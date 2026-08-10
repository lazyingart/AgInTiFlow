import { isLoopbackBaseURL, normalizeProviderId, resolveProviderDefaults } from "./provider-contract.js";

export const DEFAULT_PROVIDER_READINESS_TIMEOUT_MS = 3000;
export const MAX_PROVIDER_READINESS_TIMEOUT_MS = 15000;

const MIN_PROVIDER_READINESS_TIMEOUT_MS = 25;

export class ProviderReadinessError extends Error {
  constructor({ code, message, action, provider = "localllm", stage = "configuration", endpoint = "", status = 0, details = {} }) {
    super(message);
    this.name = "ProviderReadinessError";
    this.code = code;
    this.action = action;
    this.provider = provider;
    this.stage = stage;
    this.endpoint = endpoint;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      name: this.name,
      code: this.code,
      message: this.message,
      action: this.action,
      provider: this.provider,
      stage: this.stage,
      endpoint: this.endpoint,
      status: this.status,
      details: this.details,
    };
  }
}

function readinessError(options) {
  return new ProviderReadinessError(options);
}

function normalizedTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVIDER_READINESS_TIMEOUT_MS;
  return Math.min(MAX_PROVIDER_READINESS_TIMEOUT_MS, Math.max(MIN_PROVIDER_READINESS_TIMEOUT_MS, Math.trunc(parsed)));
}

function canonicalProvider(value) {
  const provider = normalizeProviderId(value || "localllm", "");
  if (provider !== "localllm") {
    throw readinessError({
      code: "PROVIDER_UNSUPPORTED",
      message: "Runtime readiness probing currently supports only the canonical localllm provider.",
      action: "Select provider=localllm, or add a provider-specific probe before enabling another provider.",
      provider: provider || String(value || "unknown"),
    });
  }
  return provider;
}

function requestedModelEntries(routeModel, mainModel, selectedModel) {
  return [
    ["route", routeModel],
    ["main", mainModel],
    ["active", selectedModel],
  ]
    .map(([role, model]) => ({ role, model: String(model || "").trim() }))
    .filter(({ model }) => Boolean(model));
}

export function deriveLocalLLMReadinessEndpoints(baseURL) {
  const rawBaseURL = String(baseURL || "").trim();
  if (!rawBaseURL) {
    throw readinessError({
      code: "BASE_URL_REQUIRED",
      message: "LocalLLM readiness requires an OpenAI-compatible loopback base URL.",
      action: "Set LOCALLLM_BASE_URL to a loopback URL such as http://127.0.0.1:8008/v1.",
    });
  }
  if (!isLoopbackBaseURL(rawBaseURL)) {
    throw readinessError({
      code: "BASE_URL_NOT_LOOPBACK",
      message: "LocalLLM readiness refused a non-loopback or credential-bearing base URL.",
      action: "Use an HTTP(S) loopback URL with no credentials, query, or fragment; hosted fallback is intentionally disabled.",
    });
  }

  const parsed = new URL(rawBaseURL);
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (!pathname.endsWith("/v1")) {
    throw readinessError({
      code: "BASE_URL_NOT_OPENAI_V1",
      message: "LocalLLM readiness expected the configured base URL path to end in /v1.",
      action: "Set LOCALLLM_BASE_URL to the OpenAI-compatible endpoint, for example http://127.0.0.1:8008/v1.",
    });
  }

  parsed.pathname = pathname;
  const normalizedBaseURL = parsed.toString().replace(/\/+$/, "");
  const healthURL = new URL(parsed.toString());
  healthURL.pathname = `${pathname.slice(0, -3) || ""}/healthz`.replace(/\/+/g, "/");
  const modelsURL = new URL(parsed.toString());
  modelsURL.pathname = `${pathname}/models`.replace(/\/+/g, "/");

  return {
    baseURL: normalizedBaseURL,
    healthURL: healthURL.toString(),
    modelsURL: modelsURL.toString(),
  };
}

function createProbeSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);

  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Provider readiness timed out", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromCaller);
    },
  };
}

function abortedProbeError({ provider, stage, endpoint, timeoutMs, timedOut }) {
  if (timedOut) {
    return readinessError({
      code: "PROBE_TIMEOUT",
      message: `LocalLLM readiness did not complete within ${timeoutMs} ms.`,
      action: "Confirm the LocalLLM API and Ollama runtime are responsive, then retry or choose a bounded larger timeout.",
      provider,
      stage,
      endpoint,
      details: { timeoutMs },
    });
  }
  return readinessError({
    code: "PROBE_ABORTED",
    message: "LocalLLM readiness was cancelled before completion.",
    action: "Retry when the caller is ready; no hosted provider was contacted.",
    provider,
    stage,
    endpoint,
  });
}

