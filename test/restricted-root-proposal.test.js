import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider, createRestrictedOpenAIProvider } from "../src/restricted-application.js";
import { runRootProposalScenario } from "./fixtures/restricted-root-proposal.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string", minLength: 1, maxLength: 200 };
const list = { type: "array", items: string, minItems: 1, maxItems: 3 };
const input = { input: [{ type: "text", text: "Could you list both items, keep their order, no saves please." }] };
const plain = value => JSON.parse(JSON.stringify(value));
const completion = value => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] });
const kinds = ["openai", "deepseek-flash", "deepseek-v4-pro"];
const provider = (kind, complete) => kind === "openai"
  ? createRestrictedOpenAIProvider({ model: "qualified-model", supportsImages: false, complete })
  : createRestrictedDeepSeekProvider({ model: kind, complete });
const run = (kind, schema, complete, tools = []) => createRestrictedApplicationRunner({
  provider: provider(kind, complete), tools, instructions: "Return an uncommitted proposal from the supplied authorized evidence; never claim a save.",
  outputSchema: schema, limits: { maxSteps: 2, maxToolCalls: 2, maxCallsPerStep: 2 },
}).run(input);

function assertWireSchema(body, kind, expected) {
  if (kind === "openai") assert.deepEqual(plain(body.response_format.json_schema.schema), expected);
  else {
    assert.deepEqual(plain(body.response_format), { type: "json_object" });
    const text = body.messages.find(message => message.role === "system").content;
    const wireSchema = JSON.parse(text.split("FINAL_JSON_SCHEMA:\n").at(-1));
    assert.deepEqual(wireSchema, expected);
  }
}

test("array/scalar/union final schemas get one exact object wire envelope", async () => {
  const examples = [
    [list, ["first", "second"]], [string, "a short reply"], [{ type: "boolean" }, false],
    [{ type: "number", minimum: 0 }, 0], [{ type: "integer", maximum: 4 }, 4], [{ type: "null" }, null],
    [{ anyOf: [string, { type: "null" }] }, null],
    [{ anyOf: [object({ reply: string }), list] }, { reply: "union object" }],
    [{ anyOf: [object({ proposal: string }), list] }, { proposal: "literal nested property" }],
    [{ type: "array", items: { type: "boolean" }, maxItems: 0 }, []],
  ];
  for (const kind of kinds) for (const [schema, value] of examples) {
    let calls = 0;
    const result = await run(kind, schema, async body => {
      calls++;
      assertWireSchema(body, kind, object({ proposal: schema }));
      assert.match(body.messages[0].content, /final.*proposal|proposal.*final/i);
      return completion({ proposal: value });
    });
    assert.deepEqual(plain(result.proposal), value);
    assert.equal(result.usage.steps, 1); assert.equal(result.usage.toolCalls, 0); assert.equal(calls, 1);
  }
});

test("object-root wire and a literal proposal property remain unchanged", async () => {
  const schema = object({ proposal: string });
  for (const kind of kinds) {
    const result = await run(kind, schema, async body => {
      assertWireSchema(body, kind, schema);
      assert.doesNotMatch(body.messages[0].content, /For the final transport response/);
      return completion({ proposal: "this belongs to the application" });
    });
    assert.deepEqual(plain(result.proposal), { proposal: "this belongs to the application" });
  }
});

test("native read batches retain arguments/results and unwrap only the final list", async () => {
  for (const kind of kinds) {
    let steps = 0; const reads = [];
    const tool = { name: "read_item", description: "Read one authorized item.", readOnly: true,
      inputSchema: object({ id: { type: "integer", enum: [1, 2] } }), outputSchema: string,
      execute: async ({ id }) => { reads.push(id); return id === 1 ? "first" : "second"; } };
    const result = await run(kind, list, async body => {
      assertWireSchema(body, kind, object({ proposal: list }));
      if (++steps === 1) {
        assert.deepEqual(plain(body.tools[0].function.parameters), tool.inputSchema);
        return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [1, 2].map(id => ({ id: `item_${id}`, type: "function", function: { name: "read_item", arguments: JSON.stringify({ id }) } })) } }] };
      }
      assert(!Object.hasOwn(body, "tools"));
      assert.deepEqual(body.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content)), ["first", "second"]);
      return completion({ proposal: ["first", "second"] });
    }, [tool]);
    assert.deepEqual(reads, [1, 2]); assert.deepEqual(plain(result.proposal), ["first", "second"]);
    assert.equal(result.usage.steps, 2); assert.equal(result.usage.toolCalls, 2);
  }
});

test("missing/extra/raw/double/duplicate envelopes and wrong values fail without retry", async () => {
  const bad = ["{}", '{"proposal":["first"],"extra":true}', '["first"]',
    '{"proposal":{"proposal":["first"]}}', '{"proposal":["first"],"proposal":["second"]}',
    '{"proposal":["first"],"\\u0070roposal":["second"]}', '{"proposal":null}', '{"proposal":[1]}'];
  for (const kind of kinds) for (const content of bad) {
    let calls = 0;
    await assert.rejects(run(kind, list, async () => {
      calls++; return { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] };
    }), error => ["PROVIDER_FAILED", "OUTPUT_INVALID"].includes(error.code));
    assert.equal(calls, 1);
  }
});

test("an empty scalar value is preserved when explicitly allowed", async () => {
  for (const kind of kinds) {
    const result = await run(kind, { type: "string", maxLength: 5 }, async () => completion({ proposal: "" }));
    assert.equal(result.proposal, "");
  }
});

test("mutating the caller schema after admission cannot change its wire or validation", async () => {
  const schema = { type: "array", items: { type: "string", enum: ["original"], maxLength: 20 }, maxItems: 1 };
  const admitted = plain(schema);
  const app = createRestrictedApplicationRunner({ provider: provider("deepseek-flash", async body => {
    assertWireSchema(body, "deepseek-flash", object({ proposal: admitted }));
    return completion({ proposal: ["original"] });
  }), tools: [], instructions: "Return only an uncommitted list.", outputSchema: schema });
  schema.items.enum[0] = "mutated"; schema.maxItems = 100;
  assert.deepEqual(plain((await app.run(input)).proposal), ["original"]);
});

test("ordinary multilingual list requests use current host state in two turns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-root-proposal-"));
  try {
    let calls = 0;
    const results = await runRootProposalScenario(async body => {
      calls++;
      const observed = body.messages.filter(message => message.role === "tool");
      if (!observed.length) return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "read_current", type: "function", function: { name: "read_current_items", arguments: "{}" } }] } }] };
      assert.equal(observed.length, 1);
      return completion({ proposal: JSON.parse(observed[0].content) });
    }, path.join(root, "host"));
    assert.equal(calls, 4); assert.equal(results.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
