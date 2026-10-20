import { PROFILE, capabilities, createRequest, scope, identifier, reject } from "./illustration-contract.js";
import { assertIllustrationStore } from "./illustration-store.js";
import { validateIllustrationPng } from "./illustration-png.js";
import { types } from "node:util";

const workers = new WeakSet();
export function assertIllustrationWorker(worker) {
  if (!workers.has(worker)) reject("ILLUSTRATION_WORKER_UNAVAILABLE", 503);
  return worker;
}

// Internal host SDK for qualification, not an enabled application route. The
// exported RPC refuses new submissions until a future reviewed activation gate.
export function createIllustrationWorker({ store, transport }) {
  assertIllustrationStore(store);
  if (!transport || types.isProxy(transport)) reject("ILLUSTRATION_TRANSPORT_UNAVAILABLE", 503);
  const descriptor = Object.getOwnPropertyDescriptor(transport, "submit");
  if (!Object.isFrozen(transport) || Object.getPrototypeOf(transport) !== Object.prototype || Reflect.ownKeys(transport).length !== 1 || !descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) reject("ILLUSTRATION_TRANSPORT_UNAVAILABLE", 503);
  const submit = descriptor.value;
  const active = new Map();
  let closed = false, closing = null;
  function admitted() { if (closed) reject("ILLUSTRATION_WORKER_CLOSED", 503); }
  function dispatch(owner, request, jobId) {
    const controller = new AbortController();
    const record = { controller, promise: null };
    // The durable claim already exists. Even failure before this call cannot be
    // interpreted as permission to submit again after restart.
    record.promise = (async () => {
      let timer, abortListener;
      try {
        const deadline = new Promise((_, rejectTimeout) => {
          timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("deadline")); }, PROFILE.timeoutMs);
        });
        const aborted = new Promise((_, rejectAbort) => {
          abortListener = () => rejectAbort(new Error("aborted"));
          controller.signal.addEventListener("abort", abortListener, { once: true });
        });
        const operation = Promise.resolve().then(() => {
          if (controller.signal.aborted) reject("ILLUSTRATION_RECOVERY_REQUIRED", 503);
          return Reflect.apply(submit, transport, [request, controller.signal]);
        });
        const bytes = await Promise.race([operation, deadline, aborted]);
        let image;
        try { image = validateIllustrationPng(bytes); }
        catch { store.settle(owner, jobId, null, true); return; }
        store.settle(owner, jobId, image);
      } catch {
        store.settle(owner, jobId);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abortListener);
        active.delete(jobId);
      }
    })();
    record.promise.catch(() => {}); // Sink only; callers can still observe failure.
    active.set(jobId, record);
  }
  const worker = Object.freeze({
    capabilities,
    create(ownerInput, key, input) {
      admitted();
      const owner = scope(ownerInput), request = createRequest(input); identifier(key);
      const result = store.claim(owner, key, request);
      if (result.fresh) dispatch(owner, request, result.job.jobId);
      return result.job;
    },
    status(owner, jobId) { admitted(); return store.status(owner, jobId); },
    cancel(owner, key, jobId) {
      admitted();
      const result = store.cancel(owner, key, jobId);
      // Only abort after authenticated durable cancellation; foreign lookups
      // cannot influence another application's controller.
      if (result.status === "cancel_requested") active.get(jobId)?.controller.abort();
      return result;
    },
    content(owner, artifactId) { admitted(); return store.content(owner, artifactId); },
    async settleLocalWork() { await Promise.all([...active.values()].map((record) => record.promise)); },
    close() {
      if (closing) return closing;
      closed = true;
      const promises = [...active.values()].map((record) => { record.controller.abort(); return record.promise; });
      closing = Promise.all(promises).then(() => undefined);
      closing.catch(() => {});
      return closing;
    },
  });
  workers.add(worker);
  return worker;
}
