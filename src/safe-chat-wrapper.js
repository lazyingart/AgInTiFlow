import OpenAI from "openai";
import { hasSensitiveText, redactSensitiveText } from "./redaction.js";

const FEATURE = "safe-chat";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";

const DEFAULT_LIMITS = Object.freeze({
  promptChars: 4000,
  historyChars: 8000,
  historyItems: 12,
  outputChars: 12000,
  timeoutMs: 60000,
  maxConcurrency: 1,
  maxTokens: 2048,
});

const ALLOWED_REQUEST_FIELDS = new Set(["prompt", "history", "locale"]);
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "apiKey",
  "api_key",
  "baseURL",
  "baseUrl",
  "command",
  "commandCwd",
  "cwd",
  "env",
  "key",
  "model",
  "provider",
  "reasoning",
  "sandbox",
  "system",
  "token",
  "tools",
  "tool_choice",
  "wrapper",
]);

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const GOOGLE_API_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{30,}\b/;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const SAFE_CHAT_ERROR_CODES = Object.freeze([
  "unauthorized",
  "not_found",
  "invalid_request",
  "unsafe_input",
  "unavailable",
  "busy",
  "cancelled",
  "timeout",
  "provider_quota",
  "provider_rate_limited",
  "provider_capacity",
  "provider_auth",
  "upstream_error",
  "invalid_response",
  "unsafe_output",
  "output_too_large",
]);

export const SAFE_CHAT_REQUEST_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: DEFAULT_LIMITS.promptChars,
    },
    history: {
      type: "array",
      maxItems: DEFAULT_LIMITS.historyItems,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "string", minLength: 1, maxLength: DEFAULT_LIMITS.historyChars },
        },
        required: ["role", "content"],
      },
    },
    locale: {
      type: "string",
      maxLength: 32,
      pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    },
  },
  required: ["prompt"],
});

let runningCount = 0;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function safeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.hostname.toLowerCase() !== "api.deepseek.com" ||
      (parsed.port && parsed.port !== "443")
    ) {
      return "";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function safeModel(value) {
  const model = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model) ? model : "";
}

function serverConfig(env = process.env) {
  return {
    enabled: truthy(env.AGINTI_SAFE_CHAT_ENABLED),
    apiKey: String(env.AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || "").trim(),
    baseURL: safeBaseUrl(env.AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL),
    model: safeModel(env.AGINTI_SAFE_CHAT_DEEPSEEK_MODEL || env.DEEPSEEK_FAST_MODEL || DEFAULT_MODEL),
    limits: {
      promptChars: DEFAULT_LIMITS.promptChars,
      historyChars: DEFAULT_LIMITS.historyChars,
      historyItems: DEFAULT_LIMITS.historyItems,
      outputChars: boundedInteger(env.AGINTI_SAFE_CHAT_OUTPUT_CHARS, DEFAULT_LIMITS.outputChars, {
        min: 1000,
        max: 24000,
      }),
      timeoutMs: boundedInteger(env.AGINTI_SAFE_CHAT_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, {
        min: 100,
        max: 120000,
      }),
      maxConcurrency: boundedInteger(env.AGINTI_SAFE_CHAT_MAX_CONCURRENCY, DEFAULT_LIMITS.maxConcurrency, {
        min: 1,
        max: 8,
      }),
      maxTokens: boundedInteger(env.AGINTI_SAFE_CHAT_MAX_TOKENS, DEFAULT_LIMITS.maxTokens, {
        min: 256,
        max: 4096,
      }),
    },
  };
}

