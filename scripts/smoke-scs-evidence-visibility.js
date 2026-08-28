#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deterministicPlanTestIntegrityIssue,
  reconcileScsProgressDecision,
  reviewScsFinish,
  reviewScsProgress,
} from "../src/scs-controller.js";
import {
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  evaluateScsSemanticContract,
  extractMarkdownCommandEvidence,
  extractMarkdownPathEvidence,
  finishResultClaimsBlocker,
  finishResultClaimsIncompleteWork,
} from "../src/scs-evidence.js";

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

const pageSafeReportContract = deriveScsTaskContract({
  goal: [
    "AGINTI_EVIDENCE_SCOPE_JSON: {\"mode\":\"task\",\"request\":\"Revise the exact existing research report at output/wechat_worker/task/report.md, write a complete Markdown report, and use page-safe tables. The host owns PDF compilation.\"}",
    "Surrounding browser and research policy text is not part of the exact request.",
  ].join("\n"),
  taskProfile: "auto",
});

const forbiddenOutputContract = deriveScsTaskContract({
  goal: "Continue the task. verification_suite.py does not exist and must not be rerun or created. Preserve smoke_test.py and finish from current evidence.",
  taskProfile: "devops",
});

const mixedRepairAndForbiddenOutputContract = deriveScsTaskContract({
  goal: "Repair service_ctl.py and do not create verification_suite.py.",
  taskProfile: "devops",
});

const coordinatedForbiddenOutputContract = deriveScsTaskContract({
  goal: "Do not create scratch.py or temporary.py; repair service_ctl.py.",
  taskProfile: "devops",
});

const wrappedImmutableSourceContract = deriveScsTaskContract({
  goal: [
    "Continue the exact task. Do not modify source_brief.md, measurements.csv,",
    "prompt.txt, or TASK.md.",
    "Treat source_brief.md, measurements.csv, prompt.txt, and TASK.md as immutable read-only source evidence.",
    "Repair build_deck.py and rebuild output/deck.pptx.",
  ].join("\n"),
  taskProfile: "slides",
});

const actionWrappedImmutableSourceContract = deriveScsTaskContract({
  goal: [
    "Continue the exact task. Do not",
    "modify source_brief.md, measurements.csv, prompt.txt, or TASK.md.",
    "Repair build_deck.py and rebuild output/deck.pptx.",
  ].join("\n"),
  taskProfile: "slides",
});

const pathWrappedImmutableSourceContract = deriveScsTaskContract({
  goal: [
    "Continue the exact task. Do not modify",
    "source_brief.md, measurements.csv, prompt.txt, or TASK.md.",
    "Repair build_deck.py and rebuild output/deck.pptx.",
  ].join("\n"),
  taskProfile: "slides",
});

const recoveryInstructionContract = deriveScsTaskContract({
  goal: [
    "Use the retained source and these two failures: the tests invoke ../service_ctl.py, while `python3 service_ctl.py start --state-dir .runtime` fails. Preserve the lifecycle assertions rather than replacing them, repair service_ctl.py, and remove the accidental untracked resume-after-git-baseline-recovery-dev-prompt.txt.",
    "Then run `python3 -m unittest discover -s tests -v`, followed by `PYTHONDONTWRITEBYTECODE=1 python3 /tmp/devops_sensor_gateway_contract.py`. Do not use LocalLLM or change provider.",
  ].join("\n"),
  taskProfile: "devops",
});

const readOnlyVerificationContinuationContract = deriveScsTaskContract({
  goal: [
    "Continue the exact active DevOps task from its clean committed state. Do not mutate source, tests, or documentation and do not create another commit.",
    "Run exactly `git status --short` once, then follow the runtime's exact required verification commands serially. These include `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v` and `PYTHONDONTWRITEBYTECODE=1 python3 /tmp/devops_sensor_gateway_contract.py`.",
  ].join("\n"),
  taskProfile: "devops",
});

const readOnlyReviewContract = deriveScsTaskContract({
  goal: [
    "Review focus: changed files only.",
    "Run a bounded code review. Default to read-only review; do not edit files unless the review focus explicitly asks for fixes.",
    "Read changed source files and report findings.",
  ].join("\n"),
  taskProfile: "review",
});

const explicitReviewRepairContract = deriveScsTaskContract({
  goal: [
    "Review focus: inspect changed files and fix confirmed defects.",
    "Default to read-only review; do not edit files unless the review focus explicitly asks for fixes.",
  ].join("\n"),
  taskProfile: "review",
});

