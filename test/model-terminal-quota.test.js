import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { createChatCompletion, isTransientProviderRequestError, shouldRetryWithTextToolProtocol } = await import(pathToFileURL(path.join(runtime, "src/model-client.js")));
const { createModelHttpClient, MAX_MODEL_HTTP_RESPONSE_BYTES } = await import(pathToFileURL(path.join(runtime, "src/model-http-client.js")));

const payload = { model: "offline-model", messages: [{ role: "user", content: "Continue the saved task." }] };
const config = { provider: "deepseek", modelTimeoutMs: 2000 };
const hardCodes = ["insufficient_quota", "insufficient_balance", "billing_hard_limit_reached", "quota_exceeded"];

for (const field of ["code", "type"]) for (const code of hardCodes) {
  test(`explicit 429 ${field}=${code} is terminal before SDK and core retries`, { timeout: 4000 }, async () => {
    let requests = 0;
    const body = { error: { message: "Quota is exhausted.", [field]: code } };
    const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
      requests++;
      return new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1", "x-should-retry": "true", "x-request-id": "kept-request-id" } });
    } });
    await assert.rejects(createChatCompletion(client, payload, config), error => {
      assert.equal(error.status, 429); assert.equal(error.error[field], code);
      assert.equal(error.headers.get("x-request-id"), "kept-request-id");
      assert.equal(isTransientProviderRequestError(error), false);
      assert.equal(shouldRetryWithTextToolProtocol(error, { provider: "localllm" }), false);
      return true;
    });
    assert.equal(requests, 1);
  });
}

for (const body of [{ error: { message: "Payment required." } }, { error: { message: "Connection reset; unsupported reasoning_effort", code: "insufficient_balance" } }]) {
  test(`HTTP402 stays terminal despite misleading retry/compatibility hints: ${body.error.code || "no code"}`, { timeout: 4000 }, async () => {
    let requests = 0;
    const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
      requests++; return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "retry-after-ms": "1", "x-should-retry": "true" } });
    } });
    await assert.rejects(createChatCompletion(client, payload, { ...config, reasoning: "high" }), error => {
      assert.equal(error.status, 402); assert.equal(isTransientProviderRequestError(error), false); return true;
    });
    assert.equal(requests, 1);
  });
}

test("quota authority wins over free-text reasoning and tool compatibility hints", async () => {
  const error = Object.assign(new Error("Unsupported reasoning_effort; tools invalid; connection reset"), { status: 429, code: "insufficient_quota" });
  let requests = 0;
  await assert.rejects(createChatCompletion({ chat: { completions: { create() { requests++; throw error; } } } }, payload, { ...config, reasoning: "high" }), e => e === error);
  assert.equal(requests, 1); assert.equal(isTransientProviderRequestError(error), false);
  assert.equal(shouldRetryWithTextToolProtocol(error, { provider: "localllm" }), false);
});

for (const [label, status, body] of [
  ["ordinary rate limit", 429, { error: { message: "Too many requests", code: "rate_limit_exceeded" } }],
  ["quota word in prose only", 429, { error: { message: "The sample mentions insufficient_quota; current limit is transient", code: "rate_limit_exceeded" } }],
  ["unclassified rate limit", 429, { error: { message: "Try again shortly" } }],
  ["server failure with unrelated quota field", 500, { error: { message: "Unavailable", code: "insufficient_quota" } }],
]) test(`${label} retains existing bounded SDK retry and core transient classification`, { timeout: 4000 }, async () => {
  let requests = 0;
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
    requests++; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
  } });
  await assert.rejects(createChatCompletion(client, payload, config), error => error.status === status && isTransientProviderRequestError(error));
  assert.equal(requests, 3);
});

test("successful completion data mentioning quota never becomes a billing error", async () => {
  let requests = 0;
  const answer = { choices: [{ finish_reason: "stop", message: { content: "The supplied example contains insufficient_quota." } }] };
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => { requests++; return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(await createChatCompletion(client, payload, config), answer); assert.equal(requests, 1);
});

for (const body of [null, "Payment required; the account must be replenished."]) test(`HTTP402 ${body === null ? "bodyless" : "plain text"} refusal cannot be made retryable by a header`, async () => {
  let requests = 0;
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
    requests++; return new Response(body, { status: 402, headers: { "x-should-retry": "true", "retry-after-ms": "1" } });
  } });
  await assert.rejects(createChatCompletion(client, payload, config), e => e.status === 402); assert.equal(requests, 1);
});

for (const status of [402, 429]) test(`terminal ${status} policy reads data descriptors without message/proxy hooks`, () => {
  let hooks = 0;
  const error = Object.create(Error.prototype, {
    status: { value: status }, code: { value: "insufficient_quota" },
    message: { get() { hooks++; throw new Error("Untrusted getter"); } },
    error: { value: new Proxy({}, { get() { hooks++; throw new Error("Untrusted proxy"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("Untrusted proxy"); } }) },
  });
  assert.equal(isTransientProviderRequestError(error), false);
  assert.equal(shouldRetryWithTextToolProtocol(error, { provider: "localllm" }), false); assert.equal(hooks, 0);
});

test("canonical quota codes are case-insensitive without accepting prose", async () => {
  let requests = 0;
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
    requests++; return new Response('{"error":{"code":"INSUFFICIENT_QUOTA"}}', { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
  } });
  await assert.rejects(createChatCompletion(client, payload, config), e => e.status === 429 && !isTransientProviderRequestError(e)); assert.equal(requests, 1);
});

