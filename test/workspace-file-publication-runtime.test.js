import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile), child = new URL("./fixtures/workspace-file-publication-runtime.js", import.meta.url).pathname;
const original = "# Projecct Handoff\nOwner: Demo Team\nState: draft\n", expected = original.replace("Projecct", "Project");
for (const mode of ["EIO", "ENOSPC", "normal"]) test(`persisted native file publication and same-session retry: ${mode}`, { timeout: 25000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/note.txt", original);
  let phase = "start", step = 0, requests = 0; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      let message;
      if (!body.tools) message = { content: "Read the note, fix only the typo, verify and finish." };
      else {
        const call = (name, args) => ({ id: `publication_${phase}_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
        const current = ++step;
        if (current === 1 || current === 3) message = { tool_calls: [call("read_file", { path: "note.txt" })] };
        else if (current === 2) message = { tool_calls: [call("apply_patch", { path: "note.txt", search: "Projecct", replace: "Project", expectedReplacements: 1 })] };
        else message = { tool_calls: [call("finish", { result: "Corrected the spelling in note.txt from Projecct to Project. The owner and state lines are unchanged." })] };
        assert.ok(body.tools.some(tool => tool.function.name === message.tool_calls[0].function.name), "fixture attempted a tool not offered");
        if (phase === "resume") assert.ok(body.messages.some(m => m.role === "user" && m.content?.includes("Continue the same task.")));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline publication fixture rejected"}}'); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const invoke = async () => {
    const result = await run(process.execPath, [child, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
    }).catch(error => { if (phase === "start" && mode !== "normal" && error.code === 1) return error; throw error; });
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  let result = await invoke(); const session = root + "/sessions/file-publication-" + mode;
  if (mode !== "normal") {
    assert.equal(result.injected, true); assert.equal(result.error.code, "PAUSE_AFTER_FAILED_WRITE");
    assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), original);
    assert.equal(JSON.parse(await fs.readFile(session + "/state.json")).meta.goalContract.status, "failed");
    await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
    phase = "resume"; step = 0; result = await invoke();
  }
  assert.deepEqual(errors, []); assert.notEqual(result.result.stopped, true);
  const state = JSON.parse(await fs.readFile(session + "/state.json"));
  const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(state.meta.goalContract.status, "completed"); assert.equal(state.sessionId, "file-publication-" + mode);
  assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), expected);
  // Resume can create the normal internal project runtime directory.
  assert.deepEqual((await fs.readdir(root + "/workspace")).filter(name => name !== ".aginti"), ["note.txt"]);
  assert.equal(events.filter(e => e.type === "tool.failed" && e.data.toolName === "apply_patch").length, mode === "normal" ? 0 : 1);
  const writes = events.filter(e => e.type === "tool.completed" && e.data.toolName === "apply_patch");
  assert.equal(writes.length, 1); assert.equal(writes[0].data.change.afterHash, crypto.createHash("sha256").update(expected).digest("hex"));
  assert.equal(events.filter(e => e.type === "session.finished").length, 1); assert.ok(requests <= 8);
  await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
});
