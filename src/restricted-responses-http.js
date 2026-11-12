import { Agent, request } from "node:https";
import { rootCertificates, checkServerIdentity } from "node:tls";
import { performance } from "node:perf_hooks";
import { types, TextDecoder } from "node:util";
import { addAbortListener } from "node:events";
import { dataFields, integer, jsonSnapshot, parseRestrictedJson, fail, RestrictedApplicationError } from "./restricted-application-contract.js";
import { buildRestrictedResponsesRequest, createRestrictedResponsesDecoder, restrictedResponsesFailure } from "./restricted-responses-protocol.js";

// Internal, unwired transport. Explicit app-owned token/scope, never CLI auth.
// No endpoint, agent, fetch, environment, retry, refresh or redirect injection.
const NativeAgent = Agent, nativeRequest = request, NativePromise = Promise;
const ca = Object.freeze([...rootCertificates]), verifyIdentity = checkServerIdentity;
const monotonic = performance.now.bind(performance), wallTime = Date.now;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get;
const setBytes = Uint8Array.prototype.set;
const WIRE_LIMIT = 1024 * 1024, ERROR_LIMIT = 16 * 1024, CLEANUP_GRACE_MS = 3000;

function signalValue(value) {
  if (value === undefined) return;
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== AbortSignal.prototype || Object.getOwnPropertyNames(value).length) fail();
  try { Reflect.apply(signalAborted, value, []); } catch { fail(); }
  return value;
}
function contains(value, secret) {
  if (typeof value === "string") return value.includes(secret);
  if (typeof value === "number") return JSON.stringify(value).includes(secret);
  return value !== null && typeof value === "object" && Object.keys(value).some(key => key.includes(secret) || contains(value[key], secret));
}
function category(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  return status >= 500 && status <= 503 ? "unavailable" : "protocol";
}
function nativeParserFailure(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return false;
  const code = Object.getOwnPropertyDescriptor(value, "code");
  return code && Object.hasOwn(code, "value") && typeof code.value === "string" && code.value.startsWith("HPE_");
}
function headers(response, limit) {
  if (!Array.isArray(response.rawHeaders) || response.rawHeaders.length > 256 || response.rawHeaders.length % 2) return false;
  const seen = new Set();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index].toLowerCase();
    if (["content-type", "content-encoding", "content-length", "transfer-encoding", "retry-after", "location"].includes(name)) {
      if (seen.has(name)) return false; seen.add(name);
    }
  }
  const h = response.headers, length = h["content-length"], encoding = h["content-encoding"], transfer = h["transfer-encoding"];
  return (encoding === undefined || typeof encoding === "string" && /^identity(?![\s\S])/i.test(encoding)) &&
    (length === undefined || typeof length === "string" && /^(0|[1-9][0-9]{0,9})(?![\s\S])/.test(length) && Number(length) <= limit) &&
    (transfer === undefined || typeof transfer === "string" && /^chunked(?![\s\S])/i.test(transfer)) &&
    !(length !== undefined && transfer !== undefined);
}

