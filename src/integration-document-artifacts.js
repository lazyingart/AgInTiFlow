import path from "node:path";
import {
  INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
  inspectIntegrationDocumentWorkerCommittedFileArtifact,
  inspectIntegrationDocumentWorkerFileArtifact,
  validateIntegrationDocumentWorkerReceipt,
} from "./integration-document-worker-client.js";

export const INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION = "aginti-integration-document-artifacts-v1";

const DOCUMENT_ACTION =
  /^(?:make|create|generate|write|rewrite|revise|update|edit|modify|correct|fix|regenerate|recompile|produce|prepare|compile|typeset|render|export|build|deliver|provide|save)\b/iu;
const DOCUMENT_FOLLOWUP_MUTATION_ACTION = /^(?:add|include|change|remove|replace)\b/iu;
const DOCUMENT_STRONG_REVISION_ACTION =
  /^(?:rewrite|revise|edit|modify|correct|fix|compile|typeset|render|export)\b/iu;
const DOCUMENT_MUTATION_TARGET =
  /\b(?:latex|tex|pdf|source|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|\b(?:this|that|same|existing|previous|current|the|its)\s+(?:files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?)\b|(?:源文件|源码|源碼|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用|参考文献|參考文獻|摘要|附录|附錄)/iu;
const DOCUMENT_STRONG_REVISION_REFERENCE =
  /\bit\b|\b(?:this|that|same|existing|previous|current|the|its)\s+(?:latex|tex|pdf|source|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|\b(?:latex|tex|pdf|source|documents?|reports?|papers?|manuscripts?|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|(?:它|这个|這個|同一|源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用|参考文献|參考文獻|摘要|附录|附錄)/iu;
const DOCUMENT_NEED_ACTION = /^(?:(?:i|we)\s+)?(?:need|want|require|would\s+like)\b/iu;
const DOCUMENT_NEED_DELIVERABLE =
  /(?:\.tex\b|\.pdf\b|\b(?:source(?:\s+files?)?|compiled\s+pdf|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|versions?|formats?)\b)/iu;
const DOCUMENT_PAIR_EXCLUSION =
  /\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]{0,160}\b(?:latex|tex|pdf)\b|\b(?:latex|tex|pdf)(?:\s+(?:source|file|document))?\s+only\b|\bonly\s+(?:the\s+)?(?:latex|tex|pdf)\b|(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]{0,100}(?:latex|tex|pdf)/iu;
const DOCUMENT_FIGURE =
  /\b(?:figures?|plots?|charts?|diagrams?|illustrations?|graphs?|tikz|pgfplots)\b|(?:图|圖|插图|插圖|绘图|繪圖|图表|圖表|示意图|示意圖|曲线|曲線)/iu;
const DOCUMENT_FIGURE_EXCLUSION =
  /\b(?:do\s+not|don't|dont|never|avoid|without|remove|omit|exclude|no)\b[^.!?;\r\n]{0,100}\b(?:figures?|plots?|charts?|diagrams?|illustrations?|graphs?|tikz|pgfplots)\b|(?:不要|不用|无需|無需|不需要|删除|刪除|移除|省略|避免)[^。！？；\r\n]{0,80}(?:图|圖|插图|插圖|绘图|繪圖|图表|圖表|示意图|示意圖|曲线|曲線)/iu;
const CHINESE_DOCUMENT_ACTION = /^(?:请|請|请你|請你|请帮我|請幫我|帮我|幫我)?(?:创建|建立|生成|撰写|撰寫|重写|重寫|修改|修订|修訂|更新|重新生成|重新编译|重新編譯|编译|編譯|导出|導出|准备|準備|制作|製作|交付|排版)/u;
const DOCUMENT_NEW_INSTANCE =
  /^(?:make|create|generate|write|rewrite|produce|prepare|build|deliver|provide|save|regenerate|compile|recompile|typeset|render|export)\b[^.!?;\r\n]{0,120}\b(?:new|another|separate|fresh|second|different|independent|additional)\b[^.!?;\r\n]{0,120}\b(?:latex|tex|pdf|file|document|report|paper|manuscript)\b|^(?:make|create|generate|write|rewrite|produce|prepare|build|regenerate|compile|recompile|typeset|render|export)\b[^.!?;\r\n]{0,160}\bfrom\s+scratch\b|^(?:新建|另建|另外创建|另外建立|创建另一个|建立另一个|创建一份新的|建立一份新的|创建第二份|建立第二份)[^。！？；\r\n]{0,120}(?:latex|tex|pdf|文件|文档|文檔|报告|報告|论文|論文)/iu;
const DOCUMENT_INITIAL_CREATION_ACTION =
  /^(?:make|create|generate|write|produce|prepare|build|deliver|provide|save|compile|typeset|render|export)\b|^(?:请|請|请你|請你|请帮我|請幫我|帮我|幫我)?(?:创建|建立|生成|撰写|撰寫|准备|準備|制作|製作|交付)/iu;
const DOCUMENT_EXPLICIT_REVISION_ACTION =
  /^(?:rewrite|revise|update|edit|modify|correct|fix|regenerate|recompile|add|include|change|remove|replace)\b|^(?:请|請|请你|請你|请帮我|請幫我|帮我|幫我)?(?:重写|重寫|修改|修订|修訂|更新|重新生成|重新编译|重新編譯|排版)/iu;
const DOCUMENT_PRIOR_INSTANCE_REFERENCE =
  /\b(?:same|existing|previous|prior|earlier|original|revised|updated|again)\b|(?:同一|现有|現有|之前|此前|原有|原来的|原來的|再次|重新)/iu;

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
    if (/^(?:recompile|regenerate)\b/iu.test(clause) || /^(?:重新生成|重新编译|重新編譯)/u.test(clause)) {
      return true;
    }
    if (DOCUMENT_STRONG_REVISION_ACTION.test(clause)) {
      return DOCUMENT_STRONG_REVISION_REFERENCE.test(clause);
    }
    if (
      DOCUMENT_FOLLOWUP_MUTATION_ACTION.test(clause) ||
      /^(?:update|make)\b/iu.test(clause) ||
      DOCUMENT_NEED_ACTION.test(clause)
    ) {
      return DOCUMENT_MUTATION_TARGET.test(clause);
    }
    return CHINESE_DOCUMENT_ACTION.test(clause) && DOCUMENT_STRONG_REVISION_REFERENCE.test(clause);
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
    const text = quotedContextRemoved(message.content);
    if (DOCUMENT_PAIR_EXCLUSION.test(text)) active = false;
    else if (explicitDocumentArtifactIntent(message.content)) active = true;
  }
  return active;
}

function minimumFigureCount(prompt = "", conversation = []) {
  const current = quotedContextRemoved(prompt);
  if (DOCUMENT_FIGURE_EXCLUSION.test(current)) return 0;
  if (DOCUMENT_FIGURE.test(affirmativeDocumentText(current))) return 1;
  if (!Array.isArray(conversation)) return 0;
  let required = false;
  for (const message of conversation) {
    if (!message || message.role !== "user" || typeof message.content !== "string") continue;
    const text = quotedContextRemoved(message.content);
    if (DOCUMENT_FIGURE_EXCLUSION.test(text)) required = false;
    else if (DOCUMENT_FIGURE.test(affirmativeDocumentText(text))) required = true;
  }
  return required ? 1 : 0;
}

export function classifyIntegrationDocumentArtifactIntent(prompt = "", conversation = [], activeDocument = false) {
  const active = activeDocument === true || activeDocumentConversation(conversation);
  const required =
    explicitDocumentArtifactIntent(prompt) ||
    (active && requestsDocumentFollowup(prompt));
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION,
    required,
    kind: required ? "tex-pdf" : "none",
    requiredFormats: Object.freeze(required ? ["tex", "pdf"] : []),
    requirements: Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
      profile: "self-contained-tex-v1",
      minimumFigureCount: required ? minimumFigureCount(prompt, conversation) : 0,
    }),
  });
}

