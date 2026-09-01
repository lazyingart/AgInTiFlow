#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateLocalFailureRecovery,
  applyLocalFailureRecovery,
  decideLocalFailureRecovery,
  localFailureRecoveryInstruction,
} from "../src/local-failure-recovery.js";
import {
  activePatchContextRepair,
  activePatchContextRefresh,
  activeRequiredSymbolRepair,
  adoptModelTimeoutRecoveryState,
  bindPatchContextRepairArguments,
  buildMalformedToolResponseRetryMessages,
  buildFailedTestFocusedRecoveryMessages,
  consumePatchContextRepairMutation,
  consumePatchContextRepairRead,
  consumePatchContextRefreshRead,
  currentRequiredSymbolRepair,
  derivePatchContextAnchor,
  failedTestRequiredSymbolContracts,
  isLocalMalformedToolResponseError,
  nextStepRuntimeConfig,
  patchContextRefreshDecision,
  patchContextReplacementScopeIssue,
  repeatedSuccessfulMutationBlock,
  requiredSymbolAbsenceDecision,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  shouldRetryWithTextToolProtocol,
  usesTextToolProtocol,
} from "../src/model-client.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const baseConfig = {
  provider: "localllm",
  model: "localllm-fast",
  routingMode: "smart",
  routeProvider: "localllm",
  routeModel: "localllm-fast",
  mainProvider: "localllm",
  mainModel: "localllm-deep",
  spareProvider: "localllm",
  spareModel: "localllm-deep",
};

const malformedProviderError = new Error(
  '500 llama-server returned invalid tool call arguments for "apply_patch": unexpected end of JSON input'
);
Object.defineProperties(malformedProviderError, {
  agintiProviderRequest: { value: true },
  agintiProvider: { value: "localllm" },
});
assert.equal(
  isLocalMalformedToolResponseError(malformedProviderError, baseConfig),
  true,
  "an annotated LocalLLM malformed native tool response was not recognized"
);
assert.equal(
  isLocalMalformedToolResponseError(
    new Error('Workspace tool returned invalid tool call arguments for "apply_patch".'),
    baseConfig
  ),
  false,
  "an ordinary unannotated workspace failure was misclassified as a provider response failure"
);
assert.equal(
  shouldRetryWithTextToolProtocol(malformedProviderError, baseConfig),
  true,
  "llama-server malformed native tool JSON did not activate the text-tool fallback"
);
assert.equal(
  shouldRetryWithTextToolProtocol(malformedProviderError, { provider: "deepseek" }),
  false,
  "a provider without the text-tool fallback crossed its provider contract"
);
assert.equal(
  usesTextToolProtocol({ ...baseConfig, forceTextToolProtocol: true }),
  true,
  "the bounded retry could not force the provider-supported text-tool protocol"
);
const groundedMalformedRetryMessages = buildMalformedToolResponseRetryMessages(
  [
    { role: "system", content: "bounded repair" },
    { role: "user", content: "Exact source path: service_ctl.py" },
    { role: "user", content: "Current source anchor: def main() -> int:" },
  ],
  { progressiveToolNames: ["apply_patch"] },
  3,
  malformedProviderError
);
assert.match(
  groundedMalformedRetryMessages.map((message) => message.content).join("\n"),
  /Exact source path: service_ctl\.py[\s\S]*exactly one complete apply_patch call[\s\S]*do not rewrite the whole file/i,
  "the malformed-response retry lost grounding or failed to constrain the replacement call"
);

function stateWithRecent(recent) {
  return { meta: { toolLoop: { recent } } };
}

function failed(toolName, signature, options = {}) {
  return {
    toolName,
    signature,
    ok: false,
    blocked: false,
    ...options,
  };
}

const singleFailure = decideLocalFailureRecovery(
  baseConfig,
  stateWithRecent([failed("run_command", "run:python analysis.py")])
);
assert.equal(singleFailure.active, false, "one ordinary command failure should not escalate the model");

const codeTierContractViolationState = {
  meta: {
    toolLoop: { recent: [] },
    toolContractViolation: { consecutive: 2, count: 2 },
  },
};
const codeTierContractRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-code",
    routeModel: "localllm-fast",
    localCodeFallbackModel: "localllm-deep",
  },
  codeTierContractViolationState
);
assert.equal(
  codeTierContractRecovery.active,
  true,
  "repeated schema violations from a strong local tier should still activate local recovery"
);
assert.equal(
  codeTierContractRecovery.model,
  "localllm-deep",
  "code-tier contract recovery did not select a different strong local model"
);

const staleRecoveryState = {
  meta: {
    goalContract: { currentHash: "new-goal" },
    toolLoop: { recent: [] },
    toolContractViolation: { consecutive: 2, count: 2 },
    localFailureRecovery: {
      active: true,
      model: "localllm-code",
      fromModel: "localllm-deep",
      goalKey: "old-goal",
      attemptedModels: ["localllm-deep", "localllm-code"],
      hopCount: 1,
    },
  },
};
const staleRecoveryDecision = activateLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-code",
    routeModel: "localllm-fast",
    localCodeFallbackModel: "localllm-deep",
  },
  staleRecoveryState
);
assert.equal(staleRecoveryDecision.active, true, "a failed stale recovery route should remain recoverable");
assert.equal(staleRecoveryDecision.activated, true, "a new goal should activate a fresh recovery handoff");
assert.equal(staleRecoveryDecision.model, "localllm-deep", "stale code recovery did not roll over to deep");
assert.equal(staleRecoveryState.meta.localFailureRecovery.goalKey, "new-goal");
assert.deepEqual(
  staleRecoveryState.meta.localFailureRecovery.attemptedModels,
  ["localllm-code", "localllm-deep"],
  "new-goal recovery retained exhausted model attempts from an older goal"
);
const stalePersistedRouteState = {
  meta: {
    goalContract: { currentHash: "new-goal" },
    localFailureRecovery: {
      active: true,
      model: "localllm-deep",
      fromModel: "localllm-code",
      goalKey: "old-goal",
    },
  },
};
assert.equal(
  applyLocalFailureRecovery(baseConfig, stalePersistedRouteState).model,
  "localllm-fast",
  "a recovery model from an older continuation remained pinned without current evidence"
);

const exhaustedRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-code",
    routeModel: "localllm-fast",
    localCodeFallbackModel: "localllm-deep",
  },
  {
    meta: {
      goalContract: { currentHash: "same-goal" },
      toolLoop: { recent: [] },
      toolContractViolation: { consecutive: 2, count: 2 },
      localFailureRecovery: {
        active: true,
        model: "localllm-code",
        fromModel: "localllm-deep",
        goalKey: "same-goal",
        attemptedModels: ["localllm-deep", "localllm-code"],
        hopCount: 1,
      },
    },
  }
);
assert.equal(exhaustedRecovery.active, false, "same-goal recovery should not ping-pong between exhausted routes");
assert.equal(exhaustedRecovery.reason, "no-strong-local-recovery-model");

const repeatedState = stateWithRecent([
  failed("apply_patch", "patch:ambiguous-function"),
  failed("apply_patch", "patch:ambiguous-function"),
]);
const repeatedDecision = activateLocalFailureRecovery(baseConfig, repeatedState);
assert.equal(repeatedDecision.active, true, "a repeated failing mutation should activate recovery");
assert.equal(repeatedDecision.activated, true, "first recovery decision should be marked as newly activated");
assert.equal(repeatedDecision.model, "localllm-deep", "recovery should use the configured deep local model");
assert.equal(repeatedState.meta.localFailureRecovery.active, true, "recovery state was not persisted");

const recoveredConfig = applyLocalFailureRecovery(baseConfig, repeatedState);
assert.equal(recoveredConfig.provider, "localllm", "recovery crossed the provider boundary");
assert.equal(recoveredConfig.model, "localllm-deep", "recovery did not update the effective model");
assert.equal(recoveredConfig.localSelection, "runtime-tool-failure-recovery");
assert.equal(
  nextStepRuntimeConfig(baseConfig, repeatedState).model,
  "localllm-deep",
  "the agent step runtime ignored persisted recovery state"
);

const timeoutSupersededRecoveryState = structuredClone(repeatedState);
timeoutSupersededRecoveryState.meta.goalContract = {
  revision: 7,
  currentHash: "same-timeout-recovery-goal",
};
adoptModelTimeoutRecoveryState(
  timeoutSupersededRecoveryState,
  { ...baseConfig, model: "localllm-fast" },
  {
    provider: "localllm",
    model: "localllm-fast",
    previousModel: "localllm-deep",
    switchedModel: true,
  },
  5,
  "2026-08-26T15:03:29.703Z"
);
assert.equal(
  timeoutSupersededRecoveryState.meta.localFailureRecovery.model,
  "localllm-fast",
  "the timed-out deep recovery remained authoritative after a successful fast fallback"
);
assert.equal(
  timeoutSupersededRecoveryState.meta.localFailureRecovery.timeoutSupersededModel,
  "localllm-deep"
);
assert.equal(
  timeoutSupersededRecoveryState.meta.modelTimeoutRecovery.goalRevision,
  7,
  "the timeout route was not bound to the active goal revision"
);
assert.equal(
  nextStepRuntimeConfig(
    { ...baseConfig, model: "localllm-fast" },
    timeoutSupersededRecoveryState
  ).model,
  "localllm-fast",
  "an older local-failure recovery reclaimed the step after timeout recovery"
);

const legacyConcurrentRecoveryState = structuredClone(repeatedState);
legacyConcurrentRecoveryState.meta.goalContract = {
  revision: 7,
  currentHash: "same-timeout-recovery-goal",
};
legacyConcurrentRecoveryState.meta.localFailureRecovery.activatedAt =
  "2026-08-26T12:03:39.611Z";
