import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
const marker = "EXCLUDED_SYNTHETIC_ARTIFACT_CANARY_TEAL";
for (const mode of ["ordinary", "outside", "long", "legacy-resume"]) test(`actual native artifact verification retains scope and context truth: ${mode}`, { timeout: 45000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-artifact-native-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(root + "/workspace"); await fs.mkdir(root + "/excluded"); await fs.writeFile(root + "/excluded/data.txt", marker);
  const text = mode === "long" ? ("Project status: prepared for the next local review.\n".repeat(500) + "END_OF_LONG_REPORT\n")
    : "Project status: ready for the next local review.\n";
  const bodies = [], errors = [], reports = []; let toolTurns = 0, phase = "initial", wrote = false, read = false;
  const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "artifact_" + (++toolTurns), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); bodies.push({ phase, body });
      const tools = (body.tools || []).map(tool => tool.function.name);
      const message = !body.tools ? { role: "assistant", content: JSON.stringify({ phase_goal: "Create and verify report.md.",
        plan: "1. Create report.md.\n2. Check its content.\n3. Finish with its path.", acceptance_criteria: ["The requested status note is in report.md."], stop_conditions: ["The output is inaccessible."] }) }
        : !wrote ? (wrote = true, call("write_file", { path: "report.md", content: text }))
        : phase === "resume" && !read && tools.includes("read_file") ? (read = true, call("read_file", { path: "report.md" }))
        : call("finish", { result: phase === "resume" ? "report.md is present. Its content has not been changed." : "Created report.md with the requested project status note." });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(error.message); response.writeHead(500); response.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0",
    AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0",
    ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  const run = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-artifact-validation-context.js", import.meta.url)), root,
      "http://127.0.0.1:" + server.address().port + "/v1", mode, phase], { cwd: root + "/workspace", env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 18000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(timedOut, false); assert.equal(exit, 0, stderr); assert.deepEqual(errors, []);
    const report = JSON.parse(stdout); reports.push(report); assert.equal(report.error, null, JSON.stringify(report)); return report;
  };
  await run();
  const statePath = root + "/sessions/artifact-context-" + mode + "/state.json";
  if (mode === "legacy-resume") {
    assert.equal(reports[0].legacySeeded, true); assert.ok((await fs.readFile(statePath, "utf8")).includes(marker));
    phase = "resume"; await run();
  }
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const events = (await fs.readFile(root + "/sessions/artifact-context-" + mode + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  const serializedRequests = JSON.stringify(bodies);
  assert.ok(!serializedRequests.includes(marker), "Automatic verification forwarded excluded or retired source");
  assert.ok(!JSON.stringify(state).includes(marker), "Excluded or retired artifact bytes remain in current state");
  assert.equal(reports[0].validationStarted, true);
  assert.equal(events.filter(event => event.type === "tool.completed" && event.data.toolName === "write_file" && event.data.ok).length, 1);
  assert.equal(events.filter(event => event.type === "tool.completed" && event.data.toolName === "run_command").length, 0);
  if (mode === "outside") {
    assert.notEqual(reports[0].result.goalStatus, "completed"); assert.equal(state.meta.artifactProgress.outputEmbedded, false);
  } else {
    assert.equal(reports.at(-1).result.goalStatus, "completed", JSON.stringify(reports));
    assert.equal(await fs.readFile(root + "/workspace/report.md", "utf8"), text);
    if (mode === "ordinary") assert.equal(state.meta.artifactProgress.outputEmbedded, true);
    if (mode === "long") {
      assert.equal(state.meta.artifactProgress.outputEmbedded, false); assert.deepEqual(state.meta.artifactProgress.embeddedOutputPaths, []);
      assert.ok(!serializedRequests.includes("END_OF_LONG_REPORT"), "The normalizer should bound long inline context");
    }
  }
  assert.equal(state.meta.runtimeConfig.revision, mode === "legacy-resume" ? 2 : 1);
  if (mode === "legacy-resume") {
    assert.ok(events.some(event => event.type === "history.repaired" && event.data.droppedArtifactMessages > 0));
    assert.ok(bodies.filter(item => item.phase === "resume").every(item => /pro/i.test(item.body.model)));
  }
  await assert.rejects(fs.stat(root + "/sessions/artifact-context-" + mode + "/.agent-run.lock"), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ mode, sessionId: state.sessionId, realNativeRuntime: true, scriptedProvider: true, externalModelCalls: 0,
    sourceMarkerForwarded: false, sourceMarkerPersisted: false, producerCalls: 1, runtimeRevision: state.meta.runtimeConfig.revision,
    goalStatus: reports.at(-1).result.goalStatus, artifactSha256: mode === "outside" ? null : createHash("sha256").update(text).digest("hex"),
    legacyRetired: mode === "legacy-resume", sessionLeaseReleased: true, providerRequests: bodies.length }));
});
