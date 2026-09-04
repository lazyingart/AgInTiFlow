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

async function runSourceFreeResponseOnlyHandoffScenario({
  sessionId,
  localResponses,
  request: requestedResponse = "",
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-source-free-handoff-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  const clientFactory = async (config) => ({
    chat: {
      completions: {
        create: async (payload) => {
          requests.push({ provider: config.provider, model: payload.model });
          if (config.provider === "deepseek") {
            throw Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
          }
          const content = localResponses.shift();
          assert.notEqual(content, undefined, "source-free handoff scenario exhausted scripted LocalLLM responses");
          return assistant(content);
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;

  const request = requestedResponse ||
    "Correct the prior research response using the host-managed evidence scope. No tools are available in this run.";
  const goal = [
    request,
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "host-managed-response",
      request,
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
      routingMode: "smart",
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
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const unsafeSourceFreeHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-handoff-fail-closed",
  localResponses: [
    "2025年Nature子刊预印本未公开，已有初步验证，响应延迟低于100ms，并预测2026年底前上线。",
    "This is unverified. The Nature publication was validated in 2025 on a 12,000-case benchmark with 94.2% accuracy.",
  ],
});
assert.equal(unsafeSourceFreeHandoff.result.stopped, true);
assert.equal(unsafeSourceFreeHandoff.result.reason, "source_free_evidence_required");
assert.deepEqual(
  unsafeSourceFreeHandoff.requests.map((item) => item.provider),
  ["deepseek", "localllm", "localllm"],
  "source-free response-only handoff did not retry exactly once on LocalLLM"
);
assert.equal(unsafeSourceFreeHandoff.state.meta.providerHandoff.status, "active");
assert.equal(
  unsafeSourceFreeHandoff.events.filter((event) => event.type === "response_only.source_free_claim_rejected").length,
  1
);
assert.equal(
  unsafeSourceFreeHandoff.events.filter((event) => event.type === "response_only.source_free_claim_failed_closed").length,
  1
);
assert.equal(
  unsafeSourceFreeHandoff.events.filter((event) => event.type === "session.finished").length,
  0,
  "unsafe source-free response-only claim was persisted as a finished session"
);
assert.equal(
  /Nature|94\.2%|100ms|2025年/.test(unsafeSourceFreeHandoff.result.result),
  false,
  "fail-closed response leaked the unsupported source-free claim text"
);
assert.doesNotMatch(
  unsafeSourceFreeHandoff.result.result,
  /AgInTi|evidence manifest|response-only|tool scope|resume with|provider|runtime/iu,
  "fail-closed response exposed private response-only recovery terminology"
);

const chineseChatSourceFreeStop = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-natural-chinese-chat-stop",
  request: [
    "Choose one response shape:",
    "1. CHAT: <one concise helpful chat message>",
    "2. NO_REPLY",
    "Current coalesced request:",
    "用户: 这项研究可靠吗？",
  ].join("\n"),
  localResponses: [
    "CHAT: 该研究已于2025年发表，并在一万例样本中得到验证。",
    "CHAT: 2025年的论文已经证实这项研究可靠。",
  ],
});
assert.equal(chineseChatSourceFreeStop.result.stopped, true);
assert.match(
  chineseChatSourceFreeStop.result.result,
  /^CHAT:\s*现有信息不足以核实/u,
  "Chinese chat fail-closed result did not preserve its human-facing CHAT protocol"
);
assert.doesNotMatch(
  chineseChatSourceFreeStop.result.result,
  /AgInTi|证据清单|工具|运行时|恢复会话|response-only|manifest/iu,
  "Chinese chat fail-closed result exposed private runtime instructions"
);

const japaneseChatSourceFreeStop = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-natural-japanese-chat-stop",
  request: [
    "Choose one response shape:",
    "1. CHAT: <one concise helpful chat message>",
    "2. NO_REPLY",
    "Current coalesced request:",
    "ユーザー: この研究は信頼できますか？",
  ].join("\n"),
  localResponses: [
    "CHAT: この研究は2025年に発表され、一万件の標本で検証済みです。",
    "CHAT: 2025年の論文ですでに有効性が確認されています。",
  ],
});
assert.equal(japaneseChatSourceFreeStop.result.stopped, true);
assert.match(
  japaneseChatSourceFreeStop.result.result,
  /^CHAT:\s*現在の情報だけでは/u,
  "Japanese chat fail-closed result did not preserve its human-facing CHAT protocol"
);
assert.doesNotMatch(
  japaneseChatSourceFreeStop.result.result,
  /AgInTi|エビデンスマニフェスト|ツール|ランタイム|再開|response-only|manifest/iu,
  "Japanese chat fail-closed result exposed private runtime instructions"
);

const repairedSourceFreeHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-handoff-repaired",
  localResponses: [
    "The paper was published in 2025 and validated on a 12,000-case benchmark with 94.2% accuracy.",
    "No fresh evidence is available, so this is an unverified hypothesis only: I cannot verify any publication, benchmark, validation, or forecast claim from this run.",
  ],
});
assert.equal(repairedSourceFreeHandoff.result.stopped, undefined);
assert.match(repairedSourceFreeHandoff.result.result, /cannot verify/i);
assert.equal(
  repairedSourceFreeHandoff.events.filter((event) => event.type === "response_only.source_free_claim_repaired").length,
  1
);
assert.equal(
  repairedSourceFreeHandoff.events.filter((event) => event.type === "session.finished").length,
  1
);

