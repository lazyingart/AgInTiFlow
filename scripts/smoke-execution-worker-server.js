import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";

import {
  createProductionExecutionWorkerServer,
  EXECUTION_WORKER_CREDENTIALS_DIRECTORY,
  EXECUTION_WORKER_CREDENTIAL_NAME,
  EXECUTION_WORKER_SERVER_SCHEMA_VERSION,
  installExecutionWorkerShutdownHandlers,
  loadExecutionWorkerServerConfig,
} from "../src/execution-worker-server.js";

const digest = "a".repeat(64);
const token = "server-smoke-token_abcdefghijklmnopqrstuvwxyz0123456789";
const tokenPath = `${EXECUTION_WORKER_CREDENTIALS_DIRECTORY}/${EXECUTION_WORKER_CREDENTIAL_NAME}`;
const environment = Object.freeze({
  CREDENTIALS_DIRECTORY: EXECUTION_WORKER_CREDENTIALS_DIRECTORY,
  AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY: "/opt/aginti-execution-runtime/releases/release-a",
  AGINTI_EXECUTION_RUNTIME_BUNDLE_DIGEST: digest,
});

function stat({ directory = false, credential = false, generation = 1 } = {}) {
  return Object.freeze({
    dev: 10,
    ino: directory ? 11 : 12,
    uid: 0,
    gid: 0,
    mode: (directory ? 0o040000 | 0o500 : 0o100000 | 0o400),
    nlink: directory ? 2 : 1,
    size: directory ? 0 : Buffer.byteLength(`${token}\n`, "utf8"),
    ctimeMs: generation,
    isDirectory: () => directory,
    isFile: () => credential,
    isSymbolicLink: () => false,
  });
}

function filesystem({ tokenValue = `${token}\n`, changed = false, symbolic = false, writable = false } = {}) {
  const directoryStat = stat({ directory: true });
  const credentialStat = stat({ credential: true });
  let credentialStats = 0;
  return Object.freeze({
    realpath: async (value) => symbolic && value === tokenPath ? "/redirected/token" : value,
    access: async (_value, mode) => {
      assert.equal(mode, fsConstants.W_OK);
      if (writable) return;
      throw Object.assign(new Error("read-only"), { code: "EACCES" });
    },
    lstat: async (value) => {
      if (value === EXECUTION_WORKER_CREDENTIALS_DIRECTORY) return directoryStat;
      if (value === tokenPath) {
        credentialStats += 1;
        return changed && credentialStats > 1 ? stat({ credential: true, generation: 2 }) : credentialStat;
      }
      throw new Error("unexpected path");
    },
    open: async (value, flags) => {
      assert.equal(value, tokenPath);
      assert((flags & fsConstants.O_NOFOLLOW) !== 0);
      return Object.freeze({
        stat: async () => credentialStat,
        readFile: async () => tokenValue,
        close: async () => {},
      });
    },
  });
}

const config = await loadExecutionWorkerServerConfig({ filesystem: filesystem(), environment });
assert.equal(config.schemaVersion, EXECUTION_WORKER_SERVER_SCHEMA_VERSION);
assert.equal(config.runtimeBundleDirectory, environment.AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY);
assert.equal(config.runtimeBundleRootDigest, digest);
assert.equal(config.bearerToken, token);
assert.match(config.workerId, /^worker_[A-Za-z0-9_-]{43}$/u);
assert.equal(Object.values(config).some((value) => String(value).includes("redirected")), false);

for (const badEnvironment of [
  { ...environment, CREDENTIALS_DIRECTORY: "/tmp/credentials" },
  { ...environment, AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY: "/tmp/runtime" },
  { ...environment, AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY: "/opt/aginti-execution-runtime/releases" },
  { ...environment, AGINTI_EXECUTION_RUNTIME_BUNDLE_DIRECTORY: "/opt/aginti-execution-runtime/releases/../evil" },
  { ...environment, AGINTI_EXECUTION_RUNTIME_BUNDLE_DIGEST: "A".repeat(64) },
  { ...environment, AGINTI_EXECUTION_TEST_BYPASS: "1" },
]) {
  await assert.rejects(
    loadExecutionWorkerServerConfig({ filesystem: filesystem(), environment: badEnvironment }),
    (error) => error.code === "EXECUTION_WORKER_CONFIG_INVALID"
  );
}

await assert.rejects(
  loadExecutionWorkerServerConfig({ filesystem: filesystem({ tokenValue: `${token}\nsecond\n` }), environment }),
  (error) => error.code === "EXECUTION_WORKER_CREDENTIAL_CHANGED" || error.code === "EXECUTION_WORKER_CREDENTIAL_INVALID"
);
await assert.rejects(
  loadExecutionWorkerServerConfig({ filesystem: filesystem({ changed: true }), environment }),
  (error) => error.code === "EXECUTION_WORKER_CREDENTIAL_CHANGED"
);
await assert.rejects(
  loadExecutionWorkerServerConfig({ filesystem: filesystem({ symbolic: true }), environment }),
  (error) => error.code === "EXECUTION_WORKER_CREDENTIAL_INVALID"
);
await assert.rejects(
  loadExecutionWorkerServerConfig({ filesystem: filesystem({ writable: true }), environment }),
  (error) => error.code === "EXECUTION_WORKER_CREDENTIAL_INVALID"
);

const runtime = await createProductionExecutionWorkerServer({ config, listen: false });
assert.equal(runtime.worker.kind, "aginti-execution-worker");
assert.equal(runtime.worker.testOnlyBypassActive, false);
assert.equal(runtime.manager.kind, "aginti-execution-job-manager");
assert.equal(runtime.address, null);

const processObject = new EventEmitter();
processObject.exitCode = null;
processObject.exit = () => assert.fail("graceful close must not force process exit");
let closes = 0;
const handlers = installExecutionWorkerShutdownHandlers({
  close(callback) {
    closes += 1;
    callback();
  },
}, { processObject });
assert.equal(typeof handlers.shutdown, "function");
processObject.emit("SIGTERM");
processObject.emit("SIGINT");
assert.equal(closes, 1);
assert.equal(processObject.exitCode, 0);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: config.schemaVersion,
  credentialSource: "systemd-only",
  runtimeBundlePinned: true,
  systemdSocketOnly: true,
  testBypassPresent: false,
}));