const testWeakeningPlanIssue = deterministicPlanTestIntegrityIssue(
  {
    phaseGoal: "Repair the current service implementation from authoritative failures.",
    plan: [
      "Add lifecycle test stubs for ownership and status behavior.",
      "If the CLI returns code 2, ensure the test explicitly checks for this exit code.",
      "Fix only the failing test case or implementation, then rerun verification.",
    ],
    acceptanceCriteria: ["Lifecycle tests accept CLI exit code 2."],
  },
  "The fresh test result is authoritative. Repair service_ctl.py, preserve tests, and run the exact test command unchanged."
);
assert.equal(
  testWeakeningPlanIssue?.decision,
  "veto_plan",
  "the deterministic SCS gate accepted a plan that weakened authoritative tests"
);
assert.match(testWeakeningPlanIssue.reason, /production implementation/i);
assert.equal(
  deterministicPlanTestIntegrityIssue(
    {
      phaseGoal: "Repair production source.",
      plan: [
        "Read the current production source and retained failure evidence.",
        "Patch the bounded implementation functions without editing tests.",
        "Run the exact authoritative test command unchanged.",
      ],
      acceptanceCriteria: ["The unchanged test suite passes."],
    },
    "Repair service_ctl.py and preserve tests."
  ),
  null,
  "a production-only repair plan was incorrectly rejected as test weakening"
);
assert(
  forbiddenOutputContract.excludedOutputPaths.includes("verification_suite.py"),
  "an explicitly forbidden output path was not retained as an authoritative exclusion"
);
assert(
  !forbiddenOutputContract.exactOutputPaths.includes("verification_suite.py"),
  "a negated create/run clause incorrectly became an exact output requirement"
);
assert(
  !forbiddenOutputContract.exactInputPaths.includes("verification_suite.py"),
  "a forbidden absent path incorrectly became an exact input requirement"
);
assert(
  !mixedRepairAndForbiddenOutputContract.excludedOutputPaths.includes("service_ctl.py"),
  "a later forbidden output path incorrectly excluded the production source named earlier in the same sentence"
);
assert(
  mixedRepairAndForbiddenOutputContract.excludedOutputPaths.includes("verification_suite.py"),
  "the path directly governed by a do-not-create clause was not excluded"
);
assert.deepEqual(
  coordinatedForbiddenOutputContract.excludedOutputPaths.sort(),
  ["scratch.py", "temporary.py"],
  "a coordinated list did not retain each path governed by one exclusion"
);
assert.deepEqual(
  wrappedImmutableSourceContract.excludedOutputPaths.sort(),
  ["TASK.md", "measurements.csv", "prompt.txt", "source_brief.md"].sort(),
  "a wrapped immutable source list lost one or more protected paths"
);
assert(
  !wrappedImmutableSourceContract.exactOutputPaths.some((item) =>
    ["TASK.md", "measurements.csv", "prompt.txt", "source_brief.md"].includes(item)
  ),
  "an immutable source path leaked into exact output requirements"
);
for (const contract of [
  actionWrappedImmutableSourceContract,
  pathWrappedImmutableSourceContract,
]) {
  assert.deepEqual(
    contract.excludedOutputPaths.sort(),
    ["TASK.md", "measurements.csv", "prompt.txt", "source_brief.md"].sort(),
    "a negative action or its governed path list lost protection across a line wrap"
  );
}
assert(
  recoveryInstructionContract.excludedOutputPaths.includes("resume-after-git-baseline-recovery-dev-prompt.txt") &&
    !recoveryInstructionContract.exactOutputPaths.includes("resume-after-git-baseline-recovery-dev-prompt.txt"),
  "an explicit deletion target became a required output"
);
assert.deepEqual(
  recoveryInstructionContract.requiredTextTerms,
  [],
  "verification commands became required document prose"
);
assert.deepEqual(
  recoveryInstructionContract.requiredExecutableTerms,
  [],
  "an environment assignment inside a verification command became required production source"
);
assert(
  !recoveryInstructionContract.exactInputPaths.some((item) => item.includes("PYTHONDONTWRITEBYTECODE")),
  "a quoted verification command became an input path"
);
assert.deepEqual(
  recoveryInstructionContract.requiredProjectCommands,
  [
    "python3 -m unittest discover -s tests -v",
    "PYTHONDONTWRITEBYTECODE=1 python3 /tmp/devops_sensor_gateway_contract.py",
  ],
  "a verification command introduced by 'followed by' was not retained"
);
assert.deepEqual(
  readOnlyVerificationContinuationContract.exactOutputPaths,
  [],
  "a verifier command following a negated create clause became an exact output path"
);
assert.deepEqual(
  readOnlyVerificationContinuationContract.exactInputPaths,
  [],
  "a quoted verifier command became an exact input path"
);
assert.deepEqual(
  readOnlyVerificationContinuationContract.requiredProjectCommands,
  [
    "git status --short",
    "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v",
    "PYTHONDONTWRITEBYTECODE=1 python3 /tmp/devops_sensor_gateway_contract.py",
  ],
  "an exact read-only continuation lost one or more required verification commands"
);
assert.equal(
  readOnlyReviewContract.requiresWorkspaceMutation,
  false,
  "negative review guardrails were misclassified as a workspace mutation request"
);
assert.equal(
  readOnlyReviewContract.requiresFileMutation,
  false,
  "negative review guardrails were misclassified as a file mutation request"
);
assert.equal(
  explicitReviewRepairContract.requiresFileMutation,
  true,
  "an explicit review-and-fix focus lost its positive mutation request"
);
assert(
  pageSafeReportContract.requiredEvidence.some((item) => item.category === "file"),
  "a scoped existing-report edit did not require file evidence"
);
assert(
  pageSafeReportContract.requiredEvidence.some((item) => item.category === "artifact"),
  "a scoped existing-report edit did not require artifact evidence"
);
assert(
  !pageSafeReportContract.requiredEvidence.some((item) => item.category === "browser"),
  "the editorial phrase page-safe incorrectly required browser evidence"
);

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
assert(
  !progressDecision.evidence.some((item) => /no tool results visible/i.test(item)),
  "model-authored no-evidence claim leaked into grounded progress evidence"
);

