/**
 * Per-document text store for the PDF question-answering tools.
 *
 * The browser half parses the PDF (pdf.js is already running there and has
 * already built the page indexes the find bar uses), then posts the plain page
 * texts here. The tools read from this store, never from the browser: a tool
 * call has to keep working after the reader closes the pane, switches tabs or
 * reloads the page, and the Host cannot call into a renderer on demand.
 *
 * What is kept is deliberately small — the flat text of each page, nothing
 * else. For the 37 MB / 779-page manual measured while designing this, that is
 * 559 KB of strings against a 222 MB peak while pdf.js was parsing. The
 * browser's richer per-page index (normalized-to-raw offsets, dehyphenation
 * positions) stays in the browser where the highlight rectangles are computed.
 *
 * Ownership: a document belongs to the session that opened it. A tool call
 * resolves "the session's document" without the model naming a file, which is
 * the whole point of asking about what is on screen; a `docId` argument remains
 * for the multi-document case.
 *
 * One file in two sessions is two entries, not one shared entry. The `docId`
 * the browser mints from a document's address does not mention the session, so
 * two conversations can legitimately send the same id for the same manual; a
 * store keyed by `docId` alone therefore had one of them overwrite — and, by
 * association, take ownership of — the other's text, and the first conversation
 * silently stopped finding its own document. Keying by session as well makes
 * that collision impossible. The cost is one extra copy of the page texts per
 * session reading the same file (559 KB for the 779-page manual measured here),
 * which is the trade this store deliberately makes: correctness for the reader
 * over a deduplicated buffer.
 */

/**
 * How many documents one session may keep.
 *
 * Two would cover "compare these two", and reading a third replaces the least
 * recently used — a session that opens a folder of PDFs one after another must
 * not accumulate their text forever.
 */
const DOCS_PER_SESSION = 3;

/**
 * Largest text one document may contribute, in bytes.
 *
 * Text, not the PDF: a 779-page manual came to 559 KB. The cap exists so a
 * pathological document (a scanned book that is one giant text layer per page)
 * cannot grow the Host's heap without bound, and it is generous enough that a
 * normal manual never meets it.
 */
export const MAX_DOC_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * Longest single page text kept.
 *
 * A page is a page; anything past this is a malformed text layer and trimming
 * it keeps one page from crowding out the rest of the document's budget.
 */
const MAX_PAGE_CHARS = 200_000;

/**
 * The text store.
 *
 * Keys are `sessionId` + NUL + `docId`. The `docId` half is minted by the
 * browser half from the document's address and modification time, so the same
 * file reopened in one session reuses one entry and an edited file is a
 * different document; the `sessionId` half keeps two sessions that happen to
 * send the same `docId` from sharing (and overwriting) one entry.
 */
const documents = new Map();

/**
 * The store key for one session's copy of one document.
 *
 * NUL cannot occur in either half — a session id is a host name and a `docId` is
 * base-36 — so no pair of distinct inputs can produce the same key.
 * @param sessionId - owning session.
 * @param docId - document identifier from the browser half.
 * @returns the map key.
 */
function keyOf(sessionId, docId) {
  return `${sessionId}\u0000${docId}`;
}

/**
 * Most recently used docIds per session, newest last.
 *
 * A separate map from `documents` because a session's *current* document is a
 * fact about the session (what the reader is looking at), while an entry's
 * liveness is a fact about the entry.
 */
const sessionDocuments = new Map();

/**
 * Free one session's copy of one document.
 *
 * The `sessionDocuments` sweep is kept even though a caller usually already
 * knows the session: it is what removes the id from a focus list that a
 * different session happens to hold, and leaving a dead id there would make the
 * next `resolveDocument` look up an entry that no longer exists.
 * @param sessionId - the owning session.
 * @param docId - the entry to drop.
 */
function forget(sessionId, docId) {
  documents.delete(keyOf(sessionId, docId));
  for (const [owner, list] of sessionDocuments) {
    const at = list.indexOf(docId);
    if (at === -1) continue;
    // Another session's list may name the same id for its own copy; only the
    // owner's copy is gone, so only the owner's list is pruned for it.
    if (owner !== sessionId && documents.has(keyOf(owner, docId))) continue;
    list.splice(at, 1);
    if (list.length === 0) sessionDocuments.delete(owner);
  }
}

