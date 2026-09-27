# Spore 设计记录

> 2026-09-27 头脑风暴 → 用户确认 → 增量实现。本文记「为什么」，`README.md` 记「怎么用」。

## 一、需求原文要点

1. `Alt+S` 截图，鼠标框选松手后图片自动发到插件右侧边栏；边栏非常驻，发截图后自动弹出。
2. 左上角 `›` 收回 → 露一个半圆小角 `‹`；再点弹回。`Alt+Z` 弹出/收起（默认绑定 + 页面内 keydown 兜底）；设置页「快捷键」卡可**隐藏半圆小角**（默认不隐藏）。
3. 会话列表默认隐藏，露一个半圆小角 `💬`；**点击**气泡弹出列表（悬停不触发），点空白处或再点气泡收起。
4. 自动起名：标题 = `题号 + 题目大意`（大意由阶段A 协议的 `TITLE` 行顺带吐出，**零额外模型调用**；模型失效回退答案前 14 字）。会话自己的时间戳以小字显示在列表行标题下方。
5. Agent（不是单纯 LLM）要配联网搜索（对应 Fungi 的 `web` / `web_search`），应对不确定/时效性问题。
6. **先快再准**：先给答案 + 简要解析 → 搜索核实 → 给核实结果（初答错了再给正确解析）。回答简洁不啰嗦。
7. 生成时滚动条不跟随，用户移到哪就固定在哪；答完右下角弹小通知，稍后消失。
8. 会话异步并发；通知未查看 → 会话列表红点。
9. 每个会话有自己的输入框，可接着追问。

## 二、调研结论（实测）

| 事实 | 数据 |
|---|---|
| Edge | 154.0.4258.37，MV3 / `chrome.sidePanel` / SW 内 `OffscreenCanvas` 全支持 |
| `deepseek-v4-flash-vision-exp` | 视觉作答 **首字 1.80s**；**function-calling 流式/非流式都支持**（0.74–1.14s，能并行发多个 tool_call） |
| `mimo-v2.6-flash` | 带图首字 **26.9s**（思考耗时），纯文本 tool_call 1.5s → 不适合「先快」 |
| 检索可达性 | `cn.bing.com` 200（HTML 10 条 `b_algo` + `format=rss` 10 条干净结果）；搜狗返回 5KB JS 壳；百度人机验证；DuckDuckGo/Brave/Startpage 全部超时；全局 `bing.com` 429 |
| 自有扩展 | 不存在（`chrome-mv3-prod` 是第三方「大学搜题酱」，只作 UX 参照） |
| Fungi 抽屉 | 桌面端是常驻 sidebar（`margin-left -.4s`），移动端 `m.css:134` 才是真抽屉（`translateX` + scrim）；**没有半圆小角、没有页内 toast、没有页内会话列表** —— 这三样要新写 |
| Fungi 滚动 | `isNearBottom(el) < 60px`（`web/app.js:25`）+ 写入前测、写入后 pin（`585/682`），写入层再兜一次（`common.js:1217`） |
| Fungi 会话 | `data/sessions/<id>.json`，id=`YYYYMMDD-HHMMSS`，标题取首条用户文本截 47 字（`session.py:85-93`），**无 LLM 起名** |
| Fungi 流式 | fetch reader 按行 NDJSON（`app.js:544-558`），断线用 `/events` 回放续播 |
| Fungi 视觉 token | accent `#ec4899` / 暗青 `#2dd4bf`、radius 14/10/6/18、fs 11.5/12.5/14.5/17、`--ease-out-expo = cubic-bezier(.16,1,.3,1)`、transition 150/250/380ms |

## 三、五个决策（用户确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 面板载体 | **注入式抽屉（Shadow DOM）** | 半圆小角、💬 角标、页内 toast 只有注入式能做；原生 `chrome.sidePanel` 只能整体开关 |
| 后端形态 | **纯扩展**（SW 直连 API） | 联网能力本来就是 HTML 抓取，JS 可等价移植；免去常驻后端/端口/生命周期 |
| 模型 | **全程 `deepseek-v4-flash-vision-exp`** | 1.8s 首字 + 支持 function-calling，一家搞定视觉与工具 |
| 检索 | **只做 HTML/RSS 抓取** | 零 key、零成本；你的网络也只有 cn.bing 可用 |
| 数据 | **本地存储 + 磁盘镜像** | `storage.local` 为主，`chrome.downloads` 镜像 markdown + 截图到 `Downloads/Spore/sessions/<日期>/` |

## 四、两阶段 Prompt 结构

- 系统：`「先结论后依据，不复述题目，不客套，中文，LaTeX，拿不准就说」`
- 阶段A：严格五行 `NO:` / `TITLE:` / `ANS:` / `WHY:` / `CERT:` —— 关键行解析失败就把整段当答案兜底。
- 阶段B：`VERDICT: OK|FIX` + `NOTE:`；明确「纯计算题可以不检索」，否则先 `web_search`（最多 N 轮）再 `web` 深读。
- 起名：阶段A 协议第五行 `TITLE`（≤12 字大意）→ 本地拼 `题号 + 大意`，**零额外模型调用**；`TITLE` 缺失回退答案前 14 字，`ensureNamed` 收尾兜底（同样纯本地）。

