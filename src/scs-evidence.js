import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText, redactValue } from "./redaction.js";
import {
  canonicalizeShellCommand,
  hasActiveShellExpansion,
  parseTopLevelShellSequence,
  tokenizeShellWords,
} from "./shell-syntax.js";

const CATEGORY_LABELS = {
  file: "file or workspace change",
  command: "command/check output",
  artifact: "durable artifact",
  browser: "browser or external UI state",
  git: "git/version-control action",
  publish: "publish/submit/deploy action",
  visual: "visual inspection or screenshot evidence",
  test: "successful discovered project test run",
};

const OBSERVATIONAL_GIT_ACTIONS = new Set(["diff", "log", "show", "status"]);
const RECOGNIZED_GIT_ACTIONS = [
  "add",
  "branch",
  "checkout",
  "clean",
  "commit",
  "diff",
  "log",
  "merge",
  "pull",
  "push",
  "pull-request",
  "rebase",
  "reset",
  "restore",
  "show",
  "status",
  "switch",
  "tag",
];

export function isObservationalGitAction(value = "") {
  return OBSERVATIONAL_GIT_ACTIONS.has(String(value || "").toLowerCase());
}

export function inferGitActionsFromCommand(value = "", { requireFailurePropagation = true } = {}) {
  // Expansion can execute a nested command that is not represented by the
  // outer command tokens. Do not turn ambiguous shell text into durable Git
  // evidence; the caller can rerun a bounded literal Git command instead.
  if (hasActiveShellExpansion(value)) return [];
  const sequence = parseTopLevelShellSequence(value);
  if (
    requireFailurePropagation &&
    (sequence.trailingSeparator ||
      (sequence.commands.length > 1 &&
        !sequence.separators.every((item) => item === "&&")))
  ) {
    return [];
  }
  const actions = [];
  for (const command of sequence.commands) {
    const tokens = tokenizeShellWords(command);
    if (!tokens.length) continue;
    const executable = String(tokens[0] || "").split(/[\\/]/).at(-1);
    if (
      (executable === "gh" && tokens[1] === "pr" && tokens[2] === "create") ||
      (executable === "glab" && tokens[1] === "mr" && tokens[2] === "create") ||
      (executable === "hub" && tokens[1] === "pull-request")
    ) {
      actions.push("pull-request");
      continue;
    }
    if (executable !== "git") continue;
    let index = 1;
    while (index < tokens.length) {
      const token = String(tokens[index] || "");
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(token)) {
        index += 2;
        continue;
      }
      if (/^--(?:git-dir|work-tree|namespace|exec-path)=/.test(token)) {
        index += 1;
        continue;
      }
      if (["--no-pager", "--paginate", "--literal-pathspecs", "--no-optional-locks", "--bare"].includes(token)) {
        index += 1;
        continue;
      }
      break;
    }
    const action = String(tokens[index] || "").toLowerCase();
    if (RECOGNIZED_GIT_ACTIONS.includes(action)) actions.push(action);
  }
  return actions;
}

const REQUIRED_GIT_ACTION_HEADS = {
  add: /^(?:git\s+add\b|stage\s+(?:the\s+)?(?:changes?|files?)\b)/,
  branch: /^(?:git\s+branch\b|(?:create|make)\s+(?:a\s+)?(?:git\s+)?branch\b(?!\s+(?:diagram|field|label|name|template)\b))/,
  checkout: /^(?:git\s+checkout\b|checkout\s+(?:the\s+)?(?:branch|revision|commit)\b)/,
  commit: /^(?:(?:git\s+)?commit\b(?!\s+(?:hash|history|message|object)\b)|(?:create|make)\s+(?:a\s+)?commit\b(?!\s+(?:hash|history|message|object|template)\b)|(?:the\s+)?(?:changes?|work|fix(?:es)?|code)\s+(?:is|are|be|gets?|got)\s+committed\b|提交代码)/,
  merge: /^(?:git\s+merge\b|merge\s+(?:the\s+)?(?:branch|changes?|commits?)\b|合并分支)/,
  pull: /^(?:git\s+pull\b|pull\s+(?:the\s+)?(?:latest|changes?)\b)/,
  push: /^(?:git\s+push\b|push\s+(?:(?:a|the)\s+)?(?:git\s+)?(?:changes?|commits?|branch|tag)\b|push\s+to\s+(?:git|github|the\s+repo(?:sitory)?)\b|(?:the\s+)?(?:changes?|work|fix(?:es)?|code|commits?|branch|tag)\s+(?:is|are|be|gets?|got)\s+pushed\b|推送)/,
  "pull-request": /^(?:(?:gh\s+pr|glab\s+mr)\s+create\b|hub\s+pull-request\b|(?:open|create|make|submit)\s+(?:(?:a|the)\s+)?(?:(?:github|gitlab)\s+)?(?:pull|merge)\s+request\b)/,
  restore: /^(?:git\s+restore\b)/,
  switch: /^(?:git\s+switch\b|switch\s+(?:to\s+)?(?:the\s+)?branch\b)/,
  tag: /^(?:git\s+tag\b|(?:create|make)\s+(?:a\s+)?(?:git\s+)?tag\b(?!\s+(?:field|label|name|template)\b))/,
};

const REQUIRED_GIT_ACTION_CONTINUATION_HEADS = new Map([
  ["stage", "add"],
  ["branch", "branch"],
  ["checkout", "checkout"],
  ["commit", "commit"],
  ["committed", "commit"],
  ["merge", "merge"],
  ["pull", "pull"],
  ["push", "push"],
  ["pushed", "push"],
  ["switch", "switch"],
  ["tag", "tag"],
]);

