import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as nativeChild from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { mock, test } from "node:test";

// Only the external advisory process is simulated. No agent CLI, credential or
// real model is used; the native tool loop and SessionStore are exercised.
let launches = 0;
let outcomes = [];
mock.module("node:child_process", { namedExports: {
  ...nativeChild,
  execFileSync(command, args, options) {
    if (command === "sh" && args?.[1] === "command -v codex") return Buffer.from("/synthetic/codex\n");
    return nativeChild.execFileSync(command, args, options);
  },
  spawn(command, args, options) {
    if (command !== "codex") return nativeChild.spawn(command, args, options);
    launches++;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const outcome = outcomes.shift() || { code: 1 };
    setImmediate(() => { if (outcome.stdout) child.stdout.write(outcome.stdout); child.emit("close", outcome.code, null); });
    return child;
  },
} });
const { runAgent } = await import("../src/agent-runner.js");
const { resolveRuntimeConfig } = await import("../src/config.js");
const { closeSessionIndexConnections } = await import("../src/session-index.js");
const { SessionStore } = await import("../src/session-store.js");

test("an explicit once-only adviser cannot be dispatched again after failure", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-adviser-invocation-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const client = { chat: { completions: { create: async request => {
    if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Ask the selected adviser once and report its result or limitation." } }] };
    calls++;
    const name = calls <= 2 ? "delegate_agent" : "finish";
    const args = name === "delegate_agent" ? { wrapper: "codex", prompt: "Read-only: explain what Number.parseFloat('1x') does. No tools or file changes." }
      : { result: "The independent review is unavailable because the adviser exited with an error. No review or file change was completed." };
    return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "adviser_" + calls, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
  } } } };
  const clientFactory = async () => client; clientFactory.agintiDeterministicTest = true;
  const goal = "Ask Codex only once for a read-only second opinion about Number.parseFloat('1x'). If it fails, do not retry. Do not change any file, use the web, install anything, or run a command. Return its finding or the specific limitation.";
  const config = resolveRuntimeConfig({ goal, provider: "openai", model: "scripted-adviser", routingMode: "manual", enableScs: "off" }, {
    baseDir: root, commandCwd: root, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "once-only-adviser", clientFactory,
    allowWrapperTools: true, preferredWrapper: "codex", wrapperModel: "cli-default", allowFileTools: false, allowShellTool: false,
    allowWebSearch: false, allowAuxiliaryTools: false, allowMcpTools: false, allowParallelScouts: false, sandboxMode: "host",
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    allowWrapperTools: true, preferredWrapper: "codex", wrapperModel: "cli-default", maxSteps: 4, dynamicSteps: "off", scsActive: false,
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline once-only adviser reproduction." }, quiet: true,
    onConsole: () => {}, onLog: () => {} });
  const result = await runAgent(config);
  const events = (await fs.readFile(path.join(root, "sessions/once-only-adviser/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(launches, 1, "the failed advisory call spent a second invocation despite the explicit limit");
  assert.equal(events.filter(e => e.type === "tool.started" && e.data?.toolName === "delegate_agent").length, 1);
  assert.equal(result.stopped, true); assert.equal(result.reason, "advisory_unavailable");
  assert.equal(calls, 1, "failure triggered an unnecessary model repair turn");
});

const review = { wrapper: "codex", prompt: "Read-only: check the supplied expression 2 * 3. Do not run tools." };
const pureGoal = "Ask Codex only once for a read-only second opinion on the supplied expression 2 * 3. Return its finding or the limitation. Do not change files or run commands.";
function assertBalanced(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") { assert.ok(pending.delete(message.tool_call_id), "orphan or duplicated tool reply"); continue; }
    assert.equal(pending.size, 0, "provider request contains unanswered tool calls");
    if (message.role === "assistant") for (const call of message.tool_calls || []) pending.add(call.id);
  }
  assert.equal(pending.size, 0, "provider request ends with unanswered tool calls");
}
function turn(name, args, id) { return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
  tool_calls: [{ id: "advisory_" + id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }; }

async function fixture(t, goal, next) {
  launches = 0; outcomes = [];
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline advisory regression must not access the network"); });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-advisory-runtime-"));
  const oldHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const clientFactory = async () => ({ chat: { completions: { create: async request => {
    assertBalanced(request.messages);
    return !request.tools ? { choices: [{ message: { role: "assistant", content: "Inspect the supplied evidence, obtain the requested advice, and verify only allowed changes." } }] }
      : next(request, ++calls);
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig({ goal, provider: "openai", model: "scripted-advisory", routingMode: "manual", enableScs: "off", taskProfile: "auto" }, {
    baseDir: root, commandCwd: root, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "advisory-runtime", clientFactory,
    sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true, allowWrapperTools: true,
    preferredWrapper: "codex", wrapperModel: "cli-default", allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false,
  });
  Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    maxSteps: 10, dynamicSteps: "off", scsActive: false, allowWrapperTools: true, preferredWrapper: "codex", wrapperModel: "cli-default", wrapperReasoning: "medium", allowProviderHandoff: false,
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline advisory durability regression." }, onConsole: () => {}, onLog: () => {} });
  return { root, config, calls: () => calls,
    state: async () => JSON.parse(await fs.readFile(path.join(root, "sessions/advisory-runtime/state.json"), "utf8")),
    events: async () => (await fs.readFile(path.join(root, "sessions/advisory-runtime/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse) };
}

test("successful advice is replayed without another CLI or invented spare model", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, (_r, n) => n < 3 ? turn("delegate_agent", review, n)
    : turn("finish", { result: "The independent advice confirms that the supplied expression evaluates to 6." }, n));
  outcomes = [{ code: 0, stdout: "The supplied expression evaluates to 6." }];
  const result = await runAgent(f.config);
  assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(launches, 1);
  const events = await f.events();
  assert.equal(events.filter(e => e.type === "tool.reused" && e.data?.toolName === "delegate_agent").length, 1);
  const checkpoint = (await f.state()).meta.advisoryInvocation;
  assert.equal(checkpoint.attempt.result.stdout, outcomes[0]?.stdout || "The supplied expression evaluates to 6.");
});

test("a new explicit review cannot be fulfilled by the older durable result", { timeout: 20000 }, async t => {
  let second = false, secondTurns = 0;
  const f = await fixture(t, pureGoal, (_request, n) => {
    if (!second) return n === 1 ? turn("delegate_agent", review, n)
      : turn("finish", { result: "The independent advice confirms that the supplied expression evaluates to 6." }, n);
    secondTurns++;
    return secondTurns === 1 ? turn("finish", { result: "The new independent Codex review confirms 6." }, n)
      : secondTurns === 2 ? turn("delegate_agent", { ...review, prompt: "Read-only: review 2 * 3 again for this newly authorized attempt." }, n)
        : turn("finish", { result: "The new independent Codex advice confirms 6." }, n);
  });
  outcomes = [{ code: 0, stdout: "The supplied expression evaluates to 6." }, { code: 0, stdout: "The new review confirms 6." }];
  assert.notEqual((await runAgent(f.config)).stopped, true);
  const first = (await f.state()).meta.advisoryInvocation;
  assert.equal(launches, 1); second = true;
  const result = await runAgent({ ...f.config, resume: "advisory-runtime",
    goal: "Continue the same task. Ask Codex once again for a read-only review of 2 * 3 before finishing." });
  assert.notEqual(result.stopped, true, JSON.stringify(result));
  assert.equal(launches, 2, "the new required review was accepted without dispatch");
  assert.equal(secondTurns, 3);
  const next = (await f.state()).meta.advisoryInvocation;
  assert.notEqual(next.attempt.id, first.attempt.id); assert.equal(next.scope.revision, 2);
  assert.ok((await f.events()).some(event => event.type === "completion.evidence_rejected" && event.data?.missingToolCalls?.includes("delegate_agent")));
});

test("a different question cannot reuse or consume a second optional grant", { timeout: 15000 }, async t => {
  const f = await fixture(t, "Ask Codex once if useful about 2 * 3. Do not change files.", (_r, n) => n < 3
    ? turn("delegate_agent", n === 1 ? review : { ...review, prompt: "A different review of 2 + 3." }, n)
    : turn("finish", { result: "The optional review was unavailable. No independent finding was obtained." }, n));
  await runAgent(f.config);
  assert.equal(launches, 1);
  assert.equal((await f.events()).filter(e => e.type === "tool.blocked" && e.data?.category === "advisory-invocation-limit").length, 1);
});

test("provider handoff and concrete same-task continuation cannot retry failed advice", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, (_r, n) => turn("delegate_agent", review, n));
  assert.equal((await runAgent(f.config)).reason, "advisory_unavailable");
  const first = await f.state();
  const resumed = await runAgent({ ...f.config, resume: "advisory-runtime", goal: "Continue the same task.",
    runtimePatch: { provider: "deepseek", model: "deepseek-flash", baseURL: "https://api.deepseek.com/v1" }, expectedRuntimeRevision: 1 });
  assert.equal(resumed.reason, "advisory_unavailable");
  assert.equal(launches, 1); assert.equal(f.calls(), 1);
  const retained = await f.state();
  assert.equal(retained.meta.runtimeConfig.provider, "deepseek");
  assert.equal(retained.meta.runtimeConfig.revision, 2);
  assert.deepEqual(retained.meta.advisoryInvocation, first.meta.advisoryInvocation);
  const concrete = await runAgent({ ...f.config, resume: "advisory-runtime", goal: "Continue the same task and add a final verification note." });
  assert.equal(concrete.reason, "advisory_unavailable"); assert.equal(launches, 1); assert.equal(f.calls(), 1);
  assert.equal((await f.state()).meta.goalContract.taskBoundaryRevision, 1);
});

test("disabled advisers do not spend a model or tool call", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, () => { throw Error("No model call permitted"); });
  assert.equal((await runAgent({ ...f.config, allowWrapperTools: false })).reason, "advisory_unavailable");
  assert.equal(launches, 0); assert.equal(f.calls(), 0);
});

test("a differently selected adviser cannot substitute for the required peer", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, () => { throw Error("No model call permitted"); });
  assert.equal((await runAgent({ ...f.config, preferredWrapper: "claude" })).reason, "advisory_unavailable");
  assert.equal(launches, 0); assert.equal(f.calls(), 0);
});

test("claiming review without an invocation is rejected before truthful recovery", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, (_r, n) => n === 2 ? turn("delegate_agent", review, n)
    : turn("finish", { result: "Codex reviewed the supplied expression and confirmed 6." }, n));
  outcomes = [{ code: 0, stdout: "The supplied expression evaluates to 6." }];
  const result = await runAgent(f.config);
  assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(launches, 1); assert.equal(f.calls(), 3);
  assert.ok((await f.events()).some(e => e.type === "completion.evidence_rejected"));
});

