import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import {
  createTestOnlyIntegrationDocumentWorkerService,
} from "../src/integration-document-worker-service.js";
import { openIntegrationDocumentWorkerStore } from "../src/integration-document-worker-store.js";
import {
  INTEGRATION_FILE_WORKER_INTENT_CANDIDATE_SCHEMA_VERSION,
  INTEGRATION_FILE_WORKER_ISSUE_INTENT_SCHEMA_VERSION,
  createTestOnlyIntegrationFileWorkerClient,
  inspectIntegrationFileWorkerArtifact,
} from "../src/integration-file-worker-client.js";
import { FILE_WORKER_ROUTES, createFileWorkerIssuanceId } from "../src/integration-file-worker-contract.js";
import { openIntegrationFileWorkerStore } from "../src/integration-file-worker-store.js";
import {
  TEST_BEARER_TOKEN,
  TEST_SCOPE,
  TEST_THREAD_SCOPE,
  sha256,
  testDocumentWorkerConfig,
} from "./fixtures/integration-document-worker-smoke-fixture.js";

const roots = [];
let service;
try {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-worker-client-"));
  roots.push(parent);
  const documentStore = await openIntegrationDocumentWorkerStore({ stateRoot: path.join(parent, "documents") });
  const fileStore = await openIntegrationFileWorkerStore({ stateRoot: path.join(parent, "files") });
  service = createTestOnlyIntegrationDocumentWorkerService({
    config: testDocumentWorkerConfig(true),
    store: documentStore,
    fileStore,
    inspectRuntimeImpl: async () => Object.freeze({
      ready: true,
      networkNone: true,
      shellEscape: false,
      runtimeDigest: sha256(Buffer.from("file-worker-test-runtime", "utf8")),
      activationProbeDigest: sha256(Buffer.from("file-worker-test-canary", "utf8")),
    }),
  });
  await service.activate();
  const disposition = (filename) => {
    const fallback = filename.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 120) || "artifact";
    const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  };
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    const request = JSON.parse(init.body);
    try {
      if (pathname === FILE_WORKER_ROUTES.readiness) {
        return Response.json(await service.fileReadiness(request), { status: 200 });
      }
      if (pathname === FILE_WORKER_ROUTES.issue) {
        return Response.json(await service.issueFiles(request), { status: 200 });
      }
      if (pathname === FILE_WORKER_ROUTES.publish) {
        return Response.json(await service.publishFiles(request), { status: 200 });
      }
      if (pathname === FILE_WORKER_ROUTES.commit) {
        return Response.json(await service.commitFiles(request), { status: 200 });
      }
      if (pathname === FILE_WORKER_ROUTES.delete) {
        return Response.json(await service.deleteFiles(request), { status: 200 });
      }
      if (pathname === FILE_WORKER_ROUTES.content) {
        const result = await service.fileContent(request);
        const { metadata } = result;
        const chunks = [];
        if (result.stream) for await (const chunk of result.stream) chunks.push(chunk);
        await result.release();
        const bytes = Buffer.concat(chunks);
        return new Response(metadata.metadataOnly ? null : bytes, {
          status: metadata.partial ? 206 : 200,
          headers: {
            "accept-ranges": "bytes",
            "cache-control": "no-store, private",
            "content-disposition": disposition(metadata.filename),
            "content-length": metadata.metadataOnly ? "0" : String(metadata.selectedBytes),
            "content-type": metadata.mime,
            etag: `"${metadata.sha256}"`,
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            ...(metadata.metadataOnly ? { "x-artifact-content-length": String(metadata.selectedBytes) } : {}),
            ...(metadata.partial ? { "content-range": `bytes ${metadata.start}-${metadata.end}/${metadata.totalBytes}` } : {}),
          },
        });
      }
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    } catch (error) {
      return Response.json({ error: { code: error?.code || "INTERNAL_ERROR" } }, {
        status: Number(error?.status || 500),
      });
    }
  };
  const client = createTestOnlyIntegrationFileWorkerClient({
    endpoint: "http://127.0.0.1:18121",
    credential: TEST_BEARER_TOKEN,
    fetchImpl,
  });
  const activation = await client.activate();
  assert.equal(activation.ready, true);
  assert.equal(activation.cloudBytePersistence, false);

  const sessionStateRoot = path.join(parent, "session");
  const sessionContext = Object.freeze({
    principalId: "principal-file-worker-session-smoke",
    browserSessionId: "e".repeat(64),
  });
  const privateMarker = "CLOUD_MUST_NOT_PERSIST_GENERAL_FILE_BYTES_b32f81";
  const sessionRunner = Object.freeze({
    async run(scope, _input, options) {
      const bundle = await client.publish(scope, {
        files: Object.freeze([
          Object.freeze({
            filename: "results.csv",
            mime: "text/csv",
            content: `name,value\n${privateMarker},42\n`,
          }),
          Object.freeze({
            filename: "notes.md",
            mime: "text/markdown",
            content: "# Verified notes\n\nTwo local files were committed.\n",
          }),
        ]),
      }, { signal: options.signal, authorizeRequest: options.onFilePublishIntent });
      for (const artifact of bundle.artifacts) await options.onArtifact?.(artifact);
      await options.onFileCommitIntent?.(bundle.artifacts);
      await client.commitArtifacts(scope, {
        receiptDigest: bundle.receipt.digest,
        artifacts: bundle.artifacts,
      }, { signal: options.signal });
      const result = Object.freeze({
        schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
        text: "The verified files are ready.",
        kind: "analysis",
        toolCalls: 1,
        executionStatus: "succeeded",
        artifacts: bundle.artifacts,
      });
      await options.onFinal?.(result);
      return result;
    },
  });
  let session = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: sessionRunner,
    stateRoot: sessionStateRoot,
    fileWorkerClient: client,
    fileWorkerEnabled: true,
  });
  const thread = await session.createThread({ title: "General file session" }, sessionContext);
  const started = await session.startRun({
    threadId: thread.thread.id,
    input: { text: "Create a CSV and Markdown file." },
  }, sessionContext);
  await session.waitForIdle();
  assert.equal((await session.getRunStatus({ runId: started.run.id }, sessionContext)).run.status, "completed");
  const sessionFiles = (await session.listArtifacts({ runId: started.run.id }, sessionContext)).artifacts;
  assert.deepEqual(sessionFiles.map(({ spec }) => spec.mime), ["text/csv", "text/markdown"]);
  const scopeEntries = await fs.readdir(path.join(sessionStateRoot, "scopes"));
  assert.equal(scopeEntries.length, 1);
  const persisted = await fs.readFile(path.join(sessionStateRoot, "scopes", scopeEntries[0], "state.json"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(privateMarker, "u"));
  assert.doesNotMatch(persisted, new RegExp(Buffer.from(privateMarker, "utf8").toString("base64"), "u"));
  const streamed = await session.getArtifactContent({ artifactId: sessionFiles[0].id }, sessionContext);
  const streamedReader = streamed.body.getReader();
  const streamedChunks = [];
  for (;;) {
    const chunk = await streamedReader.read();
    if (chunk.done) break;
    streamedChunks.push(Buffer.from(chunk.value));
  }
  streamedReader.releaseLock();
  streamed.cleanup();
  assert.match(Buffer.concat(streamedChunks).toString("utf8"), new RegExp(privateMarker, "u"));
  await assert.rejects(
    session.getArtifactContent({ artifactId: sessionFiles[0].id }, {
      ...sessionContext,
      browserSessionId: "f".repeat(64),
    }),
    (error) => error?.status === 404
  );
  await session.close({ mode: "wait" });
  session = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: sessionRunner,
    stateRoot: sessionStateRoot,
    fileWorkerClient: client,
    fileWorkerEnabled: true,
  });
  assert.equal((await session.getArtifact({ artifactId: sessionFiles[0].id }, sessionContext)).artifact.id, sessionFiles[0].id);
  assert.equal((await session.deleteThread({ threadId: thread.thread.id }, sessionContext)).deleted, true);
  await assert.rejects(
    session.getArtifactContent({ artifactId: sessionFiles[0].id }, sessionContext),
    (error) => error?.status === 404
  );
  await session.close({ mode: "wait" });

  let intent = null;
  let fullRequestSeen = false;
  const authorizeRequest = async (request) => {
    if (request.schemaVersion === INTEGRATION_FILE_WORKER_INTENT_CANDIDATE_SCHEMA_VERSION) {
      assert.equal(JSON.stringify(request).includes("Verified client content"), false);
      intent = Object.freeze({
        schemaVersion: INTEGRATION_FILE_WORKER_ISSUE_INTENT_SCHEMA_VERSION,
        issuanceId: createFileWorkerIssuanceId(request.authorityEpoch),
        authorityEpoch: request.authorityEpoch,
        contentDigest: request.contentDigest,
      });
      return intent;
    }
    assert.equal(request.issuanceId, intent.issuanceId);
    assert.equal(request.files[0].content, "Verified client content.\n");
    fullRequestSeen = true;
    return request;
  };
  const published = await client.publish(TEST_SCOPE, {
    files: Object.freeze([
      Object.freeze({
        filename: "client.md",
        mime: "text/markdown",
        content: "Verified client content.\n",
      }),
      Object.freeze({
        filename: "client.json",
        mime: "application/json",
        content: "{\"ok\":true}\n",
      }),
    ]),
  }, { authorizeRequest });
  assert.equal(fullRequestSeen, true);
  assert.equal(published.artifacts.length, 2);
  assert.equal(published.artifacts[0].kind, "file");
  const metadata = published.artifacts.map(inspectIntegrationFileWorkerArtifact);
  assert.equal(metadata.every((item) => item?.profile === "file-bundle-v1"), true);
  const commit = await client.commitArtifacts(TEST_SCOPE, {
    receiptDigest: published.receipt.digest,
    artifacts: published.artifacts,
  });
  assert.equal(commit.status, "committed");
  const content = await client.content(TEST_SCOPE, {
    ref: metadata[0].workerRef,
    receiptDigest: published.receipt.digest,
    filename: published.artifacts[0].spec.filename,
    mime: published.artifacts[0].spec.mime,
    bytes: published.artifacts[0].spec.bytes,
    sha256: published.artifacts[0].spec.sha256,
    metadataOnly: false,
  });
  const reader = content.body.getReader();
  const chunks = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(Buffer.from(chunk.value));
  }
  reader.releaseLock();
  content.cleanup();
  assert.equal(Buffer.concat(chunks).toString("utf8"), "Verified client content.\n");
  const objects = metadata.map((item) => Object.freeze({
    ref: item.workerRef,
    runId: TEST_SCOPE.runId,
    receiptDigest: published.receipt.digest,
  })).sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  const deletionId = `fdel_${crypto.createHash("sha256").update("client-delete", "utf8").digest("hex")}`;
  assert.equal((await client.deleteObjects(TEST_THREAD_SCOPE, {
    deletionId,
    phase: "prepare",
    objects,
  })).status, "prepared");
  assert.equal((await client.deleteObjects(TEST_THREAD_SCOPE, {
    deletionId,
    phase: "commit",
    objects,
  })).status, "committed");
  const gone = await client.content(TEST_SCOPE, {
    ref: metadata[0].workerRef,
    receiptDigest: published.receipt.digest,
    filename: published.artifacts[0].spec.filename,
    mime: published.artifacts[0].spec.mime,
    bytes: published.artifacts[0].spec.bytes,
    sha256: published.artifacts[0].spec.sha256,
    metadataOnly: false,
  });
  assert.equal(gone.status, 410);
  console.log("integration file worker client smoke passed");
} finally {
  await service?.close().catch(() => {});
  await Promise.allSettled(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
