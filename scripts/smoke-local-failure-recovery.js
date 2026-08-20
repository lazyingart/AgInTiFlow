#!/usr/bin/env node
import assert from "node:assert/strict";
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
import { nextStepRuntimeConfig, runAgent } from "../src/agent-runner.js";
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
  assert.equal(
    await fs.readFile(path.join(contractWorkspace, "contract-recovered.txt"), "utf8"),
    "recovered after schema violations\n"
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("LocalLLM tool-failure recovery smoke passed.");
