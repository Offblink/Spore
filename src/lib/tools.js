// 工具：web_search（联网检索）与 web（抓正文）。
// 搜索链同步自 Fungi/fungi/tools/webtools.py（spec §71，2026-09-28）：
//   引擎链 duckduckgo → bing → brave，三道闸 = 空页/节流页重试一次、结果必须含查询实词
//   （诱饵页不返回）、逐腿报错 `ERROR: Search failed (duckduckgo timed out; bing HTTP 429)`。
//   Fungi 用注册表代理给引擎定序（有代理 ddg 打头）；扩展读不到系统代理，改用设置页的
//   「代理」字段做同样的判断（填了 = 有代理 → ddg 打头；留空 = 只走 bing），见 searchPlan。
// bing 腿保留本仓的 RSS 主 + HTML 回落（本机实测 cn.bing 结构稳定），其余照抄。
// 没有 DOM 可用（service worker），所以全程正则 + 手写实体解码。
/** 工具结果也进日志环：检索失败时能一眼看到是 429、超时还是空结果（不猜） */
function toolLog(msg) {
  try {
    // 动态引用避免循环依赖；tools 与 store 互相不 import，这里直接用全局注册的回调
    globalThis.__sporeToolLog?.(msg);
  } catch {
    /* 日志不能影响工具本身 */
  }
}

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_TIMEOUT = 12000;
const WEB_TIMEOUT = 15000;
const TRUNCATE = 12000;
// 引擎链三道闸（同步 Fungi spec §71）：空页/节流页是「可重试的失败」，每腿两次、间隔 0.5s
const SEARCH_ATTEMPTS = 2;
const SEARCH_RETRY_PAUSE = 500;
const SEARCH_HITS = 8;
// 查询里的短词/虚词不构成「结果属于这次查询」的证据（≥4 字符的实词才算）
const NOISE_WORDS = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'does', 'that', 'from', 'into', 'about']);
// 引擎链由设置页的「代理」字段声明 —— 这就是 Fungi 读注册表代理（`_proxies()`）那道判断的替身：
//   填了 = 有代理 → ddg→bing→brave；留空 = 没代理 → 只走 bing（ddg 直连只会白等一个超时）。
// 浏览器自己已按系统代理路由请求，扩展没法只给检索换代理，所以这个开关决定的是「信任哪套引擎」。
let searchProxy = '';

/** 由 agent 在每次核实开始前用当前设置调一次（设置改了下一次检索就生效） */
export function setSearchProxy(v) {
  searchProxy = String(v ?? '').trim();
}

/** 当前引擎链（设置页/自动化也读它；纯函数，便于断言） */
export function searchPlan(proxy = searchProxy) {
  return String(proxy ?? '').trim() ? ['duckduckgo', 'bing', 'brave'] : ['bing'];
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网检索（DuckDuckGo → Bing）。返回编号的标题、URL、摘要。' +
        'ERROR: 表示各引擎都被节流或不可达——稍后重试或换措辞；' +
        '(no results ...) 表示引擎有响应但确实没有命中。用于核实事实、年份、术语、数据、最新信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，一次聚焦一个关键点' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web',
      description: '抓取某个网页的正文纯文本（在搜索结果的基础上深读）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 链接' } },
        required: ['url'],
      },
    },
  },
];

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
      mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
      times: '×', divide: '÷', middot: '·', copy: '©',
    };
    return named[body] ?? (body === 'amp' ? '&' : m);
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

