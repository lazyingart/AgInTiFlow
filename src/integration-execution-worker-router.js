import { types as utilTypes } from "node:util";

import {
  assertExecutionWorkerClient,
  createSystemdBoundExecutionWorkerClient,
} from "./execution-worker-client.js";
import { loadIntegrationExecutionWorkerBindingConfig } from "./integration-execution-worker-binding-config.js";
import {
  IntegrationWorkerDirectoryError,
  assertIntegrationWorkerDirectory,
  createWorkerAdmission,
} from "./integration-worker-directory.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_EXECUTION_WORKER_ROUTER_SCHEMA_VERSION =
  "aginti-integration-execution-worker-router-v1";
export const INTEGRATION_EXECUTION_WORKER_BINDING_AUTHORITY_SCHEMA_VERSION =
  "aginti-integration-execution-worker-binding-authority-v1";
export const INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS = 60_000;
export const INTEGRATION_EXECUTION_WORKER_LEASE_HEARTBEAT_MS = 20_000;
export const INTEGRATION_EXECUTION_WORKER_LEASE_RELEASE_DRAIN_MS = 2_000;

const ROUTER_BRAND = new WeakSet();
const BINDING_AUTHORITY_BRAND = new WeakSet();
const DIGEST = /^[a-f0-9]{64}$/u;
const BINDING_ID = /^binding_[A-Za-z0-9_-]{16,96}$/u;

export class IntegrationExecutionWorkerRouterError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationExecutionWorkerRouterError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationExecutionWorkerRouterError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, requiredKeys, label) {
  if (!isPlainObject(value)) fail("EXECUTION_ROUTER_INVALID", `${label} must be a plain data object.`, { status: 400 });
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("EXECUTION_ROUTER_INVALID", `${label} contains an unsupported field.`, { status: 400 });
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("EXECUTION_ROUTER_INVALID", `${label}.${key} is required.`, { status: 400 });
    }
  }
  return value;
}

function ownerDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("EXECUTION_ROUTER_INVALID", "execution route ownerDigest is invalid.", { status: 400 });
  }
  return value;
}

function leaseHeartbeatMs(value) {
  const heartbeatMs = value ?? INTEGRATION_EXECUTION_WORKER_LEASE_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 25 || heartbeatMs > INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS / 2) {
    fail("EXECUTION_ROUTER_INVALID", "execution route lease heartbeat interval is invalid.", { status: 400 });
  }
  return heartbeatMs;
}

function leaseReleaseDrainMs(value) {
  const drainMs = value ?? INTEGRATION_EXECUTION_WORKER_LEASE_RELEASE_DRAIN_MS;
  if (!Number.isSafeInteger(drainMs) || drainMs < 25 || drainMs > 30_000) {
    fail("EXECUTION_ROUTER_INVALID", "execution route lease release drain interval is invalid.", { status: 400 });
  }
  return drainMs;
}

function bindingId(value) {
  if (typeof value !== "string" || !BINDING_ID.test(value)) {
    fail("EXECUTION_BINDING_INVALID", "execution worker binding ID is invalid.");
  }
  return value;
}

function translateDirectoryError(error) {
  if (!(error instanceof IntegrationWorkerDirectoryError)) return error;
  return new IntegrationExecutionWorkerRouterError(
    error.code,
    "execution worker directory operation failed.",
    { status: error.status, cause: error }
  );
}

function assertBindingAuthority(value) {
  if (!value || !BINDING_AUTHORITY_BRAND.has(value)) {
    throw new TypeError("execution worker binding authority is not AgInTi-owned");
  }
  return value;
}

function createLeaseHeartbeat(directory, lease, owner, { heartbeatMs, signal }) {
  const controller = new AbortController();
  let timer = null;
  let renewal = null;
  let stopped = false;
  let failed = false;
  let failureError = null;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});

  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason || new Error("execution route was cancelled"));
  };
  const failRenewal = (error) => {
    if (stopped || failed) return;
    failed = true;
    const translated = translateDirectoryError(error);
    failureError = translated;
    if (!controller.signal.aborted) controller.abort(translated);
    rejectFailure(translated);
  };
  const schedule = () => {
    if (stopped || failed || controller.signal.aborted) return;
    timer = setTimeout(runRenewal, heartbeatMs);
    timer.unref?.();
  };
  const runRenewal = () => {
    timer = null;
    if (stopped || failed || controller.signal.aborted) return;
    renewal = directory.renewLease(lease.leaseId, owner, {
      ttlMs: INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS,
    }).then(
      () => {
        renewal = null;
        schedule();
      },
      (error) => {
        renewal = null;
        failRenewal(error);
      }
    );
    renewal.catch(() => {});
  };

  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  schedule();

  return Object.freeze({
    signal: controller.signal,
    failure,
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener?.("abort", abortFromCaller);
      if (renewal) await renewal.catch(() => {});
    },
    failed() {
      return failureError !== null;
    },
  });
}

