/**
 * The document tools: how the model reads the PDF the user has open.
 *
 * These are the whole point of the integration. The reader already has every
 * page's text and every page's pixels; what it lacks is a conversation. Rather
 * than rebuild an agent loop inside the plugin (own key, own retrieval, own
 * citations — which is what the standalone browser extension does), the plugin
 * exposes the document to the Host's own agent and lets it decide what to read.
 *
 * Deliberately thin: search returns page numbers and short snippets, reading
 * returns the page text, the outline returns titles and pages. The model
 * composes those into an answer and cites `p.42`, which the reader can then turn
 * into a jump. Nothing here summarizes, answers or calls a model — that is the
 * conversation's job, and it already has a better view of what was asked.
 *
 * Registration caveat: `@deepseek-ai/*` must not be imported at module scope.
 * A third-party bundle that fails to import does not merely lose these tools,
 * it fails to activate, taking the viewer with it. So the tool table is looked
 * up through `ctx` at apply time and the definitions below are plain objects
 * matching the `ToolDefinition` contract — `register` checks the shape, not the
 * provenance.
 */
import {
  MAX_QUERY,
  documentsForSession,
  indexedPageCount,
  pageText,
  resolveDocument,
  searchDocumentText,
  searchOutline,
} from "./documents.js";
import { requestPageImage } from "./bridge.js";

/** Most pages one `pdf_read_pages` call may return. */
const MAX_READ_PAGES = 12;

/**
 * Most characters one `pdf_read_pages` call may return in total.
 *
 * A page runs 700–1500 characters in a manual, so this is a few dense pages or
 * a dozen light ones — enough to answer a question, small enough that the model
 * still has room to reason about the answer instead of the raw dump.
 */
const MAX_READ_CHARS = 24_000;

/**
 * Most outline rows one call returns.
 *
 * A 779-page manual's table of contents is a few hundred rows; past that the
 * caller should filter with `query` rather than page through it.
 */
const MAX_OUTLINE_ROWS = 200;

/**
 * Largest rendered page accepted from the browser, in bytes.
 *
 * The pane renders at 1400 px on the long edge as JPEG, which lands around
 * 150 KB. This is a ceiling against a misbehaving client, not a target.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** `output.schema` for the per-document envelope every tool reports. */
const DOCUMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    docId: { type: "string" },
    title: { type: "string" },
    pageCount: { type: "integer" },
    indexedPages: { type: "integer" },
    complete: { type: "boolean" },
  },
};

/**
 * What a tool reports when there is no document to read.
 *
 * Not an exception: "no PDF is open" is an ordinary state of a conversation
 * that has not opened one yet, and a tool error would end the turn instead of
 * letting the model say so.
 * @param sessionId - the calling session.
 * @returns the message shown to the model.
 */
function missingDocument(sessionId) {
  const known = documentsForSession(sessionId);
  if (known.length === 0) {
    return "No PDF has been read in this session yet. Open one in the document preview pane; its text is uploaded automatically once it has been parsed.";
  }
  return `No document matched. Documents read in this session: ${known
    .map((entry) => `${entry.docId} (${entry.pageCount || "?"} pages)`)
    .join(", ")}. Pass docId to choose one.`;
}

/**
 * The envelope describing one stored document.
 * @param entry - a stored document.
 * @returns the reportable fields.
 */
function describe(entry) {
  return {
    docId: entry.docId,
    title: titleOf(entry),
    pageCount: entry.pageCount,
    indexedPages: indexedPageCount(entry),
    complete: entry.complete === true,
  };
}

/**
 * A display name for one document.
 *
 * The browser sends the pane's own file name when it has one; otherwise the
 * tail of the address is the best available answer and is still better than an
 * opaque id in an answer the user has to read.
 * @param entry - a stored document.
 * @returns the name.
 */
function titleOf(entry) {
  if (typeof entry.title === "string" && entry.title !== "") return entry.title;
  const address = typeof entry.address === "string" ? entry.address : "";
  const cut = address.split(/[?#]/u)[0] ?? "";
  const tail = cut.split("/").filter((part) => part !== "").pop();
  if (tail === undefined) return entry.docId;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/**
 * Parse a page specification: `[3, 7]`, `"3-7"`, or `"3,7-9"`.
 *
 * Three spellings because three are what callers actually send, and refusing
 * two of them teaches nothing. Ranges are inclusive, as page references in a
 * manual are.
 * @param pages - the argument as received.
 * @param pageCount - the document's page count, for clamping.
 * @returns sorted unique page numbers, or an empty array when unusable.
 */
function parsePages(pages, pageCount) {
  const wanted = new Set();
  const add = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) return;
    if (pageCount > 0 && number > pageCount) return;
    wanted.add(number);
  };
  if (Array.isArray(pages)) {
    for (const entry of pages) add(entry);
  } else if (typeof pages === "number") {
    add(pages);
  } else if (typeof pages === "string") {
    for (const part of pages.split(",")) {
      const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/u);
      if (range === null) {
        add(part.trim());
        continue;
      }
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) continue;
      // A reversed or huge range is a caller mistake, not a request to read the
      // rest of the book: cap the expansion rather than looping to page 10^9.
      const stop = Math.min(to, from + MAX_READ_PAGES - 1);
      for (let number = from; number <= stop; number += 1) add(number);
    }
  }
  return [...wanted].sort((left, right) => left - right);
}

