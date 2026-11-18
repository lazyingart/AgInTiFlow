import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Only the wire peer is scripted. File reads, patch publication and the
// session journal all go through the two real CLI processes.
globalThis.fetch = async (url, options) => {
  const endpoint = new URL(url);
  assert.equal(endpoint.origin, "https://api.openai.com");
  const request = JSON.parse(options.body);
  if (endpoint.pathname === "/v1/chat/completions") {
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      role: "assistant", content: "Read the file, correct the typo and verify the result." } }] });
  }
  assert.equal(endpoint.pathname, "/v1/responses");
  const results = request.input.filter(i => i.type === "function_call_output").map(i => JSON.parse(i.output));
  const lastRead = results.filter(r => r.toolName === "read_file" && r.ok).at(-1);
  let name = "read_file", args = { path: "cut.srt" }, id = "initial_read";
  if (lastRead && !results.some(r => r.toolName === "apply_patch" && r.ok)) {
    name = "apply_patch";
    args = { path: "cut.srt", search: "old brigde", replace: "old bridge" };
    id = "exact_edit";
  } else if (lastRead && process.env.TEST_INTERRUPT_AFTER_PATCH === "1") {
    await fs.appendFile(process.env.TEST_EDIT_TRACE, "checkpoint\n");
    process.kill(process.pid, "SIGKILL");
  } else if (lastRead?.content.includes("old bridge")) {
    name = "finish";
    args = { result: "Corrected old brigde to old bridge in cut.srt and verified the saved text." };
    id = "finish_edit";
  } else if (lastRead) {
    id = "verify_edit";
  }
  assert.ok(request.tools.some(t => t.name === name));
  await fs.appendFile(process.env.TEST_EDIT_TRACE, id + "\n");
  return Response.json({ model: request.model, object: "response", status: "completed", store: false, output: [{
    type: "function_call", name, id: "fc_" + id, call_id: id, status: "completed", arguments: JSON.stringify(args),
  }] });
};
