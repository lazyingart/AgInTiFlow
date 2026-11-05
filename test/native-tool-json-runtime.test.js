import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), child = new URL("./fixtures/native-tool-json-runtime.js", import.meta.url);
const note = "Latency improved from 120 ms to 90 ms.\n", summary = "# Summary\n\nLatency improved from 120 ms to 90 ms.\n";
const wrap = message => ({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] });
const tool = (name, args, id) => ({ id: "native_json_" + id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
for (const scenario of ["repair", "mixed-batch", "repeat-restart", "status-resume"]) test(scenario === "status-resume"
  ? "same-session read-only deployment question completes without publication activity"
  : `native ambiguous JSON ${scenario} cannot write before valid repair`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-tool-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace, { mode: 0o700 }); await fs.writeFile(path.join(workspace, "note.txt"), note);
  let phase = scenario === "status-resume" ? "valid" : "invalid", requests = 0, normal = 0, malformed = 0, prefixWasBlocked = true;
  const retryInstructions = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", bytes => body += bytes);
    req.on("end", () => {
      requests++; const payload = JSON.parse(body); let response;
      if (malformed && payload.tools) {
        for (const message of payload.messages) {
          if (message.role === "user" && typeof message.content === "string" && message.content.includes("previous native tool arguments")) retryInstructions.push(message.content);
        }
      }
      if (!payload.tools) response = wrap({ content: "1. Read note.txt.\n2. Save summary.md.\n3. Verify it and finish." });
      else if (phase === "status") {
        normal++;
        response = wrap({ tool_calls: [normal === 1 ? tool("read_file", { path: "summary.md" }, "status")
          : tool("finish", { result: "延迟从 120 ms 变为 90 ms。未执行生产部署。还需用更大的输入测试。没有修改任何文件。" }, "status_finish")] });
      }
      else if (phase === "invalid" && (scenario === "repeat-restart" || malformed === 0)) {
        malformed++;
        prefixWasBlocked &&= !existsSync(path.join(workspace, "summary.md")) && !existsSync(path.join(workspace, "prefix.md"));
        const bad = tool("write_file", '{"path":"summary.md","content":"correct","content":"DO_NOT_WRITE_THIS","mode":"create"}', malformed);
        response = wrap({ tool_calls: scenario === "mixed-batch" ? [tool("write_file", { path: "prefix.md", content: "also forbidden", mode: "create" }, "prefix"), bad] : [bad] });
      } else {
        if (normal === 0) prefixWasBlocked &&= !existsSync(path.join(workspace, "summary.md")) && !existsSync(path.join(workspace, "prefix.md"));
        normal++;
        response = wrap({ tool_calls: [normal === 1 ? tool("read_file", { path: "note.txt" }, "read")
          : normal === 2 ? tool("write_file", { path: "summary.md", content: summary, mode: "create" }, "write")
          : normal === 3 ? tool("read_file", { path: "summary.md" }, "verify")
          : tool("finish", { result: "Created and verified summary.md. The input note.txt is unchanged." }, "finish")] });
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = once(server, "close"); server.close(); server.closeAllConnections(); await done; });
  const sessionId = "tool-json-" + scenario, dir = path.join(root, "sessions", sessionId);
  const run = async (resume, status = false) => {
    const { stdout } = await exec(process.execPath, [child.pathname, root, `http://127.0.0.1:${server.address().port}/v1`, sessionId, ...(resume ? ["resume", ...(status ? ["status"] : [])] : [])], {
      env: { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, timeout: 12000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  let result = await run(false);
  const firstEvents = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const repairs = firstEvents.filter(e => e.type === "model.text_tool_retry_requested");
  assert.equal(repairs.length, scenario === "status-resume" ? 0 : scenario === "repeat-restart" ? 3 : 1);
  assert.ok(repairs.every(e => e.data.reason === "ambiguous-native-tool-arguments"));
  if (malformed) assert.ok(retryInstructions.length > 0);
  for (const instruction of retryInstructions) {
    assert.match(instruction, /native function-call interface.*unique keys/);
    assert.doesNotMatch(instruction, /Use the configured textual/);
  }
  assert.equal(prefixWasBlocked, true);
  assert.equal(JSON.stringify(firstEvents).includes("DO_NOT_WRITE_THIS"), false);
  assert.equal((await fs.readFile(path.join(dir, "state.json"), "utf8")).includes("DO_NOT_WRITE_THIS"), false);
  if (scenario === "repeat-restart") {
    assert.equal(result.ok, false); assert.equal(malformed, 3); assert.equal(requests, 4);
    assert.equal(firstEvents.some(e => e.type === "tool.started" || e.type === "session.finished"), false);
    assert.equal(existsSync(path.join(workspace, "summary.md")), false);
    await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
    phase = "valid"; normal = 0; result = await run(true);
  }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(normal, 4);
  if (scenario === "status-resume") {
    const before = await fs.readFile(path.join(workspace, "summary.md"));
    phase = "status"; normal = 0; const count = requests; result = await run(true, true);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(normal, 2);
    assert.ok(requests - count <= 3, "status needs no additional model repair");
    assert.deepEqual(await fs.readFile(path.join(workspace, "summary.md")), before);
    const state = JSON.parse(await fs.readFile(path.join(dir, "state.json")));
    assert.equal(state.meta.runtimeConfig.revision, 1, "an unchanged runtime needs no synthetic provider revision");
    assert.equal(state.meta.goalContract.revision, 2);
    assert.match(result.result, /未执行生产部署/);
  }
  assert.equal(result.sessionId, sessionId);
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), note);
  assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), summary);
  assert.equal(existsSync(path.join(workspace, "prefix.md")), false);
  const final = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(final.filter(e => e.type === "tool.started" && e.data.toolName === "write_file").length, 1);
  assert.equal(final.at(-1).type, "session.finished");
  await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
});
