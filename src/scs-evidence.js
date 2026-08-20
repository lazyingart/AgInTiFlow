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
    '(?:^|[\\s：:,，、])((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,220}\\.(?:' +
      extensionPattern +
      '))(?=$|[\\s"\'`,，、。；;.!?！？])',
    "gi"
  );
  const directOutputAction =
    /\b(save|saved|write|written|output|create|store|update|modify|edit)\b|保存|写入|寫入|输出|輸出|创建|建立|更新|修改|编辑|編輯/i;
  const directOutputActionGlobal =
    /\b(save|saved|write|written|output|create|store|update|modify|edit)\b|保存|写入|寫入|输出|輸出|创建|建立|更新|修改|编辑|編輯/gi;
  const outputListHeader =
    /^(?:#+\s*)?(?:(?:required|final|expected|declared|target|pilot|deliverable)\s+)*(?:create|created files?|files? to create|outputs?|output structure|required outputs?|artifacts?|deliverables?|generated files?|writer requirements|renderer requirements|生成文件|输出结构|輸出結構|输出文件|輸出文件|创建文件|建立文件)(?:\s+(?:outputs?|artifacts?|deliverables?))?\s*[：:]?\s*$/i;
  const nonOutputToolLine =
    /\b(?:validate|verify|check|compile|run|execute)\s+(?:(?:with|using)\s+)?[`"']?[^`"'\n]*\.(?:md|txt|json|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx)\b/i;
  const negatedOutputLine =
    /\b(?:do not|don't|dont|never|not)\b[^.\n]*(?:output|artifact|create|write|save|store|update|modify|edit)\b|\b(?:do not|don't|dont|never|not)\b[^.\n]*(?:treat|count|consider)\b/i;
  let inOutputList = false;
  let outputListPending = false;
  let activeOutputDir = "";
  const pushPath = (raw = "") => {
    let cleaned = String(raw || "").trim();
    if (!cleaned || /[{}]/.test(cleaned)) return;
    if (activeOutputDir && !/[\\/]/.test(cleaned)) cleaned = `${activeOutputDir}${cleaned}`;
    paths.push(cleaned);
  };
  const filterShadowedBasenames = (items = []) => {
    const basenamesWithDirectory = new Set(
      items
        .filter((item) => /[\\/]/.test(item))
        .map((item) => String(item).split(/[\\/]/).filter(Boolean).pop())
        .filter(Boolean)
    );
    return items.filter((item) => /[\\/]/.test(item) || !basenamesWithDirectory.has(item));
  };
  const outputActionIndex = (text = "") => {
    const source = String(text || "");
    directOutputActionGlobal.lastIndex = 0;
    const matches = [...source.matchAll(directOutputActionGlobal)];
    for (const match of matches) {
      const slice = source.slice(match.index, match.index + 120);
      if (/(?:to|at|in|under|到|至|在)\s*[^\s，,、；;。]*[/.]/i.test(slice)) return match.index;
    }
    return matches[0]?.index ?? -1;
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
    const directOutputIndex = outputActionIndex(line);
    const hasDirectOutputAction = directOutputIndex >= 0;
    if (!isOutputListItem && !hasDirectOutputAction) continue;
    const sourceLine = !isOutputListItem && hasDirectOutputAction ? line.slice(directOutputIndex) : line;
    if (!isOutputListItem && negatedOutputLine.test(sourceLine)) continue;
    if (!isOutputListItem && nonOutputToolLine.test(sourceLine)) continue;
    if (!isOutputListItem && /\boutput\s+(?:subfolders?|directories|folders?|paths?)\b/i.test(sourceLine)) continue;
    const outputDirMatch = sourceLine.match(/(?:to|at|in|under|到|至|在)\s*([^\s，,、；;。]+\/)/i);
    activeOutputDir = outputDirMatch?.[1] || "";
    quotedPathPattern.lastIndex = 0;
    for (const match of sourceLine.matchAll(quotedPathPattern)) {
      pushPath(match[1]);
    }
    const unquotedLine = sourceLine.replace(quotedPathPattern, (match) => " ".repeat(match.length));
    pathPattern.lastIndex = 0;
    for (const match of unquotedLine.matchAll(pathPattern)) {
      pushPath(match[1]);
    }
    activeOutputDir = "";
  }
  return uniqueLimited(filterShadowedBasenames(paths), 16);
}

function inferExactInputPaths(goal = "") {
  const paths = [];
  const lines = String(goal || "").split(/\n/);
  const extensionPattern = "md|txt|json|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx";
  const quotedPathPattern = new RegExp("[\"'`]([^\"'`\\n]{1,260}\\.(?:" + extensionPattern + "))[\"'`]", "gi");
  const pathPattern = new RegExp(
    '(?:^|[\\s：:,，、])((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,260}\\.(?:' +
      extensionPattern +
      '))(?=$|[\\s"\'`,，、。；;.!?！？])',
    "gi"
  );
  const inputAction =
    /\b(use|using|read|load|fill|upload|attach|import|select|choose|reference|input|from)\b|使用|读取|讀取|加载|載入|填写|填入|上传|上傳|附加|导入|導入|选择|選擇|选取|選取|参考|參考|素材|图片|圖片|照片|提示词|提示詞|从|從/i;
  const directOutputAction =
    /\b(save|saved|write|written|output|create|store|update|modify|edit)\b|保存|写入|寫入|输出|輸出|创建|建立|更新|修改|编辑|編輯/i;
  const pushPath = (raw = "") => {
    const cleaned = String(raw || "").trim();
    if (!cleaned || /[{}]/.test(cleaned)) return;
    paths.push(cleaned);
  };
  for (const rawLine of lines) {
    const fullLine = String(rawLine || "").trim();
    const outputIndex = fullLine.search(directOutputAction);
    const line = outputIndex > 0 ? fullLine.slice(0, outputIndex).trim() : fullLine;
    if (!line || !inputAction.test(line)) continue;
    if (directOutputAction.test(line) && !/\b(read|load|upload|attach|reference|input|from)\b|读取|讀取|加载|載入|上传|上傳|附加|参考|參考|素材|图片|圖片|照片|提示词|提示詞|从|從/i.test(line)) {
      continue;
    }
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
  return uniqueLimited(paths, 24);
}

function inferDeclaredSourceRoots(goal = "") {
  const roots = [];
  for (const match of String(goal || "").matchAll(/`([^`\n]{1,280})`/g)) {
    const candidate = String(match[1] || "").trim();
    if (
      /^(?:~\/|\.{1,2}\/|\/)[^\s]+$/.test(candidate) &&
      !/\.(?:md|txt|json|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx)$/i.test(candidate)
    ) {
      roots.push(candidate.replace(/\/+$/, ""));
    }
  }
  return uniqueLimited(roots, 12);
}

function requiresPerSourceChecks(goal = "") {
  const text = String(goal || "");
  return (
    /\b(?:run|execute)\b[^.\n;]{0,100}\b(?:help|status|doctor|read[- ]only)\b[^.\n;]{0,100}\b(?:checks?|commands?)\b/i.test(text) ||
    /\b(?:help|status|doctor|read[- ]only)\b[^.\n;]{0,100}\b(?:checks?|commands?)\b[^.\n;]{0,100}\b(?:where available|for each|per (?:stage|source|repository|repo))\b/i.test(text) ||
    /(?:运行|執行)[^。\n；]{0,100}(?:帮助|幫助|状态|狀態|只读|唯讀)[^。\n；]{0,100}(?:检查|檢查|命令)/.test(text)
  );
}

function stripForbiddenTextClauses(text = "") {
  return String(text || "")
    .replace(/(?:不要(?:写|寫)成|不得(?:写|寫)成|禁止(?:写|寫)成)\s*[^，,。；;\n]+/g, "")
    .replace(/(?:(?:不要|不得|禁止)(?:(?:写|寫)(?!成)|包含|提到)|(?:确认|確認)[^。；;\n]{0,40}?(?:没有|沒有))\s*[^。；;\n]+/g, "")
    .replace(/\b(?:do not|don't|dont|must not|never)\s+(?:write|include|mention|contain)\s+[^.\n;]+/gi, "");
}

function inferRequiredTextTerms(goal = "") {
  const terms = [];
  const outputPaths = inferExactOutputPaths(goal);
  const outputPathTerms = new Set(
    outputPaths.flatMap((item) => [String(item).trim(), path.basename(String(item).trim())]).filter(Boolean)
  );
  const lines = String(goal || "").split(/\n+/);
  for (const line of lines) {
    const positiveSegment = String(line || "").split(
      /(?:并)?确认没有|(?:并)?確認沒有|没有|沒有|\b(?:does not contain|do not contain|not contain|not include|without)\b/i
    )[0];
    const requiredSegment = stripForbiddenLanguage(stripForbiddenTextClauses(positiveSegment));
    if (
      /\b(must|require|required|include|contain|contains|check|verify|grep|keyword|keywords|preserve|keep|retain|appear)\b/i.test(requiredSegment) ||
      /必须|必須|要求|包含|保留|出现|出現|精确字符串|精確字符串|明确出现|明確出現|检查|檢查|验证|驗證|关键词|關鍵詞|自检|自檢/.test(requiredSegment)
    ) {
      terms.push(...quotedTerms(requiredSegment));
    }
  }
  // A quoted filename in "save as `report.md`" is an output location, not
  // required prose inside that report. Path existence is validated separately.
  return uniqueLimited(terms.filter((term) => !outputPathTerms.has(String(term).trim())), 24);
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
  const category = String(payload.category || advice.category || "blocked-tool");
  const code = String(payload.code || "");
  if (
    payload.recoverable === true ||
    advice.autoRecover === true ||
    ["tool-contract-violation", "repeated-read-only-call", "static-discovery-limit"].includes(category) ||
    ["TOO_MANY_TOOL_CALLS", "MALFORMED_TOOL_ARGUMENTS"].includes(code)
  ) {
    return null;
  }
  return {
    source,
    toolName,
    category: compact(category, 120),
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

function isReadOnlyReadinessTask(goal = "") {
  const text = String(goal || "");
  const readinessSignal =
    /\b(?:inspect|audit|assess|document|report on|verify)\s+(?:whether|if|the\s+(?:current\s+)?(?:readiness|capability|workflow|interface))\b/i.test(text) ||
    /\b(?:readiness|capability)\s+(?:audit|check|report|assessment)\b/i.test(text) ||
    /\bwhether\s+(?:i|we|the\s+(?:agent|system))\s+can\b/i.test(text) ||
    /只读检查|只讀檢查|就绪检查|就緒檢查|能力检查|能力檢查|检查是否|檢查是否/.test(text);
  const noActionSignal =
    /\b(?:do not|don't|dont|never|without)\b[^.\n;]{0,260}\b(?:generate|submit|upload|publish|deploy|log in|login|restart|edit|modify|delete|purchase|pay)\b/i.test(text) ||
    /(?:不要|禁止)[^。\n；]{0,260}(?:生成|提交|上传|上傳|发布|發布|部署|登录|登入|重启|重啟|编辑|編輯|修改|删除|刪除|购买|購買|支付)/.test(text);
  return readinessSignal && noActionSignal;
}

function requiresSourceGrounding(goal = "") {
  const text = String(goal || "");
  return (
    isReadOnlyReadinessTask(text) ||
    /\b(?:exact|current|mature|proven|verified|source[- ]grounded|documented)\b[^.\n;]{0,120}\b(?:commands?|interfaces?|workflows?|routines?|readiness|capabilit(?:y|ies))\b/i.test(
      text
    ) ||
    /\b(?:verify|inspect|audit|check)\b[^.\n;]{0,120}\b(?:rather than guess|without guessing|from (?:the )?(?:source|docs?|help))\b/i.test(
      text
    ) ||
    (/准确|精确|当前|成熟|已验证|有依据|不要猜|避免猜测/.test(text) && /命令|接口|流程|例程|就绪|能力/.test(text))
  );
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
  const directCommandSignal =
    textHas(
      text,
      /\b(run|command|lint|typecheck|build|compile|install|npm|node|python|pytest|make|xelatex|latexmk|ffmpeg)\b|\btest(?:ing)?\s+(?:the|this|that|it|app|site|code|function|workflow|script|build)\b/
    ) || /运行|测试|编译|安装/.test(text);
  const validationSignal = textHas(text, /\b(check|verify|validate)\b/) || /检查|验证/.test(text);
  // A generic "verify outputs" reminder on a simple document/file request is
  // satisfied by the file + semantic evidence checks below. Requiring a shell
  // command as well makes permission-resumed writes repeat an already-successful
  // create. Substantive code validation still requires command evidence.
  if (directCommandSignal || (validationSignal && codeProfileRequiresCommand(positiveGoal))) {
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

  if (isReadOnlyReadinessTask(goal)) {
    categories.delete("publish");
    categories.delete("browser");
    categories.delete("visual");
    categories.delete("git");
    const concreteArtifactOutput = inferExactOutputPaths(goal).some((item) =>
      /\.(?:pdf|docx|pptx|xlsx|png|jpe?g|webp|svg|mp4|mov|zip|7z)$/i.test(item)
    );
    if (!concreteArtifactOutput) categories.delete("artifact");
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

function inferRequiredToolCalls(goal = "") {
  const source = stripForbiddenLanguage(String(goal || ""));
  const knownTools = [
    "writing_specialist",
    "json_specialist",
    "read_image",
    "generate_image",
    "send_to_canvas",
    "start_long_job",
    "long_job_status",
  ];
  const required = [];
  for (const toolName of knownTools) {
    const index = source.indexOf(toolName);
    if (index < 0) continue;
    const window = source.slice(Math.max(0, index - 90), Math.min(source.length, index + toolName.length + 90));
    const strongToolInstruction =
      /\b(?:must|explicitly|again|call|invoke|require(?:d|s)?\s+(?:tool|call|use))\b/i.test(window) ||
      /必须(?:调用|使用)|必須(?:調用|使用)|明确(?:调用|使用)|明確(?:調用|使用)|再次(?:调用|使用)|调用|調用/.test(window);
    const specialistUseInstruction = /_specialist$/.test(toolName) && (/\buse\b/i.test(window) || /使用/.test(window));
    if (strongToolInstruction || specialistUseInstruction) {
      required.push(toolName);
    }
  }
  return unique(required).slice(0, 8);
}

function stripForbiddenLanguage(goal = "") {
  return String(goal || "")
    .replace(/\b(do not|don't|dont|never|no need to|without)\s+([^.\n;]+)/gi, "")
    .replace(/不要([^。\n；]+)/g, "")
    .replace(/禁止([^。\n；]+)/g, "");
}

function scopedChatopsEvidenceGoal(goal = "", taskProfile = "") {
  const match = String(goal || "").match(/^AGINTI_EVIDENCE_SCOPE_JSON:\s*(\{[^\n]+\})\s*$/m);
  if (!match) {
    const text = String(goal || "");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const finalInstruction = lines.slice(-3).join(" ");
    const hasQuotedChatContext =
      /^(?:context|conversation|messages?|recent\s+messages?|chat\s+context)\s*:/im.test(text) ||
      /^(?:message|msg|turn)\s*\d*\s*:/im.test(text);
    const requestsResponseOnly =
      /\b(?:return|reply|respond|answer|classify|route|output|emit)\b/i.test(finalInstruction) &&
      /\b(?:exactly|only|json|object|classification|answer|response|no\s+prose)\b/i.test(finalInstruction);
    if (hasQuotedChatContext && requestsResponseOnly) {
      return "Answer or classify the supplied chat context directly without external execution.";
    }
    return text;
  }
  try {
    const payload = JSON.parse(match[1]);
    if (!payload || typeof payload !== "object") return String(goal || "");
    const mode = String(payload.mode || "").trim().toLowerCase();
    if (["chat-response", "host-managed-response", "plan-response", "read-only-answer"].includes(mode)) {
      return "Answer the current chat turn directly without external execution.";
    }
    const request = String(payload.request || "").trim();
    return request || String(goal || "");
  } catch {
    return String(goal || "");
  }
}

export function deriveScsTaskContract({ goal = "", taskProfile = "", acceptanceCriteria = [] } = {}) {
  const evidenceGoal = scopedChatopsEvidenceGoal(goal, taskProfile);
  const requirementCategories = inferRequirementCategories(evidenceGoal, taskProfile, acceptanceCriteria);
  const requiredToolCalls = inferRequiredToolCalls(evidenceGoal);
  const requiresExternalEvidence = requirementCategories.length > 0 || requiredToolCalls.length > 0 || goalRequiresEvidence(evidenceGoal, taskProfile);
  const requiredEvidence = requirementCategories.map((category) => ({
    id: category,
    category,
    description: CATEGORY_LABELS[category] || category,
  }));
  const exactOutputPaths = inferExactOutputPaths(evidenceGoal);
  const exactInputPaths = inferExactInputPaths(evidenceGoal).filter((item) => !exactOutputPaths.includes(item));
  const declaredSourceRoots = inferDeclaredSourceRoots(evidenceGoal);
  return {
    version: 1,
    outcome: compact(evidenceGoal || "Complete the requested task.", 500),
    taskProfile: String(taskProfile || "auto"),
    requiresExternalEvidence,
    requiredEvidence,
    forbiddenActions: inferForbiddenActions(evidenceGoal),
    exactOutputPaths,
    exactInputPaths,
    declaredSourceRoots,
    readOnlyReadiness: isReadOnlyReadinessTask(evidenceGoal),
    requiresPerSourceChecks: requiresPerSourceChecks(evidenceGoal),
    requiredToolCalls,
    requiresSourceGrounding: requiresSourceGrounding(evidenceGoal),
    requiredTextTerms: inferRequiredTextTerms(evidenceGoal),
    forbiddenTextTerms: inferForbiddenTextTerms(evidenceGoal),
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

const STANDARD_SHELL_COMMANDS = new Set([
  ".",
  "alias",
  "cat",
  "cd",
  "chmod",
  "cp",
  "echo",
  "eval",
  "exec",
  "export",
  "find",
  "head",
  "ls",
  "mkdir",
  "printf",
  "pwd",
  "return",
  "rg",
  "sed",
  "set",
  "shift",
  "source",
  "stat",
  "tail",
  "test",
  "trap",
  "umask",
  "unalias",
  "unset",
  "wc",
]);

const NON_COMMAND_FIRST_TOKENS = new Set([
  "complete",
  "completed",
  "done",
  "error",
  "failed",
  "failure",
  "info",
  "output",
  "processing",
  "ready",
  "result",
  "status",
  "success",
  "total",
  "warning",
]);

const SCRIPT_INTERPRETERS = new Set(["bash", "bun", "node", "python", "python3", "sh", "zsh"]);
const INLINE_COMMAND_EXECUTABLES = new Set([
  ...SCRIPT_INTERPRETERS,
  "conda",
  "curl",
  "deno",
  "ffmpeg",
  "git",
  "npm",
  "npx",
  "pdflatex",
  "pip",
  "pip3",
  "pnpm",
  "tmux",
  "wget",
  "yarn",
]);

function unquoteShellToken(value = "") {
  return String(value || "").replace(/^['"]|['"]$/g, "");
}

function shellCommandSegments(value = "") {
  const segments = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const source = String(value || "");
  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      flush();
      index += 1;
      continue;
    }
    if (character === ";" || character === "|") {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

function commandSubcommands(tokens = [], startIndex = 0, limit = 2) {
  const subcommands = [];
  for (let index = startIndex; index < tokens.length && subcommands.length < limit; index += 1) {
    const token = unquoteShellToken(tokens[index]);
    if (!token || token.startsWith("-")) break;
    if (
      /^[A-Z][A-Z0-9_-]*$/.test(token) ||
      token.startsWith("$") ||
      token.startsWith("<") ||
      token.includes("/") ||
      /\.[a-z0-9]{1,8}$/i.test(token) ||
      !/^[a-z0-9_-]+$/i.test(token)
    ) {
      break;
    }
    subcommands.push(token.toLowerCase());
  }
  return subcommands;
}

function shellLogicalLines(value = "") {
  const logical = [];
  let pending = "";
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    pending = `${pending}${pending ? " " : ""}${line.replace(/\\\s*$/, "")}`.trim();
    if (/\\\s*$/.test(line)) continue;
    logical.push(pending);
    pending = "";
  }
  if (pending) logical.push(pending);
  return logical;
}

const SUBSTANTIVE_RUNTIME_READ_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "rg",
  "sed",
  "stat",
  "tail",
  "test",
  "wc",
]);

function isSubstantiveRuntimeCheck(segment = "") {
  if (commandSignature(segment)) return true;
  const tokens = String(segment || "").trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  while (tokens.length && /^(?:sudo|env)$/i.test(tokens[0])) tokens.shift();
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (tokens.length < 2) return false;
  return SUBSTANTIVE_RUNTIME_READ_COMMANDS.has(unquoteShellToken(tokens[0]).toLowerCase());
}

function commandSignature(value = "") {
  let text = String(value || "")
    .trim()
    .replace(/^\s*(?:[-*]\s+|\$\s+|>\s+)/, "")
    .replace(/\s+/g, " ");
  if (!text || /^https?:\/\//i.test(text) || /^(?:output|result|status|path|file)\s*:/i.test(text)) return "";
  if (/(?:^|\s)(?:\.\.\.|…)(?:\s|$)/.test(text)) return "";
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  while (tokens.length && /^(?:sudo|env)$/i.test(tokens[0])) tokens.shift();
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return "";
  const firstRaw = unquoteShellToken(tokens[0]);
  const first = firstRaw.toLowerCase();
  if (
    firstRaw.startsWith("-") ||
    /^\d/.test(firstRaw) ||
    (!firstRaw.includes("/") && /\.[a-z0-9]{1,8}$/i.test(firstRaw)) ||
    !/^[./~a-z0-9_-]+$/i.test(first) ||
    STANDARD_SHELL_COMMANDS.has(first) ||
    NON_COMMAND_FIRST_TOKENS.has(first) ||
    (!firstRaw.includes("/") && /^[A-Z]/.test(firstRaw))
  ) {
    return "";
  }
  const second = unquoteShellToken(tokens[1]);
  if (!second) return "";
  if (second === "--help" || second === "-h") return `${first} ${second}`;
  if (SCRIPT_INTERPRETERS.has(first)) {
    if (["-c", "-e", "--eval"].includes(second)) return `${first} ${second}`;
    if (second === "-m") {
      const moduleName = unquoteShellToken(tokens[2]);
      return moduleName ? `${first} -m ${moduleName}`.toLowerCase() : "";
    }
    const scriptIndex = tokens.findIndex((token, index) => index > 0 && !String(token).startsWith("-"));
    if (scriptIndex < 1) return "";
    const script = unquoteShellToken(tokens[scriptIndex]);
    if (!script || script === "..." || !/^[./~a-z0-9_-]+$/i.test(script)) return "";
    const subcommands = commandSubcommands(tokens, scriptIndex + 1);
    return [first, script, ...subcommands].join(" ").toLowerCase();
  }
  if (first === "conda" && second === "run") {
    let innerIndex = 2;
    while (innerIndex < tokens.length) {
      const token = unquoteShellToken(tokens[innerIndex]);
      if (["-n", "--name", "-p", "--prefix"].includes(token)) {
        innerIndex += 2;
        continue;
      }
      if (token.startsWith("-")) {
        innerIndex += 1;
        continue;
      }
      break;
    }
    const inner = commandSignature(tokens.slice(innerIndex).join(" "));
    return inner ? `conda run ${inner}` : "conda run";
  }
  if (first === "deno" && second === "run") {
    const scriptIndex = tokens.findIndex((token, index) => index > 1 && !String(token).startsWith("-"));
    const script = scriptIndex > 1 ? unquoteShellToken(tokens[scriptIndex]) : "";
    const subcommands = script ? commandSubcommands(tokens, scriptIndex + 1) : [];
    return script ? [first, "run", script, ...subcommands].join(" ").toLowerCase() : `${first} run`;
  }
  if (["npm", "pnpm", "yarn"].includes(first) && ["run", "run-script"].includes(second)) {
    const script = unquoteShellToken(tokens[2]);
    return script && !script.startsWith("-") ? `${first} ${second} ${script}`.toLowerCase() : `${first} ${second}`;
  }
  if (second.startsWith("-")) return first;
  const subcommands = commandSubcommands(tokens, 1);
  return subcommands.length ? [first, ...subcommands].join(" ") : "";
}

function looksLikeInlineCommandSnippet(value = "") {
  const tokens = String(value || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length < 2) return false;
  const first = unquoteShellToken(tokens[0]).toLowerCase();
  if (INLINE_COMMAND_EXECUTABLES.has(first) || first.includes("/") || /\.(?:bash|c?js|mjs|py|sh)$/.test(first)) {
    return true;
  }
  return !unquoteShellToken(tokens[1]).startsWith("-") && Boolean(commandSignature(value));
}

function markdownCommandClaims(content = "") {
  const claims = [];
  const fencedRanges = [];
  const source = String(content || "");
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of source.matchAll(fencePattern)) {
    const language = String(match[1] || "").trim().toLowerCase();
    if (/^(?:bash|sh|shell|zsh)$/.test(language)) {
      claims.push(...shellLogicalLines(match[2]));
    } else if (/^(?:console|terminal)$/.test(language)) {
      claims.push(
        ...String(match[2] || "")
          .split(/\r?\n/)
          .filter((line) => /^\s*[$>]\s+/.test(line))
          .map((line) => line.replace(/^\s*[$>]\s+/, ""))
      );
    }
    fencedRanges.push([match.index, match.index + match[0].length]);
  }
  const outsideFences = [...source];
  for (const [start, end] of fencedRanges) outsideFences.fill(" ", start, end);
  for (const match of outsideFences.join("").matchAll(/`([^`\n]{2,300})`/g)) {
    const snippet = String(match[1] || "").trim();
    if (looksLikeInlineCommandSnippet(snippet)) claims.push(snippet);
  }
  const bySignature = new Map();
  for (const claim of claims) {
    for (const segment of shellCommandSegments(claim)) {
      const signature = commandSignature(segment);
      if (signature && !bySignature.has(signature)) bySignature.set(signature, { claim: segment, signature });
    }
  }
  return [...bySignature.values()];
}

export function extractMarkdownCommandEvidence(content = "", source = "", limit = 40) {
  return markdownCommandClaims(content)
    .slice(0, Math.max(1, Number(limit) || 40))
    .map((item) => ({
      signature: item.signature,
      command: String(item.claim || "").trim(),
      source: String(source || ""),
    }));
}

const PATH_CLAIM_EXTENSIONS = new Set([
  "3mf",
  "c",
  "cpp",
  "csv",
  "docx",
  "env",
  "h",
  "html",
  "ini",
  "jpeg",
  "jpg",
  "js",
  "json",
  "md",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "py",
  "sh",
  "step",
  "stl",
  "svg",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "wav",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

function cleanPathToken(value = "") {
  let token = unquoteShellToken(String(value || "").trim())
    .replace(/^[`([{]+/, "")
    .replace(/`+[.,;:]?$/, "")
    .replace(/[\])},:;]+$/, "")
    .trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) token = token.slice(token.indexOf("=") + 1);
  return unquoteShellToken(token).trim();
}

function looksLikePathClaim(value = "") {
  const token = cleanPathToken(value);
  if (
    !token ||
    token === "/" ||
    /^(?:\.{3}|…)(?:\/|$)/.test(token) ||
    /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z0-9_+.-]+$/.test(token) ||
    /(?:^|\/)\.{3}(?:\/|$)/.test(token) ||
    /[{}]/.test(token) ||
    /[*?]/.test(token) ||
    token.startsWith("-") ||
    /^https?:\/\//i.test(token) ||
    /^(?:[<>|&]|\$)$/.test(token)
  ) return false;
  if (/^(?:~\/|\.{1,2}\/|\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/)/.test(token)) return true;
  if (token.endsWith("/") && token.includes("/")) return true;
  const extension = token.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() || "";
  if (extension && PATH_CLAIM_EXTENSIONS.has(extension)) return true;
  if (/^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)+$/.test(token)) return false;
  return token.includes("/");
}

