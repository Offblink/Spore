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
| 检索可达性（2026-09-27 首测） | `cn.bing.com` 200（HTML 10 条 `b_algo` + `format=rss` 10 条干净结果）；搜狗返回 5KB JS 壳；百度人机验证；DuckDuckGo/Brave/Startpage 全部超时；全局 `bing.com` 429 |
| 检索可达性（2026-09-28 复测，Clash rule 模式 + 系统代理） | **结论既看环境也看节流窗口**：① bing 走代理**能用但会节流**——本轮探针轰炸（约 20 次查询）之后，同一出口返回「没有结果」页（0 `b_algo` + `b_no`）和空 RSS；几分钟后自愈（同日 e2e 里「只走 bing」就拿到真结果，模型据此把答案改对）。**直连**同一查询 10 条 `b_algo`。② ddg 走代理时：脚本客户端能拿 33KB 真页/9 条锚点，而**浏览器 fetch（无头、有头都试）拿到 202 质询页**（14KB、0 条）——按客户端指纹拦，扩展侧改不了。③ brave 429。④ 国内引擎走 `GEOIP,CN,DIRECT` 直连：360 搜索 553–1075ms、7 条可解析命中（备选方案，本轮未采用）。 |
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
| 检索 | **只做 HTML/RSS 抓取**（2026-09-28 起：引擎链 `ddg→bing→brave` + 三道闸，同步 Fungi §71） | 零 key、零成本；走哪套引擎由设置页「检索代理」字段声明（填了 ddg 打头，留空只走 bing）——扩展读不到系统代理，这是 Fungi 注册表判断的替身 |
| 数据 | **本地存储 + 磁盘镜像** | `storage.local` 为主，`chrome.downloads` 镜像 markdown + 截图到 `Downloads/Spore/sessions/<日期>/` |

## 四、两阶段 Prompt 结构

- 系统：`「先结论后依据，不复述题目，不客套，中文，LaTeX，拿不准就说」`
- 阶段A：严格五行 `NO:` / `TITLE:` / `WHY:` / `ANS:` / `CERT:` —— **WHY 排在 ANS 前面**（先把解析想清楚，答案照解析落），协议里明写「ANS 必须与 WHY 结论一致」；关键行解析失败就把整段当答案兜底。落库前 `contradicts(ans, why)` 再检一遍极性（`A（对）` vs `故该说法错误`），打架就**不许走 `<<ok>>` 跳过核实**。
- 阶段B：`VERDICT: OK|FIX` + `ANS:`（仅 FIX：修正后的答案本体）+ `NOTE:`；明确「纯计算题可以不检索」，否则先 `web_search`（最多 N 轮）再 `web` 深读。判 FIX 时用 `ANS` 覆盖答案行，保证答案行与最终结论一致。
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
| 截图内嵌在会话对象里 → 每次落盘**重写全部历史图片**（实测 2~3× 写放大），且 `storage.onChanged` 把含图片的整份新值广播给每个标签页 | 图片单独成键 `spore.img.<sid>.<idx>`、**只写一次**，消息里只留 `imageKey`；发请求/渲染时才 `getImage()` 取回 data URL（抽屉按需填 `img.src`，加载前用 `:not([src])` 占位）；老会话由启动 sweep 幂等迁移 |
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
| 要收藏会话，但顶栏已经装不下、列表又逼仄 | **顶栏一个都不许去**：`#fav` 做成 26px 无底色的 ⭐（常显，未收藏时灰化），夹在 `💬` 与标题之间，标题 `flex:1` 照常省略号。收藏只切 `fav` 字段（`store.setFavorite` → `patchIndex`，与 `unread`/`status` 同一条路，不碰消息正文），抽屉靠 `storage.onChanged` 重排。列表 `#listpop` 从 292px 铺到近满宽 396px（面板 420、左右各留 12px），行内从左到右 = 星标 / 标题+时间（两行）/ 未读点 / 悬停显形的 `✎` `×`；收藏行**置顶**、淡金底、星标常显金色，行内点星只切收藏（`stopPropagation`，不许顺手打开会话） |
| 答案行写「A（对）」、解析却说「说法错误」（用户截图） | 三处成因一起堵：① 阶段A `noThink` 不给推理、ANS 又排在 WHY 前 → 协议把 WHY 提到 ANS 前并明写一致性；② `<<ok>>` 守卫把核实整个跳过 → 新增 `contradicts(ans, why)`（极性自检，只对「`A（对）`/`B（错）`」这类判断题判、括号是数值/字母就不判），打架即作废跳过捷径、强制进阶段B，日志留 `初答自检矛盾`；③ 阶段B 判 `FIX` 时用它的 `ANS` 行覆盖答案行。离线契约钉在 `tests/answer.test.mjs`（e2e 开头与 `search.test.mjs` 一起跑） |

## 六c、第三轮反馈（2026-09-29 晚）

