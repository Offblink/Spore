// 会话存储：chrome.storage.local（索引 + 一 key 一会话），外加磁盘镜像。
// 镜像优先走 File System Access（选过目录就完全静默，不弹下载气泡），没选才回落 chrome.downloads。
// 所有写入都发生在 service worker 里（单写者），content script 只读。
import * as fs from './fs.js';

const K_INDEX = 'spore.index';
const K_LOG = 'spore.log';

/**
 * 落盘诊断日志（环形 300 条）：设置页里有「日志」卡片直接看，不用猜。
 * 所有写入都在 SW 里；日志本身就是诊断对象，一律 try/catch 兜住，
 * 绝不能让日志本身抛异常去打断业务路径。
 */
const logBuf = [];
export function logEvent(msg) {
  try {
    const at = new Date().toISOString().slice(11, 23);
    logBuf.push(`${at} ${msg}`);
    if (logBuf.length > 300) logBuf.shift();
    chrome.storage.local.set({ [K_LOG]: logBuf.slice() }).catch(() => {});
    console.log(`[spore] ${msg}`);
  } catch {
    /* 日志不许影响业务 */
  }
}
export async function readLog() {
  try {
    const got = await chrome.storage.local.get(K_LOG);
    return got[K_LOG] || [];
  } catch {
    return [];
  }
}
export async function clearLog() {
  logBuf.length = 0;
  await chrome.storage.local.remove(K_LOG).catch(() => {});
}
const K_SETTINGS = 'spore.settings';
const K_SESS = 'spore.sess.';
const K_IMG = 'spore.img.';

export const DEFAULT_SETTINGS = {
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-v4-flash-vision-exp',
  apiKey: '', // 真实 key 不入库：设置页填写；e2e 从 tests/_run/e2e_key（gitignore）或 SPORE_E2E_KEY 读
  maxToolRounds: 5, // 核实阶段最多几轮检索；追问的工具循环取 max(1, 它)
  historyLimit: 10, // 上下文保留多少条消息
  fastNoThink: true, // 初答「直接作答不写推理」（实测 reasoning_effort=none 可归零思考）
  autoVerify: true, // 答完自动联网核实；关掉后回答里出现「核实一下」按钮，点它才核实
  // 检索代理（可选）：填了 = 浏览器走代理 → 引擎链 ddg→bing→brave；留空 = 只走 bing。
  // 浏览器自己已按系统代理路由，扩展没法只给检索换代理，这个字段决定的是「信任哪套引擎」。
  proxy: '',
  hideToggle: false, // 隐藏半圆小角（默认露出；隐藏后用 Alt+Z 唤出/收起抽屉）
  mirror: true, // 磁盘镜像开关
  mirrorRoot: 'Spore/sessions',
  // 没选静默目录时回落到下载（默认开：默认位置就是 Downloads，代价是 Edge 会弹下载列表；
  // 一旦在设置里选了静默目录，就改走 File System Access，完全静默）
  mirrorDownloads: true,
};

