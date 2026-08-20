import http from "node:http";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import express from "express";
import {
  createIntegrationAuthMiddleware,
  createIntegrationClient,
  writeIntegrationErrorJson,
} from "./integration-auth.js";
import { createIntegrationRouter } from "./integration-api.js";
import {
  INTEGRATION_RPC_PATH_LIST,
  INTEGRATION_RPC_PATHS,
  buildFixedIntegrationPolicy,
} from "./integration-policy.js";
import {
  IntegrationServiceConfigError,
  publicIntegrationServiceConfig,
  validateIntegrationServiceConfig,
} from "./integration-config.js";

export const INTEGRATION_MOUNT_CAPABILITY_ENABLED = false;
export const DEFAULT_INTEGRATION_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_INTEGRATION_START_TIMEOUT_MS = 5_000;
export const INTEGRATION_STORAGE_ATTESTATION_SCHEMA = "aginti-integration-storage-attestation-v1";
export const INTEGRATION_STORAGE_ATTESTATION_PROPERTY = "integrationStorageAttestation";
export const INTEGRATION_STORAGE_SNAPSHOT_SCHEMA = "aginti-integration-storage-snapshot-v1";
export const INTEGRATION_STORAGE_ROOTS = Object.freeze({
  runtimeAuthority: "/var/lib/agintiflow-integration/runtime",
  eventLedgerStore: "/var/lib/agintiflow-integration/event-ledger",
  idempotencyStore: "/var/lib/agintiflow-integration/idempotency",
});
export const INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES = Object.freeze(["/", "/var", "/var/lib"]);

const RPC_PATH_SET = new Set(INTEGRATION_RPC_PATH_LIST);
const STORAGE_ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "owner",
  "authority",
  "dependency",
  "stateRoot",
  "storageRoot",
  "dedicated",
  "symlinkFree",
  "immutable",
  "serviceUid",
  "serviceGid",
  "stateIdentity",
  "storageIdentity",
]);
const DIRECTORY_IDENTITY_KEYS = Object.freeze(["dev", "ino", "nlink", "uid", "gid", "mode"]);
const DIRECTORY_EVIDENCE_KEYS = Object.freeze([
  "path",
  "exists",
  "isDirectory",
  "isSymbolicLink",
  "realPathBefore",
  "realPathAfter",
  "before",
  "opened",
  "after",
]);
const STORAGE_SNAPSHOT_KEYS = Object.freeze(["schemaVersion", "serviceUid", "serviceGid", "directories"]);
const STORAGE_DEPENDENCY_NAMES = Object.freeze([
  "runtimeAuthority",
  "eventLedgerStore",
  "idempotencyStore",
]);
const DISABLED_DEPENDENCY_ERROR = "INTEGRATION_DISABLED_DEPENDENCY_REJECTED";

function mountFail(code, message) {
  throw new IntegrationServiceConfigError(code, message);
}

function rejectDisabledDependency(dependencyName) {
  mountFail(
    DISABLED_DEPENDENCY_ERROR,
    `Disabled integration mount must not receive ${dependencyName}; enabled wiring requires descriptor-bound storage authority.`
  );
}

function rejectUnsafeIntegrationOptions() {
  mountFail(
    "INTEGRATION_CONFIG_INVALID",
    "Integration options must be a non-proxy plain data object."
  );
}

function proxySafeOwnPropertyDescriptor(value, propertyName) {
  if (types.isProxy(value)) rejectUnsafeIntegrationOptions();
  return Object.getOwnPropertyDescriptor(value, propertyName);
}

function proxySafePrototypeOf(value) {
  if (types.isProxy(value)) rejectUnsafeIntegrationOptions();
  return Object.getPrototypeOf(value);
}

function assertNoDisabledIntegrationDependencies(options = {}) {
  if (types.isProxy(options) || !options || typeof options !== "object" || Array.isArray(options)) {
    rejectUnsafeIntegrationOptions();
  }

  for (const dependencyName of STORAGE_DEPENDENCY_NAMES) {
    if (proxySafeOwnPropertyDescriptor(options, dependencyName)) {
      rejectDisabledDependency(dependencyName);
    }
  }

  const prototype = proxySafePrototypeOf(options);
  if (prototype !== null && types.isProxy(prototype)) rejectUnsafeIntegrationOptions();
  if (prototype !== Object.prototype && prototype !== null) rejectUnsafeIntegrationOptions();

  if (prototype === Object.prototype) {
    for (const dependencyName of STORAGE_DEPENDENCY_NAMES) {
      if (proxySafeOwnPropertyDescriptor(prototype, dependencyName)) {
        rejectDisabledDependency(dependencyName);
      }
    }
    if (proxySafePrototypeOf(prototype) !== null) rejectUnsafeIntegrationOptions();
  }
}

