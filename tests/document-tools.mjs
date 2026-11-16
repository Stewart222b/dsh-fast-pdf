/**
 * Headless test for the document half: the text store, the tools that read it,
 * and the route the browser uploads through.
 *
 *   node tests/document-tools.mjs
 *
 * Everything here runs without a PDF, a browser or a Host. What it pins down is
 * the part that would otherwise be discovered only by asking a real question:
 * which document a tool resolves, what a sparse store reports for a page it has
 * not seen, and whether a refusal is a sentence the model can act on instead of
 * an exception that ends the turn.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

const store = await import(pathToFileURL(join(ROOT, "documents.js")).href);
const bridge = await import(pathToFileURL(join(ROOT, "bridge.js")).href);
const { createTools } = await import(pathToFileURL(join(ROOT, "tools.js")).href);

/** A tool call's execution context, shaped like the Host's. */
const exec = (sessionId, extra = {}) => ({
  agent: { id: sessionId, session: { requestHeader: () => ({ config: { provider: "p", model: "m" } }) } },
  signal: undefined,
  ...extra,
});

/**
 * One stored document with pages 1..n.
 * @param docId - identifier.
 * @param count - page count.
 * @param textOf - page text builder.
 * @returns the stored entry.
 */
const seed = (docId, count, textOf = (page) => `page ${page} text`) => {
  const pages = [];
  for (let page = 1; page <= count; page += 1) pages.push({ pageNumber: page, text: textOf(page) });
  return store.writeDocument({
    sessionId: "s-1",
    docId,
    title: `${docId}.pdf`,
    address: `dsh-resource://file/session/s-1/${docId}.pdf`,
    pageCount: count,
    pages,
    complete: true,
  });
};

console.log("text store");

await check("a document is stored page by page", async () => {
  store.resetDocuments();
  bridge.resetBridge();
  const entry = seed("d-one", 3);
  assert.equal(entry.pageCount, 3);
  assert.equal(store.indexedPageCount(entry), 3);
  assert.equal(store.pageText(entry, 2), "page 2 text");
  assert.equal(store.pageText(entry, 9), undefined, "a page never uploaded must not read as blank");
});

await check("a chunk that arrives late fills the pages it carries", async () => {
  store.resetDocuments();
  seed("d-late", 6, () => "");
  const entry = store.writeDocument({
    sessionId: "s-1",
    docId: "d-late",
    pageCount: 6,
    pages: [{ pageNumber: 5, text: "fifth" }],
    complete: true,
  });
  assert.equal(store.pageText(entry, 5), "fifth");
  assert.equal(store.pageText(entry, 2), "", "an empty page is a page with no text, not a missing one");
  assert.equal(store.indexedPageCount(entry), 6, "holes are filled so page 5 does not hide pages 1-4");
});

await check("a page past the end is refused, and a huge one is clipped", async () => {
  store.resetDocuments();
  const entry = store.writeDocument({
    sessionId: "s-1",
    docId: "d-limits",
    pageCount: 2,
    pages: [
      { pageNumber: 9, text: "past the end" },
      { pageNumber: 0, text: "not a page" },
      { pageNumber: 1, text: "x".repeat(500_000) },
    ],
  });
  assert.equal(store.pageText(entry, 9), undefined);
  assert.equal(store.pageText(entry, 0), undefined);
  assert.equal(store.pageText(entry, 1).length, 200_000, "one page is clipped, so a scan cannot eat the budget");
});

await check("one session keeps its documents, another keeps its own", async () => {
  store.resetDocuments();
  seed("d-a", 2);
  store.writeDocument({ sessionId: "s-2", docId: "d-b", pageCount: 2, pages: [] });
  assert.deepEqual(store.documentsForSession("s-1").map((entry) => entry.docId), ["d-a"]);
  assert.deepEqual(store.documentsForSession("s-2").map((entry) => entry.docId), ["d-b"]);
  assert.equal(store.resolveDocument("s-1", "d-b"), undefined, "another session's document is not addressable");
});

