import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createClient, createChatCompletion, isTransientProviderRequestError, shouldRetryWithTextToolProtocol } from "../src/model-client.js";
import { createModelHttpClient } from "../src/model-http-client.js";
import { classifyProviderHandoffError } from "../src/provider-handoff.js";
import { runSafeChat } from "../src/safe-chat-wrapper.js";
import { readImage } from "../src/perception-tools.js";

const marker = "SYNTHETIC_PRIVATE_PROMPT_MUST_STAY_ON_CONFIGURED_ROUTE";
const payload = { model: "offline-model", messages: [{ role: "user", content: `Summarize this note, do not share it: ${marker}` }] };
const config = { provider: "deepseek", modelTimeoutMs: 2000 };
const completion = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Observed note." } }] };

async function server(t, handler) {
  const s = http.createServer(handler);
  s.listen(0, "127.0.0.1"); await once(s, "listening");
  t.after(async () => { const closed = once(s, "close"); s.close(); s.closeAllConnections(); await closed; });
  return { server: s, origin: `http://127.0.0.1:${s.address().port}` };
}
const send = response => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(completion)); };
const client = baseURL => createClient({ ...config, baseURL, apiKey: "synthetic-model-http-key" });

for (const status of [301, 302, 303, 307, 308]) test(`model HTTP ${status} cannot forward a private prompt to another origin`, { timeout: 6000 }, async t => {
  let sourceRequests = 0, targetRequests = 0, leakedPrompt = false;
  const target = await server(t, (request, response) => {
    targetRequests++; let body = "";
    request.on("data", b => body += b);
    request.on("end", () => { leakedPrompt ||= body.includes(marker); send(response); });
  });
  const source = await server(t, (request, response) => {
    sourceRequests++; request.resume();
    response.writeHead(status, { Location: target.origin + "/v1/chat/completions" }).end();
  });
  let failure;
  try { await createChatCompletion(client(source.origin + "/v1"), payload, config); }
  catch (error) { failure = error; }
  assert.equal(targetRequests, 0, `redirect reached another origin; private prompt forwarded=${leakedPrompt}`);
  assert.ok(failure, "redirect must not become a successful completion");
  assert.equal(failure.status, status);
  assert.equal(sourceRequests, 1, "an HTTP redirect must not spend an SDK or compatibility retry");
});

test("same-origin redirects cannot silently select another model endpoint", { timeout: 6000 }, async t => {
  let sourceRequests = 0, otherPathRequests = 0;
  const source = await server(t, (request, response) => {
    request.resume();
    if (request.url !== "/v1/chat/completions") { otherPathRequests++; send(response); return; }
    sourceRequests++; response.writeHead(307, { Location: "/unexpected-handler" }).end();
  });
  await assert.rejects(createChatCompletion(client(source.origin + "/v1"), payload, config), error => error.status === 307);
  assert.equal(sourceRequests, 1); assert.equal(otherPathRequests, 0);
});

test("a redirect with a stalled body is refused immediately and its socket closes", { timeout: 6000 }, async t => {
  let close, requests = 0;
  const closed = new Promise(resolve => close = resolve);
  const source = await server(t, (request, response) => {
    requests++; request.resume(); response.once("close", close);
    response.writeHead(307, { Location: "/never", "Content-Type": "text/plain" });
    response.write("An untrusted redirect body that never finishes.");
  });
  await assert.rejects(createChatCompletion(client(source.origin + "/v1"), payload, config),
    error => error.status === 307);
  await closed; assert.equal(requests, 1);
});

test("ordinary model completion preserves the exact payload on the configured route", { timeout: 6000 }, async t => {
  let body, requests = 0;
  const source = await server(t, (request, response) => {
    requests++; assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer synthetic-model-http-key");
    let text = ""; request.on("data", b => text += b);
    request.on("end", () => { body = JSON.parse(text); send(response); });
  });
  assert.deepEqual(await createChatCompletion(client(source.origin + "/v1"), payload, config), completion);
  assert.deepEqual(body, payload); assert.equal(requests, 1);
});

