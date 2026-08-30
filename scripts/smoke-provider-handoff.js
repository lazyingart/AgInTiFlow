#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  classifyProviderHandoffError,
  resolveProviderHandoff,
  resolveProviderQualityRebound,
} from "../src/provider-handoff.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

assert.deepEqual(
  classifyProviderHandoffError(Object.assign(new Error("402 Insufficient Balance"), { status: 402 })),
  { eligible: true, code: "provider_quota", status: 402 }
);
assert.equal(
  classifyProviderHandoffError(Object.assign(new Error("invalid request"), { status: 400 })).eligible,
  false
);

const exhaustedLocalRecovery = {
  active: false,
  reason: "no-strong-local-recovery-model",
  semanticTestFailureCount: 1,
  semanticTestMutationFailureCount: 4,
};
const qualityReboundState = {
  meta: {
    goalContract: { currentHash: "same-repair-goal" },
    providerHandoff: {
      attempts: 1,
      status: "active",
      sourceProvider: "deepseek",
      sourceModel: "deepseek-v4-pro",
      sourceRoutingMode: "smart",
      targetProvider: "localllm",
      targetModel: "localllm-deep",
      failureCode: "provider_tool_contract",
    },
  },
};
const qualityRebound = resolveProviderQualityRebound(
  {
    provider: "localllm",
    model: "localllm-deep",
    routingMode: "manual",
  },
  qualityReboundState,
  exhaustedLocalRecovery
);
assert(qualityRebound, "exhausted local repair did not rebound to the original capable provider");
assert.equal(qualityRebound.targetProvider, "deepseek");
assert.equal(qualityRebound.targetModel, "deepseek-v4-pro");
assert.equal(qualityRebound.runtimePatch.routingMode, "smart");
assert.deepEqual(
  [
    qualityRebound.runtimePatch.routeModel,
    qualityRebound.runtimePatch.mainModel,
    qualityRebound.runtimePatch.spareModel,
  ],
  ["deepseek-v4-pro", "deepseek-v4-pro", "deepseek-v4-pro"]
);

