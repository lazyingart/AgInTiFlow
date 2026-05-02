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

const execFile = promisify(execFileCallback);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-tmux-"));
const session = `aginti-smoke-${process.pid}`;
const config = {
  allowShellTool: true,
  commandCwd: workspace,
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

  console.log(
    JSON.stringify(
      {
        ok: true,
        session,
        workspace,
        checks: ["start-session", "send-keys", "capture-pane", "list-sessions", "secret-guardrail", "destructive-guardrail"],
      },
      null,
      2
    )
  );
} finally {
  await execFile("tmux", ["kill-session", "-t", session]).catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true });
}
