#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  captureTmuxPane,
  checkTmuxToolUse,
  listTmuxSessions,
  sendTmuxKeys,
  startTmuxSession,
  tmuxAvailable,
} from "../src/tmux-tools.js";
import { checkToolUse } from "../src/guardrails.js";

const execFile = promisify(execFileCallback);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-tmux-"));
const session = `aginti-smoke-${process.pid}`;
const config = {
  allowShellTool: true,
  commandCwd: workspace,
};
const dockerConfig = {
  ...config,
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

  const start = await startTmuxSession({ name: session }, config);
  assert.equal(start.ok, true, start.error || start.reason);
  await sleep(250);

  const send = await sendTmuxKeys({
    target: start.target,
    text: "printf 'aginti tmux smoke\\n'; pwd",
    enter: true,
  });
  assert.equal(send.ok, true, send.error || send.reason);
  await sleep(500);

  const capture = await captureTmuxPane({ target: start.target, lines: 40 });
  assert.equal(capture.ok, true, capture.error || capture.reason);
  assert.match(capture.content, /aginti tmux smoke/, "tmux capture did not include command output");
  assert.match(capture.content, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "tmux cwd was not workspace");

  const list = await listTmuxSessions({ includePanes: true });
  assert.equal(list.ok, true, list.error || list.reason);
  assert(list.sessions.some((item) => item.name === session), "tmux list did not include smoke session");
  assert(list.panes.some((item) => item.target === start.target), "tmux list did not include smoke pane");

  const blocked = checkTmuxToolUse(
    "tmux_send_keys",
    { target: start.target, text: "OPENAI_API_KEY=secret-value" },
    config
  );
  assert.equal(blocked.allowed, false, "tmux guardrail did not block secret-like text");

  const destructive = checkTmuxToolUse("tmux_send_keys", { target: start.target, text: "rm -rf /" }, config);
  assert.equal(destructive.allowed, false, "tmux guardrail did not block destructive text");

  const outsidePath = path.join(os.tmpdir(), "agintiflow-outside-workspace-canary.txt");
  const workspacePath = path.join(workspace, "inside-workspace.txt");
  const dockerTmuxOutsideStart = checkToolUse({
    toolName: "tmux_start_session",
    args: { name: `${session}-outside`, cwd: ".", command: `cat ${outsidePath}` },
    config: dockerConfig,
  });
  assert.equal(dockerTmuxOutsideStart.allowed, false, "Docker-mode tmux_start_session should block outside host paths");
  assert.equal(dockerTmuxOutsideStart.category, "tmux", "outside tmux path block should be categorized as tmux");

  const dockerTmuxOutsideSend = checkTmuxToolUse(
    "tmux_send_keys",
    { target: start.target, text: `cat ${outsidePath}` },
    dockerConfig
  );
  assert.equal(dockerTmuxOutsideSend.allowed, false, "Docker-mode tmux_send_keys should block outside host paths");

  const directOutsideStart = await startTmuxSession(
    { name: `${session}-direct-outside`, cwd: ".", command: `cat ${outsidePath}` },
    dockerConfig
  );
  assert.equal(directOutsideStart.ok, false, "tmux_start_session should enforce outside host path guard at execution time");

  const directOutsideSend = await sendTmuxKeys(
    { target: start.target, text: `cat ${outsidePath}`, enter: false },
    dockerConfig
  );
  assert.equal(directOutsideSend.ok, false, "tmux_send_keys should enforce outside host path guard at execution time");

  const dockerTmuxWorkspaceStart = checkToolUse({
    toolName: "tmux_start_session",
    args: { name: `${session}-inside`, cwd: ".", command: `cat ${workspacePath}` },
    config: dockerConfig,
  });
  assert.equal(dockerTmuxWorkspaceStart.allowed, true, "Docker-mode tmux_start_session should allow project absolute paths");

  const dockerTmuxRelativeStart = checkToolUse({
    toolName: "tmux_start_session",
    args: { name: `${session}-relative`, cwd: ".", command: "cat inside-workspace.txt" },
    config: dockerConfig,
  });
  assert.equal(dockerTmuxRelativeStart.allowed, true, "Docker-mode tmux_start_session should allow workspace-relative paths");

  const dockerTmuxCommand = checkToolUse({
    toolName: "run_command",
    args: { command: "tmux new-session -d -s should-not-run" },
    config: dockerConfig,
  });
  assert.equal(dockerTmuxCommand.allowed, false, "Docker run_command tmux usage should be blocked in favor of host tmux tools");
  const dockerTmuxSearch = checkToolUse({
    toolName: "run_command",
    args: { command: "rg tmux README.md" },
    config: dockerConfig,
  });
  assert.equal(dockerTmuxSearch.allowed, true, "Docker run_command should still allow harmless tmux text searches");

  const dockerNpxAginti = checkToolUse({
    toolName: "run_command",
    args: { command: "npx aginti doctor --json" },
    config: dockerConfig,
  });
  assert.equal(dockerNpxAginti.allowed, false, "Docker run_command should block npx aginti self-invocation");
  assert.equal(dockerNpxAginti.category, "nested-aginti", "npx aginti block should be categorized");

  const dockerNestedAginti = checkToolUse({
    toolName: "run_command",
    args: { command: "aginti storage status" },
    config: dockerConfig,
  });
  assert.equal(dockerNestedAginti.allowed, false, "Docker run_command should block nested aginti CLI calls");
  assert.equal(dockerNestedAginti.category, "nested-aginti", "nested aginti block should be categorized");

  console.log(
    JSON.stringify(
      {
        ok: true,
        session,
        workspace,
        checks: [
          "start-session",
          "send-keys",
          "capture-pane",
          "list-sessions",
          "secret-guardrail",
          "destructive-guardrail",
          "docker-tmux-start-outside-path-guardrail",
          "docker-tmux-send-outside-path-guardrail",
          "docker-tmux-start-project-path-allowed",
          "docker-tmux-start-relative-path-allowed",
          "docker-run-command-tmux-guardrail",
          "docker-run-command-tmux-search-allowed",
          "docker-run-command-npx-aginti-guardrail",
          "docker-run-command-nested-aginti-guardrail",
        ],
      },
      null,
      2
    )
  );
} finally {
  await execFile("tmux", ["kill-session", "-t", session]).catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true });
}
