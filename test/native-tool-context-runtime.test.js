import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), child = new URL("./fixtures/native-tool-context.js", import.meta.url).pathname;
const falseClaim = /Browser and canvas tools are available|Canvas\/artifacts tunnel(?:: | )available|frontend canvas\/artifacts tunnel exists|writing_specialist is available|Writing specialist: available/iu;
async function fixture(t, tier, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-tool-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "workspace"));
  const requests = [], errors = []; let phase;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      assert.ok(requests.length < 12); requests.push({ phase, body });
      if (body.tools) assert.ok(body.tools.some(tool => tool.function.name === "finish"));
      const message = body.tools ? { role: "assistant", content: null, tool_calls: [{ id: "context_" + phase + "_" + requests.length, type: "function", function: {
        name: "finish", arguments: JSON.stringify({ result: "Review clarity, check factual support, and proofread for mistakes." }),
      } }] } : { role: "assistant", content: "Answer the supplied draft-review request directly. No files or external tools are needed." };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: body.tools ? "tool_calls" : "stop", message }] }));
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const directory = path.join(root, "sessions/tool-context-" + mode + "-" + tier), file = path.join(directory, "state.json");
  const state = async () => JSON.parse(await fs.readFile(file));
  async function run(next) {
    phase = next;
    const r = await exec(process.execPath, [child, root, "http://127.0.0.1:" + server.address().port + "/v1", tier, mode, phase], {
      cwd: path.join(root, "workspace"), timeout: 20000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(root, "home"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_HOUSEKEEPING: "0",
        ...(process.env.AGINTI_TEST_CONTEXT_RUNTIME ? { AGINTI_TEST_CONTEXT_RUNTIME: process.env.AGINTI_TEST_CONTEXT_RUNTIME } : {}) },
    });
    assert.deepEqual(errors, []); const value = JSON.parse(r.stdout.trim().split("\n").at(-1)); assert.equal(value.error, undefined, JSON.stringify(value));
    assert.equal(value.result.goalStatus, "completed");
    await assert.rejects(fs.stat(path.join(directory, ".agent-run.lock")), { code: "ENOENT" });
    return value.result;
  }
  return { root, requests, state, file, directory, run };
}
const current = body => body.messages[0].content.slice(body.messages[0].content.lastIndexOf("Current native tool policy;"));
async function common(f) {
  const before = await f.state(); await f.run("resume"); const after = await f.state();
  assert.equal(after.sessionId, before.sessionId); assert.equal(after.meta.runtimeConfig.revision, 2); assert.equal(after.meta.runtimeConfig.model, "deepseek-v4-pro");
  assert.deepEqual(f.requests.map(r => r.body.model).filter((m, i, a) => !i || m !== a[i - 1]), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const events = (await fs.readFile(path.join(f.directory, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.some(e => e.type === "tool.completed" && e.data.toolName !== "finish"), false);
  assert.equal(after.meta.projectVerification?.mutationRevision || 0, 0);
  assert.deepEqual((await fs.readdir(path.join(f.root, "workspace"))).filter(n => n !== ".aginti"), []);
  return after;
}
for (const tier of ["focused", "thorough"]) test(`actual ${tier} prompt matches finish-only policy before and after fresh Pro resume`, { timeout: 45000 }, async t => {
  const f = await fixture(t, tier, "disabled"); await f.run("start"); await common(f);
  for (const { body } of f.requests) {
    const text = body.messages.map(m => m.content || "").join("\n"); assert.doesNotMatch(text, falseClaim);
    if (body.tools) { assert.deepEqual(body.tools.map(t => t.function.name), ["finish"]); assert.match(current(body), /Policy-eligible families \(not a readiness claim\): none\./); assert.match(current(body), /Offered functions for this turn: finish\.$/); }
    else assert.match(text, /Current native tool policy/);
  }
});
test("a disabled writing specialist is not enabled by the built-in writing profile", { timeout: 45000 }, async t => {
  const f = await fixture(t, "thorough", "writer"); await f.run("start"); await common(f);
  for (const { body } of f.requests.filter(r => r.body.tools)) {
    assert.deepEqual(body.tools.map(t => t.function.name), ["finish"]);
    assert.match(current(body), /Disabled families:.*writing specialist/);
    assert.match(body.messages[0].content, /Workflow advice applies only to enabled and currently offered tools/);
  }
});
test("enabled specialist and canvas policy remains available to a bounded normal run", { timeout: 45000 }, async t => {
  const f = await fixture(t, "thorough", "eligible"); await f.run("start"); await common(f);
  for (const { body } of f.requests.filter(r => r.body.tools)) {
    assert.match(current(body), /Policy-eligible families.*browser.*canvas.*writing specialist/);
    assert.match(body.messages.map(m => m.content || "").join("\n"), /Writing specialist: available/);
  }
});
test("old saved capability advice cannot replace the fresh request-local contract", { timeout: 45000 }, async t => {
  const f = await fixture(t, "thorough", "legacy"); await f.run("start"); const state = await f.state();
  state.messages[0].content += "\nHistorical runtime: Browser and canvas tools are available. Writing specialist: available.";
  const original = state.messages[0].content; await fs.writeFile(f.file, JSON.stringify(state)); await common(f);
  assert.equal((await f.state()).messages[0].content, original, "Do not rewrite durable history to fake current eligibility");
  for (const { body } of f.requests.filter(r => r.phase === "resume" && r.body.tools)) {
    assert.deepEqual(body.tools.map(t => t.function.name), ["finish"]);
    assert.match(current(body), /supersedes earlier capability claims/); assert.match(current(body), /Policy-eligible families \(not a readiness claim\): none\./);
  }
});
test("revision-checked narrowing is reflected even when an earlier prompt enabled tools", { timeout: 45000 }, async t => {
  const f = await fixture(t, "focused", "narrow"); await f.run("start"); const before = await f.state(); const after = await common(f);
  assert.equal(before.meta.runtimeConfig.allowCanvasTools, true); assert.equal(after.meta.runtimeConfig.allowCanvasTools, false);
  for (const { body } of f.requests.filter(r => r.phase === "resume" && r.body.tools)) {
    assert.deepEqual(body.tools.map(t => t.function.name), ["finish"]); assert.match(current(body), /Policy-eligible families \(not a readiness claim\): none\./);
  }
});
test("file preview remains independent while disabled image perception stays absent", { timeout: 45000 }, async t => {
  const f = await fixture(t, "thorough", "files"); await f.run("start"); await common(f);
  for (const { body } of f.requests) {
    const text = body.messages.map(m => m.content || "").join("\n"); assert.doesNotMatch(text, /read_image is available|read_image is enabled/);
    if (body.tools) {
      const names = body.tools.map(t => t.function.name); assert.equal(names.includes("read_image"), false); assert.equal(names.includes("open_url"), false);
      assert.match(current(body), /Policy-eligible families.*workspace preview/); assert.match(current(body), /Disabled families:.*browser.*image perception/);
    }
  }
});
for (const mode of ["jobs", "tmux"]) test(`independent ${mode} policy remains truthful across fresh resume`, { timeout: 45000 }, async t => {
  const f = await fixture(t, "thorough", mode); await f.run("start"); await common(f);
  for (const { body } of f.requests) {
    const text = body.messages.map(m => m.content || "").join("\n");
    assert.equal(text.includes("use start_long_job with"), mode === "jobs"); assert.equal(text.includes("Host tmux tools are enabled"), mode === "tmux");
    if (body.tools) assert.equal(body.tools.some(t => t.function.name === (mode === "jobs" ? "tmux_list_sessions" : "start_long_job")), false);
  }
});

for (const [mode, enabled] of [["image-deny", false], ["image-allow", true]]) test(`saved image policy requires exact CAS and ignores operational defaults: ${mode}`, { timeout: 45000 }, async t => {
  const f = await fixture(t, "focused", mode); await f.run("start");
  assert.equal((await f.state()).meta.runtimeConfig.allowImagePerception, false);
  const first = f.requests.filter(r => r.body.tools); assert.equal(first.length, 1);
  assert.equal(first[0].body.tools.some(t => t.function.name === "read_image"), false);
  const after = await common(f); assert.equal(after.meta.runtimeConfig.allowImagePerception, enabled);
  assert.equal(after.meta.runtimeConfig.allowImageTools, true); assert.equal(after.meta.runtimeConfig.allowVisionTools, true);
  const resumed = f.requests.filter(r => r.phase === "resume" && r.body.tools); assert.equal(resumed.length, 1);
  assert.equal(resumed[0].body.tools.some(t => t.function.name === "read_image"), enabled);
  const policy = current(resumed[0].body).split("\n");
  assert.equal(policy.find(l => l.startsWith("Policy-eligible families")).includes("image perception"), enabled);
  assert.equal(policy.find(l => l.startsWith("Disabled families")).includes("image perception"), !enabled);
});