/**
 * Record which document a session is reading.
 *
 * Called on every write and on an explicit focus report, and it is what makes
 * `docId` optional for the model: asking about "this PDF" has to mean the one
 * on screen without the model guessing an identifier it was never told.
 * @param sessionId - owning session.
 * @param docId - the document now in front of the reader.
 */
export function focusDocument(sessionId, docId) {
  if (typeof sessionId !== "string" || sessionId === "" || typeof docId !== "string" || docId === "") return;
  const list = sessionDocuments.get(sessionId) ?? [];
  const at = list.indexOf(docId);
  if (at !== -1) list.splice(at, 1);
  list.push(docId);
  sessionDocuments.set(sessionId, list);
  while (list.length > DOCS_PER_SESSION) forget(sessionId, list[0]);
}

/** Longest outline entry title kept. */
const MAX_OUTLINE_TITLE = 300;

/** Most outline entries kept for one document. */
const MAX_OUTLINE_ENTRIES = 4000;

/** Deepest outline nesting kept. */
const MAX_OUTLINE_DEPTH = 12;

/**
 * Reduce an uploaded outline to the fields the tool reports.
 *
 * The browser sends pdf.js's own outline, whose entries carry destination arrays
 * of arbitrary shape. Only the title, the depth and the resolved page survive —
 * a destination this Host cannot read is dropped rather than guessed at, so the
 * tool never cites a page the outline did not actually name.
 * @param rows - candidate rows from the browser half.
 * @returns clean rows, bounded in count and depth.
 */
function normalizeOutline(rows) {
  const out = [];
  for (const row of rows) {
    if (out.length >= MAX_OUTLINE_ENTRIES) break;
    if (row === null || typeof row !== "object") continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (title === "") continue;
    const depth = Number(row.depth);
    if (!Number.isInteger(depth) || depth < 0) continue;
    const page = Number(row.page);
    out.push({
      title: title.length > MAX_OUTLINE_TITLE ? title.slice(0, MAX_OUTLINE_TITLE) : title,
      // Clamped rather than dropped: a reader that reports depth 40 is telling us
      // about its own indentation, not about an entry worth hiding. Losing the
      // row would leave a hole in the table of contents.
      depth: Math.min(depth, MAX_OUTLINE_DEPTH),
      page: Number.isInteger(page) && page > 0 ? page : null,
    });
  }
  return out;
}

/** Longest document title kept. */
const MAX_TITLE = 300;

/**
 * Store or extend one document's page texts.
 *
 * `pages` is sparse on purpose: the browser uploads in chunks so a 779-page
 * manual starts answering questions after the first few hundred pages instead
 * of after the whole scan. A missing page reads as "not indexed yet", which is
 * a truth the tool can report, unlike an empty string that would look like a
 * blank page.
 *
 * Writes are per page and last-one-wins. Nothing orders them beyond that, and
 * nothing needs to: a `docId` names one file at one modification time, so two
 * uploads that overlap can only be carrying the same text. Two panes on the same
 * document — or a reload re-indexing it — therefore cannot corrupt the store by
 * arriving in an order nobody expected.
 * @param input - `{ sessionId, docId, title, address, pageCount, pages, outline, complete }`.
 * @returns the stored entry, or undefined when the payload is unusable.
 */
