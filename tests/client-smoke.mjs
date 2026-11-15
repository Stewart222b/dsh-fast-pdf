/**
 * Headless smoke test for both halves, runnable without the GUI:
 *
 *   node tests/client-smoke.mjs
 *
 * It cannot render a PDF (there is no canvas here), but it does catch the
 * mistakes that would otherwise cost a Host restart to find: a mistyped asset
 * name, a broken module graph in `public/`, a preview registration that would
 * not become the default, a route that leaks outside `public/`, and a body tree
 * that throws before the viewer ever mounts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, "public");
const failures = [];

/**
 * Run one named check, recording a failure instead of aborting the suite.
 * @param name - check label.
 * @param fn - async body.
 */
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log("host half");

await check("route answers the renderer and refuses escapes", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  assert.equal(mod.name, "fast-pdf");
  assert.deepEqual(mod.inject, ["webServer"]);
  const routes = [];
  const ctx = { effect: (fn) => { fn(); return () => {}; }, webServer: { register: (r) => { routes.push(r); return () => {}; } } };
  mod.apply(ctx);
  const route = routes.find((r) => r.kind === "prefix");
  assert.ok(route, "the asset route must be registered as a prefix route");
  assert.equal(route.path, "/fast-pdf");
  assert.ok(routes.some((r) => r.kind === "exact" && r.path === "/fast-pdf/translate"), "the translation route must be exact, so it wins over the asset prefix");

  /** @param path - request path; @returns status and headers. */
  const call = async (path, method = "GET", headers = {}) => {
    const out = { status: 0, headers: {}, length: 0 };
    await route.handler(
      { method, url: path, headers },
      {
        writeHead(status, h = {}) { out.status = status; out.headers = h; return this; },
        end(body) { out.length = body === undefined ? 0 : body.length ?? 0; },
      },
    );
    return out;
  };

  const viewer = await call("/fast-pdf/viewer.mjs");
  assert.equal(viewer.status, 200, "viewer.mjs must be served");
  assert.match(viewer.headers["content-type"], /text\/javascript/);
  assert.equal(viewer.length, readFileSync(join(PUBLIC, "viewer.mjs")).length);

  assert.equal((await call("/fast-pdf/viewer.css")).status, 200);
  assert.equal((await call("/fast-pdf/cmaps/Adobe-Japan1-UCS2.bcmap")).status, 200);
  assert.equal((await call("/fast-pdf/nope.mjs")).status, 404);
  assert.equal((await call("/fast-pdf/../index.js")).status, 404, "path escape must be refused");
  assert.equal((await call("/fast-pdf/%2e%2e/index.js")).status, 404, "encoded escape must be refused");
  assert.equal((await call("/fast-pdf/viewer.mjs", "POST")).status, 405);

  const again = await call("/fast-pdf/viewer.mjs", "GET", { "if-none-match": viewer.headers.etag });
  assert.equal(again.status, 304, "a matching ETag must revalidate");
  const head = await call("/fast-pdf/pdf.mjs", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.length, 0);
});

await check("translation route answers with the session's model", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const { targetLanguage } = await import(pathToFileURL(join(ROOT, "translate.js")).href);
  assert.equal(targetLanguage("Selected passage in English."), "Chinese");
  assert.equal(targetLanguage("这是一段选中的中文"), "English");

  const seen = [];
  const llm = {
    async resolveModelInfo() { return {}; },
    async *stream(request) {
      seen.push(request);
      yield { type: "text-delta", text: "译文" };
    },
  };
  // The shape a chat turn is routed by: the session's own provider/model.
  const agents = {
    get: (id) => (id === "s-1"
      ? { session: { requestHeader: () => ({ config: { provider: "p-1", model: "m-1" } }) } }
      : undefined),
    list: () => [],
  };
  const routes = [];
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    get: (name) => (name === "llm" ? llm : name === "agents" ? agents : undefined),
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
  };
  mod.apply(ctx);
  const translate = routes.find((r) => r.path === "/fast-pdf/translate");
  assert.ok(translate, "translation route missing");

  /** @param body - JSON payload; @param method - HTTP method. @returns status and parsed body. */
  const post = async (body, method = "POST", headers = { "x-dsh-fast-pdf": "translate" }) => {
    const out = { status: 0, headers: {}, body: undefined };
    const req = {
      method,
      url: "/fast-pdf/translate",
      headers,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body), "utf8");
      },
    };
    await translate.handler(req, {
      writeHead(status, headers = {}) { out.status = status; out.headers = headers; return this; },
      end(payload) {
        if (payload === undefined) return;
        const text = payload.toString("utf8");
        // Refusals answer plain text; only the JSON replies are parsed.
        out.body = /json/.test(out.headers["content-type"] ?? "") ? JSON.parse(text) : undefined;
        out.text = text;
      },
    });
    return out;
  };

  const ok = await post({ text: "Hello world", sessionId: "s-1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(ok.body.text, "译文");
  assert.equal(ok.body.target, "Chinese");
  assert.equal(ok.body.provider, "p-1", "the session's provider must be used");
  assert.equal(ok.body.model, "m-1");
  assert.match(seen[0].system, /Chinese/, "the target language must reach the prompt");
  assert.equal(seen[0].messages[0].content[0].text, "Hello world");
  assert.equal(seen[0].sessionId, "s-1", "the session id must travel with the call");

  const empty = await post({ text: "   " });
  assert.equal(empty.body.ok, false);

  const wrongMethod = await post({ text: "x" }, "GET");
  assert.equal(wrongMethod.status, 405, "the translation route only accepts POST");

  const bare402 = await post({ text: "x" }, "POST", {});
  assert.equal(bare402.status, 403, "a request without the marker header must be refused");
  const crossSite = await post({ text: "x" }, "POST", { "x-dsh-fast-pdf": "translate", "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403, "a cross-site post must be refused");

  // Without an llm service the route must still answer, not throw.
  const bare = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    get: (name) => (name === "agents" ? agents : undefined),
    webServer: { register: (r) => { bare.push(r); return () => {}; } },
  });
  const bareRoute = bare.find((r) => r.path === "/fast-pdf/translate");
  const out = { status: 0, body: undefined };
  await bareRoute.handler({ method: "POST", url: "/fast-pdf/translate", headers: { "x-dsh-fast-pdf": "translate" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ text: "Hello", sessionId: "s-1" }), "utf8"); } }, {
    writeHead(status) { out.status = status; return this; },
    end(payload) { out.body = JSON.parse(payload.toString("utf8")); },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false, "a missing model service must be reported, not thrown");
  assert.match(String(out.body.message), /llm/, "the message must name what was missing");
});

console.log("renderer module graph");

