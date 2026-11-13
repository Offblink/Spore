// 令牌漂移守卫：页面那份（src/lib/theme.css）与抽屉 shadow 那份（drawer.js 的 :host 块）
// 是同一套明暗值写了两遍 —— 只在一边改就是「设置页变了、抽屉没变」的经典事故。
// 另外钉住两页的主题引导（theme.js 必须同步、在 </head> 之前）与 HTML 注释闭合
// （注释写错一个字符会把整段 DOM 吞掉，e2e 之前就踩过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 抽出 CSS 里的自定义属性；同名重复以最后一次为准（CSS 语义） */
function decls(css) {
  const out = new Map();
  for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    out.set(m[1].toLowerCase(), norm(m[2]));
  }
  return out;
}

/** 值归一：小写、压空格、去逗号/括号旁的空白、三位十六进制补全成六位 */
function norm(v) {
  return v
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3');
}

function splitThemes(css, darkMarker) {
  const i = css.indexOf(darkMarker);
  assert.ok(i > 0, `找不到暗色标记 ${darkMarker}`);
  return { light: decls(css.slice(0, i)), dark: decls(css.slice(i)) };
}

const page = splitThemes(read('src/lib/theme.css'), 'html[data-theme="dark"]');

const drawerSrc = read('src/content/drawer.js');
const hostAt = drawerSrc.indexOf(':host{');
const cssEnd = drawerSrc.indexOf('/* 宿主在外部树');
assert.ok(hostAt > 0 && cssEnd > hostAt, 'drawer.js 里找不到 :host 令牌块');
const drawer = splitThemes(drawerSrc.slice(hostAt, cssEnd), ':host([data-theme="dark"])');

test('抽屉令牌与页面令牌逐值一致（明/暗各一份，防止只改一边）', () => {
  for (const theme of ['light', 'dark']) {
    const p = page[theme];
    const d = drawer[theme];
    assert.ok(d.size >= 30, `${theme}: 抽屉令牌只有 ${d.size} 个，块被截断？`);
    for (const [name, value] of d) {
      const want = p.get(name);
      assert.ok(want !== undefined, `${theme}: 页面令牌缺 --${name}`);
      assert.equal(value, want, `${theme}: --${name} 两边不一致（抽屉 ${value} / 页面 ${want}）`);
    }
  }
});

test('明暗两板真的有差异，且没有自引用令牌', () => {
  for (const [name, map] of [['页面', page], ['抽屉', drawer]]) {
    for (const theme of ['light', 'dark']) {
      for (const [k, v] of map[theme]) {
        assert.notEqual(v, `var(--${k})`, `${name}/${theme}: --${k} 自引用，整块令牌会失效`);
      }
    }
    assert.equal(map.light.get('accent'), '#ec4899', `${name}: 浅色主色必须是孢子粉`);
    assert.equal(map.dark.get('accent'), '#2dd4bf', `${name}: 深色主色必须是 Fungi 青`);
    assert.equal(map.light.get('bg'), '#f2f4fa', `${name}: 浅色底`);
    assert.equal(map.dark.get('bg'), '#12141c', `${name}: 深色底`);
    assert.notEqual(map.light.get('ink'), map.dark.get('ink'), `${name}: 墨色没分板`);
  }
});

test('两页都在 </head> 之前同步引入主题（否则首帧会闪）', () => {
  for (const file of ['options.html', 'review.html']) {
    const html = read(file);
    const head = html.indexOf('</head>');
    const link = html.indexOf('href="src/lib/theme.css"');
    const script = html.indexOf('src="src/lib/theme.js"');
    assert.ok(link > 0 && link < head, `${file}: 缺 theme.css 或位置不在 head`);
    assert.ok(script > 0 && script < head, `${file}: 缺 theme.js 或位置不在 head`);
    assert.ok(!/<script[^>]+theme\.js[^>]*\b(defer|async)\b/.test(html), `${file}: theme.js 不许 defer/async`);
  }
});

test('HTML 注释与 style 标签成对（写错一个字符会把整段 DOM 吞掉）', () => {
  for (const file of ['options.html', 'review.html']) {
    const html = read(file);
    const opens = (html.match(/<!--/g) || []).length;
    const closes = (html.match(/-->/g) || []).length;
    assert.equal(opens, closes, `${file}: <!-- ${opens} 个 / --> ${closes} 个`);
    assert.equal((html.match(/<style>/g) || []).length, 1, `${file}: <style> 数量`);
    assert.equal((html.match(/<\/style>/g) || []).length, 1, `${file}: </style> 数量`);
  }
});

test('三面 CSS 不残留硬编码颜色（令牌之外只允许阴影/inline 变量）', () => {
  for (const file of ['options.html', 'review.html']) {
    const html = read(file);
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const hex = [...style.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
    assert.deepEqual(hex, [], `${file} 还有硬编码颜色：${hex.join(' ')}`);
  }
  // 抽屉：只跳过令牌块本身，规则区不许再有颜色字面量
  const rules = [
    drawerSrc.slice(0, hostAt),
    drawerSrc.slice(cssEnd, drawerSrc.indexOf('`;', cssEnd)),
  ].join('\n');
  const hex = [...rules.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]);
  assert.deepEqual(hex, [], `drawer.js 规则区还有硬编码颜色：${hex.join(' ')}`);
});
