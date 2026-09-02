import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  atomicWriteProtectedJson,
  ensureStoreLayout,
  parseIsoMs,
  randomHex,
  readProtectedJsonFile,
  reconcileProtectedJsonTemporaryFiles,
  sealObject,
  assertSealedObject,
  withDirectoryLock,
} from "./integration-durable-common.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION =
  "aginti-integration-worker-directory-v1";
export const INTEGRATION_WORKER_ADMISSION_SCHEMA_VERSION =
  "aginti-integration-worker-admission-v1";
export const INTEGRATION_WORKER_DIRECTORY_EVENT_SCHEMA_VERSION =
  "aginti-integration-worker-directory-event-v1";
export const DEFAULT_INTEGRATION_WORKER_DIRECTORY_ROOT =
  "/var/lib/agintiflow-integration/worker-directory";
export const INTEGRATION_WORKER_DIRECTORY_ROLES = Object.freeze([
  "document",
  "embedding",
  "execution",
  "file",
  "grounded-search",
  "speech",
  "text-inference",
  "vision-inference",
]);
export const INTEGRATION_WORKER_DIRECTORY_PLATFORMS = Object.freeze([
  "generic-linux",
  "jetson",
  "kria",
  "raspberry-pi",
  "workstation",
]);

const STATE_DOMAIN = "aginti-integration-worker-directory-state-v1";
const ZERO_HASH = "0".repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const NODE_ID = /^node_[A-Za-z0-9_-]{16,96}$/u;
const BINDING_ID = /^binding_[A-Za-z0-9_-]{16,96}$/u;
const LEASE_ID = /^lease_[a-f0-9]{32}$/u;
const EVENT_ID = /^worker_event_[a-f0-9]{32}$/u;
const RELEASE_ID = /^[A-Za-z0-9._+:-]{1,160}$/u;
const PROTOCOL = /^[A-Za-z0-9._+:/-]{1,120}$/u;
const ROLE_SET = new Set(INTEGRATION_WORKER_DIRECTORY_ROLES);
const PLATFORM_SET = new Set(INTEGRATION_WORKER_DIRECTORY_PLATFORMS);
const LIFECYCLES = new Set(["enrolled", "retiring"]);
const TRANSPORTS = new Set(["lazyedge-private-http-v1", "local-loopback-http-v1"]);
const MAXIMUM_NODES = 64;
const MAXIMUM_LEASES = 256;
const MAXIMUM_EVENTS = 512;
const MAXIMUM_ADMISSION_LIFETIME_MS = 10 * 60 * 1000;
const MAXIMUM_LEASE_LIFETIME_MS = 10 * 60 * 1000;
const MAXIMUM_CLOCK_SKEW_MS = 5_000;
const DIRECTORY_BRAND = new WeakSet();

