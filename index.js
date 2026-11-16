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
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INPUT, translateSelection, translateSelectionStream } from "./translate.js";
import { documentsForSession, resolveDocument, writeDocument } from "./documents.js";
import { deliverImage, failImage, releaseSession, takeWork } from "./bridge.js";
import { readBodyWithin } from "./http-body.js";
import { createTools } from "./tools.js";

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
 * Response header carrying the file's version token.
 *
 * Same shape the Host's own filesystem layer builds from `dev:ino:size:mtimeNs`
 * `:ctimeNs`. The body echoes it back to the Host as the version it is drawing,
 * so a metadata refresh that reports the same token is judged "no change" and
 * does not remount the body behind a second progress bar.
 */
const FILE_VERSION_HEADER = "x-dsh-fast-pdf-version";

/**
 * Exact route the browser half uploads extracted text to.
 *
 * The document tools read what this route stored, so a question about a page
 * still has an answer after the reader closes the pane, switches tabs or
 * reloads. That is the whole reason the text crosses to the Host at all: a tool
 * call cannot ask a renderer for anything, and the conversation outlives the
 * pane.
 */
const SYNC_PATH = `${ROUTE_PREFIX}/sync`;

/**
 * Exact route a pane polls when it is willing to render a page.
 *
 * Ordinary request/response, deliberately: the desktop shell carries this
 * traffic over an IPC bridge and does not necessarily forward a WebSocket
 * upgrade, so the Host-to-browser direction is inverted rather than pushed.
 */
const WORK_PATH = `${ROUTE_PREFIX}/work`;

/** Marker the sync and work routes require. */
const SYNC_HEADER = "x-dsh-fast-pdf";

/**
 * Largest sync upload accepted, in bytes.
 *
 * One chunk of page texts, not the whole manual: the browser sends a few hundred
 * pages at a time, and this ceiling is what a chunk of a very dense document
 * needs. It is separate from `MAX_BODY` because translation input and page text
 * are not the same kind of payload and must not be forced to share a limit.
 */
const MAX_SYNC_BODY = 8 * 1024 * 1024;

/**
 * Largest file the route will stream.
 *
 * The browser half refuses anything over this too, before it starts reading,
 * so the number exists on both sides on purpose: the route answers 413 with
 * the real size, and the body turns that into the one sentence that names it.
 */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Whether a path is absolute in either spelling the Host accepts: POSIX
 * (`/a/b`), a Windows drive (`C:/a/b`) or a UNC path (`//server/share`).
 * `node:path`'s `isAbsolute` only understands the current platform, so a
 * Windows-formatted address would be refused as "需要一个绝对路径" on macOS.
 * @param path - the decoded path.
 * @returns true when the Host would treat it as absolute.
 */
function isAbsoluteWorkspacePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith("\\\\");
}

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

/** Hard cap on kept reports: per-kind buckets alone cannot bound arbitrary kinds. */
const MAX_BEACONS = BEACON_LIMIT * 32;

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

/**
 * Resolve one URL pathname to a file inside `public/`.
 * @param pathname - request pathname, already known to start with the prefix.
 * @returns the absolute file path, or `undefined` when the path escapes the root.
 */
function resolveAsset(pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length));
  } catch {
    // A malformed escape (`%zz`) must be a 404, not a rejected handler promise.
    return undefined;
  }
  relative = relative.replace(/^\/+/, "");
  if (relative === "" || relative.includes("\0")) return undefined;
  const absolute = normalize(join(PUBLIC_DIR, relative));
  const root = PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep;
  return absolute.startsWith(root) ? absolute : undefined;
}

/**
 * ETag and bytes of one asset, always read fresh.
 *
 * A cache keyed only by `(mtimeMs, size)` served stale bytes when a file was
 * rewritten at the same size with its mtime restored — exactly what an editor
 * or a bundler can do — and a page refresh then kept the old viewer. Reading
 * 2.2 MB off local disk costs under a millisecond, while the ETag still saves
 * the network transfer on a 304, so correctness wins here.
 * @param path - absolute file path.
 * @returns identity, or `undefined` when the file is missing or unreadable.
 */
