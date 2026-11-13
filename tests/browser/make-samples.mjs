/**
 * Build the PDFs the browser harness opens, so the test corpus is reproducible
 * and carries no third-party document.
 *
 * Three shapes are needed: something small that most scenarios open, something
 * with an outline and searchable text on every page, and something long enough
 * that eager rendering would show up. The encrypted sample cannot be generated
 * by hand (AES plus the standard security handler), so `samples/pw-aes.pdf` is a
 * checked-in 2.5 KB fixture.
 *
 * Written against raw PDF syntax on purpose: no dependency, and the output is
 * byte-for-byte identical every run.
 *
 *   node tests/browser/make-samples.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./samples/", import.meta.url));
mkdirSync(OUT, { recursive: true });

/** Body text reused across samples, long enough to fill several lines. */
const LOREM = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod",
  "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam,",
  "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.",
];

/** Escape a string for a PDF literal. */
function literal(text) {
  return `(${text.replace(/[\\()]/gu, (match) => `\\${match}`)})`;
}

/**
 * Assemble numbered objects into a complete PDF file.
 * @param objects - `[number, body]` pairs; `body` sits between `obj` and `endobj`.
 * @param root - object number of the catalog.
 * @returns the file as a Buffer.
 */
function build(objects, root = 1) {
  const ordered = [...objects].sort((left, right) => left[0] - right[0]);
  const head = Buffer.from("%PDF-1.4\n", "latin1");
  const chunks = [head];
  const offsets = new Map();
  let at = head.length;
  for (const [number, body] of ordered) {
    offsets.set(number, at);
    const chunk = Buffer.from(`${String(number)} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(chunk);
    at += chunk.length;
  }
  const highest = ordered.at(-1)[0];
  const tail = [`xref\n0 ${String(highest + 1)}\n`, "0000000000 65535 f \n"];
  for (let number = 1; number <= highest; number += 1) {
    tail.push(`${String(offsets.get(number) ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  tail.push(`trailer\n<< /Size ${String(highest + 1)} /Root ${String(root)} 0 R >>\nstartxref\n${String(at)}\n%%EOF\n`);
  chunks.push(Buffer.from(tail.join(""), "latin1"));
  return Buffer.concat(chunks);
}

/**
 * One page and its content stream, as two objects.
 * @param objects - collector.
 * @param number - page object number; the stream takes `number + 1`.
 * @param lines - positioned text lines.
 * @param font - font object number.
 * @param pad - bytes of comment padding to add, for the oversized sample.
 * @returns the page's object reference, e.g. `3 0 R`.
 */
function addPage(objects, number, lines, font, pad = 0) {
  const text = lines
    .map(({ text, size = 11, x = 64, y }) => `BT /F1 ${String(size)} Tf ${String(x)} ${String(y)} Td ${literal(text)} Tj ET`)
    .join("\n");
  // A comment line is legal inside a content stream and costs the parser a scan
  // to end-of-line, so it inflates the file without adding anything to draw.
  const stream = pad === 0 ? text : `${text}\n%${"x".repeat(pad)}`;
  objects.push([
    number,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(number + 1)} 0 R >>`,
  ]);
  objects.push([number + 1, `<< /Length ${String(Buffer.byteLength(stream, "latin1"))} >>\nstream\n${stream}\nendstream`]);
  return `${String(number)} 0 R`;
}

/**
 * Build the long document: `pages` numbered pages of text, no outline.
 * @param pages - how many pages.
 */
function longDocument(pages) {
  const objects = [];
  const font = 3 + pages * 2;
  const kids = [];
  for (let index = 0; index < pages; index += 1) {
    kids.push(
      addPage(
        objects,
        3 + index * 2,
        [
          { text: `Page ${String(index + 1)} of ${String(pages)}`, size: 24, y: 742 },
          ...LOREM.map((text, line) => ({ text, y: 700 - line * 18 })),
        ],
        font,
      ),
    );
  }
  objects.push([font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages)} >>`]);
  return build(objects);
}

/**
 * Build the navigable document: a cover plus body pages, and a two-level
 * outline whose destinations land on real pages.
 */
function outlineDocument() {
  const chapters = [
    { title: "Chapter 1. Installation", sections: ["1.1 Requirements", "1.2 Package layout", "1.3 First run"] },
    { title: "Chapter 2. Configuration", sections: ["2.1 Environment", "2.2 Credentials", "2.3 Limits"] },
    { title: "Chapter 3. Troubleshooting", sections: ["3.1 Logs", "3.2 Diagnostics", "3.3 Support"] },
  ];
  const pages = 12;
  const objects = [];
  const font = 3 + pages * 2; // sits after the page/stream pairs
  const outlineRoot = font + 1;
  const kids = [];
  const refs = [];
  for (let index = 0; index < pages; index += 1) {
    const ref = addPage(
      objects,
      3 + index * 2,
      [
        { text: index === 0 ? "Cover" : `Page ${String(index + 1)}`, size: 24, y: 742 },
        { text: "Revision History: Consensus Detector Diagnostic", size: 13, y: 706 },
        ...LOREM.map((text, line) => ({ text, y: 660 - line * 16 })),
        { text: "This page carries body text so search and selection have targets.", size: 10, y: 556 },
        { text: "Page reference: the word Page appears here on purpose.", size: 10, y: 538 },
      ],
      font,
    );
    kids.push(ref);
    refs.push(ref);
  }
  objects.push([font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  objects.push([1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${String(outlineRoot)} 0 R >>`]);
  objects.push([2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages)} >>`]);

  // Layout: chapters first, each followed by its sections, so `/First` and
  // `/Last` for a chapter are adjacent numbers.
  const totalItems = chapters.reduce((sum, chapter) => sum + 1 + chapter.sections.length, 0);
  const firstItem = outlineRoot + 1;
  const chapterStart = [];
  let cursor = firstItem;
  for (const chapter of chapters) {
    chapterStart.push(cursor);
    cursor += 1 + chapter.sections.length;
  }
  let previousChapter;
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const self = chapterStart[chapterIndex];
    const firstSection = self + 1;
    const lastSection = self + chapter.sections.length;
    const parent = ` /Parent ${String(outlineRoot)} 0 R`;
    const prev = previousChapter === undefined ? "" : ` /Prev ${String(previousChapter)} 0 R`;
    const next = chapterIndex + 1 < chapters.length ? ` /Next ${String(chapterStart[chapterIndex + 1])} 0 R` : "";
    const target = refs[Math.min(chapterIndex * 3, pages - 1)];
    objects.push([
      self,
      `<< /Title ${literal(chapter.title)} /Dest [${target} /Fit]${parent}${prev}${next} `
        + `/First ${String(firstSection)} 0 R /Last ${String(lastSection)} 0 R `
        + `/Count ${String(chapter.sections.length)} >>`,
    ]);
    for (const [sectionIndex, section] of chapter.sections.entries()) {
      const number = firstSection + sectionIndex;
      const landing = refs[Math.min(chapterIndex * 3 + sectionIndex + 1, pages - 1)];
      const sectionPrev = sectionIndex === 0 ? "" : ` /Prev ${String(number - 1)} 0 R`;
      const sectionNext = sectionIndex + 1 === chapter.sections.length ? "" : ` /Next ${String(number + 1)} 0 R`;
      objects.push([
        number,
        `<< /Title ${literal(section)} /Parent ${String(self)} 0 R${sectionPrev}${sectionNext} /Dest [${landing} /Fit] >>`,
      ]);
    }
    previousChapter = self;
  }
  objects.push([
    outlineRoot,
    `<< /Type /Outlines /First ${String(chapterStart[0])} 0 R /Last ${String(chapterStart.at(-1))} 0 R `
      + `/Count ${String(totalItems)} >>`,
  ]);
  return build(objects);
}

/**
 * Build a document above the Host's 32 MiB whole-file cap.
 *
 * That cap is what `loading: "bytes-complete"` runs into and what
 * `loading: "renderer"` exists to avoid: the body reads this file in 2 MiB
 * windows, so the sample has to be big enough to need several.
 * @param target - approximate file size in bytes.
 */
function hugeDocument(target) {
  const pages = 40;
  const pad = Math.ceil(target / pages);
  const objects = [];
  const font = 3 + pages * 2;
  const kids = [];
  for (let index = 0; index < pages; index += 1) {
    kids.push(
      addPage(
        objects,
        3 + index * 2,
        [
          { text: `Page ${String(index + 1)} of ${String(pages)}`, size: 24, y: 742 },
          { text: "Oversized sample: reading this one needs window reads.", size: 11, y: 700 },
        ],
        font,
        pad,
      ),
    );
  }
  objects.push([font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages)} >>`]);
  return build(objects);
}

/**
 * Build the small document most scenarios open.
 */
function plainDocument() {
  const pages = 4;
  const objects = [];
  const font = 3 + pages * 2;
  const kids = [];
  for (let index = 0; index < pages; index += 1) {
    kids.push(
      addPage(
        objects,
        3 + index * 2,
        [
          { text: `Page ${String(index + 1)} of ${String(pages)}`, size: 24, y: 742 },
          ...LOREM.map((text, line) => ({ text, y: 700 - line * 18 })),
        ],
        font,
      ),
    );
  }
  objects.push([font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  objects.push([1, "<< /Type /Catalog /Pages 2 0 R >>"]);
  objects.push([2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages)} >>`]);
  return build(objects);
}

for (const [name, bytes] of [
  ["plain.pdf", plainDocument()],
  ["outline.pdf", outlineDocument()],
  ["big.pdf", longDocument(200)],
  ["huge.pdf", hugeDocument(34 * 1024 * 1024)],
  // Not a document at all, under a name that claims to be one: the pane has to
  // say so and offer a retry rather than keep a blank page.
  ["notpdf.pdf", Buffer.from("this file is not a PDF\n", "latin1")],
]) {
  writeFileSync(join(OUT, name), bytes);
  console.log(`${name}: ${String(bytes.length)} bytes`);
}
console.log("samples written to", OUT);
