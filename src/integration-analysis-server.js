import http from "node:http";
import { types as utilTypes } from "node:util";

import express from "express";

import { createIntegrationClient, writeIntegrationErrorJson } from "./integration-auth.js";
import {
  assertIntegrationAnalysisActivationStorage,
  createActivatedIntegrationAnalysisRouter,
  createIntegrationAnalysisRouterActivation,
} from "./integration-api.js";
import { createSystemdIntegrationAnalysisCoordinator } from "./integration-analysis-coordinator.js";
import { createIntegrationAnalysisPlanner } from "./integration-analysis-planner.js";
import { createIntegrationAnalysisSessionService } from "./integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_LISTEN_HOST,
  INTEGRATION_ANALYSIS_LISTEN_PORT,
  publicIntegrationAnalysisServiceConfig,
  validateIntegrationAnalysisServiceConfig,
} from "./integration-analysis-config.js";
import { IntegrationServiceConfigError } from "./integration-config.js";
import { createFileIntegrationIdempotencyStore } from "./integration-idempotency-store.js";
import { buildFixedIntegrationPolicy } from "./integration-policy.js";
import {
  createExactIntegrationRouteBoundary,
  createPostOnlyIntegrationBoundary,
} from "./integration-server.js";

export const INTEGRATION_ANALYSIS_SERVER_SCHEMA_VERSION = "aginti-integration-analysis-server-v1";
export const INTEGRATION_ANALYSIS_SERVER_ENABLED = true;
export const DEFAULT_INTEGRATION_ANALYSIS_START_TIMEOUT_MS = 5_000;
export const DEFAULT_INTEGRATION_ANALYSIS_CLOSE_TIMEOUT_MS = 5_000;

const IDEMPOTENCY_RECOVERY_AUTHORITY = Object.freeze({
  owner: "aginti",
  explicit: true,
  beforeDispatchRecovery: true,
  afterDispatchBeforeResultRecovery: true,
  afterResultBeforePublicResponseRecovery: true,
});

function fail(code, message) {
  throw new IntegrationServiceConfigError(code, message);
}