export function createResponsesHttpTransport(options, issueFailure) {
  if (types.isProxy(issueFailure) || typeof issueFailure !== "function") fail();
  const value = dataFields(options, ["accessToken", "principalId", "expiresAt", "model", "reasoningEffort", "timeoutMs", "maxConcurrency"],
    ["accessToken", "principalId", "expiresAt", "model", "reasoningEffort"]);
  if (typeof value.accessToken !== "string" || !/^[\x21-\x7e]{16,8192}(?![\s\S])/.test(value.accessToken) ||
      typeof value.principalId !== "string" || !/^[A-Za-z0-9._~-]{16,128}(?![\s\S])/.test(value.principalId) || value.principalId.includes(value.accessToken) ||
      typeof value.expiresAt !== "string") fail();
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== value.expiresAt || expiresAt > wallTime() + 86_400_000) fail();
  const failure = (kind, retryAfterMs = null) => issueFailure({ category: kind, retryAfterMs });
  if (expiresAt <= wallTime()) throw failure("authentication");
  const timeoutMs = integer(Object.hasOwn(value, "timeoutMs") ? value.timeoutMs : 30_000, 100, 120_000);
  const maxConcurrency = integer(Object.hasOwn(value, "maxConcurrency") ? value.maxConcurrency : 1, 1, 16);
  const fixed = Object.freeze({ model: value.model, reasoningEffort: value.reasoningEffort });
  const validation = createRestrictedResponsesDecoder({ ...fixed, outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } });
  validation.cancel();
  let accessToken = value.accessToken;
  if (fixed.model.includes(accessToken)) fail();
  let agent;
  try {
    agent = new NativeAgent({ keepAlive: false, maxSockets: maxConcurrency, maxTotalSockets: maxConcurrency,
      maxCachedSessions: 0, timeout: 5000, proxyEnv: Object.freeze({}) });
  } catch { throw failure("unavailable"); }
  const pending = new Set(), sockets = new Map();
  let closed = false, poisoned = false, poisoning = false, closing = null;

  function poisonAll() {
    poisoned = true;
    if (poisoning) return;
    poisoning = true;
    try {
      for (const task of pending) task.stop(failure("unavailable"));
      try { agent.destroy(); } catch { /* poisoned state and close failure remain */ }
      for (const socket of sockets.keys()) { try { socket.destroy(); } catch { /* retain exact unclosed socket */ } }
    } finally { poisoning = false; }
  }

  function complete(rawRequest, rawOptions = {}) {
    const started = monotonic();
    const signal = signalValue(dataFields(rawOptions, ["signal"], []).signal);
    if (signal && Reflect.apply(signalAborted, signal, [])) throw new RestrictedApplicationError("CANCELLED");
    if (closed || poisoned || pending.size >= maxConcurrency) throw failure("unavailable");
    if (wallTime() >= expiresAt) throw failure("authentication");
    const raw = jsonSnapshot(rawRequest, { maxBytes: 2 * WIRE_LIMIT });
    const profile = { ...fixed, outputSchema: raw.outputSchema };
    const body = buildRestrictedResponsesRequest(raw, profile);
    if (contains(body, accessToken)) fail("SENSITIVE_DATA");
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    if (bytes.length > WIRE_LIMIT) fail("DATA_LIMIT");
    const stream = createRestrictedResponsesDecoder(profile);
    const authorizationTime = Math.max(0, expiresAt - wallTime());
    const authorizationDeadline = monotonic() + authorizationTime;
    const deadline = Math.min(started + timeoutMs, authorizationDeadline);
    const authorizationFirst = authorizationDeadline <= started + timeoutMs;
    if (monotonic() >= deadline) { stream.cancel(); throw failure(authorizationFirst ? "authentication" : "timeout"); }
    let resolve, reject, retire;
    const promise = new NativePromise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
    const retired = new NativePromise(yes => { retire = yes; });
    let req, res, timer, cleanupTimer, abortSubscription, requestClosed = false, responseClosed = true, physicallyRetired = false, settled = false;
    let error = null, output = null, ended = false, errorBytes = null, used = 0, responseStatus = null, retryAfterMs = null;
    const ownedSockets = new Set(), record = { promise, retired, stop };
    pending.add(record);

    function settle() {
      if (physicallyRetired || !requestClosed || !responseClosed || ownedSockets.size) return;
      physicallyRetired = true; pending.delete(record); clearTimeout(timer); clearTimeout(cleanupTimer);
      abortSubscription?.[Symbol.dispose]();
      bytes.fill(0); errorBytes?.fill(0); retire();
      if (settled) return;
      settled = true;
      if (!error && wallTime() >= expiresAt) error = failure("authentication");
      if (!error && (!ended || monotonic() >= deadline)) error = failure(ended ? authorizationFirst ? "authentication" : "timeout" : "unavailable");
      if (error) reject(error); else resolve(output);
      output = null;
    }
    function stop(reason) {
      if (physicallyRetired) return;
      error ??= reason; output = null; stream.cancel();
      if (!cleanupTimer) cleanupTimer = setTimeout(() => {
        if (physicallyRetired) return;
        poisonAll();
        abortSubscription?.[Symbol.dispose]();
        clearTimeout(timer);
        // Return a bounded failure without inventing physical retirement. The
        // record/slot stays charged until all exact close events arrive.
        if (!settled) { settled = true; reject(failure("unavailable")); }
      }, CLEANUP_GRACE_MS);
      try { res?.destroy(); } catch { poisonAll(); }
      try { req?.destroy(); } catch { poisonAll(); }
    }
    function onAbort() { stop(new RestrictedApplicationError("CANCELLED")); }
    function checkpoint() {
      if (signal && Reflect.apply(signalAborted, signal, [])) onAbort();
      else if (wallTime() >= expiresAt) stop(failure("authentication"));
      else if (monotonic() >= deadline) stop(failure(authorizationFirst ? "authentication" : "timeout"));
      return !error;
    }
    function socketAttached(socket) {
      if (socket.closed === true) return;
      ownedSockets.add(socket);
      if (!sockets.has(socket)) {
        let done; const completion = new NativePromise(yes => { done = yes; });
        sockets.set(socket, completion);
        socket.once("close", () => { sockets.delete(socket); ownedSockets.delete(socket); done(); settle(); });
      }
      if (closed || poisoned || error || physicallyRetired) socket.destroy();
    }
    function receive(response) {
      if (physicallyRetired) { response.destroy(); return; }
      res = response; responseClosed = false; responseStatus = res.statusCode;
      res.once("close", () => { responseClosed = true; settle(); });
      res.once("error", () => stop(failure("unavailable")));
      res.once("aborted", () => stop(failure("unavailable")));
      if (!checkpoint() || closed || poisoned) { stop(error || failure("unavailable")); return; }
      const success = responseStatus === 200, limit = success ? WIRE_LIMIT : ERROR_LIMIT;
      if (!headers(res, limit)) { stop(failure("protocol")); return; }
      const type = res.headers["content-type"], retry = res.headers["retry-after"];
      if (typeof retry === "string" && /^(0|[1-9][0-9]{0,4})(?![\s\S])/.test(retry) && Number(retry) <= 86400) retryAfterMs = Number(retry) * 1000;
      if (success ? typeof type !== "string" || !/^text\/event-stream(?:;[ \t]*charset=utf-8)?(?![\s\S])/i.test(type) :
        responseStatus !== 429 || typeof type !== "string" || !/^application\/json(?:;[ \t]*charset=utf-8)?(?![\s\S])/i.test(type)) {
        const kind = category(responseStatus);
        stop(failure(success ? "protocol" : kind, ["rate_limit", "unavailable"].includes(kind) ? retryAfterMs : null)); return;
      }
      if (!success) errorBytes = new Uint8Array(ERROR_LIMIT);
      res.on("data", chunk => {
        if (!checkpoint() || closed || poisoned) return;
        try {
          if (success) stream.push(chunk);
          else {
            if (types.isProxy(chunk) || !types.isUint8Array(chunk)) throw null;
            const size = Reflect.apply(byteLength, chunk, []); if (used + size > ERROR_LIMIT) throw null;
            Reflect.apply(setBytes, errorBytes, [chunk, used]); used += size;
          }
        } catch (cause) {
          const metadata = restrictedResponsesFailure(cause);
          stop(metadata ? issueFailure(metadata) : failure("protocol"));
        }
      });
      res.once("end", () => {
        if (!checkpoint() || error) return;
        try {
          if (res.complete !== true) throw null;
          if (success) {
            output = stream.finish(); if (contains(output, accessToken)) throw null;
            ended = true;
          } else {
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(errorBytes.subarray(0, used));
            const parsed = parseRestrictedJson(text);
            let code;
            if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "error")) {
              const detail = dataFields(parsed.error, ["code", "message", "type", "param"], ["code", "message"]);
              if (!(detail.code === null || typeof detail.code === "string" && detail.code.length <= 160) ||
                  typeof detail.message !== "string" || detail.message.length > 4096 ||
                  Object.hasOwn(detail, "type") && !(detail.type === null || typeof detail.type === "string" && detail.type.length <= 160) ||
                  Object.hasOwn(detail, "param") && !(detail.param === null || typeof detail.param === "string" && detail.param.length <= 1024)) throw null;
              code = detail.code;
            }
            const quota = ["subscription_sharing_usage_limit_exceeded", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"].includes(code);
            stop(failure(quota ? "quota" : "rate_limit", quota ? null : retryAfterMs));
          }
        } catch (cause) {
          const metadata = restrictedResponsesFailure(cause);
          stop(metadata ? issueFailure(metadata) : failure("protocol"));
        }
        settle();
      });
    }
    timer = setTimeout(() => stop(failure(authorizationFirst ? "authentication" : "timeout")), Math.max(0, deadline - monotonic()));
    try {
      if (signal) abortSubscription = addAbortListener(signal, onAbort);
      req = nativeRequest({ protocol: "https:", hostname: "api.openai.com", port: 443, path: "/v1/responses", method: "POST",
        servername: "api.openai.com", agent, ca, checkServerIdentity: verifyIdentity, minVersion: "TLSv1.2", rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "text/event-stream",
          "accept-encoding": "identity", "content-length": bytes.length, connection: "close" } }, receive);
      req.once("socket", socketAttached);
      req.once("close", () => { requestClosed = true; settle(); });
      req.once("error", cause => stop(failure(nativeParserFailure(cause) ? "protocol" : "unavailable")));
      if (closed || poisoned || !checkpoint()) stop(error || failure("unavailable")); else req.end(bytes);
    } catch {
      if (req) stop(failure("unavailable"));
      else { requestClosed = true; error ??= failure("unavailable"); settle(); }
    }
    return promise;
  }

  function close() {
    if (closing) return closing;
    closed = true; accessToken = null;
    let resolve, reject;
    closing = new NativePromise((yes, no) => { resolve = yes; reject = no; }); closing.catch(() => {});
    let timeout;
    const drain = (async () => {
      let failed = false;
      for (const task of pending) task.stop(failure("unavailable"));
      try { agent.destroy(); } catch { failed = true; poisoned = true; }
      for (const socket of sockets.keys()) { try { socket.destroy(); } catch { failed = true; poisoned = true; } }
      while (pending.size || sockets.size) await NativePromise.all([
        ...Array.from(pending, task => task.retired), ...sockets.values(),
      ]);
      if (failed || poisoned) throw failure("unavailable");
    })();
    const bounded = new NativePromise((_, no) => { timeout = setTimeout(() => { poisoned = true; no(failure("unavailable")); }, CLEANUP_GRACE_MS); });
    NativePromise.race([drain, bounded]).then(result => { clearTimeout(timeout); resolve(result); }, error => { clearTimeout(timeout); reject(error); });
    return closing;
  }
  return Object.freeze({ complete, close });
}
