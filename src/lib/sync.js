// 与 Spore-Cloud 的同步编排（MV3 端）：先上行、再下行，游标 + 墓碑 + LWW。
//
// 协议事实（见 src/lib/cloud.js 头注）：`updated` 严格大于服务端 `update_time` 才覆盖；
// 墓碑 `deleted=1` 随 pull 下发；一篇会话在服务端只有一张「正式附件」，
// 其余图片用**合成 articleId**（`<会话id>-<消息下标>`）走同一个 push-attachment 接口——
// 服务端对该 id 的 `UPDATE article ... WHERE id=?` 影响 0 行，所以只落文件、不动行、不抬时间戳。
// 路径写进消息字段 `attPath`（服务端 messages 是 JsonNode 原样存取），下行按它拉回字节。
//
// 三条铁律（错会静默丢数据）：
//   1. pushCursor 只按「真实上行过的 updated」前进，墓碑不经游标；
//   2. pull 套用服务端行时同时抬 pushCursor（markClean），否则本地把回声当新改动重推；
//   3. 下行 LWW 键是 `server.updated > local.updated`，且本地在途回合要挡住游标（hold）。
import * as store from './store.js';
import { createClient } from './cloud.js';

const K_STATUS = 'spore.sync';
const K_TOKEN = 'spore.sync.token';
const K_TOMBS = 'spore.sync.tombs';

const PULL_LIMIT = 500; // 服务端上限
const PUSH_CHUNK = 100; // 每请求最多 100 篇
const PULL_MAX_BATCHES = 50;

const EMPTY_STATUS = {
  api: '',
  uid: -1,
  nick: '',
  pullCursor: 0,
  pushCursor: 0,
  lastSyncAt: 0,
  lastSyncMsg: '',
  lastUp: -1,
  lastDown: -1,
};

let running = false;

export function isSyncing() {
  return running;
}

async function loadStatus() {
  const got = await chrome.storage.local.get(K_STATUS);
  return { ...EMPTY_STATUS, ...(got[K_STATUS] || {}) };
}

async function saveStatus(st) {
  await chrome.storage.local.set({ [K_STATUS]: st });
}

async function loadToken() {
  const got = await chrome.storage.local.get(K_TOKEN);
  return got[K_TOKEN] || '';
}

/** 设置页读：令牌只回 hasToken，不回明文 */
export async function getStatus() {
  const st = await loadStatus();
  return { ...st, hasToken: !!(await loadToken()) };
}

/** 设置页写：地址 + 令牌；先用 /users/me 验证，成功才落库（换服务器/换身份 → 双游标清零） */
export async function setConfig({ api, token }) {
  // 令牌留空 = 沿用已保存的（设置页只需改地址时不用重新贴一次）
  const use = String(token ?? '').trim() || (await loadToken());
  if (!use) throw new Error('令牌为空');
  const client = createClient({ api, token: use });
  const me = await client.me();
  const old = await loadStatus();
  const changed = client.api !== old.api || Number(me.id) !== Number(old.uid);
  const st = {
    ...old,
    api: client.api,
    uid: me.id,
    nick: me.nickname || me.username || '',
    ...(changed ? { pullCursor: 0, pushCursor: 0 } : {}),
    lastSyncAt: 0,
    lastSyncMsg: '',
    lastUp: -1,
    lastDown: -1,
  };
  await chrome.storage.local.set({ [K_TOKEN]: use, [K_STATUS]: st });
  // 换服务器/换身份：旧账本是上一个身份的删除义务，带到新库里会把别人的同 id 行删掉
  if (changed) await chrome.storage.local.remove(K_TOMBS);
  store.logEvent(`sync 配置 → ${st.api} uid=${st.uid}`);
  return st;
}

/** 清除令牌与地址；墓碑账本留着（本地删除的传播义务还在） */
export async function clearConfig() {
  await chrome.storage.local.remove([K_TOKEN, K_STATUS]);
  store.logEvent('sync 配置已清除');
}

// ---------------------------------------------------------------- 墓碑

async function loadTombs() {
  const got = await chrome.storage.local.get(K_TOMBS);
  return got[K_TOMBS] || { articles: {}, categories: {} };
}

