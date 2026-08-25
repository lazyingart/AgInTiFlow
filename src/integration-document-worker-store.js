import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_PATTERNS,
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
  IntegrationDocumentWorkerError,
  canonicalDocumentWorkerJson,
  deriveDocumentWorkerScopeDigests,
  deriveDocumentWorkerThreadDigests,
  digestNormalizedDocumentWorkerRequest,
  documentWorkerArtifactsDigest,
  documentWorkerCommitManifest,
  documentWorkerFail,
  documentWorkerManifestDigest,
  randomDocumentWorkerId,
  validateDocumentWorkerCompileArtifacts,
  validateDocumentWorkerReceipt,
} from "./integration-document-worker-contract.js";
import { canonicalJson, contractDigest } from "./integration-policy.js";

export const DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION = "aginti-document-worker-ledger-v1";
export const DOCUMENT_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION =
  "aginti-document-worker-ledger-envelope-v1";
export const DOCUMENT_WORKER_STAGED_GROUP_TTL_MS = 24 * 60 * 60 * 1000;

const DELETE_MANIFEST_SCHEMA_VERSION = "aginti-document-worker-delete-manifest-v1";
const DELETE_TOMBSTONE_SCHEMA_VERSION = "aginti-document-worker-delete-tombstone-v1";
const LEDGER_FILENAME = "ledger.json";
const STAGES_DIRECTORY = "stages";
const OBJECTS_DIRECTORY = "objects";
const MAXIMUM_LEDGER_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DIRECTORY_ENTRIES = 8192;
const MAXIMUM_GROUPS = 4096;
const MAXIMUM_COMMIT_REQUESTS = 8192;
const MAXIMUM_DELETIONS = 4096;
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);
const STORE_BRAND = new WeakSet();
const DIGEST = DOCUMENT_WORKER_PATTERNS.digest;

function storeFail(code, message, { status = 503, cause } = {}) {
  throw new IntegrationDocumentWorkerError(code, message, { status, cause });
}

function markFailStop(error) {
  if (!Object.hasOwn(error, "documentWorkerFailStop")) {
    Object.defineProperty(error, "documentWorkerFailStop", {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return error;
}

function unavailable(cause) {
  throw markFailStop(new IntegrationDocumentWorkerError(
    "WORKER_STATE_UNAVAILABLE",
    "Document worker private state is unavailable.",
    { status: 503, cause }
  ));
}

function corrupt(cause) {
  throw markFailStop(new IntegrationDocumentWorkerError(
    "WORKER_STATE_UNAVAILABLE",
    "Document worker private state failed integrity validation.",
    { status: 503, cause }
  ));
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function currentTimestamp(now) {
  const value = now().toISOString();
  if (new Date(value).toISOString() !== value) throw new TypeError("now must return a valid Date");
  return value;
}

function stateExact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    corrupt(new Error(`${label} is not a plain object`));
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) {
    corrupt(new Error(`${label} keys are invalid`));
  }
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      corrupt(new Error(`${label} contains a non-data field`));
    }
  }
  return value;
}

function stateArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    corrupt(new Error(`${label} is invalid`));
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) corrupt(new Error(`${label} is sparse`));
  }
  return value;
}

function stateDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) corrupt(new Error(`${label} is invalid`));
  return value;
}

function stateTimestamp(value, { nullable = false, label = "timestamp" } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    corrupt(new Error(`${label} is invalid`));
  }
  return value;
}

function publicArtifact(record) {
  return Object.freeze({
    ref: record.ref,
    role: record.role,
    filename: record.filename,
    mime: record.mime,
    bytes: record.bytes,
    sha256: record.sha256,
  });
}

function compileResponse(group) {
  return Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileResponse,
    requestId: group.requestId,
    receipt: Object.freeze({ ...group.receipt }),
    artifacts: Object.freeze(group.artifacts.map(publicArtifact)),
  });
}

function validateStoredArtifact(record, expectedRole) {
  stateExact(
    record,
    ["ref", "role", "filename", "mime", "bytes", "sha256", "state"],
    `${expectedRole} stored artifact`
  );
  if (!new Set(["staged", "committed", "gone", "tombstoned"]).has(record.state)) {
    corrupt(new Error(`${expectedRole} artifact state is invalid`));
  }
  let artifact;
  try {
    artifact = validateDocumentWorkerCompileArtifacts([
      expectedRole === "source" ? publicArtifact(record) : {
        ref: `wobj_${"A".repeat(43)}`,
        role: "source",
        filename: "placeholder.tex",
        mime: "application/x-tex",
        bytes: 1,
        sha256: "0".repeat(64),
      },
      expectedRole === "pdf" ? publicArtifact(record) : {
        ref: `wobj_${"B".repeat(43)}`,
        role: "pdf",
        filename: "placeholder.pdf",
        mime: "application/pdf",
        bytes: 1,
        sha256: "1".repeat(64),
      },
    ])[expectedRole === "source" ? 0 : 1];
  } catch (error) {
    corrupt(error);
  }
  return artifact;
}

function validateStoredCommitResponse(value) {
  stateExact(
    value,
    ["schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest"],
    "stored commit response"
  );
  if (
    value.schemaVersion !== DOCUMENT_WORKER_SCHEMA_VERSIONS.commitResponse ||
    !DOCUMENT_WORKER_PATTERNS.commitRequestId.test(value.requestId) ||
    value.status !== "committed"
  ) corrupt(new Error("stored commit response identity is invalid"));
  for (const key of ["receiptDigest", "manifestDigest", "digest"]) stateDigest(value[key], `commit response ${key}`);
  stateTimestamp(value.committedAt, { label: "commit response committedAt" });
  const { digest, ...unsigned } = value;
  if (contractDigest(unsigned) !== digest) corrupt(new Error("stored commit response digest is invalid"));
  return value;
}

function validateStoredPendingCommit(value) {
  if (value === null) return null;
  stateExact(value, ["requestDigest", "response"], "pending commit");
  stateDigest(value.requestDigest, "pending commit requestDigest");
  validateStoredCommitResponse(value.response);
  return value;
}

