import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import http from "node:http";
import zlib from "node:zlib";
import test from "node:test";
import { createModelHttpClient, MAX_MODEL_HTTP_RESPONSE_BYTES } from "../src/model-http-client.js";
import { createClient, createChatCompletion, isTransientProviderRequestError, shouldRetryWithTextToolProtocol } from "../src/model-client.js";
import { resolveProviderHandoff } from "../src/provider-handoff.js";

const LIMIT = 16 * 1024 * 1024;
assert.equal(MAX_MODEL_HTTP_RESPONSE_BYTES, LIMIT);
const MiB = 1024 * 1024;
const payload = { model: "bounded-response-fixture", messages: [{ role: "user", content: "Please summarize this supplied note." }], max_tokens: 128 };
const prefix = '{"choices":[{"message":{"role":"assistant","content":"';
const suffix = '"},"finish_reason":"stop"}]}';
const complete = { choices: [{ message: { role: "assistant", content: "Observed note." }, finish_reason: "stop" }] };
const expectedLimit = error => error.code === "MODEL_RESPONSE_TOO_LARGE" && error.status === 413 && !error.message.includes("PRIVATE_PROVIDER_ERROR");
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

function source({ bytes = LIMIT + MiB, status = 200, headers = {}, error = false, chunkSize = 64 * 1024, cancelNeverSettles = false } = {}) {
  const record = { pulls: 0, delivered: 0, cancelled: 0, calls: 0 };
  let remaining = bytes, phase = 0;
  const body = new ReadableStream({
    pull(controller) {
      record.pulls++;
      let text;
      if (!phase++) text = error ? '{"error":{"message":"PRIVATE_PROVIDER_ERROR' : prefix;
      else if (remaining) { const n = Math.min(remaining, chunkSize); remaining -= n; text = "x".repeat(n); }
      else if (phase === Math.ceil(bytes / chunkSize) + 2) text = error ? '"}}' : suffix;
      else { controller.close(); return; }
      const chunk = new TextEncoder().encode(text); record.delivered += chunk.byteLength; controller.enqueue(chunk);
    },
    cancel() { record.cancelled++; if (cancelNeverSettles) return new Promise(() => {}); },
  });
  return { record, body, fetch: async (_input, init) => {
    record.calls++; record.signal = init.signal;
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  } };
}
const client = fetch => createModelHttpClient({ apiKey: "synthetic-response-key", baseURL: "https://model.fixture.invalid/v1", fetch });

test("declared oversize is refused before draining the body and cannot spend SDK retries", async () => {
  const s = source({ bytes: 1, headers: { "content-length": String(LIMIT + 1), "x-should-retry": "true", "retry-after-ms": "0" } });
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
  assert.equal(s.record.calls, 1); assert.equal(s.record.cancelled, 1); assert.ok(s.record.delivered < MiB);
});

test("unknown-length success is capped before parsing or returning oversized model data", async () => {
  const s = source({ bytes: 32 * MiB });
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
  assert.equal(s.record.calls, 1); assert.equal(s.record.cancelled, 1);
  assert.ok(s.record.delivered <= LIMIT + 2 * 64 * 1024); assert.equal(s.body.locked, false);
});

test("oversized error never leaks raw text or follows upstream retry instructions", async () => {
  const s = source({ status: 500, bytes: 32 * MiB, error: true, headers: { "x-should-retry": "true", "retry-after-ms": "0" } });
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
  assert.equal(s.record.calls, 1); assert.equal(s.record.cancelled, 1); assert.equal(s.body.locked, false);
});

test("exact decoded byte boundary remains valid", async () => {
  const s = source({ bytes: LIMIT - Buffer.byteLength(prefix + suffix) });
  const result = await client(s.fetch).chat.completions.create(payload);
  assert.equal(result.choices[0].message.content.length, LIMIT - Buffer.byteLength(prefix + suffix));
  assert.equal(s.record.delivered, LIMIT); assert.equal(s.record.cancelled, 0); assert.equal(s.body.locked, false);
});

test("one byte over cannot truncate a response into success", async () => {
  const s = source({ bytes: LIMIT + 1 - Buffer.byteLength(prefix + suffix) });
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
});

