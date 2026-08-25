import path from "node:path";

import {
  DOCUMENT_WORKER_CONFIG_PATH,
  DOCUMENT_WORKER_CREDENTIALS_DIRECTORY,
  loadIntegrationDocumentWorkerConfig,
  loadIntegrationDocumentWorkerCredential,
  publicIntegrationDocumentWorkerConfig,
} from "./integration-document-worker-config.js";
import { createIntegrationDocumentWorkerServer } from "./integration-document-worker-server.js";
import { createIntegrationDocumentWorkerService } from "./integration-document-worker-service.js";
import { openIntegrationDocumentWorkerStore } from "./integration-document-worker-store.js";
import { assertIntegrationDocumentWorkerRuntimeActivation } from "./integration-document-worker-runtime.js";

const FORBIDDEN_SECRET_ENVIRONMENT = Object.freeze([
  "AGINTI_DOCUMENT_WORKER_TOKEN",
  "AGINTI_DOCUMENT_WORKER_TOKEN_FILE",
  "AGINTI_DOCUMENT_WORKER_UPSTREAM_TOKEN",
  "AGINTI_DOCUMENT_WORKER_UPSTREAM_TOKEN_FILE",
  "DOCUMENT_WORKER_TOKEN",
  "DOCUMENT_WORKER_TOKEN_FILE",
  "LAZYEDGE_TOKEN",
  "LAZYEDGE_UPSTREAM_TOKEN",
  "LOCALLLM_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
]);

function cliFail(code, message) {
  const error = new Error(message);
  error.name = "IntegrationDocumentWorkerCliError";
  error.code = code;
  error.publicCode = code;
  error.status = 503;
  error.statusCode = 503;
  throw error;
}

export function parseIntegrationDocumentWorkerArguments(argv = []) {
  if (!Array.isArray(argv)) cliFail("DOCUMENT_WORKER_CLI_INVALID", "Document worker arguments are invalid.");
  const args = argv.map((value) => String(value));
  const command = args.shift() || "";
  if (!new Set(["serve", "check"]).has(command)) {
    cliFail(
      "DOCUMENT_WORKER_CLI_INVALID",
      "Usage: aginti-document-worker serve|check --config /absolute/path.json"
    );
  }
  let configPath = DOCUMENT_WORKER_CONFIG_PATH;
  let seen = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== "--config" || seen || args.length < 1) {
      cliFail("DOCUMENT_WORKER_CLI_INVALID", "Only one --config /absolute/path.json argument is accepted.");
    }
    seen = true;
    configPath = args.shift();
  }
  if (!path.isAbsolute(configPath) || path.normalize(configPath) !== configPath) {
    cliFail("DOCUMENT_WORKER_CLI_INVALID", "Document worker config path must be canonical and absolute.");
  }
  return Object.freeze({ command, configPath });
}

function assertCredentialEnvironment(env) {
  for (const name of FORBIDDEN_SECRET_ENVIRONMENT) {
    if (String(env?.[name] || "").trim()) {
      cliFail(
        "DOCUMENT_WORKER_CREDENTIAL_SOURCE_FORBIDDEN",
        "Document worker credentials must come only from systemd LoadCredential."
      );
    }
  }
  if (String(env?.CREDENTIALS_DIRECTORY || "") !== DOCUMENT_WORKER_CREDENTIALS_DIRECTORY) {
    cliFail(
      "DOCUMENT_WORKER_CREDENTIAL_INVALID",
      `CREDENTIALS_DIRECTORY must be exactly ${DOCUMENT_WORKER_CREDENTIALS_DIRECTORY}.`
    );
  }
}

function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function waitForShutdown(processLike) {
  let callback;
  const promise = new Promise((resolve) => {
    callback = (signal) => resolve(signal);
    processLike.once("SIGINT", callback);
    processLike.once("SIGTERM", callback);
  });
  return Object.freeze({
    promise,
    dispose() {
      processLike.removeListener?.("SIGINT", callback);
      processLike.removeListener?.("SIGTERM", callback);
    },
  });
}

export async function composeProductionIntegrationDocumentWorker({ config, bearerToken }) {
  let store;
  let service;
  try {
    await assertIntegrationDocumentWorkerRuntimeActivation();
    store = await openIntegrationDocumentWorkerStore({ stateRoot: config.stateRoot });
    service = createIntegrationDocumentWorkerService({ config, store });
    return createIntegrationDocumentWorkerServer({ config, service, bearerToken });
  } catch (error) {
    await service?.close().catch(() => {});
    await store?.close().catch(() => {});
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseIntegrationDocumentWorkerArguments(argv);
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  assertCredentialEnvironment(env);
  await assertIntegrationDocumentWorkerRuntimeActivation();
  const filePolicy = options.filePolicy || {};
  const config = await loadIntegrationDocumentWorkerConfig(parsed.configPath, filePolicy);
  const bearerToken = await loadIntegrationDocumentWorkerCredential(filePolicy);
  const server = await composeProductionIntegrationDocumentWorker({ config, bearerToken });
  let handedOff = false;
  let waiter = null;
  try {
    if (parsed.command === "check") {
      const readiness = await server.check();
      const result = Object.freeze({
        ok: true,
        status: "checked-document-worker",
        realCompilerCanary: true,
        config: publicIntegrationDocumentWorkerConfig(config),
        readiness,
      });
      writeJsonLine(stdout, result);
      return result;
    }
    const address = await server.start();
    writeJsonLine(stdout, Object.freeze({
      ok: true,
      status: "listening-document-worker",
      listen: address,
      creationEnabled: config.creation.enabled,
    }));
    if (options.waitForSignal === false) {
      handedOff = true;
      return server;
    }
    const processLike = options.processLike || process;
    waiter = waitForShutdown(processLike);
    await waiter.promise;
    return Object.freeze({ ok: true, status: "closed-document-worker" });
  } finally {
    waiter?.dispose();
    if (!handedOff && server.lifecycle !== "closed") await server.close().catch(() => {});
  }
}

export function safeIntegrationDocumentWorkerCliError(error) {
  const code = /^[A-Z][A-Z0-9_]{1,95}$/u.test(String(error?.code || ""))
    ? String(error.code)
    : "DOCUMENT_WORKER_START_FAILED";
  return `${code}: The document worker could not start safely.`;
}
