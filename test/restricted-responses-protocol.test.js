import assert from "node:assert/strict";
import test from "node:test";
import { buildRestrictedResponsesRequest, createRestrictedResponsesDecoder, restrictedResponsesFailure } from "../src/restricted-responses-protocol.js";

const schema = { type: "object", properties: { answer: { type: "string", maxLength: 100 } }, required: ["answer"], additionalProperties: false };
const options = { model: "host-selected-model", reasoningEffort: "low", outputSchema: schema };
const request = outputSchema => ({ schemaVersion: "aginti-restricted-application-v1", tools: [], outputSchema, maxOutputTokens: 256,
  messages: [{ role: "system", content: "Return an uncommitted JSON proposal from supplied text. No tools." },
    { role: "user", content: [{ type: "text", text: "just give a short answer please" }] }] });
const clone = value => JSON.parse(JSON.stringify(value));
const protocol = error => error.code === "PROVIDER_PROTOCOL_INVALID" && !String(error.message).includes("private");

function fixture(value = { answer: "你好 / hello / こんにちは 🙂" }, profile = options, reasoning = false) {
  const body = buildRestrictedResponsesRequest(request(profile.outputSchema), profile);
  const outputIndex = reasoning ? 1 : 0;
  const valueText = JSON.stringify(value), part = { type: "output_text", text: valueText, annotations: [], logprobs: [] };
  const message = { id: "msg_owned_1", type: "message", role: "assistant", status: "completed", content: [part] };
  const reason = { id: "rs_owned_1", type: "reasoning", summary: [] };
  const response = { id: "resp_owned_1", object: "response", model: profile.model, created_at: 1000, completed_at: null,
    status: "in_progress", error: null, incomplete_details: null, tools: [], tool_choice: "none", store: false,
    previous_response_id: null, reasoning: { effort: profile.reasoningEffort }, text: { format: body.text.format }, output: [] };
  const scope = { item_id: message.id, output_index: outputIndex, content_index: 0 };
  const events = [{ type: "response.created", response }, { type: "response.in_progress", response: clone(response) }];
  if (reasoning) events.push({ type: "response.output_item.added", output_index: 0, item: reason },
    { type: "response.output_item.done", output_index: 0, item: clone(reason) });
  events.push({ type: "response.output_item.added", output_index: outputIndex, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...scope, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...scope, delta: valueText, logprobs: [], obfuscation: "padding" },
    { type: "response.output_text.done", ...scope, text: valueText },
    { type: "response.content_part.done", ...scope, part: clone(part) },
    { type: "response.output_item.done", output_index: outputIndex, item: message },
    { type: "response.completed", response: { ...response, status: "completed", completed_at: 1001, output: reasoning ? [clone(reason), message] : [message] } });
  return clone(events.map((event, sequence_number) => ({ ...event, sequence_number })));
}
const encode = (events, newline = "\n") => Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("").replaceAll("\n", newline));
function decode(events, profile = options) { const decoder = createRestrictedResponsesDecoder(profile); decoder.push(encode(events)); return decoder.finish(); }
function rejected(events, profile = options) {
  const decoder = createRestrictedResponsesDecoder(profile);
  assert.throws(() => { decoder.push(encode(events)); decoder.finish(); }, protocol);
  assert.throws(() => decoder.finish(), protocol, "malformed input must permanently poison this decoder");
}
const at = (events, type) => events.find(event => event.type === type);

test("request is a fixed no-tools stateless streaming schema contract, with no ambient overrides", () => {
  const body = buildRestrictedResponsesRequest(request(schema), options);
  assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "reasoning", "store", "stream", "text", "tool_choice", "tools"]);
  assert.deepEqual([...body.tools], []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(body.instructions, request(schema).messages[0].content);
  assert.equal(body.input[0].type, "message"); assert.equal(body.input[0].role, "user"); assert.equal(body.input[0].content[0].type, "input_text");
  assert.ok(Object.isFrozen(body) && Object.isFrozen(body.input[0].content[0]) && Object.isFrozen(body.text.format.schema));
  for (const field of ["max_output_tokens", "previous_response_id", "conversation", "user", "metadata", "temperature", "apiKey", "baseURL"]) assert.equal(Object.hasOwn(body, field), false);
});

test("authorized assistant text history is explicit and contains no server continuation ID", () => {
  const raw = request(schema); raw.messages.splice(1, 0, { role: "user", content: [{ type: "text", text: "prior" }] },
    { role: "assistant", content: [{ type: "text", text: "prior answer" }] });
  const body = buildRestrictedResponsesRequest(raw, options);
  assert.equal(body.input[1].content[0].type, "input_text"); assert.equal(Object.hasOwn(body, "previous_response_id"), false);
  assert.equal(body.input[1].content[0].text, "prior answer");
});

