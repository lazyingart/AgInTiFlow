import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import { repairModelMessageHistory, recordProjectVerificationOutcome } from "../src/agent-runner.js";
import { classifyCommand } from "../src/command-policy.js";
import { boundedNativeCommandCheckpointResult, buildScsEvidenceLedger, evaluateScsEvidence, nativeCommandVerificationDigest } from "../src/scs-evidence.js";

const childPath = new URL("./fixtures/native-tool-checkpoint-runtime.js", import.meta.url).pathname;
const note = "Latency improved from 120 ms to 90 ms.\n", summary = "# Summary\n\nLatency improved from 120 ms to 90 ms.\n";
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function assertClosed(messages) {
  const pending = new Set();
  for (const m of messages) {
    if (m.role === "tool") { assert.ok(pending.delete(m.tool_call_id)); continue; }
    assert.equal(pending.size, 0, "new message precedes native tool replies");
    for (const c of m.tool_calls || []) { assert.equal(pending.has(c.id), false); pending.add(c.id); }
  }
  assert.equal(pending.size, 0);
}

function confirmedPayloads(messages) {
  const calls = new Map(), results = [];
  for (const m of messages) {
    for (const c of m.tool_calls || []) calls.set(c.id, c.function.name);
    if (m.role === "tool") {
      const value = JSON.parse(m.content);
      if (value.ok === true) results.push({ ...value, toolName: calls.get(m.tool_call_id) });
    }
    if (m.role === "user" && typeof m.content === "string") {
      const match = /^Retained runtime tool evidence\.[^\n]*\nTool:\s*([^\n]+)\nArguments:\s*([^\n]+)\nVerified result:\s*([\s\S]+)$/.exec(m.content);
      if (match) {
        const value = JSON.parse(match[3]);
        if (value.ok === true) results.push({ ...value, toolName: match[1] });
      }
    }
  }
  return results;
}

const frame = (ids = ["completed_write"], name = "write_file") => ({ role: "assistant", content: null,
  tool_calls: ids.map(id => ({ id, type: "function", function: { name, arguments: '{"path":"summary.md"}' } })) });
const outcome = (id = "completed_write", payload = { ok: true, path: "summary.md", changed: true, goalRevision: 1, projectMutationRevision: 2 }) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(payload) });

test("reasoning-incompatible complete frames retain bounded confirmed evidence", () => {
  const state = { messages: [{ role: "system", content: "Native runtime" }, frame(), outcome(), { role: "user", content: "Continue" }] };
  const result = repairModelMessageHistory(state, { provider: "deepseek" });
  assert.equal(result.changed, true); assertClosed(state.messages);
  assert.equal(state.messages.some(m => m.role === "assistant" || m.role === "tool"), false);
  const proofs = confirmedPayloads(state.messages); assert.equal(proofs.length, 1);
  assert.equal(proofs[0].toolName, "write_file"); assert.equal(proofs[0].path, "summary.md");
  assert.equal(state.messages.at(-1).content, "Continue");
});

test("incomplete native frames never manufacture a retained result", () => {
  const state = { messages: [frame(["one", "two"]), outcome("one"), { role: "user", content: "Continue" }] };
  const result = repairModelMessageHistory(state, { provider: "deepseek" });
  assert.equal(result.incompleteToolCallMessages, 1); assert.deepEqual(confirmedPayloads(state.messages), []);
  assert.equal(state.messages.some(m => m.role === "assistant" || m.role === "tool"), false);
});

test("duplicate or foreign results cannot become confirmed retained evidence", () => {
  for (const extra of [outcome(), outcome("foreign")]) {
    const state = { messages: [frame(), outcome(), extra] };
    repairModelMessageHistory(state, { provider: "deepseek" });
    assert.deepEqual(confirmedPayloads(state.messages), []);
  }
  const duplicateIds = { messages: [frame(["same", "same"]), outcome("same")] };
  repairModelMessageHistory(duplicateIds, { provider: "deepseek" });
  assert.deepEqual(confirmedPayloads(duplicateIds.messages), []);
});

test("failed, blocked and skipped outcomes do not become successful evidence", () => {
  for (const payload of [{ ok: false }, { ok: true, blocked: true }, { ok: true, skipped: true }]) {
    const state = { messages: [frame(), outcome(undefined, payload)] };
    repairModelMessageHistory(state, { provider: "deepseek" }); assert.deepEqual(confirmedPayloads(state.messages), []);
  }
});

