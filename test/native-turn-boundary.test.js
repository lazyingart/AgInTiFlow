import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, requestNextStep, requestDirectResponse, isTransientProviderRequestError, shouldRetryWithTextToolProtocol } from "../src/model-client.js";
import { assertNativeTurnAdmission } from "../src/native-turn-contract.js";
import { classifyProviderHandoffError } from "../src/provider-handoff.js";

const config = { provider: "deepseek", model: "deepseek-flash", modelTimeoutMs: 1000, taskProfile: "code",
  goal: "Read note.txt and write a short summary.md.", commandCwd: "/tmp", allowedDomains: [], allowFileTools: true,
  allowShellTool: false, allowWrapperTools: false, allowMcpTools: false, allowWebSearch: false, allowAuxiliaryTools: false };
const response = () => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: {
  role: "assistant", content: null, tool_calls: [{ id: "native_boundary_1", type: "function", function: {
    name: "write_file", arguments: '{"path":"summary.md","content":"An observed note.","mode":"create"}',
  } }],
} }] });
const text = () => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "An observed note." } }] });
const fixture = value => {
  let calls = 0;
  return { client: { chat: { completions: { create: async () => { calls++; return value; } } } }, calls: () => calls };
};

for (const [label, change] of [
  ["truncated", r => r.choices[0].finish_reason = "length"],
  ["filtered", r => r.choices[0].finish_reason = "content_filter"],
  ["unknown finish", r => r.choices[0].finish_reason = "future_partial"],
  ["null finish", r => r.choices[0].finish_reason = null],
  ["wrong role", r => r.choices[0].message.role = "user"],
  ["refused", r => r.choices[0].message.refusal = "UPSTREAM_PRIVATE_DIAGNOSTIC"],
  ["contradictory stop", r => r.choices[0].finish_reason = "stop"],
  ["multiple choices", r => r.choices.push(structuredClone(r.choices[0]))],
]) test(`${label} original native turn cannot reach tool normalization`, async () => {
  const value = response(); change(value); const f = fixture(value);
  await assert.rejects(requestNextStep(f.client, config, []), error => /^MODEL_TURN_/.test(error.code));
  assert.equal(f.calls(), 1, "No hidden compatibility retry");
});
for (const lane of ["plan", "direct"]) test(`truncated ${lane} cannot become a usable plan/answer`, async () => {
  const value = text(); value.choices[0].finish_reason = "length"; const f = fixture(value);
  await assert.rejects(lane === "plan" ? createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} })
    : requestDirectResponse(f.client, config, []), error => /^MODEL_TURN_/.test(error.code));
  assert.equal(f.calls(), 1);
});
test("ordinary native tool turn stays unchanged", async () => {
  const value = response(), f = fixture(value);
  assert.equal(await requestNextStep(f.client, config, []), value); assert.equal(f.calls(), 1);
});

for (const [label, change] of [
  ["explicit undefined finish", r => r.choices[0].finish_reason = undefined],
  ["string index", r => r.choices[0].index = "0"],
  ["empty refusal", r => r.choices[0].message.refusal = ""],
  ["false refusal", r => r.choices[0].message.refusal = false],
  ["legacy function call", r => r.choices[0].message.function_call = { name: "write_file", arguments: "{}" }],
  ["false native calls", r => r.choices[0].message.tool_calls = false],
  ["object native calls", r => r.choices[0].message.tool_calls = {}],
  ["number content", r => r.choices[0].message.content = 0],
  ["array content", r => r.choices[0].message.content = []],
  ["malformed Unicode content", r => r.choices[0].message.content = "\ud800"],
  ["false reasoning", r => r.choices[0].message.reasoning_content = false],
  ["sparse choices", r => r.choices = Array(1)],
  ["extended choices", r => r.choices.extra = true],
]) test(`native original envelope rejects ${label}`, async () => {
  const value = response(); change(value); const f = fixture(value);
  await assert.rejects(requestNextStep(f.client, config, []), error => {
    assert.match(error.code, /^MODEL_TURN_/); assert.equal(error.status, 422);
    assert.equal(isTransientProviderRequestError(error), false);
    assert.equal(shouldRetryWithTextToolProtocol(error, { provider: "localllm" }), false);
    assert.equal(classifyProviderHandoffError(error).eligible, false);
    assert.ok(!error.message.includes("UPSTREAM_PRIVATE")); return true;
  });
  assert.equal(f.calls(), 1);
});

