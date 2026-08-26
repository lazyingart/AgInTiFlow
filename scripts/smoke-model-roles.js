#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUXILIARY_MODEL_CATALOG,
  MODEL_PROVIDER_GROUPS,
  getModelRoleDefaults,
  getProviderDefaults,
  modelsForProviderGroup,
  normalizeReasoningEffort,
  selectModelRoute,
} from "../src/model-routing.js";
import { createChatCompletion, normalizeTextToolCallResponse, parseTextToolCalls, usesTextToolProtocol } from "../src/model-client.js";
import { modelRoleChoices, selectorVisibleWindow } from "../src/interactive-cli.js";
import { normalizeProviderId, resolveProviderDefaults } from "../src/provider-contract.js";
import {
  buildScsEvidencePack,
  buildSupervisorInstruction,
  createScsPlan,
  deterministicPlanActionContradiction,
  deterministicPlanRoutineIssue,
  reviewScsFinish,
  reviewScsProgress,
  resolveScsJsonLane,
  resolveScsValidationMode,
  shouldActivateScs,
  shouldRequestScsReplan,
} from "../src/scs-controller.js";
import {
  buildScsEvidenceLedger,
  deriveScsTaskContract,
  evaluateScsEvidence,
  gitActionsSatisfyContract,
  inferSuccessfulGitActionsFromCommandResult,
} from "../src/scs-evidence.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { classifyGoalIntent, isDirectAnswerIntent } from "../src/goal-intent.js";
import { languageWriterDefaults } from "../src/writing-specialist.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const key of [
  "AGENT_PROVIDER",
  "AGINTI_ROUTE_PROVIDER",
  "AGINTI_ROUTE_MODEL",
  "AGINTI_MAIN_PROVIDER",
  "AGINTI_MAIN_MODEL",
  "AGINTI_SPARE_PROVIDER",
  "AGINTI_SPARE_MODEL",
]) {
  delete process.env[key];
}
process.env.AGINTI_LOCAL_FIRST = "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role CLI smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role CLI smoke failed ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function runInteractive(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin/aginti-cli.js"), "chat"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "test-deepseek-key-not-real",
        VENICE_API_KEY: process.env.VENICE_API_KEY || "test-venice-key-not-real",
        AGINTIFLOW_NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("model role interactive smoke timed out"));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`model role interactive smoke failed ${code}\n${stdout}\n${stderr}`));
    });
    child.stdin.end(input);
  });
}

const roles = getModelRoleDefaults();
assert(roles.route.provider === "localllm", "route provider default should be localllm");
assert(roles.route.model === "localllm-fast", "route model default should be localllm-fast");
assert(roles.main.provider === "localllm", "main provider default should be localllm");
assert(roles.main.model === "localllm-deep", "main model default should be localllm-deep");
assert(
  roles.spare.provider === "localllm" && roles.spare.model === "localllm-deep",
  "local-first spare model should stay on LocalLLM Deep unless explicitly changed"
);
assert(roles.wrapper.provider === "codex" && roles.wrapper.model === "gpt-5.5", "wrapper default should be Codex GPT-5.5");
assert(roles.auxiliary.provider === "grsai" && roles.auxiliary.model === "nano-banana-2", "auxiliary default should be GRS AI Nano Banana");

