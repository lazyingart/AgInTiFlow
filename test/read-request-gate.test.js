import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";
import http from "node:http";
import { createReadRequestGate } from "@lazyingart/agintiflow/read-request-gate";

const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock(t) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  return async ms => { now += ms; t.mock.timers.tick(ms); await turn(); };
}

test("read gate bounds concurrency, FIFO and spacing through the entire callback", async t => {
  const advance = clock(t), body = deferred(), calls = [];
  const gate = createReadRequestGate({ minIntervalMs: 1100 });
  const first = gate.run(async () => { calls.push("first"); await body.promise; return 1; });
  const second = gate.run(async () => { calls.push("second"); return 2; });
  const third = gate.run(async () => { calls.push("third"); return 3; });
  await advance(5000); assert.deepEqual(calls, ["first"], "headers alone cannot free a live callback");
  body.resolve(); assert.equal(await first, 1); await turn();
  await advance(1099); assert.deepEqual(calls, ["first"]);
  await advance(1); assert.equal(await second, 2);
  await advance(1100); assert.equal(await third, 3);
  assert.deepEqual(calls, ["first", "second", "third"]);
  await gate.close();
});

test("queued cancellation removes work and listeners, without a fresh admission deadline", async t => {
  const advance = clock(t), work = deferred(), first = new AbortController(), queued = new AbortController();
  const gate = createReadRequestGate(); let calls = 0;
  const active = gate.run(async () => { calls++; await work.promise; }, { signal: first.signal });
  const waiting = gate.run(async () => { calls++; }, { signal: queued.signal });
  const rejected = assert.rejects(waiting, { code: "CANCELLED" });
  queued.abort(); await rejected;
  assert.equal(getEventListeners(queued.signal, "abort").length, 0);
  work.resolve(); await active; await advance(10000); assert.equal(calls, 1);
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  await gate.close();
});

test("cancelled live callbacks retain the slot; late rejection is sunk and close waits", async t => {
  const advance = clock(t), work = deferred(), abort = new AbortController(), gate = createReadRequestGate();
  const errors = [], listener = error => errors.push(error);
  process.on("unhandledRejection", listener); t.after(() => process.off("unhandledRejection", listener));
  let calls = 0, closed = false;
  const first = gate.run(async () => { calls++; return work.promise; }, { signal: abort.signal });
  const expected = assert.rejects(first, { code: "CANCELLED" });
  await turn(); abort.abort(); await expected;
  const queued = gate.run(async () => { calls++; }); queued.catch(() => {});
  await advance(20000); assert.equal(calls, 1);
  const close = gate.close().then(() => { closed = true; });
  await assert.rejects(queued, { code: "READ_REQUEST_CLOSED" }); await turn(); assert.equal(closed, false);
  work.reject(new Error("private transport error")); await close;
  await new Promise(setImmediate); assert.deepEqual(errors, []);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  await assert.rejects(gate.run(async () => {}), { code: "READ_REQUEST_CLOSED" });
});

test("bounded queue, close and deferred cooldown do not leave an idle timer", async t => {
  const advance = clock(t), work = deferred(), gate = createReadRequestGate({ minIntervalMs: 10, maxPending: 1 });
  const first = gate.run(async ({ defer }) => { defer(5000); await work.promise; });
  const second = gate.run(async () => "second"); second.catch(() => {});
  await assert.rejects(gate.run(async () => {}), { code: "READ_REQUEST_BUSY" });
  work.resolve(); await first; await advance(4999);
  let closed = false; const closing = gate.close(); assert.equal(closing, gate.close());
  await closing; closed = true; assert.ok(closed);
  await assert.rejects(second, { code: "READ_REQUEST_CLOSED" });
  await advance(100000); // A stale wake must not invoke a callback after close.
});

test("gate options and callbacks reject ambiguous/hostile contracts without traps", async () => {
  let traps = 0;
  for (const options of [
    { minIntervalMs: undefined }, { minIntervalMs: null }, { minIntervalMs: 0 }, { minIntervalMs: 60001 }, { maxPending: 65 },
    { minIntervalMs: "1" }, { extra: true }, { get minIntervalMs() { traps++; } },
    new Proxy({}, { get() { traps++; }, ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; } }),
    Object.create({ maxPending: 1 }), Object.defineProperty({}, "maxPending", { value: 1 }), { [Symbol()]: true },
  ]) assert.throws(() => createReadRequestGate(options), { code: "INVALID_GATE" });
  const gate = createReadRequestGate();
  assert.throws(() => gate.run(new Proxy(() => {}, { get() { traps++; } })), { code: "INVALID_GATE" });
  assert.throws(() => gate.run(async () => {}, { signal: new Proxy({}, { get() { traps++; } }) }), { code: "INVALID_GATE" });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(gate.run(async () => { traps++; }, { signal: pre.signal }), { code: "CANCELLED" });
  assert.equal(traps, 0); await gate.close();
});

