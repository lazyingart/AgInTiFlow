import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { writeIntegrationArtifactContentResponse } from "../src/integration-api.js";
import {
  compareIntegrationDocumentWorkerCodeUnits,
  inspectIntegrationDocumentWorkerFileArtifact,
} from "../src/integration-document-worker-client.js";
import { createDocumentWorkerFixture, compileRequirements } from "./test-document-worker-fixture.js";

const scope = Object.freeze({
  principalId: "principal_document_content_smoke_001",
  browserSessionId: "8".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000211",
  runId: "run_00000000-0000-4000-8000-000000000212",
});
const worker = createDocumentWorkerFixture();
const client = worker.client();
const compiled = await client.compile(scope, {
  filename: "streamed.tex",
  source: "\\documentclass{article}\n\\begin{document}streamed\\end{document}\n",
  requirements: compileRequirements(),
});
await client.commitArtifacts(scope, { receiptDigest: compiled.receipt.digest, artifacts: compiled.artifacts });
const pdf = compiled.artifacts[1];
const privatePdf = inspectIntegrationDocumentWorkerFileArtifact(pdf);

function contentInput(extra = {}) {
  return {
    ref: privatePdf.workerRef,
    receiptDigest: compiled.receipt.digest,
    filename: pdf.spec.filename,
    mime: pdf.spec.mime,
    bytes: pdf.spec.bytes,
    sha256: pdf.spec.sha256,
    metadataOnly: false,
    ...extra,
  };
}

const full = await client.content(scope, contentInput());
assert.equal(full.status, 200);
assert.equal(full.start, 0);
assert.equal(full.end, pdf.spec.bytes - 1);
const fullBytes = Buffer.from(await new Response(full.body).arrayBuffer());
full.cleanup();
assert.equal(fullBytes.byteLength, pdf.spec.bytes);

const partial = await client.content(scope, contentInput({ range: { start: 1, end: 8 } }));
assert.equal(partial.status, 206);
assert.deepEqual([partial.start, partial.end], [1, 8]);
assert.equal(Buffer.from(await new Response(partial.body).arrayBuffer()).byteLength, 8);
partial.cleanup();

const metadata = await client.content(scope, contentInput({ metadataOnly: true, range: { start: 2, end: 4 } }));
assert.equal(metadata.status, 206);
assert.equal(metadata.body, null);
assert.equal(metadata.selectedBytes, 3);

const unsatisfied = await client.content(scope, contentInput({ range: { start: pdf.spec.bytes } }));
assert.equal(unsatisfied.status, 416);
const crossScope = await client.content(
  { ...scope, browserSessionId: "9".repeat(64) },
  contentInput()
);
assert.equal(crossScope.status, 404, "cross-browser and unknown worker refs are indistinguishable");

const mixedBase64UrlRefs = ["a", "_", "A", "-", "0"].map(
  (prefix) => `wobj_${prefix}${"z".repeat(42)}`
);
assert.deepEqual(
  [...mixedBase64UrlRefs].sort(compareIntegrationDocumentWorkerCodeUnits),
  ["-", "0", "A", "_", "a"].map((prefix) => `wobj_${prefix}${"z".repeat(42)}`),
  "worker manifests use raw JavaScript/code-unit ordering, not locale collation"
);
const mixedObjects = mixedBase64UrlRefs
  .map((ref) => ({ ref, runId: scope.runId, receiptDigest: compiled.receipt.digest }))
  .sort((left, right) => compareIntegrationDocumentWorkerCodeUnits(left.ref, right.ref));
assert.equal((await client.deleteObjects(
  { principalId: scope.principalId, browserSessionId: scope.browserSessionId, threadId: scope.threadId },
  { deletionId: `del_${"f".repeat(64)}`, phase: "prepare", objects: mixedObjects }
)).status, "prepared");

class CaptureResponse extends Writable {
  constructor(options = {}) {
    super(options);
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
  }
  status(value) { this.statusCode = value; return this; }
  set(value) { Object.assign(this.headers, value); return this; }
  setHeader(name, value) { this.headers[name] = value; return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
}

const apiContent = await client.content(scope, contentInput({ range: { start: 0, end: 6 } }));
const response = new CaptureResponse();
await writeIntegrationArtifactContentResponse(response, {
  schemaVersion: "aginti-artifact-content-v1",
  artifactId: `art_${"a".repeat(64)}`,
  filename: pdf.spec.filename,
  mime: pdf.spec.mime,
  totalBytes: pdf.spec.bytes,
  sha256: pdf.spec.sha256,
  start: apiContent.start,
  end: apiContent.end,
  partial: apiContent.start !== 0 || apiContent.end !== pdf.spec.bytes - 1,
  metadataOnly: false,
  body: apiContent.body,
  cleanup: apiContent.cleanup,
}, { rangeRequested: true });
assert.equal(response.statusCode, 206);
assert.equal(response.headers["Cache-Control"], "no-store, private");
assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
assert.equal(response.headers["Content-Range"], `bytes 0-6/${pdf.spec.bytes}`);
assert.equal(Buffer.concat(response.chunks).byteLength, 7);

class SlowBackpressureResponse extends CaptureResponse {
  constructor({ closeAfterFirst = false } = {}) {
    super({ highWaterMark: 1 });
    this.closeAfterFirst = closeAfterFirst;
    this.drainCount = 0;
    this.on("drain", () => { this.drainCount += 1; });
    this.on("error", () => {});
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    setTimeout(() => {
      if (this.closeAfterFirst && this.chunks.length === 1) this.emit("close");
      callback();
    }, 2);
  }
}

function chunkedStream(bytes, { truncate = false } = {}) {
  const selected = truncate ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
  const chunks = [];
  for (let index = 0; index < selected.byteLength; index += 3) {
    chunks.push(selected.subarray(index, Math.min(index + 3, selected.byteLength)));
  }
  let index = 0;
  let cancelCount = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[index]));
      index += 1;
    },
    cancel() { cancelCount += 1; },
  }, { highWaterMark: 0 });
  return Object.freeze({ body, cancelCount: () => cancelCount });
}

