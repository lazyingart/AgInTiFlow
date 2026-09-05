#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assessInternalRuntimeScaffoldLeak,
  assessResponseOnlyEmptyEnvelope,
  assessResponseOnlyPerfectAudit,
  completionRequirementCoverageInstruction,
  continuationExecutionContractDirective,
  evaluateAuthoritativeStructuredCompletionCoverage,
  removeSupersededCompletionRepairInstructions,
  repositorySourcePrecedenceInstruction,
  runAgent,
} from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  assessBoundedTranscriptResponse,
  assessTranscriptUsability,
} from "../src/response-only-source-quality.js";
import { SessionStore } from "../src/session-store.js";
import {
  deriveScsTaskContract,
  evaluateSourceFreeResponseClaims,
  finishResultClaimsIncompleteWork,
} from "../src/scs-evidence.js";
import { tmuxAvailable } from "../src/tmux-tools.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-truthful-completion-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, "home");

const completionCoverageInstruction = completionRequirementCoverageInstruction();
assert.match(completionCoverageInstruction, /requirement by requirement/i);
assert.match(completionCoverageInstruction, /Every distinct subject/i);
assert.match(completionCoverageInstruction, /authoritative structured routine/i);
assert.match(completionCoverageInstruction, /every relevant section/i);
assert.match(completionCoverageInstruction, /instead of summarizing only failures or only successes/i);

const structuredHealthOutput = JSON.stringify({
  ok: true,
  degraded: true,
  issues: ["wechat_login_required", "android_poll_stalled"],
  queues: {
    wechat: { pending: 0, active: 0, stale_count: 0, recent_failure_count: 0 },
    wecom: { pending: 0, active: 0, stale_count: 0, recent_failure_count: 0 },
  },
  schedules: {
    career_daily: { status: "waiting", running: true },
    memo_daily: { status: "waiting", running: true },
    echomind_daily_pdf: { status: "current", running: true },
  },
});
const structuredHealthRecord = [{ output: structuredHealthOutput, authoritative: true }];
const badStructuredCoverage = evaluateAuthoritativeStructuredCompletionCoverage({
  goal: "Report queue health, schedule state, and authentication blockers concisely.",
  candidateResult: "The system is degraded because WeChat login is required. Schedule state is not visible in the retained output.",
  commandOutputs: structuredHealthRecord,
});
assert.equal(badStructuredCoverage.checked, true);
assert.equal(badStructuredCoverage.ok, false);
assert(badStructuredCoverage.missingSections.includes("queues"));
assert(badStructuredCoverage.missingSections.includes("schedules"));
assert(badStructuredCoverage.contradictedSections.includes("schedules"));
assert.match(badStructuredCoverage.expectedSummary, /Queues: .*wechat pending 0 active 0.*wecom pending 0 active 0/i);
assert.match(badStructuredCoverage.expectedSummary, /Other schedules: .*career_daily.*memo_daily.*echomind_daily_pdf/i);

const goodStructuredCoverage = evaluateAuthoritativeStructuredCompletionCoverage({
  goal: "Report queue health, schedule state, and authentication blockers concisely.",
  candidateResult: "Both queues are clear: WeChat and WeCom have pending 0, active 0, stale 0, and failures 0. Schedules are running: career_daily and memo_daily are waiting, while echomind_daily_pdf is current. Authentication blockers are wechat_login_required and android_poll_stalled.",
  commandOutputs: structuredHealthRecord,
});
assert.equal(goodStructuredCoverage.checked, true);
assert.equal(goodStructuredCoverage.ok, true);
assert.deepEqual(goodStructuredCoverage.missingSections, []);

const unstructuredCoverage = evaluateAuthoritativeStructuredCompletionCoverage({
  goal: "Explain the architecture.",
  candidateResult: "The architecture is complete.",
  commandOutputs: [{ output: "ordinary prose", authoritative: true }],
});
assert.equal(unstructuredCoverage.checked, false);
assert.equal(unstructuredCoverage.ok, true);

const sourcePrecedenceInstruction = repositorySourcePrecedenceInstruction();
assert.match(sourcePrecedenceInstruction, /current direct user request/i);
assert.match(sourcePrecedenceInstruction, /closest project instructions/i);
assert.match(sourcePrecedenceInstruction, /most specific current implementation and tests/i);
assert.match(sourcePrecedenceInstruction, /stale guides/i);
assert.match(sourcePrecedenceInstruction, /AGENTS\.md/i);

const degenerateTranscript = [
  "[00:00.00-00:02.00] 词曲 编曲 缩混 混音 母带 母带",
  "[00:30.00-00:32.00] 缩混 混音 母带 母带",
  "[00:32.00-00:34.00] 母带 母带 母带",
  "[00:34.00-00:36.00] 母带 母带 母带",
  "[00:36.00-00:38.00] 母带 母带 母带",
  "[00:38.00-00:40.00] 母带 母带 母带",
  "[00:40.00-00:42.00] 母带 母带 母带",
  "[00:42.00-00:44.00] 母带 母带 母带",
  "[00:44.00-00:46.00] 母带 母带 母带",
  "[00:46.00-00:48.00] 母带 母带 母带",
].join(" ");
const reliableTranscript = [
  "[00:00.00-00:04.00] 接下来看到的是印度南部的卡纳塔克邦",
  "[00:04.00-00:08.00] 它西临阿拉伯海 东接德干高原",
  "[00:08.00-00:12.00] 西高止山脉从高山延伸到海岸",
  "[00:12.00-00:16.00] 首府班加罗尔也被称为印度硅谷",
  "[00:16.00-00:20.00] 科技城市与古老寺庙在这里并肩而立",
].join(" ");
assert.equal(assessTranscriptUsability(degenerateTranscript, 47.17).usable, false);
assert.equal(
  assessTranscriptUsability(degenerateTranscript, 47.17).reason,
  "strongly-repetitive-transcript"
);
assert.equal(assessTranscriptUsability(reliableTranscript, 20).usable, true);
assert.equal(
  assessTranscriptUsability(
    "这是一段没有空格的完整中文转写内容，它清楚介绍实验方法、观察结果和下一步验证计划。",
    45
  ).usable,
  true,
  "a substantive unsegmented CJK transcript was mistaken for sparse audio"
);

const boundedTranscriptGoal = [
  "Write one concise reply. Identify the video and summarize the actual speech.",
  "Bounded exact-source packet:",
  "```json",
  JSON.stringify({
    source: {
      title: "翩若惊鸿，婉若游龙",
      author: "洛水辞记",
      duration_seconds: 47.17,
      audio_status: "transcribed",
    },
    transcript: degenerateTranscript,
    delivery: {
      video_ready: true,
      transcript_ready: true,
      public_publish_allowed: false,
    },
  }),
  "```",
  'Return JSON only: {"message":"...","files":[],"confirmation":""}.',
].join("\n");
const inventedBoundedSpeechSummary = assessBoundedTranscriptResponse({
  goal: boundedTranscriptGoal,
  result: JSON.stringify({
    message: "这段视频以《洛神赋》为灵感，讲述云端神女踏光而来的浪漫故事。",
    files: [],
    confirmation: "视频和时间戳文本已就绪",
  }),
});
assert.equal(inventedBoundedSpeechSummary.checked, true);
assert.equal(inventedBoundedSpeechSummary.ok, false);
assert.equal(inventedBoundedSpeechSummary.quality.reason, "strongly-repetitive-transcript");
assert.equal(
  assessBoundedTranscriptResponse({
    goal: boundedTranscriptGoal,
    result: JSON.stringify({
      message: "这是洛水辞记的《翩若惊鸿，婉若游龙》。转写内容高度重复，无法可靠概括实际语音；从标题只能判断主题与《洛神赋》有关。",
      files: [],
      confirmation: "视频和时间戳文本已就绪",
    }),
  }).ok,
  true
);
assert.equal(
  assessBoundedTranscriptResponse({
    goal: boundedTranscriptGoal.replace(degenerateTranscript, reliableTranscript),
    result: JSON.stringify({
      message: "视频介绍卡纳塔克邦的自然地貌，以及班加罗尔古老文化和现代科技并存的特点。",
      files: [],
      confirmation: "",
    }),
  }).ok,
  true
);
assert.equal(
  assessBoundedTranscriptResponse({
    goal: boundedTranscriptGoal.replace("summarize the actual speech", "identify the supplied title only"),
    result: JSON.stringify({ message: "标题是《翩若惊鸿，婉若游龙》。", files: [], confirmation: "" }),
  }).checked,
  false,
  "a title-only bounded packet was forced through the speech-summary contract"
);
assert.equal(
  assessBoundedTranscriptResponse({
    goal: boundedTranscriptGoal.replace(degenerateTranscript, ""),
    result: JSON.stringify({ message: "视频中没有可辨识语音，无法做实际讲话摘要。", files: [], confirmation: "" }),
  }).ok,
  true,
  "an honest silent-source response was rejected"
);

const readOnlyContractAuditGoal = `
Audit the current source-intake contract and cover an ordinary video, a hypothetical
same-chat publish request, a Finder card, and a document attachment. Do not send any
message, publish anything, alter a queue, open a browser, or modify configuration.
`;
const readOnlyContractAudit = deriveScsTaskContract({
  goal: readOnlyContractAuditGoal,
  taskProfile: "auto",
});
assert.equal(readOnlyContractAudit.readOnlyReadiness, true);
assert(
  !readOnlyContractAudit.requiredEvidence.some((item) => item.category === "publish"),
  "a hypothetical publish case inside a forbidden read-only contract audit required live publish evidence"
);
assert(
  !readOnlyContractAudit.requiredEvidence.some((item) => item.category === "browser"),
  "a forbidden browser action inside a read-only contract audit required browser evidence"
);
assert(
  readOnlyContractAudit.forbiddenActions.some((item) => /publish anything/i.test(item)),
  "the read-only audit lost its explicit publish prohibition"
);

assert.equal(
  finishResultClaimsIncompleteWork(
    "The report is complete and the verification that was previously paused now passes. No work remains."
  ),
  false,
  "historical paused wording was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier step was paused, but the report is complete and verified now."
  ),
  false,
  "resolved historical pause was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The bounded verification (the previously-paused step) passed, and the audit is complete."
  ),
  false,
  "a hyphenated resolved historical pause was mistaken for current unfinished work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier step was paused and the report is still incomplete."
  ),
  true,
  "historical-pause normalization hid genuinely incomplete current work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The earlier report was complete, but the current task is unfinished."
  ),
  true,
  "historical wording hid an unrelated current unfinished task"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The verifier passed, git status confirms no pending changes, and no further action is needed."
  ),
  false,
  "a clean completed repository was mistaken for pending work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The verifier passed, git status confirms no pending changes, and there is no need for further action."
  ),
  false,
  "a no-further-action completion statement was mistaken for future work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Read-only check done, nothing sent or changed. Still retrying: nightly_pdf (quality_retry_pending; next attempt at 10:14). Queues are otherwise healthy."
  ),
  false,
  "external retry status in a read-only answer was mistaken for unfinished agent work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Schedule status: memo delivered, export retry pending, next attempt tomorrow. This is only a status report."
  ),
  false,
  "external pending status in a read-only answer was mistaken for unfinished agent work"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "The current report is pending and I will finish it next."
  ),
  true,
  "agent-owned pending report work was accepted as a completed result"
);
assert.equal(
  finishResultClaimsIncompleteWork(
    "Pending validation remains before this task is complete."
  ),
  true,
  "agent-owned pending validation was accepted as a completed result"
);

const internalCompactionMessages = [{
  role: "user",
  content: [
    "The runtime proactively compacted a long agent history before the provider context became inefficient or unstable.",
    "Authoritative current goal:",
    "Prepare the requested briefing.",
    "Authoritative verification and artifact checkpoint:",
    "{}",
    "Recovery instruction:",
    "Continue the task.",
  ].join("\n"),
}];
const productionScaffoldResult = [
  "The runtime has compacted the agent history due to context window limits, but all authoritative goals, plans, and retained evidence are preserved.",
  "You are AgInTiFlow and should continue from the recovery instruction.",
  "The original prompt was truncated and the latest genuine user request is not fully visible.",
  "All acceptance criteria are satisfied.",
].join(" ");
const productionScaffoldLeak = assessInternalRuntimeScaffoldLeak({
  messages: internalCompactionMessages,
  goal: "Prepare the requested briefing.",
  result: productionScaffoldResult,
});
assert.equal(productionScaffoldLeak.leaks, true);
assert(productionScaffoldLeak.markers.includes("runtime-compaction-narrative"));
assert(productionScaffoldLeak.markers.includes("prompt-visibility-narrative"));
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: internalCompactionMessages,
    goal: "Prepare the requested briefing.",
    result: "The briefing is complete and the requested reader-facing PDF is attached.",
  }).leaks,
  false,
  "a normal post-compaction task answer was rejected"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: "Explain this text.",
    result: productionScaffoldResult,
  }).leaks,
  false,
  "ordinary text was treated as copied runtime scaffolding without a runtime source packet"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: internalCompactionMessages,
    goal: "Explain how the runtime context-compaction recovery instruction works.",
    result:
      "The runtime compacts agent history and preserves authoritative goals. You are AgInTiFlow is an identity instruction in that scaffold.",
  }).leaks,
  false,
  "an explicit user request to explain runtime compaction was rejected"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: internalCompactionMessages,
    goal: "完成用户请求。",
    result: "运行时已经压缩了代理历史。你是 AgInTiFlow，应按照恢复指令继续。原始请求已被截断。",
  }).leaks,
  true,
  "translated internal runtime scaffolding was accepted"
);
const responseOnlyHostAcknowledgementGoal = [
  "Answer the current human message naturally.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "chat-response",
    request: "Answer the current human message naturally.",
  })}`,
].join("\n");
const retainedEnglishHostAcknowledgement =
  "The WeCom message has been routed into the LabCanvas agent runtime as instructed. No external actions were taken, and the response adheres strictly to the requested format.";
const retainedChineseHostAcknowledgement = "消息已成功路由至LabCanvas运行时环境，无需进一步操作。";
for (const retainedHostAcknowledgement of [
  retainedEnglishHostAcknowledgement,
  retainedChineseHostAcknowledgement,
]) {
  const assessment = assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: responseOnlyHostAcknowledgementGoal,
    result: JSON.stringify({ response: retainedHostAcknowledgement, handled: true }),
  });
  assert.equal(
    assessment.leaks,
    true,
    "a retained host-routing acknowledgement was accepted as the human-facing answer"
  );
  assert(assessment.markers.includes("host-routing-acknowledgement"));
}
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: [
      "Report whether the current message reached LabCanvas.",
      `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
        mode: "read-only-answer",
        request: "Check whether the current message was routed into the LabCanvas runtime.",
      })}`,
    ].join("\n"),
    result: "The message was routed into the LabCanvas runtime.",
  }).leaks,
  false,
  "an explicit host-routing status question could not be answered"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: responseOnlyHostAcknowledgementGoal,
    result: JSON.stringify({
      response: "这个设计需要先核对接口尺寸，再决定公差。",
      handled: true,
    }),
  }).leaks,
  false,
  "a normal response-only human answer was rejected"
);

const privatePacketIdentifierGoal = [
  "You are the response-only reasoning backend for host-managed chat.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Return the requested natural chat message only.",
  })}`,
  "Return one strict JSON object and no prose:",
  JSON.stringify({ message: "natural source-chat response", files: [], confirmation: "" }),
  "Exact task packet:",
  JSON.stringify({
    id: "wecom-inspiration-202609040800-example",
    current_request: "Create one concise, useful inspiration point for the group.",
    route_decision: { route_kind: "research_or_summary" },
    preflight: {
      snapshot: {
        schedules: {
          memo_daily: { status: "waiting" },
        },
      },
    },
  }),
].join("\n");
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: privatePacketIdentifierGoal,
    result: JSON.stringify({
      message: "Reflect on your achievements like the memo_daily task to stay motivated.",
      files: [],
      confirmation: "",
    }),
  }).leaks,
  true,
  "a private packet-only scheduler identifier leaked into a human-facing message"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: privatePacketIdentifierGoal.replace(
      "Create one concise, useful inspiration point for the group.",
      "Explain what the memo_daily task does."
    ),
    result: JSON.stringify({
      message: "memo_daily is the schedule you asked about.",
      files: [],
      confirmation: "",
    }),
  }).leaks,
  false,
  "a machine identifier explicitly named by the human could not be discussed"
);
assert.equal(
  assessInternalRuntimeScaffoldLeak({
    messages: [],
    goal: privatePacketIdentifierGoal,
    result: JSON.stringify({
      message: "Try a small measurement_first experiment and compare the result tomorrow.",
      files: [],
      confirmation: "",
    }),
  }).leaks,
  false,
  "ordinary underscore text absent from the private packet was rejected"
);
const emptyResponseOnlyEnvelope = {
  message: "",
  files: [],
  confirmation: "",
};
assert.equal(
  assessResponseOnlyEmptyEnvelope({
    goal: privatePacketIdentifierGoal,
    result: JSON.stringify(emptyResponseOnlyEnvelope),
  }).ok,
  false,
  "a schema-valid empty host-task envelope was treated as a usable response"
);
for (const usefulPayload of [
  { ...emptyResponseOnlyEnvelope, message: "A concise human-facing answer." },
  { ...emptyResponseOnlyEnvelope, files: ["useful-report.pdf"] },
  { ...emptyResponseOnlyEnvelope, confirmation: "Which sample should I use?" },
  { ...emptyResponseOnlyEnvelope, knowledge_items: [{ subject: "retained preference" }] },
  { ...emptyResponseOnlyEnvelope, publish_stage: { stage: "published_verified" } },
]) {
  assert.equal(
    assessResponseOnlyEmptyEnvelope({
      goal: privatePacketIdentifierGoal,
      result: JSON.stringify(usefulPayload),
    }).ok,
    true,
    "a substantive response-only payload was rejected as empty"
  );
}
assert.equal(
  assessResponseOnlyEmptyEnvelope({
    goal: privatePacketIdentifierGoal.replace(
      "Create one concise, useful inspiration point for the group.",
      "Store the supplied preference and return the message field empty."
    ),
    result: JSON.stringify(emptyResponseOnlyEnvelope),
  }).ok,
  true,
  "an explicit empty-message contract could not be honored"
);