function pathClaimsFromSnippet(value = "") {
  const claims = [];
  const source = String(value || "").trim();
  if (!source) return claims;
  if (looksLikePathClaim(source) && !/\s/.test(source)) claims.push(cleanPathToken(source));
  const tokens = source.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const token of tokens) {
    const cleaned = cleanPathToken(token);
    if (looksLikePathClaim(cleaned)) claims.push(cleaned);
  }
  return claims;
}

function markdownPathClaims(content = "") {
  const source = String(content || "");
  const claims = [];
  for (const match of source.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) {
    claims.push(...pathClaimsFromSnippet(match[1]));
  }
  for (const match of source.matchAll(/`([^`\n]{1,500})`/g)) {
    claims.push(...pathClaimsFromSnippet(match[1]));
  }
  for (const match of source.matchAll(/(?:^|[\s("'])((?:~\/|\.{1,2}\/|\/)[^\s"'`),;]{1,300})/gm)) {
    const cleaned = cleanPathToken(match[1]);
    if (looksLikePathClaim(cleaned)) claims.push(cleaned);
  }
  const uniqueClaims = new Map();
  for (const claim of claims) {
    const cleaned = cleanPathToken(claim);
    if (cleaned && !uniqueClaims.has(cleaned)) uniqueClaims.set(cleaned, { path: cleaned });
  }
  return [...uniqueClaims.values()];
}

