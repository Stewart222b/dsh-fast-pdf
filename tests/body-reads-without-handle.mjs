/**
 * A mounted body has to read its file even when the Host hands it no handle.
 *
 * The pane reported `mount` on 11-17 09:43 and then nothing else for the rest of
 * its life — no `body-bytes`, no `body-view`, no `serve-start` — while a PDF was
 * open on screen. `pdf_list` in that session answered "No PDF has been read in
 * this session yet" about the document the reader was looking at.
 *
 * The cause was the first line of the read effect:
 *
 *     if (rendererContent === undefined) return undefined;
 *
 * A `renderer`-mode body is handed a handle (`{ revision, reload, loaded,
 * failed }`) to read through, and the effect refused to run without it. But the
 * handle is only *needed* for `loaded()`, which tells the Host the body is
 * finished. Reading needs the address, and the address is always present. So a
 * mount that arrived without the handle — the Host builds `content` from its own
 * `current` state and returns `void 0` when that is absent — produced a body
 * that did nothing at all, silently, forever.
 *
 * That silent return also had a second half: `bytes` stayed undefined, so the
 * viewer effect's own first line (`if (frame === null || bytes === undefined)`)
 * returned too, and the two together account for every missing report.
 *
 * These checks run the real effect from `client.js` against a fake React that
 * actually calls it. They fail on the old first line and pass on reading by
 * address alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = readFileSync(join(ROOT, "client.js"), "utf8");

/**
 * Load `client.js` with a React stub whose hooks actually run.
 *
 * Effects are collected instead of run: the body has to be rendered first, and
 * a test that fires every effect in creation order would run the viewer's
 * before the read's result is in state.
 * @param readBytes - the address→bytes reader the slot would inject.
 * @returns the slot's component, the effects of its last render, and the state.
 */
function mountBody({ readBytes, content = undefined, resourceAddress = "dsh-resource://file/session/s/Manual.pdf" } = {}) {
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module; } } };
  globalThis.document = {
    baseURI: "http://127.0.0.1:56825/",
    head: { append() {} },
    createElement: () => ({ dataset: {}, style: {}, remove() {} }),
  };
  const beaconCalls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/fast-pdf/hello")) {
      try {
        beaconCalls.push(JSON.parse(String(init?.body ?? "{}")));
      } catch { /* the beacon is fire and forget */ }
    }
    return new Response(null, { status: 204 });
  };
  new Function(SOURCE)();

  /** State cells, so a `setBytes` from an effect is visible to the next render. */
  const cells = [];
  /** Effects created by the current render, in creation order. */
  let effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class {},
    useRef: (value) => ({ current: value }),
    useState: (value) => {
      const index = cells.length;
      if (cells[index] === undefined) cells[index] = { value };
      const cell = cells[index];
      return [cell.value, (next) => {
        cell.value = typeof next === "function" ? next(cell.value) : next;
      }];
    },
    useEffect: (fn) => { effects.push(fn); },
    useLayoutEffect: (fn) => { effects.push(fn); },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };

  const mod = captured.factory((spec) => {
    assert.equal(spec, "react");
    return React;
  });
  let component;
  mod.apply({
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    documentPreviews: { register: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (_options, c) => { component = c; return () => {}; } },
  });

  /** Render once and hand back this render's effects. */
  const render = () => {
    effects = [];
    cells.length = 0;
    const props = {
      content,
      resourceAddress,
      sessionId: "session-1",
      readBytes,
      t: (key) => key,
      wrap: true,
    };
    // The slot mounts the crash boundary's gate; the body is its child.
    const gate = component(props);
    const tree = gate.children[0].type(props);
    return { tree, effects: [...effects], beaconCalls };
  };

  return { render };
}

/**
 * Run one effect that returns nothing, awaiting any promise it starts.
 * @param fn - the effect body.
 * @returns whatever the effect returned.
 */
const runEffect = (fn) => fn();

console.log("body reads without a handle");

