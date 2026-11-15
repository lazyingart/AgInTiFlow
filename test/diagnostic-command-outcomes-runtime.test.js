import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const goal = "Run `node --test check.mjs` once and tell me the result. Do not repair anything or create or modify any file.";
const failedReport = "The check failed: 1 assertion, expected 2 but observed 1. No task files were changed.";
for (const scsMode of ["off", "on"]) for (const mode of ["failed-honest", "passed-honest", "failed-false-en", "failed-false-zh", "failed-false-ja", "empty-after-fail", "empty-finish", "handoff", "must-pass-zh", "compound", "compound-empty", "write-after-result", "explain-en", "explain-zh", "explain-ja", "mixed-explanation", "mixed-explanation-guarantee", "mixed-explanation-get"]) test(`real native diagnostic outcome: ${mode} (SCS ${scsMode})`, { timeout: 40000 }, async t => {
  const compound = mode.startsWith("compound"), emptyReply = mode === "empty-after-fail" || mode === "compound-empty";
  const explaining = mode.startsWith("explain-");
  const mixedExplanation = mode.startsWith("mixed-explanation"), followup = explaining || mixedExplanation;
  const mixedRequest = "Why did the last check fail and " + (mode.endsWith("-guarantee") ? "guarantee tests pass" : mode.endsWith("-get") ? "get the tests to pass" : "ensure tests pass") + "? Do not modify any file.";
  const explanations = {
    "explain-en": { prompt: "Why did the last check fail? Did you change any file? Do not rerun it or modify any file.", result: "The check failed because the assertion expected 2 but observed 1. No check file was modified or rerun." },
    "explain-zh": { prompt: "刚才为什么失败？有没有改动检查文件？不要重跑，也不要修改文件。", result: "检查失败是因为断言期望2，实际为1。检查文件没有改动，也没有重新运行。" },
    "explain-ja": { prompt: "先ほどのチェックはなぜ失敗しましたか？ファイルを変更しましたか？再実行せず、読み取り専用で答えてください。", result: "チェックは期待値2に対して実際の値が1だったため失敗しました。ファイルは変更せず、再実行もしていません。" },
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-diagnostic-native-")), workspace = path.join(root, "workspace");
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(workspace);
  const source = `import test from 'node:test';import assert from 'node:assert/strict';test('owned diagnostic',()=>assert.equal(1,${mode === "passed-honest" || compound ? 1 : 2}));\n`;
  await fs.writeFile(path.join(workspace, "check.mjs"), source);
  if (compound) await fs.writeFile(path.join(workspace, "other-check.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';test('second diagnostic',()=>assert.equal(1,2));\n");
  const request = mode === "must-pass-zh" ? "只读运行 `node --test check.mjs`，必须保证检查全部通过。" : compound
    ? "Run `node --test check.mjs` once, then run `node --test other-check.mjs` once and report both observed results. Do not repair anything or create or modify any file." : goal;
  let phase = "start", turns = 0, requests = 0; const models = [], errors = [], offers = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const b of req) chunks.push(b);
      const body = JSON.parse(Buffer.concat(chunks)); requests++; assert.ok(requests <= 14);
      models.push({ phase, model: body.model }); offers.push((body.tools || []).map(t => t.function.name));
      const call = (name, args) => ({ id: "diagnostic_" + requests, type: "function", function: { name, arguments: JSON.stringify(args) } });
      let message;
      if (!body.tools) message = { content: "Run the exact requested diagnostic and report observed evidence only." };
      else if (phase === "start" && turns++ === 0) message = { tool_calls: [call("run_command", { command: "node --test check.mjs" })] };
      else if (compound && turns === 2) message = { tool_calls: [call("run_command", { command: "node --test other-check.mjs" })] };
      else if (mode === "handoff" && phase === "start") {
        res.writeHead(402, { "content-type": "application/json" }); res.end('{"error":{"code":"insufficient_quota","message":"Synthetic quota refusal after diagnostic persistence"}}'); return;
      } else if (mode === "write-after-result") message = { tool_calls: [call("write_file", { path: "unrequested.md", mode: "create", content: "Unrequested repair" })] };
      else if (emptyReply) message = { content: "" };
      else {
        const report = explaining && phase === "resume" ? explanations[mode].result : compound ? "The first check exited with code 0; the second check failed with code 1. No task files were changed."
          : mode === "empty-finish" ? "" : mode === "passed-honest" ? "The check passed: 1 test, 0 failures. No task files were changed."
          : mode === "failed-false-en" ? "All tests passed. No failures remain."
          : mode === "failed-false-zh" ? "所有测试全部通过，没有失败。"
          : mode === "failed-false-ja" ? "テストはすべて成功しました。"
          : failedReport;
        message = { tool_calls: [call("finish", { result: report })] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0,
        finish_reason: message.tool_calls ? "tool_calls" : emptyReply ? "length" : "stop",
        message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(e.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  async function run() {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-diagnostic-command-outcomes.js", import.meta.url)), root,
      "http://127.0.0.1:" + server.address().port + "/v1", phase === "start" ? request : explaining ? explanations[mode].prompt : mixedExplanation ? mixedRequest : "Please continue from where you stopped.", phase], {
      cwd: workspace, env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home",
        AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_TEST_SCS_MODE: scsMode,
        ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "", timedOut = false; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 18000);
      child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
    assert.equal(timedOut, false); assert.equal(exit.signal, null); assert.equal(exit.code, 0, err); return JSON.parse(out);
  }
  let result = await run();
  if (mode === "handoff") { assert.equal(result.status, 402); phase = "resume"; result = await run(); }
  let originalDiagnosticState;
  if (followup) {
    assert.notEqual(result.result.stopped, true);
    originalDiagnosticState = JSON.parse(await fs.readFile(root + "/sessions/diagnostic-status/state.json", "utf8"));
    assert.equal(originalDiagnosticState.meta.projectVerification.testRuns.at(-1).passed, false);
    phase = "resume"; result = await run();
  }
  const state = JSON.parse(await fs.readFile(root + "/sessions/diagnostic-status/state.json", "utf8"));
  const events = (await fs.readFile(root + "/sessions/diagnostic-status/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  const commands = events.filter(e => e.type === "tool.completed" && e.data?.toolName === "run_command");
  const testRun = (originalDiagnosticState || state).meta.projectVerification?.testRuns.at(-1), finishes = events.filter(e => e.type === "session.finished");
  assert.equal(result.resolved, true); assert.equal(commands.length, compound ? 2 : 1); assert.equal(commands[0].data.exitCode, mode === "passed-honest" || compound ? 0 : 1);
  if (compound) assert.equal(commands[1].data.exitCode, 1);
  assert.equal(await fs.readFile(workspace + "/check.mjs", "utf8"), source);
  const entries = (await fs.readdir(workspace, { recursive: true })).sort();
  assert.ok(entries.every(name => ["check.mjs", ...(compound ? ["other-check.mjs"] : []), ".aginti", ".aginti/codebase-map.json"].includes(name)), JSON.stringify(entries));
  if (compound) assert.equal(await fs.readFile(path.join(workspace, "other-check.mjs"), "utf8"), "import test from 'node:test';import assert from 'node:assert/strict';test('second diagnostic',()=>assert.equal(1,2));\n");
  // This negative checks the native success gate even when a command has not
  // been classified as a substantive test. Never manufacture a test-run record.
  if (mode === "must-pass-zh") {
    assert.notEqual(commands[0].data.diagnosticCommandObserved, true);
    if (testRun) assert.equal(testRun.passed, false);
  } else assert.equal(testRun.passed, mode === "passed-honest");
  if (mode.startsWith("failed-false") || mode === "must-pass-zh" || mode === "empty-finish" || mode === "write-after-result" || mixedExplanation) {
    assert.equal(result.result.stopped, true); assert.equal(finishes.length, mixedExplanation ? 1 : 0); assert.notEqual(state.meta.goalContract.status, "completed");
  } else if (emptyReply) {
    assert.notEqual(result.result.stopped, true); assert.equal(finishes.length, 1); assert.equal(state.meta.goalContract.status, "completed");
    assert.doesNotMatch(result.result.result, /could not verify.*executed/i);
    assert.match(result.result.result, /fail|exit(?:ed)?[^\d]{0,20}1|失败|失敗/i);
    assert.ok(events.some(e => e.type === "completion.verified_fallback")); assert.ok(requests <= (compound ? 5 : 4));
    if (compound) assert.match(result.result.result, /other-check\.mjs/);
  } else {
    assert.notEqual(result.result.stopped, true); assert.equal(state.meta.goalContract.status, "completed"); assert.equal(finishes.length, explaining ? 2 : 1);
    assert.equal(result.result.result, explaining ? explanations[mode].result : compound ? "The first check exited with code 0; the second check failed with code 1. No task files were changed."
      : mode === "passed-honest" ? "The check passed: 1 test, 0 failures. No task files were changed." : failedReport);
  }
  if (mode === "handoff") {
    assert.equal(state.meta.runtimeConfig.revision, 2); assert.equal(state.meta.goalContract.revision, 2);
    assert.equal(state.meta.activeExecutionContract.revision, 1); assert.equal(requests, 3);
    assert.deepEqual(models.map(m => m.model), ["deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);
  }
  if (explaining) {
    assert.equal(state.meta.runtimeConfig.revision, 2); assert.equal(state.meta.goalContract.revision, 2);
    assert.equal(state.meta.projectVerification, undefined, "Do not promote prior diagnostic execution as current task verification");
    assert.deepEqual(models.slice(0, 2).map(m => m.model), ["deepseek-v4-flash", "deepseek-v4-flash"]);
    assert.ok(models.length >= 3 && models.length <= 4);
    assert.ok(models.slice(2).every(m => m.model === "deepseek-v4-pro"));
  }
  if (mixedExplanation) {
    assert.equal(state.meta.runtimeConfig.revision, 2); assert.equal(state.meta.goalContract.revision, 2);
    assert.equal(originalDiagnosticState.meta.projectVerification.testRuns.at(-1).passed, false);
    assert.equal(state.meta.projectVerification?.testRuns?.length || 0, 0, "A prior failed diagnostic is not fresh pass evidence");
  }
  assert.deepEqual(errors, []); await assert.rejects(fs.stat(root + "/sessions/diagnostic-status/.agent-run.lock"), { code: "ENOENT" });
  assert.ok((await fs.readdir(root + "/sessions/diagnostic-status")).every(name => !name.startsWith(".agent-run.")));
  assert.equal(state.meta.scs?.active === true, scsMode === "on");
  console.log(JSON.stringify({ mode, scsMode, realNativeRuntime: true, commandExecutions: commands.length, observedExitCode: commands[0].data.exitCode,
    testPassed: testRun?.passed ?? null, goalStatus: state.meta.goalContract.status, runtimeRevision: state.meta.runtimeConfig.revision,
    taskFilesUnchanged: true, privateRuntimeCacheAllowed: entries.includes(".aginti/codebase-map.json"), externalModelCalls: 0,
    providerRequests: requests, explicitModels: models.map(m => m.model), sessionReleased: true }));
});
