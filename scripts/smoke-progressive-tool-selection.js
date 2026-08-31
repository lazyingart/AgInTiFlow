#!/usr/bin/env node
import assertStrict from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_VALIDATION_TOOL_NAMES,
  DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
  LOCAL_COMPACT_CODE_TOOL_NAMES,
  LOCAL_COMPACT_GENERAL_TOOL_NAMES,
  LOCAL_TOOL_HARD_CAP,
  repositoryGroundingState,
  selectProgressiveTools,
  unreadProjectInstructionReadPaths,
} from "../src/progressive-tool-selection.js";
import { requestNextStep } from "../src/model-client.js";
import {
  buildConstrainedRecoveryRequest,
  buildModelTimeoutRetryMessages,
  completionContractGoal,
  completionTaskContract,
  deferUnavailableVerificationRerunUntilMutation,
  integrationTextWorkspaceToolExecutionBlock,
  nextStepRuntimeConfig,
  recoverFocusedPatchAlreadyAppliedAsExactNoop,
  recoverExactPendingCommandIntent,
  recoverFocusedPatchUniqueSubrangeAsExactPatch,
  recoverFocusedPatchTrailingWhitespaceAsExactPatch,
  recoverFocusedWholeFileWriteAsExactPatch,
  recoverGroundedPathlessPatchAsExactPatch,
  recoverRequiredPatchContextReadWithoutToolCall,
  recoverRequiredRepositoryGroundingToolCall,
  recoverStalemateDiscoveryAsExactVerification,
  recoverUnavailableVerificationRerunAsCanonicalRead,
  runAgent,
  taskForbidsExternalValidatorSourceRead,
  toolContractRepairMessage,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import {
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
} from "../src/integration-retained-text-workspace.js";
import {
  attachToolContract,
  createToolContract,
  resolveDispatchableToolCallBatch,
  safeSequentialToolBatchLimit,
  toolContractFromResponse,
  validateToolCallBatch,
} from "../src/tool-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tool(name, description = `${name} tool`) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: `Input for ${name}.` },
        },
        additionalProperties: false,
      },
    },
  };
}

function names(tools) {
  return tools.map((item) => item.function.name);
}

function sameNames(actual, expected, message) {
  assert(JSON.stringify(names(actual)) === JSON.stringify(expected), `${message}: ${names(actual).join(", ")}`);
}

const convergingCodeSurface = [
  tool("read_file"),
  tool("apply_patch"),
  tool("run_command"),
  tool("finish"),
];
const convergingCodeTools = selectProgressiveTools(convergingCodeSurface, {
  config: {
    provider: "localllm",
    taskProfile: "code",
    convergenceSuppressedToolNames: ["read_file"],
  },
  goal: "Repair the service implementation from retained source evidence.",
});
assert(
  !names(convergingCodeTools).includes("read_file"),
  "a convergence-blocked read tool was immediately re-offered to the local model"
);
assert(
  names(convergingCodeTools).includes("apply_patch") && names(convergingCodeTools).includes("finish"),
  "convergence suppression removed the productive mutation or finish path"
);

const completionMutationSurface = [
  tool("read_file"),
  tool("apply_patch"),
  tool("run_command"),
  tool("inspect_project"),
  tool("finish"),
];
const completionMutationReadTools = selectProgressiveTools(
  completionMutationSurface,
  {
    config: {
      completionFreshMutationRequired: true,
      completionFreshMutationNeedsSourceRead: true,
      completionFreshMutationPaths: ["service_ctl.py"],
    },
  }
);
sameNames(
  completionMutationReadTools,
  ["read_file"],
  "fresh completion repair exposed an escape path beyond one exact source read"
);
assertStrict.deepEqual(
  completionMutationReadTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "fresh completion repair did not bind its source read to the canonical path"
);
const completionMutationPatchTools = selectProgressiveTools(
  completionMutationSurface,
  {
    config: {
      completionFreshMutationRequired: true,
      completionFreshMutationNeedsSourceRead: false,
      completionFreshMutationPaths: ["service_ctl.py"],
    },
  }
);
sameNames(
  completionMutationPatchTools,
  ["apply_patch"],
  "grounded completion repair reopened read-only, test, Git, or finish tools before mutation"
);
assertStrict.deepEqual(
  completionMutationPatchTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "fresh completion repair did not bind its patch to the grounded canonical path"
);
assert(
  completionMutationPatchTools[0].function.parameters.required.includes("path"),
  "fresh completion repair did not require the grounded canonical path"
);
const mandatoryReadAfterSuppression = selectProgressiveTools(
  completionMutationSurface,
  {
    config: {
      completionFreshMutationRequired: true,
      completionFreshMutationNeedsSourceRead: true,
      completionFreshMutationPaths: ["service_ctl.py"],
      convergenceSuppressedToolNames: ["read_file"],
    },
  }
);
sameNames(
  mandatoryReadAfterSuppression,
  ["read_file"],
  "a generic convergence suppression hid a different exact mandatory source read"
);

const standardApplyPatchTool = {
  type: "function",
  function: {
    name: "apply_patch",
    description: "Apply a patch.",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string" },
        path: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" },
        expectedReplacements: { type: "integer" },
        baseHash: { type: "string" },
      },
      additionalProperties: false,
    },
  },
};
const boundedCommitTool = {
  type: "function",
  function: {
    name: "commit_project_changes",
    description: "Commit task-owned changes.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          minLength: 3,
          maxLength: 120,
          pattern: "^[^\\r\\n\\u0000]+$",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
};
const longCommitSubject =
  "Repair service controller lifecycle handling with portable subprocess sessions, complete CLI behavior, and focused regression coverage";
const recoveredCommitSubject = resolveDispatchableToolCallBatch(
  [contractCall("bounded-commit-subject", "commit_project_changes", {
    message: longCommitSubject,
  })],
  createToolContract([boundedCommitTool])
);
assert(
  recoveredCommitSubject.ok && recoveredCommitSubject.recoveredBoundedCommitSubject,
  "a factual overlong commit subject was not bounded before dispatch"
);
const boundedCommitArgs = JSON.parse(
  recoveredCommitSubject.acceptedToolCalls[0].function.arguments
);
assert(
  boundedCommitArgs.message.length >= 3 && boundedCommitArgs.message.length <= 120,
  "bounded commit-subject recovery violated the authenticated schema"
);
assert(
  longCommitSubject.startsWith(boundedCommitArgs.message),
  "bounded commit-subject recovery changed rather than shortened the factual subject"
);
const pathlessPatchRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-grounded-pathless-patch-")
);
try {
  const source = [
    "#!/usr/bin/env python3",
    "",
    "def stop_service() -> int:",
    "    return 0",
    "",
  ].join("\n");
  const sourcePath = path.join(pathlessPatchRoot, "service_ctl.py");
  await fs.writeFile(sourcePath, source, "utf8");
  const sourceHash = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  const mainReplacement = [
    "def main() -> None:",
    "    raise SystemExit(stop_service())",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
    "",
  ].join("\n");
  const pathlessCall = contractCall("grounded-pathless-patch", "apply_patch", {
    replace: mainReplacement,
    expectedReplacements: 1,
    baseHash: sourceHash,
  });
  const pathlessContract = createToolContract([standardApplyPatchTool]);
  const pathlessValidation = resolveDispatchableToolCallBatch(
    [pathlessCall],
    pathlessContract
  );
  assert(
    !pathlessValidation.ok && pathlessValidation.code === "TOOL_ARGUMENTS_SCHEMA_INVALID",
    "an incomplete apply_patch mode passed the authenticated tool contract"
  );
  const recoveredPathlessPatch = await recoverGroundedPathlessPatchAsExactPatch(
    { commandCwd: pathlessPatchRoot },
    {
      messages: [{
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "read_file",
          path: "service_ctl.py",
          sha256: sourceHash,
          contentTruncated: false,
          contentTruncatedByLines: false,
        }),
      }],
      meta: {},
    },
    [pathlessCall],
    pathlessContract,
    pathlessValidation
  );
  assert(recoveredPathlessPatch?.ok, "a revision-bound pathless declaration patch was not repaired");
  assertStrict.equal(
    recoveredPathlessPatch.recoveryMode,
    "append-declaration",
    "a missing declaration was not recovered as a bounded append"
  );
  const recoveredArgs = JSON.parse(
    recoveredPathlessPatch.acceptedToolCalls[0].function.arguments
  );
  assertStrict.equal(recoveredArgs.path, "service_ctl.py", "the repaired patch used the wrong file");
  assertStrict.equal(recoveredArgs.search, source, "the repaired append lost its revision-bound source");
  assert(
    recoveredArgs.replace.endsWith(mainReplacement),
    "the repaired append lost the provider-authored declaration"
  );
  assertStrict.equal(
    await recoverGroundedPathlessPatchAsExactPatch(
      { commandCwd: pathlessPatchRoot },
      {
        messages: [{
          role: "tool",
          content: JSON.stringify({
            ok: true,
            toolName: "read_file",
            path: "service_ctl.py",
            sha256: sourceHash,
            contentTruncated: false,
          }),
        }],
        meta: {},
      },
      [contractCall("reject-whole-file", "apply_patch", {
        replace: `${source}\ndef main() -> None:\n    pass\n`,
        baseHash: sourceHash,
      })],
      pathlessContract,
      pathlessValidation
    ),
    null,
    "a pathless whole-file rewrite was inferred from a grounded read"
  );
} finally {
  await fs.rm(pathlessPatchRoot, { recursive: true, force: true });
}
const completionMutationRecoveryRequest = buildConstrainedRecoveryRequest(
  {
    goal: "Repair service_ctl.py and verify it.",
    plan: "Repair the canonical source, then test it.",
    messages: [{ role: "user", content: "Repair service_ctl.py and verify it." }],
    meta: {
      goalContract: {
        revision: 2,
        currentRequest: "Repair service_ctl.py and verify it.",
        taskGoal: "Repair service_ctl.py and verify it.",
      },
      projectVerification: { mutationRevision: 4 },
    },
  },
  {
    provider: "localllm",
    model: "localllm-deep",
    goal: "Repair service_ctl.py and verify it.",
    contextWindowTokens: 32768,
  },
  {},
  3,
  {
    completionFreshMutationRequired: true,
    completionFreshMutationNeedsSourceRead: false,
    completionFreshMutationPaths: ["service_ctl.py"],
  }
);
assertStrict.equal(
  completionMutationRecoveryRequest?.mode,
  "fresh-source-mutation",
  "fresh completion repair did not receive a compact constrained model turn"
);
assertStrict.equal(
  completionMutationRecoveryRequest?.maxOutputTokens,
  8192,
  "fresh completion repair did not reserve enough bounded output for a substantive source patch"
);
const exactRecoverySource = [
  "from pathlib import Path",
  "",
  "def start_service(state_dir: Path) -> int:",
  "    return 0",
  "",
  "RECOVERY_SOURCE_TAIL = 'current-complete-source'",
].join("\n");
const completionMutationWithSource = buildConstrainedRecoveryRequest(
  {
    goal: "Repair service_ctl.py and verify it.",
    plan: "Repair the canonical source, then test it.",
    messages: [
      { role: "user", content: "Continue with this new request: Repair service_ctl.py and verify it." },
      {
        role: "assistant",
        content: "",
        tool_calls: [contractCall("current-source", "read_file", {
          path: "service_ctl.py",
          lineLimit: 500,
        })],
      },
      {
        role: "tool",
        tool_call_id: "current-source",
        content: JSON.stringify({
          ok: true,
          toolName: "read_file",
          path: "service_ctl.py",
          content: exactRecoverySource,
          sha256: "current-source-sha",
          lineCount: 6,
          contentTruncated: false,
          contentTruncatedByLines: false,
        }),
      },
    ],
    meta: {
      goalContract: {
        revision: 2,
        currentRequest: "Repair service_ctl.py and verify it.",
        taskGoal: "Repair service_ctl.py and verify it.",
      },
      projectVerification: { mutationRevision: 4 },
    },
  },
  {
    provider: "localllm",
    model: "localllm-fast",
    goal: "Repair service_ctl.py and verify it.",
    contextWindowTokens: 32768,
  },
  {},
  4,
  {
    completionFreshMutationRequired: true,
    completionFreshMutationNeedsSourceRead: false,
    completionFreshMutationPaths: ["service_ctl.py"],
  }
);
assert(
  completionMutationWithSource?.messages.some((message) =>
    String(message.content || "").includes("RECOVERY_SOURCE_TAIL = 'current-complete-source'")
  ),
  "fresh-source compaction discarded the complete current source immediately after reading it"
);
assert(
  /path-bounded apply_patch tool now/i.test(
    JSON.stringify(completionMutationRecoveryRequest?.messages || [])
  ),
  "fresh completion repair request did not instruct the model to mutate canonical source"
);

const mutationGatedToolRepair = toolContractRepairMessage({
  code: "TOOL_NOT_OFFERED",
  offeredTools: ["read_file", "search_files", "apply_patch", "finish"],
  requestedCalls: [{ name: "run_command", path: "" }],
  recoveryContext: {
    failedTestCommand: "python3 external_contract.py",
    failedTestSummary: "AssertionError: SECURITY.md lacks residual coverage",
    canonicalRepairPaths: ["SECURITY.md"],
    requiredSymbolContracts: [
      { owner: "service_ctl", symbol: "launch_service" },
      { owner: "service_ctl", symbol: "wait_until_healthy" },
    ],
    topologyViolations: [
      "launch_service: declared once but not called from production code outside its own definition",
    ],
    candidateTopologyCounts: [
      {
        owner: "service_ctl",
        symbol: "launch_service",
        count: 0,
        minimumOccurrences: 2,
      },
      {
        owner: "service_ctl",
        symbol: "wait_until_healthy",
        count: 0,
        minimumOccurrences: 2,
      },
    ],
  },
  errors: [],
});
assert(
  mutationGatedToolRepair.includes("already failed and is intentionally unavailable"),
  "mutation-gated tool recovery did not explain why verification is unavailable"
);
assert(
  mutationGatedToolRepair.includes(
    "Acceptance seam contract: service_ctl.launch_service, service_ctl.wait_until_healthy"
  ) &&
    mutationGatedToolRepair.includes("declared once but not called") &&
    mutationGatedToolRepair.includes("service_ctl.launch_service=0, requires at least 2"),
  "tool-contract recovery dropped the retained required-seam topology"
);

const canonicalReadDescriptor = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read one workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};
const failedVerifierCommand = "python3 external_contract.py";
const recoveredVerifierRerun = recoverUnavailableVerificationRerunAsCanonicalRead(
  { commandCwd: "/tmp/security-project" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        testRuns: [
          {
            mutationRevision: 2,
            passed: false,
            command: failedVerifierCommand,
            failureSummary:
              "AssertionError: SECURITY.md lacks residual coverage",
          },
        ],
      },
      failedTestRecoveryPacket: {
        paths: ["labshare.py", "tests/test_labshare.py", "SECURITY.md"],
      },
    },
  },
  [
    contractCall("repeat-verifier", "run_command", {
      command: `cd /tmp/security-project && ${failedVerifierCommand}`,
    }),
  ],
  createToolContract([canonicalReadDescriptor]),
  {
    ok: false,
    errors: [{ code: "TOOL_NOT_OFFERED" }],
  }
);
assert(
  recoveredVerifierRerun?.recoveredUnavailableVerificationRerun === true,
  "an unavailable exact verifier rerun with an explicit current-workspace cd was not translated into a canonical evidence read"
);
assert(
  JSON.parse(
    recoveredVerifierRerun.acceptedToolCalls[0].function.arguments
  ).path === "SECURITY.md",
  "verifier-rerun recovery did not select the canonical file named by failure evidence"
);
assert(
  mutationGatedToolRepair.includes("SECURITY.md lacks residual coverage"),
  "mutation-gated tool recovery omitted the retained failure evidence"
);
assert(
  mutationGatedToolRepair.includes("Do not request run_command"),
  "mutation-gated tool recovery still invites the unavailable verification tool"
);
const deferredVerifierRerun = deferUnavailableVerificationRerunUntilMutation(
  {
    commandCwd: "/tmp/security-project",
    testFailureRepairMutationRequired: true,
  },
  {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        testRuns: [{
          mutationRevision: 2,
          passed: false,
          command: failedVerifierCommand,
          failureSignature: "security-failure",
        }],
      },
    },
  },
  [
    contractCall("defer-verifier", "run_command", {
      command: `cd /tmp/security-project && ${failedVerifierCommand}`,
    }),
  ],
  createToolContract([tool("apply_patch"), tool("finish")]),
  {
    ok: false,
    errors: [{ code: "TOOL_NOT_OFFERED" }],
  }
);
assertStrict.equal(
  deferredVerifierRerun?.code,
  "VERIFICATION_DEFERRED_UNTIL_MUTATION",
  "an exact verifier request was not boundedly deferred after all evidence reads closed"
);
assertStrict.equal(
  deferUnavailableVerificationRerunUntilMutation(
    {
      commandCwd: "/tmp/security-project",
      testFailureRepairMutationRequired: false,
    },
    {
      meta: {
        projectVerification: {
          mutationRevision: 2,
          testRuns: [{
            mutationRevision: 2,
            passed: false,
            command: failedVerifierCommand,
          }],
        },
      },
    },
    [contractCall("do-not-defer", "run_command", { command: failedVerifierCommand })],
    createToolContract([tool("apply_patch"), tool("finish")]),
    { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
  ),
  null,
  "verification was deferred even though the runtime had not established mutation-first recovery"
);

const exactStalemateCommand = "python3 -m unittest discover -s tests -v";
const exactStalemateRunDescriptor = {
  type: "function",
  function: {
    name: "run_command",
    description: "Run the one retained verifier.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: [exactStalemateCommand] },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};
const recoveredStalemateVerification = recoverStalemateDiscoveryAsExactVerification(
  {
    testFailureStalemateRevalidation: true,
    testFailureStalemateCommand: exactStalemateCommand,
  },
  [contractCall("stale-discovery", "inspect_project", {})],
  createToolContract([exactStalemateRunDescriptor, tool("finish")]),
  { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
);
assertStrict.equal(
  recoveredStalemateVerification?.recoveredStalemateVerification,
  true,
  "a benign discovery request did not consume the one exact stale-evidence verifier"
);
assertStrict.deepEqual(
  JSON.parse(
    recoveredStalemateVerification.acceptedToolCalls[0].function.arguments
  ),
  { command: exactStalemateCommand },
  "stale-evidence recovery did not preserve the contract's exact verifier"
);
assertStrict.equal(
  recoverStalemateDiscoveryAsExactVerification(
    {
      testFailureStalemateRevalidation: true,
      testFailureStalemateCommand: exactStalemateCommand,
    },
    [contractCall("unsafe-stale-intent", "apply_patch", {})],
    createToolContract([exactStalemateRunDescriptor, tool("finish")]),
    { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
  ),
  null,
  "a mutation request was incorrectly translated into stale-evidence verification"
);
assertStrict.equal(
  recoverStalemateDiscoveryAsExactVerification(
    {
      testFailureStalemateRevalidation: true,
      testFailureStalemateCommand: exactStalemateCommand,
    },
    [contractCall("ambiguous-stale-intent", "read_file", { path: "service_ctl.py" })],
    createToolContract([
      {
        ...exactStalemateRunDescriptor,
        function: {
          ...exactStalemateRunDescriptor.function,
          parameters: {
            ...exactStalemateRunDescriptor.function.parameters,
            properties: {
              command: {
                type: "string",
                enum: [exactStalemateCommand, "python3 -m pytest"],
              },
            },
          },
        },
      },
      tool("finish"),
    ]),
    { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
  ),
  null,
  "an ambiguous verifier surface was incorrectly auto-translated"
);

const mandatoryRefreshPath = "service_ctl.py";
const mandatoryRefreshReadDescriptor = {
  ...canonicalReadDescriptor,
  function: {
    ...canonicalReadDescriptor.function,
    parameters: {
      ...canonicalReadDescriptor.function.parameters,
      properties: {
        path: { type: "string", enum: [mandatoryRefreshPath] },
      },
    },
  },
};
const recoveredMandatoryRefreshRead = recoverRequiredPatchContextReadWithoutToolCall(
  {
    patchContextRefreshRequired: true,
    patchContextRefreshPath: mandatoryRefreshPath,
  },
  [],
  createToolContract([mandatoryRefreshReadDescriptor, tool("finish")]),
  { ok: true, calls: [], acceptedToolCalls: [], deferredToolCalls: [] }
);
assertStrict.equal(
  recoveredMandatoryRefreshRead?.recoveredRequiredPatchContextRead,
  true,
  "a missing call on a mandatory exact patch-context read was not recovered"
);
assertStrict.deepEqual(
  JSON.parse(
    recoveredMandatoryRefreshRead.acceptedToolCalls[0].function.arguments
  ),
  { path: mandatoryRefreshPath },
  "mandatory patch-context recovery did not preserve the exact constrained path"
);
const recoveredPrematureRefreshFinish = recoverRequiredPatchContextReadWithoutToolCall(
  {
    patchContextRefreshRequired: true,
    patchContextRefreshPath: mandatoryRefreshPath,
  },
  [contractCall("premature-refresh-finish", "finish", { result: "already fixed" })],
  createToolContract([mandatoryRefreshReadDescriptor]),
  { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
);
assertStrict.equal(
  recoveredPrematureRefreshFinish?.recoveredRequiredPatchContextRead,
  true,
  "a premature finish claim bypassed the mandatory exact patch-context read"
);
const mandatoryRefreshContract = createToolContract([
  mandatoryRefreshReadDescriptor,
  tool("finish"),
]);
const rangedMandatoryReadCall = contractCall(
  "ranged-mandatory-read",
  "read_file",
  { path: mandatoryRefreshPath, startLine: 100, lineLimit: 60 }
);
const rangedMandatoryReadValidation = resolveDispatchableToolCallBatch(
  [rangedMandatoryReadCall],
  mandatoryRefreshContract
);
assertStrict.equal(
  rangedMandatoryReadValidation.ok,
  false,
  "the regression fixture no longer reproduces strict exact-read range rejection"
);
const recoveredRangedMandatoryRead = recoverRequiredPatchContextReadWithoutToolCall(
  {
    patchContextRefreshRequired: true,
    patchContextRefreshPath: mandatoryRefreshPath,
  },
  [rangedMandatoryReadCall],
  mandatoryRefreshContract,
  rangedMandatoryReadValidation
);
assertStrict.equal(
  recoveredRangedMandatoryRead?.normalizedInvalidExactRead,
  true,
  "an exact mandatory reread with harmless range hints was not canonicalized"
);
assertStrict.deepEqual(
  JSON.parse(recoveredRangedMandatoryRead.acceptedToolCalls[0].function.arguments),
  { path: mandatoryRefreshPath },
  "canonical mandatory reread retained provider-supplied range arguments"
);
assertStrict.equal(
  recoverRequiredPatchContextReadWithoutToolCall(
    {
      patchContextRefreshRequired: false,
      patchContextRefreshPath: mandatoryRefreshPath,
    },
    [],
    createToolContract([mandatoryRefreshReadDescriptor, tool("finish")]),
    { ok: true, calls: [], acceptedToolCalls: [], deferredToolCalls: [] }
  ),
  null,
  "an ordinary no-tool response was incorrectly converted into a source read"
);
const recoveredRepairReread = recoverRequiredPatchContextReadWithoutToolCall(
  {
    patchContextRepairRequired: true,
    patchContextRepairPath: mandatoryRefreshPath,
    patchContextRepairReadCount: 0,
    patchContextRepairRereadAllowed: true,
  },
  [contractCall("premature-repair-command", "run_command", { command: "python3 smoke.py" })],
  createToolContract([tool("apply_patch"), mandatoryRefreshReadDescriptor, tool("finish")]),
  { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
);
assertStrict.equal(
  recoveredRepairReread?.recoveredRequiredPatchContextRead,
  true,
  "an unavailable command during bounded repair was not translated to the exact reread"
);
assertStrict.equal(
  recoveredRepairReread?.originalToolName,
  "run_command",
  "bounded repair reread recovery lost the rejected intent evidence"
);
const failedTestContextPaths = ["service_ctl.py", "tests/test_service_lifecycle.py"];
const failedTestContextReadDescriptor = {
  ...canonicalReadDescriptor,
  function: {
    ...canonicalReadDescriptor.function,
    parameters: {
      ...canonicalReadDescriptor.function.parameters,
      properties: {
        path: { type: "string", enum: failedTestContextPaths },
      },
    },
  },
};
const failedTestContextContract = createToolContract([
  failedTestContextReadDescriptor,
  tool("apply_patch"),
  tool("finish"),
]);
const invalidFailedTestContextCalls = [
  contractCall("unbounded-source-read", "read_file", { path: "gateway_service.py" }),
  contractCall("unbounded-test-read", "read_file", { path: "tests/test_service_ctl.py" }),
];
const invalidFailedTestContextValidation = resolveDispatchableToolCallBatch(
  invalidFailedTestContextCalls,
  failedTestContextContract
);
const recoveredFailedTestContextRead = recoverRequiredPatchContextReadWithoutToolCall(
  {
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairNeedsPatchContext: true,
    testFailureRepairContextPaths: failedTestContextPaths,
  },
  invalidFailedTestContextCalls,
  failedTestContextContract,
  invalidFailedTestContextValidation
);
assertStrict.equal(
  recoveredFailedTestContextRead?.recoveredRequiredPatchContextRead,
  true,
  "invalid failed-test discovery paths were not translated to bounded retained evidence"
);
assertStrict.deepEqual(
  JSON.parse(recoveredFailedTestContextRead.acceptedToolCalls[0].function.arguments),
  { path: "service_ctl.py" },
  "failed-test context recovery did not choose the first authoritative unread path"
);
const generatedDiagnosticPath = "artifacts/manifest.json";
const generatedDiagnosticReadDescriptor = {
  ...canonicalReadDescriptor,
  function: {
    ...canonicalReadDescriptor.function,
    parameters: {
      ...canonicalReadDescriptor.function.parameters,
      properties: {
        path: { type: "string", enum: [generatedDiagnosticPath] },
      },
    },
  },
};
const generatedDiagnosticContract = createToolContract([
  generatedDiagnosticReadDescriptor,
  tool("apply_patch"),
  tool("finish"),
]);
const staleSourceReadCall = contractCall(
  "stale-source-instead-of-generated-diagnostic",
  "read_file",
  { path: "build_cad.py", startLine: 1, lineLimit: 120 }
);
const staleInputReadCall = contractCall(
  "stale-input-instead-of-generated-diagnostic",
  "read_file",
  { path: "inputs/tube_measurements.csv" }
);
const staleSourceReadValidation = resolveDispatchableToolCallBatch(
  [staleSourceReadCall, staleInputReadCall],
  generatedDiagnosticContract
);
const recoveredGeneratedDiagnosticRead =
  recoverRequiredPatchContextReadWithoutToolCall(
    {
      testFailureRepairActive: true,
      testFailureRepairMutationRequired: true,
      testFailureWorkspaceDiagnosticReadPaths: [generatedDiagnosticPath],
    },
    [staleSourceReadCall, staleInputReadCall],
    generatedDiagnosticContract,
    staleSourceReadValidation
  );
assertStrict.equal(
  recoveredGeneratedDiagnosticRead?.recoveredRequiredPatchContextRead,
  true,
  "a stale canonical-source reread was not translated to exact generated diagnostic evidence"
);
assertStrict.deepEqual(
  JSON.parse(
    recoveredGeneratedDiagnosticRead.acceptedToolCalls[0].function.arguments
  ),
  { path: generatedDiagnosticPath },
  "generated diagnostic recovery broadened or changed the exact allowed artifact path"
);
assertStrict.equal(
  recoveredGeneratedDiagnosticRead.source,
  "failed-test-generated-diagnostic-read",
  "generated diagnostic intent recovery lost its auditable source label"
);
const generatedDiagnosticWithCanonicalProducerTools = selectProgressiveTools(
  [canonicalReadDescriptor, tool("apply_patch"), tool("finish")],
  {
    config: {
      testFailureRepairActive: true,
      testFailureRepairMutationRequired: true,
      testFailureWorkspaceDiagnosticReadPaths: [generatedDiagnosticPath],
      testFailureCanonicalRepairPaths: ["build_cad.py"],
      commandCwd: "/tmp/aginti-generated-diagnostic-fixture",
    },
  }
);
const generatedDiagnosticWithCanonicalProducerRead =
  generatedDiagnosticWithCanonicalProducerTools.find(
    (descriptor) => descriptor.function.name === "read_file"
  );
const generatedDiagnosticWithCanonicalProducerPaths =
  generatedDiagnosticWithCanonicalProducerRead?.function?.parameters?.properties?.path?.enum || [];
assert(
  generatedDiagnosticWithCanonicalProducerPaths.includes(generatedDiagnosticPath) &&
    generatedDiagnosticWithCanonicalProducerPaths.includes("build_cad.py") &&
    generatedDiagnosticWithCanonicalProducerPaths.includes(
      "/tmp/aginti-generated-diagnostic-fixture/build_cad.py"
    ),
  "failed-test diagnostic mode did not retain relative and absolute aliases for the canonical producer"
);
const mixedRefreshAndDiagnosticContract = createToolContract([
  {
    ...canonicalReadDescriptor,
    function: {
      ...canonicalReadDescriptor.function,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["build_cad.py"] },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
]);
const rangedMandatoryRefreshCall = contractCall(
  "ranged-mandatory-refresh-with-diagnostic-pending",
  "read_file",
  { path: "build_cad.py", startLine: 270, lineLimit: 40 }
);
const rangedMandatoryRefreshValidation = resolveDispatchableToolCallBatch(
  [rangedMandatoryRefreshCall],
  mixedRefreshAndDiagnosticContract
);
const recoveredMixedMandatoryRefresh = recoverRequiredPatchContextReadWithoutToolCall(
  {
    patchContextRefreshRequired: true,
    patchContextRefreshPath: "build_cad.py",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureWorkspaceDiagnosticReadPaths: [generatedDiagnosticPath],
  },
  [rangedMandatoryRefreshCall],
  mixedRefreshAndDiagnosticContract,
  rangedMandatoryRefreshValidation
);
assertStrict.deepEqual(
  JSON.parse(recoveredMixedMandatoryRefresh.acceptedToolCalls[0].function.arguments),
  { path: "build_cad.py" },
  "a pending generated diagnostic displaced the mandatory exact source refresh"
);
assertStrict.equal(
  recoveredMixedMandatoryRefresh.source,
  "mandatory-refresh-read",
  "mixed-state source refresh lost its mandatory recovery label"
);

const recoveredMandatoryInspect = recoverRequiredRepositoryGroundingToolCall(
  { repositoryGroundingRequired: true },
  [contractCall("premature-smoke", "run_command", { command: "python3 smoke.py" })],
  createToolContract([tool("inspect_project"), tool("finish")]),
  { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
);

const compactedGroundingMessages = [
  {
    role: "user",
    content: [
      "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
      "Tool: inspect_project",
      "Arguments: {}",
      'Verified result: {"ok":true,"manifestFiles":[{"path":"AGENTS.md"}],"recommendedReads":["AGENTS.md"],"topLevel":[{"path":"AGENTS.md","type":"file"}]}',
    ].join("\n"),
  },
];
assertStrict.deepEqual(
  repositoryGroundingState(compactedGroundingMessages),
  { phase: "read-instructions", paths: ["AGENTS.md"] },
  "compacted inspect_project evidence was discarded and repository grounding restarted",
);
const compactedGroundingReadyMessages = [
  ...compactedGroundingMessages,
  {
    role: "user",
    content: [
      "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
      "Tool: read_file",
      'Arguments: {"path":"AGENTS.md"}',
      'Verified result: {"ok":true,"path":"AGENTS.md","content":"instructions"}',
    ].join("\n"),
  },
];
assertStrict.deepEqual(
  repositoryGroundingState(compactedGroundingReadyMessages),
  { phase: "ready", paths: [] },
  "compacted read_file evidence did not complete repository grounding",
);
assertStrict.equal(
  recoveredMandatoryInspect?.recoveredRequiredRepositoryGrounding,
  true,
  "an unavailable command did not advance the mandatory repository inspection"
);
assertStrict.deepEqual(
  JSON.parse(recoveredMandatoryInspect.acceptedToolCalls[0].function.arguments),
  {},
  "mandatory repository inspection recovery invented arguments"
);
const groundedReadDescriptor = {
  ...canonicalReadDescriptor,
  function: {
    ...canonicalReadDescriptor.function,
    parameters: {
      ...canonicalReadDescriptor.function.parameters,
      properties: {
        path: { type: "string", enum: ["README.md", "service_ctl.py"] },
      },
    },
  },
};
const recoveredMandatoryGroundingRead = recoverRequiredRepositoryGroundingToolCall(
  { repositoryGroundingRequired: true },
  [contractCall("premature-scratch", "run_command", { command: "mkdir -p /tmp/check" })],
  createToolContract([groundedReadDescriptor, tool("finish")]),
  { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
);
assertStrict.deepEqual(
  JSON.parse(
    recoveredMandatoryGroundingRead.acceptedToolCalls[0].function.arguments
  ),
  { path: "README.md" },
  "mandatory repository grounding did not select the first constrained evidence path"
);
assertStrict.equal(
  recoverRequiredRepositoryGroundingToolCall(
    { repositoryGroundingRequired: true },
    [contractCall("scoped-list-intent", "list_files", { path: "output/task-1" })],
    createToolContract([groundedReadDescriptor, tool("finish")]),
    { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
  ),
  null,
  "a scope-bearing list_files request was redirected into an unrelated read_file"
);
assertStrict.equal(
  recoverRequiredRepositoryGroundingToolCall(
    { repositoryGroundingRequired: false },
    [contractCall("ordinary-command", "run_command", { command: "python3 smoke.py" })],
    createToolContract([groundedReadDescriptor, tool("finish")]),
    { ok: false, errors: [{ code: "TOOL_NOT_OFFERED" }] }
  ),
  null,
  "ordinary progressive selection rewrote an unavailable tool as repository grounding"
);

async function captureRequestTools(overrides = {}) {
  let payload = null;
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          payload = request;
          return { choices: [{ message: { role: "assistant", content: "done", tool_calls: [] } }] };
        },
      },
    },
  };
  const response = await requestNextStep(
    client,
    {
      provider: "localllm",
      model: "localllm-fast",
      baseURL: "http://127.0.0.1:8008/v1",
      apiKey: "local-dev-key",
      goal: "Exercise the complete local tool schema.",
      taskProfile: "general",
      toolSurfacePolicy: "full",
      allowShellTool: false,
      allowFileTools: true,
      allowWebSearch: true,
      allowMcpTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowHostedImagePerception: false,
      allowHostedWebResearch: false,
      allowHostedJsonSpecialist: false,
      allowHostedWritingSpecialist: false,
      modelTimeoutMs: 0,
      ...overrides,
    },
    [{ role: "user", content: "Exercise the complete local tool schema." }]
  );
  const selected = payload?.tools || [];
  const contract = toolContractFromResponse(response);
  assert(contract, "requestNextStep did not preserve its per-turn tool contract");
  assertStrict.deepEqual(contract.tools, selected, "response tool contract diverged from the exact descriptors sent to the model");
  return selected;
}

function enumFor(tools, toolName, property) {
  const descriptor = tools.find((item) => item.function?.name === toolName);
  return descriptor?.function?.parameters?.properties?.[property]?.enum || [];
}

const knownNames = [
  "open_url",
  "json_specialist",
  "json_specialist_batch",
  "click",
  "type",
  "scroll",
  "press",
  "back",
  "wait",
  "writing_specialist",
  "web_search",
  "read_web_page",
  "web_research",
  "deep_research",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_call_tool",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_create_board",
  "agentlink_get_board",
  "agentlink_send_message",
  "agentlink_claim_task",
  "agentlink_attach_evidence",
  "agentlink_summarize_session",
  "read_image",
  "open_workspace_file",
  "preview_workspace",
  "start_long_job",
  "long_job_status",
  "tmux_list_sessions",
  "tmux_capture_pane",
  "tmux_send_keys",
  "tmux_start_session",
  "run_command",
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "delegate_agent",
  "research_wrapper",
  "generate_image",
  "send_to_canvas",
  "custom_hosted_tool",
  "finish",
];
const allTools = knownNames.map((name) => tool(name));

const codeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Implement the bug fix and run tests.",
  profile: "code",
});
sameNames(codeTools, LOCAL_COMPACT_CODE_TOOL_NAMES, "code profile did not select the canonical compact set");

const convergenceTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", convergenceOutputPhase: true },
  goal: "Inspect the established routines, then write the requested readiness report.",
  profile: "code",
});
assert(names(convergenceTools).includes("write_file"), "convergence phase omitted write_file");
assert(names(convergenceTools).includes("apply_patch"), "convergence phase omitted apply_patch");
assert(names(convergenceTools).includes("finish"), "convergence phase omitted finish");
assert(
  !names(convergenceTools).some((name) => ["inspect_project", "list_files", "read_file", "search_files", "read_image", "run_command"].includes(name)),
  "convergence phase still exposed bounded-out discovery tools"
);
const convergenceCheckTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    convergenceOutputPhase: true,
    convergenceAllowRunCommand: true,
  },
  goal: "Run the required source-derived doctor checks, then write the readiness report.",
  profile: "code",
});
assert(names(convergenceCheckTools).includes("run_command"), "convergence hid a task-required bounded command check");
assert(!names(convergenceCheckTools).includes("read_file"), "convergence check mode reopened broad file discovery");

const artifactValidationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", artifactValidationPhase: true },
  goal: "The exact report exists. Validate it once, then finish.",
  profile: "code",
});
sameNames(
  artifactValidationTools,
  ARTIFACT_VALIDATION_TOOL_NAMES,
  "artifact validation phase did not expose the exact validate-correct-deliver-finish surface"
);
assert(!names(artifactValidationTools).includes("search_files"), "artifact validation phase reopened broad search");
assert(!names(artifactValidationTools).includes("open_url"), "artifact validation phase reopened browser discovery");

const localFailureRecoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover from repeated failed edits without restarting the task.",
  profile: "code",
  messages: [
    { role: "assistant", tool_calls: [{ id: "failed-edit", function: { name: "apply_patch", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "failed-edit", content: '{"ok":false}' },
  ],
});
sameNames(
  localFailureRecoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "local failure recovery did not restore the bounded repair surface"
);

const dataDiscoveryStarterTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
});
sameNames(
  dataDiscoveryStarterTools,
  ["inspect_project", "finish"],
  "local data task exposed mutation tools before project inspection"
);

const dataInspectionMessages = [
  { role: "user", content: "Goal: Clean these experiment exports and leave a reproducible analysis." },
  {
    role: "assistant",
    tool_calls: [{ id: "data-inspect", function: { name: "inspect_project", arguments: '{"path":"."}' } }],
  },
  {
    role: "tool",
    tool_call_id: "data-inspect",
    content: JSON.stringify({
      ok: true,
      recommendedReads: ["README.md", "tests/test_analysis.py"],
      manifestFiles: [{ path: "README.md" }],
      testFiles: [{ path: "tests/test_analysis.py" }],
      topLevel: [
        { path: "analysis.py", type: "file" },
        { path: "TASK.md", type: "file" },
      ],
    }),
  },
];
const dataContextTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataInspectionMessages,
});
sameNames(
  dataContextTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading project contracts"
);
assertStrict.deepEqual(
  enumFor(dataContextTools, "read_file", "path"),
  ["README.md"],
  "local data instruction phase did not constrain read_file to discovered instruction paths"
);

const dataImplementationMessages = [
  ...dataInspectionMessages,
  {
    role: "assistant",
    tool_calls: [{ id: "data-readme", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
  },
  { role: "tool", tool_call_id: "data-readme", content: '{"ok":true,"path":"README.md"}' },
];
const dataImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataImplementationMessages,
});
sameNames(
  dataImplementationTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading an analyzer/config/test surface"
);
assertStrict.deepEqual(
  enumFor(dataImplementationTools, "read_file", "path"),
  ["analysis.py"],
  "local data context phase did not constrain read_file to discovered analysis paths"
);

const dataTestDiscoveryMessages = [
  ...dataImplementationMessages,
  {
    role: "assistant",
    tool_calls: [
      { id: "data-analysis", function: { name: "read_file", arguments: '{"path":"analysis.py"}' } },
    ],
  },
  { role: "tool", tool_call_id: "data-analysis", content: '{"ok":true,"path":"analysis.py"}' },
];
const dataTestDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataTestDiscoveryMessages,
});
sameNames(
  dataTestDiscoveryTools,
  ["read_file", "finish"],
  "local data task exposed mutation tools before reading a discovered test"
);
assertStrict.deepEqual(
  enumFor(dataTestDiscoveryTools, "read_file", "path"),
  ["tests/test_analysis.py"],
  "local data test phase did not constrain read_file to discovered tests"
);

const timeoutError = new Error("agent step request timed out after 300000ms");
timeoutError.name = "ModelTimeoutError";
const compactedDataTestMessages = buildModelTimeoutRetryMessages(
  {
    goal: "Clean these experiment exports and leave a reproducible analysis.",
    plan: "",
    messages: dataTestDiscoveryMessages,
    meta: {},
  },
  {
    taskProfile: "data",
    sandboxMode: "host",
    packageInstallPolicy: "block",
    commandCwd: repoRoot,
    maxSteps: 30,
  },
  { title: "No browser page open", url: "" },
  4,
  timeoutError
);
const compactedDataTestTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: compactedDataTestMessages,
});
sameNames(
  compactedDataTestTools,
  ["read_file", "finish"],
  "timeout compaction discarded completed data discovery state"
);
assertStrict.deepEqual(
  enumFor(compactedDataTestTools, "read_file", "path"),
  ["tests/test_analysis.py"],
  "timeout compaction did not resume at the next exact discovered test"
);

const dataReadyMessages = [
  ...dataTestDiscoveryMessages,
  {
    role: "assistant",
    tool_calls: [
      { id: "data-test", function: { name: "read_file", arguments: '{"path":"tests/test_analysis.py"}' } },
    ],
  },
  { role: "tool", tool_call_id: "data-test", content: '{"ok":true,"path":"tests/test_analysis.py"}' },
];
const dataReadyTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Clean these experiment exports and leave a reproducible analysis.",
  profile: "data",
  messages: dataReadyMessages,
});
sameNames(dataReadyTools, LOCAL_COMPACT_CODE_TOOL_NAMES, "local data task did not unlock after bounded discovery");

const dataRecoveryBeforeDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover this data task after a failed mutation.",
  profile: "data",
});
sameNames(
  dataRecoveryBeforeDiscoveryTools,
  ["inspect_project", "finish"],
  "local recovery bypassed the incomplete data discovery gate"
);

const dataRecoveryAfterDiscoveryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", localFailureRecoveryActive: true },
  goal: "Recover this data task after a failed mutation.",
  profile: "data",
  messages: dataReadyMessages,
});
sameNames(
  dataRecoveryAfterDiscoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "local recovery remained trapped after data discovery completed"
);

const retainedDataRecoveryTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    localFailureRecoveryActive: true,
    dataProjectDiscoveryReady: true,
  },
  goal: "Continue the same retained data repair.",
  profile: "data",
});
sameNames(
  retainedDataRecoveryTools,
  ["read_file", "read_image", "apply_patch", "write_file", "run_command", "search_files", "inspect_project", "finish"],
  "retained local data recovery omitted mutation and verification tools"
);

const artifactRepairTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", artifactValidationPhase: true, artifactValidationNeedsRepair: true },
  goal: "Repair the exact report from deterministic preflight evidence.",
  profile: "code",
});
assertStrict.equal(names(artifactRepairTools)[0], "apply_patch", "artifact repair did not prioritize the patch tool");
assert(names(artifactRepairTools).includes("finish"), "artifact repair surface omitted finish");
assert(!names(artifactRepairTools).includes("run_command"), "artifact repair exposed command checks before content was valid");

const embeddedArtifactRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationOutputEmbedded: true,
  },
  goal: "Repair the exact report whose full content is embedded in the validation packet.",
  profile: "code",
});
assert(!names(embeddedArtifactRepairTools).includes("read_file"), "embedded artifact repair redundantly exposed read_file");
assert(!names(embeddedArtifactRepairTools).includes("write_file"), "embedded artifact repair allowed a drifting whole-file rewrite");
assert(names(embeddedArtifactRepairTools).includes("apply_patch"), "embedded artifact repair omitted apply_patch");

const focusedArtifactRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationRepairAttempts: 1,
  },
  goal: "Apply a focused repair after the first whole-artifact correction.",
  profile: "code",
});
assertStrict.equal(names(focusedArtifactRepairTools)[0], "apply_patch", "later artifact repair did not retain patch priority");
assert(!names(focusedArtifactRepairTools).includes("write_file"), "later artifact repair still allowed whole-artifact rewrites");
assert(!names(focusedArtifactRepairTools).includes("run_command"), "later artifact repair exposed unrelated command checks");

const repairWithMissingCheckTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsRepair: true,
    artifactValidationNeedsCommand: true,
    artifactValidationRepairAttempts: 1,
  },
  goal: "Collect the missing doctor evidence, then apply a focused report repair.",
  profile: "code",
});
assertStrict.equal(
  names(repairWithMissingCheckTools)[0],
  "run_command",
  "artifact repair was prioritized ahead of its missing execution evidence"
);
assert(names(repairWithMissingCheckTools).includes("apply_patch"), "combined evidence/repair surface omitted patching");
assert(!names(repairWithMissingCheckTools).includes("write_file"), "combined later repair reopened whole-file rewriting");

const artifactCommandTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsCommand: true,
    artifactValidationUsedTools: ["read_file"],
  },
  goal: "Run one bounded verification command, then finish.",
  profile: "code",
});
assertStrict.equal(names(artifactCommandTools)[0], "run_command", "artifact command evidence was not prioritized");
assert(!names(artifactCommandTools).includes("read_file"), "already-used artifact read remained exposed");

const pendingCompletionEvidenceTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsGitEvidence: true,
    artifactValidationNeedsVisualEvidence: true,
    artifactValidationUsedTools: ["run_command", "read_image"],
  },
  goal: "Finish only after the generated plot is inspected and the intentional changes are committed.",
  profile: "data",
});
assertStrict.equal(
  names(pendingCompletionEvidenceTools)[0],
  "read_image",
  "pending visual evidence did not prioritize actual image perception"
);
assert(
  names(pendingCompletionEvidenceTools).includes("run_command"),
  "pending git evidence did not reopen the shell after an earlier generator command"
);

const boundedArtifactCommitTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsGitEvidence: true,
    artifactValidationPendingGitActions: ["commit"],
    artifactValidationCommitPaths: ["SECURITY.md", "labshare.py", "tests/test_labshare.py"],
  },
  goal: "Commit only the accepted security repair, then finish.",
  profile: "code",
});
sameNames(
  boundedArtifactCommitTools,
  ["commit_project_changes", "finish"],
  "artifact Git completion exposed open-ended validation tools after task-owned paths were known"
);
assertStrict.deepEqual(
  boundedArtifactCommitTools[0].function.parameters.required,
  ["message"],
  "artifact Git completion delegated path selection back to the model"
);

const boundedTaskOwnedCommitTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    taskOwnedCommitPending: true,
    taskOwnedPendingGitActions: ["commit"],
    taskOwnedCommitPaths: ["service_ctl.py", "tests/test_service_ctl.py"],
  },
  goal: "Commit only the verified task-owned service repair, then finish.",
  profile: "devops",
});
sameNames(
  boundedTaskOwnedCommitTools,
  ["commit_project_changes", "finish"],
  "verified non-artifact code work reopened broad tools instead of a bounded task-owned commit"
);
assertStrict.deepEqual(
  boundedTaskOwnedCommitTools[0].function.parameters.required,
  ["message"],
  "task-owned Git completion delegated path selection back to the model"
);

const requiredCommandBeforeCommitTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsCommand: true,
    requiredProjectCommandPending: true,
    requiredProjectCommand: "python analysis.py",
    artifactValidationPendingGitActions: ["commit"],
    artifactValidationCommitPaths: ["analysis.py", "AGINTI.md"],
  },
  goal: "Regenerate the outputs, validate them, and commit the intended repair.",
  profile: "data",
});
sameNames(
  requiredCommandBeforeCommitTools,
  ["run_command", "finish"],
  "artifact Git completion preempted an outstanding exact project command"
);
assertStrict.deepEqual(
  requiredCommandBeforeCommitTools[0].function.parameters.properties.command.enum,
  ["python analysis.py"],
  "artifact recovery exposed an open-ended command instead of the retained requirement"
);

const resumedArtifactRuntime = nextStepRuntimeConfig(
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    taskProfile: "data",
  },
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    meta: {
      taskProfile: "data",
      artifactProgress: {
        complete: true,
        usedValidationTools: ["run_command", "read_image"],
      },
      durableEvidenceCategories: [],
    },
    messages: [],
  }
);
assert(
  resumedArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "artifact resume lost the durable git evidence requirement"
);
assert(
  resumedArtifactRuntime.artifactValidationNeedsVisualEvidence === true,
  "artifact resume lost the durable visual evidence requirement"
);

const visuallyVerifiedArtifactRuntime = nextStepRuntimeConfig(
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    taskProfile: "data",
  },
  {
    goal: "Perform a visual screenshot inspection of the generated plot and commit the intentional changes.",
    meta: {
      taskProfile: "data",
      durableEvidenceCategories: ["visual", "artifact"],
      artifactProgress: { complete: true, usedValidationTools: ["read_image"] },
    },
    messages: [],
  }
);
assert(
  visuallyVerifiedArtifactRuntime.artifactValidationNeedsVisualEvidence === false,
  "durable visual evidence was forgotten after history compaction"
);
assert(
  visuallyVerifiedArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "durable visual evidence incorrectly satisfied the separate git requirement"
);

const statusOnlyArtifactState = {
  goal: "Generate the required outputs.",
  meta: {
    taskProfile: "data",
    goalContract: {
      revision: 7,
      taskGoal: "Generate the required outputs.",
      currentRequest: "Commit only analysis.py and AGINTI.md after cleanup.",
    },
    durableEvidenceCategories: ["git"],
    durableGitActions: ["status", "diff"],
    durableGitEvidence: [
      { action: "status", goalRevision: 7 },
      { action: "diff", goalRevision: 7 },
    ],
    projectVerification: {
      mutationRevision: 2,
      mutationHistory: [
        { revision: 1, paths: ["analysis.py"] },
        { revision: 2, paths: ["AGINTI.md"] },
      ],
      commandRuns: [],
    },
    artifactProgress: { complete: true, usedValidationTools: ["run_command"] },
  },
  messages: [],
};
assert(
  completionContractGoal({ taskProfile: "data" }, statusOnlyArtifactState).includes(
    "Commit only analysis.py and AGINTI.md"
  ),
  "the latest same-task continuation disappeared from the completion contract"
);
assert(
  nextStepRuntimeConfig({ taskProfile: "data" }, statusOnlyArtifactState)
    .artifactValidationNeedsGitEvidence === true,
  "durable git status incorrectly hid the shell before the requested commit"
);
assert(
  nextStepRuntimeConfig({ taskProfile: "data" }, statusOnlyArtifactState)
    .artifactValidationNeedsCommand === true,
  "a fresh pending commit did not reopen the command tool"
);
const boundedStatusOnlyRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  statusOnlyArtifactState
);
assertStrict.deepEqual(
  boundedStatusOnlyRuntime.artifactValidationPendingGitActions,
  ["commit"],
  "artifact runtime did not retain the exact pending Git action"
);
assertStrict.deepEqual(
  boundedStatusOnlyRuntime.artifactValidationCommitPaths,
  ["analysis.py", "AGINTI.md"],
  "artifact runtime did not derive task-owned commit paths from mutation evidence"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: boundedStatusOnlyRuntime,
    goal: statusOnlyArtifactState.goal,
    profile: "data",
  }),
  ["commit_project_changes", "finish"],
  "derived artifact Git recovery did not narrow the live tool surface"
);
const staleCommitArtifactRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    ...statusOnlyArtifactState,
    meta: {
      ...statusOnlyArtifactState.meta,
      durableGitActions: ["status", "diff", "commit"],
      durableGitEvidence: [
        { action: "status", goalRevision: 7 },
        { action: "commit", goalRevision: 6 },
      ],
    },
  }
);
assert(
  staleCommitArtifactRuntime.artifactValidationNeedsGitEvidence === true,
  "a commit from an earlier goal revision satisfied a fresh commit request"
);
const committedArtifactRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    ...statusOnlyArtifactState,
    meta: {
      ...statusOnlyArtifactState.meta,
      durableGitActions: ["status", "diff", "add", "commit"],
      durableGitEvidence: [
        { action: "status", goalRevision: 7 },
        { action: "commit", goalRevision: 7, mutationRevision: 2 },
      ],
    },
  }
);
assert(
  committedArtifactRuntime.artifactValidationNeedsGitEvidence === false,
  "a durable matching commit was forgotten after compaction"
);
const bareResumeCommitState = {
  goal: "Continue the same task from the saved state.",
  meta: {
    taskProfile: "writing",
    goalContract: {
      revision: 6,
      currentRequest: "Continue the same task from the saved state.",
      activeGoal: "Update handoff.md from records.jsonl, validate it, and commit the coherent result.",
      activeGoalRevision: 5,
    },
    projectVerification: {
      mutationRevision: 9,
      requiredOutputs: ["handoff.md"],
    },
    durableEvidenceCategories: ["git"],
    durableGitActions: ["commit"],
    durableGitEvidence: [{ action: "commit", goalRevision: 5, mutationRevision: 8 }],
    artifactProgress: { complete: true, exactOutputPaths: ["handoff.md"], usedValidationTools: [] },
  },
  messages: [],
};
assert(
  nextStepRuntimeConfig({ taskProfile: "writing" }, bareResumeCommitState)
    .artifactValidationNeedsGitEvidence === true,
  "a commit predating the latest mutation satisfied a bare resumed task"
);
const currentMutationCommitState = {
  ...bareResumeCommitState,
  meta: {
    ...bareResumeCommitState.meta,
    durableGitEvidence: [{ action: "commit", goalRevision: 5, mutationRevision: 9 }],
  },
};
assert(
  nextStepRuntimeConfig({ taskProfile: "writing" }, currentMutationCommitState)
    .artifactValidationNeedsGitEvidence === false,
  "a commit covering the active goal and latest mutation was not retained"
);
const pendingCanonicalCommandRuntime = nextStepRuntimeConfig(
  { taskProfile: "data" },
  {
    goal: "Finish the validated data project.",
    meta: {
      taskProfile: "data",
      projectVerification: {
        mutationRevision: 4,
        requiredCommands: ["python analysis.py"],
        requiredOutputs: ["outputs/summary.json"],
        commandRuns: [],
        testRuns: [],
      },
      artifactProgress: { complete: true, usedValidationTools: [] },
    },
    messages: [],
  }
);
assert(
  pendingCanonicalCommandRuntime.artifactValidationNeedsCommand === true,
  "a missing canonical project command did not reopen command execution"
);
const exactVerifier =
  "python3 /home/lachlan/ProjectsLFS/Aginti-Test/supervision/acceptance/security_labshare_contract.py";
const exactVerifierRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "security" },
  {
    goal: `Run ${exactVerifier} and finish only after it passes.`,
    meta: {
      goalContract: {
        revision: 4,
        activeGoal: `Run ${exactVerifier} and finish only after it passes.`,
      },
      projectVerification: {
        mutationRevision: 2,
        contractRequiredCommands: [exactVerifier],
        commandRuns: [],
        testRuns: [],
      },
    },
    messages: [],
  }
);
assert(
  exactVerifierRuntime.requiredProjectCommandPending === true &&
    exactVerifierRuntime.requiredProjectCommand === exactVerifier,
  "a pending exact verifier did not activate the constrained project-command phase"
);
const exactVerifierTools = selectProgressiveTools(allTools, {
  config: {
    ...exactVerifierRuntime,
    convergenceSuppressedToolNames: ["run_command"],
  },
  goal: `Run ${exactVerifier}.`,
  profile: "security",
});
sameNames(
  exactVerifierTools,
  ["run_command", "finish"],
  "a pending exact verifier left unrelated tools available"
);
assertStrict.deepEqual(
  exactVerifierTools[0].function.parameters.properties.command.enum,
  [exactVerifier],
  "the pending exact verifier was not schema-constrained"
);

const artifactSourceReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsSourceRead: true,
  },
  goal: "Inspect one exact missing source, then finish.",
  profile: "code",
});
assertStrict.equal(names(artifactSourceReadTools)[0], "read_file", "missing source evidence did not prioritize an exact read");

const embeddedArtifactSourceReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    artifactValidationPhase: true,
    artifactValidationNeedsSourceRead: true,
    artifactValidationOutputEmbedded: true,
  },
  goal: "Inspect one exact missing source while the output itself is already embedded.",
  profile: "code",
});
assertStrict.equal(
  names(embeddedArtifactSourceReadTools)[0],
  "read_file",
  "embedding the output incorrectly hid a genuinely missing source read"
);

const browserTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Open the browser, fill in the form, and take a screenshot.",
  profile: "browser",
});
assert(names(browserTools).includes("open_url"), "browser bundle omitted open_url");
assert(names(browserTools).includes("click") && names(browserTools).includes("type"), "browser bundle omitted interaction tools");
assert(!names(browserTools).includes("run_command"), "browser bundle leaked the code shell tool");

const failedTestRepairTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", testFailureRepairActive: true },
  goal: "Repair the current project after a failing test.",
  profile: "data",
});
sameNames(
  failedTestRepairTools,
  ["read_file", "search_files", "apply_patch", "run_command", "finish"],
  "failed-test repair did not receive the bounded diagnose-patch-retest tool surface"
);

const generatedArtifactProducerTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    generatedArtifactProducerPending: true,
    generatedArtifactProducerCommand: "python3 build_deck.py",
    convergenceSuppressedToolNames: ["run_command"],
  },
  goal: "Rebuild the generated presentation before rerunning its validator.",
  profile: "slides",
});
sameNames(
  generatedArtifactProducerTools,
  ["run_command", "finish"],
  "a stale generated artifact did not expose only its retained producer command"
);
assertStrict.deepEqual(
  generatedArtifactProducerTools[0].function.parameters.properties.command.enum,
  ["python3 build_deck.py"],
  "the generated-artifact producer command was not schema-constrained"
);
const disabledGeneratedArtifactProducerTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    allowShellTool: false,
    generatedArtifactProducerPending: true,
    generatedArtifactProducerCommand: "python3 build_deck.py",
    convergenceSuppressedToolNames: ["run_command"],
  },
  goal: "Rebuild the generated presentation.",
  profile: "slides",
});
sameNames(
  disabledGeneratedArtifactProducerTools,
  ["finish"],
  "an authoritative producer phase bypassed an explicit shell capability disable"
);

const mutationOnlyFailedTestRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
  },
  goal: "Repair the current project after an unchanged failing test rerun.",
  profile: "data",
});
sameNames(
  mutationOnlyFailedTestRepairTools,
  ["apply_patch", "finish"],
  "an unchanged failed-test rerun did not close discovery until a real mutation"
);

const authoritativeTestRestoreTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureAuthoritativeRestorePending: true,
    testFailureAuthoritativeRestoreCommand:
      "git checkout HEAD -- 'src/test/java/example/WindowSummaryTest.java'",
    convergenceSuppressedToolNames: ["run_command"],
    patchContextRepairRequired: true,
    patchContextRepairPath: "src/test/java/example/WindowSummaryTest.java",
    patchContextRepairSearch: "damaged authoritative test body",
  },
  goal: "Recover the authoritative test this same task damaged, then repair production.",
  profile: "code",
});
sameNames(
  authoritativeTestRestoreTools,
  ["run_command", "finish"],
  "a provenance-bound authoritative-test restore was hidden by convergence suppression"
);
assertStrict.deepEqual(
  authoritativeTestRestoreTools[0].function.parameters.properties.command.enum,
  ["git checkout HEAD -- 'src/test/java/example/WindowSummaryTest.java'"],
  "the authoritative-test restore tool was not constrained to its exact command"
);

const authoritativeRestoreRequestTools = await captureRequestTools({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  taskProfile: "code",
  allowShellTool: true,
  testFailureRepairActive: true,
  testFailureRepairMutationRequired: true,
  testFailureAuthoritativeRestorePending: true,
  testFailureAuthoritativeRestoreCommand:
    "git checkout HEAD -- 'src/test/java/example/WindowSummaryTest.java'",
  patchContextRepairRequired: true,
  patchContextRepairPath: "src/test/java/example/WindowSummaryTest.java",
  patchContextRepairSearch: "damaged authoritative test body",
});
sameNames(
  authoritativeRestoreRequestTools,
  ["run_command", "finish"],
  "the model request boundary let stale patch context mask authoritative-test restoration"
);
assertStrict.deepEqual(
  authoritativeRestoreRequestTools[0].function.parameters.properties.command.enum,
  ["git checkout HEAD -- 'src/test/java/example/WindowSummaryTest.java'"],
  "the request boundary lost the exact authoritative-test restoration command"
);

const explicitHeadRestoreTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    completionFreshMutationRequired: true,
    completionFreshMutationRestorePending: true,
    completionFreshMutationRestoreCommand:
      "git checkout HEAD -- 'src/main/java/example/WindowSummary.java'",
    completionFreshMutationPaths: [
      "src/main/java/example/WindowSummary.java",
    ],
    convergenceSuppressedToolNames: ["run_command"],
  },
  goal: "Restore the exact task-owned production source to HEAD.",
  profile: "code",
});
sameNames(
  explicitHeadRestoreTools,
  ["run_command", "finish"],
  "an explicit task-owned HEAD restore was hidden by convergence suppression"
);
assertStrict.deepEqual(
  explicitHeadRestoreTools[0].function.parameters.properties.command.enum,
  ["git checkout HEAD -- 'src/main/java/example/WindowSummary.java'"],
  "the task-owned HEAD restore tool was not constrained to its exact command"
);

const explicitHeadRestoreWithStaleFailureTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    completionFreshMutationRequired: true,
    completionFreshMutationRestorePending: true,
    completionFreshMutationRestoreCommand:
      "git checkout HEAD -- 'src/main/java/example/WindowSummary.java'",
    completionFreshMutationPaths: [
      "src/main/java/example/WindowSummary.java",
    ],
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    patchContextRepairRequired: true,
    patchContextRepairPath: "src/main/java/example/WindowSummary.java",
    patchContextRepairSearch: "stale failed-test source anchor",
  },
  goal: "Restore the exact task-owned production source to HEAD.",
  profile: "code",
});
sameNames(
  explicitHeadRestoreWithStaleFailureTools,
  ["run_command", "finish"],
  "stale failed-test patch context masked an explicit task-owned HEAD restore"
);
assertStrict.deepEqual(
  explicitHeadRestoreWithStaleFailureTools[0].function.parameters.properties.command.enum,
  ["git checkout HEAD -- 'src/main/java/example/WindowSummary.java'"],
  "the stale-failure recovery surface widened the explicit HEAD restore command"
);

const authoritativeProductionRereadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    commandCwd: "/tmp/aginti-authoritative-repair",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureAuthoritativeSourceRereadRequired: true,
    testFailureCanonicalMutationPaths: [
      "src/main/java/example/WindowSummary.java",
    ],
    patchContextRefreshRequired: true,
    patchContextRefreshPath: "src/test/java/example/WindowSummaryTest.java",
  },
  goal: "Reread production after rejecting an authoritative-test rewrite.",
  profile: "code",
});
sameNames(
  authoritativeProductionRereadTools,
  ["read_file", "finish"],
  "a rejected authoritative-test rewrite did not force one canonical production reread"
);
assertStrict.deepEqual(
  authoritativeProductionRereadTools[0].function.parameters.properties.path.enum,
  [
    "src/main/java/example/WindowSummary.java",
    "/tmp/aginti-authoritative-repair/src/main/java/example/WindowSummary.java",
  ],
  "the authoritative production reread escaped its exact canonical path"
);

const canonicalProductionPatchTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureCanonicalMutationPaths: [
      "src/main/java/example/WindowSummary.java",
    ],
  },
  goal: "Repair only the canonical production implementation.",
  profile: "code",
});
sameNames(
  canonicalProductionPatchTools,
  ["apply_patch", "finish"],
  "canonical failed-test repair did not close unrelated mutation paths"
);
assertStrict.deepEqual(
  canonicalProductionPatchTools[0].function.parameters.properties.path.enum,
  ["src/main/java/example/WindowSummary.java"],
  "canonical failed-test apply_patch was not schema-bound to production"
);

const externalValidatorPath = "/tmp/aginti-acceptance/deck_contract.py";
const externalDiagnosticFailedTestRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureDiagnosticReadPaths: [externalValidatorPath],
  },
  goal: "Repair the canonical producer from the exact external acceptance contract.",
  profile: "slides",
});
sameNames(
  externalDiagnosticFailedTestRepairTools,
  ["read_file", "apply_patch", "finish"],
  "a retained external validator was not exposed as one bounded read during mutation-only recovery"
);
assertStrict.deepEqual(
  externalDiagnosticFailedTestRepairTools[0].function.parameters.properties.path.enum,
  [externalValidatorPath],
  "the external validator read was not schema-constrained to its exact path"
);
assertStrict.equal(
  taskForbidsExternalValidatorSourceRead(
    { goal: "Repair the producer. Do not inspect the external acceptance-validator source." },
    {}
  ),
  true,
  "an explicit prohibition on reading external validator source was ignored"
);
assertStrict.equal(
  taskForbidsExternalValidatorSourceRead(
    { goal: "Do not inspect the validator before its first failed run; then use bounded diagnostics." },
    {}
  ),
  false,
  "a conditional first-run opacity rule was mistaken for a permanent read prohibition"
);
const forbiddenExternalDiagnosticTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    commandCwd: "/tmp/aginti-canonical-repair",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureForbidExternalDiagnosticRead: true,
    testFailureDiagnosticReadPaths: [externalValidatorPath],
    testFailureRepairOptionalRereadPaths: ["build_deck.py"],
  },
  goal: "Repair the producer without inspecting the external validator source.",
  profile: "slides",
});
assertStrict.deepEqual(
  forbiddenExternalDiagnosticTools[0].function.parameters.properties.path.enum,
  ["build_deck.py", "/tmp/aginti-canonical-repair/build_deck.py"],
  "an explicitly forbidden validator read displaced the canonical source repair path"
);
const workspaceDiagnosticWithForbiddenExternalTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    commandCwd: "/tmp/aginti-canonical-repair",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureForbidExternalDiagnosticRead: true,
    testFailureDiagnosticReadPaths: [
      externalValidatorPath,
      "artifacts/manifest.json",
    ],
    testFailureExternalDiagnosticReadPaths: [externalValidatorPath],
    testFailureWorkspaceDiagnosticReadPaths: ["artifacts/manifest.json"],
    testFailureRepairOptionalRereadPaths: ["build_deck.py"],
  },
  goal: "Inspect generated evidence without reading the external validator source.",
  profile: "slides",
});
sameNames(
  workspaceDiagnosticWithForbiddenExternalTools,
  ["read_file", "apply_patch", "finish"],
  "forbidding external validator source also removed the workspace diagnostic read"
);
assertStrict.deepEqual(
  workspaceDiagnosticWithForbiddenExternalTools[0].function.parameters.properties.path.enum,
  [
    "artifacts/manifest.json",
    "/tmp/aginti-canonical-repair/artifacts/manifest.json",
    "build_deck.py",
    "/tmp/aginti-canonical-repair/build_deck.py",
  ],
  "workspace diagnostics were not retained ahead of bounded source rereads"
);

const canonicalRepairPathAliasTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    commandCwd: "/tmp/aginti-canonical-repair",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairOptionalRereadPaths: ["build_deck.py"],
  },
  goal: "Correct the canonical producer after a prospective patch rejection.",
  profile: "slides",
});
sameNames(
  canonicalRepairPathAliasTools,
  ["read_file", "apply_patch", "finish"],
  "a canonical repair reread did not preserve its bounded tool surface"
);
assertStrict.deepEqual(
  canonicalRepairPathAliasTools[0].function.parameters.properties.path.enum,
  ["build_deck.py", "/tmp/aginti-canonical-repair/build_deck.py"],
  "the exact in-workspace absolute alias was not accepted for the canonical repair path"
);

const failedTestPatchContextTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairNeedsPatchContext: true,
  },
  goal: "Repair the current project after an unchanged replacement.",
  profile: "data",
});
sameNames(
  failedTestPatchContextTools,
  ["read_file", "search_files", "apply_patch", "finish"],
  "a failed no-op patch did not reopen one bounded diagnostic source turn"
);

const failedTestRepairWithRequiredInstruction = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairAllowedCreates: ["AGINTI.md"],
  },
  goal: "Repair the current project and create the required project instructions.",
  profile: "data",
});
sameNames(
  failedTestRepairWithRequiredInstruction,
  ["read_file", "search_files", "apply_patch", "write_file", "run_command", "finish"],
  "failed-test repair omitted the exact required instruction-file creation exception"
);
const constrainedInstructionWrite = failedTestRepairWithRequiredInstruction.find(
  (tool) => tool.function.name === "write_file"
);
assertStrict.deepEqual(constrainedInstructionWrite.function.parameters.properties.path.enum, ["AGINTI.md"]);
assertStrict.deepEqual(constrainedInstructionWrite.function.parameters.properties.mode.enum, ["create"]);

const continuedFailedTestRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        discoveredTests: ["python -m pytest -q"],
        requiredOutputs: [],
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 0,
            passed: false,
            failureSignature: "baseline-failure",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  continuedFailedTestRepairRuntime.testVerificationPending,
  true,
  "a real repair mutation did not require the retained failed test before more edits"
);
assertStrict.equal(
  continuedFailedTestRepairRuntime.testVerificationCommand,
  "python -m pytest -q",
  "a real repair mutation lost the exact retained verification command"
);
const mutationGatedRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 1,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 1,
            passed: false,
            failureSignature: "current-failure",
          },
        ],
      },
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            stagnationEpoch: 4,
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  mutationGatedRepairRuntime.testFailureRepairMutationRequired,
  true,
  "a blocked unchanged validator did not advance failed-test recovery to mutation-only mode"
);
assertStrict.equal(
  mutationGatedRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "mutation-gated recovery without retained source evidence did not preserve one bounded diagnostic read"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: mutationGatedRepairRuntime,
    goal: "Repair the current project after an external validator failure.",
    profile: "qa",
  }),
  ["read_file", "search_files", "apply_patch", "finish"],
  "source-less mutation recovery withheld the only tools that could identify a canonical repair target"
);
const repositoryStateRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 2,
        testRuns: [{
          command: "python acceptance.py --phase final",
          mutationRevision: 2,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "repository-state-gate",
          failureSummary:
            "require(git_output(root, \"status\", \"--short\") == \"\", \"repository worktree is not clean\")",
        }],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  repositoryStateRepairRuntime.testFailureRepositoryStateRepair,
  true,
  "an empty Git-status assertion did not activate repository-state repair"
);
assertStrict.equal(
  repositoryStateRepairRuntime.testFailureRepairMutationRequired,
  false,
  "a repository-state repair incorrectly required another content mutation"
);
const repositoryStateRepairTools = selectProgressiveTools(allTools, {
  config: repositoryStateRepairRuntime,
  goal: "Finish the verified task and leave the repository clean.",
  profile: "qa",
});
sameNames(
  repositoryStateRepairTools,
  ["run_command", "finish"],
  "repository-state repair exposed document mutation tools"
);
assert(
  /exact bounded Git status inspection once/i.test(
    repositoryStateRepairTools.find((item) => item.function.name === "run_command")?.function.description || ""
  ),
  "repository-state repair did not constrain the first recovery turn to one status inspection"
);
assertStrict.deepEqual(
  repositoryStateRepairTools[0].function.parameters.properties.command.enum,
  ["git status --porcelain=v1 --untracked-files=all"],
  "repository-state repair exposed an open-ended shell instead of the exact status command"
);
const conciseRepositoryStateRepairRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "slides" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 18,
        testRuns: [{
          command: "python acceptance.py --root .",
          mutationRevision: 18,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "concise-repository-state-gate",
          failureSummary: "acceptance failed: repository is not clean",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 18,
        failureSignature: "concise-repository-state-gate",
        content: "Retained canonical source evidence from the prior content failure.",
      },
      toolLoop: {
        stagnationEpoch: 4,
        recent: [],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  conciseRepositoryStateRepairRuntime.testFailureRepositoryStateRepair,
  true,
  "a concise acceptance failure remained in canonical-source repair mode"
);
assertStrict.equal(
  conciseRepositoryStateRepairRuntime.testFailureRepairMutationRequired,
  false,
  "stale retained source evidence overrode a clean-repository repair gate"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: conciseRepositoryStateRepairRuntime,
    goal: "Commit the accepted presentation and leave the repository clean.",
    profile: "slides",
  }),
  ["run_command", "finish"],
  "a concise clean-repository acceptance failure exposed content mutation tools"
);
const explicitFailRepositoryStateRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "cad" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 19,
        testRuns: [{
          command: "python acceptance.py --root .",
          mutationRevision: 19,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "explicit-fail-repository-state-gate",
          failureSummary:
            "Failing tests: Git worktree is not clean: M .gitignore M README.md ?? .aginti/ ?? build_cad.py",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 19,
        failureSignature: "explicit-fail-repository-state-gate",
        content: "Stale canonical-source evidence from the preceding repair.",
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  explicitFailRepositoryStateRuntime.testFailureRepositoryStateRepair,
  true,
  "an explicit validator FAIL line remained in canonical-source repair mode"
);
assertStrict.equal(
  explicitFailRepositoryStateRuntime.testFailureRepairMutationRequired,
  false,
  "an explicit validator FAIL line retained the source-mutation gate"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: explicitFailRepositoryStateRuntime,
    goal: "Commit the verified CAD task and leave the repository clean.",
    profile: "cad",
  }),
  ["run_command", "finish"],
  "an explicit validator FAIL line hid the bounded Git recovery command"
);
const observedRepositoryState = {
  meta: {
    goalContract: { revision: 7 },
    projectVerification: {
      mutationRevision: 18,
      repositoryStateInspection: {
        version: 1,
        mutationRevision: 18,
        failureSignature: "observed-repository-state-gate",
        command: "git status --porcelain=v1 --untracked-files=all",
        entries: [
          { status: " D", path: "dist/deck.pdf" },
          { status: "??", path: "output/deck.pptx" },
          { status: " M", path: "unrelated-notes.md" },
        ],
      },
      testRuns: [{
        command: "python acceptance.py --phase final",
        mutationRevision: 18,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "observed-repository-state-gate",
        failureSummary: "acceptance failed: repository is not clean",
      }],
    },
  },
  messages: [],
};
const observedRepositoryRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "slides" },
  observedRepositoryState
);
assertStrict.deepEqual(
  observedRepositoryRuntime.repositoryStateRepairObservedPaths,
  ["dist/deck.pdf", "output/deck.pptx", "unrelated-notes.md"],
  "the clean-state recovery phase lost exact paths from its bounded status observation"
);
const observedRepositoryTools = selectProgressiveTools(allTools, {
  config: observedRepositoryRuntime,
  goal: "Commit only the accepted presentation relocation.",
  profile: "slides",
});
sameNames(
  observedRepositoryTools,
  ["commit_project_changes", "finish"],
  "an observed clean-state recovery did not replace the shell with path-enumerated commit selection"
);
assertStrict.deepEqual(
  observedRepositoryTools[0].function.parameters.required,
  ["paths", "message"],
  "the observed-path commit did not require explicit task-owned path selection"
);
assertStrict.deepEqual(
  observedRepositoryTools[0].function.parameters.properties.paths.items.enum,
  ["dist/deck.pdf", "output/deck.pptx", "unrelated-notes.md"],
  "the observed-path commit broadened its candidate scope beyond the exact status result"
);
const taskOwnedRepositoryState = {
  meta: {
    goalContract: { revision: 6 },
    projectVerification: {
      mutationRevision: 5,
      commandRuns: [{
        command: "git add -- old.md && git commit -m 'Prior task'",
        ok: true,
        mutationRevision: 2,
      }],
      mutationHistory: [
        { revision: 1, paths: ["old.md"] },
        { revision: 4, paths: ["handoff.md"] },
        { revision: 5, paths: ["notes/summary.md", "handoff.md"] },
      ],
      testRuns: [{
        command: "python acceptance.py --phase final",
        mutationRevision: 5,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "repository-state-gate-with-owned-paths",
        failureSummary:
          "require(git_output(root, \"status\", \"--short\") == \"\", \"repository worktree is not clean\")",
      }],
    },
  },
  messages: [],
};
const taskOwnedRepositoryRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  taskOwnedRepositoryState
);
assertStrict.deepEqual(
  taskOwnedRepositoryRuntime.repositoryStateRepairCommitPaths,
  ["handoff.md", "notes/summary.md"],
  "repository-state repair did not isolate agent-owned paths since the latest successful commit"
);
const taskOwnedRepositoryTools = selectProgressiveTools(allTools, {
  config: taskOwnedRepositoryRuntime,
  goal: "Finish the verified task and leave the repository clean.",
  profile: "qa",
});
sameNames(
  taskOwnedRepositoryTools,
  ["commit_project_changes", "finish"],
  "repository-state repair exposed an open-ended shell after task-owned paths were known"
);
assertStrict.deepEqual(
  taskOwnedRepositoryTools[0].function.parameters.required,
  ["message"],
  "the task-owned commit tool delegated path selection back to the model"
);
const verifiedCompletionTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    taskProfile: "qa",
    verifiedCompletionPending: true,
    artifactValidationPhase: true,
    testFailureRepairActive: true,
  },
  goal: "Conclude from current verified evidence.",
  profile: "qa",
});
sameNames(
  verifiedCompletionTools,
  ["finish"],
  "verified completion exposed tools that could repeat or mutate completed work"
);
const retainedPacketRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 3,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 3,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "retained-failure",
          },
        ],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 3,
        failureSignature: "retained-failure",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 3,
        failureSignature: "retained-failure",
        at: "2026-08-24T02:00:00.000Z",
        focuses: [],
      },
      toolLoop: {
        stagnationEpoch: 9,
        recent: [],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  retainedPacketRepairRuntime.testFailureRepairMutationRequired,
  true,
  "a current retained evidence packet lost its mutation gate across a resume boundary"
);
assertStrict.equal(
  retainedPacketRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "a fresh retained evidence packet did not allow one bounded diagnostic source turn"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: retainedPacketRepairRuntime,
    goal: "Resume the current failed-test repair from retained evidence.",
    profile: "qa",
  }),
  ["read_file", "search_files", "apply_patch", "finish"],
  "a fresh retained evidence packet exposed an unbounded failed-test tool surface"
);
const packetPathReadState = {
  meta: {
    projectVerification: {
      mutationRevision: 7,
      testRuns: [{
        command: "python3 -m unittest discover -s tests -v",
        mutationRevision: 7,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "packet-path-failure",
        at: "2026-08-24T02:00:00.000Z",
      }],
    },
    failedTestRecoveryPacket: {
      packetVersion: 17,
      mutationRevision: 7,
      failureSignature: "packet-path-failure",
      content: "Bounded failed-test evidence packet v17.",
      paths: ["tests/test_service_ctl.py", "service_ctl.py"],
      generatedAt: "2026-08-24T02:00:10.000Z",
    },
    failedTestFocusedRecovery: {
      packetVersion: 17,
      mutationRevision: 7,
      failureSignature: "packet-path-failure",
      at: "2026-08-24T02:00:10.000Z",
    },
    failedTestDiagnostic: {
      packetVersion: 17,
      mutationRevision: 7,
      failureSignature: "packet-path-failure",
      at: "2026-08-24T02:00:00.000Z",
      focuses: [],
    },
    toolLoop: {
      stagnationEpoch: 10,
      recent: [{
        toolName: "read_file",
        path: "service_ctl.py",
        ok: true,
        blocked: false,
        at: "2026-08-24T02:00:11.000Z",
      }],
    },
  },
  messages: [],
};
const onePacketPathUnreadRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  packetPathReadState
);
assertStrict.deepEqual(
  onePacketPathUnreadRuntime.testFailureRepairContextPaths,
  ["tests/test_service_ctl.py"],
  "one successful packet-path read consumed the entire failed-test evidence packet"
);
assertStrict.equal(
  onePacketPathUnreadRuntime.testFailureRepairNeedsPatchContext,
  true,
  "the unread acceptance-test path was not retained for one bounded read"
);
const onePacketPathUnreadTools = selectProgressiveTools(allTools, {
  config: onePacketPathUnreadRuntime,
  goal: "Resume the exact failed-test repair after reading current production source.",
  profile: "qa",
});
sameNames(
  onePacketPathUnreadTools,
  ["read_file", "apply_patch", "finish"],
  "exact packet-path recovery exposed broad search or verification tools"
);
assertStrict.deepEqual(
  onePacketPathUnreadTools[0].function.parameters.properties.path.enum,
  ["tests/test_service_ctl.py"],
  "the bounded evidence read was not constrained to the sole unread packet path"
);
const allPacketPathsReadRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  allPacketPathsReadRuntime.testFailureRepairContextPaths,
  [],
  "fully consumed packet evidence retained stale unread paths"
);
assertStrict.equal(
  allPacketPathsReadRuntime.testFailureRepairNeedsPatchContext,
  false,
  "failed-test recovery did not return to mutation-only mode after every packet path was read once"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: allPacketPathsReadRuntime,
    goal: "Apply the coherent source repair after bounded evidence reads.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "fully consumed packet evidence did not close discovery before mutation"
);
const allPacketPathsReadDeepSeekRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
        ],
      },
    },
  }
);
assertStrict.equal(
  allPacketPathsReadDeepSeekRuntime.testFailureRepairAuxiliaryReadAllowed,
  false,
  "ordinary failed-test recovery unexpectedly opened compiled-language dependency discovery"
);
assertStrict.deepEqual(
  allPacketPathsReadDeepSeekRuntime.testFailureRepairOptionalRereadPaths,
  ["service_ctl.py"],
  "DeepSeek repair did not retain one bounded canonical-source reread fallback"
);
const allPacketPathsReadDeepSeekTools = selectProgressiveTools(allTools, {
  config: allPacketPathsReadDeepSeekRuntime,
  goal: "Apply the coherent source repair after bounded evidence reads.",
  profile: "qa",
});
sameNames(
  allPacketPathsReadDeepSeekTools,
  ["read_file", "apply_patch", "finish"],
  "DeepSeek mutation repair did not tolerate one exact source reread"
);
assertStrict.deepEqual(
  allPacketPathsReadDeepSeekTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "DeepSeek repair reread fallback was not constrained to the canonical source"
);
const postCompactionRepairRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      failedTestRecoveryPacket: {
        ...packetPathReadState.meta.failedTestRecoveryPacket,
        paths: ["tests/test_service_ctl.py", "legacy_fixture.py", "service_ctl.py"],
        repairPaths: ["legacy_fixture.py", "service_ctl.py"],
      },
      toolLoop: {
        stagnationEpoch: 10,
        lastContextRecovery: {
          reason: "proactive-context-compaction",
          at: "2026-08-24T02:00:13.000Z",
          preservedStaticEvidence: true,
        },
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
          {
            toolName: "read_file",
            path: "legacy_fixture.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.500Z",
          },
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  postCompactionRepairRuntime.testFailureRepairContextPaths,
  ["legacy_fixture.py", "service_ctl.py"],
  "context compaction did not reopen the exact production source lost from model context"
);
assertStrict.equal(
  postCompactionRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "context compaction did not restore one bounded source-context turn before mutation"
);
const postCompactionRepairTools = selectProgressiveTools(allTools, {
  config: postCompactionRepairRuntime,
  goal: "Continue the failed-test repair after proactive context compaction.",
  profile: "qa",
});
sameNames(
  postCompactionRepairTools,
  ["read_file", "apply_patch", "finish"],
  "post-compaction repair reopened broad discovery or verification tools"
);
assertStrict.deepEqual(
  postCompactionRepairTools[0].function.parameters.properties.path.enum,
  ["legacy_fixture.py", "service_ctl.py"],
  "post-compaction repair did not constrain rereads to all canonical production sources"
);
const sameTaskContinuationRepairRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      failedTestRecoveryPacket: {
        ...packetPathReadState.meta.failedTestRecoveryPacket,
        paths: ["tests/test_service_ctl.py", "legacy_fixture.py", "service_ctl.py"],
        repairPaths: ["legacy_fixture.py", "service_ctl.py"],
      },
      toolLoop: {
        stagnationEpoch: 11,
        lastContextRecovery: {
          reason: "same-task-continuation",
          at: "2026-08-24T02:01:00.000Z",
        },
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
          {
            toolName: "read_file",
            path: "legacy_fixture.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.500Z",
          },
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  sameTaskContinuationRepairRuntime.testFailureRepairContextPaths,
  ["legacy_fixture.py", "service_ctl.py"],
  "same-task continuation did not reopen all retained canonical production sources"
);
const testOnlyPacketState = {
  meta: {
    projectVerification: {
      mutationRevision: 9,
      testRuns: [{
        command: "scripts/test.sh",
        mutationRevision: 9,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "java-test-only-packet",
        at: "2026-08-29T10:00:00.000Z",
      }],
    },
    failedTestRecoveryPacket: {
      packetVersion: 17,
      mutationRevision: 9,
      failureSignature: "java-test-only-packet",
      content: "Bounded failed-test evidence packet v17.",
      paths: ["src/test/java/art/lazying/telemetry/WindowSummaryTest.java"],
      repairPaths: [],
      generatedAt: "2026-08-29T10:00:01.000Z",
    },
    failedTestDiagnostic: {
      packetVersion: 17,
      mutationRevision: 9,
      failureSignature: "java-test-only-packet",
      at: "2026-08-29T10:00:01.000Z",
      focuses: [],
    },
    toolLoop: {
      stagnationEpoch: 11,
      recent: [{
        toolName: "read_file",
        path: "src/test/java/art/lazying/telemetry/WindowSummaryTest.java",
        ok: true,
        blocked: false,
        goalRevision: 1,
        mutationRevision: 9,
        at: "2026-08-29T10:00:02.000Z",
      }, {
        toolName: "search_files",
        path: "src",
        ok: true,
        blocked: false,
        goalRevision: 1,
        mutationRevision: 9,
        at: "2026-08-29T10:00:02.500Z",
      }],
    },
  },
  messages: [],
};
const testOnlyPacketRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "java" },
  testOnlyPacketState
);
assertStrict.equal(
  testOnlyPacketRuntime.testFailureRepairNeedsPatchContext,
  true,
  "reading a test-only recovery packet incorrectly closed production-source discovery"
);
assertStrict.equal(
  testOnlyPacketRuntime.testFailureRepairNeedsSourceDiscovery,
  true,
  "a path-only source search incorrectly closed production-source discovery"
);
const testOnlyPacketTools = selectProgressiveTools(allTools, {
    config: testOnlyPacketRuntime,
    goal: "Repair the Java implementation after the visible test failed.",
    profile: "java",
  });
