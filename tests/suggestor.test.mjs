// 离线契约测试：建议框 Suggestor（src/lib/suggestor.js）——
// 用例形状照抄 Mobile 端 SuggestTest.java（两端语义一致是仓库铁律），
// 外加 padding clamp 与非法输入两条本端补充。断言用不等式（pad/聚类阈值可调），不钉具体像素。
// 跑法：node --test tests/suggestor.test.mjs（e2e.py 开头会跑本文件）
import assert from 'node:assert/strict';
import test from 'node:test';

import '../src/lib/suggestor.js';

const { suggest } = globalThis.SporeSuggest;

const FRAME_W = 1080;
const FRAME_H = 2400;

const line = (left, top, right, bottom, text) => ({ left, top, right, bottom, text });

/** 三行题干+选项聚成一块，建议框覆盖整块（含外扩 pad） */
test('mergesQuestionBlockAndCoversIt', () => {
  const lines = [
    line(80, 300, 1000, 360, '1、下列哪个说法是正确的？'),
    line(80, 380, 600, 430, 'A. 说法甲'),
    line(80, 450, 600, 500, 'B. 说法乙'),
  ];
  const box = suggest(lines, FRAME_W, FRAME_H);
  assert.ok(box, '应给出建议框');
  assert.ok(box[0] <= 80, 'left 不大于块左');
  assert.ok(box[1] <= 300, 'top 不大于块顶');
  assert.ok(box[2] >= 1000, 'right 不小于块右');
  assert.ok(box[3] >= 500, 'bottom 不小于块底');
  // 不得撑满整帧（说明真按块聚类，而不是偷懒返回全屏）
  assert.ok(box[2] - box[0] < FRAME_W);
});

/** 标题（无问句信号）与题块分开时，选中题块而不是上方标题（题号块胜出） */
test('prefersQuestionOverTitle', () => {
  const lines = [
    line(80, 100, 400, 150, '语文随堂练习'),
    line(80, 300, 1000, 360, '2、下列计算正确的是（  ）？'),
    line(80, 380, 600, 430, 'A. 2+2=5'),
  ];
  const box = suggest(lines, FRAME_W, FRAME_H);
  assert.ok(box, '应给出建议框');
  assert.ok(box[1] >= 250, '题块在下，选中框应从题干附近开始');
});

/** 问号加权：带 ？ 的块必须压过上方无信号的等高块（+40 是最大单项权重） */
test('questionMarkOutweighsPlainBlock', () => {
  const lines = [
    line(80, 200, 1000, 280, '随堂练习参考答案'), // 无问号、无题号、无 cue：约 0.7 分
    line(80, 1000, 1000, 1080, '今天天气如何？'), // 问号 +40
  ];
  const box = suggest(lines, FRAME_W, FRAME_H);
  assert.ok(box, '应给出建议框');
  assert.ok(box[1] >= 900, '问号块胜出（框应落在下方问句上）');
});

/** 空输入 → null（退手动框） */
test('noTextReturnsNull', () => {
  assert.equal(suggest([], FRAME_W, FRAME_H), null);
  assert.equal(suggest(null, FRAME_W, FRAME_H), null);
});

/** 非法输入：帧尺寸非正、退化行（right<=left / bottom<=top）、全空白文本 → null */
test('invalidInputReturnsNull', () => {
  assert.equal(suggest([line(80, 300, 1000, 360, '1、下列哪个说法是正确的？')], 0, FRAME_H), null);
  assert.equal(suggest([line(80, 300, 1000, 360, '1、下列哪个说法是正确的？')], FRAME_W, -1), null);
  assert.equal(suggest([line(500, 300, 500, 360, '1、下列哪个说法是正确的？')], FRAME_W, FRAME_H), null);
  assert.equal(suggest([line(80, 300, 1000, 300, '1、下列哪个说法是正确的？')], FRAME_W, FRAME_H), null);
  assert.equal(suggest([line(80, 300, 1000, 360, '   ')], FRAME_W, FRAME_H), null);
  assert.equal(suggest([line(80, 300, 1000, 360, null)], FRAME_W, FRAME_H), null);
});

/** 太小的块没资格当建议框：宽度不足帧宽 10% 一律不建议（哪怕带问号） */
test('tinyBlockRejected', () => {
  const lines = [line(500, 1000, 530, 1040, '1+1=?')];
  assert.equal(suggest(lines, FRAME_W, FRAME_H), null);
});

/** 楼顶/页脚两块同高文本不跨列粘连：问句块独立成块且胜出 */
test('columnsDoNotGlue', () => {
  const lines = [
    line(60, 2000, 400, 2050, '答案在最后'),
    line(520, 2000, 1020, 2050, '第 3 题，哪一项是正确的？'),
  ];
  const box = suggest(lines, FRAME_W, FRAME_H);
  assert.ok(box, '应给出建议框');
  assert.ok(box[0] > 400, '应选中右列问句块');
});

/** 信号等价时取先（上方）出现的块——平手规则钉死，防止实现漂移 */
test('tiesPickTopmost', () => {
  const lines = [
    line(80, 400, 1000, 500, '第一问，哪个对？'),
    line(80, 900, 1000, 1000, '第二问，哪个对？'),
  ];
  const box = suggest(lines, FRAME_W, FRAME_H);
  assert.ok(box, '应给出建议框');
  assert.ok(box[1] < 700, '平手取上方块');
});

/** padding clamp：贴边的块外扩后必须钳回帧内，不许出现负坐标或超出帧的坐标 */
test('paddingClampedToFrame', () => {
  // 贴左上、且右缘顶到帧宽的块 → 左/上钳 0、右钳帧宽
  const top = suggest([line(0, 0, 1080, 120, '1、下列哪个说法是正确的？？')], FRAME_W, FRAME_H);
  assert.ok(top, '应给出建议框');
  assert.equal(top[0], 0, '贴左边 → 外扩钳回 0');
  assert.equal(top[1], 0, '贴上边 → 外扩钳回 0');
  assert.equal(top[2], FRAME_W, '贴右边 → 外扩钳到帧宽');
  assert.ok(top[3] <= FRAME_H, `下边不得超帧：${top}`);
  // 贴底的块 → 下边钳到帧高
  const bottom = suggest([line(0, 2280, 1080, 2400, '2、下列哪个说法是正确的？？')], FRAME_W, FRAME_H);
  assert.ok(bottom, '应给出建议框');
  assert.equal(bottom[3], FRAME_H, '贴下边 → 外扩钳到帧高');
  assert.ok(bottom[1] >= 0 && bottom[1] < 2280, `上侧正常外扩：${bottom}`);
});
