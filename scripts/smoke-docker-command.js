#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-docker-command-"));

try {
  const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "docker", "status", "--json", "--cwd", tempRoot], {
    cwd: tempRoot,
    env: {
      ...process.env,
      AGINTIFLOW_NO_WEB_AUTO_START: "1",
    },
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true, "docker status command should return ok envelope");
  assert.equal(parsed.summary.workspace, tempRoot, "docker status should honor --cwd");
  assert.equal(typeof parsed.summary.dockerAvailable, "boolean", "docker status should include docker availability");
  assert(parsed.summary.install?.command, "docker status should include install guidance");

  const install = await execFileAsync(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "docker", "install-host", "--json"], {
    cwd: tempRoot,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  const installPlan = JSON.parse(install.stdout);
  assert.equal(typeof installPlan.supported, "boolean", "install-host plan should state support");
  assert(installPlan.command, "install-host plan should include a command or guidance");

  console.log("docker command smoke ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
