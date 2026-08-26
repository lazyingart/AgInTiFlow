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
  activePatchContextRefresh,
  activeRequiredSymbolRepair,
  buildFailedTestFocusedRecoveryMessages,
  consumePatchContextRefreshRead,
  currentRequiredSymbolRepair,
  failedTestRequiredSymbolContracts,
  nextStepRuntimeConfig,
  patchContextRefreshDecision,
  repeatedSuccessfulMutationBlock,
  requiredSymbolAbsenceDecision,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
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
      packetVersion: 8,
      mutationRevision: 4,
      failureSignature: "missing-service-seams",
      paths: ["tests/test_service_ctl.py", "service_ctl.py"],
      content: [
        "Bounded failed-test evidence packet v8.",
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
assert.match(focusedRecoveryText, /Bounded failed-test evidence packet v8/);
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
stalePatchRefreshState.meta.toolLoop.patchContextRequired = stalePatchRefresh;
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
assert.equal(
  consumePatchContextRefreshRead(stalePatchRefreshState, {
    toolName: "read_file",
    args: { path: "service_ctl.py" },
    result: { path: "service_ctl.py" },
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
    assistant("", [toolCall("create-result", "write_file", {
      path: "recovered-result.txt",
      mode: "overwrite",
      content: "recovered by the stronger local route\n",
    })]),
    assistant("", [toolCall("read-result", "read_file", {
      path: "recovered-result.txt",
      startLine: 1,
      lineLimit: 20,
    })]),
    assistant("", [toolCall("finish-result", "finish", {
      result: "Created and verified recovered-result.txt after changing the stalled local route.",
    })]),
  ];
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          const response = responses.shift();
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
      goal: "Update, replace, and overwrite the existing recovered-result.txt, then verify the changed file.",
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
  assert.equal(result.stopped, undefined, "integrated recovery run stopped instead of finishing");
  assert.deepEqual(
    requests.map((payload) => payload.model),
    [
      "localllm-fast",
      "localllm-fast",
      "localllm-fast",
      "localllm-fast",
      "localllm-deep",
      "localllm-deep",
      "localllm-deep",
    ],
    "the live agent loop did not move subsequent requests onto the deep local model"
  );
  assert.equal(await fs.readFile(path.join(workspace, "recovered-result.txt"), "utf8"), "recovered by the stronger local route\n");
  assert.equal(
    events.filter((event) => event.type === "provider.local_failure_recovery").length,
    1,
    "recovery activation should be recorded exactly once"
  );
  assert.equal(state.model, "localllm-deep", "recovered model was not saved in durable session state");
  assert.equal(state.meta.runtimeConfig.model, "localllm-deep", "recovered model was not saved in runtime config");

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
