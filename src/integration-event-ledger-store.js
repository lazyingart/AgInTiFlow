import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  createPublicIntegrationEvent,
  INTEGRATION_EVENT_TYPES,
  MAX_INTEGRATION_EVENT_BATCH,
  validateIntegrationEventPayload,
  validatePublicIntegrationEvent,
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
} from "./integration-events.js";
import {
  contractDigest,
  integrationBoundedInteger,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  assertDigest,
  assertRetainedProtectedFilePrimitives,
  assertRetainedRegularFileLock,
  assertSafeSegment,
  assertSealedObject,
  atomicWriteProtectedJson,
  authorityFail,
  fsyncDirectory,
  ensureOwnerOnlyDirectory,
  ensureStoreLayout,
  nowIso,
  parseIsoMs,
  randomHex,
  readProtectedJsonFile,
  readProtectedUtf8File,
  relativePointer,
  sealObject,
  sha256Text,
  withDirectoryLock,
} from "./integration-durable-common.js";

export const INTEGRATION_EVENT_LEDGER_STORE_SCHEMA_VERSION = "aginti-public-integration-event-ledger-store-v1";
export const INTEGRATION_EVENT_LEDGER_HEADER_SCHEMA_VERSION = "aginti-public-integration-event-ledger-header-v1";
export const INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN = "aginti-public-integration-event-ledger-header";
export const INTEGRATION_EVENT_LEDGER_ATTESTATION_VERSION = "aginti-public-integration-event-ledger-attestation-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_VERSION =
  "aginti-retained-public-event-ledger-snapshot-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_RECEIPT_VERSION =
  "aginti-retained-public-event-ledger-receipt-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_INTEGRITY_DOMAIN =
  "aginti-retained-public-event-ledger-snapshot";
export const INTEGRATION_RETAINED_EVENT_LEDGER_APPEND_ATTESTATION_VERSION =
  "aginti-public-event-append-attestation-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_APPEND_ATTESTATION_PROPERTY =
  "integrationEventAppendAttestation";
export const INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_VERSION =
  "aginti-retained-public-event-ledger-bundle-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_VERSION =
  "aginti-retained-public-event-ledger-bundle-attestation-v1";
export const INTEGRATION_RETAINED_EVENT_LEDGER_LIMITATIONS = Object.freeze({
  preEnablePrimitive: true,
  runtimeCapabilityEnabled: false,
  runtimeWiringIncluded: false,
  onePreprovisionedRetainedDirectoryRequired: true,
  onePreprovisionedFixedLockFileRequired: true,
  deterministicRunSnapshotFiles: true,
  dynamicDirectoryCreation: false,
  atomicSnapshotFileCreation: true,
  globalStoreLock: true,
  globalLockSerializesAllRuns: true,
  lockSurfaceExclusiveOwnershipRequired: true,
  boundedInProcessFifo: true,
  maxPendingOperations: 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
  sameKernelHostRequired: true,
  crossHostExclusion: false,
  localFilesystemRequired: true,
  localFilesystemVerified: false,
  networkFilesystemSafety: false,
  cooperativeParticipantsOnly: true,
  sameUidMutationSafety: false,
  namedBindingRaceFree: false,
  noEnumeration: true,
  noPrune: true,
  noDelete: true,
  noMigration: true,
  noGlobalFileCountBound: true,
  perRunEventAndByteCaps: true,
  wholeSnapshotRewrite: true,
  physicalAppendOnlyFile: false,
  untokenedAppendRetryIdempotency: false,
  eventAndOutboxReceiptAtomicTogether: true,
  cursorDerivedFromEvents: true,
  crashMayLeaveReservedTemp: true,
  automaticTempRecovery: false,
  commitAmbiguityPoisonsSurface: true,
  releaseAmbiguityPoisonsSurface: true,
  atomicCommitAmbiguityRequiresFreshFactory: true,
  ambiguousLockReleaseRequiresProcessRestart: true,
  validSnapshotRollbackDetection: false,
  diskExhaustionFailsClosed: true,
  hardwareDurabilityGuarantee: false,
});
export const INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS = Object.freeze({
  preEnableBundle: true,
  runtimeCapabilityEnabled: false,
  runtimeWiringIncluded: false,
  sessionServiceWiringIncluded: false,
  serverWiringIncluded: false,
  productionDependencySetComplete: false,
  integrationStorageAttestationIncluded: false,
  authorityOpeningIncluded: false,
  directoryProvisioningIncluded: false,
  storageLifecycleOwned: false,
  callerMustCloseOwningAuthority: true,
  runtimeAndSessionViewsShareState: true,
  runtimeAndSessionViewsSharePoisonState: true,
  sessionReadViewMutationMethods: false,
  sessionAttestationUsesGlobalLock: false,
  sessionAttestationChecksOpenAndPoisonState: true,
  sessionAttestationDrainsOperations: false,
  sessionAttestationValidatesEverySnapshot: false,
  retainedLedgerLimitations: INTEGRATION_RETAINED_EVENT_LEDGER_LIMITATIONS,
});

const ZERO_DIGEST = "0".repeat(64);
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const RETAINED_EVENT_TYPES = new Set(INTEGRATION_EVENT_TYPES);
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_APPEND_PRIMITIVE_BYTES = 16 * 1024 * 1024;
const RETAINED_EVENT_LEDGER_LOCK_FILE = ".aginti-flock-v1-event-ledger";
const RETAINED_EVENT_LEDGER_SCOPE_DOMAIN = "aginti-retained-public-event-ledger-scope-v1";
const RETAINED_EVENT_LEDGER_RECEIPT_DOMAIN = "aginti-retained-public-event-ledger-outbox-receipt-v1";
const RETAINED_EVENT_LEDGER_POINTER_DOMAIN = "aginti-retained-public-event-ledger-pointer-v1";
const RETAINED_EVENT_LEDGER_MAX_JSON_DEPTH = 64;
const RETAINED_EVENT_LEDGER_MAX_JSON_NODES = 100_000;
const RETAINED_EVENT_LEDGER_MAX_PENDING_OPERATIONS = 1024;
const RETAINED_EVENT_LEDGER_EXPECTED_KEYS = Object.freeze([
  "role",
  "canonicalPath",
  "rootIdentityDigest",
  "relativeSegments",
  "directoryIdentityDigest",
  "lockFileIdentityDigest",
  "helperSha256",
  "helperIdentityDigest",
  "maxEvents",
  "maxBytes",
  "lockWaitMs",
]);
const RETAINED_EVENT_LEDGER_SCOPE_KEYS = Object.freeze([
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
]);
const RETAINED_EVENT_LEDGER_APPEND_KEYS = Object.freeze(["type", "payload", "createdAt"]);
const RETAINED_EVENT_LEDGER_OUTBOX_APPEND_KEYS = Object.freeze([
  "outboxId",
  "type",
  "payload",
  "createdAt",
  "expectedPreviousSeq",
  "expectedPreviousHash",
  "expectedEventHash",
]);
const RETAINED_EVENT_LEDGER_LOOKUP_KEYS = Object.freeze(["outboxId"]);
const RETAINED_EVENT_LEDGER_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "mappingVersion",
  "scopeDigest",
  "principalId",
  "browserSessionId",
  "browserSessionPolicy",
  "threadId",
  "runId",
  "maxEvents",
  "maxBytes",
  "events",
  "receipts",
  "integrityDigest",
]);
const RETAINED_EVENT_LEDGER_RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "outboxId",
  "eventSeq",
  "eventHash",
  "eventDigest",
  "requestDigest",
]);
const RETAINED_EVENT_LEDGER_STORE_KEYS = Object.freeze([
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
  INTEGRATION_RETAINED_EVENT_LEDGER_APPEND_ATTESTATION_PROPERTY,
]);
const RETAINED_EVENT_APPEND_ATTESTATION_KEYS = Object.freeze([
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
const RETAINED_EVENT_LEDGER_SESSION_VIEW_KEYS = Object.freeze([
  "owner",
  "ledgerForRun",
  "attest",
]);
const RETAINED_EVENT_LEDGER_SESSION_ATTESTATION_KEYS = Object.freeze([
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
const RETAINED_EVENT_LEDGER_BUNDLE_KEYS = Object.freeze([
  "schemaVersion",
  "runtimeStore",
  "sessionReadView",
  "attestation",
]);
const RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_KEYS = Object.freeze([
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
const retainedEventLedgerStoreBrand = new WeakMap();
const retainedEventLedgerSessionViewBrand = new WeakMap();
const retainedEventLedgerBundleBrand = new WeakMap();
const claimedRetainedEventLedgerLocks = new WeakSet();
const RetainedNativePromise = Promise;
const RetainedPromiseThen = Promise.prototype.then;
const RetainedReflectApply = Reflect.apply;
const RetainedReflectDefineProperty = Reflect.defineProperty;
const RetainedArrayPush = Array.prototype.push;
const RetainedArrayShift = Array.prototype.shift;
const RetainedDate = Date;
const RetainedDateParse = Date.parse;
const RetainedDateToISOString = Date.prototype.toISOString;
const RetainedSafePromiseConstructor = Object.create(null);
Object.defineProperty(RetainedSafePromiseConstructor, Symbol.species, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: RetainedNativePromise,
});
Object.freeze(RetainedSafePromiseConstructor);

function assertPrincipalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
    authorityFail("PUBLIC_EVENT_LEDGER_SCOPE_INVALID", "Public event ledger principal scope is invalid.", { status: 400 });
  }
  return value;
}

function assertBrowserSessionId(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    authorityFail("PUBLIC_EVENT_LEDGER_SCOPE_INVALID", "Public event ledger browser session scope is invalid.", {
      status: 400,
    });
  }
  return value;
}

function normalizeScope(scope = {}) {
  const principalId = assertPrincipalId(scope.principalId);
  const browserSessionId = assertBrowserSessionId(scope.browserSessionId);
  const browserSessionPolicy = String(scope.browserSessionPolicy || "").trim();
  if (browserSessionPolicy !== "same-browser-session") {
    authorityFail("PUBLIC_EVENT_LEDGER_SCOPE_INVALID", "Public event ledger browser session policy is invalid.", {
      status: 400,
    });
  }
  return Object.freeze({
    principalId,
    browserSessionId,
    browserSessionPolicy,
    threadId: validateIntegrationThreadId(scope.threadId),
    runId: validateIntegrationRunId(scope.runId),
  });
}

function scopeKey(scope) {
  return contractDigest({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    threadId: scope.threadId,
    runId: scope.runId,
  });
}

export function integrationEventLedgerPaths(rootDir, scopeInput = {}) {
  const scope = normalizeScope(scopeInput);
  const key = scopeKey(scope);
  const root = path.resolve(String(rootDir || ""));
  return Object.freeze({
    key,
    ledger: path.join(root, "runs", key.slice(0, 2), `${key}.jsonl`),
    lock: path.join(root, "locks", `${key}.lock`),
  });
}

function headerForScope(scope, now) {
  return sealObject(
    {
      schemaVersion: INTEGRATION_EVENT_LEDGER_HEADER_SCHEMA_VERSION,
      owner: "aginti",
      authority: "aginti",
      mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: scope.browserSessionPolicy,
      threadId: scope.threadId,
      runId: scope.runId,
      createdAt: nowIso(now),
    },
    INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN
  );
}

function validateHeader(value, scope) {
  assertSealedObject(value, INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN, "public event ledger header");
  if (
    value.schemaVersion !== INTEGRATION_EVENT_LEDGER_HEADER_SCHEMA_VERSION ||
    value.owner !== "aginti" ||
    value.authority !== "aginti" ||
    value.mappingVersion !== PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION
  ) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger header schema is unsupported.");
  }
  if (
    value.principalId !== scope.principalId ||
    value.threadId !== scope.threadId ||
    value.runId !== scope.runId ||
    value.browserSessionPolicy !== scope.browserSessionPolicy ||
    String(value.browserSessionId || "") !== scope.browserSessionId
  ) {
    authorityFail("NOT_FOUND", "Run events were not found.", { status: 404 });
  }
  parseIsoMs(value.createdAt, "public event ledger header createdAt");
  return value;
}

function parseLedgerLine(line, index, scope) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger contains corrupt JSON.");
  }
  if (index === 0) return { header: validateHeader(value, scope), event: null };
  return { header: null, event: validatePublicIntegrationEvent(value) };
}

