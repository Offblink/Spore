// 抽屉：网页右缘的 Agent 面板（Shadow DOM 隔离，页面 CSS 污染不到它）。
// 收起时只露一个半圆小角「‹」；左缘另一个半圆小角「💬」点击弹出会话列表。
// 流式增量走 port（高频），结构化数据读 chrome.storage.local，写入全在 service worker。
(() => {
  if (window.__sporeDrawer) {
    window.__sporeDrawer.toggle();
    return;
  }
  window.__sporeDrawer = { toggle: () => {} };

  const PANEL_W = 420; // 整体放大后更宽一档
  const KNOB = 22; // 半圆小角的半径宽度
  const KNOB_H = 46; // 半圆小角的高度（= 2×半径）
  const STICK = 60; // 距底多少算「贴底」

  const CSS = `
/* 宿主在外部树：只能用 :host（或 :host(.cls)）匹配，#host 是匹配不到的 */
:host{all:initial;display:block;position:fixed;top:0;right:0;width:${PANEL_W}px;height:100vh;
  z-index:2147483646;pointer-events:none;
  font-family:'Segoe UI Variable','Segoe UI',-apple-system,system-ui,sans-serif;color:#1a1d2e}
*{box-sizing:border-box}
#root{position:absolute;inset:0;display:flex;transform:translateX(${PANEL_W}px);
  transition:transform .42s cubic-bezier(.16,1,.3,1);pointer-events:auto}
#root.open{transform:translateX(0)}
#root.hiding{visibility:hidden;transition:none!important}

#panel{position:relative;display:flex;width:${PANEL_W}px;height:100%;background:#fff;
  box-shadow:-8px 0 34px rgba(16,20,40,.16);border-left:1px solid #e6e8f2}

/* 半圆小角：收起时凸在矩形**之外**（向左伸进页面），展开时压在矩形**之上**（向右伸进面板）。
   位置固定在左上角，两态之间用 left + border-radius 过渡「翻面」。 */
#toggle{position:absolute;left:0;top:16px;width:${KNOB}px;height:${KNOB_H}px;padding:0;border:0;cursor:pointer;
  background:#ec4899;color:#fff;display:flex;align-items:center;justify-content:center;font-size:15.5px;line-height:1;
  border-radius:0 ${KNOB_H / 2}px ${KNOB_H / 2}px 0;box-shadow:-3px 0 12px rgba(236,72,153,.32);
  transition:left .42s cubic-bezier(.16,1,.3,1),border-radius .42s cubic-bezier(.16,1,.3,1),
             background .15s,box-shadow .42s}
#root:not(.open) #toggle{left:-${KNOB}px;border-radius:${KNOB_H / 2}px 0 0 ${KNOB_H / 2}px;
  box-shadow:3px 0 12px rgba(236,72,153,.32)}
#toggle:hover{background:#db2777}
/* 设置「隐藏半圆小角」（默认关）：只在收起态不露角（不遮网页），展开态把手照常；收起态用 Alt+Z / Alt+S 唤出 */
#root.hide-toggle:not(.open) #toggle{display:none}

#main{display:flex;flex-direction:column;flex:1;height:100%;min-width:0}
#hd{display:flex;align-items:center;gap:9px;padding:13px 14px 11px 34px;border-bottom:1px solid #eef0f8;min-height:58px}
#title{flex:1;min-width:0;font-size:15px;font-weight:600;letter-spacing:.01em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;color:#1a1d2e}
#title:empty::before{content:'Spore';color:#9aa0bb;font-weight:500}
#status{font-size:12.5px;color:#7c4dbe;background:#f4ecff;border-radius:999px;padding:3px 9px;white-space:nowrap;display:none}
#status.on{display:block;animation:pulse 1.4s ease-in-out infinite}
#status.err{display:block;background:#ffeef1;color:#c81e45}
@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
.mini{border:0;background:transparent;color:#a3a8c2;cursor:pointer;font-size:16.5px;line-height:1;
  padding:4px 5px;border-radius:6px;opacity:0;transition:opacity .15s,background .15s}
#hd:hover .mini{opacity:1}
.mini:hover{background:#f1f3fa;color:#5a5f78}

#stream{flex:1;overflow-y:auto;padding:16px 16px 10px;display:flex;flex-direction:column;gap:16px;
  scrollbar-width:thin;scrollbar-color:#d6d9e8 transparent}
#stream::-webkit-scrollbar{width:8px}
#stream::-webkit-scrollbar-thumb{background:#d6d9e8;border-radius:99px;border:2px solid #fff}
#stream::-webkit-scrollbar-track{background:transparent}

.msg{max-width:100%;font-size:15.5px;line-height:1.66;word-break:break-word}
.msg.user{display:flex;flex-direction:column;gap:6px}
.msg.user .shot{align-self:flex-start;max-width:86%;border-radius:12px;border:1px solid #e6e8f2;
  box-shadow:0 2px 10px rgba(20,24,48,.10);display:block}
/* 图片按需取回（拆键）期间的占位：没 src 时别塌成 0 高，取到再展开 */
.msg.user .shot:not([src]){min-width:180px;min-height:56px;background:#f7f8fc}
.msg.user .utext{align-self:flex-start;font-size:14.5px;color:#4a4f6b;background:#f2f4fb;
  border-radius:10px 10px 10px 3px;padding:6px 10px;white-space:pre-wrap}
.msg.bot{position:relative;padding-left:12px}
.msg.bot::before{content:'';position:absolute;left:0;top:3px;bottom:3px;width:3px;border-radius:99px;background:#ec4899}
.label{font-size:11.5px;letter-spacing:.14em;color:#9aa0bb;text-transform:uppercase;margin-bottom:3px}
.ans{font-size:17.5px;font-weight:650;color:#14172a;white-space:pre-wrap}
.why{color:#4a4f6b;font-size:15px;white-space:pre-wrap;margin-top:3px}
.tools{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.tool{font-size:13px;color:#7b81a0;background:#f6f7fc;border-radius:7px;padding:3px 8px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool::before{content:'⌕ ';color:#ec4899}
.verify{display:none;margin-top:9px;border:1px solid #e6e8f2;border-radius:10px;padding:9px 11px;background:#fbfcff}
.verify.on{display:block}
/* 「核实一下」：只有关掉自动核实时才出现，点掉即消失 */
.vbtn{display:none;margin-top:9px;padding:8px 15px;border:1px solid #ec4899;border-radius:10px;
  background:#fff0f7;color:#c2185b;font:600 13.5px/1 inherit;cursor:pointer;
  transition:background .15s,transform .12s}
.vbtn.on{display:inline-flex;align-items:center;gap:6px}
.vbtn:hover{background:#ffe3ef;transform:translateY(-1px)}
.vbtn::before{content:'🔍';font-size:12.5px}
.verify .vhead{display:flex;align-items:center;gap:7px;font-size:11.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#9aa0bb;margin-bottom:3px}
.chip{border-radius:999px;padding:1px 8px;font-size:11.5px;letter-spacing:.04em}
.chip.ok{background:#e7f8ef;color:#0f9d58}
.chip.fix{background:#ffeced;color:#d02747}
.chip.skip{background:#f1f2f8;color:#7b81a0}
.vnote{font-size:15px;color:#3d4260;white-space:pre-wrap}
.chat{color:#14172a;white-space:pre-wrap}
.msg.bot code{font-family:'Cascadia Code',Consolas,monospace;font-size:14px;background:#f4f6fd;
  border:1px solid #eef0f8;border-radius:5px;padding:0 4px}
.msg.bot a{color:#c2185b;text-decoration:none;border-bottom:1px solid #f7c8da}
.msg.bot strong{font-weight:650;color:#14172a}
/* ---- md 行结构（md.js 产出：标题/表格/列表/分隔线；与移动端 panel.css 同口径） ---- */
.msg.bot h1,.msg.bot h2,.msg.bot h3,.msg.bot h4,.msg.bot h5,.msg.bot h6{margin:10px 0 6px;
  font-weight:700;color:#14172a;line-height:1.45}
.msg.bot h1{font-size:1.3em}
.msg.bot h2{font-size:1.2em}
.msg.bot h3{font-size:1.1em}
.msg.bot h4,.msg.bot h5,.msg.bot h6{font-size:1em}
.msg.bot table{border-collapse:collapse;width:100%;margin:7px 0;font-size:14px;font-weight:400;
  border:1px solid #e6e8f2}
.msg.bot th,.msg.bot td{border:1px solid #e6e8f2;padding:5px 9px;text-align:left;overflow-wrap:break-word}
.msg.bot th{background:#f2f4fb;color:#14172a;font-weight:650}
.msg.bot td{color:#4a4f6b}
.msg.bot ul{margin:6px 0;padding-left:1.4em}
.msg.bot li{margin:2px 0}
.msg.bot hr{border:0;border-top:1px solid #e6e8f2;margin:9px 0}
.msg.bot blockquote{margin:7px 0;padding:3px 10px 3px 11px;border-left:3px solid #e6e8f2;
  border-radius:0 6px 6px 0;background:#f2f4fb;color:#4a4f6b}
.msg.bot blockquote blockquote{margin:4px 0 2px;padding-left:9px;border-left-width:2px}
/* 有序列表与围栏代码（md.js：数字点号与三连反引号顶格起块） */
.msg.bot ol{margin:6px 0;padding-left:1.6em}
.msg.bot ol li{margin:2px 0}
.msg.bot pre{margin:7px 0;padding:8px 10px;overflow-x:auto;background:#f6f7fb;
  border:1px solid #e6e8f2;border-radius:6px}
.msg.bot pre code{font-family:'Cascadia Code',Consolas,monospace;font-size:13px;
  color:#4a4f6b;background:none;border:0;padding:0;white-space:pre}
/* 表格与标题里的公式别撑破气泡（长块级公式横向滚） */
.msg.bot .katex-display{overflow-x:auto;overflow-y:hidden;margin:.5em 0}
.think{display:none;margin:0 0 7px;border-left:2px solid #e9eaf4;padding:2px 0 3px 10px}
.think.on{display:block}
.think-h{display:flex;align-items:center;gap:5px;border:0;background:transparent;padding:0;cursor:pointer;
  color:#9aa0bb;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase}
.think-h::before{content:'▸';font-size:10px;transition:transform .18s}
.think.fold .think-h::before{transform:rotate(90deg)}
.think-b{font-size:13.5px;line-height:1.62;color:#8a90ab;white-space:pre-wrap;margin-top:4px;
  max-height:260px;overflow-y:auto;scrollbar-width:thin}
.think.fold .think-b{display:none}
.think-b:empty{display:none}
.caret::after{content:'';display:inline-block;width:7px;height:15px;margin-left:2px;
  background:#ec4899;border-radius:2px;animation:blink .9s steps(2) infinite;vertical-align:-2px}
@keyframes blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
.err{font-size:14px;color:#c81e45;background:#fff1f4;border-radius:8px;padding:6px 9px}
.empty{margin:auto;text-align:center;color:#a3a8c2;font-size:15px;line-height:1.9}
.empty kbd{background:#f4f6fd;border:1px solid #e6e8f2;border-bottom-width:2px;border-radius:6px;
  padding:1px 7px;font:13.5px 'Cascadia Code',monospace;color:#5a5f78}

#sessions{position:relative;flex:none;width:34px;height:34px;padding:0;border:0;border-radius:50%;cursor:pointer;
  background:#f7ebf3;color:#c2185b;font-size:16.5px;line-height:1;display:flex;align-items:center;justify-content:center;
  transition:background .15s,transform .15s}
#sessions:hover{background:#ffe4f1;transform:scale(1.08)}
#sessions .dot{position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:#ff3b5c;
  box-shadow:0 0 6px #ff3b5c;display:none;border:2px solid #fff}
#sessions.has-unread .dot{display:block}
/* 收藏当前会话的 ★：颜色由我们自己给（⭐ 是系统 emoji，同一份 CSS 在不同机器上会渲染成
   别的颜色 —— 实测有用户点了变黑），所以用字符 ★ + color：未收藏灰、收藏品牌粉 */
#fav{flex:none;width:26px;height:30px;padding:0;border:0;background:transparent;cursor:pointer;
  font-size:17px;line-height:1;color:#b3b8cd;
  transition:color .15s,transform .15s}
#fav:hover{color:#8d93ad;transform:scale(1.12)}
#fav.on{color:#ec4899}
#fav.on:hover{color:#db2777}
/* 抽屉里才看得见抽屉里的东西：收起时不露气泡 */
#root:not(.open) #sessions{display:none}
#root:not(.open) #fav{display:none}
#root:not(.open) #listpop{display:none!important}

#jump{position:absolute;right:18px;bottom:82px;width:40px;height:40px;border-radius:50%;border:1px solid #e6e8f2;
  background:#fff;color:#5a5f78;cursor:pointer;box-shadow:0 6px 18px rgba(20,24,48,.14);
  display:none;align-items:center;justify-content:center;font-size:16.5px;transition:opacity .3s,transform .3s}
#jump.on{display:flex}
#jump:hover{transform:translateY(-2px);color:#ec4899}

#composer{display:flex;align-items:flex-end;gap:9px;padding:12px 14px 14px 16px;border-top:1px solid #eef0f8;background:#fff}
#input{flex:1;resize:none;border:1px solid #e2e5f0;background:#f8f9fd;border-radius:12px;padding:9px 11px;
  font:15px/1.55 inherit;color:#1a1d2e;max-height:156px;min-height:44px;outline:none;transition:border-color .15s,background .15s}
#input:focus{border-color:#ec4899;background:#fff}
#input::placeholder{color:#a8adc6}
#send{width:40px;height:40px;border-radius:12px;border:0;background:#ec4899;color:#fff;cursor:pointer;
  font-size:16.5px;line-height:1;transition:transform .12s,background .15s;flex:none}
#send:hover{background:#db2777;transform:translateY(-1px)}
#send:disabled{background:#e6e8f2;color:#a3a8c2;cursor:default;transform:none}

/* 删除确认框：视口正中，上下左右居中 */
/* 抽屉内的模态：#confirm（删除）与 #rename（重命名）同构。
   用 **absolute + inset:0 相对 #panel**（它 position:relative、就是侧边栏本身）——
   不能用 fixed：#root 有 transform，fixed 会以整屏为参照跑到浏览器正中去。 */
#confirm,#rename{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  background:rgba(16,20,40,.34);backdrop-filter:blur(2px);pointer-events:auto;z-index:6}
#confirm.on,#rename.on{display:flex}
#confirm .box,#rename .box{width:316px;background:#fff;border-radius:16px;padding:22px 20px 18px;
  box-shadow:0 26px 64px rgba(10,12,24,.34);text-align:center;animation:pop .24s cubic-bezier(.16,1,.3,1)}
#confirm .ct,#rename .ct{font-size:16px;font-weight:650;margin-bottom:9px;color:#14172a}
#confirm .cb,#rename .cb{font-size:14px;line-height:1.7;color:#5a5f78;margin-bottom:18px;word-break:break-all}
#confirm .cb b{color:#d02747;font-weight:650}
#rename #renameInput{width:100%;box-sizing:border-box;margin:2px 0 16px;padding:10px 11px;
  border:1px solid #e6e8f2;border-radius:10px;background:#fafbfe;outline:none;
  font:13.5px/1.4 'Cascadia Code',Consolas,monospace;color:#14172a;text-align:center}
#rename #renameInput:focus{border-color:#ec4899;background:#fff}
#confirm .acts,#rename .acts{display:flex;gap:10px}
#confirm .acts button,#rename .acts button{flex:1;min-width:0;padding:11px 0;border:0;border-radius:11px;
  cursor:pointer;font:600 14.5px/1 inherit;transition:background .15s,transform .12s}
#confirm .cno,#rename .cno{background:#f1f3fb;color:#4a4f6b}
#confirm .cno:hover,#rename .cno:hover{background:#e8ebf7}
#confirm .cyes,#rename .cyes{background:#ff3b5c;color:#fff}
#confirm .cyes:hover,#rename .cyes:hover{background:#ef1f45;transform:translateY(-1px)}

/* 会话列表：贴着面板左缘铺到近满宽（420 - 12×2），行内 = 左星标 / 中标题+时间 / 右悬停操作 */
#listpop{position:absolute;left:12px;top:66px;width:396px;max-height:64vh;overflow-y:auto;
  background:#fff;border:1px solid #e6e8f2;border-radius:16px;box-shadow:0 18px 44px rgba(16,20,40,.20);
  padding:8px;display:none;z-index:2}
#listpop.on{display:block;animation:pop .26s cubic-bezier(.16,1,.3,1)}
@keyframes pop{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.row{position:relative;display:flex;align-items:center;gap:10px;padding:9px 8px 9px 10px;border-radius:12px;
  cursor:pointer;transition:background .12s}
.row:hover{background:#f5f7fd}
/* 收藏行：淡金底 + 常显金色星标；active 粉底写在后面，两者同时命中时粉色优先 */
.row.fav{background:#fff9ea}
.row.fav:hover{background:#fff3d8}
.row.active,.row.active:hover{background:#fff0f7}
.row.active::before{content:'';position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:99px;background:#ec4899}
.row .f{flex:none;border:0;background:transparent;cursor:pointer;font-size:16px;line-height:1;padding:2px 0;
  color:#b3b8cd;opacity:0;transition:opacity .15s,color .15s,transform .15s}
.row:hover .f{opacity:.6}
.row.fav .f{opacity:1;color:#ec4899}
.row .f:hover{opacity:1;transform:scale(1.18)}
.row.fav .f:hover{color:#db2777}
.row .col{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.row .t{min-width:0;font-size:14.5px;color:#2b2f4a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .ts{font-size:11.5px;line-height:1.1;color:#a3a8c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.active .t{color:#c2185b;font-weight:600}
.row .d{width:8px;height:8px;border-radius:50%;background:#ec4899;box-shadow:0 0 6px rgba(236,72,153,.6);flex:none;display:none}
.row.unread .d{display:block}
.row .r,.row .x{border:0;background:transparent;cursor:pointer;opacity:0;flex:none;border-radius:7px;
  padding:3px 5px;transition:opacity .15s,background .15s,color .15s}
.row .r{color:#c3c7db;font-size:13.5px}
.row .x{color:#c3c7db;font-size:15px}
.row:hover .r,.row:hover .x{opacity:1}
.row .r:hover{background:#eef1ff;color:#4a5bd8}
.row .x:hover{background:#ffeef2;color:#ff3b5c}
.listempty{padding:18px 12px;font-size:13.5px;color:#a3a8c2;text-align:center}

/* toast */
/* 通知锚在**屏幕右下角**（不是侧边栏左边），从屏幕外向左飞入 */
#toasts{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;
  align-items:flex-end;pointer-events:none;z-index:2147483647}
.toast{pointer-events:auto;max-width:340px;background:#14172a;color:#fff;border-radius:12px;padding:11px 15px;
  box-shadow:0 14px 34px rgba(10,12,24,.34);cursor:pointer;
  /* 起点在屏幕右边缘之外 → 从右向左飞进来，而不是从侧边栏里冒出来 */
  transform:translateX(calc(100% + 40px));opacity:0;
  transition:transform .36s cubic-bezier(.16,1,.3,1),opacity .36s}
.toast.on{transform:none;opacity:1}
.toast .tt{font-size:14px;font-weight:650;letter-spacing:.01em;margin-bottom:2px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.toast .tb{font-size:13.5px;color:#c8cbdd;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;
  -webkit-box-orient:vertical;overflow:hidden}
.toast.fail .tt{color:#ff8fa3}

@media (prefers-reduced-motion: reduce){
  #root,.toast,#toasts,#toggle,#sessions,#send{transition:none!important;animation:none!important}
}
`;

  // ------------------------------------------------------------------ DOM
  const host = document.createElement('spore-drawer');
  host.id = 'host';
  host.classList.add('closed');
  // 关键定位走内联样式：页面 CSS 有可能覆盖 :host（文档样式对宿主优先级更高）
  host.style.cssText =
    `all:initial;position:fixed;top:0;right:0;width:${PANEL_W}px;height:100vh;z-index:2147483646;` +
    'pointer-events:none;display:block;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  // KaTeX 样式要进 shadow root（外面的 <link> 进不来）：CSS 里的字体相对它解析成
  // chrome-extension://…/katex/fonts/*，manifest 的 web_accessible_resources 已放行
  const katexCss = document.createElement('link');
  katexCss.rel = 'stylesheet';
  katexCss.href = chrome.runtime.getURL('src/lib/katex/katex.min.css');
  shadow.appendChild(katexCss);

  const wrap = document.createElement('div');
  wrap.id = 'root';
  wrap.innerHTML = `
    <aside id="panel">
      <button id="toggle" title="收起">›</button>
      <div id="main">
        <div id="hd">
          <button id="sessions" title="会话列表">💬<span class="dot"></span></button>
          <button id="fav" title="收藏此会话">★</button>
          <div id="title"></div>
          <div id="status"></div>
          <button class="mini" id="retry" title="重试" style="visibility:hidden">↻</button>
          <button class="mini" id="stop" title="停止">■</button>
          <button class="mini" id="gear" title="主页">⚙</button>
        </div>
        <div id="stream"></div>
        <button id="jump" title="回到最新">↓</button>
        <div id="composer">
          <textarea id="input" rows="1" placeholder="接着问…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button id="send" title="发送">↑</button>
        </div>
      </div>

      <div id="confirm" role="dialog" aria-modal="true">
        <div class="box">
          <div class="ct">删除会话</div>
          <div class="cb">确定删除「<b id="confirmName"></b>」吗？<br>截图、回答与思考记录会一并删除，不可恢复。</div>
          <div class="acts">
            <button class="cno" id="confirmNo" type="button">取消</button>
            <button class="cyes" id="confirmYes" type="button">删除</button>
          </div>
        </div>
      </div>

      <div id="rename" role="dialog" aria-modal="true">
        <div class="box">
          <div class="ct">重命名会话</div>
          <input id="renameInput" type="text" maxlength="60" spellcheck="false" />
          <div class="acts">
            <button class="cno" id="renameNo" type="button">取消</button>
            <button class="cyes" id="renameYes" type="button">保存</button>
          </div>
        </div>
      </div>
    </aside>
    <div id="listpop"></div>
  `;
  shadow.appendChild(wrap);
  // 两个模态都是**抽屉的子组件**：放在 #panel 内（#panel position:relative 即侧边栏），
  // 用 absolute 相对它居中；遮罩也只盖侧边栏。

  const toasts = document.createElement('div');
  toasts.id = 'toasts';
  shadow.appendChild(toasts);

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('#panel');
  const stream = $('#stream');
  const titleEl = $('#title');
  const statusEl = $('#status');
  const listpop = $('#listpop');
  const input = $('#input');
  const jump = $('#jump');
  const favBtn = $('#fav');
  const stopBtn = $('#stop');
  const retryBtn = $('#retry');
  const hostRef = host;

  document.documentElement.appendChild(host);

  const state = {
    open: false,
    sid: null,
    index: [],
    sess: null,
    streaming: false,
    statusText: '',
    shortcut: '',
  };

  // ------------------------------------------------------------------ 工具
  // 渲染纯函数来自 src/lib/md.js（经典脚本挂全局）：整页 review 与抽屉共用一份，
  // 否则两个页面的 markdown 语义会各自漂移。manifest 里 md.js 排在 drawer.js 前面。
  const { esc, md } = globalThis.SporeMD;

  const now = () => Date.now();

  function visible() {
    // 收起的抽屉等于没在看：否则 SW 会把「用户正在看」当真，把系统通知和红点一起吞掉
    return !document.hidden && document.hasFocus() && state.open;
  }

  function reportView() {
    post({ type: 'view', sid: state.sid, visible: visible() });
    // 自愈：title / turn-end 这些广播可能在端口断开时丢掉，
    // 用户一回来看（focus / 心跳）就把索引重拉一遍，旧的「解析中…」当场纠正。
    if (document.hidden) return;
    syncIndex()
      .then(() => {
        const entry = state.index.find((x) => x.id === state.sid);
        if (entry && entry.title && titleEl.textContent !== entry.title) {
          titleEl.textContent = entry.title;
        }
        if (!listpop.classList.contains('on')) renderList();
      })
      .catch(() => {});
  }

  /** 内容脚本侧日志：过 port 转给 SW 落盘，设置页「日志」卡片里能看 */
  function log(msg) {
    post({ type: 'log', scope: 'drawer', msg });
  }

  let port = null;
  let pingTimer = null;
  let retryDelay = 400;
  let reconnectTimer = null;
  let suspended = false; // pagehide → pageshow(persisted) 之间为 true：不建口、不发消息

  function post(msg) {
    if (suspended) return; // 页面正要去/刚去 bfcache：垂死文档里不许再开新口（会成孤儿）
    if (!port) connect(); // 端口断了（SW 重启/扩展重载）时点按钮会静默丢消息：先补一次连
    try {
      port?.postMessage(msg);
    } catch {
      port = null;
      connect();
  log('drawer booted');
    }
  }

  function connect() {
    if (suspended) return; // 同上：只允许在活跃文档里建口
    // 单飞：bfcache 恢复时 pageshow 与断连重连定时器可能都想连，只留一个口
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      port = null;
    }
    try {
      port = chrome.runtime.connect({ name: 'spore' });
    } catch {
      reconnectTimer = setTimeout(connect, retryDelay);
      return;
    }
    retryDelay = 400;
    clearInterval(pingTimer);
    // 每 5s 上报一次「我在看哪个会话」：既延长 service worker 生命周期，
    // 也让 SW 的红点/系统通知判断不会因为状态过期而误判。
    pingTimer = setInterval(() => post({ type: 'view', sid: state.sid, visible: visible() }), 5000);
    post({ type: 'view', sid: state.sid, visible: visible() });

    const p = port;
    p.onMessage.addListener((msg) => {
      if (msg.type === 'ping') return;
      if (msg.type === 'ev') return onEvent(msg.ev);
      if (msg.type === 'turn-start') return;
      if (msg.type === 'turn-end') return syncSession();
      if (msg.type === 'session-created' && msg.sid) return openSession(msg.sid, { open: true });
      if (msg.type === 'toggle-drawer' || msg.type === 'spore:toggle') return requestToggle();
      if (msg.type === 'spore:open' && msg.sid) return openSession(msg.sid, { open: true });
      if (msg.type === 'session-deleted' && msg.sid === state.sid) return pickFirst();
      if (msg.type === 'toast') return showToast(msg);
      if (msg.type === 'title-changed') return syncIndex();
    });

    p.onDisconnect.addListener(() => {
      // Chrome 把「端口为什么被关」挂在 runtime.lastError 上，不同版本还会在断连端
      // （甚至两端）暴露 —— 不同步读掉它，控制台就刷
      // Unchecked runtime.lastError: The page keeping the extension port is moved into
      // back/forward cache, so the message channel is closed.
      const why = chrome.runtime.lastError?.message;
      if (why) console.log('[spore] 端口断开：' + why);
      if (port !== p) return; // 已经换成新口了（bfcache 恢复后的重建），别再踢一次
      clearInterval(pingTimer);
      port = null;
      retryDelay = Math.min(4000, retryDelay * 2);
      reconnectTimer = setTimeout(connect, retryDelay);
    });
  }

  // ---- bfcache：页面被搬进往返缓存时 Chrome 会掐掉端口（有些版本不给 onDisconnect，
  // 恢复后端口就是死的，抽屉从此收不到流式事件）。所以进缓存前主动断，回来时主动重连；
  // 期间挂起文档（suspended），垂死文档里任何 post/connect 都不再开新口。 ----
  window.addEventListener('pagehide', () => {
    suspended = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearInterval(pingTimer);
    try {
      port?.disconnect();
    } catch {
      /* ignore */
    }
    port = null;
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      suspended = false;
      connect(); // 从往返缓存回来：端口已被关掉，重建
    }
  });

  // ------------------------------------------------------------------ 存储
  async function syncIndex() {
    const got = await chrome.storage.local.get('spore.index');
    state.index = got['spore.index'] || [];
    if (!state.sid && state.index.length) state.sid = state.index[0].id;
    renderList();
    renderTitle();
    renderUnread();
    renderFav();
    if (state.sid) await syncSession();
  }

  async function syncSession() {
    if (!state.sid) {
      state.sess = null;
      renderMsgs();
      return;
    }
    const got = await chrome.storage.local.get('spore.sess.' + state.sid);
    const sess = got['spore.sess.' + state.sid];
    if (!sess) return pickFirst();
    state.sess = sess;
    if (!state.streaming) renderMsgs();
    renderTitle();
    setStatus(state.statusText || '');
  }

  async function pickFirst() {
    // 必须先断掉旧 sid：syncIndex 尾巴会拿 state.sid 调 syncSession，
    // 若仍指着已删除的会话 → 找不到 → 又回 pickFirst → 互递归死锁，
    // openSession(index[0])（加载最近会话）永远执行不到。
    state.sid = null;
    state.sess = null;
    await syncIndex(); // sid 为空时它会自动指到 index[0]（= 最近的会话）并加载
    if (!state.index.length) {
      renderMsgs();
      renderTitle();
      return;
    }
    openSession(state.index[0].id, { open: false, keepList: true });
  }

  // keepList：删除当前会话后自动切到最近一条时用 —— 列表要留着（用户要继续在列表里操作）
  function openSession(sid, { open = false, keepList = false } = {}) {
    state.sid = sid;
    state.streaming = false;
    setStatus('');
    if (!keepList) listpop.classList.remove('on');
    renderFav();
    if (open) setOpen(true);
    syncSession().then(() => {
      scrollToBottom();
      reportView();
      renderList();
    });
  }

  /** 隐藏半圆小角（设置项，默认关）：启动与改设置时都套一遍 class */
  async function applyHideToggle() {
    try {
      const got = await chrome.storage.local.get('spore.settings');
      wrap.classList.toggle('hide-toggle', (got['spore.settings'] || {}).hideToggle === true);
    } catch {
      /* ignore */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['spore.settings']) applyHideToggle();
    if (changes['spore.index']) {
      state.index = changes['spore.index'].newValue || [];
      renderList();
      renderTitle();
      renderUnread();
      renderFav();
    }
    const key = 'spore.sess.' + state.sid;
    if (changes[key]) {
      if (changes[key].newValue === undefined && state.sid) {
        // 当前会话被删（存储里 key 消失）：自动加载最近的会话，别让抽屉空转
        pickFirst();
        return;
      }
      state.sess = changes[key].newValue || null;
      if (!state.streaming) renderMsgs();
      renderTitle();
    }
  });

  // ------------------------------------------------------------------ 事件
  function onEvent(ev) {
    if (!ev) return;
    // 起名事件可能属于别的会话：只影响列表，不动当前标题
    if (ev.type === 'title') {
      log(`title 事件 sid=${ev.sid} title=${JSON.stringify(ev.title)} (当前 sid=${state.sid})`);
      if (ev.sid === state.sid) {
        titleEl.textContent = ev.title || '';
        const row = listpop.querySelector(`[data-sid="${ev.sid}"] .t`);
        if (row) row.textContent = ev.title || '';
      }
      syncIndex();
      return;
    }
    // 别的会话在跑：这里只负责列表与红点
    if (ev.sid && ev.sid !== state.sid) {
      if (ev.type === 'turn-end') {
        syncIndex().then(renderList);
      }
      return;
    }
    switch (ev.type) {
      case 'status':
        setStatus(ev.text || '');
        break;

      case 'answer-start':
        state.streaming = true;
        setStatus('读题中…');
        state.sess?.messages.push({
          role: 'assistant',
          kind: 'answer',
          no: '',
          ans: '',
          why: '',
          verify: { ran: false },
          ts: now(),
        });
        renderMsgs();
        bindThinkFold(stream);
        pinToQuestion();
        break;

      case 'answer-delta': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        const head = ev.no ? `第${String(ev.no).replace(/[^\dA-Za-z]/g, '')}题 ` : '';
        const ans = node.querySelector('[data-slot=ans]');
        const why = node.querySelector('[data-slot=why]');
        if (ans) ans.innerHTML = md(head + (ev.ans || ''));
        if (why) why.innerHTML = md(ev.why || '');
        autoFoldThink(node);
        break;
      }

      case 'tool': {
        const node = nodeAt(ev.idx);
        const box = node?.querySelector('[data-slot=tools]');
        if (!box) break;
        if (!box.querySelector('.tools')) box.innerHTML = '<div class="tools"></div>';
        const row = document.createElement('div');
        row.className = 'tool';
        row.textContent = ev.name === 'web' ? `读取 ${ev.brief}` : `检索 ${ev.brief}`;
        box.querySelector('.tools').appendChild(row);
        updateJump();
        break;
      }

      case 'verify-delta': {
        const node = nodeAt(ev.idx);
        const v = node?.querySelector('.verify');
        if (!v) break;
        if (!ev.pending) node.querySelector('.vbtn')?.remove();
        v.classList.add('on');
        const note = v.querySelector('.vnote');
        if (note) note.innerHTML = md(ev.note || '');
        if (ev.done) {
          const head = v.querySelector('.vhead');
          head.innerHTML = `<span>核实</span>${verifyChip({ ran: !ev.skipped, skipped: !!ev.skipped, verdict: ev.verdict })}`;
        }
        setStatus('核实中…');
        break;
      }

      case 'think-delta': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        paintThink(node, ev.kind || 'answer', ev.think || '');
        break;
      }

      case 'chat-start':
        state.streaming = true;
        setStatus('');
        state.sess?.messages.push({ role: 'assistant', kind: 'chat', text: '', ts: now() });
        renderMsgs();
        bindThinkFold(stream);
        pinToQuestion();
        break;

      case 'chat-delta': {
        const node = nodeAt(ev.idx);
        const el = node?.querySelector('[data-slot=text]');
        if (el) el.innerHTML = md(ev.total || '');
        autoFoldThink(node);
        setStatus('');
        break;
      }

      case 'turn-end':
        state.streaming = false;
        setStatus(ev.error ? '出错了' : '', !!ev.error);
        syncSession().then(() => {
          syncIndex();
          renderList();
          reportView();
        });
        break;

      case 'error':
        state.streaming = false;
        setStatus('出错了', true);
        appendError(ev.message || '失败');
        break;

      case 'toast':
        showToast(ev);
        break;

      default:
        break;
    }
  }

  function verifyChip(v) {
    if (!v) return '';
    if (v.pending) return '<span class="chip skip">⏳ 待核实</span>';
    if (v.skipped) return '<span class="chip skip">⏭ 已跳过 · 初答自评确定</span>';
    if (!v.ran) return '';
    return v.verdict === 'FIX'
      ? '<span class="chip fix">❌ 初答有误</span>'
      : '<span class="chip ok">✅ 与初答一致</span>';
  }

  function nodeAt(idx) {
    return idx == null ? null : stream.querySelector(`[data-mi="${idx}"]`);
  }

  /**
   * 把思考内容塞进对应块；空则隐藏。
   * 思考**进行中**默认展开（要看得到 CoT）；正文一出来就自动收起（fold=1），
   * 但只要用户手动点过头部，就再也不自动动它（dataset.user='1'）。
   */
  function paintThink(node, which, text, fold = false) {
    const box = node?.querySelector(`[data-think="${which}"]`);
    if (!box) return;
    const body = box.querySelector('.think-b');
    if (!text) {
      box.classList.remove('on', 'fold');
      body.textContent = '';
      return;
    }
    box.classList.add('on');
    body.textContent = text;
    body.scrollTop = body.scrollHeight;
    if (fold && box.dataset.user !== '1') box.classList.add('fold');
  }

  /** 正文开始流入 = 思考结束 → 该节点上还没被用户动过的思考块自动收起 */
  function autoFoldThink(node) {
    node?.querySelectorAll('.think.on:not(.fold)').forEach((box) => {
      if (box.dataset.user === '1') return;
      box.classList.add('fold');
    });
  }

  function bindThinkFold(root) {
    root.querySelectorAll('.think-h').forEach((h) => {
      h.addEventListener('click', (e) => {
        e.stopPropagation();
        const box = h.closest('.think');
        box.dataset.user = '1'; // 用户接管了，之后不再自动收/展开
        box.classList.toggle('fold');
      });
    });
  }

  function setStatus(text, isErr = false) {
    state.statusText = text;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('on', !!text && !isErr);
    statusEl.classList.toggle('err', !!text && isErr);
    stopBtn.style.visibility = state.streaming ? 'visible' : 'hidden';
    input.disabled = !state.sid || state.streaming;
    input.style.opacity = state.streaming ? 0.55 : 1;
    const dead = state.sess && (state.sess.status === 'error' || state.sess.status === 'interrupted');
    retryBtn.style.visibility = !state.streaming && dead ? 'visible' : 'hidden';
  }

  function appendError(message) {
    const box = document.createElement('div');
    box.className = 'err';
    box.textContent = message;
    stream.appendChild(box);
    updateJump();
  }

  // ------------------------------------------------------------------ 渲染
  function renderTitle() {
    const hit = state.index.find((e) => e.id === state.sid);
    titleEl.textContent = hit?.title || state.sess?.title || '';
    input.disabled = !state.sid || state.streaming;
    input.placeholder = state.streaming
      ? '回答生成中…'
      : state.sid
        ? '接着问…（Enter 发送，Shift+Enter 换行）'
        : '先按 Alt+S 截一道题';
  }

  /** 删除确认：抽屉内居中模态，确认才真删（Esc / 点遮罩 / 取消 只关不删） */
  let pendingDelete = null;

  function askDelete(sid, title) {
    pendingDelete = { sid };
    $('#confirmName').textContent = title;
    $('#confirm').classList.add('on');
    $('#confirmYes').focus();
  }

  function closeConfirm() {
    pendingDelete = null;
    $('#confirm').classList.remove('on');
  }

  $('#confirmNo').addEventListener('click', closeConfirm);
  $('#confirmYes').addEventListener('click', () => {
    const target = pendingDelete;
    closeConfirm();
    if (target) post({ type: 'delete', sid: target.sid });
  });
  $('#confirm').addEventListener('click', (e) => {
    if (e.target === $('#confirm')) closeConfirm();
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (pendingDelete) closeConfirm();
      else if (pendingRename) closeRename();
    },
    true,
  );

  /** 重命名：与删除同构的抽屉内居中模态（输入框版） */
  let pendingRename = null;

  function askRename(sid, title) {
    pendingRename = { sid };
    $('#renameInput').value = title || '';
    $('#rename').classList.add('on');
    $('#renameInput').focus();
    $('#renameInput').select();
  }

  function closeRename() {
    pendingRename = null;
    $('#rename').classList.remove('on');
  }

  function commitRename() {
    const target = pendingRename;
    const title = ($('#renameInput').value || '').trim();
    closeRename();
    if (target && title) post({ type: 'rename', sid: target.sid, title });
  }

  $('#renameNo').addEventListener('click', closeRename);
  $('#renameYes').addEventListener('click', commitRename);
  $('#rename').addEventListener('click', (e) => {
    if (e.target === $('#rename')) closeRename();
  });
  $('#renameInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeRename();
    }
  });

  /** 切收藏：抽屉自己给反馈（星色 + 提示），别让用户靠 SW 回执猜「到底收藏了没」 */
  function setFav(sid, on) {
    post({ type: 'favorite', sid, fav: on });
    showToast({ sid, title: on ? '已收藏' : '已取消收藏', text: on ? '会话列表里会标出这颗星' : '已取消标记' });
  }

  /** ★ 与当前会话绑定：收藏态只存索引的 fav 字段，未收藏就是灰星 */
  function renderFav() {
    const e = state.index.find((x) => x.id === state.sid);
    const on = !!(e && e.fav);
    favBtn.classList.toggle('on', on);
    favBtn.title = on ? '取消收藏' : '收藏此会话';
  }

  function renderUnread() {
    const n = state.index.filter((e) => e.unread).length;
    $('#sessions').classList.toggle('has-unread', n > 0);
  }

  /** 会话自己的时间戳（日期+时间），显示在列表行标题下方的小字里 */
  function stampOf(e) {
    let t = e.created || e.updated || 0;
    if (!t && /^\d{8}-\d{6}$/.test(e.id || '')) {
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(e.id);
      if (m) t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    }
    const d = new Date(t);
    if (!t || Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderList() {
    const active = document.activeElement;
    const keepScroll = listpop.scrollTop;
    listpop.innerHTML = '';
    if (!state.index.length) {
      listpop.innerHTML = '<div class="listempty">还没有会话<br>按 <b>Alt+S</b> 框选截图提问</div>';
      return;
    }
    // 收藏**只标记不置顶**：置顶会把最新会话埋掉（收藏攒多了就找不到刚问的那条），
    // 想只看收藏去整页审查里筛
    for (const e of state.index.slice(0, 60)) {
      const row = document.createElement('div');
      row.className =
        'row' + (e.fav ? ' fav' : '') + (e.id === state.sid ? ' active' : '') + (e.unread ? ' unread' : '');
      row.dataset.sid = e.id;
      const f = document.createElement('button');
      f.className = 'f';
      f.type = 'button';
      f.title = e.fav ? '取消收藏' : '收藏此会话';
      f.textContent = '★';
      f.addEventListener('click', (ev) => {
        ev.stopPropagation(); // 点星标只切收藏，不许顺手打开会话
        setFav(e.id, !e.fav);
      });
      const col = document.createElement('div');
      col.className = 'col';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = e.title || e.id;
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = stampOf(e);
      col.append(t, ts);
      const d = document.createElement('span');
      d.className = 'd';
      const rn = document.createElement('button');
      rn.className = 'r';
      rn.title = '重命名会话';
      rn.textContent = '✎';
      rn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        askRename(e.id, e.title || e.id);
      });
      const x = document.createElement('button');
      x.className = 'x';
      x.title = '删除会话';
      x.textContent = '×';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        askDelete(e.id, e.title || e.id);
      });
      row.append(f, col, d, rn, x);
      row.addEventListener('click', () => openSession(e.id, { open: true }));
      listpop.appendChild(row);
    }
    listpop.scrollTop = keepScroll;
    void active;
  }

  function msgNode(m, i) {
    const node = document.createElement('div');
    node.dataset.mi = String(i);
    if (m.role === 'user') {
      node.className = 'msg user';
      if (m.imageKey || m.image) {
        // 图片已拆成独立键（只写一次），这里按需取回再填 src，取不到就丢占位
        const img = document.createElement('img');
        img.className = 'shot';
        img.alt = '题目截图';
        node.appendChild(img);
        // 截图不可点：data URL 开新标签在现代浏览器里就是一张空白页（用户实测撞到），
        // 按用户拍板直接禁用点击 —— 要放大看细节交给 Edge 自带的页面缩放
        const fill = (url) => {
          if (!url) {
            img.remove();
            return;
          }
          img.src = url;
        };
        if (m.imageKey) {
          chrome.storage.local.get(m.imageKey).then((g) => fill(g[m.imageKey]));
        } else {
          fill(m.image);
        }
      }
      if (m.text) {
        const t = document.createElement('div');
        t.className = 'utext';
        t.textContent = m.text;
        node.appendChild(t);
      }
      return node;
    }
    if (m.kind === 'answer') {
      node.className = 'msg bot';
      node.innerHTML = `
        <div class="think" data-think="answer"><button class="think-h" type="button">思考</button><div class="think-b"></div></div>
        <div class="label">初答</div>
        <div class="ans" data-slot="ans"></div>
        <div class="why" data-slot="why"></div>
        <div data-slot="tools"></div>
        <button class="vbtn${m.verify?.pending ? ' on' : ''}" type="button">核实一下</button>
        <div class="verify${m.verify && (m.verify.ran || m.verify.skipped) ? ' on' : ''}">
          <div class="think" data-think="verify"><button class="think-h" type="button">思考</button><div class="think-b"></div></div>
          <div class="vhead"><span>核实</span>${verifyChip(m.verify)}</div>
          <div class="vnote"></div>
        </div>`;
      const head = m.no ? `第${String(m.no).replace(/[^\dA-Za-z]/g, '')}题 ` : '';
      paintThink(node, 'answer', m.think || '', !!(m.ans || m.why));
      paintThink(node, 'verify', m.verify?.think || '', !!m.verify?.note);
      node.querySelector('[data-slot=ans]').innerHTML = md(head + (m.ans || ''));
      node.querySelector('[data-slot=why]').innerHTML = md(m.why || '');
      if (m.verify?.ran || m.verify?.skipped) node.querySelector('.vnote').innerHTML = md(m.verify.note || '');
      if (m.tools?.length) {
        const box = node.querySelector('[data-slot=tools]');
        box.innerHTML = '<div class="tools"></div>';
        for (const t of m.tools) {
          const row = document.createElement('div');
          row.className = 'tool';
          row.textContent = t;
          box.querySelector('.tools').appendChild(row);
        }
      }
      if (m.error) node.innerHTML += `<div class="err">${esc(m.error)}</div>`;
      const vbtn = node.querySelector('.vbtn');
      if (vbtn) {
        vbtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!state.sid || state.streaming) return;
          vbtn.remove(); // 点掉即消失
          node.querySelector('.verify')?.classList.add('on');
          setStatus('核实中…');
          post({ type: 'verify-now', sid: state.sid });
        });
      }
      return node;
    }
    node.className = 'msg bot';
    // tools 槽必须排在 .chat 之前：e2e 用 `.chat:last-of-type` 取最后一条正文，
    // :last-of-type 认的是元素类型（div）—— tools 槽排后面会把它顶掉，选择器直接失配
    node.innerHTML =
      `<div class="think" data-think="chat"><button class="think-h" type="button">思考</button><div class="think-b"></div></div>` +
      `<div data-slot="tools"></div>` +
      `<div class="chat" data-slot="text"></div>`;
    paintThink(node, 'chat', m.think || '', !!m.text);
    node.querySelector('[data-slot=text]').innerHTML = md(m.text || '');
    if (m.tools?.length) {
      const box = node.querySelector('[data-slot=tools]');
      box.innerHTML = '<div class="tools"></div>';
      for (const t of m.tools) {
        const row = document.createElement('div');
        row.className = 'tool';
        row.textContent = t;
        box.querySelector('.tools').appendChild(row);
      }
    }
    return node;
  }

  function renderMsgs() {
    const count = state.sess?.messages?.length || 0;
    stream.innerHTML = '';
    if (!count) {
      stream.innerHTML =
        '<div class="empty">按 <kbd>Alt+S</kbd> 框选截图<br>把题目交给右边这位<br><span style="font-size:13.5px">先给答案，再联网核实</span></div>';
      return;
    }
    state.sess.messages.forEach((m, i) => stream.appendChild(msgNode(m, i)));
    if (state.sess.status === 'interrupted' || state.sess.status === 'error') {
      appendError(state.sess.errorMsg || '上次回答被中断');
    }
    bindThinkFold(stream);
  }

  // ------------------------------------------------------------------ 滚动
  // 约定：只有「用户主动动作」会移动视图（发问、切会话、点 ↓、首次展开）。
  // 答案流式生成期间**绝不**自动滚动——用户停在哪就固定在哪。
  function atBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < STICK;
  }

  function updateJump() {
    jump.classList.toggle('on', !atBottom());
  }

  function scrollToBottom() {
    stream.scrollTop = stream.scrollHeight;
    updateJump();
  }

  /** 发问/开始作答时把题目对齐到顶部：整个回合只定位这一次，之后不再动 */
  function pinToQuestion() {
    const lastUser = [...stream.querySelectorAll('.msg.user')].pop();
    if (!lastUser) {
      scrollToBottom();
      return;
    }
    const max = stream.scrollHeight - stream.clientHeight;
    stream.scrollTop = Math.max(0, Math.min(lastUser.offsetTop - 6, max));
    updateJump();
  }

  stream.addEventListener('scroll', updateJump);
  jump.addEventListener('click', () => scrollToBottom());

  // ------------------------------------------------------------------ 交互
  function setOpen(open) {
    state.open = open;
    if (!open) listpop.classList.remove('on');
    wrap.classList.toggle('open', open);
    hostRef.classList.toggle('closed', !open);
    $('#toggle').textContent = open ? '›' : '‹';
    $('#toggle').setAttribute('title', open ? '收起' : '展开');
    if (open) {
      syncSession().then(() => scrollToBottom());
      input.focus();
    }
    try {
      localStorage.setItem('spore.open', open ? '1' : '0');
    } catch {
      /* ignore */
    }
    reportView(); // 立刻上报，别让 SW 用 5s 前的旧状态去判「看没看完」
  }

  function togglePanel() {
    setOpen(!state.open);
  }

  // Alt+Z 双通道（chrome.commands 广播 + 页面 keydown）可能同时到：600ms 内只认第一次
  let lastToggleAt = 0;
  function requestToggle() {
    if (Date.now() - lastToggleAt < 600) return;
    lastToggleAt = Date.now();
    togglePanel();
  }

  $('#toggle').addEventListener('click', togglePanel);
  // 调试面：只读状态，诊断时能一眼看出 class/state 是否不同步
  window.__sporeDrawer = {
    toggle: togglePanel,
    state: () => ({ open: state.open, sid: state.sid, streaming: state.streaming, index: state.index.length }),
  };

  // 会话列表：**点击**气泡开/关（悬停不再触发）；点气泡与列表之外的任何位置收起
  $('#sessions').addEventListener('click', (e) => {
    e.stopPropagation(); // 不让下面的 document 兜底监听立刻把它关掉
    listpop.classList.toggle('on');
  });
  document.addEventListener('click', (e) => {
    if (!listpop.classList.contains('on')) return;
    const path = (e.composedPath && e.composedPath()) || [];
    if (path.includes(listpop) || path.includes($('#sessions'))) return;
    // 删除/重命名模态里的点击（确认/取消/遮罩）不算「点空白」：改完列表要留在原地接着操作
    if (path.includes($('#confirm')) || path.includes($('#rename'))) return;
    listpop.classList.remove('on');
  });

  stopBtn.addEventListener('click', () => post({ type: 'stop', sid: state.sid }));
  retryBtn.addEventListener('click', () => post({ type: 'retry', sid: state.sid }));
  // 收藏当前会话：与 💬 同级的头部控件，开着列表点它也别把列表关掉（要看行重排）
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.sid) {
      showToast({ title: '还没有会话', text: '先按 Alt+S 截一道题，再回来收藏', failed: true });
      return;
    }
    const cur = state.index.find((x) => x.id === state.sid);
    setFav(state.sid, !(cur && cur.fav));
  });
  // content script 里没有 chrome.runtime.openOptionsPage（会抛 TypeError，表现为「点了没反应」）
  $('#gear').addEventListener('click', () => post({ type: 'open-options' }));

  function send() {
    const text = input.value.trim();
    if (!text || !state.sid) return;
    input.value = '';
    autoGrow();
    post({ type: 'ask', sid: state.sid, text });
    setTimeout(pinToQuestion, 60);
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(156, input.scrollHeight) + 'px';
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('#send').addEventListener('click', send);

  // ---- 拖入图片 URL：把网页里的图拖到抽屉输入框 = 当作截屏回合（SW fetch-image → 起回合） ----
  // dragover 必须 preventDefault，否则浏览器会把图片 URL 当导航直接打开（与整页 #composer 同一套）
  const pickImageUrl = (dt) => {
    if (!dt) return '';
    const uri = (dt.getData('text/uri-list') || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    if (uri) return uri;
    const hit = (dt.getData('text/html') || '').match(/<img[^>]*?src\s*=\s*["']([^"']+)["']/i);
    if (hit) return hit[1];
    return (dt.getData('text/plain') || '').trim();
  };
  $('#composer').addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  $('#composer').addEventListener('drop', (e) => {
    e.preventDefault();
    const url = pickImageUrl(e.dataTransfer);
    if (!/^https?:\/\//i.test(url)) {
      showToast({ title: '拖进来的图片打不开', text: '只支持 http(s) 的图片链接', failed: true });
      return;
    }
    post({ type: 'fetch-image', url });
    showToast({ title: '正在读取图片', text: url.length > 70 ? url.slice(0, 70) + '…' : url });
  });

  // ------------------------------------------------------------------ toast
  function showToast({ sid, title, text, failed }) {
    const el = document.createElement('div');
    el.className = 'toast' + (failed ? ' fail' : '');
    el.innerHTML = `<div class="tt"></div><div class="tb"></div>`;
    el.querySelector('.tt').textContent = title || 'Spore';
    el.querySelector('.tb').textContent = failed ? String(text || '出错了') : text || '回答完毕';
    el.addEventListener('click', () => {
      if (sid) openSession(sid, { open: true });
      el.remove();
    });
    toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 360);
    }, 3600);
  }

  // ------------------------------------------------------------------ 抽屉对页面的可见性
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'spore:before-capture') {
      capturing = true;
      wrap.classList.add('hiding');
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'spore:after-capture') {
      capturing = false;
      wrap.classList.remove('hiding');
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'spore:toggle') {
      togglePanel();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'spore:open') {
      if (msg.sid) openSession(msg.sid, { open: true });
      else setOpen(true);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ------------------------------------------------------------------ 点外面收起
  /** 框选截图期间抽屉是隐藏的，那几下点击不该把抽屉收掉 */
  let capturing = false;

  document.addEventListener(
    'click',
    (e) => {
      if (!state.open || capturing) return;
      if (host.contains(e.target)) return; // 点在抽屉里
      if (String(window.getSelection?.() || '')) return; // 正在框选文字，别误收
      setOpen(false);
    },
    true,
  );

  // ------------------------------------------------------------------ 视图上报
  document.addEventListener('visibilitychange', reportView);
  window.addEventListener('focus', reportView);
  window.addEventListener('blur', reportView);

  // ------------------------------------------------------------------ Alt+S / Alt+Z
  // 快捷键（chrome.commands）与页面内 keydown 双通道：谁先到谁触发，
  // 抽屉切换在 400ms 内去重（requestToggle），截屏在 SW 里去重（lastCaptureAt），绝不会触发两次。
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'KeyS' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'capture' }).catch(() => {});
      } else if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        e.stopPropagation();
        requestToggle(); // 页面内兜底：快捷键被占用/未绑定时依然可用
      }
    },
    true,
  );

  // ------------------------------------------------------------------ 启动
  let opened = false;
  try {
    opened = localStorage.getItem('spore.open') === '1';
  } catch {
    opened = false;
  }
  applyHideToggle();
  connect();
  syncIndex().then(() => {
    if (opened) setOpen(true);
    setStatus('');
    scrollToBottom();
  });
})();
