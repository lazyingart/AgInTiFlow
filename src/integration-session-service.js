import {
  INTEGRATION_API_PREFIX,
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
  contractDigest,
  validateIntegrationBrowserSessionBinding,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
  sanitizePublicIntegrationRun,
  sanitizePublicIntegrationThread,
} from "./integration-api.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { authorityFail } from "./integration-durable-common.js";
import { assertPublicIntegrationRunCursorMatchesLedger } from "./integration-events.js";

export const NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION = "aginti-native-integration-runtime-authority-v1";
export const NATIVE_INTEGRATION_EVENT_STORE_PROOF_VERSION = "aginti-public-integration-event-ledger-attestation-v1";

const ZERO_DIGEST = "0".repeat(64);

function requireRuntimeMethod(runtime, method) {
  if (!runtime || typeof runtime[method] !== "function") {
    authorityFail("AGENT_UNAVAILABLE", "Native AgInTi integration runtime authority is unavailable.");
  }
  return runtime[method].bind(runtime);
}

function contextScope(context = {}) {
  return Object.freeze({
    principalId: context.principalId,
    browserSessionId: context.browserSessionId,
    policy: context.policy,
    abortSignal: context.abortSignal,
  });
}

function stableDigest(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    authorityFail("AGENT_UNAVAILABLE", `${label} is not a stable digest.`);
  }
  return value;
}

function assertRuntimeRevision(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) authorityFail("AGENT_UNAVAILABLE", `${label} is invalid.`);
  return value;
}

function assertAuthorityMetadata(record = {}, label) {
  const authority = record.authority || {};
  if (authority.kind !== "aginti") authorityFail("AGENT_UNAVAILABLE", `${label} authority is not AgInTi.`);
  assertRuntimeRevision(authority.runtimeRevision, `${label} runtimeRevision`);
  stableDigest(authority.contextDigest, `${label} contextDigest`);
  if (label === "thread") {
    if (!Object.prototype.hasOwnProperty.call(authority, "lastCompaction")) {
      authorityFail("AGENT_UNAVAILABLE", "thread compaction metadata is missing.");
    }
    if (authority.lastCompaction) {
      stableDigest(authority.lastCompaction.digest, "thread compaction digest");
    }
  }
  if (label === "run") stableDigest(authority.snapshotHash, "run snapshotHash");
}

function stripBrowserBinding(record = {}) {
  const {
    browserSessionId: _browserSessionId,
    ownerBrowserSessionId: _ownerBrowserSessionId,
    policyBrowserSessionId: _policyBrowserSessionId,
    initiatingBrowserSessionId: _initiatingBrowserSessionId,
    activeBrowserSessionId: _activeBrowserSessionId,
    browserSessionPolicy: _browserSessionPolicy,
    browserSessionBinding: _browserSessionBinding,
    ...publicRecord
  } = record;
  return publicRecord;
}

function notFound(label) {
  authorityFail("NOT_FOUND", `${label} was not found.`, { status: 404 });
}

function assertBrowserSessionBinding(record = {}, context = {}, label = "Resource") {
  return validateIntegrationBrowserSessionBinding(record, context, { label, requireBound: true });
}

function ownedThread(record, context, expectedThreadId = "") {
  if (record?.principalId !== context.principalId) notFound("Thread");
  if (expectedThreadId && record?.id !== expectedThreadId) notFound("Thread");
  const binding = assertBrowserSessionBinding(record, context, "Thread");
  assertAuthorityMetadata(record, "thread");
  const checked = sanitizePublicIntegrationThread({ ...stripBrowserBinding(record), principalId: context.principalId }, {
    publicContract: true,
    principalId: context.principalId,
    browserSessionId: context.browserSessionId,
  });
  return Object.freeze({
    ...checked,
    principalId: context.principalId,
    browserSessionId: binding.browserSessionId,
    browserSessionPolicy: binding.policy,
  });
}

function ownedRun(record, context, expectedRunId = "") {
  if (record?.principalId !== context.principalId) notFound("Run");
  if (expectedRunId && record?.id !== expectedRunId) notFound("Run");
  const binding = assertBrowserSessionBinding(record, context, "Run");
  assertAuthorityMetadata(record, "run");
  const checked = sanitizePublicIntegrationRun({ ...stripBrowserBinding(record), principalId: context.principalId }, {
    publicContract: true,
    principalId: context.principalId,
    browserSessionId: context.browserSessionId,
  });
  return Object.freeze({
    ...checked,
    principalId: context.principalId,
    browserSessionId: binding.browserSessionId,
    browserSessionPolicy: binding.policy,
  });
}

