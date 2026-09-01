import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  FILE_WORKER_LIMITS,
  FILE_WORKER_PATTERNS,
  FILE_WORKER_SCHEMA_VERSIONS,
  canonicalFileWorkerJson,
  digestFileWorkerContent,
  digestFileWorkerPublishOperation,
  fileWorkerArtifactsDigest,
  fileWorkerDeletionManifestDigest,
  fileWorkerCommitManifest,
  fileWorkerManifestDigest,
  fileWorkerScopeDigests,
  fileWorkerThreadDigests,
  isNormalizedFileWorkerPublishRequest,
  randomFileWorkerId,
  validateFileWorkerArtifacts,
  validateFileWorkerCommitRequest,
  validateFileWorkerDeleteRequest,
  validateFileWorkerIssueRequest,
  validateFileWorkerPublishRequest,
  validateFileWorkerReceipt,
} from "./integration-file-worker-contract.js";
import {
  IntegrationDocumentWorkerError,
  documentWorkerFail,
} from "./integration-document-worker-contract.js";
import { canonicalJson, contractDigest } from "./integration-policy.js";

export const FILE_WORKER_LEDGER_SCHEMA_VERSION = "aginti-file-worker-ledger-v1";
export const FILE_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION = "aginti-file-worker-ledger-envelope-v1";
export const FILE_WORKER_STAGED_GROUP_TTL_MS = 24 * 60 * 60 * 1000;

const LEDGER_FILENAME = "ledger.json";
const STAGES_DIRECTORY = "stages";
const OBJECTS_DIRECTORY = "objects";
const MAXIMUM_LEDGER_BYTES = 16 * 1024 * 1024;
const MAXIMUM_DIRECTORY_ENTRIES = 8192;
const MAXIMUM_GROUPS = 4096;
const MAXIMUM_RESERVATIONS = 4096;
const MAXIMUM_RESERVATIONS_PER_OWNER = 64;
const MAXIMUM_COMMITS = 8192;
const MAXIMUM_DELETIONS = 4096;
const DELETE_TOMBSTONE_SCHEMA_VERSION = "aginti-file-worker-delete-tombstone-v1";
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);
const O_DIRECTORY = Number(fsConstants.O_DIRECTORY || 0);
const STORE_BRAND = new WeakSet();

function failStop(cause) {
  const error = new IntegrationDocumentWorkerError(
    "WORKER_STATE_UNAVAILABLE",
    "File worker private state failed integrity validation.",
    { status: 503, cause }
  );
  Object.defineProperty(error, "documentWorkerFailStop", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  throw error;
}

function unavailable(message, cause) {
  const error = new IntegrationDocumentWorkerError("WORKER_STATE_UNAVAILABLE", message, { status: 503, cause });
  if (cause) {
    Object.defineProperty(error, "documentWorkerFailStop", {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  throw error;
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    failStop(new Error(`${label} is not a plain object`));
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) {
    failStop(new Error(`${label} keys are invalid`));
  }
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      failStop(new Error(`${label} contains a non-data field`));
    }
  }
  return value;
}

function list(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    failStop(new Error(`${label} is invalid`));
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) failStop(new Error(`${label} is sparse`));
  }
  return value;
}

function stateDigest(value, label) {
  if (typeof value !== "string" || !FILE_WORKER_PATTERNS.digest.test(value)) {
    failStop(new Error(`${label} is invalid`));
  }
  return value;
}

function stateTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    failStop(new Error(`${label} is invalid`));
  }
  return value;
}

function currentTimestamp(now) {
  const value = now().toISOString();
  if (new Date(value).toISOString() !== value) throw new TypeError("file worker now must return a valid Date");
  return value;
}

function publicArtifact(record) {
  return Object.freeze({
    ref: record.ref,
    index: record.index,
    filename: record.filename,
    mime: record.mime,
    bytes: record.bytes,
    sha256: record.sha256,
  });
}

function publishResponse(group) {
  return Object.freeze({
    schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.publishResponse,
    requestId: group.requestId,
    receipt: Object.freeze({ ...group.receipt }),
    artifacts: Object.freeze(group.artifacts.map(publicArtifact)),
  });
}

function publishReplay(group) {
  if (group.state === "tombstoned" || group.artifacts.some(({ state }) => state === "gone" || state === "tombstoned")) {
    documentWorkerFail("ARTIFACT_CONTENT_GONE", "Published file group was deleted.", { status: 410 });
  }
  if (new Set(["delete-prepared", "deleting"]).has(group.state)) {
    documentWorkerFail("ARTIFACT_DELETE_PENDING", "Published file group is being deleted.", { status: 503 });
  }
  return publishResponse(group);
}

function validateStoredArtifact(record, index) {
  exact(record, ["ref", "index", "filename", "mime", "bytes", "sha256", "state"], `stored file ${index}`);
  if (!new Set(["staged", "committed", "gone", "tombstoned"]).has(record.state)) {
    failStop(new Error("stored file state is invalid"));
  }
  let artifact;
  try {
    artifact = validateFileWorkerArtifacts([publicArtifact(record)])[0];
  } catch (error) {
    if (index !== 0) {
      try {
        artifact = validateFileWorkerArtifacts(Array.from({ length: index + 1 }, (_, candidateIndex) => (
          candidateIndex === index
            ? publicArtifact(record)
            : {
                ref: `fobj_${String.fromCharCode(65 + candidateIndex).repeat(43)}`,
                index: candidateIndex,
                filename: `placeholder-${candidateIndex}.txt`,
                mime: "text/plain",
                bytes: 1,
                sha256: String(candidateIndex % 10).repeat(64),
              }
        )))[index];
      } catch (nested) {
        failStop(nested);
      }
    } else {
      failStop(error);
    }
  }
  return artifact;
}

