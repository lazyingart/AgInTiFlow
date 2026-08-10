#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { createPlan, requestNextStep } from "../src/model-client.js";
import {
  DEFAULT_LOCAL_TOOL_LIMIT,
  DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET,
  LOCAL_TOOL_HARD_CAP,
  selectProgressiveTools,
} from "../src/progressive-tool-selection.js";
import { isLoopbackBaseURL } from "../src/provider-contract.js";
import { SessionStore } from "../src/session-store.js";
import {
  assistantJsonToolBlock,
  assistantText,
  assistantTools,
  createScriptedOpenAIClient,
  toolCall,
  unrelatedTransportError,
  unsupportedNativeToolsError,
} from "./fixtures/local-first-agent-eval-fixtures.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-local-agent-eval-"));
const originalFetch = globalThis.fetch;
const originalAgintiflowHome = process.env.AGINTIFLOW_HOME;
let networkAttempts = 0;

process.env.AGINTIFLOW_HOME = path.join(tempRoot, "home");
globalThis.fetch = async (...args) => {
  networkAttempts += 1;
  throw new Error(`Offline evaluation blocked a network request to ${String(args[0] || "unknown target")}`);
};

const results = [];

function oneLine(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .trim();
}

async function check(id, description, run) {
  try {
    const detail = await run();
    results.push({ id, status: "PASS", description, detail: detail || "" });
  } catch (error) {
    results.push({ id, status: "FAIL", description, detail: oneLine(error) });
  }
}

function functionTool(name, description = `${name} fixture tool`) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  };
}

const surfaceNames = [
  "open_url",
  "click",
  "type",
  "scroll",
  "press",
  "back",
  "wait",
  "web_search",
  "web_research",
  "read_image",
  "writing_specialist",
  "run_command",
  "inspect_project",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "send_to_canvas",
  "finish",
];

function requestConfig(overrides = {}) {
  return {
    provider: "localllm",
    model: "fixture-local-model",
    baseURL: "http://127.0.0.1:9/v1",
    goal: "Complete the fixture task.",
    taskProfile: "auto",
    allowFileTools: true,
    allowShellTool: true,
    allowWebSearch: true,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    modelTimeoutMs: 1_000,
    contextWindowTokens: 32768,
    maxOutputTokens: 8192,
    ...overrides,
  };
}

async function runAgentFixture({
  id,
  goal,
  responses,
  taskProfile = "auto",
  allowShellTool = false,
  maxSteps = responses.length,
  abortSignal,
  onEvent,
}) {
  const workspace = path.join(tempRoot, "workspaces", id);
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });

  const scripted = createScriptedOpenAIClient(responses, { label: id });
  const clientFactoryCalls = [];
  const deterministicClientFactory = async (factoryConfig) => {
    clientFactoryCalls.push(factoryConfig);
    return scripted.client;
  };
  deterministicClientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig(
    {
      provider: "localllm",
      routingMode: "manual",
      model: "fixture-local-model",
      goal,
      taskProfile,
      maxSteps,
      dynamicSteps: "off",
      allowShellTool,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      commandCwd: workspace,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      provider: "localllm",
      routingMode: "manual",
      model: "fixture-local-model",
      sessionId: id,
      commandCwd: workspace,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      maxSteps,
      dynamicSteps: "off",
      allowShellTool,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
      onEvent,
      abortSignal,
      clientFactory: deterministicClientFactory,
      providerReadinessMode: "deterministic-test",
    }
  );

  Object.assign(config, {
    provider: "localllm",
    requestedProvider: "localllm",
    apiKey: "",
    baseURL: "http://127.0.0.1:9/v1",
    model: "fixture-local-model",
    clientFactory: deterministicClientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    packageInstallPolicy: "block",
    maxSteps,
    maxStepsExplicit: true,
    dynamicSteps: "off",
    dynamicStepExtensionLimit: 0,
    allowShellTool,
    allowFileTools: false,
    allowWrapperTools: false,
    allowAuxiliaryTools: false,
    allowWebSearch: false,
    allowMcpTools: false,
    allowParallelScouts: false,
    scsActive: false,
    enableScs: "off",
    modelTimeoutMs: 1_000,
    abortSignal,
    onEvent,
    onLog: () => {},
    onConsole: () => {},
  });

  const result = await runAgent(config);
  const store = new SessionStore(sessionsDir, id, {
    projectRoot: workspace,
    commandCwd: workspace,
    projectSessionsDir,
  });

  return {
    config,
    result,
    calls: scripted.observations.calls,
    remainingResponses: scripted.remaining(),
    clientFactoryCalls,
    events: await store.loadEvents(),
    state: await store.loadState(),
  };
}

