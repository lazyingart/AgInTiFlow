import fs from "node:fs";
import path from "node:path";
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

function uniqueLimited(items = [], limit = 16) {
  return unique(items.map((item) => compact(item, 120)).filter(Boolean)).slice(0, limit);
}

function quotedTerms(text = "") {
  const terms = [];
  const patterns = [
    /“([^”]{1,80})”/g,
    /"([^"\n]{1,80})"/g,
    /'([^'\n]{1,80})'/g,
    /`([^`\n]{1,80})`/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(text || "").matchAll(pattern)) {
      const term = String(match[1] || "").trim();
      if (!term || /[\\/]/.test(term)) continue;
      terms.push(term);
    }
  }
  return terms;
}

function splitInlineTerms(text = "") {
  return String(text || "")
    .split(/[、,，;；]/)
    .map((item) => item.replace(/[。.!！?？:：]/g, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 40 && !/[\\/"'“”‘’`]/.test(item));
}

function trimForbiddenTail(tail = "") {
  let text = String(tail || "").trim();
  if (!text) return "";
  const stopPatterns = [
    /(?:^|[，,、\s])(?:并|且)?(?:末尾|最后|最後|保存|存到|写入|寫入|输出|輸出|完成后|完成後|运行|执行|執行|用命令|检查|檢查|验证|驗證|确认|確認|保留)/,
    /(?:^|[,\s])(?:and\s+)?(?:then|save|write|output|run|execute|check|verify|confirm|after)\b/i,
  ];
  const stops = stopPatterns.map((pattern) => text.search(pattern)).filter((index) => index >= 0);
  if (stops.length) text = text.slice(0, Math.min(...stops)).trim();
  return text.replace(/[，,、;；:\s]+$/g, "").trim();
}

function forbiddenTails(text = "") {
  const tails = [];
  const source = String(text || "");
  const patterns = [
    /(?:不要(?:写|寫)成|不得(?:写|寫)成|禁止(?:写|寫)成)\s*([^，,。；;\n]+)/g,
    /(?:(?:不要|不得|禁止)(?:(?:写|寫)(?!成)|包含|提到)|(?:确认|確認)[^。；;\n]{0,40}?(?:没有|沒有))\s*([^。；;\n]+)/g,
    /\b(?:do not|don't|dont|must not|never)\s+(?:write|include|mention|contain)\s+([^.\n;]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const tail = trimForbiddenTail(match[1] || "");
      if (tail) tails.push(tail);
    }
  }
  return tails;
}

function inferExactOutputPaths(goal = "") {
  const paths = [];
  const lines = String(goal || "").split(/\n/);
  const extensionPattern = "md|txt|json|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx";
  const quotedPathPattern = new RegExp("[\"'`]([^\"'`\\n]{1,220}\\.(?:" + extensionPattern + "))[\"'`]", "gi");
  const pathPattern = new RegExp(
    '(?:^|[\\s：:])((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,220}\\.(?:' +
      extensionPattern +
      '))(?:$|[\\s"\'`,，。；;.!?！？])',
    "gi"
  );
  const directOutputAction =
    /\b(save|saved|write|written|output|create|store|update|modify|edit)\b|保存|写入|寫入|输出|輸出|创建|建立|更新|修改|编辑|編輯/i;
  const outputListHeader =
    /^(?:#+\s*)?(?:create|created files?|files? to create|outputs?|output structure|required outputs?|artifacts?|generated files?|writer requirements|renderer requirements|生成文件|输出结构|輸出結構|输出文件|輸出文件|创建文件|建立文件)\s*[：:]\s*$/i;
  const nonOutputToolLine =
    /\b(?:validate|verify|check|compile|run|execute)\s+(?:(?:with|using)\s+)?[`"']?[^`"'\n]*\.(?:md|txt|json|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx)\b/i;
  const negatedOutputLine =
    /\b(?:do not|don't|dont|never|not)\b[^.\n]*(?:output|artifact|create|write|save|store|update|modify|edit)\b|\b(?:do not|don't|dont|never|not)\b[^.\n]*(?:treat|count|consider)\b/i;
  let inOutputList = false;
  let outputListPending = false;
  const pushPath = (raw = "") => {
    const cleaned = String(raw || "").trim();
    if (!cleaned || /[{}]/.test(cleaned)) return;
    paths.push(cleaned);
  };
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) {
      if (inOutputList) inOutputList = false;
      continue;
    }
    if (/^#+\s+/.test(line) && !outputListHeader.test(line)) {
      inOutputList = false;
      outputListPending = false;
    }
    if (outputListHeader.test(line)) {
      outputListPending = true;
      inOutputList = false;
      continue;
    }
    const isListItem = /^\s*(?:[-*]|\d+[.)])\s+/.test(rawLine);
    const isOutputListItem = (inOutputList || outputListPending) && isListItem;
    if (isOutputListItem) {
      inOutputList = true;
      outputListPending = false;
    } else if (outputListPending) {
      outputListPending = false;
    }
    const hasDirectOutputAction = directOutputAction.test(line);
    if (!isOutputListItem && !hasDirectOutputAction) continue;
    if (!isOutputListItem && negatedOutputLine.test(line)) continue;
    if (!isOutputListItem && nonOutputToolLine.test(line)) continue;
    quotedPathPattern.lastIndex = 0;
    for (const match of line.matchAll(quotedPathPattern)) {
      pushPath(match[1]);
    }
    const unquotedLine = line.replace(quotedPathPattern, (match) => " ".repeat(match.length));
    pathPattern.lastIndex = 0;
    for (const match of unquotedLine.matchAll(pathPattern)) {
      pushPath(match[1]);
    }
  }
  return uniqueLimited(paths, 16);
}

