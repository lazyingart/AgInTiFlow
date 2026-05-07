import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";
import { checkWorkspaceToolUse, resolveWorkspacePath } from "./workspace-tools.js";

const DEFAULT_GRS_HOST = "https://grsaiapi.com";
const DEFAULT_VENICE_BASE = "https://api.venice.ai/api/v1";
const DEFAULT_IMAGE_MODEL = "nano-banana-2";
const DEFAULT_VENICE_IMAGE_MODEL = "nano-banana-2";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_IMAGE_SIZE = "2K";
const TRANSIENT_HTTP_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_PROMPT_BYTES = 120_000;
const MAX_REFERENCE_BYTES = 4_000_000;

export const AUXILIARY_SKILLS = [
  {
    id: "image_generation",
    label: "Image generation",
    provider: "grsai",
    keyName: "GRSAI",
    toolName: "generate_image",
    description:
      "Generate raster image artifacts through GRS AI Nano Banana, save the manifest and image files in the workspace, then send selected results to the canvas.",
  },
  {
    id: "venice_image_generation",
    label: "Venice image generation",
    provider: "venice",
    keyName: "VENICE_API_KEY",
    toolName: "generate_image",
    description:
      "Generate raster image artifacts through Venice image models, save the manifest and image files in the workspace, then send selected results to the canvas.",
  },
];

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeStem(value = "image") {
  const stem = String(value || "image")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "image";
}

function normalizeAspectRatio(value) {
  const text = String(value || DEFAULT_ASPECT_RATIO).trim();
  return /^(?:\d+:\d+|1:1|2:3|3:2|3:4|4:3|9:16|16:9)$/.test(text) ? text : DEFAULT_ASPECT_RATIO;
}

function normalizeImageSize(value) {
  const text = String(value || DEFAULT_IMAGE_SIZE).trim();
  return /^(?:1K|2K|4K|1024x1024|1024x1536|1536x1024)$/i.test(text) ? text : DEFAULT_IMAGE_SIZE;
}

function dimensionsForImage(aspectRatio, imageSize) {
  const explicit = String(imageSize || "").match(/^(\d{3,5})x(\d{3,5})$/i);
  if (explicit) return { width: Number(explicit[1]), height: Number(explicit[2]) };
  const longSide = String(imageSize || "").toUpperCase() === "4K" ? 4096 : String(imageSize || "").toUpperCase() === "2K" ? 2048 : 1024;
  const [w = 1, h = 1] = normalizeAspectRatio(aspectRatio)
    .split(":")
    .map((part) => Math.max(Number(part) || 1, 1));
  if (w >= h) return { width: longSide, height: Math.max(256, Math.round((longSide * h) / w)) };
  return { width: Math.max(256, Math.round((longSide * w) / h)), height: longSide };
}

function veniceSizingForModel(model, args = {}) {
  const normalizedModel = String(model || "").toLowerCase();
  const aspectRatio = normalizeAspectRatio(args.aspectRatio);
  const imageSize = normalizeImageSize(args.imageSize).toUpperCase();
  const resolution = /^(?:1K|2K|4K)$/.test(imageSize) ? imageSize : "1K";
  if (/gpt-image|nano-banana/.test(normalizedModel)) {
    return { aspect_ratio: aspectRatio, resolution };
  }
  if (/qwen-image-2|wan-2-7|seedream|recraft|grok-imagine|flux-2|hunyuan|imagineart|chroma/.test(normalizedModel)) {
    return { aspect_ratio: aspectRatio };
  }
  return dimensionsForImage(aspectRatio, imageSize);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

function parseJsonResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Some providers stream server-sent JSON chunks; fall through to line parsing.
  }

  let lastObject = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const chunk = line.trim().replace(/^data:\s*/, "");
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === "object") lastObject = parsed;
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  if (!lastObject) throw new Error("Failed to parse image API response as JSON.");
  return lastObject;
}

function redactPayload(payload) {
  const copy = { ...payload };
  copy.urls = (copy.urls || []).map((item) => {
    const text = String(item || "");
    if (text.startsWith("data:")) return `<data-uri length=${text.length}>`;
    return redactSensitiveText(text);
  });
  return copy;
}

function grsaiKey() {
  return String(process.env.GRSAI || process.env.GRSAI_API_KEY || "").trim();
}

function veniceKey() {
  return String(process.env.VENICE_API_KEY || "").trim();
}

export function listAuxiliarySkills() {
  return AUXILIARY_SKILLS.map((skill) => ({
    ...skill,
    available: skill.provider === "grsai" ? Boolean(grsaiKey()) : skill.provider === "venice" ? Boolean(veniceKey()) : false,
  }));
}

