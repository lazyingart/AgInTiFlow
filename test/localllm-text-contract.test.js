import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestrictedApplicationRunner, createRestrictedOpenAIProvider } from "../src/restricted-application.js";
import { canonical, canonicalHash, replySchema, requestPolicy, sha256, strictEntity, timestamp, validateProfile, validateRequest, validateResponse } from "../scripts/fixtures/localllm-text-contract.js";

// Synthetic offline approvals/identities. Never an endpoint grant or a model
// receipt. The SDK really emits the request, but the response below is fabricated
// test data and is labelled as such in the qualification report.
const clone = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => Buffer.from(JSON.stringify(value));
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const startedAt = "2026-11-05T01:00:10Z", arrivedAt = "2026-11-05T01:00:11Z";
const requestId = "061ecac1-1111-4000-8000-000000000001";
const instructions = "Return JSON with one nonempty reply using only the supplied synthetic conversation.";
const inputs = {
  "english-initial": { input: [{ type: "text", text: "Remember the fixture word amber. Reply briefly in JSON." }] },
  "chinese-followup": { input: [{ type: "text", text: "刚才的测试词是什么？用中文简短回复。" }], history: [{ role: "user", text: "测试词是琥珀。" }, { role: "assistant", text: "已记住测试词琥珀。" }] },
};

async function emittedRequest(input = inputs["english-initial"], model = "localllm-fast") {
  let body;
  const provider = createRestrictedOpenAIProvider({ model, supportsImages: false, complete: async (request) => {
    body = request;
    return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"reply":"amber"}' } }] };
  } });
  const runner = createRestrictedApplicationRunner({ provider, tools: [], instructions, outputSchema: replySchema, limits: { maxSteps: 1, maxOutputTokens: 128 } });
  await runner.run(input);
  return body;
}

function profile(hostId = "workstation", variant = "full") {
  return { schemaVersion: "localllm-aginti-text-profile-v1", state: "qualification", issuer: "localllm", profileId: `synthetic-${hostId}-${variant}`, generation: 2, approvalId: "synthetic-offline-only",
    hostId, issuedAt: "2026-11-05T01:00:00Z", expiresAt: "2026-11-05T01:04:00Z",
    client: { clientId: "synthetic-client", variant, version: variant === "full" ? "0.20.344-integration.1" : "0.1.0-preview.2", packageSha256: digest("a"), harnessSha256: digest("b") },
    transport: { kind: hostId === "mac" ? "ssh-stdio-http-relay" : "loopback-http", clientHostId: "workstation", namespaceHostId: hostId, endpointOrigin: "http://127.0.0.1:18126", apiPrefix: "/v1", bindingId: "synthetic-binding", bindingSha256: digest("c") },
    model: hostId === "mac" ? { requestAlias: "localllm-qwen36", resolvedId: "qwen3.6:35b-a3b", manifestSha256: digest("d"), runtimeContextTokens: 8192 } : { requestAlias: "localllm-fast", resolvedId: "qwen3:8b-q4_K_M", manifestSha256: digest("d"), runtimeContextTokens: 65536 },
    release: { apiReleaseId: "12345678-abcdef12", apiArtifactSha256: digest("e"), runtimeArtifactSha256: digest("f"), adapterArtifactSha256: digest("0") },
    canary: { role: "text", verdict: "passed", receiptSha256: digest("1"), passedAt: "2026-11-05T00:59:30Z", maxAgeSeconds: 300 },
    requestPolicy, replySchemaSha256: canonicalHash(replySchema), serverDefaults: { reasoning_effort: "none" }, credentialRef: "synthetic-no-credential" };
}

function acceptance(p) {
  return { profileSha256: canonicalHash(p), approvalId: p.approvalId, generation: p.generation, hostId: p.hostId, client: clone(p.client), transport: clone(p.transport),
    ownerReceiptAt: "2026-11-05T00:59:59Z", workDeadline: "2026-11-05T01:04:00Z", tokenExpiresAt: "2026-11-05T01:04:00Z" };
}