const envSnapshot = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  AGINTI_MAIN_REASONING: process.env.AGINTI_MAIN_REASONING,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  LOCALLLM_BASE_URL: process.env.LOCALLLM_BASE_URL,
  LOCALLLM_MODEL: process.env.LOCALLLM_MODEL,
  AGINTI_WRITING_PROVIDER_ZH: process.env.AGINTI_WRITING_PROVIDER_ZH,
  AGINTI_WRITING_MODEL_ZH: process.env.AGINTI_WRITING_MODEL_ZH,
};
process.env.OPENAI_BASE_URL = "https://openai-compatible.example/v1";
process.env.LLM_BASE_URL = "https://generic-compatible.example/v1";
assert(getProviderDefaults("openai").baseURL === "https://openai-compatible.example/v1", "OPENAI_BASE_URL should override LLM_BASE_URL for OpenAI provider");
delete process.env.OPENAI_BASE_URL;
assert(getProviderDefaults("openai").baseURL === "https://generic-compatible.example/v1", "LLM_BASE_URL should remain OpenAI fallback when OPENAI_BASE_URL is unset");
process.env.LLM_BASE_URL = "https://generic-compatible.example/v1";
process.env.LLM_MODEL = "hosted-generic-model";
assert(getProviderDefaults("localllm").baseURL === "http://127.0.0.1:8008/v1", "LocalLLM must not inherit generic LLM_BASE_URL");
assert(getProviderDefaults("localllm").model === "localllm-fast", "LocalLLM must not inherit generic LLM_MODEL");
process.env.LOCALLLM_BASE_URL = "http://127.0.0.1:1234/v1";
process.env.LOCALLLM_MODEL = "local-smoke-model";
assert(getProviderDefaults("local").provider === "localllm", "local provider alias should normalize to localllm");
assert(getProviderDefaults("local-llm").provider === "localllm", "local-llm provider alias should normalize to localllm");
assert(getProviderDefaults("local_llm").provider === "localllm", "local_llm provider alias should normalize to localllm");
assert(normalizeProviderId("ollama", "") === "", "raw ollama must not alias to canonical LocalLLM");
assert(normalizeProviderId("lmstudio", "") === "", "raw lmstudio must not alias to canonical LocalLLM");
assert(normalizeProviderId("ollama") === "", "default provider normalization must not reinterpret raw ollama as LocalLLM");
let rejectedUnknownProvider = false;
try {
  getProviderDefaults("ollama");
} catch (error) {
  rejectedUnknownProvider = error?.code === "PROVIDER_UNKNOWN";
}
assert(rejectedUnknownProvider, "exported provider defaults must reject unknown/raw engine labels instead of silently selecting LocalLLM");
assert(
  resolveProviderDefaults("deepseek", { DEEPSEEK_API_KEY: "deepseek-specific", LLM_API_KEY: "stale-generic" }).apiKey ===
    "deepseek-specific",
  "DeepSeek-specific credentials must take precedence over a stale generic LLM_API_KEY"
);
assert(
  resolveProviderDefaults("openai", { OPENAI_API_KEY: "openai-specific", LLM_API_KEY: "stale-generic" }).apiKey ===
    "openai-specific",
  "OpenAI-specific credentials must take precedence over a stale generic LLM_API_KEY"
);
assert(getProviderDefaults("localllm").baseURL === "http://127.0.0.1:1234/v1", "LocalLLM should accept loopback LOCALLLM_BASE_URL");
assert(getProviderDefaults("localllm").model === "local-smoke-model", "LocalLLM should honor LOCALLLM_MODEL");
delete process.env.LOCALLLM_BASE_URL;
delete process.env.LOCALLLM_MODEL;
delete process.env.LLM_MODEL;
process.env.AGINTI_MAIN_REASONING = "provider-default";
assert(getModelRoleDefaults().main.reasoning === "", "provider-default main reasoning should normalize to omitted reasoning");
process.env.AGINTI_MAIN_REASONING = "none";
assert(getModelRoleDefaults().main.reasoning === "", "none main reasoning should normalize to omitted reasoning");
assert(normalizeReasoningEffort("min") === "minimal", "min reasoning alias should normalize to minimal");
assert(normalizeReasoningEffort("extra-high") === "xhigh", "extra-high reasoning alias should normalize to xhigh");
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.OPENAI_API_KEY = "test-openai-key";
delete process.env.AGINTI_WRITING_PROVIDER_ZH;
delete process.env.AGINTI_WRITING_MODEL_ZH;
const zhWriterRoute = languageWriterDefaults({ language: "zh-Hans", writingBrief: "写一段小说。" }, { provider: "mock", model: "mock-agent" });
assert(zhWriterRoute.provider === "mock" && zhWriterRoute.model === "mock-agent", "Chinese writing must not escape the active provider through ambient keys");
const enWriterRoute = languageWriterDefaults({ language: "en", writingBrief: "Write a scene." }, { provider: "mock", model: "mock-agent" });
assert(enWriterRoute.provider === "mock" && enWriterRoute.model === "mock-agent", "English writing must not escape the active provider through ambient keys");
process.env.AGINTI_WRITING_PROVIDER_ZH = "deepseek";
process.env.AGINTI_WRITING_MODEL_ZH = "deepseek-test-writer";
const zhEnvWriterRoute = languageWriterDefaults(
  { language: "zh-Hans", writingBrief: "写一段小说。" },
  { provider: "mock", model: "mock-agent", allowHostedWritingSpecialist: true }
);
assert(zhEnvWriterRoute.provider === "deepseek" && zhEnvWriterRoute.model === "deepseek-test-writer", "explicit language-specific writer env should override session routing");
for (const [key, value] of Object.entries(envSnapshot)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const helloIntent = classifyGoalIntent("hello");
assert(isDirectAnswerIntent(helloIntent), "bare hello should be classified as direct conversational intent");
assert(helloIntent.requiresTools === false, "bare hello should not require tools");
assert(classifyGoalIntent("你好").directAnswer.includes("你好"), "Chinese greeting should get a direct Chinese reply");
assert(classifyGoalIntent("say hello in Japanese").directAnswer.includes("こんにちは"), "Japanese greeting request should answer directly");
assert(classifyGoalIntent("create hello.py").requiresTools, "explicit file creation should remain agentic");
assert(classifyGoalIntent("write a hello-world Python script and run it").requiresTools, "explicit coding task should require tools");

const complexRoute = selectModelRoute({
  routingMode: "complex",
  provider: "deepseek",
  mainModel: "deepseek-v4-pro",
});
assert(complexRoute.model === "deepseek-v4-pro", "complex route did not use main model override");

const fastRoute = selectModelRoute({
  routingMode: "fast",
  provider: "deepseek",
  routeModel: "deepseek-v4-flash",
});
assert(fastRoute.model === "deepseek-v4-flash", "fast route did not use route model override");

const simpleSmartRoute = selectModelRoute({
  routingMode: "smart",
  provider: "localllm",
  goal: "say hello",
  taskProfile: "auto",
});
assert(simpleSmartRoute.provider === "localllm", "simple smart route should use LocalLLM provider");
assert(simpleSmartRoute.model === "localllm-fast", "simple smart route should use the route model");
assert(
  !shouldActivateScs("auto", {
    goal: "say hello",
    taskProfile: "auto",
    complexityScore: simpleSmartRoute.complexityScore,
  }),
  "SCS auto should stay inactive for simple turns"
);

const moderateSmartRoute = selectModelRoute({
  routingMode: "smart",
  provider: "localllm",
  goal: "implement a focused refactor design for one module",
  taskProfile: "auto",
});
assert(moderateSmartRoute.provider === "localllm", "moderate smart route should use LocalLLM provider");
assert(moderateSmartRoute.model === "localllm-deep", "moderate smart route should use the main model");
assert(
  !shouldActivateScs("auto", {
    goal: "implement a focused refactor design for one module",
    taskProfile: "auto",
    complexityScore: moderateSmartRoute.complexityScore,
  }),
  "SCS auto should not gate every main-model turn"
);

const highRiskSmartRoute = selectModelRoute({
  routingMode: "smart",
  provider: "localllm",
  goal: "debug failing tests and fix the build in a large repo, then commit and push",
  taskProfile: "auto",
});
assert(highRiskSmartRoute.provider === "localllm", "high-risk smart route should use LocalLLM provider");
assert(highRiskSmartRoute.model === "localllm-deep", "high-risk smart route should use the main model");
assert(
  shouldActivateScs("auto", {
    goal: "debug failing tests and fix the build in a large repo, then commit and push",
    taskProfile: "auto",
    complexityScore: highRiskSmartRoute.complexityScore,
  }),
  "SCS auto should activate for high-risk evidence-bearing work"
);
assert(
  !shouldActivateScs("auto", { goal: "explain this function", taskProfile: "code", complexityScore: 0 }),
  "code profile alone should not force SCS auto"
);

const simpleRuntimeConfig = resolveRuntimeConfig({
  goal: "say hello",
  provider: "localllm",
  routingMode: "smart",
  taskProfile: "auto",
});
assert(simpleRuntimeConfig.enableScs === "auto", "runtime config should default SCS mode to auto");
assert(simpleRuntimeConfig.scsActive === false, "simple runtime config should not activate SCS");
assert(simpleRuntimeConfig.provider === "localllm", "simple runtime config should use LocalLLM provider");
assert(simpleRuntimeConfig.model === "localllm-fast", "simple runtime config should use route model");

const moderateRuntimeConfig = resolveRuntimeConfig({
  goal: "implement a focused refactor design for one module",
  provider: "localllm",
  routingMode: "smart",
  taskProfile: "auto",
});
assert(moderateRuntimeConfig.scsActive === false, "moderate main-model work should not automatically activate SCS");
assert(moderateRuntimeConfig.provider === "localllm", "moderate runtime config should use LocalLLM provider");
assert(moderateRuntimeConfig.model === "localllm-deep", "moderate runtime config should use main model");

const highRiskRuntimeConfig = resolveRuntimeConfig({
  goal: "debug failing tests and fix the build in a large repo, then commit and push",
  provider: "localllm",
  routingMode: "smart",
  taskProfile: "auto",
});
assert(highRiskRuntimeConfig.scsActive === true, "high-risk runtime config should activate SCS");
assert(highRiskRuntimeConfig.provider === "localllm", "SCS runtime config should use LocalLLM provider by default");
assert(highRiskRuntimeConfig.model === "localllm-deep", "SCS runtime config should use main model");

const customGatewayRuntimeConfig = resolveRuntimeConfig({
  goal: "use a custom OpenAI-compatible model alias",
  provider: "deepseek",
  routingMode: "complex",
  taskProfile: "auto",
  mainProvider: "openai",
  mainModel: "gpt-5.4-high",
  mainReasoning: "none",
});
assert(customGatewayRuntimeConfig.provider === "openai", "custom OpenAI-compatible runtime should route through OpenAI provider");
assert(customGatewayRuntimeConfig.model === "gpt-5.4-high", "custom OpenAI-compatible runtime should preserve arbitrary model string");
assert(customGatewayRuntimeConfig.reasoning === "", "custom OpenAI-compatible runtime should omit reasoning when requested");

const chatPayloadCalls = [];
const fakeOpenAiClient = {
  chat: {
    completions: {
      create: async (payload) => {
        chatPayloadCalls.push(payload);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  },
};
await createChatCompletion(
  fakeOpenAiClient,
  { model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] },
  { provider: "openai", reasoning: "high" },
  "smoke reasoning request"
);
assert(chatPayloadCalls[0].reasoning_effort === "high", "OpenAI chat payload should include non-empty reasoning_effort");
await createChatCompletion(
  fakeOpenAiClient,
  { model: "gpt-5.4-high", messages: [{ role: "user", content: "hello" }] },
  { provider: "openai", reasoning: "provider-default" },
  "smoke provider-default reasoning request"
);
assert(!("reasoning_effort" in chatPayloadCalls[1]), "Provider-default reasoning should omit reasoning_effort");
let retryAttempts = 0;
const retryOpenAiClient = {
  chat: {
    completions: {
      create: async (payload) => {
        retryAttempts += 1;
        if (payload.reasoning_effort) throw new Error("Unsupported parameter: reasoning_effort");
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  },
};
await createChatCompletion(
  retryOpenAiClient,
  { model: "gateway-model", messages: [{ role: "user", content: "hello" }] },
  { provider: "openai", reasoning: "medium" },
  "smoke reasoning retry request"
);
assert(retryAttempts === 2, "OpenAI-compatible reasoning retry should retry once without reasoning_effort");

assert(MODEL_PROVIDER_GROUPS["venice-gpt"].provider === "venice", "venice-gpt group missing");
assert(MODEL_PROVIDER_GROUPS["localllm"].provider === "localllm", "localllm group missing");
assert(modelsForProviderGroup("localllm").some((item) => item.id === "localllm-fast"), "localllm group missing localllm-fast");
assert(modelsForProviderGroup("localllm").some((item) => item.id === "localllm-deep"), "localllm group missing localllm-deep");
assert(modelsForProviderGroup("venice").some((item) => item.id === "venice-uncensored-1-2"), "venice group missing Venice 1.2");
assert(modelsForProviderGroup("venice-gemma").some((item) => item.id === "google-gemma-4-31b-it"), "venice-gemma bucket missing Gemma 4 instruct");
assert(!modelsForProviderGroup("venice-gemma").some((item) => item.id === "gemma-4-uncensored"), "venice-gemma bucket should not include Gemma 4 Uncensored shortcut");
assert(modelsForProviderGroup("venice-gpt").some((item) => item.id === "openai-gpt-54-mini"), "venice-gpt bucket missing GPT-5.4 Mini");
assert(modelsForProviderGroup("venice-claude").some((item) => item.id === "claude-opus-4-7"), "venice-claude bucket missing Claude Opus 4.7");
assert(modelsForProviderGroup("venice-qwen").some((item) => item.id === "qwen3-coder-480b-a35b-instruct-turbo"), "venice-qwen bucket missing Qwen Coder");
assert(AUXILIARY_MODEL_CATALOG["venice-image"].some((item) => item.id === "gpt-image-2"), "Venice image catalog missing GPT Image 2");
assert(AUXILIARY_MODEL_CATALOG["venice-image"].some((item) => item.id === "wan-2-7-pro-edit"), "Venice image catalog missing Wan edit");
assert(MODEL_PROVIDER_GROUPS["openrouter"].provider === "openrouter", "openrouter group missing");
assert(MODEL_PROVIDER_GROUPS["openrouter-openai"].provider === "openrouter", "openrouter-openai group missing");
assert(modelsForProviderGroup("openrouter").some((item) => item.id === "openrouter/auto"), "openrouter group missing auto router");
assert(modelsForProviderGroup("openrouter-openai").some((item) => item.id === "openai/gpt-5.4-mini"), "openrouter OpenAI bucket missing GPT-5.4 Mini");
assert(modelsForProviderGroup("openrouter-anthropic").some((item) => item.id === "anthropic/claude-sonnet-4.6"), "openrouter Anthropic bucket missing Claude Sonnet");
assert(modelsForProviderGroup("openrouter-google").some((item) => item.id === "google/gemini-3.5-flash"), "openrouter Google bucket missing Gemini");
assert(modelsForProviderGroup("openrouter-deepseek").some((item) => item.id === "deepseek/deepseek-v4-pro"), "openrouter DeepSeek bucket missing V4 Pro");
assert(modelsForProviderGroup("openrouter-qwen").some((item) => item.id === "qwen/qwen3.7-max"), "openrouter Qwen bucket missing Qwen Max");
assert(!modelsForProviderGroup("openai").some((item) => item.id === "gpt-5.4-high"), "OpenAI catalog should not include synthetic gpt-5.4-high alias");
const routeChoices = modelRoleChoices("route").map((item) => `${item.provider}/${item.model}`);
const mainChoices = modelRoleChoices("main").map((item) => `${item.provider}/${item.model}`);
const spareChoices = modelRoleChoices("spare").map((item) => `${item.provider}/${item.model}`);
assert(JSON.stringify(routeChoices) === JSON.stringify(mainChoices), "route and main selectors should share the same text-model list");
assert(JSON.stringify(routeChoices) === JSON.stringify(spareChoices), "route and spare selectors should share the same text-model list");
for (const expected of [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "localllm/localllm-fast",
  "localllm/localllm-deep",
  "venice/venice-uncensored-1-2",
  "venice/venice-uncensored",
  "venice/gemma-4-uncensored",
  "venice/google-gemma-4-31b-it",
  "venice/google-gemma-4-26b-a4b-it",
  "venice/openai-gpt-55",
  "venice/openai-gpt-54-mini",
  "venice/claude-sonnet-4-6",
  "venice/claude-opus-4-7",
  "venice/qwen3-6-27b",
  "venice/qwen3-coder-480b-a35b-instruct-turbo",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
  "openrouter/openrouter/auto",
  "openrouter/openai/gpt-5.4-mini",
  "openrouter/anthropic/claude-sonnet-4.6",
  "openrouter/google/gemini-3.5-flash",
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/qwen/qwen3.7-max",
  "qwen/qwen-plus",
  "mock/mock-agent",
]) {
  assert(routeChoices.includes(expected), `shared model selector missing ${expected}`);
}
assert(!routeChoices.includes("venice/e2ee-venice-uncensored-24b-p"), "shared model selector should hide unstable E2EE Venice 1.1");
assert(modelRoleChoices("route").some((item) => item.provider === "openai" && item.model === "gpt-5.5" && item.reasoningOptions.includes("xhigh")), "OpenAI selector missing reasoning levels");
assert(modelRoleChoices("route").some((item) => item.provider === "openai" && item.model === "gpt-5.5" && item.reasoningOptions.includes("")), "OpenAI selector missing Provider default reasoning option");
assert(modelRoleChoices("auxiliary").some((item) => item.provider === "grsai"), "auxiliary selector missing GRS AI");
assert(modelRoleChoices("auxiliary").some((item) => item.provider === "venice" && item.model === "wan-2-7-pro-edit"), "auxiliary selector missing Venice Wan edit");
const longAuxiliaryWindow = selectorVisibleWindow(32, 17, 24);
assert(longAuxiliaryWindow.end - longAuxiliaryWindow.start <= 8, "selector should cap visible rows for long option lists");
assert(longAuxiliaryWindow.topHidden > 0 && longAuxiliaryWindow.bottomHidden > 0, "selector should expose scroll indicators around middle selections");
const topAuxiliaryWindow = selectorVisibleWindow(32, 0, 24);
assert(topAuxiliaryWindow.start === 0 && topAuxiliaryWindow.bottomHidden > 0, "selector should keep first option visible at top of long lists");
const parsedTextToolCalls = parseTextToolCalls('[TOOL_CALLS]list_files[ARGS]call_123[ARGS]{"path":".","maxDepth":1}');
assert(parsedTextToolCalls.length === 1, "Venice text tool-call parser did not detect encoded tool call");
assert(parsedTextToolCalls[0].function.name === "list_files", "Venice text tool-call parser returned wrong tool name");
assert(parsedTextToolCalls[0].function.arguments.includes('"maxDepth":1'), "Venice text tool-call parser returned wrong arguments");
const looseTextToolCalls = parseTextToolCalls('[TOOL_CALLS]list_files[ARGS]{"path":"."}[TOOL_CALLS]inspect_project[ARGS]{"path":"."}');
assert(looseTextToolCalls.length === 2, "Venice loose text tool-call parser did not detect multiple calls");
assert(looseTextToolCalls[1].function.name === "inspect_project", "Venice loose text tool-call parser returned wrong second tool");
const nativeMarkerText = parseTextToolCalls('Done. <|tool_call>call:finish{result:<|"|>Done<|"|>}');
assert(nativeMarkerText.length === 0, "native marker text should not be treated as JSON text tool call");
const jsonBlockToolCalls = parseTextToolCalls('TOOL_CALLS:\n```json\n[{"name":"list_files","arguments":{"path":"/workspace"}}]\n```');
assert(jsonBlockToolCalls.length === 1, "Venice JSON text tool-call parser did not detect JSON block calls");
assert(jsonBlockToolCalls[0].function.arguments.includes("/workspace"), "Venice JSON text tool-call parser returned wrong arguments");
const requestedToolCalls = parseTextToolCalls(
  'Requested tools: write_file({"path":"story-ja.txt","content":"雨の夜、彼女は「また会える」と笑った。","mode":"create"})'
);
assert(requestedToolCalls.length === 1, "Requested tools parser did not detect function-call text");
assert(requestedToolCalls[0].function.name === "write_file", "Requested tools parser returned wrong tool name");
assert(requestedToolCalls[0].function.arguments.includes("story-ja.txt"), "Requested tools parser returned wrong arguments");
const multipleRequestedToolCalls = parseTextToolCalls(
  'Requested tools: list_files({"path":"."}); inspect_project({"path":".","maxDepth":2})'
);
assert(multipleRequestedToolCalls.length === 2, "Requested tools parser did not detect multiple function-call texts");
assert(multipleRequestedToolCalls[1].function.name === "inspect_project", "Requested tools parser returned wrong second requested tool");
const xmlTextToolCalls = parseTextToolCalls(
  '<tool_calls>\n<tool_call name="inspect_project">{"project_path":"/workspace"}</tool_call>\n<tool_call name="list_files">{"path":".","depth":2}</tool_call>\n</tool_calls>'
);
assert(xmlTextToolCalls.length === 2, "XML text tool-call parser did not detect multiple calls");
assert(xmlTextToolCalls[0].function.name === "inspect_project", "XML text tool-call parser returned wrong first tool");
assert(xmlTextToolCalls[1].function.arguments.includes('"depth":2'), "XML text tool-call parser returned wrong arguments");
const functionParameterToolCalls = parseTextToolCalls(
  'I will inspect the file.\n<function=read_file>\n<parameter=path>\nservice_ctl.py\n</parameter>\n</function>\n</tool_call>'
);
assert(
  functionParameterToolCalls.length === 1,
  "function/parameter text tool-call parser did not tolerate the local model closing-tag dialect"
);
assert(
  functionParameterToolCalls[0].function.name === "read_file" &&
    JSON.parse(functionParameterToolCalls[0].function.arguments).path === "service_ctl.py",
  "function/parameter text tool-call parser returned the wrong name or path"
);
const typedFunctionParameterToolCall = parseTextToolCalls(
  '<function=read_file><parameter=startLine>12</parameter><parameter=includeHidden>false</parameter></function>'
);
assert(
  JSON.parse(typedFunctionParameterToolCall[0].function.arguments).startLine === 12 &&
    JSON.parse(typedFunctionParameterToolCall[0].function.arguments).includeHidden === false,
  "function/parameter text tool-call parser did not preserve primitive argument types"
);
const normalizedFunctionParameterToolResponse = normalizeTextToolCallResponse({
  choices: [{
    message: {
      role: "assistant",
      content:
        'Let me read it.\n<function=read_file><parameter=path>tests/test_service_ctl.py</parameter></function></tool_call>',
    },
  }],
});
assert(
  normalizedFunctionParameterToolResponse.choices[0].message.tool_calls?.length === 1 &&
    normalizedFunctionParameterToolResponse.choices[0].message.content === "Let me read it.",
  "function/parameter tool response was not normalized into one native call with clean prose"
);
const standaloneToolObject = JSON.stringify({
  toolName: "apply_patch",
  args: {
    path: "service_ctl.py",
    search: "old source",
    replace: "new source",
    expectedReplacements: 1,
  },
});
const standaloneToolObjectCalls = parseTextToolCalls(
  `I will apply the coherent patch now:\n${standaloneToolObject}\n${standaloneToolObject}`
);
assert(
  standaloneToolObjectCalls.length === 1 &&
    standaloneToolObjectCalls[0].function.name === "apply_patch",
  "line-delimited standalone tool JSON was not parsed and deduplicated"
);
assert(
  JSON.parse(standaloneToolObjectCalls[0].function.arguments).path === "service_ctl.py",
  "standalone tool JSON parser lost the exact arguments"
);
assert(
  parseTextToolCalls(`Example only:\n\u0060\u0060\u0060json\n${standaloneToolObject}\n\u0060\u0060\u0060`).length === 0,
  "a fenced standalone tool example was incorrectly treated as an executable call"
);
const normalizedStandaloneToolResponse = normalizeTextToolCallResponse({
  choices: [{
    message: {
      role: "assistant",
      content: `Applying the patch.\n${standaloneToolObject}`,
    },
  }],
});
assert(
  normalizedStandaloneToolResponse.choices[0].message.tool_calls?.length === 1 &&
    normalizedStandaloneToolResponse.choices[0].message.content === "Applying the patch.",
  "standalone tool JSON response was not normalized into a clean native call"
);
const malformedRequestedToolResponse = normalizeTextToolCallResponse({
  choices: [
    {
      message: {
        role: "assistant",
        content: 'Requested tools: write_file({"path":"story.md","content":"unfinished',
      },
    },
  ],
});
const malformedMessage = malformedRequestedToolResponse.choices[0].message;
assert(malformedMessage.tool_calls?.length === 0, "malformed requested tool text should not fabricate a tool call");
assert(
  malformedMessage.aginti_text_tool_retry?.reason === "malformed-or-truncated-text-tool-call",
  "malformed requested tool text should request a bounded protocol-level retry"
);
assert(!malformedMessage.content.includes("write_file("), "malformed requested tool text should not be surfaced as assistant content");
const cleanedMalformedSuffix = normalizeTextToolCallResponse({
  choices: [
    {
      message: {
        role: "assistant",
        content: 'Here is a normal answer. Requested tools: write_file({"path":"story.md","content":"unfinished',
      },
    },
  ],
});
assert(
  cleanedMalformedSuffix.choices[0].message.content === "Here is a normal answer.",
  "malformed tool suffix should be stripped from otherwise usable assistant content"
);
assert(usesTextToolProtocol({ provider: "venice", model: "gemma-4-uncensored" }), "Venice Gemma should use text tool protocol");
assert(usesTextToolProtocol({ provider: "venice", model: "e2ee-venice-uncensored-24b-p" }), "Venice 1.1 should use text tool protocol");
assert(usesTextToolProtocol({ provider: "venice", model: "venice-uncensored" }), "Venice legacy 1.1 should use text tool protocol");
assert(!usesTextToolProtocol({ provider: "venice", model: "venice-uncensored-1-2" }), "Venice 1.2 should keep native tool calls first");
assert(!usesTextToolProtocol({ provider: "localllm", model: "localllm-fast" }), "LocalLLM should prefer native OpenAI tool calls");
const localScsCommitteeLane = resolveScsJsonLane(
  {
    provider: "localllm",
    model: "localllm-deep",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
    maxOutputTokens: 8192,
    modelTimeoutMs: 180000,
  },
  "SCS committee"
);
assert(localScsCommitteeLane.model === "localllm-deep", "SCS committee did not reuse the selected resident LocalLLM");
assert(localScsCommitteeLane.role === "executor", "resident LocalLLM SCS lane did not report its executor role");
assert(localScsCommitteeLane.maxOutputTokens === 1536, "SCS committee output was not bounded");
assert(localScsCommitteeLane.modelTimeoutMs === 45000, "Local SCS committee timeout was not bounded");
const localScsValidatorLane = resolveScsJsonLane(
  {
    provider: "localllm",
    model: "localllm-deep",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
    maxOutputTokens: 8192,
  },
  "SCS student validator"
);
assert(localScsValidatorLane.maxOutputTokens === 768, "SCS validator output was not bounded");
assert(localScsValidatorLane.model === "localllm-deep", "SCS validator did not reuse the selected resident LocalLLM");
assert(resolveScsValidationMode({ provider: "localllm" }) === "deterministic", "LocalLLM should use runtime validation in auto mode");
assert(resolveScsValidationMode({ provider: "deepseek" }) === "model", "hosted providers should keep model validation in auto mode");
assert(
  resolveScsValidationMode({ provider: "localllm", scsValidationMode: "model" }) === "model",
  "explicit SCS validation mode was not authoritative"
);

let localScsPlanningCalls = 0;
const localScsClient = {
  chat: {
    completions: {
      create: async () => {
        localScsPlanningCalls += 1;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  role: "committee",
                  phase_goal: "Inspect the routine and write the readiness report.",
                  plan: [
                    "Read the selected source guidance.",
                    "Write LOCAL_SCS_READINESS.md from observed evidence.",
                    "Read LOCAL_SCS_READINESS.md once and finish.",
                  ],
                  acceptance_criteria: ["Exact output path is used: LOCAL_SCS_READINESS.md"],
                  allowed_tools: ["read_file", "write_file", "finish"],
                  stop_conditions: ["A required source path is inaccessible."],
                }),
              },
            },
          ],
        };
      },
    },
  },
};
const localScsPlan = await createScsPlan(
  localScsClient,
  {
    provider: "localllm",
    model: "localllm-deep",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
    enableScs: "auto",
    scsValidationMode: "auto",
  },
  {
    goal: "Inspect the current routine and write `LOCAL_SCS_READINESS.md` in this folder. Do not publish or open a browser.",
    messages: [],
    meta: {},
  },
  { taskProfile: "supervision", selectedSkills: [], readOnlyRoots: [] }
);
assert(localScsPlanningCalls === 1, "LocalLLM SCS made a redundant student or committee call");
assert(localScsPlan.scs.validatorMode === "deterministic", "LocalLLM SCS did not record deterministic validation");
assert(localScsPlan.scs.validatorModel === "runtime/deterministic", "LocalLLM SCS reported a model validator");

