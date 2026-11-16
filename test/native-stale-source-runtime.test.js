import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile), child = new URL("./fixtures/native-stale-source.js", import.meta.url).pathname;
const initial = "# Relase checklist\n\nKeep every review note.\n", sha = text => crypto.createHash("sha256").update(text).digest("hex");
for (const mode of ["unchanged", "external", "paused", "paused-legacy", "twice"]) test(`actual native stale-source recovery: ${mode}`, { timeout: 50000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-stale-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(root + "/workspace"); await fs.writeFile(root + "/workspace/draft.md", initial);
  const requests = [], errors = []; let reads = 0, phase = "start";
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      assert.ok(requests.length < 18); requests.push({ phase, body });
      let message;
      if (!body.tools) message = { role: "assistant", content: "Correct the requested heading and preserve all review notes." };
      else {
        const names = body.tools.map(t => t.function.name); let name, args;
        if (names.includes("finish") && (await fs.readFile(root + "/workspace/draft.md", "utf8")).startsWith("# Release checklist")) {
          name = "finish"; args = { result: "Updated the heading in draft.md and kept all notes." };
        } else if (names.includes("read_file") && !names.includes("apply_patch")) { reads++; name = "read_file"; args = { path: "draft.md" }; }
        else if (names.includes("apply_patch")) {
          name = "apply_patch"; const descriptor = body.tools.find(t => t.function.name === name).function;
          const properties = descriptor.parameters.properties;
          const search = descriptor.description.match(/<current_source_anchor>\n([\s\S]*?)\n<\/current_source_anchor>/)?.[1] || "# Relase checklist";
          args = { path: "draft.md", search, replace: search.replace("Relase", "Release"), expectedReplacements: 1 };
          // A provider repeats its recorded snapshot until the runtime offers a
          // real reread. Never repair this fixture by silently dropping its hash.
          if (reads < 2 && properties.baseHash) args.baseHash = sha(initial);
        } else { name = "finish"; args = { result: "Updated the heading in draft.md and kept all notes." }; }
        assert.ok(names.includes(name)); message = { role: "assistant", content: null, reasoning_content: "Use the exact observed file and current tool contract.",
          tool_calls: [{ id: "stale_" + requests.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error.stack)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root + "/config", LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home",
    AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
    ...(process.env.AGINTI_TEST_STALE_RUNTIME ? { AGINTI_TEST_STALE_RUNTIME: process.env.AGINTI_TEST_STALE_RUNTIME } : {}) };
  async function run(next) {
    phase = next; const r = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", mode, phase], { cwd: root + "/workspace", env, timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(errors, []); const value = JSON.parse(r.stdout.trim().split("\n").at(-1)); assert.equal(value.error, undefined, JSON.stringify(value)); return value;
  }
  let value = await run("start");
  if (mode.startsWith("paused")) {
    assert.equal(value.result.goalStatus, "paused");
    if (mode === "paused-legacy") {
      const file = root + "/sessions/stale-source/state.json", saved = JSON.parse(await fs.readFile(file));
      // Reproduce the older native initial-entry shape without inventing a
      // hash or changing the task, evidence, runtime policy or file bytes.
      delete saved.meta.goalContract.history[0].taskHash;
      delete saved.meta.goalContract.history[0].activeHash;
      await fs.writeFile(file, JSON.stringify(saved));
    }
    value = await run("resume");
  }
  assert.equal(value.result.goalStatus, "completed", JSON.stringify(value));
  const expected = initial.replace("Relase", "Release") + (mode === "unchanged" ? "" : "\nOwner note 1 must remain.\n") + (mode === "twice" ? "\nOwner note 2 must remain.\n" : "");
  assert.equal(await fs.readFile(root + "/workspace/draft.md", "utf8"), expected);
  const directory = root + "/sessions/stale-source", state = JSON.parse(await fs.readFile(directory + "/state.json"));
  const events = (await fs.readFile(directory + "/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse);
  const failures = events.filter(e => e.type === "tool.failed" && e.data.code === "WORKSPACE_WRITE_CONFLICT");
  assert.equal(failures.length, mode === "unchanged" ? 0 : 1);
  assert.equal(events.filter(e => e.type === "patch_context.refresh_required").length, failures.length);
  assert.equal(events.filter(e => e.type === "tool.completed" && e.data.toolName === "apply_patch").length, 1);
  for (const { body } of requests.filter(r => r.body.tools?.some(t => t.function.name === "read_file") && r.body.tools.length === 1)) {
    assert.deepEqual(body.tools[0].function.parameters.properties.path.enum, ["draft.md"]);
  }
  assert.equal(state.meta.runtimeConfig.revision, mode.startsWith("paused") ? 2 : 1);
  if (mode.startsWith("paused")) { assert.equal(state.meta.runtimeConfig.model, "deepseek-v4-pro"); assert.equal(state.meta.runtimeConfig.maxSteps, 9); }
  assert.deepEqual((await fs.readdir(root + "/workspace")).filter(n => n !== ".aginti"), ["draft.md"]);
  await assert.rejects(fs.stat(directory + "/.agent-run.lock"), { code: "ENOENT" });
});
