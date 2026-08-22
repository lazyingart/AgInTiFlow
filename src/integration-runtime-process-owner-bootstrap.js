import { types as utilTypes } from "node:util";
import { authorityFail, currentProcessOwner } from "./integration-durable-common.js";
import { contractDigest } from "./integration-policy.js";

export const INTEGRATION_RUNTIME_PROCESS_OWNER_BOOTSTRAP_VERSION =
  "aginti-integration-runtime-process-owner-bootstrap-v1";

const BOOTSTRAP_KEYS = Object.freeze([
  "schemaVersion", "processOwner", "ownerDigest", "digest",
]);
const bootstrapBrand = new WeakMap();

function unavailable(message) {
  authorityFail("AGENT_UNAVAILABLE", message);
}

function exactFrozenData(value, keys, label) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) ||
    !Object.isFrozen(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) unavailable(`${label} is invalid.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) unavailable(`${label} contains unsupported fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.writable || descriptor.configurable
    ) unavailable(`${label}.${key} is invalid.`);
  }
  return value;
}

export async function createIntegrationRuntimeProcessOwnerBootstrap() {
  const processOwner = await currentProcessOwner();
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_RUNTIME_PROCESS_OWNER_BOOTSTRAP_VERSION,
    processOwner,
    ownerDigest: contractDigest(processOwner),
  });
  const bootstrap = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  bootstrapBrand.set(bootstrap, processOwner);
  return bootstrap;
}

export function assertIntegrationRuntimeProcessOwnerBootstrap(value) {
  exactFrozenData(value, BOOTSTRAP_KEYS, "integration runtime process-owner bootstrap capability");
  const processOwner = bootstrapBrand.get(value);
  if (!processOwner || value.processOwner !== processOwner) {
    unavailable("Integration runtime process-owner bootstrap lexical brand is invalid.");
  }
  const unsigned = Object.freeze({
    schemaVersion: value.schemaVersion,
    processOwner,
    ownerDigest: value.ownerDigest,
  });
  if (
    value.schemaVersion !== INTEGRATION_RUNTIME_PROCESS_OWNER_BOOTSTRAP_VERSION ||
    value.ownerDigest !== contractDigest(processOwner) ||
    value.digest !== contractDigest(unsigned)
  ) unavailable("Integration runtime process-owner bootstrap capability is corrupt.");
  return value;
}
