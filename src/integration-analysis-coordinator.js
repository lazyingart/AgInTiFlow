import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  EXECUTION_JOB_SCHEMA_VERSION,
  EXECUTION_LIMITS,
  validateExecutionJobRequest,
} from "./execution-worker.js";
import { EXECUTION_ZERO_EVENT_HASH } from "./execution-worker-jobs.js";
import {
  ExecutionWorkerClientError,
  assertExecutionWorkerClient,
  createSystemdExecutionWorkerClient,
} from "./execution-worker-client.js";
import { contractDigest, validateIntegrationRunId, validateIntegrationThreadId } from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION = "aginti-integration-analysis-coordinator-v1";
export const INTEGRATION_ANALYSIS_TOOL_NAME = "execute_python_analysis";
export const INTEGRATION_ANALYSIS_MAX_POLL_MS = 250;

const COORDINATOR_BRAND = new WeakSet();
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "output_limited",
  "cancelled",
  "sandbox_error",
  "artifact_invalid",
  "termination_unproven",
  "worker_error",
]);

export class IntegrationAnalysisError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationAnalysisError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, options) {
  throw new IntegrationAnalysisError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowed, required, label) {
  if (!isPlainObject(value)) fail("EXECUTION_REQUEST_INVALID", `${label} must be a plain data object.`, { status: 400 });
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (
      typeof key !== "string" ||
      !allowedKeys.has(key) ||
      !descriptor?.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("EXECUTION_REQUEST_INVALID", `${label} contains an unsupported field.`, { status: 400 });
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("EXECUTION_REQUEST_INVALID", `${label}.${key} is required.`, { status: 400 });
    }
  }
  return value;
}

function scopeFor(value) {
  const scope = exactObject(
    value,
    ["principalId", "browserSessionId", "threadId", "runId"],
    ["principalId", "browserSessionId", "threadId", "runId"],
    "integration analysis scope"
  );
  if (typeof scope.principalId !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(scope.principalId)) {
    fail("INVALID_PRINCIPAL", "integration analysis principal scope is invalid.", { status: 401 });
  }
  if (typeof scope.browserSessionId !== "string" || !/^[a-f0-9]{64}$/u.test(scope.browserSessionId)) {
    fail("INVALID_BROWSER_SESSION", "integration analysis browser session scope is invalid.", { status: 400 });
  }
  return Object.freeze({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: validateIntegrationThreadId(scope.threadId),
    runId: validateIntegrationRunId(scope.runId),
  });
}

function analysisInput(value) {
  const input = exactObject(value, ["source", "stdin", "timeoutMs"], ["source"], "Python analysis request");
  if (typeof input.source !== "string" || typeof (input.stdin ?? "") !== "string") {
    fail("EXECUTION_REQUEST_INVALID", "Python analysis source and stdin must be strings.", { status: 400 });
  }
  const timeoutMs = input.timeoutMs ?? Math.min(10_000, EXECUTION_LIMITS.maximumWallTimeMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXECUTION_LIMITS.maximumWallTimeMs) {
    fail("EXECUTION_REQUEST_INVALID", "Python analysis timeoutMs is invalid.", { status: 400 });
  }
  return Object.freeze({
    source: input.source,
    stdin: input.stdin ?? "",
    timeoutMs,
  });
}

