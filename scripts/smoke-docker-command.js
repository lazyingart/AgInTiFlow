#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  dockerWorkspaceAliasMounts,
  ensureDockerGitIdentity,
} from "../src/docker-sandbox.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-docker-command-"));

try {
  const identityRepo = path.join(tempRoot, "identity-repo");
  const dockerState = path.join(tempRoot, "docker-state");
  await fs.mkdir(identityRepo, { recursive: true });
  await fs.mkdir(path.join(dockerState, "home"), { recursive: true });
  await execFileAsync("git", ["init", identityRepo]);
  await execFileAsync("git", ["-C", identityRepo, "config", "user.name", "AgInTi Test Author"]);
  await execFileAsync("git", ["-C", identityRepo, "config", "user.email", "aginti-test@example.invalid"]);
  assert.deepEqual(
    dockerWorkspaceAliasMounts({ commandCwd: identityRepo, sandboxMode: "docker-workspace" }),
    [identityRepo],
    "Docker workspace mode should preserve the exact host workspace path as a scoped writable alias"
  );
  assert.deepEqual(
    dockerWorkspaceAliasMounts({ commandCwd: identityRepo, sandboxMode: "docker-readonly" }),
    [],
    "Read-only Docker mode must not create a writable host-path alias"
  );
  const identity = await ensureDockerGitIdentity(
    { commandCwd: identityRepo, dockerStateDir: dockerState },
    {
      root: dockerState,
      home: path.join(dockerState, "home"),
      cache: path.join(dockerState, "cache"),
      env: path.join(dockerState, "env"),
    }
  );
  assert.equal(identity.configured, true, "Docker Git identity should reuse an existing repository author");
  const identityConfig = path.join(dockerState, "home", ".gitconfig.aginti-author");
  const [storedName, storedEmail] = await Promise.all([
    execFileAsync("git", ["config", "--file", identityConfig, "--get", "user.name"]),
    execFileAsync("git", ["config", "--file", identityConfig, "--get", "user.email"]),
  ]);
  assert.equal(storedName.stdout.trim(), "AgInTi Test Author");
  assert.equal(storedEmail.stdout.trim(), "aginti-test@example.invalid");
  assert.equal((await fs.stat(identityConfig)).mode & 0o777, 0o600, "Docker author config should be private");

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
