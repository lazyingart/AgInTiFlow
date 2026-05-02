const COMPLEXITY_KEYWORDS = [
  "architecture",
  "refactor",
  "debug",
  "failing",
  "test",
  "implement",
  "patch",
  "apply_patch",
  "edit",
  "large codebase",
  "codebase",
  "monorepo",
  "repository",
  "cross-file",
  "multi file",
  "large repo",
  "engineering",
  "entry point",
  "regression",
  "root cause",
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
  "system",
  "systemd",
  "permission denied",
  "install",
  "setup",
  "toolchain",
  "conda",
  "venv",
  "kubernetes",
  "nginx",
  "postgres",
  "redis",
  "segfault",
  "typescript",
  "python",
  "rust",
  "cargo",
  "golang",
  "cmake",
  "gradle",
  "maven",
];

const COMPLEX_ROUTE_HINTS = [
  /\b(large|big|complex|complicated)\s+(repo|repository|codebase|project|task)\b/i,
  /\b(multi[- ]file|cross[- ]file|repo[- ]wide|workspace[- ]wide)\b/i,
  /\b(root cause|regression|failing tests?|fix the build|make it pass)\b/i,
  /\b(system bug|system problem|permission denied|service failed|daemon|systemd|toolchain|install|setup)\b/i,
  /\b(conda|venv|python|node|typescript|rust|cargo|golang|java|gradle|maven|cmake|c\+\+)\b.*\b(project|app|tests?|build|compile|fix)\b/i,
  /\blatex\b/i,
  /\btexlive\b/i,
  /\bpdflatex\b/i,
  /\blatexmk\b/i,
  /\b(manuscript|research paper|white paper|technical report)\b/i,
  /\bcompile\b.*\bpdf\b/i,
  /\bwrite\b.*\bpdf\b/i,
];

export const ROUTING_MODES = ["smart", "fast", "complex", "manual"];