test("UTF-8 byte count is independent of string length", async () => {
  const text = "界".repeat(Math.ceil(LIMIT / 3)); assert.ok(text.length < LIMIT);
  const s = source({ bytes: 1 }); s.fetch = async (_input, init) => { s.record.signal = init.signal; return new Response(prefix + text + suffix, { headers: { "content-type": "application/json" } }); };
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
});

test("a lying small Content-Length cannot bypass the counted body", async () => {
  const s = source({ headers: { "content-length": "12" } });
  await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
});

test("body cancellation rejection or nonsettlement cannot strand refusal", { timeout: 5000 }, async () => {
  for (const declared of [false, true]) {
    const s = source({ bytes: 32 * MiB, cancelNeverSettles: true, headers: declared ? { "content-length": String(LIMIT + 1) } : {} });
    await assert.rejects(client(s.fetch).chat.completions.create(payload), expectedLimit);
    assert.equal(s.record.cancelled, 1);
  }
});

test("ordinary response preserves status, headers, URL and complete native tool-call bytes", async () => {
  const body = { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "read_1", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' } }] } }] };
  let response;
  const c = client(async () => {
    response = new Response(JSON.stringify(body), { status: 200, statusText: "Fixture OK", headers: { "content-type": "application/json", "x-request-id": "bounded-native-1", "x-safe-header": "unchanged" } });
    Object.defineProperty(response, "url", { value: "https://model.fixture.invalid/v1/chat/completions" });
    return response;
  });
  const result = await c.chat.completions.create(payload).withResponse();
  assert.deepEqual(result.data, body); assert.equal(result.request_id, "bounded-native-1");
  assert.equal(result.response.statusText, "Fixture OK"); assert.equal(result.response.url, response.url);
  assert.equal(result.response.headers.get("x-safe-header"), "unchanged");
});

test("ordinary small authentication error remains an authentication error", async () => {
  await assert.rejects(client(async () => new Response(JSON.stringify({ error: { message: "Credential unavailable", code: "invalid_api_key" } }),
    { status: 401, headers: { "content-type": "application/json" } })).chat.completions.create(payload), error => error.status === 401 && error.code === "invalid_api_key");
});

async function server(t, handler) {
  const s = http.createServer(handler); s.listen(0, "127.0.0.1"); await once(s, "listening");
  t.after(async () => { const done = once(s, "close"); s.close(); s.closeAllConnections(); await done; });
  return `http://127.0.0.1:${s.address().port}/v1`;
}

test("real compressed HTTP is limited after decompression, not its small wire length", async t => {
  const bytes = zlib.gzipSync(Buffer.from(prefix + "x".repeat(LIMIT + 1) + suffix)); assert.ok(bytes.length < 64 * 1024);
  let calls = 0;
  const baseURL = await server(t, (req, res) => { calls++; req.resume(); res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(bytes.length) }); res.end(bytes); });
  await assert.rejects(createModelHttpClient({ apiKey: "synthetic-response-key", baseURL }).chat.completions.create(payload), expectedLimit);
  assert.equal(calls, 1);
});

test("caller cancellation during a stalled body closes it and removes guard listeners", { timeout: 5000 }, async () => {
  let entered, captured, cancelled = 0;
  const ready = new Promise(resolve => entered = resolve);
  const parent = new AbortController();
  const c = client(async (_url, init) => {
    captured = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(prefix)); entered(); }, cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } });
  });
  const pending = observe(createChatCompletion(c, payload, { provider: "deepseek", modelTimeoutMs: 2000, abortSignal: parent.signal }));
  await ready; parent.abort(); const result = await pending;
  assert.equal(result.error?.name, "AbortError"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(getEventListeners(captured, "abort").length, 0);
});

test("limit failure cannot authorize handoff, transient repair or text-tool retry", async () => {
  const s = source(); const c = client(s.fetch); let error;
  try { await createChatCompletion(c, payload, { provider: "deepseek", modelTimeoutMs: 5000 }); } catch (e) { error = e; }
  assert.ok(expectedLimit(error)); assert.equal(error.agintiProviderRequest, true);
  assert.equal(isTransientProviderRequestError(error), false);
  assert.equal(shouldRetryWithTextToolProtocol(error), false);
  assert.equal(resolveProviderHandoff(error, { provider: "deepseek", routingMode: "smart" }), null);
  assert.equal(s.record.calls, 1);
});

