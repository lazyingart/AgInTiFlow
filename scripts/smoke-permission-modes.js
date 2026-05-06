#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli.js";
import { evaluateCommandPolicy } from "../src/command-policy.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  applyPermissionMode,
  normalizePermissionMode,
  permissionModeDefaults,
  permissionModeForApprovalCategory,
} from "../src/permission-modes.js";
import { checkWorkspaceToolUse, executeWorkspaceTool } from "../src/workspace-tools.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-permission-modes-"));
const workspace = path.join(tempRoot, "workspace");
const runtimeDir = path.join(tempRoot, "runtime");
await fs.mkdir(workspace, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configFor(mode, extra = {}) {
  return resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "permission smoke",
      commandCwd: workspace,
      permissionMode: mode,
      maxSteps: 2,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      commandCwd: workspace,
      ...extra,
    }
  );
}

async function main() {
  assert(normalizePermissionMode("default") === "normal", "default should normalize to normal");
  assert(permissionModeDefaults("safe").workspaceWritePolicy === "prompt", "safe should prompt before writes");
  assert(permissionModeDefaults("normal").sandboxMode === "docker-workspace", "normal should use docker workspace");
  assert(permissionModeDefaults("danger").allowPasswords === true, "danger should allow password typing");
  assert(permissionModeForApprovalCategory("workspace-write") === "normal", "workspace write approval should escalate to normal");
  assert(permissionModeForApprovalCategory("workspace-path") === "danger", "outside path approval should escalate to danger");

  const parsedSafe = parseArgs(["-s", "safe", "--provider", "mock", "hello"]);
  assert(parsedSafe.permissionMode === "safe", "CLI -s safe should set permission mode");
  assert(parsedSafe.sandboxMode === "docker-readonly", "CLI -s safe should set docker-readonly");
  assert(parsedSafe.workspaceWritePolicy === "prompt", "CLI -s safe should set write prompt");

  const parsedDanger = parseArgs(["--permission-mode", "danger", "--provider", "mock", "hello"]);
  assert(parsedDanger.permissionMode === "danger", "CLI --permission-mode danger should set permission mode");
  assert(parsedDanger.sandboxMode === "host", "danger should set host sandbox");
  assert(parsedDanger.allowDestructive === true, "danger should allow destructive shell");
  assert(parsedDanger.allowOutsideWorkspaceFileTools === true, "danger should allow outside workspace file tools");

  const safe = configFor("safe");
  assert(safe.permissionMode === "safe", "runtime safe mode not set");
  assert(safe.workspaceWritePolicy === "prompt", "runtime safe write policy not prompt");
  const safeWriteGuard = checkWorkspaceToolUse("write_file", { path: "notes/safe.md", content: "x" }, safe);
  assert(safeWriteGuard.allowed === false, "safe write should be blocked for approval");
  assert(safeWriteGuard.category === "workspace-write", "safe write should use workspace-write category");
  assert(safeWriteGuard.needsApproval === true, "safe write should need approval");
  const safeInstall = evaluateCommandPolicy("npm install left-pad", safe);
  assert(safeInstall.allowed === false, "safe package install should be blocked");
  assert(safeInstall.needsApproval === true, "safe package install should ask approval");

  const normal = configFor("normal");
  const normalWrite = await executeWorkspaceTool(
    "write_file",
    { path: "notes/normal.md", content: "normal ok" },
    normal
  );
  assert(normalWrite.ok === true, "normal should write inside workspace");
  const normalInstall = evaluateCommandPolicy("npm install left-pad", normal);
  assert(normalInstall.allowed === true, "normal should allow package setup in docker workspace");
  const normalOutside = checkWorkspaceToolUse("write_file", { path: path.join(tempRoot, "outside-normal.txt"), content: "x" }, normal);
  assert(normalOutside.allowed === false, "normal should block outside workspace file writes");
  assert(normalOutside.category === "workspace-path", "normal outside write should use workspace-path category");

  const danger = configFor("danger");
  assert(danger.sandboxMode === "host", "danger runtime should use host mode");
  assert(danger.packageInstallPolicy === "allow", "danger runtime should allow package installs");
  assert(danger.allowDestructive === true, "danger runtime should allow destructive commands");
  assert(danger.allowPasswords === true, "danger runtime should allow password typing");
  const dangerSudo = evaluateCommandPolicy("sudo apt-get install -y cowsay", danger);
  assert(dangerSudo.allowed === true, "danger should allow trusted host sudo installs");
  const dangerDestructive = evaluateCommandPolicy("rm -rf build", danger);
  assert(dangerDestructive.allowed === true, "danger should allow destructive commands");
  const dangerAbsoluteMkdir = evaluateCommandPolicy(`mkdir -p ${path.join(tempRoot, "danger-host-dir")}`, danger);
  assert(dangerAbsoluteMkdir.allowed === true, "danger should allow broad absolute host paths");
  assert(dangerAbsoluteMkdir.trustedDangerOverride === true, "danger absolute host path should be explicit override");
  const dangerPublish = evaluateCommandPolicy("npm publish", danger);
  assert(dangerPublish.allowed === false, "danger should still block hard publish/token guardrails");
  const outsidePath = path.join(tempRoot, "outside-danger.txt");
  const dangerOutside = await executeWorkspaceTool("write_file", { path: outsidePath, content: "danger outside ok" }, danger);
  assert(dangerOutside.ok === true, "danger should allow outside workspace file write");
  assert((await fs.readFile(outsidePath, "utf8")) === "danger outside ok", "outside file content mismatch");

  const applied = applyPermissionMode({}, "normal", { override: true });
  assert(applied.sandboxMode === "docker-workspace", "applyPermissionMode should set normal defaults");

  console.log("permission modes smoke ok");
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
