import { types as utilTypes } from "node:util";
import OpenAI from "openai";
import { isLocalLLMBaseURL, normalizeProviderBaseURL } from "./provider-contract.js";

export const INTEGRATION_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const INTEGRATION_DEEPSEEK_MODELS = Object.freeze([
  "deepseek-v4-flash", "deepseek-flash", "deepseek-v4-pro",
]);

export class IntegrationModelBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationModelBindingError";
    this.code = "ANALYSIS_CONFIGURATION_INVALID";
    this.status = 500;
  }
}

function fail(message) {
  throw new IntegrationModelBindingError(message);
}

function bounded(value, fallback, minimum, maximum) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail("Integration model limits must be bounded integers.");
  }
  return number;
}

export function normalizeIntegrationModelBinding(value, { requireCredential = true } = {}) {
  const keys = new Set([
    "provider", "baseURL", "model", "apiKey", "contextWindowTokens",
    "maxOutputTokens", "modelTimeoutMs", "thinking",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("Integration model binding must be a plain data object.");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("Integration model binding contains an unsupported field.");
    }
  }
  // Credentials authenticate an explicit selection. They never select a host
  // provider, fallback, route or model from the surrounding environment.
  const provider = value.provider === undefined ? "localllm" : value.provider;
  if (!new Set(["localllm", "deepseek"]).has(provider)) {
    fail("Integration model provider is unsupported.");
  }
  if (provider === "localllm") {
    if (typeof value.baseURL !== "string" || !isLocalLLMBaseURL(value.baseURL)) {
      fail("LocalLLM model binding must use an OpenAI-compatible loopback /v1 endpoint.");
    }
    if (value.thinking !== undefined) {
      fail("LocalLLM integration does not accept hosted thinking options.");
    }
  } else {
    if (value.baseURL !== INTEGRATION_DEEPSEEK_BASE_URL
        || !INTEGRATION_DEEPSEEK_MODELS.includes(value.model)) {
      fail("DeepSeek integration requires its fixed HTTPS origin and an approved model.");
    }
    if ((requireCredential || value.apiKey !== undefined)
        && (typeof value.apiKey !== "string" || !/^[A-Za-z0-9._~-]{20,512}$/u.test(value.apiKey))) {
      fail("DeepSeek integration requires its own explicit credential.");
    }
    // This bounded interactive/tool profile uses non-thinking requests. A future
    // thinking profile must retain provider reasoning across tool turns first.
    if (value.thinking !== undefined && value.thinking !== "disabled") {
      fail("DeepSeek interactive integration requires thinking=disabled.");
    }
  }
  if (typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/u.test(value.model)) {
    fail("Integration model identifier is invalid.");
  }
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string"
      || Buffer.byteLength(value.apiKey, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value.apiKey))) {
    fail("Integration model credential is invalid.");
  }
  return Object.freeze({
    provider,
    baseURL: normalizeProviderBaseURL(provider, value.baseURL, Object.freeze({})),
    model: value.model,
    apiKey: value.apiKey || (provider === "localllm" ? "local-dev-key" : ""),
    contextWindowTokens: bounded(value.contextWindowTokens, 32_768, 8_192, 262_144),
    maxOutputTokens: bounded(value.maxOutputTokens, 2_048, 256, 4_096),
    modelTimeoutMs: bounded(value.modelTimeoutMs, 180_000, 1_000, 600_000),
    ...(provider === "deepseek" ? { thinking: "disabled" } : {}),
  });
}

export function integrationModelTransport(binding) {
  return binding.provider === "deepseek" ? "deepseek-fixed-https" : "localllm-fixed-loopback";
}

export function integrationModelPublicBinding(binding) {
  return Object.freeze({
    ...(binding.provider === "deepseek" ? { provider: binding.provider, thinking: binding.thinking } : {}),
    baseURL: binding.baseURL,
    model: binding.model,
    contextWindowTokens: binding.contextWindowTokens,
    maxOutputTokens: binding.maxOutputTokens,
    modelTimeoutMs: binding.modelTimeoutMs,
  });
}

export function integrationModelPayload(payload, binding) {
  if (binding.provider !== "deepseek") return payload;
  const { reasoning_effort: _reasoning, ...rest } = payload;
  return Object.freeze({ ...rest, thinking: Object.freeze({ type: "disabled" }) });
}

export function createIntegrationHostedModelClient(value) {
  const binding = normalizeIntegrationModelBinding(value);
  if (binding.provider !== "deepseek") fail("Hosted integration client requires an explicit DeepSeek binding.");
  return new OpenAI({
    apiKey: binding.apiKey,
    baseURL: binding.baseURL,
    maxRetries: 0,
    fetchOptions: { redirect: "error" },
  });
}
