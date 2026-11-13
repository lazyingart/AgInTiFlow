import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
const fixture = new URL("./fixtures/native-long-job-checkpoint.js", import.meta.url).pathname;
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const modes = ["normal", "callback-sync", "callback-async", "callback-sync-no-reasoning", "tool-event-eio", "start-event-eio", "canvas-event-eio", "after-tool-event-crash", "after-start-event-crash", "checkpoint-eio", "checkpoint-persistent-eio", "serialized-mixed", "not-offered", "observer-abort"];
for (const mode of modes) test(`native long-job checkpoint: ${mode}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-job-checkpoint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.mkdir(root + "/bin"); await fs.writeFile(root + "/workspace/input.txt", "protected input\n");
  // Generates native metadata only: no tmux server or producer. Actual worker
  // execution is a separate qualification; these isolate checkpoint ordering.
  await fs.writeFile(root + "/bin/tmux", "#!/bin/sh\nif [ \"$1\" = new-session ]; then printf 'admit\\n' >> \"$HOME/admissions.txt\"; exit 0; fi\nprintf \"can't find session: %s\\n\" \"$3\" >&2\nexit 1\n", { mode: 0o700 });
  let phase = "start", jobId = "", turns = 0; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); let message;
      if (!body.tools) message = { content: "1. Use the supplied export once.\n2. Keep its receipt and report the observed status." };
      else if (phase === "start" && body.tools.length === 1 && body.tools[0].function.name === "finish") message = { tool_calls: [call("finish", { result: "The launch receipt is recorded; use its saved status file." }, "finish_launch")] };
      else if (phase === "start") {
        const calls = [call("start_long_job", { name: "checkpoint-export", command: "printf abc123 > product.bin", expectedOutputPath: "product.bin", expectedSizeBytes: 6, timeoutSeconds: 10, pollIntervalSeconds: 5 }, "start_export")];
        if (mode === "serialized-mixed") calls.push(call("read_file", { path: "input.txt" }, "untouched_suffix"));
        message = { tool_calls: calls };
      } else {
        turns++; assert.ok(jobId && JSON.stringify(body.messages).includes(jobId), "Restarted model context lost the actual acknowledged job ID");
        if (turns === 1) message = { tool_calls: [call("long_job_status", { jobId }, "check_saved_job")] };
        else {
          const text = JSON.stringify(body.messages); assert.match(text, /long_job_status/); assert.match(text, /created/);
          message = { tool_calls: [call("finish", { result: `The existing background job is ${jobId}. The status check observed state created; this is a saved launch receipt, not proof of completed output. Status: .aginti/long-jobs/${jobId}/status.json.` }, "finish_saved_job")] };
        }
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...(mode.endsWith("no-reasoning") ? {} : { reasoning_content: "Use the actual saved native result, not another launch." }), ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end('{"error":{"message":"Owned offline fixture rejected request"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase, ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? [process.env.AGINTI_TEST_BASELINE_RUNTIME] : [])],
      { env: { PATH: root + "/bin:" + process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", expired = false; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 12000);
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, expired, stdout, stderr }); });
  });
  const first = await run(); assert.equal(first.expired, false); assert.deepEqual(errors, []);
  const session = root + "/sessions/job-checkpoint-" + mode;
  const load = async () => ({ state: JSON.parse(await fs.readFile(session + "/state.json")), events: (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse) });
  const { state, events } = await load(); assert.doesNotMatch(JSON.stringify(state), /CALLBACK_PRIVATE_SENTINEL/); assert.doesNotMatch(first.stderr, /unhandled/i);
  assert.equal(await fs.readFile(root + "/workspace/input.txt", "utf8"), "protected input\n");
  if (mode === "not-offered") {
    await assert.rejects(fs.stat(root + "/admissions.txt"), { code: "ENOENT" });
    assert.equal(events.some(e => e.type === "long_job.started"), false); assert.equal(state.meta.deferredJobReceipts?.length || 0, 0); return;
  }
  assert.equal(await fs.readFile(root + "/admissions.txt", "utf8"), "admit\n");
  const jobs = await fs.readdir(root + "/workspace/.aginti/long-jobs"); assert.equal(jobs.length, 1); jobId = jobs[0];
  const success = state.messages.some(m => m.role === "tool" && m.tool_call_id === "start_export" && JSON.parse(m.content).ok === true);
  assert.equal(events.some(e => e.type === "tool.failed" && e.data.toolName === "start_long_job"), false, "A post-result failure must not fabricate a failed producer result");
  if (mode === "checkpoint-persistent-eio") {
    assert.equal(JSON.parse(first.stdout).resolved, false); assert.equal(JSON.parse(first.stdout).code, "EIO");
    assert.equal(events.some(e => e.type === "tool.completed" && e.data.toolName === "start_long_job"), false); return;
  }
  assert.equal(success, true, "Acknowledged launch absent from durable native frame");
  assert.equal(state.meta.deferredJobReceipts.some(r => r.jobId === jobId), true);
  if (mode.includes("crash")) assert.equal(first.signal, "SIGKILL");
  else {
    assert.equal(first.code, 0, first.stderr); const report = JSON.parse(first.stdout); assert.equal(report.unhandled, 0); assert.equal(report.abortListeners, 0);
    if (mode.endsWith("eio") || mode.startsWith("callback")) { assert.equal(report.resolved, false); assert.equal(report.injected, true); }
    if (mode === "normal" || mode === "serialized-mixed") assert.equal(report.outcome.goalStatus, "completed");
  }
  if (mode === "serialized-mixed") assert.equal(state.messages.some(m => m.role === "tool" && m.tool_call_id === "untouched_suffix"), false);
  phase = "resume"; const second = await run(); assert.equal(second.expired, false); assert.equal(second.code, 0, second.stderr); assert.deepEqual(errors, []);
  const resumed = JSON.parse(second.stdout); assert.equal(resumed.resolved, true, second.stdout);
  const diagnostics = (await load()).events.filter(e => /completion|stopped/.test(e.type)).slice(-5);
  assert.equal(resumed.outcome.goalStatus, "completed", JSON.stringify({ resumed, turns, diagnostics })); assert.match(resumed.outcome.result, new RegExp(jobId)); assert.equal(resumed.unhandled, 0); assert.equal(resumed.abortListeners, 0);
  assert.equal(await fs.readFile(root + "/admissions.txt", "utf8"), "admit\n", "Resume must not admit a duplicate producer");
  assert.equal((await fs.readdir(root + "/workspace/.aginti/long-jobs")).length, 1);
  const latest = await load(); assert.equal(latest.events.filter(e => e.type === "session.finished").length, ["normal", "serialized-mixed"].includes(mode) ? 2 : 1);
  await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
});
