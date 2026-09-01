import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import { sanitizeIntegrationArtifact } from "./integration-artifacts.js";
import {
  validateAgintiBrowserSession,
  validateAgintiPrincipalId,
  validateIntegrationBearerToken,
} from "./integration-auth.js";
import {
  FILE_WORKER_LIMITS,
  FILE_WORKER_PATTERNS,
  FILE_WORKER_ROUTES,
  FILE_WORKER_SCHEMA_VERSIONS,
  createFileWorkerIssuanceId,
  digestFileWorkerContent,
  digestFileWorkerPublishOperation,
  fileWorkerArtifactsDigest,
  fileWorkerDeletionManifestDigest,
  fileWorkerManifestDigest,
  normalizeFileWorkerFilename,
  validateFileWorkerArtifacts,
  validateFileWorkerCommitRequest,
  validateFileWorkerContentRequest,
  validateFileWorkerDeleteRequest,
  validateFileWorkerMimeAndFilename,
  validateFileWorkerPublishRequest,
  validateFileWorkerReceipt,
  publicFileWorkerPublishRequest,
} from "./integration-file-worker-contract.js";
import {
  AGENT_WORKER_SCHEMA_VERSION,
  canonicalJson,
  contractDigest,
  validateIntegrationRunId,
  validateIntegrationThreadId,
} from "./integration-policy.js";

export const INTEGRATION_FILE_WORKER_SCHEMA_VERSION = "aginti-file-worker-client-v1";
export const INTEGRATION_FILE_WORKER_ACTIVATION_SCHEMA_VERSION = "aginti-file-worker-client-activation-v1";
export const INTEGRATION_FILE_WORKER_TOOL_NAME = "create_artifact_files";
export const INTEGRATION_FILE_WORKER_ENDPOINT = "http://127.0.0.1:18121";
export const INTEGRATION_FILE_WORKER_TIMEOUT_MS = 120_000;
export const INTEGRATION_FILE_WORKER_INTENT_CANDIDATE_SCHEMA_VERSION =
  "aginti-file-worker-publish-intent-candidate-v1";
export const INTEGRATION_FILE_WORKER_ISSUE_INTENT_SCHEMA_VERSION =
  "aginti-file-worker-issue-intent-v1";

const CLIENT_BRAND = new WeakSet();
const CLIENT_METADATA = new WeakMap();
const ACTIVATION_METADATA = new WeakMap();
const FILE_METADATA = new WeakMap();
const COMMIT_METADATA = new WeakMap();
const MAXIMUM_JSON_BYTES = 128 * 1024;
const MAXIMUM_REQUEST_BYTES = 1024 * 1024;

export class IntegrationFileWorkerError extends Error {
  constructor(code, message, { status = 503, cause, workerCode = "" } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationFileWorkerError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
    this.workerCode = workerCode;
    this.retryable = status === 503 || status === 504;
  }
}

function fail(code, message, options) {
  throw new IntegrationFileWorkerError(code, message, options);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, allowed, required, label, { code = "FILE_WORKER_PROTOCOL_INVALID", status = 502 } = {}) {
  if (!plain(value)) fail(code, `${label} must be a plain data object.`, { status });
  const accepted = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (typeof key !== "string" || !accepted.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(code, `${label} contains an unsupported field.`, { status });
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(code, `${label}.${key} is required.`, { status });
  return value;
}

function denseArray(value, minimum, maximum, label, { code = "FILE_WORKER_INVALID", status = 400 } = {}) {
  if (
    !Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum || value.length > maximum
  ) fail(code, `${label} is outside its bound.`, { status });
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(code, `${label} must be dense.`, { status });
  }
  return value;
}

function normalizeScope(value, { includeRun = true } = {}) {
  const keys = includeRun
    ? ["principalId", "browserSessionId", "threadId", "runId"]
    : ["principalId", "browserSessionId", "threadId"];
  const scope = exact(value, keys, keys, "file worker scope", { code: "FILE_WORKER_INVALID", status: 400 });
  try {
    return Object.freeze({
      principalId: validateAgintiPrincipalId(scope.principalId),
      browserSessionId: validateAgintiBrowserSession(scope.browserSessionId),
      threadId: validateIntegrationThreadId(scope.threadId),
      ...(includeRun ? { runId: validateIntegrationRunId(scope.runId) } : {}),
    });
  } catch (cause) {
    fail("FILE_WORKER_INVALID", "File worker scope is invalid.", { status: 400, cause });
  }
}