function ownedArtifact(record, context, expected = {}) {
  if (record?.principalId !== context.principalId) notFound("Artifact");
  const binding = assertBrowserSessionBinding(record, context, "Artifact");
  if (expected.threadId && record.threadId !== expected.threadId) notFound("Artifact");
  if (expected.runId && record.runId !== expected.runId) notFound("Artifact");
  const checked = sanitizeIntegrationArtifact({
    id: record.id,
    title: record.title,
    kind: record.kind,
    type: record.type,
    spec: record.spec,
    markdown: record.markdown,
    content: record.content,
    columns: record.columns,
    rows: record.rows,
    table: record.table,
    plot: record.plot,
  });
  return Object.freeze({
    ...checked,
    principalId: context.principalId,
    browserSessionId: binding.browserSessionId,
    browserSessionPolicy: binding.policy,
    threadId: record.threadId || "",
    runId: record.runId || "",
  });
}

function assertNoAdapterSemantics(runtime = {}) {
  for (const forbidden of [
    "plan",
    "createPlan",
    "compactContext",
    "summarize",
    "runTool",
    "executeTool",
    "executeDocker",
    "callModel",
    "completeWithModel",
  ]) {
    if (forbidden in Object(runtime)) {
      authorityFail("AGENT_UNAVAILABLE", "Runtime adapter exposes semantic agent operations.");
    }
  }
}

function fullIsolationAttestation(proof = {}) {
  const attestation = {};
  const source = proof.isolationAttestation || {};
  for (const key of ["profileVersion", "profileDigest", ...REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS]) {
    attestation[key] = source[key];
  }
  return attestation;
}

function validateRuntimeProof(proof = {}) {
  if (
    proof.schemaVersion !== NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION ||
    proof.owner !== "aginti" ||
    proof.stableSessionIds !== true ||
    proof.runtimeRevisions !== true ||
    proof.contextDigests !== true ||
    proof.compactionMetadata !== true ||
    proof.adaptersAreTransportOnly !== true ||
    proof.noRawEvents !== true ||
    proof.publicArtifactsOnly !== true ||
    typeof proof.noHostedProviders !== "boolean" ||
    typeof proof.noWrappers !== "boolean" ||
    typeof proof.noMcp !== "boolean" ||
    typeof proof.noWeb !== "boolean"
  ) {
    authorityFail("AGENT_UNAVAILABLE", "Native AgInTi runtime proof is unavailable.");
  }
  return proof;
}

function validateSandboxProof(proof = {}) {
  const sandbox = proof.sandboxPrerequisites || {};
  if (
    sandbox.owner !== "aginti" ||
    typeof sandbox.valid !== "boolean" ||
    typeof sandbox.enabled !== "boolean" ||
    typeof sandbox.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sandbox.digest)
  ) {
    authorityFail("AGENT_UNAVAILABLE", "Native AgInTi sandbox proof is unavailable.");
  }
  return sandbox;
}

async function eventStoreProof(eventLedgerStore) {
  if (!eventLedgerStore || eventLedgerStore.owner !== "aginti" || typeof eventLedgerStore.attest !== "function") {
    return Object.freeze({
      schemaVersion: NATIVE_INTEGRATION_EVENT_STORE_PROOF_VERSION,
      owner: "",
      authority: "",
      durable: false,
      persisted: false,
      contiguous: false,
      monotonic: false,
      bridgeOwned: true,
      mappingVersion: "",
      digest: contractDigest({ missing: true }),
    });
  }
  const proof = await eventLedgerStore.attest();
  const expectedDigest = contractDigest({
    schemaVersion: proof.schemaVersion,
    owner: proof.owner,
    authority: proof.authority,
    durable: proof.durable,
    persisted: proof.persisted,
    contiguous: proof.contiguous,
    monotonic: proof.monotonic,
    bridgeOwned: proof.bridgeOwned,
    mappingVersion: proof.mappingVersion,
    maxEvents: proof.maxEvents,
    maxBytes: proof.maxBytes,
  });
  if (
    proof.schemaVersion !== NATIVE_INTEGRATION_EVENT_STORE_PROOF_VERSION ||
    proof.owner !== "aginti" ||
    proof.authority !== "aginti" ||
    proof.durable !== true ||
    proof.persisted !== true ||
    proof.contiguous !== true ||
    proof.monotonic !== true ||
    proof.bridgeOwned !== false ||
    typeof proof.mappingVersion !== "string" ||
    proof.digest !== expectedDigest
  ) {
    return Object.freeze({
      schemaVersion: NATIVE_INTEGRATION_EVENT_STORE_PROOF_VERSION,
      owner: "",
      authority: "",
      durable: false,
      persisted: false,
      contiguous: false,
      monotonic: false,
      bridgeOwned: true,
      mappingVersion: "",
      digest: contractDigest({ malformed: true }),
    });
  }
  return Object.freeze(proof);
}