/**
 * Whether the calling model can accept an image.
 *
 * Asked of the route rather than assumed, because the answer decides between
 * returning the page and returning a sentence that says which model would.
 * A service that is missing counts as "no": the tools still work for text.
 * @param ctx - plugin context.
 * @param exec - tool execution context.
 * @returns true when the current route declares image input.
 */
async function routeTakesImages(ctx, exec) {
  /** @param name - service name. @returns the service or undefined. */
  const read = (name) => {
    try {
      return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  const llm = read("llm");
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") return false;
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (typeof provider !== "string" || typeof model !== "string") return false;
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    return info?.inputModalities?.includes("image") === true;
  } catch {
    return false;
  }
}

/**
 * Decode one `data:image/...;base64,…` payload.
 * @param dataUrl - the rendered page.
 * @returns `{ data, mediaType }`, or undefined when it is not a usable image.
 */
function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string") return undefined;
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,([\s\S]+)$/u);
  if (match === null) return undefined;
  const mediaType = match[1];
  if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp") return undefined;
  let data;
  try {
    data = Buffer.from(match[2], "base64");
  } catch {
    return undefined;
  }
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return undefined;
  return { data: new Uint8Array(data), mediaType };
}

/**
 * Build the tool definitions.
 *
 * Every definition is a plain `ToolDefinition`: `parameters` is raw JSON Schema
 * and `output.render` turns the canonical value into content blocks. `execute`
 * returns only lossless JSON — an image travels as an attachment reference,
 * never as bytes in the value.
 * @param ctx - plugin context, read lazily for `attachments` and `llm`.
 * @returns the definitions, in the order the model should see them.
 */
