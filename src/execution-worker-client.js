import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  EXECUTION_WORKER_API_SCHEMA_VERSION,
  EXECUTION_WORKER_LISTEN_HOST,
  EXECUTION_WORKER_LISTEN_PORT,
  EXECUTION_WORKER_MAX_REQUEST_BYTES,
  EXECUTION_WORKER_RPC_PATHS,
  validateExecutionWorkerBearerToken,
} from "./execution-worker-api.js";
import {
  EXECUTION_JOB_SCHEMA_VERSION,
  EXECUTION_RESULT_SCHEMA_VERSION,
  EXECUTION_WORKER_SCHEMA_VERSION,
  validateExecutionJobRequest,
  validateExecutionResult,
} from "./execution-worker.js";
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
  EXECUTION_ZERO_EVENT_HASH,
} from "./execution-worker-jobs.js";
import {
  INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
} from "./integration-config.js";
import { assertIntegrationExecutionWorkerBinding } from "./integration-execution-worker-binding-config.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { contractDigest } from "./integration-policy.js";

export const EXECUTION_WORKER_CLIENT_SCHEMA_VERSION = "aginti-execution-worker-client-v1";
export const EXECUTION_WORKER_CREDENTIAL_NAME = "execution-worker-token";
export const EXECUTION_WORKER_CREDENTIAL_PATH =
  `${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}/${EXECUTION_WORKER_CREDENTIAL_NAME}`;
export const EXECUTION_WORKER_RESPONSE_MAX_BYTES = 512 * 1024;
export const EXECUTION_WORKER_CLIENT_REQUEST_TIMEOUT_MS = 7_500;

const CLIENT_BRAND = new WeakSet();
const DIGEST = /^[a-f0-9]{64}$/u;
const JOB_ID = /^job_[A-Za-z0-9_-]{24,96}$/u;
const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{32,86}$/u;
const PUBLIC_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/u;
const JOB_STATES = new Set([
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "output_limited",
  "cancelled",
  "sandbox_error",
  "artifact_invalid",
  "termination_unproven",
  "worker_error",
]);
const TERMINAL_JOB_STATES = new Set([...JOB_STATES].filter((state) => state !== "running" && state !== "cancelling"));
const EVENT_TYPES = new Set(["job.started", "job.cancel_requested", "job.terminal"]);
const CAPABILITY_HEALTH_KEYS = new Set([
  "ready",
  "admission",
  "activation",
  "capabilityDigest",
  "healthDigest",
  "coordinatorProtocol",
  "coordinatorProtocolDigest",
  "coordinatorHealthDigest",
]);

export class ExecutionWorkerClientError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionWorkerClientError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new ExecutionWorkerClientError(code, message, options);
}

function protocolValidation(operation, message) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ExecutionWorkerClientError) throw error;
    fail("EXECUTION_PROTOCOL_INVALID", message, { cause: error });
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label) {
  if (!isPlainObject(value)) fail("EXECUTION_PROTOCOL_INVALID", `${label} must be a plain data object.`);
  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("EXECUTION_PROTOCOL_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("EXECUTION_PROTOCOL_INVALID", `${label}.${key} is unavailable.`);
    }
  }
  return value;
}

function canonicalJson(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EXECUTION_PROTOCOL_INVALID", `${label} contains a non-finite number.`);
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    fail("EXECUTION_PROTOCOL_INVALID", `${label} contains non-JSON data.`);
  }
  if (seen.has(value)) fail("EXECUTION_PROTOCOL_INVALID", `${label} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("EXECUTION_PROTOCOL_INVALID", `${label} array prototype is invalid.`);
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))
      ) {
        fail("EXECUTION_PROTOCOL_INVALID", `${label} array shape is invalid.`);
      }
      return Object.freeze(value.map((item, index) => canonicalJson(item, `${label}[${index}]`, seen)));
    }
    if (!isPlainObject(value)) fail("EXECUTION_PROTOCOL_INVALID", `${label} object prototype is invalid.`);
    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        fail("EXECUTION_PROTOCOL_INVALID", `${label} contains non-data fields.`);
      }
      clone[key] = canonicalJson(descriptor.value, `${label}.${key}`, seen);
    }
    return Object.freeze(clone);
  } finally {
    seen.delete(value);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") fail("EXECUTION_PROTOCOL_INVALID", `${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("EXECUTION_PROTOCOL_INVALID", `${label} is invalid.`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("EXECUTION_PROTOCOL_INVALID", `${label} is invalid.`);
  }
  return value;
}

function jobReference(value, label = "execution job reference") {
  const input = exactObject(value, ["jobId", "attempt"], ["jobId", "attempt"], label);
  if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId)) {
    fail("EXECUTION_REQUEST_INVALID", `${label}.jobId is invalid.`, { status: 400 });
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 1_000_000) {
    fail("EXECUTION_REQUEST_INVALID", `${label}.attempt is invalid.`, { status: 400 });
  }
  return Object.freeze({ jobId: input.jobId, attempt: input.attempt });
}