await check("every public module parses and viewer.mjs exports its surface", async () => {
  const entries = await readdir(PUBLIC, { withFileTypes: true });
  const modules = entries.filter((e) => e.isFile() && e.name.endsWith(".mjs")).map((e) => e.name);
  for (const name of modules) {
    // `node --check` on the source catches syntax errors even where a browser
    // global would abort evaluation.
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["--check", join(PUBLIC, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr?.trim()}`);
  }
  // pdf_viewer.mjs reads `document` and `requestAnimationFrame` at module scope,
  // so importing the graph needs the smallest possible stub.
  const style = { setProperty() {}, getPropertyValue() { return ""; }, removeProperty() {} };
  const node = { style, append() {}, appendChild() {}, setAttribute() {}, dataset: {}, remove() {} };
  globalThis.document = {
    documentElement: { style },
    head: node,
    body: node,
    createElement: () => node,
    createTextNode: () => ({}),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const viewer = await import(pathToFileURL(join(PUBLIC, "viewer.mjs")).href);
  for (const name of ["PdfViewer", "ViewHistory", "stepZoomPercent", "applyWheelZoomScale", "searchDocument"]) {
    assert.equal(typeof viewer[name], "function", `viewer.mjs must export ${name}`);
  }
  const pdfjs = await import(pathToFileURL(join(PUBLIC, "pdf.mjs")).href);
  assert.equal(pdfjs.version, "6.3.289", "pdf.js build must match the version the port targets");
  assert.match(pdfjs.GlobalWorkerOptions.workerSrc, /pdf\.worker\.mjs$/, "worker must resolve next to pdf.mjs");
});

console.log("browser half");

await check("registration takes the default seat and keys the body", async () => {
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  globalThis.document = { baseURI: "http://127.0.0.1:56825/", head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) };
  new Function(readFileSync(join(ROOT, "client.js"), "utf8"))();
  assert.equal(captured.id, "dsh-fast-pdf");

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const React = {
    createElement,
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
  };
  const mod = captured.factory((spec) => {
    assert.equal(spec, "react", `unexpected require(${spec})`);
    return React;
  });
  assert.deepEqual(mod.inject, ["slots", "locale", "documentPreviews"]);

  const registrations = [];
  let body;
  let slotOptions;
  const ctx = {
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    documentPreviews: { register: (def) => { registrations.push(def); return () => {}; } },
    slots: { inject: (_name, fn) => fn(), register: (options, c) => { slotOptions = options; body = c; return () => {}; } },
  };
  mod.apply(ctx);

  const def = registrations[0];
  assert.equal(def.extensions.includes("pdf"), true);
  assert.equal(def.binaryExtensions.includes("pdf"), true);
  // `renderer` is the Host's "the body brings its own content" mode. With
  // `bytes-complete` the Host reads the whole file and refuses anything above
  // `workspaceFiles.maxFileBytes` (32 MiB) — and when that read fails it never
  // mounts the body at all, so no plugin-side setting could have helped.
  assert.equal(def.loading, "renderer");
  assert.equal(def.wrap, false);
  assert.equal("priority" in def, false, "omitting priority is what puts this preview above the built-in one");
  assert.equal(typeof def.title, "function");

  // What the slot mounts is the crash boundary's gate; the body is its child,
  // so the first render is one hop further in than the registration.
  const props = { content: { kind: "bytes", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, t: (key) => key };
  const gate = body(props);
  assert.equal(gate.type?.name, "BodyBoundary", "the body must be registered behind the crash boundary");
  const tree = gate.children[0].type(props);
  assert.equal(tree.type, "div");
  assert.equal(tree.props.className, "fp-root");

  /** @param className - class to look for; @returns the first matching node. */
  const findClass = (className, node = tree) => {
    if (node?.props?.className === className) return node;
    for (const child of node?.children?.flat(9) ?? []) {
      const hit = findClass(className, child);
      if (hit) return hit;
    }
    return undefined;
  };
  // The viewer measures the frame and observes the page hosts, so both have to
  // exist on the very first render — not after the first bitmap lands.
  assert.ok(findClass("fp-frame"), "the scrolling frame must render immediately");
  // The pages host is made by the viewer effect, not by this render: a document
  // that is still open keeps its own container and the effect re-attaches it,
  // so React must not own that node (see `fp-frame` above). The class matters
  // all the same — pdf.js's own stylesheet keys off it — so it is asserted on
  // the source that creates it.
  assert.ok(
    /pages\.className = "fp-pages pdfViewer"/.test(readFileSync(join(ROOT, "client.js"), "utf8")),
    "the page host must carry pdf.js's container class",
  );
  assert.equal(findClass("fp-status") !== undefined, true, "the loading overlay must be present while opening");

  // Ctrl+F has to land on our own finder: the page is a canvas, so the browser
  // would search a document it cannot see. That needs two things wired at once.
  assert.equal(typeof tree.props.onKeyDown, "function", "the pane must listen for the chord");
  assert.equal(findClass("fp-frame").props.tabIndex, -1, "the frame must be focusable, or no keydown ever reaches it");

  // The running app calls `inject` with the session only: the slot carries an
  // `actions` bag for registrations that bring a `store`, and this one does not.
  // Reading `actions.forget` on the way used to throw inside the mount effect and
  // left the pane blank with nothing on screen to explain it.
  const injected = slotOptions.inject("sess-46");
  assert.equal(injected.sessionId, "sess-46");
  assert.equal(typeof injected.retainTab, "function");
  injected.retainTab("tab-1", new AbortController().signal);
  assert.equal(typeof injected.readBytes, "function", "the body reads the file through this");
  assert.equal(slotOptions.inject("sess-46").readBytes, injected.readBytes,
    "host rerenders must not restart the file-reading effect by replacing readBytes");
});

await check("a big PDF is streamed through the host half, past the Host's whole-file cap", async () => {
  // The 32 MiB cap lives on `workspaceFiles` whole-file reads, and that service
  // is not reachable from a third-party client plugin in this build (measured on
  // 0.2.1-rc.3: `ctx.remote` exists, `ctx.remote.workspaceFiles` does not). So
  // the body reads through this plugin's own `POST /fast-pdf/file`, which
  // streams the file back with a `content-length`.
  const payload = new Uint8Array(3_000_001);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const ADDRESS = "dsh-resource://file/session/sess-1/C%3A/Users/a/big.pdf";

  /** A fresh module instance, so the reader is the one this build ships. */
  const freshReader = () => {
    let captured;
    globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
    globalThis.document = { baseURI: "http://127.0.0.1:56825/", head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) };
    new Function(readFileSync(join(ROOT, "client.js"), "utf8"))();
    const mod = captured.factory((spec) => {
      assert.equal(spec, "react");
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        Component: class {},
        useRef: (value) => ({ current: value }),
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useLayoutEffect: () => {},
        useCallback: (fn) => fn,
      };
    });
    let options;
    mod.apply({
      effect: (fn) => fn(),
      locale: { bind: () => (key) => key, register: () => () => {} },
      documentPreviews: { register: () => () => {} },
      slots: { inject: (_name, fn) => fn(), register: (o) => { options = o; return () => {}; } },
    });
    return options.inject("sess-1").readBytes;
  };

  const calls = [];
  const realFetch = globalThis.fetch;
  /** @param reply - `() => Response`, or a thrower. */
  const withFetch = async (reply, run) => {
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      // The page reports itself to `/fast-pdf/hello` on apply; only reads count.
      if (!href.endsWith("/fast-pdf/file")) return new Response(null, { status: 204 });
      calls.push({
        url: href,
        method: init?.method,
        marker: init?.headers?.["x-dsh-fast-pdf"],
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return reply();
    };
    try {
      return await run(freshReader());
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const chunks = [payload.slice(0, 2_000_000), payload.slice(2_000_000)];
  const seen = [];
  const result = await withFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-length": String(payload.length) } },
      ),
    (read) => read(ADDRESS, new AbortController().signal, (ratio) => seen.push(ratio)),
  );
  assert.equal(calls.length, 1, "one streaming request, not a round trip per window");
  assert.match(calls[0].url, /\/fast-pdf\/file$/u);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].marker, "file", "the route refuses a request without this marker");
  assert.deepEqual(
    calls[0].body,
    { address: ADDRESS },
    "the address travels whole: the host half resolves it, this side never guesses a path",
  );
  assert.equal(result.bytes.length, payload.length, "every chunk lands in the buffer");
  assert.equal(Buffer.compare(Buffer.from(result.bytes), Buffer.from(payload)), 0, "the bytes are unchanged");
  assert.equal(result.version, 1, "the body reports a version so the pane stops treating the tab as loading");
  assert.equal(seen.length >= 2, true, "progress is reported while bytes arrive");
  assert.equal(seen.every((ratio) => ratio > 0 && ratio <= 1), true, "and stays a fraction");
  assert.equal(seen.at(-1), 1, "and ends at one");

  // Our own ceiling, now that the Host's no longer applies: the route answers
  // 413 with the real size and the body is expected to name it.
  await withFetch(
    () =>
      new Response(JSON.stringify({ ok: false, code: "too-large", size: 300 * 1024 * 1024 }), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    (read) =>
      assert.rejects(
        () => read(ADDRESS, new AbortController().signal, () => {}),
        (error) => error?.code === "too-large" && error.size === 300 * 1024 * 1024,
        "an oversized file is refused by name, not by hanging",
      ),
  );

  // Something that is not a file address at all is reported and never asked for.
  const before = calls.length;
  await withFetch(
    () => {
      throw new Error("should not be called");
    },
    (read) =>
      assert.rejects(
        () => read("https://example.com/a.pdf", new AbortController().signal, () => {}),
        (error) => error?.code === "address",
        "a non-file address is reported, not guessed at",
      ),
  );
  assert.equal(calls.length, before, "and nothing is asked of the host half");

  // Both scopes the Host writes are accepted, including the one that carries an
  // absolute path rather than a session: the address travels whole.
  await withFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }),
    async (read) => {
      const absolute = "dsh-resource://file/absolute/C%3A/Users/a/big.pdf";
      const relative = "dsh-resource://file/session/sess-1/docs/rel.pdf";
      assert.equal((await read(absolute, new AbortController().signal, () => {})).bytes.length, 3);
      assert.equal((await read(relative, new AbortController().signal, () => {})).bytes.length, 3);
    },
  );
  assert.deepEqual(
    calls.slice(-2).map((call) => call.body.address),
    ["dsh-resource://file/absolute/C%3A/Users/a/big.pdf", "dsh-resource://file/session/sess-1/docs/rel.pdf"],
    "a relative session path is sent as-is and resolved by the host half",
  );

  // A host half that is not loaded at all is a message, not a blank pane.
  await withFetch(
    () => {
      throw new Error("Failed to fetch");
    },
    (read) =>
      assert.rejects(
        () => read(ADDRESS, new AbortController().signal, () => {}),
        (error) => error?.code === "unavailable",
        "a missing route reads as unavailable",
      ),
  );
});

console.log("takeover");

await check("the builtin registry puts this preview ahead of the built-in one", async () => {
  // The ranking below is copied verbatim from
  // @deepseek-ai/dsh-client-ui-sidebar-documentpreview 0.2.1-rc.3 — regions
  // `client/document/suffix.js`, `client/document/registry.js` and the pane
  // owner's one-line selection. Copying beats importing: that package is not a
  // dependency of this plugin, and what has to be pinned is the exact
  // expression `rank: definition.priority === "builtin" ? 0 : 1`, sorted
  // descending. If the Host ever changes it, this test is where it shows.
  const normalizeSuffix = (extension) => extension.toLowerCase().replace(/^\./u, "");
  const documentFileName = (path) => {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  };
  const matchedSuffixLength = (name, extensions) =>
    Math.max(
      0,
      ...extensions
        .map(normalizeSuffix)
        .filter((extension) => name.endsWith(`.${extension}`))
        .map((extension) => extension.length),
    );
  const matchingDocumentPreviews = (definitions, path) => {
    const name = documentFileName(path);
    return definitions
      .map((definition, order) => ({
        definition,
        order,
        rank: definition.priority === "builtin" ? 0 : 1,
        length: matchedSuffixLength(name, definition.extensions),
      }))
      .filter((candidate) => candidate.length > 0)
      .sort(
        (left, right) =>
          right.rank - left.rank || right.length - left.length || left.order - right.order,
      )
      .map((candidate) => candidate.definition);
  };
  const binaryDocumentPath = (definitions, path) => {
    const name = documentFileName(path);
    return definitions.some((definition) => matchedSuffixLength(name, definition.binaryExtensions ?? []) > 0);
  };
  class DocumentPreviewRegistry {
    registered = new Map();
    listeners = new Set();
    snapshot = [];
    getSnapshot = () => this.snapshot;
    subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    register(definition) {
      if (this.registered.has(definition.id)) {
        throw new Error(`documentPreviews: duplicate implementation "${definition.id}"`);
      }
      const declared = new Set(definition.extensions.map(normalizeSuffix));
      for (const extension of definition.binaryExtensions ?? []) {
        if (!declared.has(normalizeSuffix(extension))) {
          throw new Error(`documentPreviews: "${definition.id}" declares binary suffix "${extension}" outside its extensions`);
        }
      }
      this.registered.set(definition.id, definition);
      this.publish();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        this.registered.delete(definition.id);
        this.publish();
      };
    }
    candidates(path) {
      return matchingDocumentPreviews(this.snapshot, path);
    }
    publish() {
      this.snapshot = [...this.registered.values()];
      for (const listener of this.listeners) listener();
    }
  }
  /** The built-in renderer's own registration, verbatim from the same package. */
  const builtinPdfDefinition = (title) => ({
    id: "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf",
    extensions: ["pdf"],
    binaryExtensions: ["pdf"],
    priority: "builtin",
    title,
    loading: "bytes-complete",
    wrap: false,
  });
  /** Which implementation a tab renders: its own choice first, else the first candidate. */
  const selectedRenderer = (candidates, state) =>
    candidates.find((candidate) => candidate.id === state?.rendererId) ?? candidates[0];

  // The real bundle, mounted against the real ctx a client plugin receives.
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  globalThis.document = {
    baseURI: "http://127.0.0.1:56825/",
    head: { append() {} },
    createElement: () => ({ dataset: {}, remove() {} }),
  };
  new Function(readFileSync(join(ROOT, "client.js"), "utf8"))();
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
  };
  const mod = captured.factory(() => React);
  const registrations = [];
  mod.apply({
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    documentPreviews: { register: (definition) => { registrations.push(definition); return () => {}; } },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  });
  const mine = registrations[0];
  assert.ok(mine, "the bundle must register a preview");

  // The built-in registers first, exactly as bundle order has it: its package
  // loads before this plugin. Rank still wins over registration order.
  const registry = new DocumentPreviewRegistry();
  registry.register(builtinPdfDefinition(() => "PDF"));
  registry.register(mine);

  const candidates = registry.candidates("/w/session/uploads/report.PDF");
  assert.deepEqual(candidates.map((definition) => definition.id), [
    "dsh-fast-pdf/pdf",
    "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf",
  ], "this preview takes the default seat and the built-in stays reachable");
  assert.equal(selectedRenderer(candidates, undefined).id, "dsh-fast-pdf/pdf");
  assert.equal(
    selectedRenderer(candidates, { rendererId: "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf" }).id,
    "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf",
    "a tab that picked the built-in keeps it",
  );
  assert.equal(
    selectedRenderer(candidates, { rendererId: "dsh-fast-pdf/pdf" }).id,
    "dsh-fast-pdf/pdf",
    "and a tab that picked this one keeps it too",
  );

  // The owner only shows "this file type has no renderer" when no registration
  // claims the suffix as binary; this preview has to keep claiming `pdf`.
  assert.equal(binaryDocumentPath(registry.getSnapshot(), "a.pdf"), true);
  assert.deepEqual(
    registry.candidates("/w/notes.md").map((definition) => definition.id),
    [],
    "other suffixes must not match",
  );

  // Disposing the registration (plugin unload) puts the built-in back in front,
  // which is the whole story of "the Host keeps working without this plugin".
  const dispose = registry.register({ ...mine, id: "dsh-fast-pdf/second" });
  assert.equal(registry.candidates("a.pdf").at(1).id, "dsh-fast-pdf/second");
  dispose();
  assert.equal(registry.candidates("a.pdf").length, 2);
});

await check("the bundle only requires what the shell seeds", async () => {
  // The client loader hands a factory a `require` backed by a closed table of
  // seed modules; anything else throws at load time. A typo here is a plugin
  // that silently never mounts, so the contract is worth asserting.
  const SEEDS = new Set([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "zod",
    "@tanstack/react-virtual",
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-dockkit",
  ]);
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const specs = [...source.matchAll(/\brequire\("([^"]+)"\)/gu)].map((match) => match[1]);
  assert.ok(specs.length > 0, "the bundle must require at least React");
  const strangers = specs.filter((spec) => !SEEDS.has(spec));
  assert.deepEqual(strangers, [], `not a seed module: ${strangers.join(", ")}`);
  // The loader evaluates the file as a script, so a top-level import/export
  // would be a syntax error rather than a lazy load.
  const esm = source.split("\n").filter((line) => /^(import|export)\s/u.test(line));
  assert.deepEqual(esm, [], `top-level ESM statements: ${esm.join(" | ")}`);
});

await check("the toolbar takes the Host's primitives when they are seeded", async () => {
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  globalThis.document = { baseURI: "http://127.0.0.1:56825/", head: { append() {} }, createElement: () => ({ dataset: {}, remove() {} }) };
  new Function(readFileSync(join(ROOT, "client.js"), "utf8"))();

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const React = {
    createElement,
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
  };
  const HostButton = function HostButton() {};
  const HostTooltip = function HostTooltip() {};
  const HostIcon = function HostIcon() {};
  const copied = [];
  const primitives = {
    Button: HostButton,
    Tooltip: HostTooltip,
    writeClipboard: (text) => copied.push(text),
    IconSearchOutlineRegular: HostIcon,
    IconChevronLeftOutlineRegular: HostIcon,
    IconChevronRightOutlineRegular: HostIcon,
    IconPlusOutlineRegular: HostIcon,
    IconCloseOutlineRegular: HostIcon,
    IconFlatListOutlineRegular: HostIcon,
    IconChevronUpOutlineRegular: HostIcon,
    IconChevronDownOutlineRegular: HostIcon,
    IconCopyOutlineRegular: HostIcon,
    IconRefreshOutlineRegular: HostIcon,
  };
  const mod = captured.factory((spec) => {
    if (spec === "react") return React;
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require(${spec})`);
  });

  let body;
  const ctx = {
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    documentPreviews: { register: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (_o, c) => { body = c; return () => {}; } },
  };
  mod.apply(ctx);

  // `createElement` only records what it is given, so the plugin's own
  // components are still elements here. Expanding everything that is not one of
  // the faked Host components is enough to see what the toolbar actually builds.
  const HOST_PARTS = new Set([HostButton, HostTooltip, HostIcon]);
  /** @param node - recorded element; @returns the tree with local components expanded. */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function" && node.type.prototype?.render !== undefined) {
      // A class component: build it, then expand whatever its first render
      // produced (the boundary renders its children while nothing has thrown).
      const kids = node.children ?? [];
      // React hands a single child through as the child itself, not a list.
      const instance = new node.type({ ...(node.props ?? {}), children: kids.length === 1 ? kids[0] : kids });
      instance.state ??= {};
      return expand(instance.render());
    }
    if (typeof node.type === "function" && !HOST_PARTS.has(node.type)) return expand(node.type(node.props ?? {}));
    const fromProps = node.props?.children;
    const kids = [...(node.children ?? []), ...(Array.isArray(fromProps) ? fromProps : fromProps == null ? [] : [fromProps])].flat(9);
    return { type: node.type, props: { ...node.props, children: undefined }, children: kids.map(expand) };
  };
  /** @param node - tree node; @returns its child nodes. */
  const kidsOf = (node) => (node.children ?? []).flat(9);
  /** @param node - tree node; @param hits - accumulator; @returns every Host Button in the tree. */
  const walk = (node, hits = []) => {
    if (node === null || node === undefined) return hits;
    if (node.type === HostButton) hits.push(node);
    for (const child of kidsOf(node)) walk(child, hits);
    return hits;
  };
  const tree = expand(body({ content: { kind: "bytes", data: new Uint8Array([0x25]) }, t: (key) => key }));
  const buttons = walk(tree);
  // Toolbar: find, history back/forward, page prev/next, zoom out/in, the fit
  // toggle and the overflow menu. The outline button only exists once the
  // document has one; document properties moved into that menu (a dialog, not a
  // mode, and this pane is too narrow to give it an icon of its own).
  assert.equal(buttons.length, 9, `toolbar should be the Host's Button: got ${buttons.length}`);
  const labels = buttons.map((node) => node.props["aria-label"]);
  assert.deepEqual(labels, [
    "find",
    "historyBack",
    "historyForward",
    "previous",
    "next",
    "zoomOut",
    "zoomIn",
    // The fit button names what it will do: page-width is the current mode, so
    // it offers page-fit.
    "fitPage",
    "more",
  ]);
  for (const node of buttons) {
    assert.equal(node.props.size, "sm", "the toolbar rides on the Host's small size");
    assert.equal(node.props.variant, "ghost", "and on its ghost variant");
    assert.equal(node.props.title, node.props["aria-label"], "the label doubles as the native tooltip");
  }
  // Icons: the Host set where it has one, a drawn path where it does not.
  const iconKinds = buttons.map((node) => (node.props.icon?.type === HostIcon ? "host" : "drawn"));
  assert.deepEqual(iconKinds, [
    "host",
    "drawn",
    "drawn",
    "host",
    "host",
    "drawn",
    "host",
    "drawn",
    // The overflow menu is three drawn dots: the Host set has no "more" glyph.
    "drawn",
  ]);
  // Every one of them is offered through the Host's tooltip.
  const tooltips = [];
  const collect = (node) => {
    if (node === null || node === undefined) return;
    if (node.type === HostTooltip) tooltips.push(node);
    for (const child of kidsOf(node)) collect(child);
  };
  collect(tree);
  assert.equal(tooltips.length, 9, "each toolbar button must sit in a Host tooltip");
  assert.equal(tooltips[0].props.side, "top");
  assert.equal(typeof primitives.writeClipboard, "function");
  assert.deepEqual(copied, [], "nothing is copied until the reader asks");
});

