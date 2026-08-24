import assert from "node:assert/strict";

import {
  EXECUTION_WORKER_API_SCHEMA_VERSION,
  EXECUTION_WORKER_RPC_PATHS,
} from "../src/execution-worker-api.js";
import { createTestOnlyExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createExecutionJobManager } from "../src/execution-worker-jobs.js";
import {
  EXECUTION_LIMITS,
  EXECUTION_RESULT_SCHEMA_VERSION,
  EXECUTION_WORKER_SCHEMA_VERSION,
  validateExecutionResult,
} from "../src/execution-worker.js";
import {
  INTEGRATION_ANALYSIS_TOOL_NAME,
  createTestOnlyIntegrationAnalysisCoordinator,
} from "../src/integration-analysis-coordinator.js";
import {
  INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
  assertIntegrationAnalysisPlanner,
  createTestOnlyIntegrationAnalysisPlanner,
} from "../src/integration-analysis-planner.js";
import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import { contractDigest } from "../src/integration-policy.js";

const PRINCIPAL_ID = "principal_planner_smoke_001";
const BROWSER_SESSION_ID = "2".repeat(64);
const THREAD_ID = "thr_00000000-0000-4000-8000-000000000061";
const RUN_ID = "run_00000000-0000-4000-8000-000000000062";
const WORKER_ID = "worker_planner_smoke_000000000001";
const POLICY_DIGEST = "3".repeat(64);
const RUNTIME_DIGEST = "4".repeat(64);
const PROOF_DIGEST = "5".repeat(64);
const SECCOMP_DIGEST = "6".repeat(64);
const BUNDLE_DIGEST = "7".repeat(64);
const CGROUP_DIGEST = "8".repeat(64);
const LOCAL_MODEL = Object.freeze({
  baseURL: "http://127.0.0.1:8008/v1",
  model: "localllm-analysis-smoke",
  apiKey: "test-local-secret-credential",
  contextWindowTokens: 32_768,
  maxOutputTokens: 1_024,
  modelTimeoutMs: 30_000,
});

function scope(runId = RUN_ID) {
  return Object.freeze({
    principalId: PRINCIPAL_ID,
    browserSessionId: BROWSER_SESSION_ID,
    threadId: THREAD_ID,
    runId,
  });
}

function capability() {
  const core = Object.freeze({
    schemaVersion: EXECUTION_WORKER_SCHEMA_VERSION,
    workerId: WORKER_ID,
    implementation: "aginti-execution-worker",
    implementationVersion: "1",
    runtime: Object.freeze({
      profile: "python-bwrap-netless-v1",
      policyDigest: POLICY_DIGEST,
      runtimeDigest: RUNTIME_DIGEST,
      proofDigest: PROOF_DIGEST,
      seccomp: true,
      seccompPolicyVerified: true,
      seccompPolicyDigest: SECCOMP_DIGEST,
      deniedSyscallsProven: true,
      minimalRuntimeRoot: true,
      runtimeBundleDigestPinned: true,
      runtimeBundleRootDigest: BUNDLE_DIGEST,
    }),
    containment: Object.freeze({
      aggregateCgroupVerified: true,
      cgroupPolicyDigest: CGROUP_DIGEST,
    }),
    languages: Object.freeze(["python"]),
    artifacts: Object.freeze({ schemaVersion: "1", kinds: Object.freeze(["plot", "table", "markdown"]) }),
    limits: EXECUTION_LIMITS,
    executionGate: Object.freeze({
      requiresVerifiedSeccompPolicy: true,
      requiresAggregateCgroupContainment: true,
      testOnlyBypassConfigured: false,
    }),
  });
  const capabilityDigest = contractDigest(core);
  const admission = Object.freeze({ state: "ready", activeJobs: 0, maximumConcurrentJobs: 2 });
  const activation = Object.freeze({ publicReady: true, blockers: Object.freeze([]) });
  return Object.freeze({
    ...core,
    ready: true,
    admission,
    activation,
    capabilityDigest,
    healthDigest: contractDigest({ capabilityDigest, ready: true, admission, activation }),
  });
}

