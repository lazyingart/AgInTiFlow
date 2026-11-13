import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mock, test } from "node:test";
import { getEventListeners } from "node:events";

// Only the built-in HTTPS boundary is redirected to a test-owned HTTP peer.
// Production has no endpoint/fetch/test-only constructor option. This exercises
// real request/body/close events but makes no TLS or paid-provider claim.
let activeFixture;
class FixtureAgent extends http.Agent {
  constructor(options) { super(options); activeFixture?.agents.push(this); }
}
mock.module("node:https", { namedExports: { ...https, Agent: FixtureAgent,
  request(options, callback) {
    assert.ok(activeFixture, "No live network is authorized by this test");
    assert.equal(options.protocol, "https:"); assert.equal(options.hostname, "api.deepseek.com");
    assert.equal(options.port, 443); assert.equal(options.path, "/v1/chat/completions");
    assert.equal(options.method, "POST"); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.maxHeaderSize, 16 * 1024); assert.equal(options.insecureHTTPParser, false);
    assert.equal(options.headers.authorization, "Bearer synthetic-deepseek-credential");
    assert.equal(options.headers["accept-encoding"], "identity");
    activeFixture.constructions++;
    if (activeFixture.throwBefore) throw Error("Synthetic pre-dispatch constructor failure");
    const owner = activeFixture;
    const request = http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: activeFixture.port }, response => {
      callback(response); owner.onResponseReceived?.(response);
    });
    if (owner.holdSocketClose) request.once("socket", socket => {
      const emit = socket.emit;
      socket.emit = function (name, ...args) {
        if (name === "close" && owner.holdSocketClose) {
          owner.releaseSocketClose = () => Reflect.apply(emit, this, [name, ...args]); owner.onSocketCloseHeld?.(); return true;
        }
        return Reflect.apply(emit, this, [name, ...args]);
      };
    });
    activeFixture.onConstruct?.(request);
    if (activeFixture.holdClose) {
      const emit = request.emit;
      request.emit = function (name, ...args) {
        if (name === "close" && activeFixture.holdClose) {
          activeFixture.releaseClose = () => Reflect.apply(emit, this, [name, ...args]);
          activeFixture.onCloseHeld?.();
          return true;
        }
        return Reflect.apply(emit, this, [name, ...args]);
      };
    }
    return request;
  },
} });
const { createRestrictedDeepSeekClient } = await import("../src/restricted-deepseek-client.js");
const { createRestrictedApplicationRunner, createRestrictedProviderFailure } = await import("../src/restricted-application.js");
const { createDeepSeekHttpTransport } = await import("../src/restricted-deepseek-http.js");
const defaults = { apiKey: "synthetic-deepseek-credential", model: "deepseek-flash", userId: "opaque_user_scope_001", timeoutMs: 500, maxConcurrency: 2 };
const schema = { type: "object", properties: { reply: { type: "string", minLength: 1, maxLength: 80 } }, required: ["reply"], additionalProperties: false };
const result = reply => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply }) } }] });
const native = async fixture => {
  const runner = createRestrictedApplicationRunner({ provider: fixture.client.provider, instructions: "Return a short JSON reply from the supplied text. No tools.", outputSchema: schema, tools: [],
    limits: { timeoutMs: 1200, maxSteps: 1, maxCallsPerStep: 1, maxToolCalls: 1, maxConcurrency: 2, maxOutputTokens: 128 } });
  return runner;
};
const input = { input: [{ type: "text", text: "Say hello briefly." }] };
const category = expected => error => error.code === "PROVIDER_FAILED" && error.providerFailure?.category === expected && !Object.hasOwn(error, "cause");

async function setup(t, handler, options = {}) {
  assert.equal(activeFixture, undefined);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); requests.push(body);
    handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  activeFixture = { port: server.address().port, constructions: 0, requests, agents: [], ...options };
  const state = activeFixture;
  const client = createRestrictedDeepSeekClient({ ...defaults, ...options.client });
  t.after(async () => {
    state.holdClose = false; state.releaseClose?.();
    state.holdSocketClose = false; state.releaseSocketClose?.();
    try { await client.close(); } catch (error) { if (!state.expectedCloseFailure) throw error; assert.ok(category("unavailable")(error)); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); activeFixture = undefined;
  });
  return { ...state, state, client, server, requests };
}

