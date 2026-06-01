const GREETING_PATTERNS = [
  /^(hi|hello|hey|hiya|yo|sup|howdy|good\s+(morning|afternoon|evening))[\s!.。！]*$/i,
  /^(你好|您好|嗨|哈喽|哈啰|早上好|下午好|晚上好)[\s!.。！]*$/i,
  /^(こんにちは|こんばんは|おはよう|おはようございます|やあ|もしもし)[\s!.。！]*$/i,
  /^(안녕하세요|안녕|여보세요)[\s!.。！]*$/i,
  /^(bonjour|salut|hola|hallo|ciao|olá|ola|namaste)[\s!.。！]*$/i,
];

const THANKS_PATTERNS = [
  /^(thanks|thank\s+you|thx|ty|much\s+appreciated)[\s!.。！]*$/i,
  /^(谢谢|多谢|感谢|辛苦了)[\s!.。！]*$/i,
  /^(ありがとう|ありがとうございます|助かりました)[\s!.。！]*$/i,
];

const TOOL_INTENT_RE =
  /\b(create|write|edit|update|fix|patch|modify|delete|remove|rename|move|copy|save|generate|draw|plot|build|compile|run|execute|test|debug|install|download|upload|clone|commit|push|publish|deploy|open|browse|search|read|inspect|analyze|analyse|summarize|summarise|convert|extract|classify|compare|review)\b/i;

const FILE_OR_COMMAND_HINT_RE =
  /(^|\s)(\.{0,2}\/|~\/|[A-Za-z]:\\|[\w.-]+\.(js|ts|jsx|tsx|py|md|tex|json|csv|tsv|txt|yaml|yml|html|css|svg|png|jpg|jpeg|pdf|zip|tar|gz|sh|bash|zsh|rs|go|java|c|cpp|h|hpp|sql)\b|npm\s|node\s|python\s|pip\s|git\s|curl\s|wget\s|docker\s|tmux\s)/i;

function normalizedGoal(goal = "") {
  return String(goal || "")
    .replace(/\s+/g, " ")
    .trim();
}

function directGreetingAnswer(goal) {
  const text = normalizedGoal(goal);
  if (/谢谢|多谢|感谢|辛苦了/.test(text)) return "不用谢。";
  if (/ありがとう|ありがとうございます|助かりました/.test(text)) return "どういたしまして。";
  if (/안녕|감사/.test(text)) return "천만에요.";
  if (/你好|您好|嗨|哈喽|哈啰|早上好|下午好|晚上好/.test(text)) return "你好，我在。";
  if (/こんにちは|こんばんは|おはよう|もしもし/.test(text)) return "こんにちは。";
  if (/bonjour|salut/i.test(text)) return "Bonjour.";
  if (/hola/i.test(text)) return "Hola.";
  return "Hello. How can I help?";
}

function looksLikeDirectGreetingRequest(text) {
  return /^(say|reply|respond)\s+(hi|hello|hey)\b/i.test(text) && !TOOL_INTENT_RE.test(text.replace(/^(say|reply|respond)\s+/i, ""));
}

export function classifyGoalIntent(goal, options = {}) {
  const text = normalizedGoal(goal);
  if (!text) {
    return {
      kind: "empty",
      requiresTools: false,
      directAnswer: "",
      reason: "empty-input",
    };
  }

  if (FILE_OR_COMMAND_HINT_RE.test(text) || TOOL_INTENT_RE.test(text)) {
    return {
      kind: "agentic",
      requiresTools: true,
      directAnswer: "",
      reason: FILE_OR_COMMAND_HINT_RE.test(text) ? "file-or-command-hint" : "tool-intent-keyword",
    };
  }

  if (GREETING_PATTERNS.some((pattern) => pattern.test(text)) || THANKS_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "casual",
      requiresTools: false,
      directAnswer: directGreetingAnswer(text),
      reason: "short-social-turn",
    };
  }

  if (looksLikeDirectGreetingRequest(text)) {
    return {
      kind: "direct-answer",
      requiresTools: false,
      directAnswer: /japanese|日本語|日语|日文/i.test(text) ? "こんにちは。" : directGreetingAnswer(text),
      reason: "explicit-greeting-answer",
    };
  }

  const shortQuestion = text.length <= 160 && /[?？]$/.test(text);
  if (shortQuestion && options.allowQuestionDirectAnswers) {
    return {
      kind: "direct-answer",
      requiresTools: false,
      directAnswer: "",
      reason: "short-question",
    };
  }

  return {
    kind: "agentic",
    requiresTools: true,
    directAnswer: "",
    reason: "default-agentic",
  };
}

export function isDirectAnswerIntent(intent = {}) {
  return Boolean(intent && intent.requiresTools === false && (intent.kind === "casual" || intent.kind === "direct-answer"));
}
