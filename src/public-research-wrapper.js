import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasSensitiveText, redactSensitiveText } from "./redaction.js";

const DEFAULT_ALLOWED_DOMAINS = [
  "arxiv.org",
  "biorxiv.org",
  "cell.com",
  "docs.github.com",
  "github.com",
  "medrxiv.org",
  "nature.com",
  "ncbi.nlm.nih.gov",
  "nih.gov",
  "nist.gov",
  "plos.org",
  "pubmed.ncbi.nlm.nih.gov",
  "science.org",
  "who.int",
  "wikipedia.org",
];

const FORBIDDEN_CLIENT_FIELDS = new Set([
  "apiKey",
  "api_key",
  "baseURL",
  "baseUrl",
  "command",
  "commandCwd",
  "cwd",
  "env",
  "home",
  "model",
  "provider",
  "reasoning",
  "sandbox",
  "token",
  "wrapper",
]);

const PRIVATE_OR_LOCAL_DOMAIN_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^\[?::1\]?$/i,
];

const DEFAULT_LIMITS = {
  queryChars: 4000,
  contextChars: 8000,
  outputChars: 12000,
  stderrChars: 4000,
  timeoutMs: 90000,
  maxConcurrency: 1,
};

let runningCount = 0;

function commandExists(command, env = process.env) {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [command], { stdio: "ignore", env });
    } else {
      execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore", env });
    }
    return true;
  } catch {
    return false;
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function normalizeDomain(value) {
  const domain = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) return "";
  if (domain.length > 253 || domain.split(".").some((part) => !part || part.length > 63)) return "";
  if (PRIVATE_OR_LOCAL_DOMAIN_PATTERNS.some((pattern) => pattern.test(domain))) return "";
  return domain;
}

function parseServerAllowlist(env = process.env) {
  const configured = String(env.AGINTI_PUBLIC_RESEARCH_ALLOWED_DOMAINS || "")
    .split(/[,\s]+/)
    .map(normalizeDomain)
    .filter(Boolean);
  const domains = configured.length ? configured : DEFAULT_ALLOWED_DOMAINS;
  return [...new Set(domains)];
}

function resolveAllowedDomains(requestedDomains, serverDomains) {
  const serverSet = new Set(serverDomains);
  if (!Array.isArray(requestedDomains) || requestedDomains.length === 0) return serverDomains;

  const requested = requestedDomains.map(normalizeDomain).filter(Boolean);
  if (requested.length === 0) throw new Error("allowedDomains must contain public domain names.");

  const rejected = requested.filter((domain) => !serverSet.has(domain));
  if (rejected.length) {
    throw new Error(`Requested domains are outside the server allowlist: ${rejected.slice(0, 5).join(", ")}`);
  }
  return [...new Set(requested)];
}

function sanitizeClientPayload(body = {}) {
  const keys = Object.keys(body || {});
  const forbidden = keys.filter((key) => FORBIDDEN_CLIENT_FIELDS.has(key));
  if (forbidden.length) {
    throw new Error(`Client-controlled route/model/runtime fields are not accepted: ${forbidden.join(", ")}`);
  }

  const query = String(body.query ?? body.question ?? body.prompt ?? "").trim();
  const context = String(body.context ?? "").trim();
  if (!query) throw new Error("query is required.");
  if (query.length > DEFAULT_LIMITS.queryChars) throw new Error(`query exceeds ${DEFAULT_LIMITS.queryChars} characters.`);
  if (context.length > DEFAULT_LIMITS.contextChars) throw new Error(`context exceeds ${DEFAULT_LIMITS.contextChars} characters.`);
  if (hasSensitiveText(`${query}\n${context}`)) throw new Error("Request appears to contain a secret or credential.");
  return { query, context };
}

