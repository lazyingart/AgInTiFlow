import assert from "node:assert/strict";
import test from "node:test";
import { createRestrictedApplicationRunner, createRestrictedOpenAIProvider } from "../src/restricted-application.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 2000 };
const schema = object({ reply: string });
const input = { input: [{ type: "text", text: "Inspect the authorized record and propose a correction." }] };
const final = (content, extra = {}) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content, ...extra } }] });
const adapter = complete => createRestrictedOpenAIProvider({ model: "offline-fixture", supportsImages: false, complete });
const run = raw => createRestrictedApplicationRunner({ provider: adapter(async () => raw), instructions: "Uncommitted proposal only.", tools: [], outputSchema: schema }).run(input);
const decode = raw => adapter(async () => raw).complete({ messages: [], tools: [], outputSchema: schema, maxOutputTokens: 128 }, { signal: new AbortController().signal });

test("duplicate decoded JSON keys reject at every nesting level", async () => {
  for (const value of [
    '{"reply":"discarded","reply":"accepted"}',
    String.raw`{"reply":"discarded","r\u0065ply":"accepted"}`,
    '{"reply":{"text":"discarded","text":"accepted"}}',
    '{"items":[{"text":"discarded","text":"accepted"}]}',
  ]) {
    await assert.rejects(decode(final(value)), { name: "RestrictedApplicationError", code: "PROVIDER_PROTOCOL_INVALID" });
  }
});

test("duplicate call arguments reject the entire batch before any read", async () => {
  let reads = 0, requests = 0;
  const call = (id, args) => ({ id, type: "function", function: { name: "record_search", arguments: args } });
  const provider = adapter(async () => ++requests === 1
    ? { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      call("first", '{"query":"valid"}'), call("second", '{"query":"discarded","query":"accepted"}'),
    ] } }] }
    : final('{"reply":"done"}'));
  const runner = createRestrictedApplicationRunner({ provider, instructions: "Read only scoped records.", outputSchema: schema, tools: [{
    name: "record_search", description: "Account-bound read only.", readOnly: true,
    inputSchema: object({ query: string }), outputSchema: object({ text: string }),
    execute: async () => { reads++; return { text: "authorized" }; },
  }] });
  await assert.rejects(runner.run(input), { code: "PROVIDER_FAILED" });
  assert.equal(reads, 0);
  assert.equal(requests, 1);
});

test("legacy function-call metadata cannot accompany a successful final answer", async () => {
  for (const value of [{ name: "undeclared", arguments: "{}" }, {}, false, 0, []]) {
    await assert.rejects(run(final('{"reply":"valid JSON"}', { function_call: value })), { code: "PROVIDER_FAILED" });
  }
});

test("non-array native tool metadata is rejected even when falsey", async () => {
  for (const value of [{}, false, 0, ""]) {
    await assert.rejects(run(final('{"reply":"valid JSON"}', { tool_calls: value })), { code: "PROVIDER_FAILED" });
  }
});

test("malformed refusal metadata cannot masquerade as a completed answer", async () => {
  for (const value of [false, 0, {}, []]) {
    await assert.rejects(run(final('{"reply":"valid JSON"}', { refusal: value })), { code: "PROVIDER_FAILED" });
  }
});

test("direct adapter parse errors are stable and contain no raw response text", async () => {
  for (const content of ['{"reply":"PRIVATE_RESPONSE_SENTINEL",}', '{"reply":"PRIVATE_RESPONSE_SENTINEL"', '{} trailing PRIVATE_RESPONSE_SENTINEL']) {
    await assert.rejects(decode(final(content)), error => {
      assert.equal(error.name, "RestrictedApplicationError");
      assert.equal(error.code, "PROVIDER_PROTOCOL_INVALID");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /PRIVATE_RESPONSE_SENTINEL/);
      return true;
    });
  }
});

test("valid Unicode, escapes, repeated values and neutral native metadata remain compatible", async () => {
  const value = { reply: '中文・日本語・English 👩🏽‍💻\n"quotes" \\ slash/', items: [{ id: 1, label: "same" }, { id: 2, label: "same" }], numbers: [0, -3.25, 1.2e3], flags: [true, false, null] };
  assert.deepEqual(JSON.parse(JSON.stringify((await decode(final(JSON.stringify(value)))).value)), value);
  for (const extra of [{}, { function_call: null }, { tool_calls: null }, { tool_calls: [] }, { refusal: null }, { refusal: "" }]) {
    assert.equal((await run(final('{"reply":"compatible"}', extra))).proposal.reply, "compatible");
  }
});

test("existing newline identifier guards remain closed without widening the contract", async () => {
  assert.throws(() => createRestrictedOpenAIProvider({ model: "fixture\n", supportsImages: false, complete: async () => final('{"reply":"ok"}') }), { code: "INVALID_CONTRACT" });
  let reads = 0;
  const provider = adapter(async () => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "call-1\n", type: "function", function: { name: "record_search", arguments: '{"query":"draft"}' } }],
  } }] }));
  const runner = createRestrictedApplicationRunner({ provider, instructions: "Read scoped data.", outputSchema: schema, tools: [{
    name: "record_search", description: "Read only.", readOnly: true,
    inputSchema: object({ query: string }), outputSchema: object({ text: string }),
    execute: async () => { reads++; return { text: "authorized" }; },
  }] });
  await assert.rejects(runner.run(input), { code: "TOOL_CALL_INVALID" });
  assert.equal(reads, 0);
});

test("direct adapter JSON parsing is bounded by depth, node count and UTF-8 bytes", async () => {
  const deep = "[".repeat(34) + "0" + "]".repeat(34);
  const nodes = JSON.stringify(Array(20001).fill(0));
  for (const content of [deep, nodes, JSON.stringify({ reply: "汉".repeat(100000) })]) {
    await assert.rejects(decode(final(content)), { name: "RestrictedApplicationError", code: "DATA_LIMIT" });
  }
});
