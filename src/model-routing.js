const COMPLEXITY_KEYWORDS = [
  "architecture",
  "refactor",
  "debug",
  "failing",
  "test",
  "implement",
  "design",
  "review",
  "migrate",
  "security",
  "performance",
  "multi-file",
  "database",
  "docker",
  "ci",
  "github",
];

const COMPLEX_ROUTE_HINTS = [
  /\blatex\b/i,
  /\btexlive\b/i,
  /\bpdflatex\b/i,
  /\blatexmk\b/i,
  /\b(manuscript|research paper|white paper|technical report)\b/i,
  /\bcompile\b.*\bpdf\b/i,
  /\bwrite\b.*\bpdf\b/i,
];

export const ROUTING_MODES = ["smart", "fast", "complex", "manual"];

export function getProviderDefaults(provider = "deepseek") {
  if (provider === "mock") {
    return {
      provider: "mock",
      apiKey: "mock-local",
      baseURL: "",
      model: process.env.MOCK_MODEL || "mock-agent",
    };
  }

  if (provider === "openai") {
    return {
      provider: "openai",
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
      baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      model: process.env.OPENAI_DEFAULT_MODEL || process.env.LLM_MODEL || "gpt-5.4-mini",
    };
  }

  return {
    provider: "deepseek",
    apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
    model: process.env.DEEPSEEK_FAST_MODEL || process.env.LLM_MODEL || "deepseek-v4-flash",
  };
}

export function getModelPresets() {
  return {
    fast: {
      id: "fast",
      label: "Fast base",
      provider: "deepseek",
      model: process.env.DEEPSEEK_FAST_MODEL || "deepseek-v4-flash",
      description: "Default fast route for normal browser, shell, and short coding tasks.",
    },
    complex: {
      id: "complex",
      label: "Complex reasoning",
      provider: "deepseek",
      model: process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
      description: "Higher-capacity DeepSeek route for multi-step coding and design tasks.",
    },
    mock: {
      id: "mock",
      label: "Local mock",
      provider: "mock",
      model: process.env.MOCK_MODEL || "mock-agent",
      description: "Credential-free local route for UI, API, and tool-routing smoke tests.",
    },
    codexPrimary: {
      id: "codexPrimary",
      label: "Codex primary wrapper",
      provider: "codex-wrapper",
      model: process.env.CODEX_PRIMARY_MODEL || "gpt-5.5",
      reasoning: process.env.CODEX_PRIMARY_REASONING || "medium",
      description: "External Codex wrapper route for coding enhancement tasks.",
    },
    codexSpare: {
      id: "codexSpare",
      label: "Codex spare wrapper",
      provider: "codex-wrapper",
      model: process.env.CODEX_SPARE_MODEL || "gpt-5.4-mini",
      reasoning: process.env.CODEX_SPARE_REASONING || "high",
      description: "Fallback Codex wrapper route when the primary wrapper fails.",
    },
  };
}

export function scoreTaskComplexity(goal = "") {
  const text = String(goal).toLowerCase();
  let score = text.length > 600 ? 2 : text.length > 240 ? 1 : 0;
  for (const keyword of COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) score += 1;
  }
  for (const hint of COMPLEX_ROUTE_HINTS) {
    if (hint.test(goal)) score += 3;
  }
  return score;
}

export function normalizeRoutingMode(value) {
  return ROUTING_MODES.includes(value) ? value : "smart";
}

export function selectModelRoute({ routingMode = "smart", provider = "deepseek", model = "", goal = "" } = {}) {
  const mode = normalizeRoutingMode(routingMode);
  const presets = getModelPresets();

  if (provider === "mock") {
    const defaults = getProviderDefaults("mock");
    return {
      routingMode: "manual",
      provider: defaults.provider,
      model: model || defaults.model,
      reason: "Local mock route selected for smoke tests and offline UI/API checks.",
      complexityScore: scoreTaskComplexity(goal),
    };
  }

  if (mode === "manual") {
    const defaults = getProviderDefaults(provider);
    return {
      routingMode: mode,
      provider: defaults.provider,
      model: model || defaults.model,
      reason: "Manual provider/model selection.",
      complexityScore: scoreTaskComplexity(goal),
    };
  }

  if (mode === "complex") {
    return {
      routingMode: mode,
      provider: presets.complex.provider,
      model: presets.complex.model,
      reason: "Complex route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal),
    };
  }

  if (mode === "fast") {
    return {
      routingMode: mode,
      provider: presets.fast.provider,
      model: presets.fast.model,
      reason: "Fast route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal),
    };
  }

  const complexityScore = scoreTaskComplexity(goal);
  const selected = complexityScore >= 3 ? presets.complex : presets.fast;
  return {
    routingMode: mode,
    provider: selected.provider,
    model: selected.model,
    reason:
      selected.id === "complex"
        ? `Smart routing selected complex route; complexity score ${complexityScore}.`
        : `Smart routing selected fast route; complexity score ${complexityScore}.`,
    complexityScore,
  };
}
