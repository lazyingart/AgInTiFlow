import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createChatCompletion } from "../src/model-client.js";

const model = "gpt-6.1-sol", config = { provider: "openai", sessionId: "unit", reasoning: "medium" };
const body = { model, messages: [{ role: "user", content: "Read the handoff." }],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }], max_tokens: 512 };
const call = { type: "function_call", id: "fc_one", call_id: "call_one", status: "completed", name: "read_file", arguments: '{"path":"a"}' };
const wrap = output => ({ object: "response", model, status: "completed", store: false, output });
const text = content => ({ type: "message", id: "msg_one", role: "assistant", status: "completed", content: [{ type: "output_text", text: content }] });
const send = (payload, result, inspect = () => {}) => createChatCompletion({ responses: { create: async (wire, options) => {
  inspect(wire, options); return result;
} } }, payload, config);

test("native Responses keeps tool selection, token ceilings, reasoning effort and usage", async () => {
  const reply = await send({ ...body, tool_choice: { type: "function", function: { name: "read_file" } } },
    { ...wrap([call]), usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } }, (wire, options) => {
      assert.equal(wire.max_output_tokens, 512);
      assert.deepEqual(wire.tool_choice, { type: "function", name: "read_file" });
      assert.equal(wire.reasoning.effort, "medium");
      assert.equal(wire.previous_response_id, undefined);
      assert.deepEqual(wire.include, ["reasoning.encrypted_content"]);
      assert.equal(options.maxRetries, 0);
    });
  assert.deepEqual(reply.choices[0].message.tool_calls[0].function, { name: call.name, arguments: call.arguments });
  assert.equal(reply.usage.total_tokens, 100);
});

test("incomplete, refused, hosted, ambiguous or textual tool returns cannot authorize a native action", async () => {
  for (const response of [ { ...wrap([call]), status: "incomplete" }, { ...wrap([call]), model: "another-model" },
    wrap([call, call]), wrap([{ ...call, status: undefined }]), wrap([{ ...call, name: "undeclared" }]), wrap([{ ...call, type: "web_search_call" }]),
    wrap([{ ...call, arguments: '{"path":1,"path":2}' }]), wrap([text('Requested tool: read_file')]),
    wrap([{ ...text("x"), content: [{ type: "refusal", refusal: "no" }] }]) ]) {
    await assert.rejects(send(body, response));
  }
  await assert.rejects(send({ ...body, tool_choice: "required" }, wrap([text("I will look")])));
  await assert.rejects(send({ ...body, tool_choice: "none" }, wrap([call])));
  const chat = await send(body, wrap([text("The saved review is complete.")]));
  assert.equal(chat.choices[0].message.content, "The saved review is complete.");
});

test("incomplete or ambiguous local call history fails before the request", async () => {
  let requests = 0;
  const assistant = { role: "assistant", content: null, tool_calls: [
    { type: "function", id: call.call_id, function: { name: call.name, arguments: call.arguments } }] };
  const tool = { role: "tool", tool_call_id: call.call_id, content: "{}" };
  for (const messages of [[tool], [assistant], [assistant, { ...tool, name: "other" }], [assistant, tool, assistant, tool]]) {
    await assert.rejects(send({ ...body, messages }, wrap([call]), () => { requests++; }));
  }
  assert.equal(requests, 0);
});

test("completed pairs cross sessions as fresh history without another session's encrypted item", async () => {
  const reasoning = { type: "reasoning", id: "rs_one", encrypted_content: "private-frame", summary: [] };
  const wires = [];
  const client = { responses: { create: async wire => {
    wires.push(wire);
    return wires.length === 1 ? wrap([reasoning, call]) : wrap([text("Done.")]);
  } } };
  const reply = await createChatCompletion(client, body, config);
  const message = reply.choices[0].message, tool = { role: "tool", tool_call_id: call.call_id, content: "exact read" };
  const next = { ...body, messages: [...body.messages, message, tool] };
  await createChatCompletion(client, next, config);
  assert.ok(wires[1].input.some(i => i.encrypted_content === "private-frame"));
  await assert.rejects(createChatCompletion(client, { ...next, messages: [...body.messages, {
    ...message, tool_calls: [{ ...message.tool_calls[0], function: { name: "read_file", arguments: '{}' } }] }, tool] }, config));
  await createChatCompletion(client, next, { ...config, resume: "other-session" });
  assert.ok(!JSON.stringify(wires[2]).includes("private-frame"));
  assert.deepEqual(wires[2].input.slice(-2), [{ type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments },
    { type: "function_call_output", call_id: call.call_id, output: "exact read" }]);
});

