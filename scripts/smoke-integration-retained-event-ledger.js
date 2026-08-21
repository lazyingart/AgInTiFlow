#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const LOCK_NAME = ".aginti-flock-v1-event-ledger";
const ZERO_DIGEST = "0".repeat(64);
const SNAPSHOT_DOMAIN = "aginti-retained-public-event-ledger-snapshot";
const SCOPE_DOMAIN = "aginti-retained-public-event-ledger-scope-v1";
const MOCK_MODE = String(process.argv.find((value) => value.startsWith("--mock-mode=")) || "").slice(12);
const execFileAsync = promisify(execFile);
const STORE_KEYS = Object.freeze([
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
const PROOF_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "appendPublicEvent",
  "appendByOutboxId",
  "lookupByOutboxId",
  "terminalFinality",
  "durable",
  "persisted",
  "monotonic",
  "digest",
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

function identityDigest(contractDigest, stat) {
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

function scopeFor(index = 1) {
  const suffix = String(index).padStart(12, "0");
  return Object.freeze({
    principalId: "principal-retained-ledger",
    browserSessionId: "a".repeat(64),
    browserSessionPolicy: "same-browser-session",
    threadId: `thr_11111111-1111-4111-8111-${suffix}`,
    runId: `run_22222222-2222-4222-8222-${suffix}`,
  });
}

function scopeDigest(contractDigest, scope) {
  return contractDigest({ domain: SCOPE_DOMAIN, ...scope });
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function countJsonNodes(value) {
  let nodes = 0;
  let maximumDepth = 0;
  const visit = (item, depth) => {
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        for (const child of item) visit(child, depth + 1);
      } else {
        for (const key of Object.keys(item)) visit(item[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  return Object.freeze({ nodes, maximumDepth });
}

function assertExactFrozenSurface(value, keys) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
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
  const codes = Array.isArray(expected) ? expected : [expected];
  let captured;
  try {
    await action();
  } catch (error) {
    captured = error;
    if (codes.includes(error?.publicCode || error?.code)) {
      const publicText = publicErrorText(error);
      assert.equal(publicText.includes("/proc/self/fd"), false);
      assert.equal(publicText.includes(HELPER_PATH), false);
      assert.equal(/"fd"\s*:/u.test(publicText), false);
      if (forbiddenRoot) assert.equal(publicText.includes(forbiddenRoot), false);
      return error;
    }
  }
  if (!captured) assert.fail(`Expected ${codes.join("|")} rejection, but the operation completed.`);
  assert.fail(`Expected ${codes.join("|")}, got ${captured?.publicCode || captured?.code || captured?.name}.`);
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fdTargetsContaining(text) {
  const targets = [];
  for (const name of await fs.readdir("/proc/self/fd")) {
    const target = await fs.readlink(`/proc/self/fd/${name}`).catch(() => "");
    if (target.includes(text)) targets.push(target);
  }
  return targets.sort();
}

async function loadApi() {
  const [storage, durable, ledger, events, policy] = await Promise.all([
    import("../src/integration-storage-authority.js"),
    import("../src/integration-durable-common.js"),
    import("../src/integration-event-ledger-store.js"),
    import("../src/integration-events.js"),
    import("../src/integration-policy.js"),
  ]);
  return Object.freeze({ storage, durable, ledger, events, policy });
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

async function openFixture(api, rootPath, role, { maxEvents = 64, maxBytes = 256 * 1024, lockWaitMs = 2000 } = {}) {
  const dataPath = path.join(rootPath, "data");
  const lockPath = path.join(dataPath, LOCK_NAME);
  await makeOwnerDirectory(dataPath);
  await makeLockFile(lockPath);
  const authority = await api.storage.openIntegrationStorageAuthority({
    rootPath,
    role,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained event ledger smoke",
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
  const files = api.storage.createIntegrationRetainedFilePrimitives(directory, directoryExpected);
  const helperBytes = await fs.readFile(HELPER_PATH);
  const helperSha256 = crypto.createHash("sha256").update(helperBytes).digest("hex");
  const helperIdentityDigest = identityDigest(api.policy.contractDigest, await fs.stat(HELPER_PATH, { bigint: true }));
  const lockFileIdentityDigest = identityDigest(api.policy.contractDigest, await fs.stat(lockPath, { bigint: true }));
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
  const lock = await api.storage.openIntegrationRetainedRegularFileLock(files, lockExpected);
  return Object.freeze({ authority, directory, files, lock, lockExpected, expected, dataPath, lockPath, rootPath });
}

function appendInput(text, createdAt) {
  return Object.freeze({ type: "output.delta", payload: Object.freeze({ text }), createdAt });
}

function outboxInput(api, scope, predecessor, text, createdAt, outboxId) {
  const event = api.events.createPublicIntegrationEvent({
    threadId: scope.threadId,
    runId: scope.runId,
    seq: predecessor.seq + 1,
    type: "output.delta",
    payload: Object.freeze({ text }),
    createdAt,
    previousHash: predecessor.hash,
  });
  return Object.freeze({
    outboxId,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
    expectedPreviousSeq: predecessor.seq,
    expectedPreviousHash: predecessor.hash,
    expectedEventHash: event.hash,
  });
}

async function runPromisePoisonRegression(api, fixture, store, scope) {
  const holder = await api.storage.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
  const entered = deferred();
  const release = deferred();
  const holderActive = holder.runExclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const blocked = store.ledgerForRun(scope).loadHead();
  const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
  let queued;
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() { throw new Error("Promise species trap must stay untouched"); },
    });
    Object.defineProperty(Promise.prototype, "constructor", {
      configurable: true,
      get() { throw new Error("Promise constructor trap must stay untouched"); },
    });
    queued = store.ledgerForRun(scope).loadCursor(0);
  } finally {
    Object.defineProperty(Promise, Symbol.species, species);
    Object.defineProperty(Promise.prototype, "constructor", constructor);
    release.resolve();
  }
  await holderActive;
  const head = await blocked;
  assert.equal(head.seq, 0);
  assert.equal(head.hash, ZERO_DIGEST);
  assert.deepEqual(await queued, { seq: 0, hash: ZERO_DIGEST });
}

async function runInvalidSnapshotNodes(api, smokeRoot) {
  for (const kind of ["symlink", "hardlink", "fifo"]) {
    const fixture = await openFixture(api, path.join(smokeRoot, `invalid-${kind}`), `retained-ledger-${kind}`);
    const scope = scopeFor(kind === "symlink" ? 31 : kind === "hardlink" ? 32 : 33);
    const snapshotPath = path.join(fixture.dataPath, `${scopeDigest(api.policy.contractDigest, scope)}.json`);
    const outside = path.join(fixture.rootPath, `outside-${kind}.json`);
    try {
      await fs.writeFile(outside, "{}\n", { mode: 0o600 });
      await fs.chmod(outside, 0o600);
      if (kind === "symlink") await fs.symlink(outside, snapshotPath);
      else if (kind === "hardlink") await fs.link(outside, snapshotPath);
      else {
        await execFileAsync("mkfifo", [snapshotPath]);
        await fs.chmod(snapshotPath, 0o600);
      }
      const store = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
      await expectCode(
        () => withTimeout(store.ledgerForRun(scope).loadHead(), 1500, `${kind} snapshot read`),
        "PUBLIC_EVENT_LEDGER_CORRUPT",
        smokeRoot
      );
      await expectCode(() => store.ledgerForRun(scope).loadHead(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);
    } finally {
      await fixture.authority.close().catch(() => {});
    }
  }
}

async function runStructuralCapacityRegression(api, smokeRoot) {
  const fixture = await openFixture(api, path.join(smokeRoot, "structural-cap"), "retained-ledger-structure", {
    maxEvents: 1000,
    maxBytes: 16 * 1024 * 1024,
  });
  const scope = scopeFor(34);
  try {
    const steps = Object.freeze(Array.from({ length: 64 }, (_unused, index) => Object.freeze({
      id: `step-${index}`,
      label: `step ${index}`,
      status: "pending",
    })));
    const events = [];
    let previousHash = ZERO_DIGEST;
    for (let seq = 1; seq <= 400; seq += 1) {
      const event = api.events.createPublicIntegrationEvent({
        threadId: scope.threadId,
        runId: scope.runId,
        seq,
        type: "plan.updated",
        payload: Object.freeze({ steps }),
        createdAt: new Date(Date.UTC(2026, 7, 21, 0, 1, seq)).toISOString(),
        previousHash,
      });
      events.push(event);
      previousHash = event.hash;
    }
    const buildSnapshot = (length) => api.durable.sealObject({
      schemaVersion: api.ledger.INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_VERSION,
      owner: "aginti",
      authority: "aginti",
      mappingVersion: api.events.PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
      scopeDigest: scopeDigest(api.policy.contractDigest, scope),
      ...scope,
      maxEvents: fixture.expected.maxEvents,
      maxBytes: fixture.expected.maxBytes,
      events: Object.freeze(events.slice(0, length)),
      receipts: Object.freeze([]),
    }, SNAPSHOT_DOMAIN);
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countJsonNodes(buildSnapshot(middle)).nodes <= 100_000) low = middle;
      else high = middle - 1;
    }
    const baseline = buildSnapshot(low);
    assert.equal(low > 0 && low < events.length, true);
    assert.equal(countJsonNodes(baseline).nodes <= 100_000, true);
    assert.equal(countJsonNodes(buildSnapshot(low + 1)).nodes > 100_000, true);
    const snapshotName = `${scopeDigest(api.policy.contractDigest, scope)}.json`;
    await fixture.files.atomicWriteProtectedJson(snapshotName, baseline, { maxBytes: fixture.expected.maxBytes });
    const baselineRaw = await fs.readFile(path.join(fixture.dataPath, snapshotName), "utf8");
    const store = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
    await expectCode(
      () => store.appendPublicEvent(scope, {
        type: "plan.updated",
        payload: Object.freeze({ steps }),
        createdAt: new Date(Date.UTC(2026, 7, 21, 0, 1, low + 1)).toISOString(),
      }),
      "PUBLIC_EVENT_LEDGER_FULL",
      smokeRoot
    );
    assert.equal(await fs.readFile(path.join(fixture.dataPath, snapshotName), "utf8"), baselineRaw);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runPointerReopenRegression(api, smokeRoot) {
  const rootPath = path.join(smokeRoot, "pointer-reopen");
  const role = "retained-ledger-pointer";
  const scope = scopeFor(35);
  let fixture = await openFixture(api, rootPath, role);
  let pointerDigest;
  try {
    const store = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
    pointerDigest = store.ledgerForRun(scope).pointerDigest;
    await store.appendPublicEvent(scope, appendInput("stable pointer", "2026-08-21T00:02:00.000Z"));
  } finally {
    await fixture.authority.close().catch(() => {});
  }
  fixture = await openFixture(api, rootPath, role);
  try {
    const reopened = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
    const ledger = reopened.ledgerForRun(scope);
    assert.equal(ledger.pointerDigest, pointerDigest);
    assert.equal((await ledger.loadHead()).seq, 1);
  } finally {
    await fixture.authority.close().catch(() => {});
  }
}

async function runCoreSmoke() {
  const api = await loadApi();
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-event-ledger-"));
  const authorities = [];
  try {
    const serverSource = await fs.readFile(new URL("../src/integration-server.js", import.meta.url), "utf8");
    const runtimeSource = await fs.readFile(new URL("../src/integration-runtime-authority.js", import.meta.url), "utf8");
    assert.match(serverSource, /export const INTEGRATION_MOUNT_CAPABILITY_ENABLED = false;/u);
    assert.equal(serverSource.includes("createRetainedIntegrationEventLedgerStore"), false);
    assert.equal(runtimeSource.includes("createRetainedIntegrationEventLedgerStore"), false);

    const fixture = await openFixture(api, path.join(smokeRoot, "main"), "retained-ledger-main");
    authorities.push(fixture.authority);
    await expectCode(
      () => api.ledger.createRetainedIntegrationEventLedgerStore(
        fixture.files,
        fixture.lock,
        { ...fixture.expected, rootIdentityDigest: "0".repeat(64) }
      ),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    const store = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
    assert.equal(api.ledger.assertRetainedIntegrationEventLedgerStore(store, fixture.expected), store);
    assertExactFrozenSurface(store, STORE_KEYS);
    assertExactFrozenSurface(store.integrationEventAppendAttestation, PROOF_KEYS);
    assert.equal(
      store.integrationEventAppendAttestation.digest,
      api.policy.contractDigest(Object.fromEntries(
        Object.entries(store.integrationEventAppendAttestation).filter(([key]) => key !== "digest")
      ))
    );
    await expectCode(
      () => api.ledger.assertRetainedIntegrationEventLedgerStore(Object.freeze({ ...store })),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    await expectCode(
      () => api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    const limits = api.ledger.INTEGRATION_RETAINED_EVENT_LEDGER_LIMITATIONS;
    assert.equal(limits.runtimeCapabilityEnabled, false);
    assert.equal(limits.runtimeWiringIncluded, false);
    assert.equal(limits.untokenedAppendRetryIdempotency, false);
    assert.equal(limits.ambiguousLockReleaseRequiresProcessRestart, true);
    assert.equal(limits.validSnapshotRollbackDetection, false);
    assert.equal(limits.noEnumeration, true);
    assert.equal(limits.noPrune, true);

    const emptyScope = scopeFor(1);
    const emptyLedger = store.ledgerForRun(emptyScope);
    assert.deepEqual(await emptyLedger.loadEventsAfter(), []);
    assert.deepEqual(await emptyLedger.loadCursor(), { seq: 0, hash: ZERO_DIGEST });
    assert.deepEqual(await emptyLedger.loadHead(), { seq: 0, hash: ZERO_DIGEST });
    assert.equal(await store.lookupByOutboxId(emptyScope, { outboxId: "outbox.empty" }), null);
    for (const badCursor of [null, "0", false, "", {}, Symbol("cursor")]) {
      await expectCode(() => emptyLedger.loadEventsAfter(badCursor), "INVALID_REQUEST", smokeRoot);
    }

    let proxyTouched = false;
    const proxyScope = new Proxy(emptyScope, { get() { proxyTouched = true; throw new Error("scope trap"); } });
    await expectCode(
      () => store.appendPublicEvent(proxyScope, appendInput("safe", "2026-08-21T00:00:00.000Z")),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(proxyTouched, false);
    let getterTouched = false;
    const getterInput = { payload: { text: "safe" } };
    Object.defineProperty(getterInput, "type", {
      enumerable: true,
      get() { getterTouched = true; return "output.delta"; },
    });
    await expectCode(() => store.appendPublicEvent(emptyScope, getterInput), "PUBLIC_EVENT_LEDGER_UNAVAILABLE", smokeRoot);
    assert.equal(getterTouched, false);
    await expectCode(
      () => store.appendPublicEvent(emptyScope, { ...appendInput("safe", "2026-08-21T00:00:00.000Z"), [Symbol("bad")]: true }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    await expectCode(
      () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: { text: "safe" }, createdAt: null }),
      "INVALID_REQUEST",
      smokeRoot
    );
    for (const createdAt of ["x".repeat(100_000), "2026-08-21 00:00:00Z"] ) {
      await expectCode(
        () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: { text: "safe" }, createdAt }),
        "INVALID_REQUEST",
        smokeRoot
      );
    }
    const secretKey = "/private/secret/path-token";
    const secretPayload = Object.create(null);
    Object.defineProperty(secretPayload, secretKey, { enumerable: true, value: Symbol("bad") });
    const secretError = await expectCode(
      () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: secretPayload }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(publicErrorText(secretError).includes(secretKey), false);
    let secretGetterTouched = false;
    const secretGetterPayload = Object.create(null);
    Object.defineProperty(secretGetterPayload, secretKey, {
      enumerable: true,
      get() { secretGetterTouched = true; return "unsafe"; },
    });
    const secretGetterError = await expectCode(
      () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: secretGetterPayload }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(secretGetterTouched, false);
    assert.equal(publicErrorText(secretGetterError).includes(secretKey), false);
    let nestedProxyTouched = false;
    const nestedProxy = new Proxy({}, { get() { nestedProxyTouched = true; throw new Error("nested proxy trap"); } });
    await expectCode(
      () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: { text: nestedProxy } }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(nestedProxyTouched, false);
    let nestedGetterTouched = false;
    const nestedGetter = {};
    Object.defineProperty(nestedGetter, "text", {
      enumerable: true,
      get() { nestedGetterTouched = true; return "unsafe"; },
    });
    await expectCode(
      () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: nestedGetter }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(nestedGetterTouched, false);
    let thenableTouched = false;
    await expectCode(
      () => store.appendPublicEvent(emptyScope, {
        type: "output.delta",
        payload: { text: "safe", then() { thenableTouched = true; } },
      }),
      "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      smokeRoot
    );
    assert.equal(thenableTouched, false);
    for (const dangerous of [
      JSON.parse('{"__proto__":{"polluted":"yes"}}'),
      JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}'),
    ]) {
      await expectCode(
        () => store.appendPublicEvent(emptyScope, { type: "output.delta", payload: dangerous }),
        "UNSUPPORTED_FIELD",
        smokeRoot
      );
      assert.equal(Object.prototype.polluted, undefined);
    }

    for (const [normalizingScope, type, payload] of [
      [scopeFor(21), "plan.updated", { steps: [{ id: "step-1", label: " padded plan label ", status: "pending" }] }],
      [scopeFor(22), "tool.started", {
        callId: "call-1",
        publicLabel: " padded tool label ",
        publicSummary: "safe summary",
        at: "2026-08-21T00:00:00.000Z",
      }],
    ]) {
      await expectCode(
        () => store.appendPublicEvent(normalizingScope, {
          type,
          payload,
          createdAt: "2026-08-21T00:00:00.000Z",
        }),
        "INVALID_REQUEST",
        smokeRoot
      );
      await assert.rejects(
        fs.lstat(path.join(fixture.dataPath, `${scopeDigest(api.policy.contractDigest, normalizingScope)}.json`)),
        { code: "ENOENT" }
      );
    }

    await runPromisePoisonRegression(api, fixture, store, scopeFor(2));

    const scope = scopeFor(3);
    const first = await store.appendPublicEvent(scope, appendInput("first", "2026-08-21T00:00:01.000Z"));
    assert.equal(first.seq, 1);
    const outbox = outboxInput(api, scope, first, "second", "2026-08-21T00:00:02.000Z", "outbox.second");
    const second = await store.appendByOutboxId(scope, outbox);
    assert.equal(second.seq, 2);
    assert.deepEqual(await store.lookupByOutboxId(scope, { outboxId: outbox.outboxId }), second);
    const preConflictPath = path.join(fixture.dataPath, `${scopeDigest(api.policy.contractDigest, scope)}.json`);
    const preConflictRaw = await fs.readFile(preConflictPath, "utf8");
    const sameReceiptMismatches = [
      { ...outbox, type: "output.completed", payload: {} },
      { ...outbox, payload: { text: "changed" } },
      { ...outbox, createdAt: "2026-08-21T00:00:02.001Z" },
      { ...outbox, expectedPreviousSeq: 0 },
      { ...outbox, expectedPreviousHash: "b".repeat(64) },
      { ...outbox, expectedEventHash: "c".repeat(64) },
    ];
    for (const mismatch of sameReceiptMismatches) {
      await expectCode(() => store.appendByOutboxId(scope, mismatch), "PUBLIC_EVENT_LEDGER_OUTBOX_CONFLICT", smokeRoot);
      assert.equal(await fs.readFile(preConflictPath, "utf8"), preConflictRaw);
    }
    await expectCode(
      () => store.appendByOutboxId(scope, {
        ...outbox,
        outboxId: "outbox.bad-predecessor",
        expectedPreviousSeq: 0,
        expectedPreviousHash: ZERO_DIGEST,
      }),
      "PUBLIC_EVENT_LEDGER_CONFLICT",
      smokeRoot
    );
    await expectCode(
      () => store.appendByOutboxId(scope, {
        ...outboxInput(api, scope, second, "third", "2026-08-21T00:00:02.500Z", "outbox.bad-hash"),
        expectedEventHash: "d".repeat(64),
      }),
      "PUBLIC_EVENT_LEDGER_CONFLICT",
      smokeRoot
    );
    assert.equal(await fs.readFile(preConflictPath, "utf8"), preConflictRaw);
    const terminal = await store.appendPublicEvent(scope, {
      type: "run.completed",
      payload: Object.freeze({}),
      createdAt: "2026-08-21T00:00:03.000Z",
    });
    assert.equal(terminal.seq, 3);
    assert.deepEqual(await store.appendByOutboxId(scope, outbox), second);
    await expectCode(
      () => store.appendPublicEvent(scope, appendInput("after-terminal", "2026-08-21T00:00:04.000Z")),
      "PUBLIC_EVENT_LEDGER_CONFLICT",
      smokeRoot
    );
    assert.deepEqual(await store.ledgerForRun(scope).loadEventsAfter(1), [second, terminal]);
    assert.deepEqual(await store.ledgerForRun(scope).loadCursor(2), { seq: 2, hash: second.hash });
    assert.deepEqual(await store.ledgerForRun(scope).loadHead(), { seq: 3, hash: terminal.hash });

    const unkeyedScope = scopeFor(4);
    const unkeyedInput = appendInput("unkeyed", "2026-08-21T00:00:05.000Z");
    const unkeyed = await store.appendPublicEvent(unkeyedScope, unkeyedInput);
    const retroactive = Object.freeze({
      outboxId: "outbox.retroactive",
      type: unkeyed.type,
      payload: unkeyed.payload,
      createdAt: unkeyed.createdAt,
      expectedPreviousSeq: 0,
      expectedPreviousHash: ZERO_DIGEST,
      expectedEventHash: unkeyed.hash,
    });
    await expectCode(
      () => store.appendByOutboxId(unkeyedScope, retroactive),
      "PUBLIC_EVENT_LEDGER_CONFLICT",
      smokeRoot
    );
    assert.equal(await store.lookupByOutboxId(unkeyedScope, { outboxId: retroactive.outboxId }), null);

    const secondLock = await api.storage.openIntegrationRetainedRegularFileLock(fixture.files, fixture.lockExpected);
    const secondStore = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, secondLock, fixture.expected);
    const concurrentScope = scopeFor(5);
    const appendA = store.appendPublicEvent(concurrentScope, appendInput("concurrent-a", "2026-08-21T00:00:06.000Z"));
    const headAfterA = store.ledgerForRun(concurrentScope).loadHead();
    const appendB = secondStore.appendPublicEvent(concurrentScope, appendInput("concurrent-b", "2026-08-21T00:00:07.000Z"));
    const [eventA, queuedHead, eventB] = await Promise.all([appendA, headAfterA, appendB]);
    assert.deepEqual([eventA.seq, eventB.seq].sort((left, right) => left - right), [1, 2]);
    assert.equal(queuedHead.seq >= eventA.seq, true);
    const concurrentEvents = await store.ledgerForRun(concurrentScope).loadEventsAfter(0);
    assert.deepEqual(concurrentEvents.map((event) => event.seq), [1, 2]);
    assert.deepEqual(
      new Set(concurrentEvents.map((event) => event.hash)),
      new Set([eventA.hash, eventB.hash])
    );

    const snapshotName = `${scopeDigest(api.policy.contractDigest, scope)}.json`;
    const snapshotRaw = await fs.readFile(path.join(fixture.dataPath, snapshotName), "utf8");
    const snapshot = JSON.parse(snapshotRaw);
    assert.equal(snapshotRaw, `${canonicalJson(snapshot)}\n`);
    assert.equal(snapshot.scopeDigest, path.basename(snapshotName, ".json"));
    assert.equal(snapshot.receipts.length, 1);
    assert.equal(snapshot.receipts[0].eventSeq, second.seq);
    assert.equal(JSON.stringify(snapshot.events).includes("outbox.second"), false);
    assert.equal(JSON.stringify(await store.ledgerForRun(scope).loadEventsAfter(0)).includes("receipts"), false);
    assert.equal(JSON.stringify(await store.ledgerForRun(scope).loadEventsAfter(0)).includes("outbox.second"), false);
    const entries = await fs.readdir(fixture.dataPath, { withFileTypes: true });
    assert.equal(entries.every((entry) => entry.isFile()), true);
    assert.equal(entries.some((entry) => entry.name.startsWith(".aginti-atomic-v1-")), false);

    const capFixture = await openFixture(api, path.join(smokeRoot, "event-cap"), "retained-ledger-cap", {
      maxEvents: 1,
      maxBytes: 64 * 1024,
    });
    authorities.push(capFixture.authority);
    const capStore = api.ledger.createRetainedIntegrationEventLedgerStore(capFixture.files, capFixture.lock, capFixture.expected);
    const capScope = scopeFor(10);
    const unhandled = [];
    const recordUnhandled = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", recordUnhandled);
    let capRejected;
    try {
      const capFirst = capStore.appendPublicEvent(capScope, appendInput("one", "2026-08-21T00:00:08.000Z"));
      capRejected = capStore.appendPublicEvent(capScope, appendInput("two", "2026-08-21T00:00:09.000Z"));
      const capHead = capStore.ledgerForRun(capScope).loadHead();
      assert.equal((await capFirst).seq, 1);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      await expectCode(() => capRejected, "PUBLIC_EVENT_LEDGER_FULL", smokeRoot);
      assert.equal((await capHead).seq, 1);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
    const capPath = path.join(capFixture.dataPath, `${scopeDigest(api.policy.contractDigest, capScope)}.json`);
    const capRaw = await fs.readFile(capPath, "utf8");
    await expectCode(
      () => capStore.appendPublicEvent(capScope, appendInput("three", "2026-08-21T00:00:10.000Z")),
      "PUBLIC_EVENT_LEDGER_FULL",
      smokeRoot
    );
    assert.equal(await fs.readFile(capPath, "utf8"), capRaw);

    const byteFixture = await openFixture(api, path.join(smokeRoot, "byte-cap"), "retained-ledger-bytes", {
      maxEvents: 4,
      maxBytes: 4096,
    });
    authorities.push(byteFixture.authority);
    const byteStore = api.ledger.createRetainedIntegrationEventLedgerStore(byteFixture.files, byteFixture.lock, byteFixture.expected);
    const byteScope = scopeFor(11);
    await expectCode(
      () => byteStore.appendPublicEvent(byteScope, appendInput("x".repeat(3900), "2026-08-21T00:00:11.000Z")),
      "PUBLIC_EVENT_LEDGER_FULL",
      smokeRoot
    );
    await assert.rejects(fs.lstat(path.join(byteFixture.dataPath, `${scopeDigest(api.policy.contractDigest, byteScope)}.json`)), {
      code: "ENOENT",
    });

    const tamperFixture = await openFixture(api, path.join(smokeRoot, "tamper"), "retained-ledger-tamper");
    authorities.push(tamperFixture.authority);
    const tamperStore = api.ledger.createRetainedIntegrationEventLedgerStore(
      tamperFixture.files,
      tamperFixture.lock,
      tamperFixture.expected
    );
    const tamperScope = scopeFor(12);
    const tamperSeed = await tamperStore.appendPublicEvent(
      tamperScope,
      appendInput("seed", "2026-08-21T00:00:12.000Z")
    );
    const tamperOutbox = outboxInput(
      api,
      tamperScope,
      tamperSeed,
      "receipt",
      "2026-08-21T00:00:13.000Z",
      "outbox.tamper"
    );
    await tamperStore.appendByOutboxId(tamperScope, tamperOutbox);
    const tamperName = `${scopeDigest(api.policy.contractDigest, tamperScope)}.json`;
    const tamperSnapshot = JSON.parse(await fs.readFile(path.join(tamperFixture.dataPath, tamperName), "utf8"));
    const { integrityDigest: _oldDigest, ...tamperUnsigned } = tamperSnapshot;
    tamperUnsigned.receipts = tamperSnapshot.receipts.map((receipt) => ({
      ...receipt,
      requestDigest: "f".repeat(64),
    }));
    const resealed = api.durable.sealObject(tamperUnsigned, SNAPSHOT_DOMAIN);
    await tamperFixture.files.atomicWriteProtectedJson(tamperName, resealed, { maxBytes: tamperFixture.expected.maxBytes });
    const viewUnhandled = [];
    const recordViewUnhandled = (reason) => { viewUnhandled.push(reason); };
    process.on("unhandledRejection", recordViewUnhandled);
    const ignoredCorruptView = tamperStore.ledgerForRun(tamperScope).loadHead();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(viewUnhandled, []);
    process.off("unhandledRejection", recordViewUnhandled);
    await expectCode(() => ignoredCorruptView, "PUBLIC_EVENT_LEDGER_CORRUPT", smokeRoot);
    await expectCode(() => tamperStore.ledgerForRun(tamperScope).loadHead(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);

    const chainFixture = await openFixture(api, path.join(smokeRoot, "chain-tamper"), "retained-ledger-chain");
    authorities.push(chainFixture.authority);
    const chainStore = api.ledger.createRetainedIntegrationEventLedgerStore(
      chainFixture.files,
      chainFixture.lock,
      chainFixture.expected
    );
    const chainScope = scopeFor(14);
    await chainStore.appendPublicEvent(chainScope, appendInput("chain-one", "2026-08-21T00:00:14.000Z"));
    await chainStore.appendPublicEvent(chainScope, appendInput("chain-two", "2026-08-21T00:00:15.000Z"));
    const chainName = `${scopeDigest(api.policy.contractDigest, chainScope)}.json`;
    const chainSnapshot = JSON.parse(await fs.readFile(path.join(chainFixture.dataPath, chainName), "utf8"));
    const { hash: _oldEventHash, ...changedSecondUnsigned } = chainSnapshot.events[1];
    changedSecondUnsigned.previousHash = "e".repeat(64);
    const changedSecond = Object.freeze({
      ...changedSecondUnsigned,
      hash: api.policy.contractDigest(changedSecondUnsigned),
    });
    const { integrityDigest: _oldChainDigest, ...chainUnsigned } = chainSnapshot;
    chainUnsigned.events = Object.freeze([chainSnapshot.events[0], changedSecond]);
    const resealedChain = api.durable.sealObject(chainUnsigned, SNAPSHOT_DOMAIN);
    await chainFixture.files.atomicWriteProtectedJson(chainName, resealedChain, {
      maxBytes: chainFixture.expected.maxBytes,
    });
    await expectCode(() => chainStore.ledgerForRun(chainScope).loadHead(), "PUBLIC_EVENT_LEDGER_CORRUPT", smokeRoot);
    await expectCode(() => chainStore.ledgerForRun(chainScope).loadHead(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);

    const missingFixture = await openFixture(api, path.join(smokeRoot, "missing"), "retained-ledger-missing");
    authorities.push(missingFixture.authority);
    const missingStore = api.ledger.createRetainedIntegrationEventLedgerStore(
      missingFixture.files,
      missingFixture.lock,
      missingFixture.expected
    );
    const missingScope = scopeFor(13);
    await missingStore.appendPublicEvent(missingScope, appendInput("present", "2026-08-21T00:00:14.000Z"));
    await fs.unlink(path.join(missingFixture.dataPath, `${scopeDigest(api.policy.contractDigest, missingScope)}.json`));
    await expectCode(() => missingStore.ledgerForRun(missingScope).loadHead(), "PUBLIC_EVENT_LEDGER_CORRUPT", smokeRoot);
    await expectCode(() => missingStore.ledgerForRun(missingScope).loadHead(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);

    await runInvalidSnapshotNodes(api, smokeRoot);
    await runStructuralCapacityRegression(api, smokeRoot);
    await runPointerReopenRegression(api, smokeRoot);

    for (const authority of authorities.reverse()) await authority.close().catch(() => {});
    authorities.length = 0;
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
    for (const mode of [
      "rename-ambiguous",
      "outbox-rename-ambiguous",
      "postwrite-read-failure",
      "post-operation-lock-replacement",
    ]) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--experimental-test-module-mocks", fileURLToPath(import.meta.url), `--mock-mode=${mode}`],
        { timeout: 25_000, maxBuffer: 1024 * 1024 }
      );
      assert.match(stdout, new RegExp(`integration retained event ledger ${mode} mock: ok`, "u"));
    }
  } finally {
    for (const authority of authorities.reverse()) await authority.close().catch(() => {});
    await fs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write("integration retained event ledger smoke: ok\n");
}

async function runAmbiguityMock(mode) {
  const { mock } = await import("node:test");
  const realFs = (await import("node:fs/promises")).default;
  const state = { armed: false, failNextRead: false, lockPath: "" };
  const mockFs = { ...realFs };
  mockFs.rename = async (source, target) => {
    await realFs.rename(source, target);
    if (state.armed && String(target).endsWith(".json")) {
      state.armed = false;
      if (mode === "rename-ambiguous" || mode === "outbox-rename-ambiguous") {
        throw new Error("synthetic /proc/self/fd/991 rename ambiguity");
      }
      if (mode === "postwrite-read-failure") state.failNextRead = true;
      if (mode === "post-operation-lock-replacement") {
        await realFs.rename(state.lockPath, `${state.lockPath}.replaced`);
        await realFs.writeFile(state.lockPath, "", { mode: 0o600 });
        await realFs.chmod(state.lockPath, 0o600);
        await realFs.chown(state.lockPath, UID, GID);
      }
    }
  };
  mockFs.open = async (target, flags, ...args) => {
    if (state.failNextRead && String(target).endsWith(".json")) {
      state.failNextRead = false;
      throw new Error("synthetic /proc/self/fd/992 postwrite read failure");
    }
    return realFs.open(target, flags, ...args);
  };
  const fsMock = mock.module("node:fs/promises", { defaultExport: mockFs });
  const api = await loadApi();
  const smokeRoot = await realFs.mkdtemp(path.join(os.tmpdir(), `aginti-retained-ledger-${mode}-`));
  let fixture;
  try {
    fixture = await openFixture(api, path.join(smokeRoot, "root"), `retained-ledger-${mode}`);
    state.lockPath = fixture.lockPath;
    const store = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, fixture.lock, fixture.expected);
    const scope = scopeFor(
      mode === "rename-ambiguous" ? 41 :
        mode === "outbox-rename-ambiguous" ? 42 :
          mode === "postwrite-read-failure" ? 43 : 44
    );
    const outbox = outboxInput(
      api,
      scope,
      Object.freeze({ seq: 0, hash: ZERO_DIGEST }),
      "ambiguous",
      "2026-08-21T00:00:15.000Z",
      "outbox.ambiguous"
    );
    state.armed = true;
    const ambiguous = await expectCode(
      () => mode === "outbox-rename-ambiguous"
        ? store.appendByOutboxId(scope, outbox)
        : store.appendPublicEvent(scope, appendInput("ambiguous", "2026-08-21T00:00:15.000Z")),
      "PUBLIC_EVENT_LEDGER_COMMIT_AMBIGUOUS",
      smokeRoot
    );
    assert.equal(ambiguous.details.operationStarted, true);
    assert.equal(ambiguous.details.operationSettled, true);
    assert.equal(ambiguous.details.operationFailed, mode !== "post-operation-lock-replacement");
    if (mode === "postwrite-read-failure") {
      assert.equal(ambiguous.details.writeConfirmed, true);
      assert.equal(ambiguous.details.postWriteVerified, false);
    }
    if (mode === "post-operation-lock-replacement") {
      assert.equal(ambiguous.details.writeConfirmed, true);
      assert.equal(ambiguous.details.postWriteVerified, true);
    }
    await expectCode(() => store.ledgerForRun(scope).loadHead(), "PUBLIC_EVENT_LEDGER_POISONED", smokeRoot);
    const recoveredLockIdentity = identityDigest(
      api.policy.contractDigest,
      await realFs.stat(fixture.lockPath, { bigint: true })
    );
    const recoveryLockExpected = Object.freeze({
      ...fixture.lockExpected,
      lockFileIdentityDigest: recoveredLockIdentity,
    });
    const recoveryExpected = Object.freeze({
      ...fixture.expected,
      lockFileIdentityDigest: recoveredLockIdentity,
    });
    const recoveryLock = await api.storage.openIntegrationRetainedRegularFileLock(fixture.files, recoveryLockExpected);
    const recovered = api.ledger.createRetainedIntegrationEventLedgerStore(fixture.files, recoveryLock, recoveryExpected);
    if (mode === "outbox-rename-ambiguous") {
      const retried = await recovered.appendByOutboxId(scope, outbox);
      const lookedUp = await recovered.lookupByOutboxId(scope, { outboxId: outbox.outboxId });
      const events = await recovered.ledgerForRun(scope).loadEventsAfter(0);
      assert.equal(retried.seq, 1);
      assert.deepEqual(lookedUp, retried);
      assert.deepEqual(events, [retried]);
      assert.equal((await recovered.ledgerForRun(scope).loadHead()).seq, 1);
      const raw = JSON.parse(await realFs.readFile(
        path.join(fixture.dataPath, `${scopeDigest(api.policy.contractDigest, scope)}.json`),
        "utf8"
      ));
      assert.equal(raw.events.length, 1);
      assert.equal(raw.receipts.length, 1);
    } else {
      assert.equal((await recovered.ledgerForRun(scope).loadHead()).seq, 1);
    }
  } finally {
    await fixture?.authority.close().catch(() => {});
    fsMock.restore();
    await realFs.rm(smokeRoot, { recursive: true, force: true });
    assert.deepEqual(await fdTargetsContaining(smokeRoot), []);
  }
  process.stdout.write(`integration retained event ledger ${mode} mock: ok\n`);
}

if ([
  "rename-ambiguous",
  "outbox-rename-ambiguous",
  "postwrite-read-failure",
  "post-operation-lock-replacement",
].includes(MOCK_MODE)) await runAmbiguityMock(MOCK_MODE);
else await runCoreSmoke();
