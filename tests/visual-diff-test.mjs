/**
 * Proves tests/visual-diff.mjs actually measures what it claims.
 *
 *   node tests/visual-diff-test.mjs
 *
 * Every image here is built in memory with `encodePng` and written to a temp
 * directory only where the command line has to read a file, so there are no
 * fixtures to keep in sync and nothing to fetch.
 *
 * Two things are checked on purpose at both levels: the functions, because that
 * is what other scripts import, and the real `node tests/visual-diff.mjs` child
 * process, because the exit codes are the contract a runner depends on and a
 * function that returns 2 proves nothing about a process that exits 0.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { decodePng, diffImages, encodePng, renderDiffPng, runVisualDiff } from "./visual-diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "visual-diff.mjs");
const WORK = mkdtempSync(join(tmpdir(), "visual-diff-test-"));
const failures = [];

/**
 * Run one named check, recording a failure instead of aborting the suite —
 * the phrasing matches client-smoke.mjs, so a runner greps all suites alike.
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

/**
 * Build a decoded image the way `decodePng` returns one.
 * @param width - pixels across.
 * @param height - rows.
 * @param channels - 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA).
 * @param paint - `(x, y) => [r, g, b, a]`; only the first `channels` are used.
 * @returns `{ width, height, channels, data }`.
 */
function makeImage(width, height, channels, paint) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const colour = paint(x, y);
      const at = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) data[at + channel] = colour[channel];
    }
  }
  return { width, height, channels, data };
}

/**
 * @param image - decoded image.
 * @param x - column.
 * @param y - row.
 * @param colour - channel values.
 */
function setPixel(image, x, y, colour) {
  const at = (y * image.width + x) * image.channels;
  for (let channel = 0; channel < image.channels; channel += 1) image.data[at + channel] = colour[channel];
}

/**
 * @param image - decoded image.
 * @param x - column.
 * @param y - row.
 * @returns its channel values.
 */
function getPixel(image, x, y) {
  const at = (y * image.width + x) * image.channels;
  return Array.from(image.data.subarray(at, at + image.channels));
}

/**
 * @param image - decoded image.
 * @returns a deep copy, so a candidate can be derived from a baseline.
 */
function cloneImage(image) {
  return { ...image, data: Uint8Array.from(image.data) };
}

/**
 * Write an image as a PNG and hand back its path, which is what the child
 * process needs.
 * @param name - file name inside the temp directory.
 * @param image - decoded image.
 * @returns the absolute path.
 */
function savePng(name, image) {
  const path = join(WORK, name);
  writeFileSync(path, encodePng(image));
  return path;
}

/**
 * Run the real command line, exactly as a PowerShell test would.
 * @param args - CLI arguments.
 * @returns exit status plus captured streams.
 */
function runCliProcess(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Read one `key=value` fact out of the CLI's plain output.
 * @param stdout - captured stdout.
 * @param key - the fact's name.
 * @returns its value.
 */
function field(stdout, key) {
  const match = new RegExp(`^${key}=(.*)$`, "mu").exec(stdout);
  assert.ok(match !== null, `the output has no ${key}= line:\n${stdout}`);
  return match[1].trim();
}

/**
 * The command line as a function, with capture streams, so a check can assert
 * on the lines a runner will grep without a second process.
 * @param args - CLI arguments.
 * @returns exit code, stdout lines and stderr lines.
 */
function runCliInProcess(...args) {
  const out = [];
  const err = [];
  const io = {
    stdout: { write: (text) => out.push(String(text).replace(/\n$/u, "")) },
    stderr: { write: (text) => err.push(String(text).replace(/\n$/u, "")) },
  };
  const { code, report } = runVisualDiff(args, io);
  return { code, report, lines: out, errors: err };
}

// --- the test's own PNG writer ------------------------------------------------
// Needed for the one thing `encodePng` will not produce: scanlines that use
// filters 1..4, which is what every real screenshot from Chromium does. The
// forward filters are written out independently of the decoder on purpose — a
// shared implementation would agree with itself while both were wrong.

const TEST_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let remainder = index;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder & 1) === 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[index] = remainder >>> 0;
  }
  return table;
})();

