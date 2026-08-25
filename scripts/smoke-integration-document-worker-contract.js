import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  DOCUMENT_WORKER_ERROR_STATUS,
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
  deriveDocumentWorkerScopeDigests,
  documentWorkerErrorStatus,
  documentWorkerManifestDigest,
  publicDocumentWorkerErrorCode,
  validateDocumentWorkerCompileArtifacts,
  validateDocumentWorkerCompileRequest,
  validateDocumentWorkerDeleteRequest,
} from "../src/integration-document-worker-contract.js";
import { inspectIntegrationDocumentCompileRequirements } from "../src/integration-document-worker-requirements.js";
import { contractDigest } from "../src/integration-policy.js";
import {
  TEST_SCOPE,
  fixedRequestId,
  sha256,
  testCompileRequest,
  testRequirements,
} from "./fixtures/integration-document-worker-smoke-fixture.js";

function expectCode(operation, code) {
  assert.throws(operation, (error) => error?.code === code);
}

function objectRef(label) {
  return `wobj_${crypto.createHash("sha256").update(label).digest("base64url")}`;
}

const normalized = validateDocumentWorkerCompileRequest(testCompileRequest("contract"));
assert.equal(normalized.schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequest);
assert.equal(normalized.sourceSha256, sha256(Buffer.from(normalized.source, "utf8")));

const scopeDigests = deriveDocumentWorkerScopeDigests(TEST_SCOPE);
const ownerDigest = contractDigest({
  schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.owner,
  principalId: TEST_SCOPE.principalId,
  browserSessionId: TEST_SCOPE.browserSessionId,
});
const threadDigest = contractDigest({
  schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.thread,
  ownerDigest,
  threadId: TEST_SCOPE.threadId,
});
const runDigest = contractDigest({
  schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.run,
  threadDigest,
  runId: TEST_SCOPE.runId,
});
assert.deepEqual(scopeDigests, {
  ownerDigest,
  threadDigest,
  runDigest,
  scopeDigest: contractDigest({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.scope,
    ...TEST_SCOPE,
  }),
});

const figureSource = [
  "\\documentclass{article}",
  "\\usepackage{tikz}",
  "\\begin{document}",
  "\\begin{figure}",
  "  \\begin{tikzpicture}",
  "    \\draw (0,0) -- (1,1);",
  "  \\end{tikzpicture}",
  "\\end{figure}",
  "\\end{document}",
].join("\n");
const figureEvidence = inspectIntegrationDocumentCompileRequirements(figureSource, testRequirements(1));
assert.equal(figureEvidence.verifiedFigureCount, 1, "nested figure structures must not be double-counted");
expectCode(
  () => inspectIntegrationDocumentCompileRequirements(figureSource, testRequirements(2)),
  "TEX_REQUIREMENTS_UNSATISFIED"
);
expectCode(
  () => inspectIntegrationDocumentCompileRequirements(
    `${figureSource}\n\\begin{tikzpicture}`,
    testRequirements(1)
  ),
  "TEX_REQUIREMENTS_UNSATISFIED"
);
assert.equal(
  inspectIntegrationDocumentCompileRequirements(figureSource, testRequirements(1)).verifiedFigureCount,
  1,
  "a rejected unbalanced request must not leak RegExp cursor state into the next request"
);
expectCode(
  () => inspectIntegrationDocumentCompileRequirements(
    `${figureSource}\n\\includegraphics{host-secret.png}`,
    testRequirements(1)
  ),
  "TEX_EXTERNAL_ASSET_FORBIDDEN"
);
assert.equal(
  inspectIntegrationDocumentCompileRequirements(
    `${figureSource}\n% \\includegraphics{ignored-comment.png}`,
    testRequirements(1)
  ).verifiedFigureCount,
  1
);