function validateEventChain(events, scope) {
  let expectedSeq = 1;
  let previousHash = ZERO_DIGEST;
  let terminalSeen = false;
  for (const event of events) {
    if (event.threadId !== scope.threadId || event.runId !== scope.runId) {
      authorityFail("NOT_FOUND", "Run events were not found.", { status: 404 });
    }
    if (event.seq !== expectedSeq) authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger is not contiguous.");
    if (event.previousHash !== previousHash) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger previous hash is invalid.");
    }
    if (terminalSeen) authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger contains events after terminal.");
    if (TERMINAL_EVENT_TYPES.has(event.type)) terminalSeen = true;
    previousHash = event.hash;
    expectedSeq += 1;
  }
  return Object.freeze({
    lastSeq: events.length ? events[events.length - 1].seq : 0,
    lastHash: events.length ? events[events.length - 1].hash : ZERO_DIGEST,
    terminal: terminalSeen,
  });
}

function assertNoPrivateEventText(event) {
  const text = JSON.stringify(event);
  if (/(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media)(?:\/|\b)|[A-Za-z]:\\|(?:api[_-]?key|token|secret|password)\s*[:=])/iu.test(text)) {
    authorityFail("UNSAFE_PRESENTATION", "Public event contains private runtime content.", { status: 400 });
  }
}

function jsonLineByteLength(value) {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

async function atomicWriteProtectedUtf8File(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureOwnerOnlyDirectory(dir, { label: "public event ledger shard" });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomHex(8)}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath);
    renamed = true;
    await fsyncDirectory(dir);
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function publicLedgerView(ledger) {
  return Object.freeze({
    header: ledger.header,
    events: ledger.events,
    cursor: ledger.cursor,
  });
}