await check("the current document is the one the reader reported last", async () => {
  store.resetDocuments();
  seed("d-old", 1);
  seed("d-new", 1);
  assert.equal(store.resolveDocument("s-1", undefined).docId, "d-new");
  store.focusDocument("s-1", "d-old");
  assert.equal(store.resolveDocument("s-1", undefined).docId, "d-old");
  assert.equal(store.resolveDocument("s-1", "d-new").docId, "d-new", "a named document wins over the focus");
});

await check("a session keeps at most three documents and drops the oldest", async () => {
  store.resetDocuments();
  seed("d-1", 1);
  seed("d-2", 1);
  seed("d-3", 1);
  seed("d-4", 1);
  const ids = store.documentsForSession("s-1").map((entry) => entry.docId).sort();
  assert.deepEqual(ids, ["d-2", "d-3", "d-4"], "the oldest document is the one evicted, not the newest");
  assert.equal(store.resolveDocument("s-1", "d-1"), undefined, "an evicted document is no longer addressable");
  assert.equal(store.resolveDocument("s-1", undefined).docId, "d-4");
});

await check("a document id from another session is not addressable by name", async () => {
  store.resetDocuments();
  seed("d-mine", 1);
  store.writeDocument({ sessionId: "s-2", docId: "d-theirs", pageCount: 1, pages: [] });
  assert.equal(store.resolveDocument("s-1", "d-theirs"), undefined);
  assert.equal(store.resolveDocument("s-2", "d-theirs").docId, "d-theirs");
});

await check("two sessions sending one document id keep separate copies", async () => {
  // The `docId` a pane mints comes from the document's address, and an address
  // is `dsh-resource://file/session/<sessionId>/<path>` — which names one
  // session, not the file. Nothing stops two conversations from opening the
  // same manual, and when they do they send the same id for it. Measured on the
  // old store, which was keyed by `docId` alone: the second writer's `sessionId`
  // was written over the entry, and the first conversation then found nothing —
  // the document it had just indexed disappeared from `pdf_list`, with no error
  // anywhere to explain it. Two copies are the fix; the cost is the page texts
  // twice, which for the 779-page manual measured here is 559 KB.
  store.resetDocuments();
  const mine = store.writeDocument({
    sessionId: "s-1",
    docId: "d-shared",
    title: "Manual.pdf",
    pageCount: 1,
    pages: [{ pageNumber: 1, text: "opened by s-1" }],
    complete: true,
  });
  const theirs = store.writeDocument({
    sessionId: "s-2",
    docId: "d-shared",
    title: "Manual.pdf",
    pageCount: 1,
    pages: [{ pageNumber: 1, text: "opened by s-2" }],
    complete: true,
  });
  assert.notEqual(mine, theirs, "one id in two sessions is two entries");
  assert.equal(store.pageText(mine, 1), "opened by s-1", "the first session keeps its own text");
  assert.equal(store.pageText(theirs, 1), "opened by s-2", "the second session keeps its own text");
  assert.equal(store.resolveDocument("s-1", "d-shared").sessionId, "s-1", "ownership did not move to the later writer");
  assert.equal(store.resolveDocument("s-2", "d-shared").sessionId, "s-2");
  assert.deepEqual(store.documentsForSession("s-1").map((entry) => entry.docId), ["d-shared"]);
  assert.deepEqual(store.documentsForSession("s-2").map((entry) => entry.docId), ["d-shared"]);

  // Writing again from the first session must not reach the second's copy, and
  // the same is true of the closing word, which carries no pages at all.
  store.writeDocument({ sessionId: "s-1", docId: "d-shared", pages: [{ pageNumber: 1, text: "rewritten by s-1" }] });
  assert.equal(store.pageText(theirs, 1), "opened by s-2", "a later write by one session leaves the other's copy alone");
  assert.equal(store.pageText(mine, 1), "rewritten by s-1", "and does land in its own copy");
});

console.log("search and outline");

