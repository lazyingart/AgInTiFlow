import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCUMENT_EXTENSIONS = new Set([".csv", ".json", ".md", ".rst", ".tsv", ".txt", ".yaml", ".yml"]);
const SOURCE_DIRECTORY_NAMES = new Set(["input", "inputs", "material", "materials", "notes", "reference", "references", "source", "sources"]);
const ROOT_SOURCE_NAMES = /^(?:agents?|brief|project[-_ ]?notes?|readme|requirements?|style[-_ ]?notes?|task)(?:\.[^.]+)?$/i;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".aginti",
  ".aginti-preview",
  ".aginti-sessions",
  ".git",
  ".venv",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "outputs",
  "temp",
  "tmp",
]);
const INTENTIONAL_SPARSE_PAGE_PATTERN =
  /^(?:appendix|approval|approvals|acknowledgements?|back cover|contact|notes|references|sign[- ]?off|signatures?)\b/i;
const HISTORICAL_TRANSITION_PATTERN =
  /\b(?:formerly|no longer|previously|replac(?:ed|ing)|supersed(?:e|ed|es|ing)|used to be)\b/i;
const MIN_READABLE_MEDIAN_WORD_HEIGHT_PT = 8.8;
const MIN_READABLE_HORIZONTAL_MARGIN_PT = 18;
const COUNT_WORDS = new Map([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15],
  ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20],
]);
const ACTION_COUNT_PATTERN = new RegExp(
  `\\b(\\d+|${[...COUNT_WORDS.keys()].join("|")})\\s+(?:open|remaining|outstanding|pending)\\s+(?:action items?|actions?|tasks?|items?)\\b`,
  "gi"
);
const ACTION_SECTION_HEADING_PATTERN =
  /^\s*(?:remaining|open|outstanding|pending)\s+(?:action items?|actions?|tasks?|items?|next steps)\s*$/i;
const DOCUMENT_SECTION_HEADING_PATTERN =
  /^\s*(?:appendix|budget|current decisions?|executive summary|notes|references|risks?(?: and mitigations)?|summary)\s*$/i;
const HUMAN_DATE_PATTERN =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)\b/gi;

function portablePath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function decodeXml(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textFromDocumentXml(xml = "") {
  return decodeXml(
    String(xml || "")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedComparableText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const SOURCE_UNRESOLVED_STATUS_PATTERN =
  /\b(?:awaiting|blocked|login\s+required|no\s+upload\s+started|not\s+(?:yet\s+)?(?:confirmed|complete|completed|verified)|pending|requires?\s+(?:confirmation|verification)|still\s+(?:needs?|requires?)\s+(?:checking|confirmation|verification)|unconfirmed|unverified|waiting)\b|(?:阻塞|登录(?:已)?过期|登入(?:已)?過期|需要登录|需要登入)|(?:尚未|还没|還沒|未)(?:确认|確認|核实|核實|验证|驗證|完成|同步|上传|上傳|发布|發佈)|(?:等待|待)(?:确认|確認|核实|核實|验证|驗證)|(?:需要|必须|必須|要).{0,24}(?:查证|查證|核实|核實|验证|驗證|确认|確認).{0,24}(?:才|后|後).{0,20}(?:完成|写成完成|寫成完成|列为完成|列為完成)|(?:不能|不要).{0,30}(?:写成|寫成|列为|列為|视为|視為).{0,10}(?:完成|已完成)/iu;
const OUTPUT_COMPLETION_STATUS_PATTERN =
  /\b(?:archived|backed\s+up|completed|confirmed|delivered|done|finished|paid|posted|published|saved|synced|synchronized|uploaded|verified)\b|(?:已(?:完成|确认|確認|交付|付款|支付|发布|發佈|归档|歸檔|保存|同步|上传|上傳|验证|驗證)|完成事项|完成事項)/iu;
const OUTPUT_NEGATED_STATUS_PATTERN =
  /\b(?:not|never|no)\b.{0,28}\b(?:archived|backed\s+up|completed|confirmed|delivered|done|finished|paid|posted|published|saved|synced|synchronized|uploaded|verified)\b|(?:未|没有|沒有|不要|不能).{0,24}(?:完成|确认|確認|交付|付款|支付|发布|發佈|归档|歸檔|保存|同步|上传|上傳|验证|驗證)/iu;
const STATUS_EVIDENCE_STOP_WORDS = new Set([
  "action", "actions", "already", "complete", "completed", "confirmation", "confirmed",
  "been", "current", "done", "evidence", "finished", "has", "item", "items", "pending", "posted", "received",
  "request", "requested", "requires", "status", "still", "task", "tasks", "unconfirmed",
  "unverified", "verification", "verified", "waiting",
]);
const STATUS_CJK_BIGRAM_STOP_WORDS = new Set([
  "不要", "不能", "今天", "仍然", "以后", "已完", "完成", "如果", "已经", "目前", "需要",
  "是否", "等待", "确认", "確認", "明确", "明確", "真正", "才能", "这个", "這個",
]);
const STATUS_HAN_CHAR_STOP_CHARS = new Set(
  [..."的是了和与與及在有为為把被已未不没沒要需会會可到收成完后後前今明这這个個其还還只再"]
);
const SOURCE_TOPIC_STOP_WORDS = new Set([
  "Agents", "Chat", "Completed", "Document", "Generated", "History", "Lachlan",
  "LaTeX", "Markdown", "PDF", "Project", "Read", "Report", "System", "TASK",
  "Task", "Timestamps", "Today", "Verify",
]);

function statusClauses(text = "") {
  const clauses = [];
  String(text || "")
    .replace(/\r/gu, "")
    .replace(/\n(?=\s*[\u0088•*-]\s+)/gu, "\n\n")
    .split(/\n\s*\n|\f/gu)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/gu, " ").trim())
    .filter(Boolean)
    .forEach((line, lineIndex) => {
      line
        .split(/(?<!\d)\.(?!\d)|[!?;。！？；]+/u)
        .map((item) => item.replace(/\s+/gu, " ").trim())
        .filter(Boolean)
        .forEach((value, clauseIndex) => clauses.push({ value, lineIndex, clauseIndex }));
    });
  return clauses;
}

function statusEntityText(text = "") {
  return String(text || "").replace(
    /^\s*(?:\[[^\]\r\n]{1,80}\]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s+[^:：\r\n]{1,80}[:：]\s*/u,
    ""
  );
}

function statusLatinTerms(text = "") {
  return new Set(
    (normalizedComparableText(statusEntityText(text)).match(/[a-z][a-z0-9_./+-]{2,}/gu) || [])
      .map((item) => item.replace(/^[./+-]+|[./+-]+$/gu, ""))
      .filter((item) => item.length >= 3 && !STATUS_EVIDENCE_STOP_WORDS.has(item))
  );
}

function statusHanCharacters(text = "") {
  return new Set(
    (statusEntityText(text).match(/\p{Script=Han}/gu) || [])
      .filter((value) => !STATUS_HAN_CHAR_STOP_CHARS.has(value))
  );
}

function statusCjkBigrams(text = "") {
  const values = new Set();
  for (const run of statusEntityText(text).match(/\p{Script=Han}+/gu) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const value = run.slice(index, index + 2);
      if (!STATUS_CJK_BIGRAM_STOP_WORDS.has(value)) values.add(value);
    }
  }
  return values;
}

