import assert from "node:assert/strict";

const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
const node = { style, append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {}, getContext: () => ({}), replaceWith() {}, replaceChildren() {} };
globalThis.document = {
  documentElement: { style }, head: node, body: node,
  createElement: () => node, createTextNode: () => ({}),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { PdfViewer } = await import("../public/viewer.mjs");

function createViewer() {
  const viewer = new PdfViewer({
    pagesEl: { replaceChildren() {} },
    wrapEl: { scrollTop: 0, scrollLeft: 0, clientHeight: 500, clientWidth: 600, removeEventListener() {}, scrollTo() {} },
    history: { reset() {} },
  });
  viewer.generation = 1;
  viewer.pdf = { destroy: async () => {} };
  viewer.zoom = 1;
  viewer.pageEls = Array.from({ length: 10 }, (_, i) => ({
    offsetTop: i * 300, offsetHeight: 300,
    dataset: { pageNumber: String(i + 1) },
    querySelector: () => null,
  }));
  viewer.renderJobs = new Map();
  viewer.renderQueue = [];
  viewer.activeRenderJobs = new Set();
  viewer.pageRenderLocks = new Map();
  viewer.maxConcurrentRenders = 2;
  viewer.tasks = new Map();
  viewer.textLayers = new Map();
  viewer.renderedPages = new Map();
  viewer.visiblePages = new Set();
  viewer.textMappings = new Map();
  viewer.textContents = new Map();
  viewer.highlightedPages = new Set();
  viewer.zoomAnimations = new Map();
  viewer.pageSizes = [];
  viewer.pageTexts = [];
  viewer.hits = [];
  viewer.query = "";
  viewer.indexPromise = null;
  viewer.observer = null;
  viewer.history = { reset() {} };
  viewer.pagesEl = { replaceChildren() {} };
  viewer.cancelZoomAnimations = () => {};
  viewer.cancelPinch = () => {};
  viewer.captureScrollAnchor = () => null;
  viewer.trimCache = () => {};
  viewer.onScrollPosition = null;
  viewer.currentPage = 1;
  viewer.pageCount = 10;
  viewer.renderPageNow = async () => {};
  return viewer;
}

// The same 1200px lead-in used by IntersectionObserver must remain eligible to
// render. Page 5 starts at 1200px, within a 500px viewport's 1200px lead-in.
{
  const viewer = createViewer();
  let started = 0;
  viewer.renderPageNow = () => new Promise((resolve) => { started += 1; setTimeout(resolve, 20); });
  const pageFive = viewer.renderPage(5);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(viewer.renderJobs.get(5)?.cancelled, false, "IO lead-in page must remain scheduled");
  assert.equal(started, 1, "lead-in page should be eligible to start");
  await pageFive;
  viewer.close();
}

// Every scroll event must request one frame's viewport update; a quiet period
// is not required before newly visible pages are considered.
{
  const viewer = createViewer();
  const scheduled = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const cancelled = [];
  globalThis.requestAnimationFrame = (callback) => { scheduled.push(callback); return scheduled.length; };
  globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); };
  try {
    viewer.onScroll();
    viewer.wrapEl.scrollTop = 300;
    viewer.onScroll();
    assert.equal(scheduled.length, 2, "scroll should schedule frame-based work immediately");
    assert.ok(viewer.scrollFrame, "the latest frame is tracked for close cancellation");
    const latest = viewer.scrollFrame;
    viewer.close();
    assert.ok(cancelled.includes(latest), "close cancels pending frame work");
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

// The queue shares only two active slots, deduplicates a page promise, drops
// stale queued work after a jump and cancels active work when the viewer closes.
{
  const viewer = createViewer();
  const started = [];
  viewer.renderPageNow = (pageNumber, _force, job) => new Promise((resolve) => {
    started.push({ pageNumber, job, resolve });
  });
  const oldJobs = [];
  for (let page = 1; page <= 6; page += 1) oldJobs.push(viewer.renderPage(page));
  assert.equal(viewer.activeRenderJobs.size, 2, "only two render jobs may hold active slots");
  assert.equal(viewer.renderPage(3), oldJobs[2], "same-page requests reuse the queued promise");
  viewer.wrapEl.scrollTop = 3000;
  viewer.pumpRenderQueue();
  assert.equal(viewer.renderJobs.has(3), false, "queued pages outside the new window are discarded");
  assert.equal(viewer.activeRenderJobs.size, 2, "canceled active tasks retain their slots until settled");
  started.slice(0, 2).forEach((job) => job.resolve());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const target = viewer.renderPage(10);
  assert.ok(started.some((job) => job.pageNumber === 10), "the current viewport target starts promptly");
  const active = [...viewer.activeRenderJobs];
  viewer.close();
  assert.ok(active.every((job) => job.cancelled), "close cancels all active page work");
  assert.equal(viewer.activeRenderJobs.size, 0, "closed generations release their scheduler slots");
  started.slice(2).forEach((job) => job.resolve());
  await Promise.allSettled([...oldJobs, target]);
}

console.log("render queue behavior passed");

// Exercise the actual renderPageNow body with a PDF page and DOM shims. Keep the
// expensive pdf.js drawing primitive and text-layer implementation mocked so
// this seam catches completion bookkeeping and cache reuse deterministically.
{
  const originalMethod = PdfViewer.prototype.renderPageNow.toString()
    .replace(/^renderPageNow/u, "function")
    .replaceAll("new TextLayerBuilder(", "new MockTextLayerBuilder(");
  class MockTextLayerBuilder {
    constructor({ highlighter }) { this.div = fakeElement(); this.highlighter = highlighter; }
    async render() {
      this.highlighter.setTextMapping(["span"], ["sample text"]);
      if (deferTextLayer) await new Promise((resolve) => { resolveDeferredTextLayer = resolve; });
    }
    cancel() {}
  }
  let deferTextLayer = false;
  let resolveDeferredTextLayer = null;
  const realRender = new Function("MockTextLayerBuilder", "setLayerDimensions", "buildTextMapping",
    `return (${originalMethod});`)(MockTextLayerBuilder, () => {}, (divs, strings) => ({ divs, strings }));
  const viewer = createViewer();
  let renders = 0;
  let textContentCalls = 0;
  const page = {
    getViewport: ({ scale }) => ({ width: 100, height: 200, scale, viewBox: [0, 0, 100, 200] }),
    render: () => { renders += 1; return { promise: Promise.resolve() }; },
    getTextContent: () => { textContentCalls += 1; throw new Error("renderPageNow must not duplicate TextLayerBuilder text streaming"); },
  };
  const el = fakeElement();
  el.dataset.pageNumber = "1";
  const oldCanvas = fakeElement();
  let currentCanvas = oldCanvas;
  let textLayer = fakeElement();
  let textLayerReplacements = 0;
  const linkLayer = fakeElement();
  const hlLayer = fakeElement();
  el.querySelector = (selector) => selector === "canvas" ? currentCanvas
    : ({ ".textLayer": textLayer, ".linkLayer": linkLayer, ".hlLayer": hlLayer })[selector] ?? fakeElement();
  oldCanvas.replaceWith = (next) => { currentCanvas = next; };
  textLayer.replaceWith = (next) => { textLayerReplacements += 1; textLayer = next; };
  viewer.pageEls[0] = el;
  viewer.pdf = { getPage: async () => page };
  viewer.zoom = 1;
  viewer.textContents = new Map();
  viewer.renderedPages = new Map();
  viewer.textLayers = new Map();
  viewer.textMappings = new Map();
  viewer.renderJobs = new Map();
  viewer.tasks = new Map();
  viewer.generation = 1;
  viewer.renderLinks = async () => {};
  viewer.paintHighlights = async () => {};
  viewer.trimCache = () => {};
  const phases = [];
  viewer.onRenderPhase = (event) => phases.push(event);
  const job = { key: "1.000", cancelled: false };
  viewer.renderJobs.set(1, job);
  const createElement = document.createElement;
  document.createElement = () => fakeElement();
  try { await realRender.call(viewer, 1, false, job); }
  finally { document.createElement = createElement; }
  assert.equal(textContentCalls, 0, "renderPageNow leaves text streaming to TextLayerBuilder");
  assert.equal(el.dataset.renderedZoom, job.key);
  assert.equal(viewer.renderedPages.get(1), page);
  assert.deepEqual(phases.map((event) => event.phase), ["canvas", "textLayer", "textMapping", "links", "highlights"]);
  assert.ok(phases.every((event) => Number.isFinite(event.ms) && Number.isFinite(event.syncMs)));

  // A delayed text layer stays detached until complete. Superseding its job
  // before completion must leave the old placeholder in place.
  textLayer = fakeElement();
  textLayerReplacements = 0;
  textLayer.replaceWith = (next) => { textLayerReplacements += 1; textLayer = next; };
  deferTextLayer = true;
  const cancelledTextJob = { key: "1.000", cancelled: false };
  viewer.renderJobs.set(1, cancelledTextJob);
  const cancelledTextRender = realRender.call(viewer, 1, false, cancelledTextJob);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(textLayerReplacements, 0, "pending off-DOM text does not replace the placeholder");
  cancelledTextJob.cancelled = true;
  viewer.renderJobs.set(1, { key: "superseded" });
  resolveDeferredTextLayer();
  await cancelledTextRender;
  assert.equal(textLayerReplacements, 0, "canceled text work never commits its container");

  textLayer = fakeElement();
  textLayerReplacements = 0;
  textLayer.replaceWith = (next) => { textLayerReplacements += 1; textLayer = next; };
  const completedTextJob = { key: "1.000", cancelled: false };
  viewer.renderJobs.set(1, completedTextJob);
  const completedTextRender = realRender.call(viewer, 1, false, completedTextJob);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(textLayerReplacements, 0);
  resolveDeferredTextLayer();
  await completedTextRender;
  deferTextLayer = false;
  assert.equal(textLayerReplacements, 1, "current text container commits exactly once after render");
  assert.deepEqual(viewer.textMappings.get(1), { divs: ["span"], strings: ["sample text"] });
  assert.equal(el.dataset.renderedZoom, completedTextJob.key);

  await viewer.renderPage(1);
  assert.equal(renders, 1, "a completed bitmap must be reused instead of rendered again");
  delete el.dataset.renderedZoom;
  const rerenderSameZoom = { key: "1.000", cancelled: false };
  viewer.renderJobs.set(1, rerenderSameZoom);
  document.createElement = () => fakeElement();
  try { await realRender.call(viewer, 1, false, rerenderSameZoom); }
  finally { document.createElement = createElement; }
  assert.equal(renders, 1, "cancelled text work reuses a valid same-zoom bitmap");
  viewer.zoom = 1.5;
  const zoomed = { key: "1.500", cancelled: false };
  viewer.renderJobs.set(1, zoomed);
  document.createElement = () => fakeElement();
  try { await realRender.call(viewer, 1, false, zoomed); }
  finally { document.createElement = createElement; }
  assert.equal(renders, 2, "a zoom change requires a new bitmap");
  delete el.dataset.renderedZoom;
  currentCanvas.width = 0;
  const cleared = { key: "1.500", cancelled: false };
  viewer.renderJobs.set(1, cleared);
  document.createElement = () => fakeElement();
  try { await realRender.call(viewer, 1, false, cleared); }
  finally { document.createElement = createElement; }
  assert.equal(renders, 3, "a cleared canvas cannot satisfy bitmap reuse");
}

function fakeElement() {
  return {
    style: { setProperty() {} }, dataset: {}, width: 0, height: 0,
    getContext: () => ({}), replaceWith() {}, replaceChildren() {}, append() {},
  };
}

// Live scrolling keeps in-window work active and starts newly visible pages
// before the 100ms settle fallback.
{
  const viewer = createViewer();
  const started = [];
  let resolveInitial;
  viewer.renderPageNow = (pageNumber, _force, job) => new Promise((resolve) => {
    started.push({ pageNumber, job, resolve });
    if (pageNumber === 1) resolveInitial = resolve;
    else setTimeout(resolve, 0);
  });
  const inWindow = viewer.renderPage(1);
  const inWindowJob = viewer.renderJobs.get(1);
  for (const top of [300, 600, 900, 1200, 1500]) {
    viewer.wrapEl.scrollTop = top;
    viewer.onScroll();
    await new Promise((resolve) => setTimeout(resolve, 8));
    const viewportPage = Math.floor(top / 300) + 1;
    assert.equal(inWindowJob.cancelled, false, "an active page inside the 1200px window survives every scroll tick");
    assert.ok(started.some((item) => item.pageNumber === viewportPage), `visible page ${viewportPage} starts before settle`);
    assert.ok(viewer.activeRenderJobs.size <= 2, "live scrolling still respects the two-render limit");
  }
  viewer.close();
  resolveInitial();
  await inWindow;
}

// A true out-of-window active task is canceled, and the final viewport remains
// guaranteed by the settle fallback.
{
  const viewer = createViewer();
  const started = [];
  viewer.renderPageNow = (pageNumber, _force, job) => new Promise((resolve) => started.push({ pageNumber, job, resolve }));
  viewer.wrapEl.scrollTop = 2400;
  const old = viewer.renderPage(10);
  const oldJob = viewer.renderJobs.get(10);
  viewer.wrapEl.scrollTop = 0;
  viewer.onScroll();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(oldJob.cancelled, true, "active work outside the 1200px window is canceled");
  assert.ok(started.some((item) => item.pageNumber <= 2), "the new visible viewport starts while scrolling");
  assert.ok(started.length <= 2, "scrolling stays within the concurrent render limit");
  started[0].resolve();
  await old;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.ok(started.some((item) => item.pageNumber <= 2), `settle leaves the final visible viewport rendered; started=${started.map((item) => item.pageNumber)}`);
  started.slice(1).forEach((item) => item.resolve());
  viewer.renderQueue.forEach((job) => viewer.cancelRenderJob(job));
  viewer.close();
}

// IntersectionObserver entry order is arbitrary; visible pages are submitted
// from the viewport center outward, rather than in document order.
{
  const viewer = createViewer();
  const started = [];
  viewer.renderPageNow = (pageNumber) => new Promise((resolve) => started.push({ pageNumber, resolve }));
  viewer.wrapEl.scrollTop = 2400;
  const original = globalThis.IntersectionObserver;
  let callback;
  globalThis.IntersectionObserver = class {
    constructor(fn) { callback = fn; }
    disconnect() {}
    observe() {}
  };
  try {
    viewer.observe();
    callback([
      { target: viewer.pageEls[9], isIntersecting: true },
      { target: viewer.pageEls[8], isIntersecting: true },
    ]);
    assert.deepEqual(started.map((item) => item.pageNumber), [9, 10]);
    started.forEach((item) => item.resolve());
  } finally {
    globalThis.IntersectionObserver = original;
    viewer.close();
  }
}

// Close clears the settle timer, so it cannot create page jobs after teardown.
{
  const viewer = createViewer();
  let started = 0;
  viewer.renderPageNow = async () => { started += 1; };
  viewer.onScroll();
  assert.ok(viewer.scrollSettleTimer);
  viewer.close();
  assert.equal(viewer.scrollSettleTimer, 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(started, 0, "closed viewer does not render from a stale settle callback");
}

// A search destination remains eligible and receives its render during motion.
{
  const viewer = createViewer();
  const started = [];
  viewer.renderPageNow = (pageNumber) => new Promise((resolve) => started.push({ pageNumber, resolve }));
  viewer.wrapEl.scrollTop = 0;
  viewer.lastScrollAt = performance.now();
  viewer.priorityPage = 10;
  const target = viewer.renderPage(10);
  assert.ok(started.some((item) => item.pageNumber === 10), "explicit search target can start during motion");
  started[0].resolve();
  await target;
  viewer.close();
}