function containsLikelySecret(value) {
  const text = String(value || "");
  return (
    hasSensitiveText(text) ||
    PRIVATE_KEY_PATTERN.test(text) ||
    JWT_PATTERN.test(text) ||
    AWS_ACCESS_KEY_PATTERN.test(text) ||
    GOOGLE_API_KEY_PATTERN.test(text) ||
    SLACK_TOKEN_PATTERN.test(text)
  );
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(message = "Safe chat request is invalid.") {
  const error = new Error(message);
  error.publicCode = "invalid_request";
  error.status = 400;
  error.retryable = false;
  return error;
}

function unsafeInput() {
  const error = new Error("Safe chat request was rejected by the secret guardrail.");
  error.publicCode = "unsafe_input";
  error.status = 400;
  error.retryable = false;
  return error;
}

function cancelledFailure() {
  return Object.freeze(
    failure("cancelled", 499, false, "Safe chat request was cancelled.")
  );
}

function sanitizeClientPayload(body, limits) {
  if (!plainObject(body)) throw invalidRequest();

  const keys = Object.keys(body);
  if (keys.some((key) => FORBIDDEN_CLIENT_FIELDS.has(key))) {
    throw invalidRequest("Client-controlled model, credential, tool, or runtime fields are not accepted.");
  }
  if (keys.some((key) => !ALLOWED_REQUEST_FIELDS.has(key))) {
    throw invalidRequest("Safe chat request contains an unknown field.");
  }

  if (typeof body.prompt !== "string") throw invalidRequest("prompt must be a string.");
  const prompt = body.prompt.trim();
  if (!prompt) throw invalidRequest("prompt is required.");
  if (prompt.length > limits.promptChars) {
    throw invalidRequest(`prompt exceeds ${limits.promptChars} characters.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(prompt)) {
    throw invalidRequest("prompt contains an unsupported control character.");
  }

  const rawHistory = body.history === undefined ? [] : body.history;
  if (!Array.isArray(rawHistory)) throw invalidRequest("history must be an array.");
  if (rawHistory.length > limits.historyItems) {
    throw invalidRequest(`history exceeds ${limits.historyItems} messages.`);
  }

  let historyChars = 0;
  const history = rawHistory.map((item) => {
    if (!plainObject(item)) throw invalidRequest("history items must be objects.");
    const itemKeys = Object.keys(item);
    if (
      itemKeys.length !== 2 ||
      !itemKeys.includes("role") ||
      !itemKeys.includes("content") ||
      !["user", "assistant"].includes(item.role) ||
      typeof item.content !== "string"
    ) {
      throw invalidRequest("history items accept only role and content for user or assistant messages.");
    }
    const content = item.content.trim();
    if (!content) throw invalidRequest("history content must not be empty.");
    if (CONTROL_CHARACTER_PATTERN.test(content)) {
      throw invalidRequest("history contains an unsupported control character.");
    }
    historyChars += content.length;
    return { role: item.role, content };
  });
  if (historyChars > limits.historyChars) {
    throw invalidRequest(`history exceeds ${limits.historyChars} characters.`);
  }

  let locale = "";
  if (body.locale !== undefined) {
    if (typeof body.locale !== "string") throw invalidRequest("locale must be a string.");
    locale = body.locale.trim();
    if (
      !locale ||
      locale.length > 32 ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)
    ) {
      throw invalidRequest("locale must be a short BCP 47-style language tag.");
    }
  }

  const secretSurface = [prompt, ...history.map((item) => item.content)].join("\n");
  if (containsLikelySecret(secretSurface)) throw unsafeInput();
  return { prompt, history, locale };
}

function makeStatus(env = process.env) {
  const config = serverConfig(env);
  let unavailableReason = "";
  if (!config.enabled) unavailableReason = "safe chat is disabled";
  else if (!config.apiKey) unavailableReason = "server-owned DeepSeek credentials are unavailable";
  else if (!config.baseURL) unavailableReason = "server-owned DeepSeek endpoint is invalid";
  else if (!config.model) unavailableReason = "server-owned DeepSeek model is unavailable";

  return {
    ok: true,
    feature: FEATURE,
    enabled: config.enabled,
    available: !unavailableReason,
    unavailableReason,
    modelExposed: false,
    providerExposed: false,
    running: runningCount,
    limits: { ...config.limits },
    policy: {
      provider: "server-owned",
      modelSelection: "server-owned",
      clientModelSelection: false,
      tools: false,
      filesystem: false,
      shell: false,
      browser: false,
      sessions: false,
      persistence: false,
      processPromptTransport: "direct-api",
      secretInputs: "reject",
      secretOutputs: "reject",
      diagnostics: "hidden",
      unavailableBehavior: "fail-closed",
    },
  };
}

function systemPrompt(locale = "") {
  return [
    "You are a server-owned text-only fallback assistant.",
    "Answer from the supplied conversation only.",
    "You have no tools, internet access, browser, shell, filesystem, private data, credentials, or persistent memory.",
    "Never claim that you searched, opened, downloaded, changed, sent, installed, or published anything.",
    "Do not ask for or reproduce secrets, authentication tokens, passwords, private keys, or internal system details.",
    "If the request requires unavailable tools or private/current evidence, explain that limitation briefly.",
    "Return only the helpful final response text.",
    locale ? `Prefer the user's requested locale: ${locale}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function safeChatPayload(request, config) {
  return {
    model: config.model,
    temperature: 0.2,
    max_tokens: config.limits.maxTokens,
    messages: [
      { role: "system", content: systemPrompt(request.locale) },
      ...request.history,
      { role: "user", content: request.prompt },
    ],
  };
}

function defaultClientFactory(config) {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0,
  });
}

function errorText(error) {
  return [
    error?.code,
    error?.type,
    error?.message,
    error?.error?.code,
    error?.error?.type,
    error?.error?.message,
    error?.response?.data?.error?.code,
    error?.response?.data?.error?.type,
    error?.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function classifyProviderError(error, timedOut = false) {
  const status = Number(error?.status || error?.response?.status || 0);
  const text = errorText(error);
  if (
    timedOut ||
    status === 408 ||
    /timeout/i.test(String(error?.name || "")) ||
    /(?:^|\s)(?:etimedout|request timed out)(?:\s|$)/.test(text)
  ) {
    return {
      code: "timeout",
      status: 504,
      retryable: true,
      error: "Safe chat provider request timed out.",
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|invalid[_ -]?api[_ -]?key|permission denied/.test(text)
  ) {
    return {
      code: "provider_auth",
      status: 503,
      retryable: false,
      error: "Safe chat provider authentication is unavailable.",
    };
  }
  if (
    status === 402 ||
    /insufficient[_ -]?quota|quota exceeded|billing|account balance|insufficient[_ -]?balance|credits? exhausted/.test(text)
  ) {
    return {
      code: "provider_quota",
      status: 429,
      retryable: false,
      error: "Safe chat provider quota is unavailable.",
    };
  }
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) {
    return {
      code: "provider_rate_limited",
      status: 429,
      retryable: true,
      error: "Safe chat provider is temporarily rate limited.",
    };
  }
  if (status === 503 || status === 529 || /overload|overloaded|capacity|temporarily unavailable/.test(text)) {
    return {
      code: "provider_capacity",
      status: 503,
      retryable: true,
      error: "Safe chat provider is temporarily at capacity.",
    };
  }
  return {
    code: "upstream_error",
    status: status >= 500 ? 502 : 503,
    retryable: status === 0 || status >= 500,
    error: "Safe chat provider request failed.",
  };
}

function failure(code, status, retryable, error) {
  return {
    ok: false,
    feature: FEATURE,
    code,
    status,
    retryable: Boolean(retryable),
    error: redactSensitiveText(String(error || "Safe chat request failed.")),
    modelExposed: false,
    providerExposed: false,
  };
}

function cancellationError() {
  const error = new Error("Safe chat request was cancelled.");
  error.name = "SafeChatCancelledError";
  error.safeChatCancelled = true;
  return error;
}

function timeoutError() {
  const error = new Error("Safe chat provider request timed out.");
  error.name = "TimeoutError";
  error.safeChatTimedOut = true;
  return error;
}

async function requestWithTimeout(client, payload, config, parentSignal = null) {
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = (error) => {
      if (settled) return;
      try {
        controller.abort(error);
      } catch {
        // The guarded request still settles with the fixed public error below.
      }
      settle(() => reject(error));
    };
    const onParentAbort = () => abort(cancellationError());

    if (parentSignal?.aborted) {
      abort(cancellationError());
      return;
    }
    parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
    timer = setTimeout(() => abort(timeoutError()), config.limits.timeoutMs);

    let request;
    try {
      request = client.chat.completions.create(payload, {
        signal: controller.signal,
        timeout: config.limits.timeoutMs,
      });
    } catch (error) {
      settle(() => reject(error));
      return;
    }

    // Attach both handlers immediately. If timeout or parent cancellation wins,
    // a later provider rejection is consumed here rather than becoming unhandled.
    Promise.resolve(request).then(
      (response) => settle(() => resolve(response)),
      (error) => settle(() => reject(error))
    );
  });
}

export function getSafeChatStatus(env = process.env) {
  return makeStatus(env);
}

export async function runSafeChat(body = {}, options = {}) {
  const env = options.env || process.env;
  const abortSignal = options.abortSignal || null;
  if (abortSignal?.aborted) return cancelledFailure();
  const status = makeStatus(env);
  if (!status.available) {
    return failure("unavailable", 503, false, "Safe chat is unavailable.");
  }
  if (runningCount >= status.limits.maxConcurrency) {
    return failure("busy", 429, true, "Safe chat concurrency limit reached.");
  }

  runningCount += 1;
  try {
    const config = serverConfig(env);
    const request = sanitizeClientPayload(body, config.limits);
    const clientFactory = options.clientFactory || defaultClientFactory;
    const client = clientFactory({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      timeoutMs: config.limits.timeoutMs,
    });
    if (!client?.chat?.completions?.create) {
      return failure("unavailable", 503, false, "Safe chat client is unavailable.");
    }

    const response = await requestWithTimeout(client, safeChatPayload(request, config), config, abortSignal);
    const answer = response?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return failure("invalid_response", 502, false, "Safe chat provider returned an invalid response.");
    }
    const normalizedAnswer = answer.trim();
    if (normalizedAnswer.length > config.limits.outputChars) {
      return failure("output_too_large", 502, false, "Safe chat provider response exceeded the output limit.");
    }
    if (containsLikelySecret(normalizedAnswer)) {
      return failure("unsafe_output", 502, false, "Safe chat provider response was rejected by the secret guardrail.");
    }

    return {
      ok: true,
      feature: FEATURE,
      answer: normalizedAnswer,
      code: "ok",
      retryable: false,
      modelExposed: false,
      providerExposed: false,
    };
  } catch (error) {
    if (abortSignal?.aborted || error?.safeChatCancelled) return cancelledFailure();
    if (error?.publicCode) {
      return failure(error.publicCode, Number(error.status) || 400, Boolean(error.retryable), error.message);
    }
    const classified = classifyProviderError(error, Boolean(error?.safeChatTimedOut));
    return failure(classified.code, classified.status, classified.retryable, classified.error);
  } finally {
    runningCount = Math.max(0, runningCount - 1);
  }
}