test("native HTTP client sends one fixed scoped request and closes its pooled sockets", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("hello"))); });
  const runner = await native(f);
  assert.equal((await runner.run(input)).proposal.reply, "hello");
  assert.equal(f.requests.length, 1); assert.equal(f.state.constructions, 1);
  assert.equal(f.requests[0].model, defaults.model); assert.equal(f.requests[0].user_id, defaults.userId);
  assert.deepEqual(f.requests[0].thinking, { type: "disabled" });
  assert.deepEqual(f.requests[0].response_format, { type: "json_object" });
  assert.equal(f.requests[0].stream, false); assert.equal(f.requests[0].max_tokens, 128); assert.equal(f.requests[0].tools, undefined);
  assert.ok(!JSON.stringify(f.requests[0]).includes(defaults.apiKey));
  assert.deepEqual(Object.keys(f.client).sort(), ["close", "provider"]);
  const closing = f.client.close(); assert.equal(f.client.close(), closing); await closing;
  await assert.rejects(runner.run(input), category("unavailable")); assert.equal(f.requests.length, 1);
});

test("native tool loop uses the same HTTP scope and returns only a schema-checked proposal", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res, body) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body.messages.some(message => message.role === "tool") ? result("current note") : {
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ index: 0, id: "read_1", type: "function", function: { name: "read_note", arguments: "{}" } }] } }],
    }));
  });
  let reads = 0;
  const runner = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Read the host-owned note and return JSON.", outputSchema: schema,
    tools: [{ name: "read_note", description: "Read only this account's note", readOnly: true,
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: schema,
      execute() { reads++; return { reply: "current note" }; } }], limits: { timeoutMs: 1200, maxSteps: 2, maxToolCalls: 1, maxOutputTokens: 128 } });
  const answer = await runner.run(input); assert.equal(answer.proposal.reply, "current note"); assert.equal(reads, 1);
  assert.equal(f.requests.length, 2); assert.ok(f.requests.every(body => body.user_id === defaults.userId));
  assert.equal(f.requests[1].tools.length, 1);
  assert.equal(f.requests[1].tools[0].function.name, "__aginti_return_proposal", "exhausted reads stay withdrawn; only output serialization remains");
  assert.deepEqual(f.requests[1].tool_choice, { type: "function", function: { name: "__aginti_return_proposal" } });
});

for (const [status, expected] of [[302, "protocol"], [400, "protocol"], [401, "authentication"], [402, "quota"], [403, "permission"], [422, "protocol"],
  [429, "rate_limit"], [499, "protocol"], [500, "unavailable"], [503, "unavailable"], [504, "timeout"], [505, "protocol"]]) {
  test(`HTTP ${status} is safely classified without retry or redirect`, { timeout: 5000 }, async t => {
    const f = await setup(t, (_req, res) => { res.writeHead(status, { "content-type": "application/json", location: "https://outside.invalid/", "retry-after": "2" }); res.end('private response must not escape'); });
    const runner = await native(f);
    await assert.rejects(runner.run(input), error => category(expected)(error) && !JSON.stringify(error).includes("private") &&
      error.providerFailure.retryAfterMs === ([429, 500, 503].includes(status) ? 2000 : null));
    assert.equal(f.state.constructions, 1); assert.equal(f.requests.length, 1);
  });
}

for (const [name, body] of [["duplicate outer choice keys", '{"choices":[],"choices":'+JSON.stringify(result("bad").choices)+'}'],
  ["invalid UTF8", Buffer.from([0x7b, 0xc3, 0x28, 0x7d])], ["truncated JSON", '{"choices":'],
  ["byte overflow", Buffer.alloc(256 * 1024 + 1, 0x20)]]) {
  test(`${name} returns no proposal`, { timeout: 5000 }, async t => {
    const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
  });
}

