import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipe, streams, base, input, final, call, tool, frame, gate, until, bounded } from "./harness.js";

test("explicit null/array config cannot silently become an omitted fixed profile", () => {
  for (const extra of [{ tools: null }, { limits: null }, { limits: [] }, { provider: { supportsImages: true, complete: async () => final() } }, { limits: { maxConcurrency: 2 } }]) {
    assert.throws(() => pipe.createRestrictedApplicationChannel({ ...base(), emit: () => {}, ...extra }));
  }
});

test("a real deadline cancels the SDK but never frees an unsettled provider or promises a result", async () => {
  const wait = gate(), events = [];let calls = 0;
  const c = pipe.createRestrictedApplicationChannel(base(() => { calls++;return wait.promise; }, { limits: { timeoutMs: 20 }, emit: e => { events.push(e); } }));
  try {
    await c.accept(frame(c, "run", undefined, { request: input }));await until(() => events.some(e => e.code === "TIMEOUT"));
    assert.equal(c.inspect().providerCallbacks, 1);
    await c.accept(frame(c, "run", "request_timeout_02", { request: input }));assert.equal(events.at(-1).code, "BUSY");
    wait.resolve(final());await until(() => c.inspect().providerCallbacks === 0);assert.equal(calls, 1);
    assert.ok(!events.some(e => e.type === "result"));
  } finally { wait.resolve(final());await c.close(); }
});

test("output schema and unavailable tool errors are real SDK failures, never successful transport results", async () => {
  for (const response of [ { type: "final", value: { reply: "looks fine", hidden: true } }, { type: "tool_calls", calls: [{ id: "c1", name: "shell", arguments: {} }] } ]) {
    const events = [], c = pipe.createRestrictedApplicationChannel(base(async () => response, { emit: e => { events.push(e); } }));
    try {
      await c.accept(frame(c, "run", undefined, { request: input }));await until(() => events.some(e => e.type === "error"));
      assert.ok(!events.some(e => ["result", "read"].includes(e.type)));
    } finally { await c.close(); }
  }
});

test("provider-returned Proxy and thenable data reach SDK admission without getters or traps", async () => {
  let traps = 0;
  const thenable = {};Object.defineProperty(thenable, "then", { enumerable: true, get() { traps++;throw Error("must not read"); } });
  for (const raw of [thenable, new Proxy({}, { get() { traps++; }, ownKeys() { traps++; } })]) {
    const events = [], c = pipe.createRestrictedApplicationChannel(base(() => raw, { emit: e => { events.push(e); } }));
    try {
      await c.accept(frame(c, "run", undefined, { request: input }));await until(() => events.some(e => e.type === "error"));
      assert.equal(traps, 0);assert.ok(!events.some(e => e.type === "result"));
    } finally { await c.close(); }
  }
});

test("channel output failure during an active parent read cancels and stays poisoned", async () => {
  const events = [];let rejectNext = false;
  const c = pipe.createRestrictedApplicationChannel(base(async () => call(), { tools: [tool], emit: e => { if (rejectNext) return Promise.reject(new Error("private"));events.push(e); } }));
  try {
    await c.accept(frame(c, "run", undefined, { request: input }));await until(() => events.some(e => e.type === "read"));rejectNext = true;
    await assert.rejects(c.accept({ ...frame(c, "cancel"), scopeId: "account_wrong_0001" }));
    await until(() => c.inspect().activeRuns === 0);assert.equal(c.inspect().pendingReads, 0);assert.equal(c.inspect().poisoned, true);
    await assert.rejects(c.accept(frame(c, "run", "request_after_0002", { request: input })), e => e.code === "CLOSED");
  } finally { await c.close(); }
});

test("request validation failure consumes no provider call and used IDs still cannot resurrect", async () => {
  let calls = 0;const events = [];
  const c = pipe.createRestrictedApplicationChannel(base(async () => { calls++;return final(); }, { emit: e => { events.push(e); } }));
  try {
    await c.accept(frame(c, "run", undefined, { request: { input: [] } }));await until(() => events.some(e => e.type === "error"));
    assert.equal(calls, 0);await c.accept(frame(c, "run", undefined, { request: input }));assert.equal(events.at(-1).code, "REQUEST_ID_REUSED");
  } finally { await c.close(); }
});

test("read replies cannot override schema, tool name or request correlation", async () => {
  const events = [], c = pipe.createRestrictedApplicationChannel(base(async () => call(), { tools: [tool], emit: e => { events.push(e); } }));
  try {
    await c.accept(frame(c, "run", undefined, { request: input }));await until(() => events.some(e => e.type === "read"));const read = events.find(e => e.type === "read");
    await assert.rejects(c.accept(frame(c, "read_result", undefined, { readId: read.readId, value: {}, name: "shell" })));
    assert.equal(c.inspect().pendingReads, 1);
    await c.accept(frame(c, "read_result", undefined, { readId: read.readId, value: { text: "draft", revision: "4" } }));
    await until(() => events.some(e => e.type === "error"));assert.ok(!events.some(e => e.type === "result"));
  } finally { await c.close(); }
});