function artifactId(request, artifact) {
  return `art_${contractDigest({
    jobId: request.jobId,
    attempt: request.attempt,
    index: 0,
    kind: artifact.kind,
    title: artifact.title,
    spec: artifact.spec,
  }).slice(0, 64)}`;
}

function resultArtifact(request) {
  const artifact = Object.freeze({
    title: "Square-number trend",
    kind: "plot",
    spec: Object.freeze({
      schemaVersion: "1",
      type: "line",
      xLabel: "Sample",
      yLabel: "Square",
      labels: Object.freeze(["1", "2", "3"]),
      series: Object.freeze([
        Object.freeze({ name: "n squared", data: Object.freeze([1, 4, 9]) }),
      ]),
    }),
  });
  return sanitizeIntegrationArtifact({ id: artifactId(request, artifact), ...artifact });
}

function terminalResult(request, signal) {
  const status = signal?.aborted ? "cancelled" : "succeeded";
  const artifacts = status === "succeeded" ? Object.freeze([resultArtifact(request)]) : Object.freeze([]);
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status,
    exitCode: status === "succeeded" ? 0 : null,
    stdout: status === "succeeded" ? "answer=9\ntoken=abcdefghijklmnopqrstu\n" : "",
    stderr: status === "succeeded" ? "diagnostic at /home/private/runtime/file.py\n" : "",
    outputTruncated: false,
    durationMs: 12,
    artifacts,
  });
  return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
}

function fakeWorker() {
  return Object.freeze({
    capabilities: async () => capability(),
    async execute(request, { signal } = {}) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal?.addEventListener?.("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return terminalResult(request, signal);
    },
  });
}

function rpcForManager(manager, calls) {
  return async (pathname, body) => {
    calls.push(Object.freeze({ pathname, body }));
    let response;
    if (pathname === EXECUTION_WORKER_RPC_PATHS.capabilities) response = await manager.capabilities();
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart) response = await manager.start(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStatus) response = manager.status(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsEvents) response = manager.events(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsCancel) response = manager.cancel(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsList) response = manager.listArtifacts(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsGet) response = manager.getArtifact(body);
    else throw new Error("unexpected execution RPC path");
    return Object.freeze({ schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, response });
  };
}

function toolResponse(source, extras = {}, callExtras = {}) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          ...callExtras,
          id: `call_${contractDigest(source).slice(0, 20)}`,
          type: "function",
          function: {
            name: INTEGRATION_ANALYSIS_TOOL_NAME,
            arguments: JSON.stringify({ source, stdin: "", timeoutMs: 1_000, ...extras }),
          },
        }],
      },
    }],
  };
}

function textResponse(content) {
  return { choices: [{ message: { role: "assistant", content, tool_calls: [] } }] };
}

function fixture(complete) {
  const rpcCalls = [];
  const manager = createExecutionJobManager({ worker: fakeWorker() });
  const client = createTestOnlyExecutionWorkerClient(rpcForManager(manager, rpcCalls));
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(client, { pollMs: 25 });
  const planner = createTestOnlyIntegrationAnalysisPlanner({
    coordinator,
    localModelConfig: LOCAL_MODEL,
    modelClient: Object.freeze({ mock: true }),
    complete,
  });
  return Object.freeze({ planner, coordinator, rpcCalls });
}