test("caller/provider/tool/history/config escapes are rejected before any request exists", () => {
  for (const change of [raw => { raw.tools = [{ name: "shell" }]; }, raw => { raw.baseURL = "https://untrusted.invalid"; },
    raw => { raw.messages[1] = { role: "tool", content: [] }; }, raw => { raw.messages[1].calls = []; },
    raw => { raw.messages[1].content[0] = { type: "image", data: "bytes" }; }, raw => { raw.messages[0].role = "developer"; },
    raw => { raw.schemaVersion = "other"; }, raw => { raw.maxOutputTokens = 0; }, raw => { raw.messages[1].role = "assistant"; }]) {
    const raw = request(schema); change(raw); assert.throws(() => buildRestrictedResponsesRequest(raw, options));
  }
  for (const extra of ["fetch", "complete", "endpoint", "apiKey", "now"]) assert.throws(() => buildRestrictedResponsesRequest(request(schema), { ...options, [extra]: "forbidden" }));
});

test("unsupported optional schema fields are refused rather than silently made required", () => {
  const optional = { ...schema, required: [] };
  assert.throws(() => buildRestrictedResponsesRequest(request(optional), { ...options, outputSchema: optional }));
  assert.throws(() => createRestrictedResponsesDecoder({ ...options, outputSchema: optional }));
});

test("mutable configuration and input aliases cannot change issued request or decoder authority", () => {
  const mutable = clone(options), raw = request(schema);
  const body = buildRestrictedResponsesRequest(raw, mutable), decoder = createRestrictedResponsesDecoder(mutable);
  mutable.model = "substitute-model"; mutable.outputSchema.properties.answer.maxLength = 1;
  raw.messages[0].content = "substitute instructions"; raw.messages[1].content[0].text = "substitute task";
  assert.equal(body.model, options.model); assert.notEqual(body.instructions, raw.messages[0].content);
  assert.notEqual(body.input[0].content[0].text, raw.messages[1].content[0].text);
  decoder.push(encode(fixture())); assert.equal(decoder.finish().value.answer, "你好 / hello / こんにちは 🙂");
});

test("model and opaque IDs use an exact grammar without trailing-newline aliases", () => {
  for (const model of ["host-selected-model\n", "host-selected-model\r", " host-selected-model", "https://host.invalid/model"])
    assert.throws(() => createRestrictedResponsesDecoder({ ...options, model }));
  const response = fixture();
  for (const event of response) if (event.response) event.response.id += "\n";
  rejected(response);
  const item = fixture(); at(item, "response.output_item.added").item.id += "\n"; rejected(item);
});

test("complete byte-fragmented multilingual output is returned only after terminal plus EOF", () => {
  const events = fixture(), bytes = encode(events);
  for (const stride of [1, 2, 7, 1024, bytes.length]) {
    const decoder = createRestrictedResponsesDecoder(options);
    for (let offset = 0; offset < bytes.length; offset += stride) assert.equal(decoder.push(bytes.subarray(offset, offset + stride)), undefined);
    const final = decoder.finish(); assert.equal(final.value.answer, "你好 / hello / こんにちは 🙂");
    assert.equal(decoder.finish(), final); assert.ok(Object.isFrozen(final) && Object.isFrozen(final.value));
    assert.deepEqual(Object.keys(final).sort(), ["type", "value"]); assert.equal(final.type, "final");
    assert.throws(() => decoder.push(Buffer.from("\n")), protocol);
    assert.throws(() => decoder.finish(), protocol, "a late protocol write cannot replay the earlier cached result");
  }
});

test("CRLF, bounded heartbeat comments and empty reasoning items preserve the same proposal", () => {
  const decoder = createRestrictedResponsesDecoder(options);
  decoder.push(Buffer.from(": keepalive\r\n\r\n")); decoder.push(encode(fixture(undefined, options, true), "\r\n"));
  assert.equal(decoder.finish().value.answer, "你好 / hello / こんにちは 🙂");
});