export function createFileIntegrationEventLedgerStore(options = {}) {
  if (!options.rootDir) authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger rootDir is required.");
  const rootDir = path.resolve(String(options.rootDir || ""));
  const maxEvents = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
  const lockWaitMs = Number(options.lockWaitMs || DEFAULT_LOCK_WAIT_MS);
  const staleLockMs = Number(options.staleLockMs || DEFAULT_STALE_LOCK_MS);
  const now = typeof options.now === "function" ? options.now : () => new Date();

  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger event cap is invalid.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > MAX_APPEND_PRIMITIVE_BYTES) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger byte cap is invalid.");
  }

  let layoutPromise = null;
  async function layout() {
    layoutPromise ||= ensureStoreLayout(rootDir, ["runs", "locks"]).then(async (dirs) => {
      const metaPath = path.join(dirs.root, "store.json");
      const existing = await readProtectedJsonFile(metaPath, { optional: true, maxBytes: 4096 });
      if (existing) {
        if (
          existing.schemaVersion !== INTEGRATION_EVENT_LEDGER_STORE_SCHEMA_VERSION ||
          existing.owner !== "aginti" ||
          existing.mappingVersion !== PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION
        ) {
          authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger store metadata is unsupported.");
        }
      } else {
        await atomicWriteProtectedJson(metaPath, {
          schemaVersion: INTEGRATION_EVENT_LEDGER_STORE_SCHEMA_VERSION,
          owner: "aginti",
          mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
          createdAt: nowIso(now),
        });
      }
      return dirs;
    });
    return layoutPromise;
  }

  function pathsForScope(dirs, scope) {
    const key = scopeKey(scope);
    assertSafeSegment(key, "event ledger key");
    return {
      shard: path.join(dirs.runs, key.slice(0, 2)),
      ledger: path.join(dirs.runs, key.slice(0, 2), `${key}.jsonl`),
      lock: path.join(dirs.locks, `${key}.lock`),
      pointer: relativePointer("runs", key.slice(0, 2), `${key}.jsonl`),
    };
  }

  async function readLedgerFile(filePath, scope, { optional = false } = {}) {
    const raw = await readProtectedUtf8File(filePath, { optional, maxBytes });
    if (raw === null) return null;
    const lines = raw.split("\n").filter(Boolean);
    if (!lines.length) authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger is empty.");
    const parsed = lines.map((line, index) => parseLedgerLine(line, index, scope));
    const header = parsed[0].header;
    const events = parsed.slice(1).map((item) => item.event);
    const cursor = validateEventChain(events, scope);
    return Object.freeze({ header, events: Object.freeze(events), cursor, raw });
  }

  async function readExistingLedgerFile(dirs, scope, paths) {
    await ensureOwnerOnlyDirectory(paths.shard, { label: "public event ledger shard" });
    return readLedgerFile(paths.ledger, scope, { optional: true });
  }

  async function appendEventWithOptionalHeader(paths, event, currentRaw) {
    const nextRaw = `${currentRaw}${JSON.stringify(event)}\n`;
    const nextBytes = Buffer.byteLength(nextRaw, "utf8");
    if (nextBytes > maxBytes) authorityFail("PUBLIC_EVENT_LEDGER_FULL", "Public event ledger byte cap is exhausted.");
    await atomicWriteProtectedUtf8File(paths.ledger, nextRaw);
  }

  async function appendExact(scopeInput, eventInput) {
    const scope = normalizeScope(scopeInput);
    const dirs = await layout();
    const paths = pathsForScope(dirs, scope);
    return withDirectoryLock(
      paths.lock,
      async () => {
        const existing = await readExistingLedgerFile(dirs, scope, paths);
        const header = existing ? null : headerForScope(scope, now);
        const ledger =
          existing ||
          Object.freeze({
            header,
            events: Object.freeze([]),
            cursor: Object.freeze({ lastSeq: 0, lastHash: ZERO_DIGEST, terminal: false }),
          });
        if (ledger.events.length >= maxEvents) {
          authorityFail("PUBLIC_EVENT_LEDGER_FULL", "Public event ledger event cap is exhausted.");
        }
        if (ledger.cursor.terminal) {
          authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger already contains a terminal event.");
        }
        const event = validatePublicIntegrationEvent(eventInput);
        assertNoPrivateEventText(event);
        if (event.seq !== ledger.cursor.lastSeq + 1 || event.previousHash !== ledger.cursor.lastHash) {
          authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger append is not monotonic.");
        }
        if (event.threadId !== scope.threadId || event.runId !== scope.runId) {
          authorityFail("NOT_FOUND", "Run events were not found.", { status: 404 });
        }
        const currentRaw = existing ? existing.raw : `${JSON.stringify(header)}\n`;
        await appendEventWithOptionalHeader(paths, event, currentRaw);
        return event;
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function appendPublicEvent(scopeInput, eventInput) {
    const scope = normalizeScope(scopeInput);
    const dirs = await layout();
    const paths = pathsForScope(dirs, scope);
    return withDirectoryLock(
      paths.lock,
      async () => {
        const existing = await readExistingLedgerFile(dirs, scope, paths);
        const header = existing ? null : headerForScope(scope, now);
        const ledger =
          existing ||
          Object.freeze({
            header,
            events: Object.freeze([]),
            cursor: Object.freeze({ lastSeq: 0, lastHash: ZERO_DIGEST, terminal: false }),
          });
        if (ledger.events.length >= maxEvents) {
          authorityFail("PUBLIC_EVENT_LEDGER_FULL", "Public event ledger event cap is exhausted.");
        }
        if (ledger.cursor.terminal) {
          authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger already contains a terminal event.");
        }
        const event = createPublicIntegrationEvent({
          threadId: scope.threadId,
          runId: scope.runId,
          seq: ledger.cursor.lastSeq + 1,
          type: eventInput.type,
          payload: eventInput.payload,
          createdAt: eventInput.createdAt || nowIso(now),
          previousHash: ledger.cursor.lastHash,
        });
        assertNoPrivateEventText(event);
        const currentRaw = existing ? existing.raw : `${JSON.stringify(header)}\n`;
        await appendEventWithOptionalHeader(paths, event, currentRaw);
        return event;
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  async function load(scopeInput) {
    const scope = normalizeScope(scopeInput);
    const dirs = await layout();
    const paths = pathsForScope(dirs, scope);
    return withDirectoryLock(
      paths.lock,
      async () => {
        const ledger = await readLedgerFile(paths.ledger, scope, { optional: true });
        if (!ledger) return Object.freeze({ events: Object.freeze([]), cursor: Object.freeze({ lastSeq: 0, lastHash: ZERO_DIGEST, terminal: false }) });
        return publicLedgerView(ledger);
      },
      { waitMs: lockWaitMs, staleMs: staleLockMs }
    );
  }

  function ledgerForRun(scopeInput = {}) {
    const scope = normalizeScope(scopeInput);
    return Object.freeze({
      owner: "aginti",
      authority: "aginti",
      durable: true,
      persisted: true,
      contiguous: true,
      monotonic: true,
      bridgeOwned: false,
      mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: scope.browserSessionPolicy,
      threadId: scope.threadId,
      runId: scope.runId,
      pointerDigest: sha256Text(scopeKey(scope)),
      async loadEventsAfter(afterSeq) {
        const cursor = integrationBoundedInteger(Number(afterSeq || 0), "afterSeq", { maximum: 10_000_000_000 });
        const ledger = await load(scope);
        return ledger.events.filter((event) => event.seq > cursor).slice(0, MAX_INTEGRATION_EVENT_BATCH);
      },
      async loadCursor(seq) {
        const cursor = integrationBoundedInteger(Number(seq || 0), "cursor seq", { maximum: 10_000_000_000 });
        if (cursor === 0) return Object.freeze({ seq: 0, hash: ZERO_DIGEST });
        const ledger = await load(scope);
        const event = ledger.events.find((item) => item.seq === cursor);
        return event ? Object.freeze({ seq: event.seq, hash: event.hash }) : null;
      },
      async loadHead() {
        const ledger = await load(scope);
        return Object.freeze({ seq: ledger.cursor.lastSeq, hash: ledger.cursor.lastHash });
      },
    });
  }

  return Object.freeze({
    owner: "aginti",
    authority: "aginti",
    durable: true,
    persisted: true,
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    maxEvents,
    maxBytes,
    async attest() {
      await layout();
      const attestation = {
        schemaVersion: INTEGRATION_EVENT_LEDGER_ATTESTATION_VERSION,
        owner: "aginti",
        authority: "aginti",
        durable: true,
        persisted: true,
        contiguous: true,
        monotonic: true,
        bridgeOwned: false,
        mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
        maxEvents,
        maxBytes,
      };
      return Object.freeze({ ...attestation, digest: contractDigest(attestation) });
    },
    appendPublicEvent,
    appendExactPublicEvent: appendExact,
    ledgerForRun,
    load,
    pathsForRun: (scope) => integrationEventLedgerPaths(rootDir, scope),
  });
}

function retainedLedgerFail(code, message, { status = 503, details = {} } = {}) {
  authorityFail(code, message, { status, details });
}

function retainedExactDataObject(value, allowedKeys, requiredKeys, label) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} must not be a Proxy.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} prototype is invalid.`);
  }
  const allowed = new Set(allowedKeys);
  const ownKeys = Reflect.ownKeys(value);
  const clone = {};
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} contains an unsupported field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label}.${String(key)} must be an enumerable data field.`);
    }
    clone[key] = descriptor.value;
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(clone, key)) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label}.${key} is required.`);
    }
  }
  return Object.freeze(clone);
}

function retainedCloneJson(value, label, state = { nodes: 0, active: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > RETAINED_EVENT_LEDGER_MAX_JSON_NODES || depth > RETAINED_EVENT_LEDGER_MAX_JSON_DEPTH) {
    retainedLedgerFail(
      state.overflowCode === "PUBLIC_EVENT_LEDGER_FULL" ? "PUBLIC_EVENT_LEDGER_FULL" : "PUBLIC_EVENT_LEDGER_UNAVAILABLE",
      `${label} exceeds structural bounds.`,
      { status: state.overflowCode === "PUBLIC_EVENT_LEDGER_FULL" ? 409 : 503 }
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} contains a non-finite number.`);
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} must contain only trap-safe JSON data.`);
  }
  if (state.active.has(value)) retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} must not contain cycles.`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length)) {
        retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} array shape is invalid.`);
      }
      const keys = Reflect.ownKeys(value);
      const indexKeys = keys.filter((key) => key !== "length");
      if (
        indexKeys.length !== value.length ||
        indexKeys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))
      ) {
        retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} array must be dense data.`);
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label}[${index}] must be an enumerable data field.`);
        }
        clone[index] = retainedCloneJson(descriptor.value, `${label}[${index}]`, state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} object prototype is invalid.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} must not contain symbols.`);
    }
    const clone = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} fields must be enumerable data.`);
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: retainedCloneJson(descriptor.value, `${label} field`, state, depth + 1),
      });
    }
    return Object.freeze(clone);
  } finally {
    state.active.delete(value);
  }
}

function retainedCanonicalJson(value, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || active.has(value)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger snapshot is not canonical JSON data.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => retainedCanonicalJson(item, active)).join(",")}]`;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger snapshot contains unsupported fields.");
    }
    return `{${keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${retainedCanonicalJson(value[key], active)}`)
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function retainedDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `${label} is invalid.`);
  }
  return value;
}

function normalizeRetainedEventLedgerExpected(input) {
  const raw = retainedExactDataObject(
    input,
    RETAINED_EVENT_LEDGER_EXPECTED_KEYS,
    RETAINED_EVENT_LEDGER_EXPECTED_KEYS,
    "retained event ledger expected binding"
  );
  const relativeSegments = retainedCloneJson(raw.relativeSegments, "retained event ledger relativeSegments");
  if (!Array.isArray(relativeSegments)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "retained event ledger relativeSegments must be an array.");
  }
  for (const field of ["role", "canonicalPath"]) {
    if (typeof raw[field] !== "string") {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", `retained event ledger ${field} must be a string.`);
    }
  }
  for (const field of [
    "rootIdentityDigest",
    "directoryIdentityDigest",
    "lockFileIdentityDigest",
    "helperSha256",
    "helperIdentityDigest",
  ]) {
    retainedDigest(raw[field], `retained event ledger ${field}`);
  }
  if (!Number.isSafeInteger(raw.maxEvents) || raw.maxEvents < 1 || raw.maxEvents > 1_000_000) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger event cap is invalid.");
  }
  if (!Number.isSafeInteger(raw.maxBytes) || raw.maxBytes < 4096 || raw.maxBytes > MAX_APPEND_PRIMITIVE_BYTES) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger byte cap is invalid.");
  }
  if (!Number.isSafeInteger(raw.lockWaitMs) || raw.lockWaitMs < 0 || raw.lockWaitMs > 60_000) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger lock wait is invalid.");
  }
  return Object.freeze({
    role: raw.role,
    canonicalPath: raw.canonicalPath,
    rootIdentityDigest: raw.rootIdentityDigest,
    relativeSegments,
    directoryIdentityDigest: raw.directoryIdentityDigest,
    lockFileIdentityDigest: raw.lockFileIdentityDigest,
    helperSha256: raw.helperSha256,
    helperIdentityDigest: raw.helperIdentityDigest,
    maxEvents: raw.maxEvents,
    maxBytes: raw.maxBytes,
    lockWaitMs: raw.lockWaitMs,
  });
}