function validateStoredCommitResponse(value) {
  exact(value, ["schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest"], "stored file commit response");
  if (
    value.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.commitResponse ||
    !FILE_WORKER_PATTERNS.commitRequestId.test(value.requestId) ||
    value.status !== "committed"
  ) failStop(new Error("stored file commit response is invalid"));
  for (const key of ["receiptDigest", "manifestDigest", "digest"]) stateDigest(value[key], `file commit ${key}`);
  stateTimestamp(value.committedAt, "file commit timestamp");
  const { digest, ...unsigned } = value;
  if (contractDigest(unsigned) !== digest) failStop(new Error("stored file commit response digest is invalid"));
}

function validateStoredGroup(group) {
  exact(group, [
    "groupId", "state", "ownerDigest", "threadDigest", "runDigest", "scopeDigest", "requestId",
    "authorityEpoch", "requestDigest", "receipt", "artifacts", "createdAt", "committedAt", "deletionId",
    "pendingCommit",
  ], "stored file group");
  if (
    !FILE_WORKER_PATTERNS.groupId.test(group.groupId) ||
    !FILE_WORKER_PATTERNS.requestId.test(group.requestId) ||
    !Number.isSafeInteger(group.authorityEpoch) || group.authorityEpoch < 1 ||
    !new Set(["staged", "committing", "committed", "delete-prepared", "deleting", "tombstoned"]).has(group.state)
  ) failStop(new Error("stored file group identity is invalid"));
  for (const key of ["ownerDigest", "threadDigest", "runDigest", "scopeDigest", "requestDigest"]) {
    stateDigest(group[key], `file group ${key}`);
  }
  let receipt;
  try { receipt = validateFileWorkerReceipt(group.receipt); } catch (error) { failStop(error); }
  if (
    receipt.groupId !== group.groupId || receipt.requestId !== group.requestId ||
    receipt.ownerDigest !== group.ownerDigest || receipt.threadDigest !== group.threadDigest ||
    receipt.runDigest !== group.runDigest || receipt.scopeDigest !== group.scopeDigest ||
    receipt.requestDigest !== group.requestDigest
  ) failStop(new Error("stored file receipt binding is invalid"));
  const artifacts = list(group.artifacts, FILE_WORKER_LIMITS.maximumFiles, "stored group files");
  if (artifacts.length < 1) failStop(new Error("stored file group is empty"));
  artifacts.forEach(validateStoredArtifact);
  if (
    receipt.fileCount !== artifacts.length ||
    receipt.totalBytes !== artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) ||
    receipt.artifactsDigest !== fileWorkerArtifactsDigest(artifacts.map(publicArtifact))
  ) failStop(new Error("stored file receipt metadata is inconsistent"));
  const states = artifacts.map(({ state }) => state);
  if (new Set(["staged", "committing"]).has(group.state) && states.some((state) => state !== "staged")) {
    failStop(new Error("stored staged file lifecycle is invalid"));
  }
  if (group.state === "committed" && states.some((state) => !new Set(["committed", "gone"]).has(state))) {
    failStop(new Error("stored committed file lifecycle is invalid"));
  }
  if (new Set(["delete-prepared", "deleting"]).has(group.state) && states.some((state) => state !== "committed")) {
    failStop(new Error("stored deleting file lifecycle is invalid"));
  }
  if (group.state === "tombstoned" && states.some((state) => state !== "tombstoned")) {
    failStop(new Error("stored tombstoned file lifecycle is invalid"));
  }
  stateTimestamp(group.createdAt, "file group createdAt");
  stateTimestamp(group.committedAt, "file group committedAt", { nullable: true });
  if (group.deletionId !== null && !FILE_WORKER_PATTERNS.deletionId.test(group.deletionId)) {
    failStop(new Error("stored file group deletionId is invalid"));
  }
  if (group.pendingCommit !== null) {
    exact(group.pendingCommit, ["requestDigest", "response"], "file pending commit");
    stateDigest(group.pendingCommit.requestDigest, "file pending commit digest");
    validateStoredCommitResponse(group.pendingCommit.response);
  }
  if ((group.state === "committing") !== (group.pendingCommit !== null)) {
    failStop(new Error("stored file pending commit lifecycle is invalid"));
  }
  if ((group.committedAt === null) !== new Set(["staged", "committing"]).has(group.state)) {
    failStop(new Error("stored file committed timestamp lifecycle is invalid"));
  }
  if ((group.deletionId === null) !== new Set(["staged", "committing", "committed"]).has(group.state)) {
    failStop(new Error("stored file deletion lifecycle is invalid"));
  }
}

function validateStoredReservation(record) {
  exact(record, [
    "issuanceId", "issueRequestDigest", "requestId", "authorityEpoch", "authorityToken",
    "authorityTokenDigest", "contentDigest", "ownerDigest", "threadDigest", "runDigest", "scopeDigest", "createdAt",
  ], "stored file reservation");
  if (
    !FILE_WORKER_PATTERNS.issuanceId.test(record.issuanceId) ||
    !FILE_WORKER_PATTERNS.requestId.test(record.requestId) ||
    !FILE_WORKER_PATTERNS.authorityToken.test(record.authorityToken) ||
    !Number.isSafeInteger(record.authorityEpoch) || record.authorityEpoch < 1
  ) failStop(new Error("stored file reservation identity is invalid"));
  for (const key of ["issueRequestDigest", "authorityTokenDigest", "contentDigest", "ownerDigest", "threadDigest", "runDigest", "scopeDigest"]) {
    stateDigest(record[key], `file reservation ${key}`);
  }
  stateTimestamp(record.createdAt, "file reservation createdAt");
  if (crypto.createHash("sha256").update(record.authorityToken, "utf8").digest("hex") !== record.authorityTokenDigest) {
    failStop(new Error("stored file reservation token is inconsistent"));
  }
}

