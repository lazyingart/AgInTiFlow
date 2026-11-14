import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { createRestrictedApplicationRunner, createRestrictedProviderFailure, createRestrictedDeepSeekProvider, createRestrictedOpenAIProvider } = await import(pathToFileURL(path.join(root, "src/restricted-application.js")));
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const schema = object({ draft: { type: "string", minLength: 1, maxLength: 1600 } });
const empty = object({}), input = { input: [{ type: "text", text: "Make this clearer but keep the facts." }] };
const final = draft => ({ type: "final", value: { draft } });
const original = "The observed value is 12. Independent review is pending.";
const revised = "The value observed was 12; independent review remains pending.";
const accept = () => ({ decision: "accept" });
const revise = () => ({ decision: "revise", feedback: "This candidate repeats the current text without performing the requested rewrite. Preserve the supplied facts and propose a revised draft." });
const review = evaluate => ({ readOnly: true, evaluate });
function options(complete, proposalReview, limits = {}) {
  return { provider: { supportsImages: false, complete }, tools: [], instructions: "Return an uncommitted draft proposal based on authorized evidence.", outputSchema: schema,
    ...(proposalReview === undefined ? {} : { proposalReview }), limits: { maxSteps: 4, maxConcurrency: 1, timeoutMs: 1000, ...limits } };
}
const make = (complete, proposalReview, limits) => createRestrictedApplicationRunner(options(complete, proposalReview, limits));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });return { promise, resolve, reject }; };