test("opaque scope, credential, exact options and zero-trap validation precede HTTP", () => {
  const bad = [null, { ...defaults, apiKey: " leading-space-credential" }, { ...defaults, apiKey: "credential-with-space " },
    { ...defaults, apiKey: "short" }, { ...defaults, userId: "raw@email.invalid" }, { ...defaults, model: "ambient-model" },
    { ...defaults, timeoutMs: null }, { ...defaults, maxConcurrency: null }, { ...defaults, baseURL: "https://outside.invalid" },
    Object.defineProperty({ ...defaults }, "model", { get() { throw Error("must not call getter"); } }),
    Object.defineProperty({ ...defaults }, "hidden", { value: true }), { ...defaults, [Symbol("extra")]: true }];
  let traps = 0;
  bad.push(new Proxy({}, { get() { traps++; throw Error("trap"); }, getPrototypeOf() { traps++; throw Error("trap"); }, ownKeys() { traps++; throw Error("trap"); } }));
  for (const value of bad) assert.throws(() => createRestrictedDeepSeekClient(value));
  assert.equal(traps, 0); assert.equal(activeFixture, undefined);
});

test("cancellation closes the request and leaves no partial proposal", { timeout: 5000 }, async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("\n"); entered(); });
  const runner = await native(f), controller = new AbortController();
  const running = runner.run(input, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(running, { code: "CANCELLED" }); await f.client.close(); assert.equal(f.requests.length, 1);
});

test("a whole response timeout is classified, has zero retry and drains before close", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("\n"); }, { client: { timeoutMs: 100 } });
  await assert.rejects((await native(f)).run(input), category("timeout"));
  assert.equal(f.requests.length, 1); await f.client.close();
});

test("mutable construction input cannot swap model, key or user scope", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("scoped"))); });
  const options = { ...defaults }; const client = createRestrictedDeepSeekClient(options); t.after(() => client.close());
  Object.assign(options, { apiKey: "changed-credential-value", userId: "another_user_scope_002", model: "deepseek-v4-pro" });
  const runner = await native({ client }); assert.equal((await runner.run(input)).proposal.reply, "scoped");
  assert.equal(f.requests[0].user_id, defaults.userId); assert.equal(f.requests[0].model, defaults.model);
});

test("capacity cannot be bypassed by another runner sharing the same client", { timeout: 5000 }, async t => {
  let release, entered;
  const first = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, (_req, res) => {
    const finish = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("done"))); };
    if (!release) { release = finish; entered(); } else finish();
  }, { client: { maxConcurrency: 1 } });
  const runner = await native(f), another = await native(f); const pending = runner.run(input);
  await first; await assert.rejects(another.run(input), category("unavailable"));
  assert.equal(f.state.constructions, 1); release(); assert.equal((await pending).proposal.reply, "done");
  assert.equal((await another.run(input)).proposal.reply, "done"); assert.equal(f.requests.length, 2);
});

test("delayed native close retains the timed-out slot and makes shutdown wait", { timeout: 5000 }, async t => {
  let held;
  const captured = new Promise(resolve => { held = resolve; });
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("late"))); },
    { holdClose: true, onCloseHeld: held, client: { maxConcurrency: 1 } });
  const runner = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Return JSON.", outputSchema: schema, tools: [], limits: { timeoutMs: 50, maxSteps: 1, maxConcurrency: 1 } });
  const pending = runner.run(input); const rejection = assert.rejects(pending, { code: "TIMEOUT" });
  await captured; await rejection; await assert.rejects(runner.run(input), { code: "BUSY" });
  const closing = f.client.close(); let done = false; closing.then(() => { done = true; });
  await new Promise(setImmediate); assert.equal(done, false); assert.equal(f.requests.length, 1);
  f.state.holdClose = false; f.state.releaseClose(); await closing;
  assert.equal(done, true); assert.equal(f.state.constructions, 1);
});

test("close during request construction prevents body dispatch and cleans both promises", { timeout: 5000 }, async t => {
  let closing;
  const f = await setup(t, () => assert.fail("No body dispatch permitted"));
  f.state.onConstruct = () => { closing = f.client.close(); };
  await assert.rejects((await native(f)).run(input), category("unavailable"));
  await closing; assert.equal(f.requests.length, 0); assert.equal(f.state.constructions, 1);
});

