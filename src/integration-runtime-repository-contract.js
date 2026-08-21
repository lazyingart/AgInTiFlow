import { types as utilTypes } from "node:util";
import { authorityFail } from "./integration-authority-error.js";
import { contractDigest } from "./integration-policy.js";
import { validateNativeRuntimeRootsAttestation } from "./integration-native-runtime-roots.js";

const ArrayIsArray = Array.isArray;
const AsyncFunctionPrototype = Object.getPrototypeOf(async function () {});
const FunctionPrototype = Function.prototype;
const FunctionPrototypeBind = FunctionPrototype.bind;
const FunctionPrototypeCall = FunctionPrototype.call;
const NativePromise = Promise;
const ObjectAssign = Object.assign;
const ObjectCreate = Object.create;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIsFrozen = Object.isFrozen;
const ObjectPrototype = Object.prototype;
const ObjectPrototypeHasOwn = ObjectPrototype.hasOwnProperty;
const PromisePrototype = NativePromise.prototype;
const PromisePrototypeThen = PromisePrototype.then;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpPrototypeTest = RegExp.prototype.test;
const SymbolSpecies = Symbol.species;

const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;

export const INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION =
  "aginti-integration-thread-session-repository-v5";
export const INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY =
  "integrationRuntimeRepositoryAttestation";

export const INTEGRATION_RUNTIME_REPOSITORY_METHODS = ObjectFreeze([
  "listIntegrationThreads",
  "createIntegrationThread",
  "getIntegrationThread",
  "updateIntegrationThread",
  "deleteIntegrationThread",
  "getActiveIntegrationRunForThread",
  "createIntegrationRun",
  "markIntegrationRunDispatching",
  "authorizeIntegrationRunNativeStart",
  "abortIntegrationRunBeforeLaunch",
  "getIntegrationRun",
  "markIntegrationRunCancelling",
  "finishIntegrationRunWithOutbox",
  "getIntegrationCompletionOutboxBundle",
  "reconcileIntegrationDispatches",
  "listPendingIntegrationOutboxEvents",
  "markIntegrationOutboxDelivered",
  "listIntegrationArtifacts",
  "getIntegrationArtifact",
  "stageIntegrationArtifactOutbox",
  "publishIntegrationArtifactOutbox",
]);

export const INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS = ObjectFreeze([
  "schemaVersion",
  "owner",
  "authority",
  "descriptorBound",
  "nativeSessionMapping",
  "onePublicThreadToOneNativeSession",
  "principalBound",
  "browserSessionBound",
  "optimisticRevisions",
  "casRevisions",
  "immutableNativeSessionId",
  "durableThreadSessionMapping",
  "dispatchLeases",
  "dispatchOutbox",
  "nativeStartAuthorization",
  "receiptRecoveryHold",
  "exactReconciliationResults",
  "preLaunchAbort",
  "terminalOutbox",
  "completionOutboxBundles",
  "outboxDelivery",
  "startupReconciliation",
  "processIdentity",
  "artifactTransactionalOutbox",
  "publishedArtifactsOnly",
  "exactOwnership",
  "noPathThreadMapStore",
  "durable",
  "retainedDescriptorStorageAuthority",
  "runtimeRoots",
  "digest",
]);

const repositorySurfaceKeys = [INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY];
for (let index = 0; index < INTEGRATION_RUNTIME_REPOSITORY_METHODS.length; index += 1) {
  repositorySurfaceKeys[index + 1] = INTEGRATION_RUNTIME_REPOSITORY_METHODS[index];
}
export const INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS = ObjectFreeze(repositorySurfaceKeys);

export const INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS = ObjectFreeze(ObjectAssign(ObjectCreate(null), {
  preEnableContractOnly: true,
  methodInventoryIncluded: true,
  repositorySurfaceValidationIncluded: true,
  repositoryAttestationValidationIncluded: true,
  runtimeCapabilityEnabled: false,
  runtimeWiringIncluded: false,
  runtimeRepositoryImplementationIncluded: false,
  runtimeRepositorySurfaceProvided: false,
  retainedPersistenceIncluded: false,
  repositoryDomainStateSchemaIncluded: false,
  repositoryRecordSchemasIncluded: false,
  repositoryMethodPayloadSchemasIncluded: false,
  repositoryMethodResultSchemasIncluded: false,
  repositoryTransitionsIncluded: false,
  artifactSemanticsIncluded: false,
  recoverySemanticsIncluded: false,
  idempotencySemanticsIncluded: false,
  ambiguityReconciliationIncluded: false,
  exactThreadRecordSchema: false,
  exactRunRecordSchema: false,
  listPagination: false,
  deleteRetentionCascade: false,
  longLivedMutationReplay: false,
  pendingOutboxQuery: false,
  exactDeliveryReceipt: false,
  artifactStagePublish: false,
  runtimeRepositoryReady: false,
}));

