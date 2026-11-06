import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { closeSessionIndexConnections } from "../src/session-index.js";
import { captureWorkspaceVerificationFingerprint as observe } from "../src/workspace-tools.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-verification-inputs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { commandCwd: root, allowFileTools: true };
  return { root, config };
}

test("metadata observation is stable, content-free and scoped to its root", async t => {
  const a = await fixture(t), b = await fixture(t);
  await fs.writeFile(path.join(a.root, "code.js"), "export const n = 2;\n");
  await fs.writeFile(path.join(b.root, "code.js"), "export const n = 2;\n");
  t.mock.method(fs, "readFile", () => { throw Error("Fingerprint must not read bytes"); });
  const first = await observe(a.config);
  assert.deepEqual(await observe(a.config), first);
  assert.deepEqual(Object.keys(first).sort(), ["digest", "entryCount", "rootDigest", "version"]);
  assert.notEqual((await observe(b.config)).rootDigest, first.rootDigest);
  assert.ok(!JSON.stringify(first).includes("code.js"));
});
for (const operation of ["edit", "add", "remove", "replace", "mtime-restored", "generated-input", "dependency-input"]) {
  test(`${operation} cannot retain the earlier public-workspace observation`, async t => {
    const { root, config } = await fixture(t), file = path.join(root, "code.js");
    await fs.writeFile(file, "old\n"); const before = await observe(config); const stat = await fs.stat(file);
    if (operation === "add") await fs.writeFile(path.join(root, "new-test.js"), "new\n");
    else if (operation === "generated-input") { await fs.mkdir(path.join(root, "dist")); await fs.writeFile(path.join(root, "dist/code.js"), "new\n"); }
    else if (operation === "dependency-input") { await fs.mkdir(path.join(root, "node_modules")); await fs.writeFile(path.join(root, "node_modules/code.js"), "new\n"); }
    else if (operation === "remove") await fs.unlink(file);
    else if (operation === "replace") { await fs.rename(file, file + ".old"); await fs.writeFile(file, "old\n"); }
    else { await fs.writeFile(file, "new\n"); if (operation === "mtime-restored") await fs.utimes(file, stat.atime, stat.mtime); }
    assert.notEqual((await observe(config)).digest, before.digest);
  });
}
test("sensitive paths and private/runtime caches are never read or included", async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(path.join(root, "code.js"), "ok\n");
  await fs.mkdir(path.join(root, ".cache")); await fs.mkdir(path.join(root, ".private"));
  const before = await observe(config);
  for (const name of [".env", ".cache/runtime.js", ".private/data.txt"]) await fs.writeFile(path.join(root, name), "synthetic-private\n");
  assert.equal((await observe(config)).digest, before.digest);
});
test("child symlinks and restricted scopes yield no reusable observation", async t => {
  const { root, config } = await fixture(t), other = await fixture(t);
  await fs.writeFile(path.join(other.root, "data.txt"), "outside\n");
  await fs.symlink(path.join(other.root, "data.txt"), path.join(root, "link.txt"));
  assert.equal(await observe(config), null);
  assert.equal(await observe({ ...config, workspacePathScopeRoots: ["allowed"] }), null);
});
test("only exact configured private storage is excluded, never its ordinary siblings or the whole workspace", async t => {
  const { root, config } = await fixture(t);
  config.sessionsDir = path.join(root, "state");
  await fs.mkdir(config.sessionsDir);
  const before = await observe(config);
  await fs.writeFile(path.join(config.sessionsDir, "state.json"), "runtime state\n");
  assert.deepEqual(await observe(config), before);
  await fs.mkdir(path.join(root, "state-other"));
  await fs.writeFile(path.join(root, "state-other/input.json"), "project input\n");
  assert.notEqual((await observe(config)).digest, before.digest);
  assert.equal(await observe({ ...config, sessionsDir: root }), null);
});
test("oversized or inaccessible inventories fail closed instead of sampling", async t => {
  const { root, config } = await fixture(t);
  for (let start = 0; start < 4100; start += 32) await Promise.all(Array.from({ length: Math.min(32, 4100 - start) },
    (_, i) => fs.writeFile(path.join(root, `input-${start + i}.txt`), "")));
  assert.equal(await observe(config), null);
  assert.equal(await observe({ ...config, commandCwd: path.join(root, "absent") }), null);
});

