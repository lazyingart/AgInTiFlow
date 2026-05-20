import { redactSensitiveText, redactValue } from "./redaction.js";
import { formatBehaviorContractForPrompt, scsContractCriteria } from "./behavior-contract.js";
import { browserStateReconciliationGuidance } from "./browser-automation-guidance.js";
import {
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  deterministicFinishBlocker,
  evaluateScsSemanticContract,
  evaluateScsEvidence,
  finishResultClaimsBlocker,
  hasScsBlockerEvidence,
  summarizeScsContractEvidence,
} from "./scs-evidence.js";

export const SCS_MODES = ["off", "on", "auto"];

const COMPLEX_AUTO_PROFILES = new Set([
  "android",
  "app",
  "book",
  "code",
  "codebase",
  "database",
  "devops",
  "github",
  "ios",
  "large-codebase",
  "latex",
  "maintenance",
  "novel",
  "paper",
  "qa",
  "research",
  "review",
  "security",
  "supervision",
  "website",
  "writing",
]);

const COMPLEX_AUTO_HINTS = [
  /\b(complex|complicated|large|multi[- ]file|cross[- ]file|repo[- ]wide|workspace[- ]wide)\b/i,
  /\b(implement|refactor|debug|failing|regression|root cause|test|build|compile|migrate)\b/i,
  /\b(android|ios|gradle|xcode|docker|systemd|github|pull request|release|deploy|latex|pdf)\b/i,
  /\b(supervise|monitor|long[- ]running|resume|tmux|simulator|emulator)\b/i,
  /\b(browser|web[- ]?ui|website|chrome|chromedriver|cdp|devtools|playwright|selenium|puppeteer)\b/i,
  /\b(upload|attach|asset library|submit|publish|poll|download|reference video|reference image)\b/i,
  /\b(novel|book|chapter|manuscript|screenplay|story bible|long[- ]form|research paper)\b/i,
  /小云雀|浏览器|网页|上传|提交|发布|资产库|参考图|参考视频|短片|生成视频|沉浸式|按钮|登录|积分/,
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

function likelyWholePageText(value = "") {
  const text = String(value || "").replace(/\\n/g, "\n");
  if (text.length < 1200) return false;
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 16) return false;
  const signalPatterns = [
    /\b(history|assets?|library|new chat|home|login|profile|settings|examples?|all|yesterday|this month)\b/i,
    /历史记录|资产库|新对话|全部|昨天|本月|更早|登录|会员|爆款案例/,
    /\b(upload|attach|reference|submit|publish|model|duration|prompt)\b/i,
    /上传|参考|提交|发布|模型|时长|提示词|按钮/,
  ];
  const signals = signalPatterns.filter((pattern) => pattern.test(text)).length;
  return signals >= 2;
}