function validateStoredCommit(record) {
  exact(record, ["requestId", "requestDigest", "response"], "stored file commit");
  if (!FILE_WORKER_PATTERNS.commitRequestId.test(record.requestId)) failStop(new Error("stored file commit id is invalid"));
  stateDigest(record.requestDigest, "stored file commit request digest");
  validateStoredCommitResponse(record.response);
}

function validateStoredDeletion(record) {
  exact(record, [
    "deletionId", "manifestDigest", "ownerDigest", "threadDigest", "status", "objects", "preparedAt",
    "completedAt", "tombstoneDigest",
  ], "stored file deletion");
  if (!FILE_WORKER_PATTERNS.deletionId.test(record.deletionId) || !new Set(["prepared", "committing", "committed"]).has(record.status)) {
    failStop(new Error("stored file deletion identity is invalid"));
  }
  for (const key of ["manifestDigest", "ownerDigest", "threadDigest"]) stateDigest(record[key], `file deletion ${key}`);
  const objects = list(record.objects, FILE_WORKER_LIMITS.maximumDeleteObjects, "stored file deletion objects");
  if (objects.length < 1) failStop(new Error("stored file deletion is empty"));
  for (const object of objects) {
    exact(object, ["ref", "runDigest", "receiptDigest"], "stored file delete object");
    if (!FILE_WORKER_PATTERNS.objectRef.test(object.ref)) failStop(new Error("stored file delete ref is invalid"));
    stateDigest(object.runDigest, "stored file delete run digest");
    stateDigest(object.receiptDigest, "stored file delete receipt digest");
  }
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1].ref >= objects[index].ref) failStop(new Error("stored file delete objects are unsorted"));
  }
  stateTimestamp(record.preparedAt, "stored file deletion preparedAt");
  stateTimestamp(record.completedAt, "stored file deletion completedAt", { nullable: true });
  if (record.tombstoneDigest !== null) stateDigest(record.tombstoneDigest, "stored file deletion tombstone");
  if (record.status === "committed" && (!record.completedAt || !record.tombstoneDigest)) {
    failStop(new Error("stored committed file deletion lacks tombstone"));
  }
}

function validateLedger(ledger) {
  exact(ledger, ["schemaVersion", "revision", "authorityEpoch", "reservations", "groups", "commits", "deletions"], "file ledger");
  if (
    ledger.schemaVersion !== FILE_WORKER_LEDGER_SCHEMA_VERSION ||
    !Number.isSafeInteger(ledger.revision) || ledger.revision < 0 ||
    !Number.isSafeInteger(ledger.authorityEpoch) || ledger.authorityEpoch < 1
  ) failStop(new Error("file ledger identity is invalid"));
  list(ledger.reservations, MAXIMUM_RESERVATIONS, "file reservations").forEach(validateStoredReservation);
  list(ledger.groups, MAXIMUM_GROUPS, "file groups").forEach(validateStoredGroup);
  list(ledger.commits, MAXIMUM_COMMITS, "file commits").forEach(validateStoredCommit);
  list(ledger.deletions, MAXIMUM_DELETIONS, "file deletions").forEach(validateStoredDeletion);
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) failStop(new Error(`${label} is duplicated`));
  };
  unique(ledger.reservations.map(({ issuanceId }) => issuanceId), "file issuance id");
  unique(ledger.reservations.map(({ requestId }) => requestId), "file reservation request id");
  unique(ledger.groups.map(({ groupId }) => groupId), "file group id");
  unique(ledger.groups.map(({ requestId }) => requestId), "file group request id");
  unique(ledger.groups.map(({ receipt }) => receipt.digest), "file receipt digest");
  unique(ledger.groups.flatMap(({ artifacts }) => artifacts.map(({ ref }) => ref)), "file object ref");
  unique(ledger.commits.map(({ requestId }) => requestId), "file commit request id");
  unique(ledger.deletions.map(({ deletionId }) => deletionId), "file deletion id");
  return ledger;
}

function initialLedger() {
  return {
    schemaVersion: FILE_WORKER_LEDGER_SCHEMA_VERSION,
    revision: 0,
    authorityEpoch: 1,
    reservations: [],
    groups: [],
    commits: [],
    deletions: [],
  };
}

function envelope(payload) {
  return {
    schemaVersion: FILE_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION,
    payload,
    digest: contractDigest(payload),
  };
}

function parseEnvelope(text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { failStop(error); }
  exact(value, ["schemaVersion", "payload", "digest"], "file ledger envelope");
  if (value.schemaVersion !== FILE_WORKER_LEDGER_ENVELOPE_SCHEMA_VERSION || contractDigest(value.payload) !== value.digest) {
    failStop(new Error("file ledger envelope digest is invalid"));
  }
  return validateLedger(value.payload);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

async function syncDirectory(filename) {
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function privateDirectory(filename, { create = false } = {}) {
  if (create) {
    try { await fs.mkdir(filename, { recursive: false, mode: 0o700 }); } catch (error) {
      if (error?.code !== "EEXIST") unavailable("File worker private directory is unavailable.", error);
    }
  }
  const named = await fs.lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    unavailable("File worker private directory is unavailable.", error);
  });
  if (
    !named || !named.isDirectory() || named.isSymbolicLink() || (named.mode & 0o777) !== 0o700 ||
    (currentUid() !== null && named.uid !== currentUid())
  ) failStop(new Error("file worker private directory metadata is unsafe"));
}

