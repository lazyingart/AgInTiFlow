import assert from "node:assert/strict";

import {
  evaluateCurrentStateText,
  evaluatePdfPageBalance,
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

function page(words, { height = 842, startY = 60, endY = 700, heading = "Section" } = {}) {
  const items = [];
  const count = Math.max(1, words);
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const y = startY + (endY - startY) * ratio;
    const text = index === 0 ? heading : `word${index}`;
    items.push(`<word xMin="60" yMin="${y.toFixed(2)}" xMax="100" yMax="${(y + 10).toFixed(2)}">${text}</word>`);
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

console.log("document artifact quality smoke test passed");