test("compatible DeepSeek and ordinary OpenAI native frames remain native", () => {
  for (const provider of ["deepseek", "openai"]) {
    const a = frame(); if (provider === "deepseek") a.reasoning_content = "Use the source file.";
    const reply = outcome(), state = { messages: [a, reply] };
    const result = repairModelMessageHistory(state, { provider });
    assert.equal(result.changed, false); assert.equal(state.messages[1], reply);
    assert.equal(state.messages[0].tool_calls[0].id, "completed_write");
    assert.equal(state.messages[0].reasoning_content, a.reasoning_content);
  }
});

test("retained read output uses existing bounded compaction rather than raw output", () => {
  const state = { messages: [frame(undefined, "read_file"), outcome(undefined, { ok: true, path: "summary.md", content: "Z".repeat(100000), bytes: 100000 })] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  const proofs = confirmedPayloads(state.messages); assert.equal(proofs.length, 1); assert.ok(proofs[0].content.length < 4000);
  assert.ok(JSON.stringify(state.messages).length < 7000);
});

test("unsupported tool data is not promoted into retained text", () => {
  const state = { messages: [frame(undefined, "unknown_native_tool"), outcome(undefined, { ok: true, stdout: "UNTRUSTED_RESULT" })] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  assert.deepEqual(state.messages, []);
});

test("retained mutation evidence preserves exact recorded scope revisions", () => {
  const state = { messages: [frame(), outcome()] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  const [proof] = confirmedPayloads(state.messages); assert.equal(proof.goalRevision, 1); assert.equal(proof.projectMutationRevision, 2);
  assert.equal(proof.changed, true); assert.equal(proof.path, "summary.md");
});

for (const mode of ["crash", "event-checkpoint-crash", "change-checkpoint-crash", "result-event-save-error", "read-batch-event-checkpoint-crash", "read-batch", "callback-error", "save-error", "normal", "event-error", "event-async-error", "change-error", "event-hostile-error", "read-batch-event-error", "read-batch-async-error", "log-async-error", "observer-abort", "start-event-error", "start-async-error"]) test(`completed native batch checkpoint: ${mode}`, { timeout: 25000 }, async t => {
  const readBatch = mode.startsWith("read-batch"), preDispatch = mode.startsWith("start-"), checkpointBoundary = mode.includes("checkpoint-crash") || mode === "result-event-save-error";
  const deliveryError = !preDispatch && !checkpointBoundary && !["crash", "read-batch", "normal", "save-error", "observer-abort"].includes(mode);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-tool-checkpoint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/note.txt", note); await fs.writeFile(root + "/workspace/other.txt", "Other note remains open.\n");
  const session = root + "/sessions/tool-checkpoint-" + mode; let step = 0, phase = "start"; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); assertClosed(body.messages);
      let message;
      if (!body.tools) message = { content: "Read the supplied note, complete the requested task, verify and finish." };
      else {
        step++;
        if (phase === "resume") {
          const proofs = confirmedPayloads(body.messages);
          const requiredPaths = readBatch ? ["note.txt", "other.txt"] : ["summary.md"];
          for (const target of requiredPaths) assert.ok(proofs.some(p => p.path === target && (readBatch ? p.toolName === "read_file" : ["write_file", "apply_patch"].includes(p.toolName))), "confirmed completed outcome absent: " + target);
          message = step === 1 && !readBatch ? { tool_calls: [call("read_file", { path: "summary.md" }, "resume_verify")] }
            : { tool_calls: [call("finish", { result: readBatch ? "The first note reports latency improving from 120 ms to 90 ms; the other note remains open." : "Saved summary.md with the latency improvement from 120 ms to 90 ms; note.txt is unchanged." }, "resume_finish")] };
        } else if (step === 1) {
          message = { tool_calls: [call("read_file", { path: "note.txt" }, "checkpoint_read")] };
          if (readBatch) message.tool_calls.push(call("read_file", { path: "other.txt" }, "checkpoint_other"));
        } else if (step === 2 && !readBatch) {
          const write = body.tools.some(t => t.function.name === "write_file") ? call("write_file", { path: "summary.md", content: summary, mode: "create" }, "checkpoint_write")
            : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: summary.md\n" + summary.trimEnd().split("\n").map(x => "+" + x).join("\n") + "\n*** End Patch" }, "checkpoint_write");
          message = { tool_calls: [write, call("read_file", { path: "summary.md" }, "deferred_verify")] };
        } else message = { tool_calls: [call("finish", { result: "Saved summary.md with the latency improvement from 120 ms to 90 ms; note.txt is unchanged." }, "normal_finish")] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(e.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline checkpoint fixture rejected request"}}'); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [childPath, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", expired = false; c.stdout.on("data", x => stdout += x); c.stderr.on("data", x => stderr += x);
    const timer = setTimeout(() => { expired = true; c.kill("SIGKILL"); }, 12000);
    c.once("error", reject); c.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, expired, stdout, stderr }); });
  });
  const first = await run(); assert.equal(first.expired, false); assert.deepEqual(errors, []);
  let state = JSON.parse(await fs.readFile(session + "/state.json"));
  const firstStep = step;
  const firstOutput = checkpointBoundary && !readBatch ? await fs.stat(root + "/workspace/summary.md", { bigint: true }) : null;
  const firstEvidence = { first, results: state.messages.filter(m => m.role === "tool"),
    summaryBytes: readBatch || preDispatch ? null : await fs.readFile(root + "/workspace/summary.md", "utf8") };
  if (mode.includes("error") && mode !== "save-error") assert.doesNotMatch(first.stderr, /unhandled|Synthetic.*observer failure\n\s+at/, "observer rejection must be reported by the runtime, not escape the process");
  if (["crash", "read-batch"].includes(mode) || mode.endsWith("checkpoint-crash")) assert.equal(first.signal, "SIGKILL");
  else assert.equal(first.code, ["normal", "observer-abort"].includes(mode) ? 0 : 1, JSON.stringify(firstEvidence));
  if (preDispatch) {
    assert.equal(step, 2); assert.equal(first.stderr, "");
    await assert.rejects(fs.stat(root + "/workspace/summary.md"), { code: "ENOENT" });
    assert.equal(state.messages.some(m => m.tool_call_id === "checkpoint_write"), false);
    const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.some(e => e.type === "file.changed" || e.type === "session.finished" || e.type === "tool.failed"), false);
    assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
    await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
    return;
  }
  assertClosed(state.messages);
  if (mode === "event-checkpoint-crash") {
    const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName) && e.data.ok === true).length, 1);
    assert.equal(firstEvidence.summaryBytes, summary);
    assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
    assert.ok(state.messages.some(m => m.role === "tool" && m.tool_call_id === "checkpoint_write"), "durable tool event and file exist, but native state lost the confirmed result: " + JSON.stringify(firstEvidence));
  }
  if (mode === "result-event-save-error") {
    const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.some(e => e.type === "tool.failed"), false, "result publication failure must not contradict the confirmed tool outcome");
    assert.equal(events.some(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName)), false);
    await assert.rejects(fs.stat(root + "/post-result-callback.json"), { code: "ENOENT" });
    assert.equal(JSON.parse(first.stdout.trim().split("\n").at(-1)).error.code, "EIO");
  }
  const required = readBatch ? ["checkpoint_read", "checkpoint_other"] : ["checkpoint_write"];
  for (const id of required) assert.equal(state.messages.filter(m => m.role === "tool" && m.tool_call_id === id && JSON.parse(m.content).ok === true).length, 1, "completed outcome must be retained exactly once after callback/death: " + id);
  assert.ok(state.stepsCompleted >= (readBatch ? 1 : 2));
  if (mode === "observer-abort") {
    const report = JSON.parse(first.stdout.trim().split("\n").at(-1));
    assert.equal(report.reason, "user_interrupt"); assert.equal(report.observerAbortListeners, 0);
    assert.equal(step, 2); assert.equal(state.meta.goalContract.status, "paused");
  }
  if (deliveryError) {
    const report = JSON.parse(first.stdout.trim().split("\n").at(-1));
    assert.equal(report.error.code, "OBSERVER_DELIVERY_FAILED"); assert.equal(report.observerTrapReads, 0);
    assert.equal(step, readBatch ? 1 : 2, "delivery failure must stop before another provider request");
    assert.doesNotMatch(JSON.stringify(state), /CALLBACK_PRIVATE_SENTINEL/);
    const savedEvents = await fs.readFile(session + "/events.jsonl", "utf8");
    assert.doesNotMatch(savedEvents, /CALLBACK_PRIVATE_SENTINEL/);
    assert.equal(savedEvents.split("\n").filter(Boolean).map(JSON.parse).some(e => e.type === "tool.failed"), false, "callback failure is not a failed tool");
  }
  if (mode === "save-error") await assert.rejects(fs.stat(root + "/post-result-callback.json"), { code: "ENOENT" });
  if (mode !== "normal") {
    const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.some(e => e.type === "session.finished"), false);
    phase = "resume"; step = 0; const resumed = await run(); assert.equal(resumed.code, 0, JSON.stringify({ resumed, errors })); assert.deepEqual(errors, []);
    assert.equal(JSON.parse(resumed.stdout.trim().split("\n").at(-1)).stopped, undefined);
  }
  state = JSON.parse(await fs.readFile(session + "/state.json")); assertClosed(state.messages); assert.equal(state.meta.goalContract.status, "completed");
  const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.started" && ["write_file", "apply_patch"].includes(e.data.toolName)).length, readBatch ? 0 : 1);
  if (!readBatch) assert.equal(await fs.readFile(root + "/workspace/summary.md", "utf8"), summary);
  assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
  if (checkpointBoundary) {
    if (firstOutput) {
      const after = await fs.stat(root + "/workspace/summary.md", { bigint: true });
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[key], firstOutput[key], "resume must not republish confirmed output: " + key);
    }
    t.diagnostic(JSON.stringify({ checkpointBoundary: mode, realChildProcesses: 2, firstExitCode: first.code, firstExitSignal: first.signal, actualProviderRequests: 0, scriptedStartTurns: firstStep, scriptedResumeTurns: step, confirmedResultsRetained: required.length, completedGoal: true, producerCalls: readBatch ? 0 : 1, sourceUnchanged: true, outputIdentityUnchanged: Boolean(firstOutput), scope: "Actual process-death/publication-failure regression with scripted provider; not power-loss or generic exactly-once effects" }));
  }
  await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
});

