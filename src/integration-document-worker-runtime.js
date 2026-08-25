import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

export const DOCUMENT_WORKER_NODE_RUNTIME = Object.freeze({
  path: "/home/lachlan/.nvm/versions/node/v22.21.0/bin/node",
  version: "v22.21.0",
  sha256: "29e9c28204d89d85cc426b518b4a7c6e32aafecd5e447d65301ffb2c1c15335a",
  uid: 1000,
  gid: 1000,
  mode: 0o755,
  size: 123_351_032,
});

const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);
const O_CLOEXEC = Number(fsConstants.O_CLOEXEC || 0);
const EXPECTED_HOME_TREE = Object.freeze([
  Object.freeze(["/home/lachlan", Object.freeze([".nvm"])]),
  Object.freeze(["/home/lachlan/.nvm", Object.freeze(["versions"])]),
  Object.freeze(["/home/lachlan/.nvm/versions", Object.freeze(["node"])]),
  Object.freeze(["/home/lachlan/.nvm/versions/node", Object.freeze(["v22.21.0"])]),
  Object.freeze(["/home/lachlan/.nvm/versions/node/v22.21.0", Object.freeze(["bin"])]),
  Object.freeze(["/home/lachlan/.nvm/versions/node/v22.21.0/bin", Object.freeze(["node"])]),
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

export async function verifyIntegrationDocumentWorkerNodeRuntime() {
  let handle;
  try {
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
    const [after, afterNamed] = await Promise.all([handle.stat(), fs.lstat(DOCUMENT_WORKER_NODE_RUNTIME.path)]);
    if (
      sha256 !== DOCUMENT_WORKER_NODE_RUNTIME.sha256 ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, afterNamed)
    ) throw runtimeError();
    return Object.freeze({ ...DOCUMENT_WORKER_NODE_RUNTIME });
  } catch (error) {
    if (error?.code === "DOCUMENT_WORKER_RUNTIME_INVALID") throw error;
    throw runtimeError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function unescapeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/gu, (match, code) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\",
  })[code] || match);
}

function hasReadOnlyRuntimeBind(mountInfo) {
  return String(mountInfo || "").split("\n").some((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) return false;
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6 || unescapeMountPath(fields[4]) !== DOCUMENT_WORKER_NODE_RUNTIME.path) return false;
    return fields[5].split(",").includes("ro");
  });
}

async function verifyRuntimeNamespace() {
  if (
    process.execPath !== DOCUMENT_WORKER_NODE_RUNTIME.path ||
    typeof process.getuid !== "function" ||
    process.getuid() === 0 ||
    process.getuid() === DOCUMENT_WORKER_NODE_RUNTIME.uid
  ) throw runtimeError();
  for (const [directory, expectedEntries] of EXPECTED_HOME_TREE) {
    const entries = (await fs.readdir(directory)).sort();
    if (entries.length !== expectedEntries.length) throw runtimeError();
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index] !== expectedEntries[index]) throw runtimeError();
    }
  }
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  if (!hasReadOnlyRuntimeBind(mountInfo)) throw runtimeError();
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
