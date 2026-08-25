#!/usr/bin/env node
import { verifyIntegrationDocumentWorkerNodeRuntime } from "../src/integration-document-worker-runtime.js";

if (process.argv.length !== 2) {
  process.stderr.write("aginti-document-worker-runtime-check: RUNTIME_IDENTITY_INVALID\n");
  process.exitCode = 1;
} else {
  verifyIntegrationDocumentWorkerNodeRuntime().catch(() => {
    process.stderr.write("aginti-document-worker-runtime-check: RUNTIME_IDENTITY_INVALID\n");
    process.exitCode = 1;
  });
}
