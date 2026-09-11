import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTestOnlyPublicPdfDownloader } from "../../src/public-pdf-download.js";
import { ACQUIRED_PAPER_MAXIMUM_BYTES } from "../../src/integration-acquired-paper-contract.js";
import { pdf } from "./acquired-paper.js";

// Synthetic public TLS peer; no live DNS, network, compiler or model request.
export function paperDownloadFixture({ beforeLookup, body = () => pdf(), maximumBytes = ACQUIRED_PAPER_MAXIMUM_BYTES } = {}) {
  const downloads = [];
  const downloader = createTestOnlyPublicPdfDownloader({
    allowedOrigins: ["https://papers.example.org", "https://arxiv.org"], maximumBytes, timeoutMs: 1000,
  }, {
    async lookup() {
      await beforeLookup?.();
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request(options, callback) {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        downloads.push(options.path);
        const bytes = body(downloads.length);
        const stream = new PassThrough();
        stream.statusCode = 200;
        stream.complete = true;
        stream.headers = { "content-type": "application/pdf", "content-length": String(bytes.length) };
        stream.socket = { authorized: true, remoteAddress: "8.8.8.8" };
        const aborted = () => stream.destroy(options.signal.reason);
        options.signal.addEventListener("abort", aborted, { once: true });
        stream.once("close", () => options.signal.removeEventListener("abort", aborted));
        callback(stream);
        setImmediate(() => stream.end(bytes));
      });
      return request;
    },
  });
  return { downloader, downloads };
}
