import { createTestOnlyIntegrationAnalysisSessionService } from "../../src/integration-analysis-session-service.js";
import { createTestOnlyIntegrationFileWorkerClient } from "../../src/integration-file-worker-client.js";
import { INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES as MODES } from "../../src/integration-analysis-state-persistence.js";
import { TEST_BEARER_TOKEN } from "../../scripts/fixtures/integration-document-worker-smoke-fixture.js";
import { paperRecoveryRunner } from "./paper-recovery-runner.js";

process.once("message", async config => {
  try {
    const client = createTestOnlyIntegrationFileWorkerClient({ endpoint: config.endpoint, credential: TEST_BEARER_TOKEN, fetchImpl: fetch });
    const runner = paperRecoveryRunner(client, { additionalOutputs: config.additionalOutputs,
      stage: async name => {
        if (name !== config.stopAt) return;
        process.send({ stage: name });
        await new Promise(() => {}); // Parent kills this exact child, like a power loss.
      } });
    const service = createTestOnlyIntegrationAnalysisSessionService({ stateRoot: config.stateRoot,
      analysisRunner: runner, fileWorkerClient: client, fileWorkerEnabled: true, searchEnabled: true,
      statePersistenceMode: MODES.nativeV3 });
    const proof = await service.recoverBeforeListen();
    process.send({ proof });
    if (!config.restart) {
      const { thread } = await service.createThread({ title: "Interrupted paper" }, config.owner);
      const { run } = await service.startRun({ threadId: thread.id, input: {
        text: config.additionalOutputs ? "Find the source paper PDF and calculate 2+2." : "Find the source paper PDF.",
        search: { mode: "papers", limit: 2 },
      } }, config.owner);
      process.send({ runId: run.id, threadId: thread.id });
    }
    await service.waitForIdle();
    process.send({ idle: true });
    await service.close({ mode: "wait" });
    process.disconnect();
  } catch (error) {
    process.send({ error: error.stack });
    process.exitCode = 1;
    process.disconnect();
  }
});
