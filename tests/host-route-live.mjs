/**
 * The Host half over a real socket:
 *
 *   node tests/host-route-live.mjs                       # self-check, exits 0 or 1
 *   node tests/host-route-live.mjs --serve 8899 <dir>    # keep serving for a browser
 *
 * `client-smoke.mjs` calls the route handlers with hand-built `req`/`res`
 * objects. That catches typos, but not the things a real socket decides: the
 * `req.url` a Node server actually hands over, `for await (const chunk of req)`
 * on a live upload, and — the one this file exists for — whether the route the
 * Host's own table would pick is the one expected.
 *
 * The matching below is copied from `@deepseek-ai/dsh-host-webserver`'s
 * `register`/`match`: exact table first, then the longest prefix whose
 * `pathname === prefix || pathname.startsWith(prefix + "/")`. Copying it is the
 * point — a prefix registered as `/fast-pdf/` instead of `/fast-pdf` would still
 * pass a mock that never matches anything, and would serve nothing on the Host.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

/** The Host's route table, reduced to the part this plugin's routes touch. */
function createRouteTable() {
  const exact = new Map();
  const prefixes = new Map();
  return {
    register(route) {
      const table = route.kind === "exact" ? exact : prefixes;
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    match(pathname) {
      const hit = exact.get(pathname);
      if (hit !== undefined) return hit;
      let best;
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
        if (best === undefined || prefix.length > best.path.length) best = route;
      }
      return best;
    },
  };
}

/**
 * Services the translation route reads, faked at the same shape the real ones
 * have: `agents.get(id)` for a live session, `agentDefaultModel` for the route
 * a session without a live agent falls back to, `llm.stream()` for the answer.
 */
function createServices() {
  const seen = [];
  return {
    seen,
    get(name) {
      if (name === "llm") {
        return {
          async resolveModelInfo() { return {}; },
          async *stream(request) {
            seen.push(request);
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "译文" };
            yield { type: "finish", reason: { kind: "stop" } };
          },
        };
      }
      if (name === "agents") {
        return {
          get: () => ({ session: { requestHeader: () => ({ config: { provider: "p-1", model: "m-1" } }) } }),
          list: () => [],
        };
      }
      if (name === "sessions") {
        // The address grammar allows a session-relative path, and the Host
        // resolves those against the session header's `cwd`. Answering with the
        // plugin root is enough to show the route does the same.
        return { get: (id) => (id === "sess-1" ? { header: { cwd: ROOT } } : undefined) };
      }
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider: "p-default", model: "m-default" }) };
      }
      return undefined;
    },
  };
}

/**
 * Static files for the page that drives the browser half in `--serve` mode.
 * @param dir - document root.
 * @returns a handler answering `req`/`res`.
 */
