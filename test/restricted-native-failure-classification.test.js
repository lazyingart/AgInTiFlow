import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { getEventListeners } from "node:events";
import test from "node:test";

const sdk = await import(process.env.AGINTI_TEST_SDK_ENTRY || new URL("../src/restricted-application.js", import.meta.url));
const schema = { type: "object", properties: { reply: { type: "string", maxLength: 80 } }, required: ["reply"], additionalProperties: false };
const request = { input: [{ type: "text", text: "Give a brief answer from the supplied note only." }] };
const final = (content = '{"reply":"observed"}', finish_reason = "stop") => ({ choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }] });
const call = (name = "read_current", args = "{}") => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "read_1", type: "function", function: { name, arguments: args } }] } }] });
const tool = execute => ({ name: "read_current", description: "Read the supplied authorized record.", readOnly: true, inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: { type: "string", maxLength: 80 }, execute });
const adapter = (kind, complete) => kind === "deepseek" ? sdk.createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete }) : sdk.createRestrictedOpenAIProvider({ model: "offline-model", supportsImages: false, complete });
const runner = (provider, execute = () => "observed", limits = {}) => sdk.createRestrictedApplicationRunner({ provider, tools: [tool(execute)], instructions: "Use authorized current data and return a proposal only.", outputSchema: schema, limits: { maxSteps: 3, timeoutMs: 1000, ...limits } });
async function rejection(fn) { try { await fn(); assert.fail("Expected a rejected native turn"); } catch (error) { return error; } }
function protocol(error) {
  assert.equal(error.code, "PROVIDER_FAILED");
  assert.ok(error.providerFailure, "owned native rejection must retain safe protocol metadata");
  assert.deepEqual(JSON.parse(JSON.stringify(error.providerFailure)), { schemaVersion: "aginti-provider-failure-v1", category: "protocol", retryAfterMs: null });
  assert.equal(Object.isFrozen(error), true); assert.equal(Object.isFrozen(error.providerFailure), true);
  assert.doesNotMatch(JSON.stringify(error), /RAW_SECRET_SENTINEL|private-source-path/);
}
const malformed = [
  ["truncated", () => final('{"reply":"partial', "length")],
  ["duplicate-json", () => final('{"reply":"one","reply":"two"}')],
  ["contradictory-error", () => ({ ...final(), error: { category: "authentication", message: "RAW_SECRET_SENTINEL /private-source-path" } })],
  ["hidden-error", () => Object.defineProperty(final(), "error", { value: false })],
  ["accessor-choices", trap => Object.defineProperty({}, "choices", { enumerable: true, get: trap })],
  ["proxy-response", trap => new Proxy(final(), { get: trap, ownKeys: trap, getPrototypeOf: trap })],
  ["custom-prototype", trap => Object.assign(Object.create(Object.defineProperty({}, "then", { get: trap })), final())],
  ["invalid-native-arguments", () => call("read_current", '{"x":1,"x":2}')],
  ["refusal", () => { const raw = final(); raw.choices[0].message.refusal = "RAW_SECRET_SENTINEL"; return raw; }],
  ["oversized-choices", () => final("x".repeat(300 * 1024))],
];

