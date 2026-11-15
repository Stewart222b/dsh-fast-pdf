import {
  getDocument,
  GlobalWorkerOptions,
  setLayerDimensions,
} from "./pdf.mjs";
import { TextLayerBuilder } from "./pdf_viewer.mjs";
import { buildTextIndex, buildTextMapping, matchRects } from "./search.mjs";
import { convertCssToPdfPoint, convertPdfToCssPoint } from "./pdf-viewport.mjs";
import { destPdfY } from "./outline-active.mjs";
import { t } from "./i18n.mjs";

GlobalWorkerOptions.workerSrc = new URL(
  "./pdf.worker.mjs",
  import.meta.url,
).toString();

const CMAP_URL = new URL("./cmaps/", import.meta.url).toString();
const FONT_URL = new URL("./standard_fonts/", import.meta.url).toString();
const WASM_URL = new URL("./wasm/", import.meta.url).toString();
const ICC_URL = new URL("./iccs/", import.meta.url).toString();
export const PDF_VIEWER_BUILD = "2026-11-15-search-navigation-v6";

export function runtimeDiagnostics(viewer, phase) {
  const port = viewer?.loadingTask?._worker?.port;
  const workerPortKind = port?.constructor?.name ?? "unavailable";
  let realWorker = false;
  try { realWorker = typeof Worker === "function" && port instanceof Worker; } catch { /* surface may omit Worker */ }
  let sourceProtocol = "";
  let workerSourceProtocol = "";
  try { sourceProtocol = new URL(import.meta.url).protocol; } catch { /* import metadata may be unavailable */ }
  try { workerSourceProtocol = new URL(GlobalWorkerOptions.workerSrc).protocol; } catch { /* worker may be unset */ }
  return { build: PDF_VIEWER_BUILD, phase, sourceProtocol, workerSourceProtocol, workerPortKind, realWorker };
}

function viewportRect(viewport, pdfRect) {
  const [x1, y1, x2, y2] = pdfRect;
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
  const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
  return [vx1, vy1, vx2, vy2];
}

function destTypeName(type) {
  if (type == null) return "";
  if (typeof type === "string") return type;
  return type.name || "";
}

const DEST_SCROLL_OFFSET = 64;
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 175, 200, 250, 300];
// Mouse notches report ±100/120 px; trackpad nudges are much smaller.
const WHEEL_COARSE_PX = 40;
const WHEEL_FINE_PX_CAP = 10;
const RENDER_MARGIN_PX = 1200;
const SCROLL_SETTLE_MS = 100;

export function wheelDeltaPixels(deltaY, deltaMode = 0, pageHeight = 800) {
  if (!Number.isFinite(deltaY)) return 0;
  let pixels = deltaY;
  if (deltaMode === 1) pixels *= 16;
  else if (deltaMode === 2) pixels *= pageHeight || 800;
  return pixels;
}

/** One toolbar step in percentage points (not ×1.1 of current zoom). */
export function stepZoomPercent(currentPercent, direction) {
  const current = Math.round(currentPercent);
  let next;
  if (direction > 0) {
    next = ZOOM_PRESETS.find((v) => v > current) ?? current + 25;
  } else {
    next = [...ZOOM_PRESETS].reverse().find((v) => v < current) ?? Math.max(25, current - 25);
  }
  return Math.min(500, Math.max(25, next));
}

export function applyWheelZoomScale(currentScale, deltaY, deltaMode = 0, pageHeight = 800) {
  const pixels = wheelDeltaPixels(deltaY, deltaMode, pageHeight);
  if (!pixels) return currentScale;
  const clamped = (scale) => Math.min(5, Math.max(0.25, scale));
  if (Math.abs(pixels) >= WHEEL_COARSE_PX) {
    const next = stepZoomPercent(currentScale * 100, pixels > 0 ? -1 : 1);
    return clamped(next / 100);
  }
  const capped = Math.max(-WHEEL_FINE_PX_CAP, Math.min(WHEEL_FINE_PX_CAP, pixels));
  return clamped(currentScale * Math.exp(-capped / 100));
}

export class PdfViewer {
  constructor({ pagesEl, wrapEl, history, onState, onZoomPreview, onPinchCommit, onScrollPosition, onIndex, onPassword, onRenderPhase }) {
    this.pagesEl = pagesEl;
    this.wrapEl = wrapEl;
    this.history = history;
    this.onState = onState;
    this.onZoomPreview = onZoomPreview;
    this.onPinchCommit = onPinchCommit;
    this.onScrollPosition = onScrollPosition;
    this.onIndex = onIndex;
    this.onPassword = onPassword;
    this.onRenderPhase = onRenderPhase;
    this.renderedPages = new Map();
    this.maxCachedPages = 8;
    this.indexedPages = 0;
    this.indexError = null;
    this.pdf = null;
    this.pageCount = 0;
    this.currentPage = 1;
    /**
     * Where a smooth page jump is heading, while it is on its way.
     *
     * `goToPage` names the destination immediately, but the frames in between
     * are still over the page it came from, and the scroll handler would report
     * those — the readout went 25 → 26 → 25 → 26 for one press of the chevron.
     * While this is set, the scroll handler leaves the readout alone.
     */
    this.pendingPage = null;
    this.pendingTimer = null;
    this.scrollFrame = 0;
    this.scrollSettleTimer = 0;
    this.zoomMode = "page-fit";
    this.zoom = 1;
    this.baseWidth = 612;
    this.baseHeight = 792;
    this.pageSizes = [];
    this.pageEls = [];
    this.tasks = new Map();
    this.pageTexts = [];
    this.textContents = new Map();
    this.hits = [];
    this.hitIndex = -1;
    this.query = "";
    this.applyingHistory = false;
    this.observer = null;
    this.indexPromise = null;
    this.name = "";
    this.sourceBytes = 0;
    this.sourceLocation = "";
    this.generation = 0;
    this.loadingTask = null;
    this.renderJobs = new Map();
    this.renderQueue = [];
    this.activeRenderJobs = new Set();
    this.pageRenderLocks = new Map();
    this.maxConcurrentRenders = 2;
    this.priorityPage = null;
    this.activePageRenders = 0;
    this.zoomAnimations = new Map();
    this.textLayers = new Map();
    this.textMappings = new Map();
    this.highlightLayerCache = new Map();
    this.visiblePages = new Set();
    this.highlightedPages = new Set();
    this.hitGeneration = 0;
    this.navigationGeneration = 0;
    if (globalThis.__PDF_BENCH__) {
      this.bench = {
        renderPageCalls: 0,
        renderVisibleCalls: 0,
        observerRenderCalls: 0,
        renderTaskCancels: 0,
        trimEvictions: 0,
        renderJobsPeak: 0,
        activePageRendersPeak: 0,
        canvasPeak: 0,
        textLayerPeak: 0,
      };
      const origRenderVisible = this.renderVisible.bind(this);
      this.renderVisible = async (...args) => {
        this.bench.renderVisibleCalls += 1;
        return origRenderVisible(...args);
      };
      const origTrim = this.trimCache.bind(this);
      this.trimCache = () => {
        const before = this.renderedPages.size;
        origTrim();
        this.bench.trimEvictions += Math.max(0, before - this.renderedPages.size);
      };
    }
  }

  getState() {
    return {
      page: this.currentPage,
      zoom: this.zoomMode,
      scrollTop: this.wrapEl.scrollTop,
      scrollLeft: this.wrapEl.scrollLeft,
      anchor: this.captureScrollAnchor(),
    };
  }

