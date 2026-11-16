import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildKnownReadOnlyAnswerPhasePlan, buildKnownConstrainedPhasePlan, completionTaskContract } from "../src/agent-runner.js";
import { deriveScsTaskContract, evaluateScsSemanticContract } from "../src/scs-evidence.js";
import { resolveRuntimeConfig } from "../src/config.js";
import * as runtimePolicy from "../src/session-runtime.js";

const familyFields = ["allowBrowserTools", "allowCanvasTools", "allowAgentLinkTools", "allowCoordinationTools", "allowSpecialistTools", "allowJsonTools", "allowJsonSpecialist", "allowWritingTools", "allowWritingSpecialist", "allowLongJobTools", "allowBackgroundJobs", "allowTmuxTools", "allowImageTools", "allowVisionTools", "allowImagePerception", "allowImageGeneration"];
const disabledFamilies = Object.fromEntries(familyFields.map(field => [field, false]));
const assertFamily = (snapshot, expected) => { for (const field of familyFields) assert.equal(snapshot[field], expected, field); };

test("native tool-family policy is resolved, captured and retained through a provider-only patch", () => {
  const config = resolveRuntimeConfig({ provider: "mock", model: "mock" }, disabledFamilies);
  assertFamily(config, false);
  const before = runtimePolicy.captureSessionRuntime(config);
  assert.equal(before.schemaVersion, 3);
  assertFamily(before, false);
  const after = runtimePolicy.resolveSessionRuntime({ state: { meta: { runtimeConfig: before } }, runtimePatch: { provider: "deepseek", model: "deepseek-v4-pro" }, expectedRevision: 1 });
  assertFamily(after.snapshot, false);assertFamily(after.runtimeOverrides, false);assert.equal(after.snapshot.revision, 2);
});

test("native tool-family policy cannot be widened by incoming values or stale CAS", () => {
  const before = runtimePolicy.captureSessionRuntime({ provider: "mock", model: "mock", ...disabledFamilies });
  const bytes = JSON.stringify(before);
  const state = { meta: { runtimeConfig: before } };
  assertFamily(runtimePolicy.resolveSessionRuntime({ state, incomingConfig: Object.fromEntries(familyFields.map(field => [field, true])) }).snapshot, false);
  assert.throws(() => runtimePolicy.applySessionRuntimePatch(before, { allowBrowserTools: true }, 2), { code: "SESSION_RUNTIME_CONFLICT" });
  const changed = runtimePolicy.applySessionRuntimePatch(before, { allowBrowserTools: true }, 1);
  assert.equal(changed.allowBrowserTools, true);assert.equal(changed.revision, 2);assert.equal(JSON.stringify(before), bytes);
  for (const value of ["false", null, undefined, 0]) assert.throws(() => runtimePolicy.applySessionRuntimePatch(before, { allowBrowserTools: value }, 1), { code: "SESSION_RUNTIME_INVALID_FIELD" });
  assert.throws(() => runtimePolicy.resolveSessionRuntime({ savedRuntime: { ...before, allowBrowserTools: null } }), { code: "SESSION_RUNTIME_INVALID_FIELD" });
  const missing = { ...before };delete missing.allowBrowserTools;
  assert.throws(() => runtimePolicy.resolveSessionRuntime({ savedRuntime: missing }), { code: "SESSION_RUNTIME_INVALID_FIELD" });
  assertFamily(runtimePolicy.applySessionRuntimePatch(before, { permissionMode: "danger" }, 1), false);
});

