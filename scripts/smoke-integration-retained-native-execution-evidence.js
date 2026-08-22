#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  createRetainedIntegrationNativeExecutionEvidence,
} from "../src/integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationTextWorkspaceCurrent,
  createRetainedIntegrationTextWorkspace,
  INTEGRATION_TEXT_WORKSPACE_PROFILE_ID,
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
} from "../src/integration-retained-text-workspace.js";
import {
  INTEGRATION_VISION_WORKSPACE_PROFILE_ID,
  INTEGRATION_VISION_WORKSPACE_TOOL_NAMES,
  INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
  createRetainedIntegrationVisionWorkspace,
} from "../src/integration-retained-vision-workspace.js";
import {
  createRetainedIntegrationNativeSessionRepositoryState,
} from "../src/integration-retained-native-session-repository-state.js";
import {
  INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
  bindRetainedIntegrationSessionStateStoreWriteFence,
  createRetainedIntegrationSessionStateStore,
} from "../src/integration-retained-session-state-store.js";
import {
  INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
  createRetainedIntegrationRuntimeRepositoryKernel,
} from "../src/integration-runtime-repository.js";
import {
  createIntegrationRetainedBinaryFilePrimitives,
  createIntegrationRetainedFilePrimitives,
  openIntegrationRetainedRegularFileLock,
  openIntegrationStorageAuthority,
} from "../src/integration-storage-authority.js";
import {
  PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
} from "../src/integration-events.js";
import {
  NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
} from "../src/integration-native-runtime-roots.js";
import {
  bindRetainedNativeExecution,
  buildFixedNativeRunAgentConfig,
  expectedFixedSessionRuntimeSnapshot,
  postflightNativeSessionRuntime,
  preflightNativeSessionRuntime,
  recordRetainedNativeTerminalEvidence,
} from "../src/integration-native-executor.js";
import {
  acquireRetainedIntegrationRuntimeRepositoryFence,
  compactRetainedIntegrationRuntimeRepository,
  createRetainedIntegrationRuntimeNativeWriteFence,
  createRetainedIntegrationRuntimeRecoveryCoordinator,
  createRetainedIntegrationRuntimeRepositorySurface,
  handoffRetainedIntegrationRuntimeRepositoryFence,
  retainedIntegrationRuntimeNativeWriteFenceActivityProof,
} from "../src/integration-retained-runtime-repository-surface.js";
import {
  createAgintiIntegrationRuntimeAuthority,
  createIntegrationRuntimeProcessOwnerBootstrap,
  INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY,
  INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
  INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
  INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
} from "../src/integration-runtime-authority.js";
import {
  buildFixedIntegrationPolicy,
  contractDigest,
  REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS,
} from "../src/integration-policy.js";
import {
  invokeIntegrationVisionWorkspace,
  registerIntegrationSessionConfig,
  runWithIntegrationSessionScope,
} from "../src/integration-session-persistence.js";
import { SessionStore } from "../src/session-store.js";
import { runAgent } from "../src/agent-runner.js";

const UID = process.getuid();
const GID = process.getgid();
const HELPER_PATH = "/usr/bin/flock";
const ZERO_DIGEST = "0".repeat(64);
const PRINCIPAL = "principalAAAAAAAA";
const BROWSER_SESSION = "a".repeat(64);
const POLICY_FINGERPRINT = "b".repeat(64);
const ROLE = "retained-native-evidence-smoke";
const THREAD_ID = "thr_00000000-0000-4000-8000-000000000301";
const RUN_ID = "run_00000000-0000-4000-8000-000000000302";
const RESUME_RUN_ID = "run_00000000-0000-4000-8000-000000000304";
const NATIVE_SESSION_ID = "aginti:00000000-0000-4000-8000-000000000303";
const VISION_LOCK_FILE = ".aginti-flock-v1-vision-blobs";
const FORGED_VISION_ARGUMENT_MARKER = "FORGED_VISION_ARGUMENT_7f4a65b9";
const FORGED_VISION_TEXT_RETRY_MARKER = "FORGED_VISION_TEXT_RETRY_6c2d91a8";
const FORGED_VISION_PATH = `/tmp/${FORGED_VISION_ARGUMENT_MARKER}.png`;
const FORGED_VISION_URL = `https://forbidden.invalid/${FORGED_VISION_ARGUMENT_MARKER}.png`;
const FORGED_VISION_BASE64 = `data:image/png;base64,${Buffer.from(FORGED_VISION_ARGUMENT_MARKER).toString("base64")}`;
const FORGED_WRAPPED_VISION_BYTES = Buffer.alloc(600, 0x00);
const FORGED_WRAPPED_VISION_PROMPT = (() => {
  const encoded = FORGED_WRAPPED_VISION_BYTES.toString("base64");
  const parts = [];
  let offset = 0;
  let width = 17;
  while (offset < encoded.length) {
    parts.push(encoded.slice(offset, offset + width));
    offset += width;
    width += 1;
  }
  return parts.join("\n");
})();
const FORGED_OVERSIZED_WRAPPED_VISION_PROMPT = Buffer.alloc(1200, 0xa5)
  .toString("base64")
  .match(/.{1,76}/gu)
  .join("\n");
const FORGED_BOUNDED_WRAPPED_VISION_PROMPT = Buffer.alloc(420, 0x93)
  .toString("base64")
  .match(/.{1,56}/gu)
  .join("\n");
const BASE_MS = Date.parse("2026-08-22T08:00:00.000Z");
const CHILD_MODE = String(process.argv.find((value) => value.startsWith("--child=")) || "").slice(8);
const CHILD_ROOT = String(process.argv.find((value) => value.startsWith("--root=")) || "").slice(7);

function timestamp(offsetSeconds) {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
}