function exactRequestTarget(req = {}) {
  const target = String(req.originalUrl ?? req.url ?? "");
  return RPC_PATH_SET.has(target) ? target : "";
}

export function classifyExactIntegrationRoute(method, requestTarget) {
  const pathname = RPC_PATH_SET.has(String(requestTarget || "")) ? String(requestTarget) : "";
  if (!pathname) return Object.freeze({ allowed: false, status: 404, code: "NOT_FOUND", pathname: "" });
  if (String(method || "").toUpperCase() !== "POST") {
    return Object.freeze({ allowed: false, status: 405, code: "METHOD_NOT_ALLOWED", pathname });
  }
  return Object.freeze({ allowed: true, status: 0, code: "", pathname });
}

export function createExactIntegrationRouteBoundary() {
  return (req, res, next) => {
    if (!exactRequestTarget(req)) {
      writeIntegrationErrorJson(res, 404, "NOT_FOUND");
      return;
    }
    next();
  };
}

export function createPostOnlyIntegrationBoundary() {
  return (req, res, next) => {
    if (String(req.method || "").toUpperCase() !== "POST") {
      writeIntegrationErrorJson(res, 405, "METHOD_NOT_ALLOWED");
      return;
    }
    next();
  };
}

export function createHardDisabledIntegrationBoundary() {
  return (req, res, next) => {
    if (exactRequestTarget(req) === INTEGRATION_RPC_PATHS.capabilities) {
      next();
      return;
    }
    writeIntegrationErrorJson(res, 503, "AGENT_UNAVAILABLE");
  };
}

function normalizedProxyClient(value) {
  try {
    return createIntegrationClient(value);
  } catch {
    mountFail("INTEGRATION_AUTH_INVALID", "A protected trusted principal proxy client is required.");
  }
}

function exactFrozenData(value, keys, code, message) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  const ownKeys = value && typeof value === "object" ? Reflect.ownKeys(value) : [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null) ||
    !Object.isFrozen(value) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    mountFail(code, message);
  }
  return value;
}

function exactDirectoryIdentity(value, label) {
  const identity = exactFrozenData(
    value,
    DIRECTORY_IDENTITY_KEYS,
    "INTEGRATION_STORAGE_ATTESTATION_INVALID",
    `${label} directory identity is not sealed data.`
  );
  if (
    typeof identity.dev !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(identity.dev) ||
    typeof identity.ino !== "string" ||
    !/^[1-9][0-9]*$/u.test(identity.ino) ||
    !Number.isSafeInteger(identity.nlink) ||
    identity.nlink < 2 ||
    !Number.isSafeInteger(identity.uid) ||
    identity.uid < 0 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid < 0 ||
    !Number.isSafeInteger(identity.mode) ||
    identity.mode < 0 ||
    identity.mode > 0o7777
  ) {
    mountFail("INTEGRATION_STORAGE_ATTESTATION_INVALID", `${label} directory identity is invalid.`);
  }
  return identity;
}

function dependencyDataValue(options, dependencyName) {
  if (types.isProxy(options) || !options || typeof options !== "object" || Array.isArray(options)) {
    mountFail("INTEGRATION_CONFIG_INVALID", "Integration dependency options must be a non-proxy data object.");
  }
  const descriptor = proxySafeOwnPropertyDescriptor(options, dependencyName);
  if (!descriptor) return null;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    mountFail(
      "INTEGRATION_STORAGE_ATTESTATION_REQUIRED",
      `${dependencyName} must be injected as an explicit data property.`
    );
  }
  return descriptor.value ?? null;
}

