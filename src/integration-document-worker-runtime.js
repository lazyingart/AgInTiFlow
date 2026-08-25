import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

export const DOCUMENT_WORKER_NODE_RUNTIME = Object.freeze({
  path: "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85/bin/node",
  version: "v22.21.0",
  sha256: "29e9c28204d89d85cc426b518b4a7c6e32aafecd5e447d65301ffb2c1c15335a",
  uid: 0,
  gid: 0,
  mode: 0o555,
  size: 123_351_032,
});

const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);
const O_DIRECTORY = Number(fsConstants.O_DIRECTORY || 0);
export const DOCUMENT_WORKER_RUNTIME_ANCESTRY = Object.freeze([
  Object.freeze({ path: "/", uid: 0, gid: 0, mode: 0o755 }),
  Object.freeze({ path: "/opt", uid: 0, gid: 0, mode: 0o755 }),
  Object.freeze({
    path: "/opt/agintiflow-document-worker",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: Object.freeze(["releases", "runtimes"]),
  }),
  Object.freeze({
    path: "/opt/agintiflow-document-worker/runtimes",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: Object.freeze(["node-v22.21.0-29e9c28204d89d85"]),
  }),
  Object.freeze({
    path: "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: Object.freeze(["bin"]),
  }),
  Object.freeze({
    path: "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85/bin",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: Object.freeze(["node"]),
  }),
]);
let activationPromise = null;

function runtimeError() {
  const error = new Error("Document worker runtime identity or namespace is invalid.");
  error.name = "IntegrationDocumentWorkerRuntimeError";
  error.code = "DOCUMENT_WORKER_RUNTIME_INVALID";
  error.publicCode = "DOCUMENT_WORKER_RUNTIME_INVALID";
  error.status = 503;
  error.statusCode = 503;
  return error;
}

function sameIdentity(left, right) {
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

async function hashOpenFile(handle, size) {
  const digest = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.byteLength, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead !== length) throw runtimeError();
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

function verifyEntries(entries, contract) {
  const sorted = entries.sort();
  if (sorted.length !== contract.expectedEntries.length) throw runtimeError();
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index] !== contract.expectedEntries[index]) throw runtimeError();
  }
}

async function verifyRuntimeAncestry() {
  const identities = [];
  for (const contract of DOCUMENT_WORKER_RUNTIME_ANCESTRY) {
    let handle;
    try {
      const [real, named] = await Promise.all([fs.realpath(contract.path), fs.lstat(contract.path)]);
      if (
        real !== contract.path ||
        named.isSymbolicLink() ||
        !named.isDirectory() ||
        named.uid !== contract.uid ||
        named.gid !== contract.gid ||
        (named.mode & 0o777) !== contract.mode
      ) throw runtimeError();
      handle = await fs.open(
        contract.path,
        fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
      );
      const before = await handle.stat();
      if (!sameIdentity(named, before)) throw runtimeError();
      if (contract.expectedEntries) {
        verifyEntries(await fs.readdir(contract.path), contract);
      }
      const [after, afterNamed] = await Promise.all([handle.stat(), fs.lstat(contract.path)]);
      if (!sameIdentity(before, after) || !sameIdentity(after, afterNamed)) throw runtimeError();
      identities.push(afterNamed);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return identities;
}

export async function verifyIntegrationDocumentWorkerNodeRuntime() {
  let handle;
  try {
    const ancestryBefore = await verifyRuntimeAncestry();
    const [real, named] = await Promise.all([
      fs.realpath(DOCUMENT_WORKER_NODE_RUNTIME.path),
      fs.lstat(DOCUMENT_WORKER_NODE_RUNTIME.path),
    ]);
    if (
      real !== DOCUMENT_WORKER_NODE_RUNTIME.path ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.nlink !== 1 ||
      named.uid !== DOCUMENT_WORKER_NODE_RUNTIME.uid ||
      named.gid !== DOCUMENT_WORKER_NODE_RUNTIME.gid ||
      (named.mode & 0o777) !== DOCUMENT_WORKER_NODE_RUNTIME.mode ||
      named.size !== DOCUMENT_WORKER_NODE_RUNTIME.size
    ) throw runtimeError();
    handle = await fs.open(
      DOCUMENT_WORKER_NODE_RUNTIME.path,
      fsConstants.O_RDONLY | O_NOFOLLOW | O_CLOEXEC
    );
    const before = await handle.stat();
    if (!sameIdentity(named, before)) throw runtimeError();
    const sha256 = await hashOpenFile(handle, before.size);
    const [after, afterNamed, ancestryAfter] = await Promise.all([
      handle.stat(),
      fs.lstat(DOCUMENT_WORKER_NODE_RUNTIME.path),
      verifyRuntimeAncestry(),
    ]);
    if (
      sha256 !== DOCUMENT_WORKER_NODE_RUNTIME.sha256 ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, afterNamed) ||
      ancestryBefore.length !== ancestryAfter.length ||
      ancestryBefore.some((identity, index) => !sameIdentity(identity, ancestryAfter[index]))
    ) throw runtimeError();
    return Object.freeze({ ...DOCUMENT_WORKER_NODE_RUNTIME });
  } catch (error) {
    if (error?.code === "DOCUMENT_WORKER_RUNTIME_INVALID") throw error;
    throw runtimeError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function verifyRuntimeNamespace() {
  if (
    process.execPath !== DOCUMENT_WORKER_NODE_RUNTIME.path ||
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() === 0 ||
    process.getgid() === 0
  ) throw runtimeError();
}

export async function assertIntegrationDocumentWorkerRuntimeActivation() {
  if (!activationPromise) {
    activationPromise = (async () => {
      const runtime = await verifyIntegrationDocumentWorkerNodeRuntime();
      await verifyRuntimeNamespace();
      return runtime;
    })().catch((error) => {
      activationPromise = null;
      throw error;
    });
  }
  return activationPromise;
}
