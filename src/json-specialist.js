import crypto from "node:crypto";
import { createChatCompletion, createClient } from "./model-client.js";
import { getProviderDefaults } from "./model-routing.js";
import { normalizeProviderId, providerStructuredOutputAttempts } from "./provider-contract.js";
import { redactSensitiveText, redactValue } from "./redaction.js";

const MAX_INLINE_PREVIEW = 1600;
const JSON_PROVIDERS = new Set(["localllm", "openai", "openrouter", "deepseek", "qwen", "venice", "mock"]);

function compact(value = "", limit = MAX_INLINE_PREVIEW) {
  const text = redactSensitiveText(String(value || "").trim());
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24))} ... [truncated]`;
}

function parseJsonValue(content = "") {
  const text = String(content || "").trim();
  if (!text) return { ok: false, error: "empty JSON response" };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate.trim()) };
    } catch {
      // Try a balanced excerpt below.
    }
    const starts = ["{", "["]
      .map((char) => ({ char, index: candidate.indexOf(char) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index);
    for (const start of starts) {
      const close = start.char === "{" ? "}" : "]";
      const end = candidate.lastIndexOf(close);
      if (end <= start.index) continue;
      try {
        return { ok: true, value: JSON.parse(candidate.slice(start.index, end + 1)) };
      } catch {
        // Keep looking.
      }
    }
  }
  return { ok: false, error: "response was not parseable JSON" };
}

function normalizeSchema(raw) {
  let schema = raw;
  let name = "";
  let strict = true;
  if (typeof schema === "string" && schema.trim()) {
    schema = JSON.parse(schema);
  }
  if (schema?.schema && typeof schema.schema === "object" && !schema.type) {
    name = String(schema.name || "").trim();
    strict = schema.strict !== false;
    schema = schema.schema;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("JSON specialist requires a JSON Schema object.");
  }
  return { schema, name, strict };
}

function normalizeInputValue(args = {}) {
  if (args.inputJson !== undefined) return redactValue(args.inputJson);
  if (args.input !== undefined) return redactValue(args.input);
  const text = args.inputText ?? args.source ?? args.content ?? "";
  return redactSensitiveText(String(text || ""));
}

function normalizeResponseFormat(value = "") {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["auto", "json_schema", "json_object", "prompt"].includes(normalized)) return normalized;
  return "auto";
}

function normalizeJsonRequest(args = {}) {
  const normalizedSchema = normalizeSchema(args.schemaJson || args.schema);
  const task = redactSensitiveText(String(args.task || args.prompt || "").trim());
  const instructions = redactSensitiveText(String(args.instructions || args.requirements || "").trim());
  const context = redactSensitiveText(String(args.context || "").trim());
  const temperature = Number.isFinite(Number(args.temperature)) ? Math.min(Math.max(Number(args.temperature), 0), 1.2) : 0;
  const maxTokens = Number.isFinite(Number(args.maxTokens)) ? Math.max(256, Math.floor(Number(args.maxTokens))) : 4096;
  const provider = String(args.provider || process.env.AGINTI_JSON_PROVIDER || "").trim();
  const model = String(args.model || process.env.AGINTI_JSON_MODEL || "").trim();
  const schemaName = String(args.schemaName || normalizedSchema.name || "aginti_structured_output")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64) || "aginti_structured_output";
  return {
    task,
    instructions,
    context,
    input: normalizeInputValue(args),
    schema: normalizedSchema.schema,
    schemaName,
    strict: args.strict === undefined ? normalizedSchema.strict : args.strict !== false,
    responseFormat: normalizeResponseFormat(args.responseFormat),
    fallbackOnInvalid: args.fallbackOnInvalid !== false,
    temperature,
    maxTokens,
    provider,
    model,
  };
}

function jsonSystemPrompt() {
  return [
    "You are the isolated AgInTiFlow JSON Specialist.",
    "You transform only the supplied task, input, and schema into structured JSON.",
    "You do not know or discuss AgInTiFlow internals, shell tools, browser tools, file policies, planning, package installs, or execution constraints.",
    "Never include commentary, markdown fences, prose explanations, or partial objects.",
    "Return one JSON value that satisfies the provided schema.",
  ].join(" ");
}

function jsonUserPrompt(request, attempt) {
  return JSON.stringify(
    {
      boundary:
        "This is the complete context visible to the JSON specialist. Ignore absent agent/runtime details. Produce only schema-valid JSON.",
      task: request.task,
      instructions: request.instructions,
      context: request.context,
      input: request.input,
      json_schema: request.schema,
      output_contract: {
        mode: attempt,
        strict: request.strict,
        requirement: "Return exactly one JSON value matching json_schema. Do not wrap it in markdown.",
      },
    },
    null,
    2
  );
}

function allowedTypes(schema) {
  if (!schema || schema.type === undefined) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function typeMatches(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validateSchema(value, schema, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const variants = schema.anyOf.map((variant) => validateSchema(value, variant, path));
    return variants.some((errs) => errs.length === 0) ? [] : [`${path}: did not match anyOf`];
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((variant) => validateSchema(value, variant, path).length === 0).length;
    return matches === 1 ? [] : [`${path}: did not match exactly one oneOf variant`];
  }
  const errors = [];
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path}: value is not in enum`);
  }
  const types = allowedTypes(schema);
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path}: expected type ${types.join("|")}`);
    return errors;
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
    }
  } else if (value && typeof value === "object") {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required property missing`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validateSchema(value[key], child, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }
  return errors;
}

function mockValueForSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = allowedTypes(schema)[0] || (schema.properties ? "object" : "string");
  if (type === "string") return "mock";
  if (type === "integer") return 1;
  if (type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "array") {
    const count = Number.isFinite(schema.minItems) ? Math.max(1, schema.minItems) : 1;
    return Array.from({ length: count }, () => mockValueForSchema(schema.items || { type: "string" }));
  }
  const result = {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const keys = new Set([...(schema.required || []), ...Object.keys(properties).slice(0, 6)]);
  for (const key of keys) result[key] = mockValueForSchema(properties[key] || { type: "string" });
  return result;
}

function attemptsForRequest(request, provider) {
  const normalizedProvider = normalizeProviderId(provider);
  if (request.responseFormat === "prompt") return ["prompt"];
  if (request.responseFormat === "json_schema") return ["json_schema", "prompt"];
  if (request.responseFormat === "json_object") return ["json_object", "prompt"];
  return providerStructuredOutputAttempts(normalizedProvider).filter((attempt) => attempt !== "mock");
}

function responseFormatForAttempt(request, attempt) {
  if (attempt === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: request.schemaName,
        strict: request.strict,
        schema: request.schema,
      },
    };
  }
  if (attempt === "json_object") return { type: "json_object" };
  return null;
}

function errorLooksLikeUnsupportedResponseFormat(error) {
  const message = [error?.message, error?.error?.message, error?.response?.data?.error?.message]
    .filter(Boolean)
    .join(" ");
  return /response_format|json_schema|json_object|unsupported|invalid request|400/i.test(message);
}

function parsedRawPreview(rawContent = "") {
  return rawContent ? compact(rawContent, 1200) : "";
}

function resolveJsonProvider(request, config) {
  const active = normalizeProviderId(config.provider || "localllm", "");
  if (!active || !JSON_PROVIDERS.has(active)) {
    throw new Error(`Unknown active JSON specialist provider: ${config.provider || ""}`);
  }
  const requestedRaw = request.provider || active;
  const requested = normalizeProviderId(requestedRaw, "");
  if (!requested || !JSON_PROVIDERS.has(requested)) {
    throw new Error(`Unknown JSON specialist provider: ${requestedRaw}`);
  }
  if (requested !== active && config.allowHostedJsonSpecialist !== true) {
    const error = new Error(
      `JSON specialist provider override ${active} -> ${requested} is disabled. Select ${requested} as the active provider or explicitly enable allowHostedJsonSpecialist; ambient credentials never authorize a provider change.`
    );
    error.name = "HostedToolPermissionError";
    error.code = "HOSTED_TOOL_PROVIDER_NOT_ALLOWED";
    throw error;
  }
  return requested;
}

