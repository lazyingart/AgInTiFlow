import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";

import {
  EXECUTION_JOB_SCHEMA_VERSION,
  EXECUTION_LIMITS,
  EXECUTION_RESULT_SCHEMA_VERSION,
  EXECUTION_RUNTIME_PATHS,
  ExecutionWorkerError,
  buildExecutionWorkerCommand,
  createPythonExecutionWorker,
  executionJobRequestDigest,
  inspectExecutionWorkerRuntime,
  probeExecutionWorkerRuntime,
  validateExecutionJobRequest,
  validateExecutionResult,
} from "../src/execution-worker.js";
import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import { contractDigest } from "../src/integration-policy.js";
import {
  EXECUTION_ZERO_EVENT_HASH,
  createExecutionJobManager,
} from "../src/execution-worker-jobs.js";
import {
  EXECUTION_WORKER_API_SCHEMA_VERSION,
  EXECUTION_WORKER_MAX_REQUEST_BYTES,
  EXECUTION_WORKER_RPC_PATHS,
  createExecutionWorkerApiServer,
} from "../src/execution-worker-api.js";

const WORKER_ID = "worker_0123456789abcdefghijklmn";
let jobSequence = 0;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function job(source, overrides = {}) {
  jobSequence += 1;
  return {
    schemaVersion: EXECUTION_JOB_SCHEMA_VERSION,
    jobId: `job_${String(jobSequence).padStart(24, "0")}`,
    attempt: 1,
    language: "python",
    source,
    sourceSha256: sha256(source),
    stdin: "",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function expectWorkerError(callback, code) {
  assert.throws(callback, (error) => error instanceof ExecutionWorkerError && error.code === code);
}

const valid = job("print('validated')");
const normalized = validateExecutionJobRequest(valid);
assert(Object.isFrozen(normalized));
assert.equal(normalized.sourceSha256, sha256(valid.source));
assert.match(executionJobRequestDigest(valid), /^[a-f0-9]{64}$/u);

for (const field of ["command", "environment", "image", "mounts", "network", "runtime", "workingDirectory"]) {
  expectWorkerError(() => validateExecutionJobRequest({ ...valid, [field]: "forbidden" }), "EXECUTION_REQUEST_INVALID");
}
expectWorkerError(() => validateExecutionJobRequest({ ...valid, sourceSha256: "0".repeat(64) }), "EXECUTION_REQUEST_INVALID");
expectWorkerError(() => validateExecutionJobRequest({ ...valid, language: "shell" }), "EXECUTION_REQUEST_INVALID");
expectWorkerError(() => validateExecutionJobRequest({ ...valid, source: "x\0y", sourceSha256: sha256("x\0y") }), "EXECUTION_REQUEST_INVALID");
expectWorkerError(() => validateExecutionJobRequest({ ...valid, source: "x\u0001y", sourceSha256: sha256("x\u0001y") }), "EXECUTION_REQUEST_INVALID");
expectWorkerError(() => validateExecutionJobRequest({ ...valid, timeoutMs: EXECUTION_LIMITS.maximumWallTimeMs + 1 }), "EXECUTION_REQUEST_INVALID");
expectWorkerError(
  () => validateExecutionJobRequest({ ...valid, source: "x".repeat(EXECUTION_LIMITS.maximumSourceBytes + 1), sourceSha256: sha256("x".repeat(EXECUTION_LIMITS.maximumSourceBytes + 1)) }),
  "EXECUTION_REQUEST_INVALID"
);
const accessorRequest = { ...valid };
Object.defineProperty(accessorRequest, "source", { enumerable: true, get: () => valid.source });
expectWorkerError(() => validateExecutionJobRequest(accessorRequest), "EXECUTION_REQUEST_INVALID");
expectWorkerError(() => validateExecutionJobRequest(new Proxy(valid, {})), "EXECUTION_REQUEST_INVALID");

const command = buildExecutionWorkerCommand();
assert.equal(command.command, EXECUTION_RUNTIME_PATHS.bwrap);
assert(Object.isFrozen(command));
assert(Object.isFrozen(command.args));
for (const required of [
  "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
  "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
  "--ro-bind", "--proc", "--dev", "--tmpfs", "--chmod", "--uid", "65532", "--gid",
  EXECUTION_RUNTIME_PATHS.prlimit, EXECUTION_RUNTIME_PATHS.python, "-I", "-S", "-B", "-u",
]) {
  assert(command.args.includes(required), `sandbox command omitted ${required}`);
}
assert(command.args.indexOf(EXECUTION_RUNTIME_PATHS.prlimit) > command.args.indexOf("--gid"));
assert(!command.args.includes("--bind"));
assert(!command.args.includes("--share-net"));
for (const forbidden of ["/etc", "/home", "/root", "/sys", "/var", "/opt", "/srv", "/tmp", "/workspace"]) {
  assert(!command.args.includes(forbidden), `sandbox command exposed ${forbidden}`);
}
assert(!command.args.some((value) => /(?:^|\/)(?:ba)?sh$/u.test(value)), "sandbox launcher must enter the fixed Python runtime directly");

let identity;
let liveProof;
try {
  await Promise.all(Object.values(EXECUTION_RUNTIME_PATHS).map((pathname) => fs.access(pathname)));
  identity = await inspectExecutionWorkerRuntime();
  liveProof = await probeExecutionWorkerRuntime();
} catch (error) {
  if (process.env.AGINTI_EXECUTION_WORKER_REQUIRE_LIVE === "1") throw error;
  console.log(JSON.stringify({
    ok: true,
    live: false,
    skipped: "fixed Linux bwrap/Python runtime is unavailable",
  }));
  process.exit(0);
}
assert.equal(identity.profile, "python-bwrap-netless-v1");
assert.equal(identity.policy.hostDataMounts, false);
assert.equal(identity.policy.runtimeCredentials, false);
assert.equal(identity.policy.nestedUserNamespaces, false);
assert.equal(identity.policy.runtimeTree, "broad-read-only-host-runtime-bind");
assert.equal(identity.policy.childProcessExecution, "not-yet-restricted-inside-namespace");
assert.match(identity.policyDigest, /^[a-f0-9]{64}$/u);
assert.match(identity.runtimeDigest, /^[a-f0-9]{64}$/u);
assert.equal(identity.policy.limits.maximumWorkspaceBytes, 16 * 1024 * 1024);

assert.equal(liveProof.networkNone, true);
assert.equal(liveProof.nonRoot, true);
assert.equal(liveProof.capabilitiesDropped, true);
assert.equal(liveProof.noNewPrivileges, true);
assert.equal(liveProof.nestedUserNamespacesDisabled, true);
assert.match(liveProof.proofDigest, /^[a-f0-9]{64}$/u);

function successfulChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      child.stderr.end("\n\u001eAGINTI_ARTIFACTS_V1:[]\n");
      child.stdout.end();
      callback();
      queueMicrotask(() => child.emit("close", 0, null));
    },
  });
  child.kill = () => true;
  return child;
}