function validatePublicJobRecord(value, expected = {}) {
  const record = exactObject(
    value,
    [
      "schemaVersion",
      "jobId",
      "attempt",
      "sourceSha256",
      "state",
      "createdAt",
      "updatedAt",
      "reused",
      "terminal",
      "result",
      "errorCode",
    ],
    [
      "schemaVersion",
      "jobId",
      "attempt",
      "sourceSha256",
      "state",
      "createdAt",
      "updatedAt",
      "reused",
      "terminal",
      "result",
      "errorCode",
    ],
    "execution job response"
  );
  if (record.schemaVersion !== EXECUTION_JOB_MANAGER_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response schema is unsupported.");
  }
  const reference = jobReference({ jobId: record.jobId, attempt: record.attempt }, "execution job response");
  if (expected.jobId !== undefined && reference.jobId !== expected.jobId) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response changed jobId.");
  }
  if (expected.attempt !== undefined && reference.attempt !== expected.attempt) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response changed attempt.");
  }
  const sourceSha256 = digest(record.sourceSha256, "execution job response sourceSha256");
  if (expected.sourceSha256 !== undefined && sourceSha256 !== expected.sourceSha256) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response changed source digest.");
  }
  if (!JOB_STATES.has(record.state)) fail("EXECUTION_PROTOCOL_INVALID", "execution job response state is invalid.");
  if (typeof record.reused !== "boolean" || typeof record.terminal !== "boolean") {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response flags are invalid.");
  }
  if (record.terminal !== TERMINAL_JOB_STATES.has(record.state)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job terminal flag does not match its state.");
  }
  const createdAt = canonicalTimestamp(record.createdAt, "execution job response createdAt");
  const updatedAt = canonicalTimestamp(record.updatedAt, "execution job response updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job response timestamps are out of order.");
  }
  let result = null;
  if (record.result !== null) {
    result = protocolValidation(
      () => validateExecutionResult(record.result, {
        jobId: reference.jobId,
        attempt: reference.attempt,
        sourceSha256,
      }),
      "execution job result is invalid."
    );
  }
  if (record.state === "succeeded" && result?.status !== "succeeded") {
    fail("EXECUTION_PROTOCOL_INVALID", "successful execution job is missing its validated result.");
  }
  if (record.result !== null && !record.terminal) {
    fail("EXECUTION_PROTOCOL_INVALID", "non-terminal execution job unexpectedly contains a result.");
  }
  if (record.errorCode !== null && (typeof record.errorCode !== "string" || !PUBLIC_ERROR_CODE.test(record.errorCode))) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution job errorCode is invalid.");
  }
  if (record.state === "worker_error" && !record.errorCode) {
    fail("EXECUTION_PROTOCOL_INVALID", "worker_error job is missing errorCode.");
  }
  return Object.freeze({
    schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
    ...reference,
    sourceSha256,
    state: record.state,
    createdAt,
    updatedAt,
    reused: record.reused,
    terminal: record.terminal,
    result,
    errorCode: record.errorCode,
  });
}

