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
| 「搜题记录页面点收藏（两处）没有像抽屉那样的弹出提示」 | 根因：抽屉的提示是 `setFav()` 本地 `showToast` 弹的（SW 的 `favorite` 分支只写存储不广播 toast），整页的 `toggleFav()` 压根没有 toast 实现。修法：`review.html` 加 `#toasts` 容器 + 抽屉同款 toast CSS（右下角飞入、3.6s 自动收、`prefers-reduced-motion` 里同步禁动画）；`review.js` 加 `showToast()`（点击打开该会话，已是当前会话则只收起）并在 `toggleFav()` 里弹 —— 顶栏 ★ 与行内 ★ 两处入口都汇到 `toggleFav`，一个调用点全覆盖，且 SW 不广播故抽屉与整页不会重复弹。e2e 加 6 条断言：顶栏/行内 × 收藏/取消 × （状态落存储 + 弹提示），行内点两次复原不污染后续用例 |

## 六e、第五轮反馈（2026-10-02）

| 反馈 | 落地 |
|---|---|
| 「搜题记录页全部列表顶部加『新建科目』，命名后该科目（目录形态）置顶，可以直接拖会话进科目；空科目点开是（空），有会话点开弹会话，再点收回」 | 三段接线：① **存储**（`store.js`）新增 `spore.subjects`（`{id,name}` 数组，创建越早越靠上）与四个函数 `listSubjects`/`createSubject`/`deleteSubject`/`assignSubject`——归属记在 `spore.index` 条目上的 `sub` 字段（`null`=未归类），**只动索引不动会话正文**，仍由 SW 单写者；② **SW** 的 `handleContent` 加 `subject` 消息（`create`/`assign`/`rename`/`delete` 四个 op，日志行 `subject create/assign/rename/delete`），两个面都靠 `storage.onChanged` 收 `spore.subjects` 与 `spore.index` 的变化，不新增端口事件；③ **整页**：`.sb-head` 加 `#newSub` 按钮 → `#subnew` 命名模态（与重命名同一套 `.box/.acts` 交互，Enter=创建、Esc=关），`renderList` 拆成 `buildRow`/`buildFolder`——科目行 `.sub`（CSS 画的粉色文件夹 + `▸` 展开箭头 + 会话数徽标 + 悬停 `×`）一律排在会话行之前，展开后成员行 `.row.in` 缩进 22px 并带左引导线，**空科目展开显示「（空）把会话拖到这个科目上」**，再次点击收回；展开状态存 `localStorage`（`spore.review.subopen`）。拖放走原生 HTML5 DnD：行 `draggable`，`#list` 上统一 `dragover/drop`（`state.dragSid` + `dataTransfer` 双保险），落点解析成 `closest('.sub, .row.in, .subempty')` 的 `dataset.sub`——落到科目上/科目内/（空）提示 = 归入，落到列表其它位置 = **移出**，命中时给科目行加 `.dz` 高亮。删科目复用居中确认框（`pendingDelete` 改成 `{kind:'sess'\|'sub'}`，文案换成「里面的会话只是移出，不会删」），删完成员自动解除归属。收藏视图不摆科目（按星标平铺）。e2e 加 13 条断言（命名框弹出 / 科目置顶且落存储 / 空科目弹（空）不吞会话行 / 收回再展开 / 真拖（Playwright `drag_and_drop` 走 CDP，`dataTransfer` 是真的）归入 + 索引落 `sub` + 数目徽标 / 拖出 / 删科目留会话） |
| 「顺便加个科目重命名」 | 复用会话那套重命名模态，只换口径与路由：`review.html` 的模态标题加 `id="renameTitle"`；`state.pendingRename` 从裸 sid 改成 `{kind:'sess'|'sub', sid, title}`，`askRename`/`askRenameSub` 分别把标题写成「重命名会话 / 重命名科目」，`commitRename` 按 `kind` 分流——会话仍发 `rename`，科目发 `subject` 的 `rename` op（`store.renameSubject(id, name)` 只改 `spore.subjects` 里的 `name`，不动成员与索引，日志行 `subject rename`）。科目行尾加悬停 `✎`（`.sr`，与 `.sx` 同一套显隐/配色）。e2e 加 4 条断言：弹框且口径是科目 / 列表行同步 / 落存储 / 重命名不动成员归属 |

