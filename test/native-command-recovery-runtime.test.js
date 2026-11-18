import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import test from "node:test";

const fixture = new URL("./fixtures/native-command-recovery-runtime.js", import.meta.url).pathname;
const tool = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const scenarios = ["intent-before-error", "intent-commit-crash", "effect-crash", "ready-crash", "ready-commit-error", "ready-write-error", "closed-save-error", "event-error", "failed-ready-crash", "bounded-ready-crash", "legacy-unknown", "legacy-confirmed", "legacy-corrupt", "journal-null", "journal-foreign", "workspace-rebind", "workspace-unknown", "recovery-event-error", "mapped-commit-ready-crash", "indexed-ready-crash"];
for (const mode of scenarios) test(`native command durability boundary: ${mode}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-command-recovery-")), requests = [], children = new Set();
  const workspace = path.join(root, "workspace"), stateFile = path.join(root, "sessions/unconfirmed-command/state.json");
  const failed = mode === "failed-ready-crash", large = mode === "bounded-ready-crash";
  const mappedCommit = mode === "mapped-commit-ready-crash";
  await fs.mkdir(path.join(workspace, "tools"), { recursive: true });
  await fs.writeFile(path.join(workspace, "tools/check.mjs"), `import fs from 'node:fs';\nconst file='counter.json';const count=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).count+1:1;fs.writeFileSync(file,JSON.stringify({count}));console.log('Observed check number '+count);${large ? "console.log('password=fixture_private_secret_do_not_publish');console.log('X'.repeat(20000));" : ""}${failed ? "process.exitCode=5;" : ""}\n`);
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (mappedCommit) {
    git("init", "-q"); git("config", "user.name", "Recovery Fixture"); git("config", "user.email", "fixture@example.invalid");
    git("add", "--", "tools/check.mjs"); git("commit", "-qm", "Fixture initial state");
  }
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const hasResult = request.messages.some(m => (m.role === "tool" || m.role === "user") && typeof m.content === "string" && m.content.includes(mappedCommit ? "] fixture commit" : "Observed check number 1"));
    let call = hasResult ? tool("finish", { result: failed ? "The checker reported Observed check number 1 and exited with code 5. I did not repeat it." : "The checker reported Observed check number 1. I did not repeat it." }, "finish_once") : tool("run_command", { command: "node tools/check.mjs" }, "check_once");
    if (mode === "indexed-ready-crash") call.index = 0;
    if (mappedCommit) {
      const names = (request.tools || []).map(t => t.function.name);
      const wrote = request.messages.some(m => m.role === "tool" && m.tool_call_id === "create_note");
      call = hasResult ? tool("finish", { result: "Created note.txt and its local commit. Nothing was pushed." }, "finish_once")
        : names.includes("commit_project_changes") ? tool("commit_project_changes", { message: "fixture commit" }, "check_once")
        : !wrote ? tool("write_file", { path: "note.txt", content: "confirmed\n" }, "create_note")
        : tool("finish", { result: "The note is saved; its local commit is still needed." }, "request_commit");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "offline-recovery", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "Use the original result if it is present.", tool_calls: [call] } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const run = phase => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      detached: true, env: { PATH: process.env.PATH, HOME: path.join(root, "home"), AGINTIFLOW_HOME: path.join(root, "agent-home"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child); let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} reject(Error(`Native recovery deadline ${mode}/${phase}: ${stderr}`)); }, 20000);
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject); child.once("close", (code, signal) => {
      children.delete(child); clearTimeout(timer);
      try { resolve({ code, signal, report: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)) : null, stderr }); } catch (error) { reject(error); }
    });
  });
  const start = await run("start"), saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const unknown = ["intent-before-error", "intent-commit-crash", "effect-crash", "ready-write-error", "legacy-unknown"].includes(mode);
  const invalid = ["legacy-corrupt", "journal-null", "journal-foreign", "workspace-unknown"].includes(mode);
  const expectedCount = mode.startsWith("intent-") ? 0 : 1;
  const count = async () => mappedCommit ? Number(git("rev-list", "--count", "HEAD")) - 1 : JSON.parse(await fs.readFile(path.join(workspace, "counter.json"), "utf8").catch(error => { if (error.code === "ENOENT") return '{"count":0}'; throw error; })).count;
  assert.equal(await count(), expectedCount, JSON.stringify(start));
  assert.equal(saved.meta.nativeCommandJournal.pending?.status || "closed", unknown || invalid ? "dispatching" : ["ready-crash", "failed-ready-crash", "ready-commit-error", "bounded-ready-crash", "workspace-rebind", "recovery-event-error", "mapped-commit-ready-crash", "indexed-ready-crash"].includes(mode) ? "result-ready" : "closed");
  if (mode.startsWith("legacy-")) delete saved.meta.nativeCommandJournal;
  if (mode === "journal-null") saved.meta.nativeCommandJournal = null;
  if (mode === "journal-foreign") saved.meta.nativeCommandJournal.sessionId = "foreign-session";
  if (mode.startsWith("legacy-") || invalid) await fs.writeFile(stateFile, JSON.stringify(saved) + "\n");
  if (mode === "legacy-corrupt") await fs.appendFile(path.join(path.dirname(stateFile), "events.jsonl"), '{"broken":\n');
  const beforeStateBytes = await fs.readFile(stateFile);
  const before = requests.length, resume = await run("resume");
  assert.equal(await count(), expectedCount, "Never redispatch an unconfirmed or receipt-bearing command");
  if (mode !== "workspace-rebind") assert.equal(resume.report?.unhandled, 0, JSON.stringify(resume));
  if (mode === "workspace-rebind") {
    assert.equal(resume.signal, "SIGKILL", JSON.stringify(resume)); assert.equal(requests.length, before);
    const committed = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(committed.meta.runtimeConfig.commandCwd, path.join(root, "next-workspace"));
    assert.equal(committed.meta.nativeCommandJournal.pending, null);
    const again = await run("again"); assert.equal(again.code, 0, JSON.stringify(again));
    assert.equal(await count(), 1);
    // Changing workspace must not promote old-workspace verification into a
    // fresh passing test. The rebound journal still remains readable after the
    // injected crash, and the original checker is never executed again there.
    assert.equal(again.report.outcome.reason, "model_did_not_execute", JSON.stringify(again));
    await assert.rejects(fs.stat(path.join(root, "next-workspace/counter.json")), { code: "ENOENT" });
  } else if (mode === "recovery-event-error") {
    assert.equal(resume.report.error.code, "EIO"); assert.equal(requests.length, before);
    const closed = JSON.parse(await fs.readFile(stateFile, "utf8")); assert.equal(closed.meta.nativeCommandJournal.pending, null);
    const again = await run("again"); assert.equal(again.code, 0, JSON.stringify(again)); assert.equal(again.report.outcome.stopped, undefined);
    assert.equal(await count(), 1);
  } else if (invalid) {
    assert.equal(resume.code, 1, JSON.stringify(resume)); assert.equal(requests.length, before);
    assert.deepEqual(await fs.readFile(stateFile), beforeStateBytes, "Invalid authority does not rewrite state");
    if (mode !== "legacy-corrupt") assert.equal(resume.report.error.code, mode === "workspace-unknown" ? "NATIVE_COMMAND_WORKSPACE_CONFLICT" : "NATIVE_COMMAND_JOURNAL_INVALID");
  } else if (unknown) {
    assert.equal(resume.report?.outcome?.code, "NATIVE_COMMAND_OUTCOME_UNKNOWN", JSON.stringify(resume));
    assert.equal(requests.length, before, "Unknown effect is stopped before provider contact");
    if (mode === "legacy-unknown") {
      const held = JSON.parse(await fs.readFile(stateFile)); assert.equal(held.meta.nativeCommandLegacyHold.unknownCount, 1);
      await fs.writeFile(path.join(path.dirname(stateFile), "events.jsonl"), "");
    }
    const again = await run("again"); assert.equal(again.report?.outcome?.code, "NATIVE_COMMAND_OUTCOME_UNKNOWN"); assert.equal(requests.length, before);
  } else {
    assert.equal(resume.code, 0, JSON.stringify(resume));
    assert.ok(requests.length > before, "Continuation actually receives retained evidence");
    const after = JSON.parse(await fs.readFile(stateFile, "utf8")); assert.equal(after.meta.nativeCommandJournal.pending, null);
    assert.ok(requests.slice(before).every(r => r.messages.some(m => typeof m.content === "string" && m.content.includes(mappedCommit ? "] fixture commit" : "Observed check number 1"))));
    const events = (await fs.readFile(path.join(path.dirname(stateFile), "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.type === "tool.started" && e.data.toolName === "run_command").length, 1);
    if (!failed) assert.equal(after.meta.goalContract.status, "completed", JSON.stringify(resume));
    if (large) {
      const ready = saved.meta.nativeCommandJournal.pending.checkpoint;
      assert.ok(Buffer.byteLength(ready.resultJson) < 131072); assert.equal(ready.resultJson.includes("fixture_private_secret_do_not_publish"), false);
      assert.ok(requests.slice(before).some(r => r.messages.some(m => typeof m.content === "string" && m.content.includes("not a complete stdout/stderr transcript"))));
    }
  }
  await assert.rejects(fs.stat(path.join(path.dirname(stateFile), ".agent-run.lock")), { code: "ENOENT" });
});
