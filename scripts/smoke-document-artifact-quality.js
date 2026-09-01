import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectDocumentSourceDocuments,
  currentStateRequested,
  documentArtifactVersioningDefect,
  evaluateCurrentStateText,
  evaluateDocumentConsistency,
  evaluateExtractedDocumentText,
  evaluateLatexSourceStructure,
  evaluatePdfPageBalance,
  evaluatePdfTextBounds,
  evaluateSourceTopicCoverage,
  evaluateUnverifiedSourceCompletionClaims,
  extractSupersededLiterals,
} from "../src/document-artifact-quality.js";
import { evaluateSpreadsheetStructure } from "../src/spreadsheet-artifact-quality.js";

const workbookWithPlaceholder = evaluateSpreadsheetStructure({
  sheets: [
    { name: "Sheet", state: "visible", cellCount: 0, formulaCount: 0 },
    { name: "Raw Inventory", state: "visible", cellCount: 30, formulaCount: 0 },
    { name: "Reorder Plan", state: "visible", cellCount: 20, formulaCount: 8 },
  ],
  chartCount: 1,
  externalLinkCount: 0,
  hasMacros: false,
});
assert.equal(workbookWithPlaceholder.ok, false, "an empty default workbook sheet was accepted");
assert.equal(workbookWithPlaceholder.defects[0]?.code, "unused-default-worksheet");

const emptyWorkbook = evaluateSpreadsheetStructure({
  sheets: [{ name: "Sheet", state: "visible", cellCount: 0, formulaCount: 0 }],
  chartCount: 0,
  externalLinkCount: 0,
  hasMacros: false,
});
assert.equal(emptyWorkbook.ok, false, "a completely empty workbook was accepted");
assert.equal(emptyWorkbook.defects[0]?.code, "workbook-has-no-content");

const purposefulWorkbook = evaluateSpreadsheetStructure({
  sheets: [
    { name: "Raw Inventory", state: "visible", cellCount: 30, formulaCount: 0 },
    { name: "Reorder Plan", state: "visible", cellCount: 20, formulaCount: 8 },
    { name: "Dashboard", state: "visible", cellCount: 12, formulaCount: 3 },
  ],
  chartCount: 1,
  externalLinkCount: 0,
  hasMacros: false,
});
assert.equal(purposefulWorkbook.ok, true, "a workbook with only purposeful sheets was rejected");
assert.equal(purposefulWorkbook.formulaCount, 11);
assert.equal(purposefulWorkbook.chartCount, 1);

const source = [
  "Initial plan: the demonstration date was September 12.",
  "Preliminary total budget was HKD 18,000.",
  "Correction: the demonstration is September 19, 2026, not September 12.",
  "Mei is the integration owner, replacing Ana.",
  "Use Vendor C; Vendor A is no longer selected.",
].join("\n");

assert.deepEqual(
  extractSupersededLiterals(source),
  ["HKD 18,000", "September 12", "Ana", "Vendor A"],
  "explicit corrections did not produce a stable superseded-fact set"
);

const staleDocument = evaluateCurrentStateText({
  sourceText: source,
  outputText: "Mei owns integration, replacing Ana. The approved cap is HKD 16,500, not HKD 18,000. Vendor A is no longer selected.",
  currentStateRequired: true,
});
assert.equal(staleDocument.ok, false, "current-state validation accepted superseded history");
assert(
  staleDocument.defects.some((item) => item.code === "superseded-facts-present"),
  "superseded literals were not reported"
);
assert(
  staleDocument.defects.some((item) => item.code === "historical-transition-prose"),
  "historical transition prose was not reported"
);

const currentDocument = evaluateCurrentStateText({
  sourceText: source,
  outputText: "The demonstration is September 19, 2026. Mei owns integration. The approved cap is HKD 16,500. Vendor C supplies the filter.",
  currentStateRequired: true,
});
assert.equal(currentDocument.ok, true, "authoritative current-state prose was rejected");