function unwrapResult(value, key) {
  return value?.[key] || value;
}

function integrationAuthorityFromProof(proof = {}, eventProof = {}) {
  const sandbox = validateSandboxProof(proof);
  return Object.freeze({
    owner: "aginti",
    apiPrefix: INTEGRATION_API_PREFIX,
    sessions: "aginti",
    planning: "aginti",
    contextCompaction: "aginti",
    tools: "aginti",
    dockerExecution: "aginti",
    cancellation: "aginti",
    idempotency: "aginti",
    idempotencyContractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
    eventLedger: "aginti",
    eventLedgerPersisted: eventProof.persisted === true,
    artifacts: "aginti",
    adaptersAreTransportOnly: proof.adaptersAreTransportOnly === true,
    noHostedProviders: proof.noHostedProviders === true,
    noWrappers: proof.noWrappers === true,
    noMcp: proof.noMcp === true,
    noWeb: proof.noWeb === true,
    sandboxPrerequisites: Object.freeze({
      owner: sandbox.owner,
      valid: sandbox.valid === true,
      enabled: sandbox.enabled === true,
      digest: sandbox.digest,
    }),
    eventStoreProofDigest: eventProof.digest || ZERO_DIGEST,
    proofDigest: contractDigest({ runtime: proof, eventStore: eventProof }),
  });
}