test("constructor failure leaves no reservation or implicit retry", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("new request"))); }, { throwBefore: true });
  const runner = await native(f); await assert.rejects(runner.run(input), category("unavailable"));
  assert.equal(f.requests.length, 0); assert.equal(f.state.constructions, 1);
  f.state.throwBefore = false; assert.equal((await runner.run(input)).proposal.reply, "new request");
  assert.equal(f.state.constructions, 2); assert.equal(f.requests.length, 1);
});

test("pre-aborted calls perform zero HTTP work", { timeout: 5000 }, async t => {
  const f = await setup(t, () => assert.fail("No network permitted")); const controller = new AbortController(); controller.abort();
  await assert.rejects((await native(f)).run(input, { signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(f.state.constructions, 0); assert.equal(f.requests.length, 0);
});

test("known literal credentials never enter body input or public output", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result(defaults.apiKey))); });
  const runner = await native(f);
  await assert.rejects(runner.run({ input: [{ type: "text", text: defaults.apiKey }] }), error => error.code === "PROVIDER_FAILED" && !JSON.stringify(error).includes(defaults.apiKey));
  assert.equal(f.state.constructions, 0);
  await assert.rejects(runner.run(input), error => category("protocol")(error) && !JSON.stringify(error).includes(defaults.apiKey));
  assert.equal(f.requests.length, 1);
});

for (const type of ["text/event-stream", "text/html"]) test(`unsupported ${type} is refused`, { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": type }); res.end(JSON.stringify(result("not accepted"))); });
  await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
});

test("chunked multibyte overflow counts bytes rather than string length", { timeout: 5000 }, async t => {
  const value = JSON.stringify(result("猫".repeat(90000))); assert.ok(value.length < 256 * 1024 && Buffer.byteLength(value) > 256 * 1024);
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write(value.slice(0, 100)); res.end(value.slice(100)); });
  await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
});

test("complete native HTTP still refuses a truncated model turn", { timeout: 5000 }, async t => {
  const body = result("partial"); body.choices[0].finish_reason = "length";
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  await assert.rejects((await native(f)).run(input), { code: "PROVIDER_FAILED" }); assert.equal(f.requests.length, 1);
});

test("nonstreaming keep-alive whitespace does not grant extra time or discard final JSON", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("\n\n "); res.end(JSON.stringify(result("complete"))); });
  assert.equal((await (await native(f)).run(input)).proposal.reply, "complete"); assert.equal(f.requests.length, 1);
});

test("closed requests remove abort listeners and have no unhandled internal rejection", { timeout: 5000 }, async t => {
  const unhandled = []; const receive = reason => unhandled.push(reason); process.on("unhandledRejection", receive);
  t.after(() => process.removeListener("unhandledRejection", receive));
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("done"))); });
  let transportSignal;
  const runner = createRestrictedApplicationRunner({ provider: { supportsImages: false, complete(request, options) {
    transportSignal = options.signal; return f.client.provider.complete(request, options);
  } }, instructions: "Return JSON.", outputSchema: schema, tools: [] });
  const parent = new AbortController(); assert.equal((await runner.run(input, { signal: parent.signal })).proposal.reply, "done");
  assert.equal(getEventListeners(parent.signal, "abort").length, 0); assert.equal(getEventListeners(transportSignal, "abort").length, 0);
  await f.client.close(); await new Promise(setImmediate); assert.deepEqual(unhandled, []);
});

test("independent opaque principals and explicitly selected Pro remain separate", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result(body.user_id === defaults.userId ? "first" : "second"))); });
  const other = createRestrictedDeepSeekClient({ ...defaults, model: "deepseek-v4-pro", userId: "opaque_user_scope_002" }); t.after(() => other.close());
  const a = await native(f), b = await native({ client: other });
  const [first, second] = await Promise.all([a.run(input), b.run(input)]);
  assert.equal(first.proposal.reply, "first"); assert.equal(second.proposal.reply, "second");
  assert.deepEqual(f.requests.map(body => [body.user_id, body.model]).sort(), [[defaults.userId, "deepseek-flash"], ["opaque_user_scope_002", "deepseek-v4-pro"]]);
  assert.equal(f.requests.length, 2);
});