export class IntegrationWorkerDirectoryError extends Error {
  constructor(code, message, { status = 409, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationWorkerDirectoryError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationWorkerDirectoryError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label, code = "WORKER_DIRECTORY_INVALID") {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain data object.`, { status: 400 });
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code, `${label} contains an unsupported field.`, { status: 400 });
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(code, `${label}.${key} is required.`, { status: 400 });
    }
  }
  return value;
}

function canonicalTimestamp(value, label, code = "WORKER_DIRECTORY_INVALID") {
  try {
    parseIsoMs(value, label);
  } catch (error) {
    fail(code, `${label} is invalid.`, { status: 400, cause: error });
  }
  return value;
}

function safeDigest(value, label, code = "WORKER_DIRECTORY_INVALID") {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code, `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function safeRole(value, label = "role", code = "WORKER_DIRECTORY_INVALID") {
  if (typeof value !== "string" || !ROLE_SET.has(value)) {
    fail(code, `${label} is unsupported.`, { status: 400 });
  }
  return value;
}

function sortedUniqueStrings(
  value,
  allowed,
  label,
  { minimum = 1, maximum = 16, code = "WORKER_DIRECTORY_INVALID" } = {}
) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(code, `${label} must be a bounded array.`, { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string" || !allowed(item)) {
      fail(code, `${label} contains an unsupported value.`, { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail(code, `${label} contains a duplicate.`, { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
  }
  return Object.freeze([...normalized].sort());
}

function normalizeCandidate(value, code = "WORKER_DIRECTORY_INVALID") {
  const candidate = exactObject(
    value,
    ["nodeId", "bindingId", "platform", "roles"],
    ["nodeId", "bindingId", "platform", "roles"],
    "worker candidate",
    code
  );
  if (typeof candidate.nodeId !== "string" || !NODE_ID.test(candidate.nodeId)) {
    fail(code, "worker candidate nodeId is invalid.", { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
  }
  if (typeof candidate.bindingId !== "string" || !BINDING_ID.test(candidate.bindingId)) {
    fail(code, "worker candidate bindingId is invalid.", { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
  }
  if (typeof candidate.platform !== "string" || !PLATFORM_SET.has(candidate.platform)) {
    fail(code, "worker candidate platform is unsupported.", { status: code === "WORKER_DIRECTORY_CORRUPT" ? 500 : 400 });
  }
  const roles = sortedUniqueStrings(candidate.roles, (role) => ROLE_SET.has(role), "worker candidate roles", { code });
  return Object.freeze({
    nodeId: candidate.nodeId,
    bindingId: candidate.bindingId,
    platform: candidate.platform,
    roles,
  });
}

function admissionUnsigned(value, candidate) {
  const admission = exactObject(
    value,
    [
      "schemaVersion", "nodeId", "bindingId", "roles", "transport", "releaseId",
      "releaseDigest", "capabilitiesDigest", "canaryDigest", "protocols", "ready",
      "observedAt", "expiresAt", "digest",
    ],
    [
      "schemaVersion", "nodeId", "bindingId", "roles", "transport", "releaseId",
      "releaseDigest", "capabilitiesDigest", "canaryDigest", "protocols", "ready",
      "observedAt", "expiresAt", "digest",
    ],
    "worker admission",
    "WORKER_ADMISSION_INVALID"
  );
  if (
    admission.schemaVersion !== INTEGRATION_WORKER_ADMISSION_SCHEMA_VERSION ||
    admission.nodeId !== candidate.nodeId ||
    admission.bindingId !== candidate.bindingId ||
    admission.ready !== true ||
    typeof admission.transport !== "string" ||
    !TRANSPORTS.has(admission.transport) ||
    typeof admission.releaseId !== "string" ||
    !RELEASE_ID.test(admission.releaseId)
  ) {
    fail("WORKER_ADMISSION_INVALID", "worker admission identity is invalid.", { status: 502 });
  }
  const roles = sortedUniqueStrings(admission.roles, (role) => ROLE_SET.has(role), "worker admission roles", {
    code: "WORKER_ADMISSION_INVALID",
  });
  if (contractDigest(roles) !== contractDigest(candidate.roles)) {
    fail("WORKER_ADMISSION_INVALID", "worker admission roles diverge from the candidate.", { status: 502 });
  }
  const protocols = sortedUniqueStrings(
    admission.protocols,
    (protocol) => PROTOCOL.test(protocol),
    "worker admission protocols",
    { code: "WORKER_ADMISSION_INVALID" }
  );
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_WORKER_ADMISSION_SCHEMA_VERSION,
    nodeId: candidate.nodeId,
    bindingId: candidate.bindingId,
    roles,
    transport: admission.transport,
    releaseId: admission.releaseId,
    releaseDigest: safeDigest(admission.releaseDigest, "worker admission releaseDigest", "WORKER_ADMISSION_INVALID"),
    capabilitiesDigest: safeDigest(admission.capabilitiesDigest, "worker admission capabilitiesDigest", "WORKER_ADMISSION_INVALID"),
    canaryDigest: safeDigest(admission.canaryDigest, "worker admission canaryDigest", "WORKER_ADMISSION_INVALID"),
    protocols,
    ready: true,
    observedAt: canonicalTimestamp(admission.observedAt, "worker admission observedAt", "WORKER_ADMISSION_INVALID"),
    expiresAt: canonicalTimestamp(admission.expiresAt, "worker admission expiresAt", "WORKER_ADMISSION_INVALID"),
  });
  if (admission.digest !== contractDigest(unsigned)) {
    fail("WORKER_ADMISSION_INVALID", "worker admission digest is invalid.", { status: 502 });
  }
  return unsigned;
}

function validateAdmission(value, candidate, nowMs, { requireFresh = true } = {}) {
  const unsigned = admissionUnsigned(value, candidate);
  const observedMs = Date.parse(unsigned.observedAt);
  const expiresMs = Date.parse(unsigned.expiresAt);
  if (
    expiresMs <= observedMs ||
    expiresMs - observedMs > MAXIMUM_ADMISSION_LIFETIME_MS ||
    observedMs > nowMs + MAXIMUM_CLOCK_SKEW_MS ||
    (requireFresh && expiresMs <= nowMs)
  ) {
    fail("WORKER_ADMISSION_STALE", "worker admission evidence is stale or has an invalid lifetime.", { status: 503 });
  }
  return Object.freeze({ ...unsigned, digest: value.digest });
}

function nodeCandidate(node) {
  return Object.freeze({
    nodeId: node.nodeId,
    bindingId: node.bindingId,
    platform: node.platform,
    roles: Object.freeze([...node.roles]),
  });
}

function stateWithoutIntegrity(state) {
  const { integrityDigest: _integrityDigest, ...unsigned } = state;
  return unsigned;
}

function sealState(unsigned) {
  return sealObject(unsigned, STATE_DOMAIN);
}

function emptyState(at) {
  return sealState({
    schemaVersion: INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION,
    revision: 0,
    nodes: [],
    assignments: [],
    leases: [],
    events: [],
    lastEventHash: ZERO_HASH,
    updatedAt: at,
  });
}

function eventHash(event) {
  const { hash: _hash, ...unsigned } = event;
  return contractDigest(unsigned);
}

function appendEvent(state, type, payload, at, random) {
  if (state.events.length >= MAXIMUM_EVENTS) {
    fail("WORKER_DIRECTORY_CAPACITY_EXHAUSTED", "worker directory transition ledger is full.", { status: 507 });
  }
  const id = `worker_event_${randomToken(random, 16, "worker event")}`;
  if (state.events.some((event) => event.id === id)) {
    fail("WORKER_DIRECTORY_RANDOM_INVALID", "worker event random source repeated an identifier.", { status: 503 });
  }
  const event = {
    schemaVersion: INTEGRATION_WORKER_DIRECTORY_EVENT_SCHEMA_VERSION,
    id,
    seq: state.events.length + 1,
    revision: state.revision,
    type,
    at,
    payload,
    previousHash: state.lastEventHash,
  };
  event.hash = eventHash(event);
  state.events.push(event);
  state.lastEventHash = event.hash;
}

function normalizeNode(value, nowMs) {
  const node = exactObject(
    value,
    ["nodeId", "bindingId", "platform", "roles", "lifecycle", "admission", "enrolledAt", "updatedAt"],
    ["nodeId", "bindingId", "platform", "roles", "lifecycle", "admission", "enrolledAt", "updatedAt"],
    "worker directory node",
    "WORKER_DIRECTORY_CORRUPT"
  );
  const candidate = normalizeCandidate({
    nodeId: node.nodeId,
    bindingId: node.bindingId,
    platform: node.platform,
    roles: node.roles,
  }, "WORKER_DIRECTORY_CORRUPT");
  if (!LIFECYCLES.has(node.lifecycle)) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory node lifecycle is invalid.", { status: 500 });
  }
  canonicalTimestamp(node.enrolledAt, "worker directory node enrolledAt", "WORKER_DIRECTORY_CORRUPT");
  canonicalTimestamp(node.updatedAt, "worker directory node updatedAt", "WORKER_DIRECTORY_CORRUPT");
  return Object.freeze({
    ...candidate,
    lifecycle: node.lifecycle,
    admission: normalizePersistedAdmission(node.admission, candidate, nowMs),
    enrolledAt: node.enrolledAt,
    updatedAt: node.updatedAt,
  });
}

function normalizeAssignment(value) {
  const assignment = exactObject(
    value,
    ["role", "nodeId", "previousNodeId", "generation", "switchedAt"],
    ["role", "nodeId", "previousNodeId", "generation", "switchedAt"],
    "worker assignment",
    "WORKER_DIRECTORY_CORRUPT"
  );
  const role = safeRole(assignment.role, "worker assignment role", "WORKER_DIRECTORY_CORRUPT");
  if (!NODE_ID.test(String(assignment.nodeId || "")) ||
      (assignment.previousNodeId !== null && !NODE_ID.test(String(assignment.previousNodeId || ""))) ||
      assignment.previousNodeId === assignment.nodeId ||
      !Number.isSafeInteger(assignment.generation) || assignment.generation < 1) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker assignment identity is invalid.", { status: 500 });
  }
  canonicalTimestamp(assignment.switchedAt, "worker assignment switchedAt", "WORKER_DIRECTORY_CORRUPT");
  return Object.freeze({
    role,
    nodeId: assignment.nodeId,
    previousNodeId: assignment.previousNodeId,
    generation: assignment.generation,
    switchedAt: assignment.switchedAt,
  });
}

function normalizeLease(value) {
  const lease = exactObject(
    value,
    ["leaseId", "role", "nodeId", "assignmentGeneration", "ownerDigest", "acquiredAt", "expiresAt"],
    ["leaseId", "role", "nodeId", "assignmentGeneration", "ownerDigest", "acquiredAt", "expiresAt"],
    "worker lease",
    "WORKER_DIRECTORY_CORRUPT"
  );
  if (!LEASE_ID.test(String(lease.leaseId || "")) || !NODE_ID.test(String(lease.nodeId || "")) ||
      !Number.isSafeInteger(lease.assignmentGeneration) || lease.assignmentGeneration < 1) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker lease identity is invalid.", { status: 500 });
  }
  const role = safeRole(lease.role, "worker lease role", "WORKER_DIRECTORY_CORRUPT");
  safeDigest(lease.ownerDigest, "worker lease ownerDigest", "WORKER_DIRECTORY_CORRUPT");
  canonicalTimestamp(lease.acquiredAt, "worker lease acquiredAt", "WORKER_DIRECTORY_CORRUPT");
  canonicalTimestamp(lease.expiresAt, "worker lease expiresAt", "WORKER_DIRECTORY_CORRUPT");
  const acquiredMs = Date.parse(lease.acquiredAt);
  const expiresMs = Date.parse(lease.expiresAt);
  if (expiresMs <= acquiredMs || expiresMs - acquiredMs > MAXIMUM_LEASE_LIFETIME_MS) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker lease lifetime is invalid.", { status: 500 });
  }
  return Object.freeze({ ...lease, role });
}

function normalizePersistedAdmission(value, candidate, nowMs) {
  try {
    return validateAdmission(value, candidate, nowMs, { requireFresh: false });
  } catch (error) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory node admission is invalid.", {
      status: 500,
      cause: error,
    });
  }
}

function normalizeEvent(value, expectedSeq, expectedPreviousHash, maximumRevision) {
  const event = exactObject(
    value,
    ["schemaVersion", "id", "seq", "revision", "type", "at", "payload", "previousHash", "hash"],
    ["schemaVersion", "id", "seq", "revision", "type", "at", "payload", "previousHash", "hash"],
    "worker directory event",
    "WORKER_DIRECTORY_CORRUPT"
  );
  if (
    event.schemaVersion !== INTEGRATION_WORKER_DIRECTORY_EVENT_SCHEMA_VERSION ||
    !EVENT_ID.test(String(event.id || "")) ||
    event.seq !== expectedSeq ||
    !Number.isSafeInteger(event.revision) || event.revision < 1 || event.revision > maximumRevision ||
    typeof event.type !== "string" || !/^[a-z]+(?:\.[a-z]+){1,2}$/u.test(event.type) ||
    !isPlainObject(event.payload) ||
    event.previousHash !== expectedPreviousHash ||
    event.hash !== eventHash(event)
  ) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory event ledger is invalid.", { status: 500 });
  }
  canonicalTimestamp(event.at, "worker directory event at", "WORKER_DIRECTORY_CORRUPT");
  return Object.freeze(event);
}

function normalizeState(raw, nowMs) {
  try {
    assertSealedObject(raw, STATE_DOMAIN, "worker directory state");
  } catch (error) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory state integrity is invalid.", { status: 500, cause: error });
  }
  const state = exactObject(
    raw,
    ["schemaVersion", "revision", "nodes", "assignments", "leases", "events", "lastEventHash", "updatedAt", "integrityDigest"],
    ["schemaVersion", "revision", "nodes", "assignments", "leases", "events", "lastEventHash", "updatedAt", "integrityDigest"],
    "worker directory state",
    "WORKER_DIRECTORY_CORRUPT"
  );
  if (
    state.schemaVersion !== INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !Array.isArray(state.nodes) || state.nodes.length > MAXIMUM_NODES ||
    !Array.isArray(state.assignments) || state.assignments.length > ROLE_SET.size ||
    !Array.isArray(state.leases) || state.leases.length > MAXIMUM_LEASES ||
    !Array.isArray(state.events) || state.events.length > MAXIMUM_EVENTS
  ) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory state shape is invalid.", { status: 500 });
  }
  const nodes = state.nodes.map((node) => normalizeNode(node, nowMs));
  const assignments = state.assignments.map(normalizeAssignment);
  const leases = state.leases.map(normalizeLease);
  for (const [records, key] of [[nodes, "nodeId"], [assignments, "role"], [leases, "leaseId"]]) {
    const values = records.map((record) => record[key]);
    if (new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort())) {
      fail("WORKER_DIRECTORY_CORRUPT", `worker directory ${key} records are not unique and sorted.`, { status: 500 });
    }
  }
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  if (new Set(nodes.map(({ bindingId }) => bindingId)).size !== nodes.length) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory binding IDs are not unique.", { status: 500 });
  }
  for (const assignment of assignments) {
    const current = nodesById.get(assignment.nodeId);
    const previous = assignment.previousNodeId === null ? null : nodesById.get(assignment.previousNodeId);
    if (!current?.roles.includes(assignment.role) || current.lifecycle !== "enrolled" ||
        (assignment.previousNodeId !== null && !previous?.roles.includes(assignment.role))) {
      fail("WORKER_DIRECTORY_CORRUPT", "worker assignment references an invalid node.", { status: 500 });
    }
  }
  for (const lease of leases) {
    if (!nodesById.get(lease.nodeId)?.roles.includes(lease.role)) {
      fail("WORKER_DIRECTORY_CORRUPT", "worker lease references an invalid node.", { status: 500 });
    }
  }
  let previousHash = ZERO_HASH;
  const events = state.events.map((event, index) => {
    const normalized = normalizeEvent(event, index + 1, previousHash, state.revision);
    previousHash = normalized.hash;
    return normalized;
  });
  if (new Set(events.map(({ id }) => id)).size !== events.length) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory event IDs are not unique.", { status: 500 });
  }
  if (state.lastEventHash !== previousHash || !DIGEST.test(state.lastEventHash)) {
    fail("WORKER_DIRECTORY_CORRUPT", "worker directory event head is invalid.", { status: 500 });
  }
  canonicalTimestamp(state.updatedAt, "worker directory updatedAt", "WORKER_DIRECTORY_CORRUPT");
  return sealState({
    schemaVersion: INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION,
    revision: state.revision,
    nodes,
    assignments,
    leases,
    events,
    lastEventHash: state.lastEventHash,
    updatedAt: state.updatedAt,
  });
}

