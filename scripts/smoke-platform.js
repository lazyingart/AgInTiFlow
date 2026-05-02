#!/usr/bin/env node
import assert from "node:assert/strict";
import { platformInfo, platformLabel, platformSetupHints, hostShellOption } from "../src/platform.js";
import { buildCapabilityReport } from "../src/capabilities.js";
import { resolveRuntimeConfig } from "../src/config.js";

const info = platformInfo();
const label = platformLabel(info);
const hints = platformSetupHints(info);

assert(["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"].includes(info.platform), "unknown platform shape");
assert(label.includes(info.arch), "platform label should include architecture");
assert(hints.length > 0, "platform hints should not be empty");
assert(hostShellOption(), "host shell option should be defined");

if (info.isMac) {
  assert(hints.some((hint) => /Docker Desktop|Colima/i.test(hint)), "macOS hints should mention Docker Desktop or Colima");
  assert(hints.some((hint) => /MacTeX|BasicTeX/i.test(hint)), "macOS hints should mention MacTeX or BasicTeX");
}
if (info.isWindows) {
  assert(hints.some((hint) => /WSL/i.test(hint)), "Windows hints should recommend WSL");
}
if (info.isWsl) {
  assert(label.includes("WSL"), "WSL platform label should mention WSL");
}

const config = resolveRuntimeConfig({ goal: "platform smoke", provider: "mock" }, { useDockerSandbox: false });
const report = await buildCapabilityReport(process.cwd(), "0.0.0-smoke", config);
assert.equal(report.platform.platform, info.platform, "capability report should include platform");
assert(Array.isArray(report.platform.setupHints), "capability report should include setup hints");
assert(typeof report.platform.hostLatexAvailable === "boolean", "capability report should include host LaTeX status");

console.log(
  JSON.stringify(
    {
      ok: true,
      platform: report.platform.label,
      linuxFamily: report.platform.linuxFamily,
      hostLatexAvailable: report.platform.hostLatexAvailable,
      hints: report.platform.setupHints.length,
    },
    null,
    2
  )
);
