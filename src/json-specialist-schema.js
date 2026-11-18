import { Worker } from "node:worker_threads";

const MAX_PENDING = 32;
const DEADLINE_MS = 4000;
let worker;
let retiring = Promise.resolve();
let tail = Promise.resolve();
let pending = 0;
let idleTimer;

function unavailable() {
  return Object.assign(new Error("JSON specialist schema validation unavailable."), { code: "SPECIALIST_SCHEMA_UNAVAILABLE" });
}

function retire(current) {
  if (worker !== current) return;
  worker = undefined;
  retiring = current.terminate().catch(() => { throw unavailable(); });
  void retiring.catch(() => {});
}

function withinDeadline(operation, deadline) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(unavailable()), Math.max(1, Math.ceil(deadline - performance.now())));
  });
  return Promise.race([operation, limit]).finally(() => clearTimeout(timer));
}

function getWorker() {
  if (!worker) {
    const current = new Worker(new URL("./json-specialist-schema-worker.js", import.meta.url), {
      env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    worker = current;
    current.on("error", () => retire(current));
    current.on("exit", () => { if (worker === current) worker = undefined; });
  }
  return worker;
}

function exchange(current, message, timeout, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(fail, timeout);
    function cleanup() {
      clearTimeout(timer);
      current.off("message", answered);
      current.off("exit", fail);
      current.off("error", fail);
      signal?.removeEventListener("abort", fail);
    }
    function fail() {
      cleanup();
      retire(current);
      reject(unavailable());
    }
    function answered(reply) {
      cleanup();
      resolve(reply);
    }
    current.once("message", answered);
    current.once("exit", fail);
    current.once("error", fail);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) return fail();
    try { current.postMessage(message); } catch { fail(); }
  });
}

// A model may supply a schema through the JSON tool. Keep both compilation and
// validation off the agent event loop, with one bounded worker per process.
// No worker or queue slot is held by an in-flight provider request.
export function checkSpecialistSchema(source, value, checkOnly, signal) {
  if (pending >= MAX_PENDING || signal?.aborted) return Promise.reject(unavailable());
  clearTimeout(idleTimer);
  pending++;
  const deadline = performance.now() + DEADLINE_MS;
  const job = tail.then(async () => {
    await withinDeadline(retiring, deadline);
    const timeout = Math.ceil(deadline - performance.now());
    if (timeout <= 0 || signal?.aborted) throw unavailable();
    const current = getWorker();
    current.ref();
    const reply = await exchange(current, { source, value, checkOnly }, timeout, signal);
    if (signal?.aborted) throw unavailable();
    if (reply.status === "valid") return [];
    if (reply.status === "invalidValue") return [`Output does not satisfy JSON Schema keyword ${reply.keyword}.`];
    if (reply.status === "invalidSchema") {
      throw Object.assign(new Error("JSON specialist requires a supported, self-contained JSON Schema."), { code: "SPECIALIST_SCHEMA_INVALID" });
    }
    throw unavailable();
  }).finally(() => {
    if (--pending === 0 && worker) {
      const current = worker;
      current.unref();
      idleTimer = setTimeout(() => retire(current), 2000).unref();
    }
  });
  tail = job.catch(() => {});
  return job;
}
