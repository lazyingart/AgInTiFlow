#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import {
  createIntegrationRouter,
  INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
} from "../src/integration-api.js";
import {
  INTEGRATION_RPC_PATHS,
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
  contractDigest,
} from "../src/integration-policy.js";
import {
  assertFileIntegrationIdempotencyStore,
  createFileIntegrationIdempotencyStore,
  createSealedIntegrationIdempotencyRecord,
  integrationIdempotencyPaths,
} from "../src/integration-idempotency-store.js";
import {
  createFileIntegrationEventLedgerStore,
  integrationEventLedgerPaths,
  INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN,
  INTEGRATION_EVENT_LEDGER_HEADER_SCHEMA_VERSION,
} from "../src/integration-event-ledger-store.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
  createPublicIntegrationEvent,
  loadPublicIntegrationEvents,
} from "../src/integration-events.js";
import {
  NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION,
  createNativeIntegrationSessionService,
} from "../src/integration-session-service.js";
import {
  atomicWriteProtectedJson,
  currentProcessOwner,
  processIdentityForPid,
  sealObject,
  sha256Text,
  withDirectoryLock,
} from "../src/integration-durable-common.js";

const TOKEN = "phase3-integration-authority-token";
const PRINCIPAL = "principalAAAAAAAA";
const OTHER_PRINCIPAL = "principalBBBBBBBB";
const CLOUD_GRAMMAR_PRINCIPAL = "principal.with~dash_123";
const BROWSER_SESSION = "a".repeat(64);
const OTHER_BROWSER_SESSION = "b".repeat(64);
const AT = "2026-08-20T08:00:00.000Z";
const ZERO_DIGEST = "0".repeat(64);
const CONTEXT_DIGEST = "c".repeat(64);
const SNAPSHOT_HASH = "d".repeat(64);

function uuidId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

const threadId = uuidId("thr");
const runId = uuidId("run");
const artifactId = `art_${"a".repeat(64)}`;

function linePlot() {
  return {
    schemaVersion: "1",
    type: "line",
    labels: ["Jan", "Feb"],
    series: [{ name: "Revenue", data: [1, 2] }],
  };
}

function threadRecord(overrides = {}) {
  return {
    id: threadId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Native thread",
    status: "idle",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    lastRunId: runId,
    authority: {
      kind: "aginti",
      mapped: true,
      runtimeRevision: 7,
      contextDigest: CONTEXT_DIGEST,
      lastCompaction: null,
    },
    replay: { prunedMessageCount: 0, anchorDigest: ZERO_DIGEST },
    messages: [],
    rawPath: "/home/aginti/private",
    ...overrides,
  };
}

function runRecord(overrides = {}) {
  return {
    id: runId,
    principalId: PRINCIPAL,
    threadId,
    previousRunId: null,
    status: "running",
    createdAt: AT,
    startedAt: AT,
    completedAt: null,
    cancelRequestedAt: null,
    output: "public response",
    error: null,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    activeBrowserSessionId: BROWSER_SESSION,
    authority: {
      kind: "aginti",
      snapshotHash: SNAPSHOT_HASH,
      runtimeRevision: 8,
      contextDigest: CONTEXT_DIGEST,
    },
    eventCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 },
    rawStdout: "token=secret /home/private",
    ...overrides,
  };
}

function artifactRecord(overrides = {}) {
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
    url: "file:///home/aginti/private.png",
    ...overrides,
  };
}

function fullIsolationAttestation() {
  const attestation = {
    profileVersion: "hardened-v1",
    profileDigest: "e".repeat(64),
  };
  for (const key of REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS) attestation[key] = true;
  return attestation;
}

function runtimeProof() {
  return {
    schemaVersion: NATIVE_INTEGRATION_RUNTIME_PROOF_VERSION,
    owner: "aginti",
    stableSessionIds: true,
    runtimeRevisions: true,
    contextDigests: true,
    compactionMetadata: true,
    adaptersAreTransportOnly: true,
    noRawEvents: true,
    publicArtifactsOnly: true,
    noHostedProviders: true,
    noWrappers: true,
    noMcp: true,
    noWeb: true,
    sandboxPrerequisites: {
      owner: "aginti",
      valid: false,
      enabled: false,
      digest: contractDigest({ disabled: true }),
    },
    isolationAttestation: fullIsolationAttestation(),
  };
}

