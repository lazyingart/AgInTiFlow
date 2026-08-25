import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_RUN_STATUSES,
  IntegrationValidationError,
  contractDigest,
  integrationBoundedInteger,
  integrationBoundedText,
  integrationExactKeys,
  integrationInvalid,
  validateIntegrationBrowserSessionBinding,
  validateIntegrationLedgerHash,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_EVENT_TYPES = Object.freeze([
  "run.status",
  "plan.updated",
  "context.compacted",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "output.delta",
  "output.completed",
  "artifact.created",
  "artifact.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const DEFAULT_INTEGRATION_EVENT_STREAM_MS = 25_000;
export const DEFAULT_INTEGRATION_EVENT_POLL_MS = 250;
export const MAX_INTEGRATION_EVENT_STREAM_MS = 30_000;
export const MAX_INTEGRATION_EVENT_POLL_MS = 2_000;
export const MAX_INTEGRATION_EVENT_BATCH = 128;
export const PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION = "aginti-public-events-v1";

const EVENT_TYPE_SET = new Set(INTEGRATION_EVENT_TYPES);
const RUN_STATUS_SET = new Set(INTEGRATION_RUN_STATUSES);
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const ABSOLUTE_PATH_TEST_PATTERN =
  /(?:^|[\s("'`])(?:\/(?:workspace|home|users|root|etc|usr|var|opt|srv|run|tmp|proc|sys|dev|mnt|media|aginti-(?:home|cache|env))(?:\/[^\s"'`<>)\]]*)?|[A-Za-z]:\\[^\s"'`<>)\]]*)/iu;
const ZERO_DIGEST = "0".repeat(64);

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Aborted."));
      return;
    }
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason || new Error("Aborted."));
    };
    timeout = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isoTimestamp(value, label = "createdAt") {
  const timestamp = integrationBoundedText(value, label, 40, { minimum: 20 });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    integrationInvalid(`${label} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) integrationInvalid(`${label} must be a finite number`);
  return value;
}

function strictCallId(value, label = "callId") {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) integrationInvalid(`${label} is invalid`);
  return value;
}

function validateLabel(value, label, maximum = 120) {
  const text = integrationBoundedText(value, label, maximum, { minimum: 1, presentational: true }).trim();
  if (redactSensitiveText(text) !== text || ABSOLUTE_PATH_TEST_PATTERN.test(text)) {
    integrationInvalid(`${label} contains private runtime content`, { code: "UNSAFE_PRESENTATION" });
  }
  if (!text) integrationInvalid(`${label} must contain a non-whitespace character`);
  return text;
}

function validatePublicOutputText(value, label, maximum, { minimum = 0 } = {}) {
  const text = integrationBoundedText(value, label, maximum, { minimum });
  if (redactSensitiveText(text) !== text || ABSOLUTE_PATH_TEST_PATTERN.test(text)) {
    integrationInvalid(`${label} contains private runtime content`, { code: "UNSAFE_PRESENTATION" });
  }
  return text;
}

function validatePlanStep(step, index) {
  const item = integrationExactKeys(step, ["id", "label", "status"], `plan step[${index}]`, ["id", "label", "status"]);
  if (typeof item.id !== "string" || !/^[A-Za-z0-9._~-]{1,96}$/u.test(item.id)) integrationInvalid(`plan step[${index}].id is invalid`);
  if (!new Set(["pending", "in_progress", "completed", "failed"]).has(item.status)) integrationInvalid(`plan step[${index}].status is invalid`);
  return Object.freeze({
    id: item.id,
    label: validateLabel(item.label, `plan step[${index}].label`, 240),
    status: item.status,
  });
}

export function validateIntegrationEventPayload(type, value) {
  if (!EVENT_TYPE_SET.has(type)) {
    throw new IntegrationValidationError("INTERNAL_CONTRACT", `Unsupported event type "${type}"`, { status: 500 });
  }
  if (type === "run.status") {
    const payload = integrationExactKeys(value, ["status"], "run.status payload", ["status"]);
    if (!RUN_STATUS_SET.has(payload.status)) integrationInvalid("run.status payload status is invalid");
    return Object.freeze({ status: payload.status });
  }
  if (type === "plan.updated") {
    const payload = integrationExactKeys(value, ["steps"], "plan.updated payload", ["steps"]);
    if (!Array.isArray(payload.steps) || payload.steps.length > 64) integrationInvalid("plan.updated steps may contain at most 64 entries");
    return Object.freeze({ steps: Object.freeze(payload.steps.map(validatePlanStep)) });
  }
  if (type === "context.compacted") {
    const payload = integrationExactKeys(
      value,
      ["compactedMessages", "tokensBefore", "tokensAfter"],
      "context.compacted payload",
      ["compactedMessages", "tokensBefore", "tokensAfter"]
    );
    return Object.freeze({
      compactedMessages: integrationBoundedInteger(payload.compactedMessages, "compactedMessages", { maximum: 1_000_000 }),
      tokensBefore: integrationBoundedInteger(payload.tokensBefore, "tokensBefore", { maximum: 10_000_000 }),
      tokensAfter: integrationBoundedInteger(payload.tokensAfter, "tokensAfter", { maximum: 10_000_000 }),
    });
  }
  if (type.startsWith("tool.")) {
    const payload = integrationExactKeys(value, ["callId", "publicLabel", "publicSummary", "at"], `${type} payload`, [
      "callId",
      "publicLabel",
      "publicSummary",
      "at",
    ]);
    return Object.freeze({
      callId: strictCallId(payload.callId, `${type} callId`),
      publicLabel: validateLabel(payload.publicLabel, `${type} publicLabel`, 120),
      publicSummary: validateLabel(payload.publicSummary, `${type} publicSummary`, 400),
      at: isoTimestamp(payload.at, `${type} at`),
    });
  }
  if (type === "output.delta") {
    const payload = integrationExactKeys(value, ["text"], "output.delta payload", ["text"]);
    return Object.freeze({ text: validatePublicOutputText(payload.text, "output.delta text", 4_000, { minimum: 1 }) });
  }
  if (type === "artifact.created" || type === "artifact.updated") {
    const payload = integrationExactKeys(value, ["artifact", "receiptDigest"], `${type} payload`, ["artifact"]);
    const artifact = integrationExactKeys(payload.artifact, ["id", "title", "kind", "spec"], `${type} artifact`, [
      "id",
      "title",
      "kind",
      "spec",
    ]);
    const sanitized = sanitizeIntegrationArtifact(artifact);
    if (contractDigest(artifact) !== contractDigest(sanitized)) {
      integrationInvalid(`${type} artifact is not an exact public artifact envelope`, { code: "UNSAFE_PRESENTATION" });
    }
    if (sanitized.kind === "file") {
      if (typeof payload.receiptDigest !== "string" || !/^[a-f0-9]{64}$/u.test(payload.receiptDigest)) {
        integrationInvalid(`${type} file artifact receiptDigest is invalid`);
      }
    } else if (payload.receiptDigest !== undefined) {
      integrationInvalid(`${type} non-file artifact may not carry a receiptDigest`);
    }
    return Object.freeze({
      artifact: sanitized,
      ...(payload.receiptDigest === undefined ? {} : { receiptDigest: payload.receiptDigest }),
    });
  }
  if (type === "output.completed" || TERMINAL_EVENT_TYPES.has(type)) {
    integrationExactKeys(value, [], `${type} payload`);
    return Object.freeze({});
  }
  throw new IntegrationValidationError("INTERNAL_CONTRACT", `Missing event payload validator for "${type}"`, {
    status: 500,
  });
}

export function validatePublicIntegrationEvent(value) {
  const event = integrationExactKeys(
    value,
    ["schemaVersion", "id", "seq", "type", "threadId", "runId", "createdAt", "payload", "previousHash", "hash"],
    "agent event",
    ["schemaVersion", "id", "seq", "type", "threadId", "runId", "createdAt", "payload", "previousHash", "hash"]
  );
  if (event.schemaVersion !== AGENT_WORKER_SCHEMA_VERSION) integrationInvalid("agent event schemaVersion must be 1");
  const runId = validateIntegrationRunId(event.runId);
  const threadId = validateIntegrationThreadId(event.threadId);
  const seq = integrationBoundedInteger(event.seq, "agent event seq", { minimum: 1, maximum: 10_000_000_000 });
  if (event.id !== `${runId}.${seq}`) integrationInvalid("agent event id does not match runId and seq");
  const createdAt = isoTimestamp(event.createdAt, "agent event createdAt");
  if (!/^[a-f0-9]{64}$/u.test(event.previousHash) || !/^[a-f0-9]{64}$/u.test(event.hash)) {
    integrationInvalid("agent event ledger hashes are invalid");
  }
  const payload = validateIntegrationEventPayload(event.type, event.payload);
  const envelope = {
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    id: event.id,
    seq,
    type: event.type,
    threadId,
    runId,
    createdAt,
    payload,
    previousHash: event.previousHash,
  };
  if (contractDigest(envelope) !== event.hash) {
    integrationInvalid("agent event hash verification failed", { code: "LEDGER_HASH_MISMATCH" });
  }
  return Object.freeze({ ...envelope, hash: event.hash });
}

export function createPublicIntegrationEvent({ threadId, runId, seq, type, payload, createdAt, previousHash }) {
  const safeThreadId = validateIntegrationThreadId(threadId);
  const safeRunId = validateIntegrationRunId(runId);
  const safeSeq = integrationBoundedInteger(seq, "agent event seq", { minimum: 1, maximum: 10_000_000_000 });
  const safePayload = validateIntegrationEventPayload(type, payload);
  const envelope = {
    schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
    id: `${safeRunId}.${safeSeq}`,
    seq: safeSeq,
    type,
    threadId: safeThreadId,
    runId: safeRunId,
    createdAt: isoTimestamp(createdAt, "agent event createdAt"),
    payload: safePayload,
    previousHash: previousHash || "0".repeat(64),
  };
  if (!/^[a-f0-9]{64}$/u.test(envelope.previousHash)) integrationInvalid("agent event previousHash is invalid");
  return validatePublicIntegrationEvent({ ...envelope, hash: contractDigest(envelope) });
}

export async function loadPublicIntegrationEvents(options = {}) {
  const threadId = validateIntegrationThreadId(options.threadId);
  const runId = validateIntegrationRunId(options.runId);
  const afterSeq = integrationBoundedInteger(Number(options.afterSeq || 0), "afterSeq", { maximum: 10_000_000_000 });
  const afterHash = validateIntegrationLedgerHash(options.afterHash, "afterHash");
  if (afterSeq === 0 && afterHash !== ZERO_DIGEST) {
    throw new IntegrationValidationError("INVALID_EVENT_CURSOR", "afterHash must be the zero hash when afterSeq is 0.", { status: 400 });
  }
  const ledger = assertPublicIntegrationEventLedger(options.eventSource || options.eventLedger, {
    principalId: options.principalId,
    browserSessionId: options.browserSessionId,
    threadId,
    runId,
  });
  let previousHash = ZERO_DIGEST;
  if (afterSeq > 0) {
    const cursor = await ledger.loadCursor(afterSeq, {
      afterSeq,
      afterHash,
      threadId,
      runId,
      principalId: options.principalId,
      browserSessionId: options.browserSessionId,
      signal: options.signal,
    });
    if (!cursor || cursor.seq !== afterSeq || cursor.hash !== afterHash) {
      throw new IntegrationValidationError("INVALID_EVENT_CURSOR", "Public event cursor hash does not match durable ledger state.", {
        status: 400,
      });
    }
    previousHash = cursor.hash;
  }
  const loaded = await ledger.loadEventsAfter(afterSeq, {
    afterSeq,
    afterHash,
    threadId,
    runId,
    principalId: options.principalId,
    browserSessionId: options.browserSessionId,
    signal: options.signal,
  });
  if (!Array.isArray(loaded)) {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger returned an invalid batch.", {
      status: 503,
    });
  }
  const checked = loaded.slice(0, MAX_INTEGRATION_EVENT_BATCH).map(validatePublicIntegrationEvent);
  let expectedSeq = afterSeq + 1;
  const seenSeq = new Set();
  for (const event of checked) {
    if (event.runId !== runId || event.threadId !== threadId) {
      throw new IntegrationValidationError("NOT_FOUND", "Run events were not found.", { status: 404 });
    }
    if (seenSeq.has(event.seq)) {
      throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger contains duplicate sequence numbers.", {
        status: 503,
      });
    }
    if (event.seq <= afterSeq || event.seq !== expectedSeq) {
      throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger is not contiguous.", {
        status: 503,
      });
    }
    if (event.previousHash !== previousHash) {
      throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger previous hash is invalid.", {
        status: 503,
      });
    }
    seenSeq.add(event.seq);
    previousHash = event.hash;
    expectedSeq += 1;
  }
  return checked;
}

