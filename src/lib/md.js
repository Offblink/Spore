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
(() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PUA = ''; // 占位符护栏：M0 这种记号（U+E000 私有区码位），esc / markdown 都不碰它

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
      // 块级：$$..$$ 与 \[..\]（都可跨行）
      if (text.startsWith('$$', i) || text.startsWith('\\[', i)) {
        const close = text.startsWith('$$', i) ? '$$' : '\\]';
        const j = text.indexOf(close, i + 2);
        if (j > i + 1) {
          body += keep(text.slice(i, j + 2));
          i = j + 2;
          continue;
        }
        body += text[i]; // 没闭合 → 先放掉一个字符，后面的 $ 单独再判
        i += 1;
        continue;
      }
      // 行内：\(..\)（不跨行，与 GUI 端「无 re.S」同口径）
      if (text.startsWith('\\(', i)) {
        const nl = text.indexOf('\n', i);
        const j = text.indexOf('\\)', i + 2);
        if (j > i + 1 && (nl === -1 || j < nl)) {
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

  // —— 行结构：ATX 标题 / GFM 表格 / 无序列表 / 分隔线（语义对齐 python-markdown 的 headings +
  //    tables 扩展，与 Spore-Mobile 的 renderBlocks 同口径：标题可打断段落、表格与列表不可
  //    （须空行/块后起）、`text` 下紧邻 `---`/`===` 是 setext 标题、孤立 `---` 才是分隔线、
  //    表体少列补空多列截断、表头分隔行的 :---: 决定对齐样式）。只吃行结构；粗体/链接/公式/代码
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
  const RE_LI = /^\s*[-*+]\s+(.*)$/;
  // 有序列表：python 实测认 `1. ` 不认 `1)`；`3.` 也不开 start 属性；4 空格缩进归代码块
  const RE_OL = /^ {0,3}\d+\.\s+(.*)$/;
  // 围栏代码整块（python fenced_code 预处理器同款）：顶格 + 编号 ≥3 + 语言串单记号 +
  // 闭合围栏与开启**逐字符相同**（\1 反向引用，实测 4 个 ` 开、3 个 ` 闭不上）；未闭合不匹配
  const RE_FENCE_BLOCK = /^(~{3,}|`{3,})[ ]*\{?\.?([a-zA-Z0-9_+-]*)\}?[ ]*\n([\s\S]*?)(?<=\n)\1[ ]*(?=\n|$)/gm;

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

      // 围栏代码块（md() 层已摘成整块占位符 PUA+F+序号+PUA）：单独成块落地，
      // 不并进相邻文本行（否则前后会多出 <br>）
      if (/^\uE000F\d+\uE000$/.test(line)) {
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
        let html = '<table><thead><tr>';
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
        html += '</tbody></table>';
        out.push(html);
        afterBlock = true;
        i = j - 1;
        continue;
      }

      // 有序列表：连续 `1. ` 成一个 <ol>；紧邻段落不打断（python 口径，与无序列表同款）
      if (canStart() && RE_OL.test(line)) {
        flush(true);
        let olHtml = '<ol>';
        let oli;
        while (i < lines.length && (oli = RE_OL.exec(lines[i]))) {
          olHtml += '<li>' + oli[1] + '</li>';
          i++;
        }
        i--;
        out.push(olHtml + '</ol>');
        afterBlock = true;
        continue;
      }

      // 无序列表：连续 `- `/`* `/`+ ` 成一个 <ul>；紧邻段落时不打断（python 口径）
      if (canStart() && RE_LI.test(line)) {
        flush(true);
        let html = '<ul>';
        let li;
        while (i < lines.length && (li = RE_LI.exec(lines[i]))) {
          html += '<li>' + li[1] + '</li>';
          i++;
        }
        i--;
        out.push(html + '</ul>');
        afterBlock = true;
        continue;
      }

      buf.push(line);
      afterBlock = false;
    }
    flush(false);
    return out.join('');
  }

  function md(text) {
    // 统一换行：样本是 CRLF，\r 会让 /^#/ 与空行判定（setext/表格/列表起手）全失灵
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    // 围栏代码整块先摘（必须先于 extractMath 与行内代码：块内不解析公式/markdown，
    // python fenced_code 的预处理器就是这个顺序；`([^`]+)` 也会把 ``` 开闭配成一对吃掉）
    const blocks = [];
    const fenced = src.replace(RE_FENCE_BLOCK, (m, fence, lang, code) => {
      const cls = lang ? ' class="language-' + lang + '"' : '';
      blocks.push('<pre><code' + cls + '>' + esc(code) + '</code></pre>');
      return `${PUA}F${blocks.length - 1}${PUA}`;   // 独立标记：renderBlocks 认它是块元素
    });
    const { body, math } = extractMath(fenced);
    let s = esc(body);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    // 行结构（标题/表格/列表/分隔线/引用块/围栏占位）在 esc 之后、占位符回填之前落地
    s = renderBlocks(s);
    s = s.replace(new RegExp(PUA + 'F(\\d+)' + PUA, 'g'), (_, i) => blocks[+i]);
    if (!math.length) return s;
    return s.replace(new RegExp(PUA + 'M(\\d+)' + PUA, 'g'), (_, n) => mathHtml(math[+n]));
  }

  globalThis.SporeMD = { esc, md };
})();