test("native tool-family policy missing from a legacy snapshot requires explicit restrictive migration", () => {
  const legacy = runtimePolicy.captureSessionRuntime({ provider: "mock", model: "mock" });
  for (const field of familyFields) delete legacy[field];
  legacy.schemaVersion = 1;
  const bytes = JSON.stringify(legacy), state = { meta: { runtimeConfig: legacy } };
  assert.throws(() => runtimePolicy.resolveSessionRuntime({ state, incomingConfig: disabledFamilies }), { code: "SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED" });
  assert.throws(() => runtimePolicy.resolveSessionRuntime({ state, incomingConfig: disabledFamilies, runtimePatch: { model: "mock-next" }, expectedRevision: 1 }), { code: "SESSION_RUNTIME_POLICY_MIGRATION_REQUIRED" });
  const migrated = runtimePolicy.resolveSessionRuntime({ state, incomingConfig: disabledFamilies, runtimePatch: disabledFamilies, expectedRevision: 1 });
  assertFamily(migrated.snapshot, false);assert.equal(migrated.snapshot.revision, 2);assert.equal(JSON.stringify(legacy), bytes);
});

test("native tool-family policy preserves unrestricted legacy defaults without inventing a restriction", () => {
  const legacy = runtimePolicy.captureSessionRuntime({ provider: "mock", model: "mock" });
  for (const field of familyFields) delete legacy[field];
  legacy.schemaVersion = 1;
  const result = runtimePolicy.resolveSessionRuntime({ savedRuntime: legacy });
  assertFamily(result.snapshot, true);assert.equal(result.snapshot.revision, 1);
  assert.equal(result.snapshot.schemaVersion, 3);
  assert.deepEqual(runtimePolicy.SESSION_TOOL_FAMILY_FIELDS, familyFields);
});

for (const goal of [
  "could you draft a quick friendly reply pls? They finished reviewing my note; I'll send the revision tomorrow. Just reply here in chat, no file changes.",
  "Draft a short letter here in chat. Do not save a file.",
  "Write a two-sentence thank-you message here. No file changes.",
  "Please generate a brief reply here; no attachments.",
  "Compose a polite email in this chat.",
  "Prepare a concise summary inline.",
  "Please rewrite the reply here.",
  "Draft a quick reply. Just put the reply here.",
  "Create a checklist here in chat.",
  "帮我生成一段简短回复，直接在聊天里回答，不要创建文件。",
  "请在聊天里生成一段回复。",
  "このチャットに短い返信を生成してください。",
  "ここで短い文章を作成してください。",
  "Draft a reply from the supplied text; answer here only.",
]) test(`explicit inline text is an answer deliverable, not a file artifact: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.equal(contract.requiresExternalEvidence, false);
  assert.deepEqual(contract.requiredEvidence, []);
  assert.deepEqual(contract.exactOutputPaths, []);
  assert.deepEqual(contract.requiredArtifactKinds, []);
  assert.equal(contract.requiresWorkspaceMutation, false);
  assert.equal(contract.requiresFileMutation, false);
  assert.ok(contract.outcome.length);
});

for (const [goal, check] of [
  ["Draft a short letter.", c => c.requiredEvidence.some(x => x.category === "artifact")],
  ["Draft a short reply as reply.md here in chat.", c => c.requiredEvidence.some(x => x.category === "artifact")],
  ["Draft a reply here; create letter.md.", c => c.exactOutputPaths.includes("letter.md") && c.requiresFileMutation],
  ["Draft a reply here; run `node --test check.mjs`.", c => c.requiredEvidence.some(x => x.category === "command") && c.requiredEvidence.some(x => x.category === "test")],
  ["Read note.md, then draft a reply here in chat.", c => c.exactInputPaths.includes("note.md") && c.requiresSourceGrounding],
  ['Create report.md containing "Reply here in chat."', c => c.exactOutputPaths.includes("report.md") && c.requiresFileMutation],
  ['Draft a letter. Explain the phrase "reply here".', c => c.requiredEvidence.some(x => x.category === "artifact")],
  ['The note says "draft a reply here"; create report.pdf.', c => c.requiredArtifactKinds.some(x => x.extension === ".pdf")],
  ["Draft a reply here, then create a PDF.", c => c.requiredArtifactKinds.some(x => x.extension === ".pdf")],
  ["Generate an image here in chat.", c => c.requiredEvidence.some(x => x.category === "artifact")],
  ["Draft a reply here; explicitly call writing_specialist first.", c => c.requiredToolCalls.includes("writing_specialist")],
  ["Write the file reply.md here in chat.", c => c.requiresFileMutation && c.exactOutputPaths.includes("reply.md")],
]) test(`inline delivery cannot erase other work or be issued by quoted data: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.equal(check(contract), true);
});