function sourceDigest(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function executionRequest(scope, input) {
  const sourceSha256 = sourceDigest(input.source);
  const identityDigest = contractDigest({
    schemaVersion: INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    browserSessionPolicy: scope.browserSessionPolicy,
    threadId: scope.threadId,
    runId: scope.runId,
    sourceSha256,
    stdinDigest: contractDigest(input.stdin),
    timeoutMs: input.timeoutMs,
  });
  return validateExecutionJobRequest({
    schemaVersion: EXECUTION_JOB_SCHEMA_VERSION,
    jobId: `job_${identityDigest.slice(0, 64)}`,
    attempt: 1,
    language: "python",
    source: input.source,
    sourceSha256,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
  });
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("cancelled"));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason || new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function abortError(cause) {
  return new IntegrationAnalysisError("EXECUTION_CANCELLED", "Python analysis was cancelled.", {
    status: 499,
    cause,
  });
}

function translateError(error) {
  if (error instanceof IntegrationAnalysisError) return error;
  if (error instanceof ExecutionWorkerClientError) {
    return new IntegrationAnalysisError(error.code, "Python analysis execution was unavailable.", {
      status: error.status,
      cause: error,
    });
  }
  return new IntegrationAnalysisError("EXECUTION_UNAVAILABLE", "Python analysis execution was unavailable.", {
    cause: error,
  });
}

function validateTerminalEvidence(eventsResponse, status, terminalEvent) {
  if (!eventsResponse.terminal || !status.terminal || !TERMINAL_STATES.has(status.state)) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution terminal evidence is incomplete.");
  }
  const terminal = terminalEvent;
  if (!terminal || terminal.type !== "job.terminal") {
    fail("EXECUTION_PROTOCOL_INVALID", "execution event ledger is missing its terminal event.");
  }
  const data = terminal.data;
  const expectedStatus = status.result?.status || status.state;
  if (data.status !== expectedStatus) {
    fail("EXECUTION_PROTOCOL_INVALID", "execution terminal event status diverged from job status.");
  }
  if (status.result) {
    if (data.resultDigest !== status.result.resultDigest) {
      fail("EXECUTION_PROTOCOL_INVALID", "execution terminal event result digest diverged from job status.");
    }
    const expectedArtifactIds = status.result.artifacts.map(({ id }) => id);
    if (contractDigest(data.artifactIds) !== contractDigest(expectedArtifactIds)) {
      fail("EXECUTION_PROTOCOL_INVALID", "execution terminal event artifacts diverged from job status.");
    }
  } else if (status.state === "worker_error") {
    if (data.errorCode !== status.errorCode || contractDigest(data.artifactIds) !== contractDigest([])) {
      fail("EXECUTION_PROTOCOL_INVALID", "execution worker-error event diverged from job status.");
    }
  } else {
    fail("EXECUTION_PROTOCOL_INVALID", "execution terminal status is missing a result.");
  }
}

function publicResult(status, artifacts) {
  const result = status.result;
  return Object.freeze({
    ok: status.state === "succeeded",
    toolName: INTEGRATION_ANALYSIS_TOOL_NAME,
    status: status.state,
    exitCode: result?.exitCode ?? null,
    stdout: result?.stdout || "",
    stderr: result?.stderr || "",
    outputTruncated: result?.outputTruncated === true,
    durationMs: result?.durationMs ?? 0,
    artifacts: Object.freeze(artifacts),
    resultDigest: result?.resultDigest || null,
  });
}

