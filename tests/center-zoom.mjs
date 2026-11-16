import assert from "node:assert/strict";
import { convertCssToPdfPoint } from "../public/pdf-viewport.mjs";

const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
const node = { style, append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {}, getContext: () => ({}) };
globalThis.document = { documentElement: { style }, head: node, body: node, createElement: () => node, createTextNode: () => ({}), addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { PdfViewer } = await import("../public/viewer.mjs");

function makeViewer({ zoom = 1, scrollTop = 200, scrollLeft = 0, width = 600, height = 1000, rotation = 0, pages = 1 } = {}) {
  const wrapEl = {
    clientWidth: 400, clientHeight: 300, clientLeft: 0, clientTop: 0,
    scrollTop, scrollLeft,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; },
  };
  const pageSizes = Array.from({ length: pages }, () => ({
    width, height, rotation,
    viewBox: rotation % 180 ? [0, 0, height, width] : [0, 0, width, height],
    userUnit: 1,
  }));
  const pageEls = pageSizes.map((size, index) => ({
    offsetTop: 16 + index * (height * zoom + 14),
    offsetLeft: (wrapEl.clientWidth - size.width * zoom) / 2,
    offsetWidth: size.width * zoom,
    offsetHeight: size.height * zoom,
    style: { setProperty() {} }, dataset: {},
    querySelector() { return { replaceChildren() {} }; },
  }));
  const viewer = Object.create(PdfViewer.prototype);
  Object.assign(viewer, {
    zoom, zoomMode: String(zoom * 100), wrapEl, pageEls, pageSizes,
    pageGap: 14,
    pageCount: pages, currentPage: 1, baseWidth: width, baseHeight: height,
    zoomAnimations: new Map(), textLayers: new Map(), textMappings: new Map(),
    highlightLayerCache: new Map(), highlightedPages: new Set(),
    pinch: null, pinchTimer: 0, pinchFrame: null, generation: 1,
    pagesEl: { style: {}, offsetLeft: 7, offsetTop: 11 },
    computeZoom() {
      const size = this.pageLayout(this.currentPage);
      const fitWidth = (this.wrapEl.clientWidth - 48) / size.width;
      const fitHeight = (this.wrapEl.clientHeight - 48) / size.height;
      if (this.zoomMode === "page-width") return Math.max(0.25, fitWidth);
      if (this.zoomMode === "page-fit") return Math.max(0.25, Math.min(fitWidth, fitHeight));
      const value = Number(this.zoomMode);
      return Math.max(0.25, Math.min(5, value / 100));
    },
    applyPageLayout() {
      let top = 16 * this.zoom;
      this.pageEls.forEach((page, index) => {
        const size = this.pageLayout(index + 1);
        page.offsetTop = top;
        page.offsetWidth = size.width * this.zoom;
        page.offsetHeight = size.height * this.zoom;
        page.offsetLeft = (this.wrapEl.clientWidth - page.offsetWidth) / 2;
        top += page.offsetHeight + this.pageGap * this.zoom;
      });
    },
    renderVisible() {},
    notify() {},
  });
  return viewer;
}

function centerPdfPoint(viewer) {
  const x = viewer.wrapEl.scrollLeft + viewer.wrapEl.clientWidth / 2;
  const y = viewer.wrapEl.scrollTop + viewer.wrapEl.clientHeight / 2;
  const index = viewer.pageEls.findIndex((page) => y >= page.offsetTop && y <= page.offsetTop + page.offsetHeight);
  if (index < 0) return null;
  const page = viewer.pageEls[index];
  return { page: index + 1, point: convertCssToPdfPoint(viewer.pageLayout(index + 1), viewer.zoom, x - page.offsetLeft, y - page.offsetTop) };
}

const viewer = makeViewer();
const before = centerPdfPoint(viewer);
viewer.setZoom("200", { silent: true });
const after = centerPdfPoint(viewer);
console.log(JSON.stringify({ before, after, scroll: { top: viewer.wrapEl.scrollTop, left: viewer.wrapEl.scrollLeft } }));
assert.equal(after.page, before.page);
assert.ok(Math.abs(after.point[0] - before.point[0]) < 1e-6, `viewport-center PDF x moved: ${before.point[0]} -> ${after.point[0]}`);
assert.ok(Math.abs(after.point[1] - before.point[1]) < 1e-6, `viewport-center PDF y moved: ${before.point[1]} -> ${after.point[1]}`);
viewer.setZoom("100", { silent: true });
const zoomBack = centerPdfPoint(viewer);
assert.ok(Math.abs(zoomBack.point[0] - before.point[0]) < 1e-6, "zoom out should preserve the same center point");
assert.ok(Math.abs(zoomBack.point[1] - before.point[1]) < 1e-6, "zoom out should preserve the same center point");
const toolbar = makeViewer();
const toolbarBefore = centerPdfPoint(toolbar);
toolbar.bumpZoom(1);
let toolbarAfter = centerPdfPoint(toolbar);
assert.equal(toolbar.zoomMode, "125");
assert.ok(Math.abs(toolbarAfter.point[0] - toolbarBefore.point[0]) < 1e-6, "toolbar zoom in should preserve center x");
assert.ok(Math.abs(toolbarAfter.point[1] - toolbarBefore.point[1]) < 1e-6, "toolbar zoom in should preserve center y");
toolbar.bumpZoom(-1);
toolbarAfter = centerPdfPoint(toolbar);
assert.equal(toolbar.zoomMode, "100");
assert.ok(Math.abs(toolbarAfter.point[0] - toolbarBefore.point[0]) < 1e-6, "toolbar zoom out should preserve center x");
assert.ok(Math.abs(toolbarAfter.point[1] - toolbarBefore.point[1]) < 1e-6, "toolbar zoom out should preserve center y");
clearTimeout(toolbar.zoomTimer);
const fit = makeViewer({ scrollTop: 500 });
const fitBefore = centerPdfPoint(fit);
fit.setZoom("page-fit", { silent: true });
const fitAfter = centerPdfPoint(fit);
assert.ok(Math.abs(fitAfter.point[0] - fitBefore.point[0]) < 1e-6, "fit zoom should preserve center x");
assert.ok(Math.abs(fitAfter.point[1] - fitBefore.point[1]) < 1e-6, "fit zoom should preserve center y");