async function referenceToUrl(item, config) {
  const value = String(item || "").trim();
  if (!value) return { url: "", redacted: "" };
  if (/^https?:\/\//i.test(value)) return { url: value, redacted: value };
  if (value.startsWith("data:")) return { url: value, redacted: `<data-uri length=${value.length}>` };

  const target = resolveWorkspacePath(config, value);
  const stat = await fs.stat(target.absolutePath);
  if (!stat.isFile()) throw new Error(`Reference image is not a file: ${target.relativePath}`);
  if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`Reference image is too large: ${target.relativePath}`);
  const buffer = await fs.readFile(target.absolutePath);
  return {
    url: `data:${mimeFromPath(target.relativePath)};base64,${buffer.toString("base64")}`,
    redacted: `<${target.relativePath} data-uri bytes=${buffer.length}>`,
  };
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Operation interrupted by user.");
  error.name = error.name || "AbortError";
  throw error;
}

function sleepAbortable(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation interrupted by user."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestJson(url, payload, apiKey, { timeoutMs = 300000, retries = 2, signal = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || new Error("Operation interrupted by user."));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Image API HTTP ${response.status}: ${redactSensitiveText(text).slice(0, 600)}`);
        error.status = response.status;
        throw error;
      }
      return parseJsonResponse(text);
    } catch (error) {
      if (signal?.aborted || error?.code === "ABORT_ERR" || (error?.name === "AbortError" && !timedOut)) throw error;
      lastError = error;
      const retryable = TRANSIENT_HTTP_CODES.has(Number(error?.status)) || /aborted|timeout|fetch failed/i.test(String(error?.message || ""));
      if (!retryable || attempt >= retries) throw error;
      await sleepAbortable(2000 + attempt * 2000, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError || new Error("Image API request failed.");
}

async function pollResult({ host, taskId, apiKey, outputDir, intervalMs = 5000, timeoutMs = 900000, requestTimeoutMs = 300000, signal = null }) {
  const started = Date.now();
  const pollUrl = `${host.replace(/\/+$/, "")}/v1/draw/result`;
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await requestJson(pollUrl, { id: taskId }, apiKey, {
      timeoutMs: requestTimeoutMs,
      retries: 4,
      signal,
    });
    await writeJson(path.join(outputDir, "result_response.json"), result);

    const data = result.data || {};
    const status = result.status || data.status;
    if (status === "succeeded" || status === "failed") return result;
    if (Date.now() - started > timeoutMs) throw new Error(`Image generation polling timed out for task ${taskId}.`);
    attempt += 1;
    await sleepAbortable(Math.min(intervalMs + attempt * 250, 12000), signal);
  }
}

async function downloadImage(url, destination, signal = null) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AgInTiFlow/1.0",
    },
    signal,
  });
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, buffer);
  return {
    bytes: buffer.length,
    sha256: hashBuffer(buffer),
  };
}

async function writeBase64Image(image, destination) {
  const raw = String(image || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0) throw new Error("Image API returned an empty image payload.");
  await fs.writeFile(destination, buffer);
  return {
    bytes: buffer.length,
    sha256: hashBuffer(buffer),
  };
}

function resultUrls(payload) {
  const data = payload.data || payload;
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((item) => item?.url).filter(Boolean);
}

function normalizeImageProvider(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["venice", "venice-image", "venice-ai", "veniceai"].includes(normalized)) return "venice";
  return "grsai";
}

function defaultImageProvider(config = {}) {
  return normalizeImageProvider(
    config.auxiliaryProvider || process.env.AGINTI_AUX_PROVIDER || process.env.VENICE_IMAGE_PROVIDER || process.env.GRSAI_IMAGE_PROVIDER || ""
  );
}

function veniceBaseUrl(value = "") {
  return String(value || process.env.VENICE_API_BASE || process.env.VENICE_BASE_URL || DEFAULT_VENICE_BASE)
    .trim()
    .replace(/\/+$/, "");
}

