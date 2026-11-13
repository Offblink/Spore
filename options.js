// 设置页：读/写 spore.settings，顺带探测模型可达性与当前快捷键。
const FIELDS = ['endpoint', 'apiKey', 'model', 'maxToolRounds', 'historyLimit', 'mirrorRoot', 'proxy'];
const CHECKS = ['mirror', 'mirrorDownloads', 'fastNoThink', 'autoVerify', 'hideToggle'];

const $ = (id) => document.getElementById(id);
/** 写文本：元素缺席就跳过。一个 null.textContent 不该打断整页初始化 */
const setText = (id, text) => {
  const el = $(id);
  if (el) el.textContent = text;
};
const msg = (text, cls = '') => {
  const el = $('msg');
  if (!el) return;
  el.textContent = text;
  el.className = cls;
};

async function load() {
  const settings = await chrome.storage.local.get('spore.settings');
  const merged = { ...(await defaults()), ...(settings['spore.settings'] || {}) };
  for (const f of FIELDS) {
    $(f).value = merged[f];
  }
  for (const c of CHECKS) $(c).checked = merged[c] === true || (c === 'mirror' && merged[c] !== false);
  setText('rootEcho', merged.mirrorRoot);
  syncMirrorBody();

  // 快捷键以 chrome.commands 的**实时值**为准：storage 里那份是 SW 启动时的缓存，
  // 可能停在「命令还没注册/键名改过」的那次写入上——读缓存会把已绑定的显示成「未绑定」。
  const live = await chrome.commands.getAll().catch(() => null);
  if (live && live.length) {
    setText('kbd', live.find((c) => c.name === 'capture-region')?.shortcut || '（未绑定）');
    setText('kbdToggle', live.find((c) => c.name === 'toggle-drawer')?.shortcut || '（未绑定）');
  } else {
    const sc = await chrome.storage.local.get(['spore.shortcut', 'spore.shortcut.toggle']);
    setText('kbd', sc['spore.shortcut'] || '（未绑定）');
    setText('kbdToggle', sc['spore.shortcut.toggle'] || '（未绑定）');
  }
}

async function defaults() {
  const mod = await import('./src/lib/store.js');
  return mod.DEFAULT_SETTINGS;
}

async function save() {
  const patch = {
    endpoint: $('endpoint').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    maxToolRounds: Math.max(0, Math.min(10, Number($('maxToolRounds').value) || 0)),
    proxy: $('proxy').value.trim(),
    historyLimit: Math.max(2, Math.min(50, Number($('historyLimit').value) || 10)),
    mirror: $('mirror').checked,
    mirrorDownloads: $('mirrorDownloads').checked,
    fastNoThink: $('fastNoThink').checked,
    autoVerify: $('autoVerify').checked,
    hideToggle: $('hideToggle').checked,
    mirrorRoot: $('mirrorRoot').value.trim() || 'Spore/sessions',
  };
  const mod = await import('./src/lib/store.js');
  await mod.saveSettings(patch);
  $('rootEcho').textContent = patch.mirrorRoot;
  msg('已自动保存', 'ok');
  setTimeout(() => msg(''), 2200);
}

// ---------------- 自动保存：防抖 + ready 门闩 ----------------
// load() 回填控件期间 ready=false：那时的任何事件都不许触发写入，
// 免得用半份数据把用户真设置覆盖掉；load 成功后才开闸。
let ready = false;
let saveTimer = 0;
function scheduleSave() {
  if (!ready) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save().catch((e) => msg(String((e && e.message) || e), 'bad'));
  }, 600); // 防抖：连续敲键只落最后一次
}