const prefix = "\\documentclass{article}\n\\begin{document}\n";
const suffix = "\n\\end{document}\n";
const maximumSource = `${prefix}${"A".repeat(
  DOCUMENT_WORKER_LIMITS.maximumSourceBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
)}${suffix}`;
assert.equal(Buffer.byteLength(maximumSource), DOCUMENT_WORKER_LIMITS.maximumSourceBytes);
validateDocumentWorkerCompileRequest(testCompileRequest("source-max", { source: maximumSource }));
expectCode(
  () => validateDocumentWorkerCompileRequest(testCompileRequest("source-too-large", {
    source: `${maximumSource}X`,
  })),
  "INVALID_REQUEST"
);

validateDocumentWorkerCompileRequest(testCompileRequest("filename-max", {
  filename: `${"a".repeat(236)}.tex`,
}));
expectCode(
  () => validateDocumentWorkerCompileRequest(testCompileRequest("filename-too-large", {
    filename: `${"a".repeat(237)}.tex`,
  })),
  "INVALID_REQUEST"
);

const sourceArtifact = Object.freeze({
  ref: objectRef("source"),
  role: "source",
  filename: "document.tex",
  mime: "application/x-tex",
  bytes: DOCUMENT_WORKER_LIMITS.maximumSourceBytes,
  sha256: "1".repeat(64),
});
const pdfArtifact = Object.freeze({
  ref: objectRef("pdf"),
  role: "pdf",
  filename: "document.pdf",
  mime: "application/pdf",
  bytes: DOCUMENT_WORKER_LIMITS.maximumPdfBytes,
  sha256: "2".repeat(64),
});
validateDocumentWorkerCompileArtifacts([sourceArtifact, pdfArtifact]);
expectCode(
  () => validateDocumentWorkerCompileArtifacts([
    sourceArtifact,
    { ...pdfArtifact, bytes: DOCUMENT_WORKER_LIMITS.maximumPdfBytes + 1 },
  ]),
  "INVALID_REQUEST"
);
assert.match(documentWorkerManifestDigest([
  { ref: sourceArtifact.ref, role: "source", sha256: sourceArtifact.sha256 },
  { ref: pdfArtifact.ref, role: "pdf", sha256: pdfArtifact.sha256 },
]), /^[a-f0-9]{64}$/u);

const deleteObjects = Array.from({ length: DOCUMENT_WORKER_LIMITS.maximumDeleteObjects }, (_, index) => ({
  ref: objectRef(`delete-${String(index).padStart(4, "0")}`),
  runId: TEST_SCOPE.runId,
  receiptDigest: "3".repeat(64),
})).sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
const deleteRequest = {
  schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteRequest,
  deletionId: fixedRequestId("del_", "delete-cap"),
  phase: "prepare",
  scope: {
    principalId: TEST_SCOPE.principalId,
    browserSessionId: TEST_SCOPE.browserSessionId,
    threadId: TEST_SCOPE.threadId,
  },
  objects: deleteObjects,
};
assert.equal(validateDocumentWorkerDeleteRequest(deleteRequest).objects.length, 1024);
expectCode(
  () => validateDocumentWorkerDeleteRequest({
    ...deleteRequest,
    objects: [...deleteObjects, {
      ref: objectRef("delete-over-cap"),
      runId: TEST_SCOPE.runId,
      receiptDigest: "3".repeat(64),
    }].sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0),
  }),
  "INVALID_REQUEST"
);

for (const [code, status] of Object.entries(DOCUMENT_WORKER_ERROR_STATUS)) {
  assert.equal(publicDocumentWorkerErrorCode({ code }), code);
  assert.equal(documentWorkerErrorStatus({ code, status: 599 }), status);
}
assert.equal(publicDocumentWorkerErrorCode({ code: "LEAK_PRIVATE_FAILURE" }), "INTERNAL_ERROR");
assert.equal(documentWorkerErrorStatus({ code: "LEAK_PRIVATE_FAILURE", status: 418 }), 500);

process.stdout.write("integration document worker contract smoke passed\n");
