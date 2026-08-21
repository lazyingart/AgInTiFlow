#!/usr/bin/env node
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,
  INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS,
  INTEGRATION_RUNTIME_REPOSITORY_METHODS,
  INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS,
  assertIntegrationRuntimeRepositoryAttestation,
  assertIntegrationRuntimeRepositorySurface,
} from "../src/integration-runtime-repository-contract.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
  validateNativeRuntimeRootsAttestation,
} from "../src/integration-native-runtime-roots.js";
import { contractDigest } from "../src/integration-policy.js";

const FALSE_LIMITATIONS = Object.freeze([
  "runtimeCapabilityEnabled",
  "runtimeWiringIncluded",
  "runtimeRepositoryImplementationIncluded",
  "runtimeRepositorySurfaceProvided",
  "retainedPersistenceIncluded",
  "repositoryDomainStateSchemaIncluded",
  "repositoryRecordSchemasIncluded",
  "repositoryMethodPayloadSchemasIncluded",
  "repositoryMethodResultSchemasIncluded",
  "repositoryTransitionsIncluded",
  "artifactSemanticsIncluded",
  "recoverySemanticsIncluded",
  "idempotencySemanticsIncluded",
  "ambiguityReconciliationIncluded",
  "exactThreadRecordSchema",
  "exactRunRecordSchema",
  "listPagination",
  "deleteRetentionCascade",
  "longLivedMutationReplay",
  "pendingOutboxQuery",
  "exactDeliveryReceipt",
  "artifactStagePublish",
  "runtimeRepositoryReady",
]);

function expectUnavailable(operation, pattern = /repository|attestation|surface|prototype|field|method/iu) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code || error?.publicCode, "AGENT_UNAVAILABLE");
    assert.match(String(error?.message || ""), pattern);
    return true;
  });
}