const noReviewClient = {
  chat: { completions: { create: async () => { throw new Error("deterministic SCS review called a model"); } } },
};
const deterministicProgress = await reviewScsProgress(
  noReviewClient,
  { provider: "localllm", model: "localllm-deep", scsValidationMode: "auto", taskProfile: "supervision" },
  {
    goal: "Continue a source-grounded readiness audit.",
    messages: [],
    meta: { scs: { monitorReviews: 0 } },
  },
  { taskProfile: "supervision", events: [] }
);
assert(deterministicProgress.decision === "accept_phase", "deterministic progress review did not return a bounded decision");
const crossProviderScsLane = resolveScsJsonLane(
  {
    provider: "deepseek",
    model: "deepseek-chat",
    routeProvider: "localllm",
    routeModel: "localllm-fast",
  },
  "SCS committee"
);
assert(crossProviderScsLane.model === "deepseek-chat", "SCS reused a route model through the wrong provider client");
assert(crossProviderScsLane.role === "executor", "Cross-provider SCS lane reported an unsafe route role");
const scsInstruction = buildSupervisorInstruction({ plan: "Create one file.", acceptanceCriteria: ["File exists."] });
assert(scsInstruction.includes("Student-Committee-Supervisor"), "SCS supervisor instruction should define the acronym");
assert(!scsInstruction.includes("Syntax-Checker Sentinel"), "SCS supervisor instruction should not allow alternate acronym expansions");
assert(scsInstruction.includes("student is the independent validator"), "SCS supervisor instruction should define student as validator");
assert(shouldRequestScsReplan({ decision: "finish_rejected" }), "finish rejection should trigger committee replan");
assert(shouldRequestScsReplan({ decision: "rethink_plan" }), "student rethink should trigger committee replan");
assert(!shouldRequestScsReplan({ decision: "finish_allowed" }), "finish approval should not trigger committee replan");
const routineAwareInstruction = buildSupervisorInstruction({
  plan: "Inspect the established routine, then write the report.",
  acceptanceCriteria: ["Report exists."],
  routineContext: {
    commandCwd: "/tmp/workspace",
    readOnlyRoots: ["/tmp/Musia"],
    selectedSkills: [
      {
        id: "musia-music-production",
        path: "/tmp/skills/musia-music-production/SKILL.md",
        description: "Established music workflow.",
      },
    ],
  },
});
assert(routineAwareInstruction.includes("already active structured-read scopes"), "SCS supervisor omitted active read-root semantics");
assert(routineAwareInstruction.includes("never executable commands"), "SCS supervisor omitted skill guidance semantics");
const inventedSkillCommandIssue = deterministicPlanRoutineIssue(
  {
    plan: "Run `musia-music-production --check`, then write MEDIA_ROUTINE_READINESS.md.",
    acceptanceCriteria: ["MEDIA_ROUTINE_READINESS.md exists."],
  },
  {
    readOnlyRoots: ["/tmp/Musia"],
    selectedSkills: [{ id: "musia-music-production", path: "/tmp/skills/musia-music-production/SKILL.md" }],
  },
  "Inspect the existing workflow."
);
assert(inventedSkillCommandIssue?.decision === "veto_plan", "SCS plan gate accepted a selected skill ID as an executable");
const misplacedReadRootIssue = deterministicPlanRoutineIssue(
  { plan: "Run `aginti help --read-root /tmp/Musia` and collect output." },
  { readOnlyRoots: ["/tmp/Musia"], selectedSkills: [] },
  "Inspect the existing workflow."
);
assert(misplacedReadRootIssue?.decision === "veto_plan", "SCS plan gate accepted --read-root as an in-task command flag");
assert(
  !deterministicPlanRoutineIssue(
    { plan: "Read /tmp/skills/musia-music-production/SKILL.md, inspect /tmp/Musia/package.json, and use only documented entry points." },
    {
      readOnlyRoots: ["/tmp/Musia"],
      selectedSkills: [{ id: "musia-music-production", path: "/tmp/skills/musia-music-production/SKILL.md" }],
    },
    "Inspect the existing workflow."
  ),
  "SCS plan gate rejected a sourced routine-aware plan"
);
const readinessBrowserIssue = deterministicPlanRoutineIssue(
  {
    plan:
      "Read the exact skill files, then use open_url to access the editor and click through the live UI before writing MEDIA_ROUTINE_READINESS.md.",
  },
  { readOnlyRoots: ["/tmp/Musia"], selectedSkills: [] },
  [
    "Inspect whether I can use the existing media workflow.",
    "Do not generate, submit, upload, publish, log in, restart services, or edit sibling repositories.",
    "Write MEDIA_ROUTINE_READINESS.md using safe read-only help or status checks.",
  ].join("\n")
);
assert(readinessBrowserIssue?.decision === "veto_plan", "Read-only readiness gate accepted an unnecessary live UI plan");
assert(
  !deterministicPlanRoutineIssue(
    { plan: "Open the requested browser page, inspect its visible state, and save the requested screenshot." },
    { readOnlyRoots: [], selectedSkills: [] },
    "Inspect the browser UI state and take a screenshot without submitting anything."
  ),
  "Readiness gate rejected an explicitly requested live UI inspection"
);
const longStdout = [
  "=== Student-Committee-Supervisor present ===",
  "3:SCS stands for **Student-Committee-Supervisor**",
  "=== Syntax-Checker Sentinel absent ===",
  "OK: absent",
  "=== Residual content ===",
  "py_compile FOUND",
  "f-string FOUND",
  "artifact integrity FOUND",
].join("\n");
const scsEvidence = buildScsEvidencePack({
  goal: "verify SCS artifact",
  messages: [
    {
      role: "tool",
      content: JSON.stringify({ toolName: "run_command", ok: true, stdout: `${longStdout}\n${"x".repeat(700)}` }),
    },
  ],
});
assert(scsEvidence.includes("Student-Committee-Supervisor"), "SCS evidence pack should preserve raw verification stdout");
assert(scsEvidence.includes("Syntax-Checker Sentinel absent"), "SCS evidence pack should keep absence checks visible to the final gate");
assert(scsEvidence.includes("evidenceLedger"), "SCS evidence pack should include the structured evidence ledger");
assert(scsEvidence.includes("evaluation"), "SCS evidence pack should include deterministic contract evaluation");