export function extractMarkdownPathEvidence(content = "", source = "", limit = 80) {
  return markdownPathClaims(content)
    .slice(0, Math.max(1, Number(limit) || 80))
    .map((item) => ({ path: item.path, source: String(source || "") }));
}

function normalizedOutputEvidence(value = "") {
  return String(value || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function markdownOutputClaims(content = "") {
  const claims = [];
  const pattern = /(?:^|\n)\s*(?:command\s+output|output|stdout|result|输出|結果|结果)\s*:?\s*\n```(?:text|plaintext|console|terminal)?\s*\n([\s\S]*?)```/gim;
  for (const match of String(content || "").matchAll(pattern)) {
    const output = normalizedOutputEvidence(match[1]);
    if (output.length >= 8) claims.push({ output, preview: compact(output, 240) });
  }
  return claims;
}

function hasObservedRunCommandResult(payload = {}) {
  if (!payload || typeof payload !== "object" || payload.blocked) return false;
  if (String(payload.toolName || payload.name || "") !== "run_command") return false;
  return (
    Number.isInteger(payload.exitCode) ||
    Object.prototype.hasOwnProperty.call(payload, "stdout") ||
    Object.prototype.hasOwnProperty.call(payload, "stderr")
  );
}

function runtimeOutputEvidence({ events = [], state = {} } = {}) {
  const outputs = [];
  const consume = (payload = {}) => {
    if (!hasObservedRunCommandResult(payload)) return;
    const output = normalizedOutputEvidence(payload.stdout || payload.result || "");
    if (output) outputs.push(output);
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "tool.completed") consume(event.data);
  }
  for (const message of Array.isArray(state?.messages) ? state.messages : []) {
    if (message?.role !== "tool") continue;
    try {
      consume(JSON.parse(message.content || "{}"));
    } catch {
      // Ignore malformed historical tool messages.
    }
  }
  return outputs;
}

function evidenceExcludedPathKeys({ events = [], state = {}, explicitPaths = [], commandCwd = process.cwd() } = {}) {
  const excluded = new Set();
  const addPath = (value = "", cwd = commandCwd) => {
    for (const key of pathComparisonKeys(value, cwd)) excluded.add(key);
  };
  const addChange = (change = {}, cwd = commandCwd) => {
    if (!change || typeof change !== "object") return;
    addPath(change.path || change.file || "", change.commandCwd || cwd);
    addPath(change.newPath || change.outputPath || change.artifactPath || "", change.commandCwd || cwd);
  };
  const consumeToolPayload = (payload = {}, cwd = commandCwd) => {
    if (!payload || typeof payload !== "object" || payload.ok === false || payload.blocked) return;
    const toolName = String(payload.toolName || payload.name || "");
    const hasChanges = payload.change || (Array.isArray(payload.changes) && payload.changes.length);
    if (!["write_file", "apply_patch"].includes(toolName) && !hasChanges) return;
    const payloadCwd = payload.commandCwd || cwd;
    addPath(payload.path || payload.args?.path || "", payloadCwd);
    addChange(payload.change, payloadCwd);
    for (const change of Array.isArray(payload.changes) ? payload.changes : []) addChange(change, payloadCwd);
  };

  for (const item of Array.isArray(explicitPaths) ? explicitPaths : []) addPath(item);
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "file.changed") addChange(event.data, event?.data?.commandCwd || commandCwd);
    if (event?.type === "tool.completed") consumeToolPayload(event.data);
  }
  for (const message of Array.isArray(state?.messages) ? state.messages : []) {
    if (message?.role !== "tool") continue;
    try {
      consumeToolPayload(JSON.parse(message.content || "{}"));
    } catch {
      // Ignore malformed historical tool messages.
    }
  }
  return excluded;
}

