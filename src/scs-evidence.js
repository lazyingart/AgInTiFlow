import { redactSensitiveText, redactValue } from "./redaction.js";

const CATEGORY_LABELS = {
  file: "file or workspace change",
  command: "command/check output",
  artifact: "durable artifact",
  browser: "browser or external UI state",
  git: "git/version-control action",
  publish: "publish/submit/deploy action",
  visual: "visual inspection or screenshot evidence",
};

const PROFILE_REQUIREMENTS = {
  code: ["file", "command"],
  codebase: ["file", "command"],
  "large-codebase": ["file", "command"],
  app: ["file", "command"],
  android: ["file", "command"],
  ios: ["file", "command"],
  java: ["file", "command"],
  node: ["file", "command"],
  python: ["file", "command"],
  go: ["file", "command"],
  rust: ["file", "command"],
  dotnet: ["file", "command"],
  ruby: ["file", "command"],
  "c-cpp": ["file", "command"],
  php: ["file", "command"],
  latex: ["file", "command", "artifact"],
  website: ["browser"],
  design: ["artifact", "visual"],
  image: ["artifact", "visual"],
  slides: ["artifact"],
  word: ["artifact"],
  data: ["file", "command", "artifact"],
  qa: ["command"],
  review: ["command"],
  devops: ["command"],
  maintenance: ["command"],
  database: ["file", "command"],
  github: ["git"],
  supervision: ["command"],
  pipeline: ["command", "artifact"],
  aaps: ["file", "command"],
};

