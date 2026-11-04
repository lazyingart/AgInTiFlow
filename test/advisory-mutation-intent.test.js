import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildScsEvidenceLedger, deriveScsTaskContract, evaluateScsEvidence } from "../src/scs-evidence.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { runAgent, projectTestVerificationFinishBlock } from "../src/agent-runner.js";
import { checkToolUse } from "../src/guardrails.js";

const realPrompt = "Please check totals.js against totals.test.js. Ask Codex once for an independent read-only second opinion, then verify the finding and briefly explain the smallest fix. Don't change any file or install anything.";
const readOnly = [realPrompt,
  "Read index.js and explain a minimal fix without changing files.",
  "Inspect parser.py and recommend the smallest patch. This is review only.",
  "Review the proposed changes to index.js; do not apply them.",
  "Read index.js and explain how to fix the bug. Don't edit it.",
  "Check index.js and suggest fixing the arithmetic; leave the source unchanged.",
  "Inspect index.js and verify the existing fix without rewriting it.",
  "阅读 index.js，解释最小修复方案，不要修改文件。",
  "讀取 index.js，說明建議的修改方案，請勿修改檔案。",
  "index.js を確認して更新案を説明してください。ファイルを編集しないでください。",
];
const mutations = [
  "Fix index.js and verify it. Do not change unrelated files.",
  "Read index.js, then explain and implement the smallest fix.",
  "Review and patch index.js.",
  "Explain the fix for index.js, then apply it.",
  "Suggest a patch for index.js; apply it after review.",
  "Explain a patch for index.js, then only apply the recommendation after review.",
  "Read index.js, recommend a fix, and write review.md.",
  "Read-only inspection of index.js, then write review.md.",
  "检查 index.js，然后修复代码并运行测试。",
  "index.js を更新してください。",
];

test("advisory fix nouns do not create a workspace/file mutation obligation", () => {
  for (const goal of readOnly) {
    const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
    assert.equal(contract.requiresWorkspaceMutation, false, goal);
    assert.equal(contract.requiresFileMutation, false, goal);
  }
});

test("explicit actions and mixed review-plus-write requests still require mutation", () => {
  for (const goal of mutations) {
    const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
    assert.equal(contract.requiresWorkspaceMutation, true, goal);
    assert.equal(contract.requiresFileMutation, true, goal);
  }
});

