#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import express from "express";
import {
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
  INTEGRATION_IDEMPOTENCY_MAX_WINDOW_MS,
  INTEGRATION_ANALYSIS_MAX_CONCURRENT_ATTACHMENT_REQUESTS,
  assertIntegrationTransactionalIdempotencyStore,
  assertPublicIntegrationResponse,
  createIntegrationRouter,
  createTestOnlyIntegrationAnalysisBodyMiddlewares,
  sanitizePublicIntegrationRun,
  sanitizePublicIntegrationThread,
  writeIntegrationArtifactContentResponse,
} from "../src/integration-api.js";
import {
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
  INTEGRATION_RPC_PATHS,
  assertFixedIntegrationPolicy,
  buildFixedIntegrationPolicy,
  buildFixedIntegrationRuntimeOverrides,
  canonicalJson,
  contractDigest,
  integrationCapabilitiesResponse,
  sanitizeIntegrationRequest,
} from "../src/integration-policy.js";
import {
  normalizeIntegrationClients,
  readProtectedIntegrationTokenFile,
} from "../src/integration-auth.js";
import { findIntegrationArtifact, sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
  createPublicIntegrationEvent,
  validatePublicIntegrationEvent,
  writeIntegrationEventStream,
} from "../src/integration-events.js";

const AGENT_RPC_PATHS = INTEGRATION_RPC_PATHS;
const validateAgentRpcResponse = assertPublicIntegrationResponse;
const validatePublicAgentEvent = validatePublicIntegrationEvent;
const validateRpcBody = sanitizeIntegrationRequest;

const TOKEN = "integration-smoke-bearer-token-value";
const SECOND_TOKEN = "integration-smoke-second-bearer-token-value";
const PRINCIPAL = "principalAAAAAAAA";
const OTHER_PRINCIPAL = "principalBBBBBBBB";
const CLOUD_GRAMMAR_PRINCIPAL = "principal.with~dash_123";
const BROWSER_SESSION = "a".repeat(64);
const OTHER_BROWSER_SESSION = "b".repeat(64);
const AT = "2026-08-20T08:00:00.000Z";
const ZERO_DIGEST = "0".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
const SNAPSHOT_HASH = "c".repeat(64);
const ATTACHMENT_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ATTACHMENT_INPUT = Object.freeze({
  attachmentId: "iphone-canonical-image-0001",
  mediaType: "image/png",
  data: ATTACHMENT_DATA,
});
const ATTACHMENT_DESCRIPTOR = Object.freeze({
  attachmentId: ATTACHMENT_INPUT.attachmentId,
  mediaType: ATTACHMENT_INPUT.mediaType,
  byteLength: Buffer.from(ATTACHMENT_DATA, "base64").length,
  width: 1,
  height: 1,
  sha256: crypto.createHash("sha256").update(Buffer.from(ATTACHMENT_DATA, "base64")).digest("hex"),
});

function uuidId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

const threadId = uuidId("thr");
const otherThreadId = uuidId("thr");
const runId = uuidId("run");
const artifactId = `art_${"d".repeat(64)}`;
const outputEvent = createPublicIntegrationEvent({
  threadId,
  runId,
  seq: 1,
  type: "output.delta",
  payload: { text: "Running public integration task." },
  createdAt: AT,
  previousHash: ZERO_DIGEST,
});
const secondOutputEvent = createPublicIntegrationEvent({
  threadId,
  runId,
  seq: 2,
  type: "output.delta",
  payload: { text: "Continuing public integration task." },
  createdAt: AT,
  previousHash: outputEvent.hash,
});
const badPreviousHashEvent = createPublicIntegrationEvent({
  threadId,
  runId,
  seq: 2,
  type: "output.delta",
  payload: { text: "Bad previous hash event." },
  createdAt: AT,
  previousHash: ZERO_DIGEST,
});
const foreignRunEvent = createPublicIntegrationEvent({
  threadId,
  runId: uuidId("run"),
  seq: 1,
  type: "output.delta",
  payload: { text: "Foreign run event." },
  createdAt: AT,
  previousHash: ZERO_DIGEST,
});

function linePlot(extra = {}) {
  return {
    schemaVersion: "1",
    type: "line",
    labels: ["Jan", "Feb"],
    series: [{ name: "Revenue", data: [1, 2] }],
    ...extra,
  };
}

function publicThread(overrides = {}) {
  return {
    id: threadId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "New agent thread",
    status: "idle",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    lastRunId: runId,
    authority: {
      kind: "aginti",
      mapped: true,
      runtimeRevision: 1,
      contextDigest: CONTEXT_DIGEST,
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_DIGEST },
    messages: [],
    rawSessionId: "private-session-id-must-not-leak",
    ...overrides,
  };
}

function publicRun(overrides = {}) {
  return {
    id: runId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId,
    previousRunId: null,
    status: "running",
    createdAt: AT,
    startedAt: AT,
    completedAt: null,
    cancelRequestedAt: null,
    output: "secret=hiddenvalue123 /home/aginti/private/output.txt",
    error: null,
    authority: {
      kind: "aginti",
      snapshotHash: SNAPSHOT_HASH,
      runtimeRevision: 1,
      contextDigest: CONTEXT_DIGEST,
    },
    eventCursor: { firstSeq: 1, lastSeq: 1, lastHash: outputEvent.hash, prunedThroughSeq: 0 },
    privatePath: "/home/aginti/private",
    ...overrides,
  };
}

function publicArtifact(overrides = {}) {
  return {
    id: artifactId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId,
    runId,
    title: "Revenue",
    kind: "plot",
    spec: linePlot(),
    url: "http://127.0.0.1/private",
    ...overrides,
  };
}

function fullAttestation() {
  return {
    profileVersion: "hardened-v1",
    profileDigest: "e".repeat(64),
    dedicatedInstance: true,
    dockerLocal: true,
    nonRoot: true,
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    seccomp: true,
    networkNone: true,
    noHostReadMounts: true,
    noSharedCaches: true,
    cpuLimit: true,
    memoryLimit: true,
    pidsLimit: true,
    wallTimeLimit: true,
    diskLimit: true,
    dedicatedOutputDir: true,
    abortAllContainers: true,
  };
}

function nativeAuthorityProof(overrides = {}) {
  return {
    nativeIntegrationAuthority: {
      owner: "aginti",
      apiPrefix: "/agent/v1",
      sessions: "aginti",
      planning: "aginti",
      contextCompaction: "aginti",
      tools: "aginti",
      dockerExecution: "aginti",
      cancellation: "aginti",
      idempotency: "aginti",
      idempotencyContractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
      eventLedger: "aginti",
      eventLedgerPersisted: true,
      artifacts: "aginti",
      adaptersAreTransportOnly: true,
      noHostedProviders: true,
      noWrappers: true,
      noMcp: true,
      noWeb: true,
      sandboxPrerequisites: {
        owner: "aginti",
        valid: true,
        enabled: true,
      },
      ...(overrides.nativeIntegrationAuthority || {}),
    },
    isolationAttestationAuthority: "aginti",
    isolationAttestation: fullAttestation(),
    cancel: true,
    resume: true,
    ...overrides,
  };
}

function publicEventLedger(events = [outputEvent], overrides = {}) {
  return {
    owner: "aginti",
    authority: "aginti",
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId,
    runId,
    async loadEventsAfter(afterSeq) {
      return events.filter((event) => event.seq > afterSeq);
    },
    async loadCursor(seq) {
      if (seq === 0) return { seq: 0, hash: ZERO_DIGEST };
      const found = events.find((event) => event.seq === seq);
      return found ? { seq: found.seq, hash: found.hash } : null;
    },
    async loadHead() {
      const last = events[events.length - 1];
      return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO_DIGEST };
    },
    ...overrides,
  };
}

function makeProvenStoreContractDouble(shared = {}) {
  const records = shared.records || new Map();
  shared.records = records;
  shared.queue ||= Promise.resolve();
  const recoveryProof = {
    schemaVersion: "aginti-integration-idempotency-recovery-authority-v1",
    owner: "aginti",
    explicit: true,
    blindRedispatch: false,
    beforeDispatchRecovery: true,
    afterDispatchBeforeResultRecovery: true,
    afterResultBeforePublicResponseRecovery: true,
  };
  recoveryProof.digest = contractDigest(recoveryProof);
  function enqueue(operation) {
    const next = shared.queue.then(operation, operation);
    shared.queue = next.catch(() => {});
    return next;
  }
  return {
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
    recoveryAuthority: recoveryProof,
    async runMutation({ principalId, browserSessionId, pathname, idempotencyKey, requestHash }, handler) {
      return enqueue(async () => {
        const index = contractDigest({ principalId, browserSessionId, pathname, idempotencyKey });
        const existing = records.get(index);
        if (existing) {
          if (
            existing.requestHash !== requestHash ||
            existing.principalId !== principalId ||
            existing.browserSessionId !== browserSessionId ||
            existing.pathname !== pathname
          ) {
            const error = new Error("Idempotency key conflict.");
            error.code = "IDEMPOTENCY_CONFLICT";
            error.publicCode = "IDEMPOTENCY_CONFLICT";
            error.status = 409;
            throw error;
          }
          if (existing.status === "settled") return JSON.parse(JSON.stringify(existing.response));
          records.delete(index);
        }
        records.set(index, { principalId, browserSessionId, pathname, requestHash, status: "pending", response: null });
        let response;
        try {
          response = await handler();
        } catch (error) {
          records.delete(index);
          throw error;
        }
        records.set(index, {
          principalId,
          browserSessionId,
          pathname,
          requestHash,
          status: "settled",
          response: JSON.parse(JSON.stringify(response)),
        });
        return response;
      });
    },
  };
}