function makeStatus(env = process.env) {
  const enabled = truthy(env.AGINTI_PUBLIC_RESEARCH_ENABLED);
  const codexHome = String(env.AGINTI_PUBLIC_RESEARCH_CODEX_HOME || "").trim();
  const realHome = path.resolve(os.homedir());
  const resolvedCodexHome = codexHome ? path.resolve(codexHome) : "";
  const defaultCodexHome = path.join(realHome, ".codex");
  const dedicatedCodexHome =
    Boolean(resolvedCodexHome) && resolvedCodexHome !== realHome && resolvedCodexHome !== defaultCodexHome;
  const codexAvailable = commandExists("codex", env);
  const maxConcurrency = boundedInteger(env.AGINTI_PUBLIC_RESEARCH_MAX_CONCURRENCY, DEFAULT_LIMITS.maxConcurrency, {
    min: 1,
    max: 8,
  });
  const timeoutMs = boundedInteger(env.AGINTI_PUBLIC_RESEARCH_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, {
    min: 5000,
    max: 300000,
  });

  let unavailableReason = "";
  if (!enabled) unavailableReason = "public research wrapper is disabled";
  else if (!codexAvailable) unavailableReason = "Codex CLI is unavailable";
  else if (!dedicatedCodexHome) unavailableReason = "dedicated Codex home is not configured";

  return {
    ok: true,
    feature: "public-research-wrapper",
    route: "server-owned-codex",
    enabled,
    available: enabled && codexAvailable && dedicatedCodexHome,
    unavailableReason,
    modelExposed: false,
    running: runningCount,
    limits: {
      queryChars: DEFAULT_LIMITS.queryChars,
      contextChars: DEFAULT_LIMITS.contextChars,
      outputChars: DEFAULT_LIMITS.outputChars,
      stderrChars: DEFAULT_LIMITS.stderrChars,
      timeoutMs,
      maxConcurrency,
    },
    policy: {
      publicNetworkOnly: true,
      allowlistedDomainsOnly: true,
      clientModelSelection: false,
      projectWorkspaceAccess: false,
      hostHomeAccess: false,
      secretInputs: "reject",
      unavailableBehavior: "fail-closed",
    },
  };
}

