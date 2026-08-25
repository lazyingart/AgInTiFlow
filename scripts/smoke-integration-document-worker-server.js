import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_ROUTES,
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
} from "../src/integration-document-worker-contract.js";
import {
  DOCUMENT_WORKER_LISTEN_HOST,
  DOCUMENT_WORKER_LISTEN_PORT,
} from "../src/integration-document-worker-config.js";
import { createIntegrationDocumentWorkerServer } from "../src/integration-document-worker-server.js";
import { createTestOnlyIntegrationDocumentWorkerService } from "../src/integration-document-worker-service.js";
import { openIntegrationDocumentWorkerStore } from "../src/integration-document-worker-store.js";
import {
  TEST_BEARER_TOKEN,
  TEST_SCOPE,
  fakeCompiledPayload,
  testCommitRequest,
  testCompileRequest,
  testContentRequest,
  testDeleteRequest,
  testDocumentWorkerConfig,
  testEvidence,
} from "./fixtures/integration-document-worker-smoke-fixture.js";

function requestBytes(route, bytes, { token = TEST_BEARER_TOKEN, method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      host: DOCUMENT_WORKER_LISTEN_HOST,
      port: DOCUMENT_WORKER_LISTEN_PORT,
      path: route,
      method,
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(bytes.byteLength),
        "content-type": "application/json; charset=utf-8",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        settled = true;
        resolve(Object.freeze({
          status: response.statusCode,
          headers: Object.freeze({ ...response.headers }),
          body: Buffer.concat(chunks),
        }));
      });
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(bytes);
  });
}

function requestJson(route, value, options) {
  return requestBytes(route, Buffer.from(JSON.stringify(value), "utf8"), options);
}

function slowRejectedRequest(route, { token = TEST_BEARER_TOKEN, declaredBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: DOCUMENT_WORKER_LISTEN_HOST, port: DOCUMENT_WORKER_LISTEN_PORT });
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("rejected request body kept the connection pinned"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write([
        `POST ${route} HTTP/1.1`,
        `Host: ${DOCUMENT_WORKER_LISTEN_HOST}:${DOCUMENT_WORKER_LISTEN_PORT}`,
        `Authorization: Bearer ${token}`,
        "Content-Type: application/json; charset=utf-8",
        `Content-Length: ${declaredBytes}`,
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, Buffer.from(chunk)]);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Object.freeze({ text: response.toString("latin1"), elapsedMs: Date.now() - startedAt }));
    });
  });
}