  notify() {
    this.onState?.(this.getState());
  }

  reportRenderPhase(phase, started, syncMs) {
    try {
      this.onRenderPhase?.({ phase, startedAt: started, ms: performance.now() - started, syncMs });
    } catch { /* diagnostics must not interrupt document rendering */ }
  }

  // Page boxes remain in document order, so locating the reading point needs
  // logarithmic layout reads even in a manual with hundreds of pages.
  pageIndexAtOffset(offset) {
    let low = 0;
    let high = this.pageEls.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.pageEls[middle].offsetTop <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }

  /** Viewport reading point in PDF user space, aligned with dest jumps. */
  getReadingPoint() {
    const pageCount = this.pageCount || this.pageEls.length;
    const fallbackPage = Math.min(Math.max(1, this.currentPage || 1), pageCount || 1);
    if (!this.pageEls.length) return { page: fallbackPage, pdfY: NaN };
    const probe = (this.wrapEl?.scrollTop || 0) + DEST_SCROLL_OFFSET;
    const index = this.pageIndexAtOffset(probe);
    const el = this.pageEls[index];
    const page = Number(el.dataset.pageNumber) || 1;
    const layout = this.pageLayout(page);
    const zoom = this.zoom || 1;
    const cssX = this.wrapEl.scrollLeft + this.wrapEl.clientWidth / 2 - (el?.offsetLeft || 0);
    const cssY = probe - (el?.offsetTop || 0);
    const [, pdfY] = convertCssToPdfPoint(layout, zoom, cssX, cssY);
    if (!Number.isFinite(pdfY)) {
      const { height } = layout;
      return { page, pdfY: height > 0 && zoom > 0 ? height - cssY / zoom : NaN };
    }
    return { page, pdfY };
  }

  captureScrollAnchor() {
    const point = this.getReadingPoint();
    const el = this.pageEls[point.page - 1];
    if (!el) {
      return {
        page: point.page,
        scrollTop: this.wrapEl.scrollTop,
        scrollLeft: this.wrapEl.scrollLeft,
      };
    }
    const probe = this.wrapEl.scrollTop + DEST_SCROLL_OFFSET;
    const cssX = this.wrapEl.scrollLeft + this.wrapEl.clientWidth / 2 - el.offsetLeft;
    const cssY = probe - el.offsetTop;
    const layout = this.pageLayout(point.page);
    const zoom = this.zoom || 1;
    const [pdfX, pdfY] = convertCssToPdfPoint(layout, zoom, cssX, cssY);
    return {
      page: point.page,
      pdfX,
      pdfY,
      scrollTop: this.wrapEl.scrollTop,
      scrollLeft: this.wrapEl.scrollLeft,
    };
  }

  restoreScrollAnchor(anchor) {
    if (!anchor) return;
    const el = this.pageEls[anchor.page - 1];
    if (!el) {
      this.wrapEl.scrollTo({
        top: anchor.scrollTop ?? 0,
        left: anchor.scrollLeft ?? 0,
        behavior: "auto",
      });
      return;
    }
    const layout = this.pageLayout(anchor.page);
    const zoom = this.zoom || 1;
    if (Number.isFinite(anchor.pdfX) && Number.isFinite(anchor.pdfY) && layout?.viewBox) {
      const [cssX, cssY] = convertPdfToCssPoint(layout, zoom, anchor.pdfX, anchor.pdfY);
      this.wrapEl.scrollTop = Math.max(0, el.offsetTop + cssY - DEST_SCROLL_OFFSET);
      this.wrapEl.scrollLeft = Math.max(0, el.offsetLeft + cssX - this.wrapEl.clientWidth / 2);
      return;
    }
    this.wrapEl.scrollTop = anchor.scrollTop ?? 0;
    this.wrapEl.scrollLeft = anchor.scrollLeft ?? 0;
  }

  async open(source, { onProgress } = {}) {
    this.close();
    const generation = this.generation;
    this.name = source.name || t("document");
    this.sourceBytes = Number(source.size) || source.data?.byteLength || 0;
    const sourceUrl = String(source.url || "");
    this.sourceLocation = source.path || (/^https?:/i.test(sourceUrl) ? sourceUrl : "");
    this.notify();
    try {
      const loading = getDocument({
        url: source.url,
        data: source.data,
        withCredentials: source.withCredentials === true,
        isEvalSupported: false,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: FONT_URL,
        wasmUrl: WASM_URL,
        iccUrl: ICC_URL,
        disableAutoFetch: true,
        disableStream: true,
      });
      loading.onPassword = (updatePassword, reason) => this.promptPassword(updatePassword, reason);
      let documentLoaded = false;
      loading.onProgress = ({ loaded, total }) => {
        if (generation === this.generation && !documentLoaded) onProgress?.({ loaded, total });
      };
      this.loadingTask = loading;
      const pdf = await loading.promise;
      if (generation !== this.generation) return null;
      documentLoaded = true;
      // Parsing is one opaque pdf.js step, so it stays indeterminate; from here
      // on every step is countable and the bar becomes a 0-100 countdown.
      onProgress?.({ phase: "prepare" });
      this.pdf = pdf;
      this.pageCount = pdf.numPages;
      await this.loadFirstPageSize(pdf, generation);
      if (generation !== this.generation) return null;
      await this.buildPlaceholders(
        (done, total) => onProgress?.({ phase: "prepare", loaded: done, total }),
        () => generation === this.generation,
      );
      if (generation !== this.generation) return null;
      this.setZoom(this.zoomMode, { silent: true });
      this.history.reset(this.getState());
      this.observe();
      this.wrapEl.addEventListener("scroll", this.onScroll, { passive: true });
      this.prefetchPageSizes(pdf, generation);
      this.indexPromise = this.indexText();
      // Search still receives the rejection; background indexing has a handler too.
      this.indexPromise.catch((error) => {
        if (generation === this.generation) console.error("PDF indexing failed", error);
      });
      this.notify();
      onProgress?.({ phase: "done" });
      return this;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.close();
      throw error;
    }
  }

  close() {
    this.cancelZoomAnimations();
    this.cancelPinch();
    this.generation += 1;
    this.priorityPage = null;
    this.hitGeneration += 1;
    this.navigationGeneration += 1;
    clearTimeout(this.zoomTimer);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = 0;
    this.wrapEl.removeEventListener("scroll", this.onScroll);
    this.observer?.disconnect();
    for (const task of this.tasks.values()) task.cancel();
    for (const job of this.renderQueue) {
      job.cancelled = true;
      job.resolve();
    }
    this.renderQueue.length = 0;
    for (const job of this.activeRenderJobs) {
      job.cancelled = true;
      this.tasks.get(job.pageNumber)?.cancel();
      this.textLayers.get(job.pageNumber)?.cancel();
      if (!this.tasks.has(job.pageNumber)) {
        this.activeRenderJobs.delete(job);
        if (this.pageRenderLocks.get(job.pageNumber) === job) this.pageRenderLocks.delete(job.pageNumber);
      }
    }
    this.pageRenderLocks.clear();
    for (const layer of this.textLayers.values()) layer.cancel();
    this.tasks.clear();
    this.textLayers.clear();
    this.textMappings.clear();
    this.highlightLayerCache.clear();
    this.renderJobs.clear();
    this.renderedPages.clear();
    this.visiblePages.clear();
    this.highlightedPages.clear();
    clearTimeout(this.scrollTimer);
    this.indexedPages = 0;
    this.indexError = null;
    const resource = this.loadingTask || this.pdf;
    this.loadingTask = null;
    if (resource) {
      Promise.resolve().then(() => resource.destroy()).catch((error) => {
        console.error("PDF cleanup failed", error);
      });
    }
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.pageTexts = [];
    this.textContents.clear();
    this.hits = [];
    this.hitIndex = -1;
    this.query = "";
    this.pdf = null;
    this.indexPromise = null;
    this.currentPage = 1;
    this.pageCount = 0;
    this.name = "";
    this.sourceBytes = 0;
    this.sourceLocation = "";
    this.pageSizes = [];
    this.wrapEl.scrollTo({ top: 0, left: 0, behavior: "auto" });
    this.history.reset(this.getState());
    this.notify();
  }

