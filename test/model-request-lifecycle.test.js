import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import OpenAI from "openai";
import { createChatCompletion } from "../src/model-client.js";

const response = { choices: [{ message: { content: "Observed result" } }] };
const payload = { model: "offline-fixture", messages: [{ role: "user", content: "Summarize these notes." }] };
const config = { provider: "deepseek", reasoning: "high", modelTimeoutMs: 100 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clientFor(create) {
  return { chat: { completions: { create } } };
}

function observe(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

async function afterTurn(observed) {
  return Promise.race([observed, new Promise(resolve => setImmediate(() => resolve({ pending: true })))]);
}

test("compatibility retry shares the original deadline and cannot accept late success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const retry = deferred();
  const entered = deferred();
  const requests = [];
  t.after(() => { first.resolve(response); retry.resolve(response); });
  const observed = observe(createChatCompletion(clientFor((body, options) => {
    requests.push({ body, options });
    if (requests.length === 1) return first.promise;
    entered.resolve();
    return retry.promise;
  }), payload, config));
  await afterTurn(observed);
  t.mock.timers.tick(70);
  first.reject(new Error("Unsupported parameter: reasoning_effort"));
  await entered.promise;
  t.mock.timers.tick(30);
  const outcome = await afterTurn(observed);
  assert.equal(outcome.error?.name, "ModelTimeoutError");
  assert.equal(outcome.error.agintiProviderRequest, true);
  assert.equal(outcome.error.agintiProvider, "deepseek");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal(Object.hasOwn(requests[1].body, "reasoning_effort"), false);
  assert.equal(requests[0].options.signal, requests[1].options.signal);
  assert.equal(requests[1].options.signal.aborted, true);
  retry.resolve(response);
  assert.equal((await observed).error, outcome.error);
});

for (const retry of [false, true]) {
  test(`caller cancellation settles during ${retry ? "compatibility retry" : "initial request"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const parent = new AbortController();
    const pending = deferred();
    const entered = deferred();
    const reason = Object.freeze(new DOMException("Caller stopped this turn", "AbortError"));
    let calls = 0;
    let requestSignal;
    t.after(() => pending.resolve(response));
    const observed = observe(createChatCompletion(clientFor((_body, options) => {
      calls += 1;
      requestSignal = options.signal;
      if (retry && calls === 1) throw new Error("Unsupported parameter: reasoning_effort");
      entered.resolve();
      return pending.promise;
    }), payload, { ...config, abortSignal: parent.signal }));
    await entered.promise;
    parent.abort(reason);
    const outcome = await afterTurn(observed);
    assert.equal(outcome.error?.name, "AbortError");
    assert.equal(outcome.error.cause, reason);
    assert.equal(requestSignal.aborted, true);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    t.mock.timers.tick(1000);
    pending.reject(new Error("Late provider rejection"));
    assert.equal((await observed).error, outcome.error);
    assert.equal(calls, retry ? 2 : 1);
    assert.equal(reason.name, "AbortError");
  });
}

test("already cancelled requests never dispatch", async () => {
  const parent = new AbortController();
  parent.abort("stop");
  let calls = 0;
  await assert.rejects(createChatCompletion(clientFor(async () => {
    calls += 1;
    return response;
  }), payload, { ...config, abortSignal: parent.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("abort during unsupported-parameter failure does not start another request", async () => {
  const parent = new AbortController();
  let calls = 0;
  await assert.rejects(createChatCompletion(clientFor(() => {
    calls += 1;
    parent.abort();
    throw new Error("Unsupported parameter: reasoning_effort");
  }), payload, { ...config, abortSignal: parent.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("successful compatibility retry preserves payload and removes timers/listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const calls = [];
  const result = await createChatCompletion(clientFor(async (body, options) => {
    calls.push({ body, options });
    if (calls.length === 1) throw new Error("Unsupported parameter: reasoning_effort");
    return response;
  }), payload, { ...config, abortSignal: parent.signal });
  assert.equal(result, response);
  assert.deepEqual(calls[1].body, payload);
  assert.deepEqual(payload, { model: "offline-fixture", messages: [{ role: "user", content: "Summarize these notes." }] });
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  t.mock.timers.tick(1000);
  parent.abort();
  assert.equal(calls[1].options.signal.aborted, false);
});

test("ordinary provider errors are not retried and retain handoff classification", async () => {
  const failure = Object.assign(new Error("Quota unavailable"), { status: 402 });
  let calls = 0;
  await assert.rejects(createChatCompletion(clientFor(() => {
    calls += 1;
    throw failure;
  }), payload, config), error => error === failure && error.agintiProviderRequest === true);
  assert.equal(calls, 1);
});

test("real SDK retry-after backoff is bounded without any external fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const backoff = deferred();
  let calls = 0;
  const client = new OpenAI({
    apiKey: "offline-fixture-key",
    baseURL: "https://offline.invalid/v1",
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort" } }), { status: 400 });
      backoff.resolve();
      return new Response(JSON.stringify({ error: { message: "Try again later" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after-ms": "1000" },
      });
    },
  });
  const observed = observe(createChatCompletion(client, payload, config));
  await backoff.promise;
  await afterTurn(observed);
  t.mock.timers.tick(100);
  const outcome = await afterTurn(observed);
  // Drain SDK-owned backoff too; the cancelled signal must prevent a new fetch.
  t.mock.timers.tick(2000);
  await afterTurn(observed);
  assert.equal(outcome.error?.name, "ModelTimeoutError");
  assert.equal(calls, 2);
});