function responseFixture(body, p = profile()) {
  const requestBytes = bytes(body), response = { id: "synthetic-native-response", model: p.model.resolvedId, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"reply":"amber"}' } }] };
  const input = { profile: p, acceptance: acceptance(p), requestBytes, responseBytes: bytes(response), rawHeaders: [], requestId, startedAt, arrivedAt, elapsedMs: 1000 };
  const request = validateRequest(requestBytes, p.model.requestAlias);
  let identity = { schemaVersion: "localllm-aginti-response-identity-v1", outcome: "complete", requestId, profileId: p.profileId, profileGeneration: p.generation,
    profileSha256: input.acceptance.profileSha256, hostId: p.hostId, apiReleaseId: p.release.apiReleaseId, model: p.model.resolvedId, modelManifestSha256: p.model.manifestSha256,
    canaryReceiptSha256: p.canary.receiptSha256, clientWireSha256: request.wireSha256, clientCanonicalSha256: request.canonicalSha256,
    upstreamCanonicalSha256: request.upstreamCanonicalSha256, responseWireSha256: sha256(input.responseBytes), dispatchedAt: startedAt, completedAt: arrivedAt, finishReason: "stop" };
  const seal = () => { input.rawHeaders = [["X-LocalLLM-Response-Identity", Buffer.from(canonical(identity)).toString("base64url")]]; };
  seal();
  return { input, response, identity, seal, replaceIdentity: (value) => { identity = value; seal(); } };
}

test("actual English and Chinese SDK bodies reproduce the owner-reviewed canonical and wire vectors", async () => {
  const vectors = [
    ["english-initial", 912, 491, "677689b84935e5fa857e92840fbd2971f08e8ce387a08ea110e063f634c5be40", "e2f43e36da6322234c6a7a713f535ee712ba8a7ce3dac015ed734b6ac0b33992"],
    ["chinese-followup", 1072, 538, "8c5c0b180926f4d0644c78d17b2489fdc84477e5a845f71fc0600e9c70952885", "b5318077e19e763e57ff3c935883410e4f945908c5c8a26279e8be778cddb26e"],
  ];
  for (const [name, size, textBytes, canonicalDigest, wireDigest] of vectors) {
    const body = await emittedRequest(inputs[name]);
    const value = validateRequest(bytes(body), "localllm-fast");
    assert.equal(value.encodedBytes, size); assert.equal(value.messageTextBytes, textBytes);
    assert.equal(value.canonicalSha256, `sha256:${canonicalDigest}`); assert.equal(value.wireSha256, `sha256:${wireDigest}`);
    assert.notEqual(value.upstreamCanonicalSha256, value.canonicalSha256);
  }
  assert.equal(canonicalHash(replySchema), "sha256:1b22d84f47cbe757f72ae2783ed64c61ced1d6f08674b37ca98a8849d0c96b88");
});

test("Mac model selection is actual SDK emission and changes only the host-selected model", async () => {
  for (const input of Object.values(inputs)) {
    const workstation = await emittedRequest(input), mac = await emittedRequest(input, "localllm-qwen36");
    assert.equal(mac.model, "localllm-qwen36");
    assert.equal(canonical({ ...mac, model: workstation.model }), canonical(workstation));
    validateRequest(bytes(mac), "localllm-qwen36");
    const fixture = responseFixture(mac, profile("mac"));
    assert.equal(validateResponse(fixture.input).reply, "amber");
  }
});

test("every unreviewed request field, stream, tool, image or schema downgrade fails", async () => {
  const base = await emittedRequest();
  const changes = [
    (b) => { b.stream = true; }, (b) => { b.tools = []; }, (b) => { b.tool_choice = "none"; },
    (b) => { b.reasoning_effort = "none"; }, (b) => { b.n = 1; }, (b) => { b.model = "other"; },
    (b) => { b.max_tokens = 129; }, (b) => { b.max_tokens = "128"; }, (b) => { b.temperature = 0.1; },
    (b) => { b.messages[1].content = "strings-only"; }, (b) => { b.messages[1].role = "tool"; },
    (b) => { b.messages[1].content[0] = { type: "image_url", image_url: { url: "https://example.invalid/image" } }; },
    (b) => { b.response_format.type = "json_object"; }, (b) => { b.response_format.json_schema.strict = false; },
    (b) => { b.response_format.json_schema.name = "another"; }, (b) => { b.response_format.json_schema.schema.properties.extra = { type: "string" }; },
    (b) => { delete b.stream; }, (b) => { b.messages[0].content = []; }, (b) => { b.messages.push({ role: "assistant", content: [{ type: "text", text: "extra" }] }); },
  ];
  for (const mutate of changes) { const b = clone(base); mutate(b); assert.throws(() => validateRequest(bytes(b), base.model)); }
});

