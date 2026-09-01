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
import { recordDurableResearchEvidence } from "../src/durable-research-evidence.js";

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
const retainedReportContract = deriveScsTaskContract({
  goal: [
    "The completed evidence is already saved in tmp/reliability-evidence-pass.md and must remain read-only.",
    "Read only missing bounded ranges of tmp/reliability-evidence-pass.md.",
    "Rewrite agent-reliability-evidence-review.md as a concise decision document.",
    "Rebuild sources.json so it contains only cited sources.",
  ].join("\n"),
  taskProfile: "research",
});
assert.deepEqual(
  retainedReportContract.exactOutputPaths,
  ["agent-reliability-evidence-review.md", "sources.json"],
  "report continuation confused an existing saved input with rewrite/rebuild outputs"
);
assert.deepEqual(
  retainedReportContract.exactInputPaths,
  ["tmp/reliability-evidence-pass.md"],
  "report continuation lost the read-only evidence input"
);
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

const compactionState = {
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
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "deep-research-complete",
          type: "function",
          function: {
            name: "deep_research",
            arguments: '{"query":"reliability evidence","outputPath":"reports/reliability.md"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "deep-research-complete",
      content: JSON.stringify({
        ok: true,
        toolName: "deep_research",
        version: 14,
        researchId: "reliability-evidence-v14",
        status: "completed",
        stage: "completed",
        reportPath: "reports/reliability.md",
        artifactPath: ".aginti/deep-research-reliability.json",
        queryCount: 10,
        sourceCount: 16,
        answer: "RESEARCH-COMPACTION-SUMMARY",
        coverage: { requiredFirstPartyVerified: true },
        audit: { citationCoverage: 1 },
      }),
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "evidence-chunk-one",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"reports/reliability.md","startLine":1,"lineLimit":50}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "evidence-chunk-one",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        goalRevision: 11,
        path: "reports/reliability.md",
        startLine: 1,
        lineLimit: 50,
        lineCount: 100,
        bytes: 8000,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        contentTruncated: false,
        content: `EVIDENCE-CHUNK-ONE measured retry findings\n${"retry evidence ".repeat(220)}`,
      }),
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "evidence-chunk-two",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"reports/reliability.md","startLine":51,"lineLimit":50}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "evidence-chunk-two",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "reports/reliability.md",
        startLine: 51,
        lineLimit: 50,
        lineCount: 100,
        bytes: 8000,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        contentTruncated: false,
        content: `EVIDENCE-CHUNK-TWO limitations and recommendations\n${"limitation evidence ".repeat(180)}`,
      }),
    },
    {
      role: "tool",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        goalRevision: 11,
        path: "/evidence/Musia/SKILL.md",
        bytes: 2048,
        sha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        contentTruncated: false,
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
};
recordDurableResearchEvidence(compactionState, {
  ok: true,
  toolName: "web_search",
  query: "closed-loop organoid imaging",
  results: [{
    title: "A modular platform for automated organoid culture and longitudinal imaging",
    url: "https://example.org/organoid-platform",
    snippet: "Automated media exchange, longitudinal imaging, and environmental feedback.",
    publishedAt: "2026",
  }],
});
recordDurableResearchEvidence(compactionState, {
  ok: true,
  toolName: "read_web_page",
  query: "closed-loop organoid imaging",
  title: "A modular platform for automated organoid culture and longitudinal imaging",
  canonicalUrl: "https://example.org/organoid-platform",
  passages: ["The verified source combines automated culture with longitudinal imaging."],
  retrievedAt: "2026-08-30T01:00:00.000Z",
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
const runtimeMessages = buildContextBudgetCompactionMessages(
  compactionState,
  config,
  { title: "", url: "" },
  3,
  { reason: "test context recovery" }
);
const runtimeText = runtimeMessages.map((message) => message.content || "").join("\n");
const retainedNativeDeepResearch = runtimeMessages.find((message) =>
  Array.isArray(message.tool_calls) &&
  message.tool_calls.some((call) => call?.function?.name === "deep_research")
);
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
assert.ok(runtimeText.includes("sha256=1234567890abcdef"));
const retainedRevisionedReadIndex = runtimeMessages.findIndex((message) =>
  Array.isArray(message.tool_calls) &&
  message.tool_calls.some(
    (call) =>
      call?.function?.name === "read_file" &&
      String(call?.function?.arguments || "").includes("reports/reliability.md") &&
      String(call?.function?.arguments || "").includes('"startLine":1')
  )
);
assert.ok(retainedRevisionedReadIndex >= 0, "native compaction lost the revisioned source read");
assert.equal(
  JSON.parse(runtimeMessages[retainedRevisionedReadIndex + 1].content).goalRevision,
  11,
  "runtime compaction dropped the source read's goal revision"
);
assert.ok(runtimeText.includes("content=complete"));
assert.ok(runtimeText.includes("node bin/musia.js doctor --json"));
assert.ok(runtimeText.includes("scripts/xyq_cdp_browser.py"));
assert.ok(retainedNativeDeepResearch, "native compaction lost the completed deep_research call");
assert.ok(runtimeText.includes("reliability-evidence-v14"));
assert.ok(runtimeText.includes('"version":14'));
assert.ok(runtimeText.includes("RESEARCH-COMPACTION-SUMMARY"));
assert.ok(runtimeText.includes("EVIDENCE-CHUNK-ONE"));
assert.ok(runtimeText.includes("EVIDENCE-CHUNK-TWO"));
assert.ok(runtimeText.includes("Durable inspected web evidence"));
assert.ok(runtimeText.includes("A modular platform for automated organoid culture"));
assert.ok(runtimeText.includes("https://example.org/organoid-platform"));
assert.ok(runtimeText.includes("verified source combines automated culture"));
assert.ok(runtimeText.includes("range=lines 1-50"));
assert.ok(runtimeText.includes("range=lines 51-100"));
assert.ok(!runtimeText.includes("OLD-COMPACTION-MUST-NOT-RECUR"));
assert.match(runtimeText, /Do not reread a listed source solely because compaction occurred/);
assert.match(runtimeText, /never restart a full-file read loop after compaction/);

const latestSemanticCorrection = [
  "Continue the current task from the preserved state.",
  "LATEST-CORRECTION-AUTHORITY replaces the stale interpretation with a detailed current behavior contract that deliberately contains no exact file path or shell command.",
  "Preserve verified progress, reconcile the remaining implementation against this correction, avoid repeating rejected states, and verify the current result before finishing.",
].join(" ");
const staleGoalCompactionState = {
  goal: "STALE-ACTIVE-GOAL continue the older interpretation.",
  plan: "Use current evidence and finish the retained task.",
  messages: [
    { role: "system", content: "Preserve the latest substantive same-task correction." },
    { role: "user", content: `Continue the current task from saved state: ${latestSemanticCorrection}` },
  ],
  meta: {
    taskProfile: "auto",
    goalContract: {
      version: 3,
      revision: 9,
      activeGoalRevision: 8,
      taskGoal: "Complete the retained task.",
      activeGoal: "STALE-ACTIVE-GOAL continue the older interpretation.",
      currentRequest: latestSemanticCorrection,
      history: [{ revision: 9, refreshExecutionContract: false }],
    },
  },
};
const staleGoalCompactionMessages = buildContextBudgetCompactionMessages(
  staleGoalCompactionState,
  config,
  { title: "", url: "" },
  17,
  { reason: "recover the latest semantic correction from an older saved session" }
);
const staleGoalCompactionText = staleGoalCompactionMessages
  .map((message) => message.content || "")
  .join("\n");
const authoritativeGoalSection = staleGoalCompactionText
  .split("Authoritative current goal:")[1]
  ?.split("Current plan:")[0] || "";
assert.ok(
  authoritativeGoalSection.includes("LATEST-CORRECTION-AUTHORITY"),
  "compaction kept an older active goal above a substantive latest correction"
);
assert.ok(
  !authoritativeGoalSection.includes("STALE-ACTIVE-GOAL"),
  "compaction still labeled the stale active goal as authoritative"
);

const deepSeekRuntimeMessages = buildContextBudgetCompactionMessages(
  compactionState,
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  3,
  { reason: "test DeepSeek context recovery" }
);
const deepSeekRuntimeText = deepSeekRuntimeMessages.map((message) => message.content || "").join("\n");
assert.ok(deepSeekRuntimeText.includes("Tool: deep_research"));
assert.ok(deepSeekRuntimeText.includes("reliability-evidence-v14"));
assert.ok(deepSeekRuntimeText.includes('"version":14'));
assert.ok(deepSeekRuntimeText.includes("RESEARCH-COMPACTION-SUMMARY"));
assert.ok(deepSeekRuntimeText.includes("EVIDENCE-CHUNK-ONE"));
assert.ok(deepSeekRuntimeText.includes("EVIDENCE-CHUNK-TWO"));
assert.ok(
  estimateMessageTokens(deepSeekRuntimeMessages) <= 12288,
  "DeepSeek runtime compaction exceeded the bounded retry target"
);

const staleReadAfterMutationState = {
  goal: "Repair service_ctl.py from current source and verify the service lifecycle tests.",
  plan: "Use current source state and latest test evidence.",
  messages: [
    { role: "system", content: "Preserve current source truth across compaction." },
    { role: "user", content: "Continue the current service recovery task." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "stale-source-read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "service_ctl.py", startLine: 1, lineLimit: 40 }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "stale-source-read",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "service_ctl.py",
        startLine: 1,
        lineLimit: 40,
        lineCount: 80,
        bytes: 3200,
        sha256: "1111111111111111111111111111111111111111111111111111111111111111",
        contentTruncated: false,
        content: "STALE-SERVICE-CONTENT command = f'python gateway_service.py'",
      }),
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "current-source-mutation",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              path: "service_ctl.py",
              search: "command = f'python gateway_service.py'",
              replace: "command = [sys.executable, 'gateway_service.py']",
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "current-source-mutation",
      content: JSON.stringify({
        ok: true,
        toolName: "apply_patch",
        path: "service_ctl.py",
        summary: "1 file change applied",
      }),
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "fresh-source-read",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "service_ctl.py", startLine: 41, lineLimit: 40 }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "fresh-source-read",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "service_ctl.py",
        startLine: 41,
        lineLimit: 40,
        lineCount: 80,
        bytes: 3300,
        sha256: "2222222222222222222222222222222222222222222222222222222222222222",
        contentTruncated: false,
        content: "FRESH-SERVICE-CONTENT shell=False and lifecycle helpers are current",
      }),
    },
    ...Array.from({ length: 8 }, (_, index) => readOnlyDiagnosticPair(index + 30)).flat(),
  ],
};
const staleReadAfterMutationMessages = buildContextBudgetCompactionMessages(
  staleReadAfterMutationState,
  config,
  { title: "", url: "" },
  12,
  { reason: "discard stale pre-mutation source reads" }
);
const staleReadAfterMutationText = staleReadAfterMutationMessages
  .map((message) => message.content || "")
  .join("\n");