const perfectAuditGoal = [
  "You are the response-only independent reviewer.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Audit the supplied multilingual tutorial independently.",
  })}`,
  "Original prompt:",
  "Audit the candidate carefully. Score each dimension from 1 to 5.",
  "Set accepted=true only when every score is at least 4 and no correction remains.",
  "Required JSON shape:",
  JSON.stringify({
    accepted: true,
    scores: {
      source_fidelity: 5,
      chinese_naturalness: 5,
      english_naturalness: 5,
      japanese_naturalness: 5,
    },
    critical_issues: [],
    revision_instructions: [],
  }),
  "Candidate tutorial:",
  "The vocabulary row contains the malformed Japanese span サイズ交换 instead of サイズ交換.",
].join("\n");
const blanketPerfectAudit = {
  accepted: true,
  scores: {
    source_fidelity: 5,
    chinese_naturalness: 5,
    english_naturalness: 5,
    japanese_naturalness: 5,
  },
  critical_issues: [],
  revision_instructions: [],
};
assert.equal(
  assessResponseOnlyPerfectAudit({
    goal: perfectAuditGoal,
    result: JSON.stringify(blanketPerfectAudit),
  }).requiresConfirmation,
  true,
  "a blanket-perfect multidimensional audit bypassed skeptical confirmation"
);
assert.equal(
  assessResponseOnlyPerfectAudit({
    goal: perfectAuditGoal,
    result: JSON.stringify({
      ...blanketPerfectAudit,
      scores: { ...blanketPerfectAudit.scores, japanese_naturalness: 4 },
    }),
  }).requiresConfirmation,
  false,
  "a qualified non-perfect audit received an unnecessary confirmation turn"
);
assert.equal(
  assessResponseOnlyPerfectAudit({
    goal: perfectAuditGoal,
    result: JSON.stringify({
      ...blanketPerfectAudit,
      accepted: false,
      critical_issues: ["A concrete language defect remains."],
    }),
  }).requiresConfirmation,
  false,
  "an explicit audit rejection received an unnecessary confirmation turn"
);
assert.equal(
  assessResponseOnlyPerfectAudit({
    goal: "Return project metrics from 1 to 5 as JSON.",
    result: JSON.stringify(blanketPerfectAudit),
  }).requiresConfirmation,
  false,
  "a non-audit structured response was mistaken for blanket acceptance"
);

const sourceFreeResearchGoal = [
  "Correct the research status from the host-managed response context.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Correct the research status from the host-managed response context.",
  })}`,
].join("\n");
const completionAuditSourceFreeGoal = [
  "You are a fast completion auditor for one exact task.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Return the completion audit JSON only.",
  })}`,
  "Role: completion_audit",
  "Return JSON only:",
  JSON.stringify({
    covered_item_ids: ["source:123"],
    missing: [{ item_id: "source:456", requirement: "specific omitted action", kind: "reply|artifact|action" }],
    legitimate_blocker: false,
    complexity: "low|medium|high",
    summary: "one short private diagnostic",
  }),
].join("\n");
const retainedCompletionAuditRequirementResult = {
  covered_item_ids: [],
  missing: [{
    item_id: "task:1",
    requirement: "Per reprocess instruction, put the validated PDF itself in candidate_result.",
    kind: "artifact",
  }],
  legitimate_blocker: false,
  complexity: "low",
  summary: "The candidate omitted the requested artifact.",
};
const completionAuditItemIdentityGoal = [
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Return the completion audit JSON only.",
  })}`,
  "Role: completion_audit",
  "Original prompt:",
  "You are a fast completion auditor for one exact task.",
  "Return JSON only:",
  JSON.stringify({
    covered_item_ids: ["source:123"],
    missing: [{
      item_id: "interruption:456",
      requirement: "specific omitted action",
      kind: "reply|artifact|action",
    }],
    legitimate_blocker: false,
    complexity: "low|medium|high",
    summary: "one short private diagnostic",
  }),
  "Task packet:",
  JSON.stringify({
    task_id: "retained-completion-audit",
    request_items: [
      { item_id: "task:actual-message", text: "Answer the current question." },
      { item_id: "interruption:actual-pdf", text: "Also attach the requested PDF." },
    ],
  }),
].join("\n");
const retainedPhantomCompletionAuditResult = {
  covered_item_ids: ["source:123"],
  missing: [{
    item_id: "interruption:456",
    requirement: "specific omitted action",
    kind: "artifact",
  }],
  legitimate_blocker: false,
  complexity: "medium",
  summary: "The candidate omitted one requested artifact.",
};
const validCompletionAuditIdentityResult = {
  covered_item_ids: ["task:actual-message"],
  missing: [{
    item_id: "interruption:actual-pdf",
    requirement: "Attach the requested PDF.",
    kind: "artifact",
  }],
  legitimate_blocker: false,
  complexity: "medium",
  summary: "The answer is present, but its requested PDF is missing.",
};
const overlappingCompletionAuditIdentityResult = {
  ...validCompletionAuditIdentityResult,
  missing: [
    {
      item_id: "task:actual-message",
      requirement: "Answer the current question.",
      kind: "reply",
    },
    ...validCompletionAuditIdentityResult.missing,
  ],
};
const malformedCompletionAuditIdentityResult = {
  ...validCompletionAuditIdentityResult,
  missing: [{
    requirement: "Attach the requested PDF.",
    kind: "artifact",
  }],
};
const invalidCompletionAuditMissingEntryResult = {
  ...validCompletionAuditIdentityResult,
  missing: [{
    item_id: "interruption:actual-pdf",
    kind: "later",
  }],
};
const completionAuditFalseBlockerGoal = [
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Return the completion audit JSON only.",
  })}`,
  "Role: completion_audit",
  "Original prompt:",
  "Audit the candidate against the exact task packet.",
  "Return JSON only:",
  JSON.stringify({
    covered_item_ids: ["source:123"],
    missing: [{
      item_id: "interruption:456",
      requirement: "specific omitted action",
      kind: "reply|artifact|action",
    }],
    legitimate_blocker: false,
    complexity: "low|medium|high",
    summary: "one short private diagnostic",
  }),
  "Task packet:",
  JSON.stringify({
    task_id: "retained-false-blocker-audit",
    request_items: [
      { item_id: "task:current-message", text: "Answer the current question." },
    ],
    candidate_result: {
      message: "",
      confirmation: "",
      files: [],
    },
  }),
].join("\n");
const retainedFalseCompletionAuditBlockerResult = {
  covered_item_ids: [],
  missing: [{
    item_id: "task:current-message",
    requirement: "Answer the current question.",
    kind: "reply",
  }],
  legitimate_blocker: true,
  complexity: "low",
  summary: "The candidate did not answer the request.",
};
const correctedFalseCompletionAuditBlockerResult = {
  ...retainedFalseCompletionAuditBlockerResult,
  legitimate_blocker: false,
};
const retainedEmptyCandidateCoveredResult = {
  covered_item_ids: ["task:current-message"],
  missing: [],
  legitimate_blocker: false,
  complexity: "low",
  summary: "The candidate did not answer the request.",
};
const completionAuditExplicitSilenceGoal = completionAuditFalseBlockerGoal.replace(
  '"text":"Answer the current question."',
  '"text":"Do not send a reply; leave the response empty."'
);
const explicitSilenceCoveredResult = {
  ...retainedEmptyCandidateCoveredResult,
  summary: "The explicit no-reply request is covered by the empty candidate.",
};
const completionAuditGenuineBlockerGoal = completionAuditFalseBlockerGoal.replace(
  '"message":"","confirmation":"","files":[]',
  '"message":"I cannot access the requested account because authentication is required.","confirmation":"","files":[]'
);
const genuineCompletionAuditBlockerResult = {
  covered_item_ids: ["task:current-message"],
  missing: [],
  legitimate_blocker: true,
  complexity: "low",
  summary: "The candidate directly reports the authentication blocker.",
};
const completionAuditChineseBlockerGoal = completionAuditFalseBlockerGoal.replace(
  '"message":"","confirmation":"","files":[]',
  '"message":"当前无法继续，因为需要登录认证。","confirmation":"","files":[]'
);
assert.equal(
  evaluateSourceFreeResponseClaims({
    goal: completionAuditSourceFreeGoal,
    candidateResult: JSON.stringify(retainedCompletionAuditRequirementResult),
    evidenceLedger: { itemCount: 0, categories: [], items: [] },
  }).ok,
  true,
  "a completion auditor's diagnostic missing requirement was treated as an external validation claim"
);
assert.equal(
  evaluateSourceFreeResponseClaims({
    goal: sourceFreeResearchGoal,
    candidateResult: JSON.stringify(retainedCompletionAuditRequirementResult),
    evidenceLedger: { itemCount: 0, categories: [], items: [] },
  }).ok,
  false,
  "ordinary response-only output bypassed validation grounding through an audit-shaped object"
);
assert.equal(
  evaluateSourceFreeResponseClaims({
    goal: completionAuditSourceFreeGoal,
    candidateResult: JSON.stringify({
      ...retainedCompletionAuditRequirementResult,
      summary: "The paper was validated in 2025 on 12,000 patients.",
    }),
    evidenceLedger: { itemCount: 0, categories: [], items: [] },
  }).ok,
  false,
  "a completion auditor's own unsupported factual summary bypassed source-free grounding"
);
const unsafeSourceFreeClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "The publication appeared in 2025 and was validated on a 12,000-case benchmark with 94.2% accuracy.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  unsafeSourceFreeClaim.ok,
  false,
  "source-free response-only output accepted unsupported external factual claims"
);
assert(unsafeSourceFreeClaim.categories.includes("publication"));
assert(unsafeSourceFreeClaim.categories.includes("benchmark_or_metric"));
const unsafeChineseSourceFreeClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "这是未验证的背景说明。2025年Nature子刊预印本未公开，已有初步验证，响应延迟低于100ms，并预测2026年底前上线。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  unsafeChineseSourceFreeClaim.ok,
  false,
  "Chinese source-free response-only output accepted publication, validation, metric, or forecast claims"
);
assert(unsafeChineseSourceFreeClaim.categories.includes("publication"));
assert(unsafeChineseSourceFreeClaim.categories.includes("validation"));
assert(unsafeChineseSourceFreeClaim.categories.includes("benchmark_or_metric"));
assert(unsafeChineseSourceFreeClaim.categories.includes("forecast"));
const unsafeJapaneseSourceFreeClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "2026年末までに公開される見込みで、査読済み研究によりレイテンシ80ms未満が検証済みです。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  unsafeJapaneseSourceFreeClaim.ok,
  false,
  "Japanese source-free response-only output accepted publication, validation, metric, or forecast claims"
);
assert(unsafeJapaneseSourceFreeClaim.categories.includes("forecast"));
assert(unsafeJapaneseSourceFreeClaim.categories.includes("validation"));
assert(unsafeJapaneseSourceFreeClaim.categories.includes("benchmark_or_metric"));
const framedHypothesisClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "Without fresh evidence, this is an unverified hypothesis only: the result may need a new literature check before any publication or benchmark claim is trusted.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  framedHypothesisClaim.ok,
  true,
  "explicit unverified hypothesis framing was rejected for source-free response-only output"
);
const sourceFreePredictionGoal = [
  "Provide one clearly labeled, falsifiable 3/5/10-year prediction as your own hypothesis.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request: "Provide one clearly labeled, falsifiable 3/5/10-year prediction as your own hypothesis.",
  })}`,
].join("\n");
const explicitFalsifiablePrediction = evaluateSourceFreeResponseClaims({
  goal: sourceFreePredictionGoal,
  candidateResult:
    "高风险预测：3年内可能出现无损年龄评分；5年内可能成为质控候选；10年内若仍不能跨实验室迁移，这一假设应被否定。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  explicitFalsifiablePrediction.ok,
  true,
  "an explicitly labeled falsifiable prediction was rejected as an external fact"
);
assert.equal(explicitFalsifiablePrediction.explicitlySpeculative, true);
const explicitJapanesePrediction = evaluateSourceFreeResponseClaims({
  goal: sourceFreePredictionGoal,
  candidateResult:
    "反証可能な予測：2030年までにこの仮説を再現できなければ、採用しない。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  explicitJapanesePrediction.ok,
  true,
  "an explicitly labeled Japanese falsifiable prediction was rejected"
);
const sourceFreeInspirationGoal = [
  "Create one concise, useful inspiration point with a falsifiable prediction and experiment.",
  `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
    mode: "host-managed-response",
    request:
      "Create one concise research inspiration point with a falsifiable prediction and experiment.",
  })}`,
].join("\n");
const retainedNamedJournalEvidence = evaluateSourceFreeResponseClaims({
  goal: sourceFreeInspirationGoal,
  candidateResult:
    "Recent advances in 3D bioprinting (e.g., Nature Biomedical Engineering) provide the first indirect evidence that organoids can exhibit self-organizing states.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedNamedJournalEvidence.ok,
  false,
  "a named journal was accepted as evidence after the model omitted the publication year"
);
assert(retainedNamedJournalEvidence.categories.includes("named_source_evidence"));
const retainedNamedToolkitClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeInspirationGoal,
  candidateResult:
    "Actionable next step: monitor synchronization using the open-source 'NeuroSync' Python toolkit.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedNamedToolkitClaim.ok,
  false,
  "a claimed named open-source research toolkit bypassed source-free grounding"
);
assert(retainedNamedToolkitClaim.categories.includes("named_external_resource"));
const retainedQuotedChineseSource = evaluateSourceFreeResponseClaims({
  goal: sourceFreeInspirationGoal,
  candidateResult:
    "高风险预测：工程化细菌与类器官可能形成异构计算网络。《环球科学》提及细菌晶体管；下一步做盲法对照。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedQuotedChineseSource.ok,
  false,
  "a quoted Chinese publication claim was laundered by a requested prediction"
);
assert(retainedQuotedChineseSource.categories.includes("named_source_evidence"));
const sourceFreeExperimentWithoutAttribution = evaluateSourceFreeResponseClaims({
  goal: sourceFreeInspirationGoal,
  candidateResult:
    "这是一个尚未验证的假设：工程化细菌与类器官可能形成异构计算网络。下一步做盲法对照实验，并预先写明失败条件。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  sourceFreeExperimentWithoutAttribution.ok,
  true,
  "a source-free assistant-owned hypothesis and experiment was incorrectly rejected"
);
const groundedNamedResearchResource = evaluateSourceFreeResponseClaims({
  goal: sourceFreeInspirationGoal,
  candidateResult:
    "The current evidence manifest identifies the open-source 'NeuroSync' Python toolkit.",
  evidenceLedger: {
    itemCount: 1,
    categories: ["source"],
    items: [{ category: "source", verified: true }],
  },
});
assert.equal(
  groundedNamedResearchResource.ok,
  true,
  "a named research resource backed by current scoped evidence was rejected"
);
const attributedPrediction = evaluateSourceFreeResponseClaims({
  goal: sourceFreePredictionGoal,
  candidateResult: "该报告预测2030年底前产品将上线。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  attributedPrediction.ok,
  false,
  "an attributed source-free forecast was mistaken for the assistant's own speculation"
);
const attributedEnglishPrediction = evaluateSourceFreeResponseClaims({
  goal: sourceFreePredictionGoal,
  candidateResult: "High-risk prediction: the report says demand will reach a new peak next year.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  attributedEnglishPrediction.ok,
  false,
  "an English report attribution was mistaken for assistant-owned speculation"
);
const speculativeEvidenceClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreePredictionGoal,
  candidateResult: "高风险预测：某研究已验证该方法，并预测2030年达到94.2%准确率。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  speculativeEvidenceClaim.ok,
  false,
  "a speculation label laundered an unsupported validation or source claim"
);
const unsolicitedPrediction = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "高风险预测：2030年前该路线将成为主流。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  unsolicitedPrediction.ok,
  false,
  "a model-added prediction bypassed the source-free guard without a matching request"
);
const locallyDeniedChineseClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "没有本次新证据，这只是未验证假设：无法验证Nature子刊、2025年发表、已有验证或100ms延迟等说法。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  locallyDeniedChineseClaim.ok,
  true,
  "local Chinese unverifiable/hypothesis framing was rejected"
);
const separatedUnverifiedClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "This paragraph is unverified. The Nature publication appeared in 2025 and validation reached 94.2% accuracy.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  separatedUnverifiedClaim.ok,
  false,
  "a generic unverified phrase in one sentence governed a separate unsupported factual claim"
);
const ordinaryPureChat = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "A recursive function needs a base case so it can stop.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  ordinaryPureChat.ok,
  true,
  "ordinary source-free pure chat was incorrectly rejected"
);
const retainedBareNumberClarification = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "CHAT: 「199793」单独一个数字我这边没有可验证的上下文，不想乱猜。它可能指日期 1997-09-03，也可能是某个编号或误发。补一句它关联什么，我马上接着处理。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedBareNumberClarification.ok,
  true,
  "a bare numeric message clarification was mistaken for a year or forecast claim"
);
const retainedBareNumberRouter = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: JSON.stringify({
    route_kind: "chat_only",
    project: "unknown",
    worker_needed: false,
    reason: "A bare number '199793' cannot be safely inferred as a task without context.",
    ack: "",
    chat_reply: "收到 199793。请问这串数字指什么？",
  }),
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedBareNumberRouter.ok,
  true,
  "a routing clarification for a bare numeric message triggered source-free evidence repair"
);
const ambiguousInputExternalClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "这条消息可能是指某研究在2025年发表并已验证。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  ambiguousInputExternalClaim.ok,
  false,
  "ambiguous-input framing laundered an unsupported publication claim"
);
const projectIdeaInvitation = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "Let's spark creativity together! Share your latest project ideas and collaborate on pushing boundaries.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  projectIdeaInvitation.ok,
  true,
  "the noun 'project' in a source-free invitation was misclassified as a forecast"
);
const attributedProjectsForecast = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "The market analysis projects that demand will grow next year.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  attributedProjectsForecast.ok,
  false,
  "an attributed projects-verb forecast bypassed the source-free guard"
);
const responseOnlyRouterJson = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: JSON.stringify({
    route_kind: "research_or_summary",
    project: "labcanvas",
    worker_needed: true,
    public_publish_intent: false,
    reason: "The shared links need source reading before a concise summary.",
  }),
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  responseOnlyRouterJson.ok,
  true,
  "a response-only routing JSON project label was misclassified as an unsupported forecast"
);
const responseOnlyPublishRouterJson = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: JSON.stringify({
    route_kind: "publish_video",
    project: "lazyedit",
    worker_needed: true,
    needs_recent_media: true,
    public_publish_intent: true,
    public_publish_allowed: true,
    reason:
      "The user explicitly requested publishing the referenced video, so the worker is expected to use the established LazyEdit routine.",
  }),
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  responseOnlyPublishRouterJson.ok,
  true,
  "an operational publish-route assignment was misclassified as an external forecast"
);
const responseOnlyRouterWithForecast = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: JSON.stringify({
    route_kind: "research_or_summary",
    project: "generic",
    worker_needed: true,
    reason:
      "The user requests routing, but the report predicts market demand will grow by 20% next year.",
  }),
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  responseOnlyRouterWithForecast.ok,
  false,
  "a routing explanation laundered an unsupported external forecast"
);
const actualSourceFreeProjection = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "The report projects that demand will grow by 20% next year.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  actualSourceFreeProjection.ok,
  false,
  "a genuine source-free projection bypassed the forecast guard"
);
assert(actualSourceFreeProjection.categories.includes("forecast"));
const retainedCandidateForecastMention = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: JSON.stringify({
    summary:
      "候选结果覆盖了类器官检测分诊系统的结构性矛盾与可证伪预测，但缺少PDF附件及关联分析。",
  }),
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  retainedCandidateForecastMention.ok,
  true,
  "a retained auditor mention of candidate forecast content was treated as the auditor's own forecast"
);
const englishCandidateForecastMention = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "The candidate response includes a falsifiable prediction but omits supporting evidence.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  englishCandidateForecastMention.ok,
  true,
  "an English auditor mention of candidate forecast content was rejected"
);
const japaneseCandidateForecastMention = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult: "候補回答は反証可能な予測を含んでいますが、根拠を欠きます。",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  japaneseCandidateForecastMention.ok,
  true,
  "a Japanese auditor mention of candidate forecast content was rejected"
);
const candidateForecastAssertion = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "The candidate response includes a prediction that demand will grow by 20% next year.",
  evidenceLedger: { itemCount: 0, categories: [], items: [] },
});
assert.equal(
  candidateForecastAssertion.ok,
  false,
  "a future outcome embedded in a candidate-content summary bypassed the source-free guard"
);
const sourcedResponseOnlyClaim = evaluateSourceFreeResponseClaims({
  goal: sourceFreeResearchGoal,
  candidateResult:
    "The retained manifest says the benchmark accuracy is 94.2%.",
  evidenceLedger: {
    itemCount: 1,
    categories: ["command"],
    items: [{ category: "command", verified: true }],
  },
});
assert.equal(
  sourcedResponseOnlyClaim.ok,
  true,
  "response-only output with current scoped evidence was rejected"
);

