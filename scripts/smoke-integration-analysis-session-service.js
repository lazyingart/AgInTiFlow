import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import { INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM } from "../src/integration-api.js";
import {
  INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
  INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
  createTestOnlyIntegrationAnalysisPlanner,
} from "../src/integration-analysis-planner.js";
import {
  INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
  createTestOnlyIntegrationAnalysisCoordinator,
} from "../src/integration-analysis-coordinator.js";
import {
  INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
  assertIntegrationAnalysisSessionService,
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import {
  INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V2,
  INTEGRATION_ANALYSIS_STATE_STORAGE_V3,
} from "../src/integration-analysis-state-persistence.js";
import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import { INTEGRATION_RPC_PATHS, canonicalJson, contractDigest } from "../src/integration-policy.js";
import { validatePublicIntegrationEvent } from "../src/integration-events.js";

const PRINCIPAL_ID = "principal-analysis-0001";
const OTHER_PRINCIPAL_ID = "principal-analysis-0002";
const BROWSER_SESSION_ID = "b".repeat(64);
const OTHER_BROWSER_SESSION_ID = "c".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const RAW_SOURCE_MARKER = "RAW_EXECUTION_SOURCE_SHOULD_NOT_PERSIST";
const RAW_STDOUT_MARKER = "RAW_EXECUTION_STDOUT_SHOULD_NOT_PERSIST";
const EXPLICIT_PYTHON_SOURCE_MARKER = "RAW_EXPLICIT_PYTHON_AUTHORITATIVE_BOUNDARY_7f8c91";
const EXPLICIT_PYTHON_SOURCE = [
  `# ${EXPLICIT_PYTHON_SOURCE_MARKER}`,
  "values = [1, 4, 9]",
  "print('sum=' + str(sum(values)))",
  "emit_plot('Durable squares', {'schemaVersion':'1','type':'line','labels':['1','2','3'],'series':[{'name':'square','data':values}]})",
].join("\n");
const EXPLICIT_PYTHON_PROMPT =
  `Run this Python code and show the plot.\n\n\`\`\`python\n${EXPLICIT_PYTHON_SOURCE}\n\`\`\``;
const EXPRESSION_PLOT_PROMPT = "Plot y=x-e^x";
const PLOT_CONTINUATION_PROMPT =
  "Continue from the plot and describe the curve in one concise sentence.";
const PLOT_CONTINUATION_RESPONSE =
  "The curve rises to its maximum of -1 at x=0, then falls rapidly while remaining negative.";
const EXPLICIT_WORKER_ID = "worker_session_explicit_python_000001";
const EXPLICIT_LOCAL_MODEL = Object.freeze({
  baseURL: "http://127.0.0.1:8008/v1",
  model: "localllm-analysis-session-smoke",
  apiKey: "test-only-explicit-python-session-key",
  contextWindowTokens: 32_768,
  maxOutputTokens: 1_024,
  modelTimeoutMs: 30_000,
});

function context(principalId = PRINCIPAL_ID, browserSessionId = BROWSER_SESSION_ID) {
  return Object.freeze({ principalId, browserSessionId });
}

function mutationContext(pathname, payload, idempotencyKey, principalId = PRINCIPAL_ID, browserSessionId = BROWSER_SESSION_ID) {
  return Object.freeze({
    principalId,
    browserSessionId,
    pathname,
    payload,
    idempotencyKey,
    requestHash: contractDigest({
      algorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
      principalId,
      browserSessionId,
      operation: pathname,
      request: payload,
    }),
    idempotencyKeyDigest: crypto.createHash("sha256").update(idempotencyKey, "utf8").digest("hex"),
  });
}

function recoveryRequestFor(value) {
  return Object.freeze({
    principalId: value.principalId,
    browserSessionId: value.browserSessionId,
    pathname: value.pathname,
    requestHash: value.requestHash,
    idempotencyKeyDigest: value.idempotencyKeyDigest,
  });
}

function eventsRequest(runId) {
  return Object.freeze({ runId, afterSeq: 0, afterHash: ZERO_DIGEST });
}

function plannerResult({
  text = "Analysis completed safely.",
  artifacts = [],
  toolCalls = 1,
  executionStatus = toolCalls > 0 ? "succeeded" : null,
} = {}) {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text,
    kind: toolCalls > 0 ? "analysis" : "direct",
    toolCalls,
    executionStatus,
    artifacts: Object.freeze(artifacts),
  });
}

function plotArtifact() {
  return Object.freeze({
    id: `art_${"a".repeat(64)}`,
    title: "Quadratic plot",
    kind: "plot",
    spec: Object.freeze({
      schemaVersion: "1",
      type: "line",
      xLabel: "x",
      yLabel: "x squared",
      labels: Object.freeze(["0", "1", "2", "3"]),
      series: Object.freeze([
        Object.freeze({ name: "x squared", data: Object.freeze([0, 1, 4, 9]) }),
      ]),
    }),
  });
}

function sourcesArtifact(mode = "web") {
  return sanitizeIntegrationArtifact({
    title: "Grounded sources",
    kind: "sources",
    spec: {
      schemaVersion: "1",
      sources: [{
        index: 1,
        title: `Verified ${mode} source`,
        url: `https://example.test/evidence/${mode}`,
        snippet: "Bounded evidence persisted before the grounded answer was synthesized.",
        providers: ["provider-one"],
        kind: mode === "papers" ? "paper" : "web",
        publishedDate: "2026-08-25",
        doi: mode === "papers" ? "10.1234/aginti.search" : null,
      }],
    },
  });
}

