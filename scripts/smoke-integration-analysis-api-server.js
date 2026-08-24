import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
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
  loadIntegrationAnalysisServiceConfig,
  parseIntegrationAnalysisGroundedSearchCredential,
  parseIntegrationAnalysisLocalModelCredential,
  publicIntegrationAnalysisServiceConfig,
  validateIntegrationAnalysisServiceConfig,
} from "../src/integration-analysis-config.js";
import {
  INTEGRATION_ANALYSIS_SERVER_ENABLED,
  createIntegrationAnalysisServer,
  createTestOnlyIntegrationAnalysisServerLifecycle,
  integrationAnalysisListenOptions,
  composeProductionIntegrationAnalysisServer,
} from "../src/integration-analysis-server.js";
import {
  INTEGRATION_GROUNDED_SEARCH_ENDPOINT,
  INTEGRATION_GROUNDED_SEARCH_TIMEOUT_MS,
} from "../src/integration-grounded-search.js";
import { parseIntegrationAnalysisCliArguments } from "../src/integration-analysis-cli.js";
import { INTEGRATION_RPC_PATH_LIST, INTEGRATION_RPC_PATHS, buildFixedIntegrationPolicy, contractDigest } from "../src/integration-policy.js";

const TOKEN = "A".repeat(48);
const PRINCIPAL = "principal-analysis-0001";
const BROWSER_SESSION = "b".repeat(64);
const IDEMPOTENCY_KEY = "analysis-create-0001";
const THREAD_ID = "thr_12345678-1234-4123-8123-123456789abc";
const AT = "2026-08-24T00:00:00.000Z";
const ZERO_DIGEST = "0".repeat(64);

function validConfig(overrides = {}) {
  return {
    schemaVersion: INTEGRATION_ANALYSIS_SERVICE_CONFIG_SCHEMA_VERSION,
    capability: { enabled: true, mode: "analysis-execution" },
    listen: { host: INTEGRATION_ANALYSIS_LISTEN_HOST, port: INTEGRATION_ANALYSIS_LISTEN_PORT },
    stateRoot: DEFAULT_INTEGRATION_ANALYSIS_SERVICE_STATE_ROOT,
    idempotencyRoot: DEFAULT_INTEGRATION_ANALYSIS_IDEMPOTENCY_ROOT,
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

const checkedConfig = validateIntegrationAnalysisServiceConfig(validConfig());
assert.equal(checkedConfig.capability.enabled, true);
assert.equal(checkedConfig.trustedPrincipalProxy.clientId, "aginti-bff");
assert.deepEqual(integrationAnalysisListenOptions(checkedConfig), {
  host: "127.0.0.1",
  port: 18009,
  exclusive: true,
});
assert.equal(INTEGRATION_ANALYSIS_SERVER_ENABLED, true);
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
assert.equal(
  publicIntegrationAnalysisServiceConfig(enabledSearchConfig).groundedSearchCredentialName,
  INTEGRATION_ANALYSIS_GROUNDED_SEARCH_CREDENTIAL_NAME
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: enabledSearchConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: enabledSearchConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    groundedSearchApiKey: TOKEN,
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);
await assert.rejects(
  () => composeProductionIntegrationAnalysisServer({
    config: disabledSearchConfig,
    trustedPrincipalProxyClient: {},
    localModelApiKey: TOKEN,
    groundedSearchApiKey: TOKEN,
  }),
  (error) => error.code === "ANALYSIS_CREDENTIAL_INVALID"
);

const serverCompositionSource = await fs.readFile(
  new URL("../src/integration-analysis-server.js", import.meta.url),
  "utf8"
);
assert.equal(
  serverCompositionSource.match(/await planner\.activate\(\)/gu)?.length,
  1,
  "production composition must activate its bound planner exactly once"
);
assert.match(
  serverCompositionSource,
  /plannerActivation,\s*\n\s*\}\);/u,
  "production sessions must receive the branded planner activation"
);
assert.doesNotMatch(
  serverCompositionSource,
  /activationProof:\s*startupProof/u,
  "production sessions must not accept a detached readiness proof"
);
assert.match(
  serverCompositionSource,
  /groundedSearchConfig:[\s\S]*?apiKey:\s*options\.groundedSearchApiKey/u,
  "grounded search must use its distinct systemd credential"
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
