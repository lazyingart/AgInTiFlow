export const BASELINE_PROVIDER = "localllm";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class ProviderConfigurationError extends Error {
  constructor({ code, message, action, provider = BASELINE_PROVIDER }) {
    super(message);
    this.name = "ProviderConfigurationError";
    this.code = code;
    this.action = action;
    this.provider = provider;
  }

  toJSON() {
    return {
      ok: false,
      name: this.name,
      code: this.code,
      message: this.message,
      action: this.action,
      provider: this.provider,
    };
  }
}

export const PROVIDER_ALIASES = Object.freeze({
  local: "localllm",
  "local-llm": "localllm",
  local_llm: "localllm",
  localllm: "localllm",
  ds: "deepseek",
  deepseek: "deepseek",
  openai: "openai",
  oai: "openai",
  openrouter: "openrouter",
  "open-router": "openrouter",
  or: "openrouter",
  router: "openrouter",
  qwen: "qwen",
  venice: "venice",
  v: "venice",
  mock: "mock",
});

export const PROVIDER_CONTRACTS = Object.freeze({
  localllm: Object.freeze({
    id: "localllm",
    label: "LocalLLM",
    description: "OpenAI-compatible loopback provider for local-first baseline runs.",
    openaiCompatible: true,
    local: true,
    requiresApiKey: false,
    apiKeyEnv: ["AGINTI_LOCALLLM_API_KEY", "LOCALLLM_API_KEY", "LOCAL_LLM_API_KEY"],
    baseUrlEnv: ["AGINTI_LOCALLLM_BASE_URL", "LOCALLLM_BASE_URL", "LOCAL_LLM_BASE_URL"],
    modelEnv: ["AGINTI_LOCALLLM_MODEL", "LOCALLLM_MODEL", "LOCAL_LLM_MODEL"],
    defaultApiKey: "local-dev-key",
    defaultBaseURL: "http://127.0.0.1:8008/v1",
    defaultModel: "localllm-fast",
    toolProtocol: "native",
    structuredOutput: "json_object",
    supportsReasoningEffort: false,
    textToolFallback: true,
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    description: "Hosted OpenAI-compatible DeepSeek route.",
    openaiCompatible: true,
    local: false,
    requiresApiKey: true,
    apiKeyEnv: ["DEEPSEEK_API_KEY", "LLM_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL", "LLM_BASE_URL"],
    modelEnv: ["DEEPSEEK_FAST_MODEL", "LLM_MODEL"],
    defaultBaseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    toolProtocol: "native",
    structuredOutput: "json_schema",
    supportsReasoningEffort: false,
    textToolFallback: false,
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    description: "Hosted OpenAI route or explicit OpenAI-compatible upgrade.",
    openaiCompatible: true,
    local: false,
    requiresApiKey: true,
    apiKeyEnv: ["OPENAI_API_KEY", "LLM_API_KEY"],
    baseUrlEnv: ["OPENAI_BASE_URL", "LLM_BASE_URL"],
    modelEnv: ["OPENAI_DEFAULT_MODEL", "LLM_MODEL"],
    defaultBaseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4-mini",
    toolProtocol: "native",
    structuredOutput: "json_schema",
    supportsReasoningEffort: true,
    textToolFallback: false,
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    description: "Hosted OpenAI-compatible multi-provider gateway.",
    openaiCompatible: true,
    local: false,
    requiresApiKey: true,
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    baseUrlEnv: ["OPENROUTER_BASE_URL"],
    modelEnv: ["OPENROUTER_MODEL", "OPENROUTER_DEFAULT_MODEL", "LLM_MODEL"],
    defaultBaseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    toolProtocol: "native",
    structuredOutput: "json_schema",
    supportsReasoningEffort: false,
    textToolFallback: true,
  }),
  qwen: Object.freeze({
    id: "qwen",
    label: "Qwen",
    description: "Hosted DashScope/OpenAI-compatible Qwen route.",
    openaiCompatible: true,
    local: false,
    requiresApiKey: true,
    apiKeyEnv: ["QWEN_API_KEY"],
    baseUrlEnv: ["QWEN_BASE_URL", "LLM_BASE_URL"],
    modelEnv: ["QWEN_DEFAULT_MODEL", "LLM_MODEL"],
    defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    toolProtocol: "native",
    structuredOutput: "json_schema",
    supportsReasoningEffort: false,
    textToolFallback: false,
  }),
  venice: Object.freeze({
    id: "venice",
    label: "Venice",
    description: "Hosted Venice OpenAI-compatible route.",
    openaiCompatible: true,
    local: false,
    requiresApiKey: true,
    apiKeyEnv: ["VENICE_API_KEY"],
    baseUrlEnv: ["VENICE_API_BASE", "VENICE_BASE_URL"],
    modelEnv: ["VENICE_MODEL", "VENICE_DEFAULT_MODEL", "LLM_MODEL"],
    defaultBaseURL: "https://api.venice.ai/api/v1",
    defaultModel: "venice-uncensored-1-2",
    toolProtocol: "native",
    structuredOutput: "json_object",
    supportsReasoningEffort: false,
    textToolFallback: true,
  }),
  mock: Object.freeze({
    id: "mock",
    label: "Mock",
    description: "Deterministic local test provider.",
    openaiCompatible: false,
    local: true,
    requiresApiKey: false,
    apiKeyEnv: [],
    baseUrlEnv: [],
    modelEnv: ["MOCK_MODEL"],
    defaultApiKey: "mock-local",
    defaultBaseURL: "",
    defaultModel: "mock-agent",
    toolProtocol: "native",
    structuredOutput: "deterministic",
    supportsReasoningEffort: false,
    textToolFallback: false,
  }),
});

