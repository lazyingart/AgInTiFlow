#!/usr/bin/env node

import fs from "node:fs";

import { createSystemdIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createIntegrationAnalysisPlanner } from "../src/integration-analysis-planner.js";

const CREDENTIAL_ROOT = "/run/credentials/agintiflow-integration.service";
const LOCAL_LLM_TOKEN_PATH = `${CREDENTIAL_ROOT}/localllm-token`;

const coordinator = await createSystemdIntegrationAnalysisCoordinator();

try {
  const planner = createIntegrationAnalysisPlanner({
    coordinator,
    localModelConfig: {
      baseURL: "http://127.0.0.1:18080/v1",
      model: "localllm-code",
      apiKey: fs.readFileSync(LOCAL_LLM_TOKEN_PATH, "utf8").trim(),
      contextWindowTokens: 32_768,
      maxOutputTokens: 2_048,
      modelTimeoutMs: 180_000,
    },
  });
  const plannerActivation = await planner.activate();
  const progress = [];
  const streamedArtifacts = [];
  const final = await planner.run(
    {
      principalId: "production-planner-smoke",
      browserSessionId: "a".repeat(64),
      threadId: "thr_11111111-1111-4111-8111-111111111111",
      runId: "run_22222222-2222-4222-8222-222222222222",
    },
    {
      prompt:
        "Run Python code to calculate the squares of 1 through 5. Show a line plot, a table, and a short Markdown summary of the real result.",
      conversation: [],
    },
    {
      onProgress(value) {
        progress.push(value);
      },
      onArtifact(value) {
        streamedArtifacts.push({ id: value.id, kind: value.kind, title: value.title });
      },
    }
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    readiness: plannerActivation.readinessProof,
    plannerActivation,
    plannerAttestation: planner.attestation,
    progress,
    streamedArtifacts,
    final,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    name: error?.name || "Error",
    code: error?.code || "UNKNOWN",
    status: error?.status || null,
    message: error?.message || "Production planner smoke failed.",
  })}\n`);
  process.exitCode = 1;
} finally {
  coordinator.close();
}
