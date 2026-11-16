# dsh-fast-pdf

DSH 侧的 PDF 阅读器：默认接管右侧预览里的 `.pdf`，内置 PDF 预览器仍保留在下拉里备用。

这是 `fast-pdf-viewer`（浏览器扩展版）向 DSH 的移植。渲染核心直接沿用仓库里那份 `viewer.js` —— 连续滚动、分页惰性渲染、按页缓存回收、原生文本选择层、缩放动画都是原样搬过来的，没有重写。

## 一分钟版

| 想知道 | 回答 |
|---|---|
| 装在哪 | 桌面版 profile 里已经装好（`~/.dsh/profiles/desktop/package.json` 的 `bundles` 有 `dsh-fast-pdf`，包目录是指向本仓库的 junction） |
| 怎么确认生效 | 打开一个 `.pdf`，预览器标题写着「快速 PDF」，右上角多出「打开方式」下拉（内置预览器平时只有一个候选，所以那个按钮本来不出现） |
| 想用回内置 | 那个下拉里点内置那个，随时切回；选择记在 tab 上 |
| 怎么改完生效 | `public/*`：刷新页面；`client.js`：刷新页面；`index.js`：按一下 unlag 的刷新按钮（不用重启宿主） |
| 怎么自检 | `node tests/client-smoke.mjs` / `install-check.mjs` / `host-route-live.mjs` / `host-live.mjs`；浏览器面板再加 `tests/browser/` 那套 |
| 翻译花什么 | 宿主已配好的模型，按会话走；插件里没有 API Key 或 base URL。更多 → 设置可选择翻译语言、默认缩放和页面间距；偏好保存在本机，模型连接仍由宿主管理 |
| 没有的东西 | 插件内的"问文档"（用 DSH 的对话就好）、自带 key、云端 OCR |

## 为什么需要宿主半边

浏览器半边要的文件，模块加载器给不了：

- `viewer.mjs` 是我们自己的 ES 模块（上游 `viewer.js` 只改了 import 路径和 i18n）；
- pdf.js 本体 `pdf.mjs` / `pdf.worker.mjs`，以及 `cmaps/`（中日韩字库映射）、`standard_fonts/`、`wasm/`。

壳的 `/plugins/<id>/client.js` 只答声明的那个 bundle 入口，所以宿主半边 `index.js` 注册一条前缀路由 `/fast-pdf`，把 `public/` 只读地发出去。客户端用 `new URL('fast-pdf/viewer.mjs', document.baseURI)` 解析 —— 走页面自身的 base，反向代理前缀和桌面壳的 `dsh-app://app/` 都能落到这条路由上。全部响应带 ETag 重验证，刷新页面不会重下 3 MB 的 pdf.js。

**pdf.js 不进 bundle。** `client.js` 只有十几 KB，渲染器在真正打开 PDF 时才 `import()`，页面空转时一个字节都不多付。

## 文件

| 路径 | 作用 |
|---|---|
| `index.js` | 宿主半边：`/fast-pdf` 静态路由（ETag、HEAD、405、路径越界拒绝）+ `POST /fast-pdf/translate` + `POST /fast-pdf/sync`（页面文本上行）+ `POST /fast-pdf/work`（给浏览器派渲图任务）|
| `translate.js` | 划词翻译：按会话正在用的 provider/model 调 `ctx.llm.stream` |
| `documents.js` | 宿主侧的页面文本存储：按 `docId` 缓存、按会话排队、检索与目录过滤。**不 import `public/search.mjs`** —— 那份带高亮所需的字符映射，宿主只需要「在第几页」|
| `tools.js` | 五个工具的纯定义对象（`pdf_search` / `pdf_read_pages` / `pdf_outline` / `pdf_page_image` / `pdf_list`），手写 `ToolDefinition` 而不是 `import { defineTool }` |
| `bridge.js` | 宿主 → 浏览器的图像通道，方向反过来的请求/响应：pane 挂一个长请求等活儿，宿主有渲图需求时作答 |
| `http-body.js` | 带上限的请求体读取（翻译 96 KB、页面文本 8 MB，两个上限各有理由）|
| `client.js` | 注册 `.pdf` 预览 + 文档体；工具栏、目录、查找、划词气泡；按需加载渲染器 |
| `public/viewer.mjs` | 上游 `viewer.js` 的移植（改 import 路径、i18n，末尾把 `ViewHistory` 一并导出） |
| `public/search.mjs` `pdf-viewport.mjs` `history.mjs` | 上游同目录模块，原样搬入 |
| `public/i18n.mjs` | 渲染核心要的三条文案 |
| `public/selection-text.mjs` `selection-anchor.mjs` `bubble-text.mjs` `bubble-placement.mjs` `outline-active.mjs` `document-properties.mjs` `loading-progress.mjs` | 从作者自己的扩展搬来的纯函数：选区重排、气泡该挂在选区的哪一端、气泡里的 markdown、气泡落在视口里的哪一侧、目录当前章、属性卡、加载行。一律运行时取（见下节） |
| `public/pdf.mjs` `pdf_viewer.mjs` 等 | pdf.js 6.3.289 官方构建（与宿主内置版本一致） |
| `public/viewer.css` | 插件外壳样式；页面层级规则取自上游 `styles.css` |
| `tests/client-smoke.mjs` | 无头自检（路由、模块图、注册、主题令牌） |
| `tests/host-route-live.mjs` | 把宿主半边架在真 socket 上：路由匹配、媒体类型、304、越界、翻译往返；`--serve` 模式还能给浏览器当静态服务器 |
| `tests/install-check.mjs` | 不开 GUI 也能答的一个问题：profile 那侧是不是真的接上了这个包 |
| `tests/document-tools.mjs` | 文档那一半的无头自检：文本存储、检索、五个工具、渲图通道、sync 路由 |
| `tests/host-live.mjs` | 对着跑着的 GUI 验宿主半边是否真的加载了（`--page` 读页面自报的接管顺序） |
| `tests/browser/` | 面板自检场：`index.html` 二十个场景 + `drive.mjs`（无头 Edge 的 CDP 驱动）+ `run-scenario.ps1`（一条命令跑一个场景）+ `make-samples.mjs`（生成样本 PDF） |
| `cordis.patch.yml` | 插件挂载点 |

## 接管是怎么发生的

`documentPreviews` 的排序：`priority === "builtin"` 记 0，其余记 1，按降序取第一个作默认。内置 PDF 预览器声明了 `builtin`，我们**不声明** `priority`，于是排到它前面成为默认，而内置那个仍留在渲染器下拉里 —— 想换回去随时能切。

手动在下拉里选过的标签页会记住自己的选择（宿主按 `tabId` 存 `rendererId`），只有没选过的才算默认位。

### 一眼确认它有没有生效

看完宿主 `documentpreview` 的客户端源码，窗口里有两处明确信号：

1. **预览器上写着「快速 PDF」** —— 那行标题就是候选里 `selected.title()` 的返回值，选中不是它就不会出现这个词。
2. **右上角出现「打开方式」下拉，展开有两个选项** —— 那个 `Menu` 的条件是 `candidates.length > 1`：内置预览器本来只有一个候选，所以平时根本不显示这个按钮。它出现了，就说明候选里多了一个；两个选项分别是「快速 PDF」和内置那个（`candidates.map(c => ({ id: c.id, label: c.title() }))`），点内置那个就切回去（`onSelect → actions.selected(tabId, id)`，写进该 tab 的 `rendererId`，下一帧 `candidates.find(c => c.id === rendererId)` 就选它）。

反过来说：**如果看不到「打开方式」按钮，就是我没注册进去**，那时候看控制台有没有 `client-modules: could not load "dsh-fast-pdf"`。

### 面板拿到手的 props 是哪些

这条容易错得很安静：少拿一个 `t`，界面上就是一堆 `fastPdf.find` 这样的键名；少拿 `sessionId`，翻译会退到默认模型（还能用，但不是这个会话正在用的那个）。所以逐条对着宿主 `documentpreview` 的客户端源码核过：

| prop | 谁给的 | 宿主里的证据 |
|---|---|---|
| `t` | 插槽按注册时的 `locale: NS` 绑好，当普通 prop 传下来 | 内置的几个体都是这个形状：`MarkdownBody({ content, resourceAddress, useResource, t })`、`CodeBody({ resourceAddress, content, wrap, scrollportRef, t })`；对应的注册都写了 `locale: "…"` |
| `content` | 面板自己 | `{ kind: "bytes", data }`，内置 PDF 注册写的是 `loading: "bytes-complete"` |
| `useTabInfo` | 面板自己 | `TextBody({ content, useTabInfo })` |
| `sessionId` / `retainTab` | `inject(sessionId, actions)` 的返回值，键名原样变 prop | `inject: (_sessionId, actions) => ({ retainTab: … })`；第一参数就是会话 id（文本那一支直接把它叫 `_sessionId`，因为它不用） |

自己那半边只读这五个，`useStore`、`actions`、`renderSlot`、`resourceAddress` 一个都没用——不用就不会用错。

### 一个客户端插件要过的六道关

接管是最后一步，前面还有五道关，任何一道过不去，界面上都**没有报错**，只是"预览器还是内置那个"。这六处都对着宿主的真源码核过：

| 关 | 谁在查 | 过不去的样子 |
|---|---|---|
| profile 的 `dsh.profile.bundles` 里有这个包 | 启动加载器 | 什么都没发生（`install-check` 第 1 条） |
| `dsh.bundle.patch` 指向的文件里 `insert` 了这个包 | 启动加载器 | 提示 `skipping profile bundle`，只在 stderr |
| 没有 `engines.dsh` / `@deepseek-ai/dsh*` peer 不满足 | `evaluatePluginCompatibility` | 同上，整包跳过 |
| `dsh.client` 按 `parseDshClient` 合式（`platform` 字符串、`inject` 字符串数组、`immediately` 布尔） | 浏览器加载器 | 整个浏览器半边丢掉 |
| `exports["./client"]` 是字符串或带字符串 `default` 的对象 | `clientExportOf` | 组合期抛错（`declares dsh.client but exports no "./client" bundle`） |
| `__ModuleLoader__.load({ id })` 等于包名 | 加载器跑完脚本后查 `factories.has(row.id)` | `loaded without registering` |

后两道容易被当成形式主义，但它们决定"文件会不会被取、跑起来算不算数"。`client-modules` 的服务端那侧是这么接的：它扫的是**宿主 Loader 的每一条 entry**（不是一张 `@deepseek-ai/*` 白名单），把命中 `dsh.client` 的包解析成一条 graph row，row 的 id 就是包名，客户端 bundle 的地址是 `/plugins/<包名>/client.js?rev=<文件 mtime/size 的哈希>`。所以这个插件不是"因为放进 profile 所以被特殊照顾"，而是和内置插件走同一条路。

## 跟着宿主的主题走

工具栏、查找栏、目录栏的颜色本来就取自 `currentColor` 的透明度混色，天然跟着宿主走。真正需要自己颜色的几处（译文气泡、密码卡片、输入框、页面底衬）一律写成宿主令牌 + 兜底：

```css
background: var(--dsw-alias-bg-layer-3, light-dark(#ffffff, #23262b));
```

**兜底不能省成只写 `light-dark()`**：它跟的是 `color-scheme`，而宿主不设这个属性，暗色主题下卡片会一直停在浅色。令牌则是宿主按主题切换的，一行都不用改。

用到的令牌：`bg-document-preview`、`bg-base`、`bg-layer-1/2/3`、`border-l2/l3`、`interactive-bg-hover`、`label-primary/secondary/tertiary`、`state-warn-label`（密码填错那行字）。`tests/client-smoke.mjs` 那一组断言这些名字还在、且都带兜底。

## 按钮和图标用宿主自己的

颜色跟着令牌走还不够 —— 悬停态的深浅、禁用态的不透明度、焦点环、字号行高，这些手搓一遍总差一点。壳其实把宿主自己的 UI 集合发给了每个客户端插件：

```js
const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
primitives.Button; primitives.Tooltip; primitives.IconSearchOutlineRegular; primitives.writeClipboard;
```

所以要留意一件事：**`require` 背后是一张封闭的模块表**（`react`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`dsh-client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`、`@tanstack/react-virtual`），表外的 id 会当场抛错。别的包一律走 `ctx.get()`，`client.js` 里只有两个 `require`，都是表内词。`tests/client-smoke.mjs` 把这条写成了断言，因为拼错一个字符的后果是"插件静默不挂载"，而不是报错。

于是工具栏、查找栏、卡片底部、密码卡片、失败重试全是宿主的 `Button`（`size="sm"` 28px 行高、`variant="ghost"`，次要动作 `outline`、主按钮 `primary`），包在宿主的 `Tooltip` 里；复制走 `writeClipboard`。取值不是猜的：`_sm_` 是 28px、`_ghost_` 只加悬停底色、`_sm_` 的圆角是 `--dsw-radius-sm` —— 这几条是从宿主样式表里抄出来的，宿主那份内置缩放控件的按钮正是 `size="sm"` + `width:28px`。