test("one-byte fragmentation never rescans an already received long line", () => {
  const decoder = createRestrictedResponsesDecoder(options), original = String.prototype.indexOf;
  let calls = 0, scanned = 0;
  String.prototype.indexOf = function (search, ...rest) {
    if (search === "\n") { calls++; scanned += this.length; }
    return Reflect.apply(original, this, [search, ...rest]);
  };
  try {
    for (let index = 0; index < 4096; index++) decoder.push(Buffer.from(index === 0 ? ":" : "x"));
  } finally { String.prototype.indexOf = original; }
  assert.ok(calls >= 4096); assert.ok(scanned <= 8192, `rescanned ${scanned} characters for 4096 input bytes`);
  decoder.push(Buffer.from("\n\n")); decoder.push(encode(fixture()));
  assert.equal(decoder.finish().value.answer, "你好 / hello / こんにちは 🙂");
});

test("final-answer phase is allowed and bound; commentary cannot become a final proposal", () => {
  for (const value of [null, "final_answer"]) {
    const events = fixture();
    at(events, "response.output_item.added").item.phase = value;
    at(events, "response.output_item.done").item.phase = value;
    events.at(-1).response.output[0].phase = value;
    assert.equal(decode(events).value.answer, "你好 / hello / こんにちは 🙂");
  }
  for (const value of [false, "commentary", "unknown"]) {
    const events = fixture(); at(events, "response.output_item.added").item.phase = value; rejected(events);
  }
  const changed = fixture(); at(changed, "response.output_item.added").item.phase = "final_answer";
  at(changed, "response.output_item.done").item.phase = null; rejected(changed);
});

test("unfinished reasoning cannot overlap a later message item", () => {
  const events = fixture(undefined, options, true);
  events.splice(3, 1); events.forEach((event, index) => { event.sequence_number = index; });
  rejected(events);
});

for (const [name, outputSchema, value] of [["string", { type: "string", maxLength: 20 }, "hello"],
  ["array", { type: "array", items: { type: "boolean" }, maxItems: 2 }, [true]], ["null", { type: "null" }, null]]) {
  test(`non-object ${name} root preserves the exact closed proposal envelope`, () => {
    const p = { ...options, outputSchema }; assert.equal(buildRestrictedResponsesRequest(request(outputSchema), p).text.format.schema.type, "object");
    assert.deepEqual(JSON.parse(JSON.stringify(decode(fixture({ proposal: value }, p), p).value)), value);
    rejected(fixture({ proposal: value, extra: true }, p), p);
  });
}

const attacks = {
  "missing created event": events => events.shift(),
  "second created event": events => { events[1] = clone(events[0]); },
  "missing terminal": events => events.pop(),
  "gap": events => { events[3].sequence_number++; },
  "reorder": events => { [events[4], events[5]] = [events[5], events[4]]; },
  "duplicate sequence": events => { events[3].sequence_number = 2; },
  "foreign item": events => { at(events, "response.output_text.delta").item_id = "msg_foreign"; },
  "foreign response": events => { at(events, "response.completed").response.id = "resp_foreign"; },
  "response creation timestamp drift": events => { at(events, "response.completed").response.created_at++; },
  "completed before creation time": events => { at(events, "response.completed").response.completed_at = 999; },
  "different model": events => { events[0].response.model = "different-model"; },
  "different effort": events => { events[0].response.reasoning.effort = "high"; },
  "advertised tool": events => { events[0].response.tools = [{ type: "web_search" }]; },
  "non-none tool selection": events => { events[0].response.tool_choice = "auto"; },
  "server storage": events => { events[0].response.store = true; },
  "server continuation": events => { events[0].response.previous_response_id = "resp_stale"; },
  "server conversation": events => { events[0].response.conversation = "private"; },
  "background work": events => { events[0].response.background = true; },
  "schema substitution": events => { events[0].response.text.format.schema.required = []; },
  "explicit failed after deltas": events => { events.at(-1).type = "response.failed"; },
  "explicit incomplete after deltas": events => { events.at(-1).type = "response.incomplete"; },
  "message not completed": events => { at(events, "response.output_item.done").item.status = "in_progress"; },
  "delta/done mismatch": events => { at(events, "response.output_text.done").text = "private substituted answer"; },
  "part mismatch": events => { at(events, "response.content_part.done").part.text = "private"; },
  "item mismatch": events => { at(events, "response.output_item.done").item.content[0].text = "private"; },
  "completed output mismatch": events => { events.at(-1).response.output[0].content[0].text = "private"; },
  "tool output item": events => { at(events, "response.output_item.added").item.type = "function_call"; },
  "refusal": events => { at(events, "response.content_part.added").part.type = "refusal"; },
  "unknown event": events => { at(events, "response.output_text.delta").type = "response.future_tool.delta"; },
  "cross output index": events => { at(events, "response.output_text.delta").output_index = 2; },
  "nonzero content index": events => { at(events, "response.output_text.delta").content_index = 1; },
  "unexpected event field": events => { events[0].extra = "private"; },
  "missing mandatory error marker": events => { delete events[0].response.error; },
};
for (const [name, attack] of Object.entries(attacks)) test(`stream rejects ${name} without a partial proposal`, () => { const events = fixture(); attack(events); rejected(events); });