for (const kind of ["openai", "deepseek"]) {
  for (const [name, make] of malformed) test(`native ${kind} classifies owned response rejection: ${name}`, async () => {
    let hooks = 0, requests = 0, reads = 0;
    const trap = () => { hooks++; throw Error("UNTRUSTED_HOOK"); };
    const provider = adapter(kind, () => { requests++; return make(trap); });
    const error = await rejection(() => runner(provider, () => { reads++; return "observed"; }).run(request));
    protocol(error); assert.equal(hooks, 0); assert.equal(requests, 1); assert.equal(reads, 0);
  });
  test(`native ${kind} keeps valid read and proposal behavior unchanged`, async () => {
    let requests = 0, reads = 0;
    const result = await runner(adapter(kind, () => ++requests === 1 ? call() : final()), () => { reads++; return "observed"; }).run(request);
    assert.equal(result.proposal.reply, "observed"); assert.equal(requests, 2); assert.equal(reads, 1);
  });
  test(`native ${kind} preserves existing trusted transport failure categories`, async () => {
    for (const category of ["authentication", "permission", "quota", "rate_limit", "unavailable", "timeout", "protocol"]) {
      const retryAfterMs = ["rate_limit", "unavailable"].includes(category) ? 7 : null;
      const declared = sdk.createRestrictedProviderFailure({ category, ...(retryAfterMs === null ? {} : { retryAfterMs }) });
      const error = await rejection(() => runner(adapter(kind, () => { throw declared; })).run(request));
      assert.equal(error.code, "PROVIDER_FAILED"); assert.equal(error.providerFailure.category, category); assert.equal(error.providerFailure.retryAfterMs, retryAfterMs);
    }
  });
  for (const variant of ["error", "proxy", "fake-metadata", "primitive"]) test(`native ${kind} leaves untrusted callback throw unclassified: ${variant}`, async () => {
    let hooks = 0;
    const trap = () => { hooks++; throw Error("UNTRUSTED_ERROR_HOOK"); };
    const raw = variant === "error" ? new sdk.RestrictedApplicationError("PROVIDER_PROTOCOL_INVALID")
      : variant === "proxy" ? new Proxy(Error("RAW_SECRET_SENTINEL"), { get: trap, ownKeys: trap, getPrototypeOf: trap })
      : variant === "fake-metadata" ? Object.defineProperty(Error("RAW_SECRET_SENTINEL"), "providerFailure", { get: trap }) : "RAW_SECRET_SENTINEL";
    const error = await rejection(() => runner(adapter(kind, () => { throw raw; })).run(request));
    assert.equal(error.code, "PROVIDER_FAILED"); assert.equal(error.providerFailure, undefined); assert.equal(hooks, 0); assert.doesNotMatch(JSON.stringify(error), /RAW_SECRET_SENTINEL/);
  });
  test(`native ${kind} does not relabel semantic output-schema rejection`, async () => {
    const error = await rejection(() => runner(adapter(kind, () => final('{"reply":42}'))).run(request));
    assert.equal(error.code, "OUTPUT_INVALID"); assert.equal(error.providerFailure, undefined);
  });
  test(`native ${kind} does not relabel an unauthorized model tool as transport evidence`, async () => {
    let reads = 0;
    const error = await rejection(() => runner(adapter(kind, () => call("delete_record")), () => { reads++; }).run(request));
    assert.equal(error.code, "TOOL_CALL_INVALID"); assert.equal(error.providerFailure, undefined); assert.equal(reads, 0);
  });
  test(`native ${kind} cancellation wins over classified malformed output`, async () => {
    const parent = new AbortController();
    const provider = adapter(kind, () => { parent.abort(); return final("bad", "length"); });
    const error = await rejection(() => runner(provider).run(request, { signal: parent.signal }));
    assert.equal(error.code, "CANCELLED"); assert.equal(error.providerFailure, undefined);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  });
  test(`native ${kind} deadline wins over classified malformed output`, async () => {
    const provider = adapter(kind, () => { const end = performance.now() + 15; while (performance.now() < end) {} return final("bad", "length"); });
    const error = await rejection(() => runner(provider, undefined, { timeoutMs: 5 }).run(request));
    assert.equal(error.code, "TIMEOUT"); assert.equal(error.providerFailure, undefined);
  });
  test(`native ${kind} direct adapter retains its existing error code and own fields`, async () => {
    const provider = adapter(kind, () => final("bad", "length"));
    const error = await rejection(() => provider.complete({ messages: [{ role: "system", content: "Return JSON." }, { role: "user", content: [{ type: "text", text: "Answer briefly." }] }], tools: [], outputSchema: schema, maxOutputTokens: 100 }, { signal: new AbortController().signal }));
    assert.equal(error.code, "PROVIDER_PROTOCOL_INVALID"); assert.equal(error.providerFailure, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["code", "message", "name", "stack"]);
  });
}
test("generic normalized provider cannot mint native protocol evidence with a public SDK error", async () => {
  const provider = { supportsImages: false, complete() { throw new sdk.RestrictedApplicationError("PROVIDER_PROTOCOL_INVALID"); } };
  const error = await rejection(() => runner(provider).run(request)); assert.equal(error.code, "PROVIDER_FAILED"); assert.equal(error.providerFailure, undefined);
});
test("provider failure evidence thrown by a read callback remains outside the tool failure channel", async () => {
  const provider = adapter("deepseek", () => call());
  const error = await rejection(() => runner(provider, () => { throw sdk.createRestrictedProviderFailure({ category: "protocol" }); }).run(request));
  assert.equal(error.code, "TOOL_FAILED"); assert.equal(error.providerFailure, undefined); assert.equal(error.toolFailure, undefined);
});
test("invalid native adapter configuration is still a caller contract failure", () => {
  assert.throws(() => sdk.createRestrictedDeepSeekProvider({ model: "unsupported-model", complete() {} }), e => e.code === "INVALID_CONTRACT" && !e.providerFailure);
  assert.throws(() => sdk.createRestrictedOpenAIProvider({ model: "model", supportsImages: false, complete: null }), e => e.code === "INVALID_CONTRACT" && !e.providerFailure);
});
