import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  testDocumentWorkerConfig,
  testRequirements,
} from "./fixtures/integration-document-worker-smoke-fixture.js";
import { inspectIntegrationDocumentCompileRequirements } from "../src/integration-document-worker-requirements.js";
import { createTestOnlyIntegrationDocumentWorkerService } from "../src/integration-document-worker-service.js";
import { openIntegrationDocumentWorkerStore } from "../src/integration-document-worker-store.js";
import {
  compileIntegrationTexWorkerPayload,
  inspectIntegrationTexCompilerRuntime,
  validateIntegrationTexCompileReceipt,
} from "../src/integration-tex-compiler.js";
import { isPinnedGithubHostedReleaseEnvironment } from "./github-hosted-release-environment.js";

if (isPinnedGithubHostedReleaseEnvironment()) {
  process.stdout.write(
    "integration document worker real compile skipped: pinned GitHub-hosted Linux release runner lacks the trusted bubblewrap namespace\n"
  );
  process.exit(0);
}

async function snapshotTree(root) {
  const snapshot = [];
  async function visit(relative) {
    const directory = path.join(root, relative);
    for (const name of (await fs.readdir(directory)).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(root, childRelative);
      const metadata = await fs.lstat(child);
      if (metadata.isDirectory()) {
        snapshot.push(`d:${childRelative}:${(metadata.mode & 0o777).toString(8)}`);
        await visit(childRelative);
      } else if (metadata.isFile()) {
        const digest = crypto.createHash("sha256").update(await fs.readFile(child)).digest("hex");
        snapshot.push(`f:${childRelative}:${(metadata.mode & 0o777).toString(8)}:${metadata.size}:${digest}`);
      } else {
        snapshot.push(`o:${childRelative}:${metadata.mode}`);
      }
    }
  }
  await visit("");
  return snapshot;
}

async function compilerTemporaryEntries() {
  return (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("aginti-tex-")).sort();
}

const source = [
  "\\documentclass{article}",
  "\\usepackage{tikz}",
  "\\begin{document}",
  "\\begin{figure}",
  "\\centering",
  "\\begin{tikzpicture}",
  "  \\draw[->] (0,0) -- (2,0);",
  "  \\draw[->] (0,0) -- (0,2);",
  "  \\draw[thick] (0,0) -- (1.5,1.2);",
  "\\end{tikzpicture}",
  "\\caption{Self-contained worker activation figure}",
  "\\end{figure}",
  "\\end{document}",
  "",
].join("\n");

const evidence = inspectIntegrationDocumentCompileRequirements(source, testRequirements(1));
assert.equal(evidence.verifiedFigureCount, 1);
const canaryStoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-worker-canary-store-"));
let canaryService;
try {
  const canaryStore = await openIntegrationDocumentWorkerStore({ stateRoot: canaryStoreRoot });
  const storeBefore = await snapshotTree(canaryStoreRoot);
  const temporaryBefore = await compilerTemporaryEntries();
  let runtime;
  canaryService = createTestOnlyIntegrationDocumentWorkerService({
    config: testDocumentWorkerConfig(false),
    store: canaryStore,
    inspectRuntimeImpl: async () => {
      runtime = await inspectIntegrationTexCompilerRuntime();
      return runtime;
    },
  });
  const checkReadiness = await canaryService.check();
  assert.equal(checkReadiness.creationEnabled, false);
  assert.equal(checkReadiness.compiler, null);
  assert.equal(runtime.ready, true);
  assert.equal(runtime.networkNone, true);
  assert.equal(runtime.shellEscape, false);
  assert.match(runtime.runtimeDigest, /^[a-f0-9]{64}$/u);
  assert.match(runtime.activationProbeDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await snapshotTree(canaryStoreRoot), storeBefore);
  assert.deepEqual(await compilerTemporaryEntries(), temporaryBefore);
} finally {
  await canaryService?.close().catch(() => {});
  await fs.rm(canaryStoreRoot, { recursive: true, force: true });
}

const compiled = await compileIntegrationTexWorkerPayload({
  filename: "worker-real-figure.tex",
  source,
});
try {
  const receipt = validateIntegrationTexCompileReceipt(compiled.compilerReceipt);
  assert.equal(receipt.networkNone, true);
  assert.equal(receipt.shellEscape, false);
  assert.equal(compiled.source.mime, "application/x-tex");
  assert.equal(compiled.pdf.mime, "application/pdf");
  assert.deepEqual(compiled.source.bytes, Buffer.from(source, "utf8"));
  assert.equal(compiled.pdf.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(compiled.pdf.bytes.byteLength, receipt.pdfBytes);
  assert.equal(compiled.source.bytes.byteLength, receipt.sourceBytes);
  assert.ok(!Object.hasOwn(compiled.source, "path"));
  assert.ok(!Object.hasOwn(compiled.pdf, "path"));
} finally {
  compiled.source.bytes.fill(0);
  compiled.pdf.bytes.fill(0);
}

process.stdout.write("integration document worker real compile smoke passed\n");
