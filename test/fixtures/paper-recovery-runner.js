import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationPaperAcquisitionClient } from "../../src/integration-paper-acquisition.js";
import { PAPER_ACQUISITION_SCHEMA as JOB } from "../../src/integration-paper-acquisition-contract.js";
import { paperDownloadFixture } from "./paper-download.js";
import { paperSourceArtifact } from "./paper-source.js";

// Deterministic planner protocol, real durable session + HTTP/file worker.
// Actual model planner replay is covered separately in the planner smoke suite.
export function paperRecoveryRunner(client, { stage = async () => {}, additionalOutputs = false,
  failContinuation = false, disagreeAfterFinal = false, configured = true } = {}) {
  const { downloader, downloads } = paperDownloadFixture();
  const acquisition = createTestOnlyIntegrationPaperAcquisitionClient({ downloader, fileWorkerClient: client });
  const resumed = [];
  return {
    downloads, resumed,
    attestation: { sourcePaperAcquisitionConfigured: configured },
    async run(scope, input, options) {
      resumed.push(options.paperResume ?? null);
      const sources = options.paperResume?.sourceArtifact ?? (input.search ? paperSourceArtifact(input) : null);
      if (sources) await options.onArtifact(sources);
      const selection = options.paperResume?.selection ?? {
        schemaVersion: JOB.select, sourceArtifactId: sources.id, sourceIndex: 1,
      };
      await options.onPaperCheckpoint({ selection, additionalOutputs,
        report: options.paperResume?.report ?? null });
      await options.onProgress({ phase: "executing", toolName: "acquire_source_pdf",
        toolCallNumber: 1, toolCallsCompleted: 0, executionState: "starting" });
      await stage("before-download");
      const acquired = await acquisition.acquire(selection, { signal: options.signal,
        onPaperAcquireIntent: async request => {
          const result = await options.onPaperAcquireIntent(request);
          if (request.schemaVersion === JOB.issued) await stage("after-issue");
          return result;
        } });
      await stage("after-import");
      for (const artifact of acquired.artifacts) await options.onArtifact(artifact);
      await options.onFileCommitIntent(acquired.artifacts);
      await client.commitArtifacts(scope, { receiptDigest: acquired.receipt.digest, artifacts: acquired.artifacts });
      await options.onProgress({ phase: "executing", toolName: "acquire_source_pdf",
        toolCallNumber: 1, toolCallsCompleted: 1, executionState: "succeeded" });
      await stage("after-commit");
      if (additionalOutputs) {
        await options.onPaperContinuation();
        await stage("continuation");
        if (failContinuation) throw new Error("fixture calculation did not finish");
      }
      const result = { schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
        text: additionalOutputs ? "Original paper delivered; calculation result is 4." : "Original source paper delivered.",
        kind: "analysis", toolCalls: 1, executionStatus: "succeeded", artifacts: [...(sources ? [sources] : []), ...acquired.artifacts] };
      await options.onFinal(result);
      await stage("after-final-callback");
      return disagreeAfterFinal ? { ...result, text: "An inconsistent result." } : result;
    },
  };
}