const uploadContract = deriveScsTaskContract({
  goal:
    "Upload five images in the browser composer and verify visible thumbnails: /tmp/reference-a.png /tmp/reference-b.png /tmp/reference-c.png. Do not submit.",
  taskProfile: "website",
});
const readinessOnlyContract = deriveScsTaskContract({
  goal: [
    "Inspect whether I can make a song, turn it into a video, and publish it through the existing tools.",
    "Do not generate, submit, upload, publish, log in, restart services, or edit sibling repositories in this test.",
    "Write MEDIA_ROUTINE_READINESS.md and run safe read-only help checks.",
  ].join("\n"),
  taskProfile: "auto",
});
assert(
  readinessOnlyContract.requiredEvidence.some((item) => item.category === "file") &&
    readinessOnlyContract.requiredEvidence.some((item) => item.category === "command"),
  "read-only readiness contract omitted report/check evidence"
);
assert(
  !readinessOnlyContract.requiredEvidence.some((item) => ["publish", "browser", "visual", "artifact"].includes(item.category)),
  "read-only readiness contract required a forbidden external action or target artifact"
);
assert(
  uploadContract.exactInputPaths.includes("/tmp/reference-a.png") &&
    uploadContract.exactInputPaths.includes("/tmp/reference-b.png") &&
    uploadContract.exactInputPaths.includes("/tmp/reference-c.png"),
  "SCS contract should preserve exact input/reference paths for browser upload tasks"
);
const uploadImagePlanContradiction = deterministicPlanActionContradiction(
  "Find the latest .mp4 in the project, upload the video file, then click submit.",
  uploadContract
);
assert(
  /video-file upload/i.test(uploadImagePlanContradiction || ""),
  "SCS deterministic plan gate should reject invented video-file uploads for image-upload tasks"
);
assert(
  !deterministicPlanActionContradiction("Upload the five images, verify thumbnails, and do not submit.", uploadContract),
  "SCS deterministic plan gate should allow matching image-upload plans"
);
assert(uploadContract.requiresExternalEvidence, "browser upload contract should require external evidence");
assert(
  uploadContract.requiredEvidence.some((item) => item.category === "browser"),
  "browser upload contract should require browser evidence"
);
assert(
  uploadContract.requiredEvidence.some((item) => item.category === "visual"),
  "visible upload contract should require visual evidence"
);
assert(uploadContract.forbiddenActions.some((item) => /submit/i.test(item)), "contract should preserve forbidden submit action");

const weakUploadLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper set-file-input PAGE_ID reference-a.png reference-b.jpg" },
          stdout: '{"ok":true,"nodeCount":1}',
        }),
      },
    ],
  },
});
const weakUploadEval = evaluateScsEvidence(uploadContract, weakUploadLedger);
assert(!weakUploadEval.ok, "set-file-input alone should not satisfy visible upload evidence");
assert(weakUploadEval.missing.some((item) => item.category === "visual"), "weak upload evidence should miss visual proof");

const strongUploadLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper upload-images-verify PAGE_ID reference-a.png reference-b.jpg --screenshot outputs/upload.png" },
          stdout: '{"ok":true,"visibleEvidenceCount":5,"screenshot":"outputs/upload.png"}',
        }),
      },
    ],
  },
});
const strongUploadEval = evaluateScsEvidence(uploadContract, strongUploadLedger);
assert(strongUploadEval.ok, "visible upload verifier evidence should satisfy browser and visual contract");
const weakUploadFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "website" },
  {
    goal: uploadContract.outcome,
    messages: weakUploadLedger.items.map((item) => ({
      role: "tool",
      content: JSON.stringify({
        toolName: item.toolName || "run_command",
        ok: true,
        stdout: item.proof,
        args: { command: item.target || "" },
      }),
    })),
  },
  "Done, uploaded five images.",
  { goal: uploadContract.outcome, taskProfile: "website" }
);
assert(weakUploadFinish.decision === "finish_rejected", "SCS finish gate should reject upload claim without visual evidence");
assert(/visual|missing/i.test(weakUploadFinish.reason), "SCS finish rejection should name missing evidence");
const strongUploadFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "website" },
  {
    goal: uploadContract.outcome,
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "scripts/cdp-helper upload-images-verify PAGE_ID --screenshot outputs/upload.png" },
          stdout: '{"ok":true,"visibleEvidenceCount":5,"screenshot":"outputs/upload.png"}',
        }),
      },
    ],
  },
  "Done, verified five visible uploaded images.",
  { goal: uploadContract.outcome, taskProfile: "website" }
);
assert(strongUploadFinish.decision === "finish_allowed", "SCS finish gate should allow satisfied upload evidence");

