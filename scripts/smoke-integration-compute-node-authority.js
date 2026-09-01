#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertIntegrationComputeNodeAuthority,
  buildComputeNodeCapabilityEvidence,
  openIntegrationComputeNodeAuthority,
} from "../src/integration-compute-node-authority.js";

const BASE_TIME_MS = Date.parse("2026-09-01T00:00:00.000Z");
const UID = process.getuid();
const GID = process.getgid();

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function nowAt(offsetMs = 0) {
  return new Date(BASE_TIME_MS + offsetMs);
}

function iso(offsetMs = 0) {
  return nowAt(offsetMs).toISOString();
}

function workerId(seed) {
  return `worker_${seed.repeat(24)}`;
}

function leaseId(seed) {
  return `lease_${seed.repeat(24)}`;
}

function evidence(seed, overrides = {}) {
  const unsigned = {
    schemaVersion: "aginti-compute-node-capability-evidence-v1",
    workerId: workerId(seed),
    role: "execution-worker",
    releaseDigest: digest(`release-${seed}`),
    capabilityDigest: digest(`capability-${seed}`),
    healthDigest: digest(`health-${seed}`),
    admitted: true,
    observedAt: iso(0),
    expiresAt: iso(60_000),
    ...overrides,
  };
  return buildComputeNodeCapabilityEvidence(unsigned);
}

