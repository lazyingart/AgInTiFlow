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
  "novel",
  "book",
  "chapter",
  "screenplay",
  "story bible",
  "long-form",
  "manuscript",
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
  /\b(novel|book|chapter|screenplay|story bible|long[- ]form|fiction arc|scene draft)\b/i,
  /\bcompile\b.*\bpdf\b/i,
  /\bwrite\b.*\bpdf\b/i,
];

export const ROUTING_MODES = ["smart", "fast", "complex", "manual"];

export const MODEL_PROVIDER_GROUPS = {
  deepseek: {
    label: "DeepSeek",
    provider: "deepseek",
    role: "default route/main",
    description: "Primary low-cost coding route. Flash is used for fast planning; Pro is used for complex execution.",
  },
  openai: {
    label: "OpenAI",
    provider: "openai",
    role: "spare/frontier",
    description: "Optional frontier spare or direct manual route, usually with explicit reasoning effort.",
  },
  qwen: {
    label: "Qwen",
    provider: "qwen",
    role: "regional/general",
    description: "DashScope/OpenAI-compatible Qwen route for Chinese and general work.",
  },
  venice: {
    label: "Venice",
    provider: "venice",
    role: "alternate text",
    description: "Venice 1.2/1.1 and Gemma 4 Uncensored for optional manual routes.",
  },
  "venice-gpt": {
    label: "Venice GPT",
    provider: "venice",
    role: "alternate GPT",
    description: "GPT-family models routed through Venice.",
  },
  "venice-claude": {
    label: "Venice Claude",
    provider: "venice",
    role: "alternate Claude",
    description: "Claude-family models routed through Venice.",
  },
  "venice-gemma": {
    label: "Venice Gemma",
    provider: "venice",
    role: "alternate Gemma",
    description: "Gemma-family Venice models.",
  },
  "venice-qwen": {
    label: "Venice Qwen",
    provider: "venice",
    role: "alternate Qwen",
    description: "Qwen-family Venice models.",
  },
};

