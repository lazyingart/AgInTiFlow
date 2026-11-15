import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const source = "\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}Status note.\\end{document}\n";
for (const mode of ["ordinary", "fifo"]) test(`native document source selection remains cancellable: ${mode}`, { timeout: 15000 }, async t => {
  if (mode === "fifo" && process.platform === "win32") return t.skip("POSIX FIFO only");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-source-native-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(root + "/workspace"); let turns = 0, requests = 0; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      if (body.tools && turns++ > 0) { await new Promise(resolve => res.once("close", resolve)); return; }
      const message = !body.tools ? { role: "assistant", content: JSON.stringify({ phase_goal: "Write the source and compile the requested PDF.",
        plan: "1. Create an editable TeX source.\n2. Compile the PDF.\n3. Verify it.", acceptance_criteria: ["A valid PDF exists."], stop_conditions: ["Compilation is unavailable."] }) }
        : { role: "assistant", content: null, tool_calls: [{ id: "owned_source_write", type: "function", function: {
          name: "write_file", arguments: JSON.stringify({ path: "status-note.tex", mode: "create", content: source }) } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (e) { errors.push(e.message); res.writeHead(500); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0",
    AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0",
    ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-document-source-cancel.js", import.meta.url)), root,
    "http://127.0.0.1:" + server.address().port + "/v1", mode], { cwd: root + "/workspace", env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", killed = false; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 7000);
    child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
  assert.equal(killed, false, "Source inference blocked the native event loop"); assert.equal(exit.signal, null); assert.equal(exit.code, 0, stderr); assert.deepEqual(errors, []);
  const report = JSON.parse(stdout); assert.equal(report.error, null); assert.equal(report.sourceWritten, true); assert.equal(report.sourceOpened, true);
  assert.equal(report.sourceClosed, true); assert.equal(report.abortDelivered, true); assert.equal(report.result.reason, "user_interrupt"); assert.equal(report.result.goalStatus, "paused");
  const events = (await fs.readFile(root + "/sessions/document-source-" + mode + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "write_file").length, 1);
  assert.equal(events.filter(e => e.data?.toolName === "run_command").length, 0);
  if (mode === "ordinary") assert.equal(await fs.readFile(root + "/workspace/status-note.tex", "utf8"), source);
  else assert.equal((await fs.lstat(root + "/workspace/status-note.tex")).isFIFO(), true);
  const state = JSON.parse(await fs.readFile(root + "/sessions/document-source-" + mode + "/state.json", "utf8"));
  assert.equal(state.meta.runtimeConfig.revision, 1);
  await assert.rejects(fs.stat(root + "/sessions/document-source-" + mode + "/.agent-run.lock"), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, realNativeRuntime: true, scriptedProvider: true, externalModelCalls: 0, sourceWriteEvents: 1,
    compilerCommands: 0, sourceDescriptorClosed: true, cancellationDelivered: true, sessionLeaseReleased: true, workerKilled: false,
    runtimeRevision: 1, goalStatus: report.result.goalStatus, requests, scope: "Cancellation after real source classification; not PDF generation or model quality" }));
});
