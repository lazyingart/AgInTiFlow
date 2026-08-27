import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DOCUMENT_WORKER_CREDENTIALS_DIRECTORY,
  DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_NAME,
  loadIntegrationDocumentWorkerConfig,
  parseIntegrationDocumentWorkerCredential,
  validateIntegrationDocumentWorkerConfig,
} from "../src/integration-document-worker-config.js";
import { parseIntegrationDocumentWorkerArguments } from "../src/integration-document-worker-cli.js";
import {
  DOCUMENT_WORKER_NODE_RUNTIME,
  DOCUMENT_WORKER_RUNTIME_ANCESTRY,
  assertIntegrationDocumentWorkerRuntimeActivation,
  verifyIntegrationDocumentWorkerNodeRuntime,
} from "../src/integration-document-worker-runtime.js";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const exampleRoot = path.join(repositoryRoot, "examples", "document-worker");
const unit = await fs.readFile(path.join(exampleRoot, "aginti-document-worker.service"), "utf8");
const configText = await fs.readFile(path.join(exampleRoot, "document-worker.json"), "utf8");
const runtimeManifest = JSON.parse(await fs.readFile(path.join(exampleRoot, "runtime-manifest.json"), "utf8"));
const config = validateIntegrationDocumentWorkerConfig(JSON.parse(configText));
const runtimePath = "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85/bin/node";
const releasePath = "/opt/agintiflow-document-worker/releases/RELEASE_SHA256";
const unitLines = unit.trimEnd().split("\n");

assert.equal(config.listen.host, "127.0.0.1");
assert.equal(config.listen.port, 18102);
assert.equal(config.stateRoot, "/var/lib/aginti-document-worker");
assert.equal(config.creation.enabled, false);
assert.equal(config.creation.maximumConcurrentCompiles, 2);
assert.match(unit, /^User=aginti-document-worker$/mu);
assert.match(unit, /^Group=aginti-document-worker$/mu);
assert.match(unit, /^UMask=0077$/mu);
assert.match(unit, /^StateDirectory=aginti-document-worker$/mu);
assert.match(unit, /^StateDirectoryMode=0700$/mu);
assert.deepEqual(unitLines.filter((line) => line.startsWith("Environment=")), [
  "Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin",
]);
assert.doesNotMatch(unit, /^EnvironmentFile=/mu);
assert.deepEqual(unitLines.filter((line) => line.startsWith("ExecStartPre=")), [
  `ExecStartPre=${runtimePath} ${releasePath}/bin/aginti-document-worker-runtime-check.js`,
  `ExecStartPre=${runtimePath} ${releasePath}/bin/aginti-document-worker.js check --config /etc/agintiflow/document-worker.json`,
]);
assert.deepEqual(unitLines.filter((line) => line.startsWith("ExecStart=")), [
  `ExecStart=${runtimePath} ${releasePath}/bin/aginti-document-worker.js serve --config /etc/agintiflow/document-worker.json`,
]);
assert.doesNotMatch(unit, /\/home\/lachlan|\.nvm|\/usr\/bin\/node|\/current(?:\/|$)/u);
assert.match(unit, /^ProtectHome=tmpfs$/mu);
assert.doesNotMatch(unit, /^BindReadOnlyPaths=/mu);
assert.match(
  unit,
  new RegExp(`^LoadCredential=${DOCUMENT_WORKER_UPSTREAM_CREDENTIAL_NAME}:/etc/agintiflow/credentials/document-worker-upstream-token$`, "mu")
);
assert.match(unit, /^NoNewPrivileges=yes$/mu);
assert.match(unit, /^ProtectSystem=strict$/mu);
assert.match(unit, /^RestrictNamespaces=~time$/mu);
assert.doesNotMatch(unit, /^RestrictNamespaces=true$/mu);
assert.match(unit, /^IPAddressDeny=any$/mu);
assert.match(unit, /^IPAddressAllow=localhost$/mu);
assert.match(unit, /^SocketBindAllow=tcp:18102$/mu);
assert.match(unit, /^MemorySwapMax=0$/mu);
assert.match(unit, /^LimitCORE=0$/mu);
assert.doesNotMatch(unit, /^ConditionPathIsReadWrite=/mu);
assert.doesNotMatch(unit, /Bearer\s+[A-Za-z0-9._~+/=-]{32,}/u);
assert.deepEqual(runtimeManifest, {
  schemaVersion: "aginti-document-worker-runtime-manifest-v1",
  node: {
    path: runtimePath,
    version: "v22.21.0",
    sha256: "29e9c28204d89d85cc426b518b4a7c6e32aafecd5e447d65301ffb2c1c15335a",
    owner: "root",
    group: "root",
    mode: "0555",
    size: 123351032,
    unitMount: "none",
  },
  immutableAncestry: {
    owner: "root",
    group: "root",
    mode: "0555",
    applicationRootEntries: ["releases", "runtimes"],
    paths: [
      "/opt/agintiflow-document-worker",
      "/opt/agintiflow-document-worker/runtimes",
      "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85",
      "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85/bin",
    ],
  },
});
assert.deepEqual(DOCUMENT_WORKER_NODE_RUNTIME, {
  path: runtimePath,
  version: runtimeManifest.node.version,
  sha256: runtimeManifest.node.sha256,
  uid: 0,
  gid: 0,
  mode: 0o555,
  size: runtimeManifest.node.size,
});
assert.deepEqual(DOCUMENT_WORKER_RUNTIME_ANCESTRY, [
  { path: "/", uid: 0, gid: 0, mode: 0o755 },
  { path: "/opt", uid: 0, gid: 0, mode: 0o755 },
  {
    path: "/opt/agintiflow-document-worker",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: ["releases", "runtimes"],
  },
  {
    path: "/opt/agintiflow-document-worker/runtimes",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: ["node-v22.21.0-29e9c28204d89d85"],
  },
  {
    path: "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: ["bin"],
  },
  {
    path: "/opt/agintiflow-document-worker/runtimes/node-v22.21.0-29e9c28204d89d85/bin",
    uid: 0,
    gid: 0,
    mode: 0o555,
    expectedEntries: ["node"],
  },
]);
await assert.rejects(
  () => verifyIntegrationDocumentWorkerNodeRuntime(),
  (error) => error?.code === "DOCUMENT_WORKER_RUNTIME_INVALID",
  "runtime identity must fail closed when the sealed /opt runtime is not installed"
);
const preflight = spawnSync(
  process.execPath,
  [path.join(repositoryRoot, "bin", "aginti-document-worker-runtime-check.js")],
  { encoding: "utf8", env: Object.freeze({ PATH: "/usr/bin:/bin" }) }
);
assert.equal(preflight.status, 1, preflight.stderr);
assert.equal(preflight.stdout, "");
assert.equal(preflight.stderr, "aginti-document-worker-runtime-check: RUNTIME_IDENTITY_INVALID\n");
await assert.rejects(
  () => assertIntegrationDocumentWorkerRuntimeActivation(),
  (error) => error?.code === "DOCUMENT_WORKER_RUNTIME_INVALID",
  "runtime activation must fail closed outside the exact installed runtime and service-user namespace"
);