function rootsAttestation(overrides = {}) {
  const unsigned = {
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: "/home/lachlan/ProjectsLFS/Agent/.integration-contract-smoke/sessions",
    baseDir: "/home/lachlan/ProjectsLFS/Agent/.integration-contract-smoke/workspace",
    commandCwd: "/home/lachlan/ProjectsLFS/Agent/.integration-contract-smoke/workspace",
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
    ...overrides,
  };
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function repositoryAttestation({ retained = false, roots = rootsAttestation(), overrides = {} } = {}) {
  const unsigned = {
    schemaVersion: INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    descriptorBound: true,
    nativeSessionMapping: "repository",
    onePublicThreadToOneNativeSession: true,
    principalBound: true,
    browserSessionBound: true,
    optimisticRevisions: true,
    casRevisions: true,
    immutableNativeSessionId: true,
    durableThreadSessionMapping: true,
    dispatchLeases: true,
    dispatchOutbox: true,
    nativeStartAuthorization: true,
    receiptRecoveryHold: true,
    exactReconciliationResults: true,
    preLaunchAbort: true,
    terminalOutbox: true,
    completionOutboxBundles: true,
    outboxDelivery: true,
    startupReconciliation: true,
    processIdentity: true,
    artifactTransactionalOutbox: true,
    publishedArtifactsOnly: true,
    exactOwnership: true,
    noPathThreadMapStore: true,
    durable: true,
    retainedDescriptorStorageAuthority: retained,
    runtimeRoots: roots,
    ...overrides,
  };
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function ordinaryRepositoryMethod() {
  return this;
}

const arrowRepositoryMethod = () => "arrow";
async function asyncRepositoryMethod() {
  return "async";
}
const boundRepositoryMethod = ordinaryRepositoryMethod.bind(Object.freeze({ kind: "pre-bound" }));

function mutableRepository(attestation = repositoryAttestation()) {
  const repository = {
    [INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY]: attestation,
  };
  for (let index = 0; index < INTEGRATION_RUNTIME_REPOSITORY_METHODS.length; index += 1) {
    const method = INTEGRATION_RUNTIME_REPOSITORY_METHODS[index];
    repository[method] =
      index === 0
        ? ordinaryRepositoryMethod
        : index === 1
          ? arrowRepositoryMethod
          : index === 2
            ? asyncRepositoryMethod
            : index === 3
              ? boundRepositoryMethod
              : ordinaryRepositoryMethod;
  }
  return repository;
}

function frozenRepository(attestation = repositoryAttestation()) {
  return Object.freeze(mutableRepository(attestation));
}

function cloneFrozen(value, changes = {}, prototype = Object.getPrototypeOf(value)) {
  const clone = Object.create(prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(changes)) descriptors[key] = descriptor;
  Object.defineProperties(clone, descriptors);
  return Object.freeze(clone);
}

async function assertRejectedPromisesAreSunk(proof) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const storage = new AsyncLocalStorage();
    let rejectedProofWithSymbol;
    let rejectedProofWithString;
    let rejectedOptionsWithSymbol;
    let rejectedOptionsWithString;
    let rejectedRootsWithSymbol;
    let rejectedRootsWithString;
    let rejectedRootFieldWithString;
    storage.run(Object.freeze({ scope: "repository-contract" }), () => {
      rejectedProofWithSymbol = Promise.reject(new Error("symbol proof rejection must be sunk"));
      Object.defineProperty(rejectedProofWithSymbol, Symbol("proof-metadata"), { value: true });
      rejectedProofWithString = Promise.reject(new Error("string proof rejection must be sunk"));
      Object.defineProperty(rejectedProofWithString, "metadata", { value: true });
      rejectedOptionsWithSymbol = Promise.reject(new Error("symbol options rejection must be sunk"));
      Object.defineProperty(rejectedOptionsWithSymbol, Symbol("options-metadata"), { value: true });
      rejectedOptionsWithString = Promise.reject(new Error("string options rejection must be sunk"));
      Object.defineProperty(rejectedOptionsWithString, "metadata", { value: true });
      rejectedRootsWithSymbol = Promise.reject(new Error("symbol roots rejection must be sunk"));
      Object.defineProperty(rejectedRootsWithSymbol, Symbol("roots-metadata"), { value: true });
      rejectedRootsWithString = Promise.reject(new Error("string roots rejection must be sunk"));
      Object.defineProperty(rejectedRootsWithString, "metadata", { value: true });
      rejectedRootFieldWithString = Promise.reject(new Error("root field rejection must be sunk"));
      Object.defineProperty(rejectedRootFieldWithString, "metadata", { value: true });
    });
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(rejectedProofWithSymbol),
      /thenable/iu
    );
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(rejectedProofWithString),
      /thenable/iu
    );
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(proof, rejectedOptionsWithSymbol),
      /thenable/iu
    );
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(proof, rejectedOptionsWithString),
      /thenable/iu
    );
    expectUnavailable(() => validateNativeRuntimeRootsAttestation(rejectedRootsWithSymbol), /synchronous plain data/iu);
    expectUnavailable(() => validateNativeRuntimeRootsAttestation(rejectedRootsWithString), /synchronous plain data/iu);
    expectUnavailable(
      () => validateNativeRuntimeRootsAttestation(Object.freeze({
        ...rootsAttestation(),
        sessionsDir: rejectedRootFieldWithString,
        digest: "0".repeat(64),
      })),
      /synchronous plain data/iu
    );

    const safeCrossRealmProof = runInNewContext("Promise.reject(new Error('safe cross-realm proof rejection'))");
    const safeCrossRealmRootField = runInNewContext("Promise.reject(new Error('safe cross-realm root rejection'))");
    Object.defineProperty(safeCrossRealmProof, "constructor", { value: undefined });
    Object.defineProperty(safeCrossRealmRootField, "constructor", { value: undefined });
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(safeCrossRealmProof),
      /thenable/iu
    );
    expectUnavailable(
      () => validateNativeRuntimeRootsAttestation(Object.freeze({
        ...rootsAttestation(),
        commandCwd: safeCrossRealmRootField,
        digest: "0".repeat(64),
      })),
      /synchronous plain data/iu
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function prehandledRejectedPromise(message) {
  const value = Promise.reject(new Error(message));
  const handled = Reflect.apply(Promise.prototype.then, value, [undefined, () => undefined]);
  return { value, handled };
}

async function assertUnsafePromiseMetadataIsNotObserved(proof) {
  let constructorGetterHits = 0;
  const unsafeRoots = prehandledRejectedPromise("unsafe roots constructor was pre-handled");
  const unsafeProof = prehandledRejectedPromise("unsafe proof constructor was pre-handled");
  const unsafeOptions = prehandledRejectedPromise("unsafe options constructor was pre-handled");
  await Promise.all([unsafeRoots.handled, unsafeProof.handled, unsafeOptions.handled]);
  for (const fixture of [unsafeRoots, unsafeProof, unsafeOptions]) {
    Object.defineProperty(fixture.value, "constructor", {
      configurable: false,
      get() {
        constructorGetterHits += 1;
        throw new Error("promise constructor getter must not run");
      },
    });
  }
  expectUnavailable(() => validateNativeRuntimeRootsAttestation(unsafeRoots.value), /synchronous plain data/iu);
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(unsafeProof.value), /thenable/iu);
  expectUnavailable(
    () => assertIntegrationRuntimeRepositoryAttestation(proof, unsafeOptions.value),
    /thenable/iu
  );
  assert.equal(constructorGetterHits, 0);

  let constructorProxyHits = 0;
  const unsafeDataConstructor = new Proxy(function UnsafePromiseConstructor() {}, {
    get() {
      constructorProxyHits += 1;
      throw new Error("custom promise constructor must not be observed");
    },
    getPrototypeOf() {
      constructorProxyHits += 1;
      throw new Error("custom promise constructor prototype must not be observed");
    },
  });
  const customConstructorPromise = prehandledRejectedPromise("custom constructor was pre-handled");
  await customConstructorPromise.handled;
  Object.defineProperty(customConstructorPromise.value, "constructor", {
    configurable: false,
    value: unsafeDataConstructor,
  });
  expectUnavailable(
    () => assertIntegrationRuntimeRepositoryAttestation(customConstructorPromise.value),
    /thenable/iu
  );
  assert.equal(constructorProxyHits, 0);

  class HostilePromiseSubclass extends Promise {}
  const subclassPromise = new HostilePromiseSubclass((_resolve, reject) => {
    reject(new Error("hostile subclass rejection was pre-handled"));
  });
  const subclassHandled = Reflect.apply(Promise.prototype.then, subclassPromise, [undefined, () => undefined]);
  await subclassHandled;
  let subclassSpeciesHits = 0;
  Object.defineProperty(HostilePromiseSubclass, Symbol.species, {
    configurable: false,
    get() {
      subclassSpeciesHits += 1;
      throw new Error("subclass species getter must not run");
    },
  });
  expectUnavailable(
    () => assertIntegrationRuntimeRepositoryAttestation(subclassPromise),
    /thenable/iu
  );
  assert.equal(subclassSpeciesHits, 0);

  const adjustedPrototypePromise = prehandledRejectedPromise("adjusted prototype rejection was pre-handled");
  await adjustedPrototypePromise.handled;
  let prototypeTrapHits = 0;
  const hostilePromisePrototype = new Proxy(Object.create(null), {
    getOwnPropertyDescriptor() {
      prototypeTrapHits += 1;
      throw new Error("promise prototype descriptor trap must not run");
    },
    getPrototypeOf() {
      prototypeTrapHits += 1;
      throw new Error("promise prototype trap must not run");
    },
  });
  Object.setPrototypeOf(adjustedPrototypePromise.value, hostilePromisePrototype);
  expectUnavailable(
    () => validateNativeRuntimeRootsAttestation(adjustedPrototypePromise.value),
    /synchronous plain data/iu
  );
  assert.equal(prototypeTrapHits, 0);

  const unsafeCrossRealm = runInNewContext(`(() => {
    const value = Promise.reject(new Error("unsafe cross-realm rejection was pre-handled"));
    return { value, handled: value.then(undefined, () => undefined) };
  })()`);
  await unsafeCrossRealm.handled;
  expectUnavailable(
    () => assertIntegrationRuntimeRepositoryAttestation(unsafeCrossRealm.value),
    /thenable/iu
  );

  const originalSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  const customSpeciesRoots = prehandledRejectedPromise("custom roots species was pre-handled");
  const customSpeciesOptions = prehandledRejectedPromise("custom options species was pre-handled");
  await Promise.all([customSpeciesRoots.handled, customSpeciesOptions.handled]);
  let speciesGetterHits = 0;
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() {
        speciesGetterHits += 1;
        throw new Error("custom Promise species getter must not run");
      },
    });
    expectUnavailable(
      () => validateNativeRuntimeRootsAttestation(customSpeciesRoots.value),
      /synchronous plain data/iu
    );
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(proof, customSpeciesOptions.value),
      /thenable/iu
    );
  } finally {
    Object.defineProperty(Promise, Symbol.species, originalSpecies);
  }
  assert.equal(speciesGetterHits, 0);

  const dataSpeciesRoots = prehandledRejectedPromise("data roots species was pre-handled");
  const dataSpeciesProof = prehandledRejectedPromise("data proof species was pre-handled");
  await Promise.all([dataSpeciesRoots.handled, dataSpeciesProof.handled]);
  let speciesProxyHits = 0;
  const unsafeDataSpecies = new Proxy(function UnsafePromiseSpecies() {}, {
    get() {
      speciesProxyHits += 1;
      throw new Error("custom Promise species must not be observed");
    },
    getPrototypeOf() {
      speciesProxyHits += 1;
      throw new Error("custom Promise species prototype must not be observed");
    },
  });
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      value: unsafeDataSpecies,
    });
    expectUnavailable(
      () => validateNativeRuntimeRootsAttestation(dataSpeciesRoots.value),
      /synchronous plain data/iu
    );
    expectUnavailable(
      () => assertIntegrationRuntimeRepositoryAttestation(dataSpeciesProof.value),
      /thenable/iu
    );
  } finally {
    Object.defineProperty(Promise, Symbol.species, originalSpecies);
  }
  assert.equal(speciesProxyHits, 0);
}

