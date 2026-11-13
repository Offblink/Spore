// 主题运行时：把 spore.settings.theme（system | light | dark）落到 <html data-theme="light|dark">。
//
//   · 首帧不许闪：<head> 里同步读 localStorage 缓存（上一次的解析结果）先上色，
//     再异步读 storage 校准；因此本文件要在 <style>/<link> 之前、用普通 <script src> 引（不要 defer）。
//   · 三档语义：system 跟系统（matchMedia 监听变更）；light/dark 强制。
//   · 一处切换处处同步：写 storage → 其它标签页的 storage.onChanged 各自改自己的 data-theme。
//   · 页面 CSS 只认 data-theme，不自己探测系统；令牌在 src/lib/theme.css。
(() => {
  const KEY = 'spore.settings';
  const CACHE = 'spore.theme.resolved';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const subs = new Set();

  let mode = 'system';
  let resolved = 'light';
  let tweenTimer = 0;

  const norm = (m) => (m === 'light' || m === 'dark' ? m : 'system');
  const resolve = (m) => (m === 'light' || m === 'dark' ? m : mq.matches ? 'dark' : 'light');

  function cached() {
    try {
      const t = localStorage.getItem(CACHE);
      return t === 'light' || t === 'dark' ? t : null;
    } catch {
      return null; // 隐私模式/禁用存储：退回系统判定
    }
  }

  /** animate=false 用在首帧与 storage 校准（不闪、不抖）；用户点切换才走 .theme-tween 过渡 */
  function paint(t, animate) {
    const root = document.documentElement;
    resolved = t;
    if (!animate) {
      clearTimeout(tweenTimer);
      root.classList.remove('theme-tween');
    }
    root.setAttribute('data-theme', t);
    if (animate) {
      root.classList.add('theme-tween');
      clearTimeout(tweenTimer);
      tweenTimer = setTimeout(() => root.classList.remove('theme-tween'), 260);
    }
    try {
      localStorage.setItem(CACHE, t);
    } catch {
      /* 缓存只是首帧优化，写不进去不影响功能 */
    }
    for (const fn of subs) {
      try {
        fn(t, mode);
      } catch {
        /* 订阅者的异常不该打断主题落地 */
      }
    }
  }

  paint(cached() || resolve('system'), false);

  const ready = (async () => {
    try {
      const got = await chrome.storage.local.get(KEY);
      mode = norm((got[KEY] || {}).theme);
      paint(resolve(mode), false);
    } catch {
      /* 读不到就按系统，别把页面卡在这一步 */
    }
  })();

  mq.addEventListener('change', () => {
    if (mode === 'system') paint(resolve('system'), true);
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch[KEY]) return;
    const next = norm((ch[KEY].newValue || {}).theme);
    if (next === mode) return;
    mode = next;
    paint(resolve(mode), true);
  });

  window.SporeTheme = {
    ready,
    mode: () => mode,
    resolved: () => resolved,
    /** 写 storage（一处切换、所有面同步）；DOM 立刻变，不等其它页 */
    async set(m) {
      mode = norm(m);
      paint(resolve(mode), true);
      const got = await chrome.storage.local.get(KEY);
      await chrome.storage.local.set({ [KEY]: { ...(got[KEY] || {}), theme: mode } });
    },
    /** 页面自己要在主题变化时重算（如 canvas/图表）就订阅，回调 (resolved, mode) */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
})();