function compact(value = "", limit = 700) {
  const text = redactSensitiveText(String(value || "").replace(/\s+/g, " ").trim());
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 18)).trimEnd()} ... [truncated]`;
}

function compactJson(value, limit = 900) {
  try {
    return compact(JSON.stringify(redactValue(value)), limit);
  } catch {
    return compact(String(value || ""), limit);
  }
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function blockerFromPayload(payload = {}, source = "tool") {
  if (!payload || typeof payload !== "object") return null;
  if (!payload.blocked && payload.ok !== false && !payload.permissionAdvice) return null;
  const toolName = String(payload.toolName || payload.name || "");
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const advice = payload.permissionAdvice && typeof payload.permissionAdvice === "object" ? payload.permissionAdvice : {};
  return {
    source,
    toolName,
    category: compact(payload.category || advice.category || "blocked-tool", 120),
    target: compact(payload.path || payload.outputPath || args.path || args.command || "", 240),
    reason: compact(payload.reason || payload.error || advice.reason || "Tool was blocked or requires approval.", 500),
    needsApproval: Boolean(payload.needsApproval || advice.needsApproval),
  };
}

function eventToBlocker(event = {}) {
  const type = String(event.type || "");
  const data = event.data && typeof event.data === "object" ? event.data : {};
  if (type === "tool.blocked" || type === "tool.failed") return blockerFromPayload(data, type);
  return null;
}

function messageToBlocker(message = {}) {
  if (message.role !== "tool") return null;
  try {
    return blockerFromPayload(JSON.parse(message.content || "{}"), "tool-message");
  } catch {
    return null;
  }
}

function textHas(text, regex) {
  return regex.test(String(text || ""));
}

function normalizedText(...parts) {
  return parts.map((part) => String(part || "")).join("\n").toLowerCase();
}

function goalRequiresEvidence(goal = "", taskProfile = "") {
  const text = normalizedText(goal, taskProfile);
  return (
    /\b(create|write|edit|patch|fix|repair|refactor|build|test|run|install|publish|submit|upload|download|copy|move|convert|remove|delete|commit|push|deploy|browser|chrome|cdp|playwright|selenium|artifact|file|video|image|pdf|docx|screenshot|compile|preview)\b/.test(
      text
    ) ||
    /创建|写入|编辑|修复|测试|运行|安装|发布|提交|上传|下载|复制|移动|转换|删除|浏览器|网页|文件|视频|图片|资产|生成|编译|截图/.test(text)
  );
}

function codeProfileRequiresCommand(goal = "") {
  const text = normalizedText(goal);
  const simpleDocumentWrite =
    /\b(?:note|notes?|markdown|readme|documentation|text file)\b/.test(text) ||
    /\bnotes?\/[^\s]+\.(?:md|txt)\b/.test(text) ||
    /\.(?:md|txt)\b/.test(text);
  const substantiveCodeWork =
    /\b(?:fix|repair|bug|implement|feature|refactor|test|run|build|compile|lint|typecheck|verify|validate|package|library|cli|api server|app|application|script|codebase|src\/|source code)\b/.test(
      text
    ) ||
    /\.(?:js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|hpp|sh)\b/.test(text);
  return substantiveCodeWork && !simpleDocumentWrite;
}

function profileRequirementsForGoal(taskProfile = "", goal = "") {
  const profile = String(taskProfile || "").toLowerCase();
  const defaults = PROFILE_REQUIREMENTS[profile] || [];
  if (!defaults.length) return [];
  const codeLikeProfiles = new Set([
    "code",
    "codebase",
    "large-codebase",
    "app",
    "android",
    "ios",
    "java",
    "node",
    "python",
    "go",
    "rust",
    "dotnet",
    "ruby",
    "c-cpp",
    "php",
    "aaps",
  ]);
  if (!codeLikeProfiles.has(profile)) return defaults;
  if (codeProfileRequiresCommand(goal)) return defaults;
  return defaults.filter((category) => category !== "command");
}

function inferRequirementCategories(goal = "", taskProfile = "", acceptanceCriteria = []) {
  const positiveGoal = stripForbiddenLanguage(goal);
  const text = normalizedText(positiveGoal);
  const profile = String(taskProfile || "").toLowerCase();
  const categories = new Set(
    goalRequiresEvidence(positiveGoal, "") ? profileRequirementsForGoal(taskProfile, positiveGoal) : []
  );

  if (
    textHas(
      text,
      /\b(file|path|workspace|edit|patch|fix|repair|refactor|convert|copy|move|remove|delete|source|script|code)\b|\.(?:md|txt|js|jsx|ts|tsx|mjs|cjs|json|ya?ml|py|tex|html|css|svg|csv)\b|\b(?:markdown|json|yaml|html|css|tex|latex)\s+file\b|\bfile\s+(?:as|in)\s+(?:markdown|json|yaml|html|css|tex|latex)\b/
    ) ||
    /文件|写入文件|编辑|修复|转换|复制|移动|删除|脚本|代码/.test(text)
  ) {
    categories.add("file");
  }
  if (
    textHas(
      text,
      /\b(run|command|check|lint|typecheck|build|compile|install|verify|validate|npm|node|python|pytest|make|xelatex|latexmk|ffmpeg)\b|\btest(?:ing)?\s+(?:the|this|that|it|app|site|code|function|workflow|script|build)\b/
    ) ||
    /运行|测试|检查|验证|编译|安装/.test(text)
  ) {
    categories.add("command");
  }
  if (textHas(text, /\b(artifact|canvas|pdf|image|video|screenshot|cover|plot|chart|figure|docx|archive|copy to|export|generated|generate|draft)\b/) || /输出|产物|图片|视频|截图|封面|生成/.test(text)) {
    categories.add("artifact");
  }
  if (textHas(text, /\b(browser|chrome|chromium|cdp|devtools|playwright|selenium|web[- ]?ui|website|page|tab|composer|click|type|upload|attach|submit|form)\b/) || /浏览器|网页|页面|上传|提交|附件|资产库|按钮/.test(text)) {
    categories.add("browser");
  }
  if (textHas(text, /\b(screenshot|visible|visual|see|inspect image|open image|read_image|thumbnail)\b/) || /截图|可见|缩略图/.test(text)) {
    categories.add("visual");
  }
  if (textHas(text, /\b(commit|push|pull request|pr|branch|merge|tag|release|git\s+(?:commit|push|pull|add|checkout|switch|branch|merge|tag))\b/) || /提交代码|推送|分支/.test(text)) {
    categories.add("git");
  }
  if (textHas(text, /\b(publish|deploy|submit|upload to|generate video|external service|npm publish|release)\b/) || /发布|部署|提交|生成视频|外部服务/.test(text)) {
    categories.add("publish");
  }

  if (profile === "review") {
    return [...categories].filter((category) => ["command", "git"].includes(category));
  }

  return [...categories];
}

function inferForbiddenActions(goal = "") {
  const text = String(goal || "");
  const forbidden = [];
  const patterns = [
    { re: /\b(do not|don't|dont|never|no need to|without)\s+([^.\n;]+)/gi, prefix: "User forbids" },
    { re: /不要([^。\n；]+)/g, prefix: "User forbids" },
    { re: /禁止([^。\n；]+)/g, prefix: "User forbids" },
  ];
  for (const { re, prefix } of patterns) {
    for (const match of text.matchAll(re)) {
      forbidden.push(`${prefix}: ${compact(match[2] || match[1], 160)}`);
    }
  }
  return unique(forbidden).slice(0, 8);
}

function stripForbiddenLanguage(goal = "") {
  return String(goal || "")
    .replace(/\b(do not|don't|dont|never|no need to|without)\s+([^.\n;]+)/gi, "")
    .replace(/不要([^。\n；]+)/g, "")
    .replace(/禁止([^。\n；]+)/g, "");
}

export function deriveScsTaskContract({ goal = "", taskProfile = "", acceptanceCriteria = [] } = {}) {
  const requirementCategories = inferRequirementCategories(goal, taskProfile, acceptanceCriteria);
  const requiresExternalEvidence = requirementCategories.length > 0 || goalRequiresEvidence(goal, taskProfile);
  const requiredEvidence = requirementCategories.map((category) => ({
    id: category,
    category,
    description: CATEGORY_LABELS[category] || category,
  }));
  return {
    version: 1,
    outcome: compact(goal || "Complete the requested task.", 500),
    taskProfile: String(taskProfile || "auto"),
    requiresExternalEvidence,
    requiredEvidence,
    forbiddenActions: inferForbiddenActions(goal),
    successCriteria: unique(acceptanceCriteria).slice(0, 10),
  };
}

function eventToEvidence(event = {}) {
  const type = String(event.type || "");
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const evidence = [];
  if (type === "file.changed") {
    evidence.push({
      category: "file",
      source: type,
      target: data.path || data.file || "",
      proof: "workspace file changed",
      verified: true,
    });
  }
  if (["canvas.item", "canvas.selected", "image.generated"].includes(type)) {
    evidence.push({
      category: "artifact",
      source: type,
      target: data.path || data.artifactId || data.outputPath || "",
      proof: type,
      verified: true,
    });
    if (type === "image.generated") {
      evidence.push({
        category: "visual",
        source: type,
        target: data.path || data.outputPath || "",
        proof: "image generation artifact",
        verified: true,
      });
    }
  }
  if (type === "tool.completed") {
    evidence.push(...toolPayloadToEvidence(data, type));
  }
  return evidence;
}

function toolPayloadToEvidence(payload = {}, source = "tool") {
  if (!payload || typeof payload !== "object" || payload.ok === false || payload.blocked) return [];
  const toolName = String(payload.toolName || payload.name || "");
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const text = normalizedText(
    toolName,
    args.command,
    payload.stdout,
    payload.stderr,
    payload.result,
    payload.path,
    payload.outputPath,
    payload.artifactPath
  );
  const evidence = [];
  const push = (category, proof, target = "") => {
    evidence.push({
      category,
      source,
      toolName,
      target: compact(target || payload.path || payload.outputPath || payload.artifactPath || args.path || args.command || payload.url || "", 260),
      proof: compact(proof, 500),
      verified: payload.ok !== false,
    });
  };

  if (["write_file", "apply_patch"].includes(toolName) || payload.path || Array.isArray(payload.changes)) {
    push("file", `${toolName || "tool"} produced file/workspace evidence`, payload.path || args.path || "");
  }
  if (toolName === "run_command" || payload.stdout || Number.isInteger(payload.exitCode)) {
    push("command", `exit=${payload.exitCode ?? 0} stdout=${compact(payload.stdout || "", 260)}`, args.command || "");
  }
  if (["open_url", "click", "type", "scroll", "press", "back"].includes(toolName) || /\b(browser|chrome|cdp|playwright|selenium|upload|attach|submit|click|tab|page)\b/.test(text)) {
    push("browser", `${toolName || "browser tool"} affected or inspected browser/UI state`, payload.url || args.url || args.command || "");
  }
  if (
    ["open_workspace_file", "preview_workspace", "send_to_canvas", "generate_image", "read_image", "writing_specialist", "json_specialist", "json_specialist_batch"].includes(
      toolName
    ) ||
    payload.artifactId ||
    payload.outputPath ||
    payload.artifactPath ||
    /\b(pdf|png|jpg|jpeg|image|video|screenshot|artifact|preview)\b/.test(text)
  ) {
    push("artifact", `${toolName || "tool"} produced or inspected an artifact`, payload.path || payload.outputPath || payload.artifactPath || args.path || "");
  }
  if (["read_image", "generate_image"].includes(toolName) || /\b(screenshot|visible|thumbnail|preview|image)\b/.test(text)) {
    push("visual", `${toolName || "tool"} supplied visual evidence`, payload.path || payload.outputPath || args.path || "");
  }
  if (/\bgit\s+(commit|push|status|diff|show|log|add)\b/.test(text)) {
    push("git", `git command evidence: ${compact(payload.stdout || args.command || "", 260)}`, args.command || "");
  }
  if (/\b(npm publish|publish|deploy|submit|generate video|uploaded|submitted)\b/.test(text) || /发布|部署|提交|生成视频/.test(text)) {
    push("publish", `publish/submit evidence: ${compact(payload.stdout || payload.result || args.command || "", 260)}`, args.command || "");
  }
  return evidence;
}

function messageToEvidence(message = {}) {
  if (message.role !== "tool") return [];
  try {
    return toolPayloadToEvidence(JSON.parse(message.content || "{}"), "tool-message");
  } catch {
    return [];
  }
}

export function buildScsEvidenceLedger({ state = {}, context = {} } = {}) {
  const events = Array.isArray(context.events) ? context.events : [];
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const eventEvidence = events.flatMap(eventToEvidence);
  const messageEvidence = messages.flatMap(messageToEvidence);
  const items = [...eventEvidence, ...messageEvidence].slice(-80);
  const categories = unique(items.map((item) => item.category));
  const blockers = [...events.map(eventToBlocker), ...messages.map(messageToBlocker)]
    .filter(Boolean)
    .slice(-20)
    .map((item, index) => ({
      id: `b${String(index + 1).padStart(3, "0")}`,
      ...item,
    }));
  return {
    version: 1,
    itemCount: items.length,
    categories,
    blockerCount: blockers.length,
    blockers,
    items: items.map((item, index) => ({
      id: `e${String(index + 1).padStart(3, "0")}`,
      ...item,
    })),
  };
}

export function evaluateScsEvidence(contract = {}, ledger = {}) {
  const required = Array.isArray(contract.requiredEvidence) ? contract.requiredEvidence : [];
  const ledgerCategories = new Set(Array.isArray(ledger.categories) ? ledger.categories : []);
  const satisfied = [];
  const missing = [];
  for (const requirement of required) {
    if (ledgerCategories.has(requirement.category)) {
      satisfied.push(requirement);
    } else {
      missing.push(requirement);
    }
  }
  const hasAnyEvidence = Number(ledger.itemCount || 0) > 0;
  const ok = !contract.requiresExternalEvidence || (missing.length === 0 && hasAnyEvidence);
  return {
    ok,
    requiresExternalEvidence: Boolean(contract.requiresExternalEvidence),
    hasAnyEvidence,
    satisfied,
    missing,
    reason: ok
      ? "Evidence satisfies the deterministic task contract."
      : missing.length
        ? `Missing evidence categories: ${missing.map((item) => item.category).join(", ")}.`
        : "Task requires external evidence but the ledger is empty.",
  };
}

export function summarizeScsContractEvidence({ contract = {}, ledger = {}, evaluation = {} } = {}) {
  return {
    contract: {
      outcome: contract.outcome || "",
      taskProfile: contract.taskProfile || "",
      requiresExternalEvidence: Boolean(contract.requiresExternalEvidence),
      requiredEvidence: (contract.requiredEvidence || []).map((item) => ({
        id: item.id,
        category: item.category,
        description: item.description,
      })),
      forbiddenActions: contract.forbiddenActions || [],
      successCriteria: contract.successCriteria || [],
    },
    evidenceLedger: {
      itemCount: ledger.itemCount || 0,
      categories: ledger.categories || [],
      recentItems: (ledger.items || []).slice(-12).map((item) => ({
        id: item.id,
        category: item.category,
        source: item.source,
        toolName: item.toolName || "",
        target: item.target || "",
        proof: compact(item.proof || "", 300),
      })),
      blockers: (ledger.blockers || []).slice(-8).map((item) => ({
        id: item.id,
        source: item.source,
        toolName: item.toolName || "",
        category: item.category || "",
        target: item.target || "",
        reason: compact(item.reason || "", 300),
        needsApproval: Boolean(item.needsApproval),
      })),
    },
    evaluation: {
      ok: Boolean(evaluation.ok),
      reason: evaluation.reason || "",
      missing: (evaluation.missing || []).map((item) => item.category),
      satisfied: (evaluation.satisfied || []).map((item) => item.category),
    },
  };
}

export function finishResultClaimsBlocker(result = "") {
  return /blocked|guardrail|permission|approval|denied|forbidden|cannot|can't|unable|requires|needs approval|need approval|quota|usage limit|rate limit|login|credential|api key|missing key|captcha|external blocker|policy/i.test(
    String(result || "")
  );
}

export function hasScsBlockerEvidence(ledger = {}) {
  return Number(ledger.blockerCount || 0) > 0 || (Array.isArray(ledger.blockers) && ledger.blockers.length > 0);
}

export function deterministicFinishBlocker(contract = {}, ledger = {}, evaluation = {}) {
  if (!contract.requiresExternalEvidence || evaluation.ok) return null;
  return {
    decision: "finish_rejected",
    confidence: 0.9,
    reason: evaluation.reason || "Required evidence is missing.",
    evidence: [
      `Required: ${(contract.requiredEvidence || []).map((item) => item.category).join(", ") || "external evidence"}`,
      `Present: ${(ledger.categories || []).join(", ") || "none"}`,
    ],
    nextRequiredAction:
      "Collect the missing concrete evidence, verify the requested state or artifact, then ask SCS to finish again; if impossible, report a real blocker with proof.",
  };
}
