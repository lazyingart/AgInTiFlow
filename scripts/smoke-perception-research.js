#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { checkToolUse } from "../src/guardrails.js";
import { runJsonSpecialist } from "../src/json-specialist.js";
import { firstJsonObject, readImage, researchWrapper, webResearch } from "../src/perception-tools.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-perception-research-"));
process.env.AGINTIFLOW_HOME = path.join(tempRoot, ".agintiflow-home");
const runtimeDir = path.join(tempRoot, "runtime");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(path.join(workspace, "artifacts", "screenshots"), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyProviderBoundary({ pngPath, store, config }) {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalLlmKey = process.env.LLM_API_KEY;
  const calls = [];
  const jsonCalls = [];
  const readinessCalls = [];
  process.env.OPENAI_API_KEY = "ambient-openai-key-must-not-route";
  process.env.LLM_API_KEY = "ambient-generic-key-must-not-route";
  const perceptionClientFactory = ({ provider, baseURL }) => {
    const call = { provider, baseURL, payload: null };
    calls.push(call);
    return {
      chat: {
        completions: {
          create: async (payload) => {
            call.payload = payload;
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "Local vision stub",
                      visibleText: [],
                      observations: ["loopback client selected"],
                      issues: [],
                      answer: "local",
                      uncertainty: [],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
      responses: {
        create: async (payload) => {
          call.payload = payload;
          return {
            output_text: JSON.stringify({
              summary: "Explicit OpenAI stub",
              visibleText: [],
              observations: ["hosted client explicitly enabled"],
              issues: [],
              answer: "hosted",
              uncertainty: [],
            }),
            output: [],
          };
        },
      },
    };
  };

  try {
    const guardedImage = checkToolUse({
      toolName: "read_image",
      args: { path: path.relative(config.commandCwd, pngPath), provider: "openai" },
      snapshot: { elements: [] },
      config: { ...config, provider: "localllm", allowHostedImagePerception: false },
    });
    assert(!guardedImage.allowed, "guardrails allowed unapproved hosted image perception");
    const guardedDeepSeekLocalHandoff = checkToolUse({
      toolName: "read_image",
      args: { path: path.relative(config.commandCwd, pngPath) },
      snapshot: { elements: [] },
      config: {
        ...config,
        provider: "deepseek",
        allowLocalImagePerception: true,
        allowHostedImagePerception: false,
      },
    });
    assert(
      guardedDeepSeekLocalHandoff.allowed,
      "guardrails blocked the safe DeepSeek-to-LocalLLM image handoff"
    );
    const blockedDeepSeekWithoutHandoff = checkToolUse({
      toolName: "read_image",
      args: { path: path.relative(config.commandCwd, pngPath) },
      snapshot: { elements: [] },
      config: {
        ...config,
        provider: "deepseek",
        allowLocalImagePerception: false,
        allowHostedImagePerception: false,
      },
    });
    assert(
      !blockedDeepSeekWithoutHandoff.allowed,
      "guardrails allowed auto image perception after every backend handoff was disabled"
    );
    const guardedResearch = checkToolUse({
      toolName: "web_research",
      args: { query: "provider boundary smoke", mode: "openai" },
      snapshot: { elements: [] },
      config: { ...config, provider: "localllm", allowHostedWebResearch: false },
    });
    assert(!guardedResearch.allowed, "guardrails allowed unapproved hosted web research");
    const guardedJson = checkToolUse({
      toolName: "json_specialist",
      args: { task: "extract", schema: { type: "object" }, provider: "openai" },
      snapshot: { elements: [] },
      config: { ...config, provider: "localllm", allowHostedJsonSpecialist: false },
    });
    assert(!guardedJson.allowed, "guardrails allowed an unapproved hosted JSON specialist");

    const local = await readImage(
      { path: path.relative(config.commandCwd, pngPath), prompt: "Use the default backend." },
      {
        ...config,
        provider: "localllm",
        apiKey: "local-dev-key",
        baseURL: "http://127.0.0.1:8008/v1",
        allowHostedImagePerception: false,
        perceptionClientFactory,
        providerReadinessProbe: async (request) => {
          readinessCalls.push(request);
          return {
            ok: true,
            checks: { models: { available: [request.selectedModel] } },
          };
        },
      },
      store
    );
    assert(local.ok && local.provider === "localllm-chat-completions", `Local read_image escaped its boundary: ${local.error || local.provider}`);
    assert(calls.length === 1 && calls[0].provider === "localllm", "ambient OpenAI credentials changed LocalLLM image routing");
    assert(/^http:\/\/(?:127\.0\.0\.1|localhost):8008\/v1\/?$/.test(calls[0].baseURL), "Local vision did not use the loopback LocalLLM endpoint");
    assert(
      readinessCalls.length === 1 && readinessCalls[0].selectedModel === "localllm-vision-xl",
      "Local vision did not authenticate and confirm its selected alias before sending image pixels"
    );
    const localImagePart = calls[0].payload?.messages?.[0]?.content?.find((part) => part?.type === "image_url");
    assert(/^data:image\/png;base64,/.test(localImagePart?.image_url?.url || ""), "LocalLLM vision request did not carry the bounded image pixels");

    const deepSeekWithLocalVision = await readImage(
      { path: path.relative(config.commandCwd, pngPath), prompt: "Inspect locally while DeepSeek handles text." },
      {
        ...config,
        provider: "deepseek",
        allowHostedImagePerception: false,
        perceptionClientFactory,
        providerReadinessProbe: async (request) => ({
          ok: true,
          checks: { models: { available: [request.selectedModel] } },
        }),
      },
      store
    );
    assert(
      deepSeekWithLocalVision.ok && deepSeekWithLocalVision.provider === "localllm-chat-completions",
      `DeepSeek did not hand auto image perception to the safe local backend: ${deepSeekWithLocalVision.error || deepSeekWithLocalVision.provider}`
    );
    assert(calls.length === 2 && calls[1].provider === "localllm", "DeepSeek image handoff escaped to a hosted provider");

    const blockedImage = await readImage(
      { path: path.relative(config.commandCwd, pngPath), provider: "openai", prompt: "Try hosted vision." },
      {
        ...config,
        provider: "localllm",
        allowHostedImagePerception: false,
        perceptionClientFactory,
      },
      store
    );
    assert(!blockedImage.ok && blockedImage.blocked && /explicitly enable allowHostedImagePerception/i.test(blockedImage.error || ""), "Local read_image did not reject unapproved hosted OpenAI");
    assert(calls.length === 2, "Blocked OpenAI image perception still created a hosted client");

    const hostedImage = await readImage(
      { path: path.relative(config.commandCwd, pngPath), provider: "openai", prompt: "Use explicitly approved hosted vision." },
      {
        ...config,
        provider: "localllm",
        allowHostedImagePerception: true,
        perceptionClientFactory,
      },
      store
    );
    assert(hostedImage.ok && hostedImage.provider === "openai-responses", `Explicit OpenAI image perception failed: ${hostedImage.error || "unknown"}`);
    assert(calls.length === 3 && calls[2].provider === "openai", "Explicit OpenAI image permission did not select the hosted client");

    const blockedResearch = await webResearch(
      { query: "boundary smoke", mode: "openai" },
      {
        ...config,
        provider: "localllm",
        allowHostedWebResearch: false,
        perceptionClientFactory,
      },
      store
    );
    assert(!blockedResearch.ok && blockedResearch.blocked, "Local web_research did not visibly reject unapproved OpenAI synthesis");
    assert(blockedResearch.fallbackAvailable, "Blocked hosted research did not preserve safe snippet evidence");
    assert(calls.length === 3, "Blocked hosted web research still created an OpenAI client");

    const hostedResearch = await webResearch(
      { query: "boundary smoke", mode: "openai" },
      {
        ...config,
        provider: "localllm",
        allowHostedWebResearch: true,
        perceptionClientFactory,
      },
      store
    );
    assert(hostedResearch.ok && hostedResearch.provider === "openai-responses-web_search", "Explicit OpenAI web research did not run through the approved client");
    assert(calls.length === 4 && calls[3].provider === "openai", "Explicit OpenAI web research permission did not select the hosted client");

    const jsonArgs = {
      task: "Return a boundary marker.",
      inputText: "local",
      schema: {
        type: "object",
        properties: { boundary: { type: "string" } },
        required: ["boundary"],
        additionalProperties: false,
      },
    };
    const jsonClientFactory = (jsonConfig) => {
      jsonCalls.push({ provider: jsonConfig.provider, model: jsonConfig.model, baseURL: jsonConfig.baseURL });
      return {
        chat: {
          completions: {
            create: async () => ({ choices: [{ message: { content: '{"boundary":"kept"}' } }] }),
          },
        },
      };
    };
    const localJson = await runJsonSpecialist(
      jsonArgs,
      {
        ...config,
        provider: "localllm",
        model: "localllm-fast",
        allowHostedJsonSpecialist: false,
        jsonClientFactory,
      },
      store
    );
    assert(localJson.ok && localJson.provider === "localllm", `JSON specialist did not stay local: ${localJson.error || localJson.provider}`);
    assert(jsonCalls.length === 1 && jsonCalls[0].provider === "localllm", "ambient credentials changed the default JSON-specialist provider");

    const blockedJson = await runJsonSpecialist(
      { ...jsonArgs, provider: "openai" },
      {
        ...config,
        provider: "localllm",
        model: "localllm-fast",
        allowHostedJsonSpecialist: false,
        jsonClientFactory,
      },
      store
    );
    assert(!blockedJson.ok && blockedJson.blocked, "Local JSON specialist did not reject an unapproved OpenAI override");
    assert(jsonCalls.length === 1, "Blocked JSON-specialist override still created a hosted client");

    const hostedJson = await runJsonSpecialist(
      { ...jsonArgs, provider: "openai" },
      {
        ...config,
        provider: "localllm",
        model: "localllm-fast",
        allowHostedJsonSpecialist: true,
        jsonClientFactory,
      },
      store
    );
    assert(hostedJson.ok && hostedJson.provider === "openai", `Explicit OpenAI JSON specialist failed: ${hostedJson.error || "unknown"}`);
    assert(jsonCalls.length === 2 && jsonCalls[1].provider === "openai", "Explicit hosted JSON-specialist permission did not select OpenAI");
    assert(!/^localllm-/i.test(jsonCalls[1].model || ""), "Hosted JSON-specialist override reused the LocalLLM model name");
  } finally {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalLlmKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalLlmKey;
  }
}

async function main() {
  const pngPath = path.join(workspace, "artifacts", "screenshots", "tiny.png");
  await fs.writeFile(
    pngPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );

  const store = new SessionStore(path.join(runtimeDir, "sessions"), "perception-research-smoke");
  await store.ensure();
  const config = {
    commandCwd: workspace,
    provider: "localllm",
    apiKey: "local-dev-key",
    baseURL: "http://127.0.0.1:8008/v1",
    allowFileTools: true,
    allowWebSearch: true,
    allowWrapperTools: true,
    preferredWrapper: "codex",
    webSearchDryRun: true,
  };

  const repairedImageJson = firstJsonObject(
    '{"summary":"A simple red square is visible.","visibleText":[],"observations":["The shape is a square."],"issues":[],"answer":"A red square.","uncertainty":[],\r\n}'
  );
  assert(repairedImageJson?.answer === "A red square.", "read_image did not repair a common trailing-comma near-JSON response");

  const fencedWrapperJson = firstJsonObject('```json\n{"ok":true,"task":"read_image","summary":"done",}\n```');
  assert(fencedWrapperJson?.summary === "done", "research_wrapper did not repair fenced trailing-comma near-JSON");

  const image = await readImage(
    {
      path: "artifacts/screenshots/tiny.png",
      prompt: "Describe this tiny image.",
      dryRun: true,
    },
    config,
    store
  );
  assert(image.ok, `read_image dry-run failed: ${image.error || "unknown"}`);
  assert(image.images?.[0]?.sha256, "read_image did not record image hash");
  assert(image.artifactPath, "read_image did not persist a perception artifact");
  assert(image.markdownArtifactPath, "read_image did not persist a Markdown perception artifact");
  assert(image.markdownPath, "read_image did not persist a workspace Markdown report");
  assert(
    image.markdownPath.startsWith(".aginti/artifacts/perception/"),
    `read_image dirtied the task-owned artifact tree: ${image.markdownPath}`
  );
  assert(
    path.basename(image.markdownPath).includes("tiny-image-analysis"),
    `read_image emitted a generic artifact filename: ${image.markdownPath}`
  );
  await fs.access(image.artifactPath);
  await fs.access(image.markdownArtifactPath);
  await fs.access(path.join(workspace, image.markdownPath));

  await verifyProviderBoundary({ pngPath, store, config });

  const codexFallback = await readImage(
    {
      path: "artifacts/screenshots/tiny.png",
      prompt: "Describe this tiny image with the Codex image fallback.",
      provider: "codex",
      codexDryRun: true,
    },
    {
      ...config,
      allowWrapperTools: true,
    },
    store
  );
  assert(codexFallback.ok, `read_image Codex fallback dry-run failed: ${codexFallback.error || "unknown"}`);
  assert(codexFallback.provider === "codex-wrapper-dry-run", "read_image did not select the Codex wrapper fallback path");
  assert(codexFallback.markdownPath, "read_image Codex fallback did not write a Markdown report");

  const secretBlock = checkToolUse({
    toolName: "read_image",
    args: { path: ".env" },
    snapshot: { elements: [] },
    config,
  });
  assert(!secretBlock.allowed, "read_image did not block a sensitive path");

  const research = await webResearch(
    {
      query: "AgInTiFlow smoke current docs",
      maxResults: 2,
    },
    config,
    store
  );
  assert(research.ok, `web_research dry-run failed: ${research.error || "unknown"}`);
  assert(research.sources?.length === 1, "web_research did not return dry-run sources");
  assert(research.artifactPath, "web_research did not persist a research artifact");
  await fs.access(research.artifactPath);

  const wrapper = await researchWrapper(
    {
      task: "web_research",
      query: "AgInTiFlow wrapper smoke",
      dryRun: true,
    },
    config,
    store
  );
  assert(wrapper.ok, `research_wrapper dry-run failed: ${wrapper.error || "unknown"}`);
  assert(wrapper.model === "gpt-5.4-mini", "research_wrapper did not default to gpt-5.4-mini");
  assert(wrapper.reasoning === "medium", "research_wrapper did not default to medium reasoning");
  assert(wrapper.artifactPath, "research_wrapper did not persist an artifact");

  const localDefaults = resolveRuntimeConfig(
    { provider: "localllm", routingMode: "manual", goal: "Boundary defaults", commandCwd: workspace },
    { baseDir: runtimeDir, packageDir: repoRoot, provider: "localllm" }
  );
  assert(localDefaults.allowAuxiliaryTools === false, "LocalLLM image generation did not default off");
  assert(localDefaults.allowHostedImagePerception === false, "LocalLLM hosted image perception did not default off");
  assert(localDefaults.allowHostedWebResearch === false, "LocalLLM hosted web research did not default off");
  assert(localDefaults.allowHostedJsonSpecialist === false, "LocalLLM hosted JSON specialist did not default off");
  assert(localDefaults.allowHostedWritingSpecialist === false, "LocalLLM hosted writing specialist did not default off");

  const openAiDefaults = resolveRuntimeConfig(
    { provider: "openai", routingMode: "manual", model: "gpt-test", goal: "Boundary defaults", commandCwd: workspace },
    { baseDir: runtimeDir, packageDir: repoRoot, provider: "openai", apiKey: "test-openai-key" }
  );
  assert(openAiDefaults.allowHostedImagePerception === true, "Explicit OpenAI provider did not enable its image-perception backend");
  assert(openAiDefaults.allowHostedWebResearch === true, "Explicit OpenAI provider did not enable its hosted web-research backend");
  assert(openAiDefaults.allowHostedJsonSpecialist === false, "OpenAI provider unexpectedly enabled cross-provider JSON overrides");
  assert(openAiDefaults.allowHostedWritingSpecialist === false, "OpenAI provider unexpectedly enabled cross-provider writer overrides");

  const agentConfig = resolveRuntimeConfig(
    {
      provider: "mock",
      routingMode: "manual",
      model: "mock-agent",
      goal: "Read image artifacts/screenshots/tiny.png and tell me what it shows.",
      commandCwd: workspace,
      allowFileTools: true,
      allowShellTool: false,
      maxSteps: 4,
    },
    {
      baseDir: runtimeDir,
      packageDir: repoRoot,
      provider: "mock",
    }
  );
  const run = await runAgent(agentConfig);
  const runStore = new SessionStore(agentConfig.sessionsDir, run.sessionId);
  const events = await runStore.loadEvents();
  assert(events.some((event) => event.type === "tool.completed" && event.data?.toolName === "read_image"), "mock agent did not call read_image");
  assert(events.some((event) => event.type === "canvas.item" && event.data?.toolName === "read_image"), "read_image did not send the Markdown report to canvas");

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log("smoke-perception-research ok");
}

main().catch(async (error) => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  console.error(error);
  process.exit(1);
});
