/**
 * dsh-fast-pdf — the browser half.
 *
 * It registers a `.pdf` document preview that ranks above the built-in one and
 * the body that preview opens. The renderer is a plain ES module served by the
 * host half from `/fast-pdf/`, so pdf.js never enters the plugin bundle: the
 * page only pays for it when a PDF is actually opened.
 *
 * The registration omits `priority`, which is what makes this the default
 * renderer — the built-in PDF previewer declares `priority: "builtin"` and
 * sorts below every third-party preview while staying in the renderer dropdown.
 *
 * Everything the toolbar does is a call into the ported core (`viewer.mjs`).
 * This file owns only the seats around it: a page/zoom row, an outline column,
 * and a find bar.
 */
window.__ModuleLoader__.load({
  id: "dsh-fast-pdf",
  factory(require) {
    const React = require("react");


    /** Locale namespace of this plugin's own chrome. */
    const NS = "fastPdf";
    /** Document-preview id; also the slot key of the body below. */
    const PREVIEW_ID = "dsh-fast-pdf/pdf";
    /** Host route (registered by index.js) holding the renderer and pdf.js. */
    const ASSET_DIR = "fast-pdf/";
    /** Milliseconds between the last keystroke and the search it triggers. */
    const FIND_DEBOUNCE_MS = 350;
    /** Milliseconds of quiet scrolling before the reading place is captured. */
    const PLACE_DEBOUNCE_MS = 400;
    /** How many tabs keep a reading place. */
    const PLACE_LIMIT = 24;
    /** Longest passage the selection bubble will send. */
    const SELECTION_LIMIT = 6000;
    /** How long a translation may stay unanswered before the card offers a retry. */
    const TRANSLATE_TIMEOUT_MS = 60000;
    /** Width of the translate pill, and the one line of height it takes. */
    const PILL_WIDTH = 92;
    const PILL_HEIGHT = 30;
    /** Width and tallest height of the translation card — mirror `.fp-pick-card`. */
    const CARD_WIDTH = 300;
    const CARD_TALL = 260;
    /**
     * The largest file this viewer will read.
     *
     * The Host's ceiling is 32 MiB and it applies it before the body is even
     * mounted: a whole-file read above `maxFileBytes` fails, and the pane then
     * draws its own "too large" card instead of calling the body at all. A
     * body that wants bigger files has to bring its own content
     * (`loading: "renderer"`) and read the bytes itself, so this constant —
     * checked on both halves — is the real ceiling.
     */
    const MAX_PDF_BYTES = 256 * 1024 * 1024;
    /** Scheme every workspace-file address opens with. */
    const FILE_PREFIX = "dsh-resource://file/";

    /**
     * The Host's own UI collection.
     *
     * The shell seeds a fixed table of modules into every client plugin's
     * `require` — react, react-dom, cordis, zod, the client store, the slot
     * registry, `ui-primitives` and `dockkit` — so the primitives are the same
     * buttons, icons and tooltips the rest of the app is built from. Using them
     * means this pane inherits the Host's hover, focus and disabled states
     * instead of re-deriving them. A shell that does not seed the table (or a
     * primitives build without `Button`) turns every helper below into a plain
     * element with the same handlers, so nothing here is load-bearing.
     */
    const UI = (() => {
      try {
        const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
        return primitives?.Button == null ? null : primitives;
      } catch {
        return null;
      }
    })();

    /**
     * An icon from the Host set, or the drawn stand-in where the set has none.
     *
     * The built-in document preview does exactly this for zoom-out: there is no
     * minus in the icon set, so it puts a 16-unit stroke-1.5 `<path>` where the
     * icon would go. Same box, same stroke, so a drawn one and a set one sit in
     * a row without looking like two different toolbars.
     * @param name - icon export name.
     * @param path - `d` of the stand-in, drawn in a 16×16 box.
     * @param weight - `solid` fills the shape as well as stroking it, which is
     * how a two-state icon (the pin) says which state it is in without a second
     * picture.
     */
    function icon(name, path, weight) {
      const Stock = UI?.[name];
      if (Stock != null) return React.createElement(Stock, { size: 14, "aria-hidden": "true" });
      return React.createElement(
        "svg",
        { width: "14", height: "14", viewBox: "0 0 16 16", "aria-hidden": "true" },
        React.createElement("path", {
          d: path,
          fill: weight === "solid" ? "currentColor" : "none",
          stroke: "currentColor",
          strokeWidth: weight === "solid" ? "1.2" : "1.5",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    /** Stand-in paths for the actions the Host icon set does not carry. */
    const DRAWN = {
      // Copied from the built-in zoom controls: the same minus the app draws.
      minus: "M2 8h12",
      historyBack: "M6.5 3.5 3 7l3.5 3.5M3 7h6a4 4 0 0 1 0 8H6",
      historyForward: "M9.5 3.5 13 7l-3.5 3.5M13 7H7a4 4 0 0 0 0 8h3",
      fitWidth: "M2.5 4v8M13.5 4v8M5 8h6M6.8 6.2 5 8l1.8 1.8M9.2 6.2 11 8l-1.8 1.8",
      fitPage: "M3.5 2.5h9v11h-9zM5.5 8h5M6.8 6.4 5.5 8l1.3 1.6M8.2 6.4 9.5 8l-1.3 1.6",
      // Two chevrons, one outward and one inward: the outline's all / none.
      expandAll: "M4 6.5 8 2.5l4 4M4 9.5l4 4 4-4",
      collapseAll: "M4 2.5l4 4 4-4M4 13.5l4-4 4 4",
      // Two sheets for 复制, one tick for 已复制 — drawn only if the Host's icon
      // set has no glyph under the name asked for.
      copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
      check: "M3.5 8.5 6.6 11.6 12.5 4.8",
    };

    const zh = {
      title: "快速 PDF",
      loading: "正在打开 PDF…",
      failed: "这个 PDF 打不开",
      invalidPdf: "文件不是有效的 PDF，或者已经损坏",
      missingPdf: "读不到这个文件，可能已经移动或删掉了",
      retry: "重试",
      previous: "上一页",
      next: "下一页",
      zoomIn: "放大",
      zoomOut: "缩小",
      fitWidth: "适应宽度",
      fitPage: "整页显示",
      historyBack: "后退到上一个位置",
      historyForward: "前进到下一个位置",
      outline: "目录",
      find: "查找",
      findPlaceholder: "在本 PDF 中查找",
      findPrevious: "上一个",
      findNext: "下一个",
      // Three different nothings, and the bar used to show only one of them —
      // the case that never happened. See the count in the find bar.
      findSearching: "正在搜索…",
      findIndexing: "正在建立索引…",
      findIndexingProgress: "索引中 {current}/{total}",
      findNone: "没有找到",
      translate: "翻译",
      translating: "翻译中…",
      translateTimeout: "翻译等太久了，请重试",
      copy: "复制",
      copied: "已复制",
      close: "关闭",
      passwordTitle: "这个 PDF 需要密码",
      passwordHint: "输入打开密码",
      passwordWrong: "密码不对，再试一次",
      passwordPlaceholder: "密码",
      passwordOpen: "打开",
      passwordCancel: "取消",
      passwordCancelled: "没有输入密码，PDF 没有打开",
      readUnavailable: "这个宿主版本没有开放文件读取，打不开这个文件",
      tooLarge: "这个 PDF 超过了能打开的大小上限",
      selectionTooLong: "选中的内容太多了，一次最多翻译 {count} 个字符",
      pageNumber: "页码",
      matchCase: "区分大小写",
      wholeWord: "整个词",
      expandAll: "展开全部",
      collapseAll: "折叠全部",
      unfoldNode: "展开这一节",
      foldNode: "折叠这一节",
      properties: "文档属性",
      settings: "设置",
      translationLanguage: "翻译语言",
      languageAuto: "自动检测",
      languageChinese: "简体中文",
      languageEnglish: "English",
      defaultZoom: "新文档默认缩放",
      defaultZoomHint: "已有阅读位置会优先恢复。",
      pageGap: "页面间距（100%）",
      pageGapHint: "随页面同比缩放，修改后立即应用。",
      more: "更多",
      fileName: "文件名",
      fileSize: "大小",
      documentLocationPath: "位置",
      documentTitle: "标题",
      documentAuthor: "作者",
      documentSubject: "主题",
      documentKeywords: "关键词",
      documentCreationDate: "创建时间",
      documentModDate: "修改时间",
      documentCreator: "创建程序",
      documentProducer: "生成程序",
      pdfVersion: "PDF 版本",
      documentPageCount: "页数",
      pageSize: "页面尺寸",
      fastWebView: "快速 Web 查看",
      pagePortrait: "纵向",
      pageLandscape: "横向",
      pageSizeValue: "{width} × {height} mm（{orientation}）",
      fileSizeBytes: "{count} 字节",
      fileSizeKb: "{count} KB",
      fileSizeMb: "{count} MB",
      yes: "是",
      no: "否",
      loadingWaiting: "正在读取文件…",
      loadingReceived: "已读取 {loaded}",
      loadingBytes: "已读取 {loaded} / {total}（{percent}%）",
      loadingPrepare: "正在解析版面…",
      loadingPreparePages: "正在排版 {loaded} / {total} 页",
      stop: "停止",
      pin: "固定这个翻译",
      unpin: "取消固定",
      source: "原文",
    };

    const en = {
      title: "Fast PDF",
      loading: "Opening PDF…",
      failed: "This PDF could not be opened",
      invalidPdf: "This file is not a valid PDF, or it is damaged",
      missingPdf: "This file could not be read — it may have moved or been deleted",
      retry: "Retry",
      previous: "Previous page",
      next: "Next page",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fitWidth: "Fit width",
      fitPage: "Fit page",
      historyBack: "Back to the previous position",
      historyForward: "Forward to the next position",
      outline: "Outline",
      find: "Find",
      findPlaceholder: "Find in this PDF",
      findPrevious: "Previous match",
      findNext: "Next match",
      findSearching: "Searching…",
      findIndexing: "Building index…",
      findIndexingProgress: "indexing {current}/{total}",
      findNone: "No matches",
      translate: "Translate",
      translating: "Translating…",
      translateTimeout: "The translation took too long — try again",
      copy: "Copy",
      copied: "Copied",
      close: "Close",
      passwordTitle: "This PDF needs a password",
      passwordHint: "Enter the password to open it",
      passwordWrong: "Wrong password, try again",
      passwordPlaceholder: "Password",
      passwordOpen: "Open",
      passwordCancel: "Cancel",
      passwordCancelled: "No password was entered, so the PDF stayed closed",
      readUnavailable: "This host build does not expose file reads, so this file cannot be opened",
      tooLarge: "This PDF is larger than the size this viewer will open",
      selectionTooLong: "That is too much to translate at once — {count} characters at most",
      pageNumber: "Page number",
      matchCase: "Match case",
      wholeWord: "Whole word",
      expandAll: "Expand all",
      collapseAll: "Collapse all",
      unfoldNode: "Expand this section",
      foldNode: "Collapse this section",
      properties: "Document properties",
      settings: "Settings",
      translationLanguage: "Translation language",
      languageAuto: "Auto detect",
      languageChinese: "Chinese (Simplified)",
      languageEnglish: "English",
      defaultZoom: "Default zoom for new documents",
      defaultZoomHint: "Saved reading positions take priority.",
      pageGap: "Page spacing at 100%",
      pageGapHint: "Scales with document zoom. Changes apply immediately.",
      more: "More",
      fileName: "File name",
      fileSize: "Size",
      documentLocationPath: "Location",
      documentTitle: "Title",
      documentAuthor: "Author",
      documentSubject: "Subject",
      documentKeywords: "Keywords",
      documentCreationDate: "Created",
      documentModDate: "Modified",
      documentCreator: "Creator",
      documentProducer: "Producer",
      pdfVersion: "PDF version",
      documentPageCount: "Pages",
      pageSize: "Page size",
      fastWebView: "Fast web view",
      pagePortrait: "portrait",
      pageLandscape: "landscape",
      pageSizeValue: "{width} × {height} mm ({orientation})",
      fileSizeBytes: "{count} bytes",
      fileSizeKb: "{count} KB",
      fileSizeMb: "{count} MB",
      yes: "Yes",
      no: "No",
      loadingWaiting: "Reading the file…",
      loadingReceived: "{loaded} read",
      loadingBytes: "{loaded} of {total} ({percent}%)",
      loadingPrepare: "Reading the page layout…",
      loadingPreparePages: "Laying out {loaded} of {total} pages",
      stop: "Stop",
      pin: "Pin this translation",
      unpin: "Unpin",
      source: "Source",
    };

    /** One in-flight module import shared by every body instance. */
    // A host plugin refresh can preserve the document and its ES-module cache.
    // Use one revision for this factory, while retaining per-factory deduplication.
    let moduleRevision = Date.now().toString(36);
    function moduleAssetUrl(path, base) {
      const url = new URL(assetUrl(path, base));
      url.searchParams.set("plugin-rev", moduleRevision);
      return url.href;
    }
    let viewerModule;

    /** The ported helper modules, one in-flight import per file. */
    const helperModules = new Map();

    /**
     * Where each tab was reading, keyed by tab id.
     *
     * Reopening a 300-page document should not start at page 1. The document
     * slot hands the tab over on every mount, and the client bundle outlives any
     * single mount, so this map is all the storage a closed-then-reopened tab
     * needs — no host state and nothing written to disk.
     */
    const places = new Map();

    /**
     * Keep the reading place of one tab, bounded so a long session cannot grow
     * this map without limit.
     * @param tabId - document tab id.
     * @param place - page, zoom and scroll offsets.
     */
    function rememberPlace(tabId, place) {
      if (typeof tabId !== "string" || place === undefined) return;
      places.delete(tabId);
      places.set(tabId, place);
      while (places.size > PLACE_LIMIT) {
        const oldest = places.keys().next();
        if (oldest.done) break;
        places.delete(oldest.value);
      }
    }

    /** Props fallback for a slot that does not expose tab information. */
    const noTabInfo = () => ({});

    /**
     * Documents that are still open in this page, keyed by the address they
     * were opened from.
     *
     * Switching PDFs in the tab bar used to re-read the whole file and rebuild
     * every page: 35 MB through the Host bridge and 779 canvases per switch.
     * That is why a reader expects "opened once, switch is instant" and did not
     * get it. What is expensive here is the *viewer* — pdf.js document, page
     * elements, bitmaps, text index — so that is what is kept, and coming back
     * to a file hands the same nodes to the pane instead of making them again.
     *
     * Keyed by address, not by content: DSH hands the body a fresh `revision`
     * on every mount, so a revision cannot tell "the same file" from "a file
     * that changed". An entry therefore lives for the page session and is only
     * dropped by eviction, by an explicit retry, or by the page going away.
     * Bounded because a viewer holds bitmaps for the pages near the viewport.
     */
    const openDocuments = new Map();
    const OPEN_DOCUMENT_LIMIT = 4;

    /**
     * Drop one open document for good: cancel its work, free its bitmaps.
     * @param address - resource address the viewer was opened from.
     */
    function closeOpenDocument(address) {
      const entry = openDocuments.get(address);
      if (entry === undefined) return;
      openDocuments.delete(address);
      try {
        entry.viewer?.close?.();
      } catch {
        /* a closing viewer must not break the caller */
      }
      entry.pages?.remove();
    }

    /**
     * Record a document as open, evicting the least recently used one.
     * @param address - resource address.
     * @param entry - viewer, its page container and the state to resume at.
     */
    function rememberOpenDocument(address, entry) {
      const previous = openDocuments.get(address);
      if (previous !== undefined && previous !== entry) {
        try {
          previous.viewer?.close?.();
        } catch {
          /* ignore */
        }
        previous.pages?.remove();
      }
      openDocuments.delete(address);
      openDocuments.set(address, entry);
      while (openDocuments.size > OPEN_DOCUMENT_LIMIT) {
        const oldest = openDocuments.keys().next();
        if (oldest.done) break;
        closeOpenDocument(oldest.value);
      }
    }

    /**
     * Take a document out of the cache without closing it.
     * The caller is about to re-attach the very same page container.
     * @param address - resource address.
     * @returns the parked entry, or `undefined`.
     */
    function takeOpenDocument(address) {
      const entry = openDocuments.get(address);
      if (entry === undefined) return undefined;
      openDocuments.delete(address);
      openDocuments.set(address, entry);
      return entry;
    }

    /**
     * Resolve one asset URL against the page, so a reverse-proxy directory
     * prefix and the desktop shell's custom scheme both keep working.
     * @param path - route-relative asset path.
     * @param base - base URL to resolve against.
     * @returns absolute URL string.
     */
    function assetUrl(path, base) {
      return new URL(ASSET_DIR + path, base).toString();
    }

    /**
     * The document registry this half registered into, kept for one reason:
     * at registration time it can be asked which renderers a `.pdf` would match,
     * which is the only place the takeover order is visible from inside the app.
     */
    let previewRegistry = undefined;

    /**
     * Tell the host half that this half is alive, and with what.
     *
     * A client plugin has no console of its own out here: if this bundle fails
     * to load, registers the wrong id or loses the default seat, the pane simply
     * stays the built-in one and nothing says why. `Host route /fast-pdf/hello`
     * records the last few of these, so `tests/host-live.mjs --page` can ask the
     * running Host what the page said — no DevTools, no screenshot.
     * @param kind - `apply` once per page, `mount` once per opened document.
     * @param extra - additional fields for the payload.
     */
    function beacon(kind, extra) {
      try {
        if (typeof fetch !== "function" || typeof document === "undefined") return;
        const ids = (() => {
          try {
            const list = previewRegistry?.candidates?.("probe.pdf");
            return Array.isArray(list) ? list.map((entry) => String(entry?.id ?? "")) : undefined;
          } catch {
            return undefined;
          }
        })();
        const payload = {
          kind,
          id: PREVIEW_ID,
          path: String(document.baseURI ?? ""),
          pageAt: Math.round(Number(globalThis.performance?.timeOrigin ?? 0)),
          at: Date.now(),
          ...(ids === undefined ? {} : { candidates: ids }),
          ...extra,
        };
        void fetch(assetUrl("hello", document.baseURI), {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-fast-pdf": "hello" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* the pane works without this; never let it break a load */
      }
    }

    /**
     * Load the renderer module, once per page.
     *
     * The page base is the right origin in both transports (a browser origin or
     * the desktop shell's forwarded `dsh-app://app/`). If that import fails the
     * host's published origin is the fallback — the asset route answers with
     * `access-control-allow-origin: *` precisely so it can.
     * @returns promise of the renderer module namespace.
     */
    function loadViewer() {
      if (viewerModule !== undefined) return viewerModule;
      const page = typeof document === "undefined" ? undefined : document.baseURI;
      const transport = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
      viewerModule = (async () => {
        try {
          if (typeof page !== "string" || page === "") throw new Error("no page base");
          return await import(moduleAssetUrl("viewer.mjs", page));
        } catch (error) {
          if (typeof transport !== "string" || transport === "") throw error;
          return await import(moduleAssetUrl("viewer.mjs", `${new URL(transport).origin}/`));
        }
      })();
      viewerModule.catch(() => {
        // A failed download is worth retrying on the next mount, not caching.
        viewerModule = undefined;
      });
      return viewerModule;
    }

    /**
     * Load one of the ported helper modules, once per page and per file.
     *
     * These are the extension's own pure modules — selection text, outline
     * position, property rows, the markdown bubble — moved over whole rather
     * than rewritten, so the same rules decide the same cases on both sides.
     * Same two-base resolution as the renderer.
     * @param name - file name inside `public/`, e.g. `"selection-text.mjs"`.
     * @returns promise of the module namespace.
     */
    function loadHelper(name) {
      const cached = helperModules.get(name);
      if (cached !== undefined) return cached;
      const page = typeof document === "undefined" ? undefined : document.baseURI;
      const transport = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
      const pending = (async () => {
        try {
          if (typeof page !== "string" || page === "") throw new Error("no page base");
          return await import(moduleAssetUrl(name, page));
        } catch (error) {
          if (typeof transport !== "string" || transport === "") throw error;
          return await import(moduleAssetUrl(name, `${new URL(transport).origin}/`));
        }
      })();
      helperModules.set(name, pending);
      pending.catch(() => helperModules.delete(name));
      return pending;
    }

    /**
     * Turn a renderer failure into something the pane can say in its own
     * language. pdf.js answers in English (`Invalid PDF structure.`,
     * `No password given`), and those strings are not what a reader wants to
     * see; the raw text stays available as a tooltip for bug reports.
     * @param message - whatever the failure carried.
     * @param t - the bound dictionary.
     * @returns a sentence to show, or null to fall back to the raw message.
     */
    function describeFailure(message, t) {
      const raw = String(message ?? "");
      // Only "no password was given" is the reader's own cancel; any other
      // password failure is a real one and keeps its raw text.
      if (/No password|password required/i.test(raw)) return t("passwordCancelled");
      if (/Invalid PDF|not a PDF|structure|damaged/i.test(raw)) return t("invalidPdf");
      // The file-read failures arrive from the Host's filesystem, not pdf.js,
      // so they carry fs wording (`ENOENT`, `permission denied`) instead.
      if (/Missing PDF|Cannot read|fetch|network|Unexpected server|ENOENT|no such file|permission denied|EACCES/i.test(raw)) {
        return t("missingPdf");
      }
      return null;
    }

    /**
     * Whether an address names a file this plugin can ask for.
     *
     * Only the shape is checked here: `dsh-resource://file/<scope>/...` with a
     * known scope and at least one path segment. A `session` path may be
     * absolute or relative to that session's workspace root, so it is the host
     * half that turns the address into a path, using the same rule the Host's
     * own workspace reads use. This side never guesses a path.
     * @param address - a document tab's content address.
     * @returns the scope, or null when the address is not a file address.
     */
    function fileAddressScope(address) {
      const text = String(address ?? "");
      if (!text.startsWith(FILE_PREFIX)) return null;
      const cut = text.search(/[?#]/);
      const parts = text.slice(FILE_PREFIX.length, cut === -1 ? undefined : cut).split("/");
      const scope = parts.shift();
      if (scope !== "session" && scope !== "absolute") return null;
      if (parts.length === 0 || parts.every((part) => part === "")) return null;
      try {
        parts.forEach((part) => decodeURIComponent(part));
      } catch {
        return null;
      }
      return scope;
    }

    /**
     * 12.3 MB / 128 MB, for the one sentence that mentions a size.
     * @param count - byte count.
     * @returns the size a reader recognizes.
     */
    function humanSize(count) {
      const megabytes = Number(count) / (1024 * 1024);
      if (!Number.isFinite(megabytes) || megabytes <= 0) return "0 MB";
      return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
    }

    /**
     * Read the opened file through this plugin's own host route.
     *
     * `loading: "renderer"` means the Host hands the body a handle and no
     * bytes: bringing the content is the body's job. The bytes come from
     * `POST /fast-pdf/file`, which streams the file with a `content-length`, so
     * the progress line has a real denominator and nothing passes through the
     * Host's 32 MiB whole-file bridge.
     *
     * The route is on this plugin's own half rather than on
     * `remote.workspaceFiles` because that service is not reachable from a
     * third-party client plugin in this build (measured: `ctx.remote` exists,
     * `ctx.remote.workspaceFiles` does not). The address still has to be a
     * `session` address — the body only ever receives one — so the route is
     * never asked for a path the pane did not hand over.
     * @param address - the tab's `dsh-resource://file/session/...` address.
     * @param signal - aborts the read when the pane goes away.
     * @param onProgress - called with 0..1 as bytes arrive.
     * @returns `{ bytes, version }`.
     */
    async function readWholeFile(address, signal, onProgress) {
      const fail = (code, message) => {
        const error = new Error(message);
        error.code = code;
        return error;
      };
      const tooLarge = (size) => {
        const error = fail("too-large", `the file is ${String(size)} bytes`);
        error.size = size;
        return error;
      };
      if (fileAddressScope(address) === null) {
        throw fail("address", `not a file address: ${String(address)}`);
      }
      let response;
      try {
        response = await fetch(assetUrl("file", document.baseURI), {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-fast-pdf": "file" },
          body: JSON.stringify({ address: String(address) }),
          signal,
        });
      } catch (error) {
        if (signal?.aborted === true) throw fail("aborted", "aborted");
        throw fail("unavailable", String(error?.message ?? error));
      }
      if (response.ok !== true) {
        const detail = await response.json().catch(() => null);
        // A refused read says which address it could not turn into a file: the
        // one thing that cannot be recovered from the pane afterwards.
        beacon("read-fail", {
          status: Number(response.status),
          code: String(detail?.code ?? ""),
          message: String(detail?.message ?? "").slice(0, 160),
          address: String(address).slice(0, 220),
        });
        if (detail?.code === "too-large") throw tooLarge(Number(detail.size ?? 0));
        throw fail("read", String(detail?.message ?? `the file route answered ${String(response.status)}`));
      }
      const total = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(total) && total > MAX_PDF_BYTES) throw tooLarge(total);
      // A transport that buffers the body has no stream to read from; the
      // bytes are then all here already and the progress line just ends.
      if (typeof response.body?.getReader !== "function") {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_PDF_BYTES) throw tooLarge(bytes.length);
        if (typeof onProgress === "function") onProgress(1, { loaded: bytes.length, total: bytes.length });
        return { bytes, version: 1 };
      }
      const reader = response.body.getReader();
      const parts = [];
      let read = 0;
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (error) {
          if (signal?.aborted === true) throw fail("aborted", "aborted");
          throw fail("read", String(error?.message ?? error));
        }
        if (step.done === true) break;
        read += step.value.length;
        if (read > MAX_PDF_BYTES) {
          await reader.cancel().catch(() => {});
          throw tooLarge(read);
        }
        parts.push(step.value);
        // The reader's line names both numbers when the Host sent a length, so
        // the ratio travels with the bytes that produced it. Without a length
        // there is no ratio to write — the count still moves the line on.
        if (typeof onProgress === "function") {
          if (total > 0) onProgress(Math.min(1, read / total), { loaded: read, total });
          else onProgress(0, { loaded: read, total: 0 });
        }
      }
      // One buffer for pdf.js: a hundred stream chunks with their own offsets
      // is exactly the sort of shape that shows up as a truncated page.
      const bytes = new Uint8Array(read);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      if (typeof onProgress === "function") onProgress(1, { loaded: read, total: total > 0 ? total : read });
      return { bytes, version: 1 };
    }

    /** Inject the renderer's stylesheet rules once per page. */
    let stylesApplied = false;
    function applyStyles() {
      if (stylesApplied || typeof document === "undefined") return () => {};
      stylesApplied = true;
      const page = document.baseURI;
      const layer = document.createElement("link");
      layer.rel = "stylesheet";
      layer.href = assetUrl("pdf_viewer.css", page);
      layer.dataset.dshFastPdf = "pdfjs";
      const chrome = document.createElement("link");
      chrome.rel = "stylesheet";
      chrome.href = assetUrl("viewer.css", page);
      chrome.dataset.dshFastPdf = "viewer";
      // Both, layered first: pdf.js's own sheet is not optional decoration. Its
      // text-layer rules decide where every span sits, so dropping it to save
      // 160 KB shifts the selection rects (measured: 51,137 → 72,145) and loses
      // a search match. Ours goes second and only overrides the page box.
      document.head.append(layer, chrome);
      return () => {
        layer.remove();
        chrome.remove();
        stylesApplied = false;
      };
    }

    /**
     * Coerce the slot's byte content into a private copy.
     *
     * pdf.js transfers the buffer it is handed to its worker, which would leave
     * the tab's own copy detached and make a remount fail.
     * @param data - bytes supplied by the document slot.
     * @returns a detached copy, or `undefined` when the content is not bytes.
     */
    function copyBytes(data) {
      if (data instanceof Uint8Array) return new Uint8Array(data);
      if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
      return Array.isArray(data) ? Uint8Array.from(data) : undefined;
    }

    /**
     * Flatten a pdf.js outline tree into one indented list.
     *
     * Flat, but not unaware of the tree: every row keeps its id, its parent and
     * how many rows hang under it, which is what lets the column fold one node
     * away, fold the whole thing, and mark the chapter being read. A row's own
     * page and Y are filled in afterwards — they need the document, so resolving
     * them is the caller's job.
     * @param items - pdf.js outline nodes.
     * @param depth - current nesting level.
     * @param out - accumulator.
     * @param parent - id of the enclosing row, or "" at the top.
     * @param path - id prefix, so an id stays unique while rows are skipped.
     * @returns flat rows with their depth and tree bookkeeping.
     */
    function flattenOutline(items, depth = 0, out = [], parent = "", path = "") {
      for (const [position, item] of (items ?? []).entries()) {
        if (typeof item?.title !== "string" || item.title.trim() === "") continue;
        const id = path === "" ? `#${out.length}` : `${path}.${position}`;
        const row = { id, parent, title: item.title, dest: item.dest, depth, children: 0 };
        out.push(row);
        const before = out.length;
        flattenOutline(item.items, depth + 1, out, id, id);
        row.children = out.length - before;
      }
      return out;
    }

    /**
     * Hold a tab's bytes for as long as the tab lives.
     *
     * The document owner releases a tab's content when its body unmounts, so
     * switching to another file and back would re-read the PDF. The builtin image
     * and PDF bodies keep a retention seat instead; this rebuilds that on the
     * slot's `actions.forget`, when the slot hands one over — the seat is given up
    * when the tab's own
     * signal aborts, which is exactly when the tab is gone.
     * @returns `{retain, dispose}`.
     */
    function retainTabs() {
      const retained = new Map();
      return {
        retain(tabId, signal, forgetTab) {
          if (signal === undefined || typeof forgetTab !== "function") return;
          if (signal.aborted) {
            forgetTab(tabId);
            return;
          }
          if (retained.has(signal)) return;
          const forget = () => {
            signal.removeEventListener("abort", forget);
            retained.delete(signal);
            forgetTab(tabId);
          };
          retained.set(signal, forget);
          signal.addEventListener("abort", forget, { once: true });
        },
        dispose() {
          for (const forget of retained.values()) forget();
        },
      };
    }

    /** Display names of the two target languages the translator picks between. */
    const TARGET_LABEL = { Chinese: "中文", English: "英文" };

    /**
     * A control button.
     *
     * With primitives this is the Host's `Button` (small, ghost by default,
     * optionally wrapped in the Host's tooltip); without them it is a `<button>`
     * that carries the same label, state and handler. The `data-fp-btn` marker
     * is what the stylesheet hangs the fallback chrome on, so the two kinds
     * never style each other.
     *
     * `tip: false` leaves the Host's floating tooltip off. It is for a control
     * that says what it is on its own and sits beside a pane edge — the × on the
     * properties sheet, where the tooltip was reported to appear at the far
     * right of the pane and to drag a horizontal scrollbar in with it. The
     * accessible name stays either way.
     * @param props - label, disabled, pressed, onClick, icon, className, variant, tip, children.
     */
    function Button({ label, disabled, pressed, onClick, icon: leading, className, variant, tip = true, children }) {
      if (UI !== null) {
        const button = React.createElement(
          UI.Button,
          {
            size: "sm",
            variant: variant ?? "ghost",
            className: className === undefined ? "fp-btn" : `fp-btn ${className}`,
            title: label,
            "aria-label": label,
            "aria-pressed": pressed,
            "data-pressed": pressed ? "" : undefined,
            disabled,
            onClick,
            icon: leading,
            // The built-in zoom controls do this too: otherwise pressing a
            // toolbar button blurs the page and drops the reader's selection.
            onMouseDown: (event) => event.preventDefault(),
          },
          children,
        );
        if (UI.Tooltip == null || tip === false) return button;
        return React.createElement(
          UI.Tooltip,
          { label, side: "top", children: React.createElement("span", { className: "fp-tip" }, button) },
        );
      }
      return React.createElement(
        "button",
        {
          type: "button",
          className: className === undefined ? "fp-btn" : `fp-btn ${className}`,
          "data-fp-btn": "",
          "data-variant": variant,
          title: label,
          "aria-label": label,
          "aria-pressed": pressed,
          "data-pressed": pressed ? "" : undefined,
          disabled,
          onClick,
        },
        leading ?? null,
        children,
      );
    }

    /** Copy to the clipboard through the Host's helper when it has one. */
    function copyText(text) {
      if (typeof UI?.writeClipboard === "function") {
        void Promise.resolve(UI.writeClipboard(text)).catch(() => {});
        return;
      }
      void navigator.clipboard?.writeText(text).catch(() => {});
    }

    /**
     * Reflow a selection into the text a reader would have typed.
     *
     * The selection lives in pdf.js's text layer, where every line is its own
     * positioned `<span>`: the browser's own clipboard writes that back as one
     * block per span (a line break per line, plus the `text/html` flavour with
     * inline styles), so a copied paragraph arrives broken into a dozen lines
     * and pasted with formatting.
     *
     * The rules live in the extension's `selection-text.js`, which reads not
     * only `toString()` but the character geometry of the range: two spans that
     * merely sit next to each other are one word, a wide gap between them is a
     * space, a trailing hyphen is a hyphenation break, and whether a line starts
     * a paragraph is decided by how the previous one ended. This was a local
     * whitespace-joining helper before, which got Latin and CJK right and
     * `inter-\nnational` and `Page 12\n中文标题` wrong.
     * @param module - the loaded `selection-text.mjs`.
     * @param selection - the window selection inside the page area.
     * @returns plain text, with a blank line between paragraphs.
     */
    function selectionText(module, selection) {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      return module.normalizePdfSelectionText(selection?.toString() ?? "", range);
    }

    /**
     * Catch a render-time throw from the body and say so out loud.
     *
     * A pane whose body throws goes blank, and a blank pane says nothing about
     * why: the client bundle has no console out here and the mount effect never
     * runs, so `/fast-pdf/hello` would show no `mount` report and nothing else
     * either. This boundary turns that silence into one `body-crash` report (and
     * a readable line in the pane), which is the only way to tell "our render
     * threw" apart from "the Host never drew the slot".
     */
    // React tells a class component from a function one by
    // `prototype.isReactComponent`, not by its base class — so the base is only
    // there to supply that marker, and `Object` does when a stand-in React is
    // too thin to carry `Component`.
    const BoundaryBase = React.Component ?? Object;
    class BodyBoundary extends BoundaryBase {
      constructor(props) {
        super(props);
        this.props = props;
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        beacon("body-crash", {
          message: String(error?.message ?? error).slice(0, 300),
          stack: String(error?.stack ?? "").slice(0, 700),
          componentStack: String(info?.componentStack ?? "").slice(0, 700),
        });
      }

      render() {
        const { error } = this.state;
        if (error === null) return this.props.children;
        return React.createElement(
          "div",
          { className: "fp-status", "data-failed": "", "data-fp-crash": "" },
          React.createElement("div", null, "快速 PDF 出错了：",
            React.createElement("div", null, String(error?.message ?? error))),
        );
      }
    }

    /** The first body render reports what the slot handed over, once per page. */
    let gateReported = false;

    BodyBoundary.prototype.isReactComponent = {};

    /**
     * What the host's document slot actually mounts.
     *
     * Reports before rendering, so "the slot called us and here is what it
     * passed" is on record even when the body throws two lines later.
     * @param props - standard document-slot props.
     * @returns the body, guarded by the crash boundary above.
     */
    function PdfBodyGate(props) {
      if (!gateReported) {
        gateReported = true;
        const content = props.content;
        const data = content?.data;
        beacon("body-render", {
          kind: String(content?.kind ?? ""),
          bytes: Number(data?.byteLength ?? data?.length ?? -1),
          revision: Number(content?.revision ?? -1),
          read: typeof props.readBytes,
          wrap: String(props.wrap),
          tType: typeof props.t,
          sessionId: String(props.sessionId ?? ""),
          propKeys: Object.keys(props).sort().join("+").slice(0, 240),
        });
      }
      return React.createElement(BodyBoundary, null, React.createElement(PdfBody, props));
    }

    /**
     * The document body: toolbar, outline column, find bar and the renderer.
     * @param props - standard document-slot props.
     * @returns the mounted viewer.
     */
    function PdfBody(props) {
      const t = props.t ?? ((key) => key);
      // Some slots hand a fresh copy function per render; reading it through a
      // ref keeps the mount effect keyed on the bytes alone.
      const copy = React.useRef(t);
      copy.current = t;
      // Two ways in. A `bytes` body was handed the whole file by the Host; a
      // `renderer` body is handed a handle instead and reads the file itself,
      // because the Host refuses to read anything above its own 32 MiB cap and
      // never mounts a body when that read fails.
      const content = props.content;
      const rendererContent = content?.kind === "renderer" ? content : undefined;
      const inlineBytes = content?.kind === "bytes" ? content.data : undefined;
      const [bytes, setBytes] = React.useState(inlineBytes);
      /**
       * Which address those bytes belong to, set together with them.
       *
       * `bytes` alone cannot say which document is on screen — after a switch
       * the previous file's bytes are still in state for one render — and the
       * open effect needs a key it can look up in `openDocuments`.
       */
      const [sourceAddress, setSourceAddress] = React.useState("");
      /** The `revision`-independent version number the Host reported for them. */
      const bytesVersionRef = React.useRef(1);
      const [progress, setProgress] = React.useState(null);
      const rootRef = React.useRef(null);
      const frameRef = React.useRef(null);
      const pagesRef = React.useRef(null);
      const viewerRef = React.useRef(null);
      const [status, setStatus] = React.useState("loading");
      const [failure, setFailure] = React.useState("");
      const [attempt, setAttempt] = React.useState(0);
      const [view, setView] = React.useState({ page: 1, total: 0, scale: 1, mode: "page-width" });
      const [outline, setOutline] = React.useState(null);
      const [pane, setPane] = React.useState("none");
      /** The ⋯ menu at the right end of the bar. */
      const [menu, setMenu] = React.useState(false);
      // The outline's own view state: which chapter the viewport is under, and
      // which nodes the reader has folded away.
      const [chapter, setChapter] = React.useState("");
      // The entry an outline click landed on, and the page it landed on. Held
      // until the view moves off that page: see the note in `sync()`.
      const outlineHold = React.useRef({ id: "", page: 0 });
      const [folded, setFolded] = React.useState(() => new Set());
      const [find, setFind] = React.useState({
        query: "",
        hits: [],
        index: -1,
        // Two different nothings: a search still in flight (no answer yet) and
        // a background index still walking (any answer is partial).
        busy: false,
        indexing: false,
        // How far the background index has walked. Without these the bar could
        // only say 「正在建立索引…」 about a state it never entered — measured on
        // three files: `find.indexing` was never true, so a reader who typed a
        // query saw an empty bar for 400 ms and then a count that quietly grew.
        indexed: 0,
        pages: 0,
        matchCase: false,
        wholeWord: false,
      });
      /**
       * The translation card, and the pill that offers to open it.
       *
       * Two states rather than one, because they have two lifetimes. The pill
       * follows the selection and belongs to nobody; the card is something the
       * reader opened, can pin, drag and keep. Kept in one slot they could not
       * coexist — a pin had to make the pill disappear, which is exactly the
       * 「固定之后划词不再弹翻译」 bug.
       */
      const [pick, setPick] = React.useState(null);
      const pickDragCleanupRef = React.useRef(null);
      const pickDragPositionRef = React.useRef(null);
      const [chip, setChip] = React.useState(null);
      // The size the reader dragged the card to, or `null` for "as big as its
      // content". Kept above the card itself so the next translation opens in
      // the box the reader made, the way the extension keeps `bubbleRequestedWidth`.
      const [cardSize, setCardSize] = React.useState(null);
      // The document-properties card's rows, built from the open document the
      // first time it is asked for.
      const [sheet, setSheet] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [preferences, setPreferences] = React.useState({ translationLanguage: "auto", defaultZoom: "page-fit", pageGap: 14 });
      const preferencesRef = React.useRef(preferences);
      preferencesRef.current = preferences;
      /** Whether the stored preferences have been adopted into React state once. */
      const preferencesLoadedRef = React.useRef(false);
      // The page box is an input: what the reader is typing, which is not the
      // page they are on until they say so.
      const [pageDraft, setPageDraft] = React.useState("");
      // State, not a ref: leaving the box has to redraw it. When the draft ends
      // up empty — "abc" stripped to nothing, a cleared field — dropping it is
      // no change to `pageDraft` at all, so a ref-only flip rendered nothing and
      // the field kept showing the empty string long after the reader left it.
      const [pageDrafting, setPageDrafting] = React.useState(false);
      // The handlers read the ref, not the state: Escape clears the flag and
      // blurs the box inside one task, and state read back in that same task is
      // still the value from the last render — which made Escape commit the very
      // jump it was asked to cancel (measured: Escape on a typed 9 scrolled the
      // view from 0 to 4606 exactly like Enter).
      const drafting = React.useRef(false);
      // pdf.js asks for a password in the middle of opening and waits on the
      // answer, so the prompt keeps the resolver it has to hand back.
      const [password, setPassword] = React.useState(null);
      const passwordRef = React.useRef(null);
      const pickRef = React.useRef(pick);
      pickRef.current = pick;
      React.useLayoutEffect(() => {
        const position = pickDragPositionRef.current;
        if (!position || position.active) return;
        if (pick === null || pick !== position.pick ||
            (pick.moved?.left === position.left && pick.moved?.top === position.top)) {
          pickDragPositionRef.current = null;
        }
      }, [pick]);
      const chipRef = React.useRef(chip);
      chipRef.current = chip;
      /** Cancels the translation in flight — the card's 停止 button. */
      const pickAbort = React.useRef(null);
      // 「已复制」 is an answer to one press, not a new permanent label: left up,
      // the second press said nothing at all (measured: still 已复制 two seconds
      // later, while the clipboard did receive the new text).
      const copyReset = React.useRef(null);
      /** Which document the mounted viewer belongs to; see `savePlace`. */
      const viewerAddress = React.useRef("");
      /**
       * Which loading phase the line is in.
       *
       * The read and the layout both report progress for the same bar, and the
       * read's last callback can land after the layout has started — measured as
       * a "34 MB / 34 MB · 100%" line repainted in the middle of 正在排版, and as
       * the bar falling back from full. Only the phase that is current may
       * speak.
       */
      const loadingPhase = React.useRef("download");
      /** A selection read that found the page still settling; see `onSelect`. */
      const selectionRetry = React.useRef(0);
      /** The card's translation body; the ported markdown renderer fills it. */
      const pickBody = React.useRef(null);
      /** The card element itself, measured to decide above or below the anchor. */
      const cardRef = React.useRef(null);
      /**
       * Loaded helper modules by file name.
       *
       * A `copy` event has to be answered synchronously, so the selection-text
       * module is loaded with the pane rather than at the moment it is needed;
       * until it lands, a copy is handed back to the browser untouched.
       */
      const helperRef = React.useRef({});
      /** The properties card's rows, readable from a callback. */
      const sheetRef = React.useRef(null);
      sheetRef.current = sheet;
      const sheetRequestRef = React.useRef(0);
      /** The outline rows `sync()` ranks the reading point against. */
      const outlineRef = React.useRef(null);
      outlineRef.current = outline;
      // Which session's model answers a translation. The document slot hands the
      // owning session to the body through the registration's `inject`.
      const sessionRef = React.useRef(props.sessionId);
      sessionRef.current = props.sessionId;
      const findRef = React.useRef(find);
      const findInputRef = React.useRef(null);
      /** The ⋯ button and its popover, so an outside press can close it. */
      const moreRef = React.useRef(null);
      findRef.current = find;
      const findTimer = React.useRef(0);
      const placeTimer = React.useRef(0);
      /** The last state the viewer announced — see `savePlace`. */
      const lastState = React.useRef(null);
      // The tab identifies where to resume; tracking it through a ref keeps a
      // new tab from tearing down the mounted renderer.
      const useTabInfo = props.useTabInfo ?? noTabInfo;
      const { tab } = useTabInfo();
      const tabId = tab?.id;
      const tabIdRef = React.useRef(tabId);
      tabIdRef.current = tabId;
      const tabSignal = tab?.signal;
      const retainTab = props.retainTab;
      React.useEffect(() => {
        if (typeof retainTab === "function" && tabId !== undefined) retainTab(tabId, tabSignal);
      }, [retainTab, tabId, tabSignal]);
      React.useEffect(() => {
        beacon("mount", { mounted: true });
      }, []);
      // A popover closes on the next press anywhere else — the usual bargain, and
      // the reason the ⋯ menu needs no full-screen backdrop over the page.
      React.useEffect(() => {
        if (!menu) return undefined;
        const onDown = (event) => {
          if (event.target instanceof Node && moreRef.current?.contains(event.target) === true) return;
          setMenu(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
      }, [menu]);
      // The copy handler has to answer synchronously, so the selection rules are
      // fetched with the pane instead of at the moment a copy arrives.
      React.useEffect(() => {
        let live = true;
        for (const name of [
          "selection-text.mjs",
          "selection-anchor.mjs",
          "bubble-placement.mjs",
          "bubble-text.mjs",
          "outline-active.mjs",
          "loading-progress.mjs",
        ]) {
          void loadHelper(name).then(
            (module) => {
              if (live) helperRef.current[name] = module;
            },
            () => {},
          );
        }
        return () => {
          live = false;
        };
      }, []);
      // One look at how the pane actually lands on this display. "The text looks
      // rough" has two very different causes — fewer pixels per glyph (the fit
      // zoom in a narrow pane) or a raster that is being rescaled (a canvas that
      // is not `devicePixelRatio` times its CSS box) — and this says which
      // without needing a screenshot. It also reports the font the chrome
      // inherits, since the toolbar has no `font-family` of its own.
      React.useEffect(() => {
        // Wait for the first bitmap rather than for a fixed delay: the pane is
        // measured when there is something to measure, and a probe that never
        // fires is indistinguishable from one that says "nothing to report".
        let tries = 0;
        let timer = 0;
        const report = (canvas) => {
          try {
            const frame = canvas.closest(".fp-frame");
            const pageEl = canvas.closest(".page");
            const toolbar = document.querySelector(".fp-toolbar");
            const chrome = toolbar === null ? null : getComputedStyle(toolbar);
            const cssWidth = pageEl === null ? 0 : Number.parseFloat(pageEl.style.width) || 0;
            let scaled = "";
            for (let el = frame; el !== null && el !== document.documentElement; el = el.parentElement) {
              const style = getComputedStyle(el);
              const zoom = style.zoom;
              if (style.transform !== "none" || (zoom !== "" && zoom !== "normal" && zoom !== "1")) {
                scaled = `${String(el.className).slice(0, 40)} transform=${style.transform} zoom=${zoom}`.slice(0, 120);
                break;
              }
            }
            beacon("body-view", {
              dpr: window.devicePixelRatio || 1,
              pane: frame === null ? "-" : `${frame.clientWidth}x${frame.clientHeight}`,
              pageCssW: Math.round(cssWidth),
              canvasW: canvas.width,
              pxPerCss: cssWidth > 0 ? Math.round((canvas.width / cssWidth) * 100) / 100 : 0,
              pagePixels: `${canvas.width}x${canvas.height}`,
              // The toolbar prints the live zoom; the page remembers the scale
              // its bitmap was rasterised at.
              fitZoom: (document.querySelector(".fp-zoom-count")?.textContent ?? "-").slice(0, 12),
              renderedAt: String(pageEl?.dataset.renderedZoom ?? "-").slice(0, 60),
              chromeFont: chrome === null ? "-" : `${chrome.fontFamily} ${chrome.fontSize}/${chrome.fontWeight}`.slice(0, 120),
              bodyFont: String(getComputedStyle(document.body).fontFamily).slice(0, 100),
              docZoom: getComputedStyle(document.documentElement).zoom,
              // What the pane's text is actually drawn with, and whether the
              // shell's grayscale antialiasing still reaches in here.
              smoothing: `${getComputedStyle(document.body).webkitFontSmoothing ?? "-"} / ${getComputedStyle(document.querySelector(".fp-root") ?? document.body).webkitFontSmoothing ?? "-"}`.slice(0, 40),
              hasInter: document.fonts === undefined ? null : document.fonts.check('12px Inter'),
              hasSegoeUi: document.fonts === undefined ? null : document.fonts.check('12px "Segoe UI"'),
              hasYaHei: document.fonts === undefined ? null : document.fonts.check('12px "Microsoft YaHei"'),
              visualScale: window.visualViewport === undefined ? null : window.visualViewport.scale,
              scaledAncestor: scaled,
            });
          } catch {
            // A probe must never be the reason a pane breaks.
          }
        };
        const look = () => {
          const canvas = document.querySelector(".fp-frame canvas");
          // A `<canvas>` is 300×150 before anything is drawn on it, so "a canvas
          // exists, and has a width" is not the signal. The page box carries
          // `renderedZoom` only once a bitmap has been rasterised at that scale;
          // without this the probe fired on its first tick and reported the
          // placeholder size, which reads as "the page never painted".
          const page = canvas === null ? null : canvas.closest(".page");
          if (page?.dataset.renderedZoom !== undefined && canvas.width > 0) {
            report(canvas);
            return;
          }
          tries += 1;
          if (tries > 24) return;
          timer = setTimeout(look, 250);
        };
        timer = setTimeout(look, 200);
        return () => clearTimeout(timer);
      }, []);

      const updateZoomPreview = React.useCallback((previewScale) => {
        const current = viewerRef.current;
        const scale = typeof previewScale === "number" && Number.isFinite(previewScale)
          ? previewScale / 100
          : current?.zoom;
        if (!Number.isFinite(scale)) return;
        setView((previous) => Math.abs(scale - previous.scale) < 0.001
          ? previous
          : { ...previous, scale });
      }, []);

      const sync = React.useCallback(() => {
        const viewer = viewerRef.current;
        if (viewer === null) return;
        setView((previous) => {
          const next = {
            page: viewer.currentPage ?? previous.page,
            total: viewer.pageCount ?? previous.total,
            scale: viewer.pinch?.target ?? viewer.zoom ?? previous.scale,
            mode: viewer.zoomMode ?? previous.mode,
            back: viewer.history?.canBack?.() === true,
            forward: viewer.history?.canForward?.() === true,
          };
          return next.page === previous.page &&
            next.total === previous.total &&
            Math.abs(next.scale - previous.scale) < 0.001 &&
            next.mode === previous.mode &&
            next.back === previous.back &&
            next.forward === previous.forward
            ? previous
            : next;
        });
        // The outline follows the viewport: the entry the reading point is under
        // is the chapter the reader is in.
        const rows = outlineRef.current;
        const searcher = helperRef.current["outline-active.mjs"];
        if (rows === null || rows === undefined || searcher === undefined) return;
        // …except for the entry the reader has just clicked. A PDF destination
        // usually names a page and no vertical offset, so a jump to 2.2.1 puts
        // the reading point at the *top of its page* — above the heading — and
        // the rule below answers 2.1.2, the chapter the reader has just left
        // (measured: clicked `2.2.1 Subsection 1`, `aria-current` on
        // `2.1.2 Subsection 2`). The click stands until the page changes.
        //
        // A page of -1 means "the jump is still in flight": the landing page is
        // not known yet, so a sync in between must not take the entry back.
        const held = outlineHold.current;
        if (held.id !== "" && (held.page === -1 || held.page === (viewer.currentPage ?? 0))) {
          setChapter(held.id);
          return;
        }
        outlineHold.current = { id: "", page: 0 };
        const reading = viewer.getReadingPoint?.();
        const active = reading === undefined ? null : searcher.pickOutlineActive(rows, reading);
        setChapter(active === null || active === undefined ? "" : String(active.id ?? ""));
      }, []);

      /** Fold or unfold one outline node. */
      const foldNode = (id) => {
        setFolded((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      /** Fold every chapter away, or bring the whole tree back. */
      const foldAll = (hide) => {
        const rows = outlineRef.current ?? [];
        setFolded(hide
          ? new Set(rows.filter((row) => row.children > 0).map((row) => row.id))
          : new Set());
      };

      /**
       * Search the pages indexed so far and optionally jump to one hit.
       * @param text - query.
       * @param index - hit to select.
       * @param jump - whether to scroll to that hit.
       */
      const runFind = React.useCallback(async (text, index = 0, jump = true) => {
        const viewer = viewerRef.current;
        if (viewer === null) return;
        const query = text.trim();
        const { matchCase, wholeWord } = findRef.current;
        if (query === "") {
          setFind((previous) => ({ ...previous, query: "", hits: [], index: -1, busy: false, indexing: false }));
          await viewer.showHits([], "", 0, { jump: false });
          return;
        }
        const module = await loadViewer();
        setFind((previous) => ({ ...previous, query, busy: true }));
        let pages = viewer.pageTexts ?? [];
        if (pages.length === 0 && viewer.indexPromise) {
          try {
            pages = await viewer.indexPromise;
          } catch {
            pages = viewer.pageTexts ?? [];
          }
        }
        if (viewerRef.current !== viewer) return;
        const hits = module.searchDocument(pages, query, { matchCase, wholeWord });
        const selected = hits.length === 0 ? -1 : Math.min(Math.max(0, index), hits.length - 1);
        // The background index is still growing, so an empty result is not a
        // verdict yet: keep the bar in its 「正在建立索引…」 state until the last
        // page is in. Measured without this: the bar said 「没有找到」 about a word
        // with 11 hits in it, then corrected itself a second later.
        setFind({ ...findRef.current, query, hits, index: selected, busy: false, ...indexState(viewer) });
        await viewer.showHits(hits, query, Math.max(0, selected), { jump });
      }, []);

      /** Capture page, zoom and scroll of the mounted viewer. */
      const savePlace = React.useCallback(() => {
        const current = viewerRef.current;
        if (current === null) return;
        try {
          // A passive effect cleanup runs after React has already detached the
          // nodes, and a detached scroller reports `scrollTop` 0 — so past that
          // point the last state the viewer announced is the only honest one.
          // React nulls the ref before this cleanup runs, so a missing ref means
          // the nodes are already gone — not that they are still there.
          const frame2 = frameRef.current;
          const detached = frame2 === null || !frame2.isConnected;
          const state = (detached ? lastState.current : current.getState()) ?? current.getState();
          if (state === null) return;
          const { page, zoom, scrollTop, scrollLeft } = state;
          // The anchor names text on a rendered page; it is meaningless once the
          // renderer is gone, so the plain offsets are what gets kept.
          // Keyed by the document as well as the tab: the place names pages and
          // offsets *of one file*, and switching to another document used to
          // resume at the previous file's page — a 4-page file opened on its
          // second page at 150%, inherited from a 200-page one.
          rememberPlace(`${tabIdRef.current}|${viewerAddress.current}`, { page, zoom, scrollTop, scrollLeft });
        } catch {
          /* a viewer that failed to open has no place to remember */
        }
      }, []);

      /**
       * Is the background text index still growing?
       *
       * `pageTexts` only ever holds the pages indexed so far, so a zero-hit
       * answer over a short index is not an answer — the viewer keeps the
       * cursor, and an index that gave up is a different state from one that is
       * still walking, so a permanent 「正在建立索引…」 is not an option either.
       */
      const stillIndexing = (target) => (target.indexError ?? null) === null
        && (target.indexedPages ?? 0) < (target.pageCount ?? 0);

      /**
       * The three numbers the find bar needs to stop lying about its own state.
       *
       * `indexing` was in the state from the start and set nowhere, so the bar's
       * "building index" branch was dead and a count over a half-built index read
       * like a final answer. Every `setFind` below carries all three now.
       */
      const indexState = (target) => ({
        indexing: stillIndexing(target),
        indexed: Number(target?.indexedPages ?? 0),
        pages: Number(target?.pageCount ?? 0),
      });

      /** Re-run the current query over a freshly grown index, without jumping. */
      const refreshFind = React.useCallback(async () => {
        const viewer = viewerRef.current;
        const { query, index, matchCase, wholeWord } = findRef.current;
        if (viewer === null || query === "") return;
        const pages = viewer.pageTexts ?? [];
        if (pages.length === 0) return;
        const module = await loadViewer();
        const hits = module.searchDocument(pages, query, { matchCase, wholeWord });
        const selected = hits.length === 0 ? -1 : Math.min(Math.max(0, index), hits.length - 1);
        // Same question as in `runFind`: ask the renderer, rather than inheriting
        // the `busy` of a call that searched a shorter index.
        setFind({ ...findRef.current, query, hits, index: selected, busy: false, ...indexState(viewer) });
        await viewer.showHits(hits, query, Math.max(0, selected), { jump: false });
      }, []);

      /**
       * What a floating bubble needs to know, recorded when the selection is made.
       *
       * The bubble is absolutely positioned inside `.fp-root`, so everything is
       * kept in that box's coordinates: the anchor is the *end* of the selection
       * (see `selection-anchor.mjs` — a multi-line selection's union rect is
       * useless for this), and `view` is the box itself, because the placement
       * rules keep needing its edges long after this call is over.
       *
       * @param range - the selected range.
       * @param selection - the live selection; its focus end is the anchor.
       */
      const anchorOf = React.useCallback((range, selection, point = null) => {
        const root = rootRef.current;
        if (root === null) return null;
        const box = root.getBoundingClientRect();
        const view = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        // The bubble floats over the *scrollport*, which is the frame, not the
        // whole pane: clamping a card's top to the root's edge let it lie on top
        // of the toolbar — measured 118,9,300,704 against a toolbar box of
        // 1,1,460,37 — where every button in the toolbar stopped answering the
        // pointer (`elementFromPoint` answered the card's own title).
        const frameBox = (frameRef.current ?? root).getBoundingClientRect();
        const viewport = {
          left: frameBox.left,
          top: frameBox.top,
          right: frameBox.right,
          bottom: frameBox.bottom,
        };
        const anchorModule = helperRef.current["selection-anchor.mjs"];
        // The anchor helper filters candidate lines against a viewport in screen
        // coordinates, so it gets the frame; the placement rules below want the
        // same box expressed inside the pane.
        const measured = (anchorModule === undefined
          ? null
          : anchorModule.getSelectionAnchorRect(range, viewport, selection)) ?? range.getBoundingClientRect();
        // A range over a page that was redrawn under the reader's hand comes back
        // with no rects at all (measured: `getClientRects()` empty and a 0x0
        // union, while the range still held its characters). The pointer is
        // where the reader's own bubble would go, so it anchors the pill instead
        // of dropping it — the whole gesture would otherwise end in nothing.
        const anchor = measured.width > 0 || measured.height > 0
          ? measured
          : (point === null ? measured : { left: point.x, top: point.y, right: point.x, bottom: point.y, width: 1, height: 1 });
        if (!(anchor.width > 0 || anchor.height > 0)) return null;
        return {
          anchor: {
            left: anchor.left - box.left,
            top: anchor.top - box.top,
            right: anchor.right - box.left,
            bottom: anchor.bottom - box.top,
          },
          view: {
            left: frameBox.left - box.left,
            top: frameBox.top - box.top,
            right: frameBox.right - box.left,
            bottom: frameBox.bottom - box.top,
          },
        };
      }, []);

      /**
       * Where the pill or the card goes, from the recorded anchor and the box.
       *
       * Recomputed on render rather than frozen at selection time: the card's own
       * height is what decides above or below, and that is only known once it has
       * drawn once. `maxWidth` is the element's own preferred width — the rules
       * need it to clamp horizontally, and a pill clamped as if it were as wide as
       * a card would slide to the far edge.
       */
      const placeBubble = (held, height, maxWidth) => {
        if (held?.anchor === undefined || held?.view === undefined) return null;
        const placement = helperRef.current["bubble-placement.mjs"];
        if (placement === undefined) {
          // Without the rules: under the anchor, pulled inside the pane by hand.
          const width = Math.min(maxWidth, held.view.right - 12);
          return {
            left: Math.max(6, Math.min(held.anchor.left, held.view.right - width - 8)),
            width,
            top: Math.min(held.anchor.bottom + 6, held.view.bottom - 44),
            maxHeight: Math.max(72, held.view.bottom - held.anchor.bottom - 16),
          };
        }
        const width = Math.min(maxWidth, placement.maxBubbleWidthForViewport(held.view, { absoluteMax: maxWidth }));
        const placed = placement.computeBubblePlacement(held.anchor, held.view, width, height);
        return { left: placed.left, width, top: placed.top, maxHeight: placed.maxHeight };
      };

      /**
       * Ask the host half to translate a selection.
       *
       * `from` is the pill the reader pressed; without it this is the card's
       * 重试 button, retrying the selection that failed there. Either way the
       * card is what appears — the pill only ever offers the request.
       */
      const translate = React.useCallback(async (from) => {
        const current = from ?? pickRef.current;
        if (current === null || current === undefined) return;
        if (from === undefined && current.status !== "error") return;
        setChip(null);
        // Pressing the pill while a card is open reuses that card. It replaces
        // its *content* — pinning it and dragging it are decisions about the
        // card, and the pill's own anchor has no opinion about either. Taking
        // the pill's state wholesale (what this did) dropped `pinned` and moved
        // the card to the new selection, so 「原地填成新内容」 was never true for a
        // pinned card: measured 110,136,300,122 → 106,641,300,72 with the pin
        // unpressed.
        const heldCard = from === undefined ? undefined : pickRef.current;
        const carried = heldCard?.pinned === true
          ? {
            pinned: true,
            moved: heldCard.moved,
            anchor: heldCard.anchor,
            view: heldCard.view,
            cardHeight: heldCard.cardHeight,
          }
          : null;
        const controller = new AbortController();
        // The card's 停止 button aborts this. The timeout is the fallback for a
        // call that never answers at all.
        pickAbort.current = controller;
        // The answer belongs to *this* call, not to whatever text the card happens
        // to show: closing a busy card and asking again for the same passage sends a
        // second request, and comparing the text let the older one land last —
        // measured 第二次请求的译文 → 第一次请求的译文, and an abandoned call's 60 s
        // timeout turned a finished card back into 「翻译等太久了」.
        setPick({ ...current, ...carried, status: "busy", message: "", copied: false, request: controller });
        const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
        try {
          const response = await fetch(assetUrl("translate", document.baseURI), {
            method: "POST",
            // A simple request: no CORS preflight in either transport.
            headers: {
              "content-type": "text/plain;charset=UTF-8",
              // The host route refuses requests without this header, which is what
              // keeps other pages in the browser from spending the model quota.
              "x-dsh-fast-pdf": "translate",
            },
            body: JSON.stringify({ text: current.text, sessionId: sessionRef.current, stream: true, targetLanguage: preferencesRef.current.translationLanguage }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // The route answers line-by-line while the model talks; without a
          // streamable body (an older Host, a proxy that buffered it away) the
          // whole answer still arrives as one JSON object.
          const streamed = String(response.headers.get("content-type") ?? "").includes("ndjson");
          const reader = streamed ? response.body?.getReader?.() : undefined;
          if (reader !== undefined && reader !== null) {
            const decoder = new TextDecoder();
            let buffer = "";
            let grown = "";
            let final = null;
            for (;;) {
              const step = await reader.read();
              if (step.done) break;
              buffer += decoder.decode(step.value, { stream: true });
              let edge = buffer.indexOf("\n");
              while (edge >= 0) {
                const line = buffer.slice(0, edge).trim();
                buffer = buffer.slice(edge + 1);
                edge = buffer.indexOf("\n");
                if (line === "") continue;
                let event = null;
                try {
                  event = JSON.parse(line);
                } catch {
                  continue;
                }
                if (typeof event?.delta === "string") {
                  grown += event.delta;
                  // One paint per chunk is what makes it look like typing; the
                  // text is captured so a stopped call keeps what it had.
                  setPick((held) => held !== null && held.request === controller
                    ? { ...held, status: "busy", partial: grown }
                    : held);
                } else if (typeof event?.ok === "boolean") {
                  final = event;
                }
              }
            }
            setPick((held) => held !== null && held.request === controller
              ? (final === null
                ? { ...held, status: "error", message: String(held.partial ?? "").trim() === "" ? "翻译失败" : "", partial: "" }
                : final.ok === true
                  ? { ...held, status: "done", result: final, partial: "" }
                  : { ...held, status: "error", message: String(final.message ?? "翻译失败"), partial: "" })
              : held);
            return;
          }
          const data = await response.json();
          setPick((held) => held !== null && held.request === controller
            ? (data?.ok === true
              ? { ...held, status: "done", result: data }
              : { ...held, status: "error", message: String(data?.message ?? "翻译失败") })
            : held);
        } catch (error) {
          const message = error?.name === "AbortError"
            ? copy.current("translateTimeout")
            : String(error?.message ?? error);
          // A card the reader already stopped or closed is not updated.
          setPick((held) => held !== null && held.request === controller
            ? { ...held, status: "error", message }
            : held);
        } finally {
          clearTimeout(timer);
          if (pickAbort.current === controller) pickAbort.current = null;
        }
      }, []);

      /** Stop the call in flight and put the card away. */
      const stopTranslate = React.useCallback(() => {
        pickAbort.current?.abort();
        pickAbort.current = null;
        setPick(null);
      }, []);

      /** Close the properties sheet and invalidate any metadata request. */
      const closeSheet = React.useCallback(() => {
        sheetRequestRef.current += 1;
        sheetRef.current = null;
        setSheet(null);
      }, []);

      /** Open (or close) the document-properties card. */
      const toggleSheet = React.useCallback(async () => {
        if (sheetRef.current !== null) {
          closeSheet();
          return;
        }
        const current = viewerRef.current;
        if (current === null) return;
        const request = ++sheetRequestRef.current;
        let module;
        try {
          module = await loadHelper("document-properties.mjs");
        } catch (error) {
          console.error("PDF document properties helper failed", error);
          return;
        }
        if (request !== sheetRequestRef.current || viewerRef.current !== current) return;
        const locale = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
        const firstPage = current.pageLayout(1);
        const basicSnapshot = {
          fileName: current.name,
          fileSize: current.sourceBytes,
          location: current.sourceLocation,
          pageCount: current.pageCount,
          pageWidth: firstPage.width,
          pageHeight: firstPage.height,
          info: {},
        };
        const basicRows = module.buildDocumentPropertyRows(basicSnapshot, copy.current, locale);
        sheetRef.current = basicRows;
        setSheet(basicRows);

        // Metadata can require parsing the document's catalog and take long
        // enough to make the menu feel inert. Show the useful basic rows first,
        // then enrich them when pdf.js returns. A failure leaves the basic card
        // open and must not become an unhandled rejection.
        try {
          const snapshot = await current.getDocumentInfo();
          if (snapshot === null || request !== sheetRequestRef.current || viewerRef.current !== current) return;
          const rows = module.buildDocumentPropertyRows(snapshot, copy.current, locale);
          sheetRef.current = rows;
          setSheet(rows);
        } catch {
          // Basic document properties remain available without metadata.
        }
      }, [closeSheet]);

      const loadPreferences = React.useCallback(async () => {
        const module = helperRef.current["preferences.mjs"] ?? await loadHelper("preferences.mjs");
        helperRef.current["preferences.mjs"] = module;
        const next = module.readPreferences();
        // Only the first read may adopt the stored value. Every later read
        // (opening settings again, re-attaching a cached document) must not
        // overwrite a choice the reader made in this component: the write may
        // still be in flight, and a stale read would roll the UI — and the
        // next translation's targetLanguage — back to the stored snapshot.
        if (!preferencesLoadedRef.current) {
          preferencesLoadedRef.current = true;
          preferencesRef.current = next;
          setPreferences(next);
        }
        return { module, preferences: preferencesRef.current };
      }, []);

      const closeSettings = React.useCallback(() => {
        setSettingsOpen(false);
        requestAnimationFrame(() => moreRef.current?.querySelector("button")?.focus());
      }, []);

      const openSettings = React.useCallback(async () => {
        setMenu(false);
        try {
          await loadPreferences();
          setSettingsOpen(true);
        } catch (error) {
          console.error("PDF preferences helper failed", error);
        }
      }, [loadPreferences]);

      const updatePreference = React.useCallback(async (key, value) => {
        try {
          const module = helperRef.current["preferences.mjs"] ?? await loadHelper("preferences.mjs");
          helperRef.current["preferences.mjs"] = module;
          const next = module.writePreferences({ ...preferencesRef.current, [key]: value });
          // A write is at least as fresh as any pending read, so no later
          // `loadPreferences()` may adopt the stored snapshot over it.
          preferencesLoadedRef.current = true;
          preferencesRef.current = next;
          setPreferences(next);
          if (key === "pageGap") {
            viewerRef.current?.setPageGap?.(next.pageGap);
            sync();
          }
        } catch (error) {
          console.error("PDF preferences could not be saved", error);
        }
      }, [sync]);

      React.useEffect(() => {
        if (!settingsOpen) return;
        rootRef.current?.querySelector(".fp-settings-language")?.focus();
      }, [settingsOpen]);

      /**
       * Drag the translation card by its head.
       *
       * The card sits absolutely inside `.fp-root`, so a drag is just an offset
       * in those coordinates, clamped to the pane. Nothing is written down: the
       * next selection starts from where that selection was.
       */
      const beginDrag = React.useCallback((event) => {
        if (event.button !== 0) return;
        // A press that lands on one of the head's own buttons belongs to it.
        if (event.target instanceof Element && event.target.closest("button") !== null) return;
        const root = rootRef.current;
        const start = pickRef.current;
        if (root === null || start === null) return;
        pickDragCleanupRef.current?.();
        event.preventDefault();
        const pointerId = event.pointerId;
        const captureElement = event.currentTarget;
        try { captureElement.setPointerCapture?.(pointerId); } catch { /* fallback to window listeners */ }
        const fromX = event.clientX;
        const fromY = event.clientY;
        // Where the card actually is right now, read off the element: after the
        // first drag it is `moved`, before that it is wherever the placement put
        // it, and the box knows both without repeating that arithmetic here.
        const card = event.currentTarget.closest(".fp-pick");
        const cardBox = card?.getBoundingClientRect();
        const rootBox = root.getBoundingClientRect();
        const originLeft = cardBox === undefined ? 0 : cardBox.left - rootBox.left;
        const originTop = cardBox === undefined ? 0 : cardBox.top - rootBox.top;
        const width = root.offsetWidth;
        const height = root.offsetHeight;
        // Clamp against the card's own box, not a guess: the reader can resize
        // it (`resize: both`), and a card half outside the pane is a card lost.
        const cardWidth = card?.offsetWidth ?? CARD_WIDTH;
        const cardHeight = card?.offsetHeight ?? 0;
        const maxLeft = Math.max(4, width - cardWidth - 4);
        const maxTop = Math.max(4, height - cardHeight - 4);
        const position = { card, pick: start, left: originLeft, top: originTop, active: true, frame: 0 };
        pickDragPositionRef.current = position;
        let dragging = false;
        let latestX = fromX;
        let latestY = fromY;
        const preventSelection = (selectionEvent) => selectionEvent.preventDefault();
        const applyPosition = () => {
          position.left = Math.max(4, Math.min(originLeft + latestX - fromX, maxLeft));
          position.top = Math.max(4, Math.min(originTop + latestY - fromY, maxTop));
          position.pendingLeft = undefined;
          position.pendingTop = undefined;
          card.style.left = `${position.left}px`;
          card.style.top = `${position.top}px`;
        };
        const move = (moveEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          const dx = moveEvent.clientX - fromX;
          const dy = moveEvent.clientY - fromY;
          // Under a couple of pixels is a click on the head, not a drag.
          if (!dragging && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          if (!dragging) {
            dragging = true;
            root.setAttribute("data-dragging", "");
            root.addEventListener("selectstart", preventSelection);
          }
          moveEvent.preventDefault();
          latestX = moveEvent.clientX;
          latestY = moveEvent.clientY;
          position.pendingLeft = Math.max(4, Math.min(originLeft + dx, maxLeft));
          position.pendingTop = Math.max(4, Math.min(originTop + dy, maxTop));
          if (!position.frame) {
            position.frame = requestAnimationFrame(() => {
              position.frame = 0;
              applyPosition();
            });
          }
        };
        const end = (endEvent = null, commit = true) => {
          if (Number.isFinite(endEvent?.pointerId) && endEvent.pointerId !== pointerId) return;
          if (position.frame) cancelAnimationFrame(position.frame);
          position.frame = 0;
          if (dragging) {
            applyPosition();
            position.active = false;
            if (commit) setPick((held) => (held === null ? held : { ...held, moved: { left: position.left, top: position.top } }));
            else if (pickDragPositionRef.current === position) pickDragPositionRef.current = null;
          } else {
            position.active = false;
            if (pickDragPositionRef.current === position) pickDragPositionRef.current = null;
          }
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          window.removeEventListener("blur", end);
          captureElement.removeEventListener?.("lostpointercapture", end);
          root.removeEventListener("selectstart", preventSelection);
          root.removeAttribute("data-dragging");
          if (pickDragCleanupRef.current === cleanup) pickDragCleanupRef.current = null;
          try {
            if (captureElement.hasPointerCapture?.(pointerId)) captureElement.releasePointerCapture?.(pointerId);
          } catch { /* the pointer may already have been released by the browser */ }
        };
        const cleanup = () => end(null, false);
        pickDragCleanupRef.current = cleanup;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        window.addEventListener("blur", end);
        captureElement.addEventListener?.("lostpointercapture", end);
      }, []);

      React.useEffect(() => () => pickDragCleanupRef.current?.(), []);

      /**
       * How big the card is allowed to get.
       *
       * The native `resize: both` corner had no bounds at all: the card could be
       * dragged to a 12×9 sliver or to five times the pane, and once it was
       * bigger than the pane its own close button was outside the frame
       * (measured: 300×122 card → 1180×760 in a 495×720 pane). The extension
       * answers this with `bubbleSizeLimits`, so the numbers here are its shape:
       * a floor wide enough for a sentence, a ceiling inside the viewport, and a
       * height cap at most the pane tall.
       */
      const cardLimits = () => {
        const box = rootRef.current?.getBoundingClientRect();
        const width = box?.width ?? CARD_WIDTH;
        const height = box?.height ?? CARD_TALL * 2;
        const room = Math.max(120, width - 16);
        return {
          minWidth: Math.min(220, room),
          maxWidth: Math.min(560, room),
          minHeight: Math.min(120, Math.max(72, height - 16)),
          maxHeight: Math.max(120, Math.round(height * 0.85)),
        };
      };

      /** Which edges of a box this pointer is on, or `null` for the middle. */
      const edgesAt = (event, box) => {
        const band = 9;
        const x = event.clientX;
        const y = event.clientY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (x < box.left - band || x > box.right + band) return null;
        if (y < box.top - band || y > box.bottom + band) return null;
        if (x > box.left + band && x < box.right - band && y > box.top + band && y < box.bottom - band) return null;
        const left = x <= box.left + band;
        const right = x >= box.right - band;
        const top = y <= box.top + band;
        const bottom = y >= box.bottom - band;
        if (!left && !right && !top && !bottom) return null;
        return { left, right, top, bottom };
      };

      /** The arrow that edge pair wears — the same eight the extension has. */
      const resizeCursor = (edges) => {
        if (edges === null) return "";
        if ((edges.left && edges.top) || (edges.right && edges.bottom)) return "nwse-resize";
        if ((edges.right && edges.top) || (edges.left && edges.bottom)) return "nesw-resize";
        if (edges.left || edges.right) return "ew-resize";
        return "ns-resize";
      };

      /**
       * Drag one of the card's edges.
       *
       * Runs in the capture phase on the card, so an edge press resizes instead
       * of starting the head's drag underneath it, and the cursor is pushed onto
       * `.fp-root` for as long as the press lasts — a pointer that outruns the
       * card keeps saying "resizing" instead of falling back to a text cursor.
       */
      const beginResize = React.useCallback((event) => {
        if (event.button !== 0) return;
        const root = rootRef.current;
        const card = cardRef.current;
        if (root === null || card === null || card === undefined) return;
        const box = card.getBoundingClientRect();
        const edges = edgesAt(event, box);
        if (edges === null) return;
        event.preventDefault();
        event.stopPropagation();
        const rootBox = root.getBoundingClientRect();
        const start = {
          width: box.width,
          height: box.height,
          left: box.left - rootBox.left,
          top: box.top - rootBox.top,
        };
        const fromX = event.clientX;
        const fromY = event.clientY;
        // A card shorter than the floor may not be made *taller* by the first
        // drag towards the top-left: shrinking is what the edge is for.
        const limits = cardLimits();
        limits.minHeight = Math.min(limits.minHeight, Math.round(start.height));
        const cursor = resizeCursor(edges);
        card.setAttribute("data-edge", "");
        card.style.cursor = cursor;
        root.setAttribute("data-resizing", "");
        root.style.setProperty("--fp-edge-cursor", cursor);
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - fromX;
          const dy = moveEvent.clientY - fromY;
          let width = start.width;
          let height = start.height;
          let left = start.left;
          let top = start.top;
          if (edges.right) {
            width = Math.max(limits.minWidth, Math.min(limits.maxWidth, start.width + dx));
          }
          if (edges.left) {
            width = Math.max(limits.minWidth, Math.min(limits.maxWidth, start.width - dx));
            left = start.left + (start.width - width);
          }
          if (edges.bottom) {
            height = Math.max(limits.minHeight, Math.min(limits.maxHeight, start.height + dy));
          }
          if (edges.top) {
            height = Math.max(limits.minHeight, Math.min(limits.maxHeight, start.height - dy));
            top = start.top + (start.height - height);
          }
          // A resized card is still a card in this pane: never past its edges.
          left = Math.max(0, Math.min(left, Math.max(0, rootBox.width - width)));
          top = Math.max(0, Math.min(top, Math.max(0, rootBox.height - height)));
          setCardSize({ width: Math.round(width), height: Math.round(height) });
          setPick((held) => (held === null ? held : {
            ...held,
            moved: { left: Math.round(left), top: Math.round(top) },
          }));
        };
        const end = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", end);
          window.removeEventListener("pointercancel", end);
          card.removeAttribute("data-edge");
          card.style.cursor = "";
          root.removeAttribute("data-resizing");
          root.style.removeProperty("--fp-edge-cursor");
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
      }, []);

      /** Paint the resize cursor while the pointer is merely near an edge. */
      const hoverResize = (event) => {
        const card = cardRef.current;
        const root = rootRef.current;
        if (card === null || card === undefined) return;
        // Only an *active* resize owns the cursor. Keying this off `data-edge`
        // instead froze the arrow at whatever edge was touched first: the pointer
        // moved from the right edge to the corner and the cursor stayed
        // `ew-resize` (measured), because the stale mark said "already handled".
        if (root?.hasAttribute("data-resizing") === true) return;
        const edges = edgesAt(event, card.getBoundingClientRect());
        card.style.cursor = resizeCursor(edges);
        if (edges === null) card.removeAttribute("data-edge");
        else card.setAttribute("data-edge", "");
      };

      React.useEffect(() => {
        const frame = frameRef.current;
        if (frame === null) return undefined;
        /** Show the translate affordance next to a fresh selection. */
        const onSelect = (attempt = 0, point = null) => {
          // Looked up on every selection: switching documents swaps the page
          // container, and a captured one would reject every selection in the
          // document that came after it.
          const pages = pagesRef.current;
          if (pages === null) return;
          const selection = window.getSelection();
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          // When the anchor is missing, the page was still being laid out under
          // the reader's hand: the text layer is emptied and rebuilt at the end
          // of a zoom or a resize, and a range that pointed into it comes back
          // blank. One short retry picks the selection up if it survived; a
          // rebuild that took it with it gets nothing, and the next drag asks
          // again.
          const again = () => {
            if (attempt >= 3) return;
            clearTimeout(selectionRetry.current);
            selectionRetry.current = setTimeout(() => onSelect(attempt + 1, point), 120);
          };
          if (!pages.contains(range.commonAncestorContainer)) {
            again();
            return;
          }
          const module = helperRef.current["selection-text.mjs"];
          // Until the selection module is in, the plain string is enough to
          // decide whether this was a drag at all.
          // An engine may refuse to spell out a selection it considers
          // unselectable even though the range holds characters — measured in
          // headless Edge, where the range around "Cover" stringified fine while
          // `getSelection().toString()` came back empty and no pill appeared for
          // any selection. The range is the source of truth; the selection is
          // only the convenient way to ask.
          let prepared = module === undefined
            ? { text: selection.toString().trim(), mode: "passage", raw: selection.toString() }
            : module.prepareSelectionForTranslation(selection, SELECTION_LIMIT);
          if (prepared.text.length < 2 && !prepared.tooLong) {
            const rangeText = String(range.toString()).trim();
            if (rangeText.length >= 2) {
              prepared = {
                text: rangeText.slice(0, SELECTION_LIMIT),
                mode: "passage",
                raw: rangeText,
                tooLong: rangeText.length > SELECTION_LIMIT,
              };
            }
          }
          if (prepared.text.length < 2 && !prepared.tooLong) {
            again();
            return;
          }
          const anchored = anchorOf(range, selection, point);
          if (anchored === null) {
            again();
            return;
          }
          if (prepared.tooLong) {
            // Selecting a whole page and dragging the mouse is easy to do by
            // accident; saying so costs less than a request nobody wanted. The
            // message has to be read, so it opens the card it belongs in.
            setChip(null);
            setPick({
              text: "",
              mode: "passage",
              ...anchored,
              status: "error",
              message: String(copy.current("selectionTooLong")).replace("{count}", String(SELECTION_LIMIT)),
            });
            return;
          }
          // A pinned card stays exactly where it is — that is what pinning it
          // bought — but a longer read still goes on around it, and a new
          // selection still gets its own 翻译. The pill is offered as usual, and
          // pressing it fills that same card in place. Suppressing the pill
          // instead is how 「固定之后划词不再弹翻译」 happened.
          setChip({ text: prepared.text, mode: prepared.mode, ...anchored });
        };
        // A drag inside the page ends on mouseup, and the selection is read in
        // that same task: the text layer is emptied and rebuilt at the end of
        // the opening layout, and a range read one task later came back blank —
        // measured on a 4-page file, where the pill then never appeared at all.
        // The pointer's own position comes along as the fallback anchor, which
        // is what keeps the pill from being dropped when the page was redrawn
        // under the hand and its range came back without a single rect.
        const onUp = (event) => {
          const x = Number(event?.clientX);
          const y = Number(event?.clientY);
          const point = Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0) ? { x, y } : null;
          onSelect(0, point);
        };
        const onDown = (event) => {
          if (!(event.target instanceof Node) || !frame.contains(event.target)) return;
          // The pill is a prompt, not a fixture: a press on the page drops it,
          // along with the selection it was for. Clicking the pill itself never
          // reaches this listener.
          if (chipRef.current !== null) setChip(null);
          // A pinned card is there on purpose, so a click on the page is not a
          // dismissal either.
          if (pickRef.current !== null && pickRef.current.pinned !== true) setPick(null);
        };
        /**
         * Copy the selection as text, not as the page's own markup.
         *
         * Only the plain flavour is written and the browser's own copy is
         * cancelled, which is what drops the `text/html` half: inline styles, and
         * one line break per positioned span. A selection outside the page area —
         * the toolbar, the card — is left to the browser.
         */
        const onCopy = (event) => {
          const pages = pagesRef.current;
          if (pages === null) return;
          const selection = window.getSelection();
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
          if (!pages.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
          const module = helperRef.current["selection-text.mjs"];
          // Without its rules the browser's own copy is the honest answer.
          if (module === undefined) return;
          const text = selectionText(module, selection);
          if (text === "" || typeof event.clipboardData?.setData !== "function") return;
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
        };
        // The pill is anchored to a line, not to the pane: the moment the pages
        // slide under it the anchor is a lie — after 下一页 it stayed put while
        // the frame had scrolled 576 px past the words it pointed at. So a scroll
        // drops the *pill*. It does not drop the card: the reader asked for that
        // translation and scrolling is how they read the answer. The card goes
        // when the reader clicks somewhere else, which is the rule the extension
        // uses too (measured before: one wheel tick closed a 300×122 card and
        // took the answer with it).
        const onScroll = () => {
          if (chipRef.current !== null) setChip(null);
        };
        frame.addEventListener("mouseup", onUp);
        frame.addEventListener("keyup", onUp);
        frame.addEventListener("mousedown", onDown);
        frame.addEventListener("copy", onCopy);
        frame.addEventListener("scroll", onScroll, { passive: true });
        return () => {
          frame.removeEventListener("mouseup", onUp);
          frame.removeEventListener("keyup", onUp);
          frame.removeEventListener("mousedown", onDown);
          frame.removeEventListener("copy", onCopy);
          frame.removeEventListener("scroll", onScroll);
          clearTimeout(selectionRetry.current);
        };
      }, [anchorOf, sync]);

      // A handle from the Host means the file is ours to read.
      React.useEffect(() => {
        if (inlineBytes === undefined) return;
        setBytes(inlineBytes);
        setSourceAddress(String(props.resourceAddress ?? "inline"));
      }, [inlineBytes, props.resourceAddress]);

      const revision = rendererContent === undefined ? undefined : rendererContent.revision;
      React.useEffect(() => {
        if (rendererContent === undefined) return undefined;
        const read = props.readBytes;
        if (typeof read !== "function") {
          setFailure(copy.current("readUnavailable"));
          setStatus("failed");
          return undefined;
        }
        const address = String(props.resourceAddress ?? "");
        const controller = new AbortController();
        let done = false;
        // Already open in this page: there is nothing to read. The viewer (and
        // its bitmaps and text index) is waiting in the cache, so a switch back
        // is a re-attach rather than a reload. Asked *before* the loading paint:
        // a cached switch back was measured putting `.fp-loading` into the DOM
        // for a frame or two while the pane was ready the whole time.
        const parked = address === "" ? undefined : takeOpenDocument(address);
        if (parked !== undefined && parked.bytes !== undefined) {
          setFailure("");
          setProgress(null);
          setBytes(parked.bytes);
          setSourceAddress(address);
          bytesVersionRef.current = parked.version ?? 1;
          rendererContent.loaded?.(parked.version ?? 1);
          return undefined;
        }
        setStatus("loading");
        setFailure("");
        setProgress(null);
        loadingPhase.current = "download";
        read(props.resourceAddress, controller.signal, (ratio, counts) => {
          if (done) return;
          // The layout took over: a byte count that arrives now is the tail of
          // the read, and painting it would push the bar back to full.
          if (loadingPhase.current !== "download") return;
          const known = Number(counts?.total) || 0;
          const own = Math.max(0, Math.min(1, Number(ratio) || 0));
          const loaded = Number(counts?.loaded) || 0;
          setProgress((previous) => {
            if (previous?.phase === "prepare") return previous;
            const floor = Number(previous?.percent) || 0;
            // Same rule as the viewer own counts: bytes fill the bar up to 95,
            // the layout carries the rest, so it never has to walk backwards.
            const percent = known > 0 ? Math.min(95, Math.max(floor, own * 100)) : floor;
            return { loaded, total: known, ratio: known > 0 ? own : null, percent, phase: "download" };
          });
        })
          .then((result) => {
            if (done) return;
            done = true;
            // The byte count stays on screen until the layout reports its own:
            // clearing it here is what put an indeterminate "正在排版…" between a
            // full bar and the page count (measured: 100% → blank → 95% on a
            // 35 MB file).
            setBytes(result.bytes);
            setSourceAddress(address);
            bytesVersionRef.current = result.version ?? 1;
            beacon("body-bytes", { bytes: result.bytes.byteLength, version: result.version });
            // `hasContent` in the pane is `version !== undefined`, so a renderer
            // body that never reports one leaves the tab looking unfinished.
            // The value itself is not compared against anything the Host
            // measured — it stops measuring once the body reads for itself.
            rendererContent.loaded?.(result.version ?? 1);
          })
          .catch((error) => {
            if (done) return;
            done = true;
            setProgress(null);
            setFailure(
              error?.code === "too-large"
                ? `${copy.current("tooLarge")} · ${humanSize(Number(error.size ?? 0))}`
                : String(error?.message ?? error),
            );
            setStatus("failed");
          });
        return () => {
          done = true;
          controller.abort();
        };
      }, [revision, rendererContent === undefined, props.readBytes, props.resourceAddress]);

      React.useEffect(() => {
        const frame = frameRef.current;
        if (frame === null || bytes === undefined) return undefined;
        let disposed = false;
        let viewer = null;
        let resizeObserver = null;
        let detachWheel = () => {};
        let detachHistory = () => {};
        let detachScrollDiagnostics = () => {};
        let pages = null;
        /** The cache row this effect owns, once there is something worth keeping. */
        let entry = null;
        const address = sourceAddress;
        const attachScrollDiagnostics = async (target, module, listenerExists = false) => {
          const previousScroll = target.onScroll;
          if (listenerExists) frame.removeEventListener("scroll", previousScroll);
          detachScrollDiagnostics = module.attach(target, (data) => beacon("scroll-perf", data), { pauseRendering: false, canvasOnly: false });
          if (listenerExists) frame.addEventListener("scroll", target.onScroll, { passive: true });
        };

        /**
         * Put this viewer back in the cache for the next switch.
         *
         * The page container leaves the frame but keeps its bitmaps, and the
         * scroll listener comes off: two viewers listening to one scroller
         * would each take the other's scrolling for their own.
         */
        const park = () => {
          if (entry === null || address === "") return false;
          try {
            // Past detach the scroller reports 0, so the last state the viewer
            // announced is the honest one — `savePlace` makes the same call.
            entry.state = (frame.isConnected ? null : lastState.current)
              ?? viewer?.getState()
              ?? null;
          } catch {
            entry.state = null;
          }
          try {
            frame.removeEventListener("scroll", viewer.onScroll);
          } catch {
            /* ignore */
          }
          entry.bytes = bytes;
          entry.viewer = viewer;
          entry.pages = pages;
          if (pages !== null) pages.remove();
          pagesRef.current = null;
          viewerRef.current = null;
          rememberOpenDocument(address, entry);
          return true;
        };

        /**
         * The outline column, fetched once and kept with the document.
         *
         * `entry.rows` is written back so a re-attached document shows its
         * table of contents immediately instead of re-walking pdf.js for it.
         */
        const loadOutline = () => {
          if (viewer === null) return;
          const target = viewer;
          target
            .getOutline()
            .then((items) => {
              if (disposed) return;
              const rows = flattenOutline(items);
              if (rows.length === 0) {
                setOutline(null);
                return;
              }
              setOutline(rows);
              if (entry !== null) entry.rows = rows;
              // Where each chapter starts, for the highlight. One pass over the
              // tree once it is open; `sync()` reads the result from then on.
              void Promise.all(rows.map((row) => target.destPoint?.(row.dest) ?? null))
                .then((points) => {
                  if (disposed || viewerRef.current !== target) return;
                  const enriched = rows.map((row, at) => ({
                    ...row,
                    page: Number(points[at]?.page) || NaN,
                    pdfY: Number(points[at]?.pdfY),
                  }));
                  setOutline(enriched);
                  if (entry !== null) entry.rows = enriched;
                  sync();
                }, () => {});
            })
            .catch(() => setOutline(null));
        };

        /**
         * Page-width zoom follows the frame's own width, which changes when the
         * pane is resized, dragged, or the outline column opens. Shared, because
         * a re-attached document has to keep following it too.
         */
        const watchWidth = () => {
          let scheduled = 0;
          resizeObserver = new ResizeObserver(() => {
            if (scheduled !== 0) return;
            scheduled = requestAnimationFrame(() => {
              scheduled = 0;
              const current = viewerRef.current;
              if (current === null || disposed || current.pinch) return;
              if (current.zoomMode !== "page-width" && current.zoomMode !== "page-fit") return;
              current.setZoom(current.zoomMode, { silent: true });
              sync();
            });
          });
          resizeObserver.observe(frame);
        };

        /** Route modified wheel gestures through the viewer's compositor preview. */
        const watchWheel = (module) => {
          const onWheel = (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            const current = viewerRef.current;
            if (current === null) return;
            event.preventDefault();
            current.pinchZoom(event);
          };
          frame.addEventListener("wheel", onWheel, { passive: false });
          detachWheel = () => {
            frame.removeEventListener("wheel", onWheel);
            viewerRef.current?.cancelPinch();
          };
        };

        // This document is still open: re-attach it instead of rebuilding it.
        const parkedRow = address === "" ? undefined : takeOpenDocument(address);
        const parked = parkedRow !== undefined && parkedRow.bytes === bytes && parkedRow.pages !== undefined && parkedRow.moduleRevision === moduleRevision
          ? parkedRow
          : undefined;
        if (parkedRow !== undefined && parked === undefined) closeOpenDocument(address);
        if (parked !== undefined) {
          pages = parked.pages;
          frame.appendChild(pages);
          pagesRef.current = pages;
          viewer = parked.viewer;
          entry = parked;
          viewerAddress.current = String(parked.address ?? address);
          viewerRef.current = viewer;
          viewer.onZoomPreview = updateZoomPreview;
          viewer.onPinchCommit = sync;
          void loadPreferences().then(({ preferences: saved }) => {
            if (disposed || viewerRef.current !== viewer) return;
            viewer.setPageGap?.(saved.pageGap);
            sync();
          }, () => {});
          // A cached viewer outlives the component that originally opened it.
          // Route notifications to this mount rather than its detached refs.
          viewer.onState = (state) => {
            if (frame.isConnected) lastState.current = state;
            sync();
          };
          viewer.onScrollPosition = () => {
            if (frame.isConnected) lastState.current = viewer.getState();
            clearTimeout(placeTimer.current);
            placeTimer.current = setTimeout(savePlace, PLACE_DEBOUNCE_MS);
          };
          viewer.onIndex = () => {
            if (findRef.current.query === "") return;
            clearTimeout(findTimer.current);
            findTimer.current = setTimeout(() => void refreshFind(), FIND_DEBOUNCE_MS);
          };
          void loadViewer().then(async (module) => {
            if (disposed) return;
            beacon("runtime-viewer-build", {
              viewerBuild: module.PDF_VIEWER_BUILD ?? "unknown",
              ...module.runtimeDiagnostics?.(viewer, "reattach"),
            });
            try {
              const diagnostics = await loadHelper("scroll-diagnostics.mjs");
              if (!disposed) await attachScrollDiagnostics(viewer, diagnostics, true);
            } catch { /* diagnostic helper must not affect reading */ }
          });
          viewer.wrapEl = frame;
          viewer.pagesEl = pages;
          viewer.observe();
          frame.addEventListener("scroll", viewer.onScroll, { passive: true });
          // The pane may be a different width than the one it was parked at.
          viewer.setZoom(viewer.zoomMode, { silent: true });
          // Offsets, not the text anchor that `getState()` also carries: the
          // anchor names text on a rendered page, and a re-attached page is
          // rendering its text layer again. Restoring through a stale anchor
          // put the reader back on the first page (measured by a teammate:
          // left at page 2 / scroll 260, came back 1 / 324, three seconds
          // stable). `scrollToOffset` already retries while the page boxes are
          // still unsized, which is the failure mode this path actually has.
          const restored = parked.state ?? places.get(`${tabIdRef.current}|${address}`);
          if (restored !== null && restored !== undefined) {
            viewer.applyReadingPosition({
              page: restored.page,
              zoom: restored.zoom,
              scrollTop: restored.scrollTop,
              scrollLeft: restored.scrollLeft,
            });
          }
          setOutline(parked.rows ?? null);
          setStatus("ready");
          sync();
          watchWidth();
          void loadViewer().then((module) => {
            if (!disposed) watchWheel(module);
          });
          if (parked.rows === null || parked.rows === undefined) loadOutline();
          // The hits live in this viewer, so the bar carries on where the reader
          // left it instead of looking like the search never ran.
          if (findRef.current.query !== "") void runFind(findRef.current.query, 0, false);
          return () => {
            disposed = true;
            clearTimeout(findTimer.current);
            clearTimeout(placeTimer.current);
            savePlace();
            resizeObserver?.disconnect();
            detachWheel();
            detachHistory();
            if (!park()) {
              viewerRef.current = null;
              pagesRef.current = null;
              pages?.remove?.();
              try {
                viewer?.close();
              } catch {
                /* ignore */
              }
            }
            detachScrollDiagnostics();
          };
        }

        // Everything below builds a viewer from nothing.
        pages = document.createElement("div");
        pages.className = "fp-pages pdfViewer";
        frame.appendChild(pages);
        pagesRef.current = pages;
        setStatus("loading");
        setFailure("");
        setOutline(null);

        (async () => {
          const module = await loadViewer();
          if (disposed) return;
          let savedPreferences = preferencesRef.current;
          try {
            const loadedPreferences = await loadPreferences();
            savedPreferences = loadedPreferences.preferences;
          } catch {
            // Settings are optional; the built-in defaults keep opening available.
          }
          if (disposed) return;
          let diagnostics = null;
          try { diagnostics = await loadHelper("scroll-diagnostics.mjs"); } catch { /* optional diagnostics */ }
          if (disposed) return;
          // Outline jumps and search jumps both land in this history; it is what
          // gives the reader a way back out of one.
          const history = new module.ViewHistory();
          // `ViewHistory` exposes `onChange(fn)`, not `subscribe`. A destination
          // with a zoom change pushes to the history *after* `notify()` has
          // already run, so without this listener the back/forward buttons keep
          // their old disabled state until some later scroll or page turn.
          if (typeof history.onChange === "function") {
            detachHistory = history.onChange(() => sync());
          }
          viewer = new module.PdfViewer({
            pagesEl: pages,
            wrapEl: frame,
            history,
            onState: (state) => {
              // Only while the nodes are attached: a late notification during
              // unmount reads offsets of 0 and would erase the real ones.
              if (frame.isConnected) lastState.current = state;
              sync();
            },
            onScrollPosition: () => {
              // Read the offsets while the nodes are still attached: this is the
              // only moment they are still readable for the unmount path below.
              if (frame.isConnected && viewer !== null) lastState.current = viewer.getState();
              clearTimeout(placeTimer.current);
              placeTimer.current = setTimeout(savePlace, PLACE_DEBOUNCE_MS);
            },
            onZoomPreview: updateZoomPreview,
            onPinchCommit: sync,
            // The background index reports progress; a live query catches up
            // with it instead of waiting for the last page.
            onIndex: () => {
              if (findRef.current.query === "") return;
              clearTimeout(findTimer.current);
              findTimer.current = setTimeout(() => void refreshFind(), FIND_DEBOUNCE_MS);
            },
            // A protected document is a prompt, not a failure. pdf.js calls
            // this again with reason 2 when the previous answer was wrong.
            onPassword: (reason) =>
              new Promise((resolve, reject) => {
                passwordRef.current = { resolve, reject };
                setPassword({ draft: "", wrong: reason === 2 });
              }),
          });
          viewerRef.current = viewer;
          viewer.setPageGap?.(savedPreferences.pageGap);
          if (diagnostics !== null) {
            await attachScrollDiagnostics(viewer, diagnostics);
          }
          beacon("runtime-viewer-build", {
            viewerBuild: module.PDF_VIEWER_BUILD ?? "unknown",
            ...module.runtimeDiagnostics?.(viewer, "before-open"),
          });
          // Every step the viewer can count goes to the bar: laying out the
          // pages becomes a 0-100 countdown instead of an indeterminate swipe.
          // Bytes first, then the layout — one bar for both. The bar keeps what
          // it reached when the second phase starts instead of counting from 0
          // again (measured: 100 → 48 on a 200-page file, where the read
          // finished long before the pages were laid out), and the bytes are
          // capped just short of full so the layout still has somewhere to go.
          let handover = -1;
          let barPercent = 0;
          const markProgressDone = (previous) => {
            const total = Math.max(0, Number(previous?.total) || 0);
            const loaded = total > 0 ? total : Math.max(0, Number(previous?.loaded) || 0);
            return { loaded, total, ratio: 1, percent: 100, phase: "prepare" };
          };
          const finishOpenProgress = () => {
            setProgress(markProgressDone);
            setStatus("ready");
          };
          await viewer.open({
            data: copyBytes(bytes),
            size: bytes.byteLength ?? bytes.length ?? 0,
          }, {
            onProgress: (event) => {
              if (disposed) return;
              if (event?.phase === "done") {
                loadingPhase.current = "prepare";
                setProgress(markProgressDone);
                return;
              }
              const total = Number(event?.total) || 0;
              const loaded = Number(event?.loaded) || 0;
              const phase = event?.phase === "prepare" ? "prepare" : "download";
              // A bare `prepare` is the signal that the bytes are in and the
              // layout is starting, whether or not it carries a count yet.
              if (phase === "prepare") loadingPhase.current = "prepare";
              // One bar for two phases, and it only ever moves forwards: the
              // layout picks up where the bytes stopped instead of counting
              // from zero again (measured: 100 -> 48 on a 200-page file), and a
              // byte count that lands after the layout began is the tail of the
              // read, not news about the layout (measured: a "34 MB / 34 MB ·
              // 100%" line repainted in the middle of 正在排版). Reading the
              // previous value inside the updater, rather than in a local, keeps
              // that true even if a second read or a re-render interleaves.
              setProgress((previous) => {
                const floor = Number(previous?.percent) || 0;
                if (phase === "download" && previous?.phase === "prepare") return previous;
                if (total <= 0) {
                  // Started, nothing to count yet: the bar holds what it has.
                  return { loaded, total: 0, ratio: null, percent: floor, phase };
                }
                const own = Math.max(0, Math.min(1, loaded / total));
                const percent = phase === "prepare"
                  ? floor + ((100 - floor) * own)
                  : Math.min(95, Math.max(floor, own * 100));
                return { loaded, total, ratio: own, percent, phase };
              });
            },
          });
          beacon("runtime-viewer-build", {
            viewerBuild: module.PDF_VIEWER_BUILD ?? "unknown",
            ...module.runtimeDiagnostics?.(viewer, "after-open"),
          });
          if (disposed) return;
          // Completion and removal of the loading overlay share this commit;
          // do not hold an opaque loading surface over the already-open page.
          const place = places.get(`${tabIdRef.current}|${address}`);
          if (place !== undefined) {
            // Reopening this tab: resume at the same page and offset.
            viewer.applyReadingPosition(place);
          } else {
            viewer.setZoom(savedPreferences.defaultZoom, { silent: true });
          }
          finishOpenProgress();
          sync();
          // From here on this viewer is worth keeping: a switch away parks it
          // (see `park`), and a switch back re-attaches it.
          entry = {
            address,
            moduleRevision,
            bytes,
            version: bytesVersionRef.current,
            viewer,
            pages,
            state: null,
            rows: null,
          };
          rememberOpenDocument(address, entry);
          loadOutline();
          watchWidth();
          watchWheel(module);
        })().catch((error) => {
          if (disposed) return;
          setFailure(String(error?.message ?? error));
          setStatus("failed");
        });

        return () => {
          disposed = true;
          passwordRef.current?.reject(new Error("closed"));
          passwordRef.current = null;
          clearTimeout(findTimer.current);
          clearTimeout(placeTimer.current);
          savePlace();
          resizeObserver?.disconnect();
          detachWheel();
          detachHistory();
          // Keep the document in the page instead of closing it: the next
          // switch back is then a re-attach, not a reload. `park` only knows
          // how to keep a viewer that finished opening, so a failure still
          // closes as it always did.
          if (!park()) {
            // `park()` only cleans up a viewer that finished opening. A half
            // opened one still owns a `.fp-pages` container in the frame and a
            // `pagesRef` pointing at it; leaving both behind makes the next
            // mount append a second container and judge selections against the
            // detached one.
            viewerRef.current = null;
            pagesRef.current = null;
            pages?.remove?.();
            try {
              viewer?.close();
            } catch {
              /* a closing viewer must not break the unmount */
            }
          }
          detachScrollDiagnostics();
        };
      }, [bytes, sourceAddress, attempt, sync, updateZoomPreview, refreshFind, savePlace, runFind]);

      /**
       * A click on the page puts the outline column away.
       *
       * The column is a look-up, not a fixture: it takes a third of a narrow
       * pane, and the way out of it was the toolbar button that opened it. The
       * extension closes its sidebar the same way a reader expects — press
       * somewhere else — so the same press closes this one. The toolbar and the
       * column itself are the two places a press is not "somewhere else".
       */
      React.useEffect(() => {
        if (pane !== "outline") return undefined;
        const root = rootRef.current;
        if (root === null) return undefined;
        const onAway = (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest(".fp-outline, .fp-toolbar") !== null) return;
          setPane("none");
        };
        root.addEventListener("pointerdown", onAway, true);
        return () => root.removeEventListener("pointerdown", onAway, true);
      }, [pane]);

      const viewer = () => viewerRef.current;

      const go = (delta) => {
        const current = viewer();
        if (current === null) return;
        // Ask the renderer where it is, not the last render: two clicks in one
        // frame both read `view.page` otherwise and the second one is swallowed.
        const total = Math.max(1, current.pageCount || view.total);
        const from = current.currentPage ?? view.page;
        current.goToPage(Math.min(Math.max(1, from + delta), total));
        sync();
      };

      /**
       * Go to one page, clamped to the document.
       *
       * Every way into the page box — leaving the field, Enter, the arrow keys —
       * ends here, so the clamp lives in one place. The box's own draft is the
       * caller's business: two of those three stay in the field afterwards.
       */
      const commitPage = (target) => {
        const current = viewer();
        if (current === null || !Number.isFinite(target) || target < 1) return;
        const total = Math.max(1, current.pageCount || view.total || 1);
        current.goToPage(Math.min(Math.round(target), total), { push: true, instant: true });
        sync();
      };

      /** Walk the jump history, which is where outline and search jumps come from. */
      const goHistory = (delta) => {
        const current = viewer();
        if (current === null) return;
        if (delta < 0) current.back();
        else current.forward();
        sync();
      };

      const zoomBy = async (direction) => {
        const current = viewer();
        if (current === null) return;
        const module = await loadViewer();
        current.setZoom(module.stepZoomPercent(current.zoom * 100, direction));
        sync();
      };

      const setFit = (mode) => {
        const current = viewer();
        if (current === null) return;
        current.setZoom(mode);
        sync();
      };

      /** Hand the typed password back to the open that is waiting for it. */
      const submitPassword = () => {
        const pending = passwordRef.current;
        const entered = password?.draft ?? "";
        if (pending === null || entered === "") return;
        passwordRef.current = null;
        setPassword(null);
        pending.resolve(entered);
      };

      /** Decline to open it: pdf.js fails the open with this message. */
      const cancelPassword = () => {
        const pending = passwordRef.current;
        passwordRef.current = null;
        setPassword(null);
        pending?.reject(new Error(t("passwordCancelled")));
      };

      const closeFind = () => {
        setPane((current) => (current === "search" ? "none" : current));
        clearTimeout(findTimer.current);
        void runFind("", 0, false);
        // Closing the bar takes the focused input with it, and focus falls to
        // <body>: the next Tab then starts over at the top of the pane instead of
        // from where the reader was (measured: activeElement === body). The page
        // is where Ctrl+F and PageDown expect to stand.
        frameRef.current?.focus();
      };

      /**
       * What Ctrl/⌘+F means inside a document.
       *
       * The browser's own find cannot see a canvas: every glyph here is paint,
       * not text in the DOM, so Ctrl+F outside the pane would report zero
       * matches in a document that has hundreds. The app itself binds nothing
       * on that chord (checked in the shipped frontend bundle), so swallowing it
       * while the pane has focus costs nobody anything. The handler sits on the
       * pane root and only runs when focus is inside — Ctrl+F in the chat half
       * still means what it always meant.
       */
      const onRootKeyDown = (event) => {
        // The ⋯ menu is a popover: the first Escape closes it, the next one the
        // sheet it may have opened.
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          setMenu(false);
          return;
        }
        if (event.key === "Escape" && settingsOpen) {
          event.preventDefault();
          closeSettings();
          return;
        }
        // The properties card is a read-only sheet over the page; Escape is the
        // way out of it, exactly as the password card answers the same key.
        if (event.key === "Escape" && sheet !== null) {
          event.preventDefault();
          closeSheet();
          return;
        }
        // The pill is the lightest of the three, so it is what Escape puts away
        // once the menu and the sheet above are gone — and it never touches the
        // card, which only its own 关闭 dismisses.
        if (event.key === "Escape" && chip !== null) {
          event.preventDefault();
          setChip(null);
          // The pill is the offer for *this* selection, so the selection leaves
          // with it. Left alive, the frame's own `keyup` handler — the one that
          // serves Shift+Arrow extension — reads the same range again and puts
          // the pill straight back: measured closed on keydown, back 400 ms
          // later with the range still selected.
          window.getSelection()?.removeAllRanges();
          return;
        }
        // The find bar is the last layer out. It used to answer Escape only from
        // its own field, so a reader who clicked the page to read — the whole
        // point of leaving the bar open — could not put it away at all
        // (`focusOnFrame=true barOpenBeforeFrameEsc=true barClosedFromFrame=false`).
        if (event.key === "Escape" && pane === "search") {
          event.preventDefault();
          closeFind();
          return;
        }
        // The outline column is a side column rather than a popover, so it
        // leaves last: a reader scanning chapters who presses Escape loses the
        // find bar first and the column second. Without this branch the key did
        // nothing at all while the column was open (measured
        // `escapeClosed=false`, `escapePressed=true` — the toolbar button was
        // still held down afterwards).
        if (event.key === "Escape" && pane === "outline") {
          event.preventDefault();
          setPane((current) => (current === "outline" ? "none" : current));
          return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
        if (event.key !== "f" && event.key !== "F") return;
        event.preventDefault();
        event.stopPropagation();
        if (status !== "ready") return;
        setPane("search");
        // Already open: React will not re-mount the field, so focus it by hand.
        findInputRef.current?.focus();
      };

      const stepFind = async (delta) => {
        const current = viewer();
        if (current === null || find.hits.length === 0) return;
                // Ask the renderer where the cursor is, not this render's copy of it:
        // two presses in one frame both read the stale index, so the second is
        // swallowed (measured: two Enters moved the bar 1 / 4 → 2 / 4).
        const base = Number.isInteger(current.hitIndex) && current.hitIndex >= 0 ? current.hitIndex : find.index;
        const index = (base + delta + find.hits.length) % find.hits.length;
        setFind((previous) => ({ ...previous, index }));
        await current.jumpToHit(index);
        sync();
      };

      const toolbar = React.createElement(
        "div",
        { className: "fp-toolbar" },
        outline === null
          ? null
          : React.createElement(
            Button,
            {
              label: t("outline"),
              pressed: pane === "outline",
              onClick: () => setPane((current) => (current === "outline" ? "none" : "outline")),
              icon: icon("IconFlatListOutlineRegular", "M3 4h10M3 8h10M3 12h7"),
            },
          ),
        React.createElement(
          Button,
          {
            label: t("find"),
            pressed: pane === "search",
            disabled: status !== "ready",
            onClick: () => setPane((current) => (current === "search" ? "none" : "search")),
            icon: icon("IconSearchOutlineRegular", "M7 11.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zM10.2 10.2 13.6 13.6"),
          },
        ),
        React.createElement("span", { className: "fp-sep", "aria-hidden": "true" }),
        React.createElement(
          Button,
          {
            label: t("historyBack"),
            disabled: status !== "ready" || view.back !== true,
            onClick: () => goHistory(-1),
            icon: icon(null, DRAWN.historyBack),
          },
        ),
        React.createElement(
          Button,
          {
            label: t("historyForward"),
            disabled: status !== "ready" || view.forward !== true,
            onClick: () => goHistory(1),
            icon: icon(null, DRAWN.historyForward),
          },
        ),
        React.createElement(
          Button,
          {
            label: t("previous"),
            disabled: status !== "ready" || view.page <= 1,
            onClick: () => go(-1),
            icon: icon("IconChevronLeftOutlineRegular", "M9.5 4 5.5 8l4 4"),
          },
        ),
        React.createElement(
          "span",
          // Not `.fp-pages`: that name belongs to the page column below.
          { className: "fp-pageno" },
          // The page number is a box, because "jump to page 640" is a thing a
          // reader does and clicking a chevron 639 times is not. The total stays
          // a label next to it: only one of the two numbers is editable.
          React.createElement("input", {
            type: "text",
            inputMode: "numeric",
            className: "fp-page-input",
            title: t("pageNumber"),
            "aria-label": t("pageNumber"),
            disabled: status !== "ready",
            value: pageDrafting ? pageDraft : String(view.page),
            onFocus: () => {
              drafting.current = true;
              setPageDrafting(true);
              setPageDraft(String(view.page));
            },
            onChange: (event) => setPageDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 6)),
            // Leaving the box is a decision, not a cancellation: the reader
            // typed a page and clicked away, which is what every page field
            // does. Escape clears the draft first, so it cannot land here.
            onBlur: () => {
              if (!drafting.current) return;
              drafting.current = false;
              const target = Number(pageDraft);
              setPageDrafting(false);
              setPageDraft("");
              commitPage(target);
            },
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                drafting.current = false;
                setPageDrafting(false);
                setPageDraft("");
                event.currentTarget.blur();
                return;
              }
              // The arrows step one page from whatever is in the box without
              // leaving it — the gesture every other page field has and this one
              // did not. The box stays in edit mode, so the next keystroke still
              // types; dropping out of edit mode here is what made a typed page
              // disappear.
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const trimmed = String(pageDraft).trim();
                const typed = Number(pageDraft);
                // "0" is a typed value: stepping up from it must land on page
                // 1, not fall back to the current page and skip ahead. An empty
                // (or non-numeric) box still means "step from where I am".
                const from = trimmed !== "" && Number.isFinite(typed) ? Math.max(0, typed) : view.page;
                // Clamped here as well as in `commitPage`, so the number left
                // in the box is the page that was actually reached.
                const target = Math.min(Math.max(1, from + (event.key === "ArrowUp" ? 1 : -1)), Math.max(1, view.total || 1));
                drafting.current = true;
                setPageDrafting(true);
                setPageDraft(String(target));
                commitPage(target);
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              // Enter is the same decision as leaving: the blur handler is the
              // only place that commits, so a page cannot be committed twice.
              event.currentTarget.blur();
            },
          }),
          // The slash is a word, the count is a number; separate boxes so the
          // two can be spaced and the count can hold its own column — that is
          // the alignment 「页数这块不够对齐」 was about.
          React.createElement(
            "span",
            { className: "fp-pages-total" },
            React.createElement("span", { className: "fp-pages-slash", "aria-hidden": "true" }, "/"),
            React.createElement("span", { className: "fp-pages-count" }, String(view.total || "–")),
          ),
        ),
        React.createElement(
          Button,
          {
            label: t("next"),
            disabled: status !== "ready" || view.page >= view.total,
            onClick: () => go(1),
            icon: icon("IconChevronRightOutlineRegular", "M6.5 4 10.5 8l-4 4"),
          },
        ),
        React.createElement("span", { className: "fp-spacer" }),
        // One unit: when the pane is too narrow to hold both groups, the zoom
        // controls move to a second row whole instead of dropping the last button.
        React.createElement(
          "span",
          { className: "fp-zoom" },
          React.createElement(
            Button,
            {
              label: t("zoomOut"),
              // The renderer clamps at 25 % and 500 %. At those two ends the
              // button used to stay lit and swallow the press (measured: 25 %,
              // then six presses, nothing, `disabled=false`).
              disabled: status !== "ready" || view.scale <= 0.25,
              onClick: () => void zoomBy(-1),
              icon: icon(null, DRAWN.minus),
            },
          ),
          React.createElement("span", { className: "fp-zoom-count" }, `${Math.round(view.scale * 100)}%`),
          React.createElement(
            Button,
            {
              label: t("zoomIn"),
              disabled: status !== "ready" || view.scale >= 5,
              onClick: () => void zoomBy(1),
              icon: icon("IconPlusOutlineRegular", "M8 2.5v11M2.5 8h11"),
            },
          ),
          React.createElement(
            Button,
            {
              label: view.mode === "page-width" ? t("fitPage") : t("fitWidth"),
              disabled: status !== "ready",
              onClick: () => setFit(view.mode === "page-width" ? "page-fit" : "page-width"),
              icon: icon(null, view.mode === "page-width" ? DRAWN.fitWidth : DRAWN.fitPage),
            },
          ),
        ),
        // The far right of the bar: one ⋯ for the things a reader *looks at*
        // rather than uses. 文档属性 was an ⓘ button of its own until it became
        // clear that a pane this narrow cannot spend a whole icon on a sheet
        // that opens once per document.
        React.createElement(
          "span",
          { className: "fp-more", ref: moreRef },
          React.createElement(
            Button,
            {
              label: t("more"),
              // `pressed` is the only state the Host's Button forwards to the DOM
              // (`aria-pressed`; measured — hand-written `aria-haspopup` /
              // `aria-expanded` never reach the element), so the open state rides
              // on the contract the primitive actually honours.
              pressed: menu,
              onClick: () => setMenu((open) => !open),
              icon: icon(null, "M2.6 8h.01M8 8h.01M13.4 8h.01"),
            },
          ),
          menu
            ? React.createElement(
              "div",
              { className: "fp-menu" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "fp-menu-row",
                  onClick: () => void openSettings(),
                },
                icon(null, "M8 2.5v2M8 11.5v2M13.5 8h-2M4.5 8h-2M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4M11.9 11.9l-1.4-1.4M5.5 5.5 4.1 4.1M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z"),
                React.createElement("span", null, t("settings")),
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "fp-menu-row",
                  disabled: status !== "ready",
                  onClick: () => {
                    setMenu(false);
                    void toggleSheet();
                  },
                },
                icon(null, "M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8zM8 7.2v3.6M8 4.9v1"),
                React.createElement("span", null, t("properties")),
              ),
            )
            : null,
        ),
      );

      const findBar = pane === "search"
        ? React.createElement(
          "div",
          { className: "fp-findbar" },
          React.createElement("input", {
            type: "text",
            className: "fp-find-input",
            placeholder: t("findPlaceholder"),
            "aria-label": t("findPlaceholder"),
            value: find.query,
            spellCheck: false,
            autoFocus: true,
            ref: findInputRef,
            onChange: (event) => {
              const value = event.target.value;
              // The answer for the previous query is not the answer for this one:
              // dropping the hits stops the bar from showing a stale count, and
              // `busy` stops it from claiming 「没有找到」 during the debounce
              // (measured: that claim appeared about a word with 11 hits in it).
              setFind((previous) => ({ ...previous, query: value, hits: [], index: -1, busy: true }));
              clearTimeout(findTimer.current);
              findTimer.current = setTimeout(() => void runFind(value, 0, true), FIND_DEBOUNCE_MS);
            },
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                clearTimeout(findTimer.current);
                if (find.hits.length > 0) void stepFind(event.shiftKey ? -1 : 1);
                else void runFind(event.currentTarget.value, 0, true);
              } else if (event.key === "Escape") {
                // The pane root owns Escape: it is the only place that knows the
                // order the layers leave in (menu → sheet → pill → find bar).
                // Closing the bar here as well let the same press go on to the
                // root and take the menu with it — one Escape, two layers,
                // measured `escMenuGone=true escBarGone=true` with both open.
                event.preventDefault();
              }
            },
          }),
          // Two switches, a letter wide: the search engine has understood both
          // from the start, the bar just never asked.
          React.createElement(
            Button,
            {
              label: t("matchCase"),
              pressed: find.matchCase,
              className: "fp-find-toggle",
              onClick: () => {
                const next = !findRef.current.matchCase;
                // `runFind` reads the ref, and the state write has not landed yet.
                findRef.current = { ...findRef.current, matchCase: next };
                setFind((previous) => ({ ...previous, matchCase: next }));
                if (find.query !== "") void runFind(find.query, 0, true);
              },
            },
            "Aa",
          ),
          React.createElement(
            Button,
            {
              label: t("wholeWord"),
              pressed: find.wholeWord,
              className: "fp-find-toggle",
              onClick: () => {
                const next = !findRef.current.wholeWord;
                findRef.current = { ...findRef.current, wholeWord: next };
                setFind((previous) => ({ ...previous, wholeWord: next }));
                if (find.query !== "") void runFind(find.query, 0, true);
              },
            },
            "ab",
          ),
          React.createElement(
            "span",
            {
              className: "fp-find-count",
              // The count lands asynchronously: a reader who cannot see the
              // bar has no other way to hear 「没有找到」.
              role: "status",
              "aria-live": "polite",
              "data-empty": find.query !== "" && find.hits.length === 0 ? "" : undefined,
            },
            // 「没有找到」 is a verdict, not a placeholder: it may only appear once a
            // search over a complete index has come back empty. The three states
            // before that verdict are different and the bar used to show one of
            // them (the index one) only when it was impossible: measured on three
            // files, a reader who typed a query saw an empty bar for 400 ms and
            // then a count that silently grew as the index walked. So: 「正在搜索…」
            // while the answer is in flight, 「正在建立索引…」 while the index is
            // short, and a 「索引中 n/m」 tail on the count while it still grows.
            find.hits.length === 0
              ? find.busy
                ? t("findSearching")
                : find.query === ""
                  ? ""
                  : find.indexing
                    ? t("findIndexing")
                    : t("findNone")
              : `${find.index + 1} / ${find.hits.length}${find.indexing && find.pages > 0
                ? ` · ${t("findIndexingProgress").replace("{current}", String(find.indexed)).replace("{total}", String(find.pages))}`
                : ""}`,
          ),
          React.createElement(
            Button,
            {
              label: t("findPrevious"),
              disabled: find.hits.length === 0,
              onClick: () => void stepFind(-1),
              icon: icon("IconChevronUpOutlineRegular", "M4 9.5 8 5.5l4 4"),
            },
          ),
          React.createElement(
            Button,
            {
              label: t("findNext"),
              disabled: find.hits.length === 0,
              onClick: () => void stepFind(1),
              icon: icon("IconChevronDownOutlineRegular", "M4 6.5 8 10.5l4-4"),
            },
          ),
          React.createElement(Button, {
            label: t("close"),
            onClick: closeFind,
            icon: icon("IconCloseOutlineRegular", "M4 4l8 8M12 4l-8 8"),
          }),
        )
        : null;

      // The tree is rendered nested, one container per parent, so a branch can
      // animate its own height. A flat list can only appear and disappear, and
      // 「目录展开没有动画」 was exactly that. Collapsed branches stay in the DOM,
      // clipped to zero and inert, so the height has something to transition.
      const kidsOf = new Map();
      for (const row of outline ?? []) {
        const list = kidsOf.get(row.parent);
        if (list === undefined) kidsOf.set(row.parent, [row]);
        else list.push(row);
      }

      /**
       * One outline node and, under it, its own branch.
       *
       * The branch carries the animation: `grid-template-rows` runs between 0fr
       * and 1fr, so the browser interpolates a real height instead of switching
       * `display` — which is what 「没有动画」 meant. `inert` while folded keeps a
       * clipped-away subtree out of the tab order and out of the pointer's way.
       *
       * @param rows - the sibling rows to render.
       */
      const renderOutlineRows = (rows) => rows.map((row) => {
        const unfolded = row.children > 0 && !folded.has(row.id);
        return React.createElement(
          "div",
          { key: row.id, className: "fp-outline-node" },
          React.createElement(
            "div",
            {
              className: "fp-outline-item",
              "data-active": row.id === chapter ? "" : undefined,
              // The indent is also the highlight's start, so it is published
              // rather than repeated in the stylesheet — a rule pinned to the
              // column's left edge marks the column, not the chapter.
              style: {
                "--fp-indent": `${2 + row.depth * 12}px`,
                paddingInlineStart: `${2 + row.depth * 12}px`,
              },
            },
            row.children > 0
              ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "fp-outline-caret",
                  "data-folded": unfolded ? undefined : "",
                  "aria-expanded": unfolded,
                  "aria-label": unfolded ? t("foldNode") : t("unfoldNode"),
                  onClick: () => foldNode(row.id),
                },
                "›",
              )
              : React.createElement("span", { className: "fp-outline-caret", "aria-hidden": "true" }),
            React.createElement(
              "button",
              {
                type: "button",
                className: "fp-outline-row",
                title: row.title,
                "aria-current": row.id === chapter ? "location" : undefined,
                onClick: () => {
                  const current = viewer();
                  if (current === null) return;
                  const id = String(row.id ?? "");
                  // Mark it the active entry straight away — page -1 says the
                  // jump is still in flight, so `sync()` keeps it until the
                  // landing page is known (see the note there).
                  outlineHold.current = { id, page: -1 };
                  setChapter(id);
                  void current.goToDest(row.dest, true).then(() => {
                    // Landed: stamp the page it landed on, so the hold lasts
                    // exactly as long as the reader stays on it. A sync may
                    // have run during the jump and answered with the old
                    // chapter, so say it again here.
                    if (outlineHold.current.id === id) {
                      outlineHold.current = { id, page: viewer()?.currentPage ?? 0 };
                    }
                    setChapter(id);
                  });
                },
              },
              row.title,
            ),
          ),
          row.children > 0
            ? React.createElement(
              "div",
              {
                className: "fp-outline-kids",
                "data-folded": unfolded ? undefined : "",
                inert: unfolded ? undefined : "",
              },
              React.createElement(
                "div",
                { className: "fp-outline-inner" },
                renderOutlineRows(kidsOf.get(row.id) ?? []),
              ),
            )
            : null,
        );
      });

      const outlineColumn = pane === "outline" && outline !== null
        ? React.createElement(
          "nav",
          { className: "fp-outline" },
          React.createElement(
            "div",
            { className: "fp-outline-head" },
            React.createElement(Button, {
              label: t("expandAll"),
              className: "fp-outline-fold",
              onClick: () => foldAll(false),
              icon: icon(null, DRAWN.expandAll),
            }),
            React.createElement(Button, {
              label: t("collapseAll"),
              className: "fp-outline-fold",
              onClick: () => foldAll(true),
              icon: icon(null, DRAWN.collapseAll),
            }),
          ),
          // The rows scroll; those two buttons do not. A long table of contents
          // used to carry them off the top with it — 「折叠展开没有固定在顶端」
          // — so the list gets its own scroller and the head stays put.
          React.createElement(
            "div",
            { className: "fp-outline-list" },
            renderOutlineRows(kidsOf.get("") ?? []),
          ),
        )
        : null;

      const frame = React.createElement(
        "div",
        {
          className: "fp-frame",
          ref: frameRef,
          // Focusable without joining the tab order: clicking a page focuses it,
          // which is what gives Ctrl+F somewhere to stand.
          tabIndex: -1,
        },
        // The page container is made by the viewer effect, not here: a document
        // that is already open keeps its own container, and that is the node the
        // effect re-attaches on the way back. React must not own it, or the two
        // would fight over the same children.
      );

      // The pill is one line tall and the card is not, so each asks the placement
      // rules for its own answer; a dragged card keeps the position it was given.
      const pillPlaced = chip === null ? null : placeBubble(chip, PILL_HEIGHT, PILL_WIDTH);
      const bubbleHeight = pick === null ? 0 : pick.cardHeight ?? CARD_TALL;
      const placed = pick === null ? null : placeBubble(pick, bubbleHeight, CARD_WIDTH);
      const dragPosition = pick !== null && pickDragPositionRef.current?.card === cardRef.current?.closest(".fp-pick")
        ? pickDragPositionRef.current
        : null;
      const cardLeft = pick === null ? 0 : dragPosition?.pendingLeft ?? dragPosition?.left ?? pick.moved?.left ?? placed?.left ?? 8;
      const cardTop = pick === null ? 0 : dragPosition?.pendingTop ?? dragPosition?.top ?? pick.moved?.top ?? placed?.top ?? 8;

      // The pill offers the request; the card is the request. Two elements, two
      // lifetimes: a pinned card can be on screen while the next selection's
      // pill waits beside it.
      const pickChip = chip === null
        ? null
        : React.createElement(
          "div",
          {
            className: "fp-chip",
            style: {
              left: `${pillPlaced?.left ?? 8}px`,
              top: `${pillPlaced?.top ?? 8}px`,
              "--fp-chip-width": `${pillPlaced?.width ?? PILL_WIDTH}px`,
            },
          },
          React.createElement(
            "button",
            { type: "button", className: "fp-pick-action", onClick: () => void translate(chip) },
            t("translate"),
          ),
        );

      const picker = pick === null
        ? null
        : React.createElement(
          "div",
          {
            className: "fp-pick",
            "data-status": pick.status,
            "data-mode": pick.mode ?? "passage",
            "data-pinned": pick.pinned === true ? "" : undefined,
            "data-moved": pick.moved === undefined ? undefined : "",
            style: {
              left: `${cardLeft}px`,
              top: `${cardTop}px`,
              "--fp-card-width": `${cardSize?.width ?? placed?.width ?? CARD_WIDTH}px`,
              "--fp-card-height": cardSize === null ? undefined : `${cardSize.height}px`,
              // The placement caps the *content* height; a card the reader made
              // taller than that keeps its own height, already clamped to the pane.
              "--fp-card-max-height": `${Math.max(placed?.maxHeight ?? CARD_TALL, cardSize?.height ?? 0)}px`,
            },
          },
          React.createElement(
              "div",
              {
                className: "fp-pick-card",
                ref: cardRef,
                // Capture: an edge press is a resize, not a drag on the head.
                onPointerDownCapture: beginResize,
                onPointerMove: hoverResize,
                onPointerLeave: (event) => {
                  if (!(event.currentTarget instanceof Element)) return;
                  event.currentTarget.style.cursor = "";
                  event.currentTarget.removeAttribute("data-edge");
                },
              },
              React.createElement(
                "div",
                {
                  className: "fp-pick-head",
                  // The head is the handle. It is also where the pointer is
                  // anyway once the card covers the line it was opened from.
                  onPointerDown: beginDrag,
                },
                pick.status === "busy"
                  ? React.createElement("span", { className: "fp-pick-spinner", "aria-hidden": "true" })
                  : null,
                React.createElement(
                  "span",
                  { className: "fp-pick-title" },
                  pick.status === "busy"
                    ? t("translating")
                    : pick.status === "error"
                      ? pick.message
                      : TARGET_LABEL[pick.result?.target] ?? pick.result?.target ?? "",
                ),
                pick.status === "busy"
                  // 停止 replaces 关闭 while a call is out: a request the reader
                  // no longer wants should stop, not just be hidden.
                  ? React.createElement(Button, {
                    label: t("stop"),
                    className: "fp-pick-close",
                    onClick: stopTranslate,
                    icon: icon(null, "M5 5h6v6H5z"),
                  })
                  : React.createElement(Button, {
                    label: pick.pinned === true ? t("unpin") : t("pin"),
                    className: "fp-pick-close fp-pin",
                    pressed: pick.pinned === true,
                    onClick: () => setPick((held) => (held === null ? held : { ...held, pinned: held.pinned !== true })),
                    // One pin, two fills. The pinned state used to be a filled
                    // triangle over a stem — that is an *up arrow*, and an up
                    // arrow in a card header reads as 「move up」, not 「this card is
                    // pinned」 (measured glyph: M8 8.6v4.9M4.2 8.6 8 1.9l3.8 6.7z).
                    // Same silhouette in both states, so the only thing that
                    // changes is 「outline → solid」, which is the state.
                    icon: pick.pinned === true
                      ? icon(null, "M6 2.5h4l-.6 3.2 2.1 2.1H4.5l2.1-2.1z M8 7.8V13.5", "solid")
                      : icon(null, "M6 2.5h4l-.6 3.2 2.1 2.1H4.5l2.1-2.1z M8 7.8V13.5"),
                  }),
                React.createElement(Button, {
                  label: t("close"),
                  className: "fp-pick-close",
                  onClick: () => setPick(null),
                  icon: icon("IconCloseOutlineRegular", "M4 4l8 8M12 4l-8 8"),
                }),
              ),
              // The words this came from, remembered so the reader can check
              // what is being translated without losing the selection.
              pick.text === "" && pick.raw === undefined
                ? null
                : React.createElement(
                  "div",
                  {
                    className: "fp-pick-source",
                    "data-open": pick.srcOpen === true ? "" : undefined,
                    title: t("source"),
                    onClick: () => setPick((held) => (held === null ? held : { ...held, srcOpen: held.srcOpen !== true })),
                  },
                  pick.text !== "" ? pick.text : String(pick.raw ?? "").slice(0, 400),
                ),
              pick.status === "done" || (pick.status === "busy" && String(pick.partial ?? "") !== "")
                // The translation arrives as markdown; the extension's own
                // renderer turns tables, lists and code into elements, and a
                // streaming answer keeps its caret.
                ? React.createElement("div", {
                  className: "fp-pick-text",
                  ref: pickBody,
                  // While it is still arriving the card grows a line at a time,
                  // so the tail has to stay in view without the reader chasing it.
                  "data-streaming": pick.status === "busy" ? "" : undefined,
                })
                : null,
              pick.status === "done"
                ? React.createElement(
                  "div",
                  { className: "fp-pick-foot" },
                  React.createElement(
                    Button,
                    {
                      // One glyph, not a word: the footer is 300px wide and the
                      // model name next to it wants that room. The label lives
                      // on as the accessible name, so 「复制」 is still said out
                      // loud and the 已复制 answer still arrives — it just
                      // arrives as a tick instead of a second string.
                      className: "fp-foot-copy",
                      label: pick.copied ? t("copied") : t("copy"),
                      icon: pick.copied
                        // The Host's own icon names, checked against the
                        // shipped bundle: `IconCopyOutlineRegular` and
                        // `IconCheckOutlineRegular` are both there, so the two
                        // glyphs come from the same set as the toolbar's. The
                        // drawn paths are the fallback for hosts that lack them.
                        ? icon("IconCheckOutlineRegular", DRAWN.check)
                        : icon("IconCopyOutlineRegular", DRAWN.copy),
                      onClick: () => {
                        const body = pickBody.current;
                        const module = helperRef.current["bubble-text.mjs"];
                        const plain = module !== undefined && body !== null
                          ? module.readBubblePlainText(body)
                          : String(pick.result.text ?? "");
                        copyText(plain);
                        setPick((held) => (held === null ? held : { ...held, copied: true }));
                        clearTimeout(copyReset.current);
                        copyReset.current = setTimeout(() => {
                          setPick((held) => (held === null ? held : { ...held, copied: false }));
                        }, 1500);
                      },
                    },
                  ),
                  React.createElement(
                    "span",
                    { className: "fp-pick-model" },
                    `${pick.result.provider ?? ""} / ${pick.result.model ?? ""}`,
                  ),
                )
                : pick.status === "error"
                  // A failed call is worth one more try without reselecting.
                  ? React.createElement(
                    "div",
                    { className: "fp-pick-foot" },
                    pick.text === ""
                      ? null
                      : React.createElement(
                        Button,
                        {
                          variant: "outline",
                          className: "fp-foot-btn",
                          onClick: () => void translate(),
                        },
                        t("retry"),
                      ),
                  )
                  : null,
            ),
        );

      // The card is filled by the ported renderer rather than by React: the
      // markdown walker builds elements, and re-implementing it in createElement
      // would be a second renderer to keep in step.
      React.useEffect(() => {
        const el = pickBody.current;
        if (el === null) return;
        const streaming = pick?.status === "busy";
        const text = pick?.status === "done"
          ? String(pick.result?.text ?? "")
          : streaming
            ? String(pick.partial ?? "")
            : "";
        if (text === "") {
          el.replaceChildren();
          return;
        }
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        const mode = pick?.mode ?? "passage";
        const paint = (module) => {
          if (!el.isConnected) return;
          if (module === undefined) {
            el.textContent = text;
            return;
          }
          module.renderBubbleTranslation(el, text, mode, { streaming });
        };
        paint(helperRef.current["bubble-text.mjs"]);
        if (helperRef.current["bubble-text.mjs"] === undefined) {
          void loadHelper("bubble-text.mjs").then((module) => {
            helperRef.current["bubble-text.mjs"] = module;
            paint(module);
          }, () => {});
        }
        // Follow the tail, unless the reader scrolled up to read what the answer
        // already said — then the card stays where they put it.
        if (streaming && atBottom) el.scrollTop = el.scrollHeight;
      }, [pick?.status, pick?.result?.text, pick?.partial, pick?.mode]);

      /**
       * Measure the card once it has drawn — and again whenever it changes size.
       *
       * Above-or-below is decided by how tall the card is, and only the browser
       * knows that. Written back into the pick state instead of read during
       * render, because a layout read there would repeat on every pass; the
       * two-pixel tolerance stops a rounding disagreement from looping.
       *
       * A one-shot measurement is not enough: the card grows after the first
       * paint (the translation lands, the quoted source block opens, the footer
       * fills in), and a height taken too early leaves the flipped card sitting
       * on top of the words instead of above them — measured 95.3 px against the
       * 103 px it ended up being. `ResizeObserver` follows the card, so the
       * placement tracks whatever the card becomes, including a manual resize.
       */
      React.useLayoutEffect(() => {
        const el = cardRef.current;
        if (el === null) return undefined;
        const write = () => {
          const height = el.getBoundingClientRect().height;
          if (height < 1) return;
          if (Math.abs(height - (pickRef.current?.cardHeight ?? 0)) < 2) return;
          setPick((held) => (held === null ? held : { ...held, cardHeight: height }));
        };
        write();
        if (typeof ResizeObserver !== "function") return undefined;
        const observer = new ResizeObserver(write);
        observer.observe(el);
        return () => observer.disconnect();
      }, [pick?.status, pick?.result?.text, pick?.mode]);

      // What the file says about itself, read once when the card opens. Nothing
      // here is editable: the panel is a label with a long list on it.
      const propertiesCard = sheet === null
        ? null
        : React.createElement(
          "div",
          {
            className: "fp-panel-mask",
            onClick: closeSheet,
          },
          React.createElement(
            "div",
            {
              className: "fp-panel",
              role: "dialog",
              "aria-label": t("properties"),
              onClick: (event) => event.stopPropagation(),
            },
            React.createElement(
              "div",
              { className: "fp-panel-head" },
              React.createElement("span", { className: "fp-pick-title" }, t("properties")),
              React.createElement(Button, {
                label: t("close"),
                className: "fp-pick-close",
                // The × needs no tooltip, and inside this sheet the Host's
                // tooltip landed at the far right of the pane and widened it.
                tip: false,
                onClick: closeSheet,
                icon: icon("IconCloseOutlineRegular", "M4 4l8 8M12 4l-8 8"),
              }),
            ),
            React.createElement(
              "dl",
              { className: "fp-prop-list" },
              sheet.map((row, at) => React.createElement(
                React.Fragment,
                { key: `${at}:${row.label}` },
                React.createElement("dt", { className: "fp-prop-key" }, row.label),
                React.createElement("dd", { className: "fp-prop-value", title: row.value }, row.value),
              )),
            ),
          ),
        );

      const settingsCard = !settingsOpen
        ? null
        : React.createElement(
          "div",
          { className: "fp-panel-mask", onClick: closeSettings },
          React.createElement(
            "div",
            {
              className: "fp-panel fp-settings",
              role: "dialog",
              "aria-modal": "true",
              "aria-label": t("settings"),
              onClick: (event) => event.stopPropagation(),
              onKeyDown: (event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSettings();
                  return;
                }
                if (event.key === "Tab") {
                  const focusable = Array.from(event.currentTarget.querySelectorAll(
                    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
                  ));
                  if (focusable.length === 0) {
                    event.preventDefault();
                    return;
                  }
                  const first = focusable[0];
                  const last = focusable[focusable.length - 1];
                  if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
                    event.preventDefault();
                    last.focus();
                  } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              },
            },
            React.createElement(
              "div",
              { className: "fp-panel-head" },
              React.createElement("span", { className: "fp-settings-heading" }, t("settings")),
              React.createElement(Button, {
                label: t("close"),
                className: "fp-pick-close",
                tip: false,
                onClick: closeSettings,
                icon: icon("IconCloseOutlineRegular", "M4 4l8 8M12 4l-8 8"),
              }),
            ),
            React.createElement(
              "label",
              { className: "fp-settings-row" },
              React.createElement("span", { className: "fp-settings-label" }, t("translationLanguage")),
              React.createElement(
                "select",
                {
                  className: "fp-settings-select fp-settings-language",
                  value: preferences.translationLanguage,
                  onChange: (event) => void updatePreference("translationLanguage", event.target.value),
                },
                React.createElement("option", { value: "auto" }, t("languageAuto")),
                React.createElement("option", { value: "zh" }, t("languageChinese")),
                React.createElement("option", { value: "en" }, t("languageEnglish")),
              ),
            ),
            React.createElement(
              "label",
              { className: "fp-settings-row" },
              React.createElement("span", { className: "fp-settings-label" }, t("defaultZoom")),
              React.createElement(
                "select",
                {
                  className: "fp-settings-select",
                  value: preferences.defaultZoom,
                  onChange: (event) => void updatePreference("defaultZoom", event.target.value),
                },
                ...[["page-fit", t("fitPage")], ["page-width", t("fitWidth")], ["50", "50%"], ["75", "75%"], ["100", "100%"], ["125", "125%"], ["150", "150%"], ["175", "175%"], ["200", "200%"], ["250", "250%"], ["300", "300%"]]
                  .map(([value, label]) => React.createElement("option", { key: value, value }, label)),
              ),
              React.createElement("span", { className: "fp-settings-hint" }, t("defaultZoomHint")),
            ),
            React.createElement(
              "label",
              { className: "fp-settings-row" },
              React.createElement(
                "span",
                { className: "fp-settings-label fp-settings-gap-label" },
                t("pageGap"),
                React.createElement("output", { className: "fp-settings-gap-value", htmlFor: "fp-settings-gap" }, `${preferences.pageGap}px`),
              ),
              React.createElement("input", {
                id: "fp-settings-gap",
                className: "fp-settings-range",
                type: "range",
                min: 0,
                max: 48,
                step: 2,
                value: preferences.pageGap,
                onChange: (event) => void updatePreference("pageGap", Number(event.target.value)),
              }),
              React.createElement("span", { className: "fp-settings-hint" }, t("pageGapHint")),
            ),
          ),
        );

      const passwordCard = password === null
        ? null
        : React.createElement(
          "div",
          {
            className: "fp-password",
            // The same shape as the properties sheet: a card over the page that
            // asks the reader something, so it names itself instead of leaving a
            // screen reader on a naked div (measured: role=null).
            role: "dialog",
            "aria-label": t("passwordTitle"),
          },
          React.createElement(
            "form",
            {
              onSubmit: (event) => {
                event.preventDefault();
                submitPassword();
              },
            },
            React.createElement("div", { className: "fp-password-title" }, t("passwordTitle")),
            React.createElement(
              "div",
              {
                className: "fp-password-hint",
                // The wrong-password line replaces the hint in place; without a
                // live region the reader only hears the input they are back in,
                // never why (measured: hintRole=null hintLive=null).
                role: "status",
                "aria-live": "polite",
                "data-wrong": password.wrong ? "" : undefined,
              },
              password.wrong ? t("passwordWrong") : t("passwordHint"),
            ),
            React.createElement("input", {
              type: "password",
              className: "fp-password-input",
              placeholder: t("passwordPlaceholder"),
              "aria-label": t("passwordPlaceholder"),
              value: password.draft,
              autoFocus: true,
              spellCheck: false,
              autoComplete: "off",
              onChange: (event) => {
                const value = event.target.value;
                setPassword((held) => (held === null ? held : { ...held, draft: value }));
              },
              onKeyDown: (event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                // This Escape belongs to the card — it is the layer the reader is
                // in. Without stopping it here the same key keeps bubbling to the
                // root handler, which closed the menu behind the card as well
                // (measured: one press = card gone + menu gone + the pane fell
                // through to 「这个 PDF 打不开」).
                event.stopPropagation();
                cancelPassword();
              },
            }),
            React.createElement(
              "div",
              { className: "fp-password-actions" },
              React.createElement(
                Button,
                { variant: "outline", onClick: () => cancelPassword() },
                t("passwordCancel"),
              ),
              // The Host's Button is always `type="button"`, so the form's
              // submit is reached through the handler; Enter in the input still
              // submits the form itself.
              React.createElement(
                Button,
                {
                  variant: "primary",
                  className: "fp-password-submit",
                  disabled: password.draft === "",
                  onClick: () => submitPassword(),
                },
                t("passwordOpen"),
              ),
            ),
          ),
        );

      /**
       * What the opening line says, and how full its bar is.
       *
       * Before the module lands — or if its file never arrives — the line still
       * says something honest: the plain percentage the read reported.
       */
      const progressModule = helperRef.current["loading-progress.mjs"];
      const locale = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
      // A ratio only means something against a length; a byte count on its own
      // keeps the fallback line at "opening" rather than a fake 0%.
      const ratio = progress === null || (Number(progress.total) || 0) <= 0 ? null : Number(progress.ratio);
      const barPercent = progress === null ? null : Number(progress.percent);
      const loading = progressModule === undefined
        ? {
          // A known count is a known count, module or no module: the fallback
          // used to call itself indeterminate while carrying a percentage.
          mode: Number.isFinite(barPercent) ? "determinate" : "indeterminate",
          percent: Number.isFinite(barPercent) ? Math.floor(barPercent) : null,
          text: Number.isFinite(barPercent) ? `${t("loading")} ${Math.floor(barPercent)}%` : t("loading"),
        }
        : progressModule.loadingState({
          // Bytes are in and the layout is not: that is the difference between
          // waiting on a disk and waiting on pdf.js. Whoever last reported says
          // which phase it was — both of them can be a 0-100 count.
          phase: progress?.phase ?? (bytes === undefined ? "download" : "prepare"),
          progress: ratio,
          // The bar's own 0-100, which spans both phases and never walks back.
          barPercent: progress?.percent,
          loaded: progress?.loaded ?? 0,
          total: progress?.total ?? 0,
        }, t, locale);

      return React.createElement(
        "div",
        { className: "fp-root", ref: rootRef, onKeyDown: onRootKeyDown },
        toolbar,
        findBar,
        React.createElement("div", { className: "fp-body" }, outlineColumn, frame),
        status === "loading" && password === null
          ? React.createElement(
            "div",
            { className: "fp-status", "data-loading": "" },
            // A 100 MB PDF is 50 window reads; the count is the difference
            // between "hung" and "working". Once the bytes are in, the line
            // changes phase instead of sitting frozen on 100%.
            React.createElement(
              "div",
              { className: "fp-loading" },
              React.createElement("div", { className: "fp-loading-text" }, loading.text),
              React.createElement(
                "div",
                {
                  className: "fp-loading-track",
                  role: "progressbar",
                  "aria-label": t("loading"),
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-valuenow": loading.percent === null ? undefined : loading.percent,
                  "data-mode": loading.mode,
                },
                React.createElement("div", {
                  className: "fp-loading-fill",
                  style: { inlineSize: loading.percent === null ? "35%" : `${loading.percent}%` },
                }),
              ),
            ),
          )
          : null,
        status === "failed"
          ? React.createElement(
            "div",
            { className: "fp-status", "data-failed": "" },
            React.createElement(
              "div",
              null,
              React.createElement("div", null, t("failed")),
              failure === ""
                ? null
                : React.createElement(
                  "div",
                  { title: failure },
                  describeFailure(failure, t) ?? failure,
                ),
              React.createElement(
                Button,
                {
                  variant: "outline",
                  onClick: () => {
                    // A retry means "read it again": whatever this page kept for
                    // this address is what just failed, so it goes first.
                    closeOpenDocument(String(props.resourceAddress ?? ""));
                    // With a handle, the Host owns the retry: it resets the
                    // revision and the loader effect above starts over.
                    if (rendererContent !== undefined && typeof rendererContent.reload === "function") {
                      rendererContent.reload();
                      return;
                    }
                    setAttempt((value) => value + 1);
                  },
                  icon: icon("IconRefreshOutlineRegular", "M12.5 8a4.5 4.5 0 1 1-1.6-3.4M12.5 3v2.6h-2.6"),
                },
                t("retry"),
              ),
            ),
          )
          : null,
        passwordCard,
        settingsCard,
        propertiesCard,
        picker,
        pickChip,
      );
    }

    /**
     * Register the preview, its dictionary, its stylesheet and its body.
     * @param ctx - plugin context carrying slots, locale and the document registry.
     */
    function apply(ctx) {
      const startedAt = Date.now();
      moduleRevision = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      viewerModule = undefined;
      helperModules.clear();
      const t = ctx.locale.bind(NS);
      const tabs = retainTabs();
      // Where the bytes come from, for the report: `host-route` means the body
      // reads the file through `/fast-pdf/file`, so no 32 MiB cap applies.
      const reader = "host-route";
      ctx.effect(() => () => tabs.dispose(), "fast-pdf: retention");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "fast-pdf: dictionaries");
      ctx.effect(() => applyStyles(), "fast-pdf: styles");
      ctx.effect(
        () =>
          ctx.documentPreviews.register({
            id: PREVIEW_ID,
            extensions: ["pdf"],
            binaryExtensions: ["pdf"],
            title: () => t("title"),
            // `renderer` is the Host's "the body brings its own content" mode:
            // it reads nothing itself, hands the body a handle
            // (`{ revision, reload, loaded, failed }`), and its whole-file cap
            // never runs. A 200 MB PDF opens here; it never did with
            // `bytes-complete`, which the Host refuses above 32 MiB — and the
            // body it refuses is the very one that would show the message.
            loading: "renderer",
            wrap: false,
          }),
        "fast-pdf: preview",
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.tab.document", () =>
            ctx.slots.register(
              {
                name: "sidebar.right.tab.document",
                key: PREVIEW_ID,
                locale: NS,
                // The owning session decides which model translates a
                // selection; `retainTab` is the byte-retention seat built above.
                //
                // `actions` is optional, and in the running app it is absent:
                // the slot only carries one for a registration that brings its
                // own `store`, which this one deliberately does not. Reading
                // `actions.forget` unguarded is what used to blank the pane with
                // "Cannot read properties of undefined (reading 'forget')".
                inject: (sessionId, actions) => ({
                  sessionId,
                  retainTab: (tabId, signal) => tabs.retain(tabId, signal, actions?.forget),
                  // The one read a `renderer` body needs: the whole file,
                  // through this plugin's own route, past the Host's cap.
                  readBytes: readWholeFile,
                }),
              },
              PdfBodyGate,
            ),
          ),
        "fast-pdf: body",
      );
      previewRegistry = ctx.documentPreviews;
      // After the effects above, so `candidates` already sees this registration.
      Promise.resolve().then(() => beacon("apply", { tookMs: Date.now() - startedAt, reader }));
    }

    return {
      inject: ["slots", "locale", "documentPreviews"],
      apply,
    };
  },
});
