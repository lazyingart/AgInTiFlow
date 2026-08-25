import assert from "node:assert/strict";

import { testRequirements } from "./fixtures/integration-document-worker-smoke-fixture.js";
import { inspectIntegrationDocumentCompileRequirements } from "../src/integration-document-worker-requirements.js";
import {
  compileIntegrationTexWorkerPayload,
  inspectIntegrationTexCompilerRuntime,
  validateIntegrationTexCompileReceipt,
} from "../src/integration-tex-compiler.js";

const source = [
  "\\documentclass{article}",
  "\\usepackage{tikz}",
  "\\begin{document}",
  "\\begin{figure}",
  "\\centering",
  "\\begin{tikzpicture}",
  "  \\draw[->] (0,0) -- (2,0);",
  "  \\draw[->] (0,0) -- (0,2);",
  "  \\draw[thick] (0,0) -- (1.5,1.2);",
  "\\end{tikzpicture}",
  "\\caption{Self-contained worker activation figure}",
  "\\end{figure}",
  "\\end{document}",
  "",
].join("\n");

const evidence = inspectIntegrationDocumentCompileRequirements(source, testRequirements(1));
assert.equal(evidence.verifiedFigureCount, 1);
const runtime = await inspectIntegrationTexCompilerRuntime();
assert.equal(runtime.ready, true);
assert.equal(runtime.networkNone, true);
assert.equal(runtime.shellEscape, false);
assert.match(runtime.runtimeDigest, /^[a-f0-9]{64}$/u);
assert.match(runtime.activationProbeDigest, /^[a-f0-9]{64}$/u);

const compiled = await compileIntegrationTexWorkerPayload({
  filename: "worker-real-figure.tex",
  source,
});
try {
  const receipt = validateIntegrationTexCompileReceipt(compiled.compilerReceipt);
  assert.equal(receipt.networkNone, true);
  assert.equal(receipt.shellEscape, false);
  assert.equal(compiled.source.mime, "application/x-tex");
  assert.equal(compiled.pdf.mime, "application/pdf");
  assert.deepEqual(compiled.source.bytes, Buffer.from(source, "utf8"));
  assert.equal(compiled.pdf.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(compiled.pdf.bytes.byteLength, receipt.pdfBytes);
  assert.equal(compiled.source.bytes.byteLength, receipt.sourceBytes);
  assert.ok(!Object.hasOwn(compiled.source, "path"));
  assert.ok(!Object.hasOwn(compiled.pdf, "path"));
} finally {
  compiled.source.bytes.fill(0);
  compiled.pdf.bytes.fill(0);
}

process.stdout.write("integration document worker real compile smoke passed\n");