await check("surface-default", "LocalLLM compact active tool surface is at most 12 tools", async () => {
  const tools = surfaceNames.map((name) => functionTool(name));
  const selected = selectProgressiveTools(tools, {
    config: { provider: "localllm" },
    goal: "Implement code, browse a page, research sources, and draft a report.",
    profile: "auto",
  });
  assert.ok(selected.length <= DEFAULT_LOCAL_TOOL_LIMIT, `selected ${selected.length} tools, expected <= ${DEFAULT_LOCAL_TOOL_LIMIT}`);
  assert.equal(selected.at(-1)?.function?.name, "finish");
  return `${selected.length} tools`;
});

await check("surface-hard-cap", "LocalLLM compact tool surface cannot exceed the hard cap of 16", async () => {
  const tools = surfaceNames.map((name) => functionTool(name));
  const selected = selectProgressiveTools(tools, {
    config: {
      provider: "localllm",
      toolSurfaceMaxTools: 999,
      toolSurfaceMaxChars: 100_000,
    },
    goal: "Implement code, browse and click, research sources, then draft and save a report.",
    profile: "auto",
  });
  assert.ok(selected.length <= LOCAL_TOOL_HARD_CAP, `selected ${selected.length} tools, expected <= ${LOCAL_TOOL_HARD_CAP}`);
  assert.equal(selected.at(-1)?.function?.name, "finish");
  return `${selected.length} tools`;
});

await check("surface-char-budget", "LocalLLM drops oversized tool schemas before they exceed the configured character budget", async () => {
  const tools = surfaceNames.map((name) =>
    functionTool(name, name === "finish" ? "Finish the fixture." : `${name} ${"oversized ".repeat(400)}`)
  );
  const charBudget = 1_024;
  const selected = selectProgressiveTools(tools, {
    config: {
      provider: "localllm",
      toolSurfaceMaxChars: charBudget,
    },
    goal: "Implement code, browse, research, and save a report.",
    profile: "auto",
  });
  assert.deepEqual(selected.map((tool) => tool.function.name), ["finish"]);
  assert.ok(JSON.stringify(selected).length <= charBudget);
  return `${JSON.stringify(selected).length}/${charBudget} schema chars`;
});

