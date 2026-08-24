import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { authorityFail } from "./integration-authority-error.js";
import {
  INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS,
  INTEGRATION_RETAINED_EVENT_LEDGER_LOCK_FILE,
  assertRetainedIntegrationEventLedgerBundle,
  createRetainedIntegrationEventLedgerBundle,
} from "./integration-event-ledger-store.js";
import { NATIVE_INTEGRATION_EXECUTOR_PROOF } from "./integration-native-executor.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
  validateNativeRuntimeRootsAttestation,
} from "./integration-native-runtime-roots.js";
import { contractDigest } from "./integration-policy.js";
import {
  createRetainedIntegrationNativeSessionRepositoryState,
} from "./integration-retained-native-session-repository-state.js";
import {
  INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS,
  assertRetainedIntegrationRuntimeRepositorySurface,
  createRetainedIntegrationRuntimeRepositorySurface,
} from "./integration-retained-runtime-repository-surface.js";
import {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  INTEGRATION_RETAINED_SESSION_STATE_STORE_LIMITATIONS,
  assertRetainedIntegrationSessionStateStore,
  createRetainedIntegrationSessionStateStore,
} from "./integration-retained-session-state-store.js";
import {
  INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS,
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  createRetainedIntegrationRuntimeRepositoryKernel,
} from "./integration-runtime-repository.js";
import {
  PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
  PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
} from "./integration-sandbox-profile.js";
import {
  assertIntegrationStorageAuthority,
  assertIntegrationRetainedDirectory,
  assertIntegrationRetainedFilePrimitives,
  assertIntegrationRetainedRegularFileLock,
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "./integration-storage-authority.js";

const FunctionPrototypeCall = Function.prototype.call;
const NativePromise = Promise;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
const PromisePrototypeThen = NativePromise.prototype.then;
const ReflectApply = Reflect.apply;
const SymbolSpecies = Symbol.species;
const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(
  NativePromise,
  SymbolSpecies
);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;

export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_VERSION =
  "aginti-integration-production-runtime-bundle-v1";
export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ATTESTATION_VERSION =
  "aginti-integration-production-runtime-bundle-attestation-v1";
export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_HEALTH_VERSION =
  "aginti-integration-production-runtime-bundle-health-v1";
export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ROLE =
  "public-integration-production-runtime";
export const INTEGRATION_PRODUCTION_RUNTIME_FLOCK_HELPER = "/usr/bin/flock";

export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT = deepFreeze({
  repository: ["runtime-authority", "repository"],
  sessions: ["runtime-authority", "sessions"],
  workspace: ["runtime-authority", "workspace"],
  eventLedger: ["event-ledger"],
  idempotency: ["idempotency-store"],
});

export const INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LIMITATIONS = deepFreeze(
  Object.assign(Object.create(null), {
    preEnableBundle: true,
    capabilityEnabled: false,
    httpServingEnabled: false,
    runtimeActivationIncluded: false,
    repositoryFenceAcquisitionIncluded: false,
    storageLifecycleOwned: true,
    descriptorBoundRepository: true,
    descriptorBoundSessionState: true,
    descriptorBoundEventLedger: true,
    descriptorBoundIdempotencyNamespace: true,
    descriptorBoundIdempotencyStore: false,
    nativeExecutorRetainedSessionBinding: false,
    sandboxCapabilityEnabled: false,
    publicArtifactEvents: false,
    runtimeAuthorityComposed: false,
    sessionServiceComposed: false,
    repositoryLimitations: INTEGRATION_RETAINED_RUNTIME_REPOSITORY_LIMITATIONS,
    repositoryKernelLimitations: INTEGRATION_RETAINED_REPOSITORY_KERNEL_LIMITATIONS,
    sessionStateLimitations: INTEGRATION_RETAINED_SESSION_STATE_STORE_LIMITATIONS,
    eventLedgerLimitations: INTEGRATION_RETAINED_EVENT_LEDGER_BUNDLE_LIMITATIONS,
  })
);

const BUNDLE_INPUT_KEYS = Object.freeze(["stateRoot"]);
const DEFAULT_REPOSITORY_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SESSION_STATE_BYTES = 512 * 1024;
const DEFAULT_EVENT_LEDGER_EVENTS = 10_000;
const DEFAULT_EVENT_LEDGER_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS = 3_000;
const ZERO_DIGEST = "0".repeat(64);
const STORAGE_SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "EBADF",
  "EBUSY",
  "EDQUOT",
  "EFBIG",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "ESTALE",
]);
const STATIC_BLOCKERS = deepFreeze([
  {
    component: "idempotencyStore",
    code: "INTEGRATION_DESCRIPTOR_BOUND_IDEMPOTENCY_UNAVAILABLE",
  },
  {
    component: "sandbox",
    code: "INTEGRATION_SANDBOX_REVALIDATION_REQUIRED",
  },
  {
    component: "nativeExecutor",
    code: "INTEGRATION_PUBLIC_ARTIFACT_EVENTS_UNAVAILABLE",
  },
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function bundleFail(code, message) {
  authorityFail(code, message, { status: 503 });
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwnProperty, [value, key]);
}

function isPromiseValue(value) {
  return (
    Boolean(value) &&
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

function observeRejectedArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    observePromiseRejectionIfSafe(args[index]);
  }
}

function safeErrorCode(error) {
  const code = String(error?.publicCode || error?.code || "");
  if (STORAGE_SYSTEM_ERROR_CODES.has(code)) return "INTEGRATION_STORAGE_UNAVAILABLE";
  return /^[A-Z][A-Z0-9_]{1,95}$/u.test(code)
    ? code
    : "INTEGRATION_RUNTIME_BUNDLE_UNAVAILABLE";
}

function throwNormalizedCompositionError(error) {
  const rawCode = String(error?.publicCode || error?.code || "");
  if (STORAGE_SYSTEM_ERROR_CODES.has(rawCode)) {
    bundleFail(
      "INTEGRATION_STORAGE_UNAVAILABLE",
      "Production runtime bundle storage composition is unavailable."
    );
  }
  if (/^(?:INTEGRATION|PUBLIC)_[A-Z0-9_]+$/u.test(rawCode)) throw error;
  bundleFail(
    "INTEGRATION_RUNTIME_BUNDLE_UNAVAILABLE",
    "Production runtime bundle composition is unavailable."
  );
}

function failureComponent(code) {
  if (code.startsWith("INTEGRATION_STORAGE_")) return "storageAuthority";
  if (code.startsWith("INTEGRATION_REPOSITORY_")) return "repository";
  if (code.startsWith("INTEGRATION_SESSION_STATE_")) return "sessionState";
  if (code.startsWith("PUBLIC_EVENT_LEDGER_")) return "eventLedger";
  return "runtimeBundle";
}

function exactBundleInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    utilTypes.isProxy(input) ||
    Array.isArray(input) ||
    observePromiseRejectionIfSafe(input)
  ) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle input must be plain data.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle input prototype is invalid.");
  }
  const keys = Reflect.ownKeys(input);
  let stateRootDescriptor = null;
  for (const key of keys) {
    const descriptor = ObjectGetOwnPropertyDescriptor(input, key);
    if (descriptor && hasOwn(descriptor, "value")) {
      observePromiseRejectionIfSafe(descriptor.value);
    }
    if (key === "stateRoot") stateRootDescriptor = descriptor;
  }
  if (
    keys.length !== BUNDLE_INPUT_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !BUNDLE_INPUT_KEYS.includes(key))
  ) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle input fields are invalid.");
  }
  const descriptor = stateRootDescriptor;
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle stateRoot must be a data field.");
  }
  const stateRoot = descriptor.value;
  if (
    observePromiseRejectionIfSafe(stateRoot) ||
    typeof stateRoot !== "string" ||
    !path.isAbsolute(stateRoot) ||
    path.normalize(stateRoot) !== stateRoot ||
    stateRoot === path.parse(stateRoot).root ||
    stateRoot.endsWith(path.sep) ||
    stateRoot.includes("\0")
  ) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle stateRoot is invalid.");
  }
  return Object.freeze({ stateRoot });
}