const hallucinatedAccept = reconcileScsProgressDecision(
  {
    decision: "accept_phase",
    confidence: 0.99,
    evidence: ["All browser checks passed and final video exists."],
    reason: "Every UI and file task completed successfully.",
    next_required_action: "finish",
  },
  {
    ok: false,
    hasAnyEvidence: true,
    reason: "Missing evidence categories: artifact.",
    missing: [{ id: "artifact", category: "artifact" }],
    missingToolCalls: [],
  },
  {
    itemCount: 1,
    categories: ["file"],
    items: [{ id: "e001", category: "file", toolName: "read_file", target: "README.md", proof: "read 120 bytes" }],
    blockers: [],
  }
);
assert.equal(hallucinatedAccept.decision, "accept_phase");
assert.match(hallucinatedAccept.reason, /phase is not complete/i);
assert(!hallucinatedAccept.evidence.some((item) => /browser checks|final video/i.test(item)));
assert(hallucinatedAccept.evidence.some((item) => /read_file README\.md/i.test(item)));
assert.equal(hallucinatedAccept.nextRequiredAction, "collect_evidence:artifact");

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

const researchEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-research-evidence-"));
try {
  const reportPath = path.join(researchEvidenceRoot, "reports", "cited-research.md");
  const artifactPath = path.join(researchEvidenceRoot, "artifacts", "deep-research.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(reportPath, "# Cited research\n\nVerified report fixture.\n", "utf8");
  fs.writeFileSync(artifactPath, JSON.stringify({ status: "completed" }), "utf8");

  const researchReportLedger = buildScsEvidenceLedger({
    context: {
      events: [{
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "deep_research",
          status: "completed",
          reportPath,
          artifactPath,
          coverage: {
            verifiedClaimCount: 12,
            quoteVerificationRate: 1,
          },
          audit: {
            citationCoverage: 1,
            unknownEvidenceIds: [],
          },
        },
      }],
    },
  });
  assert(
    ["file", "command", "artifact"].every((category) => researchReportLedger.categories.includes(category)),
    "a completed and audited deep-research report did not satisfy file, validation-command, and artifact evidence categories"
  );
  assert(
    researchReportLedger.items.some(
      (item) => item.category === "command" && /deterministic audit completed/.test(item.proof)
    ),
    "deep-research validation evidence did not preserve its deterministic audit provenance"
  );
} finally {
  fs.rmSync(researchEvidenceRoot, { recursive: true, force: true });
}

const recoverableLedger = buildScsEvidenceLedger({
  context: {
    events: [
      {
        type: "tool.failed",
        data: {
          ok: false,
          blocked: true,
          recoverable: true,
          category: "tool-contract-violation",
          code: "TOO_MANY_TOOL_CALLS",
          toolName: "tool_call_batch",
          reason: "Retry with a bounded batch.",
        },
      },
      {
        type: "tool.blocked",
        data: {
          ok: false,
          blocked: true,
          category: "repeated-read-only-call",
          toolName: "list_files",
          permissionAdvice: { autoRecover: true },
        },
      },
    ],
  },
});
assert.equal(recoverableLedger.blockerCount, 0, "recoverable runtime guards became external completion blockers");
const recoverablePatchLedger = buildScsEvidenceLedger({
  context: {
    events: [
      {
        type: "tool.failed",
        data: {
          ok: false,
          toolName: "apply_patch",
          error: "Patch search text was not found in analysis.py.",
        },
      },
    ],
  },
});
assert.equal(recoverablePatchLedger.blockerCount, 0, "a recoverable patch context miss became a completion blocker");
const supersededWorkspaceBlockerLedger = buildScsEvidenceLedger({
  context: {
    events: [
      {
        type: "tool.blocked",
        data: {
          toolName: "run_command",
          category: "blocked",
          reason: "mkdir target must be a safe workspace-relative directory: /tmp/test_service",
          permissionAdvice: {
            category: "blocked",
            reason: "mkdir target must be a safe workspace-relative directory: /tmp/test_service",
          },
        },
      },
      {
        type: "tool.blocked",
        data: {
          toolName: "run_command",
          category: "blocked",
          reason: "mkdir target must be a safe workspace-relative directory: /tmp/test_service",
          permissionAdvice: {
            category: "workspace-command-correction",
            reason: "mkdir target must be a safe workspace-relative directory: /tmp/test_service",
            autoRecover: true,
          },
        },
      },
    ],
  },
});
assert.equal(
  supersededWorkspaceBlockerLedger.blockerCount,
  0,
  "a newer recoverable workspace correction did not retire its stale generic blocker"
);
assert.equal(finishResultClaimsBlocker("No external services, logins, or approvals are required."), false);
assert.equal(finishResultClaimsBlocker("The task is blocked and requires human login approval."), true);
assert.equal(finishResultClaimsBlocker("I cannot continue because login is required."), true);
assert.equal(
  finishResultClaimsBlocker("Never signal processes it cannot identify as this exact gateway instance."),
  false,
  "an incidental safety-clause 'cannot' was misclassified as a current external blocker"
);
assert.equal(finishResultClaimsIncompleteWork("Completed and verified the requested report."), false);
assert.equal(
  finishResultClaimsIncompleteWork("The task is paused. A corrected implementation will be written next."),
  true,
  "future work was accepted as a completed result"
);