test("cancelled native Responses request cannot admit a late tool call or poison its retry", async () => {
  const abort = new AbortController();
  let delivered, count = 0;
  const client = { responses: { create: async () => {
    count++;
    if (count === 1) {
      abort.abort();
      await new Promise(resolve => { delivered = resolve; });
    }
    return wrap([call]);
  } } };
  await assert.rejects(createChatCompletion(client, body, { ...config, abortSignal: abort.signal }), { name: "AbortError" });
  delivered();
  await new Promise(resolve => setImmediate(resolve));
  const retry = await createChatCompletion(client, body, config);
  assert.equal(retry.choices[0].message.tool_calls[0].id, call.call_id);
  assert.equal(count, 2);
});

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/aginti-cli.js", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/native-openai-responses-provider.js", import.meta.url));
for (const crash of [false, true]) test("native CLI Sol read and finish" + (crash ? " after SIGKILL" : " in one process"), { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-sol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work"); await fs.mkdir(cwd);
  const expected = "Review the revised figure " + randomUUID() + ".";
  await fs.writeFile(path.join(cwd, "note.txt"), expected);
  const env = { HOME: root, PATH: process.env.PATH, AGINTIFLOW_HOME: path.join(root, "agent"),
    XDG_CONFIG_HOME: path.join(root, "config"), OPENAI_API_KEY: "synthetic-fixture", AGINTI_PROVIDER_HANDOFF: "0",
    AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_HOUSEKEEPING: "0",
    AGINTI_MAX_OUTPUT_TOKENS: "768", RESPONSES_TRACE: path.join(root, "trace") };
  const run = (args, extra) => {
    const result = exec(process.execPath, ["--import", provider, cli, ...args], { cwd, env: { ...env, ...extra }, timeout: 15000 });
    result.child.stdin.end();
    return result;
  };
  const start = ["run", "--json", "--session-id", "sol-read", "--provider", "openai", "--model", model, "--routing", "manual",
    "--profile", "code", "--no-scs", "--max-steps", "3", "--dynamic-steps", "off", "--sandbox-mode", "host", "--allow-file-tools",
    "--no-shell", "--no-web-search", "--no-mcp", "--no-wrappers", "--no-auxiliary-tools", "--no-parallel-scouts",
    "Read note.txt and tell me exactly what it says. Leave it unchanged."];
  let result;
  if (crash) {
    await assert.rejects(run(start, { INTERRUPT_READ: "1" }), { signal: "SIGKILL" });
    result = await run(["resume", "sol-read", "--json", "Continue from the saved read and report its contents."])
      .catch(error => { throw new Error(error.stdout || error.stderr || error.message, { cause: error }); });
  } else result = await run(start);
  assert.equal(JSON.parse(result.stdout).result, expected);
  const trace = (await fs.readFile(env.RESPONSES_TRACE, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(trace, [{ read: false, encrypted: false }, { read: true, encrypted: true },
    ...(crash ? [{ read: true, encrypted: false }] : [])]);
  const dir = path.join(env.AGINTIFLOW_HOME, "sessions", "sol-read");
  for (const file of ["state.json", "events.jsonl"]) assert.ok(!(await fs.readFile(path.join(dir, file), "utf8")).includes("opaque_test_marker"));
  assert.equal(await fs.readFile(path.join(cwd, "note.txt"), "utf8"), expected);
});