export function isSuspiciousBroadBrowserToolResult(toolResult = {}) {
  if (!toolResult || toolResult.ok === false || toolResult.blocked || toolResult.done) return false;
  const toolName = String(toolResult.toolName || "");
  const command = String(toolResult.args?.command || "");
  const stdout = String(toolResult.stdout || "");
  const combined = `${toolName}\n${command}\n${stdout}`;
  const browserCommand =
    /\b(browser|chrome|chromium|cdp|devtools|playwright|selenium|puppeteer)\b/i.test(combined) ||
    /\b(click-text|click_text|clickText|querySelector|document\.|xpath|dom)\b/i.test(combined);
  if (!browserCommand) return false;

  let resultText = "";
  const parsed = parseJsonObject(stdout);
  if (parsed && typeof parsed === "object") {
    resultText = [parsed.text, parsed.clicked, parsed.label, parsed.reason].filter(Boolean).join("\n");
  }
  const inspectedText = resultText || stdout;
  if (!likelyWholePageText(inspectedText)) return false;
  return /\b(click-text|click_text|clickText|click)\b/i.test(command) || resultText.length > 0;
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

function fallbackBlockedPlan(goal = "", studentReason = "") {
  return [
    "1. Do not execute target work under a phase plan the student validator rejected.",
    "2. Report the validator blocker with the specific evidence and unresolved acceptance criteria.",
    "3. Ask for either clearer requirements or an explicit override before taking irreversible actions.",
    studentReason ? `4. Validator concern to preserve: ${compact(studentReason, 180)}` : "",
    goal ? `5. Original goal remains: ${compact(goal, 180)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function fallbackHardContractPlan(goal = "", contract = {}, studentReason = "") {
  const exactOutputPaths = normalizeStringList(contract.exactOutputPaths, []);
  const exactInputPaths = normalizeStringList(contract.exactInputPaths, []);
  const requiredTextTerms = normalizeStringList(contract.requiredTextTerms, []);
  const forbiddenTextTerms = normalizeStringList(contract.forbiddenTextTerms, []);
  return [
    "1. Execute the user's target work under the deterministic hard-contract fallback plan.",
    exactOutputPaths.length
      ? `2. Write the requested output exactly at: ${exactOutputPaths.join(", ")}. If an output file already exists and the user allowed overwrite/update, overwrite it intentionally.`
      : "2. Create or update the requested output artifact at the user-specified location.",
    exactInputPaths.length ? `3. Use these exact user-specified input/reference path(s): ${exactInputPaths.join(", ")}.` : "",
    requiredTextTerms.length ? `4. Ensure the output contains these required term(s): ${requiredTextTerms.join(", ")}.` : "",
    forbiddenTextTerms.length ? `5. Ensure the output does not contain these forbidden term(s): ${forbiddenTextTerms.join(", ")}.` : "",
    "6. Run concrete validation commands or inspections for file existence and content before finish.",
    studentReason ? `7. Preserve the validator concern while executing: ${compact(studentReason, 180)}` : "",
    goal ? `8. Original goal remains authoritative: ${compact(goal, 220)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
        timeout: Number(config.modelTimeoutMs || process.env.AGINTI_MODEL_TIMEOUT_MS || 180000),
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
  if (Array.isArray(value)) return value.map((item) => compact(item, 220)).filter(Boolean).slice(0, 16);
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

function formatHardContractForPrompt(contract = {}) {
  const lines = [];
  const exactOutputPaths = normalizeStringList(contract.exactOutputPaths, []);
  const exactInputPaths = normalizeStringList(contract.exactInputPaths, []);
  const requiredTextTerms = normalizeStringList(contract.requiredTextTerms, []);
  const forbiddenTextTerms = normalizeStringList(contract.forbiddenTextTerms, []);
  const forbiddenActions = normalizeStringList(contract.forbiddenActions, []);
  if (exactOutputPaths.length) lines.push(`Exact output path(s): ${exactOutputPaths.join(", ")}`);
  if (exactInputPaths.length) lines.push(`Exact input/reference path(s) to use: ${exactInputPaths.join(", ")}`);
  if (requiredTextTerms.length) lines.push(`Required text term(s) in the output: ${requiredTextTerms.join(", ")}`);
  if (forbiddenTextTerms.length) lines.push(`Forbidden text term(s) in the output: ${forbiddenTextTerms.join(", ")}`);
  if (forbiddenActions.length) lines.push(`Forbidden action(s): ${forbiddenActions.join("; ")}`);
  return lines.length
    ? [
        "Inferred hard task contract. Preserve these literally; do not replace them with weaker or contradictory criteria:",
        ...lines.map((line) => `- ${line}`),
      ].join("\n")
    : "";
}

function deterministicPlanContractIssue(committee = {}, contract = {}) {
  const planText = `${committee.phaseGoal || ""}\n${committee.plan || ""}\n${(committee.acceptanceCriteria || []).join("\n")}`;
  const missingPath = normalizeStringList(contract.exactOutputPaths, []).filter((item) => !planText.includes(item));
  const missingInputPath = normalizeStringList(contract.exactInputPaths, []).filter((item) => !planText.includes(item));
  const missingRequiredTerms = normalizeStringList(contract.requiredTextTerms, []).filter((item) => !planText.includes(item));
  const forbiddenTermsInPlan = normalizeStringList(contract.forbiddenTextTerms, []).filter((item) => planText.includes(item));
  const actionContradiction = deterministicPlanActionContradiction(planText, contract);
  if (missingPath.length || missingInputPath.length || missingRequiredTerms.length || forbiddenTermsInPlan.length || actionContradiction) {
    return {
      decision: "veto_plan",
      confidence: 0.94,
      evidence: [
        missingPath.length ? `Plan omitted exact output path(s): ${missingPath.join(", ")}` : "",
        missingInputPath.length ? `Plan omitted exact input/reference path(s): ${missingInputPath.join(", ")}` : "",
        missingRequiredTerms.length ? `Plan omitted required text term(s): ${missingRequiredTerms.join(", ")}` : "",
        forbiddenTermsInPlan.length ? `Plan includes forbidden text term(s): ${forbiddenTermsInPlan.join(", ")}` : "",
        actionContradiction || "",
      ].filter(Boolean),
      reason:
        "The phase plan does not preserve the user's inferred hard task contract. It must carry exact paths, required/forbidden output terms, and requested action targets without inventing contradictory actions.",
      next_required_action:
        "Committee must draft a new plan whose acceptance criteria explicitly include every exact output path, required text term, forbidden text term, and requested action target from the hard contract.",
    };
  }
  return null;
}

const UPLOAD_ACTION_RE =
  /\b(upload|attach|add|select|choose|import|provide)\b|上传|附加|添加|选择|选取|导入|提供|从资产库选择|从素材库选择/iu;
const IMAGE_TARGET_RE = /\b(images?|photos?|pictures?|thumbnails?)\b|图片|照片|参考图|素材图|图像|五张|5张/iu;
const VIDEO_TARGET_RE = /\b(video\s*files?|mp4s?|movs?|webms?)\b|视频文件|mp4|mov|webm/iu;

function nearbyUploadTargetKinds(text = "") {
  const kinds = new Set();
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return kinds;
  const segments = normalized
    .split(/(?<=[。.!?！？；;])|\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (!UPLOAD_ACTION_RE.test(segment)) continue;
    if (IMAGE_TARGET_RE.test(segment)) kinds.add("image");
    if (VIDEO_TARGET_RE.test(segment)) kinds.add("video-file");
  }
  return kinds;
}

export function deterministicPlanActionContradiction(planText = "", contract = {}) {
  const goal = String(contract.outcome || "");
  const requestedKinds = nearbyUploadTargetKinds(goal);
  const planKinds = nearbyUploadTargetKinds(planText);
  if (requestedKinds.has("image") && !requestedKinds.has("video-file") && planKinds.has("video-file")) {
    return "Plan invents a video-file upload even though the user requested image/reference-image uploads.";
  }
  return null;
}

function isBrowserSubmitGoal(goal = "") {
  const text = String(goal || "");
  const browserSignal =
    /\b(browser|chrome|chromium|cdp|devtools|selenium|playwright|web[- ]?ui|website|composer)\b/i.test(text) ||
    /小云雀|xyq|浏览器|网页|上传|资产库|参考视频|参考图|短片|沉浸式/.test(text);
  const submitSignal =
    /\b(submit|publish|generate|post|upload|attach|asset library|reference video|reference image)\b/i.test(text) ||
    /提交|发布|生成|上传|附件|资产库|参考视频|参考图/.test(text);
  return browserSignal && submitSignal;
}

function hasAllowedExternalBrowserBlocker(result = "") {
  return /积分不足|余额不足|credits? (not enough|insufficient)|not enough credits|login|登录|captcha|验证码|internal error|server error|服务器错误|内部错误|合规|安全|风控|account permission|会员权限|permission denied|确认弹窗|confirmation dialog|user confirmation/i.test(
    String(result || "")
  );
}

export function browserSubmitFinishIssue(goal = "", result = "") {
  if (!isBrowserSubmitGoal(goal)) return null;
  const text = String(result || "");
  if (!text.trim() || hasAllowedExternalBrowserBlocker(text)) return null;
  const incomplete =
    /未执行|未完成|跳过|步骤不足|未找到.*(提交|生成)|没有.*(提交|生成)|not submitted|did not submit|submit[^.\n]{0,80}(not|skipped|missing|failed)|skipped|incomplete|not executed|not run|not found/i.test(
      text
    ) ||
    /资产库[^。\n|]*未执行|参考视频[^。\n|]*未执行|VIP[^。\n|]*跳过|提交[^。\n|]*未执行|生成[^。\n|]*未执行|页面状态出现偏差|非创建页|manual.*confirm/i.test(
      text
    );
  if (!incomplete) return null;
  return "Browser submit/generation task is unfinished: the proposed result reports skipped or unexecuted required UI actions, but no real external blocker was proven.";
}

function finishRequiresExternalEvidence(goal = "", taskProfile = "") {
  const text = `${String(goal || "")}\n${String(taskProfile || "")}`.toLowerCase();
  if (
    /\b(code|app|android|ios|large-codebase|github|maintenance|security|latex|research|supervision|aaps|website)\b/.test(text) ||
    /\b(create|write|edit|patch|fix|repair|refactor|build|test|run|install|publish|submit|upload|download|copy|move|convert|remove|delete|commit|push|deploy|browser|chrome|cdp|playwright|selenium|artifact|file|video|image|pdf|docx)\b/.test(
      text
    ) ||
    /创建|写入|编辑|修复|测试|运行|安装|发布|提交|上传|下载|复制|移动|转换|删除|浏览器|网页|文件|视频|图片|资产|生成/.test(text)
  ) {
    return true;
  }
  return false;
}

function contractForState(state = {}, context = {}) {
  const scs = state.meta?.scs || {};
  return (
    scs.taskContract ||
    deriveScsTaskContract({
      goal: state.goal || context.goal || "",
      taskProfile: context.taskProfile || "",
      acceptanceCriteria: scs.acceptanceCriteria || [],
    })
  );
}

function hasConcreteFinishEvidence(state = {}, context = {}) {
  const contract = contractForState(state, context);
  const ledger = buildScsEvidenceLedger({ state, context });
  const evaluation = evaluateScsEvidence(contract, ledger);
  return evaluation.ok;
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
            stdout: parsed.stdout ? String(parsed.stdout).slice(0, 1200) : "",
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

  const taskContract = contractForState(state, context);
  const evidenceLedger = buildScsEvidenceLedger({ state, context });
  const evidenceEvaluation = evaluateScsEvidence(taskContract, evidenceLedger);

  return compactJson(
    {
      goal: state.goal || context.goal || "",
      taskProfile: context.taskProfile || "",
      approvedPlan: state.plan || "",
      scs: state.meta?.scs || null,
      ...summarizeScsContractEvidence({
        contract: taskContract,
        ledger: evidenceLedger,
        evaluation: evidenceEvaluation,
      }),
      recentEvents: events,
      recentMessages: messageSummary,
    },
    7000
  );
}

export function buildSupervisorInstruction(scs = {}) {
  const criteria = normalizeStringList(scs.acceptanceCriteria);
  const stopConditions = normalizeStringList(scs.stopConditions);
  const hardContract = formatHardContractForPrompt(scs.taskContract || {});
  return [
    "SCS mode is enabled. SCS means Student-Committee-Supervisor; do not redefine the acronym.",
    "You are the supervisor executor in that Student-Committee-Supervisor pipeline.",
    "Role boundaries: committee plans only; student is the independent validator/QA gate and may approve, reject, or request replan; supervisor executes tools and gathers evidence.",
    "Execute the approved phase plan. You may choose exact tools and paths, but you may not replace the strategic plan with a new one.",
    "If the student validator rejects a finish, tool result, or phase progress, stop treating the current plan as self-approved. Wait for the runtime to request a committee replan, then execute the new approved phase.",
    formatBehaviorContractForPrompt(),
    "If tool evidence invalidates the plan, stop repeating the failed path and explain the blocker through finish or wait for student review.",
    "Approved phase plan:",
    scs.plan || fallbackPlan(),
    hardContract,
    criteria.length ? `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}` : "",
    stopConditions.length ? `Stop conditions:\n${stopConditions.map((item) => `- ${item}`).join("\n")}` : "",
    "Before calling finish, include concrete evidence: files changed, commands/checks run, artifacts created, or a clear limitation.",
    "For substantial writing phases, use writing_specialist for isolated prose/argument/scene drafting, then let the supervisor handle files, formatting, citations, checks, and artifacts.",
    browserStateReconciliationGuidance(),
    "For browser/CDP/helper workflows, a command can return ok=true while still clicking the wrong broad page element. If a click/search result returns whole-page text, repeated navigation/sidebar text, or no scoped target, treat it as suspect evidence: verify state, switch to a precise selector or scoped toolbar/container query, and do not repeat the same broad click.",
  ]
    .filter(Boolean)
    .join("\n");
}

function committeeSystemPrompt({ phaseKind = "initial" } = {}) {
  const replan = phaseKind === "replan";
  return [
    "You are the SCS committee planner. Draft one practical next-phase plan only.",
    "You cannot approve the plan, monitor execution, call tools, or declare completion.",
    replan
      ? "This is a replan request caused by the independent student validator rejecting the prior phase, progress, or finish. Address the validator evidence directly instead of repeating the same plan."
      : "",
    browserStateReconciliationGuidance(),
    formatBehaviorContractForPrompt({ mode: "plan" }),
    "Preserve exact user hard constraints literally: output paths, required words/phrases, forbidden words/phrases, model/duration/tier, and explicit no-action instructions. Do not invent contradictory acceptance criteria such as a different length target or output location.",
    "Return strict JSON with keys: role, phase_goal, plan, acceptance_criteria, allowed_tools, stop_conditions.",
  ]
    .filter(Boolean)
    .join(" ");
}

function studentPlanGatePrompt() {
  return [
    "You are the independent SCS student validator. You are QA, not a cheerleader.",
    "You may approve_plan or veto_plan only.",
    "Judge whether the committee phase plan is safe, scoped, minimal, permission-aware, and evidence-oriented.",
    "You cannot execute tools or approve your own work. If the plan is weak, veto it so the committee must draft a better plan.",
    "For browser tasks, reject plans that stop merely because a state field is unknown when the user requested a target state and a bounded set-then-verify path is available.",
    "Reject any plan whose phase goal, steps, or acceptance criteria omit exact input/reference paths, exact output paths, required output phrases, or forbidden output phrases from the hard task contract. Also reject plans that add contradictory constraints not requested by the user.",
    formatBehaviorContractForPrompt({ mode: "plan" }),
    "Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
  ].join(" ");
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

function normalizeBudgetDecision(parsed, fallback = {}) {
  const allowed = new Set(["extend_steps", "deny_extension", "rethink_plan"]);
  const decision = allowed.has(String(parsed?.decision || "")) ? parsed.decision : fallback.decision || "deny_extension";
  const confidence = Number(parsed?.confidence);
  const extraSteps = Number(parsed?.extra_steps ?? parsed?.extraSteps ?? fallback.extraSteps ?? fallback.extra_steps ?? 0);
  return {
    role: "student",
    decision,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : fallback.confidence || 0.6,
    extraSteps: Number.isFinite(extraSteps) && extraSteps > 0 ? Math.floor(extraSteps) : 0,
    evidence: normalizeStringList(parsed?.evidence, fallback.evidence || []),
    reason: compact(parsed?.reason || fallback.reason || "", 500),
    nextRequiredAction: compact(parsed?.next_required_action || parsed?.nextRequiredAction || fallback.nextRequiredAction || "", 240),
  };
}

async function createScsPhase(client, config, state, context = {}, options = {}) {
  const phase = Number(options.phase || 1);
  const phaseKind = options.phaseKind || "initial";
  const validatorFeedback = options.validatorFeedback || null;
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
  let lastValidatorConcern = validatorFeedback?.reason || validatorFeedback?.nextRequiredAction || "";
  const taskContract = deriveScsTaskContract({
    goal: state.goal,
    taskProfile: context.taskProfile || "",
    acceptanceCriteria: [],
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rawCommittee = await callJson(
      client,
      config,
      [
        {
          role: "system",
          content: committeeSystemPrompt({ phaseKind }),
        },
        {
          role: "user",
          content: [
            `Goal and evidence:\n${evidence}`,
            formatHardContractForPrompt(taskContract),
            validatorFeedback
              ? `Student validator feedback that caused this ${phaseKind}:\n${compactJson(validatorFeedback, 1800)}`
              : "",
            lastValidatorConcern && attempt > 1 ? `Previous student veto concern to address:\n${lastValidatorConcern}` : "",
            "Return one short phase plan as JSON. Plan must be 3-6 concrete steps.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      fallbackCommittee,
      "SCS committee"
    );
    committee = normalizeCommitteePlan(rawCommittee, state.goal);
    const deterministicIssue = deterministicPlanContractIssue(committee, taskContract);
    if (deterministicIssue) {
      student = normalizeDecision(deterministicIssue, "veto_plan");
      lastValidatorConcern = student.reason || student.nextRequiredAction || lastValidatorConcern;
      if (attempt < 2) continue;
      break;
    }

    const rawStudent = await callJson(
      client,
      config,
      [
        {
          role: "system",
          content: studentPlanGatePrompt(),
        },
        {
          role: "user",
          content: [
            `Goal/evidence:\n${evidence}`,
            formatHardContractForPrompt(taskContract),
            `Committee plan:\n${compactJson(committee, 4000)}`,
          ].join("\n\n"),
        },
      ],
      student,
      "SCS student plan gate"
    );
    student = normalizeDecision(rawStudent, "approve_plan");
    lastValidatorConcern = student.reason || student.nextRequiredAction || lastValidatorConcern;
    if (student.decision !== "veto_plan" || attempt === 2) break;
  }

  if (student.decision === "veto_plan") {
    const hardContractPlan = fallbackHardContractPlan(state.goal, taskContract, student.reason || lastValidatorConcern);
    const hardContractCriteria = [
      ...normalizeStringList(taskContract.exactOutputPaths, []).map((item) => `Exact output path is used: ${item}`),
      ...normalizeStringList(taskContract.exactInputPaths, []).map((item) => `Exact input/reference path is used: ${item}`),
      ...normalizeStringList(taskContract.requiredTextTerms, []).map((item) => `Output contains required text: ${item}`),
      ...normalizeStringList(taskContract.forbiddenTextTerms, []).map((item) => `Output omits forbidden text: ${item}`),
      "Concrete file/content validation evidence is collected before finish.",
    ];
    committee = normalizeCommitteePlan(
      {
        phase_goal: "Execute the user's target work using the deterministic hard-contract fallback plan.",
        plan: hardContractPlan,
        acceptance_criteria: hardContractCriteria,
        stop_conditions: ["A required file path is inaccessible.", "A required/forbidden text constraint cannot be satisfied."],
      },
      state.goal
    );
    student = normalizeDecision(
      {
        decision: "approve_plan",
        confidence: 0.9,
        reason:
          "Student veto remained after committee retries; runtime synthesized a deterministic hard-contract fallback plan that preserves exact user constraints.",
        evidence: student.evidence || [],
        next_required_action: "supervisor_execute_hard_contract_plan",
      },
      "approve_plan"
    );
  }

  const scs = {
    enabled: true,
    mode: config.enableScs || "on",
    active: true,
    model: `${config.provider}/${config.model}`,
    phase,
    phaseKind,
    phaseGoal: committee.phaseGoal,
    plan: committee.plan,
    acceptanceCriteria: committee.acceptanceCriteria,
    taskContract: deriveScsTaskContract({
      goal: state.goal,
      taskProfile: context.taskProfile || "",
      acceptanceCriteria: committee.acceptanceCriteria,
    }),
    allowedTools: committee.allowedTools,
    stopConditions: committee.stopConditions,
    committee,
    student,
    validatorFeedback,
    finishRejects: 0,
    monitorReviews: 0,
  };
  return {
    scs,
    plan: committee.plan,
    supervisorInstruction: buildSupervisorInstruction(scs),
  };
}

export async function createScsPlan(client, config, state, context = {}) {
  return createScsPhase(client, config, state, context, { phase: 1, phaseKind: "initial" });
}

export async function createScsReplan(client, config, state, studentDecision, context = {}) {
  const previousScs = state.meta?.scs || {};
  const phase = Number(previousScs.phase || 1) + 1;
  const result = await createScsPhase(client, config, state, context, {
    phase,
    phaseKind: "replan",
    validatorFeedback: studentDecision,
  });
  result.scs.finishRejects = previousScs.finishRejects || 0;
  result.scs.monitorReviews = previousScs.monitorReviews || 0;
  result.scs.budgetReviews = previousScs.budgetReviews || 0;
  result.scs.replanCount = (previousScs.replanCount || 0) + 1;
  result.scs.previousPhase = previousScs.phase || null;
  result.scs.replannedFrom = studentDecision || null;
  return result;
}

export function shouldRequestScsReplan(decision = {}) {
  return ["rethink_plan", "reject_phase", "finish_rejected"].includes(String(decision?.decision || ""));
}

export function shouldReviewToolResult(toolResult, state = {}) {
  if (!toolResult || toolResult.done) return false;
  if (toolResult.ok === false || toolResult.blocked || toolResult.error || toolResult.reason) return true;
  if (isSuspiciousBroadBrowserToolResult(toolResult)) return true;
  const recent = state.meta?.toolLoop?.recent || [];
  const warned = state.meta?.toolLoop?.warned || [];
  return warned.length > 0 && recent.some((entry) => entry.toolName === toolResult.toolName && entry.ok === false);
}

export async function reviewScsToolResult(client, config, state, toolResult, context = {}) {
  const fallback = normalizeDecision(
    {
      decision: "rethink_plan",
      confidence: 0.65,
      reason: isSuspiciousBroadBrowserToolResult(toolResult)
        ? "Browser/helper output looked successful but returned broad whole-page text, so the click or selector was probably imprecise."
        : `Tool evidence needs supervisor adjustment: ${toolResult?.error || toolResult?.reason || toolResult?.toolName || "unknown"}`,
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
          "You are the SCS student monitor. Review the latest failed/blocked/suspicious tool evidence. Emit one decision: accept_phase, reject_phase, or rethink_plan. Do not call tools. If browser/CDP/helper output says ok=true but returns whole-page text, navigation/history/sidebar text, or an unscoped broad match, treat it as a likely wrong target and propose a precise selector/state-check replan. If the supervisor is repeating a bad path, propose interruption and a new bounded plan. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
      },
      {
        role: "user",
        content: [
          `Latest tool result:\n${compactJson(toolResult, 2500)}`,
          isSuspiciousBroadBrowserToolResult(toolResult)
            ? "Runtime heuristic: this successful browser/helper result appears to contain whole-page text from an imprecise click or broad selector."
            : "",
          `Evidence pack:\n${evidence}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
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
          "You are the SCS student monitor. Perform a periodic progress review. Emit accept_phase if progress is coherent, rethink_plan if the plan needs adjustment, or reject_phase if the supervisor is drifting or lacks evidence. Do not call tools. Monitor progress only; propose interruption/replan when needed. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
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

export async function reviewScsStepBudget(client, config, state, context = {}) {
  const runtimeDecision = context.runtimeDecision || {};
  const fallback = normalizeBudgetDecision({
    decision: runtimeDecision.approved ? "extend_steps" : "deny_extension",
    confidence: runtimeDecision.approved ? 0.62 : 0.72,
    extra_steps: runtimeDecision.extraSteps || 0,
    reason: runtimeDecision.reason || "Runtime budget gate supplied the fallback step-extension decision.",
    evidence: runtimeDecision.evidence || [],
    next_required_action: runtimeDecision.approved ? "supervisor_continue_with_focused_verification" : "finish_or_report_blocker",
  });
  const evidence = buildScsEvidencePack(state, context);
  const raw = await callJson(
    client,
    config,
    [
      {
        role: "system",
        content:
          "You are the SCS student budget gate. The run is near its step limit. Decide whether to grant a bounded extension. Emit extend_steps only when recent evidence shows concrete progress, no permission blocker is being bypassed, and the next phase is specific. Emit deny_extension when more steps would hide a loop or blocker. Emit rethink_plan when progress exists but the supervisor needs to adjust the next phase. Do not call tools. Return strict JSON with keys: role, decision, confidence, extra_steps, evidence, reason, next_required_action.",
      },
      {
        role: "user",
        content: [
          `Runtime budget recommendation:\n${compactJson(runtimeDecision, 2600)}`,
          `Step budget:\n${compactJson(context.stepBudget || {}, 1600)}`,
          `Evidence pack:\n${evidence}`,
        ].join("\n\n"),
      },
    ],
    fallback,
    "SCS step-budget monitor"
  );
  return normalizeBudgetDecision(raw, fallback);
}

export async function reviewScsFinish(client, config, state, result = "", context = {}) {
  const deterministicIssue = browserSubmitFinishIssue(context.goal || state.goal || "", result);
  if (deterministicIssue && (state.meta?.scs?.finishRejects || 0) < 2) {
    return normalizeDecision(
      {
        decision: "finish_rejected",
        confidence: 0.96,
        reason: deterministicIssue,
        evidence: [
          "The user requested a browser submit/generation workflow.",
          "The proposed final result says required UI steps were skipped, not executed, or not submitted.",
        ],
        next_required_action:
          "Continue with the smallest remaining browser action: verify exact selected model/tier, attach required assets/reference media, find the active composer submit control, then submit or report a real external blocker.",
      },
      "finish_rejected"
    );
  }

  const evidence = buildScsEvidencePack(state, context);
  const taskContract = contractForState(state, {
    ...context,
    taskProfile: context.taskProfile || config.taskProfile || "",
  });
  const evidenceLedger = buildScsEvidenceLedger({ state, context });
  const evidenceEvaluation = evaluateScsEvidence(taskContract, evidenceLedger);
  const semanticEvaluation = evaluateScsSemanticContract(taskContract, {
    commandCwd: config.commandCwd || process.cwd(),
  });
  const deterministicBlocker = deterministicFinishBlocker(taskContract, evidenceLedger, evidenceEvaluation);
  const hasRealBlocker = hasScsBlockerEvidence(evidenceLedger) && finishResultClaimsBlocker(result);
  if (!semanticEvaluation.ok && !hasRealBlocker) {
    return normalizeDecision(
      {
        decision: "finish_rejected",
        confidence: 0.97,
        reason: `SCS semantic hard-contract gate rejected finish: ${semanticEvaluation.reason}`,
        evidence: [
          ...(semanticEvaluation.missingFiles || []).map((item) => `missing file: ${item}`),
          ...(semanticEvaluation.missingRequiredText || []).map((item) => `missing required text: ${item}`),
          ...(semanticEvaluation.presentForbiddenText || []).map((item) => `forbidden text present: ${item}`),
        ],
        next_required_action:
          "Revise the exact output file(s) to satisfy the required and forbidden text terms, then run concrete validation commands before finishing.",
      },
      "finish_rejected"
    );
  }
  const requiresEvidence =
    taskContract.requiresExternalEvidence ||
    finishRequiresExternalEvidence(context.goal || state.goal || "", context.taskProfile || config.taskProfile || "");
  const hasEvidence = hasConcreteFinishEvidence(state, {
    ...context,
    taskProfile: context.taskProfile || config.taskProfile || "",
  });
  const fallback = normalizeDecision(
    {
      decision: requiresEvidence && !hasEvidence && !hasRealBlocker ? "finish_rejected" : "finish_allowed",
      confidence: requiresEvidence && !hasEvidence && !hasRealBlocker ? 0.78 : hasRealBlocker ? 0.82 : 0.55,
      reason:
        hasRealBlocker
          ? "Fallback finish approval for a real tool/permission blocker with structured blocker evidence."
          : requiresEvidence && !hasEvidence
          ? `Fallback finish rejection: ${evidenceEvaluation.reason || "this task requires concrete external evidence, but the evidence ledger is insufficient."}`
          : "Fallback finish approval for a task without mandatory external evidence. Runtime guardrails remain authoritative.",
      evidence: hasEvidence
        ? ["contract evidence categories were satisfied"]
        : hasRealBlocker
          ? (evidenceLedger.blockers || []).map(
              (item) => `${item.toolName || "tool"} blocked (${item.category || "blocked"}): ${item.reason || "approval required"}`
            )
        : deterministicBlocker?.evidence || ["finish requested"],
      next_required_action:
        hasRealBlocker
          ? "report_blocker"
          : requiresEvidence && !hasEvidence
          ? deterministicBlocker?.nextRequiredAction || "collect concrete evidence or report a real blocker"
          : "finish",
    },
    requiresEvidence && !hasEvidence && !hasRealBlocker ? "finish_rejected" : "finish_allowed"
  );
  if ((state.meta?.scs?.finishRejects || 0) >= 2) {
    if (requiresEvidence && !hasEvidence && !hasAllowedExternalBrowserBlocker(result) && !hasRealBlocker) {
      return {
        ...fallback,
        reason: "Finish rejection cap reached, but SCS still cannot allow completion without concrete evidence for an evidence-bearing task.",
      };
    }
    return {
      ...fallback,
      reason: "Finish rejection cap reached; allowing finish to prevent SCS deadlock.",
    };
  }

  const raw = await callJson(
    client,
    config,
    [
      {
        role: "system",
        content:
          "You are the SCS student final gate. Decide if the supervisor has enough concrete evidence to finish. Emit finish_allowed or finish_rejected only. Do not accept a supervisor finish claim merely because it sounds confident. Compare the approved plan, acceptance criteria, final answer, and evidence pack. For tasks involving files, code, shell commands, browser state, uploads, external services, generated artifacts, commits, or tests, require concrete tool/file/artifact/check evidence or a real external blocker. For pure explanatory or prose answers, allow finish when the answer directly satisfies the request. Tool stdout in recentMessages/recentEvents is raw command evidence and does not need to be duplicated in the final answer. Reject when requested observable state is missing, skipped, unverifiable, or contradicted by the evidence. Return strict JSON with keys: role, decision, confidence, evidence, reason, next_required_action.",
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
  if (decision.decision === "finish_allowed" && deterministicBlocker && !hasAllowedExternalBrowserBlocker(result)) {
    if (hasRealBlocker) return decision;
    return normalizeDecision(
      {
        ...deterministicBlocker,
        reason: `SCS deterministic evidence gate overrode finish approval: ${deterministicBlocker.reason}`,
      },
      "finish_rejected"
    );
  }
  return decision;
}