**图标**取宿主图标集（`IconSearchOutlineRegular`、`IconChevronLeft/Right/Up/Down`、`IconPlusOutlineRegular`、`IconCloseOutlineRegular`、`IconCopyOutlineRegular`、`IconRefreshOutlineRegular`、`IconFlatListOutlineRegular`）。集合里没有的四个 —— 缩小、后退、前进、适应宽度 —— 按宿主自己的办法画：内置预览器的缩小键就是手画的一条 `M2 8h12`（16 单位里 1.5 描边），这里照抄，所以画的和取的在同一行里看不出是两套。

**拿不到就降级**：`require` 包在 `try` 里，取不到 `Button` 就退回普通 `<button>`，带 `data-fp-btn` 标记，样式表只给这个标记上外观、`.fp-btn` 只给几何。两条路的行为一模一样（同一份断言、同一套场景跑过两遍），差别只在"谁画的皮"。

## 划词翻译

选中文字 → 选中处浮出「翻译」→ 译文出现在气泡里。三段都是克制的：

- **语言与词条**：不设选项。选中中文就译成英文，选中其它就译成中文（按 CJK 字数占比判断）。短词或短语会生成紧凑的双语词典条目，包含词头、词性、释义和例句；句子或段落只翻译原文并保留格式。
- **模型**：不填 Key、不填 base URL。宿主半边走和对话同一条路 —— 先看这段 PDF 所属会话的路由（`agent.session.requestHeader().config`），再看 agent 的，最后落到 `agentDefaultModel`。模型支持时，翻译请求会单独设置 `reasoningEffort: "off"`；其他情况下会通过提示词要求模型直接翻译，不会把会话的思考等级复制到请求。提示词无法保证关闭模型底层思考。
- **失败**：模型没配好、选中太长、宿主没有 `llm` 服务，都只在气泡里写一句原因，不影响阅读。

**高度量早了会让翻上去的卡片压住字**。翻不翻转要拿卡片自己的高度去算，而卡片是长出来的：译文落进来、引文块展开、页脚补上模型名，从第一帧到定稿量过 95.3 → 122 → 130 → 139 px 四个值。最早那版只在状态变化时量一次，量到的是中间值，于是靠页底的卡片翻上去以后正好盖住选区（实测差 1 px，本来该留 8 px 的空）。现在测量挂在 `ResizeObserver` 上，卡片怎么长，落点就跟着重算；`select` 场景靠 `firstBelow=8` / `bottomAbove=8` 两条钉住。

气泡挂在哪，是上游那份扩展里最容易被忽略的一处：多行选区取并集框，气泡就飘到整段的右边、离字很远。这里搬的是**焦点端**——指针最后松手的那一头（`public/selection-anchor.mjs`），反向选（从下往上拖）时焦点端在上一行，气泡就跟着到上面那行去。落点、翻转、最大宽度由 `public/bubble-placement.mjs` 算，两个函数都只算坐标，不写样式。`anchor` 场景量的就是这个：正向、反向两次，气泡左边与焦点端左边的差都是 `0`，上边离焦点端底边都是 `8`。

`translate.js` 里没有一行 `@deepseek-ai/*` 的顶层 import：桌面版 profile 是 `autoInstallPeers: false`，这些包是可选 peer，顶层 import 失败会**让整条插件不激活**（连 PDF 预览一起没了）。所以服务一律在请求时用 `ctx.get()` 取，拿不到就降级成一句提示。

## 问文档：把文档交给对话，而不是自己再做一个问答

选中文字 → 气泡里除了「翻译」还有「问这段」。它不弹自己的对话框：把「《文档名》第 N 页」加选中的文字一起放进 DSH 的输入框，剩下的就是正常的对话。这样追问、换模型、看引用历史、改主意重问，都是对话本来就有的能力，插件不必再实现一遍。

**为什么不是插件自己问答。** 上游那份扩展是自己跑 agent 循环的：它持有 API key、自己检索、自己排轮次。DSH 里这三样都不归插件 —— 模型和会话在宿主手里，插件没有 key，也不该有。所以这里把「读这份 PDF」降级成五个工具，由对话里的模型自己决定调哪个：

| 工具 | 回答的问题 |
|---|---|
| `pdf_search` | 「哪几页提到了这个词」—— 按页报，一页一条 |
| `pdf_read_pages` | 「把 3 到 7 页读出来」—— 支持 `3-7`、`3,7-9`，一次最多 12 页 / 24k 字符 |
| `pdf_outline` | 「这份文档怎么组织的」—— 目录，可按词过滤 |
| `pdf_page_image` | 「这一页长什么样」—— 渲成图交给视觉模型；当前模型不看图时返回一句说明而不是报错 |
| `pdf_list` | 「这个会话读过哪些文档」—— 多份文档时用它拿到 `docId` |

**文本怎么到宿主。** 这是整件事里唯一不显然的地方。工具在宿主里跑，而 PDF 是浏览器解析的（宿主没有 canvas，`public/pdf.mjs` 是浏览器构建，在 Node 下导入即崩：`hashOriginal.toHex is not a function`）。而 typert 的 Remote 是单向的（`TypertRemoteContribution` 是 Host-for-Client），**宿主没有「调用客户端」这回事**。于是反过来了：浏览器把页面文本推上去。

阅读器本来就在建全文索引（查找栏要用），那份索引里只取 `text`，按批 `POST /fast-pdf/sync`，一批 120 页 / 1.5 MB 字符，**每批确认之后才推进游标**。这一点不是洁癖：构建批次和推进游标写在同一个循环里会少一行，但失败的批次会把它的页留在游标后面，而没有任何东西会再要它们 —— 文档看起来是完整的，那几页却永远不在。索引是边扫边推的，所以 779 页的手册在第一页读完时就能被问到，不用等整个扫描结束。

**图怎么回去。** 同样是被反转的方向，只是这次是宿主有事要找浏览器：`pdf_page_image` 把一个渲图任务放进队列，pane 挂着的那个长请求正好拿到它，渲完 `POST /fast-pdf/work` 回来。一次只挂一个请求，就是普通的请求/响应，所以桌面版的 IPC 桥也能承载（它不一定转发 WebSocket upgrade）。pane 关掉时 `bye` 会结算所有排队任务，工具拿到的是「pane 已经关了」，不是等到超时。

**哪来的 docId。** `d` + 一段 FNV-1a 哈希，输入是文件地址和 pdf.js 的 fingerprint。地址命名文件，fingerprint 在字节变化时变化 —— 所以同一个文件重开命中原文本，改过的文件是一个新文档。会话最多留三份，最旧的被挤掉。

**一份手册开在两个对话里，存两份。** 这个 `docId` 里没有会话：地址是 `dsh-resource://file/session/<sessionId>/<path>`，哈希出来的字符串两个对话会算成同一个（地址里那个 session 段是"谁在问这份文件"，不是"文件是谁的"）。所以存储的键是**会话加 docId 两段**，不是一个 docId。原先只按 docId 存，后写的那个会话会把 `sessionId` 盖掉 —— 前一个对话刚索引完的手册会从它的 `pdf_list` 里消失，没有任何报错。两份的代价是页文本存两遍（779 页那份是 559 KB），这个仓库在这个地方的选择是"读的人能查准"优先于"省一份缓冲区"。断言在 `tests/document-tools.mjs` 的 `two sessions sending one document id keep separate copies`：两个会话写同一个 id，各读各的文本，且后写的一方不搬走所有权。

**降级都有话说。** 没开文档、文档还没索引到那一页、这一页没有文本层（扫描件）、宿主没有 `tools` 服务、当前模型不接受图像 —— 每一条都是一句话，写在工具结果里给模型读，而不是抛异常把这一轮对话打断。`tools` 服务是可选依赖：拿不到时 PDF 预览照常工作，只是对话里看不见这份文档。

## 阅读手势

两件阅读时最常做的事，各有一条明确的路：

- **双击选词**：阅读器不拦截页面的 `dblclick`，也不触发缩放；合成事件测试只确认事件未取消、倍率不变、已有选区未清除，不代表测试了浏览器原生选词。
- **复制出来是纯文本**：页面文字在 pdf.js 的文本层里是一行一个定位 `<span>`，浏览器默认会把这份 DOM 连同 `text/html` 和"每行一个换行"一起写进剪贴板。面板在 `.fp-frame` 上接住 `copy`，只写 `text/plain` 并 `preventDefault()`，内容是 `toString()` 重新排过的一份：拉丁片段之间补一个空格，CJK 之间不补（两个汉字之间加空格本身就是错字）。

这条的断言分两处。`client-smoke.mjs` 把 `selectionPlainText` 从 bundle 源码里提出来直接调（真字符串、真换行），"换行有没有多余"在那里量；`tests/browser` 的 `copy` 场景量的是另一件事——面板认领了这个事件、只写纯文本一种、页面之外的选区一概不碰。合成分发的 `copy` 写不进真剪贴板（浏览器拿自己序列化的选区填 `text/plain`，`transferIsBrowserFilled=true` 就是这个意思），与其假装量到了，不如把这条边界写在场景里。

### 拖分栏：拖动时只做合成器变换，停手才重排

分栏拖拽改的是面板宽度，而 `page-width` 模式的倍率就是宽度除以页宽——**每一次 `ResizeObserver` 回调都会算出新的倍率**。照直走 `setZoom` 的代价在 779 页的文档上非常直白：清掉每一页的已渲染标记、隐藏每一个文本层、重写 779 个页盒的 `width`/`height` 与 `--scale-factor`，然后把可见页**强制**重新栅格化一遍。拖动一秒六十帧，这套账单就付六十遍，而屏幕上真正需要的只是把已有的栅格按比例缩放。

所以拖动走的是和 pinch 手势同一条路：`previewResize()` 只在 `pagesEl` 上写 `transform: scale(target / zoom)`，锚点取视口中心，160 ms 没有新的宽度读数才 `commitResize()`——那时才付一次 `setZoom`，并把锚点恢复回去。三点值得记下：

- **`computeZoom` 现在接参数**（`computeZoom(mode = this.zoomMode)`）。预览要的是"新宽度会算出什么倍率"，但 `this.zoom` 必须继续描述屏幕上那份布局，否则 `restoreZoomAnchor` 会按一个还没生效的倍率去算坐标。
- **预览期间不发渲染**。`previewResize()` 会取消正在跑的 job，因为按旧倍率画出来的 canvas 在提交那一刻就要丢掉；`renderPage` 本来也有 `if (this.pinch) return` 的短路，resize 走的是另一条。
- **`setZoom`、`close()`、`commitResize` 都先 `cancelResize()`**。留着一个过期的 transform，新的布局会被缩放第二次；而 `commitResize` 额外检查 `this.wrapEl?.isConnected`——面板被 park 之后页盒还在、包裹节点已经离开文档，这时重排 779 页没有人会看见。

固定百分比（`100`、`150` 之类）不走预览：那种模式下文档宽度不跟随面板，拖动本来就不该改变它，`previewResize()` 直接返回 `false`，调用方照旧 `setZoom`。

**「适应宽度」是一个模式，不是一次动作**，所以工具条上那个按钮亮着（`pressed: view.mode === "page-width"`），再按一次就灭。这一点是被读者问出来的两层：

- 第一层：「点了适应宽度之后拖动分栏，页面又跟着缩放，看起来像按钮失效了，再点一下加号才好」。其实两件事都对——模式在生效时本来就该跟着宽度走，加号之所以"修好"它，是因为加号把模式换成了固定百分比。缺的是**状态可见**：`view.mode` 因此重新进了 `sync()` 的投影。上一轮清理死代码时它恰好被删过，所以这里留了注释。
- 第二层：「高亮太不明显，而且不能点一下取消，就不能做得像搜索的大小写那个按钮吗」。两处都改了：按钮现在按**查找栏那两个开关**的样子点亮（强调色文字 + 13% 强调色填充 + 48% 的内描边，`public/viewer.css`），再按一次就把当前倍率定住、退出模式——和 `Aa`/`ab` 的开关语义一致。定住时用的是**四舍五入后的整数百分比**，也就是读数上那个数，所以按下前后工具栏显示的百分比不变。

顺带修掉一个更基础的问题：原来的规则挂在 `[data-pressed]` 上，而宿主的 `Button` 只转发 `aria-pressed`（`pressed` 是它唯一转发的状态，`⋯` 按钮就靠这个），所以**在宿主路径下那条规则从来没命中过**，只有无宿主的降级 `<button>` 才会亮。现在两个选择器都在。

`client-smoke.mjs` 的 `a resize previews on the compositor and commits once, not per frame` 把这条钉在源码层面：常量是 160 ms、`computeZoom` 收参数、预览函数体里**不许**出现 `applyPageLayout`/`renderVisible`/`renderedZoom`/`textLayers.values`。断言读源码而不是跑行为，是因为要跑就得伪造 779 个页盒与一个能测时间的 ResizeObserver——那套假壳能证明的事情比这两行正则少。

## 从自己那份扩展搬过来的七样

这个面板的原型是作者自己的浏览器扩展 `Stewart222b/fast-pdf-viewer`。扩展里那些"日常在用"的细节，按需要一条条搬了过来，搬的是行为，不是代码：扩展的模块读的是 `window`、`localStorage` 和自己那一套 i18n，面板这边换成宿主的 props、宿主的 `locale`、宿主的路由。