function sourceEvidenceCommands({ events = [], state = {}, excludedPaths = [], commandCwd = process.cwd() } = {}) {
  const excluded = evidenceExcludedPathKeys({
    events,
    state,
    explicitPaths: excludedPaths,
    commandCwd,
  });
  const commands = new Map();
  const addCommand = (item, source = "") => {
    if (!item?.signature || commands.has(item.signature)) return;
    commands.set(item.signature, {
      signature: item.signature,
      command: String(item.claim || "").trim(),
      source: String(source || ""),
    });
  };
  const addMarkdownCommands = (content = "", source = "") => {
    for (const item of markdownCommandClaims(content)) addCommand(item, source);
  };
  const addRetainedCommands = (items = [], fallbackSource = "") => {
    for (const item of Array.isArray(items) ? items : []) {
      const command = String(item?.command || item?.claim || "").trim();
      const signature = String(item?.signature || commandSignature(command)).trim();
      if (signature && command) {
        addCommand({ claim: command, signature }, item?.source || fallbackSource);
      }
    }
  };
  const addShellCommands = (content = "", source = "runtime") => {
    for (const line of shellLogicalLines(content)) {
      for (const segment of shellCommandSegments(line)) {
        const signature = commandSignature(segment);
        if (signature) addCommand({ claim: segment, signature }, source);
      }
    }
  };
  const consume = (payload = {}) => {
    if (!payload || typeof payload !== "object" || payload.blocked) return;
    const toolName = String(payload.toolName || payload.name || "");
    const observedRunCommand = hasObservedRunCommandResult(payload);
    if (payload.ok === false && !observedRunCommand) return;
    const payloadPath = payload.path || payload.args?.path || "";
    const payloadPathKeys = pathComparisonKeys(payloadPath, commandCwd);
    if (toolName === "read_file" && payloadPath && !payloadPathKeys.some((key) => excluded.has(key))) {
      addRetainedCommands(payload.commandEvidence, payloadPath);
      addMarkdownCommands(payload.content || payload.contentPreview || "", payloadPath);
    }
    if (toolName === "run_command") {
      addShellCommands(payload.args?.command || "", "observed runtime command");
      if (payload.ok === false) return;
      const sourcePaths = readOnlyCommandSourcePaths(payload.args?.command || "", commandCwd);
      const sourceIsExcluded = sourcePaths.some((sourcePath) =>
        pathComparisonKeys(sourcePath, commandCwd).some((key) => excluded.has(key))
      );
      if (
        sourcePaths.length &&
        !sourceIsExcluded &&
        isPureReadOnlySourceDisplayCommand(payload.args?.command || "")
      ) {
        addMarkdownCommands(
          payload.stdout || payload.result || "",
          `read-only command output: ${sourcePaths.join(", ")}`
        );
      }
    }
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "tool.completed") consume(event.data);
  }
  for (const message of Array.isArray(state?.messages) ? state.messages : []) {
    if (message?.role !== "tool") continue;
    try {
      consume(JSON.parse(message.content || "{}"));
    } catch {
      // Ignore malformed historical tool messages.
    }
  }
  return commands;
}