function parsedJson(result) {
  return JSON.parse(result.body.toString("utf8"));
}

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-server-"));
let server;
try {
  const store = await openIntegrationDocumentWorkerStore({ stateRoot });
  const compileRequest = testCompileRequest("server-floor");
  const compiled = fakeCompiledPayload(compileRequest, "server-floor");
  const staged = await store.stageCompile({
    request: compileRequest,
    evidence: testEvidence(compileRequest),
    compiled,
  });
  await store.commit(testCommitRequest(staged, TEST_SCOPE, "server-floor"));
  const config = testDocumentWorkerConfig(false);
  let canaryCalls = 0;
  const service = createTestOnlyIntegrationDocumentWorkerService({
    config,
    store,
    inspectRuntimeImpl: async () => {
      canaryCalls += 1;
      return Object.freeze({
        ready: true,
        networkNone: true,
        shellEscape: false,
        runtimeDigest: "6".repeat(64),
        activationProbeDigest: "7".repeat(64),
      });
    },
  });
  server = createIntegrationDocumentWorkerServer({
    config,
    service,
    bearerToken: TEST_BEARER_TOKEN,
  });
  const checked = await server.check();
  assert.equal(checked.creationEnabled, false);
  assert.equal(checked.compiler, null);
  assert.equal(canaryCalls, 1, "server.check must execute the disabled-floor compiler canary");
  assert.deepEqual(await server.start(), {
    address: DOCUMENT_WORKER_LISTEN_HOST,
    port: DOCUMENT_WORKER_LISTEN_PORT,
    family: "IPv4",
  });
  assert.equal(canaryCalls, 1, "server startup must reuse the successful exact check");

  const readiness = await requestJson(DOCUMENT_WORKER_ROUTES.readiness, {
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.readinessRequest,
  });
  assert.equal(readiness.status, 200);
  assert.equal(parsedJson(readiness).schemaVersion, DOCUMENT_WORKER_SCHEMA_VERSIONS.readinessResponse);
  assert.equal(parsedJson(readiness).creationEnabled, false);
  assert.equal(parsedJson(readiness).compiler, null);
  assert.equal(readiness.headers["cache-control"], "no-store");
  assert.equal(readiness.headers["x-content-type-options"], "nosniff");

  const disabledCompile = await requestJson(DOCUMENT_WORKER_ROUTES.compile, compileRequest);
  assert.equal(disabledCompile.status, 503);
  assert.equal(disabledCompile.body.toString("utf8"), '{"error":{"code":"WORKER_CREATION_DISABLED"}}\n');

  const contentRequest = testContentRequest(staged, "pdf");
  const content = await requestJson(DOCUMENT_WORKER_ROUTES.content, contentRequest);
  assert.equal(content.status, 200);
  assert.deepEqual(content.body, compiled.pdf.bytes);
  assert.equal(content.headers["accept-ranges"], "bytes");
  assert.equal(content.headers["cache-control"], "no-store, private");
  assert.equal(content.headers["content-type"], "application/pdf");
  assert.equal(content.headers["content-length"], String(compiled.pdf.bytes.byteLength));
  assert.equal(content.headers.etag, `"${compiled.pdf.sha256}"`);
  assert.equal(content.headers["x-content-type-options"], "nosniff");
  assert.match(content.headers["content-disposition"], /^attachment;/u);

  const metadata = await requestJson(DOCUMENT_WORKER_ROUTES.content, testContentRequest(staged, "pdf", {
    metadataOnly: true,
    range: { start: 3 },
  }));
  assert.equal(metadata.status, 206);
  assert.equal(metadata.body.byteLength, 0);
  assert.equal(metadata.headers["content-length"], "0");
  assert.equal(
    metadata.headers["x-artifact-content-length"],
    String(compiled.pdf.bytes.byteLength - 3)
  );
  assert.equal(metadata.headers["content-range"], `bytes 3-${compiled.pdf.bytes.byteLength - 1}/${compiled.pdf.bytes.byteLength}`);

  const unsatisfiable = await requestJson(DOCUMENT_WORKER_ROUTES.content, testContentRequest(staged, "pdf", {
    range: { start: compiled.pdf.bytes.byteLength },
  }));
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers["content-range"], `bytes */${compiled.pdf.bytes.byteLength}`);
  assert.equal(unsatisfiable.body.toString("utf8"), '{"error":{"code":"RANGE_NOT_SATISFIABLE"}}\n');

  const ownerMismatch = await requestJson(DOCUMENT_WORKER_ROUTES.content, testContentRequest(staged, "pdf", {
    scope: { ...TEST_SCOPE, browserSessionId: "b".repeat(64) },
  }));
  assert.equal(ownerMismatch.status, 404);

  for (const invalidUtf8 of [
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xe2, 0x82]),
  ]) {
    const body = Buffer.concat([
      Buffer.from('{"schemaVersion":"', "utf8"),
      invalidUtf8,
      Buffer.from('"}', "utf8"),
    ]);
    const rejected = await requestBytes(DOCUMENT_WORKER_ROUTES.readiness, body);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.toString("utf8"), '{"error":{"code":"INVALID_REQUEST"}}\n');
  }
  const bom = await requestBytes(
    DOCUMENT_WORKER_ROUTES.readiness,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"schemaVersion":"aginti-document-worker-readiness-request-v1"}', "utf8"),
    ])
  );
  assert.equal(bom.status, 400);
  const duplicateKey = await requestBytes(
    DOCUMENT_WORKER_ROUTES.readiness,
    Buffer.from('{"schemaVersion":"aginti-document-worker-readiness-request-v1","schemaVersion":"aginti-document-worker-readiness-request-v1"}', "utf8")
  );
  assert.equal(duplicateKey.status, 400);

  const unauthorized = await slowRejectedRequest(DOCUMENT_WORKER_ROUTES.readiness, {
    token: "wrong-document-worker-token-0123456789abcdef",
  });
  assert.match(unauthorized.text, /^HTTP\/1\.1 401 /u);
  assert.match(unauthorized.text, /Connection: close/iu);
  assert.ok(unauthorized.elapsedMs < 2_000);
  const unknownPath = await slowRejectedRequest("/artifact/v1/unknown");
  assert.match(unknownPath.text, /^HTTP\/1\.1 404 /u);
  assert.match(unknownPath.text, /Connection: close/iu);
  const oversized = await slowRejectedRequest(DOCUMENT_WORKER_ROUTES.readiness, {
    declaredBytes: DOCUMENT_WORKER_LIMITS.maximumRequestBytes + 1,
  });
  assert.match(oversized.text, /^HTTP\/1\.1 413 /u);
  assert.match(oversized.text, /Connection: close/iu);

  const deletion = testDeleteRequest(staged, "prepare", "server-floor");
  const prepared = await requestJson(DOCUMENT_WORKER_ROUTES.delete, deletion);
  assert.equal(prepared.status, 200);
  assert.equal(parsedJson(prepared).status, "prepared");
  const committedDelete = await requestJson(DOCUMENT_WORKER_ROUTES.delete, { ...deletion, phase: "commit" });
  assert.equal(committedDelete.status, 200);
  assert.equal(parsedJson(committedDelete).status, "committed");
  const gone = await requestJson(DOCUMENT_WORKER_ROUTES.content, contentRequest);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.toString("utf8"), '{"error":{"code":"ARTIFACT_CONTENT_GONE"}}\n');
} finally {
  await server?.close().catch(() => {});
  await fs.rm(stateRoot, { recursive: true, force: true });
}

process.stdout.write("integration document worker server smoke passed\n");