const source = { message: { items: [{ title: ["Synthetic public evidence"], DOI: "10.0000/fixture", URL: "https://doi.org/10.0000/fixture", type: "journal-article", published: { "date-parts": [[2025]] } }] } };
let instance = 0;
const searchInstance = async () => (await import(`../src/web-search.js?pacing=${++instance}`)).searchWeb;

test("built-in Crossref callers share body-aware pacing and preserve publication kind", async t => {
  const advance = clock(t), search = await searchInstance(), entered = deferred(), body = deferred(), times = [];
  let outstanding = 0, maximum = 0;
  const config = { webSearchFetchImpl: async (_, options) => {
    times.push(performance.now()); maximum = Math.max(maximum, ++outstanding);
    assert.equal(options.redirect, "error");
    if (times.length === 1) return new Response(new ReadableStream({ async pull(controller) {
      entered.resolve(); await body.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(source))); controller.close(); outstanding--;
    } }), { headers: { "x-rate-limit-limit": "1", "x-rate-limit-interval": "1s", "x-concurrency-limit": "1" } });
    outstanding--;
    return Response.json(source, { headers: { "x-rate-limit-limit": "1", "x-rate-limit-interval": "1s", "x-concurrency-limit": "1" } });
  } };
  const first = search({ query: "evidence continuity", provider: "crossref" }, config); await entered.promise;
  const second = search({ query: "source verification", provider: "crossref" }, config);
  await turn(); assert.equal(times.length, 1);
  body.resolve(); assert.equal((await first).ok, true); await turn();
  await advance(1099); assert.equal(times.length, 1);
  await advance(1); const result = await second;
  assert.equal(result.ok, true); assert.equal(maximum, 1);
  assert.equal(result.results[0].sourceType, "journal-article");
  assert.ok(times[1] - times[0] >= 1100);
});

test("source cooldown survives a failed read; unrelated providers remain responsive", async t => {
  const advance = clock(t), search = await searchInstance(), times = [];
  const config = { webSearchFetchImpl: async (url) => {
    if (url.includes("bing.com")) return new Response('<rss><channel><item><title>Public source</title><link>https://example.org/source</link></item></channel></rss>');
    times.push(performance.now());
    return times.length === 1 ? new Response("private upstream body", { status: 429, headers: { "Retry-After": "3" } }) : Response.json(source);
  } };
  const failed = await search({ query: "evidence continuity", provider: "crossref" }, config);
  assert.equal(failed.ok, false); assert.match(failed.error, /429/); assert.doesNotMatch(JSON.stringify(failed), /private upstream body/);
  const waiting = search({ query: "source verification", provider: "crossref" }, config);
  assert.equal((await search({ query: "independent source", provider: "bing" }, config)).ok, true);
  await advance(2999); assert.equal(times.length, 1);
  await advance(1); assert.equal((await waiting).ok, true); assert.equal(times.length, 2);
});

test("a cancelled queued source never fetches; malformed retry metadata closes its lane", async t => {
  const advance = clock(t), search = await searchInstance(); let calls = 0;
  const config = { webSearchFetchImpl: async () => { calls++; return Response.json(source); } };
  assert.equal((await search({ query: "public source one", provider: "crossref" }, config)).ok, true);
  const abort = new AbortController();
  const queued = search({ query: "public source two", provider: "crossref" }, { ...config, abortSignal: abort.signal });
  abort.abort(); assert.equal((await queued).ok, false); await advance(5000); assert.equal(calls, 1);
  const bad = await search({ query: "public source three", provider: "crossref" }, { webSearchFetchImpl: async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "1".repeat(20) } }); } });
  assert.equal(bad.ok, false); assert.match(bad.error, /retry timing/);
  assert.equal((await search({ query: "public source four", provider: "crossref" }, config)).ok, false);
  assert.equal(calls, 2);
});

