/**
 * The Host-to-browser work channel for page images.
 *
 * Text never needs this: the browser posts page texts up front and the Host
 * keeps them. An image is different, because only the browser can render one —
 * the Host has no canvas, and adding a native rasterizer would drag a system
 * dependency (poppler, or a prebuilt `@napi-rs/canvas`) into an install that is
 * supposed to be one `link:` away from working.
 *
 * The two halves still cannot be wired in the obvious direction: the renderer
 * talks to the Host, never the reverse, and the desktop shell carries that
 * traffic over an IPC bridge instead of a socket. So the direction is inverted
 * here — the pane keeps one ordinary request open ("do you need anything?"),
 * and the Host answers it when a tool call needs a page rendered. That is a
 * plain request/response, which is exactly what both transports carry, and it
 * does not assume the WebSocket upgrade path is forwarded.
 *
 * Everything is keyed by session: a page image may only be rendered for a
 * session whose own pane asked to be able to serve one, and an answer that
 * arrives for someone else's job is refused.
 */

/**
 * How long a pane's "do you need anything?" request is held open.
 *
 * Short enough that an ordinary proxy or the IPC bridge is happy with it, long
 * enough that a quiet session costs one request every twenty seconds rather
 * than a poll per second.
 */
export const WORK_WAIT_MS = 20_000;

/**
 * How long a job waits for a pane to take it.
 *
 * A tool call that arrives while the pane is repainting still succeeds; one that
 * arrives with no pane open fails with the sentence that tells the model to ask
 * the user to open the document.
 */
export const CLAIM_TIMEOUT_MS = 30_000;

/**
 * How long a job waits when no pane has ever served the session.
 *
 * Short, but not zero: a pane starts polling the moment it mounts, so a tool
 * called in the same second as the pane opening would otherwise be told there is
 * no pane by a race it cannot see. One and a half seconds is long enough for the
 * first poll to arrive and far short of the thirty seconds a silence used to
 * cost — and since the Host can now read a file itself, "no pane" is a
 * condition the caller can work with rather than a dead end.
 */
export const PANE_ABSENT_MS = 1500;

/**
 * How long a tool waits for a rendered page after a pane took the job.
 *
 * Rendering one page measured at well under a second in the browser; the
 * allowance is for a cold pdf.js worker on a huge document, not for a pane that
 * has gone away.
 */
export const IMAGE_TIMEOUT_MS = 30_000;

/** Most jobs one session may have in flight, so a burst cannot pile up. */
const MAX_JOBS_PER_SESSION = 4;

/**
 * Every job that has not settled yet, by id.
 *
 * One map for both states — waiting and taken — because a job moves between them
 * and splitting the bookkeeping is how an entry gets lost in the gap.
 * @type {Map<string, {
 *   job: { id: string, pageNumber: number, docId: string, createdAt: number },
 *   sessionId: string,
 *   settle: (error: Error | undefined, dataUrl?: string) => void,
 *   taken: boolean,
 * }>}
 */
const jobs = new Map();

/**
 * Jobs still waiting for a pane, oldest first, per session.
 * @type {Map<string, string[]>}
 */
const queue = new Map();

/**
 * Panes holding a "do you need anything?" request open, per session.
 * @type {Map<string, Set<(work: object | null) => void>>}
 */
const pollers = new Map();

/**
 * Sessions whose pane has asked for work at least once.
 *
 * A page image is rendered by a browser pane, so with no pane there is nothing
 * to render it and no reason to wait. The distinction this set draws is between
 * "the pane has not answered yet" and "there is no pane": without it both look
 * like silence, and the tool spends its claim deadline proving something it
 * could have known at once.
 * @type {Set<string>}
 */
const activePanes = new Set();

/**
 * Whether a pane has ever asked this session for work.
 *
 * "Ever", not "right now": a pane long-polls, so between two requests there is a
 * millisecond when no request is outstanding, and treating that as absence would
 * refuse a render the pane was about to perform.
 * @param sessionId - the session to ask about.
 * @returns true when a pane is known to serve this session.
 */