function normalizeEndpoint(value, { testOnly }) {
  let parsed;
  try { parsed = new URL(value); } catch (cause) {
    fail("FILE_WORKER_CONFIGURATION_INVALID", "File worker endpoint is invalid.", { status: 500, cause });
  }
  const production = parsed.origin === INTEGRATION_FILE_WORKER_ENDPOINT && parsed.href === `${INTEGRATION_FILE_WORKER_ENDPOINT}/`;
  const test = parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" &&
    Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535 && parsed.pathname === "/" &&
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  if (testOnly ? !test : !production) {
    fail("FILE_WORKER_CONFIGURATION_INVALID", "File worker endpoint is not the fixed private route.", { status: 500 });
  }
  return parsed.origin;
}

function normalizeFiles(value) {
  const files = denseArray(value, 1, FILE_WORKER_LIMITS.maximumFiles, "file worker files");
  const normalized = files.map((raw, index) => {
    const item = exact(raw, ["filename", "mime", "encoding", "content"], ["filename", "mime", "content"], `file worker files[${index}]`, {
      code: "FILE_WORKER_INVALID",
      status: 400,
    });
    let presentation;
    try {
      presentation = validateFileWorkerMimeAndFilename(item.mime, item.filename);
    } catch (cause) {
      fail("FILE_WORKER_INVALID", "File MIME and filename are invalid.", { status: 400, cause });
    }
    const encoding = item.encoding ?? "utf8";
    let bytes;
    if (encoding === "utf8") {
      if (typeof item.content !== "string" || !item.content.isWellFormed() || item.content.includes("\u0000")) {
        fail("FILE_WORKER_INVALID", "File UTF-8 content is invalid.", { status: 400 });
      }
      bytes = Buffer.from(item.content, "utf8");
    } else if (encoding === "base64") {
      if (typeof item.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.content)) {
        fail("FILE_WORKER_INVALID", "File base64 content is invalid.", { status: 400 });
      }
      bytes = Buffer.from(item.content, "base64");
      if (bytes.toString("base64") !== item.content) fail("FILE_WORKER_INVALID", "File base64 content is not canonical.", { status: 400 });
    } else {
      fail("FILE_WORKER_INVALID", "File content encoding is unsupported.", { status: 400 });
    }
    if (bytes.byteLength < 1 || bytes.byteLength > FILE_WORKER_LIMITS.maximumFileBytes) {
      bytes.fill(0);
      fail("FILE_WORKER_INVALID", "File content is outside its byte bound.", { status: 400 });
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const normalizedFile = Object.freeze({
      index,
      ...presentation,
      bytes: bytes.byteLength,
      sha256,
      encoding,
      content: item.content,
    });
    bytes.fill(0);
    return normalizedFile;
  });
  const names = new Set(normalized.map(({ filename }) => filename.toLowerCase()));
  const totalBytes = normalized.reduce((sum, file) => sum + file.bytes, 0);
  if (names.size !== normalized.length || totalBytes > FILE_WORKER_LIMITS.maximumBundleBytes) {
    fail("FILE_WORKER_INVALID", "File bundle names or total bytes are invalid.", { status: 400 });
  }
  return Object.freeze(normalized);
}

function candidates(files) {
  return Object.freeze(files.map(({ index, filename, mime, bytes, sha256 }) => Object.freeze({
    index, filename, mime, bytes, sha256,
  })));
}

function abortFor(signal, timeoutMs) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("FILE_WORKER_INVALID", "File worker signal is invalid.", { status: 400 });
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || new Error("file worker request cancelled"));
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("file worker request timed out")), timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  });
}

async function readJson(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAXIMUM_JSON_BYTES)) {
    response.body?.cancel?.().catch?.(() => {});
    fail("FILE_WORKER_PROTOCOL_INVALID", "File worker JSON length is invalid.", { status: 502 });
  }
  if (signal?.aborted) throw signal.reason;
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_JSON_BYTES) fail("FILE_WORKER_PROTOCOL_INVALID", "File worker JSON is too large.", { status: 502 });
  try { return JSON.parse(text); } catch (cause) {
    fail("FILE_WORKER_PROTOCOL_INVALID", "File worker JSON is invalid.", { status: 502, cause });
  }
}

async function workerError(response, signal) {
  const value = await readJson(response, signal).catch(() => null);
  return String(value?.error?.code || "INTERNAL_ERROR");
}

