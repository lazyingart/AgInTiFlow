import crypto from "node:crypto";
import { createChatCompletion, createClient } from "./model-client.js";
import {
  normalizeProviderId,
  providerRequiresApiKey,
  resolveProviderDefaults,
} from "./provider-contract.js";
import { redactSensitiveText, redactValue } from "./redaction.js";

const CREATIVE_KINDS = new Set(["novel", "story", "scene", "screenplay", "script", "poem", "fiction"]);
const ACADEMIC_KINDS = new Set(["research_paper", "paper", "latex_manuscript", "manuscript", "article", "essay"]);
const MAX_INLINE_PREVIEW = 1600;

function compact(value = "", limit = MAX_INLINE_PREVIEW) {
  const text = redactSensitiveText(String(value || "").trim());
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24))} ... [truncated]`;
}

function normalizeText(value = "") {
  return redactSensitiveText(String(value || "").trim());
}

function parseJsonObject(content = "") {
  const text = String(content || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try a balanced object excerpt below.
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item, 320)).filter(Boolean).slice(0, 12);
  if (typeof value === "string" && value.trim()) return [compact(value, 320)];
  return [];
}

function normalizeFormatHandoff(value, fallbackIntent = "") {
  if (value && typeof value === "object" && !Array.isArray(value)) return redactValue(value);
  const text = compact(value || fallbackIntent || "No special formatter requirements.", 800);
  return {
    targetFormat: fallbackIntent || "",
    instructions: text,
  };
}

function defaultTemperature(kind = "") {
  const normalized = String(kind || "").toLowerCase();
  if (CREATIVE_KINDS.has(normalized)) return 0.82;
  if (ACADEMIC_KINDS.has(normalized)) return 0.36;
  return 0.62;
}

function normalizeTemperature(value, kind) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(Math.max(numeric, 0), 1.2);
  return defaultTemperature(kind);
}

function normalizeWritingRequest(args = {}) {
  const kind = String(args.kind || args.genre || "other").trim().toLowerCase() || "other";
  return {
    task: String(args.task || "draft").trim().toLowerCase(),
    kind,
    language: String(args.language || "").trim(),
    writingBrief: normalizeText(args.writingBrief || args.brief || args.prompt || ""),
    target: normalizeText(args.target || args.section || args.scene || ""),
    audience: normalizeText(args.audience || ""),
    canon: normalizeText(args.canon || args.background || args.context || ""),
    styleGuide: normalizeText(args.styleGuide || args.style || args.voice || ""),
    priorDraft: normalizeText(args.priorDraft || args.draft || args.source || ""),
    constraints: normalizeText(args.constraints || args.requirements || ""),
    length: normalizeText(args.length || args.targetLength || ""),
    formatIntent: normalizeText(args.formatIntent || args.outputFormat || ""),
    temperature: normalizeTemperature(args.temperature, kind),
    provider: String(args.provider || "").trim(),
    model: String(args.model || "").trim(),
  };
}

function likelyLanguageFromText(request = {}) {
  const explicit = String(request.language || "").trim();
  if (explicit) return explicit;
  const text = [request.writingBrief, request.target, request.audience, request.canon, request.styleGuide, request.priorDraft, request.constraints]
    .join("\n")
    .slice(0, 8000);
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-Hans";
  return "en";
}

function languageEnvSuffix(language = "") {
  const normalized = String(language || "").toLowerCase();
  if (normalized.startsWith("zh")) return "ZH";
  if (normalized.startsWith("ja")) return "JA";
  if (normalized.startsWith("ko")) return "KO";
  if (normalized.startsWith("en")) return "EN";
  return "";
}

function normalizeKnownProvider(value = "", source = "writing specialist") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizeProviderId(raw, "");
  if (!normalized) {
    throw new Error(`Unknown ${source} provider "${compact(raw, 120)}".`);
  }
  return normalized;
}

function writerProviderEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LLM_")));
}

function writerProviderDefaults(provider = "localllm") {
  const normalized = normalizeKnownProvider(provider, "writing specialist");
  const defaults = resolveProviderDefaults(normalized, writerProviderEnvironment());
  if (normalized === "deepseek") {
    return {
      ...defaults,
      model: process.env.DEEPSEEK_PRO_MODEL || "deepseek-v4-pro",
    };
  }
  if (normalized === "openai") {
    return {
      ...defaults,
      model: process.env.OPENAI_DEFAULT_MODEL || "gpt-5.4",
    };
  }
  return defaults;
}

function providerCredentialName(provider = "") {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "qwen") return "QWEN_API_KEY";
  if (provider === "venice") return "VENICE_API_KEY";
  return "a provider-specific API key";
}

function assertWritingProviderPermission(provider, sessionProvider, config = {}) {
  if (provider === sessionProvider || config.allowHostedWritingSpecialist === true) return;
  const error = new Error(
    `Writing specialist provider override ${sessionProvider} -> ${provider} is disabled. Select ${provider} as the active provider or explicitly enable allowHostedWritingSpecialist; ambient credentials and model-supplied provider arguments never authorize a provider change.`
  );
  error.name = "HostedToolPermissionError";
  error.code = "HOSTED_TOOL_PROVIDER_NOT_ALLOWED";
  throw error;
}

export function languageWriterDefaults(request = {}, config = {}) {
  const language = likelyLanguageFromText(request);
  const suffix = languageEnvSuffix(language);
  const requestProviderRaw = String(request.provider || "").trim();
  const envProviderRaw = String((suffix && process.env[`AGINTI_WRITING_PROVIDER_${suffix}`]) || process.env.AGINTI_WRITING_PROVIDER || "").trim();
  const envModel = String((suffix && process.env[`AGINTI_WRITING_MODEL_${suffix}`]) || process.env.AGINTI_WRITING_MODEL || "").trim();
  const sessionProvider = normalizeKnownProvider(config.provider || "localllm", "active session");
  const requestProvider = normalizeKnownProvider(requestProviderRaw, "requested writing specialist");
  const envProvider = normalizeKnownProvider(envProviderRaw, "configured writing specialist");
  const provider = requestProvider || envProvider || sessionProvider;
  assertWritingProviderPermission(provider, sessionProvider, config);
  const defaults = writerProviderDefaults(provider);
  const sessionCredential = provider === sessionProvider ? String(config.apiKey || "").trim() : "";
  if (providerRequiresApiKey(provider) && !sessionCredential && !defaults.apiKey) {
    throw new Error(
      `Writing provider "${provider}" requires ${providerCredentialName(provider)}; generic LLM_* credentials are not used for writer routing.`
    );
  }
  const reason = requestProvider ? "request-provider" : envProvider || envModel ? "writer-env" : "session-default";
  return {
    provider,
    model:
      String(request.model || "").trim() ||
      envModel ||
      (provider === sessionProvider ? String(config.model || "").trim() : "") ||
      defaults.model ||
      "",
    language,
    reason,
    sessionProvider,
  };
}

function writingSystemPrompt() {
  return [
    "You are the isolated AgInTiFlow Writing Specialist.",
    "You only handle writing craft: prose, argument, structure, scene, voice, continuity, rhetoric, and revision.",
    "You do not know or discuss AgInTiFlow internals, shell tools, browser tools, file policies, agent planning, package installs, or execution constraints.",
    "You may mention formatting needs only in format_handoff so a separate formatter can handle Markdown, LaTeX, Final Draft, screenplay layout, or file packaging.",
    "Do not dilute the writing with implementation notes. Produce the best writing artifact possible from the supplied writing context.",
    "Return strict JSON with these keys: draft, revision_notes, continuity_notes, format_handoff, quality_checks, questions.",
  ].join(" ");
}

function writingUserPrompt(request) {
  return JSON.stringify(
    {
      boundary:
        "This is the complete context visible to the writing specialist. Ignore absent agent/runtime details. Write from the user's canon, brief, and style only.",
      task: request.task,
      kind: request.kind,
      language: request.language,
      writing_brief: request.writingBrief,
      target: request.target,
      audience: request.audience,
      canon: request.canon,
      style_guide: request.styleGuide,
      prior_draft: request.priorDraft,
      constraints: request.constraints,
      length: request.length,
      format_intent_for_downstream_formatter: request.formatIntent,
      output_contract: {
        draft: "Full writing text or revised passage. Keep markup minimal unless the brief explicitly asks for a markup-heavy draft.",
        revision_notes: "Short notes about major choices and improvements.",
        continuity_notes: "Canon/logic/style continuity notes for future writing.",
        format_handoff: "Instructions for a separate formatter, not the main draft.",
        quality_checks: "Self-checks for voice, continuity, claims, and completeness.",
        questions: "Only ask if truly blocking; otherwise continue with reasonable assumptions.",
      },
    },
    null,
    2
  );
}

function normalizeWritingResult(parsed, request, rawContent = "") {
  const rawDraft = parsed?.draft ?? parsed?.text ?? parsed?.content ?? rawContent;
  const draft = normalizeText(rawDraft);
  return {
    draft,
    draftPreview: compact(draft, 1800),
    revisionNotes: normalizeList(parsed?.revision_notes || parsed?.revisionNotes || parsed?.notes),
    continuityNotes: normalizeList(parsed?.continuity_notes || parsed?.continuityNotes),
    formatHandoff: normalizeFormatHandoff(parsed?.format_handoff || parsed?.formatHandoff, request.formatIntent),
    qualityChecks: normalizeList(parsed?.quality_checks || parsed?.qualityChecks),
    questions: normalizeList(parsed?.questions),
  };
}

function mockWritingResult(request) {
  const target = request.target || "the requested passage";
  const draft = [
    request.kind === "research_paper" || request.kind === "paper"
      ? `This draft section develops ${target} with a clear claim, evidence-aware framing, and a concise scholarly voice.`
      : `The scene opens around ${target}, grounding the reader in a concrete image before turning toward character desire and consequence.`,
    "",
    request.writingBrief ? `Writing brief honored: ${request.writingBrief}` : "Writing brief honored with a focused draft.",
    request.canon ? `Continuity anchor: ${request.canon.slice(0, 360)}` : "Continuity anchor: no prior canon was supplied.",
  ].join("\n");
  return {
    draft,
    draftPreview: compact(draft, 1800),
    revisionNotes: ["Mock writing specialist produced an isolated writing-only draft."],
    continuityNotes: [request.canon ? "Canon was included in the writing-only context." : "No canon was supplied."],
    formatHandoff: normalizeFormatHandoff("", request.formatIntent),
    qualityChecks: ["Draft is present.", "Agent/runtime/tool context was not part of the writer input."],
    questions: [],
  };
}

export function isLikelyWritingSpecialistGoal(goal = "", taskProfile = "") {
  const text = `${goal}\n${taskProfile}`.toLowerCase();
  const action = /\b(write|draft|revise|rewrite|continue|polish|outline|critique|edit)\b/.test(text);
  const target =
    /\b(novel|story|scene|chapter|book|manuscript|paper|research paper|article|essay|screenplay|script|dialogue|poem|prose|latex)\b/.test(text);
  return action && target;
}

export async function runWritingSpecialist(args = {}, config = {}, store = null) {
  const request = normalizeWritingRequest(args);
  if (!request.writingBrief) {
    return {
      ok: false,
      toolName: "writing_specialist",
      reason: "writingBrief is required.",
    };
  }

  const startedAt = new Date().toISOString();
  const requestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(redactValue(request)))
    .digest("hex");
  let result;
  let writerDefaults = {
    language: likelyLanguageFromText(request),
    reason: "unresolved",
    sessionProvider: "",
  };
  let model = request.model || config.model || "";
  let provider = request.provider || config.provider || "localllm";
  let rawContent = "";

  try {
    writerDefaults = languageWriterDefaults(request, config);
    model = writerDefaults.model;
    provider = writerDefaults.provider;
    if (provider === "mock") {
      provider = "mock";
      model = request.model || config.model || "mock-agent";
      result = mockWritingResult(request);
    } else {
      const selectedProviderDefaults = writerProviderDefaults(provider);
      const retainsSessionProvider = provider === writerDefaults.sessionProvider;
      const writingConfig = {
        ...(retainsSessionProvider
          ? { ...selectedProviderDefaults, ...config }
          : { ...config, ...selectedProviderDefaults }),
        provider,
        model: model || selectedProviderDefaults.model,
        apiKey: retainsSessionProvider
          ? config.apiKey || selectedProviderDefaults.apiKey
          : selectedProviderDefaults.apiKey,
        baseURL: retainsSessionProvider
          ? config.baseURL || selectedProviderDefaults.baseURL
          : selectedProviderDefaults.baseURL,
      };
      model = writingConfig.model;
      provider = writingConfig.provider;
      const client =
        typeof config.writingClientFactory === "function"
          ? config.writingClientFactory({ ...writingConfig })
          : createClient(writingConfig);
      const response = await createChatCompletion(
        client,
        {
          model: writingConfig.model,
          temperature: request.temperature,
          messages: [
            { role: "system", content: writingSystemPrompt() },
            { role: "user", content: writingUserPrompt(request) },
          ],
        },
        writingConfig,
        "writing specialist request"
      );
      rawContent = response.choices[0]?.message?.content || "";
      const parsed = parseJsonObject(rawContent);
      result = normalizeWritingResult(parsed || { draft: rawContent }, request, rawContent);
    }

    const artifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      startedAt,
      provider,
      model,
      requestFingerprint,
      request: redactValue(request),
      result: redactValue(result),
      rawPreview: parsedRawPreview(rawContent),
    };
    const artifactPath = store
      ? await store.saveJsonArtifact(`writing-specialist-${Date.now()}.json`, artifact).catch(() => "")
      : "";
    return {
      ok: true,
      toolName: "writing_specialist",
      provider,
      model,
      args: {
        task: request.task,
        kind: request.kind,
        language: request.language,
        detectedLanguage: writerDefaults.language,
        target: request.target,
        length: request.length,
        provider: request.provider,
        routeReason: writerDefaults.reason,
        formatIntent: request.formatIntent,
        requestFingerprint,
      },
      artifactPath,
      ...result,
    };
  } catch (error) {
    return {
      ok: false,
      blocked: error?.code === "HOSTED_TOOL_PROVIDER_NOT_ALLOWED",
      toolName: "writing_specialist",
      provider,
      model,
      args: {
        task: request.task,
        kind: request.kind,
        language: request.language,
        detectedLanguage: writerDefaults.language,
        target: request.target,
        provider: request.provider,
        routeReason: writerDefaults.reason,
        requestFingerprint,
      },
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function parsedRawPreview(rawContent = "") {
  return rawContent ? compact(rawContent, 1200) : "";
}
