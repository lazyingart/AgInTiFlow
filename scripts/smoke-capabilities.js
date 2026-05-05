#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultMaxStepsForProfile, listTaskProfiles } from "../src/task-profiles.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-capabilities-"));
const agintiflowHome = path.join(tempRoot, ".agintiflow-home");
process.env.AGINTIFLOW_HOME = agintiflowHome;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCli(args, envOverrides = {}) {
  const result = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
    cwd: tempRoot,
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      AGINTIFLOW_RUNTIME_DIR: "",
      AGINTIFLOW_HOME: agintiflowHome,
      ...envOverrides,
    },
  });
  return result.stdout;
}

async function runCliIn(cwd, args, envOverrides = {}) {
  const result = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
    cwd,
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      AGINTIFLOW_RUNTIME_DIR: "",
      AGINTIFLOW_HOME: agintiflowHome,
      ...envOverrides,
    },
  });
  return result.stdout;
}

try {
  await runCli(["init"]);
  const agintiMd = await fs.readFile(path.join(tempRoot, "AGINTI.md"), "utf8");
  assert(agintiMd.includes("Project instructions for AgInTiFlow agents."), "init did not create AGINTI.md");
  assert(agintiMd.includes("## Agent Operating Contract"), "default init did not include the behavior contract");
  assert(agintiMd.includes("## Verification Contract"), "default init did not include verification contract");
  assert(agintiMd.includes("## Permission And Safety Contract"), "default init did not include permission contract");
  assert(agintiMd.includes("## Definition Of Done"), "default init did not include definition of done");
  const templates = await runCli(["init", "--list-templates"]);
  assert(templates.includes("disciplined") && templates.includes("supervision"), "init did not list instruction templates");
  const minimalRoot = path.join(tempRoot, "minimal-template");
  await fs.mkdir(minimalRoot);
  const minimalOutput = await runCliIn(minimalRoot, ["init", "--template", "minimal"]);
  const minimalMd = await fs.readFile(path.join(minimalRoot, "AGINTI.md"), "utf8");
  assert(minimalOutput.includes("template=minimal"), "minimal init did not report template");
  assert(minimalMd.includes("## Agent Contract"), "minimal template did not create compact contract");
  assert(!minimalMd.includes("## Architecture Notes"), "minimal template should stay compact");
  const codingRoot = path.join(tempRoot, "coding-template");
  await fs.mkdir(codingRoot);
  await runCliIn(codingRoot, ["init", "coding"]);
  const codingMd = await fs.readFile(path.join(codingRoot, "AGINTI.md"), "utf8");
  assert(codingMd.includes("## Coding Profile Notes"), "coding template did not add coding appendix");
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
    capabilities.tools?.taskProfiles?.some((profile) => profile.id === "supervision"),
    "capabilities did not report supervision task profile"
  );
  for (const profileId of ["docs", "data", "qa", "database", "devops", "security", "slides", "education", "java", "ios", "go", "rust", "dotnet", "php", "ruby"]) {
    assert(
      capabilities.tools?.taskProfiles?.some((profile) => profile.id === profileId),
      `capabilities did not report ${profileId} task profile`
    );
  }
  const qaProfile = listTaskProfiles().find((profile) => profile.id === "qa");
  assert(qaProfile, "QA profile is missing");
  assert(defaultMaxStepsForProfile("qa") >= 40, "QA profile step budget is too low for verification and cleanup");
  assert(!/misleading failing test/i.test(qaProfile.prompt), "QA profile still encourages misleading test fixtures");
  assert(/do not stage fake bugs/i.test(qaProfile.prompt), "QA profile does not discourage fake staged failures");
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
  assert(
    capabilities.tools?.skills?.some((skill) => skill.id === "supervision-student"),
    "capabilities did not report built-in supervision skill"
  );
  for (const skillId of ["data-analysis", "docs-knowledge", "qa-testing", "database", "devops-deployment", "security-review", "presentation-slides", "writing-editing", "java-jvm", "ios-swift", "go", "rust", "dotnet-csharp", "php", "ruby"]) {
    assert(
      capabilities.tools?.skills?.some((skill) => skill.id === skillId),
      `capabilities did not report built-in ${skillId} skill`
    );
  }

  const doctor = JSON.parse(await runCli(["doctor", "--capabilities", "--json"]));
  assert(doctor.project.root === tempRoot, "doctor --capabilities used the wrong project root");
  assert(doctor.project.instructionsPresent, "doctor --capabilities did not report AGINTI.md");
  const envSandboxRun = await runCli(
    ["--provider", "mock", "--routing", "manual", "--model", "mock-agent", "--max-steps", "1", "env sandbox smoke"],
    {
      SANDBOX_MODE: "host",
      PACKAGE_INSTALL_POLICY: "allow",
      USE_DOCKER_SANDBOX: "false",
    }
  );
  assert(envSandboxRun.includes("Shell: host policy=allow"), "one-shot CLI did not respect host sandbox env defaults");
  assert(!envSandboxRun.includes("Docker workspace:"), "one-shot CLI forced Docker despite host sandbox env defaults");

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: [
          "aginti-md-init",
          "capabilities-cli",
          "doctor-capabilities",
          "maintenance-policy",
          "trusted-docker-policy",
          "git-policy",
          "skills-capability",
          "env-sandbox-defaults",
          "aginti-md-contract-templates",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