function setsOverlap(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

export function evaluateUnverifiedSourceCompletionClaims({ sourceText = "", outputText = "" } = {}) {
  const sourceClauses = statusClauses(sourceText).map((clause) => ({
    ...clause,
    latin: statusLatinTerms(clause.value),
    han: statusHanCharacters(clause.value),
    bigrams: statusCjkBigrams(clause.value),
  }));
  const unresolvedIndexes = sourceClauses
    .map((clause, index) => SOURCE_UNRESOLVED_STATUS_PATTERN.test(clause.value) ? index : -1)
    .filter((index) => index >= 0);
  const outputClauses = statusClauses(outputText);
  const outputClaims = outputClauses
    .map((clause, index) => {
      const latin = statusLatinTerms(clause.value);
      const bigrams = statusCjkBigrams(clause.value);
      const previous = index > 0 ? outputClauses[index - 1] : null;
      if (
        latin.size === 0 &&
        bigrams.size === 0 &&
        previous?.lineIndex === clause.lineIndex &&
        previous.clauseIndex + 1 === clause.clauseIndex
      ) {
        for (const term of statusLatinTerms(previous.value)) latin.add(term);
        for (const term of statusCjkBigrams(previous.value)) bigrams.add(term);
      }
      return { ...clause, latin, bigrams };
    })
    .filter((clause) =>
      OUTPUT_COMPLETION_STATUS_PATTERN.test(clause.value) &&
      !OUTPUT_NEGATED_STATUS_PATTERN.test(clause.value)
    );
  const defects = [];

  for (const unresolvedIndex of unresolvedIndexes) {
    const connected = new Set([unresolvedIndex]);
    const unresolved = sourceClauses[unresolvedIndex];
    for (const [candidateIndex, candidate] of sourceClauses.entries()) {
      if (candidateIndex === unresolvedIndex) continue;
      const adjacentSameLine =
        candidate.lineIndex === unresolved.lineIndex &&
        Math.abs(candidate.clauseIndex - unresolved.clauseIndex) === 1 &&
        (
          setsOverlap(candidate.han, unresolved.han) ||
          setsOverlap(candidate.bigrams, unresolved.bigrams) ||
          setsOverlap(candidate.latin, unresolved.latin)
        );
      if (
        adjacentSameLine ||
        setsOverlap(candidate.latin, unresolved.latin) ||
        setsOverlap(candidate.bigrams, unresolved.bigrams)
      ) {
        connected.add(candidateIndex);
      }
    }
    const latinAnchors = new Set();
    const cjkAnchors = new Set();
    for (const index of connected) {
      for (const term of sourceClauses[index].latin) latinAnchors.add(term);
      for (const term of sourceClauses[index].bigrams) cjkAnchors.add(term);
    }
    const conflict = outputClaims.find((claim) =>
      setsOverlap(claim.latin, latinAnchors) || setsOverlap(claim.bigrams, cjkAnchors)
    );
    if (!conflict) continue;
    const anchor = [...conflict.latin].find((term) => latinAnchors.has(term)) ||
      [...conflict.bigrams].find((term) => cjkAnchors.has(term)) ||
      "the same item";
    defects.push({
      code: "source-unverified-completion-claim",
      message:
        `The output reports ${JSON.stringify(anchor)} as completed, but the authoritative source says that item still requires confirmation or verification. ` +
        "Keep it pending or unverified until completion evidence is present.",
    });
  }

  return { ok: defects.length === 0, defects };
}

export function sourceTopicCoverageRequested(goal = "", sourceText = "") {
  const contract = `${goal}\n${sourceText}`;
  return (
    /\b(?:complete\s+(?:source|context)|context[- ]complete|full\s+(?:context|source)|read\s+the\s+complete|reconcile(?:d|s|ing)?\s+(?:corrections?|dependencies|source))\b/iu.test(
      contract
    ) ||
    /(?:完整(?:上下文|内容|內容|材料|资料|資料)|阅读全文|閱讀全文|读取完整|讀取完整|综合全部|綜合全部|结合全部|結合全部|对照全部|對照全部|协调更正|協調更正)/u.test(
      contract
    )
  );
}

function salientSourceTopicAnchors(sourceText = "") {
  const scores = new Map();
  const add = (value, weight = 1) => {
    const cleaned = String(value || "")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.+-]+$/gu, "")
      .trim();
    if (
      cleaned.length < 2 ||
      cleaned.length > 80 ||
      SOURCE_TOPIC_STOP_WORDS.has(cleaned) ||
      /\.(?:md|pdf|tex)$/iu.test(cleaned)
    ) {
      return;
    }
    const key = normalizedComparableText(cleaned);
    if (!key) return;
    const prior = scores.get(key) || { value: cleaned, score: 0 };
    prior.score += weight;
    if (cleaned.length > prior.value.length) prior.value = cleaned;
    scores.set(key, prior);
  };

  for (const clause of statusClauses(sourceText)) {
    const body = statusEntityText(clause.value);
    for (const match of body.matchAll(
      /\b(?:[A-Z]{2,}[A-Z0-9+-]*|[A-Za-z]+\d[A-Za-z0-9.+-]*|[A-Za-z]*\d+[A-Za-z][A-Za-z0-9.+-]*|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z]{3,})\b/gu
    )) {
      add(match[0], 2);
    }
    for (const match of body.matchAll(
      /(?<![\d.])\d+(?:\.\d+)?\s*(?:V|mA|A|mm|cm|um|µm|nm|ms|Hz|kHz|MHz|GB|MB)\b/giu
    )) {
      add(match[0].replace(/\s+/gu, " "), 3);
    }
  }
  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))
    .slice(0, 24)
    .map((item) => item.value);
}

