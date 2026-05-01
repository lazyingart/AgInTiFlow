import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.js";
import { checkWorkspaceToolUse, resolveWorkspacePath } from "./workspace-tools.js";

const DEFAULT_GRS_HOST = "https://grsaiapi.com";
const DEFAULT_IMAGE_MODEL = "nano-banana-2";
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

export function listAuxiliarySkills() {
  return AUXILIARY_SKILLS.map((skill) => ({
    ...skill,
    available: skill.provider === "grsai" ? Boolean(grsaiKey()) : false,
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

async function requestJson(url, payload, apiKey, { timeoutMs = 300000, retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      lastError = error;
      const retryable = TRANSIENT_HTTP_CODES.has(Number(error?.status)) || /aborted|timeout|fetch failed/i.test(String(error?.message || ""));
      if (!retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 + attempt * 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Image API request failed.");
}

async function pollResult({ host, taskId, apiKey, outputDir, intervalMs = 5000, timeoutMs = 900000, requestTimeoutMs = 300000 }) {
  const started = Date.now();
  const pollUrl = `${host.replace(/\/+$/, "")}/v1/draw/result`;
  let attempt = 0;
  while (true) {
    const result = await requestJson(pollUrl, { id: taskId }, apiKey, {
      timeoutMs: requestTimeoutMs,
      retries: 4,
    });
    await writeJson(path.join(outputDir, "result_response.json"), result);

    const data = result.data || {};
    const status = result.status || data.status;
    if (status === "succeeded" || status === "failed") return result;
    if (Date.now() - started > timeoutMs) throw new Error(`Image generation polling timed out for task ${taskId}.`);
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs + attempt * 250, 12000)));
  }
}

async function downloadImage(url, destination) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AgInTiFlow/1.0",
    },
  });
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
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

  const host = String(args.host || DEFAULT_GRS_HOST).trim().replace(/\/+$/, "") || DEFAULT_GRS_HOST;
  const model = String(args.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
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
    provider: "grsai",
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
      path: target.relativePath,
      manifestPath: path.posix.join(target.relativePath, "task_manifest.json"),
      promptPath: path.posix.join(target.relativePath, "prompt.txt"),
      requestPayloadPath: path.posix.join(target.relativePath, "request_payload.redacted.json"),
      imagePaths: [],
      summary: "Prepared redacted image-generation payload without calling the provider.",
    };
  }

  const apiKey = grsaiKey();
  if (!apiKey) {
    throw new Error("Missing GRSAI key. Run `aginti login grsai`, `aginti keys set grsai --stdin`, or `/auxilliary grsai`.");
  }

  const submitUrl = `${host}/v1/draw/nano-banana`;
  const submitPayload = await requestJson(submitUrl, payload, apiKey, {
    timeoutMs: Number(args.requestTimeoutMs) || 300000,
    retries: 2,
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
    const info = await downloadImage(urls[index], absolutePath);
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