for (const headers of [false, true]) test(`caller cancellation closes real model HTTP ${headers ? "during response body" : "before headers"}`, { timeout: 6000 }, async t => {
  let enter, close;
  const entered = new Promise(resolve => enter = resolve), closed = new Promise(resolve => close = resolve);
  let requests = 0;
  const source = await server(t, (request, response) => {
    requests++; request.resume();
    response.on("close", close);
    if (headers) { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"choices":['); }
    enter();
  });
  const controller = new AbortController();
  const outcome = createChatCompletion(client(source.origin + "/v1"), payload, { ...config, abortSignal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  await entered; controller.abort(new Error("Host cancelled this turn"));
  assert.equal((await outcome).error.name, "AbortError");
  await closed;
  assert.equal(requests, 1);
});

test("mock model stays entirely offline", () => {
  assert.deepEqual(createClient({ provider: "mock" }), { mock: true, provider: "mock" });
});

test("a redirect body cannot request a compatibility retry or provider handoff", { timeout: 6000 }, async t => {
  let requests = 0;
  const source = await server(t, (request, response) => {
    requests++; request.resume();
    response.writeHead(307, { Location: "/never", "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Unsupported parameter reasoning_effort; tools invalid; quota exceeded; fetch failed; temporarily unavailable" } }));
  });
  let failure;
  try { await createChatCompletion(client(source.origin + "/v1"), payload, { ...config, reasoning: "high" }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status, 307); assert.equal(requests, 1);
  assert.doesNotMatch(failure.message, /quota|reasoning_effort/);
  const advertised = { status: 307, message: "Unsupported reasoning_effort; tools invalid; quota exceeded; fetch failed" };
  assert.equal(shouldRetryWithTextToolProtocol(advertised, { provider: "localllm" }), false);
  assert.equal(isTransientProviderRequestError(advertised), false);
  assert.equal(classifyProviderHandoffError(advertised).eligible, false);
  assert.equal(shouldRetryWithTextToolProtocol(failure, { provider: "localllm" }), false);
  assert.equal(isTransientProviderRequestError(failure), false);
  assert.equal(classifyProviderHandoffError(failure).eligible, false);
});

test("the owned default overrides follow while retaining explicitly strict error mode", { timeout: 6000 }, async t => {
  let targetRequests = 0;
  const target = await server(t, (request, response) => { targetRequests++; request.resume(); send(response); });
  const source = await server(t, (request, response) => { request.resume(); response.writeHead(307, { Location: target.origin + "/v1/chat/completions" }).end(); });
  const options = { apiKey: "synthetic-model-http-key", baseURL: source.origin + "/v1", fetchOptions: { redirect: "follow" } };
  assert.equal(createModelHttpClient(options).fetchOptions.redirect, "manual");
  assert.equal(options.fetchOptions.redirect, "follow", "do not mutate a caller's trusted configuration");
  assert.equal(createModelHttpClient({ ...options, fetchOptions: { redirect: "error" } }).fetchOptions.redirect, "error");
  await assert.rejects(createModelHttpClient(options).chat.completions.create(payload, { fetchOptions: { redirect: "follow" } }), error => error.status === 307);
  assert.equal(targetRequests, 0);
});

test("real safe-chat HTTP refuses redirect with no answer, retry, or quota misclassification", { timeout: 6000 }, async t => {
  let sourceRequests = 0, targetRequests = 0;
  const target = await server(t, (request, response) => { targetRequests++; request.resume(); send(response); });
  const source = await server(t, (request, response) => {
    sourceRequests++; request.resume();
    response.writeHead(308, { Location: target.origin + "/v1/chat/completions", "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "quota exceeded; invalid API key; overload" } }));
  });
  const result = await runSafeChat({ prompt: marker }, { env: {
    AGINTI_SAFE_CHAT_ENABLED: "1", AGINTI_SAFE_CHAT_PROVIDER: "localllm",
    AGINTI_SAFE_CHAT_API_KEY: "synthetic-model-http-key", AGINTI_SAFE_CHAT_MODEL: "offline-model",
    AGINTI_SAFE_CHAT_BASE_URL: source.origin + "/v1",
  } });
  assert.equal(result.ok, false); assert.equal(result.code, "upstream_error");
  assert.equal(result.status, 502); assert.equal(result.retryable, false);
  assert.equal(Object.hasOwn(result, "answer"), false);
  assert.equal(sourceRequests, 1); assert.equal(targetRequests, 0);
});

test("native image perception refuses redirect before a reasoning retry or image forwarding", { timeout: 6000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-model-http-image-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "sample.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7mQAAAAASUVORK5CYII=", "base64"));
  let sourceRequests = 0, targetRequests = 0, imageOnSource = false;
  const target = await server(t, (request, response) => { targetRequests++; request.resume(); send(response); });
  const source = await server(t, (request, response) => {
    sourceRequests++; let body = ""; request.on("data", b => body += b);
    request.on("end", () => {
      imageOnSource ||= body.includes("data:image/png;base64,");
      response.writeHead(307, { Location: target.origin + "/v1/responses", "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "model not found; unsupported reasoning parameter" } }));
    });
  });
  const result = await readImage({ path: "sample.png", provider: "openai", model: "offline-model", reasoning: "medium", fallbackModels: [] }, {
    provider: "openai", apiKey: "synthetic-model-http-key", baseURL: source.origin + "/v1", commandCwd: root,
    modelTimeoutMs: 2000,
  });
  assert.equal(result.ok, false); assert.equal(sourceRequests, 1); assert.equal(targetRequests, 0);
  assert.equal(imageOnSource, true, "actually exercise the native image request, not a preflight rejection");
});
