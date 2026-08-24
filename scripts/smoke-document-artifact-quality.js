import assert from "node:assert/strict";

import {
  evaluateCurrentStateText,
  evaluateDocumentConsistency,
  evaluateExtractedDocumentText,
  evaluatePdfPageBalance,
  evaluatePdfTextBounds,
  extractSupersededLiterals,
} from "../src/document-artifact-quality.js";

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

const boundedText = evaluatePdfTextBounds(`<doc>${page(20)}</doc>`);
assert.equal(boundedText.ok, true, "text inside readable margins was rejected");

const clippedText = evaluatePdfTextBounds(
  '<doc><page width="595" height="842"><word xMin="8" yMin="60" xMax="90" yMax="70">clipped</word></page></doc>'
);
assert.equal(clippedText.ok, false, "text outside readable margins was accepted");
assert.equal(clippedText.defects[0]?.code, "pdf-text-outside-readable-margin");

console.log("document artifact quality smoke test passed");