await check(
  "surface-mixed-mcp-code",
  "LocalLLM preserves bounded MCP discovery, editing, and verification capabilities across workflow phases",
  async () => {
    const goal = "Use MCP to inspect the project, then implement the fix and run the tests.";
    const discoveryClient = createScriptedOpenAIClient(
      [assistantTools(toolCall("mixed-finish-1", "finish", { result: "fixture discovery surface inspected" }))],
      { label: "mixed-mcp-code-discovery" }
    );
    await requestNextStep(
      discoveryClient.client,
      requestConfig({ goal, allowMcpTools: true }),
      [{ role: "user", content: `Goal: ${goal}` }]
    );
    const discoveryTools = discoveryClient.observations.calls[0].payload.tools;
    const discoveryNames = discoveryTools.map((tool) => tool.function.name);
    for (const requiredName of ["mcp_call_tool", "write_file", "apply_patch", "run_command", "finish"]) {
      assert.ok(discoveryNames.includes(requiredName), `discovery phase omitted ${requiredName}`);
    }
    assert.ok(discoveryTools.length <= DEFAULT_LOCAL_TOOL_LIMIT);
    assert.ok(JSON.stringify(discoveryTools).length <= DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET);

    const implementationClient = createScriptedOpenAIClient(
      [assistantTools(toolCall("mixed-finish-2", "finish", { result: "fixture implementation surface inspected" }))],
      { label: "mixed-mcp-code-implementation" }
    );
    const mcpCall = toolCall("mcp-discovery-complete", "mcp_list_servers", {});
    await requestNextStep(
      implementationClient.client,
      requestConfig({ goal, allowMcpTools: true }),
      [
        { role: "user", content: `Goal: ${goal}` },
        assistantTools(mcpCall).choices[0].message,
        { role: "tool", tool_call_id: mcpCall.id, content: '{"ok":true}' },
      ]
    );
    const implementationTools = implementationClient.observations.calls[0].payload.tools;
    const implementationNames = implementationTools.map((tool) => tool.function.name);
    assert.deepEqual(
      implementationNames.slice(0, 7),
      ["run_command", "inspect_project", "list_files", "read_file", "search_files", "write_file", "apply_patch"]
    );
    assert.ok(implementationNames.includes("mcp_call_tool"));
    assert.equal(implementationNames.at(-1), "finish");
    assert.ok(implementationTools.length <= DEFAULT_LOCAL_TOOL_LIMIT);
    assert.ok(JSON.stringify(implementationTools).length <= DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET);

    const verificationClient = createScriptedOpenAIClient(
      [assistantTools(toolCall("mixed-finish-3", "finish", { result: "fixture verification surface inspected" }))],
      { label: "mixed-mcp-code-verification" }
    );
    const editCall = toolCall("mixed-edit-complete", "apply_patch", { patch: "fixture" });
    await requestNextStep(
      verificationClient.client,
      requestConfig({ goal, allowMcpTools: true }),
      [
        { role: "user", content: `Goal: ${goal}` },
        assistantTools(mcpCall).choices[0].message,
        { role: "tool", tool_call_id: mcpCall.id, content: '{"ok":true}' },
        assistantTools(editCall).choices[0].message,
        { role: "tool", tool_call_id: editCall.id, content: '{"ok":true}' },
      ]
    );
    const verificationTools = verificationClient.observations.calls[0].payload.tools;
    const verificationNames = verificationTools.map((tool) => tool.function.name);
    assert.deepEqual(verificationNames.slice(0, 4), ["run_command", "read_file", "search_files", "inspect_project"]);
    assert.ok(verificationNames.includes("apply_patch"));
    assert.ok(verificationNames.includes("mcp_call_tool"));
    assert.equal(verificationNames.at(-1), "finish");
    assert.ok(verificationTools.length <= DEFAULT_LOCAL_TOOL_LIMIT);
    assert.ok(JSON.stringify(verificationTools).length <= DEFAULT_LOCAL_TOOL_SCHEMA_CHAR_TARGET);
    return `${discoveryTools.length} discovery -> ${implementationTools.length} implementation -> ${verificationTools.length} verification tools`;
  }
);

await check("native-first", "LocalLLM sends native OpenAI tool calls before any text protocol", async () => {
  const scripted = createScriptedOpenAIClient(
    [assistantTools(toolCall("finish-native", "finish", { result: "native tool call accepted" }))],
    { label: "native-first" }
  );
  const response = await requestNextStep(
    scripted.client,
    requestConfig({ goal: "Use a tool and finish the fixture task." }),
    [{ role: "user", content: "Use a tool and finish the fixture task." }]
  );
  assert.equal(scripted.observations.calls.length, 1);
  const payload = scripted.observations.calls[0].payload;
  assert.ok(Array.isArray(payload.tools) && payload.tools.length > 0, "first LocalLLM request omitted native tools");
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.max_tokens, 8192, "LocalLLM request omitted the bounded output reserve");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "finish");
  return `${payload.tools.length} native tools on first request`;
});

await check("context-envelope", "High-token-density LocalLLM prompts fail before transport when the bounded envelope cannot fit", async () => {
  const scripted = createScriptedOpenAIClient([], { label: "context-envelope" });
  await assert.rejects(
    () =>
      requestNextStep(
        scripted.client,
        requestConfig({ contextWindowTokens: 12000, maxOutputTokens: 4096 }),
        [{ role: "user", content: "高密度上下文".repeat(5000) }]
      ),
    (error) => error?.code === "LOCALLLM_CONTEXT_BUDGET_EXCEEDED"
  );
  assert.equal(scripted.observations.calls.length, 0, "oversized LocalLLM payload reached the transport");
  return "rejected before transport";
});