const sourceFreeJsonContractRequest = [
  "Correct the unsupported claim while preserving the response envelope.",
  "Return one strict JSON object and no prose:",
  JSON.stringify({ message: "", files: [], confirmation: "" }, null, 2),
].join("\n");
const sourceFreeRepairDropsJsonContract = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-repair-drops-json-contract",
  request: sourceFreeJsonContractRequest,
  localResponses: [
    JSON.stringify({
      message: "The paper was published in 2025 and validated on a 12,000-case benchmark.",
      files: [],
      confirmation: "",
    }),
    JSON.stringify({ message: "No fresh evidence is available, so I cannot verify that claim." }),
  ],
});
assert.equal(sourceFreeRepairDropsJsonContract.result.stopped, true);
assert.equal(
  sourceFreeRepairDropsJsonContract.result.reason,
  "response_only_output_contract_required"
);
assert.equal(
  sourceFreeRepairDropsJsonContract.events.filter(
    (event) => event.type === "response_only.output_contract_failed_closed"
  ).length,
  1
);
assert.equal(
  sourceFreeRepairDropsJsonContract.events.filter((event) => event.type === "session.finished").length,
  0,
  "a source-free repair that dropped required JSON keys was persisted as finished"
);

const sourceFreeRepairPreservesJsonContract = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-repair-preserves-json-contract",
  request: sourceFreeJsonContractRequest,
  localResponses: [
    JSON.stringify({
      message: "The paper was published in 2025 and validated on a 12,000-case benchmark.",
      files: [],
      confirmation: "",
    }),
    JSON.stringify({
      message: "No fresh evidence is available, so I cannot verify that claim.",
      files: [],
      confirmation: "",
    }),
  ],
});
assert.equal(sourceFreeRepairPreservesJsonContract.result.stopped, undefined);
assert.deepEqual(Object.keys(JSON.parse(sourceFreeRepairPreservesJsonContract.result.result)), [
  "message",
  "files",
  "confirmation",
]);
assert.equal(
  sourceFreeRepairPreservesJsonContract.events.filter(
    (event) => event.type === "response_only.source_free_claim_repaired"
  ).length,
  1
);
assert.equal(
  sourceFreeRepairPreservesJsonContract.events.filter((event) => event.type === "session.finished").length,
  1
);