export function evaluateSourceTopicCoverage({
  goal = "",
  sourceText = "",
  outputText = "",
} = {}) {
  if (!sourceTopicCoverageRequested(goal, sourceText)) {
    return {
      ok: true,
      checked: false,
      anchors: [],
      covered: [],
      missing: [],
      defects: [],
    };
  }
  const anchors = salientSourceTopicAnchors(sourceText);
  if (anchors.length < 4 || String(sourceText || "").length < 400) {
    return {
      ok: true,
      checked: false,
      anchors,
      covered: [],
      missing: [],
      defects: [],
    };
  }
  const covered = anchors.filter((anchor) => containsLiteral(outputText, anchor));
  const missing = anchors.filter((anchor) => !covered.includes(anchor));
  const requiredCovered = Math.min(6, Math.max(3, Math.ceil(anchors.length * 0.3)));
  const defects = covered.length < requiredCovered
    ? [{
        code: "source-topic-coverage-incomplete",
        message:
          `The report covers only ${covered.length}/${anchors.length} salient source anchors, below the ${requiredCovered}-anchor context-completeness floor. ` +
          `It appears to describe document generation instead of the source content. Re-read the authoritative material and incorporate its current decisions, statuses, constraints, and ideas. Missing examples: ${missing.slice(0, 8).join(", ")}.`,
      }]
    : [];
  return {
    ok: defects.length === 0,
    checked: true,
    anchors,
    covered,
    missing,
    requiredCovered,
    defects,
  };
}

