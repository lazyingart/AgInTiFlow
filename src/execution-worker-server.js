import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT } from "./execution-runtime-bundle.js";
import {
  createExecutionWorkerApiServer,
  listenExecutionWorkerSystemdSocket,
  validateExecutionWorkerBearerToken,
} from "./execution-worker-api.js";
import { createExecutionJobManager } from "./execution-worker-jobs.js";
import {
  attestExecutionWorkerActivationEnvironment,
  attestExecutionWorkerCgroupBoundary,
} from "./execution-worker-systemd-boundary.js";
import { createPythonExecutionWorker } from "./execution-worker.js";

export const EXECUTION_WORKER_SYSTEMD_UNIT = "aginti-execution-worker.service";
export const EXECUTION_WORKER_CREDENTIAL_NAME = "execution-worker-token";
export const EXECUTION_WORKER_CREDENTIALS_DIRECTORY = `/run/credentials/${EXECUTION_WORKER_SYSTEMD_UNIT}`;
export const EXECUTION_WORKER_SERVER_SCHEMA_VERSION = "aginti-execution-worker-server-v1";

const TOKEN_PATH = path.join(EXECUTION_WORKER_CREDENTIALS_DIRECTORY, EXECUTION_WORKER_CREDENTIAL_NAME);
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_CREDENTIAL_BYTES = 257;

export class ExecutionWorkerServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionWorkerServerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExecutionWorkerServerError(code, message);
}

function insidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sameFile(left, right) {
  return Boolean(
    left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.ctimeMs === right.ctimeMs
  );
}

function validateCredentialMetadata(directory, credential, { uid, gid }) {
  const directoryMode = directory.mode & 0o7777;
  const credentialMode = credential.mode & 0o7777;
  const trustedUid = (value) => value === 0 || value === uid;
  const trustedGid = (value) => value === 0 || value === gid;
  if (!directory.isDirectory() || directory.isSymbolicLink() || !trustedUid(directory.uid) || !trustedGid(directory.gid)
      || (directoryMode !== 0o500 && directoryMode !== 0o550)) {
    fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential directory is not trusted.");
  }
  if (!credential.isFile() || credential.isSymbolicLink() || !trustedUid(credential.uid) || !trustedGid(credential.gid)
      || (credentialMode !== 0o400 && credentialMode !== 0o440) || credential.nlink !== 1
      || credential.size < 32 || credential.size > MAX_CREDENTIAL_BYTES) {
    fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential file is not trusted.");
  }
}

async function loadCredential(filesystem, processObject) {
  let directoryBefore;
  let credentialBefore;
  let handle;
  try {
    const [directoryReal, credentialReal] = await Promise.all([
      filesystem.realpath(EXECUTION_WORKER_CREDENTIALS_DIRECTORY),
      filesystem.realpath(TOKEN_PATH),
    ]);
    if (directoryReal !== EXECUTION_WORKER_CREDENTIALS_DIRECTORY || credentialReal !== TOKEN_PATH) {
      fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential path traverses a symbolic link.");
    }
    [directoryBefore, credentialBefore] = await Promise.all([
      filesystem.lstat(EXECUTION_WORKER_CREDENTIALS_DIRECTORY),
      filesystem.lstat(TOKEN_PATH),
    ]);
    const uid = processObject.geteuid?.() ?? processObject.getuid?.();
    const gid = processObject.getegid?.() ?? processObject.getgid?.();
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
      fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential process identity is unavailable.");
    }
    validateCredentialMetadata(directoryBefore, credentialBefore, { uid, gid });
    try {
      await filesystem.access(TOKEN_PATH, fsConstants.W_OK);
      fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential is writable by the service.");
    } catch (error) {
      if (error instanceof ExecutionWorkerServerError) throw error;
      if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
        fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential read-only state is unproven.");
      }
    }
    handle = await filesystem.open(
      TOKEN_PATH,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_CLOEXEC || 0) | (fsConstants.O_NONBLOCK || 0)
    );
    const openedBefore = await handle.stat();
    if (!sameFile(credentialBefore, openedBefore)) {
      fail("EXECUTION_WORKER_CREDENTIAL_CHANGED", "execution worker credential changed before read.");
    }
    const raw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    const [directoryAfter, credentialAfter, directoryRealAfter, credentialRealAfter] = await Promise.all([
      filesystem.lstat(EXECUTION_WORKER_CREDENTIALS_DIRECTORY),
      filesystem.lstat(TOKEN_PATH),
      filesystem.realpath(EXECUTION_WORKER_CREDENTIALS_DIRECTORY),
      filesystem.realpath(TOKEN_PATH),
    ]);
    if (!sameFile(openedBefore, openedAfter) || !sameFile(openedAfter, credentialAfter)
        || !sameFile(directoryBefore, directoryAfter)
        || directoryRealAfter !== EXECUTION_WORKER_CREDENTIALS_DIRECTORY || credentialRealAfter !== TOKEN_PATH
        || Buffer.byteLength(raw, "utf8") !== openedAfter.size) {
      fail("EXECUTION_WORKER_CREDENTIAL_CHANGED", "execution worker credential changed during read.");
    }
    if (raw.includes("\u0000") || raw.includes("\r")) {
      fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential framing is invalid.");
    }
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!token || token.includes("\n")) {
      fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential must contain exactly one line.");
    }
    return validateExecutionWorkerBearerToken(token);
  } catch (error) {
    if (error instanceof ExecutionWorkerServerError) throw error;
    fail("EXECUTION_WORKER_CREDENTIAL_INVALID", "execution worker credential could not be read safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== "object") {
    throw new TypeError("environment must be an object");
  }
  if (environment.CREDENTIALS_DIRECTORY !== EXECUTION_WORKER_CREDENTIALS_DIRECTORY) {
    fail("EXECUTION_WORKER_CONFIG_INVALID", "execution worker requires its exact systemd credential directory.");
  }
  const runtimeBundleDirectory = environment.AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY;
  if (typeof runtimeBundleDirectory !== "string" || !path.isAbsolute(runtimeBundleDirectory)
      || path.normalize(runtimeBundleDirectory) !== runtimeBundleDirectory
      || !insidePath(runtimeBundleDirectory, EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT)) {
    fail("EXECUTION_WORKER_CONFIG_INVALID", "execution worker runtime bundle directory is invalid.");
  }
  const runtimeBundleRootDigest = environment.AGINTI_EXECUTION_RUNTIME_BUNDLE_DIGEST;
  if (typeof runtimeBundleRootDigest !== "string" || !DIGEST.test(runtimeBundleRootDigest)) {
    fail("EXECUTION_WORKER_CONFIG_INVALID", "execution worker runtime bundle digest is invalid.");
  }
  if (environment.AGINTI_EXECUTION_TEST_BYPASS !== undefined) {
    fail("EXECUTION_WORKER_CONFIG_INVALID", "execution worker test bypass must not exist in production.");
  }
  const workerId = `worker_${crypto.createHash("sha256")
    .update(`${EXECUTION_WORKER_SERVER_SCHEMA_VERSION}:${runtimeBundleRootDigest}`)
    .digest("base64url")}`;
  return Object.freeze({ runtimeBundleDirectory, runtimeBundleRootDigest, workerId });
}

