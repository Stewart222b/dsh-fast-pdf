/**
 * Turning what a caller names into a path this Host will actually open.
 *
 * These four functions used to live inside `index.js`, where the file route was
 * their only customer. The document tools need the same answers now — the model
 * may name a PDF by workspace-relative path, by absolute path, or by the
 * `dsh-resource://` address the pane already uses — and two copies of the
 * address grammar would eventually disagree about what `..` or a Windows drive
 * means. So the grammar lives here once, and both the route and the tools call
 * it.
 *
 * Nothing here imports from `@deepseek-ai/*`: these run in the Host process,
 * where a third-party bundle that fails to import takes the whole plugin with
 * it.
 */

/** The `dsh-resource://file/` grammar, as the Host writes it. */
export const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

/**
 * Whether a path is absolute in either spelling the Host accepts: POSIX
 * (`/a/b`), a Windows drive (`C:/a/b`) or a UNC path (`//server/share`).
 * `node:path`'s `isAbsolute` only understands the current platform, so a
 * Windows-formatted address would be refused as "需要一个绝对路径" on macOS.
 * @param path - the decoded path.
 * @returns true when the Host would treat it as absolute.
 */
export function isAbsoluteWorkspacePath(path) {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith("\\\\");
}

/**
 * Read a file address back into a scope, a session and a path.
 *
 * Copied from the built-in document preview's own parser rather than imported:
 * what has to match is the grammar on the wire, and that is one small function.
 * A `session` path is absolute *or* relative to that session's workspace root,
 * which is exactly why the route resolves it instead of demanding absolute.
 * @param address - a candidate `dsh-resource://file/...` address.
 * @returns `{ scope, sessionId, path }`, or null when it is not one.
 */
export function parseFileAddress(address) {
  try {
    if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return null;
    const cut = address.search(/[?#]/u);
    const parts = address.slice(FILE_ADDRESS_PREFIX.length, cut === -1 ? undefined : cut).split("/");
    const scope = parts.shift();
    if (scope === "session") {
      const [id, ...segments] = parts;
      if (id === undefined || id === "" || segments.length === 0) return null;
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: segments.map((part) => decodeURIComponent(part)).join("/"),
      };
    }
    if (scope === "absolute") {
      // Match the Host's `dsh-util-workspace-path` grammar: an empty first
      // segment with more behind it is a UNC path's `//`, a first segment like
      // `C:` is a Windows drive, and every other POSIX path needs its leading
      // slash put back. Without these three cases an absolute address never
      // passes the path check and the file route answers 400.
      const unc = parts[0] === "" && parts.length > 1;
      const segments = (unc ? parts.slice(1) : parts).map((part) => decodeURIComponent(part));
      if (segments.length === 0 || segments[0] === "") return null;
      if (unc) return { scope, sessionId: "", path: `//${segments.join("/")}` };
      const drive = /^[A-Za-z]:$/u.test(segments[0]);
      return { scope, sessionId: "", path: drive ? segments.join("/") : `/${segments.join("/")}` };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Where a session's relative paths are resolved from.
 *
 * The same answer the Host gives its own workspace reads: the session header's
 * `cwd`, then the sandbox policy's workspace root. Read through `ctx.get` so a
 * build without either service still serves absolute addresses.
 * @param ctx - plugin context.
 * @param sessionId - the session named by the address.
 * @returns an absolute directory.
 */
export function workspaceRootFor(ctx, sessionId) {
  /** @param name - service name. @returns the service, or undefined. */
  const read = (name) => {
    try {
      return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const header = read("sessions")?.get?.(sessionId)?.header;
    if (typeof header?.cwd === "string" && header.cwd !== "") return header.cwd;
  } catch {
    // A session that is already gone has no cwd to read; fall through.
  }
  const root = read("sandboxPolicy")?.workspaceRoot;
  if (typeof root === "string" && root !== "") return root;
  return process.cwd();
}

/**
 * The file name at the end of a path or address.
 *
 * The renderer falls back to the localized word "文档" for a file opened from
 * bytes, which is what made every document in a conversation carry that name.
 * The last segment of the path always ends in the real file name, and that is
 * what a person recognises in a citation.
 * @param target - a path or a `dsh-resource://` address.
 * @returns the decoded last segment, or "".
 */
export function fileNameOf(target) {
  const text = String(target ?? "");
  const cut = text.search(/[?#]/u);
  const parts = text.slice(0, cut === -1 ? undefined : cut).split("/");
  const last = parts[parts.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
