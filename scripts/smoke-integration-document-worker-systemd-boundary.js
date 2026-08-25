import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assertIntegrationDocumentWorkerRuntimeActivation,
  verifyIntegrationDocumentWorkerNodeRuntime,
} from "../src/integration-document-worker-runtime.js";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const exampleRoot = path.join(repositoryRoot, "examples", "document-worker");
const unit = await fs.readFile(path.join(exampleRoot, "aginti-document-worker.service"), "utf8");
const configText = await fs.readFile(path.join(exampleRoot, "document-worker.json"), "utf8");
const runtimeManifest = JSON.parse(await fs.readFile(path.join(exampleRoot, "runtime-manifest.json"), "utf8"));
const config = validateIntegrationDocumentWorkerConfig(JSON.parse(configText));

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
assert.match(
  unit,
  /^ExecStart=\/home\/lachlan\/\.nvm\/versions\/node\/v22\.21\.0\/bin\/node /mu
);
assert.match(
  unit,
  /^ExecStartPre=\/usr\/bin\/node \/opt\/agintiflow-document-worker\/current\/bin\/aginti-document-worker-runtime-check\.js$/mu
);
assert.doesNotMatch(unit, /^ExecStart=\/usr\/bin\/node /mu);
assert.match(unit, /^ProtectHome=tmpfs$/mu);
assert.match(
  unit,
  /^BindReadOnlyPaths=\/home\/lachlan\/\.nvm\/versions\/node\/v22\.21\.0\/bin\/node$/mu
);
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
assert.doesNotMatch(unit, /^Environment(?:File)?=/mu);
assert.doesNotMatch(unit, /Bearer\s+[A-Za-z0-9._~+/=-]{32,}/u);
assert.deepEqual(runtimeManifest, {
  schemaVersion: "aginti-document-worker-runtime-manifest-v1",
  node: {
    path: "/home/lachlan/.nvm/versions/node/v22.21.0/bin/node",
    version: "v22.21.0",
    sha256: "29e9c28204d89d85cc426b518b4a7c6e32aafecd5e447d65301ffb2c1c15335a",
    owner: "lachlan",
    group: "lachlan",
    mode: "0755",
    size: 123351032,
    unitMount: "read-only",
  },
});
assert.equal((await verifyIntegrationDocumentWorkerNodeRuntime()).sha256, runtimeManifest.node.sha256);
const preflight = spawnSync(
  "/usr/bin/node",
  [path.join(repositoryRoot, "bin", "aginti-document-worker-runtime-check.js")],
  { encoding: "utf8", env: Object.freeze({ PATH: "/usr/bin:/bin" }) }
);
assert.equal(preflight.status, 0, preflight.stderr);
assert.equal(preflight.stdout, "");
assert.equal(preflight.stderr, "");
await assert.rejects(
  () => assertIntegrationDocumentWorkerRuntimeActivation(),
  (error) => error?.code === "DOCUMENT_WORKER_RUNTIME_INVALID",
  "runtime activation must fail closed outside ProtectHome=tmpfs and its exact read-only bind"
);

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