for (const marker of [false, 0, "", { code: "private" }]) test(`non-null error ${JSON.stringify(marker)} cannot be discarded`, () => {
  const events = fixture(); events.at(-1).response.error = marker; rejected(events);
});

for (const [name, body] of [["truncated frame", encode(fixture()).subarray(0, -1)],
  ["duplicate JSON key", Buffer.from('event: response.created\ndata: {"type":"response.created","type":"response.completed","sequence_number":0}\n\n')],
  ["invalid UTF-8", Buffer.from([0xff])], ["truncated UTF-8", Buffer.from([0xf0, 0x9f])],
  ["BOM", Buffer.from("\ufeff")], ["NUL", Buffer.from([0])],
  ["reconnect ID", Buffer.from("id: rerun\n\n")], ["retry hint", Buffer.from("retry: 1\n\n")],
  ["duplicate event field", Buffer.from("event: response.created\nevent: response.completed\ndata: {}\n\n")],
  ["bare CR", Buffer.from("event: response.created\rdata: {}\n\n")],
  ["plain protocol text", Buffer.from("private tool output\n\n")], ["Chat Completions DONE", Buffer.from("data: [DONE]\n\n")]]) {
  test(`framing rejects ${name} permanently`, () => {
    const decoder = createRestrictedResponsesDecoder(options);
    assert.throws(() => { decoder.push(body); decoder.finish(); }, protocol); assert.throws(() => decoder.finish(), protocol);
  });
}

test("event after a completed terminal poisons even previously valid output", () => {
  const decoder = createRestrictedResponsesDecoder(options); decoder.push(encode(fixture()));
  assert.throws(() => decoder.push(Buffer.from('event: error\ndata: {"type":"error","sequence_number":9}\n\n')), protocol);
  assert.throws(() => decoder.finish(), protocol);
});

test("result schema, credential strings and malformed JSON are not normalized into success", () => {
  rejected(fixture({ other: "not the schema" }));
  rejected(fixture({ answer: "sk-proj-" + "a".repeat(80) }));
  const events = fixture();
  for (const event of events) {
    if (event.delta) event.delta = "not JSON";
    if (event.type === "response.output_text.done") event.text = "not JSON";
    if (event.part?.text) event.part.text = "not JSON";
    if (event.item?.status === "completed") event.item.content[0].text = "not JSON";
  }
  events.at(-1).response.output[0].content[0].text = "not JSON"; rejected(events);
});

test("text, event, aggregate wire and event-count caps fail closed", () => {
  const events = fixture(); at(events, "response.output_text.delta").delta = "中".repeat(22_000); rejected(events);
  for (const body of [Buffer.from(": " + "x".repeat(256 * 1024)), Buffer.alloc(1024 * 1024 + 1, 32)]) {
    const decoder = createRestrictedResponsesDecoder(options); assert.throws(() => decoder.push(body), protocol);
  }
  const decoder = createRestrictedResponsesDecoder(options); decoder.push(encode(fixture().slice(0, 4)));
  const delta = at(fixture(), "response.output_text.delta"); delta.delta = "";
  delete delta.obfuscation; delete delta.logprobs;
  for (let i = 4; i < 4096; i++) { delta.sequence_number = i; decoder.push(encode([delta])); }
  delta.sequence_number = 4096;
  assert.throws(() => decoder.push(encode([delta])), protocol);
});

test("caller proxies/accessors/custom arrays never execute at configuration or byte boundaries", () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("private"); }, ownKeys() { traps++; throw Error("private"); }, getPrototypeOf() { traps++; throw Error("private"); } });
  const getter = { ...options }; Object.defineProperty(getter, "model", { get() { traps++; return options.model; }, enumerable: true });
  for (const value of [proxy, getter, { ...options, outputSchema: proxy }, { ...options, [Symbol()]: 1 }]) assert.throws(() => createRestrictedResponsesDecoder(value));
  const raw = request(schema); raw.messages = Array(2); assert.throws(() => buildRestrictedResponsesRequest(raw, options));
  const decoder = createRestrictedResponsesDecoder(options); assert.throws(() => decoder.push(proxy), protocol);
  assert.equal(traps, 0);
});

