import assert from "node:assert/strict";

import {
  EXECUTION_WORKER_API_SCHEMA_VERSION,
  EXECUTION_WORKER_RPC_PATHS,
} from "../src/execution-worker-api.js";
import { createExecutionJobManager } from "../src/execution-worker-jobs.js";
import {
  EXECUTION_LIMITS,
  EXECUTION_RESULT_SCHEMA_VERSION,
  EXECUTION_WORKER_SCHEMA_VERSION,
  validateExecutionResult,
} from "../src/execution-worker.js";
import {
  createTestOnlyExecutionWorkerClient,
  createSystemdExecutionWorkerClient,
  loadExecutionWorkerSystemdCredential,
  validateExecutionWorkerSystemdCredentialMetadata,
} from "../src/execution-worker-client.js";
import {
  INTEGRATION_ANALYSIS_TOOL_NAME,
  createTestOnlyIntegrationAnalysisCoordinator,
} from "../src/integration-analysis-coordinator.js";
import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import { projectCoreEvent } from "../src/integration-core-event-projector.js";
import { contractDigest } from "../src/integration-policy.js";

const PRINCIPAL_ID = "principal_analysis_smoke_001";
const BROWSER_SESSION_ID = "a".repeat(64);
const THREAD_ID = "thr_00000000-0000-4000-8000-000000000041";
const RUN_ID = "run_00000000-0000-4000-8000-000000000042";
const WORKER_ID = "worker_analysis_smoke_000000000001";
const POLICY_DIGEST = "b".repeat(64);
const RUNTIME_DIGEST = "c".repeat(64);
const PROOF_DIGEST = "d".repeat(64);
const SECCOMP_DIGEST = "e".repeat(64);
const BUNDLE_DIGEST = "f".repeat(64);
const CGROUP_DIGEST = "1".repeat(64);

function capability({
  aggregateCgroupVerified = true,
  requiresAggregateCgroupContainment = true,
  testOnlyBypassConfigured = false,
} = {}) {
  const core = Object.freeze({
    schemaVersion: EXECUTION_WORKER_SCHEMA_VERSION,
    workerId: WORKER_ID,
    implementation: "aginti-execution-worker",
    implementationVersion: "1",
    runtime: Object.freeze({
      profile: "python-bwrap-netless-v1",
      policyDigest: POLICY_DIGEST,
      runtimeDigest: RUNTIME_DIGEST,
      proofDigest: PROOF_DIGEST,
      seccomp: true,
      seccompPolicyVerified: true,
      seccompPolicyDigest: SECCOMP_DIGEST,
      deniedSyscallsProven: true,
      minimalRuntimeRoot: true,
      runtimeBundleDigestPinned: true,
      runtimeBundleRootDigest: BUNDLE_DIGEST,
    }),
    containment: Object.freeze({
      aggregateCgroupVerified,
      cgroupPolicyDigest: CGROUP_DIGEST,
    }),
    languages: Object.freeze(["python"]),
    artifacts: Object.freeze({ schemaVersion: "1", kinds: Object.freeze(["plot", "table", "markdown"]) }),
    limits: EXECUTION_LIMITS,
    executionGate: Object.freeze({
      requiresVerifiedSeccompPolicy: true,
      requiresAggregateCgroupContainment,
      testOnlyBypassConfigured,
    }),
  });
  const capabilityDigest = contractDigest(core);
  const admission = Object.freeze({ state: "ready", activeJobs: 0, maximumConcurrentJobs: 2 });
  const activation = Object.freeze({ publicReady: true, blockers: Object.freeze([]) });
  return Object.freeze({
    ...core,
    ready: true,
    admission,
    activation,
    capabilityDigest,
    healthDigest: contractDigest({ capabilityDigest, ready: true, admission, activation }),
  });
}

function artifactId(request, index, artifact) {
  return `art_${contractDigest({
    jobId: request.jobId,
    attempt: request.attempt,
    index,
    kind: artifact.kind,
    title: artifact.title,
    spec: artifact.spec,
  }).slice(0, 64)}`;
}

function resultArtifacts(request) {
  const withoutIds = [
    Object.freeze({
      title: "Computed trend",
      kind: "plot",
      spec: Object.freeze({
        schemaVersion: "1",
        type: "line",
        xLabel: "Sample",
        yLabel: "Value",
        labels: Object.freeze(["A", "B", "C"]),
        series: Object.freeze([
          Object.freeze({ name: "Result", data: Object.freeze([1, 4, 9]) }),
        ]),
      }),
    }),
    Object.freeze({
      title: "Computed values",
      kind: "table",
      spec: Object.freeze({
        schemaVersion: "1",
        columns: Object.freeze([
          Object.freeze({ key: "sample", label: "Sample" }),
          Object.freeze({ key: "value", label: "Value" }),
        ]),
        rows: Object.freeze([
          Object.freeze({ sample: "A", value: 1 }),
          Object.freeze({ sample: "B", value: 4 }),
          Object.freeze({ sample: "C", value: 9 }),
        ]),
      }),
    }),
    Object.freeze({
      title: "Analysis note",
      kind: "markdown",
      spec: Object.freeze({ schemaVersion: "1", markdown: "The values follow a square-number pattern." }),
    }),
  ];
  return Object.freeze(withoutIds.map((item, index) => sanitizeIntegrationArtifact({
    id: artifactId(request, index, item),
    ...item,
  })));
}

