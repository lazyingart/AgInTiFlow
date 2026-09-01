import { normalizeTaskProfile } from "./task-profiles.js";

export const EXECUTION_TIERS = ["focused", "thorough"];

const THOROUGH_PROFILES = new Set([
  "android",
  "app",
  "devops",
  "github",
  "ios",
  "large-codebase",
  "maintenance",
  "pipeline",
  "qa",
  "security",
  "supervision",
  "website",
]);

export function normalizeExecutionTier(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["focused", "fast", "light", "linear", "simple"].includes(text)) return "focused";
  if (["thorough", "deep", "complex", "robust", "scs"].includes(text)) return "thorough";
  return "";
}

export function selectExecutionPolicy({
  requestedTier = "",
  routingMode = "smart",
  taskProfile = "auto",
  complexityScore = 0,
  scsActive = false,
  responseOnly = false,
} = {}) {
  const profile = normalizeTaskProfile(taskProfile);
  const score = Number(complexityScore || 0);
  if (responseOnly) {
    return {
      tier: "focused",
      requiresPlan: false,
      reason: "The explicit response-only scope requires one direct model turn without execution planning.",
    };
  }
  if (scsActive) {
    return {
      tier: "thorough",
      requiresPlan: true,
      reason: "SCS evidence validation requires a phase plan.",
    };
  }
  const explicitTier = normalizeExecutionTier(requestedTier);
  if (explicitTier) {
    return {
      tier: explicitTier,
      requiresPlan: explicitTier === "thorough",
      reason: `Execution tier selected explicitly: ${explicitTier}.`,
    };
  }
  if (String(routingMode || "").toLowerCase() === "complex") {
    return {
      tier: "thorough",
      requiresPlan: true,
      reason: "The complex routing mode requires an explicit execution plan.",
    };
  }
  if (score >= 3) {
    return {
      tier: "thorough",
      requiresPlan: true,
      reason: `Task complexity score ${score} requires planned execution.`,
    };
  }
  if (THOROUGH_PROFILES.has(profile)) {
    return {
      tier: "thorough",
      requiresPlan: true,
      reason: `Task profile "${profile}" requires planned execution.`,
    };
  }
  return {
    tier: "focused",
    requiresPlan: false,
    reason: `Low-cost focused execution selected for complexity score ${score}.`,
  };
}

export function maxStepsForExecutionPolicy(defaultMaxSteps, policy = {}, { explicit = false } = {}) {
  const value = Number(defaultMaxSteps);
  const normalized = Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
  if (explicit || policy.tier !== "focused") return normalized;
  return Math.min(normalized, 12);
}