function makeService(calls = [], overrides = {}) {
  return {
    async getIntegrationCapabilities() {
      return {
        ...(overrides.capabilities === undefined ? nativeAuthorityProof() : overrides.capabilities),
      };
    },
    async listThreads(payload, context) {
      calls.push({ method: "listThreads", payload, context });
      return {
        threads: [
          publicThread(),
          publicThread({ id: otherThreadId, principalId: OTHER_PRINCIPAL }),
          publicThread({ id: uuidId("thr"), principalId: undefined }),
          publicThread({ id: uuidId("thr"), browserSessionId: OTHER_BROWSER_SESSION }),
        ],
        nextBefore: otherThreadId,
      };
    },
    async createThread(payload, context) {
      calls.push({ method: "createThread", payload, context });
      assert.equal(context.principalId, PRINCIPAL);
      assert.equal(context.browserSessionId, BROWSER_SESSION);
      assert.equal(context.policy.runtime.provider, "localllm");
      assert.equal(context.policy.runtime.routeProvider, "localllm");
      assert.equal(context.policy.runtime.mainProvider, "localllm");
      assert.equal(context.policy.runtime.spareProvider, "localllm");
      assert.equal(context.policy.runtime.allowWebSearch, false);
      assert.equal(context.policy.runtime.allowMcpTools, false);
      assert.equal(context.policy.runtime.allowWrapperTools, false);
      assert.equal(context.policy.runtime.dockerNetwork, "none");
      assert.equal("commandCwd" in context.policy.runtime, false);
      assert.deepEqual(Object.keys(payload).sort(), ["title"]);
      if (typeof overrides.createThread === "function") return overrides.createThread(payload, context, calls);
      return { thread: publicThread({ title: payload.title }) };
    },
    async getThread(payload, context) {
      calls.push({ method: "getThread", payload, context });
      return { thread: publicThread(overrides.getThread || {}) };
    },
    async updateThread(payload, context) {
      calls.push({ method: "updateThread", payload, context });
      return { thread: publicThread({ title: payload.title, revision: 2, ...(overrides.updateThread || {}) }) };
    },
    async deleteThread(payload, context) {
      calls.push({ method: "deleteThread", payload, context });
      return { deleted: true, threadId: payload.threadId, principalId: PRINCIPAL, ...(overrides.deleteThread || {}) };
    },
    async startRun(payload, context) {
      calls.push({ method: "startRun", payload, context });
      assert.deepEqual(Object.keys(payload).sort(), ["input", "threadId"]);
      assert.deepEqual(Object.keys(payload.input), ["text"]);
      return { run: publicRun(overrides.startRun || {}) };
    },
    async getRunStatus(payload, context) {
      calls.push({ method: "getRunStatus", payload, context });
      return { run: publicRun(overrides.getRunStatus || {}) };
    },
    async loadRunEvents(payload, context) {
      calls.push({ method: "loadRunEvents", payload, context });
      return {
        run: publicRun(overrides.loadRunEventsRun || {}),
        publicEventLedger: publicEventLedger(
          Array.isArray(overrides.events) ? overrides.events : [overrides.event || outputEvent],
          overrides.publicEventLedger || {}
        ),
        once: true,
        streamMs: 1000,
        pollMs: 50,
      };
    },
    async cancelRun(payload, context) {
      calls.push({ method: "cancelRun", payload, context });
      return { run: publicRun({ status: "cancelled", completedAt: AT, cancelRequestedAt: AT, ...(overrides.cancelRun || {}) }) };
    },
    async resumeRun(payload, context) {
      calls.push({ method: "resumeRun", payload, context });
      return { run: publicRun({ previousRunId: runId, ...(overrides.resumeRun || {}) }) };
    },
    async listArtifacts(payload, context) {
      calls.push({ method: "listArtifacts", payload, context });
      return {
        artifacts: [
          publicArtifact(),
          publicArtifact({ id: `art_${"f".repeat(64)}`, principalId: OTHER_PRINCIPAL }),
          publicArtifact({ id: `art_${"a".repeat(64)}`, principalId: undefined }),
          publicArtifact({ id: `art_${"b".repeat(64)}`, browserSessionId: OTHER_BROWSER_SESSION }),
          publicArtifact({ id: `art_${"c".repeat(64)}`, threadId: uuidId("thr"), runId: uuidId("run") }),
        ],
      };
    },
    async getArtifact(payload, context) {
      calls.push({ method: "getArtifact", payload, context });
      return { artifact: publicArtifact({ id: payload.artifactId, ...(overrides.getArtifact || {}) }) };
    },
    async getArtifactContent(payload, context) {
      calls.push({ method: "getArtifactContent", payload, context });
      const full = Buffer.from("12345678");
      const selected = full.subarray(payload.range?.start || 0, (payload.range?.end ?? 7) + 1);
      return {
        schemaVersion: "aginti-artifact-content-v1",
        artifactId: payload.artifactId,
        filename: "report.pdf",
        mime: "application/pdf",
        totalBytes: 8,
        sha256: crypto.createHash("sha256").update(full).digest("hex"),
        start: payload.range?.start || 0,
        end: payload.range?.end ?? 7,
        partial: payload.range !== undefined,
        metadataOnly: payload.metadataOnly === true,
        body: payload.metadataOnly === true ? null : new Response(selected).body,
        cleanup() {},
      };
    },
  };
}

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "x-aginti-principal-id": PRINCIPAL,
    "x-aginti-browser-session-id": BROWSER_SESSION,
    ...extra,
  };
}

async function startApp(options = {}) {
  const app = express();
  app.use(createIntegrationRouter(options));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function rpc(baseUrl, pathname, body = {}, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: authHeaders(headers),
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("text/event-stream")) return { response, text: await response.text() };
  return { response, json: await response.json() };
}

async function rawPost(baseUrl, requestPath, body = "{}", headers = {}) {
  const url = new URL(baseUrl);
  const bodyBytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: requestPath,
        method: "POST",
        headers: {
          ...authHeaders(headers),
          "content-length": bodyBytes,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function chunkedPost(baseUrl, requestPath, body) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: requestPath,
      method: "POST",
      headers: authHeaders({ "transfer-encoding": "chunked" }),
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(text) }));
    });
    request.on("error", reject);
    const bytes = Buffer.from(body);
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      request.write(bytes.subarray(offset, offset + 16 * 1024));
    }
    request.end();
  });
}

async function startBodyBoundaryApp() {
  const middlewares = createTestOnlyIntegrationAnalysisBodyMiddlewares();
  let potentiallyLargeRequestsStarted = 0;
  let attachmentBusyResponsesFinished = 0;
  let largeHandlersInFlight = 0;
  let maximumLargeHandlersInFlight = 0;
  let resolveLargeHandler;
  const largeHandler = new Promise((resolve) => { resolveLargeHandler = resolve; });
  let releaseLargeHandlers;
  const largeHandlersReleased = new Promise((resolve) => { releaseLargeHandlers = resolve; });
  const app = express();
  app.use("/agent/v1", (req, res, next) => {
    const imageRoute = new Set([AGENT_RPC_PATHS.runsStart, AGENT_RPC_PATHS.runsResume])
      .has(String(req.originalUrl || ""));
    const rawLength = req.headers["content-length"];
    const lengthText = Array.isArray(rawLength) ? "" : String(rawLength ?? "").trim();
    const declaredLength = Number(lengthText);
    const declaredOrdinary = /^[0-9]+$/u.test(lengthText) &&
      Number.isSafeInteger(declaredLength) && declaredLength <= 128 * 1024;
    const potentiallyLarge = imageRoute && !declaredOrdinary;
    if (potentiallyLarge) potentiallyLargeRequestsStarted += 1;
    res.once("finish", () => {
      if (potentiallyLarge && res.statusCode === 429) attachmentBusyResponsesFinished += 1;
    });
    Object.defineProperty(req, "integrationBodyByteLimit", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: imageRoute && !declaredOrdinary ? 24 * 1024 * 1024 : 128 * 1024,
    });
    next();
  });
  app.use("/agent/v1", middlewares.beforeBody);
  app.use("/agent/v1", middlewares.parse);
  app.use("/agent/v1", middlewares.afterBody);
  for (const pathname of [
    AGENT_RPC_PATHS.runsStart,
    AGENT_RPC_PATHS.runsResume,
    AGENT_RPC_PATHS.capabilities,
  ]) {
    app.post(pathname, async (req, res) => {
      if (req.body?.hold === true) {
        largeHandlersInFlight += 1;
        maximumLargeHandlersInFlight = Math.max(maximumLargeHandlersInFlight, largeHandlersInFlight);
        resolveLargeHandler();
        await largeHandlersReleased;
        largeHandlersInFlight -= 1;
      }
      res.status(204).end();
    });
  }
  app.use((error, _req, res, _next) => {
    const tooLarge = error?.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      error: { code: tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_JSON" },
    });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    requestsInFlight: middlewares.requestsInFlight,
    potentiallyLargeRequestsStarted: () => potentiallyLargeRequestsStarted,
    attachmentBusyResponsesFinished: () => attachmentBusyResponsesFinished,
    waitForLargeHandler: () => largeHandler,
    maximumLargeHandlersInFlight: () => maximumLargeHandlersInFlight,
    releaseLargeHandlers,
    close: () => new Promise((resolve) => {
      releaseLargeHandlers();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  });
}

