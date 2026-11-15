import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
const fixture = new URL("./fixtures/native-interruption-durability.js", import.meta.url).pathname;
const cases = [
  ...["runtime", "preflight", "preflight-failure", "timeout"].flatMap(stage => ["none", "state", "event"].map(fault => ({ stage, fault }))),
  ...["ENOSPC", "EROFS"].map(errno => ({ stage: "runtime", fault: "state", errno })),
  { stage: "preflight-failure", fault: "event", errno: "ENOSPC" },
  ...["runtime", "preflight"].map(stage => ({ stage, fault: "state-after-rename" })),
  ...["state", "event"].map(fault => ({ stage: "runtime", fault, artifact: true })),
  { stage: "runtime", fault: "none", late: true },
];
const bounded = async (promise, ms = 5000) => {
  let timer;try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Bounded interruption fixture deadline")), ms); })]); }
  finally { clearTimeout(timer); }
};
for (const specification of cases) test(`native interruption persistence: ${JSON.stringify(specification)}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-interruption-durability-"));await fs.mkdir(path.join(root, "workspace"));
  const requests = [], errors = [], children = [];let phase = "start", writes = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const parts = [];let size = 0;for await (const b of req) { size += b.length;assert.ok(size < 1024 * 1024);parts.push(b); }
      const body = JSON.parse(Buffer.concat(parts));requests.push({ phase, model: body.model });assert.ok(requests.length <= 6);
      // Exercise the native exhausted-timeout path through real HTTP. Its
      // normal retry has a 60s floor; an upstream timeout response keeps both
      // attempts bounded without disabling or fabricating retry state.
      if (specification.stage === "timeout" && phase === "start") {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Upstream model timed out after 300ms", code: "MODEL_TIMEOUT", type: "timeout_error" } }));return;
      }
      let message;
      if (specification.artifact && phase === "start" && writes++ === 0) {
        const offered = body.tools.map(x => x.function.name), write = offered.includes("write_file");
        message = { tool_calls: [{ id: "confirmed_write", type: "function", function: { name: write ? "write_file" : "apply_patch", arguments: JSON.stringify(write ? { path: "result.md", content: "confirmed\n", mode: "create" } : { patch: "*** Begin Patch\n*** Add File: result.md\n+confirmed\n*** End Patch" }) } }] };
      } else message = { content: specification.artifact ? "Saved result.md with the requested content." : "I have no recorded earlier check result. I did not run or modify anything." };
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message);res.writeHead(400);res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ closed }) => bounded(closed.catch(() => {}))));
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));await fs.rm(root, { recursive: true, force: true });await assert.rejects(fs.stat(root), { code: "ENOENT" });
  });
  const run = async () => {
    const child = spawn(process.execPath, [fixture, root, "http://127.0.0.1:" + server.address().port + "/v1", JSON.stringify(specification), phase], {
      cwd: path.join(root, "workspace"), env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) }, stdio: ["ignore", "pipe", "pipe"],
    });let stdout = "", stderr = "";child.stdout.on("data", b => stdout += b);child.stderr.on("data", b => stderr += b);
    const closed = new Promise((resolve, reject) => { child.once("error", reject);child.once("close", (code, signal) => resolve({ code, signal })); });closed.catch(() => {});children.push({ child, closed });
    const exit = await bounded(closed, 20000);assert.equal(exit.signal, null);assert.equal(exit.code, 0, stderr);assert.deepEqual(errors, []);
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  const load = async () => ({ state: JSON.parse(await fs.readFile(root + "/sessions/interruption-durability/state.json", "utf8")), events: (await fs.readFile(root + "/sessions/interruption-durability/events.jsonl", "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) });
  const record = async (stage, report) => {
    if (!process.env.AGINTI_TEST_EVIDENCE_DIR) return;
    const name = [specification.stage, specification.fault, specification.errno || "EIO", specification.artifact ? "artifact" : specification.late ? "late" : "plain"].join("-");
    const target = path.join(process.env.AGINTI_TEST_EVIDENCE_DIR, name);await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const n of ["state.json", "events.jsonl"]) await fs.writeFile(path.join(target, stage + "-" + n), await fs.readFile(root + "/sessions/interruption-durability/" + n), { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(target, stage + "-receipt.json"), JSON.stringify({ specification, report, requests }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (specification.artifact) await fs.writeFile(path.join(target, stage + "-result.md"), await fs.readFile(root + "/workspace/result.md"), { flag: "wx", mode: 0o600 });
  };
  const report = await run(), saved = await load();
  assert.equal(report.unhandled, 0);assert.equal(report.abortListeners, 0);assert.equal(report.liveProviderCalls, 0);
  await assert.rejects(fs.stat(root + "/sessions/interruption-durability/.agent-run.lock"), { code: "ENOENT" });
  assert.equal(saved.events.some(e => /handoff|quality_rebound/.test(e.type)), false);
  const status = specification.stage === "timeout" || specification.stage === "preflight-failure" ? "failed" : "paused";
  const terminal = status === "failed" ? "session.failed" : "session.stopped";
  if (specification.fault !== "none") {
    assert.equal(report.failures, 1);assert.equal(report.outcome, undefined, "No saved/stopped result after a persistence failure");
    assert.equal(report.error?.code, specification.errno || "EIO");assert.equal(report.error.exactIoError, true, "Surface exact storage failure rather than the original abort/provider reason");
    assert.deepEqual(report.delivered, []);assert.deepEqual(report.consoleClaims, []);
    assert.equal(saved.state.meta.goalContract.status, specification.fault === "event" || specification.fault === "state-after-rename" ? status : "active");
    assert.equal(saved.events.filter(e => e.type === terminal).length, 0);
    assert.ok(report.observation.leaseHeld);
  } else if (specification.late) {
    assert.equal(report.error, undefined);assert.notEqual(report.outcome.stopped, true);assert.equal(saved.state.meta.goalContract.status, "completed");
    assert.equal(saved.events.filter(e => e.type === "session.finished").length, 1);assert.equal(saved.events.filter(e => e.type === "session.stopped").length, 0);
  } else {
    assert.equal(report.failures, 0);assert.equal(saved.state.meta.goalContract.status, status);assert.equal(saved.events.filter(e => e.type === terminal).length, 1);
    assert.equal(report.delivered.filter(e => e.type === terminal && e.durableStatus === status).length, 1);
    if (specification.stage === "runtime") { assert.equal(report.error, undefined);assert.equal(report.outcome.reason, "user_interrupt"); }
    if (specification.stage === "timeout") { assert.equal(report.error, undefined);assert.equal(report.outcome.reason, "model_timeout");assert.equal(report.outcome.failed, true); }
    if (specification.stage === "preflight") assert.equal(report.error.code, "TEST_CALLER_CANCELLED");
    if (specification.stage === "preflight-failure") assert.equal(report.error.code, "PROVIDER_PREREQUISITE_MISSING");
  }
  await record("start", report);
  if (specification.artifact) {
    const bytes = await fs.readFile(root + "/workspace/result.md"), digest = createHash("sha256").update(bytes).digest("hex");assert.equal(bytes.toString(), "confirmed\n");
    const completedWrites = events => events.filter(e => e.type === "tool.completed" && ["write_file", "apply_patch"].includes(e.data.toolName));assert.equal(completedWrites(saved.events).length, 1);
    phase = "resume";const resumed = await run(), after = await load();assert.equal(resumed.error, undefined);assert.notEqual(resumed.outcome.stopped, true);
    assert.equal(after.state.meta.goalContract.status, "completed");assert.equal(after.state.meta.runtimeConfig.revision, 2);assert.equal(after.state.meta.runtimeConfig.model, "deepseek-v4-pro");
    assert.equal(createHash("sha256").update(await fs.readFile(root + "/workspace/result.md")).digest("hex"), digest);assert.equal(completedWrites(after.events).length, 1);
    assert.equal(after.events.filter(e => e.type === "session.finished").length, 1);await record("resume", resumed);
  }
});