test("native deadlines expire in the queue without dispatch or leaking abort listeners", { timeout: 5000 }, async () => {
  const gate = createReadRequestGate(), work = deferred(), entered = deferred(); let calls = 0;
  const active = gate.run(async () => { calls++; entered.resolve(); await work.promise; }); await entered.promise;
  const signal = AbortSignal.timeout(20);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(gate.run(async () => { calls++; }, { signal }), { code: "CANCELLED" });
    assert.equal(calls, 1); assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally { clearTimeout(keepAlive); work.resolve(); await active; await gate.close(); }
});

test("server rate intervals and canonical Retry-After dates can only lengthen pacing", async t => {
  const advance = clock(t), search = await searchInstance(), times = [];
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1));
  const config = { webSearchFetchImpl: async () => {
    times.push(performance.now());
    if (times.length === 1) return Response.json(source, { headers: { "x-rate-limit-limit": "1", "x-rate-limit-interval": "3s" } });
    if (times.length === 2) return new Response("", { status: 503, headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:05 GMT" } });
    return Response.json(source, { headers: { "x-rate-limit-limit": "100", "x-rate-limit-interval": "1s" } });
  } };
  assert.equal((await search({ query: "public source one", provider: "crossref" }, config)).ok, true);
  const second = search({ query: "public source two", provider: "crossref" }, config);
  await advance(2999); assert.equal(times.length, 1); await advance(1); assert.equal((await second).ok, false);
  const third = search({ query: "public source three", provider: "crossref" }, config);
  await advance(4999); assert.equal(times.length, 2); await advance(1); assert.equal((await third).ok, true);
  const fourth = search({ query: "public source four", provider: "crossref" }, config);
  await advance(1099); assert.equal(times.length, 3); await advance(1); assert.equal((await fourth).ok, true);
});

const suppress = control => {
  const listener = event => event.stopImmediatePropagation();
  control.signal.addEventListener("abort", listener);
  return () => control.signal.removeEventListener("abort", listener);
};

test("suppressed queued cancellation frees capacity without dispatching the cancelled read", async t => {
  const advance = clock(t), work = deferred(), control = new AbortController(), remove = suppress(control);
  const gate = createReadRequestGate({ minIntervalMs: 1, maxPending: 1 });
  const active = gate.run(() => work.promise); let cancelledCalls = 0, outcome;
  const waiting = gate.run(() => { cancelledCalls++; }, { signal: control.signal });
  waiting.then(value => { outcome = { value }; }, error => { outcome = { code: error.code }; });
  let next;
  try {
    await turn(); control.abort(); await turn();
    assert.deepEqual(outcome, { code: "CANCELLED" });
    assert.equal(getEventListeners(control.signal, "abort").length, 1, "the caller listener stays caller-owned");
    next = gate.run(() => "next"); next.catch(() => {});
    await advance(5000); assert.equal(cancelledCalls, 0, "live old work keeps the physical slot");
    work.resolve("first"); await active; await advance(1); assert.equal(await next, "next");
  } finally { work.resolve(); await gate.close(); await Promise.allSettled([active, waiting, ...(next ? [next] : [])]); remove(); }
});

for (const rejection of [false, true]) {
  test(`suppressed active cancellation rejects promptly while late ${rejection ? "error" : "data"} remains charged`, async t => {
    const advance = clock(t), work = deferred(), control = new AbortController(), remove = suppress(control);
    const gate = createReadRequestGate({ minIntervalMs: 1 }); let outcome, calls = 0, closed = false;
    const unhandled = [], receive = error => unhandled.push(error); process.on("unhandledRejection", receive);
    const active = gate.run(() => { calls++; return work.promise; }, { signal: control.signal });
    active.then(value => { outcome = { value }; }, error => { outcome = { code: error.code }; });
    let queued, close;
    try {
      await turn(); control.abort(); await turn(); assert.deepEqual(outcome, { code: "CANCELLED" });
      queued = gate.run(() => { calls++; }); queued.catch(() => {});
      await advance(5000); assert.equal(calls, 1);
      close = gate.close().then(() => { closed = true; }); await turn(); assert.equal(closed, false);
      await assert.rejects(queued, { code: "READ_REQUEST_CLOSED" });
      if (rejection) work.reject(Error("private late source detail")); else work.resolve("late source data");
      await close; await new Promise(setImmediate); assert.deepEqual(unhandled, []);
      assert.deepEqual(outcome, { code: "CANCELLED" }); assert.equal(getEventListeners(control.signal, "abort").length, 1);
    } finally { work.resolve(); await gate.close(); await Promise.allSettled([active, ...(queued ? [queued] : [])]); remove(); process.off("unhandledRejection", receive); }
  });
}

