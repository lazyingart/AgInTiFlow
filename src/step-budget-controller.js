import { redactSensitiveText, redactValue } from "./redaction.js";

export const DYNAMIC_STEP_MODES = ["off", "auto", "on"];

const PROGRESS_TOOL_NAMES = new Set([
  "apply_patch",
  "generate_image",
  "inspect_project",
  "open_workspace_file",
  "preview_workspace",
  "read_file",
  "read_image",
  "run_command",
  "search_files",
  "send_to_canvas",
  "web_research",
  "web_search",
  "write_file",
]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function compact(value = "", limit = 360) {
  const text = redactSensitiveText(String(value || "").replace(/\s+/g, " ").trim());
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 18)} ... [truncated]`;
}

function parseToolMessage(message) {
  if (message?.role !== "tool" || !message.content) return null;
  try {
    const parsed = JSON.parse(message.content);
    if (!parsed || typeof parsed !== "object") return null;
    return redactValue(parsed);
  } catch {
    return null;
  }
}

export function normalizeDynamicStepsMode(value = "auto") {
  const text = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "n", "disable", "disabled", "off", "never"].includes(text)) return "off";
  if (["1", "true", "yes", "y", "enable", "enabled", "on", "always"].includes(text)) return "on";
  if (["auto", "smart", ""].includes(text)) return "auto";
  return "auto";
}

export function createStepBudgetState(config = {}, state = {}) {
  const saved = state.meta?.stepBudget || {};
  const initialMaxSteps = positiveInteger(saved.initialMaxSteps, positiveInteger(config.maxSteps, 24));
  const savedCurrent = positiveInteger(saved.currentMaxSteps, initialMaxSteps);
  const currentMaxSteps = Math.max(savedCurrent, positiveInteger(config.maxSteps, initialMaxSteps), positiveInteger(state.stepsCompleted, 0));
  const scsActive = Boolean(config.scsActive);
  const defaultExtensionLimit = scsActive ? 2 : 1;
  const extensionLimit = clamp(
    positiveInteger(config.dynamicStepExtensionLimit ?? config.dynamicStepExtensions, defaultExtensionLimit),
    0,
    8
  );
  const defaultHardCap = Math.min(
    96,
    Math.max(initialMaxSteps + (scsActive ? 8 : 6), Math.ceil(initialMaxSteps * (scsActive ? 2.5 : 2)))
  );
  const hardCap = Math.max(currentMaxSteps, positiveInteger(config.dynamicStepHardCap, defaultHardCap));
  const mode = normalizeDynamicStepsMode(config.dynamicSteps ?? "auto");
  const disabledForMockAuto = mode === "auto" && config.provider === "mock";
  return {
    mode,
    enabled: mode !== "off" && !disabledForMockAuto && extensionLimit > 0,
    initialMaxSteps,
    currentMaxSteps,
    extensionLimit,
    hardCap,
    extensionsUsed: clamp(positiveInteger(saved.extensionsUsed, 0), 0, extensionLimit),
    lastExtensionStep: positiveInteger(saved.lastExtensionStep, 0),
    monitor: scsActive ? "scs-student" : "runtime",
  };
}

export function serializeStepBudgetState(budget = {}) {
  return {
    mode: budget.mode || "auto",
    enabled: Boolean(budget.enabled),
    monitor: budget.monitor || "runtime",
    initialMaxSteps: positiveInteger(budget.initialMaxSteps, 0),
    currentMaxSteps: positiveInteger(budget.currentMaxSteps, 0),
    hardCap: positiveInteger(budget.hardCap, 0),
    extensionLimit: positiveInteger(budget.extensionLimit, 0),
    extensionsUsed: positiveInteger(budget.extensionsUsed, 0),
    lastExtensionStep: positiveInteger(budget.lastExtensionStep, 0),
  };
}

export function shouldCheckStepBudget(step, budget = {}, options = {}) {
  if (!budget.enabled) return false;
  const currentStep = positiveInteger(step, 0);
  if (!currentStep) return false;
  if (currentStep >= budget.hardCap) return true;
  const threshold = clamp(positiveInteger(options.threshold ?? 2, 2), 1, 8);
  return budget.currentMaxSteps - currentStep <= threshold;
}

export function summarizeRecentToolResults(state = {}, limit = 8) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.map(parseToolMessage).filter(Boolean).slice(-limit);
}

function hasConcreteProgress(recentToolResults = [], events = []) {
  if (
    events
      .slice(-24)
      .some((event) => event?.type === "file.changed" || event?.type === "canvas.item" || event?.type === "tool.completed")
  ) {
    return true;
  }
  return recentToolResults.some((result) => {
    if (result.ok === false || result.blocked || result.done) return false;
    if (!PROGRESS_TOOL_NAMES.has(result.toolName)) return false;
    if (result.toolName === "run_command") return Boolean(result.stdout || result.stderr || result.exitCode === 0);
    return Boolean(
      result.path ||
        result.artifactPath ||
        result.summary ||
        result.counts ||
        result.results?.length ||
        result.changes?.length ||
        result.content ||
        result.url ||
        result.title ||
        result.ok === true
    );
  });
}

function activeBlocker(recentToolResults = []) {
  const lastResults = recentToolResults.slice(-4);
  const lastSuccessIndex = lastResults.findLastIndex((result) => result.ok !== false && !result.blocked && !result.error);
  const afterLastSuccess = lastSuccessIndex >= 0 ? lastResults.slice(lastSuccessIndex + 1) : lastResults;
  const blockers = afterLastSuccess.filter((result) => result.blocked || result.ok === false || result.error || result.reason);
  if (blockers.length < 2 && !blockers.some((result) => result.permissionAdvice)) return null;
  const blocker = blockers.at(-1);
  const reasonText = [
    blocker?.reason,
    blocker?.error,
    blocker?.category,
    blocker?.permissionAdvice?.reason,
    blocker?.permissionAdvice?.suggestedCommand,
  ]
    .filter(Boolean)
    .join(" ");
  if (/permission|approval|blocked|destructive|outside|install|policy|secret|forbidden|requires/i.test(reasonText)) {
    return compact(reasonText, 360);
  }
  if (blockers.length >= 2) return compact(reasonText || "recent repeated tool failures", 360);
  return null;
}

function extensionSize(config = {}, budget = {}, monitor = "runtime") {
  const configured = Number(config.dynamicStepExtensionSize);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const ratio = monitor === "scs-student" ? 0.4 : 0.33;
  const min = monitor === "scs-student" ? 8 : 6;
  const max = monitor === "scs-student" ? 16 : 12;
  return clamp(Math.ceil(budget.initialMaxSteps * ratio), min, max);
}

function decisionPayload(decision, data = {}) {
  return {
    checked: true,
    approved: decision === "extend_steps",
    decision,
    extraSteps: positiveInteger(data.extraSteps ?? data.extra_steps, 0),
    monitor: data.monitor || "runtime",
    trigger: data.trigger || "near-limit",
    reason: compact(data.reason || "", 520),
    evidence: Array.isArray(data.evidence) ? data.evidence.map((item) => compact(item, 220)).filter(Boolean).slice(0, 8) : [],
    initialMaxSteps: positiveInteger(data.initialMaxSteps, 0),
    currentMaxSteps: positiveInteger(data.currentMaxSteps, 0),
    hardCap: positiveInteger(data.hardCap, 0),
    extensionsUsed: positiveInteger(data.extensionsUsed, 0),
    extensionLimit: positiveInteger(data.extensionLimit, 0),
    stepsCompleted: positiveInteger(data.stepsCompleted, 0),
  };
}

export function decideStepBudgetExtension({ config = {}, state = {}, budget = {}, step = 0, events = [], trigger = "near-limit" } = {}) {
  const stepsCompleted = positiveInteger(step || state.stepsCompleted, 0);
  const base = {
    monitor: budget.monitor || (config.scsActive ? "scs-student" : "runtime"),
    trigger,
    initialMaxSteps: budget.initialMaxSteps,
    currentMaxSteps: budget.currentMaxSteps,
    hardCap: budget.hardCap,
    extensionsUsed: budget.extensionsUsed,
    extensionLimit: budget.extensionLimit,
    stepsCompleted,
  };
  if (!shouldCheckStepBudget(stepsCompleted, budget)) {
    return { checked: false, approved: false, decision: "not_near_limit", ...base };
  }
  if (budget.extensionsUsed >= budget.extensionLimit) {
    return decisionPayload("deny_extension", {
      ...base,
      reason: "Step budget extension limit reached.",
    });
  }
  if (stepsCompleted >= budget.hardCap || budget.currentMaxSteps >= budget.hardCap) {
    return decisionPayload("deny_extension", {
      ...base,
      reason: "Dynamic step hard cap reached.",
    });
  }

  const recentToolResults = summarizeRecentToolResults(state, 8);
  const blocker = activeBlocker(recentToolResults);
  if (blocker) {
    return decisionPayload("deny_extension", {
      ...base,
      reason: `Recent blocker requires a different permission/setup path, not more steps: ${blocker}`,
      evidence: recentToolResults.slice(-3).map((result) => `${result.toolName || "tool"} ok=${result.ok !== false} blocked=${Boolean(result.blocked)}`),
    });
  }

  if (!hasConcreteProgress(recentToolResults, events)) {
    return decisionPayload("deny_extension", {
      ...base,
      reason: "No recent concrete tool/file/artifact progress was observed.",
      evidence: recentToolResults.slice(-3).map((result) => `${result.toolName || "tool"} ok=${result.ok !== false}`),
    });
  }

  const remainingCap = budget.hardCap - budget.currentMaxSteps;
  const extraSteps = Math.min(extensionSize(config, budget, base.monitor), remainingCap);
  if (extraSteps <= 0) {
    return decisionPayload("deny_extension", {
      ...base,
      reason: "No dynamic step capacity remains under the hard cap.",
    });
  }
  return decisionPayload("extend_steps", {
    ...base,
    extraSteps,
    reason: "Recent verified tool progress exists and a bounded continuation can still finish or verify the task.",
    evidence: recentToolResults
      .filter((result) => result.ok !== false && !result.blocked)
      .slice(-4)
      .map((result) => `${result.toolName || "tool"}${result.path ? ` path=${result.path}` : ""}${result.summary ? ` summary=${compact(result.summary, 120)}` : ""}`),
  });
}

export function applyStepBudgetExtension(budget = {}, decision = {}) {
  if (!decision.approved || decision.extraSteps <= 0) return { ...decision, applied: false };
  const approvedExtraSteps = Math.min(decision.extraSteps, Math.max(0, budget.hardCap - budget.currentMaxSteps));
  if (approvedExtraSteps <= 0) {
    return {
      ...decision,
      approved: false,
      applied: false,
      decision: "deny_extension",
      reason: "No capacity remains under the dynamic step hard cap.",
      extraSteps: 0,
    };
  }
  budget.currentMaxSteps += approvedExtraSteps;
  budget.extensionsUsed += 1;
  budget.lastExtensionStep = positiveInteger(decision.stepsCompleted, budget.lastExtensionStep || 0);
  return {
    ...decision,
    applied: true,
    approvedExtraSteps,
    extraSteps: approvedExtraSteps,
    currentMaxSteps: budget.currentMaxSteps,
    extensionsUsed: budget.extensionsUsed,
    hardCap: budget.hardCap,
  };
}
