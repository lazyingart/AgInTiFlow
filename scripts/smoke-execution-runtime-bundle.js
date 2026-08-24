import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildExecutionRuntimeBundle,
  ExecutionRuntimeBundleError,
  validateExecutionRuntimeBundle,
} from "../src/execution-runtime-bundle.js";
import {
  buildExecutionWorkerCommand,
  createPythonExecutionWorker,
  EXECUTION_JOB_SCHEMA_VERSION,
  ExecutionWorkerError,
  probeExecutionWorkerRuntime,
} from "../src/execution-worker.js";
import { contractDigest } from "../src/integration-policy.js";

const requireLive = process.env.AGINTI_EXECUTION_RUNTIME_BUNDLE_REQUIRE_LIVE === "1";
const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-execution-runtime-smoke-"));

function sourceDigest(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function job(source) {
  return Object.freeze({
    schemaVersion: EXECUTION_JOB_SCHEMA_VERSION,
    jobId: `job_${crypto.randomBytes(24).toString("base64url")}`,
    attempt: 1,
    language: "python",
    source,
    sourceSha256: sourceDigest(source),
    stdin: "",
    timeoutMs: 5_000,
  });
}

async function makeRemovable(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch { return; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(target, 0o700);
  const items = await fs.readdir(target, { withFileTypes: true });
  for (const item of items) {
    if (item.isDirectory() && !item.isSymbolicLink()) await makeRemovable(path.join(target, item.name));
  }
}

async function cleanup() {
  await makeRemovable(temporaryParent);
  await fs.rm(temporaryParent, { recursive: true, force: true });
}

async function assertNoSymlinks(target) {
  const items = await fs.readdir(target, { withFileTypes: true });
  for (const item of items) {
    assert.equal(item.isSymbolicLink(), false, `sealed runtime contains symlink ${path.join(target, item.name)}`);
    if (item.isDirectory()) await assertNoSymlinks(path.join(target, item.name));
  }
}

let first;
let second;
try {
  first = await buildExecutionRuntimeBundle({
    bundleDirectory: path.join(temporaryParent, "bundle-a"),
    testOnlyAllowUntrustedOwnership: true,
  });
  second = await buildExecutionRuntimeBundle({
    bundleDirectory: path.join(temporaryParent, "bundle-b"),
    testOnlyAllowUntrustedOwnership: true,
  });
} catch (error) {
  await cleanup();
  if (requireLive) throw error;
  if (!(error instanceof ExecutionRuntimeBundleError)) throw error;
  console.log(JSON.stringify({
    ok: true,
    live: false,
    skipped: "fixed Linux Python, ldd, and Bubblewrap prerequisites are unavailable",
    code: error.code,
  }));
  process.exit(0);
}

try {
  assert.equal(first.rootDigest, second.rootDigest, "two builds from the same trusted sources must be deterministic");
  assert.equal(first.entryCount, second.entryCount);
  assert.equal(first.totalFileBytes, second.totalFileBytes);
  assert(first.entryCount > 100 && first.totalFileBytes > 1_000_000);
  await assertNoSymlinks(first.rootPath);

  await assert.rejects(
    validateExecutionRuntimeBundle({ bundleDirectory: first.bundleDirectory }),
    (error) => error instanceof ExecutionRuntimeBundleError && error.code === "EXECUTION_RUNTIME_BUNDLE_UNTRUSTED"
  );
  const validated = await validateExecutionRuntimeBundle({
    bundleDirectory: first.bundleDirectory,
    expectedRootDigest: first.rootDigest,
    testOnlyAllowUntrustedOwnership: true,
  });
  assert.equal(validated.rootDigest, first.rootDigest);

  const command = buildExecutionWorkerCommand({ runtimeRoot: first.rootPath });
  const rootMountIndex = command.args.indexOf(first.rootPath);
  assert(rootMountIndex > 0);
  assert.equal(command.args[rootMountIndex - 1], "--ro-bind");
  assert.equal(command.args[rootMountIndex + 1], "/");
  assert.equal(command.args.includes("/usr"), false, "sealed command must not bind host /usr");
  assert.equal(command.args.includes("/lib"), false, "sealed command must not bind host /lib");
  assert.equal(command.args.includes("/lib64"), false, "sealed command must not bind host /lib64");

  const proof = await probeExecutionWorkerRuntime({
    runtimeBundleDirectory: first.bundleDirectory,
    expectedRuntimeBundleRootDigest: first.rootDigest,
    testOnlyAllowUntrustedRuntimeBundle: true,
  });
  assert.equal(proof.nonRoot, true);
  assert.equal(proof.networkNone, true);
  assert.equal(proof.privatePathsAbsent, true);

  const worker = createPythonExecutionWorker({
    workerId: `worker_${crypto.randomBytes(24).toString("base64url")}`,
    runtimeBundleDirectory: first.bundleDirectory,
    expectedRuntimeBundleRootDigest: first.rootDigest,
    testOnlyAllowUntrustedRuntimeBundle: true,
    testOnlyAllowMissingSeccomp: true,
  });
  const capabilities = await worker.capabilities();
  assert.equal(capabilities.runtime.minimalRuntimeRoot, true);
  assert.equal(capabilities.runtime.runtimeBundleDigestPinned, true);
  assert.equal(capabilities.runtime.runtimeBundleRootDigest, first.rootDigest);
  assert.equal(capabilities.activation.publicReady, false, "the bundle alone must not unlock public execution");
  assert.equal(capabilities.activation.blockers.includes("minimal-runtime-root-unproven"), false);
  assert(capabilities.activation.blockers.includes("aggregate-cgroup-containment-unproven"));
  assert(capabilities.activation.blockers.includes("test-only-bypass-configured"));
  assert.equal(capabilities.activation.blockers.includes("public-activation-locked"), false);

  const unpinnedWorker = createPythonExecutionWorker({
    workerId: `worker_${crypto.randomBytes(24).toString("base64url")}`,
    runtimeBundleDirectory: first.bundleDirectory,
    testOnlyAllowUntrustedRuntimeBundle: true,
    testOnlyAllowMissingSeccomp: true,
  });
  const unpinnedCapabilities = await unpinnedWorker.capabilities();
  assert.equal(unpinnedCapabilities.runtime.runtimeBundleDigestPinned, false);
  assert(unpinnedCapabilities.activation.blockers.includes("runtime-bundle-digest-unpinned"));

  const source = `
import json
import math
import os
import subprocess

blocked = {}
for executable in ("/usr/bin/bash", "/usr/bin/node", "/usr/bin/gcc", "/bin/sh"):
    try:
        subprocess.run([executable, "--version"], check=False, capture_output=True)
        blocked[executable] = False
    except (FileNotFoundError, PermissionError):
        blocked[executable] = True

points = [math.sin(index / 4) for index in range(9)]
print(json.dumps({
    "blocked": blocked,
    "executables": sorted(os.listdir("/usr/bin")),
    "host_paths_absent": all(not os.path.exists(value) for value in ("/etc", "/home", "/root", "/usr/local")),
}, sort_keys=True))
emit_plot("Sine sample", {
    "schemaVersion": "1",
    "type": "line",
    "labels": [str(index) for index in range(len(points))],
    "series": [{"name": "sin(x/4)", "data": points}],
})
`;
  const result = await worker.execute(job(source));
  assert.equal(result.status, "succeeded");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, "plot");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.executables, ["prlimit", "python3.12"]);
  assert.equal(output.host_paths_absent, true);
  assert(Object.values(output.blocked).every(Boolean));

  const forgedContent = Buffer.from("forged executable\n", "utf8");
  const forgedDirectory = path.join(second.rootPath, "opt");
  const forgedPath = path.join(forgedDirectory, "evil");
  await fs.chmod(second.rootPath, 0o755);
  await fs.mkdir(forgedDirectory, { mode: 0o700 });
  await fs.writeFile(forgedPath, forgedContent, { mode: 0o555 });
  await fs.chmod(forgedPath, 0o555);
  await fs.chmod(forgedDirectory, 0o555);
  await fs.chmod(second.rootPath, 0o555);
  const manifestPath = path.join(second.bundleDirectory, "manifest.json");
  const forgedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  forgedManifest.entries.push(
    { path: "/opt", type: "directory", mode: 0o555 },
    {
      path: "/opt/evil",
      type: "file",
      mode: 0o555,
      size: forgedContent.byteLength,
      sha256: sourceDigest(forgedContent),
    }
  );
  forgedManifest.entries.sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
  forgedManifest.entryCount = forgedManifest.entries.length;
  forgedManifest.totalFileBytes += forgedContent.byteLength;
  forgedManifest.rootDigest = contractDigest({
    schemaVersion: forgedManifest.schemaVersion,
    profile: forgedManifest.profile,
    executables: forgedManifest.executables,
    entries: forgedManifest.entries,
  });
  await fs.chmod(manifestPath, 0o644);
  await fs.writeFile(manifestPath, `${JSON.stringify(forgedManifest)}\n`);
  await fs.chmod(manifestPath, 0o444);
  await assert.rejects(
    validateExecutionRuntimeBundle({
      bundleDirectory: second.bundleDirectory,
      testOnlyAllowUntrustedOwnership: true,
    }),
    (error) => error instanceof ExecutionRuntimeBundleError && error.code === "EXECUTION_RUNTIME_BUNDLE_INVALID"
  );

  console.log(JSON.stringify({
    ok: true,
    live: true,
    profile: first.profile,
    rootDigest: first.rootDigest,
    entryCount: first.entryCount,
    totalFileBytes: first.totalFileBytes,
    usrBinAllowlist: ["prlimit", "python3.12"],
    plotArtifacts: result.artifacts.length,
    publicActivation: capabilities.activation.publicReady,
  }));
} catch (error) {
  if (error instanceof ExecutionWorkerError && !requireLive) {
    console.log(JSON.stringify({ ok: true, live: false, skipped: error.code }));
  } else {
    throw error;
  }
} finally {
  await cleanup();
}
