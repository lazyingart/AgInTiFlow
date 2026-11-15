import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const mode of ["ordinary", "outside", "denied"]) test(`native persisted writing honors the source read boundary: ${mode}`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-writer-native-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  await fs.mkdir(root + "/workspace"); await fs.mkdir(root + "/excluded");
  const original = "Authorized source: the orchard trial used eight samples.\n", sentinel = "EXCLUDED_VIOLET_LIGHTHOUSE";
  await fs.writeFile(root + "/workspace/notes.md", original); await fs.writeFile(root + "/excluded/record.txt", sentinel);
  let turn = 0, replaced = false; const errors = [];
  const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const b of request) chunks.push(b);
      const body = JSON.parse(Buffer.concat(chunks)); let message;
      if (!body.tools) message = { content: "Read the source, draft from that source and report the article." };
      else if (turn++ === 0) message = { tool_calls: [call("read_file", { path: "notes.md" }, "read_source")] };
      else if (turn === 2) {
        if (mode === "outside") { replaced = true; await fs.unlink(root + "/workspace/notes.md"); await fs.symlink(root + "/excluded/record.txt", root + "/workspace/notes.md"); }
        message = { tool_calls: [call("writing_specialist", { kind: "article", language: "en", writingBrief: "Write a short article based on notes.md.", canon: "notes.md is the sole source of truth.",
          provider: mode === "denied" ? "openai" : "deepseek", model: mode === "denied" ? "unqualified-writer" : "deepseek-flash" }, "draft_source")] };
      } else message = { tool_calls: [call("finish", { result: mode === "denied" ? "The source was read, but the requested writing provider is unavailable under the active permission policy." : "The orchard trial used eight samples, according to the supplied source." }, "finish_source")] };
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message); response.writeHead(500); response.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: root + "/home", LANG: "C.UTF-8", AGINTIFLOW_HOUSEKEEPING: "0",
    AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0",
    ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/native-writer-read-boundary.js", import.meta.url)), root, `http://127.0.0.1:${server.address().port}/v1`, mode], { cwd: root + "/workspace", env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; worker.stdout.on("data", b => stdout += b); worker.stderr.on("data", b => stderr += b);
  const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { worker.kill("SIGKILL"); reject(Error("Native writer test timed out")); }, 15000);
    worker.once("error", error => { clearTimeout(timer); reject(error); }); worker.once("close", code => { clearTimeout(timer); resolve(code); }); });
  assert.equal(exit, 0, stderr); assert.deepEqual(errors, []);
  const report = JSON.parse(stdout), serialized = JSON.stringify(report.writerPayloads);
  assert.equal(report.writerPayloads.length, mode === "denied" ? 0 : 1, JSON.stringify(report));
  assert.ok(!serialized.includes(sentinel), "Excluded bytes reached a writing provider");
  if (mode === "ordinary") assert.ok(serialized.includes("AUTHORIZED SOURCE MATERIAL") || serialized.includes("AUTHORITATIVE SOURCE MATERIAL"));
  if (mode === "denied") assert.equal(report.sourceAccessesDuringWriter, 0, "Denied writing must not refresh source contents first");
  const state = JSON.parse(await fs.readFile(`${root}/sessions/writer-boundary-${mode}/state.json`, "utf8"));
  const events = (await fs.readFile(`${root}/sessions/writer-boundary-${mode}/events.jsonl`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(state.sessionId, "writer-boundary-" + mode); assert.ok(!JSON.stringify(state).includes(sentinel));
  assert.equal(events.filter(event => event.type === "writing.context_grounded").length, mode === "ordinary" ? 1 : 0);
  assert.equal(replaced, mode === "outside");
});
