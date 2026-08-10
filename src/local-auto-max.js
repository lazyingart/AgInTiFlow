import { normalizeProviderId } from "./provider-contract.js";
import {
  LOCALLLM_AUTO_MAX_MIN_COMPLEXITY,
  LOCALLLM_MODEL_TIERS,
  localLLMModelTier,
  normalizeLocalLLMResourceState,
} from "./model-routing.js";

export const LOCALLLM_AUTO_MAX_OUTCOMES = Object.freeze({
  DISABLED: "disabled",
  INELIGIBLE: "ineligible",
  MODEL_UNAVAILABLE: "model-unavailable",
  RESOURCE_UNKNOWN: "resource-unknown",
  RESOURCE_PRESSURE: "resource-pressure",
  SELECTED: "selected",
});
export const LOCALLLM_AUTO_MAX_POLICY_SCHEMA_VERSION = 1;

function finiteComplexity(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : -1;
}

function localAutoMaxComplexity(config = {}) {
  return config.localAutoMaxResumeEligible === true
    ? finiteComplexity(config.localAutoMaxEligibilityComplexityScore)
    : finiteComplexity(config.routeComplexityScore);
}

function availableModelAliases(readiness = {}) {
  const aliases = readiness?.checks?.models?.available;
  return Array.isArray(aliases)
    ? aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
    : [];
}

export function isLocalAutoMaxCandidate(config = {}) {
  if (config.allowLocalAutoMax !== true) return false;
  if (normalizeProviderId(config.provider, "") !== "localllm") return false;
  if (String(config.routingMode || "").trim().toLowerCase() !== "smart") return false;
  const resumeEligible = config.localAutoMaxResumeEligible === true;
  if (!resumeEligible && String(config.requestedModel || "").trim()) return false;
  if (!resumeEligible && String(config.localSelection || "").trim() !== "complexity") return false;
  const score = localAutoMaxComplexity(config);
  if (score < LOCALLLM_AUTO_MAX_MIN_COMPLEXITY) return false;
  return (localLLMModelTier(config.model)?.id || String(config.localTier || "")) === "deep";
}

export function captureLocalAutoMaxPolicy(config = {}) {
  const candidateModel = String(config.localMaxModel || LOCALLLM_MODEL_TIERS.max.model)
    .trim()
    .slice(0, 256);
  return {
    schemaVersion: LOCALLLM_AUTO_MAX_POLICY_SCHEMA_VERSION,
    optedIn: config.allowLocalAutoMax === true,
    eligible: isLocalAutoMaxCandidate(config),
    complexityScore: finiteComplexity(config.routeComplexityScore),
    candidateModel,
  };
}

export function restoreLocalAutoMaxPolicy(config = {}, policy = {}) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.schemaVersion !== LOCALLLM_AUTO_MAX_POLICY_SCHEMA_VERSION ||
    policy.optedIn !== true ||
    policy.eligible !== true ||
    finiteComplexity(policy.complexityScore) < LOCALLLM_AUTO_MAX_MIN_COMPLEXITY
  ) {
    return config;
  }
  const candidateModel = String(policy.candidateModel || "").trim();
  if (!candidateModel || candidateModel.length > 256 || /[\u0000-\u001f\u007f]/u.test(candidateModel)) return config;
  return {
    ...config,
    allowLocalAutoMax: true,
    localMaxModel: candidateModel,
    localAutoMaxResumeEligible: true,
    localAutoMaxEligibilityComplexityScore: finiteComplexity(policy.complexityScore),
  };
}