/** @param bytes - chunk type plus data. @returns its CRC32. */
function testCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TEST_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param type - chunk name. @param data - payload. @returns the chunk bytes. */
function testChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(testCrc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, trailer]);
}

/** @param left - predictor inputs, as in the PNG specification. */
function testPaeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}

/**
 * Forward-filter an image, one filter type per row.
 * @param image - the pixels that must come back out of the decoder.
 * @param filterForRow - `(y) => 0..4`.
 * @returns one filter byte plus one row of residuals per scanline.
 */
function filterRows(image, filterForRow) {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filterType = filterForRow(y);
    out[y * (stride + 1)] = filterType;
    for (let x = 0; x < stride; x += 1) {
      const value = data[y * stride + x];
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = (left + up) >> 1;
      else if (filterType === 4) predictor = testPaeth(left, up, upLeft);
      out[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
    }
  }
  return out;
}

/**
 * Assemble a PNG from parts, including the variants the decoder must refuse.
 * @param spec - header fields and the already-filtered image data.
 * @returns the file bytes.
 */
function assemblePng({ width = 1, height = 1, bitDepth = 8, colourType = 2, compression = 0, interlace = 0, palette = false, rows = Buffer.alloc(height * (width * 3 + 1)), idat = null, iend = true }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colourType;
  header[10] = compression;
  header[11] = 0;
  header[12] = interlace;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), testChunk("IHDR", header)];
  if (palette) parts.push(testChunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])));
  if (idat !== null) parts.push(testChunk("IDAT", idat));
  else if (rows !== null) parts.push(testChunk("IDAT", deflateSync(rows)));
  if (iend) parts.push(testChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

console.log("visual-diff: decoding");

await check("a PNG survives encode/decode for every supported colour type", () => {
  const shapes = [
    // All-zero rows exercise the "every predictor is 0" path and the shortest
    // possible IDs; all-255 rows the byte wraparound in the residuals.
    ["zeros", () => [0, 0, 0, 0]],
    ["white", () => [255, 255, 255, 255]],
    ["diagonal", (x, y) => [(x * 8) & 0xff, (y * 8) & 0xff, ((x + y) * 4) & 0xff, 255]],
  ];
  // channels -> the colour type the header must carry: 6 RGBA and 2 RGB are the
  // two the encoder is used for, 0 and 4 cover the greys for free.
  const layouts = [[4, 6], [3, 2], [1, 0], [2, 4]];
  for (const [label, paint] of shapes) {
    for (const [channels, colourType] of layouts) {
      const image = makeImage(17, 9, channels, paint);
      const encoded = encodePng(image);
      const decoded = decodePng(encoded);
      assert.equal(decoded.width, image.width, `${label}/${channels}: width`);
      assert.equal(decoded.height, image.height, `${label}/${channels}: height`);
      assert.equal(decoded.channels, channels, `${label}/${channels}: channels`);
      assert.equal(decoded.colourType, colourType, `${label}/${channels}: colour type from the header`);
      assert.deepEqual(
        Buffer.from(decoded.data),
        Buffer.from(image.data),
        `${label}/${channels}: the pixels came back changed`,
      );
    }
  }
});

await check("the decoder undoes all five scanline filters", () => {
  // A stride wider than one pixel, so Sub/Average/Paeth have to reach back the
  // right number of bytes rather than one pixel's worth.
  const wide = makeImage(7, 5, 3, (x, y) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 61) & 0xff, (x * 19 + y * 7) & 0xff]);
  const allFilters = decodePng(assemblePng({ width: wide.width, height: wide.height, colourType: 2, rows: filterRows(wide, (y) => y) }));
  assert.deepEqual(Buffer.from(allFilters.data), Buffer.from(wide.data), "rows filtered 0,1,2,3,4 did not come back");

  // A one-pixel-wide image is the edge case where the byte to the left does not
  // exist on any row: the predictors must fall back to 0, not to the previous row.
  const narrow = makeImage(1, 3, 2, (x, y) => [(y * 91 + 17) & 0xff, (y * 40 + 200) & 0xff]);
  const narrowDecoded = decodePng(assemblePng({ width: 1, height: 3, colourType: 4, rows: filterRows(narrow, (y) => [2, 3, 4][y]) }));
  assert.deepEqual(Buffer.from(narrowDecoded.data), Buffer.from(narrow.data), "a one-pixel-wide image lost its filters");
});