function safeRootPath(stateRoot) {
  if (
    observePromiseRejectionIfSafe(stateRoot) ||
    typeof stateRoot !== "string" ||
    !path.isAbsolute(stateRoot) ||
    path.normalize(stateRoot) !== stateRoot ||
    stateRoot === path.parse(stateRoot).root ||
    stateRoot.endsWith(path.sep) ||
    stateRoot.includes("\0")
  ) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle stateRoot is invalid.");
  }
  return stateRoot;
}

export function integrationProductionRuntimeBundlePaths(stateRootInput) {
  if (arguments.length !== 1) {
    observeRejectedArguments(arguments);
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle paths require one argument.");
  }
  const stateRoot = safeRootPath(stateRootInput);
  const directory = (segments) => path.join(stateRoot, ...segments);
  const repository = directory(INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.repository);
  const sessions = directory(INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.sessions);
  const eventLedger = directory(INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.eventLedger);
  return deepFreeze({
    stateRoot,
    repository,
    repositoryLock: path.join(repository, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE),
    sessions,
    sessionLock: path.join(sessions, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE),
    workspace: directory(INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.workspace),
    eventLedger,
    eventLedgerLock: path.join(eventLedger, INTEGRATION_RETAINED_EVENT_LEDGER_LOCK_FILE),
    idempotency: directory(INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.idempotency),
  });
}

