import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Exercise the actual method without importing the browser-only pdf.js modules.
const source = readFileSync(new URL('../public/viewer.mjs', import.meta.url), 'utf8');
const body = source.match(/  pageIndexAtOffset\(offset\) \{([\s\S]*?)\n  \}/)?.[1];
assert.ok(body, 'the viewer exposes its internal ordered-page lookup');
const lookup = new Function('offset', body);
let reads = 0;
const pageEls = Array.from({ length: 779 }, (_, i) => ({ get offsetTop() { reads++; return 16 + i * 800; } }));
for (const offset of [-100, 16, 815, 816, 10000, 400000, 999999]) {
  reads = 0;
  const actual = lookup.call({ pageEls }, offset);
  assert.equal(actual, Math.min(778, Math.max(0, Math.floor((offset - 16) / 800))));
  assert.ok(reads <= 10, `779-page lookup used ${reads} layout reads`);
}
assert.equal(lookup.call({ pageEls: [] }, 0), 0);
assert.match(source, /pageIndexAtOffset\(probe\)/);
assert.match(source, /pageIndexAtOffset\(top\)/);
console.log('scroll lookup: page boundaries correct; at most 10 layout reads for 779 pages');