async function saveTombs(tombs) {
  await chrome.storage.local.set({ [K_TOMBS]: tombs });
}

/** 本地删除即记账：kind = 'article' | 'category' */
export async function recordTombstone(kind, id, ts = Date.now()) {
  if (!id) return;
  const tombs = await loadTombs();
  const bucket = kind === 'category' ? tombs.categories : tombs.articles;
  bucket[id] = Math.max(bucket[id] || 0, ts);
  await saveTombs(tombs);
}

/** 墓碑被服务端收下（或本地重新活过来）就销账 */
async function dropTombstone(kind, id) {
  const tombs = await loadTombs();
  const bucket = kind === 'category' ? tombs.categories : tombs.articles;
  if (!(id in bucket)) return;
  delete bucket[id];
  await saveTombs(tombs);
}

/** 服务端下发的活行 vs 本地墓碑：墓碑压住活行（不许复活），并把账抬到行的时间戳 */
async function raiseTombstone(kind, id, ts) {
  const tombs = await loadTombs();
  const bucket = kind === 'category' ? tombs.categories : tombs.articles;
  bucket[id] = Math.max(bucket[id] || 0, ts);
  await saveTombs(tombs);
}

// ---------------------------------------------------------------- 映射（纯函数，node 单测直接调）

/** 服务端只认 done/error/aborted；在途/空态一律按 done 上推（进程死掉不留 answering） */
export function normalizeStatus(status) {
  if (status === 'error' || status === 'aborted') return status;
  return 'done';
}

/**
 * 会话 → 上行 article。
 * 消息写**超集**：既带 Mobile 的扁平 verify 字段（跨端互看），也保留 MV3 自己的语义；
 * 图片：第一张留给服务端正式附件列（attachmentPath，由 push-attachment 回写），
 * 其余图片把**预先算好的路径**写进 `attPath`（`<sid>-<下标>.jpg`，与 push-attachment 的落名一致）。
 */
export function sessionToArticle(sess) {
  const sid = sess.id;
  const slotIdx = (sess.messages || [])
    .map((m, i) => (m.imageKey || m.image ? i : -1))
    .filter((i) => i >= 0);
  const first = slotIdx[0];
  return {
    id: sid,
    categoryId: sess.sub || '',
    title: String(sess.title || '').trim() || '新会话',
    messages: (sess.messages || []).map((m, i) => messageOut(m, { first, isSlot: slotIdx.includes(i), sid, idx: i })),
    fav: sess.fav ? 1 : 0,
    status: normalizeStatus(sess.status),
    created: Number(sess.created) || Date.now(),
    updated: Number(sess.updated) || Date.now(),
    deleted: 0,
  };
}

function messageOut(m, { first, isSlot, sid, idx }) {
  const v = m.verify || {};
  const out = {
    role: m.role || 'user',
    kind: m.kind || '',
    text: m.text || '',
    think: m.think || '',
    no: m.no || '',
    title: m.title || '',
    ans: m.ans || '',
    why: m.why || '',
    ts: Number(m.ts) || 0,
    tools: Array.isArray(m.tools) ? m.tools : [],
    hasImage: !!(m.imageKey || m.image || m.attPath),
    imagePath: '',
    // Mobile 的扁平核实字段
    verifyRan: !!v.ran,
    verifySkipped: !!v.skipped,
    verifyPending: !!v.pending,
    verifyVerdict: v.verdict || '',
    verifyNote: v.note || '',
    verifyThink: v.think || '',
  };
  // 第 2 张及以后的图：路径可预先确定（文件名 = safeId + 扩展名），先写进消息，图在后台上推
  if (isSlot && idx !== first) out.attPath = `${sid}-${idx}.jpg`;
  if (m.attPath && !out.attPath) out.attPath = m.attPath;
  return out;
}

/** 下行 article → 本地会话（图片由 hydrateImages 另行补 imageKey） */
export function articleToSession(row) {
  return {
    id: row.id,
    title: row.title || '新会话',
    created: Number(row.created) || Number(row.updated) || Date.now(),
    updated: Number(row.updated) || 0,
    messages: (Array.isArray(row.messages) ? row.messages : []).map(messageIn),
    status: normalizeStatus(row.status),
    unread: false,
    fav: !!row.fav,
    sub: row.categoryId || null,
  };
}

