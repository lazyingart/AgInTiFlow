import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { parseArgs, parseResumeCommandArgs, buildResumeRuntimePatch } from "../src/cli.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { captureSessionRuntime, applySessionRuntimePatch, sessionRuntimeOverrides } from "../src/session-runtime.js";
import { evaluateCommandPolicy } from "../src/command-policy.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-fallback-policy-"));
const previousHome = process.env.AGINTIFLOW_HOME;
process.env.AGINTIFLOW_HOME = path.join(root, "account");
after(() => {
  if (previousHome === undefined) delete process.env.AGINTIFLOW_HOME;
  else process.env.AGINTIFLOW_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function config(args = {}, overrides = {}) {
  return resolveRuntimeConfig({
    provider: "deepseek", routingMode: "smart",
    goal: "Fix the failing tests and verify the implementation", ...args,
  }, {
    baseDir: root, commandCwd: root, sandboxMode: "host", enableScs: "on",
    routeProvider: "deepseek", routeModel: "deepseek-v4-flash",
    mainProvider: "deepseek", mainModel: "deepseek-v4-pro",
    spareProvider: "deepseek", spareModel: "deepseek-v4-pro", ...overrides,
  });
}

test("fast routing keeps the fast executor while retaining completion validation", () => {
  const result = config({ routingMode: "fast" });
  assert.equal(result.model, "deepseek-v4-flash");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.scsActive, true);
  assert.equal(result.allowDestructive, false);
  assert.equal(result.allowOutsideWorkspaceFileTools, false);
});

test("manual model is not silently replaced by an SCS main role", () => {
  const result = config({ routingMode: "manual", model: "chosen-deepseek-model" }, {
    mainProvider: "openai", mainModel: "separately-configured-reviewer",
  });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.model, "chosen-deepseek-model");
  assert.equal(result.scsActive, true);
});

test("smart routing retains its complex-task main model", () => {
  const result = config();
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.scsActive, true);
});

test("wrapper opt-out overrides ambient configuration and survives resume", () => {
  const previous = process.env.ALLOW_WRAPPER_TOOLS;
  process.env.ALLOW_WRAPPER_TOOLS = "true";
  try {
    const args = parseArgs(["--no-wrappers"]);
    assert.deepEqual(args.unknownOptions, []);
    assert.equal(config(args).allowWrapperTools, false);
    const original = captureSessionRuntime(config({ allowWrapperTools: true }), { revision: 1 });
    for (const argv of [["--no-wrappers", "saved-session"], ["saved-session", "--no-wrappers"]]) {
      const resumed = parseResumeCommandArgs(argv);
      assert.deepEqual(resumed.unknownOptions, []);
      assert.equal(resumed.prompt, "");
      const patch = buildResumeRuntimePatch(resumed.optionArgv);
      assert.deepEqual(patch, { allowWrapperTools: false });
      const updated = applySessionRuntimePatch(original, patch, 1);
      assert.equal(sessionRuntimeOverrides(updated).allowWrapperTools, false);
      assert.equal(sessionRuntimeOverrides(original).allowWrapperTools, true);
    }
    assert.equal(parseArgs(["--no-wrappers", "--allow-wrappers"]).allowWrapperTools, true);
    assert.equal(parseArgs(["--allow-wrappers", "--no-wrappers"]).allowWrapperTools, false);
    assert.equal(parseArgs(["--", "--no-wrappers"]).goal, "--no-wrappers");
    assert.deepEqual(buildResumeRuntimePatch([]), {});
  } finally {
    if (previous === undefined) delete process.env.ALLOW_WRAPPER_TOOLS;
    else process.env.ALLOW_WRAPPER_TOOLS = previous;
  }
});

test("unbounded inspection is recoverable without granting broader shell permission", () => {
  const policy = { commandCwd: root, allowShellTool: true, sandboxMode: "host", packageInstallPolicy: "block" };
  for (const command of [
    "find . -name '__pycache__' -o -name '*.pyc'",
    "find . -name '__pycache__' -o -name '*.pyc' 2>/dev/null | head",
    'git status --short; find . -name "*.pyc" 2>/dev/null | head; echo "EXIT:$?"',
    "grep -r TODO . | head",
    "npm test && find . -name '*.pyc'",
  ]) {
    const result = evaluateCommandPolicy(command, policy);
    assert.equal(result.allowed, false, command);
    assert.equal(result.category, "unbounded-discovery", command);
    assert.equal(result.recoverable, true, command);
    assert.equal(result.needsApproval, false, command);
  }
  assert.equal(evaluateCommandPolicy("find . -maxdepth 8 -name '*.pyc' | head", policy).allowed, true);
  for (const command of [
    "find . -name '*.pyc' -delete", "find . -exec sh -c 'touch marker' \\;",
    "find . -fprintf marker '%p'", "find . -fprint marker", "find . -name '*.pyc' > marker",
    "find . -name '*.pyc'; rm -rf output", "find . -name '*.pyc' | sh",
  ]) {
    const result = evaluateCommandPolicy(command, policy);
    assert.equal(result.allowed, false, command);
    assert.notEqual(result.category, "unbounded-discovery", command);
  }
});