function retainedObjectIdentityDigest(stat) {
  return contractDigest({
    schemaVersion: "aginti-retained-regular-file-identity-v1",
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

async function flockHelperProof() {
  let bytes;
  let stat;
  try {
    [bytes, stat] = await Promise.all([
      fs.readFile(INTEGRATION_PRODUCTION_RUNTIME_FLOCK_HELPER),
      fs.stat(INTEGRATION_PRODUCTION_RUNTIME_FLOCK_HELPER, { bigint: true }),
    ]);
  } catch {
    bundleFail(
      "INTEGRATION_STORAGE_UNAVAILABLE",
      "Pinned production runtime lock helper is unavailable."
    );
  }
  return Object.freeze({
    helperSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    helperIdentityDigest: retainedObjectIdentityDigest(stat),
  });
}

async function openDirectoryBinding({
  authority,
  stateRoot,
  relativeSegments,
  lockFileName,
  lockPath,
  helperProof,
  capacity,
}) {
  const directory = await authority.openDirectory(relativeSegments);
  const identity = await directory.identity();
  const directoryExpected = Object.freeze({
    role: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ROLE,
    canonicalPath: stateRoot,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments,
    directoryIdentityDigest: identity.digest,
  });
  const files = createIntegrationRetainedFilePrimitives(directory, directoryExpected);
  let lockStat;
  try {
    lockStat = await fs.stat(lockPath, { bigint: true });
  } catch {
    bundleFail(
      "INTEGRATION_STORAGE_UNAVAILABLE",
      "Preprovisioned production runtime lock file is unavailable."
    );
  }
  const lockFileIdentityDigest = retainedObjectIdentityDigest(lockStat);
  const lockExpected = Object.freeze({
    ...directoryExpected,
    lockFileName,
    helperSha256: helperProof.helperSha256,
    lockFileIdentityDigest,
    helperIdentityDigest: helperProof.helperIdentityDigest,
  });
  const lock = await openIntegrationRetainedRegularFileLock(files, lockExpected);
  return Object.freeze({
    directory,
    identity,
    files,
    lock,
    directoryExpected,
    expected: Object.freeze({
      ...directoryExpected,
      lockFileIdentityDigest,
      helperSha256: helperProof.helperSha256,
      helperIdentityDigest: helperProof.helperIdentityDigest,
      ...capacity,
      lockWaitMs: DEFAULT_LOCK_WAIT_MS,
    }),
    lockExpected,
  });
}

async function openDescriptorDirectory(authority, stateRoot, relativeSegments) {
  const directory = await authority.openDirectory(relativeSegments);
  const identity = await directory.identity();
  const expected = Object.freeze({
    role: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ROLE,
    canonicalPath: stateRoot,
    rootIdentityDigest: authority.attestation.rootIdentityDigest,
    relativeSegments,
    directoryIdentityDigest: identity.digest,
  });
  return Object.freeze({ directory, identity, expected });
}

function runtimeRoots(paths) {
  const unsigned = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: paths.sessions,
    baseDir: paths.workspace,
    commandCwd: paths.workspace,
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  });
  const proof = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  validateNativeRuntimeRootsAttestation(proof);
  return proof;
}

function componentEvidence(state = null) {
  const composed = Boolean(state);
  const repositoryProof = state?.repository?.integrationRuntimeRepositoryAttestation;
  const components = Object.assign(Object.create(null), {
    storageAuthority: Object.freeze({
      composed,
      healthy: composed,
      descriptorBound: composed,
      lifecycleOwned: composed,
      proofDigest: state?.authority?.attestation?.digest || ZERO_DIGEST,
    }),
    repository: Object.freeze({
      composed,
      healthy: composed,
      descriptorBound: composed,
      runtimeFenceAcquired: false,
      proofDigest: repositoryProof?.digest || ZERO_DIGEST,
    }),
    sessionState: Object.freeze({
      composed,
      healthy: composed,
      descriptorBound: composed,
      nativeWriteFenceBound: false,
      proofDigest: state?.sessionStateStore?.attestation?.digest || ZERO_DIGEST,
    }),
    eventLedger: Object.freeze({
      composed,
      healthy: composed,
      descriptorBound: composed,
      runtimeAppendView: composed,
      sessionReadView: composed,
      proofDigest: state?.eventLedgerBundle?.attestation?.digest || ZERO_DIGEST,
    }),
    idempotencyStore: Object.freeze({
      composed: false,
      healthy: false,
      namespaceDescriptorBound: composed,
      transactionalStore: false,
      proofDigest: ZERO_DIGEST,
    }),
    nativeExecutor: Object.freeze({
      lexicalProofPresent: true,
      retainedSessionStateBound: false,
      planEvents: NATIVE_INTEGRATION_EXECUTOR_PROOF.planEvents === true,
      artifactEvents: NATIVE_INTEGRATION_EXECUTOR_PROOF.artifactEvents === true,
      proofDigest: NATIVE_INTEGRATION_EXECUTOR_PROOF.digest,
    }),
    sandbox: Object.freeze({
      profilePresent: true,
      profileId: PUBLIC_INTEGRATION_SANDBOX_PROFILE_ID,
      freshPrerequisitesAttested: false,
      capabilityEnabled: PUBLIC_INTEGRATION_SANDBOX_CAPABILITY_ENABLED,
      proofDigest: ZERO_DIGEST,
    }),
    runtimeAuthority: Object.freeze({
      factoryPresent: true,
      composed: false,
      repositoryFenceAcquired: false,
      proofDigest: ZERO_DIGEST,
    }),
    sessionService: Object.freeze({
      factoryPresent: true,
      composed: false,
      runtimeAuthorityBound: false,
      eventReadViewBound: composed,
      proofDigest: ZERO_DIGEST,
    }),
  });
  return Object.freeze(components);
}

function buildHealthEvidence(state, probe, { healthy = true, dynamicBlocker = null } = {}) {
  const components = componentEvidence(healthy ? state : null);
  const blockers = deepFreeze([
    ...(dynamicBlocker ? [dynamicBlocker] : []),
    ...STATIC_BLOCKERS,
  ]);
  const implementationReady = Boolean(
    healthy &&
    components.storageAuthority.descriptorBound &&
    components.repository.descriptorBound &&
    components.sessionState.descriptorBound &&
    components.eventLedger.descriptorBound &&
    components.idempotencyStore.transactionalStore &&
    components.nativeExecutor.retainedSessionStateBound &&
    components.nativeExecutor.planEvents &&
    components.nativeExecutor.artifactEvents &&
    components.sandbox.capabilityEnabled &&
    components.runtimeAuthority.composed &&
    components.sessionService.composed
  );
  const unsigned = deepFreeze({
    schemaVersion: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_HEALTH_VERSION,
    owner: "aginti",
    authority: "aginti",
    probe,
    status: healthy ? "healthy-disabled" : "unavailable-disabled",
    healthy,
    implementationReady,
    capabilityEnabled: false,
    httpServingEnabled: false,
    components,
    blockers,
    firstBlocker: blockers[0],
  });
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function buildBundleAttestation(state) {
  const health = buildHealthEvidence(state, "open");
  const unsigned = deepFreeze({
    schemaVersion: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    descriptorBound: true,
    storageLifecycleOwned: true,
    implementationReady: health.implementationReady,
    capabilityEnabled: false,
    httpServingEnabled: false,
    runtimeActivated: false,
    runtimeRootsDigest: state.runtimeRoots.digest,
    storageProofDigest: state.authority.attestation.digest,
    repositoryProofDigest: state.repository.integrationRuntimeRepositoryAttestation.digest,
    sessionStateProofDigest: state.sessionStateStore.attestation.digest,
    eventLedgerProofDigest: state.eventLedgerBundle.attestation.digest,
    idempotencyProofDigest: ZERO_DIGEST,
    nativeExecutorProofDigest: NATIVE_INTEGRATION_EXECUTOR_PROOF.digest,
    blockers: health.blockers,
    limitations: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LIMITATIONS,
  });
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function assertBundleLive(state) {
  if (state.poisoned) {
    bundleFail(
      "INTEGRATION_RUNTIME_BUNDLE_POISONED",
      "Production runtime bundle health can no longer be proven."
    );
  }
  if (state.closing || state.closed || state.authority.isClosed()) {
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_CLOSED", "Production runtime bundle is closed.");
  }
}

function beginProbe(state) {
  assertBundleLive(state);
  state.activeProbes += 1;
}

async function acquireProbeTurn(state) {
  if (!state.probeRunning) {
    state.probeRunning = true;
    return;
  }
  await new NativePromise((resolve) => state.probeTurnWaiters.push(resolve));
}

function releaseProbeTurn(state) {
  const next = state.probeTurnWaiters.shift();
  if (next) next();
  else state.probeRunning = false;
}

function endProbe(state) {
  state.activeProbes -= 1;
  if (state.activeProbes !== 0) return;
  const waiters = state.probeDrainWaiters;
  state.probeDrainWaiters = [];
  for (const resolve of waiters) resolve();
}

async function waitForProbeDrain(state) {
  if (state.activeProbes === 0) return;
  await new Promise((resolve) => state.probeDrainWaiters.push(resolve));
}

async function probeBundle(state, probe) {
  beginProbe(state);
  let probeTurnAcquired = false;
  try {
    await acquireProbeTurn(state);
    probeTurnAcquired = true;
    assertBundleLive(state);
    assertIntegrationStorageAuthority(state.authority, {
      role: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ROLE,
      canonicalPath: state.paths.stateRoot,
      rootIdentityDigest: state.authority.attestation.rootIdentityDigest,
    });
    await state.authority.recheckNamedBinding();
    assertBundleLive(state);
    for (const binding of state.directoryBindings) {
      assertIntegrationRetainedDirectory(
        binding.directory,
        binding.directoryExpected || binding.expected
      );
      const identity = await binding.directory.identity();
      assertBundleLive(state);
      if (identity.digest !== binding.expected.directoryIdentityDigest) {
        bundleFail(
          "INTEGRATION_RUNTIME_BUNDLE_POISONED",
          "Production runtime bundle directory identity changed."
        );
      }
    }
    for (const binding of [
      state.repositoryBinding,
      state.sessionBinding,
      state.eventLedgerBinding,
    ]) {
      assertIntegrationRetainedFilePrimitives(binding.files, binding.directoryExpected);
      assertIntegrationRetainedRegularFileLock(binding.lock, binding.lockExpected);
      await binding.lock.runExclusive(
        async () => {
          assertBundleLive(state);
        },
        { waitMs: DEFAULT_LOCK_WAIT_MS }
      );
      assertBundleLive(state);
    }
    assertIntegrationRetainedFilePrimitives(
      state.idempotencyFiles,
      state.idempotencyBinding.expected
    );
    assertRetainedIntegrationSessionStateStore(
      state.sessionStateStore,
      state.sessionBinding.expected
    );
    assertRetainedIntegrationRuntimeRepositorySurface(state.repository);
    assertRetainedIntegrationEventLedgerBundle(
      state.eventLedgerBundle,
      state.eventLedgerBinding.expected
    );
    const eventSessionProof = await state.eventLedgerBundle.sessionReadView.attest();
    assertBundleLive(state);
    if (
      eventSessionProof.digest !==
      state.eventLedgerBundle.attestation.sessionProofDigest
    ) {
      bundleFail(
        "INTEGRATION_RUNTIME_BUNDLE_POISONED",
        "Production runtime bundle event read view changed."
      );
    }
    validateNativeRuntimeRootsAttestation(state.runtimeRoots);
    assertBundleLive(state);
    return buildHealthEvidence(state, probe);
  } catch (error) {
    if (!state.closing && !state.closed) {
      state.poisoned = true;
      state.poisonCode = safeErrorCode(error);
    }
    throw error;
  } finally {
    if (probeTurnAcquired) releaseProbeTurn(state);
    endProbe(state);
  }
}

function buildBundleSurface(state) {
  const surface = Object.freeze(Object.assign(Object.create(null), {
    schemaVersion: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_VERSION,
    attestation: state.attestation,
    preflight() {
      if (arguments.length !== 0) {
        observeRejectedArguments(arguments);
        bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle preflight takes no arguments.");
      }
      return probeBundle(state, "preflight");
    },
    health() {
      if (arguments.length !== 0) {
        observeRejectedArguments(arguments);
        bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle health takes no arguments.");
      }
      return probeBundle(state, "health");
    },
    close() {
      if (arguments.length !== 0) {
        observeRejectedArguments(arguments);
        bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle close takes no arguments.");
      }
      if (state.closePromise) return state.closePromise;
      state.closing = true;
      state.closePromise = (async () => {
        await waitForProbeDrain(state);
        try {
          await state.authority.close();
        } finally {
          state.closed = true;
          state.closing = false;
        }
        return Object.freeze({ closed: true, poisoned: state.poisoned });
      })();
      return state.closePromise;
    },
    isClosed() {
      if (arguments.length !== 0) {
        observeRejectedArguments(arguments);
        bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle isClosed takes no arguments.");
      }
      return state.closing || state.closed || state.authority.isClosed();
    },
  }));
  state.surface = surface;
  return surface;
}

export async function openIntegrationProductionRuntimeBundle(input) {
  if (arguments.length !== 1) {
    observeRejectedArguments(arguments);
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle open requires one argument.");
  }
  const options = exactBundleInput(input);
  const paths = integrationProductionRuntimeBundlePaths(options.stateRoot);
  let authority = null;
  try {
    authority = await openIntegrationStorageAuthority({
      rootPath: paths.stateRoot,
      role: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_ROLE,
      label: "public integration production runtime",
    });
    const helperProof = await flockHelperProof();
    const repositoryBinding = await openDirectoryBinding({
      authority,
      stateRoot: paths.stateRoot,
      relativeSegments: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.repository,
      lockFileName: INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
      lockPath: paths.repositoryLock,
      helperProof,
      capacity: { maxSnapshotBytes: DEFAULT_REPOSITORY_SNAPSHOT_BYTES },
    });
    const sessionBinding = await openDirectoryBinding({
      authority,
      stateRoot: paths.stateRoot,
      relativeSegments: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.sessions,
      lockFileName: INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
      lockPath: paths.sessionLock,
      helperProof,
      capacity: { maxStateBytes: DEFAULT_SESSION_STATE_BYTES },
    });
    const eventLedgerBinding = await openDirectoryBinding({
      authority,
      stateRoot: paths.stateRoot,
      relativeSegments: INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.eventLedger,
      lockFileName: INTEGRATION_RETAINED_EVENT_LEDGER_LOCK_FILE,
      lockPath: paths.eventLedgerLock,
      helperProof,
      capacity: {
        maxEvents: DEFAULT_EVENT_LEDGER_EVENTS,
        maxBytes: DEFAULT_EVENT_LEDGER_BYTES,
      },
    });
    const workspaceBinding = await openDescriptorDirectory(
      authority,
      paths.stateRoot,
      INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.workspace
    );
    const idempotencyBinding = await openDescriptorDirectory(
      authority,
      paths.stateRoot,
      INTEGRATION_PRODUCTION_RUNTIME_BUNDLE_LAYOUT.idempotency
    );
    const idempotencyFiles = createIntegrationRetainedFilePrimitives(
      idempotencyBinding.directory,
      idempotencyBinding.expected
    );
    const repositoryKernel = createRetainedIntegrationRuntimeRepositoryKernel(
      repositoryBinding.files,
      repositoryBinding.lock,
      repositoryBinding.expected
    );
    const sessionStateStore = createRetainedIntegrationSessionStateStore(
      sessionBinding.files,
      sessionBinding.lock,
      sessionBinding.expected
    );
    const repositoryExpected = Object.freeze({
      repositoryKernel: repositoryBinding.expected,
      sessionStateStore: sessionBinding.expected,
    });
    const repositoryState = createRetainedIntegrationNativeSessionRepositoryState(
      repositoryKernel,
      sessionStateStore,
      repositoryExpected
    );
    const roots = runtimeRoots(paths);
    const repository = createRetainedIntegrationRuntimeRepositorySurface({
      repositoryState,
      repositoryStateExpected: repositoryExpected,
      runtimeRoots: roots,
    });
    const eventLedgerBundle = createRetainedIntegrationEventLedgerBundle(
      eventLedgerBinding.files,
      eventLedgerBinding.lock,
      eventLedgerBinding.expected
    );
    await authority.recheckNamedBinding();
    const state = {
      authority,
      paths,
      repositoryBinding,
      sessionBinding,
      eventLedgerBinding,
      workspaceBinding,
      idempotencyBinding,
      idempotencyFiles,
      repositoryKernel,
      sessionStateStore,
      repositoryExpected,
      repositoryState,
      repository,
      eventLedgerBundle,
      runtimeRoots: roots,
      directoryBindings: Object.freeze([
        repositoryBinding,
        sessionBinding,
        eventLedgerBinding,
        workspaceBinding,
        idempotencyBinding,
      ]),
      activeProbes: 0,
      probeDrainWaiters: [],
      probeRunning: false,
      probeTurnWaiters: [],
      closing: false,
      closed: false,
      poisoned: false,
      poisonCode: "",
      closePromise: null,
      attestation: null,
      surface: null,
    };
    state.attestation = buildBundleAttestation(state);
    return buildBundleSurface(state);
  } catch (error) {
    if (authority) {
      try {
        await authority.close();
      } catch {
        // Preserve the original fail-closed composition error.
      }
    }
    throwNormalizedCompositionError(error);
  }
}

export async function preflightIntegrationProductionRuntimeBundle(input) {
  if (arguments.length !== 1) {
    observeRejectedArguments(arguments);
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle preflight requires one argument.");
  }
  const options = exactBundleInput(input);
  let bundle = null;
  try {
    bundle = await openIntegrationProductionRuntimeBundle(options);
    return await bundle.preflight();
  } finally {
    if (bundle) await bundle.close();
  }
}

export async function checkIntegrationProductionRuntimeBundle(input) {
  if (arguments.length !== 1) {
    observeRejectedArguments(arguments);
    bundleFail("INTEGRATION_RUNTIME_BUNDLE_INVALID", "Runtime bundle check requires one argument.");
  }
  const options = exactBundleInput(input);
  try {
    return await preflightIntegrationProductionRuntimeBundle(options);
  } catch (error) {
    const code = safeErrorCode(error);
    return buildHealthEvidence(null, "check", {
      healthy: false,
      dynamicBlocker: Object.freeze({
        component: failureComponent(code),
        code,
      }),
    });
  }
}