export function truncateMiddle(text, limit = TRUNCATE) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n... [truncated ${text.length - limit} chars] ...\n\n${text.slice(-half)}`;
}

async function getText(url, timeoutMs, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function clean(text) {
  return decodeEntities(String(text ?? ''))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ddgTarget：duckduckgo.com/l/?uddg=<urlencoded> → 真链（只解码一次；Fungi 的二次 unquote 会把 URL 里合法的 %20 解坏） */
function ddgTarget(href) {
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const target = new URL(href).searchParams.get('uddg');
    if (target) return target;
  } catch {
    /* 非法 URL 原样返回 */
  }
  return href;
}

/** unbing：bing 的 /ck/a?...&u=a1<base64url> 跳转 → 真链（Fungi _unbing） */
function unbing(url) {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return url;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return url;
  }
}

/** DuckDuckGo 静态页：按标题锚点切分（容器 class 会变，锚点不变），跳赞助行、还原跳转（Fungi _search_ddg） */
async function searchDdg(query, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await getText(url, SEARCH_TIMEOUT, signal);
  const items = [];
  for (const chunk of html.split(/class="result__a"/i).slice(1)) {
    const a = /^[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!a) continue;
    const href = decodeEntities(a[1]);
    if (href.includes('y.js') || href.includes('ad_domain')) continue; // 赞助行
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    items.push({ title: clean(a[2]), url: ddgTarget(href), snippet: sn ? clean(sn[1]) : '' });
    if (items.length >= SEARCH_HITS) break;
  }
  return formatResults(items);
}

/**
 * Bing：RSS 主 + HTML 回落（本仓实测，与 Fungi 的纯 HTML 腿不同——这是刻意保留的本地适配）。
 * 返回格式化串；有响应但 0 条 = ''（引擎链按可重试空页处理），三个入口全网络失败才抛错。
 */
async function searchBing(query, signal) {
  const q = encodeURIComponent(query);
  const tries = [
    `https://cn.bing.com/search?q=${q}&format=rss&count=20&setlang=zh-CN`,
    `https://www.bing.com/search?q=${q}&format=rss&count=20&setlang=en-US`,
    `https://cn.bing.com/search?q=${q}&count=20&setlang=zh-CN`,
  ];
  let lastErr = null;
  let firstBody = '';
  let sawBody = false;
  for (const url of tries) {
    let text;
    try {
      text = await getText(url, SEARCH_TIMEOUT, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      continue;
    }
    sawBody = true;
    const items = url.includes('format=rss') ? parseRss(text) : parseHtml(text);
    if (items.length) return formatResults(items);
    if (!firstBody) firstBody = text;
  }
  if (sawBody) {
    // 有响应但一条都没解析出来（节流页/改版）：记响应头进日志环，交给引擎链当空页重试
    toolLog(`bing empty → body head: ${firstBody.slice(0, 220).replace(/\s+/g, ' ')}`);
    return '';
  }
  throw lastErr || new Error('search failed');
}

/** brave：整页去标签兜底（Fungi _search_brave，≥50 字才算有内容），只在前两腿全挂时出场 */
async function searchBrave(query, signal) {
  const raw = await getText(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, SEARCH_TIMEOUT, signal);
  const text = stripTags(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' '),
  ).trim();
  return text.length >= 50 ? text : '';
}

function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const blk = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(blk)?.[1] ?? '';
    const link = /<link>([\s\S]*?)<\/link>/.exec(blk)?.[1] ?? '';
    const desc = /<description>([\s\S]*?)<\/description>/.exec(blk)?.[1] ?? '';
    if (!link) continue;
    out.push({ title: clean(title), url: clean(link), snippet: clean(desc) });
    if (out.length >= SEARCH_HITS) break;
  }
  return out;
}

function parseHtml(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo[\s\S]*?<\/li>/g)) {
    const blk = m[0];
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(blk);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(blk);
    out.push({ title: clean(a[2]), url: unbing(clean(a[1])), snippet: p ? clean(p[1]) : '' });
    if (out.length >= SEARCH_HITS) break;
  }
  return out;
}

