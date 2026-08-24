import { types as utilTypes } from "node:util";
import {
  contractDigest,
  integrationBoundedInteger,
  integrationBoundedText,
  validateIntegrationBrowserSessionBinding,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";
import {
  INTEGRATION_EVENT_TYPES,
  createPublicIntegrationEvent,
  validateIntegrationEventPayload,
} from "./integration-events.js";
import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import { authorityFail } from "./integration-durable-common.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_CORE_EVENT_PROJECTOR_VERSION = "aginti-core-event-projector-v1";

const ALLOWED_RAW_EVENT_TYPES = new Set([
  "run.status",
  "session.ready",
  "context.compacted",
  "history.compacted_for_context_budget",
  "history.compacted_for_local_context_retry",
  "history.compacted_for_model_retry",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "output.delta",
  "assistant.delta",
  "model.responded",
  "output.completed",
  "artifact.available",
]);
const TERMINAL_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const RUN_STATUSES = new Set(["starting", "running", "completed", "failed", "cancelled"]);
const TOOL_EVENT_TYPES = new Set(["tool.started", "tool.progress", "tool.completed", "tool.failed"]);
const FORBIDDEN_KEYS = new Set([
  "args",
  "arguments",
  "baseURL",
  "command",
  "commandCwd",
  "cwd",
  "env",
  "filePath",
  "model",
  "path",
  "provider",
  "raw",
  "result",
  "secret",
  "stderr",
  "stdout",
  "token",
  "toolArgs",
  "toolResult",
  "url",
]);
const ABSOLUTE_PATH_OR_SECRET_PATTERN =
  /(?:^|[\s("'`<>\[{=])(?:file:\/\/\/[^\s"'`<>)\]}]+|\/(?!\/)[^\s"'`<>)\]}]+|[A-Za-z]:[\\/][^\s"'`<>)\]}]+|\\\\[^\\/\s"'`<>)\]}]+\\[^\s"'`<>)\]}]+|(?:api[_-]?key|token|secret|password)\s*[:=])/iu;
const EVENT_LEDGER_STORE_REQUIRED_KEYS = Object.freeze([
  "owner",
  "authority",
  "mappingVersion",
  "durable",
  "persisted",
  "contiguous",
  "monotonic",
  "bridgeOwned",
  "appendPublicEvent",
  "ledgerForRun",
]);
const EVENT_LEDGER_STORE_OPTIONAL_KEYS = Object.freeze([
  "appendByOutboxId",
  "lookupByOutboxId",
  "eventsForRun",
  "integrationEventAppendAttestation",
]);
const PUBLIC_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "id",
  "seq",
  "type",
  "threadId",
  "runId",
  "createdAt",
  "payload",
  "previousHash",
  "hash",
]);
const PUBLIC_EVENT_OPTIONAL_SCOPE_KEYS = Object.freeze(["principalId", "browserSessionId"]);

function rejectUnsafePresentation(label) {
  authorityFail("UNSAFE_PRESENTATION", `${label} contains private runtime content.`, { status: 400 });
}

export function assertNoUnsafeCoreEventFields(value, label = "core event") {
  const seen = new Set();
  function visit(item, path = label) {
    if (item === null || item === undefined) return;
    if (typeof item === "string") {
      if (redactSensitiveText(item) !== item || ABSOLUTE_PATH_OR_SECRET_PATTERN.test(item)) rejectUnsafePresentation(path);
      return;
    }
    if (typeof item !== "object") return;
    if (seen.has(item)) authorityFail("INTERNAL_CONTRACT", `${label} must not contain cycles.`);
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_KEYS.has(key) || /(?:path|url|command|stdout|stderr|secret|token|password|provider|model|args|result)/iu.test(key)) {
        rejectUnsafePresentation(`${path}.${key}`);
      }
      visit(item[key], `${path}.${key}`);
    }
  }
  visit(value);
}

