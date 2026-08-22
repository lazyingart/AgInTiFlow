import assert from "node:assert/strict";
import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTEGRATION_CREDENTIAL_NAME } from "../src/integration-auth.js";
import {
  DEFAULT_INTEGRATION_STATE_ROOT,
  INTEGRATION_SERVICE_CONFIG_SCHEMA,
  INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
  IntegrationServiceConfigError,
  createTrustedPrincipalProxyClient,
  loadIntegrationServiceConfig,
  loadTrustedPrincipalProxyCredential,
  validateIntegrationServiceConfig,
  validateSystemdCredentialMetadata,
} from "../src/integration-config.js";
import {
  INTEGRATION_MOUNT_CAPABILITY_ENABLED,
  INTEGRATION_STORAGE_ATTESTATION_PROPERTY,
  INTEGRATION_STORAGE_ATTESTATION_SCHEMA,
  INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES,
  INTEGRATION_STORAGE_ROOTS,
  INTEGRATION_STORAGE_SNAPSHOT_SCHEMA,
  classifyExactIntegrationRoute,
  createExactIntegrationRouteBoundary,
  createHardDisabledIntegrationBoundary,
  createIntegrationApp,
  createIntegrationServer,
  createPostOnlyIntegrationBoundary,
  integrationListenOptions,
  validateIntegrationStorageDependencies,
  validateIntegrationStorageSnapshot,
} from "../src/integration-server.js";
import { INTEGRATION_RPC_PATH_LIST, INTEGRATION_RPC_PATHS } from "../src/integration-policy.js";
import { main as integrationCliMain, parseIntegrationCliArguments } from "../src/integration-cli.js";

const TEST_TOKEN = "A".repeat(48);
const TEST_SERVICE_UID = 1000;
const TEST_SERVICE_GID = 1000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL_STORAGE_PATHS = Object.freeze([
  ...INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES,
  DEFAULT_INTEGRATION_STATE_ROOT,
  ...Object.values(INTEGRATION_STORAGE_ROOTS),
]);

function validConfig(overrides = {}) {
  return {
    schemaVersion: INTEGRATION_SERVICE_CONFIG_SCHEMA,
    capability: { enabled: false },
    listen: { host: "127.0.0.1", port: 18109 },
    stateRoot: DEFAULT_INTEGRATION_STATE_ROOT,
    trustedPrincipalProxy: {
      clientId: "lazyedge-principal-proxy",
      label: "LazyEdge trusted principal proxy",
      scopes: [...INTEGRATION_RPC_PATH_LIST],
    },
    ...overrides,
  };
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => error instanceof IntegrationServiceConfigError && error.code === code);
}

function throwsCode(action, code) {
  assert.throws(action, (error) => error instanceof IntegrationServiceConfigError && error.code === code);
}

function throwsOneOfCodes(action, codes) {
  assert.throws(
    action,
    (error) => error instanceof IntegrationServiceConfigError && codes.includes(error.code)
  );
}

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    writableEnded: false,
    headersSent: false,
    status(value) {
      this.statusCode = value;
      return this;
    },
    set(value) {
      Object.assign(this.headers, value);
      return this;
    },
    json(value) {
      this.body = value;
      this.writableEnded = true;
      return this;
    },
  };
}

function systemdCredentialMetadata(directoryOverrides = {}, credentialOverrides = {}) {
  return {
    directory: {
      kind: "directory",
      uid: 0,
      gid: 0,
      mode: 0o550,
      nlink: 2,
      size: 60,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
      ...directoryOverrides,
    },
    credential: {
      kind: "credential",
      uid: 0,
      gid: 0,
      mode: 0o440,
      nlink: 1,
      size: TEST_TOKEN.length + 1,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      ...credentialOverrides,
    },
  };
}

function directoryIdentity(directoryPath, overrides = {}) {
  const index = ALL_STORAGE_PATHS.indexOf(directoryPath) + 1;
  const bootstrap = INTEGRATION_STORAGE_BOOTSTRAP_PREFIXES.includes(directoryPath);
  return Object.freeze({
    dev: "2049",
    ino: String(10_000 + index),
    nlink: 2,
    uid: bootstrap ? 0 : TEST_SERVICE_UID,
    gid: bootstrap ? 0 : TEST_SERVICE_GID,
    mode: bootstrap ? 0o755 : 0o700,
    ...overrides,
  });
}

