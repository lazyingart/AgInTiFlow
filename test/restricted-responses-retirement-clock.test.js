import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { mock, test } from "node:test";

// Clock-order probe only. No real network, token, inference or TLS admission.
let now = 1_800_000_000_000, ticks = 1000, request, receive, constructions = 0;
const realNow = Date.now;
Date.now = () => now;
mock.module("node:perf_hooks", { namedExports: { performance: { now: () => ticks } } });
mock.module("node:https", { namedExports: { ...https,
  Agent: class { destroy() {} },
  request(_options, callback) {
    constructions++; receive = callback; request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => request.emit("close");
    return request;
  },
} });
const { createResponsesHttpTransport } = await import("../src/restricted-responses-http.js");
Date.now = realNow;
const schema = { type: "object", properties: { answer: { type: "string", maxLength: 80 } }, required: ["answer"], additionalProperties: false };
const input = { schemaVersion: "aginti-restricted-application-v1", messages: [
  { role: "system", content: "Return supplied text only." }, { role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [], outputSchema: schema, maxOutputTokens: 256 };

function finishResponse() {
  const text = '{"answer":"observed"}', part = { type: "output_text", text, annotations: [] };
  const item = { id: "msg_clock_one", type: "message", status: "completed", role: "assistant", content: [part] };
  const response = { id: "resp_clock_one", object: "response", model: "fixed-model", created_at: 1000, status: "in_progress",
    error: null, incomplete_details: null, store: false, tool_choice: "none", tools: [], output: [],
    reasoning: { effort: "low" }, text: { format: { type: "json_schema", name: "application_proposal", strict: true, schema } } };
  const scope = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [{ type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...scope, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...scope, delta: text },
    { type: "response.output_text.done", ...scope, text },
    { type: "response.content_part.done", ...scope, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", completed_at: 1001, output: [item] } }];
  const res = new EventEmitter(); res.statusCode = 200; res.complete = true;
  res.headers = { "content-type": "text/event-stream" }; res.rawHeaders = ["Content-Type", "text/event-stream"];
  res.destroy = () => res.emit("close"); receive(res);
  res.emit("data", Buffer.from(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("")));
  res.emit("end"); res.emit("close");
}

test("earlier authorization expiry at physical retirement remains authentication, not timeout", async () => {
  const client = createResponsesHttpTransport({ accessToken: "synthetic-clock-token", principalId: "opaque_principal_001",
    expiresAt: new Date(now + 200).toISOString(), model: "fixed-model", reasoningEffort: "low", timeoutMs: 500 },
  metadata => Object.assign(Error("safe provider failure"), { metadata }));
  try {
    const running = client.complete(input), result = assert.rejects(running, error => {
      assert.equal(error.metadata?.category, "authentication"); return true;
    });
    finishResponse(); now += 300; ticks += 300;
    request.emit("close"); await result; assert.equal(constructions, 1);
  } finally { await client.close(); }
});