sameNames(
  testOnlyPacketTools,
  ["list_files", "read_file", "search_files", "apply_patch", "finish"],
  "test-only recovery evidence forced a blind mutation without production source"
);
assertStrict.equal(
  testOnlyPacketTools
    .find((item) => item.function?.name === "read_file")
    ?.function?.parameters?.properties?.path?.enum,
  undefined,
  "source discovery retained a stale failed-test path enum"
);
const existingInstructionWorkspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "aginti-existing-required-instruction-")
);
try {
  await fs.writeFile(
    path.join(existingInstructionWorkspace, "AGINTI.md"),
    "# Existing project instructions\n\nRun `scripts/test.sh`.\n",
    "utf8"
  );
  const existingInstructionRuntime = nextStepRuntimeConfig(
    {
      provider: "localllm",
      taskProfile: "java",
      commandCwd: existingInstructionWorkspace,
    },
    {
      ...testOnlyPacketState,
      commandCwd: existingInstructionWorkspace,
      meta: {
        ...testOnlyPacketState.meta,
        projectVerification: {
          ...testOnlyPacketState.meta.projectVerification,
          requiredOutputs: ["AGINTI.md"],
        },
        artifactProgress: {
          completed: [],
        },
      },
    }
  );
  assertStrict.deepEqual(
    existingInstructionRuntime.testFailureRepairAllowedCreates,
    [],
    "failed-test recovery offered create-only write_file for an existing instruction file"
  );
} finally {
  await fs.rm(existingInstructionWorkspace, { recursive: true, force: true });
}
const testOnlyPacketWithSourceRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "java" },
  {
    ...testOnlyPacketState,
    meta: {
      ...testOnlyPacketState.meta,
      toolLoop: {
        stagnationEpoch: 11,
        recent: [
          ...testOnlyPacketState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "src/main/java/art/lazying/telemetry/WindowSummary.java",
            ok: true,
            blocked: false,
            goalRevision: 1,
            mutationRevision: 9,
            at: "2026-08-29T10:00:03.000Z",
          },
        ],
      },
    },
  }
);
assertStrict.equal(
  testOnlyPacketWithSourceRuntime.testFailureRepairNeedsPatchContext,
  false,
  "failed-test recovery stayed in discovery after production source was read"
);
assertStrict.equal(
  testOnlyPacketWithSourceRuntime.testFailureRepairNeedsSourceDiscovery,
  false,
  "source discovery remained open after production source was read"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: testOnlyPacketWithSourceRuntime,
    goal: "Apply the Java source repair from current evidence.",
    profile: "java",
  }),
  ["apply_patch", "finish"],
  "production-source grounding did not return failed-test recovery to mutation-only mode"
);
const compiledDependencyPacketState = {
  meta: {
    projectVerification: {
      mutationRevision: 12,
      testRuns: [{
        command: "scripts/test.sh",
        mutationRevision: 12,
        passed: false,
        failureEvidenceVersion: 2,
        failureSignature: "compiled-dependency-read",
        at: "2026-08-29T12:00:00.000Z",
      }],
    },
    failedTestRecoveryPacket: {
      packetVersion: 17,
      mutationRevision: 12,
      failureSignature: "compiled-dependency-read",
      content: "Bounded failed-test evidence packet v17.",
      paths: [
        "src/test/java/example/WindowSummaryTest.java",
        "src/main/java/example/WindowSummary.java",
      ],
      repairPaths: ["src/main/java/example/WindowSummary.java"],
      generatedAt: "2026-08-29T12:00:01.000Z",
    },
    failedTestDiagnostic: {
      packetVersion: 17,
      mutationRevision: 12,
      failureSignature: "compiled-dependency-read",
      at: "2026-08-29T12:00:01.000Z",
      focuses: [],
    },
    toolLoop: {
      stagnationEpoch: 12,
      recent: [
        {
          toolName: "read_file",
          path: "src/main/java/example/WindowSummary.java",
          ok: true,
          blocked: false,
          at: "2026-08-29T12:00:02.000Z",
        },
        {
          toolName: "read_file",
          path: "src/test/java/example/WindowSummaryTest.java",
          ok: true,
          blocked: false,
          at: "2026-08-29T12:00:03.000Z",
        },
      ],
    },
  },
};
const compiledDependencyRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "java" },
  compiledDependencyPacketState
);
assertStrict.equal(
  compiledDependencyRuntime.testFailureRepairAuxiliaryReadAllowed,
  true,
  "DeepSeek did not receive one bounded supporting-read turn for a compiled-language repair"
);
const compiledDependencyTools = selectProgressiveTools(allTools, {
  config: compiledDependencyRuntime,
  goal: "Repair the Java implementation from the authoritative failed-test packet.",
  profile: "java",
});
sameNames(
  compiledDependencyTools,
  ["read_file", "apply_patch", "finish"],
  "compiled-language recovery omitted its bounded supporting-read turn"
);
assertStrict.equal(
  compiledDependencyTools[0].function.parameters.properties.path?.enum,
  undefined,
  "compiled-language supporting reads remained pinned to stale packet paths"
);
const compiledDependencyConsumedRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "java" },
  {
    ...compiledDependencyPacketState,
    meta: {
      ...compiledDependencyPacketState.meta,
      toolLoop: {
        ...compiledDependencyPacketState.meta.toolLoop,
        recent: [
          ...compiledDependencyPacketState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "src/main/java/example/Reading.java",
            ok: true,
            blocked: false,
            at: "2026-08-29T12:00:04.000Z",
          },
        ],
      },
    },
  }
);
assertStrict.equal(
  compiledDependencyConsumedRuntime.testFailureRepairAuxiliaryReadAllowed,
  false,
  "a successful compiled-language dependency read reopened broad discovery"
);
const compiledDependencyConsumedTools = selectProgressiveTools(allTools, {
  config: compiledDependencyConsumedRuntime,
  goal: "Apply the Java source repair after reading the supporting type.",
  profile: "java",
});
assertStrict.deepEqual(
  compiledDependencyConsumedTools[0].function.parameters.properties.path.enum,
  ["src/main/java/example/WindowSummary.java"],
  "compiled-language recovery did not contract back to the canonical source"
);
const regeneratedSameFailurePacketRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      failedTestRecoveryPacket: {
        ...packetPathReadState.meta.failedTestRecoveryPacket,
        generatedAt: "2026-08-24T03:00:00.000Z",
      },
      failedTestFocusedRecovery: {
        ...packetPathReadState.meta.failedTestFocusedRecovery,
        at: "2026-08-24T03:00:00.000Z",
      },
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:11.000Z",
          },
          ...Array.from({ length: 4 }, (_, index) => ({
            toolName: "read_file",
            path: "service_ctl.py",
            ok: true,
            blocked: false,
            at: `2026-08-24T02:00:${12 + index}.000Z`,
          })),
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  regeneratedSameFailurePacketRuntime.testFailureRepairContextPaths,
  [],
  "regenerating an unchanged failure packet forgot source reads retained after the failure"
);
assertStrict.deepEqual(
  regeneratedSameFailurePacketRuntime.testFailureRepairOptionalRereadPaths,
  [],
  "regenerating an unchanged failure packet replenished DeepSeek's bounded reread budget"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: regeneratedSameFailurePacketRuntime,
    goal: "Apply the retained source repair after a resume boundary.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "an unchanged resumed failure reopened discovery after its reread budget was exhausted"
);
const documentationFirstRepairPacketState = {
  ...packetPathReadState,
  meta: {
    ...packetPathReadState.meta,
    failedTestRecoveryPacket: {
      ...packetPathReadState.meta.failedTestRecoveryPacket,
      paths: ["README.md", "build_cad.py"],
      repairPaths: ["README.md", "build_cad.py"],
    },
    toolLoop: {
      stagnationEpoch: 10,
      recent: [
        {
          toolName: "read_file",
          path: "README.md",
          ok: true,
          blocked: false,
          at: "2026-08-24T02:00:11.000Z",
        },
        {
          toolName: "read_file",
          path: "build_cad.py",
          ok: true,
          blocked: false,
          at: "2026-08-24T02:00:12.000Z",
        },
      ],
    },
  },
};
const documentationFirstRepairRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "code" },
  documentationFirstRepairPacketState
);
assertStrict.deepEqual(
  documentationFirstRepairRuntime.testFailureRepairOptionalRereadPaths,
  ["build_cad.py"],
  "DeepSeek repair preferred documentation over the canonical producing source"
);
const exhaustedProducerRereadRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "code" },
  {
    ...documentationFirstRepairPacketState,
    meta: {
      ...documentationFirstRepairPacketState.meta,
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          {
            toolName: "read_file",
            path: "README.md",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:11.000Z",
          },
          ...Array.from({ length: 4 }, (_, index) => ({
            toolName: "read_file",
            path: "build_cad.py",
            ok: true,
            blocked: false,
            at: `2026-08-24T02:00:${12 + index}.000Z`,
          })),
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  exhaustedProducerRereadRuntime.testFailureRepairOptionalRereadPaths,
  [],
  "exhausting the primary producer reread fell through to lower-priority documentation"
);
const documentationFirstRepairTools = selectProgressiveTools(allTools, {
  config: documentationFirstRepairRuntime,
  goal: "Repair the manifest generator after reading its bounded evidence packet.",
  profile: "code",
});
assertStrict.deepEqual(
  documentationFirstRepairTools[0].function.parameters.properties.path.enum,
  ["build_cad.py"],
  "the source-prioritized reread was not constrained to the canonical producer"
);
const sourceReferencedDependencyMessages = [
  {
    role: "assistant",
    tool_calls: [
      {
        id: "read-canonical-cad-source",
        function: { name: "read_file", arguments: '{"path":"build_cad.py"}' },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "read-canonical-cad-source",
    content: JSON.stringify({
      ok: true,
      toolName: "read_file",
      path: "build_cad.py",
      goalRevision: 11,
      pathEvidence: [
        { path: "inputs/tube_measurements.csv", source: "build_cad.py" },
        { path: "artifacts/", source: "build_cad.py" },
        { path: "/tmp/external_validator.py", source: "build_cad.py" },
        { path: "../outside.txt", source: "build_cad.py" },
        { path: ".private/token.json", source: "build_cad.py" },
      ],
    }),
  },
];
const compactedInstructionDiscoveryMessages = [
  {
    role: "user",
    content: [
      "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
      "Tool: inspect_project",
      "Arguments: {}",
      'Verified result: {"ok":true,"recommendedReads":["README.md","AGENTS.md"],"manifestFiles":[{"path":"AGENTS.md"}],"topLevel":[{"path":"README.md","type":"file"},{"path":"AGENTS.md","type":"file"}]}',
    ].join("\n"),
  },
  {
    role: "user",
    content: [
      "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
      "Tool: read_file",
      'Arguments: {"path":"README.md"}',
      'Verified result: {"ok":true,"path":"README.md","content":"project overview"}',
    ].join("\n"),
  },
  {
    role: "user",
    content: "Continue the current task from saved state: repair the CAD producer.",
  },
];
assertStrict.deepEqual(
  unreadProjectInstructionReadPaths(compactedInstructionDiscoveryMessages, {
    commandCwd: "/tmp/aginti-source-reference",
  }),
  ["AGENTS.md"],
  "a continuation boundary hid an exact unread project instruction discovered before compaction"
);
const instructionOnlyWorkspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "aginti-instruction-without-inspection-")
);
try {
  await fs.writeFile(
    path.join(instructionOnlyWorkspace, "AGENTS.md"),
    "# Project instructions\nPreserve the canonical generator.\n",
    "utf8"
  );
  assertStrict.deepEqual(
    unreadProjectInstructionReadPaths(sourceReferencedDependencyMessages, {
      commandCwd: instructionOnlyWorkspace,
    }),
    ["AGENTS.md"],
    "an existing root AGENTS.md disappeared when inspect_project evidence was compacted away"
  );
  const instructionOnlyRepairTools = selectProgressiveTools(allTools, {
    config: {
      provider: "deepseek",
      taskProfile: "code",
      commandCwd: instructionOnlyWorkspace,
      testFailureRepairActive: true,
      testFailureRepairMutationRequired: true,
      testFailureRepairOptionalRereadPaths: ["build_cad.py"],
      testFailureRepairPatchTargets: ["build_cad.py"],
    },
    goal: "Repair the canonical CAD producer while honoring project instructions.",
    profile: "code",
    messages: sourceReferencedDependencyMessages,
  });
  assert(
    instructionOnlyRepairTools[0].function.parameters.properties.path.enum.includes("AGENTS.md"),
    "failed-test recovery rejected a valid root AGENTS.md read after compaction"
  );
  sameNames(
    selectProgressiveTools(allTools, {
      config: {
        provider: "deepseek",
        taskProfile: "code",
        commandCwd: instructionOnlyWorkspace,
        testFailureRepairActive: true,
        testFailureRepairMutationRequired: true,
        testFailureRepairNeedsPatchContext: false,
        testFailureRepairOptionalRereadPaths: [],
      },
      goal: "Apply the retained canonical producer correction now.",
      profile: "code",
      messages: sourceReferencedDependencyMessages,
    }),
    ["apply_patch", "finish"],
    "consumed canonical repair evidence reopened auxiliary instruction discovery instead of requiring mutation"
  );
} finally {
  await fs.rm(instructionOnlyWorkspace, { recursive: true, force: true });
}
const sourceReferencedDependencyTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    taskProfile: "code",
    commandCwd: "/tmp/aginti-source-reference",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairOptionalRereadPaths: ["build_cad.py"],
    testFailureRepairPatchTargets: ["build_cad.py"],
  },
  goal: "Repair the canonical CAD producer from its declared input data.",
  profile: "code",
  messages: [
    ...compactedInstructionDiscoveryMessages,
    ...sourceReferencedDependencyMessages,
  ],
});
assertStrict.deepEqual(
  sourceReferencedDependencyTools[0].function.parameters.properties.path.enum,
  [
    "build_cad.py",
    "/tmp/aginti-source-reference/build_cad.py",
    "AGENTS.md",
    "/tmp/aginti-source-reference/AGENTS.md",
    "inputs/tube_measurements.csv",
    "/tmp/aginti-source-reference/inputs/tube_measurements.csv",
  ],
  "failed-test recovery did not expose both the exact project instruction and source dependency"
);
assert(
  !sourceReferencedDependencyTools[0].function.parameters.properties.path.enum.some(
    (item) => /external_validator|outside|\.private|artifacts\/$/.test(item)
  ),
  "source-reference recovery exposed an external, protected, traversing, or directory path"
);
const sourceDependencyAlreadyReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    taskProfile: "code",
    commandCwd: "/tmp/aginti-source-reference",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairOptionalRereadPaths: ["build_cad.py"],
    testFailureRepairPatchTargets: ["build_cad.py"],
  },
  goal: "Repair the canonical CAD producer after inspecting its declared input once.",
  profile: "code",
  messages: [
    ...compactedInstructionDiscoveryMessages,
    {
      role: "user",
      content: [
        "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
        "Tool: read_file",
        'Arguments: {"path":"AGENTS.md"}',
        'Verified result: {"ok":true,"path":"AGENTS.md","content":"current instructions"}',
      ].join("\n"),
    },
    ...sourceReferencedDependencyMessages,
    {
      role: "assistant",
      tool_calls: [
        {
          id: "read-canonical-cad-input",
          function: {
            name: "read_file",
            arguments: '{"path":"inputs/tube_measurements.csv"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "read-canonical-cad-input",
      content: JSON.stringify({
        ok: true,
        toolName: "read_file",
        path: "inputs/tube_measurements.csv",
        goalRevision: 11,
      }),
    },
  ],
});
assertStrict.deepEqual(
  sourceDependencyAlreadyReadTools[0].function.parameters.properties.path.enum,
  ["build_cad.py", "/tmp/aginti-source-reference/build_cad.py"],
  "already-read instruction or source dependency remained available for a repetitive read loop"
);
const continuedDeepSeekRereadRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
          {
            toolName: "read_file",
            path: "service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:13.000Z",
          },
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  continuedDeepSeekRereadRuntime.testFailureRepairOptionalRereadPaths,
  ["service_ctl.py"],
  "DeepSeek repair dropped a canonical source before bounded continuation ranges were exhausted"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: continuedDeepSeekRereadRuntime,
    goal: "Inspect the next bounded source range before the coherent repair.",
    profile: "qa",
  }),
  ["read_file", "apply_patch", "finish"],
  "DeepSeek repair did not preserve the bounded continuation-read route"
);
const exhaustedDeepSeekRereadRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    ...packetPathReadState,
    meta: {
      ...packetPathReadState.meta,
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          ...packetPathReadState.meta.toolLoop.recent,
          {
            toolName: "read_file",
            path: "tests/test_service_ctl.py",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:12.000Z",
          },
          ...[13, 14, 15].map((second, index) => ({
            toolName: "read_file",
            path: "service_ctl.py",
            ok: true,
            blocked: false,
            at: `2026-08-24T02:00:${second}.000Z`,
            startLine: 101 + index * 100,
            lineLimit: 100,
          })),
        ],
      },
    },
  }
);
assertStrict.deepEqual(
  exhaustedDeepSeekRereadRuntime.testFailureRepairOptionalRereadPaths,
  [],
  "DeepSeek repair kept reopening a canonical source after four bounded reads"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: exhaustedDeepSeekRereadRuntime,
    goal: "Apply the coherent source repair after bounded source coverage.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "DeepSeek repair did not close source discovery after the bounded read limit"
);
const topologyStalemateState = {
  ...packetPathReadState,
  meta: {
    ...packetPathReadState.meta,
    requiredSymbolRepair: {
      version: 1,
      owner: "service_ctl",
      symbol: "launch_service",
      path: "service_ctl.py",
      contracts: [
        { owner: "service_ctl", symbol: "launch_service", path: "service_ctl.py" },
        { owner: "service_ctl", symbol: "wait_until_healthy", path: "service_ctl.py" },
      ],
      mutationRevision: 7,
      failureSignature: "packet-path-failure",
      topologyRetry: {
        count: 3,
        violations: ["launch_service is still absent"],
      },
    },
    toolLoop: {
      stagnationEpoch: 10,
      recent: [
        ...packetPathReadState.meta.toolLoop.recent,
        {
          toolName: "read_file",
          path: "tests/test_service_ctl.py",
          ok: true,
          blocked: false,
          at: "2026-08-24T02:00:12.000Z",
        },
      ],
    },
  },
};
const topologyStalemateRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  topologyStalemateState
);
assertStrict.equal(
  topologyStalemateRuntime.testFailureStalemateRevalidation,
  true,
  "repeated semantic topology rejection did not open one exact stale-evidence verifier"
);
const topologyStalemateTools = selectProgressiveTools(allTools, {
  config: topologyStalemateRuntime,
  goal: "Refresh stale failed-test evidence after repeated semantic rejection.",
  profile: "qa",
});
sameNames(
  topologyStalemateTools,
  ["run_command", "finish"],
  "topology stalemate revalidation exposed tools beyond the exact verifier"
);
assertStrict.deepEqual(
  topologyStalemateTools[0].function.parameters.properties.command.enum,
  ["python3 -m unittest discover -s tests -v"],
  "topology stalemate revalidation lost the exact retained verifier"
);
const consumedTopologyStalemateRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    ...topologyStalemateState,
    meta: {
      ...topologyStalemateState.meta,
      failedTestStalemateRevalidation: {
        version: 1,
        mutationRevision: 7,
        failureSignature: "packet-path-failure",
        command: "python3 -m unittest discover -s tests -v",
        topologyRetryCount: 3,
      },
    },
  }
);
assertStrict.equal(
  consumedTopologyStalemateRuntime.testFailureStalemateRevalidation,
  undefined,
  "one stale-evidence verifier reopened without new topology rejection evidence"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: consumedTopologyStalemateRuntime,
    goal: "Return to the canonical source repair after revalidation.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "consumed topology revalidation did not return to bounded mutation"
);
const focusedPatchRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 5,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 5,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "focused-failure",
          },
        ],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 5,
        failureSignature: "focused-failure",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 5,
        failureSignature: "focused-failure",
        at: "2026-08-24T02:00:00.000Z",
        focuses: [
          {
            path: "report.md",
            decisiveLine: 2,
            directSearch: "The earlier marker is incorrect.",
            left: "correct",
            operator: "<",
            right: "incorrect",
            caseFolded: true,
          },
          {
            kind: "membership",
            path: "report.md",
            decisiveLine: 2,
            directSearch: "The earlier marker is incorrect.",
            literal: "required marker",
            negated: false,
            anchorLiteral: "earlier marker",
            caseFolded: true,
          },
        ],
      },
      toolLoop: {
        stagnationEpoch: 10,
        recent: [
          {
            category: "failed-test-irrelevant-patch",
            failureSignature: "focused-failure",
            failedTestMutationRevision: 5,
            ok: false,
            blocked: true,
            at: "2026-08-24T02:00:01.000Z",
          },
          {
            category: "failed-test-irrelevant-patch",
            failureSignature: "focused-failure",
            failedTestMutationRevision: 5,
            ok: false,
            blocked: true,
            at: "2026-08-24T02:00:02.000Z",
          },
          {
            toolName: "read_file",
            ok: true,
            blocked: false,
            at: "2026-08-24T02:00:03.000Z",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.deepEqual(
  focusedPatchRepairRuntime.testFailureRepairPatchTargets,
  [
    {
      kind: "index-comparison",
      path: "report.md",
      search: "The earlier marker is incorrect.",
      line: 2,
      left: "correct",
      operator: "<",
      right: "incorrect",
      literal: "",
      anchorLiteral: "",
      negated: false,
      caseFolded: true,
    },
    {
      kind: "membership",
      path: "report.md",
      search: "The earlier marker is incorrect.",
      line: 2,
      left: "",
      operator: "",
      right: "",
      literal: "required marker",
      anchorLiteral: "earlier marker",
      negated: false,
      caseFolded: true,
    },
  ],
  "repeated evidence-proven late patches did not activate a generic focused repair target"
);
const focusedPatchRepairTools = selectProgressiveTools(allTools, {
  config: focusedPatchRepairRuntime,
  goal: "Repair the exact earlier occurrence after repeated irrelevant patches.",
  profile: "qa",
});
sameNames(
  focusedPatchRepairTools,
  ["apply_patch", "finish"],
  "focused failed-test repair reopened unrelated tools"
);
const focusedApplyPatch = focusedPatchRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
const focusedReplacementDescription =
  focusedApplyPatch.function.parameters.properties.replace.description;
assertStrict.deepEqual(
  focusedApplyPatch.function.parameters.properties.path.enum,
  ["report.md"],
  "focused failed-test repair did not constrain the exact task-owned path"
);
assertStrict.ok(
  focusedReplacementDescription.includes('first "correct" < first "incorrect"') &&
    focusedReplacementDescription.includes("appending later text is insufficient") &&
    focusedReplacementDescription.includes('"required marker" must appear'),
  "focused failed-test repair dropped one of multiple evidence-derived constraints on the same line"
);
assertStrict.ok(
  focusedApplyPatch.function.parameters.properties.replace.pattern === undefined &&
    focusedReplacementDescription.includes("natural project content") &&
    !focusedApplyPatch.function.description.includes("The earlier marker is incorrect."),
  "focused failed-test repair should explain natural artifact content without a brittle phrase blacklist"
);
assertStrict.deepEqual(
  focusedApplyPatch.function.parameters.required,
  ["path", "search", "replace"],
  "focused exact patch repair allowed the model to omit its runtime-selected anchor"
);
assertStrict.deepEqual(
  focusedApplyPatch.function.parameters.properties.search.enum,
  ["The earlier marker is incorrect."],
  "focused failed-test repair did not constrain the evidence-derived decisive line"
);
const tracebackRepairLine =
  '        lines.append(f"| {name} | {path.stat().st_size} |")';
const tracebackRepairRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "cad", commandCwd: repoRoot },
  {
    meta: {
      taskProfile: "cad",
      projectVerification: {
        taskProfile: "cad",
        mutationRevision: 9,
        requiredOutputs: ["package.json"],
        testRuns: [{
          command: "python3 validate.py --root .",
          mutationRevision: 9,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "deepest-traceback-line",
          failureSummary: "package manifest rebuild failed at the deepest traceback line",
          at: "2026-08-29T03:59:59.000Z",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 9,
        failureSignature: "deepest-traceback-line",
        content: "Bounded failed-test evidence packet v17.",
        paths: ["README.md", "build_cad.py", "inputs/tube_measurements.csv"],
        generatedAt: "2026-08-29T04:00:00.000Z",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 9,
        failureSignature: "deepest-traceback-line",
        at: "2026-08-29T04:00:00.000Z",
        focuses: [{
          kind: "failed-test-traceback-line",
          path: "build_cad.py",
          decisiveLine: 398,
          directSearch: tracebackRepairLine,
        }, {
          kind: "generated-artifact-semantic-producer",
          path: "build_cad.py",
          decisiveLine: 412,
          directSearch: "    json_payload = {\n        'artifacts': [],\n    }",
        }],
      },
      toolLoop: { stagnationEpoch: 12, recent: [] },
    },
    messages: [],
  }
);
assertStrict.deepEqual(
  tracebackRepairRuntime.testFailureRepairPatchTargets,
  [{
    kind: "failed-test-traceback-line",
    path: "build_cad.py",
    search: tracebackRepairLine,
    line: 398,
    left: "",
    operator: "",
    right: "",
    literal: "",
    anchorLiteral: "",
    negated: false,
    caseFolded: false,
  }],
  "the deepest current traceback line did not outrank a broad semantic producer focus"
);
assertStrict.deepEqual(
  {
    canonical: tracebackRepairRuntime.testFailureCanonicalRepairPaths,
    context: tracebackRepairRuntime.testFailureRepairContextPaths,
    diagnostic: tracebackRepairRuntime.testFailureDiagnosticReadPaths,
    externalDiagnostic: tracebackRepairRuntime.testFailureExternalDiagnosticReadPaths,
    optional: tracebackRepairRuntime.testFailureRepairOptionalRereadPaths,
    workspaceDiagnostic: tracebackRepairRuntime.testFailureWorkspaceDiagnosticReadPaths,
  },
  {
    canonical: [],
    context: [],
    diagnostic: [],
    externalDiagnostic: [],
    optional: [],
    workspaceDiagnostic: [],
  },
  "an authoritative traceback repair retained contradictory ancillary read paths"
);
const tracebackRepairTools = selectProgressiveTools(allTools, {
  config: tracebackRepairRuntime,
  goal: "Repair the current isolated CAD rebuild failure.",
  profile: "cad",
});
sameNames(
  tracebackRepairTools,
  ["rewrite_text_excerpt", "finish"],
  "the exact traceback repair exposed a schema-fragile apply_patch surface"
);
const tracebackRewrite = tracebackRepairTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.deepEqual(
  Object.keys(tracebackRewrite.function.parameters.properties),
  ["revisedText"],
  "the traceback repair still required DeepSeek to reproduce runtime-owned path/search arguments"
);
assertStrict.equal(
  tracebackRewrite.function.parameters.properties.revisedText.maxLength,
  6000,
  "the traceback replacement was not bounded to a small coherent source edit"
);
const tracebackContract = createToolContract([tracebackRewrite]);
const tracebackProposal = contractCall(
  "deepseek-traceback-block",
  "rewrite_text_excerpt",
  {
    revisedText: [
      "        if path.exists():",
      '            lines.append(f"| {name} | {path.stat().st_size} |")',
    ].join("\n"),
  }
);
assert(
  resolveDispatchableToolCallBatch([tracebackProposal], tracebackContract).ok,
  "a small DeepSeek traceback repair block was rejected before runtime anchor binding"
);
const pythonGuardRepairSearch = [
  "if __name__ == '__main__':",
  "    raise SystemExit(main())",
  "",
  "def start_service():",
  "    return 0",
  "",
].join("\n");
const pythonGuardRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 8,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 8,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-main-guard-order",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 8,
        failureSignature: "python-main-guard-order",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 8,
        failureSignature: "python-main-guard-order",
        at: "2026-08-26T18:00:00.000Z",
        focuses: [{
          kind: "python-main-guard-order",
          path: "service_ctl.py",
          decisiveLine: 90,
          directSearch: pythonGuardRepairSearch,
          calledLater: [
            { name: "start_service", line: 94 },
            { name: "stop_service", line: 140 },
          ],
        }, {
          kind: "python-main-guard-order",
          path: "service_ctl.py",
          decisiveLine: 120,
          directSearch: [
            "if __name__ == '__main__':",
            "    raise SystemExit(main())",
            "",
            "def stop_service():",
            "    return 0",
            "",
          ].join("\n"),
          calledLater: [{ name: "stop_service", line: 140 }],
        }],
      },
      requiredSymbolRepair: {
        version: 1,
        owner: "service_ctl",
        symbol: "launch_service",
        path: "service_ctl.py",
        mutationRevision: 8,
        failureSignature: "python-main-guard-order",
        topologyRetry: { count: 3 },
      },
      toolLoop: {
        stagnationEpoch: 11,
        recent: [],
        patchContextRepair: {
          version: 1,
          path: "service_ctl.py",
          search: "def start_service():\n    return 1\n",
          searchHash: "stale-anchor-hash",
          mutationRevision: 8,
          privateMutationRevision: 0,
        },
      },
    },
    messages: [],
  }
);
assertStrict.deepEqual(
  pythonGuardRepairRuntime.testFailureRepairPatchTargets,
  [{
    kind: "python-main-guard-order",
    path: "service_ctl.py",
    search: pythonGuardRepairSearch,
    line: 90,
    left: "",
    operator: "",
    right: "",
    literal: "",
    anchorLiteral: "",
    negated: false,
    caseFolded: false,
    calledLater: [
      { name: "start_service", line: 94 },
      { name: "stop_service", line: 140 },
    ],
  }],
  "a deterministic Python entrypoint-order defect did not activate an immediate focused patch target"
);
assertStrict.equal(
  pythonGuardRepairRuntime.patchContextRepairRequired,
  undefined,
  "a stale narrow patch-context marker outranked the current deterministic topology repair"
);
assertStrict.equal(
  pythonGuardRepairRuntime.testFailureStalemateRevalidation,
  undefined,
  "a stale topology retry counter outranked the current deterministic topology repair"
);
const pythonGuardRepairTools = selectProgressiveTools(allTools, {
  config: pythonGuardRepairRuntime,
  goal: "Repair the retained Python entrypoint-order failure.",
  profile: "qa",
});
sameNames(
  pythonGuardRepairTools,
  ["rewrite_text_excerpt", "finish"],
  "Python entrypoint-order repair exposed unrelated tools"
);
const pythonGuardApplyPatch = pythonGuardRepairTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.deepEqual(
  Object.keys(pythonGuardApplyPatch.function.parameters.properties),
  ["revisedText"],
  "Python entrypoint-order repair exposed its large runtime-owned path or source anchor"
);
assertStrict.ok(
  pythonGuardApplyPatch.function.parameters.properties.revisedText.description.includes(
    "one complete __main__ guard moved after start_service (line 94), stop_service (line 140)"
  ) &&
    pythonGuardApplyPatch.function.parameters.properties.revisedText.description.includes(
      "Adding a comment"
    ) &&
    pythonGuardApplyPatch.function.parameters.properties.revisedText.maxLength === 24000 &&
    pythonGuardApplyPatch.function.parameters.required.join(",") === "revisedText",
  "Python entrypoint-order repair omitted the structural move contract"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: {
      ...pythonGuardRepairRuntime,
      completionFreshMutationRequired: true,
      completionFreshMutationPaths: ["service_ctl.py"],
    },
    goal: "Repair the retained Python entrypoint-order failure.",
    profile: "qa",
  }),
  ["rewrite_text_excerpt", "finish"],
  "a generic completion-freshness gate outranked the authoritative current failed-test repair"
);
const duplicateSourceRepairSearch = [
  "def status_service():",
  "    return 'old'",
  "",
  "def status_service():",
  "    return 'current'",
  "",
  "def main():",
  "    return status_service()",
  "",
].join("\n");
const duplicateSourceRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 9,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 9,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-duplicate-source",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 9,
        failureSignature: "python-duplicate-source",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 9,
        failureSignature: "python-duplicate-source",
        at: "2026-08-26T19:00:00.000Z",
        focuses: [{
          kind: "python-duplicate-top-level-definition",
          path: "service_ctl.py",
          decisiveLine: 1,
          directSearch: duplicateSourceRepairSearch,
          duplicateDeclarations: [{
            kind: "def",
            name: "status_service",
            count: 2,
            lines: [1, 4],
          }],
        }],
      },
      toolLoop: {
        stagnationEpoch: 12,
        recent: [],
        patchContextRepair: {
          version: 1,
          path: "service_ctl.py",
          search: "def status_service():\n    return 'old'\n",
          searchHash: "stale-duplicate-anchor",
          mutationRevision: 9,
          privateMutationRevision: 0,
        },
      },
    },
    messages: [],
  }
);
assertStrict.deepEqual(
  duplicateSourceRepairRuntime.testFailureRepairPatchTargets,
  [{
    kind: "python-duplicate-top-level-definition",
    path: "service_ctl.py",
    search: duplicateSourceRepairSearch,
    line: 1,
    left: "",
    operator: "",
    right: "",
    literal: "",
    anchorLiteral: "",
    negated: false,
    caseFolded: false,
    duplicateDeclarations: [{
      kind: "def",
      name: "status_service",
      count: 2,
      lines: [1, 4],
    }],
  }],
  "duplicate production declarations did not activate a focused full-source repair"
);
assertStrict.equal(
  duplicateSourceRepairRuntime.patchContextRepairRequired,
  undefined,
  "a stale narrow patch-context marker outranked deterministic duplicate cleanup"
);
const duplicateSourceRepairTools = selectProgressiveTools(allTools, {
  config: duplicateSourceRepairRuntime,
  goal: "Consolidate duplicate production declarations without weakening tests.",
  profile: "qa",
});
sameNames(
  duplicateSourceRepairTools,
  ["rewrite_text_excerpt", "finish"],
  "duplicate source cleanup exposed unrelated tools"
);
const duplicateSourceRewrite = duplicateSourceRepairTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.ok(
  duplicateSourceRewrite.function.parameters.properties.revisedText.description.includes(
    "exactly one top-level implementation"
  ) &&
    duplicateSourceRewrite.function.parameters.properties.revisedText.description.includes(
      "def status_service (2 copies at lines 1, 4)"
    ) &&
    duplicateSourceRewrite.function.parameters.properties.revisedText.maxLength === 24000,
  "duplicate source cleanup omitted its structural consolidation contract"
);
const baselineRecoverySearch = [
  "def start_service(root: Path):",
  "    return True",
  "",
  "if __name__ == '__main__':",
  "    raise SystemExit(main())",
  "",
].join("\n");
const baselineRecoveryRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 10,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 10,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "python-baseline-recovery",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 10,
        failureSignature: "python-baseline-recovery",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 10,
        failureSignature: "python-baseline-recovery",
        at: "2026-08-26T19:30:00.000Z",
        focuses: [{
          kind: "python-git-baseline-recovery",
          path: "service_ctl.py",
          decisiveLine: 1,
          directSearch: baselineRecoverySearch,
          baselineDeclarations: [
            { kind: "def", name: "build_service_command", count: 1 },
            { kind: "def", name: "launch_service", count: 1 },
            { kind: "def", name: "start_service", count: 1 },
            { kind: "def", name: "main", count: 1 },
          ],
          missingDeclarations: [
            { kind: "def", name: "build_service_command" },
            { kind: "def", name: "launch_service" },
            { kind: "def", name: "main" },
          ],
        }],
      },
      toolLoop: {
        stagnationEpoch: 13,
        recent: [],
        patchContextRepair: {
          version: 1,
          path: "service_ctl.py",
          search: "def start_service(root: Path):\n",
          searchHash: "stale-truncated-anchor",
          mutationRevision: 10,
          privateMutationRevision: 0,
        },
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  baselineRecoveryRuntime.testFailureRepairPatchTargets?.[0]?.kind,
  "python-git-baseline-recovery",
  "a severe tracked-source regression did not activate focused baseline reconstruction"
);
assertStrict.deepEqual(
  baselineRecoveryRuntime.testFailureRepairPatchTargets?.[0]?.missingDeclarations,
  [
    { kind: "def", name: "build_service_command" },
    { kind: "def", name: "launch_service" },
    { kind: "def", name: "main" },
  ],
  "baseline reconstruction lost its exact missing-declaration contract"
);
assertStrict.equal(
  baselineRecoveryRuntime.patchContextRepairRequired,
  undefined,
  "a stale narrow patch-context marker outranked exact baseline reconstruction"
);
const baselineRecoveryTools = selectProgressiveTools(allTools, {
  config: baselineRecoveryRuntime,
  goal: "Recover the complete tracked source and retain intended task repairs.",
  profile: "qa",
});
sameNames(
  baselineRecoveryTools,
  ["rewrite_text_excerpt", "finish"],
  "tracked baseline reconstruction exposed unrelated tools"
);
const baselineRecoveryRewrite = baselineRecoveryTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.ok(
  baselineRecoveryRewrite.function.parameters.properties.revisedText.description.includes(
    "version-controlled baseline recovery"
  ) &&
    baselineRecoveryRewrite.function.parameters.properties.revisedText.description.includes(
      "def build_service_command"
    ) &&
    baselineRecoveryRewrite.function.parameters.properties.revisedText.description.includes(
      "do not blindly revert"
    ) &&
    baselineRecoveryRewrite.function.parameters.properties.revisedText.maxLength === 24000,
  "tracked baseline reconstruction omitted its complete-source repair contract"
);
const harnessPathSearch = 'SERVICE_CTL = "../service_ctl.py"';
const harnessPathReplacement =
  'SERVICE_CTL = (Path(__file__).resolve().parent / "../service_ctl.py").resolve()';
const harnessPathRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 11,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 11,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "agent-created-test-harness-path",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 11,
        failureSignature: "agent-created-test-harness-path",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 11,
        failureSignature: "agent-created-test-harness-path",
        at: "2026-08-26T20:30:00.000Z",
        focuses: [{
          kind: "python-agent-test-harness-path",
          path: "tests/test_service_lifecycle.py",
          decisiveLine: 6,
          directSearch: harnessPathSearch,
          directReplacement: harnessPathReplacement,
          expectedWorkspacePath: "service_ctl.py",
          symbol: "SERVICE_CTL",
          testNames: ["test_start", "test_stop"],
          assertionCount: 4,
        }],
      },
      toolLoop: { stagnationEpoch: 14, recent: [] },
    },
    messages: [],
  }
);
assertStrict.equal(
  harnessPathRuntime.testFailureRepairPatchTargets?.[0]?.kind,
  "python-agent-test-harness-path",
  "an agent-created test harness path defect did not activate its bounded repair"
);
assertStrict.equal(
  harnessPathRuntime.testFailureRepairPatchTargets?.[0]?.directReplacement,
  harnessPathReplacement,
  "the exact cwd-independent test harness binding was not retained"
);
const harnessPathTools = selectProgressiveTools(allTools, {
  config: harnessPathRuntime,
  goal: "Repair the retained lifecycle verification without weakening its tests.",
  profile: "qa",
});
sameNames(
  harnessPathTools,
  ["rewrite_text_excerpt", "finish"],
  "agent-created test harness path recovery exposed unrelated tools"
);
const harnessPathRewrite = harnessPathTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.deepEqual(
  harnessPathRewrite.function.parameters.properties.revisedText.enum,
  [harnessPathReplacement],
  "the test harness repair did not constrain the local model to the one safe binding"
);
assertStrict.ok(
  harnessPathRewrite.function.parameters.properties.revisedText.description.includes(
    "preserving all 2 test methods and 4 assertion lines"
  ) &&
    harnessPathRewrite.function.description.includes("agent-created Python test"),
  "the test harness repair omitted its assertion-preservation boundary"
);
const portCollisionSearch = [
  "import socket",
  "import unittest",
  "",
  "class TestLifecycle(unittest.TestCase):",
  "    def test_start(self):",
  "        result = run_service('--port', '8765')",
  "        self.assertEqual(result.returncode, 0)",
  "",
].join("\n");
const portCollisionRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 12,
        testRuns: [{
          command: "python -m unittest discover -s tests -v",
          mutationRevision: 12,
          passed: false,
          failureEvidenceVersion: 2,
          failureSignature: "agent-created-test-port-collision",
        }],
      },
      failedTestRecoveryPacket: {
        packetVersion: 17,
        mutationRevision: 12,
        failureSignature: "agent-created-test-port-collision",
        content: "Bounded failed-test evidence packet v17.",
      },
      failedTestDiagnostic: {
        packetVersion: 17,
        mutationRevision: 12,
        failureSignature: "agent-created-test-port-collision",
        at: "2026-08-27T09:00:00.000Z",
        focuses: [{
          kind: "python-agent-test-foreign-port-collision",
          path: "tests/test_service_lifecycle.py",
          decisiveLine: 6,
          directSearch: portCollisionSearch,
          ports: [8765],
          portOccurrences: 4,
          listenerEvidence: [{
            port: 8765,
            processName: "python3",
            ownership: "outside-task-workspace",
          }],
          testNames: ["test_start", "test_restart"],
          assertionCount: 5,
          assertionMethods: [
            "assertEqual",
            "assertTrue",
            "assertEqual",
            "assertNotEqual",
            "assertTrue",
          ],
        }],
      },
      toolLoop: { stagnationEpoch: 15, recent: [] },
    },
    messages: [],
  }
);
assertStrict.equal(
  portCollisionRuntime.testFailureRepairPatchTargets?.[0]?.kind,
  "python-agent-test-foreign-port-collision",
  "a foreign listener collision in a Git-new test did not activate bounded test isolation"
);
assertStrict.deepEqual(
  portCollisionRuntime.testFailureRepairPatchTargets?.[0]?.ports,
  [8765],
  "the focused test repair lost the exact occupied port evidence"
);
const portCollisionTools = selectProgressiveTools(allTools, {
  config: portCollisionRuntime,
  goal: "Keep a foreign service alive while isolating the task-owned lifecycle test.",
  profile: "qa",
});
sameNames(
  portCollisionTools,
  ["rewrite_text_excerpt", "finish"],
  "foreign-port test isolation exposed unrelated tools"
);
const portCollisionRewrite = portCollisionTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
assertStrict.ok(
  portCollisionRewrite.function.parameters.properties.revisedText.description.includes(
    "socket.bind(('127.0.0.1', 0))"
  ) &&
    portCollisionRewrite.function.parameters.properties.revisedText.description.includes(
      "Do not skip tests"
    ) &&
    portCollisionRewrite.function.description.includes("foreign-port evidence") &&
    portCollisionRewrite.function.parameters.properties.revisedText.maxLength === 24000,
  "foreign-port test isolation omitted its dynamic-port or integrity contract"
);
const separatorRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "membership",
        path: "report.md",
        search: "Keep the required-marker beside the verified value.",
        line: 3,
        literal: "required marker",
        anchorLiteral: "verified value",
        negated: false,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained exact membership failure.",
  profile: "qa",
});
const separatorRepairPatch = separatorRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
assertStrict.deepEqual(
  separatorRepairPatch.function.parameters.properties.replace.enum,
  ["Keep the required marker beside the verified value."],
  "an unambiguous separator-only membership repair was not exposed as an exact evidence-derived value"
);
assertStrict.ok(
  separatorRepairPatch.function.parameters.properties.replace.description.includes(
    "single lossless separator normalization"
  ),
  "the exact separator repair omitted its generic rationale"
);
const duplicateLineRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "index-comparison",
        path: "report.md",
        search: "Repeated summary line.\nUnique neighboring context.",
        line: 1,
        left: "later marker",
        operator: "<",
        right: "repeated summary",
        decisiveText: "Repeated summary line.",
        decisiveSide: "right",
        decisiveDuplicateCount: 3,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained first-match relation without duplicating content.",
  profile: "qa",
});
const duplicateLineRepairPatch = duplicateLineRepairTools.find(
  (tool) => tool.function.name === "apply_patch"
);
assertStrict.deepEqual(
  duplicateLineRepairPatch.function.parameters.properties.replace.enum,
  ["Unique neighboring context."],
  "a duplicated decisive line did not yield one lossless evidence-derived removal"
);
assertStrict.ok(
  duplicateLineRepairPatch.function.parameters.properties.replace.description.includes(
    "single lossless duplicate-line removal"
  ),
  "the duplicate-line repair omitted its generic rationale"
);
const prematureOperandRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRepairPatchTargets: [
      {
        kind: "index-comparison",
        path: "notes.md",
        search: "A carefully preloaded summary.",
        line: 4,
        left: "baseline",
        operator: "<",
        right: "load",
        decisiveText: "A carefully preloaded summary.",
        decisiveSide: "right",
        decisiveDuplicateCount: 1,
        caseFolded: true,
      },
    ],
  },
  goal: "Repair the retained first-match relation using natural prose.",
  profile: "qa",
});
const prematureOperandRepairPatch = prematureOperandRepairTools.find(
  (tool) => tool.function.name === "rewrite_text_excerpt"
);
const prematureOperandReplace =
  prematureOperandRepairPatch.function.parameters.properties.revisedText;
assertStrict.deepEqual(
  Object.keys(prematureOperandRepairPatch.function.parameters.properties),
  ["revisedText"],
  "a single evidence-selected prose repair still exposed redundant path and anchor arguments"
);
assertStrict.deepEqual(
  prematureOperandRepairPatch.function.parameters.required,
  ["revisedText"],
  "the replacement-only focused repair did not require revised text"
);
assertStrict.ok(
  prematureOperandRepairPatch.function.description.includes("not the whole file"),
  "the focused rewrite alias did not distinguish one excerpt from a whole-file replacement"
);
assertStrict.ok(
  typeof prematureOperandReplace.pattern === "string" &&
    !new RegExp(prematureOperandReplace.pattern).test("A carefully preloaded summary.") &&
    !new RegExp(prematureOperandReplace.pattern).test("A preloaded summary after the baseline.") &&
    new RegExp(prematureOperandReplace.pattern).test("A concise technical summary.") &&
    new RegExp(prematureOperandReplace.pattern).test("A baseline precedes the preloaded summary."),
  "a single premature comparison operand was not constrained by the evidence-derived relation"
);
assertStrict.ok(
  prematureOperandReplace.description.includes('premature operand "load"') &&
    prematureOperandReplace.description.includes('"pre[load]ed"') &&
    prematureOperandReplace.description.includes("place the required counterpart before") &&
    !prematureOperandReplace.description.includes("preloaded summary"),
  "premature-operand guidance omitted the containing-token evidence or leaked the full fixture prose"
);
const patchContextRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: mutationGatedRepairRuntime.testFailureRepairActive
        ? {
            mutationRevision: 0,
            testRuns: [
              {
                command: "python -m pytest -q",
                mutationRevision: 0,
                passed: false,
                failureEvidenceVersion: 2,
                failureSignature: "baseline-failure",
              },
            ],
          }
        : {},
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            toolName: "run_command",
            ok: false,
            stagnationEpoch: 4,
          },
          {
            category: "workspace-patch",
            toolName: "apply_patch",
            ok: false,
            error: "Patch made no changes to report.md.",
            stagnationEpoch: 4,
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  patchContextRepairRuntime.testFailureRepairNeedsPatchContext,
  true,
  "a no-op repair patch did not request one bounded diagnostic source turn"
);
const exactStalePatchRefreshTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    patchContextRefreshRequired: true,
    patchContextRefreshPath: "service_ctl.py",
  },
  goal: "Repair the service lifecycle from current source.",
  profile: "qa",
});
sameNames(
  exactStalePatchRefreshTools,
  ["read_file"],
  "stale patch recovery exposed mutation tools before an exact current-source read"
);
assertStrict.deepEqual(
  exactStalePatchRefreshTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "stale patch recovery did not constrain read_file to the exact affected source"
);
assertStrict.deepEqual(
  Object.keys(exactStalePatchRefreshTools[0].function.parameters.properties),
  ["path"],
  "stale patch recovery still allowed a partial range that could omit the repair site"
);
assertStrict.deepEqual(
  exactStalePatchRefreshTools[0].function.parameters.required,
  ["path"],
  "stale patch recovery did not require the one complete exact source path"
);
const exactCurrentRepairAnchor = [
  "def start_service(state_dir: Path, host: str, port: int) -> int:",
  "    state_dir.mkdir(parents=True, exist_ok=True)",
  "    pid_file = state_dir / \"gateway.pid\"",
  "    prior_pid = read_pid(pid_file)",
  "    return 0",
  "",
].join("\n");
const exactStalePatchRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    patchContextRepairRequired: true,
    patchContextRepairPath: "service_ctl.py",
    patchContextRepairSearch: exactCurrentRepairAnchor,
    patchContextRepairSearchHash: "anchor-hash",
    patchContextRepairAnchorIdentity: "start_service",
    patchContextRepairLineStart: 50,
    patchContextRepairLineEnd: 55,
  },
  goal: "Repair the service lifecycle from current source.",
  profile: "qa",
});
sameNames(
  exactStalePatchRepairTools,
  ["apply_patch"],
  "fresh stale-patch recovery reopened source reading after the runtime had already supplied an exact current anchor"
);
assertStrict.deepEqual(
  exactStalePatchRepairTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "fresh stale-patch recovery did not bind the exact affected path"
);
assertStrict.deepEqual(
  exactStalePatchRepairTools[0].function.parameters.properties.search.enum,
  undefined,
  "fresh stale-patch recovery still required the provider to serialize the exact current-source anchor"
);
assertStrict.deepEqual(
  exactStalePatchRepairTools[0].function.parameters.properties.expectedReplacements.enum,
  [1],
  "fresh stale-patch recovery did not require one transactional replacement"
);
assertStrict.deepEqual(
  exactStalePatchRepairTools[0].function.parameters.required,
  ["replace"],
  "fresh stale-patch recovery did not reduce the provider contract to the authored replacement"
);
const explicitRepairRereadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    patchContextRepairRequired: true,
    patchContextRepairPath: "service_ctl.py",
    patchContextRepairSearch: exactCurrentRepairAnchor,
    patchContextRepairSearchHash: "anchor-hash",
    patchContextRepairAnchorIdentity: "start_service",
    patchContextRepairRereadAllowed: true,
  },
  goal: "Refresh a specifically invalidated repair anchor once.",
  profile: "qa",
});
sameNames(
  explicitRepairRereadTools,
  ["apply_patch", "read_file"],
  "an explicit exceptional repair reread was not retained"
);
assertStrict.deepEqual(
  explicitRepairRereadTools[1].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "an explicit exceptional repair reread escaped the exact affected path"
);
const exactStalePatchAfterReadTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    patchContextRepairRequired: true,
    patchContextRepairPath: "service_ctl.py",
    patchContextRepairSearch: exactCurrentRepairAnchor,
    patchContextRepairSearchHash: "anchor-hash",
    patchContextRepairAnchorIdentity: "start_service",
    patchContextRepairReadCount: 1,
  },
  goal: "Repair the service lifecycle from current source.",
  profile: "qa",
});
sameNames(
  exactStalePatchAfterReadTools,
  ["apply_patch"],
  "bounded patch recovery allowed a second exact source reread"
);
assertStrict.match(
  exactStalePatchRepairTools[0].function.description,
  /state_dir\.mkdir\(parents=True, exist_ok=True\)/,
  "fresh stale-patch recovery did not expose the exact current anchor as read-only provider context"
);
assertStrict.match(
  exactStalePatchRepairTools[0].function.description,
  /Do not include file headers, imports, or declarations outside the shown anchor/,
  "fresh stale-patch recovery did not communicate its structural replacement boundary"
);
assertStrict.equal(
  exactStalePatchRepairTools[0].function.parameters.properties.patch,
  undefined,
  "fresh stale-patch recovery still exposed a unified-patch escape hatch"
);
const missingSymbolRepairTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testFailureRepairActive: true,
    testFailureRepairMutationRequired: true,
    testFailureRequiredSymbolRepair: {
      kind: "python-patch-object",
      owner: "service_ctl",
      symbol: "launch_service",
      path: "service_ctl.py",
      contracts: [
        {
          kind: "python-patch-object",
          owner: "service_ctl",
          symbol: "launch_service",
          path: "service_ctl.py",
        },
        {
          kind: "python-patch-object",
          owner: "service_ctl",
          symbol: "wait_until_healthy",
          path: "service_ctl.py",
        },
      ],
      topologyRetry: {
        count: 1,
        violations: [
          "launch_service: declared once but not called from production code outside its own definition",
          "wait_until_healthy: declared once but not called from production code outside its own definition",
        ],
        replacementRequirements: [
          { symbol: "launch_service", minimumOccurrences: 2 },
          { symbol: "wait_until_healthy", minimumOccurrences: 2 },
        ],
      },
    },
  },
  goal: "Implement the missing service launch seam required by the retained test.",
  profile: "qa",
});
sameNames(
  missingSymbolRepairTools,
  ["apply_patch", "finish"],
  "missing-symbol recovery exposed unrelated tools instead of one bounded mutation lane"
);
assertStrict.deepEqual(
  missingSymbolRepairTools[0].function.parameters.properties.path.enum,
  ["service_ctl.py"],
  "missing-symbol recovery did not constrain mutation to the canonical implementation source"
);
assertStrict.ok(
  missingSymbolRepairTools[0].function.description.includes("service_ctl.launch_service") &&
    missingSymbolRepairTools[0].function.description.includes("service_ctl.wait_until_healthy") &&
    missingSymbolRepairTools[0].function.description.includes("route the tested production path through it"),
  "the mutation tool omitted the retained missing-symbol acceptance contract"
);
assertStrict.ok(
  missingSymbolRepairTools[0].function.parameters.properties.replace.description
    .slice(0, 320)
    .includes("declare each seam exactly once and call each from the tested production path"),
  "the schema diagnostic prefix still truncates the decisive seam topology"
);
assertStrict.equal(
  missingSymbolRepairTools[0].function.parameters.properties.replace.pattern,
  undefined,
  "semantic source topology leaked into a brittle JSON-schema regex instead of the deterministic patch gate"
);
assertStrict.ok(
  missingSymbolRepairTools[0].function.parameters.properties.replace.description.includes(
    "wait_until_healthy at least 2 times"
  ),
  "the schema guidance lost the concrete rejected-candidate reference counts"
);
const consumedPatchContextRepairRuntime = nextStepRuntimeConfig(
  { provider: "localllm", taskProfile: "qa" },
  {
    meta: {
      projectVerification: {
        mutationRevision: 0,
        testRuns: [
          {
            command: "python -m pytest -q",
            mutationRevision: 0,
            passed: false,
            failureEvidenceVersion: 2,
            failureSignature: "baseline-failure",
          },
        ],
      },
      testFailurePatchContext: {
        mutationRevision: 0,
        failureSignature: "baseline-failure",
        at: "2026-08-24T01:00:00.000Z",
      },
      toolLoop: {
        stagnationEpoch: 4,
        recent: [
          {
            category: "unchanged-failed-test-rerun",
            toolName: "run_command",
            ok: false,
            stagnationEpoch: 4,
            at: "2026-08-24T00:59:58.000Z",
          },
          {
            category: "workspace-patch",
            toolName: "apply_patch",
            ok: false,
            error: "Patch made no changes to report.md.",
            stagnationEpoch: 4,
            at: "2026-08-24T01:00:00.000Z",
          },
          {
            toolName: "read_file",
            ok: true,
            blocked: false,
            stagnationEpoch: 4,
            at: "2026-08-24T01:00:01.000Z",
          },
        ],
      },
    },
    messages: [],
  }
);
assertStrict.equal(
  consumedPatchContextRepairRuntime.testFailureRepairNeedsPatchContext,
  false,
  "failed-test repair kept reopening discovery after one successful diagnostic source turn"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: consumedPatchContextRepairRuntime,
    goal: "Repair the current project after one bounded diagnostic source turn.",
    profile: "qa",
  }),
  ["apply_patch", "finish"],
  "a consumed failed-test diagnostic turn did not return to mutation-only mode"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: continuedFailedTestRepairRuntime,
    goal: "Verify the coherent repair before continuing.",
    profile: "qa",
  }),
  ["run_command", "finish"],
  "a completed repair mutation did not close broad tools until the retained test reran"
);

const pendingTestTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    testVerificationPending: true,
    testVerificationCommand: "python -m unittest discover -s tests -v",
    convergenceSuppressedToolNames: ["run_command"],
  },
  goal: "Verify the canonical mutation.",
  profile: "data",
});
sameNames(pendingTestTools, ["run_command", "finish"], "post-mutation verification offered unrelated tools");
assertStrict.deepEqual(
  pendingTestTools[0].function.parameters.properties.command.enum,
  ["python -m unittest discover -s tests -v"],
  "post-mutation verification did not constrain the exact retained test command"
);
const exactPendingVerifierDescriptor = pendingTestTools[0];
const exactPendingVerifierCommand =
  exactPendingVerifierDescriptor.function.parameters.properties.command.enum[0];
const exactPendingVerifierContract = createToolContract([
  exactPendingVerifierDescriptor,
  tool("finish"),
]);
const wrongCwdVerifierCall = contractCall(
  "wrong-cwd-verifier",
  "run_command",
  {
    command:
      `cd .aginti/verification/smoke_test && ${exactPendingVerifierCommand}`,
  }
);
const wrongCwdVerifierValidation = resolveDispatchableToolCallBatch(
  [wrongCwdVerifierCall],
  exactPendingVerifierContract
);
assertStrict.equal(
  wrongCwdVerifierValidation.ok,
  false,
  "the verifier recovery fixture no longer reproduces a command enum mismatch"
);
const recoveredExactPendingVerifier = recoverExactPendingCommandIntent(
  {
    testVerificationPending: true,
    testVerificationCommand: exactPendingVerifierCommand,
  },
  [wrongCwdVerifierCall],
  exactPendingVerifierContract,
  wrongCwdVerifierValidation
);
assertStrict.equal(
  recoveredExactPendingVerifier?.recoveredExactPendingCommand,
  true,
  "an exact pending verifier wrapped in one safe wrong cwd was not canonicalized"
);
assertStrict.equal(
  recoveredExactPendingVerifier?.removedLeadingCwd,
  true,
  "wrong-cwd verifier recovery did not record the removed directory wrapper"
);
assertStrict.deepEqual(
  JSON.parse(
    recoveredExactPendingVerifier.acceptedToolCalls[0].function.arguments
  ),
  { command: exactPendingVerifierCommand },
  "wrong-cwd verifier recovery did not dispatch the authoritative exact command"
);
const unrelatedPendingCommandCall = contractCall(
  "unrelated-pending-command",
  "run_command",
  { command: "python3 service_ctl.py start" }
);
assertStrict.equal(
  recoverExactPendingCommandIntent(
    {
      testVerificationPending: true,
      testVerificationCommand: exactPendingVerifierCommand,
    },
    [unrelatedPendingCommandCall],
    exactPendingVerifierContract,
    resolveDispatchableToolCallBatch(
      [unrelatedPendingCommandCall],
      exactPendingVerifierContract
    )
  ),
  null,
  "an unrelated command was incorrectly rewritten as the pending verifier"
);
assertStrict.equal(
  recoverExactPendingCommandIntent(
    {},
    [wrongCwdVerifierCall],
    exactPendingVerifierContract,
    wrongCwdVerifierValidation
  ),
  null,
  "a singleton run-command enum was repaired without authoritative pending state"
);

const researchTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Research the latest primary sources and cite them.",
  profile: "research",
});
assert(names(researchTools).includes("web_search"), "research bundle omitted web_search");
assert(names(researchTools).includes("read_web_page"), "research bundle omitted read_web_page");
assert(names(researchTools).includes("web_research"), "research bundle omitted web_research");
assert(names(researchTools).includes("deep_research"), "research bundle omitted deep_research");
assert(!names(researchTools).includes("click"), "research bundle exposed unrelated browser interaction tools");

const explicitDeepResearchStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Write a deep web research report comparing at least three primary papers and one PDF.",
  profile: "research",
});
sameNames(
  explicitDeepResearchStarter,
  ["deep_research", "finish"],
  "explicit deep research did not start on the bounded provider-neutral tool surface"
);
const explicitDeepResearchFollowup = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Write a deep web research report comparing at least three primary papers and one PDF.",
  profile: "research",
  messages: [{ role: "assistant", tool_calls: [{ id: "deep-1", function: { name: "deep_research", arguments: "{}" } }] }],
});
assert(names(explicitDeepResearchFollowup).includes("web_search"), "deep-research follow-up did not restore targeted recovery tools");

const localEvidenceResearchStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
});
assert(names(localEvidenceResearchStarter).includes("deep_research"), "local evidence research omitted deep_research");
assert(names(localEvidenceResearchStarter).includes("read_file"), "local evidence research omitted read_file");
assert(names(localEvidenceResearchStarter).includes("write_file"), "local evidence research omitted write_file");
assert(names(localEvidenceResearchStarter).includes("run_command"), "local evidence research omitted shell/git access");
assert(
  !(names(localEvidenceResearchStarter).length === 2 && names(localEvidenceResearchStarter)[0] === "deep_research"),
  "local evidence research was trapped on deep_research before reading its source material"
);
const localEvidenceResearchAfterInspection = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content:
        "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
    },
    {
      role: "assistant",
      tool_calls: [{ id: "local-notes", function: { name: "read_file", arguments: '{"path":"PROJECT_NOTES.md"}' } }],
    },
    {
      role: "assistant",
      tool_calls: [{ id: "local-sources", function: { name: "read_file", arguments: '{"path":"sources.json"}' } }],
    },
  ],
});
sameNames(
  localEvidenceResearchAfterInspection,
  ["deep_research", "finish"],
  "local evidence research did not enter the bounded research engine after inspection"
);
const retainedEvidenceManifestRepair = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content: [
        "Resume the saved evidence-review task.",
        "Do not restart the task, run deep_research, or reopen broad discovery.",
        "Use the retained completed evidence and rebuild sources.json.",
      ].join("\n"),
    },
    {
      role: "assistant",
      tool_calls: [{ id: "retained-sources", function: { name: "read_file", arguments: '{"path":"sources.json"}' } }],
    },
    {
      role: "assistant",
      tool_calls: [{ id: "retained-evidence", function: { name: "read_file", arguments: '{"path":"tmp/reliability-evidence-pass.md"}' } }],
    },
  ],
});
assert(
  names(retainedEvidenceManifestRepair).includes("write_file"),
  "retained-evidence manifest repair omitted write_file after inspection"
);
assert(
  names(retainedEvidenceManifestRepair).includes("read_file"),
  "retained-evidence manifest repair omitted bounded source reads"
);
assert(
  !(names(retainedEvidenceManifestRepair).length === 2 &&
    names(retainedEvidenceManifestRepair)[0] === "deep_research"),
  "explicit retained-evidence reuse was forced back into deep_research"
);
const localEvidenceAfterDeepResearchCompaction = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal:
    "Investigate the reliability problem in this folder, correct PROJECT_NOTES.md, write an evidence review and sources.json, then commit the intentional work.",
  profile: "research",
  messages: [
    {
      role: "user",
      content:
        "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable.",
    },
    {
      role: "user",
      content: [
        "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.",
        "Tool: deep_research",
        'Arguments: {"query":"reliability evidence"}',
        'Verified result: {"ok":true,"version":14,"status":"completed"}',
      ].join("\n"),
    },
  ],
});
assert(
  names(localEvidenceAfterDeepResearchCompaction).includes("read_file"),
  "post-research compaction did not restore local workspace tools"
);
assert(
  !(names(localEvidenceAfterDeepResearchCompaction).length === 2 && names(localEvidenceAfterDeepResearchCompaction)[0] === "deep_research"),
  "post-research compaction forgot the completed bounded research call"
);

const timeoutCompactedResearchRepairGoal =
  "External verification failed for the existing research report. Preserve the report and evidence, add the missing sources.json and PDF, run the validator, and commit the repair.";
const timeoutCompactedResearchRepairState = {
  goal: timeoutCompactedResearchRepairGoal,
  meta: {
    goalContract: {
      revision: 2,
      currentHash: "research-repair-goal",
      currentRequest: timeoutCompactedResearchRepairGoal,
      history: [
        { revision: 1, hash: "original-research-goal" },
        {
          revision: 2,
          hash: "research-repair-goal",
          previousHash: "original-research-goal",
        },
      ],
    },
    completedDeepResearch: [
      {
        goalKey: "original-research-goal",
        result: {
          ok: true,
          version: 14,
          reportPath: path.join(repoRoot, "package.json"),
        },
      },
    ],
  },
};
const timeoutCompactedResearchRepairRuntime = nextStepRuntimeConfig(
  {
    provider: "deepseek",
    goal: timeoutCompactedResearchRepairGoal,
    commandCwd: repoRoot,
  },
  timeoutCompactedResearchRepairState
);
assertStrict.equal(
  timeoutCompactedResearchRepairRuntime.deepResearchCompletedForCurrentWork,
  true,
  "a successor artifact repair lost the completed research record from its immediately preceding goal"
);
const timeoutCompactedResearchRepair = selectProgressiveTools(allTools, {
  config: timeoutCompactedResearchRepairRuntime,
  goal: timeoutCompactedResearchRepairGoal,
  profile: "research",
  messages: [
    {
      role: "user",
      content:
        "A previous agent-step request was interrupted by a model timeout. Continue from this compacted, valid transcript.",
    },
    {
      role: "user",
      content:
        "Retained runtime tool evidence. This operation already completed; use its result and do not repeat it solely because context was compacted.\nTool: read_file\nVerified result: existing evidence report",
    },
  ],
});
assert(names(timeoutCompactedResearchRepair).includes("run_command"), "timeout-compacted research repair omitted shell validation");
assert(names(timeoutCompactedResearchRepair).includes("write_file"), "timeout-compacted research repair omitted artifact writing");
assert(
  !(names(timeoutCompactedResearchRepair).length === 2 && names(timeoutCompactedResearchRepair)[0] === "deep_research"),
  "timeout recovery forced a completed research task back into deep_research"
);

const unrelatedNewResearchGoal =
  "Write a new deep research report comparing current optical sensor calibration methods.";
const unrelatedNewResearchRuntime = nextStepRuntimeConfig(
  { provider: "deepseek", goal: unrelatedNewResearchGoal, commandCwd: repoRoot },
  {
    ...timeoutCompactedResearchRepairState,
    goal: unrelatedNewResearchGoal,
    meta: {
      ...timeoutCompactedResearchRepairState.meta,
      goalContract: {
        revision: 3,
        currentHash: "new-research-goal",
        currentRequest: unrelatedNewResearchGoal,
        history: [
          ...timeoutCompactedResearchRepairState.meta.goalContract.history,
          {
            revision: 3,
            hash: "new-research-goal",
            previousHash: "research-repair-goal",
          },
        ],
      },
    },
  }
);
assertStrict.equal(
  unrelatedNewResearchRuntime.deepResearchCompletedForCurrentWork,
  undefined,
  "an old completed report suppressed a genuinely new research request"
);
sameNames(
  selectProgressiveTools(allTools, {
    config: unrelatedNewResearchRuntime,
    goal: unrelatedNewResearchGoal,
    profile: "research",
  }),
  ["deep_research", "finish"],
  "a genuinely new research request did not retain the bounded deep-research starter"
);

const documentRuntimeSnapshot =
  'Step 1/30. Latest runtime snapshot:\n{"pageText":"Workspace file tools are ready. Web search and resumable deep research are available when current evidence is required."}';
const localDocumentStarter = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly.",
  profile: "word",
  messages: [
    { role: "user", content: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly." },
    { role: "user", content: documentRuntimeSnapshot },
  ],
});
assert(names(localDocumentStarter).includes("read_file"), "local document start omitted workspace reading tools");
assert(names(localDocumentStarter).includes("write_file"), "local document start omitted workspace writing tools");
assert(
  !(names(localDocumentStarter).length === 2 && names(localDocumentStarter)[0] === "deep_research"),
  "runtime snapshot prose forced a local document task into deep research"
);

const documentRepairAfterCompaction = selectProgressiveTools(allTools, {
  config: { provider: "deepseek" },
  goal: "Turn the files in this folder into an editable, phone-friendly handoff and finish it properly.",
  profile: "word",
  messages: [
    {
      role: "user",
      content:
        "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable. Authoritative current goal: create the document.",
    },
    {
      role: "user",
      content:
        "The previous tool-call batch was rejected before dispatch. Reason code: TOOL_NOT_OFFERED. Rejected request: apply_patch. Tools offered in that turn: deep_research, finish.",
    },
    { role: "user", content: documentRuntimeSnapshot },
  ],
});
assert(names(documentRepairAfterCompaction).includes("apply_patch"), "document repair after compaction omitted apply_patch");
assert(names(documentRepairAfterCompaction).includes("run_command"), "document repair after compaction omitted build verification");
assert(
  !(names(documentRepairAfterCompaction).length === 2 && names(documentRepairAfterCompaction)[0] === "deep_research"),
  "post-failure runtime scaffolding regressed a local document repair into deep research"
);

const scopedArtifactPrompt = `You are a persistent workspace agent. The surrounding policy mentions an evidence review.
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create one plain-text artifact and verify it."}
Repository evidence to consult as relevant: literature review, evidence review, research report.`;
const scopedArtifactTools = selectProgressiveTools(allTools, {
  config: { provider: "deepseek", progressiveTools: true },
  goal: scopedArtifactPrompt,
  profile: "auto",
  messages: [
    { role: "user", content: scopedArtifactPrompt },
    {
      role: "user",
      content: "Runtime snapshot: consult the surrounding literature review and evidence review policy before acting.",
    },
  ],
});
assert(names(scopedArtifactTools).includes("write_file"), "scoped artifact task omitted write_file");
assert(
  !(names(scopedArtifactTools).length === 2 && names(scopedArtifactTools)[0] === "deep_research"),
  "surrounding policy prose incorrectly forced a scoped artifact task into deep research"
);

const scopedExistingReportEditPrompt = `Generic research worker policy.
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Revise the exact existing research report at output/wechat_worker/task/report.md. Preserve the evidence, write the revised Markdown under this task's artifact directory, and use page-safe tables. The host owns PDF compilation."}
Surrounding routine text mentions literature review, evidence review, research report, and web sources.`;
const scopedExistingReportEditTools = selectProgressiveTools(allTools, {
  config: { provider: "deepseek", progressiveTools: true },
  goal: scopedExistingReportEditPrompt,
  profile: "auto",
  messages: [{ role: "user", content: scopedExistingReportEditPrompt }],
});
assert(names(scopedExistingReportEditTools).includes("read_file"), "scoped existing-report edit omitted read_file");
assert(names(scopedExistingReportEditTools).includes("write_file"), "scoped existing-report edit omitted write_file");
assert(
  !(names(scopedExistingReportEditTools).length === 2 && names(scopedExistingReportEditTools)[0] === "deep_research"),
  "scoped existing-report edit was incorrectly forced into deep_research"
);

const scopedArtifactGroundingTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    progressiveTools: true,
    repositoryGroundingRequired: true,
    scopedArtifactTask: true,
    scopedArtifactRoot: "output/wechat_worker/task",
  },
  goal: scopedExistingReportEditPrompt,
  profile: "auto",
  messages: [{ role: "user", content: scopedExistingReportEditPrompt }],
});
assert(
  names(scopedArtifactGroundingTools).includes("list_files") &&
    names(scopedArtifactGroundingTools).includes("read_file") &&
    names(scopedArtifactGroundingTools).includes("apply_patch"),
  "task-scoped artifact repair was reduced to generic repository grounding"
);
assert(
  !names(scopedArtifactGroundingTools).includes("inspect_project"),
  "task-scoped artifact repair exposed unrelated repository inspection"
);
const scopedRuntimePrompt = `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
  mode: "task",
  request:
    "Revise the exact existing report at output/wechat_worker/task/report.md and overwrite it after reading the current task evidence.",
  artifact_root: "/workspace/output/wechat_worker/task",
})}`;
const scopedRuntime = nextStepRuntimeConfig(
  {
    provider: "deepseek",
    goal: scopedRuntimePrompt,
    commandCwd: "/workspace",
  },
  {
    goal: scopedRuntimePrompt,
    commandCwd: "/workspace",
    meta: {
      goalContract: { revision: 1, currentRequest: scopedRuntimePrompt },
      activeExecutionContract: {
        revision: 1,
        startedMutationRevision: 0,
        requiresFileMutation: true,
        requiresSourceGrounding: true,
      },
      projectVerification: { mutationRevision: 0 },
    },
  }
);
assertStrict.equal(scopedRuntime.scopedArtifactTask, true);
assertStrict.deepEqual(scopedRuntime.workspacePathScopeRoots, ["output/wechat_worker/task"]);
assertStrict.equal(
  scopedRuntime.repositoryGroundingRequired,
  undefined,
  "an explicit task artifact root still activated generic repository grounding"
);
const scopedPathWriteDescriptor = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write one workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};
const scopedPathSurface = [
  ...allTools.filter((item) => item.function.name !== "write_file"),
  scopedPathWriteDescriptor,
];
const scopedPathTools = selectProgressiveTools(scopedPathSurface, {
  config: {
    provider: "deepseek",
    progressiveTools: true,
    scopedArtifactTask: true,
    scopedArtifactRoot: scopedRuntime.scopedArtifactRoot,
    commandCwd: "/workspace",
  },
  goal: scopedRuntimePrompt,
  profile: "auto",
  messages: [{ role: "user", content: scopedRuntimePrompt }],
});
const scopedWritePathPattern = scopedPathTools.find(
  (item) => item.function.name === "write_file"
)?.function?.parameters?.properties?.path?.pattern;
assert(scopedWritePathPattern, "scoped artifact write tool omitted its path contract");
const scopedWritePathRegex = new RegExp(scopedWritePathPattern);
assert(
  scopedWritePathRegex.test("output/wechat_worker/task/report.md"),
  "scoped artifact write contract rejected its workspace-relative path"
);
assert(
  scopedWritePathRegex.test("/workspace/output/wechat_worker/task/report.md"),
  "scoped artifact write contract rejected the host-supplied exact absolute path"
);
assert(
  !scopedWritePathRegex.test("/workspace/output/wechat_worker/other/report.md"),
  "scoped artifact write contract accepted a sibling task path"
);

const longScopedTaskRoot = path.join(repoRoot, "output/wechat_worker/long-scoped-task");
const longScopedScopeLine = `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
  mode: "task",
  request:
    "Repair the exact task-local report source, rebuild its PDF, and return only the verified replacement artifact.",
  artifact_root: longScopedTaskRoot,
})}`;
const longScopedRuntimePrompt = [
  longScopedScopeLine,
  "The report cites DOI 10.1016/j.c and other literature identifiers; these are evidence, not workspace paths.",
  `Retained same-chat history: ${"bounded historical context ".repeat(420)}`,
].join("\n");
const longScopedState = {
  goal: longScopedRuntimePrompt,
  commandCwd: repoRoot,
  meta: {
    goalContract: {
      revision: 2,
      activeGoal: longScopedRuntimePrompt,
      currentRequest: longScopedRuntimePrompt,
    },
    activeExecutionContract: {
      revision: 2,
      refreshedAt: "2026-08-27T01:30:29.713Z",
      startedMutationRevision: 0,
      requiresFileMutation: true,
      requiresSourceGrounding: true,
    },
    projectVerification: { mutationRevision: 0, mutationHistory: [] },
    completionEvidenceRepair: {
      key: "missing-reader-facing-artifact",
      at: "2026-08-27T01:30:29.713Z",
      requiresFreshFileMutation: true,
      requiredFreshMutationRevision: 1,
    },
    toolLoop: { recent: [] },
  },
};
const longScopedRuntime = nextStepRuntimeConfig(
  {
    provider: "deepseek",
    goal: longScopedRuntimePrompt,
    commandCwd: repoRoot,
  },
  longScopedState
);
assertStrict.equal(
  longScopedRuntime.scopedArtifactTask,
  true,
  "long-context compaction discarded the host-owned artifact scope"
);
assertStrict.deepEqual(
  longScopedRuntime.workspacePathScopeRoots,
  ["output/wechat_worker/long-scoped-task"],
  "long-context artifact repair escaped its exact task root"
);
assertStrict.equal(
  longScopedRuntime.completionFreshMutationRequired,
  undefined,
  "a scoped report repair was hijacked by generic source-mutation recovery"
);
assertStrict.equal(
  longScopedRuntime.completionFreshMutationPaths,
  undefined,
  "a DOI in long report context was inferred as a source filename"
);
const longScopedContract = completionTaskContract(
  {
    provider: "deepseek",
    goal: longScopedRuntimePrompt,
    commandCwd: repoRoot,
  },
  longScopedState
);
assertStrict.equal(
  longScopedContract.requiredFreshMutationRevision,
  1,
  "an authoritative scoped repair contract accepted only pre-existing artifact evidence"
);
assertStrict.equal(
  longScopedContract.requiredEvidence.find((item) => item.category === "file")
    ?.minimumMutationRevision,
  1,
  "scoped report repair did not require fresh file-mutation evidence"
);
assert(
  completionContractGoal(
    { goal: longScopedRuntimePrompt, commandCwd: repoRoot },
    {
      goal: longScopedRuntimePrompt,
      meta: { goalContract: { activeGoal: longScopedRuntimePrompt } },
    }
  ).includes(longScopedScopeLine),
  "completion-contract compaction did not preserve the valid evidence-scope JSON line"
);

const scopedDeepResearchPrompt = `Generic workspace policy.
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Write a deep research evidence review comparing three primary papers."}`;
const scopedDeepResearchTools = selectProgressiveTools(allTools, {
  config: { provider: "deepseek", progressiveTools: true },
  goal: scopedDeepResearchPrompt,
  profile: "auto",
  messages: [{ role: "user", content: scopedDeepResearchPrompt }],
});
sameNames(
  scopedDeepResearchTools,
  ["deep_research", "finish"],
  "explicit deep research inside the scoped user request was not preserved"
);

const writingTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Draft and revise a chapter, then save it.",
  profile: "writing",
});
sameNames(
  writingTools,
  ["writing_specialist", "read_file", "write_file", "apply_patch", "web_search", "send_to_canvas", "finish"],
  "writing task did not select the exact specialist bundle"
);

const longJobTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Run this download as a long-running background job.",
  profile: "auto",
});
sameNames(
  longJobTools,
  ["start_long_job", "long_job_status", "run_command", "inspect_project", "read_file", "send_to_canvas", "finish"],
  "long-running task did not select the exact background-job bundle"
);

const tmuxTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "auto",
  messages: [{ role: "user", content: "Use tmux to list sessions, capture the pane, and send keys." }],
});
sameNames(
  tmuxTools,
  [
    "tmux_list_sessions",
    "tmux_capture_pane",
    "tmux_send_keys",
    "tmux_start_session",
    "run_command",
    "inspect_project",
    "read_file",
    "finish",
  ],
  "tmux message did not select the exact session-coordination bundle"
);

const supervisionTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Continue supervising the worker.",
  profile: "supervision",
});
sameNames(supervisionTools, names(tmuxTools), "supervision profile did not preserve tmux coordination tools");

const pipelineTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Continue the workflow.",
  profile: "pipeline",
});
sameNames(
  pipelineTools,
  [
    "start_long_job",
    "long_job_status",
    "tmux_list_sessions",
    "tmux_capture_pane",
    "tmux_send_keys",
    "tmux_start_session",
    "run_command",
    "inspect_project",
    "read_file",
    "search_files",
    "apply_patch",
    "finish",
  ],
  "pipeline profile did not select its exact long-running coordination bundle"
);

const agentLinkTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Coordinate peer agents on a shared task board.",
  profile: "collaboration",
});
sameNames(
  agentLinkTools,
  [
    "agentlink_status",
    "agentlink_list_peers",
    "agentlink_create_board",
    "agentlink_get_board",
    "agentlink_send_message",
    "agentlink_claim_task",
    "agentlink_attach_evidence",
    "agentlink_summarize_session",
    "finish",
  ],
  "AgentLink profile did not select the exact collaboration bundle"
);

const mcpTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use MCP resources and tools through the Model Context Protocol.",
  profile: "auto",
});
sameNames(
  mcpTools,
  [
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "mcp_list_prompts",
    "mcp_get_prompt",
    "finish",
  ],
  "MCP task did not select the exact bridge bundle"
);

const mixedMcpCodeGoal = "Use MCP to inspect the project, then implement the fix and run the tests.";
const mixedMcpCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
});
sameNames(
  mixedMcpCodeTools,
  [
    "mcp_list_servers",
    "mcp_list_tools",
    "mcp_call_tool",
    "read_file",
    "search_files",
    "write_file",
    "apply_patch",
    "run_command",
    "mcp_list_resources",
    "mcp_read_resource",
    "inspect_project",
    "finish",
  ],
  "mixed MCP/code discovery phase did not reserve implementation and verification tools"
);

const mixedMcpFixTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Inspect the issue through MCP, then fix it and verify the result.",
  profile: "auto",
});
for (const requiredName of ["mcp_call_tool", "write_file", "apply_patch", "run_command"]) {
  assert(names(mixedMcpFixTools).includes(requiredName), `mixed MCP/fix inference omitted ${requiredName}`);
}

const completedMcpMessages = [
  { role: "user", content: `Goal: ${mixedMcpCodeGoal}` },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "mcp-discovery-1",
        type: "function",
        function: { name: "mcp_list_servers", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "mcp-discovery-1", content: '{"ok":true}' },
];
const mixedMcpImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: completedMcpMessages,
});
sameNames(
  mixedMcpImplementationTools,
  [
    "run_command",
    "inspect_project",
    "list_files",
    "read_file",
    "search_files",
    "write_file",
    "apply_patch",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "finish",
  ],
  "completed MCP discovery did not escalate to the code-first implementation phase"
);

const mixedMcpVerificationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: [
    ...completedMcpMessages,
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "edit-1",
          type: "function",
          function: { name: "apply_patch", arguments: '{"patch":"fixture"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "edit-1", content: '{"ok":true}' },
  ],
});
sameNames(
  mixedMcpVerificationTools,
  [
    "run_command",
    "read_file",
    "search_files",
    "inspect_project",
    "apply_patch",
    "write_file",
    "list_files",
    "mcp_list_tools",
    "mcp_call_tool",
    "mcp_list_resources",
    "mcp_read_resource",
    "finish",
  ],
  "completed edit did not advance the mixed workflow to verification-first ordering"
);

const unresolvedMcpCallTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: completedMcpMessages.slice(0, -1),
});
sameNames(
  unresolvedMcpCallTools,
  names(mixedMcpCodeTools),
  "an MCP request without a matching tool result incorrectly advanced the workflow phase"
);

const newRequestBoundaryTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedMcpCodeGoal,
  profile: "auto",
  messages: [
    ...completedMcpMessages,
    { role: "user", content: `Continue with this new request: ${mixedMcpCodeGoal}` },
  ],
});
sameNames(
  newRequestBoundaryTools,
  names(mixedMcpCodeTools),
  "completed tools from an earlier continuation leaked into the new workflow phase"
);

const mixedResearchCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Research the current primary documentation, then implement the fix and test it.",
  profile: "auto",
});
for (const requiredName of ["web_search", "web_research", "write_file", "apply_patch", "run_command"]) {
  assert(names(mixedResearchCodeTools).includes(requiredName), `mixed research/code phase omitted ${requiredName}`);
}
assert(mixedResearchCodeTools.length <= 12, "mixed research/code phase exceeded the default local limit");

const mixedAgentLinkCodeGoal = "Use AgentLink peers to coordinate, then fix the code and run tests.";
const mixedAgentLinkCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedAgentLinkCodeGoal,
});
for (const requiredName of [
  "agentlink_status",
  "agentlink_list_peers",
  "agentlink_create_board",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "run_command",
  "finish",
]) {
  assert(
    names(mixedAgentLinkCodeTools).includes(requiredName),
    `mixed AgentLink/code coordination phase omitted ${requiredName}`
  );
}
assert(mixedAgentLinkCodeTools.length <= 12, "mixed AgentLink/code phase exceeded the default local limit");

const mixedAgentLinkImplementationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: mixedAgentLinkCodeGoal,
  messages: [
    { role: "user", content: `Goal: ${mixedAgentLinkCodeGoal}` },
    {
      role: "assistant",
      tool_calls: [
        { id: "agentlink-call-1", type: "function", function: { name: "agentlink_create_board", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "agentlink-call-1", content: '{"ok":true,"boardId":"board-1"}' },
  ],
});
for (const requiredName of ["read_file", "search_files", "write_file", "apply_patch", "run_command", "agentlink_get_board", "finish"]) {
  assert(
    names(mixedAgentLinkImplementationTools).includes(requiredName),
    `completed AgentLink coordination did not retain ${requiredName} for implementation`
  );
}
assert(
  names(mixedAgentLinkImplementationTools)[0] === "run_command",
  "completed AgentLink coordination did not advance to a code-first phase"
);

const disabledMixedMcpCodeTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", allowFileTools: false, allowShellTool: false },
  goal: mixedMcpCodeGoal,
  profile: "auto",
});
for (const disabledName of ["read_file", "search_files", "write_file", "apply_patch", "run_command"]) {
  assert(!names(disabledMixedMcpCodeTools).includes(disabledName), `mixed workflow leaked disabled tool ${disabledName}`);
}
assert(names(disabledMixedMcpCodeTools).includes("mcp_call_tool"), "mixed workflow lost its enabled MCP capability");

const jsonTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use the JSON specialist for schema-bound extraction into strict structured JSON.",
  profile: "auto",
});
sameNames(
  jsonTools,
  ["json_specialist", "json_specialist_batch", "read_file", "write_file", "search_files", "send_to_canvas", "finish"],
  "structured JSON task did not select the exact specialist bundle"
);

const imageReadTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Use image perception to analyze the supplied PNG.",
  profile: "vision",
});
sameNames(imageReadTools, ["read_image", "send_to_canvas", "finish"], "vision task did not select the exact perception bundle");

const retainedTextWorkspaceTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
    integrationAllowedToolNames: INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
    allowImagePerception: false,
  },
  goal: "Inspect the screenshot, edit the project, and preview it in a browser.",
  profile: "vision",
});
for (const selected of names(retainedTextWorkspaceTools)) {
  assert(
    INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES.includes(selected),
    `retained text-workspace leaked disallowed tool ${selected}`
  );
}
assert(!names(retainedTextWorkspaceTools).includes("read_image"), "retained text-workspace exposed read_image");
assert(!names(retainedTextWorkspaceTools).includes("run_command"), "retained text-workspace exposed run_command");
assert(!names(retainedTextWorkspaceTools).includes("send_to_canvas"), "retained text-workspace exposed canvas");
assert(!names(retainedTextWorkspaceTools).includes("open_url"), "retained text-workspace exposed browser tools");
assert(names(retainedTextWorkspaceTools).includes("finish"), "retained text-workspace lost finish");
const forgedReadImageBlock = integrationTextWorkspaceToolExecutionBlock(
  { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
  "read_image"
);
assert(forgedReadImageBlock?.blocked === true, "executeTool second-line gate accepted forged read_image");
const forgedRunCommandBlock = integrationTextWorkspaceToolExecutionBlock(
  { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
  "run_command"
);
assert(forgedRunCommandBlock?.blocked === true, "executeTool second-line gate accepted forged run_command");
assert(
  integrationTextWorkspaceToolExecutionBlock(
    { integrationSessionProfile: INTEGRATION_TEXT_WORKSPACE_PROFILE_ID },
    "read_file"
  ) === null,
  "executeTool second-line gate blocked an allowed text tool"
);

const imageGenerationTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", allowAuxiliaryTools: true },
  goal: "Generate a raster illustration.",
  profile: "image",
});
sameNames(
  imageGenerationTools,
  ["generate_image", "read_image", "write_file", "send_to_canvas", "finish"],
  "image task did not select the exact generation bundle"
);

const imageGenerationOffTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Generate a raster illustration.",
  profile: "image",
});
assert(!names(imageGenerationOffTools).includes("generate_image"), "local image generation was exposed without explicit enablement");

const canvasTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  goal: "Send the finished artifact to the canvas.",
  profile: "canvas",
});
sameNames(canvasTools, ["send_to_canvas", "read_file", "write_file", "finish"], "canvas task did not select the exact artifact bundle");

const explicitProfileTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: {
    id: "custom",
    tools: ["MCP_CALL_TOOL", "custom_hosted_tool", "not_registered", "finish"],
  },
});
sameNames(
  explicitProfileTools,
  ["mcp_call_tool", "finish"],
  "explicit profile tools were not safely intersected with compact registered tools"
);

const disabledTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    allowFileTools: false,
    allowShellTool: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowBrowserTools: false,
    allowCanvasTools: false,
  },
  profile: "auto",
});
sameNames(disabledTools, ["finish"], "disabled feature flags left compact tools exposed");

const disabledBundleCases = [
  {
    label: "background jobs",
    config: { allowLongJobTools: false },
    goal: "Run this as a long-running background job.",
    expected: ["run_command", "inspect_project", "read_file", "send_to_canvas", "finish"],
  },
  {
    label: "tmux",
    config: { allowTmuxTools: false },
    goal: "Use tmux to capture the pane and send keys.",
    expected: ["run_command", "inspect_project", "read_file", "finish"],
  },
  {
    label: "AgentLink",
    config: { allowAgentLinkTools: false },
    goal: "Use AgentLink with peer agents and a shared task board.",
    expected: ["finish"],
  },
  {
    label: "MCP",
    config: { allowMcpTools: false },
    goal: "Use MCP resources through the Model Context Protocol.",
    expected: ["finish"],
  },
  {
    label: "JSON specialist",
    config: { allowJsonTools: false },
    goal: "Use the JSON specialist for strict structured JSON.",
    expected: ["read_file", "write_file", "search_files", "send_to_canvas", "finish"],
  },
  {
    label: "image generation",
    config: { allowAuxiliaryTools: false },
    goal: "Generate a raster illustration.",
    expected: ["read_image", "write_file", "send_to_canvas", "finish"],
  },
  {
    label: "image perception",
    config: { allowVisionTools: false },
    goal: "Use image perception to analyze the supplied PNG.",
    expected: ["send_to_canvas", "finish"],
  },
  {
    label: "canvas",
    config: { allowCanvasTools: false },
    goal: "Send the finished artifact to the canvas.",
    expected: ["read_file", "write_file", "finish"],
  },
  {
    label: "writing specialist",
    config: { allowWritingTools: false },
    goal: "Draft and revise a novel chapter.",
    expected: ["read_file", "write_file", "apply_patch", "web_search", "send_to_canvas", "finish"],
  },
];
for (const testCase of disabledBundleCases) {
  const selected = selectProgressiveTools(allTools, {
    config: { provider: "localllm", ...testCase.config },
    goal: testCase.goal,
    profile: "auto",
  });
  sameNames(selected, testCase.expected, `${testCase.label} allow flag was not enforced`);
}

const disabledFullTools = selectProgressiveTools(allTools, {
  config: {
    provider: "openai",
    allowFileTools: false,
    allowShellTool: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowBrowserTools: false,
    allowCanvasTools: false,
  },
});
const disabledFullNames = names(disabledFullTools);
for (const disabledName of [
  "run_command",
  "read_file",
  "read_image",
  "web_search",
  "read_web_page",
  "web_research",
  "deep_research",
  "mcp_call_tool",
  "delegate_agent",
  "research_wrapper",
  "generate_image",
  "open_url",
  "click",
  "send_to_canvas",
]) {
  assert(!disabledFullNames.includes(disabledName), `hosted full policy leaked disabled tool ${disabledName}`);
}
assert(disabledFullNames.includes("custom_hosted_tool"), "feature filtering removed an unrelated hosted tool");
assert(disabledFullNames.includes("finish"), "feature filtering removed finish");

const unknownProfileTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "not-a-real-profile",
});
sameNames(
  unknownProfileTools,
  LOCAL_COMPACT_GENERAL_TOOL_NAMES,
  "unknown profile did not fall back to the compact general set"
);
assert(!names(unknownProfileTools).includes("read_image"), "general fallback exposed vision without image intent");

const messageInferredTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm" },
  profile: "auto",
  messages: [{ role: "user", content: "Please research current primary sources and cite them." }],
});
assert(names(messageInferredTools).includes("web_research"), "message text did not drive task-aware selection");
assert(!names(messageInferredTools).includes("run_command"), "message-inferred research leaked the code shell tool");

const hostedInput = [...allTools, { type: "invalid", function: { name: "invalid_tool" } }, allTools[0]];
const hostedTools = selectProgressiveTools(hostedInput, {
  config: { provider: "openai", allowWrapperTools: true, allowAuxiliaryTools: true },
  profile: "code",
});
sameNames(hostedTools, knownNames, "hosted auto policy did not preserve the complete valid tool surface");
assert(hostedTools.every((item) => hostedInput.includes(item)), "hosted selection manufactured a descriptor");

const explicitFullTools = selectProgressiveTools(allTools, {
  config: { provider: "localllm", toolSurfacePolicy: "full", allowWrapperTools: true, allowAuxiliaryTools: true },
});
sameNames(explicitFullTools, knownNames, "explicit full policy did not preserve the local tool surface");

const hardCapTools = selectProgressiveTools(allTools, {
  config: {
    provider: "localllm",
    allowAuxiliaryTools: true,
    toolSurfaceMaxTools: 999,
    toolSurfaceMaxChars: 100_000,
  },
  goal:
    "Start a long-running background code job in tmux, coordinate peer agents with AgentLink, use MCP and the JSON specialist, generate an image, and send the artifact to canvas.",
  profile: "auto",
});
assert(hardCapTools.length === LOCAL_TOOL_HARD_CAP, "compact mixed-task selection did not exercise the hard cap");
assert(hardCapTools.at(-1)?.function?.name === "finish", "hard-capped selection did not reserve finish");
assert(hardCapTools.every((item) => allTools.includes(item)), "hard-capped selection manufactured a descriptor");

for (const selected of [
  codeTools,
  browserTools,
  researchTools,
  writingTools,
  longJobTools,
  tmuxTools,
  supervisionTools,
  pipelineTools,
  agentLinkTools,
  mcpTools,
  jsonTools,
  imageReadTools,
  imageGenerationTools,
  canvasTools,
]) {
  assert(selected.length <= 12, `default local bundle exceeded 12 tools: ${names(selected).join(", ")}`);
  assert(selected.at(-1)?.function?.name === "finish", "default local bundle did not retain finish");
  assert(selected.every((item) => allTools.includes(item)), "default local bundle manufactured a descriptor");
}

const bulkyTools = knownNames.map((name) => tool(name, `${name}: ${"schema detail ".repeat(180)}`));
const sizeBoundTools = selectProgressiveTools(bulkyTools, {
  config: { provider: "localllm" },
  profile: "auto",
});
assert(
  JSON.stringify(sizeBoundTools).length <= DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
  "compact selection exceeded its serialized schema-size target"
);
assert(sizeBoundTools.at(-1)?.function?.name === "finish", "size-bounded selection omitted finish");

const localBoundaryTools = await captureRequestTools();
assert(
  JSON.stringify(enumFor(localBoundaryTools, "writing_specialist", "provider")) === JSON.stringify(["localllm"]),
  "LocalLLM tool schema exposed a cross-provider writing route"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "json_specialist", "provider")) === JSON.stringify(["localllm"]),
  "LocalLLM tool schema exposed a cross-provider JSON route"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "read_image", "provider")) === JSON.stringify(["auto", "localllm"]),
  "LocalLLM tool schema exposed hosted image perception"
);
assert(
  JSON.stringify(enumFor(localBoundaryTools, "web_research", "mode")) === JSON.stringify(["snippets"]),
  "LocalLLM tool schema exposed hosted web synthesis"
);

const explicitlyHostedTools = await captureRequestTools({
  allowHostedImagePerception: true,
  allowHostedWebResearch: true,
  allowHostedJsonSpecialist: true,
  allowHostedWritingSpecialist: true,
});
assert(enumFor(explicitlyHostedTools, "writing_specialist", "provider").includes("openai"), "explicit writer permission did not expose hosted providers");
assert(enumFor(explicitlyHostedTools, "json_specialist", "provider").includes("openai"), "explicit JSON permission did not expose hosted providers");
assert(enumFor(explicitlyHostedTools, "read_image", "provider").includes("openai"), "explicit image permission did not expose OpenAI");
assert(enumFor(explicitlyHostedTools, "web_research", "mode").includes("openai"), "explicit research permission did not expose OpenAI");

function contractCall(id, name, args, { raw = false } = {}) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: raw ? args : JSON.stringify(args),
    },
  };
}

const focusedTranslationRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-focused-write-translation-")
);
try {
  const currentFocusedContent = [
    "# Report",
    "The earlier marker is incorrect.",
    "Keep this trailing evidence.",
  ].join("\n");
  const proposedFocusedContent = [
    "# Report",
    "The required marker is correct.",
    "Keep this trailing evidence.",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(focusedTranslationRoot, "report.md"),
    currentFocusedContent,
    "utf8"
  );
  const focusedContract = createToolContract([focusedApplyPatch]);
  const rejectedWholeFileCall = contractCall("focused-whole-file", "write_file", {
    path: "report.md",
    content: proposedFocusedContent,
    mode: "overwrite",
  });
  const rejectedWholeFileValidation = resolveDispatchableToolCallBatch(
    [rejectedWholeFileCall],
    focusedContract
  );
  assert(!rejectedWholeFileValidation.ok, "unoffered whole-file write unexpectedly passed directly");
  const translatedFocusedWrite = await recoverFocusedWholeFileWriteAsExactPatch(
    { commandCwd: focusedTranslationRoot },
    {
      meta: {
        failedTestDiagnostic: {
          focuses: [
            {
              kind: "membership",
              path: "report.md",
              directSearch: "The earlier marker is incorrect.",
            },
          ],
        },
      },
    },
    [rejectedWholeFileCall],
    focusedContract,
    rejectedWholeFileValidation
  );
  assert(translatedFocusedWrite?.ok, "lossless focused whole-file intent was not translated");
  assert(translatedFocusedWrite.recoveredFocusedWholeFileWrite, "focused translation was not marked");
  assert(
    translatedFocusedWrite.terminalNewlineNormalized,
    "focused translation did not record its bounded terminal-newline normalization"
  );
  assertStrict.deepEqual(
    JSON.parse(translatedFocusedWrite.acceptedToolCalls[0].function.arguments),
    {
      path: "report.md",
      search: "The earlier marker is incorrect.",
      replace: "The required marker is correct.",
    },
    "focused whole-file intent did not become the exact minimal patch"
  );
  assertStrict.equal(
    await fs.readFile(path.join(focusedTranslationRoot, "report.md"), "utf8"),
    currentFocusedContent,
    "intent translation mutated the workspace before normal tool dispatch"
  );

  const driftingWholeFileCall = contractCall("drifting-whole-file", "write_file", {
    path: "report.md",
    content: proposedFocusedContent.replace("Keep this trailing evidence.", "Unrelated drift."),
    mode: "overwrite",
  });
  assertStrict.equal(
    await recoverFocusedWholeFileWriteAsExactPatch(
      { commandCwd: focusedTranslationRoot },
      {
        meta: {
          failedTestDiagnostic: {
            focuses: [
              {
                kind: "membership",
                path: "report.md",
                directSearch: "The earlier marker is incorrect.",
              },
            ],
          },
        },
      },
      [driftingWholeFileCall],
      focusedContract,
      resolveDispatchableToolCallBatch([driftingWholeFileCall], focusedContract)
    ),
    null,
    "whole-file intent with unrelated drift was translated into a focused mutation"
  );
} finally {
  await fs.rm(focusedTranslationRoot, { recursive: true, force: true });
}

const focusedTrailingWhitespaceRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-focused-patch-whitespace-")
);
try {
  const canonicalSearch = [
    "def write_manifest():",
    "    payload = {'artifacts': []}",
    "",
    "",
  ].join("\n");
  const requestedSearch = canonicalSearch.trimEnd();
  const source = `${canonicalSearch}def main():\n    return 0\n`;
  await fs.writeFile(
    path.join(focusedTrailingWhitespaceRoot, "build_cad.py"),
    source,
    "utf8"
  );
  const descriptor = {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Repair one exact semantic producer.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["build_cad.py"] },
          search: { type: "string", enum: [canonicalSearch] },
          replace: { type: "string", minLength: 1 },
          expectedReplacements: { type: "integer", enum: [1] },
        },
        required: ["path", "search", "replace"],
        additionalProperties: false,
      },
    },
  };
  const contract = createToolContract([descriptor]);
  const call = contractCall("focused-trailing-whitespace", "apply_patch", {
    path: "build_cad.py",
    search: requestedSearch,
    replace: [
      "def write_manifest():",
      "    payload = {'artifacts': [], 'validation': {'step': 'checked'}}",
    ].join("\n"),
    expectedReplacements: 1,
  });
  const rejected = resolveDispatchableToolCallBatch([call], contract);
  assert(!rejected.ok, "trailing-whitespace search mismatch unexpectedly passed directly");
  const recovered = await recoverFocusedPatchTrailingWhitespaceAsExactPatch(
    { commandCwd: focusedTrailingWhitespaceRoot },
    {
      meta: {
        failedTestDiagnostic: {
          focuses: [{
            kind: "generated-artifact-semantic-producer",
            path: "build_cad.py",
            directSearch: canonicalSearch,
          }],
        },
      },
    },
    [call],
    contract,
    rejected
  );
  assert(recovered?.ok, "focused patch trailing line breaks were not normalized");
  assert(
    recovered.recoveredFocusedPatchTrailingWhitespace,
    "focused patch normalization was not marked"
  );
  const recoveredArgs = JSON.parse(recovered.acceptedToolCalls[0].function.arguments);
  assertStrict.equal(
    recoveredArgs.search,
    canonicalSearch,
    "focused patch normalization did not inject the revision-bound anchor"
  );
  assertStrict.equal(
    recoveredArgs.replace.endsWith("\n\n"),
    true,
    "focused patch normalization did not preserve the anchor boundary"
  );
  assertStrict.equal(
    await fs.readFile(path.join(focusedTrailingWhitespaceRoot, "build_cad.py"), "utf8"),
    source,
    "focused patch normalization mutated the workspace before normal dispatch"
  );

  const noChangeCall = contractCall("focused-no-change-whitespace", "apply_patch", {
    path: "build_cad.py",
    search: requestedSearch,
    replace: requestedSearch,
    expectedReplacements: 1,
  });
  const recoveredNoChange = await recoverFocusedPatchTrailingWhitespaceAsExactPatch(
    { commandCwd: focusedTrailingWhitespaceRoot },
    {
      meta: {
        failedTestDiagnostic: {
          focuses: [{
            kind: "generated-artifact-semantic-producer",
            path: "build_cad.py",
            directSearch: canonicalSearch,
          }],
        },
      },
    },
    [noChangeCall],
    contract,
    resolveDispatchableToolCallBatch([noChangeCall], contract)
  );
  assert(
    recoveredNoChange?.ok,
    "focused no-change patch was not normalized for deterministic executor feedback"
  );
  assertStrict.equal(
    JSON.parse(recoveredNoChange.acceptedToolCalls[0].function.arguments).replace,
    canonicalSearch,
    "focused no-change normalization did not preserve the exact anchor"
  );

  const driftingSearchCall = contractCall("focused-non-whitespace-drift", "apply_patch", {
    path: "build_cad.py",
    search: requestedSearch.replace("artifacts", "outputs"),
    replace: "def write_manifest():\n    return {}",
    expectedReplacements: 1,
  });
  assertStrict.equal(
    await recoverFocusedPatchTrailingWhitespaceAsExactPatch(
      { commandCwd: focusedTrailingWhitespaceRoot },
      {
        meta: {
          failedTestDiagnostic: {
            focuses: [{
              kind: "generated-artifact-semantic-producer",
              path: "build_cad.py",
              directSearch: canonicalSearch,
            }],
          },
        },
      },
      [driftingSearchCall],
      contract,
      resolveDispatchableToolCallBatch([driftingSearchCall], contract)
    ),
    null,
    "non-whitespace focused search drift was normalized"
  );
} finally {
  await fs.rm(focusedTrailingWhitespaceRoot, { recursive: true, force: true });
}

const focusedUniqueSubrangeRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-focused-patch-subrange-")
);
try {
  const canonicalSearch = [
    "    json_payload = {",
    '        "title": "tube cradle",',
    '        "validation": validation,',
    '        "artifacts": artifacts,',
    "    }",
    "",
  ].join("\n");
  const requestedSearch = [
    '        "validation": validation,',
    '        "artifacts": artifacts,',
  ].join("\n");
  const requestedReplace = [
    '        "validation": validation,',
    '        "validation_evidence": list(validation.values()),',
    '        "artifacts": artifacts,',
  ].join("\n");
  const source = [
    "def write_manifest():",
    canonicalSearch.trimEnd(),
    "    return json_payload",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(focusedUniqueSubrangeRoot, "build_cad.py"),
    source,
    "utf8"
  );
  const descriptor = {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Repair one exact semantic producer.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["build_cad.py"] },
          search: { type: "string", enum: [canonicalSearch] },
          replace: { type: "string", minLength: 1 },
          expectedReplacements: { type: "integer", enum: [1] },
        },
        required: ["path", "search", "replace"],
        additionalProperties: false,
      },
    },
  };
  const contract = createToolContract([descriptor]);
  const state = {
    meta: {
      failedTestDiagnostic: {
        focuses: [{
          kind: "generated-artifact-semantic-producer",
          path: "build_cad.py",
          directSearch: canonicalSearch,
        }],
      },
    },
  };
  const call = contractCall("focused-unique-subrange", "apply_patch", {
    path: "build_cad.py",
    search: requestedSearch,
    replace: requestedReplace,
    expectedReplacements: 1,
  });
  const rejected = resolveDispatchableToolCallBatch([call], contract);
  assert(!rejected.ok, "unique inner-block search unexpectedly passed directly");
  const recovered = await recoverFocusedPatchUniqueSubrangeAsExactPatch(
    { commandCwd: focusedUniqueSubrangeRoot },
    state,
    [call],
    contract,
    rejected
  );
  assert(recovered?.ok, "unique focused inner-block patch was not recovered");
  assert(
    recovered.recoveredFocusedPatchUniqueSubrange,
    "unique focused inner-block recovery was not marked"
  );
  const recoveredArgs = JSON.parse(recovered.acceptedToolCalls[0].function.arguments);
  assertStrict.equal(
    recoveredArgs.search,
    canonicalSearch,
    "unique focused inner-block recovery did not inject the exact allowed anchor"
  );
  assertStrict.equal(
    recoveredArgs.replace,
    canonicalSearch.replace(requestedSearch, requestedReplace),
    "unique focused inner-block recovery did not splice the requested mutation losslessly"
  );
  assertStrict.equal(
    await fs.readFile(path.join(focusedUniqueSubrangeRoot, "build_cad.py"), "utf8"),
    source,
    "unique focused inner-block recovery mutated the workspace before dispatch"
  );

  const outsideFocusCall = contractCall("focused-subrange-outside", "apply_patch", {
    path: "build_cad.py",
    search: "def write_manifest():\n    json_payload",
    replace: "def write_manifest():\n    rejected_payload",
    expectedReplacements: 1,
  });
  assertStrict.equal(
    await recoverFocusedPatchUniqueSubrangeAsExactPatch(
      { commandCwd: focusedUniqueSubrangeRoot },
      state,
      [outsideFocusCall],
      contract,
      resolveDispatchableToolCallBatch([outsideFocusCall], contract)
    ),
    null,
    "a requested search outside the exact failed-test focus was recovered"
  );

  const scopeExpansionCall = contractCall("focused-subrange-scope-expansion", "apply_patch", {
    path: "build_cad.py",
    search: requestedSearch,
    replace: `${requestedReplace}\n\ndef unrelated_rebuild():\n    return {}`,
    expectedReplacements: 1,
  });
  assertStrict.equal(
    await recoverFocusedPatchUniqueSubrangeAsExactPatch(
      { commandCwd: focusedUniqueSubrangeRoot },
      state,
      [scopeExpansionCall],
      contract,
      resolveDispatchableToolCallBatch([scopeExpansionCall], contract)
    ),
    null,
    "a focused inner-block patch that injected an unrelated declaration was recovered"
  );
} finally {
  await fs.rm(focusedUniqueSubrangeRoot, { recursive: true, force: true });
}

const focusedAlreadyAppliedRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agintiflow-focused-patch-already-applied-")
);
try {
  const staleSearch = [
    "    json_payload = {",
    '        "validation": validation,',
    '        "artifacts": artifacts,',
    "    }",
    "",
  ].join("\n");
  const currentSearch = [
    "    json_payload = {",
    '        "validation": validation,',
    '        "artifacts": artifacts,',
    '        "validation_results": list(validation.values()),',
    "    }",
    "",
  ].join("\n");
  const source = [
    "def write_manifest():",
    currentSearch.trimEnd(),
    "    return json_payload",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(focusedAlreadyAppliedRoot, "build_cad.py"),
    source,
    "utf8"
  );
  const descriptor = {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Repair one exact semantic producer.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["build_cad.py"] },
          search: { type: "string", enum: [currentSearch] },
          replace: { type: "string", minLength: 1 },
          expectedReplacements: { type: "integer", enum: [1] },
        },
        required: ["path", "search", "replace"],
        additionalProperties: false,
      },
    },
  };
  const contract = createToolContract([descriptor]);
  const state = {
    meta: {
      failedTestDiagnostic: {
        focuses: [{
          kind: "generated-artifact-semantic-producer",
          path: "build_cad.py",
          directSearch: currentSearch,
        }],
      },
    },
  };
  const call = contractCall("focused-stale-already-applied", "apply_patch", {
    path: "build_cad.py",
    search: staleSearch,
    replace: currentSearch,
    expectedReplacements: 1,
  });
  const rejected = resolveDispatchableToolCallBatch([call], contract);
  assert(!rejected.ok, "stale already-applied search unexpectedly passed directly");
  const recovered = await recoverFocusedPatchAlreadyAppliedAsExactNoop(
    { commandCwd: focusedAlreadyAppliedRoot },
    state,
    [call],
    contract,
    rejected
  );
  assert(
    recovered?.ok && recovered.recoveredFocusedPatchAlreadyApplied,
    "stale patch whose replacement was already current was not recovered"
  );
  const recoveredArgs = JSON.parse(
    recovered.acceptedToolCalls[0].function.arguments
  );
  assertStrict.equal(
    recoveredArgs.search,
    currentSearch,
    "already-applied recovery did not bind the exact current anchor"
  );
  assertStrict.equal(
    recoveredArgs.replace,
    currentSearch,
    "already-applied recovery did not produce a deterministic no-op"
  );
  assertStrict.equal(
    await fs.readFile(path.join(focusedAlreadyAppliedRoot, "build_cad.py"), "utf8"),
    source,
    "already-applied recovery mutated the workspace before dispatch"
  );

  const changedReplacementCall = contractCall(
    "focused-stale-not-already-applied",
    "apply_patch",
    {
      path: "build_cad.py",
      search: staleSearch,
      replace: currentSearch.replace("validation_results", "different_results"),
      expectedReplacements: 1,
    }
  );
  assertStrict.equal(
    await recoverFocusedPatchAlreadyAppliedAsExactNoop(
      { commandCwd: focusedAlreadyAppliedRoot },
      state,
      [changedReplacementCall],
      contract,
      resolveDispatchableToolCallBatch([changedReplacementCall], contract)
    ),
    null,
    "a materially different stale patch was mislabeled as already applied"
  );
} finally {
  await fs.rm(focusedAlreadyAppliedRoot, { recursive: true, force: true });
}

const strictWriteDescriptor = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "overwrite"] },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};
const strictContract = createToolContract([strictWriteDescriptor]);
assert(
  validateToolCallBatch(
    [contractCall("valid-write", "write_file", { path: "valid.txt", content: "ok", mode: "create" })],
    strictContract
  ).ok,
  "valid offered tool call did not satisfy its exact schema"
);

const safeReadDescriptors = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, query: { type: "string" } },
        required: ["path", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];
const safeReadCalls = [
  contractCall("safe-read", "read_file", { path: "AGENTS.md" }),
  contractCall("safe-search", "search_files", { path: ".", query: "lazyedit" }),
  contractCall("safe-list", "list_files", { path: "." }),
];
const safeReadContract = createToolContract(safeReadDescriptors);
assert(safeSequentialToolBatchLimit(safeReadCalls) === 4, "safe read batch did not receive the bounded sequential allowance");
assert(
  validateToolCallBatch(safeReadCalls, safeReadContract, {
    maxToolCalls: safeSequentialToolBatchLimit(safeReadCalls),
  }).ok,
  "valid safe read batch did not pass the exact per-turn contract"
);
const singletonReadContract = createToolContract([
  {
    ...safeReadDescriptors[0],
    function: {
      ...safeReadDescriptors[0].function,
      parameters: {
        ...safeReadDescriptors[0].function.parameters,
        properties: { path: { type: "string", enum: ["README.md"] } },
      },
    },
  },
]);
const repairedSingletonRead = resolveDispatchableToolCallBatch(
  [contractCall("wrong-singleton-read", "read_file", { path: "raw/run_a.csv" })],
  singletonReadContract
);
assert(repairedSingletonRead.ok, "singleton read-only enum mismatch was not repaired");
assert(repairedSingletonRead.recoveredSingletonEnums, "singleton enum recovery was not recorded");
assertStrict.deepEqual(
  JSON.parse(repairedSingletonRead.acceptedToolCalls[0].function.arguments),
  { path: "README.md" },
  "singleton enum recovery did not dispatch the only contract-authorized path"
);
const readRangeAliasContract = createToolContract([
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read one bounded file range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["service_ctl.py"] },
          startLine: { type: "integer", minimum: 1 },
          lineLimit: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
]);
const repairedReadRangeAlias = resolveDispatchableToolCallBatch(
  [
    contractCall("read-natural-range", "read_file", {
      path: "service_ctl.py",
      range: "from line 60 to line 80",
    }),
  ],
  readRangeAliasContract
);
assert(
  repairedReadRangeAlias.ok && repairedReadRangeAlias.recoveredReadRangeAlias,
  "a bounded natural-language read_file range was not repaired to the native schema"
);
assertStrict.deepEqual(
  JSON.parse(repairedReadRangeAlias.acceptedToolCalls[0].function.arguments),
  { path: "service_ctl.py", startLine: 60, lineLimit: 21 },
  "read_file range recovery produced the wrong native line bounds"
);
assert(
  !resolveDispatchableToolCallBatch(
    [
      contractCall("read-ambiguous-range", "read_file", {
        path: "service_ctl.py",
        range: "around the service function",
      }),
    ],
    readRangeAliasContract
  ).ok,
  "an ambiguous natural-language read range was silently dispatched"
);
const multipleReadChoices = createToolContract([
  {
    ...safeReadDescriptors[0],
    function: {
      ...safeReadDescriptors[0].function,
      parameters: {
        ...safeReadDescriptors[0].function.parameters,
        properties: { path: { type: "string", enum: ["README.md", "AGENTS.md"] } },
      },
    },
  },
]);
assert(
  !resolveDispatchableToolCallBatch(
    [contractCall("wrong-multi-read", "read_file", { path: "raw/run_a.csv" })],
    multipleReadChoices
  ).ok,
  "multi-choice read enum was silently rewritten"
);
const unsafeSingletonWrite = createToolContract([
  {
    ...strictWriteDescriptor,
    function: {
      ...strictWriteDescriptor.function,
      parameters: {
        ...strictWriteDescriptor.function.parameters,
        properties: {
          ...strictWriteDescriptor.function.parameters.properties,
          mode: { type: "string", enum: ["create"] },
        },
      },
    },
  },
]);
assert(
  !resolveDispatchableToolCallBatch(
    [contractCall("wrong-singleton-write", "write_file", { path: "unsafe.txt", content: "x", mode: "overwrite" })],
    unsafeSingletonWrite
  ).ok,
  "write argument was rewritten through read-only singleton recovery"
);
const mixedReadWriteCalls = [
  safeReadCalls[0],
  contractCall("unsafe-write", "write_file", { path: "blocked.txt", content: "bad" }),
];
assert(safeSequentialToolBatchLimit(mixedReadWriteCalls) === 1, "mixed read/write batch escaped the single-call limit");
assert(
  !validateToolCallBatch(mixedReadWriteCalls, createToolContract([...safeReadDescriptors, strictWriteDescriptor]), {
    maxToolCalls: safeSequentialToolBatchLimit(mixedReadWriteCalls),
  }).ok,
  "mixed read/write batch unexpectedly passed"
);
const recoveredMixedBatch = resolveDispatchableToolCallBatch(
  mixedReadWriteCalls,
  createToolContract([...safeReadDescriptors, strictWriteDescriptor])
);
assert(recoveredMixedBatch.ok, "valid mixed batch could not recover through bounded sequential deferral");
assert(recoveredMixedBatch.recoveredSequentially, "mixed batch recovery was not recorded");
assert(recoveredMixedBatch.acceptedToolCalls.length === 1, "mixed batch recovery dispatched more than one call");
assert(recoveredMixedBatch.deferredToolCalls.length === 1, "mixed batch recovery did not defer the extra call");
const fiveCallMixedBatch = [
  ...safeReadCalls,
  contractCall("safe-read-four", "read_file", { path: "fourth.txt" }),
  contractCall("deferred-write-five", "write_file", { path: "later.txt", content: "later" }),
];
const recoveredFiveCallMixedBatch = resolveDispatchableToolCallBatch(
  fiveCallMixedBatch,
  createToolContract([...safeReadDescriptors, strictWriteDescriptor])
);
assert(recoveredFiveCallMixedBatch.ok, "five-call mixed batch was rejected instead of bounded deferral");
assert(
  recoveredFiveCallMixedBatch.acceptedToolCalls.length === 1 &&
    recoveredFiveCallMixedBatch.deferredToolCalls.length === 4,
  "five-call mixed batch did not dispatch exactly one call and preserve the suffix"
);
assert(
  recoveredFiveCallMixedBatch.deferredToolCalls.at(-1)?.function?.name === "write_file",
  "bounded mixed recovery lost or executed the deferred write"
);
const oversizedReadCalls = Array.from({ length: 5 }, (_, index) =>
  contractCall(`read-${index}`, "read_file", { path: `file-${index}.txt` })
);
assert(
  !validateToolCallBatch(oversizedReadCalls, safeReadContract, {
    maxToolCalls: safeSequentialToolBatchLimit(oversizedReadCalls),
  }).ok,
  "oversized read batch escaped the bounded allowance"
);
const recoveredOversizedReadBatch = resolveDispatchableToolCallBatch(oversizedReadCalls, safeReadContract);
assert(recoveredOversizedReadBatch.ok, "oversized safe read batch was not recoverable in a bounded chunk");
assert(recoveredOversizedReadBatch.recoveredSequentially, "oversized safe read recovery was not recorded");
assert(recoveredOversizedReadBatch.acceptedToolCalls.length === 4, "oversized safe read recovery dispatched the wrong chunk size");
assert(recoveredOversizedReadBatch.deferredToolCalls.length === 1, "oversized safe read recovery lost its deferred suffix");
const excessiveReadBatch = Array.from({ length: 13 }, (_, index) =>
  contractCall(`excessive-read-${index}`, "read_file", { path: `file-${index}.txt` })
);
assert(
  !resolveDispatchableToolCallBatch(excessiveReadBatch, safeReadContract).ok,
  "unbounded safe read batch escaped the reported-call cap"
);
assert(
  !resolveDispatchableToolCallBatch(
    [...excessiveReadBatch.slice(0, 12), contractCall("excessive-write", "write_file", { path: "later.txt", content: "later" })],
    createToolContract([...safeReadDescriptors, strictWriteDescriptor])
  ).ok,
  "unbounded mixed batch escaped the reported-call cap"
);