export function createNativeIntegrationSessionService(options = {}) {
  const runtime = options.runtimeAuthority || null;
  const eventLedgerStore = options.eventLedgerStore || null;

  async function runtimeProof() {
    assertNoAdapterSemantics(runtime || {});
    const getProof = requireRuntimeMethod(runtime, "getIntegrationRuntimeProof");
    return validateRuntimeProof(await getProof());
  }

  async function call(method, payload, context) {
    await runtimeProof();
    const fn = requireRuntimeMethod(runtime, method);
    return fn(payload, contextScope(context));
  }

  async function loadRawOwnedThread(threadId, context) {
    const id = validateIntegrationThreadId(threadId);
    const thread = unwrapResult(await call("getIntegrationThread", { threadId: id }, context), "thread");
    return Object.freeze({ raw: thread, public: ownedThread(thread, context, id) });
  }

  async function loadRawOwnedRun(runId, context) {
    const id = validateIntegrationRunId(runId);
    const run = unwrapResult(await call("getIntegrationRunStatus", { runId: id }, context), "run");
    return Object.freeze({ raw: run, public: ownedRun(run, context, id) });
  }

  async function ledgerForPublicRun(run, context) {
    if (!eventLedgerStore || eventLedgerStore.owner !== "aginti" || typeof eventLedgerStore.ledgerForRun !== "function") {
      authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Native AgInTi public event ledger is unavailable.");
    }
    return eventLedgerStore.ledgerForRun({
      principalId: context.principalId,
      browserSessionId: context.browserSessionId,
      browserSessionPolicy: "same-browser-session",
      threadId: run.threadId,
      runId: run.id,
    });
  }

  async function ownedRunWithLedger(record, context, expectedRunId = "") {
    const run = ownedRun(record, context, expectedRunId);
    await assertPublicIntegrationRunCursorMatchesLedger(run, await ledgerForPublicRun(run, context));
    return run;
  }

  return Object.freeze({
    async getIntegrationCapabilities() {
      const proof = await runtimeProof();
      const events = await eventStoreProof(eventLedgerStore);
      return Object.freeze({
        nativeIntegrationAuthority: integrationAuthorityFromProof(proof, events),
        isolationAttestationAuthority: "aginti",
        isolationAttestation: fullIsolationAttestation(proof),
        cancel: true,
        resume: true,
      });
    },

    async listThreads(payload, context) {
      const result = await call("listIntegrationThreads", payload, context);
      return Object.freeze({
        threads: Object.freeze((result.threads || []).map((thread) => ownedThread(thread, context))),
        nextBefore: result.nextBefore || null,
      });
    },

    async createThread(payload, context) {
      const thread = await call("createIntegrationThread", payload, context);
      return Object.freeze({ thread: ownedThread(thread.thread || thread, context) });
    },

    async getThread(payload, context) {
      const thread = await loadRawOwnedThread(payload.threadId, context);
      return Object.freeze({ thread: thread.public });
    },

    async updateThread(payload, context) {
      await loadRawOwnedThread(payload.threadId, context);
      const thread = await call("updateIntegrationThread", payload, context);
      return Object.freeze({ thread: ownedThread(thread.thread || thread, context, payload.threadId) });
    },

    async deleteThread(payload, context) {
      await loadRawOwnedThread(payload.threadId, context);
      const result = await call("deleteIntegrationThread", payload, context);
      if (result.thread) ownedThread(result.thread, context, payload.threadId);
      return Object.freeze({ deleted: true, threadId: payload.threadId, principalId: context.principalId });
    },

    async startRun(payload, context) {
      await loadRawOwnedThread(payload.threadId, context);
      const run = await call("startIntegrationRun", payload, context);
      const publicRun = await ownedRunWithLedger(run.run || run, context);
      if (publicRun.threadId !== payload.threadId) notFound("Run");
      return Object.freeze({ run: publicRun });
    },

    async getRunStatus(payload, context) {
      const run = (await loadRawOwnedRun(payload.runId, context)).raw;
      return Object.freeze({ run: await ownedRunWithLedger(run, context, payload.runId) });
    },

    async loadRunEvents(payload, context) {
      validateIntegrationRunId(payload.runId);
      if (!eventLedgerStore || eventLedgerStore.owner !== "aginti" || typeof eventLedgerStore.ledgerForRun !== "function") {
        authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Native AgInTi public event ledger is unavailable.");
      }
      const run = await ownedRunWithLedger((await loadRawOwnedRun(payload.runId, context)).raw, context, payload.runId);
      return Object.freeze({
        run,
        publicEventLedger: await ledgerForPublicRun(run, context),
        once: true,
        streamMs: 1000,
        pollMs: 50,
      });
    },

    async cancelRun(payload, context) {
      const currentRecord = (await loadRawOwnedRun(payload.runId, context)).raw;
      assertBrowserSessionBinding(currentRecord, context, "Run");
      const run = await call("cancelIntegrationRun", payload, context);
      return Object.freeze({ run: await ownedRunWithLedger(run.run || run, context, payload.runId) });
    },

    async resumeRun(payload, context) {
      await loadRawOwnedRun(payload.runId, context);
      const run = await call("resumeIntegrationRun", payload, context);
      const publicRun = await ownedRunWithLedger(run.run || run, context);
      if (publicRun.previousRunId !== payload.runId) notFound("Run");
      return Object.freeze({ run: publicRun });
    },

    async listArtifacts(payload, context) {
      const result = await call("listIntegrationArtifacts", payload, context);
      const artifacts = [];
      for (const artifact of result.artifacts || []) {
        try {
          artifacts.push(ownedArtifact(artifact, context, payload));
        } catch (error) {
          if ((error.code || error.publicCode) !== "NOT_FOUND") throw error;
        }
      }
      return Object.freeze({
        artifacts: Object.freeze(artifacts),
      });
    },

    async getArtifact(payload, context) {
      const result = await call("getIntegrationArtifact", payload, context);
      return Object.freeze({ artifact: ownedArtifact(result.artifact || result, context) });
    },
  });
}

export function publicThreadRecord(overrides = {}) {
  return Object.freeze({
    id: overrides.id,
    principalId: overrides.principalId,
    title: overrides.title || "New agent thread",
    status: overrides.status || "idle",
    revision: overrides.revision || 1,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    lastRunId: overrides.lastRunId || null,
    authority: Object.freeze({
      kind: "aginti",
      mapped: true,
      runtimeRevision: overrides.runtimeRevision || 1,
      contextDigest: overrides.contextDigest || ZERO_DIGEST,
      lastCompaction: overrides.lastCompaction ?? null,
    }),
    replay: Object.freeze({ prunedMessageCount: 0, anchorDigest: overrides.anchorDigest || ZERO_DIGEST }),
    messages: Object.freeze([]),
  });
}
