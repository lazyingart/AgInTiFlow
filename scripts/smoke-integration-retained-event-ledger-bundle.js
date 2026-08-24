#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
  contractDigest,
} from "../src/integration-policy.js";

const MOCK_MODE = process.argv.find((value) => value.startsWith("--mock-mode="))?.slice("--mock-mode=".length) || "";
const ambiguityState = { armed: false };
let ambiguityFsMock = null;
if (MOCK_MODE === "bundle-rename-ambiguous") {
  const { mock } = await import("node:test");
  const mockFs = { ...fs };
  mockFs.rename = async (source, target) => {
    await fs.rename(source, target);
    if (ambiguityState.armed && String(target).endsWith(".json")) {
      ambiguityState.armed = false;
      throw new Error("synthetic /proc/self/fd/993 bundle rename ambiguity");
    }
  };
  ambiguityFsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
}

const ledgerApi = await import(new URL("../src/integration-event-ledger-store.js", import.meta.url).href);
const storageApi = await import(new URL("../src/integration-storage-authority.js", import.meta.url).href);
const {
  INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_VERSION,
  INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS,
  INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_VERSION,
  assertRetainedIntegrationEventLedgerBundle,
  assertRetainedIntegrationEventLedgerStore,
  createRetainedIntegrationEventLedgerBundle,
  createRetainedIntegrationEventLedgerStore,
} = ledgerApi;
const {
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} = storageApi;
const execFileAsync = promisify(execFile);

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const LOCK_NAME = ".aginti-flock-v1-event-ledger";
const ZERO_DIGEST = "0".repeat(64);
const SCOPE_DOMAIN = "aginti-retained-public-event-ledger-scope-v1";
const RUNTIME_STORE_KEYS = Object.freeze([
  "owner",
  "authority",
  "mappingVersion",
  "durable",
  "persisted",
  "contiguous",
  "monotonic",
  "bridgeOwned",
  "appendPublicEvent",
  "appendByOutboxId",
  "lookupByOutboxId",
  "ledgerForRun",
  "integrationEventAppendAttestation",
]);
const BUNDLE_KEYS = Object.freeze(["schemaVersion", "runtimeStore", "sessionReadView", "attestation"]);
const SESSION_VIEW_KEYS = Object.freeze(["owner", "ledgerForRun", "attest"]);
const SESSION_PROOF_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "durable",
  "persisted",
  "contiguous",
  "monotonic",
  "bridgeOwned",
  "mappingVersion",
  "maxEvents",
  "maxBytes",
  "digest",
]);
const BUNDLE_PROOF_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "sharedRetainedState",
  "runtimeAppendSurface",
  "sessionReadOnlySurface",
  "sessionAttestationUnderGlobalLock",
  "sessionAttestationChecksOpenAndPoisonState",
  "sessionAttestationDrainsOperations",
  "singleClaimedLockSurface",
  "storageLifecycleOwned",
  "runtimeCapabilityEnabled",
  "serverWiringIncluded",
  "eventAppendProofDigest",
  "sessionProofDigest",
  "storageBindingDigest",
  "limitations",
  "digest",
]);
const RUNTIME_REPOSITORY_METHODS = Object.freeze([
  "listIntegrationThreads",
  "createIntegrationThread",
  "getIntegrationThread",
  "updateIntegrationThread",
  "deleteIntegrationThread",
  "getActiveIntegrationRunForThread",
  "createIntegrationRun",
  "markIntegrationRunDispatching",
  "authorizeIntegrationRunNativeStart",
  "abortIntegrationRunBeforeLaunch",
  "getIntegrationRun",
  "markIntegrationRunCancelling",
  "finishIntegrationRunWithOutbox",
  "getIntegrationCompletionOutboxBundle",
  "reconcileIntegrationDispatches",
  "listPendingIntegrationOutboxEvents",
  "markIntegrationOutboxDelivered",
  "listIntegrationArtifacts",
  "getIntegrationArtifact",
  "stageIntegrationArtifactOutbox",
  "publishIntegrationArtifactOutbox",
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function seal(value) {
  const unsigned = { ...value };
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function identityDigest(stat) {
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

function digestWithoutDigest(value) {
  const unsigned = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "digest") unsigned[key] = value[key];
  }
  return contractDigest(unsigned);
}

function scopeFor(index = 1) {
  const suffix = String(index).padStart(12, "0");
  return Object.freeze({
    principalId: "principal-retained-bundle",
    browserSessionId: "b".repeat(64),
    browserSessionPolicy: "same-browser-session",
    threadId: `thr_11111111-1111-4111-8111-${suffix}`,
    runId: `run_22222222-2222-4222-8222-${suffix}`,
  });
}

function scopeDigest(scope) {
  return contractDigest({ domain: SCOPE_DOMAIN, ...scope });
}

function appendInput(text, createdAt) {
  return Object.freeze({ type: "output.delta", payload: Object.freeze({ text }), createdAt });
}

function assertExactFrozenSurface(value, keys, prototype = Object.prototype) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), prototype);
  assert.deepEqual(Reflect.ownKeys(value), keys);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(descriptor?.enumerable, true);
    assert.equal(descriptor?.configurable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor || {}, "value"), true);
  }
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.publicCode || error?.code || "",
    message: error?.message || "",
    details: error?.details || {},
  });
}

