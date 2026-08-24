import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { contractDigest } from "./integration-policy.js";

export const EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION = "aginti-execution-runtime-bundle-v1";
export const EXECUTION_RUNTIME_BUNDLE_PROFILE = "python312-curated-root-v1";
export const EXECUTION_RUNTIME_BUNDLE_MANIFEST = "manifest.json";
export const EXECUTION_RUNTIME_BUNDLE_ROOT = "root";
export const EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT = "/opt/aginti-execution-runtime/releases";
export const EXECUTION_RUNTIME_BUNDLE_PATHS = Object.freeze({
  python: "/usr/bin/python3.12",
  prlimit: "/usr/bin/prlimit",
  stdlib: "/usr/lib/python3.12",
});

const FIXED_EXECUTABLES = Object.freeze([
  EXECUTION_RUNTIME_BUNDLE_PATHS.prlimit,
  EXECUTION_RUNTIME_BUNDLE_PATHS.python,
  "/lib64/ld-linux-x86-64.so.2",
]);
const FORBIDDEN_PATHS = Object.freeze([
  "/bin",
  "/etc",
  "/home",
  "/root",
  "/sbin",
  "/sys",
  "/usr/bin/bash",
  "/usr/bin/curl",
  "/usr/bin/env",
  "/usr/bin/gcc",
  "/usr/bin/node",
  "/usr/bin/sh",
  "/usr/local",
]);
const OMITTED_STDLIB_TOP_LEVEL = new Set([
  "EXTERNALLY-MANAGED",
  "ensurepip",
  "idlelib",
  "sitecustomize.py",
  "tkinter",
  "turtledemo",
  "venv",
]);
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ENTRY_PATH = /^\/(?:[A-Za-z0-9._+-]+\/?)+$/u;
const MAX_LDD_OUTPUT_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 4_096;
const MAX_BUNDLE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 128 * 1024 * 1024;

export class ExecutionRuntimeBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionRuntimeBundleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExecutionRuntimeBundleError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactPlainObject(input, keys, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} must be a plain data object.`);
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} fields do not match the schema.`);
  }
  return input;
}