const sourceFreeJsonFailClosed = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-json-contract-fail-closed",
  request: sourceFreeJsonContractRequest,
  localResponses: [
    JSON.stringify({
      message: "The paper was published in 2025 and validated on a 12,000-case benchmark.",
      files: [],
      confirmation: "",
    }),
    JSON.stringify({
      message: "The 2025 publication was validated with 94.2% accuracy.",
      files: [],
      confirmation: "",
    }),
  ],
});
assert.equal(sourceFreeJsonFailClosed.result.stopped, true);
assert.equal(sourceFreeJsonFailClosed.result.reason, "source_free_evidence_required");
assert.deepEqual(
  Object.keys(JSON.parse(sourceFreeJsonFailClosed.result.result)),
  ["message", "files", "confirmation"],
  "a source-free fail-closed result broke the caller's explicit JSON envelope"
);
assert.match(
  JSON.parse(sourceFreeJsonFailClosed.result.result).message,
  /cannot verify/i,
  "the schema-compatible fail-closed result omitted its truthful limitation"
);
assert.equal(
  sourceFreeJsonFailClosed.events.filter((event) => event.type === "session.finished").length,
  0,
  "a repeated source-free claim was persisted as a finished session"
);

const requestedFalsifiablePrediction = [
  "Create one concise inspiration message from the supplied conceptual context.",
  "Include one clearly labeled, falsifiable 3/5/10-year prediction as your own hypothesis.",
  "Do not claim a publication, citation, validation result, benchmark, or external source.",
].join("\n");
const speculativeSourceFreeHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-falsifiable-prediction-handoff",
  request: requestedFalsifiablePrediction,
  localResponses: [
    "高风险预测：3年内可形成可测试原型；5年内若不能跨样本复现就应收缩假设；10年内若仍不能跨实验室迁移，就应否定这条路线。",
  ],
});
assert.equal(speculativeSourceFreeHandoff.result.stopped, undefined);
assert.deepEqual(
  speculativeSourceFreeHandoff.requests.map((item) => item.provider),
  ["deepseek", "localllm"],
  "a requested falsifiable prediction triggered an unnecessary source-free repair"
);
assert.equal(
  speculativeSourceFreeHandoff.events.filter((event) => event.type === "response_only.source_free_claim_rejected").length,
  0,
  "a clearly labeled assistant-owned prediction was rejected as external evidence"
);
assert.equal(
  speculativeSourceFreeHandoff.events.filter((event) => event.type === "session.finished").length,
  1
);

const routerClassification = JSON.stringify({
  route_kind: "research_or_summary",
  project: "labcanvas",
  worker_needed: true,
  needs_recent_media: false,
  public_publish_intent: false,
  public_publish_allowed: false,
  external_action_allowed: true,
  delivery_mode: "agent_decide",
  source_policy: "current_request_only",
  reason: "The shared links need source reading before a concise summary.",
  ack: "",
  chat_reply: "",
  confidence: 0.94,
});
const routerSourceFreeHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-router-json-handoff",
  localResponses: [routerClassification],
});
assert.equal(routerSourceFreeHandoff.result.stopped, undefined);
assert.equal(routerSourceFreeHandoff.result.result, routerClassification);
assert.deepEqual(
  routerSourceFreeHandoff.requests.map((item) => item.provider),
  ["deepseek", "localllm"],
  "safe router JSON did not finish on the first LocalLLM fallback response"
);
assert.equal(
  routerSourceFreeHandoff.events.filter((event) => event.type === "response_only.source_free_claim_rejected").length,
  0,
  "a project label in safe router JSON was still classified as a forecast"
);
assert.equal(
  routerSourceFreeHandoff.events.filter((event) => event.type === "session.finished").length,
  1
);

