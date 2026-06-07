#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentLinkStatus,
  attachAgentLinkEvidence,
  claimAgentLinkTask,
  createAgentLinkBoard,
  executeAgentLinkTool,
  getAgentLinkBoard,
  listAgentLinkPeers,
  sendAgentLinkMessage,
  summarizeAgentLinkSession,
} from "../src/agentlink.js";
import { createClient, requestNextStep } from "../src/model-client.js";
import { listSkills, selectSkillsForGoal } from "../src/skill-library.js";
import { SessionStore } from "../src/session-store.js";
import { globalSessionPaths } from "../src/session-index.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-agentlink-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");

try {
  const sessionId = "agentlink-target-smoke";
  const global = globalSessionPaths();
  const store = new SessionStore(global.sessionsDir, sessionId);
  await store.saveState({
    sessionId,
    status: "idle",
    provider: "mock",
    model: "mock-agent",
    goal: "Target session for AgentLink smoke.",
    projectRoot: tempRoot,
    commandCwd: tempRoot,
    updatedAt: new Date().toISOString(),
    stepsCompleted: 1,
  });
  await store.appendEvent("session.finished", { result: "synthetic done" });
  await store.appendEvent("file.changed", {
    toolName: "write_file",
    action: "create_file",
    path: "notes/agentlink-context.md",
    afterHash: "abc123",
    diff: "--- a/notes/agentlink-context.md\n+++ b/notes/agentlink-context.md\n@@ line 1 @@\n+AgentLink smoke fact: shared-color=cyan sample-id=AGLINK-SMOKE-001",
  });

  const status = await agentLinkStatus({ commandCwd: tempRoot });
  assert.equal(status.ok, true);
  assert.equal(status.localDiscovery, true);
  assert.equal(status.networkDiscovery, false);
  assert.equal(status.rawSessionSharing, false);
  assert(status.identity?.nodeId, "AgentLink identity was not created");

  const peers = await listAgentLinkPeers({ limit: 20 });
  assert(peers.peers.some((peer) => peer.sessionId === sessionId), "AgentLink peers did not include indexed session");

  const boardResult = await createAgentLinkBoard({
    boardId: "smoke-board",
    title: "AgentLink smoke board",
    objective: "Verify collaboration primitives.",
    projectRoot: tempRoot,
  });
  assert.equal(boardResult.ok, true);
  assert.equal(boardResult.board.boardId, "smoke-board");

  const contract = await claimAgentLinkTask({
    boardId: "smoke-board",
    title: "Check target session",
    ownerSessionId: sessionId,
    instructions: "Report status with evidence.",
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.contract.ownerSessionId, sessionId);

  const message = await sendAgentLinkMessage({
    boardId: "smoke-board",
    toSessionId: sessionId,
    kind: "request",
    content: "Please report status with evidence.",
    priority: "asap",
  });
  assert.equal(message.ok, true);
  assert(message.inboxItem?.id, "AgentLink did not append target inbox item");
  const inbox = await store.loadInbox();
  assert(inbox.some((item) => item.source === "agentlink" && item.priority === "asap"), "target inbox did not contain AgentLink item");

  const evidence = await attachAgentLinkEvidence({
    boardId: "smoke-board",
    contractId: contract.contract.contractId,
    sessionId,
    summary: "Synthetic session summary was verified.",
    path: "reports/smoke.md",
  });
  assert.equal(evidence.ok, true);

  const board = await getAgentLinkBoard({ boardId: "smoke-board" });
  assert.equal(board.ok, true);
  assert.equal(board.messages.length, 1);
  assert.equal(board.contracts.length, 1);
  assert.equal(board.evidence.length, 1);

  const summary = await summarizeAgentLinkSession({ sessionId });
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.goal, "Target session for AgentLink smoke.");
  assert(summary.summary.eventCount >= 1, "session summary did not include event count");
  assert(summary.summary.recentChanges.some((change) => change.path === "notes/agentlink-context.md"), "session summary missed file-change evidence");
  assert(
    summary.summary.recentChanges.some((change) => String(change.diff || "").includes("AGLINK-SMOKE-001")),
    "session summary missed redacted diff context"
  );
  assert(!JSON.stringify(summary).includes("Please report status with evidence."), "session summary leaked raw inbox content");

  const toolResult = await executeAgentLinkTool("agentlink_get_board", { boardId: "smoke-board" }, { commandCwd: tempRoot }, { sessionId });
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.board.boardId, "smoke-board");

  const skills = listSkills({ includeBody: true, projectRoot: tempRoot });
  assert(skills.some((skill) => skill.id === "aginti-agentlink"), "built-in AgentLink skill did not load");
  const selected = selectSkillsForGoal("coordinate multiple aginti sessions with agentlink", { projectRoot: tempRoot });
  assert(selected.some((skill) => skill.id === "aginti-agentlink"), "AgentLink skill was not selected for collaboration prompt");

  const cli = await execFileAsync(process.execPath, [path.join(process.cwd(), "bin/aginti-cli.js"), "--no-auto-update", "agentlink", "status", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, AGINTIFLOW_HOME: process.env.AGINTIFLOW_HOME },
    timeout: 10_000,
  });
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.feature, "agentlink");

  const cliCreate = await execFileAsync(
    process.execPath,
    [
      path.join(process.cwd(), "bin/aginti-cli.js"),
      "--no-auto-update",
      "agentlink",
      "create",
      "cli-board",
      "CLI",
      "board",
      "title",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGINTIFLOW_HOME: process.env.AGINTIFLOW_HOME },
      timeout: 10_000,
    }
  );
  const parsedCreate = JSON.parse(cliCreate.stdout);
  assert.equal(parsedCreate.board.boardId, "cli-board");
  assert.equal(parsedCreate.board.title, "CLI board title");

  const mockClient = createClient({ provider: "mock" });
  const mockConfig = {
    provider: "mock",
    model: "mock-agent",
    goal: "Use AgentLink to find the other session context and report the shared-color and sample-id.",
    allowFileTools: true,
    allowShellTool: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    taskProfile: "auto",
  };
  const currentStore = new SessionStore(global.sessionsDir, "agentlink-current-smoke");
  await currentStore.saveState({
    sessionId: "agentlink-current-smoke",
    status: "running",
    provider: "mock",
    model: "mock-agent",
    goal: mockConfig.goal,
    projectRoot: tempRoot,
    commandCwd: tempRoot,
    updatedAt: new Date(Date.now() + 1000).toISOString(),
    stepsCompleted: 0,
  });
  const initialMessages = [{ role: "user", content: `Goal: ${mockConfig.goal}` }];
  const firstMock = await requestNextStep(mockClient, mockConfig, initialMessages);
  const firstTool = firstMock.choices[0].message.tool_calls[0];
  assert.equal(firstTool.function.name, "agentlink_list_peers");
  const peersPayload = await executeAgentLinkTool("agentlink_list_peers", JSON.parse(firstTool.function.arguments), { commandCwd: tempRoot }, {});
  const secondMessages = [...initialMessages, firstMock.choices[0].message, { role: "tool", tool_call_id: firstTool.id, content: JSON.stringify(peersPayload) }];
  const secondMock = await requestNextStep(mockClient, mockConfig, secondMessages);
  const secondTool = secondMock.choices[0].message.tool_calls[0];
  assert.equal(secondTool.function.name, "agentlink_summarize_session");
  const summaryPayload = await executeAgentLinkTool("agentlink_summarize_session", JSON.parse(secondTool.function.arguments), { commandCwd: tempRoot }, {});
  const thirdMessages = [...secondMessages, secondMock.choices[0].message, { role: "tool", tool_call_id: secondTool.id, content: JSON.stringify(summaryPayload) }];
  const thirdMock = await requestNextStep(mockClient, mockConfig, thirdMessages);
  const finishTool = thirdMock.choices[0].message.tool_calls[0];
  assert.equal(finishTool.function.name, "finish");
  const finishArgs = JSON.parse(finishTool.function.arguments);
  assert.match(finishArgs.result, /shared-color=cyan/);
  assert.match(finishArgs.result, /AGLINK-SMOKE-001/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: [
          "identity-created",
          "local-session-discovery",
          "board-created",
          "contract-created",
          "message-sent-to-session-inbox",
          "evidence-attached",
          "safe-session-summary",
          "safe-file-change-context",
          "model-tool-bridge",
          "mock-agentlink-routing",
          "built-in-skill-loaded",
          "cli-json-status",
          "cli-create-id-title",
        ],
      },
      null,
      2
    )
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