test("request limits count UTF-8 bytes, exact message alternation and the encoded entity", async () => {
  const base = await emittedRequest();
  const b = clone(base); b.messages[0].content = "a"; b.messages[1].content[0].text = "中".repeat(683);
  assert.throws(() => validateRequest(bytes(b), base.model));
  b.messages[1].content[0].text = "\u0000".repeat(2047);
  assert.ok(validateRequest(bytes(b), base.model));
  assert.throws(() => validateRequest(Buffer.from(`${JSON.stringify(base)}${" ".repeat(16384)}`), base.model));
  b.messages[1].content = Array.from({ length: 17 }, () => ({ type: "text", text: "a" }));
  assert.throws(() => validateRequest(bytes(b), base.model));
  const history = await emittedRequest(inputs["chinese-followup"]); history.messages[2].role = "user";
  assert.throws(() => validateRequest(bytes(history), base.model));
});

test("strict raw JSON rejects duplicates, invalid UTF-8, BOM, surrogates and dangerous object hooks", () => {
  for (const entity of [Buffer.from('{"a":1,"\\u0061":2}'), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    Buffer.from('\ufeff{"a":1}'), Buffer.from('{"a":"\\ud800"}'), Buffer.from('{"a":1e400}')]) assert.throws(() => strictEntity(entity));
  let traps = 0;
  assert.throws(() => strictEntity(new Proxy(Buffer.from("{}"), { get() { traps++; throw Error("must not run"); } })));
  for (const object of [Object.defineProperty({}, "a", { enumerable: true, get() { traps++; } }), new Proxy({}, { ownKeys() { traps++; } }), { a: 1.5 }, { "非ASCII": 1 }]) assert.throws(() => canonical(object));
  assert.equal(traps, 0);
  assert.notEqual(canonicalHash({ text: "é" }), canonicalHash({ text: "e\u0301" }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
});

test("synthetic qualification is accepted only with the independently supplied matching fixture acceptance", () => {
  for (const hostId of ["workstation", "mac"]) for (const variant of ["full", "lite"]) {
    const p = profile(hostId, variant), a = acceptance(p);
    const result = validateProfile(p, a, timestamp(startedAt));
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.transport));
    p.client.clientId = "mutated";
    assert.equal(result.client.clientId, "synthetic-client");
    assert.throws(() => validateProfile(p, a, timestamp(startedAt)));
  }
});

test("unavailable, self-issued, rollback, binding and client swaps never grant qualification", () => {
  const p = profile(), a = acceptance(p);
  assert.throws(() => validateProfile({ schemaVersion: p.schemaVersion, state: "unavailable", issuer: "localllm", hostId: "workstation", reasonCodes: ["no_approval"] }, a, timestamp(startedAt)));
  for (const mutate of [
    (b) => { b.profileSha256 = digest("9"); }, (b) => { b.generation = 1; }, (b) => { b.approvalId = "self-issued"; },
    (b) => { b.hostId = "mac"; }, (b) => { b.client.variant = "lite"; }, (b) => { b.transport.bindingSha256 = digest("9"); },
    (b) => { b.client.harnessSha256 = digest("9"); }, (b) => { b.client.packageSha256 = digest("9"); },
  ]) { const altered = clone(a); mutate(altered); assert.throws(() => validateProfile(p, altered, timestamp(startedAt))); }
  assert.throws(() => validateProfile(p, {}, timestamp(startedAt)));
});