const publishRouterClassification = JSON.stringify({
  route_kind: "publish_video",
  project: "lazyedit",
  worker_needed: true,
  needs_recent_media: true,
  public_publish_intent: true,
  public_publish_allowed: true,
  external_action_allowed: true,
  delivery_mode: "agent_decide",
  source_policy: "recent_media",
  reason:
    "The user explicitly requested publishing the referenced video, so the worker is expected to use the established LazyEdit routine.",
  ack: "",
  chat_reply: "",
  confidence: 0.96,
});
const publishRouterRequest = [
  "Classify the current chat request for a backend worker.",
  "Return only JSON. No markdown.",
  "JSON schema:",
  JSON.stringify({
    route_kind: "publish_video|chat_only",
    project: "lazyedit|generic",
    worker_needed: true,
    needs_recent_media: false,
    public_publish_intent: false,
    public_publish_allowed: false,
    external_action_allowed: true,
    delivery_mode: "agent_decide|chat_attachment",
    source_policy: "current_request_only|recent_media",
    reason: "short reason",
    ack: "",
    chat_reply: "",
    confidence: 0.0,
  }, null, 2),
].join("\n");
const publishRouterSourceFreeHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-publish-router-json-handoff",
  request: publishRouterRequest,
  localResponses: [publishRouterClassification],
});
assert.equal(publishRouterSourceFreeHandoff.result.stopped, undefined);
assert.equal(publishRouterSourceFreeHandoff.result.result, publishRouterClassification);
assert.deepEqual(
  publishRouterSourceFreeHandoff.requests.map((item) => item.provider),
  ["deepseek", "localllm"],
  "a safe publish route did not finish on the first LocalLLM fallback response"
);
assert.equal(
  publishRouterSourceFreeHandoff.events.filter(
    (event) => event.type === "response_only.source_free_claim_rejected"
  ).length,
  0,
  "operational publish routing still triggered a source-free forecast repair"
);
assert.equal(
  publishRouterSourceFreeHandoff.events.filter((event) => event.type === "session.finished").length,
  1
);

const explicitRouterSchema = {
  route_kind: "research_or_summary",
  project: "labcanvas|generic",
  worker_needed: true,
  needs_recent_media: false,
  public_publish_intent: false,
  public_publish_allowed: false,
  external_action_allowed: true,
  delivery_mode: "agent_decide|local_save|chat_attachment",
  source_policy: "current_request_only|recent_media",
  reason: "short reason",
  ack: "",
  chat_reply: "",
  confidence: 0.0,
};
const validExplicitRouterResponse = {
  ...explicitRouterSchema,
  project: "generic",
  delivery_mode: "agent_decide",
  source_policy: "current_request_only",
};
const explicitRouterSchemaRequest = [
  "Classify the current chat request for a backend worker.",
  "Return only JSON. No markdown.",
  "Allowed route_kind values:",
  "- chat_only",
  "- research_or_summary",
  "JSON schema:",
  JSON.stringify(explicitRouterSchema, null, 2),
].join("\n");
const sourceFreeRouterFailClosed = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "source-free-router-contract-fail-closed",
  request: explicitRouterSchemaRequest,
  localResponses: [
    JSON.stringify({
      ...validExplicitRouterResponse,
      reason: "The paper was published in 2025 and validated on a 12,000-case benchmark.",
    }),
    JSON.stringify({
      ...validExplicitRouterResponse,
      reason: "The 2025 publication was validated with 94.2% accuracy.",
    }),
  ],
});
assert.equal(sourceFreeRouterFailClosed.result.stopped, true);
assert.equal(sourceFreeRouterFailClosed.result.reason, "source_free_evidence_required");
const sourceFreeRouterFallback = JSON.parse(sourceFreeRouterFailClosed.result.result);
assert.deepEqual(Object.keys(sourceFreeRouterFallback), Object.keys(explicitRouterSchema));
assert.equal(
  sourceFreeRouterFallback.route_kind,
  "chat_only",
  "a fail-closed fallback overwrote a declared route enum with diagnostic prose"
);
assert.match(sourceFreeRouterFallback.reason, /cannot verify/i);
assert.doesNotMatch(
  sourceFreeRouterFallback.reason,
  /AgInTi|evidence manifest|response-only|tool scope|resume with|provider|runtime/iu,
  "schema-preserving source-free stop exposed private runtime terminology"
);
assert.equal(
  sourceFreeRouterFailClosed.events.filter((event) => event.type === "session.finished").length,
  0
);
const repairedExplicitRouterSchema = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "response-only-explicit-router-schema-repaired",
  request: explicitRouterSchemaRequest,
  localResponses: [
    JSON.stringify({ route_kind: "research_or_summary" }),
    JSON.stringify({
      ...validExplicitRouterResponse,
      reason: "The shared source needs backend reading.",
      confidence: 0.92,
    }),
  ],
});
assert.equal(repairedExplicitRouterSchema.result.stopped, undefined);
assert.deepEqual(
  Object.keys(JSON.parse(repairedExplicitRouterSchema.result.result)),
  Object.keys(explicitRouterSchema)
);
assert.deepEqual(
  repairedExplicitRouterSchema.requests.map((item) => item.provider),
  ["deepseek", "localllm", "localllm"],
  "an incomplete explicit router schema did not get one bounded LocalLLM repair"
);
assert.equal(
  repairedExplicitRouterSchema.events.filter(
    (event) => event.type === "response_only.output_contract_rejected"
  ).length,
  1
);
assert.equal(
  repairedExplicitRouterSchema.events.filter(
    (event) => event.type === "response_only.output_contract_repaired"
  ).length,
  1
);
assert.equal(
  repairedExplicitRouterSchema.events.filter((event) => event.type === "session.finished").length,
  1
);