function stripForbiddenTextClauses(text = "") {
  return String(text || "")
    .replace(/(?:不要(?:写|寫)成|不得(?:写|寫)成|禁止(?:写|寫)成)\s*[^，,。；;\n]+/g, "")
    .replace(/(?:(?:不要|不得|禁止)(?:(?:写|寫)(?!成)|包含|提到)|(?:确认|確認)[^。；;\n]{0,40}?(?:没有|沒有))\s*[^。；;\n]+/g, "")
    .replace(/\b(?:do not|don't|dont|must not|never)\s+(?:write|include|mention|contain)\s+[^.\n;]+/gi, "");
}

function inferRequiredTextTerms(goal = "") {
  const terms = [];
  const lines = String(goal || "").split(/\n+/);
  for (const line of lines) {
    const positiveSegment = String(line || "").split(
      /(?:并)?确认没有|(?:并)?確認沒有|没有|沒有|\b(?:does not contain|do not contain|not contain|not include|without)\b/i
    )[0];
    const requiredSegment = stripForbiddenTextClauses(positiveSegment);
    if (
      /\b(must|require|required|include|contain|contains|check|verify|grep|keyword|keywords|preserve|keep|retain|appear)\b/i.test(line) ||
      /必须|必須|要求|包含|保留|出现|出現|精确字符串|精確字符串|明确出现|明確出現|检查|檢查|验证|驗證|关键词|關鍵詞|自检|自檢/.test(line)
    ) {
      terms.push(...quotedTerms(requiredSegment));
    }
  }
  return uniqueLimited(terms, 24);
}

function inferForbiddenTextTerms(goal = "") {
  const terms = [];
  const lines = String(goal || "").split(/\n+/);
  for (const line of lines) {
    for (const tail of forbiddenTails(line)) {
      terms.push(...quotedTerms(tail));
      const unquotedTail = tail.replace(/“[^”]+”|"[^"\n]+"|'[^'\n]+'|`[^`\n]+`/g, "");
      terms.push(...splitInlineTerms(unquotedTail).filter((item) => !/^(and|or|the|a|an|other|其他|上一集道具)$/.test(item)));
    }
  }
  return uniqueLimited(terms, 16);
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
  if (textHas(text, /\b(browser|chrome|chromium|cdp|devtools|playwright|selenium|web[- ]?ui|website|page|tab|composer|click|type|upload|attach|submit|form)\b/) || /浏览器|网页|页面|上传|提交|附件|资产库/.test(text)) {
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
  const isAction = (value = "") =>
    /\b(use|open|click|browse|browser|upload|attach|submit|publish|deploy|run|execute|install|delete|remove|commit|push|call|api)\b/i.test(
      value
    ) || /浏览器|网页|打开|点击|上传|提交|发布|部署|运行|执行|安装|删除|复制|移动|提交代码|推送|调用|API/.test(value);
  const patterns = [
    { re: /\b(do not|don't|dont|never|no need to|without)\s+([^.\n;]+)/gi, prefix: "User forbids" },
    { re: /不要([^。\n；]+)/g, prefix: "User forbids" },
    { re: /禁止([^。\n；]+)/g, prefix: "User forbids" },
  ];
  for (const { re, prefix } of patterns) {
    for (const match of text.matchAll(re)) {
      const value = compact(match[2] || match[1], 160);
      if (isAction(value)) forbidden.push(`${prefix}: ${value}`);
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
    exactOutputPaths: inferExactOutputPaths(goal),
    requiredTextTerms: inferRequiredTextTerms(goal),
    forbiddenTextTerms: inferForbiddenTextTerms(goal),
    successCriteria: unique(acceptanceCriteria).slice(0, 10),
  };
}

function resolveContractPath(commandCwd = process.cwd(), rawPath = "") {
  const text = String(rawPath || "").trim();
  if (!text) return "";
  if (text.startsWith("~/")) return path.join(process.env.HOME || commandCwd, text.slice(2));
  if (text === "/workspace") return path.resolve(commandCwd || process.cwd());
  if (text.startsWith("/workspace/")) return path.resolve(commandCwd || process.cwd(), text.slice("/workspace/".length));
  if (path.isAbsolute(text)) return text;
  return path.resolve(commandCwd || process.cwd(), text);
}

export function evaluateScsSemanticContract(contract = {}, { commandCwd = process.cwd() } = {}) {
  const exactOutputPaths = Array.isArray(contract.exactOutputPaths) ? contract.exactOutputPaths : [];
  const requiredTextTerms = Array.isArray(contract.requiredTextTerms) ? contract.requiredTextTerms : [];
  const forbiddenTextTerms = Array.isArray(contract.forbiddenTextTerms) ? contract.forbiddenTextTerms : [];
  if (!exactOutputPaths.length && !requiredTextTerms.length && !forbiddenTextTerms.length) {
    return { ok: true, checked: false, reason: "No semantic file contract was inferred." };
  }
  if (!exactOutputPaths.length) {
    return {
      ok: true,
      checked: false,
      reason: "Semantic text terms were inferred, but no exact output path was inferred for deterministic file inspection.",
      requiredTextTerms,
      forbiddenTextTerms,
    };
  }

  const files = exactOutputPaths.map((rawPath) => {
    const absolutePath = resolveContractPath(commandCwd, rawPath);
    try {
      const content = fs.readFileSync(absolutePath, "utf8");
      return { rawPath, absolutePath, exists: true, content };
    } catch {
      return { rawPath, absolutePath, exists: false, content: "" };
    }
  });
  const missingFiles = files.filter((file) => !file.exists).map((file) => file.rawPath);
  const combinedContent = files.map((file) => file.content).join("\n");
  const missingRequiredText = requiredTextTerms.filter((term) => !combinedContent.includes(term));
  const presentForbiddenText = forbiddenTextTerms.filter((term) => combinedContent.includes(term));
  const ok = missingFiles.length === 0 && missingRequiredText.length === 0 && presentForbiddenText.length === 0;
  return {
    ok,
    checked: true,
    exactOutputPaths,
    requiredTextTerms,
    forbiddenTextTerms,
    missingFiles,
    missingRequiredText,
    presentForbiddenText,
    inspectedFiles: files.map((file) => ({
      path: file.rawPath,
      exists: file.exists,
      chars: file.content.length,
    })),
    reason: ok
      ? "Exact output files satisfy inferred semantic hard constraints."
      : [
          missingFiles.length ? `Missing exact output files: ${missingFiles.join(", ")}` : "",
          missingRequiredText.length ? `Missing required text terms: ${missingRequiredText.join(", ")}` : "",
          presentForbiddenText.length ? `Forbidden text terms present: ${presentForbiddenText.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; "),
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
      exactOutputPaths: contract.exactOutputPaths || [],
      requiredTextTerms: contract.requiredTextTerms || [],
      forbiddenTextTerms: contract.forbiddenTextTerms || [],
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
