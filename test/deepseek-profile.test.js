import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import * as sdk from "../src/restricted-application.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 1000 };
const schema = object({ reply: string });
const input = { input: [{ type: "text", text: "Read my current draft and propose a shorter title; keep the notes." }] };
const final = (content = '{"reply":"Proposal, not saved."}') => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
const native = (content = "Read the latest record first.", calls) => ({ choices: [{ index: 0, logprobs: null, finish_reason: "tool_calls", message: { role: "assistant", content,
  tool_calls: calls ?? [{ index: 0, id: "c1", type: "function", function: { name: "record_search", arguments: '{"query":"draft"}' } }] } }] });
function provider(complete, model = "deepseek-flash") {
  assert.equal(typeof sdk.createRestrictedDeepSeekProvider, "function", "explicit native DeepSeek profile is missing");
  return sdk.createRestrictedDeepSeekProvider({ model, complete });
}
const tool = execute => ({ name: "record_search", description: "Read only the caller-bound current record.", readOnly: true,
  inputSchema: object({ query: string }), outputSchema: object({ text: string }), execute });
const runner = (p, tools = [], limits = {}) => sdk.createRestrictedApplicationRunner({ provider: p, tools, instructions: "Read authorized data; return an uncommitted JSON proposal. The host owns saves.", outputSchema: schema, limits });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("explicit Flash/Pro profile emits bounded native JSON-object tools without an SDK dependency", async () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
    const bodies = []; let reads = 0;
    const p = provider(async (body, options) => {
      bodies.push(body); assert.ok(Object.isFrozen(body) && Object.isFrozen(body.messages));
      assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.temperature, 0);
      assert.deepEqual(JSON.parse(JSON.stringify(body.response_format)), { type: "json_object" });
      assert.deepEqual(JSON.parse(JSON.stringify(body.thinking)), { type: "disabled" });
      assert.ok(body.messages[0].content.includes(JSON.stringify(schema))); assert.match(body.messages[0].content, /FINAL_JSON_SCHEMA:/);
      assert.ok(body.messages.every(m => m.content === null || typeof m.content === "string"));
      assert.equal(options.signal.aborted, false);
      return bodies.length === 1 ? native("我先读取当前记录。") : final();
    }, model);
    const result = await runner(p, [tool(async () => { reads++; return { text: "Scoped draft with notes." }; })]).run(input);
    assert.equal(result.proposal.reply, "Proposal, not saved."); assert.deepEqual({ ...result.usage }, { steps: 2, toolCalls: 1 });
    assert.equal(reads, 1); assert.equal(bodies.length, 2); assert.equal(p.supportsImages, false);
    assert.equal(bodies[1].messages.at(-1).tool_call_id, "c1"); assert.equal(bodies[1].messages.at(-1).content, '{"text":"Scoped draft with notes."}');
    assert.equal(Object.hasOwn(bodies[0], "reasoning_effort"), false);
  }
});

