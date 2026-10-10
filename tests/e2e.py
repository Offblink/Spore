"""Spore 真机端到端自测（Playwright + 本机 Edge）。

跑法（模型 key 走 `SPORE_E2E_KEY` 环境变量或 gitignore 的 `tests/_run/e2e_key`，默认设置不含 key）：

    python tests/e2e.py

覆盖：Alt+S 框选截图 → 抽屉弹出 → 阶段A 直接作答 → <<ok>> 守卫/联网核实 →
异步起名 → 半圆小角收起弹出（内压/外凸）→ 会话气泡点击列表（悬停不触发）→ 顶栏 ★ 收藏（品牌粉、
只标记不置顶、有提示）→ 删除/重命名后列表保持 → 滚动不跟随 → CoT 思考块 → 追问 → 0 下载（静默镜像）
→ FSA 写盘能力 → 设置页搜题记录首块 + 整页审查（筛选 / 列表收放 / hash 定位）+
涂抹多选（「批量选择」按钮进模式·0 选起手 / 单选框涂抹与折返换向 / 批量收藏·移入科目·删除 /
底栏取消·Escape·换筛选·按钮再点四条退出路）+ 涂抹贴边自动滚动 #list（贴下缘连续滚 → 回中部停 →
pointerup 必停，播种超长列表，全确定性）+ LaTeX 渲染（四类分隔符 / $2+2=4$ 出 .katex、价格 $5 不被吞、
坏公式原样源码 / 宽表格 .tablewrap 横向滚 / 题号前缀不顶掉首行标题 / 整页与抽屉 shadow 两面钉住共用 md.js）+ 拖入图片 URL 读取（两处 composer 的 dragover 兜底 /
非 http(s) 忽略并提示 / 拉非图不建会话 / 真图建会话且消息带图）。
全部断言通过时退出码为 0；失败会把现场截图留在 tests/_shots/。
"""

import ast
import os
import pathlib
import shutil
import subprocess
import sys
import time
import traceback

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
EXT = str(REPO)
ROOT = HERE / "_run"
PAGE = "http://127.0.0.1:8899/page.html"
SHOTS = HERE / "_shots"
PROFILE = ROOT / "profile"
SHOTS.mkdir(parents=True, exist_ok=True)
(ROOT / 'profile').parent.mkdir(parents=True, exist_ok=True)

fails = []
steps = []


def check(name, ok, detail=""):
    steps.append(("PASS" if ok else "FAIL", name, str(detail)[:220]))
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}", flush=True)
    if not ok:
        fails.append(name)
    return ok


