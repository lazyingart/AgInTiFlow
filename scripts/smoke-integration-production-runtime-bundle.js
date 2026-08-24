#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_HEALTH_VERSION,
  INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LIMITATIONS,
  INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_VERSION,
  checkIntegrationProductionRuntimeBundle,
  integrationProductionRuntimeBundlePaths,
  openIntegrationProductionRuntimeBundle,
  preflightIntegrationProductionRuntimeBundle,
} from "../src/integration-production-runtime-bundle.js";
import {
  INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE,
} from "../src/integration-retained-idempotency-store.js";
import { contractDigest } from "../src/integration-policy.js";

const UID = process.getuid();
const GID = process.getgid();

async function expectCode(action, expectedCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `Expected ${expectedCode}`);
  assert.equal(captured.publicCode || captured.code, expectedCode, captured.stack || captured.message);
}

async function expectNoUnhandledRejections(action) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await action();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
}

async function ensureOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function ensureLockFile(filePath) {
  try {
    await fs.writeFile(filePath, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

async function provisionRuntimeRoot(stateRoot, { omitEventLock = false } = {}) {
  const paths = integrationProductionRuntimeBundlePaths(stateRoot);
  for (const directoryPath of [
    paths.stateRoot,
    path.dirname(paths.repository),
    paths.repository,
    paths.sessions,
    paths.workspace,
    paths.eventLedger,
    paths.idempotency,
  ]) {
    await ensureOwnerDirectory(directoryPath);
  }
  await ensureLockFile(paths.repositoryLock);
  await ensureLockFile(paths.sessionLock);
  if (!omitEventLock) await ensureLockFile(paths.eventLedgerLock);
  await ensureLockFile(paths.idempotencyLock);
  return paths;
}

async function inventory(stateRoot) {
  const names = await fs.readdir(stateRoot, { recursive: true });
  return names.map((name) => String(name)).sort();
}

function assertEvidenceDigest(evidence) {
  const { digest, ...unsigned } = evidence;
  assert.equal(digest, contractDigest(unsigned));
}

async function run() {
  const missingRoot = path.join(
    os.tmpdir(),
    `aginti-production-runtime-bundle-missing-${process.pid}-${Date.now()}`
  );
  const missing = await checkIntegrationProductionRuntimeBundle({ stateRoot: missingRoot });
  assert.equal(missing.schemaVersion, INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_HEALTH_VERSION);
  assert.equal(missing.healthy, false);
  assert.equal(missing.implementationReady, false);
  assert.equal(missing.capabilityEnabled, false);
  assert.equal(missing.httpServingEnabled, false);
  assert.equal(missing.firstBlocker.component, "storageAuthority");
  assert.equal(missing.firstBlocker.code, "INTEGRATION_STORAGE_UNAVAILABLE");
  assert.equal(missing.blockers[1].component, "idempotencyStore");
  assertEvidenceDigest(missing);

  let proxyTrapCalls = 0;
  const proxiedInput = new Proxy(Object.freeze({ stateRoot: missingRoot }), {
    get() {
      proxyTrapCalls += 1;
      throw new Error("bundle input get trap must not run");
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error("bundle input ownKeys trap must not run");
    },
  });
  await expectCode(
    () => openIntegrationProductionRuntimeBundle(proxiedInput),
    "INTEGRATION_RUNTIME_BUNDLE_INVALID"
  );
  assert.equal(proxyTrapCalls, 0);
  const revocable = Proxy.revocable(Object.freeze({ stateRoot: missingRoot }), {});
  revocable.revoke();
  await expectCode(
    () => openIntegrationProductionRuntimeBundle(revocable.proxy),
    "INTEGRATION_RUNTIME_BUNDLE_INVALID"
  );

  let accessorCalls = 0;
  const accessorInput = {};
  Object.defineProperty(accessorInput, "stateRoot", {
    configurable: true,
    enumerable: true,
    get() {
      accessorCalls += 1;
      return missingRoot;
    },
  });
  await expectCode(
    () => openIntegrationProductionRuntimeBundle(accessorInput),
    "INTEGRATION_RUNTIME_BUNDLE_INVALID"
  );
  assert.equal(accessorCalls, 0);
  await expectCode(
    () => openIntegrationProductionRuntimeBundle(Object.create({ stateRoot: missingRoot })),
    "INTEGRATION_RUNTIME_BUNDLE_INVALID"
  );
  await expectNoUnhandledRejections(async () => {
    const rejectedInput = Promise.reject(new Error("already rejected bundle input"));
    await expectCode(
      () => openIntegrationProductionRuntimeBundle(rejectedInput),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
    const rejectedStateRoot = Promise.reject(new Error("already rejected stateRoot"));
    await expectCode(
      () => openIntegrationProductionRuntimeBundle({ stateRoot: rejectedStateRoot }),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
    const rejectedOpenExtra = Promise.reject(new Error("already rejected open extra"));
    await expectCode(
      () => openIntegrationProductionRuntimeBundle({ stateRoot: missingRoot }, rejectedOpenExtra),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
    const rejectedPreflightExtra = Promise.reject(new Error("already rejected preflight extra"));
    await expectCode(
      () => preflightIntegrationProductionRuntimeBundle({ stateRoot: missingRoot }, rejectedPreflightExtra),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
    const rejectedCheckExtra = Promise.reject(new Error("already rejected check extra"));
    await expectCode(
      () => checkIntegrationProductionRuntimeBundle({ stateRoot: missingRoot }, rejectedCheckExtra),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
    const rejectedPathsExtra = Promise.reject(new Error("already rejected paths extra"));
    await expectCode(
      () => integrationProductionRuntimeBundlePaths(missingRoot, rejectedPathsExtra),
      "INTEGRATION_RUNTIME_BUNDLE_INVALID"
    );
  });

  const nonDirectoryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-production-runtime-nondirectory-")
  );
  try {
    const nonDirectory = path.join(nonDirectoryRoot, "not-a-directory");
    await fs.writeFile(nonDirectory, "blocked", { mode: 0o600 });
    const unavailable = await checkIntegrationProductionRuntimeBundle({
      stateRoot: path.join(nonDirectory, "child"),
    });
    assert.equal(unavailable.healthy, false);
    assert.equal(unavailable.firstBlocker.component, "storageAuthority");
    assert.equal(unavailable.firstBlocker.code, "INTEGRATION_STORAGE_UNAVAILABLE");
    if (UID !== 0) {
      const deniedParent = path.join(nonDirectoryRoot, "denied");
      await fs.mkdir(deniedParent, { mode: 0o700 });
      await fs.chmod(deniedParent, 0o000);
      try {
        const denied = await checkIntegrationProductionRuntimeBundle({
          stateRoot: path.join(deniedParent, "child"),
        });
        assert.equal(denied.healthy, false);
        assert.equal(denied.firstBlocker.component, "storageAuthority");
        assert.equal(denied.firstBlocker.code, "INTEGRATION_STORAGE_UNAVAILABLE");
      } finally {
        await fs.chmod(deniedParent, 0o700);
      }
    }
  } finally {
    await fs.rm(nonDirectoryRoot, { recursive: true, force: true });
  }

  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-production-runtime-bundle-"));
  const poisonRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-production-runtime-poison-"));
  const lockModeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-production-runtime-lock-mode-"));
  const lockReplacementRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-production-runtime-lock-replacement-")
  );
  const failedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-production-runtime-failed-"));
  const idempotencyCorruptionRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-production-runtime-idempotency-corrupt-")
  );
  try {
    const paths = await provisionRuntimeRoot(stateRoot);
    assert.equal(paths.repository, path.join(stateRoot, "runtime-authority", "repository"));
    assert.equal(paths.sessions, path.join(stateRoot, "runtime-authority", "sessions"));
    assert.equal(paths.workspace, path.join(stateRoot, "runtime-authority", "workspace"));
    assert.equal(paths.eventLedger, path.join(stateRoot, "event-ledger"));
    assert.equal(paths.idempotency, path.join(stateRoot, "idempotency-store"));

    const beforePreflight = await inventory(stateRoot);
    const check = await checkIntegrationProductionRuntimeBundle({ stateRoot });
    assert.equal(check.healthy, true);
    assert.equal(check.implementationReady, false);
    assert.equal(check.firstBlocker.component, "idempotencyStore");
    assert.equal(
      check.firstBlocker.code,
      "INTEGRATION_IDEMPOTENCY_TRUSTED_RECOVERY_RECEIPT_AUTHORITY_UNAVAILABLE"
    );
    assert.equal(check.components.storageAuthority.descriptorBound, true);
    assert.equal(check.components.repository.descriptorBound, true);
    assert.equal(check.components.repository.runtimeFenceAcquired, false);
    assert.equal(check.components.sessionState.descriptorBound, true);
    assert.equal(check.components.sessionState.nativeWriteFenceBound, false);
    assert.equal(check.components.eventLedger.runtimeAppendView, true);
    assert.equal(check.components.eventLedger.sessionReadView, true);
    assert.equal(check.components.idempotencyStore.namespaceDescriptorBound, true);
    assert.equal(check.components.idempotencyStore.descriptorBound, true);
    assert.equal(check.components.idempotencyStore.transactionalStore, false);
    assert.equal(check.components.idempotencyStore.recoveryAuthorityBound, false);
    assert.equal(check.components.idempotencyStore.trustedRecoveryReceiptAuthorityBound, false);
    assert.equal(check.components.idempotencyStore.publicMutationResponseByteEnvelopeCovered, true);
    assert.equal(check.components.idempotencyStore.boundedTransactionalSubstrate, true);
    assert.equal(check.components.idempotencyStore.integrationApiCompatibleWhenRecoveryBound, false);
    assert.notEqual(check.components.idempotencyStore.proofDigest, "0".repeat(64));
    assert.equal(check.components.nativeExecutor.lexicalProofPresent, true);
    assert.equal(check.components.nativeExecutor.retainedSessionStateBound, false);
    assert.equal(check.components.nativeExecutor.artifactEvents, false);
    assert.equal(check.components.sandbox.capabilityEnabled, false);
    assert.equal(check.components.runtimeAuthority.composed, false);
    assert.equal(check.components.sessionService.composed, false);
    assertEvidenceDigest(check);
    assert.deepEqual(await inventory(stateRoot), beforePreflight);

    const directPreflight = await preflightIntegrationProductionRuntimeBundle({ stateRoot });
    assert.equal(directPreflight.probe, "preflight");
    assert.equal(directPreflight.healthy, true);
    assert.equal(directPreflight.implementationReady, false);
    assert.deepEqual(await inventory(stateRoot), beforePreflight);

    const bundle = await openIntegrationProductionRuntimeBundle({ stateRoot });
    assert.equal(Object.getPrototypeOf(bundle), null);
    assert.equal(Object.isFrozen(bundle), true);
    assert.equal(bundle.schemaVersion, INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_VERSION);
    assert.equal(bundle.attestation.descriptorBound, true);
    assert.equal(bundle.attestation.storageLifecycleOwned, true);
    assert.equal(bundle.attestation.implementationReady, false);
    assert.equal(bundle.attestation.capabilityEnabled, false);
    assert.equal(bundle.attestation.httpServingEnabled, false);
    assert.equal(bundle.attestation.runtimeActivated, false);
    assert.notEqual(bundle.attestation.idempotencyProofDigest, "0".repeat(64));
    assert.equal(bundle.attestation.blockers[0].component, "idempotencyStore");
    assert.equal(bundle.attestation.limitations, INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LIMITATIONS);
    assert.equal("start" in bundle, false);
    assert.equal("serve" in bundle, false);
    assert.equal("runtimeAuthority" in bundle, false);
    assert.equal("sessionService" in bundle, false);
    assert.throws(() => Object.defineProperty(bundle, "start", { value() {} }), TypeError);
    await expectCode(() => bundle.health({}), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
    await expectCode(() => bundle.preflight({}), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
    await expectCode(() => bundle.close({}), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
    await expectCode(() => bundle.isClosed({}), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
    await expectNoUnhandledRejections(async () => {
      const rejectedHealthExtra = Promise.reject(new Error("already rejected health extra"));
      await expectCode(() => bundle.health(rejectedHealthExtra), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
      const rejectedPreflightExtra = Promise.reject(new Error("already rejected preflight extra"));
      await expectCode(
        () => bundle.preflight(rejectedPreflightExtra),
        "INTEGRATION_RUNTIME_BUNDLE_INVALID"
      );
      const rejectedCloseExtra = Promise.reject(new Error("already rejected close extra"));
      await expectCode(() => bundle.close(rejectedCloseExtra), "INTEGRATION_RUNTIME_BUNDLE_INVALID");
      const rejectedClosedExtra = Promise.reject(new Error("already rejected isClosed extra"));
      await expectCode(
        () => bundle.isClosed(rejectedClosedExtra),
        "INTEGRATION_RUNTIME_BUNDLE_INVALID"
      );
    });

    const healthy = await bundle.health();
    assert.equal(healthy.probe, "health");
    assert.equal(healthy.status, "healthy-disabled");
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.implementationReady, false);
    assertEvidenceDigest(healthy);

    const concurrentHealth = await Promise.all([
      bundle.health(),
      bundle.preflight(),
      bundle.health(),
    ]);
    assert.deepEqual(
      concurrentHealth.map((item) => item.healthy),
      [true, true, true]
    );

    const racingProbe = bundle.health();
    const racingClose = bundle.close();
    await expectCode(() => racingProbe, "INTEGRATION_RUNTIME_BUNDLE_CLOSED");
    assert.deepEqual(await racingClose, { closed: true, poisoned: false });
    assert.equal(bundle.isClosed(), true);
    assert.deepEqual(await bundle.close(), { closed: true, poisoned: false });
    await expectCode(() => bundle.health(), "INTEGRATION_RUNTIME_BUNDLE_CLOSED");
    await expectCode(() => bundle.preflight(), "INTEGRATION_RUNTIME_BUNDLE_CLOSED");

    await provisionRuntimeRoot(poisonRoot);
    const poisonedBundle = await openIntegrationProductionRuntimeBundle({ stateRoot: poisonRoot });
    await fs.chmod(poisonRoot, 0o755);
    await expectCode(() => poisonedBundle.health(), "INTEGRATION_STORAGE_POISONED");
    await fs.chmod(poisonRoot, 0o700);
    await expectCode(() => poisonedBundle.health(), "INTEGRATION_RUNTIME_BUNDLE_POISONED");
    assert.deepEqual(await poisonedBundle.close(), { closed: true, poisoned: true });

    const lockModePaths = await provisionRuntimeRoot(lockModeRoot);
    const lockModeBundle = await openIntegrationProductionRuntimeBundle({ stateRoot: lockModeRoot });
    await fs.chmod(lockModePaths.repositoryLock, 0o640);
    await expectCode(() => lockModeBundle.health(), "INTEGRATION_STORAGE_LOCK_POISONED");
    await fs.chmod(lockModePaths.repositoryLock, 0o600);
    await expectCode(() => lockModeBundle.health(), "INTEGRATION_RUNTIME_BUNDLE_POISONED");
    assert.deepEqual(await lockModeBundle.close(), { closed: true, poisoned: true });

    const replacementPaths = await provisionRuntimeRoot(lockReplacementRoot);
    const replacementBundle = await openIntegrationProductionRuntimeBundle({
      stateRoot: lockReplacementRoot,
    });
    const displacedSessionLock = `${replacementPaths.sessionLock}.displaced`;
    await fs.rename(replacementPaths.sessionLock, displacedSessionLock);
    await ensureLockFile(replacementPaths.sessionLock);
    await expectCode(
      () => replacementBundle.health(),
      "INTEGRATION_STORAGE_LOCK_POISONED"
    );
    await expectCode(
      () => replacementBundle.preflight(),
      "INTEGRATION_RUNTIME_BUNDLE_POISONED"
    );
    assert.deepEqual(await replacementBundle.close(), { closed: true, poisoned: true });

    const failedPaths = await provisionRuntimeRoot(failedRoot, { omitEventLock: true });
    await expectCode(
      () => openIntegrationProductionRuntimeBundle({ stateRoot: failedRoot }),
      "INTEGRATION_STORAGE_UNAVAILABLE"
    );
    await ensureLockFile(failedPaths.eventLedgerLock);
    const recoveredFromFactoryFailure = await openIntegrationProductionRuntimeBundle({
      stateRoot: failedRoot,
    });
    assert.equal((await recoveredFromFactoryFailure.health()).healthy, true);
    await recoveredFromFactoryFailure.close();

    const corruptIdempotencyPaths = await provisionRuntimeRoot(idempotencyCorruptionRoot);
    await fs.writeFile(
      path.join(
        corruptIdempotencyPaths.idempotency,
        INTEGRATION_RETAINED_IDEMPOTENCY_SNAPSHOT_FILE
      ),
      "{}\n",
      { mode: 0o600 }
    );
    await expectCode(
      () => openIntegrationProductionRuntimeBundle({
        stateRoot: idempotencyCorruptionRoot,
      }),
      "IDEMPOTENCY_STORE_CORRUPT"
    );
    const corruptIdempotencyCheck = await checkIntegrationProductionRuntimeBundle({
      stateRoot: idempotencyCorruptionRoot,
    });
    assert.equal(corruptIdempotencyCheck.healthy, false);
    assert.equal(corruptIdempotencyCheck.firstBlocker.component, "idempotencyStore");
    assert.equal(corruptIdempotencyCheck.firstBlocker.code, "IDEMPOTENCY_STORE_CORRUPT");

    const [cliSource, serverSource, bundleSource] = await Promise.all([
      fs.readFile(new URL("../src/integration-cli.js", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/integration-server.js", import.meta.url), "utf8"),
      fs.readFile(new URL("../src/integration-production-runtime-bundle.js", import.meta.url), "utf8"),
    ]);
    assert.match(cliSource, /checkIntegrationProductionRuntimeBundle/u);
    assert.doesNotMatch(serverSource, /integration-production-runtime-bundle/u);
    assert.doesNotMatch(
      bundleSource,
      /acquireRetainedIntegrationRuntimeRepositoryFence|createAgintiIntegrationRuntimeAuthority|createNativeIntegrationSessionService|createFileIntegrationIdempotencyStore/u
    );
  } finally {
    await fs.chmod(poisonRoot, 0o700).catch(() => {});
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(poisonRoot, { recursive: true, force: true });
    await fs.rm(lockModeRoot, { recursive: true, force: true });
    await fs.rm(lockReplacementRoot, { recursive: true, force: true });
    await fs.rm(failedRoot, { recursive: true, force: true });
    await fs.rm(idempotencyCorruptionRoot, { recursive: true, force: true });
  }

  process.stdout.write("integration production runtime bundle smoke: ok\n");
}

run().catch((error) => {
  process.stderr.write(
    `integration production runtime bundle smoke: failed (${String(error?.publicCode || error?.code || error?.name || "ERROR")})\n`
  );
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exitCode = 1;
});