test("normal SSE remains incremental and is not buffered until completion", { timeout: 5000 }, async () => {
  let finish; const end = new Promise(resolve => finish = resolve);
  const c = client(async () => new Response(new ReadableStream({
    async start(controller) { controller.enqueue(new TextEncoder().encode('data: {"value":"first"}\n\n')); await end; controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } }));
  try {
    const stream = await c.chat.completions.create({ ...payload, stream: true });
    const iterator = stream[Symbol.asyncIterator](); assert.deepEqual((await iterator.next()).value, { value: "first" });
    finish(); assert.equal((await iterator.next()).done, true);
  } finally { finish(); }
});

test("oversized SSE terminates at the same byte budget without a new request", async () => {
  let calls = 0, cancelled = 0, delivered = 0;
  const c = client(async () => {
    calls++;
    return new Response(new ReadableStream({ pull(controller) { const b = new TextEncoder().encode('data: {"value":"' + "x".repeat(64 * 1024) + '"}\n\n'); delivered += b.length; controller.enqueue(b); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
  });
  await assert.rejects(async () => { const stream = await c.chat.completions.create({ ...payload, stream: true }); for await (const _event of stream) { if (delivered > LIMIT * 2) throw new Error("Test safety ceiling: body remained unbounded"); } }, expectedLimit);
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.ok(delivered <= LIMIT + 3 * 64 * 1024);
});

test("incomplete bodies keep explicit core recovery but do not add hidden SDK attempts", async () => {
  let calls = 0, captured;
  const c = client(async (_url, init) => {
    calls++; captured = init.signal;
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error("PRIVATE_PROVIDER_ERROR must not escape")); } }), { headers: { "content-type": "application/json" } });
  });
  let failure;
  try { await createChatCompletion(c, payload, { provider: "deepseek", modelTimeoutMs: 1000 }); } catch (error) { failure = error; }
  assert.equal(failure.status, 502); assert.equal(failure.code, "MODEL_RESPONSE_INCOMPLETE");
  assert.equal(isTransientProviderRequestError(failure), true); assert.equal(failure.message.includes("PRIVATE_PROVIDER_ERROR"), false);
  assert.equal(calls, 1); assert.equal(getEventListeners(captured, "abort").length, 0);
});

test("small retryable error retains SDK policy and exact succeeding response", async () => {
  let calls = 0;
  const c = client(async () => ++calls === 1
    ? new Response('{"error":{"message":"Temporarily unavailable"}}', { status: 503, headers: { "content-type": "application/json", "retry-after-ms": "0" } })
    : new Response(JSON.stringify(complete), { headers: { "content-type": "application/json" } }));
  assert.deepEqual(await c.chat.completions.create(payload), complete); assert.equal(calls, 2);
});

test("bodyless 204 and explicit empty 200 preserve SDK semantics", async () => {
  assert.equal(await client(async () => new Response(null, { status: 204 })).chat.completions.create(payload), null);
  assert.equal(await client(async () => new Response(null, { headers: { "content-type": "application/json", "content-length": "0" } })).chat.completions.create(payload), undefined);
});

test("ordinary raw response clones retain complete bytes and original metadata", async () => {
  const c = client(async () => {
    const response = new Response(JSON.stringify(complete), { headers: { "content-type": "application/json", "x-request-id": "clone-fixture" } });
    Object.defineProperty(response, "url", { value: "https://model.fixture.invalid/v1/chat/completions" });
    return response;
  });
  const response = await c.chat.completions.create(payload).asResponse(); const copy = response.clone();
  assert.equal(copy.url, response.url); assert.equal(copy.type, response.type); assert.equal(copy.redirected, response.redirected);
  assert.deepEqual(await copy.json(), complete); assert.deepEqual(await response.json(), complete);
});