function pathComparisonKeys(value = "", commandCwd = process.cwd()) {
  const cleaned = cleanPathToken(value).replace(/\/+$/, "");
  if (!cleaned) return [];
  const keys = new Set([cleaned]);
  if (!/^\$\{?[A-Za-z_]/.test(cleaned)) {
    try {
      keys.add(resolveContractPath(commandCwd, cleaned).replace(/\/+$/, ""));
    } catch {
      // Preserve the literal key when a platform-specific path cannot resolve.
    }
  }
  return [...keys];
}

function pathTemplateSegments(value = "") {
  return cleanPathToken(value)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/<[^>]+>/g, "*")
        .replace(/\b(?:RUN_NAME|SONG(?:_ID)?|VIDEO(?:_ID)?|PAGE_ID|THREAD_URL|INPUT_AUDIO|TARGET_LINES|SHA256|PROMPT|YYYY(?:-MM(?:-DD)?)?)\b/g, "*")
        .replace(/\*+/g, "*")
    );
}

function pathTemplateSegmentCompatible(left = "", right = "") {
  if (left === right) return true;
  if (!left.includes("*") && !right.includes("*")) return false;
  const toPattern = (value) =>
    new RegExp(`^${String(value).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+")}$`);
  return toPattern(left).test(right.replace(/\*/g, "placeholder")) ||
    toPattern(right).test(left.replace(/\*/g, "placeholder"));
}

function pathTemplateRangeCompatible(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => pathTemplateSegmentCompatible(segment, right[index]));
}

function pathTemplateIsSameParentOrSuffix(claim = "", evidence = "") {
  const claimSegments = pathTemplateSegments(claim);
  const evidenceSegments = pathTemplateSegments(evidence);
  if (!claimSegments.length || !evidenceSegments.length) return false;
  if (
    claimSegments.length <= evidenceSegments.length &&
    pathTemplateRangeCompatible(claimSegments, evidenceSegments.slice(0, claimSegments.length))
  ) return true;
  if (claimSegments.length <= evidenceSegments.length) {
    const suffix = evidenceSegments.slice(-claimSegments.length);
    if (pathTemplateRangeCompatible(claimSegments, suffix)) return true;
  }
  return false;
}

function readOnlyCommandSourcePaths(command = "", commandCwd = process.cwd()) {
  const sources = [];
  let activeDirectory = commandCwd;
  for (const line of shellLogicalLines(command)) {
    for (const segment of shellCommandSegments(line)) {
      const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      if (!tokens.length) continue;
      const first = unquoteShellToken(tokens[0]).toLowerCase();
      if (first === "cd") {
        const target = cleanPathToken(tokens[1] || "");
        if (target) activeDirectory = resolveContractPath(activeDirectory, target);
        continue;
      }
      if (!["cat", "head", "sed", "tail"].includes(first)) continue;
      for (let index = 1; index < tokens.length; index += 1) {
        const token = cleanPathToken(tokens[index]);
        if (!token || token.startsWith("-") || /^[0-9,+$]+[a-z]*$/i.test(token)) continue;
        if (first === "sed" && /^\d+(?:,\d+)?[a-z]$/i.test(token)) continue;
        if (!looksLikePathClaim(token)) continue;
        sources.push(resolveContractPath(activeDirectory, token));
      }
    }
  }
  return [...new Set(sources)];
}

