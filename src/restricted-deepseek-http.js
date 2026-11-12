import { Agent, request } from "node:https";
import { performance } from "node:perf_hooks";
import { types, TextDecoder } from "node:util";
import { addAbortListener } from "node:events";
import { dataFields, integer, jsonSnapshot, fail, parseRestrictedJson, RestrictedApplicationError } from "./restricted-application-contract.js";

// Internal transport building block. No caller-selectable endpoint, fetch,
// credential discovery, listener, retry or redirect handler. This is local
// request containment, not proof a remote inference stopped or was uncharged.
const NativeAgent = Agent, nativeRequest = request;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CLEANUP_GRACE_MS = 3000;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
const setBytes = Uint8Array.prototype.set;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;

function checkedSignal(value) {
  if (value === undefined) return;
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== AbortSignal.prototype || Object.getOwnPropertyNames(value).length) fail();
  try { Reflect.apply(signalAborted, value, []); } catch { fail(); }
  return value;
}

function statusCategory(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500 && status <= 503) return "unavailable";
  return "protocol";
}

function containsCredential(value, secret) {
  if (typeof value === "string") return value.includes(secret);
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some(key => key.includes(secret) || containsCredential(value[key], secret));
}

export function createDeepSeekHttpTransport(options, issueFailure) {
  const fields = dataFields(options, ["apiKey", "model", "userId", "timeoutMs", "maxConcurrency"], ["apiKey", "model", "userId"]);
  if (typeof fields.apiKey !== "string" || !/^[\x21-\x7e]{16,512}$/.test(fields.apiKey)) fail();
  if (!["deepseek-flash", "deepseek-v4-pro"].includes(fields.model)) fail();
  if (typeof fields.userId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(fields.userId)) fail();
  if (fields.userId.includes(fields.apiKey)) fail();
  const timeoutMs = integer(Object.hasOwn(fields, "timeoutMs") ? fields.timeoutMs : 30_000, 100, 60_000);
  const maxConcurrency = integer(Object.hasOwn(fields, "maxConcurrency") ? fields.maxConcurrency : 4, 1, 32);
  const agent = new NativeAgent({ keepAlive: true, maxSockets: maxConcurrency, maxTotalSockets: maxConcurrency,
    maxFreeSockets: Math.min(maxConcurrency, 2), timeout: 5000 });
  const pending = new Set(), sockets = new Map();
  let closed = false, poisoned = false, poisoning = false, closing;
  const failure = (category, retryAfterMs = null) => issueFailure({ category, retryAfterMs });
  function poisonAll() {
    poisoned = true;
    if (poisoning) return;
    poisoning = true;
    try {
      for (const task of pending) task.stop(failure("unavailable"));
      try { agent.destroy(); } catch { /* poison and failed close remain */ }
      for (const socket of sockets.keys()) {
        try { socket.destroy(); } catch { /* retain exact unclosed socket */ }
      }
    } finally { poisoning = false; }
  }
  function trackSocket(socket) {
    if (socket.closed === true) return;
    if (!sockets.has(socket)) {
      const completion = new Promise(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); }));
      sockets.set(socket, completion);
    }
    if (closed || poisoned) socket.destroy();
  }

  function complete(rawBody, rawOptions = {}) {
    const { signal: value } = dataFields(rawOptions, ["signal"], []), signal = checkedSignal(value);
    if (signal && Reflect.apply(signalAborted, signal, [])) throw new RestrictedApplicationError("CANCELLED");
    if (closed || poisoned || pending.size >= maxConcurrency) throw failure("unavailable");
    const body = jsonSnapshot(rawBody, { maxBytes: MAX_REQUEST_BYTES });
    const wire = dataFields(body, ["model", "messages", "tools", "response_format", "thinking", "max_tokens", "stream", "temperature"],
      ["model", "messages", "response_format", "thinking", "max_tokens", "stream", "temperature"]);
    if (wire.model !== fields.model || wire.stream !== false || wire.temperature !== 0 ||
        JSON.stringify(wire.response_format) !== '{"type":"json_object"}' || JSON.stringify(wire.thinking) !== '{"type":"disabled"}') fail();
    integer(wire.max_tokens, 1, 8192);
    const payload = { ...wire, user_id: fields.userId };
    if (containsCredential(payload, fields.apiKey)) fail("SENSITIVE_DATA");
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    if (bytes.length > MAX_REQUEST_BYTES) fail("DATA_LIMIT");

    let resolve, reject, retire;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {}); // Observe this owned task even if the SDK turn stops waiting.
    const retired = new Promise(yes => { retire = yes; });
    const deadline = performance.now() + timeoutMs;
    let req, res, timer, cleanupTimer, abortSubscription, requestClosed = false, responseClosed = true, physicallyRetired = false, settled = false;
    let error = null, output, ended = false, used = 0;
    const buffer = new Uint8Array(MAX_RESPONSE_BYTES);
    const record = { retired, stop };
    pending.add(record);

    function settle() {
      if (physicallyRetired || !requestClosed || !responseClosed) return;
      physicallyRetired = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      abortSubscription?.[Symbol.dispose]();
      pending.delete(record); retire(); buffer.fill(0);
      if (settled) return;
      settled = true;
      if (!error && (!ended || performance.now() >= deadline)) error = failure(ended ? "timeout" : "unavailable");
      if (error) reject(error); else resolve(output);
      output = undefined;
    }
    function stop(reason) {
      if (physicallyRetired) return;
      error ??= reason;
      output = undefined;
      if (!cleanupTimer) cleanupTimer = setTimeout(() => {
        if (physicallyRetired) return;
        poisonAll(); clearTimeout(timer); abortSubscription?.[Symbol.dispose]();
        // A bounded public failure is not physical retirement. Keep the exact
        // record charged, permanently block admission and wait for real close.
        if (!settled) { settled = true; reject(failure("unavailable")); }
      }, CLEANUP_GRACE_MS);
      try { res?.destroy(); } catch { poisonAll(); }
      try { req?.destroy(); } catch { poisonAll(); }
    }
    function onAbort() { stop(new RestrictedApplicationError("CANCELLED")); }
    function checkpoint() {
      if (signal && Reflect.apply(signalAborted, signal, [])) onAbort();
      else if (performance.now() >= deadline) stop(failure("timeout"));
      return !error;
    }
    function receive(response) {
      if (physicallyRetired) { response.destroy(); return; }
      res = response; responseClosed = false;
      res.once("close", () => { responseClosed = true; settle(); });
      res.once("error", () => stop(failure("unavailable")));
      res.once("aborted", () => stop(failure("unavailable")));
      if (!checkpoint() || closed || poisoned) { stop(error || failure("unavailable")); return; }
      if (res.statusCode !== 200) {
        const category = statusCategory(res.statusCode);
        const header = res.headers["retry-after"];
        const retryAfterMs = ["rate_limit", "unavailable"].includes(category) && typeof header === "string" &&
          /^(0|[1-9][0-9]{0,4})$/.test(header) && Number(header) <= 86400 ? Number(header) * 1000 : null;
        stop(failure(category, retryAfterMs)); return;
      }
      const contentType = res.headers["content-type"], encoding = res.headers["content-encoding"], length = res.headers["content-length"];
      if (typeof contentType !== "string" || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) ||
          (encoding !== undefined && (typeof encoding !== "string" || encoding.toLowerCase() !== "identity")) ||
          (length !== undefined && (typeof length !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))) {
        stop(failure("protocol")); return;
      }
      res.on("data", chunk => {
        if (!checkpoint()) return;
        if (types.isProxy(chunk) || !types.isUint8Array(chunk)) { stop(failure("protocol")); return; }
        const size = Reflect.apply(byteLength, chunk, []);
        if (used + size > MAX_RESPONSE_BYTES) { stop(failure("protocol")); return; }
        Reflect.apply(setBytes, buffer, [chunk, used]); used += size;
      });
      res.once("end", () => {
        if (!checkpoint()) return;
        try {
          if (res.complete !== true) throw Error("incomplete");
          const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used));
          output = parseRestrictedJson(decoded);
          if (containsCredential(output, fields.apiKey)) throw Error("credential reflection");
          if (!checkpoint()) return;
          ended = true;
        } catch { stop(failure("protocol")); }
        settle();
      });
    }
    timer = setTimeout(() => stop(failure("timeout")), timeoutMs);
    try {
      if (signal) abortSubscription = addAbortListener(signal, onAbort);
      req = nativeRequest({ protocol: "https:", hostname: "api.deepseek.com", port: 443, path: "/v1/chat/completions", method: "POST",
        agent, rejectUnauthorized: true, maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        headers: { authorization: `Bearer ${fields.apiKey}`, "content-type": "application/json",
          accept: "application/json", "accept-encoding": "identity", "content-length": bytes.length } }, receive);
      req.once("socket", trackSocket);
      req.once("close", () => { requestClosed = true; settle(); });
      req.once("error", cause => stop(failure(typeof cause?.code === "string" && cause.code.startsWith("HPE_") ? "protocol" : "unavailable")));
      if (closed || poisoned || !checkpoint()) stop(error || failure("unavailable"));
      else req.end(bytes); // One request, one end, zero retry/reconnect logic.
    } catch {
      if (req) stop(failure("unavailable"));
      else { requestClosed = true; error ??= failure("unavailable"); settle(); }
    }
    return promise;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    let resolve, reject;
    closing = new Promise((yes, no) => { resolve = yes; reject = no; });
    closing.catch(() => {});
    let timeout;
    const drain = (async () => {
      let cleanupFailed = false;
      for (const task of pending) task.stop(failure("unavailable"));
      try { agent.destroy(); } catch { cleanupFailed = true; }
      for (const socket of sockets.keys()) {
        try { socket.destroy(); } catch { cleanupFailed = true; }
      }
      // Requests admitted before close may attach a socket before reporting
      // close. Drain to a stable empty set; do not assert remote quiescence.
      while (pending.size || sockets.size) await Promise.allSettled([
        ...Array.from(pending, task => task.retired), ...sockets.values(),
      ]);
      if (cleanupFailed || poisoned) throw failure("unavailable");
    })();
    const bounded = new Promise((_, no) => {
      timeout = setTimeout(() => { poisonAll(); no(failure("unavailable")); }, CLEANUP_GRACE_MS);
    });
    Promise.race([drain, bounded]).then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); },
    );
    return closing;
  }
  return Object.freeze({ complete, close });
}