function exactStorageAttestation(dependency, dependencyName, stateRoot) {
  if (!dependency || typeof dependency !== "object" || Array.isArray(dependency) || !Object.isFrozen(dependency)) {
    mountFail(
      "INTEGRATION_STORAGE_ATTESTATION_REQUIRED",
      `${dependencyName} must be an immutable injected dependency with an explicit storage attestation.`
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(dependency, INTEGRATION_STORAGE_ATTESTATION_PROPERTY);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    descriptor.writable !== false ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true
  ) {
    mountFail(
      "INTEGRATION_STORAGE_ATTESTATION_REQUIRED",
      `${dependencyName} does not carry an immutable own storage attestation.`
    );
  }

  const proof = descriptor.value;
  exactFrozenData(
    proof,
    STORAGE_ATTESTATION_KEYS,
    "INTEGRATION_STORAGE_ATTESTATION_INVALID",
    `${dependencyName} storage attestation is not sealed data.`
  );

  const expectedStorageRoot = INTEGRATION_STORAGE_ROOTS[dependencyName];
  const storageRoot = typeof proof.storageRoot === "string" ? proof.storageRoot : "";
  const relativeRoot = path.relative(stateRoot, storageRoot);
  if (
    proof.schemaVersion !== INTEGRATION_STORAGE_ATTESTATION_SCHEMA ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.dependency !== dependencyName ||
    proof.stateRoot !== stateRoot ||
    storageRoot !== expectedStorageRoot ||
    proof.dedicated !== true ||
    proof.symlinkFree !== true ||
    proof.immutable !== true ||
    !Number.isSafeInteger(proof.serviceUid) ||
    proof.serviceUid < 0 ||
    !Number.isSafeInteger(proof.serviceGid) ||
    proof.serviceGid < 0 ||
    !path.isAbsolute(storageRoot) ||
    path.resolve(storageRoot) !== storageRoot ||
    !relativeRoot ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot) ||
    relativeRoot.includes(path.sep) ||
    path.dirname(storageRoot) !== stateRoot
  ) {
    mountFail(
      "INTEGRATION_STORAGE_ATTESTATION_INVALID",
      `${dependencyName} storage attestation does not prove its exact dedicated canonical root.`
    );
  }
  exactDirectoryIdentity(proof.stateIdentity, `${dependencyName} state root`);
  exactDirectoryIdentity(proof.storageIdentity, `${dependencyName} storage root`);
  return proof;
}

function inspectIntegrationStorageDependencies(config, options = {}) {
  const dependencies = Object.freeze({
    runtimeAuthority: dependencyDataValue(options, "runtimeAuthority"),
    eventLedgerStore: dependencyDataValue(options, "eventLedgerStore"),
    idempotencyStore: dependencyDataValue(options, "idempotencyStore"),
  });
  const present = Object.values(dependencies).filter((dependency) => dependency !== null).length;
  if (present !== 0 && present !== 3) {
    mountFail(
      "INTEGRATION_DEPENDENCIES_INCOMPLETE",
      "Runtime authority, event ledger, and idempotency store must be injected as one complete set."
    );
  }
  const proofs = {};
  if (present === 3) {
    const roots = Object.entries(dependencies).map(([dependencyName, dependency]) => {
      const proof = exactStorageAttestation(dependency, dependencyName, config.stateRoot);
      proofs[dependencyName] = proof;
      return proof.storageRoot;
    });
    if (new Set(roots).size !== roots.length) {
      mountFail(
        "INTEGRATION_STORAGE_ATTESTATION_INVALID",
        "Injected dependencies must attest distinct dedicated storage roots."
      );
    }
  }
  return Object.freeze({
    dependencies,
    present,
    proofs: Object.freeze(proofs),
  });
}

function directoryIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: Number(stat.nlink),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
  });
}

function collectDirectoryEvidence(directoryPath) {
  let handle;
  let beforeStat = null;
  let openedStat = null;
  let afterStat = null;
  let realPathBefore = "";
  let realPathAfter = "";
  let closeFailed = false;
  try {
    beforeStat = fs.lstatSync(directoryPath, { bigint: true });
    realPathBefore = fs.realpathSync.native(directoryPath);
    handle = fs.openSync(
      directoryPath,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_CLOEXEC || 0)
    );
    openedStat = fs.fstatSync(handle, { bigint: true });
    afterStat = fs.lstatSync(directoryPath, { bigint: true });
    realPathAfter = fs.realpathSync.native(directoryPath);
  } catch {
    // The sealed evidence below remains incomplete and therefore fails closed.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed) {
    afterStat = null;
    realPathAfter = "";
  }
  return Object.freeze({
    path: directoryPath,
    exists: beforeStat !== null,
    isDirectory: beforeStat?.isDirectory() === true,
    isSymbolicLink: beforeStat?.isSymbolicLink() === true,
    realPathBefore,
    realPathAfter,
    before: beforeStat ? directoryIdentity(beforeStat) : null,
    opened: openedStat ? directoryIdentity(openedStat) : null,
    after: afterStat ? directoryIdentity(afterStat) : null,
  });
}

