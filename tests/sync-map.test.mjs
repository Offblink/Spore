// 同步映射的纯函数契约：上行超集字段、下行扁平→嵌套兼容、图片槽位（首图 vs 合成 id）。
// 跑法：node --test tests/sync-map.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  articleToSession,
  categoryToSubject,
  normalizeStatus,
  sessionToArticle,
  subjectToCategory,
} from '../src/lib/sync.js';

const sess = (over = {}) => ({
  id: '20261113-221500',
  title: '导数',
  created: 1000,
  updated: 5000,
  status: 'answering',
  fav: true,
  sub: 'c1',
  messages: [
    { role: 'user', ts: 1100, text: '这题', imageKey: 'spore.img.20261113-221500.0' },
    {
      role: 'assistant',
      kind: 'answer',
      ts: 1200,
      no: '7',
      title: '导数',
      ans: 'B',
      why: '因为',
      think: '想',
      tools: ['检索 x'],
      verify: { ran: true, skipped: false, verdict: 'OK', note: '一致', think: '核实想' },
    },
    { role: 'user', ts: 1300, text: '再问', imageKey: 'spore.img.20261113-221500.2' },
  ],
  ...over,
});

test('normalizeStatus：在途/空态一律 done，error/aborted 保留', () => {
  assert.equal(normalizeStatus('answering'), 'done');
  assert.equal(normalizeStatus('verifying'), 'done');
  assert.equal(normalizeStatus('searching'), 'done');
  assert.equal(normalizeStatus('idle'), 'done');
  assert.equal(normalizeStatus(''), 'done');
  assert.equal(normalizeStatus('error'), 'error');
  assert.equal(normalizeStatus('aborted'), 'aborted');
  assert.equal(normalizeStatus('done'), 'done');
});

test('sessionToArticle：元数据 + 超集消息字段', () => {
  const a = sessionToArticle(sess());
  assert.equal(a.id, '20261113-221500');
  assert.equal(a.categoryId, 'c1');
  assert.equal(a.fav, 1);
  assert.equal(a.status, 'done'); // answering → done
  assert.equal(a.created, 1000);
  assert.equal(a.updated, 5000);
  assert.equal(a.deleted, 0);

  const [user, answer] = a.messages;
  assert.equal(user.hasImage, true);
  assert.equal(user.imagePath, '');
  assert.equal(user.attPath, undefined); // 首图走正式附件列
  // Mobile 的扁平字段（让手机端能显示核实块）
  assert.equal(answer.verifyRan, true);
  assert.equal(answer.verifySkipped, false);
  assert.equal(answer.verifyVerdict, 'OK');
  assert.equal(answer.verifyNote, '一致');
  assert.equal(answer.verifyThink, '核实想');
  assert.deepEqual(answer.tools, ['检索 x']);
  assert.equal(answer.no, '7');
  assert.equal(answer.ans, 'B');
  // MV3 的局部引用不上行
  assert.equal(user.imageKey, undefined);
});

test('sessionToArticle：第 2 张及以后的图预置 attPath（文件名可预知）', () => {
  const a = sessionToArticle(sess());
  assert.equal(a.messages[2].hasImage, true);
  assert.equal(a.messages[2].attPath, '20261113-221500-2.jpg');
});

test('sessionToArticle：无科目 = 空串（服务端把空串写成 NULL）', () => {
  const a = sessionToArticle(sess({ sub: null }));
  assert.equal(a.categoryId, '');
});

test('articleToSession：扁平 verify 还原成嵌套、attPath 保留', () => {
  const row = {
    id: 's1',
    title: '会话',
    created: 100,
    updated: 200,
    status: 'done',
    fav: 1,
    categoryId: 'c1',
    attachmentPath: 's1.jpg',
    messages: [
      { role: 'user', hasImage: true, text: '题', ts: 110, imagePath: '', verifyRan: false },
      {
        role: 'assistant',
        kind: 'answer',
        no: '1',
        ans: 'A',
        verifyRan: true,
        verifyVerdict: 'FIX',
        verifyNote: '改',
        tools: ['检索 y'],
        ts: 120,
      },
      { role: 'user', hasImage: true, attPath: 's1-2.jpg', ts: 130 },
    ],
  };
  const s = articleToSession(row);
  assert.equal(s.id, 's1');
  assert.equal(s.fav, true);
  assert.equal(s.sub, 'c1');
  assert.equal(s.updated, 200);
  assert.equal(s.messages[0].hasImage, true);
  assert.deepEqual(s.messages[1].verify, { ran: true, verdict: 'FIX', note: '改' });
  assert.deepEqual(s.messages[1].tools, ['检索 y']);
  assert.equal(s.messages[2].attPath, 's1-2.jpg');
});

test('articleToSession：未知字段不进本地会话（服务端存的是任意 JSON）', () => {
  const s = articleToSession({
    id: 's2',
    updated: 10,
    messages: [{ role: 'assistant', text: 'x', someFutureField: 1, imagePath: '/data/user/0/a.jpg' }],
  });
  assert.equal(s.messages[0].someFutureField, undefined);
  assert.equal(s.messages[0].imagePath, undefined);
});

test('往返：sessionToArticle → articleToSession 保留正文/答案/核实', () => {
  const a = sessionToArticle(sess({ status: 'done' }));
  const back = articleToSession({
    ...a,
    messages: a.messages,
    attachmentPath: 'x.jpg',
  });
  assert.equal(back.messages[1].no, '7');
  assert.equal(back.messages[1].ans, 'B');
  assert.equal(back.messages[1].why, '因为');
  assert.equal(back.messages[1].think, '想');
  assert.deepEqual(back.messages[1].verify, { ran: true, verdict: 'OK', note: '一致', think: '核实想' });
});

test('科目映射：subject → category 补齐服务端必填字段；category → subject 只留本地口径', () => {
  const c = subjectToCategory({ id: 'c1', name: '高数', created: 100, updated: 200 });
  assert.deepEqual(c, {
    id: 'c1',
    parentId: null,
    name: '高数',
    sortOrder: 0,
    status: 1,
    created: 100,
    updated: 200,
    deleted: 0,
  });
  assert.deepEqual(categoryToSubject({ id: 'c1', name: '高数', created: 100, updated: 200, parentId: null }), {
    id: 'c1',
    name: '高数',
    created: 100,
    updated: 200,
  });
});

test('老科目没有 updated：按 created 兜底（不能让全量同步漏掉它）', () => {
  const c = subjectToCategory({ id: 'c9', name: '旧科目', created: 777 });
  assert.equal(c.updated, 777);
  assert.equal(c.created, 777);
});
