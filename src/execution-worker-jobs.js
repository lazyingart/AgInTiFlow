import { types as utilTypes } from "node:util";

import {
  ExecutionWorkerError,
  executionJobRequestDigest,
  validateExecutionJobRequest,
  validateExecutionResult,
} from "./execution-worker.js";
import { contractDigest } from "./integration-policy.js";

export const EXECUTION_JOB_MANAGER_SCHEMA_VERSION = "aginti-execution-job-manager-v1";
export const EXECUTION_EVENT_SCHEMA_VERSION = "aginti-execution-event-v1";
export const EXECUTION_ZERO_EVENT_HASH = "0".repeat(64);
export const EXECUTION_MAX_RETAINED_JOBS = 128;

const JOB_ID = /^job_[A-Za-z0-9_-]{24,96}$/u;
const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{32,86}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
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

function fail(code, message, { status = 400, details } = {}) {
  throw new ExecutionWorkerError(code, message, { status, details });
}

function exactObject(input, allowed, required, label) {
  if (
    !input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    fail("EXECUTION_REQUEST_INVALID", `${label} must be a plain data object.`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    fail("EXECUTION_REQUEST_INVALID", `${label} contains an unsupported field.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("EXECUTION_REQUEST_INVALID", `${label} must contain only data fields.`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      fail("EXECUTION_REQUEST_INVALID", `${label}.${key} is required.`);
    }
  }
  return input;
}

function reference(input, label = "execution job reference") {
  const value = exactObject(input, ["jobId", "attempt"], ["jobId", "attempt"], label);
  if (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) {
    fail("EXECUTION_REQUEST_INVALID", `${label}.jobId is invalid.`);
  }
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 1_000_000) {
    fail("EXECUTION_REQUEST_INVALID", `${label}.attempt is invalid.`);
  }
  return Object.freeze({ jobId: value.jobId, attempt: value.attempt });
}

function recordKey({ jobId, attempt }) {
  return `${jobId}:${attempt}`;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    fail("EXECUTION_CLOCK_INVALID", "execution worker clock returned an invalid timestamp.", { status: 503 });
  }
  return value;
}

function eventData(value) {
  return Object.freeze(value);
}

function appendEvent(record, type, data, now) {
  const previous = record.events.at(-1);
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    jobId: record.jobId,
    attempt: record.attempt,
    seq: record.events.length + 1,
    previousHash: previous?.eventHash || EXECUTION_ZERO_EVENT_HASH,
    type,
    timestamp: timestamp(now()),
    data: eventData(data),
  });
  const event = Object.freeze({ ...unsigned, eventHash: contractDigest(unsigned) });
  record.events.push(event);
  record.updatedAt = event.timestamp;
  return event;
}

function publicRecord(record, { reused = false } = {}) {
  return Object.freeze({
    schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
    jobId: record.jobId,
    attempt: record.attempt,
    sourceSha256: record.sourceSha256,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    reused,
    terminal: TERMINAL_STATES.has(record.state),
    result: record.result,
    errorCode: record.errorCode,
  });
}

function workerErrorCode(error) {
  if (error instanceof ExecutionWorkerError && typeof error.code === "string") return error.code;
  return "EXECUTION_WORKER_FAILURE";
}

export function createExecutionJobManager({
  worker,
  now = () => new Date().toISOString(),
  maximumRetainedJobs = EXECUTION_MAX_RETAINED_JOBS,
} = {}) {
  if (!worker || typeof worker.capabilities !== "function" || typeof worker.execute !== "function") {
    throw new TypeError("worker must provide capabilities and execute");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(maximumRetainedJobs) || maximumRetainedJobs < 8 || maximumRetainedJobs > 1_024) {
    throw new TypeError("maximumRetainedJobs is invalid");
  }
  const records = new Map();
  let activeJobs = 0;

  function evictTerminalRecords() {
    if (records.size < maximumRetainedJobs) return;
    for (const [key, record] of records) {
      if (TERMINAL_STATES.has(record.state)) {
        records.delete(key);
        if (records.size < maximumRetainedJobs) return;
      }
    }
    if (records.size >= maximumRetainedJobs) {
      fail("EXECUTION_BUSY", "execution worker retention is full of active jobs.", { status: 429 });
    }
  }

  function find(input, label) {
    const normalized = reference(input, label);
    const record = records.get(recordKey(normalized));
    if (!record) fail("EXECUTION_JOB_NOT_FOUND", "execution job was not found.", { status: 404 });
    return record;
  }

  async function capabilities() {
    const workerCapabilities = await worker.capabilities();
    const protocol = Object.freeze({
      schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
      durable: false,
      tenantBlind: true,
      retainedJobs: maximumRetainedJobs,
      eventLedger: Object.freeze({ schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION, hashChained: true, pruned: false }),
      routes: Object.freeze([
        "capabilities", "jobs.start", "jobs.status", "jobs.events", "jobs.cancel",
        "artifacts.list", "artifacts.get",
      ]),
    });
    const workerMaximum = workerCapabilities.admission?.maximumConcurrentJobs;
    const maximumConcurrentJobs = Number.isSafeInteger(workerMaximum) && workerMaximum > 0
      ? workerMaximum
      : 0;
    const state = workerCapabilities.ready !== true
      ? (workerCapabilities.admission?.state || "blocked")
      : activeJobs < maximumConcurrentJobs ? "ready" : "busy";
    const coordinatorAdmission = Object.freeze({
      state,
      activeJobs,
      maximumConcurrentJobs,
      workerAdmission: workerCapabilities.admission,
    });
    const ready = state === "ready";
    return Object.freeze({
      ...workerCapabilities,
      ready,
      admission: coordinatorAdmission,
      coordinatorProtocol: protocol,
      coordinatorProtocolDigest: contractDigest(protocol),
      coordinatorHealthDigest: contractDigest({ ready, admission: coordinatorAdmission }),
    });
  }

  async function start(input) {
    const request = validateExecutionJobRequest(input);
    const key = recordKey(request);
    const requestDigest = executionJobRequestDigest(request);
    const existing = records.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        fail("EXECUTION_IDEMPOTENCY_CONFLICT", "execution job identity was reused with different input.", { status: 409 });
      }
      return publicRecord(existing, { reused: true });
    }
    const currentCapabilities = await worker.capabilities();
    const raced = records.get(key);
    if (raced) {
      if (raced.requestDigest !== requestDigest) {
        fail("EXECUTION_IDEMPOTENCY_CONFLICT", "execution job identity was reused with different input.", { status: 409 });
      }
      return publicRecord(raced, { reused: true });
    }
    if (currentCapabilities.ready !== true) {
      const busy = currentCapabilities.admission?.state === "busy";
      fail(
        busy ? "EXECUTION_BUSY" : "EXECUTION_UNAVAILABLE",
        busy ? "execution worker has no available slot." : "execution worker is not ready for admitted jobs.",
        { status: busy ? 429 : 503 }
      );
    }
    const maximumConcurrentJobs = currentCapabilities.admission?.maximumConcurrentJobs;
    if (!Number.isSafeInteger(maximumConcurrentJobs) || maximumConcurrentJobs < 1 || maximumConcurrentJobs > 64) {
      fail("EXECUTION_UNAVAILABLE", "execution worker admission contract is invalid.", { status: 503 });
    }
    if (activeJobs >= maximumConcurrentJobs) {
      fail("EXECUTION_BUSY", "execution worker has no available slot.", { status: 429 });
    }
    evictTerminalRecords();
    const createdAt = timestamp(now());
    const record = {
      jobId: request.jobId,
      attempt: request.attempt,
      sourceSha256: request.sourceSha256,
      requestDigest,
      request,
      state: "running",
      createdAt,
      updatedAt: createdAt,
      result: null,
      errorCode: null,
      controller: new AbortController(),
      events: [],
      completion: null,
    };
    activeJobs += 1;
    try {
      records.set(key, record);
      appendEvent(record, "job.started", {
        sourceSha256: request.sourceSha256,
        timeoutMs: request.timeoutMs,
        language: request.language,
      }, now);
    } catch (error) {
      records.delete(key);
      activeJobs -= 1;
      throw error;
    }
    record.completion = Promise.resolve()
      .then(() => worker.execute(request, { signal: record.controller.signal }))
      .then((result) => {
        const validatedResult = validateExecutionResult(result, {
          jobId: record.jobId,
          attempt: record.attempt,
          sourceSha256: record.sourceSha256,
        });
        record.state = validatedResult.status;
        record.result = validatedResult;
        record.request = null;
        appendEvent(record, "job.terminal", {
          status: validatedResult.status,
          resultDigest: validatedResult.resultDigest,
          artifactIds: Object.freeze(validatedResult.artifacts.map(({ id }) => id)),
        }, now);
        return publicRecord(record);
      })
      .catch((error) => {
        record.state = "worker_error";
        record.errorCode = workerErrorCode(error);
        record.request = null;
        appendEvent(record, "job.terminal", {
          status: "worker_error",
          errorCode: record.errorCode,
          artifactIds: Object.freeze([]),
        }, now);
        return publicRecord(record);
      })
      .finally(() => {
        record.controller = null;
        activeJobs -= 1;
      });
    return publicRecord(record);
  }

  function status(input) {
    return publicRecord(find(input, "execution status request"));
  }

  function events(input) {
    const request = exactObject(
      input,
      ["jobId", "attempt", "afterSeq", "afterHash"],
      ["jobId", "attempt", "afterSeq", "afterHash"],
      "execution events request"
    );
    const record = find({ jobId: request.jobId, attempt: request.attempt }, "execution events request");
    if (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < 0 || request.afterSeq > record.events.length) {
      fail("EXECUTION_CURSOR_INVALID", "execution event cursor is invalid.", { status: 409 });
    }
    if (typeof request.afterHash !== "string" || !DIGEST.test(request.afterHash)) {
      fail("EXECUTION_CURSOR_INVALID", "execution event cursor hash is invalid.", { status: 409 });
    }
    const expectedHash = request.afterSeq === 0
      ? EXECUTION_ZERO_EVENT_HASH
      : record.events[request.afterSeq - 1].eventHash;
    if (request.afterHash !== expectedHash) {
      fail("EXECUTION_CURSOR_CONFLICT", "execution event cursor does not match the retained ledger.", { status: 409 });
    }
    const replay = Object.freeze(record.events.slice(request.afterSeq));
    const cursor = record.events.at(-1);
    return Object.freeze({
      schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
      jobId: record.jobId,
      attempt: record.attempt,
      events: replay,
      cursor: Object.freeze({
        seq: cursor?.seq || 0,
        hash: cursor?.eventHash || EXECUTION_ZERO_EVENT_HASH,
      }),
      terminal: TERMINAL_STATES.has(record.state),
    });
  }

  function cancel(input) {
    const record = find(input, "execution cancel request");
    if (TERMINAL_STATES.has(record.state)) return publicRecord(record, { reused: true });
    if (record.state !== "cancelling") {
      record.state = "cancelling";
      appendEvent(record, "job.cancel_requested", {}, now);
      record.controller?.abort();
    }
    return publicRecord(record);
  }

  function listArtifacts(input) {
    const record = find(input, "execution artifact list request");
    const artifacts = Object.freeze(record.result?.status === "succeeded" ? [...record.result.artifacts] : []);
    return Object.freeze({
      schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
      jobId: record.jobId,
      attempt: record.attempt,
      terminal: TERMINAL_STATES.has(record.state),
      artifacts,
    });
  }

  function getArtifact(input) {
    const request = exactObject(
      input,
      ["jobId", "attempt", "artifactId"],
      ["jobId", "attempt", "artifactId"],
      "execution artifact get request"
    );
    if (typeof request.artifactId !== "string" || !ARTIFACT_ID.test(request.artifactId)) {
      fail("EXECUTION_REQUEST_INVALID", "execution artifactId is invalid.");
    }
    const record = find({ jobId: request.jobId, attempt: request.attempt }, "execution artifact get request");
    const artifact = record.result?.status === "succeeded"
      ? record.result.artifacts.find(({ id }) => id === request.artifactId)
      : null;
    if (!artifact) fail("EXECUTION_ARTIFACT_NOT_FOUND", "execution artifact was not found.", { status: 404 });
    return Object.freeze({
      schemaVersion: EXECUTION_JOB_MANAGER_SCHEMA_VERSION,
      jobId: record.jobId,
      attempt: record.attempt,
      artifact,
    });
  }

  async function waitForTerminal(input) {
    const record = find(input, "execution wait request");
    await record.completion;
    return publicRecord(record);
  }

  return Object.freeze({
    kind: "aginti-execution-job-manager",
    capabilities,
    start,
    status,
    events,
    cancel,
    listArtifacts,
    getArtifact,
    waitForTerminal,
  });
}