function retainedDirectoryExpected(expected) {
  return Object.freeze({
    role: expected.role,
    canonicalPath: expected.canonicalPath,
    rootIdentityDigest: expected.rootIdentityDigest,
    relativeSegments: expected.relativeSegments,
    directoryIdentityDigest: expected.directoryIdentityDigest,
  });
}

function retainedLockExpected(expected) {
  return Object.freeze({
    ...retainedDirectoryExpected(expected),
    lockFileName: RETAINED_EVENT_LEDGER_LOCK_FILE,
    helperSha256: expected.helperSha256,
    lockFileIdentityDigest: expected.lockFileIdentityDigest,
    helperIdentityDigest: expected.helperIdentityDigest,
  });
}

function normalizeRetainedLedgerScope(input) {
  const raw = retainedExactDataObject(
    input,
    RETAINED_EVENT_LEDGER_SCOPE_KEYS,
    RETAINED_EVENT_LEDGER_SCOPE_KEYS,
    "retained event ledger scope"
  );
  for (const key of RETAINED_EVENT_LEDGER_SCOPE_KEYS) {
    if (typeof raw[key] !== "string") {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_SCOPE_INVALID", `Retained event ledger scope ${key} must be a string.`, {
        status: 400,
      });
    }
  }
  return normalizeScope(Object.freeze({
    principalId: raw.principalId,
    browserSessionId: raw.browserSessionId,
    browserSessionPolicy: raw.browserSessionPolicy,
    threadId: raw.threadId,
    runId: raw.runId,
  }));
}

function retainedScopeDigest(scope) {
  return contractDigest({
    domain: RETAINED_EVENT_LEDGER_SCOPE_DOMAIN,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    threadId: scope.threadId,
    runId: scope.runId,
  });
}

function retainedSnapshotFileName(scope) {
  return `${retainedScopeDigest(scope)}.json`;
}

function sameRetainedLedgerScope(left, right) {
  return RETAINED_EVENT_LEDGER_SCOPE_KEYS.every((key) => left[key] === right[key]);
}

function normalizeRetainedAppendInput(input) {
  const raw = retainedExactDataObject(
    input,
    RETAINED_EVENT_LEDGER_APPEND_KEYS,
    ["type", "payload"],
    "retained event ledger append"
  );
  if (typeof raw.type !== "string") {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger append type must be a string.", {
      status: 400,
    });
  }
  const hasCreatedAt = Object.prototype.hasOwnProperty.call(raw, "createdAt");
  const createdAt = hasCreatedAt
    ? normalizeRetainedCreatedAt(raw.createdAt, "retained event ledger append createdAt")
    : undefined;
  const payload = normalizeRetainedEventPayload(raw.type, raw.payload, "retained event ledger append payload");
  return Object.freeze({
    type: raw.type,
    payload,
    ...(hasCreatedAt ? { createdAt } : {}),
  });
}

function retainedOutboxId(value) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value) ||
    value.includes("..")
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger outbox id is invalid.", { status: 400 });
  }
  return value;
}

function normalizeRetainedEventPayload(type, value, label) {
  if (!RETAINED_EVENT_TYPES.has(type)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger event type is unsupported.", {
      status: 400,
    });
  }
  const cloned = retainedCloneJson(value, label);
  let validated;
  try {
    validated = validateIntegrationEventPayload(type, cloned);
  } catch (error) {
    const code = new Set(["INVALID_REQUEST", "UNSUPPORTED_FIELD", "UNSAFE_PRESENTATION"]).has(error?.publicCode)
      ? error.publicCode
      : "PUBLIC_EVENT_LEDGER_UNAVAILABLE";
    retainedLedgerFail(code, "Retained event ledger event payload is invalid.", { status: 400 });
  }
  if (contractDigest(cloned) !== contractDigest(validated)) {
    retainedLedgerFail("INVALID_REQUEST", "Retained event ledger event payload must already be canonical.", {
      status: 400,
    });
  }
  return retainedCloneJson(validated, label);
}

function normalizeRetainedCreatedAt(value, label) {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    retainedLedgerFail("INVALID_REQUEST", "Retained event ledger createdAt is invalid.", { status: 400 });
  }
  const milliseconds = RetainedReflectApply(RetainedDateParse, RetainedDate, [value]);
  let canonical = "";
  if (Number.isFinite(milliseconds)) {
    canonical = RetainedReflectApply(RetainedDateToISOString, new RetainedDate(milliseconds), []);
  }
  if (canonical !== value) {
    retainedLedgerFail("INVALID_REQUEST", `${label} must be a canonical UTC timestamp.`, { status: 400 });
  }
  return value;
}

function retainedNowIso() {
  return RetainedReflectApply(RetainedDateToISOString, new RetainedDate(), []);
}

function normalizeRetainedOutboxAppendInput(input) {
  const raw = retainedExactDataObject(
    input,
    RETAINED_EVENT_LEDGER_OUTBOX_APPEND_KEYS,
    RETAINED_EVENT_LEDGER_OUTBOX_APPEND_KEYS,
    "retained event ledger outbox append"
  );
  if (typeof raw.type !== "string") {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger outbox event fields are invalid.", {
      status: 400,
    });
  }
  const createdAt = normalizeRetainedCreatedAt(raw.createdAt, "retained event ledger outbox createdAt");
  const payload = normalizeRetainedEventPayload(raw.type, raw.payload, "retained event ledger outbox payload");
  const expectedPreviousSeq = integrationBoundedInteger(
    raw.expectedPreviousSeq,
    "retained event ledger expectedPreviousSeq",
    { maximum: 10_000_000_000 }
  );
  return Object.freeze({
    outboxId: retainedOutboxId(raw.outboxId),
    type: raw.type,
    payload,
    createdAt,
    expectedPreviousSeq,
    expectedPreviousHash: retainedDigest(raw.expectedPreviousHash, "retained event ledger expectedPreviousHash"),
    expectedEventHash: retainedDigest(raw.expectedEventHash, "retained event ledger expectedEventHash"),
  });
}

function normalizeRetainedLookupInput(input) {
  const raw = retainedExactDataObject(
    input,
    RETAINED_EVENT_LEDGER_LOOKUP_KEYS,
    RETAINED_EVENT_LEDGER_LOOKUP_KEYS,
    "retained event ledger outbox lookup"
  );
  return Object.freeze({ outboxId: retainedOutboxId(raw.outboxId) });
}

function normalizeRetainedCursorInput(value, label) {
  const candidate = value === undefined ? 0 : value;
  if (typeof candidate !== "number") {
    retainedLedgerFail("INVALID_REQUEST", `${label} must be a safe integer.`, { status: 400 });
  }
  return integrationBoundedInteger(candidate, label, { maximum: 10_000_000_000 });
}

function poisonRetainedEventLedgerStore(state, reason) {
  state.poisoned = true;
  state.poisonReason = reason;
}

function assertRetainedEventLedgerStoreOpen(state) {
  if (state.poisoned) {
    retainedLedgerFail(
      "PUBLIC_EVENT_LEDGER_POISONED",
      state.poisonReason || "Retained event ledger store is poisoned."
    );
  }
  if (state.filePrimitives.isClosed() || state.lock.isClosed()) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger storage binding is closed.");
  }
}

function retainedSnapshotCorrupt(state, message = "Retained event ledger snapshot is corrupt.") {
  poisonRetainedEventLedgerStore(state, "Retained event ledger snapshot validation failed.");
  retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", message);
}

function retainedOutboxRequestDigest(scope, input) {
  return contractDigest({
    domain: RETAINED_EVENT_LEDGER_RECEIPT_DOMAIN,
    scopeDigest: retainedScopeDigest(scope),
    outboxId: input.outboxId,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt,
    expectedPreviousSeq: input.expectedPreviousSeq,
    expectedPreviousHash: input.expectedPreviousHash,
    expectedEventHash: input.expectedEventHash,
  });
}

function makeRetainedEventReceipt(scope, input, event) {
  return Object.freeze({
    schemaVersion: INTEGRATION_RETAINED_EVENT_LEDGER_RECEIPT_VERSION,
    outboxId: input.outboxId,
    eventSeq: event.seq,
    eventHash: event.hash,
    eventDigest: contractDigest(event),
    requestDigest: retainedOutboxRequestDigest(scope, input),
  });
}

