import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";

const fixture = new URL("./fixtures/native-background-handoff-runtime.js", import.meta.url).pathname;
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
for (const scenario of ["ordinary", "budget", "compound", "ignores-finish", "stale-state"]) test(`native background handoff: ${scenario}`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-background-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.mkdir(root + "/bin");
  await fs.writeFile(root + "/workspace/input.txt", "protected input\n");
  // The native tool creates real metadata. Admission only is faked: no actual
  // background producer is invoked in these loop/convergence tests.
  await fs.writeFile(root + "/bin/tmux", "#!/bin/sh\nif [ \"$1\" = new-session ]; then exit 0; fi\nprintf \"can't find session: %s\\n\" \"$3\" >&2\nexit 1\n", { mode: 0o700 });
  const offered = [], errors = []; let steps = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks)); let message;
      if (!body.tools) message = { content: "1. Start the supplied export as one background job.\n2. Return its saved receipt and status location." };
      else {
        const names = body.tools.map(tool => tool.function.name); offered.push(names); steps++;
        if (steps === 1) message = { tool_calls: [call("start_long_job", { name: "handoff-test", command: "printf abc123 > product.bin", expectedOutputPath: "product.bin", expectedSizeBytes: 6, timeoutSeconds: 10, pollIntervalSeconds: 5 }, "start_job")] };
        else if (scenario === "ignores-finish" && steps === 2) message = { tool_calls: [call("write_file", { path: "unrequested.md", content: "unrequested report", mode: "create" }, "unrequested_write")] };
        else if (scenario === "compound" && steps === 2) message = { tool_calls: [call("write_file", { path: "note.md", content: "handoff checked\n", mode: "create" }, "write_note")] };
        else if (names.length === 1 && names[0] === "finish" || scenario === "compound") {
          const tool = body.messages.filter(m => m.role === "tool").map(m => { try { return JSON.parse(m.content); } catch { return null; } }).find(p => p?.toolName === "start_long_job");
          const context = body.messages.map(m => m.content || "").join("\n");
          const jobId = tool?.jobId || /Background launch confirmed: ([A-Za-z0-9_.+-]+)\./.exec(context)?.[1];
          const statusPath = tool?.statusPath || /Status: (\.aginti\/long-jobs\/[A-Za-z0-9_.+-]+\/status\.json)/.exec(context)?.[1];
          assert.ok(jobId && statusPath, "The actual offered context must retain the native launch receipt");
          const text = scenario === "compound" ? "Saved note.md with handoff checked. " : "";
          message = scenario === "stale-state"
            ? { content: "The job has completed successfully. Every output has been verified." }
            : { tool_calls: [call("finish", { result: text + `Background launch confirmed: ${jobId}. Status: ${statusPath}. Completion is deferred.` }, "finish_handoff")] };
        } else message = { tool_calls: [call("read_file", { path: "input.txt" }, `unneeded_read_${steps}`)] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const child = spawn(process.execPath, [fixture, root, `http://127.0.0.1:${server.address().port}/v1`, scenario, ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? [process.env.AGINTI_TEST_BASELINE_RUNTIME] : [])],
    { env: { PATH: root + "/bin:" + process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTO_UPDATE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, stderr); assert.deepEqual(errors, []);
  const report = JSON.parse(stdout.trim()); assert.equal(report.unhandled, 0);
  const state = JSON.parse(await fs.readFile(root + "/sessions/native-background-handoff/state.json"));
  const events = (await fs.readFile(root + "/sessions/native-background-handoff/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "long_job.started").length, 1);
  assert.equal(await fs.readFile(root + "/workspace/input.txt", "utf8"), "protected input\n");
  if (scenario === "budget") {
    assert.equal(report.outcome.stopped, true); assert.equal(report.outcome.reason, "max_steps_reached");
    assert.equal(report.outcome.goalStatus, "paused"); assert.match(report.outcome.result, /Background launch confirmed: handoff-test-/);
    assert.match(report.outcome.result, /before confirming the entire request/);
    assert.equal(state.chat.at(-1).content, report.outcome.result);
    assert.equal(events.some(e => e.type === "session.finished"), false);
  } else {
    assert.equal(report.outcome.stopped, undefined); assert.equal(report.outcome.goalStatus, "completed");
    assert.match(report.outcome.result, /Background launch confirmed: handoff-test-/);
    if (scenario === "compound") { assert.ok(offered[1].includes("write_file")); assert.equal(await fs.readFile(root + "/workspace/note.md", "utf8"), "handoff checked\n"); }
    else {
      assert.deepEqual(offered[1], ["finish"]); assert.equal(steps, scenario === "ignores-finish" ? 3 : 2);
      assert.match(report.outcome.result, /Current job state has not been checked/);
      assert.doesNotMatch(report.outcome.result, /job has completed successfully|Every output has been verified/);
      if (scenario === "ignores-finish") {
        await assert.rejects(fs.stat(root + "/workspace/unrequested.md"), { code: "ENOENT" });
        assert.equal(events.some(e => e.type === "tool.failed" && e.data.category === "tool-contract-violation"), true);
      }
    }
    assert.equal(events.filter(e => e.type === "session.finished").length, 1);
  }
});