| 搬来的 | 落在哪 | 和扩展不同的地方 |
|---|---|---|
| 选区整理成段落 | `public/selection-text.mjs` | 两处**有意**偏离：CJK 换行之间不补空格；`\u00A0` 先换成普通空格再 `trim()`（上游的 `trim()` 不去 NBSP） |
| 选区整理成段落之后：气泡挂在**焦点端** | `public/selection-anchor.mjs` | 上游还会先挑 `.textLayer` 里的元素；这里不需要（选区本来就从文本层里来），少一层判据 |
| 气泡落在视口的哪一侧、多宽 | `public/bubble-placement.mjs` | 只搬了算坐标的那两个函数；上游那个顺手写样式的 `applyBubblePlacement` 没搬，样式归 React 渲染 |
| 译文气泡的拖动 / 固定 / 停止 | `client.js` 的 `beginDrag` + `picker` | 边界钳在画布内（钳的是卡片自己的 `offsetWidth/offsetHeight`）；按在气泡里的按钮上不算拖动（3px 阈值） |
| 目录当前章高亮 + 展开/折叠 | `public/outline-active.mjs` + 目录列 | 上游比较的是 `scrollTop`，这里比较阅读点 `{page, pdfY}`（视口顶部那一行的位置） |
| 页码输入框、查找的「区分大小写 / 整个词」 | 工具条 + 查找栏 | 上游是下拉菜单，这里两个 `pressed` 开关，改一下立刻重查 |
| 文档属性卡、加载进度行 | `public/document-properties.mjs`、`public/loading-progress.mjs` | 属性从 `pdf.js` 的 `getMetadata()` + 页尺寸算，位置一栏只显示宿主侧的路径（`blob:` 一律不显示） |

**七样都走同一条加载路径**：`client.js` 里没有一行 `import "./public/xxx.mjs"`。这些模块是**页面里现取**的（`loadHelper(name)`，按 `assetUrl(name, document.baseURI)` 解析，拿不到页面基址时退到 `__DSH_TRANSPORT__.streamBaseUrl` 的 origin），取回来填进 `helperRef`。理由是两条，都不是洁癖：

1. `client.js` 是 `window.__ModuleLoader__.load` 加载的纯 ESM 单文件，顶层的相对 `import` 在打包后的页面里没有稳定的基址，加载失败会让**整条插件不激活**（连 PDF 预览一起没）。
2. 这些模块全是纯函数、没有 `@deepseek-ai/*` 的依赖，晚一步拿到不影响首屏。拿不到时各条路径都有兜底：复制退回浏览器自己的纯文本、气泡退回 `textContent`、目录退回不高亮、加载行退回 `${t("loading")} ${pct}%`。

所以浏览器场景里 `panel=true`、`pinned=true` 这类断言量的是"拿到了并接上了"，而字符串规则本身由 `client-smoke.mjs` 直接 `import` 那四个 `.mjs` 来量——纯函数不需要装在页面里才可信。

**一个起名上的坑，记一下**：页码那一组叫 `.fp-pageno`，不能叫 `.fp-pages`——`.fp-pages` 是 pdf.js 那一列的页面容器（`flex-direction: column` + `gap: 14px`）。一开始复用了这个名字，页码框当场被竖排成 44×114，工具条也跟着撑成四行、`frameHeight` 从 683 掉到 597。`mount` 场景现在钉住三件事：工具条单行（高度 ≤ 40）、页码框与 `/ 4` 同一行、`frameHeight` 回到 683。

## 主题：用宿主的真值，不留自己的配色

调色板不是猜的。`@deepseek-ai/dsh-client-ui-theme` 那份样式里，`body` 是亮色、`body[data-ds-dark-theme]` 是暗色，两边都只把 `--dsw-alias-*` 指向 `--dsw-static-*`；拆开解析一遍，这个插件用到的每个 token 真值如下：

| token | 亮色 | 暗色 |
|---|---|---|
| `--dsw-alias-bg-document-preview` | `#ebeef2` | `#151517`（和 `bg-base` 同色） |
| `--dsw-alias-bg-layer-1 / 2 / 3` | `#ffffff` | `#232324` / `#2c2c2e` / `#353638` |
| `--dsw-alias-border-l2 / l3` | `#0000001a` / `#0000001f` | `#ffffff1f` / `#ffffff29` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-label-primary / secondary / tertiary` | `#0f1115` / `#61666b` / `#81858c` | `#f9fafb` / `#cfd3d6` / `#adb2b8` |
| `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629`（两套同一个琥珀色，不是红） |
| `--dsw-elevation-prominent` | `0 0 0 .5px #00000029` | `0 0 0 .5px #ffffff29` |
| `--dsw-radius-sm / md / lg` | `8 / 12 / 16px` | 同左 |

两件事值得记一下：

- **亮色的 `layer-1/2/3` 全是纯白**，卡片之间靠那道 0.5px 描边分开，不靠底色差；只有暗色才分层。所以浮层（选词按钮、译文卡）只用 `--dsw-elevation-prominent` 加 `layer-2/3`，不自己叠阴影——内置 PDF 那个密码面板也是这么写的（`border: .5px solid var(--dsw-alias-border-l3)`）。
- **`light-dark()` 只能包颜色**。它是 `<color>` 函数，包一整个 `box-shadow` 列表（`light-dark(0 0 .5px #000, …)`）会让整条声明失效。`viewer.css` 里现在 `light-dark()` 只出现在颜色位置。

`viewer.css` 里每个 `var(--token, 兜底)` 的兜底值都换成了上表的真值，于是「宿主给了 token」和「没给」两条路观感一致。这条兜底路是真会走到的：任何不在宿主体内的页面都只有兜底。

- **浮层上的悬停色只能叠，不能换**：`--dsw-alias-interactive-bg-hover` 本身只有约 6% 不透明度，它是留给「贴在实色底上」的按钮的。工具条上的发丝按钮写 `background: var(--…hover)` 没问题——底下是实色条；选词气泡那个「翻译」按钮浮在纸面上，同一条简写会把它的实色底**换掉**，按钮当场变透明——用户报的「点翻译按钮会变透明」就是这一句。现在它保留 `background-color: layer-3`，悬停/按下用 `background-image: linear-gradient(…)` 盖一层，`client-smoke.mjs` 钉住「这条规则里不许出现 `background:` 简写」。

**看真主题下的样子**：`tests/browser/index.html` 那个假宿主已经按上表铺了 `body` 和 `body[data-ds-dark-theme]` 两套 token。URL 加 `&dark=1` 走暗色，加 `&bare=1` 把 token 全设成 `initial` 退回兜底路：

```powershell
node tests\host-route-live.mjs --serve 8899 tests\browser
# http://127.0.0.1:8899/index.html?scenario=select&pdf=./samples/outline.pdf&primitives=1&dark=1
```

### 字体：别继承宿主正文容器的等宽体

宿主给「文档标签页」的正文容器（`._3R73eq_body`，就在 `ui-sidebar-documentpreview` 打包出来的那份 CSS 里）写的是：

```css
._3R73eq_body {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  white-space: pre;
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
```

那套样式是给**文本预览**用的（源码要看等宽对齐）。每个内置正文都在自己根节点上写 `font-family: var(--dsw-font, …)` 跳出去——markdown 是 `var(--dsw-font, inherit)`，图片是 `var(--dsw-font, sans-serif)`。这个插件原先没跳，于是整块面板的工具栏、查找栏、译文卡全按 `ui-monospace, monospace` 渲染：英文落到 Consolas 这类等宽体，中文落到 `monospace` 别名解出来的字体。表现出来就是"和顶部 tab 不是一个字体"，而且怎么看怎么糙。

真宿主里读回来的对照（`/fast-pdf/hello` 的 `body-view` 那条）：

| | 值 |
|---|---|
| 我们工具栏 `font-family` | `ui-monospace, monospace` 12px |
| 宿主 `body` | `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"` |
| `devicePixelRatio` | 1.75 |
| 面板宽 / 页面 CSS 宽 | 549px / 501px（适配 63%） |
| 页面位图宽 | 876px → `像素/CSS 像素` 正好 1.75 |

最后两行是关键：**位图是精确按 1.75 倍渲的，没被重采样**。所以纸面正文看着小只是 63% 下字本来就小（面板窄），不是糊；真正糙的是文字 UI，而它确实被换了字体。

两处一起改：

1. `.fp-root` 用宿主自己的写法跳出去 —— `font-family: var(--dsw-font, var(--dsw-font-family, -apple-system, … "Microsoft YaHei", …))`，顺手补 `white-space: normal`（容器还把 `pre` 塞进来了）。
2. `-webkit-font-smoothing: auto`。宿主 `body` 上写的是 `antialiased`，这条在 macOS 上是好意，在 Windows 上等于**关掉 ClearType、退回灰度抗锯齿**；11–12px 的中文这么渲就是边缘发灰。`auto` 把面板交回平台默认，只影响这一块。

这条现在两边都钉住了：`client-smoke.mjs` 有一条 `the pane asks for the app's typeface, not the code font`（读 `viewer.css` 的 `.fp-root` 块，且整份样式里不许出现 `monospace`）；浏览器自检在挂载前造一个 `font-family: ui-monospace, monospace; white-space: pre` 的容器、把裸 `.fp-root` 塞进去读计算样式，`mount` 场景因此多打 `paneFont` / `paneWhiteSpace=normal` / `paneIsMono=false` 三行。

## 自检

不需要开 GUI，六条命令：

```powershell
node tests\client-smoke.mjs        # 直接调 handler，假 req/res
node tests\document-tools.mjs      # 文本存储、检索、五个工具、渲图通道
node tests\reattach-paint.mjs      # 切回时那一帧：该省的排版权一次都不能多
node tests\install-check.mjs       # 从 profile 出发，照加载器的方式把包解析一遍
node tests\host-route-live.mjs     # 真的 http 服务 + 真 socket
node tests\visual-diff.mjs a.png b.png    # 两张同尺寸截图，只回答「变了多少」
```

`npm test` 跑十六个：上面五个（`visual-diff.mjs` 除外，它是给人用的比较器，自己那十一条断言在 `visual-diff-test.mjs`）加下面十一个。剩下的两个不在里面——`host-live.mjs` 要一个活着的宿主，`visual-diff.mjs`、`browser/` 那一套要浏览器和截图，都不该拖住一条 `npm test`。

```powershell
node tests\center-zoom.mjs         # 缩放锚点：放大缩小时光标下的那一行不动
node tests\pinch-spacing.mjs       # 捏合预览期间的页间距
node tests\preferences.mjs         # 偏好文件的读写与旧值迁移（`page-fit` → `page-width`）
node tests\render-queue.mjs        # 渲图队列：并发上限、取消、重用旧位图
node tests\reattach-paint.mjs      # 见上
node tests\scroll-diagnostics.mjs  # 滚动诊断事件
node tests\scroll-lookup.mjs       # 按位置反查是第几页
node tests\search-navigation.mjs   # 查找命中之间怎么跳
node tests\translation-options.mjs # 翻译的目标语言与提示词拼装
node tests\viewer-reattach.mjs     # 视图器挂起再挂回的状态保留
node tests\wheel-pinch.mjs         # Ctrl+滚轮：合成器预览、停手提交、暂停队列
```

全量跑一遍约 11 秒、99 条 `ok`。**这一轮补的正是这个缺口**：`npm test` 原来只跑三个文件，剩下的十几份里 `wheel-pinch` 早在 resize 预览那一轮就坏了——假 viewer 少了 `previewResize`，断言还停在 `viewer.pinch?.target ?? viewer.zoom`——因为它不在 `npm test` 里，一直没人发现。一条没人跑的命令迟早会烂。

浏览器那套场景要先有样本。样本全是 `make-samples.mjs` 现搓的，但其中 34 MB 的 `huge.pdf` **不在仓库里**（`.gitignore` 挡着，为了不让 clone 背 34 MB），所以第一次跑之前：

```powershell
node tests\browser\make-samples.mjs   # 生成 plain / outline / big / huge / notpdf 五份
```

其余样本（`a-deep.pdf`、`b-dense.pdf`、`b-short.pdf`、`pw-aes.pdf` 等，共约 750 KB）都随仓库走。**每条场景对样本是有要求的**（写死的搜索词只在特定页数里存在），喂错样本会得到一条「一条也搜不到」的假红：`c-find-count` / `c-find-typing` 要 `plain.pdf`，`c-find-index-late` 要 `big.pdf`，`c-pw` / `c-pw-cancel` / `c-stack` 要 `pw-aes.pdf`，`a-outline3` / `lead-outline-hold` 要 `a-deep.pdf`，其余默认 `outline.pdf`。

`visual-diff.mjs` 是这一轮补的第四件工具，管的是前面三件都管不了的那一类毛病：**看得出来、却说不出是哪条规则**的那种（间距歪几像素、颜色差一档、圆角该不该有）。它自己解 PNG（不装任何依赖）、逐像素比、吐 `diffPixels` / `diffRatio` / `worstDelta` / `worstAt`，超阈值就 exit 2 并把差异图写出来：

```powershell
node tests\visual-diff.mjs before\outline.png after\outline.png --ratio 0.002 --out diff.png
# size / sizeMatch / diffPixels / diffRatio / worstDelta / worstChannel / worstAt / tolerance / ratio / verdict，一律 key=value
```

