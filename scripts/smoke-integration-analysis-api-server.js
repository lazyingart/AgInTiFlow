import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  INTEGRATION_ANALYSIS_MUTATION_RECOVERY_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION,
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
  INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
  createActivatedIntegrationAnalysisRouter,
  createIntegrationAnalysisRouterActivation,
} from "../src/integration-api.js";
import {
  DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
  DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
  INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_NAME,
  INTEGRATION_ANALYSIS_LISTEN_HOST,
  INTEGRATION_ANALYSIS_LISTEN_PORT,
  INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME,
  INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
  INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
  INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
  INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
  INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID,
  createIntegrationAnalysisTrustedProxyClient,
  isMissingIntegrationAnalysisDocumentWorkerCredentialError,
  loadIntegrationAnalysisDocumentWorkerCredential,
  loadIntegrationAnalysisServiceConfig,
  parseIntegrationAnalysisDocumentWorkerCredential,
  parseIntegrationAnalysisGroundedSearchCredential,
  parseIntegrationAnalysisLocalModelCredential,
  publicIntegrationAnalysisServiceConfig,
  validateIntegrationAnalysisServiceConfig,
} from "../src/integration-analysis-config.js";
import {
  INTEGRATION_ANALYSIS_SERVER_ENABLED,
  configureIntegrationAnalysisHttpServer,
  createIntegrationAnalysisServer,
  createTestOnlyIntegrationAnalysisServerLifecycle,
  integrationAnalysisListenOptions,
  integrationAnalysisVisionEligibleForStatePersistenceMode,
  assertDistinctIntegrationAnalysisCredentials,
  composeProductionIntegrationAnalysisServer,
} from "../src/integration-analysis-server.js";
import {
  INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
} from "../src/integration-grounded-search.js";
import {
  INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
  INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
} from "../src/integration-document-worker-client.js";
import {
  INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "../src/integration-analysis-state-persistence.js";
import { IntegrationServiceConfigError } from "../src/integration-config.js";
import {
  integrationAnalysisCliSummary,
  parseIntegrationAnalysisCliArguments,
} from "../src/integration-analysis-cli.js";
import {
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_RECEIVE_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS,
  INTEGRATION_RPC_PATH_LIST,
  INTEGRATION_RPC_PATHS,
  buildFixedIntegrationPolicy,
  contractDigest,
} from "../src/integration-policy.js";
import { integrationAnalysisBodyReceiveTimeoutMs } from "../src/integration-api.js";

const TOKEN = "A".repeat(48);
const PRINCIPAL = "principal-analysis-0001";
const BROWSER_SESSION = "b".repeat(64);
const IDEMPOTENCY_KEY = "analysis-create-0001";
const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const AT = "2026-08-24T00:00:00.000Z";
const ZERO_DIGEST = "0".repeat(64);

const credentialRoles = ["model", "trustedBff", "groundedSearch", "documentEdge", "executionWorker"];
const distinctCredentials = Object.fromEntries(
  credentialRoles.map((role, index) => [role, `${String(index + 1).repeat(2)}${role}-credential-${"x".repeat(32)}`])
);
assert.equal(assertDistinctIntegrationAnalysisCredentials(distinctCredentials), true);
for (let left = 0; left < credentialRoles.length; left += 1) {
  for (let right = left + 1; right < credentialRoles.length; right += 1) {
    const collided = { ...distinctCredentials };
    collided[credentialRoles[right]] = collided[credentialRoles[left]];
    assert.throws(
      () => assertDistinctIntegrationAnalysisCredentials(collided),
      (error) => error?.code === "ANALYSIS_CREDENTIAL_INVALID",
      `credential equality ${credentialRoles[left]}=${credentialRoles[right]} must fail closed`
    );
  }
}

function validConfig(overrides = {}) {
  return {
    schemaVersion: INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    capability: { enabled: true, mode: "analysis-execution" },
    listen: { host: INTEGRATION_ANALYSIS_LISTEN_HOST, port: INTEGRATION_ANALYSIS_LISTEN_PORT },
    stateRoot: DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
    idempotencyRoot: DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
    statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3 },
    localModel: {
      baseURL: INTEGRATION_ANALYSIS_LOCALLLM_BASE_URL,
      model: INTEGRATION_ANALYSIS_LOCALLLM_MODEL,
      contextWindowTokens: INTEGRATION_ANALYSIS_LOCALLLM_CONTEXT_TOKENS,
      maxOutputTokens: INTEGRATION_ANALYSIS_LOCALLLM_OUTPUT_TOKENS,
      modelTimeoutMs: INTEGRATION_ANALYSIS_LOCALLLM_TIMEOUT_MS,
    },
    trustedPrincipalProxy: {
      clientId: INTEGRATION_ANALYSIS_TRUSTED_CLIENT_ID,
      label: "LazyingAgentWeb BFF",
      scopes: [...INTEGRATION_RPC_PATH_LIST],
    },
    ...overrides,
  };
}

