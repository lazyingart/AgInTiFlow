import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Exercise the real CLI and its tool dispatcher; only the provider is scripted.
globalThis.fetch = async (url, options) => {
  const endpoint = new URL(url);
  assert.equal(endpoint.origin, "https://api.openai.com");
  const body = JSON.parse(options.body);
  if (endpoint.pathname === "/v1/chat/completions") {
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      role: "assistant", content: "Read the local review note and share its checklist." } }] });
  }
  assert.equal(endpoint.pathname, "/v1/responses");
  const tools = body.tools.map(tool => tool.name);
  const replies = body.input.filter(item => item.type === "function_call_output").map(item => JSON.parse(item.output));
  const read = replies.find(item => item.toolName === "read_file" && item.ok);
  let name, args;
  if (process.env.TEST_LAST_STEP === "1") {
    assert.ok(!tools.includes("expand_tool_menu") && tools.includes("send_to_canvas"));
    name = "finish"; args = { result: "CHECK" };
  } else if (!read) {
    assert.ok(!tools.includes("send_to_canvas"));
    name = "read_file"; args = { path: "review.txt" };
  } else if (!replies.some(item => item.toolName === "expand_tool_menu" && item.ok)) {
    const menu = body.tools.find(tool => tool.name === "expand_tool_menu");
    assert.match(menu.description, /\bsend_to_canvas\b/);
    name = "expand_tool_menu"; args = {};
  } else if (!replies.some(item => item.toolName === "send_to_canvas" && item.ok)) {
    assert.ok(!tools.includes("expand_tool_menu"));
    name = "send_to_canvas"; args = { title: "Review", kind: "text", content: read.content.trim() };
  } else {
    name = "finish"; args = { result: "Shared the review checklist." };
  }
  assert.ok(tools.includes(name));
  assert.ok(!tools.includes("run_command"));
  await fs.appendFile(process.env.TEST_DISCLOSURE_TRACE, JSON.stringify({ name, tools: tools.length }) + "\n");
  return Response.json({ model: body.model, object: "response", status: "completed", store: false, output: [{
    type: "function_call", name, id: "fc_" + name, call_id: name, status: "completed", arguments: JSON.stringify(args),
  }] });
};