await check("the closing word marks a document complete without carrying pages", async () => {
  // The pane sends three kinds of upload: a chunk of pages, the outline alone,
  // and — once the cursor reaches the end — one last message that carries
  // neither and only says the index finished. Refusing that one left the pane
  // retrying a 400 every three seconds forever, on every document.
  store.resetDocuments();
  seed("d-done", 2);
  const closed = store.writeDocument({ sessionId: "s-1", docId: "d-done", complete: true });
  assert.ok(closed !== undefined, "a known document can be closed");
  assert.equal(closed.complete, true);
  assert.equal(store.pageText(closed, 1), "page 1 text", "closing must not disturb the pages");
  assert.equal(
    store.writeDocument({ sessionId: "s-1", docId: "d-unknown", complete: true }),
    undefined,
    "closing a document that was never stored says nothing about anything",
  );
});

await check("search finds a phrase and reports the page that holds it", async () => {
  store.resetDocuments();
  seed("d-search", 4, (page) => (page === 3 ? "Set the network mask here." : `page ${page}`));
  const hits = store.searchDocumentText(store.resolveDocument("s-1"), "network mask", {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pageNumber, 3);
  assert.match(hits[0].snippet, /network mask/u);
});

await check("search folds case, width and whitespace the way a reader expects", async () => {
  store.resetDocuments();
  seed("d-fold", 1, () => "ＦＵＬＬ　ＷＩＤＴＨ  and\nnewlines");
  const entry = store.resolveDocument("s-1");
  assert.equal(store.searchDocumentText(entry, "full width", {}).length, 1, "NFKC and folded spaces must match");
  assert.equal(
    store.searchDocumentText(entry, "FULL WIDTH", { matchCase: true }).length,
    1,
    "a case-sensitive hit still folds width, or a CJK manual is unsearchable when quoted exactly",
  );
  assert.equal(store.searchDocumentText(entry, "full width", { matchCase: true }).length, 0, "but case still matters");
});

await check("a snippet quotes the page's own capitalisation", async () => {
  // Folding is for comparing, not for quoting. A search for "acic" that answers
  // with "enabling acic/esd about this task" has rewritten the document — the
  // page says "Enabling ACIC/ESD About this task", and that is what a citation
  // has to reproduce.
  store.resetDocuments();
  seed("d-case", 1, () => "5.4.2.2. Enabling ACIC/ESD About this task The ACIC algorithm helps.");
  const hits = store.searchDocumentText(store.resolveDocument("s-1"), "acic", {});
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /Enabling ACIC\/ESD About this task/u);
  assert.doesNotMatch(hits[0].snippet, /enabling acic/u);
});

await check("a snippet survives a width-folded page", async () => {
  // The folded text is not the same length as the raw one: full-width forms
  // shrink to half-width and doubled spaces collapse. Cutting the raw page at a
  // folded offset would quote text from before the match.
  store.resetDocuments();
  seed("d-width", 1, () => "prefix ＦＵＬＬ　ＷＩＤＴＨ marker tail");
  const hits = store.searchDocumentText(store.resolveDocument("s-1"), "marker", {});
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /ＦＵＬＬ ＷＩＤＴＨ marker tail/u);
});

await check("a case-sensitive search still cuts its snippet in the right place", async () => {
  // Collapsing doubled spaces shortens the text, so the folded offset is not the
  // raw one. Slicing the raw page there quotes the wrong span — off by the width
  // of every collapsed run before the match.
  store.resetDocuments();
  seed("d-space", 1, () => "a  b  Enabling ACIC About");
  const entry = store.resolveDocument("s-1");
  const hit = store.searchDocumentText(entry, "Enabling ACIC", { matchCase: true })[0];
  assert.ok(hit !== undefined, "a case-sensitive search must still match");
  assert.equal(hit.snippet, "a b Enabling ACIC About");
  assert.equal(store.searchDocumentText(entry, "enabling acic", { matchCase: true }).length, 0);
});

await check("search does not report the same page once per occurrence", async () => {
  store.resetDocuments();
  seed("d-repeat", 2, (page) => (page === 1 ? "mask mask mask" : "mask"));
  const hits = store.searchDocumentText(store.resolveDocument("s-1"), "mask", {});
  assert.deepEqual(hits.map((hit) => hit.pageNumber), [1, 2]);
});

await check("search honors its limit", async () => {
  store.resetDocuments();
  seed("d-many", 20);
  assert.equal(store.searchDocumentText(store.resolveDocument("s-1"), "page", { limit: 5 }).length, 5);
  assert.equal(store.searchDocumentText(store.resolveDocument("s-1"), "page", { limit: 500 }).length, 20);
});