function redirectRefusedProbeError({ provider, stage, endpoint }) {
  return readinessError({
    code: "PROBE_REDIRECT_REFUSED",
    message: `LocalLLM ${stage} readiness refused an HTTP redirect.`,
    action: "Configure the loopback LocalLLM endpoint to respond directly; readiness redirects are disabled to preserve local-only routing.",
    provider,
    stage,
    endpoint,
  });
}

function isRedirectRefusal(error) {
  return [error?.message, error?.cause?.message, error?.code, error?.cause?.code]
    .filter(Boolean)
    .some((value) => /redirect/i.test(String(value)));
}

async function fetchJson({ fetchImpl, url, headers = {}, signal, didTimeOut, timeoutMs, provider, stage }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...headers,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw abortedProbeError({ provider, stage, endpoint: url, timeoutMs, timedOut: didTimeOut() });
    }
    if (isRedirectRefusal(error)) {
      throw redirectRefusedProbeError({ provider, stage, endpoint: url });
    }
    throw readinessError({
      code: "PROBE_UNREACHABLE",
      message: `LocalLLM ${stage} endpoint could not be reached.`,
      action: "Start or repair the loopback LocalLLM API, verify its port, and retry.",
      provider,
      stage,
      endpoint: url,
    });
  }

  if (response.status >= 300 && response.status < 400) {
    throw redirectRefusedProbeError({ provider, stage, endpoint: url });
  }

  if (!response.ok) {
    if (stage === "models" && (response.status === 401 || response.status === 403)) {
      throw readinessError({
        code: "AUTHENTICATION_FAILED",
        message: `LocalLLM model discovery rejected bearer authentication with HTTP ${response.status}.`,
        action: "Set LOCALLLM_API_KEY to the key accepted by the loopback LocalLLM API, then retry.",
        provider,
        stage,
        endpoint: url,
        status: response.status,
      });
    }
    throw readinessError({
      code: "PROBE_HTTP_ERROR",
      message: `LocalLLM ${stage} endpoint returned HTTP ${response.status}.`,
      action: "Inspect the LocalLLM API health and configuration, then retry the loopback readiness check.",
      provider,
      stage,
      endpoint: url,
      status: response.status,
    });
  }

  try {
    return await response.json();
  } catch {
    if (signal.aborted) {
      throw abortedProbeError({ provider, stage, endpoint: url, timeoutMs, timedOut: didTimeOut() });
    }
    throw readinessError({
      code: `${stage.toUpperCase()}_MALFORMED_RESPONSE`,
      message: `LocalLLM ${stage} endpoint did not return valid JSON.`,
      action: "Verify that the configured loopback port serves the LocalLLM API rather than another process.",
      provider,
      stage,
      endpoint: url,
    });
  }
}

function validateHealth(health, { provider, endpoint }) {
  if (!health || typeof health !== "object" || Array.isArray(health) || typeof health.ok !== "boolean") {
    throw readinessError({
      code: "HEALTH_MALFORMED_RESPONSE",
      message: "LocalLLM health response did not contain the required boolean ok field.",
      action: "Verify that the configured loopback endpoint implements the LocalLLM /healthz contract.",
      provider,
      stage: "health",
      endpoint,
    });
  }
  if (health.ok !== true) {
    throw readinessError({
      code: "SERVICE_UNAVAILABLE",
      message: "The LocalLLM API reported that its service is not ready.",
      action: "Inspect the LocalLLM API logs and restart or repair the local service before starting an agent run.",
      provider,
      stage: "health",
      endpoint,
    });
  }
  if (!health.ollama || typeof health.ollama !== "object" || typeof health.ollama.ok !== "boolean") {
    throw readinessError({
      code: "HEALTH_MALFORMED_RESPONSE",
      message: "LocalLLM health response did not contain the required ollama.ok runtime field.",
      action: "Upgrade or repair the LocalLLM API so /healthz reports its Ollama runtime state.",
      provider,
      stage: "health",
      endpoint,
    });
  }
  if (health.ollama.ok !== true) {
    throw readinessError({
      code: "RUNTIME_UNAVAILABLE",
      message: "The LocalLLM API is reachable, but its Ollama runtime is unavailable.",
      action: "Start or repair Ollama and confirm LocalLLM /healthz reports ollama.ok=true before retrying.",
      provider,
      stage: "runtime",
      endpoint,
    });
  }
}

