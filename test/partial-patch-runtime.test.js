import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile), child = new URL("./fixtures/partial-patch-runtime.js", import.meta.url).pathname;
const original = "# Small project\nNo generated files yet.\n", planning = "# Planning\n- Inspect the request\n- Make the changes\n", review = "# Review\n- Check the changes\n- Verify the result\n";
const add = (name, text) => "*** Add File: " + name + "\n" + text.split("\n").map(line => "+" + line).join("\n");
const patch = (...operations) => "*** Begin Patch\n" + operations.join("\n") + "\n*** End Patch";
for (const mode of ["EIO", "ENOSPC", "normal", "local-handoff"]) test(`persisted partial patch: ${mode}`, { timeout: 25000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-partial-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/README.md", original);
  let phase = "start", step = 0, requests = 0, retainedSeen = false; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      // Test-owned readiness DTOs only; never contact a real LocalLLM service.
      if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "localllm-api", ollama: { ok: true, version: "offline-fixture" } })); return; }
      if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "localllm-fast" }] })); return; }
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      let message;
      if (!body.tools) message = { content: "Read the instructions, add the checklists, verify and finish." };
      else {
        const n = ++step, call = (name, args) => ({ id: `partial_${phase}_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
        if (phase === "resume") {
          const retained = body.messages.find(m => m.role === "user" && m.content?.startsWith("Retained runtime tool evidence.") && m.content.includes('"partial":true'));
          const native = body.messages.find(m => m.role === "tool" && m.content?.includes('"partial":true'));
          if (mode === "local-handoff") { assert.equal(body.model, "localllm-fast"); assert.ok(retained || native, "partial outcome absent across provider handoff"); retainedSeen = true; }
          else { assert.ok(retained, "partial outcome absent after provider history repair"); assert.match(retained.content, /patch is incomplete/); assert.match(retained.content, /planning.md/); assert.match(retained.content, /"ok":false/); retainedSeen = true; }
          message = { tool_calls: [n === 1 ? call("read_file", { path: "planning.md" }) : n === 2 ? call("apply_patch", { patch: patch(add("review.md", review)) }) : n === 3 ? call("read_file", { path: "review.md" }) : call("finish", { result: "Added planning.md and review.md checklists. README.md is unchanged." })] };
        } else message = { tool_calls: [n === 1 ? call("read_file", { path: "README.md" }) : n === 2 ? call("apply_patch", { patch: patch(add("planning.md", planning), add("review.md", review)) }) : n === 3 ? call("read_file", { path: "review.md" }) : call("finish", { result: "Added planning.md and review.md checklists. README.md is unchanged." })] };
        assert.ok(body.tools.some(tool => tool.function.name === message.tool_calls[0].function.name), "fixture tool not offered");
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline partial-patch fixture rejected"}}'); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const invoke = async () => {
    const r = await run(process.execPath, [child, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
    }).catch(error => { if (phase === "start" && mode !== "normal" && error.code === 1) return error; throw new Error("Unexpected offline fixture failure: " + (error.stdout || error.stderr || error.message)); });
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  };
  let result = await invoke(); const dir = root + "/sessions/partial-patch-" + mode;
  const read = async () => ({ state: JSON.parse(await fs.readFile(dir + "/state.json")), events: (await fs.readFile(dir + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse) });
  if (mode !== "normal") {
    assert.equal(result.injected, true); assert.equal(result.error.code, "OBSERVER_DELIVERY_FAILED");
    const { state, events } = await read(); const failure = events.find(e => e.type === "tool.failed" && e.data.toolName === "apply_patch");
    assert.equal(failure.data.partial, true); assert.equal(failure.data.changes[0].path, "planning.md"); assert.equal(failure.data.partialPatch.failedOperation.path, "review.md");
    assert.equal(state.meta.projectVerification.mutationRevision, 1); assert.deepEqual(state.meta.projectVerification.mutationHistory.at(-1).paths, ["planning.md"]);
    assert.equal(events.filter(e => e.type === "file.changed").length, 1); assert.equal(events.some(e => e.type === "session.finished"), false);
    assert.equal(await fs.readFile(root + "/workspace/planning.md", "utf8"), planning); await assert.rejects(fs.stat(root + "/workspace/review.md"), { code: "ENOENT" });
    await assert.rejects(fs.stat(dir + "/.agent-run.lock"), { code: "ENOENT" }); phase = "resume"; step = 0; result = await invoke(); assert.equal(retainedSeen, true);
  }
  assert.deepEqual(errors, []); assert.notEqual(result.result.stopped, true);
  const { state, events } = await read(); assert.equal(state.meta.goalContract.status, "completed");
  if (mode === "local-handoff") assert.equal(state.meta.runtimeConfig.provider, "localllm");
  assert.equal(await fs.readFile(root + "/workspace/README.md", "utf8"), original); assert.equal(await fs.readFile(root + "/workspace/planning.md", "utf8"), planning); assert.equal(await fs.readFile(root + "/workspace/review.md", "utf8"), review);
  const changed = events.filter(e => e.type === "file.changed"); assert.equal(changed.length, 2); assert.deepEqual(changed.map(e => e.data.path), ["planning.md", "review.md"]);
  assert.equal(events.filter(e => e.type === "session.finished").length, 1); assert.equal(state.meta.projectVerification.mutationRevision, mode === "normal" ? 1 : 2);
  assert.ok(requests <= 9); assert.deepEqual((await fs.readdir(root + "/workspace")).filter(n => n !== ".aginti").sort(), ["README.md", "planning.md", "review.md"]);
});
