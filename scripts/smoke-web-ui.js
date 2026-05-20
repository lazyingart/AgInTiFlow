#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-web-ui-"));
const agintiflowHome = path.join(runtimeDir, ".agintiflow-home");
const port = 47000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "web", "--port", String(port), "--host", "127.0.0.1"], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    AGINTIFLOW_HOME: agintiflowHome,
    AGINTIFLOW_RUNTIME_DIR: runtimeDir,
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

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
      if (health.ok) return health;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`web server did not become healthy. stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
}

async function waitForRunState(page, status, timeout = 20000) {
  await page.waitForFunction(
    (expected) => document.querySelector("#run-state")?.dataset.status === expected,
    status,
    { timeout }
  );
}

async function waitForTerminalRunState(page, timeout = 30000) {
  await page.waitForFunction(
    () => ["finished", "failed", "stopped"].includes(document.querySelector("#run-state")?.dataset.status || ""),
    null,
    { timeout }
  );
  return page.locator("#run-state").evaluate((node) => node.dataset.status || "");
}

async function optionValues(page, selector) {
  return page.locator(selector).evaluate((node) => [...node.options].map((option) => option.value));
}

let browser;

try {
  await waitForHealth();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const runPayloads = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/runs") && request.method() === "POST") {
      runPayloads.push(request.postData() || "");
    }
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#chat-input");

  const initialSubmit = await page.locator("#chat-submit").innerText();
  if (!/start new run/i.test(initialSubmit)) throw new Error(`composer did not default to new-run mode: ${initialSubmit}`);
  if (await page.locator("#stop-run").isVisible()) throw new Error("stop button is visible before a run starts");

  await page.selectOption("#routingMode", "manual");
  await page.selectOption("#provider", "mock");
  await page.selectOption("#model", "mock-agent");
  await page.fill("#maxSteps", "4");
  await page.fill("#chat-input", "Say hello from the web UI composer in one concise sentence.");
  await page.click("#chat-submit");
  await waitForRunState(page, "running");
  if (!(await page.locator("#stop-run").isVisible())) throw new Error("stop button did not appear while run was active");
  await page.click("#stop-run");
  await waitForTerminalRunState(page);
  if (await page.locator("#stop-run").isVisible()) throw new Error("stop button stayed visible after terminal run state");
  if (!(await page.locator(".toast").first().isVisible().catch(() => false))) {
    throw new Error("running status toast did not render");
  }

  await page.click("#new-session");
  await waitForRunState(page, "idle");
  const resetSubmit = await page.locator("#chat-submit").innerText();
  if (!/start new run/i.test(resetSubmit)) throw new Error("new session did not reset composer to start mode");

  await page.click("#open-settings");
  await page.waitForSelector("#settings-modal[open]");
  const routeProviders = await optionValues(page, "#routeProvider");
  for (const provider of ["deepseek", "openai", "qwen", "venice", "mock"]) {
    if (!routeProviders.includes(provider)) throw new Error(`settings route provider dropdown is missing ${provider}`);
  }
  const wrapperOptions = await optionValues(page, "#preferredWrapper");
  for (const wrapper of ["codex", "claude", "gemini", "copilot", "qwen"]) {
    if (!wrapperOptions.includes(wrapper)) throw new Error(`preferred wrapper dropdown is missing ${wrapper}`);
  }
  await page.click("#done-settings");

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtimeDir,
        checks: [
          "composer-starts-new-run",
          "running-stop-button-visible",
          "running-status-toast",
          "terminal-stop-button-hidden",
          "new-session-resets-scope",
          "settings-provider-dropdowns",
          "settings-wrapper-dropdowns",
        ],
      },
      null,
      2
    )
  );
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await delay(150);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