const multilingualUnverifiedSource = [
  "09:40 Lachlan: 我把一本显微成像的 PDF 发到群里了。请保存到 Downloads/Books，并同步 Nutstore 私人备份。",
  "17:40 Lachlan: 今日真正完成：JLC 已付款；adapter 已验证；书籍归档请求已收到。书是否真的同步成功需要查证后才能写完成。",
].join("\n");
const unsupportedBookCompletion = evaluateUnverifiedSourceCompletionClaims({
  sourceText: multilingualUnverifiedSource,
  outputText: "Completed Today\nBook on microscopy archived to Downloads/Books and synced to Nutstore.",
});
assert.equal(unsupportedBookCompletion.ok, false, "an unverified cross-language backup was reported as completed");
assert(
  unsupportedBookCompletion.defects.some((item) => item.code === "source-unverified-completion-claim"),
  "an unsupported completion claim did not produce a precise source-status defect"
);
const preservedBookUncertainty = evaluateUnverifiedSourceCompletionClaims({
  sourceText: multilingualUnverifiedSource,
  outputText: "Pending\nVerify whether the microscopy book reached Nutstore; the archive request was received only.",
});
assert.equal(preservedBookUncertainty.ok, true, "a correctly preserved unverified source state was rejected");

const contextCompleteChatSource = [
  "08:07 Lachlan: Instagram retry must reuse the existing LazyEdit output.",
  "09:02 Sunny: Dataset publication permission remains unconfirmed.",
  "09:40 Lachlan: Archive the microscopy PDF and verify the Nutstore backup.",
  "10:15 Lachlan: Record the 5V 400mA PCB idea only; do not manufacture it.",
  "14:04 Lachlan: The M10-to-M6 adapter is assembled and verified.",
  "17:40 Lachlan: JLC is paid, but the book backup is still unverified.",
].join("\n");
const genericProcessOnlyReport = evaluateSourceTopicCoverage({
  goal: "Read the complete chat history and produce a context-complete report.",
  sourceText: contextCompleteChatSource,
  outputText:
    "This report read the source and created a structured LaTeX document. The PDF is ready for verification.",
});
assert.equal(
  genericProcessOnlyReport.ok,
  false,
  "a process-only report passed despite omitting every salient source topic"
);
assert(
  genericProcessOnlyReport.defects.some(
    (item) => item.code === "source-topic-coverage-incomplete"
  ),
  "missing source topic coverage did not produce a precise semantic defect"
);
const contextGroundedReport = evaluateSourceTopicCoverage({
  goal: "Read the complete chat history and produce a context-complete report.",
  sourceText: contextCompleteChatSource,
  outputText: [
    "Retry Instagram from the existing LazyEdit result only.",
    "Wait for Sunny before dataset publication and verify the Nutstore book backup.",
    "JLC is already paid and the M10-to-M6 adapter is verified.",
    "Keep the 5V 400mA PCB item as a note; do not manufacture it.",
  ].join(" "),
});
assert.equal(
  contextGroundedReport.ok,
  true,
  `a report grounded in the source topics was rejected: ${JSON.stringify(contextGroundedReport)}`
);
const contradictoryBookCompletion = evaluateUnverifiedSourceCompletionClaims({
  sourceText: multilingualUnverifiedSource,
  outputText: "Completed Today\nMicroscopy PDF archived to Downloads/Books and synced to Nutstore (verification pending).",
});
assert.equal(
  contradictoryBookCompletion.ok,
  false,
  "a positive completion claim escaped validation merely by appending a pending-verification qualifier"
);
const unrelatedVerifiedCompletion = evaluateUnverifiedSourceCompletionClaims({
  sourceText: multilingualUnverifiedSource,
  outputText: "Completed Today\nJLC order paid and adapter verified.",
});
assert.equal(unrelatedVerifiedCompletion.ok, true, "a separately verified completion was tied to an unrelated source uncertainty");
const repeatedSpeakerDoesNotJoinStatuses = evaluateUnverifiedSourceCompletionClaims({
  sourceText: [
    "09:06 Lachlan: 在 Sunny 明确确认许可前不要上传数据。",
    "10:43 Lachlan: 已支付的 JLC 订单不需要再操作。",
  ].join("\n"),
  outputText: "Completed Today\nJLC order paid and confirmed.",
});
assert.equal(
  repeatedSpeakerDoesNotJoinStatuses.ok,
  true,
  "transport sender labels connected an unresolved item to an unrelated verified completion"
);
const transitiveChatTermsDoNotJoinStatuses = evaluateUnverifiedSourceCompletionClaims({
  sourceText: [
    "09:06 Lachlan: 在 Sunny 明确确认许可前不要上传数据。",
    "10:43 Lachlan: 已支付的 JLC 订单不需要再操作。",
    "14:35 Lachlan: 每日 memo 要整理完成事项、等待事项和明确边界。",
    "16:28 Lachlan: 数据上传任务状态是等待 Sunny，明天中午检查。",
  ].join("\n"),
  outputText: "Daily Memo\nCompleted Today\nJLC order paid and confirmed.",
});
assert.equal(
  transitiveChatTermsDoNotJoinStatuses.ok,
  true,
  "transitive chat vocabulary connected an unresolved dataset to an unrelated JLC completion"
);
const adjacentPronounCompletion = evaluateUnverifiedSourceCompletionClaims({
  sourceText: [
    "13:12 System: Instagram automation reports login required; no upload started.",
    "13:18 Lachlan: 这是阻塞，不是失败。等登录恢复后只重试 Instagram。",
  ].join("\n"),
  outputText: [
    "Instagram upload is blocked by login; retry only after login is restored.",
    "Do not re-publish the bird video on Instagram; it has already been posted.",
  ].join("\n"),
});
assert.equal(
  adjacentPronounCompletion.ok,
  false,
  "an adjacent pronoun completion claim contradicted a source-verified login blocker"
);

