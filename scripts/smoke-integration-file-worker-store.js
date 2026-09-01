import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FILE_WORKER_SCHEMA_VERSIONS,
  createFileWorkerIssuanceId,
} from "../src/integration-file-worker-contract.js";
import { openIntegrationFileWorkerStore } from "../src/integration-file-worker-store.js";
import { contractDigest } from "../src/integration-policy.js";

const scope = Object.freeze({
  principalId: "principal.file-worker-smoke",
  browserSessionId: "a".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000101",
  runId: "run_00000000-0000-4000-8000-000000000102",
});
const threadScope = Object.freeze({
  principalId: scope.principalId,
  browserSessionId: scope.browserSessionId,
  threadId: scope.threadId,
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function candidates(label = "default") {
  const text = Buffer.from(`# ${label}\n\nVerified local file.\n`, "utf8");
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Object.freeze({
    manifests: Object.freeze([
      Object.freeze({ index: 0, filename: `${label}.md`, mime: "text/markdown", bytes: text.byteLength, sha256: sha256(text) }),
      Object.freeze({ index: 1, filename: `${label}.png`, mime: "image/png", bytes: binary.byteLength, sha256: sha256(binary) }),
    ]),
    contents: Object.freeze([
      Object.freeze({ index: 0, filename: `${label}.md`, mime: "text/markdown", bytes: text.byteLength, sha256: sha256(text), encoding: "utf8", content: text.toString("utf8") }),
      Object.freeze({ index: 1, filename: `${label}.png`, mime: "image/png", bytes: binary.byteLength, sha256: sha256(binary), encoding: "base64", content: binary.toString("base64") }),
    ]),
    bytes: Object.freeze([text, binary]),
  });
}

async function issuedRequest(store, label) {
  const files = candidates(label);
  const issue = Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.issueRequest,
    issuanceId: createFileWorkerIssuanceId(1),
    authorityEpoch: 1,
    scope,
    files: files.manifests,
  });
  const authority = await store.issue(issue);
  return Object.freeze({
    files,
    request: Object.freeze({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.publishRequest,
      issuanceId: authority.issuanceId,
      requestId: authority.requestId,
      authorityEpoch: authority.authorityEpoch,
      authorityToken: authority.authorityToken,
      scope,
      files: files.contents,
    }),
  });
}

function commitRequest(published, label) {
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.commitRequest,
    requestId: `fcmt_${sha256(Buffer.from(`commit:${label}`, "utf8"))}`,
    scope,
    receiptDigest: published.receipt.digest,
    objects: Object.freeze(published.artifacts.map(({ ref, index, sha256: digest }) => Object.freeze({
      ref, index, sha256: digest,
    }))),
  });
}

function contentRequest(published, artifact, overrides = {}) {
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.contentRequest,
    scope: overrides.scope || scope,
    ref: artifact.ref,
    receiptDigest: published.receipt.digest,
    metadataOnly: overrides.metadataOnly ?? false,
    ...(overrides.range === undefined ? {} : { range: overrides.range }),
  });
}

async function read(result) {
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  await result.release();
  return Buffer.concat(chunks);
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

const roots = [];
try {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-worker-lifecycle-"));
  roots.push(parent);
  const root = path.join(parent, "state");
  let store = await openIntegrationFileWorkerStore({ stateRoot: root });
  const issued = await issuedRequest(store, "bundle");
  const published = await store.publish(issued.request);
  assert.equal(published.artifacts.length, 2);
  assert.equal((await store.publish(issued.request)).receipt.digest, published.receipt.digest);
  await expectCode(() => store.openContent(contentRequest(published, published.artifacts[0])), "NOT_FOUND");
  const committed = await store.commit(commitRequest(published, "bundle"));
  assert.equal(committed.status, "committed");
  const opened = await store.openContent(contentRequest(published, published.artifacts[0]));
  assert.deepEqual(await read(opened), issued.files.bytes[0]);
  const ranged = await store.openContent(contentRequest(published, published.artifacts[0], { range: { start: 2, end: 6 } }));
  assert.deepEqual(await read(ranged), issued.files.bytes[0].subarray(2, 7));
  const metadata = await store.openContent(contentRequest(published, published.artifacts[1], { metadataOnly: true }));
  assert.equal(metadata.stream, null);
  assert.equal(metadata.metadata.mime, "image/png");
  await expectCode(
    () => store.openContent(contentRequest(published, published.artifacts[0], {
      scope: { ...scope, browserSessionId: "b".repeat(64) },
    })),
    "NOT_FOUND"
  );
  await store.close();
  store = await openIntegrationFileWorkerStore({ stateRoot: root });
  const reopened = await store.openContent(contentRequest(published, published.artifacts[1]));
  assert.deepEqual(await read(reopened), issued.files.bytes[1]);
  const objects = published.artifacts.map(({ ref }) => Object.freeze({
    ref,
    runId: scope.runId,
    receiptDigest: published.receipt.digest,
  })).sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  const deletionId = `fdel_${sha256(Buffer.from("delete:bundle", "utf8"))}`;
  const deleteRequest = (phase, selected = objects) => Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
    deletionId,
    phase,
    scope: threadScope,
    objects: Object.freeze(selected),
  });
  await expectCode(() => store.delete(deleteRequest("prepare", objects.slice(0, 1))), "INVALID_REQUEST");
  assert.equal((await store.delete(deleteRequest("prepare"))).status, "prepared");
  assert.equal((await store.delete(deleteRequest("commit"))).status, "committed");
  await expectCode(() => store.openContent(contentRequest(published, published.artifacts[0])), "ARTIFACT_CONTENT_GONE");
  await store.close();

  const recoveryParent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-worker-recovery-"));
  roots.push(recoveryParent);
  const recoveryRoot = path.join(recoveryParent, "state");
  let interrupted = true;
  store = await openIntegrationFileWorkerStore({
    stateRoot: recoveryRoot,
    checkpoint(name) {
      if (interrupted && name === "file-after-commit-ledger-before-objects") {
        interrupted = false;
        throw new Error("simulated interruption");
      }
    },
  });
  const recoveryIssued = await issuedRequest(store, "recover");
  const recoveryPublished = await store.publish(recoveryIssued.request);
  await assert.rejects(() => store.commit(commitRequest(recoveryPublished, "recover")), /simulated interruption/u);
  await store.close();
  store = await openIntegrationFileWorkerStore({ stateRoot: recoveryRoot });
  const recovered = await store.openContent(contentRequest(recoveryPublished, recoveryPublished.artifacts[0]));
  assert.deepEqual(await read(recovered), recoveryIssued.files.bytes[0]);
  await store.close();

  const tamperParent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-worker-tamper-"));
  roots.push(tamperParent);
  const tamperRoot = path.join(tamperParent, "state");
  store = await openIntegrationFileWorkerStore({ stateRoot: tamperRoot });
  const tamperIssued = await issuedRequest(store, "tamper");
  const tamperPublished = await store.publish(tamperIssued.request);
  await store.commit(commitRequest(tamperPublished, "tamper"));
  await fs.writeFile(path.join(tamperRoot, "objects", tamperPublished.artifacts[0].ref), "changed", { mode: 0o600 });
  await expectCode(
    () => store.openContent(contentRequest(tamperPublished, tamperPublished.artifacts[0])),
    "WORKER_STATE_UNAVAILABLE"
  );

  console.log("integration file worker store smoke passed");
} finally {
  await Promise.allSettled(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
