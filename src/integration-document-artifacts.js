import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { MAX_INTEGRATION_FILE_ARTIFACT_BYTES } from "./integration-artifacts.js";
import {
  inspectPrivateIntegrationFileArtifact,
  validateIntegrationTexCompileReceipt,
} from "./integration-tex-compiler.js";

export const INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION = "aginti-integration-document-artifacts-v1";

const execFileAsync = promisify(execFile);
const QPDF_EXECUTABLE = "/usr/bin/qpdf";

const DOCUMENT_ACTION =
  /^(?:make|create|generate|write|rewrite|revise|update|edit|modify|correct|fix|regenerate|recompile|produce|prepare|compile|typeset|render|export|build|deliver|provide|save)\b/iu;
const DOCUMENT_NEED_ACTION = /^(?:(?:i|we)\s+)?(?:need|want|require|would\s+like)\b/iu;
const DOCUMENT_NEED_DELIVERABLE =
  /(?:\.tex\b|\.pdf\b|\b(?:source(?:\s+files?)?|compiled\s+pdf|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|versions?|formats?)\b)/iu;
const DOCUMENT_FOLLOWUP_REFERENCE =
  /\b(?:it|this|that|same|again|latex|tex|pdf|source|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?)\b|(?:它|这个|這個|同一|再次|重新|源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用)/iu;
const DOCUMENT_PAIR_EXCLUSION =
  /\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]{0,160}\b(?:latex|tex|pdf)\b|\b(?:latex|tex|pdf)(?:\s+(?:source|file|document))?\s+only\b|\bonly\s+(?:the\s+)?(?:latex|tex|pdf)\b|(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]{0,100}(?:latex|tex|pdf)/iu;
const CHINESE_DOCUMENT_ACTION = /^(?:请|請|请你|請你|请帮我|請幫我|帮我|幫我)?(?:创建|建立|生成|撰写|撰寫|重写|重寫|修改|修订|修訂|更新|重新生成|重新编译|重新編譯|编译|編譯|导出|導出|准备|準備|制作|製作|交付|排版)/u;

