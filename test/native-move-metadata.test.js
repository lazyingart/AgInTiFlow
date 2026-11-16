import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), child = new URL("./fixtures/native-move-metadata.js", import.meta.url).pathname;
const content = name => "# " + name + "\nKeep every line.\n", sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
for (const mode of ["normal", "restart", "partial"]) test("real native private-file move completion: " + mode, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-move-metadata-")), workspace = path.join(root, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(workspace);
  for (const [name, permissions] of [["alpha.md", 0o600], ["beta.md", 0o640]]) {
    await fs.writeFile(path.join(workspace, name), content(name)); await fs.chmod(path.join(workspace, name), permissions);
  }
  await fs.writeFile(path.join(workspace, "unrelated.txt"), "Leave this unrelated file unchanged.\n");
  const requests = [], errors = [], reads = new Set(); let phase = "start";
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      assert.ok(requests.length < 16); requests.push({ phase, model: body.model, offered: (body.tools || []).map(tool => tool.function.name) });
      let message = { role: "assistant", content: "Read the notes and move them unchanged; preserve their existing permissions." };
      if (body.tools) {
        const remaining = [];
        for (const name of ["alpha.md", "beta.md"]) if (await fs.stat(path.join(workspace, name)).then(() => true, () => false)) remaining.push(name);
        const unread = remaining.find(name => !reads.has(name)); let name, args;
        if (unread) { name = "read_file"; args = { path: unread }; reads.add(unread); }
        else if (remaining.length) {
          name = "apply_patch"; const schema = body.tools.find(tool => tool.function.name === name)?.function.parameters;
          assert.ok(schema?.properties.patch, "Only execute explicitly offered patch documents");
          args = { patch: "*** Begin Patch\n" + remaining.map(file => `*** Update File: ${file}\n*** Move to: archive/${file}\n`).join("") + "*** End Patch" };
          for (const [key, value] of Object.entries({ path: remaining[0], search: "# " + remaining[0], replace: "# " + remaining[0] })) if (schema.required?.includes(key)) args[key] = value;
        } else { name = "finish"; args = { result: "Moved alpha.md and beta.md into archive/ with their contents and permissions preserved. Other files are unchanged." }; }
        assert.ok(body.tools.some(tool => tool.function.name === name));
        message = { role: "assistant", content: null, tool_calls: [{ id: "move_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error.stack)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = path.join(root, "sessions/move-metadata-" + mode);
  async function run(next) {
    phase = next; reads.clear();
    const r = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", mode, next], { cwd: workspace, timeout: 20000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), AGINTIFLOW_HOME: path.join(root, "home"), LANG: "C.UTF-8", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_MOVE_RUNTIME ? { AGINTI_TEST_MOVE_RUNTIME: process.env.AGINTI_TEST_MOVE_RUNTIME } : {}) } });
    assert.deepEqual(errors, []); const value = JSON.parse(r.stdout.trim().split("\n").at(-1)); assert.equal(value.error, undefined, JSON.stringify(value)); return value;
  }
  let result = await run("start");
  if (mode !== "normal") {
    assert.equal(result.result.reason, "user_interrupt");
    const saved = JSON.parse(await fs.readFile(path.join(directory, "state.json"))); assert.equal(saved.meta.goalContract.status, "paused");
    result = await run("resume");
  }
  assert.equal(result.result.goalStatus, "completed", JSON.stringify(result));
  const state = JSON.parse(await fs.readFile(path.join(directory, "state.json")));
  assert.equal(state.meta.runtimeConfig.revision, mode === "normal" ? 1 : 2);
  assert.equal(state.meta.runtimeConfig.model, mode === "normal" ? "deepseek-v4-flash" : "deepseek-v4-pro");
  for (const [name, permissions] of [["alpha.md", 0o600], ["beta.md", 0o640]]) {
    const file = path.join(workspace, "archive", name), stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, permissions); assert.equal(await fs.readFile(file, "utf8"), content(name));
    await assert.rejects(fs.stat(path.join(workspace, name)), { code: "ENOENT" });
  }
  assert.equal(await fs.readFile(path.join(workspace, "unrelated.txt"), "utf8"), "Leave this unrelated file unchanged.\n");
  const events = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const changes = events.filter(event => ["tool.completed", "tool.failed"].includes(event.type) && event.data.toolName === "apply_patch").flatMap(event => event.data.changes || []);
  assert.deepEqual(changes.map(change => change.path), ["archive/alpha.md", "archive/beta.md"]);
  for (const change of changes) { assert.equal(change.action, "apply_patch_move"); assert.equal(change.afterHash, sha(content(path.basename(change.path)))); }
  assert.equal(events.filter(event => event.type === "session.finished").length, 1);
  await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" });
  assert.equal(result.externalModelCalls, 0);
});
