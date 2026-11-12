import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { checkServerIdentity, rootCertificates } from "node:tls";
import { getEventListeners } from "node:events";
import { mock, test } from "node:test";

// Only the native HTTPS boundary is adapted to an owned HTTP peer. There is no
// production endpoint/test callback option. These are actual Node body/socket/
// close events, not proof of public TLS, real auth, model access or admission.
let fixture;
class FixtureAgent extends http.Agent {
  constructor(options) {
    assert.equal(options.keepAlive, false); assert.equal(options.maxCachedSessions, 0);
    assert.deepEqual({ ...options.proxyEnv }, {});
    if (fixture?.throwAgent) throw Error("Synthetic private agent failure");
    super(options); fixture?.agents.push(this);
  }
}
mock.module("node:https", { namedExports: { ...https, Agent: FixtureAgent,
  request(options, callback) {
    assert.ok(fixture, "No live network is authorized");
    assert.equal(options.protocol, "https:"); assert.equal(options.hostname, "api.openai.com");
    assert.equal(options.port, 443); assert.equal(options.path, "/v1/responses"); assert.equal(options.method, "POST");
    assert.equal(options.servername, "api.openai.com"); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, checkServerIdentity); assert.deepEqual(options.ca, rootCertificates);
    assert.equal(Object.isFrozen(options.ca), true); assert.equal(options.minVersion, "TLSv1.2");
    assert.equal(options.maxHeaderSize, 16 * 1024); assert.equal(options.insecureHTTPParser, false);
    assert.equal(options.headers.connection, "close"); assert.equal(options.headers["accept-encoding"], "identity");
    assert.equal(options.headers.accept, "text/event-stream");
    assert.ok(fixture.tokens.includes(options.headers.authorization));
    fixture.constructions++;
    if (fixture.throwBefore) throw Error("Synthetic private constructor failure");
    const owned = fixture;
    const req = http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port: fixture.port }, response => {
      callback(response); owned.onResponseReceived?.();
    });
    const emit = req.emit;
    const destroy = req.destroy;
    owned.requestObjects.push(req); owned.destroyCounts.set(req, 0);
    req.destroy = function (...args) { owned.destroyCounts.set(req, owned.destroyCounts.get(req) + 1); return Reflect.apply(destroy, this, args); };
    req.emit = function (name, ...args) {
      if (name === "close" && (typeof owned.holdClose === "function" ? owned.holdClose(req) : owned.holdClose)) {
        owned.heldCloses.push(() => Reflect.apply(emit, this, [name, ...args])); owned.closeHeld?.(); return true;
      }
      return Reflect.apply(emit, this, [name, ...args]);
    };
    fixture.constructed?.(req); return req;
  },
} });

const { createRestrictedResponsesClient } = await import("../src/restricted-responses-client.js");
const { createRestrictedApplicationRunner } = await import("../src/restricted-application.js");
const defaults = () => ({ accessToken: "synthetic-responses-access-token", principalId: "opaque_principal_001",
  model: "host-selected-model", reasoningEffort: "low", expiresAt: new Date(Date.now() + 3600_000).toISOString(), timeoutMs: 500 });
const schema = { type: "object", properties: { answer: { type: "string", maxLength: 100 } }, required: ["answer"], additionalProperties: false };
const input = { input: [{ type: "text", text: "just summarize this short note, no tools please" }] };
const raw = () => ({ schemaVersion: "aginti-restricted-application-v1", messages: [
  { role: "system", content: "Return JSON from supplied text. No tools or changes." }, { role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [], outputSchema: schema, maxOutputTokens: 256 });
const runner = client => createRestrictedApplicationRunner({ provider: client.provider, instructions: "Return one short JSON proposal. No tools.",
  outputSchema: schema, tools: [], limits: { timeoutMs: 1500, maxSteps: 1, maxConcurrency: 2, maxOutputTokens: 256 } });
const category = expected => error => error.code === "PROVIDER_FAILED" && error.providerFailure?.category === expected && !Object.hasOwn(error, "cause");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("test gate timeout")), 5000); promise.finally(() => clearTimeout(timer)).catch(() => {}); })]);

