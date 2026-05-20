#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  getModelRoleDefaults,
  modelsForProviderGroup,
  selectModelRoute,
} from "../src/model-routing.js";
import { normalizeTextToolCallResponse, parseTextToolCalls, usesTextToolProtocol } from "../src/model-client.js";
import { modelRoleChoices, selectorVisibleWindow } from "../src/interactive-cli.js";
import {
  buildScsEvidencePack,
  buildSupervisorInstruction,
  deterministicPlanActionContradiction,
  reviewScsFinish,
  shouldRequestScsReplan,
} from "../src/scs-controller.js";
import { buildScsEvidenceLedger, deriveScsTaskContract, evaluateScsEvidence } from "../src/scs-evidence.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role CLI smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role CLI smoke failed ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function runInteractive(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "chat"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "test-deepseek-key-not-real",
        VENICE_API_KEY: process.env.VENICE_API_KEY || "test-venice-key-not-real",
        AGINTIFLOW_NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role interactive smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role interactive smoke failed ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

const roles = getModelRoleDefaults();
assert(roles.route.provider === "deepseek", "route provider default should be deepseek");
assert(roles.route.model === "deepseek-v4-flash", "route model default should be deepseek-v4-flash");
assert(roles.main.model === "deepseek-v4-pro", "main model default should be deepseek-v4-pro");
assert(roles.spare.provider === "openai" && roles.spare.model === "gpt-5.4", "spare model default should be OpenAI GPT-5.4");
assert(roles.wrapper.provider === "codex" && roles.wrapper.model === "gpt-5.5", "wrapper default should be Codex GPT-5.5");
assert(roles.auxiliary.provider === "grsai" && roles.auxiliary.model === "nano-banana-2", "auxiliary default should be GRS AI Nano Banana");

const complexRoute = selectModelRoute({
  routingMode: "complex",
  provider: "deepseek",
  mainModel: "deepseek-v4-pro",
});
assert(complexRoute.model === "deepseek-v4-pro", "complex route did not use main model override");

const fastRoute = selectModelRoute({
  routingMode: "fast",
  provider: "deepseek",
  routeModel: "deepseek-v4-flash",
});
assert(fastRoute.model === "deepseek-v4-flash", "fast route did not use route model override");

