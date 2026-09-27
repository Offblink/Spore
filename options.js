// 设置页：读/写 spore.settings，顺带探测模型可达性与当前快捷键。
const FIELDS = ['endpoint', 'apiKey', 'model', 'maxToolRounds', 'historyLimit', 'mirrorRoot'];
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

  const sc = await chrome.storage.local.get(['spore.shortcut', 'spore.shortcut.toggle']);
  setText('kbd', sc['spore.shortcut'] || '（未绑定）');
  setText('kbdToggle', sc['spore.shortcut.toggle'] || '（未绑定）');
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
const SECTIONS = ['model', 'mirror', 'keys', 'log'];

function showSec(name) {
  const pick = SECTIONS.includes(name) ? name : 'model';
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

document.querySelectorAll('.idx a').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showSec(a.dataset.sec);
  }),
);
showSec((location.hash || '').slice(1));