function assertNoEncodedImageFragments(text, bytes, label) {
  const encoded = bytes.toString("base64");
  assert.equal(text.includes(encoded), false, `${label} retained the exact image encoding`);
  for (let index = 0; index <= encoded.length - 24; index += 1) {
    assert.equal(
      text.includes(encoded.slice(index, index + 24)),
      false,
      `${label} retained an input-derived image encoding fragment at ${index}`
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function seal(value) {
  const unsigned = { ...value };
  return deepFreeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function exactPng(width, height, rgba = [32, 96, 160, 255]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (1 + width * 4);
    rows[rowStart] = 0;
    for (let column = 0; column < width; column += 1) {
      const pixel = rowStart + 1 + column * 4;
      rows[pixel] = rgba[0];
      rows[pixel + 1] = rgba[1];
      rows[pixel + 2] = rgba[2];
      rows[pixel + 3] = rgba[3];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND"),
  ]);
}

function customPng({
  width = 1,
  height = 1,
  interlace = 0,
  rows = Buffer.from([0, 0, 0, 0, 255]),
  compressed = null,
  beforeImageData = [],
  afterImageData = [],
} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...beforeImageData,
    pngChunk("IDAT", compressed || deflateSync(rows)),
    ...afterImageData,
    pngChunk("IEND"),
  ]);
}

function nearMaximumUploadPng() {
  const width = 1024;
  const height = 960;
  const rowBytes = 1 + width * 4;
  const rows = Buffer.alloc(rowBytes * height);
  crypto.randomFillSync(rows);
  for (let row = 0; row < height; row += 1) rows[row * rowBytes] = 0;
  return customPng({
    width,
    height,
    rows,
    compressed: deflateSync(rows, { level: 0 }),
  });
}

async function openVisionLoopback() {
  const requests = [];
  let failureReferenceId = "";
  let cancellationReferenceId = "";
  let outputEchoReferenceId = "";
  let outputEchoMode = "wrapped";
  const promptWaiters = new Map();
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      if (chunks.reduce((total, item) => total + item.length, 0) > 8 * 1024 * 1024) {
        request.destroy();
        return;
      }
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push(Object.freeze({ method: request.method, url: request.url, bodyText }));
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/healthz") {
      send(200, { ok: true, service: "localllm-api", ollama: { ok: true, version: "vision-smoke" } });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      assert.match(String(request.headers.authorization || ""), /^Bearer /u);
      send(200, { object: "list", data: [{ id: "localllm-vision", object: "model" }] });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const payload = JSON.parse(bodyText);
      assert.equal(payload.model, "localllm-vision");
      assert.equal(payload.response_format?.type, "json_object");
      const content = payload.messages?.[0]?.content;
      assert(Array.isArray(content));
      const prompt = String(content.find((item) => item?.type === "text")?.text || "");
      const dataUrl = String(content.find((item) => item?.type === "image_url")?.image_url?.url || "");
      const detail = String(content.find((item) => item?.type === "image_url")?.image_url?.detail || "");
      assert.match(dataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u);
      assert(["low", "high", "auto"].includes(detail));
      for (const [referenceId, resolve] of promptWaiters) {
        if (!prompt.includes(referenceId)) continue;
        promptWaiters.delete(referenceId);
        resolve();
      }
      if (cancellationReferenceId && prompt.includes(cancellationReferenceId)) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          request.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (response.destroyed || response.writableEnded) return;
      }
      if (failureReferenceId && prompt.includes(failureReferenceId)) {
        send(500, {
          error: {
            message: `echo=${dataUrl} path=/tmp/private-vision.png secret=sk-abcdefghijklmnop`,
          },
        });
        return;
      }
      if (outputEchoReferenceId && prompt.includes(outputEchoReferenceId)) {
        const encodedImage = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const echoed = outputEchoMode === "sparse-hidden-exact"
          ? `${"a ".repeat(6000)}${encodedImage.slice(100_003, 100_051).match(/.{12}/gu).join(".")} ${"a ".repeat(6000)}`
          : outputEchoMode === "large-natural"
            ? JSON.stringify({
                summary: "The image presents a detailed but ordinary visual scene with balanced spacing, readable structure, and no indication that raw image bytes are part of this description. ".repeat(35),
                answer: "Visible evidence remains neutral and descriptive; colors, shapes, alignment, and uncertainty are reported in natural language for the calling agent. ".repeat(35),
              })
          : outputEchoMode === "unicode-punctuation"
          ? `vision-output:${encodedImage.match(/.{1,11}/gu).join("\u200b:,:")}:end`
          : outputEchoMode === "tiny-json-chunks"
          ? JSON.stringify({ answerChunks: encodedImage.match(/.{1,7}/gu) })
          : outputEchoMode === "prefix-suffix"
            ? JSON.stringify({ answer: `prefix:${encodedImage.slice(11, 83)}:suffix` })
            : JSON.stringify({ answer: encodedImage.match(/.{1,76}/gu).join("\n") });
        send(200, {
          id: "chatcmpl-retained-vision-echo-smoke",
          object: "chat.completion",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: echoed },
          }],
        });
        return;
      }
      send(200, {
        id: "chatcmpl-retained-vision-smoke",
        object: "chat.completion",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary: "A small validated PNG. secret=sk-abcdefghijklmnop path=/tmp/private-vision.png",
              visibleText: [],
              observations: ["One blue-toned square is visible."],
              issues: [],
              answer: "The retained image was read locally.",
              uncertainty: [],
            }),
          },
        }],
      });
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return Object.freeze({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setFailureReferenceId(referenceId) {
      failureReferenceId = referenceId;
    },
    setCancellationReferenceId(referenceId) {
      cancellationReferenceId = referenceId;
    },
    setOutputEcho(referenceId, mode = "wrapped") {
      outputEchoReferenceId = referenceId;
      outputEchoMode = mode;
    },
    waitForPrompt(referenceId) {
      const existing = requests.some((request) => request.bodyText.includes(referenceId));
      if (existing) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          promptWaiters.delete(referenceId);
          reject(new Error(`Vision request ${referenceId} was not observed.`));
        }, 5000);
        promptWaiters.set(referenceId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}

function visionScope(overrides = {}) {
  return Object.freeze({
    mode: "start",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: THREAD_ID,
    runId: RUN_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    ...overrides,
  });
}

function runtimeEventLedgerStore() {
  return Object.freeze({
    owner: "aginti",
    authority: "aginti",
    mappingVersion: PUBLIC_INTEGRATION_EVENT_LEDGER_VERSION,
    durable: true,
    persisted: true,
    contiguous: true,
    monotonic: true,
    bridgeOwned: false,
    appendPublicEvent() {
      throw new Error("runtime proof smoke does not append public events");
    },
    appendByOutboxId() {
      throw new Error("runtime proof smoke does not append outbox events");
    },
    lookupByOutboxId() {
      return null;
    },
    ledgerForRun() {
      throw new Error("runtime proof smoke does not open a public ledger");
    },
    [INTEGRATION_EVENT_APPEND_ATTESTATION_PROPERTY]: seal({
      schemaVersion: INTEGRATION_EVENT_APPEND_ATTESTATION_VERSION,
      owner: "aginti",
      authority: "aginti",
      appendPublicEvent: true,
      appendByOutboxId: true,
      lookupByOutboxId: true,
      terminalFinality: true,
      durable: true,
      persisted: true,
      monotonic: true,
    }),
  });
}

function runtimeCancellationAttestation() {
  return seal({
    schemaVersion: INTEGRATION_RUNTIME_CANCELLATION_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    abortControllerBound: true,
    exactRunOnly: true,
    browserSessionBound: true,
    cancellation: true,
  });
}

function runtimeSandboxAttestation() {
  const isolationAttestation = deepFreeze({
    profileVersion: "hardened-v1",
    profileDigest: "f".repeat(64),
    ...Object.fromEntries(REQUIRED_INTEGRATION_ISOLATION_ASSERTIONS.map((key) => [key, true])),
  });
  return seal({
    schemaVersion: INTEGRATION_HARDENED_SANDBOX_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    valid: true,
    enabled: true,
    isolationAttestation,
  });
}

function runtimeAuthorityForFixture(fixture, overrides = {}) {
  return createAgintiIntegrationRuntimeAuthority({
    threadSessionRepository: fixture.repository,
    eventLedgerStore: runtimeEventLedgerStore(),
    cancellationAttestation: runtimeCancellationAttestation(),
    hardenedSandboxAttestation: runtimeSandboxAttestation(),
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    repositoryFenceLease: fixture.acquiredFence.lease,
    nativeWriteFence: fixture.nativeWriteFence,
    retainedNativeExecutionEvidence: fixture.evidence,
    retainedRecoveryCoordinator: fixture.recovery,
    retainedTextWorkspace: fixture.textWorkspace,
    retainedVisionWorkspace: fixture.visionWorkspace,
    ...overrides,
  });
}

function identityDigest(stat) {
  return contractDigest({
    schemaVersion: "aginti-retained-regular-file-identity-v1",
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

async function ensureOwnerDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
  await fs.chown(directoryPath, UID, GID);
}

async function ensureLockFile(filePath) {
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.writeFile(filePath, "", { flag: "wx", mode: 0o600 });
  }
  await fs.chmod(filePath, 0o600);
  await fs.chown(filePath, UID, GID);
}

function runtimeRoots(rootPath) {
  const unsigned = Object.freeze({
    schemaVersion: NATIVE_RUNTIME_ROOTS_ATTESTATION_VERSION,
    sessionsDir: path.join(rootPath, "native:sessions"),
    baseDir: path.join(rootPath, "workspace"),
    commandCwd: path.join(rootPath, "workspace"),
    retainedDescriptor: true,
    symlinkFree: true,
    outsideForbiddenRoots: true,
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

async function openFixture(rootPath, now, processOwnerBootstrap, options = {}) {
  const repositorySegments = Object.freeze(["data:repository"]);
  const sessionSegments = Object.freeze(["native:sessions"]);
  const visionMetadataSegments = Object.freeze(["native:vision-metadata"]);
  const visionSegments = Object.freeze(["native:vision-blobs"]);
  const repositoryPath = path.join(rootPath, ...repositorySegments);
  const sessionPath = path.join(rootPath, ...sessionSegments);
  const visionMetadataPath = path.join(rootPath, ...visionMetadataSegments);
  const visionPath = path.join(rootPath, ...visionSegments);
  const repositoryLockPath = path.join(repositoryPath, INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE);
  const sessionLockPath = path.join(sessionPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE);
  const visionMetadataLockPath = path.join(visionMetadataPath, INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE);
  const visionLockPath = path.join(visionPath, VISION_LOCK_FILE);
  await ensureOwnerDirectory(rootPath);
  await ensureOwnerDirectory(repositoryPath);
  await ensureOwnerDirectory(sessionPath);
  await ensureOwnerDirectory(visionMetadataPath);
  await ensureOwnerDirectory(visionPath);
  await ensureOwnerDirectory(path.join(rootPath, "workspace"));
  const poisonTarget = path.join(rootPath, "legacy-session-root-poison");
  await fs.mkdir(poisonTarget, { recursive: true, mode: 0o700 });
  await fs.chmod(poisonTarget, 0o000);
  await fs.symlink(poisonTarget, path.join(sessionPath, NATIVE_SESSION_ID)).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await ensureLockFile(repositoryLockPath);
  await ensureLockFile(sessionLockPath);
  await ensureLockFile(visionMetadataLockPath);
  await ensureLockFile(visionLockPath);
  const authority = await openIntegrationStorageAuthority({
    rootPath,
    role: ROLE,
    ownerUid: UID,
    ownerGid: GID,
    label: "retained native evidence smoke",
  });
  const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(HELPER_PATH)).digest("hex");
  const helperIdentityDigest = identityDigest(await fs.stat(HELPER_PATH, { bigint: true }));

  async function binding(relativeSegments, lockFileName, lockPath, bytesKey, bytesValue, { binary = false } = {}) {
    const directory = await authority.openDirectory(relativeSegments);
    const directoryIdentity = await directory.identity();
    const directoryExpected = Object.freeze({
      role: ROLE,
      canonicalPath: rootPath,
      rootIdentityDigest: authority.attestation.rootIdentityDigest,
      relativeSegments,
      directoryIdentityDigest: directoryIdentity.digest,
    });
    const lockFiles = createIntegrationRetainedFilePrimitives(directory, directoryExpected);
    const files = binary
      ? createIntegrationRetainedBinaryFilePrimitives(directory, directoryExpected)
      : lockFiles;
    const lockFileIdentityDigest = identityDigest(await fs.stat(lockPath, { bigint: true }));
    const lock = await openIntegrationRetainedRegularFileLock(lockFiles, Object.freeze({
      ...directoryExpected,
      lockFileName,
      helperSha256,
      lockFileIdentityDigest,
      helperIdentityDigest,
    }));
    return Object.freeze({
      directory,
      files,
      lock,
      expected: Object.freeze({
        ...directoryExpected,
        lockFileIdentityDigest,
        helperSha256,
        helperIdentityDigest,
        [bytesKey]: bytesValue,
        lockWaitMs: 3000,
      }),
    });
  }

  const repositoryBinding = await binding(
    repositorySegments,
    INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE,
    repositoryLockPath,
    "maxSnapshotBytes",
    2 * 1024 * 1024
  );
  const sessionBinding = await binding(
    sessionSegments,
    INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
    sessionLockPath,
    "maxStateBytes",
    512 * 1024
  );
  const visionBinding = await binding(
    visionSegments,
    VISION_LOCK_FILE,
    visionLockPath,
    "maxBlobBytes",
    INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    { binary: true }
  );
  const visionMetadataBinding = await binding(
    visionMetadataSegments,
    INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
    visionMetadataLockPath,
    "maxStateBytes",
    512 * 1024
  );
  const kernel = createRetainedIntegrationRuntimeRepositoryKernel(
    repositoryBinding.files,
    repositoryBinding.lock,
    repositoryBinding.expected
  );
  const sessionStateStore = createRetainedIntegrationSessionStateStore(
    sessionBinding.files,
    sessionBinding.lock,
    sessionBinding.expected
  );
  const visionMetadataStore = createRetainedIntegrationSessionStateStore(
    visionMetadataBinding.files,
    visionMetadataBinding.lock,
    visionMetadataBinding.expected
  );
  const expected = Object.freeze({
    repositoryKernel: repositoryBinding.expected,
    sessionStateStore: sessionBinding.expected,
  });
  const repositoryState = createRetainedIntegrationNativeSessionRepositoryState(
    kernel,
    sessionStateStore,
    expected
  );
  const repository = createRetainedIntegrationRuntimeRepositorySurface({
    repositoryState,
    repositoryStateExpected: expected,
    runtimeRoots: runtimeRoots(rootPath),
    now,
  });
  const acquiredFence = await acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap,
  });
  if (options.probeFakeWriteFence === true) {
    const fakeFence = deepFreeze({
      schemaVersion: "aginti-retained-runtime-native-write-fence-v1",
      fenceIdentity: Object.freeze({ passthrough: true }),
      seal: Object.freeze({ passthrough: true }),
      admit: (operation) => operation(),
      attestation: Object.freeze({
        sessionStateNamespaceDigest: sessionStateStore.attestation.logicalNamespaceDigest,
        sessionStateAdmissionBindingDigest: sessionStateStore.attestation.admissionBindingDigest,
      }),
    });
    await expectCode(
      () => bindRetainedIntegrationSessionStateStoreWriteFence(
        sessionStateStore,
        sessionBinding.expected,
        fakeFence
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
  }
  const nativeWriteFence = options.skipNativeWriteFence === true
    ? null
    : await createRetainedIntegrationRuntimeNativeWriteFence(repository, {
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
      });
  const evidence = nativeWriteFence
    ? createRetainedIntegrationNativeExecutionEvidence({
        sessionStateStore,
        sessionStateStoreExpected: sessionBinding.expected,
        nativeWriteFence,
      })
    : null;
  const recovery = nativeWriteFence
    ? createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository,
        nativeExecutionEvidence: evidence,
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
        nativeWriteFence,
      })
    : null;
  const textWorkspace = nativeWriteFence
    ? await createRetainedIntegrationTextWorkspace({
        sessionStateStore,
        sessionStateStoreExpected: sessionBinding.expected,
        nativeExecutionEvidence: evidence,
        nativeWriteFence,
        repository,
        recoveryCoordinator: recovery,
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
      })
    : null;
  const visionFilesExpected = Object.freeze({
    role: visionBinding.expected.role,
    canonicalPath: visionBinding.expected.canonicalPath,
    rootIdentityDigest: visionBinding.expected.rootIdentityDigest,
    relativeSegments: visionBinding.expected.relativeSegments,
    directoryIdentityDigest: visionBinding.expected.directoryIdentityDigest,
  });
  const visionLockExpected = Object.freeze({
    ...visionFilesExpected,
    lockFileName: VISION_LOCK_FILE,
    helperSha256: visionBinding.expected.helperSha256,
    lockFileIdentityDigest: visionBinding.expected.lockFileIdentityDigest,
    helperIdentityDigest: visionBinding.expected.helperIdentityDigest,
  });
  const visionWorkspace = nativeWriteFence
    ? await createRetainedIntegrationVisionWorkspace({
        textWorkspace,
        sessionStateStore,
        sessionStateStoreExpected: sessionBinding.expected,
        metadataStore: visionMetadataStore,
        metadataStoreExpected: visionMetadataBinding.expected,
        binaryFilePrimitives: visionBinding.files,
        binaryFilePrimitivesExpected: visionFilesExpected,
        binaryFileLock: visionBinding.lock,
        binaryFileLockExpected: visionLockExpected,
        nativeExecutionEvidence: evidence,
        nativeWriteFence,
        repository,
        recoveryCoordinator: recovery,
        processOwnerBootstrap,
        repositoryFenceLease: acquiredFence.lease,
      })
    : null;
  const openDistinctSessionStore = async () => {
    const distinctBinding = await binding(
      sessionSegments,
      INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
      sessionLockPath,
      "maxStateBytes",
      512 * 1024
    );
    return createRetainedIntegrationSessionStateStore(
      distinctBinding.files,
      distinctBinding.lock,
      distinctBinding.expected
    );
  };
  return Object.freeze({
    authority,
    repository,
    repositoryState,
    sessionStateStore,
    visionMetadataStore,
    evidence,
    textWorkspace,
    visionWorkspace,
    recovery,
    expected,
    processOwnerBootstrap,
    processOwner: processOwnerBootstrap.processOwner,
    acquiredFence,
    nativeWriteFence,
    sessionBinding,
    visionMetadataBinding,
    visionBinding,
    visionFilesExpected,
    visionLockExpected,
    visionPath,
    openDistinctSessionStore,
  });
}

async function openSiblingFixture(rootPath, now, fixture) {
  const repository = createRetainedIntegrationRuntimeRepositorySurface({
    repositoryState: fixture.repositoryState,
    repositoryStateExpected: fixture.expected,
    runtimeRoots: runtimeRoots(rootPath),
    now,
  });
  const acquiredFence = await acquireRetainedIntegrationRuntimeRepositoryFence(repository, {
    processOwnerBootstrap: fixture.processOwnerBootstrap,
  });
  return Object.freeze({
    repository,
    repositoryState: fixture.repositoryState,
    processOwnerBootstrap: fixture.processOwnerBootstrap,
    processOwner: fixture.processOwner,
    acquiredFence,
  });
}

function installLegacySessionRootGuard(legacyRoot) {
  const names = [
    "access", "appendFile", "chmod", "chown", "copyFile", "cp", "link", "lstat", "mkdir", "mkdtemp",
    "open", "opendir", "readFile", "readdir", "readlink", "realpath", "rename", "rm", "stat",
    "symlink", "truncate", "unlink", "utimes", "writeFile",
  ];
  const originals = new Map();
  const hits = [];
  const matches = (value) => {
    let candidate = value;
    if (value instanceof URL && value.protocol === "file:") candidate = fileURLToPath(value);
    if (Buffer.isBuffer(candidate)) candidate = candidate.toString("utf8");
    if (typeof candidate !== "string") return false;
    const resolved = path.resolve(candidate);
    return resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`);
  };
  for (const name of names) {
    if (typeof fs[name] !== "function") continue;
    const original = fs[name];
    originals.set(name, original);
    fs[name] = async (...args) => {
      if (args.some(matches)) {
        hits.push(Object.freeze({ name, path: String(args.find(matches)) }));
        const error = new Error(`Forbidden legacy SessionStore root access: ${name}`);
        error.code = "EACCES";
        throw error;
      }
      return original(...args);
    };
  }
  return Object.freeze({
    hits,
    restore() {
      for (const [name, original] of originals) fs[name] = original;
    },
  });
}

function deterministicRunAgentConfig(baseConfig, registration) {
  let toolTurn = 0;
  let visionTextRetrySent = false;
  const vision = registration.visionWorkspace
    ? Object.freeze({
        workspace: registration.visionWorkspace,
        revokedReferenceId: registration.revokedReferenceId,
        failureReferenceId: registration.failureReferenceId,
        outputEchoReferenceId: registration.outputEchoReferenceId,
        validReferenceId: registration.validReferenceId,
      })
    : null;
  const promptAudit = {
    executionTier: registration.executionTier || "thorough",
    payloads: 0,
    planPayloads: 0,
    executionPayloads: 0,
  };
  const clientFactory = async () => ({
    chat: {
      completions: {
        async create(payload) {
          const promptText = JSON.stringify(payload.messages || []);
          assert.doesNotMatch(
            promptText,
            /common host data roots|home parent|supports broader setup and network commands|read-only at (?:their )?original absolute paths|Absolute host paths are acceptable/iu,
            "retained text-workspace prompt advertised unavailable host mounts or network setup"
          );
          assert.match(
            promptText,
            /(?:No shell command tool is available|Shell(?: tool)?(?: execution)?(?: and package installation)? (?:is|are)? ?(?:unavailable|disabled)|Shell, browser.{0,160}(?:unavailable|disabled))/iu,
            "retained workspace prompt did not disclose that shell execution is disabled"
          );
          const forbiddenCapability = promptText.match(
            /browser and canvas tools are available|local preview tools available|canvas\/artifacts tunnel: available|writing specialist: available|long-job tool available|allowed remote image|workspace-local.{0,40}image|persists typed perception|perception artifacts? (?:are )?(?:persisted|available)/iu
          );
          assert.equal(
            forbiddenCapability,
            null,
            `retained workspace prompt advertised a forbidden capability: ${forbiddenCapability?.[0] || "unknown"}`
          );
          if (vision) {
            assert.match(promptText, /opaque retained PNG reference/iu);
            assert.match(promptText, /localllm-vision/u);
          }
          promptAudit.payloads += 1;
          if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
            promptAudit.planPayloads += 1;
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "1. Inspect the workspace.\n2. Verify retained evidence.\n3. Finish concisely.",
                },
              }],
            };
          }
          promptAudit.executionPayloads += 1;
          assert(
            !payload.tools.some((tool) => tool.function?.name === "run_command"),
            "real retained workspace execution offered run_command"
          );
          const offered = new Set(payload.tools.map((tool) => tool.function?.name));
          if (vision) {
            assert([...offered].every((name) => [
              "inspect_project", "list_files", "read_file", "search_files", "write_file", "apply_patch",
              "read_image", "finish",
            ].includes(name)));
            const readImageTool = payload.tools.find((tool) => tool.function?.name === "read_image");
            assert(readImageTool, "retained vision execution did not offer read_image");
            assert.deepEqual(
              Object.keys(readImageTool.function.parameters.properties).sort(),
              ["detail", "referenceId"]
            );
            assert.deepEqual(readImageTool.function.parameters.required, ["referenceId"]);
            assert.equal(readImageTool.function.parameters.additionalProperties, false);
            if (!visionTextRetrySent) {
              visionTextRetrySent = true;
              return {
                choices: [{
                  message: {
                    role: "assistant",
                    content: "",
                    aginti_text_tool_retry: {
                      reason: `${FORGED_VISION_TEXT_RETRY_MARKER} data:image/png;base64,Zm9yYmlkZGVu /tmp/private-vision.png`,
                    },
                  },
                }],
              };
            }
          }
          toolTurn += 1;
          const sequence = vision
            ? [
                {
                  name: "read_image",
                  args: {
                    referenceId: vision.validReferenceId,
                    path: FORGED_VISION_PATH,
                    url: FORGED_VISION_URL,
                    base64: FORGED_VISION_BASE64,
                    provider: "hosted-forged-provider",
                    model: "hosted-forged-model",
                  },
                },
                { name: "read_image", args: { referenceId: vision.revokedReferenceId, detail: "auto" } },
                {
                  name: "read_image",
                  args: {
                    referenceId: vision.validReferenceId,
                    prompt: FORGED_WRAPPED_VISION_PROMPT,
                    detail: "auto",
                  },
                },
                { name: "read_image", args: { referenceId: vision.failureReferenceId, detail: "high" } },
                { name: "read_image", args: { referenceId: vision.outputEchoReferenceId, detail: "auto" } },
                { name: "read_image", args: { referenceId: vision.validReferenceId, detail: "low" } },
                { name: "finish", args: { result: "Retained vision-workspace execution completed with verified local PNG evidence." } },
              ]
            : [
                { name: "inspect_project", args: {} },
                { name: "finish", args: { result: "Retained text-workspace execution completed with verified workspace evidence." } },
              ];
          const selected = sequence[Math.min(toolTurn - 1, sequence.length - 1)];
          const name = selected.name === "inspect_project" && !offered.has("inspect_project") ? "finish" : selected.name;
          assert(offered.has(name), `retained profile did not offer selected tool ${name}`);
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: `retained-text-workspace-${toolTurn}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(name === selected.name ? selected.args : {
                      result: "Retained workspace execution completed with verified evidence.",
                    }),
                  },
                }],
              },
            }],
          };
        },
      },
    },
  });
  clientFactory.agintiDeterministicTest = true;
  clientFactory.promptAudit = promptAudit;
  const config = Object.freeze({
    ...baseConfig,
    clientFactory,
    providerReadinessMode: "deterministic-test",
    allowLocalAutoMax: false,
    localResourceProbe: async () => Object.freeze({
      ready: false,
      status: "unknown",
      sharedWorkstationPressure: null,
    }),
    executionPolicy: Object.freeze({
      tier: registration.executionTier || "thorough",
      requiresPlan: (registration.executionTier || "thorough") === "thorough",
      reason: "Deterministic retained-profile E2E coverage.",
    }),
  });
  const expectedBeforeRevision = registration.mode === "resume" ? registration.expectedRuntimeRevision : 0;
  const expectedAfterRevision = registration.mode === "resume" ? registration.expectedRuntimeRevision + 1 : 1;
  return registerIntegrationSessionConfig(config, {
    nativeSessionId: NATIVE_SESSION_ID,
    mode: registration.mode,
    policyLock: config.integrationPolicyLock,
    policyFingerprint: config.integrationPolicyFingerprint,
    runtimeRootsDigest: config.integrationRuntimeRootsDigest,
    sessionsDir: config.sessionsDir,
    baseDir: config.baseDir,
    commandCwd: config.commandCwd,
    expectedBeforeRevision,
    expectedAfterRevision,
    expectedBeforeRuntimeDigest: registration.mode === "resume"
      ? contractDigest(expectedFixedSessionRuntimeSnapshot(config, expectedBeforeRevision))
      : ZERO_DIGEST,
    expectedAfterRuntimeDigest: contractDigest(expectedFixedSessionRuntimeSnapshot(config, expectedAfterRevision)),
    retainedNativeExecutionEvidence: registration.evidence,
    retainedTextWorkspace: registration.textWorkspace,
    ...(vision ? { retainedVisionWorkspace: vision.workspace } : {}),
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    threadId: THREAD_ID,
    runId: registration.runId,
  });
}