function validateModels(payload, requested, { provider, endpoint }) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw readinessError({
      code: "MODELS_MALFORMED_RESPONSE",
      message: "LocalLLM model discovery did not return an OpenAI-compatible data array.",
      action: "Verify that the configured loopback endpoint implements GET /v1/models.",
      provider,
      stage: "models",
      endpoint,
    });
  }

  const available = payload.data
    .map((entry) => (entry && typeof entry === "object" ? String(entry.id || "").trim() : ""))
    .filter(Boolean);
  if (available.length !== payload.data.length) {
    throw readinessError({
      code: "MODELS_MALFORMED_RESPONSE",
      message: "LocalLLM model discovery returned one or more entries without a model id.",
      action: "Repair the LocalLLM model catalog so every /v1/models data entry has a non-empty id.",
      provider,
      stage: "models",
      endpoint,
    });
  }

  const availableSet = new Set(available);
  const missing = requested.filter(({ model }) => !availableSet.has(model));
  if (missing.length > 0) {
    throw readinessError({
      code: "MODEL_ALIAS_MISSING",
      message: `LocalLLM is ready, but ${missing.length} requested model alias${missing.length === 1 ? " is" : "es are"} unavailable.`,
      action: "Install or expose the requested LocalLLM aliases, or select route/main aliases listed by GET /v1/models.",
      provider,
      stage: "models",
      endpoint,
      details: { missing },
    });
  }

  return available;
}

export async function probeProviderRuntime({
  provider = "localllm",
  baseURL = "",
  apiKey = "",
  routeModel = "",
  mainModel = "",
  selectedModel = "",
  timeoutMs = DEFAULT_PROVIDER_READINESS_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAtMs = Date.now();
  const canonical = canonicalProvider(provider);
  const defaults = resolveProviderDefaults(canonical);
  const endpoints = deriveLocalLLMReadinessEndpoints(baseURL || defaults.baseURL);
  const bearerToken = String(apiKey || defaults.apiKey || "").trim();
  if (!bearerToken) {
    throw readinessError({
      code: "API_KEY_REQUIRED",
      message: "LocalLLM model discovery requires a bearer token.",
      action: "Set LOCALLLM_API_KEY to the key accepted by the loopback LocalLLM API.",
      provider: canonical,
      stage: "configuration",
    });
  }
  if (typeof fetchImpl !== "function") {
    throw readinessError({
      code: "FETCH_UNAVAILABLE",
      message: "No Fetch-compatible implementation is available for LocalLLM readiness.",
      action: "Run AgInTiFlow on its supported Node.js runtime or provide a compatible fetch implementation.",
      provider: canonical,
      stage: "configuration",
    });
  }

  const boundedTimeoutMs = normalizedTimeoutMs(timeoutMs);
  const probeSignal = createProbeSignal(signal, boundedTimeoutMs);
  const requested = requestedModelEntries(routeModel, mainModel, selectedModel);

  try {
    if (probeSignal.signal.aborted) {
      throw abortedProbeError({
        provider: canonical,
        stage: "configuration",
        endpoint: "",
        timeoutMs: boundedTimeoutMs,
        timedOut: probeSignal.didTimeOut(),
      });
    }

    const health = await fetchJson({
      fetchImpl,
      url: endpoints.healthURL,
      signal: probeSignal.signal,
      didTimeOut: probeSignal.didTimeOut,
      timeoutMs: boundedTimeoutMs,
      provider: canonical,
      stage: "health",
    });
    validateHealth(health, { provider: canonical, endpoint: endpoints.healthURL });

    const modelsPayload = await fetchJson({
      fetchImpl,
      url: endpoints.modelsURL,
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: probeSignal.signal,
      didTimeOut: probeSignal.didTimeOut,
      timeoutMs: boundedTimeoutMs,
      provider: canonical,
      stage: "models",
    });
    const availableModels = validateModels(modelsPayload, requested, { provider: canonical, endpoint: endpoints.modelsURL });
    const checkedAt = new Date().toISOString();

    return {
      ok: true,
      status: "ready",
      provider: canonical,
      locality: "loopback",
      baseURL: endpoints.baseURL,
      checkedAt,
      durationMs: Date.now() - startedAtMs,
      endpoints: {
        health: endpoints.healthURL,
        models: endpoints.modelsURL,
      },
      checks: {
        service: {
          ok: true,
          name: String(health.service || "localllm-api"),
        },
        runtime: {
          ok: true,
          name: "ollama",
          version: String(health.ollama.version || ""),
        },
        authentication: {
          ok: true,
          scheme: "bearer",
        },
        models: {
          ok: true,
          count: availableModels.length,
          available: availableModels,
          requested,
          missing: [],
        },
      },
    };
  } finally {
    probeSignal.cleanup();
  }
}

export const probeProviderReadiness = probeProviderRuntime;