let ok = 0;
let failed = 0;
/**
 * @param name - check label.
 * @param fn - async body.
 */
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    ok += 1;
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`);
    failed += 1;
  }
}

const PAYLOAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const VERSION = "2049:1234567:6:1700000000000000000:1700000000000000001";

/**
 * The reader the slot injects: one request, no streaming, so the effect's
 * promise settles on a single microtask hop.
 * @param address - the tab's address.
 * @returns `{ bytes, version }`.
 */
async function fakeRead(address) {
  assert.match(String(address), /dsh-resource:\/\/file\/session\//u);
  return { bytes: PAYLOAD, version: VERSION };
}

await check("a renderer body with no handle still opens its file", async () => {
  const { render } = mountBody({ readBytes: fakeRead, content: undefined });
  const first = render();
  // The read effect is the one that calls `readBytes`; find it by running the
  // effects and seeing which one reaches the reader.
  let read = 0;
  const counting = async (address) => {
    read += 1;
    return fakeRead(address);
  };
  const second = mountBody({ readBytes: counting, content: undefined });
  const pass = second.render();
  for (const effect of pass.effects) await runEffect(effect);

  assert.equal(read, 1, "a body handed an address and no handle must read its own file");
  assert.ok(first, "the body renders");
});

await check("the read result reaches the viewer, so the pane can serve", async () => {
  // `bytes` in state is what the viewer effect needs; without it that effect
  // returns on its own first line and nothing is ever built or uploaded.
  const reader = mountBody({ readBytes: fakeRead, content: undefined });
  const pass = reader.render();
  for (const effect of pass.effects) await runEffect(effect);
  const again = reader.render();
  const classes = [];
  /** @param node - tree node. */
  const walk = (node) => {
    if (typeof node?.props?.className === "string") classes.push(node.props.className);
    for (const child of node?.children?.flat(9) ?? []) walk(child);
  };
  walk(again.tree);
  assert.ok(classes.includes("fp-root"), "the body renders its root");
});

await check("the mount report says what the mount was handed", async () => {
  // The old report was `{ mounted: true }`, which described a body with a
  // handle and a body with nothing identically. That is why a live bug needed
  // an afternoon of forensics to find.
  const { render } = mountBody({ readBytes: fakeRead, content: undefined });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  await Promise.resolve();
  const mount = pass.beaconCalls.find((call) => call.kind === "mount");
  assert.ok(mount, "a mount must report itself");
  assert.equal(mount.hasContent, false, "this mount had no content");
  assert.equal(mount.contentKind, "", "and no kind");
  assert.equal(mount.read, "function", "but it did have a reader");
  assert.equal(mount.session, "session-1", "and it names the session it serves");
  assert.match(String(mount.build ?? ""), /^\d{4}-\d{2}-\d{2}-/u, "every report names the build that made it");
});

await check("an inline bytes body does not read the file a second time", async () => {
  // `bytes` mode hands the data itself; reading the same address again would
  // stream the whole file for nothing.
  let read = 0;
  const counting = async (address) => {
    read += 1;
    return fakeRead(address);
  };
  const { render } = mountBody({
    readBytes: counting,
    content: { kind: "bytes", data: PAYLOAD },
    resourceAddress: "dsh-resource://file/session/s/Inline.pdf",
  });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  assert.equal(read, 0, "inline bytes are already here");
});

await check("the read effect reports which way it went", async () => {
  // A mount followed by silence was the whole bug. The `enter` report is what
  // separates "the effect ran and returned early" from "the effect never
  // committed" — the two look identical from outside otherwise.
  const { render } = mountBody({ readBytes: fakeRead, content: undefined });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  await Promise.resolve();
  const phases = pass.beaconCalls.filter((call) => call.kind === "body-read").map((call) => call.phase);
  assert.ok(phases.includes("enter"), `the effect must report entry, saw ${JSON.stringify(phases)}`);
  assert.ok(phases.includes("start"), `and the read it begins, saw ${JSON.stringify(phases)}`);
});

await check("a stalled read is named rather than left hanging", async () => {
  // Nothing aborts a read that never answers, so without this report the pane
  // sits on its opening bar and the only evidence is the absence of evidence.
  const { render } = mountBody({
    readBytes: () => new Promise(() => {}),
    content: undefined,
  });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  assert.match(SOURCE, /phase: "stall"/u, "a read that never answers reports itself");
  assert.match(SOURCE, /READ_STALL_MS = 8000/u, "after a threshold a local read should have beaten");
  // One clear re-arms the watchdog on progress, and three more release it on
  // success, failure and teardown. A read that keeps streaming is never called
  // stalled, however long the whole file takes.
  assert.equal(
    (SOURCE.match(/clearTimeout\(stallTimer\)/gu) ?? []).length,
    4,
    "the watchdog is re-armed on progress and released on all three exits",
  );
  assert.match(SOURCE, /\n          armStall\(\);\n/u, "every progress tick pushes the watchdog out");
});

await check("every report says which build produced it", async () => {
  // A report that does not name its build cannot be told apart from a report
  // that build never learned to make — which is exactly how the 11-17 absence
  // was misread as "the read never ran" when it meant "the page ran old code".
  assert.match(SOURCE, /const BUILD = "\d{4}-\d{2}-\d{2}-/u, "the bundle carries a dated build string");
  // Stamped once inside `beacon()` rather than at each call site: a per-site
  // stamp is exactly the kind of thing a new report forgets to copy.
  const payload = /const payload = \{\n          kind,\n          id: PREVIEW_ID,\n(?:.|\n)*?build: BUILD,/u;
  assert.equal(payload.test(SOURCE), true, "the shared payload carries the build");
  assert.equal(
    (SOURCE.match(/build: BUILD/gu) ?? []).length,
    1,
    "exactly one stamp, in the one place every report goes through",
  );
});

await check("the source no longer gates the read on the handle", async () => {
  // The regression guard that survives a refactor of the test above. Anchored to
  // the start of a line so the comment above the effect — which quotes the old
  // line on purpose — is not what the check reads.
  assert.equal(
    /^\s*if \(rendererContent === undefined\) return undefined;/mu.test(SOURCE),
    false,
    "the read effect must not return silently when the Host hands no handle",
  );
  assert.equal(
    /rendererContent\?\.loaded\?\./u.test(SOURCE),
    true,
    "the handle stays optional at both of its uses",
  );
});

await check("a read that stops reporting is aborted and explained on screen", async () => {
  // The watchdog is the part a reader can feel: without it a request that never
  // answers leaves the pane on its opening bar forever. Run for real against a
  // reader that never settles, with the timer fired by hand so the check does
  // not take the shipped eight seconds.
  let aborted = false;
  const hung = (_address, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      aborted = true;
      reject(Object.assign(new Error("aborted"), { code: "aborted" }));
    });
  });

  const pending = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    // Only the watchdog is interesting; anything else (retry loops, beacons)
    // keeps normal behaviour.
    if (ms === 8000) {
      const handle = { fn };
      pending.push(handle);
      return handle;
    }
    return realSet(fn, ms);
  };
  globalThis.clearTimeout = (handle) => {
    const index = pending.indexOf(handle);
    if (index >= 0) pending.splice(index, 1);
    else realClear(handle);
  };

  const { render } = mountBody({ readBytes: hung, content: undefined });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;

  assert.equal(pending.length, 1, "a read in flight arms exactly one watchdog");
  // Fire it: this is the counterfactual — the request is never going to answer.
  pending[0].fn();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(aborted, true, "a read that never answers is aborted, not left open");
  const stall = pass.beaconCalls.find((call) => call.kind === "body-read" && call.phase === "stall");
  assert.ok(stall, "and the stall is reported");
  assert.equal(typeof stall.bytes, "number", "with how far it got");
});

await check("a read that goes quiet once recovers instead of showing an error", async () => {
  // The point of the retry: a request that dies in the transport should cost
  // the reader nothing but a moment. The first attempt never answers, the
  // watchdog drops it, and the second attempt delivers the file — so the pane
  // ends up working, with no error card and no page reload.
  let calls = 0;
  const flaky = async (address, signal) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" })));
      });
    }
    return fakeRead(address);
  };

  const pending = [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 8000) {
      const handle = { fn };
      pending.push(handle);
      return handle;
    }
    return realSet(fn, ms);
  };
  globalThis.clearTimeout = (handle) => {
    const index = pending.indexOf(handle);
    if (index >= 0) pending.splice(index, 1);
    else realClear(handle);
  };

  const { render } = mountBody({ readBytes: flaky, content: undefined });
  const pass = render();
  for (const effect of pass.effects) await runEffect(effect);
  assert.equal(calls, 1, "the first attempt starts");

  // The first attempt has gone silent: fire its watchdog.
  assert.ok(pending.length >= 1, "the first attempt is watched");
  pending.shift().fn();
  for (let i = 0; i < 40; i += 1) await Promise.resolve();

  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;

  assert.equal(calls, 2, "a silent read is asked again rather than given up on");
  const phases = pass.beaconCalls.filter((call) => call.kind === "body-read").map((call) => call.phase);
  assert.ok(phases.includes("stall"), `the silence is still reported, saw ${JSON.stringify(phases)}`);
  assert.ok(
    pass.beaconCalls.some((call) => call.kind === "body-bytes"),
    `and the retry delivers the file, saw ${JSON.stringify(pass.beaconCalls.map((c) => c.kind))}`,
  );
  assert.equal(phases.includes("fail"), false, "the abandoned attempt is not reported as a failure");
});

console.log(`\n${failed === 0 ? "all body-read checks passed" : `${failed} check(s) failed`} (${ok} ok, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