assert(MODEL_PROVIDER_GROUPS["venice-gpt"].provider === "venice", "venice-gpt group missing");
assert(modelsForProviderGroup("venice").some((item) => item.id === "venice-uncensored-1-2"), "venice group missing Venice 1.2");
assert(modelsForProviderGroup("venice-gemma").some((item) => item.id === "google-gemma-4-31b-it"), "venice-gemma bucket missing Gemma 4 instruct");
assert(!modelsForProviderGroup("venice-gemma").some((item) => item.id === "gemma-4-uncensored"), "venice-gemma bucket should not include Gemma 4 Uncensored shortcut");
assert(modelsForProviderGroup("venice-gpt").some((item) => item.id === "openai-gpt-54-mini"), "venice-gpt bucket missing GPT-5.4 Mini");
assert(modelsForProviderGroup("venice-claude").some((item) => item.id === "claude-opus-4-7"), "venice-claude bucket missing Claude Opus 4.7");
assert(modelsForProviderGroup("venice-qwen").some((item) => item.id === "qwen3-coder-480b-a35b-instruct-turbo"), "venice-qwen bucket missing Qwen Coder");
assert(AUXILIARY_MODEL_CATALOG["venice-image"].some((item) => item.id === "gpt-image-2"), "Venice image catalog missing GPT Image 2");
assert(AUXILIARY_MODEL_CATALOG["venice-image"].some((item) => item.id === "wan-2-7-pro-edit"), "Venice image catalog missing Wan edit");
const routeChoices = modelRoleChoices("route").map((item) => `${item.provider}/${item.model}`);
const mainChoices = modelRoleChoices("main").map((item) => `${item.provider}/${item.model}`);
const spareChoices = modelRoleChoices("spare").map((item) => `${item.provider}/${item.model}`);
assert(JSON.stringify(routeChoices) === JSON.stringify(mainChoices), "route and main selectors should share the same text-model list");
assert(JSON.stringify(routeChoices) === JSON.stringify(spareChoices), "route and spare selectors should share the same text-model list");
for (const expected of [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "venice/venice-uncensored-1-2",
  "venice/venice-uncensored",
  "venice/gemma-4-uncensored",
  "venice/google-gemma-4-31b-it",
  "venice/google-gemma-4-26b-a4b-it",
  "venice/openai-gpt-55",
  "venice/openai-gpt-54-mini",
  "venice/claude-sonnet-4-6",
  "venice/claude-opus-4-7",
  "venice/qwen3-6-27b",
  "venice/qwen3-coder-480b-a35b-instruct-turbo",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
  "qwen/qwen-plus",
  "mock/mock-agent",
]) {
  assert(routeChoices.includes(expected), `shared model selector missing ${expected}`);
}
assert(!routeChoices.includes("venice/e2ee-venice-uncensored-24b-p"), "shared model selector should hide unstable E2EE Venice 1.1");
assert(modelRoleChoices("route").some((item) => item.provider === "openai" && item.model === "gpt-5.5" && item.reasoningOptions.includes("xhigh")), "OpenAI selector missing reasoning levels");
assert(modelRoleChoices("auxiliary").some((item) => item.provider === "grsai"), "auxiliary selector missing GRS AI");
assert(modelRoleChoices("auxiliary").some((item) => item.provider === "venice" && item.model === "wan-2-7-pro-edit"), "auxiliary selector missing Venice Wan edit");
const longAuxiliaryWindow = selectorVisibleWindow(32, 17, 24);
assert(longAuxiliaryWindow.end - longAuxiliaryWindow.start <= 8, "selector should cap visible rows for long option lists");
assert(longAuxiliaryWindow.topHidden > 0 && longAuxiliaryWindow.bottomHidden > 0, "selector should expose scroll indicators around middle selections");
const topAuxiliaryWindow = selectorVisibleWindow(32, 0, 24);
assert(topAuxiliaryWindow.start === 0 && topAuxiliaryWindow.bottomHidden > 0, "selector should keep first option visible at top of long lists");
const parsedTextToolCalls = parseTextToolCalls('[TOOL_CALLS]list_files[ARGS]call_123[ARGS]{"path":".","maxDepth":1}');
assert(parsedTextToolCalls.length === 1, "Venice text tool-call parser did not detect encoded tool call");
assert(parsedTextToolCalls[0].function.name === "list_files", "Venice text tool-call parser returned wrong tool name");
assert(parsedTextToolCalls[0].function.arguments.includes('"maxDepth":1'), "Venice text tool-call parser returned wrong arguments");
const looseTextToolCalls = parseTextToolCalls('[TOOL_CALLS]list_files[ARGS]{"path":"."}[TOOL_CALLS]inspect_project[ARGS]{"path":"."}');
assert(looseTextToolCalls.length === 2, "Venice loose text tool-call parser did not detect multiple calls");
assert(looseTextToolCalls[1].function.name === "inspect_project", "Venice loose text tool-call parser returned wrong second tool");
const nativeMarkerText = parseTextToolCalls('Done. <|tool_call>call:finish{result:<|"|>Done<|"|>}');
assert(nativeMarkerText.length === 0, "native marker text should not be treated as JSON text tool call");
const jsonBlockToolCalls = parseTextToolCalls('TOOL_CALLS:\n```json\n[{"name":"list_files","arguments":{"path":"/workspace"}}]\n```');
assert(jsonBlockToolCalls.length === 1, "Venice JSON text tool-call parser did not detect JSON block calls");
assert(jsonBlockToolCalls[0].function.arguments.includes("/workspace"), "Venice JSON text tool-call parser returned wrong arguments");
const requestedToolCalls = parseTextToolCalls(
  'Requested tools: write_file({"path":"story-ja.txt","content":"雨の夜、彼女は「また会える」と笑った。","mode":"create"})'
);
assert(requestedToolCalls.length === 1, "Requested tools parser did not detect function-call text");
assert(requestedToolCalls[0].function.name === "write_file", "Requested tools parser returned wrong tool name");
assert(requestedToolCalls[0].function.arguments.includes("story-ja.txt"), "Requested tools parser returned wrong arguments");
const multipleRequestedToolCalls = parseTextToolCalls(
  'Requested tools: list_files({"path":"."}); inspect_project({"path":".","maxDepth":2})'
);
assert(multipleRequestedToolCalls.length === 2, "Requested tools parser did not detect multiple function-call texts");
assert(multipleRequestedToolCalls[1].function.name === "inspect_project", "Requested tools parser returned wrong second requested tool");
const xmlTextToolCalls = parseTextToolCalls(
  '<tool_calls>\n<tool_call name="inspect_project">{"project_path":"/workspace"}</tool_call>\n<tool_call name="list_files">{"path":".","depth":2}</tool_call>\n</tool_calls>'
);
assert(xmlTextToolCalls.length === 2, "XML text tool-call parser did not detect multiple calls");
assert(xmlTextToolCalls[0].function.name === "inspect_project", "XML text tool-call parser returned wrong first tool");
assert(xmlTextToolCalls[1].function.arguments.includes('"depth":2'), "XML text tool-call parser returned wrong arguments");
const malformedRequestedToolResponse = normalizeTextToolCallResponse({
  choices: [
    {
      message: {
        role: "assistant",
        content: 'Requested tools: write_file({"path":"story.md","content":"unfinished',
      },
    },
  ],
});
const malformedMessage = malformedRequestedToolResponse.choices[0].message;
assert(malformedMessage.tool_calls?.[0]?.function?.name === "wait", "malformed requested tool text should trigger a safe retry tool");
assert(!malformedMessage.content.includes("write_file("), "malformed requested tool text should not be surfaced as assistant content");
const cleanedMalformedSuffix = normalizeTextToolCallResponse({
  choices: [
    {
      message: {
        role: "assistant",
        content: 'Here is a normal answer. Requested tools: write_file({"path":"story.md","content":"unfinished',
      },
    },
  ],
});
assert(
  cleanedMalformedSuffix.choices[0].message.content === "Here is a normal answer.",
  "malformed tool suffix should be stripped from otherwise usable assistant content"
);
assert(usesTextToolProtocol({ provider: "venice", model: "gemma-4-uncensored" }), "Venice Gemma should use text tool protocol");
assert(usesTextToolProtocol({ provider: "venice", model: "e2ee-venice-uncensored-24b-p" }), "Venice 1.1 should use text tool protocol");
assert(usesTextToolProtocol({ provider: "venice", model: "venice-uncensored" }), "Venice legacy 1.1 should use text tool protocol");
assert(!usesTextToolProtocol({ provider: "venice", model: "venice-uncensored-1-2" }), "Venice 1.2 should keep native tool calls first");
const scsInstruction = buildSupervisorInstruction({ plan: "Create one file.", acceptanceCriteria: ["File exists."] });
assert(scsInstruction.includes("Student-Committee-Supervisor"), "SCS supervisor instruction should define the acronym");
assert(!scsInstruction.includes("Syntax-Checker Sentinel"), "SCS supervisor instruction should not allow alternate acronym expansions");
assert(scsInstruction.includes("student is the independent validator"), "SCS supervisor instruction should define student as validator");
assert(shouldRequestScsReplan({ decision: "finish_rejected" }), "finish rejection should trigger committee replan");
assert(shouldRequestScsReplan({ decision: "rethink_plan" }), "student rethink should trigger committee replan");
assert(!shouldRequestScsReplan({ decision: "finish_allowed" }), "finish approval should not trigger committee replan");
const longStdout = [
  "=== Student-Committee-Supervisor present ===",
  "3:SCS stands for **Student-Committee-Supervisor**",
  "=== Syntax-Checker Sentinel absent ===",
  "OK: absent",
  "=== Residual content ===",
  "py_compile FOUND",
  "f-string FOUND",
  "artifact integrity FOUND",
].join("\n");
const scsEvidence = buildScsEvidencePack({
  goal: "verify SCS artifact",
  messages: [
    {
      role: "tool",
      content: JSON.stringify({ toolName: "run_command", ok: true, stdout: `${longStdout}\n${"x".repeat(700)}` }),
    },
  ],
});
assert(scsEvidence.includes("Student-Committee-Supervisor"), "SCS evidence pack should preserve raw verification stdout");
assert(scsEvidence.includes("Syntax-Checker Sentinel absent"), "SCS evidence pack should keep absence checks visible to the final gate");
assert(scsEvidence.includes("evidenceLedger"), "SCS evidence pack should include the structured evidence ledger");
assert(scsEvidence.includes("evaluation"), "SCS evidence pack should include deterministic contract evaluation");

