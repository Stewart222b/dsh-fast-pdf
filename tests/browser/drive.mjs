// Drive the mounted-body harness: wait for the page to publish its facts, print
// them, and optionally save a screenshot.
//
// The exit code answers two different questions, and a report has to be able to
// tell them apart:
//   0   the scenario ran and reported nothing wrong
//   1   the scenario ran and reported an `ERROR=` line — a statement about the
//       plugin (or about the probe), never about the driver
//   14  the driver could not finish its own job — the debugging port never
//       opened, there was no page target, the socket went away, or a command got
//       no reply. `stderr` (and the `err:` line) says which:
//       `DRIVER_SOCKET_CLOSED` / `DRIVER_TIMEOUT` / `DRIVER_ERROR`.
//       A 14 is not a finding: rerun it. (Before this existed, a dead socket left
//       the top-level await for ever pending, so node exited 13 with an
//       `unsettled top-level await` warning that named no cause.)
const PROBE_FAILED = 1;
const DRIVER_FAILED = 14;
// A CDP reply arrives in milliseconds; 45 s means the browser is gone in a way
// the socket has not noticed yet (a killed process tree, a sleeping host).
const REPLY_TIMEOUT_MS = 45000;
const OPEN_TIMEOUT_MS = 15000;
// The debugging socket can also close while the browser is still starting: a
// socket opened against the just-listed page target gets dropped (1006) before
// anything has been measured. Reattaching is the honest fix — a fixed sleep
// would only make the race rarer, and this is measured, not guessed: attaching
// four seconds late never failed, attaching at once did, over and over.
const MAX_ATTACH_ATTEMPTS = 3;

class DriverError extends Error {
  constructor(kind, detail) {
    super(`${kind} ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Give up as a driver, saying why. The bare token goes to stderr — that is the
 * line a log reader greps — and the same failure goes out as an `err:` line,
 * which is the channel `run-scenario.ps1` prints even when the run produced a
 * `log:` line first.
 */
function failDriver(kind, detail) {
  console.error(kind);
  console.log(`err: ${kind} ${detail}`);
  process.exit(DRIVER_FAILED);
}

const port = Number(process.argv[2] ?? 0);
const outPath = process.argv[3] ?? "";
const timeoutMs = Number(process.argv[4] ?? 60000);

/**
 * Poll the debugging port until Edge has opened it and lists a page target, or
 * give up. Edge needs a few seconds — measured 3.3 s on this machine, longer
 * after another browser was just killed — and waiting here is what keeps a slow
 * start from looking like a broken scenario.
 */
async function waitForPageTarget(targetPort, waitMs) {
  const until = Date.now() + waitMs;
  let last = null;
  while (Date.now() < until) {
    let targets = null;
    try {
      targets = await (await fetch(`http://127.0.0.1:${targetPort}/json/list`)).json();
    } catch (error) {
      last = error;
    }
    if (targets !== null) {
      const page = targets.find((target) => target.type === "page");
      if (page !== undefined) return page;
      last = new Error(`only ${targets.map((target) => target.type).join(",") || "no"} targets`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  // Not `failDriver` here: whether a missing port is the whole story depends on
  // what happened before it, and `main` is the one that knows.
  throw new DriverError("DRIVER_NO_DEBUG_PORT",
    `no page target on the debugging port ${targetPort} after ${waitMs} ms (${last?.cause?.code ?? last})`);
}

/** One WebSocket to one target, with every command either answered or failed. */
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let next = 1;
  const waiting = new Map();
  // Set once the socket is unusable: every command from then on fails at once
  // instead of waiting for a reply that cannot come.
  let socketGone = null;

  const abandonWaiting = (reason) => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(new DriverError("DRIVER_SOCKET_CLOSED", `${reason} while ${entry.method}`));
    }
    waiting.clear();
  };

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (entry === undefined) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message.result ?? {});
  });
  ws.addEventListener("close", (event) => {
    socketGone = `the socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`;
    abandonWaiting(socketGone);
  });
  ws.addEventListener("error", () => {
    if (socketGone === null) socketGone = "the socket errored";
    abandonWaiting(socketGone);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DriverError("DRIVER_SOCKET_CLOSED", `the socket never opened in ${OPEN_TIMEOUT_MS} ms`)),
      OPEN_TIMEOUT_MS,
    );
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new DriverError("DRIVER_SOCKET_CLOSED", `the socket refused to open (${target.url})`));
    }, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socketGone !== null) {
      reject(new DriverError("DRIVER_SOCKET_CLOSED", `${socketGone} before ${method}`));
      return;
    }
    const id = next++;
    // A reply that never comes is the same failure as a closed socket, only
    // slower: without this timer the await stays pending for ever and node
    // reports an unsettled top-level await instead of a reason.
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new DriverError("DRIVER_TIMEOUT", `${method} got no reply in ${REPLY_TIMEOUT_MS} ms`));
    }, REPLY_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer, method });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(new DriverError("DRIVER_SOCKET_CLOSED",
        `${method} could not be sent: ${String(error?.message ?? error)}`));
    }
  });

  const evaluate = async (expression) => {
    const answer = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return answer.result?.value;
  };

  return { send, evaluate, close: () => { try { ws.close(); } catch { /* already gone */ } } };
}

