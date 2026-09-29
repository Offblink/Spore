// 离线契约测试：初答自检（答案行 vs 解析结论）+ 阶段B 解析。
// 起因是用户实测截图：「第17题 A（对）」和「…故该说法错误」并排出现，而 <<ok>> 守卫把核实整个跳过了。
// 极性判定是启发式，误伤的代价只是「多跑一次核实」，但漏判会直接把矛盾答案端给用户 —— 这里把两侧都钉死。
// 跑法：node --test tests/answer.test.mjs（tests/e2e.py 开头会连 search.test.mjs 一起跑）
import assert from 'node:assert/strict';
import test from 'node:test';

import { contradicts, isSelfCertain, parsePhaseA, parsePhaseB } from '../src/lib/agent.js';

const WHY_BAD = '制定软件质量计划属于SQA活动中的计划与实施范畴，故该说法错误。';

test('答案行与解析结论打架 → 检出（用户截图里的那道判断题）', () => {
  assert.equal(contradicts('A（对）', WHY_BAD), true);
  assert.equal(contradicts('A（对）', 'A 不对，应选 B。'), true);
  assert.equal(contradicts('错', '该说法成立。'), true);
});

test('答案与解析一致 → 不检出', () => {
  assert.equal(contradicts('B（错）', WHY_BAD), false);
  assert.equal(contradicts('A（对）', '说法成立，选 A。'), false);
  assert.equal(contradicts('对', '定义如此，没有例外。'), false);
});

test('括号里是数值/字母（普通选择题、计算题）→ 不判，绝不误伤', () => {
  assert.equal(contradicts('B（-1）', '求导得 -1。'), false);
  assert.equal(contradicts('42', '两边同乘 42 再移项。'), false);
  assert.equal(contradicts('B', '应选 B。'), false);
  assert.equal(contradicts('', ''), false);
});

test('解析里读不出结论极性 → 不判', () => {
  assert.equal(contradicts('A（对）', '应选 B'), false);
  assert.equal(contradicts('A（对）', ''), false);
});

test('阶段B FIX：ANS 行被单独解析出来，不混进 NOTE', () => {
  const v = parsePhaseB('VERDICT: FIX\nANS: B（错）\nNOTE: 教材：SQA 含计划活动，原说法错误（来源：软件工程教材）。');
  assert.equal(v.verdict, 'FIX');
  assert.equal(v.ans, 'B（错）');
  assert.ok(!v.note.includes('ANS:'));
});

test('阶段B 判 OK / 没给 ANS 行 → ans 为空（调用方据此不覆盖答案行）', () => {
  assert.equal(parsePhaseB('VERDICT: OK\nANS: 无\nNOTE: 与初答一致。').ans, '无');
  assert.equal(parsePhaseB('VERDICT: OK\nNOTE: 与初答一致。').ans, '');
  // 模型把 ANS 排到 NOTE 后面：NOTE 的 [\s\S]* 会把它吞掉，ans 仍要拿到、note 里不能留
  const v = parsePhaseB('VERDICT: FIX\nNOTE: 原说法错误。\nANS: B（错）');
  assert.equal(v.ans, 'B（错）');
  assert.ok(!v.note.includes('ANS:'));
});

test('阶段A 五行协议（WHY 在 ANS 前）照样解析，守卫标记不漏进正文', () => {
  const raw = [
    'NO: 17',
    'TITLE: SQA活动范围',
    'WHY: 制定软件质量计划属于SQA活动，故说法错误。',
    'ANS: B（错）',
    'CERT: <<check>>',
  ].join('\n');
  const p = parsePhaseA(raw);
  assert.equal(p.no, '17');
  assert.equal(p.ans, 'B（错）');
  assert.ok(p.why.includes('说法错误'));
  assert.equal(isSelfCertain(raw), false);
  assert.equal(isSelfCertain(raw.replace('<<check>>', '<<ok>>')), true);
});