function events(body, value = { answer: "observed note only" }, suffix = "one") {
  const text = JSON.stringify(value), part = { type: "output_text", text, annotations: [] };
  const item = { id: "msg_fixture_" + suffix, type: "message", status: "completed", role: "assistant", content: [part], phase: "final_answer" };
  const response = { id: "resp_fixture_" + suffix, object: "response", model: body.model, created_at: 1000, status: "in_progress",
    error: null, incomplete_details: null, store: false, tool_choice: "none", tools: [], output: [], reasoning: body.reasoning, text: body.text };
  const scope = { item_id: item.id, output_index: 0, content_index: 0 };
  return [{ type: "response.created", response }, { type: "response.in_progress", response: { ...response } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...scope, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...scope, delta: text }, { type: "response.output_text.done", ...scope, text },
    { type: "response.content_part.done", ...scope, part }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", completed_at: 1001, output: [item] } }]
    .map((event, sequence_number) => ({ ...event, sequence_number }));
}
const stream = list => Buffer.from(list.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
function success(res, body, value, suffix) { res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" }); res.end(stream(events(body, value, suffix))); }

async function setup(t, handler, extra = {}) {
  assert.equal(fixture, undefined);
  const state = { constructions: 0, agents: [], clients: [], heldCloses: [], requests: [], requestObjects: [], destroyCounts: new Map(),
    tokens: ["Bearer synthetic-responses-access-token"], ...extra };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.requests.push({ body, authorization: req.headers.authorization }); await handler(req, res, body, state);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port; fixture = state;
  const client = createRestrictedResponsesClient({ ...defaults(), ...extra.client }); state.clients.push(client);
  t.after(async () => {
    state.holdClose = false; for (const release of state.heldCloses.splice(0)) release();
    for (const item of state.clients) {
      try { await item.close(); } catch (error) { if (!state.expectedCloseFailure) throw error; assert.ok(category("unavailable")(error)); }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture = undefined;
  });
  return { state, client, server };
}

test("one fixed stateless request yields a schema-checked AgInTi proposal after all closes", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body));
  const answer = await runner(f.client).run(input);
  assert.equal(answer.proposal.answer, "observed note only"); assert.deepEqual({ ...answer.usage }, { steps: 1, toolCalls: 0 });
  assert.equal(f.state.constructions, 1); assert.equal(f.state.requests.length, 1);
  const body = f.state.requests[0].body;
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.stream, true); assert.equal(body.store, false);
  assert.equal(body.model, "host-selected-model"); assert.equal(body.reasoning.effort, "low");
  for (const name of ["max_output_tokens", "previous_response_id", "user", "principalId", "metadata", "accessToken", "temperature"]) assert.equal(Object.hasOwn(body, name), false);
  assert.equal(JSON.stringify(body).includes(defaults().accessToken), false);
  assert.deepEqual(Object.keys(f.client).sort(), ["close", "provider"]); assert.equal(Object.isFrozen(f.client.provider), true);
  const closing = f.client.close(); assert.equal(f.client.close(), closing); await closing;
  assert.equal(f.state.agents.every(agent => Object.keys(agent.sockets).length === 0 && Object.keys(agent.freeSockets).length === 0), true);
  await assert.rejects(runner(f.client).run(input), category("unavailable")); assert.equal(f.state.constructions, 1);
});

for (const [status, expected] of [[302, "protocol"], [400, "protocol"], [401, "authentication"], [402, "quota"], [403, "permission"],
  [422, "protocol"], [429, "rate_limit"], [499, "protocol"], [500, "unavailable"], [503, "unavailable"], [504, "timeout"], [505, "protocol"]]) {
  test(`HTTP ${status} returns ${expected} with no redirect/retry/body leak`, { timeout: 6000 }, async t => {
    const f = await setup(t, (_req, res) => { res.writeHead(status, { "content-type": "application/json", "retry-after": "2", location: "https://untrusted.invalid" }); res.end('{"detail":"private diagnostic"}'); });
    await assert.rejects(runner(f.client).run(input), error => category(expected)(error) &&
      error.providerFailure.retryAfterMs === (["rate_limit", "unavailable"].includes(expected) ? 2000 : null) && !JSON.stringify(error).includes("private"));
    assert.equal(f.state.constructions, 1); assert.equal(f.state.requests.length, 1);
  });
}