export function isIntegrationDocumentArtifactRevision(prompt = "", conversation = [], activeDocument = false) {
  const current = imperativeClause(affirmativeDocumentText(quotedContextRemoved(prompt)));
  const explicitInitialCreation =
    DOCUMENT_INITIAL_CREATION_ACTION.test(current) &&
    explicitDocumentArtifactIntent(prompt) &&
    !DOCUMENT_PRIOR_INSTANCE_REFERENCE.test(current);
  return (
    requestsDocumentFollowup(prompt) &&
    !DOCUMENT_NEW_INSTANCE.test(current) &&
    !explicitInitialCreation &&
    (
      activeDocument === true ||
      activeDocumentConversation(conversation) ||
      DOCUMENT_EXPLICIT_REVISION_ACTION.test(current) ||
      DOCUMENT_PRIOR_INSTANCE_REFERENCE.test(current)
    )
  );
}

function artifactFilename(value = {}) {
  const candidate = value?.filename ?? value?.fileName ?? value?.name ?? value?.spec?.filename ?? value?.spec?.fileName;
  if (typeof candidate !== "string" || candidate.includes("\0") || Buffer.byteLength(candidate, "utf8") > 500) {
    return "";
  }
  return path.basename(candidate.trim());
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
    const privateFile = inspectIntegrationDocumentWorkerFileArtifact(artifact);
    const committed = inspectIntegrationDocumentWorkerCommittedFileArtifact(artifact);
    if (!filename || !privateFile || !committed) continue;
    let receipt = null;
    let contentMatchesReceipt = false;
    if (privateFile?.receipt) {
      try {
        receipt = validateIntegrationDocumentWorkerReceipt(privateFile.receipt);
        const expectedSha256 = privateFile.role === "source" ? receipt.sourceSha256 : receipt.pdfSha256;
        const expectedBytes = privateFile.role === "source" ? receipt.sourceBytes : receipt.pdfBytes;
        contentMatchesReceipt =
          new Set(["source", "pdf"]).has(privateFile.role) &&
          artifact?.spec?.bytes === expectedBytes &&
          artifact?.spec?.sha256 === expectedSha256 &&
          receipt.verifiedFigureCount >= (intent?.requirements?.minimumFigureCount || 0);
      } catch {}
    }
    if (
      receipt &&
      committed.receiptDigest === receipt.digest &&
      contentMatchesReceipt &&
      privateFile.role === "source" &&
      /\.tex$/iu.test(filename)
    ) {
      const key = `${receipt.digest}:${committed.digest}`;
      const roles = receipts.get(key) || new Set();
      roles.add("source");
      receipts.set(key, roles);
    }
    if (/\.pdf$/iu.test(filename)) {
      if (
        receipt &&
        committed.receiptDigest === receipt.digest &&
        contentMatchesReceipt &&
        privateFile.role === "pdf"
      ) {
        // The authenticated workstation worker issues this receipt only after
        // its networkless compiler and qpdf validation succeed.
        const key = `${receipt.digest}:${committed.digest}`;
        const roles = receipts.get(key) || new Set();
        roles.add("pdf");
        receipts.set(key, roles);
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
      ? "A committed worker-sealed TeX source and qpdf-valid PDF share one bound receipt and commit acknowledgement."
      : missingFormats.length === 2
        ? "The requested TeX source and structurally valid PDF artifacts were not both produced."
        : missingFormats[0] === "tex"
          ? "The requested TeX source artifact (.tex) was not produced."
          : invalidPdfCount > 0
            ? "The requested PDF artifact did not have a valid bounded compile proof."
            : "The requested PDF artifact was not produced.",
  });
}