function threadPreservationDigest(thread) {
  return contractDigest({
    id: thread.id,
    nativeSessionId: thread.nativeSessionId,
    principalId: thread.principalId,
    browserSessionId: thread.browserSessionId,
    browserSessionPolicy: thread.browserSessionPolicy,
    title: thread.title,
    createdAt: thread.createdAt,
    authority: thread.authority,
    replay: thread.replay,
    messages: thread.messages || [],
  });
}

function authorizationFor(run, thread, previousRun = null) {
  const mode = previousRun === null ? "start" : "resume";
  const expectedNativeRuntimeRevision = run.authority.runtimeRevision;
  const unsigned = Object.freeze({
    schemaVersion: "aginti-native-start-authorization-v1",
    mode,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    threadId: run.threadId,
    runId: run.id,
    nativeSessionId: run.nativeSessionId,
    previousRunId: previousRun?.id || null,
    previousRunRevision: previousRun?.revision || null,
    previousRunRuntimeRevision: previousRun?.authority?.runtimeRevision || null,
    threadRevision: thread.revision,
    threadPreservationDigest: threadPreservationDigest(thread),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    expectedNativeRuntimeRevision,
    targetNativeRuntimeRevision:
      mode === "resume" ? expectedNativeRuntimeRevision + 1 : expectedNativeRuntimeRevision,
    expectedRunRevision: run.revision,
    targetRunRevision: run.revision + 1,
    dispatchLeaseId: run.dispatchLeaseId,
    dispatchOutbox: true,
    dispatchedAt: run.dispatchedAt,
    processOwner: run.processOwner,
    authorizedAt: run.dispatchedAt,
  });
  const authorizationDigest = contractDigest(unsigned);
  return Object.freeze({
    ...unsigned,
    authorizationId: `nstart_${authorizationDigest.slice(0, 48)}`,
    authorizationDigest,
  });
}

function reconciliationRequest(processOwner, reconciledAt) {
  const unsigned = Object.freeze({
    schemaVersion: "aginti-dispatch-reconciliation-v1",
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    processOwner,
    liveRunClaims: Object.freeze([]),
    reconciledAt,
  });
  return Object.freeze({ ...unsigned, requestDigest: contractDigest(unsigned) });
}

function fillerThreadId(index) {
  return `thr_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fillerNativeSessionId(index) {
  return `aginti:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fillerRunId(index) {
  return `run_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

async function fillReplayReceipts(fixture, { startIndex, count, startOffset }) {
  for (let index = 0; index < count; index += 1) {
    const identity = startIndex + index;
    await fixture.repository.createIntegrationThread(Object.freeze({
      threadId: fillerThreadId(identity),
      nativeSessionId: fillerNativeSessionId(identity),
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      browserSessionPolicy: "same-browser-session",
      title: `Replay horizon filler ${identity}`,
      createdAt: timestamp(startOffset + index),
      policyFingerprint: POLICY_FINGERPRINT,
    }));
  }
}

async function expectCode(action, expectedCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `Expected ${expectedCode}`);
  assert.equal(captured.publicCode || captured.code, expectedCode, captured.message);
}

function errorCode(error) {
  return String(error?.publicCode || error?.code || error?.name || "ERROR");
}

function spawnSessionLockBarrier(lockPath) {
  const child = spawn(
    HELPER_PATH,
    ["-x", lockPath, "/bin/bash", "-c", "echo locked; IFS= read -r _"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const locked = new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("locked")) resolve();
    });
    child.once("exit", (code, signal) => {
      if (!output.includes("locked")) {
        reject(new Error(`session lock barrier exited ${code}/${signal}: ${stderr}`));
      }
    });
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    resolve({ code, signal, stderr });
  }));
  return Object.freeze({
    child,
    locked,
    exited,
    release() {
      child.stdin.end("release\n");
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  });
}

async function waitForFenceActivity(nativeWriteFence, predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const proof = retainedIntegrationRuntimeNativeWriteFenceActivityProof(nativeWriteFence);
    if (predicate(proof)) return proof;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for native-write fence ${label}.`);
}

