// 建议框选择器：OCR 文本行 → 纵向聚类 → 选最像题的块 → 输出单框。
// 忠实移植 Mobile 端 Suggestor.java（其行为由那边的 SuggestTest.java 钉住），
// tests/suggestor.test.mjs 按同样用例形状钉行为；纯几何/文本逻辑、零依赖、经典脚本挂全局
// （参照 src/lib/md.js 的 SporeMD 写法；offscreen.html 加载）。
//
// 坐标系 = 冻结帧像素；返回 [left, top, right, bottom]（含外扩 padding），无可用块 → null
// （调用方退化为手动拖框）。判据存档（Mobile handoff §9.3）：单帧回归不可靠、文本聚类无语义
// → 只给「建议 + 一次确认」，误判成本从「搜错题」降为「拖一下」。
//
// 移植注意事项（照抄 Java 语义，别「优化」）：
//   · sb 每行前都拼一个空格；firstLine() = trim 后**第一个空格前**的片段（行内空格也算）；
//   · absorb() 不更新 lastLineH（Java 源如此，行为由测试钉住）；
//   · 强转一律截断（Java (int)），不是四舍五入。
(() => {
  /** 题号开头：`1.` `2、` `3．` `4)` `5）`（前导空白可有可无） */
  const NUMBERING = /^\s*\d+\s*[.、．)）]/;
  /** 题干常见词（命中 +10，一票多词也只加一次） */
  const CUES = [
    '下列', '选择', '判断', '如图', '关于', '说法', '正确', '错误',
    '多少', '等于', '计算', '求解', '公式', '实验', '如右图',
  ];

  /**
   * @param {Array<{left:number,top:number,right:number,bottom:number,text:string}>} lines OCR 行（可为空）
   * @param {number} frameW 冻结帧宽（像素），块太小 = 不建议
   * @param {number} frameH 冻结帧高
   * @returns {number[]|null} 单框 [left, top, right, bottom]（帧坐标、含外扩 padding）
   */
  function suggest(lines, frameW, frameH) {
    if (!lines || lines.length === 0 || frameW <= 0 || frameH <= 0) return null;
    const usable = [];
    for (const l of lines) {
      const text = l.text == null ? '' : String(l.text);
      if (text.trim() !== '' && l.right > l.left && l.bottom > l.top) {
        usable.push({ left: l.left, top: l.top, right: l.right, bottom: l.bottom, text });
      }
    }
    if (usable.length === 0) return null;

    // Java: Comparator.comparingInt(top).thenComparingInt(left)（TimSort 稳定；JS 排序同样稳定）
    usable.sort((a, b) => a.top - b.top || a.left - b.left);

    const clusters = cluster(usable);

    const minW = Math.trunc(0.10 * frameW);
    const minH = Math.max(36, Math.trunc(0.015 * frameH));

    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      if (c.width() < minW || c.height() < minH) continue; // 小块没资格当建议框（手动拖才够准）
      const s = c.score();
      if (best === null || s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (best === null) return null;
    return pad(best.left, best.top, best.right, best.bottom, frameW, frameH);
  }

  /** 纵向相邻（间隙 ≤ 1.6 行高）且水平重叠 ≥ 20%（窄者计）→ 同块；行序自上而下 */
  function cluster(sorted) {
    const out = [];
    for (const line of sorted) {
      const hits = out.filter((c) => c.canJoin(line));
      if (hits.length === 0) {
        out.push(newCluster(line)); // Java ctor：先定界再 add 第一行
        continue;
      }
      const first = hits[0];
      first.add(line);
      for (let i = 1; i < hits.length; i++) {
        first.absorb(hits[i]);
        out.splice(out.indexOf(hits[i]), 1);
      }
    }
    return out;
  }


  function pad(l, t, r, b, frameW, frameH) {
    const p = Math.trunc(Math.max(8, Math.min(24, 0.02 * Math.max(r - l, b - t))));
    return [
      Math.max(0, l - p),
      Math.max(0, t - p),
      Math.min(frameW, r + p),
      Math.min(frameH, b + p),
    ];
  }

  function newCluster(l) {
    const c = {
      left: l.left,
      top: l.top,
      right: l.right,
      bottom: l.bottom,
      lastLineH: l.bottom - l.top,
      chars: 0,
      sb: '',
      add(line) {
        this.left = Math.min(this.left, line.left);
        this.top = Math.min(this.top, line.top);
        this.right = Math.max(this.right, line.right);
        this.bottom = Math.max(this.bottom, line.bottom);
        this.lastLineH = line.bottom - line.top;
        this.sb += ' ' + line.text;
        this.chars += line.text.trim().length;
      },
      // 注意：Java 的 absorb 不更新 lastLineH —— 忠实保留
      absorb(c) {
        this.left = Math.min(this.left, c.left);
        this.top = Math.min(this.top, c.top);
        this.right = Math.max(this.right, c.right);
        this.bottom = Math.max(this.bottom, c.bottom);
        this.sb += ' ' + c.sb;
        this.chars += c.chars;
      },
      canJoin(line) {
        const gap = line.top - this.bottom;
        if (gap > 1.6 * this.lastLineH) return false;
        const overlap = Math.min(this.right, line.right) - Math.max(this.left, line.left);
        const minW = Math.min(this.width(), line.right - line.left);
        return minW > 0 && overlap >= 0.2 * minW;
      },
      width() {
        return this.right - this.left;
      },
      height() {
        return this.bottom - this.top;
      },
      /** 题面信号 + 文本量；平手取先出现（上方）的块 */
      score() {
        const text = this.sb;
        let s = Math.min(this.chars, 150) / 10;
        if (text.indexOf('？') >= 0 || text.indexOf('?') >= 0) s += 40;
        if (NUMBERING.test(firstLine(this))) s += 25;
        for (const cue of CUES) {
          if (text.indexOf(cue) >= 0) {
            s += 10;
            break; // 多词也只加一次，防止关键词堆叠压过问号
          }
        }
        return s;
      },
    };
    c.add(l); // Java 构造器最后调了 add(第一行)
    return c;
  }

  function firstLine(c) {
    const raw = c.sb.trim();
    const sp = raw.indexOf(' ');
    return sp >= 0 ? raw.slice(0, sp) : raw;
  }

  globalThis.SporeSuggest = { suggest };
})();
