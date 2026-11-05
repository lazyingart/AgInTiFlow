import assert from "node:assert/strict";
import test from "node:test";
import * as restricted from "../src/restricted-application.js";


// JSON instance equality: objects unordered, arrays ordered, no coercion.
const enumObject = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const enumText = { type: "string", maxLength: 500 };
const enumRecord = { sourceId: "ref_A", details: { title: "Verified 文献", year: 2020 }, identifiers: [{ kind: "doi", value: "10.0000/fixture" }], flags: [false, null, 1] };
const enumRecordSchema = {
  ...enumObject({ sourceId: enumText, details: enumObject({ title: enumText, year: { type: "integer" } }),
    identifiers: { type: "array", items: enumObject({ kind: enumText, value: enumText }), maxItems: 2 },
    flags: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "null" }, { type: "number" }] }, maxItems: 3 } }),
  enum: [enumRecord],
};
const enumReordered = { flags: [false, null, 1], identifiers: [{ value: "10.0000/fixture", kind: "doi" }], details: { year: 2020, title: "Verified 文献" }, sourceId: "ref_A" };
const enumInput = { input: [{ type: "text", text: "Use the verified reference we just found; keep its details." }] };
const enumRun = (value, outputSchema = enumRecordSchema, extra = {}) => restricted.createRestrictedApplicationRunner({
  provider: { supportsImages: false, complete: async () => ({ type: "final", value }) }, tools: [],
  instructions: "Return only an uncommitted proposal from authorized observed values.", outputSchema, ...extra,
});
const enumPlain = value => JSON.parse(JSON.stringify(value));

test("object enum equality ignores key order recursively without rewriting returned proposals", async () => {
  for (const value of [enumRecord, enumReordered]) {
    const result = await enumRun(value).run(enumInput);
    assert.deepEqual(enumPlain(result.proposal), value);
    assert.deepEqual(Object.keys(result.proposal), Object.keys(value), "validation must not reorder the actual proposal");
    assert.ok(Object.isFrozen(result.proposal.details));
  }
  const arraySchema = { type: "array", items: enumRecordSchema, minItems: 1, maxItems: 1, enum: [[enumRecord]] };
  assert.deepEqual(enumPlain((await enumRun([enumReordered], arraySchema).run(enumInput)).proposal), [enumReordered]);
  const mutable = structuredClone(enumRecordSchema);
  const configured = enumRun(enumReordered, mutable);
  mutable.enum[0].details.title = "changed";
  assert.equal((await configured.run(enumInput)).proposal.details.title, "Verified 文献");
});

test("enum equality retains exact values, array order, types, keys and Unicode spelling", async () => {
  const negatives = [
    { ...enumReordered, sourceId: "ref_B" }, { ...enumReordered, extra: true },
    { ...enumReordered, flags: [1, null, false] }, { ...enumReordered, flags: [false, null, 1, 1] },
    { ...enumReordered, details: { year: "2020", title: "Verified 文献" } },
    { ...enumReordered, details: { year: 2021, title: "Verified 文献" } },
    { ...enumReordered, identifiers: [] },
    { ...enumReordered, identifiers: [{ value: "10.0000/other", kind: "doi" }] },
  ];
  for (const value of negatives) await assert.rejects(enumRun(value).run(enumInput), error => error.code === "OUTPUT_INVALID");
  for (const [schema, good, bad] of [
    [{ type: "object", properties: {}, required: [], additionalProperties: false, enum: [{}] }, {}, []],
    [{ type: "array", items: { type: "boolean" }, maxItems: 0, enum: [[]] }, [], {}],
    [{ type: "number", enum: [0] }, -0, false],
    [{ type: "string", maxLength: 20, enum: ["é"] }, "\u00e9", "e\u0301"],
    [{ type: "null", enum: [null] }, null, ""],
  ]) {
    await enumRun(good, schema).run(enumInput);
    await assert.rejects(enumRun(bad, schema).run(enumInput), error => error.code === "OUTPUT_INVALID");
  }
});

test("object enums admit reordered tool arguments/results but reject a foreign batch before its first read", async () => {
  let turns = 0, reads = 0;
  const makeCall = (id, args = enumReordered) => ({ id, name: "reference_read", arguments: args });
  const tools = [{ name: "reference_read", description: "Read the caller-authorized reference only.", readOnly: true,
    inputSchema: enumRecordSchema, outputSchema: enumRecordSchema, execute: async args => {
      reads++; assert.ok(Object.isFrozen(args.details)); return enumReordered;
    } }];
  const app = enumRun(null, enumRecordSchema, { tools, provider: { supportsImages: false, async complete(request) {
    if (++turns === 1) return { type: "tool_calls", calls: [makeCall("read_1")] };
    assert.deepEqual(enumPlain(request.messages.at(-1).value), enumReordered);
    return { type: "final", value: enumReordered };
  } } });
  await app.run(enumInput); assert.equal(reads, 1); assert.equal(turns, 2);
  reads = 0;
  await assert.rejects(enumRun(null, enumRecordSchema, { tools, provider: { supportsImages: false, async complete() {
    return { type: "tool_calls", calls: [makeCall("valid"), makeCall("foreign", { ...enumReordered, sourceId: "ref_B" })] };
  } } }).run(enumInput), error => error.code === "TOOL_CALL_INVALID");
  assert.equal(reads, 0);
  let traps = 0;
  const hostile = [
    new Proxy(enumReordered, { get() { traps++; }, ownKeys() { traps++; } }),
    Object.defineProperty({ ...enumReordered }, "sourceId", { enumerable: true, get() { traps++; return "ref_A"; } }),
    { ...enumReordered, [Symbol("extra")]: 1 },
    Object.defineProperty({ ...enumReordered }, "hidden", { value: 1 }),
    { ...enumReordered, toJSON() { traps++; return enumRecord; } },
  ];
  for (const value of hostile) await assert.rejects(enumRun(value).run(enumInput));
  assert.equal(traps, 0);
});

test("native OpenAI and Flash/Pro accept reordered observed enum records and reject mixed source binding", async () => {
  for (const model of ["generic-explicit", "deepseek-flash", "deepseek-v4-pro"]) {
    const factory = model === "generic-explicit" ? restricted.createRestrictedOpenAIProvider : restricted.createRestrictedDeepSeekProvider;
    for (const [value, accepted] of [[enumReordered, true], [{ ...enumReordered, details: { year: 2020, title: "Other source" } }, false]]) {
      let requests = 0;
      const provider = factory({ model, ...(model === "generic-explicit" ? { supportsImages: false } : {}), async complete(body) {
        requests++; assert.equal(body.model, model);
        return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] };
      } });
      const pending = enumRun(null, enumRecordSchema, { provider }).run(enumInput);
      if (accepted) assert.deepEqual(enumPlain((await pending).proposal), enumReordered);
      else await assert.rejects(pending, error => error.code === "OUTPUT_INVALID");
      assert.equal(requests, 1);
    }
  }
});
