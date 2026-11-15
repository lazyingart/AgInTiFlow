import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createRestrictedDeepSeekProvider, createRestrictedOpenAIProvider } from "../src/restricted-application.js";
import { qualifyRestrictedProviderFactory } from "../scripts/fixtures/restricted-provider-conformance.js";

for (const kind of ["deepseek", "openai"]) test(`qualified ${kind} preserves original envelope through the portable test kit`, async () => {
  const signals = [];
  const report = await qualifyRestrictedProviderFactory(({ model, complete }) => {
    const options = { model, complete(body, { signal }) { signals.push(signal); return complete(body, { signal }); } };
    return kind === "deepseek" ? createRestrictedDeepSeekProvider(options) : createRestrictedOpenAIProvider({ ...options, supportsImages: false });
  });
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.totalCases, 20);
  assert.equal(report.passedCases, 20); assert.equal(report.failedCases, 0); assert.equal(report.productionReady, false);
  assert.equal(report.scope, "offline-original-envelope-only"); assert.ok(signals.length > 20);
  assert.ok(signals.every(signal => signal.aborted && getEventListeners(signal, "abort").length === 0));
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.results));
  assert.ok(report.results.every(result => Object.isFrozen(result) && Object.isFrozen(result.reasons)));
});

// Representative existing custom normalization, deliberately unsafe. This is
// not copied app code: the small fixture demonstrates the lost evidence class.
function lossyFactory({ complete }) {
  return { supportsImages: false, async complete(request, options) {
    const raw = await complete(request, options), choice = raw.choices[0];
    if (choice.finish_reason === "tool_calls") return { type: "tool_calls", calls: choice.message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) })) };
    if (choice.finish_reason === "length" || choice.message.refusal) throw Error("Rejected by custom parser");
    return { type: "final", value: JSON.parse(choice.message.content) };
  } };
}

test("lossy custom normalization cannot pass merely by using a current runner", async () => {
  const report = await qualifyRestrictedProviderFactory(lossyFactory);
  assert.equal(report.passed, false); assert.equal(report.productionReady, false);
  const get = id => report.results.find(result => result.id === id);
  for (const id of ["valid-answer", "valid-read-answer", "truncated-turn", "refusal", "undeclared-tool", "foreign-read-target", "extra-owner-argument", "mixed-batch", "duplicate-batch-id"]) assert.equal(get(id).passed, true, id);
  for (const id of ["error-object", "error-null", "duplicate-final-json", "multiple-choices", "wrong-role", "content-filter", "false-tool-calls", "error-with-read", "duplicate-read-json", "competing-text-protocol"]) assert.equal(get(id).passed, false, id);
  assert.equal(get("error-with-read").readCallbacks, 1); assert.equal(get("duplicate-read-json").readCallbacks, 1);
  assert.ok(get("error-with-read").reasons.includes("READ_COUNT_MISMATCH"));
});

test("report never exposes native error details, callback source, prompts or data", async () => {
  let traps = 0;
  const error = new Proxy({}, { get() { traps++; throw Error("PRIVATE_DIAGNOSTIC"); }, getPrototypeOf() { traps++; throw Error("PRIVATE_DIAGNOSTIC"); } });
  const report = await qualifyRestrictedProviderFactory(() => { throw error; });
  assert.equal(report.passed, false); assert.equal(report.failedCases, 20); assert.equal(traps, 0);
  assert.ok(report.results.every(row => row.rejectionCode === "ADAPTER_ERROR" && row.reasons.includes("TRANSPORT_COUNT_MISMATCH")));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DIAGNOSTIC|record_alpha|supplied current|Synthetic provider/);
});

