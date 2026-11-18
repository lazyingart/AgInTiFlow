import assert from "node:assert/strict";
import fs from "node:fs/promises";

globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, "https://api.openai.com");
  const request = JSON.parse(options.body);
  if (url.pathname === "/v1/chat/completions") {
    assert.equal(request.tools, undefined);
    assert.equal(request.max_completion_tokens, 768);
    return Response.json({ choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "1. Read note.txt.\n2. Report its contents unchanged." } }] });
  }
  assert.equal(url.pathname, "/v1/responses");
  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.parallel_tool_calls, false);
  const read = request.input.find(i => i.type === "function_call_output");
  const encrypted = request.input.some(i => i.type === "reasoning");
  await fs.appendFile(process.env.RESPONSES_TRACE, JSON.stringify({ read: Boolean(read), encrypted }) + "\n");
  if (read && process.env.INTERRUPT_READ === "1") process.kill(process.pid, "SIGKILL");
  const name = read ? "finish" : "read_file";
  assert.ok(request.tools.some(t => t.name === name && t.type === "function"));
  const args = read ? { result: JSON.parse(read.output).content } : { path: "note.txt" };
  return Response.json({ object: "response", model: request.model, status: "completed", store: false,
    output: [{ type: "reasoning", id: "rs_" + name, summary: [], encrypted_content: "opaque_test_marker" },
      { type: "function_call", id: "fc_" + name, call_id: "call_" + name, name, arguments: JSON.stringify(args), status: "completed" }] });
};
