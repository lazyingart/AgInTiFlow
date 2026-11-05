import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
test("published browser dependency selects the qualified Playwright/core pair", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const selected = manifest.dependencies.playwright;
  // A package-lock does not constrain a consumer's global npm resolution.
  // Keep the browser ABI/runtime pair explicit in the published manifest.
  assert.match(selected, /^\d+\.\d+\.\d+$/);
  const playwrightPath = require.resolve("playwright/package.json");
  const playwright = JSON.parse(fs.readFileSync(playwrightPath, "utf8"));
  const fromPlaywright = createRequire(playwrightPath);
  const core = JSON.parse(fs.readFileSync(fromPlaywright.resolve("playwright-core/package.json"), "utf8"));
  assert.equal(playwright.version, selected);
  assert.equal(playwright.dependencies["playwright-core"], selected);
  assert.equal(core.version, selected);
});