test("even matching fixture approval cannot bypass the fixed policy, model, schema or temporal rules", () => {
  const changes = [
    (p) => { p.extra = true; }, (p) => { p.model.resolvedId = "other"; }, (p) => { p.client.version = "0.0.0"; },
    (p) => { p.transport.endpointOrigin = "http://127.0.0.1:8008"; }, (p) => { p.transport.namespaceHostId = "mac"; },
    (p) => { p.requestPolicy = { ...p.requestPolicy, retries: 1 }; }, (p) => { p.serverDefaults.reasoning_effort = "high"; },
    (p) => { p.replySchemaSha256 = digest("9"); }, (p) => { p.canary.verdict = "failed"; }, (p) => { p.canary.passedAt = "2026-11-05T01:00:01Z"; },
    (p) => { p.issuedAt = "2026-11-05T01:00:20Z"; }, (p) => { p.expiresAt = "2026-11-05T01:05:00Z"; },
  ];
  for (const mutate of changes) { const p = clone(profile()); mutate(p); assert.throws(() => validateProfile(p, acceptance(p), timestamp(startedAt))); }
  const p = profile();
  for (const now of [timestamp(p.expiresAt), timestamp(p.issuedAt) - 1]) assert.throws(() => validateProfile(p, acceptance(p), now));
  for (const time of ["2026-02-30T01:00:00Z", "2026-11-05T01:00:00.000Z", "2026-11-05T01:00:00+00:00"]) assert.throws(() => timestamp(time));
});

test("valid synthetic identity releases only detached reply JSON to the generic SDK", async () => {
  const body = await emittedRequest(), fixture = responseFixture(body);
  assert.equal(validateResponse(fixture.input).reply, "amber");
  const provider = createRestrictedOpenAIProvider({ model: body.model, supportsImages: false, complete: async (request) => {
    const item = responseFixture(request); validateResponse(item.input); return strictEntity(item.input.responseBytes).value;
  } });
  const result = await createRestrictedApplicationRunner({ provider, tools: [], instructions, outputSchema: replySchema, limits: { maxSteps: 1, maxOutputTokens: 128 } }).run(inputs["english-initial"]);
  assert.equal(result.proposal.reply, "amber");
  assert.deepEqual({ ...result.usage }, { steps: 1, toolCalls: 0 });
});

test("every identity scope, request, release, model, receipt and hash substitution fails", async () => {
  const body = await emittedRequest();
  const fields = ["requestId", "profileId", "profileGeneration", "profileSha256", "hostId", "apiReleaseId", "model", "modelManifestSha256", "canaryReceiptSha256", "clientWireSha256", "clientCanonicalSha256", "upstreamCanonicalSha256", "responseWireSha256", "schemaVersion", "outcome", "finishReason"];
  for (const field of fields) {
    const f = responseFixture(body);
    f.identity[field] = typeof f.identity[field] === "number" ? 1 : field.endsWith("Sha256") ? digest("9") : "wrong"; f.seal();
    assert.throws(() => validateResponse(f.input), field);
  }
  const f = responseFixture(body); f.identity.extra = true; f.seal(); assert.throws(() => validateResponse(f.input));
});

test("wire hashes cannot be replaced with canonical hashes or hidden server transformations", async () => {
  const body = await emittedRequest(), f = responseFixture(body);
  f.input.requestBytes = Buffer.from(JSON.stringify(body, null, 2));
  assert.throws(() => validateResponse(f.input));
  f.identity.clientWireSha256 = sha256(f.input.requestBytes); f.seal();
  assert.equal(validateResponse(f.input).reply, "amber");
  f.identity.upstreamCanonicalSha256 = canonicalHash({ ...body, reasoning_effort: "none", keep_alive: 60 }); f.seal();
  assert.throws(() => validateResponse(f.input));
  const g = responseFixture(body); g.input.responseBytes = Buffer.from(`${g.input.responseBytes.toString()}\n`); assert.throws(() => validateResponse(g.input));
});

test("absent, duplicate, combined, padded, oversized and noncanonical identity headers fail", async () => {
  const body = await emittedRequest();
  const changes = [
    (f) => { f.input.rawHeaders = []; }, (f) => { f.input.rawHeaders.push(["x-localllm-response-identity", f.input.rawHeaders[0][1]]); },
    (f) => { f.input.rawHeaders[0][1] += ",other"; }, (f) => { f.input.rawHeaders[0][1] += "="; },
    (f) => { f.input.rawHeaders[0][1] = "A".repeat(4097); }, (f) => { f.input.rawHeaders.push(["Content-Encoding", "gzip"]); },
    (f) => { f.input.rawHeaders[0][1] = Buffer.from(`${canonical(f.identity)} `).toString("base64url"); },
    (f) => { f.input.rawHeaders[0][1] = Buffer.from('{"requestId":"a","requestId":"b"}').toString("base64url"); },
  ];
  // Canonical identity JSON is itself required, not just canonical base64url.
  for (const mutate of changes) { const f = responseFixture(body); mutate(f); assert.throws(() => validateResponse(f.input)); }
});

