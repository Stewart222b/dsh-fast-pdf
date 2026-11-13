/**
 * Host half of dsh-fast-pdf.
 *
 * The browser half needs files the module loader cannot serve: purpose-built
 * ES modules (`viewer.mjs`) plus pdf.js's own build, worker, CMap tables and
 * standard fonts. The shell's plugin route only answers the declared bundle
 * entry, so this half owns one prefix route, `/fast-pdf`, over `public/`.
 *
 * Nothing here is stateful and nothing is secret: the route serves read-only
 * viewer code, so it answers any request that resolves inside `public/` and
 * refuses everything else. Every response is revalidated with an ETag, which
 * keeps page refreshes from re-downloading 3 MB of pdf.js, while an edited file
 * still comes through on the next load.
 *
 * One more route lives here: `POST /fast-pdf/translate`, the seat the reader's
 * selection translation talks to. It is the only part of this plugin that asks
 * a model for anything, and it does so on the session's own route — see
 * `translate.js` for why that is where the work sits.
 *
 * And one that serves the document itself: `POST /fast-pdf/file`. A preview
 * registered with `loading: "renderer"` gets a handle from the pane and no
 * bytes, and the Host's own `workspaceFiles` service is not reachable from a
 * third-party client plugin in this build, so the body reads the file through
 * this route instead. It streams, which is what keeps the Host's 32 MiB
 * whole-file cap out of the path entirely.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INPUT, translateSelection, translateSelectionStream } from "./translate.js";

export const name = "fast-pdf";

/** Service dependency: the named HTTP route table. */
export const inject = ["webServer"];

/** Route prefix the client half resolves against `document.baseURI`. */
const ROUTE_PREFIX = "/fast-pdf";

/** Exact route the selection bubble posts to. */
const TRANSLATE_PATH = `${ROUTE_PREFIX}/translate`;

/**
 * Exact route the browser half reports itself to.
 *
 * A client plugin is silent by construction: a bundle that never loads, registers
 * under an id the slot ignores, or loses the default seat all look the same from
 * outside — the built-in viewer keeps the pane and nothing is logged anywhere the
 * user would see. This route is the one place the page can say what happened, so
 * `GET` answers with the last few reports and `tests/host-live.mjs --page` can
 * read the takeover order out of the running app instead of asking for a
 * screenshot. Reports live in this process only and are never written anywhere.
 */
const HELLO_PATH = `${ROUTE_PREFIX}/hello`;

/**
 * Exact route the browser half reads the opened document through.
 *
 * Same marker-header discipline as the two above, and for the same reason: a
 * plain `POST` is reachable from any page the browser has open, and this one
 * returns the contents of an arbitrary readable file.
 */
const FILE_PATH = `${ROUTE_PREFIX}/file`;

/** Marker the file route requires. */
const FILE_HEADER = "x-dsh-fast-pdf";

/**
 * Largest file the route will stream.
 *
 * The browser half refuses anything over this too, before it starts reading,
 * so the number exists on both sides on purpose: the route answers 413 with
 * the real size, and the body turns that into the one sentence that names it.
 */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Header a beacon must carry — same reason as the translation route's. */
const HELLO_HEADER = "x-dsh-fast-pdf";

/**
 * How many beacons of one kind are kept.
 *
 * Per kind, not overall, because the reports are not the same weight: opening
 * one document emits four (`body-render`, `mount`, `body-bytes`, `body-view`),
 * so a single overall count lets an ordinary open push the oldest `apply` report
 * out — and `tests/host-live.mjs --page` then fails a page that is demonstrably
 * running this plugin. The list is in memory only and a report is a few hundred
 * bytes, so this is bounded and cheap.
 */
const BEACON_LIMIT = 8;

/**
 * Drop the oldest reports while one kind is over the limit.
 * @param kind - the kind that just arrived; only its own stack is trimmed.
 */
function trimBeacons(kind) {
  let seen = 0;
  for (let index = beacons.length - 1; index >= 0; index -= 1) {
    if (beacons[index].kind !== kind) continue;
    seen += 1;
    if (seen > BEACON_LIMIT) {
      beacons.splice(index, 1);
      return;
    }
  }
}

/** Largest beacon body accepted, in bytes. */
const MAX_BEACON_BODY = 4096;

/** Beacons seen since this Host started, oldest first. */
const beacons = [];

/** Largest translation request body accepted, in bytes. */
const MAX_BODY = 16 * MAX_INPUT;

