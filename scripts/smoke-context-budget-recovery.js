#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildContextBudgetCompactionMessages } from "../src/agent-runner.js";
import {
  compactTextForTokenBudget,
  estimateMessageTokens,
  estimateTextTokens,
} from "../src/context-budget-controller.js";
import { createPlan } from "../src/model-client.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";

const HEAD = "AUTHORITATIVE-HEAD exact current task";
const TAIL = "AUTHORITATIVE-TAIL bounded task packet and latest interruption";
const hugeGoal = `${HEAD}\n${"middle context ".repeat(30000)}\n${TAIL}`;

const compacted = compactTextForTokenBudget(hugeGoal, 4096, { headFraction: 0.3 });
assert.ok(compacted.includes(HEAD), "token compaction lost the authoritative head");
assert.ok(compacted.includes(TAIL), "token compaction lost the latest authoritative tail");
assert.ok(compacted.includes("omitted to fit the provider context"));
assert.ok(estimateTextTokens(compacted) <= 4096);

const chatContract = deriveScsTaskContract({
  goal:
    'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"chat-response","request":"Return the routing JSON"}\n' +
    "Control text mentions files, artifacts, browser checks, and verification.",
  taskProfile: "chatops",
});
assert.equal(chatContract.requiresExternalEvidence, false, "chat transport control prose incorrectly required file evidence");
const planContract = deriveScsTaskContract({
  goal:
    'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"plan-response","request":"Identify the LazyEdit video routine without changing files."}\n' +
    "Control text mentions video, files, commands, artifacts, screenshots, and verification.",
  taskProfile: "auto",
});
assert.equal(planContract.requiresExternalEvidence, false, "read-only planning control prose incorrectly required execution evidence");
const hostManagedContract = deriveScsTaskContract({
  goal:
    'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"host-managed-response","request":"Return the LaTeX body; the host compiles and delivers it."}\n' +
    "Control text mentions files, artifacts, compilation, and delivery.",
  taskProfile: "chatops",
});
assert.equal(
  hostManagedContract.requiresExternalEvidence,
  false,
  "host-managed response incorrectly required the agent to duplicate caller-owned artifact work"
);
const artifactContract = deriveScsTaskContract({
  goal:
    'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create and compile the requested PDF."}\n' +
    "Control text is outside the task scope.",
  taskProfile: "chatops",
});
assert.equal(artifactContract.requiresExternalEvidence, true, "real chat artifact work lost its evidence gate");
assert.ok(artifactContract.requiredEvidence.some((item) => item.category === "artifact"));
const scopedArtifactRootContract = deriveScsTaskContract({
  goal:
    'AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create result.txt with the exact requested content.","artifact_root":"/tmp/labcanvas-task-artifacts"}',
  taskProfile: "chatops",
});
assert.equal(scopedArtifactRootContract.artifactRoot, "/tmp/labcanvas-task-artifacts");
assert.deepEqual(
  scopedArtifactRootContract.exactOutputPaths,
  ["/tmp/labcanvas-task-artifacts/result.txt"],
  "a bare task artifact filename was not resolved against the host-declared artifact root"
);

let capturedPayload = null;
const client = {
  chat: {
    completions: {
      create: async (payload) => {
        capturedPayload = payload;
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "1. Read the routine contract.\n2. Run the established routine.\n3. Verify and return artifacts.",
              },
            },
          ],
        };
      },
    },
  },
};
const config = {
  provider: "localllm",
  model: "localllm-balanced",
  maxOutputTokens: 8192,
  contextWindowTokens: 32768,
  taskProfile: "chatops",
  commandCwd: process.cwd(),
  baseDir: process.cwd(),
  allowedDomains: [],
  allowShellTool: true,
  allowFileTools: true,
  allowWrapperTools: false,
  allowAuxiliaryTools: false,
  allowWebSearch: false,
  allowMcpTools: false,
  allowParallelScouts: false,
  allowHostedImagePerception: false,
  allowHostedWebResearch: false,
  allowHostedJsonSpecialist: false,
  allowHostedWritingSpecialist: false,
  packageInstallPolicy: "block",
  permissionMode: "normal",
  sandboxMode: "docker-workspace",
  modelTimeoutMs: 0,
};
const state = {
  goal: hugeGoal,
  startUrl: "",
  meta: { projectInstructions: { exists: false, path: "" } },
};

await createPlan(client, config, state);
assert.ok(capturedPayload, "createPlan did not send a compacted request");
assert.ok(
  estimateMessageTokens(capturedPayload.messages) + 2048 <= config.contextWindowTokens,
  "compacted plan still exceeded the LocalLLM context window"
);
const sentPlan = capturedPayload.messages.map((message) => message.content || "").join("\n");
assert.ok(sentPlan.includes(HEAD), "plan request lost the exact task head");
assert.ok(sentPlan.includes(TAIL), "plan request lost the latest task tail");

const runtimeMessages = buildContextBudgetCompactionMessages(
  {
    goal: hugeGoal,
    plan: "Use the existing routine and verify its artifact.",
    messages: [
      { role: "system", content: "SYSTEM-HEAD\n" + "policy ".repeat(10000) + "\nSYSTEM-TAIL" },
      { role: "user", content: "first request" },
      {
        role: "user",
        content:
          "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable. OLD-COMPACTION-MUST-NOT-RECUR",
      },
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "read_file",
          path: "/evidence/Musia/SKILL.md",
          bytes: 2048,
          content: [
            "---",
            "name: musia-music-production",
            "description: Create and review songs through the established Musia production workflow.",
            "---",
            "# Musia Music Production",
            "Use the existing CLI and preserve the reviewed song artifacts.",
          ].join("\n"),
          commandEvidence: [{ command: "node bin/musia.js doctor --json" }],
          pathEvidence: [{ path: "bin/musia.js" }],
        }),
      },
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "list_files",
          path: "/evidence/LALACHAN/scripts",
          entries: [{ path: "scripts/xyq_cdp_browser.py" }, { path: "scripts/wait_downloaded_mp4.sh" }],
        }),
      },
      { role: "user", content: "latest interruption: send the finished PDF to this exact chat" },
    ],
  },
  config,
  { title: "", url: "" },
  3,
  { reason: "test context recovery" }
);
const runtimeText = runtimeMessages.map((message) => message.content || "").join("\n");
assert.ok(
  estimateMessageTokens(runtimeMessages) <= 12288,
  "runtime compaction exceeded the bounded LocalLLM retry target"
);
assert.ok(runtimeText.includes(HEAD));
assert.ok(runtimeText.includes(TAIL));
assert.ok(runtimeText.includes("latest interruption"));
assert.ok(runtimeText.includes("SYSTEM-HEAD"));
assert.ok(runtimeText.includes("SYSTEM-TAIL"));
assert.ok(runtimeText.includes("Retained source evidence"));
assert.ok(runtimeText.includes("/evidence/Musia/SKILL.md"));
assert.ok(runtimeText.includes("Create and review songs through the established Musia production workflow"));
assert.ok(runtimeText.includes("# Musia Music Production"));
assert.ok(runtimeText.includes("node bin/musia.js doctor --json"));
assert.ok(runtimeText.includes("scripts/xyq_cdp_browser.py"));
assert.ok(!runtimeText.includes("OLD-COMPACTION-MUST-NOT-RECUR"));
assert.match(runtimeText, /Do not reread a listed source solely because compaction occurred/);

console.log("context budget recovery smoke passed");