async function waitForOperationDrain(operationPromise, drainMs) {
  if (!operationPromise) return true;
  let timer = null;
  try {
    return await Promise.race([
      operationPromise.then(
        () => true,
        () => true
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createTestOnlyExecutionWorkerBindingAuthority(entriesValue) {
  if (!Array.isArray(entriesValue) || entriesValue.length < 1 || entriesValue.length > 16) {
    throw new TypeError("test binding entries must be a bounded array");
  }
  const clients = new Map();
  for (const entryValue of entriesValue) {
    const entry = exactObject(entryValue, ["bindingId", "client"], ["bindingId", "client"], "test binding entry");
    const id = bindingId(entry.bindingId);
    if (clients.has(id)) throw new TypeError("test binding entries contain a duplicate binding ID");
    clients.set(id, assertExecutionWorkerClient(entry.client));
  }
  const bindingIds = Object.freeze([...clients.keys()].sort());
  const proofUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_AUTHORITY_SCHEMA_VERSION,
    owner: "aginti",
    authority: "test-only",
    systemOwnedBindings: true,
    callerSelectableBinding: false,
    callerSelectableEndpoint: false,
    callerSelectableCredential: false,
    bindingSetDigest: contractDigest(bindingIds),
  });
  const authority = Object.freeze({
    attestation: Object.freeze({ ...proofUnsigned, digest: contractDigest(proofUnsigned) }),
    async open(route) {
      const id = bindingId(route?.bindingId);
      const client = clients.get(id);
      if (!client) fail("EXECUTION_BINDING_UNAVAILABLE", "execution worker binding is unavailable.");
      return client;
    },
    close() {
      for (const client of new Set(clients.values())) client.close();
    },
  });
  BINDING_AUTHORITY_BRAND.add(authority);
  return authority;
}

export async function createSystemdExecutionWorkerBindingAuthority(...args) {
  if (args.length !== 0) {
    fail("EXECUTION_BINDING_CONFIG_SOURCE_FORBIDDEN", "production binding authority accepts no overrides.");
  }
  const config = await loadIntegrationExecutionWorkerBindingConfig();
  const bindings = new Map(config.bindings.map((binding) => [binding.bindingId, binding]));
  const clients = new Map();
  const proofUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_BINDING_AUTHORITY_SCHEMA_VERSION,
    owner: "aginti",
    authority: "systemd-loadcredential-manifest",
    systemOwnedBindings: true,
    callerSelectableBinding: false,
    callerSelectableEndpoint: false,
    callerSelectableCredential: false,
    bindingConfigDigest: config.digest,
    bindingSetDigest: contractDigest([...bindings.keys()].sort()),
  });
  async function open(route) {
    const id = bindingId(route?.bindingId);
    const binding = bindings.get(id);
    if (!binding) fail("EXECUTION_BINDING_UNAVAILABLE", "execution worker binding is unavailable.");
    let client = clients.get(id);
    if (!client) {
      client = assertExecutionWorkerClient(await createSystemdBoundExecutionWorkerClient(binding), {
        requireSystemdCredential: true,
      });
      clients.set(id, client);
    }
    return client;
  }
  const authority = Object.freeze({
    attestation: Object.freeze({ ...proofUnsigned, digest: contractDigest(proofUnsigned) }),
    open,
    async probe(candidate) {
      if (!candidate?.roles || contractDigest(candidate.roles) !== contractDigest(["execution"])) {
        fail("EXECUTION_BINDING_INVALID", "execution binding probe requires the exact execution role.");
      }
      const binding = bindings.get(bindingId(candidate.bindingId));
      if (!binding) fail("EXECUTION_BINDING_UNAVAILABLE", "execution worker binding is unavailable.");
      const client = await open({ bindingId: binding.bindingId });
      const capabilities = await client.capabilities();
      const observedAt = new Date();
      return createWorkerAdmission(candidate, {
        transport: binding.transport,
        releaseId: `${capabilities.implementation}-${capabilities.implementationVersion}`,
        releaseDigest: contractDigest({
          workerId: capabilities.workerId,
          implementation: capabilities.implementation,
          implementationVersion: capabilities.implementationVersion,
          runtimeBundleRootDigest: capabilities.runtime.runtimeBundleRootDigest,
        }),
        capabilitiesDigest: capabilities.capabilityDigest,
        canaryDigest: capabilities.healthDigest,
        protocols: ["aginti-execution-worker-api-v1", capabilities.coordinatorProtocol.schemaVersion],
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.valueOf() + 5 * 60_000).toISOString(),
      });
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  });
  BINDING_AUTHORITY_BRAND.add(authority);
  return authority;
}

export function createIntegrationExecutionWorkerRouter(optionsValue) {
  const options = exactObject(
    optionsValue,
    ["directory", "bindingAuthority", "leaseHeartbeatMs", "leaseReleaseDrainMs"],
    ["directory", "bindingAuthority"],
    "execution worker router options"
  );
  const directory = assertIntegrationWorkerDirectory(options.directory);
  const bindingAuthority = assertBindingAuthority(options.bindingAuthority);
  const heartbeatMs = leaseHeartbeatMs(options.leaseHeartbeatMs);
  const releaseDrainMs = leaseReleaseDrainMs(options.leaseReleaseDrainMs);
  const proofUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_ROUTER_SCHEMA_VERSION,
    owner: "aginti",
    authority: "aginti",
    role: "execution",
    leaseTtlMs: INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS,
    leaseHeartbeatMs: heartbeatMs,
    leaseReleaseDrainMs: releaseDrainMs,
    directoryAttestationDigest: directory.attestation.stateRootDigest,
    bindingAuthorityAttestationDigest: bindingAuthority.attestation.digest,
    credentialSource: bindingAuthority.attestation.authority,
    leasePinsWorkerForEntireOperation: true,
    leaseHeartbeatExtendsActiveOperation: true,
    leaseHeartbeatRenewsAdmission: true,
    leaseReleaseWaitsForCancellationDrain: true,
    assignmentSwitchAffectsNewLeasesOnly: true,
    capabilityDigestRevalidated: true,
    callerSelectableBinding: false,
    callerSelectableEndpoint: false,
    callerSelectableCredential: false,
  });
  const attestation = Object.freeze({ ...proofUnsigned, digest: contractDigest(proofUnsigned) });

  const router = Object.freeze({
    attestation,

    async withClient(ownerDigestValue, operation, optionsValue = {}) {
      const owner = ownerDigest(ownerDigestValue);
      if (typeof operation !== "function") throw new TypeError("execution worker route operation must be a function");
      const options = exactObject(optionsValue, ["signal"], [], "execution worker route options");
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
        throw new TypeError("execution worker route signal must be an AbortSignal");
      }
      if (options.signal?.aborted) {
        fail("EXECUTION_CANCELLED", "execution worker route was cancelled.", { status: 499 });
      }
      let lease = null;
      let operationError = null;
      let heartbeat = null;
      let operationPromise = null;
      let releaseLease = true;
      const withHeartbeat = (promise) => heartbeat
        ? Promise.race([promise, heartbeat.failure])
        : promise;
      try {
        lease = await directory.acquire("execution", owner, {
          ttlMs: INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS,
        });
        heartbeat = createLeaseHeartbeat(directory, lease, owner, {
          heartbeatMs,
          signal: options.signal,
        });
        const route = await withHeartbeat(directory.resolveLease(lease.leaseId, owner));
        const client = assertExecutionWorkerClient(await withHeartbeat(bindingAuthority.open(route)));
        const capabilities = await withHeartbeat(client.capabilities({ signal: heartbeat.signal }));
        if (capabilities.capabilityDigest !== route.capabilitiesDigest) {
          fail(
            "EXECUTION_BINDING_DIVERGED",
            "execution worker capabilities diverged from admitted binding evidence."
          );
        }
        operationPromise = Promise.resolve().then(() => operation(
          client,
          Object.freeze({ ...route }),
          capabilities,
          Object.freeze({ signal: heartbeat.signal })
        ));
        operationPromise.catch(() => {});
        return await withHeartbeat(operationPromise);
      } catch (error) {
        operationError = translateDirectoryError(error);
        throw operationError;
      } finally {
        if (heartbeat) await heartbeat.stop();
        if (heartbeat?.failed() && operationPromise) {
          releaseLease = await waitForOperationDrain(operationPromise, releaseDrainMs);
        }
        if (lease) {
          if (releaseLease) {
            try {
              await directory.releaseLease(lease.leaseId, owner);
            } catch (releaseError) {
              if (!operationError) {
                fail("EXECUTION_LEASE_RELEASE_FAILED", "execution worker lease could not be released.", {
                  cause: releaseError,
                });
              }
            }
          }
        }
      }
    },

    close() {
      bindingAuthority.close();
    },
  });
  ROUTER_BRAND.add(router);
  return router;
}

export function assertIntegrationExecutionWorkerRouter(value) {
  if (!value || !ROUTER_BRAND.has(value)) {
    throw new TypeError("execution worker router is not AgInTi-owned");
  }
  return value;
}