/**
 * Header the bubble must send.
 *
 * The route spends the user's model quota, and `POST` with a simple content type
 * is reachable from any web page the browser happens to have open. A custom
 * header is the cheap correct answer: a cross-origin request carrying it needs a
 * preflight, and this route never grants one.
 */
const TRANSLATE_HEADER = "x-dsh-fast-pdf";

/** Read-only asset root. */
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

/** Media types of the asset kinds shipped in `public/`. */
const MEDIA_TYPES = new Map([
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".bcmap", "application/octet-stream"],
  [".pfb", "application/octet-stream"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".icc", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** Cache of path → `{ etag, size }`, keyed by path and validated by mtime. */
const digests = new Map();

/**
 * Resolve one URL pathname to a file inside `public/`.
 * @param pathname - request pathname, already known to start with the prefix.
 * @returns the absolute file path, or `undefined` when the path escapes the root.
 */
function resolveAsset(pathname) {
  const relative = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length)).replace(/^\/+/, "");
  if (relative === "" || relative.includes("\0")) return undefined;
  const absolute = normalize(join(PUBLIC_DIR, relative));
  const root = PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep;
  return absolute.startsWith(root) ? absolute : undefined;
}

/**
 * ETag of one asset, recomputed only when its mtime or size changed.
 * @param path - absolute file path.
 * @returns identity, or `undefined` when the file is missing or unreadable.
 */