test("absent review preserves the existing request and exact two-field usage", async () => {
  const requests = [];
  const result = await make(request => { requests.push(request);return final(original); }).run(input);
  assert.deepEqual({ ...result.usage }, { steps: 1, toolCalls: 0 });assert.equal(result.proposal.draft, original);
  assert.deepEqual(Object.keys(requests[0]).sort(), ["maxOutputTokens", "messages", "outputSchema", "schemaVersion", "tools"]);
});
test("accepting review leaves the initial provider request byte-identical", async () => {
  const requests = [];
  await make(request => { requests.push(JSON.stringify(request));return final(revised); }).run(input);
  const result = await make(request => { requests.push(JSON.stringify(request));return final(revised); }, review((proposal, context) => {
    assert.ok(Object.isFrozen(proposal));assert.deepEqual(Object.keys(context).sort(), ["reads", "signal"]);assert.ok(Object.isFrozen(context.reads));assert.deepEqual(context.reads, []);return accept();
  })).run(input);
  assert.equal(requests[0], requests[1]);assert.deepEqual({ ...result.usage }, { steps: 1, toolCalls: 0, proposalReviews: 1, proposalRevisions: 0 });
});
test("one host rejection refines a no-op within the same provider and budget", async () => {
  let calls = 0, reviews = 0;const seen = [];
  const result = await make(request => {
    calls++;seen.push(request);
    if (calls === 2) { assert.equal(request.messages.at(-1).role, "system");assert.ok(request.messages.at(-1).content.includes("repeats the current text"));assert.deepEqual(JSON.parse(request.messages.at(-2).content[0].text), { draft: original }); }
    return final(calls === 1 ? original : revised);
  }, review(proposal => { reviews++;return proposal.draft === original ? revise() : accept(); })).run(input);
  assert.equal(result.proposal.draft, revised);assert.equal(calls, 2);assert.equal(reviews, 2);
  assert.deepEqual({ ...result.usage }, { steps: 2, toolCalls: 0, proposalReviews: 2, proposalRevisions: 1 });
  assert.equal(seen[0].maxOutputTokens, seen[1].maxOutputTokens);assert.deepEqual(seen[0].tools, seen[1].tools);
});
test("only this invocation's detached frozen reads reach the host reviewer", async () => {
  let calls = 0, reads = 0, reviews = 0;const value = { draft: original };
  const config = options(() => ++calls === 1 ? { type: "tool_calls", calls: [{ id: "read_1", name: "read_draft", arguments: {} }] } : final(calls === 2 ? original : revised), review((proposal, context) => {
    reviews++;assert.equal(context.reads.length, 1);const read = context.reads[0];
    assert.deepEqual(Object.keys(read).sort(), ["arguments", "callId", "name", "value"]);assert.equal(read.callId, "read_1");assert.equal(read.name, "read_draft");assert.equal(read.value.draft, original);
    assert.notEqual(read.value, value);assert.ok(Object.isFrozen(read));assert.ok(Object.isFrozen(read.value));assert.ok(Object.isFrozen(read.arguments));assert.throws(() => { read.value.draft = "changed"; });
    return proposal.draft === original ? revise() : accept();
  }));
  config.tools = [{ name: "read_draft", description: "Read current authorized draft.", readOnly: true, inputSchema: empty, outputSchema: schema, execute() { reads++;return value; } }];
  const result = await createRestrictedApplicationRunner(config).run({ ...input, history: [{ role: "assistant", text: "An old draft existed; that is not a current tool observation." }] });
  assert.equal(calls, 3);assert.equal(reads, 1);assert.equal(reviews, 2);assert.equal(value.draft, original);assert.equal(result.usage.toolCalls, 1);
});
test("repeated rejection fails closed after exactly one refinement", async () => {
  let calls = 0, reviews = 0;
  const app = make(() => { calls++;return final(original); }, review(() => { reviews++;return revise(); }), { maxSteps: 8 });
  await assert.rejects(app.run(input), { code: "PROPOSAL_REJECTED" });assert.equal(calls, 2);assert.equal(reviews, 2);
});
test("a final-step rejection grants no extra model request", async () => {
  let calls = 0;await assert.rejects(make(() => { calls++;return final(original); }, review(revise), { maxSteps: 1 }).run(input), { code: "PROPOSAL_REJECTED" });assert.equal(calls, 1);
});
test("invalid proposal schema is never passed to review", async () => {
  let reviews = 0;await assert.rejects(make(() => ({ type: "final", value: { unexpected: true } }), review(() => { reviews++;return accept(); })).run(input), { code: "OUTPUT_INVALID" });assert.equal(reviews, 0);
});
test("feedback cannot grant an undeclared tool", async () => {
  let calls = 0;const app = make(() => ++calls === 1 ? final(original) : ({ type: "tool_calls", calls: [{ id: "forbidden", name: "run_command", arguments: {} }] }), review(revise));
  await assert.rejects(app.run(input), { code: "TOOL_CALL_INVALID" });assert.equal(calls, 2);
});
test("review feedback is charged to the existing context bound", async () => {
  let calls = 0;
  const app = make(() => { calls++;return final("x".repeat(900)); }, review(() => ({ decision: "revise", feedback: "bounded feedback ".repeat(70) })), { maxContextBytes: 2000 });
  await assert.rejects(app.run(input), { code: "CONTEXT_LIMIT" });assert.equal(calls, 1);
});
for (const value of [null, undefined, false, {}, { decision: "yes" }, { decision: "accept", feedback: "extra" }, { decision: "revise" }, { decision: "revise", feedback: " " }, { decision: "revise", feedback: "x".repeat(2049) }, { decision: "revise", feedback: "sk-" + "x".repeat(32) }, { decision: "accept", extra: true }]) {
  test(`invalid review result fails closed: ${JSON.stringify(value)?.slice(0, 90)}`, async () => {
    let calls = 0;await assert.rejects(make(() => { calls++;return final(original); }, review(() => value)).run(input), { code: "PROPOSAL_REVIEW_INVALID" });assert.equal(calls, 1);
  });
}
for (const shape of ["proxy", "promise-proxy", "thenable", "accessor", "inherited", "hidden", "symbol"]) test(`review rejects ${shape} without data hooks`, async () => {
  let hooks = 0;const data = { decision: "accept" };let result = data;
  if (shape === "proxy") result = new Proxy(data, { get() { hooks++;throw Error("hook"); }, ownKeys() { hooks++;throw Error("hook"); } });
  if (shape === "promise-proxy") result = new Proxy(Promise.resolve(data), { get() { hooks++;throw Error("hook"); } });
  if (shape === "thenable") result = { then() { hooks++; } };
  if (shape === "accessor") Object.defineProperty(data, "then", { get() { hooks++;throw Error("hook"); } });
  if (shape === "inherited") result = Object.assign(Object.create({ get then() { hooks++;throw Error("hook"); } }), data);
  if (shape === "hidden") Object.defineProperty(data, "extra", { value: true });
  if (shape === "symbol") data[Symbol("extra")] = true;
  await assert.rejects(make(() => final(original), review(() => result)).run(input), { code: "PROPOSAL_REVIEW_INVALID" });assert.equal(hooks, 0);
});
for (const config of [null, false, { evaluate: accept }, { readOnly: false, evaluate: accept }, { readOnly: true, evaluate: null }, { readOnly: true, evaluate: accept, maxRevisions: 2 }]) test(`review configuration is exact and explicit: ${JSON.stringify(config)}`, () => {
  assert.throws(() => createRestrictedApplicationRunner({ ...options(() => final(original)), proposalReview: config }), { code: "INVALID_CONTRACT" });
});
test("configuration descriptor attacks reject before traps", () => {
  let traps = 0;for (const value of [new Proxy(review(accept), { get() { traps++;throw Error("trap"); } }), Object.defineProperty({ readOnly: true }, "evaluate", { enumerable: true, get() { traps++;throw Error("trap"); } })]) assert.throws(() => make(() => final(original), value));assert.equal(traps, 0);
});
test("constructor captures the reviewer rather than a mutable config alias", async () => {
  const config = review(accept), app = make(() => final(original), config);config.evaluate = () => { throw Error("replaced"); };config.readOnly = false;assert.equal((await app.run(input)).status, "completed");
});
for (const asynchronous of [false, true]) test(`review callback failure is safe and never a provider fallback signal: async=${asynchronous}`, async () => {
  const error = createRestrictedProviderFailure({ category: "unavailable" });const evaluate = () => { throw error; };
  await assert.rejects(make(() => final(original), review(asynchronous ? async () => evaluate() : evaluate)).run(input), value => value.code === "PROPOSAL_REVIEW_FAILED" && !Object.hasOwn(value, "providerFailure") && !value.message.includes("unavailable"));
});
for (const timeout of [false, true]) test(`pending review preserves cancellation/deadline and physical capacity: timeout=${timeout}`, { timeout: 5000 }, async () => {
  const entered = defer(), pending = defer(), controller = new AbortController();let reviews = 0;const unhandled = [], listen = error => unhandled.push(error);process.on("unhandledRejection", listen);
  const app = make(() => final(original), review(() => { if (++reviews === 1) { entered.resolve();return pending.promise; }return accept(); }), { timeoutMs: timeout ? 500 : 1000 });
  try {
    const running = app.run(input, { signal: controller.signal });running.catch(() => {});await Promise.race([entered.promise, running.then(() => { throw Error("Review was not entered"); })]);if (!timeout) controller.abort();
    await assert.rejects(running, { code: timeout ? "TIMEOUT" : "CANCELLED" });await assert.rejects(app.run(input), { code: "BUSY" });
    pending.reject(Error("private late review detail"));await new Promise(setImmediate);assert.equal((await app.run(input)).status, "completed");assert.equal(getEventListeners(controller.signal, "abort").length, 0);assert.deepEqual(unhandled, []);
  } finally { pending.resolve(accept());controller.abort();process.removeListener("unhandledRejection", listen); }
});
test("pre-cancellation invokes neither provider nor reviewer", async () => {
  let calls = 0, reviews = 0;const controller = new AbortController();controller.abort();await assert.rejects(make(() => { calls++;return final(original); }, review(() => { reviews++;return accept(); })).run(input, { signal: controller.signal }), { code: "CANCELLED" });assert.equal(calls, 0);assert.equal(reviews, 0);
});
for (const native of ["openai", "deepseek"]) test(`${native} normalized feedback preserves native framing`, async () => {
  let calls = 0;const complete = body => {
    calls++;if (calls === 2) { assert.equal(body.messages.at(-1).role, "system");assert.equal(typeof body.messages.at(-1).content, "string");assert.equal(body.messages.at(-2).role, "assistant"); }
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ draft: calls === 1 ? original : revised }) } }] };
  };
  const provider = native === "openai" ? createRestrictedOpenAIProvider({ model: "qualified-test-model", supportsImages: false, complete }) : createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete });
  const result = await createRestrictedApplicationRunner({ ...options(() => {} , review(p => p.draft === original ? revise() : accept())), provider }).run(input);assert.equal(calls, 2);assert.equal(result.proposal.draft, revised);
});

