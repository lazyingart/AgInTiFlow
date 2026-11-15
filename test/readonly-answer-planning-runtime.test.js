import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const question = {
  en: "Why did the previous test fail? Did you edit any file? Do not rerun it or modify any file.",
  zh: "上次的检查为什么失败？有没有修改文件？不要重跑，也不要修改文件。",
  ja: "前回のテストはなぜ失敗しましたか？ファイルを変更しましたか？再実行せず、読み取り専用で答えてください。",
};
for (const [mode, scsMode] of [["en", "on"], ["zh", "on"], ["ja", "on"], ["en", "off"], ["no-history", "on"], ["mixed", "on"], ["model-review", "on"], ["model-review-reject", "on"], ["en-read", "on"]]) {
  test(`bounded read-only answer avoids model planning: ${mode} / SCS ${scsMode}`, { timeout: 40000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-readonly-answer-")), workspace = path.join(root, "workspace");
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
    await fs.mkdir(workspace);
    const source = "import test from 'node:test';import assert from 'node:assert/strict';test('owned answer fixture',()=>assert.equal(3,4));\n";
    await fs.writeFile(workspace + "/check.mjs", source);
    let phase = "start", turns = 0, reviewCalls = 0, followupTurns = 0;
    const modelReview = mode.startsWith("model-review"), rejectFirst = mode === "model-review-reject";
    const requests = [], errors = [];
    const reply = mode === "no-history" ? "I do not have a prior test result to explain. I did not run or modify anything."
      : "The earlier test failed because it expected 4 but observed 3. No task file was edited or check rerun.";
    const server = http.createServer(async (req, res) => {
      try {
        const parts = []; for await (const b of req) parts.push(b);
        const body = JSON.parse(Buffer.concat(parts)); assert.ok(requests.length < 14);
        const review = !body.tools && String(body.messages?.[0]?.content || "").includes("SCS student final gate");
        requests.push({ phase, model: body.model, planning: !body.tools && !review, review, execution: Boolean(body.tools), offeredTools: (body.tools || []).map(t => t.function.name) });
        const call = (name, args) => ({ id: "answer_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(args) } });
        const system = String(body.messages?.[0]?.content || "");
        if (review && phase === "resume" && modelReview) {
          const pack = JSON.parse(body.messages.at(-1).content.split("Evidence pack:\n").at(-1));
          assert.match(pack.historicalObservations.observation.stdout, /expected: 4/);
          assert.match(pack.historicalObservations.observation.stdout, /actual: 3/);
          assert.equal(pack.historicalObservations.freshExecutionProof, false);
          assert.equal(pack.evidenceLedger.itemCount, 0);
          assert.deepEqual(pack.commandProofs, []);
        }
        const message = review ? { content: JSON.stringify({ role: "student", decision: phase === "resume" && rejectFirst && reviewCalls++ === 0 ? "finish_rejected" : "finish_allowed", confidence: 0.99, evidence: ["Recorded native result and current read-only contract"], reason: "Bounded final answer review", next_required_action: "answer" }) }
          : !body.tools && system.includes("SCS committee planner") ? { content: JSON.stringify({ role: "committee", phase_goal: "Answer the current question within the current task contract", plan: "Use the recorded observations and finish with a truthful answer.", acceptance_criteria: ["Answer the question truthfully"], allowed_tools: ["finish"], stop_conditions: ["Missing mandatory evidence remains a blocker"] }) }
          : !body.tools && system.includes("independent SCS student validator") ? { content: JSON.stringify({ role: "student", decision: "approve_plan", confidence: 0.99, evidence: ["The runtime evidence gate remains authoritative"], reason: "Bounded plan review", next_required_action: "answer" }) }
          : !body.tools ? { content: "Use the recorded outcome; respect all prohibitions and keep evidence truthful." }
          : phase === "start" && mode !== "no-history" && turns++ === 0
            ? { tool_calls: [call("run_command", { command: "node --test check.mjs" })] }
            : phase === "resume" && mode === "en-read" && followupTurns++ === 0
              ? { tool_calls: [call("read_file", { path: "check.mjs" })] }
            : { tool_calls: [call("finish", { result: reply })] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
      } catch (e) { errors.push(e.message); res.writeHead(400); res.end("{}"); }
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    async function run(goal) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-diagnostic-command-outcomes.js", import.meta.url)), root,
        "http://127.0.0.1:" + server.address().port + "/v1", goal, phase], {
        cwd: workspace, env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home",
          AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_TEST_SCS_MODE: scsMode, AGINTI_TEST_SCS_VALIDATION_MODE: modelReview ? "model" : "deterministic",
          ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "", expired = false;
      child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 18000);
        child.once("error", e => { clearTimeout(timer); reject(e); });
        child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.equal(expired, false); assert.equal(result.signal, null); assert.equal(result.code, 0, stderr);
      const parsed = JSON.parse(stdout); assert.equal(parsed.resolved, true); return parsed.result;
    }
    let result = await run(mode === "no-history" ? question.en : "Run `node --test check.mjs` once and tell me what happened. Do not repair or modify any file.");
    assert.notEqual(result.stopped, true);
    if (mode !== "no-history") {
      phase = "resume";
      result = await run(mode === "mixed" ? "Why did the previous test fail and ensure tests pass? Do not modify any file." : modelReview || mode === "en-read" ? question.en : question[mode]);
    }
    const state = JSON.parse(await fs.readFile(root + "/sessions/diagnostic-status/state.json", "utf8"));
    const events = (await fs.readFile(root + "/sessions/diagnostic-status/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    const lastStart = events.findLastIndex(e => e.type === "session.resumed");
    const current = events.slice(lastStart < 0 ? 0 : lastStart);
    const planned = current.filter(e => e.type === "scs.plan.requested" || e.type === "plan.requested");
    const calls = requests.filter(r => r.phase === phase);
    assert.equal(state.meta.scs?.active === true, scsMode === "on");
    assert.equal(await fs.readFile(workspace + "/check.mjs", "utf8"), source);
    assert.equal(events.filter(e => e.type === "tool.completed" && e.data?.toolName === "run_command").length, mode === "no-history" ? 0 : 1);
    if (mode === "mixed") {
      assert.equal(result.stopped, true); assert.notEqual(state.meta.goalContract.status, "completed");
      assert.equal(planned.length, 1, "Fresh unmet passing-test requirement retains normal planning");
      assert.ok(!current.some(e => e.type === "scs.student.finish_allowed"));
    } else {
      assert.notEqual(result.stopped, true); assert.equal(result.result, reply);
      assert.equal(planned.length, 0, "Known read-only answer must not pay for a separate model phase plan");
      // A final-review rejection retains its normal committee/student repair.
      // It is not an initial phase-plan request and must not be optimized away.
      assert.equal(calls.filter(r => r.planning).length, rejectFirst ? 2 : 0); assert.equal(calls.filter(r => r.execution).length, rejectFirst || mode === "en-read" ? 2 : 1);
      assert.equal(calls.filter(r => r.review).length, modelReview ? rejectFirst ? 2 : 1 : 0);
      assert.ok(calls.every(r => !r.offeredTools.includes("write_file") && !r.offeredTools.includes("apply_patch")));
      assert.equal(state.meta.projectVerification?.testRuns?.length || 0, 0);
      assert.equal(state.meta.projectVerification?.commandRuns?.length || 0, 0);
      assert.equal(current.filter(e => e.type === "tool.completed" && e.data?.toolName === "read_file").length, mode === "en-read" ? 1 : 0);
      if (scsMode === "on") {
        assert.ok(current.some(e => e.type === "plan.constrained_phase_reused" && e.data?.mode === "read-only-answer"));
        assert.equal(current.filter(e => e.type === "scs.student.finish_allowed").length, 1, "The final SCS gate remains authoritative");
        assert.equal(current.filter(e => e.type === "scs.student.finish_rejected").length, rejectFirst ? 1 : 0);
      }
    }
    assert.deepEqual(errors, []);
    await assert.rejects(fs.stat(root + "/sessions/diagnostic-status/.agent-run.lock"), { code: "ENOENT" });
    console.log(JSON.stringify({ mode, scsMode, nativeRuntime: true, modelPlanningRequests: planned.length,
      executionRequests: calls.filter(r => r.execution).length, finalReviewRequests: calls.filter(r => r.review).length, reviewRepairRequests: rejectFirst ? calls.filter(r => r.planning).length : 0, taskFilesUnchanged: true,
      commandExecutions: mode === "no-history" ? 0 : 1, stopped: result.stopped === true, runtimeRevision: state.meta.runtimeConfig.revision, externalModelCalls: 0 }));
  });
}