| 反馈 | 落地 |
|---|---|
| 「点了变黑？不应该是变粉吗」 | 星标原来用 emoji `⭐` + `filter: grayscale(1)`，**颜色由系统 emoji 字体决定**，同一份 CSS 在不同机器上能渲成黑/金 → 改用字符 `★` + `color` 自己给：收藏 `#ec4899`（hover 深一档 `#db2777`）、未收藏 `#b3b8cd`；顶栏与行内同一套。收藏再加 toast 反馈（`已收藏 / 已取消收藏`），点按钮还要弹提示 |
| 「别置顶了，累积了就找不到最新会话」 | `renderList` 去掉 fav-first 重排，**收藏只标记不置顶**（行序 = 索引序 = 最新在前）；要只看收藏去整页审查里筛。`favs/rest` 那段补满 60 条上限的逻辑一并删掉 |
| 「删除或重命名后不要关会话列表」 | 两处关列表的来源都堵：① `document` 兜底点击把**模态内的点击**（确认/取消/遮罩）也当「点空白」→ 加 `#confirm`/`#rename` 白名单；② 删掉当前会话后 `pickFirst → openSession` 会收列表 → 加 `keepList` 选项，删除触发的顺位切换不收 |
| 「专门开发一个整页做题目审查……构造和 Fungi 基本一致」 | 新增 `review.html` + `src/review.js`：外壳 `flex`（左 `#sidebar` 固定 280px、`.collapsed` 用 `margin-left` 滑出，右 `#main{flex:1}` **宽度自动跟随**）；左列表带 `全部 / 收藏` 分段筛选，右历史复用 `src/lib/md.js`（抽屉与整页共用一份 markdown 语义，manifest 里排在 `drawer.js` 前） |
| 「收进去用 <、拉出来用 >」→「箭头方向反了」 | 收放按钮**跟动作方向**走：展开态 `<`（点了往左收）、收起态 `>`（点了往右拉），与抽屉半圆小角同一口径；不用三横 `☰` |
| 「点搜题记录直接跳新链接，不要显示在设置界面右边」 | 设置页索引第一项 `data-jump` **直通 `review.html`**（`chrome.tabs.create`），右侧不留任何搜题记录分页；索引里用 `.gap` + `应用设置` 分组标签与下面四张卡拉开间距。同时「Spore 设置」改名 **「Spore 主页」**（抽屉 `⚙` 的 tooltip 一并改） |
| 「删除与重命名、甚至下方输入框也要（copy）进去」 | **复制不是搬走**：整页里行内 `✎`/`×` + 居中确认/重命名模态、底部输入框（Enter 发送、流式期间禁用）全都有；协议复用 SW 的 `rename`/`delete`/`ask`，并开一条与抽屉同名的 `spore` 端口收 `ev` 流式事件就地更新（回合内 1.2s 落盘不整份重绘，避免打断思考块与滚动） |
| 「点会话里的截图开到一个空网页」 | `window.open(dataURL)` 在现代浏览器里就是空白页 → **直接禁用截图点击**（抽屉与整页两处都去掉监听），放大看细节交给 Edge 自带缩放 |

## 六d、第四轮反馈（2026-10-01）

| 反馈 | 落地 |
|---|---|
| 「工具不只是没收到 `<<ok>>` 就搜索的触发器，还是一个 agent 可以随时调用的工具 —— 追问说『再查一下』，他不该说查不了，而是真的再去查」 | 根因：`agent.js` 追问分支只发**一次不带 `tools` 的 `streamChat`**，模型手里根本没有 `web_search`/`web`（工具循环只存在于阶段B）。修法对齐 Fungi `agent.py` 的「每轮对话都带工具注册表」：① 追问分支改成同一套工具循环（`TOOLS` + `dispatch` + 轮次预算 + 轮次用光强制收尾），轮次取 `max(1, settings.maxToolRounds)` —— 设置里那个 0 关的是「自动核实」，不是「永远不许查」；② `SYSTEM` 明确声明两个工具与「用户要查就查、绝不回『我查不了』」；③ chat 消息行补 `[data-slot=tools]` 槽位（抽屉 `case 'tool'` 原来找不到槽位会静默丢 chip），抽屉与整页重渲染都恢复 `m.tools`；④ 思考跨轮拼 `thinkBase`（每轮 acc 从零开始，不接基线会把上一轮思考整段冲掉），日志留 `chat tool loop start`。设置页 `maxToolRounds` 标签同步改口径（0 = 不自动核实，追问仍可查 1 轮）。e2e 加 3 条断言：日志行 / 新 chat 行出现工具 chip / 回答是中文且没推说查不了 |

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
| **检索全挂、门禁却全绿**（上轮 e2e 实测 6 次检索全 `ERROR: search failed (empty results)`，出答案照过） | 两层原因：① 断言只数工具 chip（chip 在 dispatch *之前* 推出），从没看检索结果；② 只有一条 bing 腿，而 bing 在该出口被节流成「没有结果」页。修法：同步 Fungi §71 的三腿 + 三道闸、加「检索代理」开关（填了 ddg 打头），离线用 `tests/search.test.mjs` 钉死三道闸，e2e 再断言返回只有三态（`1.` / `(no results` / `ERROR: Search failed`） |
