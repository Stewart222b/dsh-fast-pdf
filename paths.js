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
 *
 * Both separators count. A path the Host resolved arrives in the platform's own
 * spelling, and on Windows that is `C:\work\a.pdf`: splitting on `/` alone
 * leaves the whole path as the "file name", which is how every document opened
 * by path came to be titled with its full location.
 * @param target - a path or a `dsh-resource://` address.
 * @returns the decoded last segment, or "".
 */
export function fileNameOf(target) {
  const text = String(target ?? "");
  const cut = text.search(/[?#]/u);
  const parts = text.slice(0, cut === -1 ? undefined : cut).split(/[\\/]/u);
  const last = parts[parts.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * The path to put in a citation link, from a document's stored address.
 *
 * A citation is a Markdown link the conversation's own renderer turns into a
 * button, and that renderer only recognises a destination it can parse as a
 * file: a workspace-relative path or an absolute one. It rejects
 * `dsh-resource://` addresses, so the address a document is stored under is not
 * the address a citation may use — this converts one into the other.
 *
 * The escaping matters as much as the path. Markdown link destinations may not
 * contain spaces, and the renderer decodes URL escapes exactly once before
 * parsing, so percent-encoding each segment produces the original path at the
 * far end. Encoding the whole string would encode its separators too.
 * @param address - a `dsh-resource://file/...` address.
 * @returns the citation-ready destination, or undefined when unusable.
 */
export function citationTargetOf(address) {
  const parsed = parseFileAddress(address);
  if (parsed === null) return undefined;
  const path = parsed.path.replace(/\\/gu, "/");
  if (path === "") return undefined;
  const encoded = path
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  return encoded === "" ? undefined : encoded;
}

/**
 * The address a document is stored under, for a path this Host resolved.
 *
 * Two halves of this plugin reach the same file and must agree on its identity:
 * the pane, which names a file by the tab address it already has, and the Host,
 * which resolves a path itself. A `docId` is derived from the address, so the
 * two only coincide when the addresses coincide.
 *
 * A file inside the session's workspace therefore gets the same
 * `session/<id>/<relative path>` shape the pane uses — which also makes a
 * citation short and relative, the way a person would write it. Anything outside
 * the workspace has no relative spelling, and keeps the `absolute` form.
 * @param ctx - plugin context.
 * @param sessionId - the session the document belongs to.
 * @param path - an absolute path.
 * @returns a `dsh-resource://file/...` address.
 */
export function fileAddressFor(ctx, sessionId, path) {
  const text = String(path ?? "").replace(/\\/gu, "/");
  /** @param segment - one path segment. @returns it, encoded. */
  const encode = (segment) => {
    try {
      return encodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const root = String(workspaceRootFor(ctx, sessionId) ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (root !== "" && text !== root && text.startsWith(`${root}/`)) {
    const relative = text.slice(root.length + 1);
    const encoded = relative.split("/").filter((part) => part !== "").map(encode).join("/");
    if (encoded !== "") return `${FILE_ADDRESS_PREFIX}session/${encode(sessionId)}/${encoded}`;
  }
  const absolute = text.startsWith("/") ? text : `/${text}`;
  return `${FILE_ADDRESS_PREFIX}absolute${absolute.split("/").map(encode).join("/")}`;
}