退出码三分：`0` 在阈值内、`2` 是回归或尺寸不一致、`1` 是用法错或 PNG 解不开。拦下解交织、调色板、非 8 位的 PNG（这些解出来的字节不是眼睛看到的），并校验每个 chunk 的 CRC —— 截图坏掉时宁可报错，也别给一个「看起来很稳」的假绿灯。用法就一句：**改之前截一张存着，改完再截一张**，`diffRatio` 掉到多少、`worstAt` 落在哪儿，比「我觉得没动别的」可靠。它自己那十一条断言在 `tests\visual-diff-test.mjs`（造图、注入一个像素、CRC 坏掉、尺寸不一致各一遍）。

`install-check` 回答的是另外三个脚本答不了、而重启也说不清的那一类问题：**宿主到底能不能找到这个包**。它站在 profile 的 `package.json` 上（和加载器同一个锚点）把 `dsh-fast-pdf/client`、`dsh-fast-pdf` 解析出来，读 `dsh.bundle.patch` 指的那个文件、确认里面 `insert` 的就是这个包名，再真 `import()` 一次宿主半边、拿一个假的 ctx 跑 `apply` 看两条路由有没有注册上。二十一条断言是照着 `@deepseek-ai/dsh-app-boot` 的 `resolveBundleDir` / `bundlePatchPaths` / `evaluatePluginCompatibility` 三条真规则、外加浏览器加载器 `parseDshClient` 的四条写的：patch 文件是**直接 join 包目录**（所以 `exports` 里不用导出它），而 `engines.dsh` 或任何 `@deepseek-ai/dsh*` peer 不满足都会让整个 bundle 被跳过——跳过时只往 stderr 写一行，界面上什么都不说。

最后两条管的是另一半的静默失败。`dsh.client` 声明是按 `parseDshClient` 的规则验的（`platform` 必须是字符串、`inject`/`external` 必须是字符串数组、`immediately` 必须是布尔），因为那份声明一旦抛错，丢掉的是整个浏览器半边，而界面上的表现只是「预览器还是内置那个」；`__ModuleLoader__.load({ id })` 也必须等于包名，否则加载器跑完脚本查 `factories.has(row.id)` 会查不到，报的是 `loaded without registering`——同样看不见。

后者不是前者的重复。`client-smoke` 拿手搓的 `req`/`res` 调 handler，能抓住拼写错误；但**路由匹配**、`req.url` 的真实形状、`for await` 读一个正在上传的 body，这些只有真 socket 说了算。所以 `host-route-live` 里把宿主 `dsh-host-webserver` 的 `register`/`match` 原样抄了一份（先精确表、再最长前缀、匹配条件是 `pathname === prefix || startsWith(prefix + "/")`）—— 抄它才是重点：前缀要是注册成 `/fast-pdf/`，任何一个不做匹配的 mock 都会绿，而宿主上什么都取不到。

十一条断言：媒体类型（`.mjs`/`.worker.mjs` 必须是 JS、`.bcmap` 八位流、`.wasm`、`.ttf`）、查询串不影响解析、HEAD 报真长度、`if-none-match` → 304、越界与相邻路径 404、资产只收 GET/HEAD、**精确路由压过前缀路由**（用「未标记的 POST 该得 403 而不是 405」来区分是哪条路由答的）、标记 POST 走通一次翻译、没有 live agent 时退到默认模型、超大 body 与坏 JSON 都给中文句子。

九组断言（全部在 `tests/client-smoke.mjs` 里，前两组是宿主半边）：

1. 宿主路由：200 / 304 / HEAD / 405 / `/fast-pdf/../index.js` 与 `%2e%2e` 越界 404；
2. 翻译路由：用假的 `llm` + `agents` 跑通一次调用（会话的 provider/model 真的传下去、目标语言进了 system prompt、sessionId 随请求走），没有 `llm` 服务时返回原因而不是抛错；
3. 模块图：`public/` 每个模块能解析，`viewer.mjs` 导出 `PdfViewer`/`ViewHistory`/`searchDocument` 等，pdf.js 版本是 6.3.289 且 worker 指向同目录；
4. 浏览器半边：预览项**不含** `priority`（这是接管默认位的关键）、`loading: renderer`（正文自己读，见下面"32 MiB 的墙"）、body 首帧就有滚动容器和 `.pdfViewer` 宿主、注册的组件套着崩溃边界（`gate.type.name === "BodyBoundary"`）、`inject` 要了 `remote.workspaceFiles` 并把 `readBytes` 递进正文，以及**只给 sessionId 不给 `actions`** 调一遍 `inject` 再把 `retainTab` 跑一次——真宿主就是这么调的，这一条以前缺了才让整块空白溜过去；
5. 模块表：`client.js` 的 `require` 只有表内词、没有顶层 `import`/`export`；
6. 宿主组件：喂一份假的 `ui-primitives`，工具栏九个按钮的 `aria-label` 顺序、`size`/`variant`、每个都包在 `Tooltip` 里、图标哪几个取自宿主哪几个是手画，逐条对；
7. 主题令牌：名字还在、都带兜底、`.fp-frame` 仍是偏移父级；
8. 字体：`.fp-root` 用 `var(--dsw-font, …)` 跳出正文容器的等宽体、把 `white-space` 收回 `normal`，整份 `viewer.css` 不出现 `monospace`；
9. 读整份文件：假 `fetch` 把 3 MB 分成两块流回来，断言只发一次请求、地址是 `/fast-pdf/file`、带标记头、body 是**原样**的 `{ address }`、拼回的字节与原文逐字节相同、进度是 (0,1] 的分数且收在 1 上；宿主回 413 时断言以 `code: "too-large"` 带真实大小被点名拒绝（不是干等）；不是文件地址的字符串断言报 `code: "address"` **且一个请求都没发**；`absolute` 和 `session` 两种作用域都断言发得出去（相对路径原样送出，落地交给宿主半边）；路由整个不在时断言报 `code: "unavailable"` 而不是空白。

`--serve` 模式把这套路由当静态服务器用，可以让浏览器直接跑在**插件自己的路由上**（而不是某个 python 静态服务器上）：

```powershell
node tests\host-route-live.mjs --serve 8899 <一个含 index.html 的目录>
```

页面放在服务器根上，于是 `fast-pdf/viewer.mjs` 解析成 `/fast-pdf/viewer.mjs` —— 和宿主里 `document.baseURI` 是 `/` 一模一样。pdf.js 本体、worker、cmaps、标准字体、wasm 于是全从这条路由取。

### 面板自检（`tests/browser/`）

那个"含 `index.html` 的目录"就在仓库里，所以这套流程不用现搭：

```powershell
# 从 default-workspace 出发（路径按插件目录算）
node plugins\dsh-fast-pdf\tests\host-route-live.mjs --serve 8899 plugins\dsh-fast-pdf\tests\browser

# 另开一个：无头 Edge 打开某个场景，drive.mjs 等到页面报完再截一张图
msedge --headless=new --remote-debugging-port=9800 --user-data-dir=%TEMP%\fp --window-size=520,820 ^
  "http://127.0.0.1:8899/index.html?scenario=select&pdf=./samples/outline.pdf&primitives=1"
node plugins\dsh-fast-pdf\tests\browser\drive.mjs 9800 out.png 60000
```

`drive.mjs` 等的是页面自己置的 `ready` / `settled`，然后把 `log:` 那行（组件上报的实测值）和截图一起带回来。它会先轮询调试端口直到 Edge 开出来（这台机器冷启要 3.3 秒，早先按固定 `sleep` 等就时不时报 `ECONNREFUSED`）。参数：`&dark=1` 换暗色，`&pane=<px>` 改面板宽，`&paneH=<px>` 改面板高度（把 `#host` 压矮，目录树才会溢出它那一列），`&bare=1` 不带宿主的 CSS 变量，`&pdf=` 换样本，`&disk=<绝对路径>` 让正文改从真路由读盘（见下）。

`&disk=` 是这几条里唯一改变**字节从哪来**的那条。它的值是一条**绝对路径**（不是样本名，也不是 `dsh-resource://` 地址）：页面把它整段转义后塞进一条会话地址 —— `dsh-resource://file/session/sess-46/<路径>`，路径里的 `%5C` / `%2F` 一律换成 `/` —— 面板再照平时那条 `POST /fast-pdf/file` 去读。所以带上它，`log:` 里会多一行 `readerRoute=dsh-resource://file/session/sess-46/C%3A/…`，`reader` 也变成 `plugin-route`；不带它是 `reader=harness`，读的是页面开头 `fetch(&pdf=)` 下来的那份内存拷贝。`&pdf=` 仍然要留着：页面开头照旧 fetch 它，只是拿到的字节带 `&disk=` 时不再用，所以两者指同一份文件最省事。页面只认 `&pdf=`，没有 `&sample=` 这个参数——`-Sample` 是 `run-scenario.ps1` 那一层的名字，它同时拼进 `&pdf=` 和 `&disk=`。`run-scenario.ps1` 按 `-Sample` 自己算出 `samples\<名字>` 的绝对路径并转义，所以走它时不用手工拼；手写 URL 才需要自己 `EscapeDataString` 那一段（冒号、反斜杠都得转义）。

嫌两条命令来回切麻烦就用同目录的 `run-scenario.ps1`，它把启动 Edge、驱动、截图、收尾串成一条：

```powershell
powershell -File tests\browser\run-scenario.ps1 -Name find -Sample outline.pdf -Port 9900 -Extra '&dark=1'
```

二十二个场景，一个查一件事：

| 场景 | 它回答什么 |
|---|---|
| `mount` | 挂起来就有滚动容器、`.pdfViewer` 宿主、工具栏九个按钮（`outlineButtonAppeared` 说明目录按钮是**有目录才出现**）、`injectWithoutActions=ok`（宿主只传 sessionId 的那条路不抛）、`paneIsMono=false`（等宽容器里 `.fp-root` 仍用界面字体） |
| `nav` | 翻页连点会不会吞步、缩放与「适应」、两帧内连点 |
| `dblclick` | 页面合成双击未取消，倍率不变，已有选区保留；工具栏合成双击也未取消且倍率不变。此场景不验证浏览器原生选词 |
| `copy` | 复制页面文字时面板认领这个事件（`copyDefaultPrevented`）、只写纯文本一种（`plainFlavourOnly`）、选区在页面之外就不管（`outsideUntouched`）。**合成事件写不进真剪贴板**：浏览器会用它自己序列化的选区填 `text/plain`（`transferIsBrowserFilled=true`），所以"换行有没有多余"这条是在 `client-smoke.mjs` 里直接对 `selectionPlainText` 测的 |
| `find` | 命中数、高亮落在几页、跳页、Escape 清干净；`hlTimeline` 是每 250 ms 采一次的稳定值 |
| `hotkey` | `Ctrl/⌘+F` 抢过来打开自己的查找栏，浏览器查找被取消（`dispatchEvent` 返回 false） |
| `outline` / `history` | 目录行数、跳转、`后退`/`前进` 走的是阅读历史。另外量三件这轮改出来的事：`frameWidthOpen` 与 `frameWidthClosed` 相等 + `outlineOverFrame=true`（目录是浮层，不挤版面）；`branchOpenHeight 67 → branchMidHeight 45 → branchFoldedHeight 0`（50 ms 时采到的是过渡中间那一下，`branchTransition=0.16s`）；`activeAfterJump` 高亮在跳过去之后落在了某一行上（第一页在首个条目之上，那一页本来就该空着） |
| `menu` | 工具栏最右的「⋯」开出的一层：量它的位置（`menuRect=279,35,176,36`——在按钮正下方、右边对齐、整块在面板内）、菜单里只有一行、按下时按钮是 `pressed=true` |
| `anchor` | 气泡挂在选区的**焦点端**：正向选一段（3 个 span），气泡左边与焦点端的左边差 `0`、上边距焦点端底边 `8`；改成从下往上选（`selection.collapse` + `extend`），焦点端翻到**上一行**，气泡跟着翻到上面那行——两次的差都还是 `8` / `0`；再按一下页面，气泡收掉 |
| `place` | 装卸之后阅读位置（页 + 滚动量 + 缩放）复原、以及前几帧布局没定时的重推 |
| `perf` | 打开一份 200 页 PDF 的代价：资产体积、首屏、滚到底 |
| `sweep` | 200 页走到底，位图数和堆内存是否被页数带着涨 |
| `recycle` | 反复装卸：canvas 归零、堆增量、不留 frame |
| `switch` | 换渲染器再换回来，页数和高亮不丢 |
| `select` | 划词 → 气泡 → 真模型译文；卡片在焦点端下面 `8` px（`firstBelow=8`）、靠页底那次翻到上面也是 `8`（`bottomAbove=8`）、不横向溢出。量之前先 `settle(400)`：卡片的最终高度要等文字和引文块都落定，**先量到的高度会让翻上去的卡片正好压在字上**——这条是量出来的（见下节） |
| `translate-error` | 失败态、有没有「重试」、气泡是否还在；重试是真的再打一次（`retrySucceeds=true`，还是同一张卡片），不是只把话改一改 |
| `password` / `password-card` | 加密 PDF 的密码卡片：位置、自动聚焦、空输入不可提交、输对了能打开 |
| `two` | 两个文档同时开着：各自的页数、查找、滚动、阅读位置互不串；关掉一个，另一个照常用 |
| `fail` | 打不开的文件走错误态 |
| `defects` | 这一轮报上来的七个毛病，每个一条实测事实（见「七个报上来的毛病」）。要用 `&paneH=300` 跑：面板得矮到目录树溢出它那一列，第一条才量得出来 |

