const BUILD = "2026-11-14-diag1";
const RENDER_PHASES = ["canvas", "textContent", "textLayer", "textMapping", "links", "highlights"];
const attached = new WeakMap();

/** Attach bounded, aggregate-only scroll timing diagnostics to one viewer. */
export function attach(viewer, report, { pauseRendering = false, canvasOnly = false } = {}) {
  if (viewer === null || typeof viewer !== "object" || typeof report !== "function") {
    return () => {};
  }
  if (attached.has(viewer)) return () => {};

  const previousCanvasOnly = viewer.diagnosticCanvasOnly;
  viewer.diagnosticCanvasOnly = canvasOnly;
  let disposed = false;
  let activeUntil = 0;
  let lastScrollAt = 0;
  let lastFrameAt = 0;
  let frame = 0;
  let idleTimer = 0;
  let batchTimer = 0;
  const totals = () => ({
    scrollEvents: 0,
    pinchEvents: 0,
    maxPinchSyncMs: 0,
    maxFrameGapMs: 0,
    frameCount: 0,
    totalFrameGapMs: 0,
    maxScrollHandlerMs: 0,
    maxRenderVisibleSyncMs: 0,
    visibleCalls: 0,
    maxGetStateSyncMs: 0,
    renderStarts: 0,
    renderMaxMs: 0,
    renderErrors: 0,
    setZoomCalls: 0,
    maxSetZoomMs: 0,
    zoomChanges: 0,
    renderPhaseMaxMs: Object.fromEntries(RENDER_PHASES.map((phase) => [phase, 0])),
    renderPhaseSyncMaxMs: Object.fromEntries(RENDER_PHASES.map((phase) => [phase, 0])),
  });
  let counters = totals();
  const now = () => globalThis.performance?.now?.() ?? Date.now();

  const workerInfo = () => {
    const port = viewer.loadingTask?._worker?.port;
    const workerPortKind = port?.constructor?.name ?? "unavailable";
    let realWorker = false;
    try {
      realWorker = typeof Worker === "function" && port instanceof Worker;
    } catch { /* feature may not expose Worker in this surface */ }
    return { workerPortKind, realWorker };
  };
  const emit = () => {
    const frameEl = viewer.wrapEl;
    const payload = {
      build: BUILD,
      rasterPaused: pauseRendering,
      canvasOnly,
      ...counters,
      docVisible: typeof document === "undefined" ? null : !document.hidden,
      docHasFocus: typeof globalThis.document?.hasFocus === "function" ? globalThis.document.hasFocus() : null,
      frameWidth: Number(frameEl?.clientWidth) || 0,
      frameHeight: Number(frameEl?.clientHeight) || 0,
      ...workerInfo(),
      renderPhaseMaxMs: { ...counters.renderPhaseMaxMs },
      renderPhaseSyncMaxMs: { ...counters.renderPhaseSyncMaxMs },
    };
    counters = totals();
    try { report(payload); } catch { /* diagnostics must never affect reading */ }
  };
  const stopFrames = () => {
    if (frame) globalThis.cancelAnimationFrame?.(frame);
    frame = 0;
    lastFrameAt = 0;
  };
  const finishWindow = () => {
    if (disposed || now() < activeUntil) return;
    stopFrames();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = 0;
    if (batchTimer) clearInterval(batchTimer);
    batchTimer = 0;
    emit();
  };
  const sampleFrame = (time) => {
    if (disposed || !activeUntil) return;
    if (lastFrameAt > 0) {
      const gap = time - lastFrameAt;
      counters.maxFrameGapMs = Math.max(counters.maxFrameGapMs, gap);
      counters.frameCount += 1;
      counters.totalFrameGapMs += gap;
    }
    lastFrameAt = time;
    if (time >= activeUntil) {
      frame = 0;
      finishWindow();
      return;
    }
    frame = globalThis.requestAnimationFrame?.(sampleFrame) ?? 0;
  };
  const beginWindow = () => {
    activeUntil = now() + 500;
    if (!frame) frame = globalThis.requestAnimationFrame?.(sampleFrame) ?? 0;
    if (!batchTimer) batchTimer = setInterval(emit, 1000);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(finishWindow, 510);
  };

  const originalScroll = viewer.onScroll;
  const wrappedScroll = function (...args) {
    if (disposed) return originalScroll?.apply(this, args);
    const started = now();
    counters.scrollEvents += 1;
    lastScrollAt = started;
    beginWindow();
    try { return originalScroll?.apply(this, args); }
    finally { counters.maxScrollHandlerMs = Math.max(counters.maxScrollHandlerMs, now() - started); }
  };
  viewer.onScroll = wrappedScroll;

  const originalPinch = viewer.pinchZoom;
  const wrappedPinch = function (...args) {
    if (disposed) return originalPinch.apply(this, args);
    beginWindow();
    counters.pinchEvents += 1;
    const started = now();
    try { return originalPinch.apply(this, args); }
    finally { counters.maxPinchSyncMs = Math.max(counters.maxPinchSyncMs, now() - started); }
  };
  if (typeof originalPinch === "function") viewer.pinchZoom = wrappedPinch;

  const originalRender = viewer.renderPageNow;
  const wrappedRender = function (...args) {
    if (pauseRendering) return Promise.resolve();
    const started = now();
    if (!disposed && started <= activeUntil) counters.renderStarts += 1;
    let result;
    try { result = originalRender.apply(this, args); }
    catch (error) {
      if (!disposed && started <= activeUntil) counters.renderErrors += 1;
      throw error;
    }
    if (result?.then) {
      return result.then((value) => {
        if (!disposed && started <= activeUntil) counters.renderMaxMs = Math.max(counters.renderMaxMs, now() - started);
        return value;
      }, (error) => {
        if (!disposed && started <= activeUntil) {
          counters.renderErrors += 1;
          counters.renderMaxMs = Math.max(counters.renderMaxMs, now() - started);
        }
        throw error;
      });
    }
    if (!disposed && started <= activeUntil) counters.renderMaxMs = Math.max(counters.renderMaxMs, now() - started);
    return result;
  };
  if (typeof originalRender === "function") viewer.renderPageNow = wrappedRender;

  const originalRenderPhase = viewer.onRenderPhase;
  const wrappedRenderPhase = (event) => {
    if (!disposed && event && now() <= activeUntil
      && RENDER_PHASES.includes(event.phase)) {
      counters.renderPhaseMaxMs[event.phase] = Math.max(counters.renderPhaseMaxMs[event.phase], Number(event.ms) || 0);
      counters.renderPhaseSyncMaxMs[event.phase] = Math.max(counters.renderPhaseSyncMaxMs[event.phase], Number(event.syncMs) || 0);
    }
    try { originalRenderPhase?.(event); } catch { /* diagnostics callback is isolated */ }
  };
  viewer.onRenderPhase = wrappedRenderPhase;

  const originalSetZoom = viewer.setZoom;
  const wrappedSetZoom = function (...args) {
    const started = now();
    const before = viewer.zoom;
    if (!disposed && started <= activeUntil) counters.setZoomCalls += 1;
    let result;
    try { result = originalSetZoom.apply(this, args); }
    catch (error) {
      if (!disposed && started <= activeUntil) counters.maxSetZoomMs = Math.max(counters.maxSetZoomMs, now() - started);
      throw error;
    }
    const finish = () => {
      if (disposed || started > activeUntil) return;
      counters.maxSetZoomMs = Math.max(counters.maxSetZoomMs, now() - started);
      if (viewer.zoom !== before) counters.zoomChanges += 1;
    };
    if (result?.then) return result.finally(finish);
    finish();
    return result;
  };
  if (typeof originalSetZoom === "function") viewer.setZoom = wrappedSetZoom;

  const originalRenderVisible = viewer.renderVisible;
  const wrappedRenderVisible = function (...args) {
    const started = now();
    if (!disposed && started <= activeUntil) counters.visibleCalls += 1;
    const result = originalRenderVisible.apply(this, args);
    if (!disposed && started <= activeUntil) {
      counters.maxRenderVisibleSyncMs = Math.max(counters.maxRenderVisibleSyncMs, now() - started);
    }
    return result;
  };
  if (typeof originalRenderVisible === "function") viewer.renderVisible = wrappedRenderVisible;

  const originalGetState = viewer.getState;
  const wrappedGetState = function (...args) {
    const started = now();
    const result = originalGetState.apply(this, args);
    if (!disposed && started <= activeUntil) counters.maxGetStateSyncMs = Math.max(counters.maxGetStateSyncMs, now() - started);
    return result;
  };
  if (typeof originalGetState === "function") viewer.getState = wrappedGetState;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopFrames();
    if (idleTimer) clearTimeout(idleTimer);
    if (batchTimer) clearInterval(batchTimer);
    idleTimer = batchTimer = 0;
    viewer.wrapEl?.removeEventListener?.("scroll", wrappedScroll);
    if (viewer.onScroll === wrappedScroll) viewer.onScroll = originalScroll;
    if (viewer.pinchZoom === wrappedPinch) viewer.pinchZoom = originalPinch;
    if (viewer.renderPageNow === wrappedRender) viewer.renderPageNow = originalRender;
    if (viewer.onRenderPhase === wrappedRenderPhase) viewer.onRenderPhase = originalRenderPhase;
    if (viewer.setZoom === wrappedSetZoom) viewer.setZoom = originalSetZoom;
    if (viewer.renderVisible === wrappedRenderVisible) viewer.renderVisible = originalRenderVisible;
    if (viewer.getState === wrappedGetState) viewer.getState = originalGetState;
    viewer.diagnosticCanvasOnly = previousCanvasOnly;
    attached.delete(viewer);
  };
  attached.set(viewer, dispose);
  return dispose;
}
