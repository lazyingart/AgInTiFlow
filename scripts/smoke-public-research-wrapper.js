#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicResearchWrapperStatus } from "../src/public-research-wrapper.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-public-research-smoke-"));
const fakeBin = path.join(runtimeDir, "bin");
const dedicatedCodexHome = path.join(runtimeDir, "server-codex-home");
const agintiflowHome = path.join(runtimeDir, ".agintiflow-home");
const port = 45000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

await fs.mkdir(fakeBin, { recursive: true });
await fs.mkdir(dedicatedCodexHome, { recursive: true });

const fakeCodex = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const cdIndex = args.indexOf("--cd");
const sandboxIndex = args.indexOf("--sandbox");
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : "";
const workspace = cdIndex >= 0 ? args[cdIndex + 1] : "";
const sandbox = sandboxIndex >= 0 ? args[sandboxIndex + 1] : "";
const secretEnvKeys = Object.keys(process.env).filter((key) => /(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key));
const failures = [];

if (!args.includes("exec")) failures.push("missing exec");
if (!args.includes("--ephemeral")) failures.push("missing ephemeral");
if (!args.includes("--ignore-user-config")) failures.push("missing ignore-user-config");
if (!args.includes("--ignore-rules")) failures.push("missing ignore-rules");
if (!args.includes('shell_environment_policy.inherit="none"')) failures.push("shell env inheritance not disabled");
if (sandbox !== "read-only") failures.push("sandbox not read-only");
if (!workspace.includes("aginti-public-research-")) failures.push("workspace is not disposable");
if (process.cwd() !== workspace) failures.push("process cwd does not match disposable workspace");
if (!String(process.env.HOME || "").includes("aginti-public-research-")) failures.push("HOME is not disposable");
if (!String(process.env.CODEX_HOME || "").endsWith("server-codex-home")) failures.push("CODEX_HOME is not dedicated");
if (secretEnvKeys.length) failures.push("secret env leaked: " + secretEnvKeys.join(","));
if (!args.at(-1).includes("Allowed public domains: nih.gov")) failures.push("allowed domain prompt missing");
if (!outputFile) failures.push("missing output file");

if (failures.length) {
  console.error(failures.join("; "));
  process.exit(47);
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, "Fake public research answer from the server-owned route.\\n");
`;
const fakeCodexPath = path.join(fakeBin, process.platform === "win32" ? "codex.cmd" : "codex");
await fs.writeFile(fakeCodexPath, fakeCodex, "utf8");
await fs.chmod(fakeCodexPath, 0o755);

const disabledStatus = getPublicResearchWrapperStatus({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` });
if (disabledStatus.available || disabledStatus.enabled || disabledStatus.modelExposed !== false) {
  throw new Error(`disabled status is not fail-closed: ${JSON.stringify(disabledStatus)}`);
}

const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
    AGINTIFLOW_HOME: agintiflowHome,
    AGINTI_PUBLIC_RESEARCH_ENABLED: "1",
    AGINTI_PUBLIC_RESEARCH_ALLOWED_DOMAINS: "nih.gov pubmed.ncbi.nlm.nih.gov",
    AGINTI_PUBLIC_RESEARCH_CODEX_HOME: dedicatedCodexHome,
    AGINTI_PUBLIC_RESEARCH_MAX_CONCURRENCY: "1",
    AGINTI_PUBLIC_RESEARCH_TIMEOUT_MS: "10000",
    OPENAI_API_KEY: "sk-smoke-secret-value-that-must-not-leak",
    DEEPSEEK_API_KEY: "sk-smoke-secret-value-that-must-not-leak",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const { response, body } = await fetchJson("/health");
      if (response.ok && body.ok) return;
    } catch {
      // Wait and retry.
    }
    await delay(250);
  }
  throw new Error(`web server did not become healthy. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

try {
  await waitForHealth();

  const status = await fetchJson("/api/public-research/status");
  if (!status.response.ok || !status.body.available || status.body.modelExposed !== false) {
    throw new Error(`public research status invalid: ${JSON.stringify(status.body)}`);
  }
  if (JSON.stringify(status.body).match(/gpt|model_reasoning|AGINTI_PUBLIC_RESEARCH_CODEX_MODEL/i)) {
    throw new Error(`public research status exposed model internals: ${JSON.stringify(status.body)}`);
  }

  const run = await fetchJson("/api/public-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "Summarize public NIH guidance about reproducible biomedical literature searches.",
      allowedDomains: ["nih.gov"],
    }),
  });
  if (!run.response.ok || !run.body.ok || !run.body.answer.includes("Fake public research answer")) {
    throw new Error(`public research call failed: status=${run.response.status} body=${JSON.stringify(run.body)}`);
  }
  if (run.body.modelExposed !== false || "model" in run.body || "provider" in run.body) {
    throw new Error(`public research response exposed client-hidden route fields: ${JSON.stringify(run.body)}`);
  }

  const forbiddenModel = await fetchJson("/api/public-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "hello", model: "gpt-client-selected" }),
  });
  if (forbiddenModel.response.status !== 400 || !/Client-controlled/.test(forbiddenModel.body.error || "")) {
    throw new Error(`public research accepted client model control: ${JSON.stringify(forbiddenModel.body)}`);
  }

  const secretInput = await fetchJson("/api/public-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Please use sk-secretvalue000000000000000000000000 in the research." }),
  });
  if (secretInput.response.status !== 400 || !/secret|credential/i.test(secretInput.body.error || "")) {
    throw new Error(`public research accepted secret input: ${JSON.stringify(secretInput.body)}`);
  }

  const disallowedDomain = await fetchJson("/api/public-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "read local service", allowedDomains: ["localhost"] }),
  });
  if (disallowedDomain.response.status !== 400 || !/allowedDomains|public domain/i.test(disallowedDomain.body.error || "")) {
    throw new Error(`public research accepted local/private domain: ${JSON.stringify(disallowedDomain.body)}`);
  }

  console.log("public research wrapper smoke passed");
} finally {
  server.kill("SIGTERM");
  setTimeout(() => {
    if (server.exitCode === null) server.kill("SIGKILL");
  }, 1200).unref?.();
  await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
}