test("HTTP 429 exact quota code differs from prose and retains no inferred reset time", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
    res.end('{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"private usage diagnostic"}}'); });
  await assert.rejects(runner(f.client).run(input), error => category("quota")(error) && error.providerFailure.retryAfterMs === null && !JSON.stringify(error).includes("subscription"));
  assert.equal(f.state.constructions, 1);
});

test("a malformed HTTP quota error cannot issue trusted quota metadata", { timeout: 6000 }, async t => {
  let index = 0;
  const errors = [
    { code: "insufficient_quota" }, { code: "insufficient_quota", message: false },
    { code: "insufficient_quota", message: "private", param: {} },
    { code: "insufficient_quota", message: "private", type: false },
    { code: "insufficient_quota", message: "private", extra: true },
  ];
  const f = await setup(t, (_req, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: errors[index++] })); });
  for (const _error of errors) await assert.rejects(f.client.provider.complete(raw()), category("protocol"));
  assert.equal(f.state.constructions, errors.length);
});

test("late native usage failure discards deltas and preserves safe quota metadata", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => {
    const list = events(body).slice(0, 5), failed = events(body).at(-1);
    failed.type = "response.failed"; failed.sequence_number = list.length; failed.response.status = "failed";
    failed.response.error = { code: "subscription_sharing_usage_limit_exceeded", message: defaults().accessToken };
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(stream([...list, failed]));
  });
  await assert.rejects(runner(f.client).run(input), error => category("quota")(error) && !JSON.stringify(error).includes(defaults().accessToken));
  assert.equal(f.state.requests.length, 1);
});

test("a completed event without HTTP EOF grants no success", { timeout: 6000 }, async t => {
  const entered = deferred();
  const f = await setup(t, (_req, res, body) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(stream(events(body))); entered.resolve(); });
  const running = runner(f.client).run(input); const rejection = assert.rejects(running, category("timeout"));
  await bounded(entered.promise); await rejection; assert.equal(f.state.constructions, 1);
});

for (const [name, modify] of [["missing terminal", list => list.slice(0, -1)], ["after-terminal error", list => [...list, { type: "error", sequence_number: list.length, message: "private" }]],
  ["foreign response", list => { list.at(-1).response.id = "resp_foreign"; return list; }],
  ["bad JSON", () => [{ type: "unexpected", sequence_number: 0 }]]]) {
  test(`native transport rejects ${name} without partial success or retry`, { timeout: 6000 }, async t => {
    const f = await setup(t, (_req, res, body) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(stream(modify(events(body)))); });
    await assert.rejects(runner(f.client).run(input), category("protocol")); assert.equal(f.state.constructions, 1);
  });
}

test("partial network disconnect remains ambiguous failure, not a retry", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(stream(events(body).slice(0, 5))); res.socket.destroy(); });
  await assert.rejects(runner(f.client).run(input), category("unavailable")); assert.equal(f.state.constructions, 1);
});

for (const [name, header] of [["wrong content type", { "content-type": "application/json" }], ["compression", { "content-encoding": "gzip" }],
  ["excess declared length", { "content-length": String(1024 * 1024 + 1) }], ["oversized header", { "x-padding": "x".repeat(17000) }]]) {
  test(`native header boundary refuses ${name}`, { timeout: 6000 }, async t => {
    const f = await setup(t, (_req, res, body) => { res.writeHead(200, { "content-type": "text/event-stream", ...header }); res.end(stream(events(body))); });
    await assert.rejects(runner(f.client).run(input), category("protocol")); assert.equal(f.state.constructions, 1);
  });
}

test("invalid UTF-8 and multibyte overflow never enter a proposal", { timeout: 6000 }, async t => {
  let round = 0;
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(round++ ? Buffer.from(": " + "中".repeat(400_000)) : Buffer.from([0xff])); });
  for (let i = 0; i < 2; i++) await assert.rejects(runner(f.client).run(input), category("protocol"));
  assert.equal(f.state.constructions, 2);
});

test("known credential bytes are rejected in request and reflected final output", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body, { answer: defaults().accessToken }));
  await assert.rejects(runner(f.client).run({ input: [{ type: "text", text: defaults().accessToken }] }));
  assert.equal(f.state.constructions, 0);
  await assert.rejects(runner(f.client).run(input), error => category("protocol")(error) && !JSON.stringify(error).includes(defaults().accessToken));
  assert.equal(f.state.constructions, 1);
});