await check("truncated and corrupt files throw instead of returning garbage", () => {
  const image = makeImage(32, 16, 4, (x, y) => [(x * 7) & 0xff, (y * 15) & 0xff, 128, 255]);
  const valid = encodePng(image);

  const cut = Buffer.from(valid.subarray(0, Math.floor(valid.length / 2)));
  assert.throws(() => decodePng(cut), /truncated|corrupt/u, "a file cut in half must be refused");

  // The IDAT payload starts at 8 (signature) + 25 (IHDR chunk). Flipping a byte
  // there leaves the length intact but breaks the CRC — the classic "the copy
  // through the network was fine, the disk was not" case.
  const bitRot = Buffer.from(valid);
  bitRot[41] ^= 0xff;
  assert.throws(() => decodePng(bitRot), /CRC/u, "a corrupted IDAT byte must be reported, not decoded");

  assert.throws(() => decodePng(Buffer.from('<?xml version="1.0"?><svg/>')), /signature/u, "a non-PNG must be named as one");
  assert.throws(() => decodePng(Buffer.alloc(0)), /signature/u, "an empty file must be named as one");
  assert.throws(() => decodePng(assemblePng({ width: 4, height: 4, idat: Buffer.from([9, 9, 9, 9, 9]) })), /inflate/u, "an intact CRC over nonsense data must still be refused");
  assert.throws(() => decodePng(assemblePng({ width: 4, height: 4, idat: null, rows: null })), /no IDAT/u, "a header with no pixels must be refused");
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 1, rows: filterRows(makeImage(2, 1, 3, () => [1, 2, 3]), () => 0), iend: false })), /no IEND/u, "a file that stops before IEND must be refused");

  // Every one of those has to be an Error with words in it: a thrown string or a
  // silently short buffer would leave the caller guessing.
  for (const bad of [cut, bitRot]) {
    try {
      decodePng(bad);
      assert.fail("decodePng returned for a corrupt file");
    } catch (error) {
      assert.ok(error instanceof Error, "the failure must be an Error");
      assert.ok(error.message.length > 20, `the message is too thin: ${error.message}`);
    }
  }
});

await check("unsupported PNG variants are refused by name", () => {
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, bitDepth: 16 })), /bit depth 16/u);
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, interlace: 1 })), /interlaced/u);
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, colourType: 3 })), /colour type 3|paletted/u);
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, colourType: 3, palette: true })), /PLTE|paletted/u, "a palette must be named rather than ignored");
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, colourType: 5 })), /colour type 5/u);
  assert.throws(() => decodePng(assemblePng({ width: 2, height: 2, compression: 1 })), /compression method/u);
});

console.log("visual-diff: comparing");

await check("an image is the same as itself", () => {
  const image = makeImage(40, 30, 4, (x, y) => [(x * 6) & 0xff, (y * 8) & 0xff, 200, 255]);
  const report = diffImages(image, image);
  assert.equal(report.sizeMatch, true);
  assert.equal(report.diffPixels, 0);
  assert.equal(report.diffRatio, 0);
  assert.equal(report.worstDelta, 0);
  assert.equal(report.verdict, "same");

  // The same claim, through the command line's own code path and then through a
  // real child process: both must say 0.
  const path = savePng("same.png", image);
  const inProcess = runCliInProcess(path, path);
  assert.equal(inProcess.code, 0, "the CLI helper must exit 0 for identical images");
  assert.ok(inProcess.lines.includes("verdict=same"), inProcess.lines.join(" | "));
  assert.ok(inProcess.lines.includes("diffPixels=0"), inProcess.lines.join(" | "));
  assert.ok(inProcess.lines.includes("size=40x30"), inProcess.lines.join(" | "));

  const child = runCliProcess(path, path);
  assert.equal(child.status, 0, `a real run must exit 0, got ${child.status}: ${child.stderr}`);
  assert.equal(field(child.stdout, "verdict"), "same");
  assert.equal(field(child.stdout, "diffPixels"), "0");
  assert.equal(field(child.stdout, "size"), "40x30");
  assert.equal(child.stderr, "", "a clean comparison must not write to stderr");
});