test("unavailable mutation calls cannot bypass the mandatory review phase", { timeout: 15000 }, async t => {
  const f = await fixture(t, "Ask Codex once before editing, then fix calculate.js.", (request, n) => {
    assert.ok(!request.tools.some(tool => ["apply_patch", "write_file", "run_command"].includes(tool.function.name)));
    return turn("write_file", { path: "calculate.js", content: "forbidden", mode: "overwrite" }, n);
  });
  await fs.writeFile(path.join(f.root, "calculate.js"), "original\n");
  const result = await runAgent(f.config);
  assert.equal(result.reason, "tool_contract_violation"); assert.equal(launches, 0);
  assert.equal(await fs.readFile(path.join(f.root, "calculate.js"), "utf8"), "original\n");
});

test("loss of a persisted reservation acknowledgement cannot redispatch", { timeout: 15000 }, async t => {
  const f = await fixture(t, pureGoal, (_r, n) => turn("delegate_agent", review, n));
  const original = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState");
  let injected = false;
  Object.defineProperty(SessionStore.prototype, "saveState", { ...original, async value(state) {
    const result = await Reflect.apply(original.value, this, [state]);
    if (this.sessionId === "advisory-runtime" && state.meta?.advisoryInvocation?.attempt?.status === "reserved" && !injected) {
      injected = true; const error = new Error("Synthetic reservation acknowledgement loss"); error.code = "EIO"; throw error;
    }
    return result;
  } });
  try { await assert.rejects(runAgent(f.config), { code: "EIO" }); }
  finally { Object.defineProperty(SessionStore.prototype, "saveState", original); }
  assert.equal(launches, 0); assert.equal((await f.state()).meta.advisoryInvocation.attempt.status, "reserved");
  assert.equal((await runAgent({ ...f.config, resume: "advisory-runtime", goal: "Continue the same task." })).reason, "advisory_unavailable");
  assert.equal(launches, 0);
  assertBalanced((await f.state()).messages);
});

