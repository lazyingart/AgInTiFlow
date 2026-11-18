import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestOnlyExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createTestOnlyIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createTestOnlyIntegrationAnalysisPlanner } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";

import { projectPublicIntegrationResponse } from "../src/integration-api.js";

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
    complete: async (_client, payload) => {
      modelCalls++;
      return typeof value === "function" ? value(payload) : value;
    },
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

test("editor text preserves paired delimiters and private path redaction through restart and resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-editor-replay-"));
  const context = {
    principalId: scope.principalId, principal: { id: scope.principalId },
    browserSessionId: scope.browserSessionId, browserSession: { id: scope.browserSessionId },
  };
  const source = '<unit id="7"><em>雾港</em> — open /scratch/work.txt</unit>';
  const safeSource = source.replace("/scratch/work.txt", "[REDACTED_PATH]");
  const answer = { translation: '<unit id="7"><em>Fog Harbour</em></unit>' };
  const wires = [];
  const f = fixture(payload => {
    wires.push(payload.messages);
    assert.equal(payload.tools, undefined);
    const value = response();
    value.choices[0].message.content = JSON.stringify(answer);
    return value;
  });
  const open = () => createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: f.planner, stateRoot: root });
  let service = open();
  try {
    const { thread } = await service.createThread({ title: "Bilingual passage" }, context);
    const { run } = await service.startRun({ threadId: thread.id, input: {
      text: source, inference: { responseFormat: "json_object" },
    } }, context);
    await service.waitForIdle();
    assert.equal(wires[0].at(-1).content, safeSource);
    await service.close({ mode: "wait" });
    service = open();
    const p = { runId: run.id };
    const status = await service.getRunStatus(p, context);
    const projected = projectPublicIntegrationResponse("/agent/v1/runs/status", status, p, context).run;
    assert.equal(projected.status, "completed");
    assert.deepEqual(JSON.parse(projected.output), answer);
    const get = { threadId: thread.id };
    const persisted = projectPublicIntegrationResponse("/agent/v1/threads/get", await service.getThread(get, context), get, context);
    assert.deepEqual(persisted.thread.messages.map(m => m.content), [safeSource, projected.output]);
    const { publicEventLedger } = await service.loadRunEvents({ ...p, afterSeq: 0, afterHash: "0".repeat(64) }, context);
    const events = await publicEventLedger.loadEventsAfter(0);
    assert.equal(events.filter(e => e.type === "output.delta").map(e => e.payload.text).join(""), projected.output);
    const follow = await service.resumeRun({ runId: run.id, input: {
      text: "Keep the formatting and check the place name.", inference: { responseFormat: "json_object" },
    } }, context);
    await service.waitForIdle();
    assert.equal(follow.run.previousRunId, run.id);
    assert(wires[1].some(m => m.content === safeSource));
    assert(wires[1].some(m => m.content === projected.output));
    assert.equal(f.modelCalls(), 2);
    assert.equal(f.workerCalls(), 0);
  } finally {
    await service.close({ mode: "abort" });
    f.coordinator.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only paired text delimiters qualify; path, secret and structured-field guards remain active", async () => {
  const examples = [
    ['[draft] <line>A <b>B</b></line>.', '[draft] <line>A <b>B</b></line>.'],
    ['<note href="/private/file.txt">A</note>', '<note href="[REDACTED_PATH]">A</note>'],
    ['<cell></cell><cell/> </cell>', '<cell></cell><cell/> <[REDACTED_PATH]>'],
    ['<a><b>text</a></b>', '<a><b>text<[REDACTED_PATH]><[REDACTED_PATH]>'],
    ['<sample>path </sample/subdir> /data/item', '<sample>path <[REDACTED_PATH]> [REDACTED_PATH]'],
    ['<sample>bad </Sample>', '<sample>bad <[REDACTED_PATH]>'],
    ['<sample>bad </sample extra>', '<sample>bad <[REDACTED_PATH] extra>'],
    ['<note>Use C:\\Temp\\item or file:///private/item</note>', '<note>Use [REDACTED_PATH] or [REDACTED_PATH]</note>'],
    ['{"x":"<name>","y":"</name>"}', '{"x":"<name>","y":"<[REDACTED_PATH]>"}'],
    ['<script>example</script>', '<script>example<[REDACTED_PATH]>'],
    ['<note>api_key=example-private-value end</note>', '<note>api_key=[REDACTED] end</note>'],
  ];
  let answer;
  const f = fixture(() => {
    const value = response();
    value.choices[0].message.content = answer;
    return value;
  });
  try {
    for (const [input, expected] of examples) {
      answer = input;
      const result = await f.planner.run(scope, { prompt: "Repeat the sample.", inference: { responseFormat: "text" } });
      assert.equal(result.text, expected);
    }
    assert.equal(f.workerCalls(), 0);
  } finally { f.coordinator.close(); }
});

test("long Unicode text and a closing element at an event boundary replay losslessly", async () => {
  // The '<' lands at UTF-16 offset 3999. Splitting immediately after it
  // would turn the next event into an apparent absolute path.
  const passage = "<root>" + "x".repeat(3993) + "</root>" + "🍋".repeat(2600);
  const value = response();
  value.choices[0].message.content = passage;
  const f = fixture(value, "localllm");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-unicode-events-"));
  const service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: f.planner, stateRoot: root });
  try {
    const { thread } = await service.createThread({ title: "Long passage" }, scope);
    const { run } = await service.startRun({ threadId: thread.id, input: {
      text: "Return the sample.", inference: { responseFormat: "text" },
    } }, scope);
    await service.waitForIdle();
    const { publicEventLedger } = await service.loadRunEvents({ runId: run.id, afterSeq: 0, afterHash: "0".repeat(64) }, scope);
    const events = await publicEventLedger.loadEventsAfter(0);
    assert.equal(events.at(-1).type, "run.completed");
    const chunks = events.filter(e => e.type === "output.delta").map(e => e.payload.text);
    assert(chunks.length >= 3);
    assert(chunks.every(chunk => chunk.length <= 4000 && chunk.isWellFormed()));
    assert.equal(chunks.join(""), passage);
    assert.equal(f.workerCalls(), 0);
  } finally {
    await service.close({ mode: "abort" });
    f.coordinator.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
