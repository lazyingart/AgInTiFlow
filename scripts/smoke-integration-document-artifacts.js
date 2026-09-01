import assert from "node:assert/strict";

import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import {
  classifyIntegrationDocumentArtifactIntent,
  evaluateIntegrationDocumentArtifactCompletion,
  extractIntegrationExactFencedTeXSource,
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

const productionIntegrityPrompt =
  "Create exactly two downloadable file artifacts named mobile-r137.tex and mobile-r137.pdf. " +
  "Write a short self-contained LaTeX document titled Mobile R137 General Agent Test. " +
  "Include one sentence explaining that this PDF was compiled by the general Agent tool workflow and the displayed equation E = mc^2. " +
  "Actually compile the TeX into a valid PDF using the available TeX compiler. " +
  "Do not fake or base64-encode the PDF, and create no other file.";
const productionIntegrityIntent = classifyIntegrationDocumentArtifactIntent(productionIntegrityPrompt, []);
assert.equal(productionIntegrityIntent.required, true);
assert.equal(productionIntegrityIntent.kind, "tex-pdf");
assert.deepEqual(productionIntegrityIntent.requiredFormats, ["tex", "pdf"]);

const exactFencedSource = "\\documentclass{article}\n\\begin{document}\nExact bytes.\n\\end{document}\n";
const exactFencedPrompt = `Create exact.tex and exact.pdf. Compile this exact source byte-for-byte, including its final newline.\n\n\`\`\`tex\n${exactFencedSource}\`\`\``;
assert.equal(extractIntegrationExactFencedTeXSource(exactFencedPrompt), exactFencedSource);
assert.equal(
  extractIntegrationExactFencedTeXSource(`Create example.tex and example.pdf.\n\n\`\`\`tex\n${exactFencedSource}\`\`\``),
  null,
  "a fenced example without exact-source authority must remain model-authored",
);
assert.equal(
  extractIntegrationExactFencedTeXSource(`${exactFencedPrompt}\n\n\`\`\`latex\n${exactFencedSource}\`\`\``),
  null,
  "ambiguous multiple exact TeX fences must fail closed",
);

for (const prompt of [
  "Create the report in LaTeX and give me the PDF.",
  "Generate a QAOA paper using LaTeX and return a PDF.",
  "Prepare the TeX manuscript and PDF.",
  "Write the LaTeX and PDF files.",
  "Produce both LaTeX and PDF versions.",
  "Please send me the TeX source and compiled PDF.",
  "I need the .tex and .pdf files.",
  "Give me a LaTeX source and compiled PDF.",
  "Output a TeX source plus compiled PDF.",
  "Create exactly two downloadable file artifacts named live_document.tex and live_document.pdf. Compile that exact source into the PDF using the document worker. Do not create another artifact and do not merely paste the files into chat.",
  "Create report.tex and report.pdf. Do not fake the PDF; compile it normally.",
  "Generate the TeX source and compiled PDF, but never return a placeholder PDF.",
  "Create both .tex and .pdf deliverables without base64 encoding the PDF.",
  "Write the LaTeX file and build the PDF; no fake PDF is acceptable.",
  "Compile a short TeX source into a PDF and do not simulate either file.",
  "请提供 LaTeX 源文件和编译后的 PDF。",
  "我需要 LaTeX 源文件和编译后的 PDF。",
  "制作 LaTeX 和 PDF 文件。",
]) {
  assert.equal(
    classifyIntegrationDocumentArtifactIntent(prompt, []).required,
    true,
    `${prompt} must request the paired TeX/PDF deliverable`,
  );
}

for (const prompt of [
  "Write a tutorial about how LaTeX source is compiled to PDF.",
  "Can you write a tutorial on using LaTeX to compile a PDF?",
  "Prepare a comparison of LaTeX source and compiled PDF internals.",
  "Generate prose explaining a LaTeX source and compiled PDF.",
  "Create a LaTeX source and compiled PDF, but do not create files.",
  "Create a LaTeX source but do not create the PDF.",
  "Create mobile-r137.tex and do not compile or output a PDF.",
  "Write the TeX source only.",
  "Create a PDF only, without the TeX source.",
  "Create a report, but do not output TeX or PDF files.",
  "Create neither a LaTeX source nor compiled PDF; just explain them.",
  "Write a LaTeX source-code example that mentions PDF.",
  "Provide advice on creating a LaTeX source and compiled PDF.",
  "Provide an explanation of LaTeX and PDF.",
  "Write about LaTeX and PDF.",
]) {
  assert.equal(
    classifyIntegrationDocumentArtifactIntent(prompt, []).required,
    false,
    `${prompt} describes the formats but must not create files`,
  );
}

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
assert.equal(
  classifyIntegrationDocumentArtifactIntent(
    "Update the previous TeX and PDF. Do not fake or base64-encode the PDF.",
    priorConversation,
  ).required,
  true,
  "format-integrity guards must not cancel an explicit document revision",
);
assert.equal(
  classifyIntegrationDocumentArtifactIntent(
    "Update the previous TeX source, but do not create or compile the PDF.",
    priorConversation,
  ).required,
  false,
  "direct negation of a requested document format must still cancel a revision",
);

const unrelatedPlotConversation = [
  {
    role: "user",
    content: "Run bounded Python and create one real line-plot artifact with labeled axes and title.",
  },
  { role: "assistant", content: "The verified Python plot is ready." },
];
assert.equal(
  classifyIntegrationDocumentArtifactIntent(
    "Create exactly two downloadable files named qaoa.tex and qaoa.pdf. Compile a short LaTeX note.",
    unrelatedPlotConversation,
  ).requirements.minimumFigureCount,
  0,
  "an unrelated analysis plot must not become a TeX figure requirement",
);
assert.equal(
  classifyIntegrationDocumentArtifactIntent(
    "Create another new LaTeX report and compiled PDF without requesting a figure.",
    priorConversation,
    { active: true, allowImplicitReference: true, minimumFigureCount: 1 },
  ).requirements.minimumFigureCount,
  0,
  "a new document must not inherit the previous document's figure requirement",
);
for (const prompt of [
  "Update it",
  "Change it",
  "Make it better",
  "Make it longer and recompile",
  "Recompile",
  "Add more detail",
]) {
  assert.equal(
    classifyIntegrationDocumentArtifactIntent(prompt, priorConversation).required,
    true,
    `${prompt} must be a natural immediate document followup`,
  );
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, priorConversation),
    true,
    `${prompt} must retain prior-source revision semantics`,
  );
}
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