export function formatIntegrationSseEvent(event) {
  const checked = validatePublicIntegrationEvent(event);
  return `id: ${checked.id}\nevent: ${checked.type}\ndata: ${JSON.stringify(checked)}\n\n`;
}

function boundedStreamNumber(value, fallback, { minimum, maximum, label }) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new IntegrationValidationError("INVALID_STREAM_OPTIONS", `${label} is outside supported bounds.`, { status: 500 });
  }
  return number;
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Aborted."));
      return;
    }
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      res.off?.("drain", finish);
      res.off?.("error", fail);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason || new Error("Aborted."));
    timeout = setTimeout(() => fail(new Error("SSE backpressure timeout.")), 5_000);
    res.once?.("drain", finish);
    res.once?.("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function writeSseChunk(res, chunk, signal) {
  if (res.writableEnded) return;
  if (Number(res.writableLength || 0) > 64 * 1024) await waitForDrain(res, signal);
  if (res.write(chunk) === false) await waitForDrain(res, signal);
}

export function assertPublicIntegrationEventLedger(source = {}, options = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger is unavailable.", {
      status: 503,
    });
  }
  if (
    source.owner !== "aginti" ||
    source.authority !== "aginti" ||
    source.mappingVersion !== PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION ||
    source.durable !== true ||
    source.persisted !== true ||
    source.contiguous !== true ||
    source.monotonic !== true ||
    source.bridgeOwned !== false
  ) {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger is not durable AgInTi-owned state.", {
      status: 503,
    });
  }
  if (source.principalId !== options.principalId || source.runId !== options.runId || source.threadId !== options.threadId) {
    throw new IntegrationValidationError("NOT_FOUND", "Run events were not found.", { status: 404 });
  }
  validateIntegrationBrowserSessionBinding(source, { browserSessionId: options.browserSessionId }, { label: "Run events", requireBound: true });
  if (typeof source.loadEventsAfter !== "function" || typeof source.loadCursor !== "function" || typeof source.loadHead !== "function") {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger cannot replay events.", {
      status: 503,
    });
  }
  return source;
}

