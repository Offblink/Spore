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
  /** 建议框的缩放手柄：8 个方位里右下角让给「采纳」按钮 → 7 个（nw/n/ne/w/e/sw/s） */
  const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's'];
  const HS = 10; // 手柄边长（px）
  const HIT = 6; // 命中容差（手柄小，鼠标不必压得很准）
  const BTN_W = 56;
  const BTN_H = 26;

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

    // 建议框专用：7 个缩放手柄 + 右下角「采纳」按钮（都 pointer-events:none，
    // 命中判定统一在 onDown 里按坐标算——window 上的捕获监听才是事件源）
    const handleEls = {};
    const handleWrap = document.createElement('div');
    handleWrap.style.cssText = 'position:absolute;display:none;pointer-events:none;';
    for (const d of HANDLES) {
      const el = document.createElement('div');
      el.style.cssText =
        `position:absolute;width:${HS}px;height:${HS}px;box-sizing:border-box;` +
        'background:#fff;border:2px solid #ec4899;pointer-events:none;';
      handleWrap.appendChild(el);
      handleEls[d] = el;
    }
    root.appendChild(handleWrap);

    const btn = document.createElement('div');
    btn.id = 'spore-accept';
    btn.textContent = '采纳';
    btn.style.cssText =
      `position:absolute;display:none;width:${BTN_W}px;height:${BTN_H}px;` +
      'box-sizing:border-box;text-align:center;line-height:26px;border-radius:999px;' +
      'background:#ec4899;color:#fff;font:13px/26px "Segoe UI",system-ui,sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none;';
    root.appendChild(btn);

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
    /** 选区是否来自 AI 建议框：只有建议框显示手柄与「采纳」按钮（用户 2026-10-09 拍板：
     *  右下角放采纳按钮、边界可拖，**不要**单击/回车采纳）；手拖选区仍是松手即采纳 */
    let sugSel = false;
    /** 正在拖的边界方位；只有建议框能进这个状态 */
    let resizeDir = null;

    const clampX = (v) => Math.min(Math.max(v, 0), window.innerWidth);
    const clampY = (v) => Math.min(Math.max(v, 0), window.innerHeight);

    /** 手柄中心点与「采纳」按钮矩形（按钮贴选区右下角外侧，右下角本体不设手柄） */
    const handleCenters = (s) => ({
      nw: [s.x, s.y],
      n: [s.x + s.w / 2, s.y],
      ne: [s.x + s.w, s.y],
      w: [s.x, s.y + s.h / 2],
      e: [s.x + s.w, s.y + s.h / 2],
      sw: [s.x, s.y + s.h],
      s: [s.x + s.w / 2, s.y + s.h],
    });

    const btnRectOf = (s) => ({
      x: Math.min(s.x + s.w - BTN_W, window.innerWidth - BTN_W), // 右缘对齐选区，越界贴视口边
      y: Math.min(s.y + s.h + 6, window.innerHeight - BTN_H), // 紧贴下边缘外侧
      w: BTN_W,
      h: BTN_H,
    });

    const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

    /** 命中缩放手柄 → 方位；没命中返回 null */
    const hitHandle = (x, y, s) => {
      const cs = handleCenters(s);
      for (const d of HANDLES) {
        const [cx, cy] = cs[d];
        if (Math.abs(x - cx) <= HS / 2 + HIT && Math.abs(y - cy) <= HS / 2 + HIT) return d;
      }
      return null;
    };

    /** 手柄与按钮只在建议框预填期间显示，其余一律收起 */
    const layoutExtras = () => {
      const show = sugSel && sel;
      handleWrap.style.display = show ? 'block' : 'none';
      btn.style.display = show ? 'block' : 'none';
      if (!show) return;
      const cs = handleCenters(sel);
      for (const d of HANDLES) {
        handleEls[d].style.left = `${cs[d][0] - HS / 2}px`;
        handleEls[d].style.top = `${cs[d][1] - HS / 2}px`;
      }
      const b = btnRectOf(sel);
      btn.style.left = `${b.x}px`;
      btn.style.top = `${b.y}px`;
    };

    /** 拖哪条边就动哪条（对边不动，含 4 角），夹进视口后重画 */
    const resizeTo = (cx, cy) => {
      const d = resizeDir;
      let { x, y, w, h } = sel;
      if (d.includes('w')) {
        const right = x + w;
        x = Math.min(clampX(cx), right);
        w = right - x;
      }
      if (d.includes('e')) {
        w = Math.max(0, clampX(cx) - x);
      }
      if (d.includes('n')) {
        const bottom = y + h;
        y = Math.min(clampY(cy), bottom);
        h = bottom - y;
      }
      if (d.includes('s')) {
        h = Math.max(0, clampY(cy) - y);
      }
      paint(x, y, x + w, y + h);
    };

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
      layoutExtras();
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
      paint(x0, y0, x1, y1);
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      moved = false;
      resizeDir = null;
      startX = clampX(e.clientX);
      startY = clampY(e.clientY);
      if (sugSel && sel) {
        // 右下角「采纳」按钮：点它才提交（单击框内 / 回车已按 2026-10-09 拍板废弃）
        if (inRect(startX, startY, btnRectOf(sel))) {
          finish(sel);
          return;
        }
        const hd = hitHandle(startX, startY, sel);
        if (hd) {
          resizeDir = hd; // 拖边界：改选区，松手**不**提交
          return;
        }
        if (
          startX >= sel.x &&
          startX <= sel.x + sel.w &&
          startY >= sel.y &&
          startY <= sel.y + sel.h
        ) {
          return; // 框内空白：按住不动（边界与按钮才是操作面，拖空白不销毁建议框）
        }
      }
      sugSel = false;
      paint(startX, startY, startX, startY);
    };

    const onMove = (e) => {
      if (!dragging) return;
      const cx = clampX(e.clientX);
      const cy = clampY(e.clientY);
      if (resizeDir) {
        resizeTo(cx, cy);
        return;
      }
      if (sugSel) return; // 框内空白拖动：选区原地不动
      const r = paint(startX, startY, cx, cy);
      if (r.w > 6 || r.h > 6) moved = true;
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      if (resizeDir) {
        resizeDir = null; // 收边界：选区留下，等用户点「采纳」
        return;
      }
      if (sugSel) return; // 框内空白：什么都不发生，建议框还在
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
      // Enter 采纳已废弃（2026-10-09 拍板）：采纳只走右下角按钮
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
