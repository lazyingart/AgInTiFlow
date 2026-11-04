import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTestOnlyExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createTestOnlyIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createTestOnlyIntegrationAnalysisPlanner } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";

// Real durable session operations with controlled provider envelopes. This demo
// does not measure live provider quality/latency or enable a production service.
const paced = process.argv.includes("--paced");
if (process.argv.slice(2).some((arg) => arg !== "--paced")) throw new Error("Only --paced is supported");
async function emit(value) {
  console.log(JSON.stringify({ offlineFixture: true, ...value }));
  if (paced) await delay(1400);
}
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-backend-completion-demo-"));
const owner = { principalId: "public-completion-fixture", browserSessionId: "b".repeat(64) };
let modelCalls = 0, workerCalls = 0, service;
const coordinator = createTestOnlyIntegrationAnalysisCoordinator(createTestOnlyExecutionWorkerClient(async () => {
  workerCalls++;
  throw new Error("This text-only demonstration forbids worker calls");
}));
const planner = createTestOnlyIntegrationAnalysisPlanner({
  coordinator, modelClient: {},
  localModelConfig: {
    provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash",
    apiKey: "synthetic-fixture-no-provider-access", thinking: "disabled",
  },
  async complete() {
    modelCalls++;
    return { choices: [{ finish_reason: modelCalls === 1 ? "length" : "stop", message: { role: "assistant", content: "READY" } }] };
  },
});
try {
  await emit({ phase: "start", note: "Actual session persistence; offline provider fixture" });
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: planner, stateRoot });
  const { thread } = await service.createThread({ title: "Durable completion demonstration" }, owner);
  const start = await service.startRun({ threadId: thread.id, input: { text: "Just say READY." } }, owner);
  await service.waitForIdle();
  const first = (await service.getRunStatus({ runId: start.run.id }, owner)).run;
  assert.equal(first.status, "failed");
  assert.equal(first.output, "");
  assert.equal(first.error.code, "ANALYSIS_MODEL_PROTOCOL_INVALID");
  await emit({ phase: "truncated_reply", status: first.status, code: first.error.code, outputPublished: false });
  await service.close({ mode: "wait" }); service = null;
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: planner, stateRoot });
  assert.deepEqual((await service.getRunStatus({ runId: first.id }, owner)).run, first);
  assert.equal(modelCalls, 1);
  await emit({ phase: "restart", retainedStatus: "failed", modelCalls, workerCalls });
  const next = await service.resumeRun({ runId: first.id, input: { text: "Try again, just say READY." } }, owner);
  await service.waitForIdle();
  const completed = (await service.getRunStatus({ runId: next.run.id }, owner)).run;
  assert.equal(completed.status, "completed");
  assert.equal(completed.output, "READY");
  assert.equal(completed.previousRunId, first.id);
  assert.equal(completed.threadId, thread.id);
  await emit({ phase: "same_thread_resume", status: completed.status, output: completed.output, sameThread: true, lineageRetained: true });
  await service.close({ mode: "wait" }); service = null;
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: planner, stateRoot });
  assert.deepEqual((await service.getRunStatus({ runId: completed.id }, owner)).run, completed);
  assert.equal(modelCalls, 2); assert.equal(workerCalls, 0);
  await emit({ phase: "verified", schemaVersion: "aginti-backend-completion-demo-v1", modelCalls, workerCalls,
    threadId: thread.id, failedRunId: first.id, completedRunId: completed.id, restartVerified: true });
} finally {
  await service?.close({ mode: "abort" }); coordinator.close();
  await fs.rm(stateRoot, { recursive: true, force: true });
}