await check("the outline is filtered and depth is preserved", async () => {
  store.resetDocuments();
  const entry = store.writeDocument({
    sessionId: "s-1",
    docId: "d-outline",
    pageCount: 20,
    pages: [],
    outline: [
      { title: "Getting started", depth: 0, page: 1 },
      { title: "Installing", depth: 1, page: 3 },
      { title: "Network setup", depth: 1, page: 7 },
      { title: "", depth: 2, page: 8 },
      { title: "Bad depth", depth: 99, page: 9 },
    ],
  });
  assert.deepEqual(entry.outline.map((row) => row.title), ["Getting started", "Installing", "Network setup", "Bad depth"]);
  assert.equal(entry.outline.find((row) => row.title === "Bad depth").depth, 12, "depth is clamped, not dropped");
  assert.deepEqual(store.searchOutline(entry, "net", 10).map((row) => row.title), ["Network setup"]);
});

console.log("tools");

await check("every tool declares a render and a supported schema", async () => {
  const tools = createTools({ get: () => undefined });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "pdf_search",
    "pdf_read_pages",
    "pdf_outline",
    "pdf_page_image",
    "pdf_list",
  ]);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, "function", `${tool.name} needs execute`);
    assert.equal(typeof tool.output?.render, "function", `${tool.name} needs output.render`);
    assert.equal(tool.output.schema.type, "object", `${tool.name} must describe an object value`);
    assert.equal(tool.parameters.type, "object", `${tool.name} must take an object`);
  }
});

await check("no document open is an answer, not an exception", async () => {
  store.resetDocuments();
  const tools = createTools({ get: () => undefined });
  const search = tools.find((tool) => tool.name === "pdf_search");
  const value = await search.execute({ query: "anything" }, exec("s-empty"));
  assert.deepEqual(value.hits, []);
  assert.match(value.note, /No PDF has been read/u);
  const rendered = search.output.render({ query: "anything" }, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, "text");
  assert.match(rendered[0].text, /No PDF has been read/u, "the note is what the model reads");
});

await check("search renders page numbers the model can cite", async () => {
  store.resetDocuments();
  seed("d-cite", 3, (page) => (page === 2 ? "the mask is 255.0.0.0" : `page ${page}`));
  const tools = createTools({ get: () => undefined });
  const search = tools.find((tool) => tool.name === "pdf_search");
  const value = await search.execute({ query: "255.0.0.0" }, exec("s-1"));
  const rendered = search.output.render({ query: "255.0.0.0" }, value);
  assert.match(rendered[0].text, /p\.2:/u);
  assert.match(rendered[0].text, /3\/3 pages searchable/u);
});

await check("read_pages accepts a range, a list and a single number", async () => {
  store.resetDocuments();
  seed("d-read", 10);
  const tools = createTools({ get: () => undefined });
  const read = tools.find((tool) => tool.name === "pdf_read_pages");
  const range = await read.execute({ pages: "3-5" }, exec("s-1"));
  assert.deepEqual(range.pages.map((page) => page.pageNumber), [3, 4, 5]);
  const list = await read.execute({ pages: "1,2,7" }, exec("s-1"));
  assert.deepEqual(list.pages.map((page) => page.pageNumber), [1, 2, 7]);
  const single = await read.execute({ pages: "9" }, exec("s-1"));
  assert.deepEqual(single.pages.map((page) => page.pageNumber), [9]);
  assert.match(read.output.render({}, range)[0].text, /--- p\.3 ---/u);
});

await check("read_pages refuses a page the document does not have", async () => {
  store.resetDocuments();
  seed("d-short", 4);
  const tools = createTools({ get: () => undefined });
  const read = tools.find((tool) => tool.name === "pdf_read_pages");
  await assert.rejects(() => read.execute({ pages: "40-50" }, exec("s-1")), /this document has 4 pages/u);
});

