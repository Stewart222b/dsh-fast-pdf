# 提示词：审查并实测 dsh-fast-pdf 的交互 bug

> 用法：新开一个对话，把下面 ```text 代码块里的内容整段粘进去。不需要额外补充什么。

```text
你的任务：审查并主动撞出 dsh-fast-pdf（一个 DSH 客户端的 PDF 预览插件）里的交互 bug，然后逐个修掉。
不要等我给你 bug 清单——自己去撞、自己去量。我懒得复述，你负责找出来。

## 0. 先把事实读清楚（别猜，别重造）

工作目录（cwd）：C:\Users\SW0178\Documents\deepseek-harness\default-workspace
插件目录：plugins\dsh-fast-pdf

先按顺序读：
- plugins\dsh-fast-pdf\README.md（重点看「接管是怎么发生的」「自检」「面板自检」「七个报上来的毛病」「现状」几节，别通读散文部分）
- plugins\dsh-fast-pdf\client.js（浏览器半边，~2860 行，React.createElement 手写，不用 JSX）
- plugins\dsh-fast-pdf\public\viewer.mjs（渲染核心，pdf.js 封装）与 public\viewer.css
- plugins\dsh-fast-pdf\tests\browser\index.html（场景脚本，~1600 行；note(name, value) 记一条实测事实，until(fn, ms) 等条件）
- plugins\dsh-fast-pdf\index.js（宿主半边：/fast-pdf 静态路由 + /fast-pdf/file + /fast-pdf/translate）

它是 DSH 的客户端插件：预览 id 是 dsh-fast-pdf/pdf，默认接管 .pdf，内置预览器还留在下拉里。
**改了 client.js 或 public/ 下的东西 → 刷新页面就生效；改了 index.js → 必须重启 DSH。** 改的时候别越界。

## 1. 环境里已经有的东西（用，别再装）

GUI：http://127.0.0.1:60052（插件已经装好并加载着；对未认证请求回 401，抓不到页面，别试图 curl 它）
静态服务器：通常已经在 8899 监听（若没有：& $node tests\host-route-live.mjs --serve 8899 tests\browser，用后台任务跑）

node（本机唯一的 node，别用系统 PATH 里的）：
$node = "C:\Users\SW0178\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
它每次会往 stderr 打一行 "Please use the legacy build…" 警告，PowerShell 会把有 stderr 的命令当失败报 exit 1 —— 所以一律 `2>$null`，然后看 $LASTEXITCODE。

四件现成工具（全绿才动手改 bug）：
cd C:\Users\SW0178\Documents\deepseek-harness\default-workspace\plugins\dsh-fast-pdf
& $node tests\client-smoke.mjs 2>$null; "EXIT=$LASTEXITCODE"        # 15 条：宿主路由、翻译路由、模块图、组件真挂载（真 React 18 + 假 ui-primitives）
& $node tests\install-check.mjs 2>$null; "EXIT=$LASTEXITCODE"       # 宿主能不能找到这个包（21 条）
& $node tests\host-route-live.mjs 2>$null; "EXIT=$LASTEXITCODE"     # 真 http + 真 socket 的路由（11 条）
& $node tests\visual-diff-test.mjs 2>$null; "EXIT=$LASTEXITCODE"    # 截图差异工具自己的 11 条

截图对比工具：& $node tests\visual-diff.mjs before.png after.png --ratio 0.002 --out diff.png
（零依赖，自己解 PNG；exit 0 在阈值内 / 2 回归或尺寸不一致 / 1 用法错或解不开；stdout 全是 key=value）

## 2. 主力是浏览器场景（一条命令跑一件事）

powershell -NoProfile -ExecutionPolicy Bypass -File tests\browser\run-scenario.ps1 -Name <场景> -Sample <样本> -Port <端口>
powershell ... -Name mount -Sample plain.pdf -Port 9900 -Extra '&pane=300&dark=1'

它串起：起无头 Edge → 打开 index.html?scenario=<场景> → 等页面自己置的 ready/settled → 打印一行 log:（全是 key=value 实测值）→ 截图到 $env:TEMP\fp-<场景>.png（用 read_image 看）。

现有 22 个场景（一个查一件事，名字就是 -Name 的值）：
mount nav dblclick copy find hotkey outline history menu anchor place perf sweep recycle switch select translate-error password password-card two fail defects

URL 参数（都经 -Extra 传）：&pane=<px> 面板宽、&paneH=<px> 面板高、&dark=1 暗色、&bare=1 去掉宿主 CSS 变量走兜底、&primitives=0 走降级按钮、&disk=<绝对路径> 让正文改从真路由读盘、&pdf= 换样本。

样本（tests\browser\samples，现搓的，不含第三方文档）：
plain.pdf 4 页 / outline.pdf 12 页两层目录 / big.pdf 200 页 / huge.pdf 34 MB / pw-aes.pdf 密码 secret / notpdf.pdf 假 PDF

加新场景：直接在 tests\browser\index.html 里加一个 if (scenario === "你的名字") { ... } 块，-Name 随便起（没有名字校验，不匹配就什么都不打印）；里面用 note()/until()/settle()/click()/type()/all()/text() 这些现成的小工具。

## 3. 你要做的事（顺序别乱）

