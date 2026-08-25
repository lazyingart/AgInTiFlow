import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
  compareIntegrationDocumentWorkerCodeUnits,
  createTestOnlyIntegrationDocumentWorkerClient,
  inspectIntegrationDocumentWorkerFileArtifact,
} from "../src/integration-document-worker-client.js";

function workerModule(workerRoot, relativePath) {
  return pathToFileURL(path.join(workerRoot, relativePath)).href;
}

async function main() {
  const workerRoot = path.resolve(process.argv[2] || "");
  if (!process.argv[2] || workerRoot === path.parse(workerRoot).root) {
    throw new Error("Usage: node scripts/smoke-integration-document-worker-cross-boundary.js <worker-checkout>");
  }

  const [serverModule, serviceModule, storeModule, fixtureModule] = await Promise.all([
    import(workerModule(workerRoot, "src/integration-document-worker-server.js")),
    import(workerModule(workerRoot, "src/integration-document-worker-service.js")),
    import(workerModule(workerRoot, "src/integration-document-worker-store.js")),
    import(workerModule(workerRoot, "scripts/fixtures/integration-document-worker-smoke-fixture.js")),
  ]);

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-boundary-"));
  let creationRoot;
  let store;
  let server;
  try {
    store = await storeModule.openIntegrationDocumentWorkerStore({ stateRoot: temporaryRoot });
    const config = fixtureModule.testDocumentWorkerConfig(false);
    const service = serviceModule.createTestOnlyIntegrationDocumentWorkerService({ config, store });
    server = serverModule.createIntegrationDocumentWorkerServer({
      config,
      service,
      bearerToken: fixtureModule.TEST_BEARER_TOKEN,
    });
    const address = await server.start();
    assert.deepEqual(address, { address: "127.0.0.1", port: 18102, family: "IPv4" });

    const client = createTestOnlyIntegrationDocumentWorkerClient({
      endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
      credential: fixtureModule.TEST_BEARER_TOKEN,
      timeoutMs: 5_000,
      fetchImpl(input, init) {
        const target = new URL(String(input));
        assert.equal(target.origin, INTEGRATION_DOCUMENT_WORKER_ENDPOINT);
        target.port = "18102";
        return fetch(target, init);
      },
    });
    const activation = await client.activate();
    assert.equal(activation.ready, true);
    assert.equal(activation.creationEnabled, false);
    assert.equal(activation.compilerDigest, undefined);
    assert.equal(activation.activationProbeDigest, undefined);

    await server.close();
    server = null;
    store = null;

    creationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-creation-boundary-"));
    store = await storeModule.openIntegrationDocumentWorkerStore({ stateRoot: creationRoot });
    const creationConfig = fixtureModule.testDocumentWorkerConfig(true);
    const creationService = serviceModule.createTestOnlyIntegrationDocumentWorkerService({
      config: creationConfig,
      store,
      compileImpl(input) {
        return fixtureModule.fakeCompiledPayload(input, "qaoa-boundary");
      },
      inspectRuntimeImpl: async () => Object.freeze({
        ready: true,
        networkNone: true,
        shellEscape: false,
        runtimeDigest: "a".repeat(64),
        activationProbeDigest: "b".repeat(64),
      }),
    });
    server = serverModule.createIntegrationDocumentWorkerServer({
      config: creationConfig,
      service: creationService,
      bearerToken: fixtureModule.TEST_BEARER_TOKEN,
    });
    await server.start();
    const creationClient = createTestOnlyIntegrationDocumentWorkerClient({
      endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
      credential: fixtureModule.TEST_BEARER_TOKEN,
      timeoutMs: 5_000,
      fetchImpl(input, init) {
        const target = new URL(String(input));
        assert.equal(target.origin, INTEGRATION_DOCUMENT_WORKER_ENDPOINT);
        target.port = "18102";
        return fetch(target, init);
      },
    });
    const creationActivation = await creationClient.activate();
    assert.equal(creationActivation.creationEnabled, true);
    const source = [
      "\\documentclass{article}",
      "\\usepackage{tikz}",
      "\\begin{document}",
      "\\section*{QAOA}",
      "\\begin{figure}",
      "\\centering",
      "\\begin{tikzpicture}",
      "\\draw[->] (0,0) -- (2,0);",
      "\\draw[->] (0,0) -- (0,2);",
      "\\draw (0,0) -- (1,1) -- (2,1.4);",
      "\\end{tikzpicture}",
      "\\caption{Self-contained illustrative objective curve.}",
      "\\end{figure}",
      "\\end{document}",
      "",
    ].join("\n");
    const compiled = await creationClient.compile(fixtureModule.TEST_SCOPE, {
      filename: "qaoa-figure.tex",
      source,
      requirements: fixtureModule.testRequirements(1),
    });
    assert.equal(compiled.receipt.verifiedFigureCount, 1);
    assert.deepEqual(compiled.artifacts.map(({ spec }) => spec.filename), [
      "qaoa-figure.tex",
      "qaoa-figure.pdf",
    ]);
    await creationClient.commitArtifacts(fixtureModule.TEST_SCOPE, {
      receiptDigest: compiled.receipt.digest,
      artifacts: compiled.artifacts,
    });
    const pdf = compiled.artifacts[1];
    const privatePdf = inspectIntegrationDocumentWorkerFileArtifact(pdf);
    const content = await creationClient.content(fixtureModule.TEST_SCOPE, {
      ref: privatePdf.workerRef,
      receiptDigest: compiled.receipt.digest,
      filename: pdf.spec.filename,
      mime: pdf.spec.mime,
      bytes: pdf.spec.bytes,
      sha256: pdf.spec.sha256,
      metadataOnly: false,
      range: { start: 0, end: Math.min(9, pdf.spec.bytes - 1) },
    });
    assert.equal(content.status, 206);
    assert.equal(Buffer.from(await new Response(content.body).arrayBuffer()).byteLength, content.selectedBytes);
    content.cleanup();
    const objects = compiled.artifacts
      .map((artifact) => ({
        ref: inspectIntegrationDocumentWorkerFileArtifact(artifact).workerRef,
        runId: fixtureModule.TEST_SCOPE.runId,
        receiptDigest: compiled.receipt.digest,
      }))
      .sort((left, right) => compareIntegrationDocumentWorkerCodeUnits(left.ref, right.ref));
    const deletionId = `del_${"c".repeat(64)}`;
    assert.equal((await creationClient.deleteObjects(fixtureModule.TEST_THREAD_SCOPE, {
      deletionId,
      phase: "prepare",
      objects,
    })).status, "prepared");
    assert.equal((await creationClient.deleteObjects(fixtureModule.TEST_THREAD_SCOPE, {
      deletionId,
      phase: "commit",
      objects,
    })).status, "committed");
  } finally {
    if (server) await server.close().catch(() => {});
    else await store?.close().catch(() => {});
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    if (creationRoot) await fs.rm(creationRoot, { recursive: true, force: true });
  }
  process.stdout.write("integration document worker cross-boundary smoke passed\n");
}

await main();
