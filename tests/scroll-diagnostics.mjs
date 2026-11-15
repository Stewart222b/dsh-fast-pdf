import assert from "node:assert/strict";
import { attach } from "../public/scroll-diagnostics.mjs";
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
globalThis.cancelAnimationFrame = clearTimeout;

const reports = [];
const removed = [];
const viewer = {
  zoom: 1,
  wrapEl: { clientWidth: 675, clientHeight: 836, removeEventListener: (...args) => removed.push(args) },
  onScroll() { return "scrolled"; },
  pinchZoom() { return "pinched"; },
  renderPageNow() { return Promise.resolve("rendered"); },
  renderVisible() { return Promise.resolve(); },
  getState() { return { page: 1 }; },
  setZoom(value) { this.zoom = value / 100; },
  onRenderPhase() { throw new Error("prior callback failure is isolated"); },
};
const original = {
  onScroll: viewer.onScroll,
  pinchZoom: viewer.pinchZoom,
  renderPageNow: viewer.renderPageNow,
  renderVisible: viewer.renderVisible,
  getState: viewer.getState,
  setZoom: viewer.setZoom,
  onRenderPhase: viewer.onRenderPhase,
};
const dispose = attach(viewer, (data) => reports.push(data));
const duplicateDispose = attach(viewer, () => assert.fail("duplicate instrumentation reported"));
const wrappedScroll = viewer.onScroll;
assert.notEqual(viewer.onScroll, original.onScroll);
assert.notEqual(viewer.renderPageNow, original.renderPageNow);
viewer.onScroll();
assert.equal(viewer.pinchZoom({deltaY: 1}), "pinched");
viewer.renderPageNow(1).then(() => {});
viewer.renderVisible();
viewer.getState();
viewer.setZoom(125);
viewer.onRenderPhase({ phase: "canvas", startedAt: performance.now(), ms: 240, syncMs: 6 });
viewer.onRenderPhase({ phase: "textMapping", startedAt: performance.now(), ms: 18, syncMs: 18 });
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(reports.length, 1);
assert.equal(reports[0].build, "2026-11-14-diag1");
assert.equal(reports[0].scrollEvents, 1);
assert.equal(reports[0].pinchEvents, 1);
assert.equal(reports[0].renderStarts, 1);
assert.equal(reports[0].visibleCalls, 1);
assert.equal(reports[0].setZoomCalls, 1);
assert.equal(reports[0].zoomChanges, 1);
assert.equal(reports[0].frameWidth, 675);
assert.equal(reports[0].renderPhaseMaxMs.canvas, 240);
assert.equal(reports[0].renderPhaseSyncMaxMs.canvas, 6);
assert.equal(reports[0].renderPhaseMaxMs.textMapping, 18);
dispose();
duplicateDispose();
assert.equal(viewer.onScroll, original.onScroll);
assert.equal(viewer.pinchZoom, original.pinchZoom);
assert.equal(viewer.renderPageNow, original.renderPageNow);
assert.equal(viewer.renderVisible, original.renderVisible);
assert.equal(viewer.getState, original.getState);
assert.equal(viewer.setZoom, original.setZoom);
assert.equal(viewer.onRenderPhase, original.onRenderPhase);
assert.equal(removed.at(-1)?.[0], "scroll");
assert.equal(removed.at(-1)?.[1], wrappedScroll);
viewer.onScroll();
await new Promise((resolve) => setTimeout(resolve, 550));
assert.equal(reports.length, 1, "dispose stops timing reports");
console.log("scroll diagnostics attach/dispose passed");