test("SSE early consumer exit cancels work and cleans the signal listener", { timeout: 5000 }, async () => {
  let captured, cancelled = 0;
  const c = client(async (_url, init) => { captured = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"value":"one"}\n\n')); }, cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const stream = await c.chat.completions.create({ ...payload, stream: true });
  for await (const event of stream) { assert.deepEqual(event, { value: "one" }); break; }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(getEventListeners(captured, "abort").length, 0);
});

test("a late transport response after cancellation is discarded and its body cancelled", { timeout: 5000 }, async () => {
  let release, entered, captured, cancelled = 0;
  const gate = new Promise(resolve => entered = resolve); const waiting = new Promise(resolve => release = resolve);
  const c = client(async (_url, init) => { captured = init.signal; entered(); return waiting; });
  const parent = new AbortController();
  const pending = observe(createChatCompletion(c, payload, { provider: "deepseek", modelTimeoutMs: 2000, abortSignal: parent.signal }));
  await gate; parent.abort(); assert.equal((await pending).error.name, "AbortError");
  release(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(getEventListeners(captured, "abort").length, 0);
});

test("deadline covers a stalled retryable error body without spending another request", { timeout: 5000 }, async () => {
  let calls = 0, cancelled = 0;
  const c = client(async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); }, cancel() { cancelled++; } }),
    { status: 503, headers: { "content-type": "application/json", "x-should-retry": "true", "retry-after-ms": "0" } }); });
  await assert.rejects(createChatCompletion(c, payload, { provider: "deepseek", modelTimeoutMs: 50 }), { name: "ModelTimeoutError" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test("cancellation rejection is sunk and never leaks callback diagnostics", async () => {
  const unhandled = []; const onUnhandled = error => unhandled.push(error); process.on("unhandledRejection", onUnhandled);
  try {
    let calls = 0;
    const c = client(async () => { calls++; return new Response(new ReadableStream({ cancel() { throw new Error("PRIVATE_PROVIDER_ERROR"); } }),
      { headers: { "content-type": "application/json", "content-length": String(LIMIT + 1) } }); });
    await assert.rejects(c.chat.completions.create(payload), expectedLimit);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", onUnhandled); }
});

test("invalid byte chunks reject before invoking a Proxy trap or an SDK retry", async () => {
  let traps = 0, calls = 0;
  const chunk = new Proxy(new Uint8Array(1), { get() { traps++; throw new Error("Trap must not execute"); } });
  const c = client(async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); } }), { headers: { "content-type": "application/json" } }); });
  await assert.rejects(c.chat.completions.create(payload), error => error.code === "MODEL_RESPONSE_INVALID" && error.status === 422);
  assert.equal(calls, 1); assert.equal(traps, 0);
});

test("real unknown-length HTTP closes before an unbounded response finishes", { timeout: 5000 }, async t => {
  let closed, sent = 0, calls = 0;
  const close = new Promise(resolve => closed = resolve);
  const baseURL = await server(t, (req, res) => {
    calls++; req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.write(prefix);
    res.on("close", closed); const chunk = Buffer.alloc(64 * 1024, "x");
    const send = () => {
      if (res.destroyed) return;
      if (sent >= 64 * MiB) { res.end(suffix); return; }
      sent += chunk.length; if (res.write(chunk)) setImmediate(send); else res.once("drain", send);
    }; send();
  });
  await assert.rejects(createModelHttpClient({ apiKey: "synthetic-response-key", baseURL }).chat.completions.create(payload), expectedLimit);
  await close; assert.equal(calls, 1); assert.ok(sent < 64 * MiB);
});

test("raw SSE cancellation with no reason permanently closes admission", async () => {
  let captured, cancelled = 0;
  const c = client(async (_url, init) => { captured = init.signal; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } }); });
  const response = await c.chat.completions.create({ ...payload, stream: true }).asResponse();
  await response.body.cancel(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(getEventListeners(captured, "abort").length, 0);
  assert.equal((await response.body.getReader().read()).done, true);
});

test("byte chunks cannot override counting or copying with typed-array properties", async () => {
  let traps = 0;
  const chunk = new TextEncoder().encode(JSON.stringify(complete));
  for (const key of ["byteLength", "constructor", Symbol.iterator]) Object.defineProperty(chunk, key, { get() { traps++; throw new Error("No chunk hook may execute"); } });
  const c = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close(); } }), { headers: { "content-type": "application/json" } }));
  assert.deepEqual(await c.chat.completions.create(payload), complete); assert.equal(traps, 0);
});
