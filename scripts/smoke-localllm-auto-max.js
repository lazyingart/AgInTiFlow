#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  LOCALLLM_AUTO_MAX_OUTCOMES,
  applyLocalAutoMaxUpgrade,
  isLocalAutoMaxCandidate,
  resolveLocalAutoMaxUpgrade,
} from "../src/local-auto-max.js";
import { LOCALLLM_AUTO_MAX_MIN_COMPLEXITY } from "../src/model-routing.js";

const ENV_KEYS = [
  "AGINTIFLOW_HOME",
  "AGENT_PROVIDER",
  "AGINTI_LOCALLLM_ALLOW_AUTO_MAX",
  "AGINTI_LOCALLLM_MAX_MODEL",
  "AGINTI_ROUTE_PROVIDER",
  "AGINTI_ROUTE_MODEL",
  "AGINTI_MAIN_PROVIDER",
  "AGINTI_MAIN_MODEL",
  "LLM_MODEL",
];
const envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const TEST_BEARER_TOKEN = "smoke-auto-max-local-bearer";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const complexGoal = [
  "Architect and implement a complex multi-file repository migration.",
  "Debug the root cause, repair the regression, update the database and CI configuration,",
  "review security and performance, then run the complete test suite.",
].join(" ");

function readiness(models = ["localllm-fast", "localllm-deep", "localllm-max"]) {
  return {
    ok: true,
    checks: {
      authentication: { ok: true, scheme: "bearer" },
      models: { ok: true, available: models },
    },
  };
}

function readyResources() {
  return {
    ready: true,
    status: "ready",
    sharedWorkstationPressure: false,
    reasons: [],
    metrics: { availableRamBytes: 32 * 1024 ** 3, swapPressureRatio: 0.5, aggregateGpuFreeMiB: 48_000 },
  };
}