for (const scs of [false, true]) test(`advice precedes mutation and the primary verifies the fix (SCS ${scs})`, { timeout: 15000 }, async t => {
  const f = await fixture(t, "The calculation is wrong. Ask Codex once before editing, then fix the implementation and verify it. Keep package.json unchanged.", (_r, n) => {
    if (n === 1) return turn("read_file", { path: "calculate.js" }, n);
    if (n === 2) return turn("delegate_agent", { ...review, prompt: "Read-only: the supplied implementation exports 1; the required value is 2. Review the smallest correction." }, n);
    if (n === 3) return turn("apply_patch", { path: "calculate.js", search: "export const total = 1;", replace: "export const total = 2;" }, n);
    if (n === 4) return turn("run_command", { command: "node --test calculate.test.js" }, n);
    return turn("finish", { result: "The independent review suggested correcting the constant. I changed the implementation to 2 and verified it with node --test calculate.test.js; package.json is unchanged." }, n);
  });
  await fs.writeFile(path.join(f.root, "package.json"), '{"type":"module","private":true}\n');
  await fs.writeFile(path.join(f.root, "calculate.js"), "export const total = 1;\n");
  await fs.writeFile(path.join(f.root, "calculate.test.js"), 'import assert from "node:assert/strict"; import { total } from "./calculate.js"; assert.equal(total, 2);\n');
  outcomes = [{ code: 0, stdout: "Correct the implementation constant from 1 to 2, then execute the retained test. Do not alter the test or manifest." }];
  Object.assign(f.config, { scsActive: scs, enableScs: scs ? "on" : "off", scsValidationMode: "deterministic" });
  const result = await runAgent(f.config);
  assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(launches, 1);
  const starts = (await f.events()).filter(e => e.type === "tool.started").map(e => e.data.toolName);
  assert.ok(starts.indexOf("delegate_agent") < starts.indexOf("apply_patch"));
  assert.equal(await fs.readFile(path.join(f.root, "calculate.js"), "utf8"), "export const total = 2;\n");
  assert.equal(await fs.readFile(path.join(f.root, "package.json"), "utf8"), '{"type":"module","private":true}\n');
});

