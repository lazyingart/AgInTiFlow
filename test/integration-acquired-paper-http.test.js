import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ACQUIRED_PAPER_MAXIMUM_BYTES, ACQUIRED_PAPER_ROUTES as ROUTES, ACQUIRED_PAPER_SCHEMA_VERSIONS as PAPER, validateAcquiredPaperReceipt } from "../src/integration-acquired-paper-contract.js";
import { ACQUIRED_PAPER_CONTENT_TYPE, ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES, ACQUIRED_PAPER_TRANSFER_TIMEOUT_MS, encodeAcquiredPaperFrame } from "../src/integration-acquired-paper-transfer.js";
import { FILE_WORKER_ROUTES as FILE_ROUTES, FILE_WORKER_SCHEMA_VERSIONS as FILE } from "../src/integration-file-worker-contract.js";
import { validateIntegrationDocumentWorkerConfig } from "../src/integration-document-worker-config.js";
import { inspectIntegrationFileWorkerArtifact } from "../src/integration-file-worker-client.js";
import { contractDigest } from "../src/integration-policy.js";
import { testDocumentWorkerConfig, TEST_BEARER_TOKEN } from "../scripts/fixtures/integration-document-worker-smoke-fixture.js";
import { scope, pdf, sha256, issueRequest, importRequest, commitRequest, contentRequest } from "./fixtures/acquired-paper.js";
import { createPaperHttpWorker } from "./fixtures/paper-worker.js";

async function fixture(t, options = {}) {
  const { server, port, fileStore, client } = await createPaperHttpWorker(t, options);
  function send(route, body, { headers = {}, token = TEST_BEARER_TOKEN, method = "POST" } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: route, method, agent: false,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": body.length, ...headers },
      }, response => {
        const chunks = [];
        response.on("error", reject);
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
      request.end(body);
    });
  }
  const json = (route, value, options) => send(route, Buffer.from(JSON.stringify(value)), options);
  async function issue(bytes) {
    const metadata = issueRequest(bytes);
    const response = await json(ROUTES.issue, metadata);
    assert.equal(response.status, 200);
    return importRequest(metadata, JSON.parse(response.body));
  }
  async function upload(metadata, bytes, options = {}) {
    const frame = encodeAcquiredPaperFrame(metadata, bytes);
    try { return await send(ROUTES.import, Buffer.concat(frame.chunks), { ...options, headers: { "content-type": ACQUIRED_PAPER_CONTENT_TYPE, ...options.headers } }); }
    finally { frame.dispose(); }
  }
  return { server, port, fileStore, send, json, issue, upload, client };
}

for (const length of [775166, ACQUIRED_PAPER_MAXIMUM_BYTES]) test(`${length}-byte paper crosses authenticated HTTP, commit, range read and deletion`, async t => {
  const f = await fixture(t);
  const bytes = pdf(length);
  const readiness = await f.json(ROUTES.readiness, { schemaVersion: PAPER.readinessRequest });
  assert.equal(readiness.status, 200);
  assert.equal(JSON.parse(readiness.body).creationEnabled, true);
  const request = await f.issue(bytes);
  const response = await f.upload(request, bytes);
  assert.equal(response.status, 200, response.body.toString());
  const imported = JSON.parse(response.body);
  validateAcquiredPaperReceipt(imported.receipt);
  assert.equal(imported.receipt.schemaVersion, PAPER.receipt);
  assert.equal((await f.json(FILE_ROUTES.content, contentRequest(imported))).status, 404);
  assert.equal((await f.json(FILE_ROUTES.commit, commitRequest(imported))).status, 200);
  const full = await f.json(FILE_ROUTES.content, contentRequest(imported));
  assert.equal(full.status, 200);
  assert.equal(sha256(full.body), sha256(bytes));
  assert.equal(full.headers["content-type"], "application/pdf");
  assert.match(full.headers["content-disposition"], /^attachment;/u);
  assert.equal(full.headers["x-content-type-options"], "nosniff");
  const range = await f.json(FILE_ROUTES.content, contentRequest(imported, { range: { start: 71, end: 777 } }));
  assert.equal(range.status, 206);
  assert.deepEqual(range.body, bytes.subarray(71, 778));
  const replay = await f.upload(request, bytes);
  assert.deepEqual(JSON.parse(replay.body), imported);
  assert.equal((await f.fileStore.inspect()).groups, 1);
  const { runId, ...threadScope } = scope;
  const deletion = { schemaVersion: FILE.deleteRequest, deletionId: `fdel_${sha256("delete" + length)}`, phase: "prepare", scope: threadScope,
    objects: [{ ref: imported.artifacts[0].ref, runId, receiptDigest: imported.receipt.digest }] };
  assert.equal((await f.json(FILE_ROUTES.delete, deletion)).status, 200);
  assert.equal((await f.json(FILE_ROUTES.delete, { ...deletion, phase: "commit" })).status, 200);
  assert.equal((await f.json(FILE_ROUTES.content, contentRequest(imported))).status, 410);
  assert.equal((await f.upload(request, bytes)).status, 410);
});