function openHeldChunkedPost(baseUrl, pathname) {
  const url = new URL(baseUrl);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: pathname,
      method: "POST",
      headers: { "content-type": "application/json" },
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode));
    });
    request.once("error", reject);
    request.write('{"input":{"attachments":[');
  });
  return Object.freeze({ request, response });
}

async function waitForBodyBoundary(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startMaximumBodyClient(baseUrl, pathname, maximumBodyBytes) {
  const source = `
    import http from "node:http";
    const [baseUrl, pathname, maximumBodyBytesText] = process.argv.slice(1);
    const maximumBodyBytes = Number(maximumBodyBytesText);
    const prefix = Buffer.from('{"hold":true,"padding":"');
    const suffix = Buffer.from('"}');
    const paddingBytes = maximumBodyBytes - prefix.length - suffix.length;
    let clientsStarted = 0;
    let resolveBothClientsStarted;
    const bothClientsStarted = new Promise((resolve) => { resolveBothClientsStarted = resolve; });
    let releaseBodies;
    const bodiesReleased = new Promise((resolve) => { releaseBodies = resolve; });
    async function send(fill) {
      const url = new URL(baseUrl);
      let request;
      let responseStartedResolve;
      const responseStarted = new Promise((resolve) => { responseStartedResolve = resolve; });
      let responseStatus = null;
      const response = new Promise((resolve, reject) => {
        request = http.request({
          hostname: url.hostname,
          port: url.port,
          path: pathname,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": maximumBodyBytes },
        }, (incoming) => {
          responseStatus = incoming.statusCode;
          responseStartedResolve();
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
        });
        request.once("error", (error) => {
          responseStartedResolve();
          if (responseStatus === null) reject(error);
        });
      });
      request.write(prefix);
      clientsStarted += 1;
      if (clientsStarted === 2) resolveBothClientsStarted();
      await bodiesReleased;
      const block = Buffer.alloc(64 * 1024, fill);
      let remaining = paddingBytes;
      while (remaining > 0 && responseStatus === null) {
        const size = Math.min(block.length, remaining);
        remaining -= size;
        if (!request.write(block.subarray(0, size))) {
          await Promise.race([
            new Promise((resolve) => request.once("drain", resolve)),
            responseStarted,
          ]);
        }
      }
      if (responseStatus === null) request.end(suffix);
      return response;
    }
    const statusesPromise = Promise.all([send("a"), send("b")]);
    await bothClientsStarted;
    process.stderr.write("READY\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    releaseBodies();
    const statuses = await statusesPromise;
    process.stdout.write(JSON.stringify(statuses));
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, baseUrl, pathname, String(maximumBodyBytes)],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (!readySettled && stderr.includes("READY\n")) {
      readySettled = true;
      resolveReady();
    }
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const error = new Error(`Maximum body client failed (${code ?? signal}): ${stderr}`);
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        reject(error);
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
  return Object.freeze({
    ready,
    result,
    releaseBodies: () => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end("release\n");
    },
    terminate: () => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end("release\n");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  });
}

async function attachmentBodyAdmissionRoundTrip() {
  assert.equal(INTEGRATION_ANALYSIS_MAX_CONCURRENT_ATTACHMENT_REQUESTS, 1);
  const receiveApp = await startBodyBoundaryApp();
  const held = [openHeldChunkedPost(receiveApp.url, AGENT_RPC_PATHS.runsStart)];
  try {
    await waitForBodyBoundary(
      () => receiveApp.requestsInFlight() === 1,
      "one bounded attachment body admission"
    );
    const smallStart = await rawPost(receiveApp.url, AGENT_RPC_PATHS.runsStart, "{}");
    const smallResume = await rawPost(receiveApp.url, AGENT_RPC_PATHS.runsResume, "{}");
    assert.equal(smallStart.status, 204, "small declared text start bypasses a slow image receive slot");
    assert.equal(smallResume.status, 204, "small declared text resume bypasses a slow image receive slot");
    const rejectedLarge = openHeldChunkedPost(receiveApp.url, AGENT_RPC_PATHS.runsResume);
    assert.equal(await rejectedLarge.response, 429);
    rejectedLarge.request.destroy();
    assert.equal(
      receiveApp.requestsInFlight(),
      1,
      "a second potentially-large body never consumes the occupied receive slot"
    );

    const ordinaryOversize = await chunkedPost(
      receiveApp.url,
      AGENT_RPC_PATHS.capabilities,
      `"${"a".repeat(128 * 1024)}"`
    );
    assert.equal(ordinaryOversize.status, 413);
    assert.equal(ordinaryOversize.json.error.code, "REQUEST_TOO_LARGE");

    held[0].response.catch(() => {});
    held[0].request.destroy();
    await waitForBodyBoundary(() => receiveApp.requestsInFlight() === 0, "attachment slot release on abort");
  } finally {
    for (const item of held) {
      item.response.catch(() => {});
      item.request.destroy();
    }
    await receiveApp.close();
  }

  const parsedImageApp = await startBodyBoundaryApp();
  try {
    const heldImage = rawPost(
      parsedImageApp.url,
      AGENT_RPC_PATHS.runsResume,
      JSON.stringify({ hold: true, reuseAttachments: true })
    );
    await parsedImageApp.waitForLargeHandler();
    assert.equal(parsedImageApp.requestsInFlight(), 1, "parsed image retry retains the image mutation slot");
    assert.equal((await rawPost(parsedImageApp.url, AGENT_RPC_PATHS.runsStart, "{}")).status, 204);
    assert.equal((await rawPost(parsedImageApp.url, AGENT_RPC_PATHS.runsResume, "{}")).status, 204);
    const rejectedImage = await rawPost(
      parsedImageApp.url,
      AGENT_RPC_PATHS.runsResume,
      JSON.stringify({ reuseAttachments: true })
    );
    assert.equal(rejectedImage.status, 429);
    assert.equal(rejectedImage.json.error.code, "ANALYSIS_ATTACHMENT_ADMISSION_BUSY");
    parsedImageApp.releaseLargeHandlers();
    assert.equal((await heldImage).status, 204);
    await waitForBodyBoundary(() => parsedImageApp.requestsInFlight() === 0, "parsed image slot release");
  } finally {
    await parsedImageApp.close();
  }

  const maximumApp = await startBodyBoundaryApp();
  let maximumBodyClient = null;
  try {
    const maximumBodyBytes = 24 * 1024 * 1024;
    maximumBodyClient = startMaximumBodyClient(
      maximumApp.url,
      AGENT_RPC_PATHS.runsStart,
      maximumBodyBytes
    );
    await maximumBodyClient.ready;
    await waitForBodyBoundary(
      () => maximumApp.attachmentBusyResponsesFinished() === 1,
      "one maximum body to receive an attachment admission rejection"
    );
    assert.equal(maximumApp.potentiallyLargeRequestsStarted(), 2);
    maximumBodyClient.releaseBodies();
    await maximumApp.waitForLargeHandler();
    assert.equal(maximumApp.maximumLargeHandlersInFlight(), 1);
    const maximumResidentBytes = process.memoryUsage.rss();
    maximumApp.releaseLargeHandlers();
    assert.deepEqual((await maximumBodyClient.result).sort((left, right) => left - right), [204, 429]);
    assert.ok(
      maximumResidentBytes < 768 * 1024 * 1024,
      `single admitted maximum Agent body exceeded the 768MiB service RSS budget: ${Math.ceil(maximumResidentBytes / 1024)}KiB`
    );
  } finally {
    maximumBodyClient?.terminate();
    maximumBodyClient?.result.catch(() => {});
    await maximumApp.close();
  }
}

function idempotencyKey(seed) {
  return `integration-smoke-${seed}-${"x".repeat(20)}`;
}

function assertNoPrivateText(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("/home/"), false);
  assert.equal(serialized.includes("/tmp/"), false);
  assert.equal(serialized.includes("supersecret"), false);
  assert.equal(serialized.includes("hiddenvalue"), false);
  assert.equal(serialized.includes("private-session-id"), false);
}

async function expectRpcError(baseUrl, pathname, body, expectedStatus, expectedCode, headers = {}, label = pathname) {
  const result = await rpc(baseUrl, pathname, body, headers);
  assert.equal(result.response.status, expectedStatus, label);
  assert.equal(result.json.error.code, expectedCode, label);
}

function fakeSseResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 0,
    headers: {},
    chunks: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      this.headers = { ...this.headers, ...headers };
      return this;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy(error) {
      this.destroyed = true;
      this.destroyError = error;
      this.writableEnded = true;
    },
    once() {},
    off() {},
  };
}

async function smokeSsePostHeaderFailure() {
  let loads = 0;
  let appended = false;
  const response = fakeSseResponse();
  await writeIntegrationEventStream(response, {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId,
    runId,
    afterSeq: 0,
    afterHash: ZERO_DIGEST,
    streamMs: 100,
    pollMs: 50,
    once: false,
    eventSource: publicEventLedger([], {
      async appendPublicEvent() {
        appended = true;
      },
      async loadEventsAfter() {
        loads += 1;
        if (loads > 1) {
          const error = new Error("post-header public event ledger failure");
          error.code = "PUBLIC_EVENT_LEDGER_CORRUPT";
          error.publicCode = "PUBLIC_EVENT_LEDGER_CORRUPT";
          throw error;
        }
        return [];
      },
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headersSent, true);
  assert.equal(response.destroyed, true);
  assert.equal(response.destroyError.code, "PUBLIC_EVENT_LEDGER_CORRUPT");
  assert.equal(appended, false);
  assert.equal(/run\.(?:completed|failed|cancelled)/u.test(response.chunks.join("")), false);
}

assert.deepEqual(INTEGRATION_RPC_PATHS, AGENT_RPC_PATHS);
for (const [key, pathname] of Object.entries(AGENT_RPC_PATHS)) {
  assert.equal(pathname, INTEGRATION_RPC_PATHS[key]);
}
assert.deepEqual(sanitizeIntegrationRequest(AGENT_RPC_PATHS.capabilities, {}), validateRpcBody(AGENT_RPC_PATHS.capabilities, {}));
assert.deepEqual(sanitizeIntegrationRequest(AGENT_RPC_PATHS.threadsCreate, {}), validateRpcBody(AGENT_RPC_PATHS.threadsCreate, {}));
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.threadsCreate, { title: "    " }), /non-whitespace/u);
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.threadsUpdate, { threadId, title: "    " }), /non-whitespace/u);
assert.deepEqual(
  sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, { threadId, input: { text: "Plot this" } }),
  validateRpcBody(AGENT_RPC_PATHS.runsStart, { threadId, input: { text: "Plot this" } })
);
const imageStartRequest = Object.freeze({
  threadId,
  input: Object.freeze({
    text: "Inspect the retained image.",
    attachments: Object.freeze([ATTACHMENT_INPUT]),
  }),
});
assert.deepEqual(sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, imageStartRequest), imageStartRequest);
assert.deepEqual(
  sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, {
    runId,
    input: { text: "Use the replacement image.", attachments: [ATTACHMENT_INPUT] },
  }).input.attachments,
  [ATTACHMENT_INPUT]
);
assert.deepEqual(
  sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, {
    runId,
    reuseAttachments: true,
  }),
  { runId, reuseAttachments: true }
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, {
    runId,
    reuseAttachments: false,
  }),
  /exactly true/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, {
    runId,
    reuseAttachments: true,
    input: { text: "Do not mix marker and corrected input." },
  }),
  /only valid without input/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, {
    threadId,
    input: { text: "Reject a duplicate.", attachments: [ATTACHMENT_INPUT, ATTACHMENT_INPUT] },
  }),
  /duplicated/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, {
    threadId,
    input: {
      text: "Reject too many.",
      attachments: Array.from({ length: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT + 1 }, (_, index) => ({
        ...ATTACHMENT_INPUT,
        attachmentId: `iphone-canonical-image-${String(index).padStart(4, "0")}`,
      })),
    },
  }),
  /1-4/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, {
    threadId,
    input: { text: "Reject non-canonical base64.", attachments: [{ ...ATTACHMENT_INPUT, data: "AAAA\n" }] },
  }),
  /canonical base64/u
);
const nonCanonicalTailBits = `${Buffer.alloc(16).toString("base64").slice(0, -4)}AB==`;
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, {
    threadId,
    input: {
      text: "Reject non-zero base64 tail bits without decoding.",
      attachments: [{ ...ATTACHMENT_INPUT, data: nonCanonicalTailBits }],
    },
  }),
  /canonical base64/u
);
assert.deepEqual(sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }), {
  runId,
  afterSeq: 0,
  afterHash: ZERO_DIGEST,
});
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsEvents, { runId, afterHash: ZERO_DIGEST }), /afterSeq/u);
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsEvents, { runId }), /afterSeq|afterHash/u);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: "1".repeat(64) }),
  /zero hash/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 1, afterHash: ZERO_DIGEST }),
  /non-zero/u
);
const nullPrototypeResumeRequest = Object.assign(Object.create(null), { runId });
assert.deepEqual(sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, nullPrototypeResumeRequest), { runId });
assert.deepEqual(Object.keys(sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsResume, { runId })), ["runId"]);
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.capabilities, { profileDigest: "x" }), /unsupported field/u);
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.runsStart, { threadId, input: { text: "x" }, provider: "deepseek" }), /unsupported field/u);
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.artifactsList, { threadId, runId }), /Exactly one/u);
assert.deepEqual(
  sanitizeIntegrationRequest(AGENT_RPC_PATHS.artifactsContent, {
    artifactId,
    metadataOnly: true,
    range: { start: 4, end: 9 },
  }),
  { artifactId, metadataOnly: true, range: { start: 4, end: 9 } }
);
assert.deepEqual(
  sanitizeIntegrationRequest(AGENT_RPC_PATHS.artifactsContent, {
    artifactId,
    range: { start: Number.MAX_SAFE_INTEGER },
  }),
  { artifactId, range: { start: Number.MAX_SAFE_INTEGER } },
  "a syntactically valid large browser range reaches the owned artifact boundary and resolves as 416"
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.artifactsContent, { artifactId, range: { start: 9, end: 4 } }),
  /must not precede/u
);
assert.throws(
  () => sanitizeIntegrationRequest(AGENT_RPC_PATHS.artifactsContent, { artifactId, metadataOnly: "yes" }),
  /boolean/u
);
const hiddenRequestField = {};
Object.defineProperty(hiddenRequestField, "provider", { value: "deepseek", enumerable: false });
assert.throws(() => sanitizeIntegrationRequest(AGENT_RPC_PATHS.capabilities, hiddenRequestField), /non-enumerable/u);

assert.equal(buildFixedIntegrationPolicy().runtime.baseURL, "http://127.0.0.1:8008/v1");
assert.equal(buildFixedIntegrationPolicy({ localLLMBaseURL: "http://127.0.0.1:8008/v1" }).runtime.provider, "localllm");
assert.throws(() => buildFixedIntegrationPolicy({ localLLMBaseURL: "https://api.deepseek.com/v1" }), /loopback|fixed/u);
assert.throws(() => buildFixedIntegrationPolicy({ routeModel: "deepseek-chat" }), /models are fixed/u);
const fixedPolicy = buildFixedIntegrationPolicy();
assert.equal("commandCwd" in buildFixedIntegrationRuntimeOverrides(fixedPolicy, { commandCwd: "/home/lachlan" }), false);
assert.throws(() => assertFixedIntegrationPolicy({ ...fixedPolicy, runtime: { ...fixedPolicy.runtime, allowWebSearch: true } }), /fingerprint/u);

assert.equal(canonicalJson({ b: [2], a: 1 }), '{"a":1,"b":[2]}');
assert.throws(() => canonicalJson([, 1]), /sparse/u);
const accessorObject = {};
Object.defineProperty(accessorObject, "secret", { enumerable: true, get: () => "x" });
assert.throws(() => canonicalJson(accessorObject), /accessor/u);
const extendedObject = Object.create({ inherited: true });
extendedObject.a = 1;
assert.throws(() => canonicalJson(extendedObject), /extended/u);
const extendedArray = [1];
extendedArray.extra = 2;
assert.throws(() => canonicalJson(extendedArray), /extended/u);
const originalMap = Array.prototype.map;
const originalSort = Array.prototype.sort;
const originalJoin = Array.prototype.join;
Array.prototype.map = () => {
  throw new Error("hostile map should not be called");
};
Array.prototype.sort = () => {
  throw new Error("hostile sort should not be called");
};
Array.prototype.join = () => {
  throw new Error("hostile join should not be called");
};
try {
  assert.equal(canonicalJson([1, 2]), "[1,2]");
  assert.equal(canonicalJson({ b: [2], a: 1 }), '{"a":1,"b":[2]}');
} finally {
  Array.prototype.map = originalMap;
  Array.prototype.sort = originalSort;
  Array.prototype.join = originalJoin;
}
assert.doesNotThrow(() => assertIntegrationTransactionalIdempotencyStore(makeProvenStoreContractDouble()));
assert.throws(
  () =>
    assertIntegrationTransactionalIdempotencyStore({
      ...makeProvenStoreContractDouble(),
      sameKeySameRequestReplays: undefined,
    }),
  /Transactional AgInTi idempotency is unavailable/u
);

assert.throws(
  () => sanitizeIntegrationArtifact({ id: artifactId, title: "Bad", kind: "markdown", spec: { schemaVersion: "1", markdown: "[x](https://example.test)" } }),
  /links|URL/u
);
const generatedA = sanitizeIntegrationArtifact({ title: "Generated", kind: "plot", spec: linePlot() });
const generatedB = sanitizeIntegrationArtifact({ title: "Generated", kind: "plot", spec: linePlot({ yLabel: "Value" }) });
assert.notEqual(generatedA.id, generatedB.id);
const publicFileArtifact = sanitizeIntegrationArtifact({
  title: "Compiled PDF",
  kind: "file",
  spec: {
    schemaVersion: "1",
    filename: "report.pdf",
    mime: "application/pdf",
    bytes: 1234,
    sha256: "2".repeat(64),
  },
});
assert.deepEqual(Object.keys(publicFileArtifact.spec), ["schemaVersion", "filename", "mime", "bytes", "sha256"]);
assert.throws(
  () => sanitizeIntegrationArtifact({ ...publicFileArtifact, spec: { ...publicFileArtifact.spec, content: "base64" } }),
  /unsupported field/u
);
assert.throws(
  () => sanitizeIntegrationArtifact({
    ...publicFileArtifact,
    spec: { ...publicFileArtifact.spec, filename: " report.pdf" },
  }),
  /safe basename/u
);
assert.throws(
  () => sanitizeIntegrationArtifact({
    ...publicFileArtifact,
    spec: { ...publicFileArtifact.spec, mime: "Application/PDF" },
  }),
  /lowercase/u
);
class CaptureContentResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
    this.on("error", () => {});
  }
  status(code) { this.statusCode = code; return this; }
  set(headers) { this.headers = { ...headers }; return this; }
  setHeader(name, value) { this.headers[name] = value; return this; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
}
async function captureContentResponse(result, options) {
  const response = new CaptureContentResponse();
  await writeIntegrationArtifactContentResponse(response, result, options);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.chunks.length === 0 ? undefined : Buffer.concat(response.chunks),
  };
}
const rawRange = await captureContentResponse({
  schemaVersion: "aginti-artifact-content-v1",
  artifactId,
  filename: "报告 (final's*).pdf",
  mime: "application/pdf",
  totalBytes: 8,
  sha256: "2".repeat(64),
  start: 2,
  end: 5,
  partial: true,
  metadataOnly: false,
  body: new Response(Buffer.from("2345")).body,
  cleanup() {},
}, { rangeRequested: true });
assert.equal(rawRange.statusCode, 206);
assert.equal(rawRange.headers["Content-Range"], "bytes 2-5/8");
assert.equal(rawRange.headers["Content-Length"], "4");
assert.equal(rawRange.headers["Cache-Control"], "no-store, private");
assert.match(
  rawRange.headers["Content-Disposition"],
  /filename\*=UTF-8''%E6%8A%A5%E5%91%8A%20%28final%27s%2A%29\.pdf/u
);
assert.deepEqual(rawRange.body, Buffer.from("2345"));
const metadataOnlyResponse = await captureContentResponse({
  schemaVersion: "aginti-artifact-content-v1",
  artifactId,
  filename: "report.pdf",
  mime: "application/pdf",
  totalBytes: 8,
  sha256: "2".repeat(64),
  start: 0,
  end: 7,
  partial: false,
  metadataOnly: true,
  body: null,
  cleanup() {},
});
assert.equal(metadataOnlyResponse.statusCode, 200);
assert.equal(metadataOnlyResponse.headers["Content-Length"], "0");
assert.equal(metadataOnlyResponse.headers["X-Artifact-Content-Length"], "8");
assert.equal(metadataOnlyResponse.body, undefined);
const markdownBytes = Buffer.from("# exact MIME\n", "utf8");
const markdownResponse = await captureContentResponse({
  schemaVersion: "aginti-artifact-content-v1",
  artifactId,
  filename: "notes.md",
  mime: "text/markdown",
  totalBytes: markdownBytes.byteLength,
  sha256: crypto.createHash("sha256").update(markdownBytes).digest("hex"),
  start: 0,
  end: markdownBytes.byteLength - 1,
  partial: false,
  metadataOnly: false,
  body: new Response(markdownBytes).body,
  cleanup() {},
});
assert.equal(markdownResponse.headers["Content-Type"], "text/markdown");
assert.deepEqual(markdownResponse.body, markdownBytes);
const exactMimeApp = express();
exactMimeApp.get("/artifact", async (_req, res, next) => {
  try {
    await writeIntegrationArtifactContentResponse(res, {
      schemaVersion: "aginti-artifact-content-v1",
      artifactId,
      filename: "notes.md",
      mime: "text/markdown",
      totalBytes: markdownBytes.byteLength,
      sha256: crypto.createHash("sha256").update(markdownBytes).digest("hex"),
      start: 0,
      end: markdownBytes.byteLength - 1,
      partial: false,
      metadataOnly: false,
      body: new Response(markdownBytes).body,
      cleanup() {},
    });
  } catch (error) {
    next(error);
  }
});
const exactMimeServer = http.createServer(exactMimeApp);
await new Promise((resolve, reject) => {
  exactMimeServer.once("error", reject);
  exactMimeServer.listen(0, "127.0.0.1", resolve);
});
try {
  const address = exactMimeServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/artifact`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown",
    "Express must not append a charset to authenticated artifact MIME metadata");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), markdownBytes);
} finally {
  await new Promise((resolve, reject) => exactMimeServer.close((error) => error ? reject(error) : resolve()));
}
await assert.rejects(
  captureContentResponse({
    schemaVersion: "aginti-artifact-content-v1",
    artifactId,
    filename: "report.pdf",
    mime: "application/pdf",
    totalBytes: 8,
    sha256: "2".repeat(64),
    start: 2,
    end: 5,
    partial: true,
    metadataOnly: false,
    body: new Response(Buffer.from("too short")).body,
    cleanup() {},
  }, { rangeRequested: true }),
  /exceeded its bound/u,
  "raw delivery fails closed when body length disagrees with authenticated metadata"
);
assert.throws(() => findIntegrationArtifact([], artifactId), /Artifact not found/u);
assert.deepEqual(validatePublicAgentEvent(outputEvent), outputEvent);
assertNoPrivateText(outputEvent);
const trimmedToolEvent = {
  schemaVersion: "1",
  id: `${runId}.3`,
  seq: 3,
  type: "tool.started",
  threadId,
  runId,
  createdAt: AT,
  payload: { callId: "tool-call", publicLabel: " Inspect ", publicSummary: " Ready ", at: AT },
  previousHash: secondOutputEvent.hash,
};
const trimmedToolHashEnvelope = {
  ...trimmedToolEvent,
  payload: { callId: "tool-call", publicLabel: "Inspect", publicSummary: "Ready", at: AT },
};
const sanitizedHashEvent = { ...trimmedToolEvent, hash: contractDigest(trimmedToolHashEnvelope) };
const checkedSanitizedHashEvent = validatePublicAgentEvent(sanitizedHashEvent);
assert.equal(checkedSanitizedHashEvent.payload.publicLabel, "Inspect");
assert.equal(checkedSanitizedHashEvent.payload.publicSummary, "Ready");
assert.throws(() => validatePublicAgentEvent({ ...outputEvent, createdAt: "2026-08-20T08:00:00Z" }), /canonical/u);
const imageCapabilities = validateAgentRpcResponse(
  AGENT_RPC_PATHS.capabilities,
  integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, attachments: true })
);
assert.deepEqual(imageCapabilities.attachments, {
  enabled: true,
  transport: "inline-base64",
  acceptedMediaTypes: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES,
  maximumCount: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT,
  maximumBytesEach: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
  maximumBytesTotal: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_TOTAL_BYTES_LIMIT,
  requestTimeoutMs: INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_REQUEST_TIMEOUT_MS,
  model: "localllm-vision",
  persistence: "retained-reference-v1",
});
const ordinaryCapabilities = validateAgentRpcResponse(
  AGENT_RPC_PATHS.capabilities,
  integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, retry: true })
);
assert.deepEqual(ordinaryCapabilities.attachments, { enabled: false });
assert.equal(ordinaryCapabilities.actions.retry, true);
assert.equal(
  Object.prototype.hasOwnProperty.call(ordinaryCapabilities.attachments, "requestTimeoutMs"),
  false,
  "the extended deadline must remain image-capability-only"
);
const roleStates = Object.freeze({
  executionWorker: Object.freeze({
    schemaVersion: "aginti-analysis-role-state-v1",
    role: "executionWorker",
    configured: true,
    status: "ready",
    ready: true,
    observedAt: AT,
    reason: null,
    actionable: null,
  }),
  documentWorker: Object.freeze({
    schemaVersion: "aginti-analysis-role-state-v1",
    role: "documentWorker",
    configured: true,
    status: "degraded",
    ready: false,
    observedAt: AT,
    reason: "route_unavailable",
    actionable: "Restore the private document worker route, then reactivate.",
  }),
  groundedSearch: Object.freeze({
    schemaVersion: "aginti-analysis-role-state-v1",
    role: "groundedSearch",
    configured: true,
    status: "degraded",
    ready: false,
    observedAt: AT,
    reason: "credential_unavailable",
    actionable: "Install the optional grounded search credential, then reactivate.",
  }),
});
const roleCapabilities = validateAgentRpcResponse(
  AGENT_RPC_PATHS.capabilities,
  integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, roles: roleStates })
);
assert.deepEqual(roleCapabilities.roles, roleStates);
assert.throws(
  () => validateAgentRpcResponse(
    AGENT_RPC_PATHS.capabilities,
    integrationCapabilitiesResponse({
      enabled: true,
      cancel: true,
      resume: true,
      roles: {
        ...roleStates,
        documentWorker: { ...roleStates.documentWorker, actionable: "x".repeat(241) },
      },
    })
  ),
  /role capability/u
);
assert.throws(
  () => validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, {
    ...integrationCapabilitiesResponse({ enabled: true, cancel: true, resume: true, attachments: true }),
    attachments: {
      ...integrationCapabilitiesResponse({ enabled: true, attachments: true }).attachments,
      maximumCount: 5,
    },
  }),
  /attachment capabilities/u
);
const publicImageThread = sanitizePublicIntegrationThread(publicThread({
  activeImageContext: true,
  messages: [{
    id: `msg_${"1".repeat(32)}`,
    role: "user",
    content: "Inspect the retained image.",
    runId,
    createdAt: AT,
    digest: "2".repeat(64),
    attachments: [ATTACHMENT_DESCRIPTOR],
  }],
}), {
  principalId: PRINCIPAL,
  browserSessionId: BROWSER_SESSION,
});
assert.deepEqual(publicImageThread.messages[0].attachments, [ATTACHMENT_DESCRIPTOR]);
assert.equal(publicImageThread.activeImageContext, true);
assert.equal(Object.prototype.hasOwnProperty.call(publicImageThread.messages[0].attachments[0], "data"), false);
assert.equal(Object.prototype.hasOwnProperty.call(sanitizePublicIntegrationThread(publicThread(), {
  principalId: PRINCIPAL,
  browserSessionId: BROWSER_SESSION,
}), "activeImageContext"), false);
assert.equal(Object.prototype.hasOwnProperty.call(sanitizePublicIntegrationThread(publicThread({
  activeImageContext: false,
}), {
  principalId: PRINCIPAL,
  browserSessionId: BROWSER_SESSION,
}), "activeImageContext"), false, "false image context is represented only by field absence");
assert.throws(
  () => sanitizePublicIntegrationThread(publicThread({ activeImageContext: "yes" }), {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
  }),
  /must be a boolean/u
);
assert.throws(
  () => sanitizePublicIntegrationThread(publicThread({ lastRunId: null, activeImageContext: true }), {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
  }),
  /requires lastRunId/u
);
assert.throws(
  () => sanitizePublicIntegrationThread(publicThread({
    messages: [{
      ...publicImageThread.messages[0],
      role: "assistant",
    }],
  }), {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
  }),
  /attachments is invalid/u
);
assert.throws(
  () =>
    validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, {
      schemaVersion: "1",
      enabled: false,
      agent: { kind: "aginti", label: "AgInTi Agent" },
      model: { label: "LocalLLM" },
      actions: { cancel: true, resume: false, retry: false },
      attachments: { enabled: false },
      artifacts: { kinds: ["plot", "table", "markdown", "file"], schemaVersion: "1" },
    }),
  /disabled capabilities/u
);
assert.throws(
  () => validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, {
    schemaVersion: "1",
    enabled: false,
    agent: { kind: "aginti", label: "AgInTi Agent" },
    model: { label: "LocalLLM" },
    actions: { cancel: false, resume: false, retry: true },
    attachments: { enabled: false },
    artifacts: { kinds: ["plot", "table", "markdown"], schemaVersion: "1" },
  }),
  /disabled capabilities/u
);
assert.throws(
  () => validateAgentRpcResponse(AGENT_RPC_PATHS.threadsGet, { schemaVersion: "1", thread: { ...publicThread(), rawPath: "/home/aginti" } }),
  /unsupported field/u
);
const publicRunContract = sanitizePublicIntegrationRun(publicRun(), {
  principalId: PRINCIPAL,
  browserSessionId: BROWSER_SESSION,
});
assert.equal(publicRunContract.eventCursor.firstSeq, 1);
assert.equal(publicRunContract.eventCursor.prunedThroughSeq, 0);
const publicRunPathContract = sanitizePublicIntegrationRun(publicRun({
  output:
    "Paths /scratch/aginti/private.txt file:///data/secret.tex C:\\Users\\alice\\secret.txt \\\\server\\share\\secret.txt stay private.",
}), {
  principalId: PRINCIPAL,
  browserSessionId: BROWSER_SESSION,
});
assert.doesNotMatch(publicRunPathContract.output, /\/scratch|file:\/\/\/data|C:\\\\Users|\\\\server/iu);
assert.match(publicRunPathContract.output, /\[REDACTED_PATH\]/u);
assert.throws(
  () =>
    sanitizePublicIntegrationThread(publicThread({ title: "    " }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /non-whitespace/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(publicRun({ error: { code: "    ", message: "Runtime failed" } }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /non-whitespace/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(publicRun({ error: { code: "RUN_FAILED", message: "    " } }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /non-whitespace/u
);
assert.throws(
  () =>
    validateAgentRpcResponse(AGENT_RPC_PATHS.runsStatus, {
      schemaVersion: "1",
      run: { ...publicRunContract, createdAt: "2026-08-20T08:00:00Z" },
    }),
  /canonical/u
);
assert.throws(
  () =>
    validateAgentRpcResponse(AGENT_RPC_PATHS.runsStatus, {
      schemaVersion: "1",
      run: { ...publicRunContract, eventCursor: { firstSeq: 3, lastSeq: 1, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 } },
    }),
  /event cursor/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(
      publicRun({ eventCursor: { firstSeq: 2, lastSeq: 2, lastHash: outputEvent.hash, prunedThroughSeq: 1 } }),
      {
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }
  ),
  /v1 does not support pruned/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(
      publicRun({ eventCursor: { firstSeq: 1, lastSeq: 1, lastHash: outputEvent.hash, prunedThroughSeq: 1 } }),
      {
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      }
    ),
  /event cursor/u
);
assert.throws(
  () =>
    validateAgentRpcResponse(AGENT_RPC_PATHS.artifactsGet, {
      schemaVersion: "1",
      artifact: { id: artifactId, title: "Revenue", kind: "plot.v1", spec: linePlot() },
    }),
  /exact public artifact/u
);
assert.throws(
  () =>
    createPublicIntegrationEvent({
      threadId,
      runId,
      seq: 1,
      type: "output.delta",
      payload: { text: "token=supersecret /home/aginti/private.txt" },
      createdAt: AT,
      previousHash: ZERO_DIGEST,
    }),
  /private runtime/u
);
assert.throws(
  () =>
    createPublicIntegrationEvent({
      threadId,
      runId,
      seq: 1,
      type: "tool.completed",
      payload: { callId: "tool-call", publicLabel: "/home/aginti/tool", publicSummary: "done", at: AT },
      createdAt: AT,
      previousHash: ZERO_DIGEST,
    }),
  /private runtime/u
);
assert.throws(
  () =>
    createPublicIntegrationEvent({
      threadId,
      runId,
      seq: 1,
      type: "raw.data",
      payload: { stdout: "private" },
      createdAt: AT,
      previousHash: ZERO_DIGEST,
    }),
  /Unsupported event type/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationThread(publicThread({ ownerBrowserSessionId: OTHER_BROWSER_SESSION }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationThread(publicThread({ browserSessionPolicy: "same-browser-session", browserSessionId: "" }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationThread(publicThread({ browserSessionPolicy: undefined, browserSessionId: undefined }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(publicRun({ browserSessionPolicy: "shared-browser-session" }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
assert.throws(
  () =>
    sanitizePublicIntegrationRun(publicRun({ ownerBrowserSessionId: "A".repeat(64) }), {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
const inheritedBrowserAliasThread = Object.assign(Object.create({ ownerBrowserSessionId: OTHER_BROWSER_SESSION }), publicThread());
assert.throws(
  () =>
    sanitizePublicIntegrationThread(inheritedBrowserAliasThread, {
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    }),
  /not found/u
);
const largeThreadMessage = {
  id: `msg_${"m".repeat(32)}`,
  role: "assistant",
  content: "x".repeat(32_000),
  runId,
  createdAt: AT,
  digest: "9".repeat(64),
};
const oversizedThreadList = {
  schemaVersion: "1",
  threads: Object.freeze(
    Array.from({ length: 70 }, () =>
      sanitizePublicIntegrationThread(publicThread({ id: uuidId("thr"), messages: [largeThreadMessage] }), {
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
      })
    )
  ),
  nextBefore: null,
};
assert.throws(() => validateAgentRpcResponse(AGENT_RPC_PATHS.threadsList, oversizedThreadList), /byte limit/u);

assert.throws(
  () => normalizeIntegrationClients({ clients: [{ id: "dup", token: TOKEN, trustedProxy: true }, { id: "dup", token: SECOND_TOKEN, trustedProxy: true }] }),
  /client ids must be unique/u
);
assert.throws(
  () => normalizeIntegrationClients({ clients: [{ id: "one", token: TOKEN, trustedProxy: true }, { id: "two", token: TOKEN, trustedProxy: true }] }),
  /tokens must be unique/u
);
assert.throws(() => normalizeIntegrationClients({ bearerToken: "x".repeat(31) }), /32-4096/u);
assert.throws(() => normalizeIntegrationClients({ bearerToken: "x".repeat(4097) }), /32-4096/u);
assert.throws(() => normalizeIntegrationClients({ bearerToken: `${"x".repeat(31)}!` }), /transport credential grammar/u);
assert.throws(() => normalizeIntegrationClients({ bearerToken: TOKEN }), /trusted principal proxy/u);
assert.doesNotThrow(() => normalizeIntegrationClients({ bearerToken: TOKEN, trustedProxy: true }));
assert.deepEqual(
  normalizeIntegrationClients({
    clients: [{
      id: "artifact-content-client",
      token: TOKEN,
      trustedProxy: true,
      scopes: [AGENT_RPC_PATHS.artifactsContent],
    }],
  })[0].scopes,
  [AGENT_RPC_PATHS.artifactsContent],
  "the exact local artifact-content RPC is an admissible trusted-proxy scope"
);
await smokeSsePostHeaderFailure();

const additiveSourceFiles = [
  "src/integration-api.js",
  "src/integration-artifacts.js",
  "src/integration-auth.js",
  "src/integration-durable-common.js",
  "src/integration-event-ledger-store.js",
  "src/integration-events.js",
  "src/integration-idempotency-store.js",
  "src/integration-policy.js",
  "src/integration-sandbox-profile.js",
  "src/integration-session-service.js",
  "scripts/smoke-integration-api.js",
  "scripts/smoke-integration-authorities.js",
  "scripts/smoke-integration-sandbox-profile.js",
];
const forbiddenRuntimeNeedles = [
  ["ProjectsLFS", "LazyEdge"].join("/"),
  ["..", "..", "LazyEdge"].join("/"),
  ["Lazying", "Agent", "Web"].join(""),
];
for (const relativeFile of additiveSourceFiles) {
  const source = await fs.readFile(relativeFile, "utf8");
  assert.equal(forbiddenRuntimeNeedles.some((needle) => source.includes(needle)), false, relativeFile);
}
for (const relativeFile of additiveSourceFiles.filter((file) => file.startsWith("src/"))) {
  const source = await fs.readFile(relativeFile, "utf8");
  assert.equal(/x-lazyedge-(?:principal-id|browser-session-id|idempotency-key)/u.test(source), false, relativeFile);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-integration-smoke-"));
try {
  await attachmentBodyAdmissionRoundTrip();
  const tokenPath = path.join(tempDir, "token");
  await fs.writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
  assert.equal(await readProtectedIntegrationTokenFile(tokenPath), TOKEN);
  await fs.writeFile(tokenPath, `${TOKEN}\n${SECOND_TOKEN}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
  await assert.rejects(() => readProtectedIntegrationTokenFile(tokenPath), /exactly one line/u);
  await fs.writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  await fs.chmod(tokenPath, 0o644);
  await assert.rejects(() => readProtectedIntegrationTokenFile(tokenPath), /group\/world/u);
  await fs.chmod(tokenPath, 0o600);
  const hardLink = path.join(tempDir, "token-hardlink");
  await fs.link(tokenPath, hardLink);
  await assert.rejects(() => readProtectedIntegrationTokenFile(tokenPath), /hard links/u);
  await fs.unlink(hardLink);
  const symlink = path.join(tempDir, "token-symlink");
  await fs.symlink(tokenPath, symlink);
  await assert.rejects(() => readProtectedIntegrationTokenFile(symlink), /symlink/u);

  const calls = [];
  const app = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService(calls),
    idempotencyStore: makeProvenStoreContractDouble(),
  });
  try {
    let result = await rpc(app.url, AGENT_RPC_PATHS.capabilities, {});
    assert.equal(result.response.status, 200);
    const capabilities = validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, result.json);
    assert.equal(capabilities.enabled, false);
    assert.equal(capabilities.agent.label, "AgInTi Agent");
    assert.equal(capabilities.model.label, "LocalLLM");

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, { method: "GET", headers: authHeaders() });
    assert.equal(result.status, 405);
    assert.equal((await result.json()).error.code, "METHOD_NOT_ALLOWED");

    result = await rpc(app.url, "/agent/v1/capabilities/get", {});
    assert.equal(result.response.status, 404);
    assert.equal(result.json.error.code, "NOT_FOUND");

    for (const badPath of [
      `${AGENT_RPC_PATHS.capabilities}/`,
      "/agent/v1//capabilities",
      "/agent/v1/%2e/capabilities",
      `${AGENT_RPC_PATHS.capabilities}?x=1`,
    ]) {
      const raw = await rawPost(app.url, badPath);
      assert.equal(raw.status, 404, badPath);
      assert.equal(raw.json.error.code, "NOT_FOUND");
    }

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json; charset=utf-16" }),
      body: "{}",
    });
    assert.equal(result.status, 415);
    assert.equal((await result.json()).error.code, "INVALID_CONTENT_TYPE");

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders({ "content-encoding": "gzip" }),
      body: "{}",
    });
    assert.equal(result.status, 415);
    assert.equal((await result.json()).error.code, "UNSUPPORTED_CONTENT_ENCODING");

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.code, "UNAUTHORIZED");

    const invalidUtf8 = await rawPost(app.url, AGENT_RPC_PATHS.capabilities, Buffer.from([0xff]), {});
    assert.equal(invalidUtf8.status, 400);
    assert.equal(invalidUtf8.json.error.code, "INVALID_JSON");
    assert.equal(calls.length, 0);

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-aginti-browser-session-id": BROWSER_SESSION,
      },
      body: "{}",
    });
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.code, "INVALID_PRINCIPAL");

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders({ "x-aginti-principal-id": CLOUD_GRAMMAR_PRINCIPAL }),
      body: "{}",
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).enabled, false);

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders({ "x-aginti-browser-session-id": "A".repeat(64) }),
      body: "{}",
    });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, "INVALID_BROWSER_SESSION");

    result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders({ "x-lazyedge-browser-session": BROWSER_SESSION }),
      body: "{}",
    });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, "RESERVED_INTEGRATION_HEADER");

    for (const legacyHeader of [
      "x-lazyedge-principal-id",
      "x-lazyedge-browser-session-id",
      "x-lazyedge-idempotency-key",
    ]) {
      result = await fetch(`${app.url}${AGENT_RPC_PATHS.capabilities}`, {
        method: "POST",
        headers: authHeaders({ [legacyHeader]: legacyHeader === "x-lazyedge-idempotency-key" ? idempotencyKey("legacy") : BROWSER_SESSION }),
        body: "{}",
      });
      assert.equal(result.status, 400, legacyHeader);
      assert.equal((await result.json()).error.code, "RESERVED_INTEGRATION_HEADER", legacyHeader);
    }

    for (const [label, headers, expectedStatus, expectedCode] of [
      ["duplicate authorization", { authorization: [`Bearer ${TOKEN}`, `Bearer ${SECOND_TOKEN}`] }, 401, "UNAUTHORIZED"],
      ["duplicate principal", { "x-aginti-principal-id": [PRINCIPAL, OTHER_PRINCIPAL] }, 401, "INVALID_PRINCIPAL"],
      ["duplicate browser session", { "x-aginti-browser-session-id": [BROWSER_SESSION, OTHER_BROWSER_SESSION] }, 400, "INVALID_BROWSER_SESSION"],
      ["duplicate idempotency", { "Idempotency-Key": [idempotencyKey("dup-a"), idempotencyKey("dup-b")] }, 400, "INVALID_IDEMPOTENCY_KEY"],
    ]) {
      const duplicate = await rawPost(app.url, AGENT_RPC_PATHS.capabilities, "{}", headers);
      assert.equal(duplicate.status, expectedStatus, label);
      assert.equal(duplicate.json.error.code, expectedCode, label);
    }

    result = await rpc(app.url, AGENT_RPC_PATHS.threadsList, {}, { "Idempotency-Key": idempotencyKey("read") });
    assert.equal(result.response.status, 400);
    assert.equal(result.json.error.code, "INVALID_IDEMPOTENCY_KEY");

    result = await rpc(app.url, AGENT_RPC_PATHS.threadsCreate, {});
    assert.equal(result.response.status, 400);
    assert.equal(result.json.error.code, "INVALID_IDEMPOTENCY_KEY");

    await expectRpcError(app.url, AGENT_RPC_PATHS.threadsList, {}, 503, "AGENT_UNAVAILABLE");
    await expectRpcError(app.url, AGENT_RPC_PATHS.threadsGet, { threadId }, 503, "AGENT_UNAVAILABLE");

    const createKey = idempotencyKey("create");
    await expectRpcError(
      app.url,
      AGENT_RPC_PATHS.threadsCreate,
      {},
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": createKey },
      "disabled create"
    );
    await expectRpcError(
      app.url,
      AGENT_RPC_PATHS.threadsCreate,
      {},
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": createKey },
      "disabled create replay"
    );
    assert.equal(calls.filter((call) => call.method === "createThread").length, 0);

    await expectRpcError(
      app.url,
      AGENT_RPC_PATHS.runsStart,
      { threadId, input: { text: "Plot this" } },
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": idempotencyKey("start") },
      "disabled run start"
    );

    const forbidden = await rpc(
      app.url,
      AGENT_RPC_PATHS.runsStart,
      { threadId, input: { text: "Plot this" }, provider: "deepseek" },
      { "Idempotency-Key": idempotencyKey("forbidden") }
    );
    assert.equal(forbidden.response.status, 400);
    assert.equal(forbidden.json.error.code, "UNSUPPORTED_FIELD");

    await expectRpcError(app.url, AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0 }, 400, "INVALID_REQUEST");
    await expectRpcError(app.url, AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE");
    await expectRpcError(app.url, AGENT_RPC_PATHS.artifactsList, { threadId }, 503, "AGENT_UNAVAILABLE");
    await expectRpcError(app.url, AGENT_RPC_PATHS.artifactsGet, { artifactId }, 503, "AGENT_UNAVAILABLE");
    assert.equal(calls.some((call) => call.method !== "capabilities"), false);
  } finally {
    await app.close();
  }

  const implicitProxyCalls = [];
  const implicitProxyApp = await startApp({
    auth: { bearerToken: TOKEN },
    sessionService: makeService(implicitProxyCalls),
    idempotencyStore: makeProvenStoreContractDouble(),
  });
  try {
    const implicitProxy = await rpc(implicitProxyApp.url, AGENT_RPC_PATHS.capabilities, {});
    assert.equal(implicitProxy.response.status, 503);
    assert.equal(implicitProxy.json.error.code, "AUTH_UNCONFIGURED");
    assert.equal(implicitProxyCalls.length, 0);
  } finally {
    await implicitProxyApp.close();
  }

  const invalidUtf8Calls = [];
  let invalidUtf8IdempotencyCalls = 0;
  const invalidUtf8Store = {
    ...makeProvenStoreContractDouble(),
    async runMutation(...args) {
      invalidUtf8IdempotencyCalls += 1;
      return makeProvenStoreContractDouble().runMutation(...args);
    },
  };
  const invalidUtf8App = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService(invalidUtf8Calls),
    idempotencyStore: invalidUtf8Store,
  });
  try {
    const invalidMutation = await rawPost(
      invalidUtf8App.url,
      AGENT_RPC_PATHS.threadsCreate,
      Buffer.from([0xff]),
      { "Idempotency-Key": idempotencyKey("invalid-utf8") }
    );
    assert.equal(invalidMutation.status, 400);
    assert.equal(invalidMutation.json.error.code, "INVALID_JSON");
    assert.equal(invalidUtf8Calls.length, 0);
    assert.equal(invalidUtf8IdempotencyCalls, 0);
  } finally {
    await invalidUtf8App.close();
  }

  const tinyBodyApp = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([]),
    idempotencyStore: makeProvenStoreContractDouble(),
    maxBodyBytes: 10,
  });
  try {
    const result = await fetch(`${tinyBodyApp.url}${AGENT_RPC_PATHS.capabilities}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ tooLarge: true }),
    });
    assert.equal(result.status, 413);
    assert.equal((await result.json()).error.code, "REQUEST_TOO_LARGE");
  } finally {
    await tinyBodyApp.close();
  }

  const disabled = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([], { capabilities: {} }),
  });
  try {
    const capabilities = await rpc(disabled.url, AGENT_RPC_PATHS.capabilities, {});
    assert.equal(capabilities.response.status, 200);
    assert.equal(validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, capabilities.json).enabled, false);
    await expectRpcError(disabled.url, AGENT_RPC_PATHS.threadsList, {}, 503, "AGENT_UNAVAILABLE");
    await expectRpcError(
      disabled.url,
      AGENT_RPC_PATHS.runsStart,
      { threadId, input: { text: "Blocked" } },
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": idempotencyKey("blocked") }
    );
  } finally {
    await disabled.close();
  }

  const missingIdempotency = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([]),
  });
  try {
    const capabilities = await rpc(missingIdempotency.url, AGENT_RPC_PATHS.capabilities, {});
    assert.equal(capabilities.response.status, 200);
    assert.equal(validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, capabilities.json).enabled, false);
    await expectRpcError(missingIdempotency.url, AGENT_RPC_PATHS.threadsList, {}, 503, "AGENT_UNAVAILABLE");
    await expectRpcError(
      missingIdempotency.url,
      AGENT_RPC_PATHS.threadsCreate,
      {},
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": idempotencyKey("missing-idempotency") }
    );
  } finally {
    await missingIdempotency.close();
  }

  const weakIdempotency = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([]),
    idempotencyStore: {
      owner: "aginti",
      durable: true,
      atomicLookupAndDispatch: true,
      testOnly: true,
      runMutation: async () => {
        throw new Error("must not be called");
      },
    },
  });
  try {
    const capabilities = await rpc(weakIdempotency.url, AGENT_RPC_PATHS.capabilities, {});
    assert.equal(capabilities.response.status, 200);
    assert.equal(validateAgentRpcResponse(AGENT_RPC_PATHS.capabilities, capabilities.json).enabled, false);
    await expectRpcError(
      weakIdempotency.url,
      AGENT_RPC_PATHS.threadsCreate,
      {},
      503,
      "AGENT_UNAVAILABLE",
      { "Idempotency-Key": idempotencyKey("weak-idempotency") }
    );
  } finally {
    await weakIdempotency.close();
  }

  const sharedRaceState = {};
  const raceCalls = [];
  const raceService = makeService(raceCalls);
  const raceAppA = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: raceService,
    idempotencyStore: makeProvenStoreContractDouble(sharedRaceState),
  });
  const raceAppB = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: raceService,
    idempotencyStore: makeProvenStoreContractDouble(sharedRaceState),
  });
  try {
    const raceKey = idempotencyKey("race");
    const [first, second] = await Promise.all([
      rpc(raceAppA.url, AGENT_RPC_PATHS.threadsCreate, {}, { "Idempotency-Key": raceKey }),
      rpc(raceAppB.url, AGENT_RPC_PATHS.threadsCreate, {}, { "Idempotency-Key": raceKey }),
    ]);
    assert.equal(first.response.status, 503);
    assert.equal(second.response.status, 503);
    assert.equal(first.json.error.code, "AGENT_UNAVAILABLE");
    assert.equal(second.json.error.code, "AGENT_UNAVAILABLE");
    assert.equal(raceCalls.filter((call) => call.method === "createThread").length, 0);
  } finally {
    await raceAppA.close();
    await raceAppB.close();
  }

  let recoveryAttempts = 0;
  const recovery = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([], {
      createThread: async (payload) => {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) throw new Error("simulated handler failure");
        return { thread: publicThread({ title: payload.title }) };
      },
    }),
    idempotencyStore: makeProvenStoreContractDouble(),
  });
  try {
    const recoveryKey = idempotencyKey("recovery");
    const failed = await rpc(recovery.url, AGENT_RPC_PATHS.threadsCreate, {}, { "Idempotency-Key": recoveryKey });
    assert.equal(failed.response.status, 503);
    assert.equal(failed.json.error.code, "AGENT_UNAVAILABLE");
    const retried = await rpc(recovery.url, AGENT_RPC_PATHS.threadsCreate, {}, { "Idempotency-Key": recoveryKey });
    assert.equal(retried.response.status, 503);
    assert.equal(retried.json.error.code, "AGENT_UNAVAILABLE");
    assert.equal(recoveryAttempts, 0);
  } finally {
    await recovery.close();
  }

  for (const [pathname, body, overrides, headers = {}] of [
    [AGENT_RPC_PATHS.threadsGet, { threadId }, { getThread: { principalId: undefined } }],
    [AGENT_RPC_PATHS.threadsGet, { threadId }, { getThread: { id: uuidId("thr") } }],
    [AGENT_RPC_PATHS.threadsGet, { threadId }, { getThread: { browserSessionId: OTHER_BROWSER_SESSION } }],
    [AGENT_RPC_PATHS.runsStatus, { runId }, { getRunStatus: { principalId: undefined } }],
    [AGENT_RPC_PATHS.runsStatus, { runId }, { getRunStatus: { id: uuidId("run") } }],
    [AGENT_RPC_PATHS.runsStatus, { runId }, { getRunStatus: { browserSessionId: OTHER_BROWSER_SESSION } }],
    [AGENT_RPC_PATHS.threadsDelete, { threadId }, { deleteThread: { principalId: undefined } }, { "Idempotency-Key": idempotencyKey("delete-missing-owner") }],
    [AGENT_RPC_PATHS.threadsDelete, { threadId }, { deleteThread: { threadId: uuidId("thr") } }, { "Idempotency-Key": idempotencyKey("delete-wrong-id") }],
    [AGENT_RPC_PATHS.artifactsGet, { artifactId }, { getArtifact: { principalId: undefined } }],
    [AGENT_RPC_PATHS.artifactsGet, { artifactId }, { getArtifact: { id: `art_${"e".repeat(64)}` } }],
    [AGENT_RPC_PATHS.artifactsGet, { artifactId }, { getArtifact: { browserSessionId: OTHER_BROWSER_SESSION } }],
    [AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, { loadRunEventsRun: { id: uuidId("run") } }],
    [AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, { publicEventLedger: { principalId: OTHER_PRINCIPAL } }],
    [AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, { publicEventLedger: { browserSessionId: OTHER_BROWSER_SESSION } }],
  ]) {
    const scoped = await startApp({
      auth: { bearerToken: TOKEN, trustedProxy: true },
      sessionService: makeService([], overrides),
      idempotencyStore: makeProvenStoreContractDouble(),
    });
    try {
      await expectRpcError(scoped.url, pathname, body, 503, "AGENT_UNAVAILABLE", headers);
    } finally {
      await scoped.close();
    }
  }

  const unprovenEvents = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: makeService([], { publicEventLedger: { durable: false } }),
    idempotencyStore: makeProvenStoreContractDouble(),
  });
  try {
    await expectRpcError(unprovenEvents.url, AGENT_RPC_PATHS.runsEvents, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE");
  } finally {
    await unprovenEvents.close();
  }

  for (const [label, overrides, body, expectedStatus, expectedCode] of [
    ["bridge-owned", { publicEventLedger: { bridgeOwned: true } }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["missing-monotonic", { publicEventLedger: { monotonic: undefined } }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["gap", { events: [secondOutputEvent] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["reorder", { events: [secondOutputEvent, outputEvent] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["duplicate", { events: [outputEvent, outputEvent] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["bad-prev", { events: [outputEvent, badPreviousHashEvent] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["foreign-event-run", { events: [foreignRunEvent] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    ["hash-drift", { events: [{ ...outputEvent, hash: "1".repeat(64) }] }, { runId, afterSeq: 0, afterHash: ZERO_DIGEST }, 503, "AGENT_UNAVAILABLE"],
    [
      "bad-cursor-hash",
      {
        events: [secondOutputEvent],
        publicEventLedger: {
          loadCursor: async () => ({ seq: 1, hash: "1".repeat(64) }),
        },
      },
      { runId, afterSeq: 1, afterHash: outputEvent.hash },
      503,
      "AGENT_UNAVAILABLE",
    ],
  ]) {
    const eventApp = await startApp({
      auth: { bearerToken: TOKEN, trustedProxy: true },
      sessionService: makeService([], overrides),
      idempotencyStore: makeProvenStoreContractDouble(),
    });
    try {
      await expectRpcError(eventApp.url, AGENT_RPC_PATHS.runsEvents, body, expectedStatus, expectedCode, {}, label);
    } finally {
      await eventApp.close();
    }
  }
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

console.log("smoke-integration-api ok");
