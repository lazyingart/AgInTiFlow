import { types, TextDecoder } from "node:util";
import {
  dataFields, jsonSnapshot, checkedSchema, matchesSchema, parseRestrictedJson,
  assertNoCredentials, integer, text, fail,
} from "./restricted-application-contract.js";

// Internal protocol prerequisite, deliberately not a package export or provider.
// No HTTP, credentials, CLI, configuration discovery, retry or fallback lives
// here. An accepting decoder is not authentication/isolation/backend admission.
const MAX_WIRE_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_EVENTS = 4096;
const NativeBytes = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeBytes.prototype);
const getByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const copyBytes = NativeBytes.prototype.set;
const FORM = "application_proposal";

function sameJson(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

function profile(options) {
  const value = dataFields(options, ["model", "reasoningEffort", "outputSchema"]);
  text(value.model, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/.test(value.model) ||
      !["none", "minimal", "low", "medium", "high", "xhigh"].includes(value.reasoningEffort)) fail();
  assertNoCredentials(value.model);
  const schema = checkedSchema(value.outputSchema);
  function strict(node) {
    if (node.anyOf) { node.anyOf.forEach(strict); return; }
    if (node.type === "object") {
      // Do not silently change optional fields into required fields. Responses'
      // strict schema dialect requires every object property to be required.
      if (node.required.length !== Object.keys(node.properties).length) fail();
      Object.values(node.properties).forEach(strict);
    } else if (node.type === "array") strict(node.items);
  }
  strict(schema);
  const wrapped = schema.type !== "object";
  const wireSchema = wrapped ? jsonSnapshot({ type: "object", properties: { proposal: schema }, required: ["proposal"], additionalProperties: false }) : schema;
  const format = jsonSnapshot({ type: "json_schema", name: FORM, strict: true, schema: wireSchema });
  return { model: value.model, effort: value.reasoningEffort, schema, wrapped, format };
}

export function buildRestrictedResponsesRequest(request, options) {
  const fixed = profile(options);
  const value = jsonSnapshot(request, { maxBytes: 2 * MAX_WIRE_BYTES });
  dataFields(value, ["schemaVersion", "messages", "tools", "outputSchema", "maxOutputTokens"]);
  if (value.schemaVersion !== "aginti-restricted-application-v1" || !sameJson(value.outputSchema, fixed.schema) ||
      !Array.isArray(value.tools) || value.tools.length !== 0 || !Array.isArray(value.messages) ||
      value.messages.length < 2 || value.messages.length > 26) fail();
  integer(value.maxOutputTokens, 1, 8192);
  const system = dataFields(value.messages[0], ["role", "content"]);
  if (system.role !== "system") fail();
  text(system.content, 128 * 1024);
  const input = value.messages.slice(1).map(message => {
    dataFields(message, ["role", "content"]);
    if (!["user", "assistant"].includes(message.role) || !Array.isArray(message.content) ||
        message.content.length < 1 || message.content.length > 16) fail();
    return { type: "message", role: message.role, content: message.content.map(part => {
      dataFields(part, ["type", "text"]);
      if (part.type !== "text") fail();
      text(part.text, 128 * 1024);
      // These are app-supplied EasyInputMessage records, not native output
      // items (which require their own identity/status/annotations/phase).
      return { type: "input_text", text: part.text };
    }) };
  });
  if (input.at(-1).role !== "user") fail();
  const body = jsonSnapshot({ model: fixed.model, reasoning: { effort: fixed.effort },
    instructions: system.content, input, tools: [], tool_choice: "none", store: false, stream: true,
    text: { format: fixed.format } }, { maxBytes: MAX_WIRE_BYTES });
  assertNoCredentials(body);
  // This route forbids max_output_tokens and server conversation continuation.
  // A future transport must separately bound wall time and received bytes; no
  // upstream token/cost ceiling or remote termination is claimed by this helper.
  return body;
}

export function createRestrictedResponsesDecoder(options) {
  const fixed = profile(options);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let wireBytes = 0, eventBytes = 0, textBytes = 0, sequence = 0;
  let lineParts = [], lineBytes = 0, eventName = null, data = [], responseId = null, createdAt = null;
  let valueText = "", textDone = false, partDone = false, completed = false, result = null, poison = null;
  const items = [];
  function clear() { lineParts = []; lineBytes = 0; eventName = null; data = []; valueText = ""; items.length = 0; }
  function reject(code = "PROVIDER_PROTOCOL_INVALID") { poison ??= code; result = null; clear(); fail(poison); }
  function require(condition) { if (!condition) reject(); }
  function check() { if (poison) fail(poison); }
  function fields(value, allowed, required = allowed) {
    try { return dataFields(value, allowed, required); } catch { reject(); }
  }
  function identifier(value, prefix) { require(typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,160}(?![\\s\\S])`).test(value)); }
  function response(value, status) {
    require(value && typeof value === "object" && !Array.isArray(value));
    for (const key of ["id", "object", "created_at", "status", "error", "incomplete_details", "model", "output", "tools", "tool_choice", "store", "reasoning", "text"])
      require(Object.hasOwn(value, key));
    identifier(value.id, "resp");
    require(value.object === "response" && value.model === fixed.model && value.status === status && value.error === null &&
      value.incomplete_details === null && value.store === false && value.tool_choice === "none" &&
      Array.isArray(value.tools) && value.tools.length === 0 && Array.isArray(value.output) &&
      Number.isSafeInteger(value.created_at) && value.created_at >= 0);
    require(value.reasoning && value.reasoning.effort === fixed.effort && value.text && sameJson(value.text.format, fixed.format));
    if (Object.hasOwn(value, "previous_response_id")) require(value.previous_response_id === null);
    if (Object.hasOwn(value, "conversation")) require(value.conversation === null);
    if (Object.hasOwn(value, "background")) require(value.background === false);
    if (responseId === null) { responseId = value.id; createdAt = value.created_at; }
    else require(value.id === responseId && value.created_at === createdAt);
  }
  function outputText(part, expected) {
    fields(part, ["type", "text", "annotations", "logprobs"], ["type", "text", "annotations"]);
    require(part.type === "output_text" && part.text === expected && Array.isArray(part.annotations) && part.annotations.length === 0);
    if (Object.hasOwn(part, "logprobs")) require(Array.isArray(part.logprobs) && part.logprobs.length === 0);
  }
  function phase(item) {
    if (Object.hasOwn(item, "phase")) require(item.phase === null || item.phase === "final_answer");
  }
  function itemAdded(value) {
    require(value.output_index === items.length && items.length < 9 && items.every(entry => entry.done));
    const item = value.item;
    require(item && typeof item === "object");
    identifier(item.id, item.type === "message" ? "msg" : "rs");
    require(!items.some(entry => entry.id === item.id));
    if (item.type === "reasoning") {
      fields(item, ["id", "type", "summary", "status"], ["id", "type", "summary"]);
      require(!items.some(entry => entry.type === "message") && Array.isArray(item.summary) && item.summary.length === 0);
      if (Object.hasOwn(item, "status")) require(item.status === "in_progress");
    } else {
      fields(item, ["id", "type", "status", "role", "content", "phase"], ["id", "type", "status", "role", "content"]);
      require(item.type === "message" && item.status === "in_progress" && item.role === "assistant" &&
        Array.isArray(item.content) && item.content.length === 0 && !items.some(entry => entry.type === "message"));
      phase(item);
    }
    items.push({ id: item.id, type: item.type, done: null, partAdded: false,
      phasePresent: Object.hasOwn(item, "phase"), phase: item.phase });
  }
  function current(value) {
    require(Number.isSafeInteger(value.output_index) && value.output_index >= 0);
    const item = items[value.output_index];
    require(item && item.id === value.item_id && item.type === "message" && !item.done && value.content_index === 0);
    return item;
  }
  function processEvent(event) {
    require(!completed && event && typeof event === "object" && !Array.isArray(event));
    require(event.type === eventName && event.sequence_number === sequence && sequence < MAX_EVENTS);
    sequence++;
    const base = ["type", "sequence_number"];
    if (event.type === "response.created" || event.type === "response.in_progress") {
      fields(event, [...base, "response"]);
      require(event.type === "response.created" ? sequence === 1 && responseId === null : responseId !== null && items.length === 0);
      response(event.response, "in_progress"); require(event.response.output.length === 0); return;
    }
    require(responseId !== null);
    if (event.type === "response.output_item.added") {
      fields(event, [...base, "output_index", "item"]); itemAdded(event); return;
    }
    if (event.type === "response.output_item.done") {
      fields(event, [...base, "output_index", "item"]);
      require(Number.isSafeInteger(event.output_index) && event.output_index >= 0);
      const entry = items[event.output_index], item = event.item;
      require(entry && !entry.done && item && item.id === entry.id && item.type === entry.type);
      if (entry.type === "message") {
        fields(item, ["id", "type", "status", "role", "content", "phase"], ["id", "type", "status", "role", "content"]);
        require(textDone && partDone && item.status === "completed" && item.role === "assistant" && Array.isArray(item.content) && item.content.length === 1);
        phase(item);
        if (entry.phasePresent) require(Object.hasOwn(item, "phase") && item.phase === entry.phase);
        outputText(item.content[0], valueText);
      } else {
        fields(item, ["id", "type", "summary", "status"], ["id", "type", "summary"]);
        require(Array.isArray(item.summary) && item.summary.length === 0);
        if (Object.hasOwn(item, "status")) require(item.status === "completed");
      }
      entry.done = item; return;
    }
    if (event.type === "response.content_part.added" || event.type === "response.content_part.done") {
      fields(event, [...base, "item_id", "output_index", "content_index", "part"]);
      const entry = current(event);
      if (event.type.endsWith("added")) {
        require(!entry.partAdded); outputText(event.part, ""); entry.partAdded = true;
      } else { require(entry.partAdded && textDone && !partDone); outputText(event.part, valueText); partDone = true; }
      return;
    }
    if (event.type === "response.output_text.delta" || event.type === "response.output_text.done") {
      const delta = event.type.endsWith("delta");
      const keys = [...base, "item_id", "output_index", "content_index", delta ? "delta" : "text"];
      fields(event, [...keys, "logprobs", "obfuscation"], keys);
      const entry = current(event); require(entry.partAdded && !textDone);
      if (Object.hasOwn(event, "logprobs")) require(Array.isArray(event.logprobs) && event.logprobs.length === 0);
      if (Object.hasOwn(event, "obfuscation")) require(typeof event.obfuscation === "string" && event.obfuscation.length <= 1024);
      if (delta) {
        require(typeof event.delta === "string"); textBytes += Buffer.byteLength(event.delta);
        require(textBytes <= MAX_TEXT_BYTES); valueText += event.delta;
      } else { require(event.text === valueText); textDone = true; }
      return;
    }
    if (event.type === "response.completed") {
      fields(event, [...base, "response"]); response(event.response, "completed");
      require(textDone && partDone && items.length > 0 && items.every(entry => entry.done) &&
        items.some(entry => entry.type === "message") && sameJson(event.response.output, items.map(entry => entry.done)));
      if (Object.hasOwn(event.response, "completed_at")) require(Number.isSafeInteger(event.response.completed_at) && event.response.completed_at >= createdAt);
      completed = true; return;
    }
    // Failed/incomplete/error, unknown events, refusal, hosted/local tools and
    // reasoning-summary data are not a successful no-tools JSON completion.
    reject();
  }
  function line(value, rawBytes) {
    eventBytes += rawBytes;
    require(eventBytes <= MAX_EVENT_BYTES);
    if (value === "") {
      if (data.length) {
        require(eventName !== null);
        let event; try { event = parseRestrictedJson(data.join("\n")); } catch { reject(); }
        processEvent(event);
      } else require(eventName === null);
      data = []; eventName = null; eventBytes = 0; return;
    }
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":"); require(separator > 0);
    const key = value.slice(0, separator);
    let field = value.slice(separator + 1); if (field.startsWith(" ")) field = field.slice(1);
    if (key === "event") { require(eventName === null && field.length > 0 && field.length <= 100); eventName = field; }
    else if (key === "data") data.push(field);
    else reject(); // No reconnect IDs/retry semantics or alternate protocol.
  }
  function partial(fragment) {
    if (!fragment) return;
    lineBytes += Buffer.byteLength(fragment);
    require(eventBytes + lineBytes <= MAX_EVENT_BYTES);
    // Merge only geometrically growing segments. Never repeatedly scan or
    // flatten the whole retained prefix when a peer delivers one byte at a time.
    while (lineParts.length && lineParts.at(-1).length <= fragment.length) fragment = lineParts.pop() + fragment;
    lineParts.push(fragment);
  }
  function accept(decoded) {
    require(!decoded.includes("\0") && !decoded.includes("\ufeff"));
    let end, offset = 0;
    while ((end = decoded.indexOf("\n", offset)) !== -1) {
      partial(decoded.slice(offset, end));
      let next = lineParts.join(""); const rawBytes = lineBytes + 1;
      lineParts = []; lineBytes = 0; offset = end + 1;
      if (next.endsWith("\r")) next = next.slice(0, -1);
      require(!next.includes("\r")); line(next, rawBytes);
    }
    partial(decoded.slice(offset));
  }
  function push(chunk) {
    check(); if (result) reject();
    try {
      require(!types.isProxy(chunk) && types.isUint8Array(chunk));
      require(!types.isSharedArrayBuffer(Reflect.apply(getBuffer, chunk, [])));
      const size = Reflect.apply(getByteLength, chunk, []);
      wireBytes += size; require(wireBytes <= MAX_WIRE_BYTES);
      const owned = new NativeBytes(size); Reflect.apply(copyBytes, owned, [chunk]);
      accept(decoder.decode(owned, { stream: true }));
    } catch { reject(); }
  }
  function finish() {
    check(); if (result) return result;
    try {
      accept(decoder.decode());
      require(completed && !lineParts.join("").trim() && data.length === 0 && eventName === null);
      const parsed = parseRestrictedJson(valueText);
      if (fixed.wrapped) {
        fields(parsed, ["proposal"]); require(matchesSchema(parsed.proposal, fixed.schema));
      } else require(matchesSchema(parsed, fixed.schema));
      assertNoCredentials(parsed);
      result = jsonSnapshot({ type: "final", value: fixed.wrapped ? parsed.proposal : parsed });
      clear(); return result;
    } catch { reject(); }
  }
  function cancel() { if (!result) { poison ??= "CANCELLED"; clear(); } }
  return Object.freeze({ push, finish, cancel });
}