test("literal numeric credential reflection is refused before dispatch or final proposal", { timeout: 6000 }, async t => {
  const token = "1234567890123456", value = Number(token);
  const f = await setup(t, (_req, res, body) => success(res, body, { proposal: value }), {
    tokens: [`Bearer ${token}`], client: { accessToken: token },
  });
  const request = raw(); request.outputSchema = { type: "integer" };
  await assert.rejects(f.client.provider.complete(request), error => category("protocol")(error) && !JSON.stringify(error).includes(token));
  assert.equal(f.state.constructions, 1);
  request.outputSchema = { type: "integer", enum: [value] };
  assert.throws(() => f.client.provider.complete(request), { code: "SENSITIVE_DATA" });
  assert.equal(f.state.constructions, 1);
});

test("quiet native response cancels even when an earlier abort listener stops propagation", { timeout: 6000 }, async t => {
  const received = deferred(), controller = new AbortController(), blocker = event => event.stopImmediatePropagation();
  controller.signal.addEventListener("abort", blocker);
  t.after(() => controller.signal.removeEventListener("abort", blocker));
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); },
    { onResponseReceived: received.resolve });
  const running = f.client.provider.complete(raw(), { signal: controller.signal });
  const rejected = assert.rejects(running, { code: "CANCELLED" });
  await bounded(received.promise); controller.abort(); await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  assert.equal(f.state.constructions, 1);
});

test("pre-abort and malformed request/scope options perform zero network work", { timeout: 6000 }, async t => {
  const f = await setup(t, () => assert.fail("No request permitted")); const controller = new AbortController(); controller.abort();
  await assert.rejects(runner(f.client).run(input, { signal: controller.signal }), { code: "CANCELLED" });
  for (const extra of [{ model: "other-model" }, { principalId: "opaque_principal_002" }, { accessToken: "other-secret-value" }]) await assert.rejects(runner(f.client).run({ ...input, ...extra }));
  assert.throws(() => f.client.provider.complete(raw(), { principalId: "opaque_principal_002" }));
  assert.equal(f.state.constructions, 0);
});

test("cancellation closes exact transport and removes listeners without unhandled rejection", { timeout: 6000 }, async t => {
  const entered = deferred(), controller = new AbortController(), unhandled = [];
  const capture = error => unhandled.push(error); process.on("unhandledRejection", capture); t.after(() => process.removeListener("unhandledRejection", capture));
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); entered.resolve(); });
  const running = runner(f.client).run(input, { signal: controller.signal }); const rejection = assert.rejects(running, { code: "CANCELLED" });
  await bounded(entered.promise); controller.abort(); await rejection; await f.client.close(); await new Promise(setImmediate);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.deepEqual(unhandled, []); assert.equal(f.state.constructions, 1);
});

test("a long in-budget request occupies its exact concurrency slot", { timeout: 6000 }, async t => {
  const entered = deferred(); let release;
  const f = await setup(t, (_req, res, body) => { if (!release) { release = () => success(res, body); entered.resolve(); } else success(res, body); }, { client: { maxConcurrency: 1 } });
  const pending = runner(f.client).run(input); await bounded(entered.promise);
  await assert.rejects(runner(f.client).run(input), category("unavailable")); assert.equal(f.state.constructions, 1);
  release(); assert.equal((await pending).status, "completed"); assert.equal((await runner(f.client).run(input)).status, "completed");
});

test("close/abort during native construction prevents body dispatch", { timeout: 6000 }, async t => {
  let closing;
  const f = await setup(t, () => assert.fail("Body must not dispatch"));
  f.state.constructed = () => { closing = f.client.close(); };
  await assert.rejects(runner(f.client).run(input), category("unavailable")); await closing;
  assert.equal(f.state.requests.length, 0); assert.equal(f.state.constructions, 1);
});

test("constructor failure leaves no reservation or automatic retry", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body), { throwBefore: true });
  await assert.rejects(runner(f.client).run(input), category("unavailable"));
  f.state.throwBefore = false; assert.equal((await runner(f.client).run(input)).status, "completed");
  assert.equal(f.state.constructions, 2); assert.equal(f.state.requests.length, 1);
});

