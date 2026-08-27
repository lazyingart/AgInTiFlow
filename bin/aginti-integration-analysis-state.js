#!/usr/bin/env node
import {
  main,
  safeIntegrationAnalysisStateMigrationCliError,
} from "../src/integration-analysis-state-migration-cli.js";

main().catch((error) => {
  process.stderr.write(`aginti-integration-analysis-state: ${safeIntegrationAnalysisStateMigrationCliError(error)}\n`);
  process.exitCode = 1;
});
