#!/usr/bin/env node
import assert from "node:assert/strict";
import { reviewScsFinish, reviewScsProgress } from "../src/scs-controller.js";

function fakeStudentClient(json) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(json),
              },
            },
          ],
        }),
      },
    },
  };
}

const noEvidenceProgress = {
  role: "student",
  decision: "reject_phase",
  confidence: 0.91,
  evidence: ["no tool results visible"],
  reason: "There is no actionable evidence that any step was executed.",
  next_required_action: "collect evidence",
};

const progressDecision = await reviewScsProgress(
  fakeStudentClient(noEvidenceProgress),
  { model: "mock-model", modelTimeoutMs: 0, taskProfile: "supervision" },
  {
    goal: "Supervise a tmux task with evidence.",
    meta: { scs: { enabled: true, active: true, monitorReviews: 0 } },
    messages: [],
  },
  {
    taskProfile: "supervision",
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: "tmux list-sessions" },
          stdout: "worker: 1 windows",
          exitCode: 0,
        },
      },
    ],
  }
);

assert.equal(progressDecision.decision, "accept_phase", "SCS should not accept a no-evidence progress rejection when ledger evidence exists");
assert.match(progressDecision.reason, /Overrode a no-evidence progress rejection/);

const noEvidenceFinish = {
  role: "student",
  decision: "finish_rejected",
  confidence: 0.88,
  evidence: ["no concrete evidence"],
  reason: "The final answer lacks tool evidence.",
  next_required_action: "collect evidence",
};

const finishDecision = await reviewScsFinish(
  fakeStudentClient(noEvidenceFinish),
  { model: "mock-model", modelTimeoutMs: 0, taskProfile: "supervision", commandCwd: process.cwd() },
  {
    goal: "Read the requested file and report evidence.",
    meta: {
      scs: {
        enabled: true,
        active: true,
        finishRejects: 0,
        taskContract: {
          version: 1,
          outcome: "Read the requested file and report evidence.",
          taskProfile: "supervision",
          requiresExternalEvidence: true,
          requiredEvidence: [{ id: "file", category: "file", description: "file evidence" }],
        },
      },
    },
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "read_file",
          path: "books/shiji/work/aginti/orchestrator_prompt.md",
          bytes: 5317,
        }),
      },
    ],
  },
  "Read completed with evidence.",
  { taskProfile: "supervision", events: [] }
);

assert.equal(finishDecision.decision, "finish_allowed", "SCS should not reject finish as no-evidence when the contract ledger is satisfied");
assert.match(finishDecision.reason, /Overrode a no-evidence finish rejection/);

console.log("SCS evidence visibility smoke ok");
