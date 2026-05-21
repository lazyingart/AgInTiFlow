#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkToolUse } from "../src/guardrails.js";
import { longJobStatus, startLongJob } from "../src/long-job-tools.js";
import { tmuxAvailable } from "../src/tmux-tools.js";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-long-job-"));
const config = {
  allowShellTool: true,
  allowDestructive: true,
  allowPasswords: true,
  commandCwd: workspace,
  sandboxMode: "host",
  useDockerSandbox: false,
};
const dockerConfig = {
  ...config,
  allowDestructive: false,
  allowPasswords: false,
  useDockerSandbox: true,
  sandboxMode: "docker-workspace",
  packageInstallPolicy: "allow",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  if (!(await tmuxAvailable())) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "tmux is not installed" }, null, 2));
    process.exit(0);
  }

  const noShell = checkToolUse({
    toolName: "start_long_job",
    args: { command: "printf ok > out.txt" },
    config: { ...config, allowShellTool: false },
  });
  assert.equal(noShell.allowed, false, "start_long_job should require shell capability");

  const outsidePath = path.join(os.tmpdir(), "aginti-long-job-outside.txt");
  const outsideGuard = checkToolUse({
    toolName: "start_long_job",
    args: { name: "outside", command: `cat ${outsidePath}` },
    config: dockerConfig,
  });
  assert.equal(outsideGuard.allowed, false, "Docker-mode long jobs should block outside host absolute paths");

  const start = await startLongJob(
    {
      name: "smoke-download-style",
      command: "printf 'abc123' > download.bin",
      expectedOutputPath: "download.bin",
      expectedSizeBytes: 6,
      verifyCommand: "grep -q abc download.bin",
      pollIntervalSeconds: 5,
      note: "Smoke test for durable long command handoff.",
    },
    config
  );
  assert.equal(start.ok, true, start.error || start.reason);
  assert.equal(start.background, true, "long job should return as a background handoff");
  assert.match(start.statusPath, /^\.aginti\/long-jobs\//, "status path should be project-local");

  let status = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(250);
    status = await longJobStatus({ jobId: start.jobId }, config);
    assert.equal(status.ok, true, status.reason);
    if (["completed", "failed"].includes(status.state)) break;
  }
  assert.equal(status?.state, "completed", `long job did not complete: ${JSON.stringify(status)}`);
  assert.equal(status.outputBytes, 6, "expected-size progress was not recorded");
  assert.equal(status.verifyExitCode, 0, "verify command did not pass");

  const output = await fs.readFile(path.join(workspace, "download.bin"), "utf8");
  assert.equal(output, "abc123", "job output content mismatch");
  await fs.access(path.join(workspace, start.statusPath));
  await fs.access(path.join(workspace, start.stdoutPath));
  await fs.access(path.join(workspace, start.stderrPath));
  await fs.access(path.join(workspace, start.supervisorLogPath));

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        jobId: start.jobId,
        statusPath: start.statusPath,
        state: status.state,
        outputBytes: status.outputBytes,
        verifyExitCode: status.verifyExitCode,
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}
