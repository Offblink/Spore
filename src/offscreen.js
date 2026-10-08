// ML 建议框的 OCR 宿主（跑在 offscreen.html 里，见该文件头注释）。
//
// 入参 = SW 发来的冻结帧 dataURL（spore:ocr）；出参 = 归一化建议框 {l,t,r,b}
// （0..1，相对冻结帧），或 null —— null 表示识别不出字，调用方（SW → 覆盖层）
// 静默退化为手动拖框，**不弹任何提示**（用户 2026-10-08 拍板：不搬 Mobile 的硬门禁）。
//
// 坐标口径：覆盖层用 object-fit:fill 把冻结帧铺满视口，所以「分数坐标 × innerWidth/innerHeight」
// 就是视口 CSS px，与 sw.js `cropShot` 里 `bmp.width / rect.viewportW` 是同一套比例。
(() => {
  /** 识别前先缩到长边 ≤1600（与 GUI 端 ML_LONG_EDGE 同参） */
  const LONG_EDGE = 1600;
  /** 识别器初始化预算：manifest CSP 少了 wasm 关键字时 createWorker 会永久 pending，见 worker() */
  const WORKER_TIMEOUT_MS = 8000;
  const BASE = chrome.runtime.getURL('src/lib/tesseract');

  /** 识别器单例：首跑要编 wasm + 载语言包（几百 ms），之后每次 ~0.5s */
  let workerP = null;

  function worker() {
    if (!workerP) {
      const p = Tesseract.createWorker('chi_sim', 1, {
        workerPath: `${BASE}/worker.min.js`,
        // corePath 必须以 .js 结尾：getCore 的规则是「以 js 结尾就原样加载」，
        // 否则它会按 SIMD 特性自己挑文件名，而我们只 vendor 了 simd-lstm 这一个。
        corePath: `${BASE}/tesseract-core-simd-lstm.wasm.js`,
        langPath: BASE, // → `${langPath}/chi_sim.traineddata.gz`（gzip: true 默认）
        // 扩展 CSP 只放行 'self'，blob: worker 会被拦 → 直接按同源 URL 起 Worker
        workerBlobURL: false,
        gzip: true,
        logger: () => {},
      });
      // tesseract 的 `Core(...).then()` 没有 catch：wasm 被 CSP 拒 / 资产缺失时那个
      // promise **永远 pending**（2026-10-09 实测卡死在 "initializing tesseract" 0%，
      // 且一次挂死就毒化之后每一轮）。所以限时：超时丢弃实例、晚到的成功就地 terminate。
      workerP = Promise.race([
        p,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('worker init timeout')), WORKER_TIMEOUT_MS)),
      ]).catch((e) => {
        workerP = null;
        p.then((w) => w.terminate()).catch(() => {});
        throw e;
      });
    }
    return workerP;
  }

  /** dataURL → 画进 canvas 并缩到长边 ≤1600；连帧的原尺寸一起返回 */
  function toWorkCanvas(shot) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          reject(new Error('empty shot'));
          return;
        }
        const k = Math.min(1, LONG_EDGE / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ canvas: c, w, h });
      };
      img.onerror = () => reject(new Error('shot decode failed'));
      img.src = shot;
    });
  }

  async function suggestBox(shot) {
    const { canvas, w, h } = await toWorkCanvas(shot);
    // blocks 默认不产出（tesseract.js defaultOutput.blocks = false），必须显式要
    const { data } = await (await worker()).recognize(canvas, {}, { blocks: true });
    const kx = w / canvas.width;
    const ky = h / canvas.height;
    const lines = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const ln of p.lines || []) {
          const bb = ln && ln.bbox;
          // 行 text 带尾换行，trim 掉再进 Suggestor（Java 那边 ML Kit 行文本无换行）
          const text = ((ln && ln.text) || '').trim();
          if (!bb || !text) continue;
          lines.push({
            left: Math.round(bb.x0 * kx),
            top: Math.round(bb.y0 * ky),
            right: Math.round(bb.x1 * kx),
            bottom: Math.round(bb.y1 * ky),
            text,
          });
        }
      }
    }
    const box = globalThis.SporeSuggest.suggest(lines, w, h);
    if (!box) return null;
    return { l: box[0] / w, t: box[1] / h, r: box[2] / w, b: box[3] / h };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'spore:ocr') return false;
    suggestBox(msg.shot)
      .then((box) => sendResponse({ box }))
      .catch((e) => {
        console.warn('[spore] ocr failed', e);
        sendResponse({ box: null });
      });
    return true; // 异步应答
  });
})();
