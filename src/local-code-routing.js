import { LOCALLLM_MODEL_TIERS, localLLMModelTier } from "./model-routing.js";
import { normalizeProviderId } from "./provider-contract.js";

export const LOCALLLM_CODE_ROUTE_OUTCOMES = Object.freeze({
  INELIGIBLE: "ineligible",
  READINESS_UNVERIFIED: "readiness-unverified",
  MODEL_UNAVAILABLE: "model-unavailable",
  SELECTED: "selected",
});

export const LOCALLLM_CODE_POLICY_SCHEMA_VERSION = 1;

function safeModel(value, fallback = "") {
  const model = String(value || fallback).trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) return "";
  return model;
}

function authenticatedAvailableAliases(readiness = {}) {
  if (
    readiness?.ok !== true ||
    readiness?.checks?.authentication?.ok !== true ||
    readiness?.checks?.models?.ok !== true ||
    !Array.isArray(readiness?.checks?.models?.available)
  ) {
    return null;
  }
  return readiness.checks.models.available
    .map((alias) => safeModel(alias))
    .filter(Boolean);
}

export function isLocalCodeRouteCandidate(config = {}) {
  if (normalizeProviderId(config.provider, "") !== "localllm") return false;
  if (String(config.routingMode || "").trim().toLowerCase() !== "smart") return false;
  if (config.localCodeCandidate !== true && config.localCodeResumeEligible !== true) return false;
  const candidateModel = safeModel(config.localCodeModel, LOCALLLM_MODEL_TIERS.code.model);
  const fallbackModel = safeModel(config.localCodeFallbackModel, LOCALLLM_MODEL_TIERS.deep.model);
  const activeModel = safeModel(config.model);
  if (!candidateModel || !fallbackModel || candidateModel === fallbackModel) return false;
  if (activeModel === candidateModel) return false;
  return activeModel === fallbackModel || localLLMModelTier(activeModel)?.id === "deep";
}

export function captureLocalCodePolicy(config = {}) {
  return {
    schemaVersion: LOCALLLM_CODE_POLICY_SCHEMA_VERSION,
    eligible: isLocalCodeRouteCandidate(config),
    candidateModel: safeModel(config.localCodeModel, LOCALLLM_MODEL_TIERS.code.model),
    fallbackModel: safeModel(config.localCodeFallbackModel, LOCALLLM_MODEL_TIERS.deep.model),
  };
}

export function restoreLocalCodePolicy(config = {}, policy = {}) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.schemaVersion !== LOCALLLM_CODE_POLICY_SCHEMA_VERSION ||
    policy.eligible !== true ||
    normalizeProviderId(config.provider, "") !== "localllm"
  ) {
    return config;
  }
  const candidateModel = safeModel(policy.candidateModel);
  const fallbackModel = safeModel(policy.fallbackModel);
  if (!candidateModel || !fallbackModel || candidateModel === fallbackModel) return config;
  return {
    ...config,
    localCodeCandidate: true,
    localCodeResumeEligible: true,
    localCodeModel: candidateModel,
    localCodeFallbackModel: fallbackModel,
  };
}

export function resolveLocalCodeRoute(config = {}, readiness = {}) {
  if (!isLocalCodeRouteCandidate(config)) {
    return {
      attempted: false,
      outcome: LOCALLLM_CODE_ROUTE_OUTCOMES.INELIGIBLE,
      reason: "The active route is not a smart LocalLLM implementation candidate.",
    };
  }

  const model = safeModel(config.localCodeModel, LOCALLLM_MODEL_TIERS.code.model);
  const fallbackModel = safeModel(config.localCodeFallbackModel, LOCALLLM_MODEL_TIERS.deep.model);
  const available = authenticatedAvailableAliases(readiness);
  if (!available) {
    return {
      attempted: true,
      outcome: LOCALLLM_CODE_ROUTE_OUTCOMES.READINESS_UNVERIFIED,
      model,
      fallbackModel,
      reason: "Authenticated LocalLLM model discovery was not proven; staying on Deep.",
    };
  }
  if (!available.includes(model)) {
    return {
      attempted: true,
      outcome: LOCALLLM_CODE_ROUTE_OUTCOMES.MODEL_UNAVAILABLE,
      model,
      fallbackModel,
      reason: "Authenticated LocalLLM discovery did not report the configured coding alias; staying on Deep.",
    };
  }
  return {
    attempted: true,
    outcome: LOCALLLM_CODE_ROUTE_OUTCOMES.SELECTED,
    model,
    fallbackModel,
    reason: "Coding specialist selected after high-confidence implementation routing and authenticated alias discovery.",
  };
}

export function applyLocalCodeRoute(config = {}, decision = {}) {
  if (decision.outcome === LOCALLLM_CODE_ROUTE_OUTCOMES.SELECTED && decision.model) {
    return {
      ...config,
      provider: "localllm",
      model: decision.model,
      localTier: "code",
      localSelection: "runtime-authenticated-code",
      localUpgradeBlocked: "",
      requiresResourcePreflight: false,
      routeReason: decision.reason,
      scsModelPolicy: config.scsActive ? "selected" : config.scsModelPolicy,
      localCapabilities: {
        ...(config.localCapabilities || {}),
        codeModelAvailable: true,
      },
    };
  }
  if (!decision.attempted || !decision.fallbackModel) return config;
  const fallbackTier = localLLMModelTier(decision.fallbackModel)?.id || "deep";
  return {
    ...config,
    provider: "localllm",
    model: decision.fallbackModel,
    localTier: fallbackTier,
    localSelection: "runtime-code-fallback",
    localUpgradeBlocked: decision.outcome,
    requiresResourcePreflight: fallbackTier === "max",
    routeReason: decision.reason,
  };
}