function validateExecutionEvent(value, expected) {
  const event = exactObject(
    value,
    ["schemaVersion", "jobId", "attempt", "seq", "previousHash", "type", "timestamp", "data", "eventHash"],
    ["schemaVersion", "jobId", "attempt", "seq", "previousHash", "type", "timestamp", "data", "eventHash"],
    "execution event"
  );
  if (event.schemaVersion !== EXECUTION_EVENT_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event schema is unsupported.");
  }
  const reference = jobReference({ jobId: event.jobId, attempt: event.attempt }, "execution event");
  if (reference.jobId !== expected.jobId || reference.attempt !== expected.attempt) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event changed job identity.");
  }
  if (!Number.isSafeInteger(event.seq) || event.seq !== expected.seq) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event sequence is not contiguous.");
  }
  if (event.previousHash !== expected.previousHash) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event hash chain is not contiguous.");
  }
  if (!EVENT_TYPES.has(event.type)) fail("EXECUTION_PROTOCOL_INVALID", "execution event type is invalid.");
  const data = canonicalJson(event.data, "execution event data");
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    ...reference,
    seq: event.seq,
    previousHash: digest(event.previousHash, "execution event previousHash"),
    type: event.type,
    timestamp: canonicalTimestamp(event.timestamp, "execution event timestamp"),
    data,
  });
  if (digest(event.eventHash, "execution event hash") !== contractDigest(unsigned)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event hash is invalid.");
  }
  return Object.freeze({ ...unsigned, eventHash: event.eventHash });
}

function validateExecutionEventsResponse(value, reference, cursor) {
  const response = exactObject(
    value,
    ["schemaVersion", "jobId", "attempt", "events", "cursor", "terminal"],
    ["schemaVersion", "jobId", "attempt", "events", "cursor", "terminal"],
    "execution events response"
  );
  if (response.schemaVersion !== EXECUTION_JOB_MANAGER_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution events response schema is unsupported.");
  }
  const returnedReference = jobReference(
    { jobId: response.jobId, attempt: response.attempt },
    "execution events response"
  );
  if (returnedReference.jobId !== reference.jobId || returnedReference.attempt !== reference.attempt) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution events response changed job identity.");
  }
  if (!Array.isArray(response.events) || response.events.length > 256) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution events response batch is invalid.");
  }
  let seq = cursor.seq;
  let previousHash = cursor.hash;
  const events = response.events.map((event) => {
    const checked = validateExecutionEvent(event, { ...reference, seq: seq + 1, previousHash });
    seq = checked.seq;
    previousHash = checked.eventHash;
    return checked;
  });
  const returnedCursor = exactObject(response.cursor, ["seq", "hash"], ["seq", "hash"], "execution events cursor");
  if (returnedCursor.seq !== seq || returnedCursor.hash !== previousHash) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution events response cursor does not match its batch.");
  }
  if (typeof response.terminal !== "boolean") {
    fail("EXECUTION_PROTOCOL_INVALID", "execution events response terminal flag is invalid.");
  }
  return Object.freeze({
    schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
    ...reference,
    events: Object.freeze(events),
    cursor: Object.freeze({ seq, hash: previousHash }),
    terminal: response.terminal,
  });
}