export function hasPane(sessionId) {
  return activePanes.has(sessionId);
}

/** Monotonic job id source. */
let nextJobId = 1;

/**
 * Hand the oldest waiting job of one session to a pane.
 *
 * Called from both directions — a job arriving while a pane waits, and a pane
 * asking while a job waits — so the two cannot both take the same job: the
 * removal happens here, once.
 * @param sessionId - the session to serve.
 * @param waiter - the pane's resolver, or undefined to hand to a registered one.
 * @returns true when the job found a pane.
 */
function handOff(sessionId, waiter) {
  const pending = queue.get(sessionId);
  if (pending === undefined || pending.length === 0) return false;
  const target = waiter ?? firstPoller(sessionId);
  if (target === undefined) return false;
  const id = pending.shift();
  if (pending.length === 0) queue.delete(sessionId);
  const entry = jobs.get(id);
  if (entry === undefined) return false;
  entry.taken = true;
  entry.clearClaim?.();
  entry.startImageDeadline?.();
  target(entry.job);
  return true;
}

/**
 * Take one waiting pane resolver for a session, unregistering it.
 * @param sessionId - the session.
 * @returns the resolver, or undefined.
 */
function firstPoller(sessionId) {
  const set = pollers.get(sessionId);
  if (set === undefined || set.size === 0) return undefined;
  const [first] = set;
  set.delete(first);
  if (set.size === 0) pollers.delete(sessionId);
  return first;
}

/**
 * Ask a pane to render one page and wait for the JPEG.
 *
 * The promise settles exactly once: on the image, on either deadline, or when
 * the calling tool is cancelled. Job bookkeeping is removed on every path,
 * because a leaked entry would be a page number a later call could take for its
 * own.
 * @param sessionId - the session whose pane should render.
 * @param request - `{ pageNumber, docId }`.
 * @param options - `{ signal }` from the tool call.
 * @returns the `data:image/jpeg;base64,…` string.
 */
export function requestPageImage(sessionId, request, options = {}) {
  const pageNumber = Number(request?.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return Promise.reject(new Error("page must be a positive integer"));
  }
  const pending = queue.get(sessionId) ?? [];
  if (pending.length >= MAX_JOBS_PER_SESSION) {
    return Promise.reject(new Error("too many page renders are already waiting for the reader"));
  }
  const id = `job-${nextJobId}`;
  nextJobId += 1;
  const job = {
    id,
    pageNumber,
    docId: typeof request?.docId === "string" ? request.docId : "",
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let claimTimer;
    let imageTimer;
    const settle = (error, dataUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(claimTimer);
      clearTimeout(imageTimer);
      jobs.delete(id);
      const remaining = queue.get(sessionId);
      if (remaining !== undefined) {
        const at = remaining.indexOf(id);
        if (at !== -1) remaining.splice(at, 1);
        if (remaining.length === 0) queue.delete(sessionId);
      }
      options.signal?.removeEventListener?.("abort", onAbort);
      if (error === undefined) resolve({ dataUrl });
      else reject(error);
    };
    const onAbort = () => settle(new Error("cancelled"));
    if (options.signal?.aborted === true) {
      settle(new Error("cancelled"));
      return;
    }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    const entry = {
      job,
      sessionId,
      taken: false,
      settle,
      clearClaim: () => clearTimeout(claimTimer),
      startImageDeadline: () => {
        imageTimer = setTimeout(
          () => settle(new Error("the reader did not return the rendered page in time")),
          IMAGE_TIMEOUT_MS,
        );
        imageTimer.unref?.();
      },
    };
    jobs.set(id, entry);
    const list = queue.get(sessionId) ?? [];
    list.push(id);
    queue.set(sessionId, list);
    if (handOff(sessionId, undefined)) return;
    // A pane that has never asked for work is probably not there — but the first
    // poll takes a moment to arrive, so this waits briefly instead of deciding
    // from a snapshot. The error is tagged so the calling tool can offer the
    // page's text rather than an exception: the caller wanted a picture, and
    // what it can do instead depends on why there is none.
    claimTimer = setTimeout(
      () => {
        const absent = new Error("no PDF pane is open for this session, so no page can be drawn");
        absent.code = "no-pane";
        settle(absent);
      },
      activePanes.has(sessionId) ? CLAIM_TIMEOUT_MS : PANE_ABSENT_MS,
    );
    claimTimer.unref?.();
  });
}