function staticFallback(dir) {
  const media = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".pdf", "application/pdf"],
  ]);
  return async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = normalize(join(dir, relative));
    const inside = target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    const type = inside ? media.get(extname(target).toLowerCase()) : undefined;
    if (type === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, { "content-type": type, "content-length": String(body.length), "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  };
}

/**
 * Mount the plugin's host half on a real server.
 * @param fallback - handler for paths no route matched, or `undefined` to 404.
 * @returns `{server, url, services}` with the server not yet listening.
 */
async function mount(fallback) {
  const routes = createRouteTable();
  const services = createServices();
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  mod.apply({
    effect: (fn) => {
      fn();
      return () => {};
    },
    get: services.get,
    webServer: { register: (route) => routes.register(route) },
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes.match(pathname);
    if (route === undefined) {
      if (fallback === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      void fallback(req, res);
      return;
    }
    void Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error?.message ?? error));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${String(server.address().port)}`, services };
}

/**
 * One request through a real socket.
 * @param base - origin.
 * @param path - pathname and query.
 * @param options - method, headers, body.
 * @returns status, headers and the body as text.
 */
async function hit(base, path, { method = "GET", headers = {}, body } = {}) {
  const answer = await fetch(base + path, { method, headers, body, redirect: "manual" });
  const text = method === "HEAD" ? "" : await answer.text();
  return { status: answer.status, headers: Object.fromEntries(answer.headers), text };
}

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

const plan = process.argv.indexOf("--serve");
if (plan !== -1) {
  const port = Number(process.argv[plan + 1] ?? "8899");
  const dir = resolve(process.argv[plan + 2] ?? ".");
  const routes = createRouteTable();
  const services = createServices();
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  mod.apply({
    effect: (fn) => {
      fn();
      return () => {};
    },
    get: services.get,
    webServer: { register: (route) => routes.register(route) },
  });
  const serve = staticFallback(dir);
  const clientHalf = join(ROOT, "client.js");
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes.match(pathname);
    if (route !== undefined) {
      void Promise.resolve(route.handler(req, res)).catch((error) => {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(error?.message ?? error));
      });
      return;
    }
    // The Host serves the declared bundle entry itself; mirror that here so the
    // page can fetch its browser half from the URL it uses in the GUI.
    if (pathname === "/plugins/dsh-fast-pdf/client.js") {
      void readFile(clientHalf).then((bytes) => {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(bytes);
      });
      return;
    }
    void serve(req, res);
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  console.log(`serving ${dir} with the plugin's own /fast-pdf route at http://127.0.0.1:${String(port)}/`);
  console.log("run the browser harness against that root; Ctrl-C to stop");
} else {
  console.log("host half over a real socket");
  const { server, url, services } = await mount(undefined);
  try {
    await check("assets come off the prefix route with the right media types", async () => {
      const js = await hit(url, "/fast-pdf/viewer.mjs");
      assert.equal(js.status, 200);
      assert.match(js.headers["content-type"], /^text\/javascript/);
      assert.match(js.text, /class PdfViewer/, "the module the client loads must be the one served");

      const worker = await hit(url, "/fast-pdf/pdf.worker.mjs");
      assert.equal(worker.status, 200);
      assert.match(worker.headers["content-type"], /^text\/javascript/, "a module worker needs a JS media type");
      assert.ok(worker.text.length > 1_000_000, `worker truncated at ${String(worker.text.length)} bytes`);

      const css = await hit(url, "/fast-pdf/viewer.css");
      assert.equal(css.status, 200);
      assert.match(css.headers["content-type"], /^text\/css/);
    });

    await check("nested asset kinds survive the round trip", async () => {
      const cmap = await hit(url, "/fast-pdf/cmaps/UniGB-UCS2-H.bcmap");
      assert.equal(cmap.status, 200);
      assert.equal(cmap.headers["content-type"], "application/octet-stream");
      const wasm = await hit(url, "/fast-pdf/wasm/openjpeg.wasm");
      assert.equal(wasm.status, 200);
      assert.equal(wasm.headers["content-type"], "application/wasm");
      const font = await hit(url, "/fast-pdf/standard_fonts/LiberationSans-Regular.ttf");
      assert.equal(font.status, 200);
      assert.equal(font.headers["content-type"], "font/ttf");
    });

    await check("a query string and a HEAD do not change what is served", async () => {
      const plain = await hit(url, "/fast-pdf/viewer.css");
      const queried = await hit(url, "/fast-pdf/viewer.css?v=2");
      assert.equal(queried.status, 200);
      assert.equal(queried.text.length, plain.text.length, "the query must not resolve to another file");

      const head = await hit(url, "/fast-pdf/viewer.css", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.text, "");
      // Bytes, not code points: the stylesheet is UTF-8 with non-ASCII comments,
      // so comparing against `text.length` would be two short.
      assert.equal(head.headers["content-length"], plain.headers["content-length"], "HEAD must announce the real length");
    });

    await check("a second load revalidates to 304 instead of re-downloading", async () => {
      const first = await hit(url, "/fast-pdf/pdf.worker.mjs");
      const etag = first.headers.etag;
      assert.ok(etag, "no etag on a 2 MB worker means every open pays for it again");
      const second = await hit(url, "/fast-pdf/pdf.worker.mjs", { headers: { "if-none-match": etag } });
      assert.equal(second.status, 304);
      assert.equal(second.text, "");
    });

    await check("nothing outside public/ is reachable", async () => {
      for (const path of ["/fast-pdf/%2e%2e/index.js", "/fast-pdf/%2e%2e%2fpackage.json", "/fast-pdf/", "/fast-pdf", "/fast-pdf/nope.mjs", "/fast-pdf/LICENSE"]) {
        const answer = await hit(url, path);
        assert.equal(answer.status, 404, `${path} answered ${String(answer.status)}`);
      }
      const boundary = await hit(url, "/fast-pdfx/viewer.mjs");
      assert.equal(boundary.status, 404, "a sibling path must not match the prefix");
    });

    await check("only GET and HEAD are served for assets", async () => {
      const post = await hit(url, "/fast-pdf/viewer.mjs", { method: "POST", body: "x" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.allow, "GET, HEAD");
    });

    await check("the exact translation route wins over the asset prefix", async () => {
      // The prefix handler answers a POST with 405; only the exact route can
      // answer 403. That is how this check tells which route the table picked.
      const unmarked = await hit(url, "/fast-pdf/translate", { method: "POST", body: "{}" });
      assert.equal(unmarked.status, 403, "the exact route must answer, not the asset prefix");
      const crossSite = await hit(url, "/fast-pdf/translate", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "translate", "sec-fetch-site": "cross-site" },
        body: "{}",
      });
      assert.equal(crossSite.status, 403, "a cross-site post must be refused");
      const get = await hit(url, "/fast-pdf/translate");
      assert.equal(get.status, 405);
    });

    await check("the beacon route records what the page reports, and only from a page", async () => {
      const before = JSON.parse((await hit(url, "/fast-pdf/hello")).text);
      assert.equal(before.ok, true);
      assert.ok(Array.isArray(before.beacons), "beacons must be a list");

      const unmarked = await hit(url, "/fast-pdf/hello", { method: "POST", body: "{}" });
      assert.equal(unmarked.status, 403, "an unmarked post must be refused");
      const crossSite = await hit(url, "/fast-pdf/hello", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "hello", "sec-fetch-site": "cross-site" },
        body: "{}",
      });
      assert.equal(crossSite.status, 403, "a cross-site post must be refused");
      const wrongMethod = await hit(url, "/fast-pdf/hello", { method: "PUT", body: "{}" });
      assert.equal(wrongMethod.status, 405);

      const report = {
        kind: "apply",
        id: "dsh-fast-pdf/pdf",
        candidates: ["dsh-fast-pdf/pdf", "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf"],
        pageAt: Date.now(),
        tookMs: 3,
      };
      const posted = await hit(url, "/fast-pdf/hello", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "hello", "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      assert.equal(posted.status, 204, posted.text);

      const after = JSON.parse((await hit(url, "/fast-pdf/hello")).text);
      const last = after.beacons.at(-1);
      assert.equal(last.kind, "apply");
      assert.equal(last.candidates[0], "dsh-fast-pdf/pdf", "the takeover order has to survive the round trip");
      assert.equal(last.candidates[1], "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf");
      assert.ok(typeof last.receivedAt === "number", "the host clocks each report");
    });

    await check("the beacon route refuses an oversized or malformed report", async () => {
      const huge = await hit(url, "/fast-pdf/hello", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "hello", "content-type": "application/json" },
        body: JSON.stringify({ kind: "apply", pad: "x".repeat(8192) }),
      });
      assert.equal(huge.status, 413, "the route must cap what it keeps");
      const malformed = await hit(url, "/fast-pdf/hello", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "hello", "content-type": "application/json" },
        body: "{not json",
      });
      assert.equal(malformed.status, 400);
    });

    await check("a document's own reports cannot push the apply report out", async () => {
      // One document emits four reports (`body-render`, `mount`, `body-bytes`,
      // `body-view`) and the pane remounts on every tab switch, so a list counted
      // overall lost the `apply` line — and `host-live.mjs --page` then failed a
      // page that was demonstrably running this plugin. The cap is per kind, so no
      // number of documents can evict it.
      const post = (body) =>
        hit(url, "/fast-pdf/hello", {
          method: "POST",
          headers: { "x-dsh-fast-pdf": "hello", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      await post({ kind: "apply", id: "dsh-fast-pdf/pdf", candidates: ["dsh-fast-pdf/pdf"] });
      for (let doc = 0; doc < 12; doc += 1) {
        for (const kind of ["body-render", "mount", "body-bytes", "body-view"]) await post({ kind, doc });
      }
      const answer = JSON.parse((await hit(url, "/fast-pdf/hello")).text);
      const kinds = answer.beacons.map((beacon) => beacon.kind);
      assert.ok(kinds.includes("apply"), "a document's reports evicted the apply report");
      assert.equal(kinds.filter((kind) => kind === "mount").length, 8, "one kind is not capped on its own");
      assert.ok(answer.beacons.length <= 8 * 8, `kept ${String(answer.beacons.length)}`);
      assert.equal(answer.beacons.at(-1).kind, "body-view", "the newest report has to be the last one");
    });

    await check("the file route streams the document the body asked for", async () => {
      const sample = join(ROOT, "tests", "browser", "samples", "plain.pdf");
      const answer = await fetch(`${url}/fast-pdf/file`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-fast-pdf": "file" },
        body: JSON.stringify({ path: sample }),
      });
      assert.equal(answer.status, 200);
      assert.match(answer.headers.get("content-type") ?? "", /^application\/pdf/u);
      const served = new Uint8Array(await answer.arrayBuffer());
      const wanted = await readFile(sample);
      assert.equal(
        Number(answer.headers.get("content-length")),
        wanted.length,
        "the length the body pre-flight sees is the length it gets",
      );
      assert.equal(served.length, wanted.length);
      assert.equal(Buffer.compare(Buffer.from(served), wanted), 0, "the file comes back byte for byte");
    });

    await check("a session address resolves against that session's workspace root", async () => {
      // This is the shape the running app hands over: scope `session`, path
      // relative to the session's cwd rather than absolute. The route has to do
      // what the Host's own reads do and join it, or every document outside the
      // workspace root reads as "需要一个绝对路径".
      const address = "dsh-resource://file/session/sess-1/tests/browser/samples/plain.pdf";
      const answer = await fetch(`${url}/fast-pdf/file`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-fast-pdf": "file" },
        body: JSON.stringify({ address }),
      });
      assert.equal(answer.status, 200);
      const served = new Uint8Array(await answer.arrayBuffer());
      const wanted = await readFile(join(ROOT, "tests", "browser", "samples", "plain.pdf"));
      assert.equal(Buffer.compare(Buffer.from(served), wanted), 0, "the joined path is the file that was asked for");

      // The Host's `absolute/<path>` grammar drops the leading `/` for POSIX
      // paths (`absolute/home/ys/a.pdf`), keeps `C:/...` for a Windows drive
      // and keeps one empty segment for a UNC path. Sending `absolute//Users/...`
      // would be a UNC address, not the file we want, so strip the leading slash.
      const absolutePath = join(ROOT, "tests", "browser", "samples", "plain.pdf").replaceAll("\\", "/");
      const absoluteAddress = `dsh-resource://file/absolute/${absolutePath.replace(/^\/+/u, "").replaceAll(":", "%3A")}`;
      assert.equal(absoluteAddress.startsWith("dsh-resource://file/absolute/"), true);
      const drive = await fetch(`${url}/fast-pdf/file`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-fast-pdf": "file" },
        body: JSON.stringify({ address: absoluteAddress }),
      });
      assert.equal(drive.status, 200, "an absolute address is served as it stands");
      const absoluteBytes = new Uint8Array(await drive.arrayBuffer());
      assert.equal(Buffer.compare(Buffer.from(absoluteBytes), wanted), 0, "the absolute address reads the same bytes");
    });

    await check("the file route refuses everything else", async () => {
      const marked = { "content-type": "application/json", "x-dsh-fast-pdf": "file" };
      const sample = join(ROOT, "tests", "browser", "samples", "plain.pdf");
      assert.equal((await hit(url, "/fast-pdf/file")).status, 405, "reading is a POST, not a GET");
      assert.equal(
        (await hit(url, "/fast-pdf/file", { method: "POST", body: JSON.stringify({ path: sample }) })).status,
        403,
        "no marker header, no bytes",
      );
      const relative = await hit(url, "/fast-pdf/file", {
        method: "POST",
        headers: marked,
        body: JSON.stringify({ path: "plain.pdf" }),
      });
      assert.equal(relative.status, 400, "a relative path is refused rather than resolved");
      const missing = await hit(url, "/fast-pdf/file", {
        method: "POST",
        headers: marked,
        body: JSON.stringify({ path: join(ROOT, "no-such-document.pdf") }),
      });
      assert.equal(missing.status, 404);
      const directory = await hit(url, "/fast-pdf/file", {
        method: "POST",
        headers: marked,
        body: JSON.stringify({ path: join(ROOT, "tests") }),
      });
      assert.equal(directory.status, 404, "a directory is not a document");
      const broken = await hit(url, "/fast-pdf/file", { method: "POST", headers: marked, body: "{" });
      assert.equal(broken.status, 400);
    });

    await check("an oversized file is refused before a byte of it is read", async () => {
      const huge = join(tmpdir(), `dsh-fast-pdf-${String(process.pid)}-huge.pdf`);
      const handle = await open(huge, "w");
      try {
        // Sparse on NTFS: 300 MB of length with almost no disk behind it, which
        // is all this check needs — the route stats before it streams.
        await handle.truncate(300 * 1024 * 1024);
      } finally {
        await handle.close();
      }
      try {
        const answer = await hit(url, "/fast-pdf/file", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-fast-pdf": "file" },
          body: JSON.stringify({ path: huge }),
        });
        assert.equal(answer.status, 413);
        const detail = JSON.parse(answer.text);
        assert.equal(detail.code, "too-large");
        assert.equal(detail.size, 300 * 1024 * 1024, "the refusal names the real size");
      } finally {
        await rm(huge, { force: true });
      }
    });

    await check("a marked post translates on the session's own route", async () => {
      services.seen.length = 0;
      const answer = await hit(url, "/fast-pdf/translate", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "translate", "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello world", sessionId: "s-1" }),
      });
      assert.equal(answer.status, 200);
      const body = JSON.parse(answer.text);
      assert.equal(body.ok, true, answer.text);
      assert.equal(body.text, "译文");
      assert.equal(body.provider, "p-1", "the session's route must be used");
      assert.equal(body.model, "m-1");
      assert.equal(services.seen[0].sessionId, "s-1");
      assert.equal(services.seen[0].messages[0].content[0].text, "Hello world");
    });

    await check("a session without a live agent still translates on the default route", async () => {
      const routes = createRouteTable();
      const services = createServices();
      // No live agent for this tab: the default model is the only route left.
      services.get = ((original) => (name) => (name === "agents" ? { get: () => undefined, list: () => [] } : original(name)))(services.get);
      const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
      mod.apply({
        effect: (fn) => {
          fn();
          return () => {};
        },
        get: services.get,
        webServer: { register: (route) => routes.register(route) },
      });
      const server = createServer((req, res) => {
        const route = routes.match(new URL(req.url ?? "/", "http://localhost").pathname);
        void route.handler(req, res);
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      try {
        const answer = await hit(`http://127.0.0.1:${String(server.address().port)}`, "/fast-pdf/translate", {
          method: "POST",
          headers: { "x-dsh-fast-pdf": "translate", "content-type": "application/json" },
          body: JSON.stringify({ text: "Hello world", sessionId: "s-missing" }),
        });
        const body = JSON.parse(answer.text);
        assert.equal(body.ok, true, answer.text);
        assert.equal(body.provider, "p-default", "the default model must be the fallback");
        assert.equal(body.model, "m-default");
      } finally {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    });

    await check("an oversized upload is refused, not buffered", async () => {
      const answer = await hit(url, "/fast-pdf/translate", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "translate", "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(200_000), sessionId: "s-1" }),
      });
      assert.equal(answer.status, 200);
      const body = JSON.parse(answer.text);
      assert.equal(body.ok, false);
      assert.match(String(body.message), /大/, "the refusal must say why in the reader's language");
    });

    await check("a malformed body is a message, not a crash", async () => {
      const answer = await hit(url, "/fast-pdf/translate", {
        method: "POST",
        headers: { "x-dsh-fast-pdf": "translate", "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(answer.status, 200);
      assert.equal(JSON.parse(answer.text).ok, false);
    });

    await check("If-None-Match accepts weak tags, lists and the star", async () => {
      const live = await fetch(`${url}/fast-pdf/viewer.mjs`);
      const tag = live.headers.get("etag");
      assert.ok(tag, "the asset carries a strong ETag");
      await live.arrayBuffer();
      for (const candidate of [tag, `W/${tag}`, "*", `"other", ${tag}`, `${tag}, "other"`]) {
        const answer = await fetch(`${url}/fast-pdf/viewer.mjs`, { headers: { "if-none-match": candidate } });
        assert.equal(answer.status, 304, `If-None-Match: ${candidate} must revalidate`);
        await answer.arrayBuffer();
      }
    });

    await check("a malformed URL escape is a 404, not a rejected handler", async () => {
      for (const path of ["/fast-pdf/%zz", "/fast-pdf/%E0%A4%A"]) {
        const answer = await fetch(`${url}${path}`);
        assert.equal(answer.status, 404, `${path} must not throw URIError`);
        await answer.arrayBuffer();
      }
    });

    await check("an oversized upload leaves the keep-alive connection usable", async () => {
      const headers = { "x-dsh-fast-pdf": "translate", "content-type": "application/json" };
      const oversized = await fetch(`${url}/fast-pdf/translate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "x".repeat(200_000) }),
      });
      assert.equal(oversized.status, 200);
      await oversized.arrayBuffer();
      // The same connection pool must still serve the next request: an
      // unread body would be parsed as that request's start line.
      const next = await fetch(`${url}/fast-pdf/translate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hi" }),
      });
      assert.equal(next.status, 200);
      await next.arrayBuffer();
    });

    await check("a same-size, same-mtime edit is served fresh", async () => {
      // `identityOf` used to cache by (mtimeMs, size) only, so rewriting one
      // byte at the same size with the mtime restored served the old viewer.
      const path = join(ROOT, "public", "i18n.mjs");
      const original = await readFile(path);
      const info = await stat(path);
      const rewritten = Buffer.from(original);
      rewritten[0] = original[0] === 65 ? 66 : 65;
      try {
        await writeFile(path, rewritten);
        await utimes(path, info.atime, info.mtime);
        const first = await fetch(`${url}/fast-pdf/i18n.mjs`);
        const bytes = new Uint8Array(await first.arrayBuffer());
        assert.equal(bytes[0], rewritten[0], "the served bytes must be the current disk bytes");
      } finally {
        await writeFile(path, original);
        await utimes(path, info.atime, info.mtime);
      }
    });
  } finally {
    // Keep-alive sockets outlive the last response; closing without them hangs.
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }

  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
  }
}
