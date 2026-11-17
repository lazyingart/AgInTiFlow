import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), first = "node --version", second = "python3 --version";
for (const scs of ["off", "on"]) for (const mode of ["omitted", "both", "paused", "legacy-completed-missing", "legacy-completed-both", "optional", "paused-optional", "paused-optional-independent", "paused-epoch"]) {
  test(`native independent command obligations: ${scs}/${mode}`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-command-preamble-"));
    t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(path.join(root, "workspace"));
    const first = mode === "paused-epoch" ? "node tools/first-check.mjs" : "node --version";
    const second = mode === "paused-epoch" ? "node tools/second-check.mjs" : "python3 --version";
    if (mode === "paused-epoch") {
      await fs.mkdir(path.join(root, "workspace/tools"));
      await fs.writeFile(path.join(root, "workspace/tools/first-check.mjs"), "console.log('FIRST_OBSERVED');process.exitCode=2;\n");
      await fs.writeFile(path.join(root, "workspace/tools/second-check.mjs"), "console.log('SECOND_OBSERVED');\n");
    }
    let phase = "start", turns = 0, requests = 0; const errors = [];
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const b of req) chunks.push(b); const body = JSON.parse(Buffer.concat(chunks)); requests++; assert.ok(requests <= 20);
        const system = body.messages.filter(m => m.role === "system").map(m => m.content).join("\n"); let message;
        if (!body.tools && system.includes("SCS committee planner")) message = { content: JSON.stringify({ role: "committee", phase_goal: "Observe requested versions", plan: "Run each required command once and report its actual output. A conditional command is optional unless another authoritative requirement makes it mandatory.", acceptance_criteria: ["Required command outcomes observed", "No user files changed"], allowed_tools: ["run_command", "finish"], stop_conditions: ["Finish after required results are supported"] }) };
        else if (!body.tools) message = { content: "Run both requested commands once and report their observed outputs." };
        else {
          turns++; let name = "finish", args = { result: "Node reports " + process.version + "." };
          if (phase === "start" && turns === 1) { name = "run_command"; args = { command: first }; }
          else if (phase === "resume" && mode === "paused-epoch" && turns === 1) { name = "run_command"; args = { command: first }; }
          else if (phase === "start" && turns === 2 && ["both", "legacy-completed-both", "legacy-completed-missing"].includes(mode)) { name = "run_command"; args = { command: second }; }
          else if (phase === "resume" && ["paused", "paused-optional-independent", "paused-epoch"].includes(mode) && turns === 2) { name = "run_command"; args = { command: second }; }
          else if (phase === "repair" && turns === 1) { name = "run_command"; args = { command: second }; }
          else if (phase === "repair") args = { result: "Python reports its observed version. No task files were changed." };
          else if (phase === "resume" && mode === "paused-epoch" && turns > 2) args = { result: "The first check failed with exit 2; the second check passed with exit 0. No files were changed." };
          else if (mode !== "omitted" && (phase === "start" && turns > 2 || phase === "resume" && turns > 2)) args = { result: "Node reports " + process.version + "; Python reports its observed version. No task files were changed." };
          assert.ok(body.tools.some(tool => tool.function.name === name));
          message = { tool_calls: [{ id: `command_${phase}_${turns}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
      } catch (error) { errors.push(String(error)); res.writeHead(400); res.end("{}"); }
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const directory = path.join(root, "sessions/command-preamble"), statePath = path.join(directory, "state.json"), eventPath = path.join(directory, "events.jsonl");
    async function run(next, expectedRevision = 1) {
      phase = next; turns = 0;
      const r = await exec(process.execPath, [new URL("./fixtures/native-command-preamble.js", import.meta.url).pathname, root, "http://127.0.0.1:" + server.address().port + "/v1", scs, mode, phase, String(expectedRevision)], {
        cwd: root, timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
          ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
      }); assert.deepEqual(errors, []); return JSON.parse(r.stdout.trim().split("\n").at(-1));
    }
    let result = await run("start"), prefix = "", beforeRequests = requests;
    if (mode === "paused-epoch") {
      const state = JSON.parse(await fs.readFile(statePath)); assert.equal(state.meta.goalContract.status, "paused");
      assert.equal(state.meta.activeExecutionContract.revision, 1);
      prefix = await fs.readFile(eventPath, "utf8"); result = await run("resume");
    } else if (mode.startsWith("paused") || mode.startsWith("legacy-completed")) {
      const state = JSON.parse(await fs.readFile(statePath));
      assert.equal(state.meta.goalContract.status, mode.startsWith("paused") ? "paused" : "completed");
      // Simulate only pre-upgrade inferred metadata. These are controlled
      // regression fixtures, not observations of a historical live session.
      state.meta.activeExecutionContract.requiredProjectCommands = [first]; delete state.meta.activeExecutionContract.commandIntentInferenceVersion;
      if (state.meta.scs?.taskContract) { state.meta.scs.taskContract.requiredProjectCommands = [first]; delete state.meta.scs.taskContract.commandIntentInferenceVersion; }
      if (mode.startsWith("paused-optional")) {
        state.meta.activeExecutionContract.requiredProjectCommands = [first, second];
        state.meta.projectVerification.contractRequiredCommands = [first, second];
        if (state.meta.scs?.taskContract) state.meta.scs.taskContract.requiredProjectCommands = [first, second];
        const batch = state.meta.projectVerification.requiredCommandBatch;
        if (batch) { batch.key = JSON.stringify([first, second]); batch.requiredCommands = [first, second]; batch.complete = false; }
        if (mode === "paused-optional-independent") state.meta.projectVerification.requiredCommands = [second];
      }
      if (mode === "legacy-completed-missing") {
        // Reproduce the old false-completion shape by removing only second's
        // authority receipts, retaining the first command and terminal marker.
        state.meta.projectVerification.commandRuns = state.meta.projectVerification.commandRuns.filter(r => r.command !== second);
        state.meta.projectVerification.contractRequiredCommands = [first];
        const batch = state.meta.projectVerification.requiredCommandBatch;
        if (batch) { batch.key = JSON.stringify([first]); batch.requiredCommands = [first]; batch.completedCommands = [first]; batch.completedRuns = batch.completedRuns.filter(r => r.command === first); }
        state.messages = state.messages.filter(m => !(m.role === "tool" && typeof m.content === "string" && m.content.includes(second)));
        const events = (await fs.readFile(eventPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(e => !(["tool.started", "tool.completed"].includes(e.type) && (e.data.command || e.data.args?.command) === second));
        await fs.writeFile(eventPath, events.map(e => JSON.stringify(e)).join("\n") + "\n");
      }
      await fs.writeFile(statePath, JSON.stringify(state)); prefix = await fs.readFile(eventPath, "utf8"); result = await run("resume");
    }
    const text = await fs.readFile(eventPath, "utf8"), events = text.trim().split("\n").map(JSON.parse), state = JSON.parse(await fs.readFile(statePath));
    const completed = events.filter(e => e.type === "tool.completed" && e.data.toolName === "run_command");
    assert.ok(text.startsWith(prefix)); assert.equal(events.some(e => e.type === "file.changed"), false);
    if (mode === "omitted") {
      assert.notEqual(result.result?.goalStatus, "completed"); assert.equal(completed.length, 1); assert.equal(events.some(e => e.type === "session.finished"), false);
    } else if (mode === "legacy-completed-missing") {
      assert.equal(result.result?.stopped, true); assert.equal(result.result.reason, "completion_contract_review_required"); assert.notEqual(state.meta.goalContract.status, "completed");
      assert.equal(requests, beforeRequests, "old completion must not replay provider or tools blindly"); assert.equal(completed.length, 1);
      assert.equal(state.meta.runtimeConfig.revision, 2);
      beforeRequests = requests; result = await run("resume", state.meta.runtimeConfig.revision); assert.equal(result.result?.reason, "completion_contract_review_required", JSON.stringify(result)); assert.equal(requests, beforeRequests);
      const reviewed = JSON.parse(await fs.readFile(statePath));
      result = await run("repair", reviewed.meta.runtimeConfig.revision);
      assert.equal(result.result?.goalStatus, "completed", JSON.stringify(result));
      const repaired = JSON.parse(await fs.readFile(statePath)); assert.equal(repaired.meta.commandCompletionReview, undefined);
      const all = (await fs.readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.deepEqual(all.filter(e => e.type === "tool.completed" && e.data.toolName === "run_command").map(e => e.data.command || e.data.args?.command), [first, second]);
    } else if (mode === "optional" || mode === "paused-optional") {
      assert.equal(result.result?.goalStatus, "completed", JSON.stringify(result)); assert.equal(completed.length, 1);
      if (mode === "paused-optional") {
        assert.deepEqual(state.meta.activeExecutionContract.requiredProjectCommands, [first]);
        assert.equal(state.meta.runtimeConfig.revision, 2);
      }
    } else {
      assert.equal(result.result?.goalStatus, "completed", JSON.stringify(result)); assert.equal(completed.length, 2);
      assert.deepEqual(completed.map(e => e.data.command || e.data.args?.command), [first, second]);
      if (mode === "legacy-completed-both") assert.equal(requests, beforeRequests, "verified old completion remains delivery-only");
      if (mode === "paused") {
        assert.ok(events.some(e => e.type === "completion.evidence_rejected")); assert.equal(state.meta.runtimeConfig.revision, 2);
        assert.deepEqual(state.meta.activeExecutionContract.requiredProjectCommands, [first, second]);
      }
      if (mode === "both" || mode.startsWith("paused")) assert.equal(state.meta.activeExecutionContract.commandIntentInferenceVersion, 1);
      if (mode === "paused-optional-independent") assert.ok(state.meta.projectVerification.requiredCommands.includes(second));
      if (mode === "paused-epoch") {
        assert.deepEqual(completed.map(e => e.data.exitCode), [2, 0]);
        assert.equal(state.meta.activeExecutionContract.revision, 1); assert.equal(state.meta.goalContract.revision, 2);
        const runs = state.meta.projectVerification.commandRuns;
        assert.ok(runs[0].requiredCommandBatchId); assert.equal(runs[0].requiredCommandBatchId, runs[1].requiredCommandBatchId);
        assert.equal(events.some(e => e.type === "completion.evidence_rejected"), false);
      }
    }
    await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" });
  });
}