## 六f、报错修复：`Unchecked runtime.lastError`（端口被 bfcache 关掉，2026-10-02）

| 现象 | 根因与修法 |
|---|---|
| 控制台 / 扩展管理页刷 `Unchecked runtime.lastError: The page keeping the extension port is moved into back/forward cache, so the message channel is closed.` | **根因**（Chromium 源码 `extensions/browser/api/messaging/extension_message_port.cc`）：页面被搬进往返缓存（bfcache）时，`ContextTracker::DidFinishNavigation` 走 `UnregisterFramesUnderMainFrame(previous_rfh, kClosedWhenPageEntersBFCache)` 把整条消息通道关掉，错误串就是 `kClosedWhenPageEntersBFCache`；这个原因被挂在**断连回调里的 `chrome.runtime.lastError`** 上，回调不读它 → Chrome 打 `Unchecked runtime.lastError: …`。**实测**：在 `onDisconnect` 里读 `chrome.runtime.lastError?.message`，拿到的正是这句话（SW 日志行 `port 断开 tab=…`）。**修法**：三处 `port.onDisconnect` 同步消费掉 —— `src/content/drawer.js`、`src/review.js`、`src/sw.js`（SW 侧顺手落进日志环，设置页「日志」卡能直接看到是谁关的） |
| 顺带发现：bfcache 之后抽屉的端口**再也不重连**（探针实测 SW 侧端口数掉到 0），抽屉从此收不到流式事件 | 原实现只靠 `onDisconnect → setTimeout(connect)`，而文档进 bfcache 后是被冻结的，回调/定时器都可能不跑。修法四件套（`drawer.js` 与 `review.js` 同构）：① `pagehide` 主动 `port.disconnect()`；② `pageshow(e.persisted)` 主动 `connect()`；③ `suspended` 标志 —— pagehide 到 pageshow 之间 `post()`/`connect()` 一律直接 return，否则**垂死文档里补开的口会变成 SW 永远关不掉的孤儿端口**（探针实测过：不加就攒到 2 个/页）；④ `onDisconnect` 里 `if (port !== p) return` —— 晚到的旧口断连回调不许把刚建好的新口踢掉 |
| **复现/验收口径**（不进 e2e 门禁，e2e 不测 bfcache） | 回归脚本：**`python tests/bfcache.py`**（独立 profile、端口 8898，8 条判据，约 15s；本仓实测：带修复全绿 exit 0，`git stash` 摘掉修复后 4 条 FAIL exit 1）。Playwright 默认带 `--disable-back-forward-cache`，不摘掉就永远复现不出来：`launch_persistent_context(..., ignore_default_args=["--disable-back-forward-cache"])`，再用 `page.goto(另一页) → page.go_back(wait_until="commit")`（**必须 `commit`**：bfcache 恢复不触发 `load`，默认 `load` 会挂到超时）。判据三条：往返后 SW `__spore.ports()` 仍是 1 个/页（无孤儿）、`spore.log` 里有 `port 断开 tab=…：The page keeping…`（原因被消费且留痕）、bfcache 前后各发一次 `ask` 都能收到 `settleTurn` 广播的 toast（**toast 只走端口，storage 里没有等价信号**，所以它能证明 SW→页面这条方向真的通；探针里 `ask` 只走纯文本追问分支，空 key → 401 → `failTurn`，不依赖模型出字） |

## 六g、第六轮反馈（2026-10-03）

