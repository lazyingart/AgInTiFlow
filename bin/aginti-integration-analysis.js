#!/usr/bin/env node
import { main, safeIntegrationAnalysisCliError } from "../src/integration-analysis-cli.js";

main().catch((error) => {
  process.stderr.write(`aginti-integration-analysis: ${safeIntegrationAnalysisCliError(error)}\n`);
  process.exitCode = 1;
});
