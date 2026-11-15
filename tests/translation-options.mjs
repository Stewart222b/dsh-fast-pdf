import assert from "node:assert/strict";
import { translateSelection, translateSelectionStream } from "../translate.js";
import { classifyTranslationMode } from "../public/selection-text.mjs";

const sessionConfig = { provider: "p-session", model: "m-session", reasoningEffort: "high" };
function context(llm) {
  return {
    get(name) {
      if (name === "llm") return llm;
      if (name === "agents") return { get: () => ({ session: { requestHeader: () => ({ config: sessionConfig }) } }), list: () => [] };
      return undefined;
    },
  };
}
const textResult = async function* () { yield { type: "text-delta", text: "translation" }; };

assert.equal(classifyTranslationMode("network adapter"), "term");
assert.equal(classifyTranslationMode("network adapter."), "passage");
assert.equal(classifyTranslationMode("one two three four"), "passage");
assert.equal(classifyTranslationMode("short 中文短语"), "term");

{
  const requests = [];
  const llm = {
    async resolveModelInfo(provider, model) {
      assert.equal(provider, "p-session");
      assert.equal(model, "m-session");
      return { reasoning: { efforts: [{ id: "low" }, { id: "off" }, { id: "high" }] } };
    },
    stream(request) { requests.push(request); return textResult(); },
  };
  const result = await translateSelection(context(llm), { text: "hello", sessionId: "session-1" });
  assert.equal(result.ok, true);
  assert.equal(requests[0].reasoningEffort, "off");
  assert.equal(requests[0].provider, sessionConfig.provider);
  assert.equal(requests[0].model, sessionConfig.model);
  assert.equal(requests[0].sessionId, "session-1");
  assert.equal(sessionConfig.reasoningEffort, "high", "translation must not mutate session configuration");
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }] } }; },
    stream(request) { requests.push(request); return textResult(); },
  };
  const result = [];
  for await (const item of translateSelectionStream(context(llm), { text: "hello", sessionId: "session-1" })) result.push(item);
  assert.equal(result.at(-1).ok, true);
  assert.equal(requests[0].reasoningEffort, "off");
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "low" }, { id: "high" }] } }; },
    stream(request) { requests.push(request); return textResult(); },
  };
  const result = await translateSelection(context(llm), { text: "hello", sessionId: "session-1" });
  assert.equal(result.ok, true, "models without off support should still translate");
  assert.equal(requests.length, 1);
  assert.equal("reasoningEffort" in requests[0], false, "unsupported off must not be fabricated");
  assert.match(requests[0].system, /Translate directly/);
  assert.match(requests[0].system, /do not output reasoning/i);
  assert.equal(requests[0].reasoningEffort, undefined, "session high effort must not be copied");
}

{
  const requests = [];
  const llm = { async resolveModelInfo() { throw new Error("metadata unavailable"); }, stream(request) { requests.push(request); return textResult(); } };
  const result = await translateSelection(context(llm), { text: "hello", sessionId: "session-1" });
  assert.equal(result.ok, true, "metadata failures should retain compatibility");
  assert.equal(requests.length, 1);
  assert.equal("reasoningEffort" in requests[0], false);
  assert.match(requests[0].system, /Translate directly/);
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "low" }, { id: "high" }] } }; },
    stream(request) { requests.push(request); return textResult(); },
  };
  const result = [];
  for await (const item of translateSelectionStream(context(llm), { text: "hello", sessionId: "session-1" })) result.push(item);
  assert.equal(result.at(-1).ok, true, "streaming should continue if off is unsupported");
  assert.equal(requests.length, 1);
  assert.equal("reasoningEffort" in requests[0], false);
  assert.match(requests[0].system, /Translate directly/);
  assert.equal(requests[0].reasoningEffort, undefined);
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }] } }; },
    async *stream(request) {
      requests.push(request);
      if (request.messages[0].content instanceof Array) throw new Error("try bare message");
      yield { type: "text-delta", text: "fallback" };
    },
  };
  const result = await translateSelection(context(llm), { text: "hello", sessionId: "session-1" });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2, "message shape fallback remains available");
  assert.ok(requests.every((request) => request.reasoningEffort === "off"), "every fallback attempt must keep reasoning off");
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }] } }; },
    async *stream(request) {
      requests.push(request);
      if (request.messages[0].content instanceof Array) throw new Error("try bare message");
      yield { type: "text-delta", text: "stream fallback" };
    },
  };
  const result = [];
  for await (const item of translateSelectionStream(context(llm), { text: "hello", sessionId: "session-1" })) result.push(item);
  assert.equal(result.at(-1).ok, true);
  assert.equal(requests.length, 2, "streaming route should retain the message-shape fallback");
  assert.ok(requests.every((request) => request.reasoningEffort === "off"), "streaming fallback must keep reasoning off");
}