function terminalResult(request, status = "succeeded") {
  const artifacts = status === "succeeded" ? resultArtifacts(request) : Object.freeze([]);
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status,
    exitCode: status === "succeeded" ? 0 : null,
    stdout: status === "succeeded" ? "analysis complete\n" : "",
    stderr: "",
    outputTruncated: false,
    durationMs: 20,
    artifacts,
  });
  return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
}

function fakeWorker({
  cgroupReady = true,
  requiresAggregateCgroupContainment = true,
  testOnlyBypassConfigured = false,
  delayMs = 20,
} = {}) {
  return Object.freeze({
    capabilities: async () => capability({
      aggregateCgroupVerified: cgroupReady,
      requiresAggregateCgroupContainment,
      testOnlyBypassConfigured,
    }),
    async execute(request, { signal } = {}) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener?.("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return terminalResult(request, signal?.aborted ? "cancelled" : "succeeded");
    },
  });
}

function rpcForManager(manager, mutate = null, calls = []) {
  return async (pathname, body) => {
    calls.push(Object.freeze({ pathname, body }));
    let response;
    if (pathname === EXECUTION_WORKER_RPC_PATHS.capabilities) response = await manager.capabilities();
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart) response = await manager.start(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStatus) response = manager.status(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsEvents) response = manager.events(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsCancel) response = manager.cancel(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsList) response = manager.listArtifacts(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsGet) response = manager.getArtifact(body);
    else throw new Error("unexpected path");
    const envelope = {
      schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION,
      response,
    };
    return mutate ? mutate(pathname, structuredClone(envelope)) : envelope;
  };
}

function scope() {
  return Object.freeze({
    principalId: PRINCIPAL_ID,
    browserSessionId: BROWSER_SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
  });
}

async function successfulExecution() {
  const calls = [];
  const manager = createExecutionJobManager({ worker: fakeWorker() });
  const client = createTestOnlyExecutionWorkerClient(rpcForManager(manager, null, calls));
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(client, { pollMs: 25 });
  const readiness = await coordinator.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.publicActivationReady, true);
  assert.equal(readiness.cgroupPolicyDigest, CGROUP_DIGEST);
  assert.match(readiness.digest, /^[a-f0-9]{64}$/u);
  const seenArtifacts = [];
  const request = {
    source: "emit_plot('Computed trend', 'line', ['A', 'B', 'C'], [{'name':'Result','data':[1,4,9]}])",
    stdin: "",
    timeoutMs: 1_000,
  };
  const result = await coordinator.execute(scope(), request, {
    onArtifact(artifact) {
      seenArtifacts.push(artifact);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.toolName, INTEGRATION_ANALYSIS_TOOL_NAME);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["plot", "table", "markdown"]);
  assert.deepEqual(seenArtifacts, result.artifacts);
  const projected = projectCoreEvent(
    "artifact.available",
    { artifact: seenArtifacts[0] },
    { runId: RUN_ID, createdAt: "2026-08-24T00:00:00.000Z" }
  );
  assert.equal(projected.type, "artifact.created");
  assert.deepEqual(projected.payload.artifact, seenArtifacts[0]);
  assert.equal(projectCoreEvent(
    "artifact.available",
    { artifact: { ...seenArtifacts[2], spec: { schemaVersion: "1", markdown: "[secret](file:///etc/passwd)" } } },
    { runId: RUN_ID, createdAt: "2026-08-24T00:00:00.000Z" }
  ), null);
  assert.equal(result.stdout, "analysis complete\n");
  assert(calls.some(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsEvents));
  assert.equal(calls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.artifactsGet).length, 3);
  const start = calls.find(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).body;
  assert.deepEqual(Object.keys(start).sort(), [
    "attempt",
    "jobId",
    "language",
    "schemaVersion",
    "source",
    "sourceSha256",
    "stdin",
    "timeoutMs",
  ]);
  assert.equal(JSON.stringify(start).includes("token"), false);
  assert.equal(JSON.stringify(start).includes("url"), false);
  const replayed = await coordinator.execute(scope(), request);
  assert.deepEqual(replayed, result);
  const starts = calls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].body, starts[0].body);
  coordinator.close();
}

async function publicActivationGates() {
  for (const worker of [
    fakeWorker({ cgroupReady: false }),
    fakeWorker({ requiresAggregateCgroupContainment: false }),
    fakeWorker({ testOnlyBypassConfigured: true }),
  ]) {
    const manager = createExecutionJobManager({ worker });
    const client = createTestOnlyExecutionWorkerClient(rpcForManager(manager));
    const coordinator = createTestOnlyIntegrationAnalysisCoordinator(client, { pollMs: 25 });
    await assert.rejects(
      coordinator.execute(scope(), { source: "print(1)" }),
      (error) => error?.code === "EXECUTION_NOT_READY" && /unavailable/i.test(error.message)
    );
    coordinator.close();
  }
}

