import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { isDomainAllowed } from "./guardrails.js";
import { redactSensitiveText } from "./redaction.js";
import { normalizeWrapperName, runAgentWrapper } from "./tool-wrappers.js";
import { searchWeb } from "./web-search.js";
import { resolveWorkspacePath } from "./workspace-tools.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;
const MAX_QUERY_BYTES = 1000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactText(value, limit = 12000) {
  const text = redactSensitiveText(String(value || "")).trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n[truncated]`;
}

function openAiApiKey(config = {}) {
  if (config.provider === "openai" && config.apiKey) return config.apiKey;
  return process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
}

function openAiBaseUrl(config = {}) {
  if (config.provider === "openai" && config.baseURL) return config.baseURL;
  return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
}

function uniqueList(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function isModelFallbackError(error) {
  const message = `${error?.status || ""} ${error?.message || ""} ${error?.error?.message || ""}`.toLowerCase();
  return /does not have access|model .*not found|unknown model|invalid model|not supported|unsupported model|403/.test(message);
}

function outputTextFromResponse(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
      if (typeof content?.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseModelJsonObject(candidate = "") {
  const text = String(candidate || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  const variants = [
    text,
    // Hosted model wrappers occasionally produce near-JSON with trailing
    // commas. Keep the repair narrow so malformed structure still fails.
    text.replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const variant of uniqueList(variants)) {
    try {
      const parsed = JSON.parse(variant);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next narrow repair variant.
    }
  }
  return null;
}

export function firstJsonObject(text = "") {
  const source = String(text || "").trim();
  if (!source) return null;
  const direct = parseModelJsonObject(source);
  if (direct) return direct;

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsedFenced = parseModelJsonObject(fenced);
    if (parsedFenced) return parsedFenced;
  }

  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return parseModelJsonObject(source.slice(start, index + 1));
      }
    }
  }
  return null;
}

async function persistToolArtifact(store, subdir, stem, payload) {
  if (!store?.artifactsDir) return "";
  await store.ensure();
  const outputDir = path.join(store.artifactsDir, subdir);
  await fs.mkdir(outputDir, { recursive: true });
  const filename = `${isoStamp()}-${stem}.json`;
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function imageMimeForPath(inputPath, contentType = "") {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  const ext = path.extname(String(inputPath || "")).toLowerCase();
  return MIME_BY_EXT.get(ext) || "";
}

async function loadLocalImage(inputPath, config) {
  const target = resolveWorkspacePath(config, inputPath);
  const stat = await fs.stat(target.absolutePath);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${target.relativePath}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large: ${target.relativePath} (${stat.size} bytes)`);
  const ext = path.extname(target.absolutePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) throw new Error(`Unsupported image type: ${target.relativePath}`);
  const buffer = await fs.readFile(target.absolutePath);
  return {
    source: "workspace",
    path: target.relativePath,
    absolutePath: target.absolutePath,
    mime: imageMimeForPath(target.absolutePath),
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    dataUrl: `data:${imageMimeForPath(target.absolutePath)};base64,${buffer.toString("base64")}`,
  };
}