/**
 * Take one job for a pane, waiting briefly when there is none.
 *
 * This is the request the pane holds open. It always answers — with a job or
 * with null — because a request that never answered would pin a connection on
 * every quiet session.
 * @param sessionId - the polling session.
 * @param signal - aborted when the pane goes away.
 * @returns the job to perform, or null.
 */
export function takeWork(sessionId, signal) {
  if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve(null);
  // A request to do work is the proof a pane exists for this session.
  activePanes.add(sessionId);
  const handed = [];
  handOff(sessionId, (job) => handed.push(job));
  if (handed.length > 0) return Promise.resolve(handed[0]);
  if (signal?.aborted === true) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (work) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = pollers.get(sessionId);
      if (set !== undefined) {
        set.delete(done);
        if (set.size === 0) pollers.delete(sessionId);
      }
      signal?.removeEventListener?.("abort", onAbort);
      resolve(work);
    };
    const onAbort = () => done(null);
    const timer = setTimeout(() => done(null), WORK_WAIT_MS);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const set = pollers.get(sessionId) ?? new Set();
    set.add(done);
    pollers.set(sessionId, set);
  });
}

/**
 * Accept a rendered page from the pane.
 * @param sessionId - the session reporting; a job from another session is refused.
 * @param jobId - the job the pane was given.
 * @param dataUrl - `data:image/jpeg;base64,…`.
 * @returns true when a waiting tool took it.
 */
export function deliverImage(sessionId, jobId, dataUrl) {
  const entry = jobs.get(typeof jobId === "string" ? jobId : "");
  if (entry === undefined || entry.sessionId !== sessionId) return false;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return false;
  entry.settle(undefined, dataUrl);
  return true;
}

/**
 * Refuse one job the pane was given.
 *
 * A pane that is open but cannot serve a job — it is showing a different
 * document, or the page failed to render — says so instead of staying silent.
 * Silence would leave the tool waiting for its deadline, which reads to the
 * model as "the reader is slow" rather than "that page is not here".
 * @param sessionId - the session reporting.
 * @param jobId - the job the pane was given.
 * @param reason - what to tell the tool.
 * @returns true when a waiting tool took the refusal.
 */
export function failImage(sessionId, jobId, reason) {
  const entry = jobs.get(typeof jobId === "string" ? jobId : "");
  if (entry === undefined || entry.sessionId !== sessionId) return false;
  const message = typeof reason === "string" && reason.trim() !== ""
    ? reason.trim()
    : "the reader could not render that page";
  entry.settle(new Error(message));
  return true;
}

/**
 * Fail every job and close every waiter for one session.
 *
 * Called when a session's pane goes away: a closed pane must not leave a tool
 * waiting on a promise nobody can settle.
 * @param sessionId - the session going away.
 */
export function releaseSession(sessionId) {
  queue.delete(sessionId);
  activePanes.delete(sessionId);
  for (const [id, entry] of jobs) {
    if (entry.sessionId !== sessionId) continue;
    entry.settle(new Error("the document pane was closed"));
    jobs.delete(id);
  }
  const set = pollers.get(sessionId);
  if (set === undefined) return;
  pollers.delete(sessionId);
  for (const done of set) done(null);
}

/** Test seam: forget every waiter, job and poller. */
export function resetBridge() {
  for (const [, entry] of jobs) entry.settle(new Error("reset"));
  jobs.clear();
  for (const [, set] of pollers) for (const done of set) done(null);
  pollers.clear();
  queue.clear();
  activePanes.clear();
  nextJobId = 1;
}

/** Test seam: how many jobs are tracked, in any state. */
export function jobCount() {
  return jobs.size;
}