function freezeDigest(unsigned) {
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function startupProof() {
  return freezeDigest({
    schemaVersion: "aginti-integration-analysis-coordinator-v1",
    ready: true,
    publicActivationReady: true,
    workerCapabilityDigest: contractDigest("capability"),
    workerHealthDigest: contractDigest("health"),
    coordinatorProtocolDigest: contractDigest("protocol"),
    coordinatorHealthDigest: contractDigest("coordinator-health"),
    runtimeProfile: "python-analysis-v1",
    runtimeBundleRootDigest: contractDigest("runtime"),
    seccompPolicyDigest: contractDigest("seccomp"),
    cgroupPolicyDigest: contractDigest("cgroup"),
  });
}

function mutationRecoveryAuthority() {
  return freezeDigest({
    schemaVersion: INTEGRATION_ANALYSIS_MUTATION_RECOVERY_SCHEMA_VERSION,
    owner: "aginti",
    durable: true,
    atomicWithMutation: true,
    principalBound: true,
    browserSessionBound: true,
    pathnameBound: true,
    requestHashBound: true,
    idempotencyKeyDigestBound: true,
    blindRedispatch: false,
    exactPublicResponse: true,
  });
}

function sessionAuthority(activationProof, recoveryProof) {
  return freezeDigest({
    schemaVersion: "aginti-integration-analysis-session-v1",
    owner: "aginti",
    authority: "aginti",
    ready: true,
    testOnly: false,
    runnerAuthority: "aginti-analysis-planner",
    runnerDigest: contractDigest("runner"),
    activationProofRequired: true,
    activationProofDigest: activationProof.digest,
    activationProof,
    activationProofPinnedAtStartup: true,
    activationReadinessReprobedPerRpc: false,
    stateRootDigest: contractDigest("state-root"),
    statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
    stateStorageVersion: INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
    r67RollbackCompatible: false,
    oneFixedStateRoot: true,
    principalBound: true,
    browserSessionBound: true,
    sameBrowserSessionOnly: true,
    requestDerivedPaths: false,
    symlinksRejected: true,
    hardlinksRejected: true,
    privateOwnershipAndModes: true,
    canonicalStateEncoding: true,
    stateEnvelopeDigest: true,
    atomicTempFsyncRename: true,
    directoryFsync: true,
    serializedMutations: true,
    crossProcessSafe: false,
    durablePublicReplay: true,
    publicEventHashChain: true,
    artifactBeforeTerminal: true,
    exactCancellation: true,
    interruptedRunRecovery: true,
    durableMutationReceipts: true,
    mutationRecoveryAuthorityDigest: recoveryProof.digest,
    rawExecutionSourcePersisted: false,
    rawExecutionStdoutPersisted: false,
    privateRuntimePathsPersisted: false,
    documentBytesPersistedByCloud: false,
    documentSourcePersistedByCloud: false,
    documentWorkerOpaqueRefs: true,
    documentWorkerReceiptBindings: true,
    documentWorkerPairedCommitIntents: true,
    documentWorkerTwoPhaseDelete: true,
    documentWorkerDeleteIntentBeforeBytes: true,
    documentContentPrincipalAndBrowserSessionBound: true,
    documentContentStreamedWithoutCloudBuffering: true,
    publicActivationLocksChanged: false,
    limitsDigest: contractDigest("limits"),
  });
}

function publicThread(title = "New agent thread") {
  return {
    id: THREAD_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title,
    status: "idle",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    lastRunId: null,
    authority: {
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: ZERO_DIGEST,
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_DIGEST },
    messages: [],
  };
}

function createSessionService(activationProof, calls, { recover = true } = {}) {
  const recoveryProof = mutationRecoveryAuthority();
  const capabilities = Object.freeze({
    analysisSessionAuthority: sessionAuthority(activationProof, recoveryProof),
    mutationRecoveryAuthority: recoveryProof,
    cancel: true,
    resume: true,
  });
  const unavailable = async () => {
    throw new Error("not exercised");
  };
  const service = {
    async getIntegrationCapabilities() {
      return capabilities;
    },
    async listThreads() {
      return { threads: [], nextBefore: null };
    },
    async createThread(payload, context) {
      calls.push({ payload, context });
      return { thread: publicThread(payload.title) };
    },
    getThread: unavailable,
    updateThread: unavailable,
    deleteThread: unavailable,
    startRun: unavailable,
    getRunStatus: unavailable,
    loadRunEvents: unavailable,
    cancelRun: unavailable,
    resumeRun: unavailable,
    listArtifacts: unavailable,
    getArtifact: unavailable,
    ...(recover ? { async recoverMutation() { return null; } } : {}),
  };
  return Object.freeze(service);
}

function createIdempotencyStore(calls) {
  const recoveryUnsigned = {
    schemaVersion: "aginti-integration-idempotency-recovery-authority-v1",
    owner: "aginti",
    explicit: true,
    blindRedispatch: false,
    beforeDispatchRecovery: true,
    afterDispatchBeforeResultRecovery: true,
    afterResultBeforePublicResponseRecovery: true,
  };
  const recoveryAuthority = freezeDigest(recoveryUnsigned);
  return Object.freeze({
    owner: "aginti",
    contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
    durable: true,
    crossProcessSafe: true,
    atomicLookupAndDispatch: true,
    atomicClaim: true,
    atomicComplete: true,
    failOrRecoverOnHandlerError: true,
    noStrandedPendingOnHandlerError: true,
    requestHashBound: true,
    principalBound: true,
    browserSessionBound: true,
    sameKeySameRequestReplays: true,
    sameKeyDifferentRequestStatus: 409,
    idempotencyWindowMs: INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
    testOnly: false,
    requestHashAlgorithm: "canonical-json-v1",
    responseEnvelope: "aginti-agent-rpc-v1",
    recoveryAuthority,
    async runMutation(context, handler) {
      calls.push(context);
      return handler();
    },
  });
}

function authHeaders({ idempotencyKey = "" } = {}) {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "x-aginti-principal-id": PRINCIPAL,
    "x-aginti-browser-session-id": BROWSER_SESSION,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function rpc(pathname, body, headers) {
  const response = await fetch(`http://${INTEGRATION_ANALYSIS_LISTEN_HOST}:${INTEGRATION_ANALYSIS_LISTEN_PORT}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function streamedImageBodyReachesConfiguredServer() {
  let received = 0;
  const server = http.createServer((request, response) => {
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    request.on("end", () => {
      response.writeHead(204);
      response.end();
    });
  });
  configureIntegrationAnalysisHttpServer(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const block = Buffer.alloc(1024 * 1024, 0x61);
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/bounded-image-body",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT),
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      let remaining = INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT;
      const writeNext = () => {
        if (remaining === 0) {
          request.end();
          return;
        }
        const size = Math.min(block.length, remaining);
        remaining -= size;
        if (request.write(block.subarray(0, size))) setImmediate(writeNext);
        else request.once("drain", writeNext);
      };
      writeNext();
    });
    assert.equal(status, 204);
    assert.equal(received, INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_BYTES_LIMIT);
    assert.equal(server.requestTimeout, INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_RECEIVE_TIMEOUT_MS);
  } finally {
    block.fill(0);
    await new Promise((resolve) => server.close(resolve));
  }
}

const checkedConfig = validateIntegrationAnalysisServiceConfig(validConfig());
assert.equal(checkedConfig.capability.enabled, true);
assert.equal(checkedConfig.statePersistence.mode, INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3);
assert.equal(checkedConfig.trustedPrincipalProxy.clientId, "aginti-bff");
assert.equal(Object.prototype.hasOwnProperty.call(checkedConfig, "vision"), false);
assert.deepEqual(
  integrationAnalysisCliSummary(checkedConfig, "checked-analysis-ready-to-probe").vision,
  { enabled: false },
  "an absent pre-migration gate is reported as disabled without changing the accepted config shape"
);
assert.equal(
  integrationAnalysisVisionEligibleForStatePersistenceMode(
    INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3
  ),
  false,
  "the absent vision gate fails closed even after native-v3 migration"
);
assert.equal(
  integrationAnalysisVisionEligibleForStatePersistenceMode(
    INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
    true
  ),
  true
);
assert.equal(
  integrationAnalysisVisionEligibleForStatePersistenceMode(
    INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2,
    false
  ),
  false
);
assert.throws(
  () => integrationAnalysisVisionEligibleForStatePersistenceMode(
    INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2,
    true
  ),
  /requires native-v3/u
);
assert.deepEqual(integrationAnalysisListenOptions(checkedConfig), {
  host: "127.0.0.1",
  port: 18009,
  exclusive: true,
});
assert.equal(INTEGRATION_ANALYSIS_SERVER_ENABLED, true);
assert.equal(
  INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION,
  "aginti-integration-analysis-router-activation-v4"
);
const configuredHttpServer = http.createServer();
configureIntegrationAnalysisHttpServer(configuredHttpServer);
assert.equal(configuredHttpServer.requestTimeout, 245_000);
assert.equal(
  configuredHttpServer.requestTimeout,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BODY_RECEIVE_TIMEOUT_MS
);
assert.ok(configuredHttpServer.requestTimeout > 240_000);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.runsStart, { attachmentsEnabled: true }),
  245_000
);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.runsResume, { attachmentsEnabled: true }),
  245_000
);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.runsStart, {
    attachmentsEnabled: true,
    declaredBodyBytes: 128 * 1024,
  }),
  INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS,
  "an explicitly small Agent start body keeps the ordinary 125s receive deadline"
);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.runsResume, {
    attachmentsEnabled: true,
    declaredBodyBytes: 128 * 1024 + 1,
  }),
  245_000,
  "a potentially large Agent resume body receives the bounded 245s image deadline"
);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.runsStart),
  INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS
);
assert.equal(
  integrationAnalysisBodyReceiveTimeoutMs(INTEGRATION_RPC_PATHS.threadsCreate, { attachmentsEnabled: true }),
  INTEGRATION_ANALYSIS_ORDINARY_BODY_RECEIVE_TIMEOUT_MS,
  "ordinary Agent routes keep their shorter receive bound when image input is enabled"
);
assert.equal(configuredHttpServer.headersTimeout, 10_000);
assert.equal(configuredHttpServer.keepAliveTimeout, 5_000);
await streamedImageBodyReachesConfiguredServer();
const serverSource = await fs.readFile(new URL("../src/integration-analysis-server.js", import.meta.url), "utf8");
const apiSource = await fs.readFile(new URL("../src/integration-api.js", import.meta.url), "utf8");
assert.match(
  serverSource,
  /const server = http\.createServer\(app\);[\s\S]{0,256}configureIntegrationAnalysisHttpServer\(server\);/u,
  "the production server applies the 245s outer receive bound to the exact HTTP server"
);
assert.match(
  apiSource,
  /const bodyReceiveTimeoutMs = integrationAnalysisBodyReceiveTimeoutMs[\s\S]{0,256}declaredBodyBytes: declaredContentLength\(req\)[\s\S]{0,128}armBodyReceiveDeadline\(req, bodyReceiveTimeoutMs\);/u,
  "large image receives and explicitly small ordinary bodies retain separate explicit bounds"
);
assert.match(
  apiSource,
  /const attachmentTransportAware =[\s\S]{0,192}statePersistenceMode === INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES\.nativeV3[\s\S]{0,192}stateStorageVersion === INTEGRATION_ANALYSIS_STATE_STORAGE_V3/u,
  "native-v3 activation binds attachment transport parsing independently of the vision gate"
);
assert.match(
  apiSource,
  /const attachmentTransportAware = activationMetadata\?\.proof\?\.attachmentTransportAware === true;[\s\S]{0,1024}createAttachmentAdmissionMiddlewares\([\s\S]{0,128}attachmentTransportAware/u,
  "gate-off native-v3 keeps the bounded image parser and receive admission lane"
);
const gateOffPreflightIndex = apiSource.indexOf("const gateOffAttachmentMutation =");
const idempotencyMutationIndex = apiSource.indexOf(
  "transactionalIdempotencyStore.runMutation(",
  gateOffPreflightIndex
);
const visionGateRejectIndex = apiSource.indexOf('"ANALYSIS_VISION_NOT_READY"', idempotencyMutationIndex);
const sessionMutationIndex = apiSource.indexOf(
  "await callSessionService(sessionService, pathname, payload, context)",
  visionGateRejectIndex
);
assert.ok(gateOffPreflightIndex > 0);
assert.ok(
  idempotencyMutationIndex > gateOffPreflightIndex,
  "all gate-off image mutations must enter the durable idempotency authority"
);
assert.ok(
  visionGateRejectIndex > idempotencyMutationIndex && sessionMutationIndex > visionGateRejectIndex,
  "only a new idempotency dispatch rejects gate-off image work, before the session mutation"
);
assert.equal(
  apiSource.indexOf("await sessionService.recoverMutation({", gateOffPreflightIndex),
  -1,
  "the router must not bypass external completed, failed, or pending idempotency authority"
);
assert.throws(
  () => validateIntegrationAnalysisServiceConfig({ ...validConfig(), schemaVersion: "aginti-integration-analysis-service-config-v1" }),
  (error) => error.code === "ANALYSIS_CONFIG_LOCKED"
);
const { statePersistence: _missingStatePersistence, ...missingStatePersistence } = validConfig();
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(missingStatePersistence),
  (error) => error.code === "ANALYSIS_CONFIG_INVALID"
);
const r67CompatibleConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 },
}));
assert.equal(
  publicIntegrationAnalysisServiceConfig(r67CompatibleConfig).statePersistence.mode,
  INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2
);
assert.equal(Object.prototype.hasOwnProperty.call(r67CompatibleConfig, "vision"), false);
assert.deepEqual(
  validateIntegrationAnalysisServiceConfig(validConfig({
    statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 },
    vision: { enabled: false },
  })).vision,
  { enabled: false }
);
const nativeVisionDisabledConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  vision: { enabled: false },
}));
assert.deepEqual(
  integrationAnalysisCliSummary(nativeVisionDisabledConfig, "checked-analysis-ready-to-probe").vision,
  { enabled: false }
);
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(validConfig({
    statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 },
    vision: { enabled: true },
  })),
  (error) => error.code === "ANALYSIS_CONFIG_INVALID" && /native-v3/u.test(error.message)
);
const nativeVisionConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  vision: { enabled: true },
}));
assert.deepEqual(nativeVisionConfig.vision, { enabled: true });
assert.deepEqual(publicIntegrationAnalysisServiceConfig(nativeVisionConfig).vision, { enabled: true });
assert.deepEqual(
  integrationAnalysisCliSummary(nativeVisionConfig, "checked-analysis-ready-to-probe").vision,
  { enabled: true }
);
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(validConfig({ listen: { host: "127.0.0.1", port: 18109 } })),
  (error) => error.code === "ANALYSIS_CONFIG_LOCKED"
);
assert.throws(
  () =>
    validateIntegrationAnalysisServiceConfig({
      ...validConfig(),
      trustedPrincipalProxy: { ...validConfig().trustedPrincipalProxy, clientId: "lazying-agent-web" },
    }),
  (error) => error.code === "ANALYSIS_CONFIG_LOCKED"
);
assert.deepEqual(parseIntegrationAnalysisCliArguments(["doctor"]), {
  command: "check",
  configPath: "/etc/agintiflow/integration-analysis.json",
});
assert.equal(parseIntegrationAnalysisLocalModelCredential(`${TOKEN}\n`), TOKEN);
assert.equal(parseIntegrationAnalysisGroundedSearchCredential(`${TOKEN}\n`), TOKEN);
assert.equal(parseIntegrationAnalysisGroundedSearchCredential(`!search-v2-visible-ascii~key=\n`), "!search-v2-visible-ascii~key=");
assert.equal(parseIntegrationAnalysisDocumentWorkerCredential(`${TOKEN}\n`), TOKEN);
assert.throws(
  () => parseIntegrationAnalysisGroundedSearchCredential(` ${TOKEN}\n`),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
assert.throws(
  () => parseIntegrationAnalysisGroundedSearchCredential(`search-v2-é-${TOKEN}\n`),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
assert.throws(
  () => parseIntegrationAnalysisGroundedSearchCredential(`short-key\n`),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
assert.throws(
  () => parseIntegrationAnalysisDocumentWorkerCredential(`${TOKEN} \n`),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
assert.throws(
  () => parseIntegrationAnalysisDocumentWorkerCredential(`${TOKEN}\nextra`),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
assert.equal(
  isMissingIntegrationAnalysisDocumentWorkerCredentialError(
    new IntegrationServiceConfigError("ANALYSIS_CREDENTIAL_MISSING", "missing")
  ),
  true
);
assert.equal(
  isMissingIntegrationAnalysisDocumentWorkerCredentialError(
    new IntegrationServiceConfigError("ANALYSIS_CREDENTIAL_INVALID", "unsafe")
  ),
  false
);
await assert.rejects(
  loadIntegrationAnalysisDocumentWorkerCredential("/tmp/caller-selected-token"),
  (error) => error.code === "ANALYSIS_CREDENTIAL_SOURCE_FORBIDDEN"
);
const disabledSearchConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  groundedSearch: { enabled: false },
}));
assert.equal(disabledSearchConfig.groundedSearch.enabled, false);
assert.equal(
  Object.prototype.hasOwnProperty.call(publicIntegrationAnalysisServiceConfig(disabledSearchConfig), "groundedSearchCredentialName"),
  false
);
const enabledSearchConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  groundedSearch: {
    enabled: true,
    endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
    timeoutMs: INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
    maximumSources: 20,
  },
}));
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(validConfig({
    statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 },
    groundedSearch: {
      enabled: true,
      endpoint: INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
      timeoutMs: INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
      maximumSources: 20,
    },
  })),
  (error) => error.code === "ANALYSIS_CONFIG_INVALID"
);
assert.equal(
  publicIntegrationAnalysisServiceConfig(enabledSearchConfig).groundedSearchCredentialName,
  INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME
);
const disabledDocumentWorkerConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  documentWorker: { enabled: false },
}));
assert.equal(disabledDocumentWorkerConfig.documentWorker.enabled, false);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    publicIntegrationAnalysisServiceConfig(disabledDocumentWorkerConfig),
    "documentWorkerCredentialName"
  ),
  false
);
const enabledDocumentWorkerConfig = validateIntegrationAnalysisServiceConfig(validConfig({
  documentWorker: {
    enabled: true,
    endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
    timeoutMs: INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
  },
}));
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(validConfig({
    statePersistence: { mode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2 },
    documentWorker: {
      enabled: true,
      endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
      timeoutMs: INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
    },
  })),
  (error) => error.code === "ANALYSIS_CONFIG_INVALID"
);
assert.deepEqual(enabledDocumentWorkerConfig.documentWorker, {
  enabled: true,
  endpoint: "http://127.0.0.1:18121",
  timeoutMs: 120_000,
});
assert.equal(
  publicIntegrationAnalysisServiceConfig(enabledDocumentWorkerConfig).documentWorkerCredentialName,
  INTEGRATION_ANALYSIS_DOCUMENT_WORKER_CREDENTIAL_NAME
);
const trustedBffClient = createIntegrationAnalysisTrustedProxyClient(enabledDocumentWorkerConfig, TOKEN);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: enabledDocumentWorkerConfig,
    trustedPrincipalProxyClient: trustedBffClient,
    localModelApiKey: "B".repeat(48),
    documentWorkerCredential: TOKEN,
    executionWorkerCredential: "C".repeat(48),
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
for (const endpoint of [
  "http://127.0.0.1:18122",
  "http://127.0.0.2:18121",
  "http://127.0.0.1:18121/path",
  "http://user@127.0.0.1:18121",
  "https://127.0.0.1:18121",
  "http://127.0.0.1:80",
]) {
  assert.throws(
    () => validateIntegrationAnalysisServiceConfig(validConfig({
      documentWorker: {
        enabled: true,
        endpoint,
        timeoutMs: INTEGRATION_DOCUMENT_WORKER_TIMEOUT_MS,
      },
    })),
    (error) => error.code === "ANALYSIS_CONFIG_INVALID"
  );
}
assert.throws(
  () => validateIntegrationAnalysisServiceConfig(validConfig({
    documentWorker: {
      enabled: true,
      endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
      timeoutMs: 30_000,
    },
  })),
  (error) => error.code === "ANALYSIS_CONFIG_LOCKED"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: disabledDocumentWorkerConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    documentWorkerCredential: `${TOKEN}B`,
    executionWorkerCredential: "C".repeat(48),
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: enabledDocumentWorkerConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    documentWorkerCredential: TOKEN,
    executionWorkerCredential: "C".repeat(48),
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: enabledSearchConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    groundedSearchApiKey: TOKEN,
    executionWorkerCredential: "C".repeat(48),
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: disabledSearchConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    groundedSearchApiKey: TOKEN,
    executionWorkerCredential: "C".repeat(48),
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: validateIntegrationAnalysisServiceConfig(validConfig()),
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
  }),
  (error) => error.code === "ANALYSIS_SERVER_INVALID",
  "production composition must require the already-validated execution-worker credential"
);

const serverCompositionSource = await fs.readFile(
  new URL("../src/integration-analysis-server.js", import.meta.url),
  "utf8"
);
const cliCompositionSource = await fs.readFile(
  new URL("../src/integration-analysis-cli.js", import.meta.url),
  "utf8"
);
assert.match(
  cliCompositionSource,
  /loadIntegrationAnalysisDocumentWorkerCredential\(\)\.catch\(\(error\)\s*=>\s*\{[\s\S]*?isMissingIntegrationAnalysisDocumentWorkerCredentialError\(error\)[\s\S]*?throw error/u,
  "only an explicitly absent optional worker credential may degrade startup"
);
assert.match(
  cliCompositionSource,
  /loadIntegrationAnalysisGroundedSearchCredential\(\)\.catch\(\(error\)\s*=>\s*\{[\s\S]*?isMissingIntegrationAnalysisOptionalCredentialError\(error\)[\s\S]*?throw error/u,
  "only an explicitly absent optional grounded-search credential may degrade startup"
);
assert.match(
  serverCompositionSource,
  /createSystemdIntegrationAnalysisCoordinator\(\{[\s\S]*?executionWorkerCredential:\s*options\.executionWorkerCredential/u,
  "production composition must bind the already-validated execution-worker credential into the coordinator"
);
assert.match(
  serverCompositionSource,
  /executionWorker:\s*options\.executionWorkerCredential/u,
  "production composition must receive and distinct-check the execution-worker credential"
);
assert.match(
  cliCompositionSource,
  /executionWorkerCredential,\s*\n\s*\.\.\.\(groundedSearchApiKey/u,
  "CLI check/serve must provision the execution-worker credential into production composition"
);
assert.equal(
  serverCompositionSource.match(/await planner\.activate\(\)/gu)?.length,
  1,
  "production composition must activate its bound planner exactly once"
);
assert.match(
  serverCompositionSource,
  /const activatedDocumentWorkerClient = plannerActivation\.documentWorker === undefined[\s\S]*?documentWorkerClient:\s*activatedDocumentWorkerClient/u,
  "production sessions must receive the document client only when the optional role activated ready"
);
assert.doesNotMatch(
  serverCompositionSource,
  /activationProof:\s*startupProof/u,
  "production sessions must not accept a detached readiness proof"
);
assert.match(
  serverCompositionSource,
  /searchEnabled && searchCredentialPresent[\s\S]*?groundedSearchConfig:[\s\S]*?apiKey:\s*options\.groundedSearchApiKey/u,
  "grounded search must use a distinct systemd credential only after it exists"
);
assert.match(
  serverCompositionSource,
  /createIntegrationDocumentWorkerClient\(\{[\s\S]*?endpoint:\s*config\.documentWorker\.endpoint,[\s\S]*?credential:\s*options\.documentWorkerCredential/u,
  "production document creation must use the fixed credentialed worker client"
);
assert.doesNotMatch(
  serverCompositionSource,
  /integration-(?:tex-compiler|document-blob-store)|createIntegration(?:TexCompiler|DocumentBlobStore)/u,
  "cloud production composition must not import compiler or blob authority"
);

const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-config-"));
try {
  const configPath = path.join(configRoot, "integration-analysis.json");
  await fs.writeFile(configPath, `${JSON.stringify(validConfig())}\n`, { mode: 0o600 });
  const loaded = await loadIntegrationAnalysisServiceConfig(configPath, {
    ownerUid: typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
    allowRootOwner: true,
  });
  assert.equal(loaded.listen.port, 18009);
} finally {
  await fs.rm(configRoot, { recursive: true, force: true });
}

function lifecycleFixture({ startError = null, serverCloseError = null, sessionCloseError = null } = {}) {
  const events = [];
  let listening = false;
  let lifecycle = "created";
  const server = {
    app: Object.freeze({}),
    server: Object.freeze({}),
    config: Object.freeze({ listen: Object.freeze({ host: "127.0.0.1", port: 18009 }) }),
    async start() {
      events.push("http-start");
      if (startError) throw startError;
      listening = true;
      lifecycle = "listening";
      return Object.freeze({ address: "127.0.0.1", port: 18009, family: "IPv4" });
    },
    async close(options) {
      events.push(Object.freeze({ stage: "http-close", options }));
      listening = false;
      lifecycle = "closed";
      await Promise.resolve();
      events.push("http-closed");
      if (serverCloseError) throw serverCloseError;
      return Object.freeze({ closed: true, forced: false });
    },
    get listening() {
      return listening;
    },
    get lifecycle() {
      return lifecycle;
    },
  };
  const sessionService = Object.freeze({
    async close(options) {
      assert.equal(events.at(-1), "http-closed", "session drain must follow stopped HTTP acceptance");
      events.push(Object.freeze({ stage: "session-close", options }));
      await Promise.resolve();
      events.push("session-closed");
      if (sessionCloseError) throw sessionCloseError;
      return Object.freeze({ drained: true, closed: true });
    },
  });
  const coordinator = Object.freeze({
    async close() {
      assert.equal(events.at(-1), "session-closed", "coordinator close must follow the durable session drain");
      events.push("coordinator-closed");
    },
  });
  const managed = createTestOnlyIntegrationAnalysisServerLifecycle({
    server,
    sessionService,
    coordinator,
    activation: Object.freeze({ testOnly: true }),
  });
  return Object.freeze({ managed, events });
}

const normalLifecycle = lifecycleFixture();
assert.deepEqual(await normalLifecycle.managed.start(), {
  address: "127.0.0.1",
  port: 18009,
  family: "IPv4",
});
const [firstClose, repeatedClose] = await Promise.all([
  normalLifecycle.managed.close({ timeoutMs: 250 }),
  normalLifecycle.managed.close({ timeoutMs: 250 }),
]);
assert.deepEqual(firstClose, { closed: true, forced: false });
assert.deepEqual(repeatedClose, firstClose);
assert.deepEqual(normalLifecycle.events, [
  "http-start",
  { stage: "http-close", options: { timeoutMs: 250 } },
  "http-closed",
  { stage: "session-close", options: { mode: "abort", timeoutMs: 250 } },
  "session-closed",
  "coordinator-closed",
]);

const invalidCloseLifecycle = lifecycleFixture();
await assert.rejects(
  () => invalidCloseLifecycle.managed.close({ timeoutMs: 99 }),
  (error) => error.code === "ANALYSIS_CLOSE_INVALID"
);
assert.deepEqual(invalidCloseLifecycle.events, []);
await invalidCloseLifecycle.managed.close({ timeoutMs: 100 });

const listenFailure = new Error("synthetic listener failure");
const failedStartLifecycle = lifecycleFixture({ startError: listenFailure });
await assert.rejects(() => failedStartLifecycle.managed.start(), (error) => error === listenFailure);
assert.deepEqual(failedStartLifecycle.events, [
  "http-start",
  { stage: "http-close", options: { timeoutMs: 5_000 } },
  "http-closed",
  { stage: "session-close", options: { mode: "abort", timeoutMs: 5_000 } },
  "session-closed",
  "coordinator-closed",
]);

const httpCloseFailure = new Error("synthetic HTTP close failure");
const failedCloseLifecycle = lifecycleFixture({ serverCloseError: httpCloseFailure });
await assert.rejects(
  () => failedCloseLifecycle.managed.close({ timeoutMs: 500 }),
  (error) => error === httpCloseFailure
);
assert.deepEqual(failedCloseLifecycle.events, [
  { stage: "http-close", options: { timeoutMs: 500 } },
  "http-closed",
  { stage: "session-close", options: { mode: "abort", timeoutMs: 500 } },
  "session-closed",
  "coordinator-closed",
]);

const proof = startupProof();
const serviceCalls = [];
const idempotencyCalls = [];
const sessionService = createSessionService(proof, serviceCalls);
const idempotencyStore = createIdempotencyStore(idempotencyCalls);
const policy = buildFixedIntegrationPolicy();
await assert.rejects(
  () =>
    createIntegrationAnalysisRouterActivation({
      sessionService,
      idempotencyStore,
      startupProof: proof,
      policy,
      stateRoot: checkedConfig.stateRoot,
      idempotencyRoot: checkedConfig.idempotencyRoot,
      statePersistenceMode: checkedConfig.statePersistence.mode,
    }),
  (error) => error.code === "AGENT_UNAVAILABLE" && /dependency identity/iu.test(error.message),
  "production activation must reject structurally convincing but unbranded dependencies"
);
const trustedPrincipalProxyClient = createIntegrationAnalysisTrustedProxyClient(checkedConfig, TOKEN);
assert.throws(
  () =>
    createIntegrationAnalysisServer({
      config: checkedConfig,
      trustedPrincipalProxyClient,
      activation: Object.freeze({
        schemaVersion: INTEGRATION_ANALYSIS_ROUTER_ACTIVATION_SCHEMA_VERSION,
        digest: contractDigest("forged-activation"),
      }),
    }),
  (error) => error.code === "AGENT_UNAVAILABLE",
  "the fixed listener must reject an activation that was not minted from exact production dependencies"
);
assert.throws(
  () => createActivatedIntegrationAnalysisRouter({ activation: Object.freeze({}) }),
  (error) => error.code === "AGENT_UNAVAILABLE"
);

console.log("smoke-integration-analysis-api-server ok");
