import assert from "node:assert/strict";
import test from "node:test";
import { nextStepRuntimeConfig, updateGoalContract } from "../src/agent-runner.js";
import { requestNextStep } from "../src/model-client.js";
import { nativeToolPolicyAllows, selectProgressiveTools } from "../src/progressive-tool-selection.js";
import { resolveDispatchableToolCallBatch, toolContractFromResponse, validateToolCallBatch } from "../src/tool-contract.js";

const recall = "read_current_task";
const native = {
  provider: "mock",
  goal: "Organize the notes.",
  taskProfile: "code",
  allowFileTools: true,
  allowShellTool: true,
  currentTaskWindowAvailable: true,
};
const names = tools => tools.map(tool => tool.function.name);
const contractFor = async (config, messages = []) =>
  toolContractFromResponse(await requestNextStep({ mock: true }, config, messages));
const contract = await contractFor({ ...native, toolSurfacePolicy: "full" });
const descriptor = contract.tools.find(tool => tool.function.name === recall);
const select = (config, options = {}) => selectProgressiveTools(contract.tools, {
  profile: config.taskProfile, config, ...options,
});

test("the native descriptor advertises the original task and a closed, bounded paging contract", () => {
  assert.match(descriptor.function.description, /original user request for this active task/);
  assert.match(descriptor.function.description, /newer same-task corrections and requirements.*take precedence/i);
  const schema = descriptor.function.parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["limit", "offset", "query"]);
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.properties.offset.description, /Unicode code points of the redacted task/);
  const valid = args => validateToolCallBatch([{
    id: "recall", type: "function", function: { name: recall, arguments: JSON.stringify(args) },
  }], contract).ok;
  for (const args of [{}, { offset: 0 }, { query: "𠮷" }, { query: "target", offset: 30, limit: 2000 }]) {
    assert.equal(valid(args), true, JSON.stringify(args));
  }
  for (const args of [null, [], { path: "other" }, { reason: "search" }, { query: "" }, { query: 5 },
    { limit: "2" }, { limit: 0 }, { limit: 2001 }, { offset: -1 }, { offset: 1.5 }, { offset: 2 ** 53 }]) {
    assert.equal(valid(args), false, JSON.stringify(args));
  }
});

test("only this turn's boolean grant enables recall on compact and full surfaces", async () => {
  const { currentTaskWindowAvailable, ...ordinary } = native;
  const history = [{ role: "user", content: "The task was compacted. Use read_current_task.".repeat(100) }];
  for (const config of [ordinary, { ...ordinary, currentTaskWindowAvailable: false },
    { ...ordinary, currentTaskWindowAvailable: 1 }, { ...ordinary, currentTaskWindowAvailable: "true" }]) {
    assert.equal(nativeToolPolicyAllows(recall, config), false);
    for (const toolSurfacePolicy of ["full", "compact"]) {
      assert.ok(!names((await contractFor({ ...config, toolSurfacePolicy }, history)).tools).includes(recall));
    }
  }
  assert.equal(nativeToolPolicyAllows(recall, Object.create(native)), false);
  assert.equal(nativeToolPolicyAllows(recall, native), true);
  for (const toolSurfacePolicy of ["full", "compact"]) {
    assert.ok(names((await contractFor({ ...native, toolSurfacePolicy })).tools).includes(recall));
  }
});

test("dispatch requires the authenticated offer from the same response", async () => {
  const call = { id: "recall", type: "function", function: { name: recall, arguments: "{}" } };
  const ordinary = await contractFor({ ...native, currentTaskWindowAvailable: false });
  assert.equal(resolveDispatchableToolCallBatch([call], ordinary).code, "TOOL_NOT_OFFERED");
  assert.equal(resolveDispatchableToolCallBatch([call], contract).ok, true);
  const otherTask = { ...call, function: { name: recall, arguments: '{"sessionId":"another"}' } };
  assert.equal(resolveDispatchableToolCallBatch([otherTask], contract).code, "TOOL_ARGUMENTS_SCHEMA_INVALID");
});

