import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import {
  INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
  INTEGRATION_ANALYSIS_PLANNER_ACTIVATION_SCHEMA_VERSION,
  INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
  assertIntegrationAnalysisPlanner,
  assertIntegrationAnalysisPlannerActivation,
} from "./integration-analysis-planner.js";
import { INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION } from "./integration-analysis-coordinator.js";
import {
  INTEGRATION_ANALYSIS_MUTATION_RECOVERY_SCHEMA_VERSION,
  INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
  INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
  assertPublicIntegrationResponse,
  projectPublicIntegrationResponse,
  sanitizePublicIntegrationRun,
  sanitizePublicIntegrationThread,
} from "./integration-api.js";
import { validateAgintiBrowserSession, validateAgintiPrincipalId } from "./integration-auth.js";
import { withDirectoryLock } from "./integration-durable-common.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  INTEGRATION_RPC_PATHS,
  canonicalJson,
  contractDigest,
  integrationBoundedInteger,
  integrationBoundedText,
  integrationExactKeys,
  integrationRpcPathIsMutation,
  validateIntegrationSearch,
  validateIntegrationIdempotencyKey,
  validateIntegrationArtifactId,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
  createPublicIntegrationEvent,
  validatePublicIntegrationEvent,
} from "./integration-events.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION = "aginti-integration-analysis-session-v1";
export const INTEGRATION_ANALYSIS_SESSION_STORAGE_VERSION = "aginti-integration-analysis-state-v2";
export const DEFAULT_INTEGRATION_ANALYSIS_STATE_ROOT = "/var/lib/agintiflow-integration/analysis";

export const INTEGRATION_ANALYSIS_SESSION_LIMITS = Object.freeze({
  maximumScopes: 1024,
  maximumThreadsPerScope: 128,
  maximumRunsPerScope: 512,
  maximumMessagesPerThread: 256,
  maximumMessageCharactersPerThread: 256_000,
  maximumEventsPerRun: 512,
  maximumArtifactsPerRun: 32,
  maximumArtifactsPerScope: 1024,
  maximumMutationReceiptsPerScope: 1024,
  maximumMutationReceiptResponseBytes: 256 * 1024,
  maximumStateBytes: 4 * 1024 * 1024,
  maximumPromptBytes: 32 * 1024,
  maximumConversationMessages: 24,
  maximumConversationMessageBytes: 8 * 1024,
  maximumConversationBytes: 48 * 1024,
  maximumConcurrentPlannerRuns: 2,
  maximumQueuedPlannerRuns: 16,
  maximumQueuedPlannerRunsPerScope: 4,
});

