import path from "node:path";
import { types as utilTypes } from "node:util";
import { authorityFail } from "./integration-authority-error.js";
import { contractDigest } from "./integration-policy.js";

const ArrayIsArray = Array.isArray;
const FunctionPrototypeCall = Function.prototype.call;
const NativePromise = Promise;
const ObjectAssign = Object.assign;
const ObjectCreate = Object.create;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIsFrozen = Object.isFrozen;
const ObjectPrototype = Object.prototype;
const ObjectPrototypeHasOwn = Object.prototype.hasOwnProperty;
const PathIsAbsolute = path.isAbsolute;
const PathRelative = path.relative;
const PathResolve = path.resolve;
const PromisePrototype = NativePromise.prototype;
const PromisePrototypeThen = PromisePrototype.then;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpPrototypeTest = RegExp.prototype.test;
const StringPrototypeEndsWith = String.prototype.endsWith;
const StringPrototypeIncludes = String.prototype.includes;
const StringPrototypeStartsWith = String.prototype.startsWith;
const StringPrototypeTrim = String.prototype.trim;
const SymbolSpecies = Symbol.species;

const NativePromiseSpeciesDescriptor = ObjectGetOwnPropertyDescriptor(NativePromise, SymbolSpecies);
const NativePromiseSpeciesGetter = NativePromiseSpeciesDescriptor?.get;
const NativePromiseSpeciesSetter = NativePromiseSpeciesDescriptor?.set;

export const NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION = "aginti-native-runtime-roots-v1";

const NATIVE_RUNTIME_ROOTS_KEYS = ObjectFreeze([
  "schemaVersion",
  "sessionsDir",
  "baseDir",
  "commandCwd",
  "retainedDescriptor",
  "symlinkFree",
  "outsideForbiddenRoots",
  "digest",
]);
const NATIVE_RUNTIME_ROOTS_KEY_LOOKUP = ObjectFreeze(ObjectAssign(ObjectCreate(null), {
  schemaVersion: true,
  sessionsDir: true,
  baseDir: true,
  commandCwd: true,
  retainedDescriptor: true,
  symlinkFree: true,
  outsideForbiddenRoots: true,
  digest: true,
}));
const DANGEROUS_ROOT_LOOKUP = ObjectFreeze(ObjectAssign(ObjectCreate(null), {
  "/": true,
  "/home": true,
  "/Users": true,
  "/mnt": true,
  "/media": true,
  "/Volumes": true,
  "/etc": true,
  "/root": true,
  "/proc": true,
  "/sys": true,
  "/dev": true,
  "/run": true,
  "/var": true,
  "/usr": true,
  "/opt": true,
  "/srv": true,
  "/tmp": true,
}));

function fail(message) {
  authorityFail("AGENT_UNAVAILABLE", message);
}

function isPromiseValue(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !utilTypes.isProxy(value) &&
    utilTypes.isPromise(value)
  );
}

function hasOwn(value, key) {
  return ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [value, key]);
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

function rejectNonDataObject(value, label) {
  if (value && (typeof value === "object" || typeof value === "function") && utilTypes.isProxy(value)) {
    fail(`${label} must not be a Proxy.`);
  }
  if (observePromiseRejectionIfSafe(value)) {
    fail(`${label} must be synchronous plain data.`);
  }
  if (!value || typeof value !== "object" || ArrayIsArray(value)) {
    fail(`${label} must be a frozen object.`);
  }
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) fail(`${label} prototype is invalid.`);
  if (!ObjectIsFrozen(value)) fail(`${label} must be frozen.`);
}