let cleanupCount = 0;
const backpressureBody = chunkedStream(fullBytes);
const backpressureResponse = new SlowBackpressureResponse();
await writeIntegrationArtifactContentResponse(backpressureResponse, {
  schemaVersion: "aginti-artifact-content-v1",
  artifactId: `art_${"b".repeat(64)}`,
  filename: pdf.spec.filename,
  mime: pdf.spec.mime,
  totalBytes: pdf.spec.bytes,
  sha256: pdf.spec.sha256,
  start: 0,
  end: pdf.spec.bytes - 1,
  partial: false,
  metadataOnly: false,
  body: backpressureBody.body,
  cleanup() { cleanupCount += 1; },
});
assert.equal(Buffer.concat(backpressureResponse.chunks).equals(fullBytes), true);
assert(backpressureResponse.drainCount > 0, "stream writer must resume through actual drain backpressure");
assert.equal(backpressureBody.cancelCount(), 0);
assert.equal(cleanupCount, 1);

cleanupCount = 0;
const closingBody = chunkedStream(fullBytes);
const closingResponse = new SlowBackpressureResponse({ closeAfterFirst: true });
await assert.rejects(
  writeIntegrationArtifactContentResponse(closingResponse, {
    schemaVersion: "aginti-artifact-content-v1",
    artifactId: `art_${"c".repeat(64)}`,
    filename: pdf.spec.filename,
    mime: pdf.spec.mime,
    totalBytes: pdf.spec.bytes,
    sha256: pdf.spec.sha256,
    start: 0,
    end: pdf.spec.bytes - 1,
    partial: false,
    metadataOnly: false,
    body: closingBody.body,
    cleanup() { cleanupCount += 1; },
  }),
  /artifact response closed/u
);
assert(closingBody.cancelCount() >= 1, "closed responses must cancel the upstream body");
assert.equal(cleanupCount, 1, "closed responses must release the upstream exactly once");

cleanupCount = 0;
const truncatedBody = chunkedStream(fullBytes, { truncate: true });
const truncatedResponse = new CaptureResponse();
truncatedResponse.on("error", () => {});
await assert.rejects(
  writeIntegrationArtifactContentResponse(truncatedResponse, {
    schemaVersion: "aginti-artifact-content-v1",
    artifactId: `art_${"d".repeat(64)}`,
    filename: pdf.spec.filename,
    mime: pdf.spec.mime,
    totalBytes: pdf.spec.bytes,
    sha256: pdf.spec.sha256,
    start: 0,
    end: pdf.spec.bytes - 1,
    partial: false,
    metadataOnly: false,
    body: truncatedBody.body,
    cleanup() { cleanupCount += 1; },
  }),
  (error) => error?.code === "INTERNAL_ERROR" && /integrity validation/u.test(error.message)
);
assert.equal(cleanupCount, 1, "truncated streams must release their upstream exactly once");

const deletionId = `del_${"e".repeat(64)}`;
const deleteScope = { principalId: scope.principalId, browserSessionId: scope.browserSessionId, threadId: scope.threadId };
const objects = compiled.artifacts
  .map((artifact) => {
    const metadata = inspectIntegrationDocumentWorkerFileArtifact(artifact);
    return { ref: metadata.workerRef, runId: scope.runId, receiptDigest: compiled.receipt.digest };
  })
  .sort((left, right) => compareIntegrationDocumentWorkerCodeUnits(left.ref, right.ref));
assert.equal((await client.deleteObjects(deleteScope, { deletionId, phase: "prepare", objects })).status, "prepared");
assert.equal((await client.deleteObjects(deleteScope, { deletionId, phase: "commit", objects })).status, "committed");
assert.equal((await client.content(scope, contentInput())).status, 410);

worker.setAvailable(false);
await assert.rejects(
  () => client.content(scope, contentInput()),
  (error) => error.code === "ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE" && error.status === 503
);

console.log("integration document content broker smoke passed");