function isPureReadOnlySourceDisplayCommand(command = "") {
  let sawReader = false;
  for (const line of shellLogicalLines(command)) {
    for (const segment of shellCommandSegments(line)) {
      const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      if (!tokens.length) continue;
      const first = unquoteShellToken(tokens[0]).toLowerCase();
      if (first === "cd") continue;
      if (!["cat", "head", "sed", "tail"].includes(first)) return false;
      if (/(?:^|\s)(?:>|>>|\d+>)/.test(segment)) return false;
      sawReader = true;
    }
  }
  return sawReader;
}

function resolveEvidenceEntryPath(rootPath = "", entryPath = "") {
  const root = String(rootPath || ".");
  const entry = String(entryPath || "").replace(/^\.\//, "");
  if (!entry) return root;
  if (path.isAbsolute(entry)) return entry;
  const rootBase = path.basename(path.normalize(root));
  if (entry === rootBase || entry.startsWith(`${rootBase}/`)) {
    return path.join(path.dirname(root), entry);
  }
  return path.join(root, entry);
}

function sourceEvidencePaths({ events = [], state = {}, contract = {}, commandCwd = process.cwd() } = {}) {
  const excluded = evidenceExcludedPathKeys({
    events,
    state,
    explicitPaths: contract.exactOutputPaths || [],
    commandCwd,
  });
  const paths = new Map();
  const addPath = (value = "", source = "") => {
    const cleaned = cleanPathToken(value);
    if (!cleaned) return;
    const keys = pathComparisonKeys(cleaned, commandCwd);
    if (keys.some((key) => excluded.has(key))) return;
    const canonical = keys[keys.length - 1] || cleaned;
    if (!paths.has(canonical)) paths.set(canonical, { path: cleaned, source: String(source || "") });
    for (const key of keys) {
      if (!paths.has(key)) paths.set(key, { path: cleaned, source: String(source || "") });
    }
  };
  const addMarkdownPaths = (content = "", source = "") => {
    for (const item of markdownPathClaims(content)) addPath(item.path, source);
    for (const match of String(content || "").matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
      try {
        const pathname = new URL(match[0]).pathname;
        if (pathname && pathname !== "/") addPath(pathname, source || "inspected URL");
      } catch {
        // Ignore malformed URL fragments in inspected text.
      }
    }
  };
  const addSingleDirectoryListing = (command = "", stdout = "") => {
    const segments = shellLogicalLines(command).flatMap((line) => shellCommandSegments(line));
    const listings = segments.filter((segment) => /^\s*ls(?:\s|$)/i.test(segment));
    if (listings.length !== 1) return;
    const tokens = listings[0].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const targetToken = [...tokens.slice(1)].reverse().find((token) => !unquoteShellToken(token).startsWith("-"));
    const target = targetToken ? resolveContractPath(commandCwd, cleanPathToken(targetToken)) : commandCwd;
    for (const rawLine of String(stdout || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^total\s+\d+$/i.test(line) || line === "." || line === "..") continue;
      let name = line;
      if (/^[bcdlps-][rwxStTs-]{9}\s/.test(line)) {
        const fields = line.split(/\s+/);
        if (fields.length < 9) continue;
        name = fields.slice(8).join(" ").replace(/\s+->\s+.*$/, "");
      }
      if (!name || name.startsWith("===")) continue;
      addPath(path.join(target, name), `directory listing: ${target}`);
    }
  };
  const consume = (payload = {}) => {
    if (!payload || typeof payload !== "object" || payload.blocked) return;
    const toolName = String(payload.toolName || payload.name || "");
    if (payload.ok === false && !hasObservedRunCommandResult(payload)) return;
    const payloadPath = payload.path || payload.args?.path || "";
    const payloadPathKeys = pathComparisonKeys(payloadPath, commandCwd);
    const sourceIsExcluded = payloadPathKeys.some((key) => excluded.has(key));
    if (toolName === "read_file" && sourceIsExcluded) return;
    if (["read_file", "list_files", "search_files", "inspect_project"].includes(toolName)) {
      addPath(payloadPath, `${toolName} result`);
    }
    if (toolName === "read_file") {
      for (const item of Array.isArray(payload.pathEvidence) ? payload.pathEvidence : []) {
        addPath(item?.path, item?.source || payloadPath);
      }
      addMarkdownPaths(payload.content || payload.contentPreview || "", payloadPath);
    }
    if (toolName === "list_files") {
      for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
        const entryPath = String(entry?.path || "");
        addPath(resolveEvidenceEntryPath(payloadPath, entryPath), payloadPath);
      }
    }
    if (toolName === "search_files") {
      for (const result of Array.isArray(payload.results) ? payload.results : []) {
        const resultPath = String(result?.path || "");
        addPath(resolveEvidenceEntryPath(payloadPath, resultPath), payloadPath);
      }
    }
    if (toolName === "run_command") {
      for (const item of markdownPathClaims(`\`${String(payload.args?.command || "")}\``)) {
        addPath(item.path, "observed runtime command");
      }
      for (const match of String(payload.args?.command || "").matchAll(/https?:\/\/[^\s"']+/gi)) {
        try {
          const pathname = new URL(match[0]).pathname;
          if (pathname && pathname !== "/") addPath(pathname, "observed runtime URL");
        } catch {
          // Ignore malformed URL fragments in a shell command.
        }
      }
      addSingleDirectoryListing(payload.args?.command || "", payload.stdout || payload.result || "");
      const sourcePaths = readOnlyCommandSourcePaths(payload.args?.command || "", commandCwd);
      const sourceIsExcluded = sourcePaths.some((sourcePath) =>
        pathComparisonKeys(sourcePath, commandCwd).some((key) => excluded.has(key))
      );
      if (!sourceIsExcluded) {
        for (const item of pathClaimsFromSnippet(payload.stdout || payload.result || "")) {
          addPath(item, sourcePaths.length ? `read-only command output: ${sourcePaths.join(", ")}` : "observed runtime output");
        }
      }
    }
  };
  addPath(commandCwd, "runtime workspace");
  for (const root of contract.declaredSourceRoots || []) addPath(root, "task-declared source");
  for (const inputPath of contract.exactInputPaths || []) addPath(inputPath, "task-declared input");
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "tool.completed") consume(event.data);
  }
  for (const message of Array.isArray(state?.messages) ? state.messages : []) {
    if (message?.role !== "tool") continue;
    try {
      consume(JSON.parse(message.content || "{}"));
    } catch {
      // Ignore malformed historical tool messages.
    }
  }
  return paths;
}

