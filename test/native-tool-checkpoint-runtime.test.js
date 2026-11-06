import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { repairModelMessageHistory } from "../src/agent-runner.js";

const childPath = new URL("./fixtures/native-tool-checkpoint-runtime.js", import.meta.url).pathname;
const note = "Latency improved from 120 ms to 90 ms.\n", summary = "# Summary\n\nLatency improved from 120 ms to 90 ms.\n";
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function assertClosed(messages) {
  const pending = new Set();
  for (const m of messages) {
    if (m.role === "tool") { assert.ok(pending.delete(m.tool_call_id)); continue; }
    assert.equal(pending.size, 0, "new message precedes native tool replies");
    for (const c of m.tool_calls || []) { assert.equal(pending.has(c.id), false); pending.add(c.id); }
  }
  assert.equal(pending.size, 0);
}

function confirmedPayloads(messages) {
  const calls = new Map(), results = [];
  for (const m of messages) {
    for (const c of m.tool_calls || []) calls.set(c.id, c.function.name);
    if (m.role === "tool") {
      const value = JSON.parse(m.content);
      if (value.ok === true) results.push({ ...value, toolName: calls.get(m.tool_call_id) });
    }
    if (m.role === "user" && typeof m.content === "string") {
      const match = /^Retained runtime tool evidence\.[^\n]*\nTool:\s*([^\n]+)\nArguments:\s*([^\n]+)\nVerified result:\s*([\s\S]+)$/.exec(m.content);
      if (match) {
        const value = JSON.parse(match[3]);
        if (value.ok === true) results.push({ ...value, toolName: match[1] });
      }
    }
  }
  return results;
}

const frame = (ids = ["completed_write"], name = "write_file") => ({ role: "assistant", content: null,
  tool_calls: ids.map(id => ({ id, type: "function", function: { name, arguments: '{"path":"summary.md"}' } })) });
const outcome = (id = "completed_write", payload = { ok: true, path: "summary.md", changed: true, goalRevision: 1, projectMutationRevision: 2 }) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(payload) });

test("reasoning-incompatible complete frames retain bounded confirmed evidence", () => {
  const state = { messages: [{ role: "system", content: "Native runtime" }, frame(), outcome(), { role: "user", content: "Continue" }] };
  const result = repairModelMessageHistory(state, { provider: "deepseek" });
  assert.equal(result.changed, true); assertClosed(state.messages);
  assert.equal(state.messages.some(m => m.role === "assistant" || m.role === "tool"), false);
  const proofs = confirmedPayloads(state.messages); assert.equal(proofs.length, 1);
  assert.equal(proofs[0].toolName, "write_file"); assert.equal(proofs[0].path, "summary.md");
  assert.equal(state.messages.at(-1).content, "Continue");
});

test("incomplete native frames never manufacture a retained result", () => {
  const state = { messages: [frame(["one", "two"]), outcome("one"), { role: "user", content: "Continue" }] };
  const result = repairModelMessageHistory(state, { provider: "deepseek" });
  assert.equal(result.incompleteToolCallMessages, 1); assert.deepEqual(confirmedPayloads(state.messages), []);
  assert.equal(state.messages.some(m => m.role === "assistant" || m.role === "tool"), false);
});

test("duplicate or foreign results cannot become confirmed retained evidence", () => {
  for (const extra of [outcome(), outcome("foreign")]) {
    const state = { messages: [frame(), outcome(), extra] };
    repairModelMessageHistory(state, { provider: "deepseek" });
    assert.deepEqual(confirmedPayloads(state.messages), []);
  }
  const duplicateIds = { messages: [frame(["same", "same"]), outcome("same")] };
  repairModelMessageHistory(duplicateIds, { provider: "deepseek" });
  assert.deepEqual(confirmedPayloads(duplicateIds.messages), []);
});

test("failed, blocked and skipped outcomes do not become successful evidence", () => {
  for (const payload of [{ ok: false }, { ok: true, blocked: true }, { ok: true, skipped: true }]) {
    const state = { messages: [frame(), outcome(undefined, payload)] };
    repairModelMessageHistory(state, { provider: "deepseek" }); assert.deepEqual(confirmedPayloads(state.messages), []);
  }
});

test("compatible DeepSeek and ordinary OpenAI native frames remain native", () => {
  for (const provider of ["deepseek", "openai"]) {
    const a = frame(); if (provider === "deepseek") a.reasoning_content = "Use the source file.";
    const reply = outcome(), state = { messages: [a, reply] };
    const result = repairModelMessageHistory(state, { provider });
    assert.equal(result.changed, false); assert.equal(state.messages[1], reply);
    assert.equal(state.messages[0].tool_calls[0].id, "completed_write");
    assert.equal(state.messages[0].reasoning_content, a.reasoning_content);
  }
});