function validateCapabilities(value) {
  const capabilities = canonicalJson(value, "execution capabilities");
  if (
    capabilities.schemaVersion !== EXECUTION_WORKER_SCHEMA_VERSION ||
    capabilities.implementation !== "aginti-execution-worker" ||
    capabilities.implementationVersion !== "1"
  ) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker capability identity is invalid.");
  }
  if (typeof capabilities.workerId !== "string" || !/^worker_[A-Za-z0-9_-]{24,96}$/u.test(capabilities.workerId)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker capability workerId is invalid.");
  }
  const capabilityCore = {};
  for (const [key, item] of Object.entries(capabilities)) {
    if (!CAPABILITY_HEALTH_KEYS.has(key)) capabilityCore[key] = item;
  }
  if (digest(capabilities.capabilityDigest, "execution capability digest") !== contractDigest(capabilityCore)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker capability digest is invalid.");
  }
  const admission = capabilities.admission;
  const workerAdmission = admission?.workerAdmission;
  if (
    !isPlainObject(admission) ||
    !isPlainObject(workerAdmission) ||
    admission.state !== "ready" ||
    workerAdmission.state !== "ready" ||
    !Number.isSafeInteger(admission.activeJobs) ||
    !Number.isSafeInteger(admission.maximumConcurrentJobs) ||
    admission.activeJobs < 0 ||
    admission.maximumConcurrentJobs < 1 ||
    admission.activeJobs >= admission.maximumConcurrentJobs
  ) {
    fail("EXECUTION_NOT_READY", "execution worker admission is not ready.", { status: 503 });
  }
  if (
    capabilities.ready !== true ||
    capabilities.activation?.publicReady !== true ||
    !Array.isArray(capabilities.activation?.blockers) ||
    capabilities.activation.blockers.length !== 0
  ) {
    fail("EXECUTION_NOT_READY", "execution worker public activation proof is not ready.", { status: 503 });
  }
  if (
    capabilities.runtime?.seccompPolicyVerified !== true ||
    capabilities.runtime?.minimalRuntimeRoot !== true ||
    capabilities.runtime?.runtimeBundleDigestPinned !== true ||
    !DIGEST.test(String(capabilities.runtime?.seccompPolicyDigest || "")) ||
    !DIGEST.test(String(capabilities.runtime?.runtimeBundleRootDigest || "")) ||
    capabilities.executionGate?.requiresVerifiedSeccompPolicy !== true ||
    capabilities.executionGate?.requiresAggregateCgroupContainment !== true ||
    capabilities.executionGate?.testOnlyBypassConfigured !== false
  ) {
    fail("EXECUTION_NOT_READY", "execution worker isolation proof is incomplete.", { status: 503 });
  }
  if (
    capabilities.containment?.aggregateCgroupVerified !== true ||
    !DIGEST.test(String(capabilities.containment?.cgroupPolicyDigest || ""))
  ) {
    fail("EXECUTION_NOT_READY", "execution worker aggregate containment proof is incomplete.", { status: 503 });
  }
  if (
    !Array.isArray(capabilities.languages) ||
    capabilities.languages.length !== 1 ||
    capabilities.languages[0] !== "python" ||
    capabilities.artifacts?.schemaVersion !== "1" ||
    contractDigest(capabilities.artifacts?.kinds) !== contractDigest(["plot", "table", "markdown"])
  ) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker language or artifact capability is invalid.");
  }
  const protocol = capabilities.coordinatorProtocol;
  const expectedRoutes = [
    "capabilities",
    "jobs.start",
    "jobs.status",
    "jobs.events",
    "jobs.cancel",
    "artifacts.list",
    "artifacts.get",
  ];
  if (
    protocol?.schemaVersion !== EXECUTION_JOB_MANAGER_SCHEMA_VERSION ||
    protocol?.durable !== false ||
    protocol?.tenantBlind !== true ||
    protocol?.eventLedger?.schemaVersion !== EXECUTION_EVENT_SCHEMA_VERSION ||
    protocol?.eventLedger?.hashChained !== true ||
    protocol?.eventLedger?.pruned !== false ||
    contractDigest(protocol?.routes) !== contractDigest(expectedRoutes) ||
    capabilities.coordinatorProtocolDigest !== contractDigest(protocol)
  ) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker coordinator protocol proof is invalid.");
  }
  if (
    capabilities.coordinatorHealthDigest !== contractDigest({ ready: capabilities.ready, admission }) ||
    capabilities.healthDigest !== contractDigest({
      capabilityDigest: capabilities.capabilityDigest,
      ready: workerAdmission.state === "ready",
      admission: workerAdmission,
      activation: capabilities.activation,
    })
  ) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution worker health digest is invalid.");
  }
  return capabilities;
}

function validateArtifactList(value, reference, expectedResult = null) {
  const response = exactObject(
    value,
    ["schemaVersion", "jobId", "attempt", "terminal", "artifacts"],
    ["schemaVersion", "jobId", "attempt", "terminal", "artifacts"],
    "execution artifact list response"
  );
  if (response.schemaVersion !== EXECUTION_JOB_MANAGER_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact list schema is unsupported.");
  }
  const returned = jobReference({ jobId: response.jobId, attempt: response.attempt }, "execution artifact list response");
  if (returned.jobId !== reference.jobId || returned.attempt !== reference.attempt || response.terminal !== true) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact list changed job identity or terminal state.");
  }
  if (!Array.isArray(response.artifacts) || response.artifacts.length > 8) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact list is invalid.");
  }
  const artifacts = Object.freeze(response.artifacts.map((artifact) => protocolValidation(
    () => sanitizeIntegrationArtifact(artifact),
    "execution artifact list contains an invalid artifact."
  )));
  if (new Set(artifacts.map(({ id }) => id)).size !== artifacts.length) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact list contains duplicate IDs.");
  }
  if (expectedResult && contractDigest(artifacts) !== contractDigest(expectedResult.artifacts)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact list diverged from the validated terminal result.");
  }
  return artifacts;
}

