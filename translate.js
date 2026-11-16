import { classifyTranslationMode } from "./public/selection-text.mjs";

/**
 * Translate a passage on the model the user already configured in DSH.
 *
 * The point of this plugin is that a PDF pane should not ask anybody for an API
 * key: DSH already knows which provider and model the open session is using, so
 * the same route a chat turn would take is the one used here.
 *
 * Two deliberate choices:
 *
 * 1. Nothing from `@deepseek-ai/*` is imported at module scope. In the desktop
 *    profile those packages are optional peers (`autoInstallPeers: false`), so a
 *    top-level import can fail and take the whole plugin — the PDF preview
 *    included — down with it. The services are reached through `ctx.get()`
 *    instead, at request time, and every failure is reported to the bubble
 *    rather than thrown into startup.
 * 2. The model is resolved the way a chat turn resolves it: the session's own
 *    route first, then the agent's, then the global default.
 */

/** Longest passage the bubble will send; a selection is a sentence, not a chapter. */
export const MAX_INPUT = 6000;

/**
 * Drain an async iterable but stop waiting the moment `signal` aborts.
 *
 * The reader owns the request: closing the card aborts its fetch, and the Host
 * half has to stop consuming the model stream too. A plain `for await` waits
 * for the next chunk forever when the model stalls, holding the response and
 * the upstream call open. Racing each `next()` against the abort signal lets
 * the loop exit immediately; `iterator.return()` is fired without awaiting it
 * so a producer stuck inside its own `await` cannot hold this half hostage.
 * @param iterable - the upstream stream.
 * @param signal - cancellation signal, or undefined when there is none.
 * @yields the upstream chunks until the signal aborts.
 */
async function* cancellable(iterable, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  let onAbort;
  const aborted = new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve({ cancelled: true });
      return;
    }
    onAbort = () => resolve({ cancelled: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), aborted]);
      if (step?.cancelled === true || step.done === true) return;
      yield step.value;
    }
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    // Do not await: a producer blocked in its own await never finishes its
    // return(), and waiting here would re-create the leak this wrapper fixes.
    try {
      void iterator.return?.();
    } catch {
      /* the producer is gone; nothing to close */
    }
  }
}

/** Passage translation rules; kept short because every prompt token is paid per call. */
const PASSAGE_SYSTEM = [
  "You are a translation engine inside a PDF reader.",
  "Translate the text the user sends into {target}. Rules:",
  "1. Translate directly without extended deliberation; do not explain, analyze, or output reasoning. Output only the translation — no preamble or quoting of the original.",
  "2. Keep paragraph breaks, list markers, numbers, units and formulas exactly as they are.",
  "3. Keep technical terms, product names and code identifiers in their original form.",
  "4. If the text is already in {target}, return it unchanged.",
].join("\n");

const TERM_SYSTEM = [
  "You are a concise bilingual dictionary inside a PDF reader.",
  "Explain the selected term in {target} for a compact popup. Translate directly without extended deliberation; do not output reasoning.",
  "Include the headword (keep the original form when helpful), part of speech, 1–3 concise definitions, and 1–2 short example phrases or sentences.",
  "Do not use Markdown fences.",
].join("\n");

function buildTranslationSystem(text, target) {
  const template = classifyTranslationMode(text) === "term" ? TERM_SYSTEM : PASSAGE_SYSTEM;
  return template.replaceAll("{target}", target);
}

/**
 * Read one service without declaring it in `inject`.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or `undefined` when this build does not provide it.
 */
function service(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** Best-effort: use an explicit off mode only when model metadata confirms support. */
async function reasoningOptions(llm, provider, model) {
  if (typeof llm?.resolveModelInfo !== "function") return { options: {} };
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model);
  } catch {
    return { options: {} };
  }
  if (!info || typeof info !== "object" || info.reasoning === undefined) return { options: {} };
  const efforts = info.reasoning?.efforts;
  if (Array.isArray(efforts) && efforts.some((effort) => effort?.id === "off")) {
    return { options: { reasoningEffort: "off" } };
  }
  return { options: {} };
}