await check("read_pages marks a page that has not been indexed yet", async () => {
  store.resetDocuments();
  store.writeDocument({
    sessionId: "s-1",
    docId: "d-partial",
    pageCount: 4,
    pages: [{ pageNumber: 1, text: "first" }],
  });
  const tools = createTools({ get: () => undefined });
  const read = tools.find((tool) => tool.name === "pdf_read_pages");
  const value = await read.execute({ pages: "1-3" }, exec("s-1"));
  assert.equal(value.pages[0].text, "first");
  assert.equal(value.pages[1].pending, true);
  assert.match(value.note, /Pages 2, 3 have not been read yet/u);
});

await check("read_pages keeps one call inside its character budget", async () => {
  store.resetDocuments();
  seed("d-heavy", 3, () => "y".repeat(20_000));
  const tools = createTools({ get: () => undefined });
  const read = tools.find((tool) => tool.name === "pdf_read_pages");
  const value = await read.execute({ pages: "1-3" }, exec("s-1"));
  assert.equal(value.truncated, true);
  const total = value.pages.reduce((sum, page) => sum + page.text.length, 0);
  assert.ok(total <= 24_000, `the budget must hold, got ${total}`);
  assert.match(read.output.render({}, value)[0].text, /output truncated/u);
});

await check("read_pages says which pages have no text layer", async () => {
  store.resetDocuments();
  seed("d-empty", 2, () => "");
  const tools = createTools({ get: () => undefined });
  const read = tools.find((tool) => tool.name === "pdf_read_pages");
  const value = await read.execute({ pages: "1" }, exec("s-1"));
  assert.equal(value.pages[0].empty, true);
  assert.match(read.output.render({}, value)[0].text, /pdf_page_image can look at it/u);
});

await check("outline reports when a document has none", async () => {
  store.resetDocuments();
  seed("d-nooutline", 2);
  const tools = createTools({ get: () => undefined });
  const outline = tools.find((tool) => tool.name === "pdf_outline");
  const value = await outline.execute({}, exec("s-1"));
  assert.deepEqual(value.entries, []);
  assert.match(value.note, /no table of contents/u);
});

await check("list reports the documents this session has read", async () => {
  store.resetDocuments();
  seed("d-list", 2);
  const tools = createTools({ get: () => undefined });
  const list = tools.find((tool) => tool.name === "pdf_list");
  const value = await list.execute({}, exec("s-1"));
  assert.equal(value.documents.length, 1);
  assert.equal(value.documents[0].docId, "d-list");
  assert.match(list.output.render({}, value)[0].text, /d-list/u);
});

await check("page_image refuses politely when the model cannot see", async () => {
  store.resetDocuments();
  seed("d-image", 3);
  const tools = createTools({ get: () => undefined });
  const image = tools.find((tool) => tool.name === "pdf_page_image");
  const value = await image.execute({ page: 2 }, exec("s-1"));
  assert.equal(value.image, undefined);
  assert.match(value.note, /does not accept images/u);
  const blocks = image.output.render({}, value);
  assert.equal(blocks.length, 1, "no image block when there is no image");
  assert.equal(blocks[0].type, "text");
});

await check("page_image refuses a page past the end", async () => {
  store.resetDocuments();
  seed("d-image2", 2);
  const tools = createTools({ get: () => undefined });
  const image = tools.find((tool) => tool.name === "pdf_page_image");
  await assert.rejects(() => image.execute({ page: 7 }, exec("s-1")), /past the end/u);
});

console.log("page image bridge");

await check("a page image request finds the pane that asks for work", async () => {
  bridge.resetBridge();
  const waiting = bridge.requestPageImage("s-1", { pageNumber: 4, docId: "d-1" }, {});
  const job = await bridge.takeWork("s-1", undefined);
  assert.ok(job !== null, "the pane must be given the job");
  assert.equal(job.pageNumber, 4);
  assert.equal(job.docId, "d-1");
  assert.equal(bridge.deliverImage("s-1", job.id, "data:image/jpeg;base64,AAAA"), true);
  const { dataUrl } = await waiting;
  assert.equal(dataUrl, "data:image/jpeg;base64,AAAA");
  assert.equal(bridge.jobCount(), 0, "a delivered job must not linger");
});

