import crypto from "node:crypto";

import {
  INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_CAPABILITIES_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_COMMIT_RESPONSE_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_COMPILE_ISSUE_RESPONSE_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_COMPILE_REQUEST_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_COMPILE_RESPONSE_SCHEMA_VERSION,
  INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
  INTEGRATION_DOCUMENT_WORKER_LIMITS,
  INTEGRATION_DOCUMENT_WORKER_RECEIPT_SCHEMA_VERSION,
  createTestOnlyIntegrationDocumentWorkerClient,
  integrationDocumentWorkerDeletionManifestDigest,
} from "../src/integration-document-worker-client.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";
import {
  digestDocumentWorkerCompileContent,
  digestDocumentWorkerCompileOperation,
} from "../src/integration-document-worker-contract.js";

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n", "utf8");

function digestBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function token(prefix, bytes, seed) {
  const encoded = crypto.createHash("sha256").update(seed).digest().subarray(0, bytes).toString("base64url");
  return `${prefix}${encoded}`;
}

function jsonHeaders(bytes, cacheControl = "no-store") {
  return {
    "Cache-Control": cacheControl,
    "Content-Length": String(bytes.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonResponse(status, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  return new Response(bytes, { status, headers: jsonHeaders(bytes) });
}

function errorResponse(status, code, extraHeaders = {}) {
  const bytes = Buffer.from(`${JSON.stringify({ error: { code } })}\n`, "utf8");
  return new Response(bytes, { status, headers: { ...jsonHeaders(bytes), ...extraHeaders } });
}

function contentDisposition(filename) {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120) || "artifact";
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function identityDigests(scope) {
  const ownerDigest = contractDigest({
    schemaVersion: "aginti-document-worker-owner-v1",
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
  });
  const threadDigest = contractDigest({
    schemaVersion: "aginti-document-worker-thread-v1",
    ownerDigest,
    threadId: scope.threadId,
  });
  const runDigest = contractDigest({
    schemaVersion: "aginti-document-worker-run-v1",
    threadDigest,
    runId: scope.runId,
  });
  const scopeDigest = contractDigest({ schemaVersion: "aginti-document-worker-scope-v1", ...scope });
  return { ownerDigest, threadDigest, runDigest, scopeDigest };
}

export function createDocumentWorkerFixture(options = {}) {
  const calls = [];
  const staged = new Map();
  const issued = new Map();
  const committed = new Map();
  const tombstoned = new Set();
  const deletions = new Map();
  let available = options.available !== false;
  let creationEnabled = options.creationEnabled !== false;
  let readinessErrorCode = options.readinessErrorCode || null;
  let compileAuthorityEpoch = 1;
  let failNextCompileCode = null;
  let dropNextIssueResponse = false;
  let advanceEpochBeforeNextIssue = options.advanceEpochBeforeFirstIssue === true;
  let failIssueBeforePersistAndAdvance = options.failFirstIssueBeforePersistAndAdvance === true;
  let failNextCommitCode = null;
  let malformedNextCommitResponse = false;
  let hangNextCommitResponse = false;
  let failNextDeleteCode = null;

  const readinessCore = () => ({
    schemaVersion: INTEGRATION_DOCUMENT_WORKER_CAPABILITIES_SCHEMA_VERSION,
    ready: true,
    creationEnabled,
    compileAuthorityEpoch,
    protocols: {
      compileIssue: "aginti-document-worker-compile-issue-request-v2",
      compile: INTEGRATION_DOCUMENT_WORKER_COMPILE_REQUEST_SCHEMA_VERSION,
      commit: "aginti-document-worker-commit-request-v1",
      content: "aginti-document-worker-content-request-v1",
      delete: "aginti-document-worker-delete-request-v1",
    },
    compiler: creationEnabled
      ? {
          compilerDigest: "a".repeat(64),
          activationProbeDigest: "b".repeat(64),
          networkNone: true,
          shellEscape: false,
          limits: INTEGRATION_DOCUMENT_WORKER_LIMITS,
        }
      : null,
    storage: { durable: true, restartStableRefs: true, rangeReads: true, twoPhaseDelete: true },
  });

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const request = init.body ? JSON.parse(String(init.body)) : null;
    calls.push(Object.freeze({ pathname: parsed.pathname, method: init.method, request }));
    if (!available) throw new TypeError("fixture tunnel offline");
    if (url.startsWith(INTEGRATION_DOCUMENT_WORKER_ENDPOINT) !== true || init.method !== "POST") {
      return errorResponse(404, "NOT_FOUND");
    }
    if (parsed.pathname === "/artifact/v1/readiness") {
      if (readinessErrorCode) {
        const code = readinessErrorCode;
        const status = code === "UNAUTHORIZED" ? 401
          : code === "INTERNAL_ERROR" ? 500
            : 503;
        return errorResponse(status, code);
      }
      const core = readinessCore();
      return jsonResponse(200, { ...core, digest: contractDigest(core) });
    }
    if (parsed.pathname === "/artifact/v1/compile/issue") {
      if (!creationEnabled) return errorResponse(503, "WORKER_CREATION_DISABLED");
      if (failIssueBeforePersistAndAdvance) {
        failIssueBeforePersistAndAdvance = false;
        compileAuthorityEpoch += 1;
        throw new TypeError("simulated pre-dispatch issue transport failure");
      }
      if (advanceEpochBeforeNextIssue) {
        advanceEpochBeforeNextIssue = false;
        compileAuthorityEpoch += 1;
      }
      const contentDigest = digestDocumentWorkerCompileContent(request);
      const requestDigest = contractDigest(request);
      let authority = issued.get(request.issuanceId);
      if (authority && authority.requestDigest !== requestDigest) {
        return errorResponse(409, "IDEMPOTENCY_CONFLICT");
      }
      if (!authority) {
        if (request.compileAuthorityEpoch < compileAuthorityEpoch) {
          return errorResponse(410, "ARTIFACT_CONTENT_GONE");
        }
        if (request.compileAuthorityEpoch !== compileAuthorityEpoch) {
          return errorResponse(400, "INVALID_REQUEST");
        }
        const core = {
          schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMPILE_ISSUE_RESPONSE_SCHEMA_VERSION,
          issuanceId: request.issuanceId,
          requestId: `cmp_${digestBytes(Buffer.from(`request:${request.issuanceId}`, "utf8"))}`,
          compileAuthorityEpoch: request.compileAuthorityEpoch,
          compileAuthorityToken: token("wca_", 32, `authority:${request.issuanceId}`),
          contentDigest,
        };
        authority = { requestDigest, response: { ...core, digest: contractDigest(core) } };
        issued.set(request.issuanceId, authority);
      }
      if (dropNextIssueResponse) {
        dropNextIssueResponse = false;
        throw new TypeError("simulated compile issuance response loss");
      }
      return jsonResponse(200, authority.response);
    }
    if (parsed.pathname === "/artifact/v1/compile") {
      if (!creationEnabled) return errorResponse(503, "WORKER_CREATION_DISABLED");
      if (failNextCompileCode) {
        const code = failNextCompileCode;
        failNextCompileCode = null;
        return errorResponse(422, code);
      }
      const authority = issued.get(request.issuanceId);
      if (
        !authority ||
        authority.response.requestId !== request.requestId ||
        authority.response.compileAuthorityEpoch !== request.compileAuthorityEpoch ||
        authority.response.compileAuthorityToken !== request.compileAuthorityToken ||
        authority.response.contentDigest !== digestDocumentWorkerCompileContent(request)
      ) return errorResponse(410, "ARTIFACT_CONTENT_GONE");
      const sourceBytes = Buffer.from(request.source, "utf8");
      const sourceSha256 = digestBytes(sourceBytes);
      if (sourceSha256 !== request.sourceSha256) return errorResponse(400, "INVALID_REQUEST");
      const pdfBytes = Buffer.from(options.pdfBytes || PDF_BYTES);
      const pdfSha256 = digestBytes(pdfBytes);
      const receiptSeed = `${request.requestId}:${sourceSha256}:${pdfSha256}`;
      const artifacts = [
        {
          ref: token("wobj_", 32, `${receiptSeed}:source`),
          role: "source",
          filename: request.filename,
          mime: "application/x-tex",
          bytes: sourceBytes.byteLength,
          sha256: sourceSha256,
        },
        {
          ref: token("wobj_", 32, `${receiptSeed}:pdf`),
          role: "pdf",
          filename: request.filename.replace(/\.tex$/iu, ".pdf"),
          mime: "application/pdf",
          bytes: pdfBytes.byteLength,
          sha256: pdfSha256,
        },
      ];
      const identities = identityDigests(request.scope);
      const artifactsDigest = contractDigest({
        schemaVersion: "aginti-document-worker-compile-artifacts-v1",
        artifacts,
      });
      const receiptCore = {
        schemaVersion: INTEGRATION_DOCUMENT_WORKER_RECEIPT_SCHEMA_VERSION,
        receiptId: token("wrcp_", 24, `${receiptSeed}:receipt`),
        groupId: token("wgrp_", 32, `${receiptSeed}:group`),
        ...identities,
        requestId: request.requestId,
        requestDigest: digestDocumentWorkerCompileOperation(request),
        requirementsDigest: contractDigest(request.requirements),
        verifiedFigureCount: request.requirements.minimumFigureCount,
        artifactsDigest,
        compilerDigest: "a".repeat(64),
        compileLogSha256: "c".repeat(64),
        sourceSha256,
        sourceBytes: sourceBytes.byteLength,
        pdfSha256,
        pdfBytes: pdfBytes.byteLength,
        networkNone: true,
        shellEscape: false,
        issuedAt: "2026-08-26T00:00:00.000Z",
      };
      const receipt = { ...receiptCore, digest: contractDigest(receiptCore) };
      staged.set(receipt.digest, { request, receipt, artifacts, bytes: [sourceBytes, pdfBytes] });
      return jsonResponse(200, {
        schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMPILE_RESPONSE_SCHEMA_VERSION,
        requestId: request.requestId,
        receipt,
        artifacts,
      });
    }
    if (parsed.pathname === "/artifact/v1/commit") {
      if (hangNextCommitResponse) {
        hangNextCommitResponse = false;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal.reason || new Error("simulated commit abort"));
          }, { once: true });
        });
      }
      if (malformedNextCommitResponse) {
        malformedNextCommitResponse = false;
        return new Response("{", {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Length": "1",
            "Content-Type": "application/json; charset=utf-8",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (failNextCommitCode) {
        const code = failNextCommitCode;
        failNextCommitCode = null;
        const status = code === "IDEMPOTENCY_CONFLICT" ? 409
          : code === "UNAUTHORIZED" ? 401
            : code === "INTERNAL_ERROR" ? 500
              : 503;
        return errorResponse(status, code);
      }
      const group = staged.get(request.receiptDigest) || committed.get(request.receiptDigest)?.group;
      if (!group) return errorResponse(404, "NOT_FOUND");
      const manifestDigest = contractDigest({
        schemaVersion: "aginti-document-worker-artifact-manifest-v1",
        objects: request.objects,
      });
      for (let index = 0; index < group.artifacts.length; index += 1) {
        committed.set(group.artifacts[index].ref, { group, index });
      }
      committed.set(request.receiptDigest, { group });
      const core = {
        schemaVersion: INTEGRATION_DOCUMENT_WORKER_COMMIT_RESPONSE_SCHEMA_VERSION,
        requestId: request.requestId,
        receiptDigest: request.receiptDigest,
        status: "committed",
        manifestDigest,
        committedAt: "2026-08-26T00:00:01.000Z",
      };
      return jsonResponse(200, { ...core, digest: contractDigest(core) });
    }
    if (parsed.pathname === "/artifact/v1/content") {
      const stored = committed.get(request.ref);
      if (
        !stored ||
        stored.group.receipt.digest !== request.receiptDigest ||
        canonicalJson(stored.group.request.scope) !== canonicalJson(request.scope)
      ) {
        return tombstoned.has(request.ref)
          ? errorResponse(410, "ARTIFACT_CONTENT_GONE")
          : errorResponse(404, "NOT_FOUND");
      }
      const artifact = stored.group.artifacts[stored.index];
      const bytes = stored.group.bytes[stored.index];
      let start = 0;
      let end = bytes.byteLength - 1;
      if (request.range) {
        if (request.range.start >= bytes.byteLength) {
          return errorResponse(416, "RANGE_NOT_SATISFIABLE", {
            "Content-Range": `bytes */${bytes.byteLength}`,
          });
        }
        start = request.range.start;
        end = Math.min(request.range.end ?? end, end);
      }
      const selected = bytes.subarray(start, end + 1);
      const metadataOnly = request.metadataOnly === true;
      const response = new Response(metadataOnly ? null : selected, {
        status: request.range ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store, private",
          "Content-Disposition": contentDisposition(artifact.filename),
          "Content-Length": metadataOnly ? "0" : String(selected.byteLength),
          "Content-Type": artifact.mime,
          ETag: `"${artifact.sha256}"`,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          ...(metadataOnly ? { "X-Artifact-Content-Length": String(selected.byteLength) } : {}),
          ...(request.range ? { "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}` } : {}),
        },
      });
      return typeof options.contentResponseTransform === "function"
        ? options.contentResponseTransform(response)
        : response;
    }
    if (parsed.pathname === "/artifact/v1/delete") {
      if (failNextDeleteCode) {
        const code = failNextDeleteCode;
        failNextDeleteCode = null;
        const status = code === "NOT_FOUND" ? 404
          : code === "ARTIFACT_CONTENT_GONE" ? 410
            : 503;
        return errorResponse(status, code);
      }
      const manifestDigest = integrationDocumentWorkerDeletionManifestDigest(request);
      const previous = deletions.get(request.deletionId);
      const committedDelete = previous?.status === "committed" || request.phase === "commit";
      if (committedDelete) {
        for (const object of request.objects) {
          committed.delete(object.ref);
          tombstoned.add(object.ref);
        }
      }
      const core = {
        schemaVersion: "aginti-document-worker-delete-response-v1",
        deletionId: request.deletionId,
        phase: request.phase,
        status: committedDelete ? "committed" : "prepared",
        manifestDigest,
        tombstoneDigest: committedDelete ? "d".repeat(64) : null,
        completedAt: committedDelete ? "2026-08-26T00:00:02.000Z" : null,
      };
      deletions.set(request.deletionId, core);
      return jsonResponse(200, { ...core, digest: contractDigest(core) });
    }
    return errorResponse(404, "NOT_FOUND");
  }

  function client() {
    return createTestOnlyIntegrationDocumentWorkerClient({
      endpoint: INTEGRATION_DOCUMENT_WORKER_ENDPOINT,
      credential: "test-document-artifact-edge-token-12345",
      timeoutMs: 120_000,
      fetchImpl,
    });
  }

  return Object.freeze({
    calls,
    client,
    staged,
    issued,
    committed,
    tombstoned,
    setAvailable(value) { available = value === true; },
    setCreationEnabled(value) { creationEnabled = value === true; },
    setReadinessError(code) { readinessErrorCode = code; },
    advanceCompileAuthorityEpoch() { compileAuthorityEpoch += 1; },
    failNextCompile(code = "TEX_COMPILE_FAILED") { failNextCompileCode = code; },
    loseNextIssueResponse() { dropNextIssueResponse = true; },
    failNextCommit(code = "WORKER_UNAVAILABLE") { failNextCommitCode = code; },
    malformNextCommitResponse() { malformedNextCommitResponse = true; },
    hangNextCommit() { hangNextCommitResponse = true; },
    failNextDelete(code = "WORKER_UNAVAILABLE") { failNextDeleteCode = code; },
  });
}

export function compileRequirements(minimumFigureCount = 0) {
  return Object.freeze({
    schemaVersion: INTEGRATION_DOCUMENT_COMPILE_REQUIREMENTS_SCHEMA_VERSION,
    profile: "self-contained-tex-v1",
    minimumFigureCount,
  });
}
