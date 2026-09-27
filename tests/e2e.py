"""Spore 真机端到端自测（Playwright + 本机 Edge）。

跑法（模型 key 走 `SPORE_E2E_KEY` 环境变量或 gitignore 的 `tests/_run/e2e_key`，默认设置不含 key）：

    python tests/e2e.py

覆盖：Alt+S 框选截图 → 抽屉弹出 → 阶段A 直接作答 → <<ok>> 守卫/联网核实 →
异步起名 → 半圆小角收起弹出（内压/外凸）→ 会话气泡点击列表（悬停不触发）→ 滚动不跟随 →
CoT 思考块 → 追问 → 0 下载（静默镜像）→ FSA 写盘能力。
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
                """() => {
                    const sr = document.querySelector('spore-drawer').shadowRoot;
                    const c = sr.querySelector('#confirm');
                    if (!c || !c.classList.contains('on')) return null;
                    const r = c.querySelector('.box').getBoundingClientRect();
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
            page.wait_for_function(
                """() => {
                    const h = document.querySelector('spore-drawer');
                    return h && h.shadowRoot && h.shadowRoot.querySelectorAll('#stream .msg').length >= 4;
                }""",
                timeout=90000,
                polling=500,
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
            page.wait_for_function(
                """() => {
                    const h = document.querySelector('spore-drawer');
                    const m = h && h.shadowRoot && [...h.shadowRoot.querySelectorAll('#stream .chat')].pop();
                    return !!(m && m.textContent.trim().length > 3);
                }""",
                timeout=90000,
                polling=500,
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
                for name in ("model", "mirror", "keys", "log"):
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
            new_title = s_text(page, "#title")
            check(
                "删除当前会话后自动加载最近会话（标题已换且非空）",
                bool(new_title) and new_title != del_title,
                f"{del_title!r} -> {new_title!r}",
            )
            check("自动加载的会话有内容", s_count(page, "#stream .msg") >= 1, s_count(page, "#stream .msg"))
            page.screenshot(path=str(SHOTS / "10-delete-reload.png"))

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