样本是生成的，不含任何第三方文档：

```
node tests\browser\make-samples.mjs     # plain.pdf（4 页）outline.pdf（12 页 + 两层目录）big.pdf（200 页）
```

加密那个 `samples/pw-aes.pdf`（2.5 KB）手工造不出来（AES + 标准安全处理器），所以是签入的固定样本；它是 `plain.pdf` 用 pypdf 的 `encrypt("secret", algorithm="AES-128")` 出的，密码就是 `secret`。

装好之后要确认宿主真的把它加载起来了，跑这个（对着正在运行的 GUI）：

```powershell
node tests\host-live.mjs                                  # 用默认端口
node tests\host-live.mjs http://127.0.0.1:53776            # GUI 换过端口就带上它
node tests\host-live.mjs http://127.0.0.1:53776 --translate # 再花一次小额度，看真模型回话
```

它 HEAD 一下 `/fast-pdf/viewer.mjs`、`viewer.css`、2.1 MB 的 `pdf.worker.mjs`、一个嵌套 cmap、一个嵌套 wasm，各要 200；再 HEAD 一条 `../` 越界路径，要不到 200；顺带确认 worker 带强 ETag、带上 `If-None-Match` 回来的是 304 而不是整个文件。最后用不带标记头的请求打翻译路由，确认被 403 挡住、GET 被 405 挡住。**报 404 就是宿主没加载插件** —— bundle 列表只在启动时读一次，刷新页面不算，得重启 DeepSeek Harness。

### 打开一份 PDF 的代价

在真浏览器里量的（`?scenario=perf&pdf=./samples/big.pdf`，走本机路由，一次打开一份 200 页的 PDF，13 个请求）：

| 请求 | 体积 | 本地耗时 |
|---|---|---|
| `pdf.worker.mjs` | 2176 KB | 11 ms |
| `pdf.mjs` | 840 KB | 47 ms |
| `pdf_viewer.mjs` | 313 KB | 40 ms |
| `pdf_viewer.css` | 160 KB | 59 ms |
| `viewer.mjs` + `viewer.css` + 五个小模块 | 73 KB | 16–69 ms |
| 合计 | **3562 KB** | 全部在 70 ms 内 |

每个页面只下一次（导航里没有就 304），pdf.js 的 worker 是唯一的大件。

大文件不会一口气画完。拿一份手搓的 **200 页** PDF 试：

```
pages=200  painted=4  pagesCount=1 / 200  domContentLoaded=676 ms
scrollTop=scrollHeight → labelAtEnd=200 / 200  paintedAtEnd=8  scrollHeight=115209  scrollToEnd=1210 ms
```

200 个页框都在（撑住滚动条和阅读位置），真正画的只有视口附近那几页——滚到底也才 8 页。渲染由 `IntersectionObserver`（`rootMargin: 1200px`）触发，离开视口就停，这是"打开大文件不卡"的那部分。

`?scenario=sweep` 把同一份文档从头滚到尾，每 8 页采一次：**同时在册的位图始终是 8 个**，堆在 5.5–8.9 MB 之间锯齿（涨到 8.9 就回收一轮落回 5.5），滚回顶部 `1 / 200` 且首屏重画（`topRepainted=true`）。页数从 4 涨到 200，位图数没跟着涨——这是按页缓存回收在起作用。

**走完整份 200 页**（24 步滚到底，每步采样一次）：

```
painted: 4 → 8 → 8 → 8 … → 8 → 7        （自始至终 8 页）
heapMB:  7 → 6 → 6.4 → … → 8.6 → 5.3 → … → 5.7
回到顶部：labelAtEnd=200/200 → backAtTop=1/200，topRepainted=true，heap 5.9MB
```

位图缓存上限是 8 页（`maxCachedPages`），离开视口的页会 `canvas.width = 0`、清掉文本层和标注、`page.cleanup()`；滑回去按需重画。堆内存在 5–9 MB 之间锯齿轮转，**不随页数增长**——200 页的文档翻完，占用和 10 页的文档一个量级。

**别为了省 160 KB 删 `pdf_viewer.css`**——试过，代价是：查找少一个命中（4 → 3）、划词气泡的锚点从 `51,137` 挪到 `72,145`。pdf.js 的文本层就靠它那几十条 `.textLayer` 规则决定每个 span 落在哪，`viewer.css` 只是盖了页面盒子。这件事现在有断言守着（`client-smoke` 那组"both stylesheets are linked"）。

### 32 MiB 的墙：让正文自己去读（`loading: "renderer"`）

用户拿 32 MB 以上的 PDF 试出来的一句话是「现在默认还是打不开 32mb 以上的 pdf」。原因是两层的，第二层才是关键：

1. 宿主的 `workspaceFiles` 服务里，`maxBytes: 2 MiB` 管**一次窗口读**，`maxFileBytes: 32 MiB` 管**整文件读**。`readBytes` 不带 `range` 时走后者，超了抛 `workspace-file/too-large`，面板把它翻译成 `error.tooLarge` 那张卡片。
2. 面板的渲染条件是 `content !== undefined && renderSlot(...)`——**先读到内容，正文才被挂载**。所以 32 MB 以上时我们的组件一次都没有运行过，界面上那个"文件太大"是宿主自己画的。这也意味着：插件侧加多少设置都改不了它（DSH 这个版本也没有"插件设置页"，客户端能注入的只有给开发者工具用的 `configForms`）。

宿主给正文留的正路是预览定义上的另一个 `loading` 值：`renderer`。这时宿主**不读文件**，只递一个握手对象：

```js
content = { kind: "renderer", revision, reload(), loaded(version), failed() }
```

正文自己取内容、取完调 `loaded(version)`（面板的 `hasContent` 就是 `current.version !== undefined`），失败调 `failed()`，文件在磁盘上变了宿主调 `reload()` 把 `revision` 推进一格。注意它**不给读服务**：字节得正文自己找。

#### 字节从哪来：⊕ 不是 `workspaceFiles`

第一版想直接复用宿主的读通道。写完才发现这条路对第三方客户端插件是关的——实测（`apply` 上报的探针）：

```
apply-probe  canRead=false  remote="object"
```

`ctx.remote` 存在，`ctx.remote.workspaceFiles` 不存在；`ctx.inject(["remote.workspaceFiles"], cb)` 的回调永远不触发，把 `remote` 写进 `inject` 声明也没用。内置的文档预览插件能用，是因为它跟宿主一起发布，不适用同一套装配。

所以字节走**本插件自己的宿主半边**：`POST /fast-pdf/file`，body `{ address }`，标记头 `x-dsh-fast-pdf: file`（和翻译、信标同一个规矩），响应是流式的文件本体 + `content-length`。于是：

- 客户端一次 `fetch` 就把整份文件读下来，进度条有真分母（`正在打开 PDF… 37%`）；
- 宿主那条 32 MiB 的整体桥传输完全不参与；
- 上限变成我们自己写的数，**两边各写一遍**：客户端读到超 `MAX_PDF_BYTES` 就停止并报 `too-large`，宿主在 `stat` 之后、`createReadStream` 之前就回 413 并带上真实大小。

```js
const MAX_PDF_BYTES = 256 * 1024 * 1024;   // 两边同一个值
```

**传的是地址本身，不是路径**。这条是踩出来的：第一版让客户端把地址反解成路径再发过去（`{ path }`），宿主那边要求 `isAbsolute`。结果用户重启后打开的第一份文档就是

```
这个 PDF 打不开
需要一个绝对路径
```

——因为 `dsh-resource://file/session/<sessionId>/<path>` 里的 `<path>` **可以是相对于那个会话工作目录的**（宿主的 `sessionFileAddress` 注释原话：「absolute or workspace-relative path」）。文件在工作区根之外时，地址里塞的是 `docs/xxx.pdf` 这种相对路径，客户端又不知道那个会话的 cwd，只能瞎猜。

所以现在客户端只做形状校验（`session` / `absolute` 两种作用域，段能解码），**地址原样送到宿主半边**，由它自己反解并用宿主同一套规则落地：

```js
const root = ctx.get("sessions")?.get(sessionId)?.header?.cwd
          ?? ctx.get("sandboxPolicy")?.workspaceRoot
          ?? process.cwd();
const target = resolve(root, decodedPath);   // 绝对路径本来就原样通过
```

这正是宿主 `workspaceFiles` 自己的 `resolve` 规则（`header.cwd ?? sandboxPolicy.workspaceRoot`），所以同一个地址在两边落到同一个文件。落地之后仍然不信它：只服务存在的普通文件，目录 404、坏地址 400、超限 413。

被拒的读会带一条 `read-fail` 报告（`status` / `code` / `message` / `address`）——地址是面板关掉之后唯一找不回来的东西，所以它必须落在信标里。

`kind: "bytes"` 那条老路还留着（有 `bytes` 就直接用），所以宿主哪天换回去也不会坏。

#### 量过的东西

宿主路由本身（真 socket，两个方向都不打折）：

```
ok   the file route streams the document the body asked for — 35,666,428 B，content-length 与流一致，逐字节相同
ok   a session address resolves against that session's workspace root — session 相对路径逐字节读回原文件
ok   the file route refuses everything else — GET 405 / 无标记头 403 / 非绝对路径 400 / 不存在 404 / 目录 404 / 坏 JSON 400
ok   an oversized file is refused before a byte of it is read — 413 + {code:"too-large", size:314572800}
```

面板端到端（无头 Edge，`&disk=` 让 harness 走真路由读盘上的 34 MiB 样本）：

```
$ run-scenario.ps1 -Name mount -Sample huge.pdf -Port 9933
readerRoute=dsh-resource://file/session/sess-46/C%3A/…/samples/huge.pdf
ready=true settled=true canvases=40 loadedVersions=1 reader=plugin-route pagesCount=1 / 40
```

这条 `-Sample huge.pdf` 之所以得配 `&disk=`（`run-scenario.ps1` 自己加上，按 `-Sample` 算出 `samples\huge.pdf` 的绝对路径）：不带它时正文读的是页面内联的那份内存拷贝，`renderer` 这条路照样画得出来，但 `POST /fast-pdf/file`、进度条的真分母、256 MiB 上限和 413 一个都不会被走到——而这一节要验的正是它们。

同一份文件在 `bytes-complete` 时代连正文都挂不上。打不开的那条路也一样走真路由：

```
$ run-scenario.ps1 -Name fail -Sample notpdf.pdf
failedShown=true failedText=这个 PDF 打不开文件不是有效的 PDF，或者已经损坏重试 hasRetry=true retryRunsAgain=true
```

**加这条路由意味着宿主半边也变了**：客户端刷新页面就够，但 `index.js` 是在 Harness 启动时加载的，所以新路由要**重启 DeepSeek Harness** 才存在（见下面「改完的东西什么时候生效」）。

#### 文件为什么会被读两遍：版本号不是随便填的

用户报「进度条会加载两次，而且加载成功后还会再短暂出现一次」。第一次是正常的，第二次不是——`/fast-pdf/hello` 里明明白白两条 `body-bytes` 和两条 `runtime-viewer-build`，也就是说整份文件真的被重新读了一遍、视图器真的被重建了一遍。

原因是 `renderer` 握手对象里的那个 `loaded(version)`。宿主拿这个 `version` 跟**它自己 `useResource` 拿到的版本**比：

```js
const observedVersion = meta.value?.version;
const changed = current?.version !== void 0 && observedVersion !== void 0
  && observedVersion !== current.version && observedVersion !== current.observedVersion
  || state?.resourcesDirty === true;
```

`changed` 为真、且 `autoRefresh` 开着（默认 `true`）、且当前不在 loading —— 宿主就调 `reload()`，把 `revision` 推进一格。我们的正文把 `revision` 放在读文件 effect 的依赖里，于是整条「读文件 + 建视图器」链条重跑一遍：第二条 `body-bytes`、第二条 `runtime-viewer-build`、第二个进度条。

而我们当时上报的是常量 `1`，宿主上报的是 `dev:ino:size:mtimeNs:ctimeNs`。**常量永远不等于那个 token**，所以每一次元数据刷新都被判成「文件变了」。更糟的是第一轮 `prepareRenderer` 时 `useResource` 还没拿到值，`observedVersion` 记的是 `undefined`——这条兜底也失效了。

修法不是加个标志位捂住第二个进度条，而是让两边说的是同一个数：`POST /fast-pdf/file` 的响应多给一个 `x-dsh-fast-pdf-version` 头（`stat(path, { bigint: true })` 拼出来的同一个格式），正文把它原样回给 `loaded()`。整条链只有一种情况还会重载——文件真的被改了。

