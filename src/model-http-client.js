import OpenAI from "openai";
import { types, TextDecoder } from "node:util";

// Decoded response bytes, including reasoning, native calls and error text.
// Request token hints are not a transport budget. No model/caller field can
// enlarge this bound; inline image REQUEST bytes are a separate policy.
export const MAX_MODEL_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;
const NativeByteArray = Uint8Array;
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
const setBytes = Uint8Array.prototype.set;
const apply = Reflect.apply;

const TERMINAL_QUOTA_CODES = new Set([
  "insufficient_quota", "insufficient_balance", "billing_hard_limit_reached", "quota_exceeded",
]);

function ownData(value, key) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// Billing/quota exhaustion cannot be repaired by backoff, different reasoning
// parameters or context compaction. Read only explicit HTTP/machine evidence;
// a quota word in model/error prose is not this classification's authority.
export function isTerminalModelQuotaError(error) {
  const status = ownData(error, "status");
  if (status === 402) return true;
  if (status !== 429) return false;
  const detail = ownData(error, "error");
  return [ownData(error, "code"), ownData(error, "type"), ownData(detail, "code"), ownData(detail, "type")]
    .some(code => typeof code === "string" && TERMINAL_QUOTA_CODES.has(code.toLowerCase()));
}

function responseHeaders(response, chunks) {
  if (response.status !== 402 && response.status !== 429) return response.headers;
  let terminal = response.status === 402;
  if (!terminal) {
    // These chunks have already passed the decoded 16 MiB transport bound.
    // Inspect the same bytes without teeing or consuming another body, then
    // return their original bytes/status/request metadata to the SDK unchanged.
    let size = 0;
    for (const chunk of chunks) size += apply(byteLengthOf, chunk, []);
    const bytes = new NativeByteArray(size);
    let offset = 0;
    for (const chunk of chunks) { apply(setBytes, bytes, [chunk, offset]); offset += apply(byteLengthOf, chunk, []); }
    try {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      terminal = isTerminalModelQuotaError({ status: response.status, error: body?.error });
    } catch { /* Unknown/malformed rate-limit evidence keeps its existing policy. */ }
    finally { bytes.fill(0); }
  }
  if (!terminal) return response.headers;
  const headers = new Headers(response.headers);
  headers.set("x-should-retry", "false");
  return headers;
}

class ModelResponseLimitError extends Error {
  constructor() {
    super("Model response exceeded the 16 MiB decoded response limit.");
    this.name = "ModelResponseLimitError";
    this.code = "MODEL_RESPONSE_TOO_LARGE";
    this.status = 413;
  }
}

class ModelResponseProtocolError extends Error {
  constructor() {
    super("Model response did not contain a valid HTTP byte stream.");
    this.name = "ModelResponseProtocolError";
    this.code = "MODEL_RESPONSE_INVALID";
    this.status = 422;
  }
}

function cancelBody(body, reason) {
  // A producer may reject or never settle cancellation. Observe it without
  // making a bounded refusal wait on the producer's cooperation.
  try { body?.cancel(reason).catch(() => {}); } catch { /* already locked/closed */ }
}