let releaseProbe;
let boundedProbeCalls = 0;
let boundedSpawns = 0;
const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
const boundedWorker = createPythonExecutionWorker({
  workerId: WORKER_ID,
  testOnlyAllowMissingSeccomp: true,
  runtimeProbeImpl: async () => {
    boundedProbeCalls += 1;
    await probeGate;
    return liveProof;
  },
  spawnImpl: () => {
    boundedSpawns += 1;
    return successfulChild();
  },
});
const boundedRuns = Array.from({ length: 20 }, (_, index) => boundedWorker.execute(job(`print(${index})`)));
const boundedSettlement = Promise.allSettled(boundedRuns);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(boundedProbeCalls, 1, "concurrent admissions must coalesce the runtime probe");
releaseProbe();
const boundedSettled = await boundedSettlement;
assert.equal(boundedSpawns, EXECUTION_LIMITS.maximumConcurrentJobs);
assert.equal(boundedSettled.filter(({ status }) => status === "fulfilled").length, EXECUTION_LIMITS.maximumConcurrentJobs);
assert.equal(
  boundedSettled.filter(({ status, reason }) => status === "rejected" && reason?.code === "EXECUTION_BUSY").length,
  20 - EXECUTION_LIMITS.maximumConcurrentJobs
);

const worker = createPythonExecutionWorker({ workerId: WORKER_ID, testOnlyAllowMissingSeccomp: true });
const capabilities = await worker.capabilities();
assert.equal(capabilities.ready, false);
assert.equal(capabilities.activation.publicReady, false);
assert.equal(capabilities.admission.state, "blocked");
assert.equal(capabilities.admission.activeJobs, 0);
assert.deepEqual(capabilities.languages, ["python"]);
assert.deepEqual(capabilities.artifacts.kinds, ["plot", "table", "markdown"]);
assert.match(capabilities.runtime.proofDigest, /^[a-f0-9]{64}$/u);
assert.match(capabilities.capabilityDigest, /^[a-f0-9]{64}$/u);
assert.match(capabilities.healthDigest, /^[a-f0-9]{64}$/u);
assert.equal(capabilities.executionGate.testOnlyBypassConfigured, true);