| 反馈 | 落地 |
|---|---|
| 「mv3 的搜题记录页面少了停止生成按钮」 | 抽屉顶栏一直有 `■`（`post({type:'stop'})` → SW `stopTurn()` → `AbortController.abort()`），整页 `review.html` 却只有**禁用的输入框 + 「回答生成中…」占位**，回合跑起来没有任何出口（追问一发就只能干等）。修法是**纯复制、不碰抽屉**：① `review.html` 的 `#composer` 在 `#send` 后面加 `<button id="stop" hidden>■ 停止生成</button>`（白底红边 `#d02747`，与删除 `×` 的悬停同色），`#stop[hidden]{display:none}`；② `review.js` 的 `updateComposer()` 里 `$('#stop').hidden = !state.streaming` —— 与 `input.disabled` **同一个状态源**（忙以存储 `status` 三态为准，端口 `chat-start`/`answer-start` 只让它更快），所以不会出现「按钮亮着但其实早停了」；③ 点击发 `stop`，SW 落 `aborted` 后 `storage.onChanged → syncBusy()` 自然收起按钮并解锁输入框，两条收尾路径（端口 `turn-end` 与存储 `status`）互为兜底。e2e 加 5 条断言：空闲收起 / 生成中出现且输入框禁用 / 点掉后输入框恢复 / `status=aborted` / 停止后按钮收起（176 → 181） |

## 六h、第七轮反馈（2026-10-05）