test("native command checkpoint redaction is canonical at every text boundary", () => {
  const base = { toolName: "run_command", ok: true, exitCode: 0, goalRevision: 1, projectMutationRevision: 0 };
  const roundtrip = value => boundedNativeCommandCheckpointResult({ ...value,
    commandPolicy: { noMatchExitIsSuccess: value.noMatchExitIsSuccess } });
  for (const [field, limit] of [["stdout", 1800], ["stderr", 1200], ["authoritativeRoutineId", 128], ["authoritativeRoutineOutcome", 32]]) {
    for (const character of ["x", "界", "🙂"]) for (let shift = 0; shift < 24; shift++) {
      const value = boundedNativeCommandCheckpointResult({ ...base, [field]: character.repeat(limit - shift) + "\ntoken: string\n" });
      assert.deepEqual(roundtrip(value), value, `${field} boundary ${shift} ${character}`);
      assert.deepEqual(roundtrip(roundtrip(value)), value);
      assert.ok(Array.from(value[field]).length <= limit);
    }
  }
  const goal = "Observe the supplied command.", command = "node probe.mjs";
  const state = { goal, messages: [], meta: { goalContract: { revision: 1, taskBoundaryRevision: 1, taskGoal: goal, history: [] }, projectVerification: { mutationRevision: 0 } } };
  const result = { ...base, args: { command }, stdout: "x".repeat(1787) + "\ntoken: string\n", stderr: "", commandPolicy: classifyCommand(command) };
  recordProjectVerificationOutcome(state, result, { taskProfile: "auto", commandCwd: process.cwd() });
  const run = state.meta.projectVerification.commandRuns.at(-1), hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(result));
  run.nativeResultCheckpoint = { schemaVersion: 2, toolCallId: "redaction_probe", taskHash: hash(goal), runSha256: nativeCommandVerificationDigest(run), resultSha256: hash(resultJson), resultJson };
  const read = { type: "tool.completed", data: { toolName: "read_file", ok: true, args: { path: "probe.mjs" }, path: "probe.mjs" } };
  const ledger = buildScsEvidenceLedger({ state, context: { events: [read] } });
  assert.equal(ledger.items.filter(item => item.source === "native-command-checkpoint").length, 1);
  assert.equal(evaluateScsEvidence({ requiredProjectCommands: [command] }, ledger).ok, true);
});