export async function loadExecutionWorkerServerConfig({
  filesystem = fs,
  environment = process.env,
  processObject = process,
} = {}) {
  const config = validateEnvironment(environment);
  if (!processObject || typeof processObject !== "object") throw new TypeError("processObject must be an object");
  const bearerToken = await loadCredential(filesystem, processObject);
  return Object.freeze({
    schemaVersion: EXECUTION_WORKER_SERVER_SCHEMA_VERSION,
    ...config,
    bearerToken,
  });
}

export async function createProductionExecutionWorkerServer({
  config,
  serverFactory,
  listen = true,
} = {}) {
  if (!config || config.schemaVersion !== EXECUTION_WORKER_SERVER_SCHEMA_VERSION) {
    throw new TypeError("config must be a validated execution worker server config");
  }
  if (typeof listen !== "boolean") throw new TypeError("listen must be a boolean");
  if (listen && ((process.geteuid?.() ?? process.getuid?.()) === 0)) {
    fail("EXECUTION_WORKER_PROCESS_IDENTITY_INVALID", "execution worker must run as its dedicated non-root service user.");
  }
  const boundary = listen
    ? Object.freeze({
        activation: attestExecutionWorkerActivationEnvironment(),
        containment: await attestExecutionWorkerCgroupBoundary(),
      })
    : null;
  const worker = createPythonExecutionWorker({
    workerId: config.workerId,
    runtimeBundleDirectory: config.runtimeBundleDirectory,
    expectedRuntimeBundleRootDigest: config.runtimeBundleRootDigest,
    ...(boundary
      ? { containmentProbeImpl: async () => boundary.containment }
      : {}),
  });
  const manager = createExecutionJobManager({ worker });
  const server = createExecutionWorkerApiServer({
    manager,
    bearerToken: config.bearerToken,
    ...(serverFactory === undefined ? {} : { serverFactory }),
  });
  const address = listen ? await listenExecutionWorkerSystemdSocket(server) : null;
  return Object.freeze({
    schemaVersion: EXECUTION_WORKER_SERVER_SCHEMA_VERSION,
    worker,
    manager,
    server,
    address,
    boundary,
  });
}

export function installExecutionWorkerShutdownHandlers(server, { processObject = process } = {}) {
  if (!server || typeof server.close !== "function") throw new TypeError("server must provide close");
  if (!processObject || typeof processObject.once !== "function") throw new TypeError("processObject must provide once");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const forced = setTimeout(() => processObject.exit?.(1), 5_000);
    forced.unref?.();
    server.close(() => {
      clearTimeout(forced);
      processObject.exitCode = 0;
    });
  };
  processObject.once("SIGTERM", shutdown);
  processObject.once("SIGINT", shutdown);
  return Object.freeze({ shutdown });
}