function makeRuntime(calls = [], overrides = {}) {
  return {
    getIntegrationRuntimeProof() {
      calls.push({ method: "getIntegrationRuntimeProof" });
      return overrides.proof || runtimeProof();
    },
    async listIntegrationThreads(payload, context) {
      calls.push({ method: "listIntegrationThreads", payload, context });
      return { threads: [threadRecord(), threadRecord({ id: uuidId("thr"), principalId: OTHER_PRINCIPAL })], nextBefore: null };
    },
    async createIntegrationThread(payload, context) {
      calls.push({ method: "createIntegrationThread", payload, context });
      return { thread: threadRecord({ title: payload.title }) };
    },
    async getIntegrationThread(payload, context) {
      calls.push({ method: "getIntegrationThread", payload, context });
      return { thread: threadRecord({ id: payload.threadId, ...(overrides.thread || {}) }) };
    },
    async updateIntegrationThread(payload, context) {
      calls.push({ method: "updateIntegrationThread", payload, context });
      return { thread: threadRecord({ id: payload.threadId, title: payload.title, revision: 2, ...(overrides.updateThread || {}) }) };
    },
    async deleteIntegrationThread(payload, context) {
      calls.push({ method: "deleteIntegrationThread", payload, context });
      return { thread: threadRecord({ id: payload.threadId, ...(overrides.deleteThread || {}) }) };
    },
    async startIntegrationRun(payload, context) {
      calls.push({ method: "startIntegrationRun", payload, context });
      return { run: runRecord({ threadId: payload.threadId, ...(overrides.startRun || {}) }) };
    },
    async getIntegrationRunStatus(payload, context) {
      calls.push({ method: "getIntegrationRunStatus", payload, context });
      return { run: runRecord({ id: payload.runId, ...(overrides.run || {}) }) };
    },
    async cancelIntegrationRun(payload, context) {
      calls.push({ method: "cancelIntegrationRun", payload, context });
      return { run: runRecord({ id: payload.runId, status: "cancelled", completedAt: AT, cancelRequestedAt: AT }) };
    },
    async resumeIntegrationRun(payload, context) {
      calls.push({ method: "resumeIntegrationRun", payload, context });
      return { run: runRecord({ id: uuidId("run"), previousRunId: payload.runId, ...(overrides.resumeRun || {}) }) };
    },
    async listIntegrationArtifacts(payload, context) {
      calls.push({ method: "listIntegrationArtifacts", payload, context });
      return {
        artifacts: [
          artifactRecord(overrides.artifact || {}),
          artifactRecord({ id: `art_${"b".repeat(64)}`, principalId: OTHER_PRINCIPAL }),
          artifactRecord({ id: `art_${"c".repeat(64)}`, threadId: uuidId("thr") }),
        ],
      };
    },
    async getIntegrationArtifact(payload, context) {
      calls.push({ method: "getIntegrationArtifact", payload, context });
      return { artifact: artifactRecord({ id: payload.artifactId, ...(overrides.artifact || {}) }) };
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

function requestHash(pathname, principalId, browserSessionId, payload) {
  return contractDigest({
    algorithm: "canonical-json-v1",
    principalId,
    browserSessionId,
    operation: pathname,
    request: payload,
  });
}

function mutationContext(pathname, body, key = "phase3-key-xxxxxxxxxxxxxxxx") {
  return {
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    pathname,
    idempotencyKey: key,
    requestHash: requestHash(pathname, PRINCIPAL, BROWSER_SESSION, body),
    requestHashAlgorithm: "canonical-json-v1",
    responseEnvelope: "aginti-agent-rpc-v1",
  };
}

function fullRecoveryAuthority() {
  return {
    owner: "aginti",
    explicit: true,
    beforeDispatchRecovery: true,
    afterDispatchBeforeResultRecovery: true,
    afterResultBeforePublicResponseRecovery: true,
  };
}

function threadResponse(title = "Native thread") {
  const thread = threadRecord({ title });
  return {
    schemaVersion: "1",
    thread: {
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
  };
}

function assertNoRawLeak(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes("/home/"), false);
  assert.equal(text.includes("token=secret"), false);
  assert.equal(text.includes("rawStdout"), false);
  assert.equal(text.includes("rawPath"), false);
  assert.equal(text.includes("file://"), false);
}

async function assertRejectsCode(fn, code, label) {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(error.code || error.publicCode, code, label);
      return true;
    },
    label
  );
}

async function waitFor(condition, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

async function waitForFile(filePath, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

async function currentPendingOwner(overrides = {}) {
  const owner = await currentProcessOwner({ now: () => new Date(AT) });
  return { ...owner, ...overrides };
}

async function deadPendingOwner(overrides = {}) {
  const identity = await processIdentityForPid(process.pid);
  assert.ok(identity, "process identity must be available for idempotency owner smokes");
  return {
    schemaVersion: "aginti-process-owner-v1",
    pid: 999999999,
    token: "f".repeat(32),
    processIdentity: identity,
    acquiredAt: AT,
    heartbeatAt: AT,
    ...overrides,
  };
}

function staleIdentityForReuse(identity) {
  return {
    ...identity,
    startTimeTicks: identity.startTimeTicks === "1" ? "2" : "1",
  };
}

async function runNodeInline(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
    child.stdin.end(script);
  });
}

function spawnNodeInline(script, args = []) {
  const child = spawn(process.execPath, ["--input-type=module", "-", ...args], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
  child.stdin.end(script);
  return { child, done };
}

async function smokeDirectoryLock(root) {
  const lockRoot = path.join(root, "locks");
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });

  const handlerEexistLock = path.join(lockRoot, "handler-eexist.lock");
  await assertRejectsCode(
    () =>
      withDirectoryLock(handlerEexistLock, async () => {
        const error = new Error("handler-created-eexist");
        error.code = "EEXIST";
        throw error;
      }),
    "EEXIST",
    "handler EEXIST propagates"
  );
  await fs.access(handlerEexistLock).then(
    () => assert.fail("handler EEXIST lock should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const exceptionLock = path.join(lockRoot, "exception-cleanup.lock");
  await assert.rejects(
    () =>
      withDirectoryLock(exceptionLock, async () => {
        throw new Error("handler exception");
      }),
    /handler exception/u
  );
  let reacquired = false;
  await withDirectoryLock(exceptionLock, async () => {
    reacquired = true;
  });
  assert.equal(reacquired, true);

  const freshOwnerlessLock = path.join(lockRoot, "fresh-ownerless.lock");
  await fs.mkdir(freshOwnerlessLock, { mode: 0o700 });
  await assertRejectsCode(
    () =>
      withDirectoryLock(
        freshOwnerlessLock,
        async () => {
          assert.fail("fresh ownerless creation-window lock must not be acquired before stale bound");
        },
        { staleMs: 5000, waitMs: 40 }
      ),
    "INTEGRATION_AUTHORITY_BUSY",
    "fresh ownerless lock waits instead of corrupting"
  );
  await fs.rm(freshOwnerlessLock, { recursive: true, force: true });

  const ownerlessCrashLock = path.join(lockRoot, "ownerless-crash.lock");
  await fs.mkdir(ownerlessCrashLock, { mode: 0o700 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let ownerlessRecovered = false;
  await withDirectoryLock(
    ownerlessCrashLock,
    async () => {
      ownerlessRecovered = true;
    },
    { staleMs: 1, waitMs: 2000 }
  );
  assert.equal(ownerlessRecovered, true);
  await fs.access(ownerlessCrashLock).then(
    () => assert.fail("ownerless crash-window lock should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const liveForeignLock = path.join(lockRoot, "live-foreign.lock");
  await fs.mkdir(liveForeignLock, { mode: 0o700 });
  await atomicWriteProtectedJson(path.join(liveForeignLock, "owner.json"), {
    schemaVersion: "aginti-directory-lock-v1",
    pid: process.pid,
    token: "2".repeat(32),
    acquiredAt: new Date().toISOString(),
  });
  await assertRejectsCode(
    () =>
      withDirectoryLock(
        liveForeignLock,
        async () => {
          assert.fail("foreign live lock must not be reaped");
        },
        { staleMs: 1, waitMs: 40 }
      ),
    "INTEGRATION_AUTHORITY_BUSY",
    "foreign live lock preserved"
  );
  const liveOwner = JSON.parse(await fs.readFile(path.join(liveForeignLock, "owner.json"), "utf8"));
  assert.equal(liveOwner.token, "2".repeat(32));
  await fs.rm(liveForeignLock, { recursive: true, force: true });

  const reusedPidIdentity = await processIdentityForPid(process.pid);
  assert.ok(reusedPidIdentity, "process identity must be available for reused-pid smoke");
  const reusedPidLock = path.join(lockRoot, "stale-reused-pid.lock");
  await fs.mkdir(reusedPidLock, { mode: 0o700 });
  await atomicWriteProtectedJson(path.join(reusedPidLock, "owner.json"), {
    schemaVersion: "aginti-directory-lock-v1",
    pid: process.pid,
    token: "3".repeat(32),
    processIdentity: staleIdentityForReuse(reusedPidIdentity),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  let reusedPidRecovered = false;
  await withDirectoryLock(
    reusedPidLock,
    async () => {
      reusedPidRecovered = true;
    },
    { staleMs: 1, waitMs: 2000 }
  );
  assert.equal(reusedPidRecovered, true);
  await fs.access(reusedPidLock).then(
    () => assert.fail("stale reused-pid lock should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const staleLock = path.join(lockRoot, "stale-successor.lock");
  await fs.mkdir(staleLock, { mode: 0o700 });
  await atomicWriteProtectedJson(path.join(staleLock, "owner.json"), {
    schemaVersion: "aginti-directory-lock-v1",
    pid: 999999999,
    token: "1".repeat(32),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const order = [];
  await Promise.all([
    withDirectoryLock(
      staleLock,
      async () => {
        order.push("first");
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      { staleMs: 1, waitMs: 2000 }
    ),
    withDirectoryLock(
      staleLock,
      async () => {
        order.push("second");
      },
      { staleMs: 1, waitMs: 2000 }
    ),
  ]);
  assert.deepEqual(order.sort(), ["first", "second"]);
  await fs.access(staleLock).then(
    () => assert.fail("stale lock successor should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const staleQuarantineRetryLock = path.join(lockRoot, "stale-quarantine-retry.lock");
  await fs.mkdir(staleQuarantineRetryLock, { mode: 0o700 });
  await atomicWriteProtectedJson(path.join(staleQuarantineRetryLock, "owner.json"), {
    schemaVersion: "aginti-directory-lock-v1",
    pid: 999999999,
    token: "8".repeat(32),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await assert.rejects(
    () => withDirectoryLock(
      staleQuarantineRetryLock,
      async () => assert.fail("faulted stale quarantine must not enter its operation"),
      {
        staleMs: 1,
        waitMs: 2_000,
        testHooks: {
          async afterStaleQuarantineRename() {
            throw new Error("synthetic crash after stale quarantine rename");
          },
        },
      }
    ),
    /synthetic crash after stale quarantine rename/u
  );
  const staleQuarantineName = (await fs.readdir(lockRoot)).find((name) =>
    name.startsWith("stale-quarantine-retry.lock.stale-")
  );
  assert.ok(staleQuarantineName);
  await fs.unlink(path.join(lockRoot, staleQuarantineName, "owner.json"));
  let staleQuarantineRetried = false;
  await withDirectoryLock(
    staleQuarantineRetryLock,
    async () => {
      staleQuarantineRetried = true;
    },
    { staleMs: 1, waitMs: 2_000 }
  );
  assert.equal(staleQuarantineRetried, true);
  assert.equal(
    (await fs.readdir(lockRoot)).some((name) => name.startsWith("stale-quarantine-retry.lock.")),
    false,
    "empty stale quarantine left by interrupted recursive removal must be reclaimed"
  );

  const ownerlessQuarantineRetryLock = path.join(lockRoot, "ownerless-quarantine-retry.lock");
  await fs.mkdir(ownerlessQuarantineRetryLock, { mode: 0o700 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () => withDirectoryLock(
      ownerlessQuarantineRetryLock,
      async () => assert.fail("faulted ownerless quarantine must not enter its operation"),
      {
        staleMs: 1,
        waitMs: 2_000,
        testHooks: {
          async afterOwnerlessQuarantineRename() {
            throw new Error("synthetic crash after ownerless quarantine rename");
          },
        },
      }
    ),
    /synthetic crash after ownerless quarantine rename/u
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  let ownerlessQuarantineRetried = false;
  await withDirectoryLock(
    ownerlessQuarantineRetryLock,
    async () => {
      ownerlessQuarantineRetried = true;
    },
    { staleMs: 1, waitMs: 2_000 }
  );
  assert.equal(ownerlessQuarantineRetried, true);
  assert.equal(
    (await fs.readdir(lockRoot)).some((name) => name.startsWith("ownerless-quarantine-retry.lock.")),
    false
  );

  const ownerlessRaceLock = path.join(lockRoot, "ownerless-race.lock");
  await fs.mkdir(ownerlessRaceLock, { mode: 0o700 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ownerlessOrder = [];
  await Promise.all([
    withDirectoryLock(
      ownerlessRaceLock,
      async () => {
        ownerlessOrder.push("first");
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      { staleMs: 1, waitMs: 2000 }
    ),
    withDirectoryLock(
      ownerlessRaceLock,
      async () => {
        ownerlessOrder.push("second");
      },
      { staleMs: 1, waitMs: 2000 }
    ),
  ]);
  assert.deepEqual(ownerlessOrder.sort(), ["first", "second"]);
  await fs.access(ownerlessRaceLock).then(
    () => assert.fail("ownerless delayed-reaper race lock should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const creatorReaperRaceLock = path.join(lockRoot, "creator-reaper-race.lock");
  let releaseDelayedCreator;
  const delayedCreatorGate = new Promise((resolve) => {
    releaseDelayedCreator = resolve;
  });
  const creatorReaperOrder = [];
  let activeCriticalSections = 0;
  let overlapped = false;
  async function enterCriticalSection(label, delayMs = 20) {
    activeCriticalSections += 1;
    if (activeCriticalSections > 1) overlapped = true;
    creatorReaperOrder.push(label);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    activeCriticalSections -= 1;
  }
  const delayedCreator = withDirectoryLock(
    creatorReaperRaceLock,
    () => enterCriticalSection("delayed-creator"),
    {
      staleMs: 1,
      waitMs: 3000,
      testHooks: {
        afterMkdir: async () => {
          if (!creatorReaperOrder.includes("creator-mkdir")) creatorReaperOrder.push("creator-mkdir");
          await delayedCreatorGate;
        },
      },
    }
  );
  await waitFor(() => creatorReaperOrder.includes("creator-mkdir"), "creator mkdir hook did not run");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reaper = withDirectoryLock(
    creatorReaperRaceLock,
    () => enterCriticalSection("reaper-successor", 60),
    { staleMs: 1, waitMs: 3000 }
  );
  await waitFor(() => creatorReaperOrder.includes("reaper-successor"), "reaper successor did not acquire");
  releaseDelayedCreator();
  await Promise.all([delayedCreator, reaper]);
  assert.deepEqual(creatorReaperOrder.filter((item) => item !== "creator-mkdir").sort(), ["delayed-creator", "reaper-successor"]);
  assert.equal(overlapped, false);
  await fs.access(creatorReaperRaceLock).then(
    () => assert.fail("creator/reaper race lock should have been released"),
    (error) => assert.equal(error.code, "ENOENT")
  );
}

async function smokeIdempotency(root) {
  const storeRoot = path.join(root, "idempotency");
  const payload = {};
  const context = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, payload);
  const cloudPrincipalContext = {
    ...context,
    principalId: CLOUD_GRAMMAR_PRINCIPAL,
    requestHash: requestHash(INTEGRATION_RPC_PATHS.threadsCreate, CLOUD_GRAMMAR_PRINCIPAL, BROWSER_SESSION, payload),
    idempotencyKey: "phase3-cloud-principal-key",
  };
  const cloudPrincipalStore = createFileIntegrationIdempotencyStore({ rootDir: path.join(root, "idempotency-cloud-principal") });
  const cloudPrincipalReplay = await cloudPrincipalStore.runMutation(cloudPrincipalContext, async () => threadResponse("Cloud grammar principal"));
  assert.equal(cloudPrincipalReplay.thread.title, "Cloud grammar principal");
  const store = createFileIntegrationIdempotencyStore({ rootDir: storeRoot, pendingLeaseMs: 1000 });
  assert.equal(assertFileIntegrationIdempotencyStore(store), store);
  assert.equal(store.rootDirDigest, contractDigest({ rootDir: path.resolve(storeRoot) }));
  assert.equal(Object.isFrozen(store), true);
  await assertRejectsCode(
    async () => assertFileIntegrationIdempotencyStore(Object.freeze({ ...store })),
    "IDEMPOTENCY_STORE_UNAVAILABLE",
    "forged file idempotency store brand"
  );
  let calls = 0;
  const first = await store.runMutation(context, async () => {
    calls += 1;
    return threadResponse();
  });
  assert.equal(first.thread.id, threadId);
  const replay = await store.runMutation(context, async () => {
    calls += 1;
    return threadResponse("duplicate");
  });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  const record = await store.inspectRecord(context);
  assert.equal(record.state, "completed");
  assert.equal(record.result.kind, "public-rpc-response");
  assert.equal(JSON.stringify(record).includes("Native thread"), false);
  assertNoRawLeak(record);
  await assertRejectsCode(
    () =>
      store.runMutation(
        { ...context, requestHash: requestHash(INTEGRATION_RPC_PATHS.threadsCreate, PRINCIPAL, BROWSER_SESSION, { title: "Different" }) },
        async () => threadResponse("Different")
      ),
    "IDEMPOTENCY_CONFLICT",
    "same key different request"
  );

  const sharedRoot = path.join(root, "idempotency-shared-sidecar");
  let sharedNowMs = Date.parse(AT);
  const sharedNow = () => new Date(sharedNowMs);
  const sharedResponse = threadResponse("Shared response");
  const sharedA = createFileIntegrationIdempotencyStore({
    rootDir: sharedRoot,
    retentionMs: 1200,
    pendingLeaseMs: 200,
    now: sharedNow,
  });
  const sharedContextA = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-shared-key-a-xxxxxx");
  await sharedA.runMutation(sharedContextA, async () => sharedResponse);
  const sharedRecordA = await sharedA.inspectRecord(sharedContextA);
  const sharedResponsePath = path.join(sharedRoot, sharedRecordA.result.pointer);
  sharedNowMs += 300;
  const sharedB = createFileIntegrationIdempotencyStore({
    rootDir: sharedRoot,
    retentionMs: 10_000,
    pendingLeaseMs: 200,
    now: sharedNow,
  });
  const sharedContextB = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-shared-key-b-xxxxxx");
  await sharedB.runMutation(sharedContextB, async () => sharedResponse);
  sharedNowMs = Date.parse(sharedRecordA.expiresAt) + 1;
  await sharedB.runMutation(mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-shared-prune-xxxxxx"), async () =>
    threadResponse("Prune trigger")
  );
  await fs.access(sharedResponsePath);
  const replaySharedB = await sharedB.runMutation(sharedContextB, async () => threadResponse("duplicate"));
  assert.deepEqual(replaySharedB, sharedResponse);
  const sharedRecordB = await sharedB.inspectRecord(sharedContextB);
  sharedNowMs = Date.parse(sharedRecordB.expiresAt) + 1;
  await sharedB.runMutation(mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-shared-final-xxxxxx"), async () =>
    threadResponse("Final prune trigger")
  );
  await fs.access(sharedResponsePath).then(
    () => assert.fail("shared response sidecar should be removed only after final live reference expires"),
    (error) => assert.equal(error.code, "ENOENT")
  );

  const crossActionRoot = path.join(root, "idempotency-cross-action-response");
  const crossActionStore = createFileIntegrationIdempotencyStore({ rootDir: crossActionRoot, pendingLeaseMs: 1000 });
  const identicalResponse = threadResponse("Identical cross-action response");
  const crossCreate = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-cross-action-create");
  const crossUpdateBody = { threadId, title: "Identical cross-action response" };
  const crossUpdate = mutationContext(INTEGRATION_RPC_PATHS.threadsUpdate, crossUpdateBody, "phase3-cross-action-update");
  await crossActionStore.runMutation(crossCreate, async () => identicalResponse);
  await crossActionStore.runMutation(crossUpdate, async () => identicalResponse);
  const crossCreateRecord = await crossActionStore.inspectRecord(crossCreate);
  const crossUpdateRecord = await crossActionStore.inspectRecord(crossUpdate);
  assert.equal(crossCreateRecord.result.digest, crossUpdateRecord.result.digest);
  assert.notEqual(crossCreateRecord.result.pointer, crossUpdateRecord.result.pointer);
  assert.deepEqual(await crossActionStore.runMutation(crossCreate, async () => threadResponse("wrong create replay")), identicalResponse);
  assert.deepEqual(await crossActionStore.runMutation(crossUpdate, async () => threadResponse("wrong update replay")), identicalResponse);

  const publicationRaceRoot = path.join(root, "idempotency-response-publication-race");
  let releaseSidecarPublication;
  const sidecarPublicationGate = new Promise((resolve) => {
    releaseSidecarPublication = resolve;
  });
  let sidecarPublicationEntered = false;
  let sidecarPath = "";
  const publicationRaceA = createFileIntegrationIdempotencyStore({
    rootDir: publicationRaceRoot,
    pendingLeaseMs: 1000,
    lockWaitMs: 3000,
    faultInjector: async ({ phase, filePath }) => {
      if (phase === "response-sidecar-written" && !sidecarPublicationEntered) {
        sidecarPublicationEntered = true;
        sidecarPath = filePath;
        await sidecarPublicationGate;
      }
    },
  });
  const publicationRaceB = createFileIntegrationIdempotencyStore({
    rootDir: publicationRaceRoot,
    pendingLeaseMs: 1000,
    lockWaitMs: 3000,
  });
  const publicationContextA = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-publish-race-a");
  const publicationContextB = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-publish-race-b");
  const publicationPromiseA = publicationRaceA.runMutation(publicationContextA, async () => threadResponse("Publication A"));
  await waitFor(() => sidecarPublicationEntered, "response sidecar publication hook did not run");
  await fs.access(sidecarPath);
  let publicationBCompleted = false;
  const publicationPromiseB = publicationRaceB
    .runMutation(publicationContextB, async () => threadResponse("Publication B"))
    .then((value) => {
      publicationBCompleted = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(publicationBCompleted, false);
  releaseSidecarPublication();
  const [publicationResultA, publicationResultB] = await Promise.all([publicationPromiseA, publicationPromiseB]);
  assert.equal(publicationResultA.thread.title, "Publication A");
  assert.equal(publicationResultB.thread.title, "Publication B");
  await fs.access(sidecarPath);
  assert.deepEqual(
    await publicationRaceB.runMutation(publicationContextA, async () => threadResponse("wrong publication replay")),
    publicationResultA
  );

  const multibyteRoot = path.join(root, "idempotency-multibyte-overflow");
  const multibyteStore = createFileIntegrationIdempotencyStore({ rootDir: multibyteRoot, pendingLeaseMs: 1000 });
  const multibyteContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-multibyte-overflow");
  let multibyteSemanticCalls = 0;
  await assertRejectsCode(
    () =>
      multibyteStore.runMutation(multibyteContext, async () => {
        multibyteSemanticCalls += 1;
        return { schemaVersion: "1", text: "€".repeat(90_000) };
      }),
    "IDEMPOTENCY_RESULT_TOO_LARGE",
    "multibyte response byte overflow"
  );
  assert.equal(multibyteSemanticCalls, 1);
  const multibyteFailedRecord = await multibyteStore.inspectRecord(multibyteContext);
  assert.equal(multibyteFailedRecord.state, "failed");
  assert.equal(multibyteFailedRecord.failure.code, "IDEMPOTENCY_RESULT_TOO_LARGE");
  await assertRejectsCode(
    () =>
      multibyteStore.runMutation(multibyteContext, async () => {
        multibyteSemanticCalls += 1;
        return threadResponse("must not redispatch oversized");
      }),
    "IDEMPOTENCY_RESULT_TOO_LARGE",
    "multibyte failure replay"
  );
  const multibyteRestartedStore = createFileIntegrationIdempotencyStore({ rootDir: multibyteRoot, pendingLeaseMs: 1000 });
  await assertRejectsCode(
    () =>
      multibyteRestartedStore.runMutation(multibyteContext, async () => {
        multibyteSemanticCalls += 1;
        return threadResponse("must not redispatch oversized after restart");
      }),
    "IDEMPOTENCY_RESULT_TOO_LARGE",
    "multibyte failure replay after restart"
  );
  assert.equal(multibyteSemanticCalls, 1);

  const responseWriteFaultRoot = path.join(root, "idempotency-response-write-fault");
  const responseWriteFaultContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-response-write-eio");
  let responseWriteFaults = 0;
  let responseWriteSemanticCalls = 0;
  const responseWriteFaultStore = createFileIntegrationIdempotencyStore({
    rootDir: responseWriteFaultRoot,
    pendingLeaseMs: 1000,
    faultInjector: async ({ phase }) => {
      if (phase === "response-sidecar-written" && responseWriteFaults === 0) {
        responseWriteFaults += 1;
        const error = new Error("simulated response publication EIO /home/private token=secret");
        error.code = "EIO";
        throw error;
      }
    },
  });
  await assertRejectsCode(
    () =>
      responseWriteFaultStore.runMutation(responseWriteFaultContext, async () => {
        responseWriteSemanticCalls += 1;
        return threadResponse("Response write fault");
      }),
    "EIO",
    "response write fault"
  );
  assert.equal(responseWriteSemanticCalls, 1);
  const responseWriteFailed = await responseWriteFaultStore.inspectRecord(responseWriteFaultContext);
  assert.equal(responseWriteFailed.state, "failed");
  assert.equal(responseWriteFailed.failure.code, "EIO");
  assert.equal(JSON.stringify(responseWriteFailed).includes("/home/private"), false);
  await assertRejectsCode(
    () =>
      createFileIntegrationIdempotencyStore({ rootDir: responseWriteFaultRoot, pendingLeaseMs: 1000 }).runMutation(
        responseWriteFaultContext,
        async () => {
          responseWriteSemanticCalls += 1;
          return threadResponse("must not redispatch response write fault");
        }
      ),
    "EIO",
    "response write fault replay after restart"
  );
  assert.equal(responseWriteSemanticCalls, 1);

  const afterResultReceiptFaultRoot = path.join(root, "idempotency-after-result-receipt-fault");
  const afterResultReceiptFaultContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-after-result-eio");
  let afterResultReceiptFaults = 0;
  let afterResultReceiptSemanticCalls = 0;
  const afterResultReceiptFaultStore = createFileIntegrationIdempotencyStore({
    rootDir: afterResultReceiptFaultRoot,
    pendingLeaseMs: 1000,
    faultInjector: async ({ phase }) => {
      if (phase === "after-result-receipt" && afterResultReceiptFaults === 0) {
        afterResultReceiptFaults += 1;
        const error = new Error("simulated after-result receipt EIO");
        error.code = "EIO";
        throw error;
      }
    },
  });
  await assertRejectsCode(
    () =>
      afterResultReceiptFaultStore.runMutation(afterResultReceiptFaultContext, async () => {
        afterResultReceiptSemanticCalls += 1;
        return threadResponse("After result receipt fault");
      }),
    "EIO",
    "after-result receipt write fault"
  );
  assert.equal(afterResultReceiptSemanticCalls, 1);
  const afterResultReceiptFailed = await afterResultReceiptFaultStore.inspectRecord(afterResultReceiptFaultContext);
  assert.equal(afterResultReceiptFailed.state, "failed");
  assert.equal(afterResultReceiptFailed.failure.code, "EIO");
  await assertRejectsCode(
    () =>
      createFileIntegrationIdempotencyStore({ rootDir: afterResultReceiptFaultRoot, pendingLeaseMs: 1000 }).runMutation(
        afterResultReceiptFaultContext,
        async () => {
          afterResultReceiptSemanticCalls += 1;
          return threadResponse("must not redispatch after-result fault");
        }
      ),
    "EIO",
    "after-result receipt failure replay after restart"
  );
  assert.equal(afterResultReceiptSemanticCalls, 1);

  const raceRoot = path.join(root, "idempotency-race");
  const raceA = createFileIntegrationIdempotencyStore({ rootDir: raceRoot, pendingLeaseMs: 1000 });
  const raceB = createFileIntegrationIdempotencyStore({ rootDir: raceRoot, pendingLeaseMs: 1000 });
  let raceCalls = 0;
  async function slowHandler() {
    raceCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return threadResponse("Race");
  }
  const raceContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-race-key-xxxxxxxxxxxx");
  const raced = await Promise.all([raceA.runMutation(raceContext, slowHandler), raceB.runMutation(raceContext, slowHandler)]);
  assert.deepEqual(raced[1], raced[0]);
  assert.equal(raceCalls, 1);

  const unrelatedRoot = path.join(root, "idempotency-unrelated-key-not-busy");
  const unrelatedSlow = createFileIntegrationIdempotencyStore({ rootDir: unrelatedRoot, pendingLeaseMs: 1000, lockWaitMs: 40 });
  const unrelatedFast = createFileIntegrationIdempotencyStore({ rootDir: unrelatedRoot, pendingLeaseMs: 1000, lockWaitMs: 40 });
  const slowContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-unrelated-slow-key");
  const fastContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-unrelated-fast-key");
  let releaseSlowHandler;
  let slowHandlerEntered = false;
  const slowHandlerGate = new Promise((resolve) => {
    releaseSlowHandler = resolve;
  });
  const slowMutation = unrelatedSlow.runMutation(slowContext, async () => {
    slowHandlerEntered = true;
    await slowHandlerGate;
    return threadResponse("Slow unrelated");
  });
  await waitFor(() => slowHandlerEntered, "slow unrelated handler did not start");
  const fastResult = await unrelatedFast.runMutation(fastContext, async () => threadResponse("Fast unrelated"));
  assert.equal(fastResult.thread.title, "Fast unrelated");
  releaseSlowHandler();
  const slowResult = await slowMutation;
  assert.equal(slowResult.thread.title, "Slow unrelated");

  const processRaceRoot = path.join(root, "idempotency-process-race");
  const processRaceCounter = path.join(root, "process-race-counter.txt");
  const processRaceContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-process-race-key-xxxxxx");
  const processRaceScript = `
    import fs from "node:fs/promises";
    import { createFileIntegrationIdempotencyStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/integration-idempotency-store.js")).href)};
    const rootDir = process.argv[2];
    const counter = process.argv[3];
    const context = JSON.parse(process.argv[4]);
    const response = JSON.parse(process.argv[5]);
    const store = createFileIntegrationIdempotencyStore({ rootDir, pendingLeaseMs: 1000 });
    await store.runMutation(context, async () => {
      await fs.appendFile(counter, "hit\\n", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      return response;
    });
  `;
  await Promise.all([
    runNodeInline(processRaceScript, [processRaceRoot, processRaceCounter, JSON.stringify(processRaceContext), JSON.stringify(threadResponse("Process race"))]),
    runNodeInline(processRaceScript, [processRaceRoot, processRaceCounter, JSON.stringify(processRaceContext), JSON.stringify(threadResponse("Process race"))]),
  ]);
  const processHits = (await fs.readFile(processRaceCounter, "utf8")).trim().split("\n").filter(Boolean);
  assert.equal(processHits.length, 1);

  const failureRoot = path.join(root, "idempotency-failure");
  const failureStore = createFileIntegrationIdempotencyStore({ rootDir: failureRoot, pendingLeaseMs: 1000 });
  let failureCalls = 0;
  const failureContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-failure-key-xxxxxxxxx");
  await assert.rejects(
    () =>
      failureStore.runMutation(failureContext, async () => {
        failureCalls += 1;
        const error = new Error("runtime failed with /home/private token=secret");
        error.code = "RUNTIME_FAILED";
        error.status = 502;
        throw error;
      }),
    /runtime failed/
  );
  await assertRejectsCode(() => failureStore.runMutation(failureContext, async () => threadResponse()), "RUNTIME_FAILED", "terminal failure replay");
  assert.equal(failureCalls, 1);
  const failedRecord = await failureStore.inspectRecord(failureContext);
  assert.equal(failedRecord.state, "failed");
  assert.equal(JSON.stringify(failedRecord).includes("/home/private"), false);

  const visionGateRoot = path.join(root, "idempotency-vision-gate-failure");
  const visionGateContext = mutationContext(
    INTEGRATION_RPC_PATHS.runsStart,
    { threadId, input: { text: "Inspect this image" } },
    "phase3-vision-gate-failure"
  );
  let visionGateHandlers = 0;
  const visionGateStore = createFileIntegrationIdempotencyStore({
    rootDir: visionGateRoot,
    pendingLeaseMs: 1000,
  });
  await assert.rejects(
    () =>
      visionGateStore.runMutation(visionGateContext, async () => {
        visionGateHandlers += 1;
        const error = new Error("The downloaded local vision model is not enabled for new Agent image mutations.");
        error.code = "ANALYSIS_VISION_NOT_READY";
        error.publicCode = "ANALYSIS_VISION_NOT_READY";
        error.status = 409;
        throw error;
      }),
    (error) => error?.code === "ANALYSIS_VISION_NOT_READY" && error?.status === 409,
    "a new gate-off image key becomes a durable typed failure"
  );
  assert.equal(visionGateHandlers, 1);
  assert.equal((await visionGateStore.inspectRecord(visionGateContext)).state, "failed");
  const gateOnRestart = createFileIntegrationIdempotencyStore({
    rootDir: visionGateRoot,
    pendingLeaseMs: 1000,
  });
  await assert.rejects(
    () =>
      gateOnRestart.runMutation(visionGateContext, async () => {
        visionGateHandlers += 1;
        return threadResponse("must not dispatch after gate-on");
      }),
    (error) => error?.code === "ANALYSIS_VISION_NOT_READY" && error?.status === 409,
    "the exact failed image key remains failed after the vision gate is enabled"
  );
  assert.equal(visionGateHandlers, 1);

  const waitExhaustionRoot = path.join(root, "idempotency-live-pending-wait-exhaustion");
  const waitExhaustionContext = mutationContext(
    INTEGRATION_RPC_PATHS.runsStart,
    { threadId, input: { text: "Slow retained image staging" } },
    "phase3-live-pending-wait"
  );
  const waitExhaustionA = createFileIntegrationIdempotencyStore({
    rootDir: waitExhaustionRoot,
    pendingLeaseMs: 1000,
    lockWaitMs: 40,
  });
  const waitExhaustionB = createFileIntegrationIdempotencyStore({
    rootDir: waitExhaustionRoot,
    pendingLeaseMs: 1000,
    lockWaitMs: 40,
  });
  let releaseHeldMutation;
  const heldMutationGate = new Promise((resolve) => {
    releaseHeldMutation = resolve;
  });
  let heldMutationEntered = false;
  let heldMutationCalls = 0;
  const heldResponse = threadResponse("Held original completed");
  const heldMutation = waitExhaustionA.runMutation(waitExhaustionContext, async () => {
    heldMutationCalls += 1;
    heldMutationEntered = true;
    await heldMutationGate;
    return heldResponse;
  });
  await waitFor(() => heldMutationEntered, "held idempotent mutation did not enter");
  await assert.rejects(
    () =>
      waitExhaustionB.runMutation(waitExhaustionContext, async () => {
        heldMutationCalls += 1;
        return threadResponse("must not race the held original");
      }),
    (error) => error?.code === "IDEMPOTENCY_PENDING" && error?.status === 503,
    "a live same-key wait exhaustion is retryable service unavailability, not a conflict"
  );
  assert.equal(heldMutationCalls, 1);
  releaseHeldMutation();
  assert.deepEqual(await heldMutation, heldResponse);
  assert.deepEqual(
    await waitExhaustionB.runMutation(waitExhaustionContext, async () => {
      heldMutationCalls += 1;
      return threadResponse("must replay the exact completed response");
    }),
    heldResponse,
    "a retry after the held original completes resolves the exact durable response"
  );
  assert.equal(heldMutationCalls, 1);

  const pendingRoot = path.join(root, "idempotency-pending");
  const pendingStore = createFileIntegrationIdempotencyStore({ rootDir: pendingRoot, pendingLeaseMs: 1000 });
  const pendingContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-pending-key-xxxxxxxxx");
  const pendingPaths = integrationIdempotencyPaths(pendingRoot, pendingContext);
  await fs.mkdir(path.dirname(pendingPaths.record), { recursive: true, mode: 0o700 });
  const pendingNow = Date.now();
  const past = new Date(pendingNow - 60_000).toISOString();
  const future = new Date(pendingNow + 60_000).toISOString();
  await atomicWriteProtectedJson(
    pendingPaths.record,
    createSealedIntegrationIdempotencyRecord({
      schemaVersion: "aginti-integration-idempotency-record-v1",
      owner: "aginti",
      contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
      index: pendingPaths.index,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      pathname: INTEGRATION_RPC_PATHS.threadsCreate,
      keyDigest: sha256Text(pendingContext.idempotencyKey),
      requestHash: pendingContext.requestHash,
      createdAt: past,
      updatedAt: past,
      expiresAt: future,
      state: "pending",
      recoveryStage: "after-dispatch-before-result",
      leaseExpiresAt: past,
      pendingOwner: await deadPendingOwner({ acquiredAt: past, heartbeatAt: past, token: "1".repeat(32) }),
    })
  );
  let pendingCalls = 0;
  await assertRejectsCode(
    () =>
      pendingStore.runMutation(pendingContext, async () => {
        pendingCalls += 1;
        return threadResponse("should-not-dispatch");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "expired pending without recovery"
  );
  assert.equal(pendingCalls, 0);
  const recoveringStore = createFileIntegrationIdempotencyStore({
    rootDir: pendingRoot,
    pendingLeaseMs: 1000,
    recoverPending: async () => threadResponse("Recovered"),
  });
  await assertRejectsCode(
    () =>
      recoveringStore.runMutation(pendingContext, async () => {
        pendingCalls += 1;
        return threadResponse("duplicate");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "recoverPending without explicit recovery authority"
  );
  assert.equal(pendingCalls, 0);
  const provenRecoveringStore = createFileIntegrationIdempotencyStore({
    rootDir: pendingRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => threadResponse("Recovered"),
  });
  const recovered = await provenRecoveringStore.runMutation(pendingContext, async () => {
    pendingCalls += 1;
    return threadResponse("duplicate");
  });
  assert.equal(recovered.thread.title, "Recovered");
  assert.equal(pendingCalls, 0);

  const weakRecoveryRoot = path.join(root, "idempotency-weak-recovery-proof");
  const weakRecoveryContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-weak-recovery-proofx");
  const weakRecoveryPaths = integrationIdempotencyPaths(weakRecoveryRoot, weakRecoveryContext);
  await fs.mkdir(path.dirname(weakRecoveryPaths.record), { recursive: true, mode: 0o700 });
  await atomicWriteProtectedJson(
    weakRecoveryPaths.record,
    createSealedIntegrationIdempotencyRecord({
      schemaVersion: "aginti-integration-idempotency-record-v1",
      owner: "aginti",
      contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
      index: weakRecoveryPaths.index,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      pathname: INTEGRATION_RPC_PATHS.threadsCreate,
      keyDigest: sha256Text(weakRecoveryContext.idempotencyKey),
      requestHash: weakRecoveryContext.requestHash,
      createdAt: past,
      updatedAt: past,
      expiresAt: future,
      state: "pending",
      recoveryStage: "after-dispatch-before-result",
      leaseExpiresAt: past,
      pendingOwner: await deadPendingOwner({ acquiredAt: past, heartbeatAt: past, token: "2".repeat(32) }),
    })
  );
  let weakRecoveryCalls = 0;
  const weakRecoveryStore = createFileIntegrationIdempotencyStore({
    rootDir: weakRecoveryRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: { ...fullRecoveryAuthority(), afterResultBeforePublicResponseRecovery: false },
    recoverPending: async () => {
      weakRecoveryCalls += 1;
      return threadResponse("weak-recovered");
    },
  });
  await assertRejectsCode(
    () => weakRecoveryStore.runMutation(weakRecoveryContext, async () => threadResponse("duplicate")),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "malformed recovery authority refused"
  );
  assert.equal(weakRecoveryCalls, 0);

  const afterResultRoot = path.join(root, "idempotency-after-result-preserve");
  const afterResultContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-after-result-preserv");
  const afterResultStore = createFileIntegrationIdempotencyStore({ rootDir: afterResultRoot, pendingLeaseMs: 1000 });
  const persistedResponse = await afterResultStore.runMutation(afterResultContext, async () => threadResponse("Already persisted"));
  const completedAfterResult = await afterResultStore.inspectRecord(afterResultContext);
  const afterResultPaths = afterResultStore.pathsForRequest(afterResultContext);
  await atomicWriteProtectedJson(
    afterResultPaths.record,
    createSealedIntegrationIdempotencyRecord({
      ...completedAfterResult,
      state: "pending",
      recoveryStage: "after-result-before-public-response",
      leaseExpiresAt: past,
      updatedAt: past,
      pendingOwner: await deadPendingOwner({ acquiredAt: past, heartbeatAt: past, token: "3".repeat(32) }),
    })
  );
  let afterResultRecoveryCallbacks = 0;
  let afterResultSemanticCalls = 0;
  const afterResultRecoveringStore = createFileIntegrationIdempotencyStore({
    rootDir: afterResultRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      afterResultRecoveryCallbacks += 1;
      return threadResponse("Replacement must not win");
    },
  });
  const afterResultRecovered = await afterResultRecoveringStore.runMutation(afterResultContext, async () => {
    afterResultSemanticCalls += 1;
    return threadResponse("Duplicate must not dispatch");
  });
  assert.deepEqual(afterResultRecovered, persistedResponse);
  assert.equal(afterResultRecoveryCallbacks, 0);
  assert.equal(afterResultSemanticCalls, 0);
  const afterResultRecord = await afterResultRecoveringStore.inspectRecord(afterResultContext);
  assert.equal(afterResultRecord.state, "completed");
  assert.equal(afterResultRecord.result.digest, completedAfterResult.result.digest);

  const finalCompleteFaultRoot = path.join(root, "idempotency-final-complete-eio");
  const finalCompleteContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-final-complete-eiox");
  let finalCompleteFaults = 0;
  let finalCompleteSemanticCalls = 0;
  const finalCompleteFaultStore = createFileIntegrationIdempotencyStore({
    rootDir: finalCompleteFaultRoot,
    pendingLeaseMs: 1000,
    faultInjector: async ({ phase }) => {
      if (phase === "final-completed" && finalCompleteFaults === 0) {
        finalCompleteFaults += 1;
        const error = new Error("simulated final completed record EIO");
        error.code = "EIO";
        throw error;
      }
    },
  });
  const finalCompleteResponse = threadResponse("Final complete persisted");
  await assertRejectsCode(
    () =>
      finalCompleteFaultStore.runMutation(finalCompleteContext, async () => {
        finalCompleteSemanticCalls += 1;
        return finalCompleteResponse;
      }),
    "EIO",
    "final completed write fault"
  );
  assert.equal(finalCompleteSemanticCalls, 1);
  const finalCompletePending = await finalCompleteFaultStore.inspectRecord(finalCompleteContext);
  assert.equal(finalCompletePending.state, "pending");
  assert.equal(finalCompletePending.recoveryStage, "after-result-before-public-response");
  assert.equal(finalCompletePending.result.digest, contractDigest(finalCompleteResponse));
  const finalCompleteSidecarPath = path.join(finalCompleteFaultRoot, finalCompletePending.result.pointer);
  await fs.access(finalCompleteSidecarPath);
  const finalCompletePrune = await finalCompleteFaultStore.runMutation(
    mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-final-complete-prun"),
    async () => threadResponse("Prune while after-result pending remains live")
  );
  assert.equal(finalCompletePrune.thread.title, "Prune while after-result pending remains live");
  await fs.access(finalCompleteSidecarPath);
  const finalCompleteReplay = await finalCompleteFaultStore.runMutation(finalCompleteContext, async () => {
    finalCompleteSemanticCalls += 1;
    return threadResponse("Replacement must not dispatch");
  });
  assert.deepEqual(finalCompleteReplay, finalCompleteResponse);
  assert.equal(finalCompleteSemanticCalls, 1);
  const finalCompleteRecovered = await finalCompleteFaultStore.inspectRecord(finalCompleteContext);
  assert.equal(finalCompleteRecovered.state, "completed");
  assert.equal(finalCompleteRecovered.result.digest, finalCompletePending.result.digest);

  async function seedExpiredPendingRecord(rootDir, contextValue, recoveryStage, overrides = {}) {
    const paths = integrationIdempotencyPaths(rootDir, contextValue);
    const pendingOwner =
      overrides.pendingOwner ||
      (await deadPendingOwner({
        acquiredAt: past,
        heartbeatAt: past,
        token: recoveryStage === "before-dispatch" ? "4".repeat(32) : "5".repeat(32),
      }));
    await fs.mkdir(path.dirname(paths.record), { recursive: true, mode: 0o700 });
    await atomicWriteProtectedJson(
      paths.record,
      createSealedIntegrationIdempotencyRecord({
        schemaVersion: "aginti-integration-idempotency-record-v1",
        owner: "aginti",
        contractVersion: INTEGRATION_IDEMPOTENCY_CONTRACT_VERSION,
        index: paths.index,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        pathname: INTEGRATION_RPC_PATHS.threadsCreate,
        keyDigest: sha256Text(contextValue.idempotencyKey),
        requestHash: contextValue.requestHash,
        createdAt: past,
        updatedAt: past,
        expiresAt: overrides.expiresAt || future,
        state: "pending",
        recoveryStage,
        leaseExpiresAt: overrides.leaseExpiresAt || past,
        pendingOwner,
      })
    );
  }

  const startupBeforeRoot = path.join(root, "idempotency-startup-before-dispatch");
  const startupBeforeContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "startup-before-dispatch"
  );
  await seedExpiredPendingRecord(startupBeforeRoot, startupBeforeContext, "before-dispatch");
  let startupBeforeCallbacks = 0;
  const startupBeforeStore = createFileIntegrationIdempotencyStore({
    rootDir: startupBeforeRoot,
    pendingLeaseMs: 1_000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      startupBeforeCallbacks += 1;
      return threadResponse("before-dispatch must not redispatch");
    },
  });
  const startupBeforeProof = await startupBeforeStore.recoverBeforeListen({ timeoutMs: 1_000 });
  assert.equal(startupBeforeCallbacks, 0);
  assert.equal(startupBeforeProof.beforeListen, true);
  assert.equal(startupBeforeProof.pendingObserved, 1);
  assert.equal(startupBeforeProof.pendingRecovered, 1);
  assert.equal(startupBeforeProof.pendingRemaining, 0);
  assert.equal(startupBeforeProof.stagesObserved["before-dispatch"], 1);
  assert.equal(startupBeforeStore.getStartupRecoveryProof(), startupBeforeProof);

  const startupAfterDispatchRoot = path.join(root, "idempotency-startup-after-dispatch");
  const startupAfterDispatchContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "startup-after-dispatch"
  );
  await seedExpiredPendingRecord(
    startupAfterDispatchRoot,
    startupAfterDispatchContext,
    "after-dispatch-before-result"
  );
  let startupAfterDispatchCallbacks = 0;
  const startupAfterDispatchStore = createFileIntegrationIdempotencyStore({
    rootDir: startupAfterDispatchRoot,
    pendingLeaseMs: 1_000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      startupAfterDispatchCallbacks += 1;
      return threadResponse("Recovered before listener construction");
    },
  });
  const startupAfterDispatchProof = await startupAfterDispatchStore.recoverBeforeListen({ timeoutMs: 1_000 });
  assert.equal(startupAfterDispatchCallbacks, 1);
  assert.equal(startupAfterDispatchProof.pendingObserved, 1);
  assert.equal(startupAfterDispatchProof.pendingRecovered, 1);
  assert.equal(startupAfterDispatchProof.stagesObserved["after-dispatch-before-result"], 1);
  assert.equal(
    (await startupAfterDispatchStore.inspectRecord(startupAfterDispatchContext)).state,
    "completed"
  );

  const startupAfterResultRoot = path.join(root, "idempotency-startup-after-result");
  const startupAfterResultContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "startup-after-result"
  );
  const startupAfterResultSeed = createFileIntegrationIdempotencyStore({
    rootDir: startupAfterResultRoot,
    pendingLeaseMs: 1_000,
  });
  await startupAfterResultSeed.runMutation(
    startupAfterResultContext,
    async () => threadResponse("Persisted response before restart")
  );
  const startupAfterResultCompleted = await startupAfterResultSeed.inspectRecord(startupAfterResultContext);
  await atomicWriteProtectedJson(
    startupAfterResultSeed.pathsForRequest(startupAfterResultContext).record,
    createSealedIntegrationIdempotencyRecord({
      ...startupAfterResultCompleted,
      state: "pending",
      recoveryStage: "after-result-before-public-response",
      leaseExpiresAt: past,
      updatedAt: past,
      pendingOwner: await deadPendingOwner({
        acquiredAt: past,
        heartbeatAt: past,
        token: "6".repeat(32),
      }),
    })
  );
  let startupAfterResultCallbacks = 0;
  const startupAfterResultStore = createFileIntegrationIdempotencyStore({
    rootDir: startupAfterResultRoot,
    pendingLeaseMs: 1_000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      startupAfterResultCallbacks += 1;
      return threadResponse("replacement must not win");
    },
  });
  const startupAfterResultProof = await startupAfterResultStore.recoverBeforeListen({ timeoutMs: 1_000 });
  assert.equal(startupAfterResultCallbacks, 0);
  assert.equal(startupAfterResultProof.pendingObserved, 1);
  assert.equal(startupAfterResultProof.pendingRecovered, 1);
  assert.equal(startupAfterResultProof.stagesObserved["after-result-before-public-response"], 1);
  assert.equal((await startupAfterResultStore.inspectRecord(startupAfterResultContext)).state, "completed");

  const startupResidueRoot = path.join(root, "idempotency-startup-private-residue");
  const startupResidueContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "startup-private-residue"
  );
  const startupResidueSeed = createFileIntegrationIdempotencyStore({
    rootDir: startupResidueRoot,
    pendingLeaseMs: 1_000,
  });
  let startupResidueSemanticCalls = 0;
  const startupResidueResponse = await startupResidueSeed.runMutation(startupResidueContext, async () => {
    startupResidueSemanticCalls += 1;
    return threadResponse("Stable response across startup residue cleanup");
  });
  const startupResidueRecord = await startupResidueSeed.inspectRecord(startupResidueContext);
  const startupResiduePaths = startupResidueSeed.pathsForRequest(startupResidueContext);
  const startupResidueResponsePath = path.join(startupResidueRoot, startupResidueRecord.result.pointer);
  async function seedJsonTemporary(target, pid, suffix, bytes) {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${pid}.${suffix}.tmp`);
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    return temporary;
  }
  const startupResidueTemporaries = [
    await seedJsonTemporary(path.join(startupResidueRoot, "store.json"), 999999999, "1".repeat(16), Buffer.alloc(0)),
    await seedJsonTemporary(startupResiduePaths.record, process.pid, "2".repeat(16), Buffer.from("partial", "utf8")),
    await seedJsonTemporary(startupResidueResponsePath, 999999998, "3".repeat(16), await fs.readFile(startupResidueResponsePath)),
  ];
  const startupResidueLocks = path.join(startupResidueRoot, "locks");
  async function seedLockOwner(directory, token) {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, "owner.json"), `${JSON.stringify({
      schemaVersion: "aginti-directory-lock-v1",
      pid: 999999997,
      token,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    })}\n`, { flag: "wx", mode: 0o600 });
  }
  await seedLockOwner(path.join(startupResidueLocks, `${"c".repeat(64)}.lock`), "c".repeat(32));
  await seedLockOwner(
    path.join(startupResidueLocks, `${startupResiduePaths.index}.lock.stale-999999996-${"d".repeat(16)}`),
    "d".repeat(32)
  );
  await seedLockOwner(
    path.join(startupResidueLocks, `transactions.lock.stale-999999995-${"e".repeat(16)}`),
    "e".repeat(32)
  );
  await fs.mkdir(
    path.join(startupResidueLocks, `responses.lock.ownerless-999999994-${"f".repeat(16)}`),
    { mode: 0o700 }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startupResidueStore = createFileIntegrationIdempotencyStore({
    rootDir: startupResidueRoot,
    pendingLeaseMs: 1_000,
    staleLockMs: 1,
    lockWaitMs: 2_000,
  });
  const startupResidueProof = await startupResidueStore.recoverBeforeListen({ timeoutMs: 5_000 });
  assert.equal(startupResidueProof.pendingObserved, 0);
  assert.equal(startupResidueProof.pendingRemaining, 0);
  assert.deepEqual(await fs.readdir(startupResidueLocks), []);
  for (const temporary of startupResidueTemporaries) {
    await fs.access(temporary).then(
      () => assert.fail("private JSON crash temporary must be reclaimed before listener activation"),
      (error) => assert.equal(error.code, "ENOENT")
    );
  }
  const startupResidueReplay = await startupResidueStore.runMutation(startupResidueContext, async () => {
    startupResidueSemanticCalls += 1;
    return threadResponse("replacement must not dispatch");
  });
  assert.deepEqual(startupResidueReplay, startupResidueResponse);
  assert.equal(startupResidueSemanticCalls, 1);

  const wrongShardRoot = path.join(root, "idempotency-startup-wrong-shard");
  await fs.cp(startupResidueRoot, wrongShardRoot, { recursive: true });
  const wrongShardName = startupResiduePaths.index.startsWith("ff") ? "00" : "ff";
  const wrongShardDirectory = path.join(wrongShardRoot, "records", wrongShardName);
  await fs.mkdir(wrongShardDirectory, { mode: 0o700 });
  await fs.copyFile(
    startupResiduePaths.record,
    path.join(wrongShardDirectory, `${startupResiduePaths.index}.json`)
  );
  await assertRejectsCode(
    () => createFileIntegrationIdempotencyStore({ rootDir: wrongShardRoot }).recoverBeforeListen({ timeoutMs: 1_000 }),
    "IDEMPOTENCY_STORE_CORRUPT",
    "wrong-shard canonical record refuses startup proof"
  );

  const unknownResponseRoot = path.join(root, "idempotency-startup-unknown-response-action");
  await fs.cp(startupResidueRoot, unknownResponseRoot, { recursive: true });
  await fs.mkdir(path.join(unknownResponseRoot, "responses", "0".repeat(64)), { mode: 0o700 });
  await assertRejectsCode(
    () => createFileIntegrationIdempotencyStore({ rootDir: unknownResponseRoot }).recoverBeforeListen({ timeoutMs: 1_000 }),
    "IDEMPOTENCY_STORE_CORRUPT",
    "unknown response action directory refuses startup proof"
  );

  const startupTimeoutStore = createFileIntegrationIdempotencyStore({
    rootDir: path.join(root, "idempotency-startup-timeout"),
    pendingLeaseMs: 1_000,
    faultInjector: async ({ phase }) => {
      if (phase === "startup-pending-inventory-after") {
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
    },
  });
  await assertRejectsCode(
    () => startupTimeoutStore.recoverBeforeListen({ timeoutMs: 100 }),
    "IDEMPOTENCY_STARTUP_RECOVERY_TIMEOUT",
    "a zero-pending final inventory that completes beyond the deadline must fail closed"
  );
  const monotonicRegressionTicks = [100, 90];
  const startupMonotonicRegressionStore = createFileIntegrationIdempotencyStore({
    rootDir: path.join(root, "idempotency-startup-monotonic-regression"),
    monotonicNow: () => monotonicRegressionTicks.shift() ?? 90,
  });
  await assertRejectsCode(
    () => startupMonotonicRegressionStore.recoverBeforeListen({ timeoutMs: 1_000 }),
    "IDEMPOTENCY_STARTUP_RECOVERY_TIMEOUT",
    "a regressed recovery clock must not extend the startup deadline"
  );

  const beforeDispatchRoot = path.join(root, "idempotency-crash-before-dispatch");
  const beforeDispatchContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-crash-before-dispatch"
  );
  await seedExpiredPendingRecord(beforeDispatchRoot, beforeDispatchContext, "before-dispatch");
  const beforeDispatchSeed = await createFileIntegrationIdempotencyStore({
    rootDir: beforeDispatchRoot,
    pendingLeaseMs: 1000,
  }).inspectRecord(beforeDispatchContext);
  let beforeDispatchRecoveryCalls = 0;
  let beforeDispatchSemanticCalls = 0;
  let beforeDispatchReclaimEntered = false;
  let releaseBeforeDispatchReclaim;
  const beforeDispatchReclaimGate = new Promise((resolve) => {
    releaseBeforeDispatchReclaim = resolve;
  });
  const beforeDispatchStoreA = createFileIntegrationIdempotencyStore({
    rootDir: beforeDispatchRoot,
    pendingLeaseMs: 1000,
    recoverPending: async () => {
      beforeDispatchRecoveryCalls += 1;
      return threadResponse("before-dispatch callback must not run");
    },
    faultInjector: async ({ phase }) => {
      if (phase === "pending-reclaim-before-dispatch") {
        beforeDispatchReclaimEntered = true;
        await beforeDispatchReclaimGate;
      }
    },
  });
  const beforeDispatchStoreB = createFileIntegrationIdempotencyStore({
    rootDir: beforeDispatchRoot,
    pendingLeaseMs: 1000,
    recoverPending: async () => {
      beforeDispatchRecoveryCalls += 1;
      return threadResponse("before-dispatch callback must not run");
    },
  });
  const beforeDispatchConflict = {
    ...beforeDispatchContext,
    requestHash: beforeDispatchContext.requestHash === "6".repeat(64) ? "7".repeat(64) : "6".repeat(64),
  };
  await assertRejectsCode(
    () => beforeDispatchStoreA.runMutation(beforeDispatchConflict, async () => threadResponse("conflict")),
    "IDEMPOTENCY_CONFLICT",
    "before-dispatch reclaim preserves request binding"
  );
  assert.equal(
    (await beforeDispatchStoreA.inspectRecord(beforeDispatchContext)).integrityDigest,
    beforeDispatchSeed.integrityDigest
  );
  const beforeDispatchFreshResponse = threadResponse("Fresh after before-dispatch crash");
  const beforeDispatchFirst = beforeDispatchStoreA.runMutation(beforeDispatchContext, async () => {
    beforeDispatchSemanticCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return beforeDispatchFreshResponse;
  });
  await waitFor(() => beforeDispatchReclaimEntered, "before-dispatch reclaim hook did not run");
  const beforeDispatchSecond = beforeDispatchStoreB.runMutation(beforeDispatchContext, async () => {
    beforeDispatchSemanticCalls += 1;
    return beforeDispatchFreshResponse;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(beforeDispatchSemanticCalls, 0);
  releaseBeforeDispatchReclaim();
  const beforeDispatchRaced = await Promise.all([beforeDispatchFirst, beforeDispatchSecond]);
  assert.deepEqual(beforeDispatchRaced, [beforeDispatchFreshResponse, beforeDispatchFreshResponse]);
  assert.equal(beforeDispatchRecoveryCalls, 0);
  assert.equal(beforeDispatchSemanticCalls, 1);
  assert.equal((await beforeDispatchStoreA.inspectRecord(beforeDispatchContext)).state, "completed");
  assert.deepEqual(
    await beforeDispatchStoreA.runMutation(beforeDispatchContext, async () => {
      beforeDispatchSemanticCalls += 1;
      return threadResponse("duplicate before-dispatch replay");
    }),
    beforeDispatchFreshResponse
  );
  assert.equal(beforeDispatchSemanticCalls, 1);

  const afterDispatchCrashRoot = path.join(root, "idempotency-crash-after-dispatch-before-result");
  const afterDispatchCrashContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-crash-after-dispatch-before-result"
  );
  await seedExpiredPendingRecord(afterDispatchCrashRoot, afterDispatchCrashContext, "after-dispatch-before-result");
  const noRecoveryStore = createFileIntegrationIdempotencyStore({ rootDir: afterDispatchCrashRoot, pendingLeaseMs: 1000 });
  let afterDispatchCrashSemanticCalls = 0;
  await assertRejectsCode(
    () =>
      noRecoveryStore.runMutation(afterDispatchCrashContext, async () => {
        afterDispatchCrashSemanticCalls += 1;
        return threadResponse("must-not-dispatch");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "missing recovery authority after-dispatch-before-result"
  );
  assert.equal(afterDispatchCrashSemanticCalls, 0);
  let afterDispatchCrashRecoveryCalls = 0;
  const recoveryStore = createFileIntegrationIdempotencyStore({
    rootDir: afterDispatchCrashRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async (record) => {
      afterDispatchCrashRecoveryCalls += 1;
      assert.equal(record.recoveryStage, "after-dispatch-before-result");
      return threadResponse("Recovered after-dispatch-before-result");
    },
  });
  const crashRecovered = await recoveryStore.runMutation(afterDispatchCrashContext, async () => {
    afterDispatchCrashSemanticCalls += 1;
    return threadResponse("duplicate");
  });
  assert.equal(crashRecovered.thread.title, "Recovered after-dispatch-before-result");
  assert.equal(afterDispatchCrashRecoveryCalls, 1);
  assert.equal(afterDispatchCrashSemanticCalls, 0);
  const recoveredExternalRecord = await recoveryStore.inspectRecord(afterDispatchCrashContext);
  assert.equal(recoveredExternalRecord.state, "completed");
  assert.equal(recoveredExternalRecord.result.kind, "public-rpc-response");
  assert.deepEqual(
    await recoveryStore.runMutation(afterDispatchCrashContext, async () => {
      afterDispatchCrashSemanticCalls += 1;
      return threadResponse("must not redispatch after recovery");
    }),
    crashRecovered,
    "after-dispatch session recovery finalizes and replays the external idempotency record"
  );
  assert.equal(afterDispatchCrashSemanticCalls, 0);

  const absentReceiptRoot = path.join(root, "idempotency-after-dispatch-absent-receipt-race");
  const absentReceiptContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-after-dispatch-absent-receipt"
  );
  await seedExpiredPendingRecord(absentReceiptRoot, absentReceiptContext, "after-dispatch-before-result");
  const absentReceiptSeed = await createFileIntegrationIdempotencyStore({
    rootDir: absentReceiptRoot,
    pendingLeaseMs: 1000,
  }).inspectRecord(absentReceiptContext);
  let absentReceiptRecoveryCalls = 0;
  let absentReceiptSemanticCalls = 0;
  let absentReceiptRecoveryEntered = false;
  let releaseAbsentReceiptRecovery;
  const absentReceiptRecoveryGate = new Promise((resolve) => {
    releaseAbsentReceiptRecovery = resolve;
  });
  const absentReceiptStoreA = createFileIntegrationIdempotencyStore({
    rootDir: absentReceiptRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async (record) => {
      absentReceiptRecoveryCalls += 1;
      assert.equal(record.recoveryStage, "after-dispatch-before-result");
      absentReceiptRecoveryEntered = true;
      await absentReceiptRecoveryGate;
      return null;
    },
  });
  const absentReceiptStoreB = createFileIntegrationIdempotencyStore({
    rootDir: absentReceiptRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      absentReceiptRecoveryCalls += 1;
      return null;
    },
  });
  const absentReceiptConflict = {
    ...absentReceiptContext,
    requestHash: absentReceiptContext.requestHash === "8".repeat(64) ? "9".repeat(64) : "8".repeat(64),
  };
  await assertRejectsCode(
    () => absentReceiptStoreA.runMutation(absentReceiptConflict, async () => threadResponse("conflict")),
    "IDEMPOTENCY_CONFLICT",
    "after-dispatch reclaim preserves request binding"
  );
  assert.equal(
    (await absentReceiptStoreA.inspectRecord(absentReceiptContext)).integrityDigest,
    absentReceiptSeed.integrityDigest
  );
  const absentReceiptFreshResponse = threadResponse("Fresh after absent session receipt");
  const absentReceiptFirst = absentReceiptStoreA.runMutation(absentReceiptContext, async () => {
    absentReceiptSemanticCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return absentReceiptFreshResponse;
  });
  await waitFor(() => absentReceiptRecoveryEntered, "after-dispatch absent-receipt recovery hook did not run");
  const absentReceiptSecond = absentReceiptStoreB.runMutation(absentReceiptContext, async () => {
    absentReceiptSemanticCalls += 1;
    return absentReceiptFreshResponse;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(absentReceiptRecoveryCalls, 1);
  assert.equal(absentReceiptSemanticCalls, 0);
  releaseAbsentReceiptRecovery();
  const absentReceiptRaced = await Promise.all([absentReceiptFirst, absentReceiptSecond]);
  assert.deepEqual(absentReceiptRaced, [absentReceiptFreshResponse, absentReceiptFreshResponse]);
  assert.equal(absentReceiptRecoveryCalls, 1);
  assert.equal(absentReceiptSemanticCalls, 1);
  assert.equal((await absentReceiptStoreA.inspectRecord(absentReceiptContext)).state, "completed");
  assert.deepEqual(
    await absentReceiptStoreA.runMutation(absentReceiptContext, async () => {
      absentReceiptSemanticCalls += 1;
      return threadResponse("duplicate absent-receipt replay");
    }),
    absentReceiptFreshResponse
  );
  assert.equal(absentReceiptSemanticCalls, 1);

  const beforeDispatchSweepRoot = path.join(root, "idempotency-before-dispatch-startup-sweep");
  const beforeDispatchSweepContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-before-dispatch-startup-sweep"
  );
  await seedExpiredPendingRecord(beforeDispatchSweepRoot, beforeDispatchSweepContext, "before-dispatch");
  let beforeDispatchSweepRecoveryCalls = 0;
  let beforeDispatchSweepSemanticCalls = 0;
  const beforeDispatchSweepStore = createFileIntegrationIdempotencyStore({
    rootDir: beforeDispatchSweepRoot,
    pendingLeaseMs: 1000,
    recoverPending: async () => {
      beforeDispatchSweepRecoveryCalls += 1;
      return threadResponse("before-dispatch sweep callback must not run");
    },
  });
  assert.deepEqual((await beforeDispatchSweepStore.recoverExpiredPending()).recovered, [
    integrationIdempotencyPaths(beforeDispatchSweepRoot, beforeDispatchSweepContext).index,
  ]);
  assert.equal(await beforeDispatchSweepStore.inspectRecord(beforeDispatchSweepContext), null);
  assert.equal(beforeDispatchSweepRecoveryCalls, 0);
  const beforeDispatchSweepFresh = await beforeDispatchSweepStore.runMutation(beforeDispatchSweepContext, async () => {
    beforeDispatchSweepSemanticCalls += 1;
    return threadResponse("Fresh after before-dispatch startup sweep");
  });
  assert.equal(beforeDispatchSweepFresh.thread.title, "Fresh after before-dispatch startup sweep");
  assert.equal(beforeDispatchSweepSemanticCalls, 1);

  const beforeDispatchRetentionRoot = path.join(root, "idempotency-before-dispatch-expired-retention");
  const beforeDispatchRetentionContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-before-dispatch-expired-retention"
  );
  await seedExpiredPendingRecord(beforeDispatchRetentionRoot, beforeDispatchRetentionContext, "before-dispatch", {
    expiresAt: past,
  });
  let beforeDispatchRetentionRecoveryCalls = 0;
  let beforeDispatchRetentionSemanticCalls = 0;
  const beforeDispatchRetentionStore = createFileIntegrationIdempotencyStore({
    rootDir: beforeDispatchRetentionRoot,
    pendingLeaseMs: 1000,
    recoverPending: async () => {
      beforeDispatchRetentionRecoveryCalls += 1;
      return threadResponse("before-dispatch retention callback must not run");
    },
  });
  const beforeDispatchRetentionFresh = await beforeDispatchRetentionStore.runMutation(
    beforeDispatchRetentionContext,
    async () => {
      beforeDispatchRetentionSemanticCalls += 1;
      return threadResponse("Fresh after expired before-dispatch retention");
    }
  );
  assert.equal(beforeDispatchRetentionFresh.thread.title, "Fresh after expired before-dispatch retention");
  assert.equal(beforeDispatchRetentionRecoveryCalls, 0);
  assert.equal(beforeDispatchRetentionSemanticCalls, 1);

  const absentReceiptSweepRoot = path.join(root, "idempotency-after-dispatch-null-startup-sweep");
  const absentReceiptSweepContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-after-dispatch-null-startup-sweep"
  );
  await seedExpiredPendingRecord(absentReceiptSweepRoot, absentReceiptSweepContext, "after-dispatch-before-result");
  let absentReceiptSweepRecoveryCalls = 0;
  let absentReceiptSweepSemanticCalls = 0;
  const absentReceiptSweepStore = createFileIntegrationIdempotencyStore({
    rootDir: absentReceiptSweepRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      absentReceiptSweepRecoveryCalls += 1;
      return null;
    },
  });
  assert.deepEqual((await absentReceiptSweepStore.recoverExpiredPending()).recovered, [
    integrationIdempotencyPaths(absentReceiptSweepRoot, absentReceiptSweepContext).index,
  ]);
  assert.equal(await absentReceiptSweepStore.inspectRecord(absentReceiptSweepContext), null);
  assert.equal(absentReceiptSweepRecoveryCalls, 1);
  const absentReceiptSweepFresh = await absentReceiptSweepStore.runMutation(absentReceiptSweepContext, async () => {
    absentReceiptSweepSemanticCalls += 1;
    return threadResponse("Fresh after absent-receipt startup sweep");
  });
  assert.equal(absentReceiptSweepFresh.thread.title, "Fresh after absent-receipt startup sweep");
  assert.equal(absentReceiptSweepSemanticCalls, 1);

  const undefinedReceiptRoot = path.join(root, "idempotency-after-dispatch-undefined-receipt");
  const undefinedReceiptContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-after-dispatch-undefined-receipt"
  );
  await seedExpiredPendingRecord(undefinedReceiptRoot, undefinedReceiptContext, "after-dispatch-before-result");
  let undefinedReceiptRecoveryCalls = 0;
  let undefinedReceiptSemanticCalls = 0;
  const undefinedReceiptStore = createFileIntegrationIdempotencyStore({
    rootDir: undefinedReceiptRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      undefinedReceiptRecoveryCalls += 1;
      return undefined;
    },
  });
  assert.deepEqual((await undefinedReceiptStore.recoverExpiredPending()).recovered, []);
  assert.equal((await undefinedReceiptStore.inspectRecord(undefinedReceiptContext)).recoveryStage, "after-dispatch-before-result");
  await assertRejectsCode(
    () =>
      undefinedReceiptStore.runMutation(undefinedReceiptContext, async () => {
        undefinedReceiptSemanticCalls += 1;
        return threadResponse("undefined receipt must not redispatch");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "undefined after-dispatch recovery remains fail closed"
  );
  assert.equal(undefinedReceiptRecoveryCalls, 2);
  assert.equal(undefinedReceiptSemanticCalls, 0);

  const deadRestartRoot = path.join(root, "idempotency-dead-restart-retention");
  const deadRestartContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-dead-restart-live");
  await seedExpiredPendingRecord(deadRestartRoot, deadRestartContext, "after-dispatch-before-result", { expiresAt: past });
  const deadRestartNoAuthority = createFileIntegrationIdempotencyStore({ rootDir: deadRestartRoot, pendingLeaseMs: 1000 });
  let deadRestartSemanticCalls = 0;
  await assertRejectsCode(
    () =>
      deadRestartNoAuthority.runMutation(deadRestartContext, async () => {
        deadRestartSemanticCalls += 1;
        return threadResponse("must not blind redispatch");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "dead owner retention requires explicit recovery"
  );
  assert.equal(deadRestartSemanticCalls, 0);
  const deadRestartPending = await deadRestartNoAuthority.inspectRecord(deadRestartContext);
  assert.equal(deadRestartPending.state, "pending");
  let deadRestartRecoveryCalls = 0;
  const deadRestartRecoveredResponse = threadResponse("Recovered dead restart");
  const deadRestartAuthority = createFileIntegrationIdempotencyStore({
    rootDir: deadRestartRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async (record) => {
      deadRestartRecoveryCalls += 1;
      assert.equal(record.recoveryStage, "after-dispatch-before-result");
      return deadRestartRecoveredResponse;
    },
  });
  const deadRestartRecovered = await deadRestartAuthority.runMutation(deadRestartContext, async () => {
    deadRestartSemanticCalls += 1;
    return threadResponse("duplicate dead restart");
  });
  assert.deepEqual(deadRestartRecovered, deadRestartRecoveredResponse);
  assert.equal(deadRestartRecoveryCalls, 1);
  assert.equal(deadRestartSemanticCalls, 0);
  assert.equal((await deadRestartAuthority.inspectRecord(deadRestartContext)).state, "completed");

  const deadPruneRoot = path.join(root, "idempotency-dead-prune-recovers");
  const deadPruneContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-dead-prune-main");
  const deadPruneResponse = threadResponse("Recovered by prune");
  await seedExpiredPendingRecord(deadPruneRoot, deadPruneContext, "after-dispatch-before-result", { expiresAt: past });
  let deadPruneRecoveryCalls = 0;
  const deadPruneStore = createFileIntegrationIdempotencyStore({
    rootDir: deadPruneRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async (record) => {
      deadPruneRecoveryCalls += 1;
      assert.equal(record.idempotencyKeyDigest, sha256Text(deadPruneContext.idempotencyKey));
      return deadPruneResponse;
    },
  });
  const deadPruneTrigger = await deadPruneStore.runMutation(
    mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-dead-prune-trig"),
    async () => threadResponse("Dead prune trigger")
  );
  assert.equal(deadPruneTrigger.thread.title, "Dead prune trigger");
  assert.equal(deadPruneRecoveryCalls, 1);
  assert.deepEqual(await deadPruneStore.runMutation(deadPruneContext, async () => threadResponse("wrong dead prune replay")), deadPruneResponse);

  const absentReceiptPruneRoot = path.join(root, "idempotency-dead-prune-absent-receipt");
  const absentReceiptPruneContext = mutationContext(
    INTEGRATION_RPC_PATHS.threadsCreate,
    {},
    "phase3-dead-prune-absent-receipt"
  );
  await seedExpiredPendingRecord(absentReceiptPruneRoot, absentReceiptPruneContext, "after-dispatch-before-result", {
    expiresAt: past,
  });
  let absentReceiptPruneRecoveryCalls = 0;
  let absentReceiptPruneSemanticCalls = 0;
  const absentReceiptPruneStore = createFileIntegrationIdempotencyStore({
    rootDir: absentReceiptPruneRoot,
    pendingLeaseMs: 1000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      absentReceiptPruneRecoveryCalls += 1;
      return null;
    },
  });
  const absentReceiptPruneTrigger = await absentReceiptPruneStore.runMutation(
    mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-dead-prune-absent-trigger"),
    async () => threadResponse("Absent-receipt prune trigger")
  );
  assert.equal(absentReceiptPruneTrigger.thread.title, "Absent-receipt prune trigger");
  assert.equal(absentReceiptPruneRecoveryCalls, 1);
  assert.equal(await absentReceiptPruneStore.inspectRecord(absentReceiptPruneContext), null);
  const absentReceiptPruneFresh = await absentReceiptPruneStore.runMutation(absentReceiptPruneContext, async () => {
    absentReceiptPruneSemanticCalls += 1;
    return threadResponse("Fresh after absent-receipt prune");
  });
  assert.equal(absentReceiptPruneFresh.thread.title, "Fresh after absent-receipt prune");
  assert.equal(absentReceiptPruneRecoveryCalls, 1);
  assert.equal(absentReceiptPruneSemanticCalls, 1);

  const unknownRetentionRoot = path.join(root, "idempotency-unknown-retention");
  const unknownRetentionContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-unknown-retent");
  await seedExpiredPendingRecord(unknownRetentionRoot, unknownRetentionContext, "after-dispatch-before-result", { expiresAt: past });
  const unknownRetentionStore = createFileIntegrationIdempotencyStore({
    rootDir: unknownRetentionRoot,
    pendingLeaseMs: 1000,
    processOwnerTestHooks: {
      processIdentityForPid: async () => undefined,
    },
  });
  let unknownRetentionSemanticCalls = 0;
  await assertRejectsCode(
    () =>
      unknownRetentionStore.runMutation(unknownRetentionContext, async () => {
        unknownRetentionSemanticCalls += 1;
        return threadResponse("must not dispatch unknown liveness");
      }),
    "IDEMPOTENCY_RECOVERY_REQUIRED",
    "unknown owner liveness fails closed"
  );
  assert.equal(unknownRetentionSemanticCalls, 0);
  assert.equal((await unknownRetentionStore.inspectRecord(unknownRetentionContext)).state, "pending");

  const liveSlowRoot = path.join(root, "idempotency-live-slow-owner");
  const liveSlowA = createFileIntegrationIdempotencyStore({ rootDir: liveSlowRoot, pendingLeaseMs: 100, lockWaitMs: 3000 });
  let liveSlowRecoveryCalls = 0;
  const liveSlowB = createFileIntegrationIdempotencyStore({
    rootDir: liveSlowRoot,
    pendingLeaseMs: 100,
    lockWaitMs: 3000,
    recoveryAuthority: fullRecoveryAuthority(),
    recoverPending: async () => {
      liveSlowRecoveryCalls += 1;
      return threadResponse("live owner must not recover");
    },
  });
  const liveSlowContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-live-slow-owner");
  let liveSlowSemanticCalls = 0;
  const liveSlowFirst = liveSlowA.runMutation(liveSlowContext, async () => {
    liveSlowSemanticCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return threadResponse("Live slow owner");
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const liveSlowSecond = await liveSlowB.runMutation(liveSlowContext, async () => {
    liveSlowSemanticCalls += 1;
    return threadResponse("duplicate live slow");
  });
  const liveSlowOriginal = await liveSlowFirst;
  assert.deepEqual(liveSlowSecond, liveSlowOriginal);
  assert.equal(liveSlowSemanticCalls, 1);
  assert.equal(liveSlowRecoveryCalls, 0);

  const livePruneRoot = path.join(root, "idempotency-live-pending-retention-prune");
  const livePruneA = createFileIntegrationIdempotencyStore({
    rootDir: livePruneRoot,
    retentionMs: 1000,
    pendingLeaseMs: 100,
    lockWaitMs: 5000,
  });
  const livePruneB = createFileIntegrationIdempotencyStore({
    rootDir: livePruneRoot,
    retentionMs: 1000,
    pendingLeaseMs: 100,
    lockWaitMs: 5000,
  });
  const livePruneContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-live-prune-owner");
  let livePruneStarted = false;
  let livePruneSemanticCalls = 0;
  const livePruneFirst = livePruneA.runMutation(livePruneContext, async () => {
    livePruneStarted = true;
    livePruneSemanticCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    return threadResponse("Live pending survived prune");
  });
  await waitFor(() => livePruneStarted, "live retention-prune handler did not start");
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const livePruneTrigger = await livePruneB.runMutation(
    mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-live-prune-trigger"),
    async () => threadResponse("Retention prune trigger")
  );
  assert.equal(livePruneTrigger.thread.title, "Retention prune trigger");
  const livePrunePending = await livePruneB.inspectRecord(livePruneContext);
  if (livePrunePending?.state === "pending") {
    assert.equal(Date.parse(livePrunePending.expiresAt) > Date.now(), true);
    assert.equal(Date.parse(livePrunePending.leaseExpiresAt) > Date.now(), true);
  }
  const livePruneOriginal = await livePruneFirst;
  assert.equal(livePruneOriginal.thread.title, "Live pending survived prune");
  assert.equal(livePruneSemanticCalls, 1);
  assert.deepEqual(
    await livePruneB.runMutation(livePruneContext, async () => {
      livePruneSemanticCalls += 1;
      return threadResponse("duplicate live retention prune");
    }),
    livePruneOriginal
  );
  assert.equal(livePruneSemanticCalls, 1);

  const sameKeyRetentionRoot = path.join(root, "idempotency-same-key-retention-live");
  const sameKeyRetentionA = createFileIntegrationIdempotencyStore({
    rootDir: sameKeyRetentionRoot,
    retentionMs: 1000,
    pendingLeaseMs: 100,
    lockWaitMs: 5000,
  });
  const sameKeyRetentionB = createFileIntegrationIdempotencyStore({
    rootDir: sameKeyRetentionRoot,
    retentionMs: 1000,
    pendingLeaseMs: 100,
    lockWaitMs: 5000,
  });
  const sameKeyRetentionContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-same-key-live");
  let sameKeyRetentionStarted = false;
  let sameKeyRetentionCalls = 0;
  const sameKeyRetentionFirst = sameKeyRetentionA.runMutation(sameKeyRetentionContext, async () => {
    sameKeyRetentionStarted = true;
    sameKeyRetentionCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    return threadResponse("Same key live retention");
  });
  await waitFor(() => sameKeyRetentionStarted, "same-key retention handler did not start");
  await new Promise((resolve) => setTimeout(resolve, 1150));
  let sameKeyRetryResolved = false;
  const sameKeyRetry = sameKeyRetentionB
    .runMutation(sameKeyRetentionContext, async () => {
      sameKeyRetentionCalls += 1;
      return threadResponse("duplicate same-key live retention");
    })
    .then((value) => {
      sameKeyRetryResolved = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sameKeyRetentionCalls, 1);
  assert.equal(sameKeyRetryResolved, false);
  const sameKeyRetentionOriginal = await sameKeyRetentionFirst;
  assert.equal(sameKeyRetentionOriginal.thread.title, "Same key live retention");
  assert.deepEqual(await sameKeyRetry, sameKeyRetentionOriginal);
  assert.equal(sameKeyRetentionCalls, 1);

  const blockedOwnerRoot = path.join(root, "idempotency-blocked-live-owner");
  const blockedOwnerCounter = path.join(root, "blocked-live-owner-counter.txt");
  const blockedOwnerStarted = path.join(root, "blocked-live-owner-started.txt");
  const blockedOwnerContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-blocked-live");
  const blockedOwnerResponse = threadResponse("Blocked live owner");
  const blockedOwnerScript = `
    import fs from "node:fs/promises";
    import { createFileIntegrationIdempotencyStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/integration-idempotency-store.js")).href)};
    const rootDir = process.argv[2];
    const counter = process.argv[3];
    const started = process.argv[4];
    const context = JSON.parse(process.argv[5]);
    const response = JSON.parse(process.argv[6]);
    const store = createFileIntegrationIdempotencyStore({ rootDir, retentionMs: 1000, pendingLeaseMs: 100, lockWaitMs: 5000 });
    await store.runMutation(context, async () => {
      await fs.appendFile(counter, "hit\\n", "utf8");
      await fs.writeFile(started, "started\\n", "utf8");
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {}
      return response;
    });
  `;
  const blockedOwnerChild = spawnNodeInline(blockedOwnerScript, [
    blockedOwnerRoot,
    blockedOwnerCounter,
    blockedOwnerStarted,
    JSON.stringify(blockedOwnerContext),
    JSON.stringify(blockedOwnerResponse),
  ]);
  await waitForFile(blockedOwnerStarted, "blocked live owner child did not start", 2000);
  await new Promise((resolve) => setTimeout(resolve, 1150));
  const blockedOwnerRetryStore = createFileIntegrationIdempotencyStore({
    rootDir: blockedOwnerRoot,
    retentionMs: 1000,
    pendingLeaseMs: 100,
    lockWaitMs: 5000,
  });
  let blockedOwnerRetryResolved = false;
  let blockedOwnerDuplicateCalls = 0;
  const blockedOwnerRetry = blockedOwnerRetryStore
    .runMutation(blockedOwnerContext, async () => {
      blockedOwnerDuplicateCalls += 1;
      await fs.appendFile(blockedOwnerCounter, "duplicate\\n", "utf8");
      return threadResponse("duplicate blocked live owner");
    })
    .then((value) => {
      blockedOwnerRetryResolved = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(blockedOwnerRetryResolved, false);
  assert.equal(blockedOwnerDuplicateCalls, 0);
  await blockedOwnerChild.done;
  assert.deepEqual(await blockedOwnerRetry, blockedOwnerResponse);
  assert.equal(blockedOwnerDuplicateCalls, 0);
  const blockedOwnerHits = (await fs.readFile(blockedOwnerCounter, "utf8")).trim().split("\\n").filter(Boolean);
  assert.deepEqual(blockedOwnerHits, ["hit"]);

  const abaRoot = path.join(root, "idempotency-aba-expired-prune");
  let abaNowMs = Date.parse(AT);
  const abaNow = () => new Date(abaNowMs);
  const abaContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-aba-expired-key");
  const abaSeed = createFileIntegrationIdempotencyStore({
    rootDir: abaRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: abaNow,
  });
  await abaSeed.runMutation(abaContext, async () => threadResponse("ABA old record"));
  abaNowMs += 1001;
  let releaseAbaPrune;
  const abaPruneGate = new Promise((resolve) => {
    releaseAbaPrune = resolve;
  });
  let abaPruneRead = false;
  const abaPruner = createFileIntegrationIdempotencyStore({
    rootDir: abaRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: abaNow,
    faultInjector: async ({ phase, record }) => {
      if (phase === "prune-expired-record-read" && record.keyDigest === sha256Text(abaContext.idempotencyKey)) {
        abaPruneRead = true;
        await abaPruneGate;
      }
    },
  });
  const abaTrigger = abaPruner.runMutation(
    mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-aba-prune-trigger"),
    async () => threadResponse("ABA prune trigger")
  );
  await waitFor(() => abaPruneRead, "ABA prune read hook did not run");
  let abaSemanticCalls = 0;
  let abaHandlerStarted = false;
  const abaCaller = createFileIntegrationIdempotencyStore({
    rootDir: abaRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: abaNow,
  });
  const abaCall = abaCaller.runMutation(abaContext, async () => {
    abaHandlerStarted = true;
    abaSemanticCalls += 1;
    return threadResponse("ABA new record");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(abaHandlerStarted, false);
  releaseAbaPrune();
  assert.equal((await abaTrigger).thread.title, "ABA prune trigger");
  const abaResult = await abaCall;
  assert.equal(abaResult.thread.title, "ABA new record");
  assert.equal(abaSemanticCalls, 1);
  assert.deepEqual(
    await abaCaller.runMutation(abaContext, async () => {
      abaSemanticCalls += 1;
      return threadResponse("duplicate ABA replay");
    }),
    abaResult
  );
  assert.equal(abaSemanticCalls, 1);

  const replayExpiryRoot = path.join(root, "idempotency-live-replay-at-expiry");
  const replayExpiryContext = mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-replay-expiry-key");
  const replaySeedNowMs = Date.parse(AT);
  const replaySeed = createFileIntegrationIdempotencyStore({
    rootDir: replayExpiryRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: () => new Date(replaySeedNowMs),
  });
  const replayExpected = await replaySeed.runMutation(replayExpiryContext, async () => threadResponse("Replay before expiry"));
  let releaseReplayLoad;
  const replayLoadGate = new Promise((resolve) => {
    releaseReplayLoad = resolve;
  });
  let replayLoadEntered = false;
  const replayStore = createFileIntegrationIdempotencyStore({
    rootDir: replayExpiryRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: () => new Date(replaySeedNowMs + 999),
    faultInjector: async ({ phase, record }) => {
      if (phase === "response-load-before-read" && record.keyDigest === sha256Text(replayExpiryContext.idempotencyKey)) {
        replayLoadEntered = true;
        await replayLoadGate;
      }
    },
  });
  let replayExpirySemanticCalls = 0;
  const replayInFlight = replayStore.runMutation(replayExpiryContext, async () => {
    replayExpirySemanticCalls += 1;
    return threadResponse("must not dispatch replay-at-expiry");
  });
  await waitFor(() => replayLoadEntered, "replay-at-expiry response load hook did not run");
  let replayPruneCompleted = false;
  const replayPruner = createFileIntegrationIdempotencyStore({
    rootDir: replayExpiryRoot,
    retentionMs: 1000,
    pendingLeaseMs: 1000,
    lockWaitMs: 5000,
    now: () => new Date(replaySeedNowMs + 1001),
  });
  const replayPrune = replayPruner
    .runMutation(
      mutationContext(INTEGRATION_RPC_PATHS.threadsCreate, {}, "phase3-replay-prune-trigger"),
      async () => threadResponse("Replay prune trigger")
    )
    .then((value) => {
      replayPruneCompleted = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(replayPruneCompleted, false);
  releaseReplayLoad();
  assert.deepEqual(await replayInFlight, replayExpected);
  assert.equal(replayExpirySemanticCalls, 0);
  assert.equal((await replayPrune).thread.title, "Replay prune trigger");

  const wrongModeRoot = path.join(root, "idempotency-wrong-mode");
  await fs.mkdir(wrongModeRoot, { recursive: true, mode: 0o755 });
  await fs.chmod(wrongModeRoot, 0o755);
  const wrongModeStore = createFileIntegrationIdempotencyStore({ rootDir: wrongModeRoot });
  await assertRejectsCode(() => wrongModeStore.runMutation(context, async () => threadResponse()), "INTEGRATION_AUTHORITY_UNAVAILABLE", "wrong root mode");

  for (const [label, mutate, expectedCode = "INTEGRATION_AUTHORITY_CORRUPT"] of [
    ["record symlink", async (recordPath) => {
      await fs.rm(recordPath, { force: true });
      await fs.symlink(path.join(root, "target.json"), recordPath);
    }],
    ["record hardlink", async (recordPath) => {
      await fs.link(recordPath, path.join(path.dirname(recordPath), "hardlink.json"));
    }],
    ["record wrong mode", async (recordPath) => {
      await fs.chmod(recordPath, 0o644);
    }],
    ["record corrupt", async (recordPath) => {
      await fs.writeFile(recordPath, "{", { mode: 0o600 });
    }],
    ["record future schema", async (recordPath) => {
      const current = await store.inspectRecord(context);
      await atomicWriteProtectedJson(recordPath, createSealedIntegrationIdempotencyRecord({ ...current, schemaVersion: "future-v999" }));
    }, "IDEMPOTENCY_STORE_CORRUPT"],
  ]) {
    const badRoot = path.join(root, `idempotency-${label.replaceAll(" ", "-")}`);
    const badStore = createFileIntegrationIdempotencyStore({ rootDir: badRoot });
    await badStore.runMutation(context, async () => threadResponse());
    const badPaths = badStore.pathsForRequest(context);
    await mutate(badPaths.record);
    await assertRejectsCode(() => badStore.runMutation(context, async () => threadResponse()), expectedCode, label);
  }
}

async function smokeEventLedger(root) {
  const ledgerRoot = path.join(root, "events");
  const store = createFileIntegrationEventLedgerStore({ rootDir: ledgerRoot, maxEvents: 16 });
  const scope = { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, browserSessionPolicy: "same-browser-session", threadId, runId };
  const cloudPrincipalEventScope = { ...scope, principalId: CLOUD_GRAMMAR_PRINCIPAL, runId: uuidId("run") };
  const cloudPrincipalEvent = await store.appendPublicEvent(cloudPrincipalEventScope, {
    type: "output.delta",
    payload: { text: "Cloud grammar principal event" },
    createdAt: AT,
  });
  assert.equal(cloudPrincipalEvent.seq, 1);
  await assertRejectsCode(
    () => store.appendPublicEvent({ ...scope, browserSessionId: "", browserSessionPolicy: "" }, { type: "output.delta", payload: { text: "Unbound" }, createdAt: AT }),
    "PUBLIC_EVENT_LEDGER_SCOPE_INVALID",
    "event ledger requires canonical browser binding"
  );
  const first = await store.appendPublicEvent(scope, {
    type: "output.delta",
    payload: { text: "Public output" },
    createdAt: AT,
  });
  const terminal = await store.appendPublicEvent(scope, {
    type: "run.completed",
    payload: {},
    createdAt: AT,
  });
  assert.equal(first.seq, 1);
  assert.equal(terminal.seq, 2);
  await assertRejectsCode(
    () => store.appendPublicEvent(scope, { type: "run.completed", payload: {}, createdAt: AT }),
    "PUBLIC_EVENT_LEDGER_CORRUPT",
    "terminal once"
  );
  const restarted = createFileIntegrationEventLedgerStore({ rootDir: ledgerRoot, maxEvents: 16 });
  const replayed = await loadPublicIntegrationEvents({
    ...scope,
    eventSource: restarted.ledgerForRun(scope),
    afterSeq: 0,
    afterHash: ZERO_DIGEST,
  });
  assert.deepEqual(replayed.map((event) => event.seq), [1, 2]);
  assertNoRawLeak(replayed);
  const replayedAfterFirst = await loadPublicIntegrationEvents({
    ...scope,
    eventSource: restarted.ledgerForRun(scope),
    afterSeq: 1,
    afterHash: first.hash,
  });
  assert.deepEqual(replayedAfterFirst.map((event) => event.seq), [2]);
  await assertRejectsCode(
    () =>
      loadPublicIntegrationEvents({
        ...scope,
        eventSource: restarted.ledgerForRun(scope),
        afterSeq: 1,
        afterHash: "1".repeat(64),
      }),
    "INVALID_EVENT_CURSOR",
    "event cursor hash mismatch"
  );
  const wrongPreviousScope = { ...scope, runId: uuidId("run") };
  const wrongPreviousFirst = await store.appendPublicEvent(wrongPreviousScope, {
    type: "output.delta",
    payload: { text: "First cursor event" },
    createdAt: AT,
  });
  const wrongPreviousSecond = createPublicIntegrationEvent({
    threadId,
    runId: wrongPreviousScope.runId,
    seq: 2,
    type: "output.delta",
    payload: { text: "Wrong previous hash" },
    createdAt: AT,
    previousHash: ZERO_DIGEST,
  });
  await assertRejectsCode(
    () =>
      loadPublicIntegrationEvents({
        ...wrongPreviousScope,
        eventSource: {
          ...store.ledgerForRun(wrongPreviousScope),
          loadEventsAfter: async () => [wrongPreviousSecond],
        },
        afterSeq: 1,
        afterHash: wrongPreviousFirst.hash,
      }),
    "PUBLIC_EVENT_LEDGER_CORRUPT",
    "first resumed event previousHash mismatch"
  );
  await assertRejectsCode(
    () =>
      loadPublicIntegrationEvents({
        ...scope,
        principalId: OTHER_PRINCIPAL,
        eventSource: restarted.ledgerForRun(scope),
        afterSeq: 0,
        afterHash: ZERO_DIGEST,
      }),
    "NOT_FOUND",
    "cross-owner event replay"
  );
  const boundScope = { ...scope, runId: uuidId("run") };
  await store.appendPublicEvent(boundScope, { type: "output.delta", payload: { text: "Bound output" }, createdAt: AT });
  const lockedReadScope = { ...scope, runId: uuidId("run") };
  await store.appendPublicEvent(lockedReadScope, { type: "output.delta", payload: { text: "Locked read output" }, createdAt: AT });
  const lockedReadPaths = store.pathsForRun(lockedReadScope);
  let lockedReadResolved = false;
  let pendingLockedRead;
  await withDirectoryLock(
    lockedReadPaths.lock,
    async () => {
      pendingLockedRead = store.load(lockedReadScope).then((ledger) => {
        lockedReadResolved = true;
        return ledger;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(lockedReadResolved, false);
    },
    { waitMs: 1000, staleMs: 60_000 }
  );
  const lockedReadLedger = await pendingLockedRead;
  assert.equal(lockedReadResolved, true);
  assert.equal(lockedReadLedger.cursor.lastSeq, 1);
  await assertRejectsCode(
    () =>
      loadPublicIntegrationEvents({
        ...boundScope,
        browserSessionId: OTHER_BROWSER_SESSION,
        eventSource: store.ledgerForRun(boundScope),
        afterSeq: 0,
        afterHash: ZERO_DIGEST,
      }),
    "NOT_FOUND",
    "cross-browser event replay"
  );
  for (const [label, overrides] of [
    ["contradictory event browser aliases", { ownerBrowserSessionId: OTHER_BROWSER_SESSION }],
    ["malformed event browser alias", { ownerBrowserSessionId: "A".repeat(64) }],
    ["unknown event browser policy", { browserSessionPolicy: "shared-browser-session" }],
  ]) {
    await assertRejectsCode(
      () =>
        loadPublicIntegrationEvents({
          ...boundScope,
          eventSource: { ...store.ledgerForRun(boundScope), ...overrides },
          afterSeq: 0,
          afterHash: ZERO_DIGEST,
        }),
      "NOT_FOUND",
      label
    );
  }
  await assertRejectsCode(
    () =>
      store.appendPublicEvent({ ...scope, runId: uuidId("run") }, {
        type: "output.delta",
        payload: { text: "token=secret /home/aginti/private" },
        createdAt: AT,
      }),
    "UNSAFE_PRESENTATION",
    "raw event leakage"
  );

  const firstTooLargeRoot = path.join(root, "events-first-too-large");
  const firstTooLargeStore = createFileIntegrationEventLedgerStore({ rootDir: firstTooLargeRoot, maxEvents: 8, maxBytes: 4096 });
  const firstTooLargeScope = { ...scope, runId: uuidId("run") };
  const firstTooLargePaths = firstTooLargeStore.pathsForRun(firstTooLargeScope);
  await assertRejectsCode(
    () =>
      firstTooLargeStore.appendPublicEvent(firstTooLargeScope, {
        type: "output.delta",
        payload: { text: "x".repeat(4000) },
        createdAt: AT,
      }),
    "PUBLIC_EVENT_LEDGER_FULL",
    "first append over byte cap"
  );
  await fs.access(firstTooLargePaths.ledger).then(
    () => assert.fail("oversized first append must not leave a durable ledger header"),
    (error) => assert.equal(error.code, "ENOENT")
  );
  assert.throws(
    () => createFileIntegrationEventLedgerStore({ rootDir: path.join(root, "events-config-over-cap"), maxBytes: 16 * 1024 * 1024 + 1 }),
    /byte cap/u
  );

  const pagedRoot = path.join(root, "events-paged");
  const pagedStore = createFileIntegrationEventLedgerStore({ rootDir: pagedRoot, maxEvents: 140, maxBytes: 512 * 1024 });
  const pagedScope = { ...scope, runId: uuidId("run") };
  let previousHash = ZERO_DIGEST;
  for (let seq = 1; seq <= 129; seq += 1) {
    const event = await pagedStore.appendPublicEvent(pagedScope, {
      type: "output.delta",
      payload: { text: `page ${seq}` },
      createdAt: AT,
    });
    assert.equal(event.seq, seq);
    assert.equal(event.previousHash, previousHash);
    previousHash = event.hash;
  }
  const firstPage = await loadPublicIntegrationEvents({
    ...pagedScope,
    eventSource: pagedStore.ledgerForRun(pagedScope),
    afterSeq: 0,
    afterHash: ZERO_DIGEST,
  });
  assert.equal(firstPage.length, 128);
  assert.equal(firstPage[0].seq, 1);
  assert.equal(firstPage[127].seq, 128);
  const secondPage = await loadPublicIntegrationEvents({
    ...pagedScope,
    eventSource: pagedStore.ledgerForRun(pagedScope),
    afterSeq: 128,
    afterHash: firstPage[127].hash,
  });
  assert.equal(secondPage.length, 1);
  assert.equal(secondPage[0].seq, 129);

  const noPruneRoot = path.join(root, "events-v1-no-prune");
  const noPruneStore = createFileIntegrationEventLedgerStore({ rootDir: noPruneRoot, maxEvents: 2, maxBytes: 64 * 1024 });
  const noPruneScope = { ...scope, runId: uuidId("run") };
  const noPruneOne = await noPruneStore.appendPublicEvent(noPruneScope, {
    type: "output.delta",
    payload: { text: "no prune one" },
    createdAt: AT,
  });
  const noPruneTwo = await noPruneStore.appendPublicEvent(noPruneScope, {
    type: "output.delta",
    payload: { text: "no prune two" },
    createdAt: AT,
  });
  const noPruneBeforeReject = await noPruneStore.load(noPruneScope);
  await assertRejectsCode(
    () =>
      noPruneStore.appendPublicEvent(noPruneScope, {
        type: "output.delta",
        payload: { text: "must fail full" },
        createdAt: AT,
      }),
    "PUBLIC_EVENT_LEDGER_FULL",
    "v1 ledger fills instead of pruning"
  );
  const noPruneAfterReject = await noPruneStore.load(noPruneScope);
  assert.equal(noPruneAfterReject.cursor.lastSeq, noPruneBeforeReject.cursor.lastSeq);
  assert.equal(noPruneAfterReject.cursor.lastHash, noPruneBeforeReject.cursor.lastHash);
  const noPruneRestarted = createFileIntegrationEventLedgerStore({ rootDir: noPruneRoot, maxEvents: 2, maxBytes: 64 * 1024 });
  const noPruneReplay = await loadPublicIntegrationEvents({
    ...noPruneScope,
    eventSource: noPruneRestarted.ledgerForRun(noPruneScope),
    afterSeq: 0,
    afterHash: ZERO_DIGEST,
  });
  assert.deepEqual(noPruneReplay.map((event) => event.seq), [1, 2]);
  assert.equal(noPruneReplay[0].hash, noPruneOne.hash);
  assert.equal(noPruneReplay[1].hash, noPruneTwo.hash);

  const byteRoot = path.join(root, "events-byte-bound");
  const byteScope = { ...scope, runId: uuidId("run") };
  const byteSeed = createFileIntegrationEventLedgerStore({ rootDir: byteRoot, maxEvents: 8, maxBytes: 64 * 1024 });
  const byteFirst = await byteSeed.appendPublicEvent(byteScope, {
    type: "output.delta",
    payload: { text: "seed" },
    createdAt: AT,
  });
  const bytePaths = byteSeed.pathsForRun(byteScope);
  const currentBytes = Buffer.byteLength(await fs.readFile(bytePaths.ledger, "utf8"));
  let byteSecond = null;
  let exactMaxBytes = 0;
  for (let size = 100; size <= 4000; size += 100) {
    const candidate = createPublicIntegrationEvent({
      threadId,
      runId: byteScope.runId,
      seq: 2,
      type: "output.delta",
      payload: { text: "x".repeat(size) },
      createdAt: AT,
      previousHash: byteFirst.hash,
    });
    const candidateMax = currentBytes + Buffer.byteLength(`${JSON.stringify(candidate)}\n`);
    if (candidateMax >= 4096) {
      byteSecond = candidate;
      exactMaxBytes = candidateMax;
      break;
    }
  }
  assert.ok(byteSecond, "byte-bound test should find an exact-at event");
  const belowStore = createFileIntegrationEventLedgerStore({ rootDir: byteRoot, maxEvents: 8, maxBytes: exactMaxBytes - 1 });
  const belowRaw = await fs.readFile(bytePaths.ledger, "utf8");
  await assertRejectsCode(
    () => belowStore.appendExactPublicEvent(byteScope, byteSecond),
    "PUBLIC_EVENT_LEDGER_FULL",
    "ledger just-below byte cap"
  );
  assert.equal(await fs.readFile(bytePaths.ledger, "utf8"), belowRaw);
  const exactStore = createFileIntegrationEventLedgerStore({ rootDir: byteRoot, maxEvents: 8, maxBytes: exactMaxBytes });
  await exactStore.appendExactPublicEvent(byteScope, byteSecond);
  const exactLoaded = await exactStore.load(byteScope);
  assert.equal(exactLoaded.cursor.lastSeq, 2);
  const byteThird = createPublicIntegrationEvent({
    threadId,
    runId: byteScope.runId,
    seq: 3,
    type: "output.delta",
    payload: { text: "z" },
    createdAt: AT,
    previousHash: byteSecond.hash,
  });
  const overRaw = await fs.readFile(bytePaths.ledger, "utf8");
  const overStore = createFileIntegrationEventLedgerStore({
    rootDir: byteRoot,
    maxEvents: 8,
    maxBytes: Buffer.byteLength(overRaw) + Buffer.byteLength(`${JSON.stringify(byteThird)}\n`) - 1,
  });
  await assertRejectsCode(
    () => overStore.appendExactPublicEvent(byteScope, byteThird),
    "PUBLIC_EVENT_LEDGER_FULL",
    "ledger one-byte-over cap"
  );
  assert.equal(await fs.readFile(bytePaths.ledger, "utf8"), overRaw);
  const afterRejected = await exactStore.load(byteScope);
  assert.equal(afterRejected.cursor.lastSeq, 2);
  assert.equal(afterRejected.cursor.lastHash, byteSecond.hash);

  const corruptScope = { ...scope, runId: uuidId("run") };
  const one = createPublicIntegrationEvent({
    threadId,
    runId: corruptScope.runId,
    seq: 1,
    type: "output.delta",
    payload: { text: "One" },
    createdAt: AT,
    previousHash: ZERO_DIGEST,
  });
  const two = createPublicIntegrationEvent({
    threadId,
    runId: corruptScope.runId,
    seq: 2,
    type: "output.delta",
    payload: { text: "Two" },
    createdAt: AT,
    previousHash: one.hash,
  });
  for (const [label, lines] of [
    ["gap", [two]],
    ["reorder", [two, one]],
  ]) {
    const badRoot = path.join(root, `events-${label}`);
    const badStore = createFileIntegrationEventLedgerStore({ rootDir: badRoot });
    const paths = integrationEventLedgerPaths(badRoot, corruptScope);
    await fs.mkdir(path.dirname(paths.ledger), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
    const header = sealObject(
      {
        schemaVersion: INTEGRATION_EVENT_LEDGER_HEADER_SCHEMA_VERSION,
        owner: "aginti",
        authority: "aginti",
        mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
        principalId: corruptScope.principalId,
        browserSessionId: corruptScope.browserSessionId,
        browserSessionPolicy: corruptScope.browserSessionPolicy,
        threadId,
        runId: corruptScope.runId,
        createdAt: AT,
      },
      INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN
    );
    await fs.writeFile(paths.ledger, `${[header, ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
    await assertRejectsCode(() => badStore.load(corruptScope), "PUBLIC_EVENT_LEDGER_CORRUPT", label);
  }

  for (const [label, mutate, expectedCode = "INTEGRATION_AUTHORITY_CORRUPT"] of [
    ["ledger symlink", async (ledgerPath) => {
      await fs.rm(ledgerPath, { force: true });
      await fs.symlink(path.join(root, "target-ledger"), ledgerPath);
    }],
    ["ledger hardlink", async (ledgerPath) => {
      await fs.link(ledgerPath, path.join(path.dirname(ledgerPath), "hardlink.jsonl"));
    }],
    ["ledger wrong mode", async (ledgerPath) => {
      await fs.chmod(ledgerPath, 0o644);
    }],
    ["ledger corrupt", async (ledgerPath) => {
      await fs.writeFile(ledgerPath, "{", { mode: 0o600 });
    }, "PUBLIC_EVENT_LEDGER_CORRUPT"],
    ["ledger future schema", async (ledgerPath) => {
      const futureHeader = sealObject(
        {
          schemaVersion: "future-v999",
          owner: "aginti",
          authority: "aginti",
          mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
          browserSessionPolicy: scope.browserSessionPolicy,
          threadId,
          runId,
          createdAt: AT,
        },
        INTEGRATION_EVENT_LEDGER_HEADER_INTEGRITY_DOMAIN
      );
      await fs.writeFile(ledgerPath, `${JSON.stringify(futureHeader)}\n`, { mode: 0o600 });
    }, "PUBLIC_EVENT_LEDGER_UNAVAILABLE"],
  ]) {
    const badRoot = path.join(root, `events-${label.replaceAll(" ", "-")}`);
    const badStore = createFileIntegrationEventLedgerStore({ rootDir: badRoot });
    await badStore.appendPublicEvent(scope, { type: "output.delta", payload: { text: label }, createdAt: AT });
    const paths = badStore.pathsForRun(scope);
    await mutate(paths.ledger);
    await assertRejectsCode(() => badStore.load(scope), expectedCode, label);
  }
}

async function smokeSessionAdapterAndApi(root) {
  const eventStore = createFileIntegrationEventLedgerStore({ rootDir: path.join(root, "adapter-events") });
  await assertRejectsCode(
    async () => createNativeIntegrationSessionService({ eventLedgerStore: eventStore }).getIntegrationCapabilities(),
    "AGENT_UNAVAILABLE",
    "missing runtime authority"
  );
  const falseHostedService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([], { proof: { ...runtimeProof(), noHostedProviders: false } }),
    eventLedgerStore: eventStore,
  });
  const falseHostedCapabilities = await falseHostedService.getIntegrationCapabilities();
  assert.equal(falseHostedCapabilities.nativeIntegrationAuthority.noHostedProviders, false);
  const missingEventStoreService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([]),
  });
  const missingEventStoreCapabilities = await missingEventStoreService.getIntegrationCapabilities();
  assert.equal(missingEventStoreCapabilities.nativeIntegrationAuthority.eventLedgerPersisted, false);
  const malformedEventStoreService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([]),
    eventLedgerStore: {
      owner: "aginti",
      async attest() {
        return {
          schemaVersion: "aginti-public-integration-event-ledger-attestation-v1",
          owner: "aginti",
          authority: "aginti",
          durable: true,
          persisted: true,
          contiguous: true,
          monotonic: true,
          bridgeOwned: false,
          mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
          maxEvents: 1,
          maxBytes: 4096,
          digest: ZERO_DIGEST,
        };
      },
    },
  });
  const malformedEventStoreCapabilities = await malformedEventStoreService.getIntegrationCapabilities();
  assert.equal(malformedEventStoreCapabilities.nativeIntegrationAuthority.eventLedgerPersisted, false);
  const inheritedSemanticRuntime = makeRuntime([]);
  Object.setPrototypeOf(inheritedSemanticRuntime, {
    plan() {
      throw new Error("semantic adapter method must not be reachable");
    },
  });
  await assertRejectsCode(
    () =>
      createNativeIntegrationSessionService({
        runtimeAuthority: inheritedSemanticRuntime,
        eventLedgerStore: eventStore,
      }).getIntegrationCapabilities(),
    "AGENT_UNAVAILABLE",
    "inherited semantic adapter method rejected"
  );

  const directCalls = [];
  const service = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(directCalls),
    eventLedgerStore: eventStore,
  });
  const context = { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, policy: {}, abortSignal: undefined };
  const created = await service.createThread({ title: "Native thread" }, context);
  assert.equal(created.thread.id, threadId);
  assertNoRawLeak(created);

  for (const [label, threadOverride] of [
    ["missing bound same-browser-session thread", { browserSessionPolicy: "same-browser-session", browserSessionId: undefined }],
    ["unbound thread", { browserSessionPolicy: undefined, browserSessionId: undefined }],
    ["invalid bound same-browser-session thread", { browserSessionPolicy: "same-browser-session", browserSessionId: "not-lowercase-hex" }],
    [
      "contradictory same-browser-session thread",
      { browserSessionPolicy: "same-browser-session", browserSessionId: BROWSER_SESSION, ownerBrowserSessionId: OTHER_BROWSER_SESSION },
    ],
    ["unknown browser-session thread policy", { browserSessionPolicy: "shared-browser-session", browserSessionId: BROWSER_SESSION }],
  ]) {
    const bindingCalls = [];
    const bindingService = createNativeIntegrationSessionService({
      runtimeAuthority: makeRuntime(bindingCalls, { thread: threadOverride }),
      eventLedgerStore: eventStore,
    });
    await assertRejectsCode(() => bindingService.getThread({ threadId }, context), "NOT_FOUND", label);
  }

  const conflictingThreadCalls = [];
  const conflictingThreadService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(conflictingThreadCalls, {
      thread: {
        browserSessionPolicy: "same-browser-session",
        browserSessionId: BROWSER_SESSION,
        ownerBrowserSessionId: OTHER_BROWSER_SESSION,
      },
    }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(
    () => conflictingThreadService.updateThread({ threadId, title: "Unauthorized" }, context),
    "NOT_FOUND",
    "contradictory updateThread precheck"
  );
  await assertRejectsCode(
    () => conflictingThreadService.deleteThread({ threadId }, context),
    "NOT_FOUND",
    "contradictory deleteThread precheck"
  );
  await assertRejectsCode(
    () => conflictingThreadService.startRun({ threadId, input: { text: "Unauthorized" } }, context),
    "NOT_FOUND",
    "contradictory startRun precheck"
  );
  assert.equal(conflictingThreadCalls.filter((call) => call.method === "updateIntegrationThread").length, 0);
  assert.equal(conflictingThreadCalls.filter((call) => call.method === "deleteIntegrationThread").length, 0);
  assert.equal(conflictingThreadCalls.filter((call) => call.method === "startIntegrationRun").length, 0);

  const unboundThreadMutationCalls = [];
  const unboundThreadMutationService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(unboundThreadMutationCalls, {
      thread: { browserSessionPolicy: undefined, browserSessionId: undefined, activeBrowserSessionId: undefined },
    }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(
    () => unboundThreadMutationService.updateThread({ threadId, title: "Unauthorized" }, context),
    "NOT_FOUND",
    "unbound browser updateThread precheck"
  );
  assert.equal(unboundThreadMutationCalls.filter((call) => call.method === "updateIntegrationThread").length, 0);

  const threadMutationCalls = [];
  const browserBoundThreadService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(threadMutationCalls, {
      thread: { browserSessionPolicy: "same-browser-session", browserSessionId: BROWSER_SESSION },
    }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(
    () => browserBoundThreadService.updateThread({ threadId, title: "Unauthorized" }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "cross-browser updateThread precheck"
  );
  await assertRejectsCode(
    () => browserBoundThreadService.deleteThread({ threadId }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "cross-browser deleteThread precheck"
  );
  await assertRejectsCode(
    () => browserBoundThreadService.startRun({ threadId, input: { text: "Unauthorized" } }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "cross-browser startRun precheck"
  );
  assert.equal(threadMutationCalls.filter((call) => call.method === "updateIntegrationThread").length, 0);
  assert.equal(threadMutationCalls.filter((call) => call.method === "deleteIntegrationThread").length, 0);
  assert.equal(threadMutationCalls.filter((call) => call.method === "startIntegrationRun").length, 0);

  const allowedUpdated = await browserBoundThreadService.updateThread({ threadId, title: "Authorized" }, context);
  assert.equal(allowedUpdated.thread.title, "Authorized");
  await browserBoundThreadService.deleteThread({ threadId }, context);
  await browserBoundThreadService.startRun({ threadId, input: { text: "Authorized" } }, context);
  assert.equal(threadMutationCalls.filter((call) => call.method === "updateIntegrationThread").length, 1);
  assert.equal(threadMutationCalls.filter((call) => call.method === "deleteIntegrationThread").length, 1);
  assert.equal(threadMutationCalls.filter((call) => call.method === "startIntegrationRun").length, 1);

  const wrongStartResultCalls = [];
  const wrongStartResultService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(wrongStartResultCalls, { startRun: { threadId: uuidId("thr") } }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(
    () => wrongStartResultService.startRun({ threadId, input: { text: "Wrong thread result" } }, context),
    "NOT_FOUND",
    "startRun result threadId must match requested thread"
  );
  assert.equal(wrongStartResultCalls.filter((call) => call.method === "startIntegrationRun").length, 1);

  const wrongResumeResultCalls = [];
  const wrongResumeResultService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(wrongResumeResultCalls, { resumeRun: { previousRunId: uuidId("run") } }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(
    () => wrongResumeResultService.resumeRun({ runId }, context),
    "NOT_FOUND",
    "resumeRun result previousRunId must match requested run"
  );
  assert.equal(wrongResumeResultCalls.filter((call) => call.method === "resumeIntegrationRun").length, 1);

  const cursorMismatchStore = createFileIntegrationEventLedgerStore({ rootDir: path.join(root, "adapter-cursor-mismatch") });
  const cursorMismatchEvent = await cursorMismatchStore.appendPublicEvent(
    { principalId: PRINCIPAL, browserSessionId: BROWSER_SESSION, browserSessionPolicy: "same-browser-session", threadId, runId },
    { type: "output.delta", payload: { text: "Cursor mismatch event" }, createdAt: AT }
  );
  const cursorMismatchService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([], { run: { eventCursor: { firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 } } }),
    eventLedgerStore: cursorMismatchStore,
  });
  await assertRejectsCode(
    () => cursorMismatchService.getRunStatus({ runId }, context),
    "PUBLIC_EVENT_LEDGER_CORRUPT",
    "run eventCursor mismatch rejects"
  );
  const cursorMatchedService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([], { run: { eventCursor: { firstSeq: 1, lastSeq: 1, lastHash: cursorMismatchEvent.hash, prunedThroughSeq: 0 } } }),
    eventLedgerStore: cursorMismatchStore,
  });
  const cursorMatched = await cursorMatchedService.getRunStatus({ runId }, context);
  assert.equal(cursorMatched.run.eventCursor.lastHash, cursorMismatchEvent.hash);

  await assertRejectsCode(
    () => service.getRunStatus({ runId }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "browser-bound run status denied before sanitization"
  );
  const conflictingRunCalls = [];
  const conflictingRunService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(conflictingRunCalls, {
      run: {
        browserSessionPolicy: "same-browser-session",
        browserSessionId: BROWSER_SESSION,
        ownerBrowserSessionId: OTHER_BROWSER_SESSION,
      },
    }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(() => conflictingRunService.getRunStatus({ runId }, context), "NOT_FOUND", "contradictory run status");
  await assertRejectsCode(() => conflictingRunService.loadRunEvents({ runId, afterSeq: 0, afterHash: ZERO_DIGEST }, context), "NOT_FOUND", "contradictory run events");
  await assertRejectsCode(() => conflictingRunService.cancelRun({ runId }, context), "NOT_FOUND", "contradictory run cancel");
  await assertRejectsCode(() => conflictingRunService.resumeRun({ runId }, context), "NOT_FOUND", "contradictory run resume");
  assert.equal(conflictingRunCalls.filter((call) => call.method === "cancelIntegrationRun").length, 0);
  assert.equal(conflictingRunCalls.filter((call) => call.method === "resumeIntegrationRun").length, 0);

  const conflictingArtifactService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime([], {
      artifact: {
        browserSessionPolicy: "same-browser-session",
        browserSessionId: BROWSER_SESSION,
        ownerBrowserSessionId: OTHER_BROWSER_SESSION,
      },
    }),
    eventLedgerStore: eventStore,
  });
  await assertRejectsCode(() => conflictingArtifactService.getArtifact({ artifactId }, context), "NOT_FOUND", "contradictory artifact get");
  const conflictingArtifacts = await conflictingArtifactService.listArtifacts({ threadId }, context);
  assert.equal(conflictingArtifacts.artifacts.length, 0);

  const listed = await service.listArtifacts({ threadId }, context);
  assert.equal(listed.artifacts.length, 1);
  assertNoRawLeak(listed);
  await assertRejectsCode(
    () => service.cancelRun({ runId }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "cross-browser cancellation"
  );
  assert.equal(directCalls.some((call) => call.method === "cancelIntegrationRun"), false);
  await assertRejectsCode(
    () => service.resumeRun({ runId }, { ...context, browserSessionId: OTHER_BROWSER_SESSION }),
    "NOT_FOUND",
    "cross-browser resumeRun precheck"
  );
  assert.equal(directCalls.some((call) => call.method === "resumeIntegrationRun"), false);
  const cancelled = await service.cancelRun({ runId }, context);
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(directCalls.some((call) => call.method === "cancelIntegrationRun"), true);

  const routeCalls = [];
  const routeService = createNativeIntegrationSessionService({
    runtimeAuthority: makeRuntime(routeCalls),
    eventLedgerStore: eventStore,
  });
  const idempotencyStore = createFileIntegrationIdempotencyStore({ rootDir: path.join(root, "api-idempotency") });
  const app = await startApp({
    auth: { bearerToken: TOKEN, trustedProxy: true },
    sessionService: routeService,
    idempotencyStore,
  });
  try {
    const capabilities = await rpc(app.url, INTEGRATION_RPC_PATHS.capabilities, {});
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.json.enabled, false);
    const key = "phase3-api-key-xxxxxxxxxxxxxx";
    const first = await rpc(app.url, INTEGRATION_RPC_PATHS.threadsCreate, {}, { "Idempotency-Key": key });
    assert.equal(first.response.status, 503);
    assert.equal(first.json.error.code, "AGENT_UNAVAILABLE");
    assert.equal(routeCalls.filter((call) => call.method === "createIntegrationThread").length, 0);
  } finally {
    await app.close();
  }
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-phase3-authorities-"));
try {
  await smokeDirectoryLock(tempDir);
  await smokeIdempotency(tempDir);
  await smokeEventLedger(tempDir);
  await smokeSessionAdapterAndApi(tempDir);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

console.log("smoke-integration-authorities ok");
