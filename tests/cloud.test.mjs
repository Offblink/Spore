// Spore-Cloud 客户端契约测试：归一化、R 包装/401、LWW、游标、墓碑、附件（含合成 id 多图）。
// 服务端行为由 tests/mock_cloud.mjs 按 Spore-Cloud 源码复刻，本文件只断言客户端怎么用。
// 跑法：node --test tests/cloud.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudError, createClient, normalizeApi } from '../src/lib/cloud.js';
import { createMockCloud } from './mock_cloud.mjs';

const TOKEN = 'test-token';

function article(id, updated, extra = {}) {
  return {
    id,
    categoryId: '',
    title: `会话 ${id}`,
    messages: [{ role: 'user', text: '题目', ts: updated }],
    fav: 0,
    status: 'done',
    created: updated - 1000,
    updated,
    deleted: 0,
    ...extra,
  };
}

test('normalizeApi：裸 host:port / 斜杠 / 已带 /api 都归一', () => {
  assert.equal(normalizeApi('192.168.1.5:19080'), 'http://192.168.1.5:19080/api');
  assert.equal(normalizeApi('  192.168.1.5:19080/  '), 'http://192.168.1.5:19080/api');
  assert.equal(normalizeApi('http://192.168.1.5:19080/api'), 'http://192.168.1.5:19080/api');
  assert.equal(normalizeApi('https://spore.example.com/api/'), 'https://spore.example.com/api');
  assert.equal(normalizeApi('127.0.0.1:19080'), 'http://127.0.0.1:19080/api');
  assert.equal(normalizeApi(''), '');
  assert.equal(normalizeApi(null), '');
});

test('构造即失败：地址或令牌为空', () => {
  assert.throws(() => createClient({ api: '', token: TOKEN }), CloudError);
  assert.throws(() => createClient({ api: 'host:1', token: '  ' }), CloudError);
});

test('me()：连通校验返回 uid/昵称', async () => {
  const cloud = await createMockCloud({ token: TOKEN, userId: 42, nickname: '孢子' });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    const me = await c.me();
    assert.equal(me.id, 42);
    assert.equal(me.nickname, '孢子');
  } finally {
    await cloud.close();
  }
});

test('错误：401 带服务端原话与业务码', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: 'wrong' });
    await assert.rejects(c.me(), (e) => {
      assert.ok(e instanceof CloudError);
      assert.equal(e.http, 401);
      assert.equal(e.code, 40101);
      assert.equal(e.message, '未登录或 token 失效');
      return true;
    });
  } finally {
    await cloud.close();
  }
});

test('连不上：CloudError 而不是裸 TypeError', async () => {
  const c = createClient({ api: 'http://127.0.0.1:9', token: TOKEN, timeout: 800 });
  await assert.rejects(c.me(), (e) => e instanceof CloudError && /连不上服务器/.test(e.message));
});

test('push→pull：字段原样、未知键不丢、result 是 accepted 列表', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    const messages = [
      { role: 'user', ts: 1000, imageKey: 'spore.img.s1.0', verifyRan: true, attPath: 's1-2.jpg' },
      { role: 'assistant', kind: 'answer', no: '7', ans: 'B', verify: { ran: true, verdict: 'OK' } },
    ];
    const results = await c.push({ articles: [article('s1', 1000, { messages })] });
    assert.deepEqual(results, [{ id: 's1', accepted: true }]);

    const data = await c.pull(0, 100);
    assert.equal(data.articles.length, 1);
    const row = data.articles[0];
    assert.equal(row.title, '会话 s1');
    assert.equal(row.categoryId, null); // '' → NULL
    assert.equal(row.fav, 0);
    assert.deepEqual(row.messages, messages); // 服务端 JsonNode 原样存取
    assert.equal(data.nextCursor, 1000);
  } finally {
    await cloud.close();
  }
});

test('LWW：相等/更旧都拒收，更新的才覆盖', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    await c.push({ articles: [article('s1', 2000, { title: '新' })] });
    assert.deepEqual(await c.push({ articles: [article('s1', 2000, { title: '同刻' })] }), [
      { id: 's1', accepted: false },
    ]);
    assert.deepEqual(await c.push({ articles: [article('s1', 1999, { title: '更旧' })] }), [
      { id: 's1', accepted: false },
    ]);
    assert.deepEqual(await c.push({ articles: [article('s1', 2001, { title: '更新' })] }), [
      { id: 's1', accepted: true },
    ]);
    const row = (await c.pull(0, 10)).articles[0];
    assert.equal(row.title, '更新');
    assert.equal(row.updated, 2001);
  } finally {
    await cloud.close();
  }
});

