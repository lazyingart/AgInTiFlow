import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
const hash = s => createHash("sha256").update(s).digest("hex");
const task = "# Task\n\nRequired outputs:\n- `report.md`\n\nThe validation commands must run before completion:\n\n```sh\nnode --test check.mjs\n```\n";
const report = "# Report\n\nVerified project status note.\n", note = "# Status\n\nVerification requested.\n";
const checker = `import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(fs.readFileSync('report.md','utf8'),${JSON.stringify(report)});assert.equal(fs.readFileSync('notes.md','utf8'),${JSON.stringify(note)});console.log('ACCEPTANCE_CHECK_PASSED');\n`;
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
for (const mode of ["ordinary", "missing", "mixed-sources", "legacy"]) test(`durable acceptance survives interruption and continuation: ${mode}`, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-acceptance-native-test-")), workspace = root + "/workspace";
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(workspace); await fs.writeFile(workspace + "/TASK.md", task); await fs.writeFile(workspace + "/check.mjs", checker);
  if (mode === "mixed-sources") await fs.writeFile(workspace + "/README.md", "# Guide\n\nOrdinary project description.\n");
  let phase = "start", turn = 0, requests = 0, completionCalls = [];
  const errors = [], models = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const b of req) chunks.push(b); const body = JSON.parse(Buffer.concat(chunks)); requests++; models.push({ phase, model: body.model }); let message;
      if (!body.tools) message = { content: "Read the task, produce its files and verify them." };
      else if (phase === "start" && turn++ === 0) message = { tool_calls: [call("read_file", { path: "TASK.md" }, "read_owned_task")] };
      else if (phase === "start" && mode === "mixed-sources" && turn === 2) message = { tool_calls: [call("read_file", { path: "README.md" }, "read_owned_guide")] };
      else if (phase === "start") { res.writeHead(402, { "content-type": "application/json" }); res.end('{"error":{"message":"Synthetic quota refusal","code":"insufficient_quota"}}'); return; }
      else if (phase === "resume" && turn++ === 0) message = { tool_calls: [call("write_file", { path: "notes.md", mode: "create", content: note }, "write_owned_notes")] };
      else if (phase === "resume") message = { tool_calls: [call("finish", { result: "The project is complete. Saved notes.md." }, "unverified_finish_" + turn)] };
      else { const next = completionCalls.shift(); assert.ok(next, "Completion exhausted the bounded provider script"); message = { tool_calls: [next] }; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(e.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function run() {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-acceptance-continuation.js", import.meta.url)), root, "http://127.0.0.1:" + server.address().port + "/v1", phase], {
      cwd: workspace, env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1",
        ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", expired = false; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15000);
      child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
    assert.equal(expired, false, err); assert.equal(exit.signal, null); assert.equal(exit.code, 0, err); return JSON.parse(out);
  }
  const statePath = root + "/sessions/acceptance-native/state.json", eventsPath = root + "/sessions/acceptance-native/events.jsonl";
  const load = async () => JSON.parse(await fs.readFile(statePath, "utf8"));
  const events = async () => (await fs.readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const first = await run(); assert.equal(first.resolved, false); assert.equal(first.status, 402);
  const before = await load(); assert.deepEqual(before.meta.projectVerification.requiredOutputs, ["report.md"]); assert.deepEqual(before.meta.projectVerification.requiredCommands, ["node --test check.mjs"]);
  if (mode === "legacy") {
    // Schema compatibility only: this additive marker did not exist in425.
    // Keep every session identity, command, output and execution record intact.
    delete before.meta.projectVerification.acceptanceBySource["TASK.md"].commandsAreFinalVerification;
    await fs.writeFile(statePath, JSON.stringify(before));
  }
  if (mode !== "ordinary") await fs.unlink(workspace + "/TASK.md");
  phase = "resume"; turn = 0; const second = await run(), after = await load();
  assert.equal(second.resolved, true); assert.equal(second.result.stopped, true); assert.equal(after.meta.goalContract.status, "paused");
  assert.deepEqual(after.meta.projectVerification.requiredOutputs, ["report.md"]); assert.deepEqual(after.meta.projectVerification.requiredCommands, ["node --test check.mjs"]);
  assert.equal(after.meta.runtimeConfig.revision, 2); assert.equal((await events()).filter(e => e.type === "session.finished").length, 0);
  await assert.rejects(fs.stat(workspace + "/report.md"), { code: "ENOENT" });
  if (mode !== "ordinary") await fs.writeFile(workspace + "/TASK.md", task);
  phase = "finish"; turn = 0; const alreadyNotes = await fs.stat(workspace + "/notes.md").then(() => true, () => false);
  completionCalls = [call("write_file", { path: "report.md", mode: "create", content: report }, "write_verified_report"),
    ...(!alreadyNotes ? [call("write_file", { path: "notes.md", mode: "create", content: note }, "write_verified_notes")] : []),
    call("run_command", { command: "node --test check.mjs" }, "run_exact_check"), call("finish", { result: "Created report.md and notes.md and passed node --test check.mjs." }, "finish_verified_project")];
  const final = await run(), finalState = await load(), finalEvents = await events();
  assert.deepEqual(errors, [], JSON.stringify({ final, recent: finalEvents.filter(e => /completion|tool\.(?:completed|failed|blocked)/u.test(e.type)).slice(-7) }));
  assert.equal(final.resolved, true); assert.notEqual(final.result.stopped, true, JSON.stringify({ final, toolEvents: finalEvents.filter(e => /tool\.(?:completed|failed|blocked)/u.test(e.type)).slice(-10) })); assert.equal(finalState.meta.goalContract.status, "completed");
  assert.equal(finalState.meta.runtimeConfig.revision, 3); assert.equal(finalEvents.filter(e => e.type === "session.finished").length, 1);
  assert.equal(await fs.readFile(workspace + "/report.md", "utf8"), report); assert.equal(await fs.readFile(workspace + "/notes.md", "utf8"), note);
  assert.equal(await fs.readFile(workspace + "/check.mjs", "utf8"), checker); assert.equal(await fs.readFile(workspace + "/TASK.md", "utf8"), task);
  const checks = finalState.meta.projectVerification.commandRuns.filter(r => r.command === "node --test check.mjs" && r.ok === true); assert.equal(checks.length, 1);
  const checkEvents = finalEvents.filter(e => e.type === "tool.completed" && e.data.toolName === "run_command" && e.data.args.command === "node --test check.mjs");
  assert.equal(checkEvents.length, 1); assert.equal(checkEvents[0].data.exitCode, 0); assert.match(checkEvents[0].data.stdout, /ACCEPTANCE_CHECK_PASSED/u);
  const resumedModels = models.filter(m => m.phase === "resume");
  assert.ok(resumedModels.length > 0); assert.ok(resumedModels.every(m => m.model === "deepseek-v4-pro"));
  assert.equal(after.meta.runtimeConfig.allowDestructive, false); assert.equal(finalState.meta.runtimeConfig.allowDestructive, true);
  await assert.rejects(fs.stat(root + "/sessions/acceptance-native/.agent-run.lock"), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, realNativeRuntime: true, scriptedProvider: true, externalModelCalls: 0, quotaRequests: 1, runtimeRevisions: [1, 2, 3], unverifiedCompletionRejected: true, retainedOutput: "report.md", retainedCommand: "node --test check.mjs", verifiedFinalCompletion: true,
    reportSha256: hash(report), notesSha256: hash(note), checkerUnchanged: true, successfulCheckCount: 1, ownedHostCheckExplicitlyApproved: true, sessionLeaseReleased: true, requests }));
});
