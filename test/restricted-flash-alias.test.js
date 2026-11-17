import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mock, test } from "node:test";

let fixture, constructions = 0;
mock.module("node:https", { namedExports: { ...https, request(options, callback) {
  constructions++;
  assert.ok(fixture, "No external network is authorized");
  assert.equal(options.protocol, "https:");
  assert.equal(options.hostname, "api.deepseek.com");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/v1/chat/completions");
  assert.equal(options.method, "POST");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.authorization, "Bearer synthetic-flash-alias-key");
  return http.request({ ...options, agent: false, protocol: "http:", hostname: "127.0.0.1", port: fixture.port }, callback);
} } });

const { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider, createRestrictedProviderFailure } = await import("../src/restricted-application.js");
const { createRestrictedDeepSeekClient } = await import("../src/restricted-deepseek-client.js");
const { createDeepSeekHttpTransport } = await import("../src/restricted-deepseek-http.js");
const alias = "deepseek-v4-flash";
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 120 };
const schema = object({ reply: string });
const input = { input: [{ type: "text", text: "Check the current note and suggest a brief correction. Don't save it." }] };
const envelope = reply => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply }) } }] });
const options = model => ({ apiKey: "synthetic-flash-alias-key", model, userId: "synthetic_user_scope_001", timeoutMs: 1000 });
const app = (provider, tools = []) => createRestrictedApplicationRunner({ provider, tools, instructions: "Use only authorized current notes; return one JSON proposal. The host owns saves.", outputSchema: schema,
  limits: { maxSteps: 2, maxToolCalls: 1, maxCallsPerStep: 1, timeoutMs: 3000, maxOutputTokens: 128 } });

test("explicit legacy Flash literal remains exact in no-tools JSON and host history", async () => {
  let calls = 0;
  const provider = createRestrictedDeepSeekProvider({ model: alias, complete: async body => {
    calls++;
    assert.equal(body.model, alias);
    assert.equal(body.messages[1].content, "Host-authorized earlier note.");
    assert.deepEqual({ ...body.thinking }, { type: "disabled" });
    assert.deepEqual({ ...body.response_format }, { type: "json_object" });
    assert.equal(Object.hasOwn(body, "tools"), false);
    assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
    return envelope("Proposal only; not saved.");
  } });
  const result = await app(provider).run({ ...input, history: [{ role: "assistant", text: "Host-authorized earlier note." }] });
  assert.equal(provider.supportsImages, false);
  assert.equal(result.proposal.reply, "Proposal only; not saved.");
  assert.equal(calls, 1);
});

test("legacy Flash literal uses the existing native read loop and exact local schema", async () => {
  let calls = 0, reads = 0;
  const provider = createRestrictedDeepSeekProvider({ model: alias, complete: async body => {
    assert.equal(body.model, alias); calls++;
    if (calls === 1) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "note_read_1", type: "function", function: { name: "note_read", arguments: '{"id":"current"}' } }] } }] };
    assert.equal(body.messages.at(-1).tool_call_id, "note_read_1");
    assert.equal(body.messages.at(-1).content, '{"text":"The observed value is 17."}');
    return envelope("Observed 17; no save requested.");
  } });
  const runner = app(provider, [{ name: "note_read", description: "Read one host-scoped current note.", readOnly: true,
    inputSchema: object({ id: string }), outputSchema: object({ text: string }), execute: async ({ id }) => {
      assert.equal(id, "current"); reads++; return { text: "The observed value is 17." };
    } }]);
  assert.equal((await runner.run(input)).proposal.reply, "Observed 17; no save requested.");
  assert.equal(calls, 2); assert.equal(reads, 1);
});

for (const model of ["deepseek-flash", alias, "deepseek-v4-pro"]) {
  test(`fixed HTTPS client forwards ${model} unchanged, without fallback`, { timeout: 6000 }, async t => {
    const bodies = [];
    const server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(envelope("Bounded proposal.")));
    });
    const clients = [];
    t.after(async () => {
      try { for (const client of clients) await client.close(); }
      finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); fixture = undefined;
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    fixture = { port: server.address().port };
    const before = constructions, client = createRestrictedDeepSeekClient(options(model)); clients.push(client);
    assert.equal(constructions, before, "construction cannot dispatch");
    assert.equal((await app(client.provider).run(input)).proposal.reply, "Bounded proposal.");
    assert.equal(bodies.length, 1); assert.equal(constructions, before + 1);
    assert.equal(bodies[0].model, model); assert.equal(bodies[0].user_id, options(model).userId);
    assert.deepEqual(bodies[0].thinking, { type: "disabled" });
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.equal(Object.hasOwn(bodies[0], "tools"), false);
  });
}

test("lookalikes, coercion and descriptor attacks reject before callback or HTTP", async () => {
  const before = constructions; let hooks = 0;
  const complete = () => { hooks++; assert.fail("No callback authorized"); };
  for (const model of [undefined, null, 0, "", " deepseek-v4-flash", "deepseek-v4-flash ", "deepseek-v4-flash\n", "DEEPSEEK-V4-FLASH", "deepseek-v4-flash-extra", "deepseek-v4-flash-vision-exp", { toString() { hooks++; return alias; } }]) {
    assert.throws(() => createRestrictedDeepSeekProvider({ model, complete }), { code: "INVALID_CONTRACT" });
    assert.throws(() => createRestrictedDeepSeekClient(options(model)), { code: "INVALID_CONTRACT" });
  }
  for (const extra of ["thinking", "reasoning_effort", "baseURL", "fallback", "supportsImages"]) {
    assert.throws(() => createRestrictedDeepSeekProvider({ model: alias, complete, [extra]: "untrusted" }));
    assert.throws(() => createRestrictedDeepSeekClient({ ...options(alias), [extra]: "untrusted" }));
  }
  const proxy = new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; return []; } });
  const accessor = { get model() { hooks++; return alias; }, complete };
  assert.throws(() => createRestrictedDeepSeekProvider(proxy));
  assert.throws(() => createRestrictedDeepSeekClient(proxy));
  assert.throws(() => createRestrictedDeepSeekProvider(accessor));
  assert.equal(constructions, before); assert.equal(hooks, 0);
});

test("legacy Flash transport rejects cross-model body without normalizing or dispatching", async () => {
  let body;
  await app(createRestrictedDeepSeekProvider({ model: alias, complete: async request => { body = request; return envelope("Captured proposal."); } })).run(input);
  const before = constructions, transport = createDeepSeekHttpTransport(options(alias), createRestrictedProviderFailure);
  try {
    for (const model of ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash "]) {
      assert.throws(() => transport.complete({ ...body, model }), { code: "INVALID_CONTRACT" });
    }
    assert.equal(constructions, before);
  } finally { await transport.close(); }
});

test("pre-cancelled legacy Flash request cannot use a callback, tool or fallback", async () => {
  let calls = 0;
  const client = createRestrictedDeepSeekClient(options(alias));
  const provider = createRestrictedDeepSeekProvider({ model: alias, complete() { calls++; assert.fail("Cancelled"); } });
  const controller = new AbortController(); controller.abort(); const before = constructions;
  try {
    for (const p of [provider, client.provider]) await assert.rejects(app(p).run(input, { signal: controller.signal }), { code: "CANCELLED" });
    assert.equal(constructions, before); assert.equal(calls, 0);
  } finally { await client.close(); }
});