function currentServiceIdentity() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "The integration service identity is unavailable.");
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "The integration service identity is invalid.");
  }
  return Object.freeze({ uid, gid });
}

function collectIntegrationStorageSnapshot(config) {
  const service = currentServiceIdentity();
  const paths = Object.freeze([
    ...INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES,
    config.stateRoot,
    ...Object.values(INTEGRATION_STORAGE_ROOTS),
  ]);
  return Object.freeze({
    schemaVersion: INTEGRATION_STORAGE_SNAPSHOT_SCHEMA,
    serviceUid: service.uid,
    serviceGid: service.gid,
    directories: Object.freeze(paths.map((directoryPath) => collectDirectoryEvidence(directoryPath))),
  });
}

function sameDirectoryIdentity(left, right) {
  return DIRECTORY_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function validateDirectoryEvidence(value, expectedPath, { bootstrap, serviceUid, serviceGid }) {
  const evidence = exactFrozenData(
    value,
    DIRECTORY_EVIDENCE_KEYS,
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
    "Integration storage directory evidence is not sealed data."
  );
  if (
    evidence.path !== expectedPath ||
    evidence.exists !== true ||
    evidence.isDirectory !== true ||
    evidence.isSymbolicLink !== false ||
    evidence.realPathBefore !== expectedPath ||
    evidence.realPathAfter !== expectedPath
  ) {
    mountFail(
      "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
      "An integration storage directory is absent, non-canonical, or symlinked."
    );
  }
  const before = exactDirectoryIdentity(evidence.before, `${expectedPath} pre-open`);
  const opened = exactDirectoryIdentity(evidence.opened, `${expectedPath} opened`);
  const after = exactDirectoryIdentity(evidence.after, `${expectedPath} recheck`);
  if (!sameDirectoryIdentity(before, opened) || !sameDirectoryIdentity(opened, after)) {
    mountFail(
      "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
      "An integration storage directory was replaced while its identity was verified."
    );
  }
  if (bootstrap) {
    if (
      before.uid !== 0 ||
      before.gid !== 0 ||
      (before.mode & 0o7000) !== 0 ||
      (before.mode & 0o500) !== 0o500 ||
      (before.mode & 0o022) !== 0
    ) {
      mountFail(
        "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
        "Integration storage bootstrap prefixes must be root-owned and non-writable by group or other."
      );
    }
  } else if (before.uid !== serviceUid || before.gid !== serviceGid || before.mode !== 0o700) {
    mountFail(
      "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
      "Integration state directories must be owned by the service identity with mode 0700."
    );
  }
  return before;
}

function validateStorageSnapshotWithInspection(config, inspection, snapshotInput) {
  const snapshot = exactFrozenData(
    snapshotInput,
    STORAGE_SNAPSHOT_KEYS,
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID",
    "Integration storage filesystem evidence is not sealed data."
  );
  if (
    snapshot.schemaVersion !== INTEGRATION_STORAGE_SNAPSHOT_SCHEMA ||
    !Number.isSafeInteger(snapshot.serviceUid) ||
    snapshot.serviceUid < 0 ||
    !Number.isSafeInteger(snapshot.serviceGid) ||
    snapshot.serviceGid < 0 ||
    !Array.isArray(snapshot.directories) ||
    !Object.isFrozen(snapshot.directories)
  ) {
    mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "Integration storage filesystem evidence is invalid.");
  }
  const expectedPaths = [
    ...INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES,
    config.stateRoot,
    ...Object.values(INTEGRATION_STORAGE_ROOTS),
  ];
  if (snapshot.directories.length !== expectedPaths.length) {
    mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "Integration storage filesystem evidence is incomplete.");
  }
  const directoryMap = new Map();
  for (const evidence of snapshot.directories) {
    const descriptor = Object.getOwnPropertyDescriptor(evidence || {}, "path");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "Integration storage path evidence is invalid.");
    }
    if (!expectedPaths.includes(descriptor.value) || directoryMap.has(descriptor.value)) {
      mountFail("INTEGRATION_STORAGE_FILESYSTEM_INVALID", "Integration storage path evidence is unexpected.");
    }
    directoryMap.set(descriptor.value, evidence);
  }

  for (const bootstrapPath of INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES) {
    validateDirectoryEvidence(directoryMap.get(bootstrapPath), bootstrapPath, {
      bootstrap: true,
      serviceUid: snapshot.serviceUid,
      serviceGid: snapshot.serviceGid,
    });
  }
  const stateIdentity = validateDirectoryEvidence(directoryMap.get(config.stateRoot), config.stateRoot, {
    bootstrap: false,
    serviceUid: snapshot.serviceUid,
    serviceGid: snapshot.serviceGid,
  });
  for (const dependencyName of STORAGE_DEPENDENCY_NAMES) {
    const proof = inspection.proofs[dependencyName];
    const storageRoot = INTEGRATION_STORAGE_ROOTS[dependencyName];
    const storageIdentity = validateDirectoryEvidence(directoryMap.get(storageRoot), storageRoot, {
      bootstrap: false,
      serviceUid: snapshot.serviceUid,
      serviceGid: snapshot.serviceGid,
    });
    if (
      proof.serviceUid !== snapshot.serviceUid ||
      proof.serviceGid !== snapshot.serviceGid ||
      !sameDirectoryIdentity(proof.stateIdentity, stateIdentity) ||
      !sameDirectoryIdentity(proof.storageIdentity, storageIdentity)
    ) {
      mountFail(
        "INTEGRATION_STORAGE_ATTESTATION_INVALID",
        `${dependencyName} storage attestation does not match the live directory identity.`
      );
    }
  }
  return inspection.dependencies;
}