function latexWithoutComments(source = "") {
  return String(source || "")
    .split(/\r?\n/u)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
          slashCount += 1;
        }
        if (slashCount % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

export function evaluateLatexSourceStructure(source = "") {
  const uncommented = latexWithoutComments(source);
  const endings = [...uncommented.matchAll(/\\end\s*\{\s*document\s*\}/gu)];
  const defects = [];
  const singletonCommands = ["documentclass", "title", "author", "date"];
  for (const command of singletonCommands) {
    const matches = [
      ...uncommented.matchAll(
        new RegExp(`^\\\\${command}(?:\\s*\\[[^\\]\\n]*\\])?\\s*\\{`, "gmu")
      ),
    ];
    if (matches.length > 1) {
      defects.push({
        code: "latex-duplicate-singleton-command",
        command,
        count: matches.length,
        message: `The LaTeX source contains ${matches.length} active \\${command} declarations; keep one authoritative value.`,
      });
    }
  }
  if (endings.length === 0) {
    defects.push({
      code: "latex-missing-document-end",
      message: "The LaTeX source has no active \\end{document} marker.",
    });
  } else {
    if (endings.length > 1) {
      defects.push({
        code: "latex-duplicate-document-end",
        message: `The LaTeX source contains ${endings.length} active \\end{document} markers, which indicates duplicated document content.`,
      });
    }
    const firstEnding = endings[0];
    const trailing = uncommented.slice(firstEnding.index + firstEnding[0].length).trim();
    if (trailing) {
      defects.push({
        code: "latex-content-after-document-end",
        message: "The LaTeX source contains active content after the first \\end{document} marker.",
      });
    }
  }
  return {
    ok: defects.length === 0,
    endDocumentCount: endings.length,
    defects,
  };
}

function containsLiteral(text = "", literal = "") {
  const normalizedText = normalizedComparableText(text);
  const normalizedLiteral = normalizedComparableText(literal);
  if (!normalizedText || !normalizedLiteral) return false;
  const escaped = normalizedLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(
    normalizedText
  );
}

function cleanedSupersededLiteral(value = "") {
  return String(value || "")
    .replace(/^[\s:;,()\[\]-]+|[\s:;,()\[\].-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSupersededLiterals(sourceText = "") {
  const text = String(sourceText || "");
  const values = [];
  const add = (value) => {
    const cleaned = cleanedSupersededLiteral(value);
    if (cleaned.length < 2 || cleaned.length > 80) return;
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
    values.push(cleaned);
  };

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
    if (/\b(?:correction|corrected|revis(?:ed|ion)|update(?:d)?)\b/i.test(sentence)) {
      for (const match of sentence.matchAll(
        /\bnot\s+((?:[A-Z][\p{L}.'-]+(?:\s+\d{1,2}(?:,\s*\d{4})?)?)|(?:(?:HKD|USD|EUR|GBP|JPY|CNY|RMB)\s*[\d,.]+)|(?:[A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4}))/gu
      )) {
        add(match[1]);
      }
    }
    for (const match of sentence.matchAll(
      /\breplac(?:ed|ing)\s+([A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4})/gu
    )) {
      add(match[1]);
    }
    for (const match of sentence.matchAll(
      /([A-Z][\p{L}\p{N}&.'/-]*(?:\s+[A-Z][\p{L}\p{N}&.'/-]*){0,4})\s+(?:is|was)\s+no longer\b/gu
    )) {
      add(match[1]);
    }
    if (/\bpreliminary\b/i.test(sentence)) {
      for (const match of sentence.matchAll(
        /(?:(?:HKD|USD|EUR|GBP|JPY|CNY|RMB)\s*[\d,.]+|[$€£¥]\s*[\d,.]+)/gu
      )) {
        add(match[0]);
      }
    }
  }

  const seen = new Set();
  return values.filter((value) => {
    const key = normalizedComparableText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePdfBboxPages(bboxXml = "") {
  const pages = [];
  const pagePattern = /<page\b[^>]*width="([^"]+)"[^>]*height="([^"]+)"[^>]*>([\s\S]*?)<\/page>/gi;
  for (const pageMatch of String(bboxXml || "").matchAll(pagePattern)) {
    const width = Number(pageMatch[1]);
    const height = Number(pageMatch[2]);
    const words = [];
    const wordPattern =
      /<word\b[^>]*xMin="([^"]+)"[^>]*yMin="([^"]+)"[^>]*xMax="([^"]+)"[^>]*yMax="([^"]+)"[^>]*>([\s\S]*?)<\/word>/gi;
    for (const wordMatch of pageMatch[3].matchAll(wordPattern)) {
      words.push({
        xMin: Number(wordMatch[1]),
        yMin: Number(wordMatch[2]),
        xMax: Number(wordMatch[3]),
        yMax: Number(wordMatch[4]),
        text: decodeXml(wordMatch[5]).replace(/<[^>]+>/g, "").trim(),
      });
    }
    pages.push({ width, height, words });
  }
  return pages;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluatePdfPageBalance(bboxXml = "") {
  const pages = parsePdfBboxPages(bboxXml);
  const metrics = pages.map((page, index) => {
    const footerCutoff = Number.isFinite(page.height) ? page.height - 60 : Number.POSITIVE_INFINITY;
    const contentWords = page.words.filter((word) => word.text && word.yMin < footerCutoff);
    const yValues = contentWords.flatMap((word) => [word.yMin, word.yMax]).filter(Number.isFinite);
    const usableHeight = Math.max(1, Number(page.height || 0) - 120);
    const occupiedHeight = yValues.length ? Math.max(...yValues) - Math.min(...yValues) : 0;
    const wordHeights = contentWords
      .map((word) => word.yMax - word.yMin)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      page: index + 1,
      wordCount: contentWords.length,
      occupiedRatio: occupiedHeight / usableHeight,
      medianWordHeight: median(wordHeights),
      leadingText: contentWords.slice(0, 16).map((word) => word.text).join(" ").trim(),
    };
  });
  const defects = [];
  const documentMedianWordHeight = median(
    metrics.flatMap((item) => Array(item.wordCount).fill(item.medianWordHeight))
  );
  if (documentMedianWordHeight > 0 && documentMedianWordHeight < MIN_READABLE_MEDIAN_WORD_HEIGHT_PT) {
    defects.push({
      code: "undersized-document-text",
      message: `The document's median rendered word height is ${documentMedianWordHeight.toFixed(1)} pt, below the ${MIN_READABLE_MEDIAN_WORD_HEIGHT_PT.toFixed(1)} pt readability floor. Keep normal body type and rebalance coherent sections across pages instead of shrinking text to force a page count.`,
    });
  }
  if (metrics.length > 1) {
    const priorWordCounts = metrics.slice(0, -1).map((item) => item.wordCount).filter((value) => value > 0);
    const last = metrics.at(-1);
    const comparisonCount = Math.max(80, median(priorWordCounts) * 0.45);
    const intentionalSparsePage = INTENTIONAL_SPARSE_PAGE_PATTERN.test(last.leadingText);
    if (
      !intentionalSparsePage &&
      last.wordCount > 0 &&
      last.wordCount < comparisonCount &&
      last.occupiedRatio < 0.35
    ) {
      defects.push({
        code: "sparse-trailing-page",
        message: `Page ${last.page} is a sparse spill page (${last.wordCount} words; ${(last.occupiedRatio * 100).toFixed(0)}% usable-height occupancy). Reflow the preceding content or rebalance sections so the final page is intentional and useful.`,
      });
    }
  }
  return {
    ok: pages.length > 0 && defects.length === 0,
    checked: pages.length > 0,
    pages: metrics,
    documentMedianWordHeight,
    defects,
  };
}

export function evaluateExtractedDocumentText(text = "") {
  const source = String(text || "");
  const unexpected = [...source.matchAll(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\ufffd]/gu)]
    .filter((match) => {
      if (match[0] !== "\u0088") return true;
      const before = source.slice(0, match.index);
      const after = source.slice(match.index + match[0].length);
      return !/(?:^|[\n\f])\s*$/u.test(before) || !/^\s+\S/u.test(after);
    })
    .map((match) => match[0].codePointAt(0))
    .filter(Number.isInteger);
  const codePoints = [...new Set(unexpected)].sort((a, b) => a - b);
  const defects = [];
  if (codePoints.length) {
    defects.push({
      code: "corrupt-extracted-text",
      message: `The independently extracted reader text contains unexpected control or replacement glyphs: ${codePoints
        .map((value) => `U+${value.toString(16).toUpperCase().padStart(4, "0")}`)
        .join(", ")}. Repair the document encoding or generator instead of stripping these bytes only during validation.`,
    });
  }
  return { ok: defects.length === 0, defects, codePoints };
}

export function evaluatePdfTextBounds(bboxXml = "", minimumMargin = MIN_READABLE_HORIZONTAL_MARGIN_PT) {
  const pages = parsePdfBboxPages(bboxXml);
  const defects = [];
  for (const [index, page] of pages.entries()) {
    if (!Number.isFinite(page.width) || page.width <= 0) continue;
    const outside = page.words.filter((word) =>
      word.text && (
        !Number.isFinite(word.xMin) ||
        !Number.isFinite(word.xMax) ||
        word.xMin < minimumMargin ||
        word.xMax > page.width - minimumMargin
      )
    );
    if (!outside.length) continue;
    const sample = outside
      .slice(0, 4)
      .map((word) => `${JSON.stringify(word.text)} at ${Number(word.xMin).toFixed(1)}..${Number(word.xMax).toFixed(1)} pt`)
      .join("; ");
    defects.push({
      code: "pdf-text-outside-readable-margin",
      message: `PDF page ${index + 1} places ${outside.length} text item${outside.length === 1 ? "" : "s"} outside the ${minimumMargin} pt horizontal readability margin (${sample}). Reflow the text or table instead of accepting clipping.`,
    });
  }
  return { ok: pages.length > 0 && defects.length === 0, checked: pages.length > 0, defects };
}

export function evaluateCurrentStateText({
  sourceText = "",
  outputText = "",
  currentStateRequired = false,
  goal = "",
} = {}) {
  const supersededLiterals = extractSupersededLiterals(sourceText);
  const presentSupersededLiterals = supersededLiterals.filter((literal) => containsLiteral(outputText, literal));
  const defects = [];
  if (presentSupersededLiterals.length) {
    defects.push({
      code: "superseded-facts-present",
      message: `The reader-facing document still contains superseded source values: ${presentSupersededLiterals.join(", ")}. State only the authoritative current values unless history was explicitly requested.`,
    });
  }
  if (currentStateRequired) {
    const historicalMarkers = [...new Set(
      (String(outputText || "").match(new RegExp(HISTORICAL_TRANSITION_PATTERN.source, "gi")) || [])
        .map((value) => value.toLowerCase())
    )];
    if (historicalMarkers.length) {
      defects.push({
        code: "historical-transition-prose",
        message: `This is a current-state document, but it narrates superseded history (${historicalMarkers.join(", ")}). Remove transition commentary and retain only current decisions.`,
      });
    }
  }
  const unsupportedCompletion = evaluateUnverifiedSourceCompletionClaims({ sourceText, outputText });
  defects.push(...unsupportedCompletion.defects);
  const topicCoverage = evaluateSourceTopicCoverage({ goal, sourceText, outputText });
  defects.push(...topicCoverage.defects);
  return {
    ok: defects.length === 0,
    defects,
    supersededLiterals,
    presentSupersededLiterals,
    topicCoverage,
  };
}

function parsedCount(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  return COUNT_WORDS.get(normalized);
}

function actionSectionItemCount(outputText = "") {
  const lines = String(outputText || "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => ACTION_SECTION_HEADING_PATTERN.test(line));
  if (headingIndex < 0) return 0;
  const section = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (DOCUMENT_SECTION_HEADING_PATTERN.test(line)) break;
    section.push(line);
  }
  const sectionText = section.join("\n");
  const dates = new Set(
    [...sectionText.matchAll(HUMAN_DATE_PATTERN)].map((match) => normalizedComparableText(match[0]))
  );
  const bullets = section.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  return Math.max(dates.size, bullets);
}

export function evaluateDocumentConsistency(outputText = "") {
  const defects = [];
  const normalizedLines = String(outputText || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const repeatedParenthetical = String(outputText || "").match(
    /\(([^()\n]{3,100})\)\s*\(\1\)/iu
  );
  let repeatedWordSequence = "";
  for (const line of normalizedLines) {
    const words = line.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    for (let width = Math.min(8, Math.floor(words.length / 2)); width >= 3; width -= 1) {
      for (let index = 0; index + width * 2 <= words.length; index += 1) {
        const left = words.slice(index, index + width).join(" ").toLowerCase();
        const right = words.slice(index + width, index + width * 2).join(" ").toLowerCase();
        if (left === right) {
          repeatedWordSequence = left;
          break;
        }
      }
      if (repeatedWordSequence) break;
    }
    if (repeatedWordSequence) break;
  }
  if (repeatedParenthetical || repeatedWordSequence) {
    defects.push({
      code: "duplicated-prose-fragment",
      message: `The reader-facing document repeats the same adjacent prose fragment (${JSON.stringify(
        repeatedWordSequence || repeatedParenthetical?.[1] || ""
      )}). Remove the accidental duplication before delivery.`,
    });
  }

  const repeatedProseUnits = new Map();
  for (const unit of String(outputText || "")
    .replace(/\r/gu, "")
    .replace(/\f/gu, "\n\n")
    .replace(/\n(?=\s*[\u0088•*-]\s+)/gu, "\n\n")
    .split(/\n\s*\n/gu)
    .flatMap((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/gu, " ")
        .split(/(?<=[.!?。！？])\s+/u)
    )
    .map((item) => item.replace(/^[\s\u0088•*-]+/u, "").replace(/\s+/gu, " ").trim())
    .filter((item) => item.length >= 60)) {
    const normalized = normalizedComparableText(unit);
    repeatedProseUnits.set(normalized, (repeatedProseUnits.get(normalized) || 0) + 1);
  }
  const repeatedProseUnit = [...repeatedProseUnits.entries()].find(
    ([, count]) => count > 1
  )?.[0];
  if (
    repeatedProseUnit &&
    !defects.some((item) => item.code === "duplicated-prose-fragment")
  ) {
    defects.push({
      code: "duplicated-prose-fragment",
      message: `The reader-facing document repeats the same non-adjacent prose unit (${JSON.stringify(
        repeatedProseUnit.slice(0, 140)
      )}). Remove the duplicate before delivery.`,
    });
  }

  const completedSection = String(outputText || "").match(
    /(?:^|\n)\s*(?:completed tasks?|completed today|完成事项|完成事項|今日完成)\s*\n([\s\S]*?)(?=\n\s*(?:pending actions?|pending tasks?|next steps?|clarifications?|future ideas?|等待事项|等待事項|下一步|明确不要做|明確不要做|值得保留的想法)\s*(?:\n|$)|$)/iu
  )?.[1] || "";
  if (
    completedSection &&
    /\b(?:pending|unverified|awaiting|waiting|not verified|needs? verification|verification (?:is )?pending)\b|(?:待确认|待確認|待核实|待核實|未核实|未核實|未验证|未驗證|等待)/iu.test(
      completedSection
    )
  ) {
    defects.push({
      code: "completed-section-contains-unverified-work",
      message:
        "The Completed section contains work that is still pending or unverified. Move that item to pending/waiting and state only the verified completion evidence.",
    });
  }

  const bulletStatusUnits = String(outputText || "")
    .split(/(?=^\s*[•*-]\s+)/gmu)
    .filter((block) => /^\s*[•*-]\s+/u.test(block))
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const statusUnits = [...normalizedLines, ...bulletStatusUnits];
  const completedLines = statusUnits.filter((line) =>
    /(?:\b(?:completed|done|finished|verified)\b|(?:已完成|完成事项|完成：|已验证))/iu.test(line)
  );
  const unresolvedLines = statusUnits.filter((line) =>
    /(?:\b(?:pending|unverified|awaiting|waiting|not verified|needs? verification)\b|(?:待确认|待核实|未核实|未验证|等待))/iu.test(line)
  );
  const statusStopWords = new Set([
    "action", "actions", "artifact", "artifacts", "completed", "document", "documents",
    "evidence", "finished", "item", "items", "pending", "project", "projects", "report",
    "reports", "status", "task", "tasks", "unverified", "verified", "waiting", "work",
  ]);
  const statusTerms = (line) => new Set(
    (line.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/gu) || [])
      .filter((term) => !statusStopWords.has(term))
  );
  let contradictoryTerm = "";
  for (const completedLine of completedLines) {
    const completedTerms = statusTerms(completedLine);
    for (const unresolvedLine of unresolvedLines) {
      contradictoryTerm = [...statusTerms(unresolvedLine)].find((term) => completedTerms.has(term)) || "";
      if (contradictoryTerm) break;
    }
    if (contradictoryTerm) break;
  }
  if (contradictoryTerm) {
    defects.push({
      code: "completed-unverified-status-conflict",
      message: `The document places ${JSON.stringify(contradictoryTerm)} in both completed and unresolved status text. Keep unverified work out of the completed section until evidence exists.`,
    });
  }

  const sectionCount = actionSectionItemCount(outputText);
  if (sectionCount > 0) {
    for (const match of String(outputText || "").matchAll(ACTION_COUNT_PATTERN)) {
      const declaredCount = parsedCount(match[1]);
      if (Number.isInteger(declaredCount) && declaredCount !== sectionCount) {
        defects.push({
          code: "action-count-inconsistency",
          message: `The document declares ${declaredCount} open action${declaredCount === 1 ? "" : "s"}, but the Remaining Actions section contains ${sectionCount} dated/listed item${sectionCount === 1 ? "" : "s"}. Reconcile the summary and action table before delivery.`,
        });
        break;
      }
    }
  }
  return { ok: defects.length === 0, defects, actionSectionItemCount: sectionCount };
}

export async function collectDocumentSourceDocuments(commandCwd, exactInputPaths = []) {
  const documents = [];
  let totalBytes = 0;
  const maxFiles = 128;
  const maxTotalBytes = 4 * 1024 * 1024;
  const maxFileBytes = 512 * 1024;

  async function visit(directory, sourceRoot = false, depth = 0) {
    if (documents.length >= maxFiles || totalBytes >= maxTotalBytes || depth > 5) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (documents.length >= maxFiles || totalBytes >= maxTotalBytes) break;
      const absolutePath = path.join(directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(lowerName)) continue;
        const nextSourceRoot = sourceRoot || SOURCE_DIRECTORY_NAMES.has(lowerName);
        if (nextSourceRoot) await visit(absolutePath, true, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(lowerName);
      const rootCandidate = directory === commandCwd && ROOT_SOURCE_NAMES.test(entry.name);
      if (!(sourceRoot && DOCUMENT_EXTENSIONS.has(extension)) && !rootCandidate) continue;
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.size <= 0 || stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) continue;
        const text = await fs.readFile(absolutePath, "utf8");
        documents.push({ path: portablePath(path.relative(commandCwd, absolutePath)), text });
        totalBytes += stat.size;
      } catch {
        // Unreadable source material is left to the existing source-coverage gate.
      }
    }
  }

  await visit(commandCwd, false, 0);
  const knownPaths = new Set(documents.map((item) => item.path));
  for (const value of Array.isArray(exactInputPaths) ? exactInputPaths : []) {
    if (documents.length >= maxFiles || totalBytes >= maxTotalBytes) break;
    const absolutePath = path.resolve(commandCwd, String(value || ""));
    if (!isInsideRoot(commandCwd, absolutePath)) continue;
    const relativePath = portablePath(path.relative(commandCwd, absolutePath));
    if (!relativePath || knownPaths.has(relativePath)) continue;
    if (!DOCUMENT_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) continue;
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxFileBytes) continue;
      if (totalBytes + stat.size > maxTotalBytes) continue;
      const text = await fs.readFile(absolutePath, "utf8");
      documents.push({ path: relativePath, text });
      knownPaths.add(relativePath);
      totalBytes += stat.size;
    } catch {
      // Exact unreadable sources remain visible to the existing source/evidence gates.
    }
  }
  return documents;
}

function artifactCandidatesFromText(text = "") {
  const candidates = [];
  const pattern = /(?:`([^`\n]+\.(?:docx|pdf))`|((?:\.?\.?\/[\w .()\/-]+|[\w.-]+(?:\/[\w .()\/-]+)*)\.(?:docx|pdf)))/gi;
  for (const match of String(text || "").matchAll(pattern)) {
    const candidate = String(match[1] || match[2] || "").trim().replace(/[),.;:]+$/g, "");
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function collectOutputDirectoryCandidates(commandCwd) {
  const candidates = [];
  for (const name of ["output", "outputs"]) {
    const root = path.join(commandCwd, name);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 80)) {
      if (!entry.isFile() || !/\.(?:docx|pdf)$/i.test(entry.name)) continue;
      candidates.push(portablePath(path.join(name, entry.name)));
    }
  }
  return candidates;
}

async function resolveExistingArtifacts(commandCwd, values = []) {
  const artifacts = [];
  const seen = new Set();
  for (const value of values) {
    const absolutePath = path.resolve(commandCwd, String(value || ""));
    if (!isInsideRoot(commandCwd, absolutePath) || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size <= 0) continue;
      artifacts.push({
        path: portablePath(path.relative(commandCwd, absolutePath)),
        absolutePath,
        extension: path.extname(absolutePath).toLowerCase(),
        size: stat.size,
      });
    } catch {
      // Missing candidates are reported only when no document artifact exists.
    }
  }
  return artifacts;
}

async function extractPdf(artifact) {
  const [textResult, bboxResult] = await Promise.all([
    execFileAsync("pdftotext", [artifact.absolutePath, "-"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
    }),
    execFileAsync("pdftotext", ["-bbox", artifact.absolutePath, "-"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    }),
  ]);
  return { text: textResult.stdout, bbox: bboxResult.stdout };
}

async function extractDocxText(artifact) {
  const script = [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    "    sys.stdout.buffer.write(archive.read('word/document.xml'))",
  ].join("\n");
  const result = await execFileAsync("python3", ["-c", script, artifact.absolutePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  });
  return textFromDocumentXml(result.stdout);
}

export async function documentArtifactVersioningDefect(workspace, artifactPath) {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", artifactPath], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    return null;
  } catch {
    return {
      code: "document-artifact-not-versioned",
      path: artifactPath,
      message:
        `${artifactPath} is a requested document deliverable but is not tracked by Git. ` +
        "Remove any ignore rule that hides it, stage it explicitly, and commit the source plus final document artifact.",
    };
  }
}

export function currentStateRequested(goal = "", sourceText = "") {
  const contractText = `${goal}\n${sourceText}`;
  return (
    /\b(?:authoritative current|current state|latest explicit correction|latest correction|reconcile(?:d|s|ing)?\s+(?:the\s+)?(?:corrections?|updates?)|superseded|use the latest)\b/i.test(
      contractText
    ) ||
    /(?:更正|纠正|糾正|修正|取消|撤回|以.{0,30}为准|以.{0,30}為準|最新(?:要求|版本|决定|決定)|不要把.{0,60}(?:写成|寫成|列为|列為|视为|視為)(?:完成|已完成))/u.test(
      contractText
    )
  );
}

export async function validateWordDocumentArtifacts({
  commandCwd = process.cwd(),
  candidateResult = "",
  goal = "",
  exactOutputPaths = [],
  exactInputPaths = [],
  requireVersioned = false,
} = {}) {
  const workspace = path.resolve(commandCwd || process.cwd());
  const outputCandidates = [
    ...(Array.isArray(exactOutputPaths) ? exactOutputPaths : []),
    ...artifactCandidatesFromText(candidateResult),
    ...(await collectOutputDirectoryCandidates(workspace)),
  ];
  const artifacts = await resolveExistingArtifacts(workspace, outputCandidates);
  const relevantArtifacts = artifacts.filter((item) => [".docx", ".pdf"].includes(item.extension));
  const defects = [];
  if (!relevantArtifacts.length) {
    return {
      ok: false,
      checked: true,
      artifacts: [],
      defects: [{
        code: "missing-document-artifact",
        message: "The Word/document task claimed completion without a readable DOCX or PDF artifact in the declared output paths or output directory.",
      }],
      reason: "No readable DOCX or PDF artifact was found for the completed document task.",
    };
  }

  const sourceDocuments = await collectDocumentSourceDocuments(workspace, exactInputPaths);
  const sourceText = sourceDocuments.map((item) => item.text).join("\n\n");
  const currentStateRequired = currentStateRequested(goal, sourceText);
  const latexCandidates = new Set(
    (Array.isArray(exactOutputPaths) ? exactOutputPaths : [])
      .filter((item) => /\.tex$/iu.test(String(item || "")))
      .map(String)
  );
  for (const artifact of relevantArtifacts) {
    if (artifact.extension === ".pdf") {
      latexCandidates.add(artifact.path.replace(/\.pdf$/iu, ".tex"));
    }
  }
  const latexArtifacts = (
    await resolveExistingArtifacts(workspace, [...latexCandidates])
  ).filter((item) => item.extension === ".tex");
  const latexSourceReports = [];
  for (const artifact of latexArtifacts) {
    try {
      const source = await fs.readFile(artifact.absolutePath, "utf8");
      const structure = evaluateLatexSourceStructure(source);
      defects.push(...structure.defects.map((item) => ({ ...item, path: artifact.path })));
      latexSourceReports.push({
        path: artifact.path,
        endDocumentCount: structure.endDocumentCount,
      });
    } catch (error) {
      defects.push({
        code: "latex-source-inspection-failed",
        path: artifact.path,
        message: `Could not inspect ${artifact.path}: ${String(error?.message || error).slice(0, 300)}.`,
      });
    }
  }
  const artifactReports = [];
  for (const artifact of relevantArtifacts) {
    if (requireVersioned) {
      const versioningDefect = await documentArtifactVersioningDefect(workspace, artifact.path);
      if (versioningDefect) defects.push(versioningDefect);
    }
    try {
      if (artifact.extension === ".pdf") {
        const extracted = await extractPdf(artifact);
        const textQuality = evaluateExtractedDocumentText(extracted.text);
        const semantic = evaluateCurrentStateText({
          sourceText,
          outputText: extracted.text,
          currentStateRequired,
          goal,
        });
        const consistency = evaluateDocumentConsistency(extracted.text);
        const pageBalance = evaluatePdfPageBalance(extracted.bbox);
        const textBounds = evaluatePdfTextBounds(extracted.bbox);
        if (!String(extracted.text || "").trim()) {
          defects.push({
            code: "empty-pdf-text",
            path: artifact.path,
            message: "The PDF has no independently extractable reader text.",
          });
        }
        if (!pageBalance.checked) {
          defects.push({
            code: "pdf-page-geometry-unavailable",
            path: artifact.path,
            message: "The PDF page geometry could not be extracted, so page balance and clipping cannot be verified.",
          });
        }
        defects.push(...semantic.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...textQuality.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...consistency.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...pageBalance.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...textBounds.defects.map((item) => ({ ...item, path: artifact.path })));
        artifactReports.push({
          path: artifact.path,
          extension: artifact.extension,
          textChars: extracted.text.length,
          pageCount: pageBalance.pages.length,
          pages: pageBalance.pages,
          actionSectionItemCount: consistency.actionSectionItemCount,
          supersededLiterals: semantic.supersededLiterals,
          topicCoverage: semantic.topicCoverage,
        });
      } else {
        const text = await extractDocxText(artifact);
        const textQuality = evaluateExtractedDocumentText(text);
        const semantic = evaluateCurrentStateText({
          sourceText,
          outputText: text,
          currentStateRequired,
          goal,
        });
        const consistency = evaluateDocumentConsistency(text);
        if (!String(text || "").trim()) {
          defects.push({
            code: "empty-docx-text",
            path: artifact.path,
            message: "The DOCX has no independently extractable editable document text.",
          });
        }
        defects.push(...semantic.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...textQuality.defects.map((item) => ({ ...item, path: artifact.path })));
        defects.push(...consistency.defects.map((item) => ({ ...item, path: artifact.path })));
        artifactReports.push({
          path: artifact.path,
          extension: artifact.extension,
          textChars: text.length,
          actionSectionItemCount: consistency.actionSectionItemCount,
          supersededLiterals: semantic.supersededLiterals,
          topicCoverage: semantic.topicCoverage,
        });
      }
    } catch (error) {
      defects.push({
        code: "document-extraction-failed",
        path: artifact.path,
        message: `Could not independently extract and inspect ${artifact.path}: ${String(error?.message || error).slice(0, 300)}.`,
      });
    }
  }

  const uniqueDefects = [];
  const defectKeys = new Set();
  for (const defect of defects) {
    const key = `${defect.code}\n${defect.message}`;
    if (defectKeys.has(key)) continue;
    defectKeys.add(key);
    uniqueDefects.push(defect);
  }
  return {
    ok: uniqueDefects.length === 0,
    checked: true,
    artifacts: artifactReports,
    latexSources: latexSourceReports,
    sourcePaths: sourceDocuments.map((item) => item.path),
    currentStateRequired,
    defects: uniqueDefects,
    reason: uniqueDefects.length
      ? uniqueDefects.map((item) => `${item.path ? `${item.path}: ` : ""}${item.message}`).join(" ")
      : `Independent document checks passed for ${artifactReports.map((item) => item.path).join(", ")}.`,
  };
}
