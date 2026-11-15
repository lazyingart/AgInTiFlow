import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveScsJsonLane, reviewScsFinish } from "../src/scs-controller.js";

function clientForBudget(bodies, minimum = 2048) {
  return { chat: { completions: { create: async payload => {
    bodies.push(payload);
    const complete = payload.max_tokens >= minimum;
    return { choices: [{ index: 0, finish_reason: complete ? "stop" : "length", message: {
      role: "assistant", content: complete ? JSON.stringify({ role: "student", decision: "finish_allowed", confidence: 0.99,
        reason: "Structured model review completed", evidence: ["The explanation satisfies the supplied observations"], next_required_action: "finish" }) : "",
      ...(!complete ? { reasoning_content: "Reasoning consumed the available completion budget" } : {}),
    } }], usage: { completion_tokens: complete ? 1700 : payload.max_tokens } };
  } } } };
}

for (const provider of ["deepseek", "openai", "localllm"]) test(`JSON review retains available reasoning/output room: ${provider}`, async () => {
  const bodies = [], config = { provider, model: "opaque-reasoning-model", maxOutputTokens: 4096, modelTimeoutMs: 1000, scsValidationMode: "model", taskProfile: "auto" };
  const state = { goal: "Explain the supplied observations.", messages: [], meta: {} };
  const decision = await reviewScsFinish(clientForBudget(bodies), config, state, "The observations show an assertion mismatch.");
  assert.equal(bodies.length, 1); assert.equal(bodies[0].max_tokens, 4096);
  assert.equal(decision.reason, "Structured model review completed"); assert.equal(decision.confidence, 0.99);
  assert.equal(decision.decision, "finish_allowed");
});

for (const ceiling of [64, 128, 512, 768, 1536, 3072, 4096, 8192]) test(`caller ceiling stays authoritative: ${ceiling}`, () => {
  const lane = resolveScsJsonLane({ provider: "openai", model: "chosen-model", maxOutputTokens: ceiling, modelTimeoutMs: 5000 });
  assert.equal(lane.maxOutputTokens, Math.min(ceiling, 4096)); assert.equal(lane.modelTimeoutMs, 5000); assert.equal(lane.model, "chosen-model");
});
test("committee and final review share a bounded JSON output allowance", () => {
  const config = { provider: "deepseek", model: "chosen-model", maxOutputTokens: 4096 };
  assert.equal(resolveScsJsonLane(config, "SCS committee").maxOutputTokens, 4096);
  assert.equal(resolveScsJsonLane(config, "SCS final gate").maxOutputTokens, 4096);
});
test("an unspecified role budget is finite and bounded", () => {
  assert.equal(resolveScsJsonLane({ provider: "openai", model: "chosen-model" }).maxOutputTokens, 4096);
});
test("fractional caller limits do not become invalid fractional token counts", () => {
  assert.equal(resolveScsJsonLane({ provider: "openai", model: "chosen-model", maxOutputTokens: 512.9 }).maxOutputTokens, 512);
});
test("a positive limit below one token fails before a model request", () => {
  assert.throws(() => resolveScsJsonLane({ provider: "openai", model: "chosen-model", maxOutputTokens: 0.5 }), /at least one whole token/);
});
test("small explicit limits retain safe fallback without retry or widening", async () => {
  const bodies = [], config = { provider: "openai", model: "chosen-model", maxOutputTokens: 128, scsValidationMode: "model" };
  const state = { goal: "Explain the supplied observations.", messages: [], meta: {} };
  const decision = await reviewScsFinish(clientForBudget(bodies), config, state, "The observations show an assertion mismatch.");
  assert.equal(bodies.length, 1); assert.equal(bodies[0].max_tokens, 128);
  assert.match(decision.reason, /Fallback/); assert.notEqual(decision.confidence, 0.99);
});
test("resident local model and provider boundaries remain unchanged", () => {
  const lane = resolveScsJsonLane({ provider: "localllm", model: "resident-local", routeProvider: "localllm", routeModel: "another-local", maxOutputTokens: 128, modelTimeoutMs: 90000 });
  assert.equal(lane.model, "resident-local"); assert.equal(lane.modelTimeoutMs, 45000); assert.equal(lane.maxOutputTokens, 128);
  const other = resolveScsJsonLane({ provider: "openai", model: "chosen-model", routeProvider: "deepseek", routeModel: "foreign-model", maxOutputTokens: 4096 });
  assert.equal(other.provider, "openai"); assert.equal(other.model, "chosen-model");
});
test("larger JSON budget cannot authorize completion without required artifacts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-scs-json-budget-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bodies = [], config = { provider: "openai", model: "chosen-model", maxOutputTokens: 4096, scsValidationMode: "model", commandCwd: root, taskProfile: "code" };
  const decision = await reviewScsFinish(clientForBudget(bodies), config, { goal: "Create proof.md.", messages: [], meta: {} }, "Created proof.md.");
  assert.equal(decision.decision, "finish_rejected"); assert.equal(bodies.length, 0);
});