export function writeDocument(input) {
  const { sessionId, docId, title, address, pageCount, pages, outline, complete } = input ?? {};
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (typeof docId !== "string" || docId === "") return undefined;
  // Three kinds of upload reach here: a chunk of pages, the table of contents on
  // its own, and the closing word that says the index finished. The last one
  // carries neither array — it is a fact about a document that is already
  // stored — so it is accepted for a known docId and refused for an unknown one,
  // where there is nothing for `complete` to be said about.
  const carriesContent = Array.isArray(pages) || Array.isArray(outline);
  const key = keyOf(sessionId, docId);
  if (!carriesContent && !(complete === true && documents.has(key))) return undefined;
  let entry = documents.get(key);
  if (entry === undefined) {
    entry = {
      docId,
      sessionId,
      title: "",
      address: typeof address === "string" ? address : "",
      pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0,
      pages: [],
      outline: [],
      complete: false,
      bytes: 0,
      writtenAt: 0,
      fingerprints: [],
    };
    documents.set(key, entry);
  }
  entry.writtenAt = Date.now();
  // The bytes' identity, when the caller knows it. A pane and the Host can each
  // open the same file under a different address, and without a shared token
  // they would then occupy two slots in a session that keeps three — so the
  // second open would evict the text the first one had already uploaded.
  if (Array.isArray(input?.fingerprints) && fingerprintKey(input.fingerprints) !== "") {
    entry.fingerprints = input.fingerprints;
  }
  if (typeof title === "string" && title.trim() !== "") {
    const trimmed = title.trim();
    entry.title = trimmed.length > MAX_TITLE ? trimmed.slice(0, MAX_TITLE) : trimmed;
  }
  if (typeof address === "string" && address !== "") entry.address = address;
  if (Number.isInteger(pageCount) && pageCount > 0) entry.pageCount = pageCount;
  if (Array.isArray(outline)) entry.outline = normalizeOutline(outline);
  for (const page of pages ?? []) {
    const number = Number(page?.pageNumber);
    if (!Number.isInteger(number) || number < 1) continue;
    if (entry.pageCount > 0 && number > entry.pageCount) continue;
    const text = typeof page?.text === "string" ? page.text : "";
    const clipped = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
    const previous = entry.pages[number - 1];
    const previousBytes = typeof previous === "string" ? Buffer.byteLength(previous, "utf8") : 0;
    const nextBytes = Buffer.byteLength(clipped, "utf8");
    if (entry.bytes - previousBytes + nextBytes > MAX_DOC_TEXT_BYTES) continue;
    entry.bytes = entry.bytes - previousBytes + nextBytes;
    entry.pages[number - 1] = clipped;
    // Grow the array without leaving holes that read as indexed-but-blank.
    for (let index = 0; index < number; index += 1) if (entry.pages[index] === undefined) entry.pages[index] = null;
  }
  if (complete === true) entry.complete = true;
  focusDocument(sessionId, docId);
  return entry;
}

/**
 * The document a tool call should read by default.
 *
 * Resolution order: the named `docId` when the model supplied one, then the
 * document this session is reading, then — only if the session has exactly one
 * document stored — that one. The last step covers a session whose focus report
 * never arrived (a pane opened before this plugin finished loading), while
 * still refusing to guess between several.
 * @param sessionId - calling session.
 * @param docId - optional identifier from the model.
 * @returns the entry, or undefined when nothing matches.
 */
export function resolveDocument(sessionId, docId) {
  if (typeof docId === "string" && docId !== "") return documents.get(keyOf(sessionId, docId));
  const list = sessionDocuments.get(sessionId);
  if (list !== undefined && list.length > 0) {
    const current = documents.get(keyOf(sessionId, list[list.length - 1]));
    if (current !== undefined) return current;
  }
  let only;
  for (const entry of documents.values()) {
    if (entry.sessionId !== sessionId) continue;
    if (only !== undefined) return undefined;
    only = entry;
  }
  return only;
}

/**
 * FNV-1a, seven base-36 digits.
 *
 * The browser half has this same function, because a `docId` has to be the same
 * string on both sides for the pane's upload and the Host's own read to land on
 * one entry. It is an identity, not a security boundary, so a short
 * non-cryptographic hash is the right size for it — long enough that two
 * manuals in one session do not collide, short enough to read in a tool call.
 * @param text - input.
 * @returns seven base-36 digits.
 */
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/**
 * The identifier a document is stored under.
 *
 * Address plus pdf.js's fingerprints: the address names the file, and the
 * fingerprints change when its bytes do. This must stay byte-identical to
 * `documentIdOf` in `client.js`, or the pane and the Host would store the same
 * document twice.
 * @param address - the pane's file address, or the Host's resolved path.
 * @param fingerprints - pdf.js document fingerprints, when available.
 * @returns the docId.
 */