const staleCompletionRepair =
  "The proposed completion was rejected because the requested action is not supported by concrete runtime evidence. Reason: Missing required git action(s): commit.";
const repairCleanup = removeSupersededCompletionRepairInstructions([
  { role: "assistant", content: "The project validator passed." },
  { role: "user", content: staleCompletionRepair },
  { role: "user", content: "A genuine later user message." },
]);
assert.equal(repairCleanup.removed, 1);
assert.deepEqual(
  repairCleanup.messages.map((message) => message.content),
  ["The project validator passed.", "A genuine later user message."],
  "continuation cleanup removed genuine conversation instead of only turn-scoped runtime repair text"
);
const conditionalCommitDirective = continuationExecutionContractDirective(
  {
    goal: "Continue the task.",
    meta: {
      taskProfile: "cad",
      goalContract: {
        revision: 9,
        activeGoal: "Finish the task and commit task-owned changes if any remain.",
      },
    },
  },
  { taskProfile: "cad" },
  { supersededCompletionRepair: true }
);
assert.match(conditionalCommitDirective, /required Git actions = none/i);
assert.match(conditionalCommitDirective, /Do not manufacture a file edit, empty\/no-op commit/i);
const mandatoryCommitDirective = continuationExecutionContractDirective(
  {
    meta: {
      taskProfile: "code",
      goalContract: {
        revision: 10,
        activeGoal: "Commit the tested changes and push the branch.",
      },
    },
  },
  { taskProfile: "code" },
  { supersededCompletionRepair: true }
);
assert.match(mandatoryCommitDirective, /required Git actions = commit, push/i);

function assistant(content, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function reasoningOnly(reasoning, finishReason = "length") {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: "",
          reasoning_content: reasoning,
        },
      },
    ],
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function scriptedClient(responses, calls) {
  return {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          const response = responses.shift();
          assert(response, `Unexpected model call ${calls.length}.`);
          return response;
        },
      },
    },
  };
}

async function runCase({
  id,
  goal,
  taskProfile = "auto",
  provider = "openai",
  model = "scripted-model",
  routingMode = "manual",
  responses,
  allowShellTool = false,
  allowFileTools = false,
  allowDestructive = false,
  executionTier = "",
  maxOutputTokens = undefined,
  contextBudgetChars = undefined,
  contextBudgetTargetChars = undefined,
  resume = false,
  runtimePatch = undefined,
  expectedRuntimeRevision = undefined,
  providerReadinessMode = undefined,
  setup = null,
  scsActive = false,
}) {
  const workspace = path.join(tempRoot, "workspaces", id);
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });
  if (typeof setup === "function") await setup(workspace);
  const calls = [];
  const client = scriptedClient([...responses], calls);
  const factoryConfigs = [];
  const clientFactory = async (runtimeConfig = {}) => {
    factoryConfigs.push({
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
    });
    return client;
  };
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig(
    {
      provider,
      routingMode,
      model,
      goal,
      taskProfile,
      executionTier,
      allowShellTool,
      allowFileTools,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: scsActive ? "auto" : "off",
      commandCwd: workspace,
      ...(contextBudgetChars ? { contextBudgetChars } : {}),
      ...(contextBudgetTargetChars ? { contextBudgetTargetChars } : {}),
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider,
      routingMode,
      model,
      executionTier,
      sessionId: id,
      resume: resume ? id : "",
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      allowDestructive,
      allowShellTool,
      allowFileTools,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: scsActive ? "auto" : "off",
      clientFactory,
    }
  );
  Object.assign(config, {
    apiKey: "scripted-test-only",
    resume: resume ? id : "",
    clientFactory,
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(contextBudgetChars ? { contextBudgetChars } : {}),
    ...(contextBudgetTargetChars ? { contextBudgetTargetChars } : {}),
    allowDestructive,
    allowShellTool,
    allowFileTools,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive,
    enableScs: scsActive ? "auto" : "off",
    executionPolicy: scsActive
      ? { tier: "focused", requiresPlan: false, reason: "Scripted SCS completion regression." }
      : undefined,
    modelTimeoutMs: 1_000,
    ...(executionTier ? { executionTier, executionPolicy: { tier: executionTier, requiresPlan: false, reason: "Scripted completion smoke." } } : {}),
    ...(providerReadinessMode ? { providerReadinessMode } : {}),
    ...(runtimePatch ? { runtimePatch } : {}),
    ...(expectedRuntimeRevision !== undefined ? { expectedRuntimeRevision } : {}),
  });
  const result = await runAgent(config);
  const store = new SessionStore(sessionsDir, id, { projectRoot: workspace, commandCwd: workspace, projectSessionsDir });
  return {
    result,
    calls,
    factoryConfigs,
    events: await store.loadEvents(),
    state: await store.loadState(),
  };
}

function providerRuntimePatch(provider, model) {
  return {
    provider,
    model,
    routingMode: "manual",
    routeProvider: provider,
    routeModel: model,
    mainProvider: provider,
    mainModel: model,
    spareProvider: provider,
    spareModel: model,
  };
}

function scopedTaskGoal(request, artifactRoot) {
  return [
    "User request:",
    request,
    "",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "task",
      request,
      artifact_root: artifactRoot,
    })}`,
    "",
    "Artifact contract:",
    "- If no file is produced, use an empty artifacts list.",
  ].join("\n");
}

const longStructuredPathSegment = `production-task-${"x".repeat(140)}`;
const longStructuredInput = `references/${longStructuredPathSegment}/source.md`;
const longStructuredOutput = `output/wechat_worker/${longStructuredPathSegment}/report.md`;
const longStructuredExclusion = `output/wechat_worker/${longStructuredPathSegment}/draft.md`;
const longDeclaredSourceRoot = `/home/lachlan/ProjectsLFS/AgenticApp/output/wechat_worker/${longStructuredPathSegment}`;
const longStructuredPathContract = deriveScsTaskContract({
  goal: [
    `Read ${longStructuredInput}.`,
    `Create ${longStructuredOutput}.`,
    `Do not create ${longStructuredExclusion}.`,
    `Use source root \`${longDeclaredSourceRoot}\`.`,
  ].join("\n"),
  taskProfile: "chatops",
});
assert(longStructuredPathContract.exactInputPaths.includes(longStructuredInput));
assert(longStructuredPathContract.exactOutputPaths.includes(longStructuredOutput));
assert(longStructuredPathContract.excludedOutputPaths.includes(longStructuredExclusion));
assert(longStructuredPathContract.declaredSourceRoots.includes(longDeclaredSourceRoot));