const rotated = makeViewer({ width: 1000, height: 600, rotation: 90, pages: 2, scrollTop: 900, scrollLeft: 100 });
const rotatedBefore = centerPdfPoint(rotated);
assert.equal(rotatedBefore.page, 2, "the viewport center is on page two");
rotated.setZoom("150", { silent: true });
const rotatedAfter = centerPdfPoint(rotated);
assert.equal(rotatedAfter.page, rotatedBefore.page);
assert.ok(Math.abs(rotatedAfter.point[0] - rotatedBefore.point[0]) < 1e-6, "rotated-page center PDF x should remain fixed");
assert.ok(Math.abs(rotatedAfter.point[1] - rotatedBefore.point[1]) < 1e-6, "rotated-page center PDF y should remain fixed");

const gap = makeViewer({ width: 600, height: 400, pages: 2, scrollTop: 270 });
const gapContentY = gap.wrapEl.scrollTop + gap.wrapEl.clientHeight / 2;
const firstBottom = gap.pageEls[0].offsetTop + gap.pageEls[0].offsetHeight;
assert.ok(gapContentY > firstBottom && gapContentY < gap.pageEls[1].offsetTop, "fixture center is inside the page gap");
const gapOffset = gapContentY - firstBottom;
gap.setZoom("200", { silent: true });
const afterGapY = gap.wrapEl.scrollTop + gap.wrapEl.clientHeight / 2;
const afterFirstBottom = gap.pageEls[0].offsetTop + gap.pageEls[0].offsetHeight;
assert.ok(Math.abs(afterGapY - afterFirstBottom - gapOffset * 2) < 1e-6, "page-gap offset should scale with zoom");

const pinched = makeViewer({ scrollTop: 400, scrollLeft: 30 });
pinched.pdf = {};
pinched.activeRenderJobs = new Set();
pinched.cancelRenderJob = () => {};
pinched.onZoomPreview = () => {};
pinched.onPinchCommit = () => {};
const pinchBefore = centerPdfPoint(pinched);
pinched.pinchZoom({ scaleFactor: 1.5, clientX: 4, clientY: 8 });
assert.equal(pinched.pagesEl.style.transformOrigin, "223px 539px", "pinch preview origin should be viewport center in pagesEl coordinates");
pinched.finishPinch();
const pinchAfter = centerPdfPoint(pinched);
assert.ok(Math.abs(pinchAfter.point[0] - pinchBefore.point[0]) < 1e-6, "pinch at a corner should commit around viewport-center PDF x");
assert.ok(Math.abs(pinchAfter.point[1] - pinchBefore.point[1]) < 1e-6, "pinch at a corner should commit around viewport-center PDF y");

const edge = makeViewer({ scrollTop: 0, scrollLeft: 0, width: 1000, height: 1400 });
edge.setZoom("500", { silent: true });
assert.ok(edge.wrapEl.scrollTop >= 0 && edge.wrapEl.scrollLeft >= 0, "restored scroll positions should clamp at document edges");

// The horizontal gap outside a narrow page box must scale with zoom just like
// the vertical page-gap does. A wide pane with a narrow page puts the viewport
// centre in that side margin.
{
  const narrow = makeViewer({ zoom: 1, width: 120, height: 1000, scrollTop: 100, scrollLeft: 800 });
  // Put a second, wider page after the narrow one so the anchor lands in a
  // mixed-width layout, and force a large horizontal gap.
  narrow.pageEls[0].offsetLeft = 0;
  narrow.wrapEl.scrollLeft = 800;
  const anchor = narrow.captureZoomAnchor();
  assert.ok(anchor.gapX > 0, "the viewport centre sits outside the narrow page box");
  narrow.zoom = 2;
  // Recompute the page box for the new zoom, as applyPageLayout() would.
  narrow.pageEls[0].offsetWidth = 120 * 2;
  narrow.restoreZoomAnchor(anchor);
  const expected = Math.max(0, narrow.pageEls[0].offsetLeft + anchor.pageX * 2 + anchor.gapX * 2 - narrow.wrapEl.clientWidth / 2);
  assert.ok(Math.abs(narrow.wrapEl.scrollLeft - expected) < 1e-6,
    `horizontal gap must scale with zoom: got ${narrow.wrapEl.scrollLeft}, expected ${expected}`);
}
