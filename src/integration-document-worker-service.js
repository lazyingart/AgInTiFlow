import {
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
  IntegrationDocumentWorkerError,
  digestDocumentWorkerCompileOperation,
  documentWorkerFail,
  validateDocumentWorkerCommitRequest,
  validateDocumentWorkerCompileRequest,
  validateDocumentWorkerContentRequest,
  validateDocumentWorkerDeleteRequest,
  validateDocumentWorkerReadinessRequest,
} from "./integration-document-worker-contract.js";
import { validateIntegrationDocumentWorkerConfig } from "./integration-document-worker-config.js";
import { inspectIntegrationDocumentCompileRequirements } from "./integration-document-worker-requirements.js";
import { assertIntegrationDocumentWorkerStore } from "./integration-document-worker-store.js";
import {
  compileIntegrationTexWorkerPayload,
  inspectIntegrationTexCompilerRuntime,
} from "./integration-tex-compiler.js";
import { contractDigest } from "./integration-policy.js";
import {
  FILE_WORKER_LIMITS,
  FILE_WORKER_SCHEMA_VERSIONS,
  validateFileWorkerCommitRequest,
  validateFileWorkerContentRequest,
  validateFileWorkerDeleteRequest,
  validateFileWorkerIssueRequest,
  validateFileWorkerPublishRequest,
  validateFileWorkerReadinessRequest,
} from "./integration-file-worker-contract.js";
import { assertIntegrationFileWorkerStore } from "./integration-file-worker-store.js";

export const DOCUMENT_WORKER_SERVICE_SCHEMA_VERSION = "aginti-document-worker-service-v1";
export const DOCUMENT_WORKER_MAXIMUM_QUEUED_COMPILES = 4;

const SERVICE_BRAND = new WeakSet();

function mapCompilerError(error) {
  if (error instanceof IntegrationDocumentWorkerError) return error;
  const code = String(error?.publicCode || error?.code || "");
  if (code === "ANALYSIS_CANCELLED") {
    return new IntegrationDocumentWorkerError("WORKER_UNAVAILABLE", "Document compilation was interrupted.", {
      status: 503,
      cause: error,
    });
  }
  if (new Set(["ANALYSIS_TEX_OUTPUT_LIMIT", "ANALYSIS_TEX_TIMED_OUT"]).has(code)) {
    return new IntegrationDocumentWorkerError("TEX_LIMIT_EXCEEDED", "TeX compilation exceeded a fixed limit.", {
      status: 422,
      cause: error,
    });
  }
  if (new Set([
    "ANALYSIS_TEX_SOURCE_INVALID",
    "ANALYSIS_TEX_COMPILE_FAILED",
    "ANALYSIS_TEX_OUTPUT_INVALID",
    "ANALYSIS_TEX_RECEIPT_INVALID",
  ]).has(code)) {
    return new IntegrationDocumentWorkerError("TEX_COMPILE_FAILED", "The bounded TeX compiler rejected the source.", {
      status: 422,
      cause: error,
    });
  }
  return new IntegrationDocumentWorkerError("WORKER_UNAVAILABLE", "The fixed TeX runtime is unavailable.", {
    status: 503,
    cause: error,
  });
}