try {
  const repairedCompletionAuditIdentity = await runCase({
    id: "response-only-completion-audit-item-identity-repair",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [
      assistant(JSON.stringify(retainedPhantomCompletionAuditResult)),
      assistant(JSON.stringify(validCompletionAuditIdentityResult)),
    ],
  });
  assert.equal(repairedCompletionAuditIdentity.calls.length, 2);
  assert.deepEqual(
    JSON.parse(repairedCompletionAuditIdentity.result.result),
    validCompletionAuditIdentityResult
  );
  const phantomIdentityRejection = repairedCompletionAuditIdentity.events.find(
    (event) => event.type === "response_only.output_contract_rejected"
  );
  assert(phantomIdentityRejection, "phantom completion-audit item IDs were accepted without repair");
  assert.deepEqual(
    phantomIdentityRejection.data.invalidItemIds.sort(),
    ["interruption:456", "source:123"]
  );
  assert.deepEqual(
    phantomIdentityRejection.data.omittedItemIds.sort(),
    ["interruption:actual-pdf", "task:actual-message"]
  );
  assert.match(
    repairedCompletionAuditIdentity.calls[1].messages.map((message) => message.content).join("\n"),
    /must each appear exactly once[\s\S]*task:actual-message[\s\S]*interruption:actual-pdf/iu
  );
  assert(
    repairedCompletionAuditIdentity.events.some(
      (event) => event.type === "response_only.output_contract_repaired"
    ),
    "valid task-scoped completion-audit IDs did not complete the bounded repair"
  );

  const repairedOverlappingCompletionAudit = await runCase({
    id: "response-only-completion-audit-item-identity-overlap",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [
      assistant(JSON.stringify(overlappingCompletionAuditIdentityResult)),
      assistant(JSON.stringify(validCompletionAuditIdentityResult)),
    ],
  });
  assert.equal(repairedOverlappingCompletionAudit.calls.length, 2);
  assert.deepEqual(
    repairedOverlappingCompletionAudit.events.find(
      (event) => event.type === "response_only.output_contract_rejected"
    )?.data?.duplicateItemIds,
    ["task:actual-message"]
  );

  const repairedMalformedCompletionAudit = await runCase({
    id: "response-only-completion-audit-item-identity-malformed",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [
      assistant(JSON.stringify(malformedCompletionAuditIdentityResult)),
      assistant(JSON.stringify(validCompletionAuditIdentityResult)),
    ],
  });
  assert.equal(repairedMalformedCompletionAudit.calls.length, 2);
  assert.deepEqual(
    repairedMalformedCompletionAudit.events.find(
      (event) => event.type === "response_only.output_contract_rejected"
    )?.data?.malformedItemReferences,
    ["missing[0].item_id"]
  );

  const repairedInvalidCompletionAuditMissingEntry = await runCase({
    id: "response-only-completion-audit-missing-entry-shape",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [
      assistant(JSON.stringify(invalidCompletionAuditMissingEntryResult)),
      assistant(JSON.stringify(validCompletionAuditIdentityResult)),
    ],
  });
  assert.equal(
    repairedInvalidCompletionAuditMissingEntry.calls.length,
    2,
    "a completion-audit missing entry without a requirement and with an invalid kind was accepted"
  );
  const invalidMissingEntryRejection = repairedInvalidCompletionAuditMissingEntry.events.find(
    (event) => event.type === "response_only.output_contract_rejected"
  );
  assert.deepEqual(invalidMissingEntryRejection?.data?.invalidMissingItemFields, [
    "missing[0].requirement:missing",
    "missing[0].kind:outside-enum",
  ]);
  assert.match(
    repairedInvalidCompletionAuditMissingEntry.calls[1].messages
      .map((message) => message.content)
      .join("\n"),
    /invalid missing-item fields:[^\n]*requirement:missing[^\n]*kind:outside-enum/iu
  );
  assert.match(
    repairedInvalidCompletionAuditMissingEntry.calls[1].messages
      .map((message) => message.content)
      .join("\n"),
    /each missing\[\] entry requires:[^\n]*"requirement":string[^\n]*"kind":string enum="reply"\|"artifact"\|"action"/iu
  );

  const repairedFalseCompletionAuditBlocker = await runCase({
    id: "response-only-completion-audit-false-blocker",
    taskProfile: "chatops",
    goal: completionAuditFalseBlockerGoal,
    responses: [
      assistant(JSON.stringify(retainedFalseCompletionAuditBlockerResult)),
      assistant(JSON.stringify(correctedFalseCompletionAuditBlockerResult)),
    ],
  });
  assert.equal(
    repairedFalseCompletionAuditBlocker.calls.length,
    2,
    "a completion audit accepted legitimate_blocker=true without a candidate blocker or covered item"
  );
  const falseBlockerRejection = repairedFalseCompletionAuditBlocker.events.find(
    (event) => event.type === "response_only.output_contract_rejected"
  );
  assert.deepEqual(falseBlockerRejection?.data?.invalidAuditSemantics, [
    "legitimate_blocker:true-without-candidate-blocker",
    "legitimate_blocker:true-without-covered-item",
  ]);
  assert.match(
    repairedFalseCompletionAuditBlocker.calls[1].messages
      .map((message) => message.content)
      .join("\n"),
    /invalid completion-audit semantics:[^\n]*true-without-candidate-blocker[^\n]*true-without-covered-item/iu
  );

  const genuineCompletionAuditBlocker = await runCase({
    id: "response-only-completion-audit-genuine-blocker",
    taskProfile: "chatops",
    goal: completionAuditGenuineBlockerGoal,
    responses: [assistant(JSON.stringify(genuineCompletionAuditBlockerResult))],
  });
  assert.equal(
    genuineCompletionAuditBlocker.calls.length,
    1,
    "a candidate's explicit authentication blocker was rejected"
  );
  assert.deepEqual(
    JSON.parse(genuineCompletionAuditBlocker.result.result),
    genuineCompletionAuditBlockerResult
  );

  const chineseCompletionAuditBlocker = await runCase({
    id: "response-only-completion-audit-chinese-blocker",
    taskProfile: "chatops",
    goal: completionAuditChineseBlockerGoal,
    responses: [assistant(JSON.stringify(genuineCompletionAuditBlockerResult))],
  });
  assert.equal(
    chineseCompletionAuditBlocker.calls.length,
    1,
    "a candidate's explicit Chinese authentication blocker was rejected"
  );

  const repairedEmptyCandidateCoverage = await runCase({
    id: "response-only-completion-audit-empty-candidate-covered",
    taskProfile: "chatops",
    goal: completionAuditFalseBlockerGoal,
    responses: [
      assistant(JSON.stringify(retainedEmptyCandidateCoveredResult)),
      assistant(JSON.stringify(correctedFalseCompletionAuditBlockerResult)),
    ],
  });
  assert.equal(
    repairedEmptyCandidateCoverage.calls.length,
    2,
    "an empty candidate was accepted as covering an exact task item"
  );
  assert.deepEqual(
    repairedEmptyCandidateCoverage.events.find(
      (event) => event.type === "response_only.output_contract_rejected"
    )?.data?.invalidAuditSemantics,
    ["covered_item_ids:nonempty-for-empty-candidate"]
  );

  const repeatedEmptyCandidateCoverage = await runCase({
    id: "response-only-completion-audit-empty-candidate-covered-stop",
    taskProfile: "chatops",
    goal: completionAuditFalseBlockerGoal,
    responses: [
      assistant(JSON.stringify(retainedEmptyCandidateCoveredResult)),
      assistant(JSON.stringify(retainedEmptyCandidateCoveredResult)),
    ],
  });
  assert.equal(repeatedEmptyCandidateCoverage.calls.length, 2);
  assert.equal(repeatedEmptyCandidateCoverage.result.stopped, true);
  assert.deepEqual(
    JSON.parse(repeatedEmptyCandidateCoverage.result.result).missing.map(
      (item) => item.item_id
    ),
    ["task:current-message"]
  );
  assert(
    !repeatedEmptyCandidateCoverage.events.some(
      (event) => event.type === "session.finished"
    ),
    "repeated empty-candidate coverage reached terminal success"
  );

  const explicitSilenceCoverage = await runCase({
    id: "response-only-completion-audit-explicit-silence-covered",
    taskProfile: "chatops",
    goal: completionAuditExplicitSilenceGoal,
    responses: [assistant(JSON.stringify(explicitSilenceCoveredResult))],
  });
  assert.equal(
    explicitSilenceCoverage.calls.length,
    1,
    "an explicit no-reply request could not be covered by an empty candidate"
  );

  const repeatedPhantomCompletionAudit = await runCase({
    id: "response-only-completion-audit-item-identity-stop",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [
      assistant(JSON.stringify(retainedPhantomCompletionAuditResult)),
      assistant(JSON.stringify(retainedPhantomCompletionAuditResult)),
    ],
  });
  assert.equal(repeatedPhantomCompletionAudit.calls.length, 2);
  assert.equal(repeatedPhantomCompletionAudit.result.stopped, true);
  assert.equal(
    repeatedPhantomCompletionAudit.result.reason,
    "response_only_output_contract_required"
  );
  const safeAuditStop = JSON.parse(repeatedPhantomCompletionAudit.result.result);
  assert.deepEqual(safeAuditStop.covered_item_ids, []);
  assert.deepEqual(
    safeAuditStop.missing.map((item) => item.item_id).sort(),
    ["interruption:actual-pdf", "task:actual-message"]
  );
  assert(
    !repeatedPhantomCompletionAudit.events.some((event) => event.type === "session.finished"),
    "repeated phantom completion-audit IDs reached terminal success"
  );

  const validCompletionAuditIdentity = await runCase({
    id: "response-only-completion-audit-item-identity-valid",
    taskProfile: "chatops",
    goal: completionAuditItemIdentityGoal,
    responses: [assistant(JSON.stringify(validCompletionAuditIdentityResult))],
  });
  assert.equal(validCompletionAuditIdentity.calls.length, 1);
  assert.deepEqual(
    JSON.parse(validCompletionAuditIdentity.result.result),
    validCompletionAuditIdentityResult
  );

  const retainedCompletionAuditRequirement = await runCase({
    id: "response-only-completion-audit-requirement",
    taskProfile: "chatops",
    goal: completionAuditSourceFreeGoal,
    responses: [assistant(JSON.stringify(retainedCompletionAuditRequirementResult))],
  });
  assert.equal(
    retainedCompletionAuditRequirement.calls.length,
    1,
    "a valid completion-audit requirement consumed an unnecessary repair turn"
  );
  assert.deepEqual(
    JSON.parse(retainedCompletionAuditRequirement.result.result),
    retainedCompletionAuditRequirementResult
  );
  assert(
    !retainedCompletionAuditRequirement.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the retained completion-audit requirement still triggered source-free rejection"
  );
  assert(
    retainedCompletionAuditRequirement.events.some((event) => event.type === "session.finished"),
    "the valid completion audit did not finish normally"
  );

  const explanation = await runCase({
    id: "ordinary-explanation",
    goal: "Explain why recursion needs a base case.",
    responses: [assistant("A base case stops recursive calls and lets the stack unwind.")],
  });
  assert.equal(explanation.calls.length, 1);
  assert.equal(explanation.result.stopped, undefined);
  assert.match(explanation.result.result, /stops recursive calls/i);
  assert(explanation.events.some((event) => event.type === "session.finished"));
  assert(!explanation.events.some((event) => event.type === "completion.evidence_rejected"));
  assert(
    String(explanation.state.messages.find((message) => message.role === "system")?.content || "").length < 10_000,
    "focused runtime prompt did not use progressive disclosure"
  );
  assert.match(
    String(explanation.state.messages.find((message) => message.role === "system")?.content || ""),
    /run that command unchanged before probing --help, alternate wrappers/i,
    "focused runtime did not prioritize exact established routine commands"
  );
  assert(
    Math.max(
      ...explanation.state.messages
        .filter((message) => /^Step \d+\/\d+ .*Latest runtime snapshot:/i.test(String(message.content || "")))
        .map((message) => String(message.content || "").length)
    ) < 2_000,
    "focused runtime snapshot repeated the full capability manual"
  );

  const crossTaskIsolationId = "scoped-artifact-cross-task-completion";
  const crossTaskWorkspace = path.join(tempRoot, "workspaces", crossTaskIsolationId);
  const currentTaskRoot = path.join(crossTaskWorkspace, "output", "tasks", "current-task");
  const siblingTaskRoot = path.join(crossTaskWorkspace, "output", "tasks", "sibling-task");
  const currentTaskReport = path.join(currentTaskRoot, "current-report.md");
  const siblingTaskReport = path.join(siblingTaskRoot, "sibling-report.md");
  const crossTaskCompletion = await runCase({
    id: crossTaskIsolationId,
    taskProfile: "chatops",
    goal: scopedTaskGoal(
      "Create a daily research briefing under the exact task artifact root and return its verified reader-facing artifact.",
      currentTaskRoot
    ),
    allowFileTools: true,
    setup: async () => {
      await fs.mkdir(siblingTaskRoot, { recursive: true });
      await fs.writeFile(siblingTaskReport, "SIBLING TASK\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("write-current-task", "write_file", {
        path: currentTaskReport,
        content: "CURRENT TASK\n",
      })]),
      assistant("", [toolCall("finish-sibling-task", "finish", {
        result: `Created and verified ${siblingTaskReport}`,
      })]),
      assistant("", [toolCall("finish-current-task", "finish", {
        result: `Created and verified ${currentTaskReport}`,
      })]),
    ],
  });
  assert.equal(
    crossTaskCompletion.calls.length,
    3,
    "a sibling task artifact path was accepted as the current task completion"
  );
  assert.equal(crossTaskCompletion.result.stopped, undefined);
  assert.match(crossTaskCompletion.result.result, /current-report\.md/u);
  assert.doesNotMatch(crossTaskCompletion.result.result, /sibling-report\.md/u);
  assert(
    crossTaskCompletion.events.some(
      (event) => event.type === "completion.cross_task_artifact_rejected"
    ),
    "the cross-task completion did not leave private rejection evidence"
  );

  const crossTaskReadId = "scoped-artifact-cross-task-read";
  const crossTaskReadWorkspace = path.join(tempRoot, "workspaces", crossTaskReadId);
  const crossTaskReadCurrentRoot = path.join(crossTaskReadWorkspace, "output", "tasks", "current-task");
  const crossTaskReadSiblingRoot = path.join(crossTaskReadWorkspace, "output", "tasks", "sibling-task");
  const crossTaskReadCurrentFile = path.join(crossTaskReadCurrentRoot, "source.md");
  const crossTaskReadSiblingFile = path.join(crossTaskReadSiblingRoot, "source.md");
  const crossTaskRead = await runCase({
    id: crossTaskReadId,
    taskProfile: "chatops",
    goal: scopedTaskGoal(
      `Read ${crossTaskReadCurrentFile} and summarize it without creating a file.`,
      crossTaskReadCurrentRoot
    ),
    allowFileTools: true,
    setup: async () => {
      await fs.mkdir(crossTaskReadCurrentRoot, { recursive: true });
      await fs.mkdir(crossTaskReadSiblingRoot, { recursive: true });
      await fs.writeFile(crossTaskReadCurrentFile, "CURRENT SOURCE\n", "utf8");
      await fs.writeFile(crossTaskReadSiblingFile, "SIBLING SOURCE\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("read-sibling-task", "read_file", {
        path: crossTaskReadSiblingFile,
      })]),
      assistant("", [toolCall("read-current-task", "read_file", {
        path: crossTaskReadCurrentFile,
      })]),
      assistant("The current source says CURRENT SOURCE."),
    ],
  });
  assert.equal(crossTaskRead.calls.length, 3);
  assert.match(crossTaskRead.result.result, /CURRENT SOURCE/u);
  assert(
    crossTaskRead.events.some(
      (event) =>
        event.type === "tool.blocked" &&
        event.data?.category === "cross-task-artifact-scope"
    ),
    "read_file could inspect an undeclared sibling task root"
  );

  const crossTaskShellId = "scoped-artifact-cross-task-shell-read";
  const crossTaskShellWorkspace = path.join(tempRoot, "workspaces", crossTaskShellId);
  const crossTaskShellCurrentRoot = path.join(crossTaskShellWorkspace, "output", "tasks", "current-task");
  const crossTaskShellSiblingRoot = path.join(crossTaskShellWorkspace, "output", "tasks", "sibling-task");
  const crossTaskShellCurrentFile = path.join(crossTaskShellCurrentRoot, "source.md");
  const crossTaskShellSiblingFile = path.join(crossTaskShellSiblingRoot, "source.md");
  const crossTaskShellRead = await runCase({
    id: crossTaskShellId,
    taskProfile: "chatops",
    goal: scopedTaskGoal(
      `Read ${crossTaskShellCurrentFile} with a shell command and report its text.`,
      crossTaskShellCurrentRoot
    ),
    allowShellTool: true,
    allowFileTools: true,
    setup: async () => {
      await fs.mkdir(crossTaskShellCurrentRoot, { recursive: true });
      await fs.mkdir(crossTaskShellSiblingRoot, { recursive: true });
      await fs.writeFile(crossTaskShellCurrentFile, "CURRENT SHELL SOURCE\n", "utf8");
      await fs.writeFile(crossTaskShellSiblingFile, "SIBLING SHELL SOURCE\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("shell-read-sibling-task", "run_command", {
        command: `cat ${crossTaskShellSiblingFile}`,
      })]),
      assistant("", [toolCall("shell-read-current-task", "run_command", {
        command: `cat ${crossTaskShellCurrentFile}`,
      })]),
      assistant("", [toolCall("file-read-current-shell-source", "read_file", {
        path: crossTaskShellCurrentFile,
      })]),
      assistant("The current shell source says CURRENT SHELL SOURCE."),
    ],
  });
  assert.equal(crossTaskShellRead.calls.length, 4);
  assert.match(crossTaskShellRead.result.result, /CURRENT SHELL SOURCE/u);
  assert(
    crossTaskShellRead.events.some(
      (event) =>
        event.type === "tool.blocked" &&
        event.data?.category === "cross-task-artifact-scope"
    ),
    "run_command could inspect an undeclared sibling task root"
  );

  const declaredSiblingInputId = "scoped-artifact-declared-sibling-input";
  const declaredSiblingInputWorkspace = path.join(tempRoot, "workspaces", declaredSiblingInputId);
  const declaredSiblingCurrentRoot = path.join(declaredSiblingInputWorkspace, "output", "tasks", "current-task");
  const declaredSiblingSourceRoot = path.join(declaredSiblingInputWorkspace, "output", "tasks", "declared-source");
  const declaredSiblingSourceFile = path.join(declaredSiblingSourceRoot, "source.md");
  const declaredSiblingInput = await runCase({
    id: declaredSiblingInputId,
    taskProfile: "chatops",
    goal: scopedTaskGoal(
      `Use the declared read-only source root \`${declaredSiblingSourceRoot}\`. Read its supplied source and summarize it in chat without creating artifacts.`,
      declaredSiblingCurrentRoot
    ),
    allowFileTools: true,
    setup: async () => {
      await fs.mkdir(declaredSiblingCurrentRoot, { recursive: true });
      await fs.mkdir(declaredSiblingSourceRoot, { recursive: true });
      await fs.writeFile(declaredSiblingSourceFile, "DECLARED SOURCE\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("read-declared-sibling-source", "read_file", {
        path: declaredSiblingSourceFile,
      })]),
      assistant("The explicitly supplied file says DECLARED SOURCE."),
    ],
  });
  assert.equal(declaredSiblingInput.calls.length, 2);
  assert.match(declaredSiblingInput.result.result, /DECLARED SOURCE/u);
  assert(
    !declaredSiblingInput.events.some(
      (event) =>
        event.type === "tool.blocked" &&
        event.data?.category === "cross-task-artifact-scope"
    ),
    "an explicitly declared sibling input was blocked"
  );

  const compactionRecoveryGoal = [
    "Return exactly READY. Do not use any external tool or claim external facts.",
    `Retained background notes: ${"context-only background. ".repeat(1600)}`,
  ].join("\n");
  const recoveredFromInternalScaffold = await runCase({
    id: "internal-runtime-scaffold-recovery",
    goal: compactionRecoveryGoal,
    contextBudgetChars: 8_000,
    contextBudgetTargetChars: 5_000,
    responses: [
      assistant(productionScaffoldResult),
      assistant("READY"),
    ],
  });
  assert.equal(recoveredFromInternalScaffold.calls.length, 2);
  assert.equal(recoveredFromInternalScaffold.result.result, "READY");
  assert(
    recoveredFromInternalScaffold.events.some(
      (event) => event.type === "history.compacted_for_context_budget"
    ),
    "production-shaped fixture did not enter runtime context compaction"
  );
  assert.equal(
    recoveredFromInternalScaffold.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    1,
    "copied internal compaction scaffolding was not rejected exactly once"
  );
  assert.equal(
    recoveredFromInternalScaffold.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_repair_requested"
    ).length,
    1,
    "copied internal compaction scaffolding did not receive one bounded repair"
  );
  assert(
    recoveredFromInternalScaffold.calls[1].messages.some(
      (message) => /repeated private recovery or compaction scaffolding/i.test(String(message.content || ""))
    ),
    "the repaired model turn did not receive a task-facing recovery instruction"
  );
  assert(
    !recoveredFromInternalScaffold.state.messages.some(
      (message) => message.role === "assistant" && String(message.content || "").includes("original prompt was truncated")
    ),
    "rejected internal scaffolding remained in the resumed conversation"
  );

  const repeatedInternalScaffold = await runCase({
    id: "internal-runtime-scaffold-repeated",
    goal: compactionRecoveryGoal,
    contextBudgetChars: 8_000,
    contextBudgetTargetChars: 5_000,
    responses: [
      assistant(productionScaffoldResult),
      assistant(productionScaffoldResult),
    ],
  });
  assert.equal(repeatedInternalScaffold.calls.length, 2);
  assert.equal(repeatedInternalScaffold.result.stopped, true);
  assert.equal(repeatedInternalScaffold.result.reason, "model_did_not_execute");
  assert.equal(
    repeatedInternalScaffold.result.result,
    "I could not produce a reliable response for this message."
  );
  assert.doesNotMatch(
    repeatedInternalScaffold.result.result,
    /model|session|provider|runtime|resume|repair attempt/iu,
    "internal-scaffold stop exposed private runtime diagnostics"
  );
  assert.equal(
    repeatedInternalScaffold.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    2
  );
  assert(!repeatedInternalScaffold.events.some((event) => event.type === "session.finished"));

  // Recreate a state written by the older continuation classifier: the
  // expanded continuation was incorrectly persisted as the durable task.
  // A later generic resume must still recover the original material request.
  {
    const workspace = path.join(tempRoot, "workspaces", "ordinary-explanation");
    const store = new SessionStore(path.join(tempRoot, "sessions"), "ordinary-explanation", {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir: path.join(workspace, ".aginti-sessions"),
    });
    const stale = await store.loadState();
    const expandedContinuation =
      "Please continue and finish the same task from retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy.";
    stale.goal = expandedContinuation;
    stale.meta.goalContract.taskGoal = expandedContinuation;
    stale.meta.goalContract.history.push({
      revision: stale.meta.goalContract.revision + 1,
      kind: "continuation",
      relation: "new-request",
      preview: expandedContinuation,
    });
    await store.saveState(stale);
  }

  const sameTaskContinuation = await runCase({
    id: "ordinary-explanation",
    goal: "Please continue and finish the same task from the retained state. Repair the canonical project in place, follow every documented requirement, verify every deliverable, and leave the folder tidy.",
    resume: true,
    responses: [assistant("A base case also defines the smallest directly solvable input.")],
  });
  const continuationEvent = [...sameTaskContinuation.events]
    .reverse()
    .find((event) => event.type === "conversation.continued");
  assert.equal(continuationEvent?.data?.preservesTaskBoundary, true);
  assert.equal(
    sameTaskContinuation.state.goal,
    "Explain why recursion needs a base case.",
    "a generic same-task resume replaced the authoritative task goal"
  );
  assert(
    sameTaskContinuation.state.messages.some(
      (message) =>
        message.role === "user" &&
        /^Continue the current task from saved state:/i.test(String(message.content || ""))
    ),
    "same-task resume used the new-request boundary marker"
  );

  const prefixedSameTaskContinuation = await runCase({
    id: "ordinary-explanation",
    goal: [
      "You have explicit trusted-host approval for this isolated fixture.",
      "Continue the same task from the current edits. Finish it with verified evidence.",
    ].join(" "),
    resume: true,
    responses: [assistant("A base case remains the condition that terminates recursive expansion.")],
  });
  const prefixedContinuationEvent = [...prefixedSameTaskContinuation.events]
    .reverse()
    .find((event) => event.type === "conversation.continued");
  assert.equal(
    prefixedContinuationEvent?.data?.preservesTaskBoundary,
    true,
    "a same-task continuation prefixed by a permission statement opened a new task boundary"
  );
  assert.equal(
    prefixedSameTaskContinuation.state.meta?.goalContract?.taskGoal,
    "Explain why recursion needs a base case.",
    "a prefixed same-task continuation replaced the durable task goal"
  );

  const quotedChatClassification = await runCase({
    id: "quoted-chat-classification",
    taskProfile: "chatops",
    goal: [
      "Context:",
      "- Message 1: Generate a new video from the supplied video, but do not publish.",
      "- Message 2: Return the generated MP4 to the same chat.",
      'Return exactly one JSON object and no prose: {"intent":"generation_only","publish":false}.',
    ].join("\n"),
    responses: [assistant('{"intent":"generation_only","publish":false}')],
  });
  assert.equal(quotedChatClassification.calls.length, 1);
  assert.equal(quotedChatClassification.result.stopped, undefined);
  assert.equal(quotedChatClassification.result.result, '{"intent":"generation_only","publish":false}');
  assert(!quotedChatClassification.events.some((event) => event.type === "completion.evidence_rejected"));

  const repairedUnexpectedStrictJsonField = await runCase({
    id: "tool-capable-strict-json-unexpected-field",
    taskProfile: "chatops",
    goal: [
      "Answer the current chat message.",
      'Return exactly one strict JSON object and no prose: {"response":"","handled":true}.',
    ].join("\n"),
    responses: [
      assistant(JSON.stringify({
        response: "Handled the current message.",
        handled: true,
        provider: "localllm",
      })),
      assistant(JSON.stringify({
        response: "Handled the current message.",
        handled: true,
      })),
    ],
  });
  assert.equal(
    repairedUnexpectedStrictJsonField.calls.length,
    2,
    "an undeclared field was accepted in an explicitly closed JSON envelope"
  );
  const unexpectedFieldRejection = repairedUnexpectedStrictJsonField.events.find(
    (event) =>
      event.type === "completion.output_contract_rejected" &&
      event.data?.unexpectedKeys?.length
  );
  assert(
    unexpectedFieldRejection,
    `missing unexpected-key rejection: ${JSON.stringify(
      repairedUnexpectedStrictJsonField.events.filter(
        (event) => event.type === "completion.output_contract_rejected"
      )
    )}`
  );
  assert.deepEqual(unexpectedFieldRejection?.data?.unexpectedKeys, ["provider"]);
  assert.match(
    repairedUnexpectedStrictJsonField.calls[1].messages
      .map((message) => message.content)
      .join("\n"),
    /undeclared top-level keys: provider/iu
  );

  const extensibleJsonField = await runCase({
    id: "tool-capable-extensible-json-field",
    taskProfile: "chatops",
    goal: [
      "Answer the current chat message.",
      'Return JSON: {"response":""}.',
    ].join("\n"),
    responses: [assistant(JSON.stringify({
      response: "Handled the current message.",
      detail: "Useful optional detail.",
    }))],
  });
  assert.equal(extensibleJsonField.calls.length, 1);
  assert.equal(extensibleJsonField.result.stopped, undefined);
  assert(
    !extensibleJsonField.events.some(
      (event) => event.type === "completion.output_contract_rejected"
    ),
    "a plain extensible JSON example rejected an optional top-level field"
  );

  const toolCapableJsonGoal = [
    "Run pwd and report the verified working directory.",
    "Return one strict JSON object and no prose:",
    JSON.stringify({
      message: "direct user-facing answer",
      files: [],
      confirmation: "",
      knowledge_items: [],
      upstream_feedback: [],
    }),
  ].join("\n");
  const validToolCapableJson = JSON.stringify({
    message: "Verified the working directory with pwd.",
    files: [],
    confirmation: "",
    knowledge_items: [],
    upstream_feedback: [],
  });
  const repairedToolCapableJsonFinish = await runCase({
    id: "tool-capable-json-finish-repair",
    taskProfile: "shell",
    goal: toolCapableJsonGoal,
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("json-pwd-finish", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("json-invalid-finish", "finish", {
        result: "Verified the working directory with pwd.",
      })]),
      assistant("", [toolCall("json-repaired-finish", "finish", {
        result: validToolCapableJson,
      })]),
    ],
  });
  assert.equal(
    repairedToolCapableJsonFinish.calls.length,
    3,
    "a tool-capable finish bypassed the explicit JSON output contract"
  );
  assert.deepEqual(JSON.parse(repairedToolCapableJsonFinish.result.result), JSON.parse(validToolCapableJson));
  assert.equal(
    repairedToolCapableJsonFinish.events.filter(
      (event) => event.type === "completion.output_contract_rejected"
    ).length,
    1
  );
  assert.equal(
    repairedToolCapableJsonFinish.events.filter(
      (event) => event.type === "completion.output_contract_repaired"
    ).length,
    1
  );

  const repairedToolCapableJsonContent = await runCase({
    id: "tool-capable-json-assistant-repair",
    taskProfile: "shell",
    goal: toolCapableJsonGoal,
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("json-pwd-content", "run_command", { command: "pwd" })]),
      assistant("Verified the working directory with pwd."),
      assistant(validToolCapableJson),
    ],
  });
  assert.equal(
    repairedToolCapableJsonContent.calls.length,
    3,
    "tool-capable assistant content bypassed the explicit JSON output contract"
  );
  assert.deepEqual(JSON.parse(repairedToolCapableJsonContent.result.result), JSON.parse(validToolCapableJson));

  const repeatedInvalidToolCapableJson = await runCase({
    id: "tool-capable-json-repeated-invalid",
    taskProfile: "shell",
    goal: toolCapableJsonGoal,
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("json-pwd-repeated", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("json-invalid-repeated-1", "finish", {
        result: "Verified the working directory with pwd.",
      })]),
      assistant("", [toolCall("json-invalid-repeated-2", "finish", {
        result: "Done.",
      })]),
    ],
  });
  assert.equal(repeatedInvalidToolCapableJson.calls.length, 3);
  assert.equal(repeatedInvalidToolCapableJson.result.stopped, true);
  assert.equal(repeatedInvalidToolCapableJson.result.reason, "model_did_not_execute");
  assert.deepEqual(Object.keys(JSON.parse(repeatedInvalidToolCapableJson.result.result)), [
    "message",
    "files",
    "confirmation",
    "knowledge_items",
    "upstream_feedback",
  ]);
  assert(
    repeatedInvalidToolCapableJson.events.some(
      (event) => event.type === "completion.output_contract_failed_closed"
    )
  );
  assert(!repeatedInvalidToolCapableJson.events.some((event) => event.type === "session.finished"));

  const responseOnlyScope = {
    mode: "chat-response",
    request: "Return the requested text only; no external action is requested.",
  };
  const responseOnlyControlEchoGoal = [
    "You are the response-only reasoning backend for a chat host.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify(responseOnlyScope)}`,
    "Current message:",
    "Can you answer the new question instead of repeating runtime metadata?",
    "Return the finished chat response only.",
  ].join("\n");
  const repairedResponseOnlyControlEcho = await runCase({
    id: "response-only-control-envelope-echo-repair",
    taskProfile: "chatops",
    goal: responseOnlyControlEchoGoal,
    responses: [
      assistant(JSON.stringify(responseOnlyScope)),
      assistant("I will answer the new question directly rather than repeat runtime metadata."),
    ],
  });
  assert.equal(
    repairedResponseOnlyControlEcho.calls.length,
    2,
    "a response-only control-envelope echo was accepted without repair"
  );
  assert.equal(
    repairedResponseOnlyControlEcho.result.result,
    "I will answer the new question directly rather than repeat runtime metadata."
  );
  assert.equal(
    repairedResponseOnlyControlEcho.events.filter(
      (event) => event.type === "response_only.context_echo_rejected"
    ).length,
    1
  );
  assert.equal(
    repairedResponseOnlyControlEcho.events.filter(
      (event) => event.type === "response_only.context_echo_repaired"
    ).length,
    1
  );

  const staleBotMessage = "哈哈，这是马老师能量传输的副作用，能把知识讲得有趣些。";
  const currentChatMessage = "不会最后科研做不成，被训练成段子手了吧？";
  const staleBotContextGoal = [
    "You are the response-only reasoning backend for a chat host.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify(responseOnlyScope)}`,
    "Return one strict JSON object and no prose:",
    JSON.stringify({ response: "natural reply to the current message", handled: true }),
    "Current message:",
    currentChatMessage,
    "Recent same-chat context:",
    JSON.stringify([
      { local_id: 481, sender_display: "LabAgent", content: staleBotMessage, is_self: true },
      { local_id: 482, sender_display: "sunnyyty", content: currentChatMessage, is_self: false },
    ]),
  ].join("\n");
  const repairedStaleBotContextEcho = await runCase({
    id: "response-only-prior-self-message-echo-repair",
    taskProfile: "chatops",
    goal: staleBotContextGoal,
    responses: [
      assistant(JSON.stringify({ response: staleBotMessage, handled: true })),
      assistant(JSON.stringify({
        response: "不会。幽默只是表达方式，科研判断仍要靠证据和实验。",
        handled: true,
      })),
    ],
  });
  assert.equal(
    repairedStaleBotContextEcho.calls.length,
    2,
    "a prior bot-authored chat message was accepted as the answer to a different current message"
  );
  assert.equal(
    JSON.parse(repairedStaleBotContextEcho.result.result).response,
    "不会。幽默只是表达方式，科研判断仍要靠证据和实验。"
  );
  assert(
    repairedStaleBotContextEcho.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /prior bot-authored chat message/i.test(String(message.content || "")) &&
        /"response":string, "handled":boolean/i.test(String(message.content || ""))
    ),
    "the context-echo repair omitted the current-turn boundary or JSON contract"
  );

  const hostAcknowledgementContextGoal = [
    "You are the response-only reasoning backend for a chat host.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "chat-response",
      request: currentChatMessage,
    })}`,
    "Return one strict JSON object and no prose:",
    JSON.stringify({ response: "natural reply to the current message", handled: true }),
    "Current message:",
    currentChatMessage,
  ].join("\n");
  const repairedHostAcknowledgement = await runCase({
    id: "response-only-host-acknowledgement-repair",
    taskProfile: "chatops",
    goal: hostAcknowledgementContextGoal,
    responses: [
      assistant(JSON.stringify({
        response: retainedEnglishHostAcknowledgement,
        handled: true,
      })),
      assistant(JSON.stringify({
        response: "不会。幽默只是表达方式，科研判断仍要靠证据和实验。",
        handled: true,
      })),
    ],
  });
  assert.equal(repairedHostAcknowledgement.calls.length, 2);
  assert.deepEqual(
    Object.keys(JSON.parse(repairedHostAcknowledgement.result.result)),
    ["response", "handled"],
    "host acknowledgement repair changed the explicit JSON envelope"
  );
  assert.equal(
    JSON.parse(repairedHostAcknowledgement.result.result).response,
    "不会。幽默只是表达方式，科研判断仍要靠证据和实验。"
  );
  assert.equal(
    repairedHostAcknowledgement.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    1
  );
  assert.equal(
    repairedHostAcknowledgement.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_repaired"
    ).length,
    1
  );
  assert(
    repairedHostAcknowledgement.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /routing acknowledgement/i.test(String(message.content || ""))
    ),
    "the host acknowledgement repair did not explain the task-facing defect"
  );

  const repeatedHostAcknowledgement = await runCase({
    id: "response-only-host-acknowledgement-repeated",
    taskProfile: "chatops",
    goal: hostAcknowledgementContextGoal,
    responses: [
      assistant(JSON.stringify({
        response: retainedEnglishHostAcknowledgement,
        handled: true,
      })),
      assistant(JSON.stringify({
        response: retainedChineseHostAcknowledgement,
        handled: true,
      })),
    ],
  });
  assert.equal(repeatedHostAcknowledgement.calls.length, 2);
  assert.equal(repeatedHostAcknowledgement.result.stopped, true);
  assert.equal(repeatedHostAcknowledgement.result.reason, "model_did_not_execute");
  assert.deepEqual(
    Object.keys(JSON.parse(repeatedHostAcknowledgement.result.result)),
    ["response", "handled"],
    "host acknowledgement fail-closed result broke the explicit JSON envelope"
  );
  assert.equal(
    JSON.parse(repeatedHostAcknowledgement.result.result).handled,
    false,
    "host acknowledgement fail-closed result claimed the current message was handled"
  );
  assert.equal(
    JSON.parse(repeatedHostAcknowledgement.result.result).response,
    "这条消息暂时没有生成可靠的答复。"
  );
  assert.doesNotMatch(
    JSON.parse(repeatedHostAcknowledgement.result.result).response,
    /response-only|模型|会话|提供商|运行时|恢复|重试/iu,
    "response-only scaffold stop exposed private runtime diagnostics"
  );
  assert.equal(
    repeatedHostAcknowledgement.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    2
  );
  assert(
    repeatedHostAcknowledgement.events.some(
      (event) => event.type === "response_only.internal_runtime_scaffold_failed_closed"
    )
  );
  assert(!repeatedHostAcknowledgement.events.some((event) => event.type === "session.finished"));

  const packetIdentifierLeak = {
    message: "Reflect on your achievements like the memo_daily task to stay motivated.",
    files: [],
    confirmation: "",
  };
  const repairedPacketIdentifierLeak = await runCase({
    id: "response-only-private-packet-identifier-repair",
    taskProfile: "chatops",
    goal: privatePacketIdentifierGoal,
    responses: [
      assistant(JSON.stringify(packetIdentifierLeak)),
      assistant(JSON.stringify({
        message: "Choose one small result from today and write down what made it possible.",
        files: [],
        confirmation: "",
      })),
    ],
  });
  assert.equal(repairedPacketIdentifierLeak.calls.length, 2);
  assert.deepEqual(
    Object.keys(JSON.parse(repairedPacketIdentifierLeak.result.result)),
    ["message", "files", "confirmation"],
    "private-identifier repair changed the explicit JSON envelope"
  );
  assert.doesNotMatch(
    JSON.parse(repairedPacketIdentifierLeak.result.result).message,
    /memo_daily/
  );
  assert.equal(
    repairedPacketIdentifierLeak.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    1
  );
  assert(
    repairedPacketIdentifierLeak.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /private task or schedule identifiers/i.test(String(message.content || ""))
    ),
    "the repair did not explain the private packet-identifier boundary"
  );

  const repeatedPacketIdentifierLeak = await runCase({
    id: "response-only-private-packet-identifier-repeated",
    taskProfile: "chatops",
    goal: privatePacketIdentifierGoal,
    responses: [
      assistant(JSON.stringify(packetIdentifierLeak)),
      assistant(JSON.stringify({
        ...packetIdentifierLeak,
        confirmation: "The memo_daily schedule is ready.",
      })),
    ],
  });
  assert.equal(repeatedPacketIdentifierLeak.calls.length, 2);
  assert.equal(repeatedPacketIdentifierLeak.result.stopped, true);
  assert.deepEqual(
    Object.keys(JSON.parse(repeatedPacketIdentifierLeak.result.result)),
    ["message", "files", "confirmation"],
    "private-identifier fail-closed result broke the explicit JSON envelope"
  );
  assert.equal(
    repeatedPacketIdentifierLeak.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    2
  );
  assert(!repeatedPacketIdentifierLeak.events.some((event) => event.type === "session.finished"));

  const emptyResponseOnlyEnvelope = {
    message: "",
    files: [],
    confirmation: "",
  };
  const repairedEmptyResponseOnlyEnvelope = await runCase({
    id: "response-only-empty-envelope-repair",
    taskProfile: "chatops",
    goal: privatePacketIdentifierGoal,
    responses: [
      assistant(JSON.stringify(emptyResponseOnlyEnvelope)),
      assistant(JSON.stringify({
        message: "Choose one useful result from today and note the decision that produced it.",
        files: [],
        confirmation: "",
      })),
    ],
  });
  assert.equal(
    repairedEmptyResponseOnlyEnvelope.calls.length,
    2,
    "a schema-valid but semantically empty chat envelope was accepted as finished"
  );
  assert.match(
    JSON.parse(repairedEmptyResponseOnlyEnvelope.result.result).message,
    /Choose one useful result/
  );
  assert.equal(
    repairedEmptyResponseOnlyEnvelope.events.filter(
      (event) => event.type === "response_only.empty_payload_repair_requested"
    ).length,
    1
  );
  assert.equal(
    repairedEmptyResponseOnlyEnvelope.events.filter(
      (event) => event.type === "response_only.empty_payload_repaired"
    ).length,
    1
  );

  const repeatedEmptyResponseOnlyEnvelope = await runCase({
    id: "response-only-empty-envelope-repeated",
    taskProfile: "chatops",
    goal: privatePacketIdentifierGoal,
    responses: [
      assistant(JSON.stringify(emptyResponseOnlyEnvelope)),
      assistant(JSON.stringify(emptyResponseOnlyEnvelope)),
    ],
  });
  assert.equal(repeatedEmptyResponseOnlyEnvelope.calls.length, 2);
  assert.equal(repeatedEmptyResponseOnlyEnvelope.result.stopped, true);
  assert.equal(repeatedEmptyResponseOnlyEnvelope.result.reason, "empty_response_only_payload");
  assert.deepEqual(
    Object.keys(JSON.parse(repeatedEmptyResponseOnlyEnvelope.result.result)),
    ["message", "files", "confirmation"],
    "empty-envelope fail-closed result broke the explicit JSON contract"
  );
  assert.match(
    JSON.parse(repeatedEmptyResponseOnlyEnvelope.result.result).message,
    /could not produce a reliable response for this message/i
  );
  assert.doesNotMatch(
    JSON.parse(repeatedEmptyResponseOnlyEnvelope.result.result).message,
    /response-only|model|session|provider|runtime|resume|repair attempt/iu,
    "empty-envelope stop exposed private runtime diagnostics"
  );
  assert(
    repeatedEmptyResponseOnlyEnvelope.events.some(
      (event) => event.type === "response_only.empty_payload_failed_closed"
    )
  );
  assert(!repeatedEmptyResponseOnlyEnvelope.events.some((event) => event.type === "session.finished"));

  const chineseEmptyResponseOnlyGoal = [
    "You are the response-only reasoning backend for a chat host.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "host-managed-response",
      request: "用户希望得到一个简短可靠的答复。",
    })}`,
    "Return one strict JSON object and no prose:",
    JSON.stringify({ message: "", files: [], confirmation: "" }),
    "Exact task packet:",
    JSON.stringify({
      id: "wecom-chat-20260905-example",
      current_request: "用户希望得到一个简短可靠的答复。",
    }),
  ].join("\n");
  const chineseRepeatedEmptyResponseOnlyEnvelope = await runCase({
    id: "response-only-empty-envelope-repeated-chinese",
    taskProfile: "chatops",
    goal: chineseEmptyResponseOnlyGoal,
    responses: [
      assistant(JSON.stringify(emptyResponseOnlyEnvelope)),
      assistant(JSON.stringify(emptyResponseOnlyEnvelope)),
    ],
  });
  assert.equal(chineseRepeatedEmptyResponseOnlyEnvelope.calls.length, 2);
  assert.equal(chineseRepeatedEmptyResponseOnlyEnvelope.result.stopped, true);
  const chineseEmptyStop = JSON.parse(chineseRepeatedEmptyResponseOnlyEnvelope.result.result);
  assert.deepEqual(Object.keys(chineseEmptyStop), ["message", "files", "confirmation"]);
  assert.equal(chineseEmptyStop.message, "这条消息暂时没有生成可靠的答复。");
  assert.doesNotMatch(
    chineseEmptyStop.message,
    /response-only|模型|会话|提供商|运行时|恢复|重试/iu,
    "Chinese empty-envelope stop exposed private runtime diagnostics"
  );
  assert(
    !chineseRepeatedEmptyResponseOnlyEnvelope.events.some(
      (event) => event.type === "session.finished"
    )
  );

  const revisedAudit = {
    ...blanketPerfectAudit,
    accepted: false,
    scores: {
      ...blanketPerfectAudit.scores,
      japanese_naturalness: 2,
    },
    critical_issues: ["「サイズ交换」must be corrected to 「サイズ交換」."],
    revision_instructions: ["Correct the malformed Japanese vocabulary entry."],
  };
  const skepticallyRevisedAudit = await runCase({
    id: "response-only-perfect-audit-revised",
    taskProfile: "chatops",
    goal: perfectAuditGoal,
    responses: [
      assistant(JSON.stringify(blanketPerfectAudit)),
      assistant(JSON.stringify(revisedAudit)),
    ],
  });
  assert.equal(
    skepticallyRevisedAudit.calls.length,
    2,
    "a blanket-perfect audit reached the host without independent verification"
  );
  assert.equal(JSON.parse(skepticallyRevisedAudit.result.result).accepted, false);
  assert.match(
    JSON.parse(skepticallyRevisedAudit.result.result).critical_issues[0],
    /サイズ交换/
  );
  assert(
    skepticallyRevisedAudit.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /independent skeptical verification/i.test(String(message.content || "")) &&
        /accepted.*boolean/i.test(String(message.content || ""))
    ),
    "the perfect-audit verification omitted the skeptical instruction or JSON contract"
  );
  assert.equal(
    skepticallyRevisedAudit.events.filter(
      (event) => event.type === "response_only.perfect_audit_confirmation_requested"
    ).length,
    1
  );
  assert.equal(
    skepticallyRevisedAudit.events.find(
      (event) => event.type === "response_only.perfect_audit_reviewed"
    )?.data?.outcome,
    "revised"
  );

  const skepticallyConfirmedAudit = await runCase({
    id: "response-only-perfect-audit-confirmed",
    taskProfile: "chatops",
    goal: perfectAuditGoal.replace(
      "The vocabulary row contains the malformed Japanese span サイズ交换 instead of サイズ交換.",
      "The short candidate satisfies each declared requirement."
    ),
    responses: [
      assistant(JSON.stringify(blanketPerfectAudit)),
      assistant(JSON.stringify(blanketPerfectAudit)),
    ],
  });
  assert.equal(skepticallyConfirmedAudit.calls.length, 2);
  assert.equal(JSON.parse(skepticallyConfirmedAudit.result.result).accepted, true);
  assert.equal(
    skepticallyConfirmedAudit.events.find(
      (event) => event.type === "response_only.perfect_audit_reviewed"
    )?.data?.outcome,
    "confirmed-perfect"
  );
  assert(skepticallyConfirmedAudit.events.some((event) => event.type === "session.finished"));

  const rejectedAuditNeedsNoConfirmation = await runCase({
    id: "response-only-rejected-audit-single-turn",
    taskProfile: "chatops",
    goal: perfectAuditGoal,
    responses: [assistant(JSON.stringify(revisedAudit))],
  });
  assert.equal(rejectedAuditNeedsNoConfirmation.calls.length, 1);
  assert.equal(JSON.parse(rejectedAuditNeedsNoConfirmation.result.result).accepted, false);
  assert(
    !rejectedAuditNeedsNoConfirmation.events.some(
      (event) => event.type === "response_only.perfect_audit_confirmation_requested"
    )
  );

  const explicitPriorMessageRepeat = await runCase({
    id: "response-only-explicit-prior-message-repeat",
    taskProfile: "chatops",
    goal: [
      "Return the finished chat response only.",
      `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify(responseOnlyScope)}`,
      "Current message:",
      `Please repeat this exact prior sentence without changing it: ${staleBotMessage}`,
      "Recent same-chat context:",
      JSON.stringify([
        { local_id: 481, sender_display: "LabAgent", content: staleBotMessage, is_self: true },
      ]),
    ].join("\n"),
    responses: [assistant(staleBotMessage)],
  });
  assert.equal(
    explicitPriorMessageRepeat.calls.length,
    1,
    "an explicit request to repeat prior text triggered an unnecessary context-echo repair"
  );
  assert.equal(explicitPriorMessageRepeat.result.result, staleBotMessage);

  const quotedPriorMessageQuestion = await runCase({
    id: "response-only-quoted-prior-message-is-not-repeat-permission",
    taskProfile: "chatops",
    goal: [
      "Return the finished chat response only.",
      `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify(responseOnlyScope)}`,
      "Current message:",
      `Why did you previously say this: ${staleBotMessage}`,
      "Recent same-chat context:",
      JSON.stringify([
        { local_id: 481, sender_display: "LabAgent", content: staleBotMessage, is_self: true },
      ]),
    ].join("\n"),
    responses: [
      assistant(staleBotMessage),
      assistant("That sentence continued the group's joke, but it did not answer the later question."),
    ],
  });
  assert.equal(
    quotedPriorMessageQuestion.calls.length,
    2,
    "quoting an old bot message was mistaken for an explicit request to repeat it"
  );
  assert.equal(
    quotedPriorMessageQuestion.result.result,
    "That sentence continued the group's joke, but it did not answer the later question."
  );

  const repeatedStaleBotContextEcho = await runCase({
    id: "response-only-prior-self-message-echo-fail-closed",
    taskProfile: "chatops",
    goal: staleBotContextGoal,
    responses: [
      assistant(JSON.stringify({ response: staleBotMessage, handled: true })),
      assistant(JSON.stringify({ response: staleBotMessage, handled: true })),
    ],
  });
  assert.equal(repeatedStaleBotContextEcho.calls.length, 2);
  assert.equal(repeatedStaleBotContextEcho.result.stopped, true);
  assert.equal(repeatedStaleBotContextEcho.result.reason, "stale_response_context_replay");
  assert.deepEqual(Object.keys(JSON.parse(repeatedStaleBotContextEcho.result.result)), [
    "response",
    "handled",
  ]);
  assert(
    !repeatedStaleBotContextEcho.events.some((event) => event.type === "session.finished"),
    "a repeated stale bot-message replay was persisted as a successful finish"
  );

  const sourceFreeInspirationJsonGoal = [
    sourceFreeInspirationGoal,
    "Return one strict JSON object and no prose:",
    JSON.stringify({
      message: "natural source-chat response",
      files: [],
      confirmation: "",
      knowledge_items: [],
      upstream_feedback: [],
    }),
    "Exact task packet:",
    JSON.stringify({
      id: "wecom-inspiration-source-free-example",
      current_request:
        "Create one concise research inspiration point with a falsifiable prediction and experiment.",
    }),
  ].join("\n");
  const repairedNamedInspirationEvidence = await runCase({
    id: "response-only-named-inspiration-evidence-repair",
    taskProfile: "chatops",
    goal: sourceFreeInspirationJsonGoal,
    responses: [
      assistant(JSON.stringify({
        message:
          "Recent advances in 3D bioprinting (e.g., Nature Biomedical Engineering) provide the first indirect evidence of self-organizing organoids. Use the open-source 'NeuroSync' Python toolkit.",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
      assistant(JSON.stringify({
        message:
          "这是一个尚未验证的假设：工程化细菌与类器官可能形成异构计算网络。下一步可做盲法对照实验，并预先写明失败条件。",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
    ],
  });
  assert.equal(repairedNamedInspirationEvidence.calls.length, 2);
  assert.equal(repairedNamedInspirationEvidence.result.stopped, undefined);
  assert.deepEqual(
    Object.keys(JSON.parse(repairedNamedInspirationEvidence.result.result)),
    ["message", "files", "confirmation", "knowledge_items", "upstream_feedback"]
  );
  assert.match(
    JSON.parse(repairedNamedInspirationEvidence.result.result).message,
    /尚未验证的假设/u
  );
  assert.equal(
    repairedNamedInspirationEvidence.events.filter(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ).length,
    1
  );
  assert.equal(
    repairedNamedInspirationEvidence.events.filter(
      (event) => event.type === "response_only.source_free_claim_repaired"
    ).length,
    1
  );
  assert(
    repairedNamedInspirationEvidence.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /named journals or sources/i.test(String(message.content || "")) &&
        /named research resources or tool availability/i.test(String(message.content || "")) &&
        /"message":string, "files":array, "confirmation":string/i.test(
          String(message.content || "")
        )
    ),
    "named-evidence repair omitted either the grounding rule or caller JSON contract"
  );

  const failedClosedNamedInspirationEvidence = await runCase({
    id: "response-only-named-inspiration-evidence-fail-closed",
    taskProfile: "chatops",
    goal: sourceFreeInspirationJsonGoal,
    responses: [
      assistant(JSON.stringify({
        message:
          "Nature Biomedical Engineering provides evidence for this route; use the open-source 'NeuroSync' Python toolkit.",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
      assistant(JSON.stringify({
        message:
          "《环球科学》提及这一验证结果；继续使用开源 NeuroSync Python 工具包。",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
    ],
  });
  assert.equal(failedClosedNamedInspirationEvidence.calls.length, 2);
  assert.equal(failedClosedNamedInspirationEvidence.result.stopped, true);
  assert.equal(
    failedClosedNamedInspirationEvidence.result.reason,
    "source_free_evidence_required"
  );
  assert.deepEqual(
    Object.keys(JSON.parse(failedClosedNamedInspirationEvidence.result.result)),
    ["message", "files", "confirmation", "knowledge_items", "upstream_feedback"]
  );
  assert(
    !failedClosedNamedInspirationEvidence.events.some(
      (event) => event.type === "session.finished"
    ),
    "repeated unsupported named evidence was persisted as a successful finish"
  );

  const emptyAfterSourceFreeRepair = await runCase({
    id: "response-only-empty-after-source-free-repair",
    taskProfile: "chatops",
    goal: sourceFreeInspirationJsonGoal,
    responses: [
      assistant(JSON.stringify({
        message:
          "Nature Biomedical Engineering provides evidence for this route; use the open-source NeuroSync toolkit.",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
      assistant(JSON.stringify({
        message: "",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
    ],
  });
  assert.equal(emptyAfterSourceFreeRepair.calls.length, 2);
  assert.equal(
    emptyAfterSourceFreeRepair.result.stopped,
    true,
    "an empty envelope introduced by source-free repair was accepted as finished"
  );
  assert.equal(emptyAfterSourceFreeRepair.result.reason, "empty_response_only_payload");
  assert(
    emptyAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the cross-validator fixture did not exercise source-free repair"
  );
  assert(!emptyAfterSourceFreeRepair.events.some((event) => event.type === "session.finished"));

  const staleEchoAfterSourceFreeRepair = await runCase({
    id: "response-only-stale-echo-after-source-free-repair",
    taskProfile: "chatops",
    goal: staleBotContextGoal,
    responses: [
      assistant(JSON.stringify({
        response:
          "The publication appeared in 2025 and was validated on 12,000 cases with 94.2% accuracy.",
        handled: true,
      })),
      assistant(JSON.stringify({ response: staleBotMessage, handled: true })),
    ],
  });
  assert.equal(staleEchoAfterSourceFreeRepair.calls.length, 2);
  assert.equal(staleEchoAfterSourceFreeRepair.result.stopped, true);
  assert.equal(
    staleEchoAfterSourceFreeRepair.result.reason,
    "stale_response_context_replay",
    "a source-free evidence repair reintroduced a stale bot message and still finished"
  );
  assert(
    staleEchoAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the production-shaped first answer did not exercise source-free repair"
  );
  assert(
    !staleEchoAfterSourceFreeRepair.events.some((event) => event.type === "session.finished"),
    "a stale bot message introduced by a later validator repair was persisted as successful"
  );

  const hostAcknowledgementAfterSourceFreeRepair = await runCase({
    id: "response-only-host-acknowledgement-after-source-free-repair",
    taskProfile: "chatops",
    goal: sourceFreeInspirationJsonGoal,
    responses: [
      assistant(JSON.stringify({
        message:
          "The publication appeared in 2025 and was validated on 12,000 cases with 94.2% accuracy.",
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
      assistant(JSON.stringify({
        message: retainedEnglishHostAcknowledgement,
        files: [],
        confirmation: "",
        knowledge_items: [],
        upstream_feedback: [],
      })),
    ],
  });
  assert.equal(hostAcknowledgementAfterSourceFreeRepair.calls.length, 2);
  assert.equal(
    hostAcknowledgementAfterSourceFreeRepair.result.stopped,
    true,
    "a source-free evidence repair reintroduced a host acknowledgement and still finished"
  );
  assert.equal(hostAcknowledgementAfterSourceFreeRepair.result.reason, "model_did_not_execute");
  assert(
    hostAcknowledgementAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the cross-validator fixture did not exercise source-free repair"
  );
  assert.equal(
    hostAcknowledgementAfterSourceFreeRepair.events.filter(
      (event) => event.type === "completion.internal_runtime_scaffold_rejected"
    ).length,
    1
  );
  assert(
    !hostAcknowledgementAfterSourceFreeRepair.events.some(
      (event) => event.type === "completion.internal_runtime_scaffold_repair_requested"
    ),
    "the final-boundary guard spent another repair attempt after the bounded repair budget"
  );
  assert(
    !hostAcknowledgementAfterSourceFreeRepair.events.some(
      (event) => event.type === "session.finished"
    ),
    "host control language introduced by a later validator repair was persisted as successful"
  );

  const perfectAuditAfterSourceFreeRepair = await runCase({
    id: "response-only-perfect-audit-after-source-free-repair",
    taskProfile: "chatops",
    goal: perfectAuditGoal,
    responses: [
      assistant(JSON.stringify({
        ...revisedAudit,
        critical_issues: [
          "Nature Biomedical Engineering validated this in 2025 on 12,000 cases with 94.2% accuracy.",
        ],
        revision_instructions: ["Use the reported validated benchmark."],
      })),
      assistant(JSON.stringify(blanketPerfectAudit)),
      assistant(JSON.stringify(revisedAudit)),
    ],
  });
  assert.equal(
    perfectAuditAfterSourceFreeRepair.calls.length,
    3,
    "a blanket-perfect audit introduced by source-free repair bypassed skeptical confirmation"
  );
  assert.equal(JSON.parse(perfectAuditAfterSourceFreeRepair.result.result).accepted, false);
  assert.match(
    JSON.parse(perfectAuditAfterSourceFreeRepair.result.result).critical_issues[0],
    /サイズ交换/u
  );
  assert.equal(
    perfectAuditAfterSourceFreeRepair.events.filter(
      (event) => event.type === "response_only.perfect_audit_confirmation_requested"
    ).length,
    1
  );
  assert.equal(
    perfectAuditAfterSourceFreeRepair.events.find(
      (event) => event.type === "response_only.perfect_audit_reviewed"
    )?.data?.outcome,
    "revised"
  );
  assert(
    perfectAuditAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the audit cross-validator fixture did not exercise source-free repair"
  );
  assert(
    perfectAuditAfterSourceFreeRepair.events.some(
      (event) => event.type === "session.finished"
    ),
    "the skeptically revised audit did not complete normally"
  );

  const boundedTranscriptResponseGoal = [
    "You are the response-only reasoning backend for a chat host.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "chat-response",
      request: "Return the requested text only; no external action is requested.",
    })}`,
    boundedTranscriptGoal,
  ].join("\n");
  const repairedDegenerateTranscriptSummary = await runCase({
    id: "bounded-degenerate-transcript-repair",
    taskProfile: "chatops",
    goal: boundedTranscriptResponseGoal,
    responses: [
      assistant(JSON.stringify({
        message: "洛水辞记的视频以洛神赋为灵感，展现云端神女踏光而来的浪漫意境。",
        files: [],
        confirmation: "视频和时间戳文本已就绪",
      })),
      assistant(JSON.stringify({
        message: "这是洛水辞记的《翩若惊鸿，婉若游龙》。转写内容高度重复，无法可靠概括实际语音；从标题只能判断主题与《洛神赋》有关。",
        files: [],
        confirmation: "视频和时间戳文本已就绪",
      })),
    ],
  });
  assert.equal(repairedDegenerateTranscriptSummary.calls.length, 2);
  assert.equal(repairedDegenerateTranscriptSummary.result.stopped, undefined);
  assert.match(repairedDegenerateTranscriptSummary.result.result, /无法可靠概括实际语音/u);
  assert.equal(
    repairedDegenerateTranscriptSummary.events.filter(
      (event) => event.type === "response_only.transcript_quality_rejected"
    ).length,
    1
  );
  assert.equal(
    repairedDegenerateTranscriptSummary.events.filter(
      (event) => event.type === "response_only.transcript_quality_repaired"
    ).length,
    1
  );
  assert(
    repairedDegenerateTranscriptSummary.calls[1].messages.some(
      (message) =>
        message.role === "user" &&
        /Do not infer spoken content, visuals, or events from the title/i.test(String(message.content || "")) &&
        /"message":string, "files":array, "confirmation":string/i.test(String(message.content || ""))
    ),
    "the transcript-quality repair did not retain source boundaries and the caller's JSON contract"
  );

  const failedClosedDegenerateTranscriptSummary = await runCase({
    id: "bounded-degenerate-transcript-fail-closed",
    taskProfile: "chatops",
    goal: boundedTranscriptResponseGoal,
    responses: [
      assistant(JSON.stringify({
        message: "视频讲述一位神女从云端走来的故事。",
        files: [],
        confirmation: "",
      })),
      assistant(JSON.stringify({
        message: "画面表现古典诗词的浪漫想象。",
        files: [],
        confirmation: "",
      })),
    ],
  });
  assert.equal(failedClosedDegenerateTranscriptSummary.calls.length, 2);
  assert.equal(failedClosedDegenerateTranscriptSummary.result.stopped, true);
  assert.equal(failedClosedDegenerateTranscriptSummary.result.reason, "unreliable_bounded_transcript");
  assert.doesNotThrow(() => JSON.parse(failedClosedDegenerateTranscriptSummary.result.result));
  assert.match(
    JSON.parse(failedClosedDegenerateTranscriptSummary.result.result).message,
    /无法可靠概括实际语音/u
  );
  assert(
    !failedClosedDegenerateTranscriptSummary.events.some((event) => event.type === "session.finished"),
    "a repeated invented speech summary was recorded as a successful finish"
  );

  const inventedTranscriptAfterSourceFreeRepair = await runCase({
    id: "bounded-transcript-invention-after-source-free-repair",
    taskProfile: "chatops",
    goal: boundedTranscriptResponseGoal,
    responses: [
      assistant(JSON.stringify({
        message:
          "转写内容高度重复，无法可靠概括实际语音。Nature Biomedical Engineering 在 2025 年的研究已验证该视频所示机制。",
        files: [],
        confirmation: "",
      })),
      assistant(JSON.stringify({
        message: "视频实际讲述一位神女从云端踏光而来，并与诗人相遇的浪漫故事。",
        files: [],
        confirmation: "",
      })),
    ],
  });
  assert.equal(inventedTranscriptAfterSourceFreeRepair.calls.length, 2);
  assert.equal(
    inventedTranscriptAfterSourceFreeRepair.result.stopped,
    true,
    "a source-free repair replaced a truthful transcript limitation with invented speech and still finished"
  );
  assert.equal(
    inventedTranscriptAfterSourceFreeRepair.result.reason,
    "unreliable_bounded_transcript"
  );
  assert.match(
    JSON.parse(inventedTranscriptAfterSourceFreeRepair.result.result).message,
    /无法可靠概括实际语音/u
  );
  assert(
    inventedTranscriptAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.source_free_claim_rejected"
    ),
    "the cross-validator fixture did not exercise source-free repair"
  );
  assert(
    inventedTranscriptAfterSourceFreeRepair.events.some(
      (event) => event.type === "response_only.transcript_quality_failed_closed"
    ),
    "the final transcript invariant did not record its fail-closed decision"
  );
  assert(
    !inventedTranscriptAfterSourceFreeRepair.events.some(
      (event) => event.type === "session.finished"
    ),
    "invented speech introduced by a later validator repair was persisted as successful"
  );

  const providerSwitchSessionId = "provider-switch-resume-contract";
  const providerSwitchFirstTurn = await runCase({
    id: providerSwitchSessionId,
    goal: "Create provider-switch-proof.md with the exact text provider switch proof.",
    taskProfile: "auto",
    provider: "localllm",
    model: "localllm-fast",
    providerReadinessMode: "deterministic-test",
    allowFileTools: true,
    responses: [
      assistant("", [
        toolCall("write-provider-switch-proof", "write_file", {
          path: "provider-switch-proof.md",
          mode: "create",
          content: "provider switch proof\n",
        }),
      ]),
      assistant("", [
        toolCall("finish-provider-switch-proof", "finish", {
          result: "Created provider-switch-proof.md.",
        }),
      ]),
    ],
  });
  assert.equal(providerSwitchFirstTurn.result.stopped, undefined);
  assert.equal(providerSwitchFirstTurn.state.meta?.runtimeConfig?.provider, "localllm");
  assert.equal(providerSwitchFirstTurn.state.meta?.runtimeConfig?.model, "localllm-fast");

  const providerSwitchSecondTurn = await runCase({
    id: providerSwitchSessionId,
    goal: "Resume this exact session with the default provider and return exactly: DEEPSEEK_RESUME_OK",
    taskProfile: "auto",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    resume: true,
    runtimePatch: providerRuntimePatch("deepseek", "deepseek-v4-flash"),
    expectedRuntimeRevision: providerSwitchFirstTurn.state.meta.runtimeConfig.revision,
    responses: [
      assistant("", [
        toolCall("finish-provider-switch-deepseek", "finish", {
          result: "DEEPSEEK_RESUME_OK",
        }),
      ]),
    ],
  });
  assert.equal(providerSwitchSecondTurn.result.stopped, undefined);
  assert.equal(providerSwitchSecondTurn.result.result, "DEEPSEEK_RESUME_OK");
  assert.equal(providerSwitchSecondTurn.state.meta?.runtimeConfig?.provider, "deepseek");
  assert.equal(providerSwitchSecondTurn.state.meta?.runtimeConfig?.model, "deepseek-v4-flash");
  assert.equal(
    providerSwitchSecondTurn.events.filter(
      (event) => event.type === "session.runtime_resolved" && event.data?.provider === "deepseek"
    ).length,
    1,
    "explicit DeepSeek resume did not persist a provider switch"
  );

  const forcedLocalRequest =
    "Resume this exact session and return exactly: LOCALLLM_FORCED_RESUME_OK Do not create or modify any file.";
  const forcedLocalGoal = scopedTaskGoal(
    forcedLocalRequest,
    path.join(tempRoot, "artifacts", "provider-switch-resume-contract")
  );
  const forcedLocalContract = deriveScsTaskContract({ goal: forcedLocalGoal, taskProfile: "auto" });
  assert.equal(
    forcedLocalContract.requiresExternalEvidence,
    false,
    "a forbidden file-mutation clause made a pure response-only resume require external evidence"
  );
  assert.deepEqual(forcedLocalContract.requiredEvidence, []);
  assert.deepEqual(forcedLocalContract.exactOutputPaths, []);
  assert(
    forcedLocalContract.forbiddenActions.some((item) => /create or modify any file/i.test(item)),
    "forbidden file mutation was not retained as a guardrail"
  );

  const forcedLocalResume = await runCase({
    id: providerSwitchSessionId,
    goal: forcedLocalGoal,
    taskProfile: "auto",
    provider: "localllm",
    model: "localllm-fast",
    providerReadinessMode: "deterministic-test",
    resume: true,
    runtimePatch: providerRuntimePatch("localllm", "localllm-fast"),
    expectedRuntimeRevision: providerSwitchSecondTurn.state.meta.runtimeConfig.revision,
    responses: [
      assistant("", [
        toolCall("finish-provider-switch-localllm", "finish", {
          result: "LOCALLLM_FORCED_RESUME_OK",
        }),
      ]),
    ],
  });
  assert.equal(forcedLocalResume.result.stopped, undefined);
  assert.equal(forcedLocalResume.result.result, "LOCALLLM_FORCED_RESUME_OK");
  assert.equal(forcedLocalResume.calls.length, 1);
  assert.deepEqual(forcedLocalResume.factoryConfigs, [{ provider: "localllm", model: "localllm-fast" }]);
  assert.equal(forcedLocalResume.state.meta?.runtimeConfig?.provider, "localllm");
  assert.equal(forcedLocalResume.state.meta?.runtimeConfig?.model, "localllm-fast");
  assert.equal(
    forcedLocalResume.events.filter(
      (event) =>
        event.type === "session.runtime_resolved" &&
        event.data?.provider === "localllm" &&
        event.data?.model === "localllm-fast"
    ).length,
    1,
    "explicit LocalLLM resume did not persist the forced provider/model switch"
  );
  assert(
    !forcedLocalResume.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /ledger is empty/i.test(String(event.data?.reason || ""))
    ),
    "pure LocalLLM resume was rejected for missing external evidence"
  );

  const proseOnlyAction = await runCase({
    id: "prose-only-action",
    goal: "Run pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("The command would print the working directory."),
      assistant("Here is the command instead: pwd"),
    ],
  });
  assert.equal(proseOnlyAction.calls.length, 2);
  assert.equal(proseOnlyAction.result.stopped, true);
  assert.equal(proseOnlyAction.result.reason, "model_did_not_execute");
  assert.equal(proseOnlyAction.events.filter((event) => event.type === "completion.repair_requested").length, 1);
  assert.equal(proseOnlyAction.events.filter((event) => event.type === "completion.evidence_rejected").length, 2);
  assert(!proseOnlyAction.events.some((event) => event.type === "session.finished"));

  const resumedAfterSupersededRepair = await runCase({
    id: "prose-only-action",
    goal: "Continue the current task from saved state. Do not repeat completed work.",
    taskProfile: "shell",
    allowShellTool: true,
    resume: true,
    responses: [
      assistant("I will run the command and verify it next."),
      assistant("", [toolCall("run-pwd-after-repair", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("finish-pwd-after-repair", "finish", {
        result: "Verified the current working directory with pwd.",
      })]),
    ],
  });
  const resumedRepairPrompt = resumedAfterSupersededRepair.calls[0]?.messages || [];
  assert(
    resumedRepairPrompt.some(
      (message) =>
        message.role === "user" &&
        /Authoritative execution contract for goal revision/i.test(String(message.content || "")) &&
        /required Git actions = none/i.test(String(message.content || ""))
    ),
    "a resumed turn did not receive the authoritative replacement for its superseded repair contract"
  );
  assert(
    !resumedRepairPrompt.some(
      (message) => String(message.content || "").startsWith(staleCompletionRepair.split(" Reason:")[0])
    ),
    "the prior turn's generated completion-repair instruction leaked into the resumed model request"
  );
  assert.equal(
    resumedAfterSupersededRepair.calls.length,
    3,
    "a prose preamble incorrectly ended the resumed action before tool execution"
  );
  assert.equal(resumedAfterSupersededRepair.result.stopped, undefined);
  assert.match(resumedAfterSupersededRepair.result.result, /working directory/i);

  const permissionPause = await runCase({
    id: "permission-pause",
    goal: "Run the checked-in project test script and report its verified result.",
    taskProfile: "java",
    allowShellTool: true,
    scsActive: true,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "scripts"), { recursive: true });
      await fs.writeFile(path.join(workspace, "scripts", "test.sh"), "#!/usr/bin/env bash\necho pass\n", "utf8");
    },
    responses: [
      assistant("", [toolCall("permission-test", "run_command", { command: "bash scripts/test.sh" })]),
    ],
  });
  assert.equal(permissionPause.calls.length, 1, "permission blocker consumed another model turn");
  assert.equal(permissionPause.result.stopped, true);
  assert.equal(permissionPause.result.reason, "permission_required");
  assert(permissionPause.result.permissionAdvice?.suggestedCommand, "permission pause lost its exact resume command");
  assert.equal(
    permissionPause.events.filter((event) => event.type === "session.stopped" && event.data?.reason === "permission_required").length,
    1,
    "permission blocker did not persist exactly one paused state"
  );
  assert(
    !permissionPause.events.some((event) =>
      ["scs.student.rethink_plan", "scs.student.reject_phase", "scs.committee.replan_drafted"].includes(event.type)
    ),
    "permission blocker triggered an SCS replan instead of waiting for approval"
  );

  const secretWriteRedactionRecovery = await runCase({
    id: "secret-write-redaction-recovery",
    goal: [
      "Create notes/shipinhao-source-summary.md as a safe reader-facing summary.",
      "Do not copy private signed media URLs or credentials into the derived note.",
      "Verify the created file before finishing.",
    ].join(" "),
    allowFileTools: true,
    responses: [
      assistant("", [toolCall("unsafe-derived-note", "write_file", {
        path: "notes/shipinhao-source-summary.md",
        content: [
          "# Shipinhao source summary",
          "",
          "Private source credential: DEMO_SECRET_TOKEN=aginti_fake_do_not_use",
          "",
        ].join("\n"),
        mode: "create",
      })]),
      assistant("", [toolCall("redacted-derived-note", "write_file", {
        path: "notes/shipinhao-source-summary.md",
        content: [
          "# Shipinhao source summary",
          "",
          "The source card identifies a short music video. Private source URL: [REDACTED]",
          "",
        ].join("\n"),
        mode: "create",
      })]),
      assistant("", [toolCall("finish-redacted-note", "finish", {
        result: "Created and verified the safe Shipinhao source summary with its private URL redacted.",
      })]),
    ],
  });
  assert.equal(
    secretWriteRedactionRecovery.calls.length,
    3,
    "a recoverable secret-write mistake paused instead of requesting one redacted retry"
  );
  assert.equal(secretWriteRedactionRecovery.result.stopped, undefined);
  const secretWriteBlock = secretWriteRedactionRecovery.events.find(
    (event) => event.type === "tool.blocked" && event.data?.category === "workspace-content"
  );
  assert(secretWriteBlock, "the unsafe derived note was not blocked");
  assert.equal(
    secretWriteBlock.data?.permissionAdvice?.autoRecover,
    true,
    "secret-write guidance still asks for ineffective stronger permission"
  );
  assert(
    !secretWriteRedactionRecovery.events.some(
      (event) => event.type === "session.stopped" && event.data?.reason === "permission_required"
    ),
    "secret-write redaction recovery still persisted a permission pause"
  );
  assert(
    secretWriteRedactionRecovery.calls[1]?.messages.some(
      (message) =>
        message.role === "tool" &&
        /redact the sensitive value/i.test(String(message.content || ""))
    ),
    "the retry turn did not receive an explicit bounded redaction instruction"
  );
  const safeDerivedNote = await fs.readFile(
    path.join(
      tempRoot,
      "workspaces",
      "secret-write-redaction-recovery",
      "notes",
      "shipinhao-source-summary.md"
    ),
    "utf8"
  );
  assert.match(safeDerivedNote, /\[REDACTED\]/);
  assert(!safeDerivedNote.includes("aginti_fake_do_not_use"));

  const localPreviewWorkspace = path.join(
    tempRoot,
    "workspaces",
    "local-file-url-preview-recovery"
  );
  const localFileUrlPreviewRecovery = await runCase({
    id: "local-file-url-preview-recovery",
    goal: "Read notes/local-preview.txt and report its exact local preview status.",
    allowFileTools: true,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "notes"), { recursive: true });
      await fs.writeFile(
        path.join(workspace, "notes", "local-preview.txt"),
        "LOCAL_PREVIEW_READY\n",
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("file-url-as-remote-url", "open_url", {
        url: pathToFileURL(path.join(localPreviewWorkspace, "notes", "local-preview.txt")).href,
      })]),
      assistant("", [toolCall("read-local-preview", "read_file", {
        path: "notes/local-preview.txt",
      })]),
      assistant("", [toolCall("finish-local-preview", "finish", {
        result: "The local preview status is LOCAL_PREVIEW_READY.",
      })]),
    ],
  });
  assert.equal(
    localFileUrlPreviewRecovery.calls.length,
    3,
    "a recoverable file URL mistake paused instead of switching to a workspace-native tool"
  );
  assert.equal(localFileUrlPreviewRecovery.result.stopped, undefined);
  const localFileUrlBlock = localFileUrlPreviewRecovery.events.find(
    (event) => event.type === "tool.blocked" && event.data?.toolName === "open_url"
  );
  assert(localFileUrlBlock, "the unsupported local file URL was not blocked");
  assert.equal(
    localFileUrlBlock.data?.permissionAdvice?.autoRecover,
    true,
    "the local file URL mistake still requests stronger permission"
  );
  assert(
    localFileUrlPreviewRecovery.calls[1]?.messages.some(
      (message) =>
        message.role === "tool" &&
        /open_workspace_file, preview_workspace, or read_file/i.test(String(message.content || ""))
    ),
    "the retry turn did not receive workspace-native local artifact guidance"
  );
  assert(
    !localFileUrlPreviewRecovery.events.some(
      (event) => event.type === "session.stopped" && event.data?.reason === "permission_required"
    ),
    "the local file URL recovery still persisted a permission pause"
  );

  if (await tmuxAvailable()) {
    const tmuxAliasRecovery = await runCase({
      id: "tmux-shell-alias-recovery",
      goal: "Check durable host tmux sessions and report whether any sessions exist.",
      taskProfile: "auto",
      executionTier: "focused",
      allowShellTool: true,
      responses: [
        assistant("", [toolCall("tmux-as-shell", "run_command", { command: "tmux_list_sessions" })]),
        assistant("", [
          toolCall("finish-tmux-alias", "finish", {
            result: "Checked durable host tmux sessions through the native tmux listing tool.",
          }),
        ]),
      ],
    });
    assert.equal(tmuxAliasRecovery.calls.length, 2);
    assert.equal(tmuxAliasRecovery.result.stopped, undefined);
    assert(
      tmuxAliasRecovery.events.some(
        (event) =>
          event.type === "tool.auto_corrected" &&
          event.data?.requestedToolName === "run_command" &&
          event.data?.toolName === "tmux_list_sessions" &&
          event.data?.originalCommand === "tmux_list_sessions"
      ),
      "run_command tmux_list_sessions alias was not recovered to the native tmux tool"
    );
    assert(
      tmuxAliasRecovery.events.some(
        (event) =>
          event.type === "tool.started" &&
          event.data?.toolName === "tmux_list_sessions" &&
          event.data?.requestedToolName === "run_command"
      ),
      "native tmux listing was not started with original requested tool evidence"
    );
    assert(
      tmuxAliasRecovery.events.some(
        (event) =>
          event.type === "tool.completed" &&
          event.data?.toolName === "tmux_list_sessions"
      ),
      "native tmux listing did not complete after alias recovery"
    );
    assert(
      !tmuxAliasRecovery.events.some(
        (event) => event.type === "tool.started" && event.data?.toolName === "run_command"
      ),
      "tmux alias recovery still dispatched the generic shell command"
    );
    assert(
      !tmuxAliasRecovery.events.some(
        (event) => event.type === "session.stopped" && event.data?.reason === "permission_required"
      ),
      "tmux alias recovery still paused on shell permission"
    );

    const tmuxReadonlyCommandRecovery = await runCase({
      id: "tmux-readonly-command-recovery",
      goal: "List durable host tmux sessions using the available coordination tool.",
      taskProfile: "auto",
      executionTier: "focused",
      allowShellTool: true,
      responses: [
        assistant("", [toolCall("tmux-command-as-shell", "run_command", { command: "tmux list-sessions" })]),
        assistant("", [
          toolCall("finish-tmux-command", "finish", {
            result: "Checked durable host tmux sessions through the native tmux listing tool.",
          }),
        ]),
      ],
    });
    assert.equal(tmuxReadonlyCommandRecovery.result.stopped, undefined);
    assert(
      tmuxReadonlyCommandRecovery.events.some(
        (event) =>
          event.type === "tool.auto_corrected" &&
          event.data?.toolName === "tmux_list_sessions" &&
          event.data?.originalCommand === "tmux list-sessions"
      ),
      "exact tmux list-sessions shell command was not recovered"
    );
    assert(
      !tmuxReadonlyCommandRecovery.events.some(
        (event) => event.type === "tool.started" && event.data?.toolName === "run_command"
      ),
      "exact tmux list-sessions recovery still dispatched run_command"
    );

    const tmuxMutationStillBlocked = await runCase({
      id: "tmux-mutating-command-still-blocked",
      goal: "Try to create a tmux session through the generic shell.",
      taskProfile: "auto",
      executionTier: "focused",
      allowShellTool: true,
      responses: [
        assistant("", [
          toolCall("tmux-mutating-shell", "run_command", {
            command: "tmux new-session -d -s should-not-autocorrect",
          }),
        ]),
      ],
    });
    assert.equal(tmuxMutationStillBlocked.result.stopped, true);
    assert.equal(tmuxMutationStillBlocked.result.reason, "permission_required");
    assert(
      !tmuxMutationStillBlocked.events.some((event) => event.type === "tool.auto_corrected"),
      "mutating tmux shell command was incorrectly auto-corrected"
    );
  }

  const reasoningTruncation = await runCase({
    id: "reasoning-only-tool-continuation",
    goal: "Run pwd and report the verified working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      reasoningOnly("The next concrete action is to run pwd with the shell tool."),
      assistant("", [toolCall("reasoning-run", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("reasoning-finish", "finish", { result: "Ran pwd and verified the working directory." })]),
    ],
  });
  assert.equal(reasoningTruncation.calls.length, 3);
  assert.equal(reasoningTruncation.result.stopped, undefined);
  assert.equal(
    reasoningTruncation.events.filter((event) => event.type === "model.reasoning_continuation_requested").length,
    1
  );
  assert.equal(
    reasoningTruncation.events.filter((event) => event.type === "completion.evidence_rejected").length,
    0,
    "reasoning-only truncation was treated as a completion claim"
  );
  assert.equal(
    reasoningTruncation.calls[1].tool_choice,
    "required",
    "reasoning-only continuation did not require one native tool call"
  );
  assert(
    reasoningTruncation.calls[1].messages.some(
      (message) => /exactly one enabled tool call/i.test(String(message.content || ""))
    ),
    "reasoning-only continuation instruction was not retained in the next request"
  );

  const falseFinish = await runCase({
    id: "false-finish-tool",
    goal: "Run printf 4 and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("finish-1", "finish", { result: "The output was 4." })]),
      assistant("", [toolCall("finish-2", "finish", { result: "Done." })]),
    ],
  });
  assert.equal(falseFinish.calls.length, 2);
  assert.equal(falseFinish.result.reason, "model_did_not_execute");
  assert(!falseFinish.events.some((event) => event.type === "session.finished"));

  const scsApprovalNarrative = await runCase({
    id: "scs-approval-narrative",
    goal: "Repair analysis.py in place and run the documented verification command.",
    taskProfile: "shell",
    allowShellTool: true,
    scsActive: true,
    responses: [
      assistant("I must ask for approval before replacing the file. Do you approve? Reply yes to proceed."),
      assistant("After approval, I will rewrite the file and run the verification command."),
    ],
  });
  assert.equal(scsApprovalNarrative.calls.length, 2);
  assert.equal(scsApprovalNarrative.result.stopped, true);
  assert.equal(scsApprovalNarrative.result.reason, "model_did_not_execute");
  assert.equal(
    scsApprovalNarrative.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert(!scsApprovalNarrative.events.some((event) => event.type === "session.finished"));

  const scsUnsupportedNarrative = await runCase({
    id: "scs-unsupported-success-narrative",
    goal: "Run pwd and report the verified working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    scsActive: true,
    responses: [
      assistant("The task is complete and the working directory is correct."),
      assistant("Completed successfully with all requested checks."),
    ],
  });
  assert.equal(scsUnsupportedNarrative.result.stopped, true);
  assert.equal(scsUnsupportedNarrative.result.reason, "model_did_not_execute");
  assert.equal(
    scsUnsupportedNarrative.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert(!scsUnsupportedNarrative.events.some((event) => event.type === "session.finished"));

  const inventedBlockerAfterVerifiedExecution = await runCase({
    id: "invented-blocker-after-verified-execution",
    goal: "Run pwd and report the verified working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [
        toolCall("pwd-before-invented-blocker", "run_command", { command: "pwd" }),
      ]),
      assistant(
        "I cannot proceed because no target file was named. Please specify a source file."
      ),
      assistant("Ran pwd and verified the working directory."),
    ],
  });
  assert.equal(inventedBlockerAfterVerifiedExecution.calls.length, 3);
  assert.equal(inventedBlockerAfterVerifiedExecution.result.stopped, undefined);
  assert.match(inventedBlockerAfterVerifiedExecution.result.result, /verified the working directory/i);
  assert(
    inventedBlockerAfterVerifiedExecution.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /claims the task is blocked, but no matching runtime blocker evidence exists/i.test(
          String(event.data?.reason || "")
        )
    ),
    "an invented blocker was accepted after unrelated execution evidence satisfied the task contract"
  );
  assert.equal(
    inventedBlockerAfterVerifiedExecution.events.filter(
      (event) => event.type === "session.finished"
    ).length,
    1,
    "the repaired completion did not finish exactly once"
  );

  const approvalNarrativeWithBlockerEvidence = await runCase({
    id: "approval-narrative-with-blocker-evidence",
    goal: "Run which definitely_missing_aginti_command and report the result.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [
        toolCall("missing-command", "run_command", { command: "which definitely_missing_aginti_command" }),
      ]),
      assistant("The command is unavailable. Approve installing it and I will continue after approval."),
      assistant("Unable to execute the requested command because it is not installed in this environment."),
    ],
  });
  assert.equal(approvalNarrativeWithBlockerEvidence.calls.length, 3);
  assert.match(approvalNarrativeWithBlockerEvidence.result.result, /not installed/i);
  assert(
    approvalNarrativeWithBlockerEvidence.events.some(
      (event) => event.type === "completion.evidence_rejected"
    ),
    "an approval narrative overrode existing blocker evidence"
  );

  const futureWorkFinish = await runCase({
    id: "future-work-finish",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [
        toolCall("finish-future", "finish", {
          result: "The task is paused. The command will be run and verified next.",
        }),
      ]),
      assistant("", [toolCall("run-after-reject", "run_command", { command: "pwd" })]),
      assistant("", [
        toolCall("finish-after-proof", "finish", { result: "Ran pwd and verified the working directory." }),
      ]),
    ],
  });
  assert.equal(futureWorkFinish.calls.length, 3);
  assert.equal(futureWorkFinish.result.stopped, undefined);
  assert.match(futureWorkFinish.result.result, /verified the working directory/i);
  assert(futureWorkFinish.events.some((event) => event.type === "completion.evidence_rejected"));

  const readOnlyExternalRetryStatus = await runCase({
    id: "read-only-external-retry-status",
    goal: "Execute the shell command pwd and report the status without changing anything.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("external-status-proof", "run_command", { command: "pwd" })]),
      assistant("", [
        toolCall("finish-external-status", "finish", {
          result:
            "Read-only check done; nothing was sent or changed. Still retrying: nightly_pdf (quality_retry_pending; next attempt at 10:14). The requested command evidence is present.",
        }),
      ]),
    ],
  });
  assert.equal(readOnlyExternalRetryStatus.calls.length, 2);
  assert.equal(readOnlyExternalRetryStatus.result.stopped, undefined);
  assert.match(readOnlyExternalRetryStatus.result.result, /Still retrying: nightly_pdf/);
  assert(
    readOnlyExternalRetryStatus.events.some(
      (event) =>
        event.type === "completion.candidate_assessed" &&
        event.data?.claimsIncompleteWork === false
    ),
    "read-only external retry status was still marked claimsIncompleteWork=true"
  );
  assert(
    !readOnlyExternalRetryStatus.events.some(
      (event) => event.type === "completion.evidence_rejected"
    ),
    "read-only external retry status still triggered a completion repair"
  );

  const compactHealthCommand = "PYTHONPATH=src python -m agenticapp wechat health --compact --json";
  const compactHealthGoal = [
    "User request:",
    "i was checking phone and schedulr tell me which daily things actually got delivered today and which still retrying, also can msg from me and msg from other people both reach agent. dont send chat or change anything, just inspect and answer short with evidence",
    "",
    "Matched established routines",
    `- \`wechat-chatops\` ready=true; commands=[${JSON.stringify(compactHealthCommand)}, "python agentic_tools/wechat_gui_agent/scripts/wechat_android_ingress.py --status"]; outputs=["messages", "files", "task records"]; guidance=For a read-only phone, message-intake, queue, or schedule question, run the canonical compact health command first; it already includes both Android lanes. Use the raw Android status commands only when compact health marks a lane unknown or stale. Treat that current snapshot as authoritative and stop once it answers the request. Do not inspect raw chat text or private message ledgers or artifact directories, and do not send or mutate anything, unless the current request explicitly needs it.`,
  ].join("\n");
  const compactHealthFallback = await runCase({
    id: "read-only-compact-health-empty-finish-fallback",
    goal: compactHealthGoal,
    taskProfile: "chatops",
    allowShellTool: true,
    allowDestructive: true,
    maxOutputTokens: 768,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "src", "agenticapp"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "agenticapp", "__init__.py"), "", "utf8");
      await fs.writeFile(
        path.join(workspace, "src", "agenticapp", "__main__.py"),
        [
          "import json",
          "payload = {",
          "  'ok': True,",
          "  'operational': True,",
          "  'degraded': True,",
          "  'issues': ['wechat_login_required'],",
          "  'phone_ingress': {",
          "    'other_people': {'ok': True, 'fresh': True, 'reaches_agent': True, 'routes': 6},",
          "    'self_authored': {'ok': True, 'fresh': True, 'reaches_agent': True, 'routes': 6, 'seeded_routes': 6},",
          "  },",
          "  'queues': {",
          "    'wechat': {'ok': True, 'pending': 0, 'active': 0, 'recent_failure_count': 0, 'stale_count': 0},",
          "    'wecom': {'ok': True, 'pending': 0, 'active': 0, 'recent_failure_count': 0, 'stale_count': 0},",
          "  },",
          "  'schedules': {",
          "    'career_daily': {'delivered': True, 'retry_pending': False, 'running': True, 'status': 'delivered'},",
          "    'echomind_daily_pdf': {'retry_pending': True, 'status': 'quality_retry_pending', 'next_attempt_at': '2026-08-31T02:47:35+00:00'},",
          "    'memo_daily': {'delivered': True, 'required': True, 'retry_pending': False, 'status': 'delivered'},",
          "  }",
          "}",
          "print(json.dumps(payload, indent=2, sort_keys=True))",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("run-compact-health", "run_command", { command: compactHealthCommand })]),
      reasoningOnly("The compact health JSON already answers the read-only status question, so I should produce a short final answer.", "length"),
      reasoningOnly("I need to summarize delivered schedules, retrying schedules, phone ingress, and queues from the retained JSON.", "length"),
    ],
  });
  assert.equal(
    compactHealthFallback.calls.length,
    3,
    "empty finish-only verified completion burned extra model turns before fallback"
  );
  assert.equal(
    compactHealthFallback.calls[1]?.max_tokens,
    2048,
    "verified-completion turn did not raise the installed 768-token cap"
  );
  assert.equal(
    compactHealthFallback.calls[2]?.max_tokens,
    2048,
    "verified-completion retry did not retain the raised output cap"
  );
  assert.match(compactHealthFallback.result.result, /Delivered: .*career_daily.*memo_daily/i);
  assert.match(compactHealthFallback.result.result, /Still retrying: .*echomind_daily_pdf.*next attempt 2026-08-31T02:47:35\+00:00/i);
  assert.match(compactHealthFallback.result.result, /phone_ingress reaches the agent for: .*other_people.*self_authored/i);
  assert.match(compactHealthFallback.result.result, /Queues: .*wechat pending 0 active 0.*wecom pending 0 active 0/i);
  assert.match(compactHealthFallback.result.result, /Verified from runtime evidence/i);
  assert.doesNotMatch(compactHealthFallback.result.result, /^Completed the requested work and verified it from runtime evidence\. Evidence: command/i);
  assert.equal(
    compactHealthFallback.events.filter(
      (event) => event.type === "tool.started" && event.data?.toolName !== "finish"
    ).length,
    1,
    "compact health fallback dispatched more than the authoritative command"
  );
  assert(
    !compactHealthFallback.events.some(
      (event) =>
        event.type === "tool.started" &&
        /(?:^|[ /])(?:\\.private|private|raw|sqlite|jsonl|artifact)(?:$|[ /.-])/i.test(
          String(event.data?.args?.command || "")
        )
    ),
    "compact health fallback explored forbidden private/raw evidence"
  );
  assert.equal(
    compactHealthFallback.events.filter((event) => event.type === "completion.verified_fallback").length,
    1,
    "compact health empty response did not persist exactly one verified fallback"
  );
  assert.equal(
    compactHealthFallback.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    0,
    "finish-only reasoning repair still spent a separate empty-response repair turn"
  );

  const structuredCoverageFallback = await runCase({
    id: "authoritative-structured-completion-coverage",
    goal: [
      "User request:",
      "Report queue health, schedule state, and authentication blockers concisely. Read-only inspection; send nothing.",
      "",
      "Matched established routines",
      `- \`wechat-chatops\` ready=true; commands=[${JSON.stringify(compactHealthCommand)}, "python agentic_tools/wechat_gui_agent/scripts/wechat_android_ingress.py --status"]; outputs=["messages", "files", "task records"]; guidance=For a read-only phone, message-intake, queue, or schedule question, run the canonical compact health command first; it already includes both Android lanes. Treat that current snapshot as authoritative and stop once it answers the request. Do not inspect raw chat text or private message ledgers or artifact directories, and do not send or mutate anything, unless the current request explicitly needs it.`,
    ].join("\n"),
    taskProfile: "chatops",
    allowShellTool: true,
    allowDestructive: true,
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "src", "agenticapp"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "agenticapp", "__init__.py"), "", "utf8");
      await fs.writeFile(
        path.join(workspace, "src", "agenticapp", "__main__.py"),
        `print(${JSON.stringify(structuredHealthOutput)})\n`,
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("structured-health-command", "run_command", { command: compactHealthCommand })]),
      assistant("", [toolCall("structured-health-bad-finish-1", "finish", {
        result: "The system is degraded because WeChat login is required. Schedule state is not visible in the retained output.",
      })]),
      assistant("", [toolCall("structured-health-bad-finish-2", "finish", {
        result: "WeChat authentication remains blocked. The schedule section was not returned.",
      })]),
    ],
  });
  assert.equal(structuredCoverageFallback.calls.length, 3);
  assert.match(structuredCoverageFallback.result.result, /Queues: .*wechat pending 0 active 0.*wecom pending 0 active 0/i);
  assert.match(structuredCoverageFallback.result.result, /Other schedules: .*career_daily.*memo_daily.*echomind_daily_pdf/i);
  assert.match(structuredCoverageFallback.result.result, /issues=wechat_login_required,android_poll_stalled/i);
  assert.equal(
    structuredCoverageFallback.events.filter(
      (event) => event.type === "tool.started" && event.data?.toolName === "run_command"
    ).length,
    1,
    "structured summary repair reran the authoritative command"
  );
  assert.equal(
    structuredCoverageFallback.events.filter(
      (event) => event.type === "completion.structured_output_repair_requested"
    ).length,
    1,
    "structured summary defect did not request exactly one finish-only repair"
  );
  assert.equal(
    structuredCoverageFallback.events.filter(
      (event) => event.type === "completion.structured_output_fallback"
    ).length,
    1,
    "repeated bad structured summary did not use the deterministic verified fallback"
  );

  const wordCompletionWithoutArtifact = await runCase({
    id: "word-completion-without-artifact",
    goal: "Create an editable, phone-friendly project handoff from this folder.",
    taskProfile: "word",
    allowFileTools: true,
    responses: [
      assistant("", [toolCall("word-finish-without-file-1", "finish", { result: "The handoff is complete." })]),
      assistant("", [toolCall("word-finish-without-file-2", "finish", { result: "The handoff is complete." })]),
    ],
  });
  assert.equal(wordCompletionWithoutArtifact.result.stopped, true);
  assert.equal(wordCompletionWithoutArtifact.result.reason, "model_did_not_execute");
  assert(
    wordCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "document.quality_assessed" &&
        event.data?.ok === false &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "Word completion without a document artifact bypassed the independent quality gate"
  );
  assert(
    wordCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "missing Word artifacts did not produce an actionable completion repair"
  );

  const writingPdfCompletionWithoutArtifact = await runCase({
    id: "writing-pdf-completion-without-artifact",
    goal: "Read chat_history.md and produce an editable source plus a mobile-readable PDF.",
    taskProfile: "writing",
    allowFileTools: true,
    executionTier: "focused",
    responses: [
      assistant("", [toolCall("writing-pdf-finish-without-file-1", "finish", { result: "The PDF report is complete." })]),
      assistant("", [toolCall("writing-pdf-finish-without-file-2", "finish", { result: "The PDF report is complete." })]),
    ],
  });
  assert.equal(writingPdfCompletionWithoutArtifact.result.stopped, true);
  assert(
    writingPdfCompletionWithoutArtifact.events.some(
      (event) =>
        event.type === "document.quality_assessed" &&
        event.data?.ok === false &&
        /no readable DOCX or PDF/i.test(String(event.data?.reason || ""))
    ),
    "a writing-profile PDF task bypassed the independent document quality gate"
  );

  const verifiedAction = await runCase({
    id: "verified-action",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-1", "run_command", { command: "pwd" })]),
      assistant("", [toolCall("finish-verified", "finish", { result: "Verified the current working directory with pwd." })]),
    ],
  });
  assert.equal(verifiedAction.calls.length, 2);
  assert.equal(verifiedAction.result.stopped, undefined);
  assert.match(verifiedAction.result.result, /working directory/i);
  assert(verifiedAction.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "run_command"));
  assert(verifiedAction.events.some((event) => event.type === "session.finished"));
  assert(!verifiedAction.events.some((event) => event.type === "completion.repair_requested"));

  const sourceChangeRequiresFreshTests = await runCase({
    id: "source-change-requires-fresh-tests",
    goal: "Repair this Python project and verify the result.",
    taskProfile: "python",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
      await fs.writeFile(path.join(workspace, "analysis.py"), "VALUE = 1\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "tests", "test_analysis.py"),
        [
          "import unittest",
          "import analysis",
          "",
          "class AnalysisTests(unittest.TestCase):",
          "    def test_value(self):",
          "        self.assertEqual(analysis.VALUE, 2)",
          "",
          "if __name__ == '__main__':",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("inspect-source-tests", "inspect_project", { path: "." })]),
      assistant("", [
        toolCall("patch-source", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 1",
          replace: "VALUE = 2",
        }),
      ]),
      assistant("", [toolCall("run-not-test", "run_command", { command: "python analysis.py" })]),
      assistant("", [toolCall("finish-before-test", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("run-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-test", "finish", { result: "The repair and focused tests passed." })]),
    ],
  });
  assert.equal(
    sourceChangeRequiresFreshTests.calls.length,
    6,
    JSON.stringify(
      sourceChangeRequiresFreshTests.events.map((event) => ({
        type: event.type,
        toolName: event.data?.toolName || "",
        path: event.data?.path || "",
        testFiles: event.data?.testFiles || [],
        command: event.data?.args?.command || "",
      }))
    )
  );
  assert.equal(
    sourceChangeRequiresFreshTests.result.stopped,
    undefined,
    JSON.stringify({
      result: sourceChangeRequiresFreshTests.result,
      events: sourceChangeRequiresFreshTests.events
        .filter((event) => ["tool.completed", "tool.failed", "tool.blocked", "completion.evidence_rejected"].includes(event.type))
        .map((event) => ({
          type: event.type,
          toolName: event.data?.toolName || "",
          command: event.data?.args?.command || "",
          exitCode: event.data?.exitCode,
          reason: event.data?.reason || "",
          error: event.data?.error || "",
        })),
    })
  );
  assert.match(sourceChangeRequiresFreshTests.result.result, /focused tests passed/i);
  assert.equal(
    sourceChangeRequiresFreshTests.events.filter((event) => event.type === "completion.evidence_rejected").length,
    1
  );
  assert(
    sourceChangeRequiresFreshTests.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        /no relevant test command succeeded/i.test(String(event.data?.reason || ""))
    ),
    "source-changing completion was not rejected before a fresh test run"
  );
  assert(
    sourceChangeRequiresFreshTests.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.toolName === "run_command" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 0
    ),
    "fresh project test command did not pass"
  );
  assert(sourceChangeRequiresFreshTests.events.some((event) => event.type === "session.finished"));

  const failedValidationCanBeRepaired = await runCase({
    id: "failed-validation-can-be-repaired",
    goal: "Repair this Python project and verify the result.",
    taskProfile: "python",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
      await fs.writeFile(path.join(workspace, "analysis.py"), "VALUE = 1\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "tests", "test_analysis.py"),
        [
          "import unittest",
          "import analysis",
          "",
          "class AnalysisTests(unittest.TestCase):",
          "    def test_value(self):",
          "        self.assertEqual(analysis.VALUE, 3)",
          "",
          "if __name__ == '__main__':",
          "    unittest.main()",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [toolCall("inspect-repair-tests", "inspect_project", { path: "." })]),
      assistant("", [
        toolCall("patch-wrong-value", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 1",
          replace: "VALUE = 20",
        }),
      ]),
      assistant("", [toolCall("finish-without-tests", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("run-failing-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-failed-tests", "finish", { result: "The repair is verified." })]),
      assistant("", [
        toolCall("patch-correct-value", "apply_patch", {
          path: "analysis.py",
          search: "VALUE = 20",
          replace: "VALUE = 3",
        }),
      ]),
      assistant("", [
        toolCall("run-passing-tests", "run_command", { command: "python -m unittest discover -s tests" }),
      ]),
      assistant("", [toolCall("finish-after-repair", "finish", { result: "The repair and focused tests passed." })]),
    ],
  });
  assert.equal(
    failedValidationCanBeRepaired.calls.length,
    8,
    JSON.stringify(
      failedValidationCanBeRepaired.events
        .filter((event) =>
          ["tool.completed", "tool.failed", "tool.blocked", "completion.evidence_rejected", "completion.repair_requested"].includes(
            event.type
          )
        )
        .map((event) => ({
          type: event.type,
          toolName: event.data?.toolName || "",
          command: event.data?.args?.command || "",
          exitCode: event.data?.exitCode,
          reason: event.data?.reason || "",
          repairAttempt: event.data?.repairAttempt,
          progressCount: event.data?.progressCount,
        }))
    )
  );
  assert.equal(failedValidationCanBeRepaired.result.stopped, undefined);
  assert.match(failedValidationCanBeRepaired.result.result, /focused tests passed/i);
  assert.equal(
    failedValidationCanBeRepaired.events.filter((event) => event.type === "completion.evidence_rejected").length,
    2
  );
  assert.equal(
    failedValidationCanBeRepaired.events.filter((event) => event.type === "completion.repair_requested").length,
    2
  );
  assert(
    failedValidationCanBeRepaired.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 1
    ),
    "failing validation evidence was not preserved for another repair turn"
  );
  assert(
    failedValidationCanBeRepaired.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python -m unittest discover -s tests" &&
        event.data?.exitCode === 0
    ),
    "repaired project tests did not pass"
  );
  assert(failedValidationCanBeRepaired.events.some((event) => event.type === "session.finished"));

  const retainedValidatorRequiresFreshPass = await runCase({
    id: "retained-validator-requires-fresh-pass",
    goal: "Repair the current project and verify the result.",
    taskProfile: "writing",
    allowShellTool: true,
    allowFileTools: true,
    executionTier: "focused",
    setup: async (workspace) => {
      await fs.writeFile(path.join(workspace, "report.md"), "status: wrong\n", "utf8");
      await fs.writeFile(
        path.join(workspace, "acceptance_check.py"),
        [
          "from pathlib import Path",
          "",
          "content = Path('report.md').read_text(encoding='utf-8')",
          "raise SystemExit(0 if content == 'status: correct\\n' else 1)",
          "",
        ].join("\n"),
        "utf8"
      );
    },
    responses: [
      assistant("", [
        toolCall("run-retained-validator-failing", "run_command", {
          command: "python3 acceptance_check.py",
        }),
      ]),
      assistant("", [
        toolCall("repair-retained-validator-output", "apply_patch", {
          path: "report.md",
          search: "status: wrong",
          replace: "status: correct",
          expectedReplacements: 1,
        }),
      ]),
      assistant("", [
        toolCall("finish-before-retained-validator-rerun", "finish", {
          result: "The project repair is complete and verified.",
        }),
      ]),
      assistant("", [
        toolCall("run-retained-validator-passing", "run_command", {
          command: "python3 acceptance_check.py",
        }),
      ]),
      assistant("", [
        toolCall("finish-after-retained-validator-rerun", "finish", {
          result: "The project repair and retained validator both passed.",
        }),
      ]),
    ],
  });
  assert.equal(
    retainedValidatorRequiresFreshPass.calls.length,
    5,
    "completion accepted stale substantive validation after a real mutation"
  );
  assert(
    retainedValidatorRequiresFreshPass.events.some(
      (event) =>
        event.type === "completion.evidence_rejected" &&
        event.data?.suggestedTestCommands?.includes("python3 acceptance_check.py")
    ),
    "completion repair did not retain the exact substantive validator command"
  );
  assert(
    retainedValidatorRequiresFreshPass.events.some(
      (event) =>
        event.type === "tool.completed" &&
        event.data?.args?.command === "python3 acceptance_check.py" &&
        event.data?.exitCode === 0
    ),
    "the retained validator did not pass at the latest mutation revision"
  );
  assert(retainedValidatorRequiresFreshPass.events.some((event) => event.type === "session.finished"));

  const verifiedEmptyCompletion = await runCase({
    id: "verified-empty-completion",
    goal: "Execute the shell command pwd and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-empty", "run_command", { command: "pwd" })]),
      assistant(""),
      assistant(""),
    ],
  });
  assert.equal(verifiedEmptyCompletion.calls.length, 3);
  assert.equal(verifiedEmptyCompletion.result.stopped, undefined);
  assert.match(verifiedEmptyCompletion.result.result, /verified.*runtime evidence/i);
  assert.equal(
    verifiedEmptyCompletion.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    1
  );
  assert.equal(
    verifiedEmptyCompletion.events.filter((event) => event.type === "completion.verified_fallback").length,
    1
  );
  assert(!verifiedEmptyCompletion.result.result.includes("No tool call returned"));

  const unusableEmptyChat = await runCase({
    id: "unusable-empty-chat",
    goal: "Explain why recursion needs a base case.",
    responses: [assistant(""), assistant("")],
  });
  assert.equal(unusableEmptyChat.calls.length, 2);
  assert.equal(unusableEmptyChat.result.stopped, true);
  assert.equal(unusableEmptyChat.result.reason, "empty_model_response");
  assert.equal(
    unusableEmptyChat.result.result,
    "I could not produce a reliable response for this message."
  );
  assert.doesNotMatch(
    unusableEmptyChat.result.result,
    /model|session|provider|runtime|resume|repair attempt/iu,
    "empty chat stop exposed private runtime diagnostics"
  );
  assert.equal(
    unusableEmptyChat.events.filter((event) => event.type === "completion.empty_response_repair_requested").length,
    1
  );
  assert(!unusableEmptyChat.events.some((event) => event.type === "session.finished"));
  assert(!unusableEmptyChat.result.result.includes("No tool call returned"));

  const chineseUnusableEmptyChat = await runCase({
    id: "unusable-empty-chat-chinese",
    goal: "请解释递归为什么需要终止条件。",
    responses: [assistant(""), assistant("")],
  });
  assert.equal(chineseUnusableEmptyChat.result.stopped, true);
  assert.equal(chineseUnusableEmptyChat.result.result, "这条消息暂时没有生成可靠的答复。");
  assert(!chineseUnusableEmptyChat.events.some((event) => event.type === "session.finished"));

  const japaneseUnusableEmptyChat = await runCase({
    id: "unusable-empty-chat-japanese",
    goal: "再帰に終了条件が必要な理由を説明してください。",
    responses: [assistant(""), assistant("")],
  });
  assert.equal(japaneseUnusableEmptyChat.result.stopped, true);
  assert.equal(
    japaneseUnusableEmptyChat.result.result,
    "このメッセージには、信頼できる回答を作成できませんでした。"
  );
  assert(!japaneseUnusableEmptyChat.events.some((event) => event.type === "session.finished"));

  const resumedAction = await runCase({
    id: "verified-action",
    goal: "Run printf 4 and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    resume: true,
    responses: [
      assistant("The command would print 4."),
      assistant("Here is the command instead: printf 4"),
    ],
  });
  assert.equal(resumedAction.calls.length, 2, "stale command evidence prevented the continuation repair request");
  assert.equal(resumedAction.result.stopped, true, "stale command evidence satisfied a different continuation goal");
  assert.equal(resumedAction.result.reason, "model_did_not_execute");
  assert.equal(
    resumedAction.events.filter((event) => event.type === "completion.repair_requested").length,
    1,
    "the new continuation did not get its own bounded evidence repair"
  );

  const verifiedBlocker = await runCase({
    id: "verified-blocker",
    goal: "Run which definitely_not_an_aginti_command and report the result.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistant("", [toolCall("run-blocked", "run_command", { command: "which definitely_not_an_aginti_command" })]),
      assistant("", [
        toolCall("finish-blocked", "finish", {
          result: "Unable to execute the requested command because it is not installed in this environment.",
        }),
      ]),
    ],
  });
  assert.equal(verifiedBlocker.calls.length, 2);
  assert.equal(verifiedBlocker.result.stopped, undefined);
  assert.match(verifiedBlocker.result.result, /not installed/i);
  assert(verifiedBlocker.events.some((event) => event.type === "session.finished"));
  assert(!verifiedBlocker.events.some((event) => event.type === "completion.repair_requested"));

  console.log("smoke-truthful-completion ok");
} finally {
  if (process.env.AGINTI_KEEP_SMOKE_TEMP === "1") {
    console.error(`Preserved smoke workspace: ${tempRoot}`);
  } else {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