  async loadFirstPageSize(pdf, generation) {
    this.pageSizes = new Array(pdf.numPages);
    const page = await pdf.getPage(1);
    if (generation !== this.generation) return;
    const base = page.getViewport({ scale: 1 });
    this.pageSizes[0] = {
      width: base.width,
      height: base.height,
      viewBox: base.viewBox,
      rotation: base.rotation,
      userUnit: base.userUnit,
    };
    this.baseWidth = base.width;
    this.baseHeight = base.height;
    if (!this.renderJobs.has(1) && !this.renderedPages.has(1)) page.cleanup?.();
  }

  prefetchPageSizes(pdf, generation) {
    if (pdf.numPages <= 1) return;
    (async () => {
      for (let i = 2; i <= pdf.numPages; i += 1) {
        if (generation !== this.generation) return;
        const page = await pdf.getPage(i);
        if (generation !== this.generation) return;
        const base = page.getViewport({ scale: 1 });
        this.setPageSize(i - 1, {
          width: base.width,
          height: base.height,
          viewBox: base.viewBox,
          rotation: base.rotation,
          userUnit: base.userUnit,
        });
        if (!this.renderJobs.has(i) && !this.renderedPages.has(i)) page.cleanup?.();
        if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })().catch((error) => {
      if (generation === this.generation) console.error("PDF page layout prefetch failed", error);
    });
  }

  setPageSize(pageIndex, size) {
    const el = this.pageEls[pageIndex];
    const previous = this.pageSizes[pageIndex];
    const zoom = this.zoom;
    const oldHeight = el?.offsetHeight || (previous ? previous.height * zoom : this.baseHeight * zoom);
    const pageTop = el?.offsetTop ?? 0;
    const scrollTop = this.wrapEl.scrollTop;
    this.pageSizes[pageIndex] = size;
    if (!el) return;
    const newHeight = size.height * zoom;
    el.style.width = `${size.width * zoom}px`;
    el.style.height = `${newHeight}px`;
    delete el.dataset.renderedZoom;
    const delta = newHeight - oldHeight;
    if (delta !== 0 && scrollTop > pageTop) {
      this.wrapEl.scrollTop = scrollTop + delta;
      if (!this.applyingHistory) this.history.commit(this.getState());
    }
  }

  pageLayout(pageNumber) {
    const size = this.pageSizes[pageNumber - 1];
    return size || { width: this.baseWidth, height: this.baseHeight };
  }

  applyPageLayout() {
    for (let i = 0; i < this.pageEls.length; i += 1) {
      const el = this.pageEls[i];
      const { width, height } = this.pageLayout(i + 1);
      el.style.width = `${width * this.zoom}px`;
      el.style.height = `${height * this.zoom}px`;
      el.style.setProperty("--scale-factor", String(this.zoom));
    }
  }

  /**
   * One placeholder per page, a chunk at a time.
   *
   * `onStep(done, total)` runs once per chunk so the opening bar has a real
   * number to count: on a 779-page file this is the only per-page work the
   * reader waits for, and doing it in one go made every open a single frozen
   * frame («正在解析版面…» was all the bar could ever say). `stillValid` lets a
   * `close()` in the middle of the chunks stop the loop.
   */
  async buildPlaceholders(onStep, stillValid) {
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    const total = this.pageCount;
    const chunk = 96;
    for (let i = 1; i <= total; i += 1) {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.pageNumber = String(i);
      el.innerHTML =
        '<canvas></canvas><div class="textLayer"></div><div class="linkLayer"></div><div class="hlLayer"></div>';
      this.pagesEl.appendChild(el);
      this.pageEls.push(el);
      if (i % chunk === 0 && i < total) {
        onStep?.(i, total);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (stillValid !== undefined && !stillValid()) return;
      }
    }
    this.applyPageLayout();
    onStep?.(total, total);
  }

  async promptPassword(updatePassword, reason) {
    if (!this.onPassword) {
      updatePassword(new Error(t("pdfPasswordNeeded")));
      return;
    }
    try {
      const password = await this.onPassword(reason);
      updatePassword(password);
    } catch (error) {
      updatePassword(error instanceof Error ? error : new Error(String(error)));
    }
  }

  computeZoom() {
    const pad = 48;
    const { width, height } = this.pageLayout(this.currentPage);
    if (this.zoomMode === "page-width") {
      return Math.max(0.25, (this.wrapEl.clientWidth - pad) / width);
    }
    if (this.zoomMode === "page-fit") {
      const sx = (this.wrapEl.clientWidth - pad) / width;
      const sy = (this.wrapEl.clientHeight - pad) / height;
      return Math.max(0.25, Math.min(sx, sy));
    }
    const n = Number(this.zoomMode);
    return Number.isFinite(n) ? Math.min(5, Math.max(0.25, n / 100)) : 1.5;
  }

  cancelZoomAnimations() {
    for (const animation of this.zoomAnimations.values()) animation.cancel();
    this.zoomAnimations.clear();
  }

  visiblePageRects() {
    const wrap = this.wrapEl.getBoundingClientRect();
    const rects = new Map();
    for (const page of this.pageEls) {
      const rect = page.getBoundingClientRect();
      if (rect.right > wrap.left && rect.left < wrap.right && rect.bottom > wrap.top && rect.top < wrap.bottom) {
        rects.set(page, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
    }
    return rects;
  }

  animateZoomRects(previousRects) {
    if (!previousRects?.size || typeof this.pageEls[0]?.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    for (const page of this.pageEls) {
      const previous = previousRects.get(page);
      if (!previous) continue;
      const current = page.getBoundingClientRect();
      if (!current.width || !current.height) continue;
      const dx = previous.left - current.left;
      const dy = previous.top - current.top;
      const sx = previous.width / current.width;
      const sy = previous.height / current.height;
      const animation = page.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: "0 0" },
        { transform: "none", transformOrigin: "0 0" },
      ], { duration: 170, easing: "ease-out" });
      this.zoomAnimations.set(page, animation);
      animation.finished.then(() => {
        if (this.zoomAnimations.get(page) === animation) this.zoomAnimations.delete(page);
      }).catch(() => {});
    }
  }

  setZoom(mode, { silent = false, keepPage = true } = {}) {
    this.cancelZoomAnimations();
    this.cancelPinch();
    const anchor = keepPage ? this.captureScrollAnchor() : null;
    this.zoomMode = String(mode);
    this.zoom = this.computeZoom();
    this.textMappings.clear();
    this.highlightLayerCache.clear();
    this.highlightedPages.clear();
    for (const layer of this.textLayers.values()) layer.hide();
    for (const el of this.pageEls) {
      delete el.dataset.renderedZoom;
      el.querySelector(".hlLayer").replaceChildren();
    }
    this.applyPageLayout();
    if (anchor) this.restoreScrollAnchor(anchor);
    if (!silent) {
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => this.renderVisible(true), 80);
    } else {
      this.renderVisible(true);
    }
    this.notify();
  }