function explicitWorkerCapability() {
  const core = Object.freeze({
    schemaVersion: EXECUTION_WORKER_SCHEMA_VERSION,
    workerId: EXPLICIT_WORKER_ID,
    implementation: "aginti-execution-worker",
    implementationVersion: "1",
    runtime: Object.freeze({
      profile: "python-bwrap-netless-v1",
      policyDigest: "8".repeat(64),
      runtimeDigest: "9".repeat(64),
      proofDigest: "a".repeat(64),
      seccomp: true,
      seccompPolicyVerified: true,
      seccompPolicyDigest: "b".repeat(64),
      deniedSyscallsProven: true,
      minimalRuntimeRoot: true,
      runtimeBundleDigestPinned: true,
      runtimeBundleRootDigest: "c".repeat(64),
    }),
    containment: Object.freeze({
      aggregateCgroupVerified: true,
      cgroupPolicyDigest: "d".repeat(64),
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

function explicitWorkerArtifact(request) {
  const artifact = Object.freeze({
    title: "Durable explicit Python squares",
    kind: "plot",
    spec: Object.freeze({
      schemaVersion: "1",
      type: "line",
      xLabel: "n",
      yLabel: "n squared",
      labels: Object.freeze(["1", "2", "3"]),
      series: Object.freeze([
        Object.freeze({ name: "square", data: Object.freeze([1, 4, 9]) }),
      ]),
    }),
  });
  return sanitizeIntegrationArtifact({
    id: `art_${contractDigest({
      jobId: request.jobId,
      attempt: request.attempt,
      index: 0,
      kind: artifact.kind,
      title: artifact.title,
      spec: artifact.spec,
    }).slice(0, 64)}`,
    ...artifact,
  });
}

function explicitWorkerResult(request, signal) {
  const status = signal?.aborted ? "cancelled" : "succeeded";
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status,
    exitCode: status === "succeeded" ? 0 : null,
    stdout: status === "succeeded" ? "sum=14\n" : "",
    stderr: "",
    outputTruncated: false,
    durationMs: 8,
    artifacts: status === "succeeded" ? Object.freeze([explicitWorkerArtifact(request)]) : Object.freeze([]),
  });
  return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
}

function explicitRpcForManager(manager, calls) {
  return async (pathname, body) => {
    let response;
    if (pathname === EXECUTION_WORKER_RPC_PATHS.capabilities) response = await manager.capabilities();
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart) response = await manager.start(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsStatus) response = manager.status(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsEvents) response = manager.events(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.jobsCancel) response = manager.cancel(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsList) response = manager.listArtifacts(body);
    else if (pathname === EXECUTION_WORKER_RPC_PATHS.artifactsGet) response = manager.getArtifact(body);
    else throw new Error("unexpected explicit Python execution RPC path");
    calls.push(Object.freeze({ pathname, body, response }));
    return Object.freeze({ schemaVersion: EXECUTION_WORKER_API_SCHEMA_VERSION, response });
  };
}

function createExplicitPythonRunnerFixture({ complete } = {}) {
  const workerSources = [];
  const rpcCalls = [];
  const modelPayloads = [];
  let modelCalls = 0;
  const worker = Object.freeze({
    capabilities: async () => explicitWorkerCapability(),
    async execute(request, { signal } = {}) {
      workerSources.push(request.source);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal?.addEventListener?.("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return explicitWorkerResult(request, signal);
    },
  });
  const manager = createExecutionJobManager({ worker });
  const client = createTestOnlyExecutionWorkerClient(explicitRpcForManager(manager, rpcCalls));
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(client, { pollMs: 25 });
  const planner = createTestOnlyIntegrationAnalysisPlanner({
    coordinator,
    localModelConfig: EXPLICIT_LOCAL_MODEL,
    modelClient: Object.freeze({ testOnly: true }),
    async complete(...args) {
      modelCalls += 1;
      modelPayloads.push(args[1]);
      if (complete) return complete(...args);
      throw new Error("LocalLLM must not run for an explicit fenced-Python request");
    },
  });
  return Object.freeze({
    planner,
    coordinator,
    rpcCalls,
    workerSources,
    modelPayloads,
    get modelCalls() {
      return modelCalls;
    },
  });
}

async function plotThenProseContinuationRoundTrip(temporaryRoot) {
  const root = path.join(temporaryRoot, "plot-continuation-state");
  let firstOutput = "";
  const fixture = createExplicitPythonRunnerFixture({
    async complete(_client, payload) {
      assert.equal(payload.messages.at(-1).role, "user");
      assert.equal(payload.messages.at(-1).content, PLOT_CONTINUATION_PROMPT);
      assert.deepEqual(payload.messages.slice(1), [
        { role: "user", content: EXPRESSION_PLOT_PROMPT },
        { role: "assistant", content: firstOutput },
        { role: "user", content: PLOT_CONTINUATION_PROMPT },
      ], "same-thread continuation lost or reordered its retained conversation");
      assert.equal("tools" in payload, false, "a direct prose continuation must not expose execution tools");
      assert.equal("tool_choice" in payload, false, "a direct prose continuation must not authorize a tool choice");
      assert.equal("parallel_tool_calls" in payload, false);
      return {
        choices: [{
          message: {
            role: "assistant",
            content: PLOT_CONTINUATION_RESPONSE,
            tool_calls: [],
          },
        }],
      };
    },
  });
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: fixture.planner,
    stateRoot: root,
  });
  let restarted = null;
  try {
    const created = await service.createThread({ title: "Plot then continue in prose" }, context());
    const threadId = created.thread.id;
    const started = await service.startRun({
      threadId,
      input: { text: EXPRESSION_PLOT_PROMPT },
    }, context());
    const firstRunId = started.run.id;
    await service.waitForIdle();

    const firstRun = (await service.getRunStatus({ runId: firstRunId }, context())).run;
    assert.equal(firstRun.status, "completed");
    firstOutput = firstRun.output;
    assert.match(firstOutput, /Plotted x - e \^ x/u);
    assert.equal(fixture.modelCalls, 0, "the deterministic expression plot must bypass LocalLLM");
    assert.equal(
      fixture.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
      1,
      "the first plot turn must create exactly one bounded worker job"
    );
    const firstArtifacts = await service.listArtifacts({ runId: firstRunId }, context());
    assert.equal(firstArtifacts.artifacts.length, 1);
    assert.equal(firstArtifacts.artifacts[0].kind, "plot");
    assert.equal(firstArtifacts.artifacts[0].runId, firstRunId);
    assert.equal(firstArtifacts.artifacts[0].threadId, threadId);

    const resumed = await service.resumeRun({
      runId: firstRunId,
      input: { text: PLOT_CONTINUATION_PROMPT },
    }, context());
    const successorRunId = resumed.run.id;
    assert.equal(resumed.run.previousRunId, firstRunId);
    assert.equal(resumed.run.threadId, threadId);
    await service.waitForIdle();

    const successor = (await service.getRunStatus({ runId: successorRunId }, context())).run;
    assert.equal(successor.status, "completed");
    assert.equal(successor.previousRunId, firstRunId);
    assert.equal(successor.output, PLOT_CONTINUATION_RESPONSE);
    assert.equal(fixture.modelCalls, 1, "the prose continuation must use exactly one direct model turn");
    assert.equal(fixture.modelPayloads.length, 1);
    assert.equal(
      fixture.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
      1,
      "the prose continuation must not create another execution-worker job"
    );
    assert.equal(fixture.workerSources.length, 1);

    const successorArtifacts = await service.listArtifacts({ runId: successorRunId }, context());
    assert.deepEqual(successorArtifacts.artifacts, []);
    assert.deepEqual(
      (await service.listArtifacts({ runId: firstRunId }, context())).artifacts,
      firstArtifacts.artifacts,
      "the successor must retain the first run's plot artifact and ownership"
    );
    const loadedArtifact = await service.getArtifact({ artifactId: firstArtifacts.artifacts[0].id }, context());
    assert.equal(loadedArtifact.artifact.runId, firstRunId);
    assert.equal(loadedArtifact.artifact.threadId, threadId);

    const thread = (await service.getThread({ threadId }, context())).thread;
    assert.deepEqual(thread.messages.map(({ role }) => role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(thread.messages.map(({ content }) => content), [
      EXPRESSION_PLOT_PROMPT,
      firstOutput,
      PLOT_CONTINUATION_PROMPT,
      PLOT_CONTINUATION_RESPONSE,
    ]);
    assert.deepEqual(thread.messages.map(({ runId }) => runId), [
      firstRunId,
      firstRunId,
      successorRunId,
      successorRunId,
    ]);

    await service.close({ mode: "wait" });
    service = null;
    restarted = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fixture.planner,
      stateRoot: root,
    });
    assert.equal((await restarted.getRunStatus({ runId: successorRunId }, context())).run.previousRunId, firstRunId);
    assert.deepEqual((await restarted.getThread({ threadId }, context())).thread.messages, thread.messages);
    assert.deepEqual(
      (await restarted.listArtifacts({ runId: firstRunId }, context())).artifacts,
      firstArtifacts.artifacts,
      "the first plot artifact changed after durable restart"
    );
    assert.equal(fixture.workerSources.length, 1, "durable replay must not rerun either turn");
    assert.equal(fixture.modelCalls, 1, "durable replay must not repeat the prose completion");
  } finally {
    await service?.close({ mode: "abort" }).catch(() => {});
    await restarted?.close({ mode: "abort" }).catch(() => {});
    fixture.coordinator.close();
  }
}

function runnerError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publicCode = code;
  return error;
}

function activationProof() {
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
    ready: true,
    publicActivationReady: true,
    workerCapabilityDigest: "1".repeat(64),
    workerHealthDigest: "2".repeat(64),
    coordinatorProtocolDigest: "3".repeat(64),
    coordinatorHealthDigest: "4".repeat(64),
    runtimeProfile: "python312-curated-root-v1",
    runtimeBundleRootDigest: "5".repeat(64),
    seccompPolicyDigest: "6".repeat(64),
    cgroupPolicyDigest: "7".repeat(64),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function createFakeRunner() {
  const held = new Map();
  const calls = [];
  const runner = {
    calls,
    held,
    async run(scope, input, options) {
      calls.push(Object.freeze({
        scope: Object.freeze({ ...scope }),
        prompt: input.prompt,
        conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
      }));
      if (input.prompt.includes("hold")) {
        return new Promise((resolve, reject) => {
          const abort = () => {
            held.delete(scope.runId);
            reject(runnerError("ANALYSIS_CANCELLED", "cancelled"));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          held.set(scope.runId, Object.freeze({
            reject,
            async release(value = plannerResult({ toolCalls: 0 })) {
              options.signal?.removeEventListener("abort", abort);
              held.delete(scope.runId);
              try {
                await options.onFinal?.(value);
                resolve(value);
              } catch (error) {
                reject(error);
              }
            },
          }));
        });
      }
      if (input.prompt.includes("plot artifact rejection")) {
        throw runnerError(
          "ANALYSIS_PLOT_ARTIFACT_REQUIRED",
          `poisoned ${RAW_SOURCE_MARKER} /root/private/plot.log`
        );
      }
      if (input.prompt.includes("fail")) {
        throw runnerError("ANALYSIS_MODEL_UNAVAILABLE", `private ${RAW_SOURCE_MARKER} /root/private/model.log`);
      }
      if (input.prompt.includes("return unsuccessful execution result")) {
        await options.onProgress?.(Object.freeze({ phase: "planning", toolCallsCompleted: 0 }));
        for (let toolCallNumber = 1; toolCallNumber <= INTEGRATION_ANALYSIS_MAX_TOOL_CALLS; toolCallNumber += 1) {
          await options.onProgress?.(Object.freeze({
            phase: "executing",
            toolCallsCompleted: toolCallNumber - 1,
            toolName: "execute_python_analysis",
            toolCallNumber,
            executionState: "failed",
          }));
        }
        const result = plannerResult({
          text: "Let me fix this in a later response.",
          toolCalls: INTEGRATION_ANALYSIS_MAX_TOOL_CALLS,
          executionStatus: "failed",
        });
        await options.onFinal?.(result);
        return result;
      }
      await options.onProgress?.(Object.freeze({ phase: "planning", toolCallsCompleted: 0 }));
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "starting",
      }));
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "running",
      }));
      const artifact = plotArtifact();
      await options.onArtifact?.(artifact);
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "succeeded",
      }));
      await options.onProgress?.(Object.freeze({
        phase: "synthesizing",
        toolCallsCompleted: 1,
        executionSucceeded: true,
        artifactCount: 1,
      }));
      // These values model private coordinator internals and are intentionally
      // never passed through the public planner result or callbacks.
      void RAW_SOURCE_MARKER;
      void RAW_STDOUT_MARKER;
      const result = plannerResult({
        text: "The plot is ready. Internal file /root/private/result.txt was hidden.",
        artifacts: [artifact],
      });
      await options.onFinal?.(result);
      return result;
    },
  };
  return runner;
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code || error?.publicCode, code);
    return true;
  });
}