export function normalizeProviderId(value = "", fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();
  const candidate = PROVIDER_ALIASES[normalized] || normalized;
  return PROVIDER_CONTRACTS[candidate] ? candidate : fallback;
}

export function providerContract(provider = BASELINE_PROVIDER) {
  const raw = String(provider || "").trim();
  const normalized = normalizeProviderId(raw, "");
  if (!normalized) {
    throw new ProviderConfigurationError({
      code: "PROVIDER_UNKNOWN",
      message: `Unknown provider "${raw || "(empty)"}".`,
      action: "Use localllm, deepseek, openai, openrouter, qwen, venice, or mock. Raw engine labels are not provider aliases.",
      provider: raw,
    });
  }
  return PROVIDER_CONTRACTS[normalized];
}

export function textProviderIds({ includeMock = true } = {}) {
  const ids = Object.keys(PROVIDER_CONTRACTS).filter((provider) => provider !== "mock");
  return includeMock ? [...ids, "mock"] : ids;
}

function firstEnvValue(env, names = []) {
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return "";
}

export function isLoopbackBaseURL(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    const hostname = parsed.hostname.toLowerCase();
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (LOCAL_HOSTNAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))
    );
  } catch {
    return false;
  }
}

export function isLocalLLMBaseURL(value = "") {
  if (!isLoopbackBaseURL(value)) return false;
  const parsed = new URL(String(value || ""));
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return pathname.endsWith("/v1");
}

function invalidLocalLLMBaseURLError() {
  return new ProviderConfigurationError({
    code: "LOCALLLM_BASE_URL_INVALID",
    message: "LocalLLM requires an HTTP(S) loopback OpenAI-compatible base URL whose path ends in /v1.",
    action: "Set LOCALLLM_BASE_URL to a URL such as http://127.0.0.1:8008/v1; hosted fallback is intentionally disabled.",
    provider: "localllm",
  });
}

export function normalizeProviderBaseURL(provider = BASELINE_PROVIDER, value = "", env = process.env) {
  const contract = providerContract(provider);
  const raw = String(value || firstEnvValue(env, contract.baseUrlEnv) || contract.defaultBaseURL || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (contract.id === "localllm" && !isLocalLLMBaseURL(parsed.toString())) throw invalidLocalLLMBaseURLError();
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    if (contract.local && !isLoopbackBaseURL(parsed.toString())) return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    if (contract.id === "localllm") throw invalidLocalLLMBaseURLError();
    return "";
  }
}

export function resolveProviderDefaults(provider = BASELINE_PROVIDER, env = process.env) {
  const normalized = providerContract(provider).id;
  const contract = providerContract(normalized);
  return {
    provider: normalized,
    apiKey: firstEnvValue(env, contract.apiKeyEnv) || contract.defaultApiKey || "",
    baseURL: normalizeProviderBaseURL(normalized, "", env),
    model: firstEnvValue(env, contract.modelEnv) || contract.defaultModel,
    capabilities: publicProviderCapabilities(normalized),
  };
}

export function providerRequiresApiKey(provider = BASELINE_PROVIDER) {
  return providerContract(provider).requiresApiKey;
}

export function providerSupportsReasoningEffort(provider = BASELINE_PROVIDER) {
  return providerContract(provider).supportsReasoningEffort;
}

export function providerPrefersTextToolProtocol(config = {}) {
  const contract = providerContract(config.provider);
  if (contract.toolProtocol === "text") return true;
  if (contract.id !== "venice") return false;
  const model = String(config.model || "").toLowerCase();
  return model === "gemma-4-uncensored" || model === "e2ee-venice-uncensored-24b-p" || model === "venice-uncensored";
}

export function providerCanRetryWithTextToolProtocol(provider = BASELINE_PROVIDER) {
  return providerContract(provider).textToolFallback;
}

export function providerStructuredOutputAttempts(provider = BASELINE_PROVIDER) {
  const mode = providerContract(provider).structuredOutput;
  if (mode === "json_schema") return ["json_schema", "json_object", "prompt"];
  if (mode === "json_object") return ["json_object", "prompt"];
  if (mode === "deterministic") return ["mock"];
  return ["prompt"];
}

export function publicProviderCapabilities(provider = BASELINE_PROVIDER) {
  const contract = providerContract(provider);
  return {
    provider: contract.id,
    label: contract.label,
    openaiCompatible: contract.openaiCompatible,
    local: contract.local,
    requiresApiKey: contract.requiresApiKey,
    toolProtocol: contract.toolProtocol,
    structuredOutput: contract.structuredOutput,
    supportsReasoningEffort: contract.supportsReasoningEffort,
    textToolFallback: contract.textToolFallback,
  };
}

export function publicProviderContracts() {
  return Object.fromEntries(Object.keys(PROVIDER_CONTRACTS).map((provider) => [provider, publicProviderCapabilities(provider)]));
}
