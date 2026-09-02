import { types as utilTypes } from "node:util";

import { assertExecutionWorkerClient } from "./execution-worker-client.js";
import {
  IntegrationWorkerDirectoryError,
  assertIntegrationWorkerDirectory,
} from "./integration-worker-directory.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_EXECUTION_WORKER_ROUTER_SCHEMA_VERSION =
  "aginti-integration-execution-worker-router-v1";
export const INTEGRATION_EXECUTION_WORKER_BINDING_AUTHORITY_SCHEMA_VERSION =
  "aginti-integration-execution-worker-binding-authority-v1";
export const INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS = 60_000;

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

export function createIntegrationExecutionWorkerRouter(optionsValue) {
  const options = exactObject(
    optionsValue,
    ["directory", "bindingAuthority"],
    ["directory", "bindingAuthority"],
    "execution worker router options"
  );
  const directory = assertIntegrationWorkerDirectory(options.directory);
  const bindingAuthority = assertBindingAuthority(options.bindingAuthority);
  const proofUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_EXECUTION_WORKER_ROUTER_SCHEMA_VERSION,
    owner: "aginti",
    authority: "aginti",
    role: "execution",
    leaseTtlMs: INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS,
    directoryAttestationDigest: directory.attestation.stateRootDigest,
    bindingAuthorityAttestationDigest: bindingAuthority.attestation.digest,
    leasePinsWorkerForEntireOperation: true,
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
      try {
        lease = await directory.acquire("execution", owner, {
          ttlMs: INTEGRATION_EXECUTION_WORKER_LEASE_TTL_MS,
        });
        const route = await directory.resolveLease(lease.leaseId, owner);
        const client = assertExecutionWorkerClient(await bindingAuthority.open(route));
        const capabilities = await client.capabilities({ signal: options.signal });
        if (capabilities.capabilityDigest !== route.capabilitiesDigest) {
          fail(
            "EXECUTION_BINDING_DIVERGED",
            "execution worker capabilities diverged from admitted binding evidence."
          );
        }
        return await operation(client, Object.freeze({ ...route }), capabilities);
      } catch (error) {
        operationError = translateDirectoryError(error);
        throw operationError;
      } finally {
        if (lease) {
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
