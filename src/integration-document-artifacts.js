import path from "node:path";
import {
  INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
  inspectIntegrationDocumentWorkerCommittedFileArtifact,
  inspectIntegrationDocumentWorkerFileArtifact,
  validateIntegrationDocumentWorkerReceipt,
} from "./integration-document-worker-client.js";

export const INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION = "aginti-integration-document-artifacts-v1";

const DOCUMENT_ACTION =
  /^(?:make|create|generate|write|rewrite|revise|update|edit|modify|correct|fix|regenerate|recompile|produce|prepare|compile|typeset|render|export|build|deliver|provide|send|give|return|output|share|save)\b/iu;
const DOCUMENT_FOLLOWUP_MUTATION_ACTION = /^(?:add|include|change|remove|replace)\b/iu;
const DOCUMENT_STRONG_REVISION_ACTION =
  /^(?:rewrite|revise|edit|modify|correct|fix|compile|typeset|render|export)\b/iu;
const DOCUMENT_MUTATION_TARGET =
  /\b(?:latex|tex|pdf|source|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices|details?|content|length)\b|\b(?:better|longer|shorter|clearer|stronger|simpler|cleaner|more\s+detailed)\b|\b(?:this|that|same|existing|previous|current|the|its)\s+(?:files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?)\b|(?:它|这个|這個|源文件|源码|源碼|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用|参考文献|參考文獻|摘要|附录|附錄|细节|細節|内容|內容)/iu;