for (const [label, call, expectedCode] of [
  [
    "hidden dryRun",
    contractCall("hidden-dry-run", "write_file", { path: "blocked.txt", content: "bad", dryRun: false }),
    "ARGUMENT_ADDITIONAL_PROPERTY",
  ],
  ["missing required", contractCall("missing", "write_file", { path: "blocked.txt" }), "ARGUMENT_REQUIRED_PROPERTY_MISSING"],
  [
    "wrong type",
    contractCall("wrong-type", "write_file", { path: 42, content: "bad" }),
    "ARGUMENT_WRONG_TYPE",
  ],
  [
    "invalid enum",
    contractCall("bad-enum", "write_file", { path: "blocked.txt", content: "bad", mode: "append" }),
    "ARGUMENT_ENUM_MISMATCH",
  ],
  ["unoffered tool", contractCall("unoffered", "run_command", { command: "touch blocked.txt" }), "TOOL_NOT_OFFERED"],
  ["malformed JSON", contractCall("bad-json", "write_file", "{", { raw: true }), "TOOL_ARGUMENTS_INVALID_JSON"],
  ["empty id", contractCall("", "write_file", { path: "blocked.txt", content: "bad" }), "TOOL_CALL_ID_EMPTY"],
]) {
  const validation = validateToolCallBatch([call], strictContract);
  assert(!validation.ok, `${label} call unexpectedly passed the tool contract`);
  assert(
    validation.errors.some((error) => error.code === expectedCode),
    `${label} call did not report ${expectedCode}: ${JSON.stringify(validation.errors)}`
  );
}

const duplicateBatchValidation = validateToolCallBatch(
  [
    contractCall("duplicate", "write_file", { path: "one.txt", content: "one" }),
    contractCall("duplicate", "write_file", { path: "two.txt", content: "two" }),
  ],
  strictContract
);
assert(!duplicateBatchValidation.ok, "duplicate-id multi-call batch unexpectedly passed");
assert(duplicateBatchValidation.errors.some((error) => error.code === "TOO_MANY_TOOL_CALLS"), "multi-call batch did not enforce the strict cap");
assert(duplicateBatchValidation.errors.some((error) => error.code === "TOOL_CALL_ID_DUPLICATE"), "duplicate tool-call id was not rejected");

const attachedResponse = attachToolContract({ choices: [] }, [strictWriteDescriptor]);
const attachedContract = toolContractFromResponse(attachedResponse);
assertStrict.deepEqual(attachedContract?.tools, [strictWriteDescriptor], "attached tool descriptors changed value");
assert(Object.isFrozen(attachedContract?.tools), "attached descriptor list was mutable");
assert(Object.isFrozen(attachedContract?.tools?.[0]?.function?.parameters), "attached tool schema was mutable");

function assistantWithToolCalls(toolCalls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
      },
    ],
  };
}

async function runToolContractCase({
  id,
  provider = "localllm",
  profile = "code",
  goal,
  toolCalls,
  textFallback = false,
  allowShellTool = false,
  toolSurfaceMaxTools = 12,
  targets = [],
  expectedTargets = [],
  followupToolCalls = null,
  expectSequentialRecovery = false,
  expectSuccess = false,
  expectedContractFailures = 0,
  maxSteps = 3,
  responseFactory = null,
  setupWorkspace = null,
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `agintiflow-tool-contract-${id}-`));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });
  if (typeof setupWorkspace === "function") await setupWorkspace(workspace);
  const requests = [];
  let clientFactoryCalls = 0;
  const responseText = `[TOOL_CALLS]${toolCalls[0]?.function?.name || "finish"}[ARGS]${toolCalls[0]?.function?.arguments || "{}"}`;
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          requests.push(payload);
          if (typeof responseFactory === "function") {
            return responseFactory({ payload, requests, workspace });
          }
          if (textFallback && Array.isArray(payload.tools)) {
            throw new Error("invalid request parameters: tools");
          }
          if (textFallback) {
            return { choices: [{ message: { role: "assistant", content: responseText } }] };
          }
          const selectedToolCalls = Array.isArray(followupToolCalls) && requests.length > 1
            ? followupToolCalls
            : toolCalls;
          return assistantWithToolCalls(selectedToolCalls);
        },
      },
    },
  };
  const clientFactory = async () => {
    clientFactoryCalls += 1;
    return client;
  };
  clientFactory.agintiDeterministicTest = true;
  const scriptedModel = provider === "localllm" ? "localllm-fast" : "scripted-tool-contract-model";
  const config = resolveRuntimeConfig(
    {
      provider,
      routingMode: "manual",
      model: scriptedModel,
      goal,
      taskProfile: profile,
      allowShellTool,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider,
      routingMode: "manual",
      model: scriptedModel,
      sessionId: id,
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      allowShellTool,
      allowFileTools: true,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: provider === "localllm" ? "local-dev-key" : "scripted-test-only",
    baseURL: provider === "localllm" ? "http://127.0.0.1:8008/v1" : config.baseURL,
    clientFactory,
    providerReadinessMode: provider === "localllm" ? "deterministic-test" : config.providerReadinessMode,
    sessionsDir,
    projectSessionsDir,
    taskProfile: profile,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    permissionMode: "danger",
    allowShellTool,
    allowFileTools: true,
    allowBrowserTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    allowLocalAutoMax: false,
    scsActive: false,
    enableScs: "off",
    executionPolicy: { tier: "focused", requiresPlan: false, reason: "Focused deterministic contract smoke." },
    routeComplexityScore: 0,
    maxSteps,
    maxStepsExplicit: true,
    dynamicSteps: "off",
    contextBudgetMode: "off",
    toolSurfacePolicy: "compact",
    toolSurfaceMaxTools,
    modelTimeoutMs: 1_000,
    headless: true,
    onConsole: () => {},
  });

  try {
    const result = await runAgent(config);
    const store = new SessionStore(sessionsDir, id, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    const events = await store.loadEvents();
    const savedState = await store.loadState();
    const contractFailures = events.filter((event) => event.type === "tool.failed" && event.data?.category === "tool-contract-violation");
    assert(clientFactoryCalls === 1, `${id} did not complete readiness and construct exactly one deterministic client`);
    if (expectSuccess) {
      assert(result.stopped !== true, `${id} stopped instead of recovering: ${JSON.stringify(result)}`);
      assert(
        contractFailures.length === expectedContractFailures,
        `${id} recorded ${contractFailures.length} tool-contract failures; expected ${expectedContractFailures}`
      );
      for (const target of expectedTargets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(exists, `${id} did not preserve expected workspace file ${target}`);
      }
      return { result, requests, events, state: savedState, contractFailures, clientFactoryCalls };
    }
    if (expectSequentialRecovery) {
      assert(result.stopped !== true, `${id} stopped instead of completing the recovered sequential batch`);
      assert(contractFailures.length === 0, `${id} recorded a contract failure for a recoverable valid batch`);
      assert(
        events.some((event) => event.type === "tool.batch_deferred" && event.data?.deferredCount === toolCalls.length - 1),
        `${id} did not record bounded sequential deferral`
      );
      for (const target of expectedTargets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(exists, `${id} did not create expected artifact ${target}`);
      }
      for (const target of targets) {
        const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
        assert(!exists, `${id} dispatched deferred artifact ${target}`);
      }
      return { result, requests, events, state: savedState, contractFailures, clientFactoryCalls };
    }
    assert(
      result.stopped === true && result.reason === "tool_contract_violation",
      `${id} did not stop after one bounded repair: ${JSON.stringify({
        result,
        failures: contractFailures.map((event) => event.data),
        toolSurfaces: requests.filter((request) => Array.isArray(request.tools)).map((request) => names(request.tools)),
      })}`
    );
    assert(contractFailures.length === 2, `${id} did not record exactly two bounded contract failures`);
    assert(!events.some((event) => event.type === "tool.started"), `${id} dispatched a tool from an invalid batch`);
    assert(!events.some((event) => event.type === "tool.completed"), `${id} completed a tool from an invalid batch`);
    for (const target of targets) {
      const exists = await fs.access(path.join(workspace, target)).then(() => true).catch(() => false);
      assert(!exists, `${id} created forbidden artifact ${target}`);
    }
    return { result, requests, events, state: savedState, contractFailures, clientFactoryCalls };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function weakAuthoritativeRoutineGoal(command) {
  return [
    "AGINTI_EVIDENCE_SCOPE_JSON: {\"mode\":\"task\",\"request\":\"tell me phone and schedule status, read-only, dont send or change anything\"}",
    "Matched established routines",
    `- \`sample-status\` ready=true; commands=[${JSON.stringify(command)}, "node scripts/secondary-status.js --json"]; outputs=["status"]; guidance=For a read-only phone, message-intake, queue, or schedule question, run the canonical \`${command}\` command first. Treat the current status snapshot as authoritative. Do not inspect raw private stores, and do not send or mutate anything.`,
    "Operating contract",
    "- Forbidden evidence: raw/private ledgers are out of scope for this read-only answer.",
  ].join("\n");
}

const authoritativeRoutineCommand = "node scripts/status.js status --json";
const authoritativeRoutineGoal = weakAuthoritativeRoutineGoal(
  authoritativeRoutineCommand
);
const authoritativeRoutineContract = completionTaskContract(
  {
    goal: authoritativeRoutineGoal,
    taskProfile: "auto",
  },
  {
    goal: authoritativeRoutineGoal,
    meta: {
      taskProfile: "auto",
      goalContract: {
        revision: 1,
        currentRequest: authoritativeRoutineGoal,
      },
    },
  }
);
assertStrict.deepEqual(
  authoritativeRoutineContract.requiredProjectCommands,
  [authoritativeRoutineCommand],
  "authoritative read-only routine was not promoted to an exact required command"
);
assertStrict.deepEqual(
  authoritativeRoutineContract.authoritativeRoutine?.forbiddenEvidenceScopes,
  ["private", "raw"],
  "authoritative read-only routine did not retain forbidden evidence scopes"
);

const hostedRequiredRoutineTools = selectProgressiveTools(allTools, {
  config: {
    provider: "deepseek",
    toolSurfacePolicy: "full",
    requiredProjectCommandPending: true,
    requiredProjectCommand: authoritativeRoutineCommand,
  },
  goal: authoritativeRoutineGoal,
  profile: "auto",
});
sameNames(
  hostedRequiredRoutineTools,
  ["run_command", "finish"],
  "hosted/full policy did not constrain an authoritative routine first command"
);
assertStrict.deepEqual(
  enumFor(hostedRequiredRoutineTools, "run_command", "command"),
  [authoritativeRoutineCommand],
  "authoritative routine command was not exposed as an exact enum"
);

let authoritativeRoutineStep = 0;
const authoritativeRoutineRun = await runToolContractCase({
  id: "authoritative-readonly-routine",
  provider: "deepseek",
  profile: "auto",
  goal: authoritativeRoutineGoal,
  allowShellTool: true,
  maxSteps: 4,
  toolCalls: [
    contractCall("unused-authoritative", "finish", { result: "unused" }),
  ],
  expectSuccess: true,
  setupWorkspace: async (workspace) => {
    await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "scripts", "status.js"),
      [
        "console.log(JSON.stringify({ phone: 'login-required', schedule: 'current', authoritative: true }));",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8"
    );
  },
  responseFactory: ({ payload }) => {
    authoritativeRoutineStep += 1;
    const offered = Array.isArray(payload.tools) ? names(payload.tools) : [];
    if (authoritativeRoutineStep === 1) {
      assertStrict.deepEqual(
        offered,
        ["run_command", "finish"],
        "first authoritative routine turn exposed exploratory tools"
      );
      assertStrict.deepEqual(
        enumFor(payload.tools, "run_command", "command"),
        [authoritativeRoutineCommand],
        "first authoritative routine turn did not constrain the exact command"
      );
      return assistantWithToolCalls([
        contractCall("run-authoritative-status", "run_command", {
          command: authoritativeRoutineCommand,
        }),
      ]);
    }
    assertStrict.deepEqual(
      offered,
      ["finish"],
      "authoritative routine observation did not shrink the next turn to finish-only"
    );
    return assistantWithToolCalls([
      contractCall("finish-authoritative-status", "finish", {
        result: "The authoritative status snapshot says phone login is required and the schedule snapshot is current.",
      }),
    ]);
  },
});
assertStrict.equal(
  authoritativeRoutineRun.requests.length,
  2,
  "authoritative routine flow used more than two model requests"
);
assertStrict.equal(
  authoritativeRoutineRun.events.filter(
    (event) =>
      event.type === "tool.started" &&
      event.data?.toolName !== "finish"
  ).length,
  1,
  "authoritative routine flow dispatched more than the canonical command"
);
assert(
  authoritativeRoutineRun.events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.data?.toolName === "run_command" &&
      event.data?.ok === false &&
      event.data?.authoritativeReadOnlyRoutine === true &&
      event.data?.authoritativeRoutineObserved === true
  ),
  "nonzero authoritative routine snapshot was not retained as observed evidence"
);
assert(
  !authoritativeRoutineRun.events.some(
    (event) =>
      event.type === "tool.started" &&
      /(?:^|[ /])(?:\\.private|private|raw|sqlite|jsonl)(?:$|[ /.-])/i.test(
        String(event.data?.args?.command || "")
      )
  ),
  "authoritative routine flow still dispatched private/raw exploratory commands"
);

const hiddenDryRun = await runToolContractCase({
  id: "native-hidden-dry-run",
  goal: "Create hidden-dry-run.txt containing unsafe if this tool dispatches.",
  toolCalls: [
    contractCall("native-hidden", "write_file", {
      path: "hidden-dry-run.txt",
      content: "unsafe",
      mode: "create",
      dryRun: false,
    }),
  ],
  targets: ["hidden-dry-run.txt"],
});
assert(
  hiddenDryRun.contractFailures.every((event) =>
    event.data?.errors?.some((error) => error.code === "ARGUMENT_ADDITIONAL_PROPERTY")
  ),
  "native hidden dryRun was not rejected as an additional property"
);
assert(
  hiddenDryRun.requests.every((request) => request.parallel_tool_calls === false),
  "native requests did not keep parallel_tool_calls=false authoritative"
);

const unofferedFallback = await runToolContractCase({
  id: "text-unoffered",
  provider: "localllm",
  profile: "writing",
  goal: "Draft a short paragraph using the writing workflow.",
  toolCalls: [contractCall("text-unoffered", "run_command", { command: "printf unsafe > text-unoffered.txt" })],
  textFallback: true,
  allowShellTool: true,
  toolSurfaceMaxTools: 2,
  targets: ["text-unoffered.txt"],
});
assert(
  unofferedFallback.contractFailures.every((event) => event.data?.code === "TOOL_NOT_OFFERED"),
  "text fallback unoffered tool was not rejected by the exact per-turn surface"
);
const fallbackNativeRequests = unofferedFallback.requests.filter((request) => Array.isArray(request.tools));
assert(fallbackNativeRequests.length === 2, "text fallback did not exercise two native-to-text retries");
assert(
  fallbackNativeRequests.every((request) => !names(request.tools).includes("run_command")),
  "text fallback fixture unexpectedly offered run_command"
);

const multiCall = await runToolContractCase({
  id: "native-multi-call",
  goal: "Create multi-one.txt containing safe.",
  toolCalls: [
    contractCall("multi-one", "write_file", { path: "multi-one.txt", content: "safe", mode: "create" }),
    contractCall("multi-two", "write_file", { path: "multi-two.txt", content: "deferred", mode: "create" }),
  ],
  followupToolCalls: [contractCall("finish-recovered", "finish", { result: "Created and verified multi-one.txt." })],
  expectSequentialRecovery: true,
  expectedTargets: ["multi-one.txt"],
  targets: ["multi-two.txt"],
});
assert(
  multiCall.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "write_file"),
  "recoverable multi-call batch did not dispatch its first valid call"
);
assertStrict.equal(
  multiCall.state?.meta?.activeExecutionContract?.revision,
  multiCall.state?.meta?.goalContract?.revision,
  "a fresh session did not initialize the active execution contract"
);
assertStrict.equal(
  multiCall.state?.meta?.activeExecutionContract?.startedMutationRevision,
  0,
  "a fresh session did not preserve its pre-task mutation baseline"
);
assertStrict.equal(
  multiCall.state?.meta?.activeExecutionContract?.requiresFileMutation,
  true,
  "a fresh artifact task did not record its file-mutation requirement"
);
assertStrict.equal(
  completionTaskContract(
    { taskProfile: "code", goal: multiCall.state?.goal || "" },
    multiCall.state
  ).requiredFreshMutationRevision,
  1,
  "a fresh artifact task accepted a pre-existing file as current-turn completion evidence"
);

const duplicateId = await runToolContractCase({
  id: "native-duplicate-id",
  goal: "Create duplicate-one.txt and duplicate-two.txt.",
  toolCalls: [
    contractCall("duplicate-id", "write_file", { path: "duplicate-one.txt", content: "unsafe", mode: "create" }),
    contractCall("duplicate-id", "write_file", { path: "duplicate-two.txt", content: "unsafe", mode: "create" }),
  ],
  targets: ["duplicate-one.txt", "duplicate-two.txt"],
});
assert(
  duplicateId.contractFailures.every((event) => event.data?.errors?.some((error) => error.code === "TOOL_CALL_ID_DUPLICATE")),
  "duplicate tool-call ids were not rejected before dispatch"
);

const emptyId = await runToolContractCase({
  id: "native-empty-id",
  goal: "Create empty-id.txt.",
  toolCalls: [contractCall("", "write_file", { path: "empty-id.txt", content: "unsafe", mode: "create" })],
  targets: ["empty-id.txt"],
});
assert(
  emptyId.contractFailures.every((event) => event.data?.errors?.some((error) => error.code === "TOOL_CALL_ID_EMPTY")),
  "empty tool-call ids were not rejected before dispatch"
);

let malformedTextAttempts = 0;
const malformedTextRecovery = await runToolContractCase({
  id: "text-malformed-bounded-retry",
  provider: "localllm",
  profile: "code",
  goal: "Create readiness.md containing Recovered, verify it, and finish.",
  toolCalls: [contractCall("unused", "finish", { result: "Recovered." })],
  expectSuccess: true,
  expectedTargets: ["readiness.md"],
  responseFactory: ({ payload }) => {
    if (Array.isArray(payload.tools)) throw new Error("invalid request parameters: tools");
    malformedTextAttempts += 1;
    if (malformedTextAttempts === 1) {
      return {
          choices: [
            {
              message: {
                role: "assistant",
                content: 'Requested tools: write_file({"path":"readiness.md","content":"unfinished',
              },
            },
          ],
        };
    }
    return malformedTextAttempts === 2
      ? {
          choices: [
            {
              message: {
                role: "assistant",
                content: '[TOOL_CALLS]write_file[ARGS]{"path":"readiness.md","content":"Recovered\\n","mode":"create"}',
              },
            },
          ],
        }
      : {
          choices: [
            {
              message: {
                role: "assistant",
                content: '[TOOL_CALLS]finish[ARGS]{"result":"Recovered after one bounded textual syntax retry."}',
              },
            },
          ],
        };
  },
});
assert(malformedTextAttempts === 3, "malformed text-tool response did not retry once and then finish normally");
assert(
  malformedTextRecovery.events.filter((event) => event.type === "model.text_tool_retry_requested").length === 1,
  "malformed text-tool response did not record one protocol-level retry"
);
assert(
  !malformedTextRecovery.events.some((event) => event.type === "tool.started" && event.data?.toolName === "wait"),
  "malformed text-tool recovery dispatched a fabricated wait call"
);

let nonconsecutiveViolationStep = 0;
const nonconsecutiveViolationRecovery = await runToolContractCase({
  id: "native-nonconsecutive-contract-recovery",
  profile: "code",
  goal: "Create recovered.md containing Recovered and finish.",
  toolCalls: [contractCall("unused", "finish", { result: "Recovered." })],
  expectSuccess: true,
  expectedContractFailures: 2,
  expectedTargets: ["recovered.md"],
  maxSteps: 4,
  responseFactory: () => {
    nonconsecutiveViolationStep += 1;
    if (nonconsecutiveViolationStep === 1) {
      return assistantWithToolCalls([
        contractCall("invalid-before-success", "write_file", {
          path: "recovered.md",
          content: "unsafe",
          mode: "create",
          dryRun: false,
        }),
      ]);
    }
    if (nonconsecutiveViolationStep === 2) {
      return assistantWithToolCalls([
        contractCall("valid-write", "write_file", {
          path: "recovered.md",
          content: "Recovered\n",
          mode: "create",
        }),
      ]);
    }
    if (nonconsecutiveViolationStep === 3) {
      return assistantWithToolCalls([
        contractCall("invalid-after-success", "open_url", { url: "https://example.com" }),
      ]);
    }
    return assistantWithToolCalls([
      contractCall("finish-after-recovery", "finish", { result: "Created recovered.md." }),
    ]);
  },
});
assert(
  nonconsecutiveViolationRecovery.events.filter((event) => event.type === "tool.contract_recovered").length === 2,
  "successful intervening turns did not reset consecutive tool-contract violations"
);

let textAsImageStep = 0;
const textAsImageRecovery = await runToolContractCase({
  id: "text-file-requested-as-image",
  provider: "localllm",
  profile: "image",
  goal: "Inspect notes.md, report its exact readiness statement, and finish.",
  toolCalls: [contractCall("unused", "read_image", { path: "notes.md" })],
  expectSuccess: true,
  expectedTargets: ["notes.md"],
  setupWorkspace: async (workspace) => {
    await fs.writeFile(path.join(workspace, "notes.md"), "# Readiness\nVerified routine evidence.\n", "utf8");
  },
  responseFactory: () => {
    textAsImageStep += 1;
    return textAsImageStep === 1
      ? assistantWithToolCalls([contractCall("text-as-image", "read_image", { path: "notes.md" })])
      : assistantWithToolCalls([contractCall("finish-text-read", "finish", { result: "Verified routine evidence." })]);
  },
});
assert(
  textAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.auto_corrected" &&
      event.data?.requestedToolName === "read_image" &&
      event.data?.toolName === "read_file"
  ),
  "plain text requested through read_image was not corrected to read_file"
);
assert(
  textAsImageRecovery.events.some(
    (event) => event.type === "tool.completed" && event.data?.toolName === "read_file" && event.data?.autoCorrected === true
  ),
  "corrected plain-text read did not complete with provenance"
);
assert(
  !textAsImageRecovery.events.some((event) => event.type === "tool.failed" && event.data?.toolName === "read_image"),
  "plain-text correction still invoked failing image perception"
);

let recordStreamAsImageStep = 0;
const recordStreamAsImageRecovery = await runToolContractCase({
  id: "record-stream-requested-as-image",
  provider: "localllm",
  profile: "image",
  goal: "Inspect the newline-delimited task records and report the latest request.",
  toolCalls: [contractCall("unused", "read_image", { path: "records.jsonl" })],
  expectSuccess: true,
  expectedTargets: ["records.jsonl"],
  setupWorkspace: async (workspace) => {
    await fs.writeFile(
      path.join(workspace, "records.jsonl"),
      '{"id":"m1","request":"preserve every inbound record"}\n',
      "utf8"
    );
  },
  responseFactory: () => {
    recordStreamAsImageStep += 1;
    return recordStreamAsImageStep === 1
      ? assistantWithToolCalls([contractCall("records-as-image", "read_image", { path: "records.jsonl" })])
      : assistantWithToolCalls([
          contractCall("finish-record-read", "finish", { result: "Preserve every inbound record." }),
        ]);
  },
});
assert(
  recordStreamAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.auto_corrected" &&
      event.data?.requestedToolName === "read_image" &&
      event.data?.toolName === "read_file"
  ),
  "newline-delimited text requested through read_image was not corrected to read_file"
);
assert(
  recordStreamAsImageRecovery.events.some(
    (event) =>
      event.type === "tool.completed" &&
      event.data?.toolName === "read_file" &&
      event.data?.autoCorrected === true
  ),
  "corrected newline-delimited text read did not complete with provenance"
);
assert(
  !recordStreamAsImageRecovery.events.some(
    (event) => event.type === "tool.failed" && event.data?.toolName === "read_image"
  ),
  "newline-delimited text correction still invoked failing image perception"
);

assert(
  (() => {
    try {
      selectProgressiveTools([tool("run_command")], { config: { provider: "localllm" }, profile: "code" });
      return false;
    } catch (error) {
      return /finish/.test(String(error?.message || error));
    }
  })(),
  "selector did not reject an input surface without finish"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "code",
        "browser",
        "research",
        "writing",
        "long-job",
        "tmux",
        "supervision-profile",
        "pipeline-profile",
        "agentlink",
        "mcp",
        "mixed-mcp-code-discovery",
        "mixed-mcp-fix-inference",
        "mixed-mcp-code-implementation",
        "mixed-mcp-code-verification",
        "mixed-phase-requires-tool-result",
        "mixed-phase-continuation-boundary",
        "mixed-research-code",
        "mixed-agentlink-code-coordination",
        "mixed-agentlink-code-implementation",
        "mixed-disabled-tools",
        "json-specialist",
        "image-perception",
        "image-generation",
        "image-generation-default-off",
        "canvas",
        "safe-explicit-profile",
        "disabled-tools",
        "disabled-specialist-bundles",
        "disabled-tools-full",
        "unknown-profile",
        "message-inference",
        "hosted-full",
        "explicit-full",
        "hard-cap",
        "serialized-size-target",
        "provider-boundary-schemas",
        "finish-contract",
        "per-turn-contract-preserved",
        "schema-required-type-enum-extra",
        "authoritative-readonly-routine-first",
        "native-hidden-dry-run-zero-dispatch",
        "text-fallback-unoffered-zero-dispatch",
        "strict-single-call-batch",
        "duplicate-call-id",
        "empty-call-id",
        "malformed-text-tool-protocol-retry",
        "text-as-image-type-correction",
      ],
      localDefaultToolLimit: 12,
      localHardCap: LOCAL_TOOL_HARD_CAP,
      schemaCharTarget: DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
    },
    null,
    2
  )
);