async function expectCode(action, expected, forbiddenRoot = "") {
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, `Expected ${expectedCodes.join("|")} rejection.`);
  assert.equal(expectedCodes.includes(captured.publicCode || captured.code), true);
  const text = publicErrorText(captured);
  assert.equal(text.includes("/proc/self/fd"), false);
  assert.equal(text.includes(HELPER_PATH), false);
  assert.equal(/"fd"\s*:/u.test(text), false);
  if (forbiddenRoot) assert.equal(text.includes(forbiddenRoot), false);
  return captured;
}

async function makeOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function makeLockFile(lockPath) {
  await fs.writeFile(lockPath, "", { mode: 0o600 });
  await fs.chmod(lockPath, 0o600);
  await fs.chown(lockPath, UID, GID);
}

async function openFixture(rootPath, role, { maxEvents = 32, maxBytes = 256 * 1024, lockWaitMs = 1000 } = {}) {
  const dataPath = path.join(rootPath, "data");
  const lockPath = path.join(dataPath, LOCK_NAME);
  await makeOwnerDirectory(rootPath);
  await makeOwnerDirectory(dataPath);
  await makeLockFile(lockPath);
  const authority = await openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained event ledger bundle smoke",
  });
  const directory = await authority.openDirectory(["data"]);
  const directoryIdentity = await directory.identity();
  const directoryExpected = Object.freeze({
    role,
    canonicalPath: rootPath,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments: Object.freeze(["data"]),
    directoryIdentityDigest: directoryIdentity.digest,
  });
  const files = createIntegrationRetainedFilePrimitives(directory, directoryExpected);
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));
  const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
  const lockExpected = Object.freeze({
    ...directoryExpected,
    lockFileName: LOCK_NAME,
    helperSha256,
    lockFileIdentityDigest,
    helperIdentityDigest,
  });
  const expected = Object.freeze({
    ...directoryExpected,
    lockFileIdentityDigest,
    helperSha256,
    helperIdentityDigest,
    maxEvents,
    maxBytes,
    lockWaitMs,
  });
  const lock = await openIntegrationRetainedRegularFileLock(files, lockExpected);
  return Object.freeze({
    authority,
    directory,
    files,
    lock,
    lockExpected,
    expected,
    dataPath,
    rootPath,
  });
}