function normalizeAbsolutePath(value, label) {
  if (typeof value !== "string" || !SAFE_ENTRY_PATH.test(value) || path.posix.normalize(value) !== value
      || value === "/" || value.includes("//") || value.includes("/../") || value.endsWith("/..")) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} is not a canonical absolute path.`);
  }
  return value;
}

function insidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hostPathForRoot(rootPath, absolutePath) {
  const normalized = normalizeAbsolutePath(absolutePath, "runtime entry path");
  const hostPath = path.join(rootPath, normalized.slice(1));
  if (!insidePath(hostPath, rootPath)) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime entry escaped its bundle root.");
  }
  return hostPath;
}

async function trustedSourceFile(sourcePath, filesystem) {
  let realPath;
  let stat;
  try {
    realPath = await filesystem.realpath(sourcePath);
    stat = await filesystem.stat(realPath);
  } catch {
    fail("EXECUTION_RUNTIME_SOURCE_UNAVAILABLE", `required runtime source ${sourcePath} is unavailable.`);
  }
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o6022) !== 0) {
    fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", `required runtime source ${sourcePath} is not root-owned and immutable.`);
  }
  return Object.freeze({ sourcePath, realPath, stat });
}

async function collectProcessOutput(command, args, { spawnImpl = nodeSpawn, maximumBytes = MAX_LDD_OUTPUT_BYTES } = {}) {
  let child;
  try {
    child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: Object.freeze({ LANG: "C", PATH: "/usr/bin" }),
    });
  } catch {
    fail("EXECUTION_RUNTIME_DEPENDENCY_SCAN_FAILED", "runtime dependency scanner could not start.");
  }
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let overflow = false;
  const collect = (target, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes <= maximumBytes) target.push(buffer);
    else {
      overflow = true;
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    }
  };
  child.stdout?.on("data", (chunk) => collect(stdout, chunk));
  child.stderr?.on("data", (chunk) => collect(stderr, chunk));
  const completed = await new Promise((resolve) => {
    let error = null;
    child.once("error", (value) => { error = value; });
    child.once("close", (code, signal) => resolve({ code, signal, error }));
  });
  if (overflow || completed.error || completed.code !== 0 || completed.signal) {
    fail("EXECUTION_RUNTIME_DEPENDENCY_SCAN_FAILED", "runtime dependency scanner did not complete cleanly.");
  }
  return Object.freeze({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
}

function parseLddOutput(output) {
  const dependencies = new Set();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("linux-vdso.so.") || trimmed === "statically linked") continue;
    if (/=>\s+not found(?:\s|$)/u.test(trimmed)) {
      fail("EXECUTION_RUNTIME_DEPENDENCY_MISSING", "a runtime shared-library dependency is unresolved.");
    }
    const mapped = trimmed.match(/=>\s+(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/u);
    const direct = trimmed.match(/^(\/[^\s]+)\s+\(0x[0-9a-f]+\)$/u);
    const dependency = mapped?.[1] ?? direct?.[1];
    if (!dependency) {
      fail("EXECUTION_RUNTIME_DEPENDENCY_SCAN_FAILED", "runtime dependency output was not recognized.");
    }
    dependencies.add(normalizeAbsolutePath(dependency, "runtime dependency path"));
  }
  return dependencies;
}

async function listTreeFiles(rootPath, filesystem, relative = "") {
  const directory = relative ? path.join(rootPath, relative) : rootPath;
  let items;
  try {
    items = await filesystem.readdir(directory, { withFileTypes: true });
  } catch {
    fail("EXECUTION_RUNTIME_SOURCE_UNAVAILABLE", `runtime source tree ${directory} could not be read.`);
  }
  const files = [];
  for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
    if (item.name.includes("\0") || item.name === "." || item.name === "..") {
      fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", "runtime source tree contains an invalid entry.");
    }
    const childRelative = relative ? path.join(relative, item.name) : item.name;
    const topLevel = childRelative.split(path.sep)[0];
    if (OMITTED_STDLIB_TOP_LEVEL.has(topLevel) || topLevel.startsWith("config-")) continue;
    if (item.name === "__pycache__" || item.name.endsWith(".pyc") || item.name.endsWith(".pyo")) continue;
    const childPath = path.join(rootPath, childRelative);
    if (item.isDirectory()) {
      files.push(...await listTreeFiles(rootPath, filesystem, childRelative));
      continue;
    }
    if (item.isFile()) {
      files.push(childPath);
      continue;
    }
    if (item.isSymbolicLink()) {
      let resolved;
      try { resolved = await filesystem.realpath(childPath); } catch {
        fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", "runtime source tree contains a broken symbolic link.");
      }
      if (!insidePath(resolved, rootPath)) {
        fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", "runtime source tree contains an external symbolic link.");
      }
      const targetStat = await filesystem.stat(resolved);
      if (!targetStat.isFile()) {
        fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", "runtime source tree symbolic links must resolve to files.");
      }
      files.push(childPath);
      continue;
    }
    fail("EXECUTION_RUNTIME_SOURCE_UNTRUSTED", "runtime source tree contains an unsupported entry type.");
  }
  return files;
}

function entryDigestPayload(entries) {
  return entries.map(({ path: entryPath, type, mode, size, sha256: digest }) => ({
    path: entryPath,
    type,
    mode,
    ...(type === "file" ? { size, sha256: digest } : {}),
  }));
}

function runtimeRootDigest(entries) {
  return contractDigest({
    schemaVersion: EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION,
    profile: EXECUTION_RUNTIME_BUNDLE_PROFILE,
    executables: FIXED_EXECUTABLES,
    entries: entryDigestPayload(entries),
  });
}

async function copyRuntimeFile({ sourcePath, destinationPath, executable, filesystem }) {
  const trusted = await trustedSourceFile(sourcePath, filesystem);
  let content;
  try { content = await filesystem.readFile(trusted.realPath); } catch {
    fail("EXECUTION_RUNTIME_SOURCE_UNAVAILABLE", `runtime source ${sourcePath} could not be read.`);
  }
  await filesystem.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await filesystem.writeFile(destinationPath, content, { flag: "wx", mode: executable ? 0o555 : 0o444 });
  await filesystem.chmod(destinationPath, executable ? 0o555 : 0o444);
  return Object.freeze({ size: content.byteLength, sha256: sha256(content) });
}

async function addParentDirectories(rootPath, filePaths, filesystem) {
  const directories = new Set(["/"]);
  for (const filePath of filePaths) {
    let current = path.posix.dirname(filePath);
    while (current !== "/") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  for (const fixed of ["/dev", "/proc", "/tmp", "/work"]) directories.add(fixed);
  const ordered = [...directories].sort((left, right) => {
    const depth = (value) => value.split("/").length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
  for (const directory of ordered) {
    if (directory === "/") continue;
    await filesystem.mkdir(hostPathForRoot(rootPath, directory), { recursive: true, mode: 0o700 });
  }
  return ordered;
}

async function sealDirectories(rootPath, directories, filesystem) {
  const reverse = [...directories].sort((left, right) => right.length - left.length || right.localeCompare(left));
  for (const directory of reverse) {
    const destination = directory === "/" ? rootPath : hostPathForRoot(rootPath, directory);
    await filesystem.chmod(destination, 0o555);
  }
}

export async function buildExecutionRuntimeBundle({
  bundleDirectory,
  filesystem = fs,
  spawnImpl = nodeSpawn,
  testOnlyAllowUntrustedOwnership = false,
} = {}) {
  if (typeof bundleDirectory !== "string" || !path.isAbsolute(bundleDirectory) || path.normalize(bundleDirectory) !== bundleDirectory) {
    throw new TypeError("bundleDirectory must be a canonical absolute path");
  }
  if (bundleDirectory === "/" || bundleDirectory === "/usr" || bundleDirectory === "/opt") {
    throw new TypeError("bundleDirectory must be a dedicated version directory");
  }
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl must be a function");
  if (typeof testOnlyAllowUntrustedOwnership !== "boolean") {
    throw new TypeError("testOnlyAllowUntrustedOwnership must be a boolean");
  }
  try {
    await filesystem.mkdir(bundleDirectory, { recursive: false, mode: 0o700 });
  } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_EXISTS", "runtime bundle destination must be a new directory.");
  }
  const rootPath = path.join(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_ROOT);
  await filesystem.mkdir(rootPath, { recursive: false, mode: 0o700 });

  const stdlibFiles = await listTreeFiles(EXECUTION_RUNTIME_BUNDLE_PATHS.stdlib, filesystem);
  const dependencyInputs = [
    EXECUTION_RUNTIME_BUNDLE_PATHS.python,
    EXECUTION_RUNTIME_BUNDLE_PATHS.prlimit,
    ...stdlibFiles.filter((value) => value.includes(`${path.sep}lib-dynload${path.sep}`) && value.endsWith(".so")),
  ];
  const dependencies = new Set();
  for (const input of dependencyInputs) {
    const scanned = await collectProcessOutput("/usr/bin/ldd", [input], { spawnImpl });
    for (const dependency of parseLddOutput(scanned.stdout)) dependencies.add(dependency);
  }

  const sourceByDestination = new Map([
    [EXECUTION_RUNTIME_BUNDLE_PATHS.python, EXECUTION_RUNTIME_BUNDLE_PATHS.python],
    [EXECUTION_RUNTIME_BUNDLE_PATHS.prlimit, EXECUTION_RUNTIME_BUNDLE_PATHS.prlimit],
  ]);
  for (const sourcePath of stdlibFiles) {
    const relative = path.relative(EXECUTION_RUNTIME_BUNDLE_PATHS.stdlib, sourcePath);
    sourceByDestination.set(path.posix.join(EXECUTION_RUNTIME_BUNDLE_PATHS.stdlib, relative.split(path.sep).join("/")), sourcePath);
  }
  for (const dependency of dependencies) sourceByDestination.set(dependency, dependency);

  for (const forbidden of FORBIDDEN_PATHS) {
    if (sourceByDestination.has(forbidden) || [...sourceByDestination.keys()].some((value) => value.startsWith(`${forbidden}/`))) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `runtime source selection included forbidden path ${forbidden}.`);
    }
  }
  const filePaths = [...sourceByDestination.keys()].sort();
  const directories = await addParentDirectories(rootPath, filePaths, filesystem);
  const fileEntries = [];
  for (const destination of filePaths) {
    const executable = FIXED_EXECUTABLES.includes(destination);
    const copied = await copyRuntimeFile({
      sourcePath: sourceByDestination.get(destination),
      destinationPath: hostPathForRoot(rootPath, destination),
      executable,
      filesystem,
    });
    fileEntries.push(Object.freeze({ path: destination, type: "file", mode: executable ? 0o555 : 0o444, ...copied }));
  }
  await sealDirectories(rootPath, directories, filesystem);
  const entries = Object.freeze([
    ...directories.map((directory) => Object.freeze({ path: directory, type: "directory", mode: 0o555 })),
    ...fileEntries,
  ].sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type)));
  const manifest = Object.freeze({
    schemaVersion: EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION,
    profile: EXECUTION_RUNTIME_BUNDLE_PROFILE,
    rootDigest: runtimeRootDigest(entries),
    entryCount: entries.length,
    totalFileBytes: fileEntries.reduce((sum, entry) => sum + entry.size, 0),
    executables: FIXED_EXECUTABLES,
    entries,
  });
  await filesystem.writeFile(
    path.join(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_MANIFEST),
    `${JSON.stringify(manifest)}\n`,
    { flag: "wx", mode: 0o444 }
  );
  await filesystem.chmod(path.join(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_MANIFEST), 0o444);
  await filesystem.chmod(bundleDirectory, 0o555);
  return validateExecutionRuntimeBundle({
    bundleDirectory,
    filesystem,
    testOnlyAllowUntrustedOwnership,
  });
}

async function scanBundleRoot(rootPath, filesystem, relative = "", state = { entries: 0, totalBytes: 0 }) {
  const directory = relative ? path.join(rootPath, relative) : rootPath;
  let items;
  try { items = await filesystem.readdir(directory, { withFileTypes: true }); } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle root could not be traversed.");
  }
  const entries = [];
  for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? path.join(relative, item.name) : item.name;
    const entryPath = `/${childRelative.split(path.sep).join("/")}`;
    const childPath = path.join(rootPath, childRelative);
    if (item.isSymbolicLink()) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle contains a symbolic link.");
    }
    let stat;
    try { stat = await filesystem.lstat(childPath); } catch {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle entry could not be inspected.");
    }
    state.entries += 1;
    if (state.entries > MAX_BUNDLE_ENTRIES) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle contains too many entries.");
    }
    if (item.isDirectory() && stat.isDirectory()) {
      entries.push({ path: entryPath, type: "directory", mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid });
      entries.push(...await scanBundleRoot(rootPath, filesystem, childRelative, state));
      continue;
    }
    if (item.isFile() && stat.isFile()) {
      state.totalBytes += stat.size;
      if (stat.size > MAX_BUNDLE_FILE_BYTES || state.totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
        fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle file bounds exceed policy.");
      }
      let content;
      try { content = await filesystem.readFile(childPath); } catch {
        fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle file could not be read.");
      }
      entries.push({
        path: entryPath,
        type: "file",
        mode: stat.mode & 0o7777,
        uid: stat.uid,
        gid: stat.gid,
        nlink: stat.nlink,
        size: content.byteLength,
        sha256: sha256(content),
      });
      continue;
    }
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle contains an unsupported entry type.");
  }
  return entries;
}

function validateManifestEntry(input, index) {
  const label = `runtime manifest entry[${index}]`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} is invalid.`);
  }
  if (input.type === "directory") {
    exactPlainObject(input, ["path", "type", "mode"], label);
    if (input.path !== "/") normalizeAbsolutePath(input.path, `${label}.path`);
    if (input.mode !== 0o555) fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} mode is invalid.`);
  } else if (input.type === "file") {
    exactPlainObject(input, ["path", "type", "mode", "size", "sha256"], label);
    normalizeAbsolutePath(input.path, `${label}.path`);
    if ((input.mode !== 0o444 && input.mode !== 0o555) || !Number.isSafeInteger(input.size) || input.size < 0
        || typeof input.sha256 !== "string" || !DIGEST.test(input.sha256)) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} metadata is invalid.`);
    }
  } else {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `${label} type is invalid.`);
  }
  return input;
}