function terminalResponse(error = new ModelResponseLimitError()) {
  // SDKs retry thrown fetch failures and upstream 5xx/Retry-After hints. Return
  // a local terminal status with no upstream body, headers or diagnostics.
  return new Response(JSON.stringify({ error: { message: error.message, code: error.code, type: "model_response_limit" } }),
    { status: error.status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
}

function incompleteResponse() {
  // A body that failed after headers is not a new connection attempt. Do not
  // introduce SDK fetch retries by moving its consumption into this boundary.
  // The core may still apply its existing explicit transient-recovery policy.
  return new Response(JSON.stringify({ error: { message: "Model response ended before its body was complete.", code: "MODEL_RESPONSE_INCOMPLETE", type: "model_response_incomplete" } }),
    { status: 502, headers: { "content-type": "application/json", "x-should-retry": "false" } });
}

function budgetReader(body, signal, onStop = () => {}) {
  const reader = body.getReader();
  let bytes = 0, stopped = false, stopError, ended = false, reading = false, released = false;
  const release = () => {
    if (released || reading) return;
    reader.releaseLock(); released = true;
  };
  const detach = () => signal?.removeEventListener("abort", onAbort);
  const stop = error => {
    if (stopped || ended) return;
    stopped = true; stopError = error; detach();
    try { reader.cancel(error).catch(() => {}); } catch { /* reader already unusable */ }
    onStop(error); release();
  };
  const onAbort = () => stop(new DOMException("Model response aborted.", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    async read() {
      if (stopped) throw stopError;
      if (ended) return { done: true };
      reading = true;
      try {
        const item = await reader.read();
        if (stopped) throw stopError;
        if (item.done) { ended = true; detach(); return item; }
        if (!types.isUint8Array(item.value)) { stop(new ModelResponseProtocolError()); throw stopError; }
        const length = apply(byteLengthOf, item.value, []);
        bytes += length;
        if (bytes > MAX_MODEL_HTTP_RESPONSE_BYTES) { stop(new ModelResponseLimitError()); throw stopError; }
        // Count/copy intrinsic bytes, never an own byteLength/iterator hook or
        // a mutable alias retained by a custom trusted transport.
        const value = new NativeByteArray(length); apply(setBytes, value, [item.value]);
        return { value, done: false };
      } catch (error) { stop(error); throw stopped ? stopError : error; }
      finally { reading = false; if (stopped || ended) release(); }
    },
    cancel(reason) { stop(reason); },
  };
}

function retainResponseMetadata(next, original) {
  for (const key of ["url", "redirected", "type"]) Object.defineProperty(next, key, { value: original[key] });
  const clone = next.clone.bind(next);
  Object.defineProperty(next, "clone", { value: () => retainResponseMetadata(clone(), original) });
  return next;
}

async function boundedResponse(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared.trim()) && Number(declared) > MAX_MODEL_HTTP_RESPONSE_BYTES) {
    cancelBody(response.body); return terminalResponse();
  }
  if (!response.body) {
    if (response.status !== 402) return response;
    return retainResponseMetadata(new Response(null, { status: response.status, statusText: response.statusText, headers: responseHeaders(response, []) }), response);
  }
  if (response.ok && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream") {
    let streamController;
    const budget = budgetReader(response.body, signal, error => streamController?.error(error));
    const body = new ReadableStream({
      start(controller) { streamController = controller; },
      async pull(controller) {
        try { const item = await budget.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
        catch (error) { controller.error(error); }
      },
      cancel(reason) { budget.cancel(reason); },
    });
    return retainResponseMetadata(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), response);
  }
  // Inspect before giving non-streaming/error bodies to the SDK. Retain only
  // bounded byte chunks, never unbounded text/JSON or a tee's unread branch.
  // The replacement carries the unchanged HTTP metadata and exact body bytes.
  const budget = budgetReader(response.body, signal);
  const chunks = [];
  try {
    for (;;) { const item = await budget.read(); if (item.done) break; chunks.push(item.value); }
    if (signal?.aborted) throw new DOMException("Model response aborted.", "AbortError");
    const headers = responseHeaders(response, chunks);
    const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); chunks.length = 0; controller.close(); } });
    return retainResponseMetadata(new Response(body, { status: response.status, statusText: response.statusText, headers }), response);
  } catch (error) {
    budget.cancel(error);
    if (error instanceof ModelResponseLimitError || error instanceof ModelResponseProtocolError) return terminalResponse(error);
    if (signal?.aborted) throw error;
    return incompleteResponse();
  }
}

// Server-owned model configuration selects one canonical endpoint. A redirect
// is not authority to forward prompts, attachments or credentials elsewhere.
// Manual mode preserves the 3xx status, which the SDK does not retry. Retain
// an existing stricter error policy, but never accept implicit/follow mode.
export function createModelHttpClient(options) {
  const redirect = options.fetchOptions?.redirect === "error" ? "error" : "manual";
  const transportFetch = options.fetch || globalThis.fetch;
  return new OpenAI({ ...options, fetchOptions: { ...options.fetchOptions, redirect },
    fetch: async (input, init) => {
      const response = await Reflect.apply(transportFetch, undefined, [input, { ...init, redirect }]);
      if (!isModelHttpRedirect(response)) return boundedResponse(response, init?.signal);
      // A redirect body is neither model data nor useful error evidence. Do
      // not wait for it, propagate its Location, or honor retry hints. Native
      // cancellation closes the unconsumed stream; observe its rejection too.
      try { response.body?.cancel().catch(() => {}); } catch { /* already unusable */ }
      return new Response(null, { status: response.status });
    },
  });
}

export function isModelHttpRedirect(error) {
  return Number.isInteger(error?.status) && error.status >= 300 && error.status < 400;
}