```js
const ns = await stat(wanted, { bigint: true });
version = `${ns.dev}:${ns.ino}:${ns.size}:${ns.mtimeNs}:${ns.ctimeNs}`;
```

三种情形用宿主的五个动作（`fresh` / `reset` / `loading` / `rendered` / `changed`）跑过：

```
unchanged file  -> changed: false   (no second load)
edited file     -> changed: true    (real edits still reload)
old constant 1  -> changed: true    (the bug: every frame looked changed)
```

`bigint` 那一位是有意义的：普通的 `stat` 把时间截到 `mtimeMs`，拼出来的不是宿主那个 token。响应头还带了 `access-control-expose-headers`——跨源读时自定义响应头默认拿不到，漏了这一行会静默退回旧常量，等于把刚修掉的毛病原样放回去。

### 它自己会说：`/fast-pdf/hello`

客户端插件天生是哑的。bundle 没加载、id 写错、默认位丢了——从外面看全都一样：预览器还是内置那个，没有任何地方写一行字。所以我给它装了一条嘴：

- 客户端在 `apply` 之后、以及某个文档正文真的挂载时，各往 `POST /fast-pdf/hello` 发一条几百字节的报告（自定义头 + 拒 `sec-fetch-site: cross-site`，和翻译路由同一个规矩；**每种 `kind` 留最近 8 条**，只在内存里）。
- 报告里带 `candidates`：注册完当场问 `documentPreviews.candidates("probe.pdf")`，**这就是接管顺序在应用内部唯一可见的地方**。

配额是按 `kind` 分的，不是总数：打开一份文档就要发四条（`body-render` / `mount` / `body-bytes` / `body-view`），切一次标签页又会重挂载一轮，总数据上限会把最早那条 `apply` 挤掉 —— 而 `--page` 要读的正是它，于是明明在跑的页面被判失败（2026-11-13 实测：13 条报告里已经没有 `apply`）。`host-route-live.mjs` 里那条断言现在是这样钉的：先发一条 `apply`，再灌 12 份文档的各四条，然后要求 `apply` 还在、`mount` 恰好被压到 8 条。

于是"那扇窗里到底是不是我的预览器"可以不用截图回答：

```
node tests\host-live.mjs http://127.0.0.1:53776 --page
ok    the host answers the beacon route — 2 report(s)
ok    the browser half applied inside the running page — applied 41s ago, took 2ms
ok    the pane's default .pdf seat is this plugin, with the built-in still behind it — dsh-fast-pdf/pdf → @deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf
ok    the page is newer than this build of the bundle — page loaded 12s after the last edit
```

这条通道本身在真浏览器里验过一遍（拿 `--serve` 起的测试服务器真开一个无头 Edge 打开面板）：两条报告按顺序到了，`apply` 用了 2 ms。

七种报告，各自回答一个问题：

| `kind` | 什么时候发 | 它解决的是哪种"看起来一样" |
|---|---|---|
| `apply` | 浏览器半边 `apply` 跑完（含 `candidates`） | 默认位是不是我的 |
| `body-render` | 正文组件**第一次被渲染**（每页一次，带 `bytes` 和宿主传下来的 `propKeys`） | 宿主到底有没有把字节交过来 |
| `mount` | 正文的挂载副作用跑到 | 真的画出来了 |
| `body-view` | 挂载后第一张位图出现时（一次；带 `dpr`、面板尺寸、位图宽、`chromeFont`、`smoothing` 等，对照表见上面「字体」那节） | "字看着糙"是像素少，还是位图被重采样 |
| `body-bytes` | 正文自己从 `POST /fast-pdf/file` 把整份文件读完之后（带 `bytes` 字节数、`version` 就是接着交给 `loaded()` 的那个值） | `renderer` 模式下宿主不读文件，`content` 里没有 `data`，所以 `body-render` 那条的 `bytes` 只能是 `-1`；字节真的到了没有、到了多少，只有这一条能证明 |
| `body-crash` | 正文渲染抛异常（含 `message` / `stack`） | 画到一半炸了 |
| `read-fail` | 宿主路由拒绝了这次读取（含 `status` / `code` / `address`） | 字节为什么没到 |

### 为什么以前会整块空白（以及现在不会）

2026-11-12 那天用户报"快速 PDF 打不开"。查下来是正文组件在挂载副作用里读了一个不存在的参数：

```js
inject: (sessionId, actions) => ({ retainTab: (tabId, signal) => tabs.retain(tabId, signal, actions.forget) })
```

宿主**只在注册自带 `store` 时才传 `actions`**（内置那个 PDF 正文就自己带 store）。这个插件不留 store，所以 `actions` 是 `undefined`，`actions.forget` 当场抛 `TypeError`，React 把整棵正文树卸掉——面板上什么都不剩，控制台也没人看。现在两处都改了：

- 读的时候 `actions?.forget`；`tabs.retain` 本来就会跳过不是函数的 `forgetTab`，所以没有 store 也能挂载，只是不占"标签页关闭时自动丢弃字节"那一档。
- 注册的组件外面套了一层 `BodyBoundary`（`PdfBodyGate`）：渲染抛异常时不再整块空白，而是 ① 往 `/fast-pdf/hello` 发一条 `body-crash`（带 `message` 和截断的 `stack`），② 在面板里写下"快速 PDF 出错了：<原文>"。这次就是靠它一次拿到答案的。

这条错误在自检里也钉住了：`client-smoke.mjs` 会用**只有 sessionId** 的入参调一遍 `inject` 并调用 `retainTab`；浏览器自检 `mount` 场景多打一行 `injectWithoutActions=ok`。

### 改完的东西什么时候生效

浏览器半边不是从这个插件的路由发出去的。`dsh-client-modules` 扫宿主 Loader 的每条 entry，给声明了 `dsh.client` 的包发一条 graph row，地址是：

```
/plugins/??<包名>/client.js&rev=<client.js 的 mtime/ctime/size 拼成的 sha1，取前 12 位>
```

即 `artifactRevision`。这个 `rev` 是**文件系统元数据的哈希**，所以拿它当探针就能问出一件路由 404 问不出的事：宿主此刻记着的，是不是这个包、这份字节。`host-live.mjs` 里就是这么查的——自己按同一条规则算出 `rev`（`sha1("plugin-artifact\0" + len:mtimeMs + len:ctimeMs + len:size)`），去取那条地址：

```
ok  the Host's module graph holds this package, at the current bytes — 200 52665B at rev f67aa5ee29da (file is 52985B)
ok  the served bundle is the browser half, unstripped — 1334 lines
ok  the graph does not answer an invented revision — 404
```

实测（这台机器上）：改完 `client.js` 之后宿主给的是**改后的字节**，不是启动那刻的快照；随手编一个 `rev` 一定是 404。所以 failing 行的措辞是固定的：报 404 就是"你改的东西还没进宿主"，重启。

**这台机器上还装着 `dsh-unlag`**（1.15.0），它的刷新按钮比"重启宿主"轻得多，而且宿主半边也管：

```
manual reload: the refresh button was pressed
plugins reloaded (already not running=0 newly not running=0 still stopped=0 pending=0)
the page is going for a fresh document
interface rebuilt; the page runs the plugins as served now
```

也就是说按一下（右上角按钮 → 菜单里「刷新」）等于：宿主插件代码就地换新（`apply` 重新跑一遍，`ctx.effect` 逐个释放再注册）+ 页面重进。会话、排队消息、正在跑的轮次都不受影响。所以这张表是：

| 改了什么 | 怎么生效 |
|---|---|
| `public/*`（`viewer.mjs`、CSS、pdf.js 那一堆） | 刷新页面 —— 这条路由每次请求都读盘，带 ETag 重验证 |
| `client.js` | 实测会被宿主认到；不满意就跑一次 `host-live`，报 404 再刷新页面 |
| `index.js` / `translate.js`（宿主半边） | **按一下 unlag 的刷新按钮**（不用重启宿主） |
| `package.json` 的 `bundles` / `dsh.client` | 重启宿主（启动清单在那时固定） |

unlag 里还有个**「Agent 可以自己刷新」**开关，默认关。打开之后我就能自己按那个按钮（工具名 `unlag_refresh`），不必每次请你动手——但它只换宿主侧的插件代码，页面重进仍然要人按一下（或者由按钮那次一并完成）。

（`prepareSource` 会把文件尾的 `//# sourceMappingURL=` / `sourceURL` 剥掉再重新盖一个，所以取回来的字节数比磁盘上少几百 B —— 那是正常的，不是截断。）

不带参数是十三条：路由、嵌套资产、越界、ETag 重验证、graph 里那份客户端 bundle、翻译路由的 403/405；`--page` 再多四条，读的是页面自己报上来的接管顺序。加上 `--translate` 再多四条，其中三条不花钱（空文本、超长文本在问模型之前就拒了），最后一条真的翻一句：

```
ok  an empty selection is refused without a model call — 没有选中文字
ok  an oversized selection is refused — 选中内容太长（6001 字），请分段翻译
ok  the live route translates with this session's model — swzc-tech / DeepSeek-V4.1-Flash-1017 364ms → 阅读位置、大纲和搜索框均保留。
```

这条之所以值得单独留着：它是唯一能证明 **`ctx.llm.stream` 的入参形状、会话自己那个模型、以及提示词的写法在真宿主上都对得上**的检查。假宿主里 `llm` 是我自己塞的桩，桩永远配合我。

## 键盘

只做和已有控件一一对应的几处，不额外发明快捷键：

| 位置 | 键 | 行为 |
|---|---|---|
| 页面上 | `Ctrl`/`⌘` + `F` | 打开本站查找栏并聚焦输入框；再按一次不重复开，只把焦点拉回来 |
| 查找框 | `Enter` / `Shift+Enter` | 下一处 / 上一处 |
| 查找框 | `Escape` | 收起查找栏（高亮一起清掉） |
| 页码框 | `Enter` / `Escape` | 跳到输入的页 / 退回当前页（点出去也一样退回去） |
| 密码框 | `Escape` | 取消打开，卡片收起，说明"没有打开" |
| 属性卡 | `Escape` / 点卡片外 | 收起（和密码卡同一个键，同一个意思） |
| 「更多」菜单 | `Escape` / 点菜单外 | 收起。次序是写死的：先收菜单，菜单不在时 `Escape` 才轮到属性卡 |
| 页面上 | `Ctrl`/`⌘` + 滚轮 | 以阅读窗格中心缩放 |

工具栏缩放、适应页面/宽度、修饰滚轮和捏合都会围绕阅读窗格中心保留同一处 PDF 内容；阅读位置与历史记录仍使用原来的页面锚点。

`Ctrl+F` 这一处是必要的，不是发明键位：页面上的字是画在 canvas 里的，浏览器自己的查找看不见它们——在一个几百页的文档里按 `Ctrl+F` 只会得到"0 个匹配"。所以页面拿到焦点时把这对键拦下来（`preventDefault`，实测 `dispatchEvent` 返回 `false`，浏览器查找不会弹），交给自己的查找栏。宿主前端本身没绑这个组合（在打包产物里查过），而聊天那一半不在这棵 DOM 里，所以那边 `Ctrl+F` 照旧。

页面能接到键的前提是它能被聚焦：`.fp-frame` 带 `tabIndex=-1`（点一下就聚焦，但不进 Tab 顺序），焦点框在 CSS 里关掉了。

方向键翻页之类没有做：连续滚动本身就够了，多一套键位只会在 DSH 的输入框里抢焦点。

## 现状

M0 / M1 / M2 的代码都已完成：