test("native byte snapshots ignore hostile metadata and reject shared mutable storage", () => {
  let hooks = 0;
  const chunk = new Uint8Array(encode(fixture())), decoder = createRestrictedResponsesDecoder(options);
  for (const key of ["buffer", "byteLength", "byteOffset", "then", Symbol.iterator])
    Object.defineProperty(chunk, key, { get() { hooks++; throw Error("private byte metadata"); } });
  decoder.push(chunk); chunk.fill(0);
  assert.equal(decoder.finish().value.answer, "你好 / hello / こんにちは 🙂"); assert.equal(hooks, 0);
  const shared = createRestrictedResponsesDecoder(options);
  assert.throws(() => shared.push(new Uint8Array(new SharedArrayBuffer(16))), protocol);
});

test("hidden and extended request arrays never execute JSON hooks", () => {
  let hooks = 0;
  for (const key of ["toJSON", "then", Symbol.iterator]) {
    const raw = request(schema);
    Object.defineProperty(raw.messages, key, { get() { hooks++; throw Error("private array metadata"); } });
    assert.throws(() => buildRestrictedResponsesRequest(raw, options));
  }
  assert.equal(hooks, 0);
});

test("cancellation and independent decoders do not leak a partially collected proposal", () => {
  const a = createRestrictedResponsesDecoder(options), b = createRestrictedResponsesDecoder(options);
  a.push(encode(fixture().slice(0, 5))); a.cancel(); a.cancel();
  assert.throws(() => a.finish(), error => error.code === "CANCELLED");
  assert.throws(() => a.push(encode(fixture())), error => error.code === "CANCELLED");
  b.push(encode(fixture({ answer: "independent" }))); assert.equal(b.finish().value.answer, "independent");
});

for (const [code, category] of [["subscription_sharing_usage_limit_exceeded", "quota"],
  ["subscription_sharing_usage_unavailable", "unavailable"], ["subscription_sharing_invalid_user", "authentication"],
  ["subscription_sharing_user_not_eligible", "permission"], ["rate_limit_exceeded", "rate_limit"],
  ["model_timeout", "timeout"], ["private-unknown-code", "protocol"]]) {
  test(`validated negative stream preserves only the closed ${category} category`, () => {
    const events = fixture().slice(0, 5), failed = clone(fixture().at(-1));
    failed.type = "response.failed"; failed.sequence_number = events.length;
    failed.response.status = "failed"; failed.response.error = { code, message: "private diagnostic" };
    events.push(failed); const decoder = createRestrictedResponsesDecoder(options);
    let caught;
    assert.throws(() => decoder.push(encode(events)), error => { caught = error; return error.code === "PROVIDER_FAILED"; });
    assert.deepEqual({ ...restrictedResponsesFailure(caught) }, { category, retryAfterMs: null });
    assert.equal(Object.isFrozen(restrictedResponsesFailure(caught)), true);
    assert.equal(JSON.stringify(caught).includes("private"), false);
    assert.throws(() => decoder.finish(), error => restrictedResponsesFailure(error)?.category === category);
  });
}

test("a forged error object or Proxy alias cannot issue native failure metadata", () => {
  let traps = 0; const fake = { code: "PROVIDER_FAILED", providerFailure: { category: "quota" } };
  assert.equal(restrictedResponsesFailure(fake), undefined);
  assert.equal(restrictedResponsesFailure(new Proxy(fake, { get() { traps++; throw Error("private"); } })), undefined);
  assert.equal(restrictedResponsesFailure("quota"), undefined); assert.equal(traps, 0);
});

test("malformed negative error envelopes cannot issue a trusted quota category", () => {
  for (const error of [{ code: "subscription_sharing_usage_limit_exceeded" },
    { code: "subscription_sharing_usage_limit_exceeded", message: false },
    { code: "subscription_sharing_usage_limit_exceeded", message: { detail: "private" } },
    { code: "subscription_sharing_usage_limit_exceeded", message: "private", param: {} },
    { code: "subscription_sharing_usage_limit_exceeded", message: "private", type: false }]) {
    const start = fixture()[0], failed = fixture().at(-1);
    failed.type = "response.failed"; failed.sequence_number = 1; failed.response.status = "failed"; failed.response.error = error;
    const decoder = createRestrictedResponsesDecoder(options);
    assert.throws(() => decoder.push(encode([start, failed])), cause => protocol(cause) && restrictedResponsesFailure(cause) === undefined);
  }
});
