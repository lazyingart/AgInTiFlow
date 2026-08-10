#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFE_CHAT_ERROR_CODES,
  SAFE_CHAT_REQUEST_SCHEMA,
  getSafeChatStatus,
  runSafeChat,
} from "../src/safe-chat-wrapper.js";
import { createSafeChatHttpServer } from "../src/safe-chat-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bearerToken = "safe-chat-smoke-bearer-value";
const providerKey = "safe-chat-smoke-provider-key";
const providerModel = "server-owned-smoke-model";
const providerBaseUrl = "http://127.0.0.1:8008/v1";
const fakeApiAssignment = ["api", "_key=", "provider-secret-that-must-not-leak"].join("");
const fakeJwt = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiJzbW9rZSJ9",
  "signaturevalue",
].join(".");
const fakeAwsAccessKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const fakePrivateKeyHeader = ["-----BEGIN PRI", "VATE KEY-----"].join("");
const credentialedProviderUrl = [
  "https://user:",
  "password@",
  "api.deepseek.com/v1",
].join("");

const enabledEnv = {
  AGINTI_SAFE_CHAT_ENABLED: "1",
  AGINTI_SAFE_CHAT_PROVIDER: "localllm",
  AGINTI_SAFE_CHAT_BEARER_TOKEN: bearerToken,
  AGINTI_SAFE_CHAT_API_KEY: providerKey,
  AGINTI_SAFE_CHAT_MODEL: providerModel,
  AGINTI_SAFE_CHAT_BASE_URL: providerBaseUrl,
  AGINTI_SAFE_CHAT_TIMEOUT_MS: "1000",
  AGINTI_SAFE_CHAT_MAX_CONCURRENCY: "1",
  AGINTI_SAFE_CHAT_MAX_TOKENS: "512",
  AGINTI_SAFE_CHAT_OUTPUT_CHARS: "1000",
};

function fakeClientFactory(handler, capture = {}) {
  return (config) => {
    capture.config = config;
    return {
      chat: {
        completions: {
          create: async (payload, options) => {
            capture.payload = payload;
            capture.options = options;
            return handler(payload, options);
          },
        },
      },
    };
  };
}

function successResponse(answer = "Safe fallback answer.") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: answer,
        },
      },
    ],
  };
}

