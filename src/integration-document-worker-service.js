import {
  DOCUMENT_WORKER_LIMITS,
  DOCUMENT_WORKER_SCHEMA_VERSIONS,
  IntegrationDocumentWorkerError,
  digestNormalizedDocumentWorkerRequest,
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

function readinessResponse(config, runtime) {
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
    protocols: Object.freeze({
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

function createService({ config, store, compileImpl, inspectRuntimeImpl }) {
  const normalizedConfig = validateIntegrationDocumentWorkerConfig(config);
  assertIntegrationDocumentWorkerStore(store);
  let activated = false;
  let closed = false;
  let readiness = null;
  let activeCompiles = 0;
  let compilerRuntimePromise = null;
  const compileWaiters = [];
  const inFlight = new Map();

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
    if (activated) {
      if (requireCompilerCanary) await inspectCompilerRuntime();
      return readiness;
    }
    await store.inspect();
    const runtime = normalizedConfig.creation.enabled || requireCompilerCanary
      ? await inspectCompilerRuntime()
      : null;
    readiness = readinessResponse(normalizedConfig, normalizedConfig.creation.enabled ? runtime : null);
    activated = true;
    return readiness;
  }

  async function activate() {
    return activateInternal(false);
  }

  async function check() {
    return activateInternal(true);
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
    const replay = await store.lookupCompile(request);
    if (replay) return replay;
    const requestDigest = digestNormalizedDocumentWorkerRequest(request);
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

  const service = {
    schemaVersion: DOCUMENT_WORKER_SERVICE_SCHEMA_VERSION,
    config: normalizedConfig,
    activate,
    check,
    readiness(requestInput) {
      assertActive();
      validateDocumentWorkerReadinessRequest(requestInput);
      return readiness;
    },
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
      await store.close();
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
    keys.some((key) => typeof key !== "string" || !new Set(["config", "store"]).has(key)) ||
    !Object.hasOwn(options, "config") ||
    !Object.hasOwn(options, "store")
  ) throw new TypeError("document worker service options are invalid");
  return createService({
    config: options.config,
    store: options.store,
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
      !new Set(["config", "store", "compileImpl", "inspectRuntimeImpl"]).has(key)
    ) ||
    !Object.hasOwn(options, "config") ||
    !Object.hasOwn(options, "store")
  ) throw new TypeError("test document worker service options are invalid");
  return createService({
    config: options.config,
    store: options.store,
    compileImpl: options.compileImpl || compileIntegrationTexWorkerPayload,
    inspectRuntimeImpl: options.inspectRuntimeImpl || inspectIntegrationTexCompilerRuntime,
  });
}

export function assertIntegrationDocumentWorkerService(value) {
  if (!value || !SERVICE_BRAND.has(value)) throw new TypeError("document worker service is not AgInTi-owned");
  return value;
}
