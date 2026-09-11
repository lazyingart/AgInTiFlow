#!/usr/bin/env node
// Explicit, single public-document diagnostic. No model or provider key.
// It neither publishes nor stores the downloaded paper.
import assert from "node:assert/strict";
import { createPublicPdfDownloader } from "../src/public-pdf-download.js";

if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  console.error("Use node scripts/smoke-public-pdf-download.js --live for one public arXiv PDF request; unit tests are offline.");
  process.exitCode = 2;
} else {
  const url = "https://arxiv.org/pdf/1810.04805";
  const client = createPublicPdfDownloader({ allowedOrigins: ["https://arxiv.org"], timeoutMs: 60000 });
  const started = Date.now();
  try {
    const result = await client.download(url);
    assert.equal(result.sourceUrl, url);
    assert.equal(result.finalUrl, url);
    assert.equal(result.mime, "application/pdf");
    assert(result.sizeBytes > 10000);
    console.log(JSON.stringify({
      ok: true, sourceUrl: url, sizeBytes: result.sizeBytes, sha256: result.sha256,
      acquiredAt: result.acquiredAt, elapsedMs: Date.now() - started,
      tlsAndPublicAddressVerified: true, stored: false, published: false,
      parsed: false, providerCalls: 0,
    }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || error.name, status: error.status ?? null }));
    process.exitCode = 1;
  }
}
