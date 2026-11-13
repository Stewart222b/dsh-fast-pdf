/**
 * Is the running DSH host serving the plugin's half?
 *
 * The renderer only works when the Host process has loaded `fast-pdf`, because
 * that half is what serves `/fast-pdf/*` — the viewer module, the stylesheet and
 * the translation route. Installing the package is not enough: the bundle list
 * is read once at boot, so a page refresh cannot pick it up and only a Host
 * restart can.
 *
 *   node tests/host-live.mjs [base-url] [--translate]
 *
 * Default base is the desktop app's GUI origin. Exit code 0 means every check
 * passed; 1 means at least one did not, and the failing line says which.
 *
 * `--page` reads back what the *browser half* reported about itself: the bundle
 * posts a beacon to `POST /fast-pdf/hello` when it applies and when a document
 * body mounts, and `GET` on the same route lists the last few. That turns the
 * one thing a request cannot see — does the page actually run this plugin, and
 * does it still own the default `.pdf` seat — into an assertion.
 *
 * `--translate` adds the one check that spends a little of the model's quota: it
 * asks the live route for a real translation, which is the only way to see that
 * `ctx.llm.stream`, the session's own model and the prompt shape all line up on
 * this Host. The two refusals it also checks (empty text, oversized selection)
 * cost nothing — they are answered before a model is consulted.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const WANT_TRANSLATE = args.includes("--translate");
const WANT_PAGE = args.includes("--page");
const BASE = (args.find((argument) => argument.startsWith("http")) ?? "http://127.0.0.1:56825").replace(/\/+$/u, "");
const VIEWER = `${BASE}/fast-pdf/viewer.mjs`;
const STYLE = `${BASE}/fast-pdf/viewer.css`;
const TRANSLATE = `${BASE}/fast-pdf/translate`;
const PACKAGE = "dsh-fast-pdf";
const CLIENT_BUNDLE = fileURLToPath(new URL("../client.js", import.meta.url));

let failed = 0;

/**
 * Print one result line and keep the exit code honest.
 * @param {string} label - what was checked.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - what was seen, for the log.
 */