test('科目：先落目录、悬空引用置空、移出科目用空串', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    await c.push({
      categories: [{ id: 'c1', name: '高数', created: 100, updated: 100, deleted: 0 }],
      articles: [article('s1', 1000, { categoryId: 'c1' }), article('s2', 1000, { categoryId: 'ghost' })],
    });
    const data = await c.pull(0, 10);
    const byId = Object.fromEntries(data.articles.map((a) => [a.id, a]));
    assert.equal(byId.s1.categoryId, 'c1');
    assert.equal(byId.s2.categoryId, null);
    assert.equal(data.categories[0].name, '高数');

    // 移出科目：'' → NULL，且行必须比服务端更新
    await c.push({ articles: [article('s1', 1001, { categoryId: '' })] });
    const after = Object.fromEntries((await c.pull(0, 10)).articles.map((a) => [a.id, a]));
    assert.equal(after.s1.categoryId, null);
  } finally {
    await cloud.close();
  }
});

test('墓碑：deleted=1 随 pull 下发，不过滤', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    await c.push({ articles: [article('s1', 1000)] });
    await c.push({ articles: [{ id: 's1', updated: 1001, deleted: 1 }] });
    const row = (await c.pull(0, 10)).articles[0];
    assert.equal(row.deleted, 1);
    assert.equal(row.updated, 1001);
  } finally {
    await cloud.close();
  }
});

test('游标：limit 截断时不越过本批最大值', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    await c.push({ articles: [article('a', 100), article('b', 200), article('c', 300)] });
    const first = await c.pull(0, 2);
    assert.deepEqual(first.articles.map((a) => a.id), ['a', 'b']);
    assert.equal(first.nextCursor, 200);
    const second = await c.pull(first.nextCursor, 2);
    assert.deepEqual(second.articles.map((a) => a.id), ['c']);
  } finally {
    await cloud.close();
  }
});

test('附件：上推→下推字节一致；404 = null；合成 id 不抬行的 update_time', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    const c = createClient({ api: cloud.api, token: TOKEN });
    await c.push({ articles: [article('s1', 1000)] });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02]);
    const path = await c.pushAttachment('s1', bytes, 's1.jpg');
    assert.equal(path, 's1.jpg');
    assert.deepEqual(await c.pullAttachment(path), bytes);
    assert.equal(await c.pullAttachment('nope.jpg'), null);
    // 服务端 bindAttachment 抬了行的 update_time
    assert.ok(cloud.articles.get('s1').updated > 1000);

    // 第 2 张图：合成 id（文章不存在）——文件照落，但行不动
    const before = cloud.articles.get('s1').updated;
    const extra = await c.pushAttachment('s1-2', new Uint8Array([1, 2, 3]), 's1-2.jpg');
    assert.equal(extra, 's1-2.jpg');
    assert.deepEqual(await c.pullAttachment(extra), new Uint8Array([1, 2, 3]));
    assert.equal(cloud.articles.get('s1').updated, before);
  } finally {
    await cloud.close();
  }
});

test('未知接口：R 包装的业务错误照样抛 CloudError（带业务码与原话）', async () => {
  const cloud = await createMockCloud({ token: TOKEN });
  try {
    // 双 /api：落到 mock 的 default 分支 → 404 + {code:40400,...}
    const c = createClient({ api: `${cloud.api}/api`, token: TOKEN });
    await assert.rejects(c.me(), (e) => {
      assert.ok(e instanceof CloudError);
      assert.equal(e.code, 40400);
      assert.equal(e.http, 404);
      return true;
    });
  } finally {
    await cloud.close();
  }
});

test('非 JSON 响应：CloudError 说明是 HTTP 几，而不是 SyntaxError', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const c = createClient({ api, token: TOKEN });
    await assert.rejects(c.me(), (e) => {
      assert.ok(e instanceof CloudError);
      assert.equal(e.http, 502);
      assert.match(e.message, /非 JSON/);
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
