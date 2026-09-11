import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openIntegrationFileWorkerStore } from "../../src/integration-file-worker-store.js";
import { openIntegrationDocumentWorkerStore } from "../../src/integration-document-worker-store.js";
import { createTestOnlyIntegrationDocumentWorkerService } from "../../src/integration-document-worker-service.js";
import { createIntegrationDocumentWorkerServer } from "../../src/integration-document-worker-server.js";
import { createTestOnlyIntegrationFileWorkerClient } from "../../src/integration-file-worker-client.js";
import { testDocumentWorkerConfig, TEST_BEARER_TOKEN } from "../../scripts/fixtures/integration-document-worker-smoke-fixture.js";

export async function createPaperHttpWorker(t, { paperImport = true, creation = true, omitted = false } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-paper-http-"));
  const store = await openIntegrationDocumentWorkerStore({ stateRoot: path.join(parent, "documents") });
  const fileStore = await openIntegrationFileWorkerStore({ stateRoot: path.join(parent, "files") });
  const config = { ...testDocumentWorkerConfig(creation), ...(omitted ? {} : { paperImport: { enabled: paperImport } }) };
  const service = createTestOnlyIntegrationDocumentWorkerService({
    config, store, fileStore,
    inspectRuntimeImpl: async () => ({ ready: true, networkNone: true, shellEscape: false, runtimeDigest: "1".repeat(64), activationProbeDigest: "2".repeat(64) }),
    compileImpl() { throw new Error("paper transport must not invoke a compiler"); },
  });
  await service.activate();
  const server = createIntegrationDocumentWorkerServer({ config, service, bearerToken: TEST_BEARER_TOKEN });
  // Actual handler, ephemeral loopback socket. Production start() and its fixed
  // address checks are unchanged; the shared live 18102 is never touched.
  await new Promise((resolve, reject) => { server.server.once("error", reject); server.server.listen(0, "127.0.0.1", resolve); });
  const port = server.server.address().port;
  t.after(async () => { await server.close(); await fs.rm(parent, { recursive: true, force: true }); });
  function client(fetchImpl = globalThis.fetch) {
    return createTestOnlyIntegrationFileWorkerClient({ endpoint: `http://127.0.0.1:${port}`, credential: TEST_BEARER_TOKEN, fetchImpl });
  }
  return { parent, server, port, fileStore, client };
}