const FORBIDDEN_ADAPTER_METHODS = ObjectFreeze([
  "plan",
  "createPlan",
  "summarize",
  "compactContext",
  "callModel",
  "completeWithModel",
  "runTool",
  "executeTool",
  "executeDocker",
]);
const FUNCTION_METADATA_KEYS = ObjectFreeze(["length", "name"]);

function lookupFor(keys) {
  const lookup = ObjectCreate(null);
  for (let index = 0; index < keys.length; index += 1) lookup[keys[index]] = true;
  return ObjectFreeze(lookup);
}

const ATTESTATION_KEY_LOOKUP = lookupFor(INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS);
const SURFACE_KEY_LOOKUP = lookupFor(INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS);

function failUnavailable(message) {
  authorityFail("AGENT_UNAVAILABLE", message);
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [value, key]);
}

function isPromiseValue(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !utilTypes.isProxy(value) &&
    utilTypes.isPromise(value)
  );
}

function promiseCanBeSafelyObserved(value) {
  const ownConstructor = ObjectGetOwnPropertyDescriptor(value, "constructor");
  let constructorDescriptor = ownConstructor;
  if (!constructorDescriptor) {
    const prototype = ObjectGetPrototypeOf(value);
    if (!prototype || utilTypes.isProxy(prototype)) return false;
    constructorDescriptor = ObjectGetOwnPropertyDescriptor(prototype, "constructor");
  }
  if (!constructorDescriptor || !hasOwn(constructorDescriptor, "value")) return false;
  const constructor = constructorDescriptor.value;
  if (constructor === undefined) return true;
  if (constructor !== NativePromise) return false;
  const speciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
  if (!speciesDescriptor) return false;
  if (hasOwn(speciesDescriptor, "value")) {
    return (
      speciesDescriptor.value === undefined ||
      speciesDescriptor.value === null ||
      speciesDescriptor.value === NativePromise
    );
  }
  return (
    NativePromiseSpeciesGetter !== undefined &&
    speciesDescriptor.get === NativePromiseSpeciesGetter &&
    speciesDescriptor.set === NativePromiseSpeciesSetter
  );
}

function observePromiseRejectionIfSafe(value) {
  if (!isPromiseValue(value)) return false;
  if (promiseCanBeSafelyObserved(value)) {
    ReflectApply(PromisePrototypeThen, value, [undefined, () => undefined]);
  }
  return true;
}

function rejectInvalidObject(value, label, { requireFrozen = true } = {}) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    failUnavailable(`${label} must not be a Proxy.`);
  }
  if (observePromiseRejectionIfSafe(value)) {
    failUnavailable(`${label} must not be a thenable.`);
  }
  if (!value || typeof value !== "object" || ArrayIsArray(value)) {
    failUnavailable(`${label} must be a frozen object.`);
  }
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) failUnavailable(`${label} prototype is invalid.`);
  if (requireFrozen && !ObjectIsFrozen(value)) failUnavailable(`${label} must be a frozen object.`);
}

function exactDataDescriptors(value, keys, lookup, label, { requireFrozen = true } = {}) {
  rejectInvalidObject(value, label, { requireFrozen });
  const ownKeys = ReflectOwnKeys(value);
  if (ownKeys.length !== keys.length) failUnavailable(`${label} contains unsupported or unavailable fields.`);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string" || !hasOwn(lookup, key)) {
      failUnavailable(`${label} contains unsupported or unavailable fields.`);
    }
  }
  const descriptors = ObjectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !hasOwn(descriptor, "value") ||
      (requireFrozen && (descriptor.writable !== false || descriptor.configurable !== false))
    ) {
      failUnavailable(`${label}.${key} must be an enumerable immutable data field.`);
    }
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function retainedRequirement(options) {
  if (options === undefined) return false;
  if (options && (typeof options === "object" || typeof options === "function") && utilTypes.isProxy(options)) {
    failUnavailable("repository attestation options must not be a Proxy.");
  }
  if (observePromiseRejectionIfSafe(options)) {
    failUnavailable("repository attestation options must not be a thenable.");
  }
  if (!options || typeof options !== "object" || ArrayIsArray(options)) {
    failUnavailable("repository attestation options are invalid.");
  }
  const prototype = ObjectGetPrototypeOf(options);
  if (prototype !== ObjectPrototype && prototype !== null) {
    failUnavailable("repository attestation options prototype is invalid.");
  }
  const keys = ReflectOwnKeys(options);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== "requireRetainedDescriptorStorage") {
    failUnavailable("repository attestation options contain unsupported fields.");
  }
  const descriptor = ObjectGetOwnPropertyDescriptor(options, "requireRetainedDescriptorStorage");
  if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value") || typeof descriptor.value !== "boolean") {
    failUnavailable("repository attestation retained-descriptor option is invalid.");
  }
  return descriptor.value;
}

function proofValues(descriptors) {
  const values = ObjectCreate(null);
  for (let index = 0; index < INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS.length; index += 1) {
    const key = INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS[index];
    values[key] = descriptors[key].value;
  }
  return values;
}