export function applyLocalAutoMaxUpgrade(config = {}, decision = {}) {
  if (decision.outcome !== LOCALLLM_AUTO_MAX_OUTCOMES.SELECTED || !decision.model) return config;
  return {
    ...config,
    model: decision.model,
    localTier: "max",
    localSelection: "runtime-auto-max",
    localUpgradeBlocked: "",
    requiresResourcePreflight: true,
    routeReason: decision.reason,
    scsModelPolicy: config.scsActive ? "selected" : config.scsModelPolicy,
    localCapabilities: {
      ...(config.localCapabilities || {}),
      maxModelAvailable: true,
    },
    localResourcePolicy: {
      ...(config.localResourcePolicy || {}),
      allowMaxAuto: true,
      status: "ready",
      sharedWorkstationPressure: false,
    },
  };
}

/**
 * Complete the second phase of automatic LocalLLM Max routing.
 *
 * Phase one is the authenticated LocalLLM readiness probe. This function only
 * trusts the model aliases returned by that probe, then takes one fresh resource
 * sample. Automatic routing degrades to Deep on an unavailable model, pressure,
 * or unknown telemetry; it never turns those optional-upgrade conditions into a
 * run failure. Cancellation remains a real cancellation and is rethrown.
 */
export async function resolveLocalAutoMaxUpgrade(
  config = {},
  readiness = {},
  { resourceProbe } = {}
) {
  if (config.allowLocalAutoMax !== true) {
    return {
      attempted: false,
      outcome: LOCALLLM_AUTO_MAX_OUTCOMES.DISABLED,
      reason: "Automatic LocalLLM Max routing is disabled.",
    };
  }
  if (!isLocalAutoMaxCandidate(config)) {
    return {
      attempted: false,
      outcome: LOCALLLM_AUTO_MAX_OUTCOMES.INELIGIBLE,
      reason: "The active route is not an automatic high-complexity LocalLLM Deep candidate.",
    };
  }

  const maxModel = String(config.localMaxModel || LOCALLLM_MODEL_TIERS.max.model).trim();
  const available = availableModelAliases(readiness);
  if (!readiness?.ok || !available.includes(maxModel)) {
    return {
      attempted: true,
      outcome: LOCALLLM_AUTO_MAX_OUTCOMES.MODEL_UNAVAILABLE,
      model: maxModel,
      reason: "Authenticated LocalLLM discovery did not report the configured Max alias; staying on Deep.",
    };
  }

  if (typeof resourceProbe !== "function") {
    return {
      attempted: true,
      outcome: LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_UNKNOWN,
      model: maxModel,
      reason: "No fresh shared-workstation resource probe was available; staying on Deep.",
    };
  }

  let resources;
  try {
    resources = await resourceProbe({ signal: config.abortSignal });
  } catch (error) {
    if (config.abortSignal?.aborted || error?.name === "AbortError") throw error;
    return {
      attempted: true,
      outcome: LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_UNKNOWN,
      model: maxModel,
      reason: "Fresh shared-workstation resource telemetry was unavailable; staying on Deep.",
    };
  }

  const resourceStatus = normalizeLocalLLMResourceState(resources?.status);
  const resourceReady =
    resources?.ready === true &&
    resourceStatus === "ready" &&
    resources?.sharedWorkstationPressure === false;
  if (!resourceReady) {
    const confirmedPressure =
      resources?.ready === false ||
      resourceStatus === "pressured" ||
      resources?.sharedWorkstationPressure === true;
    const outcome = confirmedPressure
      ? LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_PRESSURE
      : LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_UNKNOWN;
    return {
      attempted: true,
      outcome,
      model: maxModel,
      resources: resources || null,
      reason:
        outcome === LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_PRESSURE
          ? "Fresh resource telemetry reported shared-workstation pressure; staying on Deep."
          : "Fresh shared-workstation resource telemetry was unavailable; staying on Deep.",
    };
  }

  return {
    attempted: true,
    outcome: LOCALLLM_AUTO_MAX_OUTCOMES.SELECTED,
    model: maxModel,
    resources,
    reason: `Automatic LocalLLM Max selected after authenticated alias discovery and a fresh resource check; complexity score ${localAutoMaxComplexity(config)}.`,
  };
}