function validateStoredGroup(group) {
  stateExact(group, [
    "groupId",
    "state",
    "ownerDigest",
    "threadDigest",
    "runDigest",
    "scopeDigest",
    "requestId",
    "requestDigest",
    "requirementsDigest",
    "verifiedFigureCount",
    "receipt",
    "artifacts",
    "createdAt",
    "committedAt",
    "deletionId",
    "pendingCommit",
  ], "stored group");
  if (
    !DOCUMENT_WORKER_PATTERNS.groupId.test(group.groupId) ||
    !new Set(["staged", "committing", "committed", "delete-prepared", "deleting", "tombstoned"]).has(group.state) ||
    !DOCUMENT_WORKER_PATTERNS.compileRequestId.test(group.requestId)
  ) corrupt(new Error("stored group identity is invalid"));
  for (const key of [
    "ownerDigest",
    "threadDigest",
    "runDigest",
    "scopeDigest",
    "requestDigest",
    "requirementsDigest",
  ]) stateDigest(group[key], `group ${key}`);
  if (
    !Number.isSafeInteger(group.verifiedFigureCount) ||
    group.verifiedFigureCount < 0 ||
    group.verifiedFigureCount > DOCUMENT_WORKER_LIMITS.maximumFigureCount
  ) corrupt(new Error("stored group figure count is invalid"));
  let receipt;
  try {
    receipt = validateDocumentWorkerReceipt(group.receipt);
  } catch (error) {
    corrupt(error);
  }
  if (
    receipt.groupId !== group.groupId ||
    receipt.ownerDigest !== group.ownerDigest ||
    receipt.threadDigest !== group.threadDigest ||
    receipt.runDigest !== group.runDigest ||
    receipt.scopeDigest !== group.scopeDigest ||
    receipt.requestId !== group.requestId ||
    receipt.requestDigest !== group.requestDigest ||
    receipt.requirementsDigest !== group.requirementsDigest ||
    receipt.verifiedFigureCount !== group.verifiedFigureCount
  ) corrupt(new Error("stored group receipt binding is invalid"));
  const artifacts = stateArray(group.artifacts, 2, "stored group artifacts");
  if (artifacts.length !== 2) corrupt(new Error("stored group artifact pair is incomplete"));
  validateStoredArtifact(artifacts[0], "source");
  validateStoredArtifact(artifacts[1], "pdf");
  if (receipt.artifactsDigest !== documentWorkerArtifactsDigest(artifacts.map(publicArtifact))) {
    corrupt(new Error("stored artifact digest is invalid"));
  }
  if (
    receipt.sourceSha256 !== artifacts[0].sha256 ||
    receipt.sourceBytes !== artifacts[0].bytes ||
    receipt.pdfSha256 !== artifacts[1].sha256 ||
    receipt.pdfBytes !== artifacts[1].bytes
  ) corrupt(new Error("stored artifact receipt metadata is inconsistent"));
  stateTimestamp(group.createdAt, { label: "group createdAt" });
  stateTimestamp(group.committedAt, { nullable: true, label: "group committedAt" });
  if (group.deletionId !== null && !DOCUMENT_WORKER_PATTERNS.deletionId.test(group.deletionId)) {
    corrupt(new Error("stored group deletionId is invalid"));
  }
  validateStoredPendingCommit(group.pendingCommit);
  return group;
}

function validateStoredCommitRequest(record) {
  stateExact(record, ["requestId", "requestDigest", "response"], "stored commit request");
  if (!DOCUMENT_WORKER_PATTERNS.commitRequestId.test(record.requestId)) {
    corrupt(new Error("stored commit request id is invalid"));
  }
  stateDigest(record.requestDigest, "stored commit request digest");
  validateStoredCommitResponse(record.response);
  if (record.response.requestId !== record.requestId) corrupt(new Error("commit request response binding is invalid"));
  return record;
}

function validateStoredDeleteObject(record) {
  stateExact(record, ["ref", "runDigest", "receiptDigest"], "stored delete object");
  if (!DOCUMENT_WORKER_PATTERNS.objectRef.test(record.ref)) corrupt(new Error("stored delete ref is invalid"));
  stateDigest(record.runDigest, "stored delete runDigest");
  stateDigest(record.receiptDigest, "stored delete receiptDigest");
  return record;
}

function validateStoredDeletion(record) {
  stateExact(record, [
    "deletionId",
    "manifestDigest",
    "ownerDigest",
    "threadDigest",
    "status",
    "objects",
    "preparedAt",
    "completedAt",
    "tombstoneDigest",
  ], "stored deletion");
  if (
    !DOCUMENT_WORKER_PATTERNS.deletionId.test(record.deletionId) ||
    !new Set(["prepared", "committing", "committed"]).has(record.status)
  ) corrupt(new Error("stored deletion identity is invalid"));
  for (const key of ["manifestDigest", "ownerDigest", "threadDigest"]) {
    stateDigest(record[key], `stored deletion ${key}`);
  }
  const objects = stateArray(record.objects, DOCUMENT_WORKER_LIMITS.maximumDeleteObjects, "stored deletion objects");
  if (objects.length < 1) corrupt(new Error("stored deletion object list is empty"));
  objects.forEach(validateStoredDeleteObject);
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1].ref >= objects[index].ref) corrupt(new Error("stored deletion objects are unsorted"));
  }
  stateTimestamp(record.preparedAt, { label: "stored deletion preparedAt" });
  stateTimestamp(record.completedAt, { nullable: true, label: "stored deletion completedAt" });
  if (record.tombstoneDigest !== null) stateDigest(record.tombstoneDigest, "stored deletion tombstoneDigest");
  if (record.status === "committed" && (!record.completedAt || !record.tombstoneDigest)) {
    corrupt(new Error("stored committed deletion lacks a tombstone"));
  }
  return record;
}