const inputContract = () => deriveScsTaskContract({ goal: "Read source.md and answer here only. No file changes.", taskProfile: "auto" });
for (const [goal, required] of [
  ["Copy template.txt to draft.txt without changing either byte.", []],
  ["Fix app.js.", []],
  ["Read note.md and data.md. Answer here.", ["note.md", "data.md"]],
  ["Read note.md and produce report.md.", ["note.md"]],
  ["Read README.md and add short planning.md and review.md checklists. Keep existing files as they are.", ["README.md"]],
  ["Read README.md, then add planning.md.", ["README.md"]],
  ["请读取 source.md，然后添加 report.md。", ["source.md"]],
  ['Explain the phrase "Read source.md". Answer here.', []],
  ["Do not read source.md. Just answer the supplied note.", []],
  ["请读取 source.md，然后在聊天里回答。", ["source.md"]],
  ["「source.md」を読んでください。", ["source.md"]],
  ["『source.md』を読んでください。", ["source.md"]],
  ["「source.md』を読んでください。", []],
  ["Explain 「source.md を読んでください。」", []],
  ["Please read `source.md` and answer here.", ["source.md"]],
  ["The user previously read source.md. Explain that note only.", []],
]) test(`mandatory source reads distinguish instructions from copy operands and narration: ${goal}`, () => {
  const contract = deriveScsTaskContract({ goal, taskProfile: "auto" });
  assert.deepEqual(contract.requiredInputReadPaths || [], required);
});
const inputReceipt = { toolName: "read_file", ok: true, path: "source.md", sha256: createHash("sha256").update("note").digest("hex"), bytes: 4, content: "note" };
for (const [label, payload] of [
  ["no receipt", null],
  ["directory listing", { toolName: "list_files", ok: true, path: ".", entries: ["source.md"] }],
  ["echoed pathname", { toolName: "run_command", ok: true, exitCode: 0, args: { command: "echo source.md" }, stdout: "source.md" }],
  ["different input", { ...inputReceipt, path: "other.md" }],
  ["failed reader", { ...inputReceipt, ok: false }],
  ["missing hash", { ...inputReceipt, sha256: "" }],
  ["missing content", { ...inputReceipt, content: undefined }],
  ["masked shell failure", { toolName: "run_command", ok: true, exitCode: 0, args: { command: "cat source.md || echo fallback" }, stdout: "fallback" }],
  ["executable sed expression", { toolName: "run_command", ok: true, exitCode: 0, args: { command: "sed -n '1e echo replacement' source.md" }, stdout: "replacement" }],
]) test(`an explicit input read cannot be satisfied by ${label}`, () => {
  const contract = inputContract();assert.equal(contract.requiresExternalEvidence, true);
  const result = evaluateScsSemanticContract(contract, { commandCwd: "/owned-workspace", events: payload ? [{ type: "tool.completed", data: payload }] : [] });
  assert.equal(result.ok, false);assert.deepEqual(result.inputReads.missingInputReads, ["source.md"]);
});
for (const [label, evidence] of [
  ["native read event", { events: [{ type: "tool.completed", data: inputReceipt }] }],
  ["retained native tool message", { state: { messages: [{ role: "tool", content: JSON.stringify(inputReceipt) }] } }],
  ["successful literal display", { events: [{ type: "tool.completed", data: { toolName: "run_command", ok: true, exitCode: 0, args: { command: "cat source.md" }, stdout: "note" } }] }],
]) test(`an explicit input read accepts ${label} without demanding an output file`, () => {
  const result = evaluateScsSemanticContract(inputContract(), { commandCwd: "/owned-workspace", ...evidence });
  assert.equal(result.ok, true);assert.equal(result.checked, true);assert.deepEqual(result.inputReads.missingInputReads, []);
});

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