for (const [kind, scsActive] of [["unchanged", false], ["source", false], ["source", true], ["new-test", false], ["legacy", false], ["completed", false], ["in-flight", false]]) {
  test(`persisted ${kind} verification and resume (SCS ${scsActive})`, { timeout: 20000 }, async t => {
    const { root } = await fixture(t), work = path.join(root, "work");
    const oldHome = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(root, "home");
    t.after(() => { closeSessionIndexConnections(); if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome; });
    t.mock.method(globalThis, "fetch", async () => { throw Error("Offline test forbids network"); });
    await fs.mkdir(path.join(work, "src"), { recursive: true }); await fs.mkdir(path.join(work, "test"));
    await fs.writeFile(path.join(work, "package.json"), '{"private":true,"type":"module","scripts":{"test":"node --test"}}\n');
    await fs.writeFile(path.join(work, "test/compute.test.js"), 'import assert from "node:assert/strict";import {total} from "../src/compute.js";assert.equal(total,2);\n');
    await fs.writeFile(path.join(work, "src/compute.js"), "export const total = 1;\n");
    let phase = "initial", step = 0; const events = [];
    const turn = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: `${phase}_${++step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    const clientFactory = async () => ({ chat: { completions: { create: async request => {
      if (!request.tools) return { choices: [{ message: { role: "assistant", content: "Inspect source, fix and verify with the real test command." } }] };
      if (phase === "resume") {
        if (step === 0) return turn("finish", { result: "The calculation is fixed and npm test passes." });
        throw Object.assign(Error("Stop after the rejected stale finish"), { code: "STALE_FINISH_REJECTED" });
      }
      if (phase === "recover") {
        const calls = ["source", "completed", "in-flight"].includes(kind)
          ? [["run_command", { command: "npm test" }], ["read_file", { path: "src/compute.js" }], ["apply_patch", { path: "src/compute.js", search: "export const total = 99;", replace: "export const total = 2;" }], ["run_command", { command: "npm test" }]]
          : [["run_command", { command: "npm test" }]];
        return step < calls.length ? turn(...calls[step]) : turn("finish", { result: "npm test passes after fresh verification of the current source." });
      }
      const calls = [["inspect_project", {}], ["read_file", { path: "package.json" }], ["read_file", { path: "test/compute.test.js" }],
        ["read_file", { path: "src/compute.js" }], ["apply_patch", { path: "src/compute.js", search: "export const total = 1;", replace: "export const total = 2;" }], ["run_command", { command: "npm test" }]];
      if (step < calls.length) return turn(...calls[step]);
      if (kind === "in-flight" && step === calls.length) {
        await fs.writeFile(path.join(work, "src/compute.js"), "export const total = 99;\n");
        return turn("finish", { result: "The source repair is complete and npm test passes." });
      }
      if (kind === "completed") return turn("finish", { result: "The source repair is complete and npm test passes." });
      throw Object.assign(Error("Persist a real passing test before interruption"), { code: "PAUSE_AFTER_TEST" });
    } } } }); clientFactory.agintiDeterministicTest = true;
    const config = resolveRuntimeConfig({ provider: "openai", model: "offline-freshness", routingMode: "manual", taskProfile: "code", enableScs: scsActive ? "on" : "off",
      goal: "Inspect the project source, fix the wrong calculation and verify it. Keep package.json and test/compute.test.js unchanged. No installs or extra files." }, {
      baseDir: work, commandCwd: work, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "freshness", clientFactory,
      sandboxMode: "host", packageInstallPolicy: "block", allowFileTools: true, allowShellTool: true, allowWrapperTools: false,
      allowWebSearch: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false });
    Object.assign(config, { clientFactory, apiKey: "synthetic-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
      maxSteps: 12, dynamicSteps: "off", allowProviderHandoff: false, scsActive, scsValidationMode: "deterministic",
      executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline verification freshness regression" }, onConsole: () => {}, onLog: () => {},
      onEvent(type, data) { events.push({ type, data }); } });
    if (kind === "completed") assert.notEqual((await runAgent(config)).stopped, true);
    else await assert.rejects(runAgent(config), { code: "PAUSE_AFTER_TEST" });
    const statePath = path.join(root, "sessions/freshness/state.json");
    const before = JSON.parse(await fs.readFile(statePath));
    assert.equal(before.meta.projectVerification.testRuns.at(-1).passed, true);
    assert.equal(before.meta.projectVerification.testRuns.at(-1).workspaceFingerprint.version, 1);
    if (kind === "in-flight") {
      assert.equal(events.filter(e => e.type === "verification.workspace_invalidated").length, 1);
      assert.equal(events.filter(e => e.type === "completion.evidence_rejected").length, 1);
      assert.equal(before.meta.projectVerification.privateMutationRevision, 1);
      phase = "recover"; step = 0;
      assert.notEqual((await runAgent({ ...config, resume: "freshness", goal: "Continue the same task and verify the actual current source." })).stopped, true);
      return;
    }
    if (kind === "source" || kind === "completed") await fs.writeFile(path.join(work, "src/compute.js"), "export const total = 99;\n");
    if (kind === "new-test") await fs.writeFile(path.join(work, "test/new.test.js"), 'import assert from "node:assert/strict";assert.equal(1,1);\n');
    if (kind === "legacy") { delete before.meta.projectVerification.testRuns.at(-1).workspaceFingerprint; await fs.writeFile(statePath, JSON.stringify(before)); }
    phase = "resume"; step = 0; events.length = 0;
    const resume = { ...config, resume: "freshness", goal: "Continue the same task. Report the verified result." };
    if (kind === "unchanged") {
      assert.notEqual((await runAgent(resume)).stopped, true);
      assert.equal(events.filter(e => e.type === "verification.workspace_invalidated").length, 0);
      assert.deepEqual(events.filter(e => e.type === "tool.started").map(e => e.data.toolName), ["finish"]);
    } else {
      await assert.rejects(runAgent(resume), { code: "STALE_FINISH_REJECTED" });
      assert.equal(events.filter(e => e.type === "verification.workspace_invalidated").length, 1);
      assert.equal(events.filter(e => e.type === "completion.evidence_rejected").length, 1);
      const after = JSON.parse(await fs.readFile(statePath));
      assert.notEqual(after.meta.goalContract.status, "completed");
      assert.equal(after.meta.projectVerification.mutationRevision, 1, "runtime observation must not manufacture an agent edit");
      assert.equal(after.meta.projectVerification.privateMutationRevision, 1);
      phase = "recover"; step = 0; events.length = 0;
      const result = await runAgent({ ...resume, goal: "Continue the same task and verify the actual current source." });
      assert.notEqual(result.stopped, true, JSON.stringify({ result, events: events.filter(e => /contract|blocked|rejected/.test(e.type)) }));
      const recovered = JSON.parse(await fs.readFile(statePath));
      assert.equal(recovered.meta.goalContract.status, "completed");
      assert.equal(recovered.meta.projectVerification.testRuns.at(-1).passed, true);
      assert.equal(recovered.meta.projectVerification.testRuns.at(-1).privateMutationRevision, 1);
      assert.equal(await fs.readFile(path.join(work, "src/compute.js"), "utf8"), "export const total = 2;\n");
    }
  });
}