function sourceScopeCoverage(contract = {}, { events = [], state = {}, commandCwd = process.cwd() } = {}) {
  const roots = (contract.declaredSourceRoots || []).map((rawPath) => ({
    rawPath,
    absolutePath: resolveContractPath(commandCwd, rawPath).replace(/\/+$/, ""),
  }));
  if (!roots.length) return { checked: false, missingSourceReads: [], missingSourceChecks: [] };
  const observedPayloads = [];
  const consume = (payload = {}) => {
    if (!payload || typeof payload !== "object" || payload.blocked) return;
    if (payload.ok === false && !hasObservedRunCommandResult(payload)) return;
    observedPayloads.push(payload);
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (["tool.completed", "tool.failed"].includes(event?.type)) consume(event.data);
  }
  for (const message of Array.isArray(state?.messages) ? state.messages : []) {
    if (message?.role !== "tool") continue;
    try {
      consume(JSON.parse(message.content || "{}"));
    } catch {
      // Ignore malformed historical tool messages.
    }
  }
  const pathIsUnderRoot = (value = "", root) => {
    if (!value) return false;
    const absolute = resolveContractPath(commandCwd, value).replace(/\/+$/, "");
    return absolute === root.absolutePath || absolute.startsWith(`${root.absolutePath}${path.sep}`);
  };
  const commandCoversRoot = (command = "", root, { requireSubstantive = false } = {}) => {
    const text = String(command || "");
    if (!requireSubstantive) return text.includes(root.rawPath) || text.includes(root.absolutePath);
    let activeDirectory = commandCwd;
    for (const line of shellLogicalLines(text)) {
      for (const segment of shellCommandSegments(line)) {
        const cdMatch = segment.match(/^\s*\(?\s*cd\s+([^\s)]+)/i);
        if (cdMatch) {
          activeDirectory = resolveContractPath(activeDirectory, cleanPathToken(cdMatch[1]));
          continue;
        }
        if (!isSubstantiveRuntimeCheck(segment)) continue;
        const segmentMentionsRoot = segment.includes(root.rawPath) || segment.includes(root.absolutePath);
        const active = path.resolve(activeDirectory).replace(/\/+$/, "");
        if (segmentMentionsRoot || active === root.absolutePath || active.startsWith(`${root.absolutePath}${path.sep}`)) {
          return true;
        }
      }
    }
    return false;
  };
  const missingSourceReads = roots
    .filter((root) =>
      !observedPayloads.some((payload) => {
        const toolName = String(payload.toolName || payload.name || "");
        if (["read_file", "list_files", "search_files", "inspect_project"].includes(toolName)) {
          return pathIsUnderRoot(payload.path || payload.args?.path || "", root);
        }
        if (toolName === "run_command") {
          return commandCoversRoot(payload.args?.command || "", root);
        }
        return false;
      })
    )
    .map((root) => root.rawPath);
  const missingSourceChecks = contract.requiresPerSourceChecks
    ? roots
        .filter((root) =>
          !observedPayloads.some(
            (payload) =>
              String(payload.toolName || payload.name || "") === "run_command" &&
              commandCoversRoot(payload.args?.command || "", root, { requireSubstantive: true })
          )
        )
        .map((root) => root.rawPath)
    : [];
  return {
    checked: true,
    roots: roots.map((root) => root.rawPath),
    missingSourceReads,
    missingSourceChecks,
  };
}

function evaluateSourceGrounding(contract = {}, files = [], options = {}) {
  if (!contract.requiresSourceGrounding) {
    return { ok: true, checked: false, reason: "This task does not require source-grounded command auditing." };
  }
  const claims = files.flatMap((file) => (file.exists ? markdownCommandClaims(file.content) : []));
  const exactOutputKeys = new Set(
    (contract.exactOutputPaths || []).flatMap((item) => pathComparisonKeys(item, options.commandCwd))
  );
  const pathClaims = files
    .flatMap((file) => (file.exists ? markdownPathClaims(file.content) : []))
    .filter((item) => !pathComparisonKeys(item.path, options.commandCwd).some((key) => exactOutputKeys.has(key)));
  const outputClaims = files.flatMap((file) => (file.exists ? markdownOutputClaims(file.content) : []));
  const evidenceCommands = sourceEvidenceCommands({
    events: options.events,
    state: options.state,
    excludedPaths: contract.exactOutputPaths || [],
    commandCwd: options.commandCwd,
  });
  const evidenceCommandSignatures = [...evidenceCommands.keys()];
  const commandClaimIsGrounded = (signature = "") => {
    if (evidenceCommands.has(signature)) return true;
    if (String(signature).split(/\s+/).length < 2) return false;
    return evidenceCommandSignatures.some(
      (candidate) => candidate.startsWith(`${signature} `) || candidate.endsWith(` ${signature}`)
    );
  };
  const unsupportedCommandClaims = claims.filter((item) => !commandClaimIsGrounded(item.signature));
  const evidencePaths = sourceEvidencePaths({
    events: options.events,
    state: options.state,
    contract,
    commandCwd: options.commandCwd,
  });
  const uniqueEvidencePathValues = [
    ...new Set([...evidencePaths.values()].map((item) => cleanPathToken(item.path).replace(/\/+$/, ""))),
  ];
  const declaredRootPrefixes = (contract.declaredSourceRoots || [])
    .map((item) => resolveContractPath(options.commandCwd, item).replace(/\/+$/, ""))
    .filter(Boolean);
  const sourceRelativeClaim = (cleaned = "") => {
    const resolved = resolveContractPath(options.commandCwd, cleaned).replace(/\/+$/, "");
    for (const root of declaredRootPrefixes) {
      if (resolved === root) return "";
      if (resolved.startsWith(`${root}${path.sep}`)) return resolved.slice(root.length + 1);
    }
    const firstSegment = pathTemplateSegments(cleaned)[0] || "";
    const root = declaredRootPrefixes.find((item) => path.basename(item) === firstSegment);
    return root ? pathTemplateSegments(cleaned).slice(1).join("/") : "";
  };
  const uniqueEvidenceBasenames = new Map();
  for (const candidate of uniqueEvidencePathValues) {
    const basename = path.basename(cleanPathToken(candidate).replace(/\/+$/, ""));
    if (!basename) continue;
    uniqueEvidenceBasenames.set(basename, Number(uniqueEvidenceBasenames.get(basename) || 0) + 1);
  }
  const pathClaimIsGrounded = (item) => {
    if (pathComparisonKeys(item.path, options.commandCwd).some((key) => evidencePaths.has(key))) return true;
    const cleaned = cleanPathToken(item.path).replace(/\/+$/, "");
    const segments = cleaned.split("/").filter(Boolean);
    if (segments.length === 1) {
      return uniqueEvidencePathValues.some(
        (candidate) => path.basename(cleanPathToken(candidate).replace(/\/+$/, "")) === cleaned
      );
    }
    if (
      PATH_CLAIM_EXTENSIONS.has((path.extname(cleaned).slice(1) || "").toLowerCase()) &&
      uniqueEvidenceBasenames.get(path.basename(cleaned)) === 1
    ) return true;
    if (cleaned.startsWith("../") || cleaned.startsWith("./")) return false;
    const claimedAbsolute = resolveContractPath(options.commandCwd, cleaned).replace(/\/+$/, "");
    if (
      uniqueEvidencePathValues.some((candidate) => {
        const candidateAbsolute = resolveContractPath(options.commandCwd, candidate).replace(/\/+$/, "");
        return candidateAbsolute.startsWith(`${claimedAbsolute}${path.sep}`) ||
          pathTemplateIsSameParentOrSuffix(cleaned, candidate);
      })
    ) return true;
    const relativeToDeclaredRoot = sourceRelativeClaim(cleaned);
    if (
      relativeToDeclaredRoot &&
      uniqueEvidencePathValues.some((candidate) => pathTemplateIsSameParentOrSuffix(relativeToDeclaredRoot, candidate))
    ) return true;
    const suffix = `/${cleaned}`;
    return uniqueEvidencePathValues.filter((candidate) => candidate.endsWith(suffix)).length === 1;
  };
  const unsupportedPathClaims = pathClaims.filter((item) => !pathClaimIsGrounded(item));
  const runtimeOutputs = runtimeOutputEvidence(options);
  const unsupportedOutputClaims = outputClaims.filter(
    (item) => !runtimeOutputs.some((output) => output.includes(item.output))
  );
  const scopeCoverage = sourceScopeCoverage(contract, options);
  const commandGroups = new Map();
  for (const item of evidenceCommands.values()) {
    const source = String(item.source || "unknown");
    if (!commandGroups.has(source)) commandGroups.set(source, []);
    commandGroups.get(source).push(item);
  }
  const groundedCommandExamples = [];
  while (groundedCommandExamples.length < 32 && [...commandGroups.values()].some((items) => items.length)) {
    for (const items of commandGroups.values()) {
      const item = items.shift();
      if (item) groundedCommandExamples.push(item);
      if (groundedCommandExamples.length >= 32) break;
    }
  }
  const pathGroups = new Map();
  for (const item of new Map([...evidencePaths.values()].map((entry) => [entry.path, entry])).values()) {
    const source = String(item.source || "unknown");
    if (!pathGroups.has(source)) pathGroups.set(source, []);
    pathGroups.get(source).push(item);
  }
  const groundedPathExamples = [];
  while (groundedPathExamples.length < 32 && [...pathGroups.values()].some((items) => items.length)) {
    for (const items of pathGroups.values()) {
      const item = items.shift();
      if (item) groundedPathExamples.push(item);
      if (groundedPathExamples.length >= 32) break;
    }
  }
  return {
    ok:
      unsupportedCommandClaims.length === 0 &&
      unsupportedPathClaims.length === 0 &&
      unsupportedOutputClaims.length === 0 &&
      scopeCoverage.missingSourceReads.length === 0 &&
      scopeCoverage.missingSourceChecks.length === 0,
    checked: true,
    claims,
    pathClaims,
    outputClaims,
    unsupportedCommandClaims,
    unsupportedPathClaims,
    unsupportedOutputClaims,
    groundedCommandExamples,
    groundedPathExamples,
    ...scopeCoverage,
    reason: [
      unsupportedCommandClaims.length
        ? `Command claims were not found in inspected source/help/runtime evidence: ${unsupportedCommandClaims
            .map((item) => item.signature)
            .join(", ")}.`
        : "",
      unsupportedPathClaims.length
        ? `Path claims were not found in the task, inspected source, file listings, or observed runtime commands: ${unsupportedPathClaims
            .map((item) => item.path)
            .join(", ")}.`
        : "",
      unsupportedOutputClaims.length
        ? `Claimed command output was not present in observed runtime stdout: ${unsupportedOutputClaims
            .map((item) => item.preview)
            .join(" | ")}.`
        : "",
      scopeCoverage.missingSourceReads.length
        ? `No observed source inspection covered: ${scopeCoverage.missingSourceReads.join(", ")}.`
        : "",
      scopeCoverage.missingSourceChecks.length
        ? `No observed substantive read-only check covered: ${scopeCoverage.missingSourceChecks.join(", ")}.`
        : "",
    ].filter(Boolean).join(" ") || "Every nonstandard command, path, and command-output claim is grounded in inspected evidence.",
  };
}