| 反馈 | 落地 |
|---|---|
| 「整页搜题记录加涂抹多选，完全参照移动端实现（多选 + 批量收藏/移入科目/删除）」 | 参照本机已 clone 的 Spore-Mobile `record.js`（1-450 行）移植进 `src/review.js` + `review.html`。**手势语义逐条对齐**：长按 500ms 进模式（10px slop 越过即撤销，选中被按那张卡、收尾 click 被 `suppressClick` 吃掉）；涂抹只认单选框 `.ck` 起笔（`.ck` 排行首、仅模式显示，`pointerdown` 必须 `preventDefault` —— 行是 `draggable`，不拦就触发 `dragstart`），卡片其余区域的拖动仍留给滚动/拖科目；起笔在已选卡上 = 本笔先取消，中途折返 = 方向翻转、新段从拐点起算；模式内单击卡片 = 勾选（行点击从逐行监听改成 `#list` 上的统一委托，`suppressClick` 才有统一消费点）；选中集 `selected` 每次 `renderList` 按 `state.index` 裁剪（storage.onChanged 路径同口径）、裁空即退模式，重绘后按它回放 `.on`。**批量操作全走已有 post 协议**：批量收藏全已收藏则统一取消、否则把没收藏的都收上，且**只弹一条 toast**（`showToast`，单条 `toggleFav` 会 N 连弹）；移入科目是新居中模态 `#subpick`（样式照 `#confirm` 的 `.box`，列「移出科目」+ 全部科目、标题带条数，只发 `subject assign`，不做科目增删改）；批量删除复用 `#confirm`、文案带条数、确定后逐条 `delete` 并退出模式。退出三条路：底栏「取消」/ Escape（追加在既有模态优先级链之后）/ 模式里换筛选（全部/收藏）。底栏 `#batchbar` 隐藏常态、贴侧栏底，计数「已选 N 项」、选中 0 个时三个操作禁用；侧栏 `.sb-head` 与顶栏一概不动（**本轮稍后返工**：入口改成 `.sb-head` 的「批量选择」按钮，见下一行）；`.sub` 科目行不参与多选。**顺带修掉两个被批量场景暴露的真 bug**：① `store.js setIndex` 是 get→mutate→set 的读改写，SW `handleContent` 不 await，批量消息背靠背进来会读到同一份旧快照、后写盖前写（实测批量两条必丢一条）—— 用一条 Promise 链把临界区串行化；② `setSelecting(false)` 只清集合不清 DOM 上的 `.on` 残影，退出即摘干净。e2e 加 29 条离线确定性断言（长按进模式 / 涂抹跨行 / 起笔已选先取消 / 折返换向 / 模式内单击 / 移入弹层 / 批量收藏单 toast 且落存储 / 确认框带条数与取消 / 三条退出路），`python tests/e2e.py` 全绿 210 条（181 → 210） |
| 「不是长按，而应该是按钮『批量选择』按下后进入的」（多选入口返工） | `.sb-head` 加常驻按钮 `#selBtn`「批量选择」（与 `#newSub` 并排、共用同一套虚线样式；进模式后自己变「退出选择」+ 粉底白字，再点一下退出），**0 选起手**——不自动勾任何卡。长按进模式的代码整块删掉：`HOLD_MS`/`SLOP`/`holdTimer`/`holdRow`/`holdX`/`holdY`/`held` 与 `pointerdown`/`pointermove`/`endStroke` 里的对应分支一并清除，`suppressClick` 只剩涂抹收笔那一下；`.ck` 起笔涂抹、折返换向、模式内点卡勾选、选中集裁剪、批量三件全部照旧。**连带改一处语义**：`renderList` 的选中集裁剪只有**真被裁掉东西**才「裁空即退模式」，否则 0 选刚进模式就被一次 storage 重绘踢出去。退出变成四条路：按钮再点 / 底栏「取消」/ Escape / 换筛选。e2e 把「长按 700ms 进模式」那 4 条断言改写成「点 `#selBtn` 进模式（0 选 + 批量三件禁用 + 文案变『退出选择』）→ 点卡片勾选 → 底栏计数『已选 1 项』+ 不切换会话」，另加 1 条「模式里再点按钮退出」，涂抹与批量断言原样保留（断言 210 → 212） |
| 「从网页把图拖进问问题的地方 → 当作截屏回合处理」（新特性） | SW 新消息 `{type:'fetch-image', url}`：校验 `^https?://` → `fetch`（15s 超时、20MB 上限、`blob.type` 必须 `image/`）→ 转 data URL → `fetchImageTurn()` **复用截屏那条起回合链路**（`createSession` → `putImage` 独立键 → `saveSession` → `mirrorImage`/`mirrorSession` → 广播 `session-created` → `startTurn`），没有框选就没有「框太小」判定；回合用 `void startTurn()` 起跑，消息通道不为一个跑几分钟的模型回合一直开着。失败（非 http(s) / 下载失败或超时 / 超过 20MB / 不是图）落日志 `fetch-image 失败`，并广播既有 `toast` 给抽屉，同时把错误抛回端口与 `sendMessage` 两条通道。入口两处：抽屉 composer 与整页 `#composer` —— `dragover` 一律 `preventDefault()`（不拦浏览器会直接把 URL 当导航打开），`drop` 依次取 `text/uri-list` → `text/html` 里抠 `<img src>` → `text/plain`，非 http(s) 就地弹提示、不发消息。e2e 加 5 条离线确定性断言（两处 `dragover` 被 `preventDefault` / 非 http 忽略并提示 / 拉非图 URL 报错且不建会话 / 真图走 drop→端口→SW 建新会话且首条消息带图），fixture 新增 `tests/fixtures/tiny.png`（断言 212 → 217） |

## 六i、handoff 待办 P1/P6 两片（2026-10-05，MV3 端）

