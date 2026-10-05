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

  function md(text) {
    const { body, math } = extractMath(String(text ?? ''));
    let s = esc(body);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/\n/g, '<br>');
    if (!math.length) return s;
    return s.replace(/M(\d+)/g, (_, n) => mathHtml(math[+n]));
  }

  globalThis.SporeMD = { esc, md };
})();