legacyConcurrentRecoveryState.meta.modelTimeoutRecovery = {
  active: true,
  provider: "localllm",
  model: "localllm-fast",
  previousModel: "localllm-deep",
  activatedAt: "2026-08-26T15:03:29.703Z",
  step: 5,
};
assert.equal(
  applyLocalFailureRecovery(
    { ...baseConfig, model: "localllm-fast" },
    legacyConcurrentRecoveryState
  ).model,
  "localllm-fast",
  "a saved newer timeout route was overwritten by an older tool-failure recovery"
);
legacyConcurrentRecoveryState.meta.modelTimeoutRecovery.goalRevision = 6;
assert.equal(
  applyLocalFailureRecovery(
    { ...baseConfig, model: "localllm-fast" },
    legacyConcurrentRecoveryState
  ).model,
  "localllm-deep",
  "a timeout route from an older goal revision overrode the current recovery decision"
);

const persistedDecision = activateLocalFailureRecovery(baseConfig, repeatedState);
assert.equal(persistedDecision.active, true);
assert.equal(persistedDecision.activated, false, "persisted recovery should not announce twice");

const progressReset = decideLocalFailureRecovery(
  baseConfig,
  stateWithRecent([
    failed("run_command", "run:python analysis.py"),
    failed("run_command", "run:python analysis.py"),
    { toolName: "apply_patch", signature: "patch:fixed-function", ok: true, blocked: false },
    failed("run_command", "run:python analysis.py"),
  ])
);
assert.equal(progressReset.active, false, "a successful repair should reset stale failure evidence");

const variedFailures = decideLocalFailureRecovery(
  baseConfig,
  stateWithRecent([
    failed("run_command", "run:test-1"),
    failed("apply_patch", "patch:1"),
    failed("run_command", "run:test-2"),
    failed("apply_patch", "patch:2"),
  ])
);
assert.equal(variedFailures.active, true, "several distinct failed repairs should activate recovery");

const contractViolationRecovery = decideLocalFailureRecovery(
  baseConfig,
  { meta: { toolContractViolation: { count: 2, consecutive: 2, total: 2 } } }
);
assert.equal(contractViolationRecovery.active, true, "repeated invalid local tool schemas should activate recovery");
assert.equal(contractViolationRecovery.contractViolationCount, 2);
assert(contractViolationRecovery.failedTools.includes("tool_call_batch"));

const singleContractViolation = decideLocalFailureRecovery(
  baseConfig,
  { meta: { toolContractViolation: { count: 1, consecutive: 1, total: 1 } } }
);
assert.equal(singleContractViolation.active, false, "one invalid schema should retain the bounded same-model repair turn");

const blockedOnly = decideLocalFailureRecovery(
  baseConfig,
  stateWithRecent([
    failed("write_file", "write:protected", { blocked: true }),
    failed("write_file", "write:protected", { blocked: true }),
  ])
);
assert.equal(blockedOnly.active, false, "policy blocks should not be treated as model-quality failures");

const alreadyStrong = decideLocalFailureRecovery(
  { ...baseConfig, model: "localllm-deep" },
  stateWithRecent([
    failed("apply_patch", "patch:x"),
    failed("apply_patch", "patch:x"),
  ])
);
assert.equal(alreadyStrong.active, false, "an already-deep route should not oscillate models");

const repeatedSemanticTestState = {
  meta: {
    goalContract: { currentHash: "semantic-stall" },
    toolLoop: { recent: [] },
    projectVerification: {
      testRuns: [2, 3, 4].map((mutationRevision) => ({
        command: "scripts/test.sh",
        passed: false,
        failureSignature: "same-java-failure",
        mutationRevision,
      })),
    },
  },
};
const repeatedSemanticTestRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  repeatedSemanticTestState
);
assert.equal(
  repeatedSemanticTestRecovery.active,
  true,
  "repeated identical verifier failures across real mutations did not recover the local route"
);
assert.equal(repeatedSemanticTestRecovery.model, "localllm-code");
assert.equal(repeatedSemanticTestRecovery.semanticTestFailureCount, 3);
assert(repeatedSemanticTestRecovery.failedTools.includes("project_test"));

const variedSemanticTestState = {
  meta: {
    goalContract: { currentHash: "varied-java-goal" },
    toolLoop: { recent: [] },
    projectVerification: {
      testRuns: [1, 2, 3, 4].map((mutationRevision) => ({
        command: "scripts/test.sh",
        passed: false,
        failureSignature: `different-java-failure-${mutationRevision}`,
        mutationRevision,
      })),
    },
  },
};
const variedSemanticTestRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  variedSemanticTestState
);
assert.equal(
  variedSemanticTestRecovery.active,
  true,
  "varied failures from one verifier across four source revisions did not recover the local route"
);
assert.equal(variedSemanticTestRecovery.model, "localllm-code");
assert.equal(variedSemanticTestRecovery.semanticTestFailureCount, 1);
assert.equal(variedSemanticTestRecovery.semanticTestMutationFailureCount, 4);

const variedSemanticNoCodeRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep"],
  },
  variedSemanticTestState
);
assert.equal(variedSemanticNoCodeRecovery.active, false);
assert.equal(variedSemanticNoCodeRecovery.reason, "no-strong-local-recovery-model");
assert.equal(variedSemanticNoCodeRecovery.semanticTestMutationFailureCount, 4);

const repeatedAuthoritativeTestMutationState = stateWithRecent([
  failed("apply_patch", "test-write-1", {
    blocked: true,
    category: "failed-test-specification-mutation",
  }),
  failed("apply_patch", "test-write-2", {
    blocked: true,
    category: "failed-test-specification-mutation",
  }),
  failed("apply_patch", "test-write-3", {
    blocked: true,
    category: "failed-test-specification-mutation",
  }),
]);
const repeatedAuthoritativeTestMutationRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  repeatedAuthoritativeTestMutationState
);
assert.equal(repeatedAuthoritativeTestMutationRecovery.active, true);
assert.equal(repeatedAuthoritativeTestMutationRecovery.model, "localllm-code");
assert.equal(
  repeatedAuthoritativeTestMutationRecovery.blockedTestSpecificationMutationCount,
  3
);

const repeatedAuthoritativeTestMutationNoCodeRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep"],
  },
  repeatedAuthoritativeTestMutationState
);
assert.equal(repeatedAuthoritativeTestMutationNoCodeRecovery.active, false);
assert.equal(
  repeatedAuthoritativeTestMutationNoCodeRecovery.reason,
  "no-strong-local-recovery-model"
);
assert.equal(
  repeatedAuthoritativeTestMutationNoCodeRecovery.blockedTestSpecificationMutationCount,
  3
);

const automaticHandoffVariedState = structuredClone(variedSemanticTestState);
automaticHandoffVariedState.meta.providerHandoff = {
  status: "active",
  sourceProvider: "deepseek",
  sourceModel: "deepseek-v4-pro",
  sourceRoutingMode: "smart",
  targetProvider: "localllm",
  targetModel: "localllm-deep",
  failureCode: "provider_tool_contract",
};
const automaticHandoffRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    routingMode: "manual",
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  automaticHandoffVariedState
);
assert.equal(
  automaticHandoffRecovery.model,
  "localllm-code",
  "an automatic hosted-to-local handoff was mistaken for an operator-selected manual route"
);

const manualRoute = decideLocalFailureRecovery(
  { ...baseConfig, routingMode: "manual" },
  stateWithRecent([
    failed("apply_patch", "patch:x"),
    failed("apply_patch", "patch:x"),
  ])
);
assert.equal(manualRoute.active, false, "manual routing must remain authoritative");

const manualDeepContractRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    routingMode: "manual",
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  { meta: { toolContractViolation: { count: 2, consecutive: 2, total: 2 } } }
);
assert.equal(
  manualDeepContractRecovery.active,
  true,
  "two rejected schemas should permit a bounded same-provider recovery from a manual deep route"
);
assert.equal(
  manualDeepContractRecovery.model,
  "localllm-code",
  "manual deep schema recovery did not select the authenticated coding alias"
);

