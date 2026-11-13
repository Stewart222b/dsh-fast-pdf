/**
 * Pixel-level comparison for the browser harness's screenshots.
 *
 * The browser tests save `tests/browser/shot-*.png`; this turns "did the pane
 * move?" into an exit code, so a highlight drawn one pixel off, a corner that
 * lost its radius or a toolbar row that reflowed fails the suite instead of
 * waiting for someone to eyeball it.
 *
 *   node tests/visual-diff.mjs <baseline.png> <candidate.png> [options]
 *
 * Zero npm packages on purpose: the plugin has no `package.json` of its own and
 * has to keep running on a bare Node, so PNG decoding is `node:zlib` plus the
 * five scanline filters written out below.
 *
 * Exit codes are the contract, and the reason they are three numbers instead of
 * two: a test runner has to tell "the pane moved" from "the tool broke", and a
 * tool that cannot decode a candidate must never look like a regression.
 *
 *   0  same within tolerance
 *   2  regression (pixels differ past `--ratio`, or the sizes do not match)
 *   1  usage, read, or decode error — nothing was compared
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Colour type -> channels per pixel, for the four types whose channels are
 * plain bytes. Type 3 (palette) is deliberately absent: its IDAT holds indexes
 * into PLTE, so decoding it as colours would produce a confident, wrong image.
 */
const CHANNELS_BY_COLOUR_TYPE = new Map([
  [0, 1], // grey
  [2, 3], // RGB
  [4, 2], // grey + alpha
  [6, 4], // RGBA
]);

/** The inverse table, for the encoder: channels -> colour type. */
const COLOUR_TYPE_BY_CHANNELS = new Map([
  [1, 0],
  [2, 4],
  [3, 2],
  [4, 6],
]);

/** Channel names, in the order the comparison walks them. */
const CHANNEL_NAMES = ["R", "G", "B", "A"];

/**
 * CRC32 (ISO-HDLC, the one PNG uses) for the chunk trailers the encoder writes
 * and the decoder refuses to trust without. Built once, table-driven: per-byte
 * bit-twiddling over a megabyte of IDAT would be visibly slow.
 */
