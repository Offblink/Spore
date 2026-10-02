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
  };
  // 历史会反复重绘（回合内 1.2s 落盘一次），图片按 key 缓存，别每次都去 storage 捞几百 KB
  const imgCache = new Map();
  let port = null;
  let retryDelay = 400;

  const fmtStamp = (ms) => {
    const d = new Date(ms || 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const post = (msg) => {
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
    row.append(f, col, d, rn, x);
    row.addEventListener('click', () => openSession(e.id));
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
      '<button class="sx" type="button" title="删除科目">×</button>';
    f.querySelector('.sn').textContent = s.name;
    const cn = f.querySelector('.cn');
    if (cn) cn.textContent = String(members.length);
    f.addEventListener('click', () => toggleSub(s.id));
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
    else post({ type: 'delete', sid: p.sid });
  });
  $('#confirm').addEventListener('click', (e) => {
    if (e.target === $('#confirm')) closeConfirm();
  });

  function askRename(sid, title) {
    state.pendingRename = sid;
    $('#renameInput').value = title || '';
    $('#rename').classList.add('on');
    $('#renameInput').focus();
    $('#renameInput').select();
  }
  function closeRename() {
    state.pendingRename = null;
    $('#rename').classList.remove('on');
  }
  function commitRename() {
    const sid = state.pendingRename;
    const title = ($('#renameInput').value || '').trim();
    closeRename();
    if (sid && title) post({ type: 'rename', sid, title });
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
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (state.pendingDelete) closeConfirm();
      else if (state.pendingRename) closeRename();
      else if ($('#subnew').classList.contains('on')) closeNewSub();
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
    try {
      port = chrome.runtime.connect({ name: 'spore' });
    } catch {
      setTimeout(connect, retryDelay);
      return;
    }
    retryDelay = 400;
    port.onMessage.addListener((msg) => {
      if (msg.type === 'ev') return onEvent(msg.ev);
      if (msg.type === 'title-changed' || msg.type === 'session-created' || msg.type === 'session-deleted') {
        return syncIndex();
      }
      if (msg.type === 'turn-end') return reloadSession(); // 别的会话结束也要把本页对齐存储
      if (msg.type === 'toast') return; // 抽屉自己弹，页面不重复
    });
    port.onDisconnect.addListener(() => {
      port = null;
      retryDelay = Math.min(4000, retryDelay * 2);
      setTimeout(connect, retryDelay);
    });
  }

  // ---------------------------------------------------------------- 交互
  document.querySelectorAll('.seg-b').forEach((b) =>
    b.addEventListener('click', () => {
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