const main = async () => {
  const deadline = Date.now() + timeoutMs;
  let session = null;
  let facts = null;
  // Why the last socket died, if one did: when the browser is killed the port
  // disappears too, and "no page target" alone would hide what really happened.
  let lastClose = null;

  for (let attempt = 1; facts === null && Date.now() < deadline; attempt += 1) {
    let target;
    try {
      target = await waitForPageTarget(port, attempt === 1 ? 30000 : 10000);
    } catch (error) {
      if (lastClose !== null && error instanceof DriverError) {
        throw new DriverError("DRIVER_SOCKET_CLOSED",
          `${lastClose}; the browser did not come back (${error.detail})`);
      }
      throw error;
    }
    session?.close();
    try {
      session = await attach(target);
      // Nothing has been measured until the first answer comes back, so a
      // second socket cannot produce a second, different reading of the probe.
      const first = await session.evaluate("document.title");
      if (typeof first === "string" && first.startsWith("ready")) {
        facts = await session.evaluate("JSON.stringify(window.__facts ?? null)");
      }
      while (facts === null && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 300));
        const title = await session.evaluate("document.title");
        if (typeof title === "string" && title.startsWith("ready")) {
          facts = await session.evaluate("JSON.stringify(window.__facts ?? null)");
        }
      }
    } catch (error) {
      if (error instanceof DriverError && error.kind === "DRIVER_SOCKET_CLOSED") lastClose = error.detail;
      const retriable = error instanceof DriverError
        && error.kind === "DRIVER_SOCKET_CLOSED"
        && attempt < MAX_ATTACH_ATTEMPTS
        && Date.now() < deadline;
      if (!retriable) throw error;
      console.error(`reattaching: ${error.message}`);
    }
  }

  if (facts === null) {
    // The page answered, it just never published its facts: a statement about
    // the scenario (or about the harness boot), so it stays exit 1.
    const title = await session.evaluate("document.title");
    console.log(`log: timed out after ${timeoutMs} ms (title=${title})`);
    session.close();
    process.exit(PROBE_FAILED);
  }

  const list = JSON.parse(facts);
  console.log(`log: ${list.filter((line) => !line.startsWith("ERROR=")).join(" ")}`);
  const errors = list.filter((line) => line.startsWith("ERROR="));
  for (const error of errors) console.log(`err: ${error}`);

  if (outPath !== "") {
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    console.log(`saved ${outPath}`);
  }
  session.close();
  process.exit(errors.length === 0 ? 0 : PROBE_FAILED);
};

try {
  await main();
} catch (error) {
  if (error instanceof DriverError) failDriver(error.kind, error.detail);
  // Anything else is the driver's own bug — still not a statement about the
  // plugin, so it takes the driver code and says so.
  failDriver("DRIVER_ERROR", String(error?.stack ?? error).replace(/\s+/gu, " ").slice(0, 400));
}