test("delayed close keeps capacity charged; later actual retirement drains shutdown", { timeout: 6000 }, async t => {
  const held = deferred(); const f = await setup(t, (_req, res, body) => success(res, body), { holdClose: true, closeHeld: held.resolve });
  const app = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Return JSON.", tools: [], outputSchema: schema,
    limits: { timeoutMs: 50, maxSteps: 1, maxConcurrency: 1 } });
  const running = app.run(input); const rejection = assert.rejects(running, { code: "TIMEOUT" }); await bounded(held.promise); await rejection;
  await assert.rejects(app.run(input), { code: "BUSY" });
  let done = false; const closing = f.client.close(); closing.then(() => { done = true; }); await new Promise(setImmediate); assert.equal(done, false);
  f.state.holdClose = false; for (const release of f.state.heldCloses.splice(0)) release();
  await closing; assert.equal(done, true); assert.equal(f.state.constructions, 1);
});

test("unproven close fails within grace and permanently poisons reuse", { timeout: 9000 }, async t => {
  const held = deferred(); const f = await setup(t, (_req, res, body) => success(res, body), { holdClose: true, closeHeld: held.resolve, expectedCloseFailure: true });
  const pending = runner(f.client).run(input); pending.catch(() => {}); await bounded(held.promise);
  const closing = f.client.close(); await assert.rejects(closing, category("unavailable")); assert.equal(f.client.close(), closing);
  await assert.rejects(runner(f.client).run(input), category("unavailable")); assert.equal(f.state.constructions, 1);
  await assert.rejects(pending);
  f.state.holdClose = false; for (const release of f.state.heldCloses.splice(0)) release(); await new Promise(setImmediate);
});

test("one unprovable request poisons and synchronously stops every other live request", { timeout: 9000 }, async t => {
  const firstHeld = deferred(), secondEntered = deferred(); let number = 0;
  const f = await setup(t, (_req, res, body) => {
    if (number++ === 0) success(res, body);
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); secondEntered.resolve(); }
  }, { client: { timeoutMs: 10_000, maxConcurrency: 2 }, expectedCloseFailure: true,
    closeHeld: firstHeld.resolve });
  f.state.holdClose = req => req === f.state.requestObjects[0];
  const controller = new AbortController();
  const first = f.client.provider.complete(raw(), { signal: controller.signal }); first.catch(() => {});
  await bounded(firstHeld.promise);
  const second = f.client.provider.complete(raw()); second.catch(() => {}); await bounded(secondEntered.promise);
  assert.equal(f.state.destroyCounts.get(f.state.requestObjects[1]), 0);
  controller.abort(); await assert.rejects(first, category("unavailable"));
  assert.ok(f.state.destroyCounts.get(f.state.requestObjects[1]) > 0, "poison must stop its sibling before publishing unconfirmed cleanup failure");
  await assert.rejects(second, category("unavailable"));
  await assert.rejects(runner(f.client).run(input), category("unavailable")); assert.equal(f.state.constructions, 2);
  f.state.holdClose = false; for (const release of f.state.heldCloses.splice(0)) release(); await new Promise(setImmediate);
});

test("abort during native construction stops before end and releases exact listeners", { timeout: 6000 }, async t => {
  const controller = new AbortController(); const f = await setup(t, () => assert.fail("No request body permitted"));
  f.state.constructed = () => controller.abort();
  await assert.rejects(runner(f.client).run(input, { signal: controller.signal }), { code: "CANCELLED" });
  await f.client.close(); assert.equal(f.state.requests.length, 0); assert.equal(f.state.constructions, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("token expiry bounds active work and prevents a subsequent dispatch", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); },
    { client: { expiresAt: new Date(Date.now() + 400).toISOString(), timeoutMs: 3000 } });
  await assert.rejects(runner(f.client).run(input), category("authentication"));
  const before = f.state.constructions;
  await assert.rejects(runner(f.client).run(input), category("authentication"));
  assert.ok(before <= 1); assert.equal(f.state.constructions, before);
});

test("native duplicate critical headers cannot be hidden by Node normalization", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => {
    res.writeHead(200, ["Content-Type", "text/event-stream", "Content-Type", "text/event-stream"]); res.end(stream(events(body)));
  });
  await assert.rejects(runner(f.client).run(input), category("protocol")); assert.equal(f.state.constructions, 1);
});