await check("the overflow menu closes before the sheet, and opens it", async () => {
  // A popover inside a popover needs one order, written down once: Escape takes
  // the menu first, and the sheet only answers the key when the menu is gone.
  // Reading the source is the honest way to check an order — a stub cannot press
  // the key twice and watch which one closed.
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const start = source.indexOf("const onRootKeyDown");
  assert.notEqual(start, -1, "the pane still handles keys on its root");
  const handler = source.slice(start, start + 1200);
  const menuFirst = handler.indexOf('event.key === "Escape" && menu');
  const sheetSecond = handler.indexOf('event.key === "Escape" && sheet !== null');
  assert.notEqual(menuFirst, -1, "Escape has to consult the menu");
  assert.notEqual(sheetSecond, -1, "and the sheet");
  assert.ok(menuFirst < sheetSecond, "the menu is answered before the sheet");
  assert.match(handler.slice(menuFirst, sheetSecond), /setMenu\(false\)[\s\S]*return;/u);

  // Settings and document properties both live in the overflow menu. Each retires
  // the menu before opening its own panel.
  const menuAt = source.indexOf('className: "fp-menu"');
  assert.notEqual(menuAt, -1, "the menu element is still there");
  const menu = source.slice(menuAt, menuAt + 900);
  assert.equal(menu.match(/className: "fp-menu-row"/gu)?.length, 2, "settings and properties rows are in the menu");
  assert.match(menu, /className: "fp-menu-row",[\s\S]{0,140}onClick: \(\) => void openSettings\(\)/u);
  assert.match(menu, /setMenu\(false\);[\s\S]{0,40}void toggleSheet\(\);/u);
  // The open state rides on `pressed`, not on hand-written ARIA: the Host's
  // Button forwards `aria-pressed` and drops everything else it does not know
  // (measured in the browser: `aria-expanded` and `aria-haspopup` both read null).
  assert.match(source, /label: t\("more"\),[\s\S]{0,400}pressed: menu,/u, "the ⋯ carries the open state");
  // The carets in the outline are plain buttons, so their aria-expanded works;
  // the toolbar one goes through the Host's Button and must not pretend.
  const moreAt = source.indexOf("fp-more");
  assert.doesNotMatch(source.slice(moreAt, moreAt + 1200), /"aria-expanded"/u, "no ARIA the primitive would drop");
});

