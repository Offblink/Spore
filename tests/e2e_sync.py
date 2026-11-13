"""云同步端到端（Playwright + 本机 Edge headless + 假 Spore-Cloud）。

跑法：

    python tests/e2e_sync.py

不依赖真模型、真服务器、真 MySQL：假 Cloud（`tests/mock_cloud.mjs`）按服务端源码复刻
LWW / 游标 / 墓碑 / 附件语义。覆盖：

  配置（裸 host:port 归一 + /users/me 校验）→ 上行（会话/核实字段/首图）→
  第二张图走合成 articleId（attPath）→ 下行（远端会话/题图/LWW 拒旧）→
  本地删除墓碑上行 → 状态帧不含令牌。

通过时退出码 0；失败时把截图留在 tests/_shots/（sync-*.png）。
"""

import base64
import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
EXT = str(REPO)
ROOT = HERE / "_run"
PROFILE = ROOT / "sync_profile"
SHOTS = HERE / "_shots"
TOKEN = "e2e-token"
PAGE = "http://127.0.0.1:8899/page.html"

# 假图字节（不校验图片格式，只验字节往返一致）
IMG1 = bytes.fromhex("ffd8ffdb0001020304ffd9")
IMG2 = bytes.fromhex("ffd8ffdb0a0b0c0d0effd9")
IMG3 = bytes.fromhex("ffd8ffdb1112131415ffd9")

fails = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {str(detail)[:200]}", flush=True)
    if not ok:
        fails.append(name)
    return ok