function validateLedger(ledger) {
  stateExact(ledger, ["schemaVersion", "revision", "groups", "commitRequests", "deletions"], "worker ledger");
  if (
    ledger.schemaVersion !== DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION ||
    !Number.isSafeInteger(ledger.revision) ||
    ledger.revision < 0
  ) corrupt(new Error("worker ledger identity is invalid"));
  stateArray(ledger.groups, MAXIMUM_GROUPS, "worker groups").forEach(validateStoredGroup);
  stateArray(ledger.commitRequests, MAXIMUM_COMMIT_REQUESTS, "worker commit requests").forEach(validateStoredCommitRequest);
  stateArray(ledger.deletions, MAXIMUM_DELETIONS, "worker deletions").forEach(validateStoredDeletion);
  const groupIds = new Set();
  const requestIds = new Set();
  const refs = new Set();
  for (const group of ledger.groups) {
    if (groupIds.has(group.groupId) || requestIds.has(group.requestId)) corrupt(new Error("duplicate group identity"));
    groupIds.add(group.groupId);
    requestIds.add(group.requestId);
    for (const artifact of group.artifacts) {
      if (refs.has(artifact.ref)) corrupt(new Error("duplicate object ref"));
      refs.add(artifact.ref);
    }
  }
  const commitIds = new Set();
  for (const record of ledger.commitRequests) {
    if (commitIds.has(record.requestId)) corrupt(new Error("duplicate commit request id"));
    commitIds.add(record.requestId);
  }
  const deletionIds = new Set();
  for (const record of ledger.deletions) {
    if (deletionIds.has(record.deletionId)) corrupt(new Error("duplicate deletion id"));
    deletionIds.add(record.deletionId);
  }
  return ledger;
}

function initialLedger() {
  return {
    schemaVersion: DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION,
    revision: 0,
    groups: [],
    commitRequests: [],
    deletions: [],
  };
}

function ledgerEnvelope(ledger) {
  const unsigned = {
    schemaVersion: DOCUMENT_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION,
    ledger,
  };
  return { ...unsigned, digest: contractDigest(unsigned) };
}

function parseLedgerEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    corrupt(error);
  }
  stateExact(envelope, ["schemaVersion", "ledger", "digest"], "worker ledger envelope");
  if (envelope.schemaVersion !== DOCUMENT_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION) {
    corrupt(new Error("worker ledger envelope schema is unsupported"));
  }
  stateDigest(envelope.digest, "worker ledger envelope digest");
  const unsigned = { schemaVersion: envelope.schemaVersion, ledger: envelope.ledger };
  if (contractDigest(unsigned) !== envelope.digest || `${canonicalJson(envelope)}\n` !== text) {
    corrupt(new Error("worker ledger envelope is not canonical"));
  }
  return validateLedger(envelope.ledger);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    await handle.sync();
  } catch (error) {
    unavailable(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensurePrivateDirectory(directory, { create = false } = {}) {
  let created = false;
  try {
    if (create) {
      try {
        await fs.mkdir(directory, { recursive: false, mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const [real, stat] = await Promise.all([fs.realpath(directory), fs.lstat(directory)]);
    const uid = currentUid();
    if (
      real !== directory ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (uid !== null && stat.uid !== uid)
    ) corrupt(new Error("private directory metadata is unsafe"));
    if (created) await syncDirectory(path.dirname(directory));
  } catch (error) {
    if (error instanceof IntegrationDocumentWorkerError) throw error;
    unavailable(error);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function verifyPrivateFileStats(opened, named, expectedBytes, label) {
  const uid = currentUid();
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.isSymbolicLink?.() ||
    named.isSymbolicLink() ||
    opened.nlink !== 1 ||
    named.nlink !== 1 ||
    (opened.mode & 0o777) !== 0o600 ||
    (named.mode & 0o777) !== 0o600 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    opened.size !== expectedBytes ||
    named.size !== expectedBytes ||
    (uid !== null && (opened.uid !== uid || named.uid !== uid))
  ) corrupt(new Error(`${label} metadata is unsafe`));
}

async function openVerifiedPrivateFile(filename, expectedBytes, label) {
  let named;
  try {
    named = await fs.lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unavailable(error);
  }
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    const opened = await handle.stat();
    verifyPrivateFileStats(opened, named, expectedBytes, label);
    return Object.freeze({ handle, snapshot: opened });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof IntegrationDocumentWorkerError) throw error;
    corrupt(error);
  }
}

async function hashOpenFile(handle, size) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.byteLength, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead !== length) corrupt(new Error("private object ended before its authenticated length"));
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function verifyUnchangedOpenFile(handle, filename, snapshot, expectedBytes, label) {
  let opened;
  let named;
  try {
    [opened, named] = await Promise.all([handle.stat(), fs.lstat(filename)]);
  } catch (error) {
    unavailable(error);
  }
  verifyPrivateFileStats(opened, named, expectedBytes, label);
  if (!sameFileIdentity(snapshot, opened) || !sameFileIdentity(opened, named)) {
    corrupt(new Error(`${label} changed while it was verified`));
  }
}

async function writePrivateStage(filename, bytes, expectedSha256) {
  let handle;
  try {
    handle = await fs.open(
      filename,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    const verified = await openVerifiedPrivateFile(filename, bytes.byteLength, "staged object");
    if (!verified) corrupt(new Error("staged object disappeared"));
    try {
      const actual = await hashOpenFile(verified.handle, bytes.byteLength);
      await verifyUnchangedOpenFile(verified.handle, filename, verified.snapshot, bytes.byteLength, "staged object");
      if (actual !== expectedSha256) corrupt(new Error("staged object hash mismatch"));
    } finally {
      await verified.handle.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof IntegrationDocumentWorkerError) throw error;
    unavailable(error);
  }
}

async function unlinkVerified(filename, expectedBytes, label) {
  const opened = await openVerifiedPrivateFile(filename, expectedBytes, label);
  if (!opened) return false;
  try {
    await verifyUnchangedOpenFile(opened.handle, filename, opened.snapshot, expectedBytes, label);
  } finally {
    await opened.handle.close().catch(() => {});
  }
  try {
    await fs.unlink(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    unavailable(error);
  }
}

export async function openIntegrationDocumentWorkerStore(options = {}) {
  const stateRoot = String(options.stateRoot || "");
  if (!path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot || stateRoot === path.parse(stateRoot).root) {
    throw new TypeError("document worker stateRoot must be one dedicated canonical absolute path");
  }
  const now = options.now || (() => new Date());
  if (typeof now !== "function") throw new TypeError("document worker now must be a function");
  const checkpoint = options.checkpoint || (() => {});
  if (typeof checkpoint !== "function") throw new TypeError("document worker checkpoint must be a function");
  const paths = Object.freeze({
    root: stateRoot,
    ledger: path.join(stateRoot, LEDGER_FILENAME),
    stages: path.join(stateRoot, STAGES_DIRECTORY),
    objects: path.join(stateRoot, OBJECTS_DIRECTORY),
  });
  let ledger;
  let closed = false;
  let poisoned = false;
  let serial = Promise.resolve();
  const activeStreams = new Map();

  function serialized(operation) {
    const guarded = async () => {
      try {
        return await operation();
      } catch (error) {
        if (error?.documentWorkerFailStop === true) poisoned = true;
        throw error;
      }
    };
    const run = serial.then(guarded, guarded);
    serial = run.catch(() => {});
    return run;
  }

  function assertOpen() {
    if (closed) storeFail("WORKER_STATE_UNAVAILABLE", "Document worker private state is closed.");
    if (poisoned) {
      storeFail(
        "WORKER_STATE_UNAVAILABLE",
        "Document worker private state requires a clean restart after a persistence failure."
      );
    }
  }

  async function readLedgerFile() {
    const named = await fs.lstat(paths.ledger).catch((error) => {
      if (error?.code === "ENOENT") return null;
      unavailable(error);
    });
    if (!named) return null;
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      (named.mode & 0o777) !== 0o600 ||
      named.size < 2 ||
      named.size > MAXIMUM_LEDGER_BYTES ||
      (currentUid() !== null && named.uid !== currentUid())
    ) corrupt(new Error("ledger file metadata is unsafe"));
    let handle;
    try {
      handle = await fs.open(paths.ledger, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      const before = await handle.stat();
      if (!sameFileIdentity(named, before)) corrupt(new Error("ledger changed before read"));
      const text = await handle.readFile("utf8");
      const after = await handle.stat();
      const afterNamed = await fs.lstat(paths.ledger);
      if (
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, afterNamed) ||
        Buffer.byteLength(text, "utf8") !== after.size
      ) corrupt(new Error("ledger changed during read"));
      return parseLedgerEnvelope(text);
    } catch (error) {
      if (error instanceof IntegrationDocumentWorkerError) throw error;
      unavailable(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function saveLedger() {
    let temporary = null;
    let handle;
    let revisionIncremented = false;
    let renamed = false;
    try {
      validateLedger(ledger);
      ledger.revision += 1;
      revisionIncremented = true;
      const envelope = ledgerEnvelope(ledger);
      const bytes = canonicalDocumentWorkerJson(envelope);
      if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_LEDGER_BYTES) {
        storeFail("WORKER_STATE_UNAVAILABLE", "Document worker ledger capacity is exhausted.");
      }
      temporary = path.join(paths.root, `.ledger.stage.${crypto.randomBytes(16).toString("hex")}`);
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0o600
      );
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await checkpoint("before-ledger-rename", { revision: ledger.revision });
      await fs.rename(temporary, paths.ledger);
      renamed = true;
      await checkpoint("after-ledger-rename-before-directory-sync", { revision: ledger.revision });
      await syncDirectory(paths.root);
    } catch (error) {
      poisoned = true;
      await handle?.close().catch(() => {});
      if (!renamed && temporary) await fs.unlink(temporary).catch(() => {});
      if (revisionIncremented) ledger.revision -= 1;
      const failure = error instanceof IntegrationDocumentWorkerError
        ? error
        : new IntegrationDocumentWorkerError(
            "WORKER_STATE_UNAVAILABLE",
            "Document worker private ledger could not be persisted durably.",
            { status: 503, cause: error }
          );
      markFailStop(failure);
      Object.defineProperty(failure, "documentWorkerLedgerRenamed", {
        value: renamed,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      throw failure;
    }
  }

  function findGroupByRequestId(requestId) {
    return ledger.groups.find((group) => group.requestId === requestId) || null;
  }

  function findGroupByReceipt(receiptDigest) {
    return ledger.groups.find((group) => group.receipt.digest === receiptDigest) || null;
  }

  function findArtifact(ref) {
    for (const group of ledger.groups) {
      const artifact = group.artifacts.find((candidate) => candidate.ref === ref);
      if (artifact) return Object.freeze({ group, artifact });
    }
    return null;
  }

  function retainedObjectBytes() {
    let total = 0;
    for (const group of ledger.groups) {
      for (const artifact of group.artifacts) {
        if (new Set(["gone", "tombstoned"]).has(artifact.state)) continue;
        total += artifact.bytes;
        if (!Number.isSafeInteger(total) || total > DOCUMENT_WORKER_LIMITS.maximumStoredBytes) {
          corrupt(new Error("retained object byte accounting exceeds its hard bound"));
        }
      }
    }
    return total;
  }

  function groupPath(group, artifact) {
    const directory = new Set(["staged", "committing"]).has(group.state) && artifact.state === "staged"
      ? paths.stages
      : paths.objects;
    return path.join(directory, artifact.ref);
  }

  function scopeMatchesGroup(scope, group) {
    const digests = deriveDocumentWorkerScopeDigests(scope);
    return (
      group.ownerDigest === digests.ownerDigest &&
      group.threadDigest === digests.threadDigest &&
      group.runDigest === digests.runDigest &&
      group.scopeDigest === digests.scopeDigest
    );
  }

  function contentNotFound() {
    documentWorkerFail("NOT_FOUND", "Artifact was not found.", { status: 404 });
  }

  async function finishPendingCommit(group) {
    if (group.state !== "committing" || !group.pendingCommit) corrupt(new Error("commit recovery state is invalid"));
    for (const artifact of group.artifacts) {
      const staged = path.join(paths.stages, artifact.ref);
      const final = path.join(paths.objects, artifact.ref);
      const finalStat = await fs.lstat(final).catch((error) => {
        if (error?.code === "ENOENT") return null;
        unavailable(error);
      });
      const stageStat = await fs.lstat(staged).catch((error) => {
        if (error?.code === "ENOENT") return null;
        unavailable(error);
      });
      if (finalStat && stageStat) corrupt(new Error("commit has both staged and final object"));
      if (!finalStat && !stageStat) corrupt(new Error("commit object disappeared"));
      if (stageStat) {
        const opened = await openVerifiedPrivateFile(staged, artifact.bytes, "commit staged object");
        if (!opened) corrupt(new Error("commit staged object disappeared"));
        try {
          const hash = await hashOpenFile(opened.handle, artifact.bytes);
          await verifyUnchangedOpenFile(opened.handle, staged, opened.snapshot, artifact.bytes, "commit staged object");
          if (hash !== artifact.sha256) corrupt(new Error("commit staged object hash mismatch"));
        } finally {
          await opened.handle.close().catch(() => {});
        }
        try {
          await fs.rename(staged, final);
        } catch (error) {
          unavailable(error);
        }
      } else {
        const opened = await openVerifiedPrivateFile(final, artifact.bytes, "committed object");
        if (!opened) corrupt(new Error("committed object disappeared"));
        try {
          const hash = await hashOpenFile(opened.handle, artifact.bytes);
          await verifyUnchangedOpenFile(opened.handle, final, opened.snapshot, artifact.bytes, "committed object");
          if (hash !== artifact.sha256) corrupt(new Error("committed object hash mismatch"));
        } finally {
          await opened.handle.close().catch(() => {});
        }
      }
      artifact.state = "committed";
    }
    await syncDirectory(paths.stages);
    await syncDirectory(paths.objects);
    const pending = group.pendingCommit;
    group.state = "committed";
    group.committedAt = pending.response.committedAt;
    group.pendingCommit = null;
    if (!ledger.commitRequests.some((record) => record.requestId === pending.response.requestId)) {
      ledger.commitRequests.push({
        requestId: pending.response.requestId,
        requestDigest: pending.requestDigest,
        response: pending.response,
      });
    }
    await saveLedger();
  }

  async function closeActiveRef(ref) {
    const entries = [...(activeStreams.get(ref) || [])];
    for (const entry of entries) {
      entry.stream.destroy(new Error("artifact deleted"));
      await entry.handle.close().catch(() => {});
      activeStreams.get(ref)?.delete(entry);
    }
    if (activeStreams.get(ref)?.size === 0) activeStreams.delete(ref);
  }

  async function finishPendingDeletion(deletion) {
    if (deletion.status !== "committing") corrupt(new Error("delete recovery state is invalid"));
    for (const object of deletion.objects) {
      const found = findArtifact(object.ref);
      if (!found) corrupt(new Error("delete recovery ref is missing from ledger"));
      await closeActiveRef(object.ref);
      const candidatePaths = [
        path.join(paths.objects, object.ref),
        path.join(paths.stages, object.ref),
      ];
      for (const filename of candidatePaths) {
        await unlinkVerified(filename, found.artifact.bytes, "deleted object");
      }
      found.artifact.state = "tombstoned";
      found.group.state = "tombstoned";
      found.group.deletionId = deletion.deletionId;
    }
    await syncDirectory(paths.objects);
    await syncDirectory(paths.stages);
    const completedAt = currentTimestamp(now);
    const tombstoneUnsigned = {
      schemaVersion: DELETE_TOMBSTONE_SCHEMA_VERSION,
      deletionId: deletion.deletionId,
      manifestDigest: deletion.manifestDigest,
      ownerDigest: deletion.ownerDigest,
      threadDigest: deletion.threadDigest,
      completedAt,
    };
    deletion.status = "committed";
    deletion.completedAt = completedAt;
    deletion.tombstoneDigest = contractDigest(tombstoneUnsigned);
    await saveLedger();
  }

  async function reapExpiredStagedGroups() {
    const cutoff = now().getTime() - DOCUMENT_WORKER_STAGED_GROUP_TTL_MS;
    const expired = ledger.groups.filter((group) =>
      group.state === "staged" && Date.parse(group.createdAt) <= cutoff
    );
    if (expired.length === 0) return 0;
    for (const group of expired) {
      for (const artifact of group.artifacts) {
        if (artifact.state !== "staged") corrupt(new Error("expired staged group lifecycle is inconsistent"));
        await unlinkVerified(path.join(paths.stages, artifact.ref), artifact.bytes, "expired staged object");
      }
    }
    await syncDirectory(paths.stages);
    const expiredIds = new Set(expired.map((group) => group.groupId));
    ledger.groups = ledger.groups.filter((group) => !expiredIds.has(group.groupId));
    await saveLedger();
    return expired.length;
  }

  async function reconcileDirectoryEntries() {
    const rootEntries = await fs.readdir(paths.root);
    if (rootEntries.length > MAXIMUM_DIRECTORY_ENTRIES) unavailable(new Error("state root entry bound exceeded"));
    for (const name of rootEntries) {
      if (!name.startsWith(".ledger.stage.")) continue;
      if (!/^\.ledger\.stage\.[a-f0-9]{32}$/u.test(name)) corrupt(new Error("unknown ledger stage entry"));
      const filename = path.join(paths.root, name);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        corrupt(new Error("ledger stage entry is unsafe"));
      }
      await fs.unlink(filename);
    }

    const referencedStages = new Set();
    const referencedObjects = new Set();
    for (const group of ledger.groups) {
      for (const artifact of group.artifacts) {
        if (artifact.state === "staged") referencedStages.add(artifact.ref);
        if (artifact.state === "committed" || group.state === "delete-prepared" || group.state === "deleting") {
          referencedObjects.add(artifact.ref);
        }
      }
    }
    const stageEntries = await fs.readdir(paths.stages);
    if (stageEntries.length > MAXIMUM_DIRECTORY_ENTRIES) unavailable(new Error("stage entry bound exceeded"));
    for (const name of stageEntries) {
      if (!DOCUMENT_WORKER_PATTERNS.objectRef.test(name)) corrupt(new Error("unknown stage filename"));
      if (referencedStages.has(name)) continue;
      const found = await fs.lstat(path.join(paths.stages, name));
      if (!found.isFile() || found.isSymbolicLink() || found.nlink !== 1 || (found.mode & 0o777) !== 0o600) {
        corrupt(new Error("orphan stage object is unsafe"));
      }
      await fs.unlink(path.join(paths.stages, name));
    }
    if (stageEntries.some((name) => !referencedStages.has(name))) await syncDirectory(paths.stages);

    const objectEntries = await fs.readdir(paths.objects);
    if (objectEntries.length > MAXIMUM_DIRECTORY_ENTRIES) unavailable(new Error("object entry bound exceeded"));
    for (const name of objectEntries) {
      if (!DOCUMENT_WORKER_PATTERNS.objectRef.test(name)) corrupt(new Error("unknown object filename"));
      const record = findArtifact(name);
      if (!record) corrupt(new Error("unreferenced committed object requires operator review"));
      if (record.artifact.state === "tombstoned" || record.artifact.state === "gone") {
        await unlinkVerified(path.join(paths.objects, name), record.artifact.bytes, "tombstoned object");
        continue;
      }
      if (!referencedObjects.has(name)) corrupt(new Error("committed object lifecycle is inconsistent"));
    }
    await syncDirectory(paths.objects);
  }

  async function initialize() {
    try {
      await fs.mkdir(paths.root, { recursive: false, mode: 0o700 });
      await syncDirectory(path.dirname(paths.root));
    } catch (error) {
      if (error?.code !== "EEXIST") unavailable(error);
    }
    await ensurePrivateDirectory(paths.root);
    await ensurePrivateDirectory(paths.stages, { create: true });
    await ensurePrivateDirectory(paths.objects, { create: true });
    ledger = await readLedgerFile();
    if (!ledger) {
      ledger = initialLedger();
      await saveLedger();
    }
    for (const group of ledger.groups.filter((candidate) => candidate.state === "committing")) {
      await finishPendingCommit(group);
    }
    for (const deletion of ledger.deletions.filter((candidate) => candidate.status === "committing")) {
      await finishPendingDeletion(deletion);
    }
    await reapExpiredStagedGroups();
    await reconcileDirectoryEntries();
  }

  await initialize();

  const store = {
    schemaVersion: DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION,

    async lookupCompile(request) {
      return serialized(async () => {
        assertOpen();
        await reapExpiredStagedGroups();
        const requestDigest = digestNormalizedDocumentWorkerRequest(request);
        const existing = findGroupByRequestId(request.requestId);
        if (!existing) return null;
        if (existing.requestDigest !== requestDigest || !scopeMatchesGroup(request.scope, existing)) {
          documentWorkerFail("IDEMPOTENCY_CONFLICT", "Compile request id was already used.", { status: 409 });
        }
        if (existing.state === "tombstoned") {
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "Compiled artifact group was deleted.", { status: 410 });
        }
        if (new Set(["delete-prepared", "deleting"]).has(existing.state)) {
          documentWorkerFail("ARTIFACT_DELETE_PENDING", "Compiled artifact group is being deleted.", { status: 503 });
        }
        return compileResponse(existing);
      });
    },

    async stageCompile({ request, evidence, compiled }) {
      return serialized(async () => {
        assertOpen();
        await reapExpiredStagedGroups();
        const requestDigest = digestNormalizedDocumentWorkerRequest(request);
        const existing = findGroupByRequestId(request.requestId);
        if (existing) {
          if (existing.requestDigest !== requestDigest || !scopeMatchesGroup(request.scope, existing)) {
            documentWorkerFail("IDEMPOTENCY_CONFLICT", "Compile request id was already used.", { status: 409 });
          }
          return compileResponse(existing);
        }
        if (ledger.groups.length >= MAXIMUM_GROUPS) {
          storeFail("WORKER_STATE_UNAVAILABLE", "Document worker group capacity is exhausted.");
        }
        const sourceBytes = Buffer.isBuffer(compiled?.source?.bytes) ? compiled.source.bytes : null;
        const pdfBytes = Buffer.isBuffer(compiled?.pdf?.bytes) ? compiled.pdf.bytes : null;
        if (
          !sourceBytes ||
          !pdfBytes ||
          compiled.source.sha256 !== request.sourceSha256 ||
          crypto.createHash("sha256").update(sourceBytes).digest("hex") !== compiled.source.sha256 ||
          crypto.createHash("sha256").update(pdfBytes).digest("hex") !== compiled.pdf.sha256
        ) corrupt(new Error("compiler payload is inconsistent"));
        const compilerReceipt = compiled.compilerReceipt;
        if (
          !compilerReceipt ||
          compilerReceipt.sourceSha256 !== compiled.source.sha256 ||
          compilerReceipt.sourceBytes !== sourceBytes.byteLength ||
          compilerReceipt.pdfSha256 !== compiled.pdf.sha256 ||
          compilerReceipt.pdfBytes !== pdfBytes.byteLength
        ) corrupt(new Error("compiler receipt is inconsistent"));
        const requestedBytes = sourceBytes.byteLength + pdfBytes.byteLength;
        const retainedBytes = retainedObjectBytes();
        if (requestedBytes > DOCUMENT_WORKER_LIMITS.maximumStoredBytes - retainedBytes) {
          storeFail("WORKER_STATE_UNAVAILABLE", "Document worker private object quota is exhausted.");
        }
        const refs = [
          randomDocumentWorkerId("wobj_", 32),
          randomDocumentWorkerId("wobj_", 32),
        ];
        const artifacts = Object.freeze([
          Object.freeze({
            ref: refs[0],
            role: "source",
            filename: compiled.source.filename,
            mime: "application/x-tex",
            bytes: sourceBytes.byteLength,
            sha256: compiled.source.sha256,
          }),
          Object.freeze({
            ref: refs[1],
            role: "pdf",
            filename: compiled.pdf.filename,
            mime: "application/pdf",
            bytes: pdfBytes.byteLength,
            sha256: compiled.pdf.sha256,
          }),
        ]);
        validateDocumentWorkerCompileArtifacts(artifacts);
        const digests = deriveDocumentWorkerScopeDigests(request.scope);
        const groupId = randomDocumentWorkerId("wgrp_", 32);
        const receiptUnsigned = Object.freeze({
          schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.receipt,
          receiptId: randomDocumentWorkerId("wrcp_", 24),
          groupId,
          ...digests,
          requestId: request.requestId,
          requestDigest,
          requirementsDigest: evidence.requirementsDigest,
          verifiedFigureCount: evidence.verifiedFigureCount,
          artifactsDigest: documentWorkerArtifactsDigest(artifacts),
          compilerDigest: compilerReceipt.compilerDigest,
          compileLogSha256: compilerReceipt.compileLogSha256,
          sourceSha256: compilerReceipt.sourceSha256,
          sourceBytes: compilerReceipt.sourceBytes,
          pdfSha256: compilerReceipt.pdfSha256,
          pdfBytes: compilerReceipt.pdfBytes,
          networkNone: true,
          shellEscape: false,
          issuedAt: compilerReceipt.issuedAt,
        });
        const receipt = Object.freeze({ ...receiptUnsigned, digest: contractDigest(receiptUnsigned) });
        validateDocumentWorkerReceipt(receipt);
        const stagePaths = refs.map((ref) => path.join(paths.stages, ref));
        let group = null;
        try {
          await writePrivateStage(stagePaths[0], sourceBytes, artifacts[0].sha256);
          await writePrivateStage(stagePaths[1], pdfBytes, artifacts[1].sha256);
          await syncDirectory(paths.stages);
          await checkpoint("after-stage-files-before-ledger", {
            requestId: request.requestId,
            refs: Object.freeze([...refs]),
          });
          const createdAt = currentTimestamp(now);
          group = {
            groupId,
            state: "staged",
            ...digests,
            requestId: request.requestId,
            requestDigest,
            requirementsDigest: evidence.requirementsDigest,
            verifiedFigureCount: evidence.verifiedFigureCount,
            receipt: { ...receipt },
            artifacts: artifacts.map((artifact) => ({ ...artifact, state: "staged" })),
            createdAt,
            committedAt: null,
            deletionId: null,
            pendingCommit: null,
          };
          ledger.groups.push(group);
          await saveLedger();
          return compileResponse(group);
        } catch (error) {
          if (error?.documentWorkerLedgerRenamed !== true) {
            if (group && ledger.groups.at(-1) === group) ledger.groups.pop();
            await Promise.allSettled(stagePaths.map((filename) => fs.unlink(filename)));
            await syncDirectory(paths.stages).catch(() => {});
          }
          throw error;
        }
      });
    },

    async commit(request) {
      return serialized(async () => {
        assertOpen();
        await reapExpiredStagedGroups();
        const requestDigest = digestNormalizedDocumentWorkerRequest(request);
        const replay = ledger.commitRequests.find((record) => record.requestId === request.requestId);
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            documentWorkerFail("IDEMPOTENCY_CONFLICT", "Commit request id was already used.", { status: 409 });
          }
          return Object.freeze({ ...replay.response });
        }
        const group = findGroupByReceipt(request.receiptDigest);
        if (!group || !scopeMatchesGroup(request.scope, group)) contentNotFound();
        const expectedObjects = documentWorkerCommitManifest(group.artifacts.map(publicArtifact));
        if (canonicalJson(expectedObjects) !== canonicalJson(request.objects)) contentNotFound();
        if (group.state === "tombstoned") {
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "Compiled artifact group was deleted.", { status: 410 });
        }
        if (new Set(["delete-prepared", "deleting"]).has(group.state)) {
          documentWorkerFail("ARTIFACT_DELETE_PENDING", "Compiled artifact group is being deleted.", { status: 503 });
        }
        const manifestDigest = documentWorkerManifestDigest(request.objects);
        const committedAt = group.committedAt || currentTimestamp(now);
        const responseUnsigned = {
          schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.commitResponse,
          requestId: request.requestId,
          receiptDigest: group.receipt.digest,
          status: "committed",
          manifestDigest,
          committedAt,
        };
        const response = Object.freeze({ ...responseUnsigned, digest: contractDigest(responseUnsigned) });
        if (group.state === "committed") {
          if (ledger.commitRequests.length >= MAXIMUM_COMMIT_REQUESTS) {
            storeFail("WORKER_STATE_UNAVAILABLE", "Document worker commit receipt capacity is exhausted.");
          }
          ledger.commitRequests.push({ requestId: request.requestId, requestDigest, response: { ...response } });
          await saveLedger();
          return response;
        }
        if (group.state !== "staged") corrupt(new Error("group cannot enter commit lifecycle"));
        group.state = "committing";
        group.pendingCommit = {
          requestDigest,
          response: { ...response },
        };
        await saveLedger();
        await checkpoint("after-commit-ledger-before-objects", { requestId: request.requestId });
        await finishPendingCommit(group);
        await checkpoint("after-commit-objects-and-ledger", { requestId: request.requestId });
        return response;
      });
    },

    async openContent(request) {
      return serialized(async () => {
        assertOpen();
        const found = findArtifact(request.ref);
        if (
          !found ||
          !scopeMatchesGroup(request.scope, found.group) ||
          found.group.receipt.digest !== request.receiptDigest ||
          found.group.state === "staged" ||
          found.group.state === "committing"
        ) contentNotFound();
        if (found.group.state === "tombstoned" || found.artifact.state === "tombstoned" || found.artifact.state === "gone") {
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "Artifact content is no longer available.", { status: 410 });
        }
        if (new Set(["delete-prepared", "deleting"]).has(found.group.state)) {
          documentWorkerFail("ARTIFACT_DELETE_PENDING", "Artifact content deletion is pending.", { status: 503 });
        }
        if (found.group.state !== "committed" || found.artifact.state !== "committed") {
          corrupt(new Error("artifact content lifecycle is invalid"));
        }
        let start = 0;
        let end = found.artifact.bytes - 1;
        if (request.range !== undefined) {
          start = request.range.start;
          if (start >= found.artifact.bytes) {
            const error = new IntegrationDocumentWorkerError(
              "RANGE_NOT_SATISFIABLE",
              "Artifact range is not satisfiable.",
              { status: 416 }
            );
            error.totalBytes = found.artifact.bytes;
            throw error;
          }
          end = request.range.end === undefined
            ? found.artifact.bytes - 1
            : Math.min(request.range.end, found.artifact.bytes - 1);
        }
        const filename = path.join(paths.objects, found.artifact.ref);
        const opened = await openVerifiedPrivateFile(filename, found.artifact.bytes, "committed artifact");
        if (!opened) {
          found.artifact.state = "gone";
          await saveLedger();
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "Artifact content is no longer available.", { status: 410 });
        }
        try {
          const hash = await hashOpenFile(opened.handle, found.artifact.bytes);
          await verifyUnchangedOpenFile(
            opened.handle,
            filename,
            opened.snapshot,
            found.artifact.bytes,
            "committed artifact"
          );
          if (hash !== found.artifact.sha256) corrupt(new Error("committed artifact hash mismatch"));
        } catch (error) {
          await opened.handle.close().catch(() => {});
          throw error;
        }
        const metadata = Object.freeze({
          ref: found.artifact.ref,
          role: found.artifact.role,
          filename: found.artifact.filename,
          mime: found.artifact.mime,
          totalBytes: found.artifact.bytes,
          sha256: found.artifact.sha256,
          start,
          end,
          selectedBytes: end - start + 1,
          partial: request.range !== undefined,
          metadataOnly: request.metadataOnly,
        });
        if (request.metadataOnly) {
          await opened.handle.close();
          return Object.freeze({ metadata, stream: null, release: async () => {} });
        }
        const stream = opened.handle.createReadStream({ start, end, autoClose: false });
        const entry = { handle: opened.handle, stream, released: false };
        if (!activeStreams.has(found.artifact.ref)) activeStreams.set(found.artifact.ref, new Set());
        activeStreams.get(found.artifact.ref).add(entry);
        const release = async () => {
          if (entry.released) return;
          entry.released = true;
          activeStreams.get(found.artifact.ref)?.delete(entry);
          if (activeStreams.get(found.artifact.ref)?.size === 0) activeStreams.delete(found.artifact.ref);
          await opened.handle.close().catch(() => {});
        };
        stream.once("close", () => { void release(); });
        stream.once("end", () => { void release(); });
        return Object.freeze({ metadata, stream, release });
      });
    },

    async delete(request) {
      return serialized(async () => {
        assertOpen();
        await reapExpiredStagedGroups();
        const { ownerDigest, threadDigest } = deriveDocumentWorkerThreadDigests(request.scope);
        const manifestDigest = contractDigest({
          schemaVersion: DELETE_MANIFEST_SCHEMA_VERSION,
          deletionId: request.deletionId,
          scope: request.scope,
          objects: request.objects,
        });
        let deletion = ledger.deletions.find((record) => record.deletionId === request.deletionId) || null;
        if (deletion && deletion.manifestDigest !== manifestDigest) {
          documentWorkerFail("IDEMPOTENCY_CONFLICT", "Deletion id was already used.", { status: 409 });
        }
        if (!deletion && request.phase !== "prepare") {
          documentWorkerFail("NOT_FOUND", "Deletion was not found.", { status: 404 });
        }
        if (!deletion) {
          if (ledger.deletions.length >= MAXIMUM_DELETIONS) {
            storeFail("WORKER_STATE_UNAVAILABLE", "Document worker deletion capacity is exhausted.");
          }
          const storedObjects = [];
          const groups = new Set();
          for (const object of request.objects) {
            const found = findArtifact(object.ref);
            if (!found || found.group.ownerDigest !== ownerDigest || found.group.threadDigest !== threadDigest) {
              contentNotFound();
            }
            const runDigest = contractDigest({
              schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.run,
              threadDigest,
              runId: object.runId,
            });
            if (
              found.group.runDigest !== runDigest ||
              found.group.receipt.digest !== object.receiptDigest ||
              found.group.deletionId !== null
            ) contentNotFound();
            storedObjects.push({ ref: object.ref, runDigest, receiptDigest: object.receiptDigest });
            groups.add(found.group);
          }
          const requestedRefs = new Set(storedObjects.map((object) => object.ref));
          for (const group of groups) {
            if (group.artifacts.some((artifact) => !requestedRefs.has(artifact.ref))) {
              documentWorkerFail(
                "INVALID_REQUEST",
                "Deletion must include the complete source/PDF artifact group.",
                { status: 400 }
              );
            }
          }
          const preparedAt = currentTimestamp(now);
          deletion = {
            deletionId: request.deletionId,
            manifestDigest,
            ownerDigest,
            threadDigest,
            status: "prepared",
            objects: storedObjects,
            preparedAt,
            completedAt: null,
            tombstoneDigest: null,
          };
          ledger.deletions.push(deletion);
          for (const group of groups) {
            group.state = "delete-prepared";
            group.deletionId = deletion.deletionId;
          }
          await saveLedger();
        }
        if (request.phase === "commit" && deletion.status === "prepared") {
          deletion.status = "committing";
          for (const object of deletion.objects) {
            const found = findArtifact(object.ref);
            if (!found) corrupt(new Error("deletion ref disappeared from ledger"));
            found.group.state = "deleting";
          }
          await saveLedger();
          await checkpoint("after-delete-ledger-before-unlink", { deletionId: deletion.deletionId });
          await finishPendingDeletion(deletion);
          await checkpoint("after-delete-unlink-and-ledger", { deletionId: deletion.deletionId });
        }
        const responseUnsigned = {
          schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteResponse,
          deletionId: deletion.deletionId,
          phase: request.phase,
          status: deletion.status === "committed" ? "committed" : "prepared",
          manifestDigest: deletion.manifestDigest,
          tombstoneDigest: deletion.tombstoneDigest,
          completedAt: deletion.completedAt,
        };
        return Object.freeze({ ...responseUnsigned, digest: contractDigest(responseUnsigned) });
      });
    },

    async inspect() {
      return serialized(async () => {
        assertOpen();
        await reapExpiredStagedGroups();
        return Object.freeze({
          schemaVersion: DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION,
          revision: ledger.revision,
          groups: ledger.groups.length,
          stagedGroups: ledger.groups.filter((group) => group.state === "staged").length,
          committedGroups: ledger.groups.filter((group) => group.state === "committed").length,
          tombstonedGroups: ledger.groups.filter((group) => group.state === "tombstoned").length,
          pendingDeletions: ledger.deletions.filter((record) => record.status !== "committed").length,
          digest: contractDigest({
            schemaVersion: DOCUMENT_WORKER_LEDGER_SCHEMA_VERSION,
            revision: ledger.revision,
            groups: ledger.groups.map((group) => group.receipt.digest),
            deletions: ledger.deletions.map((record) => record.tombstoneDigest || record.manifestDigest),
          }),
        });
      });
    },

    async close() {
      return serialized(async () => {
        if (closed) return;
        closed = true;
        for (const ref of [...activeStreams.keys()]) await closeActiveRef(ref);
      });
    },
  };
  STORE_BRAND.add(store);
  return Object.freeze(store);
}

export function assertIntegrationDocumentWorkerStore(value) {
  if (!value || !STORE_BRAND.has(value)) throw new TypeError("document worker store is not AgInTi-owned");
  return value;
}
