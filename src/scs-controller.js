import { redactSensitiveText, redactValue } from "./redaction.js";
import { formatBehaviorContractForPrompt, scsContractCriteria } from "./behavior-contract.js";

export const SCS_MODES = ["off", "on", "auto"];

const COMPLEX_AUTO_PROFILES = new Set([
  "android",
  "app",
  "code",
  "codebase",
  "database",
  "devops",
  "github",
  "ios",
  "large-codebase",
  "latex",
  "maintenance",
  "paper",
  "qa",
  "research",
  "review",
  "security",
  "supervision",
  "website",
]);

const COMPLEX_AUTO_HINTS = [
  /\b(complex|complicated|large|multi[- ]file|cross[- ]file|repo[- ]wide|workspace[- ]wide)\b/i,
  /\b(implement|refactor|debug|failing|regression|root cause|test|build|compile|migrate)\b/i,
  /\b(android|ios|gradle|xcode|docker|systemd|github|pull request|release|deploy|latex|pdf)\b/i,
  /\b(supervise|monitor|long[- ]running|resume|tmux|simulator|emulator)\b/i,
];

function compact(value = "", limit = 1200) {
  const text = redactSensitiveText(String(value || "").replace(/\s+/g, " ").trim());
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 24)} ... [truncated]`;
}

function compactJson(value, limit = 1800) {
  try {
    return compact(JSON.stringify(redactValue(value), null, 2), limit);
  } catch {
    return compact(String(value || ""), limit);
  }
}

export function normalizeScsMode(value = "off") {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "enable", "enabled", "on", "scs"].includes(text)) return "on";
  if (["auto", "smart"].includes(text)) return "auto";
  if (["0", "false", "no", "n", "disable", "disabled", "off"].includes(text)) return "off";
  return "off";
}

export function shouldActivateScs(mode = "off", context = {}) {
  const normalized = normalizeScsMode(mode);
  if (normalized === "on") return true;
  if (normalized !== "auto") return false;

  const profile = String(context.taskProfile || "").toLowerCase();
  const goal = String(context.goal || "");
  if (Number(context.complexityScore || 0) >= 3) return true;
  if (COMPLEX_AUTO_PROFILES.has(profile)) return true;
  return COMPLEX_AUTO_HINTS.some((hint) => hint.test(goal));
}

function fallbackPlan(goal = "") {
  return [
    "1. Inspect the workspace, project instructions, and relevant manifests before editing.",
    "2. State assumptions or ambiguities that could change scope, safety, or implementation.",
    "3. Make the smallest coherent implementation or research pass that satisfies the request.",
    "4. Run targeted checks or document why checks are unavailable.",
    "5. Finish only after concrete evidence supports the result.",
  ].join("\n");
}

function parseJsonObject(content = "") {
  const text = String(content || "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try a balanced-looking object excerpt below.
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        // Fall through.
      }
    }
  }
  return null;
}

async function callJson(client, config, messages, fallback, label) {
  if (client.mock) return fallback;
  let response;
  try {
    response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0,
        messages,
      },
      {
        ...(config.abortSignal ? { signal: config.abortSignal } : {}),
        timeout: Number(config.modelTimeoutMs || process.env.AGINTI_MODEL_TIMEOUT_MS || 90000),
      }
    );
  } catch (error) {
    if (config.abortSignal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    return {
      ...fallback,
      callWarning: `${label} call failed; fallback schema used: ${compact(error instanceof Error ? error.message : String(error), 500)}`,
    };
  }
  const content = response.choices[0]?.message?.content || "";
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return {
      ...fallback,
      raw: compact(content, 1200),
      parserWarning: `${label} did not return strict JSON; fallback schema used.`,
    };
  }
  return parsed;
}

function normalizeStringList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => compact(item, 220)).filter(Boolean).slice(0, 8);
  if (typeof value === "string" && value.trim()) return [compact(value, 220)];
  return fallback;
}

function normalizePlanText(plan) {
  if (Array.isArray(plan)) {
    return plan
      .map((item, index) => {
        const text = compact(item, 260).replace(/^\d+[.)]\s*/, "");
        return `${index + 1}. ${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  const text = String(plan || "").trim();
  if (!text) return "";
  const redacted = redactSensitiveText(text);
  return redacted.length <= 1800 ? redacted : `${redacted.slice(0, 1776)} ... [truncated]`;
}