await check("planner-envelope", "LocalLLM planning uses a smaller bounded output lane", async () => {
  const scripted = createScriptedOpenAIClient([assistantText("1. Inspect.\n2. Patch.\n3. Verify.")], {
    label: "planner-envelope",
  });
  const config = requestConfig({
    commandCwd: tempRoot,
    baseDir: tempRoot,
    packageInstallPolicy: "block",
    permissionMode: "normal",
    sandboxMode: "host",
    allowedDomains: [],
  });
  await createPlan(scripted.client, config, {
    goal: "Implement and verify a compact fixture.",
    startUrl: "",
    meta: {},
  });
  assert.equal(scripted.observations.calls.length, 1);
  assert.equal(scripted.observations.calls[0].payload.max_tokens, 2048, "planner did not reserve a bounded 2K output");
  return "2K planner output reserve";
});

await check("fallback-unsupported", "Text fallback occurs once after native tools are explicitly unsupported", async () => {
  const scripted = createScriptedOpenAIClient(
    [
      unsupportedNativeToolsError(),
      assistantText('[TOOL_CALLS]finish[ARGS]{"result":"bounded text fallback accepted"}'),
    ],
    { label: "fallback-unsupported" }
  );
  const response = await requestNextStep(
    scripted.client,
    requestConfig({ goal: "Use a tool and finish after an unsupported native request." }),
    [{ role: "user", content: "Use a tool and finish after an unsupported native request." }]
  );
  assert.equal(scripted.observations.calls.length, 2, "fallback was not bounded to one retry");
  assert.ok(Array.isArray(scripted.observations.calls[0].payload.tools), "fallback occurred before a native request");
  assert.equal(scripted.observations.calls[1].payload.tools, undefined, "fallback request still used native tool parameters");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "finish");
  return "1 native request + 1 text retry";
});

await check("fallback-json-block", "The documented JSON-block text fallback becomes a normalized tool call", async () => {
  const scripted = createScriptedOpenAIClient(
    [
      unsupportedNativeToolsError(),
      assistantJsonToolBlock([
        {
          id: "json-fallback-finish",
          name: "finish",
          arguments: { result: "JSON block fallback accepted" },
        },
      ]),
    ],
    { label: "fallback-json-block" }
  );
  const response = await requestNextStep(
    scripted.client,
    requestConfig({ goal: "Use the JSON fallback format and finish." }),
    [{ role: "user", content: "Use the JSON fallback format and finish." }]
  );
  assert.equal(scripted.observations.calls.length, 2);
  assert.ok(Array.isArray(scripted.observations.calls[0].payload.tools));
  assert.equal(scripted.observations.calls[1].payload.tools, undefined);
  const normalizedCall = response.choices[0].message.tool_calls[0];
  assert.equal(normalizedCall.id, "json-fallback-finish");
  assert.equal(normalizedCall.function.name, "finish");
  assert.deepEqual(JSON.parse(normalizedCall.function.arguments), { result: "JSON block fallback accepted" });
  return "JSON block parsed after one native rejection";
});

await check("fallback-not-broad", "Unrelated native transport failures do not trigger text fallback", async () => {
  const scripted = createScriptedOpenAIClient([unrelatedTransportError()], { label: "fallback-not-broad" });
  await assert.rejects(
    () =>
      requestNextStep(
        scripted.client,
        requestConfig({ goal: "Finish without broad fallback." }),
        [{ role: "user", content: "Finish without broad fallback." }]
      ),
    /fixture transport closed/
  );
  assert.equal(scripted.observations.calls.length, 1, "unrelated failure triggered an extra model request");
  assert.ok(Array.isArray(scripted.observations.calls[0].payload.tools), "the only request was not native");
  return "1 rejected native request, 0 fallback requests";
});

await check("ordinary-qa", "Ordinary Q&A succeeds through the local fake client", async () => {
  const run = await runAgentFixture({
    id: "ordinary-qa",
    goal: "Why does recursion need a base case?",
    responses: [assistantText("A base case terminates recursive expansion so calls can return.")],
    maxSteps: 1,
  });
  assert.match(run.result.result, /terminates recursive expansion/i);
  assert.equal(run.result.stopped, undefined);
  assert.equal(run.calls.length, 1);
  assert.ok(run.events.some((event) => event.type === "session.finished"));
  return "answered and finished in one local model call";
});