for (const action of ["Revise", "Edit", "Fix", "Rewrite"]) {
  const prompt =
    `${action} this supplied self-contained LaTeX source and return both current.tex and current.pdf:\n` +
    "```latex\n\\documentclass{article}\n\\begin{document}\nCURRENT_FENCED_SOURCE\n\\end{document}\n```";
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt, []).required, true);
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, []),
    false,
    `${action} with a complete fenced source must compile that current source without lineage`,
  );
}

const interveningConversation = [
  ...priorConversation,
  { role: "user", content: "What is one plus one?" },
  { role: "assistant", content: "Two." },
];
for (const prompt of ["Update it", "Change it", "Make it better", "Make it longer and recompile", "Recompile"]) {
  const strictLineage = Object.freeze({
    active: true,
    allowImplicitReference: false,
    minimumFigureCount: 1,
  });
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt, interveningConversation, strictLineage).required, false);
  assert.equal(
    isIntegrationDocumentArtifactRevision(prompt, interveningConversation, strictLineage),
    false,
    `${prompt} must not bind a bare pronoun across an intervening non-document answer`,
  );
}
assert.equal(
  isIntegrationDocumentArtifactRevision(
    "Update the previous TeX document title and recompile the PDF.",
    interveningConversation,
    { active: true, allowImplicitReference: false, minimumFigureCount: 1 },
  ),
  true,
  "an explicit document target may use older same-thread committed lineage",
);

const clippedLineageContext = Object.freeze({
  active: true,
  allowImplicitReference: true,
  minimumFigureCount: 2,
});
const clippedConversation = Array.from({ length: 24 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  content: `Ordinary clipped message ${index}.`,
}));
assert.equal(
  classifyIntegrationDocumentArtifactIntent("Update it and recompile", clippedConversation, clippedLineageContext)
    .requirements.minimumFigureCount,
  2,
  "verified prior figure count must survive clipped public conversation",
);
assert.equal(
  classifyIntegrationDocumentArtifactIntent("Remove all figures and recompile the PDF", clippedConversation, clippedLineageContext)
    .requirements.minimumFigureCount,
  0,
  "the current user may explicitly remove the inherited figure requirement",
);
assert.equal(
  classifyIntegrationDocumentArtifactIntent("Do not remove the figures; update it", clippedConversation, clippedLineageContext)
    .requirements.minimumFigureCount,
  2,
  "a negated removal must preserve the inherited verified figure count",
);

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
  "Add it to my shopping list.",
  "Remove it from my shopping list.",
  "Replace it in the code sample below.",
  "Make the code sample better.",
  "Make the shopping list longer.",
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
