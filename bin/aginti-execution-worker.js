#!/usr/bin/env node
import {
  createProductionExecutionWorkerServer,
  installExecutionWorkerShutdownHandlers,
  loadExecutionWorkerServerConfig,
} from "../src/execution-worker-server.js";

try {
  const config = await loadExecutionWorkerServerConfig();
  const runtime = await createProductionExecutionWorkerServer({ config });
  installExecutionWorkerShutdownHandlers(runtime.server);
  console.log(JSON.stringify({
    ok: true,
    service: "aginti-execution-worker",
    workerId: config.workerId,
    runtimeBundleRootDigest: config.runtimeBundleRootDigest,
    listener: runtime.address,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    service: "aginti-execution-worker",
    code: typeof error?.code === "string" ? error.code : "EXECUTION_WORKER_START_FAILED",
  }));
  process.exitCode = 1;
}