async function openVerified(filename, expectedBytes, label) {
  const named = await fs.lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") return null;
    unavailable(`File worker ${label} is unavailable.`, error);
  });
  if (!named) return null;
  if (
    !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || (named.mode & 0o777) !== 0o600 ||
    named.size !== expectedBytes || (currentUid() !== null && named.uid !== currentUid())
  ) failStop(new Error(`${label} metadata is unsafe`));
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    const opened = await handle.stat();
    if (!sameFile(named, opened)) failStop(new Error(`${label} changed before open`));
    return Object.freeze({ handle, snapshot: opened });
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof IntegrationDocumentWorkerError) throw error;
    unavailable(`File worker ${label} is unavailable.`, error);
  }
}

async function hashOpen(handle, size) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunk.byteLength, size - offset);
    const { bytesRead } = await handle.read(chunk, 0, length, offset);
    if (bytesRead !== length) failStop(new Error("file object read was incomplete"));
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function writeStage(filename, bytes, expectedSha256) {
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const opened = await openVerified(filename, bytes.byteLength, "staged file");
    try {
      if (await hashOpen(opened.handle, bytes.byteLength) !== expectedSha256) failStop(new Error("staged file digest mismatch"));
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof IntegrationDocumentWorkerError) throw error;
    unavailable("File worker staging failed.", error);
  }
}