assert.ok(
  !staleReadAfterMutationText.includes("STALE-SERVICE-CONTENT"),
  "compaction retained a source read that predates a successful mutation of the same file"
);
assert.ok(
  staleReadAfterMutationText.includes("FRESH-SERVICE-CONTENT"),
  "compaction discarded the bounded source read made after the successful mutation"
);
assert.ok(
  staleReadAfterMutationMessages.some((message) =>
    Array.isArray(message.tool_calls) &&
    message.tool_calls.some((call) => call?.function?.name === "apply_patch")
  ),
  "compaction discarded the successful mutation while invalidating its stale predecessor read"
);

function noisyFullReadPair(index, generation) {
  const id = `validator-${generation}-${index}`;
  const file = `tmp/validator-${generation}-${index}.py`;
  return [
    {
      role: "assistant",
      content: "",
      reasoning_content: "Inspect the latest validator.",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: file,
        bytes: 4096,
        lineCount: 120,
        sha256: `${generation}${String(index).padStart(2, "0")}`.repeat(24).slice(0, 64),
        contentTruncated: false,
        content: `VALIDATOR-${generation}-${index}\n${"broad validator content ".repeat(150)}`,
      }),
    },
  ];
}

function boundedOutputReadPair(index, generation) {
  const id = `output-${generation}-${index}`;
  return [
    {
      role: "assistant",
      content: "",
      reasoning_content: "Inspect the existing mutable output.",
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              path: "agent-reliability-evidence-review.md",
              startLine: 1 + (index - 1) * 40,
              lineLimit: 40,
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "agent-reliability-evidence-review.md",
        startLine: 1 + (index - 1) * 40,
        lineLimit: 40,
        lineCount: 240,
        bytes: 24000,
        sha256: `${generation}${String(index).padStart(2, "0")}`.repeat(24).slice(0, 64),
        contentTruncated: false,
        content: `MUTABLE-OUTPUT-${generation}-${index}\n${"old output content ".repeat(170)}`,
      }),
    },
  ];
}