export function buildScsEvidencePack(state = {}, context = {}) {
  const messages = Array.isArray(state.messages) ? state.messages.slice(-16) : [];
  const messageSummary = messages.map((message) => {
    if (message.role === "tool") {
      try {
        const parsed = JSON.parse(message.content || "{}");
        return `tool:${parsed.toolName || message.tool_call_id || "unknown"} ok=${parsed.ok !== false} done=${Boolean(parsed.done)} ${compactJson(
          {
            error: parsed.error || parsed.reason || "",
            stdout: parsed.stdout ? String(parsed.stdout).slice(0, 300) : "",
            path: parsed.path || "",
            changes: Array.isArray(parsed.changes) ? parsed.changes.map((change) => change.path).filter(Boolean) : [],
          },
          600
        )}`;
      } catch {
        return `tool:${message.tool_call_id || "unknown"} ${compact(message.content, 600)}`;
      }
    }
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => call.function?.name || "tool").join(",")
      : "";
    return `${message.role}${toolCalls ? ` tools=${toolCalls}` : ""}: ${compact(message.content, 600)}`;
  });

  const events = Array.isArray(context.events)
    ? context.events.slice(-20).map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        data: redactValue(event.data || {}),
      }))
    : [];

  return compactJson(
    {
      goal: state.goal || context.goal || "",
      taskProfile: context.taskProfile || "",
      approvedPlan: state.plan || "",
      scs: state.meta?.scs || null,
      recentEvents: events,
      recentMessages: messageSummary,
    },
    7000
  );
}