function gitActionRequestSentences(goal = "") {
  return normalizedText(stripForbiddenLanguage(goal))
    .split(/[\n.!?。！？]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function gitActionRequestSegments(sentence = "") {
  return String(sentence || "")
    .replace(/\b(?:and\s+then|then|after\s+that|afterwards|finally|next)\b/g, ",")
    .replace(/(?:然后|然後|接着|接著|随后|隨後|最后|最後)/g, ",")
    .split(/(?:[,;，；]+|\s+(?:and|also)\s+|\s*&&\s*|(?:并且|並且|以及|再)\s*)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripGitActionRequestPreamble(clause = "") {
  let value = String(clause || "").trim();
  const preamble = /^(?:(?:and|also)\s+|(?:please|kindly|now)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+|you\s+(?:must|should|need\s+to|have\s+to)\s+|(?:ensure|make\s+sure)(?:\s+that)?(?:\s+you)?\s+|(?:help|assist)\s+me(?:\s+to)?\s+|(?:run|execute|perform)\s+|(?:and|also|请你|請你|麻烦|麻煩|帮我|幫我|需要|必须|必須|运行|運行|执行|執行|请|請)\s*)/;
  while (preamble.test(value)) value = value.replace(preamble, "").trim();
  return value;
}

function requestedGitActionAtHead(value = "", { continuation = false } = {}) {
  const candidate = stripGitActionRequestPreamble(value);
  for (const [action, pattern] of Object.entries(REQUIRED_GIT_ACTION_HEADS)) {
    const match = candidate.match(pattern);
    if (match) return { action, match, candidate };
  }
  const bareMatch = candidate.match(/^([a-z]+)(?:\s+(?:it|them|this|that|these|those))?$/);
  if (bareMatch) {
    const action = REQUIRED_GIT_ACTION_CONTINUATION_HEADS.get(String(bareMatch[1] || ""));
    if (action) return { action, match: bareMatch, candidate };
  }
  if (continuation && !/^[a-z]+\s+\S+\s+(?:must|should|will|would|can|could|is|are|was|were|has|have|needs?|remains?|stays?)\b/.test(candidate)) {
    const match = candidate.match(/^([a-z]+)\b/);
    const action = REQUIRED_GIT_ACTION_CONTINUATION_HEADS.get(String(match?.[1] || ""));
    if (action) return { action, match, candidate };
  }
  return null;
}

function gitActionIsConditionalOnPendingChanges(segment = "", previousSegment = "", request = {}) {
  const candidate = String(request?.candidate || segment || "").trim();
  const context = `${String(previousSegment || "").trim()}, ${candidate}`;
  const changeSubject = "(?:changes?|edits?|modifications?|fix(?:es)?|files?|work)";
  const pendingState =
    "(?:remain(?:s|ing)?|exist(?:s)?|are\\s+(?:left|pending|uncommitted|staged|modified)|were\\s+made|have\\s+been\\s+made)";
  const explicitExistenceCondition = new RegExp(
    `\\b(?:only\\s+)?(?:if|when)\\s+(?:there\\s+(?:is|are)\\s+)?(?:any\\s+)?${changeSubject}(?:\\s+${pendingState})?\\b`,
    "i"
  );
  const anaphoricRemainderCondition =
    /\b(?:only\s+)?(?:if|when)\s+(?:any|some|one|ones|they|them|those)\s+(?:of\s+(?:them|those)\s+)?(?:remain(?:s|ing)?|are\s+(?:left|pending|uncommitted|staged|modified))\b/i;
  const dirtyWorktreeCondition =
    /\b(?:only\s+)?(?:if|when)\s+(?:the\s+)?(?:worktree|working\s+tree|repository|repo)\s+is\s+(?:dirty|not\s+clean)\b/i;
  const chinesePendingCondition =
    /(?:如果|若|如)(?:仍然|仍|还|還)?(?:有|存在)(?:任何)?(?:更改|改动|改動|变更|變更|修改|待提交内容|待提交內容)/u;
  if (
    explicitExistenceCondition.test(context) ||
    dirtyWorktreeCondition.test(context) ||
    chinesePendingCondition.test(context)
  ) {
    return true;
  }
  return anaphoricRemainderCondition.test(context) && new RegExp(`\\b${changeSubject}\\b`, "i").test(candidate);
}

function gitActionsRequestedBySentence(sentence = "") {
  const segments = gitActionRequestSegments(sentence);
  const requested = [];
  let actionSequenceActive = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const request = requestedGitActionAtHead(segment, { continuation: actionSequenceActive });
    if (!request) continue;
    // A no-op-safe instruction such as "commit task-owned changes if any
    // remain" scopes what to do when a dirty tree exists; it does not require
    // manufacturing a fresh commit after an already-complete clean run.
    if (gitActionIsConditionalOnPendingChanges(segment, segments[index - 1], request)) continue;
    requested.push(request.action);
    actionSequenceActive = true;
  }
  return requested;
}

function inferRequiredGitActions(goal = "") {
  const requested = [];
  for (const sentence of gitActionRequestSentences(goal)) {
    requested.push(...gitActionsRequestedBySentence(sentence));
  }
  return unique(requested);
}

function missingRequiredGitActionSequence(required = [], observed = []) {
  let expected = (Array.isArray(required) ? required : [])
    .map((item) => String(item || "").toLowerCase())
    .filter(Boolean);
  if (
    expected.includes("commit") &&
    expected.includes("push") &&
    expected.lastIndexOf("push") < expected.lastIndexOf("commit")
  ) {
    expected = [...expected.filter((action) => action !== "push"), "push"];
  }
  const actual = (Array.isArray(observed) ? observed : [])
    .map((item) => String(item || "").toLowerCase())
    .filter(Boolean);
  let cursor = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const observedIndex = actual.indexOf(expected[index], cursor);
    if (observedIndex < 0) {
      // A successful commit proves that an index was staged, even when the
      // preceding `git add` happened in an earlier partially successful shell
      // chain or the commit used `-a`. Preserve the requested add -> commit
      // order without forcing the model to repeat a completed commit.
      if (expected[index] === "add" && expected[index + 1] === "commit") {
        const commitIndex = actual.indexOf("commit", cursor);
        if (commitIndex >= 0) {
          cursor = commitIndex;
          continue;
        }
      }
      return expected.slice(index);
    }
    cursor = observedIndex + 1;
  }
  if (expected.at(-1) === "push") {
    const finalConsequentialAction = [...actual]
      .reverse()
      .find((action) => !isObservationalGitAction(action));
    if (finalConsequentialAction !== "push") return ["push"];
  }
  return [];
}

export function gitActionsSatisfyContract(contract = {}, actions = []) {
  const observed = (Array.isArray(actions) ? actions : []).map((item) => String(item || "").toLowerCase());
  const required = Array.isArray(contract.requiredGitActions)
    ? contract.requiredGitActions.map((item) => String(item || "").toLowerCase()).filter(Boolean)
    : [];
  if (required.length) return missingRequiredGitActionSequence(required, observed).length === 0;
  // A Git evidence requirement can be purely observational, for example when
  // a continuation asks to verify an existing commit while explicitly
  // forbidding another commit. Consequential actions remain governed by the
  // ordered requiredGitActions contract above.
  return observed.length > 0;
}

const PROJECT_TEST_PROFILES = new Set([
  "app",
  "code",
  "codebase",
  "data",
  "database",
  "devops",
  "large-codebase",
  "maintenance",
  "pipeline",
  "python",
  "qa",
]);

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
  word: ["file", "command", "artifact", "visual"],
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

function looksLikeShellCommandLiteral(value = "") {
  const text = String(value || "").trim();
  if (!text || /[\r\n]/.test(text)) return false;
  const command = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "");
  const tokens = tokenizeShellWords(command);
  if (!tokens.length) return false;
  const executable = path.basename(String(tokens[0] || "")).toLowerCase();
  return new Set([
    "aginti",
    "bash",
    "bun",
    "cargo",
    "cmake",
    "curl",
    "dotnet",
    "ffmpeg",
    "git",
    "gh",
    "go",
    "java",
    "javac",
    "latexmk",
    "make",
    "node",
    "npm",
    "npx",
    "perl",
    "php",
    "pnpm",
    "pytest",
    "python",
    "python3",
    "ruby",
    "sh",
    "wget",
    "xelatex",
    "yarn",
    "zsh",
  ]).has(executable);
}

function indexFallsInsideInlineCommand(source = "", index = 0) {
  for (const match of String(source || "").matchAll(/`([^`\r\n]+)`/g)) {
    const start = Number(match.index || 0);
    const end = start + String(match[0] || "").length;
    if (index >= start && index < end && looksLikeShellCommandLiteral(match[1])) return true;
  }
  return false;
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

function normalizeWrappedNegativePrefixes(goal = "") {
  return String(goal || "").replace(
    /\b(do|must|should)\s*\r?\n\s*not\b/giu,
    "$1 not"
  );
}

function normalizeSoftLineWraps(goal = "") {
  return normalizeWrappedNegativePrefixes(goal).replace(
    /([A-Za-z0-9,])[ \t]*\r?\n[ \t]*(?=[a-z])/g,
    "$1 "
  );
}

function inferExactOutputPaths(goal = "") {
  const paths = [];
  const lines = String(goal || "").split(/\n/);
  const extensionPattern = "md|txt|json|jsonl|ndjson|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx";
  const quotedPathPattern = new RegExp("[\"'`]([^\"'`\\n]{1,220}\\.(?:" + extensionPattern + "))[\"'`]", "gi");
  const pathPattern = new RegExp(
    '(?:^|[\\s：:,，、])((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,220}\\.(?:' +
      extensionPattern +
      '))(?=$|[\\s"\'`,，、。；;.!?！？])',
    "gi"
  );
  const directOutputAction =
    /\b(?:sav(?:e|es|ing)|writ(?:e|es|ing)|rewrit(?:e|es|ing)|output(?:s|ting)?|creat(?:e|es|ing)|rebuild(?:s|ing)?|replac(?:e|es|ing)|regenerat(?:e|es|ing)|generat(?:e|es|ing)|stor(?:e|es|ing)|updat(?:e|es|ing)|modif(?:y|ies|ying)|edit(?:s|ing)?)\b|保存|写入|寫入|重写|重寫|输出|輸出|创建|建立|重建|替换|替換|重新生成|生成|更新|修改|编辑|編輯/i;
  const directOutputActionGlobal =
    /\b(?:sav(?:e|es|ing)|writ(?:e|es|ing)|rewrit(?:e|es|ing)|output(?:s|ting)?|creat(?:e|es|ing)|rebuild(?:s|ing)?|replac(?:e|es|ing)|regenerat(?:e|es|ing)|generat(?:e|es|ing)|stor(?:e|es|ing)|updat(?:e|es|ing)|modif(?:y|ies|ying)|edit(?:s|ing)?)\b|保存|写入|寫入|重写|重寫|输出|輸出|创建|建立|重建|替换|替換|重新生成|生成|更新|修改|编辑|編輯/gi;
  const outputListHeader =
    /^(?:#+\s*)?(?:(?:required|final|expected|declared|target|pilot|deliverable)\s+)*(?:create|created files?|files? to create|outputs?|output structure|required outputs?|artifacts?|deliverables?|generated files?|writer requirements|renderer requirements|生成文件|输出结构|輸出結構|输出文件|輸出文件|创建文件|建立文件)(?:\s+(?:outputs?|artifacts?|deliverables?))?\s*[：:]?\s*$/i;
  const nonOutputToolLine =
    /\b(?:validate|verify|check|compile|run|execute)\s+(?:(?:with|using)\s+)?[`"']?[^`"'\n]*\.(?:md|txt|json|jsonl|ndjson|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx)\b/i;
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
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const currentLine = String(rawLine || "").trim();
    const previousLine = String(lines[lineIndex - 1] || "").trim();
    const wrappedOutputInstruction =
      previousLine &&
      !/[.!?。！？;；]$/.test(previousLine) &&
      directOutputAction.test(previousLine);
    const line = wrappedOutputInstruction ? `${previousLine} ${currentLine}`.trim() : currentLine;
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
    const verifierIndex = line.search(/\b(?:validate|verify|check|compile|run|execute)\b/i);
    if (!isOutputListItem && nonOutputToolLine.test(line) && verifierIndex >= 0 && verifierIndex < directOutputIndex) {
      continue;
    }
    if (!isOutputListItem && /\boutput\s+(?:subfolders?|directories|folders?|paths?)\b/i.test(sourceLine)) continue;
    const outputDirMatch = sourceLine.match(/(?:to|at|in|under|到|至|在)\s*([^\s，,、；;。]+\/)/i);
    activeOutputDir = outputDirMatch?.[1] || "";
    quotedPathPattern.lastIndex = 0;
    for (const match of sourceLine.matchAll(quotedPathPattern)) {
      const prefix = sourceLine.slice(
        Math.max(0, Number(match.index || 0) - 180),
        Number(match.index || 0)
      );
      if (
        (looksLikeShellCommandLiteral(match[1]) ||
          Boolean(canonicalBareVerifierCommand(match[1]))) &&
        /\b(?:run|rerun|re-run|execute|invoke|launch|verify|validate|check|confirm)\b[^.!?;。！？；\n]{0,160}$/i.test(
          prefix
        )
      ) {
        continue;
      }
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

const REQUESTED_ARTIFACT_FORMATS = [
  { extension: ".pptx", pattern: /\b(?:pptx|powerpoint)\b/i, description: "editable PowerPoint deck" },
  { extension: ".odp", pattern: /\b(?:odp|open(?:office|document) presentation)\b/i, description: "editable ODP deck" },
  { extension: ".pdf", pattern: /\bpdf\b/i, description: "PDF document" },
  { extension: ".md", pattern: /(?:\bmarkdown\b|\.md\b)/i, description: "Markdown document" },
  {
    extension: ".tex",
    pattern: /(?:\b(?:editable\s+)?(?:latex|tex)\s+source\b|\.tex\b)/i,
    description: "editable LaTeX source",
  },
  { extension: ".docx", pattern: /\b(?:docx|word document)\b/i, description: "editable Word document" },
  { extension: ".xlsx", pattern: /\b(?:xlsx|excel workbook)\b/i, description: "editable spreadsheet" },
  { extension: ".png", pattern: /\bpng\b/i, description: "PNG image" },
  { extension: ".svg", pattern: /\bsvg\b/i, description: "editable SVG image" },
];

function requestedArtifactFormatHasOutputIntent(source = "", format = {}) {
  const extension = String(format.extension || "").toLocaleLowerCase("en-US");
  if (!extension || !format.pattern) return false;
  if (
    inferExactOutputPaths(source).some(
      (candidate) => path.extname(candidate).toLocaleLowerCase("en-US") === extension
    )
  ) {
    return true;
  }

  const matcher = new RegExp(
    format.pattern.source,
    format.pattern.flags.includes("g") ? format.pattern.flags : `${format.pattern.flags}g`
  );
  const outputAction =
    /\b(?:compile|convert|create|deliver|export|generate|keep|make|output|prepare|preserve|produce|provide|render|retain|return|reuse|save|send|write)\b/i;
  const directRequest =
    /\b(?:can|could|would|will)\s+you\b|\b(?:i|we)\s+(?:also\s+)?(?:need|want|would\s+like|request)\b|\b(?:please|kindly)\b/i;
  for (const match of source.matchAll(matcher)) {
    const index = Number(match.index || 0);
    const clauseStart = Math.max(
      source.lastIndexOf(".", index - 1),
      source.lastIndexOf("!", index - 1),
      source.lastIndexOf("?", index - 1),
      source.lastIndexOf(";", index - 1),
      source.lastIndexOf("。", index - 1),
      source.lastIndexOf("！", index - 1),
      source.lastIndexOf("？", index - 1),
      source.lastIndexOf("；", index - 1),
      source.lastIndexOf("\n", index - 1)
    );
    const nextBoundaries = [".", "!", "?", ";", "。", "！", "？", "；", "\n"]
      .map((delimiter) => source.indexOf(delimiter, index + String(match[0] || "").length))
      .filter((candidate) => candidate >= 0);
    const clauseEnd = nextBoundaries.length ? Math.min(...nextBoundaries) : source.length;
    const clause = source.slice(clauseStart + 1, clauseEnd);
    const matchOffset = index - clauseStart - 1;
    const before = clause.slice(Math.max(0, matchOffset - 180), matchOffset);
    const after = clause.slice(matchOffset + String(match[0] || "").length, matchOffset + 120);
    if (outputAction.test(before) || directRequest.test(before)) return true;
    if (
      /\b(?:as|into|to)\s+(?:an?\s+)?$/i.test(before) &&
      /\b(?:compile|convert|export|render|save)\b/i.test(clause)
    ) {
      return true;
    }
    if (
      /^\s*(?:output|deliverable|file|document|report|version|copy)\b/i.test(after) &&
      outputAction.test(clause)
    ) {
      return true;
    }
    if (/^\s*(?:please|required|requested)\b/i.test(after)) return true;
  }
  return false;
}

function artifactRequestHasOutputIntent(goal = "", taskProfile = "") {
  const source = stripForbiddenLanguage(String(goal || ""));
  return Boolean(
    goalRequestsFileMutation(source, taskProfile) ||
      /\b(?:create|deliver|export|generate|leave|make|output|prepare|produce|save|write)\b/i.test(
        source
      ) ||
      /\b(?:i|we)\s+(?:also\s+)?(?:need|want|would like)\b[^.\n;]{0,100}\b(?:answer|artifact|deck|document|handout|material|pdf|presentation|preview|report|sheet|slides?|workbook|worksheet)\b/i.test(
        source
      ) ||
      /\b(?:give|provide|return|send)\b[^.\n;]{0,80}\b(?:answer|artifact|deck|document|handout|material|pdf|presentation|preview|report|sheet|slides?|workbook|worksheet)\b/i.test(
        source
      ) ||
      /(?:创建|生成|输出|导出|保存|提供|需要|交付)/u.test(source)
  );
}

export function hostManagedDocumentCompilationRequested(goal = "") {
  const source = String(goal || "").replace(/\s+/gu, " ").trim();
  if (!source) return false;
  if (
    /\bdo\s+not\s+(?:invoke|run|use)\b[^.!?;。！？；]{0,180}\b(?:document\s+compiler|latexmk|pdflatex|xelatex|lualatex|latex|pandoc|make)\b[^.!?;。！？；]{0,180}\b(?:labcanvas\s+)?host\b/iu.test(
      source
    ) ||
    /(?:不要|不得|无需|不需要)(?:调用|运行|使用).{0,80}(?:LaTeX|latexmk|pdflatex|xelatex|文档编译器).{0,100}(?:由|交给)(?:\s*LabCanvas)?(?:主机|宿主)(?:编译|构建|渲染|验证)/u.test(
      source
    )
  ) {
    return true;
  }

  const ownershipPattern =
    /\b(?:the\s+)?(?:labcanvas\s+)?host(?:\s+(?:compiler|recovery|stage)){0,2}\s+(?:alone\s+)?(?:owns|handles?|performs?|will\s+(?:build|compile|handle|perform|render|validate))\b[^.!?;。！？；]{0,120}\b(?:compil(?:ation|e)|document|latex|pdf|render|validation)\b/giu;
  for (const match of source.matchAll(ownershipPattern)) {
    const prefix = source.slice(Math.max(0, Number(match.index || 0) - 180), Number(match.index || 0));
    if (
      /\b(?:if|when)\b[^.!?;。！？；]{0,140}\b(?:cannot|can't|fails?|failure|unavailable|unsupported)\b/iu.test(
        prefix
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function inferRequestedArtifactRequirements(goal = "", taskProfile = "") {
  const source = stripForbiddenLanguage(String(goal || ""));
  if (!artifactRequestHasOutputIntent(source, taskProfile)) return [];
  const hostManagedCompilation = hostManagedDocumentCompilationRequested(goal);

  const requirements = [];
  const add = (requirement) => {
    if (!requirement?.id || requirements.some((item) => item.id === requirement.id)) return;
    requirements.push(requirement);
  };

  for (const format of REQUESTED_ARTIFACT_FORMATS) {
    if (hostManagedCompilation && format.extension === ".pdf") continue;
    if (!requestedArtifactFormatHasOutputIntent(source, format)) continue;
    add({
      id: `format:${format.extension}`,
      kind: "format",
      extension: format.extension,
      description: format.description,
    });
  }

  const deckRequested = /\b(?:deck|presentation|slides?|slide deck|lecture deck)\b/i.test(source);
  const editableRequested = /\b(?:editable|edit-friendly|native(?:ly)? editable)\b/i.test(source);
  if (deckRequested && editableRequested) {
    add({
      id: "editable-presentation",
      kind: "editable-presentation",
      extensions: [".pptx", ".odp", ".key"],
      description: "editable presentation deck",
    });
  }

  if (
    !hostManagedCompilation &&
    /\bprintable\b/i.test(source) &&
    /\b(?:answer|deck|document|handout|material|practice|sheet|slides?|worksheet)\b/i.test(source)
  ) {
    add({
      id: "printable-document",
      kind: "printable-document",
      extensions: [".pdf"],
      description: "printable PDF material",
    });
  }

  if (
    /\b(?:helpful|high[- ]resolution|useful|visual)\s+preview\b|\b(?:image|png|rendered|screenshot)\s+preview\b|\bpreview\s+(?:image|png|render|screenshot)\b/i.test(
      source
    )
  ) {
    add({
      id: "visual-preview",
      kind: "visual-preview",
      extensions: [".png", ".jpg", ".jpeg", ".webp"],
      description: "visual preview image",
    });
  }

  if (/\b(?:practice sheet|worksheet|exercise sheet|learner handout)\b/i.test(source)) {
    add({
      id: "practice-material",
      kind: "practice-material",
      description: "separate practice or worksheet material",
    });
  }

  if (
    /\b(?:answer\s+key|worked\s+solutions?|solutions?\s+(?:key|sheet|document|file|material)|answers?\s+(?:key|sheet|document|file|material))\b/i.test(
      source
    )
  ) {
    add({
      id: "answer-material",
      kind: "answer-material",
      description: "separate answer or solution material",
    });
  }

  if (
    /\b(?:reproducible|repeatable)\b[^.\n;]{0,80}\b(?:build|generation|export|render)\b|\b(?:build|generation|export|render)\s+(?:entrypoint|script|command)\b/i.test(
      source
    )
  ) {
    add({
      id: "reproducible-build-entrypoint",
      kind: "reproducible-build-entrypoint",
      description: "reproducible build or export entrypoint",
    });
  }

  return requirements.slice(0, 16);
}

function normalizedContractPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/workspace\//, "")
    .replace(/\/+$/, "");
}

function contractPathMatchesExclusion(value = "", exclusion = "") {
  const candidate = normalizedContractPath(value).toLocaleLowerCase("en-US");
  const excluded = normalizedContractPath(exclusion).toLocaleLowerCase("en-US");
  if (!candidate || !excluded) return false;
  if (candidate === excluded || candidate.endsWith(`/${excluded}`)) return true;
  if (!excluded.includes("/")) return path.posix.basename(candidate) === excluded;
  if (!candidate.includes("/")) return path.posix.basename(excluded) === candidate;
  return false;
}

export function filterExplicitlyExcludedOutputPaths(paths = [], exclusions = []) {
  const blocked = unique((Array.isArray(exclusions) ? exclusions : []).map(normalizedContractPath));
  return unique((Array.isArray(paths) ? paths : []).filter((candidate) =>
    !blocked.some((exclusion) => contractPathMatchesExclusion(candidate, exclusion))
  ));
}

export function inferExplicitlyExcludedOutputPaths(goal = "") {
  const extensionPattern = "md|txt|json|jsonl|ndjson|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx";
  // Preserve coordinated path lists that wrap after a comma. Prompt and task
  // files commonly format "do not modify a, b,\nc, or d" across lines; splitting
  // that text first drops the governing negative action from the continuation.
  const negativePrefix = "(?:do\\s+not|don't|dont|must\\s+not|should\\s+not|never)";
  const negativeAction = "(?:run|rerun|re-run|execut(?:e|ed|ing)|creat(?:e|ed|ing)|recreat(?:e|ed|ing)|writ(?:e|ten|ing)|generat(?:e|ed|ing)|sav(?:e|ed|ing)|output|touch|modif(?:y|ied|ying)|edit(?:ed|ing)?|stage|commit)";
  const wrappedNegativeAction = new RegExp(
    `(\\b${negativePrefix}\\b)\\s*\\r?\\n\\s*(?=${negativeAction}\\b)`,
    "giu"
  );
  const wrappedNegativePath = new RegExp(
    `(\\b${negativePrefix}\\b[^.!?。！？;；\\n]{0,180}\\b${negativeAction}\\b)\\s*\\r?\\n\\s*` +
      `(?=\\S{1,260}\\.(?:${extensionPattern})\\b)`,
    "giu"
  );
  const source = normalizeWrappedNegativePrefixes(goal)
    .replace(/([,，、])\s*\r?\n\s*/gu, "$1 ")
    .replace(wrappedNegativeAction, "$1 ")
    .replace(wrappedNegativePath, "$1 ");
  if (!source.trim()) return [];
  const pathPattern = new RegExp(
    '((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,260}\\.(?:' +
      extensionPattern +
      '))',
    "gi"
  );
  const negativeActionBefore =
    /\b(?:do\s+not|don't|dont|must\s+not|should\s+not|never)\b[^.!?。！？;；\n]{0,180}\b(?:run|rerun|re-run|execut(?:e|ed|ing)|creat(?:e|ed|ing)|recreat(?:e|ed|ing)|writ(?:e|ten|ing)|generat(?:e|ed|ing)|sav(?:e|ed|ing)|output|touch|modif(?:y|ied|ying)|edit(?:ed|ing)?|stage|commit)(?:\b|\s)/i;
  // Post-path restrictions must describe the path that came immediately
  // before them. Imperative forms such as "and do not create" take the next
  // path as their object, so treating them as postfix restrictions leaks a
  // later exclusion backwards across coordinated clauses.
  const negativeActionAfter =
    /^\s*(?:(?:does\s+not|doesn't|is\s+not|isn't)\s+exist\b\s*(?:and\s+)?)?(?:must\s+not|should\s+not|never)\s+(?:be\s+)?(?:run|rerun|re-run|execut(?:e|ed)|creat(?:e|ed)|recreat(?:e|ed)|writ(?:e|ten)|generat(?:e|ed)|sav(?:e|ed)|output|touch(?:ed)?|modif(?:y|ied)|edit(?:ed)?|stag(?:e|ed)|commit(?:ted)?)(?:\b|\s)/i;
  const keepAbsent =
    /\b(?:keep|leave)\b[^.!?。！？;；\n]{0,80}\b(?:absent|missing|nonexistent|uncreated|untouched)\b/i;
  const cjkNegativeActionBefore =
    /(?:不要|不得|禁止|无需|不需要)[^。！？；\n]{0,140}(?:运行|执行|重跑|创建|建立|写入|生成|保存|输出|修改|编辑|提交|暂存)/u;
  const cjkNegativeActionAfter =
    /^(?:(?:不得|禁止|不要)(?:被)?(?:运行|执行|重跑|创建|建立|写入|生成|保存|输出|修改|编辑|提交|暂存)|(?:を)?(?:作成|生成|実行|再実行|保存|編集|変更|コミット)[^。！？；\n]{0,40}(?:しない|しなくてよい|してはいけない))/u;
  const directRemovalBefore =
    /\b(?:remove|delete|unlink|discard)\s+(?:(?:the|an?|this|that)\s+)?(?:(?:accidental|stale|temporary|untracked|generated|obsolete|old|private|empty)\s+)*(?:file\s+)?$/i;
  const cjkDirectRemovalBefore =
    /(?:删除|刪除|移除|清除)(?:(?:这个|這個|该|該|意外的|暂存的|暫存的|临时的|臨時的|未跟踪的|未追蹤的|旧的|舊的|私有的)\s*)*(?:文件)?\s*$/u;
  const excluded = [];
  for (const clause of source.split(/[;；\n]|(?<=[.!?。！？])\s+/u)) {
    pathPattern.lastIndex = 0;
    const matches = [...clause.matchAll(pathPattern)];
    const immutablePathClause = Boolean(
      /\b(?:treat|consider|regard)\b[^!?。！？;；\n]{0,260}\b(?:as\s+)?(?:immutable|read[ -]?only)\b/i.test(
        clause
      )
    );
    let previousExcluded = false;
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex];
      const rawPath = String(match[1] || "");
      const index = Number(match.index || 0);
      const previous = matches[matchIndex - 1];
      const next = matches[matchIndex + 1];
      const previousEnd = previous
        ? Number(previous.index || 0) + String(previous[1] || "").length
        : Math.max(0, index - 220);
      const nextStart = next
        ? Number(next.index || clause.length)
        : Math.min(clause.length, index + rawPath.length + 220);
      const before = clause.slice(previousEnd, index);
      const after = clause.slice(index + rawPath.length, nextStart);
      const coordinatedWithExcludedPrevious = Boolean(
        previousExcluded &&
          /^\s*(?:(?:,|、|，)\s*)?(?:and|or|和|及|以及|或|又は|および)?\s*$/iu.test(
            before
          )
      );
      const directExclusion = Boolean(
        immutablePathClause ||
        negativeActionBefore.test(before) ||
        negativeActionAfter.test(after) ||
        keepAbsent.test(`${before}${after}`) ||
        cjkNegativeActionBefore.test(before) ||
        cjkNegativeActionAfter.test(after) ||
        directRemovalBefore.test(before) ||
        cjkDirectRemovalBefore.test(before)
      );
      previousExcluded = directExclusion || coordinatedWithExcludedPrevious;
      if (previousExcluded) {
        excluded.push(rawPath);
      }
    }
  }
  return uniqueLimited(excluded.map(normalizedContractPath), 24);
}

function inferExactInputPaths(goal = "") {
  const paths = [];
  const lines = String(goal || "").split(/\n/);
  const extensionPattern = "md|txt|json|jsonl|ndjson|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx";
  const quotedPathPattern = new RegExp("[\"'`]([^\"'`\\n]{1,260}\\.(?:" + extensionPattern + "))[\"'`]", "gi");
  const pathPattern = new RegExp(
    '(?:^|[\\s：:,，、])((?:~|\\.{1,2}|/|[A-Za-z0-9_\\-\\u4e00-\\u9fff])[\\w./~\\-\\u4e00-\\u9fff]{0,260}\\.(?:' +
      extensionPattern +
      '))(?=$|[\\s"\'`,，、。；;.!?！？])',
    "gi"
  );
  const inputAction =
    /\b(?:use|using|read|load|fill|upload|attach|import|select|choose|reference|input|from|retain(?:ed|ing)?|fix|repair|patch|correct)\b|使用|读取|讀取|加载|載入|填写|填入|上传|上傳|附加|导入|導入|选择|選擇|选取|選取|参考|參考|素材|图片|圖片|照片|提示词|提示詞|保留|修复|修正|更正|从|從/i;
  const directOutputAction =
    /\b(?:sav(?:e|es|ing)|writ(?:e|es|ing)|rewrit(?:e|es|ing)|output(?:s|ting)?|creat(?:e|es|ing)|rebuild(?:s|ing)?|replac(?:e|es|ing)|regenerat(?:e|es|ing)|generat(?:e|es|ing)|stor(?:e|es|ing)|updat(?:e|es|ing)|modif(?:y|ies|ying)|edit(?:s|ing)?)\b|保存|写入|寫入|重写|重寫|输出|輸出|创建|建立|重建|替换|替換|重新生成|生成|更新|修改|编辑|編輯/i;
  const pushPath = (raw = "") => {
    const cleaned = String(raw || "").trim();
    if (!cleaned || /[{}]/.test(cleaned)) return;
    paths.push(cleaned);
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const currentLine = String(rawLine || "").trim();
    const previousLine = String(lines[lineIndex - 1] || "").trim();
    const wrappedInputInstruction =
      previousLine &&
      !/[.!?。！？;；]$/.test(previousLine) &&
      inputAction.test(previousLine);
    const fullLine = wrappedInputInstruction ? `${previousLine} ${currentLine}`.trim() : currentLine;
    const outputIndex = fullLine.search(directOutputAction);
    const line = outputIndex > 0 ? fullLine.slice(0, outputIndex).trim() : fullLine;
    if (!line || !inputAction.test(line)) continue;
    if (directOutputAction.test(line) && !/\b(read|load|upload|attach|reference|input|from)\b|读取|讀取|加载|載入|上传|上傳|附加|参考|參考|素材|图片|圖片|照片|提示词|提示詞|从|從/i.test(line)) {
      continue;
    }
    quotedPathPattern.lastIndex = 0;
    for (const match of line.matchAll(quotedPathPattern)) {
      if (looksLikeShellCommandLiteral(match[1])) continue;
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
      !/\.(?:md|txt|json|jsonl|ndjson|ya?ml|html|css|js|ts|tsx|jsx|py|sh|csv|tex|svg|png|jpe?g|webp|mp4|mov|pdf|docx)$/i.test(candidate)
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
  return uniqueLimited(
    terms.filter((term) => {
      const cleaned = String(term).trim();
      return !outputPathTerms.has(cleaned) && !looksLikeShellCommandLiteral(cleaned);
    }),
    24
  );
}

const EXECUTABLE_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);

function sourcePathCanSatisfyExecutableRequirement(value = "") {
  const normalized = String(value || "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  if (!EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(basename).toLowerCase())) return false;
  if (/(?:^|\/)(?:tests?|specs?|fixtures?|__tests__)(?:\/|$)/i.test(normalized)) return false;
  if (/^(?:test_|spec_)|(?:\.(?:test|spec))\.[^.]+$/i.test(basename)) return false;
  return !/(?:^|\/)(?:\.git|\.aginti|\.aginti-sessions|\.agintiflow)(?:\/|$)/i.test(normalized);
}

function executableRequirementIsNegated(source = "", index = 0) {
  const prefix = String(source || "").slice(Math.max(0, index - 100), index);
  return /(?:\b(?:do not|don't|dont|must not|never|avoid|remove|omit|forbid)\b|不要|不得|禁止|避免|移除|削除|使わない)[^.!?。！？;；\n]{0,60}$/iu.test(prefix);
}

export function inferRequiredExecutableTerms(goal = "") {
  const source = String(goal || "");
  const terms = [];
  const assignmentPattern = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(True|False|None|null|true|false|[+-]?\d+(?:\.\d+)?)\b/g;
  for (const match of source.matchAll(assignmentPattern)) {
    const index = Number(match.index || 0);
    if (executableRequirementIsNegated(source, index)) continue;
    if (indexFallsInsideInlineCommand(source, index)) continue;
    const window = source.slice(Math.max(0, index - 180), Math.min(source.length, index + match[0].length + 220));
    const structuredDataLiteral =
      /\b(?:csv|json|toml|ya?ml)\b/i.test(window) &&
      !/\b(?:actual|canonical|executable|implementation|source\s+code|function|call|argument|parameter|repair|fix|replace)\b/i.test(
        window
      );
    if (structuredDataLiteral) continue;
    const implementationRequirement =
      /\b(?:actual|canonical|executable|implementation|source|code|call|argument|keyword|parameter|repair|fix|correct|replace|add|set|pass|use|must|required)\b/iu.test(window) ||
      /实际|實際|实现|實現|源码|源碼|代码|代碼|调用|調用|参数|參數|修复|修復|改正|替换|替換|添加|设置|設定|使用|必须|必須|実装|ソース|コード|呼び出し|引数|修正|置換|追加|設定|使用/.test(window);
    if (!implementationRequirement) continue;
    terms.push(`${match[1]}=${match[2]}`);
  }
  return uniqueLimited(terms, 16);
}

export function stripNonExecutableSourceText(content = "", extension = "") {
  const source = String(content || "");
  const suffix = String(extension || "").toLowerCase();
  const hashComments = new Set([".py", ".rb", ".sh"]);
  const slashComments = new Set([
    ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts",
    ".mjs", ".php", ".rs", ".swift", ".ts", ".tsx",
  ]);
  const output = [...source];
  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    const triple = source.slice(index, index + 3);
    if (hashComments.has(suffix) && char === "#") {
      while (index < source.length && source[index] !== "\n") blank(index++);
      continue;
    }
    if (slashComments.has(suffix) && pair === "//") {
      while (index < source.length && source[index] !== "\n") blank(index++);
      continue;
    }
    if (slashComments.has(suffix) && pair === "/*") {
      blank(index++);
      blank(index++);
      while (index < source.length && source.slice(index, index + 2) !== "*/") blank(index++);
      if (index < source.length) {
        blank(index++);
        blank(index++);
      }
      continue;
    }
    const isPythonTriple = suffix === ".py" && (triple === "'''" || triple === '\"\"\"');
    if (isPythonTriple) {
      const delimiter = triple;
      for (let offset = 0; offset < 3; offset += 1) blank(index++);
      while (index < source.length && source.slice(index, index + 3) !== delimiter) blank(index++);
      for (let offset = 0; offset < 3 && index < source.length; offset += 1) blank(index++);
      continue;
    }
    if (char === "'" || char === '\"' || char === "`") {
      const delimiter = char;
      blank(index++);
      while (index < source.length) {
        const current = source[index];
        blank(index++);
        if (current === "\\" && index < source.length) {
          blank(index++);
          continue;
        }
        if (current === delimiter) break;
      }
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function requiredExecutableTermPattern(term = "") {
  const match = String(term || "").match(/^([A-Za-z_][A-Za-z0-9_.]*)=(True|False|None|null|true|false|[+-]?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const escapedName = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = match[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escapedName}\\s*=\\s*${escapedValue}(?![A-Za-z0-9_])`, "m");
}

function executableSourcePaths(contract = {}, { commandCwd = process.cwd(), events = [], state = {} } = {}) {
  const paths = [];
  const append = (value = "") => {
    const normalized = normalizedContractPath(value);
    if (!normalized || !sourcePathCanSatisfyExecutableRequirement(normalized) || paths.includes(normalized)) return;
    const absolute = resolveContractPath(commandCwd, normalized);
    const relative = path.relative(path.resolve(commandCwd), absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
    paths.push(normalized);
  };
  for (const value of contract.exactOutputPaths || []) append(value);
  for (const mutation of state.meta?.projectVerification?.mutationHistory || []) {
    for (const value of mutation?.paths || []) append(value);
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "file.changed") append(event.data?.path || event.data?.file);
    if (event?.type !== "tool.completed") continue;
    append(event.data?.path || event.data?.args?.path);
    for (const change of event.data?.changes || []) append(change?.path || change?.file);
  }
  return paths.slice(0, 32);
}

function evaluateRequiredExecutableTerms(contract = {}, options = {}) {
  const requiredExecutableTerms = Array.isArray(contract.requiredExecutableTerms)
    ? contract.requiredExecutableTerms.filter(Boolean)
    : [];
  if (!requiredExecutableTerms.length) {
    return {
      ok: true,
      checked: false,
      requiredExecutableTerms: [],
      missingExecutableTerms: [],
      executableSourcePaths: [],
      reason: "No executable-source term was inferred.",
    };
  }
  const commandCwd = options.commandCwd || process.cwd();
  const sourcePaths = executableSourcePaths(contract, options);
  const sources = sourcePaths.flatMap((rawPath) => {
    const absolutePath = resolveContractPath(commandCwd, rawPath);
    try {
      const content = fs.readFileSync(absolutePath, "utf8");
      return [{
        rawPath,
        executableContent: stripNonExecutableSourceText(content, path.extname(rawPath)),
      }];
    } catch {
      return [];
    }
  });
  const missingExecutableTerms = requiredExecutableTerms.filter((term) => {
    const pattern = requiredExecutableTermPattern(term);
    return !pattern || !sources.some((source) => pattern.test(source.executableContent));
  });
  return {
    ok: missingExecutableTerms.length === 0,
    checked: true,
    requiredExecutableTerms,
    missingExecutableTerms,
    executableSourcePaths: sources.map((source) => source.rawPath),
    reason: missingExecutableTerms.length
      ? `Required executable source expression(s) were absent from task-mutated production source (comments, strings, help text, and tests do not count): ${missingExecutableTerms.join(", ")}.`
      : "Required executable source expressions are present in task-mutated production source.",
  };
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
  const reason = String(payload.reason || payload.error || advice.reason || "");
  const recoverableWorkspaceFailure =
    toolName === "apply_patch" &&
    /(?:patch search text was not found|base hash mismatch|patch expected \d+ replacement|patch would replace too many sections|patch search text is required)/i.test(
      reason
    );
  if (
    payload.recoverable === true ||
    advice.autoRecover === true ||
    recoverableWorkspaceFailure ||
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

function blockerPayloadIdentity(payload = {}) {
  if (!payload || typeof payload !== "object") return "";
  const advice =
    payload.permissionAdvice && typeof payload.permissionAdvice === "object"
      ? payload.permissionAdvice
      : {};
  const toolName = String(payload.toolName || payload.name || "").trim().toLowerCase();
  const reason = String(payload.reason || payload.error || advice.reason || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return toolName && reason ? `${toolName}\u0000${reason}` : "";
}

function currentBlockersFromEntries(entries = [], source = "tool") {
  const blockers = new Map();
  let anonymousIndex = 0;
  for (const entry of entries) {
    const payload = entry && typeof entry === "object" ? entry : {};
    const identity = blockerPayloadIdentity(payload) || `anonymous-${anonymousIndex++}`;
    const blocker = blockerFromPayload(payload, source);
    if (blocker) blockers.set(identity, blocker);
    else blockers.delete(identity);
  }
  return [...blockers.values()];
}

function textHas(text, regex) {
  return regex.test(String(text || ""));
}

function normalizedText(...parts) {
  return parts.map((part) => {
    if (part === null || part === undefined) return "";
    if (typeof part !== "object") return String(part);
    try {
      return JSON.stringify(part);
    } catch {
      return "";
    }
  }).join("\n").toLowerCase();
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
  const structuredDataProse = text.replace(
    /(?:^|[\s`'"(])[^\s`'"()]+\.(?:csv|json|toml|ya?ml)\b/g,
    " "
  );
  const simpleStructuredDataWrite =
    /\.(?:csv|json|toml|ya?ml)\b/.test(text) &&
    /\b(?:create|emit|generate|save|write)\b/.test(text) &&
    !/\b(?:app|application|build|cli|code|codebase|compile|execute|function|implement|library|lint|package|refactor|run|script|server|source|test|typecheck)\b/.test(
      structuredDataProse
    );
  const substantiveCodeWork =
    /\b(?:fix|repair|bug|implement|feature|refactor|test|run|build|compile|lint|typecheck|verify|validate|package|library|cli|api server|app|application|script|codebase|src\/|source code)\b/.test(
      text
    ) ||
    /\.(?:js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|hpp|sh)\b/.test(text);
  return substantiveCodeWork && !simpleDocumentWrite && !simpleStructuredDataWrite;
}

function goalRequestsExplicitTestMutation(text = "") {
  return (
    /\b(?:add|create|implement|write)\b(?:\s+(?:a|an|the|focused|new|additional|specific|security|unit|integration|regression))*\s+(?:regression\s+)?(?:tests?|test cases?)\b/.test(
      text
    ) ||
    /\b(?:edit|fix|modify|patch|repair|update)\b(?:\s+(?:a|an|the|focused|new|existing|current|failing|specific|security|unit|integration|regression))*\s+(?:regression\s+)?(?:tests?|test cases?)\b/.test(
      text
    ) ||
    /(?:添加|新增|创建|编写|编辑|修复|修改|更新)(?:一个|新的|现有的|失败的|专门的|回归|单元|集成)*测试(?:用例)?/.test(
      text
    )
  );
}

function stripHostManagedResponseNarration(goal = "") {
  return String(goal || "").replace(
    /\b(?:and\s+)?(?:write|return|provide)\s+(?:(?:a|the)\s+)?(?:(?:concise|final|normal|structured)\s+)?(?:(?:agent|task)\s+)?(?:answer|response|result)\b(?!\s+(?:as|at|file|in|into|json|markdown|pdf|text|to|under)\b)/gi,
    ""
  ).replace(
    /\b(?:create|draft|generate|produce|prepare)\s+(?:(?:a|an|the|one)\s+)?[^.\n;]{0,120}?\b(?:answer|response|reply|message|inspiration(?:\s+point)?|summary|chat\s+text)\b/gi,
    ""
  ).replace(
    /\b(?:correct|fix|repair|replace|revise|rewrite|regenerate|update)\s+(?:(?:a|an|the)\s+)?(?:(?:prior|previous|earlier|last|current|invalid|incorrect|bad|old|failed)\s+)*(?:answer|response|reply|message|inspiration|summary|chat\s+text)\b/gi,
    ""
  );
}

function goalRequestsWorkspaceMutation(goal = "", taskProfile = "") {
  const text = normalizedText(
    stripHostManagedResponseNarration(
      stripCompletedWorkNarration(stripForbiddenLanguage(goal))
    )
  );
  const explicitAddMutation =
    goalRequestsExplicitTestMutation(text) ||
    /\badd\b(?:\s+(?:a|an|the|new|additional|specific))*\s+(?:code|documents?|files?|notes?|readme|scripts?|source|workspace)\b/.test(
      text
    ) || /(?:添加|新增)(?:一个|新的|额外的|特定的)*(?:文件|文档|代码|脚本|源码)/.test(text);
  if (String(taskProfile || "").trim().toLowerCase() === "review") {
    return (
      explicitAddMutation ||
      /\b(?:append|copy|create|delete|edit|fix|implement|modify|move|patch|refactor|remove|rename|repair|replace|rewrite|save|update|write)\b/.test(
        text
      )
    );
  }
  return (
    explicitAddMutation ||
    /\b(?:append|build|convert|copy|create|delete|edit|fix|generate|implement|modify|move|patch|refactor|remove|rename|repair|replace|rewrite|save|update|write)\b/.test(
      text
    ) ||
    /创建|写入|编辑|修复|实现|修改|更新|生成|保存|复制|移动|转换|删除|重命名|替换|追加/.test(text)
  );
}

function goalRequestsFileMutation(goal = "", taskProfile = "") {
  const text = normalizedText(stripCompletedWorkNarration(stripForbiddenLanguage(goal)));
  if (!goalRequestsWorkspaceMutation(text, taskProfile)) return false;
  const explicitTestMutation = goalRequestsExplicitTestMutation(text);
  return (
    explicitTestMutation ||
    /\b(?:code|codebase|document(?:ation)?|files?|notes?|path|readme|repo(?:sitory)?|script|source|workspace)\b/.test(
      text
    ) ||
    /(?:^|[\s`'"(])(?:\.{0,2}\/|\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.{}-]+)+/i.test(text) ||
    /\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|html?|java|js|jsx|json|kt|md|mjs|php|py|rb|rs|sh|swift|tex|ts|tsx|txt|ya?ml)\b/i.test(
      text
    ) ||
    /文件|文档|代码|代码库|仓库|脚本|源码|路径|工作区|说明书|笔记/.test(text)
  );
}

function goalRequestsScopedArtifactDeliverable(goal = "") {
  const text = normalizedText(stripCompletedWorkNarration(stripForbiddenLanguage(goal)));
  const deliverable =
    /\b(?:build|compile|create|draft|export|generate|make|prepare|produce|render|save|write)\b[^.\n;]{0,180}\b(?:artifact|brief|cad|diagram|document|figure|image|markdown|memo|model|note|paper|pcb|pdf|presentation|prompt|report|research note|slide deck|slides?|spreadsheet|story|summary|transcript|video)\b/.test(text) ||
    /\b(?:artifact|brief|cad|diagram|document|figure|image|markdown|memo|model|note|paper|pcb|pdf|presentation|prompt|report|research note|slide deck|slides?|spreadsheet|story|summary|transcript|video)\b[^.\n;]{0,120}\b(?:build|compile|create|draft|export|generate|make|prepare|produce|render|save|write)\b/.test(text) ||
    /(?:创建|生成|保存|编写|撰写|制作|导出|准备)[^。；\n]{0,100}(?:报告|笔记|摘要|文档|论文|图表|图片|模型|演示文稿|幻灯片|表格|故事|提示词|转录|视频)/.test(text);
  if (!deliverable) return false;
  const projectSourceMutation =
    /\b(?:change|debug|edit|fix|implement|improve|modify|patch|refactor|repair|replace|rewrite|update)\b[^.\n;]{0,140}\b(?:app|application|code|codebase|implementation|library|package|repo|repository|runtime|source|src\/)\b/.test(text) ||
    /\b(?:app|application|code|codebase|implementation|library|package|repo|repository|runtime|source|src\/)\b[^.\n;]{0,140}\b(?:change|debug|edit|fix|implement|improve|modify|patch|refactor|repair|replace|rewrite|update)\b/.test(text) ||
    /(?:修改|修复|实现|改进|重构|调试|替换|更新)[^。；\n]{0,100}(?:代码|代码库|实现|运行时|应用|仓库|源码)/.test(text);
  return !projectSourceMutation;
}

function goalRequestsScopedArtifactOperation(goal = "") {
  const text = normalizedText(stripCompletedWorkNarration(stripForbiddenLanguage(goal)));
  const artifactOperation =
    /\b(?:build|compile|create|draft|edit|export|generate|make|prepare|produce|render|repair|revise|save|update|write)\b[^.\n;]{0,180}\b(?:artifact|brief|cad|diagram|document|figure|image|markdown|memo|model|note|paper|pcb|pdf|presentation|prompt|report|research note|slide deck|slides?|spreadsheet|story|summary|transcript|video)\b/.test(text) ||
    /\b(?:artifact|brief|cad|diagram|document|figure|image|markdown|memo|model|note|paper|pcb|pdf|presentation|prompt|report|research note|slide deck|slides?|spreadsheet|story|summary|transcript|video)\b[^.\n;]{0,120}\b(?:build|compile|create|draft|edit|export|generate|make|prepare|produce|render|repair|revise|save|update|write)\b/.test(text) ||
    /(?:创建|生成|保存|编写|撰写|制作|导出|准备|修改|修订|修复|更新)[^。；\n]{0,100}(?:报告|笔记|摘要|文档|论文|图表|图片|模型|演示文稿|幻灯片|表格|故事|提示词|转录|视频)/.test(text);
  if (!artifactOperation) return false;
  const projectSourceMutation =
    /\b(?:change|debug|edit|fix|implement|improve|modify|patch|refactor|repair|replace|rewrite|update)\b[^.\n;]{0,140}\b(?:app|application|code|codebase|implementation|library|package|repo|repository|runtime|source\s+code|src\/)\b/.test(text) ||
    /\b(?:app|application|code|codebase|implementation|library|package|repo|repository|runtime|source\s+code|src\/)\b[^.\n;]{0,140}\b(?:change|debug|edit|fix|implement|improve|modify|patch|refactor|repair|replace|rewrite|update)\b/.test(text) ||
    /(?:修改|修复|实现|改进|重构|调试|替换|更新)[^。；\n]{0,100}(?:代码|代码库|实现|运行时|应用|仓库|源码)/.test(text);
  return !projectSourceMutation;
}

function goalRequestsTestExecution(goal = "") {
  const text = normalizedText(stripCompletedWorkNarration(stripForbiddenLanguage(goal)));
  return (
    /\b(?:run|rerun|re-run|execute|invoke)\b[^.\n;]{0,140}\b(?:tests?|test suite)\b/.test(text) ||
    /\b(?:tests?|test suite)\b[^.\n;]{0,120}\b(?:pass|passing|green|run|rerun|re-run|execute)\b/.test(text) ||
    /(?:运行|执行|重跑|重新运行)[^。；\n]{0,100}(?:测试|测试套件)|(?:测试|测试套件)[^。；\n]{0,80}(?:通过|运行|执行)/.test(
      text
    )
  );
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
  let requirements = [...defaults];
  if (!goalRequestsFileMutation(goal)) {
    requirements = requirements.filter((category) => category !== "file");
  }
  if (!codeProfileRequiresCommand(goal)) {
    requirements = requirements.filter((category) => category !== "command");
  }
  return requirements;
}

function isReadOnlyReadinessTask(goal = "") {
  const text = String(goal || "");
  const readinessSignal =
    /\b(?:inspect|audit|assess|document|report on|verify)\s+(?:whether|if|the\s+(?:current\s+)?(?:readiness|capability|workflow|interface))\b/i.test(text) ||
    /\b(?:readiness|capability)\s+(?:audit|check|report|assessment)\b/i.test(text) ||
    /\bwhether\s+(?:i|we|the\s+(?:agent|system))\s+can\b/i.test(text) ||
    /只读检查|只讀檢查|就绪检查|就緒檢查|能力检查|能力檢查|检查是否|檢查是否/.test(text);
  const contractAuditSignal =
    /\b(?:audit|inspect|review|assess|document|report\s+on)\s+(?:the\s+)?(?:current\s+)?[^.\n;]{0,140}\b(?:contract|policy|behavio(?:u)?r|workflow|implementation|routine|routing|readiness|capabilit(?:y|ies))\b/i.test(
      text
    ) ||
    /(?:审计|審計|检查|檢查|审查|審查|评估|評估|记录|記錄)[^。；\n]{0,120}(?:契约|契約|策略|行为|行為|流程|实现|實現|例程|路由|就绪|就緒|能力)/.test(
      text
    );
  const noActionSignal =
    /\b(?:do not|don't|dont|never|without)\b[^.\n;]{0,260}\b(?:send|generate|submit|upload|publish|deploy|open|browse|focus|restart|alter|change|edit|modify|write|mutate|delete|purchase|pay|log in|login)\b/i.test(text) ||
    /(?:不要|禁止)[^。\n；]{0,260}(?:生成|提交|上传|上傳|发布|發布|部署|登录|登入|重启|重啟|编辑|編輯|修改|删除|刪除|购买|購買|支付)/.test(text);
  return (readinessSignal || contractAuditSignal) && noActionSignal;
}

function requiresSourceGrounding(goal = "") {
  const text = String(goal || "");
  const positiveText = stripForbiddenLanguage(text);
  const inferredOutputs = new Set(inferExactOutputPaths(positiveText));
  const explicitSourceInputs = inferExactInputPaths(positiveText).filter(
    (item) => !inferredOutputs.has(item)
  );
  const explicitlyRequestedInputRead = Boolean(
    /\b(?:read|inspect|review|audit|consult|examine)\b/iu.test(positiveText) &&
      explicitSourceInputs.length > 0
  );
  return (
    explicitlyRequestedInputRead ||
    isReadOnlyReadinessTask(text) ||
    /\b(?:re-?read|read|inspect|review|audit)\b[^.\n;]{0,120}\b(?:repository|project|workspace)\b[^.\n;]{0,120}\b(?:requirements?|instructions?|implementation|source|tests?)\b/i.test(
      text
    ) ||
    /\b(?:exact|current|mature|proven|verified|source[- ]grounded|documented)\b[^.\n;]{0,120}\b(?:commands?|interfaces?|workflows?|routines?|readiness|capabilit(?:y|ies))\b/i.test(
      text
    ) ||
    /\b(?:verify|inspect|audit|check)\b[^.\n;]{0,120}\b(?:rather than guess|without guessing|from (?:the )?(?:source|docs?|help))\b/i.test(
      text
    ) ||
    (/准确|精确|当前|成熟|已验证|有依据|不要猜|避免猜测/.test(text) && /命令|接口|流程|例程|就绪|能力/.test(text)) ||
    (/(?:重新)?(?:阅读|讀取|检查|檢查|审查|審查)/.test(text) &&
      /(?:仓库|倉庫|项目|項目|工作区|工作區)/.test(text) &&
      /(?:要求|说明|說明|实现|實現|源码|源碼|测试|測試)/.test(text))
  );
}

function goalRequestsPublishAction(goal = "") {
  const text = normalizedText(stripCompletedWorkNarration(stripForbiddenLanguage(goal)));
  const action =
    "(?:publish|deploy|submit|upload\\s+to|generate\\s+(?:a\\s+)?video|npm\\s+publish)";
  const release =
    "(?:release|ship)(?:\\s+(?:(?:the|this|that|a|an)\\s+)?(?:package|version|build|app|application|software|library|plugin|extension|product)|\\s+(?:to|on|via|through))|cut\\s+(?:a\\s+)?release";
  const clauses = text
    .split(/[\n.!?;，；。！？]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (
      new RegExp(
        `^(?:(?:and|also|then|next|finally|please|kindly)\\s+)*(?:${action}|${release})\\b`,
        "i"
      ).test(clause)
    ) {
      return true;
    }
    if (
      new RegExp(
        `\\b(?:(?:can|could|would|will)\\s+you|(?:i|we)\\s+(?:need|want|would\\s+like)\\s+(?:you\\s+)?to|you\\s+(?:must|should|need\\s+to|have\\s+to)|please|kindly|then|next|finally)\\b[^.\\n;]{0,140}\\b(?:${action}|${release})\\b`,
        "i"
      ).test(clause)
    ) {
      return true;
    }
  }
  return (
    /(?:请|請|需要|必须|必須|帮我|幫我|立即|现在|現在)[^。；\n]{0,100}(?:发布|發布|部署|提交|上传|上傳|生成视频|生成影片)/u.test(
      text
    ) || /^(?:发布|發布|部署|提交|上传|上傳|生成视频|生成影片)/u.test(text)
  );
}

function inferRequirementCategories(goal = "", taskProfile = "", acceptanceCriteria = []) {
  const positiveGoal = stripForbiddenLanguage(goal);
  const text = normalizedText(positiveGoal);
  const artifactSignalText = text
    .replace(
      /\b(?:clean(?:\s+up)?|remove|delete|clear|purge)\b[^.\n;]{0,120}\b(?:(?:disposable|generated|temporary|stale|test|build)\s+){0,4}(?:debris|caches?|byproducts?|outputs?|artifacts?|files?|directories?|folders?)\b/gi,
      ""
    )
    .replace(
      /\b(?:ignore|exclude|omit|skip|leave\s+out)\b[^.\n;]{0,160}\b(?:generated|temporary|stale|build|session)\b[^.\n;]{0,100}\b(?:outputs?|artifacts?|files?|directories?|folders?)\b/gi,
      ""
    )
    .replace(/\bfigure\s+out\b/gi, "");
  const mandatoryEvidenceText = artifactSignalText.replace(
    /[^.\n]{0,240}\b(?:as appropriate|if appropriate|when useful|where applicable)\b/gi,
    " "
  );
  const profile = String(taskProfile || "").toLowerCase();
  const categories = new Set(
    goalRequiresEvidence(positiveGoal, "") ? profileRequirementsForGoal(taskProfile, positiveGoal) : []
  );

  if (goalRequestsFileMutation(positiveGoal)) {
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
  if (goalRequestsTestExecution(positiveGoal)) {
    categories.add("test");
  }
  if (
    textHas(
      mandatoryEvidenceText,
      /\b(artifact|canvas|pdf|image|video|screenshot|plot|chart|figure|docx|archive|copy to|export|generated|generate|draft)\b|\b(?:album|book|paper|report|video)\s+cover\b|\bcover\s+(?:art|design|image)\b/
    ) || /输出|产物|图片|视频|截图|封面|生成/.test(mandatoryEvidenceText)
  ) {
    categories.add("artifact");
  }
  if (
    textHas(
      mandatoryEvidenceText,
      /\b(browser|chrome|chromium|cdp|devtools|playwright|selenium|web[- ]?(?:ui|page)|website|tab|composer|click|upload|attach|submit|form)\b/
    ) ||
    textHas(
      mandatoryEvidenceText,
      /\b(?:browse|navigate|open|refresh|visit)\b[^.\n;]{0,60}\b(?:page|site)\b|\b(?:page|site)\b[^.\n;]{0,60}\b(?:click|open|submit|upload)\b/
    ) ||
    textHas(
      mandatoryEvidenceText,
      /\btype\b[^.\n;]{0,80}\b(?:into|in)\b[^.\n;]{0,80}\b(?:field|input|box|form|page|site|browser|tab|composer)\b|\btype\s+(?:the\s+)?(?:text|value|password|query)\b[^.\n;]{0,80}\b(?:field|input|box|form|page|site|browser|tab|composer)\b/
    ) ||
    /浏览器|网页|页面|上传|提交|附件|资产库/.test(mandatoryEvidenceText)
  ) {
    categories.add("browser");
  }
  if (
    textHas(
      mandatoryEvidenceText,
      /\b(?:screenshot|visual|inspect image|open image|read_image|thumbnails?)\b|\bvisible\s+(?:browser|page|ui|window|image|artifact|result|output|render|preview|screen|thumbnails?)\b|\bsee\s+(?:the\s+)?(?:image|render|preview|page|screen|visual\s+result)\b/
    ) ||
    /截图|(?:可见|查看|目视)[^。；\n]{0,40}(?:图像|图片|页面|界面|窗口|渲染|预览|屏幕)|缩略图/.test(mandatoryEvidenceText)
  ) {
    categories.add("visual");
  }
  const explicitPublishAction = goalRequestsPublishAction(positiveGoal);
  if (explicitPublishAction) {
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
  const text = normalizeSoftLineWraps(goal);
  const forbidden = [];
  const isAction = (value = "") =>
    /\b(use|open|click|browse|browser|upload|attach|submit|publish|deploy|run|execute|install|delete|remove|commit|push|call|api|alter|chang(?:e|ing)|edit(?:ing)?|fix(?:ing)?|modif(?:y|ying)|patch(?:ing)?|repair(?:ing)?|rewrit(?:e|ing)|send(?:ing)?|touch(?:ing)?|writ(?:e|ing))\b/i.test(
      value
    ) || /浏览器|网页|打开|点击|上传|提交|发布|部署|运行|执行|安装|删除|复制|移动|修改|编辑|修复|改写|写入|提交代码|推送|调用|API/.test(value);
  const patterns = [
    { re: /\b(do not|don't|dont|never|no need to)\s+([^.\n;]+)/gi, prefix: "User forbids" },
    // A sentence such as "without changing X, run tests and commit" starts a
    // positive instruction after the comma. Keep only the local without-clause.
    { re: /\bwithout\s+([^.,:\uFF1A\n;]+)/gi, prefix: "User forbids" },
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
  return normalizeSoftLineWraps(goal)
    .replace(
      /\b(?:create|attach|return|send|write|generate|produce)(?:\s*,?\s*(?:and|or)\s*(?:create|attach|return|send|write|generate|produce))*\s+no\s+(?:files?|attachments?|artifacts?)\b/gi,
      ""
    )
    .replace(/\b(do not|don't|dont|must not|should not|never|no need to)\s+([^.\n;]+)/gi, "")
    .replace(/\bwithout\s+([^.,:\uFF1A\n;]+)/gi, "")
    .replace(/不要([^。\n；]+)/g, "")
    .replace(/禁止([^。\n；]+)/g, "");
}

function stripCompletedWorkNarration(goal = "") {
  const completedAction =
    "(?:completed?|finished|performed|applied|committed|repaired|fixed|rebuilt|rewrote|generated|created|updated|modified|patched|moved|relocated)";
  const priorActor =
    "(?:(?:the\\s+)?(?:prior|previous|earlier|last)\\s+(?:run|turn|attempt|session|agent|worker)|(?:it|this|that)\\s+(?:was|has\\s+been))";
  return String(goal || "")
    .replace(
      /\b(?:continue|resume)\s+(?:the\s+)?(?:same\s+)?(?:already\s+)?(?:completed|finished|verified|committed)\b[^.!?;；。！？\n]*/gi,
      (clause) =>
        /\b(?:and|but|then)\s+(?:append|build|convert|copy|create|delete|edit|fix|generate|implement|modify|move|patch|refactor|remove|rename|repair|replace|rewrite|save|update|write)\b/i.test(
          clause
        )
          ? clause
          : ""
    )
    .replace(
      /\b(?:clean(?:\s+up)?|remove|delete|clear|purge)\b[^.!?;；。！？\n]{0,120}\b(?:disposable|generated|temporary|stale)\b[^.!?;；。！？\n]{0,100}\b(?:build\s+)?(?:outputs?|artifacts?|files?|directories?|folders?|caches?)\b/gi,
      ""
    )
    .replace(
      new RegExp(
        `\\b${priorActor}\\b[^.!?;；。！？\\n]{0,300}\\b${completedAction}\\b[^.!?;；。！？\\n]*`,
        "gi"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\b(?:already|previously|earlier)\\b[^.!?;；。！？\\n]{0,180}\\b${completedAction}\\b[^.!?;；。！？\\n]*`,
        "gi"
      ),
      ""
    );
}

function parseAgintiEvidenceScopeMatch(goal = "") {
  const matches = [
    ...String(goal || "").matchAll(/^AGINTI_EVIDENCE_SCOPE_JSON:\s*(\{[^\n]+\})\s*$/gm),
  ];
  for (const match of matches.reverse()) {
    try {
      const payload = JSON.parse(match[1]);
      if (payload && typeof payload === "object") {
        return {
          line: String(match[0] || "").trim(),
          payload,
        };
      }
    } catch {
      // A compacted or malformed older scope line must not hide a later valid
      // host-owned scope record.
    }
  }
  return null;
}

function parseAgintiEvidenceScope(goal = "") {
  return parseAgintiEvidenceScopeMatch(goal)?.payload || null;
}

export function agintiEvidenceScopeLine(goal = "") {
  return parseAgintiEvidenceScopeMatch(goal)?.line || "";
}

export function hasAgintiEvidenceScope(goal = "") {
  return Boolean(parseAgintiEvidenceScope(goal));
}

export function isResponseOnlyEvidenceScope(goal = "") {
  const payload = parseAgintiEvidenceScope(goal);
  if (!payload) return false;
  const mode = String(payload.mode || "").trim().toLowerCase();
  return ["chat-response", "host-managed-response", "plan-response", "read-only-answer"].includes(mode);
}

function responseOnlyScopeHasFreshEvidenceManifest(goal = "") {
  const payload = parseAgintiEvidenceScope(goal);
  if (!payload || typeof payload !== "object") return false;
  const manifestCandidates = [
    payload.evidenceManifest,
    payload.evidence_manifest,
    payload.freshEvidenceManifest,
    payload.fresh_evidence_manifest,
    payload.sourceManifest,
    payload.source_manifest,
    payload.manifestDigest,
    payload.manifest_digest,
    payload.evidenceDigest,
    payload.evidence_digest,
    payload.sourceDigest,
    payload.source_digest,
  ];
  return manifestCandidates.some((item) => {
    if (typeof item === "string") return item.trim().length >= 12;
    if (item && typeof item === "object") return Object.keys(item).length > 0;
    return Array.isArray(item) && item.length > 0;
  });
}

function sourceFreeResponseHasEvidence(ledger = {}) {
  if (!ledger || typeof ledger !== "object") return false;
  if (Number(ledger.itemCount || 0) > 0) return true;
  if (Array.isArray(ledger.items) && ledger.items.some((item) => item?.verified !== false)) return true;
  if (Array.isArray(ledger.categories) && ledger.categories.length > 0) return true;
  return false;
}

function sourceFreeClaimSegments(text = "") {
  return String(text || "")
    .split(/(?:[\n\r]+|(?<=[.!?。！？;；]))/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sourceFreeClaimSegmentHasExplicitUnverifiedFraming(text = "") {
  const value = String(text || "");
  const admitsNoEvidence =
    /\b(?:unverified|not\s+verified|cannot\s+verify|can't\s+verify|could\s+not\s+verify|no\s+(?:fresh\s+)?(?:evidence|sources?|manifest)|without\s+(?:fresh\s+)?(?:evidence|sources?|manifest))\b/iu.test(
      value
    ) ||
    /(?:没有|沒有|无|無|缺少|未获得|未取得|未取得到)(?:新鲜|新鮮|当前|當前|本次|新的)?(?:证据|證據|来源|來源|资料|資料|文献|文獻|检索|檢索|材料)/u.test(
      value
    ) ||
    /(?:无法|無法|不能|未能|没法|沒法)(?:在本次|从本次|從本次)?(?:验证|驗證|核实|核實|证实|證實|确认|確認|证明|證明|支持)/u.test(
      value
    ) ||
    /(?:証拠|出典|根拠|資料|ソース)(?:が)?(?:ない|ありません|不足)|(?:検証|確認|裏付け)(?:できない|されていない|できません)|未検証/u.test(
      value
    );
  const framesAsHypothesis =
    /\b(?:hypothesis|hypotheses|speculative|speculation|not\s+(?:a\s+)?(?:verified|evidence-backed|source-backed)\s+claim)\b/iu.test(
      value
    ) ||
    /(?:假设|假說|推测|推測|猜测|猜測|臆测|臆測|未验证|未經驗證|未经验证|未核实|未核實)/u.test(
      value
    ) ||
    /(?:仮説|推測|憶測|未検証|未確認)/u.test(value);
  return admitsNoEvidence && framesAsHypothesis;
}

function sourceFreeClaimSegmentDeniesVerification(text = "") {
  const value = String(text || "");
  return (
    /\b(?:cannot|can't|could\s+not|do\s+not|don't|unable\s+to|not\s+able\s+to|no\s+(?:fresh\s+)?(?:evidence|source|manifest)\s+to|without\s+(?:fresh\s+)?(?:evidence|sources?|manifest),?\s+(?:i\s+)?(?:cannot|can't|could\s+not)?)\b[^.!?;。！？；\n]{0,140}\b(?:verify|confirm|substantiate|support|validate|prove|claim)\b/iu.test(
      value
    ) ||
    /(?:无法|無法|不能|未能|没法|沒法|不应|不應|不能够|不能夠|没有证据|沒有證據|无证据|無證據)[^。！？；\n]{0,80}(?:验证|驗證|核实|核實|证实|證實|确认|確認|证明|證明|支持|声称|聲稱|断言|斷言)/u.test(
      value
    ) ||
    /(?:検証|確認|裏付け|断言|主張)(?:できない|できません|されていない)|(?:証拠|出典|根拠)(?:が)?(?:ない|ありません)[^。！？；\n]{0,60}(?:検証|確認|主張|断言)/u.test(
      value
    )
  );
}

function sourceFreeExternalClaimCategoriesForSegment(text = "") {
  const value = String(text || "");
  if (!value.trim()) return [];
  const categories = [];
  const add = (category, pattern) => {
    pattern.lastIndex = 0;
    if (pattern.test(value)) categories.push(category);
  };
  add(
    "publication",
    /\b(?:paper|study|article|preprint|publication|manuscript|dataset|trial|journal|conference|arxiv|doi|nature|science|cell)\b[^.!?;。！？；\n]{0,140}\b(?:published|appeared|released|accepted|reported|found|showed|demonstrated|validated)\b|\b(?:published|accepted|released)\b[^.!?;。！？；\n]{0,80}\b(?:paper|study|article|preprint|publication|manuscript|dataset|trial|journal|conference|arxiv|doi|nature|science|cell)\b|(?:Nature|Science|Cell|子刊|期刊|论文|論文|预印本|預印本|文章|研究|数据集|資料集|データセット|論文|研究|プレプリント|ジャーナル)[^.!?;。！？；\n]{0,80}(?:发表|發表|刊登|出版|公开|公開|收录|收録|发布|發布|掲載|発表|公開|出版)|(?:发表|發表|刊登|出版|公开|公開|收录|收録|发布|發布|掲載|発表|公開|出版)[^.!?;。！？；\n]{0,80}(?:Nature|Science|Cell|子刊|期刊|论文|論文|预印本|預印本|文章|研究|数据集|資料集|データセット|論文|研究|プレプリント|ジャーナル)/iu
  );
  add(
    "year",
    /\b(?:published|released|announced|accepted|reported|validated|verified|evaluated|benchmarked|forecast(?:ed)?|projected|predicted)\b[^.!?;。！？；\n]{0,100}\b(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b[^.!?;。！？；\n]{0,100}\b(?:publication|paper|study|article|benchmark|forecast|projection|dataset|trial|validation|release)\b|(?:19|20)\d{2}\s*年?[^.!?;。！？；\n]{0,80}(?:Nature|Science|Cell|子刊|期刊|论文|論文|预印本|預印本|文章|研究|发表|發表|发布|發布|预测|預測|预计|預計|验证|驗證|基准|基準|指标|指標|論文|研究|発表|公開|掲載|予測|検証|ベンチマーク)|(?:Nature|Science|Cell|子刊|期刊|论文|論文|预印本|預印本|文章|研究|发表|發表|发布|發布|预测|預測|预计|預計|验证|驗證|基准|基準|指标|指標|論文|研究|発表|公開|掲載|予測|検証|ベンチマーク)[^.!?;。！？；\n]{0,80}(?:19|20)\d{2}\s*年?/iu
  );
  add(
    "validation",
    /\b(?:validated|verified|proven|confirmed|replicated|peer-reviewed|source-backed|evidence-backed|grounded\s+in\s+(?:sources?|evidence)|the\s+evidence\s+(?:shows|confirms|validates|proves))\b|(?:已有|已经|已經|已经有|已經有|已|初步|经过|經過|得到|获得|獲得)[^。！？；\n]{0,20}(?:验证|驗證|核实|核實|证实|證實|确认|確認|证明|證明)|(?:验证|驗證|核实|核實|证实|證實|确认|確認|证明|證明)(?:通过|通過|完成|成功|结果|結果)|(?:検証済み|確認済み|実証済み|裏付けられた|査読済み)/iu
  );
  add(
    "forecast",
    /\b(?:forecast|forecasted|predict(?:s|ed|ion)?|project(?:s|ed|ion)?|expected\s+to|will\s+(?:reach|increase|decrease|grow|decline|outperform|underperform)|cagr)\b|(?:预测|預測|预计|預計|估计|估計|推算|推測|到\s*(?:19|20)\d{2}\s*年?(?:底|末)?(?:前|之前)?|(?:19|20)\d{2}\s*年?(?:底|末)?(?:前|之前)?[^。！？；\n]{0,40}(?:将|將|会|會|预计|預計|预测|預測))|(?:予測|予想|見込み|推定|年末まで|までに)/iu
  );
  add(
    "benchmark_or_metric",
    /\b(?:benchmark(?:ed|s)?|metric|score|accuracy|precision|recall|f1|auc|bleu|rouge|latency|throughput|validated\s+on|evaluated\s+on)\b[^.!?;。！？；\n]{0,100}\b\d[\d,.]*(?:\s*(?:%|percent|cases?|subjects?|participants?|patients?|samples?|records?|tokens?\/s|requests?\/s|ms|seconds?|x))?\b|\b\d[\d,.]*(?:\.\d+)?\s*(?:%|percent|cases?|subjects?|participants?|patients?|samples?|records?|benchmarks?|tokens?\/s|requests?\/s|ms|seconds?)\b[^.!?;。！？；\n]{0,100}\b(?:accuracy|validated|verified|benchmark|forecast|prediction|projection|reliable|better|improved|increase|decrease)\b|(?:响应延迟|響應延遲|响应时间|響應時間|延迟|延遲|准确率|準確率|精度|召回|吞吐|基准|基準|指标|指標|分数|分數|反応遅延|レイテンシ|精度|ベンチマーク|指標|スコア)[^。！？；\n]{0,60}\d[\d,.]*(?:\s*(?:%|％|ms|毫秒|秒|例|个|個|件|倍|x))?|\d[\d,.]*(?:\.\d+)?\s*(?:%|％|ms|毫秒|秒|例|个|個|件|倍|x)[^。！？；\n]{0,60}(?:响应延迟|響應延遲|响应时间|響應時間|延迟|延遲|准确率|準確率|精度|召回|吞吐|基准|基準|指标|指標|分数|分數|反応遅延|レイテンシ|精度|ベンチマーク|指標|スコア)/iu
  );
  add(
    "external_evidence",
    /\b(?:according\s+to|as\s+reported\s+by|sources?\s+(?:show|say|indicate|confirm|report)|cit(?:e|ation|ed)|doi\s*[:/]|arxiv\s*[:/]|the\s+(?:paper|study|source|evidence)\s+(?:shows|states|reports|confirms|validates))\b|(?:根据|根據|据|據|来源|來源|资料|資料|证据|證據|文献|文獻|论文|論文|引用)[^。！？；\n]{0,50}(?:显示|顯示|表明|指出|报道|報道|证明|證明|验证|驗證|确认|確認)|(?:によると|出典|証拠|根拠|引用|論文|研究)[^。！？；\n]{0,50}(?:示す|示した|報告|確認|検証)/iu
  );
  return unique(categories);
}

function sourceFreeExternalClaimAssessment(text = "") {
  const segments = sourceFreeClaimSegments(text);
  const categories = [];
  const unsupported = [];
  for (const segment of segments) {
    const segmentCategories = sourceFreeExternalClaimCategoriesForSegment(segment);
    if (!segmentCategories.length) continue;
    categories.push(...segmentCategories);
    const deniesVerification = sourceFreeClaimSegmentDeniesVerification(segment);
    const explicitlyUnverified = sourceFreeClaimSegmentHasExplicitUnverifiedFraming(segment);
    const assertsEvidence = segmentCategories.some((category) =>
      ["validation", "external_evidence"].includes(category)
    );
    if (!deniesVerification && (assertsEvidence || !explicitlyUnverified)) {
      unsupported.push({
        categories: segmentCategories,
        preview: compact(segment, 240),
      });
    }
  }
  return {
    categories: unique(categories),
    unsupported,
    explicitlyUnverified:
      categories.length > 0 &&
      unsupported.length === 0 &&
      segments.some((segment) => sourceFreeClaimSegmentHasExplicitUnverifiedFraming(segment)),
  };
}

export function evaluateSourceFreeResponseClaims({
  goal = "",
  candidateResult = "",
  evidenceLedger = {},
} = {}) {
  if (!isResponseOnlyEvidenceScope(goal)) {
    return {
      checked: false,
      ok: true,
      reason: "Not a response-only evidence scope.",
      categories: [],
      hasEvidence: false,
      explicitlyUnverified: false,
    };
  }
  const hasEvidence =
    responseOnlyScopeHasFreshEvidenceManifest(goal) ||
    sourceFreeResponseHasEvidence(evidenceLedger);
  const claimAssessment = sourceFreeExternalClaimAssessment(candidateResult);
  const categories = claimAssessment.categories;
  const unsupportedClaims = claimAssessment.unsupported;
  const explicitlyUnverified = claimAssessment.explicitlyUnverified;
  const ok = hasEvidence || categories.length === 0 || unsupportedClaims.length === 0;
  return {
    checked: true,
    ok,
    reason: ok
      ? hasEvidence
        ? "Current scoped evidence is available for response-only factual claims."
        : explicitlyUnverified
          ? "Every source-free external claim is locally framed as unverified hypothesis or unverifiable."
          : "No source-grounded external claim was detected."
      : `Source-free response-only output claimed external facts without current evidence: ${categories.join(", ")}.`,
    categories,
    unsupportedClaims,
    hasEvidence,
    explicitlyUnverified,
  };
}

export function scopedChatopsEvidenceGoal(goal = "", taskProfile = "") {
  const payload = parseAgintiEvidenceScope(goal);
  if (!payload) {
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
  const mode = String(payload.mode || "").trim().toLowerCase();
  if (isResponseOnlyEvidenceScope(goal)) {
    return "Answer the current chat turn directly without external execution.";
  }
  const request = String(payload.request || "").trim();
  return request || String(goal || "");
}

export function scopedArtifactRoot(goal = "") {
  const payload = parseAgintiEvidenceScope(goal);
  if (!payload || String(payload.mode || "").trim().toLowerCase() !== "task") return "";
  return String(payload.artifact_root || "").trim();
}

function applyScopedArtifactRoot(items = [], artifactRoot = "") {
  if (!artifactRoot) return items;
  return items.map((item) => {
    const value = String(item || "").trim();
    if (!value || path.isAbsolute(value) || value.startsWith("~/") || /[\\/]/.test(value)) return value;
    return path.join(artifactRoot, value);
  });
}

function prefixRequestsInlineCommandExecution(prefix = "") {
  const clauses = String(prefix || "")
    .split(
      /(?:[,;，；]+|\b(?:and\s+then|and|then|after\s+that|afterwards|finally|next)\b|(?:然后|然後|接着|接著|随后|隨後|最后|最後|并且|並且|以及|再))/i
    )
    .map((item) => item.trim())
    .filter(Boolean);
  let clause = clauses.at(-1) || String(prefix || "").trim();
  const preamble = /^(?:(?:please|kindly|now)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+|you\s+(?:must|should|need\s+to|have\s+to)\s+|(?:help|assist)\s+me(?:\s+to)?\s+|(?:请你|請你|麻烦|麻煩|帮我|幫我|需要|必须|必須|请|請)\s*)/i;
  while (preamble.test(clause)) clause = clause.replace(preamble, "").trim();
  clause = clause.replace(/(?:[:：]|--?)\s*$/, "").trim();
  clause = clause
    .replace(
      /\b(commands?)\s+(?:without|while|before|after)\b[\s\S]*$/i,
      "$1"
    )
    .trim();
  return (
    /^(?:followed\s+by|run|rerun|re-run|execute|invoke|launch|verify|validate|check|confirm)(?:\s+(?:exactly|again|once))?(?:\s+(?:(?:the|this|that)\s+)?(?:(?:canonical|exact|required|following|declared|requested|specified|validator|validation|verification|acceptance|test|project)\s+)*(?:commands?|verifier|validator|verification|tests?|test\s+suite|suite)(?:\s+named)?)?\s*$/i.test(
      clause
    ) || /^(?:随后运行|隨後運行|接着运行|接著運行|运行|運行|执行|執行|调用|調用|验证|驗證|检查|檢查|确认|確認)\s*$/.test(clause)
  );
}

function sentenceContinuesRequestedCommandList(source = "", sentenceStart = -1, commandIndex = -1) {
  const prefix = String(source || "").slice(sentenceStart + 1, commandIndex).trim();
  if (!/^(?:these|those|the\s+following)\s+(?:commands?\s+)?(?:include|are)\b/i.test(prefix)) {
    return false;
  }

  const preceding = String(source || "").slice(0, Math.max(0, sentenceStart)).trimEnd();
  const previousStart = Math.max(
    preceding.lastIndexOf("\n"),
    preceding.lastIndexOf("."),
    preceding.lastIndexOf("!"),
    preceding.lastIndexOf("?"),
    preceding.lastIndexOf("。"),
    preceding.lastIndexOf("！"),
    preceding.lastIndexOf("？")
  );
  const previousSentence = preceding.slice(previousStart + 1).trim();
  return (
    /\b(?:run|rerun|re-run|execute|invoke|launch|verify|validate|check|confirm|follow)\b/i.test(previousSentence) &&
    /\b(?:exact|required|following|verification|validation|test|check)\b/i.test(previousSentence) &&
    /\bcommands?\b/i.test(previousSentence)
  );
}

function precedingLineRequestsInlineCommandExecution(source = "", commandIndex = -1) {
  const precedingSource = String(source || "").slice(
    0,
    Math.max(0, Number(commandIndex || 0))
  );
  const lastLineBreak = precedingSource.lastIndexOf("\n");
  const currentLinePrefix = precedingSource.slice(lastLineBreak + 1).trim();
  if (
    currentLinePrefix &&
    !/^(?:[-*+]|\d+[.)])$/u.test(currentLinePrefix)
  ) {
    return false;
  }
  const priorLinesSource =
    lastLineBreak >= 0 ? precedingSource.slice(0, lastLineBreak) : "";
  const lines = priorLinesSource.split(/\r?\n/);
  while (lines.length && !String(lines.at(-1) || "").trim()) lines.pop();
  const precedingLine = String(lines.at(-1) || "").trim();
  if (precedingLine && prefixRequestsInlineCommandExecution(precedingLine)) {
    return true;
  }

  const blockLines = [];
  while (lines.length && blockLines.length < 4) {
    const line = String(lines.pop() || "").trim();
    if (!line) break;
    blockLines.unshift(line);
  }
  const precedingBlock = blockLines.join(" ").trim();
  return Boolean(
    precedingBlock &&
      /(?:^|[.!?;:,。！？；：，])\s*(?:(?:then|next)\s+)?(?:please\s+|kindly\s+|now\s+)?(?:run|rerun|re-run|execute|invoke|launch|verify|validate|check|confirm)\b/i.test(
        precedingBlock
      ) &&
      /\b(?:exact|required|following|declared|requested|specified|validator|validation|verification|acceptance|test|project|command)\b/i.test(
        precedingBlock
      )
  );
}

function canonicalBareVerifierCommand(rawPath = "") {
  const candidate = String(rawPath || "").trim();
  if (
    !candidate ||
    candidate.length > 1000 ||
    /[\u0000-\u001f\u007f\s"'`$&|;<>()[\]{}*?!]/u.test(candidate) ||
    hasActiveShellExpansion(candidate)
  ) {
    return "";
  }
  const basename = path.basename(candidate).toLowerCase();
  if (!/(?:test|verify|check|contract|acceptance|audit|smoke|doctor|lint)/i.test(basename)) {
    return "";
  }
  if (/\.py$/i.test(candidate)) return `python3 ${candidate}`;
  if (/\.sh$/i.test(candidate)) return `bash ${candidate}`;
  if (/\.(?:cjs|mjs|js)$/i.test(candidate)) return `node ${candidate}`;
  return "";
}

function inferBareRequestedVerifierCommands(goal = "") {
  const commands = [];
  const source = stripForbiddenLanguage(goal);
  const sentencePattern = /(?:^|[!?。！？\n]|\.(?=\s))\s*(?:please\s+|kindly\s+|now\s+)?(?:run|execute|invoke|launch)\b([^!?。！？\n]{0,1200})/gi;
  const pathPattern = /(?:^|[\s,:，：])((?:(?:~|\.{1,2})?\/|[A-Za-z0-9_-]+\/)[A-Za-z0-9_./~-]*\.(?:py|sh|cjs|mjs|js))(?=$|[.\s,;，；])/gi;
  for (const sentence of source.matchAll(sentencePattern)) {
    const sentenceSource = String(sentence[0] || "");
    const sentenceBody = String(sentence[1] || "");
    const sentenceBodyOffset = Math.max(0, sentenceSource.indexOf(sentenceBody));
    const clause = String(sentence[1] || "").split(
      /[,;，；]\s*(?=(?:then\s+)?(?:commit|stage|push|publish|deploy|save|write|edit|patch|create|remove|delete|verify\s+(?:a|the)\s+(?:clean|final)|提交|暂存|推送|发布|保存|写入|编辑|修改|创建|删除|验证工作区)\b)/i,
      1
    )[0];
    for (const match of clause.matchAll(pathPattern)) {
      const pathOffset = String(match[0] || "").indexOf(String(match[1] || ""));
      const absolutePathIndex =
        Number(sentence.index || 0) +
        sentenceBodyOffset +
        Number(match.index || 0) +
        Math.max(0, pathOffset);
      if (indexFallsInsideInlineCommand(source, absolutePathIndex)) continue;
      const command = canonicalBareVerifierCommand(match[1]);
      if (command) commands.push(normalizeProjectCommand(command));
    }
  }
  return unique(commands).slice(0, 8);
}

function inferExplicitRequestedCommands(goal = "") {
  const source = stripForbiddenLanguage(goal);
  const inferredBareCommands = inferBareRequestedVerifierCommands(source);
  const explicitCommands = [];
  const inlineCode = /(?<!`)`([^`\r\n]+)`(?!`)/g;
  for (const match of source.matchAll(inlineCode)) {
    const index = Number(match.index || 0);
    const sentenceStart = Math.max(
      source.lastIndexOf("\n", index - 1),
      source.lastIndexOf(".", index - 1),
      source.lastIndexOf("!", index - 1),
      source.lastIndexOf("?", index - 1),
      source.lastIndexOf("。", index - 1),
      source.lastIndexOf("！", index - 1),
      source.lastIndexOf("？", index - 1)
    );
    const prefix = source.slice(sentenceStart + 1, index).trimEnd();
    if (
      !prefixRequestsInlineCommandExecution(prefix) &&
      !sentenceContinuesRequestedCommandList(source, sentenceStart, index) &&
      !precedingLineRequestsInlineCommandExecution(source, index)
    ) {
      continue;
    }

    const command = normalizeProjectCommand(match[1]);
    if (
      !command ||
      command.length > 1000 ||
      /^\.[A-Za-z0-9_-]+$/u.test(command) ||
      /(?:^|\s)(?:\.{3}|…)(?:\s|$)/u.test(command) ||
      /[<>](?:PATH|FILE|COMMAND|VALUE)[<>]?/i.test(command) ||
      hasActiveShellExpansion(command)
    ) {
      continue;
    }
    const sequence = parseTopLevelShellSequence(command);
    if (
      !sequence.commands.length ||
      sequence.trailingSeparator ||
      sequence.openQuote ||
      sequence.trailingEscape ||
      sequence.separators.some((separator) => separator !== "&&")
    ) {
      continue;
    }
    const executableSegments = sequence.commands.every((segment) => {
      const tokens = tokenizeShellWords(segment);
      return Boolean(tokens.length && !String(tokens[0] || "").startsWith("-"));
    });
    if (executableSegments) explicitCommands.push(command);
  }
  const explicitTokenSets = explicitCommands.map((command) => tokenizeShellWords(command));
  const nonShadowedBareCommands = inferredBareCommands.filter((command) => {
    const bareTokens = tokenizeShellWords(command);
    return !explicitTokenSets.some(
      (tokens) =>
        tokens.length > bareTokens.length &&
        bareTokens.every((token, index) => tokens[index] === token)
    );
  });
  return unique([...nonShadowedBareCommands, ...explicitCommands]).slice(0, 8);
}

function routineCommandLooksReadOnly(command = "") {
  const normalized = normalizeProjectCommand(command);
  if (
    !normalized ||
    normalized.length > 1000 ||
    hasActiveShellExpansion(normalized)
  ) {
    return false;
  }
  const sequence = parseTopLevelShellSequence(normalized);
  if (
    !sequence.commands.length ||
    sequence.commands.length > 1 ||
    sequence.trailingSeparator ||
    sequence.openQuote ||
    sequence.trailingEscape ||
    sequence.separators.length
  ) {
    return false;
  }
  const unquoted = normalized.replace(/"[^"\n]*"|'[^'\n]*'/g, "");
  if (/[;&|<>`]/.test(unquoted)) return false;
  return /\b(?:status|health|doctor|inspect|check|show|list)\b|--json\b/i.test(
    normalized
  );
}

function parseRoutineCommandArray(line = "") {
  const start = String(line || "").indexOf("commands=");
  if (start < 0) return [];
  const source = String(line).slice(start + "commands=".length).trimStart();
  if (!source.startsWith("[")) return [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "]" && !inString) {
      try {
        const parsed = JSON.parse(source.slice(0, index + 1));
        return Array.isArray(parsed) ? parsed.map(normalizeProjectCommand).filter(Boolean) : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

function matchedRoutineLines(goal = "") {
  const lines = String(goal || "").split(/\r?\n/);
  const selected = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^Matched established routines\b/i.test(line)) {
      active = true;
      continue;
    }
    if (!active) continue;
    if (/^(?:Operating contract|Runtime|Repository evidence)\b/i.test(line)) break;
    if (!line) continue;
    if (/^-\s+/.test(line)) selected.push(line);
  }
  return selected;
}

export function inferAuthoritativeReadOnlyRoutine(goal = "") {
  const scope = parseAgintiEvidenceScope(goal);
  const request = String(scope?.request || scopedChatopsEvidenceGoal(goal) || "");
  const requestReadOnly = /\b(?:read[- ]only|inspect|checking|check|status|tell me|answer|report)\b/i.test(request) &&
    /\b(?:do not|don't|dont|never|without|no)\b[^.\n;]{0,180}\b(?:send|change|modify|edit|write|mutate|delete|publish|deploy)\b/i.test(request);
  for (const line of matchedRoutineLines(goal)) {
    if (!/\bready\s*=\s*true\b/i.test(line)) continue;
    const commands = parseRoutineCommandArray(line)
      .filter(routineCommandLooksReadOnly)
      .slice(0, 4);
    if (!commands.length) continue;
    const guidance = line.includes("guidance=")
      ? line.slice(line.indexOf("guidance=") + "guidance=".length)
      : line;
    const lowerGuidance = guidance.toLowerCase();
    const readOnlyRoutine =
      requestReadOnly ||
      /\bread[- ]only\b/.test(lowerGuidance) ||
      /\bdo not\b[^.\n;]{0,180}\b(?:send|change|modify|edit|write|mutate)\b/i.test(guidance);
    const authoritative =
      /\b(?:canonical|authoritative|run\b[^.\n;]{0,160}\bfirst|invoke\b[^.\n;]{0,160}\bfirst)\b/i.test(
        guidance
      );
    if (!readOnlyRoutine || !authoritative) continue;
    const forbiddenEvidenceScopes = [];
    if (/\bprivate\b/i.test(guidance)) forbiddenEvidenceScopes.push("private");
    if (/\braw\b/i.test(guidance)) forbiddenEvidenceScopes.push("raw");
    const routineId =
      line.match(/^-\s+`([^`]+)`/)?.[1] ||
      line.match(/^-\s+([A-Za-z0-9._:-]+)/)?.[1] ||
      "authoritative-routine";
    return {
      schemaVersion: 1,
      routineId: String(routineId).slice(0, 120),
      primaryCommand: commands[0],
      commands,
      readOnly: true,
      stopAfterPrimary: true,
      forbiddenEvidenceScopes: unique(forbiddenEvidenceScopes).slice(0, 4),
    };
  }
  return null;
}

export function deriveScsTaskContract({ goal = "", taskProfile = "", acceptanceCriteria = [] } = {}) {
  const evidenceGoal = scopedChatopsEvidenceGoal(goal, taskProfile);
  const positiveEvidenceGoal = stripForbiddenLanguage(evidenceGoal);
  const authoritativeRoutine = inferAuthoritativeReadOnlyRoutine(goal);
  const artifactRoot = scopedArtifactRoot(goal);
  const requirementCategories = inferRequirementCategories(evidenceGoal, taskProfile, acceptanceCriteria);
  const requiredToolCalls = inferRequiredToolCalls(evidenceGoal);
  const requiredGitActions = inferRequiredGitActions(evidenceGoal);
  if (requiredGitActions.length && !requirementCategories.includes("git")) {
    requirementCategories.push("git");
  }
  const requiresExternalEvidence =
    requirementCategories.length > 0 || requiredToolCalls.length > 0 || goalRequiresEvidence(positiveEvidenceGoal, taskProfile);
  const requiredEvidence = requirementCategories.map((category) => ({
    id: category,
    category,
    description: CATEGORY_LABELS[category] || category,
  }));
  const excludedOutputPaths = inferExplicitlyExcludedOutputPaths(evidenceGoal);
  const inferredOutputPaths = filterExplicitlyExcludedOutputPaths(
    inferExactOutputPaths(positiveEvidenceGoal),
    excludedOutputPaths
  );
  const hostManagedDocumentCompilation = hostManagedDocumentCompilationRequested(
    evidenceGoal
  );
  const exactOutputPaths = filterExplicitlyExcludedOutputPaths(
    applyScopedArtifactRoot(inferredOutputPaths, artifactRoot),
    excludedOutputPaths
  ).filter(
    (item) =>
      !hostManagedDocumentCompilation ||
      path.extname(String(item || "")).toLocaleLowerCase("en-US") !== ".pdf"
  );
  const exactInputPaths = filterExplicitlyExcludedOutputPaths(
    inferExactInputPaths(positiveEvidenceGoal),
    excludedOutputPaths
  ).filter((item) => !inferredOutputPaths.includes(item) && !exactOutputPaths.includes(item));
  const declaredSourceRoots = inferDeclaredSourceRoots(evidenceGoal);
  const requiredArtifactKinds = inferRequestedArtifactRequirements(
    positiveEvidenceGoal,
    taskProfile
  );
  const scopedArtifactDeliverable = Boolean(
    artifactRoot && goalRequestsScopedArtifactDeliverable(evidenceGoal)
  );
  const scopedArtifactOperation = Boolean(
    artifactRoot && goalRequestsScopedArtifactOperation(evidenceGoal)
  );
  return {
    version: 1,
    outcome: compact(evidenceGoal || "Complete the requested task.", 500),
    taskProfile: String(taskProfile || "auto"),
    requiresExternalEvidence,
    requiredEvidence,
    forbiddenActions: inferForbiddenActions(evidenceGoal),
    exactOutputPaths,
    requiredArtifactKinds,
    hostManagedDocumentCompilation,
    scopedArtifactDeliverable,
    scopedArtifactOperation,
    excludedOutputPaths,
    artifactRoot,
    exactInputPaths,
    declaredSourceRoots,
    readOnlyReadiness: isReadOnlyReadinessTask(evidenceGoal),
    requiresPerSourceChecks: requiresPerSourceChecks(evidenceGoal),
    requiredToolCalls,
    requiredGitActions,
    requiredProjectCommands: unique([
      ...inferExplicitRequestedCommands(positiveEvidenceGoal),
      ...(authoritativeRoutine?.primaryCommand ? [authoritativeRoutine.primaryCommand] : []),
    ]).slice(0, 8),
    authoritativeRoutine,
    requiresWorkspaceMutation: goalRequestsWorkspaceMutation(evidenceGoal, taskProfile),
    requiresFileMutation: goalRequestsFileMutation(evidenceGoal, taskProfile),
    requiresSourceGrounding: requiresSourceGrounding(evidenceGoal),
    requiredTextTerms: inferRequiredTextTerms(positiveEvidenceGoal),
    requiredExecutableTerms: inferRequiredExecutableTerms(positiveEvidenceGoal),
    forbiddenTextTerms: inferForbiddenTextTerms(evidenceGoal),
    successCriteria: unique(acceptanceCriteria).slice(0, 10),
  };
}

function normalizeProjectCommand(value = "") {
  return canonicalizeShellCommand(value);
}

function pipelineStatusCommand(value = "", pipelineIndex = 0) {
  const sequence = parseTopLevelShellSequence(value);
  if (
    sequence.openQuote ||
    sequence.trailingEscape ||
    sequence.trailingSeparator ||
    sequence.commands.length < 2 ||
    sequence.separators.at(-1) !== "|"
  ) {
    return "";
  }

  let pipelineStart = sequence.commands.length - 1;
  while (pipelineStart > 0 && sequence.separators[pipelineStart - 1] === "|") {
    pipelineStart -= 1;
  }
  const commandIndex = pipelineStart + Number(pipelineIndex || 0);
  if (commandIndex < pipelineStart || commandIndex >= sequence.commands.length) return "";
  return normalizeProjectCommand(sequence.commands[commandIndex]);
}

export function parseNonMutatingExitStatusWrapper(value = "") {
  const normalized = normalizeProjectCommand(value);
  if (!normalized) return null;
  const label = "(?:EXIT|STATUS|RESULT)(?:_CODE)?";
  const pipelinePattern = new RegExp(
    `^(?<pipelineCommand>[\\s\\S]+);\\s*echo\\s+(?:"(?<doubleLabel>${label})\\s*[:=]\\s*\\$\\{PIPESTATUS\\[0\\]\\}"|(?<bareLabel>${label})\\s*[:=]\\s*\\$\\{PIPESTATUS\\[0\\]\\})$`,
    "i"
  );
  const pipelineMatch = normalized.match(pipelinePattern);
  if (pipelineMatch?.groups?.pipelineCommand) {
    const wrappedCommand = normalizeProjectCommand(pipelineMatch.groups.pipelineCommand);
    const command = pipelineStatusCommand(wrappedCommand, 0);
    if (command) {
      return {
        command,
        wrappedCommand,
        label: String(
          pipelineMatch.groups.doubleLabel || pipelineMatch.groups.bareLabel || ""
        ).toUpperCase(),
        statusSource: "pipeline",
        pipelineIndex: 0,
      };
    }
  }
  const patterns = [
    new RegExp(
      `^(?<command>[\\s\\S]+);\\s*echo\\s+(?:\"(?<doubleLabel>${label})\\s*[:=]\\s*\\$\\?\"|'(?<singleLabel>${label})\\s*[:=]\\s*\\$\\?'|(?<bareLabel>${label})\\s*[:=]\\s*\\$\\?)$`,
      "i"
    ),
    new RegExp(
      `^(?<command>[\\s\\S]+);\\s*printf\\s+(?:\"(?<doubleLabel>${label})\\s*[:=]\\s*%(?:s|d|i|u)\\\\n\"|'(?<singleLabel>${label})\\s*[:=]\\s*%(?:s|d|i|u)\\\\n')\\s+(?:\"\\$\\?\"|\\$\\?)$`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.groups?.command) continue;
    return {
      command: normalizeProjectCommand(match.groups.command),
      label: String(
        match.groups.doubleLabel || match.groups.singleLabel || match.groups.bareLabel || ""
      ).toUpperCase(),
    };
  }
  return null;
}

export function parseExplicitExitStatus(value = "") {
  const match = String(value || "")
    .trimEnd()
    .match(/(?:^|\n)\s*(?:EXIT|STATUS|RESULT)(?:_CODE)?\s*[:=]\s*(-?\d+)\s*$/i);
  return match ? Number(match[1]) : null;
}

export function inferSuccessfulGitActionsFromCommandResult(payload = {}) {
  if (!payload || payload.blocked || payload.skipped) return [];
  const command = normalizeProjectCommand(payload.args?.command || payload.command || "");
  if (!command) return [];
  const exitWrapper = parseNonMutatingExitStatusWrapper(command);
  if (exitWrapper) {
    if (parseExplicitExitStatus(payload.stdout || payload.result || "") !== 0) return [];
    return inferGitActionsFromCommand(exitWrapper.command);
  }
  if (payload.ok === false || Number(payload.exitCode ?? 0) !== 0) return [];
  const inferred = inferGitActionsFromCommand(command);
  if (inferred.length) return inferred;

  // Shell expansion or a setup prefix can make the full command ambiguous to
  // the static parser. A canonical successful commit line plus an explicit
  // top-level `git commit` still provides concrete commit evidence.
  const output = String(payload.stdout || payload.result || "");
  if (
    /(?:^|[;&|]\s*)git\s+commit\b/i.test(command) &&
    /^\[[^\]\n]+\s+[0-9a-f]{7,}\]\s+\S+/mi.test(output)
  ) {
    return ["commit"];
  }
  return [];
}

export function buildTmuxGitIntent(command = "") {
  const text = String(command || "");
  // `$?` is expected in the explicit tmux exit marker. Remove only that
  // non-command expansion before parsing; all other shell expansion remains
  // subject to the normal ambiguity guard.
  const parseable = text.replace(/\$\?/g, "0");
  const actions = inferGitActionsFromCommand(parseable, {
    requireFailurePropagation: false,
  }).filter((action) => !isObservationalGitAction(action));
  const markers = [
    ...text.matchAll(/={3,}([A-Z0-9][A-Z0-9_-]{3,96}(?:START|BEGIN))={3,}/g),
  ].map((match) => String(match[0] || ""));
  if (!actions.length || !markers.length) return null;
  return {
    actions: unique(actions),
    markers: unique(markers).slice(0, 4),
  };
}

export function inferSuccessfulGitActionsFromTmuxCapture(intent = {}, payload = {}) {
  if (
    !intent ||
    !payload ||
    payload.ok === false ||
    payload.blocked ||
    String(payload.toolName || "") !== "tmux_capture_pane"
  ) {
    return [];
  }
  const content = [payload.content, payload.contentPreview, payload.contentTail]
    .map((item) => String(item || ""))
    .filter(Boolean)
    .join("\n");
  const markers = Array.isArray(intent.markers)
    ? intent.markers.map(String).filter(Boolean)
    : [];
  if (!content || !markers.length || !markers.some((marker) => content.includes(marker))) {
    return [];
  }
  const requested = Array.isArray(intent.actions)
    ? intent.actions.map((item) => String(item || "").toLowerCase()).filter(Boolean)
    : [];
  const verified = [];
  if (
    requested.includes("commit") &&
    /={3,}(?:GIT_)?COMMIT_EXIT\s*[:=]\s*0={3,}/i.test(content) &&
    /^\[[^\]\n]+\s+[0-9a-f]{7,}\]\s+\S+/mi.test(content)
  ) {
    verified.push("commit");
  }
  return verified;
}

export function reconcileTmuxGitEvidenceEvents(events = []) {
  const source = Array.isArray(events) ? events : [];
  const pendingStarts = new Map();
  const activeIntents = new Map();
  let goalRevision = 0;
  let mutationRevision = 0;

  return source.map((event) => {
    const type = String(event?.type || "");
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    goalRevision = Math.max(
      goalRevision,
      Number(
        data.goalRevision ??
          (type === "goal.updated" ? data.revision : 0) ??
          0
      ) || 0
    );
    mutationRevision = Math.max(
      mutationRevision,
      Number(data.projectMutationRevision ?? data.mutationRevision ?? 0) || 0
    );

    const toolName = String(data.toolName || "");
    const target = String(data.target || data.args?.target || "");
    if (type === "tool.started" && toolName === "tmux_send_keys" && target) {
      const intent = buildTmuxGitIntent(data.args?.text || "");
      if (intent) {
        pendingStarts.set(target, {
          ...intent,
          target,
          goalRevision,
          mutationRevision,
        });
      } else {
        pendingStarts.delete(target);
        activeIntents.delete(target);
      }
      return event;
    }

    if (["tool.completed", "tool.failed"].includes(type) && toolName === "tmux_send_keys" && target) {
      const pending = pendingStarts.get(target);
      pendingStarts.delete(target);
      if (type === "tool.completed" && data.ok !== false && pending) {
        activeIntents.set(target, {
          ...pending,
          sentTextSha256: String(data.sentTextSha256 || ""),
        });
      } else {
        activeIntents.delete(target);
      }
      return event;
    }

    if (type === "tool.completed" && toolName === "tmux_capture_pane" && target) {
      const pending = activeIntents.get(target);
      const verifiedGitActions = inferSuccessfulGitActionsFromTmuxCapture(
        pending,
        data
      );
      if (verifiedGitActions.length) {
        activeIntents.delete(target);
        return {
          ...event,
          data: {
            ...data,
            verifiedGitActions,
            verifiedGitSource: "tmux_capture_pane",
            verifiedGitGoalRevision: Math.max(
              0,
              Number(pending.goalRevision || 0)
            ),
            verifiedGitMutationRevision: Math.max(
              0,
              Number(pending.mutationRevision || 0)
            ),
            verifiedGitCommandSha256: String(
              pending.sentTextSha256 || ""
            ),
          },
        };
      }
    }
    return event;
  });
}

export function successfulGitCommitProvesFileMutation(payload = {}) {
  if (!inferSuccessfulGitActionsFromCommandResult(payload).includes("commit")) return false;
  const output = String(payload.stdout || payload.result || "");
  return (
    /^\[[^\]\n]+\s+[0-9a-f]{7,}\]\s+\S+/mi.test(output) &&
    (/(?:^|\n)\s*\d+\s+files?\s+changed\b/mi.test(output) ||
      /(?:^|\n)\s*(?:create|delete|rename)\s+mode\s+\d+\s+/mi.test(output))
  );
}

function observedProjectCommandSatisfies(requiredCommand = "", item = {}) {
  const required = normalizeProjectCommand(requiredCommand);
  const observed = normalizeProjectCommand(item?.command || item?.target || "");
  const boundRequired = normalizeProjectCommand(item?.requiredProjectCommand || "");
  if (!required || !observed) return false;
  if (
    Object.prototype.hasOwnProperty.call(item, "explicitExitStatus") &&
    item.explicitExitStatus !== 0
  ) {
    return false;
  }
  if (boundRequired === required) return true;
  if (observed === required) return true;

  // Agents commonly preserve a command's exit code with
  // `command; echo "EXIT=$?"`. Accept only that narrow wrapper when the
  // captured evidence proves the wrapped command returned zero. Arbitrary
  // semicolon chains remain rejected because their final exit code can mask
  // an earlier failure.
  const exitProbe = parseNonMutatingExitStatusWrapper(observed);
  if (!exitProbe || exitProbe.command !== required) return false;
  return item?.explicitExitStatus === 0;
}

export function augmentScsTaskContractWithProjectVerification(contract = {}, state = {}, context = {}) {
  const verification = state?.meta?.projectVerification;
  if (!verification || typeof verification !== "object") return contract;
  const profile = String(context.taskProfile || contract.taskProfile || verification.taskProfile || "auto").toLowerCase();
  const mutationRevision = Math.max(0, Number(verification.mutationRevision || 0));
  const discoveredTests = unique(
    (Array.isArray(verification.discoveredTests) ? verification.discoveredTests : [])
      .map((item) => String(item?.path || item || "").trim())
      .filter(Boolean)
  ).slice(0, 80);
  const excludedOutputPaths = unique(
    (Array.isArray(contract.excludedOutputPaths) ? contract.excludedOutputPaths : [])
      .map(normalizedContractPath)
      .filter(Boolean)
  ).slice(0, 24);
  const requiredOutputs = filterExplicitlyExcludedOutputPaths(
    applyScopedArtifactRoot(
      (Array.isArray(verification.requiredOutputs) ? verification.requiredOutputs : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
      String(contract.artifactRoot || "")
    ),
    excludedOutputPaths
  ).slice(0, 64);
  const verificationRequiredProjectCommands = unique([
    ...(Array.isArray(verification.contractRequiredCommands)
      ? verification.contractRequiredCommands
      : []),
    ...(Array.isArray(verification.requiredCommands) ? verification.requiredCommands : []),
  ].map(normalizeProjectCommand).filter(Boolean)).slice(0, 24);
  const requiredProjectCommands = unique([
    ...(Array.isArray(contract.requiredProjectCommands) ? contract.requiredProjectCommands : []),
    ...verificationRequiredProjectCommands,
  ].map(normalizeProjectCommand).filter(Boolean)).slice(0, 24);
  const requiredCommandBatch = verification.requiredCommandBatch;
  const batchRequiredCommands = unique(
    (Array.isArray(requiredCommandBatch?.requiredCommands)
      ? requiredCommandBatch.requiredCommands
      : requiredCommandBatch?.key === JSON.stringify(requiredProjectCommands)
        ? requiredProjectCommands
        : [])
      .map(normalizeProjectCommand)
      .filter((command) => command && requiredProjectCommands.includes(command))
  );
  const requiredProjectCommandBatchId =
    requiredCommandBatch &&
    batchRequiredCommands.length > 0 &&
    requiredCommandBatch.key === JSON.stringify(batchRequiredCommands) &&
    requiredCommandBatch.id
      ? String(requiredCommandBatch.id)
      : "";
  const requiredProjectCommandRuns = requiredProjectCommandBatchId
    ? (Array.isArray(requiredCommandBatch.completedRuns) ? requiredCommandBatch.completedRuns : [])
        .map((run) => ({
          command: normalizeProjectCommand(run?.command || ""),
          mutationRevision: Math.max(0, Number(run?.mutationRevision || 0)),
        }))
        .filter((run) => run.command && requiredProjectCommands.includes(run.command))
    : [];
  const requiredEvidence = Array.isArray(contract.requiredEvidence)
    ? contract.requiredEvidence.map((item) => ({ ...item }))
    : [];
  const addEvidence = (category, description, details = {}) => {
    if (requiredEvidence.some((item) => item.category === category)) return;
    requiredEvidence.push({ id: category, category, description, ...details });
  };

  if (PROJECT_TEST_PROFILES.has(profile) && discoveredTests.length && mutationRevision > 0) {
    addEvidence("test", CATEGORY_LABELS.test, { minimumMutationRevision: mutationRevision });
  }
  if (requiredOutputs.some((item) => /\.(?:avif|bmp|gif|jpe?g|png|tiff?|webp)$/i.test(item))) {
    addEvidence("visual", CATEGORY_LABELS.visual);
  }

  const exactOutputPaths = filterExplicitlyExcludedOutputPaths([
    ...(Array.isArray(contract.exactOutputPaths) ? contract.exactOutputPaths : []),
    ...requiredOutputs,
  ], excludedOutputPaths).slice(0, 80);
  const requiresExternalEvidence = Boolean(
    contract.requiresExternalEvidence ||
    requiredEvidence.length ||
    exactOutputPaths.length ||
    requiredProjectCommands.length
  );
  return {
    ...contract,
    requiresExternalEvidence,
    requiredEvidence,
    exactOutputPaths,
    excludedOutputPaths,
    requiredProjectCommands,
    requiredProjectCommandBatchId,
    requiredProjectCommandBatchCommands: requiredProjectCommandBatchId
      ? batchRequiredCommands
      : [],
    requiredProjectCommandRuns,
    projectMutationRevision: mutationRevision,
    projectTestFiles: discoveredTests,
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

const ARTIFACT_SCAN_IGNORED_DIRECTORIES = new Set([
  ".aginti",
  ".aginti-sessions",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  "node_modules",
  "vendor",
]);

function taskArtifactFreshnessBoundary(state = {}) {
  const lifecycle = Array.isArray(state.meta?.goalContract?.lifecycle)
    ? state.meta.goalContract.lifecycle
    : [];
  const lifecycleTimes = lifecycle
    .map((item) => Date.parse(String(item?.at || "")))
    .filter(Number.isFinite);
  if (lifecycleTimes.length) return Math.min(...lifecycleTimes) - 2000;
  const mutationTimes = (Array.isArray(state.meta?.projectVerification?.mutationHistory)
    ? state.meta.projectVerification.mutationHistory
    : [])
    .map((item) => Date.parse(String(item?.at || "")))
    .filter(Number.isFinite);
  return mutationTimes.length ? Math.min(...mutationTimes) - 2000 : 0;
}

function taskArtifactMutationPaths(state = {}) {
  const paths = new Set();
  for (const mutation of Array.isArray(state.meta?.projectVerification?.mutationHistory)
    ? state.meta.projectVerification.mutationHistory
    : []) {
    for (const candidate of Array.isArray(mutation?.paths) ? mutation.paths : []) {
      const normalized = normalizedContractPath(candidate);
      if (normalized) paths.add(normalized.toLocaleLowerCase("en-US"));
    }
  }
  return paths;
}

function collectRequestedArtifactCandidates(
  commandCwd = process.cwd(),
  state = {},
  artifactRoot = ""
) {
  const root = path.resolve(commandCwd || process.cwd());
  const freshnessBoundary = taskArtifactFreshnessBoundary(state);
  const mutationPaths = taskArtifactMutationPaths(state);
  const candidates = [];
  const seenFiles = new Set();
  const scanRoots = [];
  const appendScanRoot = (rawPath = "") => {
    const absolutePath = rawPath
      ? resolveContractPath(root, rawPath)
      : root;
    if (!absolutePath || scanRoots.includes(absolutePath)) return;
    try {
      if (!fs.statSync(absolutePath).isDirectory()) return;
    } catch {
      return;
    }
    scanRoots.push(absolutePath);
  };
  // A host-declared task artifact root is authoritative and usually sits deep
  // inside a large application workspace. Inspect it before the bounded broad
  // workspace scan so unrelated files cannot exhaust the candidate limit and
  // hide a valid task deliverable.
  appendScanRoot(artifactRoot);
  appendScanRoot();
  let visited = 0;
  for (const scanRoot of scanRoots) {
    const queue = [{ absolutePath: scanRoot, depth: 0 }];
    while (queue.length && candidates.length < 3000 && visited < 6000) {
      const current = queue.shift();
      visited += 1;
      let entries = [];
      try {
        entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(current.absolutePath, entry.name);
        if (entry.isDirectory()) {
          if (
            current.depth < 7 &&
            !ARTIFACT_SCAN_IGNORED_DIRECTORIES.has(entry.name) &&
            !entry.name.startsWith(".cache")
          ) {
            queue.push({ absolutePath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (seenFiles.has(absolutePath)) continue;
        seenFiles.add(absolutePath);
        let stat;
        try {
          stat = fs.statSync(absolutePath);
        } catch {
          continue;
        }
        if (!stat.size) continue;
        const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
        const normalized = normalizedContractPath(relativePath).toLocaleLowerCase("en-US");
        const fresh = Boolean(
          mutationPaths.has(normalized) ||
            freshnessBoundary === 0 ||
            Number(stat.mtimeMs || 0) >= freshnessBoundary
        );
        candidates.push({
          path: relativePath,
          extension: path.extname(entry.name).toLocaleLowerCase("en-US"),
          basename: entry.name.toLocaleLowerCase("en-US"),
          bytes: stat.size,
          mtimeMs: Number(stat.mtimeMs || 0),
          fresh,
        });
      }
    }
  }
  return candidates;
}

function requestedArtifactRequirementMatches(requirement = {}, candidate = {}) {
  const extension = String(candidate.extension || "").toLocaleLowerCase("en-US");
  const basename = String(candidate.basename || "").toLocaleLowerCase("en-US");
  if (requirement.kind === "format") {
    return extension === String(requirement.extension || "").toLocaleLowerCase("en-US");
  }
  if (["editable-presentation", "printable-document", "visual-preview"].includes(requirement.kind)) {
    const extensions = new Set(
      (Array.isArray(requirement.extensions) ? requirement.extensions : [])
        .map((item) => String(item || "").toLocaleLowerCase("en-US"))
    );
    if (!extensions.has(extension)) return false;
    if (requirement.kind === "visual-preview") {
      return /(?:preview|contact[-_ ]?sheet|overview|thumbnail|render)/i.test(basename);
    }
    return true;
  }
  if (requirement.kind === "practice-material") {
    return /(?:practice|worksheet|exercise|handout|activity)/i.test(basename) &&
      /\.(?:docx|html?|md|odt|pdf|tex|txt)$/i.test(extension);
  }
  if (requirement.kind === "answer-material") {
    return /(?:answer|solution|worked[-_ ]?answers?)/i.test(basename) &&
      /\.(?:docx|html?|md|odt|pdf|tex|txt)$/i.test(extension);
  }
  if (requirement.kind === "reproducible-build-entrypoint") {
    return (
      /^(?:makefile|justfile)$/i.test(basename) ||
      /(?:^|[-_])(?:build|compile|export|generate|render)(?:[-_.]|$)/i.test(basename)
    ) && /(?:^makefile$|^justfile$|\.(?:cjs|js|mjs|py|sh|ts)$)/i.test(basename);
  }
  return false;
}

export function evaluateRequestedArtifactRequirements(
  contract = {},
  { commandCwd = process.cwd(), state = {} } = {}
) {
  const requirements = Array.isArray(contract.requiredArtifactKinds)
    ? contract.requiredArtifactKinds
    : [];
  if (!requirements.length) {
    return {
      ok: true,
      checked: false,
      requirements: [],
      satisfied: [],
      missing: [],
      candidates: [],
      reason: "No semantic artifact-set contract was inferred.",
    };
  }
  const candidates = collectRequestedArtifactCandidates(
    commandCwd,
    state,
    String(contract.artifactRoot || "")
  );
  const requireFresh = contract.requiresFileMutation === true;
  const usableCandidates = requireFresh
    ? candidates.filter((candidate) => candidate.fresh)
    : candidates;
  const satisfied = [];
  const missing = [];
  for (const requirement of requirements) {
    const matches = usableCandidates.filter((candidate) =>
      requestedArtifactRequirementMatches(requirement, candidate)
    );
    if (matches.length) {
      satisfied.push({
        ...requirement,
        paths: matches.map((candidate) => candidate.path).slice(0, 12),
      });
    } else {
      missing.push(requirement);
    }
  }
  return {
    ok: missing.length === 0,
    checked: true,
    requirements,
    satisfied,
    missing,
    candidates: usableCandidates.slice(0, 120),
    reason: missing.length
      ? `Missing requested artifact deliverables: ${missing
          .map((item) => item.description || item.id)
          .join(", ")}.`
      : "Every requested artifact format and role has a fresh workspace deliverable.",
  };
}

const PROJECT_SOURCE_PATH_PATTERN =
  /\.(?:c|cc|cpp|cxx|h|hh|hpp|cs|go|java|js|jsx|ts|tsx|mjs|cjs|kt|kts|php|py|r|rb|rs|scala|sh|sql|swift|vue|svelte|jl)$/i;
const PROJECT_SOURCE_MANIFEST_PATTERN =
  /(?:^|\/)(?:CMakeLists\.txt|Cargo\.toml|Gemfile|Makefile|Package\.swift|build\.gradle(?:\.kts)?|go\.mod|package\.json|pom\.xml|pyproject\.toml|requirements[^/]*\.txt)$/i;
const GENERATED_SOURCE_PATH_PATTERN =
  /(?:^|\/)(?:\.aginti|\.aginti-sessions|artifacts?|build|coverage|dist|node_modules|outputs?|target|vendor)(?:\/|$)/i;
const TEST_COMMAND_PATTERNS = Object.freeze([
  /(?:^|[;&|]\s*|\s)python\d*(?:\.\d+)?\s+-m\s+(?:pytest|unittest)\b/i,
  /(?:^|[;&|]\s*|\s)(?:pytest|jest|vitest|phpunit|rspec)\b/i,
  /(?:^|[;&|]\s*|\s)npx\s+(?:jest|mocha|pytest|vitest)\b/i,
  /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check)(?::[^\s;&|]+)?)(?:\s|$)/i,
  /(?:^|[;&|]\s*|\s)(?:cargo|deno|dotnet|go|swift)\s+test\b/i,
  /(?:^|[;&|]\s*|\s)node\s+--test\b/i,
  /(?:^|[;&|]\s*|\s)(?:ctest|make\s+(?:check|test)|mvn\w*\s+(?:test|verify))\b/i,
  /(?:^|[;&|]\s*|\s)(?:gradle\w*|\.\/gradlew)\s+[^;&|\n]*\btest\b/i,
]);

function projectSourceMutationPath(value = "") {
  const cleaned = String(value || "").trim().replace(/\\/g, "/");
  if (!cleaned || GENERATED_SOURCE_PATH_PATTERN.test(cleaned)) return false;
  return PROJECT_SOURCE_PATH_PATTERN.test(cleaned) || PROJECT_SOURCE_MANIFEST_PATTERN.test(cleaned);
}

function projectTestCommand(value = "") {
  const command = String(value || "").trim();
  return Boolean(command && TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command)));
}

function evaluateProjectTestVerification(events = []) {
  const eventList = Array.isArray(events) ? events : [];
  let testFiles = [];
  for (const event of eventList) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    if (event?.type !== "tool.completed" || data.toolName !== "inspect_project" || data.ok === false) continue;
    testFiles = unique([
      ...testFiles,
      ...(Array.isArray(data.testFiles) ? data.testFiles : [])
        .map((item) => String(item?.path || item || "").trim())
        .filter(Boolean),
    ]);
  }
  if (testFiles.length === 0) {
    return { ok: true, checked: false, reason: "No project tests were discovered." };
  }

  const mutations = [];
  for (let index = 0; index < eventList.length; index += 1) {
    const event = eventList[index];
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    if (event?.type !== "file.changed") continue;
    const changedPath = String(data.path || data.file || data.change?.path || "").trim();
    if (projectSourceMutationPath(changedPath)) mutations.push({ index, path: changedPath });
  }
  if (mutations.length === 0) {
    return { ok: true, checked: false, reason: "No source or build manifest changed after test discovery." };
  }

  const lastMutation = mutations.at(-1);
  const testRuns = [];
  for (let index = lastMutation.index + 1; index < eventList.length; index += 1) {
    const event = eventList[index];
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const command = String(data.args?.command || "").trim();
    const recordedProjectTest =
      data.projectTest && typeof data.projectTest === "object"
        ? data.projectTest
        : null;
    if (
      event?.type !== "tool.completed" ||
      data.toolName !== "run_command" ||
      (!projectTestCommand(command) && !recordedProjectTest)
    ) {
      continue;
    }
    const exitCode = Number.isInteger(data.exitCode) ? data.exitCode : null;
    testRuns.push({
      command,
      exitCode,
      passed: recordedProjectTest
        ? recordedProjectTest.passed === true
        : exitCode === 0,
      source: recordedProjectTest ? "project-verification-ledger" : "command-pattern",
    });
  }

  if (testRuns.length === 0) {
    return {
      ok: false,
      checked: true,
      testFiles: testFiles.slice(0, 12),
      changedPaths: mutations.map((item) => item.path).slice(-12),
      testRuns: [],
      reason: `Source changed after inspect_project discovered tests, but no relevant test command succeeded after the latest source change (${lastMutation.path}). Run the focused project tests and finish only after exit 0.`,
    };
  }

  const lastRun = testRuns.at(-1);
  const ok = lastRun.passed === true;
  return {
    ok,
    checked: true,
    testFiles: testFiles.slice(0, 12),
    changedPaths: mutations.map((item) => item.path).slice(-12),
    testRuns: testRuns.slice(-8),
    reason: ok
      ? `A relevant test command passed after the latest source change: ${lastRun.command}.`
      : `The latest relevant test command did not pass after the latest source change (exit ${lastRun.exitCode ?? "unknown"}): ${lastRun.command}.`,
  };
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
  "jsonl",
  "md",
  "mov",
  "ndjson",
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
  const addPath = (value = "", source = "", { allowExcludedDirect = false } = {}) => {
    const cleaned = cleanPathToken(value);
    if (!cleaned) return;
    const keys = pathComparisonKeys(cleaned, commandCwd);
    if (!allowExcludedDirect && keys.some((key) => excluded.has(key))) return;
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
    if (toolName === "read_file") {
      // Reading a generated or previously mutated file proves that exact path
      // exists. Its contents still cannot ground additional claims.
      addPath(payloadPath, `${toolName} result`, { allowExcludedDirect: true });
      if (sourceIsExcluded) return;
    } else if (["list_files", "search_files", "inspect_project"].includes(toolName)) {
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
  const roots = unique([
    ...(contract.declaredSourceRoots || []),
    ...(contract.exactInputPaths || []),
  ]).map((rawPath) => ({
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
  const requiredExecutableTerms = Array.isArray(contract.requiredExecutableTerms)
    ? contract.requiredExecutableTerms
    : [];
  const forbiddenTextTerms = Array.isArray(contract.forbiddenTextTerms) ? contract.forbiddenTextTerms : [];
  const projectTestVerification = evaluateProjectTestVerification(events);
  const executable = evaluateRequiredExecutableTerms(contract, { commandCwd, events, state });
  const requestedArtifacts = evaluateRequestedArtifactRequirements(contract, {
    commandCwd,
    state,
  });
  if (
    !exactOutputPaths.length &&
    !requiredTextTerms.length &&
    !requiredExecutableTerms.length &&
    !forbiddenTextTerms.length &&
    !requestedArtifacts.checked
  ) {
    return projectTestVerification.checked
      ? {
          ok: projectTestVerification.ok,
          checked: true,
          projectTestVerification,
          reason: projectTestVerification.reason,
        }
      : { ok: true, checked: false, projectTestVerification, reason: "No semantic file contract was inferred." };
  }
  if (!exactOutputPaths.length) {
    const ok = executable.ok && projectTestVerification.ok && requestedArtifacts.ok;
    return {
      ok,
      checked: executable.checked || projectTestVerification.checked || requestedArtifacts.checked,
      reason: !requestedArtifacts.ok
        ? requestedArtifacts.reason
        : !executable.ok
        ? executable.reason
        : !projectTestVerification.ok
          ? projectTestVerification.reason
          : requestedArtifacts.checked
            ? requestedArtifacts.reason
            : "Semantic text terms were inferred, but no exact output path was inferred for deterministic file inspection.",
      requiredTextTerms,
      requiredExecutableTerms,
      forbiddenTextTerms,
      requestedArtifacts,
      missingExecutableTerms: executable.missingExecutableTerms,
      executableSourcePaths: executable.executableSourcePaths,
      executable,
      projectTestVerification,
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
    executable.ok &&
    sourceGrounding.ok &&
    projectTestVerification.ok &&
    requestedArtifacts.ok;
  return {
    ok,
    checked: true,
    exactOutputPaths,
    requiredTextTerms,
    requiredExecutableTerms,
    forbiddenTextTerms,
    requestedArtifacts,
    missingFiles,
    missingRequiredText,
    missingExecutableTerms: executable.missingExecutableTerms,
    executableSourcePaths: executable.executableSourcePaths,
    presentForbiddenText,
    executable,
    sourceGrounding,
    projectTestVerification,
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
          !executable.ok ? executable.reason : "",
          presentForbiddenText.length ? `Forbidden text terms present: ${presentForbiddenText.join(", ")}` : "",
          !sourceGrounding.ok ? sourceGrounding.reason : "",
          !projectTestVerification.ok ? projectTestVerification.reason : "",
          !requestedArtifacts.ok ? requestedArtifacts.reason : "",
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
      virtualArtifact: Boolean(data.artifactId && !data.path && !data.outputPath),
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
  const authoritativeRoutineObserved = Boolean(
    payload?.authoritativeReadOnlyRoutine === true &&
      payload?.authoritativeRoutineObserved === true
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.blocked ||
    (payload.ok === false && !authoritativeRoutineObserved)
  ) {
    return [];
  }
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
  const push = (category, proof, target = "", details = {}) => {
    evidence.push({
      category,
      source,
      toolName,
      target: compact(target || payload.path || payload.outputPath || payload.artifactPath || args.path || args.command || payload.url || "", 260),
      proof: compact(proof, 500),
      verified: payload.ok !== false || authoritativeRoutineObserved,
      goalRevision: Math.max(0, Number(payload.goalRevision || 0)),
      mutationRevision: Math.max(0, Number(payload.projectMutationRevision || 0)),
      ...details,
    });
  };

  if (["write_file", "apply_patch"].includes(toolName) || payload.path || payload.reportPath || Array.isArray(payload.changes)) {
    push(
      "file",
      `${toolName || "tool"} produced file/workspace evidence`,
      payload.path || payload.reportPath || args.path || ""
    );
  }
  if (
    toolName === "run_command" &&
    payload.explicitHeadRestore === true &&
    Array.isArray(payload.explicitHeadRestorePaths)
  ) {
    for (const restoredPath of payload.explicitHeadRestorePaths
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 24)) {
      push(
        "file",
        "runtime-verified exact task-owned HEAD restore",
        restoredPath,
        { explicitHeadRestore: true }
      );
    }
  }
  if (toolName === "run_command" || payload.stdout || Number.isInteger(payload.exitCode)) {
    const command = normalizeProjectCommand(args.command || "");
    const exitWrapper = parseNonMutatingExitStatusWrapper(command);
    const explicitExitStatus = exitWrapper
      ? parseExplicitExitStatus(payload.stdout || "")
      : undefined;
    push(
      "command",
      `exit=${payload.exitCode ?? 0} stdout=${compact(payload.stdout || "", 260)}`,
      args.command || "",
      {
        command,
        mutationRevision: Math.max(0, Number(payload.projectMutationRevision || 0)),
        ...(payload.requiredCommandBatchId
          ? { requiredCommandBatchId: String(payload.requiredCommandBatchId) }
          : {}),
        ...(payload.requiredProjectCommand
          ? { requiredProjectCommand: normalizeProjectCommand(payload.requiredProjectCommand) }
          : {}),
        ...(authoritativeRoutineObserved
          ? {
              authoritativeReadOnlyRoutine: true,
              authoritativeRoutineId: String(payload.authoritativeRoutineId || ""),
              authoritativeRoutineOutcome: String(payload.authoritativeRoutineOutcome || "status"),
            }
          : {}),
        ...(exitWrapper ? { explicitExitStatus } : {}),
      }
    );
  }
  if (payload.projectTest?.passed === true) {
    push(
      "test",
      `project tests passed for mutation revision ${Number(payload.projectTest.mutationRevision || 0)}`,
      payload.projectTest.command || args.command || "",
      {
        command: normalizeProjectCommand(payload.projectTest.command || args.command || ""),
        mutationRevision: Math.max(0, Number(payload.projectTest.mutationRevision || 0)),
      }
    );
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
  const artifactTools = new Set([
    "open_workspace_file",
    "preview_workspace",
    "send_to_canvas",
    "generate_image",
    "read_image",
    "writing_specialist",
    "json_specialist",
    "json_specialist_batch",
  ]);
  const artifactPath = firstArtifactPath(
    payload.artifactPath,
    payload.outputPath,
    payload.reportPath,
    payload.path,
    args.path,
    text
  );
  if (artifactTools.has(toolName) || payload.artifactId || artifactPath) {
    push(
      "artifact",
      `${toolName || "tool"} produced or inspected an artifact`,
      artifactPath || payload.artifactId || "",
      { virtualArtifact: Boolean(payload.artifactId && !artifactPath) }
    );
  }
  if (["read_image", "generate_image"].includes(toolName) || /\b(screenshot|visible|thumbnail|preview|image)\b/.test(text)) {
    push("visual", `${toolName || "tool"} supplied visual evidence`, payload.path || payload.outputPath || args.path || "");
  }
  const gitActions = Array.isArray(payload.verifiedGitActions)
    ? payload.verifiedGitActions
    : inferSuccessfulGitActionsFromCommandResult(payload);
  if (gitActions.length) {
    push(
      "git",
      `git ${gitActions.join("+")} evidence: ${compact(payload.stdout || args.command || "", 260)}`,
      args.command || "",
      {
        gitAction: gitActions.at(-1),
        gitActions,
        goalRevision: Math.max(
          0,
          Number(payload.verifiedGitGoalRevision ?? payload.goalRevision ?? 0)
        ),
        mutationRevision: Math.max(
          0,
          Number(
            payload.verifiedGitMutationRevision ??
              payload.projectMutationRevision ??
              0
          )
        ),
      }
    );
  }
  if (/\b(npm publish|publish|deploy|submit|generate video|uploaded|submitted)\b/.test(text) || /发布|部署|提交|生成视频/.test(text)) {
    push("publish", `publish/submit evidence: ${compact(payload.stdout || payload.result || args.command || "", 260)}`, args.command || "");
  }
  return evidence;
}

const ARTIFACT_EXTENSION_PATTERN = /\.(?:md|json|csv|txt|html?|tex|pdf|docx|pptx|xlsx|png|jpe?g|webp|svg|mp4|mov|mkv|webm|wav|mp3|flac|zip|7z|tar|gz|step|stp|stl|3mf)$/i;
const ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(=])([^\s"'`()=]+\.(?:md|json|csv|txt|html?|tex|pdf|docx|pptx|xlsx|png|jpe?g|webp|svg|mp4|mov|mkv|webm|wav|mp3|flac|zip|7z|tar|gz|step|stp|stl|3mf))(?:$|[\s"'`),;:])/i;

function firstArtifactPath(...values) {
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (!candidate) continue;
    if (!/\s/.test(candidate) && ARTIFACT_EXTENSION_PATTERN.test(candidate)) {
      return candidate;
    }
    const match = candidate.match(ARTIFACT_PATH_PATTERN);
    if (match?.[1]) return match[1];
  }
  return "";
}

function revalidateArtifactEvidence(item = {}, state = {}, context = {}) {
  if (item?.category !== "artifact" || item?.verified === false || item?.virtualArtifact === true) return item;
  const candidate = firstArtifactPath(item.target, item.proof);
  if (!candidate) {
    return item.toolName === "run_command"
      ? {
          ...item,
          verified: false,
          proof: `${item.proof || "artifact evidence"}; no durable artifact path was reported`,
        }
      : item;
  }
  const commandCwd = String(
    context.commandCwd ||
      state.commandCwd ||
      state.meta?.runtimeConfig?.commandCwd ||
      process.cwd()
  );
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(commandCwd, candidate);
  let durable = false;
  try {
    const stat = fs.statSync(resolved);
    durable = stat.isDirectory() || (stat.isFile() && stat.size > 0);
  } catch {
    durable = false;
  }
  return {
    ...item,
    target: candidate,
    resolvedTarget: resolved,
    verified: durable,
    proof: durable
      ? item.proof
      : `${item.proof || "artifact evidence"}; artifact path no longer exists or is empty`,
  };
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
  const events = reconcileTmuxGitEvidenceEvents(
    Array.isArray(context.events) ? context.events : []
  );
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const eventEvidence = events.flatMap(eventToEvidence);
  // Completed tools are mirrored into both the append-only event stream and
  // model messages. Use the chronological event stream when it is available;
  // otherwise use messages as the durable fallback. Combining both can repeat
  // action sequences and fabricate ordered Git completion.
  const hasCompletedToolEvents = events.some((event) => String(event?.type || "") === "tool.completed");
  const messageEvidence = hasCompletedToolEvents ? [] : messages.flatMap(messageToEvidence);
  const items = [...eventEvidence, ...messageEvidence]
    .slice(-80)
    .map((item) => revalidateArtifactEvidence(item, state, context));
  const verifiedItems = items.filter((item) => item?.verified !== false);
  const durableGitEvidence = (
    Array.isArray(state.meta?.durableGitEvidence) ? state.meta.durableGitEvidence : []
  )
    .map((item) => ({
      action: String(item?.action || "").toLowerCase(),
      goalRevision: Math.max(0, Number(item?.goalRevision || 0)),
      mutationRevision: Math.max(0, Number(item?.mutationRevision || 0)),
    }))
    .filter((item) => item.action)
    .slice(-80);
  const categories = unique([
    ...verifiedItems.map((item) => item.category),
    ...(durableGitEvidence.length ? ["git"] : []),
  ]);
  const toolNames = unique(verifiedItems.map((item) => item.toolName).filter(Boolean));
  const blockerEvents = events
    .filter((event) => ["tool.blocked", "tool.failed"].includes(String(event?.type || "")))
    .map((event) => event?.data || {});
  const blockerMessages = messages
    .filter((message) => message?.role === "tool")
    .map((message) => {
      try {
        return JSON.parse(message.content || "{}");
      } catch {
        return {};
      }
    });
  // A newer recoverable classification for the same tool/reason supersedes
  // an older generic denial. Prefer the append-only event stream when it is
  // available so mirrored tool messages cannot resurrect stale blockers.
  const blockers = currentBlockersFromEntries(
    blockerEvents.length ? blockerEvents : blockerMessages,
    blockerEvents.length ? "tool-event" : "tool-message"
  )
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
    durableGitEvidence,
    items: items.map((item, index) => ({
      id: `e${String(index + 1).padStart(3, "0")}`,
      ...item,
    })),
  };
}

export function evaluateScsEvidence(contract = {}, ledger = {}) {
  const required = Array.isArray(contract.requiredEvidence) ? contract.requiredEvidence : [];
  const ledgerCategories = new Set(Array.isArray(ledger.categories) ? ledger.categories : []);
  const ledgerItems = Array.isArray(ledger.items) ? ledger.items : [];
  const requiredToolCalls = Array.isArray(contract.requiredToolCalls) ? contract.requiredToolCalls : [];
  const ledgerToolNames = new Set(Array.isArray(ledger.toolNames) ? ledger.toolNames : []);
  const requiredGitRevision = Math.max(0, Number(contract.requiredGitRevision || 0));
  const requiredGitMutationRevision = Math.max(
    0,
    Number(contract.requiredGitMutationRevision || 0)
  );
  const durableGitEvidence = (
    Array.isArray(ledger.durableGitEvidence) ? ledger.durableGitEvidence : []
  ).filter(
    (item) =>
      item?.action &&
      (requiredGitRevision === 0 || Number(item?.goalRevision || 0) >= requiredGitRevision) &&
      (requiredGitMutationRevision === 0 ||
        Number(item?.mutationRevision || 0) >= requiredGitMutationRevision)
  );
  const observedGitEvidence = durableGitEvidence.length
    ? durableGitEvidence.map((item) => ({
        category: "git",
        verified: true,
        gitAction: item.action,
        goalRevision: item.goalRevision,
        mutationRevision: item.mutationRevision,
      }))
    : ledgerItems;
  const observedGitActionSequence =
    observedGitEvidence
      .filter(
        (item) =>
          item?.category === "git" &&
          item?.verified !== false &&
          (requiredGitRevision === 0 || Number(item?.goalRevision || 0) >= requiredGitRevision) &&
          (requiredGitMutationRevision === 0 ||
            Number(item?.mutationRevision || 0) >= requiredGitMutationRevision)
      )
      .flatMap((item) =>
        Array.isArray(item.gitActions)
          ? item.gitActions
          : item.gitAction
            ? [item.gitAction]
            : inferGitActionsFromCommand(item.command || item.target || "")
      )
      .map((item) => String(item || "").toLowerCase())
      .filter(Boolean);
  const observedGitActions = unique(observedGitActionSequence);
  const requiredGitActions = Array.isArray(contract.requiredGitActions)
    ? contract.requiredGitActions
    : [];
  const missingGitActions = missingRequiredGitActionSequence(
    requiredGitActions,
    observedGitActionSequence
  );
  const satisfied = [];
  const missing = [];
  for (const requirement of required) {
    const minimumGoalRevision = Math.max(0, Number(requirement.minimumGoalRevision || 0));
    const minimumMutationRevision = Math.max(0, Number(requirement.minimumMutationRevision || 0));
    const matchingEvidence = (item) =>
      item?.category === requirement.category &&
      item?.verified !== false &&
      (minimumGoalRevision === 0 || Number(item?.goalRevision || 0) >= minimumGoalRevision) &&
      (minimumMutationRevision === 0 || Number(item?.mutationRevision || 0) >= minimumMutationRevision);
    const categorySatisfied = requirement.category === "git"
      ? gitActionsSatisfyContract(contract, observedGitActionSequence)
      : minimumGoalRevision > 0 || minimumMutationRevision > 0
        ? ledgerItems.some(matchingEvidence)
        : ledgerCategories.has(requirement.category);
    if (categorySatisfied) {
      satisfied.push(requirement);
    } else {
      missing.push(requirement);
    }
  }
  const missingToolCalls = requiredToolCalls.filter((toolName) => !ledgerToolNames.has(toolName));
  const requiredProjectCommands = unique(
    (Array.isArray(contract.requiredProjectCommands) ? contract.requiredProjectCommands : [])
      .map(normalizeProjectCommand)
      .filter(Boolean)
  );
  const projectMutationRevision = Math.max(0, Number(contract.projectMutationRevision || 0));
  const requiredProjectCommandBatchId = String(
    contract.requiredProjectCommandBatchId || ""
  );
  const requiredProjectCommandBatchCommands = unique(
    (Array.isArray(contract.requiredProjectCommandBatchCommands)
      ? contract.requiredProjectCommandBatchCommands
      : [])
      .map(normalizeProjectCommand)
      .filter(Boolean)
  );
  const requiredProjectCommandRuns = Array.isArray(contract.requiredProjectCommandRuns)
    ? contract.requiredProjectCommandRuns
        .map((run) => ({
          command: normalizeProjectCommand(run?.command || ""),
          mutationRevision: Math.max(0, Number(run?.mutationRevision || 0)),
        }))
        .filter((run) => run.command)
    : [];
  const successfulProjectCommandItems = ledgerItems.filter(
    (item) => item?.category === "command" && item?.verified !== false
  );
  const missingProjectCommands = requiredProjectCommands.filter(
    (requiredCommand) => {
      const batchGoverned =
        requiredProjectCommandBatchId &&
        requiredProjectCommandBatchCommands.includes(requiredCommand);
      const expectedRun = batchGoverned
        ? requiredProjectCommandRuns.find((run) => run.command === requiredCommand)
        : null;
      if (batchGoverned && !expectedRun) return true;
      return !successfulProjectCommandItems.some((item) => {
        if (!observedProjectCommandSatisfies(requiredCommand, item)) return false;
        if (expectedRun) {
          return (
            String(item?.requiredCommandBatchId || "") === requiredProjectCommandBatchId &&
            Number(item?.mutationRevision || 0) === expectedRun.mutationRevision
          );
        }
        return Number(item?.mutationRevision || 0) >= projectMutationRevision;
      });
    }
  );
  const hasAnyEvidence = Number(ledger.itemCount || 0) > 0;
  const missingNonGitEvidence = missing
    .filter((item) => item?.category !== "git")
    .sort((left, right) => {
      const order = new Map([
        ["file", 0],
        ["test", 1],
        ["command", 2],
        ["artifact", 3],
        ["visual", 4],
        ["browser", 5],
        ["publish", 6],
      ]);
      return (order.get(left?.category) ?? 99) - (order.get(right?.category) ?? 99);
    });
  const freshMissingEvidence = missingNonGitEvidence.filter(
    (item) =>
      Number(item?.minimumGoalRevision || 0) > 0 ||
      Number(item?.minimumMutationRevision || 0) > 0
  );
  const minimumMissingMutationRevision = Math.max(
    0,
    ...freshMissingEvidence.map((item) => Number(item?.minimumMutationRevision || 0))
  );
  const evidenceOk = !contract.requiresExternalEvidence || (missing.length === 0 && hasAnyEvidence);
  const ok =
    evidenceOk &&
    missingGitActions.length === 0 &&
    missingToolCalls.length === 0 &&
    missingProjectCommands.length === 0;
  return {
    ok,
    requiresExternalEvidence: Boolean(contract.requiresExternalEvidence),
    hasAnyEvidence,
    satisfied,
    missing,
    requiredToolCalls,
    missingToolCalls,
    requiredGitActions,
    requiredGitRevision,
    observedGitActions,
    missingGitActions,
    requiredProjectCommands,
    requiredProjectCommandBatchId,
    requiredProjectCommandBatchCommands,
    requiredProjectCommandRuns,
    missingProjectCommands,
    reason: ok
      ? "Evidence satisfies the deterministic task contract."
      : missingProjectCommands.length
        ? `Missing successful required project command(s) after the latest change: ${missingProjectCommands.join(", ")}.`
        : missingNonGitEvidence.length
          ? freshMissingEvidence.length
            ? `Missing fresh post-correction evidence${minimumMissingMutationRevision > 0 ? ` after project mutation revision ${minimumMissingMutationRevision}` : ""}: ${missingNonGitEvidence.map((item) => item.category).join(", ")}. Apply the requested source/file correction before validation or Git completion.`
            : `Missing evidence categories: ${missingNonGitEvidence.map((item) => item.category).join(", ")}. Perform the requested work before Git completion.`
        : missingGitActions.length
          ? `Missing required git action(s): ${missingGitActions.join(", ")}.`
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
        minimumGoalRevision: Number(item.minimumGoalRevision || 0),
        minimumMutationRevision: Number(item.minimumMutationRevision || 0),
      })),
      forbiddenActions: contract.forbiddenActions || [],
      exactOutputPaths: contract.exactOutputPaths || [],
      requiredArtifactKinds: contract.requiredArtifactKinds || [],
      exactInputPaths: contract.exactInputPaths || [],
      requiredToolCalls: contract.requiredToolCalls || [],
      requiredGitActions: contract.requiredGitActions || [],
      requiredGitRevision: Number(contract.requiredGitRevision || 0),
      requiredGitMutationRevision: Number(contract.requiredGitMutationRevision || 0),
      requiresWorkspaceMutation: Boolean(contract.requiresWorkspaceMutation),
      requiresFileMutation: Boolean(contract.requiresFileMutation),
      requiredProjectCommands: contract.requiredProjectCommands || [],
      requiredProjectCommandBatchId: contract.requiredProjectCommandBatchId || "",
      requiredProjectCommandRuns: contract.requiredProjectCommandRuns || [],
      projectMutationRevision: Number(contract.projectMutationRevision || 0),
      projectTestFiles: contract.projectTestFiles || [],
      requiresSourceGrounding: Boolean(contract.requiresSourceGrounding),
      requiredTextTerms: contract.requiredTextTerms || [],
      requiredExecutableTerms: contract.requiredExecutableTerms || [],
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
        gitActions: item.gitActions || (item.gitAction ? [item.gitAction] : []),
        requiredCommandBatchId: item.requiredCommandBatchId || "",
        requiredProjectCommand: item.requiredProjectCommand || "",
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
      missingGitActions: evaluation.missingGitActions || [],
      observedGitActions: evaluation.observedGitActions || [],
      missingProjectCommands: evaluation.missingProjectCommands || [],
      requiredProjectCommandBatchId: evaluation.requiredProjectCommandBatchId || "",
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
  const explicitTaskBlocker =
    /\b(?:the\s+)?(?:task|request|operation|execution|run|workflow|work)\s+(?:is|remains|was)\s+(?:currently\s+)?(?:blocked|denied|forbidden)\b/i.test(
      text
    );
  const firstPersonInability =
    /\b(?:i|we)\s+(?:(?:am|are)\s+)?(?:currently\s+)?(?:unable\s+to|cannot|can't)\s+(?:continue|complete|finish|proceed|execute|run|access|submit|publish|upload|download|authenticate|log\s*in)\b/i.test(
      text
    );
  const sentenceInitialInability =
    /(?:^|[.!?\n]\s*)unable\s+to\s+(?:continue|complete|finish|proceed|execute|run|access|submit|publish|upload|download|authenticate|log\s*in)\b/i.test(
      text
    );
  const explicitExternalCondition =
    /\b(?:quota exhausted|usage limit|rate limit|missing (?:credential|api key)|external blocker)\b|\b(?:access|permission)\s+(?:is\s+)?(?:denied|forbidden)\b|\b(?:login|authentication|credentials?)\s+(?:is|are)\s+required\b|\b(?:requires?|needs?|waiting for|blocked by|encountered)\s+(?:a\s+)?(?:human\s+)?(?:approval|permission|login|credentials?|an? api key|captcha)\b/i.test(
      text
    );
  return (
    explicitTaskBlocker ||
    firstPersonInability ||
    sentenceInitialInability ||
    explicitExternalCondition
  );
}

export function finishResultClaimsIncompleteWork(result = "") {
  const text = String(result || "")
    .replace(
      /\b(?:earlier|previous|prior|former)\s+(?:step|attempt|run|verification|check|phase|command|process|audit)\s+(?:was|were|had\s+been)\s+(?:paused|pending|incomplete|unfinished)\b/gi,
      ""
    )
    .replace(
      /\b(?:(?:was|were|had\s+been)\s+)?(?:previously|formerly|earlier|already)[\s-]+(?:paused|pending|incomplete|unfinished)(?:[\s-]+(?:step|attempt|run|verification|check|phase|command|process|audit))?\b/gi,
      ""
    )
    .replace(/\b(?:not|never)\s+(?:paused|pending|incomplete|unfinished)\b/gi, "")
    .replace(
      /\b(?:no|without)\s+(?:remaining|pending|unfinished)\s+(?:work|steps?|tasks?|actions?|changes?)\b/gi,
      ""
    )
    .replace(/\bno\s+(?:further|additional)\s+(?:work|steps?|tasks?|actions?|changes?)\s+(?:is|are\s+)?(?:needed|required)\b/gi, "")
    .replace(/\bno\s+need\s+for\s+(?:further|additional)\s+(?:work|steps?|tasks?|actions?|changes?)\b/gi, "");
  const explicitIncompleteState =
    /\b(?:paused|unfinished|incomplete|not\s+(?:yet\s+)?(?:complete|completed|done)|still\s+(?:needs?|requires?)\s+(?:work|implementation|repair|validation|testing|verification))\b/i.test(
      text
    ) ||
    /\b(?:the\s+)?(?:task|request|agent\s+work|work|implementation|repair|validation|verification|testing|test\s+run|commit|patch|edit|artifact|report|deliverable|submission|upload|download)\s+(?:is|are|remains?|stays?|was|were)?\s*(?:currently\s+)?pending\b/i.test(
      text
    ) ||
    /\bpending\s+(?:agent\s+)?(?:work|steps?|tasks?|actions?|changes?|implementation|repair|validation|verification|testing|tests?|commits?|patches?|edits?|artifacts?|reports?|deliverables?|submissions?|uploads?|downloads?)\b/i.test(
      text
    );
  const promisedFutureAction =
    /\b(?:will|would|going\s+to|still\s+need(?:s)?\s+to)\s+(?:now\s+)?(?:be\s+)?(?:write|written|rewrite|rewritten|replace|replaced|refactor|refactored|patch|patched|create|created|implement|implemented|fix|fixed|repair|repaired|generate|generated|run|test|tested|validate|validated|verify|verified|continue|continued|finish|finished|complete|completed|submit|submitted|publish|published|upload|uploaded|download|downloaded)\b/i.test(
      text
    );
  const asksForApprovalInsteadOfFinishing =
    /\b(?:do you approve|please approve|reply ["']?yes|ask(?:ing)? for approval|need(?:s)? (?:your |user )?approval|must ask(?: the user)?|await(?:ing)? approval)\b/i.test(
      text
    );
  return explicitIncompleteState || promisedFutureAction || asksForApprovalInsteadOfFinishing;
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
      ...(evaluation.missingProjectCommands?.length
        ? [`Required project commands missing after the latest change: ${evaluation.missingProjectCommands.join(", ")}`]
        : []),
    ],
    nextRequiredAction:
      "Collect the missing concrete evidence, verify the requested state or artifact, then ask SCS to finish again; if impossible, report a real blocker with proof.",
  };
}
