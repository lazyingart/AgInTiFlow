#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import {
  classifyProviderHandoffError,
  resolveProviderHandoff,
} from "../src/provider-handoff.js";
import { SessionStore } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assistant(content) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

assert.deepEqual(
  classifyProviderHandoffError(Object.assign(new Error("402 Insufficient Balance"), { status: 402 })),
  { eligible: true, code: "provider_quota", status: 402 }
);
assert.equal(
  classifyProviderHandoffError(Object.assign(new Error("invalid request"), { status: 400 })).eligible,
  false
);
assert.equal(
  resolveProviderHandoff(Object.assign(new Error("payment required"), { status: 402 }), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routingMode: "manual",
  }),
  null,
  "manual provider selection must remain exact"
);
assert.equal(
  resolveProviderHandoff(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }), {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    routingMode: "smart",
  }),
  null,
  "an unmarked tool/runtime network error changed the reasoning provider"
);

async function runScenario({ routingMode, sessionId }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agintiflow-provider-handoff-"));
  const workspace = path.join(tempRoot, "workspace");
  const sessionsDir = path.join(tempRoot, "sessions");
  const projectSessionsDir = path.join(workspace, ".aginti-sessions");
  await fs.mkdir(workspace, { recursive: true });

  const factoryConfigs = [];
  const requests = [];
  const clientFactory = async (config) => {
    factoryConfigs.push({ provider: config.provider, model: config.model });
    return {
      chat: {
        completions: {
          create: async (payload) => {
            requests.push({ provider: config.provider, model: payload.model });
            if (config.provider === "deepseek") {
              throw Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
            }
            return assistant("Local fallback produced the complete response.");
          },
        },
      },
    };
  };
  clientFactory.agintiDeterministicTest = true;

  const goal = [
    "Explain the current task result clearly.",
    `AGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({
      mode: "host-managed-response",
      request: "Explain the current task result clearly.",
    })}`,
  ].join("\n");
  const config = resolveRuntimeConfig(
    {
      goal,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      routeProvider: "deepseek",
      routeModel: "deepseek-v4-flash",
      mainProvider: "deepseek",
      mainModel: "deepseek-v4-pro",
      spareProvider: "deepseek",
      spareModel: "deepseek-v4-pro",
      routingMode,
      taskProfile: "research",
      commandCwd: workspace,
    },
    {
      baseDir: workspace,
      packageDir: repoRoot,
      sessionId,
      clientFactory,
      providerReadinessMode: "deterministic-test",
      sandboxMode: "host",
      useDockerSandbox: false,
      allowShellTool: false,
      allowFileTools: false,
      allowWrapperTools: false,
      allowAuxiliaryTools: false,
      allowWebSearch: false,
      allowMcpTools: false,
      allowParallelScouts: false,
      enableScs: "off",
    }
  );
  Object.assign(config, {
    apiKey: "deterministic-hosted-test",
    clientFactory,
    providerReadinessMode: "deterministic-test",
    sessionsDir,
    projectSessionsDir,
    useDockerSandbox: false,
    sandboxMode: "host",
    enableScs: "off",
    scsActive: false,
    dynamicSteps: "off",
    maxSteps: 4,
    modelTimeoutMs: 1000,
  });

  try {
    let result = null;
    let error = null;
    try {
      result = await runAgent(config);
    } catch (caught) {
      error = caught;
    }
    const store = new SessionStore(sessionsDir, sessionId, {
      projectRoot: workspace,
      commandCwd: workspace,
      projectSessionsDir,
    });
    return {
      result,
      error,
      state: await store.loadState(),
      events: await store.loadEvents(),
      factoryConfigs,
      requests,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const smart = await runScenario({ routingMode: "smart", sessionId: "smart-provider-handoff" });
assert.equal(smart.error, null);
assert.equal(smart.result.result, "Local fallback produced the complete response.");
assert.deepEqual(smart.factoryConfigs, [
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "localllm", model: "localllm-deep" },
]);
assert.deepEqual(smart.requests.map((item) => item.provider), ["deepseek", "localllm"]);
assert.equal(smart.state.provider, "localllm");
assert.equal(smart.state.model, "localllm-deep");
assert.equal(smart.state.meta.runtimeConfig.provider, "localllm");
assert.equal(smart.state.meta.runtimeConfig.model, "localllm-deep");
assert.equal(smart.state.meta.providerHandoff.status, "active");
assert.equal(smart.state.meta.goalContract.status, "completed");
assert.equal(smart.events.filter((event) => event.type === "provider.handoff_requested").length, 1);
assert.equal(smart.events.filter((event) => event.type === "provider.handoff_activated").length, 1);
assert.equal(smart.events.filter((event) => event.type === "session.failed").length, 0);

const manual = await runScenario({ routingMode: "manual", sessionId: "manual-provider-exact" });
assert(manual.error);
assert.equal(manual.factoryConfigs.length, 1);
assert.equal(manual.events.filter((event) => event.type === "provider.handoff_requested").length, 0);
assert.equal(manual.events.filter((event) => event.type === "session.failed").length, 1);

console.log("provider handoff smoke test passed");
