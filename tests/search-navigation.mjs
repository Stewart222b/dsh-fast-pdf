import assert from "node:assert/strict";

const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
const created = () => ({ style, dataset: {}, className: "", children: [], appendChild(node) { this.children.push(node); } });
const root = created();
globalThis.document = {
  documentElement: { style }, head: root, body: root,
  createElement: created, createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node); } }), createTextNode: () => ({}),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { PdfViewer } = await import("../public/viewer.mjs");

const metrics = { hitCount: 10_000, rectClientReads: 0, layerReplacements: 0, highlightNodesAdded: 0, cachedRenderCalls: 0 };
const text = "term ".repeat(metrics.hitCount);
const textDiv = { isConnected: true, firstChild: { nodeValue: text } };
const mapping = { entries: [{ div: textDiv, start: 0, end: text.length }], textDivs: [textDiv], textContentItemsStr: [text] };
const makeLayer = () => ({
  clientWidth: 1000,
  clientHeight: 1400,
  ownerDocument: {
    createRange() {
      return {
        setStart() {}, setEnd() {},
        getClientRects() {
          metrics.rectClientReads += 1;
          return [{ left: 100, top: 100, width: 24, height: 12 }];
        },
      };
    },
  },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1400 }),
  replaceChildren(...nodes) { metrics.layerReplacements += 1; this.children = nodes.flatMap((node) => node.children || [node]); },
  appendChild(node) { metrics.highlightNodesAdded += 1; this.children.push(node); },
  children: [],
});
const layers = [makeLayer(), makeLayer()];
const pages = Array.from({ length: 2 }, (_, index) => ({
  offsetTop: index * 1400,
  offsetLeft: 0,
  offsetHeight: 1400,
  dataset: { pageNumber: String(index + 1), renderedZoom: "1.000" },
  querySelector: (selector) => selector === ".hlLayer" ? layers[index] : null,
}));
const scrollFeedback = [];
const viewer = new PdfViewer({
  pagesEl: { replaceChildren() {} },
  wrapEl: { scrollTop: 0, scrollLeft: 0, clientHeight: 900, clientWidth: 700, scrollTo(value) { scrollFeedback.push(value); }, removeEventListener() {} },
  history: { commit() {}, push() {} },
});
Object.assign(viewer, {
  pdf: {}, generation: 1, hitGeneration: 1, navigationGeneration: 0,
  pageEls: pages, pageCount: pages.length, currentPage: 1, zoom: 1,
  renderedPages: new Map([[1, {}]]), visiblePages: new Set([1]),
  textMappings: new Map([[1, mapping], [2, mapping]]),
  textLayers: new Map(), renderedPagesCache: new Map(),
  hits: Array.from({ length: metrics.hitCount }, (_, index) => ({ pageNumber: 1, offset: index * 5, length: 4 })),
  query: "term", hitIndex: 0, priorityPage: null,
  getState: () => ({ page: viewer.currentPage, zoom: viewer.zoom, scrollTop: viewer.wrapEl.scrollTop, scrollLeft: viewer.wrapEl.scrollLeft }),
  notify() {},
});

const cachedRender = viewer.renderPage.bind(viewer);
viewer.renderPage = (...args) => {
  metrics.cachedRenderCalls += 1;
  return cachedRender(...args);
};
// Establish the existing highlight layer, then count only the Enter-style move
// to another cached hit on the same page.
await viewer.paintHighlights(1);
metrics.rectClientReads = 0;
metrics.layerReplacements = 0;
metrics.highlightNodesAdded = 0;
await viewer.jumpToHit(1);
const samePage = {
  rectClientReads: metrics.rectClientReads,
  layerReplacements: metrics.layerReplacements,
  highlightNodesAdded: metrics.highlightNodesAdded,
  cachedRenderCalls: metrics.cachedRenderCalls,
  scrollFeedback: scrollFeedback.length,
};
const originalHits = viewer.hits;
viewer.hits = [...originalHits];
metrics.rectClientReads = 0;
metrics.layerReplacements = 0;
await viewer.paintHighlights(1);
const changedHitsRebuild = { rectClientReads: metrics.rectClientReads, layerReplacements: metrics.layerReplacements };
viewer.hits = originalHits;
viewer.clearHits();
viewer.hits = originalHits;
viewer.query = "term";
viewer.hitIndex = 1;
metrics.rectClientReads = 0;
metrics.layerReplacements = 0;
await viewer.paintHighlights(1);
const clearRebuild = { rectClientReads: metrics.rectClientReads, layerReplacements: metrics.layerReplacements };

