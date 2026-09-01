import path from "node:path";
import { types } from "node:util";
import {
  DEFAULT_INTEGRATION_CONFIG_PATH,
  INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
  IntegrationServiceConfigError,
  createTrustedPrincipalProxyClient,
  loadIntegrationServiceConfig,
  loadTrustedPrincipalProxyCredential,
  publicIntegrationServiceConfig,
} from "./integration-config.js";
import { checkIntegrationProductionRuntimeBundle } from "./integration-production-runtime-bundle.js";
import { createIntegrationServer } from "./integration-server.js";

const FORBIDDEN_SECRET_ENVIRONMENT = Object.freeze([
  "AGINTI_INTEGRATION_BEARER_TOKEN",
  "AGINTI_INTEGRATION_TOKEN",
  "AGINTI_INTEGRATION_BEARER_TOKEN_FILE",
  "AGINTI_INTEGRATION_TOKEN_FILE",
  "AGINTI_LOCALLLM_API_KEY",
  "LOCALLLM_API_KEY",
  "LOCAL_LLM_API_KEY",
]);
const MAIN_OPTION_KEYS = Object.freeze([
  "dependencies",
  "env",
  "filePolicy",
  "processLike",
  "stdout",
  "waitForSignal",
]);
const FILE_POLICY_KEYS = Object.freeze(["allowRootOwner", "ownerUid"]);

function cliFail(code, message) {
  throw new IntegrationServiceConfigError(code, message);
}

function assertNoDisabledCliDependencies(options) {
  if (!options || (typeof options !== "object" && typeof options !== "function")) return;
  let cursor = options;
  let depth = 0;
  while (cursor) {
    if (types.isProxy(cursor)) {
      cliFail("INTEGRATION_CLI_INVALID", "Integration CLI options must not be a Proxy.");
    }
    if (Object.getOwnPropertyDescriptor(cursor, "dependencies")) {
      cliFail(
        "INTEGRATION_DISABLED_DEPENDENCY_REJECTED",
        "Disabled integration serve must not receive dependencies; enabled wiring requires descriptor-bound storage authority."
      );
    }
    cursor = Object.getPrototypeOf(cursor);
    depth += 1;
    if (depth > 32) {
      cliFail("INTEGRATION_CLI_INVALID", "Integration CLI options prototype chain is too deep.");
    }
  }
}

