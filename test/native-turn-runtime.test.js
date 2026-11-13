import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), child = new URL("./fixtures/native-tool-json-runtime.js", import.meta.url);
const note = "Latency improved from 120 ms to 90 ms.\n", summary = "# Summary\n\nLatency improved from 120 ms to 90 ms.\n";
const marker = "INCOMPLETE_PROVIDER_PAYLOAD";
const wrap = message => ({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] });
const tool = (name, args, id) => wrap({ tool_calls: [{ id: "turn_boundary_" + id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
for (const scenario of ["plan", "tool", "finish", "text-tool", "refusal", "multiple", "reasoning", "empty",
  "error-plan", "error-tool", "error-finish", "error-text-tool", "error-null"]) test(`native ${scenario} admission preserves side-effect and restart boundaries`, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-turn-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace, { mode: 0o700 }); await fs.writeFile(path.join(workspace, "note.txt"), note);
  let phase = "bad", requests = 0, normal = 0, reasoningSent = false;
  const trace = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", bytes => body += bytes);
    req.on("end", () => {
      requests++; const payload = JSON.parse(body); let reply;
      if (!payload.tools) {
        reply = wrap({ content: phase === "bad" && ["plan", "error-plan"].includes(scenario) ? marker : "1. Read note.txt.\n2. Save summary.md.\n3. Verify it and finish." });
        if (phase === "bad" && scenario === "plan") reply.choices[0].finish_reason = "length";
      } else if (phase === "bad" && ["reasoning", "empty"].includes(scenario) && !reasoningSent) {
        reasoningSent = true; reply = wrap({ content: null, ...(scenario === "reasoning" ? { reasoning_content: "Need one next action." } : {}) }); reply.choices[0].finish_reason = "length";
      } else if (phase === "bad" && ["tool", "text-tool", "refusal", "multiple", "error-tool", "error-text-tool", "error-null"].includes(scenario)) {
        reply = tool("write_file", { path: "summary.md", content: marker, mode: "create" }, "bad");
        if (["text-tool", "error-text-tool"].includes(scenario)) reply = wrap({ content: `Requested tool: write_file(${JSON.stringify({ path: "summary.md", content: marker, mode: "create" })})` });
        if (scenario === "refusal") reply.choices[0].message.refusal = marker;
        else if (scenario === "multiple") reply.choices.push(structuredClone(reply.choices[0]));
        else if (!scenario.startsWith("error-")) reply.choices[0].finish_reason = "length";
      } else {
        normal++;
        if (phase === "good" && ["finish", "error-finish"].includes(scenario)) {
          const finishOnly = payload.tools.every(d => d.function.name === "finish");
          reply = normal === 1 && !finishOnly ? tool("read_file", { path: "summary.md" }, "resume_read")
            : tool("finish", { result: "Created and verified summary.md. The input note.txt is unchanged." }, "resume_finish");
        } else reply = normal === 1 ? tool("read_file", { path: "note.txt" }, "read")
          : normal === 2 ? (payload.tools.some(t => t.function.name === "write_file")
            ? tool("write_file", { path: "summary.md", content: summary, mode: "create" }, "write")
            : tool("apply_patch", { patch: "*** Begin Patch\n*** Add File: summary.md\n" + summary.trimEnd().split("\n").map(line => "+" + line).join("\n") + "\n*** End Patch" }, "write"))
          : normal === 3 ? tool("read_file", { path: "summary.md" }, "verify")
          : tool("finish", { result: phase === "bad" && ["finish", "error-finish"].includes(scenario) ? marker : "Created and verified summary.md. The input note.txt is unchanged." }, "finish");
        if (phase === "bad" && scenario === "finish" && normal === 4) reply.choices[0].finish_reason = "length";
      }
      if (phase === "bad" && scenario.startsWith("error-") &&
          (scenario === "error-plan" ? !payload.tools : scenario === "error-finish" ? normal === 4 : Boolean(payload.tools))) {
        reply.error = scenario === "error-null" ? null : { code: "quota_exceeded", message: marker };
      }
      if (payload.tools) trace.push({ offered: payload.tools.map(t => t.function.name), requested: reply.choices[0].message.tool_calls?.map(t => t.function.name) || [] });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = once(server, "close"); server.close(); server.closeAllConnections(); await done; });
  const sessionId = "native-turn-" + scenario, dir = path.join(root, "sessions", sessionId);
  const run = async resume => {
    const { stdout } = await exec(process.execPath, [child.pathname, root, `http://127.0.0.1:${server.address().port}/v1`, sessionId, ...(resume ? ["resume"] : [])], {
      env: { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" }, timeout: 12000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  let result = await run(false);
  const raw = await fs.readFile(path.join(dir, "events.jsonl"), "utf8"), first = raw.trim().split("\n").map(JSON.parse);
  assert.equal(raw.includes(marker), false); assert.equal((await fs.readFile(path.join(dir, "state.json"), "utf8")).includes(marker), false);
  if (["reasoning", "empty"].includes(scenario)) {
    assert.equal(result.ok, true, JSON.stringify({ result, trace, failures: first.filter(e => e.type === "tool.failed").map(e => e.data) }));
    if (scenario === "reasoning") assert.equal(first.filter(e => e.type === "model.reasoning_continuation_requested").length, 1);
  } else {
    assert.equal(result.ok, false); assert.match(result.code, /^MODEL_TURN_/); assert.equal(result.status, 422);
    assert.equal(requests, ["plan", "error-plan"].includes(scenario) ? 1 : ["finish", "error-finish"].includes(scenario) ? 5 : 2, "No hidden retry or fallback");
    assert.equal(first.some(e => e.type === "session.finished"), false);
    assert.ok(first.some(e => e.type === "session.failed"));
    if (["finish", "error-finish"].includes(scenario)) assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), summary);
    else { assert.equal(first.some(e => e.type === "tool.started"), false); await assert.rejects(fs.stat(path.join(workspace, "summary.md")), { code: "ENOENT" }); }
    await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
    phase = "good"; normal = 0; result = await run(true);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(result.sessionId, sessionId);
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), note);
  assert.equal(await fs.readFile(path.join(workspace, "summary.md"), "utf8"), summary);
  const final = (await fs.readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(final.at(-1).type, "session.finished");
  assert.equal(final.filter(e => e.type === "tool.started" && ["write_file", "apply_patch"].includes(e.data.toolName)).length, 1, "Retained successful producer must not repeat after failed completion");
  await assert.rejects(fs.stat(path.join(dir, ".agent-run.lock")), { code: "ENOENT" });
});
