// Offline provider for the machine CLI test. Record only persisted read replies.
import assert from "node:assert/strict";
import fs from "node:fs/promises";

globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, "https://api.deepseek.com");
  assert.ok(url.pathname.endsWith("/chat/completions"));
  const request = JSON.parse(options.body);
  const reads = request.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content))
    .filter(r => r.toolName === "read_file");
  const offered = (request.tools || []).map(t => t.function.name);
  await fs.appendFile(process.env.READ_WINDOW_TRACE, JSON.stringify({ model: request.model, reads, offered }) + "\n");
  if (!offered.length) return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: {
    role: "assistant", content: "1. Read the requested portion of handoff.txt.\n2. Report the excerpt.",
  } }] });
  const mode = process.env.READ_WINDOW_MODE;
  assert.ok(["suffix", "past-eof"].includes(mode));
  const selected = mode === "suffix" ? 4 : 6;
  const resultText = reads.at(-1)?.content;
  const name = reads.length ? "finish" : "read_file";
  assert.ok(offered.includes(name));
  const args = name === "read_file" ? { path: "handoff.txt", startLine: selected } :
    { result: resultText ? "The saved excerpt says: " + resultText : "The saved read reached EOF and contained no lines." };
  return Response.json({ choices: [{ index: 0, finish_reason: "tool_calls", message: {
    role: "assistant", content: null, reasoning_content: "Report the requested excerpt.",
    tool_calls: [{ index: 0, id: name + "_window", type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } }] });
};