export async function openIntegrationFileWorkerStore(options = {}) {
  const stateRoot = String(options.stateRoot || "");
  if (!path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot || stateRoot === path.parse(stateRoot).root) {
    throw new TypeError("file worker stateRoot must be one dedicated canonical absolute path");
  }
  const now = options.now || (() => new Date());
  const checkpoint = options.checkpoint || (() => {});
  if (typeof now !== "function" || typeof checkpoint !== "function") throw new TypeError("file worker hooks are invalid");
  const paths = Object.freeze({
    root: stateRoot,
    ledger: path.join(stateRoot, LEDGER_FILENAME),
    stages: path.join(stateRoot, STAGES_DIRECTORY),
    objects: path.join(stateRoot, OBJECTS_DIRECTORY),
  });
  let ledger;
  let serial = Promise.resolve();
  let closed = false;
  let poisoned = false;
  const activeStreams = new Map();

  function runSerialized(operation) {
    const guarded = async () => {
      if (closed || poisoned) unavailable("File worker private state is unavailable.");
      try { return await operation(); } catch (error) {
        if (error?.documentWorkerFailStop === true) poisoned = true;
        throw error;
      }
    };
    const run = serial.then(guarded, guarded);
    serial = run.catch(() => {});
    return run;
  }

  async function readLedger() {
    const named = await fs.lstat(paths.ledger).catch((error) => error?.code === "ENOENT" ? null : unavailable("File ledger is unavailable.", error));
    if (!named) return null;
    if (
      !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || (named.mode & 0o777) !== 0o600 ||
      named.size < 2 || named.size > MAXIMUM_LEDGER_BYTES || (currentUid() !== null && named.uid !== currentUid())
    ) failStop(new Error("file ledger metadata is unsafe"));
    let handle;
    try {
      handle = await fs.open(paths.ledger, fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      const before = await handle.stat();
      if (!sameFile(named, before)) failStop(new Error("file ledger changed before read"));
      const text = await handle.readFile("utf8");
      const after = await handle.stat();
      const afterNamed = await fs.lstat(paths.ledger);
      if (!sameFile(before, after) || !sameFile(after, afterNamed) || Buffer.byteLength(text, "utf8") !== after.size) {
        failStop(new Error("file ledger changed during read"));
      }
      return parseEnvelope(text);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function saveLedger() {
    validateLedger(ledger);
    ledger.revision += 1;
    const bytes = canonicalFileWorkerJson(envelope(ledger));
    if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_LEDGER_BYTES) unavailable("File worker ledger capacity is exhausted.");
    const temporary = path.join(paths.root, `.ledger.stage.${crypto.randomBytes(16).toString("hex")}`);
    let handle;
    let renamed = false;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await checkpoint("file-before-ledger-rename", { revision: ledger.revision });
      await fs.rename(temporary, paths.ledger);
      renamed = true;
      await syncDirectory(paths.root);
    } catch (cause) {
      poisoned = true;
      await handle?.close().catch(() => {});
      if (!renamed) await fs.unlink(temporary).catch(() => {});
      const error = cause instanceof IntegrationDocumentWorkerError
        ? cause
        : new IntegrationDocumentWorkerError("WORKER_STATE_UNAVAILABLE", "File worker ledger could not be persisted.", { status: 503, cause });
      if (!Object.hasOwn(error, "documentWorkerFailStop")) {
        Object.defineProperty(error, "documentWorkerFailStop", { value: true, enumerable: false });
      }
      throw error;
    }
  }

  const findGroupByRequest = (requestId) => ledger.groups.find((group) => group.requestId === requestId) || null;
  const findGroupByReceipt = (receiptDigest) => ledger.groups.find((group) => group.receipt.digest === receiptDigest) || null;
  const findArtifact = (ref) => {
    for (const group of ledger.groups) {
      const artifact = group.artifacts.find((candidate) => candidate.ref === ref);
      if (artifact) return { group, artifact };
    }
    return null;
  };
  const scopeMatches = (scope, group) => {
    const digests = fileWorkerScopeDigests(scope);
    return ["ownerDigest", "threadDigest", "runDigest", "scopeDigest"].every((key) => digests[key] === group[key]);
  };
  const notFound = () => documentWorkerFail("NOT_FOUND", "File artifact was not found.", { status: 404 });

  function retainedBytes() {
    const total = ledger.groups.reduce((sum, group) => sum + group.artifacts.reduce(
      (inner, artifact) => inner + (new Set(["gone", "tombstoned"]).has(artifact.state) ? 0 : artifact.bytes), 0
    ), 0);
    if (!Number.isSafeInteger(total) || total > FILE_WORKER_LIMITS.maximumStoredBytes) failStop(new Error("file quota accounting is invalid"));
    return total;
  }

  async function finishCommit(group) {
    if (group.state !== "committing" || !group.pendingCommit) failStop(new Error("file commit recovery state is invalid"));
    for (const artifact of group.artifacts) {
      const stage = path.join(paths.stages, artifact.ref);
      const object = path.join(paths.objects, artifact.ref);
      const installed = await openVerified(object, artifact.bytes, "committed file");
      if (installed) {
        try {
          if (await hashOpen(installed.handle, artifact.bytes) !== artifact.sha256) failStop(new Error("committed file digest mismatch"));
        } finally { await installed.handle.close(); }
        await fs.unlink(stage).catch((error) => { if (error?.code !== "ENOENT") unavailable("File stage cleanup failed.", error); });
      } else {
        const staged = await openVerified(stage, artifact.bytes, "staged file");
        if (!staged) failStop(new Error("file commit source disappeared"));
        try {
          if (await hashOpen(staged.handle, artifact.bytes) !== artifact.sha256) failStop(new Error("staged file digest mismatch"));
        } finally { await staged.handle.close(); }
        await fs.rename(stage, object);
      }
    }
    await syncDirectory(paths.stages);
    await syncDirectory(paths.objects);
    const { requestDigest, response } = group.pendingCommit;
    group.state = "committed";
    group.committedAt = response.committedAt;
    group.pendingCommit = null;
    for (const artifact of group.artifacts) artifact.state = "committed";
    if (!ledger.commits.some(({ requestId }) => requestId === response.requestId)) {
      ledger.commits.push({ requestId: response.requestId, requestDigest, response: { ...response } });
    }
    await saveLedger();
  }

  async function closeRef(ref) {
    const entries = [...(activeStreams.get(ref) || [])];
    for (const entry of entries) {
      entry.stream?.destroy(new Error("file artifact is being deleted"));
      await entry.handle.close().catch(() => {});
      entry.released = true;
    }
    activeStreams.delete(ref);
  }

  async function finishDeletion(deletion) {
    if (deletion.status !== "committing") failStop(new Error("file deletion recovery state is invalid"));
    for (const object of deletion.objects) {
      await closeRef(object.ref);
      const found = findArtifact(object.ref);
      if (!found) failStop(new Error("file deletion object disappeared"));
      await fs.unlink(path.join(paths.objects, object.ref)).catch((error) => {
        if (error?.code !== "ENOENT") unavailable("File artifact deletion failed.", error);
      });
      found.artifact.state = "tombstoned";
    }
    await syncDirectory(paths.objects);
    for (const group of new Set(deletion.objects.map(({ ref }) => findArtifact(ref)?.group).filter(Boolean))) {
      group.state = "tombstoned";
    }
    deletion.status = "committed";
    deletion.completedAt = currentTimestamp(now);
    deletion.tombstoneDigest = contractDigest({
      schemaVersion: DELETE_TOMBSTONE_SCHEMA_VERSION,
      deletionId: deletion.deletionId,
      manifestDigest: deletion.manifestDigest,
      completedAt: deletion.completedAt,
    });
    await saveLedger();
  }

  async function reapExpired() {
    const threshold = now().getTime() - FILE_WORKER_STAGED_GROUP_TTL_MS;
    let changed = false;
    for (const group of ledger.groups) {
      if (group.state !== "staged" || Date.parse(group.createdAt) > threshold) continue;
      for (const artifact of group.artifacts) await fs.unlink(path.join(paths.stages, artifact.ref)).catch(() => {});
      for (const artifact of group.artifacts) artifact.state = "tombstoned";
      group.state = "tombstoned";
      group.committedAt = group.createdAt;
      group.deletionId = `fdel_${contractDigest({ schemaVersion: "aginti-file-worker-expiry-v1", groupId: group.groupId })}`;
      changed = true;
    }
    const retainedRequestIds = new Set(ledger.groups.map(({ requestId }) => requestId));
    const before = ledger.reservations.length;
    ledger.reservations = ledger.reservations.filter((reservation) => (
      retainedRequestIds.has(reservation.requestId) || Date.parse(reservation.createdAt) > threshold
    ));
    if (changed || before !== ledger.reservations.length) {
      await syncDirectory(paths.stages);
      await saveLedger();
    }
  }

  async function reconcile() {
    const stageRefs = new Set(ledger.groups.filter(({ state }) => new Set(["staged", "committing"]).has(state)).flatMap(
      ({ artifacts }) => artifacts.filter(({ state }) => state === "staged").map(({ ref }) => ref)
    ));
    const objectRefs = new Set(ledger.groups.filter(({ state }) => !new Set(["staged", "committing", "tombstoned"]).has(state)).flatMap(
      ({ artifacts }) => artifacts.filter(({ state }) => state === "committed").map(({ ref }) => ref)
    ));
    const stages = await fs.readdir(paths.stages);
    const objects = await fs.readdir(paths.objects);
    if (stages.length > MAXIMUM_DIRECTORY_ENTRIES || objects.length > MAXIMUM_DIRECTORY_ENTRIES) {
      unavailable("File worker directory capacity is exhausted.");
    }
    for (const name of stages) {
      if (!FILE_WORKER_PATTERNS.objectRef.test(name) || !stageRefs.has(name)) failStop(new Error("unknown file stage object"));
    }
    for (const name of objects) {
      if (!FILE_WORKER_PATTERNS.objectRef.test(name) || !objectRefs.has(name)) failStop(new Error("unknown committed file object"));
    }
    for (const ref of stageRefs) if (!stages.includes(ref)) failStop(new Error("referenced file stage is absent"));
    for (const ref of objectRefs) if (!objects.includes(ref)) {
      const found = findArtifact(ref);
      found.artifact.state = "gone";
      await saveLedger();
    }
  }

  try {
    await fs.mkdir(paths.root, { recursive: false, mode: 0o700 });
    await syncDirectory(path.dirname(paths.root));
  } catch (error) {
    if (error?.code !== "EEXIST") unavailable("File worker state root is unavailable.", error);
  }
  await privateDirectory(paths.root);
  await privateDirectory(paths.stages, { create: true });
  await privateDirectory(paths.objects, { create: true });
  ledger = await readLedger();
  if (!ledger) {
    ledger = initialLedger();
    await saveLedger();
  }
  for (const group of ledger.groups.filter(({ state }) => state === "committing")) await finishCommit(group);
  for (const deletion of ledger.deletions.filter(({ status }) => status === "committing")) await finishDeletion(deletion);
  await reapExpired();
  await reconcile();

  const store = {
    schemaVersion: FILE_WORKER_LEDGER_SCHEMA_VERSION,

    issue(requestInput) {
      return runSerialized(async () => {
        const request = validateFileWorkerIssueRequest(requestInput);
        await reapExpired();
        const requestDigest = contractDigest(request);
        const replay = ledger.reservations.find(({ issuanceId }) => issuanceId === request.issuanceId);
        if (replay) {
          if (replay.issueRequestDigest !== requestDigest) {
            documentWorkerFail("IDEMPOTENCY_CONFLICT", "File issuance id was already used.", { status: 409 });
          }
          const unsigned = {
            schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.issueResponse,
            issuanceId: replay.issuanceId,
            requestId: replay.requestId,
            authorityEpoch: replay.authorityEpoch,
            authorityToken: replay.authorityToken,
            contentDigest: replay.contentDigest,
          };
          return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
        }
        if (request.authorityEpoch !== ledger.authorityEpoch) {
          documentWorkerFail(
            request.authorityEpoch < ledger.authorityEpoch ? "ARTIFACT_CONTENT_GONE" : "INVALID_REQUEST",
            "File issuance authority is invalid.",
            { status: request.authorityEpoch < ledger.authorityEpoch ? 410 : 400 }
          );
        }
        const digests = fileWorkerScopeDigests(request.scope);
        const ownerCount = ledger.reservations.filter(({ ownerDigest, requestId }) => (
          ownerDigest === digests.ownerDigest && !findGroupByRequest(requestId)
        )).length;
        if (ledger.reservations.length >= MAXIMUM_RESERVATIONS || ownerCount >= MAXIMUM_RESERVATIONS_PER_OWNER) {
          unavailable("File worker issuance capacity is exhausted.");
        }
        const requestId = `fpub_${crypto.randomBytes(32).toString("hex")}`;
        const authorityToken = randomFileWorkerId("wpa_", 32);
        const reservation = {
          issuanceId: request.issuanceId,
          issueRequestDigest: requestDigest,
          requestId,
          authorityEpoch: request.authorityEpoch,
          authorityToken,
          authorityTokenDigest: crypto.createHash("sha256").update(authorityToken, "utf8").digest("hex"),
          contentDigest: digestFileWorkerContent(request),
          ...digests,
          createdAt: currentTimestamp(now),
        };
        ledger.reservations.push(reservation);
        await saveLedger();
        const unsigned = {
          schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.issueResponse,
          issuanceId: reservation.issuanceId,
          requestId,
          authorityEpoch: reservation.authorityEpoch,
          authorityToken,
          contentDigest: reservation.contentDigest,
        };
        return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
      });
    },

    publish(requestInput) {
      return runSerialized(async () => {
        const requestDigest = digestFileWorkerPublishOperation(requestInput);
        const request = isNormalizedFileWorkerPublishRequest(requestInput)
          ? requestInput
          : validateFileWorkerPublishRequest(requestInput);
        try {
          await reapExpired();
          const existing = findGroupByRequest(request.requestId);
          if (existing) {
            if (existing.requestDigest !== requestDigest || !scopeMatches(request.scope, existing)) {
              documentWorkerFail("IDEMPOTENCY_CONFLICT", "File publish request id was already used.", { status: 409 });
            }
            return publishReplay(existing);
          }
          const reservation = ledger.reservations.find(({ requestId }) => requestId === request.requestId);
          const candidateFiles = request.files.map(({ bytesValue: _bytesValue, encoding: _encoding, content: _content, ...file }) => file);
          const tokenDigest = crypto.createHash("sha256").update(request.authorityToken, "utf8").digest("hex");
          const digests = fileWorkerScopeDigests(request.scope);
          if (
            !reservation || reservation.issuanceId !== request.issuanceId ||
            reservation.authorityEpoch !== request.authorityEpoch || reservation.authorityTokenDigest !== tokenDigest ||
            reservation.contentDigest !== digestFileWorkerContent({ scope: request.scope, files: candidateFiles }) ||
            ["ownerDigest", "threadDigest", "runDigest", "scopeDigest"].some((key) => reservation[key] !== digests[key])
          ) {
            documentWorkerFail("ARTIFACT_CONTENT_GONE", "File publish authority is absent or expired.", { status: 410 });
          }
          if (ledger.groups.length >= MAXIMUM_GROUPS) unavailable("File worker group capacity is exhausted.");
          const requestedBytes = request.files.reduce((sum, file) => sum + file.bytes, 0);
          if (requestedBytes > FILE_WORKER_LIMITS.maximumStoredBytes - retainedBytes()) {
            unavailable("File worker private object quota is exhausted.");
          }
          const artifacts = Object.freeze(request.files.map((file, index) => Object.freeze({
            ref: randomFileWorkerId("fobj_", 32),
            index,
            filename: file.filename,
            mime: file.mime,
            bytes: file.bytes,
            sha256: file.sha256,
          })));
          validateFileWorkerArtifacts(artifacts);
          const groupId = randomFileWorkerId("fgrp_", 32);
          const receiptUnsigned = {
            schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.receipt,
            receiptId: randomFileWorkerId("frcp_", 24),
            groupId,
            ...digests,
            requestId: request.requestId,
            requestDigest,
            artifactsDigest: fileWorkerArtifactsDigest(artifacts),
            fileCount: artifacts.length,
            totalBytes: requestedBytes,
            networkNone: true,
            issuedAt: currentTimestamp(now),
          };
          const receipt = Object.freeze({ ...receiptUnsigned, digest: contractDigest(receiptUnsigned) });
          validateFileWorkerReceipt(receipt);
          const stagePaths = artifacts.map(({ ref }) => path.join(paths.stages, ref));
          let group = null;
          try {
            for (let index = 0; index < artifacts.length; index += 1) {
              await writeStage(stagePaths[index], request.files[index].bytesValue, artifacts[index].sha256);
            }
            await syncDirectory(paths.stages);
            await checkpoint("file-after-stage-before-ledger", { requestId: request.requestId });
            group = {
              groupId,
              state: "staged",
              ...digests,
              requestId: request.requestId,
              authorityEpoch: request.authorityEpoch,
              requestDigest,
              receipt: { ...receipt },
              artifacts: artifacts.map((artifact) => ({ ...artifact, state: "staged" })),
              createdAt: receipt.issuedAt,
              committedAt: null,
              deletionId: null,
              pendingCommit: null,
            };
            ledger.groups.push(group);
            await saveLedger();
            return publishResponse(group);
          } catch (error) {
            if (group && ledger.groups.at(-1) === group) ledger.groups.pop();
            await Promise.allSettled(stagePaths.map((filename) => fs.unlink(filename)));
            await syncDirectory(paths.stages).catch(() => {});
            throw error;
          }
        } finally {
          for (const file of request.files) file.bytesValue.fill(0);
        }
      });
    },

    commit(requestInput) {
      return runSerialized(async () => {
        const request = validateFileWorkerCommitRequest(requestInput);
        await reapExpired();
        const requestDigest = contractDigest(request);
        const replay = ledger.commits.find(({ requestId }) => requestId === request.requestId);
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            documentWorkerFail("IDEMPOTENCY_CONFLICT", "File commit request id was already used.", { status: 409 });
          }
          return Object.freeze({ ...replay.response });
        }
        const group = findGroupByReceipt(request.receiptDigest);
        if (!group || !scopeMatches(request.scope, group)) notFound();
        if (canonicalJson(fileWorkerCommitManifest(group.artifacts.map(publicArtifact))) !== canonicalJson(request.objects)) notFound();
        if (group.state === "tombstoned") documentWorkerFail("ARTIFACT_CONTENT_GONE", "File group was deleted.", { status: 410 });
        if (new Set(["delete-prepared", "deleting"]).has(group.state)) {
          documentWorkerFail("ARTIFACT_DELETE_PENDING", "File group is being deleted.", { status: 503 });
        }
        const committedAt = group.committedAt || currentTimestamp(now);
        const unsigned = {
          schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.commitResponse,
          requestId: request.requestId,
          receiptDigest: group.receipt.digest,
          status: "committed",
          manifestDigest: fileWorkerManifestDigest(request.objects),
          committedAt,
        };
        const response = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
        if (group.state === "committed") {
          ledger.commits.push({ requestId: request.requestId, requestDigest, response: { ...response } });
          await saveLedger();
          return response;
        }
        if (group.state !== "staged") failStop(new Error("file group cannot enter commit lifecycle"));
        group.state = "committing";
        group.pendingCommit = { requestDigest, response: { ...response } };
        await saveLedger();
        await checkpoint("file-after-commit-ledger-before-objects", { requestId: request.requestId });
        await finishCommit(group);
        return response;
      });
    },

    openContent(request) {
      return runSerialized(async () => {
        const found = findArtifact(request.ref);
        if (!found || !scopeMatches(request.scope, found.group) || found.group.receipt.digest !== request.receiptDigest ||
          new Set(["staged", "committing"]).has(found.group.state)) notFound();
        if (found.group.state === "tombstoned" || new Set(["gone", "tombstoned"]).has(found.artifact.state)) {
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "File artifact is no longer available.", { status: 410 });
        }
        if (new Set(["delete-prepared", "deleting"]).has(found.group.state)) {
          documentWorkerFail("ARTIFACT_DELETE_PENDING", "File artifact deletion is pending.", { status: 503 });
        }
        let start = 0;
        let end = found.artifact.bytes - 1;
        if (request.range) {
          start = request.range.start;
          if (start >= found.artifact.bytes) {
            const error = new IntegrationDocumentWorkerError("RANGE_NOT_SATISFIABLE", "File range is not satisfiable.", { status: 416 });
            error.totalBytes = found.artifact.bytes;
            throw error;
          }
          end = request.range.end === undefined ? end : Math.min(request.range.end, end);
        }
        const filename = path.join(paths.objects, found.artifact.ref);
        const opened = await openVerified(filename, found.artifact.bytes, "committed file");
        if (!opened) {
          found.artifact.state = "gone";
          await saveLedger();
          documentWorkerFail("ARTIFACT_CONTENT_GONE", "File artifact is no longer available.", { status: 410 });
        }
        try {
          if (await hashOpen(opened.handle, found.artifact.bytes) !== found.artifact.sha256) failStop(new Error("committed file digest mismatch"));
          const after = await opened.handle.stat();
          const named = await fs.lstat(filename);
          if (!sameFile(opened.snapshot, after) || !sameFile(after, named)) failStop(new Error("committed file changed during verification"));
        } catch (error) {
          await opened.handle.close().catch(() => {});
          throw error;
        }
        const metadata = Object.freeze({
          ...publicArtifact(found.artifact),
          totalBytes: found.artifact.bytes,
          start,
          end,
          selectedBytes: end - start + 1,
          partial: Boolean(request.range),
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

    delete(requestInput) {
      return runSerialized(async () => {
        const request = validateFileWorkerDeleteRequest(requestInput);
        await reapExpired();
        const { ownerDigest, threadDigest } = fileWorkerThreadDigests(request.scope);
        const manifestDigest = fileWorkerDeletionManifestDigest(request);
        let deletion = ledger.deletions.find(({ deletionId }) => deletionId === request.deletionId) || null;
        if (deletion && deletion.manifestDigest !== manifestDigest) {
          documentWorkerFail("IDEMPOTENCY_CONFLICT", "File deletion id was already used.", { status: 409 });
        }
        if (!deletion && request.phase !== "prepare") documentWorkerFail("NOT_FOUND", "File deletion was not found.", { status: 404 });
        if (!deletion) {
          if (ledger.deletions.length >= MAXIMUM_DELETIONS) unavailable("File deletion capacity is exhausted.");
          const groups = new Set();
          const objects = [];
          for (const object of request.objects) {
            const found = findArtifact(object.ref);
            if (!found || found.group.ownerDigest !== ownerDigest || found.group.threadDigest !== threadDigest ||
              found.group.receipt.digest !== object.receiptDigest || found.group.deletionId !== null) notFound();
            const expectedRunDigest = contractDigest({
              schemaVersion: "aginti-document-worker-run-v1",
              threadDigest,
              runId: object.runId,
            });
            if (found.group.runDigest !== expectedRunDigest) notFound();
            groups.add(found.group);
            objects.push({ ref: object.ref, runDigest: expectedRunDigest, receiptDigest: object.receiptDigest });
          }
          const refs = new Set(objects.map(({ ref }) => ref));
          for (const group of groups) {
            if (group.artifacts.some(({ ref }) => !refs.has(ref))) {
              documentWorkerFail("INVALID_REQUEST", "Deletion must include the complete file bundle.", { status: 400 });
            }
          }
          deletion = {
            deletionId: request.deletionId,
            manifestDigest,
            ownerDigest,
            threadDigest,
            status: "prepared",
            objects,
            preparedAt: currentTimestamp(now),
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
          for (const object of deletion.objects) findArtifact(object.ref).group.state = "deleting";
          await saveLedger();
          await checkpoint("file-after-delete-ledger-before-unlink", { deletionId: deletion.deletionId });
          await finishDeletion(deletion);
        }
        const unsigned = {
          schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.deleteResponse,
          deletionId: deletion.deletionId,
          phase: request.phase,
          status: deletion.status === "committed" ? "committed" : "prepared",
          manifestDigest: deletion.manifestDigest,
          tombstoneDigest: deletion.tombstoneDigest,
          completedAt: deletion.completedAt,
        };
        return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
      });
    },

    inspect() {
      return runSerialized(async () => Object.freeze({
        schemaVersion: FILE_WORKER_LEDGER_SCHEMA_VERSION,
        revision: ledger.revision,
        authorityEpoch: ledger.authorityEpoch,
        groups: ledger.groups.length,
        stagedGroups: ledger.groups.filter(({ state }) => state === "staged").length,
        committedGroups: ledger.groups.filter(({ state }) => state === "committed").length,
        tombstonedGroups: ledger.groups.filter(({ state }) => state === "tombstoned").length,
        pendingDeletions: ledger.deletions.filter(({ status }) => status !== "committed").length,
        reservations: ledger.reservations.length,
        digest: contractDigest({
          schemaVersion: FILE_WORKER_LEDGER_SCHEMA_VERSION,
          revision: ledger.revision,
          authorityEpoch: ledger.authorityEpoch,
          receipts: ledger.groups.map(({ receipt }) => receipt.digest),
        }),
      }));
    },

    close() {
      return runSerialized(async () => {
        for (const ref of [...activeStreams.keys()]) await closeRef(ref);
        closed = true;
      });
    },
  };
  STORE_BRAND.add(store);
  return Object.freeze(store);
}

export function assertIntegrationFileWorkerStore(value) {
  if (!value || !STORE_BRAND.has(value)) throw new TypeError("file worker store is not AgInTi-owned");
  return value;
}
