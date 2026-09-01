import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  IntegrationAuthorityError,
  fsyncDirectory,
  parseIsoMs,
  randomHex,
  reconcileProtectedJsonTemporaryFiles,
  withDirectoryLock,
} from "./integration-durable-common.js";
import { canonicalJson, contractDigest } from "./integration-policy.js";

export const INTEGRATION_COMPUTE_NODE_AUTHORITY_VERSION = "aginti-compute-node-authority-v1";
export const INTEGRATION_COMPUTE_NODE_STATE_VERSION = "aginti-compute-node-authority-state-v1";
export const INTEGRATION_COMPUTE_NODE_EVIDENCE_VERSION = "aginti-compute-node-capability-evidence-v1";
export const INTEGRATION_COMPUTE_NODE_RECORD_VERSION = "aginti-compute-node-record-v1";
export const INTEGRATION_COMPUTE_NODE_ASSIGNMENT_VERSION = "aginti-compute-node-assignment-v1";
export const INTEGRATION_COMPUTE_NODE_LEASE_VERSION = "aginti-compute-node-lease-v1";
export const INTEGRATION_COMPUTE_NODE_ATTESTATION_VERSION = "aginti-compute-node-authority-attestation-v1";

const STATE_FILE = "compute-nodes.json";
const LOCK_DIR = "compute-nodes.lock";
const MAXIMUM_STATE_BYTES = 256 * 1024;
const MAXIMUM_NODES = 256;
const MAXIMUM_ASSIGNMENTS = 64;
const MAXIMUM_LEASES = 4096;
const MAXIMUM_EVIDENCE_TTL_MS = 5 * 60 * 1000;
const MINIMUM_EVIDENCE_CLOCK_SKEW_MS = 60 * 1000;
const AUTHORITY_ROLE = "compute-node-authority";
const DIGEST = /^[a-f0-9]{64}$/u;
const WORKER_ID = /^worker_[A-Za-z0-9_-]{24,96}$/u;
const ROLE = /^[a-z][a-z0-9._:-]{2,63}$/u;
const LEASE_ID = /^lease_[A-Za-z0-9_-]{16,96}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SAFE_STATE_MODES = new Set([0o600]);
const SAFE_ROOT_MODE = 0o700;
const AUTHORITY_BRAND = new WeakSet();
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ReflectOwnKeys = Reflect.ownKeys;
const ArrayIsArray = Array.isArray;
const BufferByteLength = Buffer.byteLength;
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);

function fail(code, message, { status = 503, details = {}, cause } = {}) {
  const error = new IntegrationAuthorityError(code, message, { status, details });
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  throw error;
}

function invalid(message, details = {}) {
  fail("COMPUTE_NODE_AUTHORITY_INVALID", message, { status: 400, details });
}

function corrupt(message, cause) {
  fail("COMPUTE_NODE_AUTHORITY_CORRUPT", message, { status: 503, cause });
}

function unavailable(message, cause) {
  fail("COMPUTE_NODE_AUTHORITY_UNAVAILABLE", message, { status: 503, cause });
}

function conflict(message, details = {}) {
  fail("COMPUTE_NODE_CAS_CONFLICT", message, { status: 409, details });
}

function notFound(message = "Compute node was not found.") {
  fail("COMPUTE_NODE_NOT_FOUND", message, { status: 404 });
}

function closeObject(value) {
  if (!value || typeof value !== "object") return value;
  if (ArrayIsArray(value)) {
    for (let index = 0; index < value.length; index += 1) closeObject(value[index]);
  } else {
    for (const key of ObjectKeys(value)) closeObject(value[key]);
  }
  return Object.freeze(value);
}

function cloneStrictJson(value, label, depth = 0) {
  if (depth > 32) invalid(`${label} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return value;
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    invalid(`${label} must be strict JSON data`);
  }
  if (utilTypes.isProxy(value)) invalid(`${label} must not be a Proxy`);
  if (ArrayIsArray(value)) {
    if (ObjectGetPrototypeOf(value) !== Array.prototype) invalid(`${label} must be a plain array`);
    const own = ReflectOwnKeys(value);
    const lengthDescriptor = ObjectGetOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || lengthDescriptor.enumerable || !ObjectHasOwn(lengthDescriptor, "value")) {
      invalid(`${label} array length descriptor is invalid`);
    }
    if (own.length !== value.length + 1 || !own.includes("length")) {
      invalid(`${label} must be a dense JSON array`);
    }
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      if (!ObjectHasOwn(value, key)) invalid(`${label} must not be sparse`);
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, "value")) {
        invalid(`${label} must contain only enumerable data items`);
      }
      out.push(cloneStrictJson(descriptor.value, `${label}[${index}]`, depth + 1));
    }
    return closeObject(out);
  }
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const own = ReflectOwnKeys(value);
  const keys = ObjectKeys(value);
  if (own.length !== keys.length) invalid(`${label} must not contain symbols or non-enumerable fields`);
  const out = {};
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || key === "then") {
      invalid(`${label} contains a forbidden field`);
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, "value")) {
      invalid(`${label} must contain only enumerable data fields`);
    }
    out[key] = cloneStrictJson(descriptor.value, `${label}.${key}`, depth + 1);
  }
  return closeObject(out);
}

function exactObject(value, keys, label) {
  const object = cloneStrictJson(value, label);
  if (!object || typeof object !== "object" || ArrayIsArray(object)) invalid(`${label} must be an object`);
  const own = ObjectKeys(object);
  const expected = new Set(keys);
  if (own.length !== keys.length || own.some((key) => !expected.has(key))) {
    invalid(`${label} fields are invalid`);
  }
  return object;
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== "string") invalid(`${label} must be a timestamp`);
  const ms = parseIsoMs(value, label);
  return { value, ms };
}

function assertNullableTimestamp(value, label) {
  if (value === null) return value;
  assertCanonicalTimestamp(value, label);
  return value;
}

function assertDigestValue(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${label} is invalid`);
  return value;
}

