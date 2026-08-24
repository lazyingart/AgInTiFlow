import { Buffer } from "node:buffer";

import { EXECUTION_LIMITS } from "./execution-worker.js";

export const INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION =
  "aginti-integration-explicit-python-v1";

const MAXIMUM_PROMPT_BYTES = 32 * 1024;
const CANONICAL_PYTHON_FENCE =
  /(^|\n)```python[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\n|$)/giu;
const MARKDOWN_FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/gmu;
const DEFAULT_IGNORABLE_OUTSIDE = /\p{Default_Ignorable_Code_Point}/u;
const FORBIDDEN_PROMPT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FORBIDDEN_SOURCE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FORBIDDEN_SOURCE_BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/u;
const PUBLIC_REDACTION_MARKER = /\[REDACTED(?:_PATH)?\]/u;
const NEGATED_PLOT =
  /(?:\b(?:not|no|without)\s+(?:a\s+|any\s+)?(?:plot|chart|graph)\b|(?:不|不要|无需|無需|不用)(?:画图|畫圖|绘图|繪圖|生成图表|生成圖表))/iu;
const REQUESTED_PLOT =
  /(?:\b(?:plot|chart|graph|visuali[sz]e)\b|\b(?:show|make|create|generate|draw|render|produce|return|include|display)\b.{0,72}\b(?:plot|chart|graph)\b|(?:画图|畫圖|绘图|繪圖|生成图表|生成圖表|显示图表|顯示圖表))/iu;
const ENGLISH_BROAD_EXECUTION = /^(?:run|execute)\b/iu;
const CHINESE_BROAD_EXECUTION = /^(?:运行|運行|执行|執行)/iu;
const ENGLISH_CODE_NOUN = "(?:python(?:\\s+(?:code|script|program|snippet|block))?|code|script|program|snippet|block)";
const ENGLISH_CODE_TARGET =
  `(?:(?:corrected|revised|updated)\\s+)?${ENGLISH_CODE_NOUN}`;
const ENGLISH_PREFIX_TARGET = [
  `(?:(?:this|that|my)\\s+${ENGLISH_CODE_TARGET}(?:\\s+below)?)`,
  `(?:(?:the\\s+)?(?:following|below)(?:\\s+${ENGLISH_CODE_TARGET})?)`,
  `(?:the\\s+${ENGLISH_CODE_TARGET}(?:\\s+below)?)`,
  ENGLISH_CODE_TARGET,
  "(?:this|that|it)",
].join("|");
const ENGLISH_SUFFIX_TARGET = [
  `(?:(?:this|that|my)\\s+${ENGLISH_CODE_TARGET}(?:\\s+above)?)`,
  `(?:(?:the\\s+)?(?:above)(?:\\s+${ENGLISH_CODE_TARGET})?)`,
  `(?:the\\s+${ENGLISH_CODE_TARGET}(?:\\s+above)?)`,
  ENGLISH_CODE_TARGET,
  "(?:this|that|it)",
].join("|");
const ENGLISH_RESULT_OBJECT =
  "(?:result|results|output|stdout|stderr|messages|plot|chart|graph|artifact|artifacts|data|value|values|it)";
const ENGLISH_RESULT_REQUEST =
  "(?:show|display|return|give|print|output|produce|create|generate|draw|render|include|plot|chart|graph|visuali[sz]e)" +
  "\\s+(?:me\\s+)?(?:both\\s+)?(?:(?:the|a|an|its|my|their)\\s+)?" +
  `${ENGLISH_RESULT_OBJECT}(?:\\s+and\\s+(?:(?:the|a|an|its|my|their)\\s+)?${ENGLISH_RESULT_OBJECT})?`;
const ENGLISH_FIRST_PERSON_PLOT_REQUEST =
  "i\\s+(?:need|want|would\\s+like)\\s+(?:a\\s+|the\\s+)?(?:plot|chart|graph)";
const ENGLISH_NO_PLOT = "(?:[ \\t]*,?[ \\t]*(?:but[ \\t]+)?(?:not|no|without)[ \\t]+(?:a[ \\t]+|any[ \\t]+)?(?:plot|chart|graph))?";
const ENGLISH_REQUIRED_RESULT_SUFFIX =
  `(?:[ \\t]*(?:[,;][ \\t]*)?(?:(?:and(?:[ \\t]+then)?|then|to)[ \\t]+)?${ENGLISH_RESULT_REQUEST}${ENGLISH_NO_PLOT}` +
  `|[ \\t]*[;,][ \\t]*${ENGLISH_FIRST_PERSON_PLOT_REQUEST})`;
const ENGLISH_RESULT_SUFFIX = `(?:${ENGLISH_REQUIRED_RESULT_SUFFIX})?`;
const ENGLISH_END = "[ \\t]*(?:,[ \\t]*)?(?:please[ \\t]*)?(?:[.!?]|:)?[ \\t]*";
const ENGLISH_PREFIX_DIRECTIVE = new RegExp(
  `^(?:(?:run|execute)\\s+(?:${ENGLISH_PREFIX_TARGET})${ENGLISH_RESULT_SUFFIX}|(?:run|execute)${ENGLISH_REQUIRED_RESULT_SUFFIX}|(?:run|execute)[ \\t]*:)${ENGLISH_END}$`,
  "iu"
);
const ENGLISH_SUFFIX_DIRECTIVE = new RegExp(
  `^(?:(?:run|execute)\\s+(?:${ENGLISH_SUFFIX_TARGET})${ENGLISH_RESULT_SUFFIX}|(?:run|execute)${ENGLISH_REQUIRED_RESULT_SUFFIX}|(?:run|execute)[ \\t]*:)${ENGLISH_END}$`,
  "iu"
);
const CHINESE_PREFIX_TARGET =
  "(?:(?:以下|下面)(?:的)?(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式)?|(?:这段|這段|这个|這個|该|該)(?:的)?(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式)|(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式))";
const CHINESE_SUFFIX_TARGET =
  "(?:(?:上述|上面)(?:的)?(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式)?|(?:这段|這段|这个|這個|该|該)(?:的)?(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式)|(?:python)?(?:代码|代碼|程式碼|脚本|腳本|程序|程式))";
const CHINESE_RESULT_SUFFIX =
  "(?:[ \\t]*[，,;；]?[ \\t]*(?:(?:并|並|然后|然後|并且|並且)[ \\t]*)?(?:显示|顯示|返回|给出|給出|输出|輸出|生成|绘制|繪製)[ \\t]*(?:结果|結果|输出|輸出|图表|圖表|图像|圖像|绘图|繪圖)(?:[ \\t]*[，,]?[ \\t]*(?:但|但是)?(?:不|不要|无需|無需|不用)(?:画图|畫圖|绘图|繪圖|生成图表|生成圖表))?)?";
const CHINESE_END = "[ \\t]*(?:[。.!！?？]|[:：])?[ \\t]*";
const CHINESE_PREFIX_DIRECTIVE = new RegExp(
  `^(?:(?:运行|運行|执行|執行)(?:一下)?${CHINESE_PREFIX_TARGET}${CHINESE_RESULT_SUFFIX}|(?:运行|運行|执行|執行)(?:一下)?[ \\t]*[:：])${CHINESE_END}$`,
  "iu"
);
const CHINESE_SUFFIX_DIRECTIVE = new RegExp(
  `^(?:(?:运行|運行|执行|執行)(?:一下)?${CHINESE_SUFFIX_TARGET}${CHINESE_RESULT_SUFFIX}|(?:运行|運行|执行|執行)(?:一下)?[ \\t]*[:：])${CHINESE_END}$`,
  "iu"
);

const NONE = Object.freeze({
  schemaVersion: INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION,
  kind: "none",
});
const NON_EXECUTION = Object.freeze({
  schemaVersion: INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION,
  kind: "non-execution",
});

export class IntegrationExplicitPythonError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationExplicitPythonError";
    this.code = "ANALYSIS_EXPLICIT_PYTHON_INVALID";
    this.publicCode = this.code;
    this.status = 400;
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new IntegrationExplicitPythonError(message);
}

function actionText(value) {
  let text = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  text = text.replace(/^(?:please|kindly)[ \t]*,?[ \t]+/iu, "");
  text = text.replace(
    /^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)[ \t]*,?[ \t]+)?/iu,
    ""
  );
  text = text.replace(
    /^i(?:['’]d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu,
    ""
  );
  text = text.replace(/^let(?:['’]s|\s+us)\s+/iu, "");
  text = text.replace(/^(?:请你?|請你?|麻烦你?|麻煩你?|劳驾|勞駕)[ \t]*/u, "");
  return text;
}

function targetedExecution(value, position) {
  const text = actionText(value);
  if (!text) return false;
  return position === "prefix"
    ? ENGLISH_PREFIX_DIRECTIVE.test(text) || CHINESE_PREFIX_DIRECTIVE.test(text)
    : ENGLISH_SUFFIX_DIRECTIVE.test(text) || CHINESE_SUFFIX_DIRECTIVE.test(text);
}

function broadExecution(value) {
  const text = actionText(value);
  return ENGLISH_BROAD_EXECUTION.test(text) || CHINESE_BROAD_EXECUTION.test(text);
}

function canonicalMatches(prompt) {
  CANONICAL_PYTHON_FENCE.lastIndex = 0;
  const matches = [...prompt.matchAll(CANONICAL_PYTHON_FENCE)];
  CANONICAL_PYTHON_FENCE.lastIndex = 0;
  return matches;
}

function fenceMarkers(prompt) {
  MARKDOWN_FENCE_LINE.lastIndex = 0;
  const markers = [...prompt.matchAll(MARKDOWN_FENCE_LINE)];
  MARKDOWN_FENCE_LINE.lastIndex = 0;
  return markers;
}

function splitAroundCandidate(prompt, candidate) {
  if (!candidate) return Object.freeze({ prefix: prompt, suffix: "", outside: prompt });
  const prefix = prompt.slice(0, candidate.index);
  const suffix = prompt.slice(candidate.index + candidate[0].length);
  return Object.freeze({ prefix, suffix, outside: `${prefix}\n${suffix}` });
}

function plotRequested(outside) {
  return REQUESTED_PLOT.test(outside) && !NEGATED_PLOT.test(outside);
}

export function classifyIntegrationExplicitPythonPrompt(value) {
  if (typeof value !== "string") return NONE;
  if (!value.isWellFormed()) {
    invalid("The fenced-code request contains ill-formed Unicode text.");
  }
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_PROMPT_BYTES) {
    invalid("The explicit Python request exceeds the public prompt limit.");
  }

  const markers = fenceMarkers(value);
  if (markers.length === 0) return NONE;
  const matches = canonicalMatches(value);
  const candidate = matches.length === 1 ? matches[0] : null;
  const { prefix, suffix, outside } = splitAroundCandidate(value, candidate);
  if (DEFAULT_IGNORABLE_OUTSIDE.test(outside) || FORBIDDEN_PROMPT_CONTROLS.test(outside)) {
    invalid("The fenced-code request contains hidden formatting controls.");
  }
  const prefixRequested = targetedExecution(prefix, "prefix");
  const suffixRequested = targetedExecution(suffix, "suffix");
  const requested =
    (prefixRequested && !suffix.trim()) ||
    (suffixRequested && !prefix.trim());
  const broadRequest = broadExecution(prefix) || broadExecution(suffix);

  if (!requested) {
    if (broadRequest) invalid("The fenced-code execution request is not unambiguous.");
    return NON_EXECUTION;
  }
  if (candidate === null || matches.length !== 1 || markers.length !== 2) {
    invalid("Explicit Python execution requires exactly one canonical ```python fenced block.");
  }

  const source = candidate[2];
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (
    sourceBytes < 1 ||
    sourceBytes > EXECUTION_LIMITS.maximumSourceBytes ||
    !source.trim() ||
    FORBIDDEN_SOURCE_CONTROLS.test(source) ||
    FORBIDDEN_SOURCE_BIDI_CONTROLS.test(source)
  ) {
    invalid("The explicit Python source is empty, malformed, or exceeds the execution limit.");
  }
  if (PUBLIC_REDACTION_MARKER.test(source)) {
    invalid("The Python source was changed by public-data redaction and was not executed.");
  }

  return Object.freeze({
    schemaVersion: INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION,
    kind: "execute",
    execution: Object.freeze({
      source,
      stdin: "",
      timeoutMs: Math.min(10_000, EXECUTION_LIMITS.maximumWallTimeMs),
    }),
    requirements: Object.freeze({
      plotArtifact: plotRequested(outside),
    }),
  });
}

export function compileIntegrationExplicitPythonPrompt(value) {
  const classification = classifyIntegrationExplicitPythonPrompt(value);
  if (classification.kind !== "execute") return null;
  return Object.freeze({
    schemaVersion: classification.schemaVersion,
    ...classification.execution,
    requiresPlotArtifact: classification.requirements.plotArtifact,
  });
}