const productionGatedWorker = createPythonExecutionWorker({ workerId: WORKER_ID });
const productionGatedCapabilities = await productionGatedWorker.capabilities();
assert.equal(productionGatedCapabilities.ready, false);
assert.equal(productionGatedCapabilities.activation.publicReady, false);
assert(productionGatedCapabilities.activation.blockers.includes("public-activation-locked"));
await assert.rejects(
  () => productionGatedWorker.execute(job("print('blocked until the full service boundary is proven')")),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_UNAVAILABLE"
);

const artifactSource = `
print("analysis ready")
emit_plot("Squares", {
    "schemaVersion": "1",
    "type": "line",
    "labels": ["1", "2", "3"],
    "series": [{"name": "x squared", "data": [1, 4, 9]}],
})
emit_table("Values", {
    "schemaVersion": "1",
    "columns": [{"key": "x", "label": "x"}, {"key": "square", "label": "square"}],
    "rows": [{"x": 1, "square": 1}, {"x": 2, "square": 4}],
})
emit_markdown("Summary", "**Maximum:** 9")
`;
const artifactResult = await worker.execute(job(artifactSource));
assert.equal(artifactResult.status, "succeeded");
assert.equal(artifactResult.stdout, "analysis ready\n");
assert.equal(artifactResult.stderr, "");
assert.deepEqual(artifactResult.artifacts.map(({ kind }) => kind), ["plot", "table", "markdown"]);
assert(artifactResult.artifacts.every(Object.isFrozen));
assert.match(artifactResult.resultDigest, /^[a-f0-9]{64}$/u);
assert.deepEqual(validateExecutionResult(artifactResult, {
  jobId: artifactResult.jobId,
  attempt: artifactResult.attempt,
  sourceSha256: artifactResult.sourceSha256,
}), artifactResult);
assert.throws(
  () => validateExecutionResult({ ...artifactResult, resultDigest: "0".repeat(64) }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_RESULT_INVALID"
);
const forgedArtifacts = artifactResult.artifacts.map((artifact, index) => index === 0
  ? { ...artifact, id: `art_${"a".repeat(64)}` }
  : artifact);
const forgedUnsigned = {
  schemaVersion: artifactResult.schemaVersion,
  jobId: artifactResult.jobId,
  attempt: artifactResult.attempt,
  sourceSha256: artifactResult.sourceSha256,
  status: artifactResult.status,
  exitCode: artifactResult.exitCode,
  stdout: artifactResult.stdout,
  stderr: artifactResult.stderr,
  outputTruncated: artifactResult.outputTruncated,
  durationMs: artifactResult.durationMs,
  artifacts: forgedArtifacts,
};
assert.throws(
  () => validateExecutionResult({ ...forgedUnsigned, resultDigest: contractDigest(forgedUnsigned) }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_RESULT_INVALID"
);
const repeatedArtifact = await worker.execute(job(artifactSource));
assert.equal(repeatedArtifact.status, "succeeded");
assert.notEqual(repeatedArtifact.artifacts[0].id, artifactResult.artifacts[0].id, "artifact IDs must bind to their job");

const isolationSource = `
import json
import os
import socket
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.25)
try:
    network_blocked = sock.connect_ex(("1.1.1.1", 53)) != 0
finally:
    sock.close()
print(json.dumps({
    "uid": os.getuid(),
    "gid": os.getgid(),
    "etc_absent": not os.path.exists("/etc/passwd"),
    "home_absent": not os.path.exists("/home"),
    "network_blocked": network_blocked,
    "work_empty": os.listdir("/work") == [],
}, sort_keys=True))
open("/work/ephemeral", "w").write("discard me")
`;
const isolationResult = await worker.execute(job(isolationSource));
assert.equal(isolationResult.status, "succeeded");
assert.deepEqual(JSON.parse(isolationResult.stdout), {
  etc_absent: true,
  gid: 65532,
  home_absent: true,
  network_blocked: true,
  uid: 65532,
  work_empty: true,
});
const freshWorkspace = await worker.execute(job("import os; print(os.path.exists('/work/ephemeral'))"));
assert.equal(freshWorkspace.status, "succeeded");
assert.equal(freshWorkspace.stdout, "False\n");

const failed = await worker.execute(job("raise RuntimeError('expected failure')"));
assert.equal(failed.status, "failed");
assert.match(failed.stderr, /RuntimeError: expected failure/u);
assert(!failed.stderr.includes("/home/"));
assert.equal(failed.artifacts.length, 0);

for (const source of [
  `emit_markdown("Unsafe", "[remote](https://example.invalid)")`,
  `emit_plot("Extreme", {"schemaVersion":"1","type":"line","labels":["x"],"series":[{"name":"y","data":[1e308]}]})`,
  `emit_table("Unsafe <table>", {"schemaVersion":"1","columns":[{"key":"x","label":"x"}],"rows":[]})`,
  `emit_plot.__globals__["_artifacts"].append({"id":"art_${"f".repeat(64)}","title":"Forged","kind":"markdown","spec":{"schemaVersion":"1","markdown":"forged"}})`,
]) {
  const rejected = await worker.execute(job(source));
  assert.equal(rejected.status, "artifact_invalid");
  assert.equal(rejected.artifacts.length, 0);
  assert.equal(rejected.stderr, "The execution returned an invalid artifact envelope.");
}

for (const artifact of [
  { title: "Extreme", kind: "plot", spec: { schemaVersion: "1", type: "line", labels: ["x"], series: [{ name: "y", data: [Number.MAX_VALUE] }] } },
  { title: "Overflow", kind: "plot", spec: { schemaVersion: "1", type: "scatter", series: [{ name: "y", points: [{ x: -Number.MAX_VALUE, y: 1 }, { x: Number.MAX_VALUE, y: 2 }] }] } },
]) {
  assert.throws(() => sanitizeIntegrationArtifact(artifact));
}

const outputLimited = await worker.execute(job(`print("🙂" * 40000)`));
assert.equal(outputLimited.status, "output_limited");
assert.equal(outputLimited.outputTruncated, true);
assert(Buffer.byteLength(outputLimited.stdout, "utf8") <= EXECUTION_LIMITS.maximumOutputBytes);
assert(!outputLimited.stdout.includes("�"), "UTF-8 output was cut inside a code point");

const combinedLimited = await worker.execute(job(`
import sys
sys.stdout.write("o" * 180000)
sys.stdout.flush()
sys.stderr.write("e" * 180000)
sys.stderr.flush()
`));
assert.equal(combinedLimited.status, "output_limited");
assert(Buffer.byteLength(combinedLimited.stdout, "utf8") + Buffer.byteLength(combinedLimited.stderr, "utf8") <= EXECUTION_LIMITS.maximumOutputBytes);

const timedOut = await worker.execute(job("while True:\n    pass", { timeoutMs: 150 }));
assert.equal(timedOut.status, "timed_out");
assert.equal(timedOut.exitCode, null);

const controller = new AbortController();
const cancelling = worker.execute(job("while True:\n    pass", { timeoutMs: 5_000 }), { signal: controller.signal });
setTimeout(() => controller.abort(), 100).unref?.();
const cancelled = await cancelling;
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.exitCode, null);
const afterCancellation = await worker.capabilities();
assert.equal(afterCancellation.admission.activeJobs, 0);

const alreadyAborted = new AbortController();
alreadyAborted.abort();
const cancelledBeforeStart = await worker.execute(job("print('must not run')"), { signal: alreadyAborted.signal });
assert.equal(cancelledBeforeStart.status, "cancelled");
assert.equal(cancelledBeforeStart.durationMs, 0);

const admittedWorker = Object.freeze({
  capabilities: async () => Object.freeze({
    ...capabilities,
    ready: true,
    admission: Object.freeze({
      state: "ready",
      activeJobs: 0,
      maximumConcurrentJobs: EXECUTION_LIMITS.maximumConcurrentJobs,
    }),
  }),
  execute: (request, options) => worker.execute(request, options),
});
let managerTime = Date.parse("2026-08-24T00:00:00.000Z");
const manager = createExecutionJobManager({
  worker: admittedWorker,
  now: () => new Date((managerTime += 1)).toISOString(),
});
const managerCapabilities = await manager.capabilities();
assert.equal(managerCapabilities.coordinatorProtocol.tenantBlind, true);
assert.equal(managerCapabilities.coordinatorProtocol.durable, false);
assert.match(managerCapabilities.coordinatorProtocolDigest, /^[a-f0-9]{64}$/u);

const managedRequest = job(`emit_plot("Managed", {"schemaVersion":"1","type":"bar","labels":["a","b"],"series":[{"name":"value","data":[2,3]}]})`);
const managedStarted = await manager.start(managedRequest);
assert.equal(managedStarted.state, "running");
assert.equal(managedStarted.terminal, false);
const managedReusedWhileRunning = await manager.start(managedRequest);
assert.equal(managedReusedWhileRunning.reused, true);
const managedTerminal = await manager.waitForTerminal({ jobId: managedRequest.jobId, attempt: managedRequest.attempt });
assert.equal(managedTerminal.state, "succeeded");
assert.equal(managedTerminal.result.artifacts.length, 1);
assert.equal(manager.status({ jobId: managedRequest.jobId, attempt: managedRequest.attempt }).result.resultDigest, managedTerminal.result.resultDigest);
const managedReusedTerminal = await manager.start(managedRequest);
assert.equal(managedReusedTerminal.reused, true);
assert.equal(managedReusedTerminal.result.resultDigest, managedTerminal.result.resultDigest);
const conflictingSource = "print('different')";
await assert.rejects(
  () => manager.start({ ...managedRequest, source: conflictingSource, sourceSha256: sha256(conflictingSource) }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_IDEMPOTENCY_CONFLICT"
);

const ledger = manager.events({
  jobId: managedRequest.jobId,
  attempt: managedRequest.attempt,
  afterSeq: 0,
  afterHash: EXECUTION_ZERO_EVENT_HASH,
});
assert.equal(ledger.terminal, true);
assert.deepEqual(ledger.events.map(({ type }) => type), ["job.started", "job.terminal"]);
assert.equal(ledger.events[0].previousHash, EXECUTION_ZERO_EVENT_HASH);
assert.equal(ledger.events[1].previousHash, ledger.events[0].eventHash);
assert.equal(ledger.cursor.hash, ledger.events[1].eventHash);
const emptyReplay = manager.events({
  jobId: managedRequest.jobId,
  attempt: managedRequest.attempt,
  afterSeq: ledger.cursor.seq,
  afterHash: ledger.cursor.hash,
});
assert.equal(emptyReplay.events.length, 0);
assert.throws(
  () => manager.events({
    jobId: managedRequest.jobId,
    attempt: managedRequest.attempt,
    afterSeq: 1,
    afterHash: "0".repeat(64),
  }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_CURSOR_CONFLICT"
);

const listed = manager.listArtifacts({ jobId: managedRequest.jobId, attempt: managedRequest.attempt });
assert.equal(listed.artifacts.length, 1);
const retrieved = manager.getArtifact({
  jobId: managedRequest.jobId,
  attempt: managedRequest.attempt,
  artifactId: listed.artifacts[0].id,
});
assert.deepEqual(retrieved.artifact, listed.artifacts[0]);
assert.throws(
  () => manager.getArtifact({
    jobId: managedRequest.jobId,
    attempt: managedRequest.attempt,
    artifactId: `art_${"0".repeat(64)}`,
  }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_ARTIFACT_NOT_FOUND"
);

const managedCancelRequest = job("while True:\n    pass", { timeoutMs: 5_000 });
await manager.start(managedCancelRequest);
const cancelRequested = manager.cancel({ jobId: managedCancelRequest.jobId, attempt: managedCancelRequest.attempt });
assert.equal(cancelRequested.state, "cancelling");
const managedCancelled = await manager.waitForTerminal({ jobId: managedCancelRequest.jobId, attempt: managedCancelRequest.attempt });
assert.equal(managedCancelled.state, "cancelled");
const cancelLedger = manager.events({
  jobId: managedCancelRequest.jobId,
  attempt: managedCancelRequest.attempt,
  afterSeq: 0,
  afterHash: EXECUTION_ZERO_EVENT_HASH,
});
assert.deepEqual(cancelLedger.events.map(({ type }) => type), ["job.started", "job.cancel_requested", "job.terminal"]);
assert.equal(manager.cancel({ jobId: managedCancelRequest.jobId, attempt: managedCancelRequest.attempt }).reused, true);

assert.throws(
  () => manager.status({ jobId: "job_000000000000000000000000", attempt: 1 }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_JOB_NOT_FOUND"
);
assert.throws(
  () => manager.status({ jobId: managedRequest.jobId, attempt: managedRequest.attempt, source: "forbidden" }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_REQUEST_INVALID"
);

function fakeSuccessResult(request) {
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status: "succeeded",
    exitCode: 0,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    durationMs: 1,
    artifacts: Object.freeze([]),
  });
  return Object.freeze({ ...unsigned, resultDigest: contractDigest(unsigned) });
}

const pendingExecutions = [];
const admissionWorker = Object.freeze({
  capabilities: async () => Object.freeze({
    ready: true,
    admission: Object.freeze({ state: "ready", activeJobs: 0, maximumConcurrentJobs: 2 }),
  }),
  execute: (request) => new Promise((resolve) => pendingExecutions.push(() => resolve(fakeSuccessResult(request)))),
});
const admissionManager = createExecutionJobManager({ worker: admissionWorker });
const concurrentStarts = Array.from({ length: 20 }, (_, index) => admissionManager.start(job(`print(${index})`)));
const concurrentStartResults = await Promise.allSettled(concurrentStarts);
assert.equal(concurrentStartResults.filter(({ status }) => status === "fulfilled").length, 2);
assert.equal(
  concurrentStartResults.filter(({ status, reason }) => status === "rejected" && reason?.code === "EXECUTION_BUSY").length,
  18
);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingExecutions.length, 2);
for (const release of pendingExecutions.splice(0)) release();

let sameKeyExecutions = 0;
const sameKeyWorker = Object.freeze({
  capabilities: admissionWorker.capabilities,
  execute: async (request) => {
    sameKeyExecutions += 1;
    return fakeSuccessResult(request);
  },
});
const sameKeyManager = createExecutionJobManager({ worker: sameKeyWorker });
const sameKeyRequest = job("print('once')");
const sameKeyStarts = await Promise.all(Array.from({ length: 20 }, () => sameKeyManager.start(sameKeyRequest)));
assert.equal(sameKeyStarts.filter(({ reused }) => reused === false).length, 1);
assert.equal(sameKeyStarts.filter(({ reused }) => reused === true).length, 19);
await sameKeyManager.waitForTerminal({ jobId: sameKeyRequest.jobId, attempt: sameKeyRequest.attempt });
assert.equal(sameKeyExecutions, 1);

const apiToken = "worker_test_token_0123456789abcdefghijklmnop";
const apiServer = createExecutionWorkerApiServer({ manager, bearerToken: apiToken });
await new Promise((resolve, reject) => {
  apiServer.once("error", reject);
  apiServer.listen(0, "127.0.0.1", resolve);
});
const apiAddress = apiServer.address();
assert(apiAddress && typeof apiAddress === "object");
const apiBase = `http://127.0.0.1:${apiAddress.port}`;

async function apiRequest(route, body, { token = apiToken, method = "POST", contentType = "application/json" } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (contentType !== null) headers["content-type"] = contentType;
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers,
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, text };
}

try {
  const apiCapabilities = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, {});
  assert.equal(apiCapabilities.response.status, 200);
  assert.equal(apiCapabilities.response.headers.get("cache-control"), "no-store");
  assert.equal(apiCapabilities.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(apiCapabilities.body.schemaVersion, EXECUTION_WORKER_API_SCHEMA_VERSION);
  assert.equal(apiCapabilities.body.response.coordinatorProtocol.tenantBlind, true);

  const apiStatus = await apiRequest(EXECUTION_WORKER_RPC_PATHS.jobsStatus, {
    jobId: managedRequest.jobId,
    attempt: managedRequest.attempt,
  });
  assert.equal(apiStatus.response.status, 200);
  assert.equal(apiStatus.body.response.result.resultDigest, managedTerminal.result.resultDigest);

  const missingAuth = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, {}, { token: null });
  assert.equal(missingAuth.response.status, 401);
  assert.equal(missingAuth.body.error.code, "UNAUTHORIZED");
  const badAuth = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, {}, { token: "x".repeat(32) });
  assert.equal(badAuth.response.status, 401);
  assert(!badAuth.text.includes(apiToken));

  const wrongMethod = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, {}, { method: "GET", contentType: null });
  assert.equal(wrongMethod.response.status, 405);
  const queryRejected = await apiRequest(`${EXECUTION_WORKER_RPC_PATHS.capabilities}?probe=1`, {});
  assert.equal(queryRejected.response.status, 404);
  const slashRejected = await apiRequest(`${EXECUTION_WORKER_RPC_PATHS.capabilities}/`, {});
  assert.equal(slashRejected.response.status, 404);
  const wrongContentType = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, {}, { contentType: "text/plain" });
  assert.equal(wrongContentType.response.status, 415);
  const malformedJson = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, "{");
  assert.equal(malformedJson.response.status, 400);
  const nonemptyCapabilities = await apiRequest(EXECUTION_WORKER_RPC_PATHS.capabilities, { extra: true });
  assert.equal(nonemptyCapabilities.response.status, 400);
  const boundarySource = "\n".repeat(EXECUTION_LIMITS.maximumSourceBytes);
  const boundaryRequest = job(boundarySource, {
    stdin: "\t".repeat(EXECUTION_LIMITS.maximumStdinBytes),
    sourceSha256: sha256(boundarySource),
  });
  const boundaryJson = JSON.stringify(boundaryRequest);
  assert(Buffer.byteLength(boundaryJson, "utf8") <= EXECUTION_WORKER_MAX_REQUEST_BYTES);
  assert(Buffer.byteLength(boundaryJson, "utf8") > 64 * 1024, "boundary fixture must cover the old transport bug");
  const boundaryResponse = await apiRequest(EXECUTION_WORKER_RPC_PATHS.jobsStart, boundaryJson);
  assert.equal(boundaryResponse.response.status, 200);
  await manager.waitForTerminal({ jobId: boundaryRequest.jobId, attempt: boundaryRequest.attempt });
  const oversized = await apiRequest(
    EXECUTION_WORKER_RPC_PATHS.jobsStart,
    JSON.stringify({ value: "x".repeat(EXECUTION_WORKER_MAX_REQUEST_BYTES + 1) })
  );
  assert.equal(oversized.response.status, 413);
  assert(!oversized.text.includes(apiToken));

  const invalidStatus = await apiRequest(EXECUTION_WORKER_RPC_PATHS.jobsStatus, {
    jobId: managedRequest.jobId,
    attempt: managedRequest.attempt,
    source: "forbidden",
  });
  assert.equal(invalidStatus.response.status, 400);
  assert.equal(invalidStatus.body.error.code, "EXECUTION_REQUEST_INVALID");
  assert(!invalidStatus.text.includes("forbidden"));
} finally {
  await new Promise((resolve) => apiServer.close(resolve));
}

