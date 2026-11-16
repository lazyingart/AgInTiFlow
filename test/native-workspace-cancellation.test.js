import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), child = new URL("./fixtures/native-workspace-cancellation.js", import.meta.url).pathname;
const original = name => `# ${name}\nState: drafft\nOwner: Example team\n`;
const fixed = name => original(name).replace("drafft", "draft"), sha = value => crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-workspace-cancel-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  for (const name of ["alpha", "beta"]) await fs.writeFile(path.join(workspace, name + ".md"), original(name));
  const requests = [], errors = []; let phase, step;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ phase, model: body.model }); assert.ok(requests.length <= 16);
      let message = { role: "assistant", content: "Read both notes, fix only their spelling and finish truthfully." };
      if (body.tools) {
        step++; let name, args;
        if (step <= 2) { name = "read_file"; args = { path: step === 1 ? "alpha.md" : "beta.md" }; }
        else {
          const remaining = [];
          for (const n of ["alpha", "beta"]) if ((await fs.readFile(path.join(workspace, n + ".md"), "utf8")).includes("drafft")) remaining.push(n);
          if (step === 3 && remaining.length) {
            name = "apply_patch";
            args = { patch: "*** Begin Patch\n" + remaining.map(n => `*** Update File: ${n}.md\n@@\n-State: drafft\n+State: draft\n`).join("") + "*** End Patch" };
            const parameters = body.tools.find(t => t.function.name === name)?.function.parameters;
            assert.ok(parameters?.properties.patch, "Fixture needs an explicitly offered patch document");
            for (const [k, v] of Object.entries({ path: remaining[0] + ".md", search: "State: drafft", replace: "State: draft" })) {
              if (parameters.required?.includes(k)) args[k] = v;
            }
          } else { name = "finish"; args = { result: "Corrected the spelling in alpha.md and beta.md; the owner lines are unchanged." }; }
        }
        assert.ok(body.tools.some(t => t.function.name === name), `${phase} step ${step}: ${name} not offered`);
        message = { role: "assistant", content: null, tool_calls: [{ id: `cancel_${phase}_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = path.join(root, "sessions/workspace-cancellation-" + mode);
  const state = async () => JSON.parse(await fs.readFile(path.join(directory, "state.json")));
  const events = async () => (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const content = name => fs.readFile(path.join(workspace, name + ".md"), "utf8");
  async function run(next) {
    phase = next; step = 0;
    const result = await exec(process.execPath, [child, root, `http://127.0.0.1:${server.address().port}/v1`, mode, phase], {
      timeout: 15000, maxBuffer: 1024 * 1024, cwd: workspace,
      env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_CANCEL_RUNTIME ? { AGINTI_TEST_CANCEL_RUNTIME: process.env.AGINTI_TEST_CANCEL_RUNTIME } : {}) },
    });
    assert.deepEqual(errors, []); return JSON.parse(result.stdout.trim().split("\n").at(-1));
  }
  return { root, workspace, directory, requests, state, events, content, run };
}

for (const mode of ["before-first", "after-first", "after-last", "normal"]) {
  test("actual persisted workspace cancellation boundary: " + mode, { timeout: 20000 }, async t => {
    const f = await fixture(t, mode), result = await f.run("start"); assert.equal(result.error, undefined);
    const cancelled = mode !== "normal"; assert.equal(result.aborted, cancelled);
    assert.equal(result.externalModelCalls, 0); assert.equal(result.result.stopped === true, cancelled);
    assert.equal(result.result.reason, cancelled ? "user_interrupt" : undefined);
    const changed = mode === "before-first" ? [] : mode === "after-first" ? ["alpha"] : ["alpha", "beta"];
    for (const name of ["alpha", "beta"]) assert.equal(await f.content(name), changed.includes(name) ? fixed(name) : original(name));
    assert.deepEqual(result.order, mode === "before-first" ? ["abort"] : mode === "after-first" ? ["commit:alpha.md", "abort"]
      : mode === "after-last" ? ["commit:alpha.md", "commit:beta.md", "abort"] : ["commit:alpha.md", "commit:beta.md"]);
    const saved = await f.state(), events = await f.events();
    assert.equal(saved.meta.goalContract.status, cancelled ? "paused" : "completed");
    assert.deepEqual(saved.meta.projectVerification?.mutationHistory?.flatMap(m => m.paths) || [], changed.map(n => n + ".md"));
    const mutations = events.filter(e => ["tool.completed", "tool.failed"].includes(e.type) && e.data.toolName === "apply_patch");
    if (mode === "after-first") {
      assert.equal(mutations.length, 1); const receipt = mutations[0].data;
      assert.equal(receipt.ok, false); assert.equal(receipt.partial, true); assert.equal(receipt.changes.length, 1);
      assert.equal(receipt.change.beforeHash, sha(original("alpha"))); assert.equal(receipt.change.afterHash, sha(fixed("alpha")));
      const savedResult = saved.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)).find(m => m.partial);
      assert.equal(savedResult.changes[0].afterHash, receipt.change.afterHash); assert.equal(savedResult.partialPatch.completedOperations, 1);
    } else if (changed.length) { assert.equal(mutations.length, 1); assert.equal(mutations[0].data.ok, true); assert.equal(mutations[0].data.changes.length, 2); }
    else assert.equal(mutations.length, 0);
    await assert.rejects(fs.stat(path.join(f.directory, ".agent-run.lock")), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(f.workspace)).filter(n => n !== ".aginti"), ["alpha.md", "beta.md"]);
    assert.equal(f.requests.length, cancelled ? 3 : 4);
  });
}

for (const mode of ["before-first", "after-first", "after-last"]) {
  test("fresh process resumes cancelled workspace task without repeating accepted writes: " + mode, { timeout: 30000 }, async t => {
    const f = await fixture(t, mode); const initial = await f.run("start"); assert.equal(initial.result.reason, "user_interrupt");
    const before = await f.state(), alphaBefore = await f.content("alpha");
    const resumed = await f.run("resume"); assert.equal(resumed.error, undefined, JSON.stringify(resumed));
    assert.notEqual(resumed.result.stopped, true, JSON.stringify(resumed));
    assert.equal((await f.state()).meta.goalContract.status, "completed"); assert.equal(resumed.aborted, false);
    assert.deepEqual(resumed.order, mode === "before-first" ? ["commit:alpha.md", "commit:beta.md"] : mode === "after-first" ? ["commit:beta.md"] : []);
    if (mode !== "before-first") assert.equal(await f.content("alpha"), alphaBefore);
    assert.equal(await f.content("alpha"), fixed("alpha")); assert.equal(await f.content("beta"), fixed("beta"));
    const saved = await f.state(); assert.equal(saved.sessionId, before.sessionId);
    assert.equal(saved.meta.runtimeConfig.revision, 2); assert.equal(saved.meta.runtimeConfig.model, "deepseek-v4-pro");
    const changes = (await f.events()).filter(e => ["tool.completed", "tool.failed"].includes(e.type) && e.data.toolName === "apply_patch").flatMap(e => e.data.changes || []);
    assert.deepEqual(changes.map(c => c.path), ["alpha.md", "beta.md"]);
    assert.deepEqual(f.requests.map(r => r.model).filter((model, i, a) => !i || model !== a[i - 1]), ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.equal((await f.events()).filter(e => e.type === "session.finished").length, 1);
    await assert.rejects(fs.stat(path.join(f.directory, ".agent-run.lock")), { code: "ENOENT" });
  });
}