function spawnSuccessor(rootPath) {
  const child = fork(fileURLToPath(import.meta.url), ["--child=successor", `--root=${rootPath}`], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map();
  let nextId = 1;
  child.on("message", (message) => {
    if (message?.type === "ready") {
      readyResolve(message);
      return;
    }
    if (message?.type !== "response" || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else {
      const error = new Error(message.message || message.code || "successor command failed");
      error.code = message.code;
      waiter.reject(error);
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    const error = new Error(`successor exited (${code ?? signal}): ${stderr}`);
    readyReject(error);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    resolve({ code, signal, stderr });
  }));
  return Object.freeze({
    child,
    ready,
    exited,
    command(command, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`successor ${command} timed out: ${stderr}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ type: "command", id, command, payload });
      });
    },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  });
}

async function runSuccessorChild() {
  const processOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  const send = (payload) => new Promise((resolve, reject) => {
    if (typeof process.send !== "function") {
      reject(new Error("successor child requires an IPC channel"));
      return;
    }
    process.send(payload, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await send({ type: "ready", processOwner: processOwnerBootstrap.processOwner, pid: process.pid });
  const message = await new Promise((resolve) => process.once("message", resolve));
  let fixture = null;
  try {
    if (message?.type !== "command" || message.command !== "resolve") {
      throw new Error("successor received an invalid command");
    }
    let childTick = 500;
    const now = () => new Date(BASE_MS + childTick++ * 1000);
    fixture = await openFixture(CHILD_ROOT, now, processOwnerBootstrap);
    const runtimeAuthority = runtimeAuthorityForFixture(fixture);
    const runtimeProof = await runtimeAuthority.getIntegrationRuntimeProof();
    const textWorkspaceProof = await fixture.textWorkspace.attestCurrent();
    const recovered = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const replay = await fixture.recovery.resolveRecoveryHeldRun(message.payload);
    const resumedNativeSessionId = fillerNativeSessionId(9001);
    const predecessorNativeSnapshot = await fixture.sessionStateStore.loadSessionSnapshot(
      resumedNativeSessionId
    );
    const successorNativeWrite = await fixture.sessionStateStore.compareAndSwapSessionSnapshot(
      Object.freeze({
        mutationId: "native-write-fence.successor-resume-after-handoff",
        nativeSessionId: resumedNativeSessionId,
        expectedPersistenceRevision: predecessorNativeSnapshot.persistenceRevision,
        expectedIntegrityDigest: predecessorNativeSnapshot.integrityDigest,
        state: Object.freeze({
          sessionId: resumedNativeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 2 }) }),
        }),
      })
    );
    const persisted = (await fixture.repository.getIntegrationRun({
      runId: message.payload.runId,
      principalId: message.payload.principalId,
      browserSessionId: message.payload.browserSessionId,
    })).run;
    await send({
      type: "response",
      id: message.id,
      ok: true,
      result: {
        runId: recovered.run.id,
        status: recovered.run.status,
        runtimeRevision: recovered.run.authority.runtimeRevision,
        processOwnerDigest: contractDigest(recovered.run.processOwner),
        replayOutcome: replay.outcome,
        persistedStatus: persisted.status,
        persistedRuntimeRevision: persisted.authority.runtimeRevision,
        persistedProcessOwnerDigest: contractDigest(persisted.processOwner),
        fence: runtimeProof.repositoryFence,
        nativeWriteFence: runtimeProof.nativeWriteFence,
        textWorkspace: {
          profile: fixture.textWorkspace.attestation.profile,
          attestationDigest: fixture.textWorkspace.attestation.digest,
          currentProofDigest: textWorkspaceProof.digest,
          nativeWriteFenceAttestationDigest:
            textWorkspaceProof.nativeWriteFenceAttestationDigest,
          durablyCurrent: textWorkspaceProof.durablyCurrent,
          nativeSessionStateWriterFencing:
            textWorkspaceProof.nativeSessionStateWriterFencing,
          nativeSessionStateWriterQuiescenceProven:
            textWorkspaceProof.nativeSessionStateWriterQuiescenceProven,
          fullSessionStoreSidecarsFenced:
            textWorkspaceProof.fullSessionStoreSidecarsFenced,
          imagePerceptionSidecarsFenced:
            textWorkspaceProof.imagePerceptionSidecarsFenced,
          runtimeProofDigest: runtimeProof.retainedTextWorkspaceCurrentProofDigest,
          runtimeNativeWriterFencing:
            runtimeProof.retainedTextWorkspaceNativeWriterFencing,
          runtimeNativeWriterQuiescence:
            runtimeProof.retainedTextWorkspaceNativeWriterQuiescence,
        },
        successorNativeWrite: {
          outcome: successorNativeWrite.outcome,
          persistenceRevision: successorNativeWrite.snapshot.persistenceRevision,
          runtimeRevision: successorNativeWrite.snapshot.runtimeRevision,
        },
        coordinatorFenceDigest: fixture.recovery.attestation.repositoryFenceDigest,
        coordinatorLeaseDigest: fixture.recovery.attestation.repositoryFenceLeaseDigest,
      },
    });
  } catch (error) {
    await send({
      type: "response",
      id: message?.id,
      ok: false,
      code: errorCode(error),
      message: String(error?.message || error),
    });
  } finally {
    await fixture?.authority.close().catch(() => {});
    process.disconnect?.();
  }
}

async function authorizeRepositoryRun(fixture, dispatchOwner = fixture.processOwner) {
  const createdAt = timestamp(1);
  const originalThread = (await fixture.repository.createIntegrationThread(Object.freeze({
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Retained native evidence",
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
  }))).thread;
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId: RUN_ID,
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    previousRunId: null,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: originalThread.revision,
    expectedNativeRuntimeRevision: 1,
    input: Object.freeze({ text: "Prove retained native execution." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(2);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId: RUN_ID,
    threadId: THREAD_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: 1,
    dispatchLeaseId: contractDigest({ runId: RUN_ID, nativeSessionId: NATIVE_SESSION_ID, createdAt }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  assert.equal(authorized.receipt.authorizationDigest, authorization.authorizationDigest);
  return Object.freeze({ created, dispatched, authorization, authorized });
}

async function authorizeRepositoryResume(fixture, previousRun, thread, dispatchOwner) {
  const createdAt = timestamp(60);
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId: RESUME_RUN_ID,
    threadId: THREAD_ID,
    nativeSessionId: NATIVE_SESSION_ID,
    previousRunId: previousRun.id,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: thread.revision,
    expectedNativeRuntimeRevision: previousRun.authority.runtimeRevision,
    input: Object.freeze({ text: "Advance the retained native execution." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(61);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId: RESUME_RUN_ID,
    threadId: THREAD_ID,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: previousRun.authority.runtimeRevision,
    dispatchLeaseId: contractDigest({
      runId: RESUME_RUN_ID,
      nativeSessionId: NATIVE_SESSION_ID,
      createdAt,
    }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread, previousRun);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  assert.equal(authorized.receipt.authorizationDigest, authorization.authorizationDigest);
  return Object.freeze({ created, dispatched, authorization, authorized });
}

async function authorizeStaleTextProfileProbe(fixture, dispatchOwner) {
  const identity = 9_902;
  const threadId = fillerThreadId(identity);
  const runId = fillerRunId(identity);
  const nativeSessionId = fillerNativeSessionId(identity);
  const createdAt = timestamp(75);
  const thread = (await fixture.repository.createIntegrationThread(Object.freeze({
    threadId,
    nativeSessionId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    title: "Stale text-profile fence probe",
    createdAt,
    policyFingerprint: POLICY_FINGERPRINT,
  }))).thread;
  const created = await fixture.repository.createIntegrationRun(Object.freeze({
    runId,
    threadId,
    nativeSessionId,
    previousRunId: null,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    browserSessionPolicy: "same-browser-session",
    expectedThreadRevision: thread.revision,
    expectedNativeRuntimeRevision: 1,
    input: Object.freeze({ text: "Hold one exact stale profile write proof." }),
    createdAt,
    status: "starting",
  }));
  const dispatchedAt = timestamp(76);
  const dispatched = (await fixture.repository.markIntegrationRunDispatching(Object.freeze({
    runId,
    threadId,
    principalId: PRINCIPAL,
    browserSessionId: BROWSER_SESSION,
    expectedRevision: created.run.revision,
    expectedNativeRuntimeRevision: 1,
    dispatchLeaseId: contractDigest({ runId, nativeSessionId, createdAt }),
    dispatchOutbox: true,
    processOwner: dispatchOwner,
    dispatchedAt,
  }))).run;
  const authorization = authorizationFor(dispatched, created.thread);
  const authorized = await fixture.repository.authorizeIntegrationRunNativeStart({ authorization });
  return Object.freeze({ threadId, runId, nativeSessionId, authorized });
}

async function run() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-retained-native-evidence-"));
  const mismatchRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-native-evidence-mismatch-")
  );
  const spliceRootPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "aginti-retained-native-evidence-splice-")
  );
  let fixture = null;
  let mismatchFixture = null;
  let spliceFixture = null;
  let spliceReplacementFixture = null;
  let staleRuntimeFixture = null;
  let successor = null;
  let sessionLockBarrier = null;
  const visionLoopback = await openVisionLoopback();
  const priorLocalLLMBaseURL = process.env.AGINTI_LOCALLLM_BASE_URL;
  const priorLocalLLMApiKey = process.env.LOCALLLM_API_KEY;
  process.env.AGINTI_LOCALLLM_BASE_URL = visionLoopback.baseURL;
  process.env.LOCALLLM_API_KEY = "retained-vision-smoke-key";
  let tick = 100;
  const now = () => new Date(BASE_MS + tick++ * 1000);
  const processOwnerBootstrap = await createIntegrationRuntimeProcessOwnerBootstrap();
  try {
    fixture = await openFixture(rootPath, now, processOwnerBootstrap, {
      probeFakeWriteFence: true,
    });
    mismatchFixture = await openFixture(mismatchRootPath, now, processOwnerBootstrap);
    spliceFixture = await openFixture(spliceRootPath, now, processOwnerBootstrap);
    await spliceFixture.authority.close();
    spliceFixture = null;
    const replacedRepositoryPath = path.join(spliceRootPath, "data:repository");
    await fs.rename(
      replacedRepositoryPath,
      path.join(spliceRootPath, "data:repository.replaced")
    );
    await ensureOwnerDirectory(replacedRepositoryPath);
    await ensureLockFile(path.join(
      replacedRepositoryPath,
      INTEGRATION_RETAINED_REPOSITORY_LOCK_FILE
    ));
    spliceReplacementFixture = await openFixture(
      spliceRootPath,
      now,
      processOwnerBootstrap,
      { skipNativeWriteFence: true }
    );
    await expectCode(
      () => createRetainedIntegrationRuntimeNativeWriteFence(
        spliceReplacementFixture.repository,
        {
          processOwnerBootstrap,
          repositoryFenceLease: spliceReplacementFixture.acquiredFence.lease,
        }
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
    assert.deepEqual(fixture.visionWorkspace.attestation.supportedMimeTypes, ["image/png"]);
    assert.equal(fixture.visionWorkspace.attestation.runtimeCapabilityEnabled, false);
    assert.equal(fixture.visionWorkspace.attestation.publicServerCapabilityEnabled, false);
    assert.equal(fixture.visionWorkspace.attestation.nativeSessionStateWriterFencing, true);
    assert.equal(fixture.visionWorkspace.attestation.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(fixture.visionWorkspace.attestation.fullSessionStoreSidecarsFenced, false);
    assert.equal(fixture.visionWorkspace.attestation.imagePerceptionSidecarsFenced, false);
    assert.equal(fixture.visionWorkspace.attestation.crossProcessImageWriterFencing, false);
    assert.equal(fixture.visionWorkspace.attestation.localVisionModel, "localllm-vision");
    const primaryScope = visionScope();
    const revokedOuter = Proxy.revocable({}, {});
    revokedOuter.revoke();
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload(revokedOuter.proxy),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    const revokedUploadScope = Proxy.revocable(primaryScope, {});
    revokedUploadScope.revoke();
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: revokedUploadScope.proxy,
        mimeType: "image/png",
        bytes: exactPng(1, 1),
      }),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    const revokedBytes = Proxy.revocable(Buffer.from(exactPng(1, 1)), {});
    revokedBytes.revoke();
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: primaryScope,
        mimeType: "image/png",
        bytes: revokedBytes.proxy,
      }),
      "INTEGRATION_VISION_IMAGE_INVALID"
    );
    const mutableBinarySegments = [...fixture.visionFilesExpected.relativeSegments];
    const mutableLockSegments = [...fixture.visionLockExpected.relativeSegments];
    const mutationSafeFactory = createRetainedIntegrationVisionWorkspace({
      textWorkspace: fixture.textWorkspace,
      sessionStateStore: fixture.sessionStateStore,
      sessionStateStoreExpected: fixture.sessionBinding.expected,
      metadataStore: fixture.visionMetadataStore,
      metadataStoreExpected: fixture.visionMetadataBinding.expected,
      binaryFilePrimitives: fixture.visionBinding.files,
      binaryFilePrimitivesExpected: {
        ...fixture.visionFilesExpected,
        relativeSegments: mutableBinarySegments,
      },
      binaryFileLock: fixture.visionBinding.lock,
      binaryFileLockExpected: {
        ...fixture.visionLockExpected,
        relativeSegments: mutableLockSegments,
      },
      nativeExecutionEvidence: fixture.evidence,
      nativeWriteFence: fixture.nativeWriteFence,
      repository: fixture.repository,
      recoveryCoordinator: fixture.recovery,
      processOwnerBootstrap,
      repositoryFenceLease: fixture.acquiredFence.lease,
    });
    mutableBinarySegments[0] = "caller-mutated-after-await";
    mutableLockSegments[0] = "caller-mutated-after-await";
    const mutationSafeVision = await mutationSafeFactory;
    assert.equal(mutationSafeVision.attestation.digest, fixture.visionWorkspace.attestation.digest);
    const orphanPng = exactPng(1, 1, [20, 40, 60, 255]);
    const orphanPrepared = await fixture.visionWorkspace.prepareImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: orphanPng,
    });
    await fixture.authority.close();
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    await expectCode(
      () => fixture.visionWorkspace.inspectImageReference({
        scope: primaryScope,
        referenceId: orphanPrepared.reference.referenceId,
      }),
      "INTEGRATION_VISION_REFERENCE_UNAVAILABLE"
    );
    const orphanPublished = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: orphanPng,
    });
    assert.equal(orphanPublished.reference.referenceId, orphanPrepared.reference.referenceId);
    const primaryPng = exactPng(2, 2, [30, 90, 150, 255]);
    const primaryPublished = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: primaryPng,
    });
    await fixture.authority.close();
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    const reopenedPrimary = await fixture.visionWorkspace.inspectImageReference({
      scope: primaryScope,
      referenceId: primaryPublished.reference.referenceId,
    });
    assert.equal(reopenedPrimary.revoked, false);
    assert.equal(reopenedPrimary.reference.sha256, crypto.createHash("sha256").update(primaryPng).digest("hex"));
    const exactRetry = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: primaryPng,
    });
    assert.equal(exactRetry.outcome, "replayed");
    assert.deepEqual(exactRetry.reference, primaryPublished.reference);
    const otherOwnerScope = visionScope({ principalId: "principalBBBBBBBB" });
    const isolated = await fixture.visionWorkspace.stageImageUpload({
      scope: otherOwnerScope,
      mimeType: "image/png",
      bytes: primaryPng,
    });
    assert.notEqual(isolated.reference.referenceId, primaryPublished.reference.referenceId);
    await expectCode(
      () => fixture.visionWorkspace.inspectImageReference({
        scope: otherOwnerScope,
        referenceId: primaryPublished.reference.referenceId,
      }),
      "INTEGRATION_VISION_REFERENCE_FORBIDDEN"
    );
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: primaryScope,
        mimeType: "image/jpeg",
        bytes: primaryPng,
      }),
      "INTEGRATION_VISION_IMAGE_INVALID"
    );
    const badCrc = Buffer.from(primaryPng);
    badCrc[29] ^= 0x01;
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: primaryScope,
        mimeType: "image/png",
        bytes: badCrc,
      }),
      "INTEGRATION_VISION_IMAGE_INVALID"
    );
    const validSingleRow = Buffer.from([0, 10, 20, 30, 255]);
    const invalidPngMatrix = [
      ["interlaced", customPng({ interlace: 1, rows: validSingleRow })],
      ["apng", customPng({ rows: validSingleRow, beforeImageData: [pngChunk("acTL", Buffer.alloc(8))] })],
      ["unknown-ancillary", customPng({ rows: validSingleRow, beforeImageData: [pngChunk("tEXt", Buffer.from("forbidden"))] })],
      ["reserved-type-bit", customPng({ rows: validSingleRow, beforeImageData: [pngChunk("ABcD", Buffer.alloc(0))] })],
      ["truncated", primaryPng.subarray(0, primaryPng.length - 1)],
      ["trailing-after-iend", Buffer.concat([primaryPng, Buffer.from([0])])],
      [
        "trailing-compressed-stream",
        customPng({
          rows: validSingleRow,
          compressed: Buffer.concat([deflateSync(validSingleRow), Buffer.from([0xde, 0xad, 0xbe, 0xef])]),
        }),
      ],
      ["invalid-filter", customPng({ rows: Buffer.from([5, 10, 20, 30, 255]) })],
      ["dimension-bound", customPng({ width: 8193, height: 1, rows: Buffer.from([0]) })],
      ["pixel-bound", customPng({ width: 8192, height: 3000, rows: Buffer.from([0]) })],
      ["decoded-byte-bound", customPng({ width: 8192, height: 2400, rows: Buffer.from([0]) })],
    ];
    for (const [label, bytes] of invalidPngMatrix) {
      await expectCode(
        () => fixture.visionWorkspace.stageImageUpload({
          scope: primaryScope,
          mimeType: "image/png",
          bytes,
        }),
        "INTEGRATION_VISION_IMAGE_INVALID",
        label
      );
    }
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: primaryScope,
        mimeType: "image/png",
        bytes: Buffer.alloc(INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES + 1),
      }),
      "INTEGRATION_VISION_IMAGE_INVALID"
    );
    await expectCode(
      () => fixture.visionWorkspace.stageImageUpload({
        scope: primaryScope,
        mimeType: "image/png",
        bytes: primaryPng,
        path: "/tmp/forbidden.png",
      }),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    const symlinkPng = exactPng(1, 2, [211, 17, 93, 255]);
    const blobNamesBeforeSymlink = new Set(
      (await fs.readdir(fixture.visionPath)).filter((name) => name.startsWith("vision-blob-"))
    );
    await fixture.visionWorkspace.prepareImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: symlinkPng,
    });
    const symlinkBlobName = (await fs.readdir(fixture.visionPath)).find(
      (name) => name.startsWith("vision-blob-") && !blobNamesBeforeSymlink.has(name)
    );
    assert(symlinkBlobName, "prepared retained vision blob was not found");
    const symlinkBlobPath = path.join(fixture.visionPath, symlinkBlobName);
    const symlinkSentinelPath = path.join(rootPath, "vision-symlink-sentinel.bin");
    await fs.writeFile(symlinkSentinelPath, Buffer.from("sentinel-stays-private"), { mode: 0o600 });
    await fs.unlink(symlinkBlobPath);
    await fs.symlink(symlinkSentinelPath, symlinkBlobPath);
    await expectCode(
      () => fixture.visionWorkspace.prepareImageUpload({
        scope: primaryScope,
        mimeType: "image/png",
        bytes: symlinkPng,
      }),
      "INTEGRATION_STORAGE_FILE_CORRUPT"
    );
    assert.equal(await fs.readFile(symlinkSentinelPath, "utf8"), "sentinel-stays-private");
    await fs.unlink(symlinkBlobPath);
    const revocable = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: exactPng(3, 1, [70, 80, 90, 255]),
    });
    const revoked = await fixture.visionWorkspace.revokeImageReference({
      scope: primaryScope,
      referenceId: revocable.reference.referenceId,
    });
    assert.equal(revoked.revoked, true);
    const revokedReplay = await fixture.visionWorkspace.revokeImageReference({
      scope: primaryScope,
      referenceId: revocable.reference.referenceId,
    });
    assert.equal(revokedReplay.outcome, "replayed");
    await fixture.authority.close();
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    const reopenedRevoked = await fixture.visionWorkspace.inspectImageReference({
      scope: primaryScope,
      referenceId: revocable.reference.referenceId,
    });
    assert.equal(reopenedRevoked.revoked, true);
    const failureImageBytes = exactPng(2, 1, [180, 30, 60, 255]);
    const failureImage = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: failureImageBytes,
    });
    visionLoopback.setFailureReferenceId(failureImage.reference.referenceId);
    const outputEchoImageBytes = exactPng(3, 2, [125, 45, 205, 255]);
    const outputEchoImage = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: outputEchoImageBytes,
    });
    visionLoopback.setOutputEcho(outputEchoImage.reference.referenceId, "unicode-punctuation");
    const maximumUploadPng = nearMaximumUploadPng();
    assert(maximumUploadPng.length > INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES - 300_000);
    assert(maximumUploadPng.length <= INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES);
    const maximumUploadImage = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: maximumUploadPng,
    });
    const cancellationImage = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: exactPng(1, 3, [90, 20, 140, 255]),
    });
    const tamper = await fixture.visionWorkspace.stageImageUpload({
      scope: primaryScope,
      mimeType: "image/png",
      bytes: exactPng(4, 1, [110, 120, 130, 255]),
    });
    const blobNames = (await fs.readdir(fixture.visionPath)).filter((name) => name.startsWith("vision-blob-"));
    let tamperBlob = "";
    for (const name of blobNames) {
      const candidate = await fs.readFile(path.join(fixture.visionPath, name));
      if (crypto.createHash("sha256").update(candidate).digest("hex") === tamper.reference.sha256) {
        tamperBlob = path.join(fixture.visionPath, name);
        break;
      }
    }
    assert(tamperBlob);
    const tamperedBytes = await fs.readFile(tamperBlob);
    tamperedBytes[tamperedBytes.length - 1] ^= 0x01;
    await fs.writeFile(tamperBlob, tamperedBytes, { mode: 0o600 });
    await expectCode(
      () => fixture.visionWorkspace.inspectImageReference({
        scope: primaryScope,
        referenceId: tamper.reference.referenceId,
      }),
      "INTEGRATION_VISION_BLOB_CORRUPT"
    );
    const sameDescriptorExpected = fixture.sessionBinding.expected;
    const sameDescriptorLock = await openIntegrationRetainedRegularFileLock(
      fixture.sessionBinding.files,
      Object.freeze({
        role: sameDescriptorExpected.role,
        canonicalPath: sameDescriptorExpected.canonicalPath,
        rootIdentityDigest: sameDescriptorExpected.rootIdentityDigest,
        relativeSegments: sameDescriptorExpected.relativeSegments,
        directoryIdentityDigest: sameDescriptorExpected.directoryIdentityDigest,
        lockFileName: INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE,
        helperSha256: sameDescriptorExpected.helperSha256,
        lockFileIdentityDigest: sameDescriptorExpected.lockFileIdentityDigest,
        helperIdentityDigest: sameDescriptorExpected.helperIdentityDigest,
      })
    );
    const sameDescriptorStore = createRetainedIntegrationSessionStateStore(
      fixture.sessionBinding.files,
      sameDescriptorLock,
      sameDescriptorExpected
    );
    const rawProbeSessionId = fillerNativeSessionId(9001);
    await expectCode(
      () => sameDescriptorStore.compareAndSwapSessionSnapshot(Object.freeze({
        mutationId: "native-write-fence.raw-reopen-probe",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: 0,
        expectedIntegrityDigest: ZERO_DIGEST,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({
            runtimeConfig: Object.freeze({ revision: 1 }),
          }),
        }),
      })),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_REQUIRED"
    );
    await bindRetainedIntegrationSessionStateStoreWriteFence(
      sameDescriptorStore,
      sameDescriptorExpected,
      fixture.nativeWriteFence
    );
    const sameDescriptorEvidence = createRetainedIntegrationNativeExecutionEvidence({
      sessionStateStore: sameDescriptorStore,
      sessionStateStoreExpected: sameDescriptorExpected,
      nativeWriteFence: fixture.nativeWriteFence,
    });
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: sameDescriptorEvidence,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE"
    );
    const distinctSameDescriptorStore = await fixture.openDistinctSessionStore();
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: distinctSameDescriptorStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_EVIDENCE_UNAVAILABLE"
    );
    await expectCode(
      () => createRetainedIntegrationRuntimeRecoveryCoordinator({
        repository: fixture.repository,
        nativeExecutionEvidence: mismatchFixture.evidence,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_SESSION_STATE_STORE_UNAVAILABLE"
    );
    await expectCode(
      () => bindRetainedIntegrationSessionStateStoreWriteFence(
        mismatchFixture.sessionStateStore,
        mismatchFixture.sessionBinding.expected,
        fixture.nativeWriteFence
      ),
      "INTEGRATION_SESSION_STATE_STORE_WRITE_FENCE_INVALID"
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: mismatchFixture.repository,
        recoveryCoordinator: mismatchFixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: mismatchFixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    const serializedNativeWriteFence = deepFreeze(
      JSON.parse(JSON.stringify(fixture.nativeWriteFence))
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: serializedNativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    await expectCode(
      () => runtimeAuthorityForFixture(fixture, {
        nativeWriteFence: serializedNativeWriteFence,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    assert.equal(
      fixture.recovery.attestation.storageExpectedDigest,
      fixture.evidence.attestation.storageExpectedDigest
    );
    assert.equal(
      fixture.recovery.attestation.storageAdmissionBindingDigest,
      fixture.evidence.attestation.storageAdmissionBindingDigest
    );
    assert.equal(fixture.textWorkspace.attestation.profile, INTEGRATION_TEXT_WORKSPACE_PROFILE_ID);
    assert.equal(fixture.textWorkspace.attestation.legacySessionRootAccess, false);
    assert.equal(fixture.textWorkspace.attestation.reachableOperationsRetained, true);
    assert.equal(fixture.textWorkspace.attestation.fullSessionStoreRetained, false);
    assert.equal(fixture.textWorkspace.attestation.shellExecution, false);
    assert.equal(fixture.textWorkspace.attestation.crossProcessExecutionFence, true);
    assert.equal(fixture.evidence.attestation.crossProcessExecutionFence, true);
    assert.equal(fixture.textWorkspace.attestation.repositoryTransitionFenceBound, true);
    assert.equal(fixture.textWorkspace.attestation.nativeSessionStateWriterFencing, true);
    assert.equal(fixture.textWorkspace.attestation.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(fixture.textWorkspace.attestation.fullSessionStoreSidecarsFenced, false);
    assert.equal(fixture.textWorkspace.attestation.imagePerceptionSidecarsFenced, false);
    assert.equal(
      fixture.textWorkspace.attestation.nativeWriteFenceAttestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    const currentProfileProof = await fixture.textWorkspace.attestCurrent();
    assert.equal(currentProfileProof.durablyCurrent, true);
    assert.equal(currentProfileProof.nativeSessionStateWriterFencing, true);
    assert.equal(currentProfileProof.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(currentProfileProof.fullSessionStoreSidecarsFenced, false);
    assert.equal(currentProfileProof.imagePerceptionSidecarsFenced, false);
    assert.equal(
      currentProfileProof.nativeWriteFenceAttestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    assert.equal(currentProfileProof.repositoryFenceLeaseDigest, fixture.acquiredFence.lease.digest);
    const integratedRuntimeProof = await runtimeAuthorityForFixture(fixture).getIntegrationRuntimeProof();
    assert.equal(
      integratedRuntimeProof.retainedNativeExecutionEvidenceProofDigest,
      fixture.evidence.attestation.digest
    );
    assert.equal(
      integratedRuntimeProof.retainedRecoveryCoordinatorProofDigest,
      fixture.recovery.attestation.digest
    );
    assert.equal(
      integratedRuntimeProof.retainedTextWorkspaceProofDigest,
      fixture.textWorkspace.attestation.digest
    );
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceCurrentProofDigest, currentProfileProof.digest);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceNativeWriterFencing, true);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceNativeWriterQuiescence, true);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceFullSessionStoreSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.retainedTextWorkspaceImagePerceptionSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.nativeWriteFence.nativeSessionStateWriterFencing, true);
    assert.equal(integratedRuntimeProof.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(integratedRuntimeProof.nativeWriteFence.imagePerceptionSidecarsFenced, false);
    const currentVisionProfileProof = await fixture.visionWorkspace.attestCurrent();
    assert.equal(
      integratedRuntimeProof.retainedVisionWorkspaceProofDigest,
      fixture.visionWorkspace.attestation.digest
    );
    assert.equal(integratedRuntimeProof.retainedVisionWorkspaceCurrentProofDigest, currentVisionProfileProof.digest);
    assert.equal(integratedRuntimeProof.retainedVisionWorkspaceNativeWriterFencing, true);
    assert.equal(integratedRuntimeProof.retainedVisionWorkspaceNativeWriterQuiescence, true);
    assert.equal(integratedRuntimeProof.retainedVisionWorkspaceCrossProcessImageWriterFencing, false);
    assert.equal(integratedRuntimeProof.repositoryFence.leaseDigest, fixture.acquiredFence.lease.digest);
    assert.deepEqual(
      [...fixture.textWorkspace.attestation.enabledToolNames],
      [...INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES]
    );
    const sessionStoreMethods = Object.getOwnPropertyNames(SessionStore.prototype)
      .filter((name) => !["constructor", "withIntegrationOperation", "assertIntegrationOperation"].includes(name))
      .sort();
    assert.deepEqual(
      Object.keys(fixture.textWorkspace.attestation.operationDispositions).sort(),
      sessionStoreMethods
    );
    let accessorTrapCount = 0;
    const accessorFactoryPayload = {};
    Object.defineProperty(accessorFactoryPayload, "sessionStateStore", {
      enumerable: true,
      get() {
        accessorTrapCount += 1;
        return fixture.sessionStateStore;
      },
    });
    Object.defineProperty(accessorFactoryPayload, "sessionStateStoreExpected", {
      enumerable: true,
      value: fixture.expected.sessionStateStore,
    });
    Object.defineProperty(accessorFactoryPayload, "nativeExecutionEvidence", {
      enumerable: true,
      value: fixture.evidence,
    });
    for (const [key, value] of Object.entries({
      nativeWriteFence: fixture.nativeWriteFence,
      repository: fixture.repository,
      recoveryCoordinator: fixture.recovery,
      processOwnerBootstrap,
      repositoryFenceLease: fixture.acquiredFence.lease,
    })) {
      Object.defineProperty(accessorFactoryPayload, key, { enumerable: true, value });
    }
    await expectCode(
      () => createRetainedIntegrationTextWorkspace(accessorFactoryPayload),
      "INTEGRATION_TEXT_WORKSPACE_INVALID"
    );
    assert.equal(accessorTrapCount, 0);
    const revokedScope = Proxy.revocable({}, {});
    revokedScope.revoke();
    await expectCode(
      () => fixture.textWorkspace.prepareExecution(revokedScope.proxy),
      "INTEGRATION_TEXT_WORKSPACE_INVALID"
    );
    await authorizeRepositoryRun(mismatchFixture);
    await mismatchFixture.authority.close();
    mismatchFixture = await openFixture(mismatchRootPath, now, processOwnerBootstrap);
    await mismatchFixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(mismatchFixture.processOwner, timestamp(40))
    );
    const noEvidenceCursor = Object.freeze({
      firstSeq: 1,
      lastSeq: 0,
      lastHash: ZERO_DIGEST,
      prunedThroughSeq: 0,
    });
    await expectCode(
      () => mismatchFixture.recovery.resolveRecoveryHeldRun(Object.freeze({
        runId: RUN_ID,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedCursor: noEvidenceCursor,
      })),
      "RECOVERY_EVIDENCE_UNAVAILABLE"
    );
    const noEvidenceHeld = (await mismatchFixture.repository.getIntegrationRun({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(noEvidenceHeld.recoveryState.status, "recovery_hold");
    await mismatchFixture.visionMetadataBinding.directory.close();
    await expectCode(
      () => mismatchFixture.visionWorkspace.attestCurrent(),
      "INTEGRATION_VISION_WORKSPACE_UNAVAILABLE"
    );
    const roots = runtimeRoots(rootPath);
    const { authorization, authorized } = await authorizeRepositoryRun(fixture);
    const visionRuntimeEvents = [];
    const visionRuntimeLogs = [];
    const baseConfig = buildFixedNativeRunAgentConfig({
      mode: "start",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: `Inspect the retained PNG image reference ${primaryPublished.reference.referenceId} and report visible evidence without modifying files.`,
      abortSignal: new AbortController().signal,
      onEvent(type, data) {
        visionRuntimeEvents.push(Object.freeze({ type, data }));
      },
      onLog(type, data) {
        visionRuntimeLogs.push(Object.freeze({ type, data }));
      },
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
      retainedTextWorkspace: fixture.textWorkspace,
      retainedVisionWorkspace: fixture.visionWorkspace,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: THREAD_ID,
      runId: RUN_ID,
    });
    const config = deterministicRunAgentConfig(baseConfig, {
      mode: "start",
      executionTier: "focused",
      expectedRuntimeRevision: 1,
      evidence: fixture.evidence,
      textWorkspace: fixture.textWorkspace,
      visionWorkspace: fixture.visionWorkspace,
      revokedReferenceId: revocable.reference.referenceId,
      failureReferenceId: failureImage.reference.referenceId,
      outputEchoReferenceId: outputEchoImage.reference.referenceId,
      validReferenceId: primaryPublished.reference.referenceId,
      runId: RUN_ID,
    });
    assert.equal(config.integrationSessionProfile, INTEGRATION_VISION_WORKSPACE_PROFILE_ID);
    assert.equal(config.allowShellTool, false);
    assert.equal(config.allowImagePerception, true);
    assert.deepEqual(config.integrationAllowedToolNames, INTEGRATION_VISION_WORKSPACE_TOOL_NAMES);
    const legacySessionRoot = path.join(roots.sessionsDir, NATIVE_SESSION_ID);
    const legacyGuard = installLegacySessionRootGuard(legacySessionRoot);
    let preflight;
    let postflight;
    let nativeResult;
    let nativeVisionBinding;
    try {
      preflight = await preflightNativeSessionRuntime(config);
      assert.equal(preflight.retained, true);
      assert.equal(preflight.expectedAfterRevision, 1);
      nativeVisionBinding = await bindRetainedNativeExecution(config, {
        authorization: authorized.receipt,
        snapshotHash: authorized.run.authority.snapshotHash,
      });
      nativeResult = await runWithIntegrationSessionScope(config, async () => {
        const result = await runAgent(config);
        const beforeLookalikeRequests = visionLoopback.requests.length;
        await expectCode(
          () => invokeIntegrationVisionWorkspace(
            Object.freeze({ integrationSessionProfile: INTEGRATION_VISION_WORKSPACE_PROFILE_ID }),
            { referenceId: primaryPublished.reference.referenceId }
          ),
          "INTEGRATION_SESSION_SCOPE_INVALID"
        );
        assert.equal(visionLoopback.requests.length, beforeLookalikeRequests);
        return result;
      });
      postflight = await postflightNativeSessionRuntime(config, preflight);
    } finally {
      legacyGuard.restore();
    }
    assert.deepEqual(legacyGuard.hits, []);
    assert.equal((await fs.lstat(legacySessionRoot)).isSymbolicLink(), true);
    assert.match(nativeResult.result, /Retained vision-workspace execution completed/u);
    assert.equal(config.clientFactory.promptAudit.executionTier, "focused");
    assert(config.clientFactory.promptAudit.executionPayloads >= 7);
    for (const mode of ["wrapped", "tiny-json-chunks", "prefix-suffix"]) {
      visionLoopback.setOutputEcho(outputEchoImage.reference.referenceId, mode);
      let outputEchoError = null;
      try {
        await fixture.visionWorkspace.invokeReadImage(
          nativeVisionBinding,
          {
            referenceId: outputEchoImage.reference.referenceId,
            detail: "auto",
          },
          { abortSignal: new AbortController().signal }
        );
      } catch (error) {
        outputEchoError = error;
      }
      assert(outputEchoError, `${mode} exact-image echo was not rejected`);
      assert.equal(errorCode(outputEchoError), "INTEGRATION_VISION_OUTPUT_REJECTED");
      assert.equal(outputEchoError.message, "The local vision response contained forbidden retained image data.");
      assertNoEncodedImageFragments(
        JSON.stringify({ code: errorCode(outputEchoError), message: outputEchoError.message }),
        outputEchoImageBytes,
        `${mode} public error`
      );
    }
    visionLoopback.setOutputEcho(maximumUploadImage.reference.referenceId, "sparse-hidden-exact");
    const sparseEchoStartedAt = performance.now();
    await expectCode(
      () => fixture.visionWorkspace.invokeReadImage(
        nativeVisionBinding,
        { referenceId: maximumUploadImage.reference.referenceId, detail: "auto" },
        { abortSignal: new AbortController().signal }
      ),
      "INTEGRATION_VISION_OUTPUT_REJECTED"
    );
    const sparseEchoElapsedMs = performance.now() - sparseEchoStartedAt;
    assert(
      sparseEchoElapsedMs < 3_000,
      `near-maximum retained image sparse exact-echo scan blocked for ${sparseEchoElapsedMs.toFixed(1)}ms`
    );
    visionLoopback.setOutputEcho(maximumUploadImage.reference.referenceId, "large-natural");
    const maximumInputStartedAt = performance.now();
    const maximumInputResult = await fixture.visionWorkspace.invokeReadImage(
      nativeVisionBinding,
      { referenceId: maximumUploadImage.reference.referenceId, detail: "auto" },
      { abortSignal: new AbortController().signal }
    );
    const maximumInputElapsedMs = performance.now() - maximumInputStartedAt;
    assert.equal(maximumInputResult.ok, true);
    assert(
      maximumInputElapsedMs < 3_000,
      `near-maximum retained image plus long natural non-match blocked for ${maximumInputElapsedMs.toFixed(1)}ms`
    );
    assert.equal(fixture.visionWorkspace.attestation.completeBoundedInputEchoResponseWindowIndex, true);
    visionLoopback.setOutputEcho(outputEchoImage.reference.referenceId, "wrapped");
    const beforeForgedInvocationRequests = visionLoopback.requests.length;
    for (const forgedArgs of [
      { path: "forbidden.txt" },
      { url: "https://forbidden.invalid/image.png" },
      { base64: "Zm9yYmlkZGVu" },
      { referenceId: primaryPublished.reference.referenceId, prompt: FORGED_BOUNDED_WRAPPED_VISION_PROMPT },
      { referenceId: primaryPublished.reference.referenceId, prompt: FORGED_OVERSIZED_WRAPPED_VISION_PROMPT },
      { referenceId: primaryPublished.reference.referenceId, provider: "openai" },
      { referenceId: primaryPublished.reference.referenceId, model: "forged-model" },
      { referenceId: primaryPublished.reference.referenceId, dryRun: true },
      { referenceId: primaryPublished.reference.referenceId, clientFactory: Object.assign(() => {}, { agintiDeterministicTest: true }) },
    ]) {
      await expectCode(
        () => fixture.visionWorkspace.invokeReadImage(
          nativeVisionBinding,
          forgedArgs,
          { abortSignal: new AbortController().signal }
        ),
        "INTEGRATION_VISION_WORKSPACE_INVALID"
      );
    }
    const revokedAbortSignal = Proxy.revocable(new AbortController().signal, {});
    revokedAbortSignal.revoke();
    await expectCode(
      () => fixture.visionWorkspace.invokeReadImage(
        nativeVisionBinding,
        { referenceId: primaryPublished.reference.referenceId },
        { abortSignal: revokedAbortSignal.proxy }
      ),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    await expectCode(
      () => fixture.visionWorkspace.invokeReadImage(
        nativeVisionBinding,
        { referenceId: primaryPublished.reference.referenceId },
        { abortSignal: Object.create(AbortSignal.prototype) }
      ),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    let abortAccessorCalls = 0;
    const accessorAbortSignal = new AbortController().signal;
    Object.defineProperty(accessorAbortSignal, "aborted", {
      configurable: true,
      enumerable: true,
      get() {
        abortAccessorCalls += 1;
        throw new Error("abort accessor must not run");
      },
    });
    await expectCode(
      () => fixture.visionWorkspace.invokeReadImage(
        nativeVisionBinding,
        { referenceId: primaryPublished.reference.referenceId },
        { abortSignal: accessorAbortSignal }
      ),
      "INTEGRATION_VISION_WORKSPACE_INVALID"
    );
    assert.equal(abortAccessorCalls, 0);
    assert.equal(visionLoopback.requests.length, beforeForgedInvocationRequests);
    visionLoopback.setCancellationReferenceId(cancellationImage.reference.referenceId);
    const cancellationController = new AbortController();
    const cancellationPromise = fixture.visionWorkspace.invokeReadImage(
      nativeVisionBinding,
      {
        referenceId: cancellationImage.reference.referenceId,
        detail: "auto",
      },
      {
        abortSignal: cancellationController.signal,
        providerReadinessTimeoutMs: 5000,
        modelTimeoutMs: 5000,
      }
    );
    await visionLoopback.waitForPrompt(cancellationImage.reference.referenceId);
    cancellationController.abort(new Error(
      "echo=data:image/png;base64,Zm9yYmlkZGVu path=/tmp/private-vision.png secret=sk-abcdefghijklmnop"
    ));
    let cancellationError = null;
    try {
      await cancellationPromise;
    } catch (error) {
      cancellationError = error;
    }
    assert(cancellationError);
    assert.equal(errorCode(cancellationError), "CANCELLED");
    assert.equal(cancellationError.message, "Retained vision inference was cancelled.");
    assert.doesNotMatch(JSON.stringify({
      code: errorCode(cancellationError),
      message: cancellationError.message,
    }), /data:image|base64|\/tmp\/|sk-|echo=/u);
    const completionRequests = visionLoopback.requests.filter((request) => request.url === "/v1/chat/completions");
    assert.equal(completionRequests.length, 9);
    assert(completionRequests.every((request) => request.bodyText.includes('"model":"localllm-vision"')));
    const requestedDetails = completionRequests.map((request) => {
      const payload = JSON.parse(request.bodyText);
      return payload.messages[0].content.find((item) => item.type === "image_url").image_url.detail;
    }).sort();
    assert.deepEqual(requestedDetails, ["auto", "auto", "auto", "auto", "auto", "auto", "auto", "high", "low"]);
    const retainedEventText = JSON.stringify(visionRuntimeEvents);
    const retainedLogText = JSON.stringify(visionRuntimeLogs);
    const forgedEncodedPayload = FORGED_VISION_BASE64.slice(FORGED_VISION_BASE64.indexOf(",") + 1);
    assert.doesNotMatch(retainedEventText, /data:image\/png;base64,/u);
    assert.doesNotMatch(retainedEventText, /\/tmp\/private-vision\.png/u);
    assert.doesNotMatch(retainedEventText, /sk-abcdefghijklmnop/u);
    assert.match(retainedEventText, /The exact loopback LocalLLM vision request failed/u);
    assert.match(retainedEventText, /The local vision response contained forbidden retained image data/u);
    assert.match(retainedEventText, /model\.text_tool_retry_requested/u);
    assert.match(retainedEventText, /retained-vision-text-tool-retry/u);
    assert.doesNotMatch(retainedEventText, /echo=/u);
    for (const forbidden of [FORGED_VISION_ARGUMENT_MARKER, FORGED_VISION_TEXT_RETRY_MARKER, FORGED_VISION_PATH, FORGED_VISION_URL, forgedEncodedPayload]) {
      assert.equal(retainedEventText.includes(forbidden), false, `forged vision argument leaked into runtime events: ${forbidden}`);
    }
    const retainedStartSnapshot = await fixture.sessionStateStore.loadSessionSnapshot(NATIVE_SESSION_ID);
    const retainedStartText = JSON.stringify(retainedStartSnapshot.state);
    for (const forbidden of [FORGED_VISION_ARGUMENT_MARKER, FORGED_VISION_TEXT_RETRY_MARKER, FORGED_VISION_PATH, FORGED_VISION_URL, forgedEncodedPayload]) {
      assert.equal(retainedStartText.includes(forbidden), false, `forged vision argument leaked into retained state: ${forbidden}`);
    }
    for (const [label, text] of [
      ["runtime events", retainedEventText],
      ["runtime logs", retainedLogText],
      ["retained start state", retainedStartText],
      ["native result", nativeResult.result],
    ]) {
      assertNoEncodedImageFragments(text, primaryPng, label);
      assertNoEncodedImageFragments(text, failureImageBytes, label);
      assertNoEncodedImageFragments(text, outputEchoImageBytes, label);
      assertNoEncodedImageFragments(text, FORGED_WRAPPED_VISION_BYTES, label);
    }
    assert.equal(postflight.revision, 1);
    const terminal = Object.freeze({
      status: "completed",
      output: nativeResult.result,
      error: null,
      resultDigest: contractDigest({ status: "completed", output: nativeResult.result }),
      completedAt: timestamp(8),
      persistedRuntimeRevision: 1,
    });
    const terminalReceipt = await recordRetainedNativeTerminalEvidence(config, terminal);
    assert.equal(terminalReceipt.outcome, "committed");
    const terminalReplay = await recordRetainedNativeTerminalEvidence(config, terminal);
    assert.equal(terminalReplay.outcome, "replayed");
    assert.equal((await fs.stat(path.join(roots.sessionsDir, NATIVE_SESSION_ID, "state.json")).catch(() => null)), null);

    await fixture.authority.close();
    fixture = await openFixture(rootPath, now, processOwnerBootstrap);
    const reopenedStartSnapshot = await fixture.sessionStateStore.loadSessionSnapshot(NATIVE_SESSION_ID);
    const reopenedStartText = JSON.stringify(reopenedStartSnapshot.state);
    for (const forbidden of [FORGED_VISION_ARGUMENT_MARKER, FORGED_VISION_TEXT_RETRY_MARKER, FORGED_VISION_PATH, FORGED_VISION_URL, forgedEncodedPayload]) {
      assert.equal(reopenedStartText.includes(forbidden), false, `forged vision argument survived restart: ${forbidden}`);
    }
    const recoveryOwner = fixture.processOwner;
    const reconciliation = await fixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(recoveryOwner, timestamp(20))
    );
    assert.equal(reconciliation.receiptRunResults.length, 1);
    assert.equal(reconciliation.receiptRunResults[0].action, "held");
    const held = (await fixture.repository.getIntegrationRun({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(held.recoveryState.status, "recovery_hold");
    const publicFinish = {
      runId: held.id,
      threadId: held.threadId,
      nativeSessionId: held.nativeSessionId,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: held.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 1,
      status: terminal.status,
      output: terminal.output,
      error: terminal.error,
      completedAt: terminal.completedAt,
      processOwner: recoveryOwner,
      expectedCursor: Object.freeze({ firstSeq: 1, lastSeq: 0, lastHash: ZERO_DIGEST, prunedThroughSeq: 0 }),
      outputEvent: Object.freeze({
        type: "output.delta",
        payload: Object.freeze({ text: terminal.output }),
        createdAt: terminal.completedAt,
      }),
      terminalEvent: Object.freeze({ type: "run.completed", payload: Object.freeze({}), createdAt: terminal.completedAt }),
      resultDigest: terminal.resultDigest,
    };
    await expectCode(
      () => fixture.repository.finishIntegrationRunWithOutbox(Object.freeze(publicFinish)),
      "RECOVERY_HOLD"
    );
    await fillReplayReceipts(fixture, { startIndex: 1_000, count: 20, startOffset: 21 });
    await compactRetainedIntegrationRuntimeRepository(fixture.repository);
    const delayedRecoverySnapshot = await fixture.repositoryState.loadDomainSnapshot();
    assert(
      delayedRecoverySnapshot.state.retention.replayCutoffAt >= terminal.completedAt,
      "recovery terminal timestamp must be behind the durable replay floor"
    );
    const recovered = await fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: publicFinish.expectedCursor,
    }));
    assert.equal(recovered.run.status, "completed");
    assert.equal(recovered.run.output, terminal.output);
    assert.equal(recovered.run.completedAt, terminal.completedAt);
    assert.equal(recovered.run.authority.snapshotHash, authorized.run.authority.snapshotHash);
    assert.equal(recovered.resultDigest, terminal.resultDigest);
    assert.equal(recovered.outboxEvents.length, 2);
    const replay = await fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
      runId: RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: publicFinish.expectedCursor,
    }));
    assert.equal(replay.outcome, "already-recovered");
    assert.equal(replay.run.id, RUN_ID);
    assert.equal(replay.resultDigest, terminal.resultDigest);
    await fillReplayReceipts(fixture, { startIndex: 1_020, count: 20, startOffset: 45 });
    await compactRetainedIntegrationRuntimeRepository(fixture.repository);
    const beforeExpiredRecoveryReplay = await fixture.repositoryState.loadDomainSnapshot();
    await expectCode(
      () => fixture.recovery.resolveRecoveryHeldRun(Object.freeze({
        runId: RUN_ID,
        principalId: PRINCIPAL,
        browserSessionId: BROWSER_SESSION,
        expectedCursor: publicFinish.expectedCursor,
      })),
      "INTEGRATION_REPOSITORY_REPLAY_WINDOW_EXPIRED"
    );
    const afterExpiredRecoveryReplay = await fixture.repositoryState.loadDomainSnapshot();
    assert.equal(afterExpiredRecoveryReplay.snapshotRevision, beforeExpiredRecoveryReplay.snapshotRevision);
    assert.equal(afterExpiredRecoveryReplay.integrityDigest, beforeExpiredRecoveryReplay.integrityDigest);

    const resumeOwner = fixture.processOwner;
    const resumed = await authorizeRepositoryResume(
      fixture,
      recovered.run,
      recovered.thread,
      resumeOwner
    );
    const resumeVisionScope = visionScope({ mode: "resume", runId: RESUME_RUN_ID });
    const resumeValid = await fixture.visionWorkspace.stageImageUpload({
      scope: resumeVisionScope,
      mimeType: "image/png",
      bytes: exactPng(2, 2, [15, 45, 75, 255]),
    });
    const resumeFailure = await fixture.visionWorkspace.stageImageUpload({
      scope: resumeVisionScope,
      mimeType: "image/png",
      bytes: exactPng(2, 1, [25, 55, 85, 255]),
    });
    const resumeEchoBytes = exactPng(3, 1, [145, 85, 25, 255]);
    const resumeEcho = await fixture.visionWorkspace.stageImageUpload({
      scope: resumeVisionScope,
      mimeType: "image/png",
      bytes: resumeEchoBytes,
    });
    const resumeRevoked = await fixture.visionWorkspace.stageImageUpload({
      scope: resumeVisionScope,
      mimeType: "image/png",
      bytes: exactPng(1, 2, [35, 65, 95, 255]),
    });
    await fixture.visionWorkspace.revokeImageReference({
      scope: resumeVisionScope,
      referenceId: resumeRevoked.reference.referenceId,
    });
    visionLoopback.setFailureReferenceId(resumeFailure.reference.referenceId);
    visionLoopback.setOutputEcho(resumeEcho.reference.referenceId, "wrapped");
    const resumeVisionEvents = [];
    const resumeVisionLogs = [];
    const resumeBaseConfig = buildFixedNativeRunAgentConfig({
      mode: "resume",
      policy: buildFixedIntegrationPolicy(),
      nativeSessionId: NATIVE_SESSION_ID,
      inputText: `Resume and inspect the retained PNG image reference ${resumeValid.reference.referenceId}.`,
      abortSignal: new AbortController().signal,
      onEvent(type, data) {
        resumeVisionEvents.push(Object.freeze({ type, data }));
      },
      onLog(type, data) {
        resumeVisionLogs.push(Object.freeze({ type, data }));
      },
      repositoryRoots: roots,
      expectedRuntimeRevision: 1,
      retainedNativeExecutionEvidence: fixture.evidence,
      retainedTextWorkspace: fixture.textWorkspace,
      retainedVisionWorkspace: fixture.visionWorkspace,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: THREAD_ID,
      runId: RESUME_RUN_ID,
    });
    const resumeConfig = deterministicRunAgentConfig(resumeBaseConfig, {
      mode: "resume",
      executionTier: "thorough",
      expectedRuntimeRevision: 1,
      evidence: fixture.evidence,
      textWorkspace: fixture.textWorkspace,
      visionWorkspace: fixture.visionWorkspace,
      revokedReferenceId: resumeRevoked.reference.referenceId,
      failureReferenceId: resumeFailure.reference.referenceId,
      outputEchoReferenceId: resumeEcho.reference.referenceId,
      validReferenceId: resumeValid.reference.referenceId,
      runId: RESUME_RUN_ID,
    });
    const resumeLegacyGuard = installLegacySessionRootGuard(legacySessionRoot);
    let resumePreflight;
    let resumePostflight;
    let resumedNativeResult;
    try {
      resumePreflight = await preflightNativeSessionRuntime(resumeConfig);
      assert.equal(resumePreflight.beforeRevision, 1);
      assert.equal(resumePreflight.expectedAfterRevision, 2);
      await bindRetainedNativeExecution(resumeConfig, {
        authorization: resumed.authorized.receipt,
        snapshotHash: resumed.authorized.run.authority.snapshotHash,
      });
      resumedNativeResult = await runWithIntegrationSessionScope(resumeConfig, () => runAgent(resumeConfig));
      resumePostflight = await postflightNativeSessionRuntime(resumeConfig, resumePreflight);
    } finally {
      resumeLegacyGuard.restore();
    }
    assert.deepEqual(resumeLegacyGuard.hits, []);
    assert.equal(resumeConfig.clientFactory.promptAudit.executionTier, "thorough");
    assert(resumeConfig.clientFactory.promptAudit.executionPayloads >= 7);
    const allCompletionRequests = visionLoopback.requests.filter((request) => request.url === "/v1/chat/completions");
    assert.equal(allCompletionRequests.length, 12);
    const resumeEventText = JSON.stringify(resumeVisionEvents);
    const resumeLogText = JSON.stringify(resumeVisionLogs);
    assert.doesNotMatch(resumeEventText, /data:image\/png;base64,|\/tmp\/private-vision\.png|sk-abcdefghijklmnop|echo=/u);
    assert.match(resumeEventText, /The exact loopback LocalLLM vision request failed/u);
    assert.match(resumeEventText, /The local vision response contained forbidden retained image data/u);
    const retainedResumeSnapshot = await fixture.sessionStateStore.loadSessionSnapshot(NATIVE_SESSION_ID);
    const retainedResumeText = JSON.stringify(retainedResumeSnapshot.state);
    for (const [label, text] of [
      ["resume runtime events", resumeEventText],
      ["resume runtime logs", resumeLogText],
      ["retained reopened resume state", retainedResumeText],
      ["resumed native result", resumedNativeResult.result],
    ]) {
      assertNoEncodedImageFragments(text, resumeEchoBytes, label);
      assertNoEncodedImageFragments(text, FORGED_WRAPPED_VISION_BYTES, label);
    }
    assert.equal(resumePostflight.revision, 2);
    const resumedTerminal = Object.freeze({
      status: "completed",
      output: resumedNativeResult.result,
      error: null,
      resultDigest: contractDigest({
        status: "completed",
        output: resumedNativeResult.result,
      }),
      completedAt: timestamp(62),
      persistedRuntimeRevision: 2,
    });
    await recordRetainedNativeTerminalEvidence(resumeConfig, resumedTerminal);
    const resumedReconciliation = await fixture.repository.reconcileIntegrationDispatches(
      reconciliationRequest(fixture.processOwner, timestamp(70))
    );
    assert.equal(resumedReconciliation.receiptRunResults.length, 1);
    assert.equal(resumedReconciliation.receiptRunResults[0].action, "held");
    const resumedHeld = (await fixture.repository.getIntegrationRun({
      runId: RESUME_RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
    })).run;
    assert.equal(resumedHeld.recoveryState.status, "recovery_hold");
    const resumedFinishPayload = Object.freeze({
      runId: RESUME_RUN_ID,
      threadId: THREAD_ID,
      nativeSessionId: NATIVE_SESSION_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedRevision: resumedHeld.revision,
      expectedNativeRuntimeRevision: 1,
      completedNativeRuntimeRevision: 2,
      status: resumedTerminal.status,
      output: resumedTerminal.output,
      error: null,
      completedAt: resumedTerminal.completedAt,
      processOwner: resumeOwner,
      expectedCursor: noEvidenceCursor,
      outputEvent: Object.freeze({
        type: "output.delta",
        payload: Object.freeze({ text: resumedTerminal.output }),
        createdAt: resumedTerminal.completedAt,
      }),
      terminalEvent: Object.freeze({
        type: "run.completed",
        payload: Object.freeze({}),
        createdAt: resumedTerminal.completedAt,
      }),
      resultDigest: resumedTerminal.resultDigest,
    });
    const staleTextProbe = await authorizeStaleTextProfileProbe(fixture, resumeOwner);
    const staleTextPreflight = await fixture.textWorkspace.prepareExecution(Object.freeze({
      mode: "start",
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      threadId: staleTextProbe.threadId,
      runId: staleTextProbe.runId,
      nativeSessionId: staleTextProbe.nativeSessionId,
    }));
    const staleTextExecution = await fixture.textWorkspace.bindAuthorizedExecution({
      authorization: staleTextProbe.authorized.receipt,
      snapshotHash: staleTextProbe.authorized.run.authority.snapshotHash,
      preflight: staleTextPreflight.handle,
    });
    const staleTextEventsBeforeHandoff = await fixture.textWorkspace.invoke(
      staleTextExecution,
      "loadEvents"
    );
    staleRuntimeFixture = await openSiblingFixture(rootPath, now, fixture);
    await expectCode(
      () => createRetainedIntegrationRuntimeNativeWriteFence(staleRuntimeFixture.repository, {
        processOwnerBootstrap,
        repositoryFenceLease: staleRuntimeFixture.acquiredFence.lease,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    const staleRuntimeAuthority = runtimeAuthorityForFixture(fixture);
    const beforeHandoffProof = await staleRuntimeAuthority.getIntegrationRuntimeProof();
    assert.equal(beforeHandoffProof.repositoryFence.acquired, true);
    assert.equal(beforeHandoffProof.repositoryFence.durablyCurrent, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.required, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.acquired, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.exactLexicalCapability, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.durablyCurrent, true);
    assert.equal(beforeHandoffProof.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(
      beforeHandoffProof.nativeWriteFence.attestationDigest,
      fixture.nativeWriteFence.attestation.digest
    );
    assert.equal(
      beforeHandoffProof.repositoryFence.leaseDigest,
      fixture.acquiredFence.lease.digest
    );
    successor = spawnSuccessor(rootPath);
    const successorReady = await successor.ready;
    await expectCode(
      () => handoffRetainedIntegrationRuntimeRepositoryFence(staleRuntimeFixture.repository, {
        currentProcessOwnerBootstrap: processOwnerBootstrap,
        successorProcessOwner: successorReady.processOwner,
        nativeWriteFence: fixture.nativeWriteFence,
      }),
      "INTEGRATION_NATIVE_WRITE_FENCE_UNAVAILABLE"
    );
    sessionLockBarrier = spawnSessionLockBarrier(path.join(
      rootPath,
      "native:sessions",
      INTEGRATION_RETAINED_SESSION_STATE_LOCK_FILE
    ));
    await sessionLockBarrier.locked;
    const completionOrder = [];
    const admittedCasPromise = fixture.sessionStateStore.compareAndSwapSessionSnapshot(
      Object.freeze({
        mutationId: "native-write-fence.admitted-before-handoff",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: 0,
        expectedIntegrityDigest: ZERO_DIGEST,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 1 }) }),
        }),
      })
    ).then((result) => {
      completionOrder[completionOrder.length] = "native-cas";
      return result;
    });
    await waitForFenceActivity(
      fixture.nativeWriteFence,
      (proof) => proof.activeWrites === 1 && proof.quiescing === false,
      "admitted CAS"
    );
    const handoffPromise = handoffRetainedIntegrationRuntimeRepositoryFence(fixture.repository, {
      currentProcessOwnerBootstrap: processOwnerBootstrap,
      successorProcessOwner: successorReady.processOwner,
      nativeWriteFence: fixture.nativeWriteFence,
    }).then((result) => {
      completionOrder[completionOrder.length] = "handoff";
      return result;
    });
    const drainingProof = await waitForFenceActivity(
      fixture.nativeWriteFence,
      (proof) => proof.activeWrites === 1 && proof.quiescing === true,
      "handoff drain"
    );
    assert.equal(drainingProof.quiesced, false);
    sessionLockBarrier.release();
    const barrierExit = await sessionLockBarrier.exited;
    assert.equal(barrierExit.code, 0, barrierExit.stderr);
    sessionLockBarrier = null;
    const [admittedCas, handoff] = await Promise.all([admittedCasPromise, handoffPromise]);
    assert.equal(admittedCas.outcome, "committed");
    assert.deepEqual(completionOrder, ["native-cas", "handoff"]);
    await expectCode(
      () => staleRuntimeAuthority.getIntegrationRuntimeProof(),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.textWorkspace.attestCurrent(),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => createRetainedIntegrationTextWorkspace({
        sessionStateStore: fixture.sessionStateStore,
        sessionStateStoreExpected: fixture.expected.sessionStateStore,
        nativeExecutionEvidence: fixture.evidence,
        nativeWriteFence: fixture.nativeWriteFence,
        repository: fixture.repository,
        recoveryCoordinator: fixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: fixture.acquiredFence.lease,
      }),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.textWorkspace.invoke(
        staleTextExecution,
        "appendEvent",
        ["native.write-fence.stale-text-profile", Object.freeze({ afterHandoff: true })]
      ),
      "INTEGRATION_NATIVE_WRITE_FENCE_STALE"
    );
    const staleTextEventsAfterHandoff = await fixture.textWorkspace.invoke(
      staleTextExecution,
      "loadEvents"
    );
    assert.deepEqual(staleTextEventsAfterHandoff, staleTextEventsBeforeHandoff);
    const successorRequest = Object.freeze({
      runId: RESUME_RUN_ID,
      principalId: PRINCIPAL,
      browserSessionId: BROWSER_SESSION,
      expectedCursor: noEvidenceCursor,
    });
    await expectCode(
      () => fixture.recovery.resolveRecoveryHeldRun(successorRequest),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    await expectCode(
      () => fixture.repository.finishIntegrationRunWithOutbox(resumedFinishPayload),
      "INTEGRATION_REPOSITORY_FENCE_STALE"
    );
    const staleRawBefore = await fixture.sessionStateStore.loadSessionSnapshot(rawProbeSessionId);
    await expectCode(
      () => fixture.sessionStateStore.compareAndSwapSessionSnapshot(Object.freeze({
        mutationId: "native-write-fence.stale-raw-cas",
        nativeSessionId: rawProbeSessionId,
        expectedPersistenceRevision: staleRawBefore.persistenceRevision,
        expectedIntegrityDigest: staleRawBefore.integrityDigest,
        state: Object.freeze({
          sessionId: rawProbeSessionId,
          meta: Object.freeze({ runtimeConfig: Object.freeze({ revision: 1 }) }),
        }),
      })),
      "INTEGRATION_NATIVE_WRITE_FENCE_STALE"
    );
    const staleRawAfter = await fixture.sessionStateStore.loadSessionSnapshot(rawProbeSessionId);
    assert.equal(staleRawAfter.persistenceRevision, staleRawBefore.persistenceRevision);
    assert.equal(staleRawAfter.integrityDigest, staleRawBefore.integrityDigest);
    const successorResult = await successor.command("resolve", successorRequest);
    assert.equal(successorResult.runId, RESUME_RUN_ID);
    assert.equal(successorResult.status, "completed");
    assert.equal(successorResult.runtimeRevision, 2);
    assert.equal(successorResult.replayOutcome, "already-recovered");
    assert.equal(successorResult.processOwnerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.persistedStatus, "completed");
    assert.equal(successorResult.persistedRuntimeRevision, 2);
    assert.equal(successorResult.persistedProcessOwnerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.fence.generation, handoff.fence.generation);
    assert.equal(successorResult.fence.ownerDigest, contractDigest(successorReady.processOwner));
    assert.equal(successorResult.fence.durablyCurrent, true);
    assert.equal(successorResult.nativeWriteFence.acquired, true);
    assert.equal(successorResult.nativeWriteFence.durablyCurrent, true);
    assert.equal(successorResult.nativeWriteFence.generation, successorResult.fence.generation);
    assert.equal(successorResult.nativeWriteFence.fenceDigest, successorResult.fence.fenceDigest);
    assert.equal(successorResult.nativeWriteFence.nativeSessionStateWriterFencing, true);
    assert.equal(successorResult.nativeWriteFence.fullSessionStoreSidecarsFenced, false);
    assert.equal(successorResult.nativeWriteFence.imagePerceptionSidecarsFenced, false);
    assert.equal(successorResult.textWorkspace.profile, INTEGRATION_TEXT_WORKSPACE_PROFILE_ID);
    assert.equal(successorResult.textWorkspace.durablyCurrent, true);
    assert.equal(successorResult.textWorkspace.nativeSessionStateWriterFencing, true);
    assert.equal(successorResult.textWorkspace.nativeSessionStateWriterQuiescenceProven, true);
    assert.equal(successorResult.textWorkspace.fullSessionStoreSidecarsFenced, false);
    assert.equal(successorResult.textWorkspace.imagePerceptionSidecarsFenced, false);
    assert.equal(
      successorResult.textWorkspace.nativeWriteFenceAttestationDigest,
      successorResult.nativeWriteFence.attestationDigest
    );
    assert.equal(
      successorResult.textWorkspace.currentProofDigest,
      successorResult.textWorkspace.runtimeProofDigest
    );
    assert.equal(successorResult.textWorkspace.runtimeNativeWriterFencing, true);
    assert.equal(successorResult.textWorkspace.runtimeNativeWriterQuiescence, true);
    assert.equal(successorResult.successorNativeWrite.outcome, "committed");
    assert.equal(successorResult.successorNativeWrite.persistenceRevision, 2);
    assert.equal(successorResult.successorNativeWrite.runtimeRevision, 2);
    assert.equal(successorResult.coordinatorFenceDigest, successorResult.fence.fenceDigest);
    assert.equal(successorResult.coordinatorLeaseDigest, successorResult.fence.leaseDigest);
    const successorExit = await successor.exited;
    assert.equal(successorExit.code, 0, successorExit.stderr);
    const closedTextWorkspace = mismatchFixture.textWorkspace;
    await mismatchFixture.authority.close();
    await expectCode(
      () => closedTextWorkspace.attestCurrent(),
      "INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE"
    );
    await expectCode(
      () => assertRetainedIntegrationTextWorkspaceCurrent(closedTextWorkspace, {
        nativeExecutionEvidence: mismatchFixture.evidence,
        nativeWriteFence: mismatchFixture.nativeWriteFence,
        repository: mismatchFixture.repository,
        recoveryCoordinator: mismatchFixture.recovery,
        processOwnerBootstrap,
        repositoryFenceLease: mismatchFixture.acquiredFence.lease,
      }),
      "INTEGRATION_TEXT_WORKSPACE_UNAVAILABLE"
    );
    assert.equal(fixture.recovery.attestation.publicRepositoryMethodCountUnchanged, true);
    assert.equal(fixture.evidence.attestation.fullSessionStoreRetained, false);
    console.log(JSON.stringify({
      ok: true,
      retainedPreflight: true,
      pathStateWriteAbsent: true,
      crashRestartRecovery: true,
      publicRecoveryBlocked: true,
      privateRecoveryCommitted: true,
      privateRecoveryReplay: true,
      delayedRecoveryPastReplayFloor: true,
      prunedRecoveryReplayExpired: true,
      immutableSnapshotHash: true,
      exactStorageBinding: true,
      exactSessionStateStoreIdentityBinding: true,
      stableSealSurvivesRestart: true,
      mismatchedStableRootRejected: true,
      samePathRepositoryLockReplacementRejected: true,
      maliciousFakePresealRejected: true,
      rawReopenedStoreWriteRejected: true,
      siblingSurfaceGuardRejected: true,
      staleRawCasRejectedBeforeCommit: true,
      admittedNativeCasDrainedBeforeHandoff: true,
      authorizationProcessOwnerBound: true,
      missingTerminalEvidenceHeld: true,
      historicalRecoveryReplayAfterReceiptPruningExpired: true,
      durableRuntimeProofReload: true,
      staleCoordinatorRejectedAfterHandoff: true,
      staleRepositoryMutationRejectedAfterHandoff: true,
      staleTextWorkspaceConstructionRejectedAfterHandoff: true,
      staleTextWorkspaceAttestationRejectedAfterHandoff: true,
      staleTextWorkspaceCasRejectedAfterHandoff: true,
      successorRecoveryAfterHandoff: true,
      successorNativeResumeWriteAfterHandoff: true,
      successorTextWorkspaceReopenedAfterHandoff: true,
      closedTextWorkspaceCurrentProofRejected: true,
      exactRuntimeNativeWriteFenceAttestation: true,
      textWorkspaceProfile: true,
      visionWorkspaceProfile: true,
      retainedPngReferencePerception: true,
      maximumInputSparseEchoElapsedMs: Number(sparseEchoElapsedMs.toFixed(1)),
      maximumInputNaturalOutputElapsedMs: Number(maximumInputElapsedMs.toFixed(1)),
      retainedHashChainedEventJournal: true,
      eventReplayAcrossResume: true,
      legacySessionRootAccess: false,
      pathOrHostedImagePerception: false,
      shellExecution: false,
      nativeSessionStateWriterFencing: true,
      nativeSessionStateWriterQuiescenceProven: true,
      fullSessionStoreSidecarsFenced: false,
      fullSessionStoreRetained: false,
      runtimeCapabilityEnabled: false,
    }));
  } finally {
    sessionLockBarrier?.terminate();
    successor?.terminate();
    await staleRuntimeFixture?.authority?.close?.().catch(() => {});
    await fixture?.authority.close().catch(() => {});
    await mismatchFixture?.authority.close().catch(() => {});
    await spliceFixture?.authority.close().catch(() => {});
    await spliceReplacementFixture?.authority.close().catch(() => {});
    await visionLoopback.close().catch(() => {});
    if (priorLocalLLMBaseURL === undefined) delete process.env.AGINTI_LOCALLLM_BASE_URL;
    else process.env.AGINTI_LOCALLLM_BASE_URL = priorLocalLLMBaseURL;
    if (priorLocalLLMApiKey === undefined) delete process.env.LOCALLLM_API_KEY;
    else process.env.LOCALLLM_API_KEY = priorLocalLLMApiKey;
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(mismatchRootPath, { recursive: true, force: true });
    await fs.rm(spliceRootPath, { recursive: true, force: true });
  }
}

if (CHILD_MODE === "successor") await runSuccessorChild();
else await run();