/**
 * Pick the language to translate into.
 *
 * Infer a target language from the selected text when the preference is set to
 * automatic. An explicit Chinese or English preference is applied by
 * `requestedTargetLanguage` before a request is sent.
 * @param text - the selected passage.
 * @returns `Chinese` or `English`.
 */
export function targetLanguage(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const letters = (text.match(/[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  if (letters === 0) return "Chinese";
  return cjk / letters > 0.3 ? "English" : "Chinese";
}

function requestedTargetLanguage(text, preference) {
  if (preference === "zh") return "Chinese";
  if (preference === "en") return "English";
  return targetLanguage(text);
}

/**
 * Find the provider/model the open session is talking to.
 * @param ctx - plugin context.
 * @param sessionId - session that owns the PDF tab, if known.
 * @returns `{provider, model, from}` or `null`.
 */
export function pickModel(ctx, sessionId) {
  const agents = service(ctx, "agents");
  let agent;
  try {
    // Only an agent for *this* session may supply its model. Falling back to
    // `agents.list()[0]` would borrow another session's provider/model (and
    // charge its route) whenever the PDF tab's own session has ended. When no
    // session id is known, the first live agent is still the best guess.
    if (sessionId && typeof agents?.get === "function") agent = agents.get(String(sessionId));
    else if (!sessionId && typeof agents?.list === "function") agent = (agents.list() ?? [])[0];
  } catch {
    agent = undefined;
  }
  if (agent) {
    try {
      const config = agent.session?.requestHeader?.()?.config;
      if (config?.provider && config?.model) {
        return { provider: config.provider, model: config.model, from: "session" };
      }
    } catch {
      /* a session without a route falls through */
    }
    try {
      const options = agent.options;
      if (options?.provider && options?.model) {
        return { provider: options.provider, model: options.model, from: "agent" };
      }
    } catch {
      /* same */
    }
  }
  try {
    const selected = service(ctx, "agentDefaultModel")?.currentSelection?.();
    if (selected?.provider && selected?.model) {
      return { provider: selected.provider, model: selected.model, from: "default" };
    }
  } catch {
    /* no default configured */
  }
  return null;
}

/**
 * Stream one answer and join it into text.
 * @param ctx - plugin context.
 * @param options - provider, model, prompts and limits.
 * @returns `{ok: true, text}` or `{ok: false, message}`.
 */
async function ask(ctx, { provider, model, system, prompt, sessionId, maxTokens, signal }) {
  const llm = service(ctx, "llm");
  if (typeof llm?.stream !== "function") return { ok: false, message: "这个 DSH 没有提供 llm 服务，翻译不可用" };
  const reasoning = await reasoningOptions(llm, provider, model);
  // Two shapes: the message object the host builds, or the bare one some
  // providers accept. Trying the cheap one first keeps this file free of host
  // package imports.
  const attempts = [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "user", content: prompt },
  ];
  let lastError = "";
  for (const message of attempts) {
    if (signal?.aborted === true) return { ok: false, message: "翻译已取消" };
    let out = "";
    try {
      for await (const chunk of cancellable(llm.stream({
        provider,
        model,
        system,
        messages: [message],
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
        ...(signal ? { signal } : {}),
        maxTokens,
        temperature: 0.1,
        ...reasoning.options,
      }), signal)) {
        if (!chunk) continue;
        // A malformed delta must not become the literal "undefined" or
        // "[object Object]" in the bubble (the streaming path guards this).
        if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") out += chunk.text;
        if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          const failure = chunk.reason.failure ?? {};
          return { ok: false, message: String(failure.message ?? failure.code ?? "模型返回了错误") };
        }
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
      continue;
    }
    const text = out.trim();
    if (text !== "") return { ok: true, text };
    lastError = "模型没有返回内容";
  }
  return { ok: false, message: lastError };
}

/**
 * Translate one selected passage.
 * @param ctx - plugin context.
 * @param input - `{text, sessionId}` from the viewer.
 * @param options - optional `{signal}` for the reader's cancellation.
 * @returns a JSON-ready result object.
 */
export async function translateSelection(ctx, input, options = {}) {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (text === "") return { ok: false, message: "没有选中文字" };
  if (text.length > MAX_INPUT) return { ok: false, message: `选中内容太长（${text.length} 字），请分段翻译` };
  const model = pickModel(ctx, input?.sessionId);
  if (model === null) return { ok: false, message: "找不到这个会话正在用的模型" };
  const target = requestedTargetLanguage(text, input?.targetLanguage);
  const started = Date.now();
  const answer = await ask(ctx, {
    provider: model.provider,
    model: model.model,
    system: buildTranslationSystem(text, target),
    prompt: text,
    sessionId: input?.sessionId,
    signal: options.signal,
    // Translated text runs longer than the source; the clamp keeps a long
    // selection from being cut off mid-sentence.
    maxTokens: Math.min(4096, Math.max(512, Math.ceil(text.length * 1.6))),
  });
  if (!answer.ok) return { ...answer, provider: model.provider, model: model.model };
  return {
    ok: true,
    text: answer.text,
    target,
    provider: model.provider,
    model: model.model,
    ms: Date.now() - started,
  };
}

/**
 * Translate one selected passage, handing out the answer as it arrives.
 *
 * The model is already streaming here — `ask` collects the chunks and returns
 * the joined string, which is why the bubble sat blank until the last token had
 * landed. This generator yields `{delta}` for every chunk and finishes with the
 * very object `translateSelection` would have returned, so the route can hand
 * each piece straight to the reader.
 * @param ctx - plugin context.
 * @param input - `{text, sessionId}` from the viewer.
 * @param options - optional `{signal}` for the reader's cancellation.
 * @yields `{delta}` while the model talks, then one final result object.
 */
export async function* translateSelectionStream(ctx, input, options = {}) {
  const signal = options.signal;
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (text === "") {
    yield { ok: false, message: "没有选中文字" };
    return;
  }
  if (text.length > MAX_INPUT) {
    yield { ok: false, message: `选中内容太长（${text.length} 字），请分段翻译` };
    return;
  }
  const model = pickModel(ctx, input?.sessionId);
  if (model === null) {
    yield { ok: false, message: "找不到这个会话正在用的模型" };
    return;
  }
  const llm = service(ctx, "llm");
  if (typeof llm?.stream !== "function") {
    yield { ok: false, message: "这个 DSH 没有提供 llm 服务，翻译不可用" };
    return;
  }
  const reasoning = await reasoningOptions(llm, model.provider, model.model);
  const target = requestedTargetLanguage(text, input?.targetLanguage);
  const started = Date.now();
  const attempts = [
    { role: "user", content: [{ type: "text", text }] },
    { role: "user", content: text },
  ];
  let lastError = "";
  for (const message of attempts) {
    if (signal?.aborted === true) return;
    let out = "";
    let spoke = false;
    try {
      for await (const chunk of cancellable(llm.stream({
        provider: model.provider,
        model: model.model,
        system: buildTranslationSystem(text, target),
        messages: [message],
        ...(input?.sessionId ? { sessionId: String(input.sessionId) } : {}),
        ...(signal ? { signal } : {}),
        maxTokens: Math.min(4096, Math.max(512, Math.ceil(text.length * 1.6))),
        temperature: 0.1,
        ...reasoning.options,
      }), signal)) {
        if (!chunk) continue;
        if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
          out += chunk.text;
          // Anything the reader has already seen counts as "spoke", even if a
          // later attempt would otherwise repeat it.
          spoke = true;
          yield { delta: chunk.text };
        }
        if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          const failure = chunk.reason.failure ?? {};
          yield {
            ok: false,
            message: String(failure.message ?? failure.code ?? "模型返回了错误"),
            provider: model.provider,
            model: model.model,
          };
          return;
        }
      }
    } catch (error) {
      // The second message shape is only worth trying if the first said nothing:
      // halfway through an answer, a retry would repeat what the reader saw.
      if (!spoke) {
        lastError = String(error?.message ?? error);
        continue;
      }
      yield { ok: false, message: String(error?.message ?? error), provider: model.provider, model: model.model };
      return;
    }
    const joined = out.trim();
    if (joined !== "") {
      yield {
        ok: true,
        text: joined,
        target,
        provider: model.provider,
        model: model.model,
        ms: Date.now() - started,
      };
      return;
    }
    lastError = "模型没有返回内容";
  }
  yield { ok: false, message: lastError, provider: model.provider, model: model.model };
}