export function createTools(ctx) {
  /** @param text - model-facing text. @returns one content block. */
  const text = (value) => [{ type: "text", text: value }];

  return [
    {
      name: "pdf_search",
      description:
        "Search the text of the PDF open in the document preview pane. Returns matching page numbers with a short snippet of context around each hit. Use this first for a fact that should appear verbatim in the document (an error code, an option name, a setting); cite the pages it returns as `p.N`.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: `Text to look for, verbatim (max ${MAX_QUERY} characters).` },
          docId: {
            type: "string",
            description: "Which document, when the session has more than one. Omit for the one on screen.",
          },
          limit: { type: "integer", description: "Most hits to return (default 12, max 50)." },
          matchCase: {
            type: "boolean",
            description: "Match case exactly. Width and line breaks are still folded. Default false.",
          },
        },
        required: ["query"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document: DOCUMENT_SCHEMA,
            hits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  pageNumber: { type: "integer" },
                  snippet: { type: "string" },
                },
              },
            },
            note: { type: "string" },
          },
        },
        render: (_args, value) => text(renderSearch(value)),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec?.agent?.id;
        const query = typeof args?.query === "string" ? args.query.trim() : "";
        if (query === "") throw new Error("query must be a non-empty string");
        if (query.length > MAX_QUERY) throw new Error(`query is too long (max ${MAX_QUERY} characters)`);
        const entry = resolveDocument(sessionId, args?.docId);
        if (entry === undefined) {
          return { hits: [], note: missingDocument(sessionId) };
        }
        const hits = searchDocumentText(entry, query, { limit: args?.limit, matchCase: args?.matchCase === true });
        const note =
          hits.length === 0
            ? indexedPageCount(entry) < entry.pageCount
              ? `No match yet, and only ${indexedPageCount(entry)} of ${entry.pageCount} pages have been read so far. Try again shortly, or read a page directly.`
              : "No match. Try a shorter or differently spelled query."
            : undefined;
        return {
          document: describe(entry),
          hits: hits.map((hit) => ({ pageNumber: hit.pageNumber, snippet: hit.snippet })),
          ...note === undefined ? {} : { note },
        };
      },
    },
    {
      name: "pdf_read_pages",
      description:
        "Read the text of specific pages of the PDF open in the document preview pane. Pages are 1-based; pass a list, or a string like `3-7` or `3,7-9`. Returns each page's extracted text, so treat it as the document's own words and cite `p.N`.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pages: {
            type: "string",
            description: "Pages to read: a number, a comma-separated list, or a range (`3-7`).",
          },
          docId: {
            type: "string",
            description: "Which document, when the session has more than one. Omit for the one on screen.",
          },
        },
        required: ["pages"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document: DOCUMENT_SCHEMA,
            pages: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  pageNumber: { type: "integer" },
                  text: { type: "string" },
                  empty: { type: "boolean" },
                  pending: { type: "boolean" },
                },
              },
            },
            truncated: { type: "boolean" },
            note: { type: "string" },
          },
        },
        render: (_args, value) => text(renderPages(value)),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec?.agent?.id;
        const entry = resolveDocument(sessionId, args?.docId);
        if (entry === undefined) {
          return { pages: [], note: missingDocument(sessionId) };
        }
        const wanted = parsePages(args?.pages, entry.pageCount);
        if (wanted.length === 0) {
          throw new Error(
            entry.pageCount > 0
              ? `no usable page numbers in "${String(args?.pages)}"; this document has ${entry.pageCount} pages`
              : `no usable page numbers in "${String(args?.pages)}"`,
          );
        }
        const out = [];
        let budget = MAX_READ_CHARS;
        let truncated = false;
        for (const pageNumber of wanted.slice(0, MAX_READ_PAGES)) {
          const value = pageText(entry, pageNumber);
          if (value === undefined) {
            out.push({ pageNumber, text: "", pending: true });
            continue;
          }
          if (value === "") {
            out.push({ pageNumber, text: "", empty: true });
            continue;
          }
          if (value.length > budget) {
            out.push({ pageNumber, text: value.slice(0, Math.max(0, budget)), empty: false });
            truncated = true;
            budget = 0;
            continue;
          }
          budget -= value.length;
          out.push({ pageNumber, text: value, empty: false });
        }
        if (wanted.length > MAX_READ_PAGES) truncated = true;
        const pending = out.filter((page) => page.pending === true).map((page) => page.pageNumber);
        return {
          document: describe(entry),
          pages: out,
          truncated,
          ...pending.length === 0
            ? {}
            : { note: `Pages ${pending.join(", ")} have not been read yet; ask again once indexing finishes.` },
        };
      },
    },
    {
      name: "pdf_outline",
      description:
        "Report the table of contents of the PDF open in the document preview pane, with the page each entry starts on. Use it to find which chapter covers a topic before searching or reading. Pass `query` to filter by title.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Only entries whose title contains this text." },
          docId: {
            type: "string",
            description: "Which document, when the session has more than one. Omit for the one on screen.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document: DOCUMENT_SCHEMA,
            entries: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  depth: { type: "integer" },
                  page: { type: "integer" },
                },
              },
            },
            note: { type: "string" },
          },
        },
        render: (_args, value) => text(renderOutline(value)),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec?.agent?.id;
        const entry = resolveDocument(sessionId, args?.docId);
        if (entry === undefined) {
          return { entries: [], note: missingDocument(sessionId) };
        }
        const rows = searchOutline(entry, args?.query, MAX_OUTLINE_ROWS);
        return {
          document: describe(entry),
          entries: rows.map((row) => ({
            title: row.title,
            depth: row.depth,
            ...row.page === null ? {} : { page: row.page },
          })),
          ...rows.length === 0
            ? {
                note:
                  entry.outline.length === 0
                    ? "This document has no table of contents; use pdf_search instead."
                    : "No outline entry matched that text.",
              }
            : {},
        };
      },
    },
    {
      name: "pdf_page_image",
      description:
        "Render one page of the PDF as an image and look at it. Use this when the text layer is not enough: a diagram, a chart, a scanned page, a photo of a connector panel, a table whose layout carries the meaning. Requires a model that accepts images.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer", description: "Page number, 1-based." },
          docId: {
            type: "string",
            description: "Which document, when the session has more than one. Omit for the one on screen.",
          },
        },
        required: ["page"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            document: DOCUMENT_SCHEMA,
            pageNumber: { type: "integer" },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string" },
                mediaType: { type: "string" },
                bytes: { type: "integer" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
            },
            note: { type: "string" },
          },
        },
        render: (_args, value) => {
          const blocks = [];
          const head = value.note === undefined ? `Page ${String(value.pageNumber)} of ${String(value.document?.title ?? "the document")}` : value.note;
          blocks.push({ type: "text", text: head });
          if (value.image !== undefined) {
            blocks.push({
              type: "image",
              attachment: {
                attachmentId: value.image.attachmentId,
                mediaType: value.image.mediaType,
                bytes: value.image.bytes,
                width: value.image.width,
                height: value.image.height,
              },
            });
          }
          return blocks;
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id;
        const entry = resolveDocument(sessionId, args?.docId);
        if (entry === undefined) {
          return { pageNumber: Number(args?.page) || 1, note: missingDocument(sessionId) };
        }
        const pageNumber = Number(args?.page);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("page must be a positive integer");
        if (entry.pageCount > 0 && pageNumber > entry.pageCount) {
          throw new Error(`page ${pageNumber} is past the end of this document (${entry.pageCount} pages)`);
        }
        if (!(await routeTakesImages(ctx, exec))) {
          return {
            document: describe(entry),
            pageNumber,
            note: `The current model does not accept images, so page ${pageNumber} was not rendered. Switch to an image-capable model to look at a page, or use pdf_read_pages for its text.`,
          };
        }
        const attachments = ctx.get("attachments");
        if (attachments === undefined) {
          return {
            document: describe(entry),
            pageNumber,
            note: "No attachment store is mounted in this Host, so a page image cannot be returned.",
          };
        }
        const { dataUrl } = await requestPageImage(
          sessionId,
          { pageNumber, docId: entry.docId },
          { signal: exec.signal },
        );
        const decoded = decodeImage(dataUrl);
        if (decoded === undefined) throw new Error("the reader returned an unusable page image");
        const ref = await attachments.saveImage({
          data: decoded.data,
          mediaType: decoded.mediaType,
          name: `${titleOf(entry)}-p${pageNumber}.${decoded.mediaType === "image/png" ? "png" : "jpg"}`,
        });
        return {
          document: describe(entry),
          pageNumber,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          },
        };
      },
    },
    {
      name: "pdf_list",
      description:
        "List the PDFs that have been read in this session, with their page counts and how many pages are already searchable. Use it when a session may have opened more than one document, or when pdf_search says no document matched.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            documents: { type: "array", items: DOCUMENT_SCHEMA },
            note: { type: "string" },
          },
        },
        render: (_args, value) => text(renderList(value)),
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const sessionId = exec?.agent?.id;
        const documents = documentsForSession(sessionId).map(describe);
        return {
          documents,
          ...documents.length === 0 ? { note: missingDocument(sessionId) } : {},
        };
      },
    },
  ];
}