function quotedContextRemoved(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/```\s*([^\s`\r\n]*)[^\r\n]*\r?\n?[\s\S]*?```/gu, (_match, language) =>
      /^(?:latex|tex)$/iu.test(String(language || "")) ? " tex-source " : " "
    )
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/^\s*(?:context|quoted\s+(?:request|prompt|instruction)|previous\s+(?:request|prompt|instruction)|message\s*\d*)\s*:\s*.*$/gimu, " ")
    .replace(/[“”]([^“”\r\n]*)[“”]/gu, " . ")
    .replace(/"([^"\r\n]*)"/gu, " . ")
    .replace(/[‘’]([^‘’\r\n]*)[‘’]/gu, " . ");
}

function affirmativeDocumentText(value = "") {
  return quotedContextRemoved(value)
    .replace(/\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]*/giu, " ")
    .replace(/(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]*/gu, " ")
    .toLowerCase();
}

function imperativeClause(value = "") {
  let text = String(value || "").trim();
  text = text.replace(/^(?:please|kindly)\s+/iu, "");
  text = text.replace(/^(?:now\s+|continue\s+(?:(?:and|to)\s+)?|go\s+ahead\s+(?:(?:and|to)\s+)?)/iu, "");
  text = text.replace(/^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)\s+)?/iu, "");
  text = text.replace(/^i(?:'d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu, "");
  text = text.replace(/^let(?:'s|\s+us)\s+/iu, "");
  return text;
}

function requestsDocumentCreation(value = "") {
  const clauses = String(value || "")
    .split(/[.!?。！？;；\r\n]+/u)
    .map((item) => imperativeClause(item))
    .filter(Boolean);
  return clauses.some((clause) =>
    DOCUMENT_ACTION.test(clause) ||
    (DOCUMENT_NEED_ACTION.test(clause) && DOCUMENT_NEED_DELIVERABLE.test(clause)) ||
    CHINESE_DOCUMENT_ACTION.test(clause) ||
    /^use\s+(?:latex|tex)\b/iu.test(clause) ||
    /^convert\b[^.!?\r\n]{0,160}\b(?:latex|tex|\.tex)\b[^.!?\r\n]{0,100}\b(?:to|into)\s+(?:a\s+)?pdf\b/iu.test(clause)
  );
}

function requestsTeXAndPdf(value = "") {
  const text = String(value || "");
  const explicitExtensions =
    /\.tex\b[^.!?\r\n]{0,240}\.pdf\b/iu.test(text) ||
    /\.pdf\b[^.!?\r\n]{0,240}\.tex\b/iu.test(text);
  const topicComparison =
    /\b(?:about|compare|comparing|comparison|differences?\s+between|explain|explaining)\b[^.!?\r\n]{0,180}\b(?:latex|tex)\b[^.!?\r\n]{0,100}\bpdf\b/iu.test(text) ||
    /\b(?:about|compare|comparing|comparison|differences?\s+between|explain|explaining)\b[^.!?\r\n]{0,180}\bpdf\b[^.!?\r\n]{0,100}\b(?:latex|tex)\b/iu.test(text) ||
    /\b(?:explanation|discussion|comparison|overview|tutorial|support|workflow|syntax|notation|differences?)\b[^.!?\r\n]{0,180}\b(?:latex|tex)\b[^.!?\r\n]{0,100}\bpdf\b/iu.test(text) ||
    /\b(?:explanation|discussion|comparison|overview|tutorial|support|workflow|syntax|notation|differences?)\b[^.!?\r\n]{0,180}\bpdf\b[^.!?\r\n]{0,100}\b(?:latex|tex)\b/iu.test(text) ||
    /\b(?:latex|tex)\b[^.!?\r\n]{0,100}\bpdf\b[^.!?\r\n]{0,120}\b(?:explain(?:ed|ing)?|compar(?:e|ed|ing)|discuss(?:ed|ing)?|support|workflow|syntax|notation|differences?)\b/iu.test(text) ||
    /\bpdf\b[^.!?\r\n]{0,100}\b(?:latex|tex)\b[^.!?\r\n]{0,120}\b(?:explain(?:ed|ing)?|compar(?:e|ed|ing)|discuss(?:ed|ing)?|support|workflow|syntax|notation|differences?)\b/iu.test(text);
  const artifactFraming =
    /\b(?:both|source|file|document|report|paper|manuscript|artifact|output|version|format|deliverable|compiled)\b/iu.test(text) ||
    /源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|输出|輸出|格式|编译后|編譯後/u.test(text);
  const coordinatedMention =
    /\b(?:both\s+)?(?:latex|tex)(?:\s+(?:source|file|document|format))?\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as|with)\b[^.!?\r\n]{0,100}\b(?:compiled\s+)?pdf\b/iu.test(text) ||
    /\bpdf\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as)\b[^.!?\r\n]{0,100}\b(?:latex|tex)\s+(?:source|file|document|format)\b/iu.test(text);
  const coordinatedFormats = coordinatedMention && artifactFraming && !topicComparison;
  const latexPdfProduction =
    /\b(?:compile|typeset|render|export|build|convert)\b[^.!?\r\n]{0,180}\b(?:latex|tex|\.tex)\b[^.!?\r\n]{0,120}\b(?:to|into|as)\b[^.!?\r\n]{0,60}\bpdf\b/iu.test(text) ||
    /\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,160}\bpdf\b[^.!?\r\n]{0,100}\b(?:using|with|from)\b[^.!?\r\n]{0,60}\b(?:latex|tex)\b/iu.test(text) ||
    /\buse\s+(?:latex|tex)\b[^.!?\r\n]{0,120}\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,80}\bpdf\b/iu.test(text) ||
    /\b(?:latex|tex)\b[^.!?\r\n]{0,160}\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,100}\bpdf\b/iu.test(text);
  const sequentialProduction =
    /\b(?:write|create|generate|prepare|produce|save)\b[^.!?\r\n]{0,160}(?:\.tex\b|\b(?:latex|tex)\b)[\s\S]{0,220}\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,120}\b(?:pdf|\.pdf)\b/iu.test(text);
  const fencedSourceProduction =
    /\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,140}\bpdf\b[\s\S]{0,260}\btex-source\b/iu.test(text);
  const chineseFormats =
    /(?:latex|tex|\.tex)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同)[^。！？\r\n]{0,100}(?:pdf|\.pdf)/iu.test(text) ||
    /(?:pdf|\.pdf)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同)[^。！？\r\n]{0,100}(?:latex|tex|\.tex)/iu.test(text) ||
    /(?:使用|用)[^。！？\r\n]{0,40}(?:latex|tex)[^。！？\r\n]{0,100}(?:生成|编译|編譯|导出|導出|制作|製作)[^。！？\r\n]{0,60}(?:pdf|\.pdf)/iu.test(text);
  return explicitExtensions || coordinatedFormats || latexPdfProduction || sequentialProduction || fencedSourceProduction || chineseFormats;
}

function requestsDocumentFollowup(value = "") {
  const unquoted = quotedContextRemoved(value);
  if (DOCUMENT_PAIR_EXCLUSION.test(unquoted)) return false;
  const clauses = affirmativeDocumentText(unquoted)
    .split(/[.!?。！？;；\r\n]+/u)
    .map((item) => imperativeClause(item))
    .filter(Boolean);
  return clauses.some((clause) => {
    const action =
      DOCUMENT_ACTION.test(clause) ||
      DOCUMENT_NEED_ACTION.test(clause) ||
      CHINESE_DOCUMENT_ACTION.test(clause);
    const implicitRecompile = /^(?:recompile|regenerate|typeset|render|export)\b/iu.test(clause) ||
      /^(?:重新生成|重新编译|重新編譯|编译|編譯|导出|導出)/u.test(clause);
    return action && (implicitRecompile || DOCUMENT_FOLLOWUP_REFERENCE.test(clause));
  });
}

function explicitDocumentArtifactIntent(prompt = "") {
  const unquoted = quotedContextRemoved(prompt);
  if (DOCUMENT_PAIR_EXCLUSION.test(unquoted)) return false;
  const affirmative = affirmativeDocumentText(unquoted);
  return requestsDocumentCreation(affirmative) && requestsTeXAndPdf(affirmative);
}

function activeDocumentConversation(conversation = []) {
  if (!Array.isArray(conversation)) return false;
  let active = false;
  for (const message of conversation) {
    if (!message || message.role !== "user" || typeof message.content !== "string") continue;
    if (explicitDocumentArtifactIntent(message.content)) active = true;
    else if (!(active && requestsDocumentFollowup(message.content))) active = false;
  }
  return active;
}

export function classifyIntegrationDocumentArtifactIntent(prompt = "", conversation = []) {
  const required =
    explicitDocumentArtifactIntent(prompt) ||
    (activeDocumentConversation(conversation) && requestsDocumentFollowup(prompt));
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION,
    required,
    kind: required ? "tex-pdf" : "none",
    requiredFormats: Object.freeze(required ? ["tex", "pdf"] : []),
  });
}

function artifactFilename(value = {}) {
  const candidate = value?.filename ?? value?.fileName ?? value?.name ?? value?.spec?.filename ?? value?.spec?.fileName;
  if (typeof candidate !== "string" || candidate.includes("\0") || Buffer.byteLength(candidate, "utf8") > 500) {
    return "";
  }
  return path.basename(candidate.trim());
}

function artifactBytes(value = {}) {
  const privateFile = inspectPrivateIntegrationFileArtifact(value);
  return privateFile?.bytes || null;
}

function validatePdfStructure(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
  if (!bytes || bytes.length < 64 || bytes.length > MAX_INTEGRATION_FILE_ARTIFACT_BYTES) {
    return Object.freeze({ valid: false, reason: "size-out-of-bounds" });
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 1024)).toString("latin1");
  const headerOffset = head.indexOf("%PDF-");
  if (
    headerOffset < 0 ||
    !/^%PDF-(?:1\.[0-9]|2\.0)(?:[\t \r\n]|$)/u.test(head.slice(headerOffset, headerOffset + 16))
  ) {
    return Object.freeze({ valid: false, reason: "invalid-header" });
  }
  const tailStart = Math.max(0, bytes.length - 16 * 1024);
  const tail = bytes.subarray(tailStart).toString("latin1");
  const eofOffset = tail.lastIndexOf("%%EOF");
  if (eofOffset < 0 || /[^\0\t\n\f\r ]/u.test(tail.slice(eofOffset + 5))) {
    return Object.freeze({ valid: false, reason: "invalid-eof" });
  }
  const startXrefMatches = [...tail.slice(0, eofOffset).matchAll(/startxref\s+(\d+)/giu)];
  const xrefOffset = Number(startXrefMatches.at(-1)?.[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= bytes.length) {
    return Object.freeze({ valid: false, reason: "invalid-startxref" });
  }
  const xrefProbe = bytes
    .subarray(xrefOffset, Math.min(bytes.length, xrefOffset + 2 * 1024 * 1024))
    .toString("latin1")
    .trimStart();
  const tableXref = /^xref\s+\d+\s+\d+\b/u.test(xrefProbe);
  const streamXref = /^\d+\s+\d+\s+obj\b/u.test(xrefProbe);
  if (!tableXref && !streamXref) {
    return Object.freeze({ valid: false, reason: "invalid-xref-target" });
  }
  if (bytes.lastIndexOf("endobj", xrefOffset) < headerOffset) {
    return Object.freeze({ valid: false, reason: "missing-indirect-object" });
  }
  if (tableXref) {
    const trailerOffset = xrefProbe.lastIndexOf("trailer");
    const trailer = trailerOffset >= 0 ? xrefProbe.slice(trailerOffset) : "";
    if (
      !/^trailer\s*<</u.test(trailer) ||
      !/\/Size\s+\d+\b/u.test(trailer) ||
      !/\/Root\s+\d+\s+\d+\s+R\b/u.test(trailer)
    ) {
      return Object.freeze({ valid: false, reason: "invalid-trailer" });
    }
  } else {
    const dictionaryEnd = xrefProbe.indexOf("stream");
    const dictionary = dictionaryEnd >= 0 ? xrefProbe.slice(0, dictionaryEnd) : "";
    if (
      !/\/Type\s*\/XRef\b/u.test(dictionary) ||
      !/\/Size\s+\d+\b/u.test(dictionary) ||
      !/\/Root\s+\d+\s+\d+\s+R\b/u.test(dictionary) ||
      !/\/W\s*\[[^\]]+\]/u.test(dictionary)
    ) {
      return Object.freeze({ valid: false, reason: "invalid-xref-stream" });
    }
  }
  return Object.freeze({ valid: true, reason: "valid-structure" });
}

export async function validateIntegrationPdfBytes(value) {
  const structure = validatePdfStructure(value);
  if (!structure.valid) return structure;
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let temporaryRoot = "";
  try {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-pdf-check-"));
    const temporaryFile = path.join(temporaryRoot, "artifact.pdf");
    await fs.writeFile(temporaryFile, bytes, { flag: "wx", mode: 0o600 });
    await execFileAsync(QPDF_EXECUTABLE, ["--check", temporaryFile], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: {
        LANG: "C",
        LC_ALL: "C",
      },
    });
    return Object.freeze({ valid: true, reason: "qpdf-clean" });
  } catch (error) {
    return Object.freeze({
      valid: false,
      reason: error?.code === "ENOENT" ? "validator-unavailable" : "qpdf-rejected",
    });
  } finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function evaluateIntegrationDocumentArtifactCompletion(intent = {}, artifacts = []) {
  if (intent?.required !== true) {
    return Object.freeze({
      ok: true,
      checked: false,
      missingFormats: Object.freeze([]),
      invalidPdfCount: 0,
      reason: "No TeX/PDF document deliverable was requested.",
    });
  }
  const candidates = Array.isArray(artifacts) ? artifacts : [];
  let invalidPdfCount = 0;
  const receipts = new Map();
  for (const artifact of candidates) {
    const filename = artifactFilename(artifact);
    const bytes = artifactBytes(artifact);
    const privateFile = inspectPrivateIntegrationFileArtifact(artifact);
    if (!filename || !bytes) continue;
    let receipt = null;
    let contentMatchesReceipt = false;
    if (privateFile?.receipt) {
      try {
        receipt = validateIntegrationTexCompileReceipt(privateFile.receipt);
        const expectedSha256 = privateFile.role === "source" ? receipt.sourceSha256 : receipt.pdfSha256;
        const expectedBytes = privateFile.role === "source" ? receipt.sourceBytes : receipt.pdfBytes;
        contentMatchesReceipt =
          new Set(["source", "pdf"]).has(privateFile.role) &&
          bytes.byteLength === expectedBytes &&
          crypto.createHash("sha256").update(bytes).digest("hex") === expectedSha256;
      } catch {}
    }
    if (
      receipt &&
      contentMatchesReceipt &&
      privateFile.role === "source" &&
      /\.tex$/iu.test(filename) &&
      /\S/u.test(bytes.toString("utf8"))
    ) {
      const roles = receipts.get(receipt.digest) || new Set();
      roles.add("source");
      receipts.set(receipt.digest, roles);
    }
    if (/\.pdf$/iu.test(filename)) {
      if (receipt && contentMatchesReceipt && privateFile.role === "pdf") {
        // An issued receipt exists only after qpdf succeeds inside the bounded,
        // networkless compiler. Rechecking outside that sandbox would weaken the boundary.
        const roles = receipts.get(receipt.digest) || new Set();
        roles.add("pdf");
        receipts.set(receipt.digest, roles);
      } else {
        invalidPdfCount += 1;
      }
    }
  }
  const related = [...receipts.values()].some((roles) => roles.has("source") && roles.has("pdf"));
  const missingFormats = [];
  if (!related) missingFormats.push("tex", "pdf");
  const ok = missingFormats.length === 0;
  return Object.freeze({
    ok,
    checked: true,
    missingFormats: Object.freeze(missingFormats),
    invalidPdfCount,
    reason: ok
      ? "A server-sealed TeX source and qpdf-valid PDF share one compile receipt."
      : missingFormats.length === 2
        ? "The requested TeX source and structurally valid PDF artifacts were not both produced."
        : missingFormats[0] === "tex"
          ? "The requested TeX source artifact (.tex) was not produced."
          : invalidPdfCount > 0
            ? "The requested PDF artifact did not have a valid bounded compile proof."
            : "The requested PDF artifact was not produced.",
  });
}
