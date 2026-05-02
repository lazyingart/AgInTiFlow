#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAuthProvider } from "../src/auth-onboarding.js";
import { getProviderDefaults } from "../src/model-routing.js";
import { providerKeyStatus, setProviderKey } from "../src/project.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auth-"));

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
  assert(normalizeAuthProvider("auxilliary") === "grsai", "auxilliary alias did not normalize to grsai");
  assert(normalizeAuthProvider("qwen") === "qwen", "qwen provider did not normalize");
  const qwenDefaults = getProviderDefaults("qwen");
  assert(qwenDefaults.provider === "qwen" && qwenDefaults.model, "qwen provider defaults are not available");

  await setProviderKey(tempRoot, "qwen", "test-qwen-key");
  let status = providerKeyStatus(tempRoot);
  assert(status.qwen, "qwen key status was not detected");
  assert(status.envVars.qwen.includes("QWEN_API_KEY"), "qwen env var name was not reported");

  await runCli(["keys", "set", "openai", "--stdin"], "test-openai-key");
  await runCli(["keys", "set", "grsai", "--stdin"], "test-grsai-key");
  status = providerKeyStatus(tempRoot);
  assert(status.openai && status.grsai && status.qwen, "stored auth keys were not detected");

  const keysOutput = await runCli(["keys", "status"]);
  assert(keysOutput.includes("qwen=available"), "keys status did not include qwen");
  assert(!keysOutput.includes("test-openai-key") && !keysOutput.includes("test-qwen-key"), "keys status leaked a raw key");

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: ["normalize-auth-provider", "qwen-defaults", "qwen-key-status", "cli-key-status-redacted"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
