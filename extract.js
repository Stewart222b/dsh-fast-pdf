/**
 * Reading a PDF in the Host process, without a browser.
 *
 * The plugin was built the other way round: the pane parsed the document and
 * pushed its text to the Host, because — for a year of this project's notes —
 * pdf.js was believed not to load in Node at all. That belief turned out to be
 * wrong. It failed with `hashOriginal.toHex is not a function`, which is not a
 * pdf.js problem but a Node one: pdf.js's modern build calls three standard
 * methods this runtime does not ship, and three small shims make it work
 * completely. Measured on the workspace's own manuals: 448 pages in 1.6 s,
 * 779 pages in 1.9 s, peak RSS about 274 MB, text a few hundred kilobytes.
 *
 * That changes where a document may come from. A conversation about "the PDF in
 * this workspace" no longer needs the pane to be open, because the Host can read
 * the file itself. This module is that path: resolve a path, read the bytes,
 * extract every page's text and the outline, and hand the result to the same
 * store the pane fills.
 *
 * Two deliberate choices:
 *
 * - **The same indexer as the viewer.** Page text comes from
 *   `public/search.mjs`'s `buildTextIndex`, the function the pane uses, not from
 *   a second concatenation written here. Search snippets and page text then read
 *   identically whichever side produced them, and a bug fixed in one is fixed in
 *   both.
 * - **Nothing browser-shaped is imported.** `public/pdf.mjs` is the modern
 *   build, and it is imported dynamically *after* the shims are in place: a
 *   static import would be hoisted above them and fail on the very call the
 *   shims exist to satisfy.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isAbsoluteWorkspacePath, parseFileAddress, workspaceRootFor } from "./paths.js";

/**
 * Largest PDF this route will parse.
 *
 * The same ceiling the file route already enforces, for the same reason: past
 * this the pane would refuse the file too, and holding a copy of it in the
 * Host's heap to discover that is the expensive way to find out.
 */
const MAX_PDF_BYTES = 256 * 1024 * 1024;

/**
 * Install the three standard methods pdf.js needs and this Node does not have.
 *
 * Node 24.22.1 ships none of them (`Map.getOrInsertComputed`,
 * `Uint8Array.prototype.toHex`, `Uint8Array.prototype.toBase64` are all
 * `undefined`), and pdf.js's modern build calls all three while hashing and
 * encoding. The error without them is `hashOriginal.toHex is not a function`.
 *
 * Written defensively on purpose: each one checks for an existing
 * implementation first, so a future Node that ships them is left alone, and each
 * is defined non-enumerably so a `for ... in` over a typed array or a Map does
 * not start seeing new names. `toHex` and `toBase64` are only ever used on byte
 * buffers, so delegating to `Buffer` is exact rather than approximate.
 */
function installPdfjsShims() {
  const define = (target, name, value) => {
    try {
      if (target[name] === undefined) {
        Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
      }
    } catch {
      // A frozen intrinsic would already have the method, so this cannot lose a
      // shim that was needed.
    }
  };
  define(Map.prototype, "getOrInsertComputed", function getOrInsertComputed(key, compute) {
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key, value);
    return value;
  });
  define(Uint8Array.prototype, "toHex", function toHex() {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("hex");
  });
  define(Uint8Array.prototype, "toBase64", function toBase64() {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
  });
}

/** The loaded pdf.js module, once. */
let libraryPromise;

/**
 * Load pdf.js with the shims installed first.
 *
 * Cached across calls: the module is 860 KB of parsed JavaScript, and a
 * conversation that opens three documents should pay for it once. The shims are
 * installed before the `import` is awaited, which is the whole reason this is a
 * function rather than a top-level import.
 * @returns the pdf.js namespace.
 */
function loadLibrary() {
  if (libraryPromise === undefined) {
    installPdfjsShims();
    libraryPromise = import("./public/pdf.mjs").then((module) => module.default ?? module, (error) => {
      // A failed import must not be remembered as "this never works": the next
      // call should be free to succeed, for instance after a partial install.
      libraryPromise = undefined;
      throw error;
    });
  }
  return libraryPromise;
}

/**
 * Resolve one outline destination to a page number.
 *
 * pdf.js hands back destinations in several shapes: a string naming a named
 * destination, an explicit array whose first element is a page index or a page
 * reference object. Anything else is genuinely unresolvable here, and returning
 * null for it is what stops the tool citing a page the outline never named.
 * @param doc - the loaded document.
 * @param dest - a destination from the outline.
 * @returns the 1-based page number, or null.
 */