const repairedExplicitRouterEnum = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "response-only-explicit-router-enum-repaired",
  request: explicitRouterSchemaRequest,
  localResponses: [
    JSON.stringify({
      ...validExplicitRouterResponse,
      route_kind: "video_generation_and_download",
    }),
    JSON.stringify({
      ...validExplicitRouterResponse,
      route_kind: "research_or_summary",
      reason: "The shared source needs backend reading.",
    }),
  ],
});
assert.equal(repairedExplicitRouterEnum.result.stopped, undefined);
assert.equal(
  JSON.parse(repairedExplicitRouterEnum.result.result).route_kind,
  "research_or_summary"
);
assert.deepEqual(
  repairedExplicitRouterEnum.requests.map((item) => item.provider),
  ["deepseek", "localllm", "localllm"],
  "an invalid explicit router enum did not get one bounded LocalLLM repair"
);
const rejectedRouterEnum = repairedExplicitRouterEnum.events.find(
  (event) => event.type === "response_only.output_contract_rejected"
);
assert.deepEqual(rejectedRouterEnum?.data?.enumMismatches, ["route_kind"]);
assert.equal(
  repairedExplicitRouterEnum.events.filter(
    (event) => event.type === "response_only.output_contract_repaired"
  ).length,
  1
);
assert.equal(
  repairedExplicitRouterEnum.events.filter((event) => event.type === "session.finished").length,
  1
);

const completionAuditRequest = [
  "Audit the candidate against the current request.",
  "Return JSON only:",
  JSON.stringify({
    covered_item_ids: ["source:123"],
    missing: [],
    legitimate_blocker: false,
    complexity: "low",
    summary: "one short private diagnostic",
  }, null, 2),
  "Task packet:",
  JSON.stringify({
    request_items: [{ item_id: "source:123", text: "Return a concise direct answer." }],
    nested_worker_prompt: [
      "Return one strict JSON object and no prose:",
      JSON.stringify({ message: "", files: [], confirmation: "" }),
    ].join("\n"),
    candidate_result: {
      message: "The concise answer.",
      confirmation: "",
      files: [],
      publish_stage: {},
      generated_pdf_content: [],
      generated_text_content: [],
    },
  }, null, 2),
].join("\n");
const repairedOutputContractHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "response-only-json-contract-repaired",
  request: completionAuditRequest,
  localResponses: [
    JSON.stringify({
      message: "",
      confirmation: "",
      files: [],
      publish_stage: {},
      generated_pdf_content: [],
      generated_text_content: [],
    }),
    JSON.stringify({
      covered_item_ids: ["source:123"],
      missing: [],
      legitimate_blocker: false,
      complexity: "low",
      summary: "The current request is covered.",
    }),
  ],
});
assert.equal(repairedOutputContractHandoff.result.stopped, undefined);
assert.deepEqual(
  JSON.parse(repairedOutputContractHandoff.result.result).covered_item_ids,
  ["source:123"]
);
assert.deepEqual(
  repairedOutputContractHandoff.requests.map((item) => item.provider),
  ["deepseek", "localllm", "localllm"],
  "explicit response-only JSON contract did not get one bounded LocalLLM repair"
);
assert.equal(
  repairedOutputContractHandoff.events.filter((event) => event.type === "response_only.output_contract_rejected").length,
  1
);
assert.equal(
  repairedOutputContractHandoff.events.filter((event) => event.type === "response_only.output_contract_repaired").length,
  1
);
assert.equal(
  repairedOutputContractHandoff.events.filter((event) => event.type === "session.finished").length,
  1
);