const spawnFailureWorker = createPythonExecutionWorker({
  workerId: WORKER_ID,
  testOnlyAllowMissingSeccomp: true,
  runtimeProbeImpl: async () => liveProof,
  spawnImpl: () => { throw new Error("private spawn detail"); },
  clock: (() => {
    let now = 10;
    return () => (now += 2);
  })(),
});
const spawnFailure = await spawnFailureWorker.execute(job("print('no')"));
assert.equal(spawnFailure.status, "sandbox_error");
assert.equal(spawnFailure.stderr, "The isolated execution runtime could not start.");
assert(!JSON.stringify(spawnFailure).includes("private spawn detail"));

function epipeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("simulated EPIPE"));
    },
  });
  let closed = false;
  child.kill = () => {
    if (!closed) {
      closed = true;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  return child;
}

const epipeWorker = createPythonExecutionWorker({
  workerId: WORKER_ID,
  testOnlyAllowMissingSeccomp: true,
  runtimeProbeImpl: async () => liveProof,
  spawnImpl: () => epipeChild(),
});
const epipeResult = await epipeWorker.execute(job("print('unreachable')"));
assert.equal(epipeResult.status, "sandbox_error");
await assert.rejects(
  () => probeExecutionWorkerRuntime({ spawnImpl: () => epipeChild() }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_RUNTIME_UNAVAILABLE"
);

function noCloseChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.kill = () => false;
  child.unref = () => {};
  return child;
}

const degradedWorker = createPythonExecutionWorker({
  workerId: WORKER_ID,
  testOnlyAllowMissingSeccomp: true,
  runtimeProbeImpl: async () => liveProof,
  spawnImpl: () => noCloseChild(),
});
const unproven = await degradedWorker.execute(job("while True:\n    pass", { timeoutMs: 100 }));
assert.equal(unproven.status, "termination_unproven");
const degradedCapabilities = await degradedWorker.capabilities();
assert(degradedCapabilities.activation.blockers.includes("worker-termination-degraded"));
await assert.rejects(
  () => degradedWorker.execute(job("print('must stay blocked')")),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_UNAVAILABLE"
);
await assert.rejects(
  () => probeExecutionWorkerRuntime({ spawnImpl: () => noCloseChild(), timeoutMs: 100 }),
  (error) => error instanceof ExecutionWorkerError && error.code === "EXECUTION_TERMINATION_UNPROVEN"
);

console.log(JSON.stringify({
  ok: true,
  live: true,
  runtimeProfile: capabilities.runtime.profile,
  seccompInherited: capabilities.runtime.seccomp,
  artifactKinds: artifactResult.artifacts.map(({ kind }) => kind),
  timeoutStatus: timedOut.status,
  cancelStatus: cancelled.status,
  outputLimitStatus: outputLimited.status,
}));