const uploadContract = deriveScsTaskContract({
  goal:
    "Upload five images in the browser composer and verify visible thumbnails: /tmp/display.png /tmp/notebook.png /tmp/Trio.png. Do not submit.",
  taskProfile: "website",
});
assert(
  uploadContract.exactInputPaths.includes("/tmp/display.png") &&
    uploadContract.exactInputPaths.includes("/tmp/notebook.png") &&
    uploadContract.exactInputPaths.includes("/tmp/Trio.png"),
  "SCS contract should preserve exact input/reference paths for browser upload tasks"
);
const uploadImagePlanContradiction = deterministicPlanActionContradiction(
  "Find the latest .mp4 in the project, upload the video file, then click submit.",
  uploadContract
);
assert(
  /video-file upload/i.test(uploadImagePlanContradiction || ""),
  "SCS deterministic plan gate should reject invented video-file uploads for image-upload tasks"
);
assert(
  !deterministicPlanActionContradiction("Upload the five images, verify thumbnails, and do not submit.", uploadContract),
  "SCS deterministic plan gate should allow matching image-upload plans"
);
assert(uploadContract.requiresExternalEvidence, "browser upload contract should require external evidence");
assert(
  uploadContract.requiredEvidence.some((item) => item.category === "browser"),
  "browser upload contract should require browser evidence"
);
assert(
  uploadContract.requiredEvidence.some((item) => item.category === "visual"),
  "visible upload contract should require visual evidence"
);
assert(uploadContract.forbiddenActions.some((item) => /submit/i.test(item)), "contract should preserve forbidden submit action");

const weakUploadLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper set-file-input PAGE_ID display.png R1.jpg" },
          stdout: '{"ok":true,"nodeCount":1}',
        }),
      },
    ],
  },
});
const weakUploadEval = evaluateScsEvidence(uploadContract, weakUploadLedger);
assert(!weakUploadEval.ok, "set-file-input alone should not satisfy visible upload evidence");
assert(weakUploadEval.missing.some((item) => item.category === "visual"), "weak upload evidence should miss visual proof");

const strongUploadLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper upload-images-verify PAGE_ID display.png R1.jpg --screenshot outputs/upload.png" },
          stdout: '{"ok":true,"visibleEvidenceCount":5,"screenshot":"outputs/upload.png"}',
        }),
      },
    ],
  },
});
const strongUploadEval = evaluateScsEvidence(uploadContract, strongUploadLedger);
assert(strongUploadEval.ok, "visible upload verifier evidence should satisfy browser and visual contract");
const weakUploadFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "website" },
  {
    goal: uploadContract.outcome,
    messages: weakUploadLedger.items.map((item) => ({
      role: "tool",
      content: JSON.stringify({
        toolName: item.toolName || "run_command",
        ok: true,
        stdout: item.proof,
        args: { command: item.target || "" },
      }),
    })),
  },
  "Done, uploaded five images.",
  { goal: uploadContract.outcome, taskProfile: "website" }
);
assert(weakUploadFinish.decision === "finish_rejected", "SCS finish gate should reject upload claim without visual evidence");
assert(/visual|missing/i.test(weakUploadFinish.reason), "SCS finish rejection should name missing evidence");
const strongUploadFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "website" },
  {
    goal: uploadContract.outcome,
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper upload-images-verify PAGE_ID --screenshot outputs/upload.png" },
          stdout: '{"ok":true,"visibleEvidenceCount":5,"screenshot":"outputs/upload.png"}',
        }),
      },
    ],
  },
  "Done, verified five visible uploaded images.",
  { goal: uploadContract.outcome, taskProfile: "website" }
);
assert(strongUploadFinish.decision === "finish_allowed", "SCS finish gate should allow satisfied upload evidence");