function validateArtifactGet(value, reference, artifactId) {
  const response = exactObject(
    value,
    ["schemaVersion", "jobId", "attempt", "artifact"],
    ["schemaVersion", "jobId", "attempt", "artifact"],
    "execution artifact get response"
  );
  if (response.schemaVersion !== EXECUTION_JOB_MANAGER_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact get schema is unsupported.");
  }
  const returned = jobReference({ jobId: response.jobId, attempt: response.attempt }, "execution artifact get response");
  if (returned.jobId !== reference.jobId || returned.attempt !== reference.attempt) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution artifact get changed job identity.");
  }
  const artifact = protocolValidation(
    () => sanitizeIntegrationArtifact(response.artifact),
    "execution artifact detail is invalid."
  );
  if (artifact.id !== artifactId) fail("EXECUTION_PROTOCOL_INVALID", "execution artifact get changed artifact identity.");
  return artifact;
}

function metadata(stat, kind) {
  return Object.freeze({
    kind,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    nlink: stat.nlink,
    size: stat.size,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
  });
}

function trustedOwner(metadataValue, effectiveUid, effectiveGid) {
  return (
    (metadataValue.uid === 0 && metadataValue.gid === 0) ||
    (metadataValue.uid === effectiveUid && metadataValue.gid === effectiveGid)
  );
}

export function validateExecutionWorkerSystemdCredentialMetadata(value, options = {}) {
  const directory = value?.directory;
  const credential = value?.credential;
  const effectiveUid = Number(options.effectiveUid);
  const effectiveGid = Number(options.effectiveGid);
  if (
    !Number.isSafeInteger(effectiveUid) || effectiveUid < 0 ||
    !Number.isSafeInteger(effectiveGid) || effectiveGid < 0 ||
    options.mountReadOnly !== true
  ) {
    fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential mount identity is invalid.");
  }
  if (
    !directory ||
    directory.kind !== "directory" ||
    directory.isDirectory !== true ||
    directory.isFile !== false ||
    directory.isSymbolicLink !== false ||
    !trustedOwner(directory, effectiveUid, effectiveGid) ||
    !Number.isSafeInteger(directory.nlink) ||
    directory.nlink < 2 ||
    (directory.mode & 0o500) !== 0o500 ||
    (directory.mode & 0o027) !== 0
  ) {
    fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential directory metadata is invalid.");
  }
  if (
    !credential ||
    credential.kind !== "credential" ||
    credential.isDirectory !== false ||
    credential.isFile !== true ||
    credential.isSymbolicLink !== false ||
    !trustedOwner(credential, effectiveUid, effectiveGid) ||
    !new Set([0o400, 0o440]).has(credential.mode) ||
    credential.nlink !== 1 ||
    !Number.isSafeInteger(credential.size) ||
    credential.size < 32 ||
    credential.size > 257
  ) {
    fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential file metadata is invalid.");
  }
  return true;
}

function mountPath(value) {
  return String(value || "").replace(/\\(040|011|012|134)/gu, (_match, code) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\",
  })[code]);
}