const supersedesHistory = evaluateCurrentStateText({
  sourceText: source,
  outputText: "This document supersedes earlier planning notes. The current owner is Mei.",
  currentStateRequired: true,
});
assert.equal(supersedesHistory.ok, false, "present-tense supersedes history was accepted");
assert(
  supersedesHistory.defects.some((item) => item.code === "historical-transition-prose"),
  "present-tense supersedes did not produce a historical transition defect"
);

const inconsistentActions = evaluateDocumentConsistency([
  "Three open actions remain.",
  "Remaining Actions",
  "Place filter order 28 August 2026",
  "Provide wiring diagram 2 September 2026",
  "Complete safety review 5 September 2026",
  "Freeze checklist 10 September 2026",
  "Budget",
].join("\n"));
assert.equal(inconsistentActions.ok, false, "declared action count contradicted by the action section was accepted");
assert.equal(inconsistentActions.actionSectionItemCount, 4);
assert.equal(inconsistentActions.defects[0]?.code, "action-count-inconsistency");

const consistentActions = evaluateDocumentConsistency([
  "Four open actions remain.",
  "Remaining Actions",
  "Place filter order 28 August 2026",
  "Provide wiring diagram 2 September 2026",
  "Complete safety review 5 September 2026",
  "Freeze checklist 10 September 2026",
  "Budget",
].join("\n"));
assert.equal(consistentActions.ok, true, "matching declared and section action counts were rejected");

const duplicatedProse = evaluateDocumentConsistency(
  "Ideas: the concept of the concept of an instrument as agent."
);
assert.equal(duplicatedProse.ok, false, "an adjacent duplicated prose fragment was accepted");
assert(
  duplicatedProse.defects.some((item) => item.code === "duplicated-prose-fragment"),
  "an adjacent duplicated prose fragment did not produce its quality defect"
);
const duplicatedWrappedBullet = evaluateDocumentConsistency([
  "Future Ideas",
  "\u0088 Develop a conceptual article titled Turning Instruments into Collaborators, using case studies",
  "from closed-loop microscopy, active spectroscopy, and autonomous experimentation.",
  "\u0088 Explore another bounded idea for the roadmap and preserve it for later review.",
  "\u0088 Develop a conceptual article titled Turning Instruments into Collaborators, using case studies",
  "from closed-loop microscopy, active spectroscopy, and autonomous experimentation.",
].join("\n"));
assert.equal(
  duplicatedWrappedBullet.ok,
  false,
  "a repeated non-adjacent wrapped PDF bullet was accepted"
);
assert(
  duplicatedWrappedBullet.defects.some(
    (item) => item.code === "duplicated-prose-fragment"
  ),
  "a repeated wrapped PDF bullet did not produce its quality defect"
);

