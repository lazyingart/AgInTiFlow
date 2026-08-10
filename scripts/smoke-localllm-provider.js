#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightProviderRuntime, runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { ProviderConfigurationError } from "../src/provider-contract.js";
import {
  ProviderReadinessError,
  deriveLocalLLMReadinessEndpoints,
  probeProviderRuntime,
} from "../src/provider-runtime.js";

const TEST_BEARER_TOKEN = "smoke-local-bearer-do-not-log";
const ROUTE_MODEL = "localllm-fast";
const MAIN_MODEL = "localllm-deep";
const MAX_MODEL = "localllm-max";

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function withFixture(scenario, callback) {
  const observations = {
    sawExpectedBearer: false,
    modelRequests: 0,
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      if (scenario.healthRedirectURL) {
        response.writeHead(302, { location: scenario.healthRedirectURL });
        response.end();
        return;
      }
      if (scenario.health === "hang") return;
      if (scenario.health === "malformed-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{not-json");
        return;
      }
      writeJson(response, scenario.healthStatus || 200, scenario.health || {
        ok: true,
        service: "localllm-api",
        ollama: { ok: true, version: "smoke-runtime" },
      });
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
      observations.modelRequests += 1;
      observations.sawExpectedBearer = request.headers.authorization === `Bearer ${TEST_BEARER_TOKEN}`;
      if (scenario.modelsRedirectURL) {
        response.writeHead(302, { location: scenario.modelsRedirectURL });
        response.end();
        return;
      }
      if (scenario.modelsStatus) {
        writeJson(response, scenario.modelsStatus, { error: { message: "fixture rejection" } });
        return;
      }
      if (scenario.models === "malformed-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not-json");
        return;
      }
      writeJson(response, 200, scenario.models || {
        object: "list",
        data: [{ id: ROUTE_MODEL }, { id: MAIN_MODEL }],
      });
      return;
    }

    writeJson(response, 404, { ok: false });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "fixture server did not expose an address");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  try {
    await callback({ baseURL, observations });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

async function withRedirectTarget(callback) {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    writeJson(response, 200, { ok: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "redirect target fixture did not expose an address");
  try {
    await callback({ origin: `http://127.0.0.1:${address.port}`, hits: () => hits });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

function assertReadinessError(expectedCode) {
  return (error) => {
    assert.ok(error instanceof ProviderReadinessError, "probe should reject with ProviderReadinessError");
    assert.equal(error.code, expectedCode);
    assert.ok(error.action, "readiness error should provide an actionable recovery message");
    assert.ok(!JSON.stringify(error).includes(TEST_BEARER_TOKEN), "readiness error leaked the bearer token");
    return true;
  };
}

await withFixture({}, async ({ baseURL, observations }) => {
  const endpoints = deriveLocalLLMReadinessEndpoints(baseURL);
  assert.equal(endpoints.healthURL, baseURL.replace(/\/v1$/, "/healthz"));
  assert.equal(endpoints.modelsURL, `${baseURL}/models`);

  const snapshot = await probeProviderRuntime({
    provider: "local",
    baseURL,
    apiKey: TEST_BEARER_TOKEN,
    routeModel: ROUTE_MODEL,
    mainModel: MAIN_MODEL,
    timeoutMs: 1000,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.provider, "localllm", "provider aliases should normalize to canonical localllm");
  assert.equal(snapshot.locality, "loopback");
  assert.equal(snapshot.checks.runtime.ok, true);
  assert.equal(snapshot.checks.models.count, 2);
  assert.deepEqual(snapshot.checks.models.requested, [
    { role: "route", model: ROUTE_MODEL },
    { role: "main", model: MAIN_MODEL },
  ]);
  assert.equal(observations.modelRequests, 1);
  assert.ok(observations.sawExpectedBearer, "model discovery did not receive the expected bearer authorization");
  assert.ok(!JSON.stringify(snapshot).includes(TEST_BEARER_TOKEN), "readiness snapshot leaked the bearer token");
});

await withFixture(
  { health: { ok: true, service: "localllm-api", ollama: { ok: false } } },
  async ({ baseURL, observations }) => {
    await assert.rejects(
      () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, routeModel: ROUTE_MODEL, mainModel: MAIN_MODEL }),
      assertReadinessError("RUNTIME_UNAVAILABLE")
    );
    assert.equal(observations.modelRequests, 0, "model discovery should not run while the runtime is down");
  }
);

await withFixture({ modelsStatus: 401 }, async ({ baseURL, observations }) => {
  await assert.rejects(
    () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, routeModel: ROUTE_MODEL, mainModel: MAIN_MODEL }),
    assertReadinessError("AUTHENTICATION_FAILED")
  );
  assert.ok(observations.sawExpectedBearer, "the authenticated models request was not observed");
});

await withFixture(
  { models: { object: "list", data: [{ id: ROUTE_MODEL }] } },
  async ({ baseURL }) => {
    await assert.rejects(
      () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, routeModel: ROUTE_MODEL, mainModel: MAIN_MODEL }),
      (error) => {
        assertReadinessError("MODEL_ALIAS_MISSING")(error);
        assert.deepEqual(error.details.missing, [{ role: "main", model: MAIN_MODEL }]);
        return true;
      }
    );
  }
);