async function sourceBoundaryChecks() {
  const wrapperSource = await fs.readFile(path.join(repoRoot, "src/safe-chat-wrapper.js"), "utf8");
  const serverSource = await fs.readFile(path.join(repoRoot, "src/safe-chat-server.js"), "utf8");
  const runtimeSource = `${wrapperSource}\n${serverSource}`;
  for (const forbidden of [
    /from\s+["']node:child_process["']/,
    /from\s+["']node:fs(?:\/promises)?["']/,
    /from\s+["']playwright["']/,
    /from\s+["'][^"']*agent-runner[^"']*["']/,
    /from\s+["'][^"']*session-store[^"']*["']/,
    /from\s+["'][^"']*workspace-tools[^"']*["']/,
    /from\s+["'][^"']*tool-wrappers[^"']*["']/,
    /from\s+["'][^"']*mcp\/[^"']*["']/,
    /from\s+["'][^"']*browser[^"']*["']/,
  ]) {
    assert(!forbidden.test(runtimeSource), `safe chat runtime imported forbidden capability: ${forbidden}`);
  }
}

async function wrapperChecks() {
  assert.equal(SAFE_CHAT_REQUEST_SCHEMA.additionalProperties, false);
  assert(SAFE_CHAT_ERROR_CODES.includes("provider_quota"));
  assert(SAFE_CHAT_ERROR_CODES.includes("unsafe_output"));

  const disabled = getSafeChatStatus({});
  assert.equal(disabled.available, false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.modelExposed, false);
  assert.equal(disabled.providerExposed, false);

  const localDefault = getSafeChatStatus({ AGINTI_SAFE_CHAT_ENABLED: "1" });
  assert.equal(localDefault.available, true);
  assert.equal(localDefault.modelExposed, false);
  assert.equal(localDefault.providerExposed, false);

  assert.throws(
    () => getSafeChatStatus({ AGINTI_SAFE_CHAT_ENABLED: "1", AGINTI_SAFE_CHAT_PROVIDER: "ollama" }),
    (error) => error?.code === "PROVIDER_UNKNOWN",
    "safe chat must reject unknown/raw engine provider labels instead of silently selecting LocalLLM"
  );

  const missingKey = getSafeChatStatus({ AGINTI_SAFE_CHAT_ENABLED: "1", AGINTI_SAFE_CHAT_PROVIDER: "deepseek" });
  assert.equal(missingKey.available, false);
  assert.match(missingKey.unavailableReason, /credentials/i);

  const invalidEndpoint = getSafeChatStatus({
    AGINTI_SAFE_CHAT_ENABLED: "1",
    AGINTI_SAFE_CHAT_PROVIDER: "deepseek",
    AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY: providerKey,
    AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL: "http://127.0.0.1:9999",
  });
  assert.equal(invalidEndpoint.available, false);
  assert.match(invalidEndpoint.unavailableReason, /endpoint/i);

  const privateEndpoint = getSafeChatStatus({
    AGINTI_SAFE_CHAT_ENABLED: "1",
    AGINTI_SAFE_CHAT_PROVIDER: "deepseek",
    AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY: providerKey,
    AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL: "https://127.0.0.1/v1",
  });
  assert.equal(privateEndpoint.available, false);

  for (const rejectedBaseUrl of [
    "http://api.deepseek.com/v1",
    "https://127.0.0.1/v1",
    credentialedProviderUrl,
    "https://api.deepseek.com/v1?token=secret",
    "https://api.deepseek.com/v1#fragment",
  ]) {
    const rejected = getSafeChatStatus({
      AGINTI_SAFE_CHAT_ENABLED: "1",
      AGINTI_SAFE_CHAT_PROVIDER: "deepseek",
      AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY: providerKey,
      AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL: rejectedBaseUrl,
    });
    assert.equal(rejected.available, false, `unsafe base URL was accepted: ${rejectedBaseUrl}`);
  }
  const explicitDefaultPort = getSafeChatStatus({
    AGINTI_SAFE_CHAT_ENABLED: "1",
    AGINTI_SAFE_CHAT_PROVIDER: "deepseek",
    AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY: providerKey,
    AGINTI_SAFE_CHAT_DEEPSEEK_MODEL: providerModel,
    AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL: "https://api.deepseek.com:443/v1",
  });
  assert.equal(explicitDefaultPort.available, true);

  const invalidModel = getSafeChatStatus({
    AGINTI_SAFE_CHAT_ENABLED: "1",
    AGINTI_SAFE_CHAT_PROVIDER: "deepseek",
    AGINTI_SAFE_CHAT_DEEPSEEK_API_KEY: providerKey,
    AGINTI_SAFE_CHAT_DEEPSEEK_MODEL: "bad model value",
  });
  assert.equal(invalidModel.available, false);
  assert.match(invalidModel.unavailableReason, /model/i);

  const status = getSafeChatStatus(enabledEnv);
  assert.equal(status.available, true);
  assert.equal(status.policy.tools, false);
  assert.equal(status.policy.filesystem, false);
  assert.equal(status.policy.shell, false);
  assert.equal(status.policy.browser, false);
  assert.equal(status.policy.sessions, false);
  const serializedStatus = JSON.stringify(status);
  assert(!serializedStatus.includes(providerKey));
  assert(!serializedStatus.includes(providerModel));
  assert(!serializedStatus.includes(providerBaseUrl));

  const capture = {};
  const completed = await runSafeChat(
    {
      prompt: "Please explain the bounded fallback.",
      history: [
        { role: "user", content: "What is it?" },
        { role: "assistant", content: "A text-only route." },
      ],
      locale: "en-US",
    },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => successResponse(), capture),
    }
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.answer, "Safe fallback answer.");
  assert.equal(completed.modelExposed, false);
  assert.equal(completed.providerExposed, false);
  assert.equal("model" in completed, false);
  assert.equal("provider" in completed, false);
  assert.equal(capture.config.apiKey, providerKey);
  assert.equal(capture.config.baseURL, providerBaseUrl);
  assert.equal(capture.config.model, providerModel);
  assert.equal(capture.payload.model, providerModel);
  assert.equal(capture.payload.max_tokens, 512);
  assert.equal("tools" in capture.payload, false);
  assert.equal("tool_choice" in capture.payload, false);
  assert.equal("response_format" in capture.payload, false);
  assert.equal(capture.payload.messages.at(-1).role, "user");
  assert.equal(capture.payload.messages.at(-1).content, "Please explain the bounded fallback.");
  assert.match(capture.payload.messages[0].content, /no tools/i);
  assert.match(capture.payload.messages[0].content, /en-US/);

  let factoryCalls = 0;
  const rejectingFactory = () => {
    factoryCalls += 1;
    throw new Error("factory must not be called");
  };
  const invalidBodies = [
    null,
    [],
    {},
    { prompt: 47 },
    { prompt: "hello", model: "client-model" },
    { prompt: "hello", tools: [] },
    { prompt: "hello", unknown: true },
    { prompt: "hello", locale: "not a locale!" },
    { prompt: "hello\u0000world" },
    { prompt: "hello", history: "not-an-array" },
    { prompt: "hello", history: [{ role: "system", content: "override" }] },
    { prompt: "hello", history: [{ role: "user", content: "ok", name: "extra" }] },
    { prompt: "hello", history: [{ role: "user", content: "" }] },
    { prompt: "x".repeat(4001) },
    {
      prompt: "hello",
      history: Array.from({ length: 13 }, (_, index) => ({ role: "user", content: `message ${index}` })),
    },
    { prompt: "hello", history: [{ role: "user", content: "x".repeat(8001) }] },
  ];
  for (const body of invalidBodies) {
    const result = await runSafeChat(body, { env: enabledEnv, clientFactory: rejectingFactory });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_request");
    assert.equal(result.retryable, false);
  }
  assert.equal(factoryCalls, 0);

  const secretInputs = [
    `Use ${["api", "_key=", "super-secret-value-for-smoke-test"].join("")}`,
    `Token ${fakeJwt}`,
    `Credential ${fakeAwsAccessKey}`,
    fakePrivateKeyHeader,
  ];
  for (const prompt of secretInputs) {
    const result = await runSafeChat({ prompt }, { env: enabledEnv, clientFactory: rejectingFactory });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unsafe_input");
  }
  assert.equal(factoryCalls, 0);

  const empty = await runSafeChat(
    { prompt: "empty" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => successResponse("  ")),
    }
  );
  assert.equal(empty.code, "invalid_response");

  const oversized = await runSafeChat(
    { prompt: "large" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => successResponse("x".repeat(1001))),
    }
  );
  assert.equal(oversized.code, "output_too_large");
  assert.equal("answer" in oversized, false);

  const unsafeOutput = await runSafeChat(
    { prompt: "safe prompt" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() =>
        successResponse(`Accidental credential: ${fakeApiAssignment}`)
      ),
    }
  );
  assert.equal(unsafeOutput.code, "unsafe_output");
  assert(!JSON.stringify(unsafeOutput).includes("provider-secret"));

  const providerErrors = [
    {
      error: Object.assign(new Error("insufficient_quota secret diagnostics"), { status: 429 }),
      code: "provider_quota",
      retryable: false,
    },
    {
      error: Object.assign(new Error("insufficient_quota but authentication failed"), { status: 401 }),
      code: "provider_auth",
      retryable: false,
    },
    {
      error: Object.assign(new Error("payment required"), { status: 402 }),
      code: "provider_quota",
      retryable: false,
    },
    {
      error: Object.assign(new Error("rate_limit reached"), { status: 429 }),
      code: "provider_rate_limited",
      retryable: true,
    },
    {
      error: Object.assign(new Error("provider overloaded"), { status: 503 }),
      code: "provider_capacity",
      retryable: true,
    },
    {
      error: Object.assign(new Error("invalid_api_key provider-secret"), { status: 401 }),
      code: "provider_auth",
      retryable: false,
    },
    {
      error: Object.assign(new Error("internal provider diagnostics"), { status: 500 }),
      code: "upstream_error",
      retryable: true,
    },
  ];
  for (const expected of providerErrors) {
    const result = await runSafeChat(
      { prompt: "provider failure" },
      {
        env: enabledEnv,
        clientFactory: fakeClientFactory(() => {
          throw expected.error;
        }),
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, expected.code);
    assert.equal(result.retryable, expected.retryable);
    assert(!JSON.stringify(result).includes("diagnostics"));
    assert(!JSON.stringify(result).includes("provider-secret"));
  }

  const primitiveFailure = await runSafeChat(
    { prompt: "primitive provider failure" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => {
        throw "private primitive provider diagnostic";
      }),
    }
  );
  assert.equal(primitiveFailure.code, "upstream_error");
  assert(!JSON.stringify(primitiveFailure).includes("primitive provider diagnostic"));

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  let preCancelledFactoryCalls = 0;
  const preCancelledController = new AbortController();
  preCancelledController.abort(new Error("PRIVATE_PRE_CANCEL_DIAGNOSTIC"));
  const preCancelled = await runSafeChat(
    { prompt: "must not start" },
    {
      env: enabledEnv,
      abortSignal: preCancelledController.signal,
      clientFactory: () => {
        preCancelledFactoryCalls += 1;
        throw new Error("must not run");
      },
    }
  );
  assert.equal(preCancelled.code, "cancelled");
  assert.equal(preCancelled.status, 499);
  assert.equal(preCancelled.retryable, false);
  assert.equal(Object.isFrozen(preCancelled), true);
  assert.equal(preCancelledFactoryCalls, 0);
  assert(!JSON.stringify(preCancelled).includes("PRIVATE_PRE_CANCEL_DIAGNOSTIC"));

  let cancellationStarted;
  const cancellationStartedPromise = new Promise((resolve) => {
    cancellationStarted = resolve;
  });
  let upstreamCancellationSignal = null;
  const cancellationController = new AbortController();
  const cancellingRun = runSafeChat(
    { prompt: "cancel active request" },
    {
      env: enabledEnv,
      abortSignal: cancellationController.signal,
      clientFactory: fakeClientFactory(
        (_payload, options) =>
          new Promise((_, reject) => {
            upstreamCancellationSignal = options.signal;
            cancellationStarted();
            options.signal.addEventListener(
              "abort",
              () => {
                setImmediate(() => reject(new Error("PRIVATE_LATE_ABORT_DIAGNOSTIC")));
              },
              { once: true }
            );
          })
      ),
    }
  );
  await cancellationStartedPromise;
  cancellationController.abort(new Error("PRIVATE_PARENT_ABORT_DIAGNOSTIC"));
  const cancelled = await cancellingRun;
  assert.equal(cancelled.code, "cancelled");
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.retryable, false);
  assert.equal(Object.isFrozen(cancelled), true);
  assert.equal(upstreamCancellationSignal?.aborted, true);
  assert(!JSON.stringify(cancelled).includes("PRIVATE_PARENT_ABORT_DIAGNOSTIC"));
  assert(!JSON.stringify(cancelled).includes("PRIVATE_LATE_ABORT_DIAGNOSTIC"));

  const timeout = await runSafeChat(
    { prompt: "timeout" },
    {
      env: { ...enabledEnv, AGINTI_SAFE_CHAT_TIMEOUT_MS: "100" },
      clientFactory: fakeClientFactory(
        (_payload, options) =>
          new Promise((_, reject) => {
            options.signal.addEventListener(
              "abort",
              () => {
                setImmediate(() => reject(new Error("PRIVATE_LATE_TIMEOUT_DIAGNOSTIC")));
              },
              { once: true }
            );
          })
      ),
    }
  );
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.retryable, true);
  assert(!JSON.stringify(timeout).includes("PRIVATE_LATE_TIMEOUT_DIAGNOSTIC"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);

  let releaseBlocked;
  const blockedRequest = new Promise((resolve) => {
    releaseBlocked = resolve;
  });
  const first = runSafeChat(
    { prompt: "first" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => blockedRequest),
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runSafeChat(
    { prompt: "second" },
    {
      env: enabledEnv,
      clientFactory: fakeClientFactory(() => successResponse("must not run")),
    }
  );
  assert.equal(second.code, "busy");
  assert.equal(second.status, 429);
  releaseBlocked(successResponse("first complete"));
  assert.equal((await first).ok, true);
}

async function serverChecks() {
  assert.throws(
    () => createSafeChatHttpServer({ env: enabledEnv, bearerToken: "" }),
    /requires.*bearer token/i
  );
  assert.throws(
    () => createSafeChatHttpServer({ env: enabledEnv, bearerToken: "too-short" }),
    /at least 24/i
  );
  assert.throws(
    () => createSafeChatHttpServer({ env: enabledEnv, bearerToken, host: "0.0.0.0" }),
    /loopback-only/i
  );

  const capture = {};
  let disconnectStarted;
  const disconnectStartedPromise = new Promise((resolve) => {
    disconnectStarted = resolve;
  });
  let disconnectUpstreamSignal = null;
  let disconnectObserved;
  const disconnectObservedPromise = new Promise((resolve) => {
    disconnectObserved = resolve;
  });
  const created = createSafeChatHttpServer({
    env: enabledEnv,
    bearerToken,
    maxBodyBytes: 1024,
    clientFactory: fakeClientFactory((payload, options) => {
      if (payload.messages.at(-1)?.content === "force upstream error") {
        throw Object.assign(new Error("PRIVATE_UPSTREAM_DIAGNOSTIC provider-secret"), { status: 500 });
      }
      if (payload.messages.at(-1)?.content === "disconnect me") {
        return new Promise((_, reject) => {
          disconnectUpstreamSignal = options.signal;
          disconnectStarted();
          options.signal.addEventListener(
            "abort",
            () => {
              disconnectObserved();
              setImmediate(() => reject(new Error("PRIVATE_DISCONNECT_DIAGNOSTIC")));
            },
            { once: true }
          );
        });
      }
      return successResponse("HTTP safe answer.");
    }, capture),
  });
  await new Promise((resolve, reject) => {
    created.server.once("error", reject);
    created.server.listen(0, "127.0.0.1", resolve);
  });
  const address = created.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authorization = { Authorization: `Bearer ${bearerToken}` };

  async function fetchJson(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, options);
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  try {
    const unauthorized = await fetchJson("/health");
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.code, "unauthorized");

    const wrongToken = await fetchJson("/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongToken.response.status, 401);

    const health = await fetchJson("/health", { headers: authorization });
    assert.equal(health.response.status, 200);
    assert.equal(health.body.service, "aginti-safe-chat");

    const ready = await fetchJson("/ready", { headers: authorization });
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.available, true);
    assert.equal(ready.body.modelExposed, false);

    const status = await fetchJson("/v1/chat/status", { headers: authorization });
    assert.equal(status.response.status, 200);
    const serializedStatus = JSON.stringify(status.body);
    assert(!serializedStatus.includes(providerKey));
    assert(!serializedStatus.includes(providerModel));
    assert(!serializedStatus.includes(providerBaseUrl));
    assert(!serializedStatus.includes(bearerToken));

    const completed = await fetchJson("/v1/chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello over HTTP", locale: "en" }),
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.answer, "HTTP safe answer.");
    assert.equal("model" in completed.body, false);
    assert.equal("provider" in completed.body, false);
    assert.equal("tools" in capture.payload, false);

    const alias = await fetchJson("/api/safe-chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello alias" }),
    });
    assert.equal(alias.response.status, 200);

    const forbidden = await fetchJson("/v1/chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", provider: "client-controlled" }),
    });
    assert.equal(forbidden.response.status, 400);
    assert.equal(forbidden.body.code, "invalid_request");

    const missingContentType = await fetchJson("/v1/chat", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(missingContentType.response.status, 415);
    assert.equal(missingContentType.body.code, "invalid_request");

    const malformed = await fetchJson("/v1/chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: "{bad-json",
    });
    assert.equal(malformed.response.status, 400);

    const oversized = await fetchJson("/v1/chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(1200) }),
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.code, "invalid_request");

    const upstream = await fetchJson("/v1/chat", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "force upstream error" }),
    });
    assert.equal(upstream.response.status, 502);
    assert.equal(upstream.body.code, "upstream_error");
    assert(!JSON.stringify(upstream.body).includes("PRIVATE_UPSTREAM_DIAGNOSTIC"));
    assert(!JSON.stringify(upstream.body).includes("provider-secret"));

    const disconnectUnhandled = [];
    const onDisconnectUnhandled = (reason) => disconnectUnhandled.push(reason);
    process.on("unhandledRejection", onDisconnectUnhandled);
    const disconnectRequest = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/chat",
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
    });
    disconnectRequest.on("error", () => {
      // The caller intentionally disconnects before a response is available.
    });
    disconnectRequest.end(JSON.stringify({ prompt: "disconnect me" }));
    await disconnectStartedPromise;
    disconnectRequest.destroy();
    let disconnectTimer;
    await Promise.race([
      disconnectObservedPromise,
      new Promise((_, reject) => {
        disconnectTimer = setTimeout(
          () => reject(new Error("HTTP disconnect did not abort the upstream request.")),
          1000
        );
      }),
    ]);
    clearTimeout(disconnectTimer);
    assert.equal(disconnectUpstreamSignal?.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.removeListener("unhandledRejection", onDisconnectUnhandled);
    assert.deepEqual(disconnectUnhandled, []);
    assert.equal(getSafeChatStatus(enabledEnv).running, 0);

    const studio = await fetchJson("/api/config", { headers: authorization });
    assert.equal(studio.response.status, 404);
    assert.equal(studio.body.code, "not_found");
  } finally {
    await new Promise((resolve) => created.server.close(resolve));
  }
}

await sourceBoundaryChecks();
await wrapperChecks();
await serverChecks();
console.log("safe chat wrapper and authenticated loopback server smoke passed");