export function evaluateScsSemanticContract(
  contract = {},
  { commandCwd = process.cwd(), events = [], state = {} } = {}
) {
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
  const sourceGrounding = evaluateSourceGrounding(contract, files, { commandCwd, events, state });
  const ok =
    missingFiles.length === 0 &&
    missingRequiredText.length === 0 &&
    presentForbiddenText.length === 0 &&
    sourceGrounding.ok;
  return {
    ok,
    checked: true,
    exactOutputPaths,
    requiredTextTerms,
    forbiddenTextTerms,
    missingFiles,
    missingRequiredText,
    presentForbiddenText,
    sourceGrounding,
    unsupportedCommandClaims: sourceGrounding.unsupportedCommandClaims || [],
    unsupportedPathClaims: sourceGrounding.unsupportedPathClaims || [],
    unsupportedOutputClaims: sourceGrounding.unsupportedOutputClaims || [],
    groundedCommandExamples: sourceGrounding.groundedCommandExamples || [],
    groundedPathExamples: sourceGrounding.groundedPathExamples || [],
    missingSourceReads: sourceGrounding.missingSourceReads || [],
    missingSourceChecks: sourceGrounding.missingSourceChecks || [],
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
          !sourceGrounding.ok ? sourceGrounding.reason : "",
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
    payload.reportPath,
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

  if (["write_file", "apply_patch"].includes(toolName) || payload.path || payload.reportPath || Array.isArray(payload.changes)) {
    push(
      "file",
      `${toolName || "tool"} produced file/workspace evidence`,
      payload.path || payload.reportPath || args.path || ""
    );
  }
  if (toolName === "run_command" || payload.stdout || Number.isInteger(payload.exitCode)) {
    push("command", `exit=${payload.exitCode ?? 0} stdout=${compact(payload.stdout || "", 260)}`, args.command || "");
  }
  if (
    toolName === "deep_research" &&
    payload.status === "completed" &&
    payload.reportPath &&
    payload.artifactPath &&
    payload.audit &&
    payload.coverage
  ) {
    push(
      "command",
      [
        "deep_research deterministic audit completed",
        `citationCoverage=${Number(payload.audit.citationCoverage || 0)}`,
        `verifiedClaims=${Number(payload.coverage.verifiedClaimCount || 0)}`,
        `quoteVerificationRate=${Number(payload.coverage.quoteVerificationRate || 0)}`,
      ].join(" "),
      payload.reportPath
    );
  }
  if (["start_long_job", "long_job_status"].includes(toolName)) {
    push(
      "command",
      `${toolName} ${payload.state ? `state=${payload.state}` : payload.background ? "background=true" : ""} status=${payload.statusPath || ""}`,
      payload.statusPath || payload.expectedOutputPath || args.command || ""
    );
    push(
      "artifact",
      `${toolName} produced durable status/log artifact paths`,
      payload.statusMarkdownPath || payload.statusPath || payload.expectedOutputPath || ""
    );
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
  const toolNames = unique(items.map((item) => item.toolName).filter(Boolean));
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
    toolNames,
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
  const requiredToolCalls = Array.isArray(contract.requiredToolCalls) ? contract.requiredToolCalls : [];
  const ledgerToolNames = new Set(Array.isArray(ledger.toolNames) ? ledger.toolNames : []);
  const satisfied = [];
  const missing = [];
  for (const requirement of required) {
    if (ledgerCategories.has(requirement.category)) {
      satisfied.push(requirement);
    } else {
      missing.push(requirement);
    }
  }
  const missingToolCalls = requiredToolCalls.filter((toolName) => !ledgerToolNames.has(toolName));
  const hasAnyEvidence = Number(ledger.itemCount || 0) > 0;
  const evidenceOk = !contract.requiresExternalEvidence || (missing.length === 0 && hasAnyEvidence);
  const ok = evidenceOk && missingToolCalls.length === 0;
  return {
    ok,
    requiresExternalEvidence: Boolean(contract.requiresExternalEvidence),
    hasAnyEvidence,
    satisfied,
    missing,
    requiredToolCalls,
    missingToolCalls,
    reason: ok
      ? "Evidence satisfies the deterministic task contract."
      : missingToolCalls.length
        ? `Missing required tool calls: ${missingToolCalls.join(", ")}.`
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
      exactInputPaths: contract.exactInputPaths || [],
      requiredToolCalls: contract.requiredToolCalls || [],
      requiresSourceGrounding: Boolean(contract.requiresSourceGrounding),
      requiredTextTerms: contract.requiredTextTerms || [],
      forbiddenTextTerms: contract.forbiddenTextTerms || [],
      successCriteria: contract.successCriteria || [],
    },
    evidenceLedger: {
      itemCount: ledger.itemCount || 0,
      categories: ledger.categories || [],
      toolNames: ledger.toolNames || [],
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
      missingToolCalls: evaluation.missingToolCalls || [],
      satisfied: (evaluation.satisfied || []).map((item) => item.category),
    },
  };
}

export function finishResultClaimsBlocker(result = "") {
  const text = String(result || "")
    .replace(
      /\b(?:no|not|without)\s+(?:external\s+)?(?:service|login|credential|approval|permission|api key|blocker)s?\s+(?:is|are\s+)?required\b/gi,
      ""
    )
    .replace(/\b(?:does not|doesn't|do not|don't)\s+require\b[^.\n;]*/gi, "");
  return /\b(?:blocked|denied|forbidden|cannot|can't|unable|captcha|quota exhausted|usage limit|rate limit|missing (?:credential|api key)|external blocker)\b|\b(?:requires?|needs?)\s+(?:human\s+)?(?:approval|permission|login|credentials?|an? api key|captcha)\b/i.test(
    text
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
      ...(evaluation.missingToolCalls?.length ? [`Required tool calls missing: ${evaluation.missingToolCalls.join(", ")}`] : []),
    ],
    nextRequiredAction:
      "Collect the missing concrete evidence, verify the requested state or artifact, then ask SCS to finish again; if impossible, report a real blocker with proof.",
  };
}
