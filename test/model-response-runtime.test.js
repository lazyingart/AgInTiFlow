import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), limit = 16 * 1024 * 1024;
const child = new URL("./fixtures/model-response-runtime.js", import.meta.url);
const note = "Latency improved from 120 ms to 90 ms.\n", summary = "# Summary\n\nLatency improved from 120 ms to 90 ms.\n";
const wrap = message => ({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] });
const call = (name, args, i) => wrap({ tool_calls: [{ id: "native_body_" + i, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

for (const stage of ["plan", "tool"]) test(`native ${stage} oversize cannot dispatch, finish or lose resumability`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-model-response-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "workspace"), { mode: 0o700 }); await fs.writeFile(path.join(root, "workspace/note.txt"), note);
  let mode = "oversize", requests = 0, normal = 0;
  const server = http.createServer((req, res) => {
    req.setEncoding("utf8"); let body = "";
    req.on("data", value => body += value);
    req.on("end", () => {
      requests++; const payload = JSON.parse(body); assert.equal(payload.model, "deepseek-flash");
      assert.equal(req.url, "/v1/chat/completions");
      res.writeHead(200, { "content-type": "application/json" });
      if (mode === "oversize" && (stage === "plan" || payload.tools)) {
        // A complete, valid native write sits before oversized reasoning. The
        // whole response must fail before it can authorize any tool execution.
        const response = call("write_file", { path: "summary.md", content: summary, mode: "create" }, 1);
        response.choices[0].message.reasoning_content = "PRIVATE_PROVIDER_ERROR" + "x".repeat(limit);
        res.end(JSON.stringify(response)); return;
      }
      if (!payload.tools) { res.end(JSON.stringify(wrap({ content: "1. Read note.txt.\n2. Save summary.md.\n3. Verify it and finish." }))); return; }
      normal++;
      const response = normal === 1 ? call("read_file", { path: "note.txt" }, normal)
        : normal === 2 ? call("write_file", { path: "summary.md", content: summary, mode: "create" }, normal)
        : normal === 3 ? call("read_file", { path: "summary.md" }, normal)
        : call("finish", { result: "Created and verified summary.md. The input note.txt is unchanged." }, normal);
      res.end(JSON.stringify(response));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = once(server, "close"); server.close(); server.closeAllConnections(); await done; });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`, sessionId = "response-limit-" + stage;
  const run = async resume => {
    const { stdout } = await exec(process.execPath, [child.pathname, root, baseURL, sessionId, ...(resume ? ["resume"] : [])], {
      env: { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" },
      timeout: 12000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  const failed = await run(false);
  assert.deepEqual(failed, { ok: false, code: "MODEL_RESPONSE_TOO_LARGE", status: 413 });
  assert.equal(requests, stage === "plan" ? 1 : 2, "No hidden SDK/core repair/fallback calls");
  await assert.rejects(fs.stat(path.join(root, "workspace/summary.md")), { code: "ENOENT" });
  const dir = path.join(root, "sessions", sessionId);
  const raw = await fs.readFile(path.join(dir, "events.jsonl"), "utf8"); const events = raw.trim().split("\n").map(JSON.parse);
  assert.equal(events.some(e => e.type === "tool.started" || e.type === "session.finished"), false);
  assert.ok(events.some(e => e.type === "session.failed"));
  assert.equal(raw.includes("PRIVATE_PROVIDER_ERROR"), false); assert.ok(Buffer.byteLength(raw) < 128 * 1024);
  const state = await fs.readFile(path.join(dir, "state.json"), "utf8");
  assert.equal(state.includes("PRIVATE_PROVIDER_ERROR"), false); assert.ok(Buffer.byteLength(state) < 256 * 1024);
  await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
  mode = "normal"; normal = 0; const before = requests;
  const resumed = await run(true); assert.equal(resumed.ok, true); assert.equal(resumed.sessionId, sessionId);
  assert.ok(requests - before <= 5); assert.equal(normal, 4);
  assert.equal(await fs.readFile(path.join(root, "workspace/note.txt"), "utf8"), note);
  assert.equal(await fs.readFile(path.join(root, "workspace/summary.md"), "utf8"), summary);
  const final = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(final.some(e => e.type === "session.resumed")); assert.equal(final.at(-1).type, "session.finished");
  assert.equal(final.filter(e => e.type === "tool.started" && e.data.toolName === "write_file").length, 1);
  await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
});
