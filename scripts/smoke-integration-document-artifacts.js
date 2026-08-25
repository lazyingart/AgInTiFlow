#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  classifyIntegrationDocumentArtifactIntent,
  evaluateIntegrationDocumentArtifactCompletion,
  validateIntegrationPdfBytes,
} from "../src/integration-document-artifacts.js";
import {
  compileIntegrationTexDocument,
  inspectIntegrationTexCompilerRuntime,
  inspectPrivateIntegrationFileArtifact,
  validateIntegrationTexCompileReceipt,
} from "../src/integration-tex-compiler.js";

function minimalPdf() {
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n",
  ]) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += [
    "xref",
    "0 3",
    "0000000000 65535 f ",
    `${String(offsets[1]).padStart(10, "0")} 00000 n `,
    `${String(offsets[2]).padStart(10, "0")} 00000 n `,
    "trailer",
    "<< /Size 3 /Root 1 0 R >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.from(body, "latin1");
}

function structurallyPlausibleButInvalidPdf() {
  let body = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog >>",
    "endobj",
    "",
  ].join("\n");
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += [
    "xref",
    "0 2",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "trailer",
    "<< /Size 2 /Root 9 0 R >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.from(body, "latin1");
}

const positivePrompts = [
  "Create a LaTeX report and deliver both the TeX source and compiled PDF.",
  "Please write report.tex, then compile report.tex to PDF.",
  "Write report.tex. Then compile it to PDF.",
  "Could you generate a PDF using LaTeX and keep the source file?",
  "Use LaTeX to make a PDF and include the .tex source.",
  "Need the final report in both TeX and PDF formats.",
  "I need output/report.tex and output/report.pdf.",
  "Revise the TeX source and recompile the PDF with a second paragraph.",
  "请帮我创建 LaTeX 源文件以及编译后的 PDF。",
  "Compile this LaTeX source to PDF:\n```latex\n\\documentclass{article}\n\\begin{document}Hi\\end{document}\n```",
  "Compile this to PDF:\n```latex\n\\documentclass{article}\n\\begin{document}Hi\\end{document}\n```",
  "Quoted warning: \"Do not create PDF.\" Create report.tex and report.pdf.",
];
for (const prompt of positivePrompts) {
  const intent = classifyIntegrationDocumentArtifactIntent(prompt);
  assert.equal(intent.required, true, prompt);
  assert.deepEqual(intent.requiredFormats, ["tex", "pdf"], prompt);
}

const negativePrompts = [
  "Explain how LaTeX creates a PDF.",
  "Review report.tex but do not compile or create a PDF.",
  "If I created a TeX file and PDF, would the fonts match?",
  "Could a LaTeX file and PDF be generated without running code?",
  "Convert this PDF to Markdown.",
  "Create a PDF and explain the TeX notation shown in it.",
  "Prepare a report comparing TeX and PDF differences.",
  "Prepare notes about TeX and PDF syntax.",
  "Quoted instruction: \"Create a LaTeX report and PDF.\" Why did that fail?",
  "Write a TeX source file only; no PDF is needed.",
  "Summarize the PDF attached to this chat.",
  "I need both TeX and PDF explained.",
  "I need a discussion of both TeX and PDF.",
  "I want both TeX and PDF compared.",
  "I require an explanation of both TeX and PDF.",
  "I need both TeX and PDF support.",
];
for (const prompt of negativePrompts) {
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt).required, false, prompt);
}

const documentConversation = [
  { role: "user", content: "Create a LaTeX report and deliver both the TeX source and compiled PDF." },
  { role: "assistant", content: "Created the requested TeX source and PDF." },
];
for (const prompt of [
  "Make the title bigger and regenerate the files.",
  "Please revise it and recompile.",
  "Fix the report grammar.",
  "Recompile the document.",
  "Create the requested files again.",
  "Continue and make the title bigger.",
  "Now regenerate the same files.",
]) {
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt, documentConversation).required, true, prompt);
  assert.equal(classifyIntegrationDocumentArtifactIntent(prompt).required, false, `${prompt} requires document context`);
}
assert.equal(
  classifyIntegrationDocumentArtifactIntent(
    "Make the title bigger and regenerate the files.",
    [...documentConversation, { role: "user", content: "Now explain the weather." }]
  ).required,
  false,
  "an unrelated intervening user turn ends the document follow-up chain"
);
assert.equal(
  classifyIntegrationDocumentArtifactIntent("Create a PDF only; do not provide the TeX source.", documentConversation).required,
  false,
  "a current format exclusion overrides prior document context"
);