const manualDeepActivationState = {
  meta: { toolContractViolation: { count: 2, consecutive: 2, total: 2 } },
};
const manualDeepActivation = activateLocalFailureRecovery(
  {
    ...baseConfig,
    routingMode: "manual",
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  manualDeepActivationState
);
assert.equal(manualDeepActivation.model, "localllm-code");
assert.equal(
  manualDeepActivationState.meta.toolContractViolation.consecutive,
  0,
  "the newly selected recovery model inherited the prior model's exhausted contract window"
);
assert.equal(
  manualDeepActivationState.meta.toolContractViolation.resetReason,
  "local-model-recovery"
);

const manualDeepUnverifiedCode = decideLocalFailureRecovery(
  {
    ...baseConfig,
    routingMode: "manual",
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep"],
  },
  { meta: { toolContractViolation: { count: 2, consecutive: 2, total: 2 } } }
);
assert.equal(
  manualDeepUnverifiedCode.active,
  false,
  "manual recovery selected a coding alias absent from authenticated discovery"
);
assert.equal(manualDeepUnverifiedCode.reason, "no-strong-local-recovery-model");

const manualDeepSemanticPatchRecovery = decideLocalFailureRecovery(
  {
    ...baseConfig,
    routingMode: "manual",
    model: "localllm-deep",
    localCodeModel: "localllm-code",
    localAvailableModels: ["localllm-fast", "localllm-deep", "localllm-code"],
  },
  stateWithRecent([
    failed("apply_patch", "patch:proposal-a", {
      category: "patch-context-scope-mismatch",
      path: "service_ctl.py",
      goalRevision: 4,
      mutationRevision: 7,
    }),
    failed("apply_patch", "patch:proposal-b", {
      category: "patch-context-scope-mismatch",
      path: "service_ctl.py",
      goalRevision: 4,
      mutationRevision: 7,
    }),
  ])
);
assert.equal(
  manualDeepSemanticPatchRecovery.active,
  true,
  "semantic scope-mismatch repetition did not permit a bounded manual deep-to-code recovery"
);
assert.equal(manualDeepSemanticPatchRecovery.model, "localllm-code");
assert.equal(manualDeepSemanticPatchRecovery.repeatedSignatureCount, 2);
assert.equal(manualDeepSemanticPatchRecovery.semanticScopeMismatchCount, 2);

const hostedRoute = decideLocalFailureRecovery(
  { ...baseConfig, provider: "deepseek", model: "deepseek-v4-pro" },
  stateWithRecent([
    failed("apply_patch", "patch:x"),
    failed("apply_patch", "patch:x"),
  ])
);
assert.equal(hostedRoute.active, false, "local recovery must not cross into a hosted provider route");

const maxConfigured = activateLocalFailureRecovery(
  {
    ...baseConfig,
    mainModel: "localllm-max",
    spareModel: "localllm-max",
    localCodeFallbackModel: "localllm-deep",
  },
  stateWithRecent([
    failed("run_command", "run:bad"),
    failed("run_command", "run:bad"),
  ])
);
assert.equal(maxConfigured.model, "localllm-deep", "automatic failure recovery must not bypass Max resource policy");

const instruction = localFailureRecoveryInstruction(repeatedDecision);
assert.match(instruction, /preserve successful work/i);
assert.match(instruction, /Do not repeat the failing call/i);
assert.match(instruction, /rerun the smallest relevant verification/i);
const constrainedMutationInstruction = localFailureRecoveryInstruction(
  manualDeepContractRecovery,
  {
    testFailureRepairMutationRequired: true,
    requiredSymbolRepair: {
      contracts: [
        { symbol: "launch_service" },
        { symbol: "wait_until_healthy" },
      ],
    },
  }
);
assert.match(constrainedMutationInstruction, /requires one coherent source mutation before verification/i);
assert.match(constrainedMutationInstruction, /launch_service, wait_until_healthy/);
assert.match(constrainedMutationInstruction, /called outside its own definition/i);

const focusedRecoveryState = {
  goal: "Repair the service controller and pass the exact retained test.",
  chat: [
    { role: "user", content: "Repair the unreliable service controller without weakening tests." },
  ],
  messages: [
    { role: "system", content: "You are AgInTiFlow." },
    {
      role: "assistant",
      content:
        "STALE_REJECTED_PATCH: duplicate launch_service and wait_until_healthy definitions should be appended.",
    },
    { role: "user", content: "An obsolete source excerpt with stale mutation advice." },
  ],
  meta: {
    projectVerification: {
      mutationRevision: 4,
      testRuns: [{
        command: "python3 -m unittest discover -s tests -v",
        mutationRevision: 4,
        passed: false,
        failureSignature: "missing-service-seams",
        failureSummary: [
          'with mock.patch.object(service_ctl, "launch_service") as launch:',
          'with mock.patch.object(service_ctl, "wait_until_healthy", return_value=True):',
          "AssertionError: 2 != 0",
        ].join(" "),
      }],
    },
    failedTestRecoveryPacket: {
      packetVersion: 17,
      mutationRevision: 4,
      failureSignature: "missing-service-seams",
      paths: ["tests/test_service_ctl.py", "service_ctl.py"],
      content: [
        "Bounded failed-test evidence packet v17.",
        'with mock.patch.object(service_ctl, "launch_service") as launch:',
        'with mock.patch.object(service_ctl, "wait_until_healthy", return_value=True):',
        "### service_ctl.py",
        "def start_service():",
        "    return 2",
      ].join("\n"),
    },
    requiredSymbolRepair: {
      version: 1,
      owner: "service_ctl",
      symbol: "launch_service",
      path: "service_ctl.py",
      contracts: [
        { owner: "service_ctl", symbol: "launch_service", path: "service_ctl.py" },
        { owner: "service_ctl", symbol: "wait_until_healthy", path: "service_ctl.py" },
      ],
      mutationRevision: 4,
      failureSignature: "missing-service-seams",
      topologyRetry: {
        violations: [
          "launch_service: declared once but not called from production code outside its own definition",
        ],
      },
    },
  },
};
const focusedRecoveryMessages = buildFailedTestFocusedRecoveryMessages(
  focusedRecoveryState,
  { goal: focusedRecoveryState.goal },
  constrainedMutationInstruction
);
const focusedRecoveryText = focusedRecoveryMessages.map((item) => item.content).join("\n");
assert.equal(
  focusedRecoveryMessages.filter((item) => item.role === "assistant").length,
  0,
  "focused local recovery retained rejected assistant mutation proposals"
);
assert.doesNotMatch(focusedRecoveryText, /STALE_REJECTED_PATCH|obsolete source excerpt/);
assert.match(focusedRecoveryText, /Only the exact current evidence below is authoritative/i);
assert.match(
  focusedRecoveryText,
  /Required acceptance seams: service_ctl\.launch_service, service_ctl\.wait_until_healthy/
);
assert.match(focusedRecoveryText, /Bounded failed-test evidence packet v17/);
assert.match(focusedRecoveryText, /requires one coherent source mutation before verification/i);

const durablePatchArgs = {
  path: "service_ctl.py",
  search: "command = f'python gateway_service.py'",
  replace: "command = [sys.executable, 'gateway_service.py']",
};
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const durableMutation = {
  revision: 4,
  goalRevision: 7,
  taskHash: digest("Repair the sensor gateway lifecycle."),
  toolName: "apply_patch",
  paths: ["service_ctl.py"],
  patch: {
    path: "./service_ctl.py",
    searchHash: digest(durablePatchArgs.search),
    replaceHash: digest(durablePatchArgs.replace),
  },
};
const durablePatchState = {
  meta: {
    goalContract: {
      revision: 7,
      taskGoal: "Repair the sensor gateway lifecycle.",
      history: [
        {
          revision: 7,
          kind: "initial",
          hash: digest("Repair the sensor gateway lifecycle."),
        },
      ],
    },
    toolLoop: {
      recent: Array.from({ length: 20 }, (_, index) =>
        failed("apply_patch", `later-failure-${index}`)
      ),
      stagnationEpoch: 23,
    },
    projectVerification: {
      mutationRevision: 4,
      mutationHistory: [durableMutation],
    },
  },
};
assert.equal(
  repeatedSuccessfulMutationBlock(durablePatchState, "apply_patch", durablePatchArgs, {
    commandCwd: process.cwd(),
  })?.category,
  "repeated-successful-mutation",
  "a successful exact patch must remain blocked after it falls out of the short tool-loop window"
);
assert.equal(
  repeatedSuccessfulMutationBlock(
    {
      ...durablePatchState,
      meta: {
        ...durablePatchState.meta,
        goalContract: {
          revision: 8,
          taskGoal: "Repair the sensor gateway lifecycle.",
          history: [
            ...durablePatchState.meta.goalContract.history,
            {
              revision: 8,
              kind: "same-task-continuation",
              relation: "same-task",
              taskHash: digest("Repair the sensor gateway lifecycle."),
            },
          ],
        },
      },
    },
    "apply_patch",
    durablePatchArgs,
    { commandCwd: process.cwd() }
  )?.category,
  "repeated-successful-mutation",
  "a same-task continuation must not forget an earlier successful mutation"
);
assert.equal(
  repeatedSuccessfulMutationBlock(
    {
      ...durablePatchState,
      meta: {
        ...durablePatchState.meta,
        goalContract: {
          revision: 8,
          taskGoal: "Implement a separate service migration.",
          history: [
            ...durablePatchState.meta.goalContract.history,
            {
              revision: 8,
              kind: "continuation",
              relation: "new-request",
              taskHash: digest("Implement a separate service migration."),
            },
          ],
        },
      },
    },
    "apply_patch",
    durablePatchArgs,
    { commandCwd: process.cwd() }
  ),
  null,
  "a genuine new task boundary must not inherit an unrelated mutation block"
);
const sanitizedDurablePatchArgs = {
  ...durablePatchArgs,
  search: durablePatchArgs.search.slice(0, 20),
  replace: durablePatchArgs.replace.slice(0, 20),
  searchHash: digest(durablePatchArgs.search),
  replaceHash: digest(durablePatchArgs.replace),
};
assert.equal(
  repeatedSuccessfulMutationBlock(
    durablePatchState,
    "apply_patch",
    sanitizedDurablePatchArgs,
    { commandCwd: process.cwd() }
  )?.category,
  "repeated-successful-mutation",
  "redacted patch previews must use their retained full-content hashes for idempotency"
);
assert.equal(
  repeatedSuccessfulMutationBlock(
    {
      ...durablePatchState,
      meta: {
        ...durablePatchState.meta,
        projectVerification: {
          mutationRevision: 5,
          mutationHistory: [
            durableMutation,
            {
              revision: 5,
              goalRevision: 7,
              toolName: "write_file",
              paths: ["service_ctl.py"],
            },
          ],
        },
      },
    },
    "apply_patch",
    durablePatchArgs,
    { commandCwd: process.cwd() }
  ),
  null,
  "an intervening successful mutation must permit the same exact patch when source state changed"
);

const stalePatchRefreshState = {
  meta: {
    goalContract: {
      revision: 7,
      taskGoal: "Repair the sensor gateway lifecycle.",
      history: [
        {
          revision: 7,
          kind: "initial",
          taskHash: digest("Repair the sensor gateway lifecycle."),
        },
      ],
    },
    projectVerification: {
      mutationRevision: 4,
      testRuns: [
        {
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 4,
          passed: false,
          failureSignature: "gateway-failure",
        },
      ],
    },
    toolLoop: {
      stagnationEpoch: 23,
      recent: [
        {
          toolName: "apply_patch",
          path: "service_ctl.py",
          ok: false,
          blocked: true,
          category: "repeated-successful-mutation",
          stagnationEpoch: 23,
        },
      ],
    },
  },
};
const directIdempotencyRefresh = patchContextRefreshDecision(
  {
    meta: {
      goalContract: stalePatchRefreshState.meta.goalContract,
      projectVerification: stalePatchRefreshState.meta.projectVerification,
      toolLoop: { stagnationEpoch: 23, recent: [] },
    },
  },
  {
    toolName: "apply_patch",
    args: durablePatchArgs,
    ok: false,
    blocked: true,
    category: "repeated-successful-mutation",
    reason: "This exact patch already succeeded.",
  }
);
assert.equal(
  directIdempotencyRefresh?.triggerCategory,
  "repeated-successful-mutation",
  "an idempotency block did not immediately force a fresh exact-source read"
);
const stalePatchRefresh = patchContextRefreshDecision(stalePatchRefreshState, {
  toolName: "apply_patch",
  args: {
    path: "service_ctl.py",
    search: "def build_service_command():",
    replace: "def build_service_command():\n    return []",
  },
  ok: false,
  category: "workspace-patch",
  error: "Patch search text was not found in service_ctl.py.",
});
assert.equal(
  stalePatchRefresh?.path,
  "service_ctl.py",
  "a stale patch after an idempotency block did not require exact current-source refresh"
);
const firstMissingSearchRefresh = patchContextRefreshDecision(
  {
    meta: {
      goalContract: stalePatchRefreshState.meta.goalContract,
      projectVerification: stalePatchRefreshState.meta.projectVerification,
      toolLoop: { stagnationEpoch: 23, recent: [] },
    },
  },
  {
    toolName: "apply_patch",
    args: durablePatchArgs,
    ok: false,
    category: "workspace-patch",
    error: "Patch search text was not found in service_ctl.py.",
  }
);
assert.equal(
  firstMissingSearchRefresh?.stalePatchFailureCount,
  1,
  "the first exact-search mismatch did not immediately open one bounded current-source refresh"
);
const tracebackFirstRefreshState = structuredClone(stalePatchRefreshState);
const scopedArtifactPath =
  "output/webapp/agent/tasks/source-intake-audit/report.md";
const scopedArtifactRoot = path.join(
  repoRoot,
  "output/webapp/agent/tasks/source-intake-audit"
);
const scopedArtifactGoal = [
  "Correct and verify the exact source-intake audit report.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "task",
    request: "Correct and verify the exact source-intake audit report.",
    artifact_root: scopedArtifactRoot,
  })}`,
].join("\n");
const scopedArtifactRefreshState = {
  commandCwd: repoRoot,
  meta: {
    goalContract: {
      revision: 9,
      activeGoal: scopedArtifactGoal,
      taskGoal: scopedArtifactGoal,
      history: [],
    },
    projectVerification: {
      mutationRevision: 2,
      testRuns: [],
    },
    toolLoop: {
      stagnationEpoch: 4,
      recent: [],
    },
  },
};
const scopedArtifactRefresh = patchContextRefreshDecision(
  scopedArtifactRefreshState,
  {
    toolName: "apply_patch",
    args: {
      path: scopedArtifactPath,
      search: "Planned dynamic check: run the guarded document reader test.",
      replace: "Guarded document reader test: passed.",
    },
    ok: false,
    category: "workspace-patch",
    error: `Patch search text was not found in ${scopedArtifactPath}.`,
  }
);
assert.equal(
  scopedArtifactRefresh?.path,
  scopedArtifactPath,
  "a stale patch inside the exact scoped task artifact root was not recoverable"
);
scopedArtifactRefreshState.meta.toolLoop.patchContextRequired =
  scopedArtifactRefresh;
assert.equal(
  activePatchContextRefresh(scopedArtifactRefreshState)?.path,
  scopedArtifactPath,
  "the scoped task-artifact refresh marker was rejected as a generic output path"
);
assert.equal(
  nextStepRuntimeConfig(baseConfig, scopedArtifactRefreshState)
    .patchContextRefreshPath,
  scopedArtifactPath,
  "the scoped task-artifact refresh path did not reach the next constrained turn"
);
const scopedArtifactSource = [
  "# Source Intake Audit",
  "",
  "Document reader verification is pending.",
  "",
].join("\n");
assert.equal(
  consumePatchContextRefreshRead(scopedArtifactRefreshState, {
    toolName: "read_file",
    args: { path: scopedArtifactPath },
    result: { path: scopedArtifactPath },
    content: scopedArtifactSource,
    ok: true,
  })?.path,
  scopedArtifactPath,
  "an exact reread did not consume the scoped task-artifact refresh"
);
assert.equal(
  activePatchContextRepair(scopedArtifactRefreshState)?.path,
  scopedArtifactPath,
  "the scoped task-artifact reread did not leave a bounded repair anchor"
);
tracebackFirstRefreshState.meta.projectVerification.testRuns[0].failureSummary =
  'File "./service_ctl.py", line 139 -> return start_service(args.state_dir, args.host, args.port) parser = argparse.ArgumentParser()';
const tracebackFirstRefresh = patchContextRefreshDecision(tracebackFirstRefreshState, {
  toolName: "apply_patch",
  args: {
    path: "service_ctl.py",
    search: "def read_pid(pid_file: Path) -> int | None:\n    return None",
    replace: "def read_pid(pid_file: Path) -> int | None:\n    return None",
  },
  ok: false,
  category: "workspace-patch",
  error: "Patch search text was not found in service_ctl.py.",
});
assert.equal(
  tracebackFirstRefresh?.failedSearchPreview,
  "return start_service(args.state_dir, args.host, args.port) parser = argparse.ArgumentParser()",
  "stale patch text displaced the current failed-test traceback anchor"
);
assert.equal(
  tracebackFirstRefresh?.tracebackAnchorUsed,
  true,
  "traceback-first stale-patch recovery did not record its authoritative evidence"
);
const firstTopologyRefreshState = {
  meta: {
    goalContract: stalePatchRefreshState.meta.goalContract,
    projectVerification: {
      ...stalePatchRefreshState.meta.projectVerification,
      testRuns: [{
        command: "python3 -m unittest discover -s tests -v",
        mutationRevision: 4,
        passed: false,
        failureSignature: "topology-failure",
      }],
    },
    requiredSymbolRepair: {
      version: 1,
      owner: "service_ctl",
      symbol: "launch_service",
      path: "service_ctl.py",
      goalRevision: 8,
      mutationRevision: 4,
      failureSignature: "topology-failure",
      topologyRetry: {
        count: 1,
        violations: ["wait_until_healthy is not called from production code"],
      },
    },
    toolLoop: { stagnationEpoch: 23, recent: [] },
  },
};
const firstTopologyRefresh = patchContextRefreshDecision(firstTopologyRefreshState, {
  toolName: "apply_patch",
  args: durablePatchArgs,
  ok: false,
  blocked: true,
  category: "failed-test-required-symbol-topology",
  reason: "wait_until_healthy is declared but not called",
});
assert.equal(
  firstTopologyRefresh?.path,
  "service_ctl.py",
  "the first topology rejection did not open one exact canonical-source refresh"
);
assert.equal(
  firstTopologyRefresh?.triggerCategory,
  "required-symbol-topology",
  "the topology refresh lost its distinct recovery reason"
);
firstTopologyRefreshState.meta.toolLoop.patchContextRequired = firstTopologyRefresh;
assert.equal(
  consumePatchContextRefreshRead(firstTopologyRefreshState, {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
    ok: true,
  })?.triggerCategory,
  "required-symbol-topology",
  "the exact topology source read did not consume its bounded refresh"
);
const repeatedTopologyRefresh = patchContextRefreshDecision(
  {
    ...firstTopologyRefreshState,
    meta: {
      ...firstTopologyRefreshState.meta,
      requiredSymbolRepair: {
        ...firstTopologyRefreshState.meta.requiredSymbolRepair,
        topologyRetry: {
          ...firstTopologyRefreshState.meta.requiredSymbolRepair.topologyRetry,
          count: 2,
        },
      },
    },
  },
  {
    toolName: "apply_patch",
    args: durablePatchArgs,
    ok: false,
    blocked: true,
    category: "failed-test-required-symbol-topology",
    reason: "wait_until_healthy is still not called",
  }
);
assert.equal(
  repeatedTopologyRefresh,
  null,
  "repeated topology rejections reopened unbounded source discovery"
);
const repeatedMissingSearchRefresh = patchContextRefreshDecision(
  {
    meta: {
      goalContract: stalePatchRefreshState.meta.goalContract,
      projectVerification: stalePatchRefreshState.meta.projectVerification,
      toolLoop: {
        stagnationEpoch: 23,
        recent: [
          {
            toolName: "apply_patch",
            path: "service_ctl.py",
            ok: false,
            blocked: false,
            category: "workspace-patch",
            error: "Patch search text was not found in service_ctl.py.",
            stagnationEpoch: 23,
          },
        ],
      },
    },
  },
  {
    toolName: "apply_patch",
    args: {
      path: "service_ctl.py",
      search: "another stale source fragment",
      replace: "a replacement",
    },
    ok: false,
    category: "workspace-patch",
    error: "Patch search text was not found in service_ctl.py.",
  }
);
assert.equal(
  repeatedMissingSearchRefresh?.stalePatchFailureCount,
  2,
  "two stale patch searches on one unchanged file did not force a current-source refresh"
);
const anchoredPatchRefresh = {
  ...stalePatchRefresh,
  failedSearchPreview: [
    "def start_service(state_dir: Path, host: str, port: int) -> int:",
    "    pid_file = state_dir / \"gateway.pid\"",
  ].join("\n"),
};
stalePatchRefreshState.meta.toolLoop.patchContextRequired = anchoredPatchRefresh;
assert.equal(
  nextStepRuntimeConfig(baseConfig, stalePatchRefreshState).patchContextRefreshPath,
  "service_ctl.py",
  "the next-step runtime did not retain the exact stale-patch refresh path"
);
assert.equal(
  consumePatchContextRefreshRead(stalePatchRefreshState, {
    toolName: "read_file",
    args: { path: "other.py" },
    result: { path: "other.py" },
    ok: true,
  }),
  null,
  "reading a different file incorrectly cleared the stale-patch refresh gate"
);
assert.ok(
  activePatchContextRefresh(stalePatchRefreshState),
  "the stale-patch refresh gate disappeared before the exact source was read"
);
const refreshedServiceSource = [
  "from pathlib import Path",
  "",
  "def start_service(state_dir: Path, host: str, port: int) -> int:",
  "    state_dir.mkdir(parents=True, exist_ok=True)",
  "    pid_file = state_dir / \"gateway.pid\"",
  "    prior_pid = read_pid(pid_file)",
  "    if prior_pid and is_alive(prior_pid):",
  "        return 0",
  "    if prior_pid:",
  "        pid_file.unlink(missing_ok=True)",
  "    process = launch_service(host, port)",
  "    pid_file.write_text(str(process.pid), encoding=\"utf-8\")",
  "    return 0 if wait_until_healthy(process) else 1",
  "",
  "def status_service(state_dir: Path) -> int:",
  "    return 0",
  "",
].join("\n");
const directDerivedAnchor = derivePatchContextAnchor(
  refreshedServiceSource,
  anchoredPatchRefresh.failedSearchPreview
);
assert.equal(
  directDerivedAnchor?.anchorIdentity,
  "start_service",
  "the stale search did not resolve to the unique current function declaration"
);
assert.match(
  directDerivedAnchor?.search || "",
  /state_dir\.mkdir\(parents=True, exist_ok=True\)/,
  "the exact repair anchor did not preserve current source omitted by the stale patch"
);
assert.equal(
  consumePatchContextRefreshRead(stalePatchRefreshState, {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
    content: refreshedServiceSource,
    ok: true,
  })?.path,
  "service_ctl.py",
  "the exact current-source read did not consume the stale-patch refresh gate"
);
assert.equal(
  activePatchContextRefresh(stalePatchRefreshState),
  null,
  "the stale-patch refresh gate remained active after the exact source read"
);
const exactPatchRepair = activePatchContextRepair(stalePatchRefreshState);
assert.equal(
  exactPatchRepair?.anchorIdentity,
  "start_service",
  "the exact source refresh did not leave a revision-bound mutation anchor"
);
const driftedRepairAnchorState = structuredClone(stalePatchRefreshState);
driftedRepairAnchorState.meta.failedTestDiagnostic = {
  mutationRevision:
    driftedRepairAnchorState.meta.projectVerification.mutationRevision,
  failureSignature:
    driftedRepairAnchorState.meta.toolLoop.patchContextRepair.failureSignature,
  focuses: [
    {
      path: "service_ctl.py",
      directSearch: exactPatchRepair.search,
    },
  ],
};
driftedRepairAnchorState.meta.toolLoop.patchContextRepair.search = [
  "def unrelated_status_probe() -> int:",
  "    return 0",
  "",
].join("\n");
driftedRepairAnchorState.meta.toolLoop.patchContextRepair.searchHash =
  "drifted-anchor-hash";
assert.equal(
  activePatchContextRepair(driftedRepairAnchorState),
  null,
  "a repair reread escaped the current failed-test producer focus"
);
assert.equal(
  nextStepRuntimeConfig(baseConfig, stalePatchRefreshState).patchContextRepairSearchHash,
  exactPatchRepair?.searchHash,
  "the next-step runtime did not retain the exact refreshed patch anchor"
);
const normalizedNoOpBinding = bindPatchContextRepairArguments(
  stalePatchRefreshState,
  {
    path: "service_ctl.py",
    search: exactPatchRepair.search.trimEnd(),
    replace: exactPatchRepair.search.trimEnd(),
    expectedReplacements: 1,
  }
);
assert.equal(
  normalizedNoOpBinding?.args.search,
  exactPatchRepair.search,
  "the executor did not inject the revision-bound current-source anchor"
);
assert.equal(
  normalizedNoOpBinding?.noOp,
  true,
  "a whitespace-only provider reconstruction was not rejected as a no-op"
);
const materialRepairBinding = bindPatchContextRepairArguments(
  stalePatchRefreshState,
  {
    replace: exactPatchRepair.search.replace(
      "    return 0 if wait_until_healthy(process) else 1",
      [
        "    if wait_until_healthy(process):",
        "        return 0",
        "    process.terminate()",
        "    return 1",
      ].join("\n")
    ),
  }
);
assert.equal(
  materialRepairBinding?.args.path,
  "service_ctl.py",
  "the executor did not inject the revision-bound patch path"
);
assert.equal(
  materialRepairBinding?.args.expectedReplacements,
  1,
  "the executor did not enforce one exact replacement"
);
assert.equal(
  materialRepairBinding?.noOp,
  false,
  "a material provider-authored replacement was incorrectly rejected"
);
assert.equal(
  materialRepairBinding?.scopeIssue,
  null,
  "a focused provider-authored function replacement was rejected as whole-file drift"
);
const oversizedRepairBinding = bindPatchContextRepairArguments(
  stalePatchRefreshState,
  {
    replace: [
      "#!/usr/bin/env python3",
      "from __future__ import annotations",
      "",
      "def is_alive(pid: int) -> bool:",
      "    return True",
      "",
      exactPatchRepair.search.trimEnd(),
      "",
      "def status_service(state_dir: Path) -> int:",
      "    return 0",
      "",
    ].join("\n"),
  }
);
assert.match(
  oversizedRepairBinding?.scopeIssue?.reason || "",
  /exceeds the revision-bound source anchor/,
  "a reconstructed whole file was allowed inside a function-scoped repair anchor"
);
assert.deepEqual(
  oversizedRepairBinding?.scopeIssue?.unexpectedDeclarations,
  ["is_alive", "status_service"],
  "the scope guard did not identify declarations outside the function anchor"
);
const completeFileSource = [
  "#!/usr/bin/env python3",
  "from __future__ import annotations",
  "import subprocess",
  "",
  "def build_service_command(host: str, port: int) -> list[str]:",
  "    return ['python3', '-m', 'http.server', str(port), '--bind', host]",
  "",
  "def launch_service(host: str, port: int) -> subprocess.Popen:",
  "    return subprocess.Popen(build_service_command(host, port))",
  "",
  "def status_service() -> int:",
  "    return 0",
  "",
  "def stop_service() -> int:",
  "    return 0",
  "",
  "def main() -> int:",
  "    return status_service()",
  "",
].join("\n");
const catastrophicCompleteFileReplacement = [
  "def launch_service(host: str, port: int) -> subprocess.Popen:",
  "    return subprocess.Popen(build_service_command(host, port), start_new_session=True)",
  "",
].join("\n");
const completeFileCollapseIssue = patchContextReplacementScopeIssue(
  { anchorKind: "complete-file", search: completeFileSource },
  catastrophicCompleteFileReplacement
);
assert.match(
  completeFileCollapseIssue?.reason || "",
  /complete-file replacement is structurally incomplete/,
  "a complete-file recovery anchor allowed catastrophic module truncation"
);
assert(
  completeFileCollapseIssue?.missingDeclarations?.includes("build_service_command") &&
    completeFileCollapseIssue?.missingDeclarations?.includes("main"),
  "the complete-file guard did not report discarded production declarations"
);
const nestedImportOnlyReplacement = completeFileSource
  .split("\n")
  .filter((line) =>
    line !== "#!/usr/bin/env python3" &&
    line !== "from __future__ import annotations" &&
    line !== "import subprocess"
  )
  .join("\n")
  .replace(
    "def main() -> int:\n    return status_service()",
    "def main() -> int:\n    import argparse\n    return status_service()"
  );
const nestedImportPreambleIssue = patchContextReplacementScopeIssue(
  { anchorKind: "complete-file", search: completeFileSource },
  nestedImportOnlyReplacement
);
assert.equal(
  nestedImportPreambleIssue?.preambleDropped,
  true,
  "an indented function-local import was mistaken for a preserved module preamble"
);
const coherentCompleteFileReplacement = completeFileSource.replace(
  "return subprocess.Popen(build_service_command(host, port))",
  "return subprocess.Popen(build_service_command(host, port), start_new_session=True)"
);
assert.equal(
  patchContextReplacementScopeIssue(
    { anchorKind: "complete-file", search: completeFileSource },
    coherentCompleteFileReplacement
  ),
  null,
  "a coherent complete-file repair preserving module structure was rejected"
);
const scopeMismatchState = {
  meta: {
    goalContract: stalePatchRefreshState.meta.goalContract,
    projectVerification: {
      mutationRevision: 4,
      testRuns: [
        {
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 4,
          passed: false,
          failureSignature: "syntax-failure",
          failureSummary:
            'File "./service_ctl.py", line 18 -> return start_service(args.state_dir, args.host, args.port)def status_service(state_dir: Path) -> int:',
        },
      ],
    },
    toolLoop: { stagnationEpoch: 23, recent: [] },
  },
};
const scopeMismatchRefresh = patchContextRefreshDecision(scopeMismatchState, {
  toolName: "apply_patch",
  args: {
    path: "service_ctl.py",
    search: exactPatchRepair.search,
    replace: oversizedRepairBinding.args.replace,
  },
  ok: false,
  category: "patch-context-scope-mismatch",
});
assert.equal(
  scopeMismatchRefresh?.triggerCategory,
  "patch-context-scope-mismatch",
  "an oversized anchor replacement did not open bounded traceback recovery"
);
assert.equal(
  scopeMismatchRefresh?.failedSearchPreview,
  "return start_service(args.state_dir, args.host, args.port)def status_service(state_dir: Path) -> int:",
  "scope recovery stayed anchored to the stale function instead of the exact traceback line"
);
scopeMismatchState.meta.toolLoop.patchContextRequired = scopeMismatchRefresh;
const syntaxBrokenSource = [
  "def main() -> int:",
  "    args = parse_args()",
  "    stop_service(args.state_dir)",
  "    return start_service(args.state_dir, args.host, args.port)def status_service(state_dir: Path) -> int:",
  "    return 0",
  "",
  "def stop_service(state_dir: Path) -> int:",
  "    return 0",
  "",
].join("\n");
const consumedScopeRefresh = consumePatchContextRefreshRead(scopeMismatchState, {
  toolName: "read_file",
  args: { path: "service_ctl.py" },
  result: { path: "service_ctl.py" },
  content: syntaxBrokenSource,
  ok: true,
});
assert.equal(
  consumedScopeRefresh?.triggerCategory,
  "patch-context-scope-mismatch",
  "the traceback-bound exact source read was not consumed"
);
assert.match(
  activePatchContextRepair(scopeMismatchState)?.search || "",
  /args\.port\)def status_service/,
  "scope recovery did not derive a new anchor around the actual syntax failure"
);
assert.equal(
  activePatchContextRepair(scopeMismatchState)?.anchorKind,
  "containing-declaration",
  "a syntax-line refresh did not expand to its complete containing declaration"
);
assert.equal(
  activePatchContextRepair(scopeMismatchState)?.anchorIdentity,
  "main",
  "a syntax-line refresh lost the identity of its containing declaration"
);
const noTargetTracebackScopeState = {
  meta: {
    goalContract: stalePatchRefreshState.meta.goalContract,
    projectVerification: {
      mutationRevision: 4,
      testRuns: [
        {
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 4,
          passed: false,
          failureSignature: "missing-symbol-failure",
          failureSummary:
            'File "./tests/test_service_ctl.py", line 22 -> command = service_ctl.build_service_command("127.0.0.1", 8765)',
        },
      ],
    },
    toolLoop: { stagnationEpoch: 23, recent: [] },
  },
};
const noTargetTracebackScopeRefresh = patchContextRefreshDecision(
  noTargetTracebackScopeState,
  {
    toolName: "apply_patch",
    args: {
      path: "service_ctl.py",
      search: "def read_pid(pid_file: Path) -> int | None:\n    return None",
      replace: "def main() -> int:\n    return 0",
    },
    ok: false,
    category: "patch-context-scope-mismatch",
  }
);
assert.equal(
  noTargetTracebackScopeRefresh?.failedSearchPreview,
  "",
  "scope mismatch without a target traceback reused the already-invalid patch scope"
);
assert.equal(
  noTargetTracebackScopeRefresh?.completeFileFallback,
  true,
  "scope mismatch without a target traceback did not request a bounded complete-file repair"
);
noTargetTracebackScopeState.meta.toolLoop.patchContextRequired =
  noTargetTracebackScopeRefresh;
consumePatchContextRefreshRead(noTargetTracebackScopeState, {
  toolName: "read_file",
  args: { path: "service_ctl.py" },
  result: { path: "service_ctl.py" },
  content: refreshedServiceSource,
  ok: true,
});
assert.equal(
  activePatchContextRepair(noTargetTracebackScopeState)?.anchorKind,
  "complete-file",
  "small-source scope recovery without a target traceback did not bind the exact complete file"
);
const requestedStartServiceSearch = refreshedServiceSource.slice(
  refreshedServiceSource.indexOf("def start_service"),
  refreshedServiceSource.indexOf("def status_service")
);
const boundedCompleteFileRepair = bindPatchContextRepairArguments(
  noTargetTracebackScopeState,
  {
    path: "service_ctl.py",
    search: requestedStartServiceSearch,
    replace: requestedStartServiceSearch.replace(
      "    return 0 if wait_until_healthy(process) else 1",
      [
        "    if wait_until_healthy(process):",
        "        return 0",
        "    process.terminate()",
        "    return 1",
      ].join("\n")
    ),
  }
);
assert.equal(
  boundedCompleteFileRepair?.boundedRequestedSubrange,
  true,
  "a unique provider-authored subrange was not preserved inside a complete-file revision anchor"
);
assert.equal(
  boundedCompleteFileRepair?.args.search,
  requestedStartServiceSearch,
  "the complete-file guard expanded a safe unique subrange back into a destructive whole-file patch"
);
assert.equal(
  boundedCompleteFileRepair?.scopeIssue,
  null,
  "a structurally coherent unique subrange repair was rejected by the complete-file scope guard"
);
assert.equal(
  consumePatchContextRepairMutation(noTargetTracebackScopeState, {
    toolName: "apply_patch",
    path: "service_ctl.py",
    args: {
      path: "service_ctl.py",
      searchHash: boundedCompleteFileRepair.marker.searchHash,
    },
    ok: true,
  })?.boundedRequestedSubrange,
  true,
  "a successful bounded subrange repair did not consume its original complete-file anchor"
);
assert.equal(
  activePatchContextRepair(noTargetTracebackScopeState),
  null,
  "a consumed bounded subrange repair left a stale complete-file anchor active"
);
const repairReadState = structuredClone(stalePatchRefreshState);
repairReadState.meta.projectVerification.testRuns[0].failureSummary =
  'File "./service_ctl.py", line 4 -> return start_service(args.state_dir, args.host, args.port)def status_service(state_dir: Path) -> int:';
const consumedRepairRead = consumePatchContextRepairRead(repairReadState, {
  toolName: "read_file",
  args: { path: "service_ctl.py" },
  result: { path: "service_ctl.py" },
  content: syntaxBrokenSource,
  ok: true,
});
assert.equal(
  consumedRepairRead?.tracebackAnchorUsed,
  true,
  "one bounded repair reread did not prefer the exact traceback source line"
);
assert.equal(
  activePatchContextRepair(repairReadState)?.repairReadCount,
  1,
  "the bounded repair reread did not close further source rereads"
);
assert.equal(
  consumePatchContextRepairRead(repairReadState, {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
    content: syntaxBrokenSource,
    ok: true,
  }),
  null,
  "the patch-context repair allowed an unbounded second reread"
);
const supersededRepairReadState = structuredClone(stalePatchRefreshState);
supersededRepairReadState.meta.toolLoop.patchContextRequired = {
  ...scopeMismatchRefresh,
  mutationRevision:
    supersededRepairReadState.meta.projectVerification.mutationRevision,
};
const supersededRepairRead = consumePatchContextRepairRead(
  supersededRepairReadState,
  {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
    content: syntaxBrokenSource,
    ok: true,
  }
);
assert.equal(
  supersededRepairRead,
  null,
  "one source read consumed a stale repair marker while a newer refresh was pending"
);
const supersedingRefreshRead = consumePatchContextRefreshRead(
  supersededRepairReadState,
  {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
    content: syntaxBrokenSource,
    ok: true,
  }
);
assert.equal(
  supersedingRefreshRead?.triggerCategory,
  "patch-context-scope-mismatch",
  "the newer mandatory refresh was not consumed after suppressing stale repair state"
);
assert.equal(
  consumePatchContextRepairMutation(stalePatchRefreshState, {
    toolName: "apply_patch",
    args: { path: "service_ctl.py", searchHash: "wrong" },
    ok: true,
  }),
  null,
  "an unrelated successful patch incorrectly consumed the exact repair anchor"
);
assert.equal(
  consumePatchContextRepairMutation(stalePatchRefreshState, {
    toolName: "apply_patch",
    args: {
      path: "service_ctl.py",
      searchHash: exactPatchRepair.searchHash,
    },
    ok: true,
  })?.searchHash,
  exactPatchRepair.searchHash,
  "the exact successful repair did not consume its revision-bound anchor"
);
assert.equal(
  activePatchContextRepair(stalePatchRefreshState),
  null,
  "the exact repair anchor remained active after its successful mutation"
);

const missingSymbolFailureSummary = [
  "Failing tests: test_stale_pid_is_removed_before_start.",
  'Traceback context: File "./tests/test_service_ctl.py", line 33, in test_stale_pid_is_removed_before_start',
  '-> with mock.patch.object(service_ctl, "launch_service") as launch:',
  '| File "/usr/lib/python3.12/unittest/mock.py", line 1431, in get_original -> raise AttributeError(',
].join(" ");
assert.deepEqual(
  failedTestRequiredSymbolContracts(missingSymbolFailureSummary),
  [
    {
      kind: "python-patch-object",
      owner: "service_ctl",
      symbol: "launch_service",
    },
  ],
  "the failed-test diagnostic did not recover the required mockable implementation seam"
);
const requiredSymbolState = {
  meta: {
    goalContract: stalePatchRefreshState.meta.goalContract,
    projectVerification: {
      mutationRevision: 4,
      testRuns: [
        {
          command: "python3 -m unittest discover -s tests -v",
          mutationRevision: 4,
          passed: false,
          failureSignature: "missing-launch-service",
          failureSummary: missingSymbolFailureSummary,
        },
      ],
    },
    failedTestRecoveryPacket: {
      paths: ["tests/test_service_ctl.py", "service_ctl.py"],
    },
    toolLoop: { stagnationEpoch: 23, recent: [] },
  },
};
const requiredSymbolRepair = requiredSymbolAbsenceDecision(requiredSymbolState, {
  toolName: "search_files",
  args: { query: "def launch_service", path: "." },
  query: "def launch_service",
  path: ".",
  results: [],
  ok: true,
  blocked: false,
});
assert.equal(
  currentRequiredSymbolRepair(requiredSymbolState)?.path,
  "service_ctl.py",
  "the retained acceptance-test seam did not constrain repair before another failed mutation"
);
assert.equal(
  requiredSymbolRepair?.path,
  "service_ctl.py",
  "an exact zero-result symbol search did not identify the canonical implementation source"
);
requiredSymbolState.meta.requiredSymbolRepair = requiredSymbolRepair;
assert.equal(
  activeRequiredSymbolRepair(requiredSymbolState)?.symbol,
  "launch_service",
  "the missing-symbol repair contract was not retained for the next mutation turn"
);
assert.equal(
  nextStepRuntimeConfig(baseConfig, requiredSymbolState)
    .testFailureRequiredSymbolRepair?.symbol,
  "launch_service",
  "the next-step runtime dropped the retained missing-symbol repair contract"
);

function assistant(content, toolCalls = []) {
  return {
    choices: [{ message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-local-failure-recovery-"));
try {
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "recovered-result.txt"), "stale\n", "utf8");
  const requests = [];
  const responses = [
    assistant("", [toolCall("fail-write-1", "write_file", {
      path: "recovered-result.txt",
      mode: "create",
      content: "incorrect create attempt\n",
    })]),
    assistant("", [toolCall("fail-write-2", "write_file", {
      path: "recovered-result.txt",
      mode: "create",
      content: "incorrect create attempt two\n",
    })]),
    assistant("", [toolCall("fail-write-3", "write_file", {
      path: "recovered-result.txt",
      mode: "create",
      content: "incorrect create attempt three\n",
    })]),
    assistant("", [toolCall("fail-write-4", "write_file", {
      path: "recovered-result.txt",
      mode: "create",
      content: "incorrect create attempt four\n",
    })]),
    (payload) => {
      const offered = new Set(
        (payload.tools || [])
          .map((tool) => String(tool?.function?.name || ""))
          .filter(Boolean)
      );
      if (offered.has("write_file")) {
        return assistant("", [toolCall("create-result", "write_file", {
          path: "recovered-result-new.txt",
          mode: "create",
          content: "recovered by the stronger local route\n",
        })]);
      }
      assert(offered.has("apply_patch"), "stronger local route offered no focused mutation tool");
      return assistant("", [toolCall("patch-result", "apply_patch", {
        patch: "*** Begin Patch\n*** Add File: recovered-result-new.txt\n+recovered by the stronger local route\n*** End Patch",
      })]);
    },
    assistant("", [toolCall("read-result", "read_file", {
      path: "recovered-result-new.txt",
      startLine: 1,
      lineLimit: 20,
    })]),
    assistant("", [toolCall("finish-result", "finish", {
      result: "Created and verified recovered-result-new.txt after changing the stalled local route.",
    })]),
  ];
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          const responseFactory = responses.shift();
          const response = typeof responseFactory === "function"
            ? responseFactory(payload)
            : responseFactory;
          assert(response, `Unexpected local recovery model call ${requests.length}.`);
          return response;
        },
      },
    },
  };
  const clientFactory = async () => client;
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig(
    {
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      goal: "Create recovered-result-new.txt with the requested recovery text, then verify the new file.",
      taskProfile: "auto",
      allowShellTool: true,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: workspace,
      dynamicSteps: "off",
      progressiveTools: false,
      maxSteps: 10,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      routeProvider: "localllm",
      routeModel: "localllm-fast",
      mainProvider: "localllm",
      mainModel: "localllm-deep",
      spareProvider: "localllm",
      spareModel: "localllm-deep",
      sessionId: "local-failure-recovery-integration",
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: true,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-local-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: true,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    dynamicSteps: "off",
    progressiveTools: false,
    maxSteps: 10,
    modelTimeoutMs: 1_000,
  });

  const result = await runAgent(config);
  const store = new SessionStore(sessionsDir, "local-failure-recovery-integration", {
    projectRoot: workspace,
    commandCwd: workspace,
    projectSessionsDir,
  });
  const events = await store.loadEvents();
  const state = await store.loadState();
  assert.equal(
    result.stopped,
    undefined,
    `integrated recovery run stopped instead of finishing; offered tools by turn: ${JSON.stringify(
      requests.map((payload) =>
        (payload.tools || []).map((tool) => String(tool?.function?.name || ""))
      )
    )}`
  );
  assert.deepEqual(
    requests.map((payload) => payload.model),
    [
      "localllm-fast",
      "localllm-fast",
      "localllm-fast",
      "localllm-deep",
      "localllm-deep",
      "localllm-deep",
      "localllm-deep",
    ],
    "the live agent loop did not move subsequent requests onto the deep local model"
  );
  assert.equal(await fs.readFile(path.join(workspace, "recovered-result-new.txt"), "utf8"), "recovered by the stronger local route\n");
  assert.equal(
    events.filter((event) => event.type === "provider.local_failure_recovery").length,
    1,
    "recovery activation should be recorded exactly once"
  );
  assert.equal(state.model, "localllm-deep", "recovered model was not saved in durable session state");
  assert.equal(state.meta.runtimeConfig.model, "localllm-deep", "recovered model was not saved in runtime config");

  const malformedWorkspace = path.join(tempRoot, "malformed-workspace");
  const malformedProjectSessionsDir = path.join(malformedWorkspace, ".aginti-sessions");
  await fs.mkdir(malformedWorkspace, { recursive: true });
  const malformedRequests = [];
  let malformedCall = 0;
  const malformedClientFactory = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          malformedRequests.push(payload);
          malformedCall += 1;
          if (malformedCall <= 2) {
            throw new Error(
              '500 llama-server returned invalid tool call arguments for "write_file": unexpected end of JSON input'
            );
          }
          if (malformedCall === 3) {
            return assistant(
              '[TOOL_CALLS]write_file[ARGS]{"path":"malformed-recovered.txt","mode":"create","content":"recovered through bounded text fallback\\n"}'
            );
          }
          if (malformedCall === 4) {
            return assistant("", [toolCall("read-malformed-result", "read_file", {
              path: "malformed-recovered.txt",
              startLine: 1,
              lineLimit: 20,
            })]);
          }
          if (malformedCall === 5) {
            return assistant("", [toolCall("finish-malformed-result", "finish", {
              result: "Created and verified malformed-recovered.txt after bounded malformed-response recovery.",
            })]);
          }
          assert.fail(`Unexpected malformed-response recovery model call ${malformedCall}.`);
        },
      },
    },
  });
  malformedClientFactory.agintiDeterministicTest = true;
  const malformedConfig = resolveRuntimeConfig(
    {
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "manual",
      goal: "Create malformed-recovered.txt, verify its exact content, and finish.",
      taskProfile: "code",
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: malformedWorkspace,
      dynamicSteps: "off",
      maxSteps: 6,
    },
    {
      baseDir: malformedWorkspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "manual",
      sessionId: "local-malformed-tool-response-integration",
      commandCwd: malformedWorkspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      clientFactory: malformedClientFactory,
    }
  );
  Object.assign(malformedConfig, {
    apiKey: "deterministic-local-test",
    clientFactory: malformedClientFactory,
    providerReadinessMode: "deterministic-test",
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Focused malformed provider response recovery smoke.",
    },
    sessionsDir,
    projectSessionsDir: malformedProjectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: false,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1_000,
  });

  const malformedResult = await runAgent(malformedConfig);
  const malformedStore = new SessionStore(
    sessionsDir,
    "local-malformed-tool-response-integration",
    {
      projectRoot: malformedWorkspace,
      commandCwd: malformedWorkspace,
      projectSessionsDir: malformedProjectSessionsDir,
    }
  );
  const malformedEvents = await malformedStore.loadEvents();
  assert.equal(malformedResult.stopped, undefined, "malformed provider response recovery stopped instead of finishing");
  assert.equal(malformedRequests.length, 5, "malformed provider response recovery used an unbounded request loop");
  assert(Array.isArray(malformedRequests[0].tools), "the first malformed request did not use native tools");
  assert.equal(malformedRequests[1].tools, undefined, "the immediate compatibility fallback retained native tools");
  assert.equal(malformedRequests[2].tools, undefined, "the agent-loop retry did not force the text-tool protocol");
  assert.match(
    malformedRequests[2].messages.map((message) => String(message?.content || "")).join("\n"),
    /no action was dispatched[\s\S]*exactly one complete/iu,
    "the bounded agent-loop retry omitted its non-replay and complete-call contract"
  );
  assert.equal(
    malformedEvents.filter((event) => event.type === "model.malformed_tool_response").length,
    1,
    "the provider failure was not recorded exactly once"
  );
  assert.equal(
    await fs.readFile(path.join(malformedWorkspace, "malformed-recovered.txt"), "utf8"),
    "recovered through bounded text fallback\n"
  );

  const contextTimeoutWorkspace = path.join(tempRoot, "context-timeout-workspace");
  const contextTimeoutProjectSessionsDir = path.join(
    contextTimeoutWorkspace,
    ".aginti-sessions"
  );
  await fs.mkdir(contextTimeoutWorkspace, { recursive: true });
  const contextTimeoutRequests = [];
  let contextTimeoutCall = 0;
  const contextTimeoutClientFactory = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          contextTimeoutRequests.push(payload);
          contextTimeoutCall += 1;
          if (contextTimeoutCall === 1) {
            const error = new Error("Local request exceeds the configured context window.");
            error.name = "LocalContextBudgetError";
            error.code = "LOCALLLM_CONTEXT_BUDGET_EXCEEDED";
            throw error;
          }
          if (contextTimeoutCall === 2) {
            const error = new Error("agent step request timed out after 1000ms");
            error.name = "ModelTimeoutError";
            throw error;
          }
          if (contextTimeoutCall === 3) {
            return assistant("", [toolCall("write-after-timeout", "write_file", {
              path: "context-timeout-recovered.txt",
              mode: "create",
              content: "recovered after compacted retry timeout\n",
            })]);
          }
          if (contextTimeoutCall === 4) {
            return assistant("", [toolCall("read-after-timeout", "read_file", {
              path: "context-timeout-recovered.txt",
              startLine: 1,
              lineLimit: 20,
            })]);
          }
          if (contextTimeoutCall === 5) {
            return assistant("", [toolCall("finish-after-timeout", "finish", {
              result: "Created and verified context-timeout-recovered.txt after nested local recovery.",
            })]);
          }
          assert.fail(`Unexpected context-timeout recovery model call ${contextTimeoutCall}.`);
        },
      },
    },
  });
  contextTimeoutClientFactory.agintiDeterministicTest = true;
  const contextTimeoutConfig = resolveRuntimeConfig(
    {
      provider: "localllm",
      model: "localllm-deep",
      routingMode: "manual",
      goal: "Create context-timeout-recovered.txt, verify its exact content, and finish.",
      taskProfile: "code",
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: contextTimeoutWorkspace,
      dynamicSteps: "off",
      maxSteps: 6,
    },
    {
      baseDir: contextTimeoutWorkspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-deep",
      routingMode: "manual",
      sessionId: "local-context-timeout-recovery-integration",
      commandCwd: contextTimeoutWorkspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      clientFactory: contextTimeoutClientFactory,
    }
  );
  Object.assign(contextTimeoutConfig, {
    apiKey: "deterministic-local-test",
    clientFactory: contextTimeoutClientFactory,
    providerReadinessMode: "deterministic-test",
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Focused nested local timeout-recovery smoke.",
    },
    sessionsDir,
    projectSessionsDir: contextTimeoutProjectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: false,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1_000,
  });

  const contextTimeoutResult = await runAgent(contextTimeoutConfig);
  const contextTimeoutStore = new SessionStore(
    sessionsDir,
    "local-context-timeout-recovery-integration",
    {
      projectRoot: contextTimeoutWorkspace,
      commandCwd: contextTimeoutWorkspace,
      projectSessionsDir: contextTimeoutProjectSessionsDir,
    }
  );
  const contextTimeoutEvents = await contextTimeoutStore.loadEvents();
  const contextTimeoutState = await contextTimeoutStore.loadState();
  assert.equal(
    contextTimeoutResult.stopped,
    undefined,
    "a timeout after local context compaction stopped instead of recovering"
  );
  assert.deepEqual(
    contextTimeoutRequests.map((payload) => payload.model),
    ["localllm-deep", "localllm-deep", "localllm-fast", "localllm-fast", "localllm-fast"],
    "nested local timeout recovery did not switch and retain the fast in-provider route"
  );
  assert(
    Number(contextTimeoutRequests[2]?.max_tokens || 0) <= 4096,
    "nested local timeout recovery retained an unbounded output envelope"
  );
  assert.equal(
    contextTimeoutEvents.filter((event) => event.type === "history.compacted_for_local_context_retry").length,
    1,
    "local context recovery was not recorded exactly once"
  );
  assert.equal(
    contextTimeoutEvents.filter((event) => event.type === "model.timeout").length,
    1,
    "the nested model timeout was not recorded exactly once"
  );
  assert.equal(
    contextTimeoutEvents.filter((event) => event.type === "model.timeout_route_adopted").length,
    1,
    "the successful nested timeout route was not adopted"
  );
  assert.equal(
    contextTimeoutState.model,
    "localllm-fast",
    "the nested timeout recovery model was not saved in durable session state"
  );
  assert.equal(
    await fs.readFile(
      path.join(contextTimeoutWorkspace, "context-timeout-recovered.txt"),
      "utf8"
    ),
    "recovered after compacted retry timeout\n"
  );

  const timeoutExhaustionWorkspace = path.join(
    tempRoot,
    "timeout-exhaustion-workspace"
  );
  const timeoutExhaustionProjectSessionsDir = path.join(
    timeoutExhaustionWorkspace,
    ".aginti-sessions"
  );
  await fs.mkdir(timeoutExhaustionWorkspace, { recursive: true });
  const timeoutExhaustionRequests = [];
  let timeoutExhaustionCall = 0;
  const timeoutExhaustionClientFactory = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          timeoutExhaustionRequests.push(payload);
          timeoutExhaustionCall += 1;
          if (timeoutExhaustionCall <= 2) {
            const error = new Error("agent step request timed out after 1000ms");
            error.name = "ModelTimeoutError";
            throw error;
          }
          if (timeoutExhaustionCall === 3) {
            return assistant("", [toolCall("write-after-escalation", "write_file", {
              path: "timeout-escalation-recovered.txt",
              mode: "create",
              content: "recovered on the stronger local route\n",
            })]);
          }
          if (timeoutExhaustionCall === 4) {
            return assistant("", [toolCall("read-after-escalation", "read_file", {
              path: "timeout-escalation-recovered.txt",
              startLine: 1,
              lineLimit: 20,
            })]);
          }
          if (timeoutExhaustionCall === 5) {
            return assistant("", [toolCall("finish-after-escalation", "finish", {
              result: "Created and verified timeout-escalation-recovered.txt after bounded model escalation.",
            })]);
          }
          assert.fail(`Unexpected timeout-exhaustion recovery model call ${timeoutExhaustionCall}.`);
        },
      },
    },
  });
  timeoutExhaustionClientFactory.agintiDeterministicTest = true;
  const timeoutExhaustionConfig = resolveRuntimeConfig(
    {
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "manual",
      goal: "Create timeout-escalation-recovered.txt, verify its exact content, and finish.",
      taskProfile: "code",
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: timeoutExhaustionWorkspace,
      dynamicSteps: "off",
      maxSteps: 6,
    },
    {
      baseDir: timeoutExhaustionWorkspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "manual",
      sessionId: "local-timeout-exhaustion-recovery-integration",
      commandCwd: timeoutExhaustionWorkspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      clientFactory: timeoutExhaustionClientFactory,
    }
  );
  Object.assign(timeoutExhaustionConfig, {
    apiKey: "deterministic-local-test",
    clientFactory: timeoutExhaustionClientFactory,
    providerReadinessMode: "deterministic-test",
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Focused exhausted local timeout recovery smoke.",
    },
    sessionsDir,
    projectSessionsDir: timeoutExhaustionProjectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: false,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1_000,
    mainProvider: "localllm",
    mainModel: "localllm-deep",
    localCodeFallbackModel: "localllm-deep",
    localAvailableModels: ["localllm-fast", "localllm-deep"],
  });

  const timeoutExhaustionResult = await runAgent(timeoutExhaustionConfig);
  const timeoutExhaustionStore = new SessionStore(
    sessionsDir,
    "local-timeout-exhaustion-recovery-integration",
    {
      projectRoot: timeoutExhaustionWorkspace,
      commandCwd: timeoutExhaustionWorkspace,
      projectSessionsDir: timeoutExhaustionProjectSessionsDir,
    }
  );
  const timeoutExhaustionEvents = await timeoutExhaustionStore.loadEvents();
  const timeoutExhaustionState = await timeoutExhaustionStore.loadState();
  assert.equal(
    timeoutExhaustionResult.stopped,
    undefined,
    "exhausted fast-route timeout recovery stopped instead of escalating once"
  );
  assert.deepEqual(
    timeoutExhaustionRequests.map((payload) => payload.model),
    [
      "localllm-fast",
      "localllm-fast",
      "localllm-deep",
      "localllm-deep",
      "localllm-deep",
    ],
    "exhausted fast-route recovery did not adopt and retain the stronger local route"
  );
  assert.equal(
    timeoutExhaustionEvents.filter((event) => event.type === "model.timeout_retry_exhausted").length,
    1,
    "the exhausted fast route was not recorded exactly once"
  );
  assert.equal(
    timeoutExhaustionEvents.filter((event) => event.type === "model.timeout_escalation_requested").length,
    1,
    "the stronger local route was not requested exactly once"
  );
  assert.equal(
    timeoutExhaustionEvents.filter((event) => event.type === "model.timeout_route_adopted").length,
    1,
    "the successful stronger local route was not adopted exactly once"
  );
  assert.equal(
    timeoutExhaustionState.model,
    "localllm-deep",
    "the stronger local timeout recovery model was not saved in durable session state"
  );
  assert.equal(
    await fs.readFile(
      path.join(timeoutExhaustionWorkspace, "timeout-escalation-recovered.txt"),
      "utf8"
    ),
    "recovered on the stronger local route\n"
  );

  const contractWorkspace = path.join(tempRoot, "contract-workspace");
  const contractProjectSessionsDir = path.join(contractWorkspace, ".aginti-sessions");
  await fs.mkdir(contractWorkspace, { recursive: true });
  const contractRequests = [];
  const contractResponses = [
    assistant("", [toolCall("invalid-contract-1", "write_file", {
      path: "contract-recovered.txt",
      mode: "create",
      content: "must not dispatch\n",
      dryRun: false,
    })]),
    assistant("", [toolCall("invalid-contract-2", "write_file", {
      path: "contract-recovered.txt",
      mode: "create",
      content: "must not dispatch either\n",
      dryRun: false,
    })]),
    assistant("", [toolCall("valid-contract-write", "write_file", {
      path: "contract-recovered.txt",
      mode: "create",
      content: "recovered after schema violations\n",
    })]),
    assistant("", [toolCall("valid-contract-read", "read_file", {
      path: "contract-recovered.txt",
      startLine: 1,
      lineLimit: 20,
    })]),
    assistant("", [toolCall("valid-contract-finish", "finish", {
      result: "Created and verified contract-recovered.txt after local tool-contract recovery.",
    })]),
  ];
  const contractClientFactory = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          contractRequests.push(payload);
          const response = contractResponses.shift();
          assert(response, `Unexpected tool-contract recovery model call ${contractRequests.length}.`);
          return response;
        },
      },
    },
  });
  contractClientFactory.agintiDeterministicTest = true;
  const contractConfig = resolveRuntimeConfig(
    {
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      goal: "Create contract-recovered.txt, verify its exact content, and finish.",
      taskProfile: "code",
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: contractWorkspace,
      dynamicSteps: "off",
      maxSteps: 7,
    },
    {
      baseDir: contractWorkspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      routeProvider: "localllm",
      routeModel: "localllm-fast",
      mainProvider: "localllm",
      mainModel: "localllm-deep",
      spareProvider: "localllm",
      spareModel: "localllm-deep",
      sessionId: "local-tool-contract-recovery-integration",
      commandCwd: contractWorkspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      clientFactory: contractClientFactory,
    }
  );
  Object.assign(contractConfig, {
    apiKey: "deterministic-local-test",
    clientFactory: contractClientFactory,
    providerReadinessMode: "deterministic-test",
    provider: "localllm",
    model: "localllm-fast",
    routingMode: "smart",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
    mainProvider: "localllm",
    mainModel: "localllm-deep",
    spareProvider: "localllm",
    spareModel: "localllm-deep",
    routeComplexityScore: 0,
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Focused deterministic local contract-recovery smoke.",
    },
    sessionsDir,
    projectSessionsDir: contractProjectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: false,
    allowFileTools: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    dynamicSteps: "off",
    maxSteps: 7,
    modelTimeoutMs: 1_000,
  });

  const contractResult = await runAgent(contractConfig);
  const contractStore = new SessionStore(sessionsDir, "local-tool-contract-recovery-integration", {
    projectRoot: contractWorkspace,
    commandCwd: contractWorkspace,
    projectSessionsDir: contractProjectSessionsDir,
  });
  const contractEvents = await contractStore.loadEvents();
  assert.equal(contractResult.stopped, undefined, "tool-contract recovery stopped instead of changing local model");
  assert.deepEqual(
    contractRequests.map((payload) => payload.model),
    ["localllm-fast", "localllm-fast", "localllm-deep", "localllm-deep", "localllm-deep"],
    "schema-invalid calls did not move the next inference onto the deep local model"
  );
  assert.equal(
    contractEvents.filter((event) => event.type === "tool.failed" && event.data?.category === "tool-contract-violation").length,
    2,
    "the contract recovery run did not retain evidence for both rejected calls"
  );
  assert.equal(
    contractEvents.filter((event) => event.type === "provider.local_failure_recovery").length,
    1,
    "tool-contract recovery should activate exactly once"
  );
  assert.match(
    (contractRequests[1]?.messages || [])
      .filter((message) => message?.role === "user")
      .map((message) => String(message?.content || ""))
      .join("\n"),
    /Schema diagnostics:.*additional property.*Do not repeat the rejected arguments unchanged/iu,
    "tool-contract recovery did not return bounded actionable schema diagnostics to the model"
  );
  assert.equal(
    await fs.readFile(path.join(contractWorkspace, "contract-recovered.txt"), "utf8"),
    "recovered after schema violations\n"
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("LocalLLM tool-failure recovery smoke passed.");
