#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveRuntimeConfig } from "../src/config.js";
import { isLocalLLMBaseURL } from "../src/provider-contract.js";
import {
  LOCALLLM_AUTO_MAX_MIN_COMPLEXITY,
  LOCALLLM_MODEL_TIERS,
  PROVIDER_MODEL_CATALOG,
  getModelPresets,
  hasLocalLLMVisionIntent,
  localLLMModelTier,
  selectLocalLLMModelTier,
  selectModelRoute,
} from "../src/model-routing.js";

const ENV_KEYS = [
  "AGENT_PROVIDER",
  "AGINTI_ROUTE_PROVIDER",
  "AGINTI_ROUTE_MODEL",
  "AGINTI_MAIN_PROVIDER",
  "AGINTI_MAIN_MODEL",
  "AGINTI_LOCALLLM_MODEL",
  "AGINTI_LOCALLLM_ROUTE_MODEL",
  "AGINTI_LOCALLLM_MAIN_MODEL",
  "AGINTI_LOCALLLM_MAX_MODEL",
  "AGINTI_LOCALLLM_VISION_MODEL",
  "LOCALLLM_MODEL",
  "LOCAL_LLM_MODEL",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_API_KEY",
  "VENICE_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
];

const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let networkCalls = 0;

try {
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("LocalLLM tier selection must stay pure and offline");
  };

  assert.equal(LOCALLLM_MODEL_TIERS.fast.model, "localllm-fast");
  assert.equal(LOCALLLM_MODEL_TIERS.deep.model, "localllm-deep");
  assert.equal(LOCALLLM_MODEL_TIERS.max.model, "localllm-max");
  assert.equal(LOCALLLM_MODEL_TIERS.vision.model, "localllm-vision-xl");
  assert.equal(localLLMModelTier("localllm-max")?.target, "Qwen3 30B-A3B Instruct Q8_0");
  assert.deepEqual(
    PROVIDER_MODEL_CATALOG.localllm.map((item) => item.id),
    ["localllm-fast", "localllm-deep", "localllm-max", "localllm-vision-xl"],
    "LocalLLM model catalog should expose all four stable aliases"
  );

  const simple = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    goal: "Say hello.",
  });
  assert.equal(simple.model, "localllm-fast", "simple local chat should use the fast route");
  assert.equal(simple.localTier, "fast");

  const substantiveCode = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    goal: "Implement the parser, update its tests, and fix the regression in this repository.",
    taskProfile: "code",
  });
  assert.ok(substantiveCode.complexityScore >= 3, "code fixture must remain substantive");
  assert.equal(substantiveCode.model, "localllm-deep", "substantive coding must never downgrade to localllm-fast");
  assert.equal(substantiveCode.localTier, "deep");

  const complexGoal = "Architect and repair a complex multi-file compiler regression, update the database and CI, review security, then run every test.";
  process.env.AGENT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "offline-ambient-openai-key";
  const explicitLocalAgainstAmbientHosted = resolveRuntimeConfig(
    { provider: "localllm", goal: complexGoal },
    { baseDir: process.cwd(), provider: "localllm", routingMode: "smart", enableScs: "auto" }
  );
  assert.equal(explicitLocalAgainstAmbientHosted.scsActive, true, "ambient-provider fixture must exercise SCS");
  assert.equal(explicitLocalAgainstAmbientHosted.requestedProvider, "localllm");
  assert.equal(explicitLocalAgainstAmbientHosted.routeProvider, "localllm");
  assert.equal(explicitLocalAgainstAmbientHosted.mainProvider, "localllm");
  assert.equal(explicitLocalAgainstAmbientHosted.spareProvider, "localllm");
  assert.equal(explicitLocalAgainstAmbientHosted.provider, "localllm", "ambient AGENT_PROVIDER escaped the explicit local boundary");
  assert.equal(explicitLocalAgainstAmbientHosted.model, "localllm-deep");
  assert.equal(isLocalLLMBaseURL(explicitLocalAgainstAmbientHosted.baseURL), true, "explicit local provider resolved a hosted base URL");
  assert.equal(explicitLocalAgainstAmbientHosted.allowWrapperTools, false, "ambient hosted provider enabled wrappers in a local run");

  const explicitRoleProviders = resolveRuntimeConfig(
    { provider: "localllm", goal: complexGoal },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      routingMode: "smart",
      enableScs: "auto",
      routeProvider: "deepseek",
      routeModel: "deepseek-v4-flash",
      mainProvider: "openai",
      mainModel: "gpt-5.4-mini",
      spareProvider: "qwen",
      spareModel: "qwen-plus",
    }
  );
  assert.equal(explicitRoleProviders.routeProvider, "deepseek", "explicit route provider was not preserved");
  assert.equal(explicitRoleProviders.mainProvider, "openai", "explicit main provider was not preserved");
  assert.equal(explicitRoleProviders.spareProvider, "qwen", "explicit spare provider was not preserved");
  assert.equal(explicitRoleProviders.provider, "openai", "SCS did not honor the explicit main provider");
  delete process.env.AGENT_PROVIDER;
  delete process.env.OPENAI_API_KEY;

  const omittedModelComplex = resolveRuntimeConfig(
    { goal: complexGoal },
    { baseDir: process.cwd(), provider: "localllm", routingMode: "smart", enableScs: "off" }
  );
  assert.equal(omittedModelComplex.model, "localllm-deep", "a fresh smart run with no model must still route by complexity");
  assert.equal(omittedModelComplex.localSelection, "complexity");

  const unlockedDefaultFast = resolveRuntimeConfig(
    { goal: complexGoal },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      enableScs: "off",
    }
  );
  assert.equal(
    unlockedDefaultFast.model,
    "localllm-deep",
    "a normal smart run must not mistake a UI/default Fast value for durable session provenance"
  );

  const lockedDeepOnSimple = resolveRuntimeConfig(
    { goal: "Inspect README.md and summarize it." },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      model: "localllm-deep",
      routingMode: "smart",
      sessionModelLocked: true,
      enableScs: "auto",
    }
  );
  assert.equal(lockedDeepOnSimple.model, "localllm-deep", "a saved Deep session drifted to Fast on a simple continuation");
  assert.equal(lockedDeepOnSimple.routingMode, "smart", "the durable route should retain smart policy metadata");
  assert.equal(lockedDeepOnSimple.localTier, "deep");
  assert.equal(lockedDeepOnSimple.localSelection, "session-snapshot");

  const lockedFastOnComplex = resolveRuntimeConfig(
    { goal: complexGoal },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      model: "localllm-fast",
      routingMode: "smart",
      sessionModelLocked: true,
      enableScs: "auto",
    }
  );
  assert.equal(lockedFastOnComplex.scsActive, true, "complex saved-Fast fixture must exercise SCS activation");
  assert.equal(lockedFastOnComplex.model, "localllm-fast", "SCS replaced a saved Fast session with the main Deep role");
  assert.equal(lockedFastOnComplex.localTier, "fast");
  assert.equal(lockedFastOnComplex.localSelection, "session-snapshot");
  assert.equal(lockedFastOnComplex.scsModelPolicy, "selected");

  const lockedMaxOnSimple = resolveRuntimeConfig(
    { goal: "Inspect README.md and summarize it." },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      model: "localllm-max",
      routingMode: "smart",
      sessionModelLocked: true,
      enableScs: "off",
    }
  );
  assert.equal(lockedMaxOnSimple.model, "localllm-max");
  assert.equal(lockedMaxOnSimple.localTier, "max");
  assert.equal(lockedMaxOnSimple.requiresResourcePreflight, true, "a saved Max session bypassed the strict resource gate");

  const highComplexity = LOCALLLM_AUTO_MAX_MIN_COMPLEXITY + 3;
  const defaultHighCapacity = selectLocalLLMModelTier({ complexityScore: highComplexity });
  assert.equal(defaultHighCapacity.model, "localllm-deep", "Max must never auto-select without explicit policy signals");
  assert.equal(defaultHighCapacity.blockedUpgrade, "max-auto-policy-not-satisfied");

  const pressured = selectLocalLLMModelTier({
    complexityScore: highComplexity,
    localCapabilities: { maxModelAvailable: true },
    localResourcePolicy: {
      allowMaxAuto: true,
      status: "ready",
      sharedWorkstationPressure: true,
    },
  });
  assert.equal(pressured.model, "localllm-deep", "shared-workstation pressure must block automatic Max routing");

  const missingPressureSnapshot = selectLocalLLMModelTier({
    complexityScore: highComplexity,
    localCapabilities: { maxModelAvailable: true },
    localResourcePolicy: { allowMaxAuto: true, status: "ready" },
  });
  assert.equal(missingPressureSnapshot.model, "localllm-deep", "unknown pressure must fail closed to Deep");

  const optedInMax = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    goal: "Architect and repair a complex multi-file compiler regression with tests.",
    taskProfile: "large-codebase",
    localCapabilities: { maxModelAvailable: true },
    localResourcePolicy: {
      allowMaxAuto: true,
      status: "ready",
      sharedWorkstationPressure: false,
    },
  });
  assert.ok(optedInMax.complexityScore >= LOCALLLM_AUTO_MAX_MIN_COMPLEXITY);
  assert.equal(optedInMax.model, "localllm-max", "confirmed opt-in and headroom should permit automatic Max routing");
  assert.equal(optedInMax.localTier, "max");
  assert.equal(optedInMax.requiresResourcePreflight, true);

  const resolvedAutoMax = resolveRuntimeConfig(
    {
      goal: "Architect and repair a complex multi-file compiler regression with tests.",
      taskProfile: "large-codebase",
    },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      routingMode: "smart",
      localCapabilities: { maxModelAvailable: true },
      localResourcePolicy: {
        allowMaxAuto: true,
        status: "ready",
        sharedWorkstationPressure: false,
      },
    }
  );
  assert.equal(resolvedAutoMax.scsActive, true, "complex Max fixture should exercise SCS activation");
  assert.equal(resolvedAutoMax.model, "localllm-max", "SCS must not replace a resource-approved Max selection with Deep");
  assert.equal(resolvedAutoMax.scsModelPolicy, "selected");

  const explicitMax = selectModelRoute({
    provider: "localllm",
    model: "localllm-max",
    routingMode: "manual",
    goal: "Review this module.",
  });
  assert.equal(explicitMax.model, "localllm-max", "Max should remain directly selectable");
  assert.equal(explicitMax.localSelection, "explicit");

  const smartExplicitMax = selectModelRoute({
    provider: "localllm",
    model: "localllm-max",
    routingMode: "smart",
    goal: "Review this module.",
  });
  assert.equal(smartExplicitMax.model, "localllm-max", "an explicit Max model must not be replaced by smart routing");
  assert.equal(smartExplicitMax.routingMode, "manual");

  const resolvedExplicitMax = resolveRuntimeConfig(
    {
      goal: "Architect and repair a complex multi-file compiler regression with tests.",
      taskProfile: "large-codebase",
    },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      model: "localllm-max",
      routingMode: "smart",
    }
  );
  assert.equal(resolvedExplicitMax.scsActive, true);
  assert.equal(resolvedExplicitMax.model, "localllm-max", "SCS must preserve an explicitly selected Max model");

  const explicitMainMax = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    mainModel: "localllm-max",
    goal: "Implement and validate a multi-file compiler refactor.",
    taskProfile: "large-codebase",
  });
  assert.equal(explicitMainMax.model, "localllm-max", "an explicit main-role Max alias should remain selectable");
  assert.equal(explicitMainMax.localTier, "max");
  assert.equal(explicitMainMax.localSelection, "configured-model");
  assert.equal(explicitMainMax.requiresResourcePreflight, true);

  const visionGoal = "Inspect the attached screenshot and identify the rendering defect.";
  assert.equal(hasLocalLLMVisionIntent(visionGoal), true);
  const noImageSignal = selectLocalLLMModelTier({
    goal: visionGoal,
    localCapabilities: { visionModelAvailable: true },
  });
  assert.notEqual(noImageSignal.model, "localllm-vision-xl", "vision intent alone must not activate the vision model");
  assert.equal(noImageSignal.blockedUpgrade, "vision-capability-signal-required");

  const noVisionModel = selectLocalLLMModelTier({
    goal: visionGoal,
    localCapabilities: { imageInput: true },
  });
  assert.notEqual(noVisionModel.model, "localllm-vision-xl", "image input without model availability must stay text-only");

  const visionReady = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    goal: visionGoal,
    localCapabilities: { imageInput: true, visionModelAvailable: true },
  });
  assert.equal(visionReady.model, "localllm-vision-xl", "vision requires both intent and an image capability signal");
  assert.equal(visionReady.localSelection, "vision-capability");

  const generationOnly = selectLocalLLMModelTier({
    goal: "Generate an image of a red panda.",
    localCapabilities: { imageInput: true, visionModelAvailable: true },
  });
  assert.notEqual(generationOnly.model, "localllm-vision-xl", "image generation text must not be mistaken for image understanding");

  process.env.DEEPSEEK_API_KEY = "ambient-deepseek-key-not-real";
  process.env.OPENAI_API_KEY = "ambient-openai-key-not-real";
  process.env.OPENROUTER_API_KEY = "ambient-openrouter-key-not-real";
  process.env.LLM_BASE_URL = "https://hosted.example.invalid/v1";
  process.env.LLM_MODEL = "hosted-model-must-not-route";
  const cloudAmbientRoute = selectModelRoute({
    provider: "localllm",
    routingMode: "smart",
    goal: "Implement a cross-file repository refactor and its tests.",
    taskProfile: "code",
  });
  assert.equal(cloudAmbientRoute.provider, "localllm", "ambient hosted keys must not change the local provider");
  assert.equal(cloudAmbientRoute.model, "localllm-deep", "ambient hosted model settings must not change the local tier");

  process.env.AGINTI_LOCALLLM_MODEL = "local-shared-explicit";
  let presets = getModelPresets({ routeProvider: "localllm", mainProvider: "localllm" });
  assert.equal(presets.fast.model, "local-shared-explicit", "AGINTI_LOCALLLM_MODEL should apply to the route role");
  assert.equal(presets.complex.model, "local-shared-explicit", "AGINTI_LOCALLLM_MODEL should apply to the main role");

  process.env.AGINTI_LOCALLLM_ROUTE_MODEL = "local-role-fast";
  process.env.AGINTI_LOCALLLM_MAIN_MODEL = "local-role-deep";
  presets = getModelPresets({ routeProvider: "localllm", mainProvider: "localllm" });
  assert.equal(presets.fast.model, "local-role-fast", "role-specific route override should win over the shared override");
  assert.equal(presets.complex.model, "local-role-deep", "role-specific main override should win over the shared override");

  delete process.env.AGINTI_LOCALLLM_MODEL;
  delete process.env.AGINTI_LOCALLLM_ROUTE_MODEL;
  delete process.env.AGINTI_LOCALLLM_MAIN_MODEL;
  process.env.LOCALLLM_MODEL = "local-standard-explicit";
  presets = getModelPresets({ routeProvider: "localllm", mainProvider: "localllm" });
  assert.equal(presets.fast.model, "local-standard-explicit", "LOCALLLM_MODEL should apply to the route role");
  assert.equal(presets.complex.model, "local-standard-explicit", "LOCALLLM_MODEL should apply to the main role");

  assert.equal(networkCalls, 0, "pure tier selection attempted a network/model call");
  console.log("LocalLLM model tier smoke test passed (offline; no model or network calls).\n");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