test("native HTTP client remains text-only and rejects images before dispatch", { timeout: 5000 }, async t => {
  const f = await setup(t, () => assert.fail("Images must not be dispatched"));
  await assert.rejects((await native(f)).run({ input: [{ type: "image", mediaType: "image/png", data: "unsupported" }] }), { code: "VISION_UNAVAILABLE" });
  assert.equal(f.state.constructions, 0); assert.equal(f.requests.length, 0);
});

test("request callers cannot override provider or opaque user scope", { timeout: 5000 }, async t => {
  const f = await setup(t, () => assert.fail("No untrusted scope selector may dispatch")); const runner = await native(f);
  for (const extra of [{ model: "deepseek-v4-pro" }, { userId: "other_user_scope_002" }, { apiKey: "other-credential-value" }]) {
    await assert.rejects(runner.run({ ...input, ...extra }));
  }
  assert.equal(f.state.constructions, 0);
});

test("a disconnected partial body is ambiguous failure, never a partial proposal or retry", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"choices":'); res.socket.destroy(); });
  await assert.rejects((await native(f)).run(input), category("unavailable"));
  assert.equal(f.requests.length, 1); assert.equal(f.state.constructions, 1);
});

test("unsolicited compression is refused rather than decoded outside the byte policy", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(JSON.stringify(result("not decoded"))); });
  await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
});

test("shutdown failure remains cached, bounded and permanently closed", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("done"))); });
  assert.equal((await (await native(f)).run(input)).proposal.reply, "done");
  const agent = f.state.agents[0], original = agent.destroy; f.state.expectedCloseFailure = true;
  agent.destroy = () => { throw Error("Synthetic confidential destructor diagnostic"); };
  try {
    const closing = f.client.close(); assert.equal(f.client.close(), closing);
    await assert.rejects(closing, error => category("unavailable")(error) && !JSON.stringify(error).includes("confidential"));
    await assert.rejects(f.client.close(), category("unavailable"));
    await assert.rejects((await native(f)).run(input), category("unavailable"));
    assert.equal(f.requests.length, 1);
  } finally { agent.destroy = original; }
});

test("the pinned native parser refuses oversized response headers", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-padding": "x".repeat(17000) });
    res.end(JSON.stringify(result("never accepted")));
  });
  await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
});

test("an earlier signal listener cannot suppress actual HTTP cancellation", { timeout: 5000 }, async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); }, { onResponseReceived: entered });
  const controller = new AbortController(), blocker = event => event.stopImmediatePropagation();
  controller.signal.addEventListener("abort", blocker);
  t.after(() => controller.signal.removeEventListener("abort", blocker));
  const pending = f.client.provider.complete({ schemaVersion: "aginti-restricted-application-v1", tools: [], outputSchema: schema,
    maxOutputTokens: 128, messages: [{ role: "system", content: "Return JSON from supplied data." },
      { role: "user", content: [{ type: "text", text: "read the authorized note" }] }] }, { signal: controller.signal });
  const rejection = assert.rejects(pending, { code: "CANCELLED" });
  await ready; controller.abort(); await rejection; await f.client.close();
  assert.equal(f.state.constructions, 1); assert.equal(f.requests.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1, "only the caller-owned blocker remains");
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const observedWithin = async (promise, ms) => {
  let timer;
  try { return await Promise.race([promise.then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ stillPending: true }), ms); })]); }
  finally { clearTimeout(timer); }
};
const rawRequest = () => ({ schemaVersion: "aginti-restricted-application-v1", tools: [], outputSchema: schema,
  maxOutputTokens: 128, messages: [{ role: "system", content: "Return supplied status JSON." },
    { role: "user", content: [{ type: "text", text: "just check this status, no changes please" }] }] });

