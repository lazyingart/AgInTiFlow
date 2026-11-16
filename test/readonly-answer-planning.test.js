import assert from "node:assert/strict";
import test from "node:test";
import { buildKnownReadOnlyAnswerPhasePlan, buildKnownConstrainedPhasePlan, completionTaskContract } from "../src/agent-runner.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

for (const goal of [
  "Could you summarize this note? The draft is ready. Just answer here, no file changes.",
  "The draft is ready; the appendix needs review. Just answer here. Do not change any files.",
  "Is the draft ready? Just tell me.",
  'Explain the phrase "draft a letter". Do not create anything.',
  "What is the status of the draft?",
  "A draft of the letter was rejected. Explain the note only.",
  "The prior draft already exists. Summarize the supplied note.",
  "Read draft.md and explain its contents. No file changes.",
  "内容里说 draft 已准备好。只用文字回答，不要修改文件。",
  "この文の draft は完成済みです。説明だけしてください。",
  "The team asked to draft a report last week. Summarize this note only.",
  "Draft status: ready. Explain this status only.",
]) test(`artifact nouns and quoted instructions do not request a new draft: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.equal(contract.requiredEvidence.some(item => item.category === "artifact"), false);
  if (!goal.includes("draft.md")) assert.equal(contract.requiresExternalEvidence, false);
});

for (const goal of [
  "Draft a short letter.", "Please draft a release note.", "Could you draft a short memo?",
  "I want you to draft a plan.", "I need a draft.", "I'd like a draft of the report.",
  "Give me a rough draft.", "Return the revised draft.", "Finish the existing draft.",
  "The draft is ready; now draft the conclusion.", "Explain the draft; then create a PDF.",
  "Read draft.md, then create final.pdf.",
]) test(`affirmative draft/artifact requests keep their evidence gate: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.equal(contract.requiresExternalEvidence, true);
  assert.equal(contract.requiredEvidence.some(item => item.category === "artifact"), true);
});

for (const clause of ["No file changes.", "Please just no workspace modifications.", "No file writes."]) {
  test(`a closed no-mutation clause is a prohibition, not fresh execution: ${clause}`, () => {
    const contract = deriveScsTaskContract({ goal: `Summarize the supplied status. ${clause}`, taskProfile: "auto" });
    assert.equal(contract.requiresExternalEvidence, false);
    assert.deepEqual(contract.requiredEvidence, []);
    assert.ok(contract.forbiddenActions.includes("User forbids: modify files"));
  });
}
test("no file changes preserves a separately requested diagnostic command", () => {
  const contract = deriveScsTaskContract({ goal: "No file changes; run `node --test check.mjs` once.", taskProfile: "auto" });
  assert.equal(contract.requiresExternalEvidence, true);
  assert.ok(contract.requiredEvidence.some(item => item.category === "command"));
  assert.ok(contract.requiredEvidence.some(item => item.category === "test"));
  assert.ok(contract.forbiddenActions.includes("User forbids: modify files"));
});

for (const goal of [
  'Create letter.md containing the text "No file changes."',
  "Write note.txt with the exact text No file changes.",
  'Explain the phrase "No file writes."',
  "No file changes to original.md; create report.md.",
]) test(`quoted, data and scoped no-change prose cannot issue a global file ban: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.equal(contract.forbiddenActions.includes("User forbids: modify files"), false);
  if (/^(?:Create|Write)/.test(goal)) assert.ok(contract.requiredEvidence.some(item => item.category === "file"));
});

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