async function credentialMountIsReadOnly(directory) {
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  let selected = null;
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6) continue;
    const candidate = mountPath(fields[4]);
    if (directory !== candidate && !directory.startsWith(`${candidate === "/" ? "" : candidate}/`)) continue;
    if (!selected || candidate.length > selected.path.length) {
      selected = { path: candidate, options: new Set(fields[5].split(",")) };
    }
  }
  return selected?.options.has("ro") === true;
}

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function loadExecutionWorkerSystemdCredentialPath(credentialPath) {
  const directory = INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY;
  let handle;
  try {
    if (path.resolve(directory) !== directory || path.resolve(credentialPath) !== credentialPath) {
      fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential path is not canonical.");
    }
    const [directoryReal, directoryBefore, credentialReal, credentialPathBefore] = await Promise.all([
      fs.realpath(directory),
      fs.lstat(directory),
      fs.realpath(credentialPath),
      fs.lstat(credentialPath),
    ]);
    if (
      directoryReal !== directory ||
      credentialReal !== credentialPath ||
      directoryBefore.isSymbolicLink() ||
      credentialPathBefore.isSymbolicLink()
    ) {
      fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential path must not contain symbolic links.");
    }
    const effectiveUid = typeof process.geteuid === "function"
      ? process.geteuid()
      : typeof process.getuid === "function" ? process.getuid() : 0;
    const effectiveGid = typeof process.getegid === "function"
      ? process.getegid()
      : typeof process.getgid === "function" ? process.getgid() : 0;
    validateExecutionWorkerSystemdCredentialMetadata(
      {
        directory: metadata(directoryBefore, "directory"),
        credential: metadata(credentialPathBefore, "credential"),
      },
      {
        effectiveUid,
        effectiveGid,
        mountReadOnly: await credentialMountIsReadOnly(directory),
      }
    );
    handle = await fs.open(
      credentialPath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK || 0) |
        (fsConstants.O_CLOEXEC || 0)
    );
    const before = await handle.stat();
    if (!sameFileSnapshot(credentialPathBefore, before)) {
      fail("EXECUTION_CREDENTIAL_CHANGED", "execution worker credential changed before it was read.");
    }
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    const [credentialPathAfter, directoryAfter, directoryRealAfter, credentialRealAfter] = await Promise.all([
      fs.lstat(credentialPath),
      fs.lstat(directory),
      fs.realpath(directory),
      fs.realpath(credentialPath),
    ]);
    if (
      !sameFileSnapshot(before, after) ||
      !sameFileSnapshot(after, credentialPathAfter) ||
      !sameFileSnapshot(directoryBefore, directoryAfter) ||
      directoryRealAfter !== directory ||
      credentialRealAfter !== credentialPath ||
      Buffer.byteLength(raw, "utf8") !== after.size
    ) {
      fail("EXECUTION_CREDENTIAL_CHANGED", "execution worker credential changed while it was read.");
    }
    if (raw.includes("\u0000") || raw.includes("\r")) {
      fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential framing is invalid.");
    }
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!token || token.includes("\n")) {
      fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential must contain exactly one line.");
    }
    if (token !== token.trim()) {
      fail("EXECUTION_CREDENTIAL_INVALID", "execution worker credential must not contain leading or trailing whitespace.");
    }
    return validateExecutionWorkerBearerToken(token);
  } catch (error) {
    if (error instanceof ExecutionWorkerClientError) throw error;
    fail("EXECUTION_CREDENTIAL_INVALID", "execution worker systemd credential could not be read safely.", { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function loadExecutionWorkerSystemdCredential(...args) {
  if (args.length !== 0) {
    fail("EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN", "execution worker credential source is fixed by systemd LoadCredential.");
  }
  return loadExecutionWorkerSystemdCredentialPath(EXECUTION_WORKER_CREDENTIAL_PATH);
}

function createHttpRpc(token, agent, endpoint = {}) {
  const host = endpoint.host ?? EXECUTION_WORKER_LISTEN_HOST;
  const port = endpoint.port ?? EXECUTION_WORKER_LISTEN_PORT;
  return function requestRpc(pathname, body, { signal } = {}) {
    if (!Object.values(EXECUTION_WORKER_RPC_PATHS).includes(pathname)) {
      fail("EXECUTION_REQUEST_INVALID", "execution worker RPC path is not allowed.", { status: 400 });
    }
    const serialized = JSON.stringify(body);
    const requestBytes = Buffer.byteLength(serialized, "utf8");
    if (requestBytes > EXECUTION_WORKER_MAX_REQUEST_BYTES) {
      fail("EXECUTION_REQUEST_INVALID", "execution worker request exceeds its transport bound.", { status: 400 });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let response = null;
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof ExecutionWorkerClientError
          ? error
          : new ExecutionWorkerClientError("EXECUTION_UNAVAILABLE", "execution worker request failed.", { cause: error }));
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const abort = () => {
        const error = new ExecutionWorkerClientError("EXECUTION_CANCELLED", "execution worker request was cancelled.", {
          status: 499,
        });
        request.destroy(error);
        response?.destroy(error);
        finishReject(error);
      };
      const cleanup = () => signal?.removeEventListener?.("abort", abort);
      const request = http.request({
        agent,
        host,
        port,
        method: "POST",
        path: pathname,
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": requestBytes,
          "content-type": "application/json; charset=utf-8",
        },
        timeout: EXECUTION_WORKER_CLIENT_REQUEST_TIMEOUT_MS,
      });
      request.once("timeout", () => request.destroy(new Error("execution worker request timeout")));
      request.once("error", finishReject);
      request.once("response", (incoming) => {
        response = incoming;
        const contentType = String(incoming.headers["content-type"] || "");
        const contentEncoding = incoming.headers["content-encoding"];
        const declaredLength = String(incoming.headers["content-length"] || "");
        const responseHeaderCount = (name) => {
          let count = 0;
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            if (String(incoming.rawHeaders[index]).toLowerCase() === name) count += 1;
          }
          return count;
        };
        if (
          responseHeaderCount("content-type") !== 1 ||
          responseHeaderCount("content-length") !== 1 ||
          !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType) ||
          contentEncoding !== undefined ||
          (declaredLength && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > EXECUTION_WORKER_RESPONSE_MAX_BYTES))
        ) {
          incoming.resume();
          finishReject(new ExecutionWorkerClientError("EXECUTION_PROTOCOL_INVALID", "execution worker response headers are invalid."));
          return;
        }
        const chunks = [];
        let bytes = 0;
        incoming.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > EXECUTION_WORKER_RESPONSE_MAX_BYTES) {
            incoming.destroy(new Error("execution worker response too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("error", finishReject);
        incoming.once("end", () => {
          if (declaredLength && Number(declaredLength) !== bytes) {
            finishReject(new ExecutionWorkerClientError("EXECUTION_PROTOCOL_INVALID", "execution worker response length is invalid."));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            finishReject(new ExecutionWorkerClientError("EXECUTION_PROTOCOL_INVALID", "execution worker response JSON is invalid.", { cause: error }));
            return;
          }
          if (incoming.statusCode !== 200) {
            const code = String(parsed?.error?.code || "");
            finishReject(new ExecutionWorkerClientError(
              PUBLIC_ERROR_CODE.test(code) ? code : "EXECUTION_UNAVAILABLE",
              "execution worker rejected the request.",
              { status: Number(incoming.statusCode) || 503 }
            ));
            return;
          }
          finishResolve(parsed);
        });
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener?.("abort", abort, { once: true });
      request.end(serialized);
    });
  };
}

function unwrapApiEnvelope(value) {
  const envelope = exactObject(value, ["schemaVersion", "response"], ["schemaVersion", "response"], "execution API response");
  if (envelope.schemaVersion !== EXECUTION_WORKER_API_SCHEMA_VERSION) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution API response schema is unsupported.");
  }
  return envelope.response;
}