export function buildSupervisorInstruction(scs = {}) {
  const criteria = normalizeStringList(scs.acceptanceCriteria);
  const stopConditions = normalizeStringList(scs.stopConditions);
  return [
    "SCS mode is enabled. You are the supervisor executor.",
    "Execute the approved phase plan. You may choose exact tools and paths, but you may not replace the strategic plan with a new one.",
    formatBehaviorContractForPrompt(),
    "If tool evidence invalidates the plan, stop repeating the failed path and explain the blocker through finish or wait for student review.",
    "Approved phase plan:",
    scs.plan || fallbackPlan(),
    criteria.length ? `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}` : "",
    stopConditions.length ? `Stop conditions:\n${stopConditions.map((item) => `- ${item}`).join("\n")}` : "",
    "Before calling finish, include concrete evidence: files changed, commands/checks run, artifacts created, or a clear limitation.",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeCommitteePlan(parsed, goal = "") {
  const plan = normalizePlanText(parsed.plan) || fallbackPlan(goal);
  return {
    role: "committee",
    phaseGoal: compact(parsed.phase_goal || parsed.phaseGoal || goal || "Complete the requested task.", 260),
    plan,
    acceptanceCriteria: normalizeStringList(parsed.acceptance_criteria || parsed.acceptanceCriteria, [
      ...scsContractCriteria(),
      "The requested outcome is present in the workspace or answer.",
      "Relevant checks were run or skipped with a concrete reason.",
    ]),
    allowedTools: normalizeStringList(parsed.allowed_tools || parsed.allowedTools, []),
    stopConditions: normalizeStringList(parsed.stop_conditions || parsed.stopConditions, [
      "The same tool/path fails twice.",
      "Required credentials, SDKs, or external devices are unavailable.",
    ]),
  };
}

function normalizeDecision(parsed, fallbackDecision = "approve_plan") {
  const allowed = new Set([
    "approve_plan",
    "veto_plan",
    "rethink_plan",
    "accept_phase",
    "reject_phase",
    "finish_allowed",
    "finish_rejected",
  ]);
  const decision = allowed.has(String(parsed.decision || "")) ? parsed.decision : fallbackDecision;
  const confidence = Number(parsed.confidence);
  return {
    role: "student",
    decision,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6,
    evidence: normalizeStringList(parsed.evidence, []),
    reason: compact(parsed.reason || "", 400),
    nextRequiredAction: compact(parsed.next_required_action || parsed.nextRequiredAction || "", 220),
  };
}

export async function createScsPlan(client, config, state, context = {}) {
  const evidence = buildScsEvidencePack(state, context);
  const fallbackCommittee = normalizeCommitteePlan({ plan: fallbackPlan(state.goal), phase_goal: state.goal }, state.goal);
  let committee = fallbackCommittee;
  let student = normalizeDecision(
    {
      decision: "approve_plan",
      confidence: 0.55,
      reason: "Fallback approval for a conservative bounded phase plan.",
      next_required_action: "supervisor_execute",
    },
    "approve_plan"
  );

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rawCommittee = await callJson(
      client,
      config,
      [
        {
          role: "system",
          content:
            `You are the SCS committee. Draft one practical next-phase plan only. You cannot approve it and you cannot call tools. ${formatBehaviorContractForPrompt({ mode: "plan" })} Return strict JSON with keys: role, phase_goal, plan, acceptance_criteria, allowed_tools, stop_conditions.`,
        },
        {
          role: "user",
          content: `Goal and evidence:\n${evidence}\n\nReturn one short phase plan as JSON. Plan must be 3-6 concrete steps.`,
        },
      ],
      fallbackCommittee,
      "SCS committee"
    );
    committee = normalizeCommitteePlan(rawCommittee, state.goal);

    const rawStudent = await callJson(
      client,
      config,
      [
        {
          role: "system",
          content:
            `You are the SCS student monitor. You may approve_plan or veto_plan only. Judge whether the committee phase plan is safe, scoped, minimal, permission-aware, and evidence-oriented. ${formatBehaviorContractForPrompt({ mode: "plan" })} Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.`,
        },
        {
          role: "user",
          content: `Goal/evidence:\n${evidence}\n\nCommittee plan:\n${compactJson(committee, 4000)}`,
        },
      ],
      student,
      "SCS student plan gate"
    );
    student = normalizeDecision(rawStudent, "approve_plan");
    if (student.decision !== "veto_plan" || attempt === 2) break;
  }

  if (student.decision === "veto_plan") {
    student.decision = "approve_plan";
    student.reason = `Plan veto was capped after retries; approving conservative fallback. Last concern: ${student.reason || "unspecified"}`;
    committee = fallbackCommittee;
  }

  const scs = {
    enabled: true,
    mode: config.enableScs || "on",
    active: true,
    model: `${config.provider}/${config.model}`,
    phase: 1,
    phaseGoal: committee.phaseGoal,
    plan: committee.plan,
    acceptanceCriteria: committee.acceptanceCriteria,
    allowedTools: committee.allowedTools,
    stopConditions: committee.stopConditions,
    committee,
    student,
    finishRejects: 0,
    monitorReviews: 0,
  };
  return {
    scs,
    plan: committee.plan,
    supervisorInstruction: buildSupervisorInstruction(scs),
  };
}

export function shouldReviewToolResult(toolResult, state = {}) {
  if (!toolResult || toolResult.done) return false;
  if (toolResult.ok === false || toolResult.blocked || toolResult.error || toolResult.reason) return true;
  const recent = state.meta?.toolLoop?.recent || [];
  const warned = state.meta?.toolLoop?.warned || [];
  return warned.length > 0 && recent.some((entry) => entry.toolName === toolResult.toolName && entry.ok === false);
}

export async function reviewScsToolResult(client, config, state, toolResult, context = {}) {
  const fallback = normalizeDecision(
    {
      decision: "rethink_plan",
      confidence: 0.65,
      reason: `Tool evidence needs supervisor adjustment: ${toolResult?.error || toolResult?.reason || toolResult?.toolName || "unknown"}`,
      next_required_action: "supervisor_continue",
      evidence: [toolResult?.toolName || "tool"],
    },
    "rethink_plan"
  );
  if ((state.meta?.scs?.monitorReviews || 0) >= 4) {
    return {
      ...fallback,
      decision: "accept_phase",
      reason: "SCS monitor cap reached; continuing under existing runtime guardrails.",
    };
  }

  const evidence = buildScsEvidencePack(state, context);
  const raw = await callJson(
    client,
    config,
    [
      {
        role: "system",
        content:
          "You are the SCS student monitor. Review the latest failed/blocked tool evidence. Emit one decision: accept_phase, reject_phase, or rethink_plan. Do not call tools. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
      },
      {
        role: "user",
        content: `Latest tool result:\n${compactJson(toolResult, 2500)}\n\nEvidence pack:\n${evidence}`,
      },
    ],
    fallback,
    "SCS student monitor"
  );
  return normalizeDecision(raw, "rethink_plan");
}

export function shouldReviewScsProgress(step, state = {}) {
  if (!Number.isFinite(Number(step)) || Number(step) <= 1 || Number(step) % 4 !== 0) return false;
  return (state.meta?.scs?.monitorReviews || 0) < 4;
}

export async function reviewScsProgress(client, config, state, context = {}) {
  const fallback = normalizeDecision(
    {
      decision: "accept_phase",
      confidence: 0.55,
      reason: "Periodic SCS progress fallback accepted. Continue under runtime guardrails.",
      evidence: ["periodic progress review"],
      next_required_action: "supervisor_continue",
    },
    "accept_phase"
  );
  const evidence = buildScsEvidencePack(state, context);
  const raw = await callJson(
    client,
    config,
    [
      {
        role: "system",
        content:
          "You are the SCS student monitor. Perform a periodic progress review. Emit accept_phase if progress is coherent, rethink_plan if the plan needs adjustment, or reject_phase if the supervisor is drifting or lacks evidence. Do not call tools. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
      },
      {
        role: "user",
        content: `Evidence pack:\n${evidence}`,
      },
    ],
    fallback,
    "SCS progress monitor"
  );
  return normalizeDecision(raw, "accept_phase");
}

export async function reviewScsFinish(client, config, state, result = "", context = {}) {
  const fallback = normalizeDecision(
    {
      decision: "finish_allowed",
      confidence: 0.55,
      reason: "Fallback finish approval. Runtime guardrails remain authoritative.",
      evidence: ["finish requested"],
      next_required_action: "finish",
    },
    "finish_allowed"
  );
  if ((state.meta?.scs?.finishRejects || 0) >= 2) {
    return {
      ...fallback,
      reason: "Finish rejection cap reached; allowing finish to prevent SCS deadlock.",
    };
  }

  const evidence = buildScsEvidencePack(state, context);
  const raw = await callJson(
    client,
    config,
    [
      {
        role: "system",
        content:
          "You are the SCS student final gate. Decide if the supervisor has enough concrete evidence to finish. Emit finish_allowed or finish_rejected only. Be strict for coding/system tasks, but do not demand impossible checks. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
      },
      {
        role: "user",
        content: `Proposed final result:\n${compact(result, 2200)}\n\nEvidence pack:\n${evidence}`,
      },
    ],
    fallback,
    "SCS finish gate"
  );
  const decision = normalizeDecision(raw, "finish_allowed");
  if (!["finish_allowed", "finish_rejected"].includes(decision.decision)) {
    decision.decision = decision.decision === "reject_phase" ? "finish_rejected" : "finish_allowed";
  }
  return decision;
}
