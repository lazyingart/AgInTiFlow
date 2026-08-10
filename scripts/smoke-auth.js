#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authProviderKeyHelp, authProviderKeyUrl, normalizeAuthProvider } from "../src/auth-onboarding.js";
import { getProviderDefaults } from "../src/model-routing.js";
import { maskProviderKey, providerKeyPreview, providerKeyStatus, setProviderKey } from "../src/project.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auth-"));
const envKeys = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "QWEN_API_KEY",
  "VENICE_API_KEY",
  "GRSAI",
  "GRSAI_API_KEY",
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalAgintiflowHome = process.env.AGINTIFLOW_HOME;
for (const key of envKeys) delete process.env[key];
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCli(args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
      cwd: tempRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AGINTIFLOW_RUNTIME_DIR: "",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("auth smoke command timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`auth smoke command failed ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(stdin);
  });
}

try {
  assert(normalizeAuthProvider("auxiliary") === "grsai", "auxiliary alias did not normalize to grsai");
  assert(normalizeAuthProvider("or") === "openrouter", "OpenRouter alias did not normalize");
  assert(normalizeAuthProvider("open-router") === "openrouter", "open-router alias did not normalize");
  assert(normalizeAuthProvider("qwen") === "qwen", "qwen provider did not normalize");
  assert(normalizeAuthProvider("venice") === "venice", "venice provider did not normalize");
  assert(authProviderKeyUrl("deepseek") === "https://platform.deepseek.com/api_keys", "DeepSeek key URL is missing");
  assert(authProviderKeyUrl("openrouter") === "https://openrouter.ai/settings/keys", "OpenRouter key URL is missing");
  assert(authProviderKeyHelp("openai").includes("https://platform.openai.com/api-keys"), "OpenAI key help is missing");
  assert(maskProviderKey("short") === "s…t (5 chars)", "short key mask was not compact");
  assert(maskProviderKey("test-openai-key") === "test…-key (15 chars)", "long key mask did not preserve prefix/suffix");
  const qwenDefaults = getProviderDefaults("qwen");
  assert(qwenDefaults.provider === "qwen" && qwenDefaults.model, "qwen provider defaults are not available");
  const openrouterDefaults = getProviderDefaults("openrouter");
  assert(
    openrouterDefaults.provider === "openrouter" &&
      openrouterDefaults.baseURL === "https://openrouter.ai/api/v1" &&
      openrouterDefaults.model === "openrouter/auto",
    "openrouter provider defaults are not available"
  );
  const veniceDefaults = getProviderDefaults("venice");
  assert(veniceDefaults.provider === "venice" && veniceDefaults.model === "venice-uncensored-1-2", "venice provider defaults are not available");

  const projectOnlyRoot = path.join(tempRoot, "project-only");
  await fs.mkdir(path.join(projectOnlyRoot, ".aginti"), { recursive: true });
  await fs.writeFile(path.join(projectOnlyRoot, ".aginti", ".env"), 'OPENAI_API_KEY="project-only-openai-key"\n', "utf8");
  let projectOnlyStatus = providerKeyStatus(projectOnlyRoot);
  assert(projectOnlyStatus.openai && projectOnlyStatus.projectEnv, "project-only key was not loaded");
  await fs.access(path.join(tempRoot, ".agintiflow-home", ".env"))
    .then(() => {
      throw new Error("project-only key was incorrectly promoted into account-wide env");
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  delete process.env.OPENAI_API_KEY;

  process.env.DEEPSEEK_API_KEY = "ambient-deepseek-key";
  process.env.OPENROUTER_API_KEY = "ambient-openrouter-key";
  process.env.VENICE_API_KEY = "ambient-venice-key";
  process.env.GRSAI_API_KEY = "ambient-grsai-key";
  let status = providerKeyStatus(tempRoot);
  assert(status.deepseek && status.openrouter && status.venice && status.grsai, "ambient provider keys were not detected");
  assert(!status.globalEnv && !status.ambientPersisted, "ambient provider keys were silently persisted account-wide");
  await fs.access(path.join(tempRoot, ".agintiflow-home", ".env"))
    .then(() => {
      throw new Error("ambient provider keys created an account-wide credential file");
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.VENICE_API_KEY;
  delete process.env.GRSAI_API_KEY;
  status = providerKeyStatus(tempRoot);
  assert(!status.deepseek && !status.openrouter && !status.venice && !status.grsai, "ambient keys survived after their process environment was cleared");

  await setProviderKey(tempRoot, "qwen", "test-qwen-key");
  await setProviderKey(tempRoot, "openrouter", "test-openrouter-key");
  await setProviderKey(tempRoot, "venice", "test-venice-key");
  status = providerKeyStatus(tempRoot);
  assert(status.qwen, "qwen key status was not detected");
  assert(status.openrouter, "openrouter key status was not detected");
  assert(status.venice, "venice key status was not detected");
  assert(status.envVars.qwen.includes("QWEN_API_KEY"), "qwen env var name was not reported");
  assert(status.envVars.openrouter.includes("OPENROUTER_API_KEY"), "openrouter env var name was not reported");
  assert(status.envVars.venice.includes("VENICE_API_KEY"), "venice env var name was not reported");
  const qwenPreview = providerKeyPreview(tempRoot, "qwen");
  assert(qwenPreview.available && qwenPreview.preview === "test…-key (13 chars)", "qwen key preview was not masked correctly");
  const openrouterPreview = providerKeyPreview(tempRoot, "openrouter");
  assert(
    openrouterPreview.available && openrouterPreview.preview === "test…-key (19 chars)",
    "openrouter key preview was not masked correctly"
  );
  const venicePreview = providerKeyPreview(tempRoot, "venice");
  assert(venicePreview.available && venicePreview.preview === "test…-key (15 chars)", "venice key preview was not masked correctly");

  await runCli(["keys", "set", "openai", "--stdin"], "test-openai-key");
  await runCli(["keys", "set", "grsai", "--stdin"], "test-grsai-key");
  await runCli(["keys", "set", "--project", "deepseek", "--stdin"], "project-deepseek-key");
  status = providerKeyStatus(tempRoot);
  assert(status.openai && status.openrouter && status.grsai && status.qwen && status.venice && status.deepseek, "stored auth keys were not detected");
  assert(status.projectEnv, "project-scoped key was not recorded as project env");
  const projectEnv = await fs.readFile(path.join(tempRoot, ".aginti", ".env"), "utf8");
  assert(projectEnv.includes("DEEPSEEK_API_KEY="), "project-scoped DeepSeek key was not saved in .aginti/.env");
  const openaiPreview = providerKeyPreview(tempRoot, "openai");
  assert(openaiPreview.preview === "test…-key (15 chars)", "openai key preview was not masked correctly");
  assert(openaiPreview.preview !== "test-openai-key", "openai key preview leaked raw key");

  const keysOutput = await runCli(["keys", "status"]);
  assert(keysOutput.includes("openrouter=available"), "keys status did not include openrouter");
  assert(keysOutput.includes("qwen=available"), "keys status did not include qwen");
  assert(keysOutput.includes("venice=available"), "keys status did not include venice");
  assert(keysOutput.includes("globalEnv=yes"), "keys status did not show global env");
  assert(keysOutput.includes("projectEnv=yes"), "keys status did not show project env");
  assert(
    !keysOutput.includes("test-openai-key") &&
      !keysOutput.includes("test-openrouter-key") &&
      !keysOutput.includes("test-qwen-key") &&
      !keysOutput.includes("test-venice-key"),
    "keys status leaked a raw key"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: [
          "normalize-auth-provider",
          "provider-key-links",
          "provider-key-mask",
          "provider-key-preview",
          "qwen-defaults",
          "openrouter-defaults",
          "venice-defaults",
          "project-key-not-auto-promoted",
          "ambient-key-discovery-is-read-only",
          "project-key-override",
          "qwen-key-status",
          "openrouter-key-status",
          "venice-key-status",
          "cli-key-status-redacted",
        ],
      },
      null,
      2
    )
  );
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  if (originalAgintiflowHome === undefined) delete process.env.AGINTIFLOW_HOME;
  else process.env.AGINTIFLOW_HOME = originalAgintiflowHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