第一步：把 22 个场景按现在的代码全部重跑一遍，记下每个的关键事实，作为回归基线。任何一个变红先查是不是上一轮改坏的。
第二步：主动撞。下面这些是我会点的路子，你必须比我撞得更狠（每撞一处，先写一条会失败的断言，再改代码）：
- 划词 → 「翻译」气泡 → 卡片 → 图钉固定 → 再划词 → 按气泡复用卡片 → 关闭 → 再固定/取消固定；固定状态下双击不得缩放或取消已有选区，滚动、翻页、切标签时卡片仍固定
- 卡片：译文里的代码块/表格/长链接/超长英文单词（不横向溢出？）、复制按钮（连点两次）、失败态「重试」、请求超时、空选区、跨页选区、只选中一个词 vs 整段
- 页码框：直接输入 0 / 999 / 字母 / 中文 / 空白 / 前导零 / 快速连打；↑↓ 到第 1 页和第末页；回车、Tab 离开、点页面离开；翻页按钮连点；拖着滚动条时的读数
- 目录：多层（3 层以上）折叠、折叠全部后当前章节在哪、跳转后高亮、目录比面板高时的滚动、超长标题、无目录文档
- 查找：0 命中、1 命中、大小写/整词开关连切、含正则特殊字符的查询、Escape、切标签回来
- 缩放：「整页显示」在极窄/极宽面板、Ctrl+滚轮、捏合；合成双击事件应未取消、倍率不变且不清除已有选区（不据此断言浏览器原生选词），放大后横向滚动条
- 面板宽度 260/300/360/420/460 × 高 300/720 × 亮/暗 × primitives=0：工具栏换行、页码同排、目录浮层、菜单与属性卡不被切、横向滚动条出现没有
- 键盘：Tab 走遍所有控件（焦点在哪、有没有可见焦点环）、Escape 的优先级（菜单 → 属性卡 → 气泡 → 查找栏）、Enter 在页码框
- 生命周期：开两个文档、切走切回、反复装卸六轮（canvas 归零、堆不涨）、200 页滚到底、34 MB 打开途中取消/切走、密码错了再对、坏文件重试
- 无障碍与语义：每个按钮的 aria-label、aria-pressed 真假、禁用态、input 的 label、有没有空的 role/aria（宿主的 Button 只转 aria-pressed，写别的等于没写）

第三步：修。改法要克制——只为这条 bug 改，不顺手重构、不换风格、不加依赖（本机出不了网，pnpm add 装不上）。
第四步：回归。改完把受影响的场景和你新加的场景全跑一遍，四件 node 工具也要绿。

## 4. 硬规矩（违反任何一条这条就不算完）

1. **只认实测**。每条结论后面必须跟一个能量出来的事实（几何/计算样式/状态/计数），不许写 note("looksRight", true) 这种自我安慰的断言。
2. **一个 bug 一条断言，改之前红、改之后绿**。如果旧代码也能让新断言通过，说明你量的不是那个 bug。
3. **别编功能**。这是我自己浏览器扩展（github.com/Stewart222b/fast-pdf-viewer）的移植版，对照的是那份扩展，不是 Edge 自带阅读器。问答块、设置页、下载、多语言包、自己存阅读位置——这些是明确不搬的，别加。
4. **别问我要清单**。撞到了就改；撞到但不确定是不是 bug 的，列出来让我判断，别自己动手。
5. **不许装依赖、不许改宿主、不许起第二个 GUI**。网络只有 C:\Users\SW0178\Documents\web_tools\request.txt 这条桥（download: 免费，search:/fetch: 付费），内置 web_fetch/web_search 在本机一定失败，别调。
6. 合成事件有边界：合成 mouseover 不会真的弹出宿主 Tooltip，桩件里的 Tooltip 只是个 title 属性；所以"提示框出现在哪"这类事只能断言结构与兜底样式，别假装测到了。
7. 别删用户的浏览器 profile 目录，临时目录一律放 $env:TEMP\fp-*。

## 5. 交付格式（照抄这个结构，别写散文）

先给一张 bug 表：序号 / 现象（我点了什么、我看到什么） / 根子上是什么 / 改在哪 / 实测事实（改前值 → 改后值）
再给回归结论：跑了哪些场景、四件 node 工具、面板宽度各档，逐条绿/红
最后一句：哪些是我撞到但没敢改、需要你拍板的

## 6. 已知的事实（省你时间，别重复验证）

- 宿主 ui-primitives 的源码不在 asar 里，Tooltip/Button 的 DOM 细节看不出来，只能靠浏览器里量。
- 面板在 420 px 时工具栏一行（37 高），360/300/260 时两行（67 高）；页码框在任何一档都和「/ 总页数」同一行。
- 这本书的「当前章节」高亮是行上的 ::before，起点用 --fp-indent（缩进多少就从哪儿开始），不是贴着列边。
- 划词气泡是 .fp-chip，翻译卡片是 .fp-pick：两个元素、两个状态，卡片钉住时气泡照样会跟着新选区出现。
- 上一轮报上来的七个毛病（目录标题不固定、目录圆角、关闭按钮的提示撑出横向滚动条、图钉不变、固定后不弹翻译、高亮白边贴最左、页码不齐与翻页跳数）已经修过并有断言守着；这些再坏就是回归，去查 recent 改动。
```
