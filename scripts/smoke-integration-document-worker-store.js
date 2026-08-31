import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DOCUMENT_WORKER_STAGED_GROUP_TTL_MS,
  openIntegrationDocumentWorkerStore,
} from "../src/integration-document-worker-store.js";
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
  testEvidence,
} from "./fixtures/integration-document-worker-smoke-fixture.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function temporaryRoot(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `aginti-document-worker-${label}-`));
}

async function stage(store, label) {
  const request = await issueTestCompileRequest(store, label);
  await store.reserveCompile(request);
  const response = await store.stageCompile({
    request,
    evidence: testEvidence(request),
    compiled: fakeCompiledPayload(request, label),
  });
  return Object.freeze({ request, response });
}

async function commit(store, staged, label) {
  const request = testCommitRequest(staged.response, TEST_SCOPE, label);
  const response = await store.commit(request);
  return Object.freeze({ request, response });
}

async function verifyReadablePdf(store, compileResponse, expected, range) {
  const opened = await store.openContent(testContentRequest(compileResponse, "pdf", {
    ...(range === undefined ? {} : { range }),
  }));
  try {
    const bytes = await readStream(opened.stream);
    assert.deepEqual(bytes, expected.subarray(opened.metadata.start, opened.metadata.end + 1));
    return opened.metadata;
  } finally {
    await opened.release();
  }
}

async function tamperLedger(root, mutate) {
  const filename = path.join(root, "ledger.json");
  const envelope = JSON.parse(await fs.readFile(filename, "utf8"));
  mutate(envelope.ledger);
  const unsigned = {
    schemaVersion: envelope.schemaVersion,
    ledger: envelope.ledger,
  };
  await fs.writeFile(
    filename,
    `${canonicalJson({ ...unsigned, digest: contractDigest(unsigned) })}\n`,
    { mode: 0o600 }
  );
}

