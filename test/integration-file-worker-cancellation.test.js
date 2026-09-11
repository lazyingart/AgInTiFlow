import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openIntegrationFileWorkerStore, FILE_WORKER_STAGED_GROUP_TTL_MS } from "../src/integration-file-worker-store.js";
import { FILE_WORKER_SCHEMA_VERSIONS as FILE } from "../src/integration-file-worker-contract.js";
import { scope, pdf, sha256, issueRequest, importRequest, commitRequest, contentRequest } from "./fixtures/acquired-paper.js";

async function fixture(t, profile, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-file-cancel-"));
  const stateRoot = path.join(parent, "files");
  let store = await openIntegrationFileWorkerStore({ stateRoot, ...options });
  t.after(async () => { await store.close().catch(() => {}); await fs.rm(parent, { recursive: true, force: true }); });
  let imported;
  let replay;
  if (profile === "paper") {
    const bytes = pdf();
    const issue = issueRequest(bytes);
    const request = importRequest(issue, await store.issueAcquiredPaper(issue));
    imported = await store.importAcquiredPaper(request, bytes);
    replay = () => store.importAcquiredPaper(request, bytes);
  } else {
    const { source: _source, ...base } = issueRequest(pdf());
    const files = ["first.txt", "second.txt"].map((filename, index) => ({
      index, filename, mime: "text/plain", bytes: 4, sha256: sha256("test"), encoding: "utf8", content: "test",
    }));
    const issue = { ...base, schemaVersion: FILE.issueRequest,
      files: files.map(({ encoding: _encoding, content: _content, ...file }) => file) };
    const authority = await store.issue(issue);
    const request = { ...issue, schemaVersion: FILE.publishRequest,
      requestId: authority.requestId, authorityToken: authority.authorityToken, files };
    imported = await store.publish(request);
    replay = () => store.publish(request);
  }
  const { runId, ...threadScope } = scope;
  const deletion = { schemaVersion: FILE.deleteRequest, deletionId: `fdel_${sha256(profile)}`, phase: "prepare", scope: threadScope,
    objects: imported.artifacts.map(artifact => ({ ref: artifact.ref, runId, receiptDigest: imported.receipt.digest }))
      .sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) };
  return {
    get store() { return store; }, stateRoot, imported, deletion, replay,
    async reopen() { await store.close().catch(() => {}); store = await openIntegrationFileWorkerStore({ stateRoot, now: options.now }); },
    async ledger() { return JSON.parse(await fs.readFile(path.join(stateRoot, "ledger.json"), "utf8")).payload; },
  };
}

for (const profile of ["paper", "generated"]) {
  for (const crash of ["prepared", "file-after-delete-ledger-before-unlink", "file-after-delete-unlink-before-ledger"]) {
    test(`${profile} staged cancellation recovers from ${crash}`, async t => {
      const f = await fixture(t, profile, { checkpoint(name) { if (name === crash) throw new Error("controlled delete crash"); } });
      if (profile === "generated") {
        await assert.rejects(f.store.delete({ ...f.deletion, objects: f.deletion.objects.slice(0, 1) }), error => error.status === 400);
      }
      assert.equal((await f.store.delete(f.deletion)).status, "prepared");
      await assert.rejects(f.store.commit(commitRequest(f.imported)), error => error.code === "ARTIFACT_DELETE_PENDING");
      await assert.rejects(f.store.openContent(contentRequest(f.imported)), error => error.code === "ARTIFACT_DELETE_PENDING");
      if (crash === "prepared") {
        await f.reopen();
        assert.equal((await f.store.delete({ ...f.deletion, phase: "commit" })).status, "committed");
      } else {
        await assert.rejects(f.store.delete({ ...f.deletion, phase: "commit" }), /controlled delete crash/u);
        await f.reopen();
      }
      assert.equal((await f.store.delete({ ...f.deletion, phase: "status" })).status, "committed");
      await assert.rejects(f.replay(), error => error.status === 410);
      await assert.rejects(f.store.openContent(contentRequest(f.imported)), error => error.status === 410);
      assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "stages")), []);
      assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "objects")), []);
      const ledger = await f.ledger();
      assert.equal(ledger.groups[0].committedAt, null);
      assert.equal(ledger.groups[0].state, "tombstoned");
      assert.equal(ledger.commits.length, 0);
      await f.reopen();
      assert.equal((await f.store.inspect()).stagedGroups, 0);
      assert.equal((await f.store.inspect()).committedGroups, 0);
      assert.equal((await f.store.inspect()).pendingDeletions, 0);
    });
  }
  test(`${profile} staged expiry remains uncommitted across restart`, async t => {
    let instant = Date.now();
    const f = await fixture(t, profile, { now: () => new Date(instant) });
    instant += FILE_WORKER_STAGED_GROUP_TTL_MS + 1;
    await f.reopen();
    const ledger = await f.ledger();
    assert.equal(ledger.groups[0].state, "tombstoned");
    assert.equal(ledger.groups[0].committedAt, null);
    assert.equal(ledger.commits.length, 0);
    await assert.rejects(f.replay(), error => error.status === 410);
    await f.reopen();
    assert.equal((await f.store.inspect()).stagedGroups, 0);
    assert.deepEqual(await fs.readdir(path.join(f.stateRoot, "stages")), []);
  });
}