test("no-tools profile preserves host history, rejects images/schema violations, and never downgrades", async () => {
  let calls = 0;
  const p = provider(async body => {
    calls++; assert.equal(Object.hasOwn(body, "tools"), false); assert.equal(body.messages[1].content, "Authorized prior note.");
    return final('{"reply":"提案：保留备注；尚未保存。"}');
  });
  const result = await runner(p, [], { maxSteps: 1 }).run({ ...input, history: [{ role: "assistant", text: "Authorized prior note." }] });
  assert.match(result.proposal.reply, /尚未保存/); assert.equal(calls, 1);
  await assert.rejects(runner(p).run({ input: [{ type: "image", mediaType: "image/png", data: "ignored" }] }), { code: "VISION_UNAVAILABLE" });
  assert.equal(calls, 1);
  for (const content of ['{}', '{"reply":1}', '{"reply":"x","saved":true}', '{"reply":"x","reply":"y"}', '  ', '<｜DSML｜tool_calls>']) {
    let attempts = 0;
    await assert.rejects(runner(provider(async () => { attempts++; return final(content); })).run(input));
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(runner(provider(() => { attempts++; throw Error("Private backend error"); })).run(input), error => {
    assert.equal(error.code, "PROVIDER_FAILED"); assert.doesNotMatch(String(error), /Private backend/); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(attempts, 1);
});

test("mixed protocols, malformed native metadata and whole-batch ambiguity dispatch zero reads", async () => {
  const responses = [
    ...[false, 0, [], {}, '<｜DSML｜tool_calls>', '<｜｜DSML｜｜tool_calls', '<tool_calls>', 'Requested tool: other_tool', '{"tool_calls":[]}', 'tool_calls: []', 'x'.repeat(262144)].map(content => native(content)),
    { choices: [] }, { choices: [final().choices[0], final().choices[0]] },
    { choices: [{ finish_reason: "length", message: native().choices[0].message }] },
    { choices: [{ ...native().choices[0], index: 1 }] },
    { choices: [{ ...native().choices[0], logprobs: {} }] },
    { choices: [{ ...native().choices[0], message: { ...native().choices[0].message, reasoning_content: "unapproved thinking" } }] },
    { choices: [{ ...native().choices[0], message: { ...native().choices[0].message, refusal: "no" } }] },
    native("Read first.", [{ index: 1, id: "c1", type: "function", function: { name: "record_search", arguments: '{"query":"draft"}' } }]),
    native("Read first.", [{ id: "c1", type: "function", function: { name: "record_search", arguments: '{"query":"one","query":"two"}' } }]),
  ];
  for (const response of responses) {
    let reads = 0, attempts = 0;
    await assert.rejects(runner(provider(async () => ++attempts === 1 ? response : final()), [tool(async () => { reads++; return { text: "scoped" }; })]).run(input), { code: "PROVIDER_FAILED" });
    assert.equal(reads, 0); assert.equal(attempts, 1);
  }
  let reads = 0;
  const batch = native("Read first.", [
    { id: "c1", type: "function", function: { name: "record_search", arguments: '{"query":"draft"}' } },
    { id: "c2", type: "function", function: { name: "undeclared", arguments: '{}' } },
  ]);
  await assert.rejects(runner(provider(async () => batch), [tool(async () => { reads++; return { text: "scoped" }; })]).run(input), { code: "TOOL_CALL_INVALID" });
  assert.equal(reads, 0);
  await assert.rejects(runner(provider(async () => native()), [tool(async () => { reads++; return { text: "scoped" }; })], { maxSteps: 1 }).run(input), { code: "STEP_LIMIT" });
  assert.equal(reads, 0);
  assert.equal((await runner(provider(async () => final('{"reply":"The <tool_calls> label is documentation data."}'))).run(input)).proposal.reply, "The <tool_calls> label is documentation data.");
});

test("profile options and hostile response descriptors reject without invoking hooks", async () => {
  assert.equal(typeof sdk.createRestrictedDeepSeekProvider, "function");
  let traps = 0;
  for (const options of [
    { model: "ambient-model", complete: async () => final() }, { model: "deepseek-flash\n", complete: async () => final() },
    { model: "deepseek-flash", complete: async () => final(), thinking: { type: "enabled" } },
    { model: "deepseek-flash", complete: async () => final(), supportsImages: false },
    new Proxy({}, { get() { traps++; }, ownKeys() { traps++; return []; } }),
    { get model() { traps++; return "deepseek-flash"; }, complete: async () => final() },
    Object.assign(Object.create({ inherited: true }), { model: "deepseek-flash", complete: async () => final() }),
  ]) assert.throws(() => sdk.createRestrictedDeepSeekProvider(options));
  for (const raw of [
    new Proxy({}, { get() { traps++; }, ownKeys() { traps++; return []; } }),
    { get choices() { traps++; return []; } },
    { get then() { traps++; }, choices: final().choices },
    { choices: [{ finish_reason: "stop", get message() { traps++; return {}; } }] },
  ]) await assert.rejects(runner(provider(() => raw)).run(input), { code: "PROVIDER_FAILED" });
  assert.equal(traps, 0);
  const neutral = final(); Object.defineProperty(neutral, "_request_id", { get() { traps++; } });
  assert.equal((await runner(provider(() => neutral)).run(input)).status, "completed"); assert.equal(traps, 0);
});

test("explicit DeepSeek cancellation retains live capacity and cannot start a read or retry", { timeout: 10000 }, async t => {
  const work = deferred(), entered = deferred(); let attempts = 0, reads = 0, signal;
  const control = new AbortController(); const unhandled = []; const onUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); control.abort(); work.resolve(final()); });
  const app = runner(provider((_body, options) => { attempts++; signal = options.signal; entered.resolve(); return work.promise; }), [tool(async () => { reads++; return { text: "scoped" }; })], { maxConcurrency: 1 });
  const running = app.run(input, { signal: control.signal }); running.catch(() => {}); await entered.promise;
  control.abort(); await assert.rejects(running, { code: "CANCELLED" }); assert.equal(signal.aborted, true);
  await assert.rejects(app.run(input), { code: "BUSY" }); assert.equal(attempts, 1); assert.equal(reads, 0);
  work.reject(Error("private late failure")); await new Promise(setImmediate);
  assert.equal(unhandled.length, 0); assert.equal(getEventListeners(control.signal, "abort").length, 0);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(app.run(input, { signal: alreadyAborted.signal }), { code: "CANCELLED" }); assert.equal(attempts, 1);
});

test("generic native adapter also rejects falsey non-text content before reads", async () => {
  for (const content of [false, 0, [], {}]) {
    let attempts = 0, reads = 0;
    const p = sdk.createRestrictedOpenAIProvider({ model: "explicit", supportsImages: false, complete: async () => {
      attempts++; const value = attempts === 1 ? native(content) : final();
      delete value.choices[0].index; delete value.choices[0].logprobs;
      if (attempts === 1) delete value.choices[0].message.tool_calls[0].index;
      return value;
    } });
    await assert.rejects(runner(p, [tool(async () => { reads++; return { text: "scoped" }; })]).run(input), { code: "PROVIDER_FAILED" });
    assert.equal(reads, 0); assert.equal(attempts, 1);
  }
});