const runtimeFixture = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-runtime-tree-"));
const fixtureApplicationRoot = path.join(runtimeFixture, "agintiflow-document-worker");
const fixtureVersionRoot = path.join(
  fixtureApplicationRoot,
  "runtimes",
  "node-v22.21.0-29e9c28204d89d85"
);
const fixtureBinRoot = path.join(fixtureVersionRoot, "bin");
const fixtureNode = path.join(fixtureBinRoot, "node");
const fixtureReleaseId = "0".repeat(64);
const fixtureReleaseRoot = path.join(fixtureApplicationRoot, "releases", fixtureReleaseId);
const bubblewrapProbe = spawnSync("/usr/bin/bwrap", [
  "--unshare-all",
  "--unshare-user",
  "--uid", "0",
  "--gid", "0",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  "--cap-drop", "ALL",
  "--ro-bind", "/usr", "/usr",
  "--ro-bind", "/lib", "/lib",
  "--ro-bind", "/lib64", "/lib64",
  "--ro-bind", "/bin", "/bin",
  "--proc", "/proc",
  "--dev", "/dev",
  "/usr/bin/true",
], {
  encoding: "utf8",
  env: Object.freeze({ PATH: "/usr/bin:/bin" }),
});
const githubHostedNamespaceRestriction =
  process.env.AGINTIFLOW_GITHUB_HOSTED_BWRAP_NAMESPACE_RESTRICTION === "allow-sigkill"
  && bubblewrapProbe.status === null
  && bubblewrapProbe.signal === "SIGKILL"
  && bubblewrapProbe.stderr === "";