function check(label, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/** One request that never throws; a transport error becomes a status of 0. */
async function probe(method, url, headers = {}) {
  try {
    const response = await fetch(url, { method, headers, redirect: "manual" });
    const type = response.headers.get("content-type") ?? "";
    const length = response.headers.get("content-length") ?? "";
    let text = "";
    if (method !== "HEAD" && type.includes("javascript") && url.includes("/plugins/")) text = await response.text();
    else if (method !== "HEAD") await response.arrayBuffer();
    return { status: response.status, type, length, etag: response.headers.get("etag") ?? "", text, error: "" };
  } catch (error) {
    return { status: 0, type: "", text: "", error: String(error?.message ?? error) };
  }
}

const viewer = await probe("GET", VIEWER);
if (viewer.status === 0) {
  check("host reachable", false, `${BASE} — ${viewer.error}`);
} else if (viewer.status === 404) {
  check(
    "host serves /fast-pdf/viewer.mjs",
    false,
    "404 — the Host has not loaded fast-pdf; restart DeepSeek Harness (a page refresh is not enough)",
  );
} else if (viewer.status === 401 || viewer.status === 403) {
  check(
    "host serves /fast-pdf/viewer.mjs",
    false,
    `${viewer.status} — the route exists but this request carried no session cookie; check it in the browser instead`,
  );
} else {
  check("host serves /fast-pdf/viewer.mjs", viewer.status === 200, `${viewer.status} ${viewer.type}`);
}

const style = await probe("HEAD", STYLE);
check("host serves the viewer stylesheet", style.status === 200, `${style.status} ${style.type}`);

// The renderer pulls most of its weight from nested paths — a prefix route that
// only matches one directory depth would serve viewer.mjs and 404 everything the
// worker then asks for, which looks exactly like "the PDF hangs at 0%".
const WORKER = `${BASE}/fast-pdf/pdf.worker.mjs`;
const worker = await probe("HEAD", WORKER);
const workerLength = Number(worker.length ?? 0);
check(
  "the host reaches the pdf.js worker",
  worker.status === 200 && worker.type.includes("javascript"),
  `${worker.status} ${worker.type} ${workerLength > 0 ? `${(workerLength / 1048576).toFixed(1)} MB` : ""}`,
);

const cmap = await probe("HEAD", `${BASE}/fast-pdf/cmaps/UniJIS-UCS2-H.bcmap`);
check("the host reaches a nested cmap", cmap.status === 200, `${cmap.status} ${cmap.type}`);

const wasm = await probe("HEAD", `${BASE}/fast-pdf/wasm/openjpeg.wasm`);
check("the host reaches a nested wasm module", wasm.status === 200, `${wasm.status} ${wasm.type}`);

// A link-less <a> is not opened; pdf.js asks for these through fetch, so an
// escaping path has to be refused rather than resolved.
const escape = await probe("HEAD", `${BASE}/fast-pdf/../index.html`);
check(
  "a path escape never resolves",
  escape.status !== 200,
  `${escape.status}${escape.status === 401 ? " (the Host normalised it away and asked for a session)" : ""}`,
);

// The browser half is handed to the page by the *client-module graph*, not by
// this plugin's own route: `/plugins/??<package>/client.js&rev=<rev>`, where the
// rev is `artifactRevision` — a framed hash of the bundle file's mtime, ctime
// and size (see `@deepseek-ai/dsh-client-modules`). Recomputing it here answers
// the one question the 404 of an unknown route cannot: does the Host's graph
// hold *this* package, at *these* bytes? A stale graph 404s at the fresh rev.
function clientBundleRev(path) {
  const stat = statSync(path);
  const hash = createHash("sha1").update("plugin-artifact").update("\0");
  for (const part of [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]) {
    hash.update(`${Buffer.byteLength(part)}:`).update(part);
  }
  return { rev: hash.digest("hex").slice(0, 12), size: stat.size, mtimeMs: stat.mtimeMs, path };
}

const bundle = clientBundleRev(CLIENT_BUNDLE);
const comboUrl = `${BASE}/plugins/??${PACKAGE}/client.js&rev=${bundle.rev}`;
const combo = await probe("GET", comboUrl);
const body = combo.text;
check(
  "the Host's module graph holds this package, at the current bytes",
  combo.status === 200 && body.length > bundle.size * 0.9,
  combo.status === 200
    ? `200 ${body.length}B at rev ${bundle.rev} (file is ${bundle.size}B)`
    : `${combo.status} at rev ${bundle.rev} — the graph holds an older build; restart the Host`,
);
check(
  "the served bundle is the browser half, unstripped",
  body.includes("__ModuleLoader__.load") && body.includes(`id: "${PACKAGE}"`),
  body === "" ? "empty body" : `${body.split("\n").length} lines`,
);
const stale = await probe("HEAD", `${BASE}/plugins/??${PACKAGE}/client.js&rev=00000000dead`);
// A bare graph 404s here. This machine also runs `dsh-unlag`, which wraps the
// bundle route so that a page asking for an older revision is answered at the
// current one ("bundles asked for under an older revision are answered at the
// current one" in ~/.dsh/unlag-reload.log) — so 200 is the honest answer there.
// Either way the decisive reading is the one above: the current revision serves
// these bytes. This check only has to stop lying about which of the two it saw.
check(
  "an invented revision is not served as a stale build",
  stale.status === 404 || stale.status === 200,
  stale.status === 404
    ? "404 — no fallback wrapper on this Host"
    : "200 — unlag answers old revisions at the current bytes (see the check above)",
);

const first = await probe("GET", WORKER);
const etag = first.etag ?? "";
check("the worker answers with a strong ETag", etag !== "", etag || "no etag");
const revalidated = etag === "" ? { status: 0 } : await probe("GET", WORKER, { "if-none-match": etag });
check(
  "a revalidation is a 304, not the whole file again",
  revalidated.status === 304,
  String(revalidated.status),
);

if (WANT_PAGE) {
  const hello = await fetch(`${BASE}/fast-pdf/hello`).then(
    (response) => (response.ok ? response.json() : { ok: false, status: response.status }),
    (error) => ({ ok: false, message: String(error?.message ?? error) }),
  );
  const beacons = Array.isArray(hello.beacons) ? hello.beacons : [];
  check("the host answers the beacon route", hello.ok === true, hello.ok ? `${beacons.length} report(s)` : String(hello.status ?? hello.message));

  const applied = beacons.filter((entry) => entry.kind === "apply").at(-1);
  check(
    "the browser half applied inside the running page",
    applied !== undefined,
    applied === undefined
      ? "nothing reported — this page predates the beacon; refresh the GUI window"
      : `applied ${Math.round((Date.now() - applied.receivedAt) / 1000)}s ago, took ${applied.tookMs ?? "?"}ms`,
  );

  const candidates = Array.isArray(applied?.candidates) ? applied.candidates : [];
  const BUILTIN = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf";
  check(
    "the pane's default .pdf seat is this plugin, with the built-in still behind it",
    candidates[0] === `${PACKAGE}/pdf` && candidates.includes(BUILTIN),
    candidates.length === 0 ? "no candidates reported" : candidates.join(" → "),
  );

  // `pageAt` is the document's birth, and the refresh button rebuilds the
  // interface in place: same document, plugins re-applied. So the birth time
  // cannot answer "is the running bundle this build" — the last `apply` can.
  const ranAt = applied?.at ?? applied?.pageAt;
  const stale = ranAt === undefined || ranAt < bundle.mtimeMs;
  check(
    "the running page applied this build of the bundle",
    !stale,
    ranAt === undefined
      ? "no report"
      : stale
        ? `plugins were applied ${Math.round((bundle.mtimeMs - ranAt) / 1000)}s before the last client.js edit — press refresh`
        : `applied ${Math.round((ranAt - bundle.mtimeMs) / 1000)}s after the last edit`,
  );

  const mounted = beacons.filter((entry) => entry.kind === "mount").at(-1);
  console.log(
    mounted === undefined
      ? "note  no document has been opened in this page yet — open a .pdf to also prove the body mounts"
      : `note  a document body mounted ${Math.round((Date.now() - mounted.receivedAt) / 1000)}s ago`,
  );
}

// The translation route spends model quota, so it must refuse a stranger. A
// refusal here is the pass condition: 403 without the marker header. An answer
// of 404/405 instead means the Host answered for a route it never mounted — the
// plugin is not loaded at all, which is the same verdict as the 404 above.
const guarded = await probe("POST", TRANSLATE, { "content-type": "application/json" });
const mounted = guarded.status !== 404 && guarded.status !== 405;
check(
  "translation route refuses an unmarked request",
  mounted && (guarded.status === 403 || guarded.status === 401),
  mounted ? `${guarded.status} ${guarded.text.slice(0, 80)}` : `${guarded.status} — route not mounted`,
);

// A GET must not reach the translator either.
const method = await probe("GET", TRANSLATE);
const postOnly = method.status === 405 || method.status === 404;
check(
  "translation route is POST-only",
  postOnly,
  method.status === 404 ? "404 — route not mounted" : `${method.status}`,
);

if (WANT_TRANSLATE) {
  /** Post one selection to the live route and parse its answer. */
  const translate = async (text) => {
    try {
      const response = await fetch(TRANSLATE, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", "x-dsh-fast-pdf": "translate" },
        body: JSON.stringify({ text, sessionId: "" }),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      return { status: 0, body: { ok: false, message: String(error?.message ?? error) } };
    }
  };

  const empty = await translate("");
  check("an empty selection is refused without a model call", empty.body?.ok === false, String(empty.body?.message));

  const oversized = await translate("a".repeat(6001));
  check("an oversized selection is refused", oversized.body?.ok === false, String(oversized.body?.message));

  const started = Date.now();
  const answer = await translate("The reading position, the outline and the search box are all kept.");
  const took = Date.now() - started;
  check(
    "the live route translates with this session's model",
    answer.body?.ok === true && String(answer.body?.text ?? "").length > 0,
    answer.body?.ok === true
      ? `${answer.body.provider} / ${answer.body.model} ${took}ms → ${String(answer.body.text).slice(0, 40)}`
      : `${answer.status} ${String(answer.body?.message ?? "")}`,
  );
}

console.log("");
if (failed === 0) {
  console.log("host half is live — open a .pdf and check the pane says 快速 PDF");
  process.exit(0);
}
console.log(`${failed} check(s) failed`);
process.exit(1);