test("closed DeepSeek native final encoding remains closed across proposal refinement", async () => {
  let calls = 0, reads = 0;
  const provider = createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete(body) {
    calls++;
    if (calls === 1) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "read_1", type: "function", function: { name: "read_draft", arguments: "{}" } }] } }] };
    assert.equal(body.tools.length, 1);assert.equal(body.tools[0].function.name, "__aginti_return_proposal");
    assert.equal(body.tool_choice.function.name, "__aginti_return_proposal");
    return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "encoded_final", type: "function", function: { name: "__aginti_return_proposal", arguments: JSON.stringify({ draft: calls === 2 ? original : revised }) } }] } }] };
  } });
  const config = options(() => {}, review(proposal => proposal.draft === original ? revise() : accept()), { maxToolCalls: 1 });config.provider = provider;
  config.tools = [{ name: "read_draft", description: "Read authorized source.", readOnly: true, inputSchema: empty, outputSchema: schema, execute() { reads++;return { draft: original }; } }];
  const result = await createRestrictedApplicationRunner(config).run(input);assert.equal(result.proposal.draft, revised);assert.equal(reads, 1);assert.equal(calls, 3);assert.equal(result.usage.toolCalls, 1);
});
test("overlapping invocations supply isolated current reads to review", async () => {
  const config = options(request => {
    const tool = request.messages.find(message => message.role === "tool");
    if (!tool) { const id = request.messages[1].content[0].text;return { type: "tool_calls", calls: [{ id: "read_1", name: "read_current", arguments: { id } }] }; }
    return final(tool.value.draft);
  }, review(async (proposal, context) => { await new Promise(setImmediate);assert.equal(context.reads.length, 1);assert.equal(context.reads[0].value.draft, proposal.draft);return accept(); }), { maxConcurrency: 2 });
  config.tools = [{ name: "read_current", description: "Read one selected source.", readOnly: true, inputSchema: object({ id: { type: "string", enum: ["A", "B"], maxLength: 1 } }), outputSchema: schema, async execute({ id }) { await new Promise(setImmediate);return { draft: id }; } }];
  const app = createRestrictedApplicationRunner(config), results = await Promise.all(["A", "B"].map(text => app.run({ input: [{ type: "text", text }] })));
  assert.deepEqual(results.map(result => result.proposal.draft), ["A", "B"]);assert.ok(results.every(result => result.usage.proposalReviews === 1));
});
for (const feedback of ["Perform the requested rewrite, preserving current facts.", "请实际改写，但保留现有事实。", "事実を保ったまま、依頼された書き換えを行ってください。", "界".repeat(682)]) test(`bounded UTF-8 review feedback is preserved: ${feedback.slice(0, 30)}`, async () => {
  let calls = 0;const app = make(request => { calls++;if (calls === 2) assert.ok(request.messages.at(-1).content.includes(feedback));return final(calls === 1 ? original : revised); }, review(proposal => proposal.draft === original ? { decision: "revise", feedback } : accept()));
  const result = await app.run(input);assert.equal(result.proposal.draft, revised);assert.equal(calls, 2);
});
test("feedback bounds count UTF-8 bytes rather than string length", async () => {
  let calls = 0;await assert.rejects(make(() => { calls++;return final(original); }, review(() => ({ decision: "revise", feedback: "界".repeat(683) }))).run(input), { code: "PROPOSAL_REVIEW_INVALID" });assert.equal(calls, 1);
});
test("refinement may use remaining authorized reads within original limits", async () => {
  let calls = 0, reads = 0;const config = options(() => {
    calls++;if (calls === 2) return { type: "tool_calls", calls: [{ id: "read_1", name: "read_draft", arguments: {} }] };return final(calls === 1 ? original : revised);
  }, review((proposal, context) => context.reads.length ? accept() : { decision: "revise", feedback: "Current evidence is missing; read the authorized source before proposing." }));
  config.tools = [{ name: "read_draft", description: "Read current source.", readOnly: true, inputSchema: empty, outputSchema: schema, execute() { reads++;return { draft: revised }; } }];
  const result = await createRestrictedApplicationRunner(config).run(input);assert.equal(calls, 3);assert.equal(reads, 1);assert.equal(result.proposal.draft, revised);assert.equal(result.usage.proposalRevisions, 1);
});
for (const native of ["openai", "deepseek"]) for (const [name, outputSchema, first, second] of [
  ["array", { type: "array", items: { type: "string", maxLength: 30 }, maxItems: 2 }, ["old"], ["revised"]],
  ["string", { type: "string", maxLength: 30 }, "old", "revised"],
  ["anyOf", { anyOf: [{ type: "null" }, { type: "string", maxLength: 30 }] }, null, "revised"],
]) test(`${native} refinement preserves exact ${name} proposal root`, async () => {
  let calls = 0;const complete = body => {
    calls++;return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ proposal: calls === 1 ? first : second }) } }] };
  };
  const provider = native === "deepseek" ? createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete }) : createRestrictedOpenAIProvider({ model: "test-model", supportsImages: false, complete });
  const config = options(() => {}, review(value => JSON.stringify(value) === JSON.stringify(first) ? revise() : accept()));config.provider = provider;config.outputSchema = outputSchema;
  const result = await createRestrictedApplicationRunner(config).run(input);assert.deepEqual(JSON.parse(JSON.stringify(result.proposal)), second);assert.equal(calls, 2);assert.equal(result.usage.proposalRevisions, 1);
});