function makeRetainedEventSnapshot(state, scope, events, receipts) {
  return sealObject(
    {
      schemaVersion: INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_VERSION,
      owner: "aginti",
      authority: "aginti",
      mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
      scopeDigest: retainedScopeDigest(scope),
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: scope.browserSessionPolicy,
      threadId: scope.threadId,
      runId: scope.runId,
      maxEvents: state.expected.maxEvents,
      maxBytes: state.expected.maxBytes,
      events: Object.freeze([...events]),
      receipts: Object.freeze([...receipts]),
    },
    INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_INTEGRITY_DOMAIN
  );
}

function emptyRetainedEventLedger(scope) {
  return Object.freeze({
    exists: false,
    scope,
    events: Object.freeze([]),
    receipts: Object.freeze([]),
    cursor: Object.freeze({ lastSeq: 0, lastHash: ZERO_DIGEST, terminal: false }),
    snapshot: null,
    rawDigest: "",
    bytes: 0,
  });
}

function validateRetainedEventSnapshot(state, scope, raw) {
  try {
    let parsedInput;
    try {
      parsedInput = JSON.parse(raw);
    } catch {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot contains invalid JSON.");
    }
    const parsed = retainedCloneJson(parsedInput, "retained event ledger snapshot");
    if (`${retainedCanonicalJson(parsed)}\n` !== raw) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot is not canonical JSON.");
    }
    assertSealedObject(
      parsed,
      INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_INTEGRITY_DOMAIN,
      "retained event ledger snapshot"
    );
    const snapshot = retainedExactDataObject(
      parsed,
      RETAINED_EVENT_LEDGER_SNAPSHOT_KEYS,
      RETAINED_EVENT_LEDGER_SNAPSHOT_KEYS,
      "retained event ledger snapshot"
    );
    if (
      snapshot.schemaVersion !== INTEGRATION_RETAINED_EVENT_LEDGER_SNAPSHOT_VERSION ||
      snapshot.owner !== "aginti" ||
      snapshot.authority !== "aginti" ||
      snapshot.mappingVersion !== PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION ||
      snapshot.maxEvents !== state.expected.maxEvents ||
      snapshot.maxBytes !== state.expected.maxBytes
    ) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot binding is invalid.");
    }
    const storedScope = normalizeRetainedLedgerScope(Object.freeze({
      principalId: snapshot.principalId,
      browserSessionId: snapshot.browserSessionId,
      browserSessionPolicy: snapshot.browserSessionPolicy,
      threadId: snapshot.threadId,
      runId: snapshot.runId,
    }));
    const scopeDigest = retainedScopeDigest(scope);
    if (
      !sameRetainedLedgerScope(storedScope, scope) ||
      snapshot.scopeDigest !== scopeDigest ||
      retainedSnapshotFileName(storedScope) !== `${scopeDigest}.json`
    ) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot scope binding is invalid.");
    }
    if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.receipts)) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot collections are invalid.");
    }
    if (snapshot.events.length > state.expected.maxEvents) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot exceeds its event cap.");
    }
    const events = [];
    try {
      for (const eventInput of snapshot.events) {
        const event = validatePublicIntegrationEvent(eventInput);
        assertNoPrivateEventText(event);
        events.push(event);
      }
    } catch {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot contains an invalid public event.");
    }
    const cursor = validateEventChain(events, scope);
    const receipts = [];
    const outboxIds = new Set();
    const receiptEventSeqs = new Set();
    for (const receiptInput of snapshot.receipts) {
      const receipt = retainedExactDataObject(
        receiptInput,
        RETAINED_EVENT_LEDGER_RECEIPT_KEYS,
        RETAINED_EVENT_LEDGER_RECEIPT_KEYS,
        "retained event ledger receipt"
      );
      if (
        receipt.schemaVersion !== INTEGRATION_RETAINED_EVENT_LEDGER_RECEIPT_VERSION ||
        !Number.isSafeInteger(receipt.eventSeq) ||
        receipt.eventSeq < 1 ||
        receipt.eventSeq > events.length ||
        outboxIds.has(receipt.outboxId) ||
        receiptEventSeqs.has(receipt.eventSeq)
      ) {
        retainedSnapshotCorrupt(state, "Retained event ledger receipt mapping is invalid.");
      }
      retainedOutboxId(receipt.outboxId);
      retainedDigest(receipt.eventHash, "retained event ledger receipt eventHash");
      retainedDigest(receipt.eventDigest, "retained event ledger receipt eventDigest");
      retainedDigest(receipt.requestDigest, "retained event ledger receipt requestDigest");
      const event = events[receipt.eventSeq - 1];
      const reconstructedRequestDigest = retainedOutboxRequestDigest(scope, Object.freeze({
        outboxId: receipt.outboxId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
        expectedPreviousSeq: event.seq - 1,
        expectedPreviousHash: event.previousHash,
        expectedEventHash: event.hash,
      }));
      if (
        receipt.eventHash !== event.hash ||
        receipt.eventDigest !== contractDigest(event) ||
        receipt.requestDigest !== reconstructedRequestDigest
      ) {
        retainedSnapshotCorrupt(state, "Retained event ledger receipt does not match its public event.");
      }
      outboxIds.add(receipt.outboxId);
      receiptEventSeqs.add(receipt.eventSeq);
      receipts.push(Object.freeze({ ...receipt }));
    }
    return Object.freeze({
      exists: true,
      scope,
      events: Object.freeze(events),
      receipts: Object.freeze(receipts),
      cursor,
      snapshot: parsed,
      rawDigest: sha256Text(raw),
      bytes: Buffer.byteLength(raw, "utf8"),
    });
  } catch (error) {
    if (error?.publicCode === "PUBLIC_EVENT_LEDGER_CORRUPT") {
      if (!state.poisoned) {
        poisonRetainedEventLedgerStore(state, "Retained event ledger snapshot validation failed.");
      }
      throw error;
    }
    retainedSnapshotCorrupt(state);
  }
}

async function readRetainedEventSnapshot(state, scope) {
  const scopeDigest = retainedScopeDigest(scope);
  const fileName = `${scopeDigest}.json`;
  const raw = await state.filePrimitives.readProtectedUtf8File(fileName, {
    optional: true,
    maxBytes: state.expected.maxBytes,
  });
  if (raw === null) {
    if (state.observedScopeDigests.has(scopeDigest)) {
      retainedSnapshotCorrupt(state, "Retained event ledger snapshot disappeared.");
    }
    return emptyRetainedEventLedger(scope);
  }
  const ledger = validateRetainedEventSnapshot(state, scope, raw);
  state.observedScopeDigests.add(scopeDigest);
  return ledger;
}

