// 工具：web_search（联网检索）与 web（抓正文）。
// 思路照抄 Fungi/fungi/tools/webtools.py，但解析走 Bing RSS（结构稳定，实测 10 条干净结果），
// RSS 失败再回落 HTML b_algo 解析。没有 DOM 可用（service worker），所以全程正则 + 手写实体解码。
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

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网检索（Bing）。用于核实事实、年份、术语、数据、最新信息。',
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

/** Bing RSS → [{title,url,snippet}]，失败回落 HTML */
async function searchBing(query, signal) {
  const q = encodeURIComponent(query);
  const tries = [
    `https://cn.bing.com/search?q=${q}&format=rss&count=20&setlang=zh-CN`,
    `https://www.bing.com/search?q=${q}&format=rss&count=20&setlang=en-US`,
    `https://cn.bing.com/search?q=${q}&count=20&setlang=zh-CN`,
  ];
  let lastErr = null;
  let lastBody = '';
  for (const url of tries) {
    let text = '';
    try {
      text = await getText(url, SEARCH_TIMEOUT, signal);
      const items = url.includes('format=rss') ? parseRss(text) : parseHtml(text);
      if (items.length) return items;
      if (!lastBody) lastBody = text;
      lastErr = new Error('empty results');
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
    }
  }
  // 三个入口都空：把响应头部记进日志环，下次能直接看出是反爬页还是改版
  if (lastBody) toolLog(`bing empty → body head: ${lastBody.slice(0, 220).replace(/\s+/g, ' ')}`);
  throw lastErr || new Error('search failed');
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
    if (out.length >= 10) break;
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
    out.push({ title: clean(a[2]), url: clean(a[1]), snippet: p ? clean(p[1]) : '' });
    if (out.length >= 10) break;
  }
  return out;
}

function formatResults(items, query) {
  if (!items.length) return `(no results for '${query}')`;
  return items
    .map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}${it.snippet ? `\n   ${it.snippet}` : ''}`)
    .join('\n\n');
}

export async function toolWebSearch(query, signal) {
  let items = [];
  try {
    items = await searchBing(query, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return `ERROR: search failed (${e.message || e})`;
  }
  return truncateMiddle(formatResults(items, query), 8000);
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
