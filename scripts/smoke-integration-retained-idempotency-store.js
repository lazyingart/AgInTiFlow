#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIntegrationTransactionalIdempotencyStore } from "../src/integration-api.js";
import {
  INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
  currentProcessOwner,
} from "../src/integration-durable-common.js";
import {
  INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE,
  INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
  INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE,
  INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
  INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS,
  assertRetainedIntegrationIdempotencyStore,
  assertRetainedIntegrationTransactionalIdempotencyStore,
  bindRetainedIntegrationIdempotencyRecoveryAuthority,
  createRetainedIntegrationIdempotencyStore,
} from "../src/integration-retained-idempotency-store.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";
import {
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";

const UID = process.getuid();
const GID = process.getgid();
const ROLE = "retained-idempotency-smoke";
const DIRECTORY_SEGMENTS = Object.freeze(["idempotency"]);
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_RECORDS = 8;
const MAX_RESPONSE_BYTES = 32 * 1024;
const PENDING_LEASE_MS = 300;
const RETENTION_MS = 5000;
const LOCK_WAIT_MS = 3000;
const THIS_FILE = fileURLToPath(import.meta.url);

function retainedObjectIdentityDigest(stat) {
  return contractDigest({
    schemaVersion: "aginti-retained-regular-file-identity-v1",
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

async function ensureOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function provisionRoot(rootPath) {
  const idempotencyPath = path.join(rootPath, ...DIRECTORY_SEGMENTS);
  await ensureOwnerDirectory(rootPath);
  await ensureOwnerDirectory(idempotencyPath);
  const lockPath = path.join(idempotencyPath, INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE);
  await fs.writeFile(lockPath, "", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await fs.chmod(lockPath, 0o600);
  await fs.chown(lockPath, UID, GID);
  return Object.freeze({ idempotencyPath, lockPath });
}

async function openFixture(
  rootPath,
  {
    pendingLeaseMs = PENDING_LEASE_MS,
    retentionMs = RETENTION_MS,
  } = {}
) {
  const paths = await provisionRoot(rootPath);
  const authority = await openIntegrationStorageAuthority({
    rootPath,
    role: ROLE,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained idempotency smoke",
  });
  const directory = await authority.openDirectory(DIRECTORY_SEGMENTS);
  const identity = await directory.identity();
  const directoryExpected = Object.freeze({
    role: ROLE,
    canonicalPath: rootPath,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments: DIRECTORY_SEGMENTS,
    directoryIdentityDigest: identity.digest,
  });
  const files = createIntegrationRetainedFilePrimitives(directory, directoryExpected);
  const [lockStat, helperStat, helperBytes] = await Promise.all([
    fs.stat(paths.lockPath, { bigint: true }),
    fs.stat("/usr/bin/flock", { bigint: true }),
    fs.readFile("/usr/bin/flock"),
  ]);
  const expected = Object.freeze({
    ...directoryExpected,
    lockFileIdentityDigest: retainedObjectIdentityDigest(lockStat),
    helperSha256: crypto.createHash("sha256").update(helperBytes).digest("hex"),
    helperIdentityDigest: retainedObjectIdentityDigest(helperStat),
    maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
    maxRecords: MAX_RECORDS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    pendingLeaseMs,
    retentionMs,
    lockWaitMs: LOCK_WAIT_MS,
  });
  const lock = await openIntegrationRetainedRegularFileLock(files, {
    ...directoryExpected,
    lockFileName: INTEGRATION_RETAINED_IDEMPOTENCY_LOCK_FILE,
    helperSha256: expected.helperSha256,
    lockFileIdentityDigest: expected.lockFileIdentityDigest,
    helperIdentityDigest: expected.helperIdentityDigest,
  });
  const store = createRetainedIntegrationIdempotencyStore(files, lock, expected);
  return Object.freeze({ authority, directory, files, lock, store, expected, paths });
}

function recoveryBinding(recoverPending) {
  return Object.freeze({
    owner: "aginti",
    explicit: true,
    testOnly: true,
    blindRedispatch: false,
    beforeDispatchRecovery: true,
    afterDispatchBeforeResultRecovery: true,
    afterResultBeforePublicResponseRecovery: true,
    recoverPending,
  });
}

function mutationContext(seed, overrides = {}) {
  return Object.freeze({
    principalId: "principal-retained-smoke-0001",
    browserSessionId: "a".repeat(64),
    pathname: "/agent/v1/threads/create",
    idempotencyKey: `retained-key-${seed.padEnd(16, "x")}`,
    requestHash: contractDigest({ seed }),
    requestHashAlgorithm: INTEGRATION_RETAINED_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    responseEnvelope: INTEGRATION_RETAINED_IDEMPOTENCY_RESPONSE_ENVELOPE,
    idempotencyWindowMs: RETENTION_MS,
    payload: Object.freeze({ seed }),
    ...overrides,
  });
}

function response(seed) {
  return Object.freeze({
    schemaVersion: "1",
    result: Object.freeze({ seed, accepted: true }),
  });
}

async function expectCode(action, code) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `Expected ${code}`);
  assert.equal(captured.publicCode || captured.code, code, captured.stack || captured.message);
  return captured;
}

async function expectNoUnhandledRejections(action) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await action();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
}

async function closeFixture(fixture) {
  await fixture?.authority?.close();
}

async function runCrashChild() {
  const rootPath = process.env.AGINTI_IDEMPOTENCY_CRASH_ROOT;
  const fixture = await openFixture(rootPath);
  const transactional = bindRetainedIntegrationIdempotencyRecoveryAuthority(
    fixture.store,
    fixture.expected,
    recoveryBinding(async () => null)
  );
  const context = mutationContext("crash-recovery");
  await transactional.runMutation(context, async () => {
    process.send?.({ stage: "handler-started" });
    return new Promise(() => {});
  });
}

async function persistAfterResultCrashBoundary(rootPath, persistedResponse) {
  const snapshotPath = path.join(
    rootPath,
    ...DIRECTORY_SEGMENTS,
    INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE
  );
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].state, "pending");
  const updatedAt = new Date();
  const record = {
    ...snapshot.records[0],
    updatedAt: updatedAt.toISOString(),
    expiresAt: new Date(updatedAt.getTime() + RETENTION_MS).toISOString(),
    recoveryStage: "after-result-before-public-response",
    response: persistedResponse,
    responseDigest: contractDigest(persistedResponse),
    responseBytes: Buffer.byteLength(canonicalJson(persistedResponse), "utf8"),
  };
  const unsigned = {
    ...snapshot,
    revision: snapshot.revision + 1,
    previousIntegrityDigest: snapshot.integrityDigest,
    updatedAt: updatedAt.toISOString(),
    records: [record],
  };
  delete unsigned.integrityDigest;
  const committed = {
    ...unsigned,
    integrityDigest: contractDigest({
      domain: "aginti-retained-integration-idempotency-snapshot-integrity-v1",
      securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
      payload: unsigned,
    }),
  };
  await fs.writeFile(snapshotPath, `${canonicalJson(committed)}\n`, { mode: 0o600 });
}