const refreshedSecurityContract = deriveScsTaskContract({
  goal: "Fix the security issue and run the regression tests.",
  taskProfile: "security",
});
const staleContractFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "security" },
  {
    goal: refreshedSecurityContract.outcome,
    meta: {
      scs: {
        taskContract: {
          ...refreshedSecurityContract,
          requiredEvidence: [
            ...refreshedSecurityContract.requiredEvidence,
            { id: "browser", category: "browser", description: "stale browser evidence" },
          ],
        },
      },
    },
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "write_file",
          ok: true,
          path: "SECURITY.md",
          args: { path: "SECURITY.md" },
        }),
      },
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "run_command",
          ok: true,
          exitCode: 0,
          args: { command: "python -m unittest discover -s tests -v" },
          stdout: "Ran 10 tests\nOK",
        }),
      },
    ],
  },
  "Implemented the security repair and all 10 regression tests pass.",
  {
    goal: refreshedSecurityContract.outcome,
    taskProfile: "security",
    taskContract: refreshedSecurityContract,
  }
);
assert(
  staleContractFinish.decision === "finish_allowed",
  "SCS final review reused an obsolete persisted contract instead of the accepted completion contract"
);

const codeContract = deriveScsTaskContract({
  goal: "Fix the bug in src/app.js and run the test.",
  taskProfile: "code",
});
const commitContract = deriveScsTaskContract({
  goal: "Commit only analysis.py and AGINTI.md after the tests pass.",
  taskProfile: "code",
});
const correctionCommitContract = deriveScsTaskContract({
  goal: "Fix analysis.py without changing validated results or artifact names, run the exact tests, commit only the intentional source correction, and verify clean status.",
  taskProfile: "code",
});
const pythonTypeAnnotationContract = deriveScsTaskContract({
  goal: "Continue the security repair. The prior write incorrectly treated safe Python type annotations as credentials. Complete the regression tests and commit the intentional work.",
  taskProfile: "security",
});
const gitStatusLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "run_command",
          exitCode: 0,
          args: { command: "git status --short && git diff --stat" },
          stdout: " M analysis.py",
        }),
      },
    ],
  },
});
const gitCommitLedger = buildScsEvidenceLedger({
  state: {
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          toolName: "run_command",
          exitCode: 0,
          args: { command: "git add analysis.py AGINTI.md && git commit -m 'finish analysis'" },
          stdout: "[main abc1234] finish analysis",
        }),
      },
    ],
  },
});
assert(
  commitContract.requiredGitActions.includes("commit"),
  "an explicit commit request did not retain the required git action"
);
assert(
  correctionCommitContract.requiredGitActions.includes("commit"),
  "a local without-clause swallowed the later positive commit instruction"
);
assert(
  !pythonTypeAnnotationContract.requiredEvidence.some((item) => item.category === "browser"),
  "Python type annotations fabricated a browser typing requirement"
);
assert(
  correctionCommitContract.exactInputPaths.includes("analysis.py"),
  "a named source file in a correction request was not retained for bounded inspection"
);
assert(
  !correctionCommitContract.forbiddenActions.some((item) => /run the exact tests|commit only/i.test(item)),
  "a local without-clause incorrectly converted later positive instructions into prohibitions"
);
assert(
  evaluateScsEvidence(commitContract, gitStatusLedger).ok === false,
  "read-only git status incorrectly satisfied an explicit commit request"
);
assert(
  evaluateScsEvidence(commitContract, gitStatusLedger).missingGitActions.includes("commit"),
  "the completion deficit did not identify the missing commit"
);
const committedEvaluation = evaluateScsEvidence(commitContract, gitCommitLedger);
assert(
  committedEvaluation.missingGitActions.length === 0 &&
    !committedEvaluation.missing.some((item) => item.category === "git"),
  "a successful git commit did not satisfy the explicit git requirement"
);
const recoveredCommitActions = inferSuccessfulGitActionsFromCommandResult({
  ok: true,
  exitCode: 0,
  args: {
    command:
      'echo "seed author: $(git log -1 --format=\'%an <%ae>\')"; git config user.name "$(git log -1 --format=\'%an\')"; git commit -m "finish handoff" && git log -1 --oneline',
  },
  stdout: "[main abc1234] finish handoff\n 8 files changed, 499 insertions(+)",
});
assert(
  recoveredCommitActions.length === 1 && recoveredCommitActions[0] === "commit",
  "a canonical successful commit was lost because its command had a setup prefix or shell expansion"
);
assert(
  gitActionsSatisfyContract(
    { requiredGitActions: ["add", "commit"] },
    recoveredCommitActions
  ),
  "a successful commit did not satisfy the implied staging step after a partially successful add/commit chain"
);
const explainCodeContract = deriveScsTaskContract({
  goal: "Explain JavaScript closures at a high level.",
  taskProfile: "code",
});
const noteFileContract = deriveScsTaskContract({
  goal: "Create notes/hello.md with a short smoke-test note.",
  taskProfile: "code",
});
const canvasArtifactContract = deriveScsTaskContract({
  goal: "Create a canvas artifact preview for this smoke test.",
});
const jsonObjectContract = deriveScsTaskContract({
  goal: "Extract a valid JSON object with schema from this text.",
});
const virtualFileContract = deriveScsTaskContract({
  goal: "Create file: /workspace/virtual-output.txt with virtual Docker path support.",
});
const requiredWriterToolContract = deriveScsTaskContract({
  goal: "Call writing_specialist again and create final/story.md.",
  taskProfile: "writing",
});
const outputListContract = deriveScsTaskContract({
  goal: [
    "Create:",
    "- `work/demo/generate_items.py`",
    "- `work/demo/review_items.py`",
    "",
    "Validate with `work/demo/validate_items.py` before promoting output.",
    "Do not treat `work/demo/existing_validator.py` as an output artifact.",
    "",
    "Output structure:",
    "- `build/demo/primary/color/book.pdf`",
    "- `build/demo/secondary/color/book.pdf`",
    "",
    "Each generated item file goes to:",
    "`data/demo/items/{item_id}.json`",
  ].join("\n"),
  taskProfile: "code",
});
const manyOutputContract = deriveScsTaskContract({
  goal: [
    "Required outputs:",
    "- `out/a01.json`",
    "- `out/a02.json`",
    "- `out/a03.json`",
    "- `out/a04.json`",
    "- `out/a05.json`",
    "- `out/a06.json`",
    "- `out/a07.json`",
    "- `out/a08.json`",
    "- `out/a09.json`",
    "- `out/a10.json`",
    "- `out/a11.json`",
    "- `out/a12.json`",
  ].join("\n"),
  taskProfile: "code",
});
const generatedReviewContract = deriveScsTaskContract({
  goal: [
    "Review focus: changed files only",
    "Run a bounded, evidence-based code review of this workspace.",
    "Exclude generated, vendored, binary, cache, and large artifact paths.",
    "Final answer format: Findings first with file/line references.",
  ].join("\n"),
  taskProfile: "review",
});
const qaCleanupContract = deriveScsTaskContract({
  goal: "Inspect the project, figure out what is actually wrong, fix the failing tests, clean up generated test debris, and commit only the intentional fix.",
  taskProfile: "qa",
});
const generatedFigureContract = deriveScsTaskContract({
  goal: "Generate a publication-ready figure that compares the two repair strategies.",
  taskProfile: "design",
});
assert(
  !explainCodeContract.requiresExternalEvidence,
  "code profile alone should not force external evidence for a pure explanation"
);
assert(
  noteFileContract.requiredEvidence.some((item) => item.category === "file") &&
    !noteFileContract.requiredEvidence.some((item) => item.category === "command"),
  "simple markdown note creation should require file evidence without an unrelated command check"
);
assert(
  canvasArtifactContract.requiredEvidence.some((item) => item.category === "artifact") &&
    !canvasArtifactContract.requiredEvidence.some((item) => item.category === "file") &&
    !canvasArtifactContract.requiredEvidence.some((item) => item.category === "visual"),
  "canvas artifact preview should require artifact evidence without unrelated file or screenshot evidence"
);
assert(
  !jsonObjectContract.requiredEvidence.some((item) => item.category === "file"),
  "JSON object extraction should not be treated as a workspace file requirement without an explicit file/path"
);
assert(
  virtualFileContract.requiredEvidence.some((item) => item.category === "file") &&
    !virtualFileContract.requiredEvidence.some((item) => item.category === "artifact"),
  "virtual output filename should require file evidence without treating output in the filename as an artifact"
);
assert(
  requiredWriterToolContract.requiredToolCalls.includes("writing_specialist"),
  "SCS should infer explicitly required specialist tool calls"
);
assert(
  outputListContract.exactOutputPaths.includes("work/demo/generate_items.py") &&
    outputListContract.exactOutputPaths.includes("work/demo/review_items.py") &&
    outputListContract.exactOutputPaths.includes("build/demo/primary/color/book.pdf") &&
    outputListContract.exactOutputPaths.includes("build/demo/secondary/color/book.pdf"),
  "SCS should infer exact outputs from Create/Output structure list sections"
);
assert(
  !outputListContract.exactOutputPaths.includes("work/demo/validate_items.py") &&
    !outputListContract.exactOutputPaths.includes("work/demo/existing_validator.py") &&
    !outputListContract.exactOutputPaths.some((item) => item.includes("{item_id}")),
  "SCS should not treat validator/tool paths or templated paths as exact output artifacts"
);
assert(
  manyOutputContract.exactOutputPaths.length === 12 && manyOutputContract.exactOutputPaths.includes("out/a12.json"),
  "SCS should preserve more than eight exact output paths for multi-artifact tasks"
);
assert(
  generatedReviewContract.requiredEvidence.some((item) => item.category === "command") &&
    !generatedReviewContract.requiredEvidence.some((item) => item.category === "file") &&
    !generatedReviewContract.requiredEvidence.some((item) => item.category === "artifact"),
  "review profile should not turn review-format boilerplate into file/artifact production requirements"
);
assert(
  qaCleanupContract.requiredEvidence.some((item) => item.category === "command") &&
    qaCleanupContract.requiredEvidence.some((item) => item.category === "git") &&
    !qaCleanupContract.requiredEvidence.some((item) => item.category === "artifact"),
  "cleaning generated test debris should not invent an unrelated artifact-delivery requirement"
);
assert(
  generatedFigureContract.requiredEvidence.some((item) => item.category === "artifact"),
  "tightening QA intent phrases removed the real generated-figure artifact gate"
);
const fileOnlyLedger = buildScsEvidenceLedger({
  context: { events: [{ type: "file.changed", data: { path: "src/app.js" } }] },
});
const fileOnlyEval = evaluateScsEvidence(codeContract, fileOnlyLedger);
assert(!fileOnlyEval.ok, "code task should not finish from file evidence without check evidence");
assert(fileOnlyEval.missing.some((item) => item.category === "command"), "code task should require command/check evidence");
const checkedCodeEval = evaluateScsEvidence(
  codeContract,
  buildScsEvidenceLedger({
    context: { events: [{ type: "file.changed", data: { path: "src/app.js" } }] },
    state: {
      messages: [
        {
          role: "tool",
          content: JSON.stringify({ toolName: "run_command", ok: true, exitCode: 0, args: { command: "npm test" }, stdout: "ok" }),
        },
      ],
    },
  })
);
assert(checkedCodeEval.ok, "code task should finish when file and command evidence are both present");
const missingWriterToolEval = evaluateScsEvidence(
  requiredWriterToolContract,
  buildScsEvidenceLedger({
    context: { events: [{ type: "file.changed", data: { path: "final/story.md" } }] },
  })
);
assert(
  !missingWriterToolEval.ok && missingWriterToolEval.missingToolCalls.includes("writing_specialist"),
  "SCS should reject finish when required specialist call is missing"
);
const writerEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-writer-evidence-"));
try {
  const writerArtifactPath = path.join(writerEvidenceRoot, "artifacts", "writer.json");
  fs.mkdirSync(path.dirname(writerArtifactPath), { recursive: true });
  fs.writeFileSync(writerArtifactPath, JSON.stringify({ status: "completed" }), "utf8");
  const presentWriterToolEval = evaluateScsEvidence(
    requiredWriterToolContract,
    buildScsEvidenceLedger({
      context: {
        commandCwd: writerEvidenceRoot,
        events: [
          { type: "file.changed", data: { path: "final/story.md" } },
          { type: "tool.completed", data: { toolName: "writing_specialist", ok: true, artifactPath: writerArtifactPath } },
        ],
      },
    })
  );
  assert(presentWriterToolEval.ok, "SCS should accept required specialist call when tool evidence is present");
} finally {
  fs.rmSync(writerEvidenceRoot, { recursive: true, force: true });
}