// A non-cached cross-page destination must not report a scroll until its render
// promise settles. The real jumpToHit body owns the await and feedback order.
viewer.hits = [
  { pageNumber: 1, offset: 0, length: 4 },
  { pageNumber: 2, offset: 5, length: 4 },
];
viewer.hitIndex = 0;
viewer.hitGeneration += 1;
scrollFeedback.length = 0;
viewer.textMappings.delete(2);
let resolveRender;
viewer.renderPage = (pageNumber) => pageNumber === 2
  ? new Promise((resolve) => { resolveRender = () => { viewer.textMappings.set(2, mapping); resolve(); }; })
  : Promise.resolve();
const crossPageJump = viewer.jumpToHit(1);
await Promise.resolve();
const scrollsBeforeRender = scrollFeedback.length;
const approximateTop = scrollFeedback[0]?.top;
resolveRender();
await crossPageJump;
const crossPage = { scrollsBeforeRender, scrollsAfterRender: scrollFeedback.length, approximateTop, preciseTop: scrollFeedback.at(-1)?.top };

// A newer navigation or query must prevent a stale cold-page render from
// applying its precise scroll after the user has moved elsewhere.
scrollFeedback.length = 0;
viewer.textMappings.delete(2);
let resolveStale;
viewer.renderPage = () => new Promise((resolve) => { resolveStale = resolve; });
const staleJump = viewer.jumpToHit(1);
await Promise.resolve();
const feedbackBeforeNewNavigation = scrollFeedback.length;
viewer.hits = [{ pageNumber: 1, offset: 0, length: 4 }];
viewer.hitIndex = 0;
viewer.hitGeneration += 1;
viewer.textMappings.set(2, mapping);
viewer.renderPage = () => Promise.resolve();
await viewer.jumpToHit(0);
const feedbackAfterNewNavigation = scrollFeedback.length;
resolveStale();
await staleJump;
const staleResult = { feedbackBeforeNewNavigation, feedbackAfterNewNavigation, feedbackAfterStaleResolve: scrollFeedback.length };

console.log(JSON.stringify({ samePage, changedHitsRebuild, clearRebuild, crossPage, staleResult }));
assert.ok(samePage.rectClientReads < metrics.hitCount,
  `same-page navigation remeasured ${samePage.rectClientReads} ranges for ${metrics.hitCount} cached hits`);
assert.equal(samePage.layerReplacements, 0, `same-page navigation rebuilt the highlight layer ${samePage.layerReplacements} times`);
assert.ok(samePage.highlightNodesAdded < 10, `same-page navigation recreated ${samePage.highlightNodesAdded} highlight nodes`);
assert.equal(changedHitsRebuild.rectClientReads, metrics.hitCount, "new hit array should rebuild measured highlight geometry");
assert.equal(changedHitsRebuild.layerReplacements, 1, "new hit array should rebuild the highlight layer once");
assert.equal(clearRebuild.rectClientReads, metrics.hitCount, "clearing hits should invalidate cached highlight geometry");
assert.equal(clearRebuild.layerReplacements, 1, "cleared hits should rebuild the layer when restored");
assert.equal(crossPage.scrollsBeforeRender, 1, "cold cross-page navigation should scroll to the destination before render completes");
assert.equal(crossPage.approximateTop, pages[1].offsetTop, "cold navigation should initially align the target page");
assert.equal(crossPage.scrollsAfterRender, 2, "cold navigation should refine to the exact hit after rendering");
assert.equal(crossPage.preciseTop, pages[1].offsetTop + 100 - 64, "cold navigation should finish at the precise hit position");
assert.equal(staleResult.feedbackBeforeNewNavigation, 1, "cold navigation should provide immediate feedback");
assert.equal(staleResult.feedbackAfterStaleResolve, staleResult.feedbackAfterNewNavigation, "stale render resolution must not scroll back to an old hit");

// A pasted paragraph is not a search term: compiling it used to throw
// "Invalid regular expression: Stack overflow" and leave the find bar busy.
const { searchDocument } = await import("../public/search.mjs");
const onePage = [{ pageNumber: 1, text: "term word", normToRaw: [], normToRawEnd: [], rawLength: 9 }];
for (const length of [1000, 2000, 20_000]) {
  assert.doesNotThrow(() => searchDocument(onePage, "a".repeat(length)), `a ${length}-char query must not throw`);
}
assert.equal(searchDocument(onePage, "term").length, 1, "ordinary queries still find hits");
