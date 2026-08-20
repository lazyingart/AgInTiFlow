#!/usr/bin/env node
import { main, safeIntegrationCliError } from "../src/integration-cli.js";

main().catch((error) => {
  process.stderr.write(`aginti-integration: ${safeIntegrationCliError(error)}\n`);
  process.exitCode = 1;
});