const blockedFileFinish = await reviewScsFinish(
  { mock: true },
  { provider: "mock", model: "mock-agent", taskProfile: "code" },
  {
    goal: "Create notes/safe.md with approval-gated content.",
    messages: [
      {
        role: "tool",
        content: JSON.stringify({
          toolName: "write_file",
          ok: false,
          blocked: true,
          needsApproval: true,
          category: "workspace-write",
          reason: "Workspace write requires approval in safe mode.",
          permissionAdvice: { category: "workspace-write", reason: "Approve this workspace write." },
          args: { path: "notes/safe.md" },
        }),
      },
    ],
  },
  "Blocked by guardrail: this workspace write requires approval before creating notes/safe.md.",
  { goal: "Create notes/safe.md with approval-gated content.", taskProfile: "code" }
);
assert(blockedFileFinish.decision === "finish_allowed", "SCS final gate should allow a proven permission blocker report");

const output = await runCli(["models"]);
assert(output.includes("/route") && output.includes("/spare") && output.includes("venice-gpt"), "aginti models output missing role details");

const interactiveOutput = await runInteractive("/venice\n");
assert(interactiveOutput.includes("venice=on"), "/venice did not enable Venice roles");
assert(interactiveOutput.includes("route=venice/venice-uncensored-1-2"), "/venice did not set Venice route role");
assert(interactiveOutput.includes("main=venice/venice-uncensored-1-2"), "/venice did not set Venice main role");
const interactiveGemmaOutput = await runInteractive("/venice 1.1 gemma\n");
assert(interactiveGemmaOutput.includes("route=venice/venice-uncensored"), "/venice 1.1 did not set Venice 1.1 route role");
assert(interactiveGemmaOutput.includes("main=venice/gemma-4-uncensored"), "/venice gemma did not set Gemma 4 main role");
const interactiveOffOutput = await runInteractive("/venice off\n");
assert(interactiveOffOutput.includes("venice=off"), "/venice off did not restore baseline roles");
assert(interactiveOffOutput.includes("route=localllm/localllm-fast"), "/venice off did not restore LocalLLM route role");
assert(interactiveOffOutput.includes("main=localllm/localllm-deep"), "/venice off did not restore LocalLLM main role");

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        "role-defaults",
        "openai-base-url",
        "provider-default-reasoning",
        "writing-specialist-language-routing",
        "openai-chat-reasoning-payload",
        "goal-intent-direct-answer",
        "route-overrides",
        "provider-groups",
        "auxiliary-catalog",
        "selector-windowing",
        "shared-model-selectors",
        "venice-text-tool-parser",
        "requested-tools-parser",
        "malformed-text-tool-retry",
        "scs-supervisor-identity",
        "scs-student-validator-replan",
        "scs-evidence-stdout",
        "scs-contract-evidence-ledger",
        "scs-required-tool-call-contract",
        "cli-models-command",
        "venice-shortcut",
      ],
    },
    null,
    2
  )
);