function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOptions(value, allowedKeys, requiredKeys, label) {
  if (!plainDataObject(value)) fail("ANALYSIS_SERVER_INVALID", `${label} must be a plain data object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("ANALYSIS_SERVER_INVALID", `${label} contains an unsupported field.`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("ANALYSIS_SERVER_INVALID", `${label}.${key} is required.`);
    }
  }
  return value;
}

function normalizeTrustedProxyClient(value, config) {
  let client;
  try {
    client = createIntegrationClient(value);
  } catch {
    fail("ANALYSIS_AUTH_INVALID", "A protected trusted principal proxy client is required.");
  }
  if (client.id !== config.trustedPrincipalProxy.clientId) {
    fail("ANALYSIS_AUTH_INVALID", "Trusted principal proxy client id does not match the fixed config.");
  }
  if (
    JSON.stringify([...client.scopes].sort()) !==
    JSON.stringify([...config.trustedPrincipalProxy.scopes].sort())
  ) {
    fail("ANALYSIS_AUTH_INVALID", "Trusted principal proxy scopes do not match the fixed config.");
  }
  return client;
}

function configureHttpServer(server) {
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}

function verifyBoundAddress(server) {
  const address = server.address();
  const family = typeof address === "object" && address ? address.family : "";
  if (
    !address ||
    typeof address !== "object" ||
    address.address !== INTEGRATION_ANALYSIS_LISTEN_HOST ||
    address.port !== INTEGRATION_ANALYSIS_LISTEN_PORT ||
    !["IPv4", 4].includes(family)
  ) {
    fail("ANALYSIS_LISTEN_MISMATCH", "Analysis integration listener did not bind its fixed IPv4 endpoint.");
  }
  return Object.freeze({ address: address.address, port: address.port, family: "IPv4" });
}

function compositionCloseTimeout(optionsValue) {
  const options = exactOptions(
    optionsValue ?? {},
    ["timeoutMs"],
    [],
    "analysis production close options"
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTEGRATION_ANALYSIS_CLOSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    fail("ANALYSIS_CLOSE_INVALID", "Analysis production close timeout is invalid.");
  }
  return timeoutMs;
}

async function closeProductionResources({ server, sessionService, coordinator, timeoutMs }) {
  const failures = [];
  let serverResult = Object.freeze({ closed: true, forced: false });

  if (server) {
    try {
      // Node stops accepting new connections as soon as close() is invoked. Wait
      // for that bounded HTTP shutdown before touching the durable run authority.
      serverResult = await server.close({ timeoutMs });
    } catch (error) {
      failures.push(error);
      server.server?.closeAllConnections?.();
      try {
        server.server?.close?.(() => {});
      } catch {
        // Continue with the durable-service drain and coordinator teardown.
      }
    }
  }

  if (sessionService) {
    try {
      await sessionService.close({ mode: "abort", timeoutMs });
    } catch (error) {
      failures.push(error);
    }
  }

  if (coordinator) {
    try {
      await coordinator.close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Analysis production resources did not close cleanly.");
  }
  return serverResult;
}

function createManagedProductionServer({ server, sessionService, coordinator, activation }) {
  let closePromise = null;

  async function close(closeOptions) {
    if (closePromise) return closePromise;
    const timeoutMs = compositionCloseTimeout(closeOptions);
    closePromise = closeProductionResources({ server, sessionService, coordinator, timeoutMs });
    return closePromise;
  }

  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_SERVER_SCHEMA_VERSION,
    app: server.app,
    server: server.server,
    config: server.config,
    activation,
    async start() {
      try {
        return await server.start();
      } catch (error) {
        try {
          await close();
        } catch {
          // Preserve the actionable listener/startup failure after exhausting
          // the ordered teardown path.
        }
        throw error;
      }
    },
    close,
    get listening() {
      return server.listening;
    },
    get lifecycle() {
      return server.lifecycle;
    },
  });
}

export function createTestOnlyIntegrationAnalysisServerLifecycle(options = {}) {
  exactOptions(
    options,
    ["server", "sessionService", "coordinator", "activation"],
    ["server", "sessionService", "coordinator", "activation"],
    "test analysis server lifecycle options"
  );
  if (
    typeof options.server?.start !== "function" ||
    typeof options.server?.close !== "function" ||
    typeof options.sessionService?.close !== "function" ||
    typeof options.coordinator?.close !== "function"
  ) {
    fail("ANALYSIS_SERVER_INVALID", "Test analysis server lifecycle dependencies are invalid.");
  }
  return createManagedProductionServer(options);
}

export function integrationAnalysisListenOptions(configInput) {
  const config = validateIntegrationAnalysisServiceConfig(configInput);
  return Object.freeze({ host: config.listen.host, port: config.listen.port, exclusive: true });
}

export function createIntegrationAnalysisApp(options = {}) {
  exactOptions(
    options,
    ["config", "trustedPrincipalProxyClient", "activation"],
    ["config", "trustedPrincipalProxyClient", "activation"],
    "analysis app options"
  );
  const config = validateIntegrationAnalysisServiceConfig(options.config);
  assertIntegrationAnalysisActivationStorage(options.activation, {
    stateRoot: config.stateRoot,
    idempotencyRoot: config.idempotencyRoot,
  });
  const client = normalizeTrustedProxyClient(options.trustedPrincipalProxyClient, config);
  const router = createActivatedIntegrationAnalysisRouter({
    activation: options.activation,
    auth: { clients: [client] },
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(createExactIntegrationRouteBoundary());
  app.use(createPostOnlyIntegrationBoundary());
  app.use(router);
  app.use((_req, res) => writeIntegrationErrorJson(res, 404, "NOT_FOUND"));
  app.use((_error, _req, res, _next) => writeIntegrationErrorJson(res, 500, "INTERNAL_ERROR"));
  Object.defineProperty(app.locals, "integrationAnalysisMount", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: publicIntegrationAnalysisServiceConfig(config),
  });
  return app;
}

export function createIntegrationAnalysisServer(options = {}) {
  exactOptions(
    options,
    ["config", "trustedPrincipalProxyClient", "activation"],
    ["config", "trustedPrincipalProxyClient", "activation"],
    "analysis server options"
  );
  const config = validateIntegrationAnalysisServiceConfig(options.config);
  const app = createIntegrationAnalysisApp(options);
  const server = http.createServer(app);
  configureHttpServer(server);
  let lifecycle = "created";
  let startPromise = null;
  let closePromise = null;

  async function start() {
    if (lifecycle === "closed" || lifecycle === "closing") {
      fail("ANALYSIS_SERVER_CLOSED", "Analysis integration server cannot restart after close.");
    }
    if (server.listening) return verifyBoundAddress(server);
    if (startPromise) return startPromise;
    lifecycle = "starting";
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
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
        reject(new IntegrationServiceConfigError("ANALYSIS_LISTEN_FAILED", "Analysis listener could not start."));
      };
      const onListening = () => {
        if (settled) return;
        try {
          const bound = verifyBoundAddress(server);
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
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        server.closeAllConnections?.();
        server.close(() => {});
        lifecycle = "created";
        reject(new IntegrationServiceConfigError("ANALYSIS_LISTEN_TIMEOUT", "Analysis listener timed out."));
      }, DEFAULT_INTEGRATION_ANALYSIS_START_TIMEOUT_MS);
      timer.unref?.();
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(integrationAnalysisListenOptions(config));
      } catch {
        onError();
      }
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function close({ timeoutMs = DEFAULT_INTEGRATION_ANALYSIS_CLOSE_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      fail("ANALYSIS_CLOSE_INVALID", "Analysis graceful close timeout is invalid.");
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
    schemaVersion: INTEGRATION_ANALYSIS_SERVER_SCHEMA_VERSION,
    app,
    server,
    config: publicIntegrationAnalysisServiceConfig(config),
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

export async function composeProductionIntegrationAnalysisServer(options = {}) {
  exactOptions(
    options,
    ["config", "trustedPrincipalProxyClient", "localModelApiKey", "groundedSearchApiKey"],
    ["config", "trustedPrincipalProxyClient", "localModelApiKey"],
    "analysis production composition options"
  );
  const config = validateIntegrationAnalysisServiceConfig(options.config);
  const searchEnabled = config.groundedSearch?.enabled === true;
  const searchCredentialPresent = Object.prototype.hasOwnProperty.call(options, "groundedSearchApiKey");
  if (searchEnabled !== searchCredentialPresent) {
    fail(
      "ANALYSIS_CREDENTIAL_INVALID",
      searchEnabled
        ? "The enabled private grounded search route requires its distinct systemd credential."
        : "A grounded search credential is forbidden while grounded search is disabled."
    );
  }
  if (searchEnabled && options.groundedSearchApiKey === options.localModelApiKey) {
    fail(
      "ANALYSIS_CREDENTIAL_INVALID",
      "Grounded search and LocalLLM model access require distinct systemd credentials."
    );
  }
  let coordinator;
  let sessionService;
  let server;
  try {
    coordinator = await createSystemdIntegrationAnalysisCoordinator();
    const planner = createIntegrationAnalysisPlanner({
      coordinator,
      localModelConfig: {
        ...config.localModel,
        apiKey: options.localModelApiKey,
      },
      ...(searchEnabled
        ? {
            groundedSearchConfig: {
              endpoint: config.groundedSearch.endpoint,
              timeoutMs: config.groundedSearch.timeoutMs,
              maximumSources: config.groundedSearch.maximumSources,
              apiKey: options.groundedSearchApiKey,
            },
          }
        : {}),
    });
    const plannerActivation = await planner.activate();
    const startupProof = plannerActivation.readinessProof;
    sessionService = createIntegrationAnalysisSessionService({
      analysisRunner: planner,
      stateRoot: config.stateRoot,
      plannerActivation,
    });
    if (typeof sessionService.recoverMutation !== "function") {
      fail(
        "ANALYSIS_MUTATION_RECOVERY_UNAVAILABLE",
        "Durable mutation receipt recovery is required before the analysis listener may start."
      );
    }
    const serviceCapabilities = await sessionService.getIntegrationCapabilities();
    const mutationRecoveryAuthority = serviceCapabilities?.mutationRecoveryAuthority;
    if (!mutationRecoveryAuthority || mutationRecoveryAuthority.atomicWithMutation !== true) {
      fail(
        "ANALYSIS_MUTATION_RECOVERY_UNAVAILABLE",
        "Durable mutation receipt authority is required before the analysis listener may start."
      );
    }
    const idempotencyStore = createFileIntegrationIdempotencyStore({
      rootDir: config.idempotencyRoot,
      recoveryAuthority: IDEMPOTENCY_RECOVERY_AUTHORITY,
      recoverPending: (record) => sessionService.recoverMutation(record),
    });
    await idempotencyStore.recoverExpiredPending();
    const policy = buildFixedIntegrationPolicy();
    const activation = await createIntegrationAnalysisRouterActivation({
      sessionService,
      idempotencyStore,
      startupProof,
      policy,
      stateRoot: config.stateRoot,
      idempotencyRoot: config.idempotencyRoot,
    });
    server = createIntegrationAnalysisServer({
      config,
      trustedPrincipalProxyClient: options.trustedPrincipalProxyClient,
      activation,
    });
    return createManagedProductionServer({
      server,
      sessionService,
      coordinator,
      activation,
    });
  } catch (error) {
    try {
      await closeProductionResources({
        server,
        sessionService,
        coordinator,
        timeoutMs: DEFAULT_INTEGRATION_ANALYSIS_CLOSE_TIMEOUT_MS,
      });
    } catch {
      // Keep the original construction failure after completing every teardown
      // stage that is still available.
    }
    throw error;
  }
}