  // Keep the raster and text together on the compositor during zoom gestures.
  // The full layout and raster commit happen once zoom input settles.
  pinchZoom(event) {
    const nativeScale = Number(event.scaleFactor);
    const hasNativeScale = Number.isFinite(nativeScale) && nativeScale > 0;
    if (!this.pdf || !this.pageEls.length || (!hasNativeScale && (!Number.isFinite(event.deltaY) || !event.deltaY))) return;
    if (!this.pinch) {
      this.cancelZoomAnimations();
      const rect = this.wrapEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const contentY = this.wrapEl.scrollTop + y;
      const page = this.pageEls.find(el => el.offsetTop + el.offsetHeight >= contentY)
        || this.pageEls[this.pageEls.length - 1];
      this.pinch = {
        zoom: this.zoom, target: this.zoom, x, y, page,
        pageX: (this.wrapEl.scrollLeft + x - page.offsetLeft) / this.zoom,
        pageY: (contentY - page.offsetTop) / this.zoom,
      };
      clearTimeout(this.zoomTimer);
      for (const job of [...this.activeRenderJobs]) this.cancelRenderJob(job);
      this.pagesEl.style.transformOrigin = `${this.wrapEl.scrollLeft + x}px ${contentY}px`;
      this.pagesEl.style.willChange = "transform";
    }
    if (hasNativeScale) {
      this.pinch.target = Math.min(5, Math.max(0.25, this.pinch.target * nativeScale));
    } else {
      this.pinch.target = applyWheelZoomScale(
        this.pinch.target,
        event.deltaY,
        event.deltaMode,
        this.wrapEl.clientHeight,
      );
    }
    if (!this.pinchFrame) {
      this.pinchFrame = requestAnimationFrame(() => {
        this.pinchFrame = null;
        if (this.pinch) {
          this.pagesEl.style.transform = `scale(${this.pinch.target / this.pinch.zoom})`;
          this.onZoomPreview?.(this.pinch.target * 100);
        }
      });
    }
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => this.finishPinch(), 160);
  }

  cancelPinch() {
    clearTimeout(this.pinchTimer);
    if (this.pinchFrame) cancelAnimationFrame(this.pinchFrame);
    this.pinchFrame = null;
    if (!this.pinch) return;
    this.pinch = null;
    this.pagesEl.style.transform = "";
    this.pagesEl.style.transformOrigin = "";
    this.pagesEl.style.willChange = "";
    this.onZoomPreview?.(this.zoomMode);
  }

  finishPinch() {
    const pinch = this.pinch;
    if (!pinch) return;
    this.cancelPinch();
    this.setZoom(String(pinch.target * 100), { keepPage: false });
    this.wrapEl.scrollLeft = pinch.page.offsetLeft + pinch.pageX * this.zoom - pinch.x;
    this.wrapEl.scrollTop = pinch.page.offsetTop + pinch.pageY * this.zoom - pinch.y;
    this.onPinchCommit?.();
  }

  bumpZoom(delta) {
    const next = stepZoomPercent(this.zoom * 100, delta > 0 ? 1 : -1);
    const canAnimate = this.pdf && this.pageEls.some(page => typeof page.animate === "function")
      && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const previousRects = canAnimate ? this.visiblePageRects() : null;
    this.setZoom(String(next));
    this.animateZoomRects(previousRects);
    return String(next);
  }

  observe() {
    this.observer?.disconnect();
    this.visiblePages.clear();
    this.observer = new IntersectionObserver(
      (entries) => {
        const entering = [];
        for (const entry of entries) {
          const n = Number(entry.target.dataset.pageNumber);
          if (entry.isIntersecting) {
            this.visiblePages.add(n);
            entering.push(n);
          } else {
            this.visiblePages.delete(n);
          }
        }
        entering.sort((a, b) => this.renderPriority(a) - this.renderPriority(b));
        for (const n of entering) {
          if (this.bench) this.bench.observerRenderCalls += 1;
          this.renderPage(n).catch((error) => console.error("PDF rendering failed", error));
        }
      },
      { root: this.wrapEl, rootMargin: `${RENDER_MARGIN_PX}px 0px`, threshold: 0.01 },
    );
    for (const el of this.pageEls) this.observer.observe(el);
  }

  onScroll = () => {
    if (!this.pageEls.length) return;
    clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = setTimeout(() => {
      this.scrollSettleTimer = 0;
      this.renderVisible();
      this.pumpRenderQueue();
    }, SCROLL_SETTLE_MS);
    this.pumpRenderQueue();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.renderVisible();
      this.pumpRenderQueue();
      this.trimCache();
    });
    const top = this.wrapEl.scrollTop + 80;
    let page = Number(this.pageEls[this.pageIndexAtOffset(top)].dataset.pageNumber) || 1;
    // At the end of the scroll range the last page can never satisfy the +80
    // rule: its top is still several pages below the viewport's top edge, so a
    // jump to it reads as the page before it (measured on 200 pages: 200 → 199,
    // stable over 3.8 s, while the frame provably sat at scrollHeight -
    // clientHeight). Being at the bottom means the last page is what the eye
    // sees. The `> 80` guard keeps a document that fits without scrolling from
    // ever landing here.
    const scrollable = this.wrapEl.scrollHeight - this.wrapEl.clientHeight;
    if (scrollable > 80 && this.wrapEl.scrollTop >= scrollable - 2) page = this.pageCount;
    if (this.pendingPage !== null) {
      // The jump named its destination before the first frame moved. Reached
      // it: hand the readout back to the viewport. Not yet: report nothing, or
      // the readout walks backwards through the pages it is leaving.
      if (page === this.pendingPage) {
        this.pendingPage = null;
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
    } else if (page !== this.currentPage) {
      this.currentPage = page;
      this.notify();
    }
    this.onScrollPosition?.();
  };

  async renderVisible(force = false) {
    if (!this.pageEls.length) return;
    const viewTop = this.wrapEl.scrollTop - RENDER_MARGIN_PX;
    const viewBottom = this.wrapEl.scrollTop + this.wrapEl.clientHeight + RENDER_MARGIN_PX;
    const candidates = [];
    const first = Math.max(0, this.pageIndexAtOffset(viewTop) - 1);
    const last = Math.min(this.pageEls.length - 1, this.pageIndexAtOffset(viewBottom) + 1);
    for (let i = first; i <= last; i += 1) {
      const el = this.pageEls[i];
      const top = el.offsetTop;
      if (top + el.offsetHeight >= viewTop && top <= viewBottom) {
        candidates.push(i + 1);
      }
    }
    candidates.sort((a, b) => this.renderPriority(a) - this.renderPriority(b));
    const jobs = candidates.map((pageNumber) => this.renderPage(pageNumber, force));
    await Promise.allSettled(jobs);
  }

  renderPage(pageNumber, force = false) {
    if (this.pinch) return Promise.resolve();
    if (this.bench) this.bench.renderPageCalls += 1;
    const el = this.pageEls[pageNumber - 1];
    const pdf = this.pdf;
    if (!el || !pdf) return Promise.resolve();
    const zoom = this.zoom;
    const key = zoom.toFixed(3);
    if (this.renderedPages.has(pageNumber)) {
      const cached = this.renderedPages.get(pageNumber);
      this.renderedPages.delete(pageNumber);
      this.renderedPages.set(pageNumber, cached);
    }
    const previous = this.renderJobs.get(pageNumber);
    if (previous?.key === key && !previous.cancelled) {
      if (previous.queued) this.pumpRenderQueue();
      return previous.promise;
    }
    if (!force && el.dataset.renderedZoom === key) return Promise.resolve();
    if (previous) this.cancelRenderJob(previous);
    const job = { pageNumber, key, cancelled: false, queued: true, force, resolve: null, reject: null };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.renderJobs.set(pageNumber, job);
    this.renderQueue.push(job);
    if (this.bench) this.bench.renderJobsPeak = Math.max(this.bench.renderJobsPeak, this.renderJobs.size);
    this.pumpRenderQueue();
    return job.promise;
  }

  cancelRenderJob(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    if (job.queued) {
      this.renderQueue = this.renderQueue.filter((queued) => queued !== job);
      job.queued = false;
      if (this.renderJobs.get(job.pageNumber) === job) this.renderJobs.delete(job.pageNumber);
      job.resolve();
    } else {
      this.tasks.get(job.pageNumber)?.cancel();
      this.textLayers.get(job.pageNumber)?.cancel();
    }
  }

  renderPriority(pageNumber) {
    if (pageNumber === this.priorityPage) return -1;
    const el = this.pageEls[pageNumber - 1];
    if (!el) return Number.POSITIVE_INFINITY;
    const top = this.wrapEl.scrollTop;
    const bottom = top + this.wrapEl.clientHeight;
    const pageTop = el.offsetTop;
    const pageBottom = pageTop + el.offsetHeight;
    const center = top + this.wrapEl.clientHeight / 2;
    const pageCenter = pageTop + el.offsetHeight / 2;
    const distance = Math.abs(pageCenter - center) / Math.max(1, this.wrapEl.clientHeight);
    return pageBottom >= top && pageTop <= bottom ? distance : distance + 1;
  }

  pumpRenderQueue() {
    if (this.generation === 0 && this.pdf === null) return;
    if (this.pinch) return;
    // Drop work that became stale while waiting, and cancel active renders that
    // have moved well outside the viewport. The existing bitmap remains visible.
    const top = this.wrapEl.scrollTop;
    const bottom = top + this.wrapEl.clientHeight;
    const wanted = (pageNumber) => {
      if (pageNumber === this.priorityPage) return true;
      const el = this.pageEls[pageNumber - 1];
      return el !== undefined
        && el.offsetTop + el.offsetHeight >= top - RENDER_MARGIN_PX
        && el.offsetTop <= bottom + RENDER_MARGIN_PX;
    };
    for (const job of [...this.renderQueue]) {
      if (!wanted(job.pageNumber)) this.cancelRenderJob(job);
    }
    for (const job of this.activeRenderJobs) {
      if (!wanted(job.pageNumber)) this.cancelRenderJob(job);
    }
    this.renderQueue.sort((a, b) => this.renderPriority(a.pageNumber) - this.renderPriority(b.pageNumber));
    while (this.activeRenderJobs.size < this.maxConcurrentRenders && this.renderQueue.length > 0) {
      const eligible = this.renderQueue.findIndex((job) => !this.pageRenderLocks.has(job.pageNumber));
      if (eligible < 0) break;
      const [job] = this.renderQueue.splice(eligible, 1);
      if (job.cancelled || this.renderJobs.get(job.pageNumber) !== job) continue;
      job.queued = false;
      this.activeRenderJobs.add(job);
      this.pageRenderLocks.set(job.pageNumber, job);
      this.renderPageNow(job.pageNumber, job.force, job).then(job.resolve, job.reject).finally(() => {
        this.activeRenderJobs.delete(job);
        if (this.pageRenderLocks.get(job.pageNumber) === job) this.pageRenderLocks.delete(job.pageNumber);
        if (this.renderJobs.get(job.pageNumber) === job) this.renderJobs.delete(job.pageNumber);
        this.trimCache();
        this.pumpRenderQueue();
      });
    }
    if (this.renderQueue.length === 0 && this.activeRenderJobs.size === 0 && this.pageRenderLocks.size !== 0) {
      this.pageRenderLocks.clear();
    }
  }

  renderPageNow(pageNumber, force = false, job) {
    const el = this.pageEls[pageNumber - 1];
    const pdf = this.pdf;
    const zoom = this.zoom;
    const key = job.key;
    const generation = this.generation;
    const current = () => generation === this.generation &&
      this.renderJobs.get(pageNumber) === job && this.zoom === zoom && !this.pinch && !job.cancelled;
    const prevTask = this.tasks.get(pageNumber);
    if (prevTask) {
      if (this.bench) this.bench.renderTaskCancels += 1;
      prevTask.cancel();
    }
    this.textLayers.get(pageNumber)?.cancel();
    this.textMappings.delete(pageNumber);
    this.highlightLayerCache.delete(pageNumber);
    this.renderJobs.set(pageNumber, job);
    if (this.bench) this.bench.renderJobsPeak = Math.max(this.bench.renderJobsPeak, this.renderJobs.size);
    return (async () => {
      try {
        if (!current()) return;
        const page = await pdf.getPage(pageNumber);
        if (!current()) return;
        const cssViewport = page.getViewport({ scale: zoom });
        const outputScale = Math.min(window.devicePixelRatio || 1,
          Math.sqrt(8_000_000 / (cssViewport.width * cssViewport.height)),
          4096 / cssViewport.width, 4096 / cssViewport.height);
        const viewport = page.getViewport({ scale: zoom * outputScale });
        el.style.width = `${cssViewport.width}px`;
        el.style.height = `${cssViewport.height}px`;
        const previousCanvas = el.querySelector("canvas");
        const reuseBitmap = !force && previousCanvas?.width > 0 && previousCanvas.dataset.bitmapZoom === key;
        let canvas = previousCanvas;
        if (!reuseBitmap) {
          canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { alpha: false });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const canvasStarted = performance.now();
          const task = page.render({ canvasContext: ctx, canvas, viewport, intent: "display" });
          const canvasSyncMs = performance.now() - canvasStarted;
          this.tasks.set(pageNumber, task);
          this.activePageRenders += 1;
          if (this.bench) {
            this.bench.activePageRendersPeak = Math.max(this.bench.activePageRendersPeak, this.activePageRenders);
          }
          try {
            await task.promise;
          } finally {
            this.activePageRenders = Math.max(0, this.activePageRenders - 1);
            this.reportRenderPhase("canvas", canvasStarted, canvasSyncMs);
          }
          if (!current()) return;
          canvas.dataset.bitmapZoom = key;
          // Keep the scaled old bitmap visible until its replacement is complete.
          previousCanvas.replaceWith(canvas);
        }
        this.renderedPages.delete(pageNumber);
        this.renderedPages.set(pageNumber, page);
        if (this.diagnosticCanvasOnly === true) {
          el.dataset.renderedZoom = job.key;
          return;
        }
        if (!current()) return;
        let mapping;
        const textLayerStarted = performance.now();
        const textLayer = new TextLayerBuilder({
          pdfPage: page,
          highlighter: {
            setTextMapping(textDivs, textContentItemsStr) {
              mapping = { textDivs, textContentItemsStr };
            },
            enable() {},
            disable() {},
          },
        });
        const container = textLayer.div;
        container.style.setProperty("--scale-factor", String(cssViewport.scale));
        setLayerDimensions(container, cssViewport);
        const textLayerPromise = textLayer.render({ viewport: cssViewport });
        const textLayerSyncMs = performance.now() - textLayerStarted;
        try { await textLayerPromise; }
        finally { this.reportRenderPhase("textLayer", textLayerStarted, textLayerSyncMs); }
        if (!current()) return;
        el.querySelector(".textLayer").replaceWith(container);
        this.textLayers.set(pageNumber, textLayer);
        const mappingStarted = performance.now();
        this.textMappings.set(pageNumber, buildTextMapping(mapping.textDivs, mapping.textContentItemsStr));
        this.reportRenderPhase("textMapping", mappingStarted, performance.now() - mappingStarted);
        const linksStarted = performance.now();
        const linksPromise = this.renderLinks(page, cssViewport, el.querySelector(".linkLayer"), current);
        const linksSyncMs = performance.now() - linksStarted;
        try { await linksPromise; }
        finally { this.reportRenderPhase("links", linksStarted, linksSyncMs); }
        if (!current()) return;
        const highlightsStarted = performance.now();
        const highlightsPromise = this.paintHighlights(pageNumber);
        const highlightsSyncMs = performance.now() - highlightsStarted;
        try { await highlightsPromise; }
        finally { this.reportRenderPhase("highlights", highlightsStarted, highlightsSyncMs); }
        if (current()) {
          el.dataset.renderedZoom = job.key;
          this.renderedPages.delete(pageNumber);
          this.renderedPages.set(pageNumber, page);
          if (this.bench) {
            this.bench.canvasPeak = Math.max(this.bench.canvasPeak, this.renderedPages.size);
            this.bench.textLayerPeak = Math.max(this.bench.textLayerPeak, this.textLayers.size);
          }
        }
      } catch (error) {
        if (current() && error?.name !== "RenderingCancelledException" && error?.name !== "AbortException") {
          delete el.dataset.renderedZoom;
          throw error;
        }
      } finally {
        if (this.renderJobs.get(pageNumber) === job) {
          this.renderJobs.delete(pageNumber);
          this.tasks.delete(pageNumber);
          this.trimCache();
        }
      }
    })();
  }

  trimCache() {
    if (this.renderedPages.size <= this.maxCachedPages) return;
    const top = this.wrapEl.scrollTop, bottom = top + this.wrapEl.clientHeight;
    for (const [number, page] of this.renderedPages) {
      if (this.renderedPages.size <= this.maxCachedPages) break;
      const el = this.pageEls[number - 1];
      if (!el || this.renderJobs.has(number)) continue;
      if (el.offsetTop + el.offsetHeight >= top && el.offsetTop <= bottom) continue;
      this.textLayers.get(number)?.cancel();
      this.textLayers.delete(number);
      this.textMappings.delete(number);
      this.highlightLayerCache.delete(number);
      this.highlightedPages.delete(number);
      const canvas = el.querySelector("canvas");
      canvas.width = canvas.height = 0;
      for (const selector of [".textLayer", ".linkLayer", ".hlLayer"]) el.querySelector(selector).replaceChildren();
      delete el.dataset.renderedZoom;
      this.textContents.delete(number);
      this.renderedPages.delete(number);
      page.cleanup?.();
    }
  }

  async renderLinks(page, viewport, layer, current = () => true) {
    const annotations = await page.getAnnotations();
    if (!current()) return;
    layer.replaceChildren();
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;
      const rect = viewportRect(viewport, annotation.rect);
      const left = Math.min(rect[0], rect[2]);
      const top = Math.min(rect[1], rect[3]);
      const width = Math.abs(rect[2] - rect[0]);
      const height = Math.abs(rect[3] - rect[1]);
      const a = document.createElement("a");
      a.href = annotation.url || "#";
      const action = annotation.action || "";
      const namedAction = ["NextPage", "PrevPage", "FirstPage", "LastPage", "GoBack", "GoForward"].includes(action)
        ? action
        : "";
      a.title = annotation.url || t("jump");
      a.style.left = `${left}px`;
      a.style.top = `${top}px`;
      a.style.width = `${width}px`;
      a.style.height = `${height}px`;
      a.addEventListener("click", (event) => {
        event.preventDefault();
        if (annotation.url) {
          window.open(annotation.url, "_blank", "noopener,noreferrer");
          return;
        }
        if (annotation.dest) this.goToDest(annotation.dest, true);
        else if (namedAction === "NextPage") this.goToPage(this.currentPage + 1, { push: true, instant: true });
        else if (namedAction === "PrevPage") this.goToPage(this.currentPage - 1, { push: true, instant: true });
        else if (namedAction === "FirstPage") this.goToPage(1, { push: true, instant: true });
        else if (namedAction === "LastPage") this.goToPage(this.pageCount, { push: true, instant: true });
        else if (namedAction === "GoBack") this.back();
        else if (namedAction === "GoForward") this.forward();
      });
      layer.appendChild(a);
    }
  }

  async goToDest(dest, push = false) {
    if (!this.pdf || dest == null) return;
    const pdf = this.pdf;
    const generation = this.generation;
    const navigation = ++this.navigationGeneration;
    const current = () => generation === this.generation && navigation === this.navigationGeneration;
    try {
      let explicit = dest;
      if (typeof dest === "string") explicit = await pdf.getDestination(dest);
      if (!explicit || !current()) return;
      const ref = explicit[0];
      const pageIndex = typeof ref === "object" ? await pdf.getPageIndex(ref) : Number(ref);
      if (!current()) return;
      const pageNumber = pageIndex + 1;
      const type = destTypeName(explicit[1]);
      let left = null;
      let top = null;
      if (type === "XYZ") {
        const [, , rawLeft, rawTop, rawZoom] = explicit;
        const zoomChange = rawZoom != null && Number.isFinite(rawZoom) && rawZoom > 0;
        if (push && zoomChange) this.history.commit(this.getState());
        if (zoomChange) {
          this.setZoom(String(Math.min(500, Math.max(25, Math.round(rawZoom * 100)))), {
            keepPage: false,
            silent: true,
          });
        }
        if (!current()) return;
        const page = await pdf.getPage(pageNumber);
        if (!current()) return;
        const viewport = page.getViewport({ scale: this.zoom });
        if (rawLeft != null && Number.isFinite(rawLeft)) {
          [left] = viewport.convertToViewportPoint(rawLeft, rawTop ?? 0);
        }
        if (rawTop != null && Number.isFinite(rawTop)) {
          [, top] = viewport.convertToViewportPoint(rawLeft ?? 0, rawTop);
        }
        if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        if (current()) {
          this.goToPage(pageNumber, { push: push && !zoomChange, instant: true, left, top });
          if (push && zoomChange) this.history.push(this.getState());
        }
        return;
      } else if (type === "FitH" || type === "FitBH") {
        const y = explicit[2];
        if (y != null && Number.isFinite(y)) {
          const page = await pdf.getPage(pageNumber);
          if (!current()) return;
          [, top] = page.getViewport({ scale: this.zoom }).convertToViewportPoint(0, y);
          if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        }
      } else if (type === "FitV" || type === "FitBV") {
        const x = explicit[2];
        if (x != null && Number.isFinite(x)) {
          const page = await pdf.getPage(pageNumber);
          if (!current()) return;
          [left] = page.getViewport({ scale: this.zoom }).convertToViewportPoint(x, 0);
          if (!this.renderJobs.has(pageNumber) && !this.renderedPages.has(pageNumber)) page.cleanup?.();
        }
      }
      if (current()) this.goToPage(pageNumber, { push, instant: true, left, top });
    } catch (error) {
      if (current()) console.error("PDF destination failed", error);
    }
  }

  async getOutline() {
    return this.pdf ? this.pdf.getOutline() : null;
  }

  /**
   * Where one outline entry points, in the words the reading point speaks.
   *
   * The sidebar highlights the entry the viewport is currently under, which
   * needs each entry's page and its Y in PDF user space — the same pair
   * `getReadingPoint()` answers for the viewport itself.
   * @param dest - a pdf.js dest array, or a name to resolve first.
   * @returns promise of `{page, pdfY}`, or null when the entry names nothing.
   */
  async destPoint(dest) {
    const pdf = this.pdf;
    if (!pdf || dest == null) return null;
    try {
      const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!explicit || pdf !== this.pdf) return null;
      const ref = explicit[0];
      const pageIndex = typeof ref === "object" ? await pdf.getPageIndex(ref) : Number(ref);
      if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;
      return { page: pageIndex + 1, pdfY: destPdfY(explicit) };
    } catch {
      return null;
    }
  }

  async getDocumentInfo() {
    if (!this.pdf) return null;
    let meta = {};
    try {
      meta = await this.pdf.getMetadata() || {};
    } catch {
      meta = {};
    }
    const size = this.pageLayout(1);
    const contentLength = Number(meta.contentLength);
    return {
      fileName: this.name,
      fileSize: contentLength > 0 ? contentLength : this.sourceBytes,
      location: this.sourceLocation,
      pageCount: this.pageCount,
      pageWidth: size.width,
      pageHeight: size.height,
      info: meta.info && typeof meta.info === "object" ? meta.info : {},
    };
  }

  async getPageImage(pageNumber, signal) {
    signal?.throwIfAborted();
    const pdf = this.pdf;
    const generation = this.generation;
    if (!pdf || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) throw new Error("Invalid PDF page");
    const page = await pdf.getPage(pageNumber);
    signal?.throwIfAborted();
    if (pdf !== this.pdf || generation !== this.generation) throw new Error("Document changed");
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.5, 1400 / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "white" });
    const cancel = () => task.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) task.cancel();
      await task.promise;
      signal?.throwIfAborted();
      if (pdf !== this.pdf || generation !== this.generation) throw new Error("Document changed");
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      signal?.removeEventListener("abort", cancel);
      canvas.width = canvas.height = 0;
    }
  }

  goToPage(pageNumber, { push = false, instant = false, left = null, top = null } = {}) {
    if (!this.pageCount || !Number.isFinite(pageNumber)) return;
    this.navigationGeneration += 1;
    const n = Math.min(this.pageCount, Math.max(1, Math.trunc(pageNumber)));
    if (push) this.history.commit(this.getState());
    this.currentPage = n;
    // History must capture the completed destination, not a smooth-scroll frame.
    this.scrollToPage(n, { instant: instant || push, left, top });
    if (push) this.history.push(this.getState());
    this.notify();
  }

  scrollToPage(pageNumber, { instant = false, left = null, top = null } = {}) {
    const el = this.pageEls[pageNumber - 1];
    if (!el) return;
    let scrollTop = el.offsetTop - 16;
    let scrollLeft = this.wrapEl.scrollLeft;
    if (top != null && Number.isFinite(top)) {
      scrollTop = Math.max(0, el.offsetTop + top - DEST_SCROLL_OFFSET);
    }
    if (left != null && Number.isFinite(left)) {
      scrollLeft = Math.max(0, el.offsetLeft + left - 32);
    }
    // A smooth scroll announces its destination here, so the readout does not
    // have to be rebuilt from the frames on the way. An instant one has no
    // frames to survive, and needs no promise kept.
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (instant) {
      this.pendingPage = null;
    } else {
      this.pendingPage = pageNumber;
      // A smooth scroll can be cancelled — a wheel, a resize, a hidden tab — and
      // then the destination is never reached; the readout goes back to
      // following the viewport after a second rather than staying wrong.
      this.pendingTimer = setTimeout(() => {
        this.pendingPage = null;
        this.pendingTimer = null;
      }, 1000);
    }
    this.wrapEl.scrollTo({
      top: scrollTop,
      left: scrollLeft,
      behavior: instant ? "auto" : "smooth",
    });
  }

  restore(state) {
    if (!state) return;
    this.applyReadingPosition(state, { fromHistory: true });
  }

  /**
   * Scroll to an absolute offset, retrying while the page boxes are unsized.
   *
   * `open()` resolves before every page has reported its size, so a restore that
   * runs right after it lands on a scroll range of a few hundred pixels: the
   * browser clamps the target and the position is lost without an error. Nudge
   * again each frame until the range is long enough (or half a second passes).
   * @param top - wanted vertical offset.
   * @param left - wanted horizontal offset.
   */
  scrollToOffset(top, left) {
    const wrap = this.wrapEl;
    if (!wrap) return;
    const target = Math.max(0, Number(top) || 0);
    const side = Math.max(0, Number(left) || 0);
    const apply = () => wrap.scrollTo({ top: target, left: side, behavior: "auto" });
    apply();
    const generation = this.generation;
    let frames = 12;
    const settle = () => {
      frames -= 1;
      if (frames <= 0 || this.generation !== generation || wrap !== this.wrapEl) return;
      const room = wrap.scrollHeight - wrap.clientHeight;
      if (room >= target) {
        // The layout has caught up; correct the clamped offset once and stop, so
        // a reader who scrolls right after opening is never fought.
        if (Math.abs(wrap.scrollTop - target) > 2) apply();
        return;
      }
      apply();
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  applyReadingPosition(state, { fromHistory = false } = {}) {
    if (!state) return;
    if (fromHistory) this.applyingHistory = true;
    if (String(state.zoom) !== String(this.zoomMode)) {
      this.setZoom(state.zoom, { keepPage: false });
    }
    if (state.page) this.currentPage = state.page;
    if (state.anchor) {
      this.restoreScrollAnchor(state.anchor);
    } else {
      this.scrollToOffset(state.scrollTop ?? 0, state.scrollLeft ?? 0);
    }
    this.notify();
    requestAnimationFrame(() => {
      if (fromHistory) this.applyingHistory = false;
      this.renderVisible(true).catch((error) => console.error("PDF rendering failed", error));
    });
  }

  back() {
    this.navigationGeneration += 1;
    if (!this.history.canBack()) return;
    this.history.commit(this.getState());
    this.restore(this.history.back());
  }

  forward() {
    this.navigationGeneration += 1;
    if (!this.history.canForward()) return;
    this.history.commit(this.getState());
    this.restore(this.history.forward());
  }

  async indexText() {
    const pdf = this.pdf;
    const generation = this.generation;
    const pages = [];
    if (!pdf) return pages;
    this.pageTexts = pages;
    try {
      for (let i = 1; i <= pdf.numPages; i += 1) {
        if (generation !== this.generation) return [];
        const page = await pdf.getPage(i);
        if (generation !== this.generation) return [];
        const textContent = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        if (generation !== this.generation) return [];
        pages.push({
          pageNumber: i,
          ...buildTextIndex(textContent),
        });
        this.indexedPages = i;
        if (!this.renderJobs.has(i) && !this.renderedPages.has(i)) page.cleanup?.();
        if (i === 1 || i % 10 === 0 || i === pdf.numPages) this.onIndex?.();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (generation !== this.generation) return [];
      this.pageTexts = pages;
      return pages;
    } catch (error) {
      if (generation !== this.generation) return [];
      this.indexError = error;
      this.onIndex?.();
      throw error;
    }
  }

  highlightCount(layer) {
    if (!layer) return 0;
    if (typeof layer.childElementCount === "number") return layer.childElementCount;
    return layer.children?.length ?? 0;
  }

  liveHighlightPages(...extra) {
    const pages = new Set();
    for (const n of this.renderedPages.keys()) pages.add(n);
    for (const n of this.visiblePages) pages.add(n);
    for (const n of extra) {
      const page = Number(n);
      if (Number.isInteger(page) && page > 0) pages.add(page);
    }
    return pages;
  }

  refreshLiveHighlights(...extra) {
    for (const n of this.liveHighlightPages(...extra)) this.paintHighlights(n);
  }

  clearRenderedHighlights() {
    this.highlightLayerCache?.clear();
    const pages = this.highlightedPages.size ? [...this.highlightedPages] : [...this.liveHighlightPages()];
    for (const n of pages) {
      const layer = this.pageEls[n - 1]?.querySelector(".hlLayer");
      if (this.highlightCount(layer)) layer.replaceChildren();
    }
    this.highlightedPages.clear();
  }

  clearHits() {
    this.hitGeneration += 1;
    this.navigationGeneration += 1;
    this.hits = [];
    this.query = "";
    this.hitIndex = -1;
    this.clearRenderedHighlights();
  }

  async paintHighlights(pageNumber) {
    const el = this.pageEls[pageNumber - 1];
    if (!el || !this.pdf) return;
    const layer = el.querySelector(".hlLayer");
    if (!this.hits.length || !this.query) {
      if (this.highlightCount(layer)) layer.replaceChildren();
      this.highlightLayerCache?.delete(pageNumber);
      this.highlightedPages.delete(pageNumber);
      return;
    }
    const mapping = this.textMappings.get(pageNumber);
    if (!mapping) return;
    const cached = this.highlightLayerCache.get(pageNumber);
    if (cached && cached.layer === layer && cached.mapping === mapping && cached.hits === this.hits && cached.query === this.query) {
      if (cached.currentIndex !== this.hitIndex) {
        for (const index of [cached.currentIndex, this.hitIndex]) {
          if (index < 0) continue;
          for (const box of cached.boxesByHit.get(index) || []) {
            box.className = `hl${index === this.hitIndex ? " current" : ""}`;
          }
        }
        cached.currentIndex = this.hitIndex;
      }
      return;
    }
    let painted = false;
    const fragment = document.createDocumentFragment();
    const boxesByHit = new Map();
    const rectsByHit = new Map();
    this.hits.forEach((hit, index) => {
      if (hit.pageNumber !== pageNumber) return;
      const rects = matchRects(mapping, layer, hit.offset, hit.length);
      rectsByHit.set(index, rects);
      for (const rect of rects) {
        const box = document.createElement("div");
        box.className = `hl${index === this.hitIndex ? " current" : ""}`;
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        fragment.appendChild(box);
        const boxes = boxesByHit.get(index) || [];
        boxes.push(box);
        boxesByHit.set(index, boxes);
        painted = true;
      }
    });
    layer.replaceChildren(fragment);
    this.highlightLayerCache.set(pageNumber, { layer, mapping, hits: this.hits, query: this.query, boxesByHit, rectsByHit, currentIndex: this.hitIndex });
    if (painted) this.highlightedPages.add(pageNumber);
    else this.highlightedPages.delete(pageNumber);
  }

  async showHits(hits, query, index = 0, { jump = true, historyGroup = null } = {}) {
    // Progressive index refreshes must not cancel in-flight search/outline jumps.
    const generation = jump ? ++this.hitGeneration : this.hitGeneration;
    if (jump) this.navigationGeneration += 1;
    const prevPage = this.hits[this.hitIndex]?.pageNumber;
    this.hits = hits;
    this.query = query;
    this.hitIndex = hits.length ? index : -1;
    if (!hits.length || !query) {
      this.clearRenderedHighlights();
      return;
    }
    this.refreshLiveHighlights(prevPage, hits[this.hitIndex]?.pageNumber);
    if (jump && generation === this.hitGeneration && hits[index]) {
      await this.jumpToHit(index, { push: true, historyGroup });
    }
  }

  async jumpToHit(index, { push = false, historyGroup = null } = {}) {
    const hit = this.hits[index];
    if (!hit) return;
    const generation = this.generation;
    const hitGeneration = this.hitGeneration;
    const navigation = ++this.navigationGeneration;
    const current = () => generation === this.generation && hitGeneration === this.hitGeneration &&
      navigation === this.navigationGeneration;
    try {
      const origin = this.getState();
      const prevPage = this.hits[this.hitIndex]?.pageNumber;
      // Name the destination before the render, exactly as `goToPage` does with
      // `currentPage`: two presses in one frame otherwise both read the old
      // cursor and the second one is swallowed.
      this.hitIndex = index;
      this.priorityPage = hit.pageNumber;
      const el = this.pageEls[hit.pageNumber - 1];
      if (!this.textMappings.has(hit.pageNumber)) {
        // Give cold destinations immediate feedback while their text layer is
        // still being built; apply the exact hit position after render.
        this.currentPage = hit.pageNumber;
        this.wrapEl.scrollTo({ top: el.offsetTop, left: el.offsetLeft, behavior: "auto" });
        this.notify();
      }
      await this.renderPage(hit.pageNumber);
      if (this.priorityPage === hit.pageNumber) this.priorityPage = null;
      this.pumpRenderQueue();
      if (!current()) return;
      const layer = el.querySelector(".hlLayer");
      const cache = this.highlightLayerCache?.get(hit.pageNumber);
      const cacheValid = cache && cache.layer === layer && cache.mapping === this.textMappings.get(hit.pageNumber) && cache.hits === this.hits && cache.query === this.query;
      const rect = (cacheValid ? cache.rectsByHit.get(index) : null)?.[0] ||
        matchRects(this.textMappings.get(hit.pageNumber), layer, hit.offset, hit.length)[0];
      if (push) this.history.commit(origin);
      this.hitIndex = index;
      this.currentPage = hit.pageNumber;
      this.wrapEl.scrollTo({
        top: Math.max(0, el.offsetTop + (rect?.top || 0) - 64),
        left: rect ? Math.max(0, el.offsetLeft + rect.left - 32) : this.wrapEl.scrollLeft,
        behavior: "auto",
      });
      if (push) this.history.push(this.getState(), { group: historyGroup });
      this.notify();
      this.refreshLiveHighlights(prevPage, hit.pageNumber);
    } catch (error) {
      if (current()) throw error;
    }
  }
}

// The shell half builds the history itself (it owns the back/forward buttons),
// so the port re-exports it instead of making callers import a second module.
export { ViewHistory } from "./history.mjs";
// The shell half searches the index the viewer builds, so it gets the same entry point.
export { searchDocument } from "./search.mjs";
