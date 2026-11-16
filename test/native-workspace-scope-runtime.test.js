import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), child = new URL("./fixtures/native-workspace-scope.js", import.meta.url).pathname;
const allowed = "The public review is on Thursday.\n", excluded = "EXCLUDED_SYNTHETIC_VIOLET_ROW\n";
async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "workspace/allowed/out"), { recursive: true });
  await fs.mkdir(path.join(root, "workspace/excluded"));
  await fs.writeFile(path.join(root, "workspace/allowed/note.md"), allowed);
  await fs.writeFile(path.join(root, "workspace/excluded/note.md"), excluded);
  const requests = [], errors = []; let phase = "start", turn = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); assert.ok(requests.length < 24);
      requests.push({ phase, model: body.model, excludedInMessages: JSON.stringify(body.messages).includes(excluded.trim()) });
      let message = { role: "assistant", content: "Read the authorized input, make only authorized changes and finish truthfully." };
      if (body.tools) {
        const n = ++turn, call = (name, args) => ({ id: "scope_" + phase + "_" + n, type: "function", function: { name, arguments: JSON.stringify(args) } });
        const writing = mode.startsWith("write");
        const bad = (phase === "resume" || phase === "widen" || mode === "unrestricted" || mode === "write-first-denial") && n === 1;
        const tool = writing ? n === 1 ? call("write_file", { path: bad ? "allowed/outside-review-checklist.md" : "allowed/out/review-checklist.md", content: "# Verified note\n", mode: "create" }) : call("finish", { result: "Created the Markdown note." })
          : n === 1 ? call("read_file", { path: bad ? "excluded/note.md" : "allowed/note.md" })
            : (phase === "resume" || phase === "widen" || mode === "unrestricted") && n === 2 ? call("read_file", { path: "allowed/note.md" })
              : call("finish", { result: "The public review is on Thursday." });
        message = { role: "assistant", content: null, tool_calls: [tool] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = path.join(root, "sessions/native-scope-" + mode);
  const state = async () => JSON.parse(await fs.readFile(path.join(directory, "state.json")));
  const events = async () => (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  async function run(next) {
    phase = next; turn = 0;
    const value = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", mode, phase], {
      cwd: path.join(root, "workspace"), timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_SCOPE_RUNTIME ? { AGINTI_TEST_SCOPE_RUNTIME: process.env.AGINTI_TEST_SCOPE_RUNTIME } : {}) },
    });
    assert.deepEqual(errors, []); return JSON.parse(value.stdout.trim().split("\n").at(-1));
  }
  return { root, directory, requests, state, events, run };
}
test("fresh-process provider resume retains read scope and a permitted recovery remains possible", { timeout: 30000 }, async t => {
  const f = await fixture(t, "read");
  assert.equal((await f.run("start")).result.goalStatus, "completed");
  const resumed = await f.run("resume");
  assert.equal(resumed.result.reason, "permission_required");
  assert.equal((await f.state()).meta.runtimeConfig.revision, 2);
  assert.equal(f.requests.some(row => row.excludedInMessages), false);
  const recovered = await f.run("recover");
  assert.equal(recovered.result.goalStatus, "completed");
  assert.deepEqual((await f.state()).meta.runtimeConfig.workspacePathScopeRoots, ["allowed"]);
  assert.equal((await f.state()).meta.runtimeConfig.revision, 2);
  assert.equal((await f.events()).some(e => e.type === "tool.completed" && e.data?.content === excluded), false);
  assert.equal(await fs.readFile(path.join(f.root, "workspace/excluded/note.md"), "utf8"), excluded);
  assert.deepEqual(f.requests.map(row => row.model).filter((model, index, list) => !index || model !== list[index - 1]), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});
test("fresh-process provider resume cannot widen the explicit write scope", { timeout: 30000 }, async t => {
  const f = await fixture(t, "write");
  const started = await f.run("start");
  assert.equal(started.resolved, true, JSON.stringify(started));
  assert.notEqual(started.result?.stopped, true, JSON.stringify({ started, events: await f.events() }));
  assert.equal(await fs.readFile(path.join(f.root, "workspace/allowed/out/review-checklist.md"), "utf8"), "# Verified note\n");
  const resumed = await f.run("resume"); assert.equal(resumed.result.reason, "permission_required");
  assert.deepEqual((await f.state()).meta.runtimeConfig.workspaceWritePathScopeRoots, ["allowed/out"]);
  await assert.rejects(fs.stat(path.join(f.root, "workspace/allowed/outside-review-checklist.md")), { code: "ENOENT" });
});
test("a fresh read scope does not override the narrower write scope", { timeout: 20000 }, async t => {
  const f = await fixture(t, "write-first-denial");
  assert.equal((await f.run("start")).result.reason, "permission_required");
  await assert.rejects(fs.stat(path.join(f.root, "workspace/allowed/outside-review-checklist.md")), { code: "ENOENT" });
  assert.equal((await f.events()).some(e => e.type === "file.changed"), false);
});
test("legacy missing scope requires explicit CAS before any model request", { timeout: 30000 }, async t => {
  const f = await fixture(t, "legacy"); await f.run("start");
  const saved = await f.state(); saved.meta.runtimeConfig.schemaVersion = 2;
  delete saved.meta.runtimeConfig.workspacePathScopeRoots; delete saved.meta.runtimeConfig.workspaceWritePathScopeRoots;
  const file = path.join(f.directory, "state.json"); await fs.writeFile(file, JSON.stringify(saved, null, 2));
  const before = await fs.readFile(file), count = f.requests.length;
  const denied = await f.run("resume");
  assert.equal(denied.code, "SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED"); assert.equal(f.requests.length, count);
  assert.deepEqual(await fs.readFile(file), before);
  const migrated = await f.run("migrate"); assert.equal(migrated.result.goalStatus, "completed");
  const after = await f.state(); assert.equal(after.meta.runtimeConfig.schemaVersion, 3); assert.equal(after.meta.runtimeConfig.revision, 2);
  assert.deepEqual(after.meta.runtimeConfig.workspacePathScopeRoots, ["allowed"]);
});
test("a trusted current-revision CAS can explicitly widen workspace scope", { timeout: 30000 }, async t => {
  const f = await fixture(t, "widen"); await f.run("start"); const widened = await f.run("widen");
  assert.equal(widened.result.goalStatus, "completed");
  assert.deepEqual((await f.state()).meta.runtimeConfig.workspacePathScopeRoots, []);
  assert.equal((await f.state()).meta.runtimeConfig.revision, 2);
  assert.ok((await f.events()).some(e => e.type === "tool.completed" && e.data?.content === excluded));
});
test("ordinary unscoped native runs keep their existing workspace access", { timeout: 20000 }, async t => {
  const f = await fixture(t, "unrestricted"); const result = await f.run("start");
  assert.equal(result.result.goalStatus, "completed");
  assert.deepEqual((await f.state()).meta.runtimeConfig.workspacePathScopeRoots ?? [], []);
  assert.ok((await f.events()).some(e => e.type === "tool.completed" && e.data?.content === excluded));
});
