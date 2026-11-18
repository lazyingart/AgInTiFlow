import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import {
  createRestrictedApplicationRunner, createRestrictedToolFailure, RESTRICTED_APPLICATION_PROTOCOL,
} from "@lazyingart/agintilite";
import peer from "@lazyingart/agintilite/package.json" with { type: "json" };
import { dataFields, jsonSnapshot, integer, checkedSchema, assertNoCredentials } from "./internal/restricted-application-contract.js";

export const RESTRICTED_APPLICATION_PIPE_PROTOCOL = "aginti-restricted-application-pipe-v1";
export const PIPE_MAX_FRAME_BYTES = 256 * 1024;
const NativeAbortController = AbortController;
const then = Promise.prototype.then;
const apply = Reflect.apply;
const IDS = /^[A-Za-z0-9_-]{16,80}$/;
const SCOPES = /^[A-Za-z0-9_-]{16,128}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SDK_CODES = new Set(["INVALID_CONTRACT", "BUSY", "CANCELLED", "TIMEOUT", "PROVIDER_FAILED", "TOOL_FAILED", "TOOL_CALL_INVALID", "TOOL_RESULT_INVALID", "OUTPUT_INVALID", "DATA_LIMIT", "CONTEXT_LIMIT", "STEP_LIMIT", "PROPOSAL_REJECTED", "PROPOSAL_REVIEW_FAILED"]);
const ACTION_FIELDS = new Map([["run", ["request"]], ["cancel", []], ["read_result", ["readId", "value"]], ["read_error", ["readId", "failure"]]]);
export class RestrictedApplicationPipeError extends Error {
  constructor(code) { super(`Restricted application pipe rejected: ${code}`); this.name = "RestrictedApplicationPipeError"; this.code = code; }
}
const fail = code => { throw new RestrictedApplicationPipeError(code); };
function callback(value) { if (typeof value !== "function" || types.isProxy(value)) fail("INVALID_CONFIG"); return value; }
function sink(promise) { apply(then, promise, [undefined, () => {}]); return promise; }
function own(value, name) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}
function publicError(error) {
  const candidate = own(error, "code");
  const result = { code: typeof candidate === "string" && SDK_CODES.has(candidate) ? candidate : "RUN_FAILED" };
  // SDK-issued metadata is a host classification, never permission to retry.
  for (const [code, field, schema] of [["PROVIDER_FAILED", "providerFailure", "aginti-provider-failure-v1"], ["TOOL_FAILED", "toolFailure", "aginti-tool-failure-v1"]]) {
    if (result.code !== code) continue;
    const raw = own(error, field); if (raw === undefined) continue;
    try {
      const value = dataFields(jsonSnapshot(raw, { maxBytes: 1024 }), ["schemaVersion", "category", "retryAfterMs"]);
      const categories = ["authentication", "permission", "quota", "rate_limit", "unavailable", "timeout", "protocol", ...(field === "toolFailure" ? ["not_found", "conflict"] : [])];
      if (value.schemaVersion !== schema || !categories.includes(value.category)) continue;
      if (value.retryAfterMs !== null && (!["rate_limit", "unavailable"].includes(value.category) || !Number.isInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 86_400_000)) continue;
      result[field] = value;
    } catch { /* Unknown raw metadata never crosses this boundary. */ }
  }
  return result;
}
function bounded(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RestrictedApplicationPipeError(code)), ms); });
  const result = Promise.race([promise, timeout]);
  apply(then, result, [() => clearTimeout(timer), () => clearTimeout(timer)]);
  return sink(result);
}