test("malformed, ambiguous or oversized quota JSON does not become retryable metadata", { timeout: 6000 }, async t => {
  let round = 0;
  const variants = ['{"error":{"code":"insufficient_quota","code":"rate_limit_exceeded"}}', '{"error":', "中".repeat(6000)];
  const f = await setup(t, (_req, res) => { res.writeHead(429, { "content-type": "application/json" }); res.end(variants[round++]); });
  for (let index = 0; index < variants.length; index++) await assert.rejects(runner(f.client).run(input), category("protocol"));
  assert.equal(f.state.constructions, variants.length);
});

test("constructor snapshots cannot be retargeted by mutating host options", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body));
  const configured = defaults(), other = createRestrictedResponsesClient(configured); f.state.clients.push(other);
  configured.accessToken = "changed-synthetic-credential"; configured.model = "changed-model";
  configured.principalId = "opaque_principal_999"; configured.expiresAt = new Date(0).toISOString();
  assert.equal((await runner(other).run(input)).status, "completed");
  assert.equal(f.state.requests[0].authorization, "Bearer " + defaults().accessToken);
  assert.equal(f.state.requests[0].body.model, "host-selected-model");
});

test("a client accepts no per-call endpoint, model, credential or principal override", { timeout: 6000 }, async t => {
  const f = await setup(t, () => assert.fail("No overridden request permitted"));
  for (const field of ["accessToken", "model", "principalId", "endpoint", "fetch", "expiresAt"]) {
    const value = raw(); value[field] = "override"; assert.throws(() => f.client.provider.complete(value));
  }
  assert.equal(f.state.constructions, 0);
});

test("supported non-object root values cross the native transport unchanged", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body, { proposal: [true, false] }));
  const outputSchema = { type: "array", items: { type: "boolean" }, maxItems: 2 };
  const app = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Return the requested booleans.", tools: [], outputSchema,
    limits: { timeoutMs: 1500, maxSteps: 1 } });
  assert.deepEqual([...(await app.run(input)).proposal], [true, false]); assert.equal(f.state.constructions, 1);
});

test("independent principals keep token/model/history/socket contexts separate", { timeout: 6000 }, async t => {
  const otherToken = "second-synthetic-access-token";
  const f = await setup(t, (req, res, body) => success(res, body, { answer: req.headers.authorization.includes("second") ? "second" : "first" },
    req.headers.authorization.includes("second") ? "second" : "first"), { tokens: ["Bearer synthetic-responses-access-token", "Bearer " + otherToken] });
  const other = createRestrictedResponsesClient({ ...defaults(), accessToken: otherToken, principalId: "opaque_principal_002", model: "second-host-model" });
  f.state.clients.push(other);
  const [a, b] = await Promise.all([runner(f.client).run(input), runner(other).run(input)]);
  assert.equal(a.proposal.answer, "first"); assert.equal(b.proposal.answer, "second");
  assert.equal(f.state.agents.length, 2); assert.deepEqual(f.state.requests.map(row => row.body.model).sort(), ["host-selected-model", "second-host-model"]);
  assert.equal(f.state.requests.some(row => JSON.stringify(row.body).includes("opaque_principal")), false);
});

test("expiry, proxy/accessor/thenable config and unknown selectors reject before connection", { timeout: 6000 }, async t => {
  const f = await setup(t, () => assert.fail("No network permitted")); let hooks = 0;
  const proxy = new Proxy({}, { get() { hooks++; throw Error("private"); }, ownKeys() { hooks++; throw Error("private"); }, getPrototypeOf() { hooks++; throw Error("private"); } });
  const accessor = defaults(); Object.defineProperty(accessor, "accessToken", { get() { hooks++; throw Error("private"); }, enumerable: true });
  for (const options of [proxy, accessor, { ...defaults(), then() { hooks++; } },
    { ...defaults(), fetch() { hooks++; } }, { ...defaults(), endpoint: "https://untrusted.invalid" },
    { ...defaults(), model: proxy }, { ...defaults(), expiresAt: proxy }, { ...defaults(), accessToken: " token-with-whitespace " },
    { ...defaults(), principalId: "opaque_principal_001\n" }]) assert.throws(() => createRestrictedResponsesClient(options));
  assert.throws(() => createRestrictedResponsesClient({ ...defaults(), expiresAt: new Date(Date.now() - 1000).toISOString() }), category("authentication"));
  assert.equal(hooks, 0); assert.equal(f.state.constructions, 0); assert.equal(f.state.agents.length, 1);
});