function createClient(requestRpc, credentialSource, closeTransport = () => {}, binding = null) {
  if (typeof requestRpc !== "function") throw new TypeError("requestRpc must be a function");
  const endpoint = binding
    ? `http://${binding.host}:${binding.port}`
    : `http://${EXECUTION_WORKER_LISTEN_HOST}:${EXECUTION_WORKER_LISTEN_PORT}`;
  const proofUnsigned = Object.freeze({
    schemaVersion: EXECUTION_WORKER_CLIENT_SCHEMA_VERSION,
    owner: "aginti",
    authority: "aginti",
    endpoint,
    apiPrefix: "/executor/v1",
    credentialSource,
    bindingId: binding?.bindingId ?? null,
    transport: binding?.transport ?? "local-loopback-http-v1",
    bindingConfigDigest: binding?.configDigest ?? null,
    browserConfigurable: false,
    modelConfigurable: false,
  });
  const attestation = Object.freeze({ ...proofUnsigned, digest: contractDigest(proofUnsigned) });

  async function rpc(pathname, body, options) {
    return unwrapApiEnvelope(await requestRpc(pathname, body, options));
  }

  const client = Object.freeze({
    attestation,
    async capabilities(options = {}) {
      return validateCapabilities(await rpc(EXECUTION_WORKER_RPC_PATHS.capabilities, {}, options));
    },
    async start(input, options = {}) {
      const request = validateExecutionJobRequest(input);
      return validatePublicJobRecord(await rpc(EXECUTION_WORKER_RPC_PATHS.jobsStart, request, options), request);
    },
    async status(input, options = {}) {
      const reference = jobReference(input, "execution status request");
      return validatePublicJobRecord(await rpc(EXECUTION_WORKER_RPC_PATHS.jobsStatus, reference, options), reference);
    },
    async events(input, options = {}) {
      const request = exactObject(
        input,
        ["jobId", "attempt", "afterSeq", "afterHash"],
        ["jobId", "attempt", "afterSeq", "afterHash"],
        "execution events request"
      );
      const reference = jobReference({ jobId: request.jobId, attempt: request.attempt }, "execution events request");
      if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < 0 || !DIGEST.test(String(request.afterHash || ""))) {
        fail("EXECUTION_REQUEST_INVALID", "execution events cursor is invalid.", { status: 400 });
      }
      return validateExecutionEventsResponse(
        await rpc(EXECUTION_WORKER_RPC_PATHS.jobsEvents, request, options),
        reference,
        { seq: request.afterSeq, hash: request.afterHash }
      );
    },
    async cancel(input, options = {}) {
      const reference = jobReference(input, "execution cancel request");
      return validatePublicJobRecord(await rpc(EXECUTION_WORKER_RPC_PATHS.jobsCancel, reference, options), reference);
    },
    async listArtifacts(input, expectedResult = null, options = {}) {
      const reference = jobReference(input, "execution artifact list request");
      return validateArtifactList(
        await rpc(EXECUTION_WORKER_RPC_PATHS.artifactsList, reference, options),
        reference,
        expectedResult
      );
    },
    async getArtifact(input, options = {}) {
      const request = exactObject(
        input,
        ["jobId", "attempt", "artifactId"],
        ["jobId", "attempt", "artifactId"],
        "execution artifact get request"
      );
      const reference = jobReference({ jobId: request.jobId, attempt: request.attempt }, "execution artifact get request");
      if (typeof request.artifactId !== "string" || !ARTIFACT_ID.test(request.artifactId)) {
        fail("EXECUTION_REQUEST_INVALID", "execution artifactId is invalid.", { status: 400 });
      }
      return validateArtifactGet(
        await rpc(EXECUTION_WORKER_RPC_PATHS.artifactsGet, request, options),
        reference,
        request.artifactId
      );
    },
    close() {
      closeTransport();
    },
  });
  CLIENT_BRAND.add(client);
  return client;
}