const outputFilenameContract = deriveScsTaskContract({
  goal: "Save the complete cited report as `CLAIM_LEVEL_CITATION_RESEARCH.md` and include `negative evidence` in the report.",
  taskProfile: "research",
});
assert.deepEqual(outputFilenameContract.exactOutputPaths, ["CLAIM_LEVEL_CITATION_RESEARCH.md"]);
assert(
  !outputFilenameContract.requiredTextTerms.includes("CLAIM_LEVEL_CITATION_RESEARCH.md"),
  "an exact output filename was incorrectly required as literal report prose"
);
assert(
  outputFilenameContract.requiredTextTerms.includes("negative evidence"),
  "excluding output filenames also removed a real required text term"
);

const executableSourceContract = deriveScsTaskContract({
  goal: "Independent acceptance fails because the canonical source does not use portable start_new_session=True. Repair the actual lifecycle implementation.",
  taskProfile: "devops",
});
assert.deepEqual(
  executableSourceContract.requiredExecutableTerms,
  ["start_new_session=True"],
  "an explicit executable implementation requirement was not inferred"
);
const forbiddenExecutableSourceContract = deriveScsTaskContract({
  goal: "Do not use start_new_session=True; preserve the existing platform-specific behavior.",
  taskProfile: "devops",
});
assert.deepEqual(
  forbiddenExecutableSourceContract.requiredExecutableTerms,
  [],
  "a forbidden executable expression became a positive source requirement"
);
const executableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-executable-source-"));
try {
  const sourcePath = path.join(executableRoot, "service_ctl.py");
  const sourceState = {
    meta: {
      projectVerification: {
        mutationHistory: [{ revision: 1, paths: ["service_ctl.py"] }],
      },
    },
  };
  fs.writeFileSync(
    sourcePath,
    [
      "import os",
      "import subprocess",
      "",
      "def launch_service(command):",
      "    # The portable implementation should use start_new_session=True.",
      "    help_text = 'start_new_session=True'",
      "    return subprocess.Popen(command, preexec_fn=os.setsid)",
      "",
    ].join("\n"),
    "utf8"
  );
  const commentOnly = evaluateScsSemanticContract(executableSourceContract, {
    commandCwd: executableRoot,
    state: sourceState,
  });
  assert.equal(commentOnly.ok, false, "a comment/help-string-only expression satisfied executable source semantics");
  assert.deepEqual(commentOnly.missingExecutableTerms, ["start_new_session=True"]);
  fs.writeFileSync(
    sourcePath,
    [
      "import subprocess",
      "",
      "def launch_service(command):",
      "    return subprocess.Popen(command, start_new_session=True)",
      "",
    ].join("\n"),
    "utf8"
  );
  const implemented = evaluateScsSemanticContract(executableSourceContract, {
    commandCwd: executableRoot,
    state: sourceState,
  });
  assert.equal(implemented.ok, true, implemented.reason);
  assert.deepEqual(implemented.executableSourcePaths, ["service_ctl.py"]);
} finally {
  fs.rmSync(executableRoot, { recursive: true, force: true });
}

const wrappedManifestRepairContract = deriveScsTaskContract({
  goal: [
    "The only unresolved content work",
    "is rebuilding the stale sources.json for the current report.",
    "The verified claims are retained in",
    "tmp/reliability-evidence-pass.md. Then write",
    "sources.json immediately. Do not read any other file.",
  ].join("\n"),
  taskProfile: "research",
});
assert.deepEqual(
  wrappedManifestRepairContract.exactOutputPaths,
  ["sources.json"],
  "an inflected, soft-wrapped output instruction did not classify its manifest as an exact output"
);
assert.deepEqual(
  wrappedManifestRepairContract.exactInputPaths,
  ["tmp/reliability-evidence-pass.md"],
  "a mutable exact output leaked into exact inputs through a later negated read clause"
);