export function assertIntegrationRuntimeRepositoryAttestation(value, options) {
  const requireRetainedDescriptorStorage = retainedRequirement(options);
  const descriptors = exactDataDescriptors(
    value,
    INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS,
    ATTESTATION_KEY_LOOKUP,
    "repository attestation"
  );
  const proof = proofValues(descriptors);
  validateNativeRuntimeRootsAttestation(proof.runtimeRoots);
  if (
    proof.schemaVersion !== INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.descriptorBound !== true ||
    proof.nativeSessionMapping !== "repository" ||
    proof.onePublicThreadToOneNativeSession !== true ||
    proof.principalBound !== true ||
    proof.browserSessionBound !== true ||
    proof.optimisticRevisions !== true ||
    proof.casRevisions !== true ||
    proof.immutableNativeSessionId !== true ||
    proof.durableThreadSessionMapping !== true ||
    proof.dispatchLeases !== true ||
    proof.dispatchOutbox !== true ||
    proof.nativeStartAuthorization !== true ||
    proof.receiptRecoveryHold !== true ||
    proof.exactReconciliationResults !== true ||
    proof.preLaunchAbort !== true ||
    proof.terminalOutbox !== true ||
    proof.completionOutboxBundles !== true ||
    proof.outboxDelivery !== true ||
    proof.startupReconciliation !== true ||
    proof.processIdentity !== true ||
    proof.artifactTransactionalOutbox !== true ||
    proof.publishedArtifactsOnly !== true ||
    proof.exactOwnership !== true ||
    proof.noPathThreadMapStore !== true ||
    proof.durable !== true ||
    typeof proof.retainedDescriptorStorageAuthority !== "boolean" ||
    typeof proof.digest !== "string" ||
    !ReflectApply(RegExpPrototypeTest, /^[a-f0-9]{64}$/u, [proof.digest])
  ) {
    failUnavailable("Integration repository attestation is unavailable.");
  }
  const unsigned = ObjectCreate(null);
  for (let index = 0; index < INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS.length; index += 1) {
    const key = INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS[index];
    if (key !== "digest") unsigned[key] = proof[key];
  }
  if (proof.digest !== contractDigest(unsigned)) {
    failUnavailable("repository attestation digest is invalid.");
  }
  if (requireRetainedDescriptorStorage && proof.retainedDescriptorStorageAuthority !== true) {
    failUnavailable("Retained-descriptor storage authority is not proven.");
  }
  return value;
}

function assertNoSemanticMethods(surface) {
  for (let index = 0; index < FORBIDDEN_ADAPTER_METHODS.length; index += 1) {
    const method = FORBIDDEN_ADAPTER_METHODS[index];
    if (hasOwn(surface, method) || hasOwn(ObjectPrototype, method)) {
      failUnavailable(`thread/session repository exposes semantic agent method ${method}.`);
    }
  }
}

function bindRepositoryMethod(method, repository, label) {
  if (utilTypes.isProxy(method)) failUnavailable(`${label} must not be a Proxy.`);
  const prototype = ObjectGetPrototypeOf(method);
  if (prototype !== FunctionPrototype && prototype !== AsyncFunctionPrototype) {
    failUnavailable(`${label} prototype is invalid.`);
  }
  for (let index = 0; index < FUNCTION_METADATA_KEYS.length; index += 1) {
    const key = FUNCTION_METADATA_KEYS[index];
    const descriptor = ObjectGetOwnPropertyDescriptor(method, key);
    if (!descriptor || !hasOwn(descriptor, "value")) failUnavailable(`${label}.${key} must be a data property.`);
  }
  return ReflectApply(FunctionPrototypeBind, method, [repository]);
}

export function assertIntegrationRuntimeRepositorySurface(value, options) {
  const requireRetainedDescriptorStorage = retainedRequirement(options);
  const descriptors = exactDataDescriptors(
    value,
    INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS,
    SURFACE_KEY_LOOKUP,
    "thread/session repository"
  );
  assertNoSemanticMethods(value);
  const attestation = assertIntegrationRuntimeRepositoryAttestation(
    descriptors[INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY].value,
    { requireRetainedDescriptorStorage }
  );
  const methods = ObjectCreate(null);
  for (let index = 0; index < INTEGRATION_RUNTIME_REPOSITORY_METHODS.length; index += 1) {
    const methodName = INTEGRATION_RUNTIME_REPOSITORY_METHODS[index];
    const method = descriptors[methodName].value;
    if (typeof method !== "function") {
      failUnavailable(`thread/session repository.${methodName} is unavailable.`);
    }
    methods[methodName] = bindRepositoryMethod(
      method,
      value,
      `thread/session repository.${methodName}`
    );
  }
  return ObjectFreeze(ObjectAssign(ObjectCreate(null), {
    attestation,
    methods: ObjectFreeze(methods),
  }));
}