test("retained read output uses existing bounded compaction rather than raw output", () => {
  const state = { messages: [frame(undefined, "read_file"), outcome(undefined, { ok: true, path: "summary.md", content: "Z".repeat(100000), bytes: 100000 })] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  const proofs = confirmedPayloads(state.messages); assert.equal(proofs.length, 1); assert.ok(proofs[0].content.length < 4000);
  assert.ok(JSON.stringify(state.messages).length < 7000);
});

test("unsupported tool data is not promoted into retained text", () => {
  const state = { messages: [frame(undefined, "unknown_native_tool"), outcome(undefined, { ok: true, stdout: "UNTRUSTED_RESULT" })] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  assert.deepEqual(state.messages, []);
});

test("retained mutation evidence preserves exact recorded scope revisions", () => {
  const state = { messages: [frame(), outcome()] };
  repairModelMessageHistory(state, { provider: "deepseek" });
  const [proof] = confirmedPayloads(state.messages); assert.equal(proof.goalRevision, 1); assert.equal(proof.projectMutationRevision, 2);
  assert.equal(proof.changed, true); assert.equal(proof.path, "summary.md");
});

for (const mode of ["crash", "read-batch", "callback-error", "save-error", "normal"]) test(`completed native batch checkpoint: ${mode}`, { timeout: 25000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-tool-checkpoint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/note.txt", note); await fs.writeFile(root + "/workspace/other.txt", "Other note remains open.\n");
  const session = root + "/sessions/tool-checkpoint-" + mode; let step = 0, phase = "start"; const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); assertClosed(body.messages);
      let message;
      if (!body.tools) message = { content: "Read the supplied note, complete the requested task, verify and finish." };
      else {
        step++;
        if (phase === "resume") {
          const proofs = confirmedPayloads(body.messages);
          const requiredPaths = mode === "read-batch" ? ["note.txt", "other.txt"] : ["summary.md"];
          for (const target of requiredPaths) assert.ok(proofs.some(p => p.path === target && (mode === "read-batch" ? p.toolName === "read_file" : ["write_file", "apply_patch"].includes(p.toolName))), "confirmed completed outcome absent: " + target);
          message = step === 1 && mode !== "read-batch" ? { tool_calls: [call("read_file", { path: "summary.md" }, "resume_verify")] }
            : { tool_calls: [call("finish", { result: mode === "read-batch" ? "The first note reports latency improving from 120 ms to 90 ms; the other note remains open." : "Saved summary.md with the latency improvement from 120 ms to 90 ms; note.txt is unchanged." }, "resume_finish")] };
        } else if (step === 1) {
          message = { tool_calls: [call("read_file", { path: "note.txt" }, "checkpoint_read")] };
          if (mode === "read-batch") message.tool_calls.push(call("read_file", { path: "other.txt" }, "checkpoint_other"));
        } else if (step === 2 && mode !== "read-batch") {
          const write = body.tools.some(t => t.function.name === "write_file") ? call("write_file", { path: "summary.md", content: summary, mode: "create" }, "checkpoint_write")
            : call("apply_patch", { patch: "*** Begin Patch\n*** Add File: summary.md\n" + summary.trimEnd().split("\n").map(x => "+" + x).join("\n") + "\n*** End Patch" }, "checkpoint_write");
          message = { tool_calls: [write, call("read_file", { path: "summary.md" }, "deferred_verify")] };
        } else message = { tool_calls: [call("finish", { result: "Saved summary.md with the latency improvement from 120 ms to 90 ms; note.txt is unchanged." }, "normal_finish")] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (e) { errors.push(e.message); res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"Offline checkpoint fixture rejected request"}}'); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [childPath, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", expired = false; c.stdout.on("data", x => stdout += x); c.stderr.on("data", x => stderr += x);
    const timer = setTimeout(() => { expired = true; c.kill("SIGKILL"); }, 12000);
    c.once("error", reject); c.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, expired, stdout, stderr }); });
  });
  const first = await run(); assert.equal(first.expired, false); assert.deepEqual(errors, []);
  if (["crash", "read-batch"].includes(mode)) assert.equal(first.signal, "SIGKILL");
  else assert.equal(first.code, mode === "normal" ? 0 : 1, JSON.stringify(first));
  let state = JSON.parse(await fs.readFile(session + "/state.json")); assertClosed(state.messages);
  const required = mode === "read-batch" ? ["checkpoint_read", "checkpoint_other"] : ["checkpoint_write"];
  for (const id of required) assert.ok(state.messages.some(m => m.role === "tool" && m.tool_call_id === id && JSON.parse(m.content).ok === true), "completed outcome missing after callback/death: " + id);
  assert.ok(state.stepsCompleted >= (mode === "read-batch" ? 1 : 2));
  if (mode === "save-error") await assert.rejects(fs.stat(root + "/post-result-callback.json"), { code: "ENOENT" });
  if (mode !== "normal") {
    const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.some(e => e.type === "session.finished"), false);
    phase = "resume"; step = 0; const resumed = await run(); assert.equal(resumed.code, 0, JSON.stringify({ resumed, errors })); assert.deepEqual(errors, []);
    assert.equal(JSON.parse(resumed.stdout.trim().split("\n").at(-1)).stopped, undefined);
  }
  state = JSON.parse(await fs.readFile(session + "/state.json")); assertClosed(state.messages); assert.equal(state.meta.goalContract.status, "completed");
  const events = (await fs.readFile(session + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.started" && ["write_file", "apply_patch"].includes(e.data.toolName)).length, mode === "read-batch" ? 0 : 1);
  if (mode !== "read-batch") assert.equal(await fs.readFile(root + "/workspace/summary.md", "utf8"), summary);
  assert.equal(await fs.readFile(root + "/workspace/note.txt", "utf8"), note);
  await assert.rejects(fs.stat(session + "/.agent-run.lock"), { code: "ENOENT" });
});
