import assert from "node:assert/strict";
import test from "node:test";
import { checkWorkspaceToolUse, executeWorkspaceTool } from "../src/workspace-tools.js";
import { buildPermissionAdvice, scopedDiscoveryCorrection } from "../src/permission-advice.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const scoped = { commandCwd: "/owned-scoped-workspace", allowFileTools: true, workspacePathScopeRoots: ["out"], workspaceWritePathScopeRoots: ["out"], sandboxMode: "host", allowDestructive: true };
for (const allowShellTool of [false, true]) test(`configured-scope denial never suggests a read-root/shell permission bypass: shell=${allowShellTool}`, () => {
  const config = { ...scoped, allowShellTool }, guard = checkWorkspaceToolUse("list_files", { path: "." }, config);
  assert.equal(guard.allowed, false); assert.equal(guard.code, "WORKSPACE_PATH_SCOPE_DENIED"); assert.equal(guard.scopeAccess, "read");
  const advice = buildPermissionAdvice({ toolName: "list_files", args: { path: "." }, guard, config });
  assert.equal(advice.category, "workspace-scope"); assert.equal(advice.autoRecover, false);
  assert.match(advice.instruction, /cannot expand/); assert.match(advice.instruction, /Do not use another tool to bypass/);
  assert.equal(advice.suggestedCommand, undefined); assert.equal(advice.trustedHostCommand, undefined);
  assert.doesNotMatch(advice.summary, /outside the workspace/);
});

test("typed read/write scope denials retain the same access decisions", async () => {
  for (const [toolName, args, access] of [["list_files", { path: "." }, "read"], ["read_file", { path: "owner.txt" }, "read"], ["write_file", { path: "other.md", content: "bad" }, "write"]]) {
    const guard = checkWorkspaceToolUse(toolName, args, scoped);
    assert.equal(guard.allowed, false); assert.equal(guard.code, "WORKSPACE_PATH_SCOPE_DENIED"); assert.equal(guard.scopeAccess, access);
    const result = await executeWorkspaceTool(toolName, args, scoped);
    assert.equal(result.blocked, true); assert.equal(result.code, guard.code); assert.equal(result.scopeAccess, access);
  }
  assert.equal(checkWorkspaceToolUse("list_files", { path: "out" }, scoped).allowed, true);
  assert.equal(checkWorkspaceToolUse("write_file", { path: "out/review.md", content: "ok" }, scoped).allowed, true);
});

test("other path failures are not mislabeled as configured-scope denials", () => {
  for (const [config, path] of [[scoped, "out/.env"], [{ ...scoped, workspacePathScopeRoots: [], workspaceWritePathScopeRoots: [] }, "/outside-scope-owner/file.md"]]) {
    const guard = checkWorkspaceToolUse("read_file", { path }, config);
    assert.equal(guard.allowed, false); assert.equal(guard.code, undefined);
  }
});

const originalGoal = "Please create out/café.md with a short release-review checklist covering build, tests, and rollback. Only create that file.";
function request(goal = originalGoal, config = scoped, toolName = "list_files", args = { path: "." }) {
  return { goal, config, toolName, args, guard: checkWorkspaceToolUse(toolName, args, config),
    contract: deriveScsTaskContract({ goal }), state: { meta: { goalContract: { revision: 2 } } } };
}
for (const name of ["list_files", "inspect_project", "search_files"]) for (const allowShellTool of [false, true]) test(`one scope correction changes no guard, config or arguments: ${name}/${allowShellTool}`, () => {
  const input = request(originalGoal, { ...scoped, allowShellTool }, name), before = JSON.stringify(input), value = scopedDiscoveryCorrection(input);
  assert.equal(value?.advice.autoRecover, true); assert.equal(value.receipt.attempts, 1); assert.equal(value.receipt.goalRevision, 2);
  assert.match(value.receipt.policyDigest, /^[0-9a-f]{64}$/); assert.ok(Object.isFrozen(value.receipt));
  assert.match(value.advice.instruction, /NOT executed/); assert.match(value.advice.instruction, /batch is skipped/); assert.match(value.advice.instruction, /Do not repeat/);
  assert.equal(JSON.stringify(input), before); assert.equal(checkWorkspaceToolUse(name, input.args, input.config).allowed, false);
  assert.equal(value.advice.suggestedCommand, undefined); assert.equal(value.advice.trustedHostCommand, undefined);
});

