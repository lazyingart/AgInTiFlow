import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider, createRestrictedOpenAIProvider, createRestrictedOpenAIResponsesProvider } from "../src/restricted-application.js";
import { qualifyRestrictedProviderFactory } from "../scripts/fixtures/restricted-provider-conformance.js";
import { withChatTokenBudget } from "../src/openai-chat-parameters.js";

const cueSchema = { type: "object", properties: { cue: { type: "string", maxLength: 40 } }, required: ["cue"], additionalProperties: false };
const cueToolSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
function responseFixture(output, model = "gpt-6.1-sol") {
  return { object: "response", status: "completed", error: null, incomplete_details: null, model, output };
}
const cueCall = () => ({ type: "function_call", id: "fc_1", call_id: "call_1", name: "read_cue", arguments: "{}", status: "completed" });
const finalCue = (text = '{"cue":"PIER B2"}') => ({ type: "message", id: "msg_1", role: "assistant", status: "completed",
  phase: "final_answer", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] });
const cueReasoning = (value = "opaque-fixture") => ({ id: "rs_1", type: "reasoning", summary: [], encrypted_content: value });
function responsesApp(send, read, overrides = {}) {
  return createRestrictedApplicationRunner({ instructions: "Return the cue from the signed-in workspace.", outputSchema: cueSchema,
    provider: createRestrictedOpenAIResponsesProvider({ model: "gpt-6.1-sol", complete: send }),
    tools: [{ name: "read_cue", description: "Read the signed-in workspace cue.", readOnly: true, inputSchema: cueToolSchema, outputSchema: cueSchema, execute: read }],
    limits: { maxSteps: 2, maxToolCalls: 1, maxOutputTokens: 192 }, ...overrides });
}
const cueInput = { input: [{ type: "text", text: "Check our cue and return it." }] };

test("Sol native Responses delegates a scoped read and replays its exact opaque reasoning only within the invocation", async () => {
  let reads = 0;
  const requests = [], signals = [];
  const runner = responsesApp((body, { signal }) => {
    signals.push(signal); requests.push(body);
    assert.equal(body.store, false); assert.equal(body.stream, false);
    assert.equal(body.max_output_tokens, 192); assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.text.format.strict, true); assert.ok(!("previous_response_id" in body));
    if (requests.length % 2) {
      assert.ok(!body.input.some(x => x.type)); assert.deepEqual(body.tools.map(t => t.name), ["read_cue"]);
      return responseFixture([{ ...cueReasoning(), content: [{ type: "reasoning_text", text: "synthetic private reasoning" }] }, cueCall()]);
    }
    assert.ok(!("tools" in body)); assert.deepEqual(body.input.slice(-3).map(x => x.type), ["reasoning", "function_call", "function_call_output"]);
    assert.equal(body.input.at(-3).encrypted_content, "opaque-fixture");
    assert.ok(!Object.hasOwn(body.input.at(-3), "content")); assert.ok(!JSON.stringify(body).includes("synthetic private reasoning"));
    assert.equal(body.input.at(-1).call_id, body.input.at(-2).call_id);
    assert.deepEqual(JSON.parse(body.input.at(-1).output), { cue: "PIER B2" });
    return responseFixture([{ ...cueReasoning(), content: null }, finalCue()]);
  }, () => { reads++;return { cue: "PIER B2" }; });
  for (let i = 0; i < 2; i++) {
    const result = await runner.run(cueInput);
    assert.equal(result.proposal.cue, "PIER B2"); assert.deepEqual({ ...result.usage }, { steps: 2, toolCalls: 1 });
    assert.ok(!JSON.stringify(result).includes("opaque-fixture"));
  }
  assert.equal(reads, 2); assert.equal(requests.length, 4); assert.notEqual(signals[0], signals[2]);
  assert.ok(signals.every(s => s.aborted && getEventListeners(s, "abort").length === 0));
});

