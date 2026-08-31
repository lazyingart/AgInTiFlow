import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openIntegrationDocumentWorkerStore } from "../src/integration-document-worker-store.js";
import { createTestOnlyIntegrationDocumentWorkerService } from "../src/integration-document-worker-service.js";
import {
  TEST_SCOPE,
  fakeCompiledPayload,
  issueTestCompileRequest,
  readStream,
  testCommitRequest,
  testCompileRequest,
  testCompileIssueRequest,
  testContentRequest,
  testDeleteRequest,
  testDocumentWorkerConfig,
  testEvidence,
} from "./fixtures/integration-document-worker-smoke-fixture.js";

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function temporaryRoot(label) {
  const base = process.platform === "linux"
    ? await fs.access("/dev/shm").then(() => "/dev/shm").catch(() => os.tmpdir())
    : os.tmpdir();
  return fs.mkdtemp(path.join(base, `aginti-document-worker-${label}-`));
}

async function createCommit(store, label) {
  const { compileAuthorityEpoch } = await store.inspect();
  const request = await issueTestCompileRequest(store, label, { compileAuthorityEpoch });
  await store.reserveCompile(request);
  const response = await store.stageCompile({
    request,
    evidence: testEvidence(request),
    compiled: fakeCompiledPayload(request, label),
  });
  const commitRequest = testCommitRequest(response, TEST_SCOPE, label);
  const commitResponse = await store.commit(commitRequest);
  return Object.freeze({ request, response, commitRequest, commitResponse });
}

async function deletePair(store, pair, label) {
  const prepare = testDeleteRequest(pair.response, "prepare", label);
  assert.equal((await store.delete(prepare)).status, "prepared");
  const committed = await store.delete({ ...prepare, phase: "commit" });
  assert.equal(committed.status, "committed");
  return Object.freeze({ prepare, committed });
}

async function readPdf(store, pair) {
  const opened = await store.openContent(testContentRequest(pair.response, "pdf"));
  try {
    return await readStream(opened.stream);
  } finally {
    await opened.release();
  }
}