test("an unused transport and an always-rejecting factory cannot qualify", async () => {
  const unused = await qualifyRestrictedProviderFactory(() => ({ supportsImages: false, complete() { return { type: "final", value: { reply: "The current public record is ready for review." } }; } }));
  assert.equal(unused.passed, false); assert.equal(unused.failedCases, 20);
  assert.ok(unused.results.every(row => row.reasons.includes("TRANSPORT_COUNT_MISMATCH")));
  const rejecting = await qualifyRestrictedProviderFactory(({ complete }) => ({ supportsImages: false, complete(request, options) { complete(request, options); throw Error("Fail all"); } }));
  assert.equal(rejecting.passed, false); assert.equal(rejecting.results.find(row => row.id === "valid-answer").passed, false);
  assert.equal(rejecting.results.find(row => row.id === "valid-read-answer").passed, false);
});

test("mistaken async factories fail and their dropped rejection is observed", async () => {
  const unhandled = [], listen = error => unhandled.push(error); process.on("unhandledRejection", listen);
  try {
    const report = await qualifyRestrictedProviderFactory(async () => { throw Error("PRIVATE_DIAGNOSTIC"); });
    assert.equal(report.passed, false); assert.equal(report.failedCases, 20);
    await new Promise(setImmediate); assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", listen); }
});

test("factory Proxy rejects before user hooks and the API has no live-provider options", async () => {
  let traps = 0;
  const factory = new Proxy(() => {}, { apply() { traps++; }, get() { traps++; } });
  await assert.rejects(qualifyRestrictedProviderFactory(factory), TypeError); assert.equal(traps, 0);
  for (const value of [null, {}, "adapter.mjs", Promise.resolve({})]) await assert.rejects(qualifyRestrictedProviderFactory(value), TypeError);
});

test("DeepSeek ordinary multilingual commentary remains compatible, not a competing tool protocol", async () => {
  const report = await qualifyRestrictedProviderFactory(({ model, complete }) => createRestrictedDeepSeekProvider({ model, complete(body, options) {
    const raw = complete(body, options), message = raw.choices?.[0]?.message;
    if (message?.tool_calls && raw.choices[0].finish_reason === "tool_calls" && message.content === null) message.content = "先看当前记录。現在の記録を確認します。 I will read the current record.";
    return raw;
  } }));
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.failedCases, 0);
});

for (const kind of ["deepseek", "openai"]) test(`no-tools ${kind} profile does not require or authorize a read`, async () => {
  const report = await qualifyRestrictedProviderFactory(({ model, complete }) => {
    const checked = (body, options) => { assert.equal(body.tools, undefined); return complete(body, options); };
    return kind === "deepseek" ? createRestrictedDeepSeekProvider({ model, complete: checked }) : createRestrictedOpenAIProvider({ model, complete: checked, supportsImages: false });
  }, { profile: "no-tools" });
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.totalCases, 19);
  assert.equal(report.profile, "no-tools"); assert.ok(report.results.every(row => row.readCallbacks === 0));
  assert.ok(report.results.every(row => row.id !== "valid-read-answer"));
});

test("a no-tools custom adapter can pass positive controls and still fail lost original evidence", async () => {
  const report = await qualifyRestrictedProviderFactory(options => {
    const provider = lossyFactory(options);
    return { supportsImages: false, complete(request, context) { assert.equal(request.tools.length, 0); return provider.complete(request, context); } };
  }, { profile: "no-tools" });
  assert.equal(report.results.find(row => row.id === "valid-answer").passed, true);
  assert.equal(report.passed, false); assert.equal(report.results.find(row => row.id === "error-object").passed, false);
});

test("qualification profile is exact and descriptor-only", async () => {
  let traps = 0;
  const cases = [new Proxy({}, { get() { traps++; }, ownKeys() { traps++; } }), Object.defineProperty({}, "profile", { enumerable: true, get() { traps++; } }),
    { profile: "no-tools", apiKey: "forbidden" }, { profile: "anything" }, { profile: "read-only", endpoint: "https://example.invalid" }, {}];
  for (const options of cases) await assert.rejects(qualifyRestrictedProviderFactory(lossyFactory, options));
  assert.equal(traps, 0);
});
