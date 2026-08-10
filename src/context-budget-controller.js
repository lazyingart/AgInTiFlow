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

export function estimateTextTokens(value = "") {
  let text = "";
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value ?? "");
    } catch {
      text = String(value || "");
    }
  }
  let ascii = 0;
  let nonAscii = 0;
  for (const symbol of text) {
    if (symbol.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  // Local/code prompts are denser than ordinary prose, while CJK and emoji can
  // approach one or more tokens per code point. This intentionally errs high.
  return Math.ceil(ascii / 3) + Math.ceil(nonAscii * 1.5);
}

export function estimateMessageTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    let count = 6 + estimateTextTokens(message?.role || "") + estimateTextTokens(message?.content || "");
    count += estimateTextTokens(message?.reasoning_content || message?.reasoningContent || "");
    if (Array.isArray(message?.tool_calls)) {
      try {
        count += estimateTextTokens(JSON.stringify(message.tool_calls));
      } catch {
        count += 500;
      }
    }
    return total + count;
  }, 0);
}

export function estimateToolSchemaTokens(tools = []) {
  try {
    return estimateTextTokens(JSON.stringify(Array.isArray(tools) ? tools : []));
  } catch {
    return 4096;
  }
}

export function createContextBudgetState(config = {}, state = {}) {
  const saved = state.meta?.contextBudget || {};
  const mode = normalizeContextBudgetMode(config.contextBudgetMode ?? saved.mode ?? "auto");
  const maxChars = positiveInteger(config.contextBudgetChars ?? saved.maxChars, 180000);
  const defaultTarget = Math.min(60000, Math.max(24000, Math.floor(maxChars * 0.4)));
  const targetChars = Math.min(maxChars, positiveInteger(config.contextBudgetTargetChars ?? saved.targetChars, defaultTarget));
  const contextWindowTokens = positiveInteger(config.contextWindowTokens ?? saved.contextWindowTokens, 0);
  const outputReserveTokens = contextWindowTokens
    ? positiveInteger(config.maxOutputTokens ?? saved.outputReserveTokens, 4096)
    : 0;
  const toolReserveTokens = contextWindowTokens
    ? positiveInteger(config.contextToolReserveTokens ?? saved.toolReserveTokens, 4096)
    : 0;
  const maxInputTokens = contextWindowTokens
    ? Math.max(1024, contextWindowTokens - outputReserveTokens - toolReserveTokens)
    : 0;
  const defaultTargetTokens = maxInputTokens ? Math.max(1024, Math.floor(maxInputTokens * 0.6)) : 0;
  const targetTokens = maxInputTokens
    ? Math.min(maxInputTokens, positiveInteger(config.contextBudgetTargetTokens ?? saved.targetTokens, defaultTargetTokens))
    : 0;
  return {
    mode,
    enabled: mode !== "off",
    maxChars,
    targetChars,
    contextWindowTokens,
    outputReserveTokens,
    toolReserveTokens,
    maxInputTokens,
    targetTokens,
    compactions: positiveInteger(saved.compactions, 0),
    lastCompactedStep: positiveInteger(saved.lastCompactedStep, 0),
    lastCharsBefore: positiveInteger(saved.lastCharsBefore, 0),
    lastCharsAfter: positiveInteger(saved.lastCharsAfter, 0),
    lastTokensBefore: positiveInteger(saved.lastTokensBefore, 0),
    lastTokensAfter: positiveInteger(saved.lastTokensAfter, 0),
  };
}

export function serializeContextBudgetState(budget = {}) {
  return {
    mode: budget.mode || "auto",
    enabled: Boolean(budget.enabled),
    maxChars: positiveInteger(budget.maxChars, 0),
    targetChars: positiveInteger(budget.targetChars, 0),
    contextWindowTokens: positiveInteger(budget.contextWindowTokens, 0),
    outputReserveTokens: positiveInteger(budget.outputReserveTokens, 0),
    toolReserveTokens: positiveInteger(budget.toolReserveTokens, 0),
    maxInputTokens: positiveInteger(budget.maxInputTokens, 0),
    targetTokens: positiveInteger(budget.targetTokens, 0),
    compactions: positiveInteger(budget.compactions, 0),
    lastCompactedStep: positiveInteger(budget.lastCompactedStep, 0),
    lastCharsBefore: positiveInteger(budget.lastCharsBefore, 0),
    lastCharsAfter: positiveInteger(budget.lastCharsAfter, 0),
    lastTokensBefore: positiveInteger(budget.lastTokensBefore, 0),
    lastTokensAfter: positiveInteger(budget.lastTokensAfter, 0),
  };
}

export function decideContextCompaction({ state = {}, budget = {}, step = 0 } = {}) {
  const charsBefore = estimateMessageChars(state.messages);
  const tokensBefore = estimateMessageTokens(state.messages);
  if (!budget.enabled) {
    return { compact: false, reason: "Context budget management is disabled.", charsBefore, tokensBefore };
  }
  const exceedsChars = charsBefore > budget.maxChars;
  const exceedsTokens = Boolean(budget.maxInputTokens && tokensBefore > budget.maxInputTokens);
  if (!exceedsChars && !exceedsTokens) {
    return { compact: false, reason: "Context remains within the configured budget.", charsBefore, tokensBefore };
  }
  if (budget.lastCompactedStep && Number(step || 0) - budget.lastCompactedStep < 2) {
    return {
      compact: false,
      reason: "Context exceeded the budget again too soon after compaction.",
      charsBefore,
      tokensBefore,
    };
  }
  return {
    compact: true,
    reason: exceedsTokens
      ? `Estimated input size ${tokensBefore} tokens exceeded the ${budget.maxInputTokens}-token input budget after output and tool reserves.`
      : `Context size ${charsBefore} chars exceeded the ${budget.maxChars}-char budget.`,
    charsBefore,
    tokensBefore,
    targetChars: budget.targetChars,
    targetTokens: budget.targetTokens,
  };
}

export function recordContextCompaction(
  budget = {},
  { step = 0, charsBefore = 0, charsAfter = 0, tokensBefore = 0, tokensAfter = 0 } = {}
) {
  budget.compactions = positiveInteger(budget.compactions, 0) + 1;
  budget.lastCompactedStep = positiveInteger(step, budget.lastCompactedStep || 0);
  budget.lastCharsBefore = positiveInteger(charsBefore, 0);
  budget.lastCharsAfter = positiveInteger(charsAfter, 0);
  budget.lastTokensBefore = positiveInteger(tokensBefore, 0);
  budget.lastTokensAfter = positiveInteger(tokensAfter, 0);
  return serializeContextBudgetState(budget);
}