function assertWorkerId(value, label = "workerId") {
  if (typeof value !== "string" || !WORKER_ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function assertRole(value, label = "role") {
  if (typeof value !== "string" || !ROLE.test(value)) invalid(`${label} is invalid`);
  return value;
}

function assertLeaseId(value, label = "leaseId") {
  if (typeof value !== "string" || !LEASE_ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function assertRunId(value, label = "runId") {
  if (typeof value !== "string" || !RUN_ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function assertRevision(value, label = "revision", { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} is invalid`);
  return value;
}

function digestRecord(unsigned) {
  return contractDigest(unsigned);
}

function sealRecord(unsigned) {
  return closeObject({ ...unsigned, digest: digestRecord(unsigned) });
}

function unsigned(record) {
  const { digest: _digest, ...rest } = record;
  return rest;
}

function evidenceUnsigned(record) {
  const {
    evidenceDigest: _evidenceDigest,
    ...rest
  } = record;
  return rest;
}

function sortBy(values, key) {
  return [...values].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function buildState(unsignedState) {
  const nodes = sortBy(unsignedState.nodes, "workerId");
  const assignments = sortBy(unsignedState.assignments, "role");
  const leases = sortBy(unsignedState.leases, "leaseId");
  return sealRecord({
    schemaVersion: INTEGRATION_COMPUTE_NODE_STATE_VERSION,
    revision: unsignedState.revision,
    nodes,
    assignments,
    leases,
    updatedAt: unsignedState.updatedAt,
  });
}

function initialState() {
  return buildState({
    revision: 0,
    nodes: Object.freeze([]),
    assignments: Object.freeze([]),
    leases: Object.freeze([]),
    updatedAt: null,
  });
}

function assertRecordDigest(record, label) {
  const expected = digestRecord(unsigned(record));
  if (record.digest !== expected) corrupt(`${label} digest is invalid.`);
}

function validateEvidence(value, { nowMs = Date.now(), label = "compute node evidence" } = {}) {
  const record = exactObject(value, [
    "schemaVersion",
    "workerId",
    "role",
    "releaseDigest",
    "capabilityDigest",
    "healthDigest",
    "admitted",
    "observedAt",
    "expiresAt",
    "evidenceDigest",
  ], label);
  if (record.schemaVersion !== INTEGRATION_COMPUTE_NODE_EVIDENCE_VERSION) invalid(`${label} schema is unsupported`);
  assertWorkerId(record.workerId, `${label}.workerId`);
  assertRole(record.role, `${label}.role`);
  assertDigestValue(record.releaseDigest, `${label}.releaseDigest`);
  assertDigestValue(record.capabilityDigest, `${label}.capabilityDigest`);
  assertDigestValue(record.healthDigest, `${label}.healthDigest`);
  if (record.admitted !== true) invalid(`${label} is not admitted`);
  const observed = assertCanonicalTimestamp(record.observedAt, `${label}.observedAt`);
  const expires = assertCanonicalTimestamp(record.expiresAt, `${label}.expiresAt`);
  if (observed.ms - nowMs > MINIMUM_EVIDENCE_CLOCK_SKEW_MS || expires.ms <= nowMs) {
    fail("COMPUTE_NODE_EVIDENCE_STALE", "Compute node capability evidence is stale.", { status: 409 });
  }
  if (expires.ms <= observed.ms || expires.ms - observed.ms > MAXIMUM_EVIDENCE_TTL_MS) {
    fail("COMPUTE_NODE_EVIDENCE_STALE", "Compute node capability evidence lifetime is invalid.", { status: 409 });
  }
  if (record.evidenceDigest !== contractDigest(evidenceUnsigned(record))) {
    invalid(`${label}.evidenceDigest does not match`);
  }
  return record;
}

function validateStoredNode(value) {
  const node = exactObject(value, [
    "schemaVersion",
    "workerId",
    "role",
    "releaseDigest",
    "capabilityDigest",
    "healthDigest",
    "evidenceDigest",
    "status",
    "fencingEpoch",
    "enrolledAt",
    "updatedAt",
    "drainingAt",
    "removedAt",
    "digest",
  ], "stored compute node");
  if (node.schemaVersion !== INTEGRATION_COMPUTE_NODE_RECORD_VERSION) corrupt("Stored compute node schema is unsupported.");
  assertWorkerId(node.workerId, "stored compute node workerId");
  assertRole(node.role, "stored compute node role");
  for (const key of ["releaseDigest", "capabilityDigest", "healthDigest", "evidenceDigest"]) {
    assertDigestValue(node[key], `stored compute node ${key}`);
  }
  if (!["admitted", "draining", "removed"].includes(node.status)) corrupt("Stored compute node status is invalid.");
  assertRevision(node.fencingEpoch, "stored compute node fencingEpoch");
  assertCanonicalTimestamp(node.enrolledAt, "stored compute node enrolledAt");
  assertCanonicalTimestamp(node.updatedAt, "stored compute node updatedAt");
  assertNullableTimestamp(node.drainingAt, "stored compute node drainingAt");
  assertNullableTimestamp(node.removedAt, "stored compute node removedAt");
  if ((node.status === "draining") !== (node.drainingAt !== null && node.removedAt === null)) {
    corrupt("Stored compute node draining lifecycle is invalid.");
  }
  if ((node.status === "removed") !== (node.removedAt !== null)) {
    corrupt("Stored compute node removed lifecycle is invalid.");
  }
  if (node.status === "admitted" && (node.drainingAt !== null || node.removedAt !== null)) {
    corrupt("Stored compute node admitted lifecycle is invalid.");
  }
  assertRecordDigest(node, "Stored compute node");
  return node;
}

function validateStoredAssignment(value) {
  const assignment = exactObject(value, [
    "schemaVersion",
    "role",
    "workerId",
    "fencingEpoch",
    "assignedAt",
    "updatedAt",
    "digest",
  ], "stored compute node assignment");
  if (assignment.schemaVersion !== INTEGRATION_COMPUTE_NODE_ASSIGNMENT_VERSION) {
    corrupt("Stored compute node assignment schema is unsupported.");
  }
  assertRole(assignment.role, "stored assignment role");
  assertWorkerId(assignment.workerId, "stored assignment workerId");
  assertRevision(assignment.fencingEpoch, "stored assignment fencingEpoch", { minimum: 1 });
  assertCanonicalTimestamp(assignment.assignedAt, "stored assignment assignedAt");
  assertCanonicalTimestamp(assignment.updatedAt, "stored assignment updatedAt");
  assertRecordDigest(assignment, "Stored compute node assignment");
  return assignment;
}

function validateStoredLease(value) {
  const lease = exactObject(value, [
    "schemaVersion",
    "leaseId",
    "runId",
    "role",
    "workerId",
    "fencingEpoch",
    "claimedAt",
    "expiresAt",
    "releasedAt",
    "digest",
  ], "stored compute node lease");
  if (lease.schemaVersion !== INTEGRATION_COMPUTE_NODE_LEASE_VERSION) {
    corrupt("Stored compute node lease schema is unsupported.");
  }
  assertLeaseId(lease.leaseId, "stored lease leaseId");
  assertRunId(lease.runId, "stored lease runId");
  assertRole(lease.role, "stored lease role");
  assertWorkerId(lease.workerId, "stored lease workerId");
  assertRevision(lease.fencingEpoch, "stored lease fencingEpoch", { minimum: 1 });
  assertCanonicalTimestamp(lease.claimedAt, "stored lease claimedAt");
  assertCanonicalTimestamp(lease.expiresAt, "stored lease expiresAt");
  assertNullableTimestamp(lease.releasedAt, "stored lease releasedAt");
  const claimed = parseIsoMs(lease.claimedAt, "stored lease claimedAt");
  const expires = parseIsoMs(lease.expiresAt, "stored lease expiresAt");
  if (expires <= claimed) corrupt("Stored compute node lease time range is invalid.");
  assertRecordDigest(lease, "Stored compute node lease");
  return lease;
}

function validateStoredState(value) {
  const state = exactObject(value, [
    "schemaVersion",
    "revision",
    "nodes",
    "assignments",
    "leases",
    "updatedAt",
    "digest",
  ], "compute node state");
  if (state.schemaVersion !== INTEGRATION_COMPUTE_NODE_STATE_VERSION) {
    corrupt("Compute node state schema is unsupported.");
  }
  assertRevision(state.revision, "compute node state revision");
  if (state.updatedAt !== null) assertCanonicalTimestamp(state.updatedAt, "compute node state updatedAt");
  if (!ArrayIsArray(state.nodes) || state.nodes.length > MAXIMUM_NODES) corrupt("Compute node list is invalid.");
  if (!ArrayIsArray(state.assignments) || state.assignments.length > MAXIMUM_ASSIGNMENTS) {
    corrupt("Compute node assignment list is invalid.");
  }
  if (!ArrayIsArray(state.leases) || state.leases.length > MAXIMUM_LEASES) corrupt("Compute node lease list is invalid.");
  const nodes = state.nodes.map(validateStoredNode);
  const assignments = state.assignments.map(validateStoredAssignment);
  const leases = state.leases.map(validateStoredLease);
  const nodeIds = new Set(nodes.map(({ workerId }) => workerId));
  const roles = new Set(assignments.map(({ role }) => role));
  const leaseIds = new Set(leases.map(({ leaseId }) => leaseId));
  if (nodeIds.size !== nodes.length || roles.size !== assignments.length || leaseIds.size !== leases.length) {
    corrupt("Compute node state has duplicate identities.");
  }
  if (contractDigest(nodes.map(({ workerId }) => workerId)) !== contractDigest(sortBy(nodes, "workerId").map(({ workerId }) => workerId))) {
    corrupt("Compute node records are not sorted.");
  }
  if (contractDigest(assignments.map(({ role }) => role)) !== contractDigest(sortBy(assignments, "role").map(({ role }) => role))) {
    corrupt("Compute node assignments are not sorted.");
  }
  if (contractDigest(leases.map(({ leaseId }) => leaseId)) !== contractDigest(sortBy(leases, "leaseId").map(({ leaseId }) => leaseId))) {
    corrupt("Compute node leases are not sorted.");
  }
  for (const assignment of assignments) {
    const node = nodes.find((candidate) => candidate.workerId === assignment.workerId);
    if (!node || node.role !== assignment.role || node.status === "removed") {
      corrupt("Compute node assignment references an unavailable node.");
    }
    if (node.fencingEpoch !== assignment.fencingEpoch) corrupt("Compute node assignment fencing diverged.");
  }
  for (const lease of leases) {
    const node = nodes.find((candidate) => candidate.workerId === lease.workerId);
    if (!node || node.role !== lease.role) {
      corrupt("Compute node lease references an unavailable node.");
    }
    if (node.status === "removed" && lease.releasedAt === null) corrupt("Compute node active lease references a removed node.");
    if (node.fencingEpoch < lease.fencingEpoch) corrupt("Compute node lease fencing diverged.");
  }
  assertRecordDigest(state, "Compute node state");
  return state;
}

function stateSummary(state) {
  const activeLeases = state.leases.filter((lease) => lease.releasedAt === null).length;
  const unsignedSummary = {
    schemaVersion: "aginti-compute-node-authority-summary-v1",
    revision: state.revision,
    stateDigest: state.digest,
    nodes: state.nodes.map((node) => Object.freeze({
      workerId: node.workerId,
      role: node.role,
      status: node.status,
      fencingEpoch: node.fencingEpoch,
      releaseDigest: node.releaseDigest,
      capabilityDigest: node.capabilityDigest,
      healthDigest: node.healthDigest,
      evidenceDigest: node.evidenceDigest,
    })),
    assignments: state.assignments.map((assignment) => Object.freeze({
      role: assignment.role,
      workerId: assignment.workerId,
      fencingEpoch: assignment.fencingEpoch,
      assignmentDigest: assignment.digest,
    })),
    activeLeaseCount: activeLeases,
  };
  return closeObject({ ...unsignedSummary, digest: contractDigest(unsignedSummary) });
}

function publicNode(node) {
  return closeObject({
    schemaVersion: "aginti-compute-node-public-v1",
    workerId: node.workerId,
    role: node.role,
    status: node.status,
    fencingEpoch: node.fencingEpoch,
    releaseDigest: node.releaseDigest,
    capabilityDigest: node.capabilityDigest,
    healthDigest: node.healthDigest,
    evidenceDigest: node.evidenceDigest,
    enrolledAt: node.enrolledAt,
    updatedAt: node.updatedAt,
    digest: node.digest,
  });
}

function publicAssignment(assignment) {
  if (assignment === null) return null;
  return closeObject({
    schemaVersion: "aginti-compute-node-public-assignment-v1",
    role: assignment.role,
    workerId: assignment.workerId,
    fencingEpoch: assignment.fencingEpoch,
    assignedAt: assignment.assignedAt,
    updatedAt: assignment.updatedAt,
    digest: assignment.digest,
  });
}

function publicLease(lease) {
  return closeObject({
    schemaVersion: "aginti-compute-node-public-lease-v1",
    leaseId: lease.leaseId,
    runId: lease.runId,
    role: lease.role,
    workerId: lease.workerId,
    fencingEpoch: lease.fencingEpoch,
    claimedAt: lease.claimedAt,
    expiresAt: lease.expiresAt,
    releasedAt: lease.releasedAt,
    digest: lease.digest,
  });
}

function nowText(now) {
  const value = now().toISOString();
  parseIsoMs(value, "compute node timestamp");
  return value;
}

function ensureCanonicalRootPath(rootPath) {
  if (typeof rootPath !== "string" || rootPath.length < 2 || rootPath.includes("\0")) {
    invalid("compute node stateRoot is invalid");
  }
  if (path.resolve(rootPath) !== rootPath) invalid("compute node stateRoot must be an exact absolute path");
  return rootPath;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function currentGid() {
  return typeof process.getgid === "function" ? process.getgid() : null;
}

async function verifyRoot(rootPath, { ownerUid, ownerGid }) {
  let link;
  try {
    link = await fs.lstat(rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") unavailable("Compute node state root does not exist.", error);
    throw error;
  }
  if (link.isSymbolicLink()) unavailable("Compute node state root must not be a symlink.");
  const real = await fs.realpath(rootPath).catch((error) => {
    unavailable("Compute node state root cannot be resolved.", error);
  });
  if (real !== rootPath) unavailable("Compute node state root must be canonical.");
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) unavailable("Compute node state root must be a directory.");
  if (stat.uid !== ownerUid || stat.gid !== ownerGid) unavailable("Compute node state root owner is invalid.");
  if ((stat.mode & 0o7777) !== SAFE_ROOT_MODE) unavailable("Compute node state root mode must be exactly 0700.");
  if (!Number.isSafeInteger(stat.nlink) || stat.nlink < 2) unavailable("Compute node state root link count is invalid.");
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
  });
}

function sameRootIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.uid === right.uid &&
      left.gid === right.gid &&
      left.mode === right.mode
  );
}

function verifyStateFileStat(stat, label, { ownerUid, ownerGid }) {
  if (!stat.isFile()) corrupt(`${label} must be a regular file.`);
  if (stat.uid !== ownerUid || stat.gid !== ownerGid) corrupt(`${label} owner is invalid.`);
  if (stat.nlink !== 1) corrupt(`${label} must not have hard links.`);
  if (!SAFE_STATE_MODES.has(stat.mode & 0o7777)) corrupt(`${label} mode must be exactly 0600.`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAXIMUM_STATE_BYTES) {
    corrupt(`${label} size is invalid.`);
  }
}

async function readStateFile(stateFile, expected) {
  let named;
  try {
    named = await fs.lstat(stateFile);
  } catch (error) {
    if (error?.code === "ENOENT") return initialState();
    throw error;
  }
  if (named.isSymbolicLink()) corrupt("Compute node state file must not be a symlink.");
  verifyStateFileStat(named, "Compute node state file", expected);
  let handle;
  try {
    handle = await fs.open(stateFile, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    const opened = await handle.stat();
    verifyStateFileStat(opened, "Compute node state file", expected);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) {
      corrupt("Compute node state file changed while it was opened.");
    }
    const raw = await handle.readFile("utf8");
    if (BufferByteLength(raw, "utf8") !== opened.size) corrupt("Compute node state file byte size changed.");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      corrupt("Compute node state file contains corrupt JSON.", error);
    }
    return validateStoredState(parsed);
  } catch (error) {
    if (error?.code === "ELOOP") corrupt("Compute node state file must not be a symlink.", error);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeStateFile(stateFile, state) {
  const dir = path.dirname(stateFile);
  const temporaryPath = path.join(dir, `.${path.basename(stateFile)}.${process.pid}.${randomHex(8)}.tmp`);
  const bytes = `${canonicalJson(state)}\n`;
  if (BufferByteLength(bytes, "utf8") > MAXIMUM_STATE_BYTES) {
    fail("COMPUTE_NODE_STATE_LIMIT", "Compute node authority state exceeds its byte limit.", { status: 503 });
  }
  let handle;
  let complete = false;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0o600
    );
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, stateFile);
    complete = true;
    await fsyncDirectory(dir);
  } finally {
    await handle?.close().catch(() => {});
    if (!complete) await fs.unlink(temporaryPath).catch(() => {});
  }
}

function buildNodeFromEvidence(evidence, timestamp) {
  return sealRecord({
    schemaVersion: INTEGRATION_COMPUTE_NODE_RECORD_VERSION,
    workerId: evidence.workerId,
    role: evidence.role,
    releaseDigest: evidence.releaseDigest,
    capabilityDigest: evidence.capabilityDigest,
    healthDigest: evidence.healthDigest,
    evidenceDigest: evidence.evidenceDigest,
    status: "admitted",
    fencingEpoch: 0,
    enrolledAt: timestamp,
    updatedAt: timestamp,
    drainingAt: null,
    removedAt: null,
  });
}

function sameImmutableNode(node, evidence) {
  return (
    node.workerId === evidence.workerId &&
    node.role === evidence.role &&
    node.releaseDigest === evidence.releaseDigest &&
    node.capabilityDigest === evidence.capabilityDigest &&
    node.healthDigest === evidence.healthDigest &&
    node.evidenceDigest === evidence.evidenceDigest
  );
}

function findNode(state, workerId) {
  return state.nodes.find((node) => node.workerId === workerId) || null;
}

function findAssignment(state, role) {
  return state.assignments.find((assignment) => assignment.role === role) || null;
}

function findLease(state, leaseId) {
  return state.leases.find((lease) => lease.leaseId === leaseId) || null;
}

function updateNode(state, node) {
  const nodes = state.nodes.map((candidate) => candidate.workerId === node.workerId ? node : candidate);
  return buildState({ ...unsigned(state), nodes, revision: state.revision + 1, updatedAt: node.updatedAt });
}

function replaceLease(state, lease, timestamp) {
  const leases = [
    ...state.leases.filter((candidate) => candidate.leaseId !== lease.leaseId),
    lease,
  ];
  return buildState({ ...unsigned(state), leases, revision: state.revision + 1, updatedAt: timestamp });
}

function removeNodeRecord(state, node, timestamp) {
  const nodes = state.nodes.map((candidate) => candidate.workerId === node.workerId ? node : candidate);
  return buildState({ ...unsigned(state), nodes, revision: state.revision + 1, updatedAt: timestamp });
}

function activeLeasesForWorker(state, workerId) {
  return state.leases.filter((lease) => lease.workerId === workerId && lease.releasedAt === null);
}

function makeEvidenceUnsigned(input) {
  const candidate = exactObject(input, [
    "schemaVersion",
    "workerId",
    "role",
    "releaseDigest",
    "capabilityDigest",
    "healthDigest",
    "admitted",
    "observedAt",
    "expiresAt",
  ], "compute node evidence input");
  if (candidate.schemaVersion !== INTEGRATION_COMPUTE_NODE_EVIDENCE_VERSION) {
    invalid("compute node evidence schema is unsupported");
  }
  assertWorkerId(candidate.workerId);
  assertRole(candidate.role);
  assertDigestValue(candidate.releaseDigest, "releaseDigest");
  assertDigestValue(candidate.capabilityDigest, "capabilityDigest");
  assertDigestValue(candidate.healthDigest, "healthDigest");
  if (candidate.admitted !== true) invalid("compute node evidence must be admitted");
  assertCanonicalTimestamp(candidate.observedAt, "observedAt");
  assertCanonicalTimestamp(candidate.expiresAt, "expiresAt");
  return candidate;
}

export function buildComputeNodeCapabilityEvidence(input = {}) {
  const unsignedEvidence = makeEvidenceUnsigned(input);
  return closeObject({ ...unsignedEvidence, evidenceDigest: contractDigest(unsignedEvidence) });
}

export function validateComputeNodeCapabilityEvidence(value, options = {}) {
  return validateEvidence(value, options);
}

function buildAttestation({ stateRoot, ownerUid, ownerGid, rootIdentity }) {
  const unsignedAttestation = {
    schemaVersion: INTEGRATION_COMPUTE_NODE_ATTESTATION_VERSION,
    authority: "aginti",
    owner: "aginti",
    role: AUTHORITY_ROLE,
    durable: true,
    explicitEnrollmentOnly: true,
    callerSuppliedEvidenceRequired: true,
    immutableIdentityFields: Object.freeze(["workerId", "role", "releaseDigest", "capabilityDigest", "healthDigest"]),
    lifecycle: Object.freeze(["admitted", "draining", "removed"]),
    assignmentCas: true,
    fencingEpoch: true,
    oneActiveAssignmentPerRole: true,
    discovery: false,
    secrets: false,
    publicEndpoints: false,
    stateRootDigest: contractDigest({ stateRoot }),
    rootIdentityDigest: contractDigest(rootIdentity),
    ownerUid,
    ownerGid,
    maximumNodes: MAXIMUM_NODES,
    maximumAssignments: MAXIMUM_ASSIGNMENTS,
    maximumLeases: MAXIMUM_LEASES,
    maximumStateBytes: MAXIMUM_STATE_BYTES,
  };
  return closeObject({ ...unsignedAttestation, digest: contractDigest(unsignedAttestation) });
}

function normalizeOpenOptions(input = {}) {
  if (!input || typeof input !== "object" || ArrayIsArray(input) || utilTypes.isProxy(input)) {
    invalid("compute node authority options must be a plain object");
  }
  const prototype = ObjectGetPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid("compute node authority options must be a plain object");
  const allowed = new Set(["stateRoot", "ownerUid", "ownerGid", "now"]);
  const values = { ownerUid: null, ownerGid: null, now: null };
  for (const key of ReflectOwnKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) invalid("compute node authority options fields are invalid");
    const descriptor = ObjectGetOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, "value")) invalid("compute node authority options must be data-only");
    values[key] = descriptor.value;
  }
  if (!ObjectHasOwn(values, "stateRoot") && !ObjectHasOwn(input, "stateRoot")) {
    invalid("compute node stateRoot is required");
  }
  const ownerUid = values.ownerUid === null ? currentUid() : values.ownerUid;
  const ownerGid = values.ownerGid === null ? currentGid() : values.ownerGid;
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) invalid("compute node ownerUid is invalid");
  if (!Number.isSafeInteger(ownerGid) || ownerGid < 0) invalid("compute node ownerGid is invalid");
  if (values.now !== null && typeof values.now !== "function") invalid("compute node now must be a function");
  return Object.freeze({
    stateRoot: ensureCanonicalRootPath(values.stateRoot),
    ownerUid,
    ownerGid,
    now: values.now || (() => new Date()),
  });
}

function operationInput(value, keys, label) {
  return exactObject(value, keys, label);
}

function assertExpectedRevision(value, current, label) {
  assertRevision(value, label);
  if (value !== current) conflict(`${label} does not match current revision.`, { expected: current, received: value });
}

export async function openIntegrationComputeNodeAuthority(input = {}) {
  const options = normalizeOpenOptions(input);
  const firstRootIdentity = await verifyRoot(options.stateRoot, options);
  const stateFile = path.join(options.stateRoot, STATE_FILE);
  const lockDir = path.join(options.stateRoot, LOCK_DIR);
  let closed = false;
  let closing = false;
  let inFlight = 0;
  let closeWaiters = [];
  const rootIdentity = firstRootIdentity;
  const attestation = buildAttestation({ ...options, rootIdentity });

  function admit(label) {
    if (closed || closing) fail("COMPUTE_NODE_AUTHORITY_CLOSED", `Compute node authority is closed before ${label}.`, { status: 503 });
    inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      if (inFlight === 0) {
        const waiters = closeWaiters;
        closeWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    };
  }

  async function loadState() {
    const currentRoot = await verifyRoot(options.stateRoot, options);
    if (!sameRootIdentity(rootIdentity, currentRoot)) unavailable("Compute node state root identity changed.");
    await reconcileProtectedJsonTemporaryFiles(stateFile, {
      maxBytes: MAXIMUM_STATE_BYTES,
      exclusiveAuthority: true,
    });
    return readStateFile(stateFile, options);
  }

  async function writeState(state) {
    const currentRoot = await verifyRoot(options.stateRoot, options);
    if (!sameRootIdentity(rootIdentity, currentRoot)) unavailable("Compute node state root identity changed.");
    await writeStateFile(stateFile, state);
    const afterRoot = await verifyRoot(options.stateRoot, options);
    if (!sameRootIdentity(rootIdentity, afterRoot)) unavailable("Compute node state root identity changed after write.");
  }

  async function transact(label, fn) {
    const release = admit(label);
    try {
      return await withDirectoryLock(lockDir, async () => {
        const state = await loadState();
        const result = await fn(state);
        if (result?.state) await writeState(result.state);
        return result?.value;
      }, { requireValidatedOwnerForRecovery: true });
    } finally {
      release();
    }
  }

  const authority = closeObject({
    schemaVersion: INTEGRATION_COMPUTE_NODE_AUTHORITY_VERSION,
    attestation,

    inspect() {
      return transact("inspect", async (state) => ({ value: stateSummary(state) }));
    },

    enrollNode(evidenceValue) {
      const evidence = validateEvidence(evidenceValue, { nowMs: options.now().getTime() });
      return transact("enrollNode", async (state) => {
        const timestamp = nowText(options.now);
        const existing = findNode(state, evidence.workerId);
        if (existing) {
          if (existing.status === "removed") fail("COMPUTE_NODE_REMOVED", "Removed compute node identity cannot be resurrected.", { status: 410 });
          if (!sameImmutableNode(existing, evidence)) conflict("Compute node immutable evidence changed.");
          return { value: publicNode(existing) };
        }
        const node = buildNodeFromEvidence(evidence, timestamp);
        const next = buildState({
          ...unsigned(state),
          revision: state.revision + 1,
          nodes: [...state.nodes, node],
          updatedAt: timestamp,
        });
        return { state: next, value: publicNode(node) };
      });
    },

    drainNode(inputValue) {
      const input = operationInput(inputValue, ["workerId", "expectedRevision"], "drain compute node request");
      const workerId = assertWorkerId(input.workerId);
      return transact("drainNode", async (state) => {
        assertExpectedRevision(input.expectedRevision, state.revision, "expectedRevision");
        const node = findNode(state, workerId);
        if (!node) notFound();
        if (node.status === "removed") fail("COMPUTE_NODE_REMOVED", "Removed compute node cannot be drained.", { status: 410 });
        if (node.status === "draining") return { value: publicNode(node) };
        const timestamp = nowText(options.now);
        const nextNode = sealRecord({ ...unsigned(node), status: "draining", updatedAt: timestamp, drainingAt: timestamp });
        return { state: updateNode(state, nextNode), value: publicNode(nextNode) };
      });
    },

    assignRole(inputValue) {
      const input = operationInput(inputValue, ["role", "workerId", "expectedFencingEpoch", "expectedRevision"], "assign compute node request");
      const role = assertRole(input.role);
      const workerId = assertWorkerId(input.workerId);
      assertRevision(input.expectedFencingEpoch, "expectedFencingEpoch");
      return transact("assignRole", async (state) => {
        assertExpectedRevision(input.expectedRevision, state.revision, "expectedRevision");
        const node = findNode(state, workerId);
        if (!node || node.role !== role) notFound();
        if (node.status !== "admitted") {
          fail("COMPUTE_NODE_ASSIGNMENT_FORBIDDEN", "Only an admitted compute node can be assigned.", { status: 409 });
        }
        const current = findAssignment(state, role);
        const currentEpoch = current?.fencingEpoch || 0;
        if (currentEpoch !== input.expectedFencingEpoch) {
          conflict("Compute node role assignment fencing epoch changed.", { expected: currentEpoch, received: input.expectedFencingEpoch });
        }
        const timestamp = nowText(options.now);
        const fencingEpoch = currentEpoch + 1;
        const nextNode = sealRecord({ ...unsigned(node), fencingEpoch, updatedAt: timestamp });
        const nextAssignment = sealRecord({
          schemaVersion: INTEGRATION_COMPUTE_NODE_ASSIGNMENT_VERSION,
          role,
          workerId,
          fencingEpoch,
          assignedAt: timestamp,
          updatedAt: timestamp,
        });
        const next = buildState({
          ...unsigned(state),
          revision: state.revision + 1,
          nodes: state.nodes.map((candidate) => candidate.workerId === workerId ? nextNode : candidate),
          assignments: [
            ...state.assignments.filter((candidate) => candidate.role !== role),
            nextAssignment,
          ],
          updatedAt: timestamp,
        });
        return { state: next, value: publicAssignment(nextAssignment) };
      });
    },

    getActiveAssignment(inputValue) {
      const input = operationInput(inputValue, ["role"], "get compute node assignment request");
      const role = assertRole(input.role);
      return transact("getActiveAssignment", async (state) => ({
        value: publicAssignment(findAssignment(state, role)),
      }));
    },

    claimLease(inputValue) {
      const input = operationInput(inputValue, [
        "leaseId",
        "runId",
        "role",
        "workerId",
        "fencingEpoch",
        "expiresAt",
        "expectedRevision",
      ], "claim compute node lease request");
      const leaseId = assertLeaseId(input.leaseId);
      const runId = assertRunId(input.runId);
      const role = assertRole(input.role);
      const workerId = assertWorkerId(input.workerId);
      assertRevision(input.fencingEpoch, "fencingEpoch", { minimum: 1 });
      assertCanonicalTimestamp(input.expiresAt, "expiresAt");
      return transact("claimLease", async (state) => {
        assertExpectedRevision(input.expectedRevision, state.revision, "expectedRevision");
        const existing = findLease(state, leaseId);
        if (existing) {
          if (
            existing.runId === runId &&
            existing.role === role &&
            existing.workerId === workerId &&
            existing.fencingEpoch === input.fencingEpoch &&
            existing.expiresAt === input.expiresAt
          ) return { value: publicLease(existing) };
          conflict("Compute node lease identity changed.");
        }
        const assignment = findAssignment(state, role);
        if (
          !assignment ||
          assignment.workerId !== workerId ||
          assignment.fencingEpoch !== input.fencingEpoch
        ) {
          fail("COMPUTE_NODE_LEASE_FENCE_MISMATCH", "Compute node lease fencing does not match active assignment.", { status: 409 });
        }
        const node = findNode(state, workerId);
        if (!node || node.status !== "admitted") {
          fail("COMPUTE_NODE_LEASE_FORBIDDEN", "Compute node is not admitted for new leases.", { status: 409 });
        }
        const timestamp = nowText(options.now);
        const expiresMs = parseIsoMs(input.expiresAt, "expiresAt");
        if (expiresMs <= parseIsoMs(timestamp, "claimedAt")) {
          invalid("expiresAt must be after the claim timestamp");
        }
        const lease = sealRecord({
          schemaVersion: INTEGRATION_COMPUTE_NODE_LEASE_VERSION,
          leaseId,
          runId,
          role,
          workerId,
          fencingEpoch: input.fencingEpoch,
          claimedAt: timestamp,
          expiresAt: input.expiresAt,
          releasedAt: null,
        });
        const next = replaceLease(state, lease, timestamp);
        return { state: next, value: publicLease(lease) };
      });
    },

    releaseLease(inputValue) {
      const input = operationInput(inputValue, ["leaseId", "runId", "expectedRevision"], "release compute node lease request");
      const leaseId = assertLeaseId(input.leaseId);
      const runId = assertRunId(input.runId);
      return transact("releaseLease", async (state) => {
        assertExpectedRevision(input.expectedRevision, state.revision, "expectedRevision");
        const lease = findLease(state, leaseId);
        if (!lease || lease.runId !== runId) notFound("Compute node lease was not found.");
        if (lease.releasedAt !== null) return { value: publicLease(lease) };
        const timestamp = nowText(options.now);
        const nextLease = sealRecord({ ...unsigned(lease), releasedAt: timestamp });
        return { state: replaceLease(state, nextLease, timestamp), value: publicLease(nextLease) };
      });
    },

    removeNode(inputValue) {
      const input = operationInput(inputValue, ["workerId", "expectedRevision"], "remove compute node request");
      const workerId = assertWorkerId(input.workerId);
      return transact("removeNode", async (state) => {
        assertExpectedRevision(input.expectedRevision, state.revision, "expectedRevision");
        const node = findNode(state, workerId);
        if (!node) notFound();
        if (node.status === "removed") return { value: publicNode(node) };
        if (state.assignments.some((assignment) => assignment.workerId === workerId)) {
          fail("COMPUTE_NODE_REMOVE_CONFLICT", "Assigned compute node cannot be removed.", { status: 409 });
        }
        if (activeLeasesForWorker(state, workerId).length > 0) {
          fail("COMPUTE_NODE_REMOVE_CONFLICT", "Compute node with active leases cannot be removed.", { status: 409 });
        }
        const timestamp = nowText(options.now);
        const nextNode = sealRecord({
          ...unsigned(node),
          status: "removed",
          updatedAt: timestamp,
          removedAt: timestamp,
        });
        return { state: removeNodeRecord(state, nextNode, timestamp), value: publicNode(nextNode) };
      });
    },

    async close() {
      if (closed) return closeObject({ closed: true });
      closing = true;
      if (inFlight > 0) {
        await new Promise((resolve) => closeWaiters.push(resolve));
      }
      closed = true;
      return closeObject({ closed: true });
    },
  });

  AUTHORITY_BRAND.add(authority);
  return authority;
}

export function assertIntegrationComputeNodeAuthority(value, expected = {}) {
  if (!value || typeof value !== "object" || !AUTHORITY_BRAND.has(value)) {
    throw new TypeError("integration compute node authority is not AgInTi-owned");
  }
  const options = exactObject({
    stateRootDigest: expected.stateRootDigest ?? null,
    rootIdentityDigest: expected.rootIdentityDigest ?? null,
  }, ["stateRootDigest", "rootIdentityDigest"], "compute node authority assertion");
  if (options.stateRootDigest !== null) assertDigestValue(options.stateRootDigest, "stateRootDigest");
  if (options.rootIdentityDigest !== null) assertDigestValue(options.rootIdentityDigest, "rootIdentityDigest");
  if (value.schemaVersion !== INTEGRATION_COMPUTE_NODE_AUTHORITY_VERSION) {
    throw new TypeError("integration compute node authority schema is invalid");
  }
  if (value.attestation?.schemaVersion !== INTEGRATION_COMPUTE_NODE_ATTESTATION_VERSION) {
    throw new TypeError("integration compute node authority attestation is invalid");
  }
  const attestationDigest = value.attestation.digest;
  const { digest, ...unsignedAttestation } = value.attestation;
  if (attestationDigest !== contractDigest(unsignedAttestation)) {
    throw new TypeError("integration compute node authority attestation digest is invalid");
  }
  if (options.stateRootDigest !== null && value.attestation.stateRootDigest !== options.stateRootDigest) {
    throw new TypeError("integration compute node authority state root digest does not match");
  }
  if (options.rootIdentityDigest !== null && value.attestation.rootIdentityDigest !== options.rootIdentityDigest) {
    throw new TypeError("integration compute node authority root identity digest does not match");
  }
  return value;
}

export function computeNodeReleaseDigest(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) invalid("release identity is invalid");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