for (const boundary of ["request", "socket"]) test(`unconfirmed ${boundary} close fails boundedly and remains cached closed`, { timeout: 8000 }, async t => {
  const held = deferred();
  const options = boundary === "request" ? { holdClose: true, onCloseHeld: held.resolve } : { holdSocketClose: true, onSocketCloseHeld: held.resolve };
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("observed"))); }, options);
  f.state.expectedCloseFailure = true;
  const pending = f.client.provider.complete(rawRequest(), {}); pending.catch(() => {});
  if (boundary === "request") await held.promise; else await pending;
  const closing = f.client.close(); assert.equal(f.client.close(), closing);
  try {
    const outcome = await observedWithin(closing, 3500);
    assert.ok(outcome.error && category("unavailable")(outcome.error), "unconfirmed retirement cannot hang or claim cleanup success");
    if (boundary === "socket") await held.promise;
    await assert.rejects(f.client.close(), category("unavailable"));
    await assert.rejects((await native(f)).run(input), category("unavailable"));
    assert.equal(f.state.constructions, 1);
  } finally {
    f.state.holdClose = false; f.state.releaseClose?.();
    f.state.holdSocketClose = false; f.state.releaseSocketClose?.();
    await pending.catch(() => {}); await closing.catch(() => {});
  }
  await assert.rejects(f.client.close(), category("unavailable"), "late physical retirement cannot rewrite a cached failed close");
});

test("an unconfirmed request after its deadline poisons admission without releasing physical work", { timeout: 8000 }, async t => {
  const held = deferred(), unhandled = [], receive = error => unhandled.push(error);
  process.on("unhandledRejection", receive); t.after(() => process.removeListener("unhandledRejection", receive));
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result("late"))); },
    { holdClose: true, onCloseHeld: held.resolve, client: { timeoutMs: 100, maxConcurrency: 1 } });
  f.state.expectedCloseFailure = true;
  const pending = f.client.provider.complete(rawRequest(), {}); pending.catch(() => {}); await held.promise;
  try {
    const outcome = await observedWithin(pending, 3500);
    assert.ok(outcome.error && category("unavailable")(outcome.error), "deadline plus uncertain retirement needs a bounded safe failure");
    await assert.rejects((await native(f)).run(input), category("unavailable"));
    assert.equal(f.state.constructions, 1);
    // Physical completion remains distinct from the already-settled public
    // failure. This also catches a drain loop spinning on resolved promises.
    const closing = f.client.close(); closing.catch(() => {});
    await new Promise(setImmediate);
    f.state.holdClose = false; f.state.releaseClose();
    await assert.rejects(closing, category("unavailable")); await new Promise(setImmediate);
    await assert.rejects((await native(f)).run(input), category("unavailable")); assert.deepEqual(unhandled, []);
  } finally { f.state.holdClose = false; f.state.releaseClose?.(); await pending.catch(() => {}); }
});

test("confirmed cancellation within the grace preserves its error and permits a fresh request", { timeout: 5000 }, async t => {
  const received = deferred(), held = deferred(), controller = new AbortController(); let count = 0;
  const f = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (++count === 1) res.flushHeaders(); else res.end(JSON.stringify(result("fresh")));
  }, { onResponseReceived: received.resolve, holdClose: true, onCloseHeld: held.resolve });
  const pending = f.client.provider.complete(rawRequest(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await received.promise; controller.abort(); await held.promise;
  f.state.holdClose = false; f.state.releaseClose(); await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal((await (await native(f)).run(input)).proposal.reply, "fresh");
  assert.equal(f.state.constructions, 2);
});