for (const [name, stdout, success] of [
  ["trailing success beyond bounded output", "x".repeat(2000) + "\nEXIT:0", true],
  ["earlier success marker before final failure", "x".repeat(1792) + "\nEXIT:0\n" + "y".repeat(500) + "\nEXIT:7", false],
]) test(`native command checkpoint preserves ${name}`, () => {
  const command = "node probe.mjs; echo EXIT:$?", goal = "Observe the supplied command.";
  const state = { goal, messages: [], meta: { goalContract: {
    revision: 1, taskBoundaryRevision: 1, taskGoal: goal, history: [],
  }, projectVerification: { mutationRevision: 0 } } };
  const result = { toolName: "run_command", args: { command }, ok: true, exitCode: 0,
    stdout, stderr: "", commandPolicy: classifyCommand(command) };
  recordProjectVerificationOutcome(state, result, { taskProfile: "auto", commandCwd: process.cwd() });
  const run = state.meta.projectVerification.commandRuns.at(-1);
  assert.equal(run.ok, success); assert.equal(run.explicitExitStatus, success ? 0 : 7);
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const resultJson = JSON.stringify(boundedNativeCommandCheckpointResult(result));
  run.nativeResultCheckpoint = { schemaVersion: 2, toolCallId: "status_probe", taskHash: hash(goal),
    runSha256: nativeCommandVerificationDigest(run), resultSha256: hash(resultJson), resultJson };
  const read = { type: "tool.completed", data: { toolName: "read_file", ok: true, args: { path: "probe.mjs" }, path: "probe.mjs" } };
  const recover = candidate => buildScsEvidenceLedger({ state: candidate, context: { events: [read] } });
  const published = buildScsEvidenceLedger({ state, context: { events: [read, { type: "tool.completed", data: result }] } });
  const contract = { requiredProjectCommands: ["node probe.mjs"], projectMutationRevision: run.mutationRevision };
  assert.equal(evaluateScsEvidence(contract, published).ok, success);
  const recovered = recover(state);
  assert.equal(evaluateScsEvidence(contract, recovered).ok, success, "bounded output cannot reinterpret the native command outcome");
  assert.equal(recovered.items.find(item => item.source === "native-command-checkpoint").explicitExitStatus, run.explicitExitStatus);
  for (const invalid of [undefined, null, "0"]) {
    const candidate = structuredClone(state), record = candidate.meta.projectVerification.commandRuns.at(-1);
    if (invalid === undefined) delete record.explicitExitStatus;
    else record.explicitExitStatus = invalid;
    record.nativeResultCheckpoint.runSha256 = nativeCommandVerificationDigest(record);
    assert.equal(evaluateScsEvidence(contract, recover(candidate)).ok, false, "missing or noninteger native status is not success");
  }
});