function exactInputEvidencePair(index) {
  const id = `exact-input-${index}`;
  const startLine = 1 + (index - 1) * 45;
  return [
    {
      role: "assistant",
      content: "",
      reasoning_content: "Read one bounded exact-input evidence range.",
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              path: "tmp/reliability-evidence-pass.md",
              startLine,
              lineLimit: 45,
            }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "tmp/reliability-evidence-pass.md",
        startLine,
        lineLimit: 45,
        lineCount: 180,
        bytes: 24000,
        sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        contentTruncated: false,
        content: `EXACT-INPUT-RANGE-${index}\n${`source evidence ${index} `.repeat(220)}`,
      }),
    },
  ];
}

function readOnlyDiagnosticPair(index) {
  const id = `diagnostic-${index}`;
  const command = `python3 -c "print('diagnostic ${index}')"`;
  return [
    {
      role: "assistant",
      content: "",
      reasoning_content: "Inspect one diagnostic without changing task outputs.",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({
        ok: true,
        toolName: "run_command",
        args: { command },
        exitCode: 0,
        stdout: `DIAGNOSTIC-${index}\n${"read-only shell output ".repeat(80)}`,
      }),
    },
  ];
}

const exactInputCoverageState = {
  goal: [
    "Read tmp/reliability-evidence-pass.md as the exact read-only input.",
    "Rewrite agent-reliability-evidence-review.md.",
    "Rebuild sources.json.",
  ].join("\n"),
  plan: "Use retained evidence and create the two outputs.",
  meta: {
    scs: {
      taskContract: {
        exactInputPaths: ["tmp/reliability-evidence-pass.md"],
        exactOutputPaths: ["agent-reliability-evidence-review.md", "sources.json"],
      },
    },
  },
  messages: [
    { role: "system", content: `SYSTEM-INPUT-COVERAGE\n${"policy ".repeat(5000)}` },
    { role: "user", content: "Create a source-grounded reader-facing report." },
    ...Array.from({ length: 4 }, (_, index) => exactInputEvidencePair(index + 1)).flat(),
    ...Array.from({ length: 10 }, (_, index) => readOnlyDiagnosticPair(index + 1)).flat(),
    ...Array.from({ length: 6 }, (_, index) => boundedOutputReadPair(index + 1, 9)).flat(),
  ],
};
const exactInputCoverage = buildContextBudgetCompactionMessages(
  exactInputCoverageState,
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  20,
  { reason: "preserve all exact-input source ranges over diagnostics" }
);
const exactInputCoverageText = exactInputCoverage.map((message) => message.content || "").join("\n");
for (let index = 1; index <= 4; index += 1) {
  assert.ok(
    exactInputCoverageText.includes(`EXACT-INPUT-RANGE-${index}`),
    `compaction lost exact input evidence range ${index}`
  );
}
assert.ok(
  estimateMessageTokens(exactInputCoverage) <= 12288,
  "exact-input evidence retention exceeded the bounded retry target"
);

