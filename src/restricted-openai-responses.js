import { types } from "node:util";
import { dataFields, fail, jsonSnapshot, parseRestrictedJson } from "./restricted-application-contract.js";

const invalid = () => fail("PROVIDER_PROTOCOL_INVALID");
const idPattern = /^[A-Za-z0-9_-]{1,80}(?![\s\S])/u;
const id = value => typeof value === "string" && idPattern.test(value);
export const maxReplayBytes = 128 * 1024;

export function responsesTextRequest(request, model, frames) {
  const input = [];
  for (const message of request.messages) {
    if (message.role === "assistant" && message.calls) {
      if (message.calls.length !== 1) invalid();
      const [call] = message.calls, frame = frames.get(call.id);
      if (!frame || frame.name !== call.name || frame.argumentsJson !== JSON.stringify(call.arguments)) invalid();
      input.push(...frame.items);
    } else if (message.role === "tool") {
      if (frames.get(message.callId)?.name !== message.name) invalid();
      input.push({ type: "function_call_output", call_id: message.callId, output: JSON.stringify(message.value) });
    } else if (message.role === "system" && typeof message.content === "string") {
      input.push({ role: "developer", content: message.content });
    } else {
      if (!["user", "assistant"].includes(message.role) || !Array.isArray(message.content) ||
        message.content.some(part => part.type !== "text" || typeof part.text !== "string")) invalid();
      input.push({ role: message.role, content: message.content.map(part => part.text).join("\n") });
    }
  }
  const schema = request.outputSchema.type === "object" ? request.outputSchema :
    { type: "object", properties: { proposal: request.outputSchema }, required: ["proposal"], additionalProperties: false };
  return { model, input, store: false, stream: false, reasoning: { effort: "medium" }, include: ["reasoning.encrypted_content"],
    text: { format: { type: "json_schema", name: "application_proposal", strict: true, schema } },
    max_output_tokens: request.maxOutputTokens,
    ...(request.tools.length ? { parallel_tool_calls: false, tools: request.tools.map(tool => ({
      type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema,
      // Host schemas may have optional properties. AgInTi validates the whole
      // call against the original schema immediately before dispatch.
      strict: false,
    })) } : {}) };
}

export function admitResponsesTurn(raw, request, model) {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Object.getOwnPropertyDescriptor(raw, "then")) invalid();
  function field(name, required = true) {
    const d = Object.getOwnPropertyDescriptor(raw, name);
    if (!d && !required) return null;
    if (!d?.enumerable || !("value" in d)) invalid();
    return d.value;
  }
  const returned = field("model");
  if (typeof returned !== "string" || (returned !== model && !(returned.startsWith(model + "-") &&
    /^\d{4}-\d{2}-\d{2}$/u.test(returned.slice(model.length + 1)) && !/\s/u.test(returned)))) invalid();
  if (![null, false].includes(field("store", false)) || ![null, false].includes(field("background", false)) ||
      field("previous_response_id", false) !== null || field("object") !== "response" || field("status") !== "completed" || field("error", false) !== null ||
      field("incomplete_details", false) !== null) invalid();
  const output = jsonSnapshot(field("output"), { maxBytes: 256 * 1024 });
  if (!Array.isArray(output) || !output.length || output.length > 2) invalid();
  const items = [];
  if (output.length === 2) {
    const r = dataFields(output[0], ["id", "type", "encrypted_content", "summary", "status", "content"], ["id", "type", "summary"]);
    if (r.type !== "reasoning" || !id(r.id) || !Array.isArray(r.summary) || r.summary.length ||
        (r.encrypted_content != null && (typeof r.encrypted_content !== "string" || r.encrypted_content.length > maxReplayBytes)) ||
        (r.status != null && r.status !== "completed")) invalid();
    if (r.content != null && typeof r.content !== "string" && !(Array.isArray(r.content) &&
        r.content.every(part => part?.type === "reasoning_text" && typeof dataFields(part, ["type", "text"]).text === "string"))) invalid();
    if (output[1]?.type === "function_call") {
      if (!r.encrypted_content) invalid();
      items.push({ type: "reasoning", id: r.id, summary: [], encrypted_content: r.encrypted_content });
    }
  }
  const item = output.at(-1);
  if (item?.type === "function_call") {
    const call = dataFields(item, ["type", "id", "status", "name", "call_id", "arguments"], ["type", "id", "name", "call_id", "arguments"]);
    if (!id(call.id) || !id(call.call_id) || (call.status !== undefined && call.status !== "completed") ||
      !request.tools.some(tool => tool.name === call.name) || typeof call.arguments !== "string") invalid();
    const args = parseRestrictedJson(call.arguments);
    items.push(item);
    return { turn: { type: "tool_calls", calls: [{ id: call.call_id, name: call.name, arguments: args }] },
      frame: { items, name: call.name, argumentsJson: JSON.stringify(args) } };
  }
  const message = dataFields(item, ["type", "id", "status", "role", "content", "phase"], ["type", "id", "status", "role", "content"]);
  if (message.type !== "message" || !id(message.id) || message.status !== "completed" || message.role !== "assistant" ||
    (message.phase != null && message.phase !== "final_answer") || !Array.isArray(message.content) || message.content.length !== 1) invalid();
  const part = dataFields(message.content[0], ["type", "text", "annotations", "logprobs"], ["type", "text"]);
  if (part.type !== "output_text" || typeof part.text !== "string" ||
    (part.annotations != null && (!Array.isArray(part.annotations) || part.annotations.length)) ||
    (part.logprobs != null && (!Array.isArray(part.logprobs) || part.logprobs.length))) invalid();
  const value = parseRestrictedJson(part.text);
  if (request.outputSchema.type === "object") return { turn: { type: "final", value } };
  return { turn: { type: "final", value: dataFields(value, ["proposal"]).proposal } };
}