function assertPlainDataOptions(value, allowedKeys, label) {
  if (types.isProxy(value) || !value || typeof value !== "object" || Array.isArray(value)) {
    cliFail("INTEGRATION_CLI_INVALID", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    cliFail("INTEGRATION_CLI_INVALID", `${label} must be a plain data object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowedKeys.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      cliFail("INTEGRATION_CLI_INVALID", `${label} contains an unsupported option.`);
    }
  }
  return value;
}

export function parseIntegrationCliArguments(argv = []) {
  if (!Array.isArray(argv)) cliFail("INTEGRATION_CLI_INVALID", "Integration CLI arguments are invalid.");
  const args = [...argv].map((value) => String(value));
  const command = args.shift() || "";
  if (!new Set(["serve", "check", "doctor"]).has(command)) {
    cliFail("INTEGRATION_CLI_INVALID", "Usage: aginti-integration serve|check --config /absolute/path.json");
  }
  let configPath = DEFAULT_INTEGRATION_CONFIG_PATH;
  let configSeen = false;
  while (args.length) {
    const flag = args.shift();
    if (flag !== "--config" || configSeen || args.length < 1) {
      cliFail("INTEGRATION_CLI_INVALID", "Only one --config /absolute/path.json argument is accepted.");
    }
    configSeen = true;
    configPath = args.shift();
  }
  if (!path.isAbsolute(configPath)) {
    cliFail("INTEGRATION_CLI_INVALID", "The integration config path must be absolute.");
  }
  return Object.freeze({ command: command === "doctor" ? "check" : command, configPath });
}

function assertNoSecretEnvironment(env = {}) {
  for (const name of FORBIDDEN_SECRET_ENVIRONMENT) {
    if (String(env?.[name] || "").trim()) {
      cliFail(
        "INTEGRATION_CREDENTIAL_SOURCE_FORBIDDEN",
        "Integration credentials must come only from systemd LoadCredential files."
      );
    }
  }
  const credentialsDirectory = String(env?.CREDENTIALS_DIRECTORY || "").trim();
  if (credentialsDirectory !== INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY) {
    cliFail(
      "INTEGRATION_CREDENTIALS_INVALID",
      `CREDENTIALS_DIRECTORY must be exactly ${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}.`
    );
  }
  return credentialsDirectory;
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function safeServiceSummary(config, status, runtimeBundle = null) {
  const publicConfig = publicIntegrationServiceConfig(config);
  return Object.freeze({
    ok: true,
    status,
    schemaVersion: publicConfig.schemaVersion,
    capability: publicConfig.capability,
    listen: publicConfig.listen,
    stateRoot: publicConfig.stateRoot,
    trustedPrincipalProxy: publicConfig.trustedPrincipalProxy,
    ...(runtimeBundle
      ? {
          implementationReady: runtimeBundle.implementationReady === true,
          runtimeBundle,
        }
      : {}),
  });
}

function createShutdownSignalWaiter(processLike) {
  let onSignal;
  const promise = new Promise((resolve) => {
    onSignal = (signal) => resolve(signal);
    processLike.once("SIGINT", onSignal);
    processLike.once("SIGTERM", onSignal);
  });
  return Object.freeze({
    promise,
    dispose() {
      processLike.removeListener?.("SIGINT", onSignal);
      processLike.removeListener?.("SIGTERM", onSignal);
    },
  });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  assertNoDisabledCliDependencies(options);
  assertPlainDataOptions(options, MAIN_OPTION_KEYS, "Integration CLI options");
  if (options.filePolicy !== undefined) {
    assertPlainDataOptions(options.filePolicy, FILE_POLICY_KEYS, "Integration config file policy");
  }
  const parsed = parseIntegrationCliArguments(argv);
  const env = options.env || process.env;
  assertNoSecretEnvironment(env);

  const config = await loadIntegrationServiceConfig(parsed.configPath, options.filePolicy || {});
  const bearerToken = await loadTrustedPrincipalProxyCredential();
  const trustedPrincipalProxyClient = createTrustedPrincipalProxyClient(config, bearerToken);
  const stdout = options.stdout || process.stdout;

  if (parsed.command === "check") {
    const runtimeBundle = await checkIntegrationProductionRuntimeBundle({
      stateRoot: config.stateRoot,
    });
    const summary = safeServiceSummary(config, "checked-disabled", runtimeBundle);
    writeJsonLine(stdout, summary);
    return summary;
  }

  // HOLD: dependency-enabled production serve remains unavailable until the
  // descriptor-bound idempotency store has a trusted, scope-bound recovery
  // receipt authority and the remaining runtime, sandbox, and public-artifact
  // gates are composed.
  const integrationServer = createIntegrationServer({
    config,
    trustedPrincipalProxyClient,
  });
  await integrationServer.start();
  let handedOff = false;
  let shutdown = null;
  try {
    writeJsonLine(stdout, safeServiceSummary(config, "listening-disabled"));
    if (options.waitForSignal === false) {
      handedOff = true;
      return integrationServer;
    }
    const processLike = options.processLike || process;
    shutdown = createShutdownSignalWaiter(processLike);
    await shutdown.promise;
    return safeServiceSummary(config, "closed");
  } finally {
    shutdown?.dispose();
    if (!handedOff) await integrationServer.close();
  }
}

export function safeIntegrationCliError(error) {
  const code = /^[A-Z][A-Z0-9_]{1,95}$/u.test(String(error?.code || ""))
    ? String(error.code)
    : "INTEGRATION_START_FAILED";
  const message = error instanceof IntegrationServiceConfigError
    ? error.message
    : "The integration service could not start safely.";
  return `${code}: ${message}`;
}