def http(base, method, path, body=None, raw=False, extra_headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    headers.update(extra_headers or {})
    req = urllib.request.Request(f"{base}{path}", data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as res:
        payload = res.read()
    return payload if raw else json.loads(payload)


def upload_attachment(base, article_id, payload, filename):
    boundary = "----spore-e2e-boundary"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode("utf-8")
    body = head + payload + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{base}/sync/push-attachment?articleId={article_id}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read())


def start_mock():
    proc = subprocess.Popen(
        ["node", str(REPO / "tests" / "mock_cloud.mjs"), "--token", TOKEN, "--port", "0"],
        cwd=str(REPO),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    port = None
    for _ in range(80):
        line = proc.stdout.readline()
        if line.startswith("MOCK_CLOUD_PORT="):
            port = int(line.strip().split("=")[1])
            break
    if not port:
        proc.kill()
        raise RuntimeError("假 Cloud 没起来")
    return proc, f"http://127.0.0.1:{port}/api", port


def data_url(payload):
    return "data:image/jpeg;base64," + base64.b64encode(payload).decode("ascii")


def main():
    shutil.rmtree(PROFILE, ignore_errors=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    ROOT.mkdir(parents=True, exist_ok=True)

    static = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8899", "--bind", "127.0.0.1"],
        cwd=str(HERE / "fixtures"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    mock, API, port = start_mock()
    ctx = None
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(PROFILE),
                executable_path=EDGE,
                headless=True,
                args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
                viewport={"width": 1280, "height": 860},
            )
            sw = ctx.service_workers[0] if ctx.service_workers else None
            if not sw:
                ctx.wait_for_event("serviceworker", timeout=15000)
                sw = ctx.service_workers[0] if ctx.service_workers else None
            assert sw, "extension service worker 没起来"
            sw.evaluate("() => true")

            # ---------- 配置：裸 host:port（客户端要自己补 http:// 与 /api） ----------
            status = sw.evaluate(
                "async ({api, token}) => __spore.syncConfig(api, token)",
                {"api": f"127.0.0.1:{port}", "token": TOKEN},
            )
            check("配置成功（/users/me 校验通过）", status.get("uid") == 7, status)
            check("地址归一（补 http:// 与 /api）", status.get("api") == API, status.get("api"))
            check("状态帧不含令牌", "token" not in status and status.get("hasToken") is True, status)

            # ---------- 设置页「服务器」卡（真页面，不只是存储） ----------
            ext_id = sw.url.split("/")[2]
            opt = ctx.new_page()
            opt.goto(f"chrome-extension://{ext_id}/options.html", wait_until="load")
            opt.wait_for_timeout(300)
            opt.click('.idx a[data-sec="cloud"]')
            opt.wait_for_selector("#cloudApi", state="visible", timeout=5000)
            check("设置页有「服务器」卡且可见", opt.is_visible("#cloudApi"))
            check(
                "地址回填（剥掉 /api）",
                opt.input_value("#cloudApi") == f"127.0.0.1:{port}",
                opt.input_value("#cloudApi"),
            )
            opt.wait_for_function(
                "() => !document.getElementById('cloudSync').disabled", timeout=5000
            )
            check("已配置时「立即同步」可用", opt.is_enabled("#cloudSync"))
            check("令牌不回填到页面", opt.input_value("#cloudToken") == "", opt.input_value("#cloudToken"))
            opt.screenshot(path=str(SHOTS / "sync-options.png"))
            opt.close()

            # ---------- 上行：本地会话 + 核实字段 + 首图 ----------
            sid = sw.evaluate(
                """async ({dataUrl}) => {
                    const { store } = __spore;
                    const s = await store.createSession({ title: '同步测试' });
                    const key = await store.putImage(s.id, 0, dataUrl);
                    s.messages.push({ role: 'user', ts: Date.now(), imageKey: key, text: '题目' });
                    s.messages.push({
                      role: 'assistant', kind: 'answer', no: '1', ans: 'A', why: '因为',
                      think: '想', verify: { ran: true, verdict: 'OK', note: '一致' },
                      tools: ['检索 x'], ts: Date.now(),
                    });
                    await store.saveSession(s);
                    return s.id;
                }""",
                {"dataUrl": data_url(IMG1)},
            )
            r1 = sw.evaluate("() => __spore.syncRun()")
            check("上行成功", r1.get("ok") is True and r1.get("up", 0) >= 1, r1)

            pull = http(API, "GET", "/sync/pull?cursor=0&limit=100")["data"]
            row = next((a for a in pull["articles"] if a["id"] == sid), None)
            check("服务端收到会话", row is not None)
            if row:
                msgs = row["messages"]
                check("服务端存的是超集字段（Mobile 能读的扁平 verify）",
                      msgs[1].get("verifyRan") is True and msgs[1].get("verifyVerdict") == "OK",
                      msgs[1].get("verifyRan"))
                check("首图走正式附件列", bool(row.get("attachmentPath")), row.get("attachmentPath"))
                left = http(API, "GET", f"/sync/pull-attachment?path={row['attachmentPath']}", raw=True)
                check("首图字节一致", left == IMG1, f"{len(left)}B vs {len(IMG1)}B")

            # ---------- 第二张图：合成 articleId（不抬行的 update_time） ----------
            time.sleep(0.05)  # 让本地 updated 严格大于服务端 upload_time（LWW 是严格大于）
            sw.evaluate(
                """async ({sid, dataUrl}) => {
                    const { store } = __spore;
                    const s = await store.getSession(sid);
                    const key = await store.putImage(sid, 2, dataUrl);
                    s.messages.push({ role: 'user', ts: Date.now(), imageKey: key, text: '追问带图' });
                    await store.saveSession(s);
                }""",
                {"sid": sid, "dataUrl": data_url(IMG2)},
            )
            r2 = sw.evaluate("() => __spore.syncRun()")
            check("第二张图同步成功", r2.get("ok") is True, r2)
            pull = http(API, "GET", "/sync/pull?cursor=0&limit=100")["data"]
            row = next((a for a in pull["articles"] if a["id"] == sid), None)
            extra = row["messages"][2].get("attPath") if row else None
            check("第二张图的 attPath 可预知", extra == f"{sid}-2.jpg", extra)
            if extra:
                left2 = http(API, "GET", f"/sync/pull-attachment?path={extra}", raw=True)
                check("第二张图字节一致", left2 == IMG2, f"{len(left2)}B vs {len(IMG2)}B")

            # ---------- 下行：远端会话 + 题图 ----------
            now = int(time.time() * 1000)
            remote = {
                "id": "remote-1",
                "categoryId": "",
                "title": "远端会话",
                "messages": [
                    {"role": "assistant", "kind": "answer", "ans": "B",
                     "verifyRan": True, "verifyVerdict": "OK", "hasImage": True},
                ],
                "fav": 1,
                "status": "done",
                "created": now,
                "updated": now,
                "deleted": 0,
            }
            http(API, "POST", "/sync/push", body={"categories": [], "articles": [remote]})
            up = upload_attachment(API, "remote-1", IMG3, "remote-1.jpg")
            r3 = sw.evaluate("() => __spore.syncRun()")
            check("下行成功", r3.get("ok") is True and r3.get("down", 0) >= 1, r3)

            local = sw.evaluate("async (id) => __spore.session(id)", "remote-1")
            check("远端会话落到本地", local is not None and local.get("title") == "远端会话", local and local.get("title"))
            if local:
                check("扁平核实字段还原成嵌套 verify", local["messages"][0].get("verify", {}).get("ran") is True,
                      local["messages"][0].get("verify"))
                key = local["messages"][0].get("imageKey")
                check("远端题图落成本地 imageKey", bool(key), key)
                if key:
                    got = sw.evaluate(
                        "async (k) => (await chrome.storage.local.get(k))[k]",
                        key,
                    )
                    check("本地图是 data URL", isinstance(got, str) and got.startswith("data:image/jpeg;base64,"),
                          (got or "")[:40])

            # ---------- 回声收敛：套用服务端行之后不该被当成本地改动重推 ----------
            conv = sw.evaluate("() => __spore.syncRun()")
            check("回声收敛：紧接着再跑一轮没有上行", conv.get("ok") is True and conv.get("up") == 0, conv)

            # ---------- LWW：更旧的远端改动不许覆盖本地 ----------
            stale = dict(remote, title="旧标题", updated=now - 5000)
            http(API, "POST", "/sync/push", body={"categories": [], "articles": [stale]})
            sw.evaluate("() => __spore.syncRun()")
            keep = sw.evaluate("async (id) => __spore.session(id)", "remote-1")
            check("LWW 拒旧：本地标题不变", keep and keep.get("title") == "远端会话", keep and keep.get("title"))

            # ---------- 删除：墓碑上行 ----------
            time.sleep(0.05)  # 墓碑 ts 必须严格大于行时间戳
            sw.evaluate("async (sid) => __spore.syncDelete(sid)", "remote-1")
            check("本地删除生效", sw.evaluate("async (id) => !(await __spore.session(id))", "remote-1") is True)
            r4 = sw.evaluate("() => __spore.syncRun()")
            check("墓碑同步成功", r4.get("ok") is True, r4)
            pull = http(API, "GET", "/sync/pull?cursor=0&limit=100")["data"]
            gone = next((a for a in pull["articles"] if a["id"] == "remote-1"), None)
            check("服务端收到墓碑（deleted=1）", gone is not None and gone.get("deleted") == 1,
                  gone and gone.get("deleted"))

            # ---------- 状态帧 ----------
            st = sw.evaluate("() => __spore.syncStatus()")
            check("状态帧记录上一轮结果", bool(st.get("lastSyncMsg")), st.get("lastSyncMsg"))
            check("状态帧无明文令牌", "token" not in st, list(st.keys()))

            if fails:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto(PAGE, wait_until="load")
                page.screenshot(path=str(SHOTS / "sync-fail.png"))
    finally:
        try:
            if ctx:
                ctx.close()
        except Exception:  # noqa: BLE001 - 上下文可能已因断言失败而断开
            pass
        static.terminate()
        mock.terminate()
        try:
            mock.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock.kill()

    print(f"\n断言 {len(fails) and '有失败' or '全过'}：失败 {len(fails)} 项", flush=True)
    if fails:
        print("失败：", "；".join(fails), flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