const codeContract = deriveScsTaskContract({
  goal: "Fix the bug in src/app.js and run the test.",
  taskProfile: "code",
});
const explainCodeContract = deriveScsTaskContract({
  goal: "Explain JavaScript closures at a high level.",
  taskProfile: "code",
});
const noteFileContract = deriveScsTaskContract({
  goal: "Create notes/hello.md with a short smoke-test note.",
  taskProfile: "code",
});
const canvasArtifactContract = deriveScsTaskContract({
  goal: "Create a canvas artifact preview for this smoke test.",
});
const jsonObjectContract = deriveScsTaskContract({
  goal: "Extract a valid JSON object with schema from this text.",
});
const virtualFileContract = deriveScsTaskContract({
  goal: "Create file: /workspace/virtual-output.txt with virtual Docker path support.",
});
const outputListContract = deriveScsTaskContract({
  goal: [
    "Create:",
    "- `books/demo/work/generate_chunk.py`",
    "- `books/demo/work/review_chunks.py`",
    "",
    "Validate with `books/demo/work/validate_chunk.py` before promoting output.",
    "Do not treat `books/demo/work/existing_validator.py` as an output artifact.",
    "",
    "Output structure:",
    "- `build/demo/jp-main/color/book.pdf`",
    "- `build/demo/zh-main/color/book.pdf`",
    "",
    "Each generated chunk file goes to:",
    "`data/demo/chunks/{chunk_id}.json`",
  ].join("\n"),
  taskProfile: "code",
});
const manyOutputContract = deriveScsTaskContract({
  goal: [
    "Required outputs:",
    "- `out/a01.json`",
    "- `out/a02.json`",
    "- `out/a03.json`",
    "- `out/a04.json`",
    "- `out/a05.json`",
    "- `out/a06.json`",
    "- `out/a07.json`",
    "- `out/a08.json`",
    "- `out/a09.json`",
    "- `out/a10.json`",
    "- `out/a11.json`",
    "- `out/a12.json`",
  ].join("\n"),
  taskProfile: "code",
});
const generatedReviewContract = deriveScsTaskContract({
  goal: [
    "Review focus: changed files only",
    "Run a bounded, evidence-based code review of this workspace.",
    "Exclude generated, vendored, binary, cache, and large artifact paths.",
    "Final answer format: Findings first with file/line references.",
  ].join("\n"),
  taskProfile: "review",
});
assert(
  !explainCodeContract.requiresExternalEvidence,
  "code profile alone should not force external evidence for a pure explanation"
);
assert(
  noteFileContract.requiredEvidence.some((item) => item.category === "file") &&
    !noteFileContract.requiredEvidence.some((item) => item.category === "command"),
  "simple markdown note creation should require file evidence without an unrelated command check"
);
assert(
  canvasArtifactContract.requiredEvidence.some((item) => item.category === "artifact") &&
    !canvasArtifactContract.requiredEvidence.some((item) => item.category === "file") &&
    !canvasArtifactContract.requiredEvidence.some((item) => item.category === "visual"),
  "canvas artifact preview should require artifact evidence without unrelated file or screenshot evidence"
);
assert(
  !jsonObjectContract.requiredEvidence.some((item) => item.category === "file"),
  "JSON object extraction should not be treated as a workspace file requirement without an explicit file/path"
);
assert(
  virtualFileContract.requiredEvidence.some((item) => item.category === "file") &&
    !virtualFileContract.requiredEvidence.some((item) => item.category === "artifact"),
  "virtual output filename should require file evidence without treating output in the filename as an artifact"
);
assert(
  outputListContract.exactOutputPaths.includes("books/demo/work/generate_chunk.py") &&
    outputListContract.exactOutputPaths.includes("books/demo/work/review_chunks.py") &&
    outputListContract.exactOutputPaths.includes("build/demo/jp-main/color/book.pdf") &&
    outputListContract.exactOutputPaths.includes("build/demo/zh-main/color/book.pdf"),
  "SCS should infer exact outputs from Create/Output structure list sections"
);
assert(
  !outputListContract.exactOutputPaths.includes("books/demo/work/validate_chunk.py") &&
    !outputListContract.exactOutputPaths.includes("books/demo/work/existing_validator.py") &&
    !outputListContract.exactOutputPaths.some((item) => item.includes("{chunk_id}")),
  "SCS should not treat validator/tool paths or templated paths as exact output artifacts"
);
assert(
  manyOutputContract.exactOutputPaths.length === 12 && manyOutputContract.exactOutputPaths.includes("out/a12.json"),
  "SCS should preserve more than eight exact output paths for multi-artifact tasks"
);
assert(
  generatedReviewContract.requiredEvidence.some((item) => item.category === "command") &&
    !generatedReviewContract.requiredEvidence.some((item) => item.category === "file") &&
    !generatedReviewContract.requiredEvidence.some((item) => item.category === "artifact"),
  "review profile should not turn review-format boilerplate into file/artifact production requirements"
);
const fileOnlyLedger = buildScsEvidenceLedger({
  context: { events: [{ type: "file.changed", data: { path: "src/app.js" } }] },
});
const fileOnlyEval = evaluateScsEvidence(codeContract, fileOnlyLedger);
assert(!fileOnlyEval.ok, "code task should not finish from file evidence without check evidence");
assert(fileOnlyEval.missing.some((item) => item.category === "command"), "code task should require command/check evidence");
const checkedCodeEval = evaluateScsEvidence(
  codeContract,
  buildScsEvidenceLedger({
    context: { events: [{ type: "file.changed", data: { path: "src/app.js" } }] },
    state: {
      messages: [
        {
          role: "tool",
          content: JSON.stringify({ toolName: "run_command", ok: true, exitCode: 0, args: { command: "npm test" }, stdout: "ok" }),
        },
      ],
    },
  })
);
assert(checkedCodeEval.ok, "code task should finish when file and command evidence are both present");

const blockedFileFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "code" },
  {
    goal: "Create notes/safe.md with approval-gated content.",
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "write_file",
          ok: false,
          blocked: true,
          needsApproval: true,
          category: "workspace-write",
          reason: "Workspace write requires approval in safe mode.",
          permissionAdvice: { category: "workspace-write", reason: "Approve this workspace write." },
          args: { path: "notes/safe.md" },
        }),
      },
    ],
  },
  "Blocked by guardrail: this workspace write requires approval before creating notes/safe.md.",
  { goal: "Create notes/safe.md with approval-gated content.", taskProfile: "code" }
);
assert(blockedFileFinish.decision === "finish_allowed", "SCS final gate should allow a proven permission blocker report");

const output = await runCli(["models"]);
assert(output.includes("/route") && output.includes("/spare") && output.includes("venice-gpt"), "aginti models output missing role details");

const interactiveOutput = await runInteractive("/venice\n");
assert(interactiveOutput.includes("venice=on"), "/venice did not enable Venice roles");
assert(interactiveOutput.includes("route=venice/venice-uncensored-1-2"), "/venice did not set Venice route role");
assert(interactiveOutput.includes("main=venice/venice-uncensored-1-2"), "/venice did not set Venice main role");
const interactiveGemmaOutput = await runInteractive("/venice 1.1 gemma\n");
assert(interactiveGemmaOutput.includes("route=venice/venice-uncensored"), "/venice 1.1 did not set Venice 1.1 route role");
assert(interactiveGemmaOutput.includes("main=venice/gemma-4-uncensored"), "/venice gemma did not set Gemma 4 main role");
const interactiveOffOutput = await runInteractive("/venice off\n");
assert(interactiveOffOutput.includes("venice=off"), "/venice off did not restore DeepSeek roles");
assert(interactiveOffOutput.includes("route=deepseek/deepseek-v4-flash"), "/venice off did not restore DeepSeek route role");

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "role-defaults",
        "route-overrides",
        "provider-groups",
        "auxiliary-catalog",
        "selector-windowing",
        "shared-model-selectors",
        "venice-text-tool-parser",
        "requested-tools-parser",
        "malformed-text-tool-retry",
        "scs-supervisor-identity",
        "scs-student-validator-replan",
        "scs-evidence-stdout",
        "scs-contract-evidence-ledger",
        "cli-models-command",
        "venice-shortcut",
      ],
    },
    null,
    2
  )
);
