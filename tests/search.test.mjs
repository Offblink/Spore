// 离线契约测试：检索引擎链的「三道闸」+ 定序开关（同步 Fungi spec §71 之后的返回口径）。
// 联网测不稳的部分（诱饵页、429、空页重试、bing 跳转还原）在这里用假 fetch 钉死；
// 真机 e2e 只断言返回口径三态，不依赖某个引擎当天是否可达（e2e 里会跑本文件）。
// 跑法：node --test tests/search.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { searchPlan, setSearchProxy, toolWebSearch } from '../src/lib/tools.js';

const Q = 'vLLM PagedAttention paper';

// —— 夹具：形状照抄 Fungi tests/test_tools.py（ddg 赞助行 + uddg 跳转；bing ck/a 跳转）——
const DDG_OK = [
  '<div class="result result--ad"><a class="result__a" ',
  'href="//duckduckgo.com/y.js?ad_domain=launchdarkly.com">LaunchDarkly</a></div>',
  '<div class="result"><a rel="nofollow" class="result__a" ',
  'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F2309.06180&amp;rut=abc">',
  'vLLM: PagedAttention</a>',
  '<a class="result__snippet">Efficient memory management for LLM serving</a></div>',
].join('');
const BING_HTML_OK =
  '<ol id="b_results"><li class="b_algo"><h2><a ' +
  'href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9hcnhpdi5vcmcvYWJzLzIzMDkuMDYxODA">vLLM paper</a>' +
  '</h2><p>PagedAttention serving</p></li></ol>';
const rss = (title, url, desc) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>bing</title><item>` +
  `<title>${title}</title><link>${url}</link><description>${desc}</description></item></channel></rss>`;
const BING_DECOY_RSS = rss('Reynolds High School', 'https://example.com/rhs', 'Tickets at the main office');
const RSS_EMPTY = '<?xml version="1.0"?><rss version="2.0"><channel><title>必应：没有与此相关的结果</title></channel></rss>';
const RSS_OK = rss('vLLM: high-throughput serving', 'https://github.com/vllm-project/vllm', 'PagedAttention 内存管理');

/** 假 fetch：按 URL 子串路由（键顺序即优先级）；值可以是字符串或 (calls) => body */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) {
        const text = typeof body === 'function' ? body(calls) : body;
        if (typeof text === 'object' && text !== null) return respond(text.body, text.status);
        return respond(text);
      }
    }
    return respond('', 404);
  };
  return calls;
}

const respond = (text, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
});

test('代理模式：ddg 打头，编号命中、还原 uddg、跳过赞助行', async () => {
  setSearchProxy('127.0.0.1:7897');
  const logs = [];
  globalThis.__sporeToolLog = (m) => logs.push(m);
  const calls = stubFetch({ duckduckgo: DDG_OK });
  const out = await toolWebSearch(Q);
  assert.match(out, /^1\. vLLM: PagedAttention/);
  assert.ok(out.includes('https://arxiv.org/abs/2309.06180'), out);
  assert.ok(!out.includes('uddg') && !out.includes('LaunchDarkly'), '跳转要还原、赞助行要跳过');
  assert.ok(calls[0].includes('duckduckgo'), '代理模式下 ddg 必须是第一腿');
  assert.ok(
    logs.some((l) => l.includes('代理模式') && l.includes('duckduckgo→bing→brave')),
    logs.join(' | '),
  );
});

test('未配代理：只碰 bing，ddg 一次都不请求（Fungi 的「没代理别白等超时」）', async () => {
  setSearchProxy('');
  const calls = stubFetch({ 'format=rss': RSS_OK, 'bing.com': BING_HTML_OK });
  const out = await toolWebSearch(Q);
  assert.ok(out.includes('https://github.com/vllm-project/vllm'), out);
  assert.ok(calls.length > 0, '得真的请求了');
  assert.ok(
    calls.every((u) => u.includes('bing.com') && !u.includes('duckduckgo')),
    '未配代理时不允许碰 ddg/brave',
  );
  assert.deepEqual(searchPlan(''), ['bing']);
  assert.deepEqual(searchPlan('127.0.0.1:7897'), ['duckduckgo', 'bing', 'brave']);
});

test('诱饵页被相关性闸拒绝：不返回正文，错误点名该腿', async () => {
  setSearchProxy('127.0.0.1:7897');
  stubFetch({
    duckduckgo: '<html></html>',
    'format=rss': BING_DECOY_RSS,
    'bing.com': '<html></html>',
    brave: '<html>tiny</html>',
  });
  const out = await toolWebSearch('anthropic multi-agent research system');
  assert.ok(out.startsWith('ERROR: Search failed'), out);
  assert.ok(out.includes('unrelated'), out);
  assert.ok(!out.includes('Reynolds'), '诱饵页正文绝不能进结果');
});

test('三腿都答空 → (no results for …)，不是 ERROR', async () => {
  setSearchProxy('127.0.0.1:7897');
  stubFetch({
    duckduckgo: '<html></html>',
    'format=rss': RSS_EMPTY,
    'bing.com': '<html></html>',
    brave: '<html>tiny</html>',
  });
  assert.equal(await toolWebSearch('qwertyuiopasdfgh'), "(no results for 'qwertyuiopasdfgh')");
});

test('三腿都 429 → 错误里逐条点名（HTTP 状态原样）', async () => {
  setSearchProxy('127.0.0.1:7897');
  const e429 = { body: '', status: 429 };
  stubFetch({ duckduckgo: e429, 'format=rss': e429, 'bing.com': e429, brave: e429 });
  const out = await toolWebSearch(Q);
  assert.ok(out.startsWith('ERROR: Search failed ('), out);
  for (const leg of ['duckduckgo HTTP 429', 'bing HTTP 429', 'brave HTTP 429']) {
    assert.ok(out.includes(leg), `${leg} 没被点名：${out}`);
  }
});

test('空页是可重试的失败：第二次尝试拿到结果', async () => {
  setSearchProxy('');
  let rssCalls = 0;
  stubFetch({
    'format=rss': () => (++rssCalls <= 2 ? RSS_EMPTY : RSS_OK),
    'bing.com': '<html></html>',
  });
  const out = await toolWebSearch(Q);
  assert.ok(out.includes('https://github.com/vllm-project/vllm'), out);
  assert.equal(rssCalls, 3, '第一次尝试两个 RSS 都空，第二次才命中');
});

test('bing HTML 腿还原 /ck/a 跳转', async () => {
  setSearchProxy('');
  stubFetch({ 'format=rss': RSS_EMPTY, 'bing.com': BING_HTML_OK });
  const out = await toolWebSearch(Q);
  assert.ok(out.includes('https://arxiv.org/abs/2309.06180'), out);
  assert.ok(!out.includes('/ck/a'), out);
});