function messageIn(m) {
  const out = {
    role: m.role || 'user',
    text: m.text || '',
    think: m.think || '',
    ts: Number(m.ts) || 0,
  };
  if (m.kind) out.kind = m.kind;
  if (m.no) out.no = m.no;
  if (m.title) out.title = m.title;
  if (m.ans) out.ans = m.ans;
  if (m.why) out.why = m.why;
  if (Array.isArray(m.tools) && m.tools.length) out.tools = m.tools;

  // 核实块：优先读 Mobile 的扁平字段，兼容早期嵌套 verify
  const nested = m.verify || {};
  const verify = {};
  if (m.verifyRan || nested.ran) verify.ran = true;
  if (m.verifySkipped || nested.skipped) verify.skipped = true;
  if (m.verifyPending || nested.pending) verify.pending = true;
  const verdict = m.verifyVerdict || nested.verdict;
  if (verdict) verify.verdict = verdict;
  const note = m.verifyNote || nested.note;
  if (note) verify.note = note;
  const think = m.verifyThink || nested.think;
  if (think) verify.think = think;
  if (Object.keys(verify).length) out.verify = verify;

  if (m.attPath) out.attPath = m.attPath;
  if (m.hasImage) out.hasImage = true;
  return out;
}

export function subjectToCategory(sub) {
  const updated = Number(sub.updated) || Number(sub.created) || 0;
  return {
    id: sub.id,
    parentId: null,
    name: sub.name || '未命名科目',
    sortOrder: 0,
    status: 1,
    created: Number(sub.created) || updated,
    updated,
    deleted: 0,
  };
}

export function categoryToSubject(row) {
  return {
    id: row.id,
    name: row.name || '未命名科目',
    created: Number(row.created) || Number(row.updated) || 0,
    updated: Number(row.updated) || 0,
  };
}

// ---------------------------------------------------------------- 图片

/** 拿某条消息的图片字节；老会话可能还是内联 `image` data URL */
async function imageBytes(m) {
  const url = m.imageKey ? await store.getImage(m.imageKey) : m.image;
  if (!url) return null;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), dataUrl: url };
}

function bytesToDataUrl(bytes, type = 'image/jpeg') {
  const blob = new Blob([bytes], { type });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('图片转 data URL 失败'));
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- 一轮同步

export async function run() {
  if (running) return { ok: false, message: '同步进行中', up: 0, down: 0 };
  running = true;
  let phase = '连接';
  try {
    const st = await loadStatus();
    const token = await loadToken();
    if (!st.api || !token) return { ok: false, message: '还没填服务器与令牌', up: 0, down: 0 };

    const client = createClient({ api: st.api, token });
    phase = '校验身份';
    const me = await client.me();
    if (Number(me.id) !== Number(st.uid)) {
      // 换人 = 换库：旧水位会永久跳过新身份的存量行；旧墓碑也不能带去新身份（会删别人的行）
      st.pullCursor = 0;
      st.pushCursor = 0;
      await chrome.storage.local.remove(K_TOMBS);
    }
    st.uid = me.id;
    st.nick = me.nickname || me.username || '';
    st.api = client.api;
    await saveStatus(st);

    phase = '上行';
    const up = await pushPhase(client, st);
    phase = '下行';
    const down = await pullPhase(client, st);

    st.lastSyncAt = Date.now();
    st.lastSyncMsg = `上行 ${up} · 下行 ${down}`;
    st.lastUp = up;
    st.lastDown = down;
    await saveStatus(st);
    store.logEvent(`sync ✓ ${st.lastSyncMsg} pull=${st.pullCursor} push=${st.pushCursor}`);
    return { ok: true, message: st.lastSyncMsg, up, down };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    const st = await loadStatus();
    st.lastSyncAt = Date.now();
    st.lastSyncMsg = `失败：${msg}`;
    st.lastUp = -1;
    st.lastDown = -1;
    await saveStatus(st);
    store.logEvent(`sync ✗ ${phase}失败：${msg}`);
    return { ok: false, message: msg, up: 0, down: 0 };
  } finally {
    running = false;
  }
}