await check("settings persist the three reader preferences and apply them at the right time", async () => {
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  assert.ok(source.includes('updatePreference("translationLanguage"'), "language choice saves its preference");
  assert.ok(source.includes('updatePreference("defaultZoom"'), "zoom choice saves its preference");
  assert.ok(source.includes('updatePreference("pageGap"'), "page gap saves its preference");
  assert.match(source, /if \(key === "pageGap"\)[\s\S]{0,140}setPageGap\?\./u,
    "changing spacing applies it to the open viewer immediately");
  const savedPlaceAt = source.indexOf("viewer.applyReadingPosition(place)");
  const defaultZoomAt = source.indexOf("viewer.setZoom(savedPreferences.defaultZoom");
  assert.ok(savedPlaceAt >= 0 && defaultZoomAt > savedPlaceAt,
    "new documents use the preferred zoom while saved reading positions win on reopen");
  assert.match(source, /targetLanguage: preferencesRef\.current\.translationLanguage/u,
    "translation requests carry the selected language");
  assert.ok(source.includes('role: "dialog"') && source.includes('"aria-modal": "true"'),
    "the settings panel is exposed as a modal dialog");
  assert.match(source, /event\.key === "Tab"[\s\S]{0,600}focusable\[0\][\s\S]{0,400}last\.focus\(\)/u,
    "Tab and Shift+Tab stay inside the settings dialog");
  assert.match(source, /event\.key === "Escape"[\s\S]{0,100}event\.stopPropagation\(\)/u,
    "the dialog closes itself once on Escape");
  assert.match(source, /const closeSettings = React\.useCallback\(\(\) => \{[\s\S]{0,180}moreRef\.current\?\.querySelector\("button"\)\?\.focus\(\)/u,
    "closing settings restores focus to the overflow trigger");
});

await check("document properties show basic rows before metadata and ignore stale replies", async () => {
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const closeStart = source.indexOf("const closeSheet = React.useCallback(() => {");
  const toggleStart = source.indexOf("const toggleSheet = React.useCallback(async () => {");
  const closeEnd = source.indexOf("}, []);", closeStart) + "}, []);".length;
  const toggleEnd = source.indexOf("}, [closeSheet]);", toggleStart) + "}, [closeSheet]);".length;
  assert.ok(closeStart >= 0 && toggleStart >= 0 && closeEnd > closeStart && toggleEnd > toggleStart);
  const scopeNames = ["React", "sheetRequestRef", "sheetRef", "setSheet", "viewerRef", "loadHelper", "navigator", "copy", "console", "closeSheet"];
  const scopeValues = [
    { useCallback: (fn) => fn },
    { current: 0 },
    { current: null },
    (value) => { calls.push(value); },
    { current: null },
    async () => ({ buildDocumentPropertyRows: (snapshot) => [snapshot] }),
    { language: "en" },
    { current: {} },
    { error() {} },
    null,
  ];
  const closeFactory = new Function(...scopeNames, `return (${source.slice(closeStart, closeEnd).replace(/^const closeSheet = /u, "").replace(/;$/u, "")});`);
  const toggleFactory = new Function(...scopeNames, `return (${source.slice(toggleStart, toggleEnd).replace(/^const toggleSheet = /u, "").replace(/;$/u, "")});`);
  let resolveMetadata;
  const current = {
    name: "manual.pdf", sourceBytes: 1234, sourceLocation: "", pageCount: 8,
    pageLayout: () => ({ width: 600, height: 800 }),
    getDocumentInfo: () => new Promise((resolve) => { resolveMetadata = resolve; }),
  };
  const calls = [];
  scopeValues[3] = (value) => { calls.push(value); };
  scopeValues[4] = { current };
  const closeSheet = closeFactory(...scopeValues);
  scopeValues[9] = closeSheet;
  const toggleSheet = toggleFactory(...scopeValues);
  const opening = toggleSheet();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1, "basic rows render without waiting for metadata");
  assert.equal(scopeValues[1].current, 1);
  closeSheet();
  resolveMetadata({ ...calls[0][0], info: { Title: "Late metadata" } });
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2, "late metadata must not reopen the closed card");
  assert.equal(calls[1], null, "closing keeps the sheet closed");
});