const intent = classifyIntegrationDocumentArtifactIntent(
  "Prepare a TeX source document and a compiled PDF."
);
const sourceBytes = Buffer.from("\\documentclass{article}\n\\begin{document}Verified\\end{document}\n", "utf8");
const validPdf = minimalPdf();
const compiled = await compileIntegrationTexDocument({ filename: "report.tex", source: sourceBytes.toString("utf8") });
const [texArtifact, pdfArtifact] = compiled.artifacts;
const runtime = await inspectIntegrationTexCompilerRuntime();
assert.equal(runtime.networkNone, true);
assert.equal(runtime.shellEscape, false);
assert.equal(runtime.limits.maximumPdfBytes, 16 * 1024 * 1024);
assert(validateIntegrationTexCompileReceipt(compiled.receipt));
assert.throws(
  () => validateIntegrationTexCompileReceipt(Object.freeze({ ...compiled.receipt })),
  (error) => error?.code === "ANALYSIS_TEX_RECEIPT_INVALID",
  "a byte-identical receipt clone does not inherit server issuance authority"
);
assert(inspectPrivateIntegrationFileArtifact(texArtifact));
assert(inspectPrivateIntegrationFileArtifact(pdfArtifact));

await compileIntegrationTexDocument({
  filename: "shell-escape.tex",
  source: [
    "\\documentclass{article}",
    "\\newread\\shellprobe",
    "\\begin{document}",
    "\\immediate\\write18{/usr/bin/touch /work/shell-ran}",
    "\\openin\\shellprobe=/work/shell-ran",
    "\\ifeof\\shellprobe\\else\\errmessage{shell escape executed}\\fi",
    "\\closein\\shellprobe",
    "Shell escape must remain disabled.",
    "\\end{document}",
    "",
  ].join("\n"),
});
await assert.rejects(
  compileIntegrationTexDocument({
    filename: "host-read.tex",
    source: "\\documentclass{article}\n\\begin{document}\\input{/etc/passwd}\\end{document}\n",
  }),
  (error) => error?.code === "ANALYSIS_TEX_COMPILE_FAILED",
  "the sandbox cannot read a host-private absolute path"
);

let abortedSpawned = false;
const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(
  compileIntegrationTexDocument(
    { filename: "never-start.tex", source: sourceBytes.toString("utf8") },
    { signal: alreadyAborted.signal, spawnImpl: () => { abortedSpawned = true; } }
  ),
  (error) => error?.code === "ANALYSIS_CANCELLED" && error?.status === 499
);
assert.equal(abortedSpawned, false, "an already-cancelled compile never starts a process");

let preflightCancelledSpawned = false;
const preflightCancellation = new AbortController();
const preflightCancelledCompile = compileIntegrationTexDocument(
  { filename: "cancel-during-preflight.tex", source: sourceBytes.toString("utf8") },
  {
    signal: preflightCancellation.signal,
    spawnImpl: () => {
      preflightCancelledSpawned = true;
      throw new Error("a cancelled compile must not spawn");
    },
  }
);
queueMicrotask(() => preflightCancellation.abort());
await assert.rejects(
  preflightCancelledCompile,
  (error) => error?.code === "ANALYSIS_CANCELLED" && error?.status === 499
);
assert.equal(preflightCancelledSpawned, false, "cancellation during fixed-runtime preflight prevents process start");

