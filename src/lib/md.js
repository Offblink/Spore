// 消息渲染的纯函数：抽屉（content script）与整页 review 共用同一份语义。
// 抽屉吃不进 ES module（manifest content_scripts 没有 module 形态），所以这里是
// 经典脚本挂全局：manifest 顺序 md.js → drawer.js；review.html 用 <script src> 引入。
(() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function md(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\$([^$\n]+)\$/g, '<span class="math">$1</span>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s.replace(/\n/g, '<br>');
  }

  globalThis.SporeMD = { esc, md };
})();