test("an earlier listener cannot turn an actual native queued deadline into an indefinite wait", { timeout: 5000 }, async () => {
  const work = deferred(), expired = deferred(), signal = AbortSignal.timeout(20), gate = createReadRequestGate();
  const listener = event => { event.stopImmediatePropagation(); expired.resolve(); };
  signal.addEventListener("abort", listener); const keepAlive = setTimeout(() => {}, 1000);
  const active = gate.run(() => work.promise); let outcome, calls = 0;
  const waiting = gate.run(() => { calls++; }, { signal });
  waiting.then(value => { outcome = { value }; }, error => { outcome = { code: error.code }; });
  try { await expired.promise; await turn(); assert.equal(signal.aborted, true); assert.deepEqual(outcome, { code: "CANCELLED" }); assert.equal(calls, 0); }
  finally { clearTimeout(keepAlive); work.resolve(); await gate.close(); await Promise.allSettled([active, waiting]); signal.removeEventListener("abort", listener); }
});

for (const throws of [false, true]) {
  test(`callback-local cancellation beats its suppressed ${throws ? "exception" : "return value"}`, async () => {
    const control = new AbortController(), remove = suppress(control), gate = createReadRequestGate();
    try {
      await assert.rejects(gate.run(() => {
        control.abort();
        if (throws) throw Error("private callback exception");
        return "late public result";
      }, { signal: control.signal }), error => error.code === "CANCELLED" && !error.message.includes("private callback"));
    } finally { await gate.close(); remove(); }
  });
}

test("cancel during an existing source cooldown rejects now and leaves no stale wake", async t => {
  const advance = clock(t), control = new AbortController(), remove = suppress(control), gate = createReadRequestGate({ minIntervalMs: 1, maxPending: 1 });
  let calls = 0, outcome;
  await gate.run(({ defer }) => { calls++; defer(86400000); });
  const waiting = gate.run(() => { calls++; }, { signal: control.signal });
  waiting.then(value => { outcome = { value }; }, error => { outcome = { code: error.code }; });
  try { control.abort(); await turn(); assert.deepEqual(outcome, { code: "CANCELLED" }); await advance(86400001); assert.equal(calls, 1); }
  finally { await gate.close(); await Promise.allSettled([waiting]); remove(); }
});

test("real HTTP source work can drain after cancellation without delivering late source data", { timeout: 5000 }, async () => {
  const entered = deferred(), control = new AbortController(), remove = suppress(control), gate = createReadRequestGate({ minIntervalMs: 1 });
  let response, outcome, closed = false;
  const server = http.createServer((_req, res) => { response = res; entered.resolve(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // Deliberately non-cooperative trusted read: do not claim a socket stopped
  // merely because its public caller cancelled. No model/credentials/network
  // outside this exact owned loopback peer are involved.
  const active = gate.run(async () => (await fetch(`http://127.0.0.1:${server.address().port}/source`)).json(), { signal: control.signal });
  active.then(value => { outcome = { value }; }, error => { outcome = { code: error.code }; });
  let close;
  try {
    await entered.promise; control.abort(); await turn(); assert.deepEqual(outcome, { code: "CANCELLED" });
    close = gate.close().then(() => { closed = true; }); await turn(); assert.equal(closed, false);
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"status":"ready"}');
    await close; assert.equal(closed, true); assert.deepEqual(outcome, { code: "CANCELLED" });
  } finally {
    if (response && !response.writableEnded) response.end('{"status":"ready"}');
    await gate.close(); await Promise.allSettled([active]); remove(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test("built-in Crossref native parent composition already preserves suppressed parent cancellation", async t => {
  const advance = clock(t), search = await searchInstance(), control = new AbortController(), remove = suppress(control); let calls = 0;
  const config = { webSearchFetchImpl: async () => { calls++; return Response.json(source); } };
  try {
    assert.equal((await search({ query: "public evidence first", provider: "crossref" }, config)).ok, true);
    const queued = search({ query: "public evidence next", provider: "crossref" }, { ...config, abortSignal: control.signal });
    control.abort(); const result = await queued; assert.equal(result.ok, false); assert.match(result.error, /CANCELLED/);
    await advance(5000); assert.equal(calls, 1);
  } finally { remove(); }
});