await withFixture({ health: "hang" }, async ({ baseURL }) => {
  await assert.rejects(
    () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, timeoutMs: 30 }),
    assertReadinessError("PROBE_TIMEOUT")
  );
});

await withFixture({ health: "hang" }, async ({ baseURL }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("smoke cancellation")), 20);
  timer.unref?.();
  await assert.rejects(
    () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, timeoutMs: 1000, signal: controller.signal }),
    assertReadinessError("PROBE_ABORTED")
  );
  clearTimeout(timer);
});

await withFixture({ health: "malformed-json" }, async ({ baseURL }) => {
  await assert.rejects(
    () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN }),
    assertReadinessError("HEALTH_MALFORMED_RESPONSE")
  );
});

await withFixture({ models: { object: "list", data: [{ model: ROUTE_MODEL }] } }, async ({ baseURL }) => {
  await assert.rejects(
    () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, routeModel: ROUTE_MODEL }),
    assertReadinessError("MODELS_MALFORMED_RESPONSE")
  );
});

await withRedirectTarget(async (target) => {
  await withFixture({ healthRedirectURL: `${target.origin}/healthz` }, async ({ baseURL, observations }) => {
    await assert.rejects(
      () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, selectedModel: ROUTE_MODEL }),
      assertReadinessError("PROBE_REDIRECT_REFUSED")
    );
    assert.equal(target.hits(), 0, "health readiness followed a redirect target");
    assert.equal(observations.modelRequests, 0, "model discovery ran after a refused health redirect");
  });

  await withFixture({ modelsRedirectURL: `${target.origin}/v1/models` }, async ({ baseURL, observations }) => {
    await assert.rejects(
      () => probeProviderRuntime({ baseURL, apiKey: TEST_BEARER_TOKEN, selectedModel: ROUTE_MODEL }),
      assertReadinessError("PROBE_REDIRECT_REFUSED")
    );
    assert.equal(target.hits(), 0, "model readiness followed a redirect target");
    assert.equal(observations.modelRequests, 1, "model redirect fixture was not reached exactly once");
    assert.ok(observations.sawExpectedBearer, "model redirect source did not receive the expected bearer authorization");
  });
});

let hostedFetchAttempted = false;
await assert.rejects(
  () =>
    probeProviderRuntime({
      baseURL: "https://hosted.example/v1",
      apiKey: TEST_BEARER_TOKEN,
      fetchImpl: async () => {
        hostedFetchAttempted = true;
        throw new Error("hosted fetch must never run");
      },
    }),
  assertReadinessError("BASE_URL_NOT_LOOPBACK")
);
assert.equal(hostedFetchAttempted, false, "readiness probe attempted a hosted fallback");

function assertConfigurationError(error) {
  assert.ok(error instanceof ProviderConfigurationError, "invalid LocalLLM base URL should raise ProviderConfigurationError");
  assert.equal(error.code, "LOCALLLM_BASE_URL_INVALID");
  assert.ok(error.action, "provider configuration error should contain recovery guidance");
  assert.ok(!JSON.stringify(error).includes(TEST_BEARER_TOKEN), "provider configuration error leaked the bearer token");
  return true;
}

const integrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-localllm-preflight-"));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalAgintiflowHome = process.env.AGINTIFLOW_HOME;
const originalLocalLLMBaseURL = process.env.LOCALLLM_BASE_URL;
process.env.AGINTIFLOW_HOME = path.join(integrationRoot, "home");

function createFakeClient(observations) {
  return {
    chat: {
      completions: {
        create: async (request) => {
          observations.modelCalls += 1;
          observations.requestModels.push(request.model);
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "The readiness preflight checks the local service, runtime, authentication, and model aliases.",
                },
              },
            ],
          };
        },
      },
    },
  };
}

async function createRunConfig(
  id,
  baseURL,
  {
    model = ROUTE_MODEL,
    mainModel = MAIN_MODEL,
    localResourceProbe,
    routingMode = "manual",
    goal = "Explain the purpose of a local provider readiness preflight.",
    taskProfile = "auto",
    enableScs = "off",
    includeRoleOverrides = true,
  } = {}
) {
  const workspace = path.join(integrationRoot, "workspaces", id);
  await fs.mkdir(workspace, { recursive: true });
  const observations = {
    factoryCalls: 0,
    modelCalls: 0,
    factoryModels: [],
    factoryProviders: [],
    factoryBaseURLs: [],
    requestModels: [],
  };
  const client = createFakeClient(observations);
  const roleOverrides = includeRoleOverrides
    ? {
        routeProvider: "localllm",
        routeModel: ROUTE_MODEL,
        mainProvider: "localllm",
        mainModel,
      }
    : {};
  const config = resolveRuntimeConfig(
    {
      provider: "localllm",
      routingMode,
      ...(model ? { model } : {}),
      goal,
      taskProfile,
      commandCwd: workspace,
      maxSteps: 1,
      enableScs,
    },
    {
      baseDir: workspace,
      packageDir: packageRoot,
      provider: "localllm",
      routingMode,
      ...(model ? { model } : {}),
      ...roleOverrides,
      ...(baseURL ? { baseURL } : {}),
      apiKey: TEST_BEARER_TOKEN,
      commandCwd: workspace,
      sessionId: id,
      maxSteps: 1,
      dynamicSteps: "off",
      enableScs,
      taskProfile,
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
  Object.assign(config, {
    clientFactory: async (effectiveConfig) => {
      observations.factoryCalls += 1;
      observations.factoryModels.push(effectiveConfig.model);
      observations.factoryProviders.push(effectiveConfig.provider);
      observations.factoryBaseURLs.push(effectiveConfig.baseURL);
      return client;
    },
    onConsole: () => {},
    onEvent: () => {},
    onLog: () => {},
    ...(localResourceProbe ? { localResourceProbe } : {}),
  });
  return { config, observations };
}

async function loadPersistedRun(config, id) {
  const sessionDir = path.join(config.sessionsDir, id);
  const state = JSON.parse(await fs.readFile(path.join(sessionDir, "state.json"), "utf8"));
  const events = (await fs.readFile(path.join(sessionDir, "events.jsonl"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { state, events };
}

function assertOnlyRequestedModel(observations, expectedModel, message) {
  assert.ok(observations.requestModels.length > 0, `${message}: no inference request was observed`);
  assert.ok(
    observations.requestModels.every((model) => model === expectedModel),
    `${message}: observed ${JSON.stringify(observations.requestModels)}`
  );
}

try {
  assert.throws(
    () =>
      resolveRuntimeConfig(
        { provider: "localllm", routingMode: "manual", model: ROUTE_MODEL, goal: "configuration guard" },
        {
          baseDir: integrationRoot,
          packageDir: packageRoot,
          provider: "localllm",
          routingMode: "manual",
          model: ROUTE_MODEL,
          baseURL: "https://collector.example/v1",
        }
      ),
    assertConfigurationError
  );

  process.env.LOCALLLM_BASE_URL = "https://collector.example/v1";
  assert.throws(
    () =>
      resolveRuntimeConfig(
        { provider: "localllm", routingMode: "manual", model: ROUTE_MODEL, goal: "ambient configuration guard" },
        { baseDir: integrationRoot, packageDir: packageRoot, provider: "localllm", routingMode: "manual", model: ROUTE_MODEL }
      ),
    assertConfigurationError
  );
  if (originalLocalLLMBaseURL === undefined) delete process.env.LOCALLLM_BASE_URL;
  else process.env.LOCALLLM_BASE_URL = originalLocalLLMBaseURL;

  const nonLoopback = await createRunConfig("nonloopback-run", "http://127.0.0.1:9/v1");
  nonLoopback.config.baseURL = "https://collector.example/v1";
  await assert.rejects(() => runAgent(nonLoopback.config), assertReadinessError("BASE_URL_NOT_LOOPBACK"));
  assert.equal(nonLoopback.observations.factoryCalls, 0, "non-loopback run created a model client before refusing the provider");
  assert.equal(nonLoopback.observations.modelCalls, 0, "non-loopback run reached model inference");

  await withFixture(
    { health: { ok: true, service: "localllm-api", ollama: { ok: false } } },
    async ({ baseURL }) => {
      const runtimeDown = await createRunConfig("runtime-down-run", baseURL);
      await assert.rejects(() => runAgent(runtimeDown.config), assertReadinessError("RUNTIME_UNAVAILABLE"));
      assert.equal(runtimeDown.observations.factoryCalls, 0, "runtime-down run created a model client before preflight finished");
      assert.equal(runtimeDown.observations.modelCalls, 0, "runtime-down run reached model inference");
      const persisted = await loadPersistedRun(runtimeDown.config, "runtime-down-run");
      assert.equal(persisted.state.chat[0]?.role, "user", "failed initial preflight did not persist the user turn");
      assert.match(persisted.state.chat[0]?.content || "", /purpose of a local provider readiness preflight/i);
      assert.equal(persisted.state.chat.at(-1)?.role, "assistant", "failed initial preflight did not persist a visible failure");
      assert.match(persisted.state.chat.at(-1)?.content || "", /RUNTIME_UNAVAILABLE/);
      assert.ok(
        persisted.events.some((event) => event.type === "session.failed" && event.data?.code === "RUNTIME_UNAVAILABLE"),
        "failed initial preflight did not append a typed session.failed event"
      );
    }
  );

  const resumeFailureScenario = {};
  await withFixture(resumeFailureScenario, async ({ baseURL }) => {
    const initial = await createRunConfig("resume-preflight-durability", baseURL);
    await runAgent(initial.config);

    resumeFailureScenario.health = { ok: true, service: "localllm-api", ollama: { ok: false } };
    const resumed = await createRunConfig("resume-preflight-durability", baseURL, { model: MAIN_MODEL });
    resumed.config.resume = "resume-preflight-durability";
    resumed.config.goal = "This continuation must remain durable when provider readiness fails.";
    resumed.config.runtimePatch = { provider: "localllm", model: MAIN_MODEL };
    resumed.config.expectedRuntimeRevision = 1;
    await assert.rejects(() => runAgent(resumed.config), assertReadinessError("RUNTIME_UNAVAILABLE"));
    assert.equal(resumed.observations.factoryCalls, 0, "failed resumed preflight created a model client");
    assert.equal(resumed.observations.modelCalls, 0, "failed resumed preflight reached model inference");

    const persisted = await loadPersistedRun(resumed.config, "resume-preflight-durability");
    assert.equal(persisted.state.meta.runtimeConfig.revision, 2, "accepted runtime patch did not persist revision 2");
    assert.ok(
      persisted.state.chat.some(
        (entry) => entry.role === "user" && /continuation must remain durable/i.test(entry.content || "")
      ),
      "failed resumed preflight lost the accepted continuation"
    );
    assert.equal(persisted.state.chat.at(-1)?.role, "assistant");
    assert.match(persisted.state.chat.at(-1)?.content || "", /RUNTIME_UNAVAILABLE/);
    assert.ok(
      persisted.events.some((event) => event.type === "conversation.continued"),
      "failed resumed preflight did not record conversation.continued"
    );
    assert.ok(
      persisted.events.some((event) => event.type === "session.failed" && event.data?.code === "RUNTIME_UNAVAILABLE"),
      "failed resumed preflight did not record the typed failure"
    );
  });

  await withFixture(
    { models: { object: "list", data: [{ id: ROUTE_MODEL }] } },
    async ({ baseURL }) => {
      const missingAlias = await createRunConfig("missing-alias-run", baseURL);
      await assert.rejects(() => runAgent(missingAlias.config), assertReadinessError("MODEL_ALIAS_MISSING"));
      assert.equal(missingAlias.observations.factoryCalls, 0, "missing-alias run created a model client before preflight finished");
      assert.equal(missingAlias.observations.modelCalls, 0, "missing-alias run reached model inference");
    }
  );

  const complexSmartGoal =
    "Architect and repair a complex multi-file compiler regression, update the database and CI, review security, then run every test.";
  const simpleSmartGoal = "Inspect README.md and summarize it.";
  await withFixture({}, async ({ baseURL, observations: fixtureObservations }) => {
    const ambientSnapshot = {
      AGENT_PROVIDER: process.env.AGENT_PROVIDER,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      AGINTI_LOCALLLM_BASE_URL: process.env.AGINTI_LOCALLLM_BASE_URL,
    };
    process.env.AGENT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "offline-ambient-openai-key";
    process.env.OPENAI_BASE_URL = "https://hosted-model.invalid/v1";
    process.env.AGINTI_LOCALLLM_BASE_URL = baseURL;
    try {
      const localSCS = await createRunConfig("ambient-hosted-provider-scs", "", {
        model: "",
        routingMode: "smart",
        goal: complexSmartGoal,
        enableScs: "auto",
        includeRoleOverrides: false,
      });
      assert.equal(localSCS.config.scsActive, true, "ambient-provider production fixture must exercise SCS");
      assert.equal(localSCS.config.requestedProvider, "localllm");
      assert.equal(localSCS.config.routeProvider, "localllm");
      assert.equal(localSCS.config.mainProvider, "localllm");
      assert.equal(localSCS.config.spareProvider, "localllm");
      assert.equal(localSCS.config.provider, "localllm", "ambient AGENT_PROVIDER escaped the explicit LocalLLM boundary");
      assert.equal(localSCS.config.model, MAIN_MODEL);
      assert.equal(localSCS.config.baseURL, baseURL, "explicit LocalLLM resolved the ambient hosted base URL");

      await runAgent(localSCS.config);
      assert.deepEqual(localSCS.observations.factoryProviders, ["localllm"]);
      assert.deepEqual(localSCS.observations.factoryBaseURLs, [baseURL]);
      assert.deepEqual(localSCS.observations.factoryModels, [MAIN_MODEL]);
      assertOnlyRequestedModel(localSCS.observations, MAIN_MODEL, "SCS client escaped the explicit LocalLLM route");
      assert.equal(fixtureObservations.modelRequests, 1, "explicit LocalLLM SCS run did not use loopback readiness");
      assert.ok(fixtureObservations.sawExpectedBearer, "explicit LocalLLM SCS readiness was not authenticated");
    } finally {
      for (const [key, value] of Object.entries(ambientSnapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  await withFixture({}, async ({ baseURL }) => {
    const initialDeep = await createRunConfig("smart-deep-resume", baseURL, {
      model: "",
      routingMode: "smart",
      goal: complexSmartGoal,
    });
    assert.equal(initialDeep.config.model, MAIN_MODEL, "complex fresh smart run did not select Deep");
    await runAgent(initialDeep.config);
    assert.deepEqual(initialDeep.observations.factoryModels, [MAIN_MODEL]);
    assertOnlyRequestedModel(initialDeep.observations, MAIN_MODEL, "fresh complex smart run drifted from Deep");

    const resumedDeep = await createRunConfig("smart-deep-resume", baseURL, {
      model: "",
      routingMode: "smart",
      goal: simpleSmartGoal,
    });
    assert.equal(resumedDeep.config.model, ROUTE_MODEL, "simple incoming smart config must remain independently dynamic");
    resumedDeep.config.resume = "smart-deep-resume";
    resumedDeep.config.expectedRuntimeRevision = 1;
    await runAgent(resumedDeep.config);
    assert.deepEqual(
      resumedDeep.observations.factoryModels,
      [MAIN_MODEL],
      "resumed Deep snapshot was not the model used to construct the actual client"
    );
    assertOnlyRequestedModel(
      resumedDeep.observations,
      MAIN_MODEL,
      "resumed Deep snapshot was not the model sent to actual inference"
    );
    const persistedDeep = await loadPersistedRun(resumedDeep.config, "smart-deep-resume");
    assert.equal(persistedDeep.state.model, MAIN_MODEL, "resumed Deep run persisted a drifted top-level model");
    assert.equal(
      persistedDeep.state.meta.runtimeConfig.model,
      MAIN_MODEL,
      "resumed Deep run persisted a drifted runtime snapshot"
    );
  });

  await withFixture({}, async ({ baseURL }) => {
    const initialFast = await createRunConfig("smart-fast-resume", baseURL, {
      model: "",
      routingMode: "smart",
      goal: simpleSmartGoal,
    });
    assert.equal(initialFast.config.model, ROUTE_MODEL, "simple fresh smart run did not select Fast");
    await runAgent(initialFast.config);
    assert.deepEqual(initialFast.observations.factoryModels, [ROUTE_MODEL]);
    assertOnlyRequestedModel(initialFast.observations, ROUTE_MODEL, "fresh simple smart run drifted from Fast");

    const resumedFast = await createRunConfig("smart-fast-resume", baseURL, {
      model: "",
      routingMode: "smart",
      goal: complexSmartGoal,
    });
    assert.equal(resumedFast.config.model, MAIN_MODEL, "complex incoming smart config must remain independently dynamic");
    resumedFast.config.resume = "smart-fast-resume";
    resumedFast.config.expectedRuntimeRevision = 1;
    await runAgent(resumedFast.config);
    assert.deepEqual(
      resumedFast.observations.factoryModels,
      [ROUTE_MODEL],
      "resumed Fast snapshot was not the model used to construct the actual client"
    );
    assertOnlyRequestedModel(
      resumedFast.observations,
      ROUTE_MODEL,
      "resumed Fast snapshot was not the model sent to actual inference"
    );
    const persistedFast = await loadPersistedRun(resumedFast.config, "smart-fast-resume");
    assert.equal(persistedFast.state.model, ROUTE_MODEL, "resumed Fast run persisted a drifted top-level model");
    assert.equal(
      persistedFast.state.meta.runtimeConfig.model,
      ROUTE_MODEL,
      "resumed Fast run persisted a drifted runtime snapshot"
    );
  });

  await withFixture(
    { models: { object: "list", data: [{ id: ROUTE_MODEL }, { id: MAIN_MODEL }, { id: MAX_MODEL }] } },
    async ({ baseURL }) => {
      let resourceChecks = 0;
      const pressuredMax = await createRunConfig("pressured-max-run", baseURL, {
        model: MAX_MODEL,
        localResourceProbe: async () => {
          resourceChecks += 1;
          return {
            ready: false,
            status: "pressured",
            sharedWorkstationPressure: true,
            reasons: ["swap-use-above-75-percent"],
            metrics: { availableRamBytes: 32 * 1024 ** 3, swapPressureRatio: 0.9, aggregateGpuFreeMiB: 48000 },
            thresholds: {},
          };
        },
      });
      assert.equal(pressuredMax.config.requiresResourcePreflight, true);
      await assert.rejects(() => runAgent(pressuredMax.config), assertReadinessError("LOCAL_RESOURCE_PRESSURE"));
      assert.equal(resourceChecks, 1, "explicit Max did not perform a fresh resource check");
      assert.equal(pressuredMax.observations.factoryCalls, 0, "pressured Max created a model client before resource refusal");
      assert.equal(pressuredMax.observations.modelCalls, 0, "pressured Max reached inference");
    }
  );

  await withFixture(
    { models: { object: "list", data: [{ id: ROUTE_MODEL }, { id: MAIN_MODEL }, { id: MAX_MODEL }] } },
    async ({ baseURL }) => {
      const previousBaseURL = process.env.AGINTI_LOCALLLM_BASE_URL;
      process.env.AGINTI_LOCALLLM_BASE_URL = "http://127.0.0.1:9/v1";
      try {
        let resourceChecks = 0;
        const readyProbe = async () => {
          resourceChecks += 1;
          return {
            ready: true,
            status: "ready",
            sharedWorkstationPressure: false,
            reasons: [],
            metrics: { availableRamBytes: 32 * 1024 ** 3, swapPressureRatio: 0.5, aggregateGpuFreeMiB: 46000 },
            thresholds: {},
          };
        };
        const healthyMax = await createRunConfig("healthy-max-run", baseURL, {
          model: MAX_MODEL,
          localResourceProbe: readyProbe,
        });
        await runAgent(healthyMax.config);
        assert.equal(resourceChecks, 1);
        assert.equal(healthyMax.observations.modelCalls, 1);

        const resumedMax = await createRunConfig("healthy-max-run", baseURL, {
          model: MAX_MODEL,
          localResourceProbe: readyProbe,
        });
        resumedMax.config.resume = "healthy-max-run";
        resumedMax.config.goal = "Continue explaining why Max resource checks run again on resume.";
        resumedMax.config.expectedRuntimeRevision = 1;
        await runAgent(resumedMax.config);
        assert.equal(resourceChecks, 2, "resumed Max reused a stale resource decision");
        assert.equal(resumedMax.observations.modelCalls, 1);
      } finally {
        if (previousBaseURL === undefined) delete process.env.AGINTI_LOCALLLM_BASE_URL;
        else process.env.AGINTI_LOCALLLM_BASE_URL = previousBaseURL;
      }
    }
  );

  await withFixture({}, async ({ baseURL, observations: fixtureObservations }) => {
    const healthy = await createRunConfig("healthy-preflight-run", baseURL);
    healthy.config.localResourceProbe = async () => {
      throw new Error("Deep/Fast must not collect Max resource status");
    };
    const result = await runAgent(healthy.config);
    assert.equal(healthy.observations.factoryCalls, 1, "healthy preflight did not proceed to the injected model client");
    assert.equal(healthy.observations.modelCalls, 1, "healthy preflight did not proceed to one model inference call");
    assert.match(result.result, /readiness preflight checks/i);
    assert.equal(fixtureObservations.modelRequests, 1, "production preflight did not discover LocalLLM models exactly once");
    assert.ok(fixtureObservations.sawExpectedBearer, "production preflight did not authenticate model discovery");
  });

  assert.equal(await preflightProviderRuntime({ provider: "mock" }), null, "mock provider should not be probed");
  assert.equal(await preflightProviderRuntime({ provider: "openai" }), null, "hosted provider should not be probed");
  await assert.rejects(
    () => preflightProviderRuntime({ provider: "localllm", providerReadinessMode: "deterministic-test" }),
    assertReadinessError("UNSAFE_PREFLIGHT_BYPASS")
  );
  const deterministicClientFactory = async () => createFakeClient({ modelCalls: 0 });
  deterministicClientFactory.agintiDeterministicTest = true;
  const deterministicBypass = await preflightProviderRuntime({
    provider: "localllm",
    providerReadinessMode: "deterministic-test",
    clientFactory: deterministicClientFactory,
  });
  assert.equal(deterministicBypass.status, "skipped", "deterministic injected test client bypass was not explicit");
} finally {
  if (originalLocalLLMBaseURL === undefined) delete process.env.LOCALLLM_BASE_URL;
  else process.env.LOCALLLM_BASE_URL = originalLocalLLMBaseURL;
  if (originalAgintiflowHome === undefined) delete process.env.AGINTIFLOW_HOME;
  else process.env.AGINTIFLOW_HOME = originalAgintiflowHome;
  await fs.rm(integrationRoot, { recursive: true, force: true });
}

console.log("LocalLLM provider readiness smoke ok");