async function pageOfDestination(doc, dest) {
  let explicit = dest;
  if (typeof dest === "string") {
    try {
      explicit = await doc.getDestination(dest);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const first = explicit[0];
  if (typeof first === "number") return Number.isInteger(first) && first >= 0 ? first + 1 : null;
  try {
    const index = await doc.getPageIndex(first);
    return Number.isInteger(index) && index >= 0 ? index + 1 : null;
  } catch {
    return null;
  }
}

/**
 * Flatten pdf.js's nested outline into the rows the store keeps.
 *
 * Depth is carried explicitly because the store sorts and indents by it, and the
 * browser sends the same shape. Children of an entry are visited in order, so a
 * caller reading the tool's output sees the table of contents as it is printed.
 * @param doc - the loaded document.
 * @param rows - outline entries from `getOutline()`.
 * @param depth - current nesting level.
 * @param out - accumulator.
 * @returns the flattened rows.
 */
async function flattenOutline(doc, rows, depth, out) {
  for (const row of rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (title !== "") {
      out.push({ title, depth, page: await pageOfDestination(doc, row.dest) });
    }
    if (Array.isArray(row.items) && row.items.length > 0) {
      await flattenOutline(doc, row.items, depth + 1, out);
    }
  }
  return out;
}

/**
 * Read one file's bytes, refusing anything the route would refuse.
 * @param path - absolute path to the file.
 * @returns `{ data, size }`, or a failure describing why not.
 */
async function readPdfBytes(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return { ok: false, code: "missing", message: `No such file: ${String(error?.message ?? error)}` };
  }
  if (!info.isFile()) return { ok: false, code: "missing", message: `Not a file: ${path}` };
  if (info.size > MAX_PDF_BYTES) {
    return { ok: false, code: "too-large", message: `That PDF is ${info.size} bytes, over the ${MAX_PDF_BYTES} byte limit.` };
  }
  try {
    return { ok: true, data: new Uint8Array(await readFile(path)), size: info.size };
  } catch (error) {
    return { ok: false, code: "missing", message: String(error?.message ?? error) };
  }
}

/**
 * Extract every page's text and the outline from a PDF on disk.
 *
 * Returns the same page shape the pane uploads — `{ pageNumber, text }` — so the
 * store, the search index and the reading tools cannot tell which side a
 * document came from. Extraction is sequential because pdf.js's worker applies
 * backpressure per page anyway; running pages in parallel only moves the peak
 * memory up for no wall-clock gain that matters at 1.6 s per 448 pages.
 * @param path - absolute path to the PDF.
 * @param options - `{ maxPages }` to stop early, for a smoke test.
 * @returns a result envelope; `pages` and `outline` are present only on success.
 */
export async function extractPdf(path, options = {}) {
  const wanted = String(path ?? "");
  if (wanted === "" || wanted.includes("\0")) {
    return { ok: false, code: "path", message: "A file path is required." };
  }
  const bytes = await readPdfBytes(wanted);
  if (bytes.ok === false) return bytes;

  let library;
  try {
    library = await loadLibrary();
  } catch (error) {
    return { ok: false, code: "library", message: `pdf.js could not be loaded: ${String(error?.message ?? error)}` };
  }

  // The indexer is the viewer's own, imported here rather than reimplemented so
  // both halves of the plugin produce byte-identical page text.
  const { buildTextIndex } = await import("./public/search.mjs");

  let doc;
  try {
    doc = await library.getDocument({
      // `data` is transferred to the document and detached, so nothing below
      // should expect to read these bytes again.
      data: bytes.data,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (error) {
    return { ok: false, code: "open", message: String(error?.message ?? error) };
  }

  const pageCount = Number(doc.numPages) || 0;
  const limit = Number.isInteger(options.maxPages) && options.maxPages > 0 ? Math.min(options.maxPages, pageCount) : pageCount;
  const pages = [];
  try {
    for (let number = 1; number <= limit; number += 1) {
      const page = await doc.getPage(number);
      // `disableNormalization: true` matches the viewer: pdf.js's own
      // normalization would rewrite characters the viewer keeps, and the two
      // sides would then disagree about what a page says.
      const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
      pages.push({ pageNumber: number, text: buildTextIndex(content).text });
      page.cleanup?.();
    }
  } catch (error) {
    doc.cleanup?.();
    return { ok: false, code: "extract", message: String(error?.message ?? error) };
  }

  let outline = [];
  try {
    outline = await flattenOutline(doc, await doc.getOutline(), 0, []);
  } catch {
    // A document with a broken table of contents is still a document. The store
    // accepts an empty outline, and the reading tools work without one.
    outline = [];
  }

  // `doc.destroy` does not exist on this build; `cleanup` releases the page
  // caches. Without it a conversation that opens several manuals keeps each
  // one's parsed content alive until the process exits.
  doc.cleanup?.();
  return {
    ok: true,
    pageCount,
    pages,
    outline,
    // Raw, not tidied: the pane joins this array as it stands, so normalising it
    // here would give the same file two identities and defeat the deduplication
    // in the store.
    fingerprints: Array.isArray(doc.fingerprints) ? doc.fingerprints : [],
    truncated: limit < pageCount,
    size: bytes.size,
  };
}

/**
 * Resolve a caller-named location to an absolute path.
 *
 * Accepts the three spellings a model or a pane might produce: a
 * `dsh-resource://` address, an absolute path, or a path relative to the
 * session's workspace. The last one is resolved against the workspace root the
 * Host itself would use, so "the PDF named in the issue" means the same file the
 * user has open.
 * @param ctx - plugin context.
 * @param sessionId - the calling session.
 * @param target - a path or an address.
 * @returns `{ path }` or `{ message }`.
 */
export function resolvePdfPath(ctx, sessionId, target) {
  const text = typeof target === "string" ? target.trim() : "";
  if (text === "") return { message: "A path or document address is required." };
  if (text.includes("\0")) return { message: "That path contains a NUL byte." };
  const parsed = parseFileAddress(text);
  if (parsed !== null) {
    if (parsed.scope === "session") {
      return { path: resolve(workspaceRootFor(ctx, parsed.sessionId || sessionId), parsed.path) };
    }
    return { path: parsed.path };
  }
  if (isAbsoluteWorkspacePath(text)) return { path: text };
  return { path: resolve(workspaceRootFor(ctx, sessionId), text) };
}