for (const reason of ["stop", "length", undefined]) test(`reasoning-only continuation remains non-executing (${reason})`, async () => {
  const value = text(); value.choices[0].message.content = null; value.choices[0].message.reasoning_content = "Need one next action.";
  if (reason === undefined) delete value.choices[0].finish_reason; else value.choices[0].finish_reason = reason;
  const f = fixture(value);
  assert.equal(await requestNextStep(f.client, config, []), value);
  assert.equal(await requestDirectResponse(f.client, config, []), value);
  if (reason === "length") await assert.rejects(createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} }), { code: "MODEL_TURN_INCOMPLETE" });
  else assert.equal((await createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} })).includes("Need one next action."), false);
});
test("empty non-acting length replies retain bounded core repair/fallback", async () => {
  const value = text(); value.choices[0].message.content = ""; value.choices[0].finish_reason = "length";
  const f = fixture(value); assert.equal(await requestNextStep(f.client, config, []), value);
  assert.equal(await requestDirectResponse(f.client, config, []), value);
  await assert.rejects(createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} }), { code: "MODEL_TURN_INCOMPLETE" });
});
test("reasoning does not excuse partial content or a native call", async () => {
  for (const value of [text(), response()]) {
    value.choices[0].finish_reason = "length"; value.choices[0].message.reasoning_content = "Reasoning alone is not authority.";
    const f = fixture(value); await assert.rejects(requestNextStep(f.client, config, []), { code: "MODEL_TURN_INCOMPLETE" });
  }
});
test("complete text-tool syntax requires a complete ORIGINAL turn", async () => {
  const value = text(); value.choices[0].message.content = 'Requested tool: read_file({"path":"note.txt"})';
  const f = fixture(value); const good = await requestNextStep(f.client, config, []);
  assert.equal(good.choices[0].message.tool_calls[0].function.name, "read_file");
  value.choices[0].finish_reason = "length";
  await assert.rejects(requestNextStep(f.client, config, []), { code: "MODEL_TURN_INCOMPLETE" });
});
test("direct and plan lanes cannot accept native calls", async () => {
  const f = fixture(response());
  await assert.rejects(requestDirectResponse(f.client, config, []), { code: "MODEL_TURN_INVALID" });
  await assert.rejects(createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} }), { code: "MODEL_TURN_INVALID" });
});
test("complete plans, direct answers and SDK metadata are preserved", async () => {
  const value = text(); Object.defineProperty(value, "_request_id", { value: "synthetic-sdk-id" });
  const f = fixture(value);
  assert.equal(await requestDirectResponse(f.client, config, []), value);
  assert.equal(await createPlan(f.client, config, { goal: config.goal, messages: [], meta: {} }), "An observed note.");
  assert.equal(value._request_id, "synthetic-sdk-id");
});
test("omitted legacy metadata stays compatible without manufacturing proof", async () => {
  const value = response(); delete value.choices[0].finish_reason; delete value.choices[0].index; delete value.choices[0].message.role;
  const f = fixture(value); assert.equal(await requestNextStep(f.client, config, []), value);
});
test("pure boundary rejects Proxy and authority accessors without traps", () => {
  let traps = 0;
  const proxy = value => new Proxy(value, { get() { traps++; throw Error("must not run"); }, getPrototypeOf() { traps++; throw Error("must not run"); } });
  const inputs = [proxy(response())];
  for (const location of ["choices", "choice", "message"]) {
    const r = response();
    if (location === "choices") r.choices = proxy(r.choices);
    else if (location === "choice") r.choices[0] = proxy(r.choices[0]);
    else r.choices[0].message = proxy(r.choices[0].message);
    inputs.push(r);
  }
  for (const [where, key] of [["root", "choices"], ["choice", "message"], ["choice", "finish_reason"], ["message", "role"], ["message", "content"]]) {
    const r = response(), target = where === "root" ? r : where === "choice" ? r.choices[0] : r.choices[0].message;
    Object.defineProperty(target, key, { enumerable: true, get() { traps++; throw Error("must not run"); } }); inputs.push(r);
  }
  for (const input of inputs) assert.throws(() => assertNativeTurnAdmission(input, "step"), { code: "MODEL_TURN_INVALID" });
  assert.equal(traps, 0);
});