await check("a job handed to another session is refused", async () => {
  bridge.resetBridge();
  const waiting = bridge.requestPageImage("s-1", { pageNumber: 1, docId: "" }, {});
  const job = await bridge.takeWork("s-1", undefined);
  assert.equal(bridge.deliverImage("s-2", job.id, "data:image/jpeg;base64,AAAA"), false);
  assert.equal(bridge.failImage("s-2", job.id, "not yours"), false);
  assert.equal(bridge.deliverImage("s-1", job.id, "not-an-image"), false, "only an image counts as a delivery");
  bridge.failImage("s-1", job.id, "different document");
  await assert.rejects(() => waiting, /different document/u);
});

await check("a pane that closes fails the job instead of hanging", async () => {
  bridge.resetBridge();
  const waiting = bridge.requestPageImage("s-1", { pageNumber: 1, docId: "" }, {});
  bridge.releaseSession("s-1");
  await assert.rejects(() => waiting, /pane was closed/u);
  assert.equal(bridge.jobCount(), 0);
});

await check("a cancelled tool call releases the job it queued", async () => {
  bridge.resetBridge();
  const controller = new AbortController();
  const waiting = bridge.requestPageImage("s-1", { pageNumber: 1, docId: "" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => waiting, /cancelled/u);
  assert.equal(bridge.jobCount(), 0, "a cancelled job must not be handed to a pane later");
  // A pane polling afterwards must be told there is nothing, not be handed the
  // cancelled page. The wait is cut short by an abort, and the `setTimeout`
  // that fires it is deliberately *referenced*: the bridge unrefs its own
  // timers so a Host with no other work can exit, which in a bare test process
  // would let the loop drain before any of them fire.
  const later = new AbortController();
  const keeper = setTimeout(() => later.abort(), 20);
  const gone = await bridge.takeWork("s-1", later.signal);
  clearTimeout(keeper);
  assert.equal(gone, null);
});

await check("a burst of renders is capped", async () => {
  bridge.resetBridge();
  const waiting = [];
  for (let index = 0; index < 4; index += 1) {
    waiting.push(bridge.requestPageImage("s-1", { pageNumber: index + 1, docId: "" }, {}));
  }
  await assert.rejects(() => bridge.requestPageImage("s-1", { pageNumber: 9, docId: "" }, {}), /too many page renders/u);
  bridge.resetBridge();
  for (const promise of waiting) await promise.catch(() => {});
});

console.log("sync route");

await check("the sync route stores what the pane uploads", async () => {
  store.resetDocuments();
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const routes = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  });
  const sync = routes.find((route) => route.path === "/fast-pdf/sync");
  assert.ok(sync, "the sync route must exist");

  /**
   * Post one payload to a route.
   * @param handler - the route handler.
   * @param body - JSON body, or a raw string.
   * @param headers - request headers.
   * @returns status and parsed body.
   */
  const post = async (handler, body, headers = { "x-dsh-fast-pdf": "sync" }) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const out = { status: 0, body: undefined };
    const req = {
      method: "POST",
      url: "/fast-pdf/sync",
      headers,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(raw, "utf8");
      },
    };
    await handler(req, {
      writeHead(status) { out.status = status; return this; },
      end(payload) {
        if (payload === undefined) return;
        const text = payload.toString("utf8");
        try {
          out.body = JSON.parse(text);
        } catch {
          out.text = text;
        }
      },
    });
    return out;
  };

  const ok = await post(sync.handler, {
    sessionId: "s-sync",
    docId: "d-sync",
    title: "manual.pdf",
    address: "dsh-resource://file/session/s-sync/manual.pdf",
    pageCount: 3,
    pages: [{ pageNumber: 1, text: "hello" }],
    complete: false,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.docId, "d-sync");
  assert.deepEqual(ok.body.documents, [{ docId: "d-sync", title: "manual.pdf", pageCount: 3, complete: false }]);
  assert.equal(store.pageText(store.resolveDocument("s-sync", "d-sync"), 1), "hello");

  const forbidden = await post(sync.handler, { sessionId: "s-sync" }, {});
  assert.equal(forbidden.status, 403, "a request without the marker must be refused");
  const crossSite = await post(sync.handler, { sessionId: "s-sync" }, {
    "x-dsh-fast-pdf": "sync",
    "sec-fetch-site": "cross-site",
  });
  assert.equal(crossSite.status, 403, "a cross-site request must be refused even with the marker");
  const noSession = await post(sync.handler, { docId: "d-x", pages: [] });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.body.code, "session");
  const broken = await post(sync.handler, "{not json");
  assert.equal(broken.status, 400);
  assert.equal(broken.body.code, "body");
  const empty = await post(sync.handler, { sessionId: "s-sync" });
  assert.equal(empty.status, 400, "a payload with neither pages nor outline is not a document");
});