async function persistInactiveCurrentProcessPending(rootPath, { all = false } = {}) {
  const snapshotPath = path.join(
    rootPath,
    ...DIRECTORY_SEGMENTS,
    INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE
  );
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const now = new Date();
  assert(all ? snapshot.records.length >= 2 : snapshot.records.length === 1);
  const records = [];
  for (let index = 0; index < snapshot.records.length; index += 1) {
    const source = snapshot.records[index];
    if (!all && index > 0) {
      records.push(source);
      continue;
    }
    records.push({
      ...source,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
      state: "pending",
      pendingOwner: await currentProcessOwner(),
      leaseExpiresAt: new Date(now.getTime() - 1000).toISOString(),
      recoveryStage: "after-dispatch-before-result",
      response: null,
      responseDigest: "0".repeat(64),
      responseBytes: 0,
      failure: null,
    });
  }
  const unsigned = {
    ...snapshot,
    revision: snapshot.revision + 1,
    previousIntegrityDigest: snapshot.integrityDigest,
    updatedAt: now.toISOString(),
    records,
  };
  delete unsigned.integrityDigest;
  const committed = {
    ...unsigned,
    integrityDigest: contractDigest({
      domain: "aginti-retained-integration-idempotency-snapshot-integrity-v1",
      securityScope: INTEGRATION_INTEGRITY_DIGEST_SECURITY_SCOPE,
      payload: unsigned,
    }),
  };
  await fs.writeFile(snapshotPath, `${canonicalJson(committed)}\n`, { mode: 0o600 });
  return Object.freeze(records.map((record) => Object.freeze({
    index: record.index,
    requestHash: record.requestHash,
  })));
}

