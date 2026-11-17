import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const run = promisify(execFile), sha = s => createHash("sha256").update(s).digest("hex");
const initial = "# Current note\n", prior = "# Old generated draft\n", correction = "# Owner correction: keep this current note.\n", updated = "# Reviewed\n";
const patch = "*** Begin Patch\n*** Update File: status.md\n@@\n-# Current note\n+# Reviewed\n*** Delete File: obsolete.md\n*** End Patch";
for (const mode of ["in-place", "atomic", "normal"]) test("native delete preimage and durable fresh-provider observation: " + mode, { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-delete-native-")), workspace = path.join(root, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "status.md"), initial); await fs.writeFile(path.join(workspace, "obsolete.md"), prior);
  await fs.writeFile(path.join(workspace, "owner.md"), "Unrelated input.\n");
  let phase = "start", step = 0, retainedSeen = false; const errors = [], requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ phase, model: body.model }); assert.ok(requests.length < 16);
      if (phase === "resume") {
        assert.equal(body.model, "deepseek-v4-pro");
        for (const m of body.messages) {
          if (m.role !== "user" || !m.content?.startsWith("Retained runtime tool evidence.") || !m.content.includes("Tool: apply_patch\n")) continue;
          const retained = JSON.parse(m.content.slice(m.content.indexOf("Verified result: ") + "Verified result: ".length));
          assert.equal(retained.ok, false); assert.equal(retained.partial, true);
          assert.deepEqual(retained.partialPatch.failedOperation, { type: "delete", path: "obsolete.md" });
          assert.deepEqual(retained.changes.map(c => c.path), ["status.md"]);
          assert.equal(retained.changes[0].afterHash, sha(updated)); retainedSeen = true;
        }
      }
      let message;
      if (!body.tools) message = { role: "assistant", content: "Read the current notes, perform only the requested work, verify and report the outcome." };
      else {
        const n = step++, call = (name, args, ordinal = 0) => ({ id: `delete_${phase}_${n}_${ordinal}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
        const calls = n === 0 ? [call("read_file", { path: "status.md" }), call("read_file", { path: "obsolete.md" }, 1)]
          : phase === "start" && n === 1 ? [call("apply_patch", { patch })]
            : phase === "start" && n === 2 ? [call("read_file", { path: "status.md" }), call("list_files", { path: "." }, 1)]
              : [call("finish", { result: phase === "resume" ? "status.md says Reviewed. obsolete.md contains the current owner correction; it remains present and unchanged. No files were changed in this observation."
                : "Updated status.md to Reviewed and removed obsolete.md. Other files are unchanged." })];
        for (const c of calls) assert.ok(body.tools.some(tool => tool.function.name === c.function.name));
        message = { role: "assistant", content: null, tool_calls: calls };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(String(error)); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async () => {
    const r = await run(process.execPath, [new URL("./fixtures/native-delete-preimage.js", import.meta.url).pathname, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      timeout: 15000, maxBuffer: 1024 * 1024, cwd: workspace,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"),
        ...(process.env.AGINTI_TEST_DELETE_RUNTIME ? { AGINTI_TEST_DELETE_RUNTIME: process.env.AGINTI_TEST_DELETE_RUNTIME } : {}),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0" },
    });
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  };
  const stateDir = path.join(root, "sessions", "native-delete-preimage-" + mode);
  const saved = async () => ({ state: JSON.parse(await fs.readFile(path.join(stateDir, "state.json"))),
    events: (await fs.readFile(path.join(stateDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse) });
  let result = await invoke();
  assert.equal(await fs.readFile(path.join(workspace, "status.md"), "utf8"), updated);
  if (mode === "normal") {
    assert.equal(result.result.goalStatus, "completed", JSON.stringify(result));
    await assert.rejects(fs.stat(path.join(workspace, "obsolete.md")), { code: "ENOENT" });
    const { events } = await saved(); assert.ok(events.some(e => e.type === "file.changed" && e.data.path === "obsolete.md" && e.data.deleted === true));
  } else {
    assert.equal(result.injected, true); assert.equal(result.error?.code, "OBSERVER_DELIVERY_FAILED", JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(workspace, "obsolete.md"), "utf8"), correction);
    const first = await saved(), failure = first.events.find(e => e.type === "tool.failed" && e.data.toolName === "apply_patch");
    assert.equal(failure.data.partial, true); assert.match(failure.data.error, /changed after planning/);
    assert.deepEqual(failure.data.changes.map(c => c.path), ["status.md"]); assert.equal(failure.data.changes[0].afterHash, sha(updated));
    assert.equal(first.state.meta.projectVerification.mutationRevision, 1); assert.deepEqual(first.state.meta.projectVerification.mutationHistory.at(-1).paths, ["status.md"]);
    assert.equal(first.events.filter(e => e.type === "file.changed").length, 1); assert.equal(first.events.some(e => e.type === "session.finished"), false);
    await assert.rejects(fs.stat(path.join(stateDir, ".agent-run.lock")), { code: "ENOENT" });
    phase = "resume"; step = 0; result = await invoke(); assert.equal(result.result.goalStatus, "completed", JSON.stringify(result));
    const second = await saved(); assert.deepEqual(second.events.slice(0, first.events.length), first.events);
    assert.equal(second.state.meta.runtimeConfig.revision, 2);
    // The read-only observation is a new request in this saved conversation,
    // not new mutation authority from the interrupted cleanup task.
    assert.equal(second.state.meta.goalContract.taskRelation, "new-request");
    assert.equal(second.state.meta.projectVerification.mutationRevision, 0);
    assert.equal(second.events.filter(e => e.type === "file.changed").length, 1); assert.equal(retainedSeen, true);
    assert.equal(await fs.readFile(path.join(workspace, "obsolete.md"), "utf8"), correction);
  }
  assert.equal(await fs.readFile(path.join(workspace, "owner.md"), "utf8"), "Unrelated input.\n"); assert.deepEqual(errors, []);
});