| 问题 | 落地 |
|---|---|
| P1「多选靠近上下边界时，自动滚动会话列表」（双端；本片 = MV3 整页 `#list`） | `src/review.js` 涂抹期间按笔尖距 `#list` 视口上/下缘分档：**band=56 / step=14 / 30ms**（量纲对齐 GUI 端），`setInterval` 连续滚，离开边缘档立刻停、滚动到头自停、`pointerup`/`pointercancel`/`lostpointercapture` 收笔必停（`endStroke()` 第一行就是 `stopEdgeScroll()`）。三个配套：① **起笔 `setPointerCapture`** —— 笔尖划出 `#list` 也照样收得到 `pointermove`（否则贴边档停不下来），`paint.px/py` 记最后笔位；② 命中逻辑从 `pointermove` 抽成 `paintHit(x,y)`，**滚动每一拍重放笔尖命中** —— 列表在动、指针没动，滚到笔尖下的新卡继续入选（折返换向语义共用）；③ 模式被别的路退出时 `edgeTick` 自停。e2e 加 6 条确定性断言（SW 播种 24 条 → 26 行超长列表：贴下缘 `scrollTop` 变大且未触底 → 回中部两次采样相等 → 再贴重新起步 → `pointerup` 后两次采样相等且未触底（非触底假停）→ 播种清掉、活动会话原样），不依赖模型。**红证**：HEAD 基线同探针 `s1=0`（压根不滚），实现后 `s1=196` |
| P6「mv3 和 gui 是否支持渲染 latex？不支持请添加支持」（本片 = MV3） | **一份语义两面共用**的 `src/lib/md.js` 加两段式管线：先把公式从**原文**摘成占位符（U+E000 私有区码位，`esc`/markdown 都不碰），markdown（`code`/`**`/链接/`\n→<br>`）跑完，最后把占位符换回 `katex.renderToString` 的 HTML —— 反着做 `esc` 会把 KaTeX 标签转义掉。四条口径（主会话拍板、GUI 端同款）：`$$..$$`/`\[..\]` 块级可跨行、`$..$`/`\(..\)` 行内不跨行；开 `$` 后非空白（**数字起算公式**，`$2+2=4$` 必渲染）、闭 `$` 前非空白**且闭 `$` 后不是数字**（Pandoc 口径 → `单价 $5，$8` 两个 $ 都配不成对，价格不吞）、`\$` 永不当分隔符且输出剥成字面 `$`；闭合扫描碰到中间的 `$` 要么合法闭合要么本次开侧作废（内容不含 `$`，与 GUI 正则 `[^$\n]` 同语义）。**渲染失败（语法错 / katex 没加载）→ 原样回填转义源码**，回填在 markdown 之后、不二次扫描。资产：KaTeX 0.19 npm tarball 进 `src/lib/katex/`（min.js / min.css / fonts 全量，无 CDN）；加载顺序三处同序：manifest `katex.min.js → md.js → drawer.js`、`review.html` 同序 `<script>`。抽屉是 Shadow DOM → `drawer.js` 往 shadow root 注入 `<link>`（`chrome.runtime.getURL`），manifest `web_accessible_resources` 放行 css+fonts（字体相对 CSS URL 解析）；整页 `review.html` head 直接 link。options 页不用 md（无对齐点）；磁盘镜像 `store.js renderMarkdown` 不经 `md()`，公式源码原样进 `.md`；think/reason 照旧只 `esc` 不渲染。e2e 加 10 条（整页：head link 载入 / 字体真加载 / 5 处 `.katex` 可见非空且 computed font 是 `KaTeX_Main` / `$2+2=4$` 源码不裸露 / `$5·$8` 原样且 `\$5` 剥反斜杠 / 坏公式原样源码；抽屉 shadow 同样 5 处 + link 进 shadow + 价格与坏公式原样；收尾两条）。**红证**：HEAD 基线 `n=0` 且无样式表，实现后 `n=5` |
| （本轮踩坑）探针页点抽屉 `#toggle` 把后续用例带崩 | 抽屉开合记在 **origin 共享**的 `localStorage['spore.open']`：P6 的探针页与 fixture 页同源，探针页上点一下 `#toggle` 就把 fixture 页切页后重开的抽屉状态写成「关」，`#sessions` 变 `display:none` → 「打开列表 → 确认删除」连锁超时 `exit=2`。修法：探针页**只读不点**（挂载按原值自开自关），另加 1 条断言钉住 `spore.open` 前后不变（233 = 217 + 16） |

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
