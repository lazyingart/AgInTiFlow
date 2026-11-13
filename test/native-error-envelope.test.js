import assert from "node:assert/strict";
import test from "node:test";
import { createRestrictedApplicationRunner, createRestrictedOpenAIProvider, createRestrictedDeepSeekProvider } from "../src/restricted-application.js";

const string = { type: "string", minLength: 1, maxLength: 2000 };
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const schema = object({ reply: string });
const input = { input: [{ type: "text", text: "Read current evidence and give a bounded answer." }] };
const factory = (model, complete) => model === "generic-explicit"
  ? createRestrictedOpenAIProvider({ model, supportsImages: false, complete })
  : createRestrictedDeepSeekProvider({ model, complete });
const runner = (provider, execute) => createRestrictedApplicationRunner({ provider, instructions: "Read only supplied evidence; return a proposal.", outputSchema: schema,
  tools: [{ name: "record_read", description: "Read caller-owned evidence.", readOnly: true, inputSchema: object({ query: string }), outputSchema: schema, execute }] });

test("native error envelopes cannot authorize a final proposal or a declared read", async () => {
  for (const model of ["generic-explicit", "deepseek-flash", "deepseek-v4-pro"]) {
    for (const toolCall of [false, true]) {
      for (const mode of ["data", "hidden", "accessor"]) {
        for (const value of [{ code: "synthetic_failure", message: "PRIVATE_ERROR_DETAIL" }, null, undefined, false, 0, "", []]) {
          let requests = 0, reads = 0, getters = 0;
          const wire = { choices: [{ finish_reason: toolCall ? "tool_calls" : "stop", message: {
            role: "assistant", content: toolCall ? null : '{"reply":"must not complete"}',
            ...(toolCall ? { tool_calls: [{ id: "c1", type: "function", function: { name: "record_read", arguments: '{"query":"current"}' } }] } : {}),
          } }] };
          Object.defineProperty(wire, "error", mode === "accessor"
            ? { enumerable: true, get() { getters++; throw Error("PRIVATE_ERROR_DETAIL"); } }
            : { enumerable: mode === "data", value });
          const app = runner(factory(model, async () => { requests++; return wire; }), () => { reads++; return { reply: "observed" }; });
          await assert.rejects(app.run(input), error => {
            assert.equal(error.code, "PROVIDER_FAILED");
            assert.deepEqual(JSON.parse(JSON.stringify(error.providerFailure)), {
              schemaVersion: "aginti-provider-failure-v1", category: "protocol", retryAfterMs: null,
            });
            assert.equal(String(error).includes("PRIVATE_ERROR_DETAIL"), false);
            return true;
          });
          assert.equal(requests, 1); assert.equal(reads, 0); assert.equal(getters, 0);
        }
      }
    }
  }
});

test("ordinary native choices retain SDK metadata and exact one-read finalization", async () => {
  for (const model of ["generic-explicit", "deepseek-flash", "deepseek-v4-pro"]) {
    let requests = 0, reads = 0, getters = 0;
    const provider = factory(model, async () => {
      const wire = { choices: [{ finish_reason: ++requests === 1 ? "tool_calls" : "stop", message: {
        role: "assistant", content: requests === 1 ? null : '{"reply":"observed"}',
        ...(requests === 1 ? { tool_calls: [{ id: "c1", type: "function", function: { name: "record_read", arguments: '{"query":"current"}' } }] } : {}),
      } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      Object.defineProperty(wire, "_request_id", { value: "synthetic-request" });
      Object.defineProperty(wire, "metadata", { get() { getters++; throw Error("metadata is not read"); } });
      return wire;
    });
    const result = await runner(provider, () => { reads++; return { reply: "observed" }; }).run(input);
    assert.equal(result.proposal.reply, "observed"); assert.equal(result.usage.toolCalls, 1);
    assert.equal(requests, 2); assert.equal(reads, 1); assert.equal(getters, 0);
  }
});
