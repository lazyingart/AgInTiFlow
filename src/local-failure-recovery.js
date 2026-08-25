import { LOCALLLM_MODEL_TIERS, localLLMModelTier } from "./model-routing.js";
import { normalizeProviderId } from "./provider-contract.js";

const RECOVERABLE_TOOL_NAMES = new Set([
  "apply_patch",
  "write_file",
  "run_command",
]);

const STRONG_LOCAL_TIERS = new Set(["deep", "code"]);

function safeModel(value = "") {
  const model = String(value || "").trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) return "";
  return model;
}

function recoverableFailureWindow(state = {}) {
  const recent = Array.isArray(state.meta?.toolLoop?.recent)
    ? state.meta.toolLoop.recent.slice(-20)
    : [];
  let lastProgressIndex = -1;
  recent.forEach((entry, index) => {
    if (
      RECOVERABLE_TOOL_NAMES.has(String(entry?.toolName || "")) &&
      entry?.ok === true &&
      entry?.blocked !== true
    ) {
      lastProgressIndex = index;
    }
  });
  return recent.slice(lastProgressIndex + 1).filter((entry) =>
    RECOVERABLE_TOOL_NAMES.has(String(entry?.toolName || "")) &&
    entry?.ok === false &&
    entry?.blocked !== true
  );
}

function contractViolationCount(state = {}) {
  const violation = state.meta?.toolContractViolation;
  return Math.max(0, Number(violation?.consecutive ?? violation?.count ?? 0));
}

function configuredRecoveryModels(config = {}) {
  const candidates = [];
  if (normalizeProviderId(config.mainProvider, "") === "localllm") {
    candidates.push(config.mainModel);
  }
  if (normalizeProviderId(config.spareProvider, "") === "localllm") {
    candidates.push(config.spareModel);
  }
  candidates.push(config.localCodeFallbackModel, LOCALLLM_MODEL_TIERS.deep.model);
  return [...new Set(candidates.map((model) => safeModel(model)).filter(Boolean))];
}

function selectRecoveryModel(config = {}, currentModel = "") {
  for (const candidate of configuredRecoveryModels(config)) {
    if (candidate === currentModel) continue;
    const tier = localLLMModelTier(candidate)?.id || "";
    if (STRONG_LOCAL_TIERS.has(tier)) return candidate;
  }
  return "";
}

export function decideLocalFailureRecovery(config = {}, state = {}) {
  const existing = state.meta?.localFailureRecovery;
  if (existing?.active === true && safeModel(existing.model)) {
    return {
      active: true,
      activated: false,
      model: safeModel(existing.model),
      fromModel: safeModel(existing.fromModel || config.model),
      reason: String(existing.reason || "Persisted local failure recovery route."),
      failureCount: Number(existing.failureCount || 0),
      repeatedSignatureCount: Number(existing.repeatedSignatureCount || 0),
      contractViolationCount: Number(existing.contractViolationCount || 0),
      failedTools: Array.isArray(existing.failedTools) ? existing.failedTools : [],
    };
  }

  if (config.localFailureRecovery === false) return { active: false, reason: "disabled" };
  if (normalizeProviderId(config.provider, "") !== "localllm") {
    return { active: false, reason: "non-local-provider" };
  }
  if (String(config.routingMode || "").trim().toLowerCase() !== "smart") {
    return { active: false, reason: "non-smart-routing" };
  }

  const currentModel = safeModel(config.model);
  const currentTier = localLLMModelTier(currentModel)?.id || "";
  const routeModel = safeModel(config.routeModel);
  const failures = recoverableFailureWindow(state);
  const invalidContractCalls = contractViolationCount(state);
  if (
    currentTier !== "fast" &&
    (!routeModel || currentModel !== routeModel) &&
    invalidContractCalls < 2
  ) {
    return { active: false, reason: "already-strong-route" };
  }
  const signatureCounts = new Map();
  for (const entry of failures) {
    const signature = String(entry?.signature || `${entry?.toolName || "unknown"}:unknown`);
    signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
  }
  const repeatedSignatureCount = Math.max(0, ...signatureCounts.values());
  if (repeatedSignatureCount < 2 && failures.length < 3 && invalidContractCalls < 2) {
    return {
      active: false,
      reason: "insufficient-failure-evidence",
      failureCount: failures.length,
      repeatedSignatureCount,
      contractViolationCount: invalidContractCalls,
    };
  }

  const model = selectRecoveryModel(config, currentModel);
  if (!model) {
    return {
      active: false,
      reason: "no-strong-local-recovery-model",
      failureCount: failures.length,
      repeatedSignatureCount,
      contractViolationCount: invalidContractCalls,
    };
  }

  return {
    active: true,
    activated: true,
    model,
    fromModel: currentModel,
    reason:
      invalidContractCalls >= 2
        ? "The current local route repeatedly returned tool calls that did not match the offered schemas."
        : repeatedSignatureCount >= 2
        ? "The current local route repeated a failing tool call without verified progress."
        : "The current local route accumulated several tool failures without verified progress.",
    failureCount: failures.length + invalidContractCalls,
    repeatedSignatureCount,
    contractViolationCount: invalidContractCalls,
    failedTools: [
      ...new Set([
        ...failures.map((entry) => String(entry?.toolName || "unknown")),
        ...(invalidContractCalls >= 2 ? ["tool_call_batch"] : []),
      ]),
    ],
  };
}

export function activateLocalFailureRecovery(config = {}, state = {}) {
  const decision = decideLocalFailureRecovery(config, state);
  if (!decision.active || !decision.activated) return decision;
  state.meta = state.meta || {};
  state.meta.localFailureRecovery = {
    active: true,
    model: decision.model,
    fromModel: decision.fromModel,
    reason: decision.reason,
    failureCount: decision.failureCount,
    repeatedSignatureCount: decision.repeatedSignatureCount,
    contractViolationCount: decision.contractViolationCount || 0,
    failedTools: decision.failedTools || [],
    activatedAt: new Date().toISOString(),
  };
  return decision;
}

export function applyLocalFailureRecovery(config = {}, state = {}) {
  const recovery = state.meta?.localFailureRecovery;
  const model = recovery?.active === true ? safeModel(recovery.model) : "";
  if (!model || normalizeProviderId(config.provider, "") !== "localllm") return config;
  return {
    ...config,
    model,
    localTier: localLLMModelTier(model)?.id || "deep",
    localSelection: "runtime-tool-failure-recovery",
    localFailureRecoveryActive: true,
    localFailureRecoveryFailedTools: Array.isArray(recovery.failedTools)
      ? recovery.failedTools
      : [],
    routeReason: String(recovery.reason || "Recovered a stalled local tool route."),
    requiresResourcePreflight: false,
  };
}

export function localFailureRecoveryInstruction(decision = {}) {
  return [
    `Runtime recovery: the local route changed from ${decision.fromModel || "the fast model"} to ${decision.model || "the configured stronger local model"}.`,
    decision.reason || "Repeated tool failures showed no verified progress.",
    decision.contractViolationCount >= 2
      ? "The invalid calls were rejected before dispatch; use only the currently offered tool names and exact argument schemas."
      : "",
    "Continue from the current files and evidence; preserve successful work and do not restart the task.",
    "Do not repeat the failing call. Re-read the exact target and latest error, choose one different bounded edit or command, then rerun the smallest relevant verification.",
  ].filter(Boolean).join(" ");
}
