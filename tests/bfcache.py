"""bfcache 端口往返的回归核验（独立脚本，**不进** e2e 门禁）。

背景、根因与判据见 docs/design.md 六f：页面被搬进往返缓存时 Chrome 会用
`The page keeping the extension port is moved into back/forward cache, so the message
channel is closed.` 关掉 spore 端口 —— 这个原因挂在断连回调的 `chrome.runtime.lastError` 上，
不读就刷 `Unchecked runtime.lastError: …`；而且抽屉原本只靠 onDisconnect 重连，文档被冻结后
端口就再也不回来（实测 SW 侧端口数掉到 0）。

三条判据（都在 bfcache 往返之后量）：
  1. 每页仍只有 1 个端口（没有垂死文档补开的孤儿口）；
  2. SW 日志里有那行 `port 断开 tab=…：The page keeping…`（原因被消费且留痕）；
  3. SW → 抽屉的端口广播还送得到（settleTurn 的 toast **只走端口**，storage 里没有等价信号）。

跑法：`python tests/bfcache.py`（独立 profile、独立端口，可与 e2e 并行）。
注意两条实测坑：Playwright 默认带 `--disable-back-forward-cache`（不摘掉就永远复现不出来），
bfcache 恢复不触发 `load`（`go_back` 必须 `wait_until="commit"`，否则挂到超时）。
"""
import pathlib
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ROOT = HERE / "_run"
PROFILE = ROOT / "bfcache-profile"
PORT = 8898
PAGE = f"http://127.0.0.1:{PORT}/page.html"
BFCACHE_ERR = "The page keeping the extension port is moved into back/forward cache"

fails = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}", flush=True)
    if not ok:
        fails.append(name)
    return ok


def main():
    shutil.rmtree(PROFILE, ignore_errors=True)
    PROFILE.parent.mkdir(parents=True, exist_ok=True)

    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=str(HERE / "fixtures"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.2)
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(PROFILE),
                executable_path=EDGE,
                headless=True,
                # Playwright 默认关 bfcache —— 不摘掉这条，下面的往返就是普通重载，测不到东西
                ignore_default_args=["--disable-back-forward-cache"],
                args=[f"--disable-extensions-except={REPO}", f"--load-extension={REPO}"],
                viewport={"width": 1200, "height": 800},
            )
            sw = ctx.service_workers[0] if ctx.service_workers else None
            if not sw:
                sw = ctx.wait_for_event("serviceworker", timeout=15000)
            assert sw, "extension service worker 没起来"

            def ports():
                return sw.evaluate("() => globalThis.__spore.ports()")

            def log_lines():
                return sw.evaluate(
                    "async () => (await chrome.storage.local.get('spore.log'))['spore.log'] || []"
                )

            def toasts():
                return pg.evaluate(
                    "() => { const h = document.querySelector('spore-drawer');"
                    " if (!h || !h.shadowRoot) return [];"
                    " return [...h.shadowRoot.querySelectorAll('.toast')].map(t => t.textContent.trim()); }"
                )

            def ask_and_wait_toast(tag, timeout_s=90):
                """建会话 → ask → settleTurn 广播 toast（只走端口）→ 等抽屉收到"""
                sid = sw.evaluate("async () => (await globalThis.__spore.store.createSession()).id")
                sw.evaluate(
                    """async (sid) => {
                        const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8898/*' });
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: (s) => chrome.runtime.sendMessage({ type: 'ask', sid: s, text: 'bfcache 端口核验' }),
                            args: [sid],
                        });
                    }""",
                    sid,
                )
                for _ in range(timeout_s):
                    pg.wait_for_timeout(1000)
                    got = toasts()
                    if got:
                        print(f"  # {tag} toast =", got, flush=True)
                        return True
                print(f"  # {tag} 没等到 toast，日志尾 =", log_lines()[-6:], flush=True)
                return False

            pg = ctx.new_page()
            pg.goto(PAGE)
            pg.wait_for_timeout(500)
            sw.evaluate(
                """async () => {
                    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8898/*' });
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/drawer.js'] });
                }"""
            )
            pg.wait_for_timeout(1200)
            check("抽屉注入成功", pg.evaluate("() => !!document.querySelector('spore-drawer')"))

            # 对照组：bfcache 之前，端口广播应当送得到（证明下面的失败不是探针自身的问题）
            check("对照：bfcache 前 SW→抽屉的端口广播送得到", ask_and_wait_toast("对照"))
            check("往返前每页只有 1 个端口", len(ports()) == 1, ports())

            # bfcache 往返：去另一页再后退
            pg.evaluate("() => { window.__bfcacheMarker = 7 }")
            pg.goto(f"http://127.0.0.1:{PORT}/")
            pg.wait_for_timeout(400)
            pg.go_back(wait_until="commit", timeout=8000)
            pg.wait_for_timeout(4000)

            marker = pg.evaluate("() => window.__bfcacheMarker ?? null")
            check("后退确实从 bfcache 恢复（不是重载）", marker == 7, f"marker={marker}")
            got = ports()
            check("往返后仍只有 1 个端口（没有孤儿口）", len(got) == 1, got)

            lines = [l for l in log_lines() if "port 断开" in l]
            check("断连原因被消费并留痕（lastError 那句进了日志环）", any(BFCACHE_ERR in l for l in lines), lines[-1:])

            check("实验组：bfcache 后重建的端口仍送得到", ask_and_wait_toast("实验组"))
            got = ports()
            check("收尾仍只有 1 个端口", len(got) == 1, got)

            ctx.close()
    finally:
        server.terminate()

    print("\n失败：", fails or "无", flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