const twiceCompactedState = {
  ...compactionState,
  meta: {
    scs: {
      taskContract: {
        exactInputPaths: ["reports/reliability.md"],
        exactOutputPaths: ["agent-reliability-evidence-review.md", "sources.json"],
      },
    },
  },
  messages: [
    ...deepSeekRuntimeMessages,
    ...Array.from({ length: 14 }, (_, index) => noisyFullReadPair(index + 1, 2)).flat(),
    ...Array.from({ length: 8 }, (_, index) => readOnlyDiagnosticPair(index + 1)).flat(),
    ...Array.from({ length: 6 }, (_, index) => boundedOutputReadPair(index + 1, 2)).flat(),
  ],
};
const twiceCompacted = buildContextBudgetCompactionMessages(
  twiceCompactedState,
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  8,
  { reason: "second DeepSeek compaction" }
);
const twiceCompactedText = twiceCompacted.map((message) => message.content || "").join("\n");
assert.ok(twiceCompactedText.includes("reliability-evidence-v14"));
assert.ok(twiceCompactedText.includes("EVIDENCE-CHUNK-ONE"));
assert.ok(twiceCompactedText.includes("EVIDENCE-CHUNK-TWO"));
assert.equal(
  (twiceCompactedText.match(/Tool: deep_research/g) || []).length,
  1,
  "second DeepSeek compaction duplicated the completed research record"
);