function assertScope(scope = {}) {
  const principalId = String(scope.principalId || "");
  const browserSessionId = String(scope.browserSessionId || "");
  if (!/^[A-Za-z0-9._~-]{16,128}$/u.test(principalId)) {
    authorityFail("INVALID_PRINCIPAL", "Integration principal scope is invalid.", { status: 401 });
  }
  if (!/^[a-f0-9]{64}$/u.test(browserSessionId)) {
    authorityFail("INVALID_BROWSER_SESSION", "Integration browser session scope is invalid.", { status: 400 });
  }
  const checked = Object.freeze({
    principalId,
    browserSessionId,
    browserSessionPolicy: "same-browser-session",
    threadId: validateIntegrationThreadId(scope.threadId),
    runId: validateIntegrationRunId(scope.runId),
  });
  validateIntegrationBrowserSessionBinding(checked, checked, { label: "Run event scope", requireBound: true });
  return checked;
}

function assertExactFrozenProjectorLedgerStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) || !Object.isFrozen(value)) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event append authority is unavailable.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event append authority is unavailable.");
  }
  const allowed = new Set([...EVENT_LEDGER_STORE_REQUIRED_KEYS, ...EVENT_LEDGER_STORE_OPTIONAL_KEYS]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event ledger exposes unsupported fields.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      descriptor.writable !== false ||
      descriptor.configurable !== false ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event ledger fields must be immutable data.");
    }
  }
  for (const key of EVENT_LEDGER_STORE_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event append authority is unavailable.");
    }
  }
  return value;
}