function mutableState(state) {
  return structuredClone(stateWithoutIntegrity(state));
}

function sortState(state) {
  state.nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  state.assignments.sort((left, right) => left.role.localeCompare(right.role));
  state.leases.sort((left, right) => left.leaseId.localeCompare(right.leaseId));
}

function sweepExpiredLeases(state, nowMs) {
  const before = state.leases.length;
  state.leases = state.leases.filter((lease) => Date.parse(lease.expiresAt) > nowMs);
  return state.leases.length !== before;
}

function freshNode(node, nowMs) {
  if (!node || node.lifecycle !== "enrolled" || Date.parse(node.admission.expiresAt) <= nowMs) {
    fail("WORKER_NOT_READY", "worker node is not enrolled with fresh admission evidence.", { status: 503 });
  }
  return node;
}

function publicSnapshot(state, nowMs) {
  const activeLeases = state.leases.filter((lease) => Date.parse(lease.expiresAt) > nowMs);
  return Object.freeze({
    schemaVersion: INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION,
    revision: state.revision,
    nodes: Object.freeze(state.nodes.map((node) => Object.freeze({ ...node }))),
    assignments: Object.freeze(state.assignments.map((assignment) => Object.freeze({ ...assignment }))),
    leases: Object.freeze(activeLeases.map((lease) => Object.freeze({ ...lease }))),
    eventCursor: Object.freeze({ lastSeq: state.events.length, lastHash: state.lastEventHash }),
    updatedAt: state.updatedAt,
    integrityDigest: state.integrityDigest,
  });
}

function expectedGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("WORKER_DIRECTORY_INVALID", "expectedGeneration must be a non-negative integer.", { status: 400 });
  }
  return value;
}

function leaseLifetime(value) {
  const ttlMs = value ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAXIMUM_LEASE_LIFETIME_MS) {
    fail("WORKER_DIRECTORY_INVALID", "worker lease ttlMs is invalid.", { status: 400 });
  }
  return ttlMs;
}

function randomToken(random, bytes, label) {
  const value = random(bytes);
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "u").test(value)) {
    fail("WORKER_DIRECTORY_RANDOM_INVALID", `${label} random source returned invalid data.`, { status: 503 });
  }
  return value;
}

async function initializeStore(rootDir, now) {
  const dirs = await ensureStoreLayout(rootDir, ["state", "locks"]);
  const statePath = path.join(dirs.state, "directory.json");
  const lockPath = path.join(dirs.locks, "mutation.lock");
  await withDirectoryLock(lockPath, async () => {
    await reconcileProtectedJsonTemporaryFiles(statePath, { exclusiveAuthority: true });
    const existing = await readProtectedJsonFile(statePath, { optional: true, maxBytes: 2 * 1024 * 1024 });
    if (existing === null) await atomicWriteProtectedJson(statePath, emptyState(now().toISOString()));
    else normalizeState(existing, now().valueOf());
  }, { requireValidatedOwnerForRecovery: true });
  return Object.freeze({ dirs, statePath, lockPath });
}

