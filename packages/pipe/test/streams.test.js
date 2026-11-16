import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { streams, base, final, call, tool, frame, until, gate, bounded } from "./harness.js";

function setup(complete, options = {}, output) {
  const input = new PassThrough();const bytes = [];
  output ??= new Writable({ write(chunk, _encoding, callback) { bytes.push(Buffer.from(chunk));callback(); } });
  const server = streams.serveRestrictedApplicationPipe({ input, output, ...base(complete, options) });
  return { server, input, output, frames: () => Buffer.concat(bytes).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

test("strict UTF8 JSONL accepts split multibyte bytes, returns result, and closes without listeners", async () => {
  const { server, input, output, frames } = setup(async () => final("中文 correction proposed"));
  await server.ready;const ready = frames()[0];
  const bytes = Buffer.from(JSON.stringify({ ...frame({ ready }, "run", undefined, { request: { input: [{ type: "text", text: "改一下 wording" }] } }) }) + "\n");
  const at = bytes.indexOf(Buffer.from("改"));input.write(bytes.subarray(0, at + 1));input.write(bytes.subarray(at + 1));
  await until(() => frames().some(f => f.type === "result"));
  input.end();await bounded(server.done);
  assert.equal(frames().at(-1).result.proposal.reply, "中文 correction proposed");
  assert.equal(input.destroyed, true);assert.equal(output.destroyed, true);
  assert.equal(output.listenerCount("error"), 0);assert.equal(output.listenerCount("close"), 0);
});

for (const [name, bytes] of [
  ["duplicate key", Buffer.from('{"type":"run","type":"cancel"}\n')],
  ["bad UTF8", Buffer.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125, 10])],
  ["blank line", Buffer.from("\n")], ["CRLF", Buffer.from("{}\r\n")],
  ["truncated frame", Buffer.from('{"schemaVersion":1')],
  ["UTF8 byte overflow", Buffer.from("中".repeat(90_000) + "\n")],
]) test(`${name} fails closed before provider dispatch and emits no forged terminal`, async () => {
  let calls = 0;const { server, input, frames } = setup(async () => { calls++;return final(); });
  await server.ready;input.end(bytes);await assert.rejects(bounded(server.done));
  assert.equal(calls, 0);assert.deepEqual(frames().map(f => f.type), ["ready"]);assert.equal(server.inspect().closed, true);
});

test("EOF while a read is active cancels local callback without a synthetic success/error", async () => {
  const { server, input, frames } = setup(async () => call(), { tools: [tool] });
  await server.ready;const ready = frames()[0];
  input.write(JSON.stringify(frame({ ready }, "run", undefined, { request: { input: [{ type: "text", text: "read my draft" }] } })) + "\n");
  await until(() => frames().some(f => f.type === "read"));input.end();
  await bounded(server.done);assert.equal(frames().some(f => ["result", "error"].includes(f.type)), false);
  assert.equal(server.inspect().pendingReads, 0);assert.equal(server.inspect().activeRuns, 0);
});

test("a blocked output is bounded, provider is not released before accepted is flushed", async () => {
  let writes = 0, calls = 0;let ready;
  const output = new Writable({ write(chunk, _encoding, callback) { if (++writes === 1) { ready = JSON.parse(chunk.toString());callback(); } } });
  const { server, input } = setup(async () => { calls++;return final(); }, {}, output);
  await server.ready;
  input.write(JSON.stringify(frame({ ready }, "run", undefined, { request: { input: [{ type: "text", text: "Help me" }] } })) + "\n");
  await assert.rejects(bounded(server.done, 4000));assert.equal(calls, 0);assert.equal(output.destroyed, true);
});

test("close aborts an admitted blocked write and leaves no local listeners/timers", async () => {
  let entered = 0;const output = new Writable({ write(_chunk, _encoding, _callback) { entered++; } });
  const { server, input } = setup(async () => final(), {}, output);
  assert.equal(entered, 1);const closing = server.close();
  await Promise.allSettled([server.ready, server.done]);
  await assert.rejects(closing);assert.equal(input.destroyed, true);assert.equal(output.destroyed, true);
  assert.equal(output.listenerCount("error"), 0);assert.equal(output.listenerCount("close"), 0);
});

test("write failure leaks no error text and never dispatches model or tools", async () => {
  let calls = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("private_output_failure_marker")); } });
  const { server } = setup(async () => { calls++;return final(); }, {}, output);
  await assert.rejects(server.done, error => !error.message.includes("private_output_failure_marker"));assert.equal(calls, 0);
});
