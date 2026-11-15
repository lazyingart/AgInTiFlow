import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";
const fixture = new URL("./fixtures/native-precompletion-cancellation.js", import.meta.url).pathname;
const cases = [
  ...["review", "inbox"].flatMap(boundary => ["deterministic", "model"].flatMap(v => ["assistant", "finish"].map(c => `${boundary}:${v}:${c}`))),
  ...["reject", "assessed", "model", "files"].flatMap(boundary => ["assistant", "finish"].map(c => `${boundary}:${boundary === "reject" || boundary === "files" ? "model" : "deterministic"}:${c}`)),
  "response-repair:deterministic:response", "post:model:assistant", "post:deterministic:finish", "inflight:model:finish",
];
const bounded = (promise, ms = 5000) => {
  let timer;return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Bounded cancellation fixture deadline")), ms); })]).finally(() => clearTimeout(timer));
};
for (const scenario of cases) test(`native pre-completion cancellation: ${scenario}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-precompletion-cancel-"));await fs.mkdir(root + "/workspace");
  const [boundary, validation, completion] = scenario.split(":"), errors = [], requests = [], children = [];
  let phase = "start", writes = 0, responseTurns = 0, currentChild, abortedResponseResolve;
  const abortedResponse = new Promise(resolve => { abortedResponseResolve = resolve; });
  const call = (name, args) => ({ id: "scoped_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const server = http.createServer(async (req, res) => {
    try {
      const parts = [];let total = 0;for await (const b of req) { total += b.length;assert.ok(total < 1024 * 1024);parts.push(b); }
      const body = JSON.parse(Buffer.concat(parts));assert.ok(requests.length < 12);
      const system = String(body.messages?.[0]?.content || ""), review = !body.tools && system.includes("SCS student final gate");
      requests.push({ phase, review, execution: Boolean(body.tools), model: body.model });
      if (boundary === "inflight" && review) {
        res.once("close", () => abortedResponseResolve(!res.writableEnded));currentChild.send({ action: "cancel" });return;
      }
      const text = boundary === "files" ? "Saved result.md with the requested content."
        : "I have no recorded previous result to explain. I did not run or edit anything.";
      let message;
      if (boundary === "response-repair") message = { content: responseTurns++ ? '{"reply":"Stopping prevents new actions."}' : '{"unexpected":"invalid shape"}' };
      else if (review) message = { content: JSON.stringify({ role: "student", decision: boundary === "reject" ? "finish_rejected" : "finish_allowed", confidence: 0.99, evidence: ["Recorded native result"], reason: "Bounded final review", next_required_action: boundary === "reject" ? "clarify" : "finish" }) };
      else if (!body.tools && system.includes("SCS committee planner")) message = { content: JSON.stringify({ role: "committee", phase_goal: "Complete the bounded request", plan: "Use only the requested tool and verify the result.", acceptance_criteria: ["Truthful final result"], allowed_tools: ["write_file", "finish"], stop_conditions: ["Stop when cancelled"] }) };
      else if (!body.tools) message = { content: JSON.stringify({ role: "student", decision: system.includes("independent SCS student validator") ? "approve_plan" : "accept_phase", confidence: 0.99, evidence: ["Native observations"], reason: "Bounded progression", next_required_action: "continue" }) };
      else if (boundary === "files" && phase === "start" && !writes++) {
        const offered = body.tools.map(tool => tool.function.name);
        message = { tool_calls: [offered.includes("write_file") ? call("write_file", { path: "result.md", content: "confirmed\n", mode: "create" })
          : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: result.md\n+confirmed\n*** End Patch" })] };
      } else message = completion === "assistant" ? { content: text } : { tool_calls: [call("finish", { result: text })] };
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(e.message);res.writeHead(400);res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ closed }) => bounded(closed.catch(() => {}))));
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });await assert.rejects(fs.stat(root), { code: "ENOENT" });
  });
  const run = async () => {
    const child = spawn(process.execPath, [fixture, root, "http://127.0.0.1:" + server.address().port + "/v1", scenario, phase], {
      cwd: root + "/workspace", env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });currentChild = child;let output = "", stderr = "";child.stdout.on("data", b => output += b);child.stderr.on("data", b => stderr += b);
    const closed = new Promise((resolve, reject) => { child.once("error", reject);child.once("close", (code, signal) => resolve({ code, signal })); });closed.catch(() => {});children.push({ child, closed });
    const exit = await bounded(closed, 18000);assert.equal(exit.signal, null);assert.equal(exit.code, 0, stderr);assert.deepEqual(errors, []);
    assert.doesNotMatch(stderr, /unhandledRejection/);return JSON.parse(output.trim().split("\n").at(-1));
  };
  const load = async () => ({ state: JSON.parse(await fs.readFile(root + "/sessions/precompletion-cancellation/state.json", "utf8")), events: (await fs.readFile(root + "/sessions/precompletion-cancellation/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse) });
  const record = async (stage, report) => {
    if (!process.env.AGINTI_TEST_EVIDENCE_DIR) return;
    const directory = path.join(process.env.AGINTI_TEST_EVIDENCE_DIR, scenario.replaceAll(":", "-"));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of ["state.json", "events.jsonl"]) await fs.writeFile(path.join(directory, stage + "-" + name),
      await fs.readFile(root + "/sessions/precompletion-cancellation/" + name), { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(directory, stage + "-receipt.json"), JSON.stringify({ scenario, report, requests }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (boundary === "files") await fs.writeFile(path.join(directory, stage + "-result.md"), await fs.readFile(root + "/workspace/result.md"), { flag: "wx", mode: 0o600 });
  };
  const report = await run(), saved = await load();
  assert.equal(report.error, undefined);assert.ok(report.observation, "Cancellation boundary was never exercised: " + JSON.stringify(report));
  assert.equal(report.aborted, true);assert.equal(report.abortListeners, 0);assert.equal(report.unhandled, 0);
  assert.equal(report.observation.leasePresent, true);
  if (boundary === "post") {
    assert.equal(report.observation.goalStatus, "completed");assert.equal(report.observation.finishedEvents, 1);
    assert.equal(saved.state.meta.goalContract.status, "completed");assert.notEqual(report.outcome.stopped, true);
    assert.equal(saved.events.filter(e => e.type === "session.stopped").length, 0);
  } else {
    assert.equal(report.observation.goalStatus, "active");assert.equal(report.observation.finishedEvents, 0);
    assert.equal(report.outcome.stopped, true);assert.equal(report.outcome.reason, "user_interrupt");
    assert.equal(saved.state.meta.goalContract.status, "paused");assert.equal(saved.events.filter(e => e.type === "session.finished").length, 0);
    assert.equal(saved.events.filter(e => e.type === "session.stopped" && e.data.reason === "user_interrupt").length, 1);
    assert.equal(saved.events.slice(report.observation.eventCount).some(e => /scs\.(?:replan|plan)[._]requested/.test(e.type)), false);
    assert.equal(saved.events.some(e => /handoff|quality_rebound/.test(e.type)), false, "Cancellation must not route frozen quota-shaped reasons");
  }
  await assert.rejects(fs.stat(root + "/sessions/precompletion-cancellation/.agent-run.lock"), { code: "ENOENT" });
  if (boundary === "inflight") assert.equal(await bounded(abortedResponse), true);
  await record("start", report);
  if (boundary === "files") {
    const bytes = await fs.readFile(root + "/workspace/result.md"), digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(bytes.toString(), "confirmed\n");
    const completedWrites = saved.events.filter(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName));assert.equal(completedWrites.length, 1);
    phase = "resume";const resumed = await run(), after = await load();
    assert.equal(resumed.error, undefined);assert.notEqual(resumed.outcome.stopped, true);assert.equal(after.state.meta.goalContract.status, "completed");
    assert.equal(after.state.meta.runtimeConfig.revision, 2);assert.equal(after.state.meta.runtimeConfig.model, "deepseek-v4-pro");
    assert.equal(createHash("sha256").update(await fs.readFile(root + "/workspace/result.md")).digest("hex"), digest);
    assert.equal(after.events.filter(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName)).length, 1);
    assert.equal(after.events.filter(e => e.type === "session.finished").length, 1);
    await record("resume", resumed);
  }
  console.log(JSON.stringify({ scenario, nativeRuntime: true, cancelledBeforeNewTerminal: boundary !== "post", confirmedEffectsRetained: boundary === "files", modelCalls: 0, persistedStatus: saved.state.meta.goalContract.status, providerRequests: requests.length }));
});
