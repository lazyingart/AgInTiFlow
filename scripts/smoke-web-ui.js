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
  if ((await page.locator("#goal").count()) !== 0) throw new Error("old standalone goal textarea is still rendered");
  if (!(await page.locator("#commandCwd").isVisible())) throw new Error("working directory search field is not visible at the top level");
  if (await page.locator("#run-defaults-card").evaluate((node) => node.open)) throw new Error("run defaults should start folded");
  await page.locator("#commandCwd").fill(runtimeDir.slice(0, Math.max(runtimeDir.lastIndexOf("/"), 1)));
  await page.waitForFunction(() => document.querySelectorAll("#command-cwd-suggestions option").length > 0);
  await page.locator("#commandCwd").fill(runtimeDir);
  if ((await page.locator(".project-status-chip").count()) < 4) throw new Error("project folder status did not render structured chips");
  await page.locator("#run-defaults-card summary").click();
  if (await page.locator("#veniceModeToggle").isChecked()) throw new Error("Venice quick mode should default off");
  if ((await page.locator("#routeProvider").inputValue()) !== "deepseek") throw new Error("route provider should default to DeepSeek");
  if ((await page.locator("#mainProvider").inputValue()) !== "deepseek") throw new Error("main provider should default to DeepSeek");

  await page.selectOption("#enableScs", "auto");
  await page.locator("label:has(#aapsModeToggle)").click();
  if ((await page.locator("#taskProfile").inputValue()) !== "aaps") throw new Error("AAPS toggle did not select the AAPS task profile");
  await page.locator("label:has(#veniceModeToggle)").click();
  if ((await page.locator("#provider").inputValue()) !== "venice") throw new Error("Venice toggle did not set primary provider");
  if (!/^venice|^e2ee|^gemma|^qwen|^openai|^claude/.test(await page.locator("#model").inputValue())) {
    throw new Error(`Venice toggle did not update primary model: ${await page.locator("#model").inputValue()}`);
  }
  if ((await page.locator("#routeProvider").inputValue()) !== "venice") throw new Error("Venice toggle did not set route provider");
  if ((await page.locator("#mainProvider").inputValue()) !== "venice") throw new Error("Venice toggle did not set main provider");
  if (!/^venice|^e2ee|^gemma|^qwen|^openai|^claude/.test(await page.locator("#routeModel").inputValue())) {
    throw new Error(`Venice toggle did not update route model: ${await page.locator("#routeModel").inputValue()}`);
  }
  if (!/^venice|^e2ee|^gemma|^qwen|^openai|^claude/.test(await page.locator("#mainModel").inputValue())) {
    throw new Error(`Venice toggle did not update main model: ${await page.locator("#mainModel").inputValue()}`);
  }
  const quickStatus = await page.locator("#quick-mode-status").innerText();
  if (!/scs=auto/.test(quickStatus) || !/profile=aaps/.test(quickStatus) || !/route venice\//.test(quickStatus)) {
    throw new Error(`quick mode status did not reflect CLI modes: ${quickStatus}`);
  }
  await page.locator("label:has(#veniceModeToggle)").click();
  if (await page.locator("#veniceModeToggle").isChecked()) throw new Error("Venice quick mode did not turn off");
  if ((await page.locator("#provider").inputValue()) !== "deepseek") throw new Error("Venice off did not restore primary provider");
  if ((await page.locator("#model").inputValue()) !== "deepseek-v4-flash") throw new Error("Venice off did not restore primary model");
  if ((await page.locator("#routeProvider").inputValue()) !== "deepseek") throw new Error("Venice off did not restore route provider");
  if ((await page.locator("#routeModel").inputValue()) !== "deepseek-v4-flash") throw new Error("Venice off did not restore route model");
  if ((await page.locator("#mainProvider").inputValue()) !== "deepseek") throw new Error("Venice off did not restore main provider");
  if ((await page.locator("#mainModel").inputValue()) !== "deepseek-v4-pro") throw new Error("Venice off did not restore main model");
  const quickBoxes = await Promise.all([
    page.locator(".quick-mode-select").boundingBox(),
    page.locator("label:has(#aapsModeToggle)").boundingBox(),
    page.locator("label:has(#veniceModeToggle)").boundingBox(),
  ]);
  if (quickBoxes.some((box) => !box)) throw new Error("quick mode controls did not render measurable boxes");
  const centers = quickBoxes.map((box) => box.y + box.height / 2);
  if (Math.max(...centers) - Math.min(...centers) > 2) {
    throw new Error(`quick mode controls are not vertically aligned: ${JSON.stringify(quickBoxes)}`);
  }
  if (quickBoxes.some((box) => box.height < 48 || box.height > 52) || quickBoxes.some((box) => box.width > 128)) {
    throw new Error(`quick mode controls are not compact button-sized elements: ${JSON.stringify(quickBoxes)}`);
  }

  await page.selectOption("#routingMode", "manual");
  await page.selectOption("#provider", "mock");
  await page.selectOption("#model", "mock-agent");
  await page.fill("#maxSteps", "4");
  await page.selectOption("#dynamicSteps", "off");
  await page.fill("#chat-input", "Say hello from the web UI composer in one concise sentence.");
  await page.click("#chat-submit");
  const firstPayload = JSON.parse(runPayloads.at(-1) || "{}");
  if (firstPayload.goal !== "Say hello from the web UI composer in one concise sentence.") {
    throw new Error("composer text was not used as the first run goal");
  }
  if (firstPayload.enableScs !== "auto" || firstPayload.taskProfile !== "aaps") {
    throw new Error(`CLI mode payload mismatch: ${runPayloads.at(-1) || ""}`);
  }
  if (firstPayload.dynamicSteps !== "off") {
    throw new Error(`dynamic steps payload mismatch: ${runPayloads.at(-1) || ""}`);
  }
  if (firstPayload.veniceMode !== false || firstPayload.routeProvider !== "deepseek" || firstPayload.mainProvider !== "deepseek") {
    throw new Error(`default route/main payload mismatch after Venice off: ${runPayloads.at(-1) || ""}`);
  }
  await waitForRunState(page, "running");
  await page.waitForSelector(".event-plan", { timeout: 12000 });
  if (!(await page.locator(".event-plan .markdown-body").first().innerText()).trim()) {
    throw new Error("web run log did not render the plan as a formatted event card");
  }
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
  if (await page.locator("#aapsModeToggle").isChecked()) await page.locator("label:has(#aapsModeToggle)").click();
  await page.selectOption("#taskProfile", "code");
  await page.selectOption("#enableScs", "off");
  await page.fill("#chat-input", "Create notes/web-ui-format.md with a short formatted event smoke message.");
  await page.click("#chat-submit");
  await waitForTerminalRunState(page);
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".event-write .change-diff")].some((node) =>
          (node.textContent || "").includes("+Created by AgInTiFlow mock mode.")
        ),
      null,
      { timeout: 30000 }
    );
  } catch (error) {
    const state = await page.locator("#run-state").evaluate((node) => node.dataset.status || "").catch(() => "unknown");
    const logsTail = (await page.locator("#logs").innerText().catch(() => "")).slice(-1200);
    const chatTail = (await page.locator("#chat-thread").innerText().catch(() => "")).slice(-1200);
    throw new Error(`web UI did not render formatted file-change diff event; state=${state}\nlogs tail:\n${logsTail}\nchat tail:\n${chatTail}`);
  }

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
          "old-goal-form-hidden",
          "working-directory-search-top",
          "project-status-chips",
          "run-defaults-folded",
          "venice-mode-default-off",
          "venice-mode-model-sync",
          "venice-mode-off-restores-deepseek",
          "quick-scs-aaps-venice-controls",
          "quick-mode-control-alignment",
          "dynamic-steps-dropdown",
          "composer-goal-payload",
          "running-stop-button-visible",
          "running-status-toast",
          "terminal-stop-button-hidden",
          "new-session-resets-scope",
          "formatted-plan-event-card",
          "formatted-file-diff-event-card",
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