function readinessResponse(config, runtime, compileAuthorityEpoch) {
  const compiler = runtime === null
    ? null
    : Object.freeze({
        compilerDigest: runtime.runtimeDigest,
        activationProbeDigest: runtime.activationProbeDigest,
        networkNone: true,
        shellEscape: false,
        limits: Object.freeze({
          maximumSourceBytes: DOCUMENT_WORKER_LIMITS.maximumSourceBytes,
          maximumPdfBytes: DOCUMENT_WORKER_LIMITS.maximumPdfBytes,
          maximumLogBytes: DOCUMENT_WORKER_LIMITS.maximumLogBytes,
          maximumWallTimeMs: DOCUMENT_WORKER_LIMITS.maximumWallTimeMs,
          maximumConcurrentCompiles: DOCUMENT_WORKER_LIMITS.maximumConcurrentCompiles,
        }),
      });
  const unsigned = Object.freeze({
    schemaVersion: DOCUMENT_WORKER_SCHEMA_VERSIONS.readinessResponse,
    ready: true,
    creationEnabled: config.creation.enabled,
    compileAuthorityEpoch,
    protocols: Object.freeze({
      compileIssue: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileIssueRequest,
      compile: DOCUMENT_WORKER_SCHEMA_VERSIONS.compileRequest,
      commit: DOCUMENT_WORKER_SCHEMA_VERSIONS.commitRequest,
      content: DOCUMENT_WORKER_SCHEMA_VERSIONS.contentRequest,
      delete: DOCUMENT_WORKER_SCHEMA_VERSIONS.deleteRequest,
    }),
    compiler,
    storage: Object.freeze({
      durable: true,
      restartStableRefs: true,
      rangeReads: true,
      twoPhaseDelete: true,
    }),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function createService({ config, store, fileStore, compileImpl, inspectRuntimeImpl }) {
  const normalizedConfig = validateIntegrationDocumentWorkerConfig(config);
  assertIntegrationDocumentWorkerStore(store);
  if (fileStore !== undefined) assertIntegrationFileWorkerStore(fileStore);
  let activated = false;
  let closed = false;
  let readiness = null;
  let activeCompiles = 0;
  let compilerRuntimePromise = null;
  const compileWaiters = [];
  const inFlight = new Map();

  async function fileReadiness(requestInput) {
    assertActive();
    validateFileWorkerReadinessRequest(requestInput);
    if (!fileStore) {
      documentWorkerFail("WORKER_UNAVAILABLE", "File artifact broker is unavailable.", { status: 503 });
    }
    const inventory = await fileStore.inspect();
    const unsigned = Object.freeze({
      schemaVersion: FILE_WORKER_SCHEMA_VERSIONS.readinessResponse,
      ready: true,
      creationEnabled: normalizedConfig.creation.enabled,
      authorityEpoch: inventory.authorityEpoch,
      protocols: Object.freeze({
        issue: FILE_WORKER_SCHEMA_VERSIONS.issueRequest,
        publish: FILE_WORKER_SCHEMA_VERSIONS.publishRequest,
        commit: FILE_WORKER_SCHEMA_VERSIONS.commitRequest,
        content: FILE_WORKER_SCHEMA_VERSIONS.contentRequest,
        delete: FILE_WORKER_SCHEMA_VERSIONS.deleteRequest,
      }),
      limits: Object.freeze({
        maximumFiles: FILE_WORKER_LIMITS.maximumFiles,
        maximumFileBytes: FILE_WORKER_LIMITS.maximumFileBytes,
        maximumBundleBytes: FILE_WORKER_LIMITS.maximumBundleBytes,
      }),
      storage: Object.freeze({
        durable: true,
        restartStableRefs: true,
        rangeReads: true,
        twoPhaseDelete: true,
        cloudBytePersistence: false,
      }),
    });
    return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
  }

  function releaseCompileSlot() {
    activeCompiles -= 1;
    if (activeCompiles < 0) throw new Error("document worker compile slot accounting underflow");
    while (compileWaiters.length > 0) {
      const waiter = compileWaiters.shift();
      if (waiter.start()) return;
    }
  }

  function acquireCompileSlot(signal) {
    if (activeCompiles < DOCUMENT_WORKER_LIMITS.maximumConcurrentCompiles) {
      activeCompiles += 1;
      return Promise.resolve(releaseCompileSlot);
    }
    if (compileWaiters.length >= DOCUMENT_WORKER_MAXIMUM_QUEUED_COMPILES) {
      documentWorkerFail(
        "WORKER_UNAVAILABLE",
        "Document worker compile admission queue is full.",
        { status: 503 }
      );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter;
      const removeWaiter = () => {
        const index = compileWaiters.indexOf(waiter);
        if (index >= 0) compileWaiters.splice(index, 1);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        removeWaiter();
        reject(new IntegrationDocumentWorkerError(
          "WORKER_UNAVAILABLE",
          "Document compilation was interrupted while queued.",
          { status: 503 }
        ));
      };
      waiter = {
        start() {
          if (settled || signal?.aborted) {
            onAbort();
            return false;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          activeCompiles += 1;
          resolve(releaseCompileSlot);
          return true;
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      compileWaiters.push(waiter);
    });
  }

  function assertActive() {
    if (!activated || closed || !readiness) {
      documentWorkerFail("WORKER_UNAVAILABLE", "Document worker is not active.", { status: 503 });
    }
  }

  async function inspectCompilerRuntime() {
    if (!compilerRuntimePromise) {
      compilerRuntimePromise = Promise.resolve().then(async () => {
        let runtime;
        try {
          runtime = await inspectRuntimeImpl();
        } catch (error) {
          throw mapCompilerError(error);
        }
        if (
          runtime?.ready !== true ||
          runtime.networkNone !== true ||
          runtime.shellEscape !== false ||
          typeof runtime.runtimeDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(runtime.runtimeDigest) ||
          typeof runtime.activationProbeDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(runtime.activationProbeDigest)
        ) {
          documentWorkerFail("WORKER_UNAVAILABLE", "TeX activation canary is invalid.", { status: 503 });
        }
        return runtime;
      }).catch((error) => {
        compilerRuntimePromise = null;
        throw error;
      });
    }
    return compilerRuntimePromise;
  }

  async function activateInternal(requireCompilerCanary) {
    if (closed) documentWorkerFail("WORKER_UNAVAILABLE", "Document worker is closed.", { status: 503 });
    const inventory = await store.inspect();
    if (activated) {
      if (requireCompilerCanary) await inspectCompilerRuntime();
      readiness = readinessResponse(
        normalizedConfig,
        normalizedConfig.creation.enabled ? await inspectCompilerRuntime() : null,
        inventory.compileAuthorityEpoch
      );
      return readiness;
    }
    const runtime = normalizedConfig.creation.enabled || requireCompilerCanary
      ? await inspectCompilerRuntime()
      : null;
    readiness = readinessResponse(
      normalizedConfig,
      normalizedConfig.creation.enabled ? runtime : null,
      inventory.compileAuthorityEpoch
    );
    activated = true;
    return readiness;
  }

  async function activate() {
    return activateInternal(false);
  }

  async function check() {
    // The rollback floor must remain able to serve already committed objects
    // when the TeX toolchain is unavailable.  Enabled creation still makes the
    // compiler activation canary a hard pre-listen requirement.
    return activateInternal(normalizedConfig.creation.enabled);
  }

  async function compile(requestInput, { signal } = {}) {
    assertActive();
    const request = validateDocumentWorkerCompileRequest(requestInput);
    if (!normalizedConfig.creation.enabled) {
      documentWorkerFail("WORKER_CREATION_DISABLED", "Document artifact creation is disabled.", { status: 503 });
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError("document worker compile signal must be an AbortSignal");
    }
    if (signal?.aborted) {
      documentWorkerFail("WORKER_UNAVAILABLE", "Document compilation was interrupted.", { status: 503 });
    }
    const reservation = await store.reserveCompile(request);
    if (reservation.replay) return reservation.replay;
    const requestDigest = digestDocumentWorkerCompileOperation(request);
    const active = inFlight.get(request.requestId);
    if (active) {
      if (active.requestDigest !== requestDigest) {
        documentWorkerFail("IDEMPOTENCY_CONFLICT", "Compile request id was already used.", { status: 409 });
      }
      return active.promise;
    }
    const execute = async () => {
      const releaseSlot = await acquireCompileSlot(signal);
      let compiled;
      try {
        if (signal?.aborted) {
          documentWorkerFail("WORKER_UNAVAILABLE", "Document compilation was interrupted.", { status: 503 });
        }
        const evidence = inspectIntegrationDocumentCompileRequirements(request.source, request.requirements);
        compiled = await compileImpl({ filename: request.filename, source: request.source }, { signal });
        return await store.stageCompile({ request, evidence, compiled });
      } catch (error) {
        throw mapCompilerError(error);
      } finally {
        compiled?.source?.bytes?.fill?.(0);
        compiled?.pdf?.bytes?.fill?.(0);
        releaseSlot();
      }
    };
    const promise = execute().finally(() => {
      if (inFlight.get(request.requestId)?.promise === promise) inFlight.delete(request.requestId);
    });
    inFlight.set(request.requestId, Object.freeze({ requestDigest, promise }));
    return promise;
  }

  async function issueCompile(requestInput) {
    assertActive();
    if (!normalizedConfig.creation.enabled) {
      documentWorkerFail("WORKER_CREATION_DISABLED", "Document artifact creation is disabled.", { status: 503 });
    }
    return store.issueCompile(requestInput);
  }

  const service = {
    schemaVersion: DOCUMENT_WORKER_SERVICE_SCHEMA_VERSION,
    config: normalizedConfig,
    activate,
    check,
    async readiness(requestInput) {
      assertActive();
      validateDocumentWorkerReadinessRequest(requestInput);
      return activateInternal(false);
    },
    fileReadiness,
    issueFiles(requestInput) {
      assertActive();
      if (!fileStore || !normalizedConfig.creation.enabled) {
        documentWorkerFail("WORKER_CREATION_DISABLED", "File artifact creation is disabled.", { status: 503 });
      }
      return fileStore.issue(validateFileWorkerIssueRequest(requestInput));
    },
    publishFiles(requestInput) {
      assertActive();
      if (!fileStore || !normalizedConfig.creation.enabled) {
        documentWorkerFail("WORKER_CREATION_DISABLED", "File artifact creation is disabled.", { status: 503 });
      }
      return fileStore.publish(validateFileWorkerPublishRequest(requestInput));
    },
    commitFiles(requestInput) {
      assertActive();
      if (!fileStore) documentWorkerFail("WORKER_UNAVAILABLE", "File artifact broker is unavailable.", { status: 503 });
      return fileStore.commit(validateFileWorkerCommitRequest(requestInput));
    },
    fileContent(requestInput) {
      assertActive();
      if (!fileStore) documentWorkerFail("WORKER_UNAVAILABLE", "File artifact broker is unavailable.", { status: 503 });
      return fileStore.openContent(validateFileWorkerContentRequest(requestInput));
    },
    deleteFiles(requestInput) {
      assertActive();
      if (!fileStore) documentWorkerFail("WORKER_UNAVAILABLE", "File artifact broker is unavailable.", { status: 503 });
      return fileStore.delete(validateFileWorkerDeleteRequest(requestInput));
    },
    issueCompile,
    compile,
    commit(requestInput) {
      assertActive();
      return store.commit(validateDocumentWorkerCommitRequest(requestInput));
    },
    content(requestInput) {
      assertActive();
      return store.openContent(validateDocumentWorkerContentRequest(requestInput));
    },
    delete(requestInput) {
      assertActive();
      return store.delete(validateDocumentWorkerDeleteRequest(requestInput));
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...inFlight.values()].map(({ promise }) => promise));
      await Promise.allSettled([store.close(), fileStore?.close()]);
    },
  };
  SERVICE_BRAND.add(service);
  return Object.freeze(service);
}

export function createIntegrationDocumentWorkerService(options = {}) {
  const keys = Reflect.ownKeys(options);
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    keys.some((key) => typeof key !== "string" || !new Set(["config", "store", "fileStore"]).has(key)) ||
    !Object.hasOwn(options, "config") ||
    !Object.hasOwn(options, "store")
  ) throw new TypeError("document worker service options are invalid");
  return createService({
    config: options.config,
    store: options.store,
    fileStore: options.fileStore,
    compileImpl: compileIntegrationTexWorkerPayload,
    inspectRuntimeImpl: inspectIntegrationTexCompilerRuntime,
  });
}

export function createTestOnlyIntegrationDocumentWorkerService(options = {}) {
  const keys = Reflect.ownKeys(options);
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    keys.some((key) =>
      typeof key !== "string" ||
      !new Set(["config", "store", "fileStore", "compileImpl", "inspectRuntimeImpl"]).has(key)
    ) ||
    !Object.hasOwn(options, "config") ||
    !Object.hasOwn(options, "store")
  ) throw new TypeError("test document worker service options are invalid");
  return createService({
    config: options.config,
    store: options.store,
    fileStore: options.fileStore,
    compileImpl: options.compileImpl || compileIntegrationTexWorkerPayload,
    inspectRuntimeImpl: options.inspectRuntimeImpl || inspectIntegrationTexCompilerRuntime,
  });
}

export function assertIntegrationDocumentWorkerService(value) {
  if (!value || !SERVICE_BRAND.has(value)) throw new TypeError("document worker service is not AgInTi-owned");
  return value;
}