function translate(code, status) {
  if (status === 404 || status === 410 || status === 416) return new IntegrationFileWorkerError(code, "File artifact is unavailable.", { status, workerCode: code });
  if (status === 409) return new IntegrationFileWorkerError("FILE_WORKER_CONFLICT", "File artifact request conflicts with durable state.", { status, workerCode: code });
  if (status === 400 || status === 413 || status === 422) return new IntegrationFileWorkerError("FILE_WORKER_INVALID", "File artifact request was rejected.", { status, workerCode: code });
  return new IntegrationFileWorkerError("ANALYSIS_FILE_WORKER_UNAVAILABLE", "The private workstation file worker is unavailable.", {
    status: 503,
    workerCode: code,
  });
}

function contentDisposition(filename) {
  const fallback = filename.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 120) || "artifact";
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createClient(optionsValue, { testOnly }) {
  const allowed = testOnly ? ["endpoint", "credential", "timeoutMs", "fetchImpl"] : ["endpoint", "credential", "timeoutMs"];
  const required = testOnly ? ["endpoint", "credential", "fetchImpl"] : ["endpoint", "credential"];
  const options = exact(optionsValue, allowed, required, "file worker client configuration", {
    code: "FILE_WORKER_CONFIGURATION_INVALID",
    status: 500,
  });
  const endpoint = normalizeEndpoint(options.endpoint, { testOnly });
  let credential;
  try { credential = validateIntegrationBearerToken(options.credential, { field: "file artifact edge credential" }); } catch (cause) {
    fail("FILE_WORKER_CONFIGURATION_INVALID", "File artifact edge credential is invalid.", { status: 500, cause });
  }
  const timeoutMs = options.timeoutMs ?? INTEGRATION_FILE_WORKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    fail("FILE_WORKER_CONFIGURATION_INVALID", "File worker timeout is invalid.", { status: 500 });
  }
  const fetchImpl = testOnly ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("FILE_WORKER_CONFIGURATION_INVALID", "File worker fetch is unavailable.", { status: 500 });
  let activation = null;
  let activationPromise = null;

  const headers = (accept = "application/json") => Object.freeze({
    Accept: accept,
    Authorization: `Bearer ${credential}`,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  const body = (value) => {
    const text = canonicalJson(value);
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_REQUEST_BYTES) fail("FILE_WORKER_INVALID", "File worker request is too large.", { status: 413 });
    return text;
  };

  async function post(pathname, value, { signal, accept = "application/json" } = {}) {
    const abort = abortFor(signal, timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${pathname}`, {
        method: "POST",
        headers: headers(accept),
        body: body(value),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      return Object.freeze({ response, abort });
    } catch (cause) {
      abort.cleanup();
      if (signal?.aborted) fail("ANALYSIS_CANCELLED", "File worker request was cancelled.", { status: 499, cause });
      fail("ANALYSIS_FILE_WORKER_UNAVAILABLE", "The private workstation file worker is unavailable.", { status: 503, cause });
    }
  }

  function validateCapabilities(value) {
    const capability = exact(value, ["schemaVersion", "ready", "creationEnabled", "authorityEpoch", "protocols", "limits", "storage", "digest"], [
      "schemaVersion", "ready", "creationEnabled", "authorityEpoch", "protocols", "limits", "storage", "digest",
    ], "file worker capabilities");
    exact(capability.protocols, ["issue", "publish", "commit", "content", "delete"], ["issue", "publish", "commit", "content", "delete"], "file worker protocols");
    exact(capability.limits, ["maximumFiles", "maximumFileBytes", "maximumBundleBytes"], ["maximumFiles", "maximumFileBytes", "maximumBundleBytes"], "file worker limits");
    exact(capability.storage, ["durable", "restartStableRefs", "rangeReads", "twoPhaseDelete", "cloudBytePersistence"], [
      "durable", "restartStableRefs", "rangeReads", "twoPhaseDelete", "cloudBytePersistence",
    ], "file worker storage");
    const { digest, ...unsigned } = capability;
    if (
      capability.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.readinessResponse || capability.ready !== true ||
      typeof capability.creationEnabled !== "boolean" || !Number.isSafeInteger(capability.authorityEpoch) || capability.authorityEpoch < 1 ||
      canonicalJson(capability.protocols) !== canonicalJson({
        issue: FILE_WORKER_SCHEMA_VERSIONS.issueRequest,
        publish: FILE_WORKER_SCHEMA_VERSIONS.publishRequest,
        commit: FILE_WORKER_SCHEMA_VERSIONS.commitRequest,
        content: FILE_WORKER_SCHEMA_VERSIONS.contentRequest,
        delete: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
      }) ||
      canonicalJson(capability.limits) !== canonicalJson(FILE_WORKER_LIMITS) && canonicalJson(capability.limits) !== canonicalJson({
        maximumFiles: FILE_WORKER_LIMITS.maximumFiles,
        maximumFileBytes: FILE_WORKER_LIMITS.maximumFileBytes,
        maximumBundleBytes: FILE_WORKER_LIMITS.maximumBundleBytes,
      }) ||
      capability.storage.durable !== true || capability.storage.restartStableRefs !== true ||
      capability.storage.rangeReads !== true || capability.storage.twoPhaseDelete !== true ||
      capability.storage.cloudBytePersistence !== false || !FILE_WORKER_PATTERNS.digest.test(digest) ||
      contractDigest(unsigned) !== digest
    ) fail("FILE_WORKER_PROTOCOL_INVALID", "File worker capabilities are invalid.", { status: 502 });
    return Object.freeze({ ...unsigned, digest });
  }

  async function activate(options = {}) {
    if (activation) return activation;
    if (activationPromise) return activationPromise;
    activationPromise = (async () => {
      const call = await post(FILE_WORKER_ROUTES.readiness, {
        schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.readinessRequest,
      }, { signal: options.signal });
      try {
        if (call.response.status !== 200) throw translate(await workerError(call.response, call.abort.signal), call.response.status);
        const capabilities = validateCapabilities(await readJson(call.response, call.abort.signal));
        const unsigned = {
          schemaVersion: INTEGRATION_FILE_WORKER_ACTIVATION_SCHEMA_VERSION,
          owner: "aginti",
          authority: "workstation-file-worker",
          ready: true,
          creationEnabled: capabilities.creationEnabled,
          authorityEpoch: capabilities.authorityEpoch,
          privateLoopback: true,
          credentialRequired: true,
          callerSelectableEndpoint: false,
          cloudBytePersistence: false,
          endpointDigest: contractDigest({ endpoint }),
          capabilitiesDigest: capabilities.digest,
        };
        activation = Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
        ACTIVATION_METADATA.set(activation, Object.freeze({ client, testOnly }));
        return activation;
      } finally { call.abort.cleanup(); }
    })().finally(() => { activationPromise = null; });
    return activationPromise;
  }

  async function publish(scopeValue, inputValue, optionsValue = {}) {
    const options = exact(optionsValue, ["signal", "authorizeRequest"], [], "file publish options", { code: "FILE_WORKER_INVALID", status: 400 });
    if (options.authorizeRequest !== undefined && typeof options.authorizeRequest !== "function") {
      fail("FILE_WORKER_INVALID", "File publish authorizer is invalid.", { status: 400 });
    }
    const current = await activate(options.signal === undefined ? {} : { signal: options.signal });
    if (!current.creationEnabled) fail("ANALYSIS_FILE_WORKER_UNAVAILABLE", "Workstation file creation is disabled.", { status: 503 });
    const scope = normalizeScope(scopeValue);
    const input = exact(inputValue, ["files"], ["files"], "file publish input", { code: "FILE_WORKER_INVALID", status: 400 });
    const files = normalizeFiles(input.files);
    const manifests = candidates(files);
    const contentDigest = digestFileWorkerContent({ scope, files: manifests });
    const candidate = Object.freeze({
      schemaVersion: INTEGRATION_FILE_WORKER_INTENT_CANDIDATE_SCHEMA_VERSION,
      authorityEpoch: current.authorityEpoch,
      scope,
      files: manifests,
      contentDigest,
    });
    let issueIntent = options.authorizeRequest === undefined
      ? Object.freeze({
          schemaVersion: INTEGRATION_FILE_WORKER_ISSUE_INTENT_SCHEMA_VERSION,
          issuanceId: createFileWorkerIssuanceId(current.authorityEpoch),
          authorityEpoch: current.authorityEpoch,
          contentDigest,
        })
      : await options.authorizeRequest(candidate);
    issueIntent = exact(issueIntent, ["schemaVersion", "issuanceId", "authorityEpoch", "contentDigest"], [
      "schemaVersion", "issuanceId", "authorityEpoch", "contentDigest",
    ], "file issue intent", { code: "FILE_WORKER_INVALID", status: 409 });
    if (
      issueIntent.schemaVersion !== INTEGRATION_FILE_WORKER_ISSUE_INTENT_SCHEMA_VERSION ||
      !FILE_WORKER_PATTERNS.issuanceId.test(issueIntent.issuanceId) || issueIntent.authorityEpoch !== current.authorityEpoch ||
      issueIntent.contentDigest !== contentDigest
    ) fail("FILE_WORKER_INVALID", "File issue intent is invalid.", { status: 409 });
    const issueRequest = Object.freeze({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.issueRequest,
      issuanceId: issueIntent.issuanceId,
      authorityEpoch: issueIntent.authorityEpoch,
      scope,
      files: manifests,
    });
    const issueCall = await post(FILE_WORKER_ROUTES.issue, issueRequest, { signal: options.signal });
    let issued;
    try {
      if (issueCall.response.status !== 200) throw translate(await workerError(issueCall.response, issueCall.abort.signal), issueCall.response.status);
      const value = exact(await readJson(issueCall.response, issueCall.abort.signal), [
        "schemaVersion", "issuanceId", "requestId", "authorityEpoch", "authorityToken", "contentDigest", "digest",
      ], ["schemaVersion", "issuanceId", "requestId", "authorityEpoch", "authorityToken", "contentDigest", "digest"], "file issue response");
      const { digest, ...unsigned } = value;
      if (
        value.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.issueResponse || value.issuanceId !== issueIntent.issuanceId ||
        !FILE_WORKER_PATTERNS.requestId.test(value.requestId) || value.authorityEpoch !== issueIntent.authorityEpoch ||
        !FILE_WORKER_PATTERNS.authorityToken.test(value.authorityToken) || value.contentDigest !== contentDigest ||
        !FILE_WORKER_PATTERNS.digest.test(digest) || contractDigest(unsigned) !== digest
      ) fail("FILE_WORKER_PROTOCOL_INVALID", "File issue response is invalid.", { status: 502 });
      issued = Object.freeze({ ...unsigned, digest });
    } finally { issueCall.abort.cleanup(); }
    const proposed = Object.freeze({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.publishRequest,
      issuanceId: issued.issuanceId,
      requestId: issued.requestId,
      authorityEpoch: issued.authorityEpoch,
      authorityToken: issued.authorityToken,
      scope,
      files,
    });
    let request = proposed;
    if (options.authorizeRequest !== undefined) {
      request = publicFileWorkerPublishRequest(validateFileWorkerPublishRequest(await options.authorizeRequest(proposed)));
    }
    if (digestFileWorkerPublishOperation(request) !== digestFileWorkerPublishOperation(proposed)) {
      fail("FILE_WORKER_INVALID", "File publish authority conflicts with content.", { status: 409 });
    }
    const call = await post(FILE_WORKER_ROUTES.publish, request, { signal: options.signal });
    try {
      if (call.response.status !== 200) throw translate(await workerError(call.response, call.abort.signal), call.response.status);
      const value = exact(await readJson(call.response, call.abort.signal), ["schemaVersion", "requestId", "receipt", "artifacts"], [
        "schemaVersion", "requestId", "receipt", "artifacts",
      ], "file publish response");
      if (value.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.publishResponse || value.requestId !== request.requestId) {
        fail("FILE_WORKER_PROTOCOL_INVALID", "File publish response identity is invalid.", { status: 502 });
      }
      const receipt = validateFileWorkerReceipt(value.receipt);
      const artifacts = validateFileWorkerArtifacts(value.artifacts);
      const scopeDigests = {
        ownerDigest: contractDigest({
          schemaVersion: "aginti-document-worker-owner-v1",
          principalId: scope.principalId,
          browserSessionId: scope.browserSessionId,
        }),
      };
      scopeDigests.threadDigest = contractDigest({
        schemaVersion: "aginti-document-worker-thread-v1",
        ownerDigest: scopeDigests.ownerDigest,
        threadId: scope.threadId,
      });
      scopeDigests.runDigest = contractDigest({
        schemaVersion: "aginti-document-worker-run-v1",
        threadDigest: scopeDigests.threadDigest,
        runId: scope.runId,
      });
      if (
        receipt.requestId !== request.requestId || receipt.requestDigest !== digestFileWorkerPublishOperation(request) ||
        receipt.artifactsDigest !== fileWorkerArtifactsDigest(artifacts) || receipt.fileCount !== artifacts.length ||
        receipt.ownerDigest !== scopeDigests.ownerDigest || receipt.threadDigest !== scopeDigests.threadDigest ||
        receipt.runDigest !== scopeDigests.runDigest
      ) fail("FILE_WORKER_PROTOCOL_INVALID", "File publish receipt binding is invalid.", { status: 502 });
      const publicArtifacts = artifacts.map((artifact) => {
        const publicArtifact = sanitizeIntegrationArtifact({
          id: `art_${contractDigest({ schemaVersion: "aginti-file-worker-public-artifact-v1", receiptDigest: receipt.digest, ref: artifact.ref })}`,
          title: artifact.filename,
          kind: "file",
          spec: {
            schemaVersion: AGENT_WORKER_SCHEMA_VERSION,
            filename: artifact.filename,
            mime: artifact.mime,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          },
        });
        FILE_METADATA.set(publicArtifact, Object.freeze({
          profile: "file-bundle-v1",
          workerRef: artifact.ref,
          index: artifact.index,
          receipt,
          scope,
        }));
        return publicArtifact;
      });
      return Object.freeze({
        schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.publishResponse,
        requestId: request.requestId,
        requestDigest: receipt.requestDigest,
        receipt,
        artifacts: Object.freeze(publicArtifacts),
      });
    } finally { call.abort.cleanup(); }
  }

  async function commitArtifacts(scopeValue, value, options = {}) {
    const scope = normalizeScope(scopeValue);
    const input = exact(value, ["receiptDigest", "artifacts", "objects"], ["receiptDigest"], "file commit input", {
      code: "FILE_WORKER_INVALID",
      status: 400,
    });
    if (!FILE_WORKER_PATTERNS.digest.test(input.receiptDigest) || (input.artifacts === undefined) === (input.objects === undefined)) {
      fail("FILE_WORKER_INVALID", "File commit input is invalid.", { status: 400 });
    }
    let objects;
    if (input.artifacts !== undefined) {
      const artifacts = denseArray(input.artifacts, 1, FILE_WORKER_LIMITS.maximumFiles, "file commit artifacts");
      objects = Object.freeze(artifacts.map((artifact, index) => {
        const metadata = inspectIntegrationFileWorkerArtifact(artifact);
        if (!metadata || metadata.index !== index || metadata.receipt.digest !== input.receiptDigest || canonicalJson(metadata.scope) !== canonicalJson(scope)) {
          fail("FILE_WORKER_INVALID", "File commit authority is invalid.", { status: 400 });
        }
        return Object.freeze({ ref: metadata.workerRef, index, sha256: artifact.spec.sha256 });
      }));
    } else {
      objects = Object.freeze(denseArray(input.objects, 1, FILE_WORKER_LIMITS.maximumFiles, "file commit objects").map((raw, index) => {
        const item = exact(raw, ["ref", "index", "sha256"], ["ref", "index", "sha256"], `file commit object ${index}`, {
          code: "FILE_WORKER_INVALID", status: 400,
        });
        return Object.freeze({ ref: item.ref, index: item.index, sha256: item.sha256 });
      }));
    }
    const request = validateFileWorkerCommitRequest({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.commitRequest,
      requestId: `fcmt_${contractDigest({ schemaVersion: "aginti-file-worker-commit-id-v1", scope, receiptDigest: input.receiptDigest, manifestDigest: fileWorkerManifestDigest(objects) })}`,
      scope,
      receiptDigest: input.receiptDigest,
      objects,
    });
    const call = await post(FILE_WORKER_ROUTES.commit, request, { signal: options.signal });
    try {
      if (call.response.status !== 200) throw translate(await workerError(call.response, call.abort.signal), call.response.status);
      const response = exact(await readJson(call.response, call.abort.signal), [
        "schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest",
      ], ["schemaVersion", "requestId", "receiptDigest", "status", "manifestDigest", "committedAt", "digest"], "file commit response");
      const { digest, ...unsigned } = response;
      if (
        response.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.commitResponse || response.requestId !== request.requestId ||
        response.receiptDigest !== request.receiptDigest || response.status !== "committed" ||
        response.manifestDigest !== fileWorkerManifestDigest(request.objects) || !Number.isFinite(Date.parse(response.committedAt)) ||
        new Date(response.committedAt).toISOString() !== response.committedAt || contractDigest(unsigned) !== digest
      ) fail("FILE_WORKER_PROTOCOL_INVALID", "File commit response is invalid.", { status: 502 });
      const commit = Object.freeze({ ...unsigned, digest });
      if (input.artifacts) for (const artifact of input.artifacts) COMMIT_METADATA.set(artifact, commit);
      return commit;
    } finally { call.abort.cleanup(); }
  }

  async function content(scopeValue, inputValue, options = {}) {
    const scope = normalizeScope(scopeValue);
    const input = exact(inputValue, ["ref", "receiptDigest", "filename", "mime", "bytes", "sha256", "metadataOnly", "range"], [
      "ref", "receiptDigest", "filename", "mime", "bytes", "sha256", "metadataOnly",
    ], "file content input", { code: "FILE_WORKER_INVALID", status: 400 });
    const presentation = validateFileWorkerMimeAndFilename(input.mime, input.filename);
    if (
      !FILE_WORKER_PATTERNS.objectRef.test(input.ref) || !FILE_WORKER_PATTERNS.digest.test(input.receiptDigest) ||
      !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > FILE_WORKER_LIMITS.maximumFileBytes ||
      !FILE_WORKER_PATTERNS.digest.test(input.sha256) || typeof input.metadataOnly !== "boolean"
    ) fail("FILE_WORKER_INVALID", "File content metadata is invalid.", { status: 400 });
    const request = validateFileWorkerContentRequest({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.contentRequest,
      scope,
      ref: input.ref,
      receiptDigest: input.receiptDigest,
      metadataOnly: input.metadataOnly,
      ...(input.range === undefined ? {} : { range: input.range }),
    });
    const call = await post(FILE_WORKER_ROUTES.content, request, { signal: options.signal, accept: `${presentation.mime}, application/json` });
    const response = call.response;
    if ([404, 410, 416].includes(response.status)) {
      const workerCode = await workerError(response, call.abort.signal);
      call.abort.cleanup();
      return Object.freeze({ status: response.status, workerCode });
    }
    if (response.status !== (request.range === undefined ? 200 : 206)) {
      const error = translate(await workerError(response, call.abort.signal), response.status);
      call.abort.cleanup();
      throw error;
    }
    const selectedBytes = Number(response.headers.get(request.metadataOnly ? "x-artifact-content-length" : "content-length"));
    let start = 0;
    let end = input.bytes - 1;
    if (request.range) {
      const match = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/u.exec(response.headers.get("content-range") || "");
      start = Number(match?.[1]);
      end = Number(match?.[2]);
      if (Number(match?.[3]) !== input.bytes || start !== request.range.start || end < start || end >= input.bytes) {
        call.abort.cleanup();
        fail("FILE_WORKER_PROTOCOL_INVALID", "File content range is invalid.", { status: 502 });
      }
    }
    if (
      response.headers.get("cache-control") !== "no-store, private" || response.headers.get("x-content-type-options") !== "nosniff" ||
      response.headers.get("content-type") !== presentation.mime || response.headers.get("etag") !== `"${input.sha256}"` ||
      response.headers.get("content-disposition") !== contentDisposition(presentation.filename) ||
      !Number.isSafeInteger(selectedBytes) || selectedBytes !== end - start + 1 ||
      (request.metadataOnly && response.headers.get("content-length") !== "0")
    ) {
      call.abort.cleanup();
      response.body?.cancel?.().catch?.(() => {});
      fail("FILE_WORKER_PROTOCOL_INVALID", "File content headers are invalid.", { status: 502 });
    }
    if (request.metadataOnly) {
      call.abort.cleanup();
      return Object.freeze({
        status: response.status, start, end, selectedBytes, totalBytes: input.bytes,
        filename: presentation.filename, mime: presentation.mime, sha256: input.sha256,
        metadataOnly: true, body: null, cleanup() {},
      });
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      call.abort.cleanup();
      fail("FILE_WORKER_PROTOCOL_INVALID", "File content stream is unavailable.", { status: 502 });
    }
    return Object.freeze({
      status: response.status, start, end, selectedBytes, totalBytes: input.bytes,
      filename: presentation.filename, mime: presentation.mime, sha256: input.sha256,
      metadataOnly: false, body: response.body, cleanup: call.abort.cleanup,
    });
  }

  async function deleteObjects(scopeValue, inputValue, options = {}) {
    const scope = normalizeScope(scopeValue, { includeRun: false });
    const input = exact(inputValue, ["deletionId", "phase", "objects"], ["deletionId", "phase", "objects"], "file delete input", {
      code: "FILE_WORKER_INVALID", status: 400,
    });
    const request = validateFileWorkerDeleteRequest({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
      deletionId: input.deletionId,
      phase: input.phase,
      scope,
      objects: input.objects,
    });
    const call = await post(FILE_WORKER_ROUTES.delete, request, { signal: options.signal });
    try {
      if (call.response.status !== 200) throw translate(await workerError(call.response, call.abort.signal), call.response.status);
      const response = exact(await readJson(call.response, call.abort.signal), [
        "schemaVersion", "deletionId", "phase", "status", "manifestDigest", "tombstoneDigest", "completedAt", "digest",
      ], ["schemaVersion", "deletionId", "phase", "status", "manifestDigest", "tombstoneDigest", "completedAt", "digest"], "file delete response");
      const { digest, ...unsigned } = response;
      if (
        response.schemaVersion !== FILE_WORKER_SCHEMA_VERSIONS.deleteResponse || response.deletionId !== request.deletionId ||
        response.phase !== request.phase || !new Set(["prepared", "committed"]).has(response.status) ||
        response.manifestDigest !== fileWorkerDeletionManifestDigest(request) || contractDigest(unsigned) !== digest
      ) fail("FILE_WORKER_PROTOCOL_INVALID", "File delete response is invalid.", { status: 502 });
      return Object.freeze({ ...unsigned, digest });
    } finally { call.abort.cleanup(); }
  }

  const attestationUnsigned = {
    schemaVersion: INTEGRATION_FILE_WORKER_SCHEMA_VERSION,
    owner: "aginti",
    authority: "cloud-file-broker",
    transport: testOnly ? "test-only-injected-fetch" : "fixed-private-loopback-fetch",
    testOnly,
    endpointDigest: contractDigest({ endpoint }),
    credentialRequired: true,
    callerSelectableEndpoint: false,
    contentStreamsWithoutBuffering: true,
    cloudBytePersistence: false,
    twoPhaseDelete: true,
    timeoutMs,
  };
  const attestation = Object.freeze({ ...attestationUnsigned, digest: contractDigest(attestationUnsigned) });
  const client = Object.freeze({
    attestation,
    activate,
    publish,
    commitArtifacts,
    content,
    deleteObjects,
    get ready() { return activation !== null; },
  });
  CLIENT_BRAND.add(client);
  CLIENT_METADATA.set(client, Object.freeze({ testOnly }));
  return client;
}

export function inspectIntegrationFileWorkerArtifact(value) {
  return FILE_METADATA.get(value) || null;
}

export function inspectIntegrationFileWorkerCommit(value) {
  return COMMIT_METADATA.get(value) || null;
}

export function assertIntegrationFileWorkerClient(value, { allowTestOnly = false } = {}) {
  if (!value || !CLIENT_BRAND.has(value)) throw new TypeError("file worker client is not AgInTi-owned");
  if (!allowTestOnly && CLIENT_METADATA.get(value)?.testOnly) throw new TypeError("test file worker client is not production-capable");
  return value;
}

export function assertIntegrationFileWorkerActivation(value, { client, allowTestOnly = false } = {}) {
  const metadata = value && ACTIVATION_METADATA.get(value);
  if (!metadata || !Object.isFrozen(value)) throw new TypeError("file worker activation is not AgInTi-owned");
  if (!allowTestOnly && metadata.testOnly) throw new TypeError("file worker activation is test-only");
  if (client !== undefined && metadata.client !== assertIntegrationFileWorkerClient(client, { allowTestOnly })) {
    throw new TypeError("file worker activation belongs to another client");
  }
  const { digest, ...unsigned } = value;
  if (
    value.schemaVersion !== INTEGRATION_FILE_WORKER_ACTIVATION_SCHEMA_VERSION || value.owner !== "aginti" ||
    value.authority !== "workstation-file-worker" || value.ready !== true || typeof value.creationEnabled !== "boolean" ||
    !Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1 || value.cloudBytePersistence !== false ||
    contractDigest(unsigned) !== digest
  ) throw new TypeError("file worker activation identity is invalid");
  return value;
}

export function createIntegrationFileWorkerClient(value = {}) {
  return createClient(value, { testOnly: false });
}

export function createTestOnlyIntegrationFileWorkerClient(value = {}) {
  return createClient(value, { testOnly: true });
}