async function fdTargetsContaining(text) {
  const targets = [];
  for (const name of await fs.readdir("/proc/self/fd")) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

async function loadIntegrationConsumerApis() {
  const { mock } = await import("node:test");
  const apiMock = mock.module(new URL("../src/integration-api.js", import.meta.url).href, {
    namedExports: {
      INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION: "aginti-transactional-idempotency-v1",
      sanitizePublicIntegrationRun(value) {
        return value;
      },
      sanitizePublicIntegrationThread(value) {
        return value;
      },
    },
  });
  const runnerMock = mock.module(new URL("../src/agent-runner.js", import.meta.url).href, {
    namedExports: {
      async runAgent() {
        throw new Error("Retained event ledger bundle smoke must not execute an agent.");
      },
    },
  });
  try {
    const sessionApi = await import(new URL("../src/integration-session-service.js", import.meta.url).href);
    const nativeExecutorApi = await import(new URL("../src/integration-native-executor.js", import.meta.url).href);
    const runtimeApi = await import(new URL("../src/integration-runtime-authority.js", import.meta.url).href);
    return Object.freeze({ sessionApi, nativeExecutorApi, runtimeApi, mocks: Object.freeze([runnerMock, apiMock]) });
  } catch (error) {
    runnerMock.restore();
    apiMock.restore();
    throw error;
  }
}

function makeRuntimeConsumerFixture(runtimeApi, nativeExecutorApi, smokeRoot) {
  const runtimeRoot = path.join(smokeRoot, "runtime-consumer");
  const unsignedRoots = {
    schemaVersion: nativeExecutorApi.NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: path.join(runtimeRoot, "state", "sessions"),
    baseDir: path.join(runtimeRoot, "workspace"),
    commandCwd: path.join(runtimeRoot, "workspace"),
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  };
  const runtimeRoots = deepFreeze({ ...unsignedRoots, digest: contractDigest(unsignedRoots) });
  const repositoryAttestation = seal({
    schemaVersion: runtimeApi.INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    descriptorBound: true,
    nativeSessionMapping: "repository",
    onePublicThreadToOneNativeSession: true,
    principalBound: true,
    browserSessionBound: true,
    optimisticRevisions: true,
    casRevisions: true,
    immutableNativeSessionId: true,
    durableThreadSessionMapping: true,
    dispatchLeases: true,
    dispatchOutbox: true,
    nativeStartAuthorization: true,
    receiptRecoveryHold: true,
    exactReconciliationResults: true,
    preLaunchAbort: true,
    terminalOutbox: true,
    completionOutboxBundles: true,
    outboxDelivery: true,
    startupReconciliation: true,
    processIdentity: true,
    artifactTransactionalOutbox: true,
    publishedArtifactsOnly: true,
    exactOwnership: true,
    noPathThreadMapStore: true,
    durable: true,
    retainedDescriptorStorageAuthority: true,
    runtimeRoots,
  });
  async function unusedRepositoryMethod() {
    throw new Error("Retained event ledger bundle consumer fixture must not call repository methods.");
  }
  const repository = {
    [runtimeApi.INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY]: repositoryAttestation,
  };
  for (const method of RUNTIME_REPOSITORY_METHODS) repository[method] = unusedRepositoryMethod;
  Object.freeze(repository);
  const cancellationAttestation = seal({
    schemaVersion: runtimeApi.INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    abortControllerBound: true,
    exactRunOnly: true,
    browserSessionBound: true,
    cancellation: true,
  });
  const isolationAttestation = deepFreeze({
    profileVersion: "hardened-v1",
    profileDigest: "f".repeat(64),
    ...Object.fromEntries(REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.map((key) => [key, true])),
  });
  const hardenedSandboxAttestation = seal({
    schemaVersion: runtimeApi.INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation,
  });
  return Object.freeze({
    repository,
    repositoryAttestation,
    cancellationAttestation,
    hardenedSandboxAttestation,
  });
}

function nativeRuntimeProof(schemaVersion) {
  return Object.freeze({
    schemaVersion,
    owner: "aginti",
    stableSessionIds: true,
    runtimeRevisions: true,
    contextDigests: true,
    compactionMetadata: true,
    adaptersAreTransportOnly: true,
    noRawEvents: true,
    publicArtifactsOnly: true,
    noHostedProviders: true,
    noWrappers: true,
    noMcp: true,
    noWeb: true,
    sandboxPrerequisites: Object.freeze({
      owner: "aginti",
      valid: true,
      enabled: true,
      digest: "c".repeat(64),
    }),
    isolationAttestation: Object.freeze({}),
  });
}

function nativeRuntimeDouble(schemaVersion) {
  const proof = nativeRuntimeProof(schemaVersion);
  return Object.freeze({
    getIntegrationRuntimeProof() {
      return proof;
    },
  });
}

async function runPromiseAssimilationRegression(sessionReadView, scope, proof) {
  const thenDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "then");
  let hits = 0;
  try {
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        hits += 1;
        throw new Error("Object.prototype.then must stay untouched");
      },
    });
    const liveProof = sessionReadView.attest();
    const proofRoundTrip = await (async () => proof)();
    const ledgerRoundTrip = await (async () => sessionReadView.ledgerForRun(scope))();
    assert.equal(liveProof, proof);
    assert.equal(proofRoundTrip, proof);
    assert.equal(Object.getPrototypeOf(ledgerRoundTrip), null);
  } finally {
    if (thenDescriptor) Object.defineProperty(Object.prototype, "then", thenDescriptor);
    else delete Object.prototype.then;
  }
  assert.equal(hits, 0);
}