// Use real wire headers: Node intentionally discards some duplicate field
// values in response.headers, so validating only that object loses evidence.
const ambiguousHeaders = [
  ["identical content types", 200, ["Content-Type", "application/json", "Content-Type", "application/json"]],
  ["conflicting content types", 200, ["Content-Type", "application/json", "Content-Type", "text/plain"]],
  ["mixed-case content types", 200, ["Content-Type", "application/json", "cOnTeNt-TyPe", "text/event-stream"]],
  ["unsupported first content type", 200, ["Content-Type", "text/plain", "Content-Type", "application/json"]],
  ["rate-limit retry hints", 429, ["Content-Type", "application/json", "Retry-After", "2", "rEtRy-AfTeR", "86400"]],
  ["unavailable retry hints", 503, ["Content-Type", "application/json", "Retry-After", "2", "Retry-After", "0"]],
  ["identical content encodings", 200, ["Content-Type", "application/json", "Content-Encoding", "identity", "Content-Encoding", "identity"]],
  ["identical content lengths", 200, ["Content-Type", "application/json", "Content-Length", "0", "Content-Length", "0"]],
];
for (const [label, status, headers] of ambiguousHeaders) {
  test(`duplicate ${label} fail before proposal or retry metadata`, { timeout: 5000 }, async t => {
    const f = await setup(t, (_req, res) => { res.writeHead(status, headers); res.end(JSON.stringify(result("must not escape"))); });
    await assert.rejects((await native(f)).run(input), error => category("protocol")(error) && error.providerFailure.retryAfterMs === null);
    assert.equal(f.state.constructions, 1); assert.equal(f.requests.length, 1);
  });
}

for (const coding of ["gzip, chunked", "custom, chunked"]) {
  test(`unsupported transfer coding ${coding} cannot bypass the JSON profile`, { timeout: 5000 }, async t => {
    const f = await setup(t, (_req, res) => {
      res.writeHead(200, ["Content-Type", "application/json", "Transfer-Encoding", coding]);
      res.end(JSON.stringify(result("must not escape")));
    });
    await assert.rejects((await native(f)).run(input), category("protocol")); assert.equal(f.requests.length, 1);
  });
}

for (const count of [128, 129]) {
  test(`${count} native response header fields respect the exact bounded profile`, { timeout: 5000 }, async t => {
    let observed;
    const f = await setup(t, (_req, res) => {
      const body = JSON.stringify(result("bounded"));
      const headers = ["Content-Type", "application/json", "Content-Length", String(Buffer.byteLength(body)), "Connection", "close"];
      for (let n = 3; n < count; n++) headers.push(`x-fixture-${n}`, "1");
      res.sendDate = false; res.writeHead(200, headers); res.end(body);
    }, { onResponseReceived: response => { observed = response.rawHeaders.length / 2; } });
    if (count === 128) assert.equal((await (await native(f)).run(input)).proposal.reply, "bounded");
    else await assert.rejects((await native(f)).run(input), category("protocol"));
    assert.equal(observed, count); assert.equal(f.requests.length, 1);
  });
}

test("unrelated repeated response headers do not become a false protocol failure", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req, res) => {
    res.writeHead(200, ["Content-Type", "application/json", "Set-Cookie", "fixture_a=1", "Set-Cookie", "fixture_b=2", "x-trace", "one", "x-trace", "two"]);
    res.end(JSON.stringify(result("normal")));
  });
  assert.equal((await (await native(f)).run(input)).proposal.reply, "normal"); assert.equal(f.requests.length, 1);
});

for (const ambiguous of [false, true]) {
  test(`${ambiguous ? "ambiguous" : "normal"} HTTP metadata gates the actual declared read loop`, { timeout: 5000 }, async t => {
    let reads = 0;
    const record = Object.freeze({ reply: "ready" });
    const f = await setup(t, (_req, res, body) => {
      res.writeHead(200, ambiguous ? ["Content-Type", "application/json", "Content-Type", "text/plain"] : ["Content-Type", "application/json"]);
      res.end(JSON.stringify(body.messages.some(m => m.role === "tool") ? result("ready") : {
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [{ index: 0, id: "read_current", type: "function", function: { name: "read_note", arguments: "{}" } }] } }],
      }));
    });
    const runner = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Read the current host note; return its status without changing it.", outputSchema: schema,
      tools: [{ name: "read_note", description: "Read this account's current note", readOnly: true,
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: schema,
        execute() { reads++; return record; } }], limits: { timeoutMs: 1200, maxSteps: 2, maxToolCalls: 1, maxOutputTokens: 128 } });
    const task = { input: [{ type: "text", text: "check my note pls, just tell me current status. don't change anything" }] };
    if (ambiguous) await assert.rejects(runner.run(task), category("protocol"));
    else assert.equal((await runner.run(task)).proposal.reply, "ready");
    assert.equal(reads, ambiguous ? 0 : 1); assert.equal(f.requests.length, ambiguous ? 1 : 2);
    assert.deepEqual(record, { reply: "ready" });
  });
}