const CRC_TABLE = (() => {
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

/**
 * @param bytes - chunk type plus data, as PNG computes it.
 * @returns the CRC32 as an unsigned 32-bit number.
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Read one IHDR payload.
 * @param data - the 13 IHDR bytes.
 * @returns width, height and the pixel layout, after every rejection this tool
 *   refuses to guess about.
 */
function readHeader(data) {
  if (data.length < 13) {
    throw new Error(`corrupt PNG: IHDR is ${data.length} bytes, expected 13`);
  }
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colourType = data[9];
  const compression = data[10];
  const filterMethod = data[11];
  const interlace = data[12];

  if (width === 0 || height === 0) {
    throw new Error(`corrupt PNG: IHDR declares a ${width}x${height} image, and a PNG cannot have a zero side`);
  }
  if (compression !== 0) {
    throw new Error(`unsupported PNG compression method ${compression}: PNG defines only deflate (0)`);
  }
  if (filterMethod !== 0) {
    throw new Error(`unsupported PNG filter method ${filterMethod}: PNG defines only 0`);
  }
  // Adam7 splits the image into seven passes with their own geometry. Nothing in
  // this repo produces one, and half-decoding it would silently shift every
  // pixel — so it is refused rather than approximated.
  if (interlace === 1) {
    throw new Error("interlaced (Adam7) PNG is not supported: re-encode the screenshot without interlacing");
  }
  if (interlace !== 0) {
    throw new Error(`unsupported PNG interlace method ${interlace}`);
  }
  const channels = CHANNELS_BY_COLOUR_TYPE.get(colourType);
  if (channels === undefined) {
    if (colourType === 3) {
      throw new Error("paletted PNG (colour type 3) is not supported: its pixels are palette indexes; re-encode as RGB or RGBA");
    }
    throw new Error(
      `unsupported PNG colour type ${colourType}: only 0 (grey), 2 (RGB), 4 (grey+alpha) and 6 (RGBA) are handled`,
    );
  }
  // 1/2/4-bit grey and 16-bit channels mean unpacking bits and rescaling before
  // any of this; that is a different bug surface than the filter math, and no
  // screenshot here needs it.
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}: only 8-bit channels are supported`);
  }
  return { width, height, bitDepth, colourType, channels };
}

/**
 * The Paeth predictor, which PNG shares with the TIFF predictor: pick whichever
 * of left/up/upper-left the linear estimate lands closest to.
 * @param left - byte to the left, 0 at the row start.
 * @param up - byte above, 0 on the first row.
 * @param upLeft - byte above-left, 0 at the row start or first row.
 * @returns the predicted byte.
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

/**
 * Undo the per-scanline filters in place into a packed pixel buffer.
 * @param raw - inflated IDAT: one filter byte plus `stride` bytes per row.
 * @param out - destination for the unfiltered pixels.
 * @param width - image width in pixels.
 * @param height - image height in rows.
 * @param channels - bytes per pixel (bit depth is known to be 8 here).
 */
function unfilter(raw, out, width, height, channels) {
  const stride = width * channels;
  // The filters reach back one byte per channel, not one pixel: RGB predicts
  // from the red of the same pixel, not from the previous pixel's red.
  const bytesPerPixel = channels;
  for (let y = 0; y < height; y += 1) {
    const rowIn = y * (stride + 1);
    const filterType = raw[rowIn];
    const rowOut = y * stride;
    const previousOut = rowOut - stride;
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rowIn + 1 + x];
      const left = x >= bytesPerPixel ? out[rowOut + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[previousOut + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[previousOut + x - bytesPerPixel] : 0;
      let predictor;
      if (filterType === 0) predictor = 0;
      else if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = (left + up) >> 1;
      else if (filterType === 4) predictor = paeth(left, up, upLeft);
      else {
        throw new Error(`corrupt PNG: scanline ${y} uses filter type ${filterType}, and only 0..4 exist`);
      }
      out[rowOut + x] = (encoded + predictor) & 0xff;
    }
  }
}

/**
 * Decode an 8-bit, non-interlaced PNG into packed rows.
 * @param bytes - the whole file.
 * @returns `{ width, height, channels, colourType, bitDepth, data }`, where
 *   `data` is `width * height * channels` bytes in `colourType`'s own layout.
 * @throws Error on anything it will not decode rather than guessing.
 */
export function decodePng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG: the 8-byte signature is missing or wrong");
  }

  let offset = PNG_SIGNATURE.length;
  let header = null;
  let ended = false;
  // A valid PNG may split IDAT over many chunks, so the payload is collected
  // first and inflated once.
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // A chunk whose length runs past the end of the file is how truncation
    // shows up: the writer was cut off mid-chunk, so there is nothing to
    // unfilter and no honest result to return.
    if (dataEnd + 4 > buffer.length) {
      throw new Error(
        `truncated PNG: chunk "${type}" declares ${length} bytes but only ${buffer.length - dataStart} remain`,
      );
    }
    const declaredCrc = buffer.readUInt32BE(dataEnd);
    const computedCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (declaredCrc !== computedCrc) {
      throw new Error(
        `corrupt PNG: chunk "${type}" fails its CRC (${computedCrc.toString(16)} != ${declaredCrc.toString(16)})`,
      );
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") header = readHeader(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    else if (type === "PLTE") {
      throw new Error("paletted PNG (PLTE chunk) is not supported: its pixels are palette indexes; re-encode as RGB or RGBA");
    }
    // Everything else is ancillary (tEXt, pHYs, gAMA, sRGB, …) and never changes
    // the pixels being compared.
    if (ended) break;
    offset = dataEnd + 4;
  }

  if (header === null) {
    throw new Error("corrupt PNG: no IHDR chunk (the file has no image header)");
  }
  if (idat.length === 0) {
    throw new Error("corrupt PNG: no IDAT chunk (the file has no pixel data)");
  }
  if (!ended) {
    throw new Error("truncated PNG: no IEND chunk (the file ends inside the image data)");
  }

  const { width, height, channels, colourType, bitDepth } = header;
  const stride = width * channels;
  // One filter byte per row is part of the stream, so the inflated size has to
  // be exactly this; anything else means the stream belonged to another image.
  const expectedBytes = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new Error(`corrupt PNG: the IDAT stream does not inflate (${error.message})`);
  }
  if (raw.length !== expectedBytes) {
    throw new Error(
      `corrupt PNG: the inflated image data is ${raw.length} bytes, expected ${expectedBytes} for ${width}x${height} colour type ${colourType}`,
    );
  }

  const pixels = Buffer.alloc(stride * height);
  unfilter(raw, pixels, width, height, channels);
  return { width, height, channels, colourType, bitDepth, data: pixels };
}

/**
 * Build one PNG chunk: length, type, data, CRC over type+data.
 * @param type - four-character chunk name.
 * @param data - chunk payload.
 * @returns the complete chunk bytes.
 */
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, trailer]);
}

/**
 * Encode packed pixels as an 8-bit PNG.
 * @param image - `{ width, height, channels, data }`; channels 1/2/3/4 map to
 *   colour types 0/4/2/6. Every scanline uses filter 0 (None).
 * @returns the PNG file bytes.
 */
export function encodePng(image) {
  const { width, height, channels = 4, data } = image ?? {};
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`encodePng: ${width}x${height} is not a usable image size`);
  }
  const colourType = COLOUR_TYPE_BY_CHANNELS.get(channels);
  if (colourType === undefined) {
    throw new Error(`encodePng: ${channels} channels cannot be written; pass 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA)`);
  }
  const pixels = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  const stride = width * channels;
  if (pixels.length !== stride * height) {
    throw new Error(`encodePng: ${pixels.length} bytes of pixels do not fill ${width}x${height}x${channels}`);
  }

  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    // Filter 0 everywhere: the images this encoder produces are diff masks and
    // test fixtures, and zlib already compresses their long flat runs well. The
    // filter choice is not what is being exercised.
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colourType;
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * @param image - a decoded image.
 * @returns its pixels as RGBA, either the original buffer or a widened copy.
 */
function toRgba(image) {
  const { width, height, channels, data } = image;
  const pixelCount = width * height;
  if (channels === 4) return data;
  const out = Buffer.alloc(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const from = pixel * channels;
    const to = pixel * 4;
    if (channels === 3) {
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = 255;
    } else if (channels === 2) {
      // Grey repeated into three channels so a grey image and an RGB one can be
      // compared channel for channel, and alpha carried through: a diffed
      // overlay losing its transparency is exactly the kind of regression this
      // tool exists for.
      out[to] = data[from];
      out[to + 1] = data[from];
      out[to + 2] = data[from];
      out[to + 3] = data[from + 1];
    } else {
      out[to] = data[from];
      out[to + 1] = data[from];
      out[to + 2] = data[from];
      // A grey PNG without an alpha channel is opaque, and both sides get the
      // same 255, so it cannot manufacture a difference.
      out[to + 3] = 255;
    }
  }
  return out;
}

/**
 * @param image - candidate decoded image.
 * @param role - "baseline" or "candidate", for the message.
 */
function assertDecodedImage(image, role) {
  if (image === null || typeof image !== "object") {
    throw new TypeError(`the ${role} is not a decoded image (pass what decodePng returns)`);
  }
  const { width, height, channels, data } = image;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError(`the ${role} has no usable size (${width}x${height})`);
  }
  if (!Number.isInteger(channels) || !COLOUR_TYPE_BY_CHANNELS.has(channels)) {
    throw new TypeError(`the ${role} has ${channels} channels; expected 1, 2, 3 or 4`);
  }
  if (data === undefined || data.length !== width * height * channels) {
    throw new TypeError(`the ${role} holds ${data?.length} bytes, expected ${width * height * channels}`);
  }
}

/**
 * Compare two decoded images pixel by pixel.
 * @param baseline - the stored screenshot, from `decodePng`.
 * @param candidate - the fresh screenshot, from `decodePng`.
 * @param options - `tolerance` (per-channel delta allowed, default 8, which is
 *   where subpixel text rendering and PNG graders usually land) and `ratio` (the
 *   share of differing pixels that still counts as the same image, default
 *   0.2% — enough for a caret blink, not enough for a moved highlight).
 * @returns a report; never throws for a merely different picture, because the
 *   caller decides what difference means.
 */
export function diffImages(baseline, candidate, options = {}) {
  const tolerance = options.tolerance ?? 8;
  const ratio = options.ratio ?? 0.002;
  assertDecodedImage(baseline, "baseline");
  assertDecodedImage(candidate, "candidate");

  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    // Nothing lines up, so there is no pixel to compare. Reporting a plausible
    // ratio here would be a lie that reads like a measurement, so every
    // candidate pixel counts as changed and the verdict is decided by that.
    const totalPixels = candidate.width * candidate.height;
    return {
      verdict: "differs",
      sizeMatch: false,
      width: baseline.width,
      height: baseline.height,
      candidateWidth: candidate.width,
      candidateHeight: candidate.height,
      totalPixels,
      diffPixels: totalPixels,
      diffRatio: 1,
      worstDelta: null,
      worstChannel: null,
      worstX: -1,
      worstY: -1,
      mask: null,
      tolerance,
      ratio,
    };
  }

  const { width, height } = baseline;
  const totalPixels = width * height;
  const before = toRgba(baseline);
  const after = toRgba(candidate);
  const mask = new Uint8Array(totalPixels);
  let diffPixels = 0;
  let worstDelta = -1;
  let worstChannel = null;
  let worstX = -1;
  let worstY = -1;

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const at = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(before[at + channel] - after[at + channel]);
      // The largest single-channel move is tracked even below tolerance: it is
      // the number that tells a human "one antialiased edge" from "a block
      // moved", and it is what the diff image is looked at next to.
      if (delta > worstDelta) {
        worstDelta = delta;
        worstChannel = CHANNEL_NAMES[channel];
        worstX = pixel % width;
        worstY = (pixel - worstX) / width;
      }
      if (delta > tolerance) changed = true;
    }
    if (changed) {
      mask[pixel] = 1;
      diffPixels += 1;
    }
  }

  const diffRatio = diffPixels / totalPixels;
  return {
    verdict: diffRatio <= ratio ? "same" : "differs",
    sizeMatch: true,
    width,
    height,
    candidateWidth: width,
    candidateHeight: height,
    totalPixels,
    diffPixels,
    diffRatio,
    worstDelta: Math.max(worstDelta, 0),
    worstChannel,
    worstX,
    worstY,
    mask,
    tolerance,
    ratio,
  };
}

/**
 * The picture a human looks at: the candidate dimmed towards grey, with every
 * changed pixel painted pure red. Red and grey are not values a UI screenshot
 * reaches by accident, so the marks read as marks rather than as styling.
 * @param candidate - the decoded fresh screenshot.
 * @param report - a report from `diffImages` with a pixel mask.
 * @returns PNG bytes the size of the candidate.
 */
export function renderDiffPng(candidate, report) {
  if (report?.mask == null) {
    throw new Error("renderDiffPng: there is no pixel mask to draw (the sizes differed, so nothing was compared)");
  }
  const { width, height } = candidate;
  const pixelCount = width * height;
  const source = toRgba(candidate);
  const out = Buffer.alloc(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const at = pixel * 4;
    if (report.mask[pixel] === 1) {
      out[at] = 255;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = 255;
      continue;
    }
    // Luma rather than one channel, so the dimmed backdrop still shows the page
    // layout the red is sitting on.
    const grey = Math.round((0.299 * source[at] + 0.587 * source[at + 1] + 0.114 * source[at + 2]) * 0.25);
    out[at] = grey;
    out[at + 1] = grey;
    out[at + 2] = grey;
    // Opaque on purpose: this is looked at as a flat picture, so a transparent
    // region must not become the viewer's checkerboard.
    out[at + 3] = 255;
  }
  return encodePng({ width, height, channels: 4, data: out });
}

const USAGE =
  "usage: node tests/visual-diff.mjs <baseline.png> <candidate.png> " +
  "[--tolerance 8] [--ratio 0.002] [--write-diff <path>] [--quiet]";

/** A mistake in how the command was called, as opposed to a broken image. */
class UsageError extends Error {}

/**
 * @param argv - arguments after the script name.
 * @returns parsed paths and options.
 */
function parseArgs(argv) {
  const paths = [];
  const options = { tolerance: 8, ratio: 0.002, writeDiff: null, quiet: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    // `--ratio=0.01` and `--ratio 0.01` both appear in shell scripts; accepting
    // only one form is a support question waiting to happen.
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (name === "--tolerance" || name === "--ratio" || name === "--write-diff") {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      if (name === "--write-diff") {
        options.writeDiff = String(value);
        continue;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        throw new UsageError(`${name} needs a non-negative number, got "${value}"`);
      }
      options[name === "--tolerance" ? "tolerance" : "ratio"] = number;
      continue;
    }
    if (name.startsWith("-")) throw new UsageError(`unknown option ${name}`);
    paths.push(arg);
  }
  if (!options.help && paths.length !== 2) {
    throw new UsageError(`expected two images (baseline then candidate), got ${paths.length}`);
  }
  return { ...options, baselinePath: paths[0], candidatePath: paths[1] };
}

/**
 * Read and decode one image, naming which side failed.
 * @param path - PNG file.
 * @param role - "baseline" or "candidate", for the message.
 * @returns the decoded image.
 */
function readPngFile(path, role) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`cannot read the ${role} ${path}: ${error.message}`);
  }
  try {
    return decodePng(bytes);
  } catch (error) {
    throw new Error(`cannot decode the ${role} ${path}: ${error.message}`);
  }
}

/**
 * The command line, minus the process: returns the exit code instead of setting
 * it, so a test can call this in-process and a runner can still run the file.
 * Writes one `key=value` fact per line to stdout — grep-friendly, and no prose
 * for a parser to skip.
 * @param argv - arguments after the script name.
 * @param io - `{ stdout, stderr }` writers; defaults to the real streams.
 * @returns `{ code, report }`; `report` is null when nothing was compared.
 */
export function runVisualDiff(argv, io = process) {
  const stdout = (line) => io.stdout.write(`${line}\n`);
  const stderr = (line) => io.stderr.write(`${line}\n`);

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`visual-diff: ${error.message}`);
    stderr(USAGE);
    return { code: 1, report: null };
  }
  if (options.help) {
    stdout(USAGE);
    return { code: 0, report: null };
  }

  let baseline;
  let candidate;
  try {
    baseline = readPngFile(options.baselinePath, "baseline");
    candidate = readPngFile(options.candidatePath, "candidate");
  } catch (error) {
    stderr(`visual-diff: ${error.message}`);
    return { code: 1, report: null };
  }

  const report = diffImages(baseline, candidate, { tolerance: options.tolerance, ratio: options.ratio });

  if (!options.quiet) {
    stdout(`baseline=${options.baselinePath}`);
    stdout(`candidate=${options.candidatePath}`);
  }
  stdout(`size=${report.width}x${report.height}`);
  stdout(`sizeMatch=${report.sizeMatch ? "true" : "false"}`);
  if (!report.sizeMatch) {
    stdout(`candidateSize=${report.candidateWidth}x${report.candidateHeight}`);
    stderr(
      `visual-diff: the images are different sizes (${report.width}x${report.height} vs ${report.candidateWidth}x${report.candidateHeight}); nothing can be compared pixel for pixel`,
    );
  }
  stdout(`diffPixels=${report.diffPixels}`);
  stdout(`diffRatio=${report.diffRatio.toFixed(6)}`);
  // A size mismatch has no delta to report; `na` says so instead of inventing a
  // number a script would happily compare against.
  stdout(`worstDelta=${report.sizeMatch ? report.worstDelta : "na"}`);
  stdout(`worstChannel=${report.sizeMatch ? report.worstChannel : "na"}`);
  stdout(`worstAt=${report.sizeMatch ? `${report.worstX},${report.worstY}` : "na"}`);
  stdout(`tolerance=${report.tolerance}`);
  stdout(`ratio=${report.ratio}`);
  stdout(`verdict=${report.verdict}`);

  const code = report.verdict === "same" ? 0 : 2;

  if (options.writeDiff !== null) {
    if (!report.sizeMatch) {
      stderr("visual-diff: no diff image written: a size mismatch has no pixel mask to paint");
    } else {
      const target = resolve(options.writeDiff);
      try {
        writeFileSync(target, renderDiffPng(candidate, report));
      } catch (error) {
        // The comparison already happened, but a caller that asked for the one
        // artefact a human needs must not get a success code when it is missing.
        stderr(`visual-diff: could not write the diff image ${target}: ${error.message}`);
        return { code: 1, report };
      }
      if (!options.quiet) stdout(`diffImage=${target}`);
    }
  }

  return { code, report };
}

// The usual entry-point guard: importing this module must not run the CLI (the
// test suite imports four functions from it), but `node tests/visual-diff.mjs`
// must.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `exitCode` rather than `exit()`: stdout is a pipe under a test runner, and
  // exiting mid-flush truncates the very lines the runner greps for.
  process.exitCode = runVisualDiff(process.argv.slice(2)).code;
}
