/**
 * Offline proof that what this package publishes can actually be loaded.
 *
 * The failure this file exists for already happened once: `tools.js` imported
 * `./extract.js` and `./paths.js`, both were added after the `files` list was
 * written, and neither was in it. Everything passed locally — the source tree
 * has every file — and the packed tarball threw `ERR_MODULE_NOT_FOUND` on its
 * first `import`. `npm publish` would have shipped that.
 *
 * So this test reads `package.json` the way npm does and walks the real import
 * graph from both entry points, then asks whether every file that gets loaded
 * is covered by `files`. It also checks the display metadata the Plugin Manager
 * reads (title, description, icon, detail document) and the fields a published
 * package needs (`private`, `repository`, `engines.dsh`).
 *
 * Usage:
 *   node tests/pack-manifest.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];

/** Record one assertion. */
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

/** Report and exit. */
function report() {
  let failed = 0;
  for (const { name, ok, detail } of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Package-relative POSIX path for an absolute one. */
function rel(abs) {
  return relative(ROOT, abs).split(sep).join("/");
}

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];

/** Escape one literal chunk of a glob for use inside a RegExp. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether npm's `files` list would include a package-relative path.
 *
 * npm treats a bare directory name as the whole subtree and `*` as "anything
 * but a separator", which is all this manifest uses.
 */
function covered(relPath) {
  const path = relPath.replace(/^\.\//, "");
  return files.some((entry) => {
    const item = String(entry).replace(/^\.\//, "");
    if (item.includes("*")) {
      const pattern = `^${item.split("*").map(escapeRe).join("[^/]*")}$`;
      return new RegExp(pattern, "u").test(path);
    }
    return path === item || path.startsWith(`${item}/`);
  });
}

// 1. Every literal entry in `files` exists. A stale name is worse than a
//    missing one: npm silently drops it and the intent is lost.
const literals = files.filter((entry) => !String(entry).includes("*"));
const missing = literals.filter((entry) => !existsSync(join(ROOT, String(entry))));
check("every literal files entry exists", missing.length === 0, missing.join(", ") || `${literals.length} entries`);

// 2. Fields a published package needs. `private: true` makes `npm publish`
//    refuse outright; the rest are what the registry page and the Plugin
//    Manager display.
check("the package is publishable", manifest.private !== true, manifest.private === true ? "private: true" : "not private");
check("the package is versioned", /^\d+\.\d+\.\d+/u.test(String(manifest.version)), String(manifest.version));
check("the package is MIT-licensed", manifest.license === "MIT", String(manifest.license));
// npm packs README, LICENSE and package.json even when `files` omits them, so
// only their presence on disk is checked here.
check("the license file exists", existsSync(join(ROOT, "LICENSE")), "LICENSE");
check(
  "the repository is declared",
  typeof manifest.repository?.url === "string" && manifest.repository.url.includes("dsh-fast-pdf"),
  manifest.repository?.url ?? "none",
);
check("the readme ships", files.includes("README.md"), files.includes("README.md") ? "README.md" : "missing");
check(
  "a changelog ships",
  files.includes("CHANGELOG.md") && existsSync(join(ROOT, "CHANGELOG.md")),
  files.includes("CHANGELOG.md") ? "CHANGELOG.md" : "missing from files",
);
// The launcher and plugin manager enforce neither field today, but they are the
// only statement of what this plugin was tested against.
check(
  "engines.dsh is declared",
  typeof manifest.engines?.dsh === "string" && manifest.engines.dsh !== "",
  manifest.engines?.dsh ?? "none",
);

// 3. The two entries the loaders ask for, and the patch they compose.
check("the host entry ships", covered("index.js"), manifest.exports?.["."] ?? "no . export");
check(
  "the client entry ships",
  covered("client.js") && manifest.exports?.["./client"] === "./client.js",
  manifest.exports?.["./client"] ?? "no ./client export",
);
const patchRel = manifest.dsh?.bundle?.patch;
check(
  "the bundle patch ships",
  typeof patchRel === "string" && existsSync(join(ROOT, patchRel)) && covered(patchRel),
  String(patchRel),
);

// 4. Walk the import graph from both entry points. Only relative specifiers
//    matter here: package specifiers resolve inside node_modules, which npm
//    never packs.
const LOCAL_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;

/** Every local file reachable from `entry` by relative import. */
function importGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const abs = join(ROOT, current);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) continue;
    const text = readFileSync(abs, "utf8");
    for (const match of text.matchAll(LOCAL_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(current), match[1]));
      if (!seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

const hostGraph = importGraph("index.js");
const unpacked = hostGraph.filter((path) => !covered(path));
check(
  "every module the host imports ships",
  unpacked.length === 0,
  unpacked.length === 0 ? `${hostGraph.length} modules` : unpacked.join(", "),
);
check(
  "the host graph reaches both post-hoc modules",
  hostGraph.includes("extract.js") && hostGraph.includes("paths.js"),
  hostGraph.filter((path) => !path.includes("/")).join(", "),
);

// 5. The client half names its assets as strings, so the import walk cannot see
//    them: `viewer.mjs` through `moduleAssetUrl`, the helpers through
//    `loadHelper`. Every `public/<name>` the client mentions has to exist.
const clientText = readFileSync(join(ROOT, "client.js"), "utf8");
const assetNames = new Set([...clientText.matchAll(/"([\w.-]+\.mjs)"/gu)].map((match) => match[1]));
const missingAssets = [...assetNames].filter((name) => !existsSync(join(ROOT, "public", name)));
check(
  "every public/ asset the client names exists",
  missingAssets.length === 0,
  missingAssets.join(", ") || `${assetNames.size} assets`,
);
check(
  "the public directory ships whole",
  covered("public/viewer.mjs") && covered("public/pdf.worker.mjs"),
  "public/",
);

// 6. Display metadata. Without these the Plugin Manager falls back to the
//    package name, the English `description`, and generic artwork.
const locales = ["en", "zh"].filter((lang) => existsSync(join(ROOT, "locale", `${lang}.json`)));
check("locale/en.json and locale/zh.json ship", locales.length === 2, locales.join(", ") || "none");
check(
  "the locale files are exported",
  manifest.exports?.["./locale/*.json"] === "./locale/*.json",
  manifest.exports?.["./locale/*.json"] ?? "no ./locale/*.json export",
);
check("the locale files are packed", covered("locale/en.json"), "locale/*.json");

const iconExport = manifest.exports?.["./icon"] ?? manifest.icon;
check("an icon is declared", typeof iconExport === "string", String(iconExport));
const iconFile = typeof manifest.icon === "string" ? manifest.icon : "";
check(
  "the icon file ships",
  iconFile !== "" && existsSync(join(ROOT, iconFile)) && covered(iconFile),
  iconFile === "" ? "no package.json icon" : iconFile,
);
if (iconFile !== "" && existsSync(join(ROOT, iconFile))) {
  const size = statSync(join(ROOT, iconFile)).size;
  // The Plugin Manager decodes icons up to 256 KiB; the artwork guidance asks
  // for 36×36 units of a 36×36 viewBox.
  check("the icon fits the 256 KiB limit", size <= 256 * 1024, `${(size / 1024).toFixed(1)} KiB`);
  const svg = readFileSync(join(ROOT, iconFile), "utf8");
  check(
    "the icon is self-contained geometry",
    /viewBox="0 0 36 36"/u.test(svg)
      && !/<(?:script|style|image|foreignObject|text)\b/iu.test(svg)
      && !/\son\w+\s*=/iu.test(svg),
    "no script, style, image, text or handlers",
  );
}

for (const lang of locales) {
  const locale = JSON.parse(readFileSync(join(ROOT, "locale", `${lang}.json`), "utf8"));
  const meta = locale.meta ?? {};
  check(
    `locale/${lang}.json has a title and description`,
    typeof meta.title === "string" && meta.title !== "" && typeof meta.description === "string" && meta.description.length > 40,
    typeof meta.title === "string" ? meta.title : "no meta.title",
  );
  if (typeof meta.detail !== "string") continue;
  // A declared detail document that is missing is an error, not a README
  // fallback — so it must exist and must be packed with its images.
  const detailPath = join(ROOT, meta.detail);
  const detailShipped = existsSync(detailPath) && covered(meta.detail);
  check(`locale/${lang}.json detail document ships`, detailShipped, meta.detail);
  if (!detailShipped) continue;
  const detailText = readFileSync(detailPath, "utf8");
  const images = [...detailText.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/gu)].map((match) => match[1]);
  check(
    `the ${lang} detail document shows one feature image`,
    images.length === 1,
    `${images.length} image(s)`,
  );
  for (const image of images) {
    if (/^[a-z]+:/iu.test(image)) continue;
    const imagePath = posix.normalize(posix.join(posix.dirname(meta.detail), image));
    check(
      `the ${lang} detail image ships`,
      existsSync(join(ROOT, imagePath)) && covered(imagePath),
      imagePath,
    );
  }
}

// 7. The `dsh` block itself: the launcher reads `dsh.bundle.patch` and the
//    browser validates `dsh.client` strictly, where a bad field costs the whole
//    client half.
check("dsh.manifestVersion is 1", manifest.dsh?.manifestVersion === 1, String(manifest.dsh?.manifestVersion));
check("dsh.client targets web", manifest.dsh?.client?.platform === "web", String(manifest.dsh?.client?.platform));

report();
