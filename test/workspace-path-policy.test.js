import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeWorkspaceScopeRoots as normalize, workspacePathScopePlan } from "../src/workspace-path-policy.js";
import { captureSessionRuntime, resolveSessionRuntime, applySessionRuntimePatch } from "../src/session-runtime.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { executeWorkspaceTool, resolveWorkspacePath } from "../src/workspace-tools.js";
import { nextStepRuntimeConfig } from "../src/agent-runner.js";

const cwd = path.resolve(os.tmpdir(), "owned-scope-workspace");
const initial = () => captureSessionRuntime({ provider: "mock", model: "mock", commandCwd: cwd,
  workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"] });

for (const [value, expected] of [
  [undefined, []], [[], []], [["."], ["."]], [["z", "./a"], ["a", "z"]],
  [[path.join(cwd, "public notes")], ["public notes"]], [["/workspace/allowed"], ["allowed"]],
]) test("workspace scope canonicalizes only explicit contained roots: " + JSON.stringify(value), () => {
  assert.deepEqual(normalize(value, cwd), expected);
});

for (const [name, value] of [
  ["null", null], ["scalar", "allowed"], ["empty member", [""]], ["whitespace", [" allowed"]],
  ["outside relative", ["../excluded"]], ["outside absolute", [path.resolve(cwd, "../excluded")]],
  ["duplicate", ["allowed", "allowed"]], ["alias duplicate", ["allowed", "./allowed"]],
  ["number", [1]], ["nul", ["bad\0name"]], ["newline", ["a\nb"]],
  ["unpaired Unicode", ["\ud800"]], ["URI", ["https://example.org"]],
  ["sparse", new Array(1)], ["too many", Array.from({ length: 33 }, (_, i) => String(i))],
  ["too long", ["a".repeat(4097)]],
]) test("invalid scope never becomes unrestricted: " + name, () => {
  assert.throws(() => normalize(value, cwd), { code: "WORKSPACE_SCOPE_POLICY_INVALID" });
});

for (const name of ["proxy", "accessor", "symbol", "hidden", "iterator", "custom prototype", "coercion"]) {
  test("scope data rejects " + name + " without executing hooks", () => {
    let traps = 0; const hook = () => { traps++; throw Error("untrusted hook"); }; let value = ["allowed"];
    if (name === "proxy") value = new Proxy(value, { get: hook, ownKeys: hook, getPrototypeOf: hook });
    if (name === "accessor") Object.defineProperty(value, "0", { get: hook, enumerable: true });
    if (name === "symbol") value[Symbol("extra")] = true;
    if (name === "hidden") Object.defineProperty(value, "hidden", { get: hook });
    if (name === "iterator") value[Symbol.iterator] = hook;
    if (name === "custom prototype") Object.setPrototypeOf(value, Object.create(Array.prototype, { then: { get: hook } }));
    if (name === "coercion") value[0] = { toString: hook };
    assert.throws(() => normalize(value, cwd), { code: "WORKSPACE_SCOPE_POLICY_INVALID" });
    assert.equal(traps, 0);
  });
}

test("captured scopes detach aliases and survive provider-only CAS and incoming defaults", () => {
  const roots = ["allowed"], config = { provider: "mock", model: "mock", commandCwd: cwd, workspacePathScopeRoots: roots };
  const saved = captureSessionRuntime(config); roots[0] = ".";
  assert.equal(saved.schemaVersion, 3); assert.deepEqual(saved.workspacePathScopeRoots, ["allowed"]);
  const resolved = resolveSessionRuntime({ savedRuntime: saved, incomingConfig: { workspacePathScopeRoots: [] },
    runtimePatch: { provider: "deepseek", model: "deepseek-v4-pro" }, expectedRevision: 1 });
  assert.deepEqual(resolved.snapshot.workspacePathScopeRoots, ["allowed"]);
  assert.deepEqual(resolved.runtimeOverrides.workspacePathScopeRoots, ["allowed"]); assert.equal(resolved.snapshot.revision, 2);
});
test("scope edits require exact revision and explicit canonical values", () => {
  const saved = initial(), bytes = JSON.stringify(saved);
  assert.throws(() => applySessionRuntimePatch(saved, { workspacePathScopeRoots: ["."] }, 2), { code: "SESSION_RUNTIME_CONFLICT" });
  for (const value of [null, undefined, ["../other"], ["./allowed"]]) {
    assert.throws(() => applySessionRuntimePatch(saved, { workspacePathScopeRoots: value }, 1), { code: "SESSION_RUNTIME_INVALID_FIELD" });
  }
  assert.deepEqual(applySessionRuntimePatch(saved, { workspacePathScopeRoots: [] }, 1).workspacePathScopeRoots, []);
  assert.equal(JSON.stringify(saved), bytes);
});
for (const kind of ["missing", "null", "outside", "unsorted", "alias"]) test("stored v3 scope is exact: " + kind, () => {
  const saved = initial();
  if (kind === "missing") delete saved.workspacePathScopeRoots;
  if (kind === "null") saved.workspacePathScopeRoots = null;
  if (kind === "outside") saved.workspacePathScopeRoots = ["../other"];
  if (kind === "unsorted") saved.workspacePathScopeRoots = ["z", "a"];
  if (kind === "alias") saved.workspacePathScopeRoots = ["./allowed"];
  assert.throws(() => resolveSessionRuntime({ savedRuntime: saved }), { code: "SESSION_RUNTIME_INVALID_FIELD" });
});
for (const version of [1, 2]) test("legacy v" + version + " cannot prove omitted or extra workspace policy", () => {
  const saved = initial(); saved.schemaVersion = version;
  const bytes = JSON.stringify(saved), incomingConfig = { workspacePathScopeRoots: ["allowed"] };
  assert.throws(() => resolveSessionRuntime({ savedRuntime: saved, incomingConfig }), { code: "SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED" });
  assert.throws(() => resolveSessionRuntime({ savedRuntime: saved, incomingConfig, runtimePatch: { model: "mock-next" }, expectedRevision: 1 }), { code: "SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED" });
  const migrated = resolveSessionRuntime({ savedRuntime: saved, incomingConfig,
    runtimePatch: { workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"] }, expectedRevision: 1 });
  assert.equal(migrated.snapshot.schemaVersion, 3); assert.equal(migrated.snapshot.revision, 2);
  assert.deepEqual(migrated.snapshot.workspacePathScopeRoots, ["allowed"]);
  assert.equal(JSON.stringify(saved), bytes);
  const ordinary = resolveSessionRuntime({ savedRuntime: saved });
  assert.deepEqual(ordinary.snapshot.workspacePathScopeRoots, []); assert.deepEqual(ordinary.snapshot.workspaceWritePathScopeRoots, []);
});
test("v2 family policy remains proven while workspace policy migrates", () => {
  const saved = initial(); saved.schemaVersion = 2; saved.allowBrowserTools = false;
  const result = resolveSessionRuntime({ savedRuntime: saved, incomingConfig: { allowBrowserTools: false } });
  assert.equal(result.snapshot.allowBrowserTools, false); assert.equal(result.snapshot.schemaVersion, 3);
});
test("trusted resolver exposes detached canonical scope lists", () => {
  const roots = ["./allowed"];
  const config = resolveRuntimeConfig({ provider: "mock", commandCwd: cwd }, { workspacePathScopeRoots: roots, workspaceWritePathScopeRoots: ["allowed/out"] });
  roots[0] = ".";
  assert.deepEqual(config.workspacePathScopeRoots, ["allowed"]);
  assert.deepEqual(config.workspaceWritePathScopeRoots, ["allowed/out"]);
  assert.throws(() => resolveRuntimeConfig({ provider: "mock", commandCwd: cwd }, { workspacePathScopeRoots: ["../other"] }), { code: "WORKSPACE_SCOPE_POLICY_INVALID" });
});
for (const [name, config, roots, restricted] of [
  ["unrestricted", {}, [], false],
  ["read-only group", { workspacePathScopeRoots: ["allowed"] }, [path.join(cwd, "allowed")], true],
  ["intersection", { workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"] }, [path.join(cwd, "allowed/out")], true],
  ["disjoint deny-all", { workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["other"] }, [], true],
  ["task narrowing", { workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"], scopedArtifactTask: true, scopedArtifactRoot: "allowed/out/task" }, [path.join(cwd, "allowed/out/task")], true],
]) test("write scopes combine by intersection: " + name, () => {
  assert.deepEqual(workspacePathScopePlan(config, cwd, { writeAccess: true }), { roots, restricted });
});
test("read scope cannot grant writes outside write scope and disjoint scopes deny before I/O", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-scope-write-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allowed/out"), { recursive: true });
  const config = { commandCwd: root, baseDir: root, allowFileTools: true, workspaceWritePolicy: "allow",
    workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"] };
  const blocked = await executeWorkspaceTool("write_file", { path: "allowed/blocked.md", content: "must not publish", mode: "create" }, config);
  assert.equal(blocked.ok, false); assert.equal(blocked.blocked, true); assert.match(blocked.reason, /outside.*scope/);
  await assert.rejects(fs.stat(path.join(root, "allowed/blocked.md")), { code: "ENOENT" });
  const valid = await executeWorkspaceTool("write_file", { path: "allowed/out/result.md", content: "verified", mode: "create" }, config);
  assert.equal(valid.ok, true); assert.equal(await fs.readFile(path.join(root, "allowed/out/result.md"), "utf8"), "verified");
  assert.throws(() => resolveWorkspacePath({ ...config, workspaceWritePathScopeRoots: ["other"] }, "allowed/x.md", { writeAccess: true }), /outside.*scope/);
});
test("task-derived output constraints narrow rather than replace host write policy", () => {
  const payload = { mode: "task", request: "Create other/result.md only.", artifact_root: path.join(cwd, "other") };
  const goal = "AGINTI_EVIDENCE_SCOPE_JSON: " + JSON.stringify(payload);
  const config = { goal, commandCwd: cwd, workspacePathScopeRoots: ["allowed"], workspaceWritePathScopeRoots: ["allowed/out"], taskProfile: "auto" };
  const runtime = nextStepRuntimeConfig(config, { goal, messages: [], meta: {} });
  assert.deepEqual(runtime.workspaceWritePathScopeRoots, ["allowed/out"]);
  assert.equal(runtime.scopedArtifactTask, true); assert.equal(runtime.scopedArtifactRoot, "other");
  assert.throws(() => resolveWorkspacePath(runtime, "other/result.md", { writeAccess: true }), /outside.*scope/);
});
