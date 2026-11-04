import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestOnlyExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createTestOnlyIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createTestOnlyIntegrationAnalysisPlanner } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";

const scope = {
  principalId: "completion-protocol-fixture",
  browserSessionId: "a".repeat(64),
  threadId: "thr_00000000-0000-4000-8000-000000000061",
  runId: "run_00000000-0000-4000-8000-000000000062",
};
const response = () => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "READY" } }] });
function fixture(value, provider = "deepseek") {
  let workerCalls = 0, modelCalls = 0;
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(createTestOnlyExecutionWorkerClient(async () => {
    workerCalls++;
    throw new Error("A protocol check must never reach execution");
  }));
  const planner = createTestOnlyIntegrationAnalysisPlanner({
    coordinator, modelClient: {},
    localModelConfig: {
      ...(provider === "localllm"
        ? { provider, baseURL: "http://127.0.0.1:8008/v1", model: "localllm-fast" }
        : { provider, baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKey: "synthetic-not-a-real-provider-credential", thinking: "disabled" }),
    },
    complete: async () => { modelCalls++; return value; },
  });
  return { coordinator, planner, workerCalls: () => workerCalls, modelCalls: () => modelCalls };
}

test("failed completion survives restart and permits one same-thread correction", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-completion-contract-"));
  const value = response(); value.choices[0].finish_reason = "length";
  const f = fixture(value);
  const context = { principalId: scope.principalId, browserSessionId: scope.browserSessionId };
  let service;
  try {
    service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: f.planner, stateRoot });
    const { thread } = await service.createThread({ title: "Bounded completion" }, context);
    const started = await service.startRun({ threadId: thread.id, input: { text: "Just say READY." } }, context);
    await service.waitForIdle();
    const failed = (await service.getRunStatus({ runId: started.run.id }, context)).run;
    assert.equal(failed.status, "failed");
    assert.equal(failed.output, "");
    assert.equal(failed.error.code, "ANALYSIS_MODEL_PROTOCOL_INVALID");
    const beforeRestart = await service.getThread({ threadId: thread.id }, context);
    assert.equal(beforeRestart.thread.messages.some((m) => m.role === "assistant" && m.content === "READY"), false);
    await service.close({ mode: "wait" }); service = null;

    // Restart with the same durable store. Reads must neither call the model
    // nor reinterpret the plausible but truncated answer as a completed run.
    service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: f.planner, stateRoot });
    assert.deepEqual((await service.getRunStatus({ runId: started.run.id }, context)).run, failed);
    assert.equal(f.modelCalls(), 1, "durable reads must not repeat inference");
    value.choices[0].finish_reason = "stop";
    const resumed = await service.resumeRun({ runId: started.run.id, input: { text: "Try again, just say READY." } }, context);
    await service.waitForIdle();
    const completed = (await service.getRunStatus({ runId: resumed.run.id }, context)).run;
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, "READY");
    assert.equal(completed.previousRunId, failed.id);
    assert.equal(completed.threadId, thread.id);
    assert.equal(f.workerCalls(), 0);
    assert.equal(f.modelCalls(), 2);
    await service.close({ mode: "wait" }); service = null;
    service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: f.planner, stateRoot });
    assert.deepEqual((await service.getRunStatus({ runId: completed.id }, context)).run, completed);
    assert.equal((await service.getRunStatus({ runId: failed.id }, context)).run.status, "failed");
    assert.equal(f.modelCalls(), 2);
  } finally {
    await service?.close({ mode: "abort" }); f.coordinator.close();
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("truncated tool request is rejected before explicitly requested execution", async () => {
  const value = response();
  value.choices[0].finish_reason = "length";
  value.choices[0].message.content = null;
  value.choices[0].message.tool_calls = [{ id: "call_01", type: "function", function: {
    name: "execute_python_analysis", arguments: '{"source":"print(17*19)"}',
  } }];
  const f = fixture(value);
  try {
    await assert.rejects(f.planner.run(scope, { prompt: "Use Python to compute 17 times 19." }),
      (error) => error.code === "ANALYSIS_MODEL_PROTOCOL_INVALID");
    assert.equal(f.workerCalls(), 0);
    assert.equal(f.modelCalls(), 1);
  } finally { f.coordinator.close(); }
});

test("complete native tool envelope still reaches the authorized worker", async () => {
  const value = response();
  value.choices[0].finish_reason = "tool_calls";
  value.choices[0].message.content = null;
  value.choices[0].message.tool_calls = [{ id: "call_01", type: "function", function: {
    name: "execute_python_analysis", arguments: '{"source":"print(17*19)"}',
  } }];
  const f = fixture(value);
  try {
    await assert.rejects(f.planner.run(scope, { prompt: "Use Python to compute 17 times 19." }),
      (error) => error.code !== "ANALYSIS_MODEL_PROTOCOL_INVALID");
    assert.equal(f.workerCalls(), 1, "the deliberately failing fake worker must be invoked once");
  } finally { f.coordinator.close(); }
});

for (const content of ["已完成。", "完了しました。"] ) {
  test(`legacy LocalLLM completion and explicit truncation (${content})`, async () => {
    const value = response(); value.choices[0].message.content = content;
    delete value.choices[0].finish_reason;
    const f = fixture(value, "localllm");
    try {
      assert.equal((await f.planner.run(scope, { prompt: "Reply briefly." })).text, content);
      value.choices[0].finish_reason = "length";
      await assert.rejects(f.planner.run(scope, { prompt: "Reply briefly." }),
        (error) => error.code === "ANALYSIS_MODEL_PROTOCOL_INVALID");
      assert.equal(f.workerCalls(), 0);
    } finally { f.coordinator.close(); }
  });
}
const invalidEnvelopes = [
  ["truncated", (v) => { v.choices[0].finish_reason = "length"; }],
  ["filtered", (v) => { v.choices[0].finish_reason = "content_filter"; }],
  ["unknown finish", (v) => { v.choices[0].finish_reason = "future_partial"; }],
  ["null finish", (v) => { v.choices[0].finish_reason = null; }],
  ["refusal with plausible text", (v) => { v.choices[0].message.refusal = "refused"; }],
  ["multiple choices", (v) => { v.choices.push(structuredClone(v.choices[0])); }],
  ["legacy function call", (v) => { v.choices[0].message.function_call = { name: "exec", arguments: "{}" }; }],
  ["wrong role", (v) => { v.choices[0].message.role = "user"; }],
  ["unfinished native tool", (v) => {
    v.choices[0].finish_reason = "length";
    v.choices[0].message.tool_calls = [{ id: "call_01", type: "function", function: { name: "execute_python_analysis", arguments: '{"source":"print(1)"}' } }];
  }],
  ["tool finish without a call", (v) => { v.choices[0].finish_reason = "tool_calls"; }],
];
for (const inference of [undefined, { responseFormat: "text" }, { responseFormat: "json_object" }]) {
  for (const [name, change] of invalidEnvelopes) {
    test(`${name} cannot publish or execute (${inference?.responseFormat || "normal"})`, async () => {
      const value = response(); change(value);
      const f = fixture(value); let finals = 0;
      try {
        await assert.rejects(f.planner.run(scope, { prompt: "Just say READY.", ...(inference ? { inference } : {}) }, { onFinal: () => { finals++; } }),
          (error) => error.code === "ANALYSIS_MODEL_PROTOCOL_INVALID");
        assert.equal(finals, 0); assert.equal(f.workerCalls(), 0);
      } finally { f.coordinator.close(); }
    });
  }
  test(`complete result is preserved (${inference?.responseFormat || "normal"})`, async () => {
    const value = response();
    if (inference?.responseFormat === "json_object") value.choices[0].message.content = '{"ready":true}';
    const f = fixture(value);
    try {
      const result = await f.planner.run(scope, { prompt: "Just say READY.", ...(inference ? { inference } : {}) });
      assert.equal(result.toolCalls, 0); assert.equal(f.workerCalls(), 0);
      assert.equal(result.text, value.choices[0].message.content);
    } finally { f.coordinator.close(); }
  });
}
