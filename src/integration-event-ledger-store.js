import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPublicIntegrationEvent,
  MAX_INTEGRATION_EVENT_BATCH,
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

const ZERO_DIGEST = "0".repeat(64);
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_APPEND_PRIMITIVE_BYTES = 16 * 1024 * 1024;

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
