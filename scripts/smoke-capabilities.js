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
  const capabilities = JSON.parse(await runCli(["capabilities", "--json"]));
  assert(capabilities.project.root === tempRoot, "capabilities did not use cwd as project root");
  assert(capabilities.project.commandCwd === tempRoot, "capabilities did not default commandCwd to project root");
  assert(capabilities.project.sharedSessionFolder, "capabilities did not report shared session folder");
  assert(capabilities.keys?.mock === true, "capabilities did not report mock availability");
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
    capabilities.maintenancePolicy.some((check) => check.command.startsWith("sudo") && !check.allowed),
    "sudo maintenance command was not blocked"
  );
  assert(
    capabilities.trustedDockerPolicy.some((check) => check.command.startsWith("apt-get install") && check.allowed),
    "trusted Docker policy did not allow apt-get install"
  );
  assert(
    capabilities.trustedDockerPolicy.some((check) => check.command.startsWith("wget") && check.allowed),
    "trusted Docker policy did not allow wget"
  );

  const doctor = JSON.parse(await runCli(["doctor", "--capabilities", "--json"]));
  assert(doctor.project.root === tempRoot, "doctor --capabilities used the wrong project root");

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot: tempRoot,
        checks: ["capabilities-cli", "doctor-capabilities", "maintenance-policy", "trusted-docker-policy"],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