test("private agent-construction and shutdown errors are never exposed", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res, body) => success(res, body));
  f.state.throwAgent = true;
  assert.throws(() => createRestrictedResponsesClient(defaults()), error => category("unavailable")(error) && !JSON.stringify(error).includes("private"));
  f.state.throwAgent = false;
  assert.equal((await runner(f.client).run(input)).status, "completed");
  const agent = f.state.agents[0], destroy = agent.destroy; f.state.expectedCloseFailure = true;
  agent.destroy = () => { throw Error("private destroy detail"); };
  try {
    const closing = f.client.close(); assert.equal(f.client.close(), closing);
    await assert.rejects(closing, error => category("unavailable")(error) && !JSON.stringify(error).includes("private"));
    await assert.rejects(runner(f.client).run(input), category("unavailable"));
  } finally { agent.destroy = destroy; }
});

test("cancelling one scoped client cannot cancel another principal", { timeout: 6000 }, async t => {
  const aEntered = deferred(), bEntered = deferred(); let releaseB;
  const otherToken = "second-synthetic-access-token";
  const f = await setup(t, (req, res, body) => {
    if (req.headers.authorization.includes("second")) { releaseB = () => success(res, body, { answer: "second remains active" }, "second"); bEntered.resolve(); }
    else { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); aEntered.resolve(); }
  }, { tokens: ["Bearer synthetic-responses-access-token", "Bearer " + otherToken] });
  const other = createRestrictedResponsesClient({ ...defaults(), accessToken: otherToken, principalId: "opaque_principal_002", timeoutMs: 2000 }); f.state.clients.push(other);
  const controller = new AbortController(); const a = runner(f.client).run(input, { signal: controller.signal });
  const rejected = assert.rejects(a, { code: "CANCELLED" }); const b = runner(other).run(input);
  await Promise.all([bounded(aEntered.promise), bounded(bEntered.promise)]); controller.abort(); await rejected;
  await f.client.close(); releaseB(); assert.equal((await b).proposal.answer, "second remains active");
  assert.equal(f.state.constructions, 2);
});

test("body bytes arriving after cancellation never produce a late answer or second request", { timeout: 6000 }, async t => {
  const entered = deferred(); let send;
  const f = await setup(t, (_req, res, body) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    send = () => { if (!res.destroyed) res.end(stream(events(body))); }; entered.resolve();
  });
  const controller = new AbortController(); const pending = runner(f.client).run(input, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "CANCELLED" }); await bounded(entered.promise); controller.abort();
  send(); await rejected; await f.client.close(); assert.equal(f.state.constructions, 1);
});

test("chunked error-body overflow is rejected before EOF rather than waiting for timeout", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.write('{"error":{"message":"' + "x".repeat(10_000)); res.write("中".repeat(3000));
  });
  await assert.rejects(runner(f.client).run(input), category("protocol")); assert.equal(f.state.constructions, 1);
});

test("cumulative SSE byte bound includes comments and is enforced without EOF", { timeout: 6000 }, async t => {
  const f = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < 18; index++) res.write(": " + "x".repeat(60_000) + "\n\n");
  });
  await assert.rejects(runner(f.client).run(input), category("protocol")); assert.equal(f.state.constructions, 1);
});

test("native fragmented multilingual stream preserves complete Unicode and exact proposal", { timeout: 7000 }, async t => {
  const answer = "只根据提供的记录 / 記録だけ / 🙂";
  const f = await setup(t, async (_req, res, body) => {
    const bytes = stream(events(body, { answer }));
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 7) {
      res.write(bytes.subarray(offset, offset + 7)); await new Promise(setImmediate);
    }
    if (!res.destroyed) res.end();
  }, { client: { timeoutMs: 3000 } });
  const app = createRestrictedApplicationRunner({ provider: f.client.provider, instructions: "Return a short proposal.", tools: [], outputSchema: schema,
    limits: { timeoutMs: 5000, maxSteps: 1 } });
  assert.equal((await app.run(input)).proposal.answer, answer); assert.equal(f.state.constructions, 1);
});
