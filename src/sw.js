// Spore service worker：快捷键截图 → 框选 → 裁剪 → 建会话 → 跑 Agent → 通知/红点。
// 所有存储写入都在这里（单写者），抽屉只读 + 订阅 chrome.storage.onChanged；
// 流式增量走 port（高频），存储按 1.2s 节流落盘。
import * as store from './lib/store.js';
import { runTurn, runVerifyOnly, ensureNamed } from './lib/agent.js';
import { searchPlan, setSearchProxy, toolWebSearch } from './lib/tools.js';

const MAX_CROP_LONG = 1600;
const JPEG_QUALITY = 0.82;

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();
/** @type {Map<string, AbortController>} */
const running = new Map();
/** @type {Map<number, (rect|null)=>void>} */
const pendingSelection = new Map();

let viewState = { sid: null, visible: false, ts: 0 };
/** chrome.commands 与页面内 keydown 两条通道的去重时间戳 */
let lastCaptureAt = 0;
const persistTimers = new Map();

function broadcast(ev, tabId = null) {
  let delivered = 0;
  for (const p of ports) {
    // port.sender.tab 拿不到 tabId 时（个别页面）宁可多投，也不能漏投
    if (tabId != null && p.__tabId != null && p.__tabId !== tabId) continue;
    try {
      p.postMessage(ev);
      delivered += 1;
    } catch {
      ports.delete(p);
    }
  }
  return delivered;
}

const emit = (ev) => broadcast({ type: 'ev', ev });

/**
 * 系统通知。两个实测坑：
 * ① iconUrl **必须给绝对 URL**（chrome.runtime.getURL）——
 *    相对路径 `icons/128.png` 会走图片下载管线并抛
 *    "Unable to download all specified images."，通知静默失败（这就是用户看到的那句报错）；
 * ② create 返回 Promise，失败不会被 try/catch 接住 → 必须手动 .catch 并落日志。
 */
