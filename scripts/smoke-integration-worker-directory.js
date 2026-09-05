import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  IntegrationWorkerDirectoryError,
  createIntegrationWorkerDirectory,
  createWorkerAdmission,
} from "../src/integration-worker-directory.js";
import { contractDigest } from "../src/integration-policy.js";

const NODE_A = Object.freeze({
  nodeId: "node_workstation_a_01",
  bindingId: "binding_workstation_a_01",
  platform: "workstation",
  roles: Object.freeze(["execution", "text-inference"]),
});
const NODE_B = Object.freeze({
  nodeId: "node_jetson_worker_01",
  bindingId: "binding_jetson_worker_01",
  platform: "jetson",
  roles: Object.freeze(["execution", "vision-inference"]),
});
const NODE_C = Object.freeze({
  nodeId: "node_kria_worker_0001",
  bindingId: "binding_kria_worker_0001",
  platform: "kria",
  roles: Object.freeze(["execution"]),
});
const OWNER_DIGEST = contractDigest({ owner: "smoke-job-1" });
const RELEASE_DIGEST = contractDigest({ release: "worker-r1" });
const CAPABILITIES_DIGEST = contractDigest({ roles: ["execution"] });
const CANARY_DIGEST = contractDigest({ canary: "ready" });

let clockMs = Date.parse("2026-09-02T08:00:00.000Z");
let randomCounter = 0;
const probeMode = new Map();

function now() {
  return new Date(clockMs);
}

function randomHex(bytes) {
  randomCounter += 1;
  return randomCounter.toString(16).padStart(bytes * 2, "0");
}

function admission(candidate, { observedMs = clockMs, expiresMs = clockMs + 5 * 60_000 } = {}) {
  return createWorkerAdmission(candidate, {
    transport: "lazyedge-private-http-v1",
    releaseId: "worker-r1",
    releaseDigest: RELEASE_DIGEST,
    capabilitiesDigest: CAPABILITIES_DIGEST,
    canaryDigest: CANARY_DIGEST,
    protocols: ["aginti-execution-worker-v1"],
    observedAt: new Date(observedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
  });
}

function smokeAdmissionProtocolCanonicalization() {
  const unsorted = ["aginti-execution-worker-api-v1", "aginti-execution-job-manager-v1"];
  const canonical = createWorkerAdmission(NODE_A, {
    transport: "lazyedge-private-http-v1",
    releaseId: "worker-r1",
    releaseDigest: RELEASE_DIGEST,
    capabilitiesDigest: CAPABILITIES_DIGEST,
    canaryDigest: CANARY_DIGEST,
    protocols: unsorted,
    observedAt: new Date(clockMs).toISOString(),
    expiresAt: new Date(clockMs + 5 * 60_000).toISOString(),
  });
  assert.deepEqual(canonical.protocols, ["aginti-execution-job-manager-v1", "aginti-execution-worker-api-v1"]);
  const { digest, ...unsigned } = canonical;
  assert.equal(digest, contractDigest(unsigned));
  const reversed = createWorkerAdmission(NODE_A, {
    transport: "lazyedge-private-http-v1",
    releaseId: "worker-r1",
    releaseDigest: RELEASE_DIGEST,
    capabilitiesDigest: CAPABILITIES_DIGEST,
    canaryDigest: CANARY_DIGEST,
    protocols: [...unsorted].reverse(),
    observedAt: new Date(clockMs).toISOString(),
    expiresAt: new Date(clockMs + 5 * 60_000).toISOString(),
  });
  assert.equal(reversed.digest, canonical.digest);
  assert.throws(
    () => createWorkerAdmission(NODE_A, {
      transport: "lazyedge-private-http-v1",
      releaseId: "worker-r1",
      releaseDigest: RELEASE_DIGEST,
      capabilitiesDigest: CAPABILITIES_DIGEST,
      canaryDigest: CANARY_DIGEST,
      protocols: [unsorted[0], unsorted[0]],
      observedAt: new Date(clockMs).toISOString(),
      expiresAt: new Date(clockMs + 5 * 60_000).toISOString(),
    }),
    (error) => error instanceof IntegrationWorkerDirectoryError && error.code === "WORKER_ADMISSION_INVALID"
  );
  assert.throws(
    () => createWorkerAdmission(NODE_A, {
      transport: "lazyedge-private-http-v1",
      releaseId: "worker-r1",
      releaseDigest: RELEASE_DIGEST,
      capabilitiesDigest: CAPABILITIES_DIGEST,
      canaryDigest: CANARY_DIGEST,
      protocols: ["not valid"],
      observedAt: new Date(clockMs).toISOString(),
      expiresAt: new Date(clockMs + 5 * 60_000).toISOString(),
    }),
    (error) => error instanceof IntegrationWorkerDirectoryError && error.code === "WORKER_ADMISSION_INVALID"
  );
}

async function probe(candidate) {
  if (probeMode.get(candidate.nodeId) === "stale") {
    return admission(candidate, {
      observedMs: clockMs - 6 * 60_000,
      expiresMs: clockMs - 60_000,
    });
  }
  if (probeMode.get(candidate.nodeId) === "mismatch") return admission(NODE_A);
  return admission(candidate);
}

async function expectCode(operation, code) {
  let caught = null;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof IntegrationWorkerDirectoryError, `expected ${code}, got ${caught?.name}`);
  assert.equal(caught.code, code);
  return caught;
}