async function loadRemoteImage(url, config) {
  if (config.allowWebSearch === false) throw new Error("Remote image reading requires web access to be enabled.");
  if (!/^https?:\/\//i.test(url)) throw new Error("Remote images must use http or https URLs.");
  if (!isDomainAllowed(url, config.allowedDomains || [])) throw new Error(`Remote image domain is outside the allowlist: ${url}`);
  const response = await fetch(url, {
    signal: config.abortSignal || AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "AgInTiFlow/1.0 (+https://flow.lazying.art)",
      Accept: "image/*,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`Remote image fetch failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const mime = imageMimeForPath(url, contentType);
  if (!mime) throw new Error(`Remote URL did not return a supported image content-type: ${contentType || "unknown"}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Remote image is too large: ${buffer.length} bytes`);
  return {
    source: "url",
    url,
    mime,
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
  };
}

async function loadImageInputs(args, config) {
  const values = normalizeList(args.imagePaths || args.images || args.paths || args.imagePath || args.path || args.url);
  if (values.length === 0) throw new Error("At least one image path or URL is required.");
  if (values.length > MAX_IMAGE_COUNT) throw new Error(`Too many images. Maximum is ${MAX_IMAGE_COUNT}.`);
  const images = [];
  for (const value of values) {
    images.push(/^https?:\/\//i.test(value) ? await loadRemoteImage(value, config) : await loadLocalImage(value, config));
  }
  return images;
}

function buildImageReadPrompt(args, images) {
  const prompt = String(args.prompt || args.question || "Describe the image accurately.").trim();
  return [
    "Return strict JSON only. Do not wrap in markdown.",
    "Schema:",
    JSON.stringify({
      summary: "short factual summary",
      visibleText: ["OCR text or labels, empty if none"],
      observations: ["concrete visible details"],
      issues: ["possible UI/data/quality issues, empty if none"],
      answer: "direct answer to the user's question",
      uncertainty: ["limits, ambiguity, or details not visible"],
    }),
    "Rules: describe only visible evidence; do not infer identity, diagnosis, or private facts beyond the image. If uncertain, say so.",
    `User question: ${prompt}`,
    `Images: ${images
      .map((image, index) => `${index + 1}. ${image.path || image.url} ${image.mime} ${image.sizeBytes} bytes sha256=${image.sha256}`)
      .join("; ")}`,
  ].join("\n");
}

async function callOpenAiImageRead(args, images, config) {
  const apiKey = openAiApiKey(config);
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY. Configure OpenAI to enable read_image, or use research_wrapper for text-only advisory fallback.");
  const preferredModel = String(args.model || config.perceptionModel || process.env.AGINTI_PERCEPTION_MODEL || "gpt-5.4-mini").trim();
  const fallbackModels = normalizeList(args.fallbackModels || process.env.AGINTI_PERCEPTION_FALLBACK_MODELS || "gpt-4o-mini");
  const models = uniqueList([preferredModel, ...fallbackModels]);
  const reasoning = String(args.reasoning || config.perceptionReasoning || process.env.AGINTI_PERCEPTION_REASONING || "medium").trim();
  const detail = ["low", "high", "auto"].includes(String(args.detail || "").toLowerCase())
    ? String(args.detail).toLowerCase()
    : "auto";
  const client = new OpenAI({
    apiKey,
    baseURL: openAiBaseUrl(config),
  });
  const content = [
    { type: "input_text", text: buildImageReadPrompt(args, images) },
    ...images.map((image) => ({
      type: "input_image",
      image_url: image.dataUrl,
      detail,
    })),
  ];
  const requestOptions = {
      timeout: Number(config.modelTimeoutMs || process.env.AGINTI_MODEL_TIMEOUT_MS || 180000),
      ...(config.abortSignal ? { signal: config.abortSignal } : {}),
  };
  let lastError = null;
  let response = null;
  let usedModel = "";
  let usedReasoning = reasoning;
  for (const model of models) {
    const payload = {
      model,
      input: [{ role: "user", content }],
      max_output_tokens: clampInteger(args.maxOutputTokens, 512, 6000, 1800),
    };
    if (reasoning) payload.reasoning = { effort: reasoning };
    try {
      response = await client.responses.create(payload, requestOptions);
      usedModel = model;
      break;
    } catch (error) {
      if (payload.reasoning) {
        const retryPayload = { ...payload };
        delete retryPayload.reasoning;
        try {
          response = await client.responses.create(retryPayload, requestOptions);
          usedModel = model;
          usedReasoning = "";
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      } else {
        lastError = error;
      }
      if (!isModelFallbackError(lastError)) throw lastError;
    }
  }
  if (!response) throw lastError || new Error("OpenAI image reading failed.");
  const rawText = outputTextFromResponse(response);
  return {
    provider: "openai-responses",
    model: usedModel,
    reasoning: usedReasoning,
    detail,
    rawText: compactText(rawText),
    parsed: firstJsonObject(rawText),
  };
}

export async function readImage(args = {}, config = {}, store = null) {
  const loadedImages = [];
  let payload = null;
  try {
    const images = await loadImageInputs(args, config);
    loadedImages.push(...images);
    const analysis = args.dryRun ? { provider: "dry-run", rawText: "", parsed: { summary: "read_image dry run", answer: "dry run" } } : await callOpenAiImageRead(args, images, config);
    payload = {
      ok: true,
      toolName: "read_image",
      provider: analysis.provider,
      model: analysis.model || "",
      reasoning: analysis.reasoning || "",
      detail: analysis.detail || "",
      prompt: redactSensitiveText(String(args.prompt || args.question || "")),
      images: images.map(({ dataUrl, absolutePath, ...image }) => image),
      result: analysis.parsed || { summary: analysis.rawText, answer: analysis.rawText, uncertainty: ["Model output was not valid JSON."] },
      rawText: analysis.parsed ? "" : analysis.rawText,
    };
    payload.artifactPath = await persistToolArtifact(store, "perception", "read-image", payload);
    return payload;
  } catch (error) {
    payload = {
      ok: false,
      toolName: "read_image",
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      images: loadedImages.map(({ dataUrl, absolutePath, ...image }) => image),
    };
    payload.artifactPath = await persistToolArtifact(store, "perception", "read-image-failed", payload);
    return payload;
  }
}

function extractResponseSources(response) {
  const sources = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const url = value.url || value.uri;
    if (typeof url === "string" && /^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      sources.push({
        title: redactSensitiveText(String(value.title || value.name || "").slice(0, 220)),
        url,
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(response?.output);
  return sources.slice(0, 40);
}

async function callOpenAiWebResearch(args, config) {
  const apiKey = openAiApiKey(config);
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY for OpenAI hosted web research.");
  const preferredModel = String(args.model || config.webResearchModel || process.env.AGINTI_WEB_RESEARCH_MODEL || "gpt-5.4-mini").trim();
  const fallbackModels = normalizeList(args.fallbackModels || process.env.AGINTI_WEB_RESEARCH_FALLBACK_MODELS || "gpt-4o-mini");
  const models = uniqueList([preferredModel, ...fallbackModels]);
  const reasoning = String(args.reasoning || config.webResearchReasoning || process.env.AGINTI_WEB_RESEARCH_REASONING || "medium").trim();
  const domains = normalizeList(args.domains || args.allowedDomains);
  const blockedDomains = normalizeList(args.blockedDomains);
  const filters = {};
  if (domains.length) filters.allowed_domains = domains;
  if (blockedDomains.length) filters.blocked_domains = blockedDomains;
  const client = new OpenAI({
    apiKey,
    baseURL: openAiBaseUrl(config),
  });
  const tool = {
    type: "web_search",
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(args.live === false || args.externalWebAccess === false ? { external_web_access: false } : {}),
  };
  const payload = {
    reasoning: reasoning ? { effort: reasoning } : undefined,
    tools: [tool],
    tool_choice: args.requireSearch === false ? "auto" : "required",
    include: ["web_search_call.action.sources"],
    input: [
      "Use web search and answer with clear citations/source URLs.",
      "Prefer primary/official sources when available. State uncertainty and date-sensitive assumptions.",
      `Query: ${String(args.query || "").trim()}`,
    ].join("\n"),
  };
  if (!payload.reasoning) delete payload.reasoning;
  const requestOptions = {
    timeout: Number(config.modelTimeoutMs || process.env.AGINTI_MODEL_TIMEOUT_MS || 180000),
    ...(config.abortSignal ? { signal: config.abortSignal } : {}),
  };
  let response = null;
  let usedModel = "";
  let usedReasoning = reasoning;
  let lastError = null;
  for (const model of models) {
    const modelPayload = { ...payload, model };
    try {
      response = await client.responses.create(modelPayload, requestOptions);
      usedModel = model;
      break;
    } catch (error) {
      const message = `${error?.message || ""} ${error?.error?.message || ""}`;
      if (/reasoning\.effort|reasoning|unsupported parameter/i.test(message) && modelPayload.reasoning) {
        const noReasoningPayload = { ...modelPayload };
        delete noReasoningPayload.reasoning;
        try {
          response = await client.responses.create(noReasoningPayload, requestOptions);
          usedModel = model;
          usedReasoning = "";
          break;
        } catch (noReasoningError) {
          const retryMessage = `${noReasoningError?.message || ""} ${noReasoningError?.error?.message || ""}`;
          if (/web_search|tool|invalid/i.test(retryMessage)) {
            try {
              response = await client.responses.create(
                {
                  ...noReasoningPayload,
                  tools: [{ ...tool, type: "web_search_preview" }],
                },
                requestOptions
              );
              usedModel = model;
              usedReasoning = "";
              break;
            } catch (previewError) {
              lastError = previewError;
            }
          } else {
            lastError = noReasoningError;
          }
        }
      } else if (/web_search|tool|invalid/i.test(message)) {
        try {
          response = await client.responses.create(
            {
              ...modelPayload,
              tools: [{ ...tool, type: "web_search_preview" }],
            },
            requestOptions
          );
          usedModel = model;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      } else {
        lastError = error;
      }
      if (!isModelFallbackError(lastError)) throw lastError;
    }
  }
  if (!response) throw lastError || new Error("OpenAI hosted web research failed.");
  return {
    provider: "openai-responses-web_search",
    model: usedModel,
    reasoning: usedReasoning,
    answer: compactText(outputTextFromResponse(response)),
    sources: extractResponseSources(response),
  };
}

function summarizeSnippetResults(results = []) {
  if (!results.length) return "No parsed search results were returned. Use the searchUrl fallback or try a narrower query/domain.";
  return results
    .map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet || "(no snippet)"}`)
    .join("\n\n");
}

export async function webResearch(args = {}, config = {}, store = null) {
  const query = String(args.query || "").trim();
  const mode = String(args.mode || "snippets").trim().toLowerCase();
  const domains = normalizeList(args.domains || args.allowedDomains);
  const maxResults = clampInteger(args.maxResults, 1, 10, 5);
  if (!query) return { ok: false, toolName: "web_research", error: "Research query is required." };
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    return { ok: false, toolName: "web_research", error: "Research query is too large." };
  }

  const snippetResult = await searchWeb(
    {
      query,
      maxResults,
      timeoutMs: args.timeoutMs,
      domains,
    },
    {
      ...config,
      allowedDomains: domains.length ? domains : config.allowedDomains || [],
    }
  );

  const payload = {
    ok: Boolean(snippetResult.ok),
    toolName: "web_research",
    query: redactSensitiveText(query),
    mode,
    domains,
    provider: snippetResult.provider || "duckduckgo-html",
    search: snippetResult,
    answer: summarizeSnippetResults(snippetResult.results || []),
    sources: (snippetResult.results || []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
    note:
      "Default web_research mode uses lightweight search snippets. Use mode=openai for hosted sourced synthesis or research_wrapper for a read-only wrapper second opinion.",
  };

  if (mode === "openai") {
    try {
      const openai = await callOpenAiWebResearch(args, config);
      payload.ok = true;
      payload.provider = openai.provider;
      payload.model = openai.model;
      payload.reasoning = openai.reasoning;
      payload.answer = openai.answer;
      payload.sources = openai.sources.length ? openai.sources : payload.sources;
      payload.note = "OpenAI hosted web_search completed; lightweight snippet results are preserved under search.";
    } catch (error) {
      payload.openaiError = redactSensitiveText(error instanceof Error ? error.message : String(error));
      payload.note = "OpenAI hosted web_search failed; returned lightweight snippet fallback.";
    }
  }

  payload.artifactPath = await persistToolArtifact(store, "research", "web-research", payload);
  return payload;
}

function wrapperTaskPrompt(args, metadata = {}) {
  const task = String(args.task || "web_research").trim() || "web_research";
  const outputSchema = {
    ok: true,
    task,
    summary: "short answer",
    findings: ["evidence-backed observations"],
    sources: [{ title: "source title", url: "https://..." }],
    uncertainties: ["limits or missing evidence"],
    recommendedNextSteps: ["optional next check"],
  };
  const parts = [
    "Return strict JSON only. Do not modify files, run installs, use secrets, or claim evidence you did not inspect.",
    `Required schema: ${JSON.stringify(outputSchema)}`,
    `Task: ${task}`,
    args.query ? `Query: ${String(args.query).trim()}` : "",
    args.prompt ? `Prompt: ${String(args.prompt).trim()}` : "",
    metadata.images?.length
      ? `Images: ${metadata.images
          .map((image, index) => `${index + 1}. ${image.path || image.url} ${image.mime || ""} sha256=${image.sha256 || ""}`)
          .join("; ")}. If your wrapper cannot directly inspect pixels from these paths, say so in uncertainties instead of guessing.`
      : "",
    metadata.search?.results?.length ? `Search snippets:\n${summarizeSnippetResults(metadata.search.results)}` : "",
  ].filter(Boolean);
  return compactText(parts.join("\n\n"), 3800);
}

export async function researchWrapper(args = {}, config = {}, store = null) {
  const wrapper = normalizeWrapperName(args.wrapper || config.preferredWrapper || "codex");
  const metadata = {};
  try {
    if (args.imagePath || args.imagePaths || args.images || args.paths || args.url) {
      const images = await loadImageInputs(args, config);
      metadata.images = images.map(({ dataUrl, absolutePath, ...image }) => image);
    }
    if (args.query && args.includeSearch !== false) {
      metadata.search = await searchWeb(
        { query: args.query, maxResults: clampInteger(args.maxResults, 1, 8, 4), domains: args.domains || args.allowedDomains },
        {
          ...config,
          allowedDomains: normalizeList(args.domains || args.allowedDomains).length
            ? normalizeList(args.domains || args.allowedDomains)
            : config.allowedDomains || [],
        }
      );
    }
    const wrapperConfig = {
      ...config,
      wrapperModel: args.model || config.researchWrapperModel || process.env.AGINTI_RESEARCH_WRAPPER_MODEL || "gpt-5.4-mini",
      wrapperReasoning: args.reasoning || config.researchWrapperReasoning || process.env.AGINTI_RESEARCH_WRAPPER_REASONING || "medium",
    };
    const wrapperResult = args.dryRun
      ? { ok: true, wrapper, stdout: JSON.stringify({ ok: true, task: args.task || "dry-run", summary: "research_wrapper dry run" }) }
      : await runAgentWrapper({ wrapper, prompt: wrapperTaskPrompt(args, metadata) }, wrapperConfig);
    const parsed = firstJsonObject(wrapperResult.stdout || "");
    const payload = {
      ok: Boolean(wrapperResult.ok),
      toolName: "research_wrapper",
      wrapper,
      model: wrapperConfig.wrapperModel,
      reasoning: wrapperConfig.wrapperReasoning,
      task: args.task || "",
      query: redactSensitiveText(String(args.query || "")),
      metadata,
      result: parsed || null,
      stdout: parsed ? "" : compactText(wrapperResult.stdout || ""),
      stderr: compactText(wrapperResult.stderr || "", 4000),
      error: wrapperResult.ok ? "" : redactSensitiveText(wrapperResult.error || ""),
    };
    payload.artifactPath = await persistToolArtifact(store, "wrappers", "research-wrapper", payload);
    return payload;
  } catch (error) {
    const payload = {
      ok: false,
      toolName: "research_wrapper",
      wrapper,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      metadata,
    };
    payload.artifactPath = await persistToolArtifact(store, "wrappers", "research-wrapper-failed", payload);
    return payload;
  }
}