export function documentIdOf(address, fingerprints) {
  return `d${shortHash(`${String(address)}\u0000${fingerprintKey(fingerprints)}`)}`;
}

/**
 * The bytes' identity as one comparable string.
 *
 * Deliberately a plain `join`, with no normalisation: pdf.js returns
 * `[hash, null]` — the second slot is a second fingerprint that this build does
 * not fill in — and the browser half joins that array exactly as it stands. Any
 * tidying here (mapping `null` to the string "null", filtering, sorting) would
 * make the two halves disagree about the same file, and then one manual would be
 * stored twice and evict itself from a session that keeps three documents.
 * @param fingerprints - pdf.js fingerprints, in their raw form.
 * @returns the identity string, or "" when there is none.
 */
function fingerprintKey(fingerprints) {
  return Array.isArray(fingerprints) ? fingerprints.join(",") : "";
}

/**
 * The document a session already holds for one file, matched by fingerprint.
 *
 * Two entry points reach the same file: the pane, which knows the tab's
 * `dsh-resource://` address, and the Host reading a path itself. Their addresses
 * differ ("session/<id>/manual.pdf" versus an absolute path), so `docId` — which
 * is derived from the address — differs too, and the same 448-page manual would
 * be parsed twice and stored twice in a session that keeps three documents.
 *
 * pdf.js's fingerprints are derived from the file's bytes, so they name the file
 * rather than the route to it. Matching on them makes the second open extend the
 * first instead of competing with it.
 * @param sessionId - the calling session.
 * @param fingerprints - the candidate file's pdf.js fingerprints.
 * @returns the existing entry, or undefined.
 */
export function findByFingerprints(sessionId, fingerprints) {
  if (typeof sessionId !== "string" || sessionId === "" || !Array.isArray(fingerprints) || fingerprints.length === 0) {
    return undefined;
  }
  const wanted = fingerprintKey(fingerprints);
  if (wanted === "") return undefined;
  for (const entry of documents.values()) {
    if (entry.sessionId !== sessionId) continue;
    if (fingerprintKey(entry.fingerprints) === wanted) return entry;
  }
  return undefined;
}

/**
 * Every document a session has stored, newest first.
 * @param sessionId - calling session.
 * @returns the entries, for the listing tool and for `docId` error messages.
 */
export function documentsForSession(sessionId) {
  const out = [];
  for (const entry of documents.values()) {
    if (entry.sessionId === sessionId) out.push(entry);
  }
  out.sort((left, right) => right.writtenAt - left.writtenAt);
  return out;
}

/**
 * One page's text, or undefined when that page has not been uploaded yet.
 * @param entry - a stored document.
 * @param pageNumber - 1-based page number.
 * @returns the text, which may be an empty string for a page with no text layer.
 */
export function pageText(entry, pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return undefined;
  const value = entry.pages[pageNumber - 1];
  return typeof value === "string" ? value : undefined;
}

/**
 * How many pages of one document have usable text.
 * @param entry - a stored document.
 * @returns the count.
 */
export function indexedPageCount(entry) {
  let count = 0;
  for (const value of entry.pages) if (typeof value === "string") count += 1;
  return count;
}

/**
 * Normalize text for matching: NFKC, folded whitespace, lower case.
 *
 * The browser half has a richer normalizer (it maps every normalized character
 * back to a raw offset so highlights land on the right glyphs). The Host has no
 * glyphs to place, only a page to name, so it needs just enough folding for a
 * query to match text that was wrapped across lines: NFKC turns ligatures and
 * full-width forms into their plain letters, and collapsing whitespace makes
 * "the quick\nbrown" match "the quick brown".
 * @param text - raw text.
 * @returns the folded form.
 */
function fold(text) {
  return foldWithMap(text).folded;
}

