/**
 * Offline proof that the profile is wired to this package the way the boot
 * loader resolves it.
 *
 * `host-live.mjs` asks the running GUI whether the plugin is live; this asks
 * the profile whether the GUI could find it at all, and it answers without a
 * restart. The two failures it is built for are the ones a restart cannot tell
 * apart from "the code is wrong": a junction that points somewhere else, and an
 * `exports` map that does not expose the entry the shell asks for.
 *
 * Every step mirrors a line of the real loader
 * (`@deepseek-ai/dsh-app-boot/lib/index.js`): `resolveBundleDir` resolves the
 * bundle name from the profile's `package.json`, `bundlePatchPaths` joins
 * `dsh.bundle.patch` onto the package directory without going through
 * `exports`, and cordis imports the package's `main` as an ES module.
 *
 * Usage:
 *   node tests/install-check.mjs                    # the desktop profile
 *   node tests/install-check.mjs <profile-dir>
 *
 * `$DSH_PROFILE_DIR` overrides the default when the environment says so.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "dsh-fast-pdf";
/** Where the desktop surface installs its profile. */
const DEFAULT_PROFILE = join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".dsh",
  "profiles",
  "desktop",
);

const profileDir = process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? DEFAULT_PROFILE;
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
    const mark = ok ? "ok  " : "FAIL";
    console.log(`${mark}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`no profile at ${profileDir}`);
  process.exit(1);
}

const require = createRequire(join(profileDir, "package.json"));

// 1. The profile lists the bundle. A profile without it boots fine and simply
//    never loads this package — the failure mode with no error message.
let profile = {};
try {
  profile = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
} catch (error) {
  console.error(`the profile manifest is not readable JSON: ${error.message}`);
  process.exit(1);
}
const bundles = profile.dsh?.profile?.bundles ?? [];
check(
  "the profile lists the bundle",
  bundles.includes(PACKAGE),
  bundles.includes(PACKAGE) ? `${bundles.length} bundles` : "missing from dsh.profile.bundles",
);

// 2. Resolution from the profile anchor — the same call the loader makes when it
//    turns the bundle name into a directory.
let packageJsonPath = "";
let clientEntry = "";
let mainEntry = "";
try {
  packageJsonPath = require.resolve(`${PACKAGE}/package.json`);
  clientEntry = require.resolve(`${PACKAGE}/client`);
  mainEntry = require.resolve(`${PACKAGE}`);
} catch (error) {
  check("the package resolves from the profile", false, error.message);
  report();
}
const packageDir = dirname(packageJsonPath);
check("the package resolves from the profile", true, packageDir);

// 3. A dev install is a link; say so, because editing the profile's copy of the
//    files is then editing this repository. Node resolves the link away, so the
//    entry itself has to be looked at with `lstat`.
const linkPath = join(profileDir, "node_modules", PACKAGE);
let linkKind = "missing";
try {
  linkKind = lstatSync(linkPath).isSymbolicLink() ? "link" : "copy";
} catch {
  /* keep "missing" */
}
check(
  "the install is a link, not a copy",
  linkKind === "link",
  linkKind === "copy" ? "a copied install — a source edit needs a reinstall" : packageDir,
);

// 4. The shell asks for `<package>/client`; the host half is the package root.
check("the client entry is client.js", clientEntry.endsWith("client.js"), clientEntry);
check("the host entry is index.js", mainEntry.endsWith("index.js"), mainEntry);

// 5. The declared patch file exists at the joined path. The loader joins the
//    path onto the package directory, so a missing `exports` subpath is fine —
//    a missing file is not.
const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const patchRel = manifest.dsh?.bundle?.patch;
const patchFile =
  patchRel === undefined || !existsSync(join(packageDir, patchRel))
    ? ""
    : join(packageDir, patchRel);
check("the bundle declares a patch file", typeof patchRel === "string", String(patchRel));
check("the patch file exists", patchFile !== "", patchFile === "" ? "missing" : patchFile);

// 6. The patch inserts this package, which is what puts the host half in the tree.
const patchText = patchFile === "" ? "" : readFileSync(patchFile, "utf8");
const inserts = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
check(
  "the patch inserts one entry for this package",
  inserts.length === 1 && patchText.includes(`name: '${PACKAGE}'`),
  `id: ${inserts.join(",") || "none"}`,
);

// 7. Compatibility gating: an unmet `engines.dsh` or a `@deepseek-ai/dsh*` peer
//    that the runtime does not satisfy gets the whole bundle skipped.
const requirements = [];
if (typeof manifest.engines?.dsh === "string") requirements.push(`engines.dsh ${manifest.engines.dsh}`);
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) {
    requirements.push(`${name} ${range}`);
  }
}
check(
  "no version requirement can skip the bundle",
  requirements.length === 0,
  requirements.join(", ") || "none declared",
);

// 8. Cordis imports the package root as an ES module and reads named exports.
const host = await import(pathToFileURL(mainEntry).href).catch((error) => {
  check("the host half imports as ESM", false, error.message);
  return null;
});
if (host === null) report();
check("the host half imports as ESM", true, Object.keys(host).join(","));
check(
  "the host half exports the cordis shape",
  typeof host.apply === "function" && Array.isArray(host.inject),
  `inject: ${JSON.stringify(host.inject)}`,
);
check(
  "the host half asks for the web server only",
  Array.isArray(host.inject) && host.inject.length === 1 && host.inject[0] === "webServer",
  JSON.stringify(host.inject),
);

// 9. Applying it against a stand-in context must register every route and
//    nothing else, so a missing service cannot be the reason a restart shows no
//    plugin. The tool route is allowed to do nothing here: this context has no
//    `get`, and the tools are an optional service the viewer must survive
//    without.
const routes = [];
const effects = [];
host.apply({
  effect(fn, label) {
    effects.push(label ?? "(unlabelled)");
    fn();
    return () => {};
  },
  webServer: {
    register(route) {
      routes.push(`${route.kind} ${route.path}`);
      return () => {};
    },
  },
});
check(
  "applying the host half registers the six routes",
  routes.join("|") === "prefix /fast-pdf|exact /fast-pdf/translate|exact /fast-pdf/hello|exact /fast-pdf/file|exact /fast-pdf/sync|exact /fast-pdf/work",
  routes.join(" | "),
);
check(
  "every effect carries a label",
  effects.every((label) => label !== "(unlabelled)"),
  effects.join(" | "),
);

// 10. The client bundle keeps to the shell's seed table — the same rule the smoke
//     test enforces, repeated here because this file already imports nothing.
const clientText = readFileSync(clientEntry, "utf8");
const specifiers = [...clientText.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]);
const SEEDS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "zod",
  "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);
const stray = specifiers.filter((id) => !SEEDS.has(id));
check("the client bundle requires only seed modules", stray.length === 0, specifiers.join(", ") || "none");
check(
  "the client bundle is loaded as a script, not a module",
  !/^\s*(?:import|export)\s/m.test(clientText),
  "no top-level import/export",
);

// 11. The `dsh.client` declaration, validated the way the browser loader
//     validates it (`parseDshClient` in `dsh-client-modules`) — same field
//     names, same rules. A declaration that throws there costs the whole client
//     half, and the pane then quietly shows the built-in previewer instead.
const clientDecl = manifest.dsh?.client;
check(
  "the bundle declares a client half",
  typeof clientDecl === "object" && clientDecl !== null,
  typeof clientDecl === "object" && clientDecl !== null ? `platform: ${clientDecl.platform}` : "no dsh.client",
);
check("the client half targets the web surface", clientDecl?.platform === "web", String(clientDecl?.platform));
const injectNames = clientDecl?.inject;
check(
  "its inject list is package names",
  injectNames === undefined
    || (Array.isArray(injectNames)
      && injectNames.every((name) => typeof name === "string" && name !== "" && !name.startsWith(".") && !name.includes("://"))),
  Array.isArray(injectNames) ? injectNames.join(", ") : "none",
);
check(
  "its immediately flag is a boolean if present",
  clientDecl?.immediately === undefined || typeof clientDecl.immediately === "boolean",
  String(clientDecl?.immediately),
);

// 12. The bundle registers itself under the package name. The loader looks up
//     `factories.has(<row id>)` after running the script, so a mismatched id
//     fails as `loaded without registering` — again with no visible symptom.
const registered = clientText.match(/__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?\bid:\s*"([^"]+)"/u);
check(
  "the client bundle registers under the package name",
  registered?.[1] === PACKAGE,
  registered?.[1] ?? "no __ModuleLoader__.load id found",
);

report();