async function withRoot(label, action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aginti-compute-node-${label}-`));
  await fs.chmod(root, 0o700);
  try {
    return await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function expectCode(action, expectedCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
    const codes = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
    if (codes.includes(error?.code) || codes.includes(error?.publicCode)) return error;
  }
  if (!captured) assert.fail(`Expected ${expectedCode}, but operation completed.`);
  assert.fail(`Expected ${expectedCode}, got ${captured?.code || captured?.name}: ${captured?.message}`);
}

async function expectNoMutation(authority, action, code) {
  const before = await authority.inspect();
  await expectCode(action, code);
  const after = await authority.inspect();
  assert.equal(after.revision, before.revision);
  assert.equal(after.stateDigest, before.stateDigest);
}

async function open(root, offsetMs = 0) {
  return openIntegrationComputeNodeAuthority({
    stateRoot: root,
    ownerUid: UID,
    ownerGid: GID,
    now: () => nowAt(offsetMs),
  });
}

async function smokeLifecycle() {
  await withRoot("lifecycle", async (root) => {
    let authority = await open(root);
    assertIntegrationComputeNodeAuthority(authority);
    assert.equal(JSON.stringify(authority.attestation).includes("http://"), false);
    assert.equal(authority.attestation.discovery, false);
    assert.equal(authority.attestation.secrets, false);
    assert.equal(authority.attestation.publicEndpoints, false);

    let summary = await authority.inspect();
    assert.equal(summary.revision, 0);
    assert.equal(summary.nodes.length, 0);

    const nodeA = await authority.enrollNode(evidence("A"));
    assert.equal(nodeA.workerId, workerId("A"));
    assert.equal(nodeA.status, "admitted");
    summary = await authority.inspect();
    assert.equal(summary.revision, 1);

    const duplicateA = await authority.enrollNode(evidence("A"));
    assert.deepEqual(duplicateA, nodeA);
    assert.equal((await authority.inspect()).revision, 1);

    await expectNoMutation(
      authority,
      () => authority.enrollNode(evidence("A", { healthDigest: digest("new-health") })),
      "COMPUTE_NODE_CAS_CONFLICT"
    );
    await expectNoMutation(
      authority,
      () => authority.enrollNode({ ...evidence("C"), endpoint: "http://127.0.0.1" }),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );
    await expectNoMutation(
      authority,
      () => authority.enrollNode({ ...evidence("C"), token: "secret" }),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );

    const assignmentA = await authority.assignRole({
      role: "execution-worker",
      workerId: workerId("A"),
      expectedFencingEpoch: 0,
      expectedRevision: 1,
    });
    assert.equal(assignmentA.fencingEpoch, 1);
    assert.equal((await authority.inspect()).revision, 2);
    await expectNoMutation(
      authority,
      () => authority.assignRole({
        role: "execution-worker",
        workerId: workerId("A"),
        expectedFencingEpoch: 0,
        expectedRevision: 2,
      }),
      "COMPUTE_NODE_CAS_CONFLICT"
    );

    await expectNoMutation(
      authority,
      () => authority.claimLease({
        leaseId: leaseId("A"),
        runId: "run-stale",
        role: "execution-worker",
        workerId: workerId("A"),
        fencingEpoch: 0,
        expiresAt: iso(120_000),
        expectedRevision: 2,
      }),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );

    const leaseA = await authority.claimLease({
      leaseId: leaseId("A"),
      runId: "run-one",
      role: "execution-worker",
      workerId: workerId("A"),
      fencingEpoch: 1,
      expiresAt: iso(120_000),
      expectedRevision: 2,
    });
    assert.equal(leaseA.releasedAt, null);
    assert.equal((await authority.inspect()).revision, 3);
    const leaseReplay = await authority.claimLease({
      leaseId: leaseId("A"),
      runId: "run-one",
      role: "execution-worker",
      workerId: workerId("A"),
      fencingEpoch: 1,
      expiresAt: iso(120_000),
      expectedRevision: 3,
    });
    assert.deepEqual(leaseReplay, leaseA);
    assert.equal((await authority.inspect()).revision, 3);

    const drainingA = await authority.drainNode({ workerId: workerId("A"), expectedRevision: 3 });
    assert.equal(drainingA.status, "draining");
    assert.equal((await authority.inspect()).revision, 4);
    await expectNoMutation(
      authority,
      () => authority.claimLease({
        leaseId: leaseId("D"),
        runId: "run-draining",
        role: "execution-worker",
        workerId: workerId("A"),
        fencingEpoch: 1,
        expiresAt: iso(120_000),
        expectedRevision: 4,
      }),
      "COMPUTE_NODE_LEASE_FORBIDDEN"
    );

    const nodeB = await authority.enrollNode(evidence("B"));
    assert.equal(nodeB.status, "admitted");
    assert.equal((await authority.inspect()).revision, 5);
    const assignmentB = await authority.assignRole({
      role: "execution-worker",
      workerId: workerId("B"),
      expectedFencingEpoch: 1,
      expectedRevision: 5,
    });
    assert.equal(assignmentB.fencingEpoch, 2);
    assert.equal((await authority.inspect()).revision, 6);
    await expectNoMutation(
      authority,
      () => authority.removeNode({ workerId: workerId("A"), expectedRevision: 6 }),
      "COMPUTE_NODE_REMOVE_CONFLICT"
    );
    const releasedA = await authority.releaseLease({
      leaseId: leaseId("A"),
      runId: "run-one",
      expectedRevision: 6,
    });
    assert.notEqual(releasedA.releasedAt, null);
    assert.equal((await authority.inspect()).revision, 7);
    const removedA = await authority.removeNode({ workerId: workerId("A"), expectedRevision: 7 });
    assert.equal(removedA.status, "removed");
    assert.equal((await authority.inspect()).revision, 8);
    await expectNoMutation(
      authority,
      () => authority.enrollNode(evidence("A")),
      "COMPUTE_NODE_REMOVED"
    );
    await expectNoMutation(
      authority,
      () => authority.assignRole({
        role: "execution-worker",
        workerId: workerId("A"),
        expectedFencingEpoch: 2,
        expectedRevision: 8,
      }),
      "COMPUTE_NODE_ASSIGNMENT_FORBIDDEN"
    );
    await expectNoMutation(
      authority,
      () => authority.claimLease({
        leaseId: leaseId("B"),
        runId: "run-stale-b",
        role: "execution-worker",
        workerId: workerId("B"),
        fencingEpoch: 1,
        expiresAt: iso(120_000),
        expectedRevision: 8,
      }),
      "COMPUTE_NODE_LEASE_FENCE_MISMATCH"
    );
    const leaseB = await authority.claimLease({
      leaseId: leaseId("B"),
      runId: "run-two",
      role: "execution-worker",
      workerId: workerId("B"),
      fencingEpoch: 2,
      expiresAt: iso(120_000),
      expectedRevision: 8,
    });
    assert.equal(leaseB.fencingEpoch, 2);
    assert.equal((await authority.inspect()).revision, 9);
    await authority.releaseLease({ leaseId: leaseId("B"), runId: "run-two", expectedRevision: 9 });
    assert.equal((await authority.inspect()).revision, 10);
    await expectNoMutation(
      authority,
      () => authority.removeNode({ workerId: workerId("B"), expectedRevision: 10 }),
      "COMPUTE_NODE_REMOVE_CONFLICT"
    );

    await authority.close();
    authority = await open(root);
    const restarted = await authority.inspect();
    assert.equal(restarted.revision, 10);
    assert.deepEqual(await authority.getActiveAssignment({ role: "execution-worker" }), assignmentB);
    await authority.close();
  });
}

async function smokeEvidenceBoundary() {
  await withRoot("evidence", async (root) => {
    const authority = await open(root);
    const admitted = evidence("E");
    const mismatchedDigest = { ...admitted, evidenceDigest: digest("wrong") };
    await expectNoMutation(authority, () => authority.enrollNode(mismatchedDigest), "COMPUTE_NODE_AUTHORITY_INVALID");
    await expectNoMutation(
      authority,
      () => authority.enrollNode(evidence("F", { admitted: false })),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );
    await expectNoMutation(
      authority,
      () => authority.enrollNode(evidence("G", { expiresAt: iso(-1) })),
      "COMPUTE_NODE_EVIDENCE_STALE"
    );
    await expectNoMutation(
      authority,
      () => authority.enrollNode(evidence("H", { expiresAt: iso(10 * 60 * 1000) })),
      "COMPUTE_NODE_EVIDENCE_STALE"
    );

    let traps = 0;
    const proxied = new Proxy(admitted, {
      get() {
        traps += 1;
        throw new Error("proxy trap executed");
      },
    });
    await expectNoMutation(authority, () => authority.enrollNode(proxied), "COMPUTE_NODE_AUTHORITY_INVALID");
    assert.equal(traps, 0);

    const accessor = { ...admitted };
    Object.defineProperty(accessor, "workerId", {
      enumerable: true,
      configurable: true,
      get() {
        traps += 1;
        return workerId("E");
      },
    });
    await expectNoMutation(authority, () => authority.enrollNode(accessor), "COMPUTE_NODE_AUTHORITY_INVALID");
    assert.equal(traps, 0);
    await authority.close();
  });
}

async function smokeOpenBoundary() {
  await withRoot("open", async (root) => {
    let traps = 0;
    const proxied = new Proxy({ stateRoot: root, ownerUid: UID, ownerGid: GID }, {
      get() {
        traps += 1;
        throw new Error("proxy trap executed");
      },
    });
    await expectCode(
      () => openIntegrationComputeNodeAuthority(proxied),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );
    assert.equal(traps, 0);

    const accessor = { ownerUid: UID, ownerGid: GID };
    Object.defineProperty(accessor, "stateRoot", {
      enumerable: true,
      get() {
        traps += 1;
        return root;
      },
    });
    await expectCode(
      () => openIntegrationComputeNodeAuthority(accessor),
      "COMPUTE_NODE_AUTHORITY_INVALID"
    );
    assert.equal(traps, 0);

    const authority = await open(root);
    const expected = {
      stateRootDigest: authority.attestation.stateRootDigest,
      rootIdentityDigest: authority.attestation.rootIdentityDigest,
    };
    assert.equal(assertIntegrationComputeNodeAuthority(authority, expected), authority);
    assert.throws(
      () => assertIntegrationComputeNodeAuthority(authority, { ...expected, stateRootDigest: digest("other") }),
      /state root digest/u
    );
    await authority.close();
  });
}

async function smokeFilesystemBoundary() {
  await withRoot("fs", async (root) => {
    const stateFile = path.join(root, "compute-nodes.json");
    const authority = await open(root);
    await authority.enrollNode(evidence("S"));
    await authority.close();

    await fs.chmod(stateFile, 0o644);
    let reopened = await open(root);
    await expectCode(() => reopened.inspect(), "COMPUTE_NODE_AUTHORITY_CORRUPT");
    await reopened.close();
    await fs.chmod(stateFile, 0o600);

    await fs.link(stateFile, `${stateFile}.hardlink`);
    reopened = await open(root);
    await expectCode(() => reopened.inspect(), "COMPUTE_NODE_AUTHORITY_CORRUPT");
    await reopened.close();
    await fs.unlink(`${stateFile}.hardlink`);

    const backup = `${stateFile}.real`;
    await fs.rename(stateFile, backup);
    await fs.symlink(backup, stateFile);
    reopened = await open(root);
    await expectCode(() => reopened.inspect(), "COMPUTE_NODE_AUTHORITY_CORRUPT");
    await reopened.close();
    await fs.unlink(stateFile);
    await fs.rename(backup, stateFile);

    const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
    raw.extra = true;
    await fs.writeFile(stateFile, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    reopened = await open(root);
    await expectCode(
      () => reopened.inspect(),
      ["COMPUTE_NODE_AUTHORITY_INVALID", "COMPUTE_NODE_AUTHORITY_CORRUPT"]
    );
    await reopened.close();

    await fs.writeFile(stateFile, "{", { mode: 0o600 });
    reopened = await open(root);
    await expectCode(() => reopened.inspect(), "COMPUTE_NODE_AUTHORITY_CORRUPT");
    await reopened.close();
  });

  await withRoot("root-mode", async (root) => {
    await fs.chmod(root, 0o755);
    await expectCode(() => open(root), "COMPUTE_NODE_AUTHORITY_UNAVAILABLE");
  });

  await withRoot("root-symlink-target", async (target) => {
    const link = `${target}-link`;
    await fs.symlink(target, link);
    try {
      await expectCode(() => open(link), "COMPUTE_NODE_AUTHORITY_UNAVAILABLE");
    } finally {
      await fs.unlink(link).catch(() => {});
    }
  });
}

async function smokeRejectedOperationsLeaveState() {
  await withRoot("nomutation", async (root) => {
    const authority = await open(root);
    await authority.enrollNode(evidence("N"));
    const before = await authority.inspect();
    await expectCode(
      () => authority.assignRole({
        role: "execution-worker",
        workerId: workerId("N"),
        expectedFencingEpoch: 0,
        expectedRevision: 99,
      }),
      "COMPUTE_NODE_CAS_CONFLICT"
    );
    await expectCode(
      () => authority.claimLease({
        leaseId: leaseId("N"),
        runId: "run-nomutation",
        role: "execution-worker",
        workerId: workerId("N"),
        fencingEpoch: 1,
        expiresAt: iso(120_000),
        expectedRevision: before.revision,
      }),
      "COMPUTE_NODE_LEASE_FENCE_MISMATCH"
    );
    const after = await authority.inspect();
    assert.equal(after.revision, before.revision);
    assert.equal(after.stateDigest, before.stateDigest);
    await authority.close();
  });
}

await smokeLifecycle();
await smokeEvidenceBoundary();
await smokeOpenBoundary();
await smokeFilesystemBoundary();
await smokeRejectedOperationsLeaveState();

console.log("smoke-integration-compute-node-authority ok");