export const PROVIDER_MODEL_CATALOG = {
  deepseek: [
    {
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      role: "fast",
      context: "1.0M",
      description: "Default fast route for normal shell, browser, and short coding tasks.",
    },
    {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      role: "complex",
      context: "1.0M",
      description: "Default complex route for large coding, debugging, and design tasks.",
    },
  ],
  openai: [
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      role: "frontier",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Frontier model for complex coding, research, and real-world work.",
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      role: "everyday coding",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Strong model for everyday coding.",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      role: "fast spare",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Small, fast, cost-efficient model for simpler coding tasks.",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      role: "coding",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Coding-optimized model.",
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      role: "fast coding",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Ultra-fast coding model.",
    },
    {
      id: "gpt-5.2",
      label: "GPT-5.2",
      role: "long-running",
      reasoning: ["low", "medium", "high", "xhigh"],
      description: "Optimized for professional work and long-running agents.",
    },
  ],
  venice: [
    {
      id: "venice-uncensored-1-2",
      label: "Venice Uncensored 1.2",
      bucket: "venice-uncensored",
      context: "128K",
      description: "Current Venice uncensored text route.",
    },
    {
      id: "venice-uncensored",
      label: "Venice Uncensored",
      bucket: "venice-uncensored",
      context: "32K",
      description: "Legacy Venice uncensored text route.",
    },
    {
      id: "venice-uncensored-role-play",
      label: "Venice Role Play Uncensored",
      bucket: "venice-uncensored",
      context: "128K",
      description: "Role-play oriented Venice route.",
    },
    {
      id: "gemma-4-uncensored",
      label: "Gemma 4 Uncensored",
      bucket: "venice-gemma",
      context: "256K",
      description: "Gemma-family uncensored Venice route.",
    },
    {
      id: "qwen3-6-27b",
      label: "Qwen 3.6 27B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Qwen-family Venice route.",
    },
    {
      id: "openai-gpt-55",
      label: "GPT-5.5 via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "OpenAI-family Venice-routed model.",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Claude-family Venice-routed model.",
    },
  ],
  qwen: [
    {
      id: "qwen-plus",
      label: "Qwen Plus",
      role: "default",
      description: "DashScope OpenAI-compatible route.",
    },
    {
      id: "qwen-max",
      label: "Qwen Max",
      role: "complex",
      description: "Higher-capacity Qwen route.",
    },
  ],
  mock: [
    {
      id: "mock-agent",
      label: "Mock Agent",
      role: "local",
      description: "Deterministic local test route.",
    },
  ],
};

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

  if (provider === "qwen") {
    return {
      provider: "qwen",
      apiKey: process.env.QWEN_API_KEY || "",
      baseURL: process.env.QWEN_BASE_URL || process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: process.env.QWEN_DEFAULT_MODEL || process.env.LLM_MODEL || "qwen-plus",
    };
  }

  if (provider === "venice") {
    return {
      provider: "venice",
      apiKey: process.env.VENICE_API_KEY || "",
      baseURL: process.env.VENICE_API_BASE || process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1",
      model: process.env.VENICE_MODEL || process.env.VENICE_DEFAULT_MODEL || process.env.LLM_MODEL || "venice-uncensored-1-2",
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
    venicePrimary: {
      id: "venicePrimary",
      label: "Venice primary",
      provider: "venice",
      model: process.env.VENICE_MODEL || process.env.VENICE_DEFAULT_MODEL || "venice-uncensored-1-2",
      description: "Manual/primary Venice OpenAI-compatible route.",
    },
    veniceUncensored: {
      id: "veniceUncensored",
      label: "Venice uncensored",
      provider: "venice",
      model: "venice-uncensored-1-2",
      description: "Venice uncensored 1.2 text route.",
    },
    veniceGemma: {
      id: "veniceGemma",
      label: "Venice Gemma",
      provider: "venice",
      model: "gemma-4-uncensored",
      description: "Venice Gemma-family route.",
    },
    veniceQwen: {
      id: "veniceQwen",
      label: "Venice Qwen",
      provider: "venice",
      model: "qwen3-6-27b",
      description: "Venice Qwen-family route.",
    },
    veniceGpt: {
      id: "veniceGpt",
      label: "Venice GPT",
      provider: "venice",
      model: "openai-gpt-55",
      description: "Venice GPT-family route.",
    },
    veniceClaude: {
      id: "veniceClaude",
      label: "Venice Claude",
      provider: "venice",
      model: "claude-sonnet-4-6",
      description: "Venice Claude-family route.",
    },
    openaiGpt55: {
      id: "openaiGpt55",
      label: "OpenAI GPT-5.5",
      provider: "openai",
      model: "gpt-5.5",
      reasoning: "medium",
      description: "Frontier OpenAI route for complex coding, research, and real-world work.",
    },
    openaiGpt54: {
      id: "openaiGpt54",
      label: "OpenAI GPT-5.4",
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "medium",
      description: "Strong OpenAI route for everyday coding.",
    },
    openaiGpt54Mini: {
      id: "openaiGpt54Mini",
      label: "OpenAI GPT-5.4 Mini",
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoning: "high",
      description: "Fast OpenAI spare route for simpler coding tasks.",
    },
    openaiCodex: {
      id: "openaiCodex",
      label: "OpenAI GPT-5.3 Codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      reasoning: "medium",
      description: "Coding-optimized OpenAI route.",
    },
    openaiCodexSpark: {
      id: "openaiCodexSpark",
      label: "OpenAI GPT-5.3 Codex Spark",
      provider: "openai",
      model: "gpt-5.3-codex-spark",
      reasoning: "high",
      description: "Ultra-fast OpenAI coding route.",
    },
    openaiGpt52: {
      id: "openaiGpt52",
      label: "OpenAI GPT-5.2",
      provider: "openai",
      model: "gpt-5.2",
      reasoning: "medium",
      description: "OpenAI route for professional and long-running agent work.",
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

export function scoreTaskComplexity(goal = "", taskProfile = "auto") {
  const text = String(goal).toLowerCase();
  let score = text.length > 600 ? 2 : text.length > 240 ? 1 : 0;
  if (["large-codebase", "engineering", "codebase"].includes(String(taskProfile || "").toLowerCase())) score += 3;
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

export function selectModelRoute({ routingMode = "smart", provider = "deepseek", model = "", goal = "", taskProfile = "auto" } = {}) {
  const mode = normalizeRoutingMode(routingMode);
  const requestedProvider = String(provider || "deepseek").toLowerCase();
  const presets = getModelPresets();

  if (requestedProvider === "mock") {
    const defaults = getProviderDefaults("mock");
    return {
      routingMode: "manual",
      provider: defaults.provider,
      model: model || defaults.model,
      reason: "Local mock route selected for smoke tests and offline UI/API checks.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  if (mode === "smart" && requestedProvider !== "deepseek") {
    const defaults = getProviderDefaults(requestedProvider);
    return {
      routingMode: "manual",
      provider: defaults.provider,
      model: model || defaults.model,
      reason: `Smart routing delegated to selected primary provider "${defaults.provider}".`,
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  if (mode === "manual") {
    const defaults = getProviderDefaults(requestedProvider);
    return {
      routingMode: mode,
      provider: defaults.provider,
      model: model || defaults.model,
      reason: "Manual provider/model selection.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  if (mode === "complex") {
    return {
      routingMode: mode,
      provider: presets.complex.provider,
      model: presets.complex.model,
      reason: "Complex route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  if (mode === "fast") {
    return {
      routingMode: mode,
      provider: presets.fast.provider,
      model: presets.fast.model,
      reason: "Fast route selected explicitly.",
      complexityScore: scoreTaskComplexity(goal, taskProfile),
    };
  }

  const complexityScore = scoreTaskComplexity(goal, taskProfile);
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