async function runReadOnlyReview(repeatDenied) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-advisory-intent-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const source = "export const total = rows => rows.reduce((n, row) => n + row.unitPrice, 0);\n";
    const checks = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from './totals.js'; test('quantities', () => assert.equal(total([{ unitPrice: 5, quantity: 3 }, { unitPrice: 4, quantity: 4 }]), 31));\n";
    await fs.writeFile(path.join(workspace, "totals.js"), source);
    await fs.writeFile(path.join(workspace, "totals.test.js"), checks);
    let step = 0;
    const offered = [];
    const call = (name, args) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    const client = { chat: { completions: { create: async (request) => {
      offered.push(request.tools.map((tool) => tool.function.name));
      if (++step === 1) return call("read_file", { path: "totals.js" });
      if (step === 2) return call("read_file", { path: "totals.test.js" });
      if (step === 3) return call("run_command", { command: "node --test totals.test.js" });
      if (step === 4) return call("run_command", { command: "node -e \"require('fs').writeFileSync('forbidden.txt', 'must not execute')\"" });
      assert.equal(step, 5, `unexpected forced repair turn: ${JSON.stringify(request.messages.slice(-2)).slice(0, 1800)}`);
      if (repeatDenied) return call("run_command", { command: "node -e \"require('fs').writeFileSync('forbidden.txt', 'second denied attempt')\"" });
      return call("finish", { result: "The test fails because the source ignores quantity: it adds prices 5 + 4 = 9. The supplied case expects 5 × 3 + 4 × 4 = 31. The smallest fix is to multiply each unitPrice by quantity. No files were changed." });
    } } } };
    const clientFactory = async () => client;
    clientFactory.agintiDeterministicTest = true;
    const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const config = resolveRuntimeConfig({ goal: realPrompt, provider: "openai", model: "scripted-review", routingMode: "manual", enableScs: "off" }, {
      baseDir: workspace, commandCwd: workspace, packageDir, sessionId: "advisory-readonly", clientFactory, sandboxMode: "host",
      allowFileTools: true, allowShellTool: true, allowWrapperTools: true, preferredWrapper: "codex", allowWebSearch: false, allowMcpTools: false,
      allowParallelScouts: false, allowAuxiliaryTools: false,
    });
    Object.assign(config, { apiKey: "scripted-test-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
      clientFactory, useDockerSandbox: false, allowProjectWrites: false, allowShellTool: true, allowWrapperTools: true, preferredWrapper: "codex", scsActive: false,
      executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline read-only review regression." }, maxSteps: 6, quiet: true });
    const result = await runAgent(config);
    if (repeatDenied) {
      assert.equal(result.stopped, true);
      assert.equal(result.reason, "permission_required");
    } else {
      assert.notEqual(result.stopped, true);
      assert.notEqual(result.failed, true);
      assert.match(result.result, /31/);
    }
    assert.equal(step, 5);
    assert.ok(offered.some((names) => names.includes("delegate_agent")), "optional selected adviser was hidden");
    assert.ok(offered.every((names) => names.length !== 1 || names[0] !== "apply_patch"), "read-only review became a patch-only turn");
    assert.equal(await fs.readFile(path.join(workspace, "totals.js"), "utf8"), source);
    assert.equal(await fs.readFile(path.join(workspace, "totals.test.js"), "utf8"), checks);
    await assert.rejects(fs.stat(path.join(workspace, "forbidden.txt")), { code: "ENOENT" });
    const events = (await fs.readFile(path.join(root, "sessions/advisory-readonly/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(!events.some((event) => event.type === "tool.started" && ["apply_patch", "write_file"].includes(event.data?.toolName)));
    assert.ok(!events.some((event) => event.type === "verification.test_repair_requested"));
    assert.ok(events.some((event) => event.type === "tool.completed" && event.data?.projectTest?.passed === false));
    assert.equal(events.filter((event) => event.type === "tool.blocked" && event.data?.permissionAdvice?.autoRecover === true).length, 1);
    assert.ok(!events.some((event) => event.type === "tool.started" && event.data?.args?.command?.includes("writeFileSync")));
  } finally {
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("persisted read-only review keeps advice available without forcing apply_patch", { timeout: 15000 }, () => runReadOnlyReview(false));
test("a second denied general-shell attempt cannot gain another recovery or permission", { timeout: 15000 }, () => runReadOnlyReview(true));

function diagnosticState() {
  return { goal: realPrompt, meta: { goalContract: { revision: 1, currentRequest: realPrompt },
    activeExecutionContract: { revision: 1, startedMutationRevision: 2, requiresWorkspaceMutation: false, refreshedAt: "2026-11-05T01:00:00Z" },
    projectVerification: { mutationRevision: 2, privateMutationRevision: 0, testRuns: [{ command: "node --test totals.test.js", passed: false, mutationRevision: 2, privateMutationRevision: 0, at: "2026-11-05T01:00:01Z" }] } } };
}

test("diagnostic failure requires truthful reporting and cannot hide pass claims or source changes", () => {
  const state = diagnosticState();
  for (const answer of ["The test failed: 9 is not 31.", "The tests did not pass.", "测试失败，实际为9，预期为31。", "測試沒有通過，實際為9。", "テストは失敗しました。"])
    assert.equal(projectTestVerificationFinishBlock(state, answer), null, answer);
  for (const answer of ["All tests passed.", "The test failed but all tests now pass.", "No failed tests.", "测试失败，但是所有测试通过。", "The file looks fine."])
    assert.equal(projectTestVerificationFinishBlock(state, answer)?.category, "read-only-diagnostic-report", answer);
  state.meta.projectVerification.mutationRevision = 3;
  assert.notEqual(projectTestVerificationFinishBlock(state, "The test failed."), null);
  state.meta.projectVerification.mutationRevision = 2;
  state.meta.projectVerification.privateMutationRevision = 1;
  assert.notEqual(projectTestVerificationFinishBlock(state, "The test failed."), null);
});

test("negative observations never satisfy a repair or mandatory-green contract", () => {
  const state = diagnosticState();
  const ledger = buildScsEvidenceLedger({ state, context: { readOnlyDiagnostic: true, events: [{ type: "tool.completed", timestamp: "2026-11-05T01:00:01Z", data: {
    toolName: "run_command", ok: false, exitCode: 1, goalRevision: 1, projectMutationRevision: 2, args: { command: "node --test totals.test.js" }, projectTest: { passed: false },
  } }] } });
  assert.ok(ledger.items.filter((item) => item.diagnosticOnly).every((item) => item.passed === false));
  assert.equal(ledger.items.filter((item) => item.diagnosticOnly).length, 2);
  const requiredEvidence = [{ category: "command" }, { category: "test" }];
  const diagnostic = { ...deriveScsTaskContract({ goal: realPrompt }), requiredEvidence };
  assert.equal(evaluateScsEvidence(diagnostic, ledger).ok, true);
  for (const goal of ["Repair totals.js and get the tests passing.", "Read-only: run tests and ensure they pass. Don't change any file."])
    assert.equal(evaluateScsEvidence({ ...deriveScsTaskContract({ goal }), requiredEvidence }, ledger).ok, false, goal);
  assert.equal(evaluateScsEvidence({ requiredEvidence: [], requiredToolCalls: ["run_command"] }, ledger).ok, false);
});

test("advisory prohibitions are not destructive requests; positive risk and wrapper selection remain closed", () => {
  const config = { allowWrapperTools: true, preferredWrapper: "codex", allowDestructive: false };
  const check = (prompt, overrides = {}) => checkToolUse({ toolName: "delegate_agent", args: { wrapper: "codex", prompt }, config: { ...config, ...overrides } });
  for (const prompt of [
    "Read-only review. Do not install anything. Explain the defect.",
    "Do NOT modify, create, or delete any file. Do not install packages. Review the supplied code.",
    "Review the code. Never install or publish. Return advice only.",
    'Instructions say: "Do not modify files, inspect other directories, use web or MCP, install packages, or load secrets." Review this source.',
  ]) assert.equal(check(prompt).allowed, true, prompt);
  for (const prompt of ["Install the missing package and fix it.", "Do not install packages, then deploy the service.", "Never delete, but publish this package.", "Review the code, then git push.", "Do not install package A, B, or C, then publish the result."])
    assert.equal(check(prompt).allowed, false, prompt);
  assert.equal(check("Review the code only.", { allowWrapperTools: false }).allowed, false);
  assert.equal(check("Review the code only.", { preferredWrapper: "claude" }).allowed, false);
});