export async function createIntegrationWorkerDirectory(options = {}) {
  const config = exactObject(
    options,
    ["rootDir", "probe", "now", "randomHex"],
    ["probe"],
    "worker directory options"
  );
  const rootDir = config.rootDir ?? DEFAULT_INTEGRATION_WORKER_DIRECTORY_ROOT;
  if (typeof rootDir !== "string" || path.resolve(rootDir) !== rootDir) {
    fail("WORKER_DIRECTORY_INVALID", "worker directory rootDir must be an absolute canonical path.", { status: 400 });
  }
  if (typeof config.probe !== "function") {
    fail("WORKER_DIRECTORY_INVALID", "worker directory requires an attested probe function.", { status: 400 });
  }
  const now = config.now ?? (() => new Date());
  const random = config.randomHex ?? randomHex;
  if (typeof now !== "function" || typeof random !== "function") {
    fail("WORKER_DIRECTORY_INVALID", "worker directory clock or random source is invalid.", { status: 400 });
  }
  const paths = await initializeStore(rootDir, now);

  async function locked(operation) {
    return withDirectoryLock(paths.lockPath, async () => {
      await reconcileProtectedJsonTemporaryFiles(paths.statePath, { exclusiveAuthority: true });
      const raw = await readProtectedJsonFile(paths.statePath, { maxBytes: 2 * 1024 * 1024 });
      const atDate = now();
      if (!(atDate instanceof Date) || !Number.isFinite(atDate.valueOf())) {
        fail("WORKER_DIRECTORY_CLOCK_INVALID", "worker directory clock is invalid.", { status: 503 });
      }
      const state = normalizeState(raw, atDate.valueOf());
      return operation(state, atDate);
    }, { requireValidatedOwnerForRecovery: true });
  }

  async function writeMutation(state, at, mutate) {
    const next = mutableState(state);
    const swept = sweepExpiredLeases(next, at.valueOf());
    const outcome = await mutate(next, at);
    if (outcome?.changed !== true && !swept) return outcome?.result;
    next.revision += 1;
    next.updatedAt = at.toISOString();
    if (outcome?.event) appendEvent(next, outcome.event.type, outcome.event.payload, next.updatedAt, random);
    sortState(next);
    const sealed = sealState(next);
    normalizeState(sealed, at.valueOf());
    await atomicWriteProtectedJson(paths.statePath, sealed);
    return outcome?.resultFactory ? outcome.resultFactory(sealed) : outcome?.result;
  }

  async function probe(candidate, nowMs) {
    let response;
    try {
      response = await config.probe(candidate);
    } catch (error) {
      if (error instanceof IntegrationWorkerDirectoryError) throw error;
      fail("WORKER_PROBE_UNAVAILABLE", "worker admission probe was unavailable.", { status: 503, cause: error });
    }
    return validateAdmission(response, candidate, nowMs);
  }

  const directory = Object.freeze({
    attestation: Object.freeze({
      schemaVersion: INTEGRATION_WORKER_DIRECTORY_SCHEMA_VERSION,
      owner: "aginti",
      durable: true,
      secretFreeState: true,
      coordinatorOwnedAssignments: true,
      callerSelectableEndpoint: false,
      callerSelectableCredential: false,
      lazyEdgeOwnsTransportOnly: true,
      zeroDowntimeLeaseDrain: true,
      rollbackBeforeFinalization: true,
      stateRootDigest: contractDigest({ rootDir }),
    }),

    async status() {
      return locked(async (state, at) => publicSnapshot(state, at.valueOf()));
    },

    async events() {
      return locked(async (state) => Object.freeze(state.events.map((event) => Object.freeze({ ...event }))));
    },

    async enroll(value) {
      const candidate = normalizeCandidate(value);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        if (next.nodes.length >= MAXIMUM_NODES) {
          fail("WORKER_DIRECTORY_CAPACITY_EXHAUSTED", "worker directory node capacity is exhausted.", { status: 507 });
        }
        if (next.nodes.some((node) => node.nodeId === candidate.nodeId || node.bindingId === candidate.bindingId)) {
          fail("WORKER_ALREADY_ENROLLED", "worker node or binding is already enrolled.");
        }
        const admission = await probe(candidate, at.valueOf());
        const record = {
          ...candidate,
          lifecycle: "enrolled",
          admission,
          enrolledAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
        next.nodes.push(record);
        return {
          changed: true,
          event: { type: "node.enrolled", payload: { nodeId: candidate.nodeId, bindingId: candidate.bindingId, roles: candidate.roles, admissionDigest: admission.digest } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).nodes.find(({ nodeId }) => nodeId === candidate.nodeId),
        };
      }));
    },

    async renew(nodeId) {
      if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) {
        fail("WORKER_DIRECTORY_INVALID", "worker nodeId is invalid.", { status: 400 });
      }
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const node = next.nodes.find((candidate) => candidate.nodeId === nodeId);
        if (!node) fail("WORKER_NOT_FOUND", "worker node is not enrolled.", { status: 404 });
        if (node.lifecycle !== "enrolled") fail("WORKER_NOT_READY", "retiring worker admission cannot be renewed.");
        const admission = await probe(nodeCandidate(node), at.valueOf());
        node.admission = admission;
        node.updatedAt = at.toISOString();
        return {
          changed: true,
          event: { type: "node.renewed", payload: { nodeId, admissionDigest: admission.digest } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).nodes.find((candidate) => candidate.nodeId === nodeId),
        };
      }));
    },

    async switchRole(roleValue, nodeId, optionsValue = {}) {
      const role = safeRole(roleValue);
      if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) {
        fail("WORKER_DIRECTORY_INVALID", "worker switch nodeId is invalid.", { status: 400 });
      }
      const options = exactObject(optionsValue, ["expectedGeneration"], ["expectedGeneration"], "worker switch options");
      const expected = expectedGeneration(options.expectedGeneration);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const target = next.nodes.find((node) => node.nodeId === nodeId);
        if (!target || !target.roles.includes(role)) fail("WORKER_NOT_FOUND", "target worker does not provide the requested role.", { status: 404 });
        if (target.lifecycle !== "enrolled") fail("WORKER_NOT_READY", "target worker is retiring.", { status: 503 });
        const current = next.assignments.find((assignment) => assignment.role === role) ?? null;
        const generation = current?.generation ?? 0;
        if (generation !== expected) fail("WORKER_ASSIGNMENT_CONFLICT", "worker assignment generation changed.");
        if (current && current.previousNodeId !== null) {
          fail("WORKER_SWITCH_PENDING", "finalize or roll back the current worker switch before another switch.");
        }
        if (current?.nodeId === nodeId) return { changed: false, result: Object.freeze({ ...current }) };
        const admission = await probe(nodeCandidate(target), at.valueOf());
        target.admission = admission;
        target.updatedAt = at.toISOString();
        const assignment = {
          role,
          nodeId,
          previousNodeId: current?.nodeId ?? null,
          generation: generation + 1,
          switchedAt: at.toISOString(),
        };
        if (current) Object.assign(current, assignment);
        else next.assignments.push(assignment);
        return {
          changed: true,
          event: { type: "role.switched", payload: { role, nodeId, previousNodeId: assignment.previousNodeId, generation: assignment.generation, admissionDigest: admission.digest } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).assignments.find((item) => item.role === role),
        };
      }));
    },

    async rollbackRole(roleValue, optionsValue = {}) {
      const role = safeRole(roleValue);
      const options = exactObject(optionsValue, ["expectedGeneration"], ["expectedGeneration"], "worker rollback options");
      const expected = expectedGeneration(options.expectedGeneration);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const assignment = next.assignments.find((item) => item.role === role);
        if (!assignment || assignment.generation !== expected) fail("WORKER_ASSIGNMENT_CONFLICT", "worker assignment generation changed.");
        if (assignment.previousNodeId === null) fail("WORKER_ROLLBACK_UNAVAILABLE", "worker assignment has no rollback target.");
        const target = next.nodes.find((node) => node.nodeId === assignment.previousNodeId);
        if (!target || target.lifecycle !== "enrolled" || !target.roles.includes(role)) {
          fail("WORKER_ROLLBACK_UNAVAILABLE", "worker rollback target is unavailable.");
        }
        const admission = await probe(nodeCandidate(target), at.valueOf());
        target.admission = admission;
        target.updatedAt = at.toISOString();
        const source = assignment.nodeId;
        assignment.nodeId = target.nodeId;
        assignment.previousNodeId = source;
        assignment.generation += 1;
        assignment.switchedAt = at.toISOString();
        return {
          changed: true,
          event: { type: "role.rolledback", payload: { role, nodeId: target.nodeId, previousNodeId: source, generation: assignment.generation, admissionDigest: admission.digest } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).assignments.find((item) => item.role === role),
        };
      }));
    },

    async finalizeRole(roleValue, optionsValue = {}) {
      const role = safeRole(roleValue);
      const options = exactObject(optionsValue, ["expectedGeneration"], ["expectedGeneration"], "worker finalize options");
      const expected = expectedGeneration(options.expectedGeneration);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const assignment = next.assignments.find((item) => item.role === role);
        if (!assignment || assignment.generation !== expected) fail("WORKER_ASSIGNMENT_CONFLICT", "worker assignment generation changed.");
        if (assignment.previousNodeId === null) return { changed: false, result: Object.freeze({ ...assignment }) };
        if (next.leases.some((lease) => lease.role === role && lease.nodeId === assignment.previousNodeId)) {
          fail("WORKER_DRAIN_INCOMPLETE", "previous worker still owns live leases.");
        }
        const previousNodeId = assignment.previousNodeId;
        assignment.previousNodeId = null;
        return {
          changed: true,
          event: { type: "role.finalized", payload: { role, nodeId: assignment.nodeId, previousNodeId, generation: assignment.generation } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).assignments.find((item) => item.role === role),
        };
      }));
    },

    async resolve(roleValue) {
      const role = safeRole(roleValue);
      return locked(async (state, at) => {
        const assignment = state.assignments.find((item) => item.role === role);
        if (!assignment) fail("WORKER_ASSIGNMENT_UNAVAILABLE", "worker role has no assignment.", { status: 503 });
        const node = freshNode(state.nodes.find((candidate) => candidate.nodeId === assignment.nodeId), at.valueOf());
        return Object.freeze({
          role,
          nodeId: node.nodeId,
          bindingId: node.bindingId,
          generation: assignment.generation,
          admissionDigest: node.admission.digest,
        });
      });
    },

    async acquire(roleValue, ownerDigestValue, optionsValue = {}) {
      const role = safeRole(roleValue);
      const ownerDigest = safeDigest(ownerDigestValue, "worker lease ownerDigest");
      const options = exactObject(optionsValue, ["expectedGeneration", "ttlMs"], [], "worker lease options");
      const ttlMs = leaseLifetime(options.ttlMs);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        if (next.leases.length >= MAXIMUM_LEASES) fail("WORKER_DIRECTORY_CAPACITY_EXHAUSTED", "worker lease capacity is exhausted.", { status: 429 });
        const assignment = next.assignments.find((item) => item.role === role);
        if (!assignment) fail("WORKER_ASSIGNMENT_UNAVAILABLE", "worker role has no assignment.", { status: 503 });
        if (options.expectedGeneration !== undefined && expectedGeneration(options.expectedGeneration) !== assignment.generation) {
          fail("WORKER_ASSIGNMENT_CONFLICT", "worker assignment generation changed.");
        }
        const node = freshNode(next.nodes.find((candidate) => candidate.nodeId === assignment.nodeId), at.valueOf());
        const admissionExpiresMs = Date.parse(node.admission.expiresAt);
        const expiresMs = Math.min(at.valueOf() + ttlMs, admissionExpiresMs);
        if (expiresMs - at.valueOf() < 1_000) fail("WORKER_ADMISSION_STALE", "worker admission expires too soon for a lease.", { status: 503 });
        const leaseId = `lease_${randomToken(random, 16, "worker lease")}`;
        if (next.leases.some((lease) => lease.leaseId === leaseId)) {
          fail("WORKER_DIRECTORY_RANDOM_INVALID", "worker lease random source repeated an identifier.", { status: 503 });
        }
        const lease = {
          leaseId,
          role,
          nodeId: node.nodeId,
          assignmentGeneration: assignment.generation,
          ownerDigest,
          acquiredAt: at.toISOString(),
          expiresAt: new Date(expiresMs).toISOString(),
        };
        next.leases.push(lease);
        return { changed: true, resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).leases.find(({ leaseId }) => leaseId === lease.leaseId) };
      }));
    },

    async renewLease(leaseId, ownerDigestValue, optionsValue = {}) {
      if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) fail("WORKER_DIRECTORY_INVALID", "worker leaseId is invalid.", { status: 400 });
      const ownerDigest = safeDigest(ownerDigestValue, "worker lease ownerDigest");
      const options = exactObject(optionsValue, ["ttlMs"], [], "worker lease renewal options");
      const ttlMs = leaseLifetime(options.ttlMs);
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const lease = next.leases.find((candidate) => candidate.leaseId === leaseId);
        if (!lease || lease.ownerDigest !== ownerDigest) fail("WORKER_LEASE_NOT_FOUND", "worker lease is unavailable.", { status: 404 });
        const node = next.nodes.find((candidate) => candidate.nodeId === lease.nodeId);
        if (!node) fail("WORKER_LEASE_NOT_FOUND", "worker lease node is unavailable.", { status: 404 });
        const expiresMs = Math.min(at.valueOf() + ttlMs, Date.parse(node.admission.expiresAt));
        if (expiresMs - at.valueOf() < 1_000) fail("WORKER_ADMISSION_STALE", "worker admission expires too soon to renew the lease.", { status: 503 });
        lease.expiresAt = new Date(expiresMs).toISOString();
        return { changed: true, resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).leases.find((candidate) => candidate.leaseId === leaseId) };
      }));
    },

    async releaseLease(leaseId, ownerDigestValue) {
      if (typeof leaseId !== "string" || !LEASE_ID.test(leaseId)) fail("WORKER_DIRECTORY_INVALID", "worker leaseId is invalid.", { status: 400 });
      const ownerDigest = safeDigest(ownerDigestValue, "worker lease ownerDigest");
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const index = next.leases.findIndex((lease) => lease.leaseId === leaseId && lease.ownerDigest === ownerDigest);
        if (index < 0) fail("WORKER_LEASE_NOT_FOUND", "worker lease is unavailable.", { status: 404 });
        next.leases.splice(index, 1);
        return { changed: true, result: Object.freeze({ released: true, leaseId }) };
      }));
    },

    async retire(nodeId) {
      if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) fail("WORKER_DIRECTORY_INVALID", "worker nodeId is invalid.", { status: 400 });
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const node = next.nodes.find((candidate) => candidate.nodeId === nodeId);
        if (!node) fail("WORKER_NOT_FOUND", "worker node is not enrolled.", { status: 404 });
        if (next.assignments.some((assignment) => assignment.nodeId === nodeId || assignment.previousNodeId === nodeId) ||
            next.leases.some((lease) => lease.nodeId === nodeId)) {
          fail("WORKER_DRAIN_INCOMPLETE", "worker node is still assigned or leased.");
        }
        if (node.lifecycle === "retiring") return { changed: false, result: Object.freeze({ ...node }) };
        node.lifecycle = "retiring";
        node.updatedAt = at.toISOString();
        return {
          changed: true,
          event: { type: "node.retiring", payload: { nodeId } },
          resultFactory: (sealed) => publicSnapshot(sealed, at.valueOf()).nodes.find((candidate) => candidate.nodeId === nodeId),
        };
      }));
    },

    async remove(nodeId) {
      if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) fail("WORKER_DIRECTORY_INVALID", "worker nodeId is invalid.", { status: 400 });
      return locked(async (state, at) => writeMutation(state, at, async (next) => {
        const index = next.nodes.findIndex((candidate) => candidate.nodeId === nodeId);
        if (index < 0) fail("WORKER_NOT_FOUND", "worker node is not enrolled.", { status: 404 });
        const node = next.nodes[index];
        if (node.lifecycle !== "retiring" ||
            next.assignments.some((assignment) => assignment.nodeId === nodeId || assignment.previousNodeId === nodeId) ||
            next.leases.some((lease) => lease.nodeId === nodeId)) {
          fail("WORKER_DRAIN_INCOMPLETE", "worker node must be unassigned, unleased, and retiring before removal.");
        }
        next.nodes.splice(index, 1);
        return {
          changed: true,
          event: { type: "node.removed", payload: { nodeId, bindingId: node.bindingId } },
          result: Object.freeze({ removed: true, nodeId }),
        };
      }));
    },
  });
  DIRECTORY_BRAND.add(directory);
  return directory;
}

export function assertIntegrationWorkerDirectory(value) {
  if (!value || !DIRECTORY_BRAND.has(value)) throw new TypeError("worker directory is not AgInTi-owned");
  return value;
}

export function createWorkerAdmission(candidateValue, value) {
  const candidate = normalizeCandidate(candidateValue);
  const input = exactObject(
    value,
    ["transport", "releaseId", "releaseDigest", "capabilitiesDigest", "canaryDigest", "protocols", "observedAt", "expiresAt"],
    ["transport", "releaseId", "releaseDigest", "capabilitiesDigest", "canaryDigest", "protocols", "observedAt", "expiresAt"],
    "worker admission input"
  );
  const unsigned = {
    schemaVersion: INTEGRATION_WORKER_ADMISSION_SCHEMA_VERSION,
    nodeId: candidate.nodeId,
    bindingId: candidate.bindingId,
    roles: candidate.roles,
    transport: input.transport,
    releaseId: input.releaseId,
    releaseDigest: input.releaseDigest,
    capabilitiesDigest: input.capabilitiesDigest,
    canaryDigest: input.canaryDigest,
    protocols: input.protocols,
    ready: true,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
  };
  const provisional = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  return validateAdmission(provisional, candidate, Date.parse(input.observedAt));
}
