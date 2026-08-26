import assert from "node:assert/strict";

import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import {
  classifyIntegrationDocumentArtifactIntent,
  evaluateIntegrationDocumentArtifactCompletion,
  isIntegrationDocumentArtifactRevision,
} from "../src/integration-document-artifacts.js";
import { createDocumentWorkerFixture, compileRequirements } from "./test-document-worker-fixture.js";

const scope = Object.freeze({
  principalId: "principal_document_artifact_smoke_001",
  browserSessionId: "7".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000201",
  runId: "run_00000000-0000-4000-8000-000000000202",
});

const productionPrompt = "Write a latex of qaoa compile and give me link of pdf with figures";
const productionIntent = classifyIntegrationDocumentArtifactIntent(productionPrompt, []);
assert.equal(productionIntent.required, true);
assert.equal(productionIntent.kind, "tex-pdf");
assert.deepEqual(productionIntent.requiredFormats, ["tex", "pdf"]);
assert.equal(productionIntent.requirements.minimumFigureCount, 1);

const priorConversation = [
  { role: "user", content: productionPrompt },
  { role: "assistant", content: "Created the requested TeX source and PDF." },
];
const ordinary = classifyIntegrationDocumentArtifactIntent("What is QAOA in one sentence?", priorConversation);
assert.equal(ordinary.required, false, "ordinary same-thread chat must not inherit file creation authority");
const revision = classifyIntegrationDocumentArtifactIntent("revise it and recompile", priorConversation);
assert.equal(revision.required, true);
assert.equal(revision.requirements.minimumFigureCount, 1, "explicit revision retains the figure requirement");
assert.equal(isIntegrationDocumentArtifactRevision("revise it and recompile", priorConversation), true);
for (const prompt of [
  "Create another new LaTeX report and compiled PDF about a different topic.",
  "Build a fresh LaTeX report and PDF about a different topic.",
  "Produce a second LaTeX report and compiled PDF about a different topic.",
  "Regenerate a new LaTeX report and compiled PDF about a different topic.",
  "Rewrite a new LaTeX report and compiled PDF from scratch.",
  "Recompile a separate LaTeX source and PDF about a different topic.",
]) {
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt, priorConversation).required, true);
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, priorConversation, true),
    false,
    `${prompt} must retain initial-creation behavior`
  );
}
assert.equal(
  isIntegrationDocumentArtifactRevision(productionPrompt, [{ role: "user", content: productionPrompt }]),
  false,
  "an identical failed initial request must remain an initial creation"
);
assert.equal(
  isIntegrationDocumentArtifactRevision("revise it and recompile", [
    ...priorConversation,
    { role: "user", content: "revise it and recompile" },
  ]),
  true,
  "an identical failed revision retry must remain source-bound"
);
assert.equal(
  isIntegrationDocumentArtifactRevision("revise it and recompile", [], true),
  true,
  "server-owned committed ancestry must not depend on clipped conversation"
);
for (const prompt of [
  "Compile this LaTeX source to PDF and return both report.tex and report.pdf:\n```latex\n\\documentclass{article}\\begin{document}Current source\\end{document}\n```",
  "Compile a new LaTeX report to PDF and return both new-report.tex and new-report.pdf.",
]) {
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt, []).required, true);
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, []),
    false,
    `${prompt} must retain first-turn source/creation behavior`
  );
}

const mutationFollowups = [
  ["add a section on approximation ratios", 1],
  ["include three references", 1],
  ["change the title to QAOA Overview", 1],
  ["update the PDF and source wording", 1],
  ["remove the figure", 0],
  ["replace the figure with an objective curve", 1],
];
for (const [prompt, minimumFigureCount] of mutationFollowups) {
  const intent = classifyIntegrationDocumentArtifactIntent(prompt, priorConversation);
  assert.equal(intent.required, true, `${prompt} must revise the active document`);
  assert.equal(intent.requirements.minimumFigureCount, minimumFigureCount);
  assert.equal(
    classifyIntegrationDocumentArtifactIntent(prompt, []).required,
    false,
    `${prompt} must not create a document without an active document conversation`,
  );
}

for (const prompt of [
  "Can you explain the figure?",
  "Which references should I read next?",
  "Should I remove the figure?",
  "Add two and three.",
  "Include QAOA in your next chat answer.",
  "Change your answer if new facts emerge.",
  "Remove ambiguity from your explanation.",
  "Replace x with y in the equation below.",
  "Can you explain why someone might say \"remove the figure\"?",
  "Add this to my shopping list.",
  "Change this chat topic to gardening.",
  "Update me on the weather report.",
]) {
  assert.equal(
    classifyIntegrationDocumentArtifactIntent(prompt, priorConversation).required,
    false,
    `${prompt} must remain an ordinary same-thread conversation`,
  );
}

for (const prompt of [
  "Add this to my shopping list.",
  "Change this chat topic to gardening.",
  "Update me on the weather report.",
]) {
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, priorConversation, true),
    false,
    `${prompt} must not fetch or compile the active document`
  );
}

const worker = createDocumentWorkerFixture();
const client = worker.client();
const source = [
  "\\documentclass{article}",
  "\\usepackage{tikz}",
  "\\begin{document}",
  "\\begin{figure}",
  "\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}",
  "\\caption{A self-contained QAOA schematic}",
  "\\end{figure}",
  "\\end{document}",
  "",
].join("\n");
const compiled = await client.compile(scope, {
  filename: "qaoa.tex",
  source,
  requirements: compileRequirements(1),
});

const stagedGate = await evaluateIntegrationDocumentArtifactCompletion(productionIntent, compiled.artifacts);
assert.equal(stagedGate.ok, false, "a compile receipt without commit ACK must never satisfy completion");
await client.commitArtifacts(scope, { receiptDigest: compiled.receipt.digest, artifacts: compiled.artifacts });
const committedGate = await evaluateIntegrationDocumentArtifactCompletion(productionIntent, compiled.artifacts);
assert.equal(committedGate.ok, true);

const forged = [
  sanitizeIntegrationArtifact({
    title: "forged source",
    kind: "file",
    spec: { schemaVersion: "1", filename: "qaoa.tex", mime: "application/x-tex", bytes: 8, sha256: "a".repeat(64) },
  }),
  sanitizeIntegrationArtifact({
    title: "forged PDF",
    kind: "file",
    spec: { schemaVersion: "1", filename: "qaoa.pdf", mime: "application/pdf", bytes: 8, sha256: "b".repeat(64) },
  }),
];
assert.equal((await evaluateIntegrationDocumentArtifactCompletion(productionIntent, forged)).ok, false);

console.log("integration document artifact broker smoke passed");
