#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "website", "assets", "screenshots");
const appUrl = process.env.AGINTIFLOW_APP_URL || "http://127.0.0.1:3210/";

async function waitForApp() {
  const healthUrl = new URL("/health", appUrl).toString();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      const body = await response.json();
      if (body.ok) return;
    } catch {
      // Keep polling until the existing tmux app is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`AgInTiFlow app is not reachable at ${healthUrl}`);
}

async function clickIfChecked(page, selector, shouldBeChecked) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "attached", timeout: 5000 });
  await locator.evaluate((element, expected) => {
    if (element.checked === expected) return;
    element.checked = expected;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, shouldBeChecked);
}

async function selectIfOptionExists(page, selector, value) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "attached", timeout: 5000 });
  const hasOption = await locator.locator(`option[value="${value}"]`).count();
  if (hasOption) await page.selectOption(selector, value);
}

async function setFieldValue(page, selector, value) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "attached", timeout: 5000 });
  await locator.evaluate((element, nextValue) => {
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function screenshot(locator, name, options = {}) {
  await locator.screenshot({
    path: path.join(outputDir, name),
    type: "jpeg",
    quality: options.quality || 84,
  });
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await waitForApp();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });

  try {
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.selectOption("#language", "en");
    await page.selectOption("#routingMode", "manual");
    await page.selectOption("#provider", "mock");
    await selectIfOptionExists(page, "#model", "mock-agent");
    await page.selectOption("#sandboxMode", "host");
    await page.selectOption("#packageInstallPolicy", "block");
    await clickIfChecked(page, "#headless", true);
    await clickIfChecked(page, "#allowShellTool", true);
    await clickIfChecked(page, "#allowWrapperTools", true);
    await setFieldValue(page, "#startUrl", "");
    await setFieldValue(page, "#allowedDomains", "github.com,news.ycombinator.com");
    await page.fill("#commandCwd", repoRoot);
    await page.fill("#goal", "Report the current working directory using a safe command.");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("#logs")?.textContent.includes("Mock run complete."), {
      timeout: 20000,
    });

    await screenshot(page.locator("main.page"), "app-overview.jpg", { quality: 82 });
    await screenshot(page.locator(".form-panel"), "task-controls.jpg");
    await screenshot(page.locator(".sandbox-card"), "sandbox-status.jpg");
    await screenshot(page.locator(".output-panel"), "run-output.jpg");
    await screenshot(page.locator(".chat-panel"), "conversation-history.jpg");

    await page.setViewportSize({ width: 390, height: 920 });
    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.selectOption("#language", "en");
    await screenshot(page.locator("main.page"), "mobile-overview.jpg", { quality: 82 });
  } finally {
    await browser.close();
  }

  const files = await fs.readdir(outputDir);
  console.log(`Captured ${files.filter((file) => file.endsWith(".jpg")).length} screenshots in ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