await check("a grey PNG compares equal to the same picture as RGBA", () => {
  // Different colour types are not a difference in the picture: an opaque grey
  // image and an RGBA one with the same values are the same pixels.
  const grey = makeImage(8, 8, 1, (x, y) => [(x * 20 + y * 3) & 0xff]);
  const rgba = makeImage(8, 8, 4, (x, y) => [(x * 20 + y * 3) & 0xff, (x * 20 + y * 3) & 0xff, (x * 20 + y * 3) & 0xff, 255]);
  const report = diffImages(decodePng(encodePng(grey)), decodePng(encodePng(rgba)));
  assert.equal(report.diffPixels, 0, "grey and its RGB expansion must compare equal");
  assert.equal(report.verdict, "same");
});

await check("one changed pixel is exactly one differing pixel, and the diff image marks it red", () => {
  // A gradient, so a highlight drawn at the wrong x lands on different values
  // rather than on a flat field where everything would compare equal.
  const gradient = () => {
    const image = makeImage(64, 64, 4, (x, y) => [x * 4, y * 4, 128, 255]);
    // Two neutral patches whose quarter-brightness is exact on any luma formula:
    // 255 * 0.25 = 64 and 100 * 0.25 = 25.
    setPixel(image, 0, 0, [255, 255, 255, 255]);
    setPixel(image, 1, 0, [100, 100, 100, 255]);
    return image;
  };
  const baseline = gradient();
  const candidate = cloneImage(baseline);
  setPixel(candidate, 7, 9, [255, 255, 255, 255]);

  const report = diffImages(baseline, candidate);
  assert.equal(report.diffPixels, 1, "exactly the one touched pixel differs");
  assert.equal(report.diffRatio, 1 / (64 * 64));
  // One pixel out of 4096 is 0.02%, inside the default 0.2% budget — that is
  // what the default is for (a blinking caret, one antialiased edge), and the
  // next check is where the strict setting bites.
  assert.equal(report.verdict, "same", "a single pixel in a large image stays inside the default budget");
  assert.equal(report.worstX, 7, "the report must say where: column");
  assert.equal(report.worstY, 9, "the report must say where: row");
  assert.equal(report.worstChannel, "R");
  assert.equal(report.worstDelta, 227, "baseline red 28 -> candidate red 255");
  assert.equal(report.mask.filter((flag) => flag === 1).length, 1);

  const baselinePath = savePng("one-change-baseline.png", baseline);
  const candidatePath = savePng("one-change-candidate.png", candidate);
  const diffPath = join(WORK, "one-change-diff.png");
  const child = runCliProcess(baselinePath, candidatePath, "--write-diff", diffPath);
  assert.equal(child.status, 0, `one pixel in 4096 is inside the default ratio, got ${child.status}: ${child.stderr}`);
  assert.equal(field(child.stdout, "diffPixels"), "1", "the count is never rounded down to zero");
  assert.equal(field(child.stdout, "verdict"), "same", "the verdict, not the count, follows the ratio");
  assert.equal(field(child.stdout, "worstAt"), "7,9");
  // The artifact is written whatever the verdict: it is how a human looks at a
  // picture that is technically inside tolerance but visibly wrong.
  assert.equal(field(child.stdout, "diffImage"), diffPath, "the path a human needs must be reported");

  // What a human opens: the candidate dimmed to grey with the change in red.
  const painted = decodePng(readFileSync(diffPath));
  assert.equal(painted.width, candidate.width, "the diff image is the candidate's size");
  assert.equal(painted.height, candidate.height);
  assert.equal(painted.channels, 4);

  const redPixels = [];
  const greyPixels = [];
  for (let y = 0; y < painted.height; y += 1) {
    for (let x = 0; x < painted.width; x += 1) {
      const [r, g, b, a] = getPixel(painted, x, y);
      assert.equal(a, 255, `the diff image must be opaque at ${x},${y}`);
      if (r === 255 && g === 0 && b === 0) redPixels.push(`${x},${y}`);
      else greyPixels.push([x, y, r, g, b]);
    }
  }
  assert.deepEqual(redPixels, ["7,9"], "exactly the changed pixel is painted red");
  assert.equal(greyPixels.length, 64 * 64 - 1, "everything else is backdrop");
  for (const [x, y, r, g, b] of greyPixels) {
    assert.ok(r === g && g === b, `the backdrop at ${x},${y} is not grey (${r},${g},${b})`);
    assert.ok(r <= 64, `the backdrop at ${x},${y} is not dimmed (${r})`);
  }
  assert.deepEqual(getPixel(painted, 0, 0).slice(0, 3), [64, 64, 64], "white dims to 255 * 0.25");
  assert.deepEqual(getPixel(painted, 1, 0).slice(0, 3), [25, 25, 25], "grey 100 dims to 25");

  // `renderDiffPng` is exported for scripts that already have the two decodes.
  const direct = decodePng(renderDiffPng(candidate, report));
  assert.deepEqual(Buffer.from(direct.data), Buffer.from(painted.data), "the exported renderer and the CLI agree");
});

