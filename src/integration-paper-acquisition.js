// One bounded acquisition attempt. The caller owns scheduling/retry policy and
// a durable onPaperAcquireIntent hook; no new state root, public URL or token.
import { assertPublicPdfDownloader } from "./public-pdf-download.js";
import { assertIntegrationFileWorkerClient } from "./integration-file-worker-client.js";
import {
  ACQUIRED_PAPER_MAXIMUM_BYTES, ACQUIRED_PAPER_SCHEMA_VERSIONS as PAPER,
  validateAcquiredPaperIssueRequest, validateAcquiredPaperImportRequest,
} from "./integration-acquired-paper-contract.js";
import { PAPER_ACQUISITION_SCHEMA as JOB, validatePaperSelectionRequest } from "./integration-paper-acquisition-contract.js";
import { canonicalJson } from "./integration-policy.js";
import { exactDocumentWorkerObject, documentWorkerFail } from "./integration-document-worker-contract.js";

const CLIENTS = new WeakSet();
const WORKERS = new WeakMap();
export const INTEGRATION_PAPER_ACQUISITION_TOOL_NAME = "acquire_source_pdf";
function invalid() { documentWorkerFail("ANALYSIS_PAPER_AUTHORITY_INVALID", "Durable paper acquisition authority is required.", { status: 409 }); }

function createClient(options, testOnly) {
  exactDocumentWorkerObject(options, ["downloader", "fileWorkerClient"], ["downloader", "fileWorkerClient"], "paper acquisition clients");
  const downloader = assertPublicPdfDownloader(options.downloader, { allowTestOnly: testOnly });
  const worker = assertIntegrationFileWorkerClient(options.fileWorkerClient, { allowTestOnly: testOnly });
  if (downloader.maximumBytes > ACQUIRED_PAPER_MAXIMUM_BYTES) invalid();
  const client = Object.freeze({
    testOnly,
    readiness: options => worker.paperReadiness(options),
    async acquire(selectionRequest, optionsValue) {
      const request = validatePaperSelectionRequest(selectionRequest);
      const options = exactDocumentWorkerObject(optionsValue, ["signal", "onPaperAcquireIntent"], ["onPaperAcquireIntent"], "paper acquisition options");
      if (typeof options.onPaperAcquireIntent !== "function" ||
          (options.signal !== undefined && !(options.signal instanceof AbortSignal))) invalid();
      const check = () => options.signal?.throwIfAborted();
      const authorize = options.onPaperAcquireIntent;
      check();
      // The service resolves the real stored record, not a URL supplied by the
      // model. Persist this selection even if readiness/download later fails.
      const selection = await authorize(request);
      check();
      const readiness = await worker.paperReadiness({ signal: options.signal });
      if (!readiness.creationEnabled) documentWorkerFail("ANALYSIS_PAPER_DISABLED", "Paper downloads are not enabled on this worker.", { status: 503 });
      check();
      const acquired = await downloader.download(selection.pdfUrl, { signal: options.signal });
      try {
        check();
        const source = { sourceId: selection.sourceId, sourceUrl: acquired.sourceUrl, finalUrl: acquired.finalUrl,
          doi: selection.doi, version: selection.version, acquiredAt: acquired.acquiredAt };
        const file = { index: 0, filename: selection.filename, mime: acquired.mime, bytes: acquired.sizeBytes, sha256: acquired.sha256 };
        const issue = validateAcquiredPaperIssueRequest(await authorize({ schemaVersion: JOB.acquired,
          selection, authorityEpoch: readiness.authorityEpoch, file, source }));
        // A persisted retry has the original acquisition time, not a new issue.
        if (canonicalJson(issue.files) !== canonicalJson([file]) || issue.authorityEpoch !== readiness.authorityEpoch ||
            canonicalJson(issue.source) !== canonicalJson({ ...source, acquiredAt: issue.source.acquiredAt })) invalid();
        check();
        const issued = await worker.issuePaper(issue, { signal: options.signal });
        const importing = validateAcquiredPaperImportRequest({ ...issue, schemaVersion: PAPER.importRequest,
          requestId: issued.requestId, authorityToken: issued.authorityToken });
        const bound = await authorize({ schemaVersion: JOB.issued, request: importing });
        if (canonicalJson(bound) !== canonicalJson(importing)) invalid();
        check();
        return await worker.importPaper(importing, acquired.bytes, { signal: options.signal });
      } finally { acquired.bytes.fill(0); }
    },
  });
  CLIENTS.add(client);
  WORKERS.set(client, worker);
  return client;
}

export function createIntegrationPaperAcquisitionClient(options) { return createClient(options, false); }
export function createTestOnlyIntegrationPaperAcquisitionClient(options) { return createClient(options, true); }
export function assertIntegrationPaperAcquisitionClient(value, { allowTestOnly = false, fileWorkerClient } = {}) {
  if (!CLIENTS.has(value) || (value.testOnly && !allowTestOnly) ||
      (fileWorkerClient !== undefined && WORKERS.get(value) !== fileWorkerClient)) invalid();
  return value;
}