const DOCUMENT_BARE_IT_REFERENCE = /\bit\b/iu;
const DOCUMENT_EXPLICIT_MUTATION_TARGET =
  /(?:\.tex\b|\.pdf\b|\b(?:latex|tex|pdf|source|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|\b(?:this|that|same|existing|previous|prior|current|the|its)\s+(?:files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?)\b|(?:源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用|参考文献|參考文獻|摘要|附录|附錄))/iu;
const DOCUMENT_STRONG_REVISION_REFERENCE =
  /\bit\b|\b(?:this|that|same|existing|previous|current|the|its)\s+(?:latex|tex|pdf|source|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|\b(?:latex|tex|pdf|source|documents?|reports?|papers?|manuscripts?|title|heading|section|paragraph|wording|grammar|layout|formatting|fonts?|margins?|tables?|figures?|citations?|references?|bibliography|abstract|captions?|appendix|appendices)\b|(?:它|这个|這個|同一|源文件|源码|源碼|文件|文档|文檔|报告|報告|论文|論文|标题|標題|段落|排版|格式|字体|字體|页边距|頁邊距|表格|图片|圖片|引用|参考文献|參考文獻|摘要|附录|附錄)/iu;
const DOCUMENT_NEED_ACTION = /^(?:(?:i|we)\s+)?(?:need|want|require|would\s+like)\b/iu;
const CHINESE_DOCUMENT_NEED_ACTION = /^(?:(?:我|我们|我們)\s*)?(?:需要|想要|要)(?:\s|$)/u;
const DOCUMENT_NEED_DELIVERABLE =
  /(?:\.tex\b|\.pdf\b|\b(?:source(?:\s+files?)?|compiled\s+pdf|files?|documents?|reports?|papers?|manuscripts?|artifacts?|outputs?|deliverables?|versions?|formats?)\b|(?:源文件|源檔案|源檔|文件|文档|文檔|报告|報告|论文|論文|输出|輸出|格式|版本|编译后|編譯後))/iu;
const DOCUMENT_PAIR_EXCLUSION =
  /\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]{0,160}\b(?:latex|tex|pdf)\b|\b(?:latex|tex|pdf)(?:\s+(?:source|file|document))?\s+only\b|\bonly\s+(?:the\s+)?(?:latex|tex|pdf)\b|(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]{0,100}(?:latex|tex|pdf)/iu;
const DOCUMENT_CREATION_EXCLUSION =
  /\b(?:do\s+not|don't|dont|never|avoid)\b[^.!?;\r\n]{0,160}\b(?:make|create|generate|write|compile|typeset|render|export|build|deliver|provide|send|give|return|output|share|save|download|files?|artifacts?|outputs?|deliverables?)\b|\bwithout\b[^.!?;\r\n]{0,100}\b(?:making|creating|generating|writing|compiling|rendering|exporting|saving|downloading|files?|artifacts?)\b|\bneither\b[^.!?;\r\n]{0,160}\b(?:latex|tex)\b[^.!?;\r\n]{0,160}\b(?:nor|or|and)\b[^.!?;\r\n]{0,100}\bpdf\b|\b(?:just|only)\s+(?:explain|describe|discuss|compare|review)\b|(?:不要|不用|无需|無需|不需要|禁止|避免)[^。！？；\r\n]{0,120}(?:创建|建立|生成|撰写|撰寫|编译|編譯|导出|導出|制作|製作|文件|文档|文檔|输出|輸出)/iu;
const DOCUMENT_ADDITIONAL_ARTIFACT_GUARD =
  /\b(?:do\s+not|don't|dont|never|avoid)\s+(?:make|create|generate|produce|return|output|add|include)\s+(?:(?:any|an)\s+)?(?:other|another|additional|extra)\s+(?:files?|artifacts?|outputs?|deliverables?)\b|\b(?:do\s+not|don't|dont|never|avoid)\s+(?:(?:merely|just)\s+)?(?:paste|show|display|include)\s+(?:the\s+)?(?:files?|file\s+contents?|source(?:\s+contents?)?)\s+(?:in|into|as)\s+(?:the\s+)?(?:chat|answer|response)\b/giu;
const DOCUMENT_FORMAT_INTEGRITY_GUARD =
  /\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]{0,160}\b(?:fake|faked|faking|mock|mocked|mocking|simulate|simulated|simulating|pretend|pretended|pretending|placeholder|dummy|stub|base64(?:[-\s]?encode|[-\s]?encoded|[-\s]?encoding)?|base64[-\s]?only)\b[^.!?;\r\n]{0,120}\b(?:latex|tex|pdf|\.tex|\.pdf|files?|artifacts?|outputs?|deliverables?)\b|\b(?:do\s+not|don't|dont|never|avoid|without|no\s+need\s+to|not\s+asked\s+to)\b[^.!?;\r\n]{0,160}\b(?:latex|tex|pdf|\.tex|\.pdf|files?|artifacts?|outputs?|deliverables?)\b[^.!?;\r\n]{0,120}\b(?:fake|faked|faking|mock|mocked|mocking|simulate|simulated|simulating|pretend|pretended|pretending|placeholder|dummy|stub|base64(?:[-\s]?encode|[-\s]?encoded|[-\s]?encoding)?|base64[-\s]?only)\b|\bno\s+(?:fake|faked|mock|mocked|simulated|placeholder|dummy|stub|base64(?:[-\s]?encoded)?|base64[-\s]?only)\s+(?:latex|tex|pdf|\.tex|\.pdf|files?|artifacts?|outputs?|deliverables?)\b/giu;
const DOCUMENT_EXACT_SOURCE_DIRECTIVE =
  /\b(?:source|contents?|text|block|bytes?)\b[^.!?;\r\n]{0,120}\b(?:exact(?:ly)?|verbatim|unchanged|unmodified|byte[- ]for[- ]byte|as[- ]is)\b|\b(?:exact(?:ly)?|verbatim|unchanged|unmodified|byte[- ]for[- ]byte|as[- ]is)\b[^.!?;\r\n]{0,120}\b(?:source|contents?|text|block|bytes?)\b|\bincluding\s+(?:its|the)\s+final\s+newline\b/iu;
const DOCUMENT_DISCUSSION_TARGET =
  /^(?:make|create|generate|write|produce|prepare|provide|give|return|output|share|deliver)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:tutorial|explanation|advice|comparison|overview|discussion|review|article|essay|prose|example|guide)\b|^(?:make|create|generate|write|produce|prepare)\s+(?:something\s+)?(?:about|on)\b|^(?:make|create|generate|write|produce|prepare|provide)\b[^.!?;\r\n]{0,120}\b(?:latex|tex)\s+source[- ]code\s+example\b/iu;
const DOCUMENT_FIGURE =
  /\b(?:figures?|plots?|charts?|diagrams?|illustrations?|graphs?|tikz|pgfplots)\b|(?:图|圖|插图|插圖|绘图|繪圖|图表|圖表|示意图|示意圖|曲线|曲線)/iu;
const DOCUMENT_FIGURE_EXCLUSION =
  /\b(?:(?:do\s+not|don't|dont|never)\s+(?:include|add|create|draw|show|use|keep|retain|have|want)\b[^.!?;\r\n]{0,80}|avoid\b[^.!?;\r\n]{0,80}|without\s+(?:any\s+)?|(?:remove|omit|exclude|delete)\b[^.!?;\r\n]{0,80}|(?:no|zero)\s+(?:self-contained\s+)?)(?:figures?|plots?|charts?|diagrams?|illustrations?|graphs?|tikz|pgfplots)\b|(?:(?:不要|不用|无需|無需|不需要)\s*(?!(?:删除|刪除|移除|省略))(?:包含|添加|使用|绘制|繪製|保留|要)?|删除|刪除|移除|省略|避免)[^。！？；\r\n]{0,60}(?:图|圖|插图|插圖|绘图|繪圖|图表|圖表|示意图|示意圖|曲线|曲線)/iu;
const DOCUMENT_FIGURE_REMOVAL_NEGATION =
  /\b(?:do\s+not|don't|dont|never|no\s+need\s+to|not\s+asked\s+to|avoid)\b[^.!?;\r\n]{0,80}\b(?:remove|omit|exclude|delete)\b[^.!?;\r\n]{0,80}\b(?:figures?|plots?|charts?|diagrams?|illustrations?|graphs?|tikz|pgfplots)\b|(?:不要|不用|无需|無需|不需要|避免)[^。！？；\r\n]{0,40}(?:删除|刪除|移除|省略)[^。！？；\r\n]{0,40}(?:图|圖|插图|插圖|绘图|繪圖|图表|圖表|示意图|示意圖|曲线|曲線)/giu;
const CHINESE_DOCUMENT_ACTION = /^(?:请|請|请你|請你|请帮我|請幫我|帮我|幫我)?(?:创建|建立|生成|撰写|撰寫|重写|重寫|修改|修订|修訂|更新|重新生成|重新编译|重新編譯|编译|編譯|导出|導出|准备|準備|制作|製作|交付|提供|给我|給我|输出|輸出|返回|排版)/u;
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

function documentPairExclusionText(value = "") {
  return String(value || "").replace(DOCUMENT_FORMAT_INTEGRITY_GUARD, " ");
}

function documentCreationExclusionText(value = "") {
  return documentPairExclusionText(value).replace(DOCUMENT_ADDITIONAL_ARTIFACT_GUARD, " ");
}

function imperativeClause(value = "") {
  let text = String(value || "").trim();
  text = text.replace(/^(?:please|kindly)\s+/iu, "");
  text = text.replace(/^(?:now\s+|then\s+|continue\s+(?:(?:and|to)\s+)?|go\s+ahead\s+(?:(?:and|to)\s+)?)/iu, "");
  text = text.replace(/^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)\s+)?/iu, "");
  text = text.replace(/^i(?:'d|\s+would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu, "");
  text = text.replace(/^let(?:'s|\s+us)\s+/iu, "");
  return text;
}

function hasSelfContainedFencedTeXSource(value = "") {
  const fence = /```[ \t]*(?:latex|tex)[^\r\n]*\r?\n([\s\S]*?)```/giu;
  let match;
  while ((match = fence.exec(String(value || ""))) !== null) {
    const source = match[1];
    if (
      /\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/iu.test(source) &&
      /\\begin\s*\{document\}/iu.test(source) &&
      /\\end\s*\{document\}/iu.test(source)
    ) {
      return true;
    }
  }
  return false;
}

export function extractIntegrationExactFencedTeXSource(prompt = "") {
  const text = String(prompt || "");
  if (
    !explicitDocumentArtifactIntent(text) ||
    !DOCUMENT_EXACT_SOURCE_DIRECTIVE.test(quotedContextRemoved(text))
  ) {
    return null;
  }
  const fences = [...text.matchAll(/^[ \t]{0,3}```[ \t]*(?:latex|tex)[^\r\n]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gimu)];
  if (fences.length !== 1) return null;
  const source = fences[0][1];
  if (
    !/\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/iu.test(source) ||
    !/\\begin\s*\{document\}/iu.test(source) ||
    !/\\end\s*\{document\}/iu.test(source)
  ) {
    return null;
  }
  return source;
}

function explicitlyExcludesFigures(value = "") {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(DOCUMENT_FIGURE_REMOVAL_NEGATION, " ");
  return DOCUMENT_FIGURE_EXCLUSION.test(text);
}

function requestsDocumentCreation(value = "") {
  const clauses = String(value || "")
    .split(/(?:[!?。！？;；\r\n]+|\.(?=\s|$))/u)
    .map((item) => imperativeClause(item))
    .filter(Boolean);
  return clauses.some((clause) =>
    DOCUMENT_ACTION.test(clause) ||
    (DOCUMENT_NEED_ACTION.test(clause) && DOCUMENT_NEED_DELIVERABLE.test(clause)) ||
    (CHINESE_DOCUMENT_NEED_ACTION.test(clause) && DOCUMENT_NEED_DELIVERABLE.test(clause)) ||
    CHINESE_DOCUMENT_ACTION.test(clause) ||
    /^use\s+(?:latex|tex)\b/iu.test(clause) ||
    /^convert\b[^.!?\r\n]{0,160}\b(?:latex|tex|\.tex)\b[^.!?\r\n]{0,100}\b(?:to|into)\s+(?:a\s+)?pdf\b/iu.test(clause) ||
    /^convert\b[^.!?\r\n]{0,120}\b(?:to|into)\s+(?:a\s+)?pdf\b[^.!?\r\n]{0,120}\bfrom\s+(?:the\s+)?(?:text|paper|report|document|manuscript)\b/iu.test(clause) ||
    /^convert\b[^.!?\r\n]{0,120}\b(?:text|paper|report|document|manuscript)\b[^.!?\r\n]{0,120}\b(?:to|into)\s+(?:a\s+)?pdf\b/iu.test(clause)
  );
}

function requestsTeXAndPdf(value = "") {
  const text = String(value || "");
  const explicitExtensions =
    /\.tex\b[\s\S]{0,240}\.pdf\b/iu.test(text) ||
    /\.pdf\b[\s\S]{0,240}\.tex\b/iu.test(text);
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
  const pairedDeliverableFormats =
    /\b(?:both\s+)?(?:latex|tex)(?:\s+(?:source|file|document|format|manuscript))?\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as|with)\b[^.!?\r\n]{0,100}\b(?:compiled\s+)?pdf\b[^.!?\r\n]{0,80}\b(?:files?|documents?|versions?|formats?|outputs?|deliverables?)\b/iu.test(text) ||
    /\b(?:both\s+)?pdf\b[^.!?\r\n]{0,100}\b(?:and|plus|along\s+with|together\s+with|as\s+well\s+as|with)\b[^.!?\r\n]{0,100}\b(?:latex|tex)(?:\s+(?:source|file|document|format|manuscript))?\b[^.!?\r\n]{0,80}\b(?:files?|documents?|versions?|formats?|outputs?|deliverables?)\b/iu.test(text);
  const latexPdfProduction =
    /\b(?:compile|typeset|render|export|build|convert)\b[^.!?\r\n]{0,180}\b(?:latex|tex|\.tex)\b[^.!?\r\n]{0,120}\b(?:to|into|as)\b[^.!?\r\n]{0,60}\bpdf\b/iu.test(text) ||
    /\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,160}\bpdf\b[^.!?\r\n]{0,100}\b(?:using|with|from)\b[^.!?\r\n]{0,60}\b(?:latex|tex)\b/iu.test(text) ||
    /\buse\s+(?:latex|tex)\b[^.!?\r\n]{0,120}\b(?:make|create|generate|produce|prepare|render|export)\b[^.!?\r\n]{0,80}\bpdf\b/iu.test(text) ||
    /\b(?:latex|tex)\b[^.!?\r\n]{0,160}\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,100}\bpdf\b/iu.test(text);
  const sequentialProduction =
    /\b(?:write|create|generate|prepare|produce|save)\b[^.!?\r\n]{0,160}(?:\.tex\b|\b(?:latex|tex)\b)[\s\S]{0,220}\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,120}\b(?:pdf|\.pdf)\b/iu.test(text);
  const fencedSourceProduction =
    /\b(?:compile|typeset|render|export|build)\b[^.!?\r\n]{0,140}\bpdf\b[\s\S]{0,260}\btex-source\b/iu.test(text);
  const textualPaperPdfProduction =
    /\b(?:write|create|generate|prepare|produce|draft)\b[^.!?\r\n]{0,180}\b(?:paper|report|manuscript|document)\b[\s\S]{0,280}\b(?:convert|compile|typeset|render|export|build)\b[^.!?\r\n]{0,120}\b(?:to|into|as)?\s*(?:a\s+)?pdf\b/iu.test(text) ||
    /\b(?:convert|compile|typeset|render|export|build)\b[^.!?\r\n]{0,120}\b(?:to|into|as)?\s*(?:a\s+)?pdf\b[^.!?\r\n]{0,120}\bfrom\s+(?:the\s+)?(?:text|paper|report|document|manuscript)\b/iu.test(text);
  const chineseFormats =
    /(?:latex|tex|\.tex)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同)[^。！？\r\n]{0,100}(?:pdf|\.pdf)/iu.test(text) ||
    /(?:pdf|\.pdf)[^。！？\r\n]{0,100}(?:和|及|与|與|以及|连同|連同)[^。！？\r\n]{0,100}(?:latex|tex|\.tex)/iu.test(text) ||
    /(?:使用|用)[^。！？\r\n]{0,40}(?:latex|tex)[^。！？\r\n]{0,100}(?:生成|编译|編譯|导出|導出|制作|製作)[^。！？\r\n]{0,60}(?:pdf|\.pdf)/iu.test(text);
  return explicitExtensions || coordinatedFormats || pairedDeliverableFormats || latexPdfProduction || sequentialProduction || fencedSourceProduction || textualPaperPdfProduction || chineseFormats;
}

function requestsDocumentFollowup(value = "", { allowImplicitReference = true } = {}) {
  const unquoted = quotedContextRemoved(value);
  if (DOCUMENT_PAIR_EXCLUSION.test(documentPairExclusionText(unquoted))) return false;
  const clauses = affirmativeDocumentText(unquoted)
    .split(/[.!?。！？;；\r\n]+/u)
    .map((item) => imperativeClause(item))
    .filter(Boolean);
  return clauses.some((clause) => {
    const explicitTarget = DOCUMENT_EXPLICIT_MUTATION_TARGET.test(clause);
    if (/^(?:recompile|regenerate)\b/iu.test(clause) || /^(?:重新生成|重新编译|重新編譯)/u.test(clause)) {
      return explicitTarget || allowImplicitReference;
    }
    if (DOCUMENT_STRONG_REVISION_ACTION.test(clause)) {
      return DOCUMENT_STRONG_REVISION_REFERENCE.test(clause) && (explicitTarget || allowImplicitReference);
    }
    if (DOCUMENT_FOLLOWUP_MUTATION_ACTION.test(clause)) {
      const target = DOCUMENT_MUTATION_TARGET.test(clause) ||
        (/^change\b/iu.test(clause) && DOCUMENT_BARE_IT_REFERENCE.test(clause));
      return target && (explicitTarget || allowImplicitReference);
    }
    if (/^make\b/iu.test(clause)) {
      const target = explicitTarget || DOCUMENT_BARE_IT_REFERENCE.test(clause);
      return target && (explicitTarget || allowImplicitReference);
    }
    if (/^update\b/iu.test(clause) || DOCUMENT_NEED_ACTION.test(clause)) {
      const target = DOCUMENT_MUTATION_TARGET.test(clause) || DOCUMENT_BARE_IT_REFERENCE.test(clause);
      return target && (explicitTarget || allowImplicitReference);
    }
    return CHINESE_DOCUMENT_ACTION.test(clause) &&
      DOCUMENT_STRONG_REVISION_REFERENCE.test(clause) &&
      (explicitTarget || allowImplicitReference);
  });
}

function explicitDocumentArtifactIntent(prompt = "") {
  const unquoted = quotedContextRemoved(prompt);
  const current = imperativeClause(unquoted);
  const exclusionText = documentCreationExclusionText(unquoted);
  if (DOCUMENT_PAIR_EXCLUSION.test(exclusionText) || DOCUMENT_CREATION_EXCLUSION.test(exclusionText)
      || DOCUMENT_DISCUSSION_TARGET.test(current)) return false;
  const affirmative = affirmativeDocumentText(unquoted);
  return requestsDocumentCreation(affirmative) && requestsTeXAndPdf(affirmative);
}

export function isIntegrationPriorArtifactDocumentConversion(prompt = "") {
  const unquoted = quotedContextRemoved(prompt);
  const exclusionText = documentCreationExclusionText(unquoted);
  if (DOCUMENT_PAIR_EXCLUSION.test(exclusionText) || DOCUMENT_CREATION_EXCLUSION.test(exclusionText)) {
    return false;
  }
  const clauses = affirmativeDocumentText(unquoted)
    .split(/[.!?。！？;；\r\n]+/u)
    .map((item) => imperativeClause(item))
    .filter(Boolean);
  return clauses.some((clause) =>
    /^(?:compile|convert|typeset|render|export|turn)\b[^.!?\r\n]{0,80}\b(?:it|this|that|these|those|the\s+(?:result|results|analysis|calculation|plot|figure|table|text|markdown|content|paper|report|document))\b[^.!?\r\n]{0,100}\b(?:to|into|as)?\s*(?:a\s+)?pdf\b/iu.test(clause) ||
    /^make\b[^.!?\r\n]{0,40}\b(?:it|this|that|the\s+(?:result|analysis|plot|figure|table|text|markdown|content|paper|report|document))\b[^.!?\r\n]{0,80}\b(?:into|as)\s+(?:a\s+)?pdf\b/iu.test(clause) ||
    /^(?:把|将|將)(?:它|这个|這個|上述结果|上述結果|以上结果|以上結果|该结果|該結果|分析|图表|圖表|文本|内容|內容|报告|報告)(?:转换|轉換|编译|編譯|导出|導出|制作|製作)(?:为|為|成)?pdf/u.test(clause)
  );
}

function documentConversationState(conversation = []) {
  if (!Array.isArray(conversation)) return Object.freeze({ active: false, immediate: false });
  let active = false;
  let immediate = false;
  for (const message of conversation) {
    if (!message || message.role !== "user" || typeof message.content !== "string") continue;
    const text = quotedContextRemoved(message.content);
    if (DOCUMENT_PAIR_EXCLUSION.test(documentPairExclusionText(text))) {
      active = false;
      immediate = false;
    } else if (explicitDocumentArtifactIntent(message.content)) {
      active = true;
      immediate = true;
    } else if (active && requestsDocumentFollowup(message.content, { allowImplicitReference: immediate })) {
      immediate = true;
    } else {
      immediate = false;
    }
  }
  return Object.freeze({ active, immediate });
}

function normalizeActiveDocumentContext(value) {
  if (value === true) {
    return Object.freeze({
      active: true,
      allowImplicitReference: true,
      preferPriorArtifacts: false,
      minimumFigureCount: 0,
      explicit: false,
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const minimum = Number.isSafeInteger(value.minimumFigureCount) &&
      value.minimumFigureCount >= 0 && value.minimumFigureCount <= 32
      ? value.minimumFigureCount
      : 0;
    return Object.freeze({
      active: value.active === true,
      allowImplicitReference: value.allowImplicitReference === true,
      preferPriorArtifacts: value.preferPriorArtifacts === true,
      minimumFigureCount: minimum,
      explicit: true,
    });
  }
  return Object.freeze({
    active: false,
    allowImplicitReference: false,
    preferPriorArtifacts: false,
    minimumFigureCount: 0,
    explicit: false,
  });
}

function minimumFigureCount(prompt = "", conversation = [], priorMinimumFigureCount = 0) {
  const current = quotedContextRemoved(prompt);
  if (explicitlyExcludesFigures(current)) return 0;
  let required = false;
  if (Array.isArray(conversation)) {
    for (const message of conversation) {
      if (!message || message.role !== "user" || typeof message.content !== "string") continue;
      const text = quotedContextRemoved(message.content);
      // Figure requests from unrelated analysis turns (for example, a Python
      // plot immediately before a new TeX task) are not document lineage.
      // Only an actual paired TeX/PDF request may contribute public
      // conversation evidence here; committed revision lineage is carried by
      // priorMinimumFigureCount below.
      if (!explicitDocumentArtifactIntent(text)) continue;
      if (explicitlyExcludesFigures(text)) required = false;
      else if (DOCUMENT_FIGURE.test(affirmativeDocumentText(text))) required = true;
    }
  }
  if (DOCUMENT_FIGURE.test(affirmativeDocumentText(current))) required = true;
  return Math.max(required ? 1 : 0, priorMinimumFigureCount);
}

function isExplicitInitialDocumentCreation(prompt = "") {
  const current = imperativeClause(affirmativeDocumentText(quotedContextRemoved(prompt)));
  return (
    DOCUMENT_INITIAL_CREATION_ACTION.test(current) &&
    explicitDocumentArtifactIntent(prompt) &&
    !DOCUMENT_PRIOR_INSTANCE_REFERENCE.test(current)
  );
}

export function classifyIntegrationDocumentArtifactIntent(prompt = "", conversation = [], activeDocument = false) {
  const context = normalizeActiveDocumentContext(activeDocument);
  const conversationState = documentConversationState(conversation);
  const active = context.active || conversationState.active;
  const allowImplicitReference = context.explicit
    ? context.allowImplicitReference
    : context.active || conversationState.immediate || !conversationState.active;
  const priorArtifactConversion =
    context.preferPriorArtifacts && isIntegrationPriorArtifactDocumentConversion(prompt);
  const required =
    explicitDocumentArtifactIntent(prompt) ||
    priorArtifactConversion ||
    (active && requestsDocumentFollowup(prompt, { allowImplicitReference }));
  const explicitInitialCreation = isExplicitInitialDocumentCreation(prompt);
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_ARTIFACT_SCHEMA_VERSION,
    required,
    kind: required ? "tex-pdf" : "none",
    requiredFormats: Object.freeze(required ? ["tex", "pdf"] : []),
    requirements: Object.freeze({
      schemaVersion: INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
      profile: "self-contained-tex-v1",
      minimumFigureCount: required
        ? priorArtifactConversion
          ? Math.max(
              context.minimumFigureCount,
              DOCUMENT_FIGURE.test(affirmativeDocumentText(prompt)) ? 1 : 0
            )
          : minimumFigureCount(
            prompt,
            explicitInitialCreation ? [] : conversation,
            explicitInitialCreation ? 0 : context.minimumFigureCount
          )
        : 0,
    }),
  });
}

export function isIntegrationDocumentArtifactRevision(prompt = "", conversation = [], activeDocument = false) {
  const current = imperativeClause(affirmativeDocumentText(quotedContextRemoved(prompt)));
  if (hasSelfContainedFencedTeXSource(prompt) && explicitDocumentArtifactIntent(prompt)) return false;
  const context = normalizeActiveDocumentContext(activeDocument);
  if (context.preferPriorArtifacts && isIntegrationPriorArtifactDocumentConversion(prompt)) return false;
  const conversationState = documentConversationState(conversation);
  const active = context.active || conversationState.active;
  const allowImplicitReference = context.explicit
    ? context.allowImplicitReference
    : context.active || conversationState.immediate || !conversationState.active;
  const explicitInitialCreation = isExplicitInitialDocumentCreation(prompt);
  return (
    requestsDocumentFollowup(prompt, { allowImplicitReference }) &&
    !DOCUMENT_NEW_INSTANCE.test(current) &&
    !explicitInitialCreation &&
    (
      active ||
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