await check("truthful-action", "Action prose without a tool cannot claim success", async () => {
  const run = await runAgentFixture({
    id: "truthful-action",
    goal: "Run printf 4 and report the output.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistantText("The command ran successfully and printed 4."),
      assistantText("Confirmed: the output is 4."),
    ],
    maxSteps: 2,
  });
  assert.equal(run.result.stopped, true);
  assert.equal(run.result.reason, "model_did_not_execute");
  assert.equal(run.events.filter((event) => event.type === "completion.repair_requested").length, 1);
  assert.equal(run.events.filter((event) => event.type === "completion.evidence_rejected").length, 2);
  assert.ok(!run.events.some((event) => event.type === "session.finished"));
  return "one repair request, then safe stop";
});

await check("tool-finish", "A valid tool call followed by finish succeeds with evidence", async () => {
  const run = await runAgentFixture({
    id: "tool-finish",
    goal: "Run pwd and report the working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistantTools(toolCall("run-command", "run_command", { command: "pwd" })),
      assistantTools(toolCall("finish-after-tool", "finish", { result: "Verified the current working directory with pwd." })),
    ],
    maxSteps: 2,
  });
  const commandEvent = run.events.find(
    (event) => event.type === "tool.completed" && event.data?.toolName === "run_command"
  );
  assert.ok(commandEvent, "run_command did not produce a completed-tool evidence event");
  assert.match(run.result.result, /working directory/i);
  assert.ok(run.events.some((event) => event.type === "session.finished"));
  return "guarded local command evidence accepted";
});

await check("malformed-args", "Malformed native tool arguments get at most one repair or a safe stop", async () => {
  let run;
  try {
    run = await runAgentFixture({
      id: "malformed-args",
      goal: "Answer with OK using finish.",
      responses: [
        assistantTools(toolCall("malformed-finish-1", "finish", '{"result":"truncated"')),
        assistantTools(toolCall("malformed-finish-2", "finish", '{"result":"still-truncated"')),
      ],
      maxSteps: 4,
    });
  } catch (error) {
    assert.fail(`malformed arguments caused more than one repair request or escaped the safe-stop boundary: ${oneLine(error)}`);
  }

  assert.equal(run.calls.length, 2, `malformed arguments caused ${run.calls.length - 1} repair requests`);
  const malformedDispatches = run.events.filter(
    (event) => event.type === "tool.started" && event.data?.toolName === "finish"
  );
  assert.equal(malformedDispatches.length, 0, "malformed arguments were dispatched");
  assert.equal(run.result.stopped, true, "the second malformed response did not stop safely");
  assert.equal(run.result.reason, "tool_contract_violation");
  assert.equal(
    run.events.filter((event) => event.type === "tool.failed" && event.data?.category === "tool-contract-violation").length,
    2,
    "malformed arguments did not use the strict per-turn contract boundary"
  );
  assert.ok(!run.events.some((event) => event.type === "session.finished"));
  return "one repair request, then safe stop without dispatch";
});

await check("malformed-args-repaired", "One malformed native call can be repaired once and then finish safely", async () => {
  const run = await runAgentFixture({
    id: "malformed-args-repaired",
    goal: "Answer with OK using finish.",
    responses: [
      assistantTools(toolCall("malformed-once", "finish", '{"result":"truncated"')),
      assistantTools(toolCall("repaired-finish", "finish", { result: "OK" })),
    ],
    maxSteps: 2,
  });
  assert.equal(run.calls.length, 2, "the malformed call did not use exactly one repair request");
  assert.equal(
    run.events.filter(
      (event) =>
        event.type === "tool.failed" &&
        event.data?.category === "tool-contract-violation" &&
        event.data?.code === "TOOL_ARGUMENTS_INVALID_JSON"
    ).length,
    1
  );
  assert.equal(
    run.events.filter((event) => event.type === "tool.started" && event.data?.toolName === "finish").length,
    1,
    "the malformed call was dispatched in addition to the one corrected finish call"
  );
  assert.equal(run.result.result, "OK");
  assert.ok(run.events.some((event) => event.type === "session.finished"));
  return "one rejected dispatch + one corrected model response";
});