export async function validateExecutionRuntimeBundle({
  bundleDirectory,
  filesystem = fs,
  expectedRootDigest,
  testOnlyAllowUntrustedOwnership = false,
} = {}) {
  if (typeof bundleDirectory !== "string" || !path.isAbsolute(bundleDirectory) || path.normalize(bundleDirectory) !== bundleDirectory) {
    throw new TypeError("bundleDirectory must be a canonical absolute path");
  }
  if (expectedRootDigest !== undefined && (typeof expectedRootDigest !== "string" || !DIGEST.test(expectedRootDigest))) {
    throw new TypeError("expectedRootDigest must be a sha256-like contract digest");
  }
  if (typeof testOnlyAllowUntrustedOwnership !== "boolean") {
    throw new TypeError("testOnlyAllowUntrustedOwnership must be a boolean");
  }
  if (!testOnlyAllowUntrustedOwnership
      && (!insidePath(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT)
        || bundleDirectory === EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT)) {
    fail(
      "EXECUTION_RUNTIME_BUNDLE_UNTRUSTED",
      `runtime bundle must be a version beneath ${EXECUTION_RUNTIME_BUNDLE_PRODUCTION_ROOT}.`
    );
  }
  const rootPath = path.join(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_ROOT);
  const manifestPath = path.join(bundleDirectory, EXECUTION_RUNTIME_BUNDLE_MANIFEST);
  let bundleStat;
  let rootStat;
  let manifestStat;
  let manifestRaw;
  let resolvedBundle;
  let resolvedRoot;
  let resolvedManifest;
  try {
    [resolvedBundle, resolvedRoot, resolvedManifest] = await Promise.all([
      filesystem.realpath(bundleDirectory),
      filesystem.realpath(rootPath),
      filesystem.realpath(manifestPath),
    ]);
  } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle structure is incomplete.");
  }
  if (resolvedBundle !== bundleDirectory || resolvedRoot !== rootPath || resolvedManifest !== manifestPath) {
    fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle path must not traverse symbolic links.");
  }
  if (!testOnlyAllowUntrustedOwnership) {
    const components = bundleDirectory.split("/").filter(Boolean);
    let current = "/";
    for (const component of components) {
      current = path.join(current, component);
      let componentStat;
      try { componentStat = await filesystem.lstat(current); } catch {
        fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle ancestry could not be inspected.");
      }
      if (!componentStat.isDirectory() || componentStat.isSymbolicLink()
          || componentStat.uid !== 0 || componentStat.gid !== 0 || (componentStat.mode & 0o022) !== 0) {
        fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle ancestry is not root-controlled.");
      }
    }
  }
  try {
    [bundleStat, rootStat, manifestStat] = await Promise.all([
      filesystem.lstat(bundleDirectory),
      filesystem.lstat(rootPath),
      filesystem.lstat(manifestPath),
    ]);
  } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle structure is incomplete.");
  }
  if (!bundleStat.isDirectory() || !rootStat.isDirectory() || !manifestStat.isFile() || manifestStat.nlink !== 1
      || bundleStat.isSymbolicLink() || rootStat.isSymbolicLink() || manifestStat.isSymbolicLink()) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle structure contains an unexpected file type.");
  }
  if (manifestStat.size < 2 || manifestStat.size > MAX_MANIFEST_BYTES) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle manifest exceeds its byte bound.");
  }
  try { manifestRaw = await filesystem.readFile(manifestPath, "utf8"); } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle manifest could not be read.");
  }
  const ownership = [bundleStat, rootStat, manifestStat];
  if (!testOnlyAllowUntrustedOwnership && ownership.some((stat) => stat.uid !== 0 || stat.gid !== 0)) {
    fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle must be owned by root.");
  }
  if (ownership.some((stat) => (stat.mode & 0o6022) !== 0)) {
    fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle metadata is writable or executable unexpectedly.");
  }
  let manifest;
  try { manifest = JSON.parse(manifestRaw); } catch {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle manifest is not valid JSON.");
  }
  exactPlainObject(
    manifest,
    ["schemaVersion", "profile", "rootDigest", "entryCount", "totalFileBytes", "executables", "entries"],
    "runtime bundle manifest"
  );
  if (manifest.schemaVersion !== EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION
      || manifest.profile !== EXECUTION_RUNTIME_BUNDLE_PROFILE
      || typeof manifest.rootDigest !== "string" || !DIGEST.test(manifest.rootDigest)
      || !Number.isSafeInteger(manifest.entryCount) || manifest.entryCount < 1
      || manifest.entryCount > MAX_BUNDLE_ENTRIES
      || !Number.isSafeInteger(manifest.totalFileBytes) || manifest.totalFileBytes < 1
      || manifest.totalFileBytes > MAX_BUNDLE_TOTAL_BYTES
      || !Array.isArray(manifest.executables) || manifest.executables.length !== FIXED_EXECUTABLES.length
      || manifest.executables.some((value, index) => value !== FIXED_EXECUTABLES[index])
      || !Array.isArray(manifest.entries) || manifest.entries.length !== manifest.entryCount) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle manifest metadata is invalid.");
  }
  const declared = manifest.entries.map(validateManifestEntry);
  const declaredKeys = declared.map((entry) => `${entry.type}:${entry.path}`);
  const entriesOrdered = declared.every((entry, index) => index === 0
    || declared[index - 1].path.localeCompare(entry.path) < 0
    || (declared[index - 1].path === entry.path && declared[index - 1].type.localeCompare(entry.type) <= 0));
  if (new Set(declaredKeys).size !== declaredKeys.length || !entriesOrdered) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle manifest entries are duplicated or unordered.");
  }
  const rootEntry = declared.find((entry) => entry.path === "/" && entry.type === "directory");
  if (!rootEntry || (rootStat.mode & 0o7777) !== rootEntry.mode) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle root metadata does not match its manifest.");
  }
  const actual = await scanBundleRoot(rootPath, filesystem);
  actual.push({ path: "/", type: "directory", mode: rootStat.mode & 0o7777, uid: rootStat.uid, gid: rootStat.gid });
  actual.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  if (actual.length !== declared.length) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle contains missing or extra entries.");
  }
  let totalFileBytes = 0;
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const observed = actual[index];
    if (expected.path !== observed.path || expected.type !== observed.type || expected.mode !== observed.mode
        || (expected.type === "file" && (expected.size !== observed.size || expected.sha256 !== observed.sha256))) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle content does not match its manifest.");
    }
    if (!testOnlyAllowUntrustedOwnership && (observed.uid !== 0 || observed.gid !== 0)) {
      fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle entry must be owned by root.");
    }
    if (observed.type === "file" && observed.nlink !== 1) {
      fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle files must not have hard-link aliases.");
    }
    if ((observed.mode & 0o6022) !== 0) {
      fail("EXECUTION_RUNTIME_BUNDLE_UNTRUSTED", "runtime bundle entry is writable or executable unexpectedly.");
    }
    if (expected.type === "file") totalFileBytes += expected.size;
  }
  if (totalFileBytes !== manifest.totalFileBytes || runtimeRootDigest(declared) !== manifest.rootDigest
      || (expectedRootDigest !== undefined && manifest.rootDigest !== expectedRootDigest)) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle digest does not match its content contract.");
  }
  const declaredPaths = new Set(declared.map(({ path: entryPath }) => entryPath));
  for (const required of FIXED_EXECUTABLES) {
    const entry = declared.find((candidate) => candidate.path === required && candidate.type === "file");
    if (!entry || entry.mode !== 0o555) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `runtime executable ${required} is absent or not executable.`);
    }
  }
  for (const forbidden of FORBIDDEN_PATHS) {
    if (declaredPaths.has(forbidden) || [...declaredPaths].some((value) => value.startsWith(`${forbidden}/`))) {
      fail("EXECUTION_RUNTIME_BUNDLE_INVALID", `runtime bundle contains forbidden path ${forbidden}.`);
    }
  }
  const executableFiles = declared
    .filter((entry) => entry.type === "file" && entry.mode === 0o555)
    .map((entry) => entry.path)
    .sort();
  const expectedExecutables = [...FIXED_EXECUTABLES].sort();
  if (executableFiles.length !== expectedExecutables.length
      || executableFiles.some((value, index) => value !== expectedExecutables[index])) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle executable allowlist does not match policy.");
  }
  const usrBinFiles = declared
    .filter((entry) => entry.type === "file" && path.posix.dirname(entry.path) === "/usr/bin")
    .map((entry) => entry.path)
    .sort();
  const expectedUsrBin = [EXECUTION_RUNTIME_BUNDLE_PATHS.prlimit, EXECUTION_RUNTIME_BUNDLE_PATHS.python].sort();
  if (usrBinFiles.length !== expectedUsrBin.length || usrBinFiles.some((value, index) => value !== expectedUsrBin[index])) {
    fail("EXECUTION_RUNTIME_BUNDLE_INVALID", "runtime bundle /usr/bin allowlist does not match policy.");
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    bundleDirectory,
    rootPath,
    rootDigest: manifest.rootDigest,
    entryCount: manifest.entryCount,
    totalFileBytes: manifest.totalFileBytes,
    executables: Object.freeze([...manifest.executables]),
  });
}
