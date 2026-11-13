// 框选层：由 service worker 在 Alt+S 后注入。展示「冻结的截图帧」，
// 用户拖出矩形 → 回传 CSS px 坐标（service worker 按截图实际像素/视口尺寸换算裁剪）。
(() => {
  if (window.__sporeOverlayArmed) return;
  window.__sporeOverlayArmed = true;

  let root = null;
  /**
   * 框选下限（CSS px）。判定口径：**两者有其一超过下限就允许** ——
   * 只有「宽和高都没到下限」才算框太小（宽条、高条都能截，避免误杀细长截图）。
   */
  const MIN_W = 60;
  const MIN_H = 40;

  const kill = () => {
    if (root) {
      root.remove();
      root = null;
    }
  };

  function start(shot) {
    kill();

    root = document.createElement('div');
    root.id = 'spore-overlay-root';
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'cursor:crosshair',
      'user-select:none',
      'touch-action:none',
      'background:#0b0c10',
    ].join(';');

    const img = document.createElement('img');
    img.src = shot;
    img.draggable = false;
    img.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;object-fit:fill;pointer-events:none;';
    root.appendChild(img);

    const box = document.createElement('div');
    box.id = 'spore-sel-box'; // e2e 断言用：手拖的选区盒
    box.style.cssText =
      'position:absolute;display:none;border:2px solid #ec4899;background:rgba(236,72,153,0.10);' +
      'box-shadow:0 0 0 9999px rgba(0,0,0,0.55);pointer-events:none;';
    root.appendChild(box);

    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;display:none;padding:3px 7px;border-radius:6px;background:#ec4899;color:#fff;' +
      'font:12px/1.2 "Segoe UI",system-ui,sans-serif;pointer-events:none;white-space:nowrap;';
    root.appendChild(label);

    const hint = document.createElement('div');
    hint.textContent = '拖拽框选题目区域 · Esc 取消';
    hint.style.cssText =
      'position:absolute;top:18px;left:50%;transform:translateX(-50%);padding:7px 16px;border-radius:999px;' +
      'background:rgba(12,13,18,0.86);color:#f5f6fc;font:13px/1 "Segoe UI",system-ui,sans-serif;' +
      'letter-spacing:.02em;pointer-events:none;';
    root.appendChild(hint);

    document.documentElement.appendChild(root);

    // 强调色跟设置页的主题档位（浅色粉 #EC4899 / 深色青 #2DD4BF）：框选层只活几秒，
    // 不做实时跟随，开框时读一次就够；读不到就按系统偏好。
    const paintAccent = (dark) => {
      box.style.borderColor = dark ? '#2dd4bf' : '#ec4899';
      box.style.background = dark ? 'rgba(45,212,191,0.12)' : 'rgba(236,72,153,0.10)';
      label.style.background = dark ? '#2dd4bf' : '#ec4899';
      label.style.color = dark ? '#08131a' : '#fff';
    };
    chrome.storage.local
      .get('spore.settings')
      .then((got) => {
        const mode = ((got['spore.settings'] || {}).theme) || 'system';
        const dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        if (dark) paintAccent(true);
      })
      .catch(() => {
        /* 主题只是配色，读不到就用浅色 */
      });

    /** 顶部提示条复用为警告条（红底），1.8s 后恢复默认文案 */
    let warnTimer = 0;
    const warn = (text) => {
      clearTimeout(warnTimer);
      hint.textContent = text;
      hint.style.background = 'rgba(158,28,44,0.95)';
      warnTimer = setTimeout(() => {
        hint.textContent = '拖拽框选题目区域 · Esc 取消';
        hint.style.background = '';
      }, 1800);
    };

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let moved = false;

    const clampX = (v) => Math.min(Math.max(v, 0), window.innerWidth);
    const clampY = (v) => Math.min(Math.max(v, 0), window.innerHeight);

    const paint = (x0, y0, x1, y1) => {
      const x = Math.min(x0, x1);
      const y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      box.style.display = 'block';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      label.style.display = 'block';
      label.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      label.style.left = `${Math.min(x, window.innerWidth - 74)}px`;
      label.style.top = `${Math.max(4, y - 26)}px`;
      return { x, y, w, h };
    };

    /** 采纳当前选区：发回 SW */
    const finish = (r) => {
      cleanup();
      root?.remove();
      root = null;
      chrome.runtime
        .sendMessage({
          type: 'spore:rect',
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.w),
            h: Math.round(r.h),
            viewportW: window.innerWidth,
            viewportH: window.innerHeight,
          },
        })
        .catch(() => {});
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      moved = false;
      startX = clampX(e.clientX);
      startY = clampY(e.clientY);
      paint(startX, startY, startX, startY);
    };

    const onMove = (e) => {
      if (!dragging) return;
      const cx = clampX(e.clientX);
      const cy = clampY(e.clientY);
      const r = paint(startX, startY, cx, cy);
      if (r.w > 6 || r.h > 6) moved = true;
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = paint(startX, startY, clampX(e.clientX), clampY(e.clientY));
      // 太小 / 只是点了下：不发给 Spore、不建会话、也不退出截图态 —— 让用户重新拖。
      // 宽高**都**没到下限才算太小（有其一够大就放行）。
      if (!moved || (rect.w < MIN_W && rect.h < MIN_H)) {
        box.style.display = 'none';
        label.style.display = 'none';
        warn(
          !moved
            ? `请按住拖拽框选（至少 ${MIN_W}×${MIN_H}）`
            : `框太小 ${Math.round(rect.w)}×${Math.round(rect.h)}，至少 ${MIN_W}×${MIN_H} · 重新拖`,
        );
        return;
      }
      finish(rect);
    };

    const cancel = () => {
      cleanup();
      root?.remove();
      root = null;
      chrome.runtime.sendMessage({ type: 'spore:rect', rect: null }).catch(() => {});
    };


    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };

    function cleanup() {
      clearTimeout(warnTimer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('scroll', onCancel, true);
      window.removeEventListener('resize', onCancel, true);
    }

    const onContext = (e) => {
      e.preventDefault();
      cancel();
    };
    const onCancel = () => cancel();

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('scroll', onCancel, true);
    window.addEventListener('resize', onCancel, true);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'spore:select') {
      try {
        start(msg.shot);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
      return false;
    }
    if (msg?.type === 'spore:overlay-cancel') {
      kill();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