await check("--ratio 0 refuses a single stray pixel", () => {
  const baseline = makeImage(64, 64, 4, (x, y) => [x * 4, y * 4, 128, 255]);
  const candidate = cloneImage(baseline);
  setPixel(candidate, 7, 9, [0, 0, 0, 255]);
  const baselinePath = savePng("ratio-baseline.png", baseline);
  const candidatePath = savePng("ratio-candidate.png", candidate);

  const child = runCliProcess(baselinePath, candidatePath, "--ratio", "0");
  assert.equal(child.status, 2, `--ratio 0 must refuse even one pixel, got ${child.status}`);
  assert.equal(field(child.stdout, "verdict"), "differs");
  assert.equal(field(child.stdout, "diffPixels"), "1");
  assert.equal(field(child.stdout, "ratio"), "0");

  // `--ratio=1` is the documented way to ask "just tell me how bad it is": the
  // verdict flips to same while the count still reports the truth.
  const lenient = runCliProcess(baselinePath, candidatePath, "--ratio=1");
  assert.equal(lenient.status, 0, "a ratio of 1 accepts anything");
  assert.equal(field(lenient.stdout, "diffPixels"), "1", "the count is not rounded away by a loose ratio");

  // A change below tolerance is not a change; above it is. Same pair, two knobs.
  const quietChange = cloneImage(baseline);
  setPixel(quietChange, 3, 3, [baseline.data[(3 * 64 + 3) * 4] + 5, baseline.data[(3 * 64 + 3) * 4 + 1], baseline.data[(3 * 64 + 3) * 4 + 2], 255]);
  const quietPath = savePng("tolerance-candidate.png", quietChange);
  assert.equal(field(runCliProcess(baselinePath, quietPath).stdout, "diffPixels"), "0", "a 5-step change is inside the default tolerance of 8");
  // Strict on both knobs: delta 5 clears a tolerance of 0, and one changed pixel
  // clears a ratio of 0.
  assert.equal(
    runCliProcess(baselinePath, quietPath, "--tolerance", "0", "--ratio", "0").status,
    2,
    "and outside a tolerance of 0 with a ratio of 0",
  );
});