async function executesAndSynthesizesPlot() {
  const modelCalls = [];
  const { planner, coordinator, rpcCalls } = fixture(async (_client, payload, config) => {
    modelCalls.push(payload);
    assert.equal(config.provider, "localllm");
    assert.equal(config.baseURL, "http://127.0.0.1:8008/v1");
    assert.equal(config.model, LOCAL_MODEL.model);
    if (modelCalls.length === 1) {
      assert.equal(payload.tool_choice, "required");
      assert.match(payload.messages[0].content, /columns:\[\{key:'number',label:'Number'\}/u);
      assert.match(payload.messages[0].content, /do not use headers or positional row arrays/u);
      assert.match(payload.messages[0].content, /emit_markdown\(title, markdownText\)/u);
      return toolResponse([
        "values = [1, 4, 9]",
        "emit_plot('Square-number trend', {'schemaVersion':'1','type':'line','labels':['1','2','3'],'series':[{'name':'n squared','data':values}]})",
        "print('answer=9')",
      ].join("\n"), {}, { index: 0 });
    }
    const canonicalToolCall = payload.messages.at(-2).tool_calls[0];
    assert.equal(Object.hasOwn(canonicalToolCall, "index"), false);
    assert.deepEqual(Object.keys(canonicalToolCall).sort(), ["function", "id", "type"]);
    const feedback = JSON.parse(payload.messages.at(-1).content);
    assert.equal(feedback.ok, true);
    assert.equal(feedback.artifacts[0].kind, "plot");
    assert.equal(feedback.artifacts[0].pointCount, 3);
    assert.equal(Object.hasOwn(feedback.artifacts[0], "spec"), false);
    assert.equal(Object.hasOwn(feedback.artifacts[0], "id"), false);
    assert.match(feedback.stdout, /\[REDACTED\]/u);
    assert.match(feedback.stderr, /\[REDACTED_PATH\]/u);
    assert.doesNotMatch(payload.messages.at(-1).content, /abcdefghijklmnopqrstu|\/home\/private/u);
    return textResponse("The Python run completed and the square-number line plot is ready.");
  });
  const progress = [];
  const artifacts = [];
  const finals = [];
  const result = await planner.run(scope(), {
    prompt: "Run Python to calculate square numbers and show a line plot.",
    conversation: [{ role: "assistant", content: "I can calculate that." }],
  }, {
    onProgress(value) {
      progress.push(value);
    },
    onArtifact(value) {
      artifacts.push(value);
    },
    onFinal(value) {
      finals.push(value);
    },
  });
  assert.equal(result.kind, "analysis");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.executionStatus, "succeeded");
  assert.match(result.text, /plot is ready/u);
  assert.deepEqual(finals, [result]);
  assert.deepEqual(artifacts, result.artifacts);
  assert.deepEqual(artifacts.map(({ kind }) => kind), ["plot"]);
  assert(progress.some(({ phase }) => phase === "planning"));
  assert(progress.some(({ phase }) => phase === "executing"));
  assert(progress.some(({ phase }) => phase === "synthesizing"));
  const callbackJson = JSON.stringify({ progress, artifacts, finals });
  assert.doesNotMatch(callbackJson, /abcdefghijklmnopqrstu|\/home\/private|test-local-secret-credential|values =/u);
  assert.equal(rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length, 1);

  const proofJson = JSON.stringify(planner.attestation);
  assert.equal(planner.attestation.loopbackOnly, true);
  assert.equal(planner.attestation.callerSelectableEndpoint, false);
  assert.equal(planner.attestation.callerSelectableModel, false);
  assert.equal(planner.attestation.callerSelectableCredential, false);
  assert.equal(planner.attestation.maximumToolCalls, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS);
  assert.equal(planner.attestation.durableSessionIntegrated, false);
  assert.equal(planner.attestation.serverIntegrated, false);
  assert.doesNotMatch(proofJson, /127\.0\.0\.1|localllm-analysis-smoke|test-local-secret-credential/u);
  assertIntegrationAnalysisPlanner(planner, { requireSystemdCredential: false });
  assert.throws(() => assertIntegrationAnalysisPlanner(planner), /fixed LocalLLM binding/u);
  coordinator.close();
}

async function directAnswerDoesNotExecute() {
  const { planner, coordinator, rpcCalls } = fixture(async () =>
    textResponse("A median is the middle ordered value. Do not read /etc/passwd; token=abcdefghijklmnopqrstu")
  );
  const finalEvents = [];
  const result = await planner.run(scope("run_00000000-0000-4000-8000-000000000063"), {
    prompt: "What is a median?",
  }, {
    onFinal(value) {
      finalEvents.push(value);
    },
  });
  assert.equal(result.kind, "direct");
  assert.equal(result.toolCalls, 0);
  assert.equal(result.executionStatus, null);
  assert.deepEqual(result.artifacts, []);
  assert.match(result.text, /\[REDACTED_PATH\]/u);
  assert.match(result.text, /\[REDACTED\]/u);
  assert.doesNotMatch(result.text, /\/etc\/passwd|abcdefghijklmnopqrstu/u);
  assert.deepEqual(finalEvents, [result]);
  assert.equal(rpcCalls.some(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart), false);
  coordinator.close();
}