const ZERO_DIGEST = "0".repeat(64);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const TOOL_TERMINAL_EVENT_TYPES = new Set(["tool.completed", "tool.failed"]);
const SUCCESSFUL_EXECUTION_STATUSES = new Set(["succeeded", "completed"]);
const EXECUTION_STATES = new Set([
  "starting",
  "queued",
  "running",
  "succeeded",
  "completed",
  "failed",
  "timed_out",
  "output_limited",
  "cancelled",
  "sandbox_error",
  "artifact_invalid",
  "termination_unproven",
  "worker_error",
]);
const RUN_SCHEDULING_STATES = new Set(["starting", "queued", "running", "terminal"]);
const SESSION_BRAND = new WeakSet();
const SESSION_METADATA = new WeakMap();
const MESSAGE_DIGEST_VERSION = "aginti-analysis-public-message-v1";
const STATE_SCOPE_DIGEST_VERSION = "aginti-analysis-state-scope-v1";
const MUTATION_RECEIPT_SCHEMA_VERSION = "aginti-analysis-mutation-receipt-v1";
const PRIVATE_PATH_PATTERN =
  /(?:^|[\s("'`<>\[{=])(?:file:\/\/\/[^\s"'`<>)\]}]+|\/(?!\/)[^\s"'`<>)\]}]+|[A-Za-z]:[\\/][^\s"'`<>)\]}]+|\\\\[^\\/\s"'`<>)\]}]+\\[^\s"'`<>)\]}]+)/giu;
const O_NOFOLLOW = Number(fsConstants.O_NOFOLLOW || 0);

export class IntegrationAnalysisSessionError extends Error {
  constructor(code, message, { status = 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationAnalysisSessionError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, { status = 500, cause } = {}) {
  throw new IntegrationAnalysisSessionError(code, message, { status, cause });
}

function corrupt(cause) {
  fail("ANALYSIS_STATE_CORRUPT", "Durable analysis state failed integrity validation.", {
    status: 503,
    cause,
  });
}

function unavailable(cause) {
  fail("ANALYSIS_STATE_UNAVAILABLE", "Durable analysis state is unavailable.", {
    status: 503,
    cause,
  });
}

function notFound(label) {
  fail("NOT_FOUND", `${label} was not found.`, { status: 404 });
}

function conflict(code, message) {
  fail(code, message, { status: 409 });
}

function exact(value, allowed, required, label) {
  return integrationExactKeys(value, allowed, label, required);
}

function exactState(value, allowed, required, label) {
  try {
    return exact(value, allowed, required, label);
  } catch (error) {
    corrupt(error);
  }
}

function canonicalTimestamp(value, label) {
  const text = integrationBoundedText(value, label, 40, { minimum: 20 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail("INVALID_REQUEST", `${label} must be a canonical UTC timestamp.`, { status: 400 });
  }
  return text;
}

function stateTimestamp(value, label) {
  try {
    return canonicalTimestamp(value, label);
  } catch (error) {
    corrupt(error);
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("INVALID_REQUEST", `${label} is invalid.`, { status: 400 });
  }
  return value;
}

function stateDigest(value, label) {
  try {
    return digest(value, label);
  } catch (error) {
    corrupt(error);
  }
}

function publicText(value, label, maximum = 32_000) {
  const checked = integrationBoundedText(String(value ?? ""), label, maximum);
  const redacted = redactSensitiveText(checked).replace(PRIVATE_PATH_PATTERN, (match) => {
    const prefix = /^[\s("'`<>\[{=]/u.test(match) ? match[0] : "";
    return `${prefix}[REDACTED_PATH]`;
  });
  return redacted.length <= maximum ? redacted : redacted.slice(0, maximum);
}

function publicErrorCode(error) {
  const code = String(error?.publicCode || error?.code || "ANALYSIS_FAILED").trim();
  return /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : "ANALYSIS_FAILED";
}

function publicFailureMessage(error, code = publicErrorCode(error)) {
  const plannerMessage = String(error?.message || "");
  if (code === "ANALYSIS_EXPLICIT_PYTHON_INVALID") {
    return "Python was not run because the request was ambiguous or malformed. Use exactly one fenced block labelled python and a direct instruction such as ‘Run this code.’";
  }
  if (code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED") {
    return "Python ran, but it did not produce the requested plot. Call emit_plot(...) and resume with corrected code.";
  }
  if (code === "ANALYSIS_EXECUTION_FAILED") {
    if (plannerMessage === "The requested Python execution timed out.") {
      return "Python execution timed out after 10 seconds. Reduce the work or split it into smaller steps, then resume.";
    }
    if (plannerMessage === "The requested Python uses packages unavailable in the bounded standard-library runtime.") {
      return "Python was not run because this execution sandbox supports the standard library only. Remove third-party imports, then resume.";
    }
    return "Python execution failed. Check the code for syntax or runtime errors and unavailable packages, then resume with corrected code.";
  }
  if (code === "ANALYSIS_MODEL_UNAVAILABLE") {
    return "The local analysis model is temporarily unavailable. Resume this run to try again.";
  }
  if (code === "ANALYSIS_PYTHON_TOOL_REQUIRED" || code === "ANALYSIS_TOOL_REQUIRED") {
    return "The agent could not form a valid bounded Python execution request. Make the run instruction explicit, then resume.";
  }
  if (code === "ANALYSIS_CONTEXT_BUDGET_EXCEEDED") {
    return "This request is too large for the local analysis context. Shorten it or split it into smaller steps, then resume.";
  }
  if (code === "GROUNDED_SEARCH_NO_USABLE_SOURCES") {
    return "Search completed, but no safe evidence sources were available. Resume to try again or choose another search mode.";
  }
  if (code.startsWith("GROUNDED_SEARCH_")) {
    return "Grounded search is temporarily unavailable. Your prompt and search settings were preserved; resume this run to try again.";
  }
  return "Analysis could not be completed. You can resume this run.";
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function clipUtf8(value, maximumBytes) {
  const text = String(value || "");
  if (byteLength(text) <= maximumBytes) return text;
  let output = "";
  let bytes = 0;
  for (const character of text) {
    const next = byteLength(character);
    if (bytes + next > maximumBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

function normalizePrompt(value) {
  const prompt = integrationBoundedText(value, "analysis prompt", 32_000, { minimum: 1 }).trim();
  if (!prompt) fail("INVALID_REQUEST", "Analysis prompt must not be blank.", { status: 400 });
  if (byteLength(prompt) > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumPromptBytes) {
    fail("ANALYSIS_INPUT_TOO_LARGE", "Analysis prompt exceeds the durable analysis input limit.", { status: 413 });
  }
  return prompt;
}

function normalizeTitle(value) {
  const title = integrationBoundedText(value, "thread title", 120, {
    minimum: 1,
    presentational: true,
  }).trim();
  if (!title) fail("INVALID_REQUEST", "Thread title must not be blank.", { status: 400 });
  return title;
}

function normalizeStateRoot(value, { testOnly = false } = {}) {
  const root = String(value || DEFAULT_INTEGRATION_ANALYSIS_STATE_ROOT);
  if (!root || root.includes("\u0000") || !path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) {
    fail("ANALYSIS_CONFIGURATION_INVALID", "Analysis state root must be one canonical absolute directory.", {
      status: 500,
    });
  }
  if (!testOnly && (root === "/tmp" || root.startsWith("/tmp/") || root === "/var/tmp" || root.startsWith("/var/tmp/"))) {
    fail("ANALYSIS_CONFIGURATION_INVALID", "Production analysis state may not use a temporary directory.", {
      status: 500,
    });
  }
  return root;
}

function normalizeScopeFromContext(context = {}) {
  const principalId = validateAgintiPrincipalId(context.principalId ?? context.principal?.id);
  const browserSessionId = validateAgintiBrowserSession(context.browserSessionId ?? context.browserSession?.id);
  if (context.principalId && context.principal?.id && context.principalId !== context.principal.id) notFound("Scope");
  if (context.browserSessionId && context.browserSession?.id && context.browserSessionId !== context.browserSession.id) notFound("Scope");
  return Object.freeze({ principalId, browserSessionId });
}

function scopeWithRun(scope, threadId, runId) {
  return Object.freeze({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: validateIntegrationThreadId(threadId),
    runId: validateIntegrationRunId(runId),
  });
}

function scopeDigest(scope) {
  return contractDigest({
    schemaVersion: STATE_SCOPE_DIGEST_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
}

function mutationReceiptId(scope, pathname, idempotencyKeyDigest) {
  return contractDigest({
    schemaVersion: MUTATION_RECEIPT_SCHEMA_VERSION,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname,
    idempotencyKeyDigest,
  });
}

function mutationReceiptDigest(scope, receipt) {
  return contractDigest({
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    pathname: receipt.pathname,
    requestHash: receipt.requestHash,
    idempotencyKeyDigest: receipt.idempotencyKeyDigest,
    createdAt: receipt.createdAt,
    expiresAt: receipt.expiresAt,
    response: receipt.response,
  });
}

function normalizedMutationIdentity(scope, pathname, payload, context, { required }) {
  if (!context?.requestHash && !context?.idempotencyKeyDigest && !context?.idempotencyKey) {
    if (!required) return null;
    fail("ANALYSIS_MUTATION_IDENTITY_REQUIRED", "Durable mutation identity is required.", { status: 503 });
  }
  if (!integrationRpcPathIsMutation(pathname) || context.pathname !== pathname) {
    fail("ANALYSIS_MUTATION_IDENTITY_INVALID", "Durable mutation path identity is invalid.", { status: 400 });
  }
  const idempotencyKey = validateIntegrationIdempotencyKey(context.idempotencyKey);
  const idempotencyKeyDigest = crypto.createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  if (context.idempotencyKeyDigest !== idempotencyKeyDigest) {
    fail("ANALYSIS_MUTATION_IDENTITY_INVALID", "Durable mutation key identity is invalid.", { status: 400 });
  }
  const requestHash = contractDigest({
    algorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    operation: pathname,
    request: payload,
  });
  if (context.requestHash !== requestHash) {
    fail("ANALYSIS_MUTATION_IDENTITY_INVALID", "Durable mutation request identity is invalid.", { status: 400 });
  }
  return Object.freeze({ pathname, requestHash, idempotencyKeyDigest });
}

function publicProjectionContext(scope) {
  return Object.freeze({
    principal: Object.freeze({ id: scope.principalId }),
    browserSession: Object.freeze({ id: scope.browserSessionId }),
  });
}

function projectedMutationResponse(scope, identity, payload, result) {
  let response;
  try {
    response = projectPublicIntegrationResponse(
      identity.pathname,
      result,
      payload,
      publicProjectionContext(scope)
    );
    response = assertPublicIntegrationResponse(identity.pathname, response);
  } catch (error) {
    fail("ANALYSIS_MUTATION_RESPONSE_INVALID", "Durable mutation response is not publicly recoverable.", {
      status: 503,
      cause: error,
    });
  }
  const serialized = canonicalJson(response);
  if (Buffer.byteLength(serialized, "utf8") > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMutationReceiptResponseBytes) {
    fail("ANALYSIS_MUTATION_RESPONSE_TOO_LARGE", "Durable mutation response exceeds its recovery limit.", {
      status: 409,
    });
  }
  return JSON.parse(serialized);
}

function appendMutationReceipt(state, scope, identity, response, createdAt) {
  const nowMs = Date.parse(createdAt);
  state.mutationReceipts = state.mutationReceipts.filter(
    (receipt) => Date.parse(receipt.expiresAt) > nowMs
  );
  const id = mutationReceiptId(scope, identity.pathname, identity.idempotencyKeyDigest);
  const existing = state.mutationReceipts.find((receipt) => receipt.id === id);
  if (existing) {
    if (existing.requestHash !== identity.requestHash) {
      conflict("IDEMPOTENCY_CONFLICT", "The durable mutation key belongs to a different request.");
    }
    fail("ANALYSIS_MUTATION_ALREADY_COMMITTED", "The durable mutation was already committed; replay its receipt.", {
      status: 503,
    });
  }
  if (state.mutationReceipts.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMutationReceiptsPerScope) {
    conflict("ANALYSIS_MUTATION_RECEIPT_CAPACITY_EXHAUSTED", "Durable mutation receipt capacity is exhausted.");
  }
  const expiresAt = new Date(nowMs + INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS).toISOString();
  const receipt = {
    schemaVersion: MUTATION_RECEIPT_SCHEMA_VERSION,
    id,
    pathname: identity.pathname,
    requestHash: identity.requestHash,
    idempotencyKeyDigest: identity.idempotencyKeyDigest,
    createdAt,
    expiresAt,
    response,
    digest: "",
  };
  receipt.digest = mutationReceiptDigest(scope, receipt);
  state.mutationReceipts.push(receipt);
  return receipt;
}

function mutationRecoveryAuthority() {
  const unsigned = Object.freeze({
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
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function initialState(scope) {
  return {
    schemaVersion: INTEGRATION_ANALYSIS_SESSION_STORAGE_VERSION,
    scope: {
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      browserSessionPolicy: "same-browser-session",
    },
    revision: 1,
    threads: [],
    runs: [],
    artifacts: [],
    mutationReceipts: [],
  };
}

function newThreadId() {
  return `thr_${crypto.randomUUID()}`;
}

function newRunId() {
  return `run_${crypto.randomUUID()}`;
}

function newMessageId() {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function messageDigest(threadId, message, previousDigest) {
  return contractDigest({
    schemaVersion: MESSAGE_DIGEST_VERSION,
    threadId,
    previousDigest,
    id: message.id,
    role: message.role,
    content: message.content,
    runId: message.runId,
    createdAt: message.createdAt,
  });
}

function appendMessage(thread, { role, content, runId, createdAt }) {
  if (thread.messages.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMessagesPerThread) {
    conflict("ANALYSIS_THREAD_FULL", "Thread message capacity is exhausted.");
  }
  const previousDigest = thread.messages.at(-1)?.digest || thread.replay.anchorDigest;
  const message = {
    id: newMessageId(),
    role,
    content: publicText(content, "public message content"),
    runId: validateIntegrationRunId(runId),
    createdAt: canonicalTimestamp(createdAt, "public message createdAt"),
    digest: "",
  };
  message.digest = messageDigest(thread.id, message, previousDigest);
  thread.messages.push(message);
  thread.authority.contextDigest = message.digest;
  return message;
}

function touchThread(thread, timestamp, { status, lastRunId } = {}) {
  thread.revision += 1;
  thread.updatedAt = timestamp;
  thread.authority.runtimeRevision = thread.revision;
  if (status !== undefined) thread.status = status;
  if (lastRunId !== undefined) thread.lastRunId = lastRunId;
}

function appendEvent(run, type, payload, createdAt) {
  if (run.events.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumEventsPerRun) {
    fail("ANALYSIS_EVENT_CAPACITY_EXHAUSTED", "Run event capacity is exhausted.", { status: 503 });
  }
  if (run.events.some((event) => TERMINAL_EVENT_TYPES.has(event.type))) {
    fail("ANALYSIS_EVENT_LEDGER_CLOSED", "Run event ledger is already terminal.", { status: 503 });
  }
  const previousHash = run.events.at(-1)?.hash || ZERO_DIGEST;
  const event = createPublicIntegrationEvent({
    threadId: run.threadId,
    runId: run.id,
    seq: run.events.length + 1,
    type,
    payload,
    createdAt,
    previousHash,
  });
  run.events.push(event);
  return event;
}

function runCursor(run) {
  return Object.freeze({
    firstSeq: 1,
    lastSeq: run.events.length,
    lastHash: run.events.at(-1)?.hash || ZERO_DIGEST,
    prunedThroughSeq: 0,
  });
}

function ownedThread(thread, { includeMessages = true } = {}) {
  const publicRecord = sanitizePublicIntegrationThread(
    {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      revision: thread.revision,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastRunId: thread.lastRunId,
      authority: thread.authority,
      replay: thread.replay,
      messages: includeMessages ? thread.messages : [],
    },
    { publicContract: true }
  );
  return Object.freeze({
    ...publicRecord,
    principalId: thread.principalId,
    browserSessionId: thread.browserSessionId,
    browserSessionPolicy: "same-browser-session",
  });
}

function ownedRun(run) {
  const publicRecord = sanitizePublicIntegrationRun(
    {
      id: run.id,
      threadId: run.threadId,
      previousRunId: run.previousRunId,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      cancelRequestedAt: run.cancelRequestedAt,
      output: run.output,
      error: run.error,
      authority: run.authority,
      eventCursor: runCursor(run),
    },
    { publicContract: true }
  );
  return Object.freeze({
    ...publicRecord,
    principalId: run.principalId,
    browserSessionId: run.browserSessionId,
    browserSessionPolicy: "same-browser-session",
  });
}

function ownedArtifact(artifact) {
  const publicArtifact = sanitizeIntegrationArtifact({
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    spec: artifact.spec,
  });
  return Object.freeze({
    ...publicArtifact,
    principalId: artifact.principalId,
    browserSessionId: artifact.browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: artifact.threadId,
    runId: artifact.runId,
  });
}

function validateMessage(message, thread, runsById, previousDigest, index) {
  const item = exactState(
    message,
    ["id", "role", "content", "runId", "createdAt", "digest"],
    ["id", "role", "content", "runId", "createdAt", "digest"],
    `state thread message[${index}]`
  );
  if (typeof item.id !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(item.id)) corrupt();
  if (item.role !== "user" && item.role !== "assistant") corrupt();
  try {
    integrationBoundedText(item.content, `state thread message[${index}].content`, 32_000);
    validateIntegrationRunId(item.runId);
  } catch (error) {
    corrupt(error);
  }
  stateTimestamp(item.createdAt, `state thread message[${index}].createdAt`);
  stateDigest(item.digest, `state thread message[${index}].digest`);
  const run = runsById.get(item.runId);
  if (!run || run.threadId !== thread.id) corrupt();
  if (item.digest !== messageDigest(thread.id, item, previousDigest)) corrupt();
  return item.digest;
}

function validateThread(thread, scope, runsById) {
  exactState(
    thread,
    [
      "id",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "title",
      "status",
      "revision",
      "createdAt",
      "updatedAt",
      "lastRunId",
      "authority",
      "replay",
      "messages",
    ],
    [
      "id",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "title",
      "status",
      "revision",
      "createdAt",
      "updatedAt",
      "lastRunId",
      "authority",
      "replay",
      "messages",
    ],
    "state thread"
  );
  if (
    thread.principalId !== scope.principalId ||
    thread.browserSessionId !== scope.browserSessionId ||
    thread.browserSessionPolicy !== "same-browser-session"
  ) {
    corrupt();
  }
  try {
    validateIntegrationThreadId(thread.id);
    sanitizePublicIntegrationThread(
      {
        id: thread.id,
        title: thread.title,
        status: thread.status,
        revision: thread.revision,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastRunId: thread.lastRunId,
        authority: thread.authority,
        replay: thread.replay,
        messages: thread.messages,
      },
      { publicContract: true }
    );
  } catch (error) {
    corrupt(error);
  }
  if (thread.replay.prunedMessageCount !== 0 || thread.replay.anchorDigest !== ZERO_DIGEST) corrupt();
  if (thread.messages.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMessagesPerThread) corrupt();
  let previousDigest = thread.replay.anchorDigest;
  const messageIds = new Set();
  for (let index = 0; index < thread.messages.length; index += 1) {
    const message = thread.messages[index];
    if (messageIds.has(message.id)) corrupt();
    messageIds.add(message.id);
    previousDigest = validateMessage(message, thread, runsById, previousDigest, index);
  }
  if (thread.authority.contextDigest !== previousDigest) corrupt();
  if (thread.authority.runtimeRevision !== thread.revision || thread.authority.mapped !== true) corrupt();
  if (thread.lastRunId !== null) {
    const run = runsById.get(thread.lastRunId);
    if (!run || run.threadId !== thread.id) corrupt();
  }
}

function validateRun(run, scope, threadIds) {
  exactState(
    run,
    [
      "id",
      "threadId",
      "previousRunId",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "status",
      "schedulingState",
      "createdAt",
      "startedAt",
      "completedAt",
      "cancelRequestedAt",
      "output",
      "error",
      "authority",
      "inputMessageId",
      "search",
      "events",
    ],
    [
      "id",
      "threadId",
      "previousRunId",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "status",
      "schedulingState",
      "createdAt",
      "startedAt",
      "completedAt",
      "cancelRequestedAt",
      "output",
      "error",
      "authority",
      "inputMessageId",
      "events",
    ],
    "state run"
  );
  if (
    run.principalId !== scope.principalId ||
    run.browserSessionId !== scope.browserSessionId ||
    run.browserSessionPolicy !== "same-browser-session" ||
    !threadIds.has(run.threadId)
  ) {
    corrupt();
  }
  if (!RUN_SCHEDULING_STATES.has(run.schedulingState)) corrupt();
  if (run.search !== undefined) {
    try {
      const normalizedSearch = validateIntegrationSearch(run.search);
      if (canonicalJson(normalizedSearch) !== canonicalJson(run.search)) corrupt();
    } catch (error) {
      corrupt(error);
    }
  }
  if (typeof run.inputMessageId !== "string" || !/^msg_[A-Za-z0-9_-]{16,96}$/u.test(run.inputMessageId)) corrupt();
  if (!Array.isArray(run.events) || run.events.length < 1 || run.events.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumEventsPerRun) corrupt();
  try {
    validateIntegrationRunId(run.id);
    validateIntegrationThreadId(run.threadId);
    if (run.previousRunId !== null) validateIntegrationRunId(run.previousRunId);
    sanitizePublicIntegrationRun(
      {
        id: run.id,
        threadId: run.threadId,
        previousRunId: run.previousRunId,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        cancelRequestedAt: run.cancelRequestedAt,
        output: run.output,
        error: run.error,
        authority: run.authority,
        eventCursor: runCursor(run),
      },
      { publicContract: true }
    );
  } catch (error) {
    corrupt(error);
  }
  let previousHash = ZERO_DIGEST;
  let terminalIndex = -1;
  const eventIds = new Set();
  for (let index = 0; index < run.events.length; index += 1) {
    let event;
    try {
      event = validatePublicIntegrationEvent(run.events[index]);
    } catch (error) {
      corrupt(error);
    }
    if (
      event.threadId !== run.threadId ||
      event.runId !== run.id ||
      event.seq !== index + 1 ||
      event.previousHash !== previousHash ||
      eventIds.has(event.id)
    ) {
      corrupt();
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      if (terminalIndex !== -1 || index !== run.events.length - 1) corrupt();
      terminalIndex = index;
    }
    eventIds.add(event.id);
    previousHash = event.hash;
  }
  if (run.events[0].type !== "run.status" || run.events[0].payload.status !== "starting") corrupt();
  const declaredRunning = run.events.some(
    (event) => event.type === "run.status" && event.payload.status === "running"
  );
  if ((run.status === "running" || run.status === "completed") && (!declaredRunning || run.startedAt === null)) corrupt();
  if (run.status === "starting" && (declaredRunning || run.startedAt !== null)) corrupt();
  if (
    (run.status === "starting" && !new Set(["starting", "queued"]).has(run.schedulingState)) ||
    (run.status === "running" && run.schedulingState !== "running") ||
    (TERMINAL_RUN_STATUSES.has(run.status) && run.schedulingState !== "terminal")
  ) {
    corrupt();
  }
  const expectedTerminal = {
    completed: "run.completed",
    failed: "run.failed",
    cancelled: "run.cancelled",
  }[run.status];
  const terminalType = terminalIndex === -1 ? "" : run.events[terminalIndex].type;
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    if (terminalType !== expectedTerminal || run.completedAt === null) corrupt();
  } else if (terminalIndex !== -1 || run.completedAt !== null) {
    corrupt();
  }
  if (run.status === "failed" && run.error === null) corrupt();
  if (run.status === "completed" && run.error !== null) corrupt();
  if (run.status === "cancelled" && run.cancelRequestedAt === null) corrupt();
  const outputCompletedEvents = run.events.filter((event) => event.type === "output.completed");
  const emittedOutput = run.events
    .filter((event) => event.type === "output.delta")
    .map((event) => event.payload.text)
    .join("");
  if (run.status === "completed") {
    if (outputCompletedEvents.length !== 1 || emittedOutput !== run.output) corrupt();
  } else if (outputCompletedEvents.length !== 0 || emittedOutput !== "" || run.output !== "") {
    corrupt();
  }
}

function validateArtifact(artifact, scope, runsById) {
  exactState(
    artifact,
    [
      "id",
      "title",
      "kind",
      "spec",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "threadId",
      "runId",
      "createdAt",
    ],
    [
      "id",
      "title",
      "kind",
      "spec",
      "principalId",
      "browserSessionId",
      "browserSessionPolicy",
      "threadId",
      "runId",
      "createdAt",
    ],
    "state artifact"
  );
  if (
    artifact.principalId !== scope.principalId ||
    artifact.browserSessionId !== scope.browserSessionId ||
    artifact.browserSessionPolicy !== "same-browser-session"
  ) {
    corrupt();
  }
  const run = runsById.get(artifact.runId);
  if (!run || run.threadId !== artifact.threadId) corrupt();
  stateTimestamp(artifact.createdAt, "state artifact createdAt");
  try {
    validateIntegrationArtifactId(artifact.id);
    sanitizeIntegrationArtifact({ id: artifact.id, title: artifact.title, kind: artifact.kind, spec: artifact.spec });
  } catch (error) {
    corrupt(error);
  }
  const createdEvent = run.events.find(
    (event) => event.type === "artifact.created" && event.payload?.artifact?.id === artifact.id
  );
  if (!createdEvent) corrupt();
  const terminalEvent = run.events.find((event) => TERMINAL_EVENT_TYPES.has(event.type));
  if (terminalEvent && createdEvent.seq >= terminalEvent.seq) corrupt();
}

function validateMutationReceipt(receipt, scope) {
  exactState(
    receipt,
    [
      "schemaVersion",
      "id",
      "pathname",
      "requestHash",
      "idempotencyKeyDigest",
      "createdAt",
      "expiresAt",
      "response",
      "digest",
    ],
    [
      "schemaVersion",
      "id",
      "pathname",
      "requestHash",
      "idempotencyKeyDigest",
      "createdAt",
      "expiresAt",
      "response",
      "digest",
    ],
    "analysis mutation receipt"
  );
  if (
    receipt.schemaVersion !== MUTATION_RECEIPT_SCHEMA_VERSION ||
    !integrationRpcPathIsMutation(receipt.pathname)
  ) {
    corrupt();
  }
  stateDigest(receipt.id, "analysis mutation receipt id");
  stateDigest(receipt.requestHash, "analysis mutation receipt requestHash");
  stateDigest(receipt.idempotencyKeyDigest, "analysis mutation receipt idempotencyKeyDigest");
  stateDigest(receipt.digest, "analysis mutation receipt digest");
  const createdAt = stateTimestamp(receipt.createdAt, "analysis mutation receipt createdAt");
  const expiresAt = stateTimestamp(receipt.expiresAt, "analysis mutation receipt expiresAt");
  if (Date.parse(expiresAt) - Date.parse(createdAt) !== INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS) corrupt();
  if (receipt.id !== mutationReceiptId(scope, receipt.pathname, receipt.idempotencyKeyDigest)) corrupt();
  if (receipt.digest !== mutationReceiptDigest(scope, receipt)) corrupt();
  let response;
  try {
    response = assertPublicIntegrationResponse(receipt.pathname, receipt.response);
  } catch (error) {
    corrupt(error);
  }
  if (
    canonicalJson(response) !== canonicalJson(receipt.response) ||
    Buffer.byteLength(canonicalJson(receipt.response), "utf8") >
      INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMutationReceiptResponseBytes
  ) {
    corrupt();
  }
}

function validateState(state, expectedScope) {
  exactState(
    state,
    ["schemaVersion", "scope", "revision", "threads", "runs", "artifacts", "mutationReceipts"],
    ["schemaVersion", "scope", "revision", "threads", "runs", "artifacts", "mutationReceipts"],
    "analysis state"
  );
  if (state.schemaVersion !== INTEGRATION_ANALYSIS_SESSION_STORAGE_VERSION) corrupt();
  exactState(
    state.scope,
    ["principalId", "browserSessionId", "browserSessionPolicy"],
    ["principalId", "browserSessionId", "browserSessionPolicy"],
    "analysis state scope"
  );
  if (
    state.scope.principalId !== expectedScope.principalId ||
    state.scope.browserSessionId !== expectedScope.browserSessionId ||
    state.scope.browserSessionPolicy !== "same-browser-session"
  ) {
    corrupt();
  }
  try {
    integrationBoundedInteger(state.revision, "analysis state revision", { minimum: 1 });
  } catch (error) {
    corrupt(error);
  }
  if (
    !Array.isArray(state.threads) ||
    !Array.isArray(state.runs) ||
    !Array.isArray(state.artifacts) ||
    !Array.isArray(state.mutationReceipts) ||
    state.threads.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumThreadsPerScope ||
    state.runs.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumRunsPerScope ||
    state.artifacts.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerScope ||
    state.mutationReceipts.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMutationReceiptsPerScope
  ) {
    corrupt();
  }
  const threadIds = new Set();
  for (const thread of state.threads) {
    if (threadIds.has(thread.id)) corrupt();
    threadIds.add(thread.id);
  }
  const runsById = new Map();
  for (const run of state.runs) {
    if (runsById.has(run.id)) corrupt();
    runsById.set(run.id, run);
    validateRun(run, expectedScope, threadIds);
  }
  for (const run of state.runs) {
    if (run.previousRunId !== null) {
      const previous = runsById.get(run.previousRunId);
      if (
        !previous ||
        previous.threadId !== run.threadId ||
        !TERMINAL_RUN_STATUSES.has(previous.status) ||
        previous.createdAt > run.createdAt
      ) {
        corrupt();
      }
      const seen = new Set([run.id]);
      let cursor = previous;
      while (cursor) {
        if (seen.has(cursor.id)) corrupt();
        seen.add(cursor.id);
        cursor = cursor.previousRunId === null ? null : runsById.get(cursor.previousRunId);
        if (cursor === undefined) corrupt();
      }
    }
  }
  for (const thread of state.threads) validateThread(thread, expectedScope, runsById);
  for (const run of state.runs) {
    const thread = state.threads.find((item) => item.id === run.threadId);
    const runMessages = thread?.messages.filter((message) => message.runId === run.id) || [];
    const inputMessages = runMessages.filter((message) => message.role === "user");
    const assistantMessages = runMessages.filter((message) => message.role === "assistant");
    if (
      inputMessages.length !== 1 ||
      inputMessages[0].id !== run.inputMessageId ||
      (run.status === "completed" ? assistantMessages.length !== 1 : assistantMessages.length !== 0) ||
      (run.status === "completed" && assistantMessages[0].content !== run.output)
    ) {
      corrupt();
    }
  }
  const artifactIds = new Set();
  const artifactCounts = new Map();
  for (const artifact of state.artifacts) {
    if (artifactIds.has(artifact.id)) corrupt();
    artifactIds.add(artifact.id);
    validateArtifact(artifact, expectedScope, runsById);
    artifactCounts.set(artifact.runId, (artifactCounts.get(artifact.runId) || 0) + 1);
    if (artifactCounts.get(artifact.runId) > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerRun) corrupt();
  }
  for (const run of state.runs) {
    for (const event of run.events) {
      if (event.type !== "artifact.created" && event.type !== "artifact.updated") continue;
      const artifact = state.artifacts.find((item) => item.id === event.payload.artifact.id);
      if (!artifact || artifact.runId !== run.id || artifact.threadId !== run.threadId) corrupt();
    }
  }
  for (const thread of state.threads) {
    const activeRunCount = state.runs.filter(
      (run) => run.threadId === thread.id && !TERMINAL_RUN_STATUSES.has(run.status)
    ).length;
    if (activeRunCount > 1) corrupt();
    const hasActiveRun = activeRunCount === 1;
    if ((thread.status === "running") !== hasActiveRun || thread.status === "deleting") corrupt();
  }
  const mutationReceiptIds = new Set();
  for (const receipt of state.mutationReceipts) {
    if (mutationReceiptIds.has(receipt.id)) corrupt();
    mutationReceiptIds.add(receipt.id);
    validateMutationReceipt(receipt, expectedScope);
  }
  return state;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function statOwnerIsTrusted(stat, { leaf = false } = {}) {
  const uid = currentUid();
  if (uid === null) return true;
  return leaf ? stat.uid === uid : stat.uid === uid || stat.uid === 0;
}

function safeMode(stat, expected, { allowStickyTestAncestor = false } = {}) {
  const mode = stat.mode & 0o7777;
  if (allowStickyTestAncestor && (mode & 0o1000) !== 0) return true;
  return expected === null ? (mode & 0o022) === 0 : (mode & 0o777) === expected;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unavailable(error);
  }
}

async function assertDirectory(target, { leaf = false, testOnly = false } = {}) {
  const stat = await lstatOrNull(target);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !statOwnerIsTrusted(stat, { leaf })) corrupt();
  const allowStickyTestAncestor = testOnly && !leaf && (stat.mode & 0o1000) !== 0;
  if (!safeMode(stat, leaf ? 0o700 : null, { allowStickyTestAncestor })) corrupt();
  return stat;
}

async function ensureDirectoryTree(target, { testOnly = false } = {}) {
  const parsed = path.parse(target);
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const leaf = index === parts.length - 1;
    let stat = await assertDirectory(cursor, { leaf, testOnly });
    if (!stat) {
      const parent = path.dirname(cursor);
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") unavailable(error);
      }
      stat = await assertDirectory(cursor, { leaf: true, testOnly });
      if (!stat) unavailable();
      await syncDirectory(parent);
    }
  }
  let real;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    unavailable(error);
  }
  if (real !== target) corrupt();
}

async function ensurePrivateDirectory(target, stateRoot, options) {
  const relative = path.relative(stateRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) corrupt();
  const parent = path.dirname(target);
  if (target !== stateRoot) await assertDirectory(parent, { leaf: true, testOnly: options.testOnly });
  let stat = await assertDirectory(target, { leaf: true, testOnly: options.testOnly });
  if (!stat) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") unavailable(error);
    }
    stat = await assertDirectory(target, { leaf: true, testOnly: options.testOnly });
    await syncDirectory(parent);
  }
  if (!stat) unavailable();
}

async function verifyRegularPrivateFile(handle, target) {
  let opened;
  let named;
  try {
    opened = await handle.stat();
    named = await fs.lstat(target);
  } catch (error) {
    unavailable(error);
  }
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.isSymbolicLink?.() ||
    named.isSymbolicLink() ||
    opened.nlink !== 1 ||
    named.nlink !== 1 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    !statOwnerIsTrusted(opened, { leaf: true }) ||
    !safeMode(opened, 0o600)
  ) {
    corrupt();
  }
  if (opened.size > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumStateBytes) corrupt();
  return opened;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY | O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    unavailable(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function envelopeForState(state) {
  const unsigned = {
    schemaVersion: INTEGRATION_ANALYSIS_SESSION_STORAGE_VERSION,
    state,
  };
  return {
    ...unsigned,
    digest: contractDigest(unsigned),
  };
}

function parseStateEnvelope(text, expectedScope) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    corrupt(error);
  }
  exactState(
    envelope,
    ["schemaVersion", "state", "digest"],
    ["schemaVersion", "state", "digest"],
    "analysis state envelope"
  );
  if (envelope.schemaVersion !== INTEGRATION_ANALYSIS_SESSION_STORAGE_VERSION) corrupt();
  stateDigest(envelope.digest, "analysis state envelope digest");
  const unsigned = { schemaVersion: envelope.schemaVersion, state: envelope.state };
  if (envelope.digest !== contractDigest(unsigned)) corrupt();
  let canonical;
  try {
    canonical = `${canonicalJson(envelope)}\n`;
  } catch (error) {
    corrupt(error);
  }
  if (canonical !== text) corrupt();
  return validateState(envelope.state, expectedScope);
}

function stateFilePaths(stateRoot, scope) {
  const id = scopeDigest(scope);
  const scopesDirectory = path.join(stateRoot, "scopes");
  const scopeDirectory = path.join(scopesDirectory, id);
  return Object.freeze({ scopesDirectory, scopeDirectory, stateFile: path.join(scopeDirectory, "state.json") });
}

function validateActivationProof(value, { required }) {
  if (value === undefined || value === null) {
    if (required) {
      fail("ANALYSIS_CONFIGURATION_INVALID", "A pinned execution activation proof is required.", { status: 500 });
    }
    return null;
  }
  const proof = exact(
    value,
    [
      "schemaVersion",
      "ready",
      "publicActivationReady",
      "workerCapabilityDigest",
      "workerHealthDigest",
      "coordinatorProtocolDigest",
      "coordinatorHealthDigest",
      "runtimeProfile",
      "runtimeBundleRootDigest",
      "seccompPolicyDigest",
      "cgroupPolicyDigest",
      "digest",
    ],
    [
      "schemaVersion",
      "ready",
      "publicActivationReady",
      "workerCapabilityDigest",
      "workerHealthDigest",
      "coordinatorProtocolDigest",
      "coordinatorHealthDigest",
      "runtimeProfile",
      "runtimeBundleRootDigest",
      "seccompPolicyDigest",
      "cgroupPolicyDigest",
      "digest",
    ],
    "execution activation proof"
  );
  if (
    !Object.isFrozen(proof) ||
    proof.schemaVersion !== INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION ||
    proof.ready !== true ||
    proof.publicActivationReady !== true ||
    typeof proof.runtimeProfile !== "string" ||
    !/^[A-Za-z0-9._+~-]{1,192}$/u.test(proof.runtimeProfile)
  ) {
    fail("ANALYSIS_CONFIGURATION_INVALID", "Execution activation proof is not immutable and ready.", { status: 500 });
  }
  for (const field of [
    "workerCapabilityDigest",
    "workerHealthDigest",
    "coordinatorProtocolDigest",
    "coordinatorHealthDigest",
    "runtimeBundleRootDigest",
    "seccompPolicyDigest",
    "cgroupPolicyDigest",
    "digest",
  ]) {
    if (typeof proof[field] !== "string" || !/^[a-f0-9]{64}$/u.test(proof[field])) {
      fail("ANALYSIS_CONFIGURATION_INVALID", "Execution activation proof contains an invalid digest.", { status: 500 });
    }
  }
  const { digest: suppliedDigest, ...unsigned } = proof;
  if (suppliedDigest !== contractDigest(unsigned)) {
    fail("ANALYSIS_CONFIGURATION_INVALID", "Execution activation proof digest is invalid.", { status: 500 });
  }
  return Object.freeze({ ...unsigned, digest: suppliedDigest });
}

function openFlags(mode) {
  return mode | O_NOFOLLOW;
}

function createService(options, { testOnly }) {
  const analysisRunner = options.analysisRunner;
  const plannerActivation = options.plannerActivation || null;
  if (!analysisRunner || typeof analysisRunner.run !== "function") {
    fail("ANALYSIS_CONFIGURATION_INVALID", "A trusted analysis runner is required.", { status: 500 });
  }
  if (!testOnly) {
    try {
      assertIntegrationAnalysisPlanner(analysisRunner, { requireSystemdCredential: true });
      assertIntegrationAnalysisPlannerActivation(plannerActivation, {
        planner: analysisRunner,
        requireSystemdCredential: true,
      });
    } catch (error) {
      fail("ANALYSIS_CONFIGURATION_INVALID", "The analysis runner lacks its bound production activation.", {
        status: 500,
        cause: error,
      });
    }
  }
  const stateRoot = normalizeStateRoot(options.stateRoot, { testOnly });
  const activationProof = validateActivationProof(
    testOnly ? options.activationProof : plannerActivation.readinessProof,
    { required: !testOnly }
  );
  const now = testOnly && typeof options.now === "function" ? options.now : () => new Date();
  const runnerDigest =
    typeof analysisRunner.attestation?.digest === "string" && /^[a-f0-9]{64}$/u.test(analysisRunner.attestation.digest)
      ? analysisRunner.attestation.digest
      : testOnly
        ? contractDigest({ testOnlyRunner: true })
        : ZERO_DIGEST;
  const fixedCoordinatorDigest = plannerActivation?.coordinatorDigest || ZERO_DIGEST;
  const plannerActivationDigest = plannerActivation?.digest || ZERO_DIGEST;
  const searchEnabled = testOnly
    ? options.searchEnabled === true
    : plannerActivation?.groundedSearch?.enabled === true && plannerActivation?.groundedSearch?.ready === true;
  if (testOnly && options.searchEnabled !== undefined && typeof options.searchEnabled !== "boolean") {
    fail("ANALYSIS_CONFIGURATION_INVALID", "Test grounded search capability flag is invalid.", { status: 500 });
  }
  const fixedMutationRecoveryAuthority = mutationRecoveryAuthority();
  const activeRuns = new Map();
  const runQueue = [];
  const ownershipLockPath = path.join(stateRoot, ".analysis-session-owner.lock");
  let plannerRunsInFlight = 0;
  let mutationTail = Promise.resolve();
  let ownershipPromise = null;
  let ownershipTask = null;
  let ownershipRelease = null;
  let ownershipHeld = false;
  let draining = false;
  let drainMode = null;
  let drainPromise = null;
  let stateAccessClosed = false;
  let closed = false;

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.valueOf())) unavailable();
    return date.toISOString();
  }

  function serialized(task) {
    const operation = mutationTail.then(task, task);
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function ensureOwnership() {
    if (stateAccessClosed || closed) {
      fail("ANALYSIS_SERVICE_CLOSED", "Durable analysis service ownership has been released.", { status: 503 });
    }
    if (ownershipHeld) return;
    if (!ownershipPromise) {
      ownershipPromise = (async () => {
        await ensureDirectoryTree(stateRoot, { testOnly });
        let acquiredResolve;
        let acquiredReject;
        const acquired = new Promise((resolve, reject) => {
          acquiredResolve = resolve;
          acquiredReject = reject;
        });
        const hold = new Promise((resolve) => {
          ownershipRelease = resolve;
        });
        ownershipTask = withDirectoryLock(
          ownershipLockPath,
          async () => {
            ownershipHeld = true;
            acquiredResolve();
            await hold;
            ownershipHeld = false;
          },
          { waitMs: 0 }
        );
        ownershipTask.catch(acquiredReject);
        await acquired;
      })();
    }
    try {
      await ownershipPromise;
    } catch (error) {
      if (error instanceof IntegrationAnalysisSessionError) throw error;
      if (error?.code === "INTEGRATION_AUTHORITY_BUSY") {
        fail("ANALYSIS_SERVICE_BUSY", "Another durable analysis service owns this state root.", {
          status: 503,
          cause: error,
        });
      }
      unavailable(error);
    }
  }

  async function releaseOwnership() {
    if (!ownershipPromise) return;
    try {
      await ownershipPromise;
    } catch {
      return;
    }
    ownershipRelease?.();
    try {
      await ownershipTask;
      await syncDirectory(stateRoot);
    } catch (error) {
      if (error instanceof IntegrationAnalysisSessionError) throw error;
      unavailable(error);
    }
  }

  async function ensureRoot() {
    await ensureOwnership();
    const { scopesDirectory } = stateFilePaths(stateRoot, {
      principalId: "a".repeat(16),
      browserSessionId: "0".repeat(64),
    });
    await ensurePrivateDirectory(scopesDirectory, stateRoot, { testOnly });
    let entries;
    try {
      entries = await fs.readdir(scopesDirectory, { withFileTypes: true });
    } catch (error) {
      unavailable(error);
    }
    if (entries.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumScopes) corrupt();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(entry.name)) corrupt();
    }
  }

  async function readState(scope, { create = false } = {}) {
    await ensureRoot();
    const locations = stateFilePaths(stateRoot, scope);
    let scopeStat = await assertDirectory(locations.scopeDirectory, { leaf: true, testOnly });
    if (!scopeStat) {
      if (!create) return null;
      let entries;
      try {
        entries = await fs.readdir(locations.scopesDirectory, { withFileTypes: true });
      } catch (error) {
        unavailable(error);
      }
      if (entries.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumScopes) {
        conflict("ANALYSIS_SCOPE_CAPACITY_EXHAUSTED", "Analysis scope capacity is exhausted.");
      }
      await ensurePrivateDirectory(locations.scopeDirectory, stateRoot, { testOnly });
      scopeStat = await assertDirectory(locations.scopeDirectory, { leaf: true, testOnly });
      if (!scopeStat) unavailable();
    }
    const named = await lstatOrNull(locations.stateFile);
    if (!named) return create ? initialState(scope) : null;
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) corrupt();
    let handle;
    try {
      handle = await fs.open(locations.stateFile, openFlags(fsConstants.O_RDONLY));
      await verifyRegularPrivateFile(handle, locations.stateFile);
      const text = await handle.readFile("utf8");
      if (byteLength(text) > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumStateBytes) corrupt();
      return parseStateEnvelope(text, scope);
    } catch (error) {
      if (error instanceof IntegrationAnalysisSessionError) throw error;
      unavailable(error);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function writeState(scope, state) {
    validateState(state, scope);
    const locations = stateFilePaths(stateRoot, scope);
    await ensureRoot();
    await ensurePrivateDirectory(locations.scopeDirectory, stateRoot, { testOnly });
    const existing = await lstatOrNull(locations.stateFile);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) corrupt();
    const envelope = envelopeForState(state);
    let serializedState;
    try {
      serializedState = `${canonicalJson(envelope)}\n`;
    } catch (error) {
      corrupt(error);
    }
    if (byteLength(serializedState) > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumStateBytes) {
      fail("ANALYSIS_STATE_FULL", "Durable analysis state capacity is exhausted.", { status: 409 });
    }
    const temporary = path.join(
      locations.scopeDirectory,
      `.state.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`
    );
    let handle;
    try {
      handle = await fs.open(
        temporary,
        openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
        0o600
      );
      await handle.writeFile(serializedState, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      handle = null;
      const temporaryHandle = await fs.open(temporary, openFlags(fsConstants.O_RDONLY));
      try {
        await verifyRegularPrivateFile(temporaryHandle, temporary);
      } finally {
        await temporaryHandle.close();
      }
      await fs.rename(temporary, locations.stateFile);
      const finalHandle = await fs.open(locations.stateFile, openFlags(fsConstants.O_RDONLY));
      try {
        await verifyRegularPrivateFile(finalHandle, locations.stateFile);
      } finally {
        await finalHandle.close();
      }
      await syncDirectory(locations.scopeDirectory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      if (error instanceof IntegrationAnalysisSessionError) throw error;
      unavailable(error);
    }
  }

  function closeOpenTools(run, createdAt, summary, eventType = "tool.failed") {
    const calls = new Map();
    for (const event of run.events) {
      if (!event.type.startsWith("tool.")) continue;
      const callId = event.payload.callId;
      const entry = calls.get(callId) || { started: false, terminal: false };
      if (event.type === "tool.started") entry.started = true;
      if (TOOL_TERMINAL_EVENT_TYPES.has(event.type)) entry.terminal = true;
      calls.set(callId, entry);
    }
    for (const [callId, state] of calls) {
      if (state.started && !state.terminal) {
        appendEvent(
          run,
          eventType,
          {
            callId,
            publicLabel: "Python analysis",
            publicSummary: summary,
            at: createdAt,
          },
          createdAt
        );
      }
    }
  }

  function recoverInterruptedRuns(state) {
    let changed = false;
    const recoveredAt = timestamp();
    for (const run of state.runs) {
      if (TERMINAL_RUN_STATUSES.has(run.status) || activeRuns.has(run.id)) continue;
      closeOpenTools(run, recoveredAt, "Analysis execution was interrupted.");
      run.status = "failed";
      run.schedulingState = "terminal";
      run.completedAt = recoveredAt;
      run.error = {
        code: "RUN_INTERRUPTED",
        message: "Analysis was interrupted and can be resumed.",
      };
      appendEvent(run, "run.failed", {}, recoveredAt);
      changed = true;
    }
    if (changed) {
      for (const thread of state.threads) {
        const active = state.runs.some(
          (run) => run.threadId === thread.id && !TERMINAL_RUN_STATUSES.has(run.status)
        );
        if (!active && thread.status === "running") touchThread(thread, recoveredAt, { status: "idle" });
      }
    }
    return changed;
  }

  async function loadRecoveredState(scope, { create = false } = {}) {
    const state = await readState(scope, { create });
    if (!state) return null;
    if (recoverInterruptedRuns(state)) {
      state.revision += 1;
      await writeState(scope, state);
    }
    return state;
  }

  async function mutate(scope, task, { create = false, receipt = null } = {}) {
    return serialized(async () => {
      const identity = receipt
        ? normalizedMutationIdentity(scope, receipt.pathname, receipt.payload, receipt.context, {
            required: !testOnly,
          })
        : null;
      const state = await loadRecoveredState(scope, { create });
      if (!state) return task(null);
      const outcome = await task(state);
      if (identity) {
        const response = projectedMutationResponse(
          scope,
          identity,
          receipt.payload,
          outcome?.receiptResult ?? outcome?.result
        );
        appendMutationReceipt(state, scope, identity, response, timestamp());
      }
      if (outcome?.changed === true || identity) {
        state.revision += 1;
        await writeState(scope, state);
      }
      return outcome?.result;
    });
  }

  async function inspect(scope, task) {
    return serialized(async () => {
      const state = await loadRecoveredState(scope);
      return task(state);
    });
  }

  function findThread(state, threadId) {
    const id = validateIntegrationThreadId(threadId);
    const thread = state?.threads.find((item) => item.id === id);
    if (!thread) notFound("Thread");
    return thread;
  }

  function findRun(state, runId) {
    const id = validateIntegrationRunId(runId);
    const run = state?.runs.find((item) => item.id === id);
    if (!run) notFound("Run");
    return run;
  }

  function inputForRun(state, run) {
    const thread = findThread(state, run.threadId);
    const inputIndex = thread.messages.findIndex((message) => message.id === run.inputMessageId);
    if (inputIndex < 0 || thread.messages[inputIndex].role !== "user") corrupt();
    const prompt = thread.messages[inputIndex].content;
    const preceding = thread.messages.slice(0, inputIndex).slice(-INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConversationMessages);
    const selected = [];
    let totalBytes = 0;
    for (let index = preceding.length - 1; index >= 0; index -= 1) {
      const message = preceding[index];
      const content = clipUtf8(message.content, INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConversationMessageBytes);
      const bytes = byteLength(content);
      if (totalBytes + bytes > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConversationBytes) continue;
      selected.unshift(Object.freeze({ role: message.role, content }));
      totalBytes += bytes;
    }
    return Object.freeze({
      prompt,
      conversation: Object.freeze(selected),
      ...(run.search === undefined ? {} : { search: validateIntegrationSearch(run.search) }),
    });
  }

  function planSteps(phase, failed = false) {
    const order = ["planning", "executing", "synthesizing"];
    const activeIndex = order.indexOf(phase);
    const labels = ["Plan the response", "Run bounded analysis", "Prepare the answer"];
    return labels.map((label, index) => Object.freeze({
      id: `analysis-step-${index + 1}`,
      label,
      status: failed && index === Math.max(0, activeIndex)
        ? "failed"
        : index < activeIndex
          ? "completed"
          : index === activeIndex
            ? "in_progress"
            : "pending",
    }));
  }

  function normalizeProgress(value) {
    const progress = exact(
      value,
      [
        "phase",
        "toolCallsCompleted",
        "toolName",
        "toolCallNumber",
        "executionState",
        "executionSucceeded",
        "artifactCount",
      ],
      ["phase", "toolCallsCompleted"],
      "analysis progress"
    );
    if (!["planning", "executing", "synthesizing"].includes(progress.phase)) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis progress phase is invalid.", { status: 502 });
    }
    integrationBoundedInteger(progress.toolCallsCompleted, "analysis progress toolCallsCompleted", {
      maximum: INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
    });
    if (progress.toolCallNumber !== undefined) {
      integrationBoundedInteger(progress.toolCallNumber, "analysis progress toolCallNumber", {
        minimum: 1,
        maximum: INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
      });
    }
    if (progress.toolName !== undefined && progress.toolName !== "execute_python_analysis") {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis progress tool is invalid.", { status: 502 });
    }
    if (progress.executionState !== undefined && !EXECUTION_STATES.has(progress.executionState)) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis execution state is invalid.", { status: 502 });
    }
    if (progress.executionSucceeded !== undefined && typeof progress.executionSucceeded !== "boolean") {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis execution outcome is invalid.", { status: 502 });
    }
    if (progress.artifactCount !== undefined) {
      integrationBoundedInteger(progress.artifactCount, "analysis progress artifactCount", {
        maximum: INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerRun,
      });
    }
    return progress;
  }

  function callIdForProgress(progress) {
    const number = Number(progress.toolCallNumber || Math.max(1, progress.toolCallsCompleted || 1));
    return `analysis-${Math.min(INTEGRATION_ANALYSIS_MAX_TOOL_CALLS, Math.max(1, number))}`;
  }

  function toolEventState(run, callId) {
    const events = run.events.filter((event) => event.type.startsWith("tool.") && event.payload.callId === callId);
    return Object.freeze({
      started: events.some((event) => event.type === "tool.started"),
      terminal: events.some((event) => TOOL_TERMINAL_EVENT_TYPES.has(event.type)),
      lastState: events.at(-1)?.payload?.publicSummary || "",
    });
  }

  async function recordProgress(scope, runId, rawProgress) {
    const progress = normalizeProgress(rawProgress);
    await mutate(scope, (state) => {
      const run = findRun(state, runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: null };
      const createdAt = timestamp();
      if (progress.phase === "planning") {
        const payload = { steps: planSteps("planning") };
        const previous = run.events.at(-1);
        if (previous?.type !== "plan.updated" || contractDigest(previous.payload) !== contractDigest(payload)) {
          appendEvent(run, "plan.updated", payload, createdAt);
          return { changed: true, result: null };
        }
        return { changed: false, result: null };
      }
      if (progress.phase === "executing") {
        const callId = callIdForProgress(progress);
        const existing = toolEventState(run, callId);
        const executionState = String(progress.executionState || "running");
        const terminalSuccess = new Set(["succeeded", "completed"]).has(executionState);
        const terminalFailure = new Set([
          "failed",
          "timed_out",
          "output_limited",
          "cancelled",
          "sandbox_error",
          "artifact_invalid",
          "termination_unproven",
          "worker_error",
        ]).has(executionState);
        const publicSummary = terminalSuccess
          ? "Bounded Python analysis completed."
          : terminalFailure
            ? "Bounded Python analysis did not complete."
            : new Set(["starting", "queued"]).has(executionState)
              ? "Bounded Python analysis is preparing."
              : "Bounded Python analysis is running.";
        if (!existing.started) {
          appendEvent(
            run,
            "tool.started",
            { callId, publicLabel: "Python analysis", publicSummary, at: createdAt },
            createdAt
          );
          if (terminalSuccess || terminalFailure) {
            appendEvent(
              run,
              terminalSuccess ? "tool.completed" : "tool.failed",
              { callId, publicLabel: "Python analysis", publicSummary, at: createdAt },
              createdAt
            );
          }
        } else if (!existing.terminal && terminalSuccess) {
          appendEvent(
            run,
            "tool.completed",
            { callId, publicLabel: "Python analysis", publicSummary, at: createdAt },
            createdAt
          );
        } else if (!existing.terminal && terminalFailure) {
          appendEvent(
            run,
            "tool.failed",
            { callId, publicLabel: "Python analysis", publicSummary, at: createdAt },
            createdAt
          );
        } else if (!existing.terminal && existing.lastState !== publicSummary) {
          appendEvent(
            run,
            "tool.progress",
            { callId, publicLabel: "Python analysis", publicSummary, at: createdAt },
            createdAt
          );
        } else {
          return { changed: false, result: null };
        }
        return { changed: true, result: null };
      }
      const openCalls = new Set(
        run.events
          .filter((event) => event.type === "tool.started")
          .map((event) => event.payload.callId)
      );
      for (const event of run.events) {
        if (TOOL_TERMINAL_EVENT_TYPES.has(event.type)) openCalls.delete(event.payload.callId);
      }
      for (const callId of openCalls) {
        appendEvent(
          run,
          "tool.completed",
          {
            callId,
            publicLabel: "Python analysis",
            publicSummary: "Bounded Python analysis completed.",
            at: createdAt,
          },
          createdAt
        );
      }
      const payload = { steps: planSteps("synthesizing") };
      appendEvent(run, "plan.updated", payload, createdAt);
      return { changed: true, result: null };
    });
  }

  function normalizeOwnedArtifact(value, scope, threadId, runId) {
    const source = sanitizeIntegrationArtifact(value);
    const id = `art_${contractDigest({
      schemaVersion: INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
      principalId: scope.principalId,
      browserSessionId: scope.browserSessionId,
      threadId,
      runId,
      source,
    })}`;
    return sanitizeIntegrationArtifact({ ...source, id });
  }

  async function recordArtifact(scope, threadId, runId, rawArtifact) {
    const artifact = normalizeOwnedArtifact(rawArtifact, scope, threadId, runId);
    return mutate(scope, (state) => {
      const run = findRun(state, runId);
      if (run.threadId !== threadId) notFound("Run");
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: artifact };
      const existing = state.artifacts.find((item) => item.id === artifact.id);
      if (existing) return { changed: false, result: ownedArtifact(existing) };
      const count = state.artifacts.filter((item) => item.runId === runId).length;
      if (
        count >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerRun ||
        state.artifacts.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerScope
      ) {
        fail("ANALYSIS_ARTIFACT_CAPACITY_EXHAUSTED", "Run artifact capacity is exhausted.", { status: 409 });
      }
      const createdAt = timestamp();
      const record = {
        ...artifact,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        threadId,
        runId,
        createdAt,
      };
      state.artifacts.push(record);
      appendEvent(run, "artifact.created", { artifact }, createdAt);
      return { changed: true, result: ownedArtifact(record) };
    });
  }

  function normalizeRunnerResult(value, { searchExpected = false } = {}) {
    const result = exact(
      value,
      ["schemaVersion", "text", "kind", "toolCalls", "executionStatus", "artifacts"],
      ["schemaVersion", "text", "kind", "toolCalls", "executionStatus", "artifacts"],
      "analysis runner result"
    );
    if (result.schemaVersion !== INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner schema is invalid.", { status: 502 });
    }
    if (result.kind !== "direct" && result.kind !== "analysis") {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner result kind is invalid.", { status: 502 });
    }
    integrationBoundedInteger(result.toolCalls, "analysis runner toolCalls", {
      maximum: INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
    });
    if (result.executionStatus !== null && !/^[a-z_]{1,40}$/u.test(String(result.executionStatus))) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner execution status is invalid.", { status: 502 });
    }
    if (!Array.isArray(result.artifacts) || result.artifacts.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumArtifactsPerRun) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner artifacts exceed their bound.", { status: 502 });
    }
    const artifacts = Object.freeze(result.artifacts.map(sanitizeIntegrationArtifact));
    const sources = artifacts.filter((artifact) => artifact.kind === "sources");
    if (
      (result.kind === "direct" && (
        result.toolCalls !== 0 ||
        result.executionStatus !== null ||
        artifacts.some((artifact) => artifact.kind !== "sources")
      )) ||
      (result.kind === "analysis" && (result.toolCalls < 1 || result.executionStatus === null)) ||
      (!searchExpected && sources.length !== 0) ||
      (searchExpected && sources.length !== 1)
    ) {
      fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner result fields are inconsistent.", { status: 502 });
    }
    const text = publicText(result.text, "analysis runner text");
    return Object.freeze({
      schemaVersion: result.schemaVersion,
      text,
      kind: result.kind,
      toolCalls: result.toolCalls,
      executionStatus: result.executionStatus,
      artifacts,
    });
  }

  function outputChunks(text) {
    const chunks = [];
    const characters = Array.from(text);
    for (let index = 0; index < characters.length; index += 4_000) {
      chunks.push(characters.slice(index, index + 4_000).join(""));
    }
    return chunks;
  }

  async function completeRun(scope, runId, result) {
    for (const artifact of result.artifacts) {
      await recordArtifact(scope, findRunThreadIdForActive(runId), runId, artifact);
    }
    return mutate(scope, (state) => {
      const run = findRun(state, runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: ownedRun(run) };
      const thread = findThread(state, run.threadId);
      const completedAt = timestamp();
      closeOpenTools(run, completedAt, "Bounded Python analysis completed.", "tool.completed");
      appendEvent(run, "plan.updated", { steps: planSteps("synthesizing").map((step) => ({ ...step, status: "completed" })) }, completedAt);
      for (const chunk of outputChunks(result.text)) appendEvent(run, "output.delta", { text: chunk }, completedAt);
      appendEvent(run, "output.completed", {}, completedAt);
      appendMessage(thread, { role: "assistant", content: result.text, runId, createdAt: completedAt });
      run.status = "completed";
      run.schedulingState = "terminal";
      run.completedAt = completedAt;
      run.output = result.text;
      run.error = null;
      appendEvent(run, "run.completed", {}, completedAt);
      touchThread(thread, completedAt, { status: "idle", lastRunId: runId });
      return { changed: true, result: ownedRun(run) };
    });
  }

  function findRunThreadIdForActive(runId) {
    const active = activeRuns.get(runId);
    if (!active) notFound("Run");
    return active.threadId;
  }

  async function failRun(scope, runId, error) {
    return mutate(scope, (state) => {
      const run = findRun(state, runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: ownedRun(run) };
      const thread = findThread(state, run.threadId);
      const failedAt = timestamp();
      const cancelled = error?.code === "ANALYSIS_CANCELLED" || activeRuns.get(runId)?.controller.signal.aborted;
      closeOpenTools(
        run,
        failedAt,
        cancelled ? "Analysis execution was cancelled." : "Analysis execution did not complete."
      );
      if (cancelled) {
        run.status = "cancelled";
        run.schedulingState = "terminal";
        run.cancelRequestedAt ||= failedAt;
        run.completedAt = failedAt;
        run.error = null;
        appendEvent(run, "run.cancelled", {}, failedAt);
      } else {
        const errorCode = publicErrorCode(error);
        run.status = "failed";
        run.schedulingState = "terminal";
        run.completedAt = failedAt;
        run.error = {
          code: errorCode,
          message: publicFailureMessage(error, errorCode),
        };
        appendEvent(run, "run.failed", {}, failedAt);
      }
      touchThread(thread, failedAt, { status: "idle", lastRunId: runId });
      return { changed: true, result: ownedRun(run) };
    });
  }

  async function executeRun(scope, threadId, runId) {
    let finalCallbackDigest = "";
    let finalCallbackCount = 0;
    try {
      const input = await mutate(scope, (state) => {
        const run = findRun(state, runId);
        if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: null };
        const thread = findThread(state, threadId);
        const startedAt = timestamp();
        run.status = "running";
        run.schedulingState = "running";
        run.startedAt = startedAt;
        appendEvent(run, "run.status", { status: "running" }, startedAt);
        touchThread(thread, startedAt, { status: "running", lastRunId: runId });
        return { changed: true, result: inputForRun(state, run) };
      });
      if (!input) return;
      const active = activeRuns.get(runId);
      if (!active) fail("ANALYSIS_RUNNER_UNAVAILABLE", "Analysis run ownership was lost.", { status: 503 });
      const runnerResult = await analysisRunner.run(
        scopeWithRun(scope, threadId, runId),
        input,
        Object.freeze({
          signal: active.controller.signal,
          onProgress: async (progress) => recordProgress(scope, runId, progress),
          onArtifact: async (artifact) => {
            await recordArtifact(scope, threadId, runId, artifact);
          },
          onFinal: async (value) => {
            finalCallbackCount += 1;
            if (finalCallbackCount > 1) {
              fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner emitted more than one final result.", {
                status: 502,
              });
            }
            finalCallbackDigest = contractDigest(normalizeRunnerResult(value, {
              searchExpected: input.search !== undefined,
            }));
          },
        })
      );
      const result = normalizeRunnerResult(runnerResult, { searchExpected: input.search !== undefined });
      if (finalCallbackCount !== 1 || finalCallbackDigest !== contractDigest(result)) {
        fail("ANALYSIS_RUNNER_PROTOCOL_INVALID", "Analysis runner final callback disagreed with its result.", {
          status: 502,
        });
      }
      if (result.kind === "analysis" && !SUCCESSFUL_EXECUTION_STATUSES.has(result.executionStatus)) {
        fail("ANALYSIS_EXECUTION_FAILED", "Analysis execution did not complete successfully.", { status: 502 });
      }
      await completeRun(scope, runId, result);
    } catch (error) {
      await failRun(scope, runId, error).catch(() => {});
    }
  }

  function newScheduledEntry(scope, threadId, runId, controller) {
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    return {
      scope,
      scopeKey: scopeDigest(scope),
      threadId,
      runId,
      controller,
      phase: "reserving",
      slotReserved: false,
      promise: null,
      done,
      resolveDone,
    };
  }

  function removeFromQueue(entry) {
    const index = runQueue.indexOf(entry);
    if (index >= 0) runQueue.splice(index, 1);
  }

  function settleQueuedEntry(entry) {
    removeFromQueue(entry);
    if (activeRuns.get(entry.runId) === entry) activeRuns.delete(entry.runId);
    entry.phase = "terminal";
    entry.resolveDone();
  }

  function launchScheduledRun(entry) {
    if (activeRuns.get(entry.runId) !== entry || !entry.slotReserved) return;
    entry.phase = "running";
    const promise = Promise.resolve()
      .then(() => executeRun(entry.scope, entry.threadId, entry.runId))
      .finally(() => {
        if (entry.slotReserved) {
          entry.slotReserved = false;
          plannerRunsInFlight -= 1;
        }
        if (activeRuns.get(entry.runId) === entry) activeRuns.delete(entry.runId);
        entry.phase = "terminal";
        entry.resolveDone();
        pumpQueue();
      });
    entry.promise = promise;
    promise.catch(() => {});
  }

  function pumpQueue() {
    if (drainMode === "abort" || closed) return;
    while (plannerRunsInFlight < INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConcurrentPlannerRuns) {
      const entry = runQueue[0];
      if (!entry || entry.phase === "persisting-queued") return;
      runQueue.shift();
      if (activeRuns.get(entry.runId) !== entry || entry.phase !== "queued") continue;
      entry.phase = "starting";
      entry.slotReserved = true;
      plannerRunsInFlight += 1;
      launchScheduledRun(entry);
    }
  }

  async function createRun(payload, context, previousRunId = null) {
    if (draining || stateAccessClosed || closed) {
      fail("ANALYSIS_SERVICE_DRAINING", "Durable analysis service is draining and cannot accept a new run.", {
        status: 503,
      });
    }
    const scope = normalizeScopeFromContext(context);
    const threadId = validateIntegrationThreadId(
      previousRunId
        ? await inspect(scope, (state) => findRun(state, previousRunId).threadId)
        : payload.threadId
    );
    const prompt = publicText(normalizePrompt(payload.input?.text ?? ""), "analysis prompt");
    const search = payload.input?.search === undefined
      ? undefined
      : validateIntegrationSearch(payload.input.search);
    if (search !== undefined && !searchEnabled) {
      conflict("GROUNDED_SEARCH_NOT_READY", "Grounded search is not enabled for this Agent runtime.");
    }
    const runId = newRunId();
    const controller = new AbortController();
    const entry = newScheduledEntry(scope, threadId, runId, controller);
    activeRuns.set(runId, entry);
    let run;
    try {
      run = await mutate(
        scope,
        (state) => {
          const thread = findThread(state, threadId);
          if (thread.status === "running") conflict("ANALYSIS_THREAD_BUSY", "Thread already has an active run.");
          if (state.runs.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumRunsPerScope) {
            conflict("ANALYSIS_RUN_CAPACITY_EXHAUSTED", "Run capacity is exhausted.");
          }
          if (thread.messages.length > INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMessagesPerThread - 2) {
            conflict("ANALYSIS_THREAD_FULL", "Thread message capacity is exhausted.");
          }
          const retainedCharacters = thread.messages.reduce((total, message) => total + message.content.length, 0);
          if (
            retainedCharacters + prompt.length + 32_000 >
            INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumMessageCharactersPerThread
          ) {
            conflict("ANALYSIS_THREAD_FULL", "Thread message capacity is exhausted.");
          }
          if (previousRunId !== null) {
            const previous = findRun(state, previousRunId);
            if (previous.threadId !== threadId || !TERMINAL_RUN_STATUSES.has(previous.status)) {
              conflict("ANALYSIS_RUN_NOT_RESUMABLE", "Run cannot be resumed.");
            }
          }
          const queued =
            plannerRunsInFlight >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConcurrentPlannerRuns ||
            runQueue.length > 0;
          if (queued) {
            const queuedForScope = runQueue.filter((item) => item.scopeKey === entry.scopeKey).length;
            if (runQueue.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumQueuedPlannerRuns) {
              conflict("ANALYSIS_QUEUE_SATURATED", "The bounded analysis queue is full.");
            }
            if (queuedForScope >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumQueuedPlannerRunsPerScope) {
              conflict("ANALYSIS_SCOPE_QUEUE_SATURATED", "This analysis scope has reached its queue limit.");
            }
            entry.phase = "persisting-queued";
            runQueue.push(entry);
          } else {
            entry.phase = "reserved-starting";
            entry.slotReserved = true;
            plannerRunsInFlight += 1;
          }
          const createdAt = timestamp();
          const inputMessage = appendMessage(thread, {
            role: "user",
            content: prompt,
            runId,
            createdAt,
          });
          const record = {
            id: runId,
            threadId,
            previousRunId,
            principalId: scope.principalId,
            browserSessionId: scope.browserSessionId,
            browserSessionPolicy: "same-browser-session",
            status: "starting",
            schedulingState: queued ? "queued" : "starting",
            createdAt,
            startedAt: null,
            completedAt: null,
            cancelRequestedAt: null,
            output: "",
            error: null,
            authority: {
              kind: "aginti",
              snapshotHash: contractDigest({
                schemaVersion: INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
                threadId,
                runId,
                contextDigest: thread.authority.contextDigest,
                ...(search === undefined ? {} : { search }),
              }),
              runtimeRevision: thread.revision + 1,
              contextDigest: thread.authority.contextDigest,
            },
            inputMessageId: inputMessage.id,
            ...(search === undefined ? {} : { search }),
            events: [],
          };
          appendEvent(record, "run.status", { status: "starting" }, createdAt);
          state.runs.push(record);
          touchThread(thread, createdAt, { status: "running", lastRunId: runId });
          const result = ownedRun(record);
          return { changed: true, result, receiptResult: Object.freeze({ run: result }) };
        },
        {
          create: false,
          receipt: {
            pathname: previousRunId === null ? INTEGRATION_RPC_PATHS.runsStart : INTEGRATION_RPC_PATHS.runsResume,
            payload: previousRunId === null ? payload : context.payload,
            context,
          },
        }
      );
    } catch (error) {
      removeFromQueue(entry);
      if (entry.slotReserved) {
        entry.slotReserved = false;
        plannerRunsInFlight -= 1;
      }
      if (activeRuns.get(runId) === entry) activeRuns.delete(runId);
      entry.resolveDone();
      pumpQueue();
      throw error;
    }
    if (entry.phase === "reserved-starting") {
      entry.phase = "starting";
      launchScheduledRun(entry);
    } else {
      entry.phase = "queued";
      pumpQueue();
    }
    return run;
  }

  async function waitForIdleInternal() {
    for (;;) {
      const entries = [...activeRuns.values()];
      if (entries.length === 0) {
        await mutationTail;
        if (activeRuns.size === 0) return;
        continue;
      }
      await Promise.allSettled(entries.map((entry) => entry.done));
    }
  }

  async function cancelEntryForDrain(entry) {
    await mutate(entry.scope, (state) => {
      const run = findRun(state, entry.runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, result: null };
      const thread = findThread(state, run.threadId);
      const cancelledAt = timestamp();
      run.cancelRequestedAt = cancelledAt;
      run.completedAt = cancelledAt;
      run.status = "cancelled";
      run.schedulingState = "terminal";
      run.error = null;
      closeOpenTools(run, cancelledAt, "Analysis execution was cancelled during service drain.");
      appendEvent(run, "run.cancelled", {}, cancelledAt);
      touchThread(thread, cancelledAt, { status: "idle", lastRunId: run.id });
      return { changed: true, result: null };
    });
    if (new Set(["queued", "persisting-queued"]).has(entry.phase)) {
      settleQueuedEntry(entry);
    } else {
      entry.controller.abort(
        new IntegrationAnalysisSessionError("ANALYSIS_CANCELLED", "Analysis was cancelled during service drain.", {
          status: 499,
        })
      );
    }
  }

  async function waitBounded(promise, timeoutMs) {
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new IntegrationAnalysisSessionError(
            "ANALYSIS_DRAIN_TIMEOUT",
            "Durable analysis service did not drain within its bounded deadline.",
            { status: 504 }
          )
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, expired]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function beginDrain(optionsValue = {}) {
    const options = exact(optionsValue, ["mode", "timeoutMs"], [], "analysis drain options");
    const mode = options.mode ?? "wait";
    if (mode !== "wait" && mode !== "abort") {
      fail("INVALID_REQUEST", "Analysis drain mode must be wait or abort.", { status: 400 });
    }
    const timeoutMs = integrationBoundedInteger(options.timeoutMs ?? 30_000, "analysis drain timeoutMs", {
      minimum: 100,
      maximum: 120_000,
    });
    if (closed) {
      return Object.freeze({ drained: true, closed: true, mode, activeRuns: 0, queuedRuns: 0 });
    }
    if (drainPromise) return drainPromise;
    draining = true;
    drainMode = mode;
    const operation = (async () => {
      await mutationTail;
      if (mode === "abort") {
        for (const entry of [...activeRuns.values()]) await cancelEntryForDrain(entry);
      } else {
        pumpQueue();
      }
      await waitBounded(waitForIdleInternal(), timeoutMs);
      stateAccessClosed = true;
      await mutationTail;
      await releaseOwnership();
      closed = true;
      return Object.freeze({ drained: true, closed: true, mode, activeRuns: 0, queuedRuns: 0 });
    })();
    drainPromise = operation.catch((error) => {
      drainPromise = null;
      throw error;
    });
    return drainPromise;
  }

  async function attestation() {
    await serialized(async () => ensureRoot());
    const unsigned = Object.freeze({
      schemaVersion: INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
      owner: "aginti",
      authority: "aginti",
      ready: !testOnly,
      testOnly,
      runnerAuthority: testOnly ? "test-only" : "aginti-analysis-planner",
      runnerDigest,
      fixedCoordinatorDigest,
      plannerActivationSchemaVersion: testOnly ? null : INTEGRATION_ANALYSIS_PLANNER_ACTIVATION_SCHEMA_VERSION,
      plannerActivationDigest,
      plannerActivationBrandRequired: !testOnly,
      plannerCoordinatorDigestBound: testOnly ? false : true,
      activationProofRequired: !testOnly,
      activationProofDigest: activationProof?.digest || ZERO_DIGEST,
      activationProof,
      activationProofPinnedAtStartup: activationProof !== null,
      activationProofMatchesBoundCoordinator: testOnly ? activationProof === null : true,
      activationReadinessProbedAtStartup: !testOnly,
      activationReadinessReprobedPerRpc: false,
      stateRootDigest: contractDigest({ stateRoot }),
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
      exclusiveServiceLifetimeLock: true,
      ownershipLockHeldAtAttestation: ownershipHeld,
      ownershipReleasedOnlyAfterDrain: true,
      crossProcessSafe: true,
      maximumConcurrentPlannerRuns: INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumConcurrentPlannerRuns,
      maximumQueuedPlannerRuns: INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumQueuedPlannerRuns,
      maximumQueuedPlannerRunsPerScope: INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumQueuedPlannerRunsPerScope,
      queuedRunsPersisted: true,
      boundedDrain: true,
      durablePublicReplay: true,
      publicEventHashChain: true,
      artifactBeforeTerminal: true,
      exactCancellation: true,
      interruptedRunRecovery: true,
      ...(searchEnabled
        ? {
            groundedSearchReady: true,
            groundedSearchActivationDigest: plannerActivation?.groundedSearch?.digest || ZERO_DIGEST,
            groundedSearchIntentPersistedBeforeLaunch: true,
            groundedSearchReplayIsReadOnly: true,
          }
        : {}),
      durableMutationReceipts: true,
      mutationRecoveryAuthorityDigest: fixedMutationRecoveryAuthority.digest,
      rawExecutionSourcePersisted: false,
      rawExecutionStdoutPersisted: false,
      privateRuntimePathsPersisted: false,
      publicActivationLocksChanged: false,
      limitsDigest: contractDigest(INTEGRATION_ANALYSIS_SESSION_LIMITS),
    });
    return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  }

  const service = Object.freeze({
    async getIntegrationCapabilities() {
      const proof = await attestation();
      return Object.freeze({
        analysisSessionAuthority: proof,
        mutationRecoveryAuthority: fixedMutationRecoveryAuthority,
        cancel: true,
        resume: true,
        ...(searchEnabled ? { search: true } : {}),
      });
    },

    async recoverMutation(value) {
      const record = exact(
        value,
        [
          "principalId",
          "browserSessionId",
          "pathname",
          "requestHash",
          "idempotencyKeyDigest",
          "createdAt",
          "recoveryStage",
          "responseReceipt",
        ],
        ["principalId", "browserSessionId", "pathname", "requestHash", "idempotencyKeyDigest"],
        "analysis mutation recovery request"
      );
      const scope = Object.freeze({
        principalId: validateAgintiPrincipalId(record.principalId),
        browserSessionId: validateAgintiBrowserSession(record.browserSessionId),
      });
      if (!integrationRpcPathIsMutation(record.pathname)) {
        fail("INVALID_REQUEST", "Analysis mutation recovery path is invalid.", { status: 400 });
      }
      const requestHash = digest(record.requestHash, "analysis mutation recovery requestHash");
      const idempotencyKeyDigest = digest(
        record.idempotencyKeyDigest,
        "analysis mutation recovery idempotencyKeyDigest"
      );
      return inspect(scope, (state) => {
        if (!state) return null;
        const id = mutationReceiptId(scope, record.pathname, idempotencyKeyDigest);
        const receipt = state.mutationReceipts.find((item) => item.id === id);
        if (!receipt || Date.parse(receipt.expiresAt) <= Date.parse(timestamp())) return null;
        if (receipt.requestHash !== requestHash) {
          conflict("IDEMPOTENCY_CONFLICT", "The durable mutation key belongs to a different request.");
        }
        return assertPublicIntegrationResponse(record.pathname, receipt.response);
      });
    },

    async getAnalysisSessionAttestation() {
      return attestation();
    },

    async beginDrain(options = {}) {
      return beginDrain(options);
    },

    async close(options = {}) {
      const checked = exact(options, ["mode", "timeoutMs"], [], "analysis close options");
      return beginDrain({ ...checked, mode: checked.mode ?? "abort" });
    },

    async listThreads(payload, context) {
      exact(payload, ["limit", "before"], [], "list threads request");
      const scope = normalizeScopeFromContext(context);
      return inspect(scope, (state) => {
        const threads = [...(state?.threads || [])].sort(
          (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
        );
        let start = 0;
        if (payload.before) {
          const before = validateIntegrationThreadId(payload.before);
          const index = threads.findIndex((thread) => thread.id === before);
          if (index < 0) notFound("Thread cursor");
          start = index + 1;
        }
        const limit = integrationBoundedInteger(payload.limit ?? 50, "thread list limit", { minimum: 1, maximum: 100 });
        const page = threads.slice(start, start + limit);
        return Object.freeze({
          threads: Object.freeze(page.map((thread) => ownedThread(thread, { includeMessages: false }))),
          nextBefore: start + page.length < threads.length ? page.at(-1)?.id || null : null,
        });
      });
    },

    async createThread(payload, context) {
      exact(payload, ["title"], [], "create thread request");
      const scope = normalizeScopeFromContext(context);
      const title = normalizeTitle(payload.title || "New agent thread");
      return mutate(
        scope,
        (state) => {
          if (state.threads.length >= INTEGRATION_ANALYSIS_SESSION_LIMITS.maximumThreadsPerScope) {
            conflict("ANALYSIS_THREAD_CAPACITY_EXHAUSTED", "Thread capacity is exhausted.");
          }
          const createdAt = timestamp();
          const thread = {
            id: newThreadId(),
            principalId: scope.principalId,
            browserSessionId: scope.browserSessionId,
            browserSessionPolicy: "same-browser-session",
            title,
            status: "idle",
            revision: 1,
            createdAt,
            updatedAt: createdAt,
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
          state.threads.push(thread);
          return { changed: true, result: Object.freeze({ thread: ownedThread(thread) }) };
        },
        {
          create: true,
          receipt: {
            pathname: INTEGRATION_RPC_PATHS.threadsCreate,
            payload,
            context,
          },
        }
      );
    },

    async getThread(payload, context) {
      exact(payload, ["threadId"], ["threadId"], "get thread request");
      const scope = normalizeScopeFromContext(context);
      return inspect(scope, (state) => Object.freeze({ thread: ownedThread(findThread(state, payload.threadId)) }));
    },

    async updateThread(payload, context) {
      exact(payload, ["threadId", "title"], ["threadId", "title"], "update thread request");
      const scope = normalizeScopeFromContext(context);
      const title = normalizeTitle(payload.title);
      return mutate(
        scope,
        (state) => {
          const thread = findThread(state, payload.threadId);
          if (thread.title === title) return { changed: false, result: Object.freeze({ thread: ownedThread(thread) }) };
          touchThread(thread, timestamp());
          thread.title = title;
          return { changed: true, result: Object.freeze({ thread: ownedThread(thread) }) };
        },
        { receipt: { pathname: INTEGRATION_RPC_PATHS.threadsUpdate, payload, context } }
      );
    },

    async deleteThread(payload, context) {
      exact(payload, ["threadId"], ["threadId"], "delete thread request");
      const scope = normalizeScopeFromContext(context);
      return mutate(
        scope,
        (state) => {
          const thread = findThread(state, payload.threadId);
          if (thread.status === "running") conflict("ANALYSIS_THREAD_BUSY", "An active thread cannot be deleted.");
          const record = ownedThread(thread);
          const runIds = new Set(state.runs.filter((run) => run.threadId === thread.id).map((run) => run.id));
          state.threads = state.threads.filter((item) => item.id !== thread.id);
          state.runs = state.runs.filter((run) => !runIds.has(run.id));
          state.artifacts = state.artifacts.filter((artifact) => !runIds.has(artifact.runId));
          return { changed: true, result: Object.freeze({ deleted: true, thread: record, threadId: thread.id }) };
        },
        { receipt: { pathname: INTEGRATION_RPC_PATHS.threadsDelete, payload, context } }
      );
    },

    async startRun(payload, context) {
      exact(payload, ["threadId", "input"], ["threadId", "input"], "start run request");
      exact(payload.input, ["text", "search"], ["text"], "start run input");
      const run = await createRun(payload, context, null);
      return Object.freeze({ run });
    },

    async getRunStatus(payload, context) {
      exact(payload, ["runId"], ["runId"], "get run status request");
      const scope = normalizeScopeFromContext(context);
      return inspect(scope, (state) => Object.freeze({ run: ownedRun(findRun(state, payload.runId)) }));
    },

    async loadRunEvents(payload, context) {
      exact(payload, ["runId", "afterSeq", "afterHash"], ["runId", "afterSeq", "afterHash"], "load run events request");
      integrationBoundedInteger(payload.afterSeq, "load run events afterSeq", { maximum: 10_000_000_000 });
      digest(payload.afterHash, "load run events afterHash");
      if ((payload.afterSeq === 0) !== (payload.afterHash === ZERO_DIGEST)) {
        fail("INVALID_EVENT_CURSOR", "Run event cursor is invalid.", { status: 400 });
      }
      const scope = normalizeScopeFromContext(context);
      const runId = validateIntegrationRunId(payload.runId);
      const record = await inspect(scope, (state) => {
        const run = findRun(state, runId);
        return Object.freeze({
          run: ownedRun(run),
          threadId: run.threadId,
          events: Object.freeze([...run.events]),
        });
      });
      const initialEvents = record.events;
      const initialHeadEvent = initialEvents.at(-1);
      const ledger = Object.freeze({
        owner: "aginti",
        authority: "aginti",
        mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
        durable: true,
        persisted: true,
        contiguous: true,
        monotonic: true,
        bridgeOwned: false,
        principalId: scope.principalId,
        browserSessionId: scope.browserSessionId,
        browserSessionPolicy: "same-browser-session",
        threadId: record.threadId,
        runId,
        async loadEventsAfter(afterSeq) {
          return inspect(scope, (state) => {
            const run = findRun(state, runId);
            return Object.freeze(run.events.filter((event) => event.seq > afterSeq).slice(0, 128));
          });
        },
        async loadCursor(seq) {
          if (seq === 0) return Object.freeze({ seq: 0, hash: ZERO_DIGEST });
          return inspect(scope, (state) => {
            const event = findRun(state, runId).events.find((item) => item.seq === seq);
            return event ? Object.freeze({ seq: event.seq, hash: event.hash }) : null;
          });
        },
        async loadHead() {
          return Object.freeze({ seq: initialHeadEvent?.seq || 0, hash: initialHeadEvent?.hash || ZERO_DIGEST });
        },
      });
      return Object.freeze({
        run: record.run,
        publicEventLedger: ledger,
        once: false,
        streamMs: 25_000,
        pollMs: 100,
      });
    },

    async cancelRun(payload, context) {
      exact(payload, ["runId"], ["runId"], "cancel run request");
      const scope = normalizeScopeFromContext(context);
      const result = await mutate(
        scope,
        (state) => {
          const run = findRun(state, payload.runId);
          const result = ownedRun(run);
          if (TERMINAL_RUN_STATUSES.has(run.status)) {
            return { changed: false, result, receiptResult: Object.freeze({ run: result }) };
          }
          const thread = findThread(state, run.threadId);
          const cancelledAt = timestamp();
          run.cancelRequestedAt = cancelledAt;
          run.completedAt = cancelledAt;
          run.status = "cancelled";
          run.schedulingState = "terminal";
          run.error = null;
          closeOpenTools(run, cancelledAt, "Analysis execution was cancelled.");
          appendEvent(run, "run.cancelled", {}, cancelledAt);
          touchThread(thread, cancelledAt, { status: "idle", lastRunId: run.id });
          const cancelled = ownedRun(run);
          return { changed: true, result: cancelled, receiptResult: Object.freeze({ run: cancelled }) };
        },
        { receipt: { pathname: INTEGRATION_RPC_PATHS.runsCancel, payload, context } }
      );
      const active = activeRuns.get(payload.runId);
      if (active && new Set(["queued", "persisting-queued"]).has(active.phase)) {
        settleQueuedEntry(active);
        pumpQueue();
      } else {
        active?.controller.abort(
          new IntegrationAnalysisSessionError("ANALYSIS_CANCELLED", "Analysis was cancelled.", { status: 499 })
        );
      }
      return Object.freeze({ run: result });
    },

    async resumeRun(payload, context) {
      exact(payload, ["runId", "input"], ["runId"], "resume run request");
      if (payload.input !== undefined) exact(payload.input, ["text", "search"], ["text"], "resume run input");
      const scope = normalizeScopeFromContext(context);
      const previous = await inspect(scope, (state) => findRun(state, payload.runId));
      if (!TERMINAL_RUN_STATUSES.has(previous.status)) conflict("ANALYSIS_RUN_NOT_RESUMABLE", "Run cannot be resumed.");
      let nextInput;
      if (payload.input === undefined) {
        nextInput = await inspect(scope, (state) => {
          const run = findRun(state, payload.runId);
          const thread = findThread(state, run.threadId);
          const message = thread.messages.find((item) => item.id === run.inputMessageId);
          if (!message || message.role !== "user") corrupt();
          return Object.freeze({
            text: message.content,
            ...(run.search === undefined ? {} : { search: validateIntegrationSearch(run.search) }),
          });
        });
      } else {
        nextInput = Object.freeze({
          text: payload.input.text,
          ...(payload.input.search === undefined
            ? {}
            : { search: validateIntegrationSearch(payload.input.search) }),
        });
      }
      const run = await createRun({ input: nextInput }, context, payload.runId);
      return Object.freeze({ run });
    },

    async listArtifacts(payload, context) {
      exact(payload, ["threadId", "runId"], [], "list artifacts request");
      if (Boolean(payload.threadId) === Boolean(payload.runId)) {
        fail("INVALID_REQUEST", "Exactly one artifact owner is required.", { status: 400 });
      }
      const scope = normalizeScopeFromContext(context);
      return inspect(scope, (state) => {
        if (payload.threadId) findThread(state, payload.threadId);
        if (payload.runId) findRun(state, payload.runId);
        const artifacts = (state?.artifacts || [])
          .filter((artifact) =>
            payload.threadId ? artifact.threadId === payload.threadId : artifact.runId === payload.runId
          )
          .slice(-32)
          .map(ownedArtifact);
        return Object.freeze({ artifacts: Object.freeze(artifacts) });
      });
    },

    async getArtifact(payload, context) {
      exact(payload, ["artifactId"], ["artifactId"], "get artifact request");
      const scope = normalizeScopeFromContext(context);
      const artifactId = validateIntegrationArtifactId(payload.artifactId);
      return inspect(scope, (state) => {
        const artifact = state?.artifacts.find((item) => item.id === artifactId);
        if (!artifact) notFound("Artifact");
        return Object.freeze({ artifact: ownedArtifact(artifact) });
      });
    },

    async waitForIdle() {
      await waitForIdleInternal();
    },
  });
  SESSION_BRAND.add(service);
  SESSION_METADATA.set(service, Object.freeze({ testOnly }));
  return service;
}

export function assertIntegrationAnalysisSessionService(value, { allowTestOnly = false } = {}) {
  if (!value || !SESSION_BRAND.has(value)) throw new TypeError("integration analysis session service is not AgInTi-owned");
  if (!allowTestOnly && SESSION_METADATA.get(value)?.testOnly === true) {
    throw new TypeError("test-only integration analysis session service is not production-capable");
  }
  return value;
}

export function createIntegrationAnalysisSessionService(value = {}) {
  const options = exact(
    value,
    ["analysisRunner", "plannerActivation", "stateRoot"],
    ["analysisRunner", "plannerActivation"],
    "analysis session service configuration"
  );
  return createService(options, { testOnly: false });
}

export function createTestOnlyIntegrationAnalysisSessionService(value = {}) {
  const options = exact(
    value,
    ["analysisRunner", "stateRoot", "now", "activationProof", "searchEnabled"],
    ["analysisRunner", "stateRoot"],
    "test analysis session service configuration"
  );
  return createService(options, { testOnly: true });
}