async function runCrashRecoverySmoke(rootPath, { persistedResult = false } = {}) {
  await provisionRoot(rootPath);
  const child = fork(THIS_FILE, [], {
    env: {
      ...process.env,
      AGINTI_IDEMPOTENCY_CRASH_CHILD: "1",
      AGINTI_IDEMPOTENCY_CRASH_ROOT: rootPath,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Crash child did not enter its handler.")), 10_000);
    child.once("error", reject);
    child.on("message", (message) => {
      if (message?.stage !== "handler-started") return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, PENDING_LEASE_MS + 150));

  const persistedResponse = response("persisted-before-public-response-crash");
  if (persistedResult) await persistAfterResultCrashBoundary(rootPath, persistedResponse);

  const fixture = await openFixture(rootPath);
  try {
    let recoveryCalls = 0;
    let handlerCalls = 0;
    const recoveredResponse = persistedResult
      ? persistedResponse
      : response("recovered-after-crash");
    const transactional = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      fixture.store,
      fixture.expected,
      recoveryBinding(async (receipt) => {
        recoveryCalls += 1;
        assert.equal(persistedResult, false, "persisted result recovery must remain store-local");
        assert.equal(receipt.recoveryStage, "after-dispatch-before-result");
        return recoveredResponse;
      })
    );
    const actual = await transactional.runMutation(mutationContext("crash-recovery"), async () => {
      handlerCalls += 1;
      return response("must-not-dispatch");
    });
    assert.deepEqual(actual, recoveredResponse);
    assert.equal(recoveryCalls, persistedResult ? 0 : 1);
    assert.equal(handlerCalls, 0);
    const replay = await transactional.runMutation(mutationContext("crash-recovery"), async () => {
      handlerCalls += 1;
      return response("must-not-dispatch");
    });
    assert.deepEqual(replay, recoveredResponse);
    assert.equal(recoveryCalls, persistedResult ? 0 : 1);
    assert.equal(handlerCalls, 0);
  } finally {
    await closeFixture(fixture);
  }
}

async function run() {
  const mainRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-idempotency-"));
  const corruptionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-idempotency-corrupt-"));
  const modeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-idempotency-mode-"));
  const replacementRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-idempotency-replace-"));
  const crashRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-idempotency-crash-"));
  const afterResultCrashRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-after-result-crash-")
  );
  const productionLeaseRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-production-lease-")
  );
  const expiryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-expiry-")
  );
  const timingBindingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-timing-binding-")
  );
  const inactiveOwnerRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-inactive-owner-")
  );
  const recoverySweepRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-idempotency-recovery-sweep-")
  );
  let fixture = null;
  try {
    fixture = await openFixture(mainRoot);
    assert.equal(INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS.sameUidNonparticipantSafety, false);
    assert.equal(INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS.namedBindingRaceFree, false);
    assert.equal(INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS.dynamicSharding, false);
    assert.equal(INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS.listMethodsRequired, false);
    assert.equal(INTEGRATION_RETAINED_IDEMPOTENCY_STORE_LIMITATIONS.deleteMethodsRequired, false);
    assertRetainedIntegrationIdempotencyStore(fixture.store, fixture.expected);
    const initialHealth = await fixture.store.health();
    assert.equal(initialHealth.healthy, true);
    assert.equal(initialHealth.recoveryAuthorityBound, false);
    assert.equal(initialHealth.records, 0);

    let proxyTrapCalls = 0;
    const contextProxy = new Proxy(mutationContext("proxy"), {
      get() {
        proxyTrapCalls += 1;
        throw new Error("context proxy get trap must not run");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("context proxy ownKeys trap must not run");
      },
    });
    let recoveryProxyTrapCalls = 0;
    const recoveryProxy = new Proxy(recoveryBinding(async () => null), {
      get() {
        recoveryProxyTrapCalls += 1;
        throw new Error("recovery proxy get trap must not run");
      },
      ownKeys() {
        recoveryProxyTrapCalls += 1;
        throw new Error("recovery proxy ownKeys trap must not run");
      },
    });
    await expectCode(
      () => bindRetainedIntegrationIdempotencyRecoveryAuthority(
        fixture.store,
        fixture.expected,
        recoveryProxy
      ),
      "IDEMPOTENCY_STORE_INVALID"
    );
    assert.equal(recoveryProxyTrapCalls, 0);
    let recoveryAccessorCalls = 0;
    const recoveryAccessor = { ...recoveryBinding(async () => null) };
    Object.defineProperty(recoveryAccessor, "recoverPending", {
      configurable: true,
      enumerable: true,
      get() {
        recoveryAccessorCalls += 1;
        return async () => null;
      },
    });
    await expectCode(
      () => bindRetainedIntegrationIdempotencyRecoveryAuthority(
        fixture.store,
        fixture.expected,
        recoveryAccessor
      ),
      "IDEMPOTENCY_STORE_INVALID"
    );
    assert.equal(recoveryAccessorCalls, 0);
    await expectNoUnhandledRejections(async () => {
      const rejectedRecovery = Promise.reject(new Error("already rejected recovery binding"));
      await expectCode(
        () => bindRetainedIntegrationIdempotencyRecoveryAuthority(
          fixture.store,
          fixture.expected,
          rejectedRecovery
        ),
        "IDEMPOTENCY_STORE_INVALID"
      );
      const rejectedExpected = Promise.reject(new Error("already rejected expected binding"));
      await expectCode(
        () => createRetainedIntegrationIdempotencyStore(fixture.files, fixture.lock, rejectedExpected),
        "IDEMPOTENCY_STORE_INVALID"
      );
    });
    const transactional = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      fixture.store,
      fixture.expected,
      recoveryBinding(async () => null)
    );
    await expectCode(
      () => assertIntegrationTransactionalIdempotencyStore(transactional),
      "AGENT_UNAVAILABLE"
    );
    assertRetainedIntegrationTransactionalIdempotencyStore(transactional, fixture.expected);
    assert.equal(transactional.testOnly, true);
    assert.equal(transactional.attestation.testOnly, true);
    assert.equal(transactional.attestation.recoveryCallbackBound, true);
    assert.equal(transactional.attestation.trustedRecoveryReceiptAuthorityBound, false);
    assert.equal(transactional.attestation.integrationApiCompatible, false);
    assert.notEqual(transactional.attestation.digest, fixture.store.attestation.digest);
    await expectCode(
      () => transactional.runMutation(contextProxy, async () => response("proxy")),
      "IDEMPOTENCY_STORE_INVALID"
    );
    assert.equal(proxyTrapCalls, 0);

    let accessorCalls = 0;
    const accessorContext = { ...mutationContext("accessor") };
    Object.defineProperty(accessorContext, "requestHash", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "b".repeat(64);
      },
    });
    await expectCode(
      () => transactional.runMutation(accessorContext, async () => response("accessor")),
      "IDEMPOTENCY_STORE_INVALID"
    );
    assert.equal(accessorCalls, 0);
    let mismatchedWindowDispatches = 0;
    await expectCode(
      () => transactional.runMutation(
        mutationContext("window-mismatch", { idempotencyWindowMs: RETENTION_MS + 1 }),
        async () => {
          mismatchedWindowDispatches += 1;
          return response("window-mismatch");
        }
      ),
      "IDEMPOTENCY_SCOPE_INVALID"
    );
    assert.equal(mismatchedWindowDispatches, 0);

    await expectNoUnhandledRejections(async () => {
      const rejectedContext = Promise.reject(new Error("already rejected context"));
      await expectCode(
        () => transactional.runMutation(rejectedContext, async () => response("rejected")),
        "IDEMPOTENCY_STORE_INVALID"
      );
      const rejectedPayload = Promise.reject(new Error("already rejected payload"));
      await expectCode(
        () => transactional.runMutation({ ...mutationContext("payload"), payload: rejectedPayload }, async () => response("payload")),
        "IDEMPOTENCY_STORE_INVALID"
      );
      const rejectedNestedPayload = Promise.reject(new Error("already rejected nested payload"));
      await expectCode(
        () => transactional.runMutation(
          {
            ...mutationContext("nested-payload"),
            payload: Object.freeze({ nested: rejectedNestedPayload }),
          },
          async () => response("nested-payload")
        ),
        "IDEMPOTENCY_SCOPE_INVALID"
      );
      const rejectedExtra = Promise.reject(new Error("already rejected extra"));
      await expectCode(
        () => transactional.runMutation(mutationContext("extra"), async () => response("extra"), rejectedExtra),
        "IDEMPOTENCY_STORE_INVALID"
      );
      const rejectedHealthExtra = Promise.reject(new Error("already rejected health extra"));
      await expectCode(() => fixture.store.health(rejectedHealthExtra), "IDEMPOTENCY_STORE_INVALID");
      const rejectedMixedContext = Promise.reject(new Error("mixed invalid handler context"));
      await expectCode(
        () => transactional.runMutation(rejectedMixedContext, null),
        "IDEMPOTENCY_STORE_INVALID"
      );
      const rejectedLateFactoryArgument = Promise.reject(new Error("late factory argument"));
      await expectCode(
        () => createRetainedIntegrationIdempotencyStore(
          null,
          rejectedLateFactoryArgument,
          fixture.expected
        ),
        "IDEMPOTENCY_STORE_UNAVAILABLE"
      );
      const rejectedLateRecoveryArgument = Promise.reject(new Error("late recovery argument"));
      await expectCode(
        () => bindRetainedIntegrationIdempotencyRecoveryAuthority(
          null,
          fixture.expected,
          rejectedLateRecoveryArgument
        ),
        "IDEMPOTENCY_STORE_UNAVAILABLE"
      );
      const rejectedLateField = Promise.reject(new Error("late unsupported field"));
      await expectCode(
        () => transactional.runMutation(
          {
            unsupported: true,
            payload: rejectedLateField,
          },
          async () => response("late-field")
        ),
        "IDEMPOTENCY_STORE_INVALID"
      );
    });

    let dispatches = 0;
    const replayContext = mutationContext("replay");
    const first = await transactional.runMutation(replayContext, async () => {
      dispatches += 1;
      return response("replay");
    });
    const replayed = await transactional.runMutation(replayContext, async () => {
      dispatches += 1;
      return response("must-not-run");
    });
    assert.deepEqual(first, response("replay"));
    assert.deepEqual(replayed, first);
    assert.equal(dispatches, 1);
    const redactedContext = mutationContext("redacted-sentinel");
    const redactedResponse = Object.freeze({
      schemaVersion: "1",
      result: Object.freeze({ text: "token: [REDACTED]" }),
    });
    const redactedFirst = await transactional.runMutation(
      redactedContext,
      async () => redactedResponse
    );
    const redactedReplay = await transactional.runMutation(
      redactedContext,
      async () => response("must-not-run-redacted")
    );
    assert.deepEqual(redactedFirst, redactedResponse);
    assert.deepEqual(redactedReplay, redactedResponse);
    await expectCode(
      () => transactional.runMutation(
        mutationContext("real-secret-rejected"),
        async () => Object.freeze({
          schemaVersion: "1",
          result: Object.freeze({ text: "token: actual-secret" }),
        })
      ),
      "IDEMPOTENCY_UNSAFE_RESULT"
    );
    await expectCode(
      () => transactional.runMutation(
        mutationContext("replay", { requestHash: contractDigest({ changed: true }) }),
        async () => response("conflict")
      ),
      "IDEMPOTENCY_CONFLICT"
    );

    const handlerError = Object.assign(new Error("deterministic handler failure"), {
      code: "HANDLER_FAILED",
      publicCode: "HANDLER_FAILED",
      status: 422,
    });
    const failedContext = mutationContext("failed");
    await expectCode(() => transactional.runMutation(failedContext, async () => {
      throw handlerError;
    }), "HANDLER_FAILED");
    await expectCode(
      () => transactional.runMutation(failedContext, async () => response("must-not-run")),
      "HANDLER_FAILED"
    );
    const collidingFailure = Object.assign(new Error("handler storage namespace collision"), {
      code: "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS",
      publicCode: "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS",
      status: 502,
    });
    const collidingFailureContext = mutationContext("failure-code-collision");
    const collidingFirst = await expectCode(
      () => transactional.runMutation(collidingFailureContext, async () => {
        throw collidingFailure;
      }),
      "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
    );
    const collidingReplay = await expectCode(
      () => transactional.runMutation(
        collidingFailureContext,
        async () => response("must-not-run-colliding-failure")
      ),
      "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS"
    );
    assert.equal(collidingFirst.status, 502);
    assert.equal(collidingReplay.status, 502);
    assert.equal((await fixture.store.health()).healthy, true);

    let concurrentDispatches = 0;
    const concurrentContext = mutationContext("concurrent");
    const concurrentResults = await Promise.all([
      transactional.runMutation(concurrentContext, async () => {
        concurrentDispatches += 1;
        await new Promise((resolve) => setTimeout(resolve, 180));
        return response("concurrent");
      }),
      transactional.runMutation(concurrentContext, async () => {
        concurrentDispatches += 1;
        return response("duplicate-a");
      }),
      transactional.runMutation(concurrentContext, async () => {
        concurrentDispatches += 1;
        return response("duplicate-b");
      }),
    ]);
    assert.equal(concurrentDispatches, 1);
    assert.deepEqual(concurrentResults, [response("concurrent"), response("concurrent"), response("concurrent")]);
    await closeFixture(fixture);
    fixture = null;

    const reopenedMain = await openFixture(mainRoot);
    try {
      let reopenDispatches = 0;
      const reopenedStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
        reopenedMain.store,
        reopenedMain.expected,
        recoveryBinding(async () => null)
      );
      assert.equal((await reopenedMain.store.health()).healthy, true);
      const reopenedReplay = await reopenedStore.runMutation(replayContext, async () => {
        reopenDispatches += 1;
        return response("must-not-dispatch-after-reopen");
      });
      assert.deepEqual(reopenedReplay, response("replay"));
      assert.equal(reopenDispatches, 0);
    } finally {
      await closeFixture(reopenedMain);
    }

    const corruptFixture = await openFixture(corruptionRoot);
    const corruptTransactional = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      corruptFixture.store,
      corruptFixture.expected,
      recoveryBinding(async () => null)
    );
    await corruptTransactional.runMutation(mutationContext("corruption"), async () => response("corruption"));
    await closeFixture(corruptFixture);
    const snapshotPath = path.join(corruptFixture.paths.idempotencyPath, INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE);
    const corruptSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    corruptSnapshot.records[0].requestHash = "f".repeat(64);
    await fs.writeFile(snapshotPath, `${JSON.stringify(corruptSnapshot)}\n`, { mode: 0o600 });
    const reopenedCorrupt = await openFixture(corruptionRoot);
    try {
      await expectCode(() => reopenedCorrupt.store.health(), "IDEMPOTENCY_STORE_CORRUPT");
      await expectCode(() => reopenedCorrupt.store.health(), "IDEMPOTENCY_STORE_POISONED");
    } finally {
      await closeFixture(reopenedCorrupt);
    }

    const modeFixture = await openFixture(modeRoot);
    await fs.chmod(modeFixture.paths.lockPath, 0o640);
    try {
      await expectCode(() => modeFixture.store.health(), "IDEMPOTENCY_STORE_UNAVAILABLE");
      await expectCode(() => modeFixture.store.health(), "IDEMPOTENCY_STORE_POISONED");
    } finally {
      await fs.chmod(modeFixture.paths.lockPath, 0o600);
      await closeFixture(modeFixture);
    }

    const replacementFixture = await openFixture(replacementRoot);
    const oldLock = `${replacementFixture.paths.lockPath}.old`;
    await fs.rename(replacementFixture.paths.lockPath, oldLock);
    await fs.writeFile(replacementFixture.paths.lockPath, "", { flag: "wx", mode: 0o600 });
    try {
      await expectCode(() => replacementFixture.store.health(), "IDEMPOTENCY_STORE_UNAVAILABLE");
      await expectCode(() => replacementFixture.store.health(), "IDEMPOTENCY_STORE_POISONED");
    } finally {
      await closeFixture(replacementFixture);
    }

    await runCrashRecoverySmoke(crashRoot);
    await runCrashRecoverySmoke(afterResultCrashRoot, { persistedResult: true });

    const timingFixture = await openFixture(timingBindingRoot);
    const timingStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      timingFixture.store,
      timingFixture.expected,
      recoveryBinding(async () => null)
    );
    await timingStore.runMutation(
      mutationContext("timing-seal"),
      async () => response("timing-seal")
    );
    await closeFixture(timingFixture);
    const changedTimingFixture = await openFixture(timingBindingRoot, {
      retentionMs: RETENTION_MS + 1000,
    });
    try {
      await expectCode(
        () => changedTimingFixture.store.health(),
        "IDEMPOTENCY_STORE_CORRUPT"
      );
    } finally {
      await closeFixture(changedTimingFixture);
    }

    const inactiveFixture = await openFixture(inactiveOwnerRoot);
    const inactiveStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      inactiveFixture.store,
      inactiveFixture.expected,
      recoveryBinding(async () => null)
    );
    const inactiveContext = mutationContext("inactive-owner");
    await inactiveStore.runMutation(
      inactiveContext,
      async () => response("inactive-owner-initial")
    );
    await closeFixture(inactiveFixture);
    await persistInactiveCurrentProcessPending(inactiveOwnerRoot);
    const recoveredInactiveFixture = await openFixture(inactiveOwnerRoot);
    try {
      let recoveryCalls = 0;
      let redispatches = 0;
      const recoveredInactiveStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
        recoveredInactiveFixture.store,
        recoveredInactiveFixture.expected,
        recoveryBinding(async () => {
          recoveryCalls += 1;
          return response("inactive-owner-recovered");
        })
      );
      const recovered = await recoveredInactiveStore.runMutation(
        inactiveContext,
        async () => {
          redispatches += 1;
          return response("inactive-owner-must-not-dispatch");
        }
      );
      assert.deepEqual(recovered, response("inactive-owner-recovered"));
      assert.equal(recoveryCalls, 1);
      assert.equal(redispatches, 0);
    } finally {
      await closeFixture(recoveredInactiveFixture);
    }

    const sweepFixture = await openFixture(recoverySweepRoot);
    const sweepSeedStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
      sweepFixture.store,
      sweepFixture.expected,
      recoveryBinding(async () => null)
    );
    const sweepContexts = [
      mutationContext("sweep-one"),
      mutationContext("sweep-two"),
    ];
    for (const context of sweepContexts) {
      await sweepSeedStore.runMutation(context, async () => response("sweep-seed"));
    }
    await closeFixture(sweepFixture);
    const sweepRecords = await persistInactiveCurrentProcessPending(
      recoverySweepRoot,
      { all: true }
    );
    const blockedRequestHash = sweepRecords[0].requestHash;
    const sweepRecoveryFixture = await openFixture(recoverySweepRoot);
    try {
      let sweepRecoveryCalls = 0;
      const sweepStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
        sweepRecoveryFixture.store,
        sweepRecoveryFixture.expected,
        recoveryBinding(async (receipt) => {
          sweepRecoveryCalls += 1;
          return receipt.requestHash === blockedRequestHash
            ? null
            : response("sweep-recovered");
        })
      );
      const sweep = await sweepStore.recoverExpiredPending();
      assert.equal(sweepRecoveryCalls, 2);
      assert.equal(sweep.pending.length, 1);
      assert.equal(sweep.recovered.length, 1);
      assert.equal(sweep.pending[0], sweepRecords[0].index);
      assert.equal(sweep.recovered[0], sweepRecords[1].index);
    } finally {
      await closeFixture(sweepRecoveryFixture);
    }

    const productionLeaseFixture = await openFixture(productionLeaseRoot, {
      pendingLeaseMs: 30_000,
      retentionMs: 60_000,
    });
    try {
      const productionLeaseStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
        productionLeaseFixture.store,
        productionLeaseFixture.expected,
        recoveryBinding(async () => null)
      );
      const startedAt = performance.now();
      await productionLeaseStore.runMutation(
        mutationContext("production-lease-latency", { idempotencyWindowMs: 60_000 }),
        async () => response("production-lease-latency")
      );
      const elapsedMs = performance.now() - startedAt;
      assert(elapsedMs < 1000, `instant mutation took ${elapsedMs.toFixed(1)}ms with a production lease`);
    } finally {
      await closeFixture(productionLeaseFixture);
    }

    const expiryFixture = await openFixture(expiryRoot, { retentionMs: 1000 });
    try {
      let expiryDispatches = 0;
      const expiryStore = bindRetainedIntegrationIdempotencyRecoveryAuthority(
        expiryFixture.store,
        expiryFixture.expected,
        recoveryBinding(async () => null)
      );
      const originalContext = mutationContext("expired-key-reuse", {
        idempotencyWindowMs: 1000,
      });
      await expiryStore.runMutation(originalContext, async () => {
        expiryDispatches += 1;
        return response("before-expiry");
      });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const reused = await expiryStore.runMutation(
        mutationContext("expired-key-reuse", {
          requestHash: contractDigest({ seed: "changed-after-expiry" }),
          idempotencyWindowMs: 1000,
        }),
        async () => {
          expiryDispatches += 1;
          return response("after-expiry");
        }
      );
      assert.deepEqual(reused, response("after-expiry"));
      assert.equal(expiryDispatches, 2);
    } finally {
      await closeFixture(expiryFixture);
    }
  } finally {
    await closeFixture(fixture);
    for (const rootPath of [
      mainRoot,
      corruptionRoot,
      modeRoot,
      replacementRoot,
      crashRoot,
      afterResultCrashRoot,
      productionLeaseRoot,
      expiryRoot,
      timingBindingRoot,
      inactiveOwnerRoot,
      recoverySweepRoot,
    ]) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }
  process.stdout.write("integration retained idempotency store smoke: ok\n");
}

if (process.env.AGINTI_IDEMPOTENCY_CRASH_CHILD === "1") {
  runCrashChild().catch((error) => {
    process.stderr.write(`crash child failed: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else {
  run().catch((error) => {
    process.stderr.write(
      `integration retained idempotency store smoke: failed (${String(error?.publicCode || error?.code || error)})\n${error?.stack || ""}\n`
    );
    process.exitCode = 1;
  });
}