test("quota inspection cannot bypass the existing decoded response bound", async () => {
  let requests = 0, cancelled = 0;
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
    requests++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429, headers: { "content-length": String(MAX_MODEL_HTTP_RESPONSE_BYTES + 1), "content-type": "application/json", "x-should-retry": "true" } });
  } });
  await assert.rejects(createChatCompletion(client, payload, config), e => e.status === 413 && e.code === "MODEL_RESPONSE_TOO_LARGE"); assert.equal(requests, 1); assert.equal(cancelled, 1);
});

test("malformed unclassified 429 body keeps its bounded rate-limit policy", async () => {
  let requests = 0;
  const client = createModelHttpClient({ apiKey: "synthetic-quota-key", baseURL: "https://offline.invalid/v1", fetch: async () => {
    requests++; return new Response('insufficient_quota is only malformed diagnostic text', { status: 429, headers: { "retry-after-ms": "1" } });
  } });
  await assert.rejects(createChatCompletion(client, payload, config), e => e.status === 429 && isTransientProviderRequestError(e)); assert.equal(requests, 3);
});

const fixture = fileURLToPath(new URL("./fixtures/native-terminal-quota.js", import.meta.url));
const brief = "# Brief\n\nLatency fell from 120 ms to 90 ms in the supplied test (12 samples). Independent review is pending.\n";
const checklist = "# Checklist\n\n- [ ] Obtain the independent review.\n";
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
for (const [status, field] of [[429, "code"], [429, "type"], [402, "code"]]) {
  test(`native persisted ${status}/${field} failure preserves first artifact and explicit model continuation`, { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-terminal-quota-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(root + "/workspace");
    const input = "Latency fell from 120 ms to 90 ms across 12 samples. Independent review is still pending.\n";
    await fs.writeFile(root + "/workspace/measurement.txt", input);
    let phase = "start", turns = 0, quotaResponses = 0; const errors = [];
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks));
        let message;
        if (!body.tools) message = { content: "1. Read the source.\n2. Write brief.md.\n3. Write checklist.md." };
        else if (phase === "start" && turns++ === 0) message = { tool_calls: [call("read_file", { path: "measurement.txt" }, "read_measurement")] };
        else if (phase === "start" && turns === 2) message = { tool_calls: [call("write_file", { path: "brief.md", content: brief }, "write_verified_brief")] };
        else if (phase === "start") {
          quotaResponses++; res.writeHead(status, { "content-type": "application/json", "retry-after-ms": "1" });
          res.end(JSON.stringify({ error: { message: status === 429 && field === "code" ? "Explicit account quota exhausted; model request timed out after 100ms" : "Explicit account quota exhausted", [field]: "insufficient_quota" } })); return;
        } else if (turns++ === 0) {
          assert.equal(body.model, "deepseek-flash");
          assert.ok(JSON.stringify(body.messages).includes("brief.md"), "Continuation lost confirmed artifact context");
          message = { tool_calls: [call("write_file", { path: "checklist.md", content: checklist }, "write_remaining_checklist")] };
        } else message = { tool_calls: [call("finish", { result: "brief.md and checklist.md are ready; the source remains unchanged." }, "finish_remaining_work")] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, reasoning_content: "Use retained verified work and complete only the remaining artifact.", ...message } }] }));
      } catch (error) { errors.push(error.message); res.writeHead(400); res.end('{"error":{"message":"Offline fixture rejected request"}}'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    async function run() {
      const child = spawn(process.execPath, [fixture, root, `http://127.0.0.1:${server.address().port}/v1`, phase], { env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", AGINTIFLOW_HOME: root + "/home", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", expired = false;
      child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 12000);
        child.once("error", e => { clearTimeout(timer); reject(e); });
        child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, expired }); });
      });
      assert.equal(result.expired, false, JSON.stringify(result)); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
    }
    const first = await run(); assert.equal(first.resolved, false); assert.equal(quotaResponses, 1); assert.deepEqual(errors, []);
    const load = async () => ({ state: JSON.parse(await fs.readFile(root + "/home/sessions/terminal-quota/state.json")), events: (await fs.readFile(root + "/home/sessions/terminal-quota/events.jsonl", "utf8")).trim().split("\n").map(JSON.parse) });
    const before = await load(); assert.equal(before.events.some(e => e.type === "history.compacted_for_model_retry"), false);
    assert.ok(before.state.messages.some(m => m.role === "tool" && m.tool_call_id === "write_verified_brief" && JSON.parse(m.content).ok === true));
    assert.equal(before.events.filter(e => e.type === "session.finished").length, 0);
    assert.equal(await fs.readFile(root + "/workspace/brief.md", "utf8"), brief); await assert.rejects(fs.stat(root + "/workspace/checklist.md"), { code: "ENOENT" });
    const eventCount = before.events.length; phase = "resume"; turns = 0;
    const second = await run(); assert.equal(second.resolved, true); assert.notEqual(second.result.stopped, true); assert.notEqual(second.result.failed, true); assert.equal(second.result.sessionId, "terminal-quota"); assert.match(second.result.result, /brief\.md.*checklist\.md/); assert.deepEqual(errors, []);
    const after = await load(); assert.equal(after.state.meta.runtimeConfig.revision, 2); assert.equal(after.state.meta.runtimeConfig.model, "deepseek-flash");
    assert.equal(await fs.readFile(root + "/workspace/measurement.txt", "utf8"), input);
    assert.equal(await fs.readFile(root + "/workspace/brief.md", "utf8"), brief); assert.equal(await fs.readFile(root + "/workspace/checklist.md", "utf8"), checklist);
    assert.equal(after.events.slice(eventCount).filter(e => e.type === "tool.started" && e.data.toolName === "write_file" && e.data.args.path === "brief.md").length, 0);
    assert.equal(after.events.filter(e => e.type === "session.finished").length, 1);
  });
}