def guard(page, name, fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 — 测试要拿到现场而不是崩掉
        check(name, False, f"{type(e).__name__}: {e}")
        dump(page, name)
        return None


def dump(page, tag):
    try:
        page.screenshot(path=str(SHOTS / f"fail-{tag.replace(' ', '_')[:40]}.png"))
    except Exception:
        pass
    try:
        print("  #status =", s_text(page, "#status"), flush=True)
        print("  .err =", s_text(page, "#stream .err"), flush=True)
        print("  #title =", s_text(page, "#title"), flush=True)
        print("  msgs =", s_count(page, "#stream .msg"), " ans =", s_count(page, "#stream .ans"), flush=True)
    except Exception as e:
        print("  dump failed:", e, flush=True)


def s_eval(page, expr):
    return page.evaluate(
        """(expr) => {
            const h = document.querySelector('spore-drawer');
            if (!h || !h.shadowRoot) return null;
            return expr(h.shadowRoot);
        }""",
        expr,
    )


def s_text(page, sel):
    return page.evaluate(
        """(sel) => {
            const h = document.querySelector('spore-drawer');
            const e = h && h.shadowRoot && h.shadowRoot.querySelector(sel);
            return e ? e.textContent.trim() : null;
        }""",
        sel,
    )


def s_count(page, sel):
    return page.evaluate(
        """(sel) => {
            const h = document.querySelector('spore-drawer');
            return h && h.shadowRoot ? h.shadowRoot.querySelectorAll(sel).length : -1;
        }""",
        sel,
    )


def s_cls(page, sel):
    return page.evaluate(
        """(sel) => {
            const h = document.querySelector('spore-drawer');
            const e = h && h.shadowRoot && h.shadowRoot.querySelector(sel);
            return e ? e.className : null;
        }""",
        sel,
    )


def s_scroll(page):
    return page.evaluate(
        """() => {
            const s = document.querySelector('spore-drawer').shadowRoot.querySelector('#stream');
            return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight };
        }"""
    )


def no_date_prefix(t):
    """起名契约：标题一律不含 MMDD- 日期前缀（日期只出现在列表行小字时间戳里）"""
    return bool(t) and not (len(t) >= 5 and t[:4].isdigit() and t[4] == "-")


def wait_answer(page, expect_n, timeout=150000):
    page.wait_for_function(
        """(n) => {
            const h = document.querySelector('spore-drawer');
            const els = h && h.shadowRoot ? [...h.shadowRoot.querySelectorAll('#stream .ans')] : [];
            if (els.length < n) return false;
            return els[n - 1].textContent.trim().length > 3;
        }""",
        arg=expect_n,
        timeout=timeout,
    )
    return page.evaluate(
        """(n) => {
            const els = [...document.querySelector('spore-drawer').shadowRoot.querySelectorAll('#stream .ans')];
            return els[n - 1].textContent.trim();
        }""",
        expect_n,
    )


def wait_idle(page, timeout=240000):
    page.wait_for_function(
        """() => {
            const h = document.querySelector('spore-drawer');
            const el = h && h.shadowRoot && h.shadowRoot.querySelector('#status');
            return !!(el && !el.classList.contains('on') && !el.classList.contains('err'));
        }""",
        timeout=timeout,
        polling=500,
    )



def geom(page):
    """抽屉几何：半圆小角与矩形的相对位置、会话气泡可见性、字号"""
    return page.evaluate(
        """() => {
            const h = document.querySelector('spore-drawer');
            const sr = h && h.shadowRoot;
            if (!sr) return null;
            const g = (sel) => sr.querySelector(sel);
            const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
            const panel = box(g('#panel'));
            const toggle = box(g('#toggle'));
            const ans = g('.ans');
            return {
                vw: window.innerWidth,
                panelX: panel.x,
                toggleX: toggle.x,
                toggleW: toggle.w,
                sessions: getComputedStyle(g('#sessions')).display,
                listpop: g('#listpop').className,
                ansFont: ans ? parseFloat(getComputedStyle(ans).fontSize) : null,
                titleFont: parseFloat(getComputedStyle(g('#title')).fontSize),
            };
        }"""
    )


def capture(page, q_index):
    box = page.locator("p.q").nth(q_index).bounding_box()
    page.keyboard.press("Alt+S")
    page.wait_for_selector("#spore-overlay-root", timeout=10000)
    page.screenshot(path=str(SHOTS / f"overlay-{q_index}.png"))
    page.mouse.move(box["x"] + 4, box["y"] + 4)
    page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(box["x"] + 4 + (box["width"] - 8) * i / 8, box["y"] + 4 + (box["height"] - 8) * i / 8)
        page.wait_for_timeout(20)
    page.mouse.up()
    page.wait_for_selector("#spore-overlay-root", state="detached", timeout=10000)
    return True


def main():
    # 断言里写死了「存储里有 2 个会话」，所以每次都要全新 profile
    for d in (PROFILE, SHOTS):
        shutil.rmtree(d, ignore_errors=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    PROFILE.parent.mkdir(parents=True, exist_ok=True)

    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8899", "--bind", "127.0.0.1"],
        cwd=str(HERE / "fixtures"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.2)
    try:
        # 检索链的「三道闸」与初答自检（答案行 vs 解析结论）都是确定性逻辑，
        # 真网络造不出诱饵页/429、真模型复现不出同一条矛盾 —— 分别钉在两个离线测试里
        for t_name, t_check in (
            ("search.test.mjs", "离线：检索引擎链三闸全过（node --test tests/search.test.mjs）"),
            ("answer.test.mjs", "离线：初答自检与阶段B 解析契约全过（node --test tests/answer.test.mjs）"),
            ("suggestor.test.mjs", "离线：建议框算法（Suggestor 移植）契约全过（node --test tests/suggestor.test.mjs）"),
        ):
            off = subprocess.run(
                ["node", "--test", str(HERE / t_name)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(REPO),
            )
            off_tail = ((off.stdout or "") + (off.stderr or "")).strip().replace("\n", " ")
            check(t_check, off.returncode == 0, off_tail[-180:])

        with sync_playwright() as p:
            # 无头跑，不在用户桌面上开窗口、不弹 --no-sandbox 横幅；
            # 新版 headless 支持扩展（Edge 154）。失败则回退有头。
            try:
                ctx = p.chromium.launch_persistent_context(
                    str(PROFILE),
                    executable_path=EDGE,
                    headless=True,
                    args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
                    viewport={"width": 1440, "height": 900},
                    accept_downloads=True,
                    chromium_sandbox=True,
                )
            except Exception as e:  # noqa: BLE001
                print("[fallback] headless 起不来，改有头：", e, flush=True)
                ctx = p.chromium.launch_persistent_context(
                    str(PROFILE),
                    executable_path=EDGE,
                    headless=False,
                    args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
                    viewport={"width": 1440, "height": 900},
                    accept_downloads=True,
                )
            # 确认扩展真的加载了（无头模式下个别版本会静默不加载）
            sw = ctx.service_workers[0] if ctx.service_workers else None
            if not sw:
                ctx.wait_for_event("serviceworker", timeout=15000)
                sw = ctx.service_workers[0] if ctx.service_workers else None
            assert sw, "extension service worker 没起来"
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("pageerror", lambda e: print("[pageerror]", e, flush=True))
            page.on(
                "console",
                lambda m: print("[console.error]", m.text, flush=True) if m.type == "error" else None,
            )

            page.goto(PAGE, wait_until="load")
            page.wait_for_selector("spore-drawer", timeout=15000)
            check("内容脚本注入（抽屉 host 存在）", True)

            sw = ctx.service_workers[0] if ctx.service_workers else None
            check("service worker 已启动", sw is not None, getattr(sw, "url", ""))
            if sw:
                print("SW url:", sw.url, flush=True)

            # 模型密钥不入库（公开仓红线）：从 SPORE_E2E_KEY 或 gitignore 的 tests/_run/e2e_key 读，
            # 必须在第一次 capture 之前写进 spore.settings（全新 profile 没有任何默认 key）
            if sw:
                key = os.environ.get("SPORE_E2E_KEY", "").strip()
                if not key and (ROOT / "e2e_key").exists():
                    key = (ROOT / "e2e_key").read_text(encoding="utf-8").strip()
                assert key, "缺模型密钥：设 SPORE_E2E_KEY 或写入 tests/_run/e2e_key"
                sw.evaluate(
                    """async (key) => {
                        const k = 'spore.settings';
                        const cur = (await chrome.storage.local.get(k))[k] || {};
                        cur.apiKey = key;
                        await chrome.storage.local.set({ [k]: cur });
                        return true;
                    }""",
                    key,
                )

            # 快捷键应由 manifest 的 suggested_key 自动绑上（全新 profile，没有手工覆盖）
            if sw:
                cmd = sw.evaluate(
                    """async () => {
                        const list = await chrome.commands.getAll();
                        const c = list.find((x) => x.name === 'capture-region');
                        const t = list.find((x) => x.name === 'toggle-drawer');
                        return { cap: c ? c.shortcut : null, tog: t ? t.shortcut : null };
                    }"""
                )
                check("快捷键自动绑定 Alt+S（无需手设）", cmd and cmd.get("cap") == "Alt+S", repr(cmd))
                check("抽屉快捷键自动绑定 Alt+Z", cmd and cmd.get("tog") == "Alt+Z", repr(cmd))

            page.wait_for_timeout(700)
            check("抽屉默认收起", s_cls(page, "#root") != "open", s_cls(page, "#root"))
            page.screenshot(path=str(SHOTS / "01-initial.png"))

            # ---------------- 第 1 题：纯数学，走「快答」 ----------------
            if guard(page, "capture q7", lambda: capture(page, 0)) is not None:
                ans1 = guard(page, "阶段A 出答案（第 7 题）", lambda: wait_answer(page, 1, 90000))
                check("阶段A 出答案（第 7 题）", bool(ans1), repr(ans1))
                page.wait_for_timeout(400)
                page.screenshot(path=str(SHOTS / "02-streaming.png"))

                # 滚动策略：手动把视图拉到顶，流式期间不得被拽走
                page.evaluate(
                    """() => {
                        const s = document.querySelector('spore-drawer').shadowRoot.querySelector('#stream');
                        s.scrollTop = 0;
                        s.dispatchEvent(new Event('scroll'));
                    }"""
                )
                before = s_scroll(page)
                page.wait_for_timeout(3000)
                after = s_scroll(page)
                check(
                    "流式期间滚动条不跟随",
                    before["top"] == after["top"] == 0,
                    f"{before} -> {after}",
                )
                if after["max"] > 60:
                    check(
                        "不在底部时出现 ↓ 按钮",
                        "on" in (s_cls(page, "#jump") or ""),
                        f"max={after['max']} cls={s_cls(page, '#jump')}",
                    )
                else:
                    check(
                        "内容不足一屏时不显示 ↓ 按钮",
                        "on" not in (s_cls(page, "#jump") or ""),
                        f"max={after['max']}",
                    )

                guard(page, "阶段B 核实（第 7 题）", lambda: wait_idle(page, 180000))
                verify1 = s_text(page, "#stream .verify .vnote") or ""
                check("核实块有说明（跑了核实，或说明为何跳过）", len(verify1) > 8, repr(verify1[:140]))
                page.screenshot(path=str(SHOTS / "03-answer1.png"))

                # 截图已拆键：消息体里只剩 imageKey，抽屉按需取回再填 src
                shot_ok = page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const im = sr.querySelector('#stream .msg.user img.shot');
                        return !!(im && im.getAttribute('src') && im.naturalWidth > 0);
                    }"""
                )
                check("问题截图在抽屉里渲染（拆键后按需取回）", bool(shot_ok), repr(shot_ok))

                # 点截图不开新页：data URL 新标签就是空白页，已按用户拍板禁用点击（看细节用 Edge 自带缩放）
                st0 = page.evaluate(
                    """() => {
                        const s = document.querySelector('spore-drawer').shadowRoot.querySelector('#stream');
                        return s ? s.scrollTop : 0;
                    }"""
                )
                pages_before = len(ctx.pages)
                page.click("spore-drawer >> #stream .msg.user img.shot")
                page.wait_for_timeout(600)
                check(
                    "点问题截图不开新页（已禁用点击）",
                    len(ctx.pages) == pages_before,
                    f"{pages_before} -> {len(ctx.pages)}",
                )
                page.evaluate(
                    """(v) => {
                        const s = document.querySelector('spore-drawer').shadowRoot.querySelector('#stream');
                        if (s) s.scrollTop = v;
                    }""",
                    st0,
                )

                title1 = s_text(page, "#title")
                # 新起名契约：标题 = 题号 + 题目大意（阶段A 顺带吐 TITLE，零额外模型调用）
                check(
                    "自动起名（题号 + 大意）",
                    bool(title1) and "解析中" not in title1 and title1.startswith("第7题"),
                    repr(title1),
                )
                check("标题不含日期前缀（起名契约）", no_date_prefix(title1), repr(title1))

            # ---------------- 第 2 题：事实题，应触发联网检索 ----------------
            guard(page, "等第 7 题回合结束", lambda: wait_idle(page, 180000))
            title_before = s_text(page, "#title")
            # 关掉「自动核实」：这一问应该只出初答，留下「核实一下」按钮
            auto_off = sw.evaluate(
                """async () => {
                    const k = 'spore.settings';
                    const cur = (await chrome.storage.local.get(k))[k] || {};
                    cur.autoVerify = false;
                    await chrome.storage.local.set({ [k]: cur });
                    return cur.autoVerify;
                }"""
            )
            check("设置里关掉自动核实（autoVerify=false）", auto_off is False, repr(auto_off))
            if guard(page, "capture q8", lambda: capture(page, 1)) is not None:
                page.wait_for_timeout(1500)
                title_after = s_text(page, "#title")
                msgs_now = s_count(page, "#stream .msg")
                check(
                    "截图后抽屉切到新会话（标题换成了新会话的占位）",
                    title_after != title_before and msgs_now <= 2,
                    f"title {title_before!r} -> {title_after!r}, msgs={msgs_now}",
                )
                check("新会话标题不含日期前缀", no_date_prefix(title_after), repr(title_after))
                page.wait_for_timeout(1500)
                ans2 = guard(page, "阶段A 出答案（第 8 题）", lambda: wait_answer(page, 1, 120000))
                check("阶段A 出答案（第 8 题）", bool(ans2), repr(ans2))
                page.screenshot(path=str(SHOTS / "04-answer2-streaming.png"))

                # 关掉自动核实：初答后必须留一个「核实一下」按钮，最后一条回答里没有核实块
                guard(page, "等阶段A 收尾（未自动核实）", lambda: wait_idle(page, 180000))
                page.wait_for_timeout(800)
                vb = page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const last = [...sr.querySelectorAll('#stream .msg.bot')].pop();
                        const b = last && last.querySelector('.vbtn');
                        return { hasBtn: !!b, shown: !!(b && b.classList.contains('on')),
                                 btnText: b ? b.textContent.trim() : '',
                                 verifyOn: !!(last && last.querySelector('.verify.on')) };
                    }"""
                )
                check("未自动核实：显示「核实一下」按钮", vb["hasBtn"] and vb["shown"], str(vb))
                check("未自动核实：没有自动跑核实块", not vb["verifyOn"], str(vb))

                page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const last = [...sr.querySelectorAll('#stream .msg.bot')].pop();
                        last && last.querySelector('.vbtn.on')?.click();
                    }"""
                )
                page.wait_for_timeout(500)
                gone = page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const last = [...sr.querySelectorAll('#stream .msg.bot')].pop();
                        return !last || !last.querySelector('.vbtn');
                    }"""
                )
                check("点「核实一下」后按钮消失", gone, f"gone={gone}")

                guard(page, "手动核实（第 8 题）", lambda: wait_idle(page, 240000))
                verify2 = s_text(page, "#stream .verify .vnote") or ""
                check("第 8 题核实完成且有核实说明", len(verify2) > 8, repr(verify2[:220]))
                tools2 = s_count(page, "#stream .tool")
                check("阶段B 触发了检索", tools2 >= 1, f"tool chips={tools2}")
                check("检索 chip 持久化（回合结束重渲染后还在）", tools2 >= 1, tools2)

                # 检索返回口径（改/加断言理由：同步 Fungi §71 后返回只有三态；旧实现是
                # `ERROR: search failed (empty results)` 小写口径，本次必须钉死新的）
                slogs = sw.evaluate("async () => (await chrome.storage.local.get('spore.log'))['spore.log'] || []")
                mode = [l for l in slogs if " search: " in l]
                check(
                    "检索日志有模式行（未配代理 → 只走 bing）",
                    any("未配代理" in l and "bing" in l for l in mode),
                    str(mode[-1:])[:200],
                )
                heads = [l.split("→ ", 1)[1] for l in slogs if 'web_search "' in l and "→ " in l]
                bad = [
                    h
                    for h in heads
                    if not (
                        h.startswith("1. ")
                        or h.startswith("(no results for ")
                        or h.startswith("ERROR: Search failed ")
                    )
                ]
                check(
                    "web_search 返回三态口径（编号命中 / (no results / ERROR: Search failed）",
                    bool(heads) and not bad,
                    str(bad[:1] or heads[:1])[:220],
                )
                page.screenshot(path=str(SHOTS / "05-answer2.png"))

            # ---------------- 半圆小角的朝向 / 气泡可见性 / 字号 ----------------
            g_open = guard(page, "展开态几何", lambda: geom(page))
            if g_open:
                print("  geom(open):", g_open, flush=True)
                check(
                    "展开时半圆压在矩形左缘（向内）",
                    abs(g_open["toggleX"] - g_open["panelX"]) <= 3,
                    f"toggle={g_open['toggleX']} panel={g_open['panelX']}",
                )
                check("展开时会话气泡可见", g_open["sessions"] != "none", g_open["sessions"])
                check(
                    "字号已整体放大（ans ≥ 17px）",
                    bool(g_open["ansFont"] and g_open["ansFont"] >= 17),
                    f"ans={g_open['ansFont']} title={g_open['titleFont']}",
                )

            # ---------------- 抽屉收起 / 半圆小角 ----------------
            print(
                "  pre-toggle state:",
                page.evaluate("() => window.__sporeDrawer && window.__sporeDrawer.state()"),
                "class:",
                s_cls(page, "#root"),
                "hosts:",
                page.evaluate("() => document.querySelectorAll('spore-drawer').length"),
                flush=True,
            )
            guard(page, "collapse", lambda: (page.click("spore-drawer >> #toggle"), page.wait_for_timeout(900)))
            print(
                "  post-toggle state:",
                page.evaluate("() => window.__sporeDrawer && window.__sporeDrawer.state()"),
                "class:",
                s_cls(page, "#root"),
                flush=True,
            )
            check("点击 › 收起抽屉", s_cls(page, "#root") != "open", s_cls(page, "#root"))
            g_closed = guard(page, "收起态几何", lambda: geom(page))
            if g_closed:
                print("  geom(closed):", g_closed, flush=True)
                check(
                    "收起时半圆凸在矩形之外（屏幕右缘）",
                    g_closed["toggleX"] >= g_closed["vw"] - 26,
                    f"toggle={g_closed['toggleX']} vw={g_closed['vw']} panel={g_closed['panelX']}",
                )
                check("收起时不显示会话气泡", g_closed["sessions"] == "none", g_closed["sessions"])
            page.screenshot(path=str(SHOTS / "06-collapsed.png"))
            guard(page, "expand", lambda: (page.click("spore-drawer >> #toggle"), page.wait_for_timeout(750)))
            check("点击 ‹ 弹出抽屉", s_cls(page, "#root") == "open", s_cls(page, "#root"))

            # ---------------- Alt+Z 弹出/收起抽屉（默认绑定 + 页面 keydown 兜底） ----------------
            page.keyboard.press("Alt+Z")
            page.wait_for_timeout(800)
            check("Alt+Z 收起抽屉", s_cls(page, "#root") != "open", s_cls(page, "#root"))
            page.keyboard.press("Alt+Z")
            page.wait_for_timeout(800)
            check("Alt+Z 再按弹出抽屉", s_cls(page, "#root") == "open", s_cls(page, "#root"))

            # ---------------- 隐藏半圆小角：只藏**收起态**（初衷=别遮网页），默认关 ----------------
            default_hide = sw.evaluate(
                """async () => {
                    const cur = (await chrome.storage.local.get('spore.settings'))['spore.settings'] || {};
                    return cur.hideToggle === true;
                }"""
            )
            check("隐藏半圆小角默认关", default_hide is False, repr(default_hide))
            sw.evaluate(
                """async () => {
                    const cur = (await chrome.storage.local.get('spore.settings'))['spore.settings'] || {};
                    return chrome.storage.local.set({ 'spore.settings': { ...cur, hideToggle: true } });
                }"""
            )
            page.wait_for_timeout(400)
            shown_open = page.evaluate(
                """() => getComputedStyle(document.querySelector('spore-drawer').shadowRoot.querySelector('#toggle')).display !== 'none'"""
            )
            check("开启后：展开态收起把手仍在（不禁用收回）", bool(shown_open), str(shown_open))
            # 收起后小角必须消失——这才是开关的初衷：别遮网页
            guard(page, "hide-toggle 下收起", lambda: (page.click("spore-drawer >> #toggle"), page.wait_for_timeout(400)))
            hidden_closed = page.evaluate(
                """() => getComputedStyle(document.querySelector('spore-drawer').shadowRoot.querySelector('#toggle')).display === 'none'"""
            )
            check("开启后：收起态半圆小角隐藏（不遮网页）", bool(hidden_closed), str(hidden_closed))
            sw.evaluate(
                """async () => {
                    const cur = (await chrome.storage.local.get('spore.settings'))['spore.settings'] || {};
                    return chrome.storage.local.set({ 'spore.settings': { ...cur, hideToggle: false } });
                }"""
            )
            page.wait_for_timeout(400)
            shown_closed = page.evaluate(
                """() => getComputedStyle(document.querySelector('spore-drawer').shadowRoot.querySelector('#toggle')).display !== 'none'"""
            )
            check("关闭后：收起态半圆小角恢复", bool(shown_closed), str(shown_closed))
            # 恢复默认后要能点把手回展开态（后续用例都在展开态跑）
            guard(page, "把手恢复后弹出", lambda: (page.click("spore-drawer >> #toggle"), page.wait_for_timeout(750)))
            check("收起态把手可点击弹出抽屉", s_cls(page, "#root") == "open", s_cls(page, "#root"))

            # ---------------- 会话列表：点击气泡弹出（悬停不再触发） ----------------
            box = page.locator("spore-drawer >> #sessions").bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=6)
            page.wait_for_timeout(400)
            print(f"  bubble box={box} hover class={s_cls(page, '#listpop')!r}", flush=True)
            check("悬停不再弹出会话列表", "on" not in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))

            guard(page, "click sessions", lambda: (page.click("spore-drawer >> #sessions"), page.wait_for_timeout(250)))
            check("点击 💬 弹出会话列表", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            rows = s_count(page, "#listpop .row")
            check("会话列表有 2 行", rows == 2, f"rows={rows}")
            # 会话自己的时间戳（日期+时间）以小字显示在行内标题下方
            ts1 = s_text(page, "#listpop .row:first-child .ts") or ""
            check(
                "列表行小字时间戳（日期+时间）",
                len(ts1) >= 11 and ts1[2:3] == "-" and ":" in ts1,
                repr(ts1),
            )

            # 删除要弹居中确认框，取消则不删
            page.hover("spore-drawer >> #listpop .row:first-child .x")
            page.click("spore-drawer >> #listpop .row:first-child .x")
            page.wait_for_timeout(400)
            box = page.evaluate(
                """async () => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const c = sr.querySelector('#confirm');
                    if (!c || !c.classList.contains('on')) return null;
                    const el = c.querySelector('.box');
                    // pop 入场动画从 translateY(-8px) 起跳：不等它跑完就读 getBoundingClientRect，
                    // 量到的是动画中间帧（实测 dy=8 恰好等于起跳位移），居中本身没问题
                    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).catch(() => {});
                    const r = el.getBoundingClientRect();
                    // 确认框是**抽屉的子组件**：要相对抽屉（侧边栏）居中，不是相对整屏
                    const root = sr.querySelector('#root').getBoundingClientRect();
                    const p = { x: root.x + root.width / 2, y: root.y + root.height / 2 };
                    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
                             panel: { x: Math.round(p.x), y: Math.round(p.y) },
                             dx: Math.abs(r.x + r.width / 2 - p.x),
                             dy: Math.abs(r.y + r.height / 2 - p.y),
                             inside: r.left >= root.left - 1 && r.right <= root.right + 1 };
                }"""
            )
            check("删除弹确认框", box is not None, str(box))
            if box:
                check(
                    "确认框相对侧边栏居中（抽屉子组件，偏差<3px）",
                    box["dx"] < 3 and box["dy"] < 3 and box["inside"],
                    str(box),
                )
            page.click("spore-drawer >> #confirmNo")
            page.wait_for_timeout(300)
            check("点取消不删（仍有 2 行）", s_count(page, "#listpop .row") == 2, s_count(page, "#listpop .row"))
            # 2026-09-29 用户要求：删除/重命名之后列表要留着，别一动就收
            check("取消删除后会话列表仍开着", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))

            # 重命名（改非当前会话）：同样不许收列表，且标题要立刻更新
            guard(
                page,
                "open rename",
                lambda: (
                    page.hover("spore-drawer >> #listpop .row:nth-child(2) .r"),
                    page.click("spore-drawer >> #listpop .row:nth-child(2) .r"),
                ),
            )
            page.wait_for_timeout(300)
            check("点 ✎ 弹重命名框", "on" in (s_cls(page, "#rename") or ""), s_cls(page, "#rename"))
            page.fill("spore-drawer >> #renameInput", "改名后的会话")
            page.click("spore-drawer >> #renameYes")
            page.wait_for_timeout(500)
            check(
                "保存后行标题更新",
                (s_text(page, "#listpop .row:nth-child(2) .t") or "") == "改名后的会话",
                s_text(page, "#listpop .row:nth-child(2) .t"),
            )
            check("重命名后会话列表仍开着", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            # 点击式气泡完整契约：点空白收起 → 再点气泡开 → 再点气泡关
            # 注意：点抽屉**之外**的页面空白会把抽屉本体也收起（既有行为），
            # 这里点抽屉内、列表外的空白，只收列表
            page.click("spore-drawer >> #title")
            page.wait_for_timeout(300)
            check("点击空白处收起会话列表", "on" not in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            page.click("spore-drawer >> #sessions")
            page.wait_for_timeout(250)
            check("再次点击气泡弹出列表", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            page.click("spore-drawer >> #sessions")
            page.wait_for_timeout(250)
            check("再次点击气泡收起列表", "on" not in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            page.mouse.move(600, 400)
            page.wait_for_timeout(400)
            unread = s_count(page, "#listpop .row.unread")
            print("unread rows:", unread, flush=True)
            page.screenshot(path=str(SHOTS / "07-sessionlist.png"))

            # ---------------- 收藏：顶栏 ⭐ + 列表置顶 ----------------
            def index_rows():
                if not sw:
                    return None
                got = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index']")
                return got if isinstance(got, list) else None

            def fav_of(sid):
                hit = [r for r in (index_rows() or []) if r.get("id") == sid]
                return bool(hit and hit[0].get("fav"))

            def first_row_sid():
                return page.evaluate(
                    """() => {
                        const r = document.querySelector('spore-drawer').shadowRoot.querySelector('#listpop .row');
                        return r ? r.dataset.sid : null;
                    }"""
                )

            # 当前会话只能从 DOM 拿：content script 在隔离世界，window.__sporeDrawer 对 page.evaluate 不可见
            def active_sid():
                return page.evaluate(
                    """() => {
                        const r = document.querySelector('spore-drawer').shadowRoot.querySelector('#listpop .row.active');
                        return r ? r.dataset.sid : null;
                    }"""
                )

            def fav_color():
                return page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        return getComputedStyle(sr.querySelector('#fav')).color;
                    }"""
                )

            def row_star_color(n):
                return page.evaluate(
                    """(n) => {
                        const rows = document.querySelector('spore-drawer').shadowRoot.querySelectorAll('#listpop .row');
                        const el = rows[n - 1] && rows[n - 1].querySelector('.f');
                        return el ? getComputedStyle(el).color : null;
                    }""",
                    n,
                )

            def toast_title():
                # 提示可叠多条（回答完毕那条可能还在），取最新那条
                return page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const ts = sr.querySelectorAll('#toasts .toast .tt');
                        return ts.length ? ts[ts.length - 1].textContent : null;
                    }"""
                )

            # 星色必须自己给（⭐ emoji 的颜色由系统字体决定，实测有用户点了变黑）：
            # 收藏态静息 #ec4899、hover 深一档 #db2777 —— 点完鼠标还停在按钮上，量到的是 hover 色
            PINKS = ("rgb(236, 72, 153)", "rgb(219, 39, 119)")
            check("顶栏有 ★ 收藏按钮", s_count(page, "#fav") == 1, s_count(page, "#fav"))
            sid_now = active_sid()
            first_before = first_row_sid()
            page.click("spore-drawer >> #fav")
            page.wait_for_timeout(400)
            check("点 ★ 收藏当前会话（写进索引）", fav_of(sid_now), f"sid={sid_now}")
            check("★ 按钮进入收藏态", "on" in (s_cls(page, "#fav") or ""), s_cls(page, "#fav"))
            check("收藏态星标是品牌粉", fav_color() in PINKS, fav_color())
            check("收藏后有反馈提示", toast_title() == "已收藏", toast_title())
            check(
                "收藏只标记不置顶：列表顺序不变",
                first_row_sid() == first_before,
                f"{first_row_sid()} vs {first_before}",
            )
            check(
                "收藏中的会话在列表行亮星标",
                "fav" in (s_cls(page, "#listpop .row.active") or ""),
                s_cls(page, "#listpop .row.active"),
            )
            # 再点一次取消收藏（后面靠「只有一个收藏」来验证筛选语义）
            page.click("spore-drawer >> #fav")
            page.wait_for_timeout(400)
            check("再点 ★ 取消收藏", not fav_of(sid_now), f"sid={sid_now}")
            check("★ 按钮退回未收藏态", "on" not in (s_cls(page, "#fav") or ""), s_cls(page, "#fav"))
            check("未收藏态星标不是粉色", fav_color() not in PINKS, fav_color())
            check("取消收藏也有提示", toast_title() == "已取消收藏", toast_title())

            # 打开列表点另一行的星标：只切收藏，不许顺手打开会话（收藏不置顶，顺序不该动）
            guard(
                page,
                "open list for star",
                lambda: (page.click("spore-drawer >> #sessions"), page.wait_for_timeout(300)),
            )
            other = page.evaluate(
                """() => {
                    const rows = [...document.querySelector('spore-drawer').shadowRoot.querySelectorAll('#listpop .row')];
                    return rows[1] ? rows[1].dataset.sid : null;
                }"""
            )
            page.click("spore-drawer >> #listpop .row:nth-child(2) .f")
            page.wait_for_timeout(400)
            sid_after = active_sid()
            check("点行内星标不切换会话（stopPropagation）", sid_after == sid_now, f"{sid_after} vs {sid_now}")
            check("行内星标同样写进索引", fav_of(other), f"other={other}")
            check("行内收藏星标也是品牌粉", row_star_color(2) in PINKS, row_star_color(2))
            check(
                "收藏不置顶：第二行留在原位",
                first_row_sid() == first_before,
                f"first={first_row_sid()} expected={first_before}",
            )

            # 开着列表点 ⭐：列表要留着（正要看行重排），当前会话收藏/取消来回切
            page.click("spore-drawer >> #fav")
            page.wait_for_timeout(400)
            check("开着列表点 ⭐ 不收起列表", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            check("开着列表也能收藏当前会话", fav_of(sid_now), f"sid={sid_now}")
            page.screenshot(path=str(SHOTS / "07c-favorite-list.png"))  # 列表开着 + 收藏态的现场取证
            page.click("spore-drawer >> #fav")
            page.wait_for_timeout(400)
            check("开着列表点 ⭐ 依旧不收起列表", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            check(
                "取消收藏后该行不再亮星标",
                "fav" not in (s_cls(page, "#listpop .row.active") or ""),
                s_cls(page, "#listpop .row.active"),
            )
            check(
                "收藏标记仍在（顺序照旧、不置顶）",
                fav_of(other) and first_row_sid() == first_before,
                f"first={first_row_sid()} fav_other={fav_of(other)}",
            )
            # 收尾把列表关掉，与既有用例进入追问时的状态对齐
            page.click("spore-drawer >> #sessions")
            page.wait_for_timeout(250)
            check("收藏用例收尾：列表已收起", "on" not in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            page.screenshot(path=str(SHOTS / "07b-favorite.png"))

            # ---------------- 会话内追问 ----------------
            # 残留清理与通知基线必须在**提交之前**做：回合可能在我们操作前就结束，
            # 事后清理会把新 toast 也删掉、基线会漏掉新通知
            page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    sr.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
                }"""
            )
            notif_before = set()
            if sw:
                try:
                    notif_before = set(
                        sw.evaluate("async () => Object.keys(await chrome.notifications.getAll())")
                    )
                except Exception:
                    notif_before = set()

            guard(
                page,
                "followup",
                lambda: (
                    page.click("spore-drawer >> #sessions"),
                    page.fill("spore-drawer >> #input", "用一句话说明你为什么这么答"),
                    page.keyboard.press("Enter"),
                    # 提交后立刻收起：settleTurn 必须晚于收起。回合先结束时「开着看」
                    # seen=true，按设计吞掉红点/通知 —— 这曾是竞态红（模型答得快就翻车）
                    page.click("spore-drawer >> #toggle"),
                    page.wait_for_timeout(1200),
                ),
            )
            page.screenshot(path=str(SHOTS / "08-followup.png"))
            guard(
                page,
                "追问消息落进抽屉",
                lambda: page.wait_for_function(
                    """() => {
                        const h = document.querySelector('spore-drawer');
                        return !!(h && h.shadowRoot && h.shadowRoot.querySelectorAll('#stream .msg').length >= 4);
                    }""",
                    timeout=90000,
                    polling=500,
                ),
            )
            check("追问产生新消息", s_count(page, "#stream .msg") >= 4, f"msgs={s_count(page, '#stream .msg')}")

            # ---------------- 收起抽屉：toast 是与抽屉同级的组件，照弹 ----------------
            # 清理/基线/收起点击都已挪到 followup 前后（竞态修复），这里只校验状态
            check("抽屉已收起（回合进行中）", s_cls(page, "#root") != "open", s_cls(page, "#root"))

            page.wait_for_function(
                """() => {
                    const h = document.querySelector('spore-drawer');
                    return !!(h && h.shadowRoot && h.shadowRoot.querySelector('#toasts .toast.on'));
                }""",
                timeout=90000,
                polling=500,
            )
            page.wait_for_timeout(600)  # 等 .36s 飞入动画停稳
            toast = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const t = sr.querySelector('#toasts .toast');
                    if (!t) return null;
                    const r = t.getBoundingClientRect();
                    return { x: Math.round(r.x), y: Math.round(r.y),
                             rightGap: Math.round(innerWidth - r.right),
                             inView: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth + 1,
                             text: (t.textContent || '').slice(0, 40) };
                }"""
            )
            check(
                "抽屉收起时照弹 toast（右下角、在视口内）",
                bool(toast) and toast["inView"] and toast["rightGap"] <= 40,
                str(toast),
            )

            # 收起 = 没在看 → 必须落红点 + 发系统通知
            unread = False
            if sw:
                idx = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index']")
                rows = idx if isinstance(idx, list) else (idx or {}).get("sessions", [])
                unread = any(bool(r.get("unread")) for r in rows)
            check("收起时该回合被打上红点（=未查看）", unread, f"unread={unread}")

            if sw:
                try:
                    notif_after = set(
                        sw.evaluate("async () => Object.keys(await chrome.notifications.getAll())")
                    )
                    new_notifs = notif_after - notif_before
                    check("收起时发出系统通知", len(new_notifs) >= 1, str(sorted(new_notifs))[:160])
                except Exception as e:
                    check("收起时发出系统通知", False, f"notifications API: {e}")

            page.click("spore-drawer >> #toggle")  # 展开回来，后面还要点开列表
            page.wait_for_timeout(400)
            check("再点 ‹ 能展开回来", s_cls(page, "#root") == "open", s_cls(page, "#root"))
            # 追问回合收尾 + 回答出文本（改/加断言理由：本流程原来几处 wait 是裸的，环境一抖动——模型
            # 402、检索连续空导致回合拖长——就把整条门禁崩成 exit 2 且不留现场；口径不变，改成 repo 统一
            # 的 guard + wait_idle 耐心值，失败时照常 check FAIL + 落盘截图）
            guard(page, "追问回合收尾", lambda: wait_idle(page, 180000))
            guard(
                page,
                "追问回答出文本",
                lambda: page.wait_for_function(
                    """() => {
                        const h = document.querySelector('spore-drawer');
                        const m = h && h.shadowRoot && [...h.shadowRoot.querySelectorAll('#stream .chat')].pop();
                        return !!(m && m.textContent.trim().length > 3);
                    }""",
                    timeout=180000,
                    polling=500,
                ),
            )
            think_texts = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    return [...sr.querySelectorAll('#stream .think')]
                        .filter(t => t.classList.contains('on'))
                        .map(t => t.querySelector('.think-b').textContent.trim().slice(0, 120));
                }"""
            )
            check("CoT 思考块可见（有内容且未折叠）", any(t for t in think_texts), str(think_texts)[:180])
            page.wait_for_timeout(1200)
            unfolded = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    return sr.querySelectorAll('#stream .think.on:not(.fold)').length;
                }"""
            )
            check("思考完毕后自动收起（正文出现即折叠）", unfolded == 0, f"unfolded={unfolded}")
            reply = s_text(page, "#stream .chat:last-of-type") or ""
            print("  追问回答:", reply[:300], flush=True)
            check(
                "追问回答不是思考草稿（无 CoT 泄漏、有中文）",
                not __import__("re").match(r"\s*(We|I|Need|Let me|Okay|First)", reply)
                and any("\u4e00" <= c <= "\u9fff" for c in reply),
                reply[:80],
            )

            # ---------------- 追问随时可调检索工具（不只 <<ok>> 触发器；2026-10-01 用户反馈） ----------------
            # 第一条追问是纯聊天（不调工具）；这条点名「先检索再答」，必须真的进工具循环。
            # chip 在 dispatch 之前推出 → 断言不依赖当天引擎可达；日志行是我们自己打的，恒成立。
            guard(
                page,
                "followup-search",
                lambda: (
                    # 第一条追问若还在流式收尾，输入框是禁用的：先等它恢复再填
                    page.wait_for_function(
                        """() => {
                            const h = document.querySelector('spore-drawer');
                            const i = h && h.shadowRoot && h.shadowRoot.querySelector('#input');
                            return !!(i && !i.disabled);
                        }""",
                        timeout=60000,
                        polling=300,
                    ),
                    page.fill("spore-drawer >> #input", "再查一下：vLLM 是什么？先调用 web_search 检索，再用一句话回答"),
                    page.keyboard.press("Enter"),
                    page.wait_for_timeout(800),
                ),
            )
            guard(
                page,
                "追问检索回合收尾",
                lambda: page.wait_for_function(
                    """() => {
                        const h = document.querySelector('spore-drawer');
                        const sr = h && h.shadowRoot;
                        const input = sr && sr.querySelector('#input');
                        const chats = sr ? [...sr.querySelectorAll('#stream .chat')] : [];
                        return !!(input && !input.disabled && chats.length && chats[chats.length - 1].textContent.trim().length > 3);
                    }""",
                    timeout=180000,
                    polling=500,
                ),
            )
            if sw:
                slogs2 = sw.evaluate("async () => (await chrome.storage.local.get('spore.log'))['spore.log'] || []")
                check(
                    "追问走了工具循环（日志 chat tool loop start）",
                    any("chat tool loop start" in l for l in slogs2),
                    str([l for l in slogs2 if "chat tool loop" in l][:1]),
                )
            search_tools = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const last = [...sr.querySelectorAll('#stream .msg.bot')].pop();
                    return last ? last.querySelectorAll('.tool').length : 0;
                }"""
            )
            check("追问里模型真的调了检索（新 chat 行出现工具 chip）", search_tools >= 1, f"tools={search_tools}")
            reply2 = (
                page.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const chats = [...sr.querySelectorAll('#stream .chat')];
                        const el = chats[chats.length - 1];
                        return el ? el.textContent.trim() : '';
                    }"""
                )
                or ""
            )  # 取最后一条：querySelector 会命中第一个 chat（第一条追问），那不是这条检索的回答
            print("  检索追问回答:", reply2[:300], flush=True)
            check(
                "检索追问给出中文回答且没推说查不了",
                any("\u4e00" <= c <= "\u9fff" for c in reply2)
                and not any(w in reply2 for w in ("查不了", "无法联网", "没有联网", "不能联网")),
                reply2[:100],
            )

            # ---------------- 通知锚点：屏幕右下角 ----------------
            toast_right = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    return getComputedStyle(sr.querySelector('#toasts')).right;
                }"""
            )
            check("通知容器锚在屏幕右缘（right=24px）", toast_right == "24px", toast_right)

            # ---------------- 存储与磁盘镜像 ----------------
            if sw:
                try:
                    idx = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index']")
                    check("存储里有 2 个会话", idx and len(idx) == 2, str([e.get('title') for e in (idx or [])]))
                    print("index:", idx, flush=True)
                    stuck = [e for e in (idx or []) if str(e.get('title', '')).startswith('解析中')]
                    check("没有会话停在占位标题「解析中…」", not stuck, str(stuck))
                    bad = [e for e in (idx or []) if e.get('status') in ("error", "interrupted")]
                    check("没有会话停在 error/interrupted", not bad, str(bad))
                    for e in idx or []:
                        sess = sw.evaluate(
                            "async (id) => (await chrome.storage.local.get('spore.sess.' + id))['spore.sess.' + id]",
                            e["id"],
                        )
                        print(
                            f"    sess {e['id']} msgs={len(sess['messages'])} status={sess.get('status')} "
                            f"err={sess.get('errorMsg')!r} title={sess.get('title')!r}",
                            flush=True,
                        )
                    # 截图拆键契约：图片单独成键、只写一次，会话对象里只留引用
                    # （改动理由：混在消息体里会被每次 saveSession 整份重写，实测 2~3× 写放大）
                    img_keys = sw.evaluate(
                        "async () => Object.keys(await chrome.storage.local.get(null))"
                        ".filter(k => k.startsWith('spore.img.'))"
                    )
                    check("截图拆成独立存储键", len(img_keys) >= 1, str(img_keys))
                    inlined = [
                        e["id"]
                        for e in idx or []
                        if "data:image"
                        in sw.evaluate(
                            "async (id) => JSON.stringify(await chrome.storage.local.get('spore.sess.' + id))",
                            e["id"],
                        )
                    ]
                    check("会话对象里不再内嵌 base64 图片", not inlined, str(inlined))

                    # 老会话迁移：注入一条旧格式（内嵌 data URL）→ 跑启动 sweep 的迁移 →
                    # 必须拆键、按 key 取回同一张图；跑完把注入的会话与索引撤干净，别污染后续断言
                    mig = sw.evaluate(
                        """async () => {
                            const K = 'spore.sess.19990101-000000';
                            const fake = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
                            const idx = ((await chrome.storage.local.get('spore.index'))['spore.index'] || []).slice();
                            const sess = { id: '19990101-000000', title: '迁移自测', created: Date.now(),
                                           updated: Date.now(), status: 'idle', unread: false,
                                           messages: [{ role: 'user', ts: Date.now(), image: fake, text: 'legacy' }] };
                            await chrome.storage.local.set({
                                [K]: sess,
                                'spore.index': [...idx, { id: sess.id, title: sess.title, created: sess.created,
                                                          updated: sess.updated, count: 1, status: 'idle', unread: false }],
                            });
                            await globalThis.__spore.store.migrateImageKeys();
                            const after = (await chrome.storage.local.get(K))[K];
                            const m = after && after.messages[0];
                            const key = (m && m.imageKey) || null;
                            const back = key ? (await chrome.storage.local.get(key))[key] : null;
                            await chrome.storage.local.remove([K, ...(key ? [key] : [])]);
                            await chrome.storage.local.set({ 'spore.index': idx });
                            return { inline: !!(m && m.image), key, ok: back === fake };
                        }"""
                    )
                    check("老会话迁移：data URL 移出消息体", mig and not mig["inline"], str(mig))
                    check("老会话迁移：按 key 能取回同一张图", mig and mig["ok"], str(mig))
                    print("---- spore.log ----", flush=True)
                    for line in (sw.evaluate("async () => (await chrome.storage.local.get('spore.log'))['spore.log']") or [])[-40:]:
                        print("   ", line, flush=True)
                except Exception as e:
                    check("读取 storage", False, str(e))

            if sw:
                # 默认 mirrorDownloads=true：没选静默目录时回落到下载（默认位置 Downloads）
                dls = sw.evaluate(
                    """async () => {
                        const all = await chrome.downloads.search({limit: 100, orderBy: ['-startTime']});
                        return all.map(d => ({ state: d.state, err: d.error,
                                                kind: String(d.url).startsWith('data:image') ? 'jpg'
                                                    : String(d.url).startsWith('data:text/markdown') ? 'md' : 'other' }));
                    }"""
                )
                md = [d for d in dls if d["kind"] == "md"]
                jpg = [d for d in dls if d["kind"] == "jpg"]
                check(
                    "默认回落下载：镜像 md+截图都已落盘",
                    len(md) >= 3 and len(jpg) >= 2,
                    f"md={len(md)} jpg={len(jpg)}",
                )

                # 静默写盘机制本身（FSA/OPFS 在 service worker 里能不能 createWritable）
                fsa = sw.evaluate(
                    """async () => {
                        if (!self.navigator?.storage?.getDirectory) return 'no-opfs';
                        try {
                            const root = await navigator.storage.getDirectory();
                            const dir = await root.getDirectoryHandle('spore-probe', {create: true});
                            const f = await dir.getFileHandle('probe.txt', {create: true});
                            const w = await f.createWritable();
                            await w.write('spore silent write probe' + String.fromCharCode(10));
                            await w.close();
                            return 'writable';
                        } catch (e) { return 'error: ' + (e && e.message || e); }
                    }"""
                )
                check("service worker 里可静默写文件（FSA 通道可用）", fsa == "writable", fsa)

            page.screenshot(path=str(SHOTS / "09-final.png"))

            # ---------------- 点抽屉之外收起 ----------------
            page.mouse.click(300, 500)
            page.wait_for_timeout(700)
            check("点抽屉之外收起抽屉", s_cls(page, "#root") != "open", s_cls(page, "#root"))
            page.click("spore-drawer >> #toggle")
            page.wait_for_timeout(700)
            check("再点 ‹ 能弹回", s_cls(page, "#root") == "open", s_cls(page, "#root"))

            # ---------------- ⚙ 设置按钮 ----------------
            try:
                with ctx.expect_page(timeout=6000) as info:
                    page.click("spore-drawer >> #gear")
                opt = info.value
                # expect_page 在导航前就返回（此时 url 还是 about:blank），要等加载完
                opt.wait_for_load_state("load", timeout=8000)
                ok_url = "options.html" in (opt.url or "")
                check("点 ⚙ 打开设置页", ok_url, opt.url)
                # 设置页自身也要没报错
                errs = []
                opt.on("pageerror", lambda e: errs.append(str(e)))
                opt.wait_for_timeout(600)
                check("设置页无 JS 报错", not errs, str(errs)[:160])

                # 分页：左边索引，右边一次只显示一页
                for name in ("model", "mirror", "keys", "capture", "log"):
                    opt.click(f'.idx a[data-sec="{name}"]')
                    opt.wait_for_timeout(120)
                    vis = opt.evaluate(
                        """() => [...document.querySelectorAll('.card[data-sec]')]
                              .filter((el) => !el.hidden)
                              .map((el) => el.dataset.sec)"""
                    )
                    check(f"分页索引「{name}」只显示该页", vis == [name], str(vis))

                opt.click('.idx a[data-sec="mirror"]')
                opt.wait_for_timeout(150)
                # 镜像是统一模块：总开关关掉时，子设置整组隐藏
                st = opt.evaluate(
                    """() => {
                        const body = document.getElementById('mirrorBody');
                        const master = document.getElementById('mirror');
                        if (!body || !master) return { missing: true };
                        master.checked = false;
                        master.dispatchEvent(new Event('change'));
                        const offHidden = body.hidden;
                        master.checked = true;
                        master.dispatchEvent(new Event('change'));
                        return { offHidden, onShown: !body.hidden };
                    }"""
                )
                check(
                    "镜像子设置随总开关显隐（关=整组隐藏）",
                    bool(st) and not st.get("missing") and st.get("offHidden") and st.get("onShown"),
                    str(st),
                )
                opt.click('.idx a[data-sec="model"]')
                opt.wait_for_timeout(250)
                av = opt.evaluate("() => document.getElementById('autoVerify').checked")
                check("设置页「自动核实」关掉了（与存储一致）", av is False, f"checked={av}")
                opt.check("#autoVerify")
                # 已改自动保存：没有保存按钮，改完等防抖（600ms）+ 落盘即可
                opt.wait_for_timeout(1400)
                saved = sw.evaluate(
                    """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).autoVerify"""
                )
                check("改完自动保存（防抖后写回存储）", saved is True, repr(saved))

                # 「检索代理」决定引擎链（改/加断言理由：设置→定序是新契约；Fungi 靠注册表代理做同一判断）
                plan0 = sw.evaluate("async () => globalThis.__spore.searchPlan()")
                check("未配代理 → 引擎链只走 bing", plan0.get("plan") == ["bing"], str(plan0))
                opt.fill("#proxy", "127.0.0.1:7897")
                opt.wait_for_timeout(1400)
                saved_proxy = sw.evaluate(
                    """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).proxy"""
                )
                check("「检索代理」经 UI 写回存储", saved_proxy == "127.0.0.1:7897", repr(saved_proxy))
                plan1 = sw.evaluate("async () => globalThis.__spore.searchPlan()")
                check(
                    "配了代理 → 引擎链变 ddg→bing→brave",
                    plan1.get("plan") == ["duckduckgo", "bing", "brave"],
                    str(plan1),
                )
                opt.fill("#proxy", "")
                opt.wait_for_timeout(1400)
                plan2 = sw.evaluate("async () => globalThis.__spore.searchPlan()")
                check("清空代理 → 回到只走 bing", plan2.get("plan") == ["bing"], str(plan2))

                # 隐藏小角必须**经设置页 UI** 能写回存储（曾漏进 save() 的手写 patch，勾了不落盘）
                opt.click('.idx a[data-sec="keys"]')
                opt.wait_for_timeout(250)
                opt.check("#hideToggle")
                opt.wait_for_timeout(1400)
                saved_hide = sw.evaluate(
                    """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).hideToggle"""
                )
                check("勾「隐藏半圆小角」写回存储", saved_hide is True, repr(saved_hide))
                opt.uncheck("#hideToggle")
                opt.wait_for_timeout(1400)
                restored_hide = sw.evaluate(
                    """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).hideToggle"""
                )
                check("取消勾选恢复默认（关）", restored_hide is False, repr(restored_hide))

                # AI 建议框：默认关 → 经设置页勾上写回存储 → 取消恢复（与 hideToggle 同一条链）
                # 开关在 .switch 标签里（input 隐藏）→ 点标签本体，走用户真实路径。
                # 整段自带 try：失败记成自己的 FAIL，不外逸到外层 except（那会吞掉语义、
                # 连带把后面没赋值的 review_base 带崩成 exit=2）
                try:
                    ml_default = sw.evaluate(
                        """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).mlSuggest"""
                    )
                    check("AI 建议框默认关闭（键缺失 = 关）", ml_default in (None, False), repr(ml_default))
                    opt.click('.idx a[data-sec="capture"]')
                    opt.wait_for_timeout(250)
                    opt.click('.card[data-sec="capture"] label.switch')
                    opt.wait_for_timeout(1400)
                    saved_ml = sw.evaluate(
                        """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).mlSuggest"""
                    )
                    check("勾「AI 建议框」写回存储", saved_ml is True, repr(saved_ml))
                    opt.click('.card[data-sec="capture"] label.switch')
                    opt.wait_for_timeout(1400)
                    restored_ml = sw.evaluate(
                        """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).mlSuggest"""
                    )
                    check("取消勾选 AI 建议框恢复默认（关）", restored_ml is False, repr(restored_ml))
                except Exception as e:  # noqa: BLE001
                    check("AI 建议框设置页开合", False, f"{type(e).__name__}: {e}")

                opt.click('.idx a[data-sec="log"]')
                opt.wait_for_timeout(700)
                logs = opt.evaluate(
                    """async () => (await chrome.storage.local.get('spore.log'))['spore.log'] || []"""
                )
                check("日志环有内容", len(logs) > 0, f"{len(logs)} 条")
                key = [l for l in logs if ("startTurn" in l or "kickNaming" in l or "ensureNamed" in l)]
                check("日志覆盖起名/回合链路", len(key) >= 2, str(key[:2])[:200])
                # 阶段A 协议应顺带吐 TITLE 行（模型失效才回退答案前 14 字）
                named = [l for l in logs if "kickNaming start" in l]
                got_gist = any('title="' in l and 'title=""' not in l for l in named)
                check("阶段A 顺带吐了题目大意（TITLE 行）", got_gist, str(named[:2])[:200])
                shown = opt.eval_on_selector("#logList", "el => el.textContent")
                check(
                    "设置页日志卡已渲染",
                    shown and "（还没有日志）" not in shown and len(shown) > 20,
                    shown[:70],
                )

                # ---------------- 索引第一项「搜题记录」= 直通整页（不做右侧分页） ----------------
                first_link = opt.evaluate("() => (document.querySelector('.idx a') || {}).textContent || ''")
                check("索引第一项是搜题记录", first_link.strip().startswith("搜题记录"), first_link)
                gap_h = opt.evaluate("() => (document.querySelector('.idx .gap') || {}).offsetHeight || 0")
                grp = opt.evaluate("() => (document.querySelector('.idx .grp') || {}).textContent || ''")
                check(
                    "搜题记录与下面四张卡之间留了间距、且归在「应用设置」分组下",
                    gap_h >= 10 and grp.strip() == "应用设置",
                    f"gap={gap_h} grp={grp!r}",
                )
                no_right = opt.evaluate("() => document.querySelector('main .card:not([data-sec])') === null")
                check("设置页右侧没有搜题记录分页（点了直接跳）", no_right, str(no_right))

                cur_sid = page.evaluate(
                    """() => {
                        const r = document.querySelector('spore-drawer').shadowRoot.querySelector('#listpop .row.active');
                        return r ? r.dataset.sid : null;
                    }"""
                )
                with ctx.expect_page(timeout=8000) as rinfo:
                    opt.click('.idx a[data-jump="history"]')
                rev = rinfo.value
                rev.wait_for_load_state("load", timeout=8000)
                check("点「整页打开」进整页审查", "review.html" in (rev.url or ""), rev.url)
                rerrs = []
                rev.on("pageerror", lambda e: rerrs.append(str(e)))
                rev.wait_for_timeout(700)
                check("整页审查无 JS 报错", not rerrs, str(rerrs)[:160])

                n_all = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("整页：左侧列出全部会话", n_all == 2, n_all)
                rev_active = rev.evaluate(
                    "() => (document.querySelector('#list .row.active') || {}).dataset?.sid || null"
                )
                check("整页：默认打开当前会话", rev_active == cur_sid, f"{rev_active} vs {cur_sid}")
                hist = rev.evaluate("() => (document.querySelector('#history .ans') || {}).textContent || ''")
                check("整页：右侧渲染出作答历史", len(hist) > 0, hist[:60])
                # 整页里的截图同样禁用点击（同一条决定）
                pages_rev = len(ctx.pages)
                rev.click("#history .msg.user img.shot")
                rev.wait_for_timeout(500)
                check("整页里点截图也不开新页", len(ctx.pages) == pages_rev, f"{pages_rev} -> {len(ctx.pages)}")

                rev.click('.seg-b[data-filter="fav"]')
                rev.wait_for_timeout(250)
                n_fav = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("整页：只看收藏（筛选生效）", n_fav == 1, n_fav)
                rev.click('.seg-b[data-filter="all"]')
                rev.wait_for_timeout(250)
                n_all2 = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("整页：切回全部", n_all2 == 2, n_all2)

                # 收放按钮：箭头跟动作方向（展开态点了往左收 = <，收起态点了往右拉 = >）
                arrow0 = rev.evaluate("() => document.getElementById('collapse').textContent")
                check("展开时收放按钮是 <", arrow0 == "<", repr(arrow0))
                w1 = rev.evaluate("() => Math.round(document.querySelector('#main').getBoundingClientRect().width)")
                rev.click("#collapse")
                rev.wait_for_timeout(700)
                w2 = rev.evaluate("() => Math.round(document.querySelector('#main').getBoundingClientRect().width)")
                arrow1 = rev.evaluate("() => document.getElementById('collapse').textContent")
                check("列表收起 → 会话界面自动变宽", w2 > w1 + 200, f"{w1} -> {w2}")
                check("收起后收放按钮是 >", arrow1 == ">", repr(arrow1))
                rev.click("#collapse")
                rev.wait_for_timeout(700)

                def rev_toast():
                    # 提示可叠多条，取最新那条（同抽屉的 toast_title 口径）
                    return rev.evaluate(
                        """() => {
                            const ts = document.querySelectorAll('#toasts .toast .tt');
                            return ts.length ? ts[ts.length - 1].textContent : null;
                        }"""
                    )

                rev.click("#rFav")
                rev.wait_for_timeout(400)
                check("整页 ★ 收藏当前会话", fav_of(cur_sid) is True, f"sid={cur_sid}")
                check("整页 ★ 收藏弹提示", rev_toast() == "已收藏", rev_toast())
                rev.click("#rFav")
                rev.wait_for_timeout(400)
                check("整页 ★ 再点取消收藏", fav_of(cur_sid) is False, f"sid={cur_sid}")
                check("整页 ★ 取消弹提示", rev_toast() == "已取消收藏", rev_toast())

                # 列表行 ★（第二处收藏入口）也要弹提示；点两次恢复原状，不污染后续用例
                rev.hover("#list .row.active")
                rev.click("#list .row.active .f")
                rev.wait_for_timeout(400)
                check("整页行内 ★ 收藏生效", fav_of(cur_sid) is True, f"sid={cur_sid}")
                check("整页行内 ★ 收藏弹提示", rev_toast() == "已收藏", rev_toast())
                rev.hover("#list .row.active")
                rev.click("#list .row.active .f")
                rev.wait_for_timeout(400)
                check("整页行内 ★ 再点取消收藏", fav_of(cur_sid) is False, f"sid={cur_sid}")
                check("整页行内 ★ 取消弹提示", rev_toast() == "已取消收藏", rev_toast())

                other_id = sw.evaluate(
                    "async () => ((await chrome.storage.local.get('spore.index'))['spore.index'])[1].id"
                )
                # ---- 行内 ✎ 重命名（从抽屉复制进整页的交互） ----
                rev.hover("#list .row:nth-child(2)")
                rev.click("#list .row:nth-child(2) .r")
                rev.wait_for_timeout(300)
                check(
                    "整页点 ✎ 弹重命名框",
                    rev.evaluate("() => document.getElementById('rename').classList.contains('on')"),
                    "rename modal",
                )
                rev.fill("#renameInput", "整页改名")
                rev.click("#renameYes")
                rev.wait_for_timeout(500)
                t2 = rev.evaluate("() => (document.querySelector('#list .row:nth-child(2) .t') || {}).textContent || ''")
                check("整页重命名生效（列表行同步）", t2 == "整页改名", t2)

                # ---- 科目（目录形态）：新建 → 空科目弹（空）→ 拖会话进科目 → 拖出 → 删科目 ----
                rev.click("#newSub")
                rev.wait_for_timeout(300)
                check(
                    "整页点「新建科目」弹命名框",
                    rev.evaluate("() => document.getElementById('subnew').classList.contains('on')"),
                    "subnew modal",
                )
                rev.fill("#subInput", "高数")
                rev.click("#subYes")
                rev.wait_for_timeout(600)
                n_sub = rev.evaluate("() => document.querySelectorAll('#list .sub').length")
                sub_name = rev.evaluate("() => (document.querySelector('#list .sub .sn') || {}).textContent || ''")
                check("命名后列表置顶出现科目行", n_sub == 1 and sub_name == "高数", f"n={n_sub} name={sub_name!r}")
                subs_db = sw.evaluate(
                    "async () => (await chrome.storage.local.get('spore.subjects'))['spore.subjects'] || []"
                )
                check("科目写进存储", len(subs_db) == 1 and subs_db[0].get("name") == "高数", subs_db)
                check(
                    "科目排在会话行之前",
                    rev.evaluate(
                        "() => !!document.querySelector('#list').firstElementChild.classList.contains('sub')"
                    ),
                    "first child is folder",
                )

                # 空科目：点一下弹出（空），再点收回，第三次展开准备接拖放
                rev.click("#list .sub")
                rev.wait_for_timeout(300)
                sub_empty = rev.evaluate("() => (document.querySelector('#list .subempty') || {}).textContent || ''")
                check("空科目展开显示（空）", "（空）" in sub_empty, sub_empty)
                rows_in_sub = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("科目展开不吞会话行", rows_in_sub == 2, rows_in_sub)
                rev.click("#list .sub")
                rev.wait_for_timeout(300)
                check(
                    "再点科目收回",
                    not rev.evaluate("() => document.querySelector('#list .sub').classList.contains('open')"),
                    "collapsed",
                )
                rev.click("#list .sub")
                rev.wait_for_timeout(300)

                # 拖放（Playwright 走 CDP 真拖，dataTransfer 是真的）：第一条会话拖到科目行上
                rev.drag_and_drop("#list .row >> nth=0", "#list .sub")
                rev.wait_for_timeout(700)
                in_n = rev.evaluate("() => document.querySelectorAll('#list .row.in').length")
                total_n = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("拖进科目：会话归入目录且列表总数不变", in_n == 1 and total_n == 2, f"in={in_n} total={total_n}")
                sub_owned = sw.evaluate(
                    "async () => { const i = (await chrome.storage.local.get('spore.index'))['spore.index'] || [];"
                    " return i.filter(e => e.sub).length }"
                )
                check("拖进科目：归属落进索引", sub_owned == 1, sub_owned)
                cnt = rev.evaluate("() => (document.querySelector('#list .sub .cn') || {}).textContent || ''")
                check("科目行标出会话数", cnt == "1", cnt)

                # ---- 科目重命名：同一个模态，标题口径换成科目 ----
                rev.hover("#list .sub")
                rev.click("#list .sub .sr")
                rev.wait_for_timeout(300)
                check(
                    "点科目 ✎ 弹重命名框且口径是科目",
                    rev.evaluate("() => document.getElementById('rename').classList.contains('on')")
                    and "科目" in rev.evaluate("() => (document.getElementById('renameTitle') || {}).textContent || ''"),
                    rev.evaluate("() => (document.getElementById('renameTitle') || {}).textContent || ''"),
                )
                rev.fill("#renameInput", "高等数学")
                rev.click("#renameYes")
                rev.wait_for_timeout(500)
                sub_renamed = rev.evaluate("() => (document.querySelector('#list .sub .sn') || {}).textContent || ''")
                check("科目重命名生效（列表行同步）", sub_renamed == "高等数学", sub_renamed)
                subs_db2 = sw.evaluate(
                    "async () => (await chrome.storage.local.get('spore.subjects'))['spore.subjects'] || []"
                )
                check("科目重命名落存储", len(subs_db2) == 1 and subs_db2[0].get("name") == "高等数学", subs_db2)
                still_in = rev.evaluate("() => document.querySelectorAll('#list .row.in').length")
                check("重命名不动成员归属", still_in == 1, still_in)

                # 拖到科目外面的会话行 = 移出科目（空白区没有独立元素，落点用同级行判定）
                rev.drag_and_drop("#list .row.in", "#list .row:not(.in)")
                rev.wait_for_timeout(700)
                in_back = rev.evaluate("() => document.querySelectorAll('#list .row.in').length")
                check("拖到科目外 = 移出科目", in_back == 0, in_back)

                # 删科目：只摘目录，会话一条不删（回到跑本段之前的平铺状态）
                rev.hover("#list .sub")
                rev.click("#list .sub .sx")
                rev.wait_for_timeout(300)
                ctitle = rev.evaluate("() => (document.getElementById('confirmTitle') || {}).textContent || ''")
                check("点科目 × 弹删除确认且口径是科目", "科目" in ctitle, ctitle)
                rev.click("#confirmYes")
                rev.wait_for_timeout(600)
                left_subs = rev.evaluate("() => document.querySelectorAll('#list .sub').length")
                left_rows = rev.evaluate("() => document.querySelectorAll('#list .row').length")
                check("删科目后目录消失、会话原样留下", left_subs == 0 and left_rows == 2, f"subs={left_subs} rows={left_rows}")
                rev.screenshot(path=str(SHOTS / "12-review-subjects.png"))

                # ---- 涂抹多选（照移动端 record.js 移植）：全段离线确定性断言，不依赖模型 ----
                def ms_rows():
                    return rev.evaluate(
                        "() => [...document.querySelectorAll('#list .row')].map(r => ({ on: r.classList.contains('on'),"
                        " sid: r.dataset.sid, fav: r.classList.contains('fav') }))"
                    )

                def ms_sel():
                    return rev.evaluate("() => document.getElementById('list').classList.contains('sel')")

                def ms_active():
                    return rev.evaluate(
                        "() => (document.querySelector('#list .row.active') || {}).dataset?.sid || null"
                    )

                def ms_n():
                    return rev.evaluate("() => document.querySelectorAll('#list .row').length")

                def ms_enter():
                    """点 head 的「批量选择」按钮进多选（唯一入口，0 选起手）"""
                    rev.click("#selBtn")
                    rev.wait_for_timeout(250)

                # 常态：单选框不现身、批量底栏收起、入口按钮还是「批量选择」
                check(
                    "多选常态：单选框隐藏、批量底栏收起、按钮是「批量选择」",
                    rev.evaluate(
                        "() => getComputedStyle(document.querySelector('#list .row .ck')).display === 'none'"
                        " && document.getElementById('batchbar').hidden"
                        " && document.getElementById('selBtn').textContent === '批量选择'"
                    ),
                    "ck none + batchbar hidden + btn 批量选择",
                )
                # 铺路：建一个科目并展开（批量移入要科目可选；块尾删掉还原前置状态）
                rev.click("#newSub")
                rev.wait_for_timeout(300)
                rev.fill("#subInput", "批量科目")
                rev.click("#subYes")
                rev.wait_for_timeout(600)
                check("多选用例铺路：科目就位", rev.evaluate("() => document.querySelectorAll('#list .sub').length") == 1, "sub==1")
                rev.click("#list .sub")
                rev.wait_for_timeout(300)
                check(
                    "多选用例铺路：科目展开（接批量移入）",
                    rev.evaluate("() => !!document.querySelector('#list .subempty')") and ms_n() == 2,
                    f"rows={ms_n()}",
                )

                # 点「批量选择」进多选：0 选起手（不自动勾任何卡），再点卡片勾选
                idx_a = rev.evaluate(
                    """() => {
                        const rows = [...document.querySelectorAll('#list .row')];
                        const a = rows.findIndex(r => r.classList.contains('active'));
                        return rows.length > 1 && a === 0 ? 1 : 0;
                    }"""
                )
                idx_o = 1 - idx_a
                active_before = ms_active()
                ms_enter()
                cnt0 = rev.evaluate("() => document.getElementById('selCount').textContent")
                check(
                    "点 #selBtn 进多选：#list.sel + 底栏浮出 + 0 选起手（批量三件禁用）",
                    ms_sel()
                    and not rev.evaluate("() => document.getElementById('batchbar').hidden")
                    and cnt0 == "已选 0 项"
                    and not any(r["on"] for r in ms_rows())
                    and rev.evaluate("() => ['bFav','bMove','bDel'].every((id) => document.getElementById(id).disabled)"),
                    f"sel={ms_sel()} count={cnt0} on={ms_rows()}",
                )
                btn_txt = rev.evaluate("() => document.getElementById('selBtn').textContent")
                check("模式里入口按钮文案变「退出选择」", btn_txt == "退出选择", btn_txt)

                # 模式内点卡片 = 勾选（不打开会话）
                rev.locator("#list .row").nth(idx_a).locator(".t").click()
                rev.wait_for_timeout(200)
                onv = [r["on"] for r in ms_rows()]
                check("模式内点卡片勾上的是被点那张（0 → 1）", onv == [i == idx_a for i in range(len(onv))], f"on={onv} idx={idx_a}")
                cnt_txt = rev.evaluate("() => document.getElementById('selCount').textContent")
                check(
                    "底栏计数「已选 1 项」",
                    cnt_txt == "已选 1 项",
                    cnt_txt,
                )
                check("点卡片不切换会话（active 不变）", ms_active() == active_before, f"{ms_active()} vs {active_before}")
                check(
                    "模式里单选框现身（.ck display:flex）",
                    rev.evaluate("() => getComputedStyle(document.querySelector('#list .row .ck')).display") == "flex",
                    "ck flex",
                )
                check(
                    "科目行不参与多选（.sub 下没有 .ck）",
                    rev.evaluate("() => document.querySelectorAll('#list .sub .ck').length") == 0,
                    "sub ck==0",
                )

                # 涂抹：从单选框起笔拖到另一张卡的单选框 → 两张全选中（只认单选框起笔）
                def ck_xy(row_idx):
                    b = rev.locator("#list .row").nth(row_idx).locator(".ck").bounding_box()
                    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

                fx, fy = ck_xy(idx_o)
                tx, ty = ck_xy(idx_a)
                rev.mouse.move(fx, fy)
                rev.mouse.down()
                for k in range(1, 6):
                    rev.mouse.move(fx + (tx - fx) * k / 5, fy + (ty - fy) * k / 5)
                    rev.wait_for_timeout(40)
                rev.mouse.up()
                rev.wait_for_timeout(300)
                onv = [r["on"] for r in ms_rows()]
                check("单选框涂抹跨行选中（.row.on 两张全亮）", onv == [True, True], f"on={onv}")
                check("涂抹收笔后会话没被切走", ms_active() == active_before, f"{ms_active()} vs {active_before}")

                # 折返换向：起笔卡已选 → 本笔先取消（中途全灭）；笔尖折返 = 方向翻转、新段从拐点起算（再全亮）
                rev.mouse.move(fx, fy)
                rev.mouse.down()
                rev.mouse.move(tx, ty)
                rev.wait_for_timeout(120)
                onv = [r["on"] for r in ms_rows()]
                check("涂抹起在已选卡上 = 本笔先取消（笔尖所至全灭）", onv == [False, False], f"on={onv}")
                rev.mouse.move(fx, fy)
                rev.wait_for_timeout(120)
                rev.mouse.up()
                rev.wait_for_timeout(300)
                onv = [r["on"] for r in ms_rows()]
                check("中途折返方向翻转、新段从拐点起算（两张复亮）", onv == [True, True], f"on={onv}")

                # 模式内单击卡片 = 勾选（不打开会话）
                rev.locator("#list .row").nth(idx_a).locator(".t").click()
                rev.wait_for_timeout(200)
                onv = [r["on"] for r in ms_rows()]
                check("模式内单击卡片 = 取消勾选", onv.count(True) == 1 and not onv[idx_a], f"on={onv}")
                check("模式内点行不切换会话", ms_active() == active_before, f"{ms_active()} vs {active_before}")
                rev.locator("#list .row").nth(idx_a).locator(".t").click()
                rev.wait_for_timeout(200)
                onv = [r["on"] for r in ms_rows()]
                check("再点一次重新勾选（选中 2 张）", onv == [True, True], f"on={onv}")

                # 批量移入科目：弹层列「移出科目 + 全部科目」，选中科目后两行都归入
                rev.click("#bMove")
                rev.wait_for_timeout(300)
                pick_n = rev.evaluate("() => document.querySelectorAll('#pickList .prow').length")
                pick_title = rev.evaluate("() => document.getElementById('pickTitle').textContent")
                check(
                    "移入科目弹层列出「移出科目」+ 科目、标题带条数",
                    pick_n == 2 and "2 条" in pick_title,
                    f"prow={pick_n} title={pick_title!r}",
                )
                rev.click("#pickList .prow:nth-child(2)")
                rev.wait_for_timeout(700)
                in_n = rev.evaluate("() => document.querySelectorAll('#list .row.in').length")
                check(
                    "批量移入生效：两行都进科目、弹层已关、模式还在",
                    in_n == 2
                    and ms_n() == 2
                    and not rev.evaluate("() => document.getElementById('subpick').classList.contains('on')")
                    and ms_sel(),
                    f"in={in_n} rows={ms_n()}",
                )

                # 批量收藏：只弹一条 toast；再点时全已收藏 → 统一取消
                rev.evaluate("() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
                rev.click("#bFav")
                rev.wait_for_timeout(500)
                t1 = rev_toast()
                n1 = rev.evaluate("() => document.querySelectorAll('#toasts .toast').length")
                check("批量收藏只弹一条 toast（已收藏 N 条）", n1 == 1 and bool(t1) and t1.startswith("已收藏") and t1.endswith("条"), f"{n1} {t1!r}")
                check(
                    "批量收藏后两行都亮星标且落进存储",
                    all(r["fav"] for r in ms_rows()) and all(fav_of(r["sid"]) for r in ms_rows()),
                    str(ms_rows()),
                )
                rev.evaluate("() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
                rev.click("#bFav")
                rev.wait_for_timeout(500)
                t2 = rev_toast()
                n2 = rev.evaluate("() => document.querySelectorAll('#toasts .toast').length")
                check(
                    "再点批量收藏：全已收藏 → 统一取消（一条 toast）",
                    n2 == 1 and bool(t2) and t2.startswith("已取消收藏") and t2.endswith("条"),
                    f"{n2} {t2!r}",
                )
                check("批量取消后没有亮星的行", not any(r["fav"] for r in ms_rows()), str(ms_rows()))

                # 批量删除：确认框带条数；取消则框关、模式在、一行不删
                rev.click("#bDel")
                rev.wait_for_timeout(300)
                conf_on = rev.evaluate("() => document.getElementById('confirm').classList.contains('on')")
                conf_txt = rev.evaluate("() => document.getElementById('confirmName').textContent")
                check("批量删除确认框带条数", conf_on and "选中的 2 条" in conf_txt, f"on={conf_on} {conf_txt!r}")
                rev.click("#confirmNo")
                rev.wait_for_timeout(300)
                check(
                    "取消批量删除：框关、模式还在、一行没删",
                    not rev.evaluate("() => document.getElementById('confirm').classList.contains('on')")
                    and ms_sel()
                    and ms_n() == 2
                    and [r["on"] for r in ms_rows()] == [True, True],
                    "cancelled",
                )

                # 退出多选四条路：入口按钮再点 / 底栏「取消」/ Escape / 模式里换筛选
                rev.click("#selCancel")
                rev.wait_for_timeout(250)
                check(
                    "点底栏「取消」退出多选（sel 撤、底栏收、选中清零、单选框藏回）",
                    not ms_sel()
                    and rev.evaluate("() => document.getElementById('batchbar').hidden")
                    and not any(r["on"] for r in ms_rows())
                    and rev.evaluate("() => getComputedStyle(document.querySelector('#list .row .ck')).display === 'none'")
                    and rev.evaluate("() => document.getElementById('selBtn').textContent === '批量选择'"),
                    "exited",
                )

                # 入口按钮自己也是退出路：进模式后它写着「退出选择」，再点一下就退
                ms_enter()
                entered = ms_sel() and rev.evaluate("() => document.getElementById('selBtn').textContent") == "退出选择"
                rev.click("#selBtn")
                rev.wait_for_timeout(250)
                check(
                    "模式里再点 #selBtn（「退出选择」）退出多选",
                    entered and not ms_sel() and rev.evaluate("() => document.getElementById('selBtn').textContent") == "批量选择",
                    f"entered={entered}",
                )

                ms_enter()
                entered = ms_sel()
                rev.keyboard.press("Escape")
                rev.wait_for_timeout(250)
                check("Escape 退出多选（模态链之后）", entered and not ms_sel(), f"entered={entered}")

                ms_enter()
                entered = ms_sel()
                rev.click('.seg-b[data-filter="fav"]')
                rev.wait_for_timeout(300)
                check(
                    "模式里换筛选（收藏）退出多选、视图切走",
                    entered and not ms_sel() and rev.evaluate("() => !!document.querySelector('#list .empty')"),
                    f"entered={entered}",
                )
                rev.click('.seg-b[data-filter="all"]')
                rev.wait_for_timeout(300)
                check("切回全部视图（两行都在）", ms_n() == 2, f"rows={ms_n()}")

                # 收尾：删掉铺路科目（目录消失、会话原样留下），还原后续用例的前置状态
                rev.hover("#list .sub")
                rev.click("#list .sub .sx")
                rev.wait_for_timeout(300)
                rev.click("#confirmYes")
                rev.wait_for_timeout(700)
                left_subs = rev.evaluate("() => document.querySelectorAll('#list .sub').length")
                left_in = rev.evaluate("() => document.querySelectorAll('#list .row.in').length")
                check(
                    "多选收尾：铺路科目删掉、会话原样留下",
                    left_subs == 0 and left_in == 0 and ms_n() == 2,
                    f"subs={left_subs} in={left_in} rows={ms_n()}",
                )
                rev.screenshot(path=str(SHOTS / "15-review-multiselect.png"))

                # ---- P1：多选涂抹贴近上下边界 → #list 自动滚动（全段确定性，不依赖模型） ----
                active_before = ms_active()
                base_url = rev.url.split("#")[0]
                orig_idx = sw.evaluate(
                    "async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []"
                )
                seeds = [
                    {
                        "id": f"seed-scroll-{i:02d}",
                        "title": f"滚动用例 {i:02d}",
                        "created": 1700000000000 + i,
                        "updated": 1700000000000 + i,
                        "count": 1,
                        "status": "idle",
                        "unread": False,
                    }
                    for i in range(1, 25)
                ]
                sw.evaluate(
                    "async (v) => { await chrome.storage.local.set({ 'spore.index': v }); return true; }",
                    seeds + orig_idx,
                )
                rev.reload()
                rev.wait_for_function(
                    "() => document.querySelectorAll('#list .row').length === 26", timeout=15000
                )
                # 之前有用例收放过侧栏：先确保展开（收起态 #list 整个在负坐标，取点就没意义了）
                if rev.evaluate("() => document.getElementById('sidebar').classList.contains('collapsed')"):
                    rev.click("#collapse")
                    rev.wait_for_timeout(500)
                geo = rev.evaluate(
                    "() => { const l = document.getElementById('list');"
                    " return { max: l.scrollHeight - l.clientHeight, h: l.clientHeight }; }"
                )
                ms_enter()
                check(
                    "P1 铺路：播种 26 行超长列表、可滚、已进多选",
                    geo["max"] > 200 and geo["h"] > 300 and ms_sel(),
                    f"max={geo['max']} h={geo['h']} sel={ms_sel()}",
                )
                lb = rev.locator("#list").bounding_box()
                ck0 = rev.locator("#list .row").nth(0).locator(".ck").bounding_box()
                fx = ck0["x"] + ck0["width"] / 2
                fy = ck0["y"] + ck0["height"] / 2
                edge_y = lb["y"] + lb["height"] - 6
                mid_y = lb["y"] + lb["height"] / 2

                def scroll_top():
                    return rev.evaluate("() => document.getElementById('list').scrollTop")

                def scroll_max():
                    return rev.evaluate(
                        "() => { const l = document.getElementById('list');"
                        " return l.scrollHeight - l.clientHeight; }"
                    )

                rev.mouse.move(fx, fy)
                rev.mouse.down()
                for k in range(1, 11):
                    rev.mouse.move(fx, fy + (edge_y - fy) * k / 10)
                    rev.wait_for_timeout(25)
                rev.wait_for_timeout(400)
                s1, mx1 = scroll_top(), scroll_max()
                check(
                    "涂抹贴下缘：#list 自动连续滚动（scrollTop 变大且未触底）",
                    s1 > 60 and s1 < mx1 - 40,
                    f"s1={s1} max={mx1}",
                )
                for k in range(1, 11):
                    rev.mouse.move(fx, edge_y + (mid_y - edge_y) * k / 10)
                    rev.wait_for_timeout(25)
                rev.wait_for_timeout(350)
                s2 = scroll_top()
                rev.wait_for_timeout(500)
                s3 = scroll_top()
                check("笔尖回到中部：离开边缘档滚动停（两次采样相等）", s3 == s2, f"{s2} -> {s3}")
                for k in range(1, 11):
                    rev.mouse.move(fx, mid_y + (edge_y - mid_y) * k / 10)
                    rev.wait_for_timeout(25)
                rev.wait_for_timeout(300)
                s4 = scroll_top()
                check("再贴下缘：滚动重新起步", s4 > s3 + 30, f"{s3} -> {s4}")
                rev.mouse.up()
                rev.wait_for_timeout(250)
                s5 = scroll_top()
                rev.wait_for_timeout(500)
                s6, mx2 = scroll_top(), scroll_max()
                check(
                    "pointerup 收笔：自动滚动必停（两次采样相等且未触底，非触底假停）",
                    s6 == s5 and s5 < mx2 - 30,
                    f"{s5} -> {s6} max={mx2}",
                )
                rev.screenshot(path=str(SHOTS / "17-review-edge-scroll.png"))
                # 收尾：退多选、删播种、活动会话原样
                if ms_sel():
                    rev.click("#selCancel")
                    rev.wait_for_timeout(250)
                sw.evaluate(
                    "async (v) => { await chrome.storage.local.set({ 'spore.index': v }); return true; }",
                    orig_idx,
                )
                rev.wait_for_function(
                    "() => document.querySelectorAll('#list .row').length === 2", timeout=10000
                )
                if active_before and ms_active() != active_before:
                    rev.goto(base_url + "#" + active_before)
                    rev.wait_for_timeout(500)
                check(
                    "P1 收尾：播种清掉、列表回到 2 行、活动会话不变",
                    ms_n() == 2 and ms_active() == active_before,
                    f"rows={ms_n()} active={ms_active()} vs {active_before}",
                )

                # ---- P6：LaTeX 渲染（md.js 抽屉/整页两面共用；四条分隔符口径；不依赖模型） ----
                math_sid = "mathseed-0001"
                math_title = "LaTeX 渲染自测"
                math_ans = (
                    "行内 $a^2+b^2$、数字开头 $2+2=4$、括号行内 \\(c=d\\)；"
                    "块级 $$\\frac{1}{2}$$ 与 \\[x+y\\]；"
                    "坏公式 $\\notacommand$ 原样保留；"
                    "价格 $5 不吃，单价 $5，$8 元也不吃；转义 \\$5 是字面美元"
                    # P6 行结构（与 Spore-Mobile renderBlocks 同口径）：标题/列表/表格/分隔线/引用块/围栏
                    "\n\n## 行结构自测\n\n> 引用甲\n> 引用乙\n\n- 列表甲\n- 列表乙\n\n"
                    "| 左 | 右 |\n|---|---|\n| 甲 | 乙 |\n\n---\n\n### 三级标题\n\n"
                    "1. 有序甲\n2. 有序乙\n\n```js\nlet a = 1;\n```\n"
                    # P6d 行内/块级新格式（与 Spore-Mobile 的 md.js 同口径）：斜体、图片、
                    # 4 空格缩进代码块、嵌套列表（ul 内嵌 ul + ol 内嵌 ol）
                    "\n\n行内 *斜体自测* 与图片 ![图注](https://e.com/spore-e2e.png)\n\n"
                    "    indent_code_a = 1\n\n"
                    "- 外层甲\n    - 内层乙\n\n"
                    "1. 外序甲\n    1. 内序乙\n"
                )
                # P6c 任务 B 回归：题号前缀（第3题 ）单独 esc、正文单独 md —— 首行 `## …` 必须成 <h2>
                math_ans2 = "## 前缀标题自测\n\n题号前缀不许顶掉首行标题。"
                math_row = {
                    "id": math_sid,
                    "title": math_title,
                    "created": 1700001111000,
                    "updated": 1700001111000,
                    "count": 2,
                    "status": "idle",
                    "unread": False,
                }
                sw.evaluate(
                    """async (v) => {
                        await chrome.storage.local.set({
                            'spore.index': [v.row].concat(v.orig),
                            ['spore.sess.' + v.sid]: {
                                id: v.sid, title: v.title, created: v.row.created, updated: v.row.updated,
                                status: 'idle', unread: false,
                                messages: [
                                    { role: 'user', ts: v.row.created, text: '题目：公式渲染自测' },
                                    { kind: 'answer', ts: v.row.updated, ans: v.ans,
                                      why: '补充：先化简再代入' },
                                    { kind: 'answer', ts: v.row.updated + 1000, no: 3, ans: v.ans2 },
                                ],
                            },
                        });
                        return true;
                    }""",
                    {"row": math_row, "sid": math_sid, "title": math_title,
                     "ans": math_ans, "ans2": math_ans2, "orig": orig_idx},
                )
                rm = ctx.new_page()
                rm.on("pageerror", lambda e: print("[pageerror]", e, flush=True))
                rm.goto(base_url + "#" + math_sid)
                rm.wait_for_selector("#history .msg.bot .ans", timeout=15000)
                rm.wait_for_timeout(400)
                link_ok = rm.evaluate(
                    "() => { const l = document.querySelector('link[href*=\"katex.min.css\"]');"
                    " return !!(l && l.sheet); }"
                )
                check("P6 整页：head 挂上 KaTeX 样式表（sheet 载入成功）", bool(link_ok), link_ok)
                fonts_n = rm.evaluate(
                    "async () => { try { const f = await document.fonts.load('1.21em KaTeX_Main');"
                    " return f.length; } catch (e) { return -1; } }"
                )
                check("P6 整页：KaTeX 字体真的加载进来（WAR 放行）", (fonts_n or 0) > 0, fonts_n)
                info = rm.evaluate(
                    """() => {
                        const els = [...document.querySelectorAll('#history .katex')];
                        const one = els[0];
                        return {
                            n: els.length,
                            h: one ? one.offsetHeight : 0,
                            t: one ? one.textContent.trim().length : 0,
                            font: one ? getComputedStyle(one).fontFamily : '',
                            doc: document.querySelector('#history').textContent,
                        };
                    }"""
                )
                check(
                    "P6 整页：四类分隔符 5 处渲染成 .katex（可见、非空、KaTeX 样式生效）",
                    info["n"] == 5 and info["h"] > 0 and info["t"] > 0 and "KaTeX" in info["font"],
                    f"n={info['n']} h={info['h']} t={info['t']} font={info['font'][:50]}",
                )
                doc = info["doc"]
                check("P6 整页：数字开头公式 $2+2=4$ 被渲染（源码不裸露）", "$2+2=4$" not in doc, "$2+2=4$" in doc)
                check(
                    "P6 整页：价格 $5/$8 不被吞、\\$5 剥成字面 $5",
                    "$5" in doc and "$8" in doc and "\\$5" not in doc and "转义 $5 是字面美元" in doc,
                    repr([s for s in ("$5", "$8", "\\$5") if s in doc]),
                )
                check(
                    "P6 整页：坏公式原样显示源码",
                    "$\\notacommand$" in doc,
                    "$\\notacommand$" in doc,
                )
                # P6b 行结构（md.js 新增：ATX/setext 标题、GFM 表格、无序列表、分隔线；
                # 语义与 Spore-Mobile renderBlocks 同口径。样式断言同挂在同一条 check 上）
                blk = rm.evaluate(
                    """() => {
                        const ans = document.querySelector('#history .msg.bot .ans');
                        const q = (s) => ans.querySelectorAll(s).length;
                        const h2 = ans.querySelector('h2');
                        const tb = ans.querySelector('table');
                        const doc = document.querySelector('#history').textContent;
                        return {
                            h2: q('h2'), h3: q('h3'), table: q('table'), th: q('th'), td: q('td'),
                            ul: q('ul'), ulli: ans.querySelectorAll('ul li').length,
                            ol: q('ol'), olli: ans.querySelectorAll('ol li').length,
                            hr: q('hr'),
                            pre: q('pre'), preLang: (ans.querySelector('pre code') || {}).className || '',
                            preOv: (() => { const p = ans.querySelector('pre');
                                return p ? getComputedStyle(p).overflowX : ''; })(),
                            h2w: h2 ? getComputedStyle(h2).fontWeight : '',
                            bc: tb ? getComputedStyle(tb).borderCollapse : '',
                            litHead: doc.includes('## 行结构自测'),
                            litPipe: doc.includes('| 左 | 右 |'),
                            litDash: ans.textContent.includes('- 列表甲'),
                            bq: q('blockquote'),
                            bqw: ans.querySelector('blockquote')
                                ? getComputedStyle(ans.querySelector('blockquote')).borderLeftWidth : '',
                            litQuote: ans.textContent.includes('> 引用甲'),
                            litOl: ans.textContent.includes('1. 有序甲'),
                            litFence: ans.textContent.includes('```'),
                            em: q('em'),
                            imgSrc: (ans.querySelector('img') || {}).src || '',
                            imgMax: (() => { const i = ans.querySelector('img');
                                return i ? getComputedStyle(i).maxWidth : ''; })(),
                            pre2Text: (() => { const p = ans.querySelectorAll('pre');
                                return p[1] ? p[1].textContent.trim() : ''; })(),
                            ulUl: ans.querySelectorAll('ul ul').length,
                            olOl: ans.querySelectorAll('ol ol').length,
                            litEm: ans.textContent.includes('*斜体自测*'),
                            litIndent: ans.textContent.includes('    indent_code_a'),
                            litNest: ans.textContent.includes('- 内层乙') || ans.textContent.includes('1. 内序乙'),
                        };
                    }"""
                )
                check(
                    "P6 整页：行结构渲染（h2/h3/table 表头表体/ul/ol/hr 齐全 + 标题与表格样式生效）",
                    blk["h2"] == 1 and blk["h3"] == 1 and blk["table"] == 1 and blk["th"] == 2
                    and blk["td"] == 2 and blk["ul"] == 3 and blk["ulli"] == 4 and blk["hr"] == 1
                    and blk["ol"] == 3 and blk["olli"] == 4
                    and blk["h2w"] == "700" and blk["bc"] == "collapse",
                    str(blk),
                )
                check(
                    "P6 整页：围栏代码渲染（pre>code + language-js + 横向滚样式 + 无字面 ``` 与 1. 序号）",
                    blk["pre"] == 2 and blk["preLang"] == "language-js" and blk["preOv"] == "auto"
                    and not blk["litFence"] and not blk["litOl"],
                    f"pre={blk['pre']} lang={blk['preLang']} ov={blk['preOv']} "
                    f"litFence={blk['litFence']} litOl={blk['litOl']}",
                )
                check(
                    "P6 整页：行内斜体与图片落地（<em> 落地、<img src=https> 且 max-width:100%、无字面 *斜体自测*）",
                    blk["em"] == 1 and blk["imgSrc"].startswith("https://")
                    and blk["imgMax"] == "100%" and not blk["litEm"],
                    f"em={blk['em']} src={blk['imgSrc']} max={blk['imgMax']} litEm={blk['litEm']}",
                )
                check(
                    "P6 整页：4 空格缩进代码块落地（第二个 pre>code 内容正确、无字面缩进行）",
                    blk["pre2Text"] == "indent_code_a = 1" and not blk["litIndent"],
                    f"pre2={blk['pre2Text']!r} litIndent={blk['litIndent']}",
                )
                check(
                    "P6 整页：嵌套列表落地（ul>ul 与 ol>ol 各一条、li 数正确、无字面嵌套记号）",
                    blk["ulUl"] == 1 and blk["olOl"] == 1 and blk["ulli"] == 4 and blk["olli"] == 4
                    and not blk["litNest"],
                    f"ulUl={blk['ulUl']} olOl={blk['olOl']} ulli={blk['ulli']} "
                    f"olli={blk['olli']} litNest={blk['litNest']}",
                )
                check(
                    "P6 整页：引用块渲染（blockquote + 左框线样式生效 + 无字面 > 记号）",
                    blk["bq"] == 1 and blk["bqw"] == "3px" and not blk["litQuote"],
                    f"bq={blk['bq']} bqw={blk['bqw']} litQuote={blk['litQuote']}",
                )
                check(
                    "P6 整页：字面 markdown 行（## 标题 / 表头行 / - 列表）不再原样保留",
                    not blk["litHead"] and not blk["litPipe"] and not blk["litDash"],
                    f"head={blk['litHead']} pipe={blk['litPipe']} dash={blk['litDash']}",
                )
                # P6c 两条新契约（整页侧）：①宽表格外套 .tablewrap 横向滚；②题号前缀不顶掉首行标题
                mm = rm.evaluate(
                    """() => {
                        const ans = document.querySelector('#history .msg.bot .ans');
                        const w = ans.querySelector('.tablewrap');
                        const tb = ans.querySelector('table');
                        const last = [...document.querySelectorAll('#history .msg.bot .ans')].pop();
                        const h = last.querySelector('h2');
                        return {
                            ov: w ? getComputedStyle(w).overflowX : '',
                            wm: w ? getComputedStyle(w).marginTop : '',
                            inner: !!(w && w.firstElementChild && w.firstElementChild.tagName === 'TABLE'),
                            tm: tb ? getComputedStyle(tb).marginTop : '',
                            h2: h ? h.textContent : '',
                            h2n: last.querySelectorAll('h2').length,
                            pre: last.textContent.startsWith('第3题 '),
                            lit: last.textContent.includes('## 前缀标题自测'),
                        };
                    }"""
                )
                check(
                    "P6 整页：宽表格外套 .tablewrap（overflow-x:auto、内层仍是 <table>、间距由外层给）",
                    mm["ov"] == "auto" and mm["wm"] == "7px" and mm["inner"] and mm["tm"] == "0px",
                    str(mm),
                )
                check(
                    "P6 整页：题号前缀不顶掉首行标题（「第3题 」仍在正文前 + 首行成 <h2> + 无字面 ## 残留）",
                    mm["h2"] == "前缀标题自测" and mm["h2n"] == 1 and mm["pre"] and not mm["lit"],
                    str(mm),
                )
                rm.screenshot(path=str(SHOTS / "18-review-katex.png"))
                rm.close()

                # 抽屉是 Shadow DOM：另一面钉住「共用同一份 md.js」+ 样式进 shadow root
                # 抽屉开合记在 origin 共享的 localStorage 上（spore.open）：探针页只读不点，
                # 否则把 fixture 页的开合状态带偏（切页后 #sessions 就没了）。挂载时按原值自开自关。
                open_flag0 = page.evaluate("() => localStorage.getItem('spore.open')")
                dp = ctx.new_page()
                dp.on("pageerror", lambda e: print("[pageerror]", e, flush=True))
                dp.goto(PAGE, wait_until="load")
                dp.wait_for_selector("spore-drawer", timeout=15000)
                guard(
                    dp,
                    "P6 抽屉等 .katex 出现",
                    lambda: dp.wait_for_function(
                        """() => {
                            const h = document.querySelector('spore-drawer');
                            const sr = h && h.shadowRoot;
                            return !!sr && sr.querySelectorAll('.katex').length === 5;
                        }""",
                        timeout=15000,
                    ),
                )
                dinfo = dp.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const els = [...sr.querySelectorAll('.katex')];
                        const one = els[0];
                        const link = sr.querySelector('link[href*="katex.min.css"]');
                        const doc = sr.querySelector('#stream').textContent;
                        const ans = sr.querySelector('#stream .msg.bot .ans');
                        const q = (s) => (ans ? ans.querySelectorAll(s).length : 0);
                        const h2 = ans && ans.querySelector('h2');
                        const tb = ans && ans.querySelector('table');
                        return {
                            n: els.length,
                            h: one ? one.offsetHeight : 0,
                            font: one ? getComputedStyle(one).fontFamily : '',
                            link: !!(link && link.sheet),
                            has5: doc.includes('$5') && doc.includes('$8'),
                            bad: doc.includes('$' + String.fromCharCode(92) + 'notacommand$'),
                            blk: {
                                h2: q('h2'), h3: q('h3'), table: q('table'), th: q('th'), td: q('td'),
                                ul: q('ul'), ulli: ans.querySelectorAll('ul li').length,
                                ol: q('ol'), olli: ans.querySelectorAll('ol li').length,
                                hr: q('hr'),
                                pre: q('pre'), preLang: (ans.querySelector('pre code') || {}).className || '',
                                preOv: (() => { const p = ans.querySelector('pre');
                                    return p ? getComputedStyle(p).overflowX : ''; })(),
                                h2w: h2 ? getComputedStyle(h2).fontWeight : '',
                                bc: tb ? getComputedStyle(tb).borderCollapse : '',
                                litHead: doc.includes('## 行结构自测'),
                                litDash: ans ? ans.textContent.includes('- 列表甲') : true,
                                bq: q('blockquote'),
                                bqw: (ans && ans.querySelector('blockquote'))
                                    ? getComputedStyle(ans.querySelector('blockquote')).borderLeftWidth : '',
                                litQuote: ans ? ans.textContent.includes('> 引用甲') : true,
                                litOl: ans ? ans.textContent.includes('1. 有序甲') : true,
                                litFence: ans ? ans.textContent.includes('```') : true,
                                em: q('em'),
                                imgSrc: (ans && ans.querySelector('img')) ? ans.querySelector('img').src : '',
                                imgMax: (() => { const i = ans && ans.querySelector('img');
                                    return i ? getComputedStyle(i).maxWidth : ''; })(),
                                pre2Text: (() => { const p = ans ? ans.querySelectorAll('pre') : [];
                                    return p[1] ? p[1].textContent.trim() : ''; })(),
                                ulUl: ans ? ans.querySelectorAll('ul ul').length : 0,
                                olOl: ans ? ans.querySelectorAll('ol ol').length : 0,
                                litEm: ans ? ans.textContent.includes('*斜体自测*') : true,
                                litIndent: ans ? ans.textContent.includes('    indent_code_a') : true,
                                litNest: ans ? (ans.textContent.includes('- 内层乙')
                                    || ans.textContent.includes('1. 内序乙')) : true,
                            },
                        };
                    }"""
                )
                check(
                    "P6 抽屉：shadow root 里同样渲染 5 处 .katex（共用 md.js）、CSS 进了 shadow",
                    dinfo["n"] == 5 and dinfo["h"] > 0 and "KaTeX" in dinfo["font"] and dinfo["link"],
                    f"n={dinfo['n']} h={dinfo['h']} link={dinfo['link']} font={dinfo['font'][:50]}",
                )
                check(
                    "P6 抽屉：价格与坏公式源码同样原样",
                    dinfo["has5"] and dinfo["bad"],
                    f"has5={dinfo['has5']} bad={dinfo['bad']}",
                )
                dblk = dinfo["blk"]
                check(
                    "P6 抽屉：shadow root 里行结构同样落地（h2/h3/table/ul/ol/hr + 样式，无字面 ## 行）",
                    dblk["h2"] == 1 and dblk["h3"] == 1 and dblk["table"] == 1 and dblk["th"] == 2
                    and dblk["td"] == 2 and dblk["ul"] == 3 and dblk["ulli"] == 4
                    and dblk["ol"] == 3 and dblk["olli"] == 4 and dblk["hr"] == 1
                    and dblk["h2w"] == "700" and dblk["bc"] == "collapse"
                    and not dblk["litHead"] and not dblk["litDash"],
                    str(dblk),
                )
                check(
                    "P6 抽屉：shadow root 里围栏代码同样落地（pre>code + language-js + 无字面 ```）",
                    dblk["pre"] == 2 and dblk["preLang"] == "language-js" and dblk["preOv"] == "auto"
                    and not dblk["litFence"] and not dblk["litOl"],
                    f"pre={dblk['pre']} lang={dblk['preLang']} ov={dblk['preOv']} "
                    f"litFence={dblk['litFence']} litOl={dblk['litOl']}",
                )
                check(
                    "P6 抽屉：行内斜体与图片同样落地（<em>、<img src=https> 且 max-width:100%、无字面 *斜体自测*）",
                    dblk["em"] == 1 and dblk["imgSrc"].startswith("https://")
                    and dblk["imgMax"] == "100%" and not dblk["litEm"],
                    f"em={dblk['em']} src={dblk['imgSrc']} max={dblk['imgMax']} litEm={dblk['litEm']}",
                )
                check(
                    "P6 抽屉：4 空格缩进代码块同样落地（第二个 pre>code 内容正确、无字面缩进行）",
                    dblk["pre2Text"] == "indent_code_a = 1" and not dblk["litIndent"],
                    f"pre2={dblk['pre2Text']!r} litIndent={dblk['litIndent']}",
                )
                check(
                    "P6 抽屉：嵌套列表同样落地（ul>ul 与 ol>ol 各一条、li 数正确、无字面嵌套记号）",
                    dblk["ulUl"] == 1 and dblk["olOl"] == 1 and dblk["ulli"] == 4 and dblk["olli"] == 4
                    and not dblk["litNest"],
                    f"ulUl={dblk['ulUl']} olOl={dblk['olOl']} ulli={dblk['ulli']} "
                    f"olli={dblk['olli']} litNest={dblk['litNest']}",
                )
                check(
                    "P6 抽屉：shadow root 里引用块同样落地（blockquote + 样式生效 + 无字面 > 记号）",
                    dblk["bq"] == 1 and dblk["bqw"] == "3px" and not dblk["litQuote"],
                    f"bq={dblk['bq']} bqw={dblk['bqw']} litQuote={dblk['litQuote']}",
                )
                # P6c 两条新契约（抽屉 shadow 侧）：与整页同口径（①表格外套 ②题号前缀不顶掉首行标题）
                dmm = dp.evaluate(
                    """() => {
                        const sr = document.querySelector('spore-drawer').shadowRoot;
                        const ans = sr.querySelector('#stream .msg.bot .ans');
                        const w = ans.querySelector('.tablewrap');
                        const tb = ans.querySelector('table');
                        const last = [...sr.querySelectorAll('#stream .msg.bot .ans')].pop();
                        const h = last.querySelector('h2');
                        return {
                            ov: w ? getComputedStyle(w).overflowX : '',
                            wm: w ? getComputedStyle(w).marginTop : '',
                            inner: !!(w && w.firstElementChild && w.firstElementChild.tagName === 'TABLE'),
                            tm: tb ? getComputedStyle(tb).marginTop : '',
                            h2: h ? h.textContent : '',
                            h2n: last.querySelectorAll('h2').length,
                            pre: last.textContent.startsWith('第3题 '),
                            lit: last.textContent.includes('## 前缀标题自测'),
                        };
                    }"""
                )
                check(
                    "P6 抽屉：宽表格同样外套 .tablewrap（overflow-x:auto、内层仍是 <table>、间距归零）",
                    dmm["ov"] == "auto" and dmm["wm"] == "7px" and dmm["inner"] and dmm["tm"] == "0px",
                    str(dmm),
                )
                check(
                    "P6 抽屉：题号前缀同样不顶掉首行标题（「第3题 」在前 + <h2> 落地 + 无字面 ## 残留）",
                    dmm["h2"] == "前缀标题自测" and dmm["h2n"] == 1 and dmm["pre"] and not dmm["lit"],
                    str(dmm),
                )
                dp.screenshot(path=str(SHOTS / "19-drawer-katex.png"))
                dp.close()
                open_flag1 = page.evaluate("() => localStorage.getItem('spore.open')")
                check(
                    "P6 收尾：探针页没把 fixture 抽屉开合状态带偏（spore.open 原样）",
                    open_flag1 == open_flag0,
                    f"{open_flag0} -> {open_flag1}",
                )
                sw.evaluate(
                    "async (v) => { await chrome.storage.local.set({ 'spore.index': v.idx });"
                    " await chrome.storage.local.remove(v.key); return true; }",
                    {"idx": orig_idx, "key": "spore.sess." + math_sid},
                )
                rev.wait_for_function(
                    "() => document.querySelectorAll('#list .row').length === 2", timeout=10000
                )
                check(
                    "P6 收尾：索引与活动会话都还原（2 行、仍是原会话）",
                    ms_n() == 2 and ms_active() == active_before,
                    f"rows={ms_n()} active={ms_active()} vs {active_before}",
                )

                # ---- 底部输入框也迁进整页：关掉自动核实省一次联网核实，发一句追问 ----
                opt.click('.idx a[data-sec="model"]')
                opt.wait_for_timeout(300)
                opt.uncheck("#autoVerify")
                opt.wait_for_timeout(1400)
                rev.fill("#input", "整页追问：一句话说明你为什么这么答")
                rev.keyboard.press("Enter")
                rev.wait_for_timeout(1800)
                utxt = rev.evaluate(
                    "() => [...document.querySelectorAll('#history .utext')].map((e) => e.textContent).join('|')"
                )
                check("整页输入框发出的追问进了历史", "整页追问" in utxt, utxt[-80:])
                guard(page, "等整页追问收尾", lambda: wait_idle(page, 180000))
                bot_n = rev.evaluate("() => document.querySelectorAll('#history .msg.bot').length")
                check("整页追问的回答渲染出来", bot_n >= 2, bot_n)
                # 输入框要跟着回合状态恢复（状态以存储 status 为准，不信端口事件收没收全）
                guard(
                    rev,
                    "等整页输入框恢复",
                    lambda: rev.wait_for_function(
                        "() => !document.getElementById('input').disabled", timeout=180000
                    ),
                )
                check(
                    "整页追问收尾后输入框恢复可用",
                    rev.evaluate("() => !document.getElementById('input').disabled"),
                    "composer enabled",
                )
                opt.check("#autoVerify")
                opt.wait_for_timeout(1400)
                saved_av = sw.evaluate(
                    """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).autoVerify"""
                )
                check("用完把自动核实恢复为开", saved_av is True, repr(saved_av))

                # ---- 停止生成按钮（整页 composer）：空闲收起 → 生成中出现 → 点掉即中止 ----
                check(
                    "空闲时停止按钮收起",
                    rev.evaluate("() => document.getElementById('stop').hidden"),
                    "hidden",
                )
                rev.fill("#input", "整页停止测试：请写一段不少于三百字的详细说明，慢慢写")
                rev.keyboard.press("Enter")
                guard(
                    rev,
                    "等停止按钮出现",
                    lambda: rev.wait_for_selector("#stop", state="visible", timeout=60000),
                )
                stop_shown = rev.evaluate("() => !document.getElementById('stop').hidden")
                check(
                    "整页生成中出现「停止生成」按钮且输入框禁用",
                    stop_shown and rev.evaluate("() => document.getElementById('input').disabled"),
                    f"stop={stop_shown}",
                )
                if stop_shown:
                    rev.screenshot(path=str(SHOTS / "13-review-stop.png"))  # 按钮亮着的现场
                    rev.click("#stop")
                    guard(
                        rev,
                        "等停止后输入框恢复",
                        lambda: rev.wait_for_function(
                            "() => !document.getElementById('input').disabled", timeout=60000
                        ),
                    )
                check(
                    "点停止后回合中止、输入框恢复可用",
                    rev.evaluate("() => !document.getElementById('input').disabled"),
                    "composer enabled",
                )
                stop_sid = rev.evaluate(
                    "() => (document.querySelector('#list .row.active') || {}).dataset?.sid || null"
                )
                stop_st = rev.evaluate(
                    """async (sid) => {
                        const o = await chrome.storage.local.get('spore.sess.' + sid);
                        return (o['spore.sess.' + sid] || {}).status || null;
                    }""",
                    stop_sid,
                )
                check("停止落存储：status=aborted", stop_st == "aborted", repr(stop_st))
                check(
                    "停止后按钮收起",
                    rev.evaluate("() => document.getElementById('stop').hidden"),
                    "hidden",
                )
                rev.screenshot(path=str(SHOTS / "14-review-stopped.png"))

                rev.goto(rev.url.split("#")[0] + f"#{other_id}")
                rev.wait_for_timeout(600)
                a2 = rev.evaluate(
                    "() => (document.querySelector('#list .row.active') || {}).dataset?.sid || null"
                )
                check("整页：hash 定位到指定会话", a2 == other_id, f"{a2} vs {other_id}")
                review_base = rev.url.split("#")[0]  # 收尾用例还要再开一次这一页
                rev.screenshot(path=str(SHOTS / "11-review-page.png"))
                rev.close()
                opt.close()
                page.wait_for_timeout(400)
            except Exception as e:  # noqa: BLE001
                check("点 ⚙ 打开设置页", False, f"{type(e).__name__}: {e}")

            # ---------------- 切页后抽屉仍在 ----------------
            page.goto(PAGE + "?x=2", wait_until="load")
            page.wait_for_selector("spore-drawer", timeout=15000)
            check("切页后抽屉仍在", True)
            check("切页后会话还在", s_count(page, "#listpop .row") >= 0, s_count(page, "#listpop .row"))

            # ---------------- 删除当前会话 → 自动加载最近的会话（收尾用例） ----------------
            del_title = s_text(page, "#title")
            rows_before = s_count(page, "#listpop .row")
            # 先保证列表开着：新契约是「确认删除后列表留着」（用户要继续在列表里操作）
            if "on" not in (s_cls(page, "#listpop") or ""):
                guard(
                    page,
                    "open list for delete",
                    lambda: (page.click("spore-drawer >> #sessions"), page.wait_for_timeout(250)),
                )
            check("删除前列表已打开", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            # .x 平时 opacity:0，直接派发点击最稳；按标题定位「当前会话」那一行
            clicked = page.evaluate(
                """(t) => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const row = [...sr.querySelectorAll('#listpop .row')].find(
                        (r) => ((r.querySelector('.t') || {}).textContent || '') === t
                    );
                    if (!row) return false;
                    row.querySelector('.x').click();
                    return true;
                }""",
                del_title,
            )
            check("点当前会话的删除按钮", bool(clicked), repr(del_title))
            page.wait_for_timeout(300)
            page.click("spore-drawer >> #confirmYes")
            page.wait_for_timeout(900)
            rows_after = s_count(page, "#listpop .row")
            check("删除后列表少一行", rows_after == rows_before - 1, f"{rows_before} -> {rows_after}")
            check("确认删除后会话列表仍开着", "on" in (s_cls(page, "#listpop") or ""), s_cls(page, "#listpop"))
            new_title = s_text(page, "#title")
            check(
                "删除当前会话后自动加载最近会话（标题已换且非空）",
                bool(new_title) and new_title != del_title,
                f"{del_title!r} -> {new_title!r}",
            )
            check("自动加载的会话有内容", s_count(page, "#stream .msg") >= 1, s_count(page, "#stream .msg"))
            page.screenshot(path=str(SHOTS / "10-delete-reload.png"))

            # ---------------- 整页审查里把最后一条也删掉（迁进去的删除走同一条协议） ----------------
            rev2 = ctx.new_page()
            rev2.goto(review_base)
            rev2.wait_for_timeout(800)
            last_title = rev2.evaluate("() => (document.querySelector('#list .row .t') || {}).textContent || ''")
            rev2.hover("#list .row")
            rev2.click("#list .row .x")
            rev2.wait_for_timeout(300)
            box_name = rev2.evaluate("() => (document.getElementById('confirmName') || {}).textContent || ''")
            check(
                "整页点 × 弹删除确认（框里是会话标题）",
                rev2.evaluate("() => document.getElementById('confirm').classList.contains('on')")
                and box_name == last_title,
                f"{box_name!r} vs {last_title!r}",
            )
            rev2.click("#confirmYes")
            rev2.wait_for_timeout(900)
            left = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []")
            check("整页删除生效（索引清空）", len(left) == 0, len(left))
            empty_txt = rev2.evaluate("() => (document.querySelector('#list .empty') || {}).textContent || ''")
            check("整页列表进空态", "还没有搜题记录" in empty_txt, empty_txt[:40])

            # ---------------- 拖入图片 URL 读取（fetch-image）：输入框拖图 = 当作截屏回合 ----------------
            # ① 两处入口的 dragover 必须 preventDefault，否则浏览器会把图片 URL 当导航直接打开
            ok_do_rev = rev2.evaluate(
                """() => {
                    const dt = new DataTransfer();
                    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
                    document.getElementById('composer').dispatchEvent(ev);
                    return ev.defaultPrevented;
                }"""
            )
            check("整页 composer 的 dragover 被 preventDefault", ok_do_rev, ok_do_rev)
            ok_do_drw = page.evaluate(
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const dt = new DataTransfer();
                    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
                    sr.getElementById('composer').dispatchEvent(ev);
                    return ev.defaultPrevented;
                }"""
            )
            check("抽屉 composer 的 dragover 被 preventDefault", ok_do_drw, ok_do_drw)

            # ② 非 http(s) 地址：客户端就地忽略并提示，压根不惊动 SW
            rev2.evaluate("() => document.getElementById('toasts').replaceChildren()")
            rev2.evaluate(
                """() => {
                    const dt = new DataTransfer();
                    dt.setData('text/uri-list', 'ftp://example.com/x.png');
                    document.getElementById('composer').dispatchEvent(
                        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
                    );
                }"""
            )
            rev2.wait_for_timeout(300)
            inv_txt = rev2.evaluate("() => (document.querySelector('#toasts .toast .tb') || {}).textContent || ''")
            idx_now = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []")
            check(
                "拖非 http(s) 地址：忽略并提示、不建会话",
                "只支持 http(s)" in inv_txt and len(idx_now) == 0,
                f"{inv_txt!r} idx={len(idx_now)}",
            )

            # ③ SW 侧校验：http 但不是图（text/html）→ 报错且不建会话（sendMessage 同步等回执）
            fail_res = rev2.evaluate(
                """async (url) => {
                    try {
                        return { resp: await chrome.runtime.sendMessage({ type: 'fetch-image', url }) };
                    } catch (e) {
                        return { err: String((e && e.message) || e) };
                    }
                }""",
                "http://127.0.0.1:8899/page.html",
            )
            idx_now = sw.evaluate("async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []")
            fail_txt = str(fail_res.get("resp") or fail_res.get("err") or "")
            check(
                "fetch-image 拉非图 URL：SW 报错且不建会话",
                "不是图片" in fail_txt and len(idx_now) == 0,
                f"{fail_txt!r} idx={len(idx_now)}",
            )

            # ④ 真图片走产品路径（drop → 端口 → SW 起回合）：新会话建立、首条消息带图
            rev2.evaluate(
                """(url) => {
                    const dt = new DataTransfer();
                    dt.setData('text/uri-list', url);
                    document.getElementById('composer').dispatchEvent(
                        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
                    );
                }""",
                "http://127.0.0.1:8899/tiny.png",
            )
            got = None
            for _ in range(60):
                rev2.wait_for_timeout(250)
                got = rev2.evaluate(
                    """async () => {
                        const idx = (await chrome.storage.local.get('spore.index'))['spore.index'] || [];
                        if (!idx.length) return null;
                        const sid = idx[0].id;
                        const s = (await chrome.storage.local.get('spore.sess.' + sid))['spore.sess.' + sid] || {};
                        const m = (s.messages || [])[0] || {};
                        const img = m.imageKey ? (await chrome.storage.local.get(m.imageKey))[m.imageKey] : null;
                        return { n: idx.length, role: m.role || null, key: m.imageKey || null,
                                 head: img ? String(img).slice(0, 11) : null };
                    }"""
                )
                if got:
                    break
            check(
                "拖入图片 URL → 新会话建立且首条消息带图",
                bool(got)
                and got.get("n") == 1
                and got.get("role") == "user"
                and bool(got.get("key"))
                and got.get("head") == "data:image/",
                got,
            )
            rev2.screenshot(path=str(SHOTS / "16-review-fetch-image.png"))
            rev2.close()

            # ---------------- AI 建议框（默认关 → 开 → 预填 → 单击采纳） ----------------
            # 放在收尾：前面的删除用例把 spore.index 清成了 0，这里造的会话不会影响任何既有计数断言
            page.bring_to_front()
            ml_now = sw.evaluate(
                """async () => ((await chrome.storage.local.get('spore.settings'))['spore.settings'] || {}).mlSuggest"""
            )
            check("收尾起点：AI 建议框仍是关的", ml_now is False, repr(ml_now))

            # ① 关着抓帧：识别链路整条不启动（不建 offscreen、不预填），取消不建会话
            idx_before = sw.evaluate(
                "async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []"
            )
            page.keyboard.press("Alt+S")
            page.wait_for_selector("#spore-overlay-root", timeout=10000)
            page.wait_for_timeout(2500)  # 若开着，识别 ~1s 就该预填；给足余量
            off_off = sw.evaluate("async () => !!(chrome.offscreen && await chrome.offscreen.hasDocument())")
            box_off = page.evaluate(
                """() => { const b = document.getElementById('spore-sel-box');
                           return b ? b.style.display : 'missing'; }"""
            )
            check("关着抓帧：不创建 offscreen 文档（零 OCR 开销）", off_off is False, repr(off_off))
            check("关着抓帧：覆盖层没有预填选区", box_off != "block", repr(box_off))
            page.keyboard.press("Escape")
            page.wait_for_selector("#spore-overlay-root", state="detached", timeout=10000)
            idx_cancel = sw.evaluate(
                "async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []"
            )
            check(
                "关着抓帧：取消框选不建会话",
                len(idx_cancel) == len(idx_before),
                f"{len(idx_before)} -> {len(idx_cancel)}",
            )

            # ② 打开开关（设置 UI 已在上面验过写链，这里直接落存储省一次开页）
            sw.evaluate(
                """async () => {
                    const k = 'spore.settings';
                    const cur = (await chrome.storage.local.get(k))[k] || {};
                    cur.mlSuggest = true;
                    await chrome.storage.local.set({ [k]: cur });
                    return true;
                }"""
            )
            # 下面整段包 try：任何一步抛异常都记成 FAIL，不能变成 exit=2（与已知抖动混淆）
            try:
                page.keyboard.press("Alt+S")
                page.wait_for_selector("#spore-overlay-root", timeout=10000)
                page.wait_for_function(
                    """() => { const b = document.getElementById('spore-sel-box');
                               return !!b && b.style.display === 'block'
                                   && parseFloat(b.style.width) > 60; }""",
                    timeout=20000,
                )
                prefilled = True
                ml_err = ""
            except Exception as e:  # noqa: BLE001
                prefilled = False
                ml_err = f"{type(e).__name__}: {e}"
                print("[ml] 预填未出现：", ml_err, flush=True)
            check("开着抓帧：识别出建议框并预填选区", prefilled, ml_err or prefilled)
            on_on = sw.evaluate("async () => !!(chrome.offscreen && await chrome.offscreen.hasDocument())")
            check("开着抓帧：创建了 offscreen 文档（OCR 跑在里面）", on_on is True, repr(on_on))
            page.screenshot(path=str(SHOTS / "17-ml-suggest.png"))

            # 预填盒必须圈住题目区域（与任一 p.q 重叠 ≥ 50%）——几何证明坐标换算没跑偏
            geo = page.evaluate(
                """() => {
                    const b = document.getElementById('spore-sel-box');
                    if (!b || b.style.display !== 'block') return null;
                    const r = b.getBoundingClientRect();
                    const sel = { x: r.x, y: r.y, w: r.width, h: r.height };
                    const qs = [...document.querySelectorAll('p.q')].map((el) => {
                        const q = el.getBoundingClientRect();
                        return { x: q.x, y: q.y, w: q.width, h: q.height };
                    });
                    return { sel, qs };
                }"""
            )

            def _ov(a, b):
                ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
                iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
                return ix * iy

            # 只钉「坐标换算没跑偏、框确实落在题目上」，**不钉框有多全**：OCR 行框有抖动
            # （同一页两次跑：一次圈住整题 1125px 宽，一次只圈到题干左半 383px 宽，
            # 后者对第一题的重叠只有 49.5% —— 建议框本来就是「建议 + 手动微调」）
            ok_geo = bool(geo) and any(
                _ov(geo["sel"], q) >= 0.25 * q["w"] * q["h"] for q in geo["qs"]
            )
            check("预填框落在题目上（与 p.q 重叠 ≥25%）", ok_geo, repr(geo))

            # ③ 采纳按钮 + 边界可拖（2026-10-09 拍板：右下角按钮采纳，废弃单击/回车）
            if prefilled and geo:
                # a) 按钮跟着选区右下角出现
                try:
                    acc = page.locator("#spore-accept")
                    acc.wait_for(state="visible", timeout=5000)
                    acc_box = acc.bounding_box()
                    s0 = geo["sel"]
                    # 选区盒带 2px 边框（bounding 含边框）、按钮按内部坐标定位 → 容差 8px：
                    # 期望 = 选区右缘 - 按钮宽、下缘 + 6
                    near_br = (
                        bool(acc_box)
                        and abs(acc_box["x"] - (s0["x"] + s0["w"] - 56)) <= 8
                        and abs(acc_box["y"] - (s0["y"] + s0["h"] + 6)) <= 8
                    )
                    check("预填后右下角出现「采纳」按钮", near_br, f"btn={acc_box} sel={s0}")
                except Exception as e:  # noqa: BLE001
                    acc_box = None
                    check("预填后右下角出现「采纳」按钮", False, f"{type(e).__name__}: {e}")

                # b) 拖左边界：选区变窄，且**不**提交（覆盖层还在）。
                #    刻意往**里**拖：建议框可能已被 clampX 顶到视口右边，
                #    朝墙外拖是 no-op（产品对、断言假红），所以选有余量的方向。
                try:
                    before = page.locator("#spore-sel-box").bounding_box()
                    edge_y = before["y"] + before["height"] / 2
                    page.mouse.move(before["x"], edge_y)
                    page.mouse.down()
                    page.mouse.move(before["x"] + 80, edge_y, steps=6)
                    page.mouse.up()
                    after = page.locator("#spore-sel-box").bounding_box()
                    still_open = page.locator("#spore-overlay-root").count() > 0
                    check(
                        "拖左边界能把选区改小（边界可拖、松手不提交）",
                        bool(after) and after["width"] <= before["width"] - 40 and still_open,
                        f"{before['width']:.0f} -> {after['width'] if after else None} open={still_open}",
                    )
                except Exception as e:  # noqa: BLE001
                    check("拖左边界能把选区改小（边界可拖、松手不提交）", False, f"{type(e).__name__}: {e}")

                # c) 点「采纳」= 提交：覆盖层收起 + 新会话建立
                #    按钮是 pointer-events:none（命中统一走 window 捕获监听），
                #    Playwright 的 Locator.click 会判它「收不到事件」超时 → 按坐标点。
                #    finish() 先移 DOM，SW 那边 cropShot → 建会话 → saveSession 还要一会儿，
                #    一次读 index 会假红成 1 -> 1，所以轮询。
                try:
                    bb = page.locator("#spore-accept").bounding_box()
                    assert bb, "采纳按钮没有几何尺寸"
                    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                    page.wait_for_selector("#spore-overlay-root", state="detached", timeout=10000)
                    idx_after = []
                    for _ in range(40):
                        idx_after = sw.evaluate(
                            "async () => (await chrome.storage.local.get('spore.index'))['spore.index'] || []"
                        )
                        if len(idx_after) > len(idx_before):
                            break
                        page.wait_for_timeout(250)
                    check(
                        "点「采纳」提交选区（覆盖层收起 + 建会话）",
                        len(idx_after) == len(idx_before) + 1,
                        f"{len(idx_before)} -> {len(idx_after)}",
                    )
                except Exception as e:  # noqa: BLE001
                    check("点「采纳」提交选区（覆盖层收起 + 建会话）", False, f"{type(e).__name__}: {e}")
            else:
                check("预填后右下角出现「采纳」按钮", False, "预填没出现，跳过")
                check("拖左边界能把选区改小（边界可拖、松手不提交）", False, "预填没出现，跳过")
                check("点「采纳」提交选区（覆盖层收起 + 建会话）", False, "预填没出现，跳过")

            # 关回默认：别把开关留在开态（后续会话不受识别链路影响）
            sw.evaluate(
                """async () => {
                    const k = 'spore.settings';
                    const cur = (await chrome.storage.local.get(k))[k] || {};
                    cur.mlSuggest = false;
                    await chrome.storage.local.set({ [k]: cur });
                    return true;
                }"""
            )

            ctx.close()
    finally:
        server.terminate()

    print("\n==== 汇总 ====", flush=True)
    for st, name, detail in steps:
        print(f"{st:4} | {name} | {detail}", flush=True)
    print("失败：", fails or "无", flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