export async function assertPublicIntegrationRunCursorMatchesLedger(run = {}, ledger = {}, options = {}) {
  const label = options.label || "Run event cursor";
  const cursor = run.eventCursor || {};
  const lastSeq = integrationBoundedInteger(cursor.lastSeq, `${label} lastSeq`, { maximum: 10_000_000_000 });
  const lastHash = typeof cursor.lastHash === "string" && /^[a-f0-9]{64}$/u.test(cursor.lastHash) ? cursor.lastHash : "";
  if (!lastHash) {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} hash is invalid.`, { status: 503 });
  }
  if (!ledger || typeof ledger.loadHead !== "function") {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger head is unavailable.", {
      status: 503,
    });
  }
  const head = await ledger.loadHead();
  if (
    !head ||
    head.seq !== lastSeq ||
    head.hash !== lastHash ||
    typeof head.hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(head.hash)
  ) {
    throw new IntegrationValidationError("PUBLIC_EVENT_LEDGER_CORRUPT", "Run event cursor does not match public event ledger head.", {
      status: 503,
    });
  }
  return Object.freeze({ seq: lastSeq, hash: lastHash });
}

export async function writeIntegrationEventStream(res, options = {}) {
  const ledger = assertPublicIntegrationEventLedger(options.eventSource || options.eventLedger, options);
  const streamMs = boundedStreamNumber(options.streamMs, DEFAULT_INTEGRATION_EVENT_STREAM_MS, {
    minimum: 1,
    maximum: MAX_INTEGRATION_EVENT_STREAM_MS,
    label: "streamMs",
  });
  const pollMs = boundedStreamNumber(options.pollMs, DEFAULT_INTEGRATION_EVENT_POLL_MS, {
    minimum: 50,
    maximum: MAX_INTEGRATION_EVENT_POLL_MS,
    label: "pollMs",
  });
  let afterSeq = Number(options.afterSeq || 0);
  let afterHash = validateIntegrationLedgerHash(options.afterHash, "afterHash");
  let pendingEvents = await loadPublicIntegrationEvents({ ...options, eventSource: ledger, afterSeq, afterHash });
  res.status(200);
  res.set({
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.flushHeaders?.();

  try {
    const deadline = Date.now() + streamMs;
    let heartbeatAt = Date.now();
    let terminal = false;
    while (!options.signal?.aborted && !res.writableEnded && Date.now() < deadline) {
      const events = pendingEvents || (await loadPublicIntegrationEvents({ ...options, eventSource: ledger, afterSeq, afterHash }));
      pendingEvents = null;
      for (const event of events) {
        await writeSseChunk(res, formatIntegrationSseEvent(event), options.signal);
        afterSeq = event.seq;
        afterHash = event.hash;
        if (TERMINAL_EVENT_TYPES.has(event.type)) terminal = true;
      }
      if (terminal || options.once === true) break;
      if (Date.now() - heartbeatAt >= 15_000) {
        await writeSseChunk(res, ": keepalive\n\n", options.signal);
        heartbeatAt = Date.now();
      }
      await delay(pollMs, options.signal);
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    // After SSE headers are sent the public contract is detach/reconnect or status probe.
    // Do not synthesize unchained terminal events for authority failures.
    if (!res.writableEnded) {
      if (typeof res.destroy === "function") res.destroy(error);
      else res.end();
    }
  }
}
