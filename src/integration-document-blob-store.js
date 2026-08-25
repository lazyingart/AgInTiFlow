import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { MAX_INTEGRATION_FILE_ARTIFACT_BYTES } from "./integration-artifacts.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_DOCUMENT_BLOB_STORE_SCHEMA_VERSION = "aginti-document-blob-store-v1";

const STATE_SCOPE_DIGEST_VERSION = "aginti-analysis-state-scope-v1";
const BLOB_REF = /^blob_[A-Za-z0-9_-]{32,96}$/u;
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);

export class IntegrationDocumentBlobStoreError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationDocumentBlobStoreError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationDocumentBlobStoreError(code, message, options);
}

function scopeId(scope) {
  return contractDigest({
    schemaVersion: STATE_SCOPE_DIGEST_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
}

function locations(stateRoot, scope, blobRef = "") {
  const scopeDirectory = path.join(stateRoot, "scopes", scopeId(scope));
  const blobDirectory = path.join(scopeDirectory, "document-blobs");
  return Object.freeze({
    scopeDirectory,
    blobDirectory,
    ...(blobRef ? { blobFile: path.join(blobDirectory, blobRef) } : {}),
  });
}

async function privateDirectory(filename, { create = false } = {}) {
  let created = false;
  if (create) {
    try {
      await fs.mkdir(filename, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const stat = await fs.lstat(filename).catch(() => null);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (uid !== null && stat.uid !== uid)
  ) {
    fail("ANALYSIS_BLOB_STORE_UNAVAILABLE", "Private document storage is unavailable.");
  }
  if (created) await syncDirectory(path.dirname(filename));
  return stat;
}

async function verifyFile(handle, named) {
  const opened = await handle.stat();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    (opened.mode & 0o777) !== 0o600 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    opened.size !== named.size ||
    (uid !== null && (opened.uid !== uid || named.uid !== uid))
  ) {
    fail("ANALYSIS_BLOB_CORRUPT", "Private document bytes failed integrity validation.");
  }
  return opened;
}

async function syncDirectory(filename) {
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function validateIntegrationDocumentBlobRef(value) {
  if (typeof value !== "string" || !BLOB_REF.test(value)) {
    fail("ANALYSIS_BLOB_CORRUPT", "Private document reference is invalid.");
  }
  return value;
}

export function createIntegrationDocumentBlobStore({ stateRoot }) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) {
    throw new TypeError("document blob stateRoot must be one canonical absolute path");
  }

  async function seal(scope, bytesValue) {
    const bytes = Buffer.isBuffer(bytesValue) ? bytesValue : Buffer.from(bytesValue || []);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_INTEGRATION_FILE_ARTIFACT_BYTES) {
      fail("ANALYSIS_BLOB_INVALID", "Private document bytes exceed their bound.", { status: 400 });
    }
    const base = locations(stateRoot, scope);
    await privateDirectory(base.scopeDirectory);
    await privateDirectory(base.blobDirectory, { create: true });
    const blobRef = `blob_${crypto.randomBytes(32).toString("base64url")}`;
    const final = locations(stateRoot, scope, blobRef).blobFile;
    const temporary = path.join(base.blobDirectory, `.stage.${crypto.randomBytes(24).toString("hex")}`);
    const expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    let handle;
    let installed = false;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = null;
      const named = await fs.lstat(temporary);
      const check = await fs.open(temporary, fsConstants.O_RDONLY | O_NOFOLLOW);
      try { await verifyFile(check, named); } finally { await check.close(); }
      await fs.rename(temporary, final);
      installed = true;
      const finalNamed = await fs.lstat(final);
      const finalHandle = await fs.open(final, fsConstants.O_RDONLY | O_NOFOLLOW);
      try {
        await verifyFile(finalHandle, finalNamed);
        const storedBytes = await finalHandle.readFile();
        const currentNamed = await fs.lstat(final);
        await verifyFile(finalHandle, currentNamed);
        if (
          storedBytes.byteLength !== bytes.byteLength ||
          crypto.createHash("sha256").update(storedBytes).digest("hex") !== expectedSha256
        ) {
          fail("ANALYSIS_BLOB_CORRUPT", "Private document bytes failed integrity validation.");
        }
      } finally {
        await finalHandle.close();
      }
      await syncDirectory(base.blobDirectory);
      return Object.freeze({
        blobRef,
        bytes: bytes.byteLength,
        sha256: expectedSha256,
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      if (installed) await fs.unlink(final).catch(() => {});
      if (error instanceof IntegrationDocumentBlobStoreError) throw error;
      fail("ANALYSIS_BLOB_STORE_UNAVAILABLE", "Private document bytes could not be sealed.", { cause: error });
    }
  }

  async function read(scope, blobRefValue, expected = {}) {
    const blobRef = validateIntegrationDocumentBlobRef(blobRefValue);
    const base = locations(stateRoot, scope, blobRef);
    await privateDirectory(base.scopeDirectory);
    const blobDirectory = await fs.lstat(base.blobDirectory).catch(() => null);
    if (!blobDirectory) return null;
    await privateDirectory(base.blobDirectory);
    const named = await fs.lstat(base.blobFile).catch(() => null);
    if (!named) return null;
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > MAX_INTEGRATION_FILE_ARTIFACT_BYTES) {
      fail("ANALYSIS_BLOB_CORRUPT", "Private document bytes failed integrity validation.");
    }
    let handle;
    try {
      handle = await fs.open(base.blobFile, fsConstants.O_RDONLY | O_NOFOLLOW);
      await verifyFile(handle, named);
      const bytes = await handle.readFile();
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (expected.bytes !== undefined && bytes.byteLength !== expected.bytes) {
        fail("ANALYSIS_BLOB_CORRUPT", "Private document byte length disagrees with metadata.");
      }
      if (expected.sha256 !== undefined && sha256 !== expected.sha256) {
        fail("ANALYSIS_BLOB_CORRUPT", "Private document hash disagrees with metadata.");
      }
      return Object.freeze({ bytes, sha256 });
    } catch (error) {
      if (error instanceof IntegrationDocumentBlobStoreError) throw error;
      fail("ANALYSIS_BLOB_STORE_UNAVAILABLE", "Private document bytes could not be read.", { cause: error });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function remove(scope, blobRefValue) {
    const blobRef = validateIntegrationDocumentBlobRef(blobRefValue);
    const base = locations(stateRoot, scope, blobRef);
    await privateDirectory(base.scopeDirectory);
    const blobDirectory = await fs.lstat(base.blobDirectory).catch(() => null);
    if (!blobDirectory) return false;
    await privateDirectory(base.blobDirectory);
    const named = await fs.lstat(base.blobFile).catch(() => null);
    if (!named) return false;
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
      fail("ANALYSIS_BLOB_CORRUPT", "Private document bytes failed integrity validation.");
    }
    const handle = await fs.open(base.blobFile, fsConstants.O_RDONLY | O_NOFOLLOW);
    try { await verifyFile(handle, named); } finally { await handle.close(); }
    await fs.unlink(base.blobFile);
    await syncDirectory(base.blobDirectory);
    return true;
  }

  return Object.freeze({ seal, read, remove });
}