export async function runJsonSpecialist(args = {}, config = {}, store = null) {
  let request;
  try {
    request = normalizeJsonRequest(args);
  } catch (error) {
    return {
      ok: false,
      toolName: "json_specialist",
      reason: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
  if (!request.task) {
    return {
      ok: false,
      toolName: "json_specialist",
      reason: "task is required.",
    };
  }

  const startedAt = new Date().toISOString();
  const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify(redactValue(request))).digest("hex");
  let model = request.model || config.model || "";
  let provider = request.provider || config.provider || "";
  let rawContent = "";
  const attemptNotes = [];

  try {
    let result;
    let validationErrors = [];
    let usedResponseFormat = "mock";
    if (config.provider === "mock" || provider === "mock") {
      provider = "mock";
      model = request.model || config.model || "mock-agent";
      result = mockValueForSchema(request.schema);
      validationErrors = validateSchema(result, request.schema);
    } else {
      provider = resolveJsonProvider(request, config);
      const providerChanged = provider !== normalizeProviderId(config.provider || "localllm", "");
      const providerDefaults = providerChanged ? getProviderDefaults(provider) : {};
      const jsonConfig = {
        ...config,
        ...providerDefaults,
        provider: provider || config.provider,
        model: request.model || (providerChanged ? providerDefaults.model : config.model) || providerDefaults.model,
      };
      model = jsonConfig.model;
      provider = jsonConfig.provider;
      const client = typeof config.jsonClientFactory === "function" ? config.jsonClientFactory({ ...jsonConfig }) : createClient(jsonConfig);
      const attempts = attemptsForRequest(request, provider);
      for (const attempt of attempts) {
        const responseFormat = responseFormatForAttempt(request, attempt);
        const payload = {
          model: jsonConfig.model,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          messages: [
            { role: "system", content: jsonSystemPrompt() },
            { role: "user", content: jsonUserPrompt(request, attempt) },
          ],
          ...(responseFormat ? { response_format: responseFormat } : {}),
        };
        try {
          const response = await createChatCompletion(client, payload, jsonConfig, `json specialist ${attempt} request`);
          rawContent = response.choices[0]?.message?.content || "";
          const parsed = parseJsonValue(rawContent);
          if (!parsed.ok) {
            attemptNotes.push(`${attempt}: ${parsed.error}`);
            if (request.fallbackOnInvalid && attempt !== attempts.at(-1)) continue;
            throw new Error(parsed.error);
          }
          const errors = validateSchema(parsed.value, request.schema);
          if (errors.length > 0) {
            attemptNotes.push(`${attempt}: ${errors.slice(0, 4).join("; ")}`);
            if (request.fallbackOnInvalid && attempt !== attempts.at(-1)) continue;
          }
          result = parsed.value;
          validationErrors = errors;
          usedResponseFormat = attempt;
          break;
        } catch (error) {
          const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
          attemptNotes.push(`${attempt}: ${message}`);
          if (attempt !== attempts.at(-1) && (request.fallbackOnInvalid || errorLooksLikeUnsupportedResponseFormat(error))) continue;
          throw error;
        }
      }
    }

    const artifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      startedAt,
      provider,
      model,
      responseFormat: usedResponseFormat,
      requestFingerprint,
      request: redactValue(request),
      result: redactValue(result),
      validationErrors,
      attemptNotes,
      rawPreview: parsedRawPreview(rawContent),
    };
    const artifactPath = store
      ? await store.saveJsonArtifact(`json-specialist-${Date.now()}.json`, artifact).catch(() => "")
      : "";
    return {
      ok: validationErrors.length === 0,
      toolName: "json_specialist",
      provider,
      model,
      responseFormat: usedResponseFormat,
      args: {
        task: request.task,
        schemaName: request.schemaName,
        responseFormat: request.responseFormat,
        provider: request.provider,
        requestFingerprint,
      },
      artifactPath,
      result,
      validationErrors,
      attemptNotes,
      rawPreview: parsedRawPreview(rawContent),
    };
  } catch (error) {
    return {
      ok: false,
      blocked: error?.code === "HOSTED_TOOL_PROVIDER_NOT_ALLOWED",
      toolName: "json_specialist",
      provider,
      model,
      args: {
        task: request.task,
        schemaName: request.schemaName,
        responseFormat: request.responseFormat,
        provider: request.provider,
        requestFingerprint,
      },
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      attemptNotes,
      rawPreview: parsedRawPreview(rawContent),
    };
  }
}

export async function runJsonSpecialistBatch(tasks = [], options = {}, config = {}, store = null) {
  const items = Array.isArray(tasks) ? tasks : [];
  const concurrency = Math.min(Math.max(Number(options.concurrency) || 4, 1), 32);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const task = items[index] || {};
      results[index] = await runJsonSpecialist({ ...options.defaults, ...task }, config, store);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return {
    ok: results.every((item) => item?.ok),
    toolName: "json_specialist_batch",
    count: results.length,
    succeeded: results.filter((item) => item?.ok).length,
    failed: results.filter((item) => !item?.ok).length,
    concurrency,
    results,
  };
}