if (!githubHostedNamespaceRestriction) {
  assert.equal(bubblewrapProbe.status, 0, bubblewrapProbe.stderr);
  assert.equal(bubblewrapProbe.signal, null);
  assert.equal(bubblewrapProbe.stdout, "");
  assert.equal(bubblewrapProbe.stderr, "");
}
try {
  await fs.mkdir(fixtureReleaseRoot, { recursive: true, mode: 0o755 });
  await fs.mkdir(fixtureBinRoot, { recursive: true, mode: 0o755 });
  await fs.copyFile(process.execPath, fixtureNode, fsConstants.COPYFILE_FICLONE);
  await fs.chmod(fixtureNode, 0o555);
  for (const directory of [
    fixtureApplicationRoot,
    path.join(fixtureApplicationRoot, "runtimes"),
    fixtureVersionRoot,
    fixtureBinRoot,
  ]) await fs.chmod(directory, 0o555);
  if (githubHostedNamespaceRestriction) {
    process.stdout.write("sealed runtime tree proof skipped: GitHub-hosted runner killed the bubblewrap namespace probe\n");
  } else {
    const fixtureProof = spawnSync("/usr/bin/bwrap", [
      "--unshare-all",
      "--unshare-user",
      "--uid", "0",
      "--gid", "0",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/bin", "/bin",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--dir", "/opt",
      "--ro-bind", fixtureApplicationRoot, "/opt/agintiflow-document-worker",
      "--ro-bind", repositoryRoot, `/opt/agintiflow-document-worker/releases/${fixtureReleaseId}`,
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "HOME", "/tmp",
      runtimePath,
      "--input-type=module",
      "-e",
      `import { verifyIntegrationDocumentWorkerNodeRuntime } from "file:///opt/agintiflow-document-worker/releases/${fixtureReleaseId}/src/integration-document-worker-runtime.js"; await verifyIntegrationDocumentWorkerNodeRuntime(); process.stdout.write("sealed runtime tree passed\\n");`,
    ], {
      encoding: "utf8",
      env: Object.freeze({ PATH: "/usr/bin:/bin" }),
    });
    assert.equal(fixtureProof.status, 0, fixtureProof.stderr);
    assert.equal(fixtureProof.signal, null);
    assert.equal(fixtureProof.stdout, "sealed runtime tree passed\n");
    assert.equal(fixtureProof.stderr, "");
  }
} finally {
  for (const directory of [
    fixtureApplicationRoot,
    path.join(fixtureApplicationRoot, "runtimes"),
    fixtureVersionRoot,
    fixtureBinRoot,
  ]) await fs.chmod(directory, 0o700).catch(() => {});
  await fs.rm(runtimeFixture, { recursive: true, force: true });
}

assert.deepEqual(parseIntegrationDocumentWorkerArguments([
  "serve",
  "--config",
  "/etc/agintiflow/document-worker.json",
]), {
  command: "serve",
  configPath: "/etc/agintiflow/document-worker.json",
});
assert.equal(DOCUMENT_WORKER_CREDENTIALS_DIRECTORY, "/run/credentials/aginti-document-worker.service");
assert.equal(
  parseIntegrationDocumentWorkerCredential("document-worker-test-token-0123456789abcdef\n"),
  "document-worker-test-token-0123456789abcdef"
);
assert.throws(
  () => parseIntegrationDocumentWorkerCredential("document-worker-test-token-0123456789abcdef\nsecond-line"),
  (error) => error?.code === "DOCUMENT_WORKER_CREDENTIAL_INVALID"
);
assert.throws(
  () => parseIntegrationDocumentWorkerCredential("document-worker-test-token-0123456789abcdef\r\n"),
  (error) => error?.code === "DOCUMENT_WORKER_CREDENTIAL_INVALID"
);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-config-security-"));
try {
  const protectedConfig = path.join(temporary, "document-worker.json");
  await fs.writeFile(protectedConfig, configText, { flag: "wx", mode: 0o600 });
  assert.equal((await loadIntegrationDocumentWorkerConfig(protectedConfig)).creation.enabled, false);

  await fs.chmod(protectedConfig, 0o644);
  await assert.rejects(
    () => loadIntegrationDocumentWorkerConfig(protectedConfig),
    (error) => error?.code === "DOCUMENT_WORKER_PROTECTED_FILE_INVALID"
  );
  await fs.chmod(protectedConfig, 0o600);

  const symlinkConfig = path.join(temporary, "document-worker-symlink.json");
  await fs.symlink(protectedConfig, symlinkConfig);
  await assert.rejects(
    () => loadIntegrationDocumentWorkerConfig(symlinkConfig),
    (error) => error?.code === "DOCUMENT_WORKER_PROTECTED_FILE_INVALID"
  );

  const hardlinkConfig = path.join(temporary, "document-worker-hardlink.json");
  await fs.link(protectedConfig, hardlinkConfig);
  await assert.rejects(
    () => loadIntegrationDocumentWorkerConfig(protectedConfig),
    (error) => error?.code === "DOCUMENT_WORKER_PROTECTED_FILE_INVALID"
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

process.stdout.write("integration document worker systemd boundary smoke passed\n");
