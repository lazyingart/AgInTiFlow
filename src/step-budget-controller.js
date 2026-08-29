import path from "node:path";
import { redactSensitiveText, redactValue } from "./redaction.js";

export const DYNAMIC_STEP_MODES = ["off", "auto", "on"];

const PROGRESS_TOOL_NAMES = new Set([
  "apply_patch",
  "generate_image",
  "inspect_project",
  "json_specialist",
  "json_specialist_batch",
  "open_workspace_file",
  "preview_workspace",
  "read_file",
  "read_image",
  "run_command",
  "search_files",
  "send_to_canvas",
  "deep_research",
  "read_web_page",
  "web_research",
  "web_search",
  "writing_specialist",
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
  const resetFromExplicitOverride = config.resetStepBudget === true;
  const saved = resetFromExplicitOverride ? {} : state.meta?.stepBudget || {};
  const initialMaxSteps = positiveInteger(saved.initialMaxSteps, positiveInteger(config.maxSteps, 24));
  const savedCurrent = positiveInteger(saved.currentMaxSteps, initialMaxSteps);
  const currentMaxSteps = Math.max(savedCurrent, positiveInteger(config.maxSteps, initialMaxSteps), positiveInteger(state.stepsCompleted, 0));
  const scsActive = Boolean(config.scsActive);
  const defaultExtensionLimit = 3;
  const configuredExtensionLimit = positiveInteger(
    config.dynamicStepExtensionLimit ?? config.dynamicStepExtensions,
    defaultExtensionLimit
  );
  const extensionLimitExplicit = config.dynamicStepExtensionLimitExplicit !== undefined
    ? config.dynamicStepExtensionLimitExplicit === true
    : Object.prototype.hasOwnProperty.call(config, "dynamicStepExtensionLimit");
  const extensionLimit = clamp(
    extensionLimitExplicit
      ? configuredExtensionLimit
      : Math.max(configuredExtensionLimit, defaultExtensionLimit),
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
    resetFromExplicitOverride,
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
    resetFromExplicitOverride: Boolean(budget.resetFromExplicitOverride),
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

export function shouldEvaluateResumeBoundary(config = {}, state = {}, budget = {}) {
  if (!config.resume || !budget.enabled) return false;
  const stepsCompleted = positiveInteger(state.stepsCompleted, 0);
  if (stepsCompleted < positiveInteger(budget.currentMaxSteps, 0)) return false;
  if (stepsCompleted >= positiveInteger(budget.hardCap, 0)) return false;
  return positiveInteger(budget.extensionsUsed, 0) < positiveInteger(budget.extensionLimit, 0);
}

export function summarizeRecentToolResults(state = {}, limit = 8) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.map(parseToolMessage).filter(Boolean).slice(-limit);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isStaticDiscoveryToolCall(toolName, args = {}) {
  if (["inspect_project", "list_files", "read_file", "search_files", "read_image"].includes(toolName)) return true;
  if (toolName !== "run_command") return false;
  const command = String(args.command || "").trim();
  if (!command) return false;
  if (/\s--?(?:help|version)\b/i.test(command)) return true;
  if (/\b(?:watch|poll|status|queue|sleep)\b|tail\s+-f|\bcurl\b|\bps\b|tmux\s+capture-pane/i.test(command)) return false;
  return /^(?:env\s+)?(?:ls\b|find\b|rg\b|grep\b|cat\b|head\b|sed\s+-n\b|wc\b|stat\b|file\b|realpath\b|readlink\b|jq\b)/i.test(
    command
  );
}

function canonicalDiscoveryPath(value, commandCwd = process.cwd()) {
  const raw = String(value || ".").trim() || ".";
  return path.resolve(commandCwd || process.cwd(), raw);
}

function simpleLsPath(command = "", commandCwd = process.cwd()) {
  const match = String(command || "")
    .trim()
    .match(/^(?:env\s+)?ls(?:\s+-[A-Za-z]+)*\s+([^;&|<>]+)$/i);
  if (!match) return "";
  const rawPath = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!rawPath || /\s/.test(rawPath)) return "";
  return canonicalDiscoveryPath(rawPath, commandCwd);
}

export function staticToolCallSignature(toolName, args = {}, context = {}) {
  const commandCwd = context.commandCwd || process.cwd();
  if (toolName === "list_files") {
    return `filesystem-list:${canonicalDiscoveryPath(args.path, commandCwd)}`;
  }
  if (toolName === "inspect_project") {
    return `project-inspect:${canonicalDiscoveryPath(args.path, commandCwd)}`;
  }
  if (toolName === "read_file") {
    return `file-read:${stableStringify({
      path: canonicalDiscoveryPath(args.path, commandCwd),
      startLine: Number(args.startLine || 1),
      lineLimit: Number(args.lineLimit || args.limit || 0),
    })}`;
  }
  if (toolName === "search_files") {
    return `file-search:${stableStringify({
      path: canonicalDiscoveryPath(args.path, commandCwd),
      query: String(args.query || "").trim(),
      caseSensitive: Boolean(args.caseSensitive),
    })}`;
  }
  if (toolName === "run_command") {
    const lsPath = simpleLsPath(args.command, commandCwd);
    if (lsPath) return `filesystem-list:${lsPath}`;
  }
  return `${toolName}:${stableStringify(args || {})}`;
}

function isStaticDiscoveryResult(result = {}) {
  if (!result || result.ok === false || result.blocked || result.done) return false;
  if (isStaticDiscoveryToolCall(result.toolName, result.args || {})) return true;
  if (result.toolName !== "run_command") return false;
  if (/\b(?:watch|poll|status|queue|sleep)\b|tail\s+-f|tmux\s+capture-pane/i.test(String(result.args?.command || ""))) {
    return false;
  }
  return !runCommandHasConcreteProgress(result);
}

function runCommandHasConcreteProgress(result = {}) {
  const policy = result.commandPolicy || {};
  const policyAllowsMutation =
    policy.mayMutateProject === true ||
    (policy.mayMutateProject === undefined && policy.writesWorkspace === true);
  return Boolean(
    policyAllowsMutation ||
      policy.substantiveTest === true ||
      (Array.isArray(result.verifiedGeneratedOutputPaths) &&
        result.verifiedGeneratedOutputPaths.length > 0)
  );
}

export function summarizeRepeatedStaticDiscovery(recentToolResults = [], context = {}) {
  const signatures = recentToolResults
    .filter(isStaticDiscoveryResult)
    .map((result) => staticToolCallSignature(result.toolName, result.args || {}, context));
  const counts = new Map();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1);
  return {
    total: signatures.length,
    unique: counts.size,
    duplicateCount: repeated.reduce((sum, [, count]) => sum + count - 1, 0),
    repeated: repeated.map(([signature, count]) => ({ signature: compact(signature, 220), count })),
  };
}

export function summarizeStagnantValidationLoop(events = [], options = {}) {
  const minimumMutationPhases = clamp(
    positiveInteger(options.minimumMutationPhases, 3),
    2,
    8
  );
  const source = Array.isArray(events) ? events : [];
  const latestGoalBoundary = source.findLastIndex(
    (event) => String(event?.type || event?.event || "") === "goal.updated"
  );
  const scoped = latestGoalBoundary >= 0 ? source.slice(latestGoalBoundary) : source;
  let mutationPhase = 0;
  let latestFailure = null;
  const failuresByKey = new Map();

  for (const event of scoped) {
    const type = String(event?.type || event?.event || "");
    const data = event?.data || event?.payload || {};
    if (type === "file.changed") {
      mutationPhase += 1;
      continue;
    }
    if (type !== "tool.completed") continue;
    const test = data?.projectTest;
    const command = String(test?.command || data?.requiredProjectCommand || "").trim();
    if (!command) continue;
    if (test?.passed === true) {
      for (const key of [...failuresByKey.keys()]) {
        if (key.startsWith(`${command}\n`)) failuresByKey.delete(key);
      }
      latestFailure = null;
      continue;
    }
    const failureSignature = String(test?.failureSignature || "").trim();
    if (!failureSignature) continue;
    const key = `${command}\n${failureSignature}`;
    const attempt = {
      command,
      failureSignature,
      mutationPhase,
      at: String(event?.at || event?.timestamp || ""),
    };
    const attempts = failuresByKey.get(key) || [];
    attempts.push(attempt);
    failuresByKey.set(key, attempts);
    latestFailure = { key, ...attempt };
  }

  if (!latestFailure || latestFailure.mutationPhase !== mutationPhase) {
    return {
      detected: false,
      mutationPhase,
      attempts: 0,
      mutationPhases: 0,
    };
  }
  const attempts = failuresByKey.get(latestFailure.key) || [];
  const mutationPhases = new Set(attempts.map((attempt) => attempt.mutationPhase));
  return {
    detected: mutationPhases.size >= minimumMutationPhases,
    command: latestFailure.command,
    failureSignature: latestFailure.failureSignature,
    attempts: attempts.length,
    mutationPhases: mutationPhases.size,
    mutationPhase,
    lastFailureAt: latestFailure.at,
  };
}

function currentFailedTestRecoveryPacket(state = {}, stagnantValidation = {}) {
  const packet = state.meta?.failedTestRecoveryPacket;
  const verification = state.meta?.projectVerification || {};
  const lastFailure = verification.lastFailedTest ||
    (Array.isArray(verification.testRuns)
      ? [...verification.testRuns].reverse().find((test) => test?.passed === false)
      : null);
  if (!packet || !lastFailure || !String(packet.content || "").trim()) return null;
  if (
    String(packet.failureSignature || "") !==
      String(stagnantValidation.failureSignature || lastFailure.failureSignature || "") ||
    String(lastFailure.failureSignature || "") !==
      String(stagnantValidation.failureSignature || "") ||
    String(packet.command || "").trim() !== String(lastFailure.command || "").trim() ||
    String(lastFailure.command || "").trim() !==
      String(stagnantValidation.command || "").trim() ||
    Number(packet.mutationRevision || 0) !== Number(lastFailure.mutationRevision || 0)
  ) {
    return null;
  }
  const packetAt = Date.parse(String(packet.generatedAt || ""));
  const failureAt = Date.parse(String(lastFailure.at || ""));
  if (
    Number.isFinite(packetAt) &&
    Number.isFinite(failureAt) &&
    packetAt < failureAt
  ) {
    return null;
  }
  return packet;
}

function hasConcreteProgress(recentToolResults = [], events = []) {
  const recentMeaningfulEvents = events
    .filter((event) =>
      [
        "file.changed",
        "canvas.item",
        "image.generated",
        "tool.completed",
        "tool.failed",
        "tool.blocked",
        "provider.local_failure_recovery",
        "history.compacted_for_context_budget",
      ].includes(event?.type)
    )
    .slice(-24);
  if (
    recentMeaningfulEvents
      .some((event) => event?.type === "file.changed" || event?.type === "canvas.item" || event?.type === "image.generated")
  ) {
    return true;
  }
  return recentToolResults.some((result) => {
    if (result.ok === false || result.blocked || result.done) return false;
    if (isStaticDiscoveryToolCall(result.toolName, result.args || {})) return false;
    if (!PROGRESS_TOOL_NAMES.has(result.toolName)) return false;
    if (result.toolName === "run_command") return runCommandHasConcreteProgress(result);
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
  if (
    /permission|approval|destructive|outside (?:the )?(?:workspace|allowed)|install|policy|secret|forbidden|captcha|login|credential|authentication|network unavailable|requires (?:human|login|authentication|credentials?)/i.test(
      reasonText
    )
  ) {
    return compact(reasonText, 360);
  }
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

  const repeatedDiscovery = summarizeRepeatedStaticDiscovery(recentToolResults, {
    commandCwd: config.commandCwd,
  });
  if (repeatedDiscovery.duplicateCount >= 3) {
    return decisionPayload("deny_extension", {
      ...base,
      reason:
        "Recent steps repeated the same static discovery calls without a file, artifact, or state transition. More steps would extend a loop rather than finish the task.",
      evidence: repeatedDiscovery.repeated.map((item) => `${item.count}x ${item.signature}`),
    });
  }

  const stagnantValidation = summarizeStagnantValidationLoop(events);
  const boundedDiagnosticRecovery = Boolean(
    stagnantValidation.detected &&
      budget.extensionsUsed === 0 &&
      currentFailedTestRecoveryPacket(state, stagnantValidation)
  );
  if (stagnantValidation.detected) {
    if (!boundedDiagnosticRecovery) {
      return decisionPayload("deny_extension", {
        ...base,
        reason:
          "The same validation failure persisted across multiple file-mutation phases. More steps would extend a non-converging repair loop rather than advance the acceptance evidence.",
        evidence: [
          `${stagnantValidation.mutationPhases} mutation phases retained failure ${stagnantValidation.failureSignature}`,
          `command=${compact(stagnantValidation.command, 180)}`,
        ],
      });
    }
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
    reason: boundedDiagnosticRecovery
      ? "A fresh failure-scoped recovery packet exists after the repeated validator result. Grant one bounded diagnostic continuation; later unchanged failures remain subject to the non-convergence guard."
      : "Recent verified tool progress exists and a bounded continuation can still finish or verify the task.",
    evidence: [
      ...(boundedDiagnosticRecovery
        ? [
            `fresh recovery packet for failure ${stagnantValidation.failureSignature}`,
            `${stagnantValidation.mutationPhases} prior mutation phases are bounded to this first extension`,
          ]
        : []),
      ...recentToolResults
        .filter((result) => result.ok !== false && !result.blocked)
        .slice(-4)
        .map((result) => `${result.toolName || "tool"}${result.path ? ` path=${result.path}` : ""}${result.summary ? ` summary=${compact(result.summary, 120)}` : ""}`),
    ].slice(0, 8),
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