export const AUXILIARY_MODEL_CATALOG = {
  grsai: [
    {
      id: "nano-banana-2",
      label: "Nano Banana 2",
      type: "image",
      description: "Default auxiliary image-generation route through GRS AI-compatible APIs.",
    },
    {
      id: "nano-banana-2-edit",
      label: "Nano Banana 2 Edit",
      type: "inpaint",
      description: "Image edit route through GRS AI-compatible APIs when available.",
    },
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      type: "image",
      description: "High-quality image generation when available through the configured auxiliary endpoint.",
    },
    {
      id: "gpt-image-2-edit",
      label: "GPT Image 2 Edit",
      type: "inpaint",
      description: "High-quality image editing when available through the configured auxiliary endpoint.",
    },
  ],
  "venice-image": [
    { id: "wan-2-7-pro-edit", label: "Wan 2.7 Pro Edit", type: "inpaint", price: "$0.09/edit" },
    { id: "nano-banana-2", label: "Nano Banana 2", type: "image", price: "$0.10/image" },
    { id: "nano-banana-2-edit", label: "Nano Banana 2 Edit", type: "inpaint", price: "$0.10/edit" },
    { id: "gpt-image-2", label: "GPT Image 2", type: "image", price: "$0.27/image" },
    { id: "gpt-image-2-edit", label: "GPT Image 2 Edit", type: "inpaint", price: "$0.36/edit" },
    { id: "grok-imagine-image-pro", label: "Grok Imagine Pro", type: "image", price: "$0.09/image" },
    { id: "grok-imagine-image", label: "Grok Imagine", type: "image", price: "$0.03/image" },
    { id: "wan-2-7-text-to-image", label: "Wan 2.7", type: "image", price: "$0.04/image" },
    { id: "wan-2-7-pro-text-to-image", label: "Wan 2.7 Pro", type: "image", price: "$0.09/image" },
    { id: "qwen-image-2", label: "Qwen Image 2", type: "image", price: "$0.05/image" },
    { id: "qwen-image-2-pro", label: "Qwen Image 2 Pro", type: "image", price: "$0.10/image" },
    { id: "qwen-image-2-edit", label: "Qwen Image 2 Edit", type: "inpaint", price: "$0.05/edit" },
    { id: "qwen-image-2-pro-edit", label: "Qwen Image 2 Pro Edit", type: "inpaint", price: "$0.10/edit" },
    { id: "bria-bg-remover", label: "Background Remover", type: "image", price: "$0.03/image" },
    { id: "recraft-v4", label: "Recraft V4", type: "image", price: "$0.05/image" },
    { id: "recraft-v4-pro", label: "Recraft V4 Pro", type: "image", price: "$0.29/image" },
    { id: "flux-2-pro", label: "Flux 2 Pro", type: "image", price: "$0.04/image" },
    { id: "flux-2-max", label: "Flux 2 Max", type: "image", price: "$0.09/image" },
    { id: "nano-banana-pro", label: "Nano Banana Pro", type: "image", price: "$0.18/image" },
    { id: "nano-banana-pro-edit", label: "Nano Banana Pro Edit", type: "inpaint", price: "$0.18/edit" },
  ],
};

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
      bucket: "venice",
      context: "128K",
      description: "Current Venice uncensored text route.",
    },
    {
      id: "venice-uncensored",
      label: "Venice Uncensored 1.1",
      bucket: "venice",
      context: "32K",
      description: "Working Venice uncensored 1.1 text route.",
    },
    {
      id: "e2ee-venice-uncensored-24b-p",
      label: "Venice Uncensored 1.1 E2EE",
      bucket: "venice",
      context: "32K",
      hidden: true,
      description: "Documented E2EE Venice 1.1 route; hidden from selectors until upstream stabilizes.",
    },
    {
      id: "venice-uncensored-role-play",
      label: "Venice Role Play Uncensored",
      bucket: "venice",
      context: "128K",
      hidden: true,
      description: "Role-play oriented Venice route.",
    },
    {
      id: "gemma-4-uncensored",
      label: "Gemma 4 Uncensored",
      bucket: "venice",
      context: "256K",
      description: "Gemma-family uncensored Venice route.",
    },
    {
      id: "google-gemma-4-31b-it",
      label: "Google Gemma 4 31B Instruct",
      bucket: "venice-gemma",
      context: "256K",
      description: "Gemma 4 instruct model through Venice.",
    },
    {
      id: "google-gemma-4-26b-a4b-it",
      label: "Google Gemma 4 26B A4B Instruct",
      bucket: "venice-gemma",
      context: "256K",
      description: "Smaller Gemma 4 instruct model through Venice.",
    },
    {
      id: "google-gemma-3-27b-it",
      label: "Google Gemma 3 27B Instruct",
      bucket: "venice-gemma",
      context: "198K",
      description: "Gemma 3 instruct model through Venice.",
    },
    {
      id: "e2ee-gemma-3-27b-p",
      label: "Gemma 3 27B E2EE",
      bucket: "venice-gemma",
      context: "40K",
      description: "Private E2EE Gemma 3 route through Venice.",
    },
    {
      id: "qwen3-6-27b",
      label: "Qwen 3.6 27B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Qwen-family Venice route.",
    },
    {
      id: "qwen-3-6-plus",
      label: "Qwen 3.6 Plus Uncensored",
      bucket: "venice-qwen",
      context: "1.0M",
      description: "Long-context Qwen 3.6 Plus route through Venice.",
    },
    {
      id: "qwen3-5-9b",
      label: "Qwen 3.5 9B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Small fast Qwen-family Venice route.",
    },
    {
      id: "qwen3-5-35b-a3b",
      label: "Qwen 3.5 35B A3B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Mid-size Qwen-family Venice route.",
    },
    {
      id: "qwen3-5-397b-a17b",
      label: "Qwen 3.5 397B A17B",
      bucket: "venice-qwen",
      context: "128K",
      description: "Large Qwen-family Venice route.",
    },
    {
      id: "qwen3-coder-480b-a35b-instruct-turbo",
      label: "Qwen 3 Coder 480B Turbo",
      bucket: "venice-qwen",
      context: "256K",
      description: "Coding-oriented Qwen route through Venice.",
    },
    {
      id: "qwen3-vl-235b-a22b",
      label: "Qwen3 VL 235B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Vision-language Qwen route through Venice.",
    },
    {
      id: "qwen3-235b-a22b-thinking-2507",
      label: "Qwen 3 235B A22B Thinking",
      bucket: "venice-qwen",
      context: "128K",
      description: "Qwen thinking route through Venice.",
    },
    {
      id: "qwen3-235b-a22b-instruct-2507",
      label: "Qwen 3 235B A22B Instruct",
      bucket: "venice-qwen",
      context: "128K",
      description: "Qwen instruct route through Venice.",
    },
    {
      id: "qwen3-next-80b",
      label: "Qwen 3 Next 80B",
      bucket: "venice-qwen",
      context: "256K",
      description: "Qwen Next route through Venice.",
    },
    {
      id: "qwen3-coder-480b-a35b-instruct",
      label: "Qwen 3 Coder 480B",
      bucket: "venice-qwen",
      context: "256K",
      hidden: true,
      description: "Deprecated Qwen Coder route; hidden by default.",
    },
    {
      id: "openai-gpt-55",
      label: "GPT-5.5 via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "OpenAI-family Venice-routed model.",
    },
    {
      id: "openai-gpt-55-pro",
      label: "GPT-5.5 Pro via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "High-capacity GPT-5.5 Pro route through Venice.",
    },
    {
      id: "openai-gpt-54",
      label: "GPT-5.4 via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "GPT-5.4 route through Venice.",
    },
    {
      id: "openai-gpt-54-pro",
      label: "GPT-5.4 Pro via Venice",
      bucket: "venice-gpt",
      context: "1.0M",
      description: "High-capacity GPT-5.4 Pro route through Venice.",
    },
    {
      id: "openai-gpt-54-mini",
      label: "GPT-5.4 Mini via Venice",
      bucket: "venice-gpt",
      context: "400K",
      description: "Small fast GPT route through Venice.",
    },
    {
      id: "openai-gpt-53-codex",
      label: "GPT-5.3 Codex via Venice",
      bucket: "venice-gpt",
      context: "400K",
      description: "Coding-optimized GPT route through Venice.",
    },
    {
      id: "openai-gpt-52",
      label: "GPT-5.2 via Venice",
      bucket: "venice-gpt",
      context: "256K",
      description: "Professional-work GPT route through Venice.",
    },
    {
      id: "openai-gpt-52-codex",
      label: "GPT-5.2 Codex via Venice",
      bucket: "venice-gpt",
      context: "256K",
      description: "Codex-flavored GPT-5.2 route through Venice.",
    },
    {
      id: "openai-gpt-4o-2024-11-20",
      label: "GPT-4o via Venice",
      bucket: "venice-gpt",
      context: "128K",
      description: "GPT-4o route through Venice.",
    },
    {
      id: "openai-gpt-4o-mini-2024-07-18",
      label: "GPT-4o Mini via Venice",
      bucket: "venice-gpt",
      context: "128K",
      description: "Small GPT-4o route through Venice.",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Claude-family Venice-routed model.",
    },
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "High-capacity Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-6-fast",
      label: "Claude Opus 4.6 Fast via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Fast Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6 via Venice",
      bucket: "venice-claude",
      context: "1.0M",
      description: "Claude Opus route through Venice.",
    },
    {
      id: "claude-opus-4-5",
      label: "Claude Opus 4.5 via Venice",
      bucket: "venice-claude",
      context: "198K",
      description: "Claude Opus 4.5 route through Venice.",
    },
    {
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5 via Venice",
      bucket: "venice-claude",
      context: "198K",
      description: "Claude Sonnet 4.5 route through Venice.",
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
      id: "qwen-turbo",
      label: "Qwen Turbo",
      role: "fast",
      description: "Fast DashScope OpenAI-compatible Qwen route.",
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

function providerDefaultModel(provider, fallback) {
  if (provider === "deepseek" && fallback) return fallback;
  return getProviderDefaults(provider).model || fallback;
}

export function getModelPresets(overrides = {}) {
  const routeProvider = overrides.routeProvider || process.env.AGINTI_ROUTE_PROVIDER || "deepseek";
  const mainProvider = overrides.mainProvider || process.env.AGINTI_MAIN_PROVIDER || "deepseek";
  return {
    fast: {
      id: "fast",
      label: "Fast base",
      provider: routeProvider,
      model:
        overrides.routeModel ||
        process.env.AGINTI_ROUTE_MODEL ||
        process.env.DEEPSEEK_FAST_MODEL ||
        providerDefaultModel(routeProvider, "deepseek-v4-flash"),
      description: "Default fast route for normal browser, shell, and short coding tasks.",
    },
    complex: {
      id: "complex",
      label: "Complex reasoning",
      provider: mainProvider,
      model:
        overrides.mainModel ||
        process.env.AGINTI_MAIN_MODEL ||
        process.env.DEEPSEEK_PRO_MODEL ||
        providerDefaultModel(mainProvider, "deepseek-v4-pro"),
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
      model: overrides.wrapperModel || process.env.AGINTI_WRAPPER_MODEL || process.env.CODEX_PRIMARY_MODEL || "gpt-5.5",
      reasoning:
        overrides.wrapperReasoning || process.env.AGINTI_WRAPPER_REASONING || process.env.CODEX_PRIMARY_REASONING || "medium",
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

export function getModelRoleDefaults(overrides = {}) {
  const presets = getModelPresets(overrides);
  const spareProvider = overrides.spareProvider || process.env.AGINTI_SPARE_PROVIDER || "openai";
  const spareModel = overrides.spareModel || process.env.AGINTI_SPARE_MODEL || "gpt-5.4";
  const auxiliaryProvider = overrides.auxiliaryProvider || process.env.AGINTI_AUX_PROVIDER || "grsai";
  const auxiliaryModel = overrides.auxiliaryModel || process.env.AGINTI_AUX_MODEL || process.env.VENICE_IMAGE_MODEL || "nano-banana-2";
  return {
    route: {
      id: "route",
      label: "Route model",
      command: "/route",
      provider: presets.fast.provider,
      model: presets.fast.model,
      reasoning: overrides.routeReasoning || process.env.AGINTI_ROUTE_REASONING || "",
      description: "Fast planner and triage model. Default: DeepSeek V4 Flash.",
    },
    main: {
      id: "main",
      label: "Main model",
      command: "/model",
      provider: presets.complex.provider,
      model: presets.complex.model,
      reasoning: overrides.mainReasoning || process.env.AGINTI_MAIN_REASONING || "",
      description: "Complex executor for coding, debugging, writing, and long tasks. Default: DeepSeek V4 Pro.",
    },
    spare: {
      id: "spare",
      label: "Spare model",
      command: "/spare",
      provider: spareProvider,
      model: spareModel,
      reasoning: overrides.spareReasoning || process.env.AGINTI_SPARE_REASONING || "medium",
      description: "Fallback or cross-check model. Default: OpenAI GPT-5.4 medium reasoning.",
    },
    wrapper: {
      id: "wrapper",
      label: "Wrapper",
      command: "/wrapper",
      provider: "codex",
      model: presets.codexPrimary.model,
      reasoning: presets.codexPrimary.reasoning,
      description: "External coding wrapper when enabled. Default: Codex with GPT-5.5 medium reasoning.",
    },
    auxiliary: {
      id: "auxiliary",
      label: "Auxiliary",
      command: "/auxiliary",
      provider: auxiliaryProvider,
      model: auxiliaryModel,
      description: "Image/media tools. Default: GRS AI/Nano Banana; Venice image is optional.",
    },
  };
}

export function modelsForProviderGroup(groupId) {
  const group = MODEL_PROVIDER_GROUPS[groupId];
  if (!group) return [];
  if (group.provider !== "venice") return PROVIDER_MODEL_CATALOG[group.provider] || [];
  return (PROVIDER_MODEL_CATALOG.venice || []).filter((item) => item.bucket === groupId);
}

export function scoreTaskComplexity(goal = "", taskProfile = "auto") {
  const text = String(goal).toLowerCase();
  let score = text.length > 600 ? 2 : text.length > 240 ? 1 : 0;
  const profile = String(taskProfile || "").toLowerCase();
  if (["large-codebase", "engineering", "codebase", "code", "qa", "database", "devops", "security"].includes(profile)) score += 3;
  if (["app", "data", "paper", "research", "latex", "github", "maintenance", "supervision", "writing", "book", "novel"].includes(profile)) {
    score += 2;
  }
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

export function selectModelRoute({
  routingMode = "smart",
  provider = "deepseek",
  model = "",
  goal = "",
  taskProfile = "auto",
  routeProvider = "",
  routeModel = "",
  mainProvider = "",
  mainModel = "",
} = {}) {
  const mode = normalizeRoutingMode(routingMode);
  const requestedProvider = String(provider || "deepseek").toLowerCase();
  const presets = getModelPresets({ routeProvider, routeModel, mainProvider, mainModel });

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