## 五、滚动策略（与 Fungi 的差别）

Fungi 是「贴底就跟随，上滑就锁定」。本项目按需求改成：**流式期间完全不跟随**，
只在两个时刻定位——① 发问后、② 阶段A 开始时，把题目块对齐到滚动容器顶部（这样答案在下方生长，
用户既不用追着滚、也不会被打断阅读）。`↓` 按钮负责手动回底。

## 六、坑与解法

| 坑 | 解法 |
|---|---|
| shadow 树里 `#host` 选择器**匹配不到宿主元素**（宿主在外部树） | 用 `:host` / `:host(.closed)`；再叠一层内联 `cssText`（文档样式对宿主优先级更高，页面 CSS 可能覆盖） |
| 内联 `all:initial` 写在最后会把前面的定位属性一起重置 | `all:initial` 必须排在声明块最前 |
| JS 正则不支持 PCRE 的 `(?is)` 内联标志 | 改 `/…/gi` + `[\s\S]` 匹配换行 |
| `chrome.commands` 与页面 keydown 双通道会截两次 | SW 记 `lastCaptureAt`，400ms 内去重 |
| MV3 SW 空闲 30s 被回收，流式回合会断 | 抽屉端口每 5s 上报一次 `view`（同时延长 SW 生命周期）；残留 `answering` 状态在 `init()` 判为「已中断」亮红点 |
| 流式期间每 1.2s 落盘会撞 storage 写频率配额 | `schedulePersist()` 节流 1.2s，回合结束强制落盘 |
| 抽屉会进自己的截图 | 抓帧**之前**先发 `spore:before-capture` 把抽屉藏起来，抓完再 `spore:after-capture` |
| 异步起名后标题被改回「解析中…」 | 在途回合的 `sess` 还攥着旧 title，下一次 `saveSession` 把索引写回去 → `store.titleOverrides` 统一覆盖 |
| LLM 流卡住不吐字会让整回合永远挂起 | `readWithIdle()` 空闲看门狗 60s，超时按可重试错误处理（每块 chunk 重置） |
| 测试里「磁盘镜像没落盘」 | Playwright 把 `download.default_directory` 接管到自己的临时目录 —— 真机上会正常落到 `Downloads/Spore/sessions/<日期>/`；用 `chrome.downloads.search()` 断言内容 |
| `document.elementFromPoint()` 在 shadow 边界只返回宿主 | 用它做遮挡判定时必须穿透 shadowRoot，否则会误判成「元素不可点击」 |

## 六b、第二轮反馈与修掉的坑