- 连续滚动、惰性渲染、缩放（含 Ctrl+滚轮）、适应宽度；页面双击不触发缩放，为浏览器原生选词保留默认事件；
- 复制选中文字只带走纯文本（没有富文本，也没有每行一个换行）；
- 目录：文档带 outline 时工具栏多一个目录键，点条目跳转；**目录是浮在文档上的一层**，不挤窄页面（右侧栏本来就没多宽，挤一下版面就全变了），开合带 140 ms 的淡入；节点能逐个折叠，折开是三排数不动的 160 ms 高度过渡（`grid-template-rows: 1fr → 0fr`，向上游学的动画），也有「展开全部 / 折叠全部」；当前读到的那一章高亮；
- 页码可以直接输入跳转：框里是当前页，右边是总页数；
- 查找：后台建索引，输入即搜，命中处画高亮，上下键跳转并显示 `3 / 17`；「区分大小写」「整个词」两个开关一改就重查；**左边那个数是全文档命中数，右边画的高亮只落在已经渲染出来的页面上**——所以"47 处命中、当下画了 7 个"是正常现象，往下滚，剩下的页面渲染出来就补上；
- 文档属性：工具栏最右的「⋯」里一行，列出文件名、大小、位置、标题/作者/主题/关键词/创建与修改时间、生成程序、PDF 版本、页数、页面尺寸、是否 Fast Web View；
- 跳转历史：后退 / 前进回到上一个/下一个位置（目录跳转和查找跳转都进这条历史）；
- 阅读位置：每个标签页记住页码与滚动位置，关掉再打开接着读；
- 划词翻译：见上一节。请求带 60 秒上限（真测过 4.5k 字符要 13 秒，所以上限给得宽），超时就落到出错的卡片并给「重试」，不会永远停在「翻译中…」；
- 加密 PDF：不再直接报错，出一张卡片要密码；填错提示"密码不对"，取消则说明没打开，可以重试；
- 标签页字节保留：和内置预览器一样占一个 retention 席位，切走再切回不重读文件；**切回时也不再闪一下进度条**——缓存里的那一份接回来要两百毫秒左右，而首帧原来一律画成「加载中」，手上又没有字节数，于是画出来的是横扫的那条不确定进度条，而不是刚看完的 0-100。现在首帧先问缓存：这一份还开着就直接以就绪状态出现（`peekOpenDocument`，只看不取，取走是重挂载那一步的事）；缓存里那份过期了（换了视图器构建、字节不同），重建路径自己会把状态改回「加载中」。
- **切回时那一下黑：不是缺进度条，是画了一帧空框**——`fp-frame` 由 React 渲染但刻意不含子节点（页面容器是视图器建的），而把容器接回去的代码在**被动** effect 里（它得先有 `bytes`）。React 先画、被动 effect 后跑，中间那帧就是 `.fp-frame` 的底色：亮色下是 `#ebeef2`，暗色下是 `#151517` 一片黑。修法不是盖一条进度条，而是让容器在**同一次渲染里**就位：`React.useLayoutEffect` 在浏览器绘制**之前**跑，把 `cachedPages` 直接 `appendChild` 回 `frameRef.current`（条件与重建路径完全一致——有页、有字节、`moduleRevision` 相同——所以不可能显示一个紧接着就要被丢掉的容器）。这样切回是「上一帧还有页面，下一帧还是那批页面」。
- **切回时那一次多余的重栅格化**：`setZoom` 原来无条件对每一页 `delete el.dataset.renderedZoom`、清 `.hlLayer`、`hide()` 每个文本层、`applyPageLayout()` 重写全部页盒，再 `renderVisible(true)` 强制重画可见页。重挂载调用它只是**担心**文档挂着的时候面板宽度变了，而通常根本没变。同一个模式、同一个尺寸进来，屏上的东西本来就是对的，这笔工作（779 页）纯粹是白做——读者看到的就是「黑一下，然后同样的像素回来」。现在 `setZoom` 在模式与缩放都没变时早退，只 `renderVisible()`（不 `force`，已有位图的页由 `renderPage` 自己跳过）；真的改过宽度才走完整路径。同理 `applyReadingPosition` 恢复滚动位置时不再 `force`——移动视口不失效任何一张位图。
- 打开时那一行会说清楚在等什么：读字节时报「已收到 128 KB / 4.2 MB · 3%」（宿主给了 Content-Length 才是确切百分比，否则进度条横扫），字节齐了改成「正在排版…」。

### 七个报上来的毛病

一次报了七条，逐条改完，每条留一条能翻回原样的实测事实（`?scenario=defects&paneH=300`，一轮跑完全在 `log:` 那一行里）：

| 报上来的 | 为什么会这样 | 改了什么 | 量到的事实 |
|---|---|---|---|
| 目录的折叠展开没固定在顶端 | 目录这一列的标题行和树是同一个滚动容器，树一滚标题跟着走 | 标题行 `flex:none`，树单独一层 `.fp-outline-list` 自己滚（`flex:1; min-block-size:0; overflow:auto`） | `headTopBefore=38 headTopAfterScroll=38 headStayedPut=true rowsMovedUnderHead=true outlineListScrolls=true` |
| 目录的圆角不需要 | 上一轮照浮层的样式给的圆角，可它本来就是贴边的一列 | 圆角去掉，与工具栏的直角对齐 | `outlineRadius=0px|0px` |
| 鼠标悬浮在「关闭」上，提示跑到很右边，还带出横向滚动条 | 宿主的 Tooltip 是绝对定位的浮层，它的包含块是 `.fp-panel`，在右边缘往外溢出，撑宽了 `.fp-root` 的可滚区域（495 px vs 面板 476 px）；而那个按钮自己写着 `aria-label="关闭"`，提示本来就是多余的 | 按钮不带提示（`Button` 多了一个 `tip` 开关，按自己说话或贴着面板边缘的那种控件关掉它），另给 `.fp-root` 一句 `overflow-x: clip` 兜住任何越界的浮层 | `sheetCloseTipWrap=false rootOverflowX=clip paneNoHScroll=true paneScroll=460/460` |
| 固定悬浮窗后大头钉图标没变化、窗口状态没变化 | 固定只是把 `pinned` 记在卡片上，没有任何东西画出来 | 图钉换实心图标（`fill:currentColor`）、`aria-pressed`、卡片描一圈主色 | `pinPressed=true pinGlyphChanged=true pinGlyphFill=currentColor pinCardRing=true pinCardFlag=true` |
| 固定之后划词不弹「翻译」 | 气泡和卡片是同一个元素：卡片钉住不走了，新选区就没地方出现 | 拆成两个元素、两个状态 —— 气泡 `.fp-chip` 每次都跟着新选区出现，卡片 `.fp-pick` 自己钉着；按气泡就把卡片原地填成新内容 | `chipWhilePinned=true cardsOnScreen=1 cardReusedByChip=true chipGoneAfterUse=true` |
| 章节高亮的白边永远在最左边，不管缩进多少 | 高亮画在行自己身上，行的 `padding-inline-start` 是缩进，可背景铺的是整个 padding box，左边那条 2 px 的起始线也就贴着列边 | 高亮改成行上的 `::before`，起止用同一个 `--fp-indent`（`inset-inline-start: var(--fp-indent)`），缩进多少就从哪儿开始 | `activeIndent=14 accentStart=14px accentFollowsIndent=true activeUsesPseudo=true` |
| 顶部页数没对齐；按钮翻页时页数会跳变 | 对齐：总数和页号是两块各占宽度的文本，中间对不齐；跳变：滚动处理器每帧按 `scrollTop + 80` 报「当前页」，翻页动画经过的中间页也被报了上去（25 → 26 → 25） | 页码变成一个居中的等宽数字输入框（`tabular-nums`），总数在右边以 `/ 12` 跟它同一基线；浏览器端记住「这次滚动的目的地」，在到达之前不报「当前页」 | `pagerAlign=center pagerCentred=true pagerTotal=/12`、`pagerSeries=2>3>4 pagerBacktracks=0`、`pagerArrowUp=5 / 12 pagerArrowDown=4 / 12`、`pagerDraftNotCommitted=true pagerBlurCommits=7 / 12` |

页码框顺带补上手感：↑↓ 在框里一次一页、**不离开框**（下一个数字还照样打得进去），输入的数字在离框（或回车）时才算数，`Escape` 撤掉草稿。以前箭头会顺手清掉草稿并退出编辑态，接着敲的数字就丢了。

### 「⋯」里放什么、不放什么

工具栏最右侧的「更多」菜单提供「文档属性」和「设置」两个入口：

- 文档属性是一次性的、读过就算，放工具栏上等于长期占着一格（460 px 宽的面板里一格就是 28 px），放菜单里一次点击就到。
- **阅读器偏好放在更多 → 设置**：提供翻译语言、新文档默认缩放和页面间距。偏好保存在本机；已有阅读位置优先于默认缩放。页面间距以 100% 缩放为基准，随页面同比缩放，修改后立即应用。模型和连接配置仍由宿主管理，不在插件设置中重复一份。
- 菜单只做一件事：`Escape` 先收菜单，菜单已经关了才轮到属性卡；点菜单外面也收。前者由 `client-smoke` 那条「the overflow menu closes before the sheet」守着（读源码里两个 `Escape` 分支的先后——桩件按不了两次键），后者和「点一行就收起」由 `port` 场景的 `menuClosedOnPick` 量。
- **开合状态只能挂在 `pressed` 上**：宿主的 `Button` 只把 `aria-pressed` 交给 DOM，手写的 `aria-haspopup` / `aria-expanded` 到不了元素上（浏览器里量过：`pressed=true`、另两个都是 `null`）。所以菜单开口用一个普通 `div`、里一个普通 `button`——不给它挂那句没实现的 `role="menu"`（挂了就得配方向键），也不写转不到 DOM 的 ARIA。

### 浏览器里验证过的（不依赖宿主）

用一个 headless Edge + 本地静态服务器跑真 pdf.js。页面、样本、驱动器都在 `tests/browser/` 里，样本是 `make-samples.mjs` 现搓的（4 页 / 12 页 / 200 页三份，另加一份加密的），不含任何第三方文档：

| 项 | 结果 |
|---|---|
| 挂起来 | `mount`：`plain.pdf` 4 页 → 4 个 canvas、`1 / 4`、工具栏按 `aria-label` 读出 `查找 后退 前进 上一页 下一页 缩小 放大 适应宽度 更多`（`更多` 在最右，`文档属性` 收在它里面）、缩放 67%、`frameHeight=683`、`toolbarOneRow=true`、`pagerOneRow=true`；没目录的文档不出现目录按钮（`outlineButtonAppeared=false`）；打开途中那行读过 `loadingSeen=正在打开`（本机 34 MB 的 `huge.pdf` 走插件自己的路由，字节到得太快，只抓到准备阶段；百分比那段由 `client-smoke.mjs` 按 `loadingState` 的入参/出参单独量） |
| 翻页 | `nav`（12 页）：连点两次「下一页」1 → 3，一次「上一页」回 2，同一帧内的两次点击也合成 1 步 |
| 缩放 | `nav`：`+` → 75%，点适应按钮回 67% |
| 双击 | `dblclick` 断言已更新：页面合成双击不被取消、倍率不变、既有选区保留；工具栏双击不改变倍率。本轮未重跑浏览器场景，也未验证原生选词 |
| 复制 | `copy`：面板认领事件且只写 `text/plain`（`copyDefaultPrevented` / `plainFlavourOnly`），选区在页面之外时一概不碰（`outsideUntouched=true`） |
| 查找 | `find`：搜 `Page` → `1 / 47`，命中处画出 15 个 `.hl` 落在 4 页上；`Escape` 后查找栏收起、高亮清到 0（`marksCleared=0`） |
| 键盘查找 | `hotkey`：点页面后按 `Ctrl+F`，浏览器查找被取消（`dispatchEvent` 返回 `false`）、自己的栏开出且输入框已聚焦、搜 `Page` 仍是 `1 / 47` 与 15 个高亮；再按一次栏不重开、焦点拉回；栏外单按 `f` 不被吞 |
| 目录 + 历史 | `outline`：12 行，点最后一行 1 → 10 页，`back` 回 1、`forward` 回 10。折叠：单个箭头折掉一个节点的 3 个子项（12 → 9）、「折叠全部」只剩顶层 3 行、「展开全部」回 12，折的那一下在 50 ms 时高 45 px、400 ms 后到底（打开时 67 px），`branchTransition=0.16s`；浮层不挤版面（开前开后 `frameWidth` 都是 460，`outlineOverFrame=true`）；第一页在首个条目之上，那一页没有高亮（`activeRow=null`），跳到 3.3 之后高亮落在那一行上 |
| 阅读位置 | `place`：停在第 5 页 2303 px（`scrollHeight=6960`、缩放 67%），卸载再重挂回到 `5 / 12` / 2303 px / 67% |
| 换渲染器 | `switch`：切到内置再切回来，`1 / 12`、12 个 canvas 都在 |
| 打不开 | `fail`：喂一份不是 PDF 的字节 → 「这个 PDF 打不开 / 文件不是有效的 PDF，或者已经损坏」+「重试」，再点仍失败且不出空白页 |
| 加密 PDF | `password`（`samples/pw-aes.pdf`）：问密码（输入框自动聚焦、空密码时「打开」禁用）→ 输入 → 5 页画出、卡片消失；`password-card` 另测卡片落在面板内（`81,288,300,147`）与 `Escape` 收起 |
| 划词翻译 | `select`：选中 → 气泡「翻译」→ 卡片里出现译文与 `swzc-tech / DeepSeek-V4.1-Flash-1017`，卡片落在焦点端下面 8 px（`firstBelow=8`）；靠页底那次翻到上面，离焦点端顶边也是 8 px（`bottomAbove=8`，`bottomFlipped=true`）；卡片始终在面板内、页面没有横向溢出。`translate-error` 走失败态：卡片里是那条消息、留着「重试」 |
| 两个文档 | `two`：见上面那张表 |
| 这一批新搬的 | `port`（`plain.pdf`）：页码框输入 `3` 回车 → `3 / 4`；查找先开「区分大小写」输 `page` → `没有找到`，关掉 → `1 / 4`，再开「整个词」仍 `1 / 4`；「⋯」里 1 行（`文档属性`），点开菜单就收起（`menuClosedOnPick=true`）、属性卡 14 行（`文件名=文档`、`页数=4`、`209.9 × 297.0 mm · 纵向`）、`Escape` 关得掉；气泡固定后的双击断言已更新为不取消事件、不改变倍率且保留固定卡片；这部分本轮尚未执行浏览器复验|
| 「⋯」菜单 | `menu`：一行 176×36 落在按钮正下方、右边对齐、都在面板内；`pressed=true`；`Escape` 先收它（`client-smoke` 按源码顺序查）、点一行就收起并打开属性卡（`port` 的 `menuClosedOnPick=true`） |
| 气泡的落点 | `anchor`（`outline.pdf`，跨 3 个 span 选一段）：正向选，气泡左边 = 焦点端左边（差 `0`）、上边离焦点端底边 `8`；反向选（焦点端翻到上一行），差仍是 `0` / `8`——钉的是焦点端，不是整段的并集框；按一下页面气泡收掉 |
| 大文档 | `perf`（`big.pdf` 200 页）：200 个页框、首屏画 4 页，数字在「打开一份 PDF 的代价」 |
| 滚动横扫 | `sweep`：200 页走到底，全程同时在册位图 8 个，堆 6.3–9.7 MB 锯齿，回到顶部仍是 8 个 |
| 开开关关 | `recycle`：六轮卸载后残留 canvas 都是 0，堆 `5.5 → 7.4` 峰值、净增 1.2 MB，每轮重挂都是 `1 / 4` |
| 两种按钮 | 同一场景跑 `&primitives=1` 与 `&primitives=0`（后者让 `require` 抛错，走降级按钮）：两遍事实现逐字相同，`frameHeight` 都是 683 |
| 真路由 | 全部场景都从 `/fast-pdf` 取资产（含 2.2 MB 的 module worker、cmaps、`.ttf`、`.wasm`），与静态服务器上一致 |
| 主题令牌 | 同一份 CSS 套两套**宿主真值**（从 `ui-theme` 客户端里逐条抄出来的，不是编的近似色）：`.fp-frame` 读到的是令牌本身（`rgb(242,243,245)`，不是兜底混色）；`&dark=1` 那套里工具栏、查找框、目录栏、密码卡片、译文卡一起变深，`&bare=1`（token 全设成 `initial`）走 CSS 里的兜底真值，两条路观感一致 |
| 工具栏宽度 | `&pane=` 逐档量：420 px 单行（`460x37` 是默认窗宽那一档）；360 / 300 / 260 px 整条变两行（`67` 高），缩放组整体挪到第二行，不会被切掉；页码框和 `/ 4` 在任何一档都同一行（`pagerOneRow=true`）。`文档属性` 从工具栏挪进「⋯」之后总格数没变（一个按钮换一个按钮），所以这几档的断点与上一轮逐字相同 |