function formatResults(items) {
  return items
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}${it.snippet ? `\n   ${it.snippet}` : ''}`)
    .join('\n\n');
}

/**
 * 相关性闸：结果必须含查询里某个实词（≥4 字符、非虚词），否则判诱饵页——宁可报错也不给静默错答（Fungi §71）。
 * 用 Unicode 词类对齐 Python 的 `\w`（CJK 也算词）：中文查询会整段成 token，要求结果原文出现该段；
 * 拒绝时模型会换措辞重试，符合「宁拒不错信」的设计取向。
 */
function relevant(query, results) {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 4 && !NOISE_WORDS.has(w));
  if (!tokens.length) return true;
  const low = results.toLowerCase();
  return tokens.some((w) => low.includes(w));
}

/** 腿级错误 → 引擎链报错片段（HTTP 状态原样、我方超时记 timed out，对齐 Fungi 的 `name reason` 口径） */
function legError(e) {
  if (e && e.name === 'AbortError') return 'timed out';
  const m = String((e && e.message) || e);
  return /^HTTP \d+$/.test(m) ? m : m.slice(0, 60);
}

export async function toolWebSearch(query, signal) {
  const legs = { duckduckgo: searchDdg, bing: searchBing, brave: searchBrave };
  const plan = searchPlan();
  const order = plan.map((name) => [name, legs[name]]);
  toolLog(`search: ${searchProxy ? '代理模式' : '未配代理'} → ${plan.join('→')} ｜ "${query.slice(0, 40)}"`);
  const failures = [];
  let empty = 0;
  for (const [name, leg] of order) {
    for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');
      let results = '';
      try {
        results = await leg(query, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        failures.push(`${name} ${legError(e)}`);
        break; // 硬失败不重试，换腿
      }
      if (results && relevant(query, results)) return truncateMiddle(results, 8000);
      if (results) {
        failures.push(`${name} returned unrelated hits`);
        break; // 诱饵页不重试、不返回
      }
      empty += 1; // 空页/节流页是可重试的失败
      if (attempt < SEARCH_ATTEMPTS) await new Promise((r) => setTimeout(r, SEARCH_RETRY_PAUSE));
    }
  }
  if (failures.length) return `ERROR: Search failed (${[...new Set(failures)].join('; ').slice(0, 200)}`;
  if (empty) return `(no results for '${query}')`;
  return 'ERROR: Search failed (no engine configured)';
}

/** 正文抓取：去 script/style/head，压缩空白，中间截断 */
export async function toolWeb(url, signal) {
  if (!/^https?:\/\//i.test(url)) return `ERROR: not an http(s) url: ${url}`;
  let raw;
  try {
    raw = await getText(url, WEB_TIMEOUT, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return `ERROR: fetch failed (${e.message || e})`;
  }
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n');
  const stripped = stripTags(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped.length < 30) return `ERROR: empty or blocked page: ${url}`;
  return truncateMiddle(stripped, TRUNCATE);
}

/** 统一分发入口：未知工具/缺参/异常都回填成 ERROR 字符串（照抄 fungi dispatch） */
export async function dispatch(name, args, signal) {
  const t0 = Date.now();
  try {
    if (name === 'web_search') {
      if (!args?.query) return 'ERROR: Missing required argument: query';
      const out = await toolWebSearch(args.query, signal);
      toolLog(`web_search "${String(args.query).slice(0, 50)}" ${Date.now() - t0}ms → ${out.slice(0, 140).replace(/\s+/g, ' ')}`);
      return out;
    }
    if (name === 'web') {
      if (!args?.url) return 'ERROR: Missing required argument: url';
      const out = await toolWeb(args.url, signal);
      toolLog(`web ${String(args.url).slice(0, 60)} ${Date.now() - t0}ms → ${out.slice(0, 120).replace(/\s+/g, ' ')}`);
      return out;
    }
    return `ERROR: Unknown tool: ${name}`;
  } catch (e) {
    if (e.name === 'AbortedError') throw e;
    toolLog(`${name} threw ${String(e && e.message).slice(0, 120)}`);
    return `ERROR: ${e.message || e}`;
  }
}
