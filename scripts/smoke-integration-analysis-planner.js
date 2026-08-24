import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

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
  assertIntegrationAnalysisPlannerActivation,
  createTestOnlyIntegrationAnalysisPlanner,
} from "../src/integration-analysis-planner.js";
import {
  INTEGRATION_EXPRESSION_PLOT_SCHEMA_VERSION,
  IntegrationExpressionPlotError,
  compileIntegrationExpressionPlotPrompt,
} from "../src/integration-expression-plot.js";
import {
  INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION,
  IntegrationExplicitPythonError,
  classifyIntegrationExplicitPythonPrompt,
  compileIntegrationExplicitPythonPrompt,
} from "../src/integration-explicit-python.js";
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

function terminalResult(request, signal, successfulArtifacts) {
  const status = signal?.aborted ? "cancelled" : "succeeded";
  const artifacts = status === "succeeded"
    ? Object.freeze(successfulArtifacts ?? [resultArtifact(request)])
    : Object.freeze([]);
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

function runtimeFailureResult(request, signal) {
  const status = signal?.aborted ? "cancelled" : "failed";
  const unsigned = Object.freeze({
    schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
    jobId: request.jobId,
    attempt: request.attempt,
    sourceSha256: request.sourceSha256,
    status,
    exitCode: status === "failed" ? 1 : null,
    stdout: "",
    stderr: status === "failed" ? "RuntimeError: simulated bounded execution failure\n" : "",
    outputTruncated: false,
    durationMs: 12,
    artifacts: Object.freeze([]),
  });
  return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
}

function fakeWorker(resultForRequest = terminalResult) {
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
      return resultForRequest(request, signal);
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

function fixture(complete, { worker } = {}) {
  const rpcCalls = [];
  const manager = createExecutionJobManager({ worker: worker || fakeWorker() });
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

function expressionPlotCompilerIsStrict() {
  const exact = compileIntegrationExpressionPlotPrompt("Plot e^x-x^e");
  assert(exact);
  assert(Object.isFrozen(exact));
  assert.equal(exact.schemaVersion, INTEGRATION_EXPRESSION_PLOT_SCHEMA_VERSION);
  assert.equal(exact.expression, "e ^ x - x ^ e");
  assert.equal(exact.xMinimum, -5);
  assert.equal(exact.xMaximum, 5);
  assert.equal(exact.sampleCount, 201);
  assert.match(exact.source, /^import math\n/u);
  assert.match(exact.source, /_value = \(\(math\.e \*\* x\) - \(x \*\* math\.e\)\)/u);
  assert.match(exact.source, /'type':'scatter'/u);
  assert.match(exact.source, /emit_plot\(/u);
  assert.doesNotMatch(exact.source, /\b(?:eval|exec|compile|open|__import__)\s*\(/u);
  assert.doesNotMatch(exact.source, /(?:subprocess|socket|urllib|requests|https?:)/u);
  const runtime = spawnSync("python3", ["-I", "-S", "-c", [
    "_captured_plots = []",
    "def emit_plot(title, spec):",
    "    _captured_plots.append((title, spec))",
    exact.source,
    "assert len(_captured_plots) == 1",
    "_title, _spec = _captured_plots[0]",
    "assert _title == 'Plot of e ^ x - x ^ e'",
    "assert _spec['schemaVersion'] == '1'",
    "assert _spec['type'] == 'scatter'",
    "assert 100 <= len(_spec['series'][0]['points']) <= 201",
    "print('expression-plot-runtime-ok')",
  ].join("\n")], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(runtime.error, undefined, runtime.error?.message);
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /expression-plot-runtime-ok/u);

  const commonNotation = compileIntegrationExpressionPlotPrompt(
    "Could you please plot 2x + π + sin(x)^2 + cos(x)^2?"
  );
  assert(commonNotation);
  assert.equal(commonNotation.expression, "2 * x + pi + sin ( x ) ^ 2 + cos ( x ) ^ 2");
  assert.match(commonNotation.source, /math\.pi/u);
  assert.match(commonNotation.source, /float\(math\.sin\(x\)\)/u);
  assert.match(commonNotation.source, /float\(math\.cos\(x\)\)/u);
  assert(compileIntegrationExpressionPlotPrompt("plot sqrt(abs(x))"));

  for (const prompt of [
    "Plot the sales data.",
    "Plot customer-retention by region.",
    "Plot revenue (monthly).",
    "Plot 2023-2024 sales.",
    "Explain how to plot x^2.",
    "If I plot x^2, what happens?",
    "Plot if x^2 is positive.",
    "Do not plot x^2.",
    "Let's not plot x^2.",
    "Could x^2 be plotted without running code?",
    "Plot is a noun in this sentence.",
  ]) {
    assert.equal(compileIntegrationExpressionPlotPrompt(prompt), null, prompt);
  }

  for (const prompt of [
    "Plot __import__('os').system('id')",
    "Plot x; __import__('os')",
    "Plot (lambda: 1)()",
    "Plot process.exit()",
    "Plot sqrt.__call__(x)",
    "Plot unknown(x)",
    `Plot ${"(".repeat(30)}x${")".repeat(30)}`,
    `Plot ${"x+".repeat(140)}x`,
  ]) {
    assert.throws(
      () => compileIntegrationExpressionPlotPrompt(prompt),
      (error) =>
        error instanceof IntegrationExpressionPlotError &&
        error.code === "ANALYSIS_EXPRESSION_PLOT_INVALID" &&
        error.status === 400,
      prompt
    );
  }
}

function explicitPythonCompilerIsStrict() {
  const source = "values = [1, 4, 9]\nprint(values)";
  const exact = compileIntegrationExplicitPythonPrompt(
    `Please run this Python code and show the result.\n\n\`\`\`python\n${source}\n\`\`\``
  );
  assert(exact);
  assert(Object.isFrozen(exact));
  assert.equal(exact.schemaVersion, INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION);
  assert.equal(exact.source, source);
  assert.equal(exact.stdin, "");
  assert.equal(exact.timeoutMs, 10_000);

  const chinese = compileIntegrationExplicitPythonPrompt("请执行下面代码\n```python\nprint('好')\n```");
  assert.equal(chinese.source, "print('好')");
  for (const prompt of [
    "Kindly run this Python code\n```python\nprint(1)\n```",
    "I'd like you to run this Python code\n```python\nprint(1)\n```",
    "Let's run this Python code\n```python\nprint(1)\n```",
    "請執行下面的程式碼\n```python\nprint('好')\n```",
    "Run and show the plot.\n```python\nprint(1)\n```",
    "Run and show the output.\n```python\nprint(1)\n```",
    "Execute and return the result.\n```python\nprint(1)\n```",
    "Execute and show both stdout and messages.\n```python\nprint(1)\n```",
    "Run, show output.\n```python\nprint(1)\n```",
    "Run; then show output.\n```python\nprint(1)\n```",
    "Run, I need a plot.\n```python\nprint(1)\n```",
    "Execute; I would like a graph.\n```python\nprint(1)\n```",
    "执行：\n```python\nprint(1)\n```",
    "執行一下:\n```python\nprint(1)\n```",
  ]) {
    assert.equal(classifyIntegrationExplicitPythonPrompt(prompt).kind, "execute", prompt);
  }

  for (const prompt of [
    "Explain this code:\n```python\nprint(1)\n```",
    "Do not run this code:\n```python\nprint(1)\n```",
    "The user said run this code:\n```python\nprint(1)\n```",
    "```python\nprint(1)\n```",
    "Run this code without providing a fenced block.",
  ]) {
    assert.equal(compileIntegrationExplicitPythonPrompt(prompt), null, prompt);
  }

  for (const prompt of [
    "Run this:\n```py\nprint(1)\n```",
    "Run this:\n```python3\nprint(1)\n```",
    "Run this:\n```python\nprint(1)",
    "Run this:\n```python\n\n```",
    "Run this code:\n```python\nprint(1)\n```\n```python\nprint(2)\n```",
    "Run this:\n```python\nprint(1)\n```\n```text\nextra\n```",
    "Run this:\n```python\nprint('bad\\u0000source')\n```".replace("\\u0000", "\u0000"),
    "Run this:\n```python\n# safe-looking \u202eevil\nprint(1)\n```",
    `Run this:\n\`\`\`python\n${"x".repeat(EXECUTION_LIMITS.maximumSourceBytes + 1)}\n\`\`\``,
  ]) {
    assert.throws(
      () => compileIntegrationExplicitPythonPrompt(prompt),
      (error) =>
        error instanceof IntegrationExplicitPythonError &&
        error.code === "ANALYSIS_EXPLICIT_PYTHON_INVALID" &&
        error.status === 400,
      prompt.slice(0, 80)
    );
  }

  const uppercase = compileIntegrationExplicitPythonPrompt("Run this code:\n```Python\nprint(1)\n```");
  assert.equal(uppercase.source, "print(1)");
  const literalFenceCharacters = compileIntegrationExplicitPythonPrompt(
    "Run this code:\n```python\nprint('~~~')\nprint('```')\n```"
  );
  assert.equal(literalFenceCharacters.source, "print('~~~')\nprint('```')");
  for (const [prompt, requiresPlotArtifact] of [
    ["Can you run this and show the plot?\n```python\nprint(1)\n```", true],
    ["Run this and show me the plot\n```python\nprint(1)\n```", true],
    ["Run this Python code and plot the output\n```python\nprint(1)\n```", true],
    ["Run this Python code and graph the results\n```python\nprint(1)\n```", true],
    ["Run this Python code and plot it\n```python\nprint(1)\n```", true],
    ["Run this Python code and chart the values\n```python\nprint(1)\n```", true],
    ["Run this Python code and display its graph\n```python\nprint(1)\n```", true],
    ["Run this Python code; I need a plot\n```python\nprint(1)\n```", true],
    ["Run this Python code and show both the output and the plot\n```python\nprint(1)\n```", true],
    ["Run this code and show output, not a plot\n```python\nprint(1)\n```", false],
    ["执行这段代码，显示结果，不画图\n```python\nprint(1)\n```", false],
  ]) {
    const classified = classifyIntegrationExplicitPythonPrompt(prompt);
    assert.equal(classified.kind, "execute", prompt);
    assert.equal(classified.requirements.plotArtifact, requiresPlotArtifact, prompt);
  }
  assert.equal(
    classifyIntegrationExplicitPythonPrompt("Explain this code:\n```python\nprint(1)\n```").kind,
    "non-execution"
  );

  for (const prompt of [
    "Run this code, but do not execute it:\n```python\nprint(1)\n```",
    "Run this code. Actually, don’t run it.\n```python\nprint(1)\n```",
    "Run this code only if it is safe:\n```python\nprint(1)\n```",
    "Run this code, but don't.\n```python\nprint(1)\n```",
    "Run this code? No.\n```python\nprint(1)\n```",
    "Run this code. I changed my mind.\n```python\nprint(1)\n```",
    "Run this code and summarize it.\n```python\nprint(1)\n```",
    "Run this code and ask me before executing.\n```python\nprint(1)\n```",
    "Run this code, subject to my approval.\n```python\nprint(1)\n```",
    "请运行这段代码，但不要执行。\n```python\nprint(1)\n```",
    "Run this code:\n~~~python\nprint(1)\n~~~",
    "Run this code:\n```javascript\nconsole.log(1)\n```",
    "Run this code:\n```python\nprint('[REDACTED_PATH]')\n```",
    "Run\u200b this code:\n```python\nprint(1)\n```",
    "Run this code, but do\u00ad not execute it:\n```python\nprint(1)\n```",
    "Run the attached code. For reference only:\n```python\nprint(1)\n```",
    "Run the code above:\n```python\nprint(1)\n```",
    "```python\nprint(1)\n```\nRun the code below.",
  ]) {
    assert.throws(
      () => classifyIntegrationExplicitPythonPrompt(prompt),
      (error) => error?.code === "ANALYSIS_EXPLICIT_PYTHON_INVALID" && error?.status === 400,
      prompt
    );
  }

  for (const prompt of [
    "Run the project tests. For reference only:\n```python\nprint(1)\n```",
    "Execute permissions audit, then explain this example:\n```python\nprint(1)\n```",
    "运行时会发生什么？\n```python\nprint(1)\n```",
  ]) {
    assert.throws(
      () => classifyIntegrationExplicitPythonPrompt(prompt),
      (error) => error?.code === "ANALYSIS_EXPLICIT_PYTHON_INVALID" && error?.status === 400,
      prompt
    );
  }
}

async function deterministicExplicitPythonExecutesWithoutModel() {
  const source = [
    "values = [1, 4, 9]",
    "print('squares=' + ','.join(str(value) for value in values))",
    "emit_plot('Squares', {'schemaVersion':'1','type':'line','labels':['1','2','3'],'series':[{'name':'square','data':values}]})",
  ].join("\n");
  let modelCalls = 0;
  let workerCalls = 0;
  const deterministic = fixture(async () => {
    modelCalls += 1;
    throw new Error("LocalLLM must not be called for explicit fenced Python");
  }, {
    worker: fakeWorker((request, signal) => {
      workerCalls += 1;
      assert.equal(request.source, source);
      return terminalResult(request, signal);
    }),
  });
  const progress = [];
  const artifacts = [];
  const finals = [];
  const result = await deterministic.planner.run(
    scope("run_00000000-0000-4000-8000-000000000084"),
    { prompt: `Run this Python code and show the plot.\n\n\`\`\`python\n${source}\n\`\`\`` },
    {
      onProgress: (value) => progress.push(value),
      onArtifact: (value) => artifacts.push(value),
      onFinal: (value) => finals.push(value),
    }
  );
  assert.equal(modelCalls, 0);
  assert.equal(workerCalls, 1);
  assert.equal(result.kind, "analysis");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.executionStatus, "succeeded");
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["plot"]);
  assert.match(result.text, /Python execution completed successfully/u);
  assert.match(result.text, /answer=9/u);
  assert.match(result.text, /Produced 1 plot/u);
  assert.doesNotMatch(result.text, /abcdefghijklmnopqrstu|\/home\/private/u);
  assert.deepEqual(artifacts, result.artifacts);
  assert.deepEqual(finals, [result]);
  assert(progress.some(({ phase, executionState }) => phase === "executing" && executionState === "running"));
  assert(progress.some(({ phase, executionSucceeded }) => phase === "synthesizing" && executionSucceeded));
  assert.equal(
    deterministic.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1
  );
  assert.equal(deterministic.planner.attestation.deterministicExplicitPython, true);
  assert.equal(
    deterministic.planner.attestation.explicitPythonCompilerSchemaVersion,
    INTEGRATION_EXPLICIT_PYTHON_SCHEMA_VERSION
  );
  assert.equal(deterministic.planner.attestation.explicitPythonUsesAgentExecution, true);
  assert.equal(deterministic.planner.attestation.explicitPythonUsesModel, false);
  deterministic.coordinator.close();
}

async function deterministicExplicitPythonFailuresStayTruthful() {
  for (const [suffix, worker, expectedCode, expectedMessage] of [
    ["085", fakeWorker(runtimeFailureResult), "ANALYSIS_EXECUTION_FAILED", /did not complete successfully/u],
    ["086", fakeWorker((request) => {
      const unsigned = Object.freeze({
        schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
        jobId: request.jobId,
        attempt: request.attempt,
        sourceSha256: request.sourceSha256,
        status: "timed_out",
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        durationMs: 10_000,
        artifacts: Object.freeze([]),
      });
      return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
    }), "ANALYSIS_EXECUTION_FAILED", /timed out/u],
  ]) {
    let modelCalls = 0;
    const failed = fixture(async () => {
      modelCalls += 1;
      return textResponse("Execution succeeded.");
    }, { worker });
    await assert.rejects(
      failed.planner.run(
        scope(`run_00000000-0000-4000-8000-000000000${suffix}`),
        { prompt: "Execute this Python:\n```python\nraise RuntimeError('no')\n```" }
      ),
      (error) => error?.code === expectedCode && error?.status === 502 && expectedMessage.test(error.message)
    );
    assert.equal(modelCalls, 0);
    assert.equal(
      failed.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
      1
    );
    failed.coordinator.close();
  }

  let rejectedModelCalls = 0;
  const rejected = fixture(async () => {
    rejectedModelCalls += 1;
    return textResponse("Execution succeeded.");
  });
  await assert.rejects(
    rejected.planner.run(
      scope("run_00000000-0000-4000-8000-000000000087"),
      { prompt: "Run this Python:\n```python\nimport numpy\nprint(numpy.arange(3))\n```" }
    ),
    (error) =>
      error?.code === "ANALYSIS_EXECUTION_FAILED" &&
      error?.status === 502 &&
      /packages unavailable/u.test(error.message)
  );
  assert.equal(rejectedModelCalls, 0);
  assert.equal(
    rejected.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  rejected.coordinator.close();

  const artifactless = fixture(async () => {
    throw new Error("model must not run");
  }, { worker: fakeWorker((request, signal) => terminalResult(request, signal, [])) });
  await assert.rejects(
    artifactless.planner.run(
      scope("run_00000000-0000-4000-8000-000000000088"),
      { prompt: "Run this Python and show a plot:\n```python\nprint(1)\n```" }
    ),
    (error) => error?.code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED" && error?.status === 502
  );
  artifactless.coordinator.close();

  let explanatoryModelCalls = 0;
  const explanatory = fixture(async (_client, payload) => {
    explanatoryModelCalls += 1;
    assert.equal(Object.hasOwn(payload, "tools"), false);
    assert.equal(Object.hasOwn(payload, "tool_choice"), false);
    assert.match(payload.messages[0].content, /does not unambiguously authorize executing it/u);
    assert.doesNotMatch(payload.messages[0].content, /must call the tool/u);
    return textResponse("This code prints one; it was not executed.");
  });
  const explanatoryResult = await explanatory.planner.run(
    scope("run_00000000-0000-4000-8000-000000000089"),
    { prompt: "Explain this code:\n```python\nprint(1)\n```" }
  );
  assert.equal(explanatoryModelCalls, 1);
  assert.equal(explanatoryResult.kind, "direct");
  assert.equal(
    explanatory.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  explanatory.coordinator.close();

  let unrelatedModelCalls = 0;
  const unrelated = fixture(async () => {
    unrelatedModelCalls += 1;
    return textResponse("The reference snippet was not executed.");
  });
  await assert.rejects(
    unrelated.planner.run(
      scope("run_00000000-0000-4000-8000-000000000091"),
      { prompt: "Run the project tests. For reference only:\n```python\nprint(1)\n```" }
    ),
    (error) => error?.code === "ANALYSIS_EXPLICIT_PYTHON_INVALID" && error?.status === 400
  );
  assert.equal(unrelatedModelCalls, 0);
  assert.equal(
    unrelated.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  unrelated.coordinator.close();

  const disobedient = fixture(async (_client, payload) => {
    assert.equal(Object.hasOwn(payload, "tools"), false);
    return toolResponse("print('must not execute')");
  });
  await assert.rejects(
    disobedient.planner.run(
      scope("run_00000000-0000-4000-8000-000000000092"),
      { prompt: "Explain this code:\n```python\nprint(1)\n```" }
    ),
    (error) => error?.code === "ANALYSIS_TOOL_FORBIDDEN" && error?.status === 502
  );
  assert.equal(
    disobedient.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  disobedient.coordinator.close();

  for (const [index, prompt] of [
    "Run this code, but do not execute it:\n```python\nprint(1)\n```",
    "Run this code only if it is safe:\n```python\nprint(1)\n```",
    "Run this code:\n~~~python\nprint(1)\n~~~",
    "Run this code:\n```javascript\nconsole.log(1)\n```",
  ].entries()) {
    let ambiguousModelCalls = 0;
    const ambiguous = fixture(async () => {
      ambiguousModelCalls += 1;
      return toolResponse("print('unsafe')");
    });
    await assert.rejects(
      ambiguous.planner.run(
        scope(`run_00000000-0000-4000-8000-${String(93 + index).padStart(12, "0")}`),
        { prompt }
      ),
      (error) => error?.code === "ANALYSIS_EXPLICIT_PYTHON_INVALID" && error?.status === 400
    );
    assert.equal(ambiguousModelCalls, 0);
    assert.equal(
      ambiguous.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
      0
    );
    ambiguous.coordinator.close();
  }

  const cancelled = fixture(async () => {
    throw new Error("model must not run");
  });
  const controller = new AbortController();
  const pending = cancelled.planner.run(
    scope("run_00000000-0000-4000-8000-000000000090"),
    { prompt: "Run this Python:\n```python\nprint(1)\n```" },
    { signal: controller.signal }
  );
  for (let index = 0; index < 50; index += 1) {
    if (cancelled.rpcCalls.some(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    cancelled.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1,
    "explicit Python cancellation must be exercised after the worker job starts"
  );
  controller.abort(new Error("private cancellation detail at /home/private"));
  await assert.rejects(
    pending,
    (error) => error?.code === "ANALYSIS_CANCELLED" && !error.message.includes("/home/private")
  );
  assert(
    cancelled.rpcCalls.some(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsCancel),
    "explicit Python cancellation must reach the coordinator cancellation path"
  );
  cancelled.coordinator.close();
}

async function explicitPythonPlotIntentIgnoresSourceText() {
  let workerCalls = 0;
  const sourceOnlyPlotWords = fixture(async () => {
    throw new Error("model must not run");
  }, {
    worker: fakeWorker((request, signal) => {
      workerCalls += 1;
      return terminalResult(request, signal, []);
    }),
  });
  const noPlotRequired = await sourceOnlyPlotWords.planner.run(
    scope("run_00000000-0000-4000-8000-000000000097"),
    { prompt: "Run this code and show the result:\n```python\nprint('show plot')\n```" }
  );
  assert.equal(workerCalls, 1);
  assert.deepEqual(noPlotRequired.artifacts, []);
  sourceOnlyPlotWords.coordinator.close();

  const outsidePlot = fixture(async () => {
    throw new Error("model must not run");
  }, { worker: fakeWorker((request, signal) => terminalResult(request, signal, [])) });
  await assert.rejects(
    outsidePlot.planner.run(
      scope("run_00000000-0000-4000-8000-000000000098"),
      { prompt: "Run this code and show a plot:\n```python\n# do not plot this comment\nprint(1)\n```" }
    ),
    (error) => error?.code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED" && error?.status === 502
  );
  outsidePlot.coordinator.close();

  const chartless = fixture(async () => {
    throw new Error("model must not run");
  }, { worker: fakeWorker((request, signal) => terminalResult(request, signal, [])) });
  await assert.rejects(
    chartless.planner.run(
      scope("run_00000000-0000-4000-8000-000000000101"),
      { prompt: "Run this Python code and chart the values:\n```python\nprint(1)\n```" }
    ),
    (error) => error?.code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED" && error?.status === 502
  );
  chartless.coordinator.close();
}

async function explicitPythonOutputIsLiteralAndBounded() {
  const output = [
    "# fake heading",
    "[fake link](https://attacker.invalid/)",
    "<img src=x onerror=alert(1)>",
    "```",
    "x".repeat(9_000),
  ].join("\n");
  const bounded = fixture(async () => {
    throw new Error("model must not run");
  }, {
    worker: fakeWorker((request) => {
      const unsigned = Object.freeze({
        schemaVersion: EXECUTION_RESULT_SCHEMA_VERSION,
        jobId: request.jobId,
        attempt: request.attempt,
        sourceSha256: request.sourceSha256,
        status: "succeeded",
        exitCode: 0,
        stdout: output,
        stderr: "",
        outputTruncated: false,
        durationMs: 12,
        artifacts: Object.freeze([]),
      });
      return validateExecutionResult({ ...unsigned, resultDigest: contractDigest(unsigned) }, request);
    }),
  });
  const result = await bounded.planner.run(
    scope("run_00000000-0000-4000-8000-000000000099"),
    { prompt: "Run this code:\n```python\nprint('bounded output')\n```" }
  );
  assert.match(result.text, /Output:\n\n(?:`{4,}|~{3,})text\n# fake heading/u);
  assert.match(result.text, /\[fake link\]\(https:\/\/attacker\.invalid\/\)/u);
  assert.match(result.text, /<img src=x onerror=alert\(1\)>/u);
  assert.match(result.text, /\n```\n/u);
  assert.match(result.text, /clipped for chat display/u);
  assert.doesNotMatch(result.text, /sandbox truncated/u);
  assert(Buffer.byteLength(result.text, "utf8") < 10 * 1024);
  bounded.coordinator.close();
}

async function deterministicExpressionPlotExecutesWithoutModel() {
  let modelCalls = 0;
  let workerCalls = 0;
  const deterministic = fixture(async () => {
    modelCalls += 1;
    throw new Error("LocalLLM must not be called for a supported expression plot");
  }, {
    worker: fakeWorker((request, signal) => {
      workerCalls += 1;
      assert.match(request.source, /_value = \(\(math\.e \*\* x\) - \(x \*\* math\.e\)\)/u);
      assert.match(request.source, /emit_plot\(/u);
      assert.doesNotMatch(request.source, /\b(?:eval|exec|__import__)\s*\(/u);
      return terminalResult(request, signal);
    }),
  });
  const progress = [];
  const artifacts = [];
  const finals = [];
  const result = await deterministic.planner.run(
    scope("run_00000000-0000-4000-8000-000000000080"),
    { prompt: "Plot e^x-x^e" },
    {
      onProgress: (value) => progress.push(value),
      onArtifact: (value) => artifacts.push(value),
      onFinal: (value) => finals.push(value),
    }
  );
  assert.equal(modelCalls, 0);
  assert.equal(workerCalls, 1);
  assert.equal(result.kind, "analysis");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.executionStatus, "succeeded");
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["plot"]);
  assert.match(result.text, /Plotted e \^ x - x \^ e for x from -5 to 5/u);
  assert.match(result.text, /3 finite samples/u);
  assert.deepEqual(artifacts, result.artifacts);
  assert.deepEqual(finals, [result]);
  assert(progress.some(({ phase, executionState }) => phase === "executing" && executionState === "running"));
  assert(progress.some(({ phase, executionSucceeded }) => phase === "synthesizing" && executionSucceeded));
  assert.equal(
    deterministic.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1
  );
  deterministic.coordinator.close();
}

async function deterministicExpressionPlotFailuresStayTruthful() {
  let failedModelCalls = 0;
  const failed = fixture(async () => {
    failedModelCalls += 1;
    return textResponse("The plot is ready.");
  }, { worker: fakeWorker(runtimeFailureResult) });
  let failedFinals = 0;
  await assert.rejects(
    failed.planner.run(
      scope("run_00000000-0000-4000-8000-000000000081"),
      { prompt: "Plot e^x-x^e" },
      { onFinal: () => { failedFinals += 1; } }
    ),
    (error) => error?.code === "ANALYSIS_EXECUTION_FAILED" && error?.status === 502
  );
  assert.equal(failedModelCalls, 0);
  assert.equal(failedFinals, 0);
  assert.equal(
    failed.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1
  );
  failed.coordinator.close();

  let artifactlessModelCalls = 0;
  const artifactless = fixture(async () => {
    artifactlessModelCalls += 1;
    return textResponse("The plot is ready.");
  }, { worker: fakeWorker((request, signal) => terminalResult(request, signal, [])) });
  await assert.rejects(
    artifactless.planner.run(
      scope("run_00000000-0000-4000-8000-000000000082"),
      { prompt: "plot e^x-x" }
    ),
    (error) => error?.code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED" && error?.status === 502
  );
  assert.equal(artifactlessModelCalls, 0);
  assert.equal(
    artifactless.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1
  );
  artifactless.coordinator.close();

  let injectionModelCalls = 0;
  const injection = fixture(async () => {
    injectionModelCalls += 1;
    return textResponse("unsafe");
  });
  await assert.rejects(
    injection.planner.run(
      scope("run_00000000-0000-4000-8000-000000000083"),
      { prompt: "Plot __import__('os').system('id')" }
    ),
    (error) => error?.code === "ANALYSIS_EXPRESSION_PLOT_INVALID" && error?.status === 400
  );
  assert.equal(injectionModelCalls, 0);
  assert.equal(
    injection.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  injection.coordinator.close();
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
  assert.equal(planner.attestation.deterministicExpressionPlots, true);
  assert.equal(
    planner.attestation.expressionPlotCompilerSchemaVersion,
    INTEGRATION_EXPRESSION_PLOT_SCHEMA_VERSION
  );
  assert.equal(planner.attestation.expressionPlotUsesAgentExecution, true);
  assert.equal(planner.attestation.expressionPlotUsesEval, false);
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

async function generalPlotRequestsRequireExecutionAndArtifact() {
  let executionCount = 0;
  const worker = fakeWorker((request, signal) => {
    executionCount += 1;
    return executionCount === 1
      ? terminalResult(request, signal, [])
      : terminalResult(request, signal);
  });
  let modelStep = 0;
  const corrected = fixture(async (_client, payload) => {
    modelStep += 1;
    if (modelStep === 1) {
      assert.equal(payload.tool_choice, "required");
      return toolResponse("values = [1.0, 2.0]\nprint(values)");
    }
    if (modelStep === 2) {
      assert.equal(payload.tool_choice, "required");
      const feedback = JSON.parse(payload.messages.at(-1).content);
      assert.equal(feedback.ok, true);
      assert.deepEqual(feedback.artifacts, []);
      assert.match(feedback.correction, /explicitly requested a plot/u);
      return toolResponse([
        "labels = ['0', '1', '2']",
        "values = [1.0, 2.718, 7.389]",
        "emit_plot('e^x - x^e', {'schemaVersion':'1','type':'line','labels':labels,'series':[{'name':'value','data':values}]})",
      ].join("\n"));
    }
    assert.equal(payload.tool_choice, "auto");
    assert.equal(Object.hasOwn(payload, "tools"), true);
    return textResponse("The corrected execution produced the requested plot.");
  }, { worker });
  const result = await corrected.planner.run(
    scope("run_00000000-0000-4000-8000-000000000070"),
    { prompt: "Run Python to create a plot of e^x-x^e." }
  );
  assert.equal(modelStep, 3);
  assert.equal(executionCount, 2);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.executionStatus, "succeeded");
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["plot"]);
  corrected.coordinator.close();

  const lowercase = fixture(async (_client, payload) => {
    assert.equal(payload.tool_choice, "required");
    return textResponse("I would only describe the formula.");
  });
  await assert.rejects(
    lowercase.planner.run(
      scope("run_00000000-0000-4000-8000-000000000071"),
      { prompt: "Run Python to create a plot of e^x-x." }
    ),
    (error) => error?.code === "ANALYSIS_TOOL_REQUIRED"
  );
  lowercase.coordinator.close();

  const nonImperativePrompts = [
    "Explain how to create a plot of e^x-x.",
    "If I plot e^x-x, what should I expect?",
    "Do not create a plot of e^x-x; explain the notation.",
    "Could e^x-x be plotted without running code?",
    "Plot is a noun in this sentence.",
  ];
  for (let index = 0; index < nonImperativePrompts.length; index += 1) {
    const direct = fixture(async (_client, payload) => {
      assert.equal(payload.tool_choice, "auto");
      return textResponse("This is an explanation, not an execution request.");
    });
    const directResult = await direct.planner.run(
      scope(`run_00000000-0000-4000-8000-${String(72 + index).padStart(12, "0")}`),
      { prompt: nonImperativePrompts[index] }
    );
    assert.equal(directResult.kind, "direct");
    assert.equal(directResult.toolCalls, 0);
    direct.coordinator.close();
  }
}

async function recoversPlotOnThirdExecutionAttempt() {
  let runtimeExecutions = 0;
  const worker = fakeWorker((request, signal) => {
    runtimeExecutions += 1;
    return runtimeExecutions === 1
      ? runtimeFailureResult(request, signal)
      : terminalResult(request, signal);
  });
  let modelStep = 0;
  const recovered = fixture(async (_client, payload) => {
    modelStep += 1;
    if (modelStep === 1) {
      assert.equal(payload.tool_choice, "required");
      return toolResponse("import numpy\nprint(numpy.exp(1))");
    }
    if (modelStep === 2) {
      assert.equal(payload.tool_choice, "required");
      const feedback = JSON.parse(payload.messages.at(-1).content);
      assert.equal(feedback.ok, false);
      assert.match(feedback.stderr, /numpy/u);
      return toolResponse("raise RuntimeError('second attempt fails at runtime')");
    }
    if (modelStep === 3) {
      assert.equal(payload.tool_choice, "required");
      const feedback = JSON.parse(payload.messages.at(-1).content);
      assert.equal(feedback.ok, false);
      assert.equal(feedback.status, "failed");
      assert.match(feedback.stderr, /simulated bounded execution failure/u);
      return toolResponse([
        "labels = ['0', '1', '2']",
        "values = [1.0, 1.718, 3.389]",
        "emit_plot('e^x - x^e', {'schemaVersion':'1','type':'line','labels':labels,'series':[{'name':'value','data':values}]})",
      ].join("\n"));
    }
    assert.equal(Object.hasOwn(payload, "tools"), false);
    const feedback = JSON.parse(payload.messages.at(-1).content);
    assert.equal(feedback.ok, true);
    assert.equal(feedback.artifacts[0].kind, "plot");
    return textResponse("The third bounded execution succeeded and produced the plot.");
  }, { worker });
  const result = await recovered.planner.run(
    scope("run_00000000-0000-4000-8000-000000000079"),
    { prompt: "Run Python to create a plot of e^x-x^e." }
  );
  assert.equal(modelStep, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS + 1);
  assert.equal(runtimeExecutions, 2);
  assert.equal(result.toolCalls, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS);
  assert.equal(result.executionStatus, "succeeded");
  assert.deepEqual(result.artifacts.map(({ kind }) => kind), ["plot"]);
  assert.equal(
    recovered.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    2
  );
  recovered.coordinator.close();
}

async function rejectsFalseCompletionAfterFailedOrArtifactlessExecution() {
  let failedStep = 0;
  const failed = fixture(async (_client, payload) => {
    failedStep += 1;
    if (failedStep === 1) return toolResponse("import numpy\nprint(numpy.arange(3))");
    if (failedStep === 2) return toolResponse("import pandas\nprint(pandas.DataFrame())");
    if (failedStep === 3) return toolResponse("import matplotlib\nprint(matplotlib.__version__)");
    assert.equal(Object.hasOwn(payload, "tools"), false);
    return textResponse("Let me fix this and create the plot next.");
  });
  let failedFinals = 0;
  await assert.rejects(
    failed.planner.run(
      scope("run_00000000-0000-4000-8000-000000000077"),
      { prompt: "Run Python to create a plot of e^x-x." },
      { onFinal: () => { failedFinals += 1; } }
    ),
    (error) => error?.code === "ANALYSIS_EXECUTION_FAILED"
  );
  assert.equal(failedStep, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS + 1);
  assert.equal(failedFinals, 0);
  assert.equal(
    failed.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  failed.coordinator.close();

  let artifactlessStep = 0;
  const artifactless = fixture(async (_client, payload) => {
    artifactlessStep += 1;
    if (artifactlessStep <= INTEGRATION_ANALYSIS_MAX_TOOL_CALLS) {
      assert.equal(payload.tool_choice, "required");
      return toolResponse(`print('artifactless attempt ${artifactlessStep}')`);
    }
    assert.equal(Object.hasOwn(payload, "tools"), false);
    return textResponse("The plot is ready.");
  }, {
    worker: fakeWorker((request, signal) => terminalResult(request, signal, [])),
  });
  await assert.rejects(
    artifactless.planner.run(
      scope("run_00000000-0000-4000-8000-000000000078"),
      { prompt: "Run Python to create a plot of e^x-x^e." }
    ),
    (error) => error?.code === "ANALYSIS_PLOT_ARTIFACT_REQUIRED"
  );
  assert.equal(artifactlessStep, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS + 1);
  assert.equal(
    artifactless.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    INTEGRATION_ANALYSIS_MAX_TOOL_CALLS
  );
  artifactless.coordinator.close();
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
  assert.equal(step, INTEGRATION_ANALYSIS_MAX_TOOL_CALLS + 1);
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

async function correctsUnavailableImportsAndBrandsActivation() {
  let step = 0;
  const corrected = fixture(async (_client, payload) => {
    step += 1;
    if (step === 1) {
      assert.equal(payload.tool_choice, "required");
      return toolResponse("import numpy as np\nprint(np.arange(3))");
    }
    if (step === 2) {
      assert.equal(payload.tool_choice, "required");
      const feedback = JSON.parse(payload.messages.at(-1).content);
      assert.equal(feedback.ok, false);
      assert.equal(feedback.status, "failed");
      assert.match(feedback.stderr, /numpy/u);
      assert.match(feedback.correction, /different corrected Python source/u);
      return toolResponse("values = [1, 4, 9]\nemit_markdown('Squares', '1, 4, 9')");
    }
    return textResponse("The corrected standard-library analysis completed.");
  });
  const result = await corrected.planner.run(
    scope("run_00000000-0000-4000-8000-000000000066"),
    { prompt: "Run Python and show the squares." }
  );
  assert.equal(result.toolCalls, 2);
  assert.equal(result.executionStatus, "succeeded");
  assert.equal(
    corrected.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    1
  );

  const activation = await corrected.planner.activate();
  assert.equal(activation.plannerDigest, corrected.planner.attestation.digest);
  assert.equal(activation.coordinatorDigest, corrected.coordinator.attestation.digest);
  assert.equal(activation.readinessDigest, activation.readinessProof.digest);
  assert(Object.isFrozen(activation));
  assert(Object.isFrozen(activation.readinessProof));
  assertIntegrationAnalysisPlannerActivation(activation, {
    planner: corrected.planner,
    requireSystemdCredential: false,
  });
  assert.throws(
    () => assertIntegrationAnalysisPlannerActivation(activation, { planner: corrected.planner }),
    /test-only/u
  );
  assert.throws(
    () => assertIntegrationAnalysisPlannerActivation(Object.freeze({ ...activation }), {
      planner: corrected.planner,
      requireSystemdCredential: false,
    }),
    /not AgInTi-owned/u
  );
  const other = fixture(async () => textResponse("unused"));
  assert.throws(
    () => assertIntegrationAnalysisPlannerActivation(activation, {
      planner: other.planner,
      requireSystemdCredential: false,
    }),
    /different planner/u
  );
  other.coordinator.close();
  corrected.coordinator.close();

  let repeatedStep = 0;
  const repeated = fixture(async () => {
    repeatedStep += 1;
    return toolResponse("from pandas import DataFrame\nprint(DataFrame())");
  });
  await assert.rejects(
    repeated.planner.run(scope("run_00000000-0000-4000-8000-000000000067"), {
      prompt: "Execute Python and show a table.",
    }),
    (error) => error?.code === "ANALYSIS_TOOL_LOOP"
  );
  assert.equal(repeatedStep, 2);
  assert.equal(
    repeated.rpcCalls.filter(({ pathname }) => pathname === EXECUTION_WORKER_RPC_PATHS.jobsStart).length,
    0
  );
  repeated.coordinator.close();
}

expressionPlotCompilerIsStrict();
explicitPythonCompilerIsStrict();
await deterministicExplicitPythonExecutesWithoutModel();
await deterministicExplicitPythonFailuresStayTruthful();
await explicitPythonPlotIntentIgnoresSourceText();
await explicitPythonOutputIsLiteralAndBounded();
await deterministicExpressionPlotExecutesWithoutModel();
await deterministicExpressionPlotFailuresStayTruthful();
await executesAndSynthesizesPlot();
await directAnswerDoesNotExecute();
await generalPlotRequestsRequireExecutionAndArtifact();
await recoversPlotOnThirdExecutionAttempt();
await rejectsFalseCompletionAfterFailedOrArtifactlessExecution();
await rejectsOverridesAndMalformedTools();
await enforcesToolLoopAndCancellation();
await correctsUnavailableImportsAndBrandsActivation();

console.log("integration analysis planner smoke passed");