async function identityOf(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const body = await readFile(path);
    return {
      body,
      etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether `If-None-Match` names this entity.
 *
 * RFC 9110 §13.1.2 uses the weak comparison for GET/HEAD: a `W/` prefix, a
 * comma-separated list and `*` all have to match, or a browser/proxy sending
 * any of them would re-download the 2.2 MB worker it already has.
 * @param header - the raw `if-none-match` value.
 * @param etag - this entity's strong ETag.
 * @returns true when a 304 is due.
 */
function revalidates(header, etag) {
  if (typeof header !== "string") return false;
  const bare = etag.replace(/^W\//u, "");
  return header.split(",").some((part) => {
    const value = part.trim().replace(/^W\//u, "");
    return value === "*" || value === bare;
  });
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
  if (revalidates(req.headers["if-none-match"], asset.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers["content-length"] = String(asset.body.length);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : asset.body);
}

/**
 * Read a translation request body as text, refusing anything oversized.
 * @param req - HTTP request.
 * @returns the body, or `undefined` when it is too large or unreadable.
 */
async function readBody(req) {
  return readBodyWithin(req, MAX_BODY);
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
  let tooLarge = false;
  let broken = false;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BEACON_BODY) {
        // Drain to the end before replying, or the unread tail becomes the
        // next request on a reused socket.
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      if (!tooLarge) chunks.push(chunk);
    }
  } catch {
    broken = true;
  }
  if (tooLarge || broken) {
    res.writeHead(tooLarge ? 413 : 400);
    res.end();
    return;
  }
  let report;
  try {
    report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // Only a plain object is a report. A string, number or array would spread
  // into character keys, and a forged `receivedAt` would overwrite our clock.
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    res.writeHead(400);
    res.end();
    return;
  }
  beacons.push({ ...report, receivedAt: Date.now() });
  trimBeacons(String(report?.kind ?? ""));
  while (beacons.length > MAX_BEACONS) beacons.shift();
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
  // One controller for the whole request. A reader that closes the card aborts
  // its fetch; `res`'s `close` event is the only signal this half gets, so it
  // drives both the response loop and the upstream model stream.
  const controller = new AbortController();
  const onClose = () => controller.abort();
  // Minimal response stubs (the smoke test) have no event API; the real
  // ServerResponse is an EventEmitter. Guard both so cancellation is wired
  // wherever it exists without breaking a plain `writeHead`/`end` object.
  const hasEvents = typeof res.on === "function" && typeof res.removeListener === "function";
  if (hasEvents) res.on("close", onClose);
  try {
    if (input?.stream === true) {
      // The reader asked to watch the answer arrive. One JSON object per line is
      // the simplest thing both halves can parse while it is still being written;
      // `x-accel-buffering: no` keeps a proxy from holding the lines back.
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      try {
        for await (const event of translateSelectionStream(ctx, input, { signal: controller.signal })) {
          if (controller.signal.aborted) break;
          // Honour backpressure: a slow reader must not let a long translation
          // pile up unbounded in this process.
          if (res.write(`${JSON.stringify(event)}\n`) === false && hasEvents) {
            await new Promise((resolve) => {
              const done = () => {
                res.removeListener("drain", done);
                res.removeListener("close", done);
                resolve();
              };
              res.on("drain", done);
              res.on("close", done);
            });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          res.write(`${JSON.stringify({ ok: false, message: String(error?.message ?? error) })}\n`);
        }
      }
      // Always finish the response, even when the reader went away mid-stream;
      // `end()` on a destroyed socket is harmless and keeps the listener paired.
      if (!res.writableEnded) res.end();
      return;
    }
    try {
      reply(await translateSelection(ctx, input, { signal: controller.signal }));
    } catch (error) {
      if (!controller.signal.aborted) reply({ ok: false, message: String(error?.message ?? error) });
    }
  } finally {
    if (hasEvents) res.removeListener("close", onClose);
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
      // Match the Host's `dsh-util-workspace-path` grammar: an empty first
      // segment with more behind it is a UNC path's `//`, a first segment like
      // `C:` is a Windows drive, and every other POSIX path needs its leading
      // slash put back. Without these three cases an absolute address never
      // passes the path check and the file route answers 400.
      const unc = parts[0] === "" && parts.length > 1;
      const segments = (unc ? parts.slice(1) : parts).map((part) => decodeURIComponent(part));
      if (segments.length === 0 || segments[0] === "") return null;
      if (unc) return { scope, sessionId: "", path: `//${segments.join("/")}` };
      const drive = /^[A-Za-z]:$/u.test(segments[0]);
      return { scope, sessionId: "", path: drive ? segments.join("/") : `/${segments.join("/")}` };
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
  if (wanted === "" || wanted.includes("\0") || !isAbsoluteWorkspacePath(wanted)) {
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
  // The body reports this token back to the Host as "the version of the file it
  // is drawing", and the Host compares it with the version its own metadata
  // carries: a difference means the file changed, which makes it drop the body
  // and mount it again — a second full read behind a second progress bar. A
  // body with no way to learn the token could only report a constant, and a
  // constant never equals `dev:ino:size:mtimeNs:ctimeNs`, so every metadata
  // frame looked like a change. `bigint` is what carries the nanoseconds; the
  // plain stat above has them rounded to `mtimeMs`, which is not the same token.
  let version = "";
  try {
    const ns = await stat(wanted, { bigint: true });
    version = `${ns.dev}:${ns.ino}:${ns.size}:${ns.mtimeNs}:${ns.ctimeNs}`;
  } catch {
    /* Without it the body falls back to its old constant; reading still works. */
  }
  // `no-store`: the pane asks again whenever the Host says the file changed, and
  // a cached copy would quietly show the old bytes.
  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": String(info.size),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    // A custom response header is invisible to `response.headers.get()` on a
    // cross-origin read, and the body would fall back to its old constant —
    // silently restoring the double load this header exists to stop.
    "access-control-expose-headers": FILE_VERSION_HEADER,
    ...version === "" ? {} : { [FILE_VERSION_HEADER]: version },
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
 * Answer one session identifier, rejecting anything that is not one.
 *
 * The browser learns the id from its own pane and sends it back; the Host trusts
 * the value no further than "a key into its own tables". Refusing empty and
 * non-string values here keeps every route from having to repeat the check.
 * @param value - candidate session id.
 * @returns the id, or undefined.
 */
function sessionIdOf(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Answer one text upload from an open pane.
 *
 * The browser half sends the pages it has extracted so far, in chunks, and gets
 * back what the Host now holds. `docId` is minted by the browser from the
 * document's address and modification time, so reopening the same file reuses
 * one entry and an edited file becomes a different document — the tools never
 * answer from text that belongs to a file the user has since changed.
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function syncHandler(req, res) {
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
  if (req.headers[SYNC_HEADER] !== "sync" || req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const body = await readBodyWithin(req, MAX_SYNC_BODY);
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
  const sessionId = sessionIdOf(payload?.sessionId);
  if (sessionId === undefined) {
    reply(400, { ok: false, code: "session", message: "需要一个会话" });
    return;
  }
  const entry = writeDocument({
    sessionId,
    docId: payload?.docId,
    title: payload?.title,
    address: payload?.address,
    pageCount: payload?.pageCount,
    pages: payload?.pages,
    outline: payload?.outline,
    complete: payload?.complete === true,
  });
  if (entry === undefined) {
    reply(400, { ok: false, code: "body", message: "请求里没有可用的页面文本" });
    return;
  }
  const documents = documentsForSession(sessionId).map((document) => ({
    docId: document.docId,
    title: document.title,
    pageCount: document.pageCount,
    complete: document.complete === true,
  }));
  reply(200, { ok: true, docId: entry.docId, documents });
}

/**
 * Answer one "do you need anything?" poll from an open pane.
 *
 * Held open for a few seconds rather than answered immediately, so a tool call
 * that starts while the pane is idle still finds it. `null` means "nothing to
 * do, ask again"; a job means "render this page and post it back".
 * @param req - HTTP request.
 * @param res - HTTP response.
 */
async function workHandler(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (req.headers[SYNC_HEADER] !== "work" || req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const body = await readBodyWithin(req, 64 * 1024);
  if (body === undefined) {
    res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
    res.end("too large");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad json");
    return;
  }
  const sessionId = sessionIdOf(payload?.sessionId);
  if (sessionId === undefined) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad session");
    return;
  }
  const action = payload?.action;
  /** @param status - HTTP status. @param value - JSON-ready payload. */
  const reply = (status, value) => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    });
    res.end(bytes);
  };
  if (action === "deliver") {
    const accepted = deliverImage(sessionId, payload?.jobId, payload?.dataUrl);
    reply(200, { ok: accepted });
    return;
  }
  if (action === "fail") {
    const accepted = failImage(sessionId, payload?.jobId, payload?.reason);
    reply(200, { ok: accepted });
    return;
  }
  if (action === "bye") {
    releaseSession(sessionId);
    reply(200, { ok: true });
    return;
  }
  // A pane that is closed mid-poll aborts its fetch; the abort has to release
  // the queued waiter, or the Host keeps a resolver alive for a pane that is
  // never coming back.
  const controller = new AbortController();
  const onClose = () => controller.abort();
  const hasEvents = typeof res.on === "function" && typeof res.removeListener === "function";
  if (hasEvents) res.on("close", onClose);
  // The page text lives in this Host's memory, but the index lives in the
  // browser for as long as the tab does, and the two outlive each other in both
  // directions: a plugin reload empties the store while the pane keeps a
  // finished document. Telling the pane that its document is gone is the only
  // way it can repair itself — it holds the pages, this side does not.
  const known = resolveDocument(sessionId, typeof payload?.docId === "string" ? payload.docId : undefined) !== undefined;
  try {
    const work = await takeWork(sessionId, controller.signal);
    if (controller.signal.aborted) return;
    reply(200, work === null ? { ok: true, job: null, known } : { ok: true, job: work, known });
  } finally {
    if (hasEvents) res.removeListener("close", onClose);
  }
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
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: SYNC_PATH, handler: syncHandler }),
    "fast-pdf: sync",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: WORK_PATH, handler: workHandler }),
    "fast-pdf: work",
  );
  // The tools are optional: a Host without the tool service (or a profile where
  // this plugin is loaded for its viewer alone) still gets a working reader, so
  // registration is attempted rather than declared as a hard dependency.
  ctx.effect(() => registerTools(ctx), "fast-pdf: tools");
}

/**
 * Register the document tools if this Host has a tool service.
 *
 * Looked up through `ctx` instead of injected as a dependency for the reason
 * `translate.js` gives: a third-party bundle that fails to activate takes the
 * whole plugin down with it, and the viewer must keep working in a Host that
 * has no tools at all.
 * @param ctx - plugin context.
 * @returns a disposer, or a no-op when there is nothing to register with.
 */
function registerTools(ctx) {
  let tools;
  try {
    tools = typeof ctx?.get === "function" ? ctx.get("tools") : undefined;
  } catch {
    tools = undefined;
  }
  if (tools === undefined || typeof tools.register !== "function") return () => {};
  const disposers = [];
  for (const definition of createTools(ctx)) {
    try {
      disposers.push(tools.register(definition));
    } catch (error) {
      // One rejected definition must not cost the others; the likeliest cause is
      // a name another plugin already owns.
      console.error(`[fast-pdf] could not register ${definition.name}:`, error);
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A disposer that has already run is not an error worth surfacing.
      }
    }
  };
}
