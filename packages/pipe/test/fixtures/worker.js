// Explicit offline test bootstrap. Never part of the distributable package.
const { serveRestrictedApplicationPipe } = await import(process.argv[2]);
const { createRestrictedDeepSeekProvider } = await import(process.argv[3]);
const str = { type: "string", maxLength: 2000 };
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const provider = createRestrictedDeepSeekProvider({ model: "deepseek-flash", complete: async request => {
  const read = request.messages.findLast(message => message.role === "tool");
  if (!read) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
    { id: "raw_provider_call_id", type: "function", function: { name: "draft_read", arguments: '{"query":"draft"}' } },
  ] } }] };
  const evidence = JSON.parse(read.content);
  const proposal = { reply: "Correction proposed, not saved.", text: evidence.text.replace("teh", "the"), revision: evidence.revision };
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) } }] };
} });
const server = serveRestrictedApplicationPipe({ input: process.stdin, output: process.stdout, scopeId: "account_python_0001", provider,
  instructions: "Read only the authenticated account draft. Propose the corrected text and expected revision; never save.",
  outputSchema: object({ reply: str, text: str, revision: { type: "integer", minimum: 1 } }),
  tools: [{ name: "draft_read", description: "Read the authenticated account draft.", inputSchema: object({ query: str }), outputSchema: object({ text: str, revision: { type: "integer", minimum: 1 } }) }],
});
try { await server.done; } catch { process.exitCode = 1; }
