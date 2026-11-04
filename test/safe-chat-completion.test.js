import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { runSafeChat } from "../src/safe-chat-wrapper.js";
import { createSafeChatHttpServer } from "../src/safe-chat-server.js";

const env = {
  AGINTI_SAFE_CHAT_ENABLED: "1", AGINTI_SAFE_CHAT_PROVIDER: "localllm",
  AGINTI_SAFE_CHAT_API_KEY: "synthetic-completion-fixture-key",
  AGINTI_SAFE_CHAT_MODEL: "fixture-model",
  AGINTI_SAFE_CHAT_BASE_URL: "http://127.0.0.1:8008/v1",
};
const response = (content = "Ready.") => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
function fixture(value) {
  let calls = 0;
  return {
    clientFactory: () => ({ chat: { completions: { create: async (payload) => {
      calls++;
      assert.equal("tools" in payload, false);
      assert.equal(payload.messages.at(-1).content, "Just say Ready.");
      return value;
    } } } }),
    calls: () => calls,
  };
}

const malformed = [
  ["truncated", (r) => { r.choices[0].finish_reason = "length"; }],
  ["filtered", (r) => { r.choices[0].finish_reason = "content_filter"; }],
  ["unknown finish", (r) => { r.choices[0].finish_reason = "future_partial"; }],
  ["null finish", (r) => { r.choices[0].finish_reason = null; }],
  ["explicit undefined finish", (r) => { r.choices[0].finish_reason = undefined; }],
  ["refused with plausible text", (r) => { r.choices[0].message.refusal = "PRIVATE_REFUSAL"; }],
  ["legacy function call", (r) => { r.choices[0].message.function_call = { name: "exec", arguments: "{}" }; }],
  ["native call with plausible text", (r) => {
    r.choices[0].finish_reason = "tool_calls";
    r.choices[0].message.tool_calls = [{ id: "fixture_call", type: "function", function: { name: "exec", arguments: "{}" } }];
  }],
  ["native call with forged stop", (r) => { r.choices[0].message.tool_calls = [{ type: "function" }]; }],
  ["malformed tool calls", (r) => { r.choices[0].message.tool_calls = {}; }],
  ["tool finish with no calls", (r) => { r.choices[0].finish_reason = "tool_calls"; }],
  ["wrong role", (r) => { r.choices[0].message.role = "user"; }],
  ["missing role", (r) => { delete r.choices[0].message.role; }],
  ["multiple choices", (r) => { r.choices.push(structuredClone(r.choices[0])); }],
  ["object choices", (r) => { r.choices = { 0: r.choices[0], length: 1 }; }],
  ["null message", (r) => { r.choices[0].message = null; }],
];
for (const [name, mutate] of malformed) {
  test(`safe chat cannot publish ${name}`, async () => {
    const value = response(); mutate(value);
    const f = fixture(value);
    const result = await runSafeChat({ prompt: "Just say Ready." }, { env, clientFactory: f.clientFactory });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_response");
    assert.equal(result.status, 502);
    assert.equal(result.retryable, false);
    assert.equal("answer" in result, false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_REFUSAL"), false);
    assert.equal(f.calls(), 1, "invalid turns must not trigger a repair/fallback request");
    // A rejected turn releases the shared admission slot without persisting it.
    const corrected = fixture(response());
    assert.equal((await runSafeChat({ prompt: "Just say Ready." }, { env, clientFactory: corrected.clientFactory })).answer, "Ready.");
  });
}
for (const content of ["Ready.", "已准备好。", "準備できました。"] ) {
  for (const legacy of [false, true]) {
    test(`complete text remains compatible (${content}, legacy=${legacy})`, async () => {
      const value = response(content);
      if (legacy) delete value.choices[0].finish_reason;
      value.choices[0].message.refusal = null;
      value.choices[0].message.function_call = null;
      value.choices[0].message.tool_calls = [];
      const f = fixture(value);
      const result = await runSafeChat({ prompt: "Just say Ready." }, { env, clientFactory: f.clientFactory });
      assert.equal(result.ok, true); assert.equal(result.answer, content); assert.equal(f.calls(), 1);
    });
  }
}

test("HTTP boundary preserves safe protocol failure and permits the next request", { timeout: 5000 }, async () => {
  const value = response(); value.choices[0].finish_reason = "length";
  const f = fixture(value), token = "synthetic-safe-chat-completion-bearer";
  const { server } = createSafeChatHttpServer({ env, bearerToken: token, clientFactory: f.clientFactory });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/v1/chat`;
    const request = () => fetch(url, { method: "POST", signal: AbortSignal.timeout(2000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Just say Ready." }) });
    const rejected = await request();
    assert.equal(rejected.status, 502); assert.equal(rejected.headers.get("Cache-Control"), "no-store");
    const body = await rejected.json();
    assert.equal(body.code, "invalid_response"); assert.equal("answer" in body, false);
    value.choices[0].finish_reason = "stop";
    const corrected = await request();
    assert.equal(corrected.status, 200); assert.equal((await corrected.json()).answer, "Ready.");
    assert.equal(f.calls(), 2);
  } finally {
    if (server.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
  }
});