await check("different sizes are a hard failure", () => {
  const tall = savePng("size-baseline.png", makeImage(64, 64, 4, (x, y) => [x * 3, y * 3, 60, 255]));
  const wide = savePng("size-candidate.png", makeImage(48, 64, 4, (x, y) => [x * 3, y * 3, 60, 255]));

  const report = diffImages(decodePng(readFileSync(tall)), decodePng(readFileSync(wide)));
  assert.equal(report.sizeMatch, false);
  assert.equal(report.verdict, "differs");
  assert.equal(report.width, 64);
  assert.equal(report.candidateWidth, 48);
  assert.equal(report.mask, null, "there is no pixel mask to offer across sizes");
  assert.throws(() => renderDiffPng(decodePng(readFileSync(wide)), report), /mask/u, "a diff image across sizes would be a lie");

  const child = runCliProcess(tall, wide, "--write-diff", join(WORK, "size-diff.png"));
  assert.equal(child.status, 2, "a size change must be a failure, got a success");
  assert.equal(field(child.stdout, "sizeMatch"), "false");
  assert.equal(field(child.stdout, "size"), "64x64", "the baseline size is still reported");
  assert.equal(field(child.stdout, "candidateSize"), "48x64", "and the candidate's, so the pair is visible");
  assert.match(child.stderr, /64x64/u, "the human-readable note names the baseline size");
  assert.match(child.stderr, /48x64/u, "and the candidate's");
  assert.equal(field(child.stdout, "worstDelta"), "na", "no delta exists across sizes, and it must not be invented");
  assert.ok(!child.stdout.includes("diffImage="), "no diff image is claimed when none was written");
});

await check("a broken call exits 1, never 2, so 'broken' cannot read as 'moved'", () => {
  const good = savePng("good.png", makeImage(4, 4, 4, () => [1, 2, 3, 255]));
  const notPng = join(WORK, "not-a-png.png");
  writeFileSync(notPng, Buffer.from("this is not a png"));
  const corrupt = join(WORK, "corrupt.png");
  const valid = Buffer.from(readFileSync(good));
  const half = Buffer.from(valid.subarray(0, Math.floor(valid.length / 2)));
  writeFileSync(corrupt, half);

  const cases = [
    [["only-one-path.png"], /two images/u],
    [[good, good, "a-third.png"], /two images/u],
    [[good, good, "--ratio", "banana"], /non-negative number/u],
    [[good, good, "--nope"], /unknown option/u],
    [[good], /two images/u],
    [[join(WORK, "missing.png"), good], /cannot read the baseline/u],
    [[notPng, good], /cannot decode the baseline/u],
    [[good, corrupt], /cannot decode the candidate/u],
  ];
  for (const [args, pattern] of cases) {
    const child = runCliProcess(...args);
    assert.equal(child.status, 1, `${args.join(" ")} must exit 1, got ${child.status}`);
    assert.match(child.stderr, pattern, `${args.join(" ")}: ${child.stderr}`);
    assert.equal(child.stdout, "", `${args.join(" ")} must not print facts it never measured`);
  }

  // Usage errors are the caller's bug and come with the usage line.
  assert.match(runCliProcess(good, good, "--nope").stderr, /usage: node tests\/visual-diff\.mjs/u);
});

await check("--quiet keeps the facts and drops the prose", () => {
  const base = savePng("quiet-base.png", makeImage(6, 6, 3, (x, y) => [x * 10, y * 10, 9]));
  const inProcess = runCliInProcess(base, base, "--quiet");
  assert.equal(inProcess.code, 0);
  assert.deepEqual(inProcess.lines, [
    "size=6x6",
    "sizeMatch=true",
    "diffPixels=0",
    "diffRatio=0.000000",
    "worstDelta=0",
    "worstChannel=R",
    "worstAt=0,0",
    "tolerance=8",
    "ratio=0.002",
    "verdict=same",
  ], inProcess.lines.join(" | "));

  const loud = runCliProcess(base, base);
  assert.equal(field(loud.stdout, "baseline"), base, "the loud run names both files");
  assert.equal(loud.status, 0);
  // One fact per line, no emoji, nothing a `ForEach-Object` has to strip.
  for (const line of loud.stdout.split("\n").filter((line) => line !== "")) {
    assert.match(line, /^[a-zA-Z]+=\S*$/u, `not a plain key=value line: ${line}`);
  }
});

rmSync(WORK, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
