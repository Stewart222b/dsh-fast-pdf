import assert from "node:assert/strict";
import { convertCssToPdfPoint } from "../public/pdf-viewport.mjs";

const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
const node = { style, append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {}, getContext: () => ({}) };
globalThis.document = { documentElement: { style }, head: node, body: node, createElement: () => node, createTextNode: () => ({}), addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { PdfViewer } = await import("../public/viewer.mjs");

function makeViewer({ pages = 40, pageGap = 14, zoom = 1, scrollTop = 2300, pageHeight = 200 } = {}) {
  const wrapEl = { clientWidth: 700, clientHeight: 500, clientLeft: 0, clientTop: 0, scrollTop, scrollLeft: 0 };
  wrapEl.removeEventListener = () => {};
  wrapEl.scrollTo = ({ top, left }) => { wrapEl.scrollTop = top; wrapEl.scrollLeft = left; };
  const pageSizes = Array.from({ length: pages }, () => ({ width: 612, height: pageHeight, viewBox: [0, 0, 612, pageHeight], rotation: 0, userUnit: 1 }));
  const pageEls = pageSizes.map((_, index) => ({
    offsetTop: 16 * zoom + index * (pageHeight * zoom + pageGap * zoom), offsetLeft: (wrapEl.clientWidth - 612 * zoom) / 2,
    offsetHeight: pageHeight * zoom, offsetWidth: 612 * zoom,
    style: { transform: "", setProperty() {} }, dataset: { pageNumber: String(index + 1) },
    querySelector: () => ({ replaceChildren() {} }),
  }));
  const rafs = new Map();
  let nextRaf = 1;
  const vars = new Map();
  const pagesEl = { offsetLeft: 0, offsetTop: 0, replaceChildren() {}, style: { vars, setProperty(name, value) { vars.set(name, value); } } };
  const viewer = Object.create(PdfViewer.prototype);
  Object.assign(viewer, {
    zoom, zoomMode: String(zoom * 100), pageGap, pageSizes, pageEls, pageCount: pages, currentPage: 1,
    baseWidth: 612, baseHeight: pageHeight, wrapEl, pdf: {}, zoomAnimations: new Map(), textLayers: new Map(),
    textMappings: new Map(), highlightLayerCache: new Map(), highlightedPages: new Set(), activeRenderJobs: new Set(),
    tasks: new Map(), renderQueue: [], pageRenderLocks: new Map(), renderJobs: new Map(), renderedPages: new Map(),
    visiblePages: new Set(), pageTexts: [], textContents: new Map(), generation: 1, priorityPage: null,
    hitGeneration: 0, navigationGeneration: 0, scrollFrame: 0, scrollSettleTimer: 0,
    history: { reset() {} }, loadingTask: null, indexPromise: null,
    renderCalls: [], renderVisible(...args) { this.renderCalls.push(args); }, notify() {}, cancelRenderJob() {}, onPinchCommitCalls: 0,
    onPinchCommit() { this.onPinchCommitCalls += 1; }, pagesEl,
    requestTestFrame(callback) { const id = nextRaf++; rafs.set(id, callback); return id; },
    cancelTestFrame(id) { rafs.delete(id); },
    computeZoom() { return Math.max(0.25, Math.min(5, Number(this.zoomMode) / 100)); },
    applyPageLayout() {
      this.applyPageSpacing();
      let top = 16 * this.zoom;
      this.pageEls.forEach((page, index) => {
        const size = this.pageLayout(index + 1);
        page.offsetTop = top;
        page.offsetHeight = size.height * this.zoom;
        page.offsetWidth = size.width * this.zoom;
        page.offsetLeft = (this.wrapEl.clientWidth - page.offsetWidth) / 2;
        top += page.offsetHeight + this.pageGap * this.zoom;
      });
    },
  });
  globalThis.requestAnimationFrame = (callback) => viewer.requestTestFrame(callback);
  globalThis.cancelAnimationFrame = (id) => viewer.cancelTestFrame(id);
  return { viewer, rafs, vars };
}

function visualPageBox(viewer, index, ratio) {
  const page = viewer.pageEls[index];
  const origin = viewer.wrapEl.scrollTop + viewer.wrapEl.clientHeight / 2;
  const top = origin + ratio * (page.offsetTop - origin);
  return { top, bottom: top + ratio * page.offsetHeight };
}
function centerPdfPoint(viewer) {
  const x = viewer.wrapEl.scrollLeft + viewer.wrapEl.clientWidth / 2;
  const y = viewer.wrapEl.scrollTop + viewer.wrapEl.clientHeight / 2;
  const index = viewer.pageEls.findIndex((page) => y >= page.offsetTop && y <= page.offsetTop + page.offsetHeight);
  if (index < 0) return null;
  const page = viewer.pageEls[index];
  return convertCssToPdfPoint(viewer.pageLayout(index + 1), viewer.zoom, x - page.offsetLeft, y - page.offsetTop);
}
function visibleGaps(viewer, ratio) {
  const visible = viewer.pageEls.map((page, index) => visualPageBox(viewer, index, ratio))
    .map((box, index) => box.bottom >= viewer.wrapEl.scrollTop && box.top <= viewer.wrapEl.scrollTop + viewer.wrapEl.clientHeight ? index : -1)
    .filter((index) => index >= 0);
  return visible.slice(0, -1).map((index) => {
    const first = visualPageBox(viewer, index, ratio);
    const next = visualPageBox(viewer, index + 1, ratio);
    return next.top - first.bottom;
  });
}

for (const ratio of [0.5, 0.6, 1.5, 2]) {
  const { viewer, rafs } = makeViewer();
  const centerBefore = centerPdfPoint(viewer);
  viewer.pinchZoom({ scaleFactor: ratio, clientX: 2, clientY: 3 });
  [...rafs.values()][0]();
  const gaps = visibleGaps(viewer, ratio);
  assert.ok(gaps.length > 0);
  assert.ok(gaps.every((gap) => Math.abs(gap - 14 * ratio) < 0.01), `preview ratio ${ratio}: expected ${14 * ratio}px gaps, got ${gaps.join(",")}`);
  assert.equal(viewer.pageEls.some((page) => page.style.transform), false, "pinch preview should use the parent compositor transform only");
  viewer.finishPinch();
  assert.equal(viewer.onPinchCommitCalls, 1);
  assert.ok(viewer.pageEls.slice(0, -1).every((page, index) => Math.abs(viewer.pageEls[index + 1].offsetTop - page.offsetTop - page.offsetHeight - 14 * ratio) < 0.001), "committed layout gap scales with zoom");
  assert.equal(viewer.pagesEl.style.vars.get("--fp-page-gap"), `${14 * ratio}px`);
  assert.equal(viewer.pagesEl.style.vars.get("--fp-page-pad-top"), `${16 * ratio}px`);
  assert.equal(viewer.pagesEl.style.vars.get("--fp-page-pad-bottom"), `${48 * ratio}px`);
  const centerAfter = centerPdfPoint(viewer);
  assert.ok(Math.abs(centerAfter[0] - centerBefore[0]) < 1e-6 && Math.abs(centerAfter[1] - centerBefore[1]) < 1e-6, "commit retains the center anchor");
}

const gapViewerFixture = makeViewer({ scrollTop: 2325 });
const gapViewer = gapViewerFixture.viewer;
const anchor = gapViewer.captureZoomAnchor();
assert.ok(Math.abs(anchor.gapY - 5) < 1e-6 && anchor.zoom === 1, "fixture center is 5px inside a page gap at 100%");
gapViewer.pinchZoom({ scaleFactor: 2, clientX: 0, clientY: 0 });
[...gapViewerFixture.rafs.values()][0]();
const previewPage = gapViewer.pageEls[anchor.page - 1];
const previewBox = visualPageBox(gapViewer, anchor.page - 1, 2);
const centerY = gapViewer.wrapEl.scrollTop + gapViewer.wrapEl.clientHeight / 2;
assert.ok(Math.abs(centerY - previewBox.bottom - anchor.gapY * 2) < 1e-6, "gap-local offset scales during pinch preview");
gapViewer.finishPinch();
gapViewer.applyPageLayout();
const committedPage = gapViewer.pageEls[anchor.page - 1];
assert.ok(Math.abs(gapViewer.wrapEl.scrollTop + gapViewer.wrapEl.clientHeight / 2 - committedPage.offsetTop - committedPage.offsetHeight - anchor.gapY * 2) < 1e-6, "gap-local offset scales through commit");
assert.equal(previewPage, committedPage);

const settings = makeViewer();
const settingViewer = settings.viewer;
settingViewer.zoom = 2;
settingViewer.zoomMode = "200";
settingViewer.applyPageLayout();
assert.equal(settingViewer.setPageGap(14), 14);
assert.equal(settingViewer.pageGap, 14, "setting remains the 100% base gap");
assert.equal(settings.vars.get("--fp-page-gap"), "28px", "14px base gap is 28px at 200% zoom");
assert.equal(settings.vars.get("--fp-page-pad-top"), "32px");
assert.equal(settings.vars.get("--fp-page-pad-bottom"), "96px");
assert.equal(settingViewer.setPageGap(0), 0);
assert.equal(settings.vars.get("--fp-page-gap"), "0px");
assert.equal(settingViewer.setPageGap(100), 48);
assert.equal(settingViewer.setPageGap(-1), 0);
assert.equal(settings.vars.get("--fp-page-gap"), "0px");
console.log("pinch-spacing: proportional preview, commit, center gap anchor, and base setting passed");