/**
 * Render search results for the model.
 * @param value - the canonical value.
 * @returns the text block body.
 */
function renderSearch(value) {
  if (value.note !== undefined && value.hits.length === 0) return value.note;
  const head = `${value.document.title} (${value.document.indexedPages}/${value.document.pageCount} pages searchable)`;
  const lines = value.hits.map((hit) => `p.${hit.pageNumber}: ${hit.snippet}`);
  return [head, ...lines, ...(value.note === undefined ? [] : ["", value.note])].join("\n");
}

/**
 * Render page texts for the model.
 * @param value - the canonical value.
 * @returns the text block body.
 */
function renderPages(value) {
  if (value.pages.length === 0) return value.note ?? "No pages were read.";
  const parts = [`${value.document.title} (${value.document.pageCount} pages)`];
  for (const page of value.pages) {
    if (page.pending === true) {
      parts.push(`--- p.${page.pageNumber} ---\n(not read yet)`);
      continue;
    }
    if (page.empty === true) {
      parts.push(`--- p.${page.pageNumber} ---\n(no text on this page; it may be an image — pdf_page_image can look at it)`);
      continue;
    }
    parts.push(`--- p.${page.pageNumber} ---\n${page.text}`);
  }
  if (value.truncated === true) parts.push("(output truncated; ask for fewer pages to see the rest)");
  if (value.note !== undefined) parts.push(value.note);
  return parts.join("\n");
}

/**
 * Render the outline for the model.
 * @param value - the canonical value.
 * @returns the text block body.
 */
function renderOutline(value) {
  if (value.entries.length === 0) return value.note ?? "No outline entries.";
  const lines = value.entries.map((row) => {
    const indent = "  ".repeat(Math.min(row.depth, 8));
    return `${indent}${row.title}${row.page === undefined ? "" : ` — p.${row.page}`}`;
  });
  return [`Table of contents of ${value.document.title}`, ...lines, ...(value.note === undefined ? [] : ["", value.note])].join(
    "\n",
  );
}

/**
 * Render the document list for the model.
 * @param value - the canonical value.
 * @returns the text block body.
 */
function renderList(value) {
  if (value.documents.length === 0) return value.note ?? "No PDF has been read in this session.";
  const lines = value.documents.map(
    (entry) => `${entry.docId} — ${entry.title}, ${entry.pageCount} pages (${entry.indexedPages} searchable)`,
  );
  return ["PDFs read in this session:", ...lines].join("\n");
}