async function generateVeniceImages({ prompt, args, target, outputStem, manifest, manifestPath, signal = null }) {
  const apiKey = veniceKey();
  if (!apiKey) {
    throw new Error("Missing VENICE_API_KEY. Run `aginti login venice` or `aginti keys set venice --stdin`.");
  }

  const model =
    String(args.model || process.env.AGINTI_AUX_MODEL || process.env.VENICE_IMAGE_MODEL || DEFAULT_VENICE_IMAGE_MODEL).trim() ||
    DEFAULT_VENICE_IMAGE_MODEL;
  const format = String(args.format || "png").trim().toLowerCase() === "webp" ? "webp" : "png";
  const sizing = veniceSizingForModel(model, args);
  const payload = {
    model,
    prompt,
    ...sizing,
    format,
    return_binary: false,
    variants: 1,
    safe_mode: args.safeMode !== false,
  };
  const requestPath = path.join(target.absolutePath, "request_payload.redacted.json");
  await writeJson(requestPath, payload);

  const base = veniceBaseUrl(args.host);
  const resultPayload = await requestJson(`${base}/image/generate`, payload, apiKey, {
    timeoutMs: Number(args.requestTimeoutMs) || 300000,
    retries: 2,
    signal,
  });
  await writeJson(path.join(target.absolutePath, "venice_result_response.json"), {
    id: resultPayload.id || "",
    images: Array.isArray(resultPayload.images) ? resultPayload.images.map((image) => `<base64 length=${String(image || "").length}>`) : [],
    timing: resultPayload.timing || {},
  });

  const images = Array.isArray(resultPayload.images) ? resultPayload.images : [];
  if (images.length === 0) throw new Error("Venice image API succeeded but returned no images.");
  const imagePaths = [];
  const downloads = [];
  for (let index = 0; index < images.length; index += 1) {
    const filename = images.length === 1 ? `${outputStem}.${format}` : `${outputStem}_${String(index + 1).padStart(2, "0")}.${format}`;
    const absolutePath = path.join(target.absolutePath, filename);
    const info = await writeBase64Image(images[index], absolutePath);
    const relativePath = path.posix.join(target.relativePath, filename);
    imagePaths.push(relativePath);
    downloads.push({ path: relativePath, ...info });
  }

  manifest.provider = "venice";
  manifest.host = base;
  manifest.model = model;
  manifest.status = "succeeded";
  manifest.finishedAt = new Date().toISOString();
  manifest.downloadedFiles = downloads;
  if (resultPayload.id) manifest.taskId = String(resultPayload.id);
  await writeJson(manifestPath, manifest);

  return {
    ok: true,
    toolName: "generate_image",
    provider: "venice",
    path: imagePaths[0] || target.relativePath,
    imagePaths,
    manifestPath: path.posix.join(target.relativePath, "task_manifest.json"),
    promptPath: path.posix.join(target.relativePath, "prompt.txt"),
    requestPayloadPath: path.posix.join(target.relativePath, "request_payload.redacted.json"),
    taskId: resultPayload.id ? String(resultPayload.id) : "",
    summary: `${imagePaths.length} image(s) generated through Venice`,
  };
}

