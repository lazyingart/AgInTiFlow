import { types } from "node:util";
import { admitResponsesOutput } from "./restricted-openai-responses.js";
import { parseNativeToolArguments } from "./native-tool-arguments.js";
import { findTextToolProtocol } from "./text-tool-turn.js";

// Opaque reasoning belongs only to the current client/session/model. After a
// restart, replay completed local call/result pairs as fresh stateless input.
// Never persist a provider frame or manufacture a result for an orphan call.
const activeFrames = new WeakMap();
const identifier = /^[A-Za-z0-9_-]{1,80}(?![\s\S])/u;
const functionName = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/u;
function invalid() {
  throw Object.assign(new Error("Invalid native OpenAI Responses conversation."), { code: "MODEL_TURN_INVALID", status: 422 });
}

function compileHistory(messages, frames) {
  const input = [], seen = new Set(), pending = new Map();
  for (const m of messages) {
    if (m.role === "tool") {
      if (!pending.has(m.tool_call_id) || (m.name != null && m.name !== pending.get(m.tool_call_id)) ||
          typeof m.content !== "string") invalid();
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
      pending.delete(m.tool_call_id);
      continue;
    }
    if (pending.size || !["assistant", "user", "system", "developer"].includes(m.role) || m.function_call) invalid();
    const calls = m.tool_calls ?? [];
    if (!Array.isArray(calls) || (calls.length && m.role !== "assistant")) invalid();
    if (!calls.length || m.content) {
      if (typeof m.content !== "string") invalid();
      input.push({ role: m.role === "system" ? "developer" : m.role, content: m.content });
    }
    for (const call of calls) {
      const fn = call.function;
      if (call.type !== "function" || typeof call.id !== "string" || !identifier.test(call.id) || seen.has(call.id) ||
          typeof fn?.name !== "string" || !functionName.test(fn.name)) invalid();
      const args = parseNativeToolArguments(fn.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) invalid();
      const frame = frames.get(call.id);
      if (frame) {
        if (frame.name !== fn.name || frame.argumentsJson !== JSON.stringify(args)) invalid();
        input.push(...frame.items);
      } else {
        input.push({ type: "function_call", call_id: call.id, name: fn.name, arguments: fn.arguments });
      }
      seen.add(call.id);
      pending.set(call.id, fn.name);
    }
  }
  if (pending.size) invalid();
  return { input, seen };
}

export async function requestNativeOpenAIResponses(client, body, options, sessionId) {
  if (!Array.isArray(body.messages) || (body.tools != null && !Array.isArray(body.tools)) ||
      body.functions != null || body.function_call != null || body.parallel_tool_calls === true) invalid();
  const scoped = typeof sessionId === "string" && sessionId.length > 0;
  let cache = scoped ? activeFrames.get(client) : null;
  if (!cache || cache.sessionId !== sessionId || cache.model !== body.model) {
    cache = { sessionId, model: body.model, frames: new Map() };
    if (scoped) activeFrames.set(client, cache);
  }
  const { input, seen } = compileHistory(body.messages, cache.frames);
  const names = new Set();
  const tools = (body.tools ?? []).map(tool => {
    const fn = tool.function;
    if (tool.type !== "function" || typeof fn?.name !== "string" || !functionName.test(fn.name) ||
        names.has(fn.name) || fn.parameters?.type !== "object") invalid();
    names.add(fn.name);
    return { type: "function", name: fn.name, description: fn.description, parameters: fn.parameters, strict: false };
  });
  let choice = body.tool_choice ?? (tools.length ? "auto" : "none");
  if (typeof choice === "object" && choice?.type === "function" && names.has(choice.function?.name)) {
    choice = { type: "function", name: choice.function.name };
  } else if (!["auto", "required", "none"].includes(choice) || (!tools.length && choice !== "none")) invalid();
  const budget = body.max_tokens ?? body.max_completion_tokens ?? 4096;
  if (!Number.isSafeInteger(budget) || budget < 1 || (body.max_completion_tokens != null && body.max_completion_tokens !== budget)) invalid();
  if (body.response_format && body.response_format.type !== "json_object") invalid();
  const wire = { model: body.model, input, store: false, stream: false, max_output_tokens: budget,
    include: ["reasoning.encrypted_content"],
    ...(body.reasoning_effort && { reasoning: { effort: body.reasoning_effort } }),
    ...(body.response_format && { text: { format: { type: "json_object" } } }),
    ...(tools.length && { tools, parallel_tool_calls: false, tool_choice: choice }) };
  const raw = await client.responses.create(wire, { ...options, maxRetries: 0 });
  options.signal.throwIfAborted();
  const { turn, frame } = admitResponsesOutput(raw, tools, body.model);
  let message;
  if (frame) {
    const [call] = turn.calls;
    if (frame.items.at(-1).status !== "completed" || choice === "none" || (typeof choice === "object" && choice.name !== call.name) ||
        seen.has(call.id) || cache.frames.has(call.id) || !call.arguments ||
        typeof call.arguments !== "object" || Array.isArray(call.arguments)) invalid();
    // Keep a bounded live suffix. Older completed pairs always retain their
    // native result in the local conversation, including across compaction.
    if (cache.frames.size >= 16) cache.frames.delete(cache.frames.keys().next().value);
    cache.frames.set(call.id, frame);
    message = { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function",
      function: { name: call.name, arguments: frame.items.at(-1).arguments } }] };
  } else {
    if (choice === "required" || typeof choice === "object" || findTextToolProtocol(turn.text)) invalid();
    message = { role: "assistant", content: turn.text };
  }
  const usage = admittedUsage(Object.getOwnPropertyDescriptor(raw, "usage")?.value);
  return { model: raw.model, choices: [{ index: 0, finish_reason: frame ? "tool_calls" : "stop", message }],
    ...(usage && { usage }) };
}

function admittedUsage(usage) {
  if (!usage || typeof usage !== "object" || types.isProxy(usage)) return null;
  const counts = ["input_tokens", "output_tokens", "total_tokens"].map(k => Object.getOwnPropertyDescriptor(usage, k)?.value);
  if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return { prompt_tokens: counts[0], completion_tokens: counts[1], total_tokens: counts[2] };
}