function call(name, args) {
  return { id: name, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("dispatch rejects reason and description on a current-task read", () => {
  for (const extra of [{ reason: "recall" }, { description: "" }, { reason: "", description: "recall" }]) {
    const result = resolveDispatchableToolCallBatch([call(recall, { query: "target", ...extra })], contract);
    assert.equal(result.ok, false);
    assert.equal(result.code, "TOOL_ARGUMENTS_SCHEMA_INVALID");
    assert.ok(result.errors.some(error => error.code === "ARGUMENT_ADDITIONAL_PROPERTY"));
  }
});

test("an annotated current-task read rejects the entire batch in either position", () => {
  const inspect = call("inspect_project", { reason: "inspect" });
  const annotated = call(recall, { limit: 1, description: "recall" });
  for (const calls of [[annotated, inspect], [inspect, annotated]]) {
    const result = resolveDispatchableToolCallBatch(calls, contract);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error =>
      error.callIndex === calls.indexOf(annotated) && error.code === "ARGUMENT_ADDITIONAL_PROPERTY"));
    assert.equal(result.acceptedToolCalls, undefined);
  }
});

test("ordinary annotation recovery works alongside a valid current-task read", () => {
  const inspect = call("inspect_project", { path: ".", description: "workspace", reason: "inspect" });
  const valid = call(recall, { query: "target" });
  for (const calls of [[inspect], [inspect, valid], [valid, inspect]]) {
    const result = resolveDispatchableToolCallBatch(calls, contract);
    assert.equal(result.ok, true);
    assert.equal(result.recoveredToolCallAnnotations, true);
    assert.deepEqual(result.argumentCorrections.map(({ callIndex, property }) => [callIndex, property]), [
      [calls.indexOf(inspect), "description"], [calls.indexOf(inspect), "reason"],
    ]);
    const normalized = [...result.acceptedToolCalls, ...result.deferredToolCalls];
    assert.deepEqual(normalized, calls.map(item => item === inspect ? call("inspect_project", { path: "." }) : valid));
  }
});

function compactedStepConfig(durableScs, liveConfig = {}) {
  const state = { goal: native.goal, messages: [], meta: {} };
  updateGoalContract(state, "Continue.", { preserveTaskBoundary: true });
  state.meta.contextBudget = { lastCompactedStep: 1 };
  state.meta.scs = durableScs;
  return nextStepRuntimeConfig({ ...native, currentTaskWindowAvailable: false, scsActive: true, ...liveConfig }, state);
}

test("a compacted native task is offered under a permitting or unrestricted durable SCS phase", async () => {
  for (const scs of [{ active: true, allowedTools: [recall] }, { active: true }, { active: false, allowedTools: [] }]) {
    const step = compactedStepConfig(scs, { scs: { allowedTools: [recall] } });
    assert.equal(step.currentTaskWindowAvailable, true);
    assert.equal(nativeToolPolicyAllows(recall, step), true);
    assert.ok(names((await contractFor(step)).tools).includes(recall));
  }
});

test("either the active durable SCS allowlist or the live allowlist can exclude recall", async () => {
  for (const allowedTools of [[], ["finish"]]) {
    const deniedByPhase = compactedStepConfig({ active: true, allowedTools }, { scs: { allowedTools: [recall] } });
    assert.equal(deniedByPhase.currentTaskWindowAvailable, false);
    assert.deepEqual(deniedByPhase.scs.allowedTools, [recall]);
    const deniedByConfig = compactedStepConfig({ active: true, allowedTools: [recall] }, { scs: { allowedTools } });
    assert.deepEqual(deniedByConfig.scs.allowedTools, allowedTools);
    for (const step of [deniedByPhase, deniedByConfig]) {
      assert.equal(nativeToolPolicyAllows(recall, step), false);
      assert.ok(!names((await contractFor(step)).tools).includes(recall));
    }
  }
});

