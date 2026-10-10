// 消息渲染的纯函数：抽屉（content script）与整页 review 共用同一份语义。
// 抽屉吃不进 ES module（manifest content_scripts 没有 module 形态），所以这里是
// 经典脚本挂全局：manifest 顺序 katex.min.js → md.js → drawer.js；review.html 同序 <script src> 引入。
//
// LaTeX 契约（主会话 2026-10-05 拍板，GUI 端同一口径，两端语义一致是仓库铁律）：
//   · 四类分隔符全支持：$$..$$（块级）、$..$（行内）、\[..\]（块级）、\(..\)（行内）
//   · 行内 $：开侧后非空白（允许数字起，$2+2=4$ 算公式）；闭侧前非空白**且闭侧后不是
//     ASCII 数字**（Pandoc 口径 → 「单价 $5，$8」两个 $ 都配不成对，价格不被吞）
//   · \$ 转义美元永不当分隔符，渲染成字面 $
//   · 行内不跨行；块级 $$..$$ 与 \[..\] 可跨行
//   · 渲染失败（KaTeX 语法错 / katex 没加载）→ 原样显示源码，不许静默丢弃或变空白
// 做法：先把公式从原文摘成占位符（U+E000 私有区码位，正文不会出现），markdown 转换全部
// 跑完，再把占位符换回 KaTeX 的 HTML —— 反过来先 esc 会把 KaTeX 的标签转义掉。
// think/reason 不走 md()，照旧只 esc。
//
// 行内与块级 markdown 口径（2026-10-10 与 Spore-Mobile assets/web/md.js 逐字对齐）：
//   · 行内：粗体/斜体/粗斜体（***x*** → strong+em）、图片 ![alt](url)（只放行 http(s)）、链接、
//     反斜杠转义（python ESCAPED_CHARS + tables 追加的 `|`；集合外不吃反斜杠）、行内代码；
//   · 块级：ATX/setext 标题、GFM 表格（外套 .tablewrap）、无序/有序/**嵌套**列表、引用块、
//     分隔线、围栏代码块、**4 空格缩进代码块**（起块需块起点：`text\n    x` 不算）；
//   · 摘取顺序（每一步都必须早于后一步）：围栏整块 → 缩进代码整块 → 行内代码 → 公式
//     （extractMath，四条分隔符契约不变）→ 反斜杠转义 → esc → 行内 → 行结构 → 占位符多趟回填。
(() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PUA = ''; // 占位符护栏：M0 这种记号（U+E000 私有区码位），esc / markdown 都不碰它

  // 摘下来的片段原位记号（成品最后按序号回填；PUA 私有区码位，esc / markdown 都不碰）：
  //   `F<i>` 整块代码（围栏 / 4 空格缩进）——renderBlocks 认它是块元素，单独成行落地；
  //   `M<i>` 公式（extractMath 产出，走 mathHtml）；不带字母的是行内片段（行内代码/图片/链接/转义字面量）。
  const PH = (i) => `${PUA}${i}${PUA}`;
  const PH_BLOCK = (i) => `${PUA}F${i}${PUA}`;
  const PH_RE = new RegExp(PUA + '([FM]?)(\\d+)' + PUA, 'g');
  const RE_BLOCK_PH = /^\uE000F\d+\uE000$/;
  // 行内片段槽 + 整块代码槽：每次 md() 清空（回填多趟，链接文字里套图片时占位符套占位符）
  let slots = [];
  let blocks = [];

  /** 摘公式：返回 { body, math }，body 里公式原位是 M<i> 占位符 */
  function extractMath(text) {
    const math = [];
    let body = '';
    let i = 0;
    const keep = (raw) => {
      const tok = `${PUA}M${math.length}${PUA}`;
      math.push(raw);
      return tok;
    };
    const ws = (c) => c !== undefined && /\s/.test(c);
    while (i < text.length) {
      // 块级：$$..$$ 与 \[..\]（都可跨行）；内层要求非空——`$$$$` / `\[\]` 是字面（python 口径）
      if (text.startsWith('$$', i) || text.startsWith('\\[', i)) {
        const close = text.startsWith('$$', i) ? '$$' : '\\]';
        const j = text.indexOf(close, i + 2);
        if (j > i + 2) {
          body += keep(text.slice(i, j + 2));
          i = j + 2;
          continue;
        }
        body += text[i]; // 没闭合 → 先放掉一个字符，后面的 $ 单独再判
        i += 1;
        continue;
      }
      // 行内：\(..\)（不跨行，与 GUI 端「无 re.S」同口径）；内层同样要求非空
      if (text.startsWith('\\(', i)) {
        const nl = text.indexOf('\n', i);
        const j = text.indexOf('\\)', i + 2);
        if (j > i + 2 && (nl === -1 || j < nl)) {
          body += keep(text.slice(i, j + 2));
          i = j + 2;
          continue;
        }
        body += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      // \$ = 字面美元：永不当分隔符（就地消费，后文的 $ 也配不到它头上）
      if (text[i] === '\\' && text[i + 1] === '$') {
        body += '$';
        i += 2;
        continue;
      }
      // 行内：$..$ —— 开 $ 后非空白（数字起也算）、闭 $ 前非空白且闭 $ 后不是数字，不跨行
      if (text[i] === '$' && text[i + 1] !== '$' && !ws(text[i + 1])) {
        let j = i + 1;
        let closed = -1;
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '$') {
            // 公式内容里不含 $（GUI 正则 [^$\n] 同口径）：碰到 $ 要么合法闭合，
            // 要么本次开侧作废（让那个 $ 稍后自己当新开侧），不跳过去继续配
            if (text[j - 1] !== '\\' && !ws(text[j - 1]) && !/[0-9]/.test(text[j + 1])) closed = j;
            break;
          }
          j += 1;
        }
        if (closed > 0) {
          body += keep(text.slice(i, closed + 1));
          i = closed + 1;
          continue;
        }
      }
      body += text[i];
      i += 1;
    }
    return { body, math };
  }

  /** 单个公式 → KaTeX HTML；失败（语法错 / katex 没到位）退回转义后的源码，绝不静默丢 */
  function mathHtml(raw) {
    // 分隔符宽度：$$ / \[ / \( 都是 2 字符，行内 $ 是 1 字符
    const wide = raw.startsWith('$$') || raw.startsWith('\\[') || raw.startsWith('\\(');
    const lead = wide ? 2 : 1;
    const inner = raw.slice(lead, raw.length - lead);
    try {
      if (!globalThis.katex || typeof globalThis.katex.renderToString !== 'function') {
        throw new Error('katex 没加载');
      }
      return globalThis.katex.renderToString(inner, { displayMode: raw.startsWith('$$') || raw.startsWith('\\['), throwOnError: true });
    } catch {
      return esc(raw);
    }
  }

  // —— 行内：转义字面量 → 图片 → 链接 → 非强调守卫 → 粗体/斜体（python inlinepatterns 的优先级顺序，
  //    与 Spore-Mobile 的 inline 逐字同口径）。图片/链接摘成占位符：一是属性里的 * _ 不被强调规则啃掉
  //    （python 图片 alt 原样输出），二是链接文字要单独过一遍强调（python 对匹配到的节点内部用更低
  //    优先级再跑一遍）。注意本函数在 esc() **之后**跑，所以属性值/title 引号此刻已是 &quot;（Mobile 同款）。
  // 反斜杠转义集合 = python Markdown.ESCAPED_CHARS（反斜杠 + 反引号 + * _ { } [ ] ( ) > # + - . !）
  //    + tables 扩展追加的 |；由 md() 在 esc 之前消费，回填的是 esc(字面量)——`\>` 落成 &gt; 而不是裸标签。
  //    `\$` 不在集合里（公式层自己管：extractMath 把 `\$` 就地降成字面 $）。
  const RE_ESCAPE = /\\([\\`*_{}\[\]()>#+\-.!|])/g;
  const RE_IMG = /!\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+?)(?:\s+(&quot;([\s\S]*?)&quot;|'([\s\S]*?)'))?\s*\)/g;
  const RE_LINK = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  // python NOT_STRONG_RE：被空白夹着（或行首/行尾）的 * ** *** / _ __ ___ 只是字面记号。
  // 行首单个 `*` 例外——那可能是无序列标记号，留给 renderBlocks 认（python 也是先切块后行内）。
  const RE_NOT_STRONG = /(^|[^\S\n])(\*{1,3}|_{1,3})(?=[^\S\n]|$)/gm;
  // python EmStrong 口径实测：***x***/___x___ → strong+em；**x** → strong（内容可再含 *，如 **a*b**）；
  // *x* → em（星号进词内也认，a*b*c）；_/__ 带词边界（(?<!\w)…(?!\w)，python 的 \w 含 CJK），
  // 所以 foo_bar_baz / 1_2_3 / _斜体_中文 不算强调。DOTALL：可跨行（[^*] / [\s\S] 天然跨行）。
  const W = '[\\p{L}\\p{N}_]';
  const RE_STRONG_EM_STAR = /\*\*\*([^*]+)\*\*\*/g;
  const RE_STRONG_EM_US = new RegExp('(?<!' + W + ')___(?!_)([\\s\\S]+?)(?<!_)___(?!' + W + ')', 'gu');
  const RE_STRONG_STAR = /\*\*([\s\S]+?)\*\*/g;
  const RE_STRONG_US = new RegExp('(?<!' + W + ')__(?!_)([\\s\\S]+?)(?<!_)__(?!' + W + ')', 'gu');
  const RE_EM_STAR = /\*([^*]+)\*/g;
  const RE_EM_US = new RegExp('(?<!' + W + ')_(?!_)([\\s\\S]+?)(?<!_)_(?!' + W + ')', 'gu');

  function emphasis(s) {
    return s
      .replace(RE_STRONG_EM_STAR, '<strong><em>$1</em></strong>')
      .replace(RE_STRONG_EM_US, '<strong><em>$1</em></strong>')
      .replace(RE_STRONG_STAR, '<strong>$1</strong>')
      .replace(RE_STRONG_US, '<strong>$1</strong>')
      .replace(RE_EM_STAR, '<em>$1</em>')
      .replace(RE_EM_US, '<em>$1</em>');
  }

  function inline(s) {
    const stash = (html) => { slots.push(html); return PH(slots.length - 1); };
    s = s.replace(RE_IMG, (m, alt, src, titleTok, titleDq, titleSq) => {
      const title = titleDq !== undefined ? titleDq : titleSq;
      return stash('<img alt="' + alt + '" src="' + src + '"' +
        (title !== undefined ? ' title="' + title + '"' : '') + '>');
    });
    s = s.replace(RE_LINK, (m, text, href) =>
      stash('<a href="' + href + '" target="_blank" rel="noreferrer">' + emphasis(text) + '</a>'));
    s = s.replace(RE_NOT_STRONG, (m, pre, run) => {
      if (pre === '' && run === '*') return m;   // 行首单个 * = 列表记号，留给 renderBlocks
      slots.push(run);
      return pre + PH(slots.length - 1);
    });
    return emphasis(s);
  }

  // —— 行结构：ATX 标题 / GFM 表格 / 列表（无序、有序、嵌套）/ 分隔线 / 引用块（语义对齐
  //    python-markdown 的 headings + tables 扩展，与 Spore-Mobile 的 renderBlocks 逐字同口径：
  //    标题可打断段落、表格与列表不可（须空行/块后起）、`text` 下紧邻 `---`/`===` 是 setext 标题、
  //    孤立 `---` 才是分隔线、表体少列补空多列截断、表头分隔行的 :---: 决定对齐样式）。
  //    只吃行结构；粗体/链接/公式/代码
  //    在进本函数前已处理，公式占位符是不含换行也不含 | 的 U+E000 M<i> U+E000，切行切表都碰不到它。
  const splitRow = (line) => {
    let t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  const isDelimRow = (line) => {
    if (line.indexOf('|') < 0) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  };
  const alignStyle = (c) =>
    c.charAt(0) === ':' && /:$/.test(c) ? ' style="text-align: center;"'
      : /:$/.test(c) ? ' style="text-align: right;"'
      : c.charAt(0) === ':' ? ' style="text-align: left;"' : '';
  const RE_ATX = /^(#{1,6})(.*)$/;
  // 引用块：行首 `> `（esc 后行首记号是 &gt;）0~3 空格缩进照 python
  const RE_BQ = /^ {0,3}&gt; ?(.*)$/;
  const RE_SET_EXT = /^\s*={3,}\s*$/;
  const RE_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  // 列表项一行：缩进 + 记号（无序 `- * +` / 有序 `1.`）+ 空白 + 正文。python 实测：
  // 有序认 `1. ` 不认 `1)`；`3.` 也不开 start 属性；无序列记号可混用（- * + 同一 ul）；
  // 4 空格缩进的 `- `/`1. ` 是代码块不是列表（RE_LIST_ITEM 只认行；摘代码那步先摘走）
  const RE_LIST_ITEM = /^(\s*)([-*+]|\d+\.)[ \t]+(.*)$/;
  // 引用块行首前缀（可嵌套 `> > `）：缩进代码提取早于 esc，所以这里认的是**裸** `>`；
  // 落地时前缀原样带进占位符行，等 esc 之后再交给 renderBlocks 的 `&gt;` 口径吃
  const RE_BQ_PREFIX = /^( {0,3}(?:> ?)+)([\s\S]*)$/;
  const isMarkerLine = (line) => RE_LIST_ITEM.test(line);
  // 缩进宽度：python 把 tab 当 4 空格
  const indentOf = (s) => {
    let n = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === ' ') n++;
      else if (c === '\t') n += 4;
      else break;
    }
    return n;
  };
  const stripIndent = (s, n) => {
    let k = 0, w = 0;
    while (k < s.length && w < n) {
      const c = s[k];
      if (c === ' ') { w++; k++; }
      else if (c === '\t') { w += 4; k++; }
      else break;
    }
    return s.slice(k);
  };
  // 围栏代码整块（python fenced_code 预处理器同款）：顶格 + 编号 ≥3 + 语言串单记号 +
  // 闭合围栏与开启**逐字符相同**（\1 反向引用，实测 4 个 ` 开、3 个 ` 闭不上）；未闭合不匹配
  const RE_FENCE_BLOCK = /^(~{3,}|`{3,})[ ]*\{?\.?([a-zA-Z0-9_+-]*)\}?[ ]*\n([\s\S]*?)(?<=\n)\1[ ]*(?=\n|$)/gm;

  // —— 4 空格缩进代码块（python IndentedCodeProcessor 实测口径）：起块要「块起点」（文本开头、
  //    空行之后、或紧跟在标题/分隔线/围栏/代码块这类块元素之后——`text\n    x` 不是代码，
  //    `# h\n    y` 与围栏后紧跟的缩进行都是），起块后连续吃掉「缩进 ≥4」的行，行内空行保留、
  //    块尾空行丢掉，内容按原样（再剥一层 4 空格）esc 后进 <pre><code>，整块占位符丢给 renderBlocks。
  //    4 空格缩进与列表**互斥**：列表记号行 / 列表上下文未关时的缩进行不算代码（`- a\n\n      code` 归列表）。
  //    引用块内同理：按剥掉 `> ` 前缀后的正文缩进判定，落地时占位符行带上原前缀，好让
  //    renderBlocks 的引用块递归里也认得出这是块元素。与 Spore-Mobile 的 extractCode 逐字同口径。
  function extractCode(s) {
    const lines = s.split('\n');
    const out = [];
    let listOpen = false;      // 上一行还在列表上下文里（含列表内缩进行）
    let pendingBlank = true;   // 处在块起点（文本开头 / 空行后 / 块元素后）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pm = RE_BQ_PREFIX.exec(line);
      const prefix = pm ? pm[1] : '';
      const body = pm ? pm[2] : line;
      if (body.trim() === '') { pendingBlank = true; out.push(line); continue; }
      const ind = indentOf(body);
      if (ind >= 4 && pendingBlank && !listOpen) {
        const buf = [];
        let j = i, blanks = 0;
        while (j < lines.length) {
          const cm = RE_BQ_PREFIX.exec(lines[j]);
          const cp = cm ? cm[1] : '';
          const cb = cm ? cm[2] : lines[j];
          if (cb.trim() === '') { blanks++; j++; continue; }
          if (cp !== prefix || indentOf(cb) < 4) break;
          while (blanks > 0) { buf.push(''); blanks--; }
          buf.push(stripIndent(cb, 4));
          j++;
        }
        blocks.push('<pre><code>' + esc(buf.join('\n') + '\n') + '</code></pre>');
        out.push(prefix + PH_BLOCK(blocks.length - 1));
        i = j - 1;
        pendingBlank = true;   // 代码块也是块元素
        listOpen = false;
        continue;
      }
      if (isMarkerLine(body) && ind <= 3) listOpen = true;
      else if (ind === 0) listOpen = false;
      pendingBlank = RE_BLOCK_PH.test(body) || RE_ATX.test(body) || RE_RULE.test(body);
      out.push(line);
    }
    return out.join('\n');
  }

  // —— 列表（含嵌套）。python 实测缩进阈值：子列表要比父项缩进**多 4 空格**（`- a\n  - b` 是同级
  //    两个 li，`- a\n    - b` 才是 li 内嵌 ul）；缩进 1~3 一律当同级兄弟项，且子列表类型由子项
  //    记号自己定（`- a` 下 `    1. b` 是嵌 ol，`1. a` 下 `    - b` 是嵌 ul）。项内续行（无记号的
  //    非空行）进 li 里用 <br> 续（python 同款，缩进按本层剥掉）；空行收尾（python 的 loose list
  //    会把 li 正文包 <p>，本实现保持 tight，见 known）。返回 [html, 下一行下标]。
  //    与 Spore-Mobile 的 parseList 逐字同口径。
  function parseList(lines, start) {
    const m0 = RE_LIST_ITEM.exec(lines[start]);
    const baseIndent = m0[1].length;
    const ordered = /^\d+\.$/.test(m0[2]);
    let html = ordered ? '<ol>' : '<ul>';
    let i = start;
    while (i < lines.length) {
      const m = RE_LIST_ITEM.exec(lines[i]);
      if (!m) break;
      const ind = m[1].length;
      if (ind < baseIndent || ind >= baseIndent + 4) break;   // 更浅/更深都不归本层
      let li = m[3];
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') break;                        // 空行收尾
        const cm = RE_LIST_ITEM.exec(line);
        if (cm) {
          const ci = cm[1].length;
          if (ci >= baseIndent + 4) {                         // 更深 → 子列表进 li
            const sub = parseList(lines, i);
            li += sub[0];
            i = sub[1];
            continue;
          }
          break;                                              // 同级/更浅 → 交回外层
        }
        if (RE_ATX.test(line) || RE_RULE.test(line) || RE_BQ.test(line) || RE_BLOCK_PH.test(line)) {
          break;                                              // 能再起块的行不吞（python 口径）
        }
        li += '<br>' + stripIndent(line, baseIndent);          // 续行
        i++;
      }
      html += '<li>' + li + '</li>';
    }
    return [html + (ordered ? '</ol>' : '</ul>'), i];
  }

  function renderBlocks(s) {
    const lines = s.split('\n');
    const out = [];
    let buf = [];         // 待拼接的普通文本行（行间仍用 <br>，保持旧输出一字不差）
    let afterBlock = false;
    const last = () => (buf.length ? buf[buf.length - 1] : undefined);
    const canStart = () => buf.length === 0 || last() === '';   // 不能打断紧邻段落（python 口径）
    const flush = (trimEnd) => {
      if (trimEnd) while (buf.length && last() === '') buf.pop();
      if (buf.length) out.push(buf.join('<br>'));
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (afterBlock && line === '') continue;   // 块元素之间的空行不再落 <br>

      // 围栏/缩进代码块（md() 层已摘成整块占位符 PUA+F+序号+PUA）：单独成块落地，
      // 不并进相邻文本行（否则前后会多出 <br>）
      if (RE_BLOCK_PH.test(line)) {
        flush(true);
        out.push(line);
        afterBlock = true;
        continue;
      }

      // 引用块：行首 `> ` 起块，可打断段落（python 口径：不须空行）。块的范围 = 起块行到本段
      // （空行分隔）末尾：段内**非空**行即使没有 `>` 也吞进块里（lazy 续行），但**能再起块的行**
      // （`#` 标题、`***`/`---` 分隔线）不吞（python 实测它们落成兄弟节点）；段间空行只在后面
      // 还有 `> ` 行时才留在块内（`> 甲\n\n> 乙` 合成一个 blockquote、空行降级成块内段落分隔）。
      // 块内剥一层 `> ` 后递归走本函数 → 块内标题/表格/列表/hr 与 `>>` 嵌套同口径。
      // 口径与 Spore-Mobile renderBlocks 逐字一致（2026-10-10 两端对齐）。
      if (RE_BQ.test(line)) {
        flush(true);
        const inner = [];
        let j = i;
        while (j < lines.length) {
          const cur = lines[j];
          if (cur.trim() === '') {
            let k = j;
            while (k < lines.length && lines[k].trim() === '') k++;
            // 后面没有 `> ` 行了：空行留在外层（afterBlock 会吃掉），块到此为止
            if (k >= lines.length || !RE_BQ.test(lines[k])) break;
            inner.push('');   // 合并跨空行的两段引用：空行降级成块内段落分隔
            j = k;
            continue;
          }
          const q = RE_BQ.exec(cur);
          if (!q && (RE_ATX.test(cur) || RE_RULE.test(cur))) break;   // 再起块的行不吞
          inner.push(q ? q[1] : cur);
          j++;
        }
        out.push('<blockquote>' + renderBlocks(inner.join('\n')) + '</blockquote>');
        afterBlock = true;
        i = j - 1;
        continue;
      }

      // ATX 标题：#~###### 开头（python 口径：不强制 # 后有空格，尾部 # 序列剥掉）
      const atx = RE_ATX.exec(line);
      if (atx) {
        flush(true);
        const lv = atx[1].length;
        const content = atx[2].trim().replace(/#+$/, '').trim();
        out.push('<h' + lv + '>' + content + '</h' + lv + '>');
        afterBlock = true;
        continue;
      }

      // setext（紧邻文本行 + ---/===）→ h2/h1；孤立 ---/`***` → 分隔线；孤立 === → 原样留文本
      if (RE_RULE.test(line) || RE_SET_EXT.test(line)) {
        const eq = RE_SET_EXT.test(line);
        const dash = /^\s*-{3,}\s*$/.test(line);
        if ((eq || dash) && last() !== undefined && last() !== '') {
          const headText = buf.pop();
          flush(true);
          const lv = eq ? 1 : 2;
          out.push('<h' + lv + '>' + headText + '</h' + lv + '>');
        } else if (!eq) {
          flush(true);
          out.push('<hr>');
        } else {
          buf.push(line);
          afterBlock = false;
          continue;
        }
        afterBlock = true;
        continue;
      }

      // GFM 表格：表头行 + 紧随 |---| 分隔行起表（列数必须相等，否则整体按段落原文，
      // python 实测同款）；表体吃非空且带 | 的行，少列补空多列截断
      if (canStart() && line.indexOf('|') >= 0 && isDelimRow(lines[i + 1] || '')) {
        const head = splitRow(line);
        const delimCells = splitRow(lines[i + 1]);
        if (delimCells.length !== head.length) {
          buf.push(line);
          afterBlock = false;
          continue;
        }
        const aligns = delimCells.map(alignStyle);
        flush(true);
        const n = head.length;
        // 宽表格横向滚动：外套 .tablewrap（overflow-x:auto，两端 CSS 同一条规则），
        // 表格本体仍是 <table> + border-collapse:collapse（e2e 断这个，不许改）
        let html = '<div class="tablewrap"><table><thead><tr>';
        for (let c = 0; c < n; c++) html += '<th' + aligns[c] + '>' + head[c] + '</th>';
        html += '</tr></thead><tbody>';
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== '' && lines[j].indexOf('|') >= 0) {
          let cells = splitRow(lines[j]);
          if (cells.length > n) cells = cells.slice(0, n);
          while (cells.length < n) cells.push('');
          html += '<tr>';
          for (let c = 0; c < n; c++) html += '<td' + aligns[c] + '>' + cells[c] + '</td>';
          html += '</tr>';
          j++;
        }
        html += '</tbody></table></div>';
        out.push(html);
        afterBlock = true;
        i = j - 1;
        continue;
      }

      // 列表（无序/有序/嵌套一体，走 parseList）：紧邻段落不打断（python 口径，与表格同款）；
      // 起块行的缩进 0~3（≥4 那种在 extractCode 里已经按代码块摘走了）
      const lm = RE_LIST_ITEM.exec(line);
      if (canStart() && lm && lm[1].length <= 3) {
        flush(true);
        const li = parseList(lines, i);
        out.push(li[0]);
        afterBlock = true;
        i = li[1] - 1;
        continue;
      }

      buf.push(line);
      afterBlock = false;
    }
    flush(false);
    return out.join('');
  }

  function md(text) {
    slots = [];
    blocks = [];
    // 统一换行：样本是 CRLF，\r 会让 /^#/ 与空行判定（setext/表格/列表起手）全失灵
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    // ① 围栏代码整块先摘（必须先于缩进代码/行内代码/extractMath：块内不解析公式与 markdown；
    //    `([^`]+)` 也会把 ``` 开闭配成一对当行内代码吃掉）。闭合围栏必须与开启逐字符相同。
    const fenced = src.replace(RE_FENCE_BLOCK, (m, fence, lang, code) => {
      const cls = lang ? ' class="language-' + lang + '"' : '';
      blocks.push('<pre><code' + cls + '>' + esc(code) + '</code></pre>');
      return PH_BLOCK(blocks.length - 1);   // 独立标记：renderBlocks 认它是块元素
    });
    // ② 4 空格缩进代码块（同样整块占位符，且必须早于行内代码/公式：块内不解析 markdown）
    const indented = extractCode(fenced);
    // ③ 行内代码：`\`` 不是定界符（python BACKTICK_RE 同款 `(?<!\\)`），内容只 esc、不再往下解析
    let s = indented.replace(/(?<!\\)`([^`]+)`/g, (m, c) => {
      slots.push('<code>' + esc(c) + '</code>');
      return PH(slots.length - 1);
    });
    // ④ 公式（extractMath，四条分隔符契约不变）：代码已摘空，剩下的 $$..$$/$..$/\[..\]/\(..\)
    //    都摘成占位符 —— KaTeX 的 HTML 反过来被 esc 会毁掉，所以必须早于 esc
    const { body, math } = extractMath(s);
    // ⑤ 反斜杠转义：早于 esc/图片/链接/强调落地（`\*` 不是强调、`\- ` 不是列表、`\#` 不是标题）；
    //    回填 esc(字面量)——`\>` 要落成 &gt; 而不是裸标签
    s = body.replace(RE_ESCAPE, (m, c) => {
      slots.push(esc(c));
      return PH(slots.length - 1);
    });
    s = esc(s);
    // ⑥ 行内：图片/链接/粗体/斜体/非强调守卫（口径见 inline 的注释）
    s = inline(s);
    // ⑦ 行结构（标题/表格/列表/分隔线/引用块/代码块占位）在 esc 之后、占位符回填之前落地
    s = renderBlocks(s);
    // ⑧ 多趟回填：链接文字里的图片之类会「占位符套占位符」，跑到不再有占位符为止（上限 8 趟兜底）
    for (let pass = 0; pass < 8 && s.indexOf(PUA) >= 0; pass++) {
      s = s.replace(PH_RE, (m, f, i) => {
        const n = Number(i);
        if (f === 'F') return blocks[n] ?? '';
        if (f === 'M') return math[n] !== undefined ? mathHtml(math[n]) : '';
        return slots[n] ?? '';
      });
    }
    return s;
  }

  globalThis.SporeMD = { esc, md };
})();
