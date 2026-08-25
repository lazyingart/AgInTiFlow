import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTestOnlyIntegrationDocumentWorkerService } from "../src/integration-document-worker-service.js";
import { openIntegrationDocumentWorkerStore } from "../src/integration-document-worker-store.js";
import {
  TEST_SCOPE,
  fakeCompiledPayload,
  readStream,
  testCommitRequest,
  testCompileRequest,
  testContentRequest,
  testDeleteRequest,
  testDocumentWorkerConfig,
  testEvidence,
} from "./fixtures/integration-document-worker-smoke-fixture.js";

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const roots = [];
try {
  const floorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-floor-"));
  roots.push(floorRoot);
  const floorStore = await openIntegrationDocumentWorkerStore({ stateRoot: floorRoot });
  const floorRequest = testCompileRequest("creation-floor");
  const floorCompiled = fakeCompiledPayload(floorRequest, "creation-floor");
  const floorStaged = await floorStore.stageCompile({
    request: floorRequest,
    evidence: testEvidence(floorRequest),
    compiled: floorCompiled,
  });
  const floorCommit = testCommitRequest(floorStaged, TEST_SCOPE, "creation-floor");
  await floorStore.commit(floorCommit);
  let floorCanaryCalls = 0;
  const floorService = createTestOnlyIntegrationDocumentWorkerService({
    config: testDocumentWorkerConfig(false),
    store: floorStore,
    inspectRuntimeImpl: async () => {
      floorCanaryCalls += 1;
      return Object.freeze({
        ready: true,
        networkNone: true,
        shellEscape: false,
        runtimeDigest: "2".repeat(64),
        activationProbeDigest: "3".repeat(64),
      });
    },
  });
  const readiness = await floorService.activate();
  assert.equal(floorCanaryCalls, 0, "disabled API startup must not claim compiler activation");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.creationEnabled, false);
  assert.equal(readiness.compiler, null);
  assert.equal((await floorService.check()).compiler, null);
  assert.equal((await floorService.check()).compiler, null);
  assert.equal(floorCanaryCalls, 1, "the exact check must run and cache one compiler canary");
  assert.equal(floorService.readiness({
    schemaVersion: "aginti-document-worker-readiness-request-v1",
  }).digest, readiness.digest);
  await expectCode(() => floorService.compile(floorRequest), "WORKER_CREATION_DISABLED");
  assert.equal((await floorService.commit(floorCommit)).status, "committed");
  const floorContent = await floorService.content(testContentRequest(floorStaged, "pdf"));
  assert.deepEqual(await readStream(floorContent.stream), floorCompiled.pdf.bytes);
  await floorContent.release();
  const floorDelete = testDeleteRequest(floorStaged, "prepare", "creation-floor");
  assert.equal((await floorService.delete(floorDelete)).status, "prepared");
  assert.equal((await floorService.delete({ ...floorDelete, phase: "commit" })).status, "committed");
  await expectCode(
    () => floorService.content(testContentRequest(floorStaged, "pdf")),
    "ARTIFACT_CONTENT_GONE"
  );
  await floorService.close();

  const failedCheckRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-check-failure-"));
  roots.push(failedCheckRoot);
  const failedCheckStore = await openIntegrationDocumentWorkerStore({ stateRoot: failedCheckRoot });
  let failedCanaryCalls = 0;
  const failedCheckService = createTestOnlyIntegrationDocumentWorkerService({
    config: testDocumentWorkerConfig(false),
    store: failedCheckStore,
    inspectRuntimeImpl() {
      failedCanaryCalls += 1;
      throw new Error("offline compiler canary failed");
    },
  });
  await expectCode(() => failedCheckService.check(), "WORKER_UNAVAILABLE");
  assert.equal(failedCanaryCalls, 1);
  assert.throws(
    () => failedCheckService.readiness({ schemaVersion: "aginti-document-worker-readiness-request-v1" }),
    (error) => error?.code === "WORKER_UNAVAILABLE",
    "a failed check must not activate the service"
  );
  await failedCheckService.close();

  const concurrencyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-concurrency-"));
  roots.push(concurrencyRoot);
  const concurrencyStore = await openIntegrationDocumentWorkerStore({ stateRoot: concurrencyRoot });
  let active = 0;
  let maximumActive = 0;
  const started = [];
  const releases = [];
  const concurrencyService = createTestOnlyIntegrationDocumentWorkerService({
    config: testDocumentWorkerConfig(true),
    store: concurrencyStore,
    inspectRuntimeImpl: async () => Object.freeze({
      ready: true,
      networkNone: true,
      shellEscape: false,
      runtimeDigest: "4".repeat(64),
      activationProbeDigest: "5".repeat(64),
    }),
    async compileImpl(value) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(value.filename);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return fakeCompiledPayload(value, value.filename);
    },
  });
  const activeReadiness = await concurrencyService.activate();
  assert.equal(activeReadiness.compiler.limits.maximumConcurrentCompiles, 2);
  const requests = Array.from({ length: 8 }, (_, index) => testCompileRequest(`concurrency-${index}`));
  const firstTwo = requests.slice(0, 2).map((request) => concurrencyService.compile(request));
  await waitFor(() => started.length === 2, "two compiler slots did not start");
  assert.equal(active, 2);
  assert.equal(started.length, 2);
  const queuedAbort = new AbortController();
  const queued = [
    concurrencyService.compile(requests[2], { signal: queuedAbort.signal }),
    concurrencyService.compile(requests[3]),
    concurrencyService.compile(requests[4]),
    concurrencyService.compile(requests[5]),
  ];
  const abortedCheck = expectCode(() => queued[0], "WORKER_UNAVAILABLE");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.length, 2, "queued compiles must not exceed the two active slots");
  await expectCode(() => concurrencyService.compile(requests[6]), "WORKER_UNAVAILABLE");
  queuedAbort.abort();
  await abortedCheck;
  const replacement = concurrencyService.compile(requests[7]);
  let replacementSettled = false;
  replacement.then(
    () => { replacementSettled = true; },
    () => { replacementSettled = true; }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementSettled, false, "an aborted waiter must free queue capacity immediately");

  const survivors = [...firstTwo, ...queued.slice(1), replacement];
  for (let index = 0; index < survivors.length; index += 1) {
    await waitFor(() => releases.length > 0, "a queued compiler did not acquire its released slot");
    releases.shift()();
  }
  const results = await Promise.all(survivors);
  assert.equal(new Set(results.map((result) => result.requestId)).size, survivors.length);
  assert.equal(maximumActive, 2);
  await concurrencyService.close();
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}

process.stdout.write("integration document worker service smoke passed\n");
