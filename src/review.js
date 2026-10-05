// 整页「搜题记录」：左＝会话列表（全部/收藏、可收放、行内 ✎/×），右＝整段作答历史 + 底部追问输入。
// 构造对齐 Fungi WebUI：侧栏固定宽、收起用 margin-left 滑出，主区 flex:1 ——
// 列表一收一放，右侧会话界面的宽度自动跟着变。
// 抽屉的删除 / 重命名 / 输入框按用户要求**复制**进来（抽屉原样保留）：协议复用 SW 的
// favorite / view / rename / delete / ask 消息，并开一条与抽屉同名的 'spore' 端口拿流式事件。
(() => {
  const $ = (s) => document.querySelector(s);
  const { esc, md } = globalThis.SporeMD; // review.html 里 md.js 排在本文件前面
  const K_INDEX = 'spore.index';
  const K_SUBJ = 'spore.subjects';
  const K_SESS = 'spore.sess.';
  const KEY_COLLAPSED = 'spore.review.collapsed';
  const KEY_SUBOPEN = 'spore.review.subopen';

  const state = {
    index: [],
    subjects: [], // 科目（目录形态），创建越早越靠上
    subOpen: new Set(), // 展开中的科目（页面级状态，存 localStorage）
    sid: null,
    sess: null,
    filter: 'all',
    streaming: false,
    follow: true, // 跟随滚动：用户往上翻就断开，滚回底部才重新跟随（抽屉同款纪律）
    pendingDelete: null,
    pendingRename: null,
    dragSid: null, // 正被拖动的会话 id
    selecting: false, // 多选模式（head 的 #selBtn 进/退；sel class 挂在 #list 上，底栏 #batchbar 随之浮出）
    selected: new Set(), // 选中的会话 id（renderList 重绘时按它回放 .on）
    pendingPick: null, // 移入科目弹层的目标会话 id 数组（null = 弹层关着）
  };
  // 多选手势（照移动端 record.js 移植）：批量选择按钮进模式（0 选起手）；单选框起笔涂抹连选
  let suppressClick = false; // 涂抹收笔后的那次 click 要吃掉
  let paint = null; // 本笔涂抹 {seg, prev, dx, dir, moved, px, py, pid}
  // 涂抹贴边自动滚动 #list（量纲对齐 GUI 端：band=56 / step=14 / 30ms）：
  // 笔尖距 #list 视口上/下缘 56px 内 → 连续滚；离开边缘停；收笔（up/cancel）必停
  const EDGE_BAND = 56;
  const EDGE_STEP = 14;
  const EDGE_MS = 30;
  let edgeScroll = null; // {dir, timer}
  // 历史会反复重绘（回合内 1.2s 落盘一次），图片按 key 缓存，别每次都去 storage 捞几百 KB
  const imgCache = new Map();
  let port = null;
  let retryDelay = 400;
  let reconnectTimer = null;
  let suspended = false; // pagehide → pageshow(persisted) 之间为 true：不建口、不发消息

  const fmtStamp = (ms) => {
    const d = new Date(ms || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const post = (msg) => {
    if (suspended) return; // 页面正要去/刚去 bfcache：垂死文档里不许再开新口（会成孤儿）
    if (!port) connect(); // 端口断了（SW 重启/扩展重载）时点发送会静默丢消息：先补一次连
    try {
      port?.postMessage(msg);
    } catch {
      port = null;
      connect();
    }
  };
  const toBottom = () => {
    const h = $('#history');
    if (h) h.scrollTop = h.scrollHeight;
  };
  const maybeFollow = () => {
    if (state.follow) toBottom();
  };

  // ---------------------------------------------------------------- 列表
  async function syncIndex() {
    const got = await chrome.storage.local.get(K_INDEX);
    state.index = got[K_INDEX] || [];
    renderList();
  }

  async function syncSubjects() {
    const got = await chrome.storage.local.get(K_SUBJ);
    state.subjects = got[K_SUBJ] || [];
    renderList();
  }

  function buildRow(e, subId) {
    const row = document.createElement('div');
    row.className =
      'row' + (e.fav ? ' fav' : '') + (e.id === state.sid ? ' active' : '') + (e.unread ? ' unread' : '');
    row.dataset.sid = e.id;
    if (subId) {
      row.classList.add('in');
      row.dataset.sub = subId; // 拖放时用来判定「落到哪个科目」
    }
    row.draggable = true; // 拖进科目（拖到列表空白处 = 移出科目）
    row.addEventListener('dragstart', (ev) => {
      state.dragSid = e.id;
      ev.dataTransfer.setData('text/plain', e.id);
      ev.dataTransfer.effectAllowed = 'move';
      row.classList.add('drag');
    });
    row.addEventListener('dragend', () => {
      state.dragSid = null;
      row.classList.remove('drag');
      clearDz();
    });
    const ck = document.createElement('span');
    ck.className = 'ck';
    ck.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 13l4 4 10-10"/></svg>';
    const f = document.createElement('button');
    f.className = 'f';
    f.type = 'button';
    f.title = e.fav ? '取消收藏' : '收藏此会话';
    f.textContent = '★';
    f.addEventListener('click', (ev) => {
      ev.stopPropagation(); // 点星标只切收藏，不许顺手打开会话
      toggleFav(e.id, !e.fav);
    });
    const col = document.createElement('div');
    col.className = 'col';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = e.title || e.id;
    const ts = document.createElement('div');
    ts.className = 'ts';
    ts.textContent = fmtStamp(e.updated || e.created);
    col.append(t, ts);
    const d = document.createElement('span');
    d.className = 'd';
    const rn = document.createElement('button');
    rn.className = 'r';
    rn.type = 'button';
    rn.title = '重命名会话';
    rn.textContent = '✎';
    rn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      askRename(e.id, e.title || e.id);
    });
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = '删除会话';
    x.textContent = '×';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      askDelete(e.id, e.title || e.id);
    });
    if (state.selected.has(e.id)) row.classList.add('on');
    row.append(ck, f, col, d, rn, x);
    // 行点击走 #list 上的统一委托（多选模式里要吃 suppressClick、改勾选不打开会话）
    return row;
  }

  // 科目行：目录形态，永远排在会话列表最前；点它展开/收回（空科目展开显示「（空）」）
  function buildFolder(s, members) {
    const open = state.subOpen.has(s.id);
    const f = document.createElement('div');
    f.className = 'sub' + (open ? ' open' : '');
    f.dataset.sub = s.id;
    f.innerHTML =
      '<span class="sc">▸</span><span class="fi"></span><span class="sn"></span>' +
      (members.length ? '<span class="cn"></span>' : '') +
      '<button class="sr" type="button" title="重命名科目">✎</button>' +
      '<button class="sx" type="button" title="删除科目">×</button>';
    f.querySelector('.sn').textContent = s.name;
    const cn = f.querySelector('.cn');
    if (cn) cn.textContent = String(members.length);
    f.addEventListener('click', () => toggleSub(s.id));
    f.querySelector('.sr').addEventListener('click', (ev) => {
      ev.stopPropagation();
      askRenameSub(s);
    });
    f.querySelector('.sx').addEventListener('click', (ev) => {
      ev.stopPropagation();
      askDeleteSub(s);
    });
    const frag = document.createDocumentFragment();
    frag.appendChild(f);
    if (open) {
      if (members.length) for (const e of members) frag.appendChild(buildRow(e, s.id));
      else {
        const empty = document.createElement('div');
        empty.className = 'subempty';
        empty.dataset.sub = s.id;
        empty.textContent = '（空）把会话拖到这个科目上';
        frag.appendChild(empty);
      }
    }
    return frag;
  }

  function renderList() {
    const box = $('#list');
    if (!box) return;
    // 选中集按现有会话裁剪：删掉的/不在库里的不再算选中；被裁到一个不剩才退多选
    //（storage.onChanged 的重绘也走同一口径；0 选起手进模式时没裁到东西，不许被这条踢出去）
    if (state.selecting) {
      const valid = new Set(state.index.map((e) => e.id));
      let cropped = false;
      for (const id of [...state.selected]) {
        if (!valid.has(id)) {
          state.selected.delete(id);
          cropped = true;
        }
      }
      if (cropped && !state.selected.size) setSelecting(false);
    }
    const keep = box.scrollTop;
    box.innerHTML = '';
    const flat = state.filter === 'fav'; // 收藏视图不摆科目，只按星标平铺
    const subs = flat ? [] : state.subjects;
    const memberOf = new Map(subs.map((s) => [s.id, []]));
    const loose = [];
    for (const e of state.index) {
      if (flat) {
        if (e.fav) loose.push(e);
        continue;
      }
      const bucket = memberOf.get(e.sub);
      if (bucket) bucket.push(e);
      else loose.push(e);
    }
    const nothing = flat ? !loose.length : !state.index.length && !subs.length;
    if (nothing) {
      box.innerHTML = `<div class="empty">${
        flat
          ? '没有收藏的会话。<br>点行内 ★ 收藏，这里只留收藏的。'
          : '还没有搜题记录。<br>回网页按 Alt+S 截一道题。'
      }</div>`;
      renderTitle();
      renderFav();
      updateComposer();
      return;
    }
    for (const s of subs) box.appendChild(buildFolder(s, memberOf.get(s.id) || []));
    for (const e of loose) box.appendChild(buildRow(e, null));
    box.scrollTop = keep;
    renderTitle();
    renderFav();
    updateComposer();
  }

  // ---------------------------------------------------------------- 多选模式（进/退、单卡勾选）

  function setSelecting(on) {
    state.selecting = on;
    if (!on) {
      state.selected.clear();
      // 退出即把 DOM 上的 .on 清干净：选中集已空，别等下一次重绘才摘残影
      for (const r of rowsArr()) r.classList.remove('on');
    }
    $('#list').classList.toggle('sel', on);
    const bar = $('#batchbar');
    if (bar) bar.hidden = !on;
    // 入口按钮自己换文案与配色：模式里点它 = 退出
    const btn = $('#selBtn');
    if (btn) {
      btn.textContent = on ? '退出选择' : '批量选择';
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    syncSelChrome();
  }

  /** 底栏计数与可用性随选中集实时同步（选中 0 个时三个操作禁用） */
  function syncSelChrome() {
    const n = state.selected.size;
    const c = $('#selCount');
    if (c) c.textContent = `已选 ${n} 项`;
    for (const id of ['bFav', 'bMove', 'bDel']) {
      const el = document.getElementById(id);
      if (el) el.disabled = n === 0;
    }
  }

  function rowsArr() {
    return [...document.querySelectorAll('#list .row')];
  }

  function rowUnder(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.row') : null;
  }

  /** 单卡勾选：改集合 + 只刷这一格的 .on（不起整列表重绘，滚动位置不丢） */
  function setRowSel(sid, on) {
    if (on === state.selected.has(sid)) return;
    if (on) state.selected.add(sid);
    else state.selected.delete(sid);
    const el = rowsArr().find((r) => r.dataset.sid === sid);
    if (el) el.classList.toggle('on', on);
    syncSelChrome();
  }

  /** 当前段起点 ↔ 笔尖卡 之间整段落选中/取消（段内重放，幂等） */
  function paintRange(toIdx) {
    const arr = rowsArr();
    const a = Math.min(paint.seg, toIdx);
    const b = Math.max(paint.seg, toIdx);
    for (let i = a; i <= b; i++) {
      const el = arr[i];
      if (el) setRowSel(el.dataset.sid, paint.dir);
    }
  }

  /** 笔尖命中重放：pointermove 与贴边滚动的每一拍共用这一份（滚动把新卡送到笔尖下也按它入选） */
  function paintHit(x, y) {
    const over = rowUnder(x, y);
    if (!over) return;
    const idx = rowsArr().indexOf(over);
    if (idx < 0 || idx === paint.prev) return;
    const d = idx > paint.prev ? 1 : -1;
    if (paint.dx && d !== paint.dx) {
      // 中途换向：方向翻转，新段从拐点（上一格）起算
      paint.dir = !paint.dir;
      paint.seg = paint.prev;
    }
    paint.dx = d;
    paint.prev = idx;
    paint.moved = true;
    paintRange(idx);
  }

  /** 贴边分档：-1 = 贴上缘往上滚，1 = 贴下缘往下滚，0 = 不滚（含笔尖划出列表外） */
  function edgeDir(y) {
    const b = listBox.getBoundingClientRect();
    if (y < b.top || y > b.bottom) return 0; // 笔尖出了列表（pointer capture 下照样收得到 move）
    if (y - b.top <= EDGE_BAND) return -1;
    if (b.bottom - y <= EDGE_BAND) return 1;
    return 0;
  }

  function stopEdgeScroll() {
    if (edgeScroll) {
      clearInterval(edgeScroll.timer);
      edgeScroll = null;
    }
  }

  function edgeTick() {
    if (!paint || !state.selecting) return stopEdgeScroll(); // 模式被别的路退掉了
    const before = listBox.scrollTop;
    listBox.scrollTop = before + edgeScroll.dir * EDGE_STEP;
    if (listBox.scrollTop === before) return stopEdgeScroll(); // 到头了
    if (paint.px != null) paintHit(paint.px, paint.py); // 滚动露出的新卡继续参与涂抹
  }

  function startEdgeScroll(dir) {
    if (edgeScroll && edgeScroll.dir === dir) return;
    stopEdgeScroll();
    edgeScroll = { dir, timer: setInterval(edgeTick, EDGE_MS) };
  }

  function toggleSub(id) {
    if (state.subOpen.has(id)) state.subOpen.delete(id);
    else state.subOpen.add(id);
    try {
      localStorage.setItem(KEY_SUBOPEN, JSON.stringify([...state.subOpen]));
    } catch {
      /* ignore */
    }
    renderList();
  }

  // ---- 拖放：拖到科目行/科目内部 = 归入该科目，拖到列表空白处 = 移出科目 ----
  const listBox = $('#list');
  function clearDz() {
    listBox.querySelectorAll('.sub.dz').forEach((el) => el.classList.remove('dz'));
  }
  function dropSub(ev) {
    const t = ev.target?.closest?.('.sub, .row.in, .subempty');
    return t ? t.dataset.sub || null : null;
  }
  listBox.addEventListener('dragover', (ev) => {
    if (!state.dragSid) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    clearDz();
    const sub = dropSub(ev);
    if (sub) listBox.querySelector(`.sub[data-sub="${sub}"]`)?.classList.add('dz');
  });
  listBox.addEventListener('drop', (ev) => {
    if (!state.dragSid) return;
    ev.preventDefault();
    const sub = dropSub(ev);
    const sid = state.dragSid;
    state.dragSid = null;
    clearDz();
    if (sid) post({ type: 'subject', op: 'assign', sid, sub });
  });

  // ---- 行点击统一委托：suppressClick 优先；多选模式里点卡片 = 勾选（不打开会话）----
  listBox.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    if (state.selecting) {
      setRowSel(row.dataset.sid, !state.selected.has(row.dataset.sid));
      return;
    }
    openSession(row.dataset.sid);
  });

  // ---- 多选手势（照移动端 record.js 移植）：模式由 #selBtn 进入（0 选起手），单选框起笔涂抹 ----
  // 语义：从某个单选框开始拖 = 涂抹，选中「段起点 → 笔尖所在卡」之间全部；起笔卡已选 →
  // 本笔先取消；中途折返即换向（方向翻转、新段从拐点起算）。卡片其余区域的拖动留给
  // 滚动/拖科目；.ck 上的 pointerdown 必须 preventDefault —— 行是 draggable，不拦会触发 dragstart。
  listBox.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return; // 多指只认主指
    suppressClick = false;
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.ck') && state.selecting) {
      // 涂抹起笔：首段方向看起笔格（起在已选上 = 本笔先取消）；seg = 起笔格
      const idx = rowsArr().indexOf(row);
      paint = { seg: idx, prev: idx, dx: 0, dir: !state.selected.has(row.dataset.sid), moved: false,
                px: e.clientX, py: e.clientY, pid: e.pointerId };
      // 抓住指针：笔尖划出 #list 也继续收 move（否则贴边档会停不下来），up 同理能收到
      try {
        listBox.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已消逝：没抓到也只是退化成旧行为 */
      }
      e.preventDefault();
    }
  });

  listBox.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    if (paint && state.selecting) {
      paint.px = e.clientX;
      paint.py = e.clientY;
      paintHit(e.clientX, e.clientY);
      const dir = edgeDir(e.clientY);
      if (dir) startEdgeScroll(dir);
      else stopEdgeScroll(); // 离开边缘档立刻停
      e.preventDefault();
    }
  });

  function endStroke() {
    stopEdgeScroll(); // 收笔必停：pointerup / pointercancel 都走这里
    if (!paint) return;
    if (paint.moved) {
      suppressClick = true; // 涂抹收笔那下别再触发 click
    } else {
      // 单选框上的轻点（没动）：就地翻选，吃掉随后的 click 防双翻
      const row = rowsArr()[paint.seg];
      if (row) setRowSel(row.dataset.sid, !state.selected.has(row.dataset.sid));
      suppressClick = true;
    }
    const pid = paint.pid;
    paint = null; // 先清再放捕获：release 会同步触发 lostpointercapture 重入本函数
    try {
      listBox.releasePointerCapture(pid);
    } catch {
      /* 捕获已自动释放 */
    }
  }

  listBox.addEventListener('pointerup', (e) => {
    if (e.isPrimary) endStroke();
  });
  listBox.addEventListener('pointercancel', (e) => {
    if (e.isPrimary) {
      endStroke();
      suppressClick = false; // cancel 后没有 click，别把标志留给下一笔
    }
  });
  // 捕获被浏览器收回（页面失焦/指针被别的元素接管）= 这笔结束，滚动跟着停
  listBox.addEventListener('lostpointercapture', () => endStroke());
  listBox.addEventListener('contextmenu', (e) => e.preventDefault()); // 涂抹途中不弹右键/文字选择菜单

  function renderTitle() {
    const hit = state.index.find((e) => e.id === state.sid);
    $('#rTitle').textContent = hit?.title || state.sess?.title || '搜题记录';
  }

  function renderFav() {
    const hit = state.index.find((x) => x.id === state.sid);
    const on = !!(hit && hit.fav);
    $('#rFav').classList.toggle('on', on);
    $('#rFav').title = on ? '取消收藏' : '收藏此会话';
  }

  function toggleFav(sid, on) {
    if (!sid) return;
    post({ type: 'favorite', sid, fav: on });
    const hit = state.index.find((x) => x.id === sid);
    if (hit) hit.fav = on; // 乐观更新：SW 改完存储会再广播一次，这里不等回执
    showToast({ sid, title: on ? '已收藏' : '已取消收藏', text: on ? '会话列表里会标出这颗星' : '已取消标记' });
    renderList();
  }

  // ------------------------------------------------------------------ toast
  // 抽屉同款（右下角飞入、3.6s 自动收、点击打开会话）。SW 的 favorite 消息不广播 toast ——
  // 谁点了谁自己弹，所以抽屉与整页不会重复弹同一条。
  function showToast({ sid, title, text }) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<div class="tt"></div><div class="tb"></div>';
    el.querySelector('.tt').textContent = title || 'Spore';
    el.querySelector('.tb').textContent = text || '';
    el.addEventListener('click', () => {
      if (sid && sid !== state.sid) openSession(sid);
      el.remove();
    });
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 360);
    }, 3600);
  }

  // ---------------------------------------------------------------- 历史
  function chipHtml(v) {
    if (!v) return '';
    if (v.pending) return '<span class="chip skip">⏳ 待核实</span>';
    if (v.skipped) return '<span class="chip skip">⏭ 已跳过 · 初答自评确定</span>';
    if (!v.ran) return '';
    return v.verdict === 'FIX'
      ? '<span class="chip fix">❌ 初答有误</span>'
      : '<span class="chip ok">✅ 与初答一致</span>';
  }

  function thinkDetails(label, text) {
    if (!text) return '';
    return `<details class="think"><summary>${label}</summary><div class="think-b">${esc(text)}</div></details>`;
  }

  function verifyBox(v) {
    if (!v || (!v.ran && !v.skipped && !v.pending)) return '';
    const note = v.note ? `<div class="vnote">${md(v.note)}</div>` : '';
    return `<div class="verify"><div class="vhead"><span>核实</span>${chipHtml(v)}</div>${note}${thinkDetails('核实思考', v.think || '')}</div>`;
  }

  function fillImg(img, key, legacy) {
    const attach = (url) => {
      img.src = url;
      img.addEventListener('load', maybeFollow); // 图片撑高后仍要贴着底部
    };
    if (legacy) {
      attach(legacy);
      return;
    }
    if (imgCache.has(key)) {
      attach(imgCache.get(key));
      return;
    }
    chrome.storage.local.get(key).then((g) => {
      const url = g[key];
      if (!url) {
        img.remove();
        return;
      }
      imgCache.set(key, url);
      if (img.isConnected) attach(url);
    });
  }

  function msgNode(m, i) {
    const node = document.createElement('div');
    node.dataset.mi = String(i);
    if (m.role === 'user') {
      node.className = 'msg user';
      if (m.imageKey || m.image) {
        const img = document.createElement('img');
        img.className = 'shot';
        img.alt = '题目截图';
        node.appendChild(img);
        // 截图不可点：data URL 开新标签 = 空白页（与抽屉同一条决定），看细节用 Edge 自带缩放
        fillImg(img, m.imageKey, m.image);
      }
      if (m.text) {
        const t = document.createElement('div');
        t.className = 'utext';
        t.textContent = m.text;
        node.appendChild(t);
      }
      return node;
    }
    node.className = 'msg bot';
    if (m.kind === 'answer') {
      const head = m.no ? `第${String(m.no).replace(/[^\dA-Za-z]/g, '')}题 ` : '';
      node.innerHTML =
        thinkDetails('思考', m.think || '') +
        '<div class="label">初答</div><div class="ans"></div><div class="why"></div>' +
        (m.tools?.length ? `<div class="tools">${m.tools.map((t) => `<div class="tool">${esc(t)}</div>`).join('')}</div>` : '') +
        verifyBox(m.verify) +
        (m.error ? `<div class="err">${esc(m.error)}</div>` : '');
      node.querySelector('.ans').innerHTML = md(head + (m.ans || ''));
      const why = node.querySelector('.why');
      if (m.why) why.innerHTML = md(m.why);
      else why.remove();
      return node;
    }
    node.innerHTML = thinkDetails('思考', m.think || '') + '<div class="chat"></div>';
    node.querySelector('.chat').innerHTML = md(m.text || '');
    if (m.tools?.length) {
      const box = document.createElement('div');
      box.className = 'tools';
      for (const t of m.tools) {
        const row = document.createElement('div');
        row.className = 'tool';
        row.textContent = t;
        box.appendChild(row);
      }
      node.appendChild(box);
    }
    return node;
  }

  function renderHistory() {
    const box = $('#history');
    box.innerHTML = '';
    if (!state.sid) {
      box.innerHTML = '<div class="hist-wrap"><div class="empty">还没有搜题记录。<br>回网页按 Alt+S 截一道题。</div></div>';
      return;
    }
    const msgs = state.sess?.messages || [];
    if (!msgs.length) {
      box.innerHTML = '<div class="hist-wrap"><div class="empty">这个会话还没有内容。</div></div>';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'hist-wrap';
    msgs.forEach((m, i) => wrap.appendChild(msgNode(m, i)));
    box.appendChild(wrap);
  }

  // ---- 流式期间的就地更新（端口事件驱动，不整份重绘，避免打断思考块与滚动） ----
  const nodeAt = (i) => document.querySelector(`#history .msg[data-mi="${i}"]`);

  function ensureThink(node) {
    let d = node.querySelector('details.think');
    if (!d) {
      d = document.createElement('details');
      d.className = 'think';
      d.innerHTML = '<summary>思考</summary><div class="think-b"></div>';
      node.insertBefore(d, node.firstChild);
    }
    return d.querySelector('.think-b');
  }

  // 回合忙不忙以**存储里的 status** 为准：端口事件可能丢（SW 重启/端口断开时正好在跑），
  // 只靠 turn-end 收尾会把输入框永久卡在「回答生成中…」
  const BUSY_STATUS = ['answering', 'verifying', 'searching'];
  function syncBusy() {
    const busy = BUSY_STATUS.includes(state.sess?.status);
    if (busy === state.streaming) return false;
    state.streaming = busy;
    updateComposer();
    return true;
  }

  async function reloadSession() {
    if (!state.sid) return;
    const got = await chrome.storage.local.get(K_SESS + state.sid);
    state.sess = got[K_SESS + state.sid] || null;
    syncBusy();
    renderHistory();
    maybeFollow();
    updateComposer();
  }

  async function openSession(sid, { updateHash = true } = {}) {
    state.sid = sid;
    state.follow = true;
    if (updateHash && location.hash !== '#' + sid) {
      try {
        history.replaceState(null, '', '#' + sid);
      } catch {
        /* ignore */
      }
    }
    const got = await chrome.storage.local.get(K_SESS + sid);
    state.sess = got[K_SESS + sid] || null;
    syncBusy();
    renderList();
    renderHistory();
    toBottom();
    updateComposer();
    // 看过了就清红点（只报「在看」，不报「没在看」——抽屉每 5s 也在报，别互相踩）
    if (!document.hidden) post({ type: 'view', sid, visible: true });
  }

  // ---------------------------------------------------------------- 输入框（从抽屉复制）
  const input = $('#input');

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(156, input.scrollHeight) + 'px';
  }

  function updateComposer() {
    const busy = !state.sid || state.streaming;
    input.disabled = busy;
    $('#send').disabled = busy;
    $('#stop').hidden = !state.streaming;
    input.placeholder = state.streaming
      ? '回答生成中…'
      : state.sid
        ? '接着问…（Enter 发送，Shift+Enter 换行）'
        : '先按 Alt+S 截一道题';
  }

  function send() {
    const text = input.value.trim();
    if (!text || !state.sid || state.streaming) return;
    input.value = '';
    autoGrow();
    // 乐观落一条：SW 会写同一份存储，回合收尾整份重绘对齐（同一事实源，不会重复）
    if (state.sess) state.sess.messages.push({ role: 'user', text, ts: Date.now() });
    state.follow = true;
    renderHistory();
    maybeFollow();
    post({ type: 'ask', sid: state.sid, text });
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('#send').addEventListener('click', send);
  // 停止生成：与抽屉顶栏 ■ 同一条协议（SW stopTurn → AbortController.abort），
  // 中止后 SW 把 status 落成 aborted，storage.onChanged → syncBusy() 自然收起本按钮
  $('#stop').addEventListener('click', () => {
    if (!state.sid || !state.streaming) return;
    post({ type: 'stop', sid: state.sid });
  });

  // ---- 拖入图片 URL：把网页里的图拖到输入框 = 当作截屏回合（SW fetch-image → 起回合） ----
  // dragover 必须 preventDefault，否则浏览器会把图片 URL 当导航直接打开（整页与抽屉同一套）
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
      showToast({ title: '拖进来的图片打不开', text: '只支持 http(s) 的图片链接' });
      return;
    }
    post({ type: 'fetch-image', url });
    showToast({ title: '正在读取图片', text: url.length > 70 ? url.slice(0, 70) + '…' : url });
  });

  // ---------------------------------------------------------------- 删除 / 重命名（复制自抽屉）
  // pendingDelete 分两种：{ kind:'sess' } 删会话、{ kind:'sub' } 删科目（会话只是移出，一个都不删）
  function askDelete(sid, title) {
    state.pendingDelete = { kind: 'sess', sid, title };
    $('#confirmTitle').textContent = '删除这个会话？';
    $('#confirmName').textContent = title;
    $('#confirm').classList.add('on');
    $('#confirmYes').focus();
  }
  function askDeleteSub(sub) {
    state.pendingDelete = { kind: 'sub', sid: sub.id, title: sub.name };
    $('#confirmTitle').textContent = '删除这个科目？（里面的会话只是移出，不会删）';
    $('#confirmName').textContent = sub.name;
    $('#confirm').classList.add('on');
    $('#confirmYes').focus();
  }
  function closeConfirm() {
    state.pendingDelete = null;
    $('#confirm').classList.remove('on');
  }
  $('#confirmNo').addEventListener('click', closeConfirm);
  $('#confirmYes').addEventListener('click', () => {
    const p = state.pendingDelete;
    closeConfirm();
    if (!p) return;
    if (p.kind === 'sub') post({ type: 'subject', op: 'delete', sub: p.sid });
    else if (p.kind === 'batch') {
      // 批量删除：把选中集抄出来逐条走同一座协议，成功即退多选
      for (const sid of p.sids) post({ type: 'delete', sid });
      setSelecting(false);
    } else post({ type: 'delete', sid: p.sid });
  });
  $('#confirm').addEventListener('click', (e) => {
    if (e.target === $('#confirm')) closeConfirm();
  });

  // pendingRename 分两种：{ kind:'sess' } 会话、{ kind:'sub' } 科目（同一个模态，标题口径跟着换）
  function askRename(sid, title) {
    state.pendingRename = { kind: 'sess', sid, title };
    $('#renameTitle').textContent = '重命名会话';
    $('#renameInput').value = title || '';
    $('#rename').classList.add('on');
    $('#renameInput').focus();
    $('#renameInput').select();
  }
  function askRenameSub(sub) {
    state.pendingRename = { kind: 'sub', sid: sub.id, title: sub.name };
    $('#renameTitle').textContent = '重命名科目';
    $('#renameInput').value = sub.name || '';
    $('#rename').classList.add('on');
    $('#renameInput').focus();
    $('#renameInput').select();
  }
  function closeRename() {
    state.pendingRename = null;
    $('#rename').classList.remove('on');
  }
  function commitRename() {
    const p = state.pendingRename;
    const title = ($('#renameInput').value || '').trim();
    closeRename();
    if (!p || !title) return;
    if (p.kind === 'sub') post({ type: 'subject', op: 'rename', sub: p.sid, name: title });
    else post({ type: 'rename', sid: p.sid, title });
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

  // ---- 新建科目（列表顶部按钮 → 命名框，与重命名同一套模态交互） ----
  function askNewSub() {
    $('#subInput').value = '';
    $('#subnew').classList.add('on');
    $('#subInput').focus();
  }
  function closeNewSub() {
    $('#subnew').classList.remove('on');
  }
  function commitNewSub() {
    const name = ($('#subInput').value || '').trim();
    closeNewSub();
    if (name) post({ type: 'subject', op: 'create', name });
  }
  $('#newSub').addEventListener('click', askNewSub);
  $('#subNo').addEventListener('click', closeNewSub);
  $('#subYes').addEventListener('click', commitNewSub);
  $('#subnew').addEventListener('click', (e) => {
    if (e.target === $('#subnew')) closeNewSub();
  });
  $('#subInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNewSub();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeNewSub();
    }
  });

  // ---- 多选批量操作（底栏）：全走已有 post 协议，批量收藏只弹一条 toast ----
  // 入口：head 的「批量选择」按钮（0 选起手），模式里它自己变成「退出选择」
  $('#selBtn').addEventListener('click', () => setSelecting(!state.selecting));
  $('#selCancel').addEventListener('click', () => setSelecting(false));

  /** 批量收藏：全已收藏 → 这次统一取消；否则把没收藏的都收上（单条 toggleFav 会 N 连弹，不能复用） */
  $('#bFav').addEventListener('click', () => {
    const sel = state.index.filter((s) => state.selected.has(s.id));
    if (!sel.length) return;
    const toFav = sel.some((s) => !s.fav);
    let n = 0;
    for (const s of sel) {
      if (!!s.fav === toFav) continue; // 已是目标状态，别再翻
      post({ type: 'favorite', sid: s.id, fav: toFav });
      s.fav = toFav; // 乐观更新：SW 改完存储会再广播，这里不等回执
      n += 1;
    }
    showToast({
      title: n ? (toFav ? `已收藏 ${n} 条` : `已取消收藏 ${n} 条`) : '操作失败',
      text: n ? `共选中 ${sel.length} 条` : '',
    });
    renderList();
  });

  $('#bMove').addEventListener('click', () => {
    if (state.selected.size) openPicker([...state.selected]);
  });

  /** 批量删除：确认框带条数，确定后逐条走 delete 协议、成功即退多选 */
  $('#bDel').addEventListener('click', () => {
    const n = state.selected.size;
    if (!n) return;
    state.pendingDelete = { kind: 'batch', sids: [...state.selected] };
    $('#confirmTitle').textContent = '删除会话';
    $('#confirmName').textContent = `确定删除选中的 ${n} 条会话吗？截图、回答与思考记录会一并删除，不可恢复。`;
    $('#confirm').classList.add('on');
    $('#confirmYes').focus();
  });

  // ---- 移入科目（移动端 openPicker 对应物）：列全部科目 + 「移出科目」，只发 assign ----
  function openPicker(ids) {
    state.pendingPick = ids;
    $('#pickTitle').textContent = ids.length > 1 ? `移入科目（${ids.length} 条）` : '移入科目';
    renderPickList();
    $('#subpick').classList.add('on');
  }
  function closePicker() {
    state.pendingPick = null;
    $('#subpick').classList.remove('on');
  }
  function renderPickList() {
    // 多条同科目才亮「当前」；科目不一致（mixed）则不亮任何行
    const subs = (state.pendingPick || []).map(
      (id) => (state.index.find((x) => x.id === id) || {}).sub || '',
    );
    const mixed = new Set(subs).size > 1;
    const cur = mixed ? '' : subs[0] || '';
    const rows = ['<button class="prow none" data-sub="" type="button">移出科目</button>'];
    for (const s of state.subjects) {
      rows.push(
        `<button class="prow${!mixed && cur === s.id ? ' on' : ''}" data-sub="${esc(s.id)}" ` +
          `type="button">${esc(s.name)}</button>`,
      );
    }
    $('#pickList').innerHTML = rows.join('');
  }
  $('#pickList').addEventListener('click', (e) => {
    const b = e.target.closest('.prow');
    const ids = state.pendingPick;
    if (!b || !ids || !ids.length) return;
    const sub = b.dataset.sub || null;
    for (const sid of ids) post({ type: 'subject', op: 'assign', sid, sub });
    closePicker();
  });
  $('#pickNo').addEventListener('click', closePicker);
  $('#subpick').addEventListener('click', (e) => {
    if (e.target === $('#subpick')) closePicker();
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (state.pendingDelete) closeConfirm();
      else if (state.pendingRename) closeRename();
      else if ($('#subnew').classList.contains('on')) closeNewSub();
      else if ($('#subpick').classList.contains('on')) closePicker();
      else if (state.selecting) setSelecting(false); // 模态优先，多选排在其后
    },
    true,
  );

  // ---------------------------------------------------------------- 端口与流式事件
  function onEvent(ev) {
    if (!ev) return;
    if (ev.type === 'title') {
      if (ev.sid === state.sid) renderTitle();
      syncIndex();
      return;
    }
    if (ev.sid && ev.sid !== state.sid) return; // 别的会话在跑，这里只管列表（存储会广播）
    switch (ev.type) {
      case 'answer-start': {
        state.streaming = true;
        state.sess?.messages.push({
          role: 'assistant',
          kind: 'answer',
          no: '',
          ans: '',
          why: '',
          verify: { ran: false },
          ts: Date.now(),
        });
        state.follow = true;
        renderHistory();
        maybeFollow();
        updateComposer();
        break;
      }
      case 'answer-delta': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        const head = ev.no ? `第${String(ev.no).replace(/[^\dA-Za-z]/g, '')}题 ` : '';
        const ans = node.querySelector('.ans');
        const why = node.querySelector('.why');
        if (ans) ans.innerHTML = md(head + (ev.ans || ''));
        if (why) why.innerHTML = md(ev.why || '');
        maybeFollow();
        break;
      }
      case 'tool': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        let box = node.querySelector('.tools');
        if (!box) {
          box = document.createElement('div');
          box.className = 'tools';
          node.insertBefore(box, node.querySelector('.verify') || null);
        }
        const row = document.createElement('div');
        row.className = 'tool';
        row.textContent = ev.name === 'web' ? `读取 ${ev.brief}` : `检索 ${ev.brief}`;
        box.appendChild(row);
        maybeFollow();
        break;
      }
      case 'verify-delta': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        let v = node.querySelector('.verify');
        if (!v) {
          v = document.createElement('div');
          v.className = 'verify';
          v.innerHTML = '<div class="vhead"><span>核实</span></div><div class="vnote"></div>';
          node.appendChild(v);
        }
        const note = v.querySelector('.vnote');
        if (note) note.innerHTML = md(ev.note || '');
        if (ev.done) v.querySelector('.vhead').innerHTML = `<span>核实</span>${chipHtml({ ran: !ev.skipped, skipped: !!ev.skipped, verdict: ev.verdict })}`;
        maybeFollow();
        break;
      }
      case 'think-delta': {
        const node = nodeAt(ev.idx);
        if (!node) break;
        ensureThink(node).innerHTML = esc(ev.think || '');
        maybeFollow();
        break;
      }
      case 'chat-start': {
        state.streaming = true;
        state.sess?.messages.push({ role: 'assistant', kind: 'chat', text: '', ts: Date.now() });
        state.follow = true;
        renderHistory();
        maybeFollow();
        updateComposer();
        break;
      }
      case 'chat-delta': {
        const node = nodeAt(ev.idx);
        const el = node?.querySelector('.chat');
        if (el) el.innerHTML = md(ev.total || '');
        maybeFollow();
        break;
      }
      case 'turn-end':
      case 'error':
        state.streaming = false;
        updateComposer();
        reloadSession();
        break;
      default:
        break;
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
    const p = port;
    p.onMessage.addListener((msg) => {
      if (msg.type === 'ev') return onEvent(msg.ev);
      if (msg.type === 'title-changed' || msg.type === 'session-created' || msg.type === 'session-deleted') {
        return syncIndex();
      }
      if (msg.type === 'turn-end') return reloadSession(); // 别的会话结束也要把本页对齐存储
      if (msg.type === 'toast') return; // 抽屉自己弹，页面不重复
    });
    p.onDisconnect.addListener(() => {
      // 与抽屉同一条纪律：断连原因挂在 runtime.lastError 上，不读就刷
      // Unchecked runtime.lastError: The page keeping the extension port is moved into
      // back/forward cache …（页面被搬进往返缓存时 Chrome 主动关端口）
      const why = chrome.runtime.lastError?.message;
      if (why) console.log('[spore] 端口断开：' + why);
      if (port !== p) return; // 已经换成新口了（bfcache 恢复后的重建），别再踢一次
      port = null;
      retryDelay = Math.min(4000, retryDelay * 2);
      reconnectTimer = setTimeout(connect, retryDelay);
    });
  }

  // ---- bfcache：页面进往返缓存时 Chrome 掐端口（有些版本不给 onDisconnect），
  // 进缓存前主动断、回来时主动重连；期间把文档挂起（suspended），垂死文档里
  // 任何 post/connect 都不许再开新口，否则 SW 会攒下永远关不掉的孤儿端口。 ----
  window.addEventListener('pagehide', () => {
    suspended = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
      connect();
    }
  });

  // ---------------------------------------------------------------- 交互
  document.querySelectorAll('.seg-b').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.selecting) setSelecting(false); // 换筛选（全部/收藏）先退多选：选中集要跟着视图走
      state.filter = b.dataset.filter;
      document.querySelectorAll('.seg-b').forEach((x) => x.classList.toggle('on', x === b));
      renderList();
    }),
  );

  function setCollapsed(v) {
    $('#sidebar').classList.toggle('collapsed', v);
    // 箭头跟**动作方向**走：展开态点了它会往左收进去（<），收起态点了它会往右拉出来（>）
    // —— 与抽屉半圆小角同一套口径（用户实测后指出方向反了）
    $('#collapse').textContent = v ? '>' : '<';
    try {
      localStorage.setItem(KEY_COLLAPSED, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  $('#collapse').addEventListener('click', () =>
    setCollapsed(!$('#sidebar').classList.contains('collapsed')),
  );
  let startCollapsed = false;
  try {
    startCollapsed = localStorage.getItem(KEY_COLLAPSED) === '1';
  } catch {
    /* ignore */
  }
  setCollapsed(startCollapsed); // 顺带把箭头方向对齐（按钮初始是空的）

  $('#rFav').addEventListener('click', () => {
    const hit = state.index.find((x) => x.id === state.sid);
    toggleFav(state.sid, !(hit && hit.fav));
  });

  // 用户往上翻就断开跟随（流式期间绝不把视图拽走），滚回底部再接上
  $('#history').addEventListener('scroll', () => {
    const h = $('#history');
    state.follow = h.scrollHeight - h.scrollTop - h.clientHeight < 60;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K_SUBJ]) {
      state.subjects = changes[K_SUBJ].newValue || [];
      renderList();
    }
    if (changes[K_INDEX]) {
      state.index = changes[K_INDEX].newValue || [];
      // 当前会话被删了就顺位到第一条；全删光就进空态，别停在一行旧数据上
      if (state.sid && !state.index.some((e) => e.id === state.sid)) {
        if (state.index[0]) {
          openSession(state.index[0].id);
          return;
        }
        state.sid = null;
        state.sess = null;
        state.streaming = false;
        renderList();
        renderHistory();
        updateComposer();
        return;
      }
      renderList();
    }
    const key = K_SESS + state.sid;
    if (changes[key]) {
      state.sess = changes[key].newValue || null;
      syncBusy(); // 状态以存储为准：SW 每次落盘都带 status，端口事件只是让它更快
      // 流式期间 DOM 由端口事件就地更新：整份重绘会打断思考块与滚动（1.2s 落盘一次）
      if (state.streaming) return;
      renderHistory();
      maybeFollow();
    }
  });

  window.addEventListener('hashchange', () => {
    const sid = decodeURIComponent(location.hash.slice(1));
    if (sid && sid !== state.sid && state.index.some((e) => e.id === sid)) openSession(sid, { updateHash: false });
  });

  // ---------------------------------------------------------------- 启动
  (async function boot() {
    try {
      state.subOpen = new Set(JSON.parse(localStorage.getItem(KEY_SUBOPEN) || '[]'));
    } catch {
      state.subOpen = new Set();
    }
    connect();
    updateComposer();
    const got = await chrome.storage.local.get([K_INDEX, K_SUBJ]);
    state.index = got[K_INDEX] || [];
    state.subjects = got[K_SUBJ] || [];
    renderList();
    const want = decodeURIComponent(location.hash.slice(1));
    const sid = state.index.some((e) => e.id === want) ? want : state.index[0]?.id;
    if (sid) await openSession(sid, { updateHash: false });
    else {
      renderTitle();
      renderHistory();
    }
  })();
})();