| 反馈 | 落地 |
|---|---|
| 半圆要「收起时向外凸出（矩形之外）、展开时压在矩形上」，且在左上角 | 同一个 `#toggle` 用 `left: 0 → -22px` + `border-radius` 左右翻转实现，0.42s 同步过渡 |
| 会话入口改圆形气泡，抽屉收起时不显示 | `#sessions` 改成 header 里的 34px 圆形；`#root:not(.open) #sessions{display:none}` |
| 字体太小 | 正文 14→15.5px、答案 15→17.5px、标题 13.5→15px，面板 400→420px，间距/控件同步抬升 |
| 初答要「不思考直接回答」 | 实测 6 种写法：`reasoning_effort=none` 与 `thinking:{type:disabled}` 能把思考归零（`reasoning:{type:disabled}`、`enable_thinking:false` 无效）；`llm.js` 发 noThink，端点报 400 自动降级 |
| 要选择性核实 | Phase A 加 `CERT` 行，`<<ok>>` 守卫跳过核实；UI 标明「已跳过」 |
| CoT 要显示 | reasoning 与正文**分流**（混进正文会变成 "We need answer user…"），`.think` 块可折叠、默认展开 |
| 下载列表会弹 | 默认**不走下载**：选了静默目录 → FSA `createWritable()` 直写；没选 → 不落盘也不弹（可选回落） |
| 答案会从存储里消失 | 根因：每个写入方都「重读一份再写回」，读到 1.2s 前的陈旧副本 → `beginTurnSession()` 把在途对象设为唯一事实源 |
| `flushSave` 没挂起就直接返回 | 改成「无论有无挂起都写一次」，否则 verify/status 的最后改动永远写不下去 |
| 旧 profile 复用时改了代码不生效 | `<profile>/Default/Service Worker/ScriptCache` 缓存旧脚本；删目录或重载扩展 |
| `window.__sporeDrawer` 在 `page.evaluate` 里读不到 | content script 跑在**隔离世界**，window 属性不共享（DOM 共享）→ 断言改用 `#title` 等 DOM |
| `chrome.runtime.openOptionsPage is not a function` | 该 API 不在 content script 里 → 发消息给 SW 代开 |
| 设置页 `TypeError: null.textContent` | 改镜像栏时删了 `#rootEcho` 却还在写它 → 加回 + 统一走 `setText()` 空值保护 |
| `Not allowed to load local resource: edge://extensions/shortcuts` | 扩展页里 `href="edge://…"` 被当本地资源拦 → `chrome.tabs.create()` 打开 |
| `Unable to download all specified images` | 图片 **data: URL** 直接进 `downloads` 会被拒 → 先转 `blob:` URL；镜像三件套一律吞异常返回状态，不把 rejection 抛到调用方 |
| 起名兜底没生效 | `ensureNamed` 用了**动态 `import()`**，而 ServiceWorker 里被 HTML 规范禁止 → 改成顶部静态导入 + 只用本地信息起名 |
| 删除当前会话后抽屉空转、点历史会话无响应 | `pickFirst`↔`syncIndex` 互递归：`syncIndex` 尾巴拿**旧 sid** 调 `syncSession` → 找不到会话又回 `pickFirst`，`openSession(index[0])` 永远到不了 → `pickFirst` **先清 sid 再同步**（顺带指到最近会话），`storage.onChanged` 里当前会话 key 消失也兜底 `pickFirst` |
| 快捷键要手设 | manifest 的 `suggested_key` 在扩展加载时自动绑定（全新 profile 实测 `commands.getAll() → Alt+S`）；只有被别的扩展占用或被手工覆盖过才需手动改 |
| **系统通知从来不弹 / 报 `Unable to download all specified images.`** | `notifications.create` 的 `iconUrl` 写**相对路径**（`icons/128.png`）会走图片下载管线被拒 → 改 `chrome.runtime.getURL('icons/128.png')`。实测：相对=抛错、绝对=成功、data:=成功、不给图标=create 返回 id 但通知不落盘 |
| 抽屉收起后系统通知与红点都不出现 | `visible()` 原来只看页面焦点，收起的抽屉也算「正在看」→ `settleTurn` 判 seen=true，把通知和红点一起吞掉 → `visible()` 必须含 `state.open`，且 `setOpen()` 立刻 `reportView()`（别等 5s 心跳） |
| 框选层一滚动就退出 / 滚动穿透很卡 | 穿透方案 = 每次滚动停就 `captureVisibleTab` 重截回灌，实测卡 → **已回退**为「滚动即取消」原设计；只保留「框太小」判定（宽高**都**小于下限才拒，有其一过线就放行） |
| 仓库里混进真实 API key | 曾把 DeepSeek key 写死在 `DEFAULT_SETTINGS` 里（推公开仓前扫描抓到）→ `apiKey` 恒为 `''`，密钥只存 `spore.settings`（设置页写）；e2e 从 `SPORE_E2E_KEY` 环境变量或 gitignore 的 `tests/_run/e2e_key` 注入，且断言在第一次 capture 之前写入 |
| 隐藏半圆小角把收起把手也藏了 | 用户初衷只是「**收起时**别遮网页」→ 开关只作用于收起态（`#root.hide-toggle:not(.open)`），展开态的收起把手永远在（否则没法点收回，而且抽屉本身就遮网页了）；收起态靠 Alt+Z 唤出 |

## 七、增量实现与验证

1. P1 骨架与检索：manifest、`llm.js`、`tools.js`、`store.js` —— 四个模块 node 语法/链接检查通过。
2. P2 截图链路：`sw.js` 抓帧 → `overlay.js` 冻结帧框选 → `OffscreenCanvas` 裁剪压缩。
3. P3 抽屉 UI：半圆小角、消息流、输入框、滚动策略、toast。
4. P4 Agent：两阶段 + 起名 + 红点 + 并发 + 中断恢复。
5. P5 设置页与真机自测：`tests/e2e.py` 用 Playwright **无头**驱动真实 Edge（`--load-extension`）
   跑两道题（数学快答 / 事实题联网核实）+ 手动核实路径，60+ 项断言 + 截图取证；现场在 `tests/_shots/`。

## 8 关键坑（本轮）

| 现象 | 根因与修法 |
|---|---|
| 设置页的确认框跑到**浏览器正中** | `#root`（整屏 absolute 层）带 `transform`，其后代上的 `position:fixed` 会以**整屏**为参照。要「侧边栏内居中」必须放进 `#panel`（`position:relative`，就是侧边栏本身）并用 `position:absolute; inset:0` —— 断言也要对着 `#panel` 量，对着 `#root` 量是同一件事，等于没测 |
| 会话名停在占位 | 默认标题不再用占位串，直接用 `stampTitle()`（日期+时分）；题号/大意起名只是**升级**，即使全失败也不会露出占位 |
| 系统通知静默失败 | `iconUrl` 必须绝对 URL（见上表）；`notifications.create` 的 Promise 失败也要手动 `.catch` 落日志 |