function notify(title, message, sid) {
  try {
    const p = chrome.notifications.create(`spore-${sid}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title,
      message: String(message || '').slice(0, 180) || '回答完毕',
      priority: 0,
    });
    if (p && typeof p.then === 'function') {
      p.catch((e) => store.logEvent(`notify failed: ${e && e.message}`));
    }
  } catch (e) {
    store.logEvent(`notify threw: ${e && e.message}`);
  }
}

async function updateBadge() {
  const idx = await store.listSessions();
  const n = idx.filter((e) => e.unread).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#ec4899' });
  await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(99, n)) : '' });
}

// ------------------------------------------------------------------ 回合

function schedulePersist(sid) {
  if (persistTimers.has(sid)) return;
  const t = setTimeout(async () => {
    persistTimers.delete(sid);
    try {
      const sess = await store.getSession(sid);
      if (sess) await store.saveSession(sess);
    } catch (e) {
      console.warn('[spore] persist failed', e);
    }
  }, 1200);
  persistTimers.set(sid, t);
}

/** 回合跑着时每 12s 打一次空 API：重置 MV3 SW 的空闲回收计时，别把回合连锅端 */
let keepAliveTimer = null;
function bumpKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!running.size) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    chrome.runtime.getPlatformInfo(() => {});
  }, 12000);
}

async function startTurn(sid, opts = {}) {
  if (running.has(sid)) {
    store.logEvent(`startTurn: ${sid} 已在跑，忽略重复触发`);
    return;
  }
  store.logEvent(opts.verifyOnly ? `startTurn(仅核实) ${sid}` : `startTurn ${sid}`);
  const settings = await store.getSettings();
  const ctl = new AbortController();
  running.set(sid, ctl);
  bumpKeepAlive();
  broadcast({ type: 'turn-start', sid });

  let failed = false;
  try {
    await (opts.verifyOnly
      ? runVerifyOnly({ sid, emit, signal: ctl.signal, settings })
      : runTurn({ sid, emit, signal: ctl.signal, settings }));
  } catch (e) {
    failed = true;
    emit({ type: 'error', sid, message: String(e.message || e).slice(0, 200) });
    emit({ type: 'turn-end', sid, error: true });
  } finally {
    running.delete(sid);
    const timer = persistTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(sid);
    }
    // 兜底：runTurn 正常会把状态写成 done/error/aborted；还停在 answering 就是异常退出
    try {
      const after = await store.getSession(sid);
      if (after && (after.status === 'answering' || after.status === 'verifying' || after.status === 'searching')) {
        store.logEvent(`zombieGuard ${sid}: status=${after.status} msgs=${after.messages.length} (live object never persisted)`);
        after.status = 'error';
        after.errorMsg = after.errorMsg || '回合异常中断，点 ↻ 重试';
        await store.saveSession(after);
      }
    } catch {
      /* ignore */
    }
    // 最后保险：占位标题必须换掉
    try {
      const finalSess = await store.getSession(sid);
      if (finalSess && /^解析中/.test(finalSess.title || '')) {
        // 注意：ServiceWorker 里 **禁止** 动态 import()（HTML 规范），必须走顶部静态导入
        ensureNamed(finalSess, emit);
      }
    } catch (e) {
      store.logEvent(`ensureNamed failed ${sid}: ${e && e.message}`);
    }
    await settleTurn(sid, failed);
    store.endTurnSession(sid); // settleTurn 之后才摘，保证收尾读写的也是同一份对象
    broadcast({ type: 'turn-end', sid });
  }
}

/** 回合结束：镜像落盘 + 按「是否正在看」决定红点与系统通知 */
async function settleTurn(sid, failed) {
  const sess = await store.getSession(sid);
  if (!sess) return;

  const viewing = viewState.sid === sid && viewState.visible && Date.now() - viewState.ts < 15000;
  const seen = viewing;

  if (!seen) {
    sess.unread = true;
    await store.saveSession(sess);
  }

  const title = sess.title || 'Spore';
  const preview = previewOf(sess);

  if (failed) {
    if (!seen) notify(`${title} · 出错了`, sess.errorMsg || '回答失败', sid);
  } else if (!viewing) {
    notify(title, preview, sid);
  }
  broadcast({ type: 'toast', sid, title, text: preview, failed });
  const channel = await mirrorChannel();
  if (channel.on) await store.mirrorSession(sess, { allowDownload: channel.allowDownload });
  await updateBadge();
}

/** 镜像通道：选过静默目录 → 直接写盘；否则只有用户显式允许才回落下载（会弹气泡） */
async function mirrorChannel() {
  try {
    const settings = await store.getSettings();
    if (settings.mirror === false) return { on: false, allowDownload: false };
    const status = await store.mirrorStatus();
    if (status.mode === 'fs') return { on: true, allowDownload: false };
    return { on: true, allowDownload: settings.mirrorDownloads === true };
  } catch {
    return { on: false, allowDownload: false };
  }
}

function previewOf(sess) {
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m.kind === 'answer' && m.ans) return `${m.ans}${m.why ? ' — ' + m.why : ''}`;
    if (m.kind === 'chat' && m.text) return m.text;
  }
  return '回答完毕';
}

function stopTurn(sid) {
  const ctl = running.get(sid);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

// ------------------------------------------------------------------ 截图

function requestRect(tabId) {
  return new Promise((resolve) => {
    const prev = pendingSelection.get(tabId);
    if (prev) prev(null);
    pendingSelection.set(tabId, resolve);
    setTimeout(() => {
      if (pendingSelection.get(tabId) === resolve) {
        pendingSelection.delete(tabId);
        resolve(null);
      }
    }, 180000);
  });
}

async function captureFlow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const tabId = tab.id;

  // 1) 让抽屉先隐藏，别进截图
  let hadContent = true;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'spore:before-capture' });
  } catch {
    hadContent = false; // 内部页面 / 注入失败：该页通常也截不了图
  }

  // 2) 抓当前视口
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    broadcast({ type: 'toast', sid: null, title: '无法截图', text: '浏览器内部页面不支持截图', failed: true }, tabId);
    if (hadContent) await chrome.tabs.sendMessage(tabId, { type: 'spore:after-capture' }).catch(() => {});
    return;
  }

  // 3) 注入框选层
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/overlay.js'] });
  } catch (e) {
    broadcast({ type: 'toast', sid: null, title: '无法截图', text: String(e.message || e), failed: true }, tabId);
    if (hadContent) await chrome.tabs.sendMessage(tabId, { type: 'spore:after-capture' }).catch(() => {});
    return;
  }

  const waiter = requestRect(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'spore:select', shot });
  } catch {
    pendingSelection.delete(tabId);
    if (hadContent) await chrome.tabs.sendMessage(tabId, { type: 'spore:after-capture' }).catch(() => {});
    return;
  }

  const rect = await waiter;
  if (hadContent) await chrome.tabs.sendMessage(tabId, { type: 'spore:after-capture' }).catch(() => {});
  if (!rect) {
    store.logEvent('capture: 用户取消框选');
    return;
  }
  store.logEvent(`capture: rect=${JSON.stringify(rect)}`);

  let image;
  try {
    image = await cropShot(shot, rect);
  } catch (e) {
    broadcast({ type: 'toast', sid: null, title: '裁剪失败', text: String(e.message || e), failed: true }, tabId);
    return;
  }

  // 4) 建会话 + 落图 + 弹抽屉 + 起跑
  const sess = await store.createSession({ title: store.stampTitle() });
  store.logEvent(`capture: 新会话 ${sess.id} note=${JSON.stringify(rect.note || '')}`);
  const idx = 0;
  // 图片单独成键、只写一次：会话对象里只留 imageKey，saveSession 从此不碰图片
  const imageKey = await store.putImage(sess.id, idx, image);
  sess.messages.push({ role: 'user', ts: Date.now(), imageKey, text: rect.note || '' });
  sess.status = 'answering';
  await store.saveSession(sess);
  try {
    const channel = await mirrorChannel();
    if (channel.on) {
      await store.mirrorImage(sess, idx, image, { allowDownload: channel.allowDownload });
      // 先落一版「只有截图」的 md，回答完成后再覆盖
      store.mirrorSession(sess, { allowDownload: channel.allowDownload }).catch(() => {});
    }
  } catch (e) {
    console.warn('[spore] image mirror failed', e);
  }
  await updateBadge();

  const delivered = broadcast({ type: 'session-created', sid: sess.id, tabId }, tabId);
  console.log(`[spore] session-created ${sess.id} → ${delivered} port(s), tabId=${tabId}`);
  await startTurn(sess.id);
}

async function cropShot(shot, rect) {
  const blob = await (await fetch(shot)).blob();
  const bmp = await createImageBitmap(blob);
  const rx = rect.viewportW > 0 ? bmp.width / rect.viewportW : 1;
  const ry = rect.viewportH > 0 ? bmp.height / rect.viewportH : 1;

  const sx = Math.max(0, Math.round(rect.x * rx));
  const sy = Math.max(0, Math.round(rect.y * ry));
  const sw = Math.min(bmp.width - sx, Math.max(1, Math.round(rect.w * rx)));
  const sh = Math.min(bmp.height - sy, Math.max(1, Math.round(rect.h * ry)));
  if (sw < 8 || sh < 8) {
    bmp.close?.();
    throw new Error('选区太小');
  }

  const scale = Math.min(1, MAX_CROP_LONG / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close?.();

  const out = await cv.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  const buf = await out.arrayBuffer();
  return `data:image/jpeg;base64,${toBase64(new Uint8Array(buf))}`;
}

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ------------------------------------------------------------------ 消息

async function handleContent(msg, port) {
  const senderTab = port?.sender?.tab?.id;
  switch (msg.type) {
    case 'ping':
      return;

    case 'view':
      viewState = { sid: msg.sid || null, visible: !!msg.visible, ts: Date.now() };
      if (msg.sid && msg.visible) {
        const sess = await store.getSession(msg.sid);
        if (sess?.unread) await store.setUnread(msg.sid, false);
        await updateBadge();
      }
      return;

    case 'ask': {
      const sid = msg.sid;
      if (!sid) return;
      const sess = await store.getSession(sid);
      if (!sess) return;
      if (String(msg.text || '').trim()) {
        sess.messages.push({ role: 'user', ts: Date.now(), text: String(msg.text).trim() });
        sess.status = 'answering';
        await store.saveSession(sess);
      }
      broadcast({ type: 'index-changed' });
      await startTurn(sid);
      return;
    }

    case 'stop':
      stopTurn(msg.sid);
      return;

    case 'retry': {
      const sess = await store.getSession(msg.sid);
      if (!sess || running.has(msg.sid)) return;
      // 丢掉最后一条回答（含中断/出错的那条），让最后一个用户问题重新被回答
      const last = sess.messages[sess.messages.length - 1];
      if (last && last.role === 'assistant') sess.messages.pop();
      sess.status = 'answering';
      sess.errorMsg = '';
      sess.unread = false;
      await store.saveSession(sess);
      broadcast({ type: 'session-updated', sid: sess.id });
      await startTurn(sess.id);
      return;
    }

    case 'rename': {
      const saved = await store.renameSession(msg.sid, msg.title);
      store.logEvent(`rename → "${saved}" (sid=${msg.sid})`);
      // 用 ev 走 onEvent：抽屉那边会连标题元素一起刷新
      broadcast({ type: 'ev', ev: { type: 'title', sid: msg.sid, title: saved || msg.title } });
      return;
    }

    case 'favorite': {
      // 收藏只动索引的 fav 字段；抽屉靠 storage.onChanged 重排列表与星标
      await store.setFavorite(msg.sid, !!msg.fav);
      store.logEvent(`favorite → sid=${msg.sid} fav=${!!msg.fav}`);
      return;
    }

    case 'subject': {
      // 科目只活在整页搜题记录里；两个面都靠 storage.onChanged 收到 spore.subjects / spore.index 的变化
      if (msg.op === 'create') {
        const sub = await store.createSubject(msg.name);
        store.logEvent(`subject create → ${sub ? `${sub.id} "${sub.name}"` : '（空名被拒）'}`);
      } else if (msg.op === 'assign') {
        await store.assignSubject(msg.sid, msg.sub || null);
        store.logEvent(`subject assign → sid=${msg.sid} sub=${msg.sub || '-'}`);
      } else if (msg.op === 'delete') {
        await store.deleteSubject(msg.sub);
        store.logEvent(`subject delete → id=${msg.sub}`);
      }
      return;
    }

    case 'delete':
      stopTurn(msg.sid);
      await store.deleteSession(msg.sid);
      broadcast({ type: 'session-deleted', sid: msg.sid });
      await updateBadge();
      return;

    case 'toggle-drawer':
      if (senderTab != null) broadcast({ type: 'toggle-drawer' }, senderTab);
      return;

    case 'open-options':
      // content script 没有 openOptionsPage，由 SW 代开
      chrome.runtime.openOptionsPage().catch((e) => console.warn('[spore] open options failed', e));
      return;

    case 'capture': {
      // 页面内 keydown 通道：若 chrome.commands 已经触发过，400ms 内忽略，避免截两次
      if (Date.now() - lastCaptureAt < 400) return;
      lastCaptureAt = Date.now();
      void captureFlow().catch((e) => console.error('[spore] capture failed', e));
      return;
    }

    case 'verify-now': {
      // 「核实一下」按钮：只对已有回答跑阶段B（设置里关掉自动核实后才会出现这个按钮）
      if (!msg.sid) return;
      if (running.has(msg.sid)) {
        store.logEvent(`verify-now ${msg.sid}: 已有回合在跑，忽略`);
        return;
      }
      void startTurn(msg.sid, { verifyOnly: true });
      return;
    }

    case 'log':
      store.logEvent(`${msg.scope || 'content'}: ${msg.msg}`);
      return;

    case 'log-clear':
      void store.clearLog().catch(() => {});
      return;

    default:
      return;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 框选层回传（runtime 消息，因为它是后来注入的）
  if (msg?.type === 'spore:rect') {
    const key = msg.tabId ?? sender.tab?.id;
    const resolve = pendingSelection.get(key);
    if (resolve) {
      pendingSelection.delete(key);
      resolve(msg.rect || null);
    }
    sendResponse({ ok: true });
    return false;
  }
  handleContent(msg, null).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'spore') return;
  ports.add(port);
  port.__tabId = port.sender?.tab?.id ?? null;
  port.onMessage.addListener((msg) => {
    handleContent(msg, port).catch((e) => console.warn('[spore] msg failed', e));
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

// ------------------------------------------------------------------ 入口

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-region') {
    lastCaptureAt = Date.now();
    captureFlow().catch((e) => console.error('[spore] capture failed', e));
    return;
  }
  if (command === 'toggle-drawer') broadcast({ type: 'toggle-drawer' });
});

chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'spore:toggle' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/drawer.js'] }).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  const sid = id.replace(/^spore-/, '').replace(/-\d{13}$/, '');
  const idx = await store.listSessions();
  const target = idx.find((e) => e.id === sid) || idx[0];
  if (!target) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'spore:open', sid: target.id }).catch(() => {});
  }
  if (target.unread) await store.setUnread(target.id, false);
  await updateBadge();
});

chrome.commands.getAll().then((list) => {
  const cap = list.find((c) => c.name === 'capture-region');
  const tog = list.find((c) => c.name === 'toggle-drawer');
  chrome.storage.local.set({ 'spore.shortcut': cap?.shortcut || '', 'spore.shortcut.toggle': tog?.shortcut || '' });
});

async function init() {
  // SW 被杀/浏览器重启后，残留的 running 状态一律判为中断
  const idx = await store.listSessions();
  let dirty = false;
  for (const e of idx) {
    if (e.status === 'answering' || e.status === 'verifying' || e.status === 'searching') {
      const sess = await store.getSession(e.id);
      if (sess && (sess.status === 'answering' || sess.status === 'verifying' || sess.status === 'searching')) {
        sess.status = 'interrupted';
        sess.unread = true;
        sess.errorMsg = '上次回答被中断（扩展重启），可点重试';
        await store.saveSession(sess);
        dirty = true;
      }
    }
  }
  if (dirty) await updateBadge();
  updateBadge().catch(() => {});

  // 清扫老构建遗留标题：「解析中…」占位 → 本地兜底起名；
  // `MMDD-…` 日期前缀 → 去掉（日期已下放到列表行小字，标题含日期是不合法旧格式）
  try {
    for (const e of await store.listSessions()) {
      const t = e.title || '';
      if (/^解析中/.test(t)) {
        const sess = await store.getSession(e.id);
        if (sess) ensureNamed(sess, (ev) => broadcast({ type: 'ev', ev }));
      } else if (/^\d{4}-/.test(t)) {
        const stripped = t.replace(/^\d{4}-/, '');
        const final = /^\d{4}$/.test(stripped) ? '新会话' : stripped; // 旧占位 0927-1649 → 新会话
        if (final !== t) {
          await store.renameSession(e.id, final);
          store.logEvent(`sweep标题: ${JSON.stringify(t)} → ${JSON.stringify(final)}`);
        }
      }
    }
  } catch (e) {
    store.logEvent(`sweep标题失败: ${e && e.message}`);
  }

  // 老会话迁移：截图从消息体挪进独立键（幂等；只动老格式，新会话一开始就是新格式）
  try {
    const moved = await store.migrateImageKeys();
    if (moved) store.logEvent(`sweep图片: ${moved} 张移出会话对象`);
  } catch (e) {
    store.logEvent(`sweep图片失败: ${e && e.message}`);
  }

  // 镜像目录授权失效（浏览器重启会重置 FSA 授权）→ 提醒一次，否则用户会莫名其妙看到下载气泡
  try {
    const status = await store.mirrorStatus();
    if (status.mode === 'expired') {
      notify('Spore 镜像目录授权失效', `「${status.dir}」需要重新授权，点击打开设置`, '');
    }
  } catch {
    /* ignore */
  }
}

// 调试面：service worker 里不能动态 import()（HTML 规范禁止），
// 自动化排查/控制台排错时用它拿日志、会话与端口状态。
// tools.js 通过它把检索结果写进同一个日志环（避免 tools↔store 循环依赖）
globalThis.__sporeToolLog = (msg) => store.logEvent(msg);

globalThis.__spore = {
  store,
  log: () => store.readLog(),
  sessions: () => store.listSessions(),
  session: (id) => store.getSession(id),
  ports: () => [...ports].map((p) => ({ tabId: p.__tabId ?? null })),
  running: () => [...running.keys()],
  // e2e 用：读盘上的「代理」设置并算出引擎链（钉住 设置→定序 这条契约，不依赖真网络）
  searchPlan: async () => {
    const s = await store.getSettings();
    return { proxy: String(s.proxy || ''), plan: searchPlan(s.proxy) };
  },
  // 排查用：真跑一次检索（按盘上的「代理」设置定腿序），结果与腿级日志一起进日志环。
  // 手动验证「检索代理」是否生效：改设置 → 控制台 await __spore.webSearch('…') → 看日志的模式行。
  webSearch: async (query) => {
    const s = await store.getSettings();
    setSearchProxy(s.proxy);
    return toolWebSearch(String(query ?? ''), undefined);
  },
};

chrome.runtime.onInstalled.addListener(() => {
  store.getSettings().then((s) => store.saveSettings(s));
  init();
});

init().catch((e) => console.warn('[spore] init failed', e));