function directoryEvidence(directoryPath, overrides = {}) {
  const identity = directoryIdentity(directoryPath);
  return Object.freeze({
    path: directoryPath,
    exists: true,
    isDirectory: true,
    isSymbolicLink: false,
    realPathBefore: directoryPath,
    realPathAfter: directoryPath,
    before: identity,
    opened: identity,
    after: identity,
    ...overrides,
  });
}

function storageSnapshotFixture(pathOverrides = {}) {
  return Object.freeze({
    schemaVersion: INTEGRATION_STORAGE_SNAPSHOT_SCHEMA,
    serviceUid: TEST_SERVICE_UID,
    serviceGid: TEST_SERVICE_GID,
    directories: Object.freeze(
      ALL_STORAGE_PATHS.map((directoryPath) =>
        Object.prototype.hasOwnProperty.call(pathOverrides, directoryPath)
          ? pathOverrides[directoryPath]
          : directoryEvidence(directoryPath)
      )
    ),
  });
}

function storageProof(dependencyName, overrides = {}) {
  const storageRoot = INTEGRATION_STORAGE_ROOTS[dependencyName];
  return {
    schemaVersion: INTEGRATION_STORAGE_ATTESTATION_SCHEMA,
    owner: "aginti",
    authority: "aginti",
    dependency: dependencyName,
    stateRoot: DEFAULT_INTEGRATION_STATE_ROOT,
    storageRoot,
    dedicated: true,
    symlinkFree: true,
    immutable: true,
    serviceUid: TEST_SERVICE_UID,
    serviceGid: TEST_SERVICE_GID,
    stateIdentity: directoryIdentity(DEFAULT_INTEGRATION_STATE_ROOT),
    storageIdentity: directoryIdentity(storageRoot),
    ...overrides,
  };
}

function dependencyFromProof(proof, options = {}) {
  const dependency = {};
  Object.defineProperty(dependency, INTEGRATION_STORAGE_ATTESTATION_PROPERTY, {
    configurable: options.configurable === true,
    enumerable: true,
    writable: options.writable === true,
    value: options.mutableProof === true ? proof : Object.freeze(proof),
  });
  return Object.freeze(dependency);
}

function storageDependencyFixture(dependencyName, proofOverrides = {}, options = {}) {
  return dependencyFromProof(storageProof(dependencyName, proofOverrides), options);
}

function storageDependencyWithAccessor(dependencyName) {
  const proof = storageProof(dependencyName);
  const storageRoot = proof.storageRoot;
  delete proof.storageRoot;
  Object.defineProperty(proof, "storageRoot", {
    configurable: false,
    enumerable: true,
    get() {
      return storageRoot;
    },
  });
  return dependencyFromProof(proof);
}

function storageDependencySet(overrides = {}) {
  return {
    runtimeAuthority: Object.prototype.hasOwnProperty.call(overrides, "runtimeAuthority")
      ? overrides.runtimeAuthority
      : storageDependencyFixture("runtimeAuthority", overrides.runtimeProof),
    eventLedgerStore: Object.prototype.hasOwnProperty.call(overrides, "eventLedgerStore")
      ? overrides.eventLedgerStore
      : storageDependencyFixture("eventLedgerStore", overrides.eventLedgerProof),
    idempotencyStore: Object.prototype.hasOwnProperty.call(overrides, "idempotencyStore")
      ? overrides.idempotencyStore
      : storageDependencyFixture("idempotencyStore", overrides.idempotencyProof),
  };
}

function snapshotWithAccessorEvidence(directoryPath) {
  const evidence = { ...directoryEvidence(directoryPath) };
  delete evidence.path;
  Object.defineProperty(evidence, "path", {
    configurable: false,
    enumerable: true,
    get() {
      return directoryPath;
    },
  });
  return storageSnapshotFixture({ [directoryPath]: Object.freeze(evidence) });
}

function referencedRunnablePaths(packageJson) {
  const referenced = new Set();
  for (const command of Object.values(packageJson.scripts || {})) {
    for (const match of command.matchAll(
      /(?:^|\s)(?:(?:node)\s+)?((?:bin|scripts)\/[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs|sh))(?=\s|$)/gu
    )) {
      referenced.add(match[1]);
    }
  }
  return [...referenced].sort();
}

function trappedDependency(label) {
  let traps = 0;
  const target = Object.freeze({});
  const proxy = new Proxy(target, {
    get() {
      traps += 1;
      throw new Error(`${label} get trap fired`);
    },
    getOwnPropertyDescriptor() {
      traps += 1;
      throw new Error(`${label} descriptor trap fired`);
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error(`${label} prototype trap fired`);
    },
    ownKeys() {
      traps += 1;
      throw new Error(`${label} ownKeys trap fired`);
    },
  });
  return Object.freeze({
    proxy,
    trapCount() {
      return traps;
    },
  });
}