const wordDocumentContract = deriveScsTaskContract({
  goal: "Create an editable DOCX and a phone-friendly PDF, then verify both outputs.",
  taskProfile: "word",
});
assert.deepEqual(
  wordDocumentContract.requiredEvidence.map((item) => item.category).sort(),
  ["artifact", "command", "file", "visual"],
  "Word document production must require written files, validation, durable artifacts, and visual evidence"
);

const groundingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-source-grounding-"));
try {
  const reportPath = path.join(groundingRoot, "READINESS.md");
  const contract = {
    exactOutputPaths: ["READINESS.md"],
    requiredTextTerms: [],
    forbiddenTextTerms: [],
    requiresSourceGrounding: true,
  };
  const sourceEvent = {
    type: "tool.completed",
    data: {
      ok: true,
      toolName: "read_file",
      path: "/reference/SKILL.md",
      content:
        "Verified interfaces:\n```bash\nnode bin/musia.js doctor --json\npython scripts/lazyedit_publish.py --video-id VIDEO_ID\n```\n",
    },
  };
  const retainedCommands = extractMarkdownCommandEvidence(
    [
      "```bash",
      "node bin/musia.js doctor --json",
      "node bin/musia.js song review --project-dir data/creative_projects/demo",
      "python scripts/lazyedit_publish.py --video-id VIDEO_ID",
      "```",
      "`Seedance 2.0 Mini 体验版`",
    ].join("\n"),
    "/reference/FULL_SKILL.md"
  );
  const retainedPaths = extractMarkdownPathEvidence(
    [
      "```bash",
      "node bin/musia.js song review --project-dir data/creative_projects/demo",
      "python scripts/lazyedit_publish.py --video-id VIDEO_ID",
      "```",
    ].join("\n"),
    "/reference/FULL_SKILL.md"
  );
  assert.deepEqual(
    retainedCommands.map((item) => item.signature),
    ["node bin/musia.js doctor", "node bin/musia.js song review", "python scripts/lazyedit_publish.py"],
    "full-source command catalog lost subcommands or accepted prose as a command"
  );
  const compactedSourceEvent = {
    type: "tool.completed",
    data: {
      ok: true,
      toolName: "read_file",
      path: "/reference/FULL_SKILL.md",
      contentPreview: "The command examples are below this compacted preview.",
      commandEvidence: retainedCommands,
      pathEvidence: retainedPaths,
    },
  };
  fs.writeFileSync(reportPath, "Run `node bin/musia.js generate --config song.yaml`.\n", "utf8");
  const wrongInterpreterSubcommand = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [compactedSourceEvent],
  });
  assert.equal(wrongInterpreterSubcommand.ok, false, "interpreter script signature hid an invented subcommand");
  assert.deepEqual(
    wrongInterpreterSubcommand.unsupportedCommandClaims.map((item) => item.signature),
    ["node bin/musia.js generate"]
  );
  fs.writeFileSync(reportPath, "Run `node bin/musia.js song review --project-dir data/creative_projects/demo`.\n", "utf8");
  const retainedGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [compactedSourceEvent],
  });
  assert.equal(retainedGrounding.ok, true, retainedGrounding.reason);
  fs.writeFileSync(reportPath, "Inspected `SKILL.md`.\n", "utf8");
  const basenameGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [sourceEvent],
  });
  assert.equal(basenameGrounding.ok, true, "an inspected exact file could not ground its basename reference");
  fs.writeFileSync(reportPath, "Unverified pattern: `Musia/scripts/*`.\n", "utf8");
  const globIsNotExactPathClaim = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [],
  });
  assert.equal(globIsNotExactPathClaim.ok, true, "a glob pattern was treated as an exact file-existence claim");

  fs.writeFileSync(
    reportPath,
    "Timezone: `Asia/Hong_Kong`. Example-only shorthand: `.../lazyedit_publish.py`.\n",
    "utf8"
  );
  const proseTokensAreNotPaths = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [],
  });
  assert.equal(proseTokensAreNotPaths.ok, true, "timezone or ellipsis shorthand was treated as a concrete path claim");

  fs.writeFileSync(reportPath, `Workspace: \`${groundingRoot}\`.\n`, "utf8");
  const workspacePathGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [],
  });
  assert.equal(workspacePathGrounding.ok, true, "the active runtime workspace was not grounded as provenance");

  fs.writeFileSync(reportPath, "Reference directory: `references/MusiaVideo/`.\n", "utf8");
  const parentDirectoryGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "references/MusiaVideo/handoff.md",
          content: "# Handoff\n",
        },
      },
    ],
  });
  assert.equal(parentDirectoryGrounding.ok, true, "an observed child path did not ground its exact parent directory");

  fs.writeFileSync(
    reportPath,
    "Verified file: `/reference/Musia/scripts/bootstrap_musia.sh`.\n",
    "utf8"
  );
  const nestedListGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "list_files",
          path: "/reference/Musia/scripts",
          entries: [{ path: "scripts/bootstrap_musia.sh", type: "file" }],
        },
      },
    ],
  });
  assert.equal(
    nestedListGrounding.ok,
    true,
    "a nested list_files result duplicated its requested directory while resolving entry paths"
  );
  fs.writeFileSync(reportPath, "Verified resumable state: `STATE.md`.\n", "utf8");
  const inventedPath = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [compactedSourceEvent],
  });
  assert.equal(inventedPath.ok, false, "invented path claim was accepted without source evidence");
  assert.deepEqual(inventedPath.unsupportedPathClaims.map((item) => item.path), ["STATE.md"]);

  const selfGroundingContent =
    "Run `inventedctl deploy --state invented/state.json`; verified state is `invented/state.json`.\n";
  fs.writeFileSync(reportPath, selfGroundingContent, "utf8");
  const selfGroundingRead = {
    type: "tool.completed",
    data: {
      ok: true,
      toolName: "read_file",
      path: "READINESS.md",
      content: selfGroundingContent,
      commandEvidence: extractMarkdownCommandEvidence(selfGroundingContent, "READINESS.md"),
      pathEvidence: extractMarkdownPathEvidence(selfGroundingContent, "READINESS.md"),
    },
  };
  const reportCannotGroundItself = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      { type: "file.changed", data: { path: "READINESS.md", commandCwd: groundingRoot } },
      selfGroundingRead,
    ],
  });
  assert.deepEqual(
    reportCannotGroundItself.unsupportedCommandClaims.map((item) => item.signature),
    ["inventedctl deploy"],
    "the exact output circularly grounded its own command claim"
  );
  assert.deepEqual(
    reportCannotGroundItself.unsupportedPathClaims.map((item) => item.path),
    ["invented/state.json"],
    "the exact output circularly grounded its own path claim"
  );

  const helperContent =
    "Use `helperctl verify --state invented/helper-state.json`; source is `invented/helper-state.json`.\n";
  fs.writeFileSync(reportPath, helperContent, "utf8");
  const generatedHelperCannotGroundReport = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "write_file",
          path: "notes/generated-evidence.md",
          change: { path: "notes/generated-evidence.md" },
        },
      },
      {
        type: "file.changed",
        data: { path: "notes/generated-evidence.md", commandCwd: groundingRoot },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "notes/generated-evidence.md",
          content: helperContent,
          commandEvidence: extractMarkdownCommandEvidence(helperContent, "notes/generated-evidence.md"),
          pathEvidence: extractMarkdownPathEvidence(helperContent, "notes/generated-evidence.md"),
        },
      },
    ],
  });
  assert.deepEqual(
    generatedHelperCannotGroundReport.unsupportedCommandClaims.map((item) => item.signature),
    ["helperctl verify"],
    "a session-generated helper circularly grounded a command claim"
  );
  assert.deepEqual(
    generatedHelperCannotGroundReport.unsupportedPathClaims.map((item) => item.path),
    ["invented/helper-state.json"],
    "a session-generated helper circularly grounded a path claim"
  );

  fs.writeFileSync(
    reportPath,
    "Verified generated helper: `notes/generated-evidence.md`.\n",
    "utf8"
  );
  const generatedHelperPathIsDirectlyObserved = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "write_file",
          path: "notes/generated-evidence.md",
          change: { path: "notes/generated-evidence.md" },
        },
      },
      {
        type: "file.changed",
        data: { path: "notes/generated-evidence.md", commandCwd: groundingRoot },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "notes/generated-evidence.md",
          content: helperContent,
          commandEvidence: extractMarkdownCommandEvidence(helperContent, "notes/generated-evidence.md"),
          pathEvidence: extractMarkdownPathEvidence(helperContent, "notes/generated-evidence.md"),
        },
      },
    ],
  });
  assert.equal(
    generatedHelperPathIsDirectlyObserved.ok,
    true,
    "a successful direct read did not ground the generated file's own path"
  );

  const shellSourceContent = [
    "Verified interface:",
    "```bash",
    "node bin/musia.js song review --project-dir data/creative_projects/demo",
    "```",
  ].join("\n");
  const shellSourceEvent = {
    type: "tool.completed",
    data: {
      ok: true,
      toolName: "run_command",
      args: { command: "cat /reference/SHELL_SKILL.md" },
      stdout: shellSourceContent,
    },
  };
  fs.writeFileSync(
    reportPath,
    "Run `node bin/musia.js song review --project-dir data/creative_projects/demo`.\n",
    "utf8"
  );
  const shellSourceGrounding = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [shellSourceEvent],
  });
  assert.equal(shellSourceGrounding.ok, true, shellSourceGrounding.reason);

  const generatedShellHelper = "notes/generated-shell-evidence.md";
  const shellHelperContent =
    "Use `helperctl verify --state invented/shell-helper-state.json`; source is `invented/shell-helper-state.json`.\n";
  fs.writeFileSync(reportPath, shellHelperContent, "utf8");
  const generatedShellReadCannotGroundReport = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "write_file",
          path: generatedShellHelper,
          change: { path: generatedShellHelper },
        },
      },
      {
        type: "file.changed",
        data: { path: generatedShellHelper, commandCwd: groundingRoot },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: `cat ${generatedShellHelper}` },
          stdout: shellHelperContent,
        },
      },
    ],
  });
  assert.deepEqual(
    generatedShellReadCannotGroundReport.unsupportedCommandClaims.map((item) => item.signature),
    ["helperctl verify"],
    "a shell read of a generated helper circularly grounded a command claim"
  );
  assert.deepEqual(
    generatedShellReadCannotGroundReport.unsupportedPathClaims.map((item) => item.path),
    ["invented/shell-helper-state.json"],
    "a shell read of a generated helper circularly grounded a path claim"
  );

  const compoundOutput =
    "Run `spoofctl publish --state invented/compound-state.json`; state is `invented/compound-state.json`.\n";
  fs.writeFileSync(reportPath, compoundOutput, "utf8");
  const compoundReadCannotInjectEvidence = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: "cat /reference/SHELL_SKILL.md; echo injected" },
          stdout: compoundOutput,
        },
      },
    ],
  });
  assert.deepEqual(
    compoundReadCannotInjectEvidence.unsupportedCommandClaims.map((item) => item.signature),
    ["spoofctl publish"],
    "a compound command injected source-command evidence through stdout"
  );

  fs.writeFileSync(reportPath, "Run `musia generate --song demo` and `lalachan mv --input demo.wav`.\n", "utf8");
  const ungrounded = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [sourceEvent],
  });
  assert.equal(ungrounded.ok, false, "semantic gate accepted invented command claims");
  assert.deepEqual(
    ungrounded.unsupportedCommandClaims.map((item) => item.signature),
    ["musia generate", "lalachan mv"]
  );
  assert(
    ungrounded.groundedCommandExamples.some((item) => item.command === "node bin/musia.js doctor --json"),
    "semantic result did not retain an exact grounded command example"
  );

  fs.writeFileSync(reportPath, "Output:\n```\ntotal 128\n-rw-r--r-- 1 demo demo 42 file.txt\n```\n", "utf8");
  const inventedOutput = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [sourceEvent],
  });
  assert.equal(inventedOutput.ok, false, "invented command output was accepted without runtime stdout");
  assert.equal(inventedOutput.unsupportedOutputClaims.length, 1);
  const outputEvent = {
    type: "tool.completed",
    data: {
      ok: true,
      toolName: "run_command",
      args: { command: "example-doctor --status" },
      stdout: "total 128\n-rw-r--r-- 1 demo demo 42 file.txt\n",
    },
  };
  const groundedOutput = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [sourceEvent, outputEvent],
  });
  assert.equal(groundedOutput.ok, true, groundedOutput.reason);

  fs.writeFileSync(
    reportPath,
    "Verified interfaces:\n```bash\nnode bin/musia.js doctor --json\npython scripts/lazyedit_publish.py --video-id VIDEO_ID\n```\n",
    "utf8"
  );
  const grounded = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [sourceEvent],
  });
  assert.equal(grounded.ok, true, grounded.reason);

  fs.writeFileSync(
    reportPath,
    "The runtime invokes `conda run` internally; its `doctor --json` status was reviewed.\n",
    "utf8"
  );
  const inlineCommandProse = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      sourceEvent,
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "/reference/PIPELINE.md",
          content: "```bash\nPYTHONNOUSERSITE=1 conda run -n musia python scripts/run_pipeline.py INPUT_AUDIO\n```\n",
        },
      },
    ],
  });
  assert.equal(
    inlineCommandProse.ok,
    true,
    "prose command fragments were rejected despite a grounded command prefix or were mistaken for standalone executables"
  );

  fs.writeFileSync(
    reportPath,
    [
      "Review with `song review`.",
      "Song: `$MUSIA_ROOT/data/creative_projects/<song>/final/selected.mp3`.",
      "State parent: `data/runs/<run-name>/`.",
      "Helper: `scripts/musia_mv_finalize.sh`.",
      "API: `/api/videos`.",
      "Platforms: `shipinhao/youtube/instagram`.",
      "Shorthand: `/reference/Musia/...` and `stems/{bass,drums,vocals,other}.wav`.",
    ].join("\n"),
    "utf8"
  );
  const equivalentRoutineLiterals = evaluateScsSemanticContract(contract, {
    commandCwd: groundingRoot,
    events: [
      compactedSourceEvent,
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "/reference/Musia/HANDOFF.md",
          content: "Song artifact: `$MUSIA_ROOT/data/creative_projects/SONG/final/selected.mp3`.\n",
        },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: {
            command:
              "cd /reference/LALACHAN && ls -1 scripts; curl -fsS http://127.0.0.1:18787/api/videos",
          },
          stdout: "musia_mv_finalize.sh\n",
        },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "/reference/MV_SKILL.md",
          content: [
            "```bash",
            "ffmpeg -i $MUSIA_ROOT/data/creative_projects/SONG/final/selected.mp3 out.wav",
            "python tool.py --run-dir data/runs/RUN_NAME/stems/bass.wav",
            "curl -fsS http://127.0.0.1:18787/api/videos",
            "```",
          ].join("\n"),
        },
      },
    ],
  });
  assert.equal(
    equivalentRoutineLiterals.ok,
    true,
    `source-grounded subcommands or placeholder-equivalent routine paths were rejected: ${equivalentRoutineLiterals.reason}`
  );

  const rootedContract = {
    ...contract,
    declaredSourceRoots: ["/reference/Musia", "/reference/LALACHAN"],
  };
  fs.writeFileSync(
    reportPath,
    "Known trees: `Musia/data/creative_projects/<song>/final/selected.mp3` and `LALACHAN/scripts/`.\n",
    "utf8"
  );
  const projectRootRelativePaths = evaluateScsSemanticContract(rootedContract, {
    commandCwd: groundingRoot,
    events: [
      compactedSourceEvent,
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "read_file",
          path: "/reference/Musia/HANDOFF.md",
          content: "Song artifact: `$MUSIA_ROOT/data/creative_projects/SONG/final/selected.mp3`.\n",
        },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: "ls -la /reference/LALACHAN" },
          stdout: "drwxr-xr-x 2 demo demo 4096 Aug 20 00:00 scripts\n",
        },
      },
    ],
  });
  assert.equal(
    projectRootRelativePaths.ok,
    true,
    `declared project-root-relative paths were rejected: ${projectRootRelativePaths.reason}`
  );

  const sourceScopeContract = {
    ...contract,
    declaredSourceRoots: ["../Musia", "../LALACHAN"],
    readOnlyReadiness: true,
    requiresPerSourceChecks: true,
  };
  fs.writeFileSync(reportPath, "# Readiness\n\nCurrent readiness remains evidence-bounded.\n", "utf8");
  const scopeEvents = [
    {
      type: "tool.completed",
      data: { ok: true, toolName: "list_files", path: path.resolve(groundingRoot, "../Musia"), entries: [] },
    },
    {
      type: "tool.completed",
      data: { ok: true, toolName: "list_files", path: path.resolve(groundingRoot, "../LALACHAN"), entries: [] },
    },
    {
      type: "tool.completed",
      data: {
        ok: true,
        toolName: "run_command",
        args: { command: "cd ../Musia && node bin/musia.js doctor --json" },
        stdout: "{}",
      },
    },
  ];
  const incompleteScope = evaluateScsSemanticContract(sourceScopeContract, {
    commandCwd: groundingRoot,
    events: scopeEvents,
  });
  assert.deepEqual(incompleteScope.missingSourceChecks, ["../LALACHAN"]);
  const completeScope = evaluateScsSemanticContract(sourceScopeContract, {
    commandCwd: groundingRoot,
    events: [
      ...scopeEvents,
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: "cd ../LALACHAN && scripts/xyq_cdp_browser.py --help" },
          stdout: "usage: xyq_cdp_browser.py",
        },
      },
    ],
  });
  assert.equal(completeScope.ok, true, completeScope.reason);
  const nonzeroObservedScope = evaluateScsSemanticContract(sourceScopeContract, {
    commandCwd: groundingRoot,
    events: [
      ...scopeEvents,
      {
        type: "tool.completed",
        data: {
          ok: false,
          toolName: "run_command",
          args: { command: "cd ../LALACHAN && scripts/xyq_cdp_browser.py --help" },
          exitCode: 2,
          stdout: "",
          stderr: "usage: xyq_cdp_browser.py",
        },
      },
    ],
  });
  assert.equal(
    nonzeroObservedScope.ok,
    true,
    "an executed bounded source check with a nonzero result was mistaken for a missing check"
  );
  const absoluteReadOnlyChecks = evaluateScsSemanticContract(sourceScopeContract, {
    commandCwd: groundingRoot,
    events: [
      ...scopeEvents.slice(0, 2),
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: `ls -la ${path.resolve(groundingRoot, "../Musia")}` },
          stdout: "README.md\n",
        },
      },
      {
        type: "tool.completed",
        data: {
          ok: true,
          toolName: "run_command",
          args: { command: `stat ${path.resolve(groundingRoot, "../LALACHAN")}` },
          stdout: "File: LALACHAN\n",
        },
      },
    ],
  });
  assert.equal(
    absoluteReadOnlyChecks.ok,
    true,
    "successful common read-only commands did not satisfy relative per-source check roots"
  );
} finally {
  fs.rmSync(groundingRoot, { recursive: true, force: true });
}

console.log("SCS evidence visibility smoke ok");