const terminatingChild = new EventEmitter();
terminatingChild.stdout = new PassThrough();
terminatingChild.stderr = new PassThrough();
terminatingChild.killCalls = 0;
terminatingChild.kill = () => {
  terminatingChild.killCalls += 1;
  queueMicrotask(() => terminatingChild.emit("close", null, "SIGKILL"));
  return true;
};
const runningCancellation = new AbortController();
await assert.rejects(
  compileIntegrationTexDocument(
    { filename: "cancel-running.tex", source: sourceBytes.toString("utf8") },
    {
      signal: runningCancellation.signal,
      spawnImpl: () => {
        queueMicrotask(() => runningCancellation.abort());
        return terminatingChild;
      },
    }
  ),
  (error) => error?.code === "ANALYSIS_CANCELLED" && error?.status === 499
);
assert.equal(terminatingChild.killCalls, 1, "a running cancelled sandbox reaches one proven SIGKILL close");

const nonTerminatingChild = new EventEmitter();
nonTerminatingChild.stdout = new PassThrough();
nonTerminatingChild.stderr = new PassThrough();
nonTerminatingChild.killCalls = 0;
nonTerminatingChild.unrefCalls = 0;
nonTerminatingChild.kill = () => { nonTerminatingChild.killCalls += 1; return true; };
nonTerminatingChild.unref = () => { nonTerminatingChild.unrefCalls += 1; };
const cancellation = new AbortController();
const nonTerminatingCompile = compileIntegrationTexDocument(
  { filename: "never-stops.tex", source: sourceBytes.toString("utf8") },
  { signal: cancellation.signal, spawnImpl: () => nonTerminatingChild }
);
setTimeout(() => cancellation.abort(), 25).unref?.();
await assert.rejects(
  nonTerminatingCompile,
  (error) => error?.code === "ANALYSIS_TEX_TERMINATION_UNPROVEN" && error?.status === 503
);
assert(nonTerminatingChild.killCalls >= 1);
assert.equal(nonTerminatingChild.unrefCalls, 1);

assert.equal((await validateIntegrationPdfBytes(validPdf)).valid, true);
assert.equal((await validateIntegrationPdfBytes(Buffer.from("%PDF-1.7\nnot a complete pdf".padEnd(96, "x")))).valid, false);
assert.equal((await validateIntegrationPdfBytes(Buffer.from("plain text".padEnd(96, "x")))).valid, false);
assert.equal((await validateIntegrationPdfBytes(structurallyPlausibleButInvalidPdf())).valid, false);

const absent = await evaluateIntegrationDocumentArtifactCompletion(intent, []);
assert.equal(absent.ok, false);
assert.deepEqual(absent.missingFormats, ["tex", "pdf"]);

const texOnly = await evaluateIntegrationDocumentArtifactCompletion(intent, [texArtifact]);
assert.equal(texOnly.ok, false);
assert.deepEqual(texOnly.missingFormats, ["tex", "pdf"], "an unpaired source has no compile relationship proof");

const fakePdf = await evaluateIntegrationDocumentArtifactCompletion(intent, [
  { filename: "report.tex", bytes: sourceBytes },
  { filename: "report.pdf", bytes: Buffer.from("%PDF-1.7\nnot a complete pdf".padEnd(96, "x")) },
]);
assert.equal(fakePdf.ok, false);
assert.deepEqual(fakePdf.missingFormats, ["tex", "pdf"]);
assert.equal(fakePdf.invalidPdfCount, 0, "unsealed byte fields are not completion evidence at all");

const sealedPdfBytes = inspectPrivateIntegrationFileArtifact(pdfArtifact).bytes;
const originalFirstByte = sealedPdfBytes[0];
let tampered;
try {
  sealedPdfBytes[0] ^= 0xff;
  tampered = await evaluateIntegrationDocumentArtifactCompletion(intent, [texArtifact, pdfArtifact]);
} finally {
  sealedPdfBytes[0] = originalFirstByte;
}
assert.equal(tampered.ok, false, "post-issuance PDF mutation invalidates the receipt relationship");
assert.deepEqual(tampered.missingFormats, ["tex", "pdf"]);

const complete = await evaluateIntegrationDocumentArtifactCompletion(intent, [texArtifact, pdfArtifact]);
assert.equal(complete.ok, true);
assert.deepEqual(complete.missingFormats, []);

const noIntent = await evaluateIntegrationDocumentArtifactCompletion(
  classifyIntegrationDocumentArtifactIntent("Explain PDF metadata."),
  []
);
assert.equal(noIntent.ok, true);
assert.equal(noIntent.checked, false);

console.log("integration document artifact smoke test passed");
