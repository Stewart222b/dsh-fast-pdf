import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
const node = { style, append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {}, getContext: () => ({}) };
globalThis.document = { documentElement: { style }, head: node, body: node, createElement: () => node, createTextNode: () => ({}), addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { PdfViewer } = await import("../public/viewer.mjs");

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = source.indexOf("        const watchWheel = (module) => {");
assert.notEqual(start, -1, "client wires wheel input through watchWheel");
const end = source.indexOf("\n        };", start) + "\n        };".length;
assert.ok(end > start, "watchWheel function boundary exists");
const watchWheelSource = source.slice(start, end).replace("        const watchWheel", "const watchWheel");

const frame = {
  clientWidth: 700,
  clientHeight: 500,
  scrollTop: 0,
  scrollLeft: 0,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  listeners: new Map(),
  addEventListener(type, callback) { this.listeners.set(type, callback); },
  removeEventListener(type) { this.listeners.delete(type); },
};
const rafs = [];
let detachWheel = () => {};
let disposed = false;
let syncCalls = 0;
const viewer = Object.create(PdfViewer.prototype);
Object.assign(viewer, {
  zoom: 1,
  zoomMode: "100",
  pdf: {},
  pageEls: [
    { offsetTop: 0, offsetLeft: 0, offsetHeight: 1000, dataset: {}, style: {} },
    { offsetTop: 1000, offsetLeft: 0, offsetHeight: 1000, dataset: {}, style: {} },
  ],
  wrapEl: frame,
  pagesEl: { style: {} },
  pageGap: 14,
  pinchPageTransforms: new Map(),
  pageSizes: [
    { width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1 },
    { width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1 },
  ],
  baseWidth: 612,
  baseHeight: 792,
  cancelZoomAnimations() {},
  activeRenderJobs: new Set(),
  tasks: new Map(),
  textLayers: new Map(),
  renderQueue: [],
  renderJobs: new Map(),
  pageRenderLocks: new Map(),
  maxConcurrentRenders: 2,
  generation: 1,
  lastScrollAt: 0,
  priorityPage: null,
  onPinchCommitCalls: 0,
  setZoomCalls: [],
  renderStarts: [],
  setZoom(value) {
    this.setZoomCalls.push(value);
    this.zoom = Number(value) / 100;
    this.pumpRenderQueue();
  },
  onPinchCommit() { this.onPinchCommitCalls += 1; },
});
let cancelledTask = 0;
let cancelledText = 0;
let keptText = 0;
const activeJob = { pageNumber: 1, queued: false, cancelled: false };
viewer.activeRenderJobs.add(activeJob);
viewer.renderJobs.set(1, activeJob);
viewer.tasks.set(1, { cancel() { cancelledTask += 1; } });
viewer.textLayers.set(1, { cancel() { cancelledText += 1; } });
viewer.textLayers.set(3, { cancel() { keptText += 1; } });
let queuedResolve;
const queuedJob = {
  pageNumber: 2, queued: true, cancelled: false, force: false, key: "1.000",
  resolve() {}, reject() {},
};
queuedJob.promise = new Promise((resolve) => { queuedResolve = resolve; });
viewer.renderQueue.push(queuedJob);
viewer.renderJobs.set(2, queuedJob);
viewer.renderPageNow = (pageNumber) => {
  viewer.renderStarts.push(pageNumber);
  return Promise.resolve();
};
viewer.trimCache = () => {};
const watchWheel = new Function(
  "viewerRef", "frame", "disposed", "sync", "requestAnimationFrame", "cancelAnimationFrame",
  `let detachWheel = () => {};\n${watchWheelSource}\nreturn { watchWheel, getDetach: () => detachWheel };`,
)({ current: viewer }, frame, disposed, () => { syncCalls += 1; }, (cb) => { rafs.push(cb); return rafs.length; }, () => {});

watchWheel.watchWheel({ applyWheelZoomScale: (scale, deltaY) => scale * (deltaY < 0 ? 1.1 : 0.9) });
const dispatch = (deltaY, modifiers = { ctrlKey: true, metaKey: false }) => {
  let prevented = false;
  const event = { ...modifiers, deltaY, deltaMode: 0, preventDefault() { prevented = true; } };
  frame.listeners.get("wheel")(event);
  return { event, prevented };
};
const gesture = [dispatch(-3), dispatch(-3), dispatch(-3), dispatch(2)];
assert.ok(gesture.every(({ prevented }) => prevented), "modified wheel remains captured for document zoom");
assert.equal(viewer.setZoomCalls.length, 0, "active gesture must not commit full page layout");
assert.equal(viewer.pinch.target > 1, true, "wheel deltas update compositor preview target");
assert.equal(cancelledTask, 1, "gesture cancels active canvas work");
assert.equal(cancelledText, 1, "gesture cancels active text-layer work");
assert.equal(keptText, 0, "gesture retains already rendered text layers");
assert.equal(activeJob.cancelled, true, "active render job is marked stale");
assert.equal(viewer.pagesEl.style.transform !== "", true, "gesture applies compositor transform preview");
viewer.pumpRenderQueue();
assert.deepEqual(viewer.renderStarts, [], "queued render work stays paused while pinching");
await new Promise((resolve) => setTimeout(resolve, 190));
assert.equal(viewer.setZoomCalls.length, 1, "settle commits exactly one full layout");
assert.equal(viewer.onPinchCommitCalls, 1);
assert.deepEqual(viewer.renderStarts, [2], "queued target rendering resumes after the commit");

const plain = dispatch(-4, { ctrlKey: false, metaKey: false });
assert.equal(plain.prevented, false, "ordinary wheel scrolling remains untouched");
dispatch(-3);
assert.ok(viewer.pinch, "a new wheel gesture starts a preview");
watchWheel.getDetach()();
assert.equal(frame.listeners.has("wheel"), false, "wheel listener detaches cleanly");
assert.equal(viewer.pinch, null, "detaching cancels an unfinished preview");
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(viewer.setZoomCalls.length, 1, "detaching cannot commit a stale gesture later");
assert.equal(syncCalls, 0, "zoom preview does not force React state sync each wheel event");

// The resize watcher still commits outside gestures, but ignores incidental
// ResizeObserver notifications while the compositor preview changes overflow.
const widthStart = source.indexOf("        const watchWidth = () => {");
const widthEnd = source.indexOf("\n        };", widthStart) + "\n        };".length;
const widthSource = source.slice(widthStart, widthEnd).replace("        const watchWidth", "const watchWidth");
const widthRafs = [];
let resizeCallback;
globalThis.ResizeObserver = class {
  constructor(callback) { resizeCallback = callback; }
  observe() {}
};
let resizeZoomCalls = 0;
const widthViewer = { pinch: null, zoomMode: "page-width",
  // No pages yet: a viewport that cannot preview falls back to the full
  // commit, which is the path this check is about.
  previewResize() { return false; },
  setZoom(mode, options) {
    resizeZoomCalls += 1;
    assert.equal(mode, "page-width");
    assert.equal(options.silent, true);
  } };
const widthWatcher = new Function("viewerRef", "frame", "disposed", "sync", "requestAnimationFrame",
  `let resizeObserver;\n${widthSource}\nreturn watchWidth;`)(
    { current: widthViewer }, frame, false, () => {}, (fn) => { widthRafs.push(fn); return widthRafs.length; },
  );
widthWatcher();
resizeCallback();
widthRafs.shift()();
assert.equal(resizeZoomCalls, 1, "non-gesture resize still reapplies page-width zoom");
widthViewer.pinch = {};
resizeCallback();
widthRafs.shift()();
assert.equal(resizeZoomCalls, 1, "gesture-time resize is ignored until numeric zoom commits");

// The actual constructor callback updates only the display state; fit modes
// passed by cancelPinch restore the committed numeric zoom without parsing the
// mode string or changing the stored mode.
const previewMatch = source.match(/const updateZoomPreview = React\.useCallback\(\(previewScale\) => \{([\s\S]*?)\n      \}, \[\]\);/u);
assert.ok(previewMatch, "viewer exposes a stable zoom-preview callback");
const runPreview = new Function("previewScale", "viewerRef", "setView", previewMatch[1]);
let view = { page: 4, total: 20, scale: 1, mode: "page-width" };
const setZoomCallsBeforePreview = viewer.setZoomCalls.length;
const setView = (update) => { view = update(view); };
const viewerRef = { current: viewer };
runPreview(240, viewerRef, setView);
assert.equal(view.scale, 2.4, "live preview updates the visible percentage scale");
assert.equal(view.mode, "page-width", "live preview preserves the fit mode");
assert.equal(view.page, 4, "live preview preserves unrelated view state");
runPreview("page-width", viewerRef, setView);
assert.equal(view.scale, viewer.zoom, "cancel restores the committed numeric zoom");
assert.equal(view.mode, "page-width", "cancel does not replace the saved fit mode");
assert.equal(Number.isNaN(view.scale), false, "fit-mode cancellation cannot produce NaN");
assert.equal(viewer.setZoomCalls.length, setZoomCallsBeforePreview, "preview UI updates never call setZoom");
assert.match(source, /scale: viewer\.pinch\?\.target \?\? viewer\.resize\?\.target \?\? viewer\.zoom/u,
  "other viewer notifications preserve the active preview scale, gesture or resize");
assert.match(source, /viewer\.onZoomPreview = updateZoomPreview;\s*viewer\.onPinchCommit = sync;/u,
  "reattached viewers receive the current component's preview and commit callbacks");
console.log("wheel pinch: compositor preview, one settled commit, paused queue, and ordinary scrolling verified");
