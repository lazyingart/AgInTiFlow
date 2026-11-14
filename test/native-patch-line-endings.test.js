import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), fixture = new URL("./fixtures/native-patch-line-endings.js", import.meta.url).pathname;
const sha = text => crypto.createHash("sha256").update(text).digest("hex");

for (const bom of ["", "\uFEFF"]) test(`native saved CRLF edit and fresh-process explicit Pro continuation; BOM=${Boolean(bom)}`, { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-patch-eol-"));
  const workspace = path.join(root, "workspace");await fs.mkdir(workspace);
  const original = bom + "# Handoff\r\nStatus: drfat\r\nReview: pendign\r\nKeep: 日本語 🌱\r\n";
  await fs.writeFile(path.join(workspace, "handoff.md"), original);
  await fs.writeFile(path.join(workspace, "keep.txt"), "Other file unchanged.\r\n");
  let phase = "initial", turns = 0;const requests = [], failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));requests.push({ phase, model: body.model, toolTurn: Boolean(body.tools) });
      let message;
      if (!body.tools) message = { role: "assistant", content: "Read the handoff, make the requested narrow correction, verify and finish." };
      else {
        const count = ++turns;
        const initial = phase === "initial", old = initial ? ["Status: drfat", "Review: pendign"] : ["Status: draft", "Review: pending"];
        const next = initial ? ["Status: draft", "Review: pending"] : ["Status: ready", "Review: requested"];
        const name = count === 1 ? "read_file" : count === 2 ? "apply_patch" : "finish";
        const args = name === "read_file" ? { path: "handoff.md" } : name === "apply_patch"
          ? { path: "handoff.md", search: old.join("\n"), replace: next.join("\n"), expectedReplacements: 1 }
          : { result: "Updated the requested lines in handoff.md and verified the current file; other content is unchanged." };
        assert.ok(body.tools.some(tool => tool.function.name === name), `Missing ${name} at step ${count}: ${body.tools.map(tool => tool.function.name)}`);
        message = { role: "assistant", content: null, tool_calls: [{ id: phase + "_" + count, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { failures.push(error.message);res.writeHead(400, { "content-type": "application/json" });res.end('{"error":{"message":"Offline fixture rejected"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const nextPhase of ["initial", "resume"]) {
      phase = nextPhase;turns = 0;
      const { stdout } = await exec(process.execPath, [fixture, root, `http://127.0.0.1:${server.address().port}/v1`, phase], {
        timeout: 12000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8",
          AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1",
          ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) },
      }).catch(error => { throw new Error(`Native fixture failed: ${failures.join("; ")}`, { cause: error }); });
      const result = JSON.parse(stdout.trim().split("\n").at(-1));assert.notEqual(result.result.stopped, true);
      const expected = original.replace("drfat", phase === "initial" ? "draft" : "ready").replace("pendign", phase === "initial" ? "pending" : "requested");
      assert.equal(await fs.readFile(path.join(workspace, "handoff.md"), "utf8"), expected);
      const session = path.join(root, "sessions/native-patch-line-endings");
      const state = JSON.parse(await fs.readFile(path.join(session, "state.json"), "utf8"));
      assert.equal(state.meta.goalContract.status, "completed");assert.equal(state.meta.runtimeConfig.model, result.model);
      assert.equal(state.meta.runtimeConfig.revision, phase === "initial" ? 1 : 2);
      const events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      const writes = events.filter(e => e.type === "tool.completed" && e.data.toolName === "apply_patch");
      assert.equal(writes.length, phase === "initial" ? 1 : 2);
      assert.equal(writes.at(-1).data.change.afterHash, sha(expected));
      assert.equal(events.filter(e => e.type === "tool.failed").length, 0);
      await assert.rejects(fs.stat(path.join(session, ".agent-run.lock")), { code: "ENOENT" });
    }
    assert.deepEqual(failures, []);assert.equal(requests.filter(r => r.toolTurn).length, 6);
    assert.ok(requests.filter(r => r.phase === "resume").every(r => r.model === "deepseek-v4-pro"));
    assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "Other file unchanged.\r\n");
  } finally {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));await fs.rm(root, { recursive: true, force: true });
  }
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});
