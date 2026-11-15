import assert from "node:assert/strict";
import test from "node:test";
import { buildKnownReadOnlyAnswerPhasePlan, buildKnownConstrainedPhasePlan, completionTaskContract } from "../src/agent-runner.js";

function context(request, extra = {}) {
  const config = { goal: request, taskProfile: "code" };
  const state = { goal: request, messages: [], meta: { taskProfile: "code", goalContract: {
    version: 3, revision: 1, taskBoundaryRevision: 1, activeGoalRevision: 1,
    taskGoal: request, activeGoal: request, currentRequest: request, history: [],
  }, ...extra } };
  return { config, state };
}

for (const request of [
  "Why did the previous test fail? Did you edit any file? Do not rerun it or modify any file.",
  "Why did the last check fail? Did you modify any file? Do not rerun or modify any file.",
  "上次的检查为什么失败？有没有修改文件？不要重跑，也不要修改文件。",
  "前回のテストはなぜ失敗しましたか？ファイルを変更しましたか？再実行せず、読み取り専用で答えてください。",
]) test(`known read-only answer phase does not need a model plan: ${request}`, () => {
  const { config, state } = context(request), before = JSON.stringify({ config, state });
  const phase = buildKnownReadOnlyAnswerPhasePlan(config, state);
  assert.equal(phase?.mode, "read-only-answer"); assert.equal(phase.command, "");
  assert.match(phase.plan, /what remains unknown/); assert.match(phase.plan, /final evidence validation still apply/);
  assert.equal(JSON.stringify({ config, state }), before);
  assert.equal(buildKnownConstrainedPhasePlan(config, state, {}), null, "Answer workflow must not become a forced completion/recovery phase");
});

for (const request of [
  "Why did the previous test fail and ensure tests pass? Do not modify any file.",
  "Why did the previous test fail and guarantee tests pass? Do not modify any file.",
  "Why did the previous test fail and get the tests to pass? Do not modify any file.",
  "上次的检查为什么失败？必须保证全部检查通过。不要修改文件。",
  "前回のテストはなぜ失敗しましたか？テストは必ず合格してください。読み取り専用で答えてください。",
  "Why did the last check fail? Inspect check.mjs and explain the current bug. Do not modify any file.",
  "Run `node --test check.mjs` once and report the result. Do not modify any file.",
  "Why did the last check fail? Create report.md. Do not modify check.mjs.",
  "Why did the last check fail? Ask Codex to review it. Do not modify any file.",
  "What is the current status of check.mjs? Do not modify any file.",
  "Why did the last check fail?",
]) test(`new obligations do not select an answer-only plan: ${request}`, () => {
  const { config, state } = context(request);
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config, state), null);
});

test("a retained unfinished task cannot become a read-only answer phase", () => {
  const { config, state } = context("Why did the previous test fail? Do not rerun or modify any file.");
  state.meta.goalContract.taskGoal = "Create report.md with the verified results.";
  assert.equal(completionTaskContract(config, state).requiresExternalEvidence, true);
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config, state), null);
});
test("an existing approved plan is preserved", () => {
  const { config, state } = context("Why did the previous test fail? Do not rerun or modify any file.");
  state.plan = "Existing approved phase"; assert.equal(buildKnownReadOnlyAnswerPhasePlan(config, state), null); assert.equal(state.plan, "Existing approved phase");
});
test("additional acceptance criteria keep normal planning", () => {
  const { config, state } = context("Why did the previous test fail? Do not rerun or modify any file.", { scs: { acceptanceCriteria: ["Check the current source before answering."] } });
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config, state), null);
});
test("current authoritative execution requirements keep normal planning", () => {
  const { config, state } = context("Why did the previous test fail? Do not rerun or modify any file.", { activeExecutionContract: {
    revision: 1, requiresSourceGrounding: true, requiresFileMutation: false, startedMutationRevision: 0,
  } });
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config, state), null);
});