const failedOutputContractHandoff = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "response-only-json-contract-fail-closed",
  request: completionAuditRequest,
  localResponses: [
    JSON.stringify({ message: "wrong nested object", files: [] }),
    JSON.stringify({ message: "still wrong", files: [] }),
  ],
});
assert.equal(failedOutputContractHandoff.result.stopped, true);
assert.equal(failedOutputContractHandoff.result.reason, "response_only_output_contract_required");
const failedOutputContractFallback = JSON.parse(failedOutputContractHandoff.result.result);
assert.deepEqual(
  Object.keys(failedOutputContractFallback),
  ["covered_item_ids", "missing", "legitimate_blocker", "complexity", "summary"]
);
assert.match(
  failedOutputContractFallback.summary,
  /could not produce a reliable response in the required format/i
);
assert.doesNotMatch(
  failedOutputContractFallback.summary,
  /response-only|output contract|model|session|provider|runtime|resume/iu,
  "schema-compatible contract stop exposed private runtime diagnostics"
);
assert.equal(
  failedOutputContractHandoff.events.filter((event) => event.type === "response_only.output_contract_failed_closed").length,
  1
);
assert.equal(
  failedOutputContractHandoff.events.filter((event) => event.type === "session.finished").length,
  0,
  "schema-invalid response-only output was persisted as a finished session"
);

const chineseJsonContractStop = await runSourceFreeResponseOnlyHandoffScenario({
  sessionId: "response-only-chinese-json-contract-fail-closed",
  request: [
    "Return one strict JSON object and no prose:",
    JSON.stringify({ message: "", files: [], confirmation: "" }, null, 2),
    "Current request: 用户希望得到一个简短可靠的答复。",
  ].join("\n"),
  localResponses: [
    JSON.stringify({ wrong: "第一次格式错误" }),
    JSON.stringify({ wrong: "第二次格式仍然错误" }),
  ],
});
assert.equal(chineseJsonContractStop.result.stopped, true);
const chineseJsonContractFallback = JSON.parse(chineseJsonContractStop.result.result);
assert.deepEqual(Object.keys(chineseJsonContractFallback), [
  "message",
  "files",
  "confirmation",
]);
assert.match(chineseJsonContractFallback.message, /^这条消息暂时没有生成/u);
assert.doesNotMatch(
  chineseJsonContractFallback.message,
  /response-only|输出契约|模型|会话|提供商|运行时|恢复/iu,
  "Chinese schema-compatible contract stop exposed private runtime diagnostics"
);

