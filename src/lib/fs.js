// 磁盘镜像的「静默写盘」通道：File System Access API。
// 选一次目录（必须在带用户手势的 options 页里选），handle 存 IndexedDB（结构化克隆，chrome.storage 存不下），
// 之后 service worker 直接 createWritable() 写文件 —— 全程不触发下载，Edge 不会弹下载气泡。
// 没选目录 / 授权失效 → 调用方回落 chrome.downloads（会弹气泡，但至少有东西落盘）。

const DB_NAME = 'spore-fs';
const STORE = 'handles';
const KEY_ROOT = 'root';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export function fsaSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** 只能在带用户手势的页面里调（options）。返回目录名。 */
export async function pickDirectory() {
  if (!fsaSupported()) throw new Error('此浏览器不支持 File System Access');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const state = await dir.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') throw new Error('未获得写入权限');
  }
  await idbPut(KEY_ROOT, dir);
  return dir.name;
}

export async function clearDirectory() {
  await idbDel(KEY_ROOT);
}

/** 当前镜像目录名（没有则 null） */
export async function currentDirectoryName() {
  try {
    const root = await idbGet(KEY_ROOT);
    return root ? root.name : null;
  } catch {
    return null;
  }
}

/**
 * 解析出可写的根目录；不可用返回 null。
 * 授权可能在浏览器重启后失效（queryPermission 回到 prompt），
 * 这时 service worker 无法弹授权框 —— 只能回落下载，由调用方提示用户重选。
 */
export async function mirrorRoot() {
  try {
    const root = await idbGet(KEY_ROOT);
    if (!root) return null;
    if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * 静默写一个文件。relPath 形如 `Spore/sessions/2026-09-27/xxx.md`（相对所选目录）。
 * 成功返回 true；不可用/失败返回 false，调用方回落 downloads。
 */
export async function writeSilent(relPath, data /* string | Blob */) {
  const root = await mirrorRoot();
  if (!root) return false;
  try {
    const parts = String(relPath).split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return false;
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(fileName, { create: true });
    const w = await file.createWritable();
    await w.write(data);
    await w.close();
    return true;
  } catch (e) {
    console.warn('[spore] silent write failed:', e);
    return false;
  }
}

/** 是否已经选过目录（用来决定 UI 上的提示） */
export async function hasPickedDirectory() {
  try {
    return !!(await idbGet(KEY_ROOT));
  } catch {
    return false;
  }
}

/**
 * 删一个镜像文件（relPath 与 writeSilent 同构）。
 * 成功 true；没选目录/授权失效/文件不存在/回落下载模式 → false，调用方按「删不掉」处理。
 */
export async function removeSilent(relPath) {
  const root = await mirrorRoot();
  if (!root) return false;
  try {
    const parts = String(relPath).split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return false;
    let dir = root;
    // 不 create：中间目录不存在就当这文件本来就没落盘
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(fileName);
    return true;
  } catch {
    return false;
  }
}