export async function getSettings() {
  const got = await chrome.storage.local.get(K_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(got[K_SETTINGS] || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [K_SETTINGS]: next });
  return next;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shortDate(d = new Date()) {
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function timeStr(d = new Date()) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function newId(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${timeStr(d)}`;
}

export async function listSessions() {
  const got = await chrome.storage.local.get(K_INDEX);
  return got[K_INDEX] || [];
}

/** 索引写入链：setIndex 的临界区排队用（见 setIndex 注释） */
let indexLock = Promise.resolve();

async function setIndex(mutate) {
  // 串行化读改写临界区：本函数是 get → mutate → set，而 SW 的 handleContent 不 await、
  // 整页多选的批量操作（批量收藏/移入/删除）会把多条消息背靠背发进来 —— 两条消息的 get
  // 读到同一份旧快照，后一条的 set 就把前一条的改动盖掉了（实测批量两条必丢一条）。
  // 用一条 Promise 链把临界区排队，后续调用等前一次写完再读。
  const run = indexLock.then(async () => {
    const got = await chrome.storage.local.get(K_INDEX);
    const index = got[K_INDEX] || [];
    const next = await mutate(index.slice());
    await chrome.storage.local.set({ [K_INDEX]: next });
    return next;
  });
  indexLock = run.catch(() => {}); // 失败不锁链：下一次照常排队，错误照常抛给本次调用方
  return run;
}

/**
 * 回合进行中，会话的唯一事实源是**在途对象**（runTurn 手里那份）。
 * 之前每个写入方（心跳 setUnread、rename、patchIndex、settleTurn）都自己重读一份再写回，
 * 读到的可能是 1.2s 前的陈旧副本 —— 答案就是这样被覆盖没的。
 * 现在：有在途回合就返回同一个引用，所有写入天然同步。
 */
const liveSessions = new Map();

export function beginTurnSession(sess) {
  liveSessions.set(sess.id, sess);
}

export function endTurnSession(sid) {
  liveSessions.delete(sid);
}

export async function getSession(id) {
  const live = liveSessions.get(id);
  if (live) return live;
  const got = await chrome.storage.local.get(K_SESS + id);
  return got[K_SESS + id] || null;
}

/**
 * 截图**单独成键、只写一次**：图片是不可变的，混在会话对象里会被每次
 * saveSession 整份重写（流式期间每 1.2s 一次，实测 2~3× 写放大），
 * 还会随 storage.onChanged 把含全部图片的新值广播给每个标签页。
 * 会话消息里只留 `imageKey` 引用；发请求/渲染时再取回 data URL。
 */
export async function putImage(sid, idx, dataUrl) {
  const key = `${K_IMG}${sid}.${idx}`;
  await chrome.storage.local.set({ [key]: dataUrl });
  return key;
}

/** 取回 data URL（发模型、抽屉渲染、点开大图都走这里）；没有则 null */
export async function getImage(key) {
  if (!key) return null;
  const got = await chrome.storage.local.get(key);
  return got[key] || null;
}

/** 消息 → data URL：新格式走 imageKey，老会话兜底直读旧字段 */
export async function resolveImage(m) {
  if (!m) return null;
  if (m.imageKey) return getImage(m.imageKey);
  return typeof m.image === 'string' && m.image.startsWith('data:') ? m.image : null;
}

/** 是否带截图（新旧两种形态都算） */
export function hasImage(m) {
  return !!(m && (m.imageKey || m.image));
}

/**
 * 老会话迁移（幂等，启动 sweep 调一次）：把消息体里的 data URL 挪进独立键。
 * 与标题 sweep 同款套路：只读取证、逐会话写、失败不断业务。
 */
export async function migrateImageKeys() {
  let moved = 0;
  for (const e of await listSessions()) {
    const sess = await getSession(e.id);
    if (!sess) continue;
    let dirty = false;
    for (const [i, m] of sess.messages.entries()) {
      if (typeof m.image === 'string' && m.image.startsWith('data:')) {
        m.imageKey = await putImage(sess.id, i, m.image);
        delete m.image;
        dirty = true;
        moved++;
      }
    }
    if (dirty) await saveSession(sess);
  }
  if (moved) logEvent(`migrateImageKeys: ${moved} 张图移出会话对象`);
  return moved;
}

/**
 * 会话占位标题：日期/时间已下放到列表行小字，**标题一律不含日期**（起名契约）。
 * 答题后必被 kickNaming 换成「题号 + 大意」；万一整回合失败也绝不露出日期。
 */
export function stampTitle() {
  return '新会话';
}

export async function createSession({ title = stampTitle(), id = newId() } = {}) {
  const now = Date.now();
  const sess = { id, title, created: now, updated: now, messages: [], status: 'idle', unread: false };
  await chrome.storage.local.set({ [K_SESS + id]: sess });
  await setIndex((idx) => [
    { id, title, created: now, updated: now, count: 0, status: 'idle', unread: false },
    ...idx,
  ]);
  return sess;
}

/**
 * 定稿标题：异步起名（kickNaming）是在回合跑到一半时改名的，
 * 而在途的 sess 对象还攥着旧 title，下一次 saveSession 会把它写回索引。
 * 这里记一份 override，所有写入统一带上，旧对象就再也覆盖不掉了。
 */
const titleOverrides = new Map();

/**
 * 节流落盘：拿**在途**的会话对象（不是重读一遍，那样等于没写）。
 * 流式期间每 1.2s 落一次，SW 被回收最多丢 1.2s 的内容，而不是丢掉整个回合。
 */
const pendingSaves = new Map();

export function scheduleSave(sess) {
  const cur = pendingSaves.get(sess.id);
  if (cur) {
    cur.sess = sess;
    return; // 已有挂起任务：只更新对象，不写日志（每个 delta 都会调进来）
  }
  logEvent(`scheduleSave(arm) ${sess.id} msgs=${sess.messages.length}`);
  const entry = { sess, timer: 0 };
  entry.timer = setTimeout(() => {
    pendingSaves.delete(sess.id);
    saveSession(entry.sess).catch((e) => console.warn('[spore] scheduled save failed', e));
  }, 1200);
  pendingSaves.set(sess.id, entry);
}

/** 立即落盘：无论有没有挂起的定时器，都要把**调用方给的这份活对象**写进去。
 *  早期实现是「没有挂起就直接返回」——回合收尾时若恰好没有 pending，
 *  verify/status 等最后的改动就永远写不下去，会话停在 answering 被判成异常。 */
export function flushSave(sess) {
  const cur = pendingSaves.get(sess.id);
  if (cur) {
    clearTimeout(cur.timer);
    pendingSaves.delete(sess.id);
  }
  return saveSession(sess).catch((e) => {
    logEvent(`flushSave FAILED ${sess.id}: ${e && e.message}`);
    console.warn('[spore] flush save failed', e);
  });
}

export async function saveSession(sess) {
  const fixed = titleOverrides.get(sess.id);
  if (fixed) sess.title = fixed;
  sess.updated = Date.now();
  logEvent(`saveSession ${sess.id} msgs=${sess.messages.length} status=${sess.status}`);
  await chrome.storage.local.set({ [K_SESS + sess.id]: sess });
  await setIndex((idx) =>
    idx.map((e) =>
      e.id === sess.id
        ? {
            ...e,
            title: sess.title,
            updated: sess.updated,
            count: sess.messages.length,
            status: sess.status,
            unread: !!sess.unread,
          }
        : e,
    ),
  );
  return sess;
}

/** 收藏/取消收藏：只动索引的 fav 字段（列表置顶与星标都读它），不动会话正文 */
export async function setFavorite(id, fav) {
  await patchIndex(id, { fav: !!fav });
}

// ---------------------------------------------------------------- 科目（整页搜题记录的目录形态）
// 只有整页用，抽屉列表不认识它；归属记在索引条目的 sub 字段上（null = 未归类）。
const K_SUBJ = 'spore.subjects';

export async function listSubjects() {
  const got = await chrome.storage.local.get(K_SUBJ);
  return got[K_SUBJ] || [];
}

/** 新建科目：追加到尾部（渲染时一律排在列表最前，创建越早越靠上） */
export async function createSubject(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const list = await listSubjects();
  const sub = { id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: clean };
  list.push(sub);
  await chrome.storage.local.set({ [K_SUBJ]: list });
  return sub;
}

/** 删除科目：成员解除归属（会话一个都不删），再摘掉科目本身 */
export async function deleteSubject(id) {
  const list = (await listSubjects()).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [K_SUBJ]: list });
  await setIndex((idx) => idx.map((e) => (e.sub === id ? { ...e, sub: null } : e)));
}

/** 重命名科目：只改名，不动成员 */
export async function renameSubject(id, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const list = await listSubjects();
  const hit = list.find((s) => s.id === id);
  if (!hit) return null;
  hit.name = clean;
  await chrome.storage.local.set({ [K_SUBJ]: list });
  return clean;
}

/** 会话归类：sub 为 null 就是移出科目。归属只写索引，不动会话正文。 */
export async function assignSubject(sid, sub) {
  await patchIndex(sid, { sub: sub || null });
}

/** 局部更新索引（状态/红点/标题），不动会话正文 —— 高频，避免整份重写 */
export async function patchIndex(id, patch) {
  let hit = false;
  await setIndex((idx) =>
    idx.map((e) => {
      if (e.id !== id) return e;
      hit = true;
      return { ...e, ...patch };
    }),
  );
  if (!hit) return;
  const sess = await getSession(id);
  if (sess) {
    let dirty = false;
    for (const [k, v] of Object.entries(patch)) {
      if (sess[k] !== v) {
        sess[k] = v;
        dirty = true;
      }
    }
    if (dirty) await chrome.storage.local.set({ [K_SESS + id]: sess });
  }
}

export async function deleteSession(id) {
  const sess = await getSession(id);
  await chrome.storage.local.remove(K_SESS + id);
  // 图片键跟着会话一起删（老会话迁移后才会有这些键）
  const imgKeys = (sess?.messages || []).filter((m) => m.imageKey).map((m) => m.imageKey);
  if (imgKeys.length) await chrome.storage.local.remove(imgKeys);
  await setIndex((idx) => idx.filter((e) => e.id !== id));
  await cleanupMirror(sess);
}

/**
 * 删除联动磁盘镜像：删掉该会话的 md + 截图，并刷新当日 _index.md。
 * 只有静默目录（FSA）模式删得掉；回落到下载的文件浏览器没有删除 API，只能留着（日志里说明）。
 */
async function cleanupMirror(sess) {
  if (!sess) return;
  try {
    const day = dateStr(new Date(sess.created));
    const names = [`${sess.id}.md`];
    sess.messages.forEach((m, i) => {
      if (hasImage(m)) names.push(`${sess.id}-${i}.jpg`);
    });
    let removed = 0;
    for (const n of names) if (await fs.removeSilent(mirrorRel(day, n))) removed++;
    logEvent(
      `delete ${sess.id}: 镜像清理 ${removed}/${names.length}` +
        (removed < names.length ? '（回落下载的文件请手动删）' : ''),
    );
    await writeIndexFile(sess, { allowDownload: false });
  } catch (e) {
    logEvent(`delete ${sess.id}: 镜像清理失败 ${e && e.message}`);
  }
}

export async function setUnread(id, unread) {
  const sess = await getSession(id);
  if (sess) {
    sess.unread = unread;
    await chrome.storage.local.set({ [K_SESS + id]: sess });
  }
  await patchIndex(id, { unread });
}

export async function renameSession(id, title) {
  const sess = await getSession(id);
  if (!sess) return null;
  const clean = String(title || '').trim().slice(0, 60);
  if (!clean) return sess.title;
  titleOverrides.set(id, clean);
  sess.title = clean;
  await saveSession(sess);
  return sess.title;
}

// ---------------------------------------------------------------- 磁盘镜像

function mirrorRel(date, name) {
  return `${DEFAULT_SETTINGS.mirrorRoot}/${date}/${name}`;
}

/**
 * 下载一律用 data: URL。
 * 实测：data:image/jpeg 与 data:text/markdown 在本机 Edge 全部 state=complete
 * （1.4MB / 4.2MB / 8.5MB base64 都试过）；而 blob: 走不通 ——
 * **service worker 里没有 URL.createObjectURL**（会抛 TypeError）。
 * 失败由调用方兜住：镜像三件套都吞异常返回状态，绝不把 rejection 抛出去。
 */
async function downloadUrl(url, filename, conflictAction = 'uniquify') {
  return chrome.downloads.download({ url, filename, saveAs: false, conflictAction });
}

/** 截图落盘：Spore/sessions/<date>/<id>-<idx>.jpg（静默优先，回落下载） */
export async function mirrorImage(sess, idx, dataUrl, { allowDownload = false } = {}) {
  const rel = mirrorRel(dateStr(new Date(sess.created)), `${sess.id}-${idx}.jpg`);
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (await fs.writeSilent(rel, blob)) return { how: 'fs' };
    if (!allowDownload) return { how: 'skipped' }; // 没开回落 → 不落盘，也绝不弹下载
    return { how: 'download', id: await downloadUrl(dataUrl, rel) };
  } catch (e) {
    logEvent(`mirrorImage failed ${sess.id}: ${e && e.message}`);
    return { how: 'failed', error: String(e && e.message) };
  }
}

function renderMarkdown(sess) {
  const lines = [`# ${sess.title}`, '', `- 会话：${sess.id}`, `- 创建：${new Date(sess.created).toLocaleString('zh-CN')}`];
  sess.messages.forEach((m, i) => {
    const t = new Date(m.ts || Date.now()).toLocaleTimeString('zh-CN');
    if (m.role === 'user') {
      lines.push('', `## 提问（${t}）`, '');
      if (hasImage(m)) lines.push(`![截图](./${sess.id}-${i}.jpg)`, '');
      if (m.text) lines.push('> ' + m.text.replace(/\n/g, '\n> '));
    } else if (m.kind === 'answer') {
      lines.push('', `## 回答（${t}）`, '', `**${m.ans || ''}**`, '');
      if (m.why) lines.push(m.why, '');
      if (m.verify?.ran) {
        lines.push(
          `> **核实** ${m.verify.verdict === 'FIX' ? '❌ 修正' : '✅ 一致'}：${m.verify.note || ''}`,
          '',
        );
      }
    } else {
      lines.push('', `## 追问（${t}）`, '', m.text || '');
    }
  });
  return lines.join('\n') + '\n';
}

/** 会话落盘为 markdown（+ 索引文件），失败静默，不影响作答 */
export async function mirrorSession(sess, { notify = false, allowDownload = false } = {}) {
  try {
    const rel = mirrorRel(dateStr(new Date(sess.created)), `${sess.id}.md`);
    const text = renderMarkdown(sess);
    // 静默写盘优先；回落下载（需显式开启）用 overwrite，避免每答一轮多一个 "xxx (1).md"
    if (await fs.writeSilent(rel, text)) {
      await writeIndexFile(sess, { allowDownload });
      return { how: 'fs' };
    }
    if (!allowDownload) return { how: 'skipped' };
    const md = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
    const id = await downloadUrl(md, rel, 'overwrite');
    await writeIndexFile(sess, { allowDownload });
    return { how: 'download', id };
  } catch (e) {
    if (notify) console.warn('[spore] mirror failed', e);
    return { how: 'failed', error: String(e?.message || e) };
  }
}

async function writeIndexFile(sess, { allowDownload = false } = {}) {
  const all = await listSessions();
  const day = dateStr(new Date(sess.created));
  const rows = all
    .filter((e) => day === `${e.id.slice(0, 4)}-${e.id.slice(4, 6)}-${e.id.slice(6, 8)}`)
    .map((e) => `| ${e.id} | ${e.title} | ${e.status} | ${new Date(e.updated).toLocaleTimeString('zh-CN')} |`)
    .join('\n');
  const md = `# Spore 会话索引 ${day}\n\n| 会话 | 标题 | 状态 | 更新 |\n|---|---|---|---|\n${rows}\n`;
  try {
    if (await fs.writeSilent(mirrorRel(day, '_index.md'), md)) return;
    if (!allowDownload) return;
    await chrome.downloads.download({
      url: 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md),
      filename: mirrorRel(day, '_index.md'),
      saveAs: false,
      conflictAction: 'overwrite',
    });
  } catch {
    /* 索引写失败不重要 */
  }
}

/** 镜像通道状态：fs=静默写盘，none=没选目录（走下载） */
export async function mirrorStatus() {
  const name = await fs.currentDirectoryName();
  if (!name) return { mode: 'none', dir: null };
  const usable = !!(await fs.mirrorRoot());
  return { mode: usable ? 'fs' : 'expired', dir: name };
}