function pressuredResources() {
  return {
    ...readyResources(),
    ready: false,
    status: "pressured",
    sharedWorkstationPressure: true,
    reasons: ["swap-use-above-75-percent"],
  };
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function withLocalFixture(callback) {
  const observations = { modelRequests: 0, authenticatedModelRequests: 0 };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        service: "localllm-api",
        ollama: { ok: true, version: "auto-max-smoke" },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      observations.modelRequests += 1;
      if (request.headers.authorization === `Bearer ${TEST_BEARER_TOKEN}`) {
        observations.authenticatedModelRequests += 1;
      }
      writeJson(response, 200, {
        object: "list",
        data: [
          { id: "localllm-fast" },
          { id: "localllm-deep" },
          { id: "localllm-max" },
        ],
      });
      return;
    }
    writeJson(response, 404, { ok: false });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await callback({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      observations,
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

async function createIntegrationConfig({
  root,
  id,
  baseURL,
  resourceProbe,
  resume = false,
} = {}) {
  const workspace = path.join(root, "workspaces", id);
  await fs.mkdir(workspace, { recursive: true });
  const observations = { factoryModels: [], requestModels: [] };
  const config = resolveRuntimeConfig(
    {
      goal: resume ? "Continue with the saved architecture explanation." : complexGoal,
      taskProfile: "large-codebase",
      maxSteps: 1,
      ...(resume ? { resume: id } : {}),
    },
    {
      baseDir: workspace,
      packageDir: packageRoot,
      provider: "localllm",
      routingMode: "smart",
      baseURL,
      apiKey: TEST_BEARER_TOKEN,
      allowLocalAutoMax: true,
      localResourceProbe: resourceProbe,
      commandCwd: workspace,
      sessionId: id,
      maxSteps: 1,
      dynamicSteps: "off",
      enableScs: "off",
      allowFileTools: false,
      allowShellTool: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      sandboxMode: "host",
      packageInstallPolicy: "block",
      providerReadinessTimeoutMs: 500,
    }
  );
  config.clientFactory = async (effectiveConfig) => {
    observations.factoryModels.push(effectiveConfig.model);
    return {
      chat: {
        completions: {
          create: async (request) => {
            observations.requestModels.push(request.model);
            return {
              choices: [{ message: { role: "assistant", content: "The architecture explanation is complete." } }],
            };
          },
        },
      },
    };
  };
  config.onConsole = () => {};
  config.onEvent = () => {};
  config.onLog = () => {};
  config.localResourceProbe = resourceProbe;
  if (resume) config.expectedRuntimeRevision = 1;
  return { config, observations };
}

try {
  for (const key of ENV_KEYS) delete process.env[key];

  const disabledConfig = resolveRuntimeConfig(
    { goal: complexGoal, taskProfile: "large-codebase" },
    { baseDir: process.cwd(), provider: "localllm", routingMode: "smart" }
  );
  assert.ok(disabledConfig.routeComplexityScore >= LOCALLLM_AUTO_MAX_MIN_COMPLEXITY);
  assert.equal(disabledConfig.model, "localllm-deep");
  assert.equal(disabledConfig.allowLocalAutoMax, false, "automatic Max must default off");
  assert.equal(isLocalAutoMaxCandidate(disabledConfig), false);

  process.env.AGINTI_LOCALLLM_ALLOW_AUTO_MAX = "true";
  const optedInConfig = resolveRuntimeConfig(
    { goal: complexGoal, taskProfile: "large-codebase" },
    { baseDir: process.cwd(), provider: "localllm", routingMode: "smart" }
  );
  assert.equal(optedInConfig.model, "localllm-deep", "phase one must remain on Deep before authenticated discovery");
  assert.equal(optedInConfig.allowLocalAutoMax, true);
  assert.equal(optedInConfig.localMaxModel, "localllm-max");
  assert.equal(isLocalAutoMaxCandidate(optedInConfig), true);

  let resourceChecks = 0;
  const unavailable = await resolveLocalAutoMaxUpgrade(optedInConfig, readiness(["localllm-fast", "localllm-deep"]), {
    resourceProbe: async () => {
      resourceChecks += 1;
      return readyResources();
    },
  });
  assert.equal(unavailable.outcome, LOCALLLM_AUTO_MAX_OUTCOMES.MODEL_UNAVAILABLE);
  assert.equal(resourceChecks, 0, "resource probing must follow authenticated Max alias discovery");

  const pressured = await resolveLocalAutoMaxUpgrade(optedInConfig, readiness(), {
    resourceProbe: async () => {
      resourceChecks += 1;
      return {
        ...readyResources(),
        ready: false,
        status: "pressured",
        sharedWorkstationPressure: true,
        reasons: ["swap-use-above-75-percent"],
      };
    },
  });
  assert.equal(pressured.outcome, LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_PRESSURE);
  assert.equal(applyLocalAutoMaxUpgrade(optedInConfig, pressured).model, "localllm-deep");

  const unknown = await resolveLocalAutoMaxUpgrade(optedInConfig, readiness(), {
    resourceProbe: async () => {
      resourceChecks += 1;
      throw new Error("offline telemetry fixture unavailable");
    },
  });
  assert.equal(unknown.outcome, LOCALLLM_AUTO_MAX_OUTCOMES.RESOURCE_UNKNOWN);
  assert.equal(applyLocalAutoMaxUpgrade(optedInConfig, unknown).model, "localllm-deep");

  const selected = await resolveLocalAutoMaxUpgrade(optedInConfig, readiness(), {
    resourceProbe: async () => {
      resourceChecks += 1;
      return readyResources();
    },
  });
  assert.equal(selected.outcome, LOCALLLM_AUTO_MAX_OUTCOMES.SELECTED);
  const upgraded = applyLocalAutoMaxUpgrade(optedInConfig, selected);
  assert.equal(upgraded.model, "localllm-max");
  assert.equal(upgraded.localTier, "max");
  assert.equal(upgraded.localSelection, "runtime-auto-max");
  assert.equal(upgraded.requiresResourcePreflight, true);
  assert.equal(upgraded.scsModelPolicy, "selected");
  assert.equal(resourceChecks, 3, "every eligible available decision must use one fresh resource sample");

  const explicitMax = resolveRuntimeConfig(
    { goal: complexGoal, taskProfile: "large-codebase", model: "localllm-max" },
    {
      baseDir: process.cwd(),
      provider: "localllm",
      routingMode: "smart",
      model: "localllm-max",
      allowLocalAutoMax: true,
    }
  );
  assert.equal(isLocalAutoMaxCandidate(explicitMax), false, "explicit Max must use the strict explicit resource gate");

  const simpleConfig = resolveRuntimeConfig(
    { goal: "Say hello." },
    { baseDir: process.cwd(), provider: "localllm", routingMode: "smart", allowLocalAutoMax: true }
  );
  let simpleResourceChecks = 0;
  const simpleDecision = await resolveLocalAutoMaxUpgrade(simpleConfig, readiness(), {
    resourceProbe: async () => {
      simpleResourceChecks += 1;
      return readyResources();
    },
  });
  assert.equal(simpleDecision.outcome, LOCALLLM_AUTO_MAX_OUTCOMES.INELIGIBLE);
  assert.equal(simpleResourceChecks, 0, "low-complexity work must never probe Max resources");

  const integrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-auto-max-"));
  process.env.AGINTIFLOW_HOME = path.join(integrationRoot, "home");
  try {
    await withLocalFixture(async ({ baseURL, observations: fixtureObservations }) => {
      let selectedResourceChecks = 0;
      const selectedProbe = async () => {
        selectedResourceChecks += 1;
        return readyResources();
      };
      const selectedRun = await createIntegrationConfig({
        root: integrationRoot,
        id: "auto-max-selected",
        baseURL,
        resourceProbe: selectedProbe,
      });
      await runAgent(selectedRun.config);
      assert.deepEqual(selectedRun.observations.factoryModels, ["localllm-max"]);
      assert.ok(selectedRun.observations.requestModels.length > 0);
      assert.ok(selectedRun.observations.requestModels.every((model) => model === "localllm-max"));
      assert.equal(selectedResourceChecks, 1, "selected automatic Max must take exactly one fresh resource sample");

      const selectedStatePath = path.join(selectedRun.config.sessionsDir, "auto-max-selected", "state.json");
      let selectedState = JSON.parse(await fs.readFile(selectedStatePath, "utf8"));
      assert.equal(selectedState.model, "localllm-max");
      assert.equal(selectedState.meta.runtimeConfig.model, "localllm-max", "initial durable runtime must record actual Max");
      assert.deepEqual(
        Object.keys(selectedState.meta.localAutoMaxPolicy).sort(),
        ["candidateModel", "complexityScore", "eligible", "optedIn", "schemaVersion"],
        "durable auto-Max policy must not contain resource readiness or telemetry"
      );

      const selectedResume = await createIntegrationConfig({
        root: integrationRoot,
        id: "auto-max-selected",
        baseURL,
        resourceProbe: selectedProbe,
        resume: true,
      });
      await runAgent(selectedResume.config);
      assert.equal(selectedResourceChecks, 2, "a resumed persisted Max run must take a new strict resource sample");
      assert.deepEqual(selectedResume.observations.factoryModels, ["localllm-max"]);
      assert.ok(selectedResume.observations.requestModels.length > 0);
      assert.ok(selectedResume.observations.requestModels.every((model) => model === "localllm-max"));

      let pressureThenReady = true;
      let fallbackResourceChecks = 0;
      const changingProbe = async () => {
        fallbackResourceChecks += 1;
        if (pressureThenReady) return pressuredResources();
        return readyResources();
      };
      const pressuredRun = await createIntegrationConfig({
        root: integrationRoot,
        id: "auto-max-pressure-fallback",
        baseURL,
        resourceProbe: changingProbe,
      });
      await runAgent(pressuredRun.config);
      assert.deepEqual(pressuredRun.observations.factoryModels, ["localllm-deep"]);
      assert.ok(pressuredRun.observations.requestModels.length > 0);
      assert.ok(pressuredRun.observations.requestModels.every((model) => model === "localllm-deep"));
      let pressuredState = JSON.parse(
        await fs.readFile(path.join(pressuredRun.config.sessionsDir, "auto-max-pressure-fallback", "state.json"), "utf8")
      );
      assert.equal(pressuredState.meta.runtimeConfig.model, "localllm-deep");
      assert.equal(pressuredState.meta.localAutoMaxPolicy.eligible, true);

      pressureThenReady = false;
      const fallbackResume = await createIntegrationConfig({
        root: integrationRoot,
        id: "auto-max-pressure-fallback",
        baseURL,
        resourceProbe: changingProbe,
        resume: true,
      });
      await runAgent(fallbackResume.config);
      assert.equal(fallbackResourceChecks, 2, "pressured Deep resume must re-evaluate resources once");
      assert.deepEqual(fallbackResume.observations.factoryModels, ["localllm-max"]);
      assert.ok(fallbackResume.observations.requestModels.length > 0);
      assert.ok(fallbackResume.observations.requestModels.every((model) => model === "localllm-max"));
      pressuredState = JSON.parse(
        await fs.readFile(path.join(pressuredRun.config.sessionsDir, "auto-max-pressure-fallback", "state.json"), "utf8")
      );
      assert.equal(pressuredState.meta.runtimeConfig.model, "localllm-max");

      const eventLines = await fs.readFile(
        path.join(pressuredRun.config.sessionsDir, "auto-max-pressure-fallback", "events.jsonl"),
        "utf8"
      );
      const autoEvents = eventLines
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "provider.local_auto_max");
      assert.deepEqual(autoEvents.map((event) => event.data.outcome), ["resource-pressure", "selected"]);
      assert.ok(
        autoEvents.every((event) => !Object.prototype.hasOwnProperty.call(event.data, "metrics")),
        "auto-Max audit events must stay bounded"
      );
      assert.equal(fixtureObservations.modelRequests, 4);
      assert.equal(fixtureObservations.authenticatedModelRequests, 4);
    });
  } finally {
    await fs.rm(integrationRoot, { recursive: true, force: true });
  }
} finally {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("LocalLLM automatic Max two-phase policy smoke passed (offline; no model loads).\n");
