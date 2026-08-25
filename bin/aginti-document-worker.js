#!/usr/bin/env node
import {
  main,
  safeIntegrationDocumentWorkerCliError,
} from "../src/integration-document-worker-cli.js";

main().catch((error) => {
  process.stderr.write(`aginti-document-worker: ${safeIntegrationDocumentWorkerCliError(error)}\n`);
  process.exitCode = 1;
});
