import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  DEFAULT_INTEGRATION_ANALYSIS_CONFIG_PATH,
  createIntegrationAnalysisTrustedProxyClient,
  loadIntegrationAnalysisGroundedSearchCredential,
  loadIntegrationAnalysisLocalModelCredential,
  loadIntegrationAnalysisServiceConfig,
  publicIntegrationAnalysisServiceConfig,
} from "./integration-analysis-config.js";
import {
  INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY,
  loadTrustedPrincipalProxyCredential,
} from "./integration-config.js";
import { composeProductionIntegrationAnalysisServer } from "./integration-analysis-server.js";

const FORBIDDEN_SECRET_ENVIRONMENT = Object.freeze([
  "AGINTI_INTEGRATION_BEARER_TOKEN",
  "AGINTI_INTEGRATION_TOKEN",
  "AGINTI_INTEGRATION_BEARER_TOKEN_FILE",
  "AGINTI_INTEGRATION_TOKEN_FILE",
  "AGINTI_LOCALLLM_API_KEY",
  "AGINTI_LOCALLLM_SEARCH_API_KEY",
  "AGINTI_LOCALLLM_SEARCH_API_KEY_FILE",
  "AGINTI_LOCALLLM_SEARCH_TOKEN",
  "AGINTI_LOCALLLM_SEARCH_TOKEN_FILE",
  "AGINTI_GROUNDED_SEARCH_API_KEY",
  "AGINTI_GROUNDED_SEARCH_API_KEY_FILE",
  "AGINTI_GROUNDED_SEARCH_TOKEN",
  "AGINTI_GROUNDED_SEARCH_TOKEN_FILE",
  "LOCALLLM_API_KEY",
  "LOCALLLM_SEARCH_API_KEY",
  "LOCALLLM_SEARCH_API_KEY_FILE",
  "LOCALLLM_SEARCH_TOKEN",
  "LOCALLLM_SEARCH_TOKEN_FILE",
  "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_SEARCH_API_KEY",
  "LOCAL_LLM_SEARCH_API_KEY_FILE",
  "LOCAL_LLM_SEARCH_TOKEN",
  "LOCAL_LLM_SEARCH_TOKEN_FILE",
]);
const MAIN_OPTION_KEYS = Object.freeze(["env", "filePolicy", "processLike", "stdout", "waitForSignal"]);
const FILE_POLICY_KEYS = Object.freeze(["allowRootOwner", "ownerUid"]);

function fail(code, message) {
  const error = new Error(message);
  error.name = "IntegrationAnalysisCliError";
  error.code = code;
  error.publicCode = code;
  throw error;
}

function exactOptions(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("ANALYSIS_CLI_INVALID", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("ANALYSIS_CLI_INVALID", `${label} must be a plain data object.`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("ANALYSIS_CLI_INVALID", `${label} contains an unsupported option.`);
    }
  }
  return value;
}

export function parseIntegrationAnalysisCliArguments(argv = []) {
  if (!Array.isArray(argv)) fail("ANALYSIS_CLI_INVALID", "Analysis CLI arguments are invalid.");
  const args = argv.map((value) => String(value));
  const command = args.shift() || "";
  if (!new Set(["serve", "check", "doctor"]).has(command)) {
    fail("ANALYSIS_CLI_INVALID", "Usage: aginti-integration-analysis serve|check --config /absolute/path.json");
  }
  let configPath = DEFAULT_INTEGRATION_ANALYSIS_CONFIG_PATH;
  let configSeen = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== "--config" || configSeen || args.length < 1) {
      fail("ANALYSIS_CLI_INVALID", "Only one --config /absolute/path.json argument is accepted.");
    }
    configSeen = true;
    configPath = args.shift();
  }
  if (!path.isAbsolute(configPath) || path.normalize(configPath) !== configPath) {
    fail("ANALYSIS_CLI_INVALID", "Analysis config path must be canonical and absolute.");
  }
  return Object.freeze({ command: command === "doctor" ? "check" : command, configPath });
}

function assertCredentialEnvironment(env) {
  for (const name of FORBIDDEN_SECRET_ENVIRONMENT) {
    if (String(env?.[name] || "").trim()) {
      fail("ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN", "Analysis credentials must come only from systemd LoadCredential.");
    }
  }
  if (String(env?.CREDENTIALS_DIRECTORY || "").trim() !== INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY) {
    fail(
      "ANALYSIS_CREDENTIAL_INVALID",
      `CREDENTIALS_DIRECTORY must be exactly ${INTEGRATION_SYSTEMD_CREDENTIALS_DIRECTORY}.`
    );
  }
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function summary(config, status) {
  const publicConfig = publicIntegrationAnalysisServiceConfig(config);
  return Object.freeze({
    ok: true,
    status,
    schemaVersion: publicConfig.schemaVersion,
    capability: publicConfig.capability,
    listen: publicConfig.listen,
    stateRoot: publicConfig.stateRoot,
    idempotencyRoot: publicConfig.idempotencyRoot,
    localModel: publicConfig.localModel,
    ...(publicConfig.groundedSearch === undefined ? {} : { groundedSearch: publicConfig.groundedSearch }),
    trustedPrincipalProxy: publicConfig.trustedPrincipalProxy,
  });
}

function shutdownWaiter(processLike) {
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
  exactOptions(options, MAIN_OPTION_KEYS, "Analysis CLI options");
  if (options.filePolicy !== undefined) exactOptions(options.filePolicy, FILE_POLICY_KEYS, "Analysis config file policy");
  const parsed = parseIntegrationAnalysisCliArguments(argv);
  const env = options.env || process.env;
  assertCredentialEnvironment(env);
  const config = await loadIntegrationAnalysisServiceConfig(parsed.configPath, options.filePolicy || {});
  const [proxyToken, localModelApiKey, groundedSearchApiKey] = await Promise.all([
    loadTrustedPrincipalProxyCredential(),
    loadIntegrationAnalysisLocalModelCredential(),
    config.groundedSearch?.enabled === true
      ? loadIntegrationAnalysisGroundedSearchCredential()
      : Promise.resolve(undefined),
  ]);
  const trustedPrincipalProxyClient = createIntegrationAnalysisTrustedProxyClient(config, proxyToken);
  const stdout = options.stdout || process.stdout;
  if (parsed.command === "check") {
    const result = summary(config, "checked-analysis-ready-to-probe");
    writeJsonLine(stdout, result);
    return result;
  }

  const integrationServer = await composeProductionIntegrationAnalysisServer({
    config,
    trustedPrincipalProxyClient,
    localModelApiKey,
    ...(groundedSearchApiKey === undefined ? {} : { groundedSearchApiKey }),
  });
  await integrationServer.start();
  let handedOff = false;
  let shutdown = null;
  try {
    writeJsonLine(stdout, summary(config, "listening-analysis"));
    if (options.waitForSignal === false) {
      handedOff = true;
      return integrationServer;
    }
    const processLike = options.processLike || process;
    shutdown = shutdownWaiter(processLike);
    await shutdown.promise;
    return summary(config, "closed-analysis");
  } finally {
    shutdown?.dispose();
    if (!handedOff) await integrationServer.close();
  }
}

export function safeIntegrationAnalysisCliError(error) {
  const code = /^[A-Z][A-Z0-9_]{1,95}$/u.test(String(error?.code || ""))
    ? String(error.code)
    : "ANALYSIS_START_FAILED";
  return `${code}: The analysis integration service could not start safely.`;
}