async function concurrentNoFileDeleteStartRoundTrip(temporaryRoot, analysisRunner) {
  const stateRoot = path.join(temporaryRoot, "concurrent-no-file-delete-state");
  const service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner, stateRoot });
  try {
    const created = await service.createThread({ title: "Atomic delete boundary" }, context());
    const deletePayload = Object.freeze({ threadId: created.thread.id });
    const deleteContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsDelete,
      deletePayload,
      "concurrent-delete-receipt-key-0001"
    );
    const startPayload = Object.freeze({
      threadId: created.thread.id,
      input: Object.freeze({ text: "This run must not slip through the delete boundary." }),
    });
    const [deleted, started] = await Promise.allSettled([
      service.deleteThread(deletePayload, deleteContext),
      service.startRun(startPayload, context()),
    ]);
    assert.equal(deleted.status, "fulfilled");
    assert.equal(deleted.value.deleted, true);
    assert.equal(started.status, "rejected");
    assert.equal(started.reason?.code, "NOT_FOUND");
    assert.deepEqual(await service.recoverMutation(recoveryRequestFor(deleteContext)), {
      schemaVersion: "1",
      deleted: true,
      threadId: created.thread.id,
    });
    const persisted = JSON.parse(await fs.readFile(await stateFile(stateRoot), "utf8"));
    assert.equal(persisted.state.threads.some(({ id }) => id === created.thread.id), false);
    assert.equal(persisted.state.runs.some(({ threadId }) => threadId === created.thread.id), false);
    assert.equal(persisted.state.mutationReceipts.length, 1);
  } finally {
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

function assertLedger(events, runId, threadId) {
  assert.ok(events.length > 0);
  let previousHash = ZERO_DIGEST;
  for (let index = 0; index < events.length; index += 1) {
    const event = validatePublicIntegrationEvent(events[index]);
    assert.equal(event.id, `${runId}.${index + 1}`);
    assert.equal(event.seq, index + 1);
    assert.equal(event.runId, runId);
    assert.equal(event.threadId, threadId);
    assert.equal(event.previousHash, previousHash);
    previousHash = event.hash;
  }
}

async function stateFile(root) {
  const scopeEntries = await fs.readdir(path.join(root, "scopes"));
  assert.equal(scopeEntries.length, 1);
  assert.match(scopeEntries[0], /^[a-f0-9]{64}$/u);
  return path.join(root, "scopes", scopeEntries[0], "state.json");
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys changed`);
}

async function assertR67CompatibleStateFile(root) {
  const text = await fs.readFile(await stateFile(root), "utf8");
  const envelope = JSON.parse(text);
  exactKeys(envelope, ["schemaVersion", "state", "digest"], "v2 envelope");
  assert.equal(envelope.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V2);
  assert.equal(envelope.state.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V2);
  assert.equal(envelope.digest, contractDigest({ schemaVersion: envelope.schemaVersion, state: envelope.state }));
  assert.equal(text, `${canonicalJson(envelope)}\n`);
  exactKeys(
    envelope.state,
    ["schemaVersion", "scope", "revision", "threads", "runs", "artifacts", "mutationReceipts"],
    "v2 state"
  );
  for (const run of envelope.state.runs) {
    exactKeys(
      run,
      [
        "id", "threadId", "previousRunId", "principalId", "browserSessionId", "browserSessionPolicy",
        "status", "schedulingState", "createdAt", "startedAt", "completedAt", "cancelRequestedAt",
        "output", "error", "authority", "inputMessageId", "events",
      ],
      "v2 run"
    );
    assert.equal(Object.prototype.hasOwnProperty.call(run, "lineagePreviousRunId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(run, "search"), false);
  }
  for (const artifact of envelope.state.artifacts) {
    exactKeys(
      artifact,
      [
        "id", "title", "kind", "spec", "principalId", "browserSessionId", "browserSessionPolicy",
        "threadId", "runId", "createdAt",
      ],
      "v2 artifact"
    );
    assert.ok(new Set(["plot", "table", "markdown"]).has(artifact.kind));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(envelope.state, "documentCommitIntents"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope.state, "documentDeletionIntents"), false);
  return Object.freeze({ text, envelope });
}

function compatibilityArtifact(kind, runId) {
  const id = `art_${contractDigest({ kind, runId })}`;
  if (kind === "plot") {
    return sanitizeIntegrationArtifact({
      id,
      title: "Compatibility plot",
      kind,
      spec: {
        schemaVersion: "1",
        type: "line",
        xLabel: "x",
        yLabel: "y",
        labels: ["0", "1"],
        series: [{ name: "value", data: [0, 1] }],
      },
    });
  }
  if (kind === "table") {
    return sanitizeIntegrationArtifact({
      id,
      title: "Compatibility table",
      kind,
      spec: {
        schemaVersion: "1",
        columns: [{ key: "name", label: "Name" }, { key: "value", label: "Value" }],
        rows: [{ name: "one", value: 1 }],
      },
    });
  }
  return sanitizeIntegrationArtifact({
    id,
    title: "Compatibility markdown",
    kind: "markdown",
    spec: { schemaVersion: "1", markdown: "Compatibility **markdown** artifact." },
  });
}

function createR67CompatibilityRunner() {
  const calls = [];
  const runner = {
    calls,
    async run(scope, input, options) {
      calls.push(Object.freeze({
        runId: scope.runId,
        prompt: input.prompt,
        conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
      }));
      if (input.prompt === "hold cancellation") {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(runnerError("ANALYSIS_CANCELLED", "cancelled"));
          options.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const kind = new Set(["plot", "table", "markdown"]).has(input.prompt) ? input.prompt : null;
      await options.onProgress?.(Object.freeze({ phase: "planning", toolCallsCompleted: 0 }));
      let artifact = null;
      if (kind) {
        await options.onProgress?.(Object.freeze({
          phase: "executing",
          toolCallsCompleted: 0,
          toolName: "execute_python_analysis",
          toolCallNumber: 1,
          executionState: "running",
        }));
        artifact = compatibilityArtifact(kind, scope.runId);
        await options.onArtifact?.(artifact);
        await options.onProgress?.(Object.freeze({
          phase: "executing",
          toolCallsCompleted: 0,
          toolName: "execute_python_analysis",
          toolCallNumber: 1,
          executionState: "succeeded",
        }));
      }
      const result = plannerResult({
        text: kind ? `${kind} compatibility result` : `direct compatibility result ${calls.length}`,
        artifacts: artifact ? [artifact] : [],
        toolCalls: artifact ? 1 : 0,
      });
      await options.onFinal?.(result);
      return result;
    },
  };
  return runner;
}

async function r67StatePersistenceCompatibilityRoundTrip(temporaryRoot) {
  const root = path.join(temporaryRoot, "r67-compatible-v2-state");
  const mode = INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.r67CompatibleV2;
  const runner = createR67CompatibilityRunner();
  assert.throws(
    () => createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: path.join(temporaryRoot, "r67-search-refusal"),
      statePersistenceMode: mode,
      searchEnabled: true,
    }),
    (error) => error?.code === "ANALYSIS_CONFIGURATION_INVALID"
  );
  assert.throws(
    () => createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: path.join(temporaryRoot, "r67-document-refusal"),
      statePersistenceMode: mode,
      documentWorkerEnabled: true,
    }),
    (error) => error?.code === "ANALYSIS_CONFIGURATION_INVALID"
  );

  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot: root,
    statePersistenceMode: mode,
  });
  let native = null;
  let refused = null;
  try {
    const capabilities = await service.getIntegrationCapabilities();
    assert.equal(capabilities.analysisSessionAuthority.statePersistenceMode, mode);
    assert.equal(capabilities.analysisSessionAuthority.stateStorageVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V2);
    assert.equal(capabilities.analysisSessionAuthority.r67RollbackCompatible, true);

    const created = await service.createThread({ title: "R67-compatible chat" }, context());
    const threadId = created.thread.id;
    await service.updateThread({ threadId, title: "R67-compatible chat updated" }, context());
    await assertR67CompatibleStateFile(root);

    const completedRunIds = [];
    for (const prompt of ["plot", "ordinary follow-up", "table", "markdown"]) {
      const started = await service.startRun({ threadId, input: { text: prompt } }, context());
      completedRunIds.push(started.run.id);
      await service.waitForIdle();
      assert.equal((await service.getRunStatus({ runId: started.run.id }, context())).run.status, "completed");
      await assertR67CompatibleStateFile(root);
    }
    const resumed = await service.resumeRun({
      runId: completedRunIds.at(-1),
      input: { text: "explicit resume" },
    }, context());
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: resumed.run.id }, context())).run.status, "completed");
    await assertR67CompatibleStateFile(root);

    const cancelThread = await service.createThread({ title: "R67-compatible cancellation" }, context());
    const held = await service.startRun({
      threadId: cancelThread.thread.id,
      input: { text: "hold cancellation" },
    }, context());
    await waitFor(() => runner.calls.some(({ runId }) => runId === held.run.id), "compatibility cancellation start");
    await service.cancelRun({ runId: held.run.id }, context());
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: held.run.id }, context())).run.status, "cancelled");
    await service.deleteThread({ threadId: cancelThread.thread.id }, context());
    await assertR67CompatibleStateFile(root);

    const expectedMessages = (await service.getThread({ threadId }, context())).thread.messages;
    await service.close({ mode: "wait" });
    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: root,
      statePersistenceMode: mode,
    });
    assert.deepEqual((await service.getThread({ threadId }, context())).thread.messages, expectedMessages);
    await service.updateThread({ threadId, title: "R67 reopened and mutated" }, context());
    await assertR67CompatibleStateFile(root);
    await service.close({ mode: "wait" });
    service = null;

    native = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: root,
      statePersistenceMode: INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES.nativeV3,
    });
    await native.updateThread({ threadId, title: "Native v3 floor" }, context());
    await native.close({ mode: "wait" });
    native = null;
    const v3Bytes = await fs.readFile(await stateFile(root), "utf8");
    const v3Envelope = JSON.parse(v3Bytes);
    assert.equal(v3Envelope.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);
    assert.equal(v3Envelope.state.schemaVersion, INTEGRATION_ANALYSIS_STATE_STORAGE_V3);

    refused = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: root,
      statePersistenceMode: mode,
    });
    await expectCode(refused.getThread({ threadId }, context()), "ANALYSIS_STATE_PERSISTENCE_INCOMPATIBLE");
    assert.equal(await fs.readFile(await stateFile(root), "utf8"), v3Bytes, "v2 refusal changed native-v3 bytes");
  } finally {
    await service?.close({ mode: "abort" }).catch(() => {});
    await native?.close({ mode: "abort" }).catch(() => {});
    await refused?.close({ mode: "abort" }).catch(() => {});
  }
}

async function explicitPythonDurabilityRoundTrip(temporaryRoot) {
  const root = path.join(temporaryRoot, "explicit-python-state");
  const fixture = createExplicitPythonRunnerFixture();
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: fixture.planner,
    stateRoot: root,
  });
  let restarted = null;
  try {
    const created = await service.createThread({ title: "Explicit Python durability" }, context());
    const threadId = created.thread.id;
    const started = await service.startRun(
      { threadId, input: { text: EXPLICIT_PYTHON_PROMPT } },
      context()
    );
    const runId = started.run.id;
    await service.waitForIdle();

    const completed = (await service.getRunStatus({ runId }, context())).run;
    assert.equal(
      completed.status,
      "completed",
      `explicit Python run failed: ${JSON.stringify({ error: completed.error, rpc: fixture.rpcCalls.map(({ pathname, response }) => ({ pathname, state: response?.state, errorCode: response?.errorCode })), workerSourceCount: fixture.workerSources.length, modelCalls: fixture.modelCalls })}`
    );
    assert.match(completed.output, /Python execution completed successfully/u);
    assert.match(completed.output, /sum=14/u);
    assert.doesNotMatch(completed.output, new RegExp(EXPLICIT_PYTHON_SOURCE_MARKER, "u"));
    assert.equal(fixture.modelCalls, 0, "explicit fenced Python must bypass LocalLLM");
    assert.deepEqual(fixture.workerSources, [EXPLICIT_PYTHON_SOURCE]);
    assert.equal(
      fixture.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
      1,
      "explicit fenced Python must create exactly one bounded worker job"
    );

    const eventResult = await service.loadRunEvents(eventsRequest(runId), context());
    const events = await eventResult.publicEventLedger.loadEventsAfter(0);
    assertLedger(events, runId, threadId);
    const eventTypes = events.map(({ type }) => type);
    assert.equal(eventTypes.filter((type) => type === "tool.started").length, 1);
    assert.equal(eventTypes.filter((type) => type === "tool.completed").length, 1);
    assert.equal(eventTypes.filter((type) => type === "tool.failed").length, 0);
    assert.equal(eventTypes.filter((type) => type === "artifact.created").length, 1);
    assert.equal(eventTypes.filter((type) => type === "run.completed").length, 1);
    assert.ok(eventTypes.indexOf("plan.updated") < eventTypes.indexOf("tool.started"));
    assert.ok(eventTypes.indexOf("tool.started") < eventTypes.indexOf("tool.completed"));
    assert.ok(eventTypes.indexOf("tool.completed") < eventTypes.indexOf("run.completed"));
    assert.ok(eventTypes.indexOf("artifact.created") < eventTypes.indexOf("run.completed"));
    assert.ok(eventTypes.indexOf("output.completed") < eventTypes.indexOf("run.completed"));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(EXPLICIT_PYTHON_SOURCE_MARKER, "u"));
    for (const event of events.filter(({ type }) =>
      type.startsWith("tool.") || type === "run.completed" || type === "output.completed"
    )) {
      assert.doesNotMatch(JSON.stringify(event.payload), new RegExp(EXPLICIT_PYTHON_SOURCE_MARKER, "u"));
    }

    const artifacts = await service.listArtifacts({ runId }, context());
    assert.deepEqual(artifacts.artifacts.map(({ kind }) => kind), ["plot"]);
    const thread = (await service.getThread({ threadId }, context())).thread;
    assert.deepEqual(thread.messages.map(({ role }) => role), ["user", "assistant"]);
    assert.equal(thread.messages[0].content, EXPLICIT_PYTHON_PROMPT);
    assert.doesNotMatch(thread.messages[1].content, new RegExp(EXPLICIT_PYTHON_SOURCE_MARKER, "u"));
    assert.equal(
      thread.messages.filter(({ content }) => content.includes(EXPLICIT_PYTHON_SOURCE_MARKER)).length,
      1,
      "the authoritative user message must be the only public source boundary"
    );

    const persistedFile = await stateFile(root);
    const persistedText = await fs.readFile(persistedFile, "utf8");
    assert.equal(
      persistedText.split(EXPLICIT_PYTHON_SOURCE_MARKER).length - 1,
      1,
      "raw explicit Python must be persisted exactly once, inside the user message"
    );
    assert.equal((await fs.stat(persistedFile)).mode & 0o777, 0o600);

    await expectCode(
      service.getRunStatus({ runId }, context(PRINCIPAL_ID, OTHER_BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );
    await expectCode(
      service.loadRunEvents(eventsRequest(runId), context(OTHER_PRINCIPAL_ID, BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );

    await service.close({ mode: "wait" });
    service = null;
    restarted = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fixture.planner,
      stateRoot: root,
    });
    const replayedRun = (await restarted.getRunStatus({ runId }, context())).run;
    assert.equal(replayedRun.status, "completed");
    assert.equal(replayedRun.eventCursor.lastHash, completed.eventCursor.lastHash);
    const replayResult = await restarted.loadRunEvents(eventsRequest(runId), context());
    const replayedEvents = await replayResult.publicEventLedger.loadEventsAfter(0);
    assert.deepEqual(replayedEvents, events, "explicit Python event replay changed after restart");
    assert.deepEqual(
      (await restarted.getThread({ threadId }, context())).thread.messages,
      thread.messages,
      "explicit Python message replay changed after restart"
    );
    assert.deepEqual(
      (await restarted.listArtifacts({ runId }, context())).artifacts,
      artifacts.artifacts,
      "explicit Python artifacts changed after restart"
    );
    assert.deepEqual(fixture.workerSources, [EXPLICIT_PYTHON_SOURCE], "terminal replay must not rerun Python");
    assert.equal(fixture.modelCalls, 0, "terminal replay must not invoke LocalLLM");
  } finally {
    await service?.close({ mode: "abort" }).catch(() => {});
    await restarted?.close({ mode: "abort" }).catch(() => {});
    fixture.coordinator.close();
  }
}

async function groundedSearchDurabilityRoundTrip(temporaryRoot) {
  const root = path.join(temporaryRoot, "grounded-search-state");
  const calls = [];
  const runner = Object.freeze({
    async run(scope, input, options = {}) {
      const serialized = JSON.parse(await fs.readFile(await stateFile(root), "utf8"));
      const persisted = serialized.state.runs.find((run) => run.id === scope.runId);
      assert(persisted, "run must be durable before the grounded-search runner starts");
      assert.deepEqual(persisted.search, input.search, "exact search intent must be durable before upstream work");
      calls.push(Object.freeze({ scope, input }));
      if (input.prompt === "Trigger a bounded search failure") {
        const error = new Error("private upstream details must not escape");
        error.code = "GROUNDED_SEARCH_TIMEOUT";
        throw error;
      }
      const artifacts = input.search === undefined ? [] : [sourcesArtifact(input.search.mode)];
      for (const artifact of artifacts) await options.onArtifact?.(artifact);
      const result = plannerResult({
        text: input.search === undefined ? "Corrected local answer." : `Grounded ${input.search.mode} answer [1].`,
        artifacts,
        toolCalls: 0,
      });
      await options.onFinal?.(result);
      return result;
    },
  });
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot: root,
    searchEnabled: true,
  });
  let restarted;
  try {
    const capabilities = await service.getIntegrationCapabilities();
    assert.equal(capabilities.search, true);
    assert.equal(capabilities.analysisSessionAuthority.groundedSearchReady, true);
    const created = await service.createThread({ title: "Durable grounded search" }, context());
    const firstSearch = Object.freeze({ mode: "both", limit: 7 });
    const first = await service.startRun({
      threadId: created.thread.id,
      input: { text: "Compare current evidence", search: firstSearch },
    }, context());
    await service.waitForIdle();
    assert.deepEqual(calls[0].input.search, firstSearch);
    const firstArtifacts = await service.listArtifacts({ runId: first.run.id }, context());
    assert.equal(firstArtifacts.artifacts.length, 1);
    assert.equal(firstArtifacts.artifacts[0].kind, "sources");

    const callsBeforeReplay = calls.length;
    await service.close({ mode: "wait" });
    service = null;
    restarted = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot: root,
      searchEnabled: true,
    });
    await restarted.getThread({ threadId: created.thread.id }, context());
    await restarted.getRunStatus({ runId: first.run.id }, context());
    await restarted.loadRunEvents(eventsRequest(first.run.id), context());
    assert.equal(calls.length, callsBeforeReplay, "restart, reload, and replay must never issue another search");

    const sameInput = await restarted.resumeRun({ runId: first.run.id }, context());
    await restarted.waitForIdle();
    assert.deepEqual(calls[1].input.search, firstSearch, "same-input Resume must reuse durable search intent");

    const correctedSearch = Object.freeze({ mode: "papers", limit: 4 });
    const corrected = await restarted.resumeRun({
      runId: sameInput.run.id,
      input: { text: "Use peer-reviewed evidence only", search: correctedSearch },
    }, context());
    await restarted.waitForIdle();
    assert.deepEqual(calls[2].input.search, correctedSearch, "corrected Resume may replace search intent");

    await restarted.resumeRun({
      runId: corrected.run.id,
      input: { text: "Answer locally without retrieval" },
    }, context());
    await restarted.waitForIdle();
    assert.equal(calls[3].input.search, undefined, "corrected Resume without search must disable retrieval");

    const failedSearch = Object.freeze({ mode: "web", limit: 5 });
    const failed = await restarted.startRun({
      threadId: created.thread.id,
      input: { text: "Trigger a bounded search failure", search: failedSearch },
    }, context());
    await restarted.waitForIdle();
    const failedStatus = (await restarted.getRunStatus({ runId: failed.run.id }, context())).run;
    assert.equal(failedStatus.status, "failed");
    assert.equal(failedStatus.error.code, "GROUNDED_SEARCH_TIMEOUT");
    assert.match(failedStatus.error.message, /prompt and search settings were preserved/u);
    assert.doesNotMatch(JSON.stringify(failedStatus), /private upstream details/u);
    const failedState = JSON.parse(await fs.readFile(await stateFile(root), "utf8"));
    assert.deepEqual(
      failedState.state.runs.find((run) => run.id === failed.run.id).search,
      failedSearch,
      "failed retrieval must retain exact durable search intent"
    );
  } finally {
    await service?.close({ mode: "abort" }).catch(() => {});
    await restarted?.close({ mode: "abort" }).catch(() => {});
  }

  const disabledRoot = path.join(temporaryRoot, "grounded-search-disabled-state");
  const disabled = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: runner, stateRoot: disabledRoot });
  try {
    const thread = await disabled.createThread({ title: "Search disabled" }, context());
    await expectCode(disabled.startRun({
      threadId: thread.thread.id,
      input: { text: "Attempt disabled search", search: { mode: "web", limit: 3 } },
    }, context()), "GROUNDED_SEARCH_NOT_READY");
  } finally {
    await disabled.close({ mode: "abort" }).catch(() => {});
  }
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-session-"));
  const root = path.join(temporaryRoot, "state");
  const fakeRunner = createFakeRunner();
  try {
    await explicitPythonDurabilityRoundTrip(temporaryRoot);
    await plotThenProseContinuationRoundTrip(temporaryRoot);
    await groundedSearchDurabilityRoundTrip(temporaryRoot);
    await r67StatePersistenceCompatibilityRoundTrip(temporaryRoot);
    await concurrentNoFileDeleteStartRoundTrip(temporaryRoot, fakeRunner);
    const service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    assertIntegrationAnalysisSessionService(service, { allowTestOnly: true });
    assert.throws(() => assertIntegrationAnalysisSessionService(service), /test-only/u);
    for (const method of [
      "getIntegrationCapabilities",
      "recoverMutation",
      "listThreads",
      "createThread",
      "getThread",
      "updateThread",
      "deleteThread",
      "startRun",
      "getRunStatus",
      "loadRunEvents",
      "cancelRun",
      "resumeRun",
      "listArtifacts",
      "getArtifact",
      "beginDrain",
      "close",
    ]) {
      assert.equal(typeof service[method], "function", `${method} is missing`);
    }
    const capabilities = await service.getIntegrationCapabilities();
    assert.equal(capabilities.cancel, true);
    assert.equal(capabilities.resume, true);
    assert.equal(capabilities.analysisSessionAuthority.schemaVersion, INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION);
    assert.equal(capabilities.analysisSessionAuthority.ready, false);
    assert.equal(capabilities.analysisSessionAuthority.testOnly, true);
    assert.equal(capabilities.analysisSessionAuthority.atomicTempFsyncRename, true);
    assert.equal(capabilities.analysisSessionAuthority.publicEventHashChain, true);
    assert.equal(capabilities.analysisSessionAuthority.exclusiveServiceLifetimeLock, true);
    assert.equal(capabilities.analysisSessionAuthority.crossProcessSafe, true);
    assert.equal(capabilities.analysisSessionAuthority.maximumConcurrentPlannerRuns, 2);
    assert.equal(capabilities.analysisSessionAuthority.publicActivationLocksChanged, false);
    assert.equal(capabilities.analysisSessionAuthority.durableMutationReceipts, true);
    assert.equal(capabilities.mutationRecoveryAuthority.atomicWithMutation, true);
    assert.equal(capabilities.mutationRecoveryAuthority.blindRedispatch, false);
    assert.equal(
      capabilities.analysisSessionAuthority.mutationRecoveryAuthorityDigest,
      capabilities.mutationRecoveryAuthority.digest
    );

    const proofBoundService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: path.join(temporaryRoot, "proof-bound-state"),
      activationProof: activationProof(),
    });
    const proofBoundAttestation = await proofBoundService.getAnalysisSessionAttestation();
    assert.equal(proofBoundAttestation.activationProofPinnedAtStartup, true);
    assert.equal(proofBoundAttestation.activationProof.digest, proofBoundAttestation.activationProofDigest);
    await proofBoundService.close();

    const receiptRoot = path.join(temporaryRoot, "receipt-state");
    const receiptService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: receiptRoot,
    });
    const receiptPayload = Object.freeze({ title: "Atomic mutation receipt" });
    const rawIdempotencyKey = "mutation-receipt-secret-key-0001";
    const receiptContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsCreate,
      receiptPayload,
      rawIdempotencyKey
    );
    const receiptCreated = await receiptService.createThread(receiptPayload, receiptContext);
    const recoveryRequest = recoveryRequestFor(receiptContext);
    const recoveredReceipt = await receiptService.recoverMutation(recoveryRequest);
    assert.equal(recoveredReceipt.schemaVersion, "1");
    assert.equal(recoveredReceipt.thread.id, receiptCreated.thread.id);

    const updatePayload = Object.freeze({ threadId: receiptCreated.thread.id, title: "Receipt updated" });
    const updateContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsUpdate,
      updatePayload,
      "mutation-receipt-secret-key-0002"
    );
    const updatedReceiptThread = await receiptService.updateThread(updatePayload, updateContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(updateContext))).thread.title,
      updatedReceiptThread.thread.title
    );

    const startPayload = Object.freeze({
      threadId: receiptCreated.thread.id,
      input: Object.freeze({ text: "Run receipt plot" }),
    });
    const startContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsStart,
      startPayload,
      "mutation-receipt-secret-key-0003"
    );
    const receiptStarted = await receiptService.startRun(startPayload, startContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(startContext))).run.id,
      receiptStarted.run.id
    );
    await receiptService.waitForIdle();

    const heldPayload = Object.freeze({
      threadId: receiptCreated.thread.id,
      input: Object.freeze({ text: "hold for receipt cancellation" }),
    });
    const heldContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsStart,
      heldPayload,
      "mutation-receipt-secret-key-0004"
    );
    const heldReceiptRun = await receiptService.startRun(heldPayload, heldContext);
    await waitFor(() => fakeRunner.held.has(heldReceiptRun.run.id), "receipt cancellation runner start");
    const cancelPayload = Object.freeze({ runId: heldReceiptRun.run.id });
    const cancelContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsCancel,
      cancelPayload,
      "mutation-receipt-secret-key-0005"
    );
    const cancelledReceiptRun = await receiptService.cancelRun(cancelPayload, cancelContext);
    assert.equal(cancelledReceiptRun.run.status, "cancelled");
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(cancelContext))).run.status,
      "cancelled"
    );
    await receiptService.waitForIdle();

    const resumePayload = Object.freeze({
      runId: heldReceiptRun.run.id,
      input: Object.freeze({ text: "answer the receipt resume" }),
    });
    const resumeContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsResume,
      resumePayload,
      "mutation-receipt-secret-key-0006"
    );
    const resumedReceiptRun = await receiptService.resumeRun(resumePayload, resumeContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(resumeContext))).run.id,
      resumedReceiptRun.run.id
    );
    await receiptService.waitForIdle();

    const deletePayload = Object.freeze({ threadId: receiptCreated.thread.id });
    const deleteContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsDelete,
      deletePayload,
      "mutation-receipt-secret-key-0007"
    );
    await receiptService.deleteThread(deletePayload, deleteContext);
    assert.deepEqual(await receiptService.recoverMutation(recoveryRequestFor(deleteContext)), {
      schemaVersion: "1",
      deleted: true,
      threadId: receiptCreated.thread.id,
    });
    const receiptStatePath = await stateFile(receiptRoot);
    const receiptStateBytes = await fs.readFile(receiptStatePath, "utf8");
    assert.doesNotMatch(receiptStateBytes, new RegExp(rawIdempotencyKey, "u"));
    assert.equal(JSON.parse(receiptStateBytes).state.mutationReceipts.length, 7);
    await expectCode(
      receiptService.recoverMutation({ ...recoveryRequest, requestHash: "f".repeat(64) }),
      "IDEMPOTENCY_CONFLICT"
    );
    assert.equal(
      await receiptService.recoverMutation({ ...recoveryRequest, idempotencyKeyDigest: "e".repeat(64) }),
      null
    );
    await receiptService.close({ mode: "wait" });

    const restartedReceiptService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: receiptRoot,
    });
    assert.deepEqual(await restartedReceiptService.recoverMutation(recoveryRequest), recoveredReceipt);
    const corruptReceiptEnvelope = JSON.parse(receiptStateBytes);
    corruptReceiptEnvelope.state.mutationReceipts[0].response.thread.title = "Corrupted receipt";
    corruptReceiptEnvelope.digest = contractDigest({
      schemaVersion: corruptReceiptEnvelope.schemaVersion,
      state: corruptReceiptEnvelope.state,
    });
    await fs.writeFile(receiptStatePath, `${canonicalJson(corruptReceiptEnvelope)}\n`, { mode: 0o600 });
    await expectCode(restartedReceiptService.recoverMutation(recoveryRequest), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(receiptStatePath, receiptStateBytes, { mode: 0o600 });
    await restartedReceiptService.close({ mode: "wait" });

    const created = await service.createThread({ title: "Durable plot" }, context());
    const threadId = created.thread.id;
    assert.equal(created.thread.browserSessionPolicy, "same-browser-session");
    const started = await service.startRun(
      { threadId, input: { text: "Run Python and show a quadratic plot" } },
      context()
    );
    const runId = started.run.id;
    assert.equal(started.run.status, "starting");
    await service.waitForIdle();

    const completed = (await service.getRunStatus({ runId }, context())).run;
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /plot is ready/u);
    assert.doesNotMatch(completed.output, /\/root\/private/u);
    assert.match(completed.output, /REDACTED_PATH/u);
    const eventResult = await service.loadRunEvents(eventsRequest(runId), context());
    const events = await eventResult.publicEventLedger.loadEventsAfter(0);
    assertLedger(events, runId, threadId);
    assert.ok(events.some((event) => event.type === "plan.updated"));
    assert.ok(events.some((event) => event.type === "tool.started"));
    assert.ok(events.some((event) => event.type === "tool.progress"));
    assert.ok(events.some((event) => event.type === "tool.completed"));
    const artifactEvent = events.find((event) => event.type === "artifact.created");
    const terminalEvent = events.find((event) => event.type === "run.completed");
    assert.ok(artifactEvent.seq < terminalEvent.seq, "artifact.created must precede run.completed");
    assert.deepEqual(await eventResult.publicEventLedger.loadCursor(0), { seq: 0, hash: ZERO_DIGEST });
    assert.deepEqual(await eventResult.publicEventLedger.loadHead(), {
      seq: completed.eventCursor.lastSeq,
      hash: completed.eventCursor.lastHash,
    });

    const listedArtifacts = await service.listArtifacts({ runId }, context());
    assert.equal(listedArtifacts.artifacts.length, 1);
    assert.notEqual(listedArtifacts.artifacts[0].id, plotArtifact().id, "artifact id was not rebound to run ownership");
    const loadedArtifact = await service.getArtifact({ artifactId: listedArtifacts.artifacts[0].id }, context());
    assert.deepEqual(loadedArtifact.artifact.spec, listedArtifacts.artifacts[0].spec);
    const loadedThread = (await service.getThread({ threadId }, context())).thread;
    assert.deepEqual(loadedThread.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(loadedThread.authority.contextDigest, loadedThread.messages.at(-1).digest);

    const persistedFile = await stateFile(root);
    const persistedText = await fs.readFile(persistedFile, "utf8");
    assert.doesNotMatch(persistedText, new RegExp(RAW_SOURCE_MARKER, "u"));
    assert.doesNotMatch(persistedText, new RegExp(RAW_STDOUT_MARKER, "u"));
    assert.doesNotMatch(persistedText, /\/root\/private/u);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(persistedFile)).mode & 0o777, 0o600);

    const rejectedSecondOwner = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    await expectCode(rejectedSecondOwner.getRunStatus({ runId }, context()), "ANALYSIS_SERVICE_BUSY");
    await rejectedSecondOwner.close();
    await service.close({ mode: "wait" });

    const restarted = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    const restartedRun = (await restarted.getRunStatus({ runId }, context())).run;
    assert.equal(restartedRun.eventCursor.lastHash, completed.eventCursor.lastHash);
    const restartedEventsResult = await restarted.loadRunEvents(eventsRequest(runId), context());
    const restartedEvents = await restartedEventsResult.publicEventLedger.loadEventsAfter(0);
    assert.deepEqual(restartedEvents, events, "durable event replay changed after service recreation");

    await expectCode(
      restarted.getThread({ threadId }, context(PRINCIPAL_ID, OTHER_BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );
    await expectCode(
      restarted.getThread({ threadId }, context(OTHER_PRINCIPAL_ID, BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );

    const streamingThread = await restarted.createThread({ title: "Dynamic stream" }, context());
    const streamingStarted = await restarted.startRun(
      { threadId: streamingThread.thread.id, input: { text: "hold for a live stream" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(streamingStarted.run.id), "dynamic stream runner start");
    const liveEventResult = await restarted.loadRunEvents(eventsRequest(streamingStarted.run.id), context());
    assert.equal(liveEventResult.once, false);
    assert.equal(liveEventResult.streamMs, 25_000);
    assert.equal(liveEventResult.pollMs, 100);
    const initialStreamEvents = await liveEventResult.publicEventLedger.loadEventsAfter(0);
    const pinnedInitialHead = await liveEventResult.publicEventLedger.loadHead();
    assert.equal(pinnedInitialHead.seq, initialStreamEvents.at(-1).seq);
    await fakeRunner.held.get(streamingStarted.run.id).release();
    await restarted.waitForIdle();
    const appendedStreamEvents = await liveEventResult.publicEventLedger.loadEventsAfter(pinnedInitialHead.seq);
    assert.ok(appendedStreamEvents.length > 0, "live event ledger did not expose events appended after the initial snapshot");
    assert.equal(appendedStreamEvents.at(-1).type, "run.completed");
    assert.deepEqual(
      await liveEventResult.publicEventLedger.loadHead(),
      pinnedInitialHead,
      "initial run/head binding must stay atomic while the append-only ledger grows"
    );

    const cancelThread = await restarted.createThread({ title: "Cancel" }, context());
    const cancelStarted = await restarted.startRun(
      { threadId: cancelThread.thread.id, input: { text: "hold until cancelled" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(cancelStarted.run.id), "cancel runner start");
    const cancelled = (await restarted.cancelRun({ runId: cancelStarted.run.id }, context())).run;
    assert.equal(cancelled.status, "cancelled");
    const cancelledAgain = (await restarted.cancelRun({ runId: cancelStarted.run.id }, context())).run;
    assert.equal(cancelledAgain.eventCursor.lastHash, cancelled.eventCursor.lastHash);
    await restarted.waitForIdle();
    const cancelledEventsResult = await restarted.loadRunEvents(eventsRequest(cancelStarted.run.id), context());
    const cancelledEvents = await cancelledEventsResult.publicEventLedger.loadEventsAfter(0);
    assert.equal(cancelledEvents.at(-1).type, "run.cancelled");
    assert.equal(cancelledEvents.filter((event) => event.type === "run.cancelled").length, 1);

    const failureThread = await restarted.createThread({ title: "Failure and resume" }, context());
    const failedStarted = await restarted.startRun(
      { threadId: failureThread.thread.id, input: { text: "fail without leaking internals" } },
      context()
    );
    await restarted.waitForIdle();
    const failed = (await restarted.getRunStatus({ runId: failedStarted.run.id }, context())).run;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "ANALYSIS_MODEL_UNAVAILABLE");
    assert.equal(
      failed.error.message,
      "The local analysis model is temporarily unavailable. Resume this run to try again."
    );
    assert.doesNotMatch(failed.error.message, /private|root|source/iu);

    const failedResultThread = await restarted.createThread({ title: "Failed runner result" }, context());
    const failedResultStarted = await restarted.startRun(
      {
        threadId: failedResultThread.thread.id,
        input: { text: "return unsuccessful execution result" },
      },
      context()
    );
    await restarted.waitForIdle();
    const failedResult = (
      await restarted.getRunStatus({ runId: failedResultStarted.run.id }, context())
    ).run;
    assert.equal(failedResult.status, "failed");
    assert.equal(failedResult.output, "");
    assert.equal(failedResult.error.code, "ANALYSIS_EXECUTION_FAILED");
    assert.equal(
      failedResult.error.message,
      "Python execution failed. Check the code for syntax or runtime errors and unavailable packages, then resume with corrected code."
    );
    const failedResultEventsResponse = await restarted.loadRunEvents(
      eventsRequest(failedResult.id),
      context()
    );
    const failedResultEvents = await failedResultEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(failedResultEvents.at(-1).type, "run.failed");
    assert.equal(failedResultEvents.filter(({ type }) => type === "run.failed").length, 1);
    assert.equal(failedResultEvents.some(({ type }) => type === "run.completed"), false);
    assert.equal(failedResultEvents.some(({ type }) => type === "output.completed"), false);
    const failedToolEvents = failedResultEvents.filter(({ type }) => type === "tool.failed");
    assert.equal(failedToolEvents.length, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS);
    assert.deepEqual(
      failedToolEvents.map(({ payload }) => payload.callId),
      ["analysis-1", "analysis-2", "analysis-3"]
    );
    const failedResultMessages = (
      await restarted.getThread({ threadId: failedResultThread.thread.id }, context())
    ).thread.messages;
    assert.deepEqual(failedResultMessages.map(({ role }) => role), ["user"]);

    const missingPlotThread = await restarted.createThread({ title: "Missing plot" }, context());
    const missingPlotStarted = await restarted.startRun(
      { threadId: missingPlotThread.thread.id, input: { text: "plot artifact rejection" } },
      context()
    );
    await restarted.waitForIdle();
    const missingPlot = (
      await restarted.getRunStatus({ runId: missingPlotStarted.run.id }, context())
    ).run;
    assert.equal(missingPlot.status, "failed");
    assert.equal(missingPlot.output, "");
    assert.deepEqual(missingPlot.error, {
      code: "ANALYSIS_PLOT_ARTIFACT_REQUIRED",
      message: "Python ran, but it did not produce the requested plot. Call emit_plot(...) and resume with corrected code.",
    });
    assert.doesNotMatch(JSON.stringify(missingPlot), new RegExp(`${RAW_SOURCE_MARKER}|/root/private`, "u"));
    const missingPlotEventsResponse = await restarted.loadRunEvents(
      eventsRequest(missingPlot.id),
      context()
    );
    const missingPlotEvents = await missingPlotEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(missingPlotEvents.at(-1).type, "run.failed");
    assert.equal(missingPlotEvents.some(({ type }) => type.startsWith("output.")), false);
    assert.deepEqual(
      (await restarted.getThread({ threadId: missingPlotThread.thread.id }, context())).thread.messages.map(({ role }) => role),
      ["user"]
    );

    const missingDocumentThread = await restarted.createThread({ title: "Missing document artifacts" }, context());
    const missingDocumentStarted = await restarted.startRun(
      {
        threadId: missingDocumentThread.thread.id,
        input: { text: "Create a LaTeX report and deliver both report.tex and report.pdf." },
      },
      context()
    );
    await restarted.waitForIdle();
    const missingDocument = (
      await restarted.getRunStatus({ runId: missingDocumentStarted.run.id }, context())
    ).run;
    assert.equal(missingDocument.status, "failed");
    assert.equal(missingDocument.output, "");
    assert.deepEqual(missingDocument.error, {
      code: "ANALYSIS_DOCUMENT_ARTIFACT_REQUIRED",
      message:
        "The requested TeX source and structurally valid PDF were not both produced, so this run was not marked complete.",
    });
    const missingDocumentEventsResponse = await restarted.loadRunEvents(
      eventsRequest(missingDocument.id),
      context()
    );
    const missingDocumentEvents = await missingDocumentEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(missingDocumentEvents.at(-1).type, "run.failed");
    assert.equal(missingDocumentEvents.some(({ type }) => type === "run.completed"), false);
    assert.equal(missingDocumentEvents.some(({ type }) => type.startsWith("output.")), false);
    assert.deepEqual(
      (await restarted.getThread({ threadId: missingDocumentThread.thread.id }, context())).thread.messages.map(({ role }) => role),
      ["user"]
    );

    const resumed = await restarted.resumeRun(
      { runId: failed.id, input: { text: "Run Python and show the plot now" } },
      context()
    );
    assert.equal(resumed.run.previousRunId, failed.id);
    await restarted.waitForIdle();
    assert.equal((await restarted.getRunStatus({ runId: resumed.run.id }, context())).run.status, "completed");

    const interruptedThread = await restarted.createThread({ title: "Exclusive ownership" }, context());
    const interruptedStarted = await restarted.startRun(
      { threadId: interruptedThread.thread.id, input: { text: "hold while the owner is live" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(interruptedStarted.run.id), "exclusive owner runner start");
    const blockedDuringRun = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    await expectCode(blockedDuringRun.getRunStatus({ runId: interruptedStarted.run.id }, context()), "ANALYSIS_SERVICE_BUSY");
    await blockedDuringRun.close();
    await restarted.cancelRun({ runId: interruptedStarted.run.id }, context());
    await restarted.waitForIdle();
    await restarted.close({ mode: "wait" });

    const afterCrash = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    const recovered = (await afterCrash.getRunStatus({ runId: interruptedStarted.run.id }, context())).run;
    assert.equal(recovered.status, "cancelled");
    const resumedRecovered = await afterCrash.resumeRun({ runId: recovered.id, input: { text: "answer normally" } }, context());
    await afterCrash.waitForIdle();
    assert.equal((await afterCrash.getRunStatus({ runId: resumedRecovered.run.id }, context())).run.status, "completed");

    const pageThread = await afterCrash.createThread({ title: "Pagination" }, context());
    const updated = await afterCrash.updateThread(
      { threadId: pageThread.thread.id, title: "Pagination updated" },
      context()
    );
    assert.equal(updated.thread.title, "Pagination updated");
    const firstPage = await afterCrash.listThreads({ limit: 1, before: "" }, context());
    assert.equal(firstPage.threads.length, 1);
    assert.ok(firstPage.nextBefore);
    const secondPage = await afterCrash.listThreads({ limit: 1, before: firstPage.nextBefore }, context());
    assert.equal(secondPage.threads.length, 1);
    assert.notEqual(secondPage.threads[0].id, firstPage.threads[0].id);
    const deleted = await afterCrash.deleteThread({ threadId: pageThread.thread.id }, context());
    assert.equal(deleted.deleted, true);
    await expectCode(afterCrash.getThread({ threadId: pageThread.thread.id }, context()), "NOT_FOUND");

    const stableBytes = await fs.readFile(persistedFile, "utf8");
    const tamperedEnvelope = JSON.parse(stableBytes);
    tamperedEnvelope.state.threads[0].title = "Tampered title";
    await fs.writeFile(persistedFile, `${canonicalJson(tamperedEnvelope)}\n`, { mode: 0o600 });
    await expectCode(afterCrash.getThread({ threadId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(persistedFile, stableBytes, { mode: 0o600 });

    const eventTamperEnvelope = JSON.parse(stableBytes);
    const run = eventTamperEnvelope.state.runs.find((item) => item.id === runId);
    run.events[0].payload.status = "running";
    const unsigned = {
      schemaVersion: eventTamperEnvelope.schemaVersion,
      state: eventTamperEnvelope.state,
    };
    eventTamperEnvelope.digest = contractDigest(unsigned);
    await fs.writeFile(persistedFile, `${canonicalJson(eventTamperEnvelope)}\n`, { mode: 0o600 });
    await expectCode(afterCrash.getRunStatus({ runId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(persistedFile, stableBytes, { mode: 0o600 });

    const realStateFile = `${persistedFile}.real`;
    await fs.rename(persistedFile, realStateFile);
    await fs.symlink(realStateFile, persistedFile);
    await expectCode(afterCrash.getRunStatus({ runId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.unlink(persistedFile);
    await fs.rename(realStateFile, persistedFile);

    const symlinkRoot = path.join(temporaryRoot, "linked-state");
    await fs.symlink(root, symlinkRoot);
    const rejectsRootSymlink = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: symlinkRoot,
    });
    await expectCode(rejectsRootSymlink.getIntegrationCapabilities(), "ANALYSIS_STATE_CORRUPT");

    assert.throws(
      () => createTestOnlyIntegrationAnalysisSessionService({
        analysisRunner: fakeRunner,
        stateRoot: path.join(temporaryRoot, "bad-proof-state"),
        activationProof: { ready: true },
      }),
      /activation proof/iu
    );

    await afterCrash.close({ mode: "wait" });

    const queueRoot = path.join(temporaryRoot, "queue-state");
    const queueService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: queueRoot,
    });
    const queueThreads = [];
    for (let index = 0; index < 7; index += 1) {
      queueThreads.push((await queueService.createThread({ title: `Queue ${index + 1}` }, context())).thread);
    }
    const callsBeforeQueue = fakeRunner.calls.length;
    const firstHeld = await queueService.startRun(
      { threadId: queueThreads[0].id, input: { text: "hold queue slot one" } },
      context()
    );
    const secondHeld = await queueService.startRun(
      { threadId: queueThreads[1].id, input: { text: "hold queue slot two" } },
      context()
    );
    await waitFor(
      () => fakeRunner.held.has(firstHeld.run.id) && fakeRunner.held.has(secondHeld.run.id),
      "two bounded planner slots"
    );
    const queuedRuns = [];
    for (let index = 2; index < 6; index += 1) {
      queuedRuns.push(await queueService.startRun(
        { threadId: queueThreads[index].id, input: { text: `answer queued run ${index}` } },
        context()
      ));
    }
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 2, "queued work escaped the global concurrency bound");
    assert.ok(queuedRuns.every((item) => item.run.status === "starting"));
    const queueStatePath = await stateFile(queueRoot);
    const queueEnvelope = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    const queuedIds = new Set(queuedRuns.map((item) => item.run.id));
    assert.equal(
      queueEnvelope.state.runs.filter((item) => queuedIds.has(item.id) && item.schedulingState === "queued").length,
      4,
      "queued scheduling state was not durably persisted"
    );
    await expectCode(
      queueService.startRun(
        { threadId: queueThreads[6].id, input: { text: "overflow this scope queue" } },
        context()
      ),
      "ANALYSIS_SCOPE_QUEUE_SATURATED"
    );
    const additionalScopes = [
      context("principal-analysis-q001", "d".repeat(64)),
      context("principal-analysis-q002", "e".repeat(64)),
      context("principal-analysis-q003", "f".repeat(64)),
    ];
    for (const [scopeIndex, queueContext] of additionalScopes.entries()) {
      for (let index = 0; index < 4; index += 1) {
        const thread = await queueService.createThread(
          { title: `Global queue ${scopeIndex + 1}.${index + 1}` },
          queueContext
        );
        await queueService.startRun(
          { threadId: thread.thread.id, input: { text: `answer global queued run ${scopeIndex}.${index}` } },
          queueContext
        );
      }
    }
    const overflowContext = context("principal-analysis-q004", "9".repeat(64));
    const globalOverflowThread = await queueService.createThread({ title: "Global overflow" }, overflowContext);
    await expectCode(
      queueService.startRun(
        { threadId: globalOverflowThread.thread.id, input: { text: "overflow the global queue" } },
        overflowContext
      ),
      "ANALYSIS_QUEUE_SATURATED"
    );
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 2, "saturated queued work started early");
    await Promise.all([
      fakeRunner.held.get(firstHeld.run.id).release(),
      fakeRunner.held.get(secondHeld.run.id).release(),
    ]);
    await queueService.waitForIdle();
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 18);
    await queueService.close({ mode: "wait" });

    const drainRoot = path.join(temporaryRoot, "drain-state");
    const drainService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: drainRoot,
    });
    const drainThread = await drainService.createThread({ title: "Bounded drain" }, context());
    const drainStarted = await drainService.startRun(
      { threadId: drainThread.thread.id, input: { text: "hold through bounded drain" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(drainStarted.run.id), "drain runner start");
    await expectCode(drainService.beginDrain({ mode: "wait", timeoutMs: 100 }), "ANALYSIS_DRAIN_TIMEOUT");
    await expectCode(
      drainService.startRun(
        { threadId: drainThread.thread.id, input: { text: "must be rejected while draining" } },
        context()
      ),
      "ANALYSIS_SERVICE_DRAINING"
    );
    const drained = await drainService.close({ mode: "abort", timeoutMs: 2_000 });
    assert.equal(drained.closed, true);
    const successor = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: drainRoot });
    const drainedRun = (await successor.getRunStatus({ runId: drainStarted.run.id }, context())).run;
    assert.equal(drainedRun.status, "cancelled");
    await successor.close({ mode: "wait" });

    console.log("smoke-integration-analysis-session-service ok");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