await check("the sync route answers GET with the method it allows", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const routes = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  });
  const sync = routes.find((route) => route.path === "/fast-pdf/sync");
  const out = { status: 0, headers: {} };
  await sync.handler(
    { method: "GET", url: "/fast-pdf/sync", headers: {} },
    {
      writeHead(status, headers = {}) { out.status = status; out.headers = headers; return this; },
      end() {},
    },
  );
  assert.equal(out.status, 405);
  assert.equal(out.headers.allow, "POST");
});

await check("the poll tells a pane its document is gone, so it can send the pages again", async () => {
  // The page text lives in the Host's memory and the index lives in the
  // browser, and the two outlive each other in both directions: a plugin reload
  // empties the store while the pane keeps a document it has already finished
  // uploading. Neither side noticed, and the conversation was told there was no
  // PDF when 779 pages were open on screen. The pane's poll is the only channel
  // that travels Host-to-pane, so the answer carries `known` and the pane
  // re-uploads when it is false.
  store.resetDocuments();
  bridge.resetBridge();
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const routes = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  });
  const work = routes.find((route) => route.path === "/fast-pdf/work");
  assert.ok(work, "the work route must exist");

  /**
   * Post one payload to the work route, with a job already queued so the held
   * request answers at once instead of waiting out its timeout.
   * @param sessionId - the session polling.
   * @param docId - the document the pane believes it uploaded.
   * @returns the parsed answer.
   */
  const poll = async (sessionId, docId) => {
    const queued = bridge.requestPageImage(sessionId, { pageNumber: 1, docId: "" }, {});
    queued.catch(() => {});
    const out = { status: 0, body: undefined };
    const res = {
      writeHead(status) { out.status = status; return this; },
      end(payload) {
        if (payload !== undefined) out.body = JSON.parse(payload.toString("utf8"));
      },
      on() { return this; },
      removeListener() { return this; },
    };
    const raw = JSON.stringify({ sessionId, action: "poll", docId });
    await work.handler(
      {
        method: "POST",
        url: "/fast-pdf/work",
        headers: { "x-dsh-fast-pdf": "work" },
        async *[Symbol.asyncIterator]() { yield Buffer.from(raw, "utf8"); },
      },
      res,
    );
    // The job was taken by this poll, so release the render it is waiting on.
    bridge.failImage(sessionId, out.body?.job?.id, "test");
    await queued.catch(() => {});
    return out.body;
  };

  seed("d-known", 1);
  const present = await poll("s-1", "d-known");
  assert.equal(present.known, true, "a document this session uploaded is known");

  // The Host forgets everything, exactly as a plugin reload does.
  store.resetDocuments();
  const gone = await poll("s-1", "d-known");
  assert.equal(gone.known, false, "a pane holding a document the Host lost must be told");
  assert.equal(gone.job !== undefined, true, "the answer still carries work when there is work");
});

await check("the tools reach the Host through apply", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const registered = [];
  const routes = [];
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    get: (name) =>
      name === "tools"
        ? { register: (definition) => { registered.push(definition.name); return () => {}; } }
        : undefined,
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    log: () => {},
  });
  assert.deepEqual(registered, ["pdf_search", "pdf_read_pages", "pdf_outline", "pdf_page_image", "pdf_list"]);
});

await check("a Host without a tool service still gets its routes", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "index.js")).href);
  const routes = [];
  assert.doesNotThrow(() =>
    mod.apply({
      effect: (fn) => { fn(); return () => {}; },
      get: () => { throw new Error("no such service"); },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    }),
  );
  assert.equal(routes.length, 6, "a throwing service lookup must not cost the viewer its routes");
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