for (const options of [{ omitted: true }, { paperImport: false }, { creation: false }]) test(`paper import stays disabled for ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options);
  const readiness = await f.json(ROUTES.readiness, { schemaVersion: PAPER.readinessRequest });
  assert.equal(JSON.parse(readiness.body).creationEnabled, false);
  const bytes = pdf();
  assert.equal((await f.json(ROUTES.issue, issueRequest(bytes))).status, 503);
  assert.equal((await f.upload(importRequest(issueRequest(bytes)), bytes)).status, 503);
  assert.equal((await f.fileStore.inspect()).groups, 0);
});

test("transport requires bearer authentication and exact private routes", async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const metadata = importRequest(issueRequest(bytes));
  assert.equal((await f.upload(metadata, bytes, { token: "wrong-token-0123456789abcdefghijk" })).status, 401);
  for (const route of [ROUTES.import + "?x=1", ROUTES.import + "/", "/artifact/v1/papers/%69mport"]) {
    assert.equal((await f.send(route, Buffer.alloc(0))).status, 404);
  }
  assert.equal((await f.upload(metadata, bytes, { method: "GET" })).status, 404);
  assert.equal((await f.fileStore.inspect()).reservations, 0);
});

test("wrong account cannot import, commit or read a paper over HTTP", async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const metadata = await f.issue(bytes);
  const other = { ...scope, principalId: "principal.other-paper-owner" };
  assert.equal((await f.upload({ ...metadata, scope: other }, bytes)).status, 410);
  const imported = JSON.parse((await f.upload(metadata, bytes)).body);
  assert.equal((await f.json(FILE_ROUTES.commit, commitRequest(imported, other))).status, 404);
  assert.equal((await f.json(FILE_ROUTES.commit, commitRequest(imported))).status, 200);
  assert.equal((await f.json(FILE_ROUTES.content, contentRequest(imported, { scope: other }))).status, 404);
});

test("malformed framing, bad bytes, compression and oversize are rejected without staging", async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const metadata = await f.issue(bytes);
  const frame = encodeAcquiredPaperFrame(metadata, bytes);
  const body = Buffer.concat(frame.chunks); frame.dispose();
  const headers = { "content-type": ACQUIRED_PAPER_CONTENT_TYPE };
  const corrupt = Buffer.from(body); corrupt[corrupt.length - 20] = 1;
  assert.equal((await f.send(ROUTES.import, corrupt, { headers })).status, 400);
  const wrongMagic = Buffer.from(body); wrongMagic[0] = 0;
  assert.equal((await f.send(ROUTES.import, wrongMagic, { headers })).status, 400);
  assert.equal((await f.send(ROUTES.import, body.subarray(0, -1), { headers })).status, 400);
  assert.equal((await f.send(ROUTES.import, Buffer.concat([body, Buffer.from("x")]), { headers })).status, 400);
  assert.equal((await f.send(ROUTES.import, body, { headers: { ...headers, "content-encoding": "gzip" } })).status, 400);
  assert.equal((await f.send(ROUTES.import, body)).status, 400);
  assert.equal((await f.send(ROUTES.import, Buffer.alloc(0), { headers: { ...headers, "content-length": ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES + 1 } })).status, 413);
  assert.equal((await f.send(FILE_ROUTES.publish, Buffer.alloc(1024 * 1024 + 1, 32))).status, 413);
  assert.equal((await f.fileStore.inspect()).groups, 0);
});

test("one active binary upload is admitted and client cancellation releases its slot", async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const metadata = await f.issue(bytes);
  const frame = encodeAcquiredPaperFrame(metadata, bytes);
  const accepted = new Promise(resolve => f.server.server.once("request", resolve));
  const pending = http.request({ host: "127.0.0.1", port: f.port, path: ROUTES.import, method: "POST", agent: false,
    headers: { authorization: `Bearer ${TEST_BEARER_TOKEN}`, "content-type": ACQUIRED_PAPER_CONTENT_TYPE, "content-length": frame.byteLength } });
  pending.on("error", () => {});
  pending.write(frame.chunks[0]); pending.write(frame.chunks[1]); pending.write(frame.chunks[2].subarray(0, 100));
  await accepted;
  assert.equal((await f.upload(metadata, bytes)).status, 503);
  pending.destroy();
  await new Promise(resolve => pending.once("close", resolve));
  await new Promise(resolve => setImmediate(resolve));
  frame.dispose();
  assert.equal((await f.upload(metadata, bytes)).status, 200);
  assert.equal((await f.fileStore.inspect()).groups, 1);
});

test("a stalled HTTP upload reaches its real deadline and releases the slot", { timeout: 70_000 }, async t => {
  const f = await fixture(t);
  const bytes = pdf();
  const metadata = await f.issue(bytes);
  const frame = encodeAcquiredPaperFrame(metadata, bytes);
  assert.equal(ACQUIRED_PAPER_TRANSFER_TIMEOUT_MS, 60_000);
  const started = Date.now();
  const pending = http.request({ host: "127.0.0.1", port: f.port, path: ROUTES.import, method: "POST", agent: false,
    headers: { authorization: `Bearer ${TEST_BEARER_TOKEN}`, "content-type": ACQUIRED_PAPER_CONTENT_TYPE, "content-length": frame.byteLength } });
  pending.on("error", () => {});
  const closed = new Promise(resolve => pending.once("close", resolve));
  t.after(() => { pending.destroy(); frame.dispose(); });
  pending.write(frame.chunks[0]);
  await closed;
  assert(Date.now() - started >= ACQUIRED_PAPER_TRANSFER_TIMEOUT_MS - 1000);
  assert.equal((await f.fileStore.inspect()).groups, 0);
  assert.equal((await f.upload(metadata, bytes)).status, 200);
});

test("paper config is explicit and cannot inject limits, URLs, or permissions", () => {
  const base = testDocumentWorkerConfig(true);
  assert.deepEqual(validateIntegrationDocumentWorkerConfig(base), base);
  for (const paperImport of [true, null, {}, { enabled: "true" }, { enabled: true, maximumBytes: 999 }, { enabled: true, allowedOrigins: ["https://example.org"] }]) {
    assert.throws(() => validateIntegrationDocumentWorkerConfig({ ...base, paperImport }));
  }
});

test("the real file-worker client imports and commits a paper with a distinct profile", async t => {
  const f = await fixture(t);
  const client = f.client();
  assert.equal((await client.paperReadiness()).creationEnabled, true);
  const bytes = pdf(ACQUIRED_PAPER_MAXIMUM_BYTES);
  const issue = issueRequest(bytes);
  const authority = await client.issuePaper(issue);
  const request = importRequest(issue, authority);
  const imported = await client.importPaper(request, bytes);
  assert.equal(imported.artifacts.length, 1);
  const artifact = imported.artifacts[0];
  const metadata = inspectIntegrationFileWorkerArtifact(artifact);
  assert.equal(metadata.profile, "acquired-paper-v1");
  const content = { ...artifact.spec, ref: metadata.workerRef, receiptDigest: imported.receipt.digest, metadataOnly: false };
  delete content.schemaVersion;
  await assert.rejects(client.content(scope, content), error => error.code === "FILE_WORKER_INVALID");
  const paperContent = { ...content, profile: metadata.profile };
  assert.equal((await client.content(scope, paperContent)).status, 404);
  assert.equal((await client.commitArtifacts(scope, { receiptDigest: imported.receipt.digest, artifacts: imported.artifacts })).status, "committed");
  const stream = await client.content(scope, paperContent);
  try { assert.deepEqual(Buffer.from(await new Response(stream.body).arrayBuffer()), bytes); }
  finally { stream.cleanup(); }
  const replay = await client.importPaper(request, bytes);
  assert.equal(replay.receipt.digest, imported.receipt.digest);
  const { runId, ...threadScope } = scope;
  const deletion = { deletionId: `fdel_${sha256("client-paper")}`, phase: "prepare", objects: [{ ref: metadata.workerRef, runId, receiptDigest: imported.receipt.digest }] };
  await client.deleteObjects(threadScope, deletion);
  await client.deleteObjects(threadScope, { ...deletion, phase: "commit" });
  assert.equal((await client.content(scope, paperContent)).status, 410);
});

test("client retries the original issuance and import after lost responses", async t => {
  const f = await fixture(t);
  let drop = ROUTES.issue;
  const client = f.client(async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith(drop) && drop) {
      await response.arrayBuffer(); drop = ""; throw new Error("controlled lost response");
    }
    return response;
  });
  const bytes = pdf();
  const issue = issueRequest(bytes);
  await assert.rejects(client.issuePaper(issue), error => error.code === "ANALYSIS_FILE_WORKER_UNAVAILABLE");
  const authority = await client.issuePaper(issue);
  assert.equal((await f.fileStore.inspect()).reservations, 1);
  const request = importRequest(issue, authority);
  drop = ROUTES.import;
  await assert.rejects(client.importPaper(request, bytes), error => error.code === "ANALYSIS_FILE_WORKER_UNAVAILABLE");
  const imported = await client.importPaper(request, bytes);
  assert.equal((await f.fileStore.inspect()).groups, 1);
  assert.equal(imported.artifacts[0].spec.sha256, sha256(bytes));
});

test("client rejects a re-digested receipt bound to another scope", async t => {
  const f = await fixture(t);
  const client = f.client(async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith(ROUTES.import)) return response;
    const value = await response.json();
    value.receipt.scopeDigest = "7".repeat(64);
    const { digest: _digest, ...unsigned } = value.receipt;
    value.receipt.digest = contractDigest(unsigned);
    return Response.json(value);
  });
  const bytes = pdf();
  const issue = issueRequest(bytes);
  const request = importRequest(issue, await client.issuePaper(issue));
  await assert.rejects(client.importPaper(request, bytes), error => error.code === "FILE_WORKER_PROTOCOL_INVALID");
});

test("client bounds JSON response streaming even without a Content-Length header", async t => {
  const f = await fixture(t);
  let cancelled = false;
  const client = f.client(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(client.paperReadiness(), error => error.code === "FILE_WORKER_PROTOCOL_INVALID");
  assert.equal(cancelled, true);
});