for (const failureCode of ["provider_quota", "provider_auth", "provider_timeout"]) {
  const ineligibleState = structuredClone(qualityReboundState);
  ineligibleState.meta.providerHandoff.failureCode = failureCode;
  assert.equal(
    resolveProviderQualityRebound(
      { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
      ineligibleState,
      exhaustedLocalRecovery
    ),
    null,
    `${failureCode} unexpectedly rebounded into a provider known to be unavailable`
  );
}

const explicitlyManualSourceState = structuredClone(qualityReboundState);
explicitlyManualSourceState.meta.providerHandoff.sourceRoutingMode = "manual";
assert.equal(
  resolveProviderQualityRebound(
    { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
    explicitlyManualSourceState,
    exhaustedLocalRecovery
  ),
  null,
  "an explicit manual source route was overridden by quality recovery"
);

const alreadyReboundedState = structuredClone(qualityReboundState);
alreadyReboundedState.meta.providerQualityRebound = { attempts: 1, status: "active" };
assert.equal(
  resolveProviderQualityRebound(
    { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
    alreadyReboundedState,
    exhaustedLocalRecovery
  ),
  null,
  "provider quality recovery could ping-pong after its single bounded attempt"
);

assert.equal(
  resolveProviderQualityRebound(
    { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
    qualityReboundState,
    { ...exhaustedLocalRecovery, semanticTestMutationFailureCount: 3 }
  ),
  null,
  "provider quality recovery activated before four distinct failed source revisions"
);

const authoritativeTestBlockRebound = resolveProviderQualityRebound(
  {
    provider: "localllm",
    model: "localllm-deep",
    routingMode: "manual",
  },
  qualityReboundState,
  {
    ...exhaustedLocalRecovery,
    semanticTestMutationFailureCount: 2,
    blockedTestSpecificationMutationCount: 3,
  }
);
assert(
  authoritativeTestBlockRebound,
  "three ignored authoritative-test mutation rejections did not activate bounded quality recovery"
);
assert.equal(authoritativeTestBlockRebound.blockedTestSpecificationMutationCount, 3);
assert.equal(
  resolveProviderQualityRebound(
    { provider: "localllm", model: "localllm-deep", routingMode: "manual" },
    qualityReboundState,
    {
      ...exhaustedLocalRecovery,
      semanticTestMutationFailureCount: 2,
      blockedTestSpecificationMutationCount: 2,
    }
  ),
  null,
  "quality recovery activated after fewer than three authoritative-test mutation rejections"
);
assert.deepEqual(
  classifyProviderHandoffError(Object.assign(
    new Error("agent step request timed out after 1000ms"),
    { name: "ModelTimeoutError" }
  )),
  { eligible: true, code: "provider_timeout", status: 0 }
);
assert.deepEqual(
  classifyProviderHandoffError(Object.assign(
    new Error("hosted model violated the tool contract twice"),
    { code: "TOOL_CONTRACT_VIOLATION" }
  )),
  { eligible: true, code: "provider_tool_contract", status: 0 }
);
assert.equal(
  resolveProviderHandoff(Object.assign(new Error("payment required"), { status: 402 }), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routingMode: "manual",
  }),
  null,
  "manual provider selection must remain exact"
);
assert.equal(
  resolveProviderHandoff(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routingMode: "smart",
  }),
  null,
  "an unmarked tool/runtime network error changed the reasoning provider"
);
assert.equal(
  resolveProviderHandoff(Object.assign(
    new Error("agent step request timed out after 1000ms"),
    { name: "ModelTimeoutError", agintiProviderRequest: true }
  ), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routingMode: "manual",
  }),
  null,
  "manual provider selection must remain exact after a timeout"
);

async function runScenario({ routingMode, sessionId }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-provider-handoff-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });

  const factoryConfigs = [];
  const requests = [];
  const clientFactory = async (config) => {
    factoryConfigs.push({ provider: config.provider, model: config.model });
    return {
      chat: {
        completions: {
          create: async (payload) => {
            requests.push({ provider: config.provider, model: payload.model });
            if (config.provider === "deepseek") {
              throw Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
            }
            return assistant("Local fallback produced the complete response.");
          },
        },
      },
    };
  };
  clientFactory.agintiDeterministicTest = true;

  const goal = [
    "Explain the current task result clearly.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "host-managed-response",
      request: "Explain the current task result clearly.",
    })}`,
  ].join("\n");
  const config = resolveRuntimeConfig(
    {
      goal,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      routeProvider: "deepseek",
      routeModel: "deepseek-v4-flash",
      mainProvider: "deepseek",
      mainModel: "deepseek-v4-pro",
      spareProvider: "deepseek",
      spareModel: "deepseek-v4-pro",
      routingMode,
      taskProfile: "research",
      commandCwd: workspace,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      sessionId,
      clientFactory,
      providerReadinessMode: "deterministic-test",
      sandboxMode: "host",
      useDockerSandbox: false,
      allowShellTool: false,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-hosted-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    enableScs: "off",
    scsActive: false,
    dynamicSteps: "off",
    maxSteps: 4,
    modelTimeoutMs: 1000,
  });

  try {
    let result = null;
    let error = null;
    try {
      result = await runAgent(config);
    } catch (caught) {
      error = caught;
    }
    const store = new SessionStore(sessionsDir, sessionId, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    return {
      result,
      error,
      state: await store.loadState(),
      events: await store.loadEvents(),
      factoryConfigs,
      requests,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const smart = await runScenario({ routingMode: "smart", sessionId: "smart-provider-handoff" });
assert.equal(smart.error, null);
assert.equal(smart.result.result, "Local fallback produced the complete response.");
assert.deepEqual(smart.factoryConfigs, [
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "localllm", model: "localllm-deep" },
]);
assert.deepEqual(smart.requests.map((item) => item.provider), ["deepseek", "localllm"]);
assert.equal(smart.state.provider, "localllm");
assert.equal(smart.state.model, "localllm-deep");
assert.equal(smart.state.meta.runtimeConfig.provider, "localllm");
assert.equal(smart.state.meta.runtimeConfig.model, "localllm-deep");
assert.equal(smart.state.meta.providerHandoff.status, "active");
assert.equal(smart.state.meta.goalContract.status, "completed");
assert.equal(smart.events.filter((event) => event.type === "provider.handoff_requested").length, 1);
assert.equal(smart.events.filter((event) => event.type === "provider.handoff_activated").length, 1);
assert.equal(smart.events.filter((event) => event.type === "session.failed").length, 0);

const manual = await runScenario({ routingMode: "manual", sessionId: "manual-provider-exact" });
assert(manual.error);
assert.equal(manual.factoryConfigs.length, 1);
assert.equal(manual.events.filter((event) => event.type === "provider.handoff_requested").length, 0);
assert.equal(manual.events.filter((event) => event.type === "session.failed").length, 1);

async function runTimeoutHandoffScenario() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-timeout-handoff-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  const sessionId = "smart-timeout-provider-handoff";
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  let localCall = 0;
  const clientFactory = async (config) => ({
    chat: {
      completions: {
        create: async (payload) => {
          requests.push({ provider: config.provider, model: payload.model });
          if (config.provider === "deepseek") {
            const error = new Error("agent step request timed out after 1000ms");
            error.name = "ModelTimeoutError";
            throw error;
          }
          if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
            return assistant([
              "1. Create timeout-handoff.txt with the exact requested content.",
              "2. Read the file back to verify it.",
              "3. Finish with the verified result.",
            ].join("\n"));
          }
          localCall += 1;
          if (localCall === 1) {
            return assistant("", [toolCall("write-local", "write_file", {
              path: "timeout-handoff.txt",
              mode: "create",
              content: "continued on LocalLLM after exhausted DeepSeek timeout\n",
            })]);
          }
          if (localCall === 2) {
            return assistant("", [toolCall("read-local", "read_file", {
              path: "timeout-handoff.txt",
              startLine: 1,
              lineLimit: 20,
            })]);
          }
          return assistant("", [toolCall("finish-local", "finish", {
            result: "Created and verified timeout-handoff.txt after same-session provider handoff.",
          })]);
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;

  const config = resolveRuntimeConfig(
    {
      goal: "Create timeout-handoff.txt, verify its exact content, and finish.",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      routeProvider: "deepseek",
      routeModel: "deepseek-v4-flash",
      mainProvider: "deepseek",
      mainModel: "deepseek-v4-pro",
      spareProvider: "deepseek",
      spareModel: "deepseek-v4-pro",
      routingMode: "smart",
      taskProfile: "code",
      commandCwd: workspace,
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      dynamicSteps: "off",
      maxSteps: 6,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      sessionId,
      clientFactory,
      providerReadinessMode: "deterministic-test",
      sandboxMode: "host",
      useDockerSandbox: false,
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-hosted-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
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
    enableScs: "off",
    scsActive: false,
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Deterministic timeout-handoff smoke.",
    },
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1_000,
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
      content: await fs.readFile(path.join(workspace, "timeout-handoff.txt"), "utf8"),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const timeoutHandoff = await runTimeoutHandoffScenario();
assert.equal(timeoutHandoff.result.stopped, undefined);
assert.deepEqual(
  timeoutHandoff.requests.map((item) => item.provider),
  ["deepseek", "deepseek", "localllm", "localllm", "localllm", "localllm"],
  "exhausted DeepSeek timeout did not continue the exact session on LocalLLM"
);
assert.equal(timeoutHandoff.state.provider, "localllm");
assert.equal(timeoutHandoff.state.model, "localllm-deep");
assert.equal(timeoutHandoff.state.meta.providerHandoff.status, "active");
assert.equal(timeoutHandoff.events.filter((event) => event.type === "model.timeout").length, 1);
assert.equal(timeoutHandoff.events.filter((event) => event.type === "provider.handoff_requested").length, 1);
assert.equal(timeoutHandoff.events.filter((event) => event.type === "provider.handoff_activated").length, 1);
assert.equal(timeoutHandoff.events.filter((event) => event.type === "session.failed").length, 0);
assert.equal(
  timeoutHandoff.content,
  "continued on LocalLLM after exhausted DeepSeek timeout\n"
);

async function runToolContractHandoffScenario() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agintiflow-tool-contract-handoff-")
  );
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  const sessionId = "smart-tool-contract-provider-handoff";
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  let localCall = 0;
  const clientFactory = async (config) => ({
    chat: {
      completions: {
        create: async (payload) => {
          requests.push({
            provider: config.provider,
            model: payload.model,
            tools: (payload.tools || []).map((item) => item.function?.name),
          });
          if (config.provider === "deepseek") {
            return assistant("", [
              toolCall(`invalid-hosted-${requests.length}`, "write_file", {
                path: "must-not-dispatch.txt",
                mode: "create",
                content: "invalid\n",
                dryRun: false,
              }),
            ]);
          }
          if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
            return assistant([
              "1. Create tool-contract-handoff.txt with the exact requested content.",
              "2. Read the file back to verify it.",
              "3. Finish with the verified result.",
            ].join("\n"));
          }
          localCall += 1;
          if (localCall === 1) {
            return assistant("", [
              toolCall("write-local-contract", "write_file", {
                path: "tool-contract-handoff.txt",
                mode: "create",
                content: "continued after hosted tool-contract handoff\n",
              }),
            ]);
          }
          if (localCall === 2) {
            return assistant("", [
              toolCall("read-local-contract", "read_file", {
                path: "tool-contract-handoff.txt",
                startLine: 1,
                lineLimit: 20,
              }),
            ]);
          }
          return assistant("", [
            toolCall("finish-local-contract", "finish", {
              result:
                "Created and verified tool-contract-handoff.txt after same-session provider recovery.",
            }),
          ]);
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;

  const config = resolveRuntimeConfig(
    {
      goal: "Create tool-contract-handoff.txt, verify its exact content, and finish.",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      routeProvider: "deepseek",
      routeModel: "deepseek-v4-flash",
      mainProvider: "deepseek",
      mainModel: "deepseek-v4-pro",
      spareProvider: "deepseek",
      spareModel: "deepseek-v4-pro",
      routingMode: "smart",
      taskProfile: "code",
      commandCwd: workspace,
      allowShellTool: false,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      dynamicSteps: "off",
      maxSteps: 6,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      sessionId,
      clientFactory,
      providerReadinessMode: "deterministic-test",
      sandboxMode: "host",
      useDockerSandbox: false,
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-hosted-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
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
    enableScs: "off",
    scsActive: false,
    executionPolicy: {
      tier: "focused",
      requiresPlan: false,
      reason: "Deterministic tool-contract handoff smoke.",
    },
    dynamicSteps: "off",
    maxSteps: 6,
    modelTimeoutMs: 1_000,
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
      content: await fs.readFile(
        path.join(workspace, "tool-contract-handoff.txt"),
        "utf8"
      ).catch(() => ""),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const toolContractHandoff = await runToolContractHandoffScenario();
assert.equal(
  toolContractHandoff.result.stopped,
  undefined,
  JSON.stringify({
    result: toolContractHandoff.result,
    requests: toolContractHandoff.requests,
    failures: toolContractHandoff.events
      .filter((event) => event.type === "tool.failed")
      .map((event) => event.data),
  })
);
assert.deepEqual(
  toolContractHandoff.requests.map((item) => item.provider),
  ["deepseek", "deepseek", "localllm", "localllm", "localllm", "localllm"],
  "repeated hosted tool-contract violations did not continue the exact session on LocalLLM"
);
assert.equal(toolContractHandoff.state.provider, "localllm");
assert.equal(toolContractHandoff.state.model, "localllm-deep");
assert.equal(toolContractHandoff.state.meta.providerHandoff.status, "active");
assert.equal(
  toolContractHandoff.state.meta.providerHandoff.failureCode,
  "provider_tool_contract"
);
assert.equal(
  toolContractHandoff.events.filter(
    (event) =>
      event.type === "tool.failed" &&
      event.data?.category === "tool-contract-violation"
  ).length,
  2
);
assert.equal(
  toolContractHandoff.events.filter(
    (event) =>
      event.type === "session.stopped" &&
      event.data?.reason === "tool_contract_violation"
  ).length,
  0
);
assert.equal(
  toolContractHandoff.content,
  "continued after hosted tool-contract handoff\n"
);

console.log("provider handoff smoke test passed");