function assertExactPublicEventView(event, label) {
  if (!event || typeof event !== "object" || Array.isArray(event) || utilTypes.isProxy(event)) {
    authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} is not a public event envelope.`);
  }
  const allowed = new Set([...PUBLIC_EVENT_KEYS, ...PUBLIC_EVENT_OPTIONAL_SCOPE_KEYS]);
  for (const key of Reflect.ownKeys(event)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} contains unsupported fields.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(event, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} contains non-public fields.`);
    }
  }
  for (const key of PUBLIC_EVENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(event, key)) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} is missing public fields.`);
    }
  }
}

function normalizeIso(value, label) {
  const timestamp = integrationBoundedText(value, label, 40, { minimum: 20 });
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    authorityFail("INTERNAL_CONTRACT", `${label} must be a canonical UTC ISO timestamp.`);
  }
  return timestamp;
}

function publicToolLabel(toolName) {
  const name = String(toolName || "tool").trim();
  const labels = {
    read_file: "Read file",
    search_files: "Search files",
    apply_patch: "Apply patch",
    run_command: "Run command",
    execute_python_analysis: "Run Python analysis",
    finish: "Finish",
  };
  return labels[name] || "AgInTi tool";
}

function normalizeToolPayload(type, data = {}, createdAt, options = {}) {
  const toolName = String(data.toolName || data.name || "tool").trim();
  const runId = typeof options.runId === "string" ? options.runId : "";
  const toolKey = toolName || "tool";
  let callId = "";
  if (options.toolState) {
    const queue = options.toolState.activeByTool.get(toolKey) || [];
    if (type === "tool.started") {
      options.toolState.nextOrdinal += 1;
      callId = `tool_${contractDigest({ runId, toolKey, ordinal: options.toolState.nextOrdinal }).slice(0, 32)}`;
      queue.push({ callId, ordinal: options.toolState.nextOrdinal });
      options.toolState.activeByTool.set(toolKey, queue);
    } else {
      const active = queue[0];
      if (!active) return null;
      callId = active.callId;
      if (type === "tool.completed" || type === "tool.failed") {
        queue.shift();
        if (queue.length) options.toolState.activeByTool.set(toolKey, queue);
        else options.toolState.activeByTool.delete(toolKey);
      }
    }
  } else {
    callId = `tool_${contractDigest({
      runId,
      type,
      toolName,
      ordinal: options.ordinal || 0,
      rawCallIdDigest: contractDigest(String(data.callId || "")),
    }).slice(0, 32)}`;
  }
  const payload = {
    callId,
    publicLabel: publicToolLabel(toolName),
    publicSummary:
      type === "tool.started"
        ? `${publicToolLabel(toolName)} started.`
        : type === "tool.failed"
          ? `${publicToolLabel(toolName)} failed.`
          : type === "tool.completed"
            ? `${publicToolLabel(toolName)} completed.`
            : `${publicToolLabel(toolName)} is running.`,
    at: createdAt,
  };
  return validateIntegrationEventPayload(type, payload);
}

function normalizeContextPayload(data = {}) {
  const payload = {
    compactedMessages: data.compactedMessages ?? data.compactions ?? data.omittedMessages ?? 0,
    tokensBefore: data.tokensBefore ?? data.beforeTokens ?? 0,
    tokensAfter: data.tokensAfter ?? data.afterTokens ?? 0,
  };
  return validateIntegrationEventPayload("context.compacted", {
    compactedMessages: integrationBoundedInteger(payload.compactedMessages, "compactedMessages", { maximum: 1_000_000 }),
    tokensBefore: integrationBoundedInteger(payload.tokensBefore, "tokensBefore", { maximum: 10_000_000 }),
    tokensAfter: integrationBoundedInteger(payload.tokensAfter, "tokensAfter", { maximum: 10_000_000 }),
  });
}

function normalizeOutputPayload(data = {}) {
  const payload =
    typeof data === "string"
      ? { text: data }
      : { text: data.text ?? data.content ?? data.delta ?? "" };
  return validateIntegrationEventPayload("output.delta", payload);
}

export function projectCoreEvent(typeInput, dataInput = {}, options = {}) {
  const rawType = String(typeInput || "");
  if (!ALLOWED_RAW_EVENT_TYPES.has(rawType)) return null;
  const data = dataInput === undefined ? {} : dataInput;
  const createdAt = normalizeIso(options.createdAt || options.now?.().toISOString?.() || new Date().toISOString(), "event createdAt");

  let type = rawType;
  let payload;
  if (rawType === "session.ready") type = "run.status";
  if (
    rawType === "history.compacted_for_context_budget" ||
    rawType === "history.compacted_for_local_context_retry" ||
    rawType === "history.compacted_for_model_retry"
  ) {
    type = "context.compacted";
  }
  if (rawType === "assistant.delta" || rawType === "model.responded") type = "output.delta";
  if (rawType === "artifact.available") type = "artifact.created";
  if (type === "run.status") {
    const statusPayload = { status: data.status || "running" };
    if (!RUN_STATUSES.has(statusPayload.status) || !["starting", "running"].includes(statusPayload.status)) return null;
    payload = validateIntegrationEventPayload(type, statusPayload);
  } else if (type === "context.compacted") {
    try {
      payload = normalizeContextPayload(data);
    } catch {
      return null;
    }
  } else if (TOOL_EVENT_TYPES.has(type)) {
    payload = normalizeToolPayload(type, data, createdAt, options);
    if (!payload) return null;
  } else if (type === "output.delta") {
    try {
      assertNoUnsafeCoreEventFields(typeof data === "string" ? { text: data } : data, type);
      payload = normalizeOutputPayload(data);
    } catch {
      return null;
    }
  } else if (type === "artifact.created") {
    try {
      const artifact = sanitizeIntegrationArtifact(data?.artifact || data);
      payload = validateIntegrationEventPayload(type, { artifact });
    } catch {
      return null;
    }
  } else if (type === "output.completed") {
    return null;
  } else {
    return null;
  }
  if (!INTEGRATION_EVENT_TYPES.includes(type)) {
    authorityFail("UNSUPPORTED_CORE_EVENT", "Projected event type is not public.", { status: 400 });
  }
  return Object.freeze({ type, payload, createdAt, terminal: false });
}

export function authorityTerminalEvent(typeInput, options = {}) {
  const type = String(typeInput || "");
  if (!TERMINAL_TYPES.has(type)) {
    authorityFail("UNSUPPORTED_CORE_EVENT", "Only the runtime authority may append terminal events.", { status: 400 });
  }
  const createdAt = normalizeIso(options.createdAt || options.now?.().toISOString?.() || new Date().toISOString(), "event createdAt");
  return Object.freeze({
    type,
    payload: validateIntegrationEventPayload(type, {}),
    createdAt,
    terminal: true,
  });
}

export function createIntegrationCoreEventProjector(options = {}) {
  const eventLedgerStore = options.eventLedgerStore;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const toolStateByRun = new Map();
  assertExactFrozenProjectorLedgerStore(eventLedgerStore);
  if (
    !eventLedgerStore ||
    eventLedgerStore.owner !== "aginti" ||
    eventLedgerStore.authority !== "aginti" ||
    typeof eventLedgerStore.appendPublicEvent !== "function"
  ) {
    authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "AgInTi public event append authority is unavailable.");
  }

  function snapshotToolState(toolState) {
    return Object.freeze({
      nextOrdinal: toolState.nextOrdinal,
      activeByTool: new Map([...toolState.activeByTool.entries()].map(([key, queue]) => [key, queue.map((item) => ({ ...item }))])),
    });
  }

  function restoreToolState(runId, hadState, snapshot) {
    if (!hadState) {
      toolStateByRun.delete(runId);
      return;
    }
    const restored = {
      nextOrdinal: snapshot.nextOrdinal,
      activeByTool: new Map([...snapshot.activeByTool.entries()].map(([key, queue]) => [key, queue.map((item) => ({ ...item }))])),
    };
    toolStateByRun.set(runId, restored);
  }

  function assertLedgerScope(ledger, scope) {
    for (const field of ["principalId", "browserSessionId", "threadId", "runId"]) {
      if (ledger?.[field] !== undefined && ledger[field] !== scope[field]) {
        authorityFail("NOT_FOUND", "Run events were not found.", { status: 404 });
      }
    }
  }

  function toolStateKey(scope) {
    return `${scope.principalId}\n${scope.browserSessionId}\n${scope.threadId}\n${scope.runId}`;
  }

  function validateLedgerHeadCursor(headInput, label) {
    const seq = Number(headInput?.seq ?? 0);
    const hash = String(headInput?.hash ?? "0".repeat(64));
    if (
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      !/^[a-f0-9]{64}$/u.test(hash) ||
      ((seq === 0) !== (hash === "0".repeat(64)))
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} cursor is invalid.`);
    }
    return Object.freeze({ seq, hash });
  }

  function assertPublicEventEnvelopeHash(event, label) {
    const checked = createPublicIntegrationEvent({
      threadId: event.threadId,
      runId: event.runId,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
      previousHash: event.previousHash,
    });
    if (
      event.schemaVersion !== checked.schemaVersion ||
      event.id !== checked.id ||
      event.hash !== checked.hash ||
      contractDigest(event) !== contractDigest(checked)
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", `${label} hash is invalid.`);
    }
  }

  async function loadLedgerHeadAndLastEvent(ledger, scope) {
    if (
      !ledger ||
      typeof ledger.loadHead !== "function" ||
      typeof ledger.loadCursor !== "function" ||
      typeof ledger.loadEventsAfter !== "function"
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_UNAVAILABLE", "Public event ledger head is unavailable.");
    }
    const head = validateLedgerHeadCursor(await ledger.loadHead(), "Public event ledger head");
    if (head.seq === 0) return Object.freeze({ head, lastEvent: null });
    const cursor = validateLedgerHeadCursor(await ledger.loadCursor(head.seq), "Public event ledger head event");
    if (cursor.seq !== head.seq || cursor.hash !== head.hash) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger head cursor does not match the last event.");
    }
    const events = await ledger.loadEventsAfter(head.seq - 1);
    if (!Array.isArray(events) || events.length !== 1) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger did not return the exact last event.");
    }
    const [lastEvent] = events;
    assertExactPublicEventView(lastEvent, "Public event ledger last event");
    if (
      lastEvent.threadId !== scope.threadId ||
      lastEvent.runId !== scope.runId ||
      lastEvent.seq !== head.seq ||
      lastEvent.hash !== head.hash
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger last event does not match the requested head.");
    }
    if (
      (lastEvent.principalId !== undefined && lastEvent.principalId !== scope.principalId) ||
      (lastEvent.browserSessionId !== undefined && lastEvent.browserSessionId !== scope.browserSessionId)
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger last event substituted scope.");
    }
    assertPublicEventEnvelopeHash(lastEvent, "Public event ledger last event");
    return Object.freeze({ head, lastEvent });
  }

  async function appendProjectedEvent(projectedInput, scopeInput) {
    const scope = assertScope(scopeInput);
    const projected = projectedInput;
    if (!projected) return null;
    const projectedIsTerminal = TERMINAL_TYPES.has(projected.type);
    if ((projected.terminal === true) !== projectedIsTerminal) {
      authorityFail("UNSUPPORTED_CORE_EVENT", "Projected event terminal flag does not match its public type.", { status: 400 });
    }
    const stateKey = toolStateKey(scope);
    const ledger =
      typeof eventLedgerStore.ledgerForRun === "function"
        ? eventLedgerStore.ledgerForRun(scope)
        : null;
    assertLedgerScope(ledger || {}, scope);
    const { head, lastEvent } = await loadLedgerHeadAndLastEvent(ledger, scope);
    if (lastEvent && TERMINAL_TYPES.has(lastEvent.type)) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger terminal finality blocks later run events.");
    }
    const previousSeq = head.seq;
    const previousHash = head.hash;
    if (
      projected.expectedPreviousSeq !== undefined &&
      (projected.expectedPreviousSeq !== previousSeq || projected.expectedPreviousHash !== previousHash)
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger head does not match the outbox cursor.");
    }
    const event = await eventLedgerStore.appendPublicEvent(scope, {
      type: projected.type,
      payload: projected.payload,
      createdAt: projected.createdAt,
    });
    assertExactPublicEventView(event, "Public event ledger append");
    const checked = createPublicIntegrationEvent({
      threadId: event.threadId,
      runId: event.runId,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
      previousHash: event.previousHash,
    });
    if (
      event.threadId !== scope.threadId ||
      event.runId !== scope.runId ||
      event.schemaVersion !== checked.schemaVersion ||
      event.id !== checked.id ||
      event.seq !== previousSeq + 1 ||
      event.previousHash !== previousHash ||
      event.hash !== checked.hash ||
      event.type !== projected.type ||
      event.createdAt !== projected.createdAt ||
      contractDigest(event.payload) !== contractDigest(projected.payload)
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger append substituted the requested event.");
    }
    if (
      (event.principalId !== undefined && event.principalId !== scope.principalId) ||
      (event.browserSessionId !== undefined && event.browserSessionId !== scope.browserSessionId)
    ) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger append substituted the requested scope.");
    }
    if (checked.hash !== event.hash || contractDigest(checked) !== contractDigest(event)) {
      authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Appended public event hash is invalid.");
    }
    if (ledger && typeof ledger.loadHead === "function") {
      const nextHead = await ledger.loadHead();
      if (nextHead?.seq !== checked.seq || nextHead?.hash !== checked.hash) {
        authorityFail("PUBLIC_EVENT_LEDGER_CORRUPT", "Public event ledger head did not advance to the appended event.");
      }
    }
    if (projected.terminal) {
      toolStateByRun.delete(stateKey);
    }
    return Object.freeze({ ...checked, terminal: projected.terminal });
  }

  async function appendCoreEvent(type, data, scopeInput) {
    const scope = assertScope(scopeInput);
    const rawType = String(type || "");
    const stateKey = toolStateKey(scope);
    const needsToolState = TOOL_EVENT_TYPES.has(rawType);
    const hadState = toolStateByRun.has(stateKey);
    let toolState = needsToolState ? toolStateByRun.get(stateKey) : undefined;
    if (needsToolState && !toolState) {
      toolState = { nextOrdinal: 0, activeByTool: new Map() };
      toolStateByRun.set(stateKey, toolState);
    }
    const snapshot = needsToolState ? snapshotToolState(toolState) : null;
    let projected = null;
    try {
      projected = projectCoreEvent(type, data, { now, runId: scope.runId, ...(needsToolState ? { toolState } : {}) });
    } catch (error) {
      if (needsToolState) restoreToolState(stateKey, hadState, snapshot);
      throw error;
    }
    if (!projected) {
      if (needsToolState) restoreToolState(stateKey, hadState, snapshot);
      return null;
    }
    try {
      return await appendProjectedEvent(projected, scope);
    } catch (error) {
      if (needsToolState) restoreToolState(stateKey, hadState, snapshot);
      throw error;
    }
  }

  async function appendAuthorityTerminalEvent(type, scopeInput) {
    return appendProjectedEvent(authorityTerminalEvent(type, { now }), scopeInput);
  }

  return Object.freeze({
    schemaVersion: INTEGRATION_CORE_EVENT_PROJECTOR_VERSION,
    owner: "aginti",
    authority: "aginti",
    appendCoreEvent,
    appendAuthorityTerminalEvent,
    clearRun(scopeInput, options = {}) {
      const scope = assertScope(scopeInput);
      const stateKey = toolStateKey(scope);
      toolStateByRun.delete(stateKey);
    },
    projectCoreEvent(type, data, scope = {}) {
      return projectCoreEvent(type, data, { now, runId: scope.runId || "" });
    },
  });
}
