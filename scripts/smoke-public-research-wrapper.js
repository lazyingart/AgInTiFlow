#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicResearchWrapperStatus } from "../src/public-research-wrapper.js";
import { createPublicResearchHttpServer } from "../src/public-research-server.js";

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
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
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
if (!args.includes('web_search="live"')) failures.push("live web search not configured");
if (!args.includes('tools.web_search={allowed_domains=["nih.gov"]}')) failures.push("web search domain filter missing");
if (sandbox !== "read-only") failures.push("sandbox not read-only");
if (!workspace.includes("aginti-public-research-")) failures.push("workspace is not disposable");
if (process.cwd() !== workspace) failures.push("process cwd does not match disposable workspace");
if (!String(process.env.HOME || "").includes("aginti-public-research-")) failures.push("HOME is not disposable");
if (!String(process.env.CODEX_HOME || "").endsWith("server-codex-home")) failures.push("CODEX_HOME is not dedicated");
if (secretEnvKeys.length) failures.push("secret env leaked: " + secretEnvKeys.join(","));
if (args.at(-1) !== "-") failures.push("prompt is not read from stdin");
if (args.some((arg) => arg.includes("Allowed public domains:") || arg.includes("Research question:"))) failures.push("prompt leaked into argv");
if (!prompt.includes("Allowed public domains: nih.gov")) failures.push("allowed domain prompt missing");
if (!outputFile) failures.push("missing output file");

if (failures.length) {
  console.error(failures.join("; "));
  process.exit(47);
}

if (prompt.includes("fail diagnostics")) {
  console.error("PRIVATE_DIAGNOSTIC_MUST_NOT_REACH_CLIENT");
  process.exit(48);
}
if (prompt.includes("hold concurrency")) {
  await new Promise((resolve) => setTimeout(resolve, 600));
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
const answer = prompt.includes("outside citation")
  ? "Unsafe source https://example.com/not-allowed"
  : prompt.includes("missing citation")
    ? "Answer without a source URL."
    : "Fake public research answer from the server-owned route. Source: https://nih.gov/research/example\\n";
fs.writeFileSync(outputFile, answer);
`;
const fakeCodexPath = path.join(fakeBin, process.platform === "win32" ? "codex.cmd" : "codex");
await fs.writeFile(fakeCodexPath, fakeCodex, "utf8");
await fs.chmod(fakeCodexPath, 0o755);

const disabledStatus = getPublicResearchWrapperStatus({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` });
if (disabledStatus.available || disabledStatus.enabled || disabledStatus.modelExposed !== false) {
  throw new Error(`disabled status is not fail-closed: ${JSON.stringify(disabledStatus)}`);
}

const missingBoundaryStatus = getPublicResearchWrapperStatus({
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
  AGINTI_PUBLIC_RESEARCH_ENABLED: "1",
  AGINTI_PUBLIC_RESEARCH_CODEX_HOME: dedicatedCodexHome,
});
if (missingBoundaryStatus.available || !/boundary/i.test(missingBoundaryStatus.unavailableReason || "")) {
  throw new Error(`wrapper did not fail closed without strict boundary attestation: ${JSON.stringify(missingBoundaryStatus)}`);
}

let remoteBindingRejected = false;
try {
  createPublicResearchHttpServer({ host: "0.0.0.0", env: {} });
} catch (error) {
  remoteBindingRejected = /loopback|remote/i.test(error instanceof Error ? error.message : String(error));
}
if (!remoteBindingRejected) throw new Error("standalone server accepted unauthenticated remote binding");

const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-public-research.js"), "--port", String(port)], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
    AGINTIFLOW_HOME: agintiflowHome,
    AGINTI_PUBLIC_RESEARCH_ENABLED: "1",
    AGINTI_PUBLIC_RESEARCH_BOUNDARY: "external-strict",
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
  if (status.body.boundary?.mode !== "external-strict" || status.body.policy?.processPromptTransport !== "stdin") {
    throw new Error(`public research boundary status is incomplete: ${JSON.stringify(status.body)}`);
  }

  const ready = await fetchJson("/ready");
  if (!ready.response.ok || !ready.body.available) {
    throw new Error(`public research readiness failed: ${JSON.stringify(ready.body)}`);
  }

  const studioEndpoint = await fetchJson("/api/config");
  if (studioEndpoint.response.status !== 404) {
    throw new Error("standalone public research server exposed the AgInTiFlow Studio API");
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

  const disallowedCitation = await fetchJson("/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "outside citation", allowedDomains: ["nih.gov"] }),
  });
  if (disallowedCitation.response.status !== 502 || disallowedCitation.body.code !== "disallowed_citation") {
    throw new Error(`public research accepted a disallowed citation: ${JSON.stringify(disallowedCitation.body)}`);
  }

  const missingCitation = await fetchJson("/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "missing citation", allowedDomains: ["nih.gov"] }),
  });
  if (missingCitation.response.status !== 502 || missingCitation.body.code !== "missing_citation") {
    throw new Error(`public research accepted uncited output: ${JSON.stringify(missingCitation.body)}`);
  }

  const diagnosticFailure = await fetchJson("/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "fail diagnostics", allowedDomains: ["nih.gov"] }),
  });
  if (
    diagnosticFailure.response.status !== 502 ||
    JSON.stringify(diagnosticFailure.body).includes("PRIVATE_DIAGNOSTIC")
  ) {
    throw new Error(`public research leaked process diagnostics: ${JSON.stringify(diagnosticFailure.body)}`);
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

  const slow = fetchJson("/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "hold concurrency", allowedDomains: ["nih.gov"] }),
  });
  await delay(100);
  const concurrent = await fetchJson("/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "second request", allowedDomains: ["nih.gov"] }),
  });
  if (concurrent.response.status !== 429 || !concurrent.body.blocked) {
    throw new Error(`public research concurrency limit was not enforced: ${JSON.stringify(concurrent.body)}`);
  }
  const slowResult = await slow;
  if (!slowResult.response.ok || !slowResult.body.ok) {
    throw new Error(`slow public research request failed: ${JSON.stringify(slowResult.body)}`);
  }

  console.log("public research wrapper and standalone server smoke passed");
} finally {
  server.kill("SIGTERM");
  setTimeout(() => {
    if (server.exitCode === null) server.kill("SIGKILL");
  }, 1200).unref?.();
  await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
}
