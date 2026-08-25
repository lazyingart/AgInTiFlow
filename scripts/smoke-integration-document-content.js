#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { sanitizeIntegrationArtifact } from "../src/integration-artifacts.js";
import {
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import {
  INTEGRATION_TEX_TOOL_NAME,
  compileIntegrationTexDocument,
} from "../src/integration-tex-compiler.js";

const PRINCIPAL = "principal_document_content_smoke";
const OTHER_PRINCIPAL = "principal_document_content_other";
const BROWSER = "d".repeat(64);
const CONTEXT = Object.freeze({ principalId: PRINCIPAL, browserSessionId: BROWSER });
const OTHER_CONTEXT = Object.freeze({ principalId: OTHER_PRINCIPAL, browserSessionId: BROWSER });
const OTHER_BROWSER_CONTEXT = Object.freeze({ principalId: PRINCIPAL, browserSessionId: "e".repeat(64) });
const PROMPT = "Create a LaTeX report and deliver both report.tex and report.pdf.";
const FOLLOWUP = "Revise the TeX source and recompile the PDF with a second paragraph.";
const CONTEXTUAL_FOLLOWUP = "Make the title bigger and regenerate the files.";
const execFileAsync = promisify(execFile);

function runner() {
  let calls = 0;
  return Object.freeze({
    async run(_scope, input, options) {
      calls += 1;
      await options.onProgress?.({ phase: "planning", toolCallsCompleted: 0 });
      if (calls === 2 || calls === 3) {
        assert.equal(
          input.prompt,
          calls === 2 ? FOLLOWUP : CONTEXTUAL_FOLLOWUP,
          "resume dispatched the exact current follow-up turn"
        );
        assert(input.conversation.some(({ role, content }) => role === "assistant" && /TeX source/u.test(content)));
      }
      await options.onProgress?.({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: INTEGRATION_TEX_TOOL_NAME,
        toolCallNumber: 1,
        executionState: "running",
      });
      const compiled = await compileIntegrationTexDocument({
        filename: calls === 2 ? "report-revised.tex" : calls === 3 ? "report-retitled.tex" : "report.tex",
        source: [
          "\\documentclass{article}",
          "\\begin{document}",
          "Truthful private document artifact.",
          ...(calls === 2 ? ["", "This is the requested second paragraph."] : []),
          ...(calls === 3 ? ["", "\\section*{A Larger Title}"] : []),
          "\\end{document}",
          "",
        ].join("\n"),
      }, { signal: options.signal });
      for (const artifact of compiled.artifacts) await options.onArtifact?.(artifact);
      await options.onProgress?.({
        phase: "synthesizing",
        toolCallsCompleted: 1,
        executionSucceeded: true,
        artifactCount: compiled.artifacts.length,
      });
      const result = Object.freeze({
        schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
        text: calls === 2
          ? "Recompiled the revised TeX source and PDF."
          : calls === 3
            ? "Regenerated the retitled TeX source and PDF."
            : "Created the requested TeX source and PDF.",
        kind: "analysis",
        toolCalls: 1,
        executionStatus: "succeeded",
        artifacts: Object.freeze(compiled.artifacts.map((artifact) => sanitizeIntegrationArtifact(artifact))),
      });
      await options.onFinal?.(result);
      return result;
    },
  });
}

async function completedRun(service, threadId, prompt = PROMPT, previousRunId = "") {
  const started = previousRunId
    ? await service.resumeRun({ runId: previousRunId, input: { text: prompt } }, CONTEXT)
    : await service.startRun({ threadId, input: { text: prompt } }, CONTEXT);
  await service.waitForIdle();
  const status = await service.getRunStatus({ runId: started.run.id }, CONTEXT);
  assert.equal(status.run.status, "completed", status.run.error?.message);
  return status.run;
}

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-content-smoke-"));
let service;
try {
  const trustedRunner = runner();
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: trustedRunner, stateRoot });
  const firstThread = (await service.createThread({ title: "Private documents" }, CONTEXT)).thread;
  const firstRun = await completedRun(service, firstThread.id);
  const firstArtifacts = (await service.listArtifacts({ threadId: firstThread.id, runId: "" }, CONTEXT)).artifacts;
  assert.deepEqual(firstArtifacts.map(({ kind }) => kind), ["file", "file"]);
  assert(firstArtifacts.every((artifact) => Object.keys(artifact.spec).join(",") === "schemaVersion,filename,mime,bytes,sha256"));
  assert.doesNotMatch(JSON.stringify(firstArtifacts), /(?:blobRef|privateBytes|contentBytes|receiptId|\/tmp\/)/u);
  const stateEnvelopePath = path.join(
    stateRoot,
    "scopes",
    (await fs.readdir(path.join(stateRoot, "scopes")))[0],
    "state.json"
  );
  const initialEnvelope = JSON.parse(await fs.readFile(stateEnvelopePath, "utf8"));
  const blobDirectory = path.join(path.dirname(stateEnvelopePath), "document-blobs");
  assert.equal((await fs.stat(blobDirectory)).mode & 0o777, 0o700);
  for (const artifact of initialEnvelope.state.artifacts.filter(({ kind }) => kind === "file")) {
    const stat = await fs.lstat(path.join(blobDirectory, artifact.blobRef));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
  }
  const sourceArtifact = firstArtifacts.find(({ spec }) => spec.filename.endsWith(".tex"));
  const pdfArtifact = firstArtifacts.find(({ spec }) => spec.filename.endsWith(".pdf"));
  const eventResult = await service.loadRunEvents({
    runId: firstRun.id,
    afterSeq: 0,
    afterHash: "0".repeat(64),
  }, CONTEXT);
  const artifactEvents = (await eventResult.publicEventLedger.loadEventsAfter(0))
    .filter(({ type }) => type === "artifact.created");
  assert.equal(artifactEvents.length, 2);
  assert(artifactEvents.every(({ payload }) => /^[a-f0-9]{64}$/u.test(payload.receiptDigest)));
  assert.doesNotMatch(JSON.stringify(artifactEvents), /(?:privateBytes|contentBytes|blobRef|receiptId|\/tmp\/)/u);
  const firstRunEvents = await eventResult.publicEventLedger.loadEventsAfter(0);
  const texStarted = firstRunEvents.find(({ type }) => type === "tool.started");
  const texCompleted = firstRunEvents.find(({ type }) => type === "tool.completed");
  assert.equal(texStarted.payload.publicLabel, "TeX document compiler");
  assert.equal(texCompleted.payload.publicSummary, "TeX source and PDF compiled.");

  const metadata = await service.getArtifactContent({ artifactId: pdfArtifact.id, metadataOnly: true }, CONTEXT);
  assert.equal(metadata.content, null);
  assert.equal(metadata.totalBytes, pdfArtifact.spec.bytes);
  const range = await service.getArtifactContent({
    artifactId: pdfArtifact.id,
    range: { start: 1, end: 7 },
  }, CONTEXT);
  assert.equal(range.partial, true);
  assert.equal(range.content.byteLength, 7);
  await assert.rejects(
    service.getArtifactContent({ artifactId: pdfArtifact.id }, OTHER_CONTEXT),
    (error) => error?.code === "NOT_FOUND" && error?.status === 404
  );
  await assert.rejects(
    service.getArtifactContent({ artifactId: pdfArtifact.id }, OTHER_BROWSER_CONTEXT),
    (error) => error?.code === "NOT_FOUND" && error?.status === 404
  );
  await assert.rejects(
    service.getArtifactContent({ artifactId: pdfArtifact.id, range: { start: pdfArtifact.spec.bytes } }, CONTEXT),
    (error) => error?.code === "RANGE_NOT_SATISFIABLE" && error?.status === 416
  );
  await assert.rejects(
    service.getArtifactContent({
      artifactId: pdfArtifact.id,
      range: { start: Number.MAX_SAFE_INTEGER },
    }, CONTEXT),
    (error) => error?.code === "RANGE_NOT_SATISFIABLE" && error?.status === 416,
    "a large but valid browser range preserves 416 semantics instead of becoming a protocol 400"
  );
  await assert.rejects(
    service.getArtifactContent({ artifactId: pdfArtifact.id, metadataOnly: "yes" }, CONTEXT),
    (error) => error?.code === "INVALID_REQUEST" && error?.status === 400
  );

  const followupRun = await completedRun(service, firstThread.id, FOLLOWUP, firstRun.id);
  assert.equal(followupRun.previousRunId, firstRun.id);
  const revisedArtifacts = (await service.listArtifacts({ runId: followupRun.id, threadId: "" }, CONTEXT)).artifacts;
  assert.deepEqual(revisedArtifacts.map(({ spec }) => spec.filename), ["report-revised.tex", "report-revised.pdf"]);
  const contextualFollowupRun = await completedRun(
    service,
    firstThread.id,
    CONTEXTUAL_FOLLOWUP,
    followupRun.id
  );
  assert.equal(contextualFollowupRun.previousRunId, followupRun.id);
  const retitledArtifacts = (
    await service.listArtifacts({ runId: contextualFollowupRun.id, threadId: "" }, CONTEXT)
  ).artifacts;
  assert.deepEqual(retitledArtifacts.map(({ spec }) => spec.filename), ["report-retitled.tex", "report-retitled.pdf"]);

  await service.close({ mode: "wait", timeoutMs: 5_000 });
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: trustedRunner, stateRoot });
  const replayed = await service.getArtifactContent({ artifactId: sourceArtifact.id }, CONTEXT);
  assert.match(replayed.content.toString("utf8"), /Truthful private document artifact/u);

  const retainedThread = (await service.createThread({ title: "Retained document" }, CONTEXT)).thread;
  await completedRun(service, retainedThread.id);
  const retainedArtifacts = (await service.listArtifacts({ threadId: retainedThread.id, runId: "" }, CONTEXT)).artifacts;
  const retainedSource = retainedArtifacts.find(({ spec }) => spec.filename.endsWith(".tex"));
  const retainedPdf = retainedArtifacts.find(({ spec }) => spec.filename.endsWith(".pdf"));
  const beforeDelete = JSON.parse(await fs.readFile(stateEnvelopePath, "utf8"));
  const retainedSourceRecord = beforeDelete.state.artifacts.find(({ id }) => id === retainedSource.id);
  const retainedSourcePath = path.join(blobDirectory, retainedSourceRecord.blobRef);
  const hardlinkPath = `${retainedSourcePath}.hardlink`;
  await fs.link(retainedSourcePath, hardlinkPath);
  try {
    await assert.rejects(
      service.getArtifactContent({ artifactId: retainedSource.id }, CONTEXT),
      (error) => error?.code === "ANALYSIS_BLOB_CORRUPT"
    );
  } finally {
    await fs.unlink(hardlinkPath);
  }
  const displacedPath = `${retainedSourcePath}.displaced`;
  await fs.rename(retainedSourcePath, displacedPath);
  try {
    await fs.symlink(displacedPath, retainedSourcePath);
    await assert.rejects(
      service.getArtifactContent({ artifactId: retainedSource.id }, CONTEXT),
      (error) => error?.code === "ANALYSIS_BLOB_CORRUPT"
    );
  } finally {
    await fs.unlink(retainedSourcePath).catch(() => {});
    await fs.rename(displacedPath, retainedSourcePath);
  }
  await fs.rename(retainedSourcePath, displacedPath);
  try {
    await execFileAsync("/usr/bin/mkfifo", [retainedSourcePath]);
    await assert.rejects(
      service.getArtifactContent({ artifactId: retainedSource.id }, CONTEXT),
      (error) => error?.code === "ANALYSIS_BLOB_CORRUPT"
    );
  } finally {
    await fs.unlink(retainedSourcePath).catch(() => {});
    await fs.rename(displacedPath, retainedSourcePath);
  }
  assert.match(
    (await service.getArtifactContent({ artifactId: retainedSource.id }, CONTEXT)).content.toString("utf8"),
    /Truthful private document artifact/u
  );
  const removedBlobRefs = beforeDelete.state.artifacts
    .filter(({ threadId }) => threadId === firstThread.id)
    .map(({ blobRef }) => blobRef);
  const firstSourceRecord = beforeDelete.state.artifacts.find(({ id }) => id === sourceArtifact.id);
  const firstSourcePath = path.join(blobDirectory, firstSourceRecord.blobRef);
  const deletionBlockerPath = `${firstSourcePath}.hardlink`;
  await fs.link(firstSourcePath, deletionBlockerPath);
  try {
    await assert.rejects(
      service.deleteThread({ threadId: firstThread.id }, CONTEXT),
      (error) => error?.code === "ANALYSIS_BLOB_CORRUPT",
      "a private-byte unlink failure must fail before deleting the only durable blob reference"
    );
    assert.equal(
      (await service.getThread({ threadId: firstThread.id }, CONTEXT)).thread.id,
      firstThread.id,
      "failed byte deletion keeps chat metadata available for a safe retry"
    );
  } finally {
    await fs.unlink(deletionBlockerPath);
  }

  await service.deleteThread({ threadId: firstThread.id }, CONTEXT);
  await assert.rejects(
    service.getArtifactContent({ artifactId: sourceArtifact.id }, CONTEXT),
    (error) => error?.code === "NOT_FOUND" && error?.status === 404
  );
  for (const blobRef of removedBlobRefs) {
    await assert.rejects(
      fs.lstat(path.join(path.dirname(stateEnvelopePath), "document-blobs", blobRef)),
      (error) => error?.code === "ENOENT",
      "thread deletion unlinked only its owned local blob"
    );
  }
  const retainedContent = await service.getArtifactContent({ artifactId: retainedPdf.id }, CONTEXT);
  assert.equal(retainedContent.content.byteLength, retainedPdf.spec.bytes, "deleting one thread did not remove another blob");
  const envelope = JSON.parse(await fs.readFile(stateEnvelopePath, "utf8"));
  const privateRecord = envelope.state.artifacts.find(({ id }) => id === retainedPdf.id);
  await fs.unlink(path.join(path.dirname(stateEnvelopePath), "document-blobs", privateRecord.blobRef));
  await assert.rejects(
    service.getArtifactContent({ artifactId: retainedPdf.id }, CONTEXT),
    (error) => error?.code === "ARTIFACT_CONTENT_GONE" && error?.status === 410
  );
} finally {
  await service?.close({ mode: "abort", timeoutMs: 5_000 }).catch(() => {});
  await fs.rm(stateRoot, { recursive: true, force: true });
}

console.log("integration document content smoke passed");