for (const goal of [
  "Read owner.txt, then create out/review.md.",
  "List the workspace root, then create out/review.md.",
  "Inspect the repository before creating out/review.md.",
  "Show the workspace files and create out/review.md.",
  "读取 owner.txt 后创建 out/清单.md。",
  "列出工作区文件，然后创建 out/清单.md。",
  "ファイル一覧を確認して、out/手順.mdを作成してください。",
  "Create out/review.md and run `node --version`.",
  "Create out/review.md and call writing_specialist.",
  "Explain how to create out/review.md. No file changes.",
  "Please create one unnamed Markdown note.",
]) test(`mixed, required-source or unknown task is not simplified by scope correction: ${goal}`, () => {
  assert.equal(scopedDiscoveryCorrection(request(goal)), null);
});

for (const [name, args] of [["list_files", { path: "private" }], ["list_files", { path: ".." }], ["read_file", { path: "owner.txt" }], ["write_file", { path: "wrong.md", content: "bad" }], ["read_file", { path: "out/.env" }]]) test(`a denied non-ancestor, direct source or mutation never becomes recoverable: ${name}/${args.path}`, () => {
  assert.equal(scopedDiscoveryCorrection(request(originalGoal, scoped, name, args)), null);
});

test("a used correction persists for the owner request; a new request gets a new bounded opportunity", () => {
  const input = request(), first = scopedDiscoveryCorrection(input);
  input.state.meta.nativeScopedDiscoveryCorrection = JSON.parse(JSON.stringify(first.receipt));
  assert.equal(scopedDiscoveryCorrection(input), null);
  input.state.meta.goalContract.revision = 3;
  assert.equal(scopedDiscoveryCorrection(input).receipt.goalRevision, 3);
  input.state.meta.goalContract.revision = 1;
  assert.equal(scopedDiscoveryCorrection(input), null);
});

for (const attack of ["null", "empty", "false", "extra", "accessor", "proxy", "future"]) test(`malformed or future correction budget fails closed without hooks: ${attack}`, () => {
  const input = request(); let calls = 0, value = { ...scopedDiscoveryCorrection(input).receipt };
  if (attack === "null") value = null;
  if (attack === "empty") value = {};
  if (attack === "false") value = false;
  if (attack === "extra") value.extra = true;
  if (attack === "accessor") Object.defineProperty(value, "attempts", { enumerable: true, get() { calls++; throw Error("hook"); } });
  if (attack === "proxy") value = new Proxy(value, { get() { calls++; throw Error("hook"); }, ownKeys() { calls++; throw Error("hook"); }, getPrototypeOf() { calls++; throw Error("hook"); } });
  if (attack === "future") value.goalRevision = 99;
  input.state.meta.nativeScopedDiscoveryCorrection = value;
  assert.equal(scopedDiscoveryCorrection(input), null); assert.equal(calls, 0);
});

test("invalid scopes are not converted to an unrestricted correction", () => {
  const input = request(); let calls = 0;
  input.config = { ...scoped, workspacePathScopeRoots: new Proxy(["out"], { get() { calls++; throw Error("hook"); } }) };
  assert.equal(scopedDiscoveryCorrection(input), null); assert.equal(calls, 0);
});

test("a literal output name containing a discovery verb is not a source directive", () => {
  assert.ok(scopedDiscoveryCorrection(request("Create out/read.md with a short welcome message.")));
});

test("protected, approval-bound or disjoint output paths cannot authorize a correction turn", () => {
  for (const [goal, config] of [["Create out/.env with a welcome message.", scoped], [originalGoal, { ...scoped, workspaceWritePolicy: "prompt" }], [originalGoal, { ...scoped, workspaceWritePathScopeRoots: ["other"] }]]) {
    assert.equal(scopedDiscoveryCorrection(request(goal, config)), null);
  }
});