async function runResponseOnlyContextBudgetHandoffScenario() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-response-only-context-handoff-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  const sessionId = "response-only-context-handoff";
  await fs.mkdir(workspace, { recursive: true });

  const requests = [];
  let phase = "seed";
  const clientFactory = async (config) => ({
    chat: {
      completions: {
        create: async (payload) => {
          requests.push({
            phase,
            provider: config.provider,
            model: payload.model,
            messages: payload.messages.length,
            maxOutputTokens: Number(payload.max_tokens || 0),
          });
          if (phase === "resume" && config.provider === "deepseek") {
            throw Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
          }
          return assistant(
            phase === "seed"
              ? "Seed response-only status saved."
              : "No fresh evidence is available; I can only give an unverified local summary of the saved status."
          );
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;

  const buildConfig = ({ goal, provider, model, resume = false }) => {
    const config = resolveRuntimeConfig(
      {
        goal,
        provider,
        model,
        routeProvider: provider,
        routeModel: model,
        mainProvider: provider,
        mainModel: model,
        spareProvider: provider,
        spareModel: model,
        routingMode: "smart",
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
      allowShellTool: false,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      scsActive: false,
      dynamicSteps: "off",
      maxSteps: 4,
      modelTimeoutMs: 1_000,
      resume: resume ? sessionId : "",
      sessionId,
    });
    return config;
  };

  try {
    await runAgent(buildConfig({
      goal: [
        "Save a short response-only seed for a later same-session fallback test.",
        `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
          mode: "host-managed-response",
          request: "Save a short response-only seed for a later same-session fallback test.",
        })}`,
      ].join("\n"),
      provider: "deepseek",
      model: "deepseek-v4-pro",
    }));

    const store = new SessionStore(sessionsDir, sessionId, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    const state = await store.loadState();
    const retainedBulk = "Retained same-session status evidence from earlier work. ".repeat(4500);
    state.messages.push({ role: "assistant", content: retainedBulk });
    state.chat.push({
      role: "assistant",
      content: retainedBulk,
      at: new Date().toISOString(),
    });
    state.updatedAt = new Date().toISOString();
    await store.saveState(state);

    phase = "resume";
    const request =
      "Can you just answer from the saved status in this same session? Keep it short; no tools needed.";
    await runAgent(buildConfig({
      goal: [
        request,
        `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
          mode: "host-managed-response",
          request,
        })}`,
      ].join("\n"),
      provider: "deepseek",
      model: "deepseek-v4-pro",
      resume: true,
    }));

    const adaptedState = await store.loadState();
    adaptedState.messages = [
      { role: "system", content: "Keep the current response-only chat contract." },
      { role: "assistant", content: "x".repeat(70000) },
    ];
    adaptedState.updatedAt = new Date().toISOString();
    await store.saveState(adaptedState);

    phase = "adaptive-resume";
    const adaptiveRequest =
      "Continue from this saved chat context with one concise, explicitly unverified summary.";
    const result = await runAgent(buildConfig({
      goal: [
        adaptiveRequest,
        `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
          mode: "host-managed-response",
          request: adaptiveRequest,
        })}`,
      ].join("\n"),
      provider: "deepseek",
      model: "deepseek-v4-pro",
      resume: true,
    }));
    return {
      result,
      state: await store.loadState(),
      events: await store.loadEvents(),
      requests,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const responseOnlyContextHandoff = await runResponseOnlyContextBudgetHandoffScenario();
assert.equal(responseOnlyContextHandoff.result.stopped, undefined);
assert.deepEqual(
  responseOnlyContextHandoff.requests.map((item) => `${item.phase}:${item.provider}`),
  ["seed:deepseek", "resume:deepseek", "resume:localllm", "adaptive-resume:localllm"],
  "response-only same-session handoff did not compact and retry on LocalLLM"
);
assert.equal(responseOnlyContextHandoff.state.provider, "localllm");
assert.equal(responseOnlyContextHandoff.state.model, "localllm-deep");
assert.equal(responseOnlyContextHandoff.state.meta.providerHandoff.status, "active");
assert.equal(
  responseOnlyContextHandoff.events.filter((event) => event.type === "provider.handoff_activated").length,
  1
);
assert.equal(
  responseOnlyContextHandoff.events.filter((event) => event.type === "model.local_context_budget_exceeded").length,
  1
);
assert.equal(
  responseOnlyContextHandoff.events.filter((event) => event.type === "history.compacted_for_local_context_retry").length,
  1
);
assert.equal(
  responseOnlyContextHandoff.state.meta?.localContextOutputAdaptation?.maxOutputTokens,
  4096,
  "response-only recovery did not retain its learned LocalLLM output cap"
);
assert.equal(
  responseOnlyContextHandoff.requests.at(-1)?.maxOutputTokens,
  4096,
  "a later response-only continuation did not reuse the learned output cap"
);
assert.equal(
  responseOnlyContextHandoff.events.filter((event) => event.type === "session.failed").length,
  0,
  "response-only context recovery still failed the session before completion"
);

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
