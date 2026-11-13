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

/** What the model is told to do. Kept short — every token here is paid per call. */
const SYSTEM = [
  "You are a translation engine inside a PDF reader.",
  "Translate the text the user sends into {target}. Rules:",
  "1. Output only the translation — no preamble, no explanation, no quoting of the original.",
  "2. Keep paragraph breaks, list markers, numbers, units and formulas exactly as they are.",
  "3. Keep technical terms, product names and code identifiers in their original form.",
  "4. If the text is already in {target}, return it unchanged.",
].join("\n");

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

/**
 * Pick the language to translate into.
 *
 * No language picker: a reader who selected Chinese wants English and the other
 * way round, and guessing that from the characters is right far more often than
 * a setting nobody opens.
 * @param text - the selected passage.
 * @returns `Chinese` or `English`.
 */
export function targetLanguage(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const letters = (text.match(/[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  if (letters === 0) return "Chinese";
  return cjk / letters > 0.3 ? "English" : "Chinese";
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
    if (sessionId && typeof agents?.get === "function") agent = agents.get(String(sessionId));
    if (agent === undefined && typeof agents?.list === "function") agent = (agents.list() ?? [])[0];
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
async function ask(ctx, { provider, model, system, prompt, sessionId, maxTokens }) {
  const llm = service(ctx, "llm");
  if (typeof llm?.stream !== "function") return { ok: false, message: "这个 DSH 没有提供 llm 服务，翻译不可用" };
  // Two shapes: the message object the host builds, or the bare one some
  // providers accept. Trying the cheap one first keeps this file free of host
  // package imports.
  const attempts = [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "user", content: prompt },
  ];
  let lastError = "";
  for (const message of attempts) {
    let out = "";
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        system,
        messages: [message],
        ...(sessionId ? { sessionId: String(sessionId) } : {}),
        maxTokens,
        temperature: 0.1,
      })) {
        if (!chunk) continue;
        if (chunk.type === "text-delta") out += chunk.text;
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
 * @returns a JSON-ready result object.
 */
export async function translateSelection(ctx, input) {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (text === "") return { ok: false, message: "没有选中文字" };
  if (text.length > MAX_INPUT) return { ok: false, message: `选中内容太长（${text.length} 字），请分段翻译` };
  const model = pickModel(ctx, input?.sessionId);
  if (model === null) return { ok: false, message: "找不到这个会话正在用的模型" };
  const target = targetLanguage(text);
  const started = Date.now();
  const answer = await ask(ctx, {
    provider: model.provider,
    model: model.model,
    system: SYSTEM.replaceAll("{target}", target),
    prompt: text,
    sessionId: input?.sessionId,
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
 * @yields `{delta}` while the model talks, then one final result object.
 */
export async function* translateSelectionStream(ctx, input) {
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
  const target = targetLanguage(text);
  const started = Date.now();
  const attempts = [
    { role: "user", content: [{ type: "text", text }] },
    { role: "user", content: text },
  ];
  let lastError = "";
  for (const message of attempts) {
    let out = "";
    let spoke = false;
    try {
      for await (const chunk of llm.stream({
        provider: model.provider,
        model: model.model,
        system: SYSTEM.replaceAll("{target}", target),
        messages: [message],
        ...(input?.sessionId ? { sessionId: String(input.sessionId) } : {}),
        maxTokens: Math.min(4096, Math.max(512, Math.ceil(text.length * 1.6))),
        temperature: 0.1,
      })) {
        if (!chunk) continue;
        if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
          out += chunk.text;
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