function exactFrozenDataDescriptors(value, keys, label) {
  rejectNonDataObject(value, label);
  const ownKeys = ReflectOwnKeys(value);
  if (ownKeys.length !== keys.length) {
    fail(`${label} must contain exact frozen data fields.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (
      typeof key !== "string" ||
      !ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [NATIVE_RUNTIME_ROOTS_KEY_LOOKUP, key])
    ) {
      fail(`${label} must contain exact frozen data fields.`);
    }
  }
  const descriptors = ObjectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      descriptor.writable !== false ||
      descriptor.configurable !== false ||
      !ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [descriptor, "value"])
    ) {
      fail(`${label}.${key} must be an immutable enumerable data field.`);
    }
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function assertSafeRootPath(value, label) {
  if (typeof value !== "string" || !ReflectApply(StringPrototypeTrim, value, [])) {
    fail(`${label} is unavailable.`);
  }
  const resolved = ReflectApply(PathResolve, path, [value]);
  if (resolved !== value) fail(`${label} must be an exact absolute path.`);
  if (ReflectApply(FunctionPrototypeCall, ObjectPrototypeHasOwn, [DANGEROUS_ROOT_LOOKUP, resolved])) {
    fail(`${label} must not be a host root or system directory.`);
  }
  if (
    ReflectApply(RegExpPrototypeTest, /^\/home\/[^/]+$/u, [resolved]) ||
    ReflectApply(RegExpPrototypeTest, /^\/Users\/[^/]+$/u, [resolved]) ||
    ReflectApply(RegExpPrototypeTest, /^\/Volumes\/[^/]+$/u, [resolved])
  ) {
    fail(`${label} must not be a shallow user or volume root.`);
  }
  if (
    ReflectApply(StringPrototypeIncludes, resolved, ["/../"]) ||
    ReflectApply(StringPrototypeEndsWith, resolved, ["/.."])
  ) {
    fail(`${label} must not contain parent traversal.`);
  }
  return resolved;
}

function pathInside(child, parent) {
  const relative = ReflectApply(PathRelative, path, [parent, child]);
  return (
    relative === "" ||
    (!ReflectApply(StringPrototypeStartsWith, relative, [".."]) &&
      !ReflectApply(PathIsAbsolute, path, [relative]))
  );
}

function pathsDisjoint(left, right) {
  return !pathInside(left, right) && !pathInside(right, left);
}

export function validateNativeRuntimeRootsAttestation(value = {}) {
  const descriptors = exactFrozenDataDescriptors(
    value,
    NATIVE_RUNTIME_ROOTS_KEYS,
    "native runtime roots attestation"
  );
  const roots = ObjectCreate(null);
  let promiseField = "";
  for (let index = 0; index < NATIVE_RUNTIME_ROOTS_KEYS.length; index += 1) {
    const key = NATIVE_RUNTIME_ROOTS_KEYS[index];
    roots[key] = descriptors[key].value;
    if (observePromiseRejectionIfSafe(roots[key]) && !promiseField) promiseField = key;
  }
  if (promiseField) fail(`native runtime roots attestation.${promiseField} must be synchronous plain data.`);
  const unsigned = ObjectCreate(null);
  for (let index = 0; index < NATIVE_RUNTIME_ROOTS_KEYS.length; index += 1) {
    const key = NATIVE_RUNTIME_ROOTS_KEYS[index];
    if (key !== "digest") unsigned[key] = roots[key];
  }
  if (
    typeof roots.schemaVersion !== "string" ||
    typeof roots.sessionsDir !== "string" ||
    typeof roots.baseDir !== "string" ||
    typeof roots.commandCwd !== "string" ||
    typeof roots.retainedDescriptor !== "boolean" ||
    typeof roots.symlinkFree !== "boolean" ||
    typeof roots.outsideForbiddenRoots !== "boolean" ||
    typeof roots.digest !== "string" ||
    !ReflectApply(RegExpPrototypeTest, /^[a-f0-9]{64}$/u, [roots.digest]) ||
    roots.schemaVersion !== NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION ||
    roots.retainedDescriptor !== true ||
    roots.symlinkFree !== true ||
    roots.outsideForbiddenRoots !== true ||
    roots.digest !== contractDigest(unsigned)
  ) {
    fail("Native runtime roots attestation is unavailable.");
  }
  const sessionsDir = assertSafeRootPath(roots.sessionsDir, "sessionsDir");
  const baseDir = assertSafeRootPath(roots.baseDir, "baseDir");
  const commandCwd = assertSafeRootPath(roots.commandCwd, "commandCwd");
  if (!pathInside(commandCwd, baseDir)) {
    fail("Native runtime command workspace must be bound under the repository-attested workspace root.");
  }
  if (!pathsDisjoint(sessionsDir, commandCwd) || !pathsDisjoint(sessionsDir, baseDir)) {
    fail("Native session state root must be disjoint from the command/tool workspace.");
  }
  return ObjectFreeze({ sessionsDir, baseDir, commandCwd, digest: roots.digest });
}
