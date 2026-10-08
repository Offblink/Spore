// 框选层：由 service worker 在 Alt+S 后注入。展示「冻结的截图帧」，
// 用户拖出矩形 → 回传 CSS px 坐标（service worker 按截图实际像素/视口尺寸换算裁剪）。
(() => {
  if (window.__sporeOverlayArmed) return;
  window.__sporeOverlayArmed = true;

  let root = null;
  /**
   * 当前这一帧的 AI 建议框入口：start() 注册、cleanup()/kill() 置空。
   * 识别结果晚到而没有入口（用户已采纳/取消/覆盖层已关）→ 直接丢，不重建覆盖层。
   */
  let suggestSink = null;
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
    suggestSink = null;
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
    box.id = 'spore-sel-box'; // e2e 断言用：预填/手拖的选区盒都走这里
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
    /** 当前选区（视口 CSS px），paint 的返回值 */
    let sel = null;
    /** 选区是否来自 AI 建议框：只有建议框享受「起手保留 + 单击/回车采纳」，
     *  手拖出来的选区维持原行为（起手即清）——开关关着时与改动前逐字节一致 */
    let sugSel = false;
    /** 本次按下是否点在建议框内（单击采纳判定） */
    let pressedInSel = false;

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
      sel = { x, y, w, h };
      return sel;
    };

    /** 采纳当前选区：发回 SW（与旧的拖拽收尾同一段代码） */
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

    // AI 建议框入口（SW 认完字补发 spore:suggest）。已起手（在拖）/框太小 → 静默丢，
    // 用户照常手动拖，不弹任何提示（识别失败同理：SW 那边根本不发这条消息）。
    suggestSink = (b) => {
      if (dragging) return;
      const x0 = clampX(b.l * window.innerWidth);
      const y0 = clampY(b.t * window.innerHeight);
      const x1 = clampX(b.r * window.innerWidth);
      const y1 = clampY(b.b * window.innerHeight);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      if (w < MIN_W && h < MIN_H) return; // 与「框太小」同口径：两者都没到下限才算小
      sugSel = true;
      pressedInSel = false;
      paint(x0, y0, x1, y1);
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      moved = false;
      startX = clampX(e.clientX);
      startY = clampY(e.clientY);
      if (sugSel && sel) {
        // 建议框保留到第一次真正拖动；点在框内 = 采纳（见 onUp），点在框外才重新起框
        pressedInSel = startX >= sel.x && startX <= sel.x + sel.w
          && startY >= sel.y && startY <= sel.y + sel.h;
        if (pressedInSel) return;
      }
      sugSel = false;
      paint(startX, startY, startX, startY);
    };

    const onMove = (e) => {
      if (!dragging) return;
      const cx = clampX(e.clientX);
      const cy = clampY(e.clientY);
      if (sugSel && !moved && Math.abs(cx - startX) <= 3 && Math.abs(cy - startY) <= 3) {
        return; // 还在点击阈值内：建议框不闪没（GUI 端 CLICK_EPS 同款）
      }
      const r = paint(startX, startY, cx, cy);
      if (r.w > 6 || r.h > 6) moved = true;
      sugSel = false; // 拖出来的就是手拖选区，不再享受单击采纳
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      // 单击建议框 = 采纳（原地一下、没拖动）：直接发回，不重画也不弹「请按住拖拽」
      if (sugSel && pressedInSel && !moved && sel) {
        finish(sel);
        return;
      }
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
        return;
      }
      // 回车采纳当前建议框（不必再拖一次；GUI 端回车同款）
      if (e.key === 'Enter' && sugSel && sel && !dragging) {
        e.preventDefault();
        e.stopPropagation();
        finish(sel);
      }
    };

    function cleanup() {
      suggestSink = null; // 这一帧结束了：晚到的识别结果没入口，直接丢
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
    if (msg?.type === 'spore:suggest') {
      // AI 建议框（SW 异步补发）：没有入口 / 已起手 / 框太小 → 静默丢，不回复错误
      try {
        suggestSink?.(msg.box);
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