async function createDirectory(rootDir, overrides = {}) {
  return createIntegrationWorkerDirectory({ rootDir, probe, now, randomHex, ...overrides });
}

async function assertProtectedStore(rootDir) {
  const statePath = path.join(rootDir, "state", "directory.json");
  assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(statePath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  return statePath;
}

async function smokeLifecycle(rootDir) {
  const directory = await createDirectory(rootDir);
  assert.equal(directory.attestation.coordinatorOwnedAssignments, true);
  assert.equal(directory.attestation.callerSelectableEndpoint, false);
  assert.equal(directory.attestation.callerSelectableCredential, false);
  assert.equal(directory.attestation.lazyEdgeOwnsTransportOnly, true);

  await expectCode(
    () => directory.enroll({ ...NODE_C, endpoint: "http://caller.invalid" }),
    "WORKER_DIRECTORY_INVALID"
  );
  await expectCode(
    () => directory.enroll({ ...NODE_C, credential: "caller-secret" }),
    "WORKER_DIRECTORY_INVALID"
  );

  await directory.enroll(NODE_A);
  const first = await directory.switchRole("execution", NODE_A.nodeId, { expectedGeneration: 0 });
  assert.equal(first.generation, 1);
  assert.equal(first.previousNodeId, null);
  assert.deepEqual(await directory.resolve("execution"), {
    role: "execution",
    nodeId: NODE_A.nodeId,
    bindingId: NODE_A.bindingId,
    generation: 1,
    admissionDigest: admission(NODE_A).digest,
  });
  const leaseA = await directory.acquire("execution", OWNER_DIGEST, {
    expectedGeneration: 1,
    ttlMs: 60_000,
  });

  await directory.enroll(NODE_B);
  const switched = await directory.switchRole("execution", NODE_B.nodeId, { expectedGeneration: 1 });
  assert.equal(switched.generation, 2);
  assert.equal(switched.previousNodeId, NODE_A.nodeId);
  assert.equal((await directory.resolve("execution")).nodeId, NODE_B.nodeId);
  const leasedRoute = await directory.resolveLease(leaseA.leaseId, OWNER_DIGEST);
  assert.equal(leasedRoute.nodeId, NODE_A.nodeId);
  assert.equal(leasedRoute.bindingId, NODE_A.bindingId);
  assert.equal(leasedRoute.assignmentGeneration, 1);
  await expectCode(
    () => directory.resolveLease(leaseA.leaseId, contractDigest({ owner: "another-job" })),
    "WORKER_LEASE_NOT_FOUND"
  );
  await expectCode(
    () => directory.finalizeRole("execution", { expectedGeneration: 2 }),
    "WORKER_DRAIN_INCOMPLETE"
  );
  await expectCode(
    () => directory.switchRole("execution", NODE_A.nodeId, { expectedGeneration: 2 }),
    "WORKER_SWITCH_PENDING"
  );
  await expectCode(
    () => directory.rollbackRole("execution", { expectedGeneration: 1 }),
    "WORKER_ASSIGNMENT_CONFLICT"
  );

  const rolledBack = await directory.rollbackRole("execution", { expectedGeneration: 2 });
  assert.equal(rolledBack.nodeId, NODE_A.nodeId);
  assert.equal(rolledBack.previousNodeId, NODE_B.nodeId);
  assert.equal(rolledBack.generation, 3);
  const restored = await directory.rollbackRole("execution", { expectedGeneration: 3 });
  assert.equal(restored.nodeId, NODE_B.nodeId);
  assert.equal(restored.previousNodeId, NODE_A.nodeId);
  assert.equal(restored.generation, 4);

  await directory.releaseLease(leaseA.leaseId, OWNER_DIGEST);
  const finalized = await directory.finalizeRole("execution", { expectedGeneration: 4 });
  assert.equal(finalized.previousNodeId, null);
  await directory.retire(NODE_A.nodeId);
  await directory.remove(NODE_A.nodeId);

  const expiringLease = await directory.acquire("execution", OWNER_DIGEST, { ttlMs: 1_000 });
  clockMs += 1_500;
  assert.equal((await directory.status()).leases.length, 0);
  await expectCode(
    () => directory.renewLease(expiringLease.leaseId, OWNER_DIGEST, { ttlMs: 60_000 }),
    "WORKER_LEASE_NOT_FOUND"
  );

  probeMode.set(NODE_C.nodeId, "stale");
  await expectCode(() => directory.enroll(NODE_C), "WORKER_ADMISSION_STALE");
  probeMode.set(NODE_C.nodeId, "mismatch");
  await expectCode(() => directory.enroll(NODE_C), "WORKER_ADMISSION_INVALID");
  probeMode.delete(NODE_C.nodeId);
  await directory.enroll(NODE_C);
  await directory.retire(NODE_C.nodeId);
  await expectCode(
    () => directory.switchRole("execution", NODE_C.nodeId, { expectedGeneration: 4 }),
    "WORKER_NOT_READY"
  );
  await directory.remove(NODE_C.nodeId);

  const beforeRestart = await directory.status();
  const events = await directory.events();
  assert.equal(events.length, 12);
  assert.equal(events.at(-1).hash, beforeRestart.eventCursor.lastHash);
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].previousHash, events[index - 1].hash);
    assert.equal(events[index].seq, index + 1);
  }

  const restarted = await createDirectory(rootDir);
  const afterRestart = await restarted.status();
  assert.equal(afterRestart.revision, beforeRestart.revision);
  assert.equal(afterRestart.eventCursor.lastHash, beforeRestart.eventCursor.lastHash);
  assert.equal((await restarted.resolve("execution")).nodeId, NODE_B.nodeId);
  assert.equal(afterRestart.nodes.some(({ nodeId }) => nodeId === NODE_A.nodeId), false);
  return { beforeRestart, events };
}

