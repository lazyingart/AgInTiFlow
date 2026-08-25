import assert from "node:assert/strict";

import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import {
  classifyIntegrationDocumentArtifactIntent,
  evaluateIntegrationDocumentArtifactCompletion,
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