const thriceCompactedState = {
  ...compactionState,
  meta: twiceCompactedState.meta,
  messages: [
    ...twiceCompacted,
    ...Array.from({ length: 14 }, (_, index) => noisyFullReadPair(index + 1, 3)).flat(),
    ...Array.from({ length: 6 }, (_, index) => boundedOutputReadPair(index + 1, 3)).flat(),
  ],
};
const thriceCompacted = buildContextBudgetCompactionMessages(
  thriceCompactedState,
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  12,
  { reason: "third DeepSeek compaction" }
);
const thriceCompactedText = thriceCompacted.map((message) => message.content || "").join("\n");
assert.ok(thriceCompactedText.includes("reliability-evidence-v14"));
assert.ok(thriceCompactedText.includes("EVIDENCE-CHUNK-ONE"));
assert.ok(thriceCompactedText.includes("EVIDENCE-CHUNK-TWO"));
assert.ok(
  estimateMessageTokens(thriceCompacted) <= 12288,
  "cumulative DeepSeek compaction exceeded the bounded retry target"
);

const instructionReadPair = [
  {
    role: "assistant",
    content: "",
    reasoning_content: "Read the exact project instructions before editing.",
    tool_calls: [
      {
        id: "read-project-instructions",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"AGENTS.md"}' },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "read-project-instructions",
    content: JSON.stringify({
      ok: true,
      toolName: "read_file",
      path: "AGENTS.md",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      content: "PROJECT-INSTRUCTION-MARKER preserve inputs and never inspect the external validator source.",
    }),
  },
];
const instructionCompactionState = {
  ...compactionState,
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "Repair the canonical CAD producer." },
    ...instructionReadPair,
    { role: "user", content: "Continue the current task from saved state: repair after validation." },
    ...Array.from({ length: 18 }, (_, index) => noisyFullReadPair(index + 1, 7)).flat(),
  ],
};
const instructionCompacted = buildContextBudgetCompactionMessages(
  instructionCompactionState,
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  22,
  { reason: "preserve project instructions across a continuation boundary" }
);
const instructionCompactedText = instructionCompacted
  .map((message) => message.content || "")
  .join("\n");
assert.ok(
  instructionCompactedText.includes("PROJECT-INSTRUCTION-MARKER"),
  "compaction lost a project instruction read that preceded the latest continuation boundary"
);
const instructionCompactedAgain = buildContextBudgetCompactionMessages(
  {
    ...instructionCompactionState,
    messages: [
      ...instructionCompacted,
      { role: "user", content: "Continue the current task from saved state: apply the bounded repair." },
      ...Array.from({ length: 18 }, (_, index) => noisyFullReadPair(index + 1, 8)).flat(),
    ],
  },
  { ...config, provider: "deepseek", model: "deepseek-chat" },
  { title: "", url: "" },
  26,
  { reason: "preserve project instructions through repeated compaction" }
);
const instructionCompactedAgainText = instructionCompactedAgain
  .map((message) => message.content || "")
  .join("\n");
assert.ok(
  instructionCompactedAgainText.includes("PROJECT-INSTRUCTION-MARKER"),
  "repeated compaction dropped durable project instruction evidence"
);
assert.equal(
  instructionCompactedAgain.filter(
    (message) =>
      message.role === "user" &&
      /Tool:\s*read_file/.test(message.content || "") &&
      /Arguments:\s*\{\"path\":\"AGENTS\.md\"\}/.test(message.content || "")
  ).length,
  1,
  "repeated compaction duplicated the durable AGENTS.md tool record"
);

console.log("context budget recovery smoke passed");
