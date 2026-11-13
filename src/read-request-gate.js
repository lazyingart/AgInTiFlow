import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { addAbortListener } from "node:events";

const MAX_DELAY_MS = 86_400_000;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const isAborted = signal => signal !== undefined && Reflect.apply(abortedGetter, signal, []);

function gateError(code) {
  const error = new Error(`Read request gate rejected: ${code}`);
  error.name = "ReadRequestGateError";
  error.code = code;
  return error;
}

function fields(value, keys) {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw gateError("INVALID_GATE");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor.enumerable || !("value" in descriptor)) throw gateError("INVALID_GATE");
    result[key] = descriptor.value;
  }
  return result;
}

// Scheduling only, not HTTP authorization, a retry engine or distributed
// admission. Trusted host callbacks retain all source/auth/body-limit duties.
export function createReadRequestGate(options = {}) {
  const config = fields(options, ["minIntervalMs", "maxPending"]);
  const minIntervalMs = Object.hasOwn(config, "minIntervalMs") ? config.minIntervalMs : 1100;
  const maxPending = Object.hasOwn(config, "maxPending") ? config.maxPending : 32;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1 || minIntervalMs > 60_000 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64) throw gateError("INVALID_GATE");
  const queue = [];
  let active = null, nextAt = 0, wake = null, closed = false, closePromise, resolveClose;

  function clearWake() {
    if (wake !== null) clearTimeout(wake);
    wake = null;
  }
  function settle(entry, ok, value) {
    if (entry.settled) return;
    entry.settled = true;
    entry.abortSubscription?.[Symbol.dispose]();
    (ok ? entry.resolve : entry.reject)(value);
  }
  function pump() {
    if (active || closed) return;
    if (!queue.length) { clearWake(); return; }
    const delay = Math.max(0, nextAt - performance.now());
    if (delay > 0) {
      if (wake === null) wake = setTimeout(() => { wake = null; pump(); }, Math.ceil(delay));
      return;
    }
    clearWake();
    const entry = queue.shift();
    active = entry;
    entry.running = true;
    const task = Promise.resolve().then(() => {
      if (isAborted(entry.signal)) throw gateError("CANCELLED");
      return entry.operation(Object.freeze({
        signal: entry.signal,
        defer(delayMs) {
          if (active !== entry || !entry.running || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw gateError("INVALID_GATE");
          nextAt = Math.max(nextAt, performance.now() + delayMs);
        },
      }));
    });
    // A public cancellation may settle before the callback. The callback keeps
    // the sole slot until its original promise/body work actually settles.
    task.then(value => finish(true, value), error => finish(false, error));
    function finish(ok, value) {
      entry.running = false;
      active = null;
      nextAt = Math.max(nextAt, performance.now() + minIntervalMs);
      // Cancellation is a public outcome, not proof the original read ended.
      // Observe native state again before any late value/error can be delivered.
      if (isAborted(entry.signal)) settle(entry, false, gateError("CANCELLED"));
      else settle(entry, ok, value);
      if (closed) resolveClose?.();
      else pump();
    }
  }

  function run(operation, options = {}) {
    if (types.isProxy(operation) || typeof operation !== "function") throw gateError("INVALID_GATE");
    const { signal } = fields(options, ["signal"]);
    if (signal !== undefined) {
      if (!signal || typeof signal !== "object" || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
          Object.getOwnPropertyNames(signal).length) throw gateError("INVALID_GATE");
      try { Reflect.apply(abortedGetter, signal, []); } catch { throw gateError("INVALID_GATE"); }
    }
    if (closed) return Promise.reject(gateError("READ_REQUEST_CLOSED"));
    if (isAborted(signal)) return Promise.reject(gateError("CANCELLED"));
    if (queue.length >= maxPending) return Promise.reject(gateError("READ_REQUEST_BUSY"));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const entry = { operation, signal, resolve, reject, running: false, settled: false, onAbort: null, abortSubscription: null };
    entry.onAbort = () => {
      settle(entry, false, gateError("CANCELLED"));
      if (!entry.running) {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        pump();
      }
    };
    // Another host listener may stop ordinary event propagation. The native
    // disposable subscription still observes cancellation; caller listeners
    // remain caller-owned and the active callback retains its slot until done.
    if (signal) entry.abortSubscription = addAbortListener(signal, entry.onAbort);
    queue.push(entry);
    if (isAborted(signal)) entry.onAbort();
    else pump();
    return promise;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = new Promise(resolve => { resolveClose = resolve; });
    clearWake();
    for (const entry of queue.splice(0)) settle(entry, false, gateError("READ_REQUEST_CLOSED"));
    if (!active) resolveClose();
    return closePromise;
  }
  return Object.freeze({ run, close });
}