test("a persisted successful reply survives lost acknowledgement and fresh-process replay", { timeout: 20000 }, async t => {
  const f = await fixture(t, pureGoal, (_r, n) => turn("delegate_agent", review, n));
  outcomes = [{ code: 0, stdout: "The supplied expression evaluates to 6." }];
  const original = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState"); let injected = false;
  Object.defineProperty(SessionStore.prototype, "saveState", { ...original, async value(state) {
    const saved = await Reflect.apply(original.value, this, [state]);
    if (this.sessionId === "advisory-runtime" && state.meta?.advisoryInvocation?.attempt?.status === "settled" && !injected) {
      injected = true; const error = new Error("Synthetic successful-result acknowledgement loss"); error.code = "EIO"; throw error;
    }
    return saved;
  } });
  try { await assert.rejects(runAgent(f.config), { code: "EIO" }); }
  finally { Object.defineProperty(SessionStore.prototype, "saveState", original); }
  const before = (await f.state()).meta.advisoryInvocation;
  assert.equal(before.attempt.result.ok, true); assert.equal(launches, 1);
  closeSessionIndexConnections();
  const { stdout } = await promisify(nativeChild.execFile)(process.execPath,
    ["--experimental-test-module-mocks", new URL("./fixtures/advisory-replay-runtime.js", import.meta.url).pathname, f.root], {
      timeout: 12000, env: { PATH: process.env.PATH, HOME: path.join(f.root, "home"), LANG: "C.UTF-8",
        AGINTIFLOW_HOME: path.join(f.root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
    });
  const receipt = JSON.parse(stdout.trim());
  assert.equal(receipt.ok, true); assert.equal(receipt.reused, 1); assert.equal(receipt.newCliLaunches, 0);
  assert.equal(receipt.resultDigest, before.attempt.resultDigest);
  assert.equal((await f.state()).meta.advisoryInvocation.attempt.id, before.attempt.id);
});

for (const lostAck of [false, true]) test(`stopping an advisory batch leaves a valid continuation (lost result acknowledgement ${lostAck})`, { timeout: 15000 }, async t => {
  let reporting = false, reportCalls = 0;
  const f = await fixture(t, pureGoal, (_r, n) => {
    if (reporting) return ++reportCalls === 1 ? turn("read_file", { path: "context.txt" }, "report_read")
      : turn("finish", { result: lostAck ? "The independent advice completed and confirmed 6. The later planned read had no recorded outcome; I read context.txt now without changing it."
        : "The independent advice was unavailable. The later planned read had no recorded outcome; I read context.txt now without changing it." }, "report_finish");
    const response = turn("delegate_agent", review, n);
    response.choices[0].message.tool_calls.push(turn("read_file", { path: "context.txt" }, "queued").choices[0].message.tool_calls[0]);
    return response;
  });
  await fs.writeFile(path.join(f.root, "context.txt"), "Retained context.\n");
  if (lostAck) outcomes = [{ code: 0, stdout: "The supplied expression evaluates to 6." }];
  const original = Object.getOwnPropertyDescriptor(SessionStore.prototype, "saveState"); let injected = false;
  if (lostAck) Object.defineProperty(SessionStore.prototype, "saveState", { ...original, async value(state) {
    const value = await Reflect.apply(original.value, this, [state]);
    if (this.sessionId === "advisory-runtime" && state.meta?.advisoryInvocation?.attempt?.status === "settled" && !injected) {
      injected = true; const error = new Error("Synthetic batch acknowledgement loss"); error.code = "EIO"; throw error;
    }
    return value;
  } });
  try {
    if (lostAck) await assert.rejects(runAgent(f.config), { code: "EIO" });
    else assert.equal((await runAgent(f.config)).reason, "advisory_unavailable");
  } finally { Object.defineProperty(SessionStore.prototype, "saveState", original); }
  reporting = true;
  const result = await runAgent({ ...f.config, resume: "advisory-runtime", goal: "Read context.txt and explain the saved advisory outcome. Do not modify any file." });
  assert.notEqual(result.stopped, true, JSON.stringify(result)); assert.equal(launches, 1);
  const state = await f.state(); assertBalanced(state.messages);
  assert.ok(!state.messages.some(m => m.tool_call_id === "advisory_queued"), "a deferred call became a dispatched call");
  assert.ok((await f.events()).some(e => e.data?.deferredCount === 1 && e.data?.deferredTools?.includes("read_file")));
  assert.equal(await fs.readFile(path.join(f.root, "context.txt"), "utf8"), "Retained context.\n");
});