const roots = [];
try {
  const longevityRoot = await temporaryRoot("longevity");
  roots.push(longevityRoot);
  let store = await openIntegrationDocumentWorkerStore({
    stateRoot: longevityRoot,
    tombstoneReplayWindow: 8,
  });
  const retained = await createCommit(store, "retained-a");
  const retainedPdf = fakeCompiledPayload(retained.request, "retained-a").pdf.bytes;
  const responseLost = await createCommit(store, "response-lost-live-operation");
  const responseLostReceipt = responseLost.response.receipt.digest;
  let oldest;
  let newest;
  for (let index = 0; index < 4_105; index += 1) {
    const label = `deleted-b-${String(index).padStart(4, "0")}`;
    const pair = await createCommit(store, label);
    const deletion = await deletePair(store, pair, label);
    const value = Object.freeze({ ...pair, deletion });
    if (index === 0) oldest = value;
    newest = value;
  }
  const inventory = await store.inspect();
  assert.equal(inventory.tombstoneReplayWindow, 8);
  assert.equal(inventory.committedGroups, 2);
  assert.equal(inventory.tombstonedGroups, 8);
  assert.equal(inventory.groups, 10);
  assert.equal(inventory.pendingDeletions, 0);
  assert.equal(inventory.compileAuthorityEpoch, 4_098);
  assert.deepEqual(await readPdf(store, retained), retainedPdf);
  const replayAfterEpochAdvance = await store.lookupCompile(responseLost.request);
  assert.equal(replayAfterEpochAdvance.receipt.digest, responseLostReceipt);
  assert.equal((await store.inspect()).groups, 10, "response loss across epoch advance must not duplicate a group");
  await expectCode(() => store.lookupCompile(oldest.request), "ARTIFACT_CONTENT_GONE");
  await expectCode(
    async () => {
      await store.reserveCompile(oldest.request);
      return store.stageCompile({
      request: oldest.request,
      evidence: testEvidence(oldest.request),
      compiled: fakeCompiledPayload(oldest.request, "deleted-b-0000"),
      });
    },
    "ARTIFACT_CONTENT_GONE"
  );
  await expectCode(() => store.commit(oldest.commitRequest), "NOT_FOUND");
  await expectCode(() => store.delete({ ...oldest.deletion.prepare, phase: "status" }), "NOT_FOUND");
  await expectCode(() => store.lookupCompile(newest.request), "ARTIFACT_CONTENT_GONE");
  const unseenStaleIssue = testCompileIssueRequest("stale-never-reached", { compileAuthorityEpoch: 1 });
  await expectCode(() => store.issueCompile(unseenStaleIssue), "ARTIFACT_CONTENT_GONE");
  await expectCode(
    () => store.issueCompile({
      ...unseenStaleIssue,
      compileAuthorityEpoch: inventory.compileAuthorityEpoch,
    }),
    "INVALID_REQUEST"
  );
  const freshAuthority = await store.issueCompile(testCompileIssueRequest(
    "genuinely-new-operation",
    { compileAuthorityEpoch: inventory.compileAuthorityEpoch }
  ));
  assert.notEqual(freshAuthority.issuanceId, unseenStaleIssue.issuanceId);
  const forgedDeletedRequest = {
    ...oldest.request,
    issuanceId: freshAuthority.issuanceId,
    compileAuthorityEpoch: freshAuthority.compileAuthorityEpoch,
    compileAuthorityToken: freshAuthority.compileAuthorityToken,
  };
  await expectCode(() => store.reserveCompile(forgedDeletedRequest), "ARTIFACT_CONTENT_GONE");
  const genuinelyNewRequest = testCompileRequest("genuinely-new-operation", {
    issuanceId: freshAuthority.issuanceId,
    requestId: freshAuthority.requestId,
    compileAuthorityEpoch: freshAuthority.compileAuthorityEpoch,
    compileAuthorityToken: freshAuthority.compileAuthorityToken,
  });
  assert.equal((await store.reserveCompile(genuinelyNewRequest)).reserved, true);
  const conflictSource = "\\documentclass{article}\\begin{document}conflict\\end{document}\n";
  const conflictingResponseLossReplay = {
    ...responseLost.request,
    source: conflictSource,
    sourceSha256: crypto.createHash("sha256").update(conflictSource).digest("hex"),
  };
  await expectCode(() => store.lookupCompile(conflictingResponseLossReplay), "IDEMPOTENCY_CONFLICT");
  assert.equal((await store.delete({ ...newest.deletion.prepare, phase: "status" })).status, "committed");
  await store.close();
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: longevityRoot,
    tombstoneReplayWindow: 8,
  });
  assert.deepEqual(await readPdf(store, retained), retainedPdf);
  const reopenedInventory = await store.inspect();
  assert.equal(reopenedInventory.groups, 10);
  assert.equal((await store.lookupCompile(responseLost.request)).receipt.digest, responseLostReceipt);
  await store.close();

  for (const event of ["before-tombstone-compaction", "after-tombstone-compaction"]) {
    const crashRoot = await temporaryRoot(`compaction-${event}`);
    roots.push(crashRoot);
    let armed = false;
    store = await openIntegrationDocumentWorkerStore({
      stateRoot: crashRoot,
      tombstoneReplayWindow: 1,
      checkpoint(candidate) {
        if (armed && candidate === event) {
          armed = false;
          throw new Error(`simulated ${event} crash`);
        }
      },
    });
    const keep = await createCommit(store, `${event}-retained-a`);
    const first = await createCommit(store, `${event}-deleted-1`);
    await deletePair(store, first, `${event}-deleted-1`);
    const second = await createCommit(store, `${event}-deleted-2`);
    const prepare = testDeleteRequest(second.response, "prepare", `${event}-deleted-2`);
    await store.delete(prepare);
    armed = true;
    await assert.rejects(
      () => store.delete({ ...prepare, phase: "commit" }),
      new RegExp(`simulated ${event} crash`, "u")
    );
    await store.close();
    store = await openIntegrationDocumentWorkerStore({
      stateRoot: crashRoot,
      tombstoneReplayWindow: 1,
    });
    assert.equal((await store.delete({ ...prepare, phase: "status" })).status, "committed");
    assert.equal((await store.inspect()).tombstonedGroups, 1);
    assert.deepEqual(
      await readPdf(store, keep),
      fakeCompiledPayload(keep.request, `${event}-retained-a`).pdf.bytes
    );
    await store.close();
  }

  const responseLossRoot = await temporaryRoot("response-loss-epoch-reopen");
  roots.push(responseLossRoot);
  let responseLossStore = await openIntegrationDocumentWorkerStore({
    stateRoot: responseLossRoot,
    tombstoneReplayWindow: 1,
  });
  const responseLossRequest = await issueTestCompileRequest(
    responseLossStore,
    "service-response-loss",
    { compileAuthorityEpoch: 1 }
  );
  let compilerInvocations = 0;
  const serviceOptions = (candidateStore) => ({
    config: testDocumentWorkerConfig(true),
    store: candidateStore,
    async compileImpl() {
      compilerInvocations += 1;
      return fakeCompiledPayload(responseLossRequest, "service-response-loss");
    },
    async inspectRuntimeImpl() {
      return Object.freeze({
        ready: true,
        networkNone: true,
        shellEscape: false,
        runtimeDigest: "a".repeat(64),
        activationProbeDigest: "b".repeat(64),
      });
    },
  });
  let responseLossService = createTestOnlyIntegrationDocumentWorkerService(serviceOptions(responseLossStore));
  await responseLossService.activate();
  const firstResponse = await responseLossService.compile(responseLossRequest);
  assert.equal(compilerInvocations, 1);
  for (const label of ["epoch-advance-one", "epoch-advance-two"]) {
    await deletePair(responseLossStore, await createCommit(responseLossStore, label), label);
  }
  const advancedReadiness = await responseLossService.readiness({
    schemaVersion: "aginti-document-worker-readiness-request-v1",
  });
  assert(advancedReadiness.compileAuthorityEpoch > responseLossRequest.compileAuthorityEpoch);
  assert.equal((await responseLossService.compile(responseLossRequest)).receipt.digest, firstResponse.receipt.digest);
  assert.equal(compilerInvocations, 1, "epoch advance must not repeat an already-live compile operation");
  await responseLossService.close();

  responseLossStore = await openIntegrationDocumentWorkerStore({
    stateRoot: responseLossRoot,
    tombstoneReplayWindow: 1,
  });
  responseLossService = createTestOnlyIntegrationDocumentWorkerService(serviceOptions(responseLossStore));
  await responseLossService.activate();
  assert.equal((await responseLossService.compile(responseLossRequest)).receipt.digest, firstResponse.receipt.digest);
  assert.equal(compilerInvocations, 1, "restart replay must not invoke the compiler again");
  assert.equal((await responseLossStore.inspect()).groups, 2, "only the live compile and bounded tombstone may remain");
  await responseLossService.close();
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}

process.stdout.write("integration document worker longevity smoke passed cycles=4105 replayWindow=8\n");