function trappedOptionsProxy(target, label, { hideDependency = false } = {}) {
  let traps = 0;
  const proxy = new Proxy(target, {
    get() {
      traps += 1;
      throw new Error(`${label} get trap fired`);
    },
    getOwnPropertyDescriptor(currentTarget, propertyName) {
      traps += 1;
      if (hideDependency && propertyName === "runtimeAuthority") return undefined;
      return Reflect.getOwnPropertyDescriptor(currentTarget, propertyName);
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error(`${label} prototype trap fired`);
    },
    ownKeys() {
      traps += 1;
      throw new Error(`${label} ownKeys trap fired`);
    },
  });
  return Object.freeze({
    proxy,
    trapCount() {
      return traps;
    },
  });
}

function fakeCredentialStat({ directory }) {
  const size = directory ? 60 : TEST_TOKEN.length + 1;
  return Object.freeze({
    dev: 91,
    ino: directory ? 10_001 : 10_002,
    uid: 0,
    gid: 0,
    mode: directory ? 0o40550 : 0o100440,
    nlink: directory ? 2 : 1,
    size,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
    isDirectory() {
      return directory;
    },
    isFile() {
      return !directory;
    },
    isSymbolicLink() {
      return false;
    },
  });
}

async function withCanonicalCredentialFixture(action) {
  const directory = INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY;
  const credentialPath = path.join(directory, DEFAULT_INTEGRATION_CREDENTIAL_NAME);
  const directoryStat = fakeCredentialStat({ directory: true });
  const credentialStat = fakeCredentialStat({ directory: false });
  const originals = {
    realpath: fs.realpath,
    lstat: fs.lstat,
    open: fs.open,
  };
  fs.realpath = async (filePath, ...args) => {
    if (filePath === directory || filePath === credentialPath) return filePath;
    return await originals.realpath(filePath, ...args);
  };
  fs.lstat = async (filePath, ...args) => {
    if (filePath === directory) return directoryStat;
    if (filePath === credentialPath) return credentialStat;
    return await originals.lstat(filePath, ...args);
  };
  fs.open = async (filePath, ...args) => {
    if (filePath !== credentialPath) return await originals.open(filePath, ...args);
    return Object.freeze({
      async stat() {
        return credentialStat;
      },
      async readFile(encoding) {
        assert.equal(encoding, "utf8");
        return `${TEST_TOKEN}\n`;
      },
      async close() {},
    });
  };
  try {
    return await action();
  } finally {
    fs.realpath = originals.realpath;
    fs.lstat = originals.lstat;
    fs.open = originals.open;
  }
}

function withStorageFilesystemForbidden(action) {
  const originals = {
    lstatSync: fsSync.lstatSync,
    openSync: fsSync.openSync,
    fstatSync: fsSync.fstatSync,
    realpathNative: fsSync.realpathSync.native,
  };
  let storageTouches = 0;
  const failStorageTouch = () => {
    storageTouches += 1;
    throw new Error("integration storage filesystem was touched");
  };
  fsSync.lstatSync = failStorageTouch;
  fsSync.openSync = failStorageTouch;
  fsSync.fstatSync = failStorageTouch;
  fsSync.realpathSync.native = failStorageTouch;
  const finish = () => {
    fsSync.lstatSync = originals.lstatSync;
    fsSync.openSync = originals.openSync;
    fsSync.fstatSync = originals.fstatSync;
    fsSync.realpathSync.native = originals.realpathNative;
    assert.equal(storageTouches, 0);
  };
  try {
    const result = action();
    if (result && typeof result.then === "function") {
      return result.finally(finish);
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

function withStorageFilesystemAndListenForbidden(action) {
  const originalCreateServer = http.createServer;
  let listenerCreated = 0;
  http.createServer = () => {
    listenerCreated += 1;
    throw new Error("integration HTTP server was constructed");
  };
  try {
    return withStorageFilesystemForbidden(() => {
      const result = action();
      assert.equal(listenerCreated, 0);
      return result;
    });
  } finally {
    http.createServer = originalCreateServer;
  }
}

function disabledDependencyOptions(config, proxyClient, defineDependency) {
  const options = { config, trustedPrincipalProxyClient: proxyClient };
  defineDependency(options);
  return options;
}

function assertDisabledDependencyRejected(config, proxyClient, defineDependency, trapCounters = []) {
  withStorageFilesystemAndListenForbidden(() => {
    throwsCode(
      () => createIntegrationServer(disabledDependencyOptions(config, proxyClient, defineDependency)),
      "INTEGRATION_DISABLED_DEPENDENCY_REJECTED"
    );
    throwsCode(
      () => createIntegrationApp(disabledDependencyOptions(config, proxyClient, defineDependency)),
      "INTEGRATION_DISABLED_DEPENDENCY_REJECTED"
    );
  });
  for (const trapCount of trapCounters) {
    assert.equal(trapCount(), 0);
  }
}

function assertUnsafeOptionsRejected(options, trapCounters = []) {
  withStorageFilesystemAndListenForbidden(() => {
    throwsCode(() => createIntegrationServer(options), "INTEGRATION_CONFIG_INVALID");
    throwsCode(() => createIntegrationApp(options), "INTEGRATION_CONFIG_INVALID");
  });
  for (const trapCount of trapCounters) assert.equal(trapCount(), 0);
}

function dependencyAccessor(label) {
  return {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`${label} accessor was invoked`);
    },
    set() {
      throw new Error(`${label} setter was invoked`);
    },
  };
}

async function unusedLoopbackPort() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function postJson(port, pathname, body) {
  const requestBody = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
          "x-aginti-principal-id": "principal-id-0001",
          "x-aginti-browser-session-id": "a".repeat(64),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode,
            body: text ? JSON.parse(text) : null,
          });
        });
      }
    );
    req.once("error", reject);
    req.end(requestBody);
  });
}