test("frame byte budget is measured as UTF8, not JS string length", async () => {
  let calls = 0;const c = pipe.createRestrictedApplicationChannel(base(async () => { calls++;return final(); }, { emit: () => {} }));
  try {
    const tooBig = frame(c, "run", undefined, { request: { input: [{ type: "text", text: "中".repeat(90_000) }] } });
    await assert.rejects(c.accept(tooBig), e => e.code === "DATA_LIMIT");assert.equal(calls, 0);assert.equal(c.inspect().seenRequests, 0);
  } finally { await c.close(); }
});

test("ordinary prose, quotes, line breaks and multilingual text survive framing without protocol injection", async () => {
  const text = '中文 日本語 "type":"cancel"\nnot another frame';const events = [];
  const c = pipe.createRestrictedApplicationChannel(base(async request => final(request.messages.at(-1).content[0].text), { emit: e => { events.push(e); } }));
  try {
    await c.accept(frame(c, "run", undefined, { request: { input: [{ type: "text", text }] } }));await until(() => events.some(e => e.type === "result"));
    assert.equal(events.at(-1).result.proposal.reply, text);
  } finally { await c.close(); }
});

test("raw stream proxies and hostile chunks reject without getters, iterator, or Buffer method traps", async () => {
  let traps = 0;const hostile = new Proxy({}, { get() { traps++; }, getPrototypeOf() { traps++; } });
  const goodOutput = new Writable({ write(_c, _e, cb) { cb(); } });
  assert.throws(() => streams.serveRestrictedApplicationPipe({ ...base(), input: hostile, output: goodOutput }));assert.equal(traps, 0);goodOutput.destroy();
  // Supply the hostile chunk directly at the stream boundary. Readable.from
  // itself adopts thenables before yielding, outside this adapter's authority.
  const inputStream = { [Symbol.asyncIterator]() { return { next: async () => ({ value: hostile, done: false }), return: async () => ({ done: true }) }; }, destroy() {} };
  const outputStream = new Writable({ write(_c, _e, cb) { cb(); } });
  const server = streams.serveRestrictedApplicationPipe({ ...base(), input: inputStream, output: outputStream });
  await assert.rejects(bounded(server.done));assert.equal(traps, 0);
});

test("typed array custom methods/iterator are not consulted; shared buffers reject", async () => {
  let traps = 0;
  for (const shared of [false, true]) {
    const raw = shared ? new Uint8Array(new SharedArrayBuffer(3)) : new Uint8Array(Buffer.from("{}\n"));
    Object.defineProperties(raw, { indexOf: { get() { traps++; } }, subarray: { get() { traps++; } }, [Symbol.iterator]: { get() { traps++; } } });
    const inputStream = Readable.from([raw], { objectMode: true }), outputStream = new Writable({ write(_c, _e, cb) { cb(); } });
    const server = streams.serveRestrictedApplicationPipe({ ...base(), input: inputStream, output: outputStream });
    await assert.rejects(bounded(server.done));assert.equal(traps, 0);
  }
});

test("output detach aborts active provider promptly but reports no false remote termination", async () => {
  const wait = gate();let signal;const inputStream = new PassThrough();const events = [];
  const outputStream = new Writable({ write(chunk, _encoding, cb) { events.push(JSON.parse(chunk.toString()));cb(); } });
  const server = streams.serveRestrictedApplicationPipe({ ...base((_r, context) => { signal = context.signal;return wait.promise; }), input: inputStream, output: outputStream, closeGraceMs: 30 });
  await server.ready;const c = { ready: events[0] };
  inputStream.write(JSON.stringify(frame(c, "run", undefined, { request: input })) + "\n");await until(() => !!signal);
  outputStream.destroy();await until(() => signal.aborted);
  await assert.rejects(bounded(server.done));assert.equal(server.inspect().providerCallbacks, 1);
  assert.ok(!events.some(e => ["error", "result"].includes(e.type)));
  wait.reject(new Error("late private error"));await until(() => server.inspect().providerCallbacks === 0);
});

test("pipelined input plus blocked output stays bounded and closes before model dispatch", async () => {
  let ready, writes = 0, calls = 0;
  const inputStream = new PassThrough();
  const outputStream = new Writable({ write(chunk, _encoding, cb) { if (++writes === 1) { ready = JSON.parse(chunk.toString());cb(); } } });
  const server = streams.serveRestrictedApplicationPipe({ ...base(() => { calls++;return final(); }), input: inputStream, output: outputStream });
  await server.ready;
  // Pipeline many same-process frames while accepted is blocked. The consumer
  // never dispatches work before delivery; bounded write timeout closes it.
  const text = Array.from({ length: 100 }, (_, i) => JSON.stringify(frame({ ready }, "run", `request_flood_${String(i).padStart(4, "0")}`, { request: input }))).join("\n") + "\n";
  inputStream.end(text);await assert.rejects(bounded(server.done, 4000));assert.equal(calls, 0);assert.equal(server.inspect().closed, true);
});
