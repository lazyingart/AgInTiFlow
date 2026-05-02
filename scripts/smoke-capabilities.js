#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-capabilities-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
    cwd: tempRoot,
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      AGINTIFLOW_RUNTIME_DIR: "",
    },
  });
  return result.stdout;
}

try {
  await runCli(["init"]);
  const agintiMd = await fs.readFile(path.join(tempRoot, "AGINTI.md"), "utf8");
  assert(agintiMd.includes("Project instructions for AgInTiFlow agents."), "init did not create AGINTI.md");
  const capabilities = JSON.parse(await runCli(["capabilities", "--json"]));
  assert(capabilities.project.root === tempRoot, "capabilities did not use cwd as project root");
  assert(capabilities.project.commandCwd === tempRoot, "capabilities did not default commandCwd to project root");
  assert(capabilities.project.instructionsPresent, "capabilities did not report AGINTI.md");
  assert(capabilities.project.sharedSessionFolder, "capabilities did not report shared session folder");
  assert(capabilities.platform?.platform, "capabilities did not report platform");
  assert(Array.isArray(capabilities.platform?.setupHints), "capabilities did not report platform setup hints");
  assert(capabilities.keys?.mock === true, "capabilities did not report mock availability");
  assert(typeof capabilities.keys?.qwen === "boolean", "capabilities did not report qwen key status");
  assert(typeof capabilities.keys?.venice === "boolean", "capabilities did not report venice key status");
  assert(
    capabilities.checks.some((check) => check.name === "npm-prefix-test-policy" && check.ok),
    "npm --prefix test policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "cd-npm-test-policy" && check.ok),
    "cd <dir> && npm test policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "mkdir-policy" && check.ok),
    "safe mkdir -p policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "bash-syntax-policy" && check.ok),
    "bash -n maintenance script policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "tmux"),
    "capabilities did not report tmux availability"
  );
  assert(
    capabilities.checks.some((check) => check.name === "git-status-policy" && check.ok),
    "git status policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "git-commit-policy" && check.ok),
    "git commit policy is not allowed"
  );
  assert(
    capabilities.checks.some((check) => check.name === "git-pull-ff-only-policy" && check.ok),
    "unsafe git pull policy was not blocked"
  );
  assert(
    capabilities.maintenancePolicy.some((check) => check.command.startsWith("sudo") && !check.allowed),
    "sudo maintenance command was not blocked"
  );
  assert(
    capabilities.maintenancePolicy.some((check) => check.command.startsWith("apt-get install") && !check.allowed),
    "host OS package install was not blocked"
  );
  assert(
    capabilities.tools?.taskProfiles?.some((profile) => profile.id === "android"),
    "capabilities did not report Android task profile"
  );
  assert(
    capabilities.trustedDockerPolicy.some((check) => check.command.startsWith("apt-get install") && check.allowed),
    "trusted Docker policy did not allow apt-get install"
  );
  assert(
    capabilities.trustedDockerPolicy.some((check) => check.command.startsWith("wget") && check.allowed),
    "trusted Docker policy did not allow wget"
  );
  assert(
    capabilities.trustedDockerPolicy.some((check) => check.command.startsWith("chmod") && check.allowed),
    "trusted Docker policy did not allow chmod"
  );
  assert(
    capabilities.tools?.skills?.some((skill) => skill.id === "website-app"),
    "capabilities did not report built-in website skill"
  );
  assert(
    capabilities.tools?.skills?.some((skill) => skill.id === "latex-manuscript"),
    "capabilities did not report built-in LaTeX skill"
  );
  assert(
    capabilities.tools?.skills?.some((skill) => skill.id === "android"),
    "capabilities did not report built-in Android skill"
  );

  const doctor = JSON.parse(await runCli(["doctor", "--capabilities", "--json"]));
  assert(doctor.project.root === tempRoot, "doctor --capabilities used the wrong project root");
  assert(doctor.project.instructionsPresent, "doctor --capabilities did not report AGINTI.md");

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: ["aginti-md-init", "capabilities-cli", "doctor-capabilities", "maintenance-policy", "trusted-docker-policy", "git-policy", "skills-capability"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