// This is a private OS-channel transport, not an authenticated network service.
// The parent owns account authentication, authorized history, read I/O and commits.
// The lexical peer SDK owns all model/read/schema loop behavior.
export function createRestrictedApplicationChannel(options) {
  const config = dataFields(options, ["scopeId", "provider", "instructions", "outputSchema", "tools", "limits", "emit", "closeGraceMs"],
    ["scopeId", "provider", "instructions", "outputSchema", "emit"]);
  const supportedPeer = peer.version === "0.1.0-preview.21" || peer.version === "0.1.0-preview.22";
  if (peer.name !== "@lazyingart/agintilite" || !supportedPeer ||
    RESTRICTED_APPLICATION_PROTOCOL !== "aginti-restricted-application-v1") fail("PEER_MISMATCH");
  if (typeof config.scopeId !== "string" || !SCOPES.test(config.scopeId)) fail("INVALID_CONFIG");
  assertNoCredentials(config.scopeId);
  const scopeId = config.scopeId, nonce = randomBytes(32).toString("hex"), emit = callback(config.emit);
  const closeGraceMs = Object.hasOwn(config, "closeGraceMs") ? integer(config.closeGraceMs, 20, 3000) : 3000;
  const provider = dataFields(config.provider, ["supportsImages", "complete"]);
  if (provider.supportsImages !== false) fail("INVALID_CONFIG");
  const complete = callback(provider.complete), scopes = new AsyncLocalStorage();
  const limits = dataFields(jsonSnapshot(Object.hasOwn(config, "limits") ? config.limits : {}),
    ["timeoutMs", "maxSteps", "maxToolCalls", "maxCallsPerStep", "maxContextBytes", "maxResultBytes", "maxOutputTokens", "maxConcurrency"], []);
  if (Object.hasOwn(limits, "maxConcurrency") && limits.maxConcurrency !== 1) fail("INVALID_CONFIG");
  const fixedLimits = Object.assign(Object.create(null), limits, { maxConcurrency: 1 });
  const declared = jsonSnapshot(Object.hasOwn(config, "tools") ? config.tools : []), physical = new Set(), pendingReads = new Map(), runs = new Set(), seen = new Set();
  if (!Array.isArray(declared) || declared.length > 16) fail("INVALID_CONFIG");
  let current = null, closed = false, poisoned = false, closing, readOrdinal = 0;
  function poison() {
    poisoned = true; current?.controller.abort();
    for (const read of pendingReads.values()) {
      read.subscription?.[Symbol.dispose](); read.reject(new RestrictedApplicationPipeError("OUTPUT_FAILED"));
    }
    pendingReads.clear();
  }
  const makeFrame = (type, requestId, fields) => jsonSnapshot(Object.assign({
    schemaVersion: 1, protocol: RESTRICTED_APPLICATION_PIPE_PROTOCOL, nonce, scopeId, type,
  }, requestId === undefined ? {} : { requestId }, fields), { maxBytes: PIPE_MAX_FRAME_BYTES });
  function send(type, requestId, fields = {}) {
    if (closed) return sink(Promise.reject(new RestrictedApplicationPipeError("CLOSED")));
    const frame = makeFrame(type, requestId, fields);
    let value;
    try { value = apply(emit, undefined, [frame]); }
    catch { poison(); return sink(Promise.reject(new RestrictedApplicationPipeError("OUTPUT_FAILED"))); }
    if (value === undefined) return Promise.resolve();
    if (types.isProxy(value) || !types.isPromise(value)) { poison(); return sink(Promise.reject(new RestrictedApplicationPipeError("OUTPUT_FAILED"))); }
    const result = bounded(value, 3000, "OUTPUT_FAILED");
    apply(then, result, [undefined, poison]);
    return result;
  }
  function observedProvider(request, context) {
    const job = scopes.getStore();
    if (!job || job.controller.signal.aborted || closed || poisoned) fail("CLOSED");
    job.dispatched = true;
    const value = apply(complete, undefined, [request, context]);
    // Preserve the SDK's opaque result admission. Never inspect/adopt a plain
    // thenable/Proxy before the actual SDK can reject it.
    if (value && !types.isProxy(value) && types.isPromise(value)) {
      const record = { value }; physical.add(record);
      try { sink(apply(then, value, [() => physical.delete(record), () => physical.delete(record)])); }
      catch { poison(); throw new RestrictedApplicationPipeError("UNOBSERVABLE_WORK"); }
    }
    return value;
  }
  function remoteRead(name, args, { signal }) {
    const job = scopes.getStore();
    if (!job || closed || poisoned || signal.aborted) fail("CLOSED");
    const readId = `read_${++readOrdinal}_${randomBytes(12).toString("hex")}`;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });sink(promise);
    const record = { job, readId, resolve, reject, subscription: null };
    pendingReads.set(readId, record);
    record.subscription = addAbortListener(signal, () => {
      // The parent owns physical read cancellation. Keep the callback pending
      // and charged until its exact reply arrives or the channel closes.
      if (!closed) sink(send("read_cancel", job.id, { readId }));
    });
    const dispatched = send("read", job.id, { readId, name, arguments: args });
    apply(then, dispatched, [undefined, () => {
      pendingReads.delete(readId); record.subscription?.[Symbol.dispose](); reject(new RestrictedApplicationPipeError("OUTPUT_FAILED"));
    }]);
    return promise;
  }
  const names = new Set();
  const tools = declared.map(raw => {
    const tool = dataFields(raw, ["name", "description", "inputSchema", "outputSchema"]);
    if (typeof tool.name !== "string" || !NAME.test(tool.name) || names.has(tool.name)) fail("INVALID_CONFIG");
    names.add(tool.name);
    return { name: tool.name, description: tool.description, inputSchema: checkedSchema(tool.inputSchema), outputSchema: checkedSchema(tool.outputSchema),
      readOnly: true, execute: (args, context) => remoteRead(tool.name, args, context) };
  });
  const runner = createRestrictedApplicationRunner({ provider: { supportsImages: false, complete: observedProvider },
    instructions: config.instructions, outputSchema: config.outputSchema, tools, limits: fixedLimits });
  const ready = makeFrame("ready", undefined, { engineProtocol: RESTRICTED_APPLICATION_PROTOCOL,
    providerAvailability: "not-probed", readTools: tools.length, maxFrameBytes: PIPE_MAX_FRAME_BYTES, maxRequests: 64, maxConcurrency: 1 });
  function runJob(job, request) {
    const promise = (async () => {
      try {
        // No provider dispatch before successful local accepted-frame delivery.
        await send("accepted", job.id);
        if (closed || poisoned) fail("CLOSED");
        if (job.controller.signal.aborted) fail("CANCELLED");
        const result = await scopes.run(job, () => runner.run(request, { signal: job.controller.signal }));
        if (job.controller.signal.aborted) fail("CANCELLED");
        const exact = dataFields(result, ["schemaVersion", "status", "proposal", "usage"]);
        if (exact.schemaVersion !== RESTRICTED_APPLICATION_PROTOCOL || exact.status !== "completed") fail("RUN_FAILED");
        await send("result", job.id, { result: exact });
      } catch (error) {
        const code = own(error, "code");
        // SDK capacity can remain charged after cancelled work returned. A BUSY
        // entry with zero dispatch is genuinely unissued and may reuse its ID.
        if (code === "BUSY" && !job.dispatched) seen.delete(job.id);
        if (!closed && !poisoned) {
          try { await send("error", job.id, publicError(error)); }
          catch { poison(); }
        }
      } finally { if (current === job) current = null; }
    })();
    runs.add(promise);sink(apply(then, promise, [() => runs.delete(promise), () => runs.delete(promise)]));
    return promise;
  }
  function accept(raw) {
    const operation = (async () => {
      if (closed || poisoned) fail("CLOSED");
      const frame = jsonSnapshot(raw, { maxBytes: PIPE_MAX_FRAME_BYTES });
      const header = ["schemaVersion", "protocol", "nonce", "scopeId", "type", "requestId"];
      if (frame.schemaVersion !== 1 || frame.protocol !== RESTRICTED_APPLICATION_PIPE_PROTOCOL || typeof frame.requestId !== "string" || !IDS.test(frame.requestId)) fail("INVALID_FRAME");
      const actionFields = ACTION_FIELDS.get(frame.type);
      if (!actionFields) fail("INVALID_FRAME");
      dataFields(frame, [...header, ...actionFields], [...header, ...(frame.type === "read_error" ? ["readId"] : actionFields)]);
      if (frame.nonce !== nonce || frame.scopeId !== scopeId) { await send("error", frame.requestId, { code: "SCOPE_MISMATCH" }); return; }
      if (frame.type === "run") {
        if (seen.has(frame.requestId)) { await send("error", frame.requestId, { code: "REQUEST_ID_REUSED" }); return; }
        if (current || pendingReads.size || physical.size) { await send("error", frame.requestId, { code: "BUSY" }); return; }
        if (seen.size >= 64) { await send("error", frame.requestId, { code: "WORKER_EXHAUSTED" }); return; }
        const request = dataFields(frame.request, ["input", "history"], ["input"]);
        const job = { id: frame.requestId, controller: new NativeAbortController(), dispatched: false };
        current = job; seen.add(job.id);runJob(job, request); return;
      }
      if (frame.type === "cancel") {
        if (!current || current.id !== frame.requestId) { await send("error", frame.requestId, { code: "REQUEST_NOT_ACTIVE" }); return; }
        current.controller.abort(); await send("cancel_requested", frame.requestId); return;
      }
      if (typeof frame.readId !== "string" || !/^read_[1-9][0-9]{0,5}_[a-f0-9]{24}$/.test(frame.readId)) fail("INVALID_FRAME");
      const read = pendingReads.get(frame.readId);
      if (!read || read.job.id !== frame.requestId) { await send("error", frame.requestId, { code: "READ_NOT_PENDING" }); return; }
      const failure = frame.type === "read_error"
        ? Object.hasOwn(frame, "failure") ? createRestrictedToolFailure(frame.failure) : new Error("Host read failed") : null;
      pendingReads.delete(frame.readId); read.subscription?.[Symbol.dispose]();
      if (frame.type === "read_result") read.resolve(frame.value);
      else read.reject(failure);
    })();
    return sink(operation);
  }
  function close() {
    if (!closing) {
      closed = true; current?.controller.abort();
      for (const read of pendingReads.values()) { read.subscription?.[Symbol.dispose](); read.reject(new RestrictedApplicationPipeError("CLOSED")); }
      pendingReads.clear();
      const drain = (async () => {
        while (runs.size || physical.size) {
          await Promise.allSettled([...runs, ...[...physical].map(record => record.value)]);
        }
        return Object.freeze({ localCallbacksDrained: true, remoteTerminationProven: false });
      })();
      closing = bounded(drain, closeGraceMs, "CLOSE_UNPROVEN");
      apply(then, closing, [undefined, () => { poisoned = true; }]);
    }
    return closing;
  }
  return Object.freeze({ ready, accept, close, inspect: () => Object.freeze({ activeRuns: runs.size, pendingReads: pendingReads.size,
    providerCallbacks: physical.size, seenRequests: seen.size, closed, poisoned }) });
}
