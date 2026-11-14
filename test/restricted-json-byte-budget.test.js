import assert from "node:assert/strict";
import test from "node:test";
import { jsonSnapshot } from "../src/restricted-application-contract.js";
import { createRestrictedApplicationRunner } from "../src/restricted-application.js";

const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const cases = [
  ["null", null], ["true", true], ["false", false], ["zero", 0], ["negative zero", -0],
  ["integer", 42], ["negative", -127], ["fraction", 0.125], ["small exponent", 1e-7],
  ["large exponent", 1e21], ["largest finite", Number.MAX_VALUE],
  ["empty string", ""], ["ASCII", "abc"], ["multibyte", "你好🙂"],
  ["escaped text", "\n\t\"\\\u0000"], ["empty array", []], ["empty object", {}],
  ["primitive array", [0, false, null, true, -0]], ["nested arrays", [[1, 2], [], [3]]],
  ["escaped keys", { ["\n\"\\"]: false }], ["Unicode keys", { ["🙂"]: "值" }],
  ["mixed object", { count: 2, rows: [{ value: 0 }, { value: null }], ok: true }],
];
for (const [name, value] of cases) test("exact UTF-8 snapshot boundary: " + name, () => {
  const serialized = JSON.stringify(value), bytes = Buffer.byteLength(serialized);
  assert.equal(JSON.stringify(jsonSnapshot(value, { maxBytes: bytes })), serialized);
  assert.throws(() => jsonSnapshot(value, { maxBytes: bytes - 1 }), { code: "DATA_LIMIT" });
});

const payload = () => ({ count: 4000, missing: 0, batches: Array.from({ length: 4 }, () => Array(1000).fill(0)) });
test("an 8046-byte current batch fits 64 KiB without charging array index names", () => {
  const value = payload();
  assert.equal(Buffer.byteLength(JSON.stringify(value)), 8046);
  assert.equal(JSON.stringify(jsonSnapshot(value, { maxBytes: 65536 })), JSON.stringify(value));
});
test("large escaped member names are charged before copying their child", () => {
  let hooks = 0;
  const child = Object.defineProperty({}, "unsafe", { enumerable: true, get() { hooks++; throw Error("not data"); } });
  const value = { ['"'.repeat(50)]: child };
  assert.throws(() => jsonSnapshot(value, { maxBytes: 80 }), { code: "DATA_LIMIT" });
  assert.equal(hooks, 0);
});
test("copy remains detached and deeply frozen with no normalization", () => {
  const input = { rows: [{ value: -0 }], text: "e\u0301" };
  const copy = jsonSnapshot(input, { maxBytes: Buffer.byteLength(JSON.stringify(input)) });
  input.rows[0].value = 7;
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.rows) && Object.isFrozen(copy.rows[0]));
  assert.ok(Object.is(copy.rows[0].value, -0)); assert.equal(copy.text, "e\u0301");
});
test("independent node and depth ceilings are not relaxed by compact JSON", () => {
  assert.throws(() => jsonSnapshot(Array(20000).fill(0), { maxBytes: 100000 }));
  assert.throws(() => jsonSnapshot({ a: { b: 0 } }, { maxBytes: 100, maxNodes: 2 }), { code: "DATA_LIMIT" });
  let nested = null; for (let i = 0; i < 34; i++) nested = [nested];
  assert.throws(() => jsonSnapshot(nested), { code: "DATA_LIMIT" });
});
test("unsafe callbacks, sparse or extended arrays and cycles never become sized JSON", () => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, "field", { enumerable: true, get() { hooks++; return 1; } });
  const proxy = new Proxy({}, { get() { hooks++; }, ownKeys() { hooks++; return []; } });
  const cycle = {}; cycle.self = cycle;
  const extended = [1]; extended.extra = 2;
  const toJSON = { toJSON() { hooks++; return {}; } };
  for (const value of [accessor, proxy, cycle, extended, Array(2), toJSON, Infinity, NaN, undefined, "\ud800"]) {
    assert.throws(() => jsonSnapshot(value));
  }
  assert.equal(hooks, 0);
});

const countSchema = { type: "integer", minimum: 0, maximum: 10000 };
const batchSchema = object({ count: countSchema, missing: countSchema,
  batches: { type: "array", maxItems: 4, items: { type: "array", maxItems: 1000, items: { type: "number" } } } });
function app({ value = payload(), limit = 65536 } = {}) {
  let requests = 0, reads = 0;
  const runner = createRestrictedApplicationRunner({
    instructions: "Read the current batch once and report its observed counts without external research or writes.",
    provider: { supportsImages: false, complete(request) {
      requests++;
      if (requests === 1) return { type: "tool_calls", calls: [{ id: "current_batch", name: "read_current_batch", arguments: {} }] };
      assert.equal(request.tools.length, 0, "The existing one-read budget remains binding.");
      const read = request.messages.filter(m => m.role === "tool");
      assert.equal(read.length, 1); assert.equal(JSON.stringify(read[0].value), JSON.stringify(value));
      return { type: "final", value: { count: 4000, missing: 0 } };
    } },
    tools: [{ name: "read_current_batch", description: "Read the current bounded numeric batch.", readOnly: true,
      inputSchema: object({}), outputSchema: batchSchema, execute() { reads++; return value; } }],
    outputSchema: object({ count: countSchema, missing: countSchema }),
    limits: { maxSteps: 3, maxToolCalls: 1, maxCallsPerStep: 1, maxResultBytes: limit },
  });
  return { runner, counts: () => ({ requests, reads }) };
}
const input = { input: [{ type: "text", text: "Check this batch and tell me how many observations there are and whether anything is missing." }] };
test("the real restricted loop can finish after a valid numeric result below its default limit", async () => {
  const f = app(); const result = await f.runner.run(input);
  assert.equal(result.status, "completed"); assert.equal(result.proposal.count, 4000);
  assert.deepEqual(f.counts(), { requests: 2, reads: 1 });
});
test("a tool result exactly at its configured byte cap is admitted intact", async () => {
  const value = payload(), bytes = Buffer.byteLength(JSON.stringify(value));
  const f = app({ value, limit: bytes }); await f.runner.run(input);
  assert.deepEqual(f.counts(), { requests: 2, reads: 1 });
});
test("one byte over the tool-result cap stops before a second model request", async () => {
  const value = payload(), bytes = Buffer.byteLength(JSON.stringify(value));
  const f = app({ value, limit: bytes - 1 });
  await assert.rejects(f.runner.run(input), { code: "DATA_LIMIT" });
  assert.deepEqual(f.counts(), { requests: 1, reads: 1 });
});