async function runCore() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-ledger-bundle-"));
  const authorities = [];
  let consumerMocks = [];
  try {
    const [serverSource, runtimeSource, sessionSource, productionBundleSource] = await Promise.all([
      fs.readFile(new URL("../src/integration-server.js", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/integration-runtime-authority.js", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/integration-session-service.js", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/integration-production-runtime-bundle.js", import.meta.url), "utf8"),
    ]);
    assert.match(serverSource, /export const INTEGRATION_MOUNT_CAPABILITY_ENABLED = false;/u);
    assert.equal(serverSource.includes("createRetainedIntegrationEventLedgerBundle"), false);
    assert.equal(runtimeSource.includes("createRetainedIntegrationEventLedgerBundle"), false);
    assert.equal(sessionSource.includes("createRetainedIntegrationEventLedgerBundle"), false);
    assert.equal(productionBundleSource.includes("createRetainedIntegrationEventLedgerBundle"), true);
    assert.match(productionBundleSource, /capabilityEnabled:\s*false/u);
    assert.match(productionBundleSource, /httpServingEnabled:\s*false/u);
    assert.match(productionBundleSource, /runtimeActivationIncluded:\s*false/u);

    const main = await openFixture(path.join(smokeRoot, "main"), "retained-ledger-bundle-main");
    authorities.push(main.authority);
    await expectCode(
      () => createRetainedIntegrationEventLedgerBundle(
        main.files,
        main.lock,
        Object.freeze({ ...main.expected, rootIdentityDigest: ZERO_DIGEST })
      ),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    const bundle = createRetainedIntegrationEventLedgerBundle(main.files, main.lock, main.expected);
    assert.equal(assertRetainedIntegrationEventLedgerBundle(bundle, main.expected), bundle);
    assert.equal(assertRetainedIntegrationEventLedgerStore(bundle.runtimeStore, main.expected), bundle.runtimeStore);
    assertExactFrozenSurface(bundle, BUNDLE_KEYS, null);
    assertExactFrozenSurface(bundle.runtimeStore, RUNTIME_STORE_KEYS);
    assertExactFrozenSurface(bundle.sessionReadView, SESSION_VIEW_KEYS, null);
    assertExactFrozenSurface(bundle.attestation, BUNDLE_PROOF_KEYS, null);
    assert.equal(bundle.schemaVersion, INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_VERSION);
    assert.equal(bundle.attestation.schemaVersion, INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_VERSION);
    assert.equal(bundle.attestation.limitations, INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS);
    assert.equal(bundle.attestation.digest, digestWithoutDigest(bundle.attestation));
    assert.equal(bundle.attestation.runtimeCapabilityEnabled, false);
    assert.equal(bundle.attestation.serverWiringIncluded, false);
    assert.equal(bundle.attestation.sessionAttestationUnderGlobalLock, false);
    assert.equal(bundle.attestation.sessionAttestationChecksOpenAndPoisonState, true);
    assert.equal(bundle.attestation.sessionAttestationDrainsOperations, false);
    assert.equal(bundle.attestation.limitations.sessionAttestationUsesGlobalLock, false);
    assert.equal(bundle.attestation.limitations.sessionAttestationChecksOpenAndPoisonState, true);
    assert.equal(bundle.attestation.limitations.sessionAttestationDrainsOperations, false);
    for (const forbidden of [
      "appendPublicEvent",
      "appendByOutboxId",
      "lookupByOutboxId",
      "files",
      "lock",
      "close",
      "integrationStorageAttestation",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(bundle.sessionReadView, forbidden), false);
      assert.equal(Object.prototype.hasOwnProperty.call(bundle, forbidden), false);
    }
    await expectCode(
      () => createRetainedIntegrationEventLedgerStore(main.files, main.lock, main.expected),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    await expectCode(
      () => assertRetainedIntegrationEventLedgerBundle(Object.freeze({ ...bundle }), main.expected),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    let proxyTraps = 0;
    const proxy = new Proxy(bundle, {
      get() {
        proxyTraps += 1;
        throw new Error("bundle Proxy trap must stay untouched");
      },
    });
    await expectCode(
      () => assertRetainedIntegrationEventLedgerBundle(proxy, main.expected),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(proxyTraps, 0);

    const sessionProof = await bundle.sessionReadView.attest();
    assertExactFrozenSurface(sessionProof, SESSION_PROOF_KEYS, null);
    assert.equal(sessionProof.maxEvents, main.expected.maxEvents);
    assert.equal(sessionProof.maxBytes, main.expected.maxBytes);
    assert.equal(sessionProof.digest, digestWithoutDigest(sessionProof));
    assert.equal(bundle.attestation.sessionProofDigest, sessionProof.digest);
    assert.equal(
      bundle.attestation.eventAppendProofDigest,
      bundle.runtimeStore.integrationEventAppendAttestation.digest
    );
    await expectCode(
      () => bundle.sessionReadView.attest(Object.freeze({ unsupported: true })),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );

    const consumers = await loadIntegrationConsumerApis();
    consumerMocks = consumers.mocks;
    const sessionApi = consumers.sessionApi;
    const runtime = nativeRuntimeDouble(sessionApi.NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION);
    const retainedSessionService = sessionApi.createNativeIntegrationSessionService({
      runtimeAuthority: runtime,
      eventLedgerStore: bundle.sessionReadView,
    });
    const retainedCapabilities = await retainedSessionService.getIntegrationCapabilities();
    assert.equal(retainedCapabilities.nativeIntegrationAuthority.eventLedgerPersisted, true);
    assert.equal(retainedCapabilities.nativeIntegrationAuthority.eventStoreProofDigest, sessionProof.digest);
    assert.equal(sessionProof.schemaVersion, sessionApi.NATIVE_INTEGRATION_EVENT_STORE_PROOF_VERSION);
    const rawRuntimeStoreService = sessionApi.createNativeIntegrationSessionService({
      runtimeAuthority: runtime,
      eventLedgerStore: bundle.runtimeStore,
    });
    assert.equal(
      (await rawRuntimeStoreService.getIntegrationCapabilities()).nativeIntegrationAuthority.eventLedgerPersisted,
      false
    );
    const runtimeFixture = makeRuntimeConsumerFixture(consumers.runtimeApi, consumers.nativeExecutorApi, smokeRoot);
    const realRuntimeAuthority = consumers.runtimeApi.createAgintiIntegrationRuntimeAuthority({
      threadSessionRepository: runtimeFixture.repository,
      eventLedgerStore: bundle.runtimeStore,
      cancellationAttestation: runtimeFixture.cancellationAttestation,
      hardenedSandboxAttestation: runtimeFixture.hardenedSandboxAttestation,
    });
    const realRuntimeProof = await realRuntimeAuthority.getIntegrationRuntimeProof();
    assert.equal(realRuntimeProof.repositoryProofDigest, runtimeFixture.repositoryAttestation.digest);
    assert.equal(
      realRuntimeProof.eventAppendProofDigest,
      bundle.runtimeStore.integrationEventAppendAttestation.digest
    );
    assert.equal(realRuntimeProof.schemaVersion, sessionApi.NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION);

    const scope = scopeFor(1);
    const first = await bundle.runtimeStore.appendPublicEvent(
      scope,
      appendInput("bundle first", "2026-08-21T01:00:00.000Z")
    );
    const sessionLedger = bundle.sessionReadView.ledgerForRun(scope);
    assert.equal(Object.getPrototypeOf(sessionLedger), null);
    assert.deepEqual(await sessionLedger.loadHead(), { seq: first.seq, hash: first.hash });
    assert.deepEqual(await sessionLedger.loadEventsAfter(0), [first]);
    assert.equal(sessionLedger.pointerDigest, bundle.runtimeStore.ledgerForRun(scope).pointerDigest);
    await runPromiseAssimilationRegression(bundle.sessionReadView, scope, sessionProof);

    const holder = await openIntegrationRetainedRegularFileLock(main.files, main.lockExpected);
    const entered = deferred();
    const release = deferred();
    const holding = holder.runExclusive(async () => {
      entered.resolve();
      await release.promise;
    }, { waitMs: main.expected.lockWaitMs });
    await entered.promise;
    const queuedAppend = bundle.runtimeStore.appendPublicEvent(
      scope,
      appendInput("bundle second", "2026-08-21T01:00:01.000Z")
    );
    const queuedRead = bundle.sessionReadView.ledgerForRun(scope).loadHead();
    assert.equal(bundle.sessionReadView.attest(), sessionProof);
    let appendSettled = false;
    let readSettled = false;
    void queuedAppend.then(
      () => { appendSettled = true; },
      () => { appendSettled = true; }
    );
    void queuedRead.then(
      () => { readSettled = true; },
      () => { readSettled = true; }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(appendSettled, false);
    assert.equal(readSettled, false);
    release.resolve();
    await holding;
    const second = await queuedAppend;
    assert.equal(second.seq, 2);
    assert.deepEqual(await queuedRead, {
      seq: second.seq,
      hash: second.hash,
    });

    const standalone = await openFixture(path.join(smokeRoot, "standalone"), "retained-ledger-bundle-standalone");
    authorities.push(standalone.authority);
    createRetainedIntegrationEventLedgerStore(standalone.files, standalone.lock, standalone.expected);
    await expectCode(
      () => createRetainedIntegrationEventLedgerBundle(standalone.files, standalone.lock, standalone.expected),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );

    const ambiguityChild = await execFileAsync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        fileURLToPath(import.meta.url),
        "--mock-mode=bundle-rename-ambiguous",
      ],
      { timeout: 25_000, maxBuffer: 1024 * 1024 }
    );
    assert.match(ambiguityChild.stdout, /integration retained event ledger bundle rename-ambiguous mock: ok/u);

    const poisonScope = scopeFor(2);
    await bundle.runtimeStore.appendPublicEvent(
      poisonScope,
      appendInput("poison seed", "2026-08-21T01:01:00.000Z")
    );
    const snapshotPath = path.join(main.dataPath, `${scopeDigest(poisonScope)}.json`);
    const tampered = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    tampered.owner = "not-aginti";
    await fs.writeFile(snapshotPath, `${JSON.stringify(tampered)}\n`);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const ignoredFailure = bundle.runtimeStore.ledgerForRun(poisonScope).loadHead();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    await expectCode(() => ignoredFailure, "PUBLIC_EVENT_LEDGER_CORRUPT", smokeRoot);
    process.removeListener("unhandledRejection", onUnhandled);
    await expectCode(() => bundle.sessionReadView.attest(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);
    assert.equal(unhandled.length, 0);

    const closed = await openFixture(path.join(smokeRoot, "closed"), "retained-ledger-bundle-closed");
    const closedBundle = createRetainedIntegrationEventLedgerBundle(closed.files, closed.lock, closed.expected);
    await closed.authority.close();
    await expectCode(() => closedBundle.sessionReadView.attest(), "PUBLIC_EVENT_LEDGER_UNAVAILABLE", smokeRoot);
    await expectCode(
      () => closedBundle.runtimeStore.ledgerForRun(scopeFor(3)),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );

    for (const fixture of [main, standalone]) {
      const names = await fs.readdir(fixture.dataPath);
      assert.equal(names.some((name) => name.startsWith(".aginti-atomic-v1-")), false);
    }
  } finally {
    for (const consumerMock of consumerMocks) consumerMock.restore();
    for (const authority of authorities.reverse()) await authority.close().catch(() => {});
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
    await fs.rm(smokeRoot, { recursive: true, force: true });
  }
}

async function runBundleAmbiguityMock() {
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-ledger-bundle-ambiguity-"));
  let fixture = null;
  try {
    fixture = await openFixture(
      path.join(smokeRoot, "root"),
      "retained-ledger-bundle-rename-ambiguous"
    );
    const bundle = createRetainedIntegrationEventLedgerBundle(fixture.files, fixture.lock, fixture.expected);
    const scope = scopeFor(71);
    ambiguityState.armed = true;
    const ambiguous = await expectCode(
      () => bundle.runtimeStore.appendPublicEvent(
        scope,
        appendInput("bundle ambiguous", "2026-08-21T01:02:00.000Z")
      ),
      "PUBLIC_EVENT_LEDGER_COMMIT_AMBIGUOUS",
      smokeRoot
    );
    assert.equal(ambiguous.details.operationStarted, true);
    assert.equal(ambiguous.details.operationSettled, true);
    assert.equal(ambiguous.details.operationFailed, true);
    await expectCode(() => bundle.sessionReadView.attest(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);
    await expectCode(
      () => bundle.sessionReadView.ledgerForRun(scope).loadHead(),
      "PUBLIC_EVENT_LEDGER_POISONED",
      smokeRoot
    );
  } finally {
    await fixture?.authority.close().catch(() => {});
    ambiguityFsMock?.restore();
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
}

const smokeOperation = MOCK_MODE === "bundle-rename-ambiguous" ? runBundleAmbiguityMock() : runCore();
smokeOperation.then(
  () => process.stdout.write(
    MOCK_MODE === "bundle-rename-ambiguous"
      ? "integration retained event ledger bundle rename-ambiguous mock: ok\n"
      : "integration retained event ledger bundle smoke: ok\n"
  ),
  (error) => {
    process.stderr.write(
      `integration retained event ledger bundle smoke: failed (${error?.publicCode || error?.code || error?.name || "ERROR"})\n`
    );
    process.exitCode = 1;
  }
);