function createCoordinator(client, { requireSystemdCredential, pollMs = 100 } = {}) {
  assertExecutionWorkerClient(client, { requireSystemdCredential });
  if (!Number.isSafeInteger(pollMs) || pollMs < 25 || pollMs > INTEGRATION_ANALYSIS_MAX_POLL_MS) {
    throw new TypeError("pollMs must be an integer between 25 and 250");
  }
  const proofUnsigned = Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
    owner: "aginti",
    authority: "aginti",
    toolName: INTEGRATION_ANALYSIS_TOOL_NAME,
    fixedWorkerClientDigest: client.attestation.digest,
    credentialSource: client.attestation.credentialSource,
    publicActivationGated: true,
    aggregateContainmentGated: true,
    callerSelectableEndpoint: false,
    callerSelectableCredential: false,
    idempotentRunScopedJobs: true,
    validatedArtifacts: Object.freeze(["plot", "table", "markdown"]),
  });
  const attestation = Object.freeze({ ...proofUnsigned, digest: contractDigest(proofUnsigned) });

  async function readiness(options = {}) {
    const capabilities = await client.capabilities(options);
    const unsigned = Object.freeze({
      schemaVersion: INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
      ready: true,
      publicActivationReady: true,
      workerCapabilityDigest: capabilities.capabilityDigest,
      workerHealthDigest: capabilities.healthDigest,
      coordinatorProtocolDigest: capabilities.coordinatorProtocolDigest,
      coordinatorHealthDigest: capabilities.coordinatorHealthDigest,
      runtimeProfile: capabilities.runtime.profile,
      runtimeBundleRootDigest: capabilities.runtime.runtimeBundleRootDigest,
      seccompPolicyDigest: capabilities.runtime.seccompPolicyDigest,
      cgroupPolicyDigest: capabilities.containment.cgroupPolicyDigest,
    });
    return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  }

  async function execute(scopeInput, inputValue, options = {}) {
    const scope = scopeFor(scopeInput);
    const input = analysisInput(inputValue);
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    if (options.onArtifact !== undefined && typeof options.onArtifact !== "function") {
      throw new TypeError("onArtifact must be a function");
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const request = executionRequest(scope, input);
    const reference = Object.freeze({ jobId: request.jobId, attempt: request.attempt });
    let started = false;
    let terminal = false;
    let cursor = Object.freeze({ seq: 0, hash: EXECUTION_ZERO_EVENT_HASH });
    let lastEvent = null;
    const startedAt = Date.now();
    const coordinatorDeadlineMs = request.timeoutMs + 5_000;
    let cancellationSent = false;

    async function cancelBestEffort() {
      if (!started || terminal || cancellationSent) return;
      cancellationSent = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      timer.unref?.();
      try {
        await client.cancel(reference, { signal: controller.signal });
      } catch {
        // The original error remains authoritative. A failed cancellation is
        // never presented as success and the worker has its own wall timeout.
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      await readiness({ signal });
      let status = await client.start(request, { signal });
      started = true;
      options.onProgress?.(Object.freeze({ state: status.state }));

      while (!status.terminal) {
        if (signal?.aborted) {
          await cancelBestEffort();
          throw abortError(signal.reason);
        }
        if (Date.now() - startedAt > coordinatorDeadlineMs) {
          await cancelBestEffort();
          fail("EXECUTION_TIMEOUT", "Python analysis coordinator deadline expired.", { status: 504 });
        }
        const replay = await client.events({
          ...reference,
          afterSeq: cursor.seq,
          afterHash: cursor.hash,
        }, { signal });
        cursor = replay.cursor;
        if (replay.events.length) lastEvent = replay.events.at(-1);
        await delay(pollMs, signal);
        status = await client.status(reference, { signal });
        options.onProgress?.(Object.freeze({ state: status.state }));
      }
      terminal = true;
      const finalEvents = await client.events({
        ...reference,
        afterSeq: cursor.seq,
        afterHash: cursor.hash,
      }, { signal });
      cursor = finalEvents.cursor;
      if (finalEvents.events.length) lastEvent = finalEvents.events.at(-1);
      validateTerminalEvidence(finalEvents, status, lastEvent);

      const artifacts = status.state === "succeeded"
        ? await client.listArtifacts(reference, status.result, { signal })
        : Object.freeze([]);
      for (const artifact of artifacts) {
        const exact = await client.getArtifact({ ...reference, artifactId: artifact.id }, { signal });
        if (contractDigest(exact) !== contractDigest(artifact)) {
          fail("EXECUTION_PROTOCOL_INVALID", "execution artifact detail diverged from its validated list.");
        }
        await options.onArtifact?.(exact);
      }
      return publicResult(status, artifacts);
    } catch (error) {
      if (signal?.aborted) {
        await cancelBestEffort();
        throw abortError(signal.reason || error);
      }
      await cancelBestEffort();
      throw translateError(error);
    }
  }

  const coordinator = Object.freeze({
    attestation,
    readiness,
    execute,
    close() {
      client.close();
    },
  });
  COORDINATOR_BRAND.add(coordinator);
  return coordinator;
}

export function assertIntegrationAnalysisCoordinator(value, { requireSystemdCredential = true } = {}) {
  if (!value || !COORDINATOR_BRAND.has(value)) {
    throw new TypeError("integration analysis coordinator is not AgInTi-owned");
  }
  if (
    requireSystemdCredential &&
    value.attestation.credentialSource !== "systemd-loadcredential-fixed"
  ) {
    throw new TypeError("integration analysis coordinator lacks its fixed worker-client binding");
  }
  return value;
}

export async function createSystemdIntegrationAnalysisCoordinator(...args) {
  if (args.length !== 0) {
    fail("EXECUTION_CREDENTIAL_SOURCE_FORBIDDEN", "production analysis coordinator accepts no overrides.");
  }
  const client = await createSystemdExecutionWorkerClient();
  return createCoordinator(client, { requireSystemdCredential: true });
}

export function createTestOnlyIntegrationAnalysisCoordinator(client, options = {}) {
  return createCoordinator(client, { ...options, requireSystemdCredential: false });
}