async function main() {
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION, "aginti-integration-thread-session-repository-v5");
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY, "integrationRuntimeRepositoryAttestation");
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_METHODS.length, 21);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS.length, 31);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS.length, 22);
  assert.equal(Object.isFrozen(INTEGRATION_RUNTIME_REPOSITORY_METHODS), true);
  assert.equal(Object.isFrozen(INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_KEYS), true);
  assert.equal(Object.isFrozen(INTEGRATION_RUNTIME_REPOSITORY_SURFACE_KEYS), true);
  assert.equal(Object.isFrozen(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS), true);
  assert.equal(Object.getPrototypeOf(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS), null);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS.preEnableContractOnly, true);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS.methodInventoryIncluded, true);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS.repositorySurfaceValidationIncluded, true);
  assert.equal(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS.repositoryAttestationValidationIncluded, true);
  for (const key of FALSE_LIMITATIONS) {
    assert.equal(INTEGRATION_RUNTIME_REPOSITORY_CONTRACT_LIMITATIONS[key], false, key);
  }

  const roots = rootsAttestation();
  assert.deepEqual(validateNativeRuntimeRootsAttestation(roots), {
    sessionsDir: roots.sessionsDir,
    baseDir: roots.baseDir,
    commandCwd: roots.commandCwd,
    digest: roots.digest,
  });
  const proof = repositoryAttestation({ roots });
  assert.equal(assertIntegrationRuntimeRepositoryAttestation(proof), proof);
  expectUnavailable(
    () => assertIntegrationRuntimeRepositoryAttestation(proof, { requireRetainedDescriptorStorage: true }),
    /Retained-descriptor/iu
  );
  const retainedProof = repositoryAttestation({ retained: true, roots });
  assert.equal(
    assertIntegrationRuntimeRepositoryAttestation(retainedProof, { requireRetainedDescriptorStorage: true }),
    retainedProof
  );

  const repository = frozenRepository(proof);
  const validated = assertIntegrationRuntimeRepositorySurface(repository);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.getPrototypeOf(validated), null);
  assert.equal(Object.isFrozen(validated.methods), true);
  assert.equal(Object.getPrototypeOf(validated.methods), null);
  assert.equal(validated.attestation, proof);
  assert.equal(validated.methods.listIntegrationThreads(), repository);
  assert.equal(validated.methods.createIntegrationThread(), "arrow");
  assert.equal(await validated.methods.getIntegrationThread(), "async");
  assert.equal(validated.methods.updateIntegrationThread().kind, "pre-bound");
  expectUnavailable(
    () => assertIntegrationRuntimeRepositorySurface(repository, { requireRetainedDescriptorStorage: true }),
    /Retained-descriptor/iu
  );
  assert.equal(
    assertIntegrationRuntimeRepositorySurface(frozenRepository(retainedProof), {
      requireRetainedDescriptorStorage: true,
    }).attestation,
    retainedProof
  );

  let methodBindTrapCount = 0;
  function ownBindGetterMethod() {
    return this;
  }
  Object.defineProperty(ownBindGetterMethod, "bind", {
    configurable: true,
    get() {
      methodBindTrapCount += 1;
      throw new Error("method.bind getter must not run");
    },
  });
  const ownBindRepository = mutableRepository(proof);
  ownBindRepository.listIntegrationThreads = ownBindGetterMethod;
  assert.equal(
    assertIntegrationRuntimeRepositorySurface(Object.freeze(ownBindRepository)).methods.listIntegrationThreads(),
    ownBindRepository
  );
  assert.equal(methodBindTrapCount, 0);

  const missingMethod = mutableRepository(proof);
  delete missingMethod.publishIntegrationArtifactOutbox;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(missingMethod)));
  const extraSurface = mutableRepository(proof);
  extraSurface.extra = true;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(extraSurface)));
  const nonFunction = mutableRepository(proof);
  nonFunction.getIntegrationRun = null;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(nonFunction)));
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(mutableRepository(proof)), /frozen/iu);

  let surfaceTrapCount = 0;
  const surfaceProxy = new Proxy(repository, {
    get() {
      surfaceTrapCount += 1;
      throw new Error("surface get trap must not run");
    },
    getPrototypeOf() {
      surfaceTrapCount += 1;
      throw new Error("surface prototype trap must not run");
    },
    ownKeys() {
      surfaceTrapCount += 1;
      throw new Error("surface ownKeys trap must not run");
    },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(surfaceProxy), /Proxy/iu);
  assert.equal(surfaceTrapCount, 0);

  let accessorTrapCount = 0;
  const accessorSurface = mutableRepository(proof);
  Object.defineProperty(accessorSurface, "getIntegrationRun", {
    configurable: true,
    enumerable: true,
    get() {
      accessorTrapCount += 1;
      throw new Error("surface accessor must not run");
    },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(accessorSurface)));
  assert.equal(accessorTrapCount, 0);

  const symbolSurface = mutableRepository(proof);
  symbolSurface[Symbol("private")] = true;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(symbolSurface)));
  const inheritedSemantic = Object.create({
    get plan() {
      accessorTrapCount += 1;
      throw new Error("inherited semantic getter must not run");
    },
  });
  Object.assign(inheritedSemantic, mutableRepository(proof));
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(inheritedSemantic)), /prototype/iu);
  assert.equal(accessorTrapCount, 0);

  let callableTrapCount = 0;
  const proxiedCallable = new Proxy(ordinaryRepositoryMethod, {
    get() {
      callableTrapCount += 1;
      throw new Error("callable get trap must not run");
    },
    getPrototypeOf() {
      callableTrapCount += 1;
      throw new Error("callable prototype trap must not run");
    },
  });
  const proxyMethodSurface = mutableRepository(proof);
  proxyMethodSurface.getIntegrationRun = proxiedCallable;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(proxyMethodSurface)), /Proxy/iu);
  assert.equal(callableTrapCount, 0);
  function customPrototypeCallable() {}
  Object.setPrototypeOf(customPrototypeCallable, Object.freeze({}));
  const customCallableSurface = mutableRepository(proof);
  customCallableSurface.getIntegrationRun = customPrototypeCallable;
  expectUnavailable(() => assertIntegrationRuntimeRepositorySurface(Object.freeze(customCallableSurface)), /prototype/iu);

  const badDigest = cloneFrozen(proof, {
    digest: { configurable: false, enumerable: true, writable: false, value: "f".repeat(64) },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(badDigest), /digest/iu);
  const falseClaim = repositoryAttestation({ overrides: { dispatchLeases: false } });
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(falseClaim));
  const mutableProof = { ...proof };
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(mutableProof), /frozen/iu);

  let proofTrapCount = 0;
  const proofProxy = new Proxy(proof, {
    get() {
      proofTrapCount += 1;
      throw new Error("proof get trap must not run");
    },
    ownKeys() {
      proofTrapCount += 1;
      throw new Error("proof ownKeys trap must not run");
    },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(proofProxy), /Proxy/iu);
  assert.equal(proofTrapCount, 0);
  const accessorProof = cloneFrozen(proof, {
    runtimeRoots: {
      configurable: false,
      enumerable: true,
      get() {
        proofTrapCount += 1;
        throw new Error("proof accessor must not run");
      },
    },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(accessorProof));
  assert.equal(proofTrapCount, 0);

  let rootValueTrapCount = 0;
  const dangerousPathValue = new Proxy(Object.freeze({}), {
    get() {
      rootValueTrapCount += 1;
      throw new Error("root path object must not be observed");
    },
  });
  const unsafeRoots = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: dangerousPathValue,
    baseDir: roots.baseDir,
    commandCwd: roots.commandCwd,
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
    digest: "0".repeat(64),
  });
  expectUnavailable(() => validateNativeRuntimeRootsAttestation(unsafeRoots), /unavailable/iu);
  assert.equal(rootValueTrapCount, 0);

  let optionsTrapCount = 0;
  const optionsProxy = new Proxy(Object.freeze({ requireRetainedDescriptorStorage: true }), {
    get() {
      optionsTrapCount += 1;
      throw new Error("options get trap must not run");
    },
    ownKeys() {
      optionsTrapCount += 1;
      throw new Error("options ownKeys trap must not run");
    },
  });
  expectUnavailable(() => assertIntegrationRuntimeRepositoryAttestation(proof, optionsProxy), /Proxy/iu);
  assert.equal(optionsTrapCount, 0);
  await assertRejectedPromisesAreSunk(proof);
  await assertUnsafePromiseMetadataIsNotObserved(proof);

  const originalSome = Array.prototype.some;
  const originalEvery = Array.prototype.every;
  const originalIncludes = Array.prototype.includes;
  let poisonedCallError = null;
  try {
    Array.prototype.some = () => { throw new Error("poisoned some"); };
    Array.prototype.every = () => { throw new Error("poisoned every"); };
    Array.prototype.includes = () => { throw new Error("poisoned includes"); };
    assertIntegrationRuntimeRepositorySurface(repository);
  } catch (error) {
    poisonedCallError = error;
  } finally {
    Array.prototype.some = originalSome;
    Array.prototype.every = originalEvery;
    Array.prototype.includes = originalIncludes;
  }
  if (poisonedCallError) throw poisonedCallError;

  const contractSource = await fs.readFile(new URL("../src/integration-runtime-repository-contract.js", import.meta.url), "utf8");
  const authoritySource = await fs.readFile(new URL("../src/integration-runtime-authority.js", import.meta.url), "utf8");
  const executorSource = await fs.readFile(new URL("../src/integration-native-executor.js", import.meta.url), "utf8");
  assert.doesNotMatch(contractSource, /integration-native-executor|agent-runner|playwright/u);
  assert.match(contractSource, /integration-native-runtime-roots\.js/u);
  assert.doesNotMatch(authoritySource, /const REQUIRED_REPOSITORY_METHODS|function validateRepository\(/u);
  assert.match(authoritySource, /assertIntegrationRuntimeRepositorySurface as validateRepository/u);
  assert.match(authoritySource, /assertIntegrationRuntimeRepositoryAttestation as validateRepositoryAttestation/u);
  assert.match(authoritySource, /export \{[\s\S]*INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_PROPERTY,[\s\S]*INTEGRATION_RUNTIME_REPOSITORY_ATTESTATION_VERSION,[\s\S]*\} from "\.\/integration-runtime-repository-contract\.js"/u);
  assert.match(authoritySource, /validateRepository\(options\.threadSessionRepository\)/u);
  assert.match(authoritySource, /validateRepositoryAttestation\(repository\.attestation,/u);
  assert.match(executorSource, /from "\.\/integration-native-runtime-roots\.js"/u);
  assert.match(executorSource, /export \{[\s\S]*NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,[\s\S]*validateNativeRuntimeRootsAttestation,[\s\S]*\} from "\.\/integration-native-runtime-roots\.js"/u);

  console.log("integration runtime repository contract smoke: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