### 把组件本身挂起来跑过（真 React，不是假壳）

上面那张表测的是渲染核心。组件这一层（`PdfBody`）另有一轮：用 React 18 的 UMD 版把 `client.js` 注册出来的那个组件真挂到 `createRoot` 上，喂 `content: { kind: "bytes" }`、`t`、`useTabInfo`、`retainTab` —— 形状照宿主那份 `CodeBody` 抄的。

最后这些场景又**改从插件自己的 `/fast-pdf` 路由加载**（`host-route-live.mjs --serve`，页面放在服务器根上）：pdf.js 本体、module worker、cmaps、标准字体、wasm 全从那条路由取，划词翻译那一次也真的打到路由上而不是被 stub 掉——卡片上的 `p-1 / m-1` 就是路由里那个假 `llm` 给的，`routeRaw` 也记着整段 JSON。

| 项 | 结果 |
|---|---|
| 注册 | 注册项字段 `id + extensions + binaryExtensions + title + loading + wrap`，**没有** `priority`；body key `dsh-fast-pdf/pdf`；inject 得到 `sessionId + retainTab`，`retainTab` 被调到（`retainedTabs=retain:tab-body`） |
| 首次渲染 | 12 页全部建框、首屏画出（`canvases=12`、`pagesCount=1 / 12`）；工具栏九个按钮按 `aria-label` 读出来（多了「文档属性」），目录按钮在 outline 到了之后才出现 |
| 查找 | 输入 `Page` → `1 / 47`、15 个 `.hl` 落在 4 个页面上；`Escape` 一起清掉 |
| 划词翻译 | 选中文本 → 浮出「翻译」→ 卡片里出现译文、`swzc-tech / DeepSeek-V4.1-Flash-1017`、复制按钮；请求体带着选中的文字与 `sessionId`（`requestedSession=sess-46`） |
| 加密 PDF | 卡片出现（标题、提示、输入框自动聚焦、空密码时「打开」禁用）→ 输入 → `打开` → 5 页画出、卡片消失 |
| 阅读位置 | `place`：停在第 5 页 2303 px，卸载再挂载回到 `5 / 12`、`scrollTop` 也是 2303、缩放 67% |
| 打不开 | 同上：说「这个 PDF 打不开」，给「重试」，再点仍失败且不出空白页 |
| 取消密码 | 卡片上按 `Escape`：卡片收起，说明「没有输入密码，PDF 没有打开」，给「重试」 |
| 翻译失败 | 宿主返回 `ok: false`：卡片里是那条消息，底部留一个「重试」，不必重新划词 |
| 窄面板 | 260 px：工具栏换两行、`page-width` 32%、目录浮层收到 `min(240px, 78%)`、密码卡片与译文卡片都在面板内 |
| 两种按钮 | `primitives=1` 与 `primitives=0` 两遍事实现逐字相同，`frameHeight` 都是 683、卡片都是 `300×91` / `300×147`、都没有横向溢出 |
| 走真路由 | 所有场景改从 `/fast-pdf` 取资产（含 2.2 MB 的 module worker、cmaps、`.ttf`、`.wasm`），行为与静态服务器上一致 |
| 真发一次翻译 | 划词 → 点「翻译」→ POST 带 `x-dsh-fast-pdf: translate` → 路由回 `200 {"ok":true,...}` → 卡片显示译文与路由选中的 `p-1 / m-1`（这一条是路由桩，真模型那条在 `select` 场景） |

这轮靠它抓到并修掉的五个真问题：

1. **连点翻页会吞掉一步** —— `go()` 原来按 `view.page`（上一次渲染的值）算目标页，同一帧内的两次点击读到同一个值。改成问渲染器自己 `viewer.currentPage`。
2. **译文卡片会跑出面板** —— 锚点按「按钮宽 92px」收边，卡片却是 300px 宽，靠边的选中会让卡片伸到面板外、把整页顶出横向滚动条。现在按卡片实际宽度分两个落点，卡片还是 `border-box`，底部放不下时翻到选中上方。
3. **窄面板里三处硬宽度** —— `.fp-root` 没声明 `flex: auto; inline-size: 100%`（父级若是横向 flex 就会缩成内容宽）、目录栏固定 190px、密码卡片少 `box-sizing`。都改成不依赖父级方向 / 按面板收窄。

4. **阅读位置其实一直存的是 0** —— 页号能记住、滚动位置记不住。`savePlace()` 在 `useEffect` 的清理函数里读 `getState()`，而被动清理跑在 React 拆掉节点之后：那时 `frameRef.current` 已经是 `null`、元素也已脱离文档，`scrollTop` 只能读到 0。现在滚动时（`onScrollPosition`）就把当时的 `getState()` 存进 ref，清理时用这份；并且只在节点还连着的时候才更新它（卸载途中的 `onState` 会再报一次 0，把好数据盖掉）。

5. **恢复位置会被布局截断** —— `open()` 在页框量出各自高度之前就 resolve，紧接着 `applyReadingPosition` 的 `scrollTo` 落在一个只有几百像素的滚动范围上，被浏览器钳到 0，还不报错。核心加了 `scrollToOffset()`：先滚一次，之后每帧看范围够不够长，不够再补；范围一够就纠正一次并停手（所以刚打开就自己滚的用户不会被抢）。

另外两处顺手的：pdf.js 的英文错误（`Invalid PDF structure.`、`No password given`）不再直接吐给用户，改成中文一句、原文留在 `title` 里；翻译失败时卡片底部给一个「重试」。

### 真宿主上读回来的（这两条以前的"待验证"）

页面自己报上来的，不是我推的。按一下 unlag 的刷新按钮（22:03:36 那次 `plugins reloaded`），页面重进之后 `GET http://127.0.0.1:53776/fast-pdf/hello` 里就是这两行：

```json
{ "kind": "apply", "id": "dsh-fast-pdf/pdf", "tookMs": 5,
  "candidates": ["dsh-fast-pdf/pdf",
                 "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf"] }
```

`candidates[0]` 是这个插件 —— 默认位是我们的；`candidates[1]` 是内置的，还在队列里，所以「打开方式」下拉会出现、能够切回去。`node tests\host-live.mjs http://127.0.0.1:53776 --page` 把它读成四行 ok：

```
ok  the host answers the beacon route — 8 report(s)
ok  the browser half applied inside the running page — applied 371s ago, took 47ms
ok  the pane's default .pdf seat is this plugin, with the built-in still behind it
    — dsh-fast-pdf/pdf → @deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf
ok  the running page applied this build of the bundle — applied 1s after the last edit
```

同时读回来的还有一件关于这台机器的事：`unlag` 会把"旧的 revision"当成"要最新那份"来答（日志里的 `bundles asked for under an older revision are answered at the current one`），所以"编一个假 revision 应该 404"这条探针在有 unlag 的机器上会是 200，这是插件之外的事，自检里改成如实说明两种情形。

### 真文件打开过（最后一格记录，这回补上了）

2026-11-12 22:27，用户在真 GUI 里打开 `000-AA-Coincidence Detector Diagnostic.pdf`（1,141,210 B），面板整块空白。三条报告把这件事钉死：

```json
{ "kind": "bytes", "bytes": 1141210, "wrap": "true", "tType": "function",
  "sessionId": "session-14421e7e-…",
  "propKeys": "addResource+content+inputActions+renderFactorySlot+resourceAddress+retainTab+scrollportRef+sessionId+setResources+t+useAccess+useChat+…" }
{ "kind": "body-crash", "message": "Cannot read properties of undefined (reading 'forget')",
  "stack": "TypeError: … at retainTab (…/dsh-fast-pdf/client.js&rev=ccafcd3806b0:1477:84) at …:609:69" }
```

即：字节到了、正文渲染到了，是挂载副作用里那句 `actions.forget` 把整棵树炸掉了（根因和修法见上面"为什么以前会整块空白"）。修完刷新之后再开同一份文件、外加另一份 2.1 MB 的：

```
22:32:40  kind=bytes   bytes=2153747  →  kind=mount
22:32:49  kind=mount
22:33:58  kind=mount
```

没有 `body-crash`，`mount` 每次都到。同一份文件在 `tests/browser` 里也单独跑过一遍（`mount` 场景，`-Sample real.pdf`）：10 页、10 张画布、`outlineButtonAppeared=true`（它自带目录）、65% 缩放。

顺便修了一条自检的度量：`pageAt` 是**文档的出生时间**，而刷新按钮是就地重建界面（文档不变，插件重新 `apply`），所以"页面比这份 bundle 新"用 `pageAt` 量会假失败；改成比**最后一条 `apply` 的时间**。

其余三件已经验过，别再当成"待验证"：

- **真主题**：套的是宿主真值（`#ebeef2`/`#151517`、`#0f1115`/`#f9fafb`……都是逐条从 `ui-theme` 客户端抄的），光线/暗色两套截图里工具栏、查找栏、目录、密码卡片、译文气泡一起跟着换；
- **真模型翻译**：不是桩，走的是 53776 这个宿主上的 `/fast-pdf/translate`，`swzc-tech / DeepSeek-V4.1-Flash-1017`，en→zh 一次 364–390 ms；
- **上游的问答**：不移植是决定，不是欠账 —— DSH 的对话本身就是那件事。

### 34 MB 的那一份，翻页和查找也走通了

`make-samples.mjs` 里那份 `huge.pdf`（35,666,428 B，正好越过 32 MiB 的墙）在自检场里当普通样本用：`mount` 场景 40 张画布全出来、`reader=plugin-route`（字节走的是 `/fast-pdf/file`，不是宿主内存里的 `content`）；`find` 场景搜 `Page` 得 `1 / 40`，3 处高亮落在 3 页上，`next` 跳到 2/40，`Escape` 清干净。也就是说"大文件"这条路上没有另外一套代码——它和解压后的小文件走同一条。

## 许可与第三方

本仓库是 MIT（见 `LICENSE`）。仓库里还有两块别人的东西：

- **`public/viewer.mjs`** 是浏览器扩展 [`fast-pdf-viewer`](https://github.com/Stewart222b/fast-pdf-viewer) 里 `web/js/viewer.js` 的移植（改 import 路径、i18n，末尾把 `ViewHistory` 一并导出）。那份扩展也是 MIT，所以 `LICENSE` 末尾原样保留了它的版权声明 —— MIT 要求「版权声明随副本一起提供」，这一条别删。
- **`public/pdf.mjs`、`pdf.worker.mjs`、`pdf_viewer.mjs`、`pdf_viewer.css`** 以及 `public/cmaps/`、`public/standard_fonts/`、`public/wasm/` 是 pdf.js 官方构建（Apache-2.0，Copyright 2024 Mozilla Foundation，与宿主内置版本一致）。各自的许可正文就在目录里：`public/cmaps/LICENSE`、`public/iccs/LICENSE`、`public/standard_fonts/LICENSE_*`、`public/wasm/LICENSE_*`。

设计上参考了 Edge 内置 PDF 阅读器的一些交互（连续滚动、目录浮层、查找栏、加载进度），实现全部是自己写的；行为对标写在 README 的实测表里。
