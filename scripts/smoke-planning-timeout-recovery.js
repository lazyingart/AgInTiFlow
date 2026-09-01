#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKnownConstrainedPhasePlan,
  buildPlanningTimeoutFallbackPlan,
  modelPlanningTimeoutRetryRoute,
  nextStepRuntimeConfig,
  recordAlreadyCommittedRepositoryRepair,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  isTransientProviderRequestError,
  planningContinuityContext,
} from "../src/model-client.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function timeout(label = "plan request") {
  const error = new Error(`${label} timed out after 1000ms`);
  error.name = "ModelTimeoutError";
  return error;
}

function transportInterrupted() {
  const error = new TypeError("terminated");
  error.cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  return error;
}

assert.equal(isTransientProviderRequestError(transportInterrupted()), true);
assert.equal(
  isTransientProviderRequestError(Object.assign(new Error("validation failed"), { status: 400 })),
  false
);

function assistant(content, toolCalls = []) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const smartRoute = modelPlanningTimeoutRetryRoute({
  provider: "localllm",
  model: "localllm-fast",
  routingMode: "smart",
  routeProvider: "localllm",
  routeModel: "localllm-fast",
  mainProvider: "localllm",
  mainModel: "localllm-deep",
  spareProvider: "localllm",
  spareModel: "localllm-deep",
  localAvailableModels: ["localllm-fast", "localllm-deep"],
  modelTimeoutMs: 1000,
});
assert.equal(smartRoute.model, "localllm-deep");
assert.equal(smartRoute.switchedModel, true);
assert.equal(smartRoute.provider, "localllm");

const manualRoute = modelPlanningTimeoutRetryRoute({
  provider: "localllm",
  model: "localllm-fast",
  routingMode: "manual",
  mainProvider: "localllm",
  mainModel: "localllm-deep",
  modelTimeoutMs: 1000,
});
assert.equal(manualRoute.model, "localllm-fast", "manual routing changed the selected model");
assert.equal(manualRoute.switchedModel, false);

assert.match(
  buildPlanningTimeoutFallbackPlan({ taskProfile: "security" }, {}),
  /Run the relevant checks and verify required artifacts/i
);

const knownVerifier = "python3 /tmp/aginti-smoke/verify_contract.py";
const knownVerifierPhase = buildKnownConstrainedPhasePlan(
  { taskProfile: "security" },
  {},
  {
    requiredProjectCommandPending: true,
    requiredProjectCommand: knownVerifier,
  }
);
assert.equal(knownVerifierPhase.mode, "required-project-command");
assert.match(knownVerifierPhase.plan, /verify_contract\.py/);
assert.equal(
  buildKnownConstrainedPhasePlan({}, {}, {
    testFailureRepairActive: true,
    testFailureCommand: knownVerifier,
  }),
  null,
  "a substantive failed-test repair bypassed model planning"
);
assert.match(
  planningContinuityContext({
    goal: "Consolidate the corrective documentation and reuse the established verifier.",
    meta: {
      goalContract: {
        revision: 2,
        history: [
          {
            revision: 1,
            preview: "Run python3 /tmp/security_contract.py, commit only SECURITY.md, and leave the worktree clean.",
          },
          {
            revision: 2,
            preview: "Consolidate the corrective documentation and reuse the established verifier.",
          },
        ],
      },
    },
  }).join("\n"),
  /python3 \/tmp\/security_contract\.py/,
  "the planner lost the prior exact verifier on a same-session follow-up"
);

const scopedRepairRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-scoped-artifact-repair-")
);
try {
  const scopedArtifactRoot = path.join(scopedRepairRoot, "output", "task-1");
  const scopedSource = "output/task-1/reader-report.md";
  await fs.mkdir(scopedArtifactRoot, { recursive: true });
  await fs.writeFile(path.join(scopedRepairRoot, scopedSource), "# Rejected report\n", "utf8");
  const refreshedAt = new Date(Date.now() - 1000).toISOString();
  const groundedAt = new Date().toISOString();
  const scopedGoal = [
    `Revise the exact existing source ${scopedSource}, materially repair it, and rebuild its PDF.`,
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "task",
      request: `Revise ${scopedSource}`,
      artifact_root: scopedArtifactRoot,
    })}`,
  ].join("\n");
  const scopedRuntime = nextStepRuntimeConfig(
    { commandCwd: scopedRepairRoot, goal: scopedGoal },
    {
      goal: scopedGoal,
      commandCwd: scopedRepairRoot,
      meta: {
        goalContract: {
          revision: 1,
          currentRequest: scopedGoal,
          currentHash: "scoped-repair",
        },
        activeExecutionContract: {
          revision: 1,
          refreshedAt,
          startedMutationRevision: 0,
          requiresWorkspaceMutation: true,
          requiresFileMutation: true,
          requiresSourceGrounding: true,
        },
        projectVerification: {
          mutationRevision: 0,
          mutationHistory: [],
          testRuns: [],
          discoveredTests: [],
        },
        toolLoop: {
          recent: [{
            toolName: "read_file",
            ok: true,
            blocked: false,
            path: scopedSource,
            at: groundedAt,
          }],
        },
      },
    }
  );
  assert.equal(scopedRuntime.scopedArtifactTask, true);
  assert.equal(
    scopedRuntime.completionFreshMutationRequired,
    true,
    "a grounded task-scoped artifact repair was allowed to probe or verify before mutation"
  );
  assert.deepEqual(scopedRuntime.completionFreshMutationPaths, [scopedSource]);
  assert.equal(scopedRuntime.completionFreshMutationNeedsSourceRead, false);
} finally {
  await fs.rm(scopedRepairRoot, { recursive: true, force: true });
}

const cleanVerifier = "python3 /tmp/aginti-smoke/clean_contract.py";
const alreadyCommittedState = {
  meta: {
    goalContract: { revision: 3 },
    durableGitEvidence: [{ action: "commit", goalRevision: 3, mutationRevision: 7 }],
    projectVerification: {
      mutationRevision: 7,
      testRuns: [{
        command: cleanVerifier,
        mutationRevision: 7,
        passed: false,
        failureSignature: "clean-worktree-gate",
        failureSummary: "AssertionError: repository worktree must be clean",
      }],
    },
  },
};
const cleanCommitNoop = {
  args: { command: 'git commit -m "finish verified task"' },
  stdout: "On branch main\nnothing to commit, working tree clean\n",
  stderr: "",
};
const repositoryRepair = recordAlreadyCommittedRepositoryRepair(alreadyCommittedState, cleanCommitNoop);
assert(repositoryRepair, "clean already-committed repair evidence was not retained");
const repairedRuntime = nextStepRuntimeConfig({}, alreadyCommittedState);
assert.equal(repairedRuntime.testFailureRepositoryStateRepair, false);
assert.equal(repairedRuntime.testFailureRepairActive, false);
assert.equal(repairedRuntime.testVerificationPending, true);
assert.equal(repairedRuntime.testVerificationCommand, cleanVerifier);
const repairedPhase = buildKnownConstrainedPhasePlan({}, alreadyCommittedState, repairedRuntime);
assert.equal(repairedPhase.mode, "exact-verification");
assert.match(repairedPhase.plan, /clean_contract\.py/);

alreadyCommittedState.meta.projectVerification.mutationRevision = 8;
const staleRepairRuntime = nextStepRuntimeConfig({}, alreadyCommittedState);
assert.notEqual(staleRepairRuntime.repositoryStateRepairSatisfied, true, "stale clean-commit repair survived a mutation");
alreadyCommittedState.meta.projectVerification.mutationRevision = 7;
alreadyCommittedState.meta.goalContract.revision = 4;
const staleGoalRuntime = nextStepRuntimeConfig({}, alreadyCommittedState);
assert.notEqual(staleGoalRuntime.repositoryStateRepairSatisfied, true, "stale clean-commit repair survived a goal revision");
alreadyCommittedState.meta.goalContract.history = [
  { revision: 3, taskHash: "same-repair" },
  { revision: 4, taskHash: "same-repair" },
];
const sameTaskGoalRuntime = nextStepRuntimeConfig({}, alreadyCommittedState);
assert.equal(
  sameTaskGoalRuntime.repositoryStateRepairSatisfied,
  true,
  "same-task continuation discarded clean-commit repair evidence"
);
alreadyCommittedState.meta.goalContract.history = [
  { revision: 3, taskHash: "prior-repair" },
  { revision: 4, taskHash: "new-repair" },
];
const newTaskGoalRuntime = nextStepRuntimeConfig({}, alreadyCommittedState);
assert.notEqual(
  newTaskGoalRuntime.repositoryStateRepairSatisfied,
  true,
  "new task reused clean-commit repair evidence from a prior task"
);

async function runScenario({
  sessionId,
  doubleTimeout = false,
  planningTransportInterrupt = false,
  executionTransportInterrupt = false,
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-plan-timeout-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  let planningCalls = 0;
  let executionAttempts = 0;
  let executionCalls = 0;
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          const planning = /You are planning/.test(payload.messages?.[0]?.content || "");
          if (planning) {
            planningCalls += 1;
            if (planningTransportInterrupt && planningCalls === 1) {
              throw transportInterrupted();
            }
            if (planningCalls === 1 || doubleTimeout) throw timeout();
            return assistant("1. Create the requested file.\n2. Read it back.\n3. Finish with verified evidence.");
          }
          executionAttempts += 1;
          if (executionTransportInterrupt && executionAttempts === 1) {
            throw transportInterrupted();
          }
          executionCalls += 1;
          if (executionCalls === 1) {
            return assistant("", [toolCall("write-result", "write_file", {
              path: "planner-recovery.txt",
              mode: "create",
              content: "same invocation recovered\n",
            })]);
          }
          if (executionCalls === 2) {
            return assistant("", [toolCall("read-result", "read_file", {
              path: "planner-recovery.txt",
              startLine: 1,
              lineLimit: 10,
            })]);
          }
          return assistant("", [toolCall("finish-result", "finish", {
            result: "Created and verified planner-recovery.txt in the same invocation.",
          })]);
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
      goal: "Create planner-recovery.txt and verify its exact contents.",
      taskProfile: "security",
      commandCwd: workspace,
      dynamicSteps: "off",
      maxSteps: 6,
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
      sessionId,
      commandCwd: workspace,
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
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-local-test",
    provider: "localllm",
    model: "localllm-fast",
    routingMode: "smart",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
    mainProvider: "localllm",
    mainModel: "localllm-deep",
    spareProvider: "localllm",
    spareModel: "localllm-deep",
    localCodeCandidate: false,
    localCodeResumeEligible: false,
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    enableScs: "off",
    scsActive: false,
    executionPolicy: { tier: "thorough", requiresPlan: true, reason: "test" },
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1000,
    localAvailableModels: ["localllm-fast", "localllm-deep"],
  });

  try {
    const result = await runAgent(config);
    const store = new SessionStore(sessionsDir, sessionId, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    return {
      result,
      state: await store.loadState(),
      events: await store.loadEvents(),
      requests,
      content: await fs.readFile(path.join(workspace, "planner-recovery.txt"), "utf8"),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runKnownCommandScenario() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-known-phase-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  const verifierPath = path.join(workspace, "verify_contract.py");
  const command = `python3 ${verifierPath}`;
  const goal = `Run ${command} and finish only after it passes.`;
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(verifierPath, 'print("contract verifier passed")\n', "utf8");

  const requests = [];
  let executionCalls = 0;
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          if (/You are planning/.test(payload.messages?.[0]?.content || "")) {
            throw new Error("known constrained phase unexpectedly requested a model plan");
          }
          executionCalls += 1;
          if (executionCalls === 1) {
            return assistant("", [toolCall("run-known-verifier", "run_command", { command })]);
          }
          return assistant("", [toolCall("finish-known-verifier", "finish", {
            result: "Ran the exact contract verifier successfully.",
          })]);
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
      routingMode: "manual",
      goal,
      taskProfile: "security",
      commandCwd: workspace,
      dynamicSteps: "off",
      maxSteps: 4,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "manual",
      sessionId: "known-constrained-phase",
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool: true,
      allowFileTools: false,
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
    enableScs: "off",
    scsActive: false,
    executionPolicy: { tier: "thorough", requiresPlan: true, reason: "test" },
    dynamicSteps: "off",
    maxSteps: 4,
    modelTimeoutMs: 1000,
  });

  try {
    const result = await runAgent(config);
    const store = new SessionStore(sessionsDir, "known-constrained-phase", {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    return {
      result,
      state: await store.loadState(),
      events: await store.loadEvents(),
      requests,
      command,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runResponseOnlyScenario() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-response-only-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  const sessionId = "response-only-provider-handoff";
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  const answers = [
    "First complete source-grounded response.",
    "Resumed provider response with the interruption applied.",
  ];
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          return assistant(answers[requests.length - 1]);
        },
      },
    },
  };
  const clientFactory = async () => client;
  clientFactory.agintiDeterministicTest = true;
  const evidenceGoal = (request) => [
    request,
    "Use all supplied source evidence and return a substantive final answer.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "host-managed-response",
      request,
    })}`,
  ].join("\n");
  const overrides = {
    baseDir: workspace,
    packageDir: repoRoot,
    provider: "localllm",
    model: "localllm-fast",
    routingMode: "manual",
    commandCwd: workspace,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    allowShellTool: false,
    allowFileTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    enableScs: "off",
    clientFactory,
  };
  const operational = {
    apiKey: "deterministic-local-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    enableScs: "off",
    scsActive: false,
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1000,
  };

  try {
    const firstConfig = resolveRuntimeConfig(
      {
        provider: "localllm",
        model: "localllm-fast",
        routingMode: "manual",
        goal: evidenceGoal("Draft the complete report body."),
        taskProfile: "research",
        commandCwd: workspace,
      },
      { ...overrides, sessionId }
    );
    Object.assign(firstConfig, operational);
    const first = await runAgent(firstConfig);

    const resumedConfig = resolveRuntimeConfig(
      {
        resume: sessionId,
        goal: evidenceGoal("Revise the same report with the new source-specific example."),
      },
      { ...overrides, sessionId }
    );
    Object.assign(resumedConfig, operational, { resume: sessionId });
    const resumed = await runAgent(resumedConfig);
    const store = new SessionStore(sessionsDir, sessionId, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    return {
      first,
      resumed,
      requests,
      events: await store.loadEvents(),
      state: await store.loadState(),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const recovered = await runScenario({ sessionId: "planning-timeout-retry" });
assert.equal(recovered.result.stopped, undefined);
assert.equal(recovered.content, "same invocation recovered\n");
assert.deepEqual(
  recovered.requests.map((request) => request.model),
  ["localllm-fast", "localllm-deep", "localllm-deep", "localllm-deep", "localllm-deep"]
);
assert(recovered.events.some((event) => event.type === "plan.timeout"));
assert(recovered.events.some((event) => event.type === "plan.timeout_recovered"));
assert(recovered.events.some((event) => event.type === "plan.timeout_route_adopted"));
assert.equal(recovered.state.model, "localllm-deep");
assert.equal(recovered.state.meta.runtimeConfig.model, "localllm-deep");

const fallback = await runScenario({ sessionId: "planning-timeout-fallback", doubleTimeout: true });
assert.equal(fallback.result.stopped, undefined);
assert.equal(fallback.content, "same invocation recovered\n");
assert(fallback.events.some((event) => event.type === "plan.timeout_fallback"));
assert.match(fallback.state.plan, /retained workspace state/i);
assert.equal(fallback.state.meta.planTimeoutRecovery.fallback, true);
assert.equal(fallback.state.model, "localllm-deep");

const transportPlan = await runScenario({
  sessionId: "planning-transport-retry",
  planningTransportInterrupt: true,
});
assert.equal(transportPlan.result.stopped, undefined);
assert.equal(transportPlan.content, "same invocation recovered\n");
assert(transportPlan.events.some((event) => event.type === "plan.transport_interrupted"));
assert(transportPlan.events.some((event) => event.type === "plan.transport_recovered"));
assert(!transportPlan.events.some((event) => event.type === "session.failed"));
assert.equal(transportPlan.state.model, "localllm-fast");

const transportStep = await runScenario({
  sessionId: "agent-step-transport-retry",
  executionTransportInterrupt: true,
});
assert.equal(transportStep.result.stopped, undefined);
assert.equal(transportStep.content, "same invocation recovered\n");
assert(transportStep.events.some((event) => event.type === "model.transport_interrupted"));
assert(transportStep.events.some((event) => event.type === "model.transport_recovered"));
assert(!transportStep.events.some((event) => event.type === "session.failed"));

const constrained = await runKnownCommandScenario();
assert.equal(constrained.result.stopped, undefined);
assert.equal(constrained.requests.length, 2);
assert(!constrained.events.some((event) => event.type === "plan.requested"));
assert(constrained.events.some((event) => event.type === "plan.constrained_phase_reused"));
assert.match(constrained.state.plan, /verify_contract\.py/);
assert.deepEqual(
  constrained.requests[0].tools.map((tool) => tool.function.name),
  ["run_command", "finish"]
);
assert.deepEqual(
  constrained.requests[0].tools[0].function.parameters.properties.command.enum,
  [constrained.command]
);

const responseOnly = await runResponseOnlyScenario();
assert.equal(responseOnly.first.result, "First complete source-grounded response.");
assert.equal(responseOnly.resumed.result, "Resumed provider response with the interruption applied.");
assert.equal(responseOnly.requests.length, 2);
assert(responseOnly.requests.every((request) => !Object.hasOwn(request, "tools")));
assert(responseOnly.requests.every((request) => !Object.hasOwn(request, "tool_choice")));
assert(!responseOnly.events.some((event) => event.type === "plan.requested"));
assert.equal(
  responseOnly.events.filter((event) => event.type === "session.finished" && event.data?.mode === "response-only").length,
  2
);
assert.equal(responseOnly.state.meta.responseOnly.model, "localllm-fast");

console.log("planning timeout recovery smoke test passed");