async function pushPhase(client, st) {
  const cursor = st.pushCursor;
  const tombs = await loadTombs();

  const cats = [];
  const revivedCats = new Set();
  for (const s of await store.listSubjects()) {
    if ((Number(s.updated) || 0) > cursor) {
      cats.push(subjectToCategory(s));
      revivedCats.add(s.id);
    }
  }
  // 本地活过来（有更新的行）的科目，其墓碑不推——否则会把刚发出去的行又删掉
  for (const [id, ts] of Object.entries(tombs.categories)) {
    if (!revivedCats.has(id)) cats.push({ id, updated: ts, deleted: 1 });
  }

  const arts = [];
  const uploads = []; // {target, message}
  const revivedArts = new Set();
  let maxUpd = cursor;
  for (const e of await store.listSessions()) {
    if ((Number(e.updated) || 0) <= cursor) continue;
    const sess = await store.getSession(e.id);
    if (!sess) continue;
    // 索引上的 fav/sub 是权威（会话对象上偶尔缺字段）
    if (e.fav !== undefined) sess.fav = !!e.fav;
    if (e.sub !== undefined) sess.sub = e.sub || null;
    arts.push(sessionToArticle(sess));
    revivedArts.add(sess.id);
    maxUpd = Math.max(maxUpd, Number(sess.updated) || Number(e.updated) || 0);
    const slots = (sess.messages || [])
      .map((m, i) => (m.imageKey || m.image ? i : -1))
      .filter((i) => i >= 0);
    slots.forEach((i, n) => {
      uploads.push({
        articleId: n === 0 ? sess.id : `${sess.id}-${i}`,
        filename: `${n === 0 ? sess.id : `${sess.id}-${i}`}.jpg`,
        message: sess.messages[i],
        rowId: sess.id,
      });
    });
  }
  // 本地活过来的会话不推墓碑（同科目；删除后又新建同 id 才会出现）
  for (const [id, ts] of Object.entries(tombs.articles)) {
    if (!revivedArts.has(id)) arts.push({ id, updated: ts, deleted: 1 });
  }

  if (!cats.length && !arts.length) return 0;

  const accepted = new Set();
  if (cats.length) {
    for (const res of await client.push({ categories: cats, articles: [] })) {
      if (res.accepted) accepted.add(res.id);
    }
  }
  for (let i = 0; i < arts.length; i += PUSH_CHUNK) {
    const chunk = arts.slice(i, i + PUSH_CHUNK);
    for (const res of await client.push({ categories: [], articles: chunk })) {
      if (res.accepted) accepted.add(res.id);
    }
  }

  // 图在行之后（服务端 bindAttachment 会抬行的 update_time，先推图再推行会被 LWW 拒）
  let failedImages = 0;
  for (const up of uploads) {
    if (!accepted.has(up.rowId)) continue;
    try {
      const img = await imageBytes(up.message);
      if (!img) continue;
      await client.pushAttachment(up.articleId, img.bytes, up.filename);
    } catch (e) {
      failedImages++;
      store.logEvent(`sync 图片上推失败 ${up.articleId}: ${e && e.message}`);
    }
  }

  // 游标只吃非墓碑的 updated；账本只销服务端真收下的
  st.pushCursor = Math.max(st.pushCursor, maxUpd);
  await saveStatus(st);
  const okCats = Object.keys(tombs.categories).filter((id) => accepted.has(id));
  const okArts = Object.keys(tombs.articles).filter((id) => accepted.has(id));
  for (const id of okCats) await dropTombstone('category', id);
  for (const id of okArts) await dropTombstone('article', id);

  const sent = cats.length + arts.length;
  const note = failedImages ? `（${failedImages} 张图失败）` : '';
  store.logEvent(`sync 上行 ${sent} 条${note}`);
  return sent;
}