export function validateIntegrationStorageSnapshot(configInput, options, snapshotInput) {
  const config = validateIntegrationServiceConfig(configInput);
  const inspection = inspectIntegrationStorageDependencies(config, options);
  if (inspection.present !== 3) {
    mountFail(
      "INTEGRATION_DEPENDENCIES_INCOMPLETE",
      "A complete dependency set is required to validate storage filesystem evidence."
    );
  }
  return validateStorageSnapshotWithInspection(config, inspection, snapshotInput);
}

export function validateIntegrationStorageDependencies(configInput, options = {}) {
  const config = validateIntegrationServiceConfig(configInput);
  const inspection = inspectIntegrationStorageDependencies(config, options);
  if (inspection.present === 3) {
    validateStorageSnapshotWithInspection(config, inspection, collectIntegrationStorageSnapshot(config));
  }
  return inspection.dependencies;
}

function hardDisableSessionService() {
  return Object.freeze({
    getIntegrationCapabilities() {
      mountFail("INTEGRATION_CAPABILITY_LOCKED", "The first production mount keeps public integration disabled.");
    },
  });
}

export function integrationListenOptions(configInput) {
  const config = validateIntegrationServiceConfig(configInput);
  return Object.freeze({
    host: config.listen.host,
    port: config.listen.port,
    exclusive: true,
  });
}

export function createIntegrationApp(options = {}) {
  assertNoDisabledIntegrationDependencies(options);
  const config = validateIntegrationServiceConfig(options.config);
  const proxyClient = normalizedProxyClient(options.trustedPrincipalProxyClient);
  if (proxyClient.id !== config.trustedPrincipalProxy.clientId) {
    mountFail("INTEGRATION_AUTH_INVALID", "The trusted principal proxy client id does not match the protected config.");
  }
  const configuredScopes = JSON.stringify([...config.trustedPrincipalProxy.scopes].sort());
  const clientScopes = JSON.stringify([...proxyClient.scopes].sort());
  if (configuredScopes !== clientScopes) {
    mountFail("INTEGRATION_AUTH_INVALID", "The trusted principal proxy scopes do not match the protected config.");
  }

  const policy = buildFixedIntegrationPolicy();
  // TODO: A future enabled mount must replace this with descriptor-bound runtime,
  // event-ledger, and idempotency authorities plus fresh storage identity checks.
  const sessionService = hardDisableSessionService();
  const router = createIntegrationRouter({
    sessionService,
    idempotencyStore: null,
    policy,
    auth: { clients: [proxyClient] },
  });
  const authenticateTrustedProxy = createIntegrationAuthMiddleware({ clients: [proxyClient] });

  const app = express();
  app.disable("x-powered-by");
  app.use(createExactIntegrationRouteBoundary());
  app.use(authenticateTrustedProxy);
  app.use(createPostOnlyIntegrationBoundary());
  app.use(createHardDisabledIntegrationBoundary());
  app.use(router);
  app.use((_req, res) => writeIntegrationErrorJson(res, 404, "NOT_FOUND"));
  app.use((_error, _req, res, _next) => writeIntegrationErrorJson(res, 500, "INTERNAL_ERROR"));

  Object.defineProperty(app.locals, "integrationMount", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: publicIntegrationServiceConfig(config),
  });
  return app;
}

