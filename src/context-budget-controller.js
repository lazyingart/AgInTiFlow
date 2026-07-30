export const CONTEXT_BUDGET_MODES = ["off", "auto", "on"];

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function normalizeContextBudgetMode(value = "auto") {
  const text = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled", "never"].includes(text)) return "off";
  if (["1", "true", "yes", "on", "enabled", "always"].includes(text)) return "on";
  return "auto";
}

export function estimateMessageChars(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    let count = String(message?.role || "").length + String(message?.content || "").length;
    count += String(message?.reasoning_content || message?.reasoningContent || "").length;
    if (Array.isArray(message?.tool_calls)) {
      try {
        count += JSON.stringify(message.tool_calls).length;
      } catch {
        count += 1000;
      }
    }
    return total + count;
  }, 0);
}

export function createContextBudgetState(config = {}, state = {}) {
  const saved = state.meta?.contextBudget || {};
  const mode = normalizeContextBudgetMode(config.contextBudgetMode ?? saved.mode ?? "auto");
  const maxChars = positiveInteger(config.contextBudgetChars ?? saved.maxChars, 180000);
  const defaultTarget = Math.min(60000, Math.max(24000, Math.floor(maxChars * 0.4)));
  const targetChars = Math.min(maxChars, positiveInteger(config.contextBudgetTargetChars ?? saved.targetChars, defaultTarget));
  return {
    mode,
    enabled: mode !== "off",
    maxChars,
    targetChars,
    compactions: positiveInteger(saved.compactions, 0),
    lastCompactedStep: positiveInteger(saved.lastCompactedStep, 0),
    lastCharsBefore: positiveInteger(saved.lastCharsBefore, 0),
    lastCharsAfter: positiveInteger(saved.lastCharsAfter, 0),
  };
}

export function serializeContextBudgetState(budget = {}) {
  return {
    mode: budget.mode || "auto",
    enabled: Boolean(budget.enabled),
    maxChars: positiveInteger(budget.maxChars, 0),
    targetChars: positiveInteger(budget.targetChars, 0),
    compactions: positiveInteger(budget.compactions, 0),
    lastCompactedStep: positiveInteger(budget.lastCompactedStep, 0),
    lastCharsBefore: positiveInteger(budget.lastCharsBefore, 0),
    lastCharsAfter: positiveInteger(budget.lastCharsAfter, 0),
  };
}

export function decideContextCompaction({ state = {}, budget = {}, step = 0 } = {}) {
  const charsBefore = estimateMessageChars(state.messages);
  if (!budget.enabled) {
    return { compact: false, reason: "Context budget management is disabled.", charsBefore };
  }
  if (charsBefore <= budget.maxChars) {
    return { compact: false, reason: "Context remains within the configured budget.", charsBefore };
  }
  if (budget.lastCompactedStep && Number(step || 0) - budget.lastCompactedStep < 2) {
    return {
      compact: false,
      reason: "Context exceeded the budget again too soon after compaction.",
      charsBefore,
    };
  }
  return {
    compact: true,
    reason: `Context size ${charsBefore} chars exceeded the ${budget.maxChars}-char budget.`,
    charsBefore,
    targetChars: budget.targetChars,
  };
}

export function recordContextCompaction(budget = {}, { step = 0, charsBefore = 0, charsAfter = 0 } = {}) {
  budget.compactions = positiveInteger(budget.compactions, 0) + 1;
  budget.lastCompactedStep = positiveInteger(step, budget.lastCompactedStep || 0);
  budget.lastCharsBefore = positiveInteger(charsBefore, 0);
  budget.lastCharsAfter = positiveInteger(charsAfter, 0);
  return serializeContextBudgetState(budget);
}