async function rejectsOverridesAndMalformedTools() {
  const direct = fixture(async () => textResponse("No execution needed."));
  await assert.rejects(
    direct.planner.run(scope(), { prompt: "Hello", baseURL: "http://attacker.invalid/v1" }),
    (error) => error?.code === "ANALYSIS_REQUEST_INVALID"
  );
  await assert.rejects(
    direct.planner.run(scope(), { prompt: "Hello" }, { model: "attacker-model" }),
    (error) => error?.code === "ANALYSIS_REQUEST_INVALID"
  );
  assert.throws(
    () => createTestOnlyIntegrationAnalysisPlanner({
      coordinator: direct.coordinator,
      localModelConfig: { ...LOCAL_MODEL, baseURL: "https://attacker.invalid/v1" },
      modelClient: {},
      complete: async () => textResponse("x"),
    }),
    (error) => error?.code === "ANALYSIS_CONFIGURATION_INVALID"
  );
  direct.coordinator.close();

  const required = fixture(async () => textResponse("Here is code you could run."));
  await assert.rejects(
    required.planner.run(scope(), { prompt: "Run this Python code and show me the result." }),
    (error) => error?.code === "ANALYSIS_TOOL_REQUIRED"
  );
  required.coordinator.close();

  const extraArgs = fixture(async () => toolResponse("print(1)", { endpoint: "http://attacker.invalid" }));
  await assert.rejects(
    extraArgs.planner.run(scope(), { prompt: "Execute Python code." }),
    (error) => error?.code === "ANALYSIS_TOOL_CALL_INVALID"
  );
  extraArgs.coordinator.close();

  for (const callExtras of [
    { index: 1 },
    { index: "0" },
    { index: null },
    { index: -0 },
    { position: 0 },
  ]) {
    const malformed = fixture(async () => toolResponse("print(1)", {}, callExtras));
    await assert.rejects(
      malformed.planner.run(scope(), { prompt: "Execute Python code." }),
      (error) => error?.code === "ANALYSIS_TOOL_CALL_INVALID"
    );
    malformed.coordinator.close();
  }

  const wrongTool = fixture(async () => ({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{
      id: "call_wrong",
      type: "function",
      function: { name: "run_shell", arguments: "{}" },
    }] } }],
  }));
  await assert.rejects(
    wrongTool.planner.run(scope(), { prompt: "Execute Python code." }),
    (error) => error?.code === "ANALYSIS_TOOL_FORBIDDEN"
  );
  wrongTool.coordinator.close();
}

async function enforcesToolLoopAndCancellation() {
  let step = 0;
  const loop = fixture(async () => {
    step += 1;
    if (step === 1) return toolResponse("print(1)");
    if (step === 2) return toolResponse("print(2)");
    return toolResponse("print(3)");
  });
  await assert.rejects(
    loop.planner.run(scope("run_00000000-0000-4000-8000-000000000064"), {
      prompt: "Run Python twice to compare two calculations.",
    }),
    (error) => error?.code === "ANALYSIS_TOOL_LIMIT"
  );
  assert.equal(step, 3);
  assert.equal(
    loop.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    INTEGRATION_ANALYSIS_MAX_TOOL_CALLS
  );
  loop.coordinator.close();

  const aborted = fixture(async (_client, _payload, config) => new Promise((resolve, reject) => {
    const onAbort = () => reject(config.abortSignal.reason || new Error("aborted"));
    config.abortSignal.addEventListener("abort", onAbort, { once: true });
    void resolve;
  }));
  const controller = new AbortController();
  const pending = aborted.planner.run(scope("run_00000000-0000-4000-8000-000000000065"), {
    prompt: "Explain quartiles.",
  }, { signal: controller.signal });
  controller.abort(new Error("private cancellation detail at /home/private"));
  await assert.rejects(
    pending,
    (error) => error?.code === "ANALYSIS_CANCELLED" && !error.message.includes("/home/private")
  );
  aborted.coordinator.close();
}

await executesAndSynthesizesPlot();
await directAnswerDoesNotExecute();
await rejectsOverridesAndMalformedTools();
await enforcesToolLoopAndCancellation();

console.log("integration analysis planner smoke passed");