async function verifyPackagedBinAndScriptClosure() {
  const [packageText, binText, binStat] = await Promise.all([
    fs.readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    fs.readFile(path.join(REPOSITORY_ROOT, "bin/aginti-integration.js"), "utf8"),
    fs.stat(path.join(REPOSITORY_ROOT, "bin/aginti-integration.js")),
  ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.bin?.["aginti-integration"], "bin/aginti-integration.js");
  assert.equal(packageJson.files.includes("bin/"), true);
  for (const requiredFile of [
    "scripts/check-js-syntax.js",
    "scripts/eval-provider-attribution.js",
    "scripts/smoke-context-budget-recovery.js",
    "scripts/smoke-integration-production-mount.js",
  ]) {
    assert.equal(packageJson.files.includes(requiredFile), true);
  }
  assert.equal(
    packageJson.scripts?.["smoke:integration-production-mount"],
    "node scripts/smoke-integration-production-mount.js"
  );
  assert.equal(packageJson.scripts.check, "node scripts/check-js-syntax.js");
  for (const relativePath of referencedRunnablePaths(packageJson)) {
    const stat = await fs.stat(path.join(REPOSITORY_ROOT, relativePath));
    assert.equal(stat.isFile(), true, `packaged script reference is missing: ${relativePath}`);
  }
  assert.equal(binText.startsWith("#!/usr/bin/env node\n"), true);
  assert.notEqual(binStat.mode & 0o111, 0);
}

async function main() {
  const config = validateIntegrationServiceConfig(validConfig());
  assert.equal(INTEGRATION_MOUNT_CAPABILITY_ENABLED, false);
  assert.equal(
    INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
    "/run/credentials/agintiflow-integration.service"
  );
  assert.deepEqual(integrationListenOptions(config), {
    host: "127.0.0.1",
    port: 18109,
    exclusive: true,
  });

  for (const listen of [
    { host: "0.0.0.0", port: 18109 },
    { host: "::", port: 18109 },
    { host: "::1", port: 18109 },
    { host: "localhost", port: 18109 },
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: -1 },
    { host: "127.0.0.1", port: 1.5 },
  ]) {
    throwsCode(() => validateIntegrationServiceConfig(validConfig({ listen })), "INTEGRATION_LISTEN_INVALID");
  }
  throwsCode(
    () => validateIntegrationServiceConfig(validConfig({ capability: { enabled: true } })),
    "INTEGRATION_CAPABILITY_LOCKED"
  );
  throwsCode(
    () => validateIntegrationServiceConfig(validConfig({ stateRoot: "/home/example/.agintiflow" })),
    "INTEGRATION_CONFIG_INVALID"
  );
  throwsCode(
    () => validateIntegrationServiceConfig({ ...validConfig(), bearerToken: TEST_TOKEN }),
    "INTEGRATION_CONFIG_INVALID"
  );
  throwsCode(() => parseIntegrationCliArguments(["serve", "--token", TEST_TOKEN]), "INTEGRATION_CLI_INVALID");
  throwsCode(
    () => parseIntegrationCliArguments(["serve", "--config", "relative.json"]),
    "INTEGRATION_CLI_INVALID"
  );

  const rejectedCliDependency = trappedDependency("CLI dependencies");
  for (const dependencies of [undefined, null, {}, rejectedCliDependency.proxy]) {
    await withStorageFilesystemForbidden(() =>
      rejectsCode(
        () =>
          integrationCliMain(["serve", "--config", "/nonexistent/aginti-integration.json"], {
            dependencies,
          }),
        "INTEGRATION_DISABLED_DEPENDENCY_REJECTED"
      )
    );
  }
  assert.equal(rejectedCliDependency.trapCount(), 0);

  const accessorCliOptions = {};
  Object.defineProperty(accessorCliOptions, "dependencies", dependencyAccessor("CLI dependencies"));
  await rejectsCode(
    () => integrationCliMain(["serve", "--config", "/nonexistent/aginti-integration.json"], accessorCliOptions),
    "INTEGRATION_DISABLED_DEPENDENCY_REJECTED"
  );

  const inheritedCliDependencies = Object.create({ dependencies: null });
  await rejectsCode(
    () =>
      integrationCliMain(["serve", "--config", "/nonexistent/aginti-integration.json"], inheritedCliDependencies),
    "INTEGRATION_DISABLED_DEPENDENCY_REJECTED"
  );
  throwsCode(
    () =>
      validateIntegrationServiceConfig(
        validConfig({
          trustedPrincipalProxy: {
            clientId: "lazyedge-principal-proxy",
            label: "LazyEdge trusted principal proxy",
            scopes: ["*"],
          },
        })
      ),
    "INTEGRATION_CONFIG_INVALID"
  );

  assert.deepEqual(classifyExactIntegrationRoute("POST", INTEGRATION_RPC_PATHS.capabilities), {
    allowed: true,
    status: 0,
    code: "",
    pathname: INTEGRATION_RPC_PATHS.capabilities,
  });
  for (const target of [
    "/agent/v1/capabilities/",
    "/agent/v1/capabilities?probe=1",
    "/agent/v1/%63apabilities",
    "/agent/v1/unknown",
    "//agent/v1/capabilities",
  ]) {
    assert.equal(classifyExactIntegrationRoute("POST", target).code, "NOT_FOUND");
  }
  assert.equal(classifyExactIntegrationRoute("GET", INTEGRATION_RPC_PATHS.capabilities).code, "METHOD_NOT_ALLOWED");

  const routeResponse = responseRecorder();
  let routeNext = false;
  createExactIntegrationRouteBoundary()(
    { method: "POST", originalUrl: "/agent/v1/capabilities?probe=1" },
    routeResponse,
    () => {
      routeNext = true;
    }
  );
  assert.equal(routeNext, false);
  assert.equal(routeResponse.statusCode, 404);

  let allowedRouteNext = false;
  createExactIntegrationRouteBoundary()(
    { method: "POST", originalUrl: INTEGRATION_RPC_PATHS.capabilities },
    responseRecorder(),
    () => {
      allowedRouteNext = true;
    }
  );
  assert.equal(allowedRouteNext, true);

  const methodResponse = responseRecorder();
  let methodNext = false;
  createPostOnlyIntegrationBoundary()(
    { method: "GET", originalUrl: INTEGRATION_RPC_PATHS.capabilities },
    methodResponse,
    () => {
      methodNext = true;
    }
  );
  assert.equal(methodNext, false);
  assert.equal(methodResponse.statusCode, 405);

  const disabledResponse = responseRecorder();
  let disabledNext = false;
  createHardDisabledIntegrationBoundary()(
    { method: "POST", originalUrl: INTEGRATION_RPC_PATHS.runsStart },
    disabledResponse,
    () => {
      disabledNext = true;
    }
  );
  assert.equal(disabledNext, false);
  assert.equal(disabledResponse.statusCode, 503);
  assert.deepEqual(disabledResponse.body, { error: { code: "AGENT_UNAVAILABLE" } });

  const capabilityResponse = responseRecorder();
  let capabilityNext = false;
  createHardDisabledIntegrationBoundary()(
    { method: "POST", originalUrl: INTEGRATION_RPC_PATHS.capabilities },
    capabilityResponse,
    () => {
      capabilityNext = true;
    }
  );
  assert.equal(capabilityNext, true);

  const proxyClient = createTrustedPrincipalProxyClient(config, TEST_TOKEN);
  const integrationServer = createIntegrationServer({ config, trustedPrincipalProxyClient: proxyClient });
  assert.equal(integrationServer.listening, false);
  assert.equal(integrationServer.lifecycle, "created");
  assert.equal(integrationServer.server.address(), null);
  assert.deepEqual(await integrationServer.close(), { closed: true, forced: false });

  const directOptionsProxy = trappedOptionsProxy(
    { config, trustedPrincipalProxyClient: proxyClient },
    "integration options"
  );
  assertUnsafeOptionsRejected(directOptionsProxy.proxy, [directOptionsProxy.trapCount]);

  const hidingTarget = { config, trustedPrincipalProxyClient: proxyClient };
  Object.defineProperty(hidingTarget, "runtimeAuthority", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: undefined,
  });
  const hidingOptionsProxy = trappedOptionsProxy(hidingTarget, "dependency-hiding options", {
    hideDependency: true,
  });
  assertUnsafeOptionsRejected(hidingOptionsProxy.proxy, [hidingOptionsProxy.trapCount]);

  const proxyPrototype = trappedOptionsProxy({}, "integration options prototype");
  const proxyPrototypeOptions = Object.create(proxyPrototype.proxy);
  Object.defineProperties(proxyPrototypeOptions, {
    config: { configurable: true, enumerable: true, writable: true, value: config },
    trustedPrincipalProxyClient: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: proxyClient,
    },
  });
  assertUnsafeOptionsRejected(proxyPrototypeOptions, [proxyPrototype.trapCount]);

  const trappedRuntimeAuthority = trappedDependency("runtimeAuthority");
  assertDisabledDependencyRejected(
    config,
    proxyClient,
    (options) => {
      options.runtimeAuthority = {};
    }
  );
  assertDisabledDependencyRejected(
    config,
    proxyClient,
    (options) => {
      options.runtimeAuthority = trappedRuntimeAuthority.proxy;
    },
    [trappedRuntimeAuthority.trapCount]
  );
  assertDisabledDependencyRejected(config, proxyClient, (options) => {
    Object.defineProperty(options, "runtimeAuthority", dependencyAccessor("runtimeAuthority"));
  });
  assertDisabledDependencyRejected(config, proxyClient, (options) => {
    Object.defineProperty(options, "idempotencyStore", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {},
    });
  });
  const inheritedDependencyPrototype = {};
  Object.defineProperty(inheritedDependencyPrototype, "eventLedgerStore", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {},
  });
  assertUnsafeOptionsRejected(
    Object.assign(Object.create(inheritedDependencyPrototype), {
      config,
      trustedPrincipalProxyClient: proxyClient,
    })
  );
  assertDisabledDependencyRejected(config, proxyClient, (options) => {
    options.eventLedgerStore = {};
  });
  assertDisabledDependencyRejected(config, proxyClient, (options) => {
    options.runtimeAuthority = null;
    options.eventLedgerStore = null;
    options.idempotencyStore = null;
  });

  Object.defineProperty(Object.prototype, "idempotencyStore", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: undefined,
  });
  try {
    assertDisabledDependencyRejected(config, proxyClient, () => {});
  } finally {
    delete Object.prototype.idempotencyStore;
  }

  const startPort = await unusedLoopbackPort();
  const startConfig = validateIntegrationServiceConfig(validConfig({ listen: { host: "127.0.0.1", port: startPort } }));
  const startProxyClient = createTrustedPrincipalProxyClient(startConfig, TEST_TOKEN);
  await withStorageFilesystemForbidden(async () => {
    const noDependencyServer = createIntegrationServer({
      config: startConfig,
      trustedPrincipalProxyClient: startProxyClient,
    });
    try {
      assert.equal(noDependencyServer.listening, false);
      assert.deepEqual(await noDependencyServer.start(), {
        address: "127.0.0.1",
        port: startPort,
        family: "IPv4",
      });
      assert.equal(noDependencyServer.listening, true);
      const response = await postJson(startPort, INTEGRATION_RPC_PATHS.capabilities, {});
      assert.equal(response.statusCode, 200);
      assert.equal(response.body?.schemaVersion, "1");
      assert.equal(response.body?.enabled, false);
    } finally {
      await noDependencyServer.close();
    }
  });

  throwsCode(
    () => validateIntegrationStorageDependencies(config, { runtimeAuthority: {} }),
    "INTEGRATION_DEPENDENCIES_INCOMPLETE"
  );
  const assertedStringsOnly = Object.freeze({
    stateRoot: DEFAULT_INTEGRATION_STATE_ROOT,
    storageRoot: INTEGRATION_STORAGE_ROOTS.runtimeAuthority,
  });
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(config, {
        runtimeAuthority: assertedStringsOnly,
        eventLedgerStore: assertedStringsOnly,
        idempotencyStore: assertedStringsOnly,
      }),
    "INTEGRATION_STORAGE_ATTESTATION_REQUIRED"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(
        config,
        storageDependencySet({
          runtimeAuthority: storageDependencyFixture("runtimeAuthority", {}, { mutableProof: true }),
        })
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(
        config,
        storageDependencySet({ runtimeProof: { stateRoot: "/var/lib/agintiflow-integration-forged" } })
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(
        config,
        storageDependencySet({
          eventLedgerProof: {
            storageRoot: INTEGRATION_STORAGE_ROOTS.runtimeAuthority,
            storageIdentity: directoryIdentity(INTEGRATION_STORAGE_ROOTS.runtimeAuthority),
          },
        })
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(
        config,
        storageDependencySet({
          runtimeProof: {
            storageRoot: "/tmp/runtime",
            storageIdentity: directoryIdentity(INTEGRATION_STORAGE_ROOTS.runtimeAuthority),
          },
        })
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(config, storageDependencySet({ runtimeProof: { symlinkFree: false } })),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageDependencies(
        config,
        storageDependencySet({ runtimeAuthority: storageDependencyWithAccessor("runtimeAuthority") })
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );

  const dependencyAccessorSet = storageDependencySet();
  Object.defineProperty(dependencyAccessorSet, "runtimeAuthority", {
    configurable: true,
    enumerable: true,
    get() {
      return storageDependencyFixture("runtimeAuthority");
    },
  });
  throwsCode(
    () => validateIntegrationStorageDependencies(config, dependencyAccessorSet),
    "INTEGRATION_STORAGE_ATTESTATION_REQUIRED"
  );

  const structurallyValidDependencies = storageDependencySet();
  throwsOneOfCodes(
    () => validateIntegrationStorageDependencies(config, structurallyValidDependencies),
    ["INTEGRATION_STORAGE_FILESYSTEM_INVALID", "INTEGRATION_STORAGE_ATTESTATION_INVALID"]
  );
  assert.deepEqual(
    validateIntegrationStorageSnapshot(config, structurallyValidDependencies, storageSnapshotFixture()),
    structurallyValidDependencies
  );
  const replacementPath = INTEGRATION_STORAGE_ROOTS.runtimeAuthority;
  throwsCode(
    () =>
      validateIntegrationStorageSnapshot(
        config,
        structurallyValidDependencies,
        storageSnapshotFixture({
          [replacementPath]: directoryEvidence(replacementPath, {
            after: directoryIdentity(replacementPath, { ino: "999999" }),
          }),
        })
      ),
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID"
  );
  const symlinkPrefix = "/var/lib";
  throwsCode(
    () =>
      validateIntegrationStorageSnapshot(
        config,
        structurallyValidDependencies,
        storageSnapshotFixture({
          [symlinkPrefix]: directoryEvidence(symlinkPrefix, {
            isDirectory: false,
            isSymbolicLink: true,
            realPathBefore: "/private/var/lib",
            realPathAfter: "/private/var/lib",
          }),
        })
      ),
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID"
  );
  const absentPath = INTEGRATION_STORAGE_ROOTS.idempotencyStore;
  throwsCode(
    () =>
      validateIntegrationStorageSnapshot(
        config,
        structurallyValidDependencies,
        storageSnapshotFixture({
          [absentPath]: Object.freeze({
            path: absentPath,
            exists: false,
            isDirectory: false,
            isSymbolicLink: false,
            realPathBefore: "",
            realPathAfter: "",
            before: null,
            opened: null,
            after: null,
          }),
        })
      ),
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageSnapshot(
        config,
        structurallyValidDependencies,
        snapshotWithAccessorEvidence(DEFAULT_INTEGRATION_STATE_ROOT)
      ),
    "INTEGRATION_STORAGE_FILESYSTEM_INVALID"
  );
  throwsCode(
    () =>
      validateIntegrationStorageSnapshot(
        config,
        storageDependencySet({
          runtimeProof: {
            storageIdentity: directoryIdentity(INTEGRATION_STORAGE_ROOTS.runtimeAuthority, { ino: "888888" }),
          },
        }),
        storageSnapshotFixture()
      ),
    "INTEGRATION_STORAGE_ATTESTATION_INVALID"
  );

  assert.equal(validateSystemdCredentialMetadata(systemdCredentialMetadata()), true);
  assert.equal(
    validateSystemdCredentialMetadata(systemdCredentialMetadata({ mode: 0o500 }, { mode: 0o400 })),
    true
  );
  for (const metadata of [
    systemdCredentialMetadata({ gid: 1000 }),
    systemdCredentialMetadata({}, { gid: 1000 }),
    systemdCredentialMetadata({ mode: 0o750 }),
    systemdCredentialMetadata({}, { mode: 0o640 }),
    systemdCredentialMetadata({}, { nlink: 2 }),
    systemdCredentialMetadata({ isSymbolicLink: true }),
    systemdCredentialMetadata({}, { isSymbolicLink: true }),
  ]) {
    throwsCode(() => validateSystemdCredentialMetadata(metadata), "INTEGRATION_CREDENTIALS_INVALID");
  }
  await rejectsCode(
    () => loadTrustedPrincipalProxyCredential({ credentialsDirectory: "/tmp/forbidden" }),
    "INTEGRATION_CREDENTIAL_SOURCE_FORBIDDEN"
  );

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-integration-mount-"));
  try {
    await fs.chmod(tempRoot, 0o700);
    const configPath = path.join(tempRoot, "integration.json");
    await fs.writeFile(configPath, `${JSON.stringify(validConfig())}\n`, { mode: 0o600 });
    assert.deepEqual(await loadIntegrationServiceConfig(configPath), config);
    await rejectsCode(
      () => loadIntegrationServiceConfig("relative-integration.json"),
      "INTEGRATION_PROTECTED_FILE_INVALID"
    );

    await fs.chmod(configPath, 0o644);
    await rejectsCode(() => loadIntegrationServiceConfig(configPath), "INTEGRATION_PROTECTED_FILE_INVALID");
    await fs.chmod(configPath, 0o600);

    const configLink = path.join(tempRoot, "integration-link.json");
    await fs.symlink(configPath, configLink);
    await rejectsCode(() => loadIntegrationServiceConfig(configLink), "INTEGRATION_PROTECTED_FILE_INVALID");

    await rejectsCode(
      () =>
        integrationCliMain(["check", "--config", configPath], {
          env: { CREDENTIALS_DIRECTORY: "/tmp/forbidden" },
          stdout: { write() {} },
        }),
      "INTEGRATION_CREDENTIALS_INVALID"
    );
    await rejectsCode(
      () =>
        integrationCliMain(["check", "--config", configPath], {
          env: { CREDENTIALS_DIRECTORY: INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY },
          stdout: { write() {} },
          credentialReader: () => TEST_TOKEN,
        }),
      "INTEGRATION_CLI_INVALID"
    );
    await rejectsCode(
      () =>
        integrationCliMain(["check", "--config", configPath], {
          env: {
            CREDENTIALS_DIRECTORY: INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
            AGINTI_INTEGRATION_TOKEN: TEST_TOKEN,
          },
          stdout: { write() {} },
        }),
      "INTEGRATION_CREDENTIAL_SOURCE_FORBIDDEN"
    );

    const cliServePort = await unusedLoopbackPort();
    const cliServeConfigPath = path.join(tempRoot, "integration-serve.json");
    await fs.writeFile(
      cliServeConfigPath,
      `${JSON.stringify(validConfig({ listen: { host: "127.0.0.1", port: cliServePort } }))}\n`,
      { mode: 0o600 }
    );
    let cliOutput = "";
    await withCanonicalCredentialFixture(async () => {
      await withStorageFilesystemForbidden(async () => {
        const cliServer = await integrationCliMain(["serve", "--config", cliServeConfigPath], {
          env: { CREDENTIALS_DIRECTORY: INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY },
          stdout: { write(chunk) { cliOutput += String(chunk); } },
          waitForSignal: false,
        });
        try {
          assert.equal(cliServer.listening, true);
          const response = await postJson(cliServePort, INTEGRATION_RPC_PATHS.capabilities, {});
          assert.equal(response.statusCode, 200);
          assert.equal(response.body?.enabled, false);
          const summary = JSON.parse(cliOutput.trim());
          assert.equal(summary.status, "listening-disabled");
          assert.equal(summary.capability?.enabled, false);
        } finally {
          await cliServer.close();
        }
        assert.equal(cliServer.listening, false);
        assert.equal(cliServer.lifecycle, "closed");
        assert.equal(cliServer.server.address(), null);
      });
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  await verifyPackagedBinAndScriptClosure();
  process.stdout.write("integration production mount smoke: ok\n");
}

main().catch((error) => {
  process.stderr.write(`integration production mount smoke: failed (${String(error?.code || error?.name || "ERROR")})\n`);
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exitCode = 1;
});