async function smokeInvalidRandom(rootDir) {
  const directory = await createDirectory(rootDir, { randomHex: () => "not-hex" });
  await expectCode(
    () => directory.enroll(NODE_A),
    "WORKER_DIRECTORY_RANDOM_INVALID"
  );
  assert.equal((await directory.status()).nodes.length, 0);
  assert.equal((await directory.status()).assignments.length, 0);
}

async function smokeAcquireAutoRenewal(rootDir) {
  let localClockMs = Date.parse("2026-09-02T10:00:00.000Z");
  let mode = "ok";
  let probeCalls = [];
  function localNow() {
    return new Date(localClockMs);
  }
  async function localProbe(candidate) {
    probeCalls.push({ nodeId: candidate.nodeId, at: localNow().toISOString(), mode });
    if (mode === "throw") throw new Error("worker readiness route unavailable");
    const lifetimeMs = mode === "short" ? 30_000 : 5 * 60_000;
    return createWorkerAdmission(candidate, {
      transport: "lazyedge-private-http-v1",
      releaseId: "worker-r1",
      releaseDigest: RELEASE_DIGEST,
      capabilitiesDigest: CAPABILITIES_DIGEST,
      canaryDigest: CANARY_DIGEST,
      protocols: ["aginti-execution-worker-api-v1", "aginti-execution-job-manager-v1"],
      observedAt: new Date(localClockMs).toISOString(),
      expiresAt: new Date(localClockMs + lifetimeMs).toISOString(),
    });
  }
  const directory = await createIntegrationWorkerDirectory({
    rootDir,
    probe: localProbe,
    now: localNow,
    randomHex,
  });
  await directory.enroll(NODE_A);
  await directory.switchRole("execution", NODE_A.nodeId, { expectedGeneration: 0 });

  probeCalls = [];
  const freshEvents = (await directory.events()).length;
  const freshLease = await directory.acquire("execution", OWNER_DIGEST, { ttlMs: 60_000 });
  assert.equal(probeCalls.length, 0, "fresh assigned admission triggered a redundant probe");
  assert.equal(Date.parse(freshLease.expiresAt), localClockMs + 60_000);
  assert.equal((await directory.events()).length, freshEvents, "fresh acquire appended a redundant event");
  await directory.releaseLease(freshLease.leaseId, OWNER_DIGEST);

  localClockMs += 4 * 60_000 + 30_000;
  probeCalls = [];
  const nearEvents = (await directory.events()).length;
  const nearLease = await directory.acquire("execution", OWNER_DIGEST, { ttlMs: 60_000 });
  assert.equal(probeCalls.length, 1, "near-expiry assigned admission was not refreshed");
  assert.equal(Date.parse(nearLease.expiresAt), localClockMs + 60_000);
  assert.equal((await directory.events()).length, nearEvents + 1, "auto renewal did not append a node.renewed event");
  const nearStatus = await directory.status();
  const nearResolve = await directory.resolve("execution");
  assert.equal(nearResolve.admissionDigest, nearStatus.nodes.find(({ nodeId }) => nodeId === NODE_A.nodeId).admission.digest);
  await directory.releaseLease(nearLease.leaseId, OWNER_DIGEST);

  localClockMs += 6 * 60_000;
  probeCalls = [];
  const expiredLease = await directory.acquire("execution", OWNER_DIGEST, { ttlMs: 60_000 });
  assert.equal(probeCalls.length, 1, "expired assigned admission did not self-recover");
  assert.equal(Date.parse(expiredLease.expiresAt), localClockMs + 60_000);
  await directory.releaseLease(expiredLease.leaseId, OWNER_DIGEST);

  localClockMs += 4 * 60_000 + 45_000;
  mode = "throw";
  probeCalls = [];
  const beforeFailure = await directory.status();
  await expectCode(() => directory.acquire("execution", OWNER_DIGEST, { ttlMs: 60_000 }), "WORKER_PROBE_UNAVAILABLE");
  const afterFailure = await directory.status();
  assert.equal(probeCalls.length, 1, "probe failure regression did not exercise the probe");
  assert.equal(afterFailure.revision, beforeFailure.revision);
  assert.equal(afterFailure.integrityDigest, beforeFailure.integrityDigest);
  assert.deepEqual(afterFailure.assignments, beforeFailure.assignments);

  mode = "short";
  probeCalls = [];
  await expectCode(() => directory.acquire("execution", OWNER_DIGEST, { ttlMs: 60_000 }), "WORKER_ADMISSION_STALE");
  assert.equal(probeCalls.length, 1, "short-admission regression did not exercise the probe");
}