export function assertExecutionWorkerClient(value, { requireSystemdCredential = false } = {}) {
  if (!value || !CLIENT_BRAND.has(value)) throw new TypeError("execution worker client is not an AgInTi-owned client");
  if (
    requireSystemdCredential &&
    !new Set(["systemd-loadcredential-fixed", "systemd-loadcredential-binding"])
      .has(value.attestation.credentialSource)
  ) {
    throw new TypeError("execution worker client does not use a systemd credential");
  }
  return value;
}

export async function createSystemdExecutionWorkerClient(...args) {
  if (args.length > 1) {
    fail("EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN", "production execution worker client accepts no overrides.");
  }
  let token;
  if (args.length === 0) {
    token = await loadExecutionWorkerSystemdCredential();
  } else {
    if (!isPlainObject(args[0])) {
      fail("EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN", "production execution worker client credential binding is invalid.");
    }
    const keys = Reflect.ownKeys(args[0]);
    const descriptor = Object.getOwnPropertyDescriptor(args[0], "token");
    if (
      keys.length !== 1 ||
      keys[0] !== "token" ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN", "production execution worker client accepts no transport overrides.");
    }
    const options = args[0];
    token = validateExecutionWorkerBearerToken(options.token);
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 5_000 });
  return createClient(createHttpRpc(token, agent), "systemd-loadcredential-fixed", () => agent.destroy());
}

export async function createSystemdBoundExecutionWorkerClient(bindingValue) {
  const binding = assertIntegrationExecutionWorkerBinding(bindingValue);
  const credentialPath = path.join(INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY, binding.credentialName);
  if (
    path.dirname(credentialPath) !== INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY ||
    path.basename(credentialPath) !== binding.credentialName
  ) {
    fail("EXECUTION_CREDENTIAL_INVALID", "execution worker binding credential path is invalid.");
  }
  const token = await loadExecutionWorkerSystemdCredentialPath(credentialPath);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1, timeout: 5_000 });
  return createClient(
    createHttpRpc(token, agent, binding),
    "systemd-loadcredential-binding",
    () => agent.destroy(),
    binding
  );
}

export function createTestOnlyExecutionWorkerClient(requestRpc) {
  return createClient(requestRpc, "test-only-fixed-rpc");
}

export const EXECUTION_WORKER_CLIENT_PROTOCOL = Object.freeze({
  apiSchemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION,
  jobSchemaVersion: EXECUTION_JOB_SCHEMA_VERSION,
  resultSchemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
  eventSchemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
  zeroEventHash: EXECUTION_ZERO_EVENT_HASH,
  endpoint: Object.freeze({ host: EXECUTION_WORKER_LISTEN_HOST, port: EXECUTION_WORKER_LISTEN_PORT }),
});