{
  const requests = [];
  const llm = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }] } }; },
    async *stream(request) {
      requests.push(request);
      yield { type: "finish", reason: { kind: "error", failure: { message: "provider rejected request" } } };
    },
  };
  const result = [];
  for await (const item of translateSelectionStream(context(llm), { text: "hello", sessionId: "session-1" })) result.push(item);
  assert.equal(result.length, 1, "finish error should stop without retrying with weaker options");
  assert.equal(result[0].ok, false);
  assert.match(result[0].message, /provider rejected request/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoningEffort, "off");
}

{
  const requests = [];
  const llm = { stream(request) { requests.push(request); return textResult(); } };
  const result = [];
  for await (const item of translateSelectionStream(context(llm), { text: "hello", sessionId: "session-1" })) result.push(item);
  assert.equal(result.at(-1).ok, true, "missing model metadata API should remain compatible");
  assert.equal(requests.length, 1);
  assert.equal("reasoningEffort" in requests[0], false);
}

{
  const llm = { async resolveModelInfo() { return {}; }, stream: textResult };
  const result = await translateSelection(context(llm), { text: "hello", sessionId: "session-1" });
  assert.equal(result.ok, true, "models without configurable reasoning remain usable");
}

{
  const requests = [];
  const llm = { async resolveModelInfo() { return {}; }, stream(request) { requests.push(request); return textResult(); } };
  const term = await translateSelection(context(llm), { text: "network adapter", sessionId: "session-1" });
  const passage = await translateSelection(context(llm), { text: "The adapter connects the device to a network.", sessionId: "session-1" });
  assert.equal(term.ok, true);
  assert.equal(passage.ok, true);
  assert.match(requests[0].system, /concise bilingual dictionary/i);
  assert.match(requests[0].system, /headword/i);
  assert.match(requests[0].system, /part of speech/i);
  assert.match(requests[0].system, /1–3 concise definitions/i);
  assert.match(requests[0].system, /1–2 short example/i);
  assert.match(requests[0].system, /Markdown fences/i);
  assert.doesNotMatch(requests[0].system, /Keep paragraph breaks/);
  assert.match(requests[1].system, /Keep paragraph breaks/);
  assert.doesNotMatch(requests[1].system, /bilingual dictionary/i);
}

{
  const requests = [];
  const llm = { async resolveModelInfo() { return {}; }, stream(request) { requests.push(request); return textResult(); } };
  const chinese = await translateSelection(context(llm), { text: "This is a complete English sentence.", sessionId: "session-1", targetLanguage: "zh" });
  const english = await translateSelection(context(llm), { text: "这是一段完整的中文句子。", sessionId: "session-1", targetLanguage: "en" });
  const automatic = await translateSelection(context(llm), { text: "这是一段完整的中文句子。", sessionId: "session-1", targetLanguage: "auto" });
  assert.equal(chinese.target, "Chinese");
  assert.equal(english.target, "English");
  assert.equal(automatic.target, "English");
  assert.match(requests[0].system, /into Chinese/);
  assert.match(requests[1].system, /into English/);
}

{
  const requests = [];
  const llm = { async resolveModelInfo() { return {}; }, async *stream(request) { requests.push(request); yield { type: "text-delta", text: "译文" }; } };
  for await (const _item of translateSelectionStream(context(llm), { text: "Hello", sessionId: "session-1", targetLanguage: "zh" })) { /* consume */ }
  assert.match(requests[0].system, /in Chinese/);
}

{
  const requests = [];
  const llm = { async resolveModelInfo() { return {}; }, async *stream(request) { requests.push(request); yield { type: "text-delta", text: "translation" }; } };
  for (const text of ["中文短语", "The adapter connects the device to a network."]) {
    for await (const _item of translateSelectionStream(context(llm), { text, sessionId: "session-1" })) { /* consume */ }
  }
  assert.match(requests[0].system, /concise bilingual dictionary/i);
  assert.match(requests[0].system, /part of speech/i);
  assert.match(requests[1].system, /Keep paragraph breaks/);
  assert.doesNotMatch(requests[1].system, /bilingual dictionary/i);
}

console.log("translation reasoning options passed");