function buildCodexPrompt({ query, context, domains }) {
  return [
    "You are a server-owned public research helper behind an application boundary.",
    "Answer only the user's research question using public information from the allowlisted domains below.",
    "Do not inspect local files, repositories, host home folders, environment variables, credentials, private networks, localhost, or internal services.",
    "Do not ask for, print, transform, or infer secrets. If the request needs private data or non-allowlisted sites, say the boundary blocks it.",
    "Do not write files, install packages, run host commands, deploy, or persist data.",
    "Return concise, source-aware findings. If you cannot verify the answer within the allowlist, say so explicitly.",
    "",
    `Allowed public domains: ${domains.join(", ")}`,
    context ? `\nNon-secret caller context:\n${context}` : "",
    `\nResearch question:\n${query}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function makeCodexArgs({ prompt, outputFile, workspaceDir }, env = process.env) {
  const args = ["exec"];
  const model = String(env.AGINTI_PUBLIC_RESEARCH_CODEX_MODEL || "").trim();
  const reasoning = String(env.AGINTI_PUBLIC_RESEARCH_CODEX_REASONING || "").trim();
  if (model) args.push("--model", model);
  if (reasoning) args.push("-c", `model_reasoning_effort="${reasoning}"`);
  args.push(
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'shell_environment_policy.inherit="none"',
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    workspaceDir,
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile
  );
  args.push("--", prompt);
  return args;
}

function makeProcessEnv({ tempDir, codexHome }, baseEnv = process.env) {
  const tempHome = path.join(tempDir, "home");
  const tempConfig = path.join(tempDir, "config");
  const tempCache = path.join(tempDir, "cache");
  return {
    PATH: baseEnv.PATH || "",
    HOME: tempHome,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: tempConfig,
    XDG_CACHE_HOME: tempCache,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    NO_COLOR: "1",
    TERM: baseEnv.TERM || "xterm-256color",
  };
}

function killChildTree(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function runCodex(spec, limits) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", spec.args, {
      cwd: spec.workspaceDir,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child, "SIGTERM");
      setTimeout(() => killChildTree(child, "SIGKILL"), 1200).unref?.();
    }, limits.timeoutMs);
    timer.unref?.();

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < limits.outputChars) stdout += chunk.toString().slice(0, limits.outputChars - stdout.length);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < limits.stderrChars) stderr += chunk.toString().slice(0, limits.stderrChars - stderr.length);
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      if (timedOut) {
        const error = new Error(`Public research wrapper timed out after ${limits.timeoutMs}ms.`);
        error.code = 124;
        error.stdout = stdout;
        error.stderr = stderr;
        settle(() => reject(error));
        return;
      }
      if (Number(code || 0) === 0) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }
      const error = new Error(`Public research wrapper exited with ${signal || code}.`);
      error.code = Number.isInteger(code) ? code : 1;
      error.stdout = stdout;
      error.stderr = stderr;
      settle(() => reject(error));
    });
  });
}

async function ensureDedicatedCodexHome(codexHome) {
  const stat = await fs.stat(codexHome).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error("Public research wrapper dedicated Codex home does not exist.");
  }
}

export function getPublicResearchWrapperStatus(env = process.env) {
  return makeStatus(env);
}

export async function runPublicResearchWrapper(body = {}, env = process.env) {
  const status = makeStatus(env);
  if (!status.available) {
    return { ...status, ok: false, error: "Public research wrapper is unavailable." };
  }
  if (runningCount >= status.limits.maxConcurrency) {
    return { ok: false, blocked: true, status: 429, error: "Public research wrapper concurrency limit reached." };
  }

  let tempDir = "";
  runningCount += 1;
  try {
    const { query, context } = sanitizeClientPayload(body);
    const serverDomains = parseServerAllowlist(env);
    const domains = resolveAllowedDomains(body.allowedDomains, serverDomains);
    const codexHome = path.resolve(String(env.AGINTI_PUBLIC_RESEARCH_CODEX_HOME || ""));
    await ensureDedicatedCodexHome(codexHome);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-public-research-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const outputFile = path.join(tempDir, "last-message.txt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, "home"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "config"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "cache"), { recursive: true });

    const prompt = buildCodexPrompt({ query, context, domains });
    const processEnv = makeProcessEnv({ tempDir, codexHome }, env);
    const args = makeCodexArgs({ prompt, outputFile, workspaceDir }, env);
    const result = await runCodex({ args, env: processEnv, workspaceDir }, status.limits);
    const lastMessage = await fs.readFile(outputFile, "utf8").catch(() => "");
    const answer = redactSensitiveText(lastMessage || result.stdout).trim().slice(0, status.limits.outputChars);
    const stderr = redactSensitiveText(result.stderr || "").trim().slice(0, status.limits.stderrChars);
    if (!answer) throw new Error("Public research wrapper returned no answer.");

    return {
      ok: true,
      feature: status.feature,
      route: status.route,
      modelExposed: false,
      answer,
      stderr: stderr || undefined,
      allowedDomains: domains,
      limits: status.limits,
      policy: status.policy,
    };
  } catch (error) {
    const statusCode = Number.isInteger(error?.code) && error.code === 124 ? 504 : 400;
    return {
      ok: false,
      feature: status.feature,
      route: status.route,
      modelExposed: false,
      status: statusCode,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      stdout: redactSensitiveText(error?.stdout || "").trim().slice(0, DEFAULT_LIMITS.outputChars) || undefined,
      stderr: redactSensitiveText(error?.stderr || "").trim().slice(0, DEFAULT_LIMITS.stderrChars) || undefined,
    };
  } finally {
    runningCount = Math.max(0, runningCount - 1);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