test("expiry during flight, stale receipt, impossible times and total deadline never release a proposal", async () => {
  const body = await emittedRequest();
  const changes = [
    (f) => { f.input.arrivedAt = f.input.profile.expiresAt; }, (f) => { f.input.elapsedMs = 60001; },
    (f) => { f.input.arrivedAt = "2026-11-05T01:00:09Z"; }, (f) => { f.identity.dispatchedAt = "2026-11-05T01:00:00Z"; f.seal(); },
    (f) => { f.identity.completedAt = "2026-11-05T01:00:09Z"; f.seal(); }, (f) => { f.identity.completedAt = f.input.profile.expiresAt; f.seal(); },
    (f) => { f.input.acceptance.tokenExpiresAt = "2026-11-05T01:00:10Z"; },
  ];
  for (const mutate of changes) { const f = responseFixture(body); mutate(f); assert.throws(() => validateResponse(f.input)); }
});

test("matching metadata never launders incomplete, refused, tool-bearing or malformed native results", async () => {
  const body = await emittedRequest();
  const changes = [
    (r) => { r.model = "other"; }, (r) => { r.choices[0].finish_reason = "length"; }, (r) => { r.choices[0].finish_reason = null; },
    (r) => { delete r.choices[0].finish_reason; }, (r) => { r.choices[0].index = 1; }, (r) => { r.choices.push(clone(r.choices[0])); },
    (r) => { r.choices[0].message.tool_calls = []; }, (r) => { r.choices[0].message.function_call = {}; },
    (r) => { r.choices[0].message.refusal = ""; }, (r) => { r.choices[0].message.refusal = false; },
    (r) => { r.choices[0].message.content = '{"reply":"ok","reply":"wrong"}'; },
    (r) => { r.choices[0].message.content = '```json\n{"reply":"ok"}\n```'; },
    (r) => { r.choices[0].message.content = '{"reply":"ok","extra":true}'; },
    (r) => { r.choices[0].message.content = '{"reply":"   "}'; },
    (r) => { r.choices[0].message.content = JSON.stringify({ reply: "😀".repeat(121) }); },
  ];
  for (const mutate of changes) {
    const f = responseFixture(body); mutate(f.response); f.input.responseBytes = bytes(f.response);
    f.identity.responseWireSha256 = sha256(f.input.responseBytes); f.seal();
    assert.throws(() => validateResponse(f.input));
  }
  const f = responseFixture(body); f.response.choices[0].message.content = JSON.stringify({ reply: "😀".repeat(120) });
  f.input.responseBytes = bytes(f.response); f.identity.responseWireSha256 = sha256(f.input.responseBytes); f.seal();
  assert.equal(Array.from(validateResponse(f.input).reply).length, 120);
});

test("profile and identity hostile descriptors/proxies reject without invoking hooks", async () => {
  let traps = 0;
  const body = await emittedRequest();
  for (const attack of [
    (p) => new Proxy(p, { get() { traps++; } }),
    (p) => Object.defineProperty(p, "generation", { enumerable: true, get() { traps++; } }),
    (p) => { Object.defineProperty(p, "hidden", { value: 1 }); return p; },
    (p) => { p[Symbol("extra")] = 1; return p; },
    (p) => Object.assign(Object.create({ inherited: true }), p),
  ]) {
    const f = responseFixture(body); f.input.profile = attack(clone(f.input.profile));
    assert.throws(() => validateResponse(f.input));
  }
  assert.equal(traps, 0);
});

test("response call boundary rejects accessors/proxies and response replay cannot cross operation IDs", async () => {
  const f = responseFixture(await emittedRequest());
  let traps = 0;
  assert.throws(() => validateResponse(new Proxy(f.input, { get() { traps++; } })));
  assert.throws(() => validateResponse(Object.defineProperty({ ...f.input }, "profile", { enumerable: true, get() { traps++; } })));
  assert.equal(traps, 0);
  f.input.requestId = "061ecac1-1111-4000-8000-000000000002";
  assert.throws(() => validateResponse(f.input));
});
