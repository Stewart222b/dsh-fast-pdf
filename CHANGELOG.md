# 更新记录

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。0.x 期间次版本号带新功能、修订号带修复。

## 0.3.0 — 首个公开发布

这是第一次发到 npm。0.1.x / 0.2.0 只在本地迭代，没有发布。

- 打包修正：`files` 补上 `extract.js` 与 `paths.js`。此前这两支从 `tools.js` 里被 import，却不在发布清单里，装上去会在加载阶段报 `ERR_MODULE_NOT_FOUND`。
- `private` 去掉，补 `repository` / `homepage` / `bugs` / `author` / `engines`。
- 补 `locale/en.json`、`locale/zh.json`，插件管理器里的标题与说明不再退回包名和英文描述。
- 补原创图标 `icon.svg` 与详情页配图 `docs/preview.svg`。
- 新增 `tests/pack-manifest.mjs`：检查发布清单、locale、图标、详情文档，并从 `index.js` / `client.js` 走一遍 import 图，确认每个会被加载的本地文件都在 `files` 里。挂在 `prepack` 上，清单漏文件时 `npm pack` 直接失败。

### 修复

- Windows 上从路径打开的文档，标题显示成整条路径（`C:\work\a.pdf`）而不是文件名。`fileNameOf` 原来只按 `/` 切，现在两种分隔符都认。

## 0.2.0

- 对话不必先打开面板也能读工作区的 PDF：宿主半边注册了 `pdf_open`、`pdf_search`、`pdf_read_pages`、`pdf_outline`、`pdf_page_image`、`pdf_list` 六个工具。
- 答案里的页码可以直接跳到那一页。

## 0.1.0

- 右侧栏 PDF 预览器接管 `.pdf`：连续滚动、缩放、适应宽度、目录、查找、页码跳转、文档属性、后退/前进、按标签页记阅读位置。
- 划词翻译、加密 PDF 密码卡片、标签页字节保留。