async function identityOf(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const cached = digests.get(path);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
    const body = await readFile(path);
    const entry = {
      body,
      etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
    digests.set(path, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * Serve one asset with revalidation, `HEAD` support and range-free caching.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
  const path = resolveAsset(pathname);
  const mediaType = path === undefined ? undefined : MEDIA_TYPES.get(extname(path).toLowerCase());
  if (path === undefined || mediaType === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const asset = await identityOf(path);
  if (asset === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const headers = {
    "content-type": mediaType,
    "cache-control": "no-cache",
    etag: asset.etag,
    "last-modified": new Date(asset.mtimeMs).toUTCString(),
    "access-control-allow-origin": "*",
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers["content-length"] = String(asset.body.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : asset.body);
}

/**
 * Read a request body as text, refusing anything oversized.
 * @param req - HTTP request.
 * @returns the body, or `undefined` when it is too large or unreadable.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Record one beacon, or answer with the ones already seen.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function helloHandler(req, res) {
  if (req.method === "GET") {
    const payload = Buffer.from(JSON.stringify({ ok: true, now: Date.now(), beacons }), "utf8");
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.length),
      "cache-control": "no-store",
    });
    res.end(payload);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return;
  }
  if (req.headers[HELLO_HEADER] !== "hello" || req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BEACON_BODY) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(chunk);
  }
  let report;
  try {
    report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  beacons.push({ receivedAt: Date.now(), ...report });
  trimBeacons(String(report?.kind ?? ""));
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

/**
 * Answer one translation request.
 *
 * The reply is always JSON with HTTP 200: the bubble shows `message` inline, and
 * a model that is merely misconfigured is not a transport failure.
 * @param ctx - plugin context.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function translateHandler(ctx, req, res) {
  /** @param body - JSON-ready payload. */
  const reply = (body) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.length),
      "cache-control": "no-store",
    });
    res.end(payload);
  };
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (req.headers[TRANSLATE_HEADER] !== "translate" || req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const body = await readBody(req);
  if (body === undefined) {
    reply({ ok: false, message: "请求太大" });
    return;
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    reply({ ok: false, message: "请求不是合法的 JSON" });
    return;
  }
  if (input?.stream === true) {
    // The reader asked to watch the answer arrive. One JSON object per line is
    // the simplest thing both halves can parse while it is still being written;
    // `x-accel-buffering: no` keeps a proxy from holding the lines back.
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    let gone = false;
    res.on("close", () => {
      gone = true;
    });
    try {
      for await (const event of translateSelectionStream(ctx, input)) {
        if (gone) return;
        res.write(`${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      if (!gone) res.write(`${JSON.stringify({ ok: false, message: String(error?.message ?? error) })}\n`);
    }
    res.end();
    return;
  }
  try {
    reply(await translateSelection(ctx, input));
  } catch (error) {
    reply({ ok: false, message: String(error?.message ?? error) });
  }
}

/** The `dsh-resource://file/` grammar, as the Host writes it. */
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

/**
 * Read a file address back into a scope, a session and a path.
 *
 * Copied from the built-in document preview's own parser rather than imported:
 * what has to match is the grammar on the wire, and that is one small function.
 * A `session` path is absolute *or* relative to that session's workspace root,
 * which is exactly why the route resolves it instead of demanding absolute.
 * @param address - a candidate `dsh-resource://file/...` address.
 * @returns `{ scope, sessionId, path }`, or null when it is not one.
 */
function parseFileAddress(address) {
  try {
    if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return null;
    const cut = address.search(/[?#]/u);
    const parts = address.slice(FILE_ADDRESS_PREFIX.length, cut === -1 ? undefined : cut).split("/");
    const scope = parts.shift();
    if (scope === "session") {
      const [id, ...segments] = parts;
      if (id === undefined || id === "" || segments.length === 0) return null;
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: segments.map((part) => decodeURIComponent(part)).join("/"),
      };
    }
    if (scope === "absolute") {
      const segments = parts.map((part) => decodeURIComponent(part));
      if (segments.length === 0 || segments[0] === "") return null;
      return { scope, sessionId: "", path: segments.join("/") };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Where a session's relative paths are resolved from.
 *
 * The same answer the Host gives its own workspace reads: the session header's
 * `cwd`, then the sandbox policy's workspace root. Read through `ctx.get` so a
 * build without either service still serves absolute addresses.
 * @param ctx - plugin context.
 * @param sessionId - the session named by the address.
 * @returns an absolute directory.
 */
function workspaceRootFor(ctx, sessionId) {
  /** @param name - service name. @returns the service, or undefined. */
  const read = (name) => {
    try {
      return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const header = read("sessions")?.get?.(sessionId)?.header;
    if (typeof header?.cwd === "string" && header.cwd !== "") return header.cwd;
  } catch {
    // A session that is already gone has no cwd to read; fall through.
  }
  const root = read("sandboxPolicy")?.workspaceRoot;
  if (typeof root === "string" && root !== "") return root;
  return process.cwd();
}

/**
 * Answer one file read: `{ address }` in, the file's bytes out.
 *
 * The address is the pane's own `dsh-resource://` name for a file the user
 * opened, so the route is never asked for a path the pane did not hand over. It
 * is still resolved and checked here rather than trusted: only an existing
 * regular file is served, and the size is refused before a single byte is read,
 * so a huge file cannot tie up a response body.
 * @param ctx - plugin context, used to resolve a session-relative path.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function fileHandler(ctx, req, res) {
  /** @param status - HTTP status. @param body - JSON-ready payload. */
  const reply = (status, body) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.length),
      "cache-control": "no-store",
    });
    res.end(payload);
  };
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (req.headers[FILE_HEADER] !== "file" || req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const body = await readBody(req);
  if (body === undefined) {
    reply(413, { ok: false, code: "too-large", message: "请求太大" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    reply(400, { ok: false, code: "body", message: "请求不是合法的 JSON" });
    return;
  }
  // `path` is still accepted: a caller that already resolved the address has
  // nothing to add by sending one back.
  const parsed = parseFileAddress(payload?.address);
  const wanted =
    parsed === null
      ? typeof payload?.path === "string"
        ? payload.path
        : ""
      : parsed.scope === "session"
        ? resolve(workspaceRootFor(ctx, parsed.sessionId), parsed.path)
        : parsed.path;
  if (wanted === "" || wanted.includes("\0") || !isAbsolute(wanted)) {
    reply(400, { ok: false, code: "path", message: "需要一个绝对路径" });
    return;
  }
  let info;
  try {
    info = await stat(wanted);
  } catch (error) {
    reply(404, { ok: false, code: "missing", message: String(error?.message ?? error) });
    return;
  }
  if (!info.isFile()) {
    reply(404, { ok: false, code: "missing", message: "不是一个文件" });
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    reply(413, { ok: false, code: "too-large", size: info.size });
    return;
  }
  // `no-store`: the pane asks again whenever the Host says the file changed, and
  // a cached copy would quietly show the old bytes.
  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": String(info.size),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (info.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(wanted);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * Register the asset and translation routes for the lifetime of this plugin.
 * @param ctx - plugin context carrying the web server service.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }),
    "fast-pdf: assets",
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: TRANSLATE_PATH,
        handler: (req, res) => translateHandler(ctx, req, res),
      }),
    "fast-pdf: translate",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: HELLO_PATH, handler: helloHandler }),
    "fast-pdf: hello",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: FILE_PATH, handler: (req, res) => fileHandler(ctx, req, res) }),
    "fast-pdf: file",
  );
}