const roots = [];
try {
  const lifecycleRoot = await temporaryRoot("lifecycle");
  roots.push(lifecycleRoot);
  let store = await openIntegrationDocumentWorkerStore({ stateRoot: lifecycleRoot });
  const staged = await stage(store, "lifecycle");
  const issuanceReplay = await store.issueCompile(testCompileIssueRequest("lifecycle"));
  assert.equal(issuanceReplay.issuanceId, staged.request.issuanceId);
  assert.equal(issuanceReplay.requestId, staged.request.requestId);
  assert.equal(issuanceReplay.compileAuthorityToken, staged.request.compileAuthorityToken);
  assert.equal((await store.inspect()).compileReservations, 1);
  const expectedPdf = fakeCompiledPayload(staged.request, "lifecycle").pdf.bytes;
  assert.equal((await store.lookupCompile(staged.request)).receipt.digest, staged.response.receipt.digest);
  await expectCode(
    () => store.openContent(testContentRequest(staged.response, "pdf")),
    "NOT_FOUND"
  );

  const committed = await commit(store, staged, "lifecycle");
  assert.equal(committed.response.status, "committed");
  const fullMetadata = await verifyReadablePdf(store, staged.response, expectedPdf);
  assert.equal(fullMetadata.partial, false);
  assert.equal(fullMetadata.selectedBytes, expectedPdf.byteLength);
  const rangedMetadata = await verifyReadablePdf(store, staged.response, expectedPdf, { start: 5 });
  assert.equal(rangedMetadata.partial, true);
  assert.equal(rangedMetadata.start, 5);
  assert.equal(rangedMetadata.end, expectedPdf.byteLength - 1);
  const clampedMetadata = await verifyReadablePdf(store, staged.response, expectedPdf, {
    start: 1,
    end: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(clampedMetadata.end, expectedPdf.byteLength - 1);
  await expectCode(
    () => store.openContent(testContentRequest(staged.response, "pdf", {
      range: { start: expectedPdf.byteLength },
    })),
    "RANGE_NOT_SATISFIABLE"
  );
  await expectCode(
    () => store.openContent(testContentRequest(staged.response, "pdf", {
      scope: { ...TEST_SCOPE, browserSessionId: "b".repeat(64) },
    })),
    "NOT_FOUND"
  );
  const metadataOnly = await store.openContent(testContentRequest(staged.response, "pdf", {
    metadataOnly: true,
    range: { start: 2, end: 6 },
  }));
  assert.equal(metadataOnly.stream, null);
  assert.equal(metadataOnly.metadata.metadataOnly, true);
  assert.equal(metadataOnly.metadata.partial, true);
  assert.equal(metadataOnly.metadata.selectedBytes, 5);
  await metadataOnly.release();

  assert.deepEqual(await store.commit(committed.request), committed.response);
  await expectCode(
    () => store.commit({
      ...committed.request,
      scope: { ...TEST_SCOPE, browserSessionId: "b".repeat(64) },
    }),
    "IDEMPOTENCY_CONFLICT"
  );

  await store.close();
  store = await openIntegrationDocumentWorkerStore({ stateRoot: lifecycleRoot });
  assert.deepEqual(await store.issueCompile(testCompileIssueRequest("lifecycle")), issuanceReplay);
  await verifyReadablePdf(store, staged.response, expectedPdf);

  const activeContent = await store.openContent(testContentRequest(staged.response, "pdf"));
  const activeStreamClosed = new Promise((resolve) => {
    activeContent.stream.once("error", (error) => resolve(error));
  });
  const prepareDelete = testDeleteRequest(staged.response, "prepare", "lifecycle");
  const prepared = await store.delete(prepareDelete);
  assert.equal(prepared.status, "prepared");
  await expectCode(
    () => store.openContent(testContentRequest(staged.response, "pdf")),
    "ARTIFACT_DELETE_PENDING"
  );
  const statusPrepared = await store.delete({ ...prepareDelete, phase: "status" });
  assert.equal(statusPrepared.status, "prepared");
  const deleted = await store.delete({ ...prepareDelete, phase: "commit" });
  assert.equal(deleted.status, "committed");
  assert.match(deleted.tombstoneDigest, /^[a-f0-9]{64}$/u);
  assert.match((await activeStreamClosed).message, /artifact deleted/u);
  assert.equal(activeContent.stream.destroyed, true);
  await activeContent.release();
  await expectCode(
    () => store.openContent(testContentRequest(staged.response, "pdf")),
    "ARTIFACT_CONTENT_GONE"
  );
  assert.equal((await store.delete({ ...prepareDelete, phase: "status" })).status, "committed");
  await store.close();

  const commitCrashRoot = await temporaryRoot("commit-crash");
  roots.push(commitCrashRoot);
  let crashOnce = true;
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: commitCrashRoot,
    checkpoint(event) {
      if (event === "after-commit-ledger-before-objects" && crashOnce) {
        crashOnce = false;
        throw new Error("simulated commit crash");
      }
    },
  });
  const crashStaged = await stage(store, "commit-crash");
  const crashPdf = fakeCompiledPayload(crashStaged.request, "commit-crash").pdf.bytes;
  const crashCommit = testCommitRequest(crashStaged.response, TEST_SCOPE, "commit-crash");
  await assert.rejects(() => store.commit(crashCommit), /simulated commit crash/u);
  await store.close();
  store = await openIntegrationDocumentWorkerStore({ stateRoot: commitCrashRoot });
  await verifyReadablePdf(store, crashStaged.response, crashPdf);
  assert.deepEqual(await store.commit(crashCommit), await store.commit(crashCommit));
  await store.close();

  let deleteCrashOnce = true;
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: commitCrashRoot,
    checkpoint(event) {
      if (event === "after-delete-ledger-before-unlink" && deleteCrashOnce) {
        deleteCrashOnce = false;
        throw new Error("simulated delete crash");
      }
    },
  });
  const crashDelete = testDeleteRequest(crashStaged.response, "prepare", "commit-crash");
  await store.delete(crashDelete);
  await assert.rejects(() => store.delete({ ...crashDelete, phase: "commit" }), /simulated delete crash/u);
  await expectCode(
    () => store.openContent(testContentRequest(crashStaged.response, "pdf")),
    "ARTIFACT_DELETE_PENDING"
  );
  await store.close();
  store = await openIntegrationDocumentWorkerStore({ stateRoot: commitCrashRoot });
  await expectCode(
    () => store.openContent(testContentRequest(crashStaged.response, "pdf")),
    "ARTIFACT_CONTENT_GONE"
  );
  assert.equal((await store.delete({ ...crashDelete, phase: "status" })).status, "committed");
  await store.close();

  const orphanRoot = await temporaryRoot("orphan");
  roots.push(orphanRoot);
  let stageCrashOnce = true;
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: orphanRoot,
    checkpoint(event) {
      if (event === "after-stage-files-before-ledger" && stageCrashOnce) {
        stageCrashOnce = false;
        throw new Error("simulated stage crash");
      }
    },
  });
  await assert.rejects(() => stage(store, "orphan"), /simulated stage crash/u);
  assert.equal((await fs.readdir(path.join(orphanRoot, "stages"))).length, 0);
  await store.close();
  const orphanNames = [
    `wobj_${Buffer.alloc(32, 7).toString("base64url")}`,
    `wobj_${Buffer.alloc(32, 8).toString("base64url")}`,
  ];
  await Promise.all(orphanNames.map((name) =>
    fs.writeFile(path.join(orphanRoot, "stages", name), "orphan", { flag: "wx", mode: 0o600 })
  ));
  store = await openIntegrationDocumentWorkerStore({ stateRoot: orphanRoot });
  assert.equal((await fs.readdir(path.join(orphanRoot, "stages"))).length, 0);
  assert.equal((await store.inspect()).groups, 0);
  await store.close();

  const ttlRoot = await temporaryRoot("ttl");
  roots.push(ttlRoot);
  let clock = Date.parse("2026-08-26T00:00:00.000Z");
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: ttlRoot,
    now: () => new Date(clock),
  });
  const retained = await stage(store, "ttl-retained");
  const retainedPdf = fakeCompiledPayload(retained.request, "ttl-retained").pdf.bytes;
  await commit(store, retained, "ttl-retained");
  const expires = await stage(store, "ttl-expired");
  await store.close();
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: ttlRoot,
    now: () => new Date(clock),
  });
  assert.equal((await store.inspect()).stagedGroups, 1, "under-TTL staged group must survive restart");
  assert.equal((await store.lookupCompile(expires.request)).receipt.digest, expires.response.receipt.digest);
  clock += DOCUMENT_WORKER_STAGED_GROUP_TTL_MS + 1;
  const afterReap = await store.inspect();
  assert.equal(afterReap.stagedGroups, 0);
  assert.equal(afterReap.committedGroups, 1);
  assert.equal((await fs.readdir(path.join(ttlRoot, "stages"))).length, 0);
  assert.equal((await fs.readdir(path.join(ttlRoot, "objects"))).length, 2);
  await verifyReadablePdf(store, retained.response, retainedPdf);
  await store.close();

  const issueLossRoot = await temporaryRoot("issue-response-loss");
  roots.push(issueLossRoot);
  let loseIssueResponse = false;
  store = await openIntegrationDocumentWorkerStore({
    stateRoot: issueLossRoot,
    checkpoint(event) {
      if (loseIssueResponse && event === "after-ledger-rename-before-directory-sync") {
        loseIssueResponse = false;
        throw new Error("simulated compile issue response loss");
      }
    },
  });
  const lostIssueRequest = testCompileIssueRequest("issue-response-loss");
  loseIssueResponse = true;
  await expectCode(() => store.issueCompile(lostIssueRequest), "WORKER_STATE_UNAVAILABLE");
  await store.close();
  store = await openIntegrationDocumentWorkerStore({ stateRoot: issueLossRoot });
  const recoveredIssue = await store.issueCompile(lostIssueRequest);
  assert.deepEqual(await store.issueCompile(lostIssueRequest), recoveredIssue);
  assert.equal((await store.inspect()).compileReservations, 1);
  await store.close();

  const forgedEvidenceRoot = await temporaryRoot("forged-evidence");
  roots.push(forgedEvidenceRoot);
  store = await openIntegrationDocumentWorkerStore({ stateRoot: forgedEvidenceRoot });
  const forgedEvidenceRequest = await issueTestCompileRequest(store, "forged-evidence");
  await store.reserveCompile(forgedEvidenceRequest);
  await expectCode(
    () => store.stageCompile({
      request: forgedEvidenceRequest,
      evidence: { ...testEvidence(forgedEvidenceRequest), verifiedFigureCount: 1 },
      compiled: fakeCompiledPayload(forgedEvidenceRequest, "forged-evidence"),
    }),
    "WORKER_STATE_UNAVAILABLE"
  );
  await store.close();

  const tamperedCommittedRoot = await temporaryRoot("tampered-committed-lifecycle");
  roots.push(tamperedCommittedRoot);
  store = await openIntegrationDocumentWorkerStore({ stateRoot: tamperedCommittedRoot });
  await stage(store, "tampered-committed-lifecycle");
  await store.close();
  await tamperLedger(tamperedCommittedRoot, (ledger) => {
    ledger.groups[0].state = "committed";
    ledger.groups[0].committedAt = "2026-08-26T00:00:00.000Z";
  });
  await expectCode(
    () => openIntegrationDocumentWorkerStore({ stateRoot: tamperedCommittedRoot }),
    "WORKER_STATE_UNAVAILABLE"
  );

  const tamperedDeletionRoot = await temporaryRoot("tampered-deletion-lifecycle");
  roots.push(tamperedDeletionRoot);
  store = await openIntegrationDocumentWorkerStore({ stateRoot: tamperedDeletionRoot });
  const tamperedDeletion = await stage(store, "tampered-deletion-lifecycle");
  await commit(store, tamperedDeletion, "tampered-deletion-lifecycle");
  await store.delete(testDeleteRequest(tamperedDeletion.response, "prepare", "tampered-deletion-lifecycle"));
  await store.close();
  await tamperLedger(tamperedDeletionRoot, (ledger) => {
    ledger.groups[0].state = "committed";
  });
  await expectCode(
    () => openIntegrationDocumentWorkerStore({ stateRoot: tamperedDeletionRoot }),
    "WORKER_STATE_UNAVAILABLE"
  );

  for (const event of ["before-ledger-rename", "after-ledger-rename-before-directory-sync"]) {
    const faultRoot = await temporaryRoot(`persistence-${event}`);
    roots.push(faultRoot);
    let armed = false;
    store = await openIntegrationDocumentWorkerStore({
      stateRoot: faultRoot,
      checkpoint(candidate) {
        if (armed && candidate === event) throw new Error(`simulated persistence fault: ${event}`);
      },
    });
    const faultRequest = await issueTestCompileRequest(store, `persistence-${event}`);
    await store.reserveCompile(faultRequest);
    armed = true;
    await expectCode(
      () => store.stageCompile({
        request: faultRequest,
        evidence: testEvidence(faultRequest),
        compiled: fakeCompiledPayload(faultRequest, event),
      }),
      "WORKER_STATE_UNAVAILABLE"
    );
    await expectCode(() => store.inspect(), "WORKER_STATE_UNAVAILABLE");
    await expectCode(() => store.lookupCompile(faultRequest), "WORKER_STATE_UNAVAILABLE");
    await store.close();
    store = await openIntegrationDocumentWorkerStore({ stateRoot: faultRoot });
    const recovered = await store.inspect();
    if (event === "before-ledger-rename") {
      assert.equal(recovered.groups, 0);
      assert.equal((await fs.readdir(path.join(faultRoot, "stages"))).length, 0);
    } else {
      assert.equal(recovered.stagedGroups, 1);
      assert.equal((await store.lookupCompile(faultRequest)).requestId, faultRequest.requestId);
    }
    await store.close();
  }

  const unknownObjectRoot = await temporaryRoot("unknown-object");
  roots.push(unknownObjectRoot);
  store = await openIntegrationDocumentWorkerStore({ stateRoot: unknownObjectRoot });
  await store.close();
  await fs.writeFile(
    path.join(unknownObjectRoot, "objects", `wobj_${Buffer.alloc(32, 9).toString("base64url")}`),
    "unknown committed bytes",
    { flag: "wx", mode: 0o600 }
  );
  await expectCode(
    () => openIntegrationDocumentWorkerStore({ stateRoot: unknownObjectRoot }),
    "WORKER_STATE_UNAVAILABLE"
  );

  for (const tamperKind of ["symlink", "hardlink", "special"]) {
    const tamperRoot = await temporaryRoot(`tamper-${tamperKind}`);
    roots.push(tamperRoot);
    store = await openIntegrationDocumentWorkerStore({ stateRoot: tamperRoot });
    const tampered = await stage(store, `tamper-${tamperKind}`);
    await commit(store, tampered, `tamper-${tamperKind}`);
    const pdf = tampered.response.artifacts.find((artifact) => artifact.role === "pdf");
    const objectPath = path.join(tamperRoot, "objects", pdf.ref);
    const outsidePath = path.join(tamperRoot, `outside-${tamperKind}`);
    const original = await fs.readFile(objectPath);
    await fs.unlink(objectPath);
    if (tamperKind === "symlink") {
      await fs.writeFile(outsidePath, original, { mode: 0o600 });
      await fs.symlink(outsidePath, objectPath);
    } else if (tamperKind === "hardlink") {
      await fs.writeFile(outsidePath, original, { mode: 0o600 });
      await fs.link(outsidePath, objectPath);
    } else {
      await fs.mkdir(objectPath, { mode: 0o700 });
    }
    await expectCode(
      () => store.openContent(testContentRequest(tampered.response, "pdf")),
      "WORKER_STATE_UNAVAILABLE"
    );
    await store.close();
  }
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}

process.stdout.write("integration document worker store smoke passed\n");
