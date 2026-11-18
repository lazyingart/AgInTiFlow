import crypto from "node:crypto";
import { createChatCompletion, createClient } from "./model-client.js";
import { parseNativeToolArguments as parseModelJson } from "./native-tool-arguments.js";
import { jsonSchemaSnapshot } from "./restricted-application-contract.js";
import { checkSpecialistSchema } from "./json-specialist-schema.js";
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

function parseJsonValue(content, attempt) {
  const invalid = { ok: false, error: "response must contain one unambiguous JSON value" };
  if (typeof content !== "string" || !content.length) return { ok: false, error: "empty JSON response" };
  try {
    return { ok: true, value: parseModelJson(content) };
  } catch (error) {
    if (attempt !== "prompt" || error.kind !== "syntax") return invalid;
  }

  // Prompt-only providers may surround a value with prose or a Markdown fence.
  // Examine a single candidate; never salvage an inner value from a rejected one.
  const text = content.trim();
  const firstFence = text.indexOf("```");
  const lastFence = text.lastIndexOf("```");
  const delimiters = /[[\]{}]/u;
  let candidate;
  if (firstFence >= 0 && lastFence > firstFence &&
      !delimiters.test(text.slice(0, firstFence)) && !delimiters.test(text.slice(lastFence + 3))) {
    candidate = text.slice(firstFence + 3, lastFence).replace(/^json\b/i, "").trim();
  } else {
    const start = text.search(/[[\]{}]/u);
    const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    if (start < 0 || end <= start || !["{", "["].includes(text[start]) ||
        text.slice(0, start).includes("```") || /[[{]|```/u.test(text.slice(end + 1))) return invalid;
    candidate = text.slice(start, end + 1);
  }
  try {
    return { ok: true, value: parseModelJson(candidate) };
  } catch {
    return invalid;
  }
}

function normalizeSchema(raw) {
  let schema = raw;
  let name = "";
  let strict = true;
  if (typeof schema === "string" && schema.trim()) {
    if (Buffer.byteLength(schema) > 65536) throw new Error("JSON specialist schema is too large.");
    schema = parseModelJson(schema);
  }
  schema = jsonSchemaSnapshot(schema);
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

function normalizeThinkingMode(value = "auto") {
  const raw = value && typeof value === "object" ? value.type : value;
  const normalized = String(raw || "auto").trim().toLowerCase();
  return ["auto", "enabled", "disabled"].includes(normalized) ? normalized : "auto";
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
    thinkingMode: normalizeThinkingMode(args.thinkingMode ?? args.thinking),
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

function mockValueForSchema(schema, budget = { nodes: 4096, literalBytes: 65536 }) {
  if (--budget.nodes < 0) throw new Error("JSON specialist mock exceeds its generation budget.");
  if (!schema || typeof schema !== "object") return {};
  if (schema.const !== undefined || (Array.isArray(schema.enum) && schema.enum.length > 0)) {
    const literal = schema.const !== undefined ? schema.const : schema.enum[0];
    budget.literalBytes -= Buffer.byteLength(JSON.stringify(literal));
    if (budget.literalBytes < 0) throw new Error("JSON specialist mock exceeds its generation budget.");
    return literal;
  }
  const type = allowedTypes(schema)[0] || (schema.properties ? "object" : "string");
  if (type === "string") return "mock";
  if (type === "integer") return 1;
  if (type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "array") {
    const count = schema.maxItems === 0 ? 0 : Math.max(1, schema.minItems || 0);
    if (count > budget.nodes) throw new Error("JSON specialist mock exceeds its generation budget.");
    return Array.from({ length: count }, () => mockValueForSchema(schema.items || { type: "string" }, budget));
  }
  const result = {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const keys = new Set([...(schema.required || []), ...Object.keys(properties).slice(0, 6)]);
  for (const key of keys) result[key] = mockValueForSchema(properties[key] || { type: "string" }, budget);
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
    const mock = config.provider === "mock" || provider === "mock";
    if (!mock) provider = resolveJsonProvider(request, config);
    const schemaSource = JSON.stringify(request.schema);
    await checkSpecialistSchema(schemaSource, undefined, true, config.abortSignal);
    if (mock) {
      provider = "mock";
      model = request.model || config.model || "mock-agent";
      result = mockValueForSchema(request.schema);
      validationErrors = await checkSpecialistSchema(schemaSource, result, false, config.abortSignal);
    } else {
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
          ...(normalizeProviderId(provider, "") === "deepseek" && request.thinkingMode !== "auto"
            ? { thinking: { type: request.thinkingMode } }
            : {}),
        };
        try {
          const response = await createChatCompletion(client, payload, jsonConfig, `json specialist ${attempt} request`);
          rawContent = response.choices[0]?.message?.content || "";
          const parsed = parseJsonValue(rawContent, attempt);
          if (!parsed.ok) {
            attemptNotes.push(`${attempt}: ${parsed.error}`);
            if (request.fallbackOnInvalid && attempt !== attempts.at(-1)) continue;
            throw new Error(parsed.error);
          }
          const errors = await checkSpecialistSchema(schemaSource, parsed.value, false, config.abortSignal);
          if (errors.length > 0) {
            attemptNotes.push(`${attempt}: ${errors.slice(0, 4).join("; ")}`);
            if (request.fallbackOnInvalid && attempt !== attempts.at(-1)) continue;
          }
          result = parsed.value;
          validationErrors = errors;
          usedResponseFormat = attempt;
          break;
        } catch (error) {
          if (config.abortSignal?.aborted || error?.code === "SPECIALIST_SCHEMA_UNAVAILABLE" || error?.code === "SPECIALIST_SCHEMA_INVALID") throw error;
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