await check("both stylesheets are linked, pdf.js's first", async () => {
  // Measured, not assumed: dropping `pdf_viewer.css` costs one search match out
  // of four and moves a selection rect from 51,137 to 72,145 — pdf.js's own
  // text-layer rules are what decide where the spans sit. Ours must come second
  // so the page box still wins.
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const links = [...source.matchAll(/href = assetUrl\("([^"]+)", page\)/gu)].map((match) => match[1]);
  assert.deepEqual(links, ["pdf_viewer.css", "viewer.css"], "linked in this order");
  assert.match(source, /document\.head\.append\(layer, chrome\)/u);
});

await check("styles follow the Host palette instead of shipping one", async () => {
  const css = readFileSync(join(PUBLIC, "viewer.css"), "utf8");
  // Opaque surfaces must read the app's theme tokens: `light-dark()` alone
  // follows `color-scheme`, which the app never sets, so cards would stay light
  // in a dark theme.
  const required = [
    "--dsw-alias-bg-document-preview",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-bg-layer-3",
    "--dsw-alias-border-l2",
    "--dsw-alias-interactive-bg-hover",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary",
    "--dsw-alias-state-warn-label",
  ];
  const missing = required.filter((token) => !css.includes(`var(${token}`));
  assert.deepEqual(missing, [], `viewer.css does not read: ${missing.join(", ")}`);
  // Each of those needs a fallback, or the pane is unstyled outside the app.
  const bare = required.filter((token) => new RegExp(`var\\(${token}\\)`).test(css));
  assert.deepEqual(bare, [], `token used without a fallback: ${bare.join(", ")}`);
  // The viewer measures pages against the frame, so it must stay the offset parent.
  assert.match(css, /\.fp-frame\s*\{[^}]*position:\s*relative/u);
  assert.match(css, /\.fp-status\[data-loading\]\s*\{[^}]*--dsw-alias-bg-document-preview/u,
    "the loading surface must hide early canvas paint without changing other status overlays");
  assert.match(css, /\.fp-findbar \.fp-find-toggle\[aria-pressed="true"\][\s\S]*?--dsw-alias-button-info-fill/u,
    "the active search switches need a visible Host-blue state");
  assert.match(css, /\.fp-find-toggle:focus-visible\s*\{[^}]*outline:/u,
    "search switches retain a visible keyboard focus ring");
  assert.match(css, /\.fp-find-toggle:disabled\s*\{[^}]*opacity:/u,
    "disabled search switches remain distinguishable");
  const loadingFill = /\.fp-loading-fill\s*\{([^}]*)\}/u.exec(css);
  assert.ok(loadingFill !== null, "loading bar fill rule exists");
  assert.match(loadingFill[1], /--dsw-alias-button-info-fill,\s*#3b82f6/u, "loading bar uses the Host blue with a fallback");
  assert.doesNotMatch(loadingFill[1], /transition:/u, "progress width tracks real progress without animation lag");
});

await check("search case and whole-word options change real results", async () => {
  const { searchDocument } = await import(pathToFileURL(join(PUBLIC, "search.mjs")).href);
  const text = "Page page pageable";
  const offsets = Array.from({ length: text.length }, (_, index) => index);
  const page = { pageNumber: 1, text, normToRaw: offsets, normToRawEnd: offsets.map((index) => index + 1), rawLength: text.length };
  assert.equal(searchDocument([page], "page").length, 3, "default search ignores case and matches prefixes");
  assert.equal(searchDocument([page], "page", { matchCase: true }).length, 2, "matchCase excludes the uppercase Page hit");
  assert.equal(searchDocument([page], "page", { wholeWord: true }).length, 2, "wholeWord excludes the longer pageable word");
  assert.equal(searchDocument([page], "page", { matchCase: true, wholeWord: true }).length, 1,
    "both options combine in the actual search engine");
});

await check("loading completion reaches 100 and removes the overlay without a hold", async () => {
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  assert.doesNotMatch(source, /PROGRESS_HOLD_MS/u, "there is no post-open progress hold");
  const doneMatch = source.match(/const markProgressDone = \(previous\) => \{([\s\S]*?)\n          \};/u);
  assert.ok(doneMatch, "client.js has a progress completion updater");
  const markDone = new Function("previous", doneMatch[1]);
  assert.deepEqual(markDone(null), { loaded: 0, total: 0, ratio: 1, percent: 100, phase: "prepare" },
    "unknown totals stay unknown while completed progress is 100%");
  assert.deepEqual(markDone({ loaded: 400, total: 1000, ratio: 0.4, percent: 95, phase: "prepare" }),
    { loaded: 1000, total: 1000, ratio: 1, percent: 100, phase: "prepare" },
    "known counts finish at their actual total");
  const finishMatch = source.match(/const finishOpenProgress = \(\) => \{([\s\S]*?)\n          \};/u);
  assert.ok(finishMatch, "success has one final progress/status update");
  let progress = null;
  let status = "loading";
  new Function("setProgress", "setStatus", "markProgressDone", finishMatch[1])(
    (update) => { progress = update(progress); },
    (next) => { status = next; },
    markDone,
  );
  assert.equal(progress.percent, 100);
  assert.equal(status, "ready");
  assert.match(source, /status === "loading" && password === null/u,
    "the loading overlay is absent as soon as status is ready");
});

await check("the pane asks for the app's typeface, not the code font", async () => {
  const css = readFileSync(join(PUBLIC, "viewer.css"), "utf8");
  // The Host's document body container declares `var(--dsw-font-mono,
  // ui-monospace, monospace)` and `white-space: pre` for its text preview, so a
  // body that says nothing renders its whole chrome in the code font — Latin in
  // Consolas, CJK at whatever the `monospace` alias picks. Every built-in body
  // opts out on its own root with `var(--dsw-font, …)`; so must this one.
  const rules = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const root = /\.fp-root\s*\{([^}]*)\}/u.exec(rules);
  assert.ok(root !== null, "viewer.css has no .fp-root block");
  assert.match(root[1], /font-family:\s*var\(--dsw-font,/u, ".fp-root does not opt out of the code font");
  assert.match(root[1], /white-space:\s*normal/u, ".fp-root does not reset the container's white-space: pre");
  assert.ok(!/monospace/u.test(rules), "viewer.css asks for a monospace family somewhere");
});

await check("the floating translate pill stays opaque while the pointer is on it", async () => {
  const css = readFileSync(join(PUBLIC, "viewer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  // The toolbar's hairlines can write plain `background:` for hover — they sit on
  // an opaque bar. The selection pill floats over the page, and that same
  // shorthand *replaces* its opaque surface with the hover token's ~6% alpha, so
  // the button turns see-through the moment it is pointed at or clicked. The
  // state has to be a layer on top while `background-color` keeps the surface.
  const base = /\.fp-pick-action\s*\{([^}]*)\}/u.exec(css);
  assert.ok(base !== null, "viewer.css has no .fp-pick-action block");
  assert.match(base[1], /background-color:\s*var\(--dsw-alias-bg-layer-3,/u, "the pill's own surface is not an opaque layer token");
  for (const state of ["hover", "active"]) {
    const rule = new RegExp(`\\.fp-pick-action:${state}\\s*\\{([^}]*)\\}`, "u").exec(css);
    assert.ok(rule !== null, `.fp-pick-action:${state} is missing`);
    assert.doesNotMatch(rule[1], /(^|[;\s])background:/u, `.fp-pick-action:${state} replaces the opaque surface`);
    assert.match(rule[1], /background-image:/u, `.fp-pick-action:${state} layers no wash on top of the surface`);
  }
});

await check("a copied selection reflows to plain text with no line breaks of its own", async () => {
  // The rule now lives in the ported module, so the check calls the module the
  // pane actually imports — a re-implementation here would pass while the pane
  // kept its own.
  const text = await import(pathToFileURL(join(ROOT, "public", "selection-text.mjs")).href);
  const reflow = (raw) => text.normalizePdfSelectionText(String(raw), null);
  // What pdf.js's text layer gives `toString()`: one line per positioned span.
  assert.equal(
    reflow("Lorem ipsum dolor sit amet,\nconsectetur adipiscing elit\nsed do eiusmod"),
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod",
  );
  // Two Chinese lines are one sentence, so nothing goes between them.
  assert.equal(reflow("第一行文字\n第二行文字"), "第一行文字第二行文字");
  // Between latin and CJK the break stands in for the space the page may have had.
  assert.equal(reflow("Page 12\n中文标题"), "Page 12 中文标题");
  // A sentence that ends followed by a capital on a long line is read as a new
  // paragraph — a guess, and the port's own.
  assert.equal(
    reflow("Lorem ipsum dolor sit amet, consectetur adipiscing elit.\nSed do eiusmod"),
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed do eiusmod",
  );
  // A bullet always starts its own block, however the wrap fell.
  assert.equal(reflow("下面三点如下：\n• 第一点\n• 第二点"), "下面三点如下：\n\n• 第一点\n\n• 第二点");
  // A hyphen at the wrap is the break, not a character of the word.
  assert.equal(reflow("inter-\nnational"), "international");
  // Non-breaking space and runs of blank space are the layout's, not the text's.
  assert.equal(reflow("a\u00a0b  \n\n  c"), "a b c");
  assert.equal(reflow("   "), "");
});

await check("the ported helpers answer the questions the pane asks them", async () => {
  const docs = await import(pathToFileURL(join(ROOT, "public", "document-properties.mjs")).href);
  const loading = await import(pathToFileURL(join(ROOT, "public", "loading-progress.mjs")).href);
  const outline = await import(pathToFileURL(join(ROOT, "public", "outline-active.mjs")).href);

  // Every key the three modules ask for has to exist in the pane's dictionary,
  // or the card and the opening line would show a bare key.
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const asked = [
    "fileName", "fileSize", "documentLocationPath", "documentTitle", "documentAuthor",
    "documentSubject", "documentKeywords", "documentCreationDate", "documentModDate",
    "documentCreator", "documentProducer", "pdfVersion", "documentPageCount", "pageSize",
    "fastWebView", "pagePortrait", "pageLandscape", "pageSizeValue", "fileSizeBytes",
    "fileSizeKb", "fileSizeMb", "yes", "no",
    "loadingWaiting", "loadingReceived", "loadingBytes", "loadingPrepare",
  ];
  for (const key of asked) {
    assert.ok(new RegExp(`\\n\\s+${key}:`, "u").test(source), `client.js has no "${key}" string for a ported helper`);
  }

  // --- the properties card ---------------------------------------------------
  const words = {
    fileName: "文件名", fileSize: "大小", documentLocationPath: "位置", documentTitle: "标题",
    documentAuthor: "作者", documentSubject: "主题", documentKeywords: "关键词",
    documentCreationDate: "创建时间", documentModDate: "修改时间", documentCreator: "创建程序",
    documentProducer: "生成程序", pdfVersion: "PDF 版本", documentPageCount: "页数",
    pageSize: "页面尺寸", fastWebView: "快速 Web 查看", pagePortrait: "纵向",
    pageLandscape: "横向", pageSizeValue: "{width} × {height} mm · {orientation}",
    fileSizeBytes: "{count} B", fileSizeKb: "{count} KB", fileSizeMb: "{count} MB",
    yes: "是", no: "否",
  };
  const t = (key) => words[key] ?? key;
  const rows = docs.buildDocumentPropertyRows({
    fileName: "a.pdf",
    fileSize: 2048,
    // A Host-side path is worth showing; a blob: origin is this process.
    location: "C:/tmp/a.pdf",
    pageCount: 12,
    pageWidth: 595.28,
    pageHeight: 841.89,
    info: { Title: "T", Creator: "Word", IsLinearized: true, CreationDate: "D:20240102030405Z" },
  }, t, "zh-CN");
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(rows.length, 15, "the location row is spliced in on top of the fourteen");
  assert.equal(rows[2].key, "location", "the location sits right under the name and size");
  assert.equal(byKey.fileName, "a.pdf");
  assert.equal(byKey.fileSize, "2.0 KB");
  assert.equal(byKey.pageSize, "210.0 × 297.0 mm · 纵向");
  assert.equal(byKey.linearized, "是");
  assert.equal(byKey.author, "—", "a missing property is a dash, not an empty cell");
  assert.match(byKey.created, /2024/u, "the PDF date format is parsed, not shown raw");
  const blob = docs.buildDocumentPropertyRows({ location: "blob:http://127.0.0.1/9", info: {} }, t);
  assert.equal(blob.length, 14);
  assert.ok(!blob.some((row) => row.key === "location"), "a blob: origin is not a file location");

  // --- the opening line ------------------------------------------------------
  const line = {
    loadingWaiting: "等待数据…",
    loadingReceived: "已收到 {loaded}",
    loadingBytes: "{loaded} / {total} · {percent}%",
    loadingPrepare: "正在排版…",
    loadingPreparePages: "正在排版 {loaded} / {total} 页",
  };
  const lt = (key) => line[key] ?? key;
  assert.deepEqual(
    loading.loadingState({ phase: "download", progress: 0.5, loaded: 512, total: 1024 }, lt, "en"),
    { mode: "determinate", percent: 50, text: "512 B / 1 KB · 50%" },
  );
  // No length from the Host means no percentage — the bar sweeps instead.
  assert.deepEqual(
    loading.loadingState({ phase: "download", loaded: 2048, total: 0 }, lt, "en"),
    { mode: "indeterminate", percent: null, text: "已收到 2 KB" },
  );
  assert.deepEqual(
    loading.loadingState({ phase: "download" }, lt, "en"),
    { mode: "indeterminate", percent: null, text: "等待数据…" },
  );
  // Bytes are in: the line changes what it is waiting for, and the bar keeps the
  // percentage it already earned instead of dropping back to a sweep — one bar
  // for two phases, and it only ever moves forwards (measured: 100 → 48 on a
  // 200-page file before this).
  assert.deepEqual(
    loading.loadingState({ phase: "prepare", progress: 1, loaded: 1024, total: 1024 }, lt, "en"),
    { mode: "determinate", percent: 100, text: "正在排版 1024 / 1024 页" },
  );
  // `barPercent` is the bar's own number: the layout knows its share of it
  // (95 → 100) before it knows how many pages it is counting, so the bar can be
  // determinate while the line is still the unsized one.
  assert.deepEqual(
    loading.loadingState({ phase: "prepare", progress: 0.4, loaded: 400, total: 1000, barPercent: 95 }, lt, "en"),
    { mode: "determinate", percent: 95, text: "正在排版 400 / 1000 页" },
  );
  assert.deepEqual(
    loading.loadingState({ phase: "prepare", barPercent: 97 }, lt, "en"),
    { mode: "determinate", percent: 97, text: "正在排版…" },
  );

  // --- the outline highlight -------------------------------------------------
  const entries = [
    { id: "#0", page: 1, pdfY: 700 },
    { id: "#1", page: 3, pdfY: 640 },
    { id: "#2", page: 3, pdfY: 200 },
    { id: "#3", page: 9, pdfY: 500 },
  ];
  const active = (page, pdfY) => outline.pickOutlineActive(entries, { page, pdfY })?.id ?? null;
  assert.equal(active(1, 650), "#0");
  // A smaller Y is further down the page, so the heading above the reading
  // point is the chapter being read.
  assert.equal(active(3, 400), "#1");
  assert.equal(active(3, 150), "#2");
  // Above the first heading of a page, that heading is still the chapter.
  assert.equal(active(3, 760), "#1");
  // A page with no heading of its own belongs to the last one that started.
  assert.equal(active(5, 400), "#2");
  assert.equal(outline.pickOutlineActive([], { page: 1, pdfY: 0 }), null);
  // pdf.js hands destinations over as an explicit array whose shape says where
  // the Y lives; the pane reads it before ranking anything.
  assert.equal(outline.destPdfY([{ num: 1, gen: 0 }, { name: "XYZ" }, 0, 500, 0]), 500);
  assert.equal(outline.destPdfY([{ num: 1, gen: 0 }, { name: "FitH" }, 640]), 640);
  assert.ok(Number.isNaN(outline.destPdfY([{ num: 1, gen: 0 }, { name: "Fit" }])), "a fit with no position has no Y");
});

await check("floating translation drag suppresses selection only during a matching pointer drag", async () => {
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  const marker = "const beginDrag = React.useCallback((event) => {";
  const start = source.indexOf(marker);
  const end = source.indexOf("\n      }, []);", start);
  assert.ok(start >= 0 && end > start, "beginDrag callback source should be present");
  const body = source.slice(start + marker.length, end);
  const callbacks = new Function("rootRef", "pickRef", "pickDragCleanupRef", "pickDragPositionRef", "setPick", "CARD_WIDTH", "window", "Element", "requestAnimationFrame", "cancelAnimationFrame", `return (event) => {${body}\n};`);

  const listeners = new Map();
  const fakeWindow = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  let draggingAttributeWrites = 0;
  const root = {
    offsetWidth: 500, offsetHeight: 400, attributes: new Set(), listeners: new Map(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setAttribute(name) { if (!this.attributes.has(name)) draggingAttributeWrites += 1; this.attributes.add(name); }, removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); },
  };
  const card = { offsetWidth: 220, offsetHeight: 100, style: { left: "20px", top: "20px" }, getBoundingClientRect: () => ({ left: 20, top: 20 }) };
  class FakeElement {
    constructor(button = false) { this.button = button; this.captured = null; this.released = null; this.listeners = new Map(); }
    closest(selector) { return selector === "button" && this.button ? {} : selector === ".fp-pick" ? card : null; }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture(id) { this.released = id; this.captured = null; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  }
  const dragCleanupRef = { current: null };
  const dragPositionRef = { current: null };
  let setPickCalls = 0;
  let pickedState = {};
  const rafs = new Map();
  let nextRaf = 1;
  const requestFrame = (callback) => { const id = nextRaf++; rafs.set(id, callback); return id; };
  const cancelFrame = (id) => rafs.delete(id);
  const beginDrag = callbacks({ current: root }, { current: {} }, dragCleanupRef, dragPositionRef,
    (update) => { setPickCalls += 1; pickedState = update(pickedState); }, 220, fakeWindow, FakeElement, requestFrame, cancelFrame);
  const makeEvent = (pointerId, target = new FakeElement(), currentTarget = new FakeElement()) => ({
    button: 0, pointerId, target, currentTarget, clientX: 20, clientY: 20,
    defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
  });

  const down = makeEvent(7);
  down.currentTarget = new FakeElement();
  beginDrag(down);
  assert.equal(down.defaultPrevented, true, "eligible pointerdown must prevent native text selection synchronously");
  assert.ok(listeners.has("pointermove"));
  assert.equal(down.currentTarget.captured, 7);
  let browserSelectedText = !down.defaultPrevented;
  assert.equal(browserSelectedText, false, "native default selection should not start from the drag handle");

  const unrelatedMove = makeEvent(8);
  listeners.get("pointermove")(unrelatedMove);
  assert.equal(unrelatedMove.defaultPrevented, false, "unrelated pointers must not be consumed");
  assert.equal(setPickCalls, 0);
  const move = makeEvent(7);
  move.clientX = 40;
  listeners.get("pointermove")(move);
  assert.equal(move.defaultPrevented, true, "the active move event must be prevented");
  assert.equal(root.attributes.has("data-dragging"), true, "selection suppression should be scoped to active dragging");
  const secondMove = makeEvent(7);
  secondMove.clientX = 60;
  secondMove.clientY = 40;
  listeners.get("pointermove")(secondMove);
  assert.equal(draggingAttributeWrites, 1, "drag state should only be written on the threshold crossing");
  assert.equal(setPickCalls, 0, "pointer moves must not trigger React state updates");
  assert.equal(rafs.size, 1, "multiple moves in one frame should schedule one DOM update");
  const [frameId, paintFrame] = rafs.entries().next().value;
  rafs.delete(frameId);
  paintFrame();
  assert.equal(card.style.left, "60px");
  assert.equal(card.style.top, "40px");
  const selectStart = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  root.listeners.get("selectstart")(selectStart);
  assert.equal(selectStart.defaultPrevented, true, "drag blocks only new selection starts inside its root");
  assert.equal(setPickCalls, 0, "the RAF DOM write should not rerender React");
  const lastMove = makeEvent(7);
  lastMove.clientX = 80;
  lastMove.clientY = 90;
  listeners.get("pointermove")(lastMove);
  listeners.get("pointerup")(makeEvent(8));
  assert.ok(listeners.has("pointermove"), "unrelated pointerup must not end this drag");
  listeners.get("pointerup")(makeEvent(7));
  assert.equal(root.attributes.has("data-dragging"), false);
  assert.equal(listeners.size, 0, "cancel must remove temporary global listeners");
  assert.equal(setPickCalls, 1, "drag end should commit moved position once");
  assert.deepEqual(pickedState.moved, { left: 80, top: 90 }, "pointerup must flush the final coordinates");
  assert.equal(rafs.size, 0, "pointerup must cancel the pending frame after flushing it synchronously");
  assert.equal(down.currentTarget.released, 7, "pointer capture must release after cleanup");

  const blurDown = makeEvent(11);
  blurDown.currentTarget = new FakeElement();
  beginDrag(blurDown);
  const blurMove = makeEvent(11);
  blurMove.clientX = 30;
  listeners.get("pointermove")(blurMove);
  assert.equal(root.attributes.has("data-dragging"), true);
  listeners.get("blur")({ type: "blur" });
  assert.equal(listeners.size, 0, "window blur must end the drag");
  assert.equal(root.attributes.has("data-dragging"), false, "FocusEvent without pointerId must clear drag styling");

  const lostCaptureDown = makeEvent(13);
  lostCaptureDown.currentTarget = new FakeElement();
  beginDrag(lostCaptureDown);
  lostCaptureDown.currentTarget.listeners.get("lostpointercapture")({ pointerId: 13 });
  assert.equal(listeners.size, 0, "lost pointer capture must end the drag");

  const previousDown = makeEvent(14);
  previousDown.currentTarget = new FakeElement();
  beginDrag(previousDown);
  const nextDown = makeEvent(15);
  nextDown.currentTarget = new FakeElement();
  beginDrag(nextDown);
  assert.equal(previousDown.currentTarget.released, 14, "a previous drag must release before capturing the next pointer");
  assert.equal(nextDown.currentTarget.captured, 15);
  dragCleanupRef.current();

  const unmountDown = makeEvent(12);
  unmountDown.currentTarget = new FakeElement();
  beginDrag(unmountDown);
  const beforeUnmountCommit = setPickCalls;
  dragCleanupRef.current();
  assert.equal(listeners.size, 0, "unmount cleanup must remove drag listeners");
  assert.equal(root.attributes.has("data-dragging"), false);
  assert.equal(setPickCalls, beforeUnmountCommit, "unmount cleanup must not schedule a React state update");

  const buttonDown = makeEvent(9, new FakeElement(true));
  beginDrag(buttonDown);
  assert.equal(buttonDown.defaultPrevented, false, "header buttons must keep their native click behavior");
  assert.equal(listeners.size, 0, "header buttons must not start a drag");
  const css = readFileSync(join(ROOT, "public", "viewer.css"), "utf8");
  assert.match(css, /\.fp-pick-head\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-select:\s*none/s);
  assert.doesNotMatch(css, /\.fp-root\[data-dragging\]\s*,?\s*\.fp-root\[data-dragging\]\s*\*/,
    "dragging must not hide the existing native selection highlight across the pane");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