await check("empty-action-retry", "An empty no-tool action response gets one evidence retry and can recover", async () => {
  const run = await runAgentFixture({
    id: "empty-action-retry",
    goal: "Run pwd and report the working directory.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistantText(""),
      assistantTools(toolCall("run-after-empty", "run_command", { command: "pwd" })),
      assistantTools(toolCall("finish-after-empty", "finish", { result: "Verified the current working directory with pwd." })),
    ],
    maxSteps: 3,
  });
  assert.equal(run.calls.length, 3);
  assert.equal(run.events.filter((event) => event.type === "completion.repair_requested").length, 1);
  assert.equal(run.events.filter((event) => event.type === "completion.evidence_rejected").length, 1);
  assert.ok(run.events.some((event) => event.type === "tool.completed" && event.data?.toolName === "run_command"));
  assert.ok(run.events.some((event) => event.type === "session.finished"));
  assert.match(run.result.result, /working directory/i);
  return "empty response -> one bounded retry -> verified completion";
});

await check("cancellation", "Cancellation prevents a later-turn tool dispatch under strict one-call semantics", async () => {
  const controller = new AbortController();
  const observedEvents = [];
  const run = await runAgentFixture({
    id: "cancellation",
    goal: "Run pwd, then run printf should-not-run.",
    taskProfile: "shell",
    allowShellTool: true,
    responses: [
      assistantTools(toolCall("pwd-first", "run_command", { command: "pwd" })),
      assistantTools(toolCall("must-not-dispatch", "run_command", { command: "printf should-not-run" })),
    ],
    maxSteps: 2,
    abortSignal: controller.signal,
    onEvent: (type, data) => {
      observedEvents.push({ type, data });
      if (type === "tool.completed" && data?.toolName === "run_command" && data?.args?.command === "pwd") {
        controller.abort(new Error("fixture cancellation after first tool"));
      }
    },
  });
  assert.equal(run.result.stopped, true);
  assert.equal(run.result.reason, "user_interrupt");
  assert.equal(run.calls.length, 1, "cancellation allowed a second model turn");
  assert.equal(
    run.calls[0].payload.parallel_tool_calls,
    false,
    "cancellation fixture did not exercise the strict one-call request contract"
  );
  assert.ok(
    observedEvents.some(
      (event) => event.type === "tool.started" && event.data?.toolName === "run_command" && event.data?.args?.command === "pwd"
    )
  );
  assert.ok(
    !observedEvents.some(
      (event) =>
        event.type === "tool.started" &&
        event.data?.toolName === "run_command" &&
        event.data?.args?.command === "printf should-not-run"
    )
  );
  return "second-turn tool was not dispatched";
});

await check("offline-baseline", "Baseline runs use LocalLLM fake clients and never contact a hosted provider", async () => {
  const run = await runAgentFixture({
    id: "offline-baseline",
    goal: "Give a short explanation of deterministic tests.",
    responses: [assistantText("Deterministic tests use controlled inputs and repeatable outcomes.")],
    maxSteps: 1,
  });
  assert.equal(run.config.provider, "localllm");
  assert.ok(isLoopbackBaseURL(run.config.baseURL));
  assert.equal(run.clientFactoryCalls.length, 1, "the in-memory client seam was not used exactly once");
  assert.equal(run.calls.length, 1);
  assert.equal(networkAttempts, 0, "a network transport was invoked during the offline baseline");
  return "loopback config + in-memory client; 0 network attempts";
});

globalThis.fetch = originalFetch;
await fs.rm(tempRoot, { recursive: true, force: true });
if (originalAgintiflowHome === undefined) delete process.env.AGINTIFLOW_HOME;
else process.env.AGINTIFLOW_HOME = originalAgintiflowHome;

const counts = results.reduce(
  (summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  },
  { PASS: 0, FAIL: 0, SKIP: 0 }
);

for (const result of results) {
  console.log(`${result.status.padEnd(4)} ${result.id}: ${result.description}${result.detail ? ` (${result.detail})` : ""}`);
}
console.log(`SUMMARY pass=${counts.PASS} fail=${counts.FAIL} skip=${counts.SKIP}`);

if (counts.FAIL > 0) process.exitCode = 1;