function retainedSnapshotCandidate(state, scope, events, receipts) {
  const snapshot = makeRetainedEventSnapshot(state, scope, events, receipts);
  retainedCloneJson(
    snapshot,
    "retained event ledger candidate",
    { nodes: 0, active: new WeakSet(), overflowCode: "PUBLIC_EVENT_LEDGER_FULL" }
  );
  const text = `${retainedCanonicalJson(snapshot)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > state.expected.maxBytes) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_FULL", "Retained event ledger byte cap is exhausted.", { status: 409 });
  }
  return Object.freeze({
    snapshot,
    text,
    bytes,
    digest: sha256Text(text),
    scopeDigest: retainedScopeDigest(scope),
  });
}

async function writeAndRecheckRetainedEventSnapshot(state, scope, candidate, facts) {
  facts.candidate = Object.freeze({
    scopeDigest: candidate.scopeDigest,
    bytes: candidate.bytes,
    digest: candidate.digest,
  });
  const receipt = await state.filePrimitives.atomicWriteProtectedJson(
    `${candidate.scopeDigest}.json`,
    candidate.snapshot,
    { maxBytes: state.expected.maxBytes }
  );
  facts.writeConfirmed = true;
  if (
    receipt?.committed !== true ||
    receipt?.directorySynced !== true ||
    receipt?.bytes !== candidate.bytes ||
    receipt?.digest !== candidate.digest
  ) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger atomic write receipt did not match its candidate.");
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger write receipt is invalid.");
  }
  const reloaded = await readRetainedEventSnapshot(state, scope);
  if (
    !reloaded.exists ||
    reloaded.rawDigest !== candidate.digest ||
    reloaded.bytes !== candidate.bytes ||
    reloaded.snapshot?.integrityDigest !== candidate.snapshot.integrityDigest ||
    contractDigest(reloaded.snapshot) !== contractDigest(candidate.snapshot)
  ) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger post-write verification failed.");
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger post-write verification failed.");
  }
  facts.postWriteVerified = true;
  return reloaded;
}

function enqueueRetainedEventLedgerOperation(state, operation) {
  if (state.pendingOperations >= RETAINED_EVENT_LEDGER_MAX_PENDING_OPERATIONS) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_BUSY", "Retained event ledger operation queue is full.", { status: 429 });
  }
  state.pendingOperations += 1;
  let resolveCaller;
  let rejectCaller;
  const caller = new RetainedNativePromise((resolve, reject) => {
    resolveCaller = resolve;
    rejectCaller = reject;
  });
  if (!RetainedReflectDefineProperty(caller, "constructor", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: RetainedSafePromiseConstructor,
  })) {
    state.pendingOperations -= 1;
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger operation promise could not be hardened.");
  }
  void RetainedReflectApply(RetainedPromiseThen, caller, [undefined, () => undefined]);
  RetainedReflectApply(RetainedArrayPush, state.operationQueue, [
    Object.freeze({ operation, resolve: resolveCaller, reject: rejectCaller }),
  ]);
  if (!state.queueDraining) {
    state.queueDraining = true;
    void drainRetainedEventLedgerOperations(state);
  }
  return caller;
}

async function drainRetainedEventLedgerOperations(state) {
  while (state.operationQueue.length > 0) {
    const job = RetainedReflectApply(RetainedArrayShift, state.operationQueue, []);
    try {
      job.resolve(await job.operation());
    } catch (error) {
      job.reject(error);
    } finally {
      state.pendingOperations -= 1;
    }
  }
  state.queueDraining = false;
}

function safeRetainedOperationFacts(error, phase, facts) {
  const details = error?.details;
  return Object.freeze({
    phase,
    writeConfirmed: facts.writeConfirmed === true,
    postWriteVerified: facts.postWriteVerified === true,
    outboxRetryIdempotent: facts.outboxRetryIdempotent === true,
    operationStarted: facts.workStarted === true,
    operationSettled: facts.workSettled === true,
    operationFailed: facts.workFailed === true,
    ...(typeof details?.renamed === "boolean" ? { renamed: details.renamed } : {}),
    ...(typeof details?.directorySynced === "boolean" ? { directorySynced: details.directorySynced } : {}),
    ...(typeof details?.postRenameSyncFailed === "boolean"
      ? { postRenameSyncFailed: details.postRenameSyncFailed }
      : {}),
    ...(facts.candidate ? { candidate: facts.candidate } : {}),
    ...(facts.candidateEvent ? { candidateEvent: facts.candidateEvent } : {}),
  });
}

function throwNormalizedRetainedEventLedgerError(state, error, phase, facts) {
  const code = typeof error?.publicCode === "string" ? error.publicCode : "";
  const safeFacts = safeRetainedOperationFacts(error, phase, facts);
  if (facts.writeConfirmed) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger committed operation requires reconciliation.");
    retainedLedgerFail(
      "PUBLIC_EVENT_LEDGER_COMMIT_AMBIGUOUS",
      "Retained event ledger operation failed after its durable write boundary.",
      { details: safeFacts }
    );
  }
  if (
    code === "PUBLIC_EVENT_LEDGER_CORRUPT" ||
    code === "PUBLIC_EVENT_LEDGER_POISONED" ||
    code === "PUBLIC_EVENT_LEDGER_FULL" ||
    code === "PUBLIC_EVENT_LEDGER_CONFLICT" ||
    code === "PUBLIC_EVENT_LEDGER_OUTBOX_CONFLICT" ||
    code === "PUBLIC_EVENT_LEDGER_SCOPE_INVALID" ||
    code === "NOT_FOUND" ||
    code === "UNSAFE_PRESENTATION" ||
    code === "INVALID_REQUEST" ||
    code === "UNSUPPORTED_FIELD" ||
    code === "LEDGER_HASH_MISMATCH"
  ) {
    throw error;
  }
  if (
    code === "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS" ||
    code === "INTEGRATION_STORAGE_LOCK_RELEASE_AMBIGUOUS"
  ) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger operation outcome requires fresh-process reconciliation.");
    retainedLedgerFail(
      "PUBLIC_EVENT_LEDGER_COMMIT_AMBIGUOUS",
      "Retained event ledger commit or lock release outcome is ambiguous.",
      { details: safeFacts }
    );
  }
  if (code === "INTEGRATION_STORAGE_LOCK_BUSY") {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_BUSY", "Retained event ledger is busy.", { status: 409, details: safeFacts });
  }
  if (
    code === "INTEGRATION_STORAGE_FILE_CORRUPT" ||
    code === "INTEGRATION_STORAGE_LOCK_CORRUPT" ||
    code === "INTEGRATION_STORAGE_CORRUPT"
  ) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger storage binding is corrupt.");
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger storage binding is corrupt.", {
      details: safeFacts,
    });
  }
  if (
    code === "INTEGRATION_STORAGE_LOCK_POISONED" ||
    code === "INTEGRATION_STORAGE_POISONED" ||
    code === "INTEGRATION_STORAGE_CLEANUP_FAILED" ||
    code === "INTEGRATION_STORAGE_LOCK_CLEANUP_FAILED"
  ) {
    poisonRetainedEventLedgerStore(state, "Retained event ledger storage binding is unavailable.");
  }
  retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger operation failed safely.", {
    details: safeFacts,
  });
}

function runRetainedEventLedgerOperation(state, phase, work, factsInput = {}) {
  assertRetainedEventLedgerStoreOpen(state);
  const facts = {
    candidate: null,
    candidateEvent: null,
    writeConfirmed: false,
    postWriteVerified: false,
    outboxRetryIdempotent: factsInput.outboxRetryIdempotent === true,
    workStarted: false,
    workSettled: false,
    workFailed: false,
  };
  return enqueueRetainedEventLedgerOperation(state, async () => {
    assertRetainedEventLedgerStoreOpen(state);
    try {
      return await state.lock.runExclusive(async () => {
        assertRetainedEventLedgerStoreOpen(state);
        facts.workStarted = true;
        try {
          const result = await work(facts);
          facts.workSettled = true;
          return result;
        } catch (error) {
          facts.workSettled = true;
          facts.workFailed = true;
          throw error;
        }
      }, { waitMs: state.expected.lockWaitMs });
    } catch (error) {
      throwNormalizedRetainedEventLedgerError(state, error, phase, facts);
    }
  });
}

function assertRetainedEventCapacity(state, ledger) {
  if (ledger.events.length >= state.expected.maxEvents) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_FULL", "Retained event ledger event cap is exhausted.", { status: 409 });
  }
  if (ledger.cursor.terminal) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_CONFLICT", "Retained event ledger already contains a terminal event.", {
      status: 409,
    });
  }
}

function exactRetainedOutboxReplay(scope, input, receipt, event) {
  const exact =
    receipt.requestDigest === retainedOutboxRequestDigest(scope, input) &&
    event.seq === input.expectedPreviousSeq + 1 &&
    event.previousHash === input.expectedPreviousHash &&
    event.hash === input.expectedEventHash &&
    event.type === input.type &&
    event.createdAt === input.createdAt &&
    contractDigest(event.payload) === contractDigest(input.payload);
  if (!exact) {
    retainedLedgerFail(
      "PUBLIC_EVENT_LEDGER_OUTBOX_CONFLICT",
      "Retained event ledger outbox id is already bound to a different event.",
      { status: 409 }
    );
  }
  return event;
}

function appendRetainedPublicEvent(state, scope, input) {
  return runRetainedEventLedgerOperation(state, "append-public-event", async (facts) => {
    const ledger = await readRetainedEventSnapshot(state, scope);
    assertRetainedEventCapacity(state, ledger);
    const event = createPublicIntegrationEvent({
      threadId: scope.threadId,
      runId: scope.runId,
      seq: ledger.cursor.lastSeq + 1,
      type: input.type,
      payload: input.payload,
      createdAt: Object.prototype.hasOwnProperty.call(input, "createdAt") ? input.createdAt : retainedNowIso(),
      previousHash: ledger.cursor.lastHash,
    });
    assertNoPrivateEventText(event);
    facts.candidateEvent = Object.freeze({ seq: event.seq, hash: event.hash });
    const candidate = retainedSnapshotCandidate(
      state,
      scope,
      Object.freeze([...ledger.events, event]),
      ledger.receipts
    );
    const reloaded = await writeAndRecheckRetainedEventSnapshot(state, scope, candidate, facts);
    const committed = reloaded.events[event.seq - 1];
    if (!committed || contractDigest(committed) !== contractDigest(event)) {
      poisonRetainedEventLedgerStore(state, "Retained event ledger committed event verification failed.");
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger committed event verification failed.");
    }
    return committed;
  });
}

function appendRetainedEventByOutboxId(state, scope, input) {
  return runRetainedEventLedgerOperation(
    state,
    "append-by-outbox-id",
    async (facts) => {
      const ledger = await readRetainedEventSnapshot(state, scope);
      const existingReceipt = ledger.receipts.find((receipt) => receipt.outboxId === input.outboxId);
      if (existingReceipt) {
        const existingEvent = ledger.events[existingReceipt.eventSeq - 1];
        return exactRetainedOutboxReplay(scope, input, existingReceipt, existingEvent);
      }
      assertRetainedEventCapacity(state, ledger);
      if (
        ledger.cursor.lastSeq !== input.expectedPreviousSeq ||
        ledger.cursor.lastHash !== input.expectedPreviousHash
      ) {
        retainedLedgerFail(
          "PUBLIC_EVENT_LEDGER_CONFLICT",
          "Retained event ledger outbox cursor no longer matches its expected predecessor.",
          { status: 409 }
        );
      }
      const event = createPublicIntegrationEvent({
        threadId: scope.threadId,
        runId: scope.runId,
        seq: input.expectedPreviousSeq + 1,
        type: input.type,
        payload: input.payload,
        createdAt: input.createdAt,
        previousHash: input.expectedPreviousHash,
      });
      assertNoPrivateEventText(event);
      if (event.hash !== input.expectedEventHash) {
        retainedLedgerFail(
          "PUBLIC_EVENT_LEDGER_CONFLICT",
          "Retained event ledger outbox event hash does not match its expected hash.",
          { status: 409 }
        );
      }
      const receipt = makeRetainedEventReceipt(scope, input, event);
      facts.candidateEvent = Object.freeze({ seq: event.seq, hash: event.hash });
      const candidate = retainedSnapshotCandidate(
        state,
        scope,
        Object.freeze([...ledger.events, event]),
        Object.freeze([...ledger.receipts, receipt])
      );
      const reloaded = await writeAndRecheckRetainedEventSnapshot(state, scope, candidate, facts);
      const committedReceipt = reloaded.receipts.find((item) => item.outboxId === input.outboxId);
      const committedEvent = committedReceipt ? reloaded.events[committedReceipt.eventSeq - 1] : null;
      if (!committedReceipt || !committedEvent) {
        poisonRetainedEventLedgerStore(state, "Retained event ledger committed outbox receipt verification failed.");
        retainedLedgerFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Retained event ledger outbox receipt verification failed.");
      }
      return exactRetainedOutboxReplay(scope, input, committedReceipt, committedEvent);
    },
    { outboxRetryIdempotent: true }
  );
}

function lookupRetainedEventByOutboxId(state, scope, input) {
  return runRetainedEventLedgerOperation(state, "lookup-by-outbox-id", async () => {
    const ledger = await readRetainedEventSnapshot(state, scope);
    const receipt = ledger.receipts.find((item) => item.outboxId === input.outboxId);
    return receipt ? ledger.events[receipt.eventSeq - 1] : null;
  }, { outboxRetryIdempotent: true });
}

function loadRetainedEventLedger(state, scope, phase, project = (ledger) => ledger) {
  return runRetainedEventLedgerOperation(state, phase, async () => project(await readRetainedEventSnapshot(state, scope)));
}

function retainedLedgerForRun(state, scope) {
  const scopeDigest = retainedScopeDigest(scope);
  return Object.freeze({
    owner: "aginti",
    authority: "aginti",
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    threadId: scope.threadId,
    runId: scope.runId,
    pointerDigest: contractDigest({
      domain: RETAINED_EVENT_LEDGER_POINTER_DOMAIN,
      mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
      scopeDigest,
    }),
    loadEventsAfter(afterSeqInput) {
      const afterSeq = normalizeRetainedCursorInput(afterSeqInput, "afterSeq");
      return loadRetainedEventLedger(state, scope, "load-events-after", (ledger) =>
        Object.freeze(ledger.events.filter((event) => event.seq > afterSeq).slice(0, MAX_INTEGRATION_EVENT_BATCH))
      );
    },
    loadCursor(seqInput) {
      const seq = normalizeRetainedCursorInput(seqInput, "cursor seq");
      return loadRetainedEventLedger(state, scope, "load-cursor", (ledger) => {
        if (seq === 0) return Object.freeze({ seq: 0, hash: ZERO_DIGEST });
        const event = ledger.events.find((item) => item.seq === seq);
        return event ? Object.freeze({ seq: event.seq, hash: event.hash }) : null;
      });
    },
    loadHead() {
      return loadRetainedEventLedger(state, scope, "load-head", (ledger) =>
        Object.freeze({ seq: ledger.cursor.lastSeq, hash: ledger.cursor.lastHash })
      );
    },
  });
}

function buildRetainedEventAppendAttestation() {
  const unsigned = {
    schemaVersion: INTEGRATION_RETAINED_EVENT_LEDGER_APPEND_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    appendPublicEvent: true,
    appendByOutboxId: true,
    lookupByOutboxId: true,
    terminalFinality: true,
    durable: true,
    persisted: true,
    monotonic: true,
  };
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function validateRetainedEventLedgerStoreSurface(surface, proof) {
  if (!Object.isFrozen(surface) || utilTypes.isProxy(surface) || Object.getPrototypeOf(surface) !== Object.prototype) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger store surface is invalid.");
  }
  const keys = Reflect.ownKeys(surface);
  if (keys.length !== RETAINED_EVENT_LEDGER_STORE_KEYS.length || keys.some((key) => !RETAINED_EVENT_LEDGER_STORE_KEYS.includes(key))) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger store fields are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    if (!descriptor || !descriptor.enumerable || descriptor.writable || descriptor.configurable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger store fields are not immutable data.");
    }
  }
  const proofKeys = Reflect.ownKeys(proof);
  if (
    !Object.isFrozen(proof) ||
    utilTypes.isProxy(proof) ||
    proofKeys.length !== RETAINED_EVENT_APPEND_ATTESTATION_KEYS.length ||
    proofKeys.some((key) => !RETAINED_EVENT_APPEND_ATTESTATION_KEYS.includes(key))
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger append proof is invalid.");
  }
  const { digest, ...unsigned } = proof;
  if (digest !== contractDigest(unsigned)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger append proof digest is invalid.");
  }
  return surface;
}

function validateRetainedEventLedgerSessionAttestation(proof) {
  if (!Object.isFrozen(proof) || utilTypes.isProxy(proof) || Object.getPrototypeOf(proof) !== null) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session proof is invalid.");
  }
  const keys = Reflect.ownKeys(proof);
  if (
    keys.length !== RETAINED_EVENT_LEDGER_SESSION_ATTESTATION_KEYS.length ||
    keys.some((key) => !RETAINED_EVENT_LEDGER_SESSION_ATTESTATION_KEYS.includes(key))
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session proof fields are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(proof, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.writable ||
      descriptor.configurable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session proof is not immutable data.");
    }
  }
  const { digest, ...unsigned } = proof;
  if (
    proof.schemaVersion !== INTEGRATION_EVENT_LEDGER_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.durable !== true ||
    proof.persisted !== true ||
    proof.contiguous !== true ||
    proof.monotonic !== true ||
    proof.bridgeOwned !== false ||
    proof.mappingVersion !== PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION ||
    !Number.isSafeInteger(proof.maxEvents) ||
    !Number.isSafeInteger(proof.maxBytes) ||
    digest !== contractDigest(unsigned)
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session proof is unavailable.");
  }
  return proof;
}

function buildRetainedEventLedgerSessionAttestation(state) {
  const unsigned = Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_EVENT_LEDGER_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    maxEvents: state.expected.maxEvents,
    maxBytes: state.expected.maxBytes,
  });
  return validateRetainedEventLedgerSessionAttestation(
    Object.freeze(Object.assign(Object.create(null), unsigned, { digest: contractDigest(unsigned) }))
  );
}

function validateRetainedEventLedgerSessionView(surface, proof) {
  if (!Object.isFrozen(surface) || utilTypes.isProxy(surface) || Object.getPrototypeOf(surface) !== null) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session view is invalid.");
  }
  const keys = Reflect.ownKeys(surface);
  if (
    keys.length !== RETAINED_EVENT_LEDGER_SESSION_VIEW_KEYS.length ||
    keys.some((key) => !RETAINED_EVENT_LEDGER_SESSION_VIEW_KEYS.includes(key))
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session view fields are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.writable ||
      descriptor.configurable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session view is not immutable data.");
    }
  }
  if (surface.owner !== "aginti" || typeof surface.ledgerForRun !== "function" || typeof surface.attest !== "function") {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session view is unavailable.");
  }
  validateRetainedEventLedgerSessionAttestation(proof);
  return surface;
}

function retainedSessionLedgerForRun(state, scope) {
  const runtimeLedger = retainedLedgerForRun(state, scope);
  const sessionLedger = Object.create(null);
  for (const key of Reflect.ownKeys(runtimeLedger)) {
    Object.defineProperty(sessionLedger, key, Object.getOwnPropertyDescriptor(runtimeLedger, key));
  }
  return Object.freeze(sessionLedger);
}

function buildRetainedEventLedgerSessionView(state) {
  state.sessionProof = buildRetainedEventLedgerSessionAttestation(state);
  return validateRetainedEventLedgerSessionView(Object.freeze(Object.assign(Object.create(null), {
    owner: "aginti",
    ledgerForRun(scopeInput) {
      const scope = normalizeRetainedLedgerScope(scopeInput);
      assertRetainedEventLedgerStoreOpen(state);
      return retainedSessionLedgerForRun(state, scope);
    },
    attest() {
      if (arguments.length !== 0) {
        retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session attestation takes no arguments.");
      }
      assertRetainedEventLedgerStoreOpen(state);
      return state.sessionProof;
    },
  })), state.sessionProof);
}

function validateRetainedEventLedgerBundleAttestation(proof) {
  if (!Object.isFrozen(proof) || utilTypes.isProxy(proof) || Object.getPrototypeOf(proof) !== null) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle proof is invalid.");
  }
  const keys = Reflect.ownKeys(proof);
  if (
    keys.length !== RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_KEYS.length ||
    keys.some((key) => !RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_KEYS.includes(key))
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle proof fields are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(proof, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.writable ||
      descriptor.configurable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle proof is not immutable data.");
    }
  }
  const { digest, ...unsigned } = proof;
  if (
    proof.schemaVersion !== INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.sharedRetainedState !== true ||
    proof.runtimeAppendSurface !== true ||
    proof.sessionReadOnlySurface !== true ||
    proof.sessionAttestationUnderGlobalLock !== false ||
    proof.sessionAttestationChecksOpenAndPoisonState !== true ||
    proof.sessionAttestationDrainsOperations !== false ||
    proof.singleClaimedLockSurface !== true ||
    proof.storageLifecycleOwned !== false ||
    proof.runtimeCapabilityEnabled !== false ||
    proof.serverWiringIncluded !== false ||
    proof.limitations !== INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS ||
    !/^[a-f0-9]{64}$/u.test(proof.eventAppendProofDigest) ||
    !/^[a-f0-9]{64}$/u.test(proof.sessionProofDigest) ||
    !/^[a-f0-9]{64}$/u.test(proof.storageBindingDigest) ||
    digest !== contractDigest(unsigned)
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle proof is unavailable.");
  }
  return proof;
}

function buildRetainedEventLedgerBundleAttestation(state) {
  const unsigned = Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    sharedRetainedState: true,
    runtimeAppendSurface: true,
    sessionReadOnlySurface: true,
    sessionAttestationUnderGlobalLock: false,
    sessionAttestationChecksOpenAndPoisonState: true,
    sessionAttestationDrainsOperations: false,
    singleClaimedLockSurface: true,
    storageLifecycleOwned: false,
    runtimeCapabilityEnabled: false,
    serverWiringIncluded: false,
    eventAppendProofDigest: state.proof.digest,
    sessionProofDigest: state.sessionProof.digest,
    storageBindingDigest: state.bindingDigest,
    limitations: INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS,
  });
  return validateRetainedEventLedgerBundleAttestation(
    Object.freeze(Object.assign(Object.create(null), unsigned, { digest: contractDigest(unsigned) }))
  );
}

function validateRetainedEventLedgerBundleSurface(surface, state) {
  if (!Object.isFrozen(surface) || utilTypes.isProxy(surface) || Object.getPrototypeOf(surface) !== null) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle is invalid.");
  }
  const keys = Reflect.ownKeys(surface);
  if (
    keys.length !== RETAINED_EVENT_LEDGER_BUNDLE_KEYS.length ||
    keys.some((key) => !RETAINED_EVENT_LEDGER_BUNDLE_KEYS.includes(key))
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle fields are invalid.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(surface, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.writable ||
      descriptor.configurable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle is not immutable data.");
    }
  }
  if (
    surface.schemaVersion !== INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_VERSION ||
    surface.runtimeStore !== state.surface ||
    surface.sessionReadView !== state.sessionView ||
    surface.attestation !== state.bundleAttestation
  ) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle references are invalid.");
  }
  validateRetainedEventLedgerStoreSurface(surface.runtimeStore, state.proof);
  validateRetainedEventLedgerSessionView(surface.sessionReadView, state.sessionProof);
  validateRetainedEventLedgerBundleAttestation(surface.attestation);
  return surface;
}

function retainedEventLedgerBindingDigest(expected) {
  return contractDigest({
    schemaVersion: "aginti-retained-public-event-ledger-binding-v1",
    directory: retainedDirectoryExpected(expected),
    lock: retainedLockExpected(expected),
    maxEvents: expected.maxEvents,
    maxBytes: expected.maxBytes,
    lockWaitMs: expected.lockWaitMs,
  });
}

function createRetainedEventLedgerState(filePrimitives, lock, expectedInput) {
  const expected = normalizeRetainedEventLedgerExpected(expectedInput);
  const directoryExpected = retainedDirectoryExpected(expected);
  const lockExpected = retainedLockExpected(expected);
  try {
    assertRetainedProtectedFilePrimitives(filePrimitives, directoryExpected);
    assertRetainedRegularFileLock(lock, lockExpected);
  } catch {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger storage brands do not match their expected binding.");
  }
  if (claimedRetainedEventLedgerLocks.has(lock)) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger lock surface is already owned by a store.");
  }
  if (filePrimitives.isClosed() || lock.isClosed()) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger storage binding is closed.");
  }
  const state = {
    filePrimitives,
    lock,
    expected,
    bindingDigest: retainedEventLedgerBindingDigest(expected),
    operationQueue: [],
    queueDraining: false,
    pendingOperations: 0,
    observedScopeDigests: new Set(),
    poisoned: false,
    poisonReason: "",
    surface: null,
    sessionView: null,
    sessionProof: null,
    bundle: null,
    bundleAttestation: null,
    proof: buildRetainedEventAppendAttestation(),
  };
  return state;
}

function buildRetainedEventLedgerRuntimeStore(state) {
  const surface = Object.freeze({
    owner: "aginti",
    authority: "aginti",
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    appendPublicEvent(scopeInput, eventInput) {
      const scope = normalizeRetainedLedgerScope(scopeInput);
      const input = normalizeRetainedAppendInput(eventInput);
      return appendRetainedPublicEvent(state, scope, input);
    },
    appendByOutboxId(scopeInput, eventInput) {
      const scope = normalizeRetainedLedgerScope(scopeInput);
      const input = normalizeRetainedOutboxAppendInput(eventInput);
      return appendRetainedEventByOutboxId(state, scope, input);
    },
    lookupByOutboxId(scopeInput, lookupInput) {
      const scope = normalizeRetainedLedgerScope(scopeInput);
      const input = normalizeRetainedLookupInput(lookupInput);
      return lookupRetainedEventByOutboxId(state, scope, input);
    },
    ledgerForRun(scopeInput) {
      const scope = normalizeRetainedLedgerScope(scopeInput);
      assertRetainedEventLedgerStoreOpen(state);
      return retainedLedgerForRun(state, scope);
    },
    [INTEGRATION_RETAINED_EVENT_LEDGER_APPEND_ATTESTATION_PROPERTY]: state.proof,
  });
  state.surface = validateRetainedEventLedgerStoreSurface(surface, state.proof);
  return state.surface;
}

function publishRetainedEventLedgerState(state, { bundle = false } = {}) {
  retainedEventLedgerStoreBrand.set(state.surface, state);
  if (bundle) {
    retainedEventLedgerSessionViewBrand.set(state.sessionView, state);
    retainedEventLedgerBundleBrand.set(state.bundle, state);
  }
  claimedRetainedEventLedgerLocks.add(state.lock);
}

export function createRetainedIntegrationEventLedgerStore(filePrimitives, lock, expectedInput) {
  const state = createRetainedEventLedgerState(filePrimitives, lock, expectedInput);
  buildRetainedEventLedgerRuntimeStore(state);
  publishRetainedEventLedgerState(state);
  return state.surface;
}

export function createRetainedIntegrationEventLedgerBundle(filePrimitives, lock, expectedInput) {
  const state = createRetainedEventLedgerState(filePrimitives, lock, expectedInput);
  buildRetainedEventLedgerRuntimeStore(state);
  state.sessionView = buildRetainedEventLedgerSessionView(state);
  state.bundleAttestation = buildRetainedEventLedgerBundleAttestation(state);
  state.bundle = validateRetainedEventLedgerBundleSurface(Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_VERSION,
    runtimeStore: state.surface,
    sessionReadView: state.sessionView,
    attestation: state.bundleAttestation,
  })), state);
  publishRetainedEventLedgerState(state, { bundle: true });
  return state.bundle;
}

export function assertRetainedIntegrationEventLedgerStore(value, expectedInput) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? retainedEventLedgerStoreBrand.get(value)
    : null;
  if (!state || value !== state.surface) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger store lexical brand is invalid.");
  }
  validateRetainedEventLedgerStoreSurface(value, state.proof);
  if (expectedInput !== undefined) {
    const expected = normalizeRetainedEventLedgerExpected(expectedInput);
    const expectedBindingDigest = retainedEventLedgerBindingDigest(expected);
    if (expectedBindingDigest !== state.bindingDigest) {
      retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger store binding is invalid.");
    }
  }
  return value;
}

export function assertRetainedIntegrationEventLedgerBundle(value, expectedInput) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? retainedEventLedgerBundleBrand.get(value)
    : null;
  if (!state || value !== state.bundle) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger bundle lexical brand is invalid.");
  }
  validateRetainedEventLedgerBundleSurface(value, state);
  if (retainedEventLedgerSessionViewBrand.get(value.sessionReadView) !== state) {
    retainedLedgerFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Retained event ledger session view lexical brand is invalid.");
  }
  assertRetainedIntegrationEventLedgerStore(value.runtimeStore, expectedInput);
  return value;
}