export async function generateImage(args = {}, config = {}) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("Image prompt is required.");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Image prompt is too large.");

  const outputDirInput = args.outputDir || `artifacts/images/${timestampSlug()}`;
  const target = resolveWorkspacePath(config, outputDirInput);
  const writePolicy = checkWorkspaceToolUse("write_file", { path: path.join(target.relativePath, "task_manifest.json") }, config);
  if (!writePolicy.allowed) {
    return {
      ok: false,
      blocked: true,
      reason: writePolicy.reason,
      category: writePolicy.category,
      toolName: "generate_image",
    };
  }

  await fs.mkdir(target.absolutePath, { recursive: true });
  const referenceInputs = Array.isArray(args.referenceImages) ? args.referenceImages : [];
  const references = [];
  for (const item of referenceInputs) {
    const converted = await referenceToUrl(item, config);
    if (converted.url) references.push(converted);
  }

  const provider = args.provider ? normalizeImageProvider(args.provider) : defaultImageProvider(config);
  const host = provider === "venice" ? veniceBaseUrl(args.host) : String(args.host || DEFAULT_GRS_HOST).trim().replace(/\/+$/, "") || DEFAULT_GRS_HOST;
  const model =
    provider === "venice"
      ? String(args.model || config.auxiliaryModel || process.env.AGINTI_AUX_MODEL || process.env.VENICE_IMAGE_MODEL || DEFAULT_VENICE_IMAGE_MODEL).trim() ||
        DEFAULT_VENICE_IMAGE_MODEL
      : String(args.model || config.auxiliaryModel || process.env.AGINTI_AUX_MODEL || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const outputStem = safeStem(args.outputStem || "image");
  const payload = {
    model,
    prompt,
    urls: references.map((item) => item.url),
    aspectRatio: normalizeAspectRatio(args.aspectRatio),
    imageSize: normalizeImageSize(args.imageSize),
    webHook: "-1",
    shutProgress: Boolean(args.shutProgress),
  };

  const redactedPayload = redactPayload(payload);
  redactedPayload.urls = references.map((item) => item.redacted);
  const promptPath = path.join(target.absolutePath, "prompt.txt");
  const requestPath = path.join(target.absolutePath, "request_payload.redacted.json");
  const manifestPath = path.join(target.absolutePath, "task_manifest.json");
  await fs.writeFile(promptPath, `${prompt}\n`, "utf8");
  await writeJson(requestPath, redactedPayload);

  const manifest = {
    tool: "generate_image",
    provider,
    host,
    model,
    outputDir: target.relativePath,
    promptFile: path.posix.join(target.relativePath, "prompt.txt"),
    requestPayloadRedacted: path.posix.join(target.relativePath, "request_payload.redacted.json"),
    status: args.dryRun ? "prepared" : "started",
    createdAt: new Date().toISOString(),
  };
  await writeJson(manifestPath, manifest);

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      toolName: "generate_image",
      provider,
      path: target.relativePath,
      manifestPath: path.posix.join(target.relativePath, "task_manifest.json"),
      promptPath: path.posix.join(target.relativePath, "prompt.txt"),
      requestPayloadPath: path.posix.join(target.relativePath, "request_payload.redacted.json"),
      imagePaths: [],
      summary: "Prepared redacted image-generation payload without calling the provider.",
    };
  }

  if (provider === "venice") {
    return generateVeniceImages({ prompt, args, target, outputStem, manifest, manifestPath, signal: config.abortSignal });
  }

  const apiKey = grsaiKey();
  if (!apiKey) {
    throw new Error("Missing GRSAI key. Run `aginti login grsai`, `aginti keys set grsai --stdin`, or `/auxiliary grsai`.");
  }

  const submitUrl = `${host}/v1/draw/nano-banana`;
  const submitPayload = await requestJson(submitUrl, payload, apiKey, {
    timeoutMs: Number(args.requestTimeoutMs) || 300000,
    retries: 2,
    signal: config.abortSignal,
  });
  await writeJson(path.join(target.absolutePath, "submit_response.json"), submitPayload);
  const taskId = submitPayload?.data?.id || submitPayload?.id;
  if (!taskId) throw new Error("Image API did not return a task id.");

  manifest.taskId = String(taskId);
  manifest.status = "submitted";
  manifest.submittedAt = new Date().toISOString();
  await writeJson(manifestPath, manifest);

  const resultPayload = await pollResult({
    host,
    taskId: String(taskId),
    apiKey,
    outputDir: target.absolutePath,
    intervalMs: Number(args.pollIntervalMs) || 5000,
    timeoutMs: Number(args.pollTimeoutMs) || 900000,
    requestTimeoutMs: Number(args.requestTimeoutMs) || 300000,
    signal: config.abortSignal,
  });

  const status = resultPayload.status || resultPayload?.data?.status;
  if (status !== "succeeded") {
    manifest.status = status || "failed";
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    throw new Error(`Image generation failed with status ${status || "unknown"}. See ${manifestPath}.`);
  }

  const urls = resultUrls(resultPayload);
  if (urls.length === 0) throw new Error("Image API succeeded but returned no image URLs.");
  const imagePaths = [];
  const downloads = [];
  for (let index = 0; index < urls.length; index += 1) {
    const parsed = new URL(urls[index]);
    const suffix = path.extname(parsed.pathname) || ".png";
    const filename = urls.length === 1 ? `${outputStem}${suffix}` : `${outputStem}_${String(index + 1).padStart(2, "0")}${suffix}`;
    const absolutePath = path.join(target.absolutePath, filename);
    const info = await downloadImage(urls[index], absolutePath, config.abortSignal);
    const relativePath = path.posix.join(target.relativePath, filename);
    imagePaths.push(relativePath);
    downloads.push({ path: relativePath, ...info });
  }

  manifest.status = "succeeded";
  manifest.finishedAt = new Date().toISOString();
  manifest.downloadedFiles = downloads;
  await writeJson(manifestPath, manifest);

  return {
    ok: true,
    toolName: "generate_image",
    path: imagePaths[0] || target.relativePath,
    imagePaths,
    manifestPath: path.posix.join(target.relativePath, "task_manifest.json"),
    promptPath: path.posix.join(target.relativePath, "prompt.txt"),
    requestPayloadPath: path.posix.join(target.relativePath, "request_payload.redacted.json"),
    taskId: String(taskId),
    summary: `${imagePaths.length} image(s) generated`,
  };
}
