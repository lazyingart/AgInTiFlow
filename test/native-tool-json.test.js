import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTextToolCallResponse } from "../src/model-client.js";
import { createToolContract, resolveDispatchableToolCallBatch } from "../src/tool-contract.js";
import { parseNativeToolArguments } from "../src/native-tool-arguments.js";

const descriptor = { type: "function", function: { name: "write_file", parameters: {
  type: "object", properties: { path: { type: "string" }, content: { type: "string" }, meta: { type: "object" } },
  required: ["path", "content"], additionalProperties: false,
} } };
const contract = createToolContract([descriptor]);
const call = (args, id = "native_json_1") => ({ id, type: "function", function: { name: "write_file", arguments: args } });
const reply = calls => ({ choices: [{ finish_reason: "tool_calls", message: {
  role: "assistant", content: null, tool_calls: calls,
} }] });

const ambiguous = [
  ["path", '{"path":"wanted.md","path":"other.md","content":"note"}'],
  ["content", '{"path":"wanted.md","content":"correct","content":"wrong"}'],
  ["escaped key", '{"path":"wanted.md","p\\u0061th":"other.md","content":"note"}'],
  ["nested object", '{"path":"wanted.md","content":"note","meta":{"revision":1,"revision":2}}'],
];
for (const [name, args] of ambiguous) {
  test(`native ${name} ambiguity requests bounded repair without calls`, () => {
    const result = normalizeTextToolCallResponse(reply([call(args)]));
    assert.deepEqual(result.choices[0].message.tool_calls, []);
    assert.equal(result.choices[0].message.aginti_text_tool_retry.reason, "ambiguous-native-tool-arguments");
    assert.ok(!JSON.stringify(result).includes("other.md"));
  });
  test(`contract cannot recover native ${name} ambiguity by losing duplicate keys`, () => {
    const result = resolveDispatchableToolCallBatch([call(args)], contract);
    assert.equal(result.ok, false);
    assert.equal(result.code, "TOOL_ARGUMENTS_INVALID_JSON");
  });
}
test("one malformed native call refuses the entire otherwise valid batch", () => {
  const result = normalizeTextToolCallResponse(reply([
    call('{"path":"first.md","content":"valid"}', "first"), call(ambiguous[1][1], "second"),
  ]));
  assert.deepEqual(result.choices[0].message.tool_calls, []);
  assert.equal(result.choices[0].message.aginti_text_tool_retry.reason, "ambiguous-native-tool-arguments");
});
test("ordinary native arguments remain exact, including duplicate-looking content", () => {
  const args = JSON.stringify({ path: "wanted.md", content: '{"key":1,"key":2}\nC:\\tmp\\note\n中文' });
  const value = reply([call(args)]);
  assert.equal(normalizeTextToolCallResponse(value), value);
  const result = resolveDispatchableToolCallBatch(value.choices[0].message.tool_calls, contract);
  assert.equal(result.ok, true);
  assert.equal(result.acceptedToolCalls[0].function.arguments, args);
});

for (const [name, source] of [
  ["duplicate nested inside an array", '{"items":[{"x":1,"x":2}]}'],
  ["identical repeated value", '{"x":1,"x":1}'],
  ["decoded unicode key collision", '{"中":1,"\\u4e2d":2}'],
  ["truncated object", '{"path":"note.md"'],
  ["trailing text", '{"x":1} extra'],
  ["non-JSON whitespace", '{\u00a0"x":1}'],
  ["non-finite number", '{"meta":{"x":1e999}}'],
  ["unpaired escaped value", '{"x":"\\ud800"}'],
  ["unpaired escaped key", '{"\\udfff":1}'],
  ["unpaired raw value", '{"x":"\ud800"}'],
  ["excess depth", '['.repeat(34) + '0' + ']'.repeat(34)],
  ["excess nodes", JSON.stringify(Array(50_001).fill(0))],
  ["UTF-8 byte overflow", JSON.stringify({ content: "中".repeat(Math.floor(16 * 1024 * 1024 / 3)) })],
]) test(`strict native JSON refuses ${name} without echoing input`, () => {
  assert.throws(() => parseNativeToolArguments(source), error => {
    assert.equal(error.code, "TOOL_ARGUMENTS_INVALID_JSON");
    assert.equal(error.message, "Native tool arguments must be bounded, unambiguous JSON.");
    return true;
  });
});
test("pure decoding preserves legitimate JSON data without recursively parsing text", () => {
  const value = { number: -0, fraction: 0.25, boolean: true, absent: null, array: [1, false, "中文🙂"],
    source: '{"x":1,"x":2}', nested: { x: 1 }, other: { x: 2 } };
  const source = JSON.stringify(value);
  assert.deepEqual(parseNativeToolArguments(source), JSON.parse(source));
  assert.equal(Object.is(parseNativeToolArguments('-0'), -0), true);
  assert.deepEqual(parseNativeToolArguments('{"__proto__":{"ordinary":"data"},"constructor":1}'),
    JSON.parse('{"__proto__":{"ordinary":"data"},"constructor":1}'));
});
test("non-string/Proxy input cannot invoke coercion hooks", () => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("must not call"); } });
  for (const value of [undefined, null, 1, proxy, { toString() { traps++; } }]) {
    assert.throws(() => parseNativeToolArguments(value), { code: "TOOL_ARGUMENTS_INVALID_JSON" });
  }
  assert.equal(traps, 0);
});
test("oversized or truncated member cannot preserve a valid prefix call", () => {
  for (const args of ['{"path":', '{"path":"x.md","content":"\\ud800"}']) {
    const result = normalizeTextToolCallResponse(reply([call('{"path":"first.md","content":"ok"}', "first"), call(args, "bad")]));
    const calls = result.choices[0].message.tool_calls;
    if (calls.length) assert.equal(resolveDispatchableToolCallBatch(calls, contract).ok, false);
    else assert.deepEqual(calls, []);
  }
});
test("ordinary truncated JSON keeps the existing native contract repair path", () => {
  const value = reply([call('{"path":')]);
  assert.equal(normalizeTextToolCallResponse(value), value);
  assert.equal(resolveDispatchableToolCallBatch(value.choices[0].message.tool_calls, contract).ok, false);
});