async function probe() {
  const endpoint = $('endpoint').value.trim();
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  if (!endpoint || !apiKey || !model) return msg('endpoint / key / model 都要填', 'bad');
  msg('探测中…');
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'user', content: '只回一个字：通' }],
      }),
    });
    if (!res.ok) return msg(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`, 'bad');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let got = false;
    while (!got) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('data:')) got = true;
    }
    await reader.cancel().catch(() => {});
    msg(got ? `通了，首字 ${((Date.now() - t0) / 1000).toFixed(2)}s` : '连上了但没有流式响应', got ? 'ok' : 'bad');
  } catch (e) {
    msg(`失败：${e.message}`, 'bad');
  }
}

/** 设置里的镜像子路径（提示文案用） */
function mirrorSubpath() {
  const el = $('mirrorRoot');
  return ((el && el.value.trim()) || 'Spore/sessions').replace(/^\/+|\/+$/g, '');
}

/** 总开关关掉时，镜像的子设置整组隐藏（不显示与自己无关的选项） */
function syncMirrorBody() {
  const body = $('mirrorBody');
  const master = $('mirror');
  if (body && master) body.hidden = !master.checked;
}
$('mirror')?.addEventListener('change', syncMirrorBody);

/** 镜像目录状态：fs=静默写盘，expired=授权失效，none=没选 */
async function renderDirState(prefix = '') {
  const store = await import('./src/lib/store.js');
  const st = await store.mirrorStatus();
  const el = $('dirState');
  if (!el) return;
  if (st.mode === 'fs') {
    el.className = 'ok';
    el.textContent = `${prefix}已选：${st.dir} —— 之后静默写盘，不再弹下载气泡`;
  } else if (st.mode === 'expired') {
    el.className = 'bad';
    el.textContent = `${prefix}目录「${st.dir}」授权已失效（浏览器重启会重置），请重新选择；当前回落下载（会弹气泡）`;
  } else {
    el.className = '';
    el.textContent = `${prefix}未选择 —— 默认回落到 Downloads/${mirrorSubpath()}/日期/（Edge 会弹下载列表）；选好目录后完全静默写盘`;
  }
}

// 模块在页面加载时就备好：showDirectoryPicker 要求**点击这一刻**还握着用户激活，
// 事件处理器里先 await import 再弹框，是这类 AbortError 的常见来源。
let FS = null;

$('pickDir').addEventListener('click', async () => {
  try {
    const fs = FS || (FS = await import('./src/lib/fs.js'));
    const name = await fs.pickDirectory();
    // 选完立刻试写一次，确认真的可写
    const ok = await fs.writeSilent('.spore-probe.txt', `spore ${new Date().toISOString()}\n`);
    await renderDirState(ok ? `选中「${name}」，试写成功。` : `选中「${name}」，但试写失败：`);
    if (!ok && $('dirState')) $('dirState').className = 'bad';
  } catch (e) {
    const el = $('dirState');
    if (!el) return;
    const name = String((e && e.name) || '');
    const msgText = String((e && e.message) || e);
    el.className = 'bad';
    // AbortError = 对话框被取消（正常操作，不该吓人）
    if (name === 'AbortError' || /aborted a request/i.test(msgText)) {
      el.textContent = '你取消了这次选择。想恢复静默写盘，再点一次「选择目录」并挑中一个文件夹即可。';
    } else if (/not allowed|permission/i.test(msgText)) {
      el.textContent = `没有写入权限：${msgText}。换个文件夹（比如 文档/下载）再试。`;
    } else {
      el.textContent = `选择失败：${msgText}`;
    }
  }
});

$('clearDir').addEventListener('click', async () => {
  const fs = FS || (FS = await import('./src/lib/fs.js'));
  await fs.clearDirectory();
  await renderDirState('已清除。');
});

// 页面里直接 href="edge://…" 会被当成本地资源拦掉（Not allowed to load local resource），
// 必须用 tabs.create 打开
$('openShortcuts')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'edge://extensions/shortcuts' }).catch((err) => msg(String(err), 'bad'));
});

for (const f of FIELDS) $(f)?.addEventListener('input', scheduleSave);
for (const c of CHECKS) $(c)?.addEventListener('change', scheduleSave);
$('probe').addEventListener('click', probe);
load()
  .then(() => renderDirState())
  .then(() => import('./src/lib/fs.js').then((m) => (FS = m)))
  .then(() => {
    ready = true; // 加载完成才开自动保存的闸
  })
  .catch((e) => msg(String(e), 'bad'));


// ---------------- 服务器与同步（地址 + 令牌；只手动触发） ----------------
// 令牌不进页面：这里只收发状态帧（hasToken / 地址 / uid / 上次结果），写入与同步都走 SW 的 cloud op。
function cloudSay(text, cls = '') {
  const el = $('cloudState');
  if (!el) return;
  el.textContent = text;
  el.className = `hint ${cls}`.trim();
}

async function cloudCall(payload) {
  const res = await chrome.runtime.sendMessage({ type: 'cloud', ...payload }).catch(() => null);
  if (!res) throw new Error('后台无响应（扩展可能正在更新）');
  if (!res.ok) throw new Error(res.error || '后台返回失败');
  return res.data;
}

function renderCloud(status) {
  if (!status) return;
  if (status.api) $('cloudApi').value = displayApi(status.api);
  if ($('cloudSync')) $('cloudSync').disabled = !status.hasToken;
  if (!status.hasToken) {
    cloudSay('未配置：填地址与令牌 → 「保存并测试」');
    return;
  }
  const tail = status.lastSyncMsg ? ` · ${status.lastSyncMsg}` : ' · 还没同步过';
  cloudSay(`已连接 · ${displayApi(status.api)} · uid ${status.uid}${tail}`);
}

/** 回填用：去掉 /api 后缀与 http:// 前缀（用户填的是 host:port；https 保留，能看出在用加密） */
function displayApi(api) {
  return String(api || '')
    .replace(/\/api$/, '')
    .replace(/^http:\/\//, '');
}

$('cloudSave')?.addEventListener('click', async () => {
  const api = $('cloudApi').value.trim();
  const token = $('cloudToken').value.trim();
  if (!api) return cloudSay('先填服务器地址（如 192.168.1.5:19080）', 'bad');
  try {
    cloudSay('连接中…');
    const data = await cloudCall({ op: 'save', api, token });
    $('cloudToken').value = '';
    $('cloudApi').value = displayApi(data.status.api);
    if ($('cloudSync')) $('cloudSync').disabled = false;
    cloudSay(`已连接 · ${displayApi(data.status.api)} · uid ${data.status.uid}`, 'ok');
  } catch (e) {
    cloudSay(`连接失败：${e.message}`, 'bad');
  }
});

$('cloudSync')?.addEventListener('click', async () => {
  const btn = $('cloudSync');
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const data = await cloudCall({ op: 'sync' });
    renderCloud(data.status);
    const r = data.result || {};
    cloudSay(r.ok ? `同步完成：${r.message}` : `同步失败：${r.message}`, r.ok ? 'ok' : 'bad');
  } catch (e) {
    cloudSay(`同步失败：${e.message}`, 'bad');
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

$('cloudClear')?.addEventListener('click', async () => {
  try {
    const data = await cloudCall({ op: 'clear' });
    $('cloudApi').value = '';
    $('cloudToken').value = '';
    renderCloud(data.status);
    cloudSay('已清除（本地删除记录保留，下次重新配置后会补推）');
  } catch (e) {
    cloudSay(`清除失败：${e.message}`, 'bad');
  }
});

cloudCall({ op: 'status' })
  .then((d) => renderCloud(d.status))
  .catch(() => cloudSay('后台未就绪，稍后刷新页面重试', 'bad'));

// ---------------- 日志（排错入口） ----------------
const K_LOG = 'spore.log';

async function renderLog() {
  const box = $('logList');
  if (!box) return;
  let lines = [];
  try {
    lines = (await chrome.storage.local.get(K_LOG))[K_LOG] || [];
  } catch {
    /* 读不到就保持上一次内容 */
  }
  const text = lines.length ? lines.join('\n') : '（还没有日志）';
  if (box.textContent !== text) {
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  }
}

$('logRefresh')?.addEventListener('click', () => renderLog());
$('logClear')?.addEventListener('click', () => {
  chrome.runtime
    .sendMessage({ type: 'log-clear' })
    .then(() => renderLog())
    .catch(() => renderLog());
});
$('logCopy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(($('logList') && $('logList').textContent) || '');
    msg('日志已复制', '');
  } catch (e) {
    msg(String(e), 'bad');
  }
});
chrome.runtime.sendMessage({ type: 'log', scope: 'options', msg: 'options opened' }).catch(() => {});
renderLog();
setInterval(renderLog, 4000);


// ---------------- 分页：左边索引，右边一次一页 ----------------
const SECTIONS = ['theme', 'model', 'cloud', 'mirror', 'keys', 'log'];

function showSec(name) {
  const pick = SECTIONS.includes(name) ? name : 'theme'; // 无 hash / 野 hash → 第一张卡（外观）
  document.querySelectorAll('.card[data-sec]').forEach((el) => {
    el.hidden = el.dataset.sec !== pick;
  });
  document.querySelectorAll('.idx a').forEach((a) => a.classList.toggle('on', a.dataset.sec === pick));
  if (location.hash !== '#' + pick) {
    try {
      history.replaceState(null, '', '#' + pick);
    } catch {
      /* file:// 或权限限制时忽略 */
    }
  }
}

document.querySelectorAll('.idx a[data-sec]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showSec(a.dataset.sec);
  }),
);
showSec((location.hash || '').slice(1));

// ---------------- 外观：三档主题 ----------------
// 读写与跨页同步都在 src/lib/theme.js（它管首帧上色 + storage.onChanged），
// 这里只画选中态：档位变（自己点、别的标签页改、系统切换）就重画一次。
function paintThemeSeg() {
  const mode = window.SporeTheme ? window.SporeTheme.mode() : 'system';
  document.querySelectorAll('#themeSeg .seg').forEach((b) => {
    b.classList.toggle('on', b.dataset.themeMode === mode);
  });
}

document.querySelectorAll('#themeSeg .seg').forEach((b) =>
  b.addEventListener('click', () => {
    window.SporeTheme.set(b.dataset.themeMode).catch((e) => msg(String(e), 'bad'));
    paintThemeSeg();
  }),
);
window.SporeTheme?.subscribe(paintThemeSeg);
window.SporeTheme?.ready.then(paintThemeSeg);
paintThemeSeg();

// ---------------- 搜题记录：索引第一项，点了**直接新开整页** ----------------
// 用户定位：抽屉只是「插件的身份」，option 才是应用的控制中枢 —— 所以入口摆在索引最上面、
// 与下面四张设置卡之间留出间距；但它不做右侧分页，点它就是跳去整页审查。
function openReview(sid) {
  const base = chrome.runtime.getURL('review.html');
  chrome.tabs.create({ url: base + (sid ? `#${sid}` : '') }).catch((e) => msg(String(e), 'bad'));
}

document.querySelectorAll('.idx a[data-jump]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openReview('');
  }),
);