async function rejectsCallerTransportFields() {
  const manager = createExecutionJobManager({ worker: fakeWorker() });
  const client = createTestOnlyExecutionWorkerClient(rpcForManager(manager));
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(client, { pollMs: 25 });
  await assert.rejects(
    coordinator.execute(scope(), {
      source: "print(1)",
      workerUrl: "https://attacker.invalid",
    }),
    (error) => error?.code === "EXECUTION_REQUEST_INVALID"
  );
  await assert.rejects(
    coordinator.execute({ ...scope(), token: "x".repeat(40) }, { source: "print(1)" }),
    (error) => error?.code === "EXECUTION_REQUEST_INVALID"
  );
  await assert.rejects(() => createSystemdExecutionWorkerClient({ endpoint: "http://attacker.invalid" }), {
    code: "EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN",
  });
  await assert.rejects(() => loadExecutionWorkerSystemdCredential("/tmp/token"), {
    code: "EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN",
  });
  coordinator.close();
}

function credentialMetadataAcceptsSystemdOwnership() {
  const base = {
    directory: {
      kind: "directory",
      uid: 1201,
      gid: 1202,
      mode: 0o700,
      nlink: 2,
      size: 80,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    },
    credential: {
      kind: "credential",
      uid: 1201,
      gid: 1202,
      mode: 0o400,
      nlink: 1,
      size: 64,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    },
  };
  assert.equal(validateExecutionWorkerSystemdCredentialMetadata(base, {
    effectiveUid: 1201,
    effectiveGid: 1202,
    mountReadOnly: true,
  }), true);
  assert.equal(validateExecutionWorkerSystemdCredentialMetadata({
    directory: { ...base.directory, uid: 0, gid: 0, mode: 0o550 },
    credential: { ...base.credential, uid: 0, gid: 0, mode: 0o440 },
  }, {
    effectiveUid: 1201,
    effectiveGid: 1202,
    mountReadOnly: true,
  }), true);
  assert.throws(() => validateExecutionWorkerSystemdCredentialMetadata(base, {
    effectiveUid: 1201,
    effectiveGid: 1202,
    mountReadOnly: false,
  }), { code: "EXECUTION_CREDENTIAL_INVALID" });
  assert.throws(() => validateExecutionWorkerSystemdCredentialMetadata({
    ...base,
    credential: { ...base.credential, uid: 9999 },
  }, {
    effectiveUid: 1201,
    effectiveGid: 1202,
    mountReadOnly: true,
  }), { code: "EXECUTION_CREDENTIAL_INVALID" });
}

async function rejectsArtifactTamper() {
  const manager = createExecutionJobManager({ worker: fakeWorker() });
  const rpc = rpcForManager(manager, (pathname, envelope) => {
    if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsGet) {
      envelope.response.artifact.spec.markdown = "tampered";
    }
    return envelope;
  });
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(createTestOnlyExecutionWorkerClient(rpc), { pollMs: 25 });
  await assert.rejects(
    coordinator.execute(scope(), { source: "print(1)", timeoutMs: 1_000 }),
    (error) => error?.code === "EXECUTION_PROTOCOL_INVALID"
  );
  coordinator.close();
}

async function rejectsEventTamper() {
  const manager = createExecutionJobManager({ worker: fakeWorker({ delayMs: 75 }) });
  let tampered = false;
  const rpc = rpcForManager(manager, (pathname, envelope) => {
    if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsEvents && envelope.response.events.length && !tampered) {
      envelope.response.events[0].eventHash = "0".repeat(64);
      tampered = true;
    }
    return envelope;
  });
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(createTestOnlyExecutionWorkerClient(rpc), { pollMs: 25 });
  await assert.rejects(
    coordinator.execute(scope(), { source: "print(1)", timeoutMs: 1_000 }),
    (error) => error?.code === "EXECUTION_PROTOCOL_INVALID"
  );
  coordinator.close();
}

async function cancellationPropagates() {
  const calls = [];
  const manager = createExecutionJobManager({ worker: fakeWorker({ delayMs: 500 }) });
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(
    createTestOnlyExecutionWorkerClient(rpcForManager(manager, null, calls)),
    { pollMs: 25 }
  );
  const controller = new AbortController();
  const promise = coordinator.execute(scope(), { source: "print(1)", timeoutMs: 1_000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("test cancellation")), 40).unref?.();
  await assert.rejects(promise, (error) => error?.code === "EXECUTION_CANCELLED");
  assert(calls.some(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsCancel));
  coordinator.close();
}

await successfulExecution();
await publicActivationGates();
await rejectsCallerTransportFields();
credentialMetadataAcceptsSystemdOwnership();
await rejectsArtifactTamper();
await rejectsEventTamper();
await cancellationPropagates();

console.log("integration analysis coordinator smoke passed");