for (const mode of [
  "command-event-checkpoint-crash", "command-result-event-save-error", "command-event-async-error",
  "command-log-async-error", "command-save-error", "command-start-event-error", "command-normal",
  "command-failed-event-checkpoint-crash", "command-result-event-save-error-pre-read",
  "command-result-event-save-error-no-reasoning", "command-result-event-save-error-pre-read-no-reasoning",
  "command-no-match-event-checkpoint-crash", "command-no-match-result-event-save-error",
  "command-result-event-save-error-pre-read-long-argv", "command-inner-failure-event-checkpoint-crash",
  "command-test-result-event-save-error-pre-read-no-reasoning",
]) test(`completed command checkpoint: ${mode}`, { timeout: 30000 }, async t => {
  const beforeDispatch = mode === "command-start-event-error", nonzero = mode.startsWith("command-failed-");
  const preRead = mode.includes("-pre-read"), noReasoning = mode.includes("-no-reasoning"), firstCommandStep = preRead ? 2 : 1;
  const noMatch = mode.startsWith("command-no-match-"), longArgv = mode.includes("-long-argv");
  const innerFailure = mode.startsWith("command-inner-failure-"), checkerFailed = nonzero || innerFailure;
  const realTest = mode.startsWith("command-test-");
  let workerPid;
  const command = () => noMatch ? `pgrep -P ${workerPid} -x acp_nomatch` : (realTest ? "npm test" : "node check.mjs") + (longArgv ? " '" + "x".repeat(65536) + "'" : innerFailure ? "; echo EXIT:$?" : "");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-command-checkpoint-"));
  const workspace = path.join(root, "workspace"), session = path.join(root, "sessions", "tool-checkpoint-" + mode);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(workspace);
  const body = 'fs.appendFileSync("executions.log", "executed\\n");\nfs.writeFileSync("measurement.txt", "observed count 7\\n", { flag: "wx" });\nconsole.log("observed count 7");\n';
  const source = 'import fs from "node:fs";\n' + (realTest
    ? 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("measurement check", () => {\n' + body + 'assert.equal(7, 7);\n});\n'
    : body + (checkerFailed ? 'console.error("checker returned nonzero");\nprocess.exitCode = 7;\n' : ''));
  await fs.writeFile(path.join(workspace, "check.mjs"), source);
  if (realTest) await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "checkpoint-fixture", version: "0.0.0", private: true, scripts: { test: "node --test check.mjs" } }));
  let phase = "start", requests = 0, observedStdout;
  const errors = [], children = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks)); assertClosed(body.messages);
      let message;
      if (!body.tools) message = { content: "Use the supplied local check once, then report its actual result." };
      else {
        requests++;
        if (phase === "resume") {
          const results = noReasoning || longArgv ? confirmedPayloads(body.messages).filter(p => p.toolName === "run_command") : body.messages.filter(m => m.role === "tool" && m.tool_call_id === "checkpoint_command").map(m => JSON.parse(m.content));
          if (longArgv && results.length !== 1) {
            const compacted = body.messages.filter(m => m.role === "user").map(m => String(m.content || "")).join("\n");
            assert.match(compacted, /stdout[=:][^\n]{0,16}observed count 7/u, "compaction must retain the observed output, not only the checker source: " + compacted.slice(-1600));
            assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) < 100000);
          } else {
            assert.equal(results.length, 1, "fresh process must receive the exact closed command result");
            assert.equal(results[0].ok, !nonzero); assert.equal(results[0].exitCode, noMatch ? 1 : nonzero ? 7 : 0);
            assert.equal(results[0].stdout || "", realTest ? observedStdout : noMatch ? "" : innerFailure ? "observed count 7\nEXIT:7" : "observed count 7");
            assert.equal(results[0].stderr || "", checkerFailed ? "checker returned nonzero" : "");
          }
        }
        message = phase === "start" && preRead && requests === 1
          ? { tool_calls: [call("read_file", { path: "check.mjs" }, "read_checker")] }
          : phase === "start" && requests === firstCommandStep
          ? { tool_calls: [call("run_command", { command: command() }, "checkpoint_command")] }
          : { tool_calls: [call("finish", { result: noMatch ? "There were no matching child processes named acp_nomatch." : checkerFailed ? "The checker reported observed count 7 and exited with code 7; the check did not pass." : "The check reported observed count 7 and exited successfully." }, "command_finish")] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...(noReasoning ? {} : { reasoning_content: "Run only the requested checker and report its observed outcome." }), ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline command checkpoint request refused"}}'); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error("Owned checkpoint worker did not close during cleanup")), 2000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGKILL");
    })));
  });
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    workerPid = child.pid;
    children.add(child); let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, expired, stdout, stderr }); });
  });
  const first = await run(); assert.equal(first.expired, false, JSON.stringify(first)); assert.deepEqual(errors, []);
  let state = JSON.parse(await fs.readFile(path.join(session, "state.json"))), events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const resultMessages = () => state.messages.filter(m => m.role === "tool" && m.tool_call_id === "checkpoint_command");
  if (beforeDispatch) {
    assert.equal(first.code, 1, JSON.stringify(first)); assert.equal(requests, 1);
    await assert.rejects(fs.stat(path.join(workspace, "executions.log")), { code: "ENOENT" });
    assert.equal(resultMessages().length, 0); assert.equal(events.some(e => e.type === "tool.completed"), false);
    return;
  }
  if (noMatch) await assert.rejects(fs.stat(path.join(workspace, "executions.log")), { code: "ENOENT" });
  else {
    const executions = await fs.readFile(path.join(workspace, "executions.log"), "utf8").catch(() => assert.fail(JSON.stringify({ first, requests, toolEvents: events.filter(e => e.type.startsWith("tool.")).map(e => ({ type: e.type, data: e.data })) })));
    assert.equal(executions, "executed\n", JSON.stringify(first));
    assert.equal(await fs.readFile(path.join(workspace, "measurement.txt"), "utf8"), "observed count 7\n");
  }
  const observedFile = noMatch ? "check.mjs" : "measurement.txt";
  const outputIdentity = await fs.stat(path.join(workspace, observedFile), { bigint: true });
  assert.equal(resultMessages().length, 1, "command effect/result event exists but saved native frame lost its completed result: " + JSON.stringify({ first, requests, toolResults: resultMessages(), completedEvents: events.filter(e => e.type === "tool.completed").map(e => ({ toolName: e.data.toolName, ok: e.data.ok })) }));
  const payload = JSON.parse(resultMessages()[0].content);
  assert.equal(payload.ok, !nonzero); assert.equal(payload.exitCode, noMatch ? 1 : nonzero ? 7 : 0);
  if (realTest) { assert.match(payload.stdout, /# pass 1\b/u); assert.match(payload.stdout, /# fail 0\b/u); observedStdout = payload.stdout; }
  else assert.equal(payload.stdout, noMatch ? "" : innerFailure ? "observed count 7\nEXIT:7" : "observed count 7");
  assert.equal(payload.stderr, checkerFailed ? "checker returned nonzero" : "");
  const storedRun = state.meta.projectVerification.commandRuns.at(-1);
  if (noMatch) { assert.equal(storedRun.ok, false); assert.equal(payload.noMatch, true); }
  if (innerFailure) { assert.equal(payload.ok, true); assert.equal(payload.exitCode, 0); assert.equal(storedRun.ok, false); assert.equal(storedRun.explicitExitStatus, 7); }
  if (realTest) {
    assert.equal(payload.projectTest.passed, true);
    const recovered = buildScsEvidenceLedger({ state, context: { events } }).items.filter(item => item.source === "native-command-checkpoint");
    assert.deepEqual(recovered.map(item => item.category).sort(), ["command", "test"]);
  }
  if (longArgv) {
    assert.ok(Buffer.byteLength(resultMessages()[0].content) > 131072, "regression must exceed the old full-result reader cap");
    assert.ok(Buffer.byteLength(storedRun.nativeResultCheckpoint.resultJson) < 16384, "recovery metadata must be bounded independently of argv length");
    assert.equal(JSON.parse(storedRun.nativeResultCheckpoint.resultJson).args, undefined);
  }
  assertClosed(state.messages);
  if (mode === "command-result-event-save-error-pre-read-no-reasoning") {
    const checkpointItems = (candidate, observed = events) => buildScsEvidenceLedger({ state: candidate, context: { events: observed } }).items.filter(item => item.source === "native-command-checkpoint");
    assert.equal(checkpointItems(state).length, 1, "saved native command record must supply the missing observation even beside earlier mirrored reads");
    const updatePayload = (candidate, change) => {
      const cp = candidate.meta.projectVerification.commandRuns.at(-1).nativeResultCheckpoint;
      const parsed = JSON.parse(cp.resultJson); change(parsed); cp.resultJson = JSON.stringify(parsed);
      cp.resultSha256 = crypto.createHash("sha256").update(cp.resultJson).digest("hex");
    };
    const cpFor = candidate => candidate.meta.projectVerification.commandRuns.at(-1).nativeResultCheckpoint;
    const attacks = [
      candidate => { delete candidate.meta.projectVerification.commandRuns.at(-1).nativeResultCheckpoint; },
      candidate => { cpFor(candidate).schemaVersion = 3; },
      candidate => { cpFor(candidate).taskHash = "a".repeat(64); },
      candidate => { cpFor(candidate).resultJson += " "; },
      candidate => { cpFor(candidate).extra = true; },
      candidate => { Object.defineProperty(cpFor(candidate), "toolCallId", { enumerable: false }); },
      candidate => { Object.setPrototypeOf(cpFor(candidate), { inherited: true }); },
      candidate => { cpFor(candidate)[Symbol("extra")] = true; },
      candidate => { updatePayload(candidate, item => { item.goalRevision = 0; }); },
      candidate => { updatePayload(candidate, item => { item.goalRevision = 9; }); },
      candidate => { updatePayload(candidate, item => { item.projectMutationRevision++; }); },
      candidate => { candidate.meta.projectVerification.commandRuns.at(-1).command = "node another-check.mjs"; },
      candidate => { updatePayload(candidate, item => { item.ok = false; }); },
      candidate => { updatePayload(candidate, item => { item.exitCode = 7; }); },
      candidate => { updatePayload(candidate, item => { item.blocked = true; }); },
      candidate => { updatePayload(candidate, item => { item.skipped = true; }); },
      candidate => { updatePayload(candidate, item => { item.projectTest = { passed: true, mutationRevision: item.projectMutationRevision }; }); },
      candidate => { candidate.meta.goalContract.taskGoal = "An unrelated new task"; },
      candidate => { candidate.meta.goalContract.revision = 2; candidate.meta.goalContract.taskBoundaryRevision = 2; },
      candidate => { candidate.meta.goalContract.revision = 2; },
      candidate => { candidate.meta.goalContract.revision = 2; candidate.meta.goalContract.history.push({ revision: 2, kind: "same-task-continuation" }); },
    ];
    for (const [index, attack] of attacks.entries()) {
      const candidate = structuredClone(state); attack(candidate);
      assert.equal(checkpointItems(candidate).length, 0, "invalid native command receipt accepted: " + index);
    }
    let traps = 0;
    for (const kind of ["proxy", "accessor"]) {
      const candidate = structuredClone(state), original = cpFor(candidate);
      if (kind === "proxy") candidate.meta.projectVerification.commandRuns.at(-1).nativeResultCheckpoint = new Proxy(original, { get() { traps++; throw new Error("receipt trap"); }, ownKeys() { traps++; throw new Error("receipt trap"); } });
      else Object.defineProperty(original, "resultJson", { enumerable: true, get() { traps++; throw new Error("receipt trap"); } });
      assert.equal(checkpointItems(candidate).length, 0);
    }
    assert.equal(traps, 0);
    const continued = structuredClone(state); continued.meta.goalContract.revision = 2;
    continued.meta.goalContract.history.push({ revision: 2, relation: "same-task", taskHash: cpFor(continued).taskHash });
    assert.equal(checkpointItems(continued).length, 1);
    const duplicated = structuredClone(state); duplicated.meta.projectVerification.commandRuns.push(structuredClone(duplicated.meta.projectVerification.commandRuns.at(-1)));
    assert.equal(checkpointItems(duplicated).length, 1);
    assert.equal(checkpointItems(state, [...events, { type: "tool.completed", data: payload }]).length, 0, "published result must not be counted twice");
    const ordered = structuredClone(state); ordered.meta.projectVerification.commandRuns.at(-1).command = "git push";
    cpFor(ordered).runSha256 = nativeCommandVerificationDigest(ordered.meta.projectVerification.commandRuns.at(-1));
    updatePayload(ordered, item => { item.stdout = "published and deployed"; });
    const projected = checkpointItems(ordered); assert.equal(projected.length, 1); assert.equal(projected[0].category, "command");
    t.diagnostic(JSON.stringify({ nativeCommandReceiptAttacksRejected: attacks.length + 2, receiptTrapCalls: traps, mirroredResultDeduplicated: true, sameTaskContinuationBound: true, gitOrPublishEvidencePromoted: false }));
  }
  if (mode.endsWith("checkpoint-crash")) assert.equal(first.signal, "SIGKILL");
  else if (mode === "command-normal") assert.equal(first.code, 0, JSON.stringify(first));
  else {
    assert.equal(first.code, 1, JSON.stringify(first));
    assert.equal(requests, firstCommandStep, "publication/delivery failure must stop before another provider request");
    assert.equal(events.some(e => e.type === "tool.failed"), false, "publication failure cannot falsify the completed command result");
    const report = JSON.parse(first.stdout.trim().split("\n").at(-1));
    assert.equal(report.error.code, mode.includes("async-error") ? "OBSERVER_DELIVERY_FAILED" : "EIO");
  }
  if (mode !== "command-normal") {
    assert.equal(events.some(e => e.type === "session.finished"), false);
    phase = "resume"; requests = 0;
    const resumed = await run(); assert.equal(resumed.code, 0, JSON.stringify({ resumed, errors })); assert.deepEqual(errors, []);
    if (nonzero) {
      assert.equal(JSON.parse(resumed.stdout.trim().split("\n").at(-1)).stopped, true, "a failed checker must not become successful completion");
      assert.ok(requests <= 2, "an uncorrected failed checker must remain a bounded refusal");
    } else assert.equal(requests, 1, "resume should use the saved observation without repeating work or a completion-repair loop");
  }
  state = JSON.parse(await fs.readFile(path.join(session, "state.json")));
  if (nonzero) assert.notEqual(state.meta.goalContract.status, "completed");
  else assert.equal(state.meta.goalContract.status, "completed");
  assertClosed(state.messages);
  if (noMatch) await assert.rejects(fs.stat(path.join(workspace, "executions.log")), { code: "ENOENT" });
  else assert.equal(await fs.readFile(path.join(workspace, "executions.log"), "utf8"), "executed\n");
  assert.equal(await fs.readFile(path.join(workspace, "check.mjs"), "utf8"), source);
  const finalIdentity = await fs.stat(path.join(workspace, observedFile), { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(finalIdentity[key], outputIdentity[key]);
  events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.started" && e.data.toolName === "run_command").length, 1);
  if (nonzero) assert.equal(events.some(e => e.type === "session.finished"), false);
  await assert.rejects(fs.stat(path.join(session, ".agent-run.lock")), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, actualProviderRequests: 0, commandExecutions: 1, exitCode: payload.exitCode, confirmedResultRetained: true, sourceUnchanged: true, outputIdentityUnchanged: true, resumed: mode !== "command-normal" }));
});