test("malformed or ambiguous Responses evidence never dispatches a read", async () => {
  let traps = 0, reads = 0;
  for (const modify of [
    raw => ({ ...raw, model: "gpt-6.2-astra" }), raw => ({ ...raw, status: "incomplete" }), raw => ({ ...raw, error: {} }),
    raw => ({ ...raw, store: true }), raw => ({ ...raw, previous_response_id: "another-run" }), raw => ({ ...raw, background: true }),
    raw => ({ ...raw, incomplete_details: { reason: "max_output_tokens" } }), () => responseFixture([cueCall(), finalCue()]),
    () => responseFixture([cueCall(), cueCall()]), () => responseFixture([{ ...cueCall(), type: "web_search_call" }]),
    () => responseFixture([{ ...cueCall(), name: "foreign_read" }]), () => responseFixture([{ ...cueCall(), status: "in_progress" }]),
    () => responseFixture([{ ...cueCall(), arguments: '{"x":1,"x":2}' }]), () => responseFixture([{ ...cueCall(), arguments: '{"scope":"elsewhere"}' }]),
    () => responseFixture([cueReasoning(""), cueCall()]), () => responseFixture([cueReasoning("a".repeat(140000)), cueCall()]),
    raw => Object.defineProperty(raw, "output", { get() { traps++; throw Error(); } }),
    raw => new Proxy(raw,{get() { traps++;throw Error(); },getPrototypeOf() { traps++;throw Error(); }}),
  ]) {
    const app = responsesApp(() => modify(responseFixture([cueCall()])), () => { reads++; return { cue: "PIER B2" }; });
    await assert.rejects(app.run(cueInput));
  }
  assert.equal(traps,0);assert.equal(reads,0);
});

test("Responses refusal, text pretending to call tools, invalid schema and repeated call IDs cannot complete or dispatch twice", async () => {
  for (const bad of [
    { ...finalCue(), phase: "commentary" }, { ...finalCue(), status: "in_progress" },
    { ...finalCue(), content: [{ type: "refusal", refusal: "refused" }] }, finalCue('{"tool_calls":[]}'),
    finalCue('{"cue":"one","cue":"two"}'), finalCue('{"cue":"a","extra":true}'), cueCall(),
  ]) {
    let calls=0, reads=0;
    const app=responsesApp(()=>responseFixture([++calls===1?cueCall():bad]),()=>{reads++;return {cue:"PIER B2"};},
      {limits:{maxSteps:3,maxToolCalls:2,maxOutputTokens:192}});
    await assert.rejects(app.run(cueInput));assert.equal(calls,2);assert.equal(reads,1);
  }
});

test("parallel Responses runs with reused provider call IDs preserve separate tool and reasoning histories", async () => {
  let entered = 0, releaseBoth;
  const both = new Promise(resolve => { releaseBoth=resolve; });
  const runner = responsesApp(async body => {
    const account=body.input.find(x=>x.role==="user").content;
    if (body.tools) { if (++entered===2) releaseBoth(); await both;return responseFixture([cueReasoning(account), cueCall()]); }
    assert.equal(body.input.at(-3).encrypted_content,account);
    return responseFixture([finalCue(JSON.stringify({cue:account}))]);
  },()=>({cue:"allowed"}));
  const results=await Promise.all(["alpha","beta"].map(text=>runner.run({input:[{type:"text",text}]})));
  assert.deepEqual(results.map(r=>r.proposal.cue),["alpha","beta"]);
});

test("cancelling a Responses turn prevents late tool dispatch and keeps its concurrency slot until transport settlement", async () => {
  let entered, release, reads = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const app = responsesApp(async () => { entered(); await held; return responseFixture([cueCall()]); },
    () => { reads++; return { cue: "PIER B2" }; }, { limits: { maxConcurrency: 1, maxSteps: 2, timeoutMs: 5000 } });
  const parent = new AbortController();
  const stopped = assert.rejects(app.run(cueInput, { signal: parent.signal }), { code: "CANCELLED" });
  try {
    await started; parent.abort(); await stopped;
    await assert.rejects(app.run(cueInput), { code: "BUSY" });
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});

test("Responses keeps primitive-root application schemas exact through the native object wrapper", async () => {
  const primitive = { type: "string", maxLength: 12 };
  for (const [text, valid] of [['{"proposal":"ready"}', true], ['{"proposal":"ready","extra":1}', false], ['"ready"', false]]) {
    const runner = responsesApp(body => {
      assert.deepEqual(body.text.format.schema.required, ["proposal"]);
      assert.equal(body.text.format.schema.properties.proposal.type, "string");
      return responseFixture([finalCue(text)]);
    }, () => assert.fail("unexpected read"), { tools: [], outputSchema: primitive });
    const run = runner.run(cueInput);
    if (valid) assert.equal((await run).proposal, "ready");
    else await assert.rejects(run);
  }
});

test("Sol and Astra text requests keep the caller's ceiling and strict proposal schema", async () => {
  const schema = { type: "object", properties: { reply: { type: "string", maxLength: 64 } }, required: ["reply"], additionalProperties: false };
  for (const model of ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.2-astra-2026-11-01"]) {
    const requests = [];
    const provider = createRestrictedOpenAIProvider({ model, supportsImages: false, complete(body) {
      requests.push(body);
      return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"reply":"ok"}' } }] };
    } });
    const app = createRestrictedApplicationRunner({ instructions: "Translate supplied text.", outputSchema: schema,
      tools: [], provider, limits: { maxSteps: 1, maxOutputTokens: 640 } });
    const result = await app.run({ input: [{ type: "text", text: "Translate bonjour." }] });
    assert.equal(result.proposal.reply, "ok");
    assert.equal(requests.length, 1);
    const [body] = requests;
    assert.equal(body.model, model);
    assert.equal(body.max_completion_tokens, 640);
    assert.equal(body.response_format.json_schema.strict, true);
    for (const key of ["tools", "temperature", "max_tokens"]) assert.ok(!Object.hasOwn(body, key));
  }
});