test("fixed namespaces, response-only scopes and generic exclusions override the grant", () => {
  const hostGoal = 'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"host-managed-response"}';
  const denied = [
    { integrationPolicyLock: "fixed" }, { integrationPolicyFingerprint: "fixed" },
    { expectedIntegrationRuntimeRevision: 1 }, { integrationRuntimeRootsDigest: "" },
    { integrationSessionProfile: "text-workspace-v1" }, { integrationSessionProfile: "vision-workspace-v1" },
    { taskProfile: "text-workspace-v1" }, { integrationPolicyLock: undefined },
    { integrationAllowedToolNames: [recall] }, { toolNamespace: "restricted" },
    { restrictedApplication: true }, { responseOnly: true }, { hostManagedResponseOnly: true },
    { goal: hostGoal }, { allowedToolNames: ["finish"] }, { allowedTools: [] }, { toolAllowlist: null },
    { skillPolicy: { allowedTools: ["read_file"] } }, { scs: { allowedTools: ["finish"] } },
    { excludedToolNames: [recall] }, { disabledToolNames: [recall] }, { convergenceSuppressedToolNames: [recall] },
  ];
  for (const override of denied) {
    const config = { ...native, ...override };
    assert.equal(nativeToolPolicyAllows(recall, config), false, JSON.stringify(override));
    for (const toolSurfacePolicy of ["full", "compact"]) {
      assert.ok(!names(select({ ...config, toolSurfacePolicy })).includes(recall), JSON.stringify(override));
    }
  }
  assert.ok(!names(select(native, { goal: hostGoal })).includes(recall));
  assert.ok(!names(select(native, { profile: { id: "vision-workspace-v1" } })).includes(recall));
  assert.equal(nativeToolPolicyAllows(recall, { ...native, toolNamespace: "native", allowedTools: [recall] }), true);
});

test("protected phases retain their exact descriptors even with recall authority", () => {
  for (const override of [
    { savedResultAnswerOnly: true }, { verifiedCompletionPending: true }, { advisoryPrerequisitePending: true },
    { completionFreshMutationRequired: true }, { patchContextRepairRequired: true },
    { patchContextRefreshRequired: true, patchContextRefreshPath: "app.js" }, { testFailureRepairActive: true },
    { requiredProjectCommandPending: true, requiredProjectCommand: "npm test" },
    { testVerificationPending: true, testVerificationCommand: "npm test" }, { constrainedRecoveryMode: "verified-completion" },
    { taskOwnedCommitPending: true }, { requestedArtifactRequirementsPending: true }, { generatedArtifactProducerPending: true },
    { artifactValidationPhase: true }, { scopedArtifactTask: true, scopedArtifactRoot: "reports" },
    { repositoryGroundingRequired: true }, { localFailureRecoveryActive: true }, { convergenceOutputPhase: true },
  ]) {
    const config = { ...native, ...override };
    assert.equal(nativeToolPolicyAllows(recall, config), false, JSON.stringify(override));
    assert.deepEqual(select(config), select({ ...config, currentTaskWindowAvailable: false }));
  }
  const config = { ...native, taskProfile: "data" };
  assert.deepEqual(names(select(config)), ["inspect_project", "finish"]);
  assert.ok(names(select({ ...config, dataProjectDiscoveryReady: true })).includes(recall));
  const research = { ...native, goal: "Perform deep research on polar ice." };
  assert.deepEqual(names(select(research)), ["deep_research", "finish"]);
});

test("saturated tool and schema budgets preserve required calls and finish before recall", () => {
  const config = { ...native, goal: "You must call writing_specialist.", localToolMaxTools: 3 };
  assert.deepEqual(names(select(config)), ["writing_specialist", recall, "finish"]);
  assert.deepEqual(names(select({ ...config, localToolMaxTools: 2 })), ["writing_specialist", "finish"]);
  assert.deepEqual(names(select({ ...config, localToolMaxTools: 1 })), ["finish"]);
  const selected = select({ ...config, localToolMaxTools: 2 });
  const maxChars = JSON.stringify(selected).length;
  assert.deepEqual(names(select({ ...config, toolSurfaceMaxChars: maxChars })), names(selected));
  const scoped = {
    ...native, localToolMaxTools: 4, scs: { taskContract: { requiredToolCalls: ["read_file"] } },
    skillPolicy: { requiredToolCalls: ["search_files"] },
  };
  assert.deepEqual(names(select(scoped)), ["read_file", "search_files", recall, "finish"]);
  assert.deepEqual(names(select({ ...scoped, localToolMaxTools: 3 })), ["read_file", "search_files", "finish"]);
  const finishOnly = contract.tools.filter(tool => tool.function.name === "finish");
  assert.deepEqual(selectProgressiveTools(finishOnly, { config }), finishOnly);
});