const unverifiedCompletedSection = evaluateDocumentConsistency([
  "Completed Tasks",
  "\u0088 A microscopy book was received and archived to the designated",
  "local and cloud storage locations; verification is pending.",
  "Pending Actions",
  "\u0088 Verify the private backup evidence.",
].join("\n"));
assert.equal(
  unverifiedCompletedSection.ok,
  false,
  "wrapped unverified work inside a Completed section was accepted"
);
assert(
  unverifiedCompletedSection.defects.some(
    (item) => item.code === "completed-section-contains-unverified-work"
  ),
  "a wrapped completed/pending contradiction did not produce its section defect"
);

const contradictoryStatus = evaluateDocumentConsistency([
  "Completed: JLC paid; book archive synchronized.",
  "Pending: book archive evidence remains unverified.",
].join("\n"));
assert.equal(contradictoryStatus.ok, false, "completed and unverified status for one subject was accepted");
assert(
  contradictoryStatus.defects.some((item) => item.code === "completed-unverified-status-conflict"),
  "a completed/unverified status conflict did not produce its quality defect"
);

const separateStatusBullets = evaluateDocumentConsistency([
  "Executive Summary",
  "This report outlines the current work without assigning status.",
  "- Completed: authentication tests passed.",
  "- Pending: deployment verification is waiting.",
].join("\n"));
assert.equal(
  separateStatusBullets.defects.some((item) => item.code === "completed-unverified-status-conflict"),
  false,
  "the status parser treated report preamble text as part of a wrapped status bullet"
);

const malformedLatexSource = evaluateLatexSourceStructure([
  "\\documentclass{article}",
  "\\begin{document}",
  "Current report.",
  "\\end{document}",
  "Duplicated report suffix.",
  "\\end{document}",
].join("\n"));
assert.equal(malformedLatexSource.ok, false, "duplicated LaTeX document suffix was accepted");
assert(
  malformedLatexSource.defects.some((item) => item.code === "latex-content-after-document-end") &&
    malformedLatexSource.defects.some((item) => item.code === "latex-duplicate-document-end"),
  "malformed LaTeX source did not report both trailing content and duplicate document termination"
);
const validLatexSource = evaluateLatexSourceStructure([
  "\\documentclass{article}",
  "\\begin{document}",
  "Current report with an escaped \\% sign.",
  "\\end{document}",
  "% \\end{document} in a comment is harmless.",
].join("\n"));
assert.equal(validLatexSource.ok, true, "valid LaTeX source with trailing comments was rejected");
const duplicateLatexDate = evaluateLatexSourceStructure([
  "\\documentclass{article}",
  "\\date{2026-08-23}",
  "% \\date{ignored comment}",
  "\\date{2026-09-01}",
  "\\begin{document}",
  "Current report.",
  "\\end{document}",
].join("\n"));
assert.equal(duplicateLatexDate.ok, false, "duplicate active LaTeX date declarations were accepted");
assert(
  duplicateLatexDate.defects.some(
    (item) => item.code === "latex-duplicate-singleton-command" && item.command === "date"
  ),
  "duplicate LaTeX date declarations did not produce a precise source defect"
);

assert(
  currentStateRequested(
    "Read the complete chat history and reconcile corrections into the current memo.",
    "更正：巴黎视频今天不要发布，上面这句取消。"
  ),
  "multilingual current-state correction language did not activate reconciliation checks"
);

const exactSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-source-"));
try {
  await fs.writeFile(
    path.join(exactSourceRoot, "chat_history.md"),
    "Later correction: keep the publication blocked until login is restored.\n",
    "utf8"
  );
  const exactSources = await collectDocumentSourceDocuments(
    exactSourceRoot,
    ["chat_history.md"]
  );
  assert.deepEqual(
    exactSources.map((item) => item.path),
    ["chat_history.md"],
    "an exact root-level source path was omitted from document validation"
  );
} finally {
  await fs.rm(exactSourceRoot, { recursive: true, force: true });
}

const versioningRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-versioning-"));
try {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("git", ["init", "-q"], { cwd: versioningRoot });
  await fs.writeFile(path.join(versioningRoot, "report.pdf"), "fixture", "utf8");
  assert.equal(
    (await documentArtifactVersioningDefect(versioningRoot, "report.pdf"))?.code,
    "document-artifact-not-versioned",
    "an untracked final document artifact passed commit-aware validation"
  );
  await run("git", ["add", "--", "report.pdf"], { cwd: versioningRoot });
  assert.equal(
    await documentArtifactVersioningDefect(versioningRoot, "report.pdf"),
    null,
    "a staged document artifact was reported as unversioned"
  );
} finally {
  await fs.rm(versioningRoot, { recursive: true, force: true });
}

function page(
  words,
  { height = 842, startY = 60, endY = 700, heading = "Section", wordHeight = 10 } = {}
) {
  const items = [];
  const count = Math.max(1, words);
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const y = startY + (endY - startY) * ratio;
    const text = index === 0 ? heading : `word${index}`;
    items.push(
      `<word xMin="60" yMin="${y.toFixed(2)}" xMax="100" yMax="${(y + wordHeight).toFixed(2)}">${text}</word>`
    );
  }
  items.push(`<word xMin="250" yMin="810" xMax="300" yMax="820">footer</word>`);
  return `<page width="595" height="${height}">${items.join("")}</page>`;
}

const sparse = evaluatePdfPageBalance(`<doc>${page(240)}${page(55, { endY: 190, heading: "Risks" })}</doc>`);
assert.equal(sparse.ok, false, "a sparse trailing spill page was accepted");
assert.equal(sparse.defects[0]?.code, "sparse-trailing-page");

const balanced = evaluatePdfPageBalance(`<doc>${page(220)}${page(160, { endY: 620, heading: "Risks" })}</doc>`);
assert.equal(balanced.ok, true, "a balanced two-page document was rejected");

const intentionalAppendix = evaluatePdfPageBalance(
  `<doc>${page(220)}${page(35, { endY: 170, heading: "Appendix" })}</doc>`
);
assert.equal(intentionalAppendix.ok, true, "an intentional sparse appendix page was rejected");

const undersizedOnePage = evaluatePdfPageBalance(
  `<doc>${page(340, { wordHeight: 8.3 })}</doc>`
);
assert.equal(undersizedOnePage.ok, false, "undersized one-page typography was accepted");
assert(
  undersizedOnePage.defects.some((item) => item.code === "undersized-document-text"),
  "undersized typography did not produce a reader-facing defect"
);

const readableOnePage = evaluatePdfPageBalance(
  `<doc>${page(260, { wordHeight: 9.4 })}</doc>`
);
assert.equal(readableOnePage.ok, true, "readable one-page typography was rejected");

const cleanExtractedText = evaluateExtractedDocumentText("Page one\n\fPage two\tvalue\r\n");
assert.equal(cleanExtractedText.ok, true, "normal whitespace and PDF form feeds were rejected");

const corruptExtractedText = evaluateExtractedDocumentText("Reference detector \u0016 complete \ufffd");
assert.equal(corruptExtractedText.ok, false, "control and replacement glyphs were accepted");
assert.deepEqual(corruptExtractedText.codePoints, [0x16, 0xfffd]);
assert.equal(corruptExtractedText.defects[0]?.code, "corrupt-extracted-text");

const latexBulletExtraction = evaluateExtractedDocumentText(
  "Completed tasks\n\u0088 First item\n\u0088 Second item\n"
);
assert.equal(
  latexBulletExtraction.ok,
  true,
  "the bounded pdflatex list-marker extraction glyph was treated as document corruption"
);
const embeddedControl = evaluateExtractedDocumentText("broken\u0088inside");
assert.equal(embeddedControl.ok, false, "an embedded C1 control byte was accepted as a list marker");

const boundedText = evaluatePdfTextBounds(`<doc>${page(20)}</doc>`);
assert.equal(boundedText.ok, true, "text inside readable margins was rejected");

const clippedText = evaluatePdfTextBounds(
  '<doc><page width="595" height="842"><word xMin="8" yMin="60" xMax="90" yMax="70">clipped</word></page></doc>'
);
assert.equal(clippedText.ok, false, "text outside readable margins was accepted");
assert.equal(clippedText.defects[0]?.code, "pdf-text-outside-readable-margin");

console.log("document artifact quality smoke test passed");