function verifyBoundAddress(server, config) {
  const address = server.address();
  const family = typeof address === "object" && address ? address.family : "";
  if (
    !address ||
    typeof address !== "object" ||
    address.address !== config.listen.host ||
    address.port !== config.listen.port ||
    !["IPv4", 4].includes(family)
  ) {
    mountFail("INTEGRATION_LISTEN_MISMATCH", "The integration listener did not bind the exact configured IPv4 endpoint.");
  }
  return Object.freeze({ address: address.address, port: address.port, family: "IPv4" });
}

function configureHttpServer(server) {
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}

export function createIntegrationServer(options = {}) {
  assertNoDisabledIntegrationDependencies(options);
  const config = validateIntegrationServiceConfig(options.config);
  const app = createIntegrationApp({
    config,
    trustedPrincipalProxyClient: options.trustedPrincipalProxyClient,
  });
  const server = http.createServer(app);
  configureHttpServer(server);

  let lifecycle = "created";
  let startPromise = null;
  let closePromise = null;

  async function start() {
    if (lifecycle === "closed" || lifecycle === "closing") {
      mountFail("INTEGRATION_SERVER_CLOSED", "The integration server cannot be restarted after close.");
    }
    if (server.listening) return verifyBoundAddress(server, config);
    if (startPromise) return startPromise;
    lifecycle = "starting";
    const listenOptions = integrationListenOptions(config);
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        server.closeAllConnections?.();
        server.close(() => {});
        lifecycle = "created";
        reject(new IntegrationServiceConfigError("INTEGRATION_LISTEN_TIMEOUT", "The integration listener did not start in time."));
      }, DEFAULT_INTEGRATION_START_TIMEOUT_MS);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        lifecycle = "created";
        reject(new IntegrationServiceConfigError("INTEGRATION_LISTEN_FAILED", "The exact integration listener could not start."));
      };
      const onListening = () => {
        if (settled) return;
        try {
          const bound = verifyBoundAddress(server, config);
          settled = true;
          cleanup();
          lifecycle = "listening";
          resolve(bound);
        } catch (error) {
          settled = true;
          cleanup();
          server.closeAllConnections?.();
          server.close(() => {});
          lifecycle = "created";
          reject(error);
        }
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(listenOptions);
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        lifecycle = "created";
        reject(
          error instanceof IntegrationServiceConfigError
            ? error
            : new IntegrationServiceConfigError(
                "INTEGRATION_LISTEN_FAILED",
                "The exact integration listener could not start."
              )
        );
      }
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function close({ timeoutMs = DEFAULT_INTEGRATION_CLOSE_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      mountFail("INTEGRATION_CLOSE_INVALID", "The graceful close timeout is invalid.");
    }
    if (closePromise) return closePromise;
    if (!server.listening && lifecycle !== "starting") {
      lifecycle = "closed";
      return Object.freeze({ closed: true, forced: false });
    }
    lifecycle = "closing";
    closePromise = new Promise((resolve) => {
      let settled = false;
      const finish = (forced) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifecycle = "closed";
        resolve(Object.freeze({ closed: true, forced }));
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish(true);
      }, timeoutMs);
      timer.unref?.();
      server.closeIdleConnections?.();
      server.close(() => finish(false));
    }).finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  return Object.freeze({
    app,
    server,
    config: publicIntegrationServiceConfig(config),
    start,
    close,
    get listening() {
      return server.listening;
    },
    get lifecycle() {
      return lifecycle;
    },
  });
}

export async function startIntegrationServer(options = {}) {
  const integrationServer = createIntegrationServer(options);
  await integrationServer.start();
  return integrationServer;
}
