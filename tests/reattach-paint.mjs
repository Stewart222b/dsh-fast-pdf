/**
 * What a switch back to an open document is allowed to redraw.
 *
 * The pane parks a viewer instead of closing it, so coming back is a re-attach
 * rather than a reload — but the re-attach used to call `setZoom`, which
 * unconditionally dropped every page's raster mark, hid every text layer and
 * re-rasterised the visible pages with `force`. The reader paid for it as a
 * blank frame and then the same pixels coming back: 「黑着 0.几秒」.
 *
 * These checks pin the two things that made it happen: `setZoom` doing that
 * work when the geometry did not change at all, and `applyReadingPosition`
 * forcing a re-raster just because the scroll position moved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const style = () => ({ setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} });
const node = { style: style(), append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {}, getContext: () => ({}) };
globalThis.document = {
  documentElement: { style: style() },
  head: node,
  body: node,
  createElement: () => ({ style: style(), dataset: {}, appendChild() {}, setAttribute() {}, getContext: () => ({}) }),
  createTextNode: () => ({}),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;

const { PdfViewer } = await import("../public/viewer.mjs");

/** A viewer with just enough surface for `setZoom` to run for real. */
function makeViewer({ pages = 3, width = 700 } = {}) {
  const stats = { layout: 0, renders: [], hides: 0, cleared: 0 };
  const wrapEl = {
    clientWidth: width, clientHeight: 900, clientLeft: 0, clientTop: 0, scrollTop: 0, scrollLeft: 0,
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; },
    removeEventListener() {},
  };
  const pageSizes = Array.from({ length: pages }, () => ({ width: 600, height: 800, viewBox: [0, 0, 600, 800], rotation: 0, userUnit: 1 }));
  const pageEls = pageSizes.map((size, index) => ({
    offsetTop: 16 + index * (size.height + 14),
    offsetLeft: 0,
    offsetWidth: size.width,
    offsetHeight: size.height,
    style: style(),
    dataset: { pageNumber: String(index + 1), renderedZoom: "1.000" },
    querySelector: () => ({ replaceChildren() { stats.cleared += 1; } }),
  }));
  const pagesEl = { offsetLeft: 0, offsetTop: 0, style: style(), replaceChildren() {} };
  const viewer = Object.create(PdfViewer.prototype);
  Object.assign(viewer, {
    // The zoom the document was laid out at on its way in: exactly what
    // `page-width` asks for at this width, so a re-attach that finds the same
    // width has nothing to redo.
    zoom: Math.max(0.25, (width - 48) / 600), zoomMode: "page-width", wrapEl, pageEls, pagesEl, pageSizes, pageGap: 14,
    pageCount: pages, currentPage: 1, baseWidth: 600, baseHeight: 800, pdf: {},
    // Laid out for that zoom, as a viewer that has finished opening would be.
    appliedZoom: Math.max(0.25, (width - 48) / 600),
    zoomAnimations: new Map(), textLayers: new Map(), textMappings: new Map(),
    highlightLayerCache: new Map(), highlightedPages: new Set(),
    activeRenderJobs: new Set(), tasks: new Map(), renderQueue: [], renderJobs: new Map(),
    renderedPages: new Map(), pinch: null, pinchTimer: 0, resize: null, resizeFrame: 0,
    resizeTimer: 0, zoomTimer: 0, generation: 1, applyingHistory: false,
    history: { reset() {}, commit() {} },
    onState: null,
    computeZoom(mode = this.zoomMode) {
      if (mode === "page-width") return Math.max(0.25, (this.wrapEl.clientWidth - 48) / 600);
      const numeric = Number(mode);
      return Number.isFinite(numeric) ? Math.min(5, Math.max(0.25, numeric / 100)) : 1;
    },
    // The real one records the zoom the boxes now describe.
    applyPageLayout() { stats.layout += 1; this.appliedZoom = this.zoom; },
    renderVisible(force = false) { stats.renders.push(force); return Promise.resolve(); },
    cancelZoomAnimations() {},
    cancelPinch() {},
    cancelResize() {},
    captureZoomAnchor() { return null; },
    restoreZoomAnchor() {},
    notify() {},
  });
  return { viewer, stats, pageEls };
}

// The re-attach case: same mode, same width while it was put away. Nothing on
// screen is wrong, so nothing may be thrown away and nothing may be re-rastered.
{
  const { viewer, stats, pageEls } = makeViewer();
  const before = viewer.zoom;
  viewer.setZoom("page-width", { silent: true });
  console.log("same geometry -> layout:", stats.layout, "renders:", JSON.stringify(stats.renders),
    "hlLayer clears:", stats.cleared);
  assert.equal(stats.layout, 0, "a re-attach at an unchanged width must not rewrite the page boxes");
  assert.equal(viewer.zoom, before, "the committed zoom is unchanged");
  assert.equal(stats.cleared, 0, "no highlight layer is emptied");
  assert.deepEqual(stats.renders, [false],
    "pages whose mark already matches are skipped, so the render is not forced");
  for (const el of pageEls) {
    assert.equal(el.dataset.renderedZoom, "1.000", "the raster mark must survive a no-op setZoom");
  }
}

// The honest case: the pane really was resized while parked. Now the layout is
// wrong and the full path is the correct one.
{
  const { viewer, stats, pageEls } = makeViewer();
  viewer.wrapEl.clientWidth = 980;
  viewer.setZoom("page-width", { silent: true });
  console.log("new width -> layout:", stats.layout, "renders:", JSON.stringify(stats.renders),
    "hlLayer clears:", stats.cleared);
  assert.equal(stats.layout, 1, "a real width change relayouts");
  assert.deepEqual(stats.renders, [true], "and re-rasterises, because the old raster is the wrong size");
  assert.equal(pageEls[0].dataset.renderedZoom, undefined, "the stale mark is dropped");
}

// A new zoom mode is always a real change, even at the same size.
{
  const { viewer, stats } = makeViewer();
  viewer.setZoom(String(Math.round(viewer.zoom * 100)), { silent: true });
  console.log("mode change at equal size -> layout:", stats.layout);
  assert.equal(stats.layout, 1, "switching from fit-width to a percentage relayouts");
}

// The trap the early return has to avoid: a viewer is born with `zoom: 1`, and
// on a pane whose fit-width happens to be exactly 1.0 the numbers would match
// before anything has ever been laid out. `appliedZoom` is what tells the two
// apart — undefined means the page boxes do not describe this zoom yet.
{
  const { viewer, stats } = makeViewer();
  delete viewer.appliedZoom;
  viewer.setZoom("page-width", { silent: true });
  console.log("never laid out -> layout:", stats.layout, "renders:", JSON.stringify(stats.renders));
  assert.equal(stats.layout, 1, "a viewer that has never been laid out must still lay out");
  assert.deepEqual(stats.renders, [true], "and rasterise, since there is nothing on screen yet");
}

// Moving the scroll position does not invalidate a raster. Forcing one here was
// the second half of the blank frame: the pages were re-rendered after the
// position was restored, for a layout that had not moved.
{
  const source = readFileSync(new URL("../public/viewer.mjs", import.meta.url), "utf8");
  const position = source.slice(source.indexOf("  applyReadingPosition(state,"), source.indexOf("  back() {"));
  assert.doesNotMatch(position, /renderVisible\(true\)/u,
    "restoring a reading position must not force a re-raster");
  assert.match(position, /this\.renderVisible\(\)\.catch/u, "it still renders pages that never got one");
}

console.log("a switch back redraws only what the width actually changed");