/**
 * Fold text and keep, for every folded character, the raw character it came from.
 *
 * The map exists so a snippet can be quoted from the *raw* page: folding changes
 * both length and offset (a ligature becomes two letters, a run of spaces becomes
 * one), so slicing the raw text at a folded offset quotes the wrong words, and
 * slicing the folded text quotes the right words in the wrong case — a search for
 * "ACIC" would answer with "acic", which is not what the page says and not what
 * the model should cite.
 * @param text - raw text.
 * @param lower - whether to lowercase as well; a case-sensitive search still
 *   needs the whitespace map, because collapsing spaces moves offsets either way.
 * @returns `{ folded, map }`, where `map[i]` is the raw index of folded char `i`.
 */
function foldWithMap(text, lower = true) {
  let folded = "";
  const map = [];
  /** Raw index of a whitespace run waiting to be written as one space. */
  let space = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/u.test(char)) {
      if (space === -1 && folded !== "") space = index;
      continue;
    }
    if (space !== -1) {
      folded += " ";
      map.push(space);
      space = -1;
    }
    // Per character rather than per string: NFKC of a whole page can reorder
    // across characters in ways this map cannot follow, and a searchable page
    // only needs the compositions that live inside one character.
    const composed = char.normalize("NFKC");
    for (const unit of lower ? composed.toLowerCase() : composed) {
      folded += unit;
      map.push(index);
    }
  }
  return { folded, map };
}

/** Longest query the search accepts, in characters. */
export const MAX_QUERY = 512;

/**
 * Context characters kept on each side of a hit.
 *
 * Enough to tell whether the hit is the one the question was about ("… set the
 * ion source to **positive** mode …"), short enough that twenty hits stay well
 * inside a tool result.
 */
const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 120;

/**
 * Search one document's pages for a query.
 *
 * Plain substring matching, not a token index: the browser already exposes a
 * full search with highlighting to the person reading, and the model's use is
 * different — it has a phrase in mind ("error 4021", "positive ion mode") and
 * wants the pages where that phrase appears. Substring matching is exactly that
 * question, needs no index to build or invalidate, and stays predictable when
 * the query is Chinese, where word-boundary rules do not apply.
 *
 * One hit per page. A page where the phrase appears six times is still one page
 * to go and read, and a list that repeats it six times pushes five other pages
 * past the limit — `limit` therefore counts pages, which is the unit the caller
 * is deciding about.
 * @param entry - a stored document.
 * @param query - what to look for.
 * @param options - `{ limit, matchCase }`.
 * @returns hits, each `{ pageNumber, snippet, offset }`, in page order.
 */
export function searchDocumentText(entry, query, options = {}) {
  const raw = typeof query === "string" ? query.trim() : "";
  if (raw === "") return [];
  const matchCase = options.matchCase === true;
  const needle = matchCase ? raw.replace(/\s+/gu, " ") : fold(raw);
  if (needle === "") return [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 12;
  const hits = [];
  for (let index = 0; index < entry.pages.length; index += 1) {
    const text = entry.pages[index];
    if (typeof text !== "string" || text === "") continue;
    // Match on the folded text, but quote the raw one. The map is what makes
    // that possible: it says which raw character each folded offset came from,
    // so the snippet keeps the page's own capitalisation and punctuation while
    // the comparison still ignores case, width and line breaks.
    const { folded, map } = foldWithMap(text, !matchCase);
    const at = folded.indexOf(needle);
    if (at === -1) continue;
    const from = map[at] ?? 0;
    const last = at + Math.max(0, needle.length - 1);
    const to = (map[last] ?? from) + 1;
    const start = Math.max(0, from - SNIPPET_BEFORE);
    const end = Math.min(text.length, to + SNIPPET_AFTER);
    hits.push({
      pageNumber: index + 1,
      offset: from,
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < text.length ? "…" : ""}`,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Outline entries matching a query, for narrowing a wide table of contents.
 * @param entry - a stored document.
 * @param query - optional filter; everything is returned when empty.
 * @param limit - most rows to return.
 * @returns rows, each `{ title, depth, page }`.
 */
export function searchOutline(entry, query, limit = 200) {
  const needle = typeof query === "string" ? fold(query.trim()) : "";
  const rows = [];
  for (const row of entry.outline) {
    if (needle !== "" && !fold(row.title).includes(needle)) continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Test seam: forget every stored document. */
export function resetDocuments() {
  documents.clear();
  sessionDocuments.clear();
}