const finalOutputName = "__aginti_return_proposal";
function finalOutputBody() {
  return { model: defaults.model, messages: [{role:"system",content:"Return JSON only."}, {role:"tool",tool_call_id:"read_1",content:'{"reply":"current note"}'}],
    tools: [{type:"function",function:{name:finalOutputName,description:"Encode a final proposal; no host action.",parameters:schema}}],
    tool_choice:{type:"function",function:{name:finalOutputName}}, response_format:{type:"json_object"},thinking:{type:"disabled"},max_tokens:128,stream:false,temperature:0 };
}
test("closed native read loop uses one private output encoding and no extra host action", { timeout: 5000 }, async t => {
  const f = await setup(t, (_req,res,body) => {
    res.writeHead(200,{"content-type":"application/json"});
    const closed=body.messages.some(m=>m.role==="tool");
    if(closed){assert.equal(body.tools.length,1);assert.equal(body.tools[0].function.name,finalOutputName);assert.deepEqual(body.tool_choice,{type:"function",function:{name:finalOutputName}});}
    res.end(JSON.stringify({choices:[{index:0,finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:closed?"final_1":"read_1",type:"function",function:{name:closed?finalOutputName:"read_note",arguments:closed?'{"reply":"current note"}':'{}'}}]}}]}));
  });
  let reads=0;const runner=createRestrictedApplicationRunner({provider:f.client.provider,instructions:"Read the account note and propose only.",tools:[{name:"read_note",description:"Read only.",readOnly:true,inputSchema:{type:"object",properties:{},required:[],additionalProperties:false},outputSchema:schema,execute(){reads++;return{reply:"current note"};}}],outputSchema:schema,limits:{maxSteps:2,maxToolCalls:1,maxOutputTokens:128,timeoutMs:1200}});
  const r=await runner.run(input);assert.equal(r.proposal.reply,"current note");assert.deepEqual({...r.usage},{steps:2,toolCalls:1});assert.equal(reads,1);assert.equal(f.requests.length,2);assert.equal(f.requests[1].user_id,defaults.userId);assert.equal(f.requests[1].max_tokens,128);
});
const invalidOutputChoices = [
 ["auto", b=>{b.tool_choice="auto";}],
 ["other-name", b=>{b.tool_choice.function.name="read_note";}],
 ["choice-extra", b=>{b.tool_choice.network=true;}],
 ["function-extra", b=>{b.tool_choice.function.cwd="/private";}],
 ["missing-tools", b=>{delete b.tools;}],
 ["missing-choice", b=>{delete b.tool_choice;}],
 ["extra-tool", b=>{b.tools.push({type:"function",function:{name:"read_note",description:"read",parameters:schema}});}],
 ["name-mismatch", b=>{b.tools[0].function.name="read_note";}],
 ["empty-tool-history", b=>{b.messages=[{role:"user",content:"just answer"}];}],
 ["extra-native-tool-key", b=>{b.tools[0].network=true;}],
 ["extra-parameter-key", b=>{b.tools[0].function.path="/private";}],
 ["nonobject-parameters", b=>{b.tools[0].function.parameters={type:"string",maxLength:20};}],
];
for(const [name,mutate]of invalidOutputChoices)test(`native HTTP rejects invalid output choice ${name} before construction`,{timeout:5000},async t=>{
 const f=await setup(t,()=>assert.fail("Invalid output routing must not reach a peer"));
 const transport=createDeepSeekHttpTransport(defaults,createRestrictedProviderFailure);
 try{const body=finalOutputBody();mutate(body);assert.throws(()=>transport.complete(body),e=>["INVALID_CONTRACT","INVALID_DATA"].includes(e.code));assert.equal(f.state.constructions,0);assert.equal(f.requests.length,0);}finally{await transport.close();}
});