async function smokeTamper(caseRoot, kind) {
  const rootDir = path.join(caseRoot, kind);
  const directory = await createDirectory(rootDir);
  await directory.enroll(NODE_A);
  const statePath = await assertProtectedStore(rootDir);

  if (kind === "corrupt") {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.revision += 1;
    await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } else if (kind === "symlink") {
    const outside = path.join(caseRoot, "symlink-sentinel.json");
    await fs.writeFile(outside, "{}\n", { mode: 0o600 });
    await fs.unlink(statePath);
    await fs.symlink(outside, statePath);
  } else if (kind === "hardlink") {
    await fs.link(statePath, path.join(caseRoot, "hardlink-witness.json"));
  }

  await assert.rejects(() => createDirectory(rootDir));
}

const roots = [];
try {
  const lifecycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-worker-directory-"));
  const randomRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-worker-directory-random-"));
  const acquireRefreshRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-worker-directory-acquire-refresh-"));
  const tamperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-worker-directory-tamper-"));
  roots.push(lifecycleRoot, randomRoot, acquireRefreshRoot, tamperRoot);

  smokeAdmissionProtocolCanonicalization();
  const result = await smokeLifecycle(lifecycleRoot);
  await assertProtectedStore(lifecycleRoot);
  await smokeInvalidRandom(randomRoot);
  await smokeAcquireAutoRenewal(acquireRefreshRoot);
  for (const kind of ["corrupt", "symlink", "hardlink"]) await smokeTamper(tamperRoot, kind);

  console.log(JSON.stringify({
    ok: true,
    revision: result.beforeRestart.revision,
    nodes: result.beforeRestart.nodes.map(({ nodeId }) => nodeId),
    assignment: result.beforeRestart.assignments[0],
    events: result.events.length,
    eventHead: result.beforeRestart.eventCursor.lastHash,
    attestedTransportSplit: true,
    failClosedTamperCases: ["corrupt", "symlink", "hardlink"],
    canonicalAdmissionProtocols: true,
    acquireAutoRenewal: true,
  }, null, 2));
} finally {
  for (const rootDir of roots) await fs.rm(rootDir, { recursive: true, force: true });
}