async function pullPhase(client, st) {
  let applied = 0;
  for (let batch = 0; batch < PULL_MAX_BATCHES; batch++) {
    const data = await client.pull(st.pullCursor, PULL_LIMIT);
    if (!data) break;
    const cats = Array.isArray(data.categories) ? data.categories : [];
    const arts = Array.isArray(data.articles) ? data.articles : [];
    if (!cats.length && !arts.length) break;

    for (const row of cats) applied += await applyCategory(row, st);

    let hold = Number.MAX_SAFE_INTEGER;
    for (const row of arts) {
      const r = await applyArticle(client, row, st);
      if (r > 0) applied += 1;
      else if (r < 0) hold = Math.min(hold, (Number(row.updated) || 0) - 1);
    }

    const next = Number(data.nextCursor) || st.pullCursor;
    const prev = st.pullCursor;
    st.pullCursor = Math.max(prev, Math.min(next, hold));
    await saveStatus(st);
    if (st.pullCursor <= prev || st.pullCursor < next) break;
  }
  return applied;
}

/** @returns 1 = 套用；0 = 无事；-1 = 本地在途回合挡住（游标停在它前面） */
async function applyArticle(client, row, st) {
  if (!row?.id) return 0;
  const sid = row.id;
  const local = await store.getSession(sid);
  const tombs = await loadTombs();
  const tomb = Number(tombs.articles[sid]) || 0;
  const updated = Number(row.updated) || 0;

  if (row.deleted === 1) {
    if (!local) {
      await dropTombstone('article', sid);
      return 0;
    }
    if ((Number(local.updated) || 0) > updated) return 0; // 本地新：等上行裁决
    await store.deleteSession(sid);
    await dropTombstone('article', sid);
    st.pushCursor = Math.max(st.pushCursor, updated);
    return 1;
  }

  if (tomb) {
    // 本地删了但服务端还活着：墓碑压住活行，抬账等下轮上行裁赢
    await raiseTombstone('article', sid, updated);
    return 0;
  }
  if (local && (Number(local.updated) || 0) >= updated) return 0; // 本地更新 / 自己刚推的回声
  if (local && ['answering', 'verifying', 'searching'].includes(local.status)) return -1;

  const sess = articleToSession(row);
  if (local?.unread) sess.unread = true;
  await hydrateImages(client, sess, row);
  await store.applyServerSession(sess);
  // 套用的是服务端内容：抬 pushCursor，否则下一轮把它当本地新改动重推
  st.pushCursor = Math.max(st.pushCursor, updated);
  return 1;
}

async function applyCategory(row, st) {
  if (!row?.id) return 0;
  const updated = Number(row.updated) || 0;
  const local = (await store.listSubjects()).find((s) => s.id === row.id);
  const tombs = await loadTombs();
  const tomb = Number(tombs.categories[row.id]) || 0;

  if (row.deleted === 1) {
    if (!local) {
      await dropTombstone('category', row.id);
      return 0;
    }
    if ((Number(local.updated) || 0) > updated) return 0;
    await store.deleteSubject(row.id); // 成员解绑并 touch，下一轮上行把 categoryId 清空
    await dropTombstone('category', row.id);
    st.pushCursor = Math.max(st.pushCursor, updated);
    return 1;
  }

  if (tomb) {
    await raiseTombstone('category', row.id, updated);
    return 0;
  }
  if (local && (Number(local.updated) || 0) >= updated) return 0;

  await store.applyServerSubject(categoryToSubject(row));
  st.pushCursor = Math.max(st.pushCursor, updated);
  return 1;
}

/**
 * 补图：正式附件（attachmentPath）指向第一张图；其余走消息里的 attPath。
 * 图拉不回来（404/网络）不算失败——消息照显示，只是没图。
 */
async function hydrateImages(client, sess, row) {
  const slots = (sess.messages || [])
    .map((m, i) => (m.hasImage || m.attPath ? i : -1))
    .filter((i) => i >= 0);

  for (let n = 0; n < slots.length; n++) {
    const idx = slots[n];
    const m = sess.messages[idx];
    // 第一张图走正式附件列；其余走消息里的 attPath（合成 id 落盘的相对路径）
    const rel = (n === 0 && row.attachmentPath) || m.attPath || '';
    if (!rel) continue;
    try {
      const bytes = await client.pullAttachment(rel);
      if (!bytes || !bytes.length) continue;
      const dataUrl = await bytesToDataUrl(bytes);
      m.imageKey = await store.putImage(sess.id, idx, dataUrl);
    } catch (e) {
      // 图拉不回来不算失败：正文照显示，只是没图
      store.logEvent(`sync 图片下行失败 ${rel}: ${e && e.message}`);
    }
  }
}