test("text-only OpenAI Chat rejects tool semantics before dispatch and leaves other providers intact", async () => {
  const body = Object.freeze({ model: "gpt-6.2-sol", messages: [], max_tokens: 97, temperature: 0,
    top_p: 0.9, logprobs: false, top_logprobs: 0, tool_choice: "none", parallel_tool_calls: false,
    tools: [], functions: [], function_call: "none", reasoning_effort: "medium" });
  assert.deepEqual(withChatTokenBudget("openai", body), { model: body.model, messages: [], max_completion_tokens: 97, reasoning_effort: "medium" });
  assert.strictEqual(withChatTokenBudget("deepseek", body), body);
  assert.throws(() => withChatTokenBudget("openai", { ...body, max_completion_tokens: 500 }), /Conflicting/);
  assert.equal(withChatTokenBudget("openai", { ...body, model: "gpt-5.4-mini" }).temperature, 0);
  for (const extra of [{ tools: [{}] }, { functions: [{}] }, { tool_choice: "auto" }, { function_call: { name: "read" } },
    { messages: [{ role: "tool" }] }, { messages: [{ role: "function" }] },
    { messages: [{ role: "assistant", tool_calls: [{}] }] }, { messages: [{ role: "assistant", function_call: { name: "read" } }] }]) {
    assert.throws(() => withChatTokenBudget("openai", { ...body, ...extra }), { code: "OPENAI_RESPONSES_TOOLS_REQUIRED" });
  }
  let dispatched = 0;
  const provider = createRestrictedOpenAIProvider({ model: body.model, supportsImages: false, complete() { dispatched++; } });
  const objectSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  const app = createRestrictedApplicationRunner({ instructions: "Read the record.", provider, outputSchema: objectSchema,
    tools: [{ name: "read_record", description: "Read a single record.", readOnly: true, inputSchema: objectSchema,
      outputSchema: objectSchema, execute() { assert.fail("unexpected tool execution"); } }] });
  await assert.rejects(app.run({ input: [{ type: "text", text: "Read the record." }] }));
  assert.equal(dispatched, 0);
});

test("a server-selected OpenAI model can read the scoped record and return a bounded proposal", async () => {
  const schema = { type: "object", properties: { room: { type: "string", maxLength: 20 } }, required: ["room"], additionalProperties: false };
  const bodies = [];
  let reads = 0;
  const provider = createRestrictedOpenAIProvider({ model: "gpt-5.4-mini", supportsImages: false, complete(body) {
    bodies.push(body);
    if (bodies.length === 1) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "room_lookup", type: "function", function: { name: "read_current", arguments: "{}" } }] } }] };
    assert.equal(body.messages.at(-1).tool_call_id, "room_lookup");
    assert.deepEqual(JSON.parse(body.messages.at(-1).content), { room: "MAPLE" });
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"room":"MAPLE"}' } }] };
  } });
  const app = createRestrictedApplicationRunner({ provider, instructions: "Read the current room.", outputSchema: schema,
    tools: [{ name: "read_current", description: "Read the signed-in account's record.", readOnly: true,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: schema,
      execute() { reads++; return { room: "MAPLE" }; } }],
    limits: { maxSteps: 2, maxToolCalls: 1, maxOutputTokens: 128 } });
  const result = await app.run({ input: [{ type: "text", text: "Which room was the workshop moved to?" }] });
  assert.equal(result.proposal.room, "MAPLE");
  assert.equal(reads, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].tools.map(t => t.function.name), ["read_current"]);
  assert.equal(bodies[1].tools, undefined);
  for (const b of bodies) {
    assert.equal(b.max_completion_tokens, 128);
    assert.equal(Object.hasOwn(b, "max_tokens"), false);
    assert.equal(b.response_format.json_schema.strict, true);
  }
});

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
