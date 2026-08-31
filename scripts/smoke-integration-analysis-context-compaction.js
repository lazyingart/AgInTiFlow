import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import {
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import { createTestOnlyIntegrationAnalysisVisionClient } from "../src/integration-analysis-vision.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";

const PRINCIPAL_ID = "principal-compaction-0001";
const BROWSER_SESSION_ID = "d".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const DURABLE_RULE = "DURABLE_RULE_KEEP_REPORTS_CONCISE_7d14";

function context() {
  return Object.freeze({ principalId: PRINCIPAL_ID, browserSessionId: BROWSER_SESSION_ID });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([0, 26, 43, 60, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createRunner() {
  const calls = [];
  return Object.freeze({
    calls,
    async run(scope, input, options = {}) {
      calls.push(Object.freeze({
        runId: scope.runId,
        prompt: input.prompt,
        conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
        visionEvidence: input.visionEvidence,
      }));
      const result = Object.freeze({
        schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
        text: `Completed ${calls.length}.`,
        kind: "direct",
        toolCalls: 0,
        executionStatus: null,
        artifacts: Object.freeze([]),
      });
      await options.onFinal?.(result);
      return result;
    },
  });
}

async function stateFile(stateRoot) {
  const scopes = await fs.readdir(path.join(stateRoot, "scopes"));
  assert.equal(scopes.length, 1);
  return path.join(stateRoot, "scopes", scopes[0], "state.json");
}

async function stateEnvelope(stateRoot) {
  return JSON.parse(await fs.readFile(await stateFile(stateRoot), "utf8"));
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-compaction-"));
  const stateRoot = path.join(temporaryRoot, "state");
  const runner = createRunner();
  const visionCalls = [];
  const visionClient = createTestOnlyIntegrationAnalysisVisionClient({
    async describe(scope, input) {
      visionCalls.push(Object.freeze({
        runId: scope.runId,
        referenceIds: Object.freeze(input.attachments.map((attachment) => attachment.referenceId)),
      }));
      return Object.freeze({
        summary: "A tiny retained image is visible.",
        visibleText: Object.freeze([]),
        observations: Object.freeze(["The same image remains available after compaction."]),
        issues: Object.freeze([]),
        answer: "Use the retained image as visual context.",
        uncertainty: Object.freeze([]),
      });
    },
  });
  const visionActivation = await visionClient.activate();
  const serviceOptions = Object.freeze({
    analysisRunner: runner,
    stateRoot,
    visionClient,
    visionActivation,
  });
  let service = createTestOnlyIntegrationAnalysisSessionService(serviceOptions);
  try {
    const created = await service.createThread({ title: "Durable compaction" }, context());
    const threadId = created.thread.id;
    const runIds = [];
    const compactionRunIds = [];
    let priorRunId = null;
    for (let index = 0; index < 130; index += 1) {
      const text = index === 0
        ? `${DURABLE_RULE}. Apply this instruction to every later answer.`
        : `Continue durable turn ${index + 1}.`;
      const started = priorRunId === null
        ? await service.startRun({
            threadId,
            input: {
              text,
              attachments: [{
                attachmentId: "compaction-image-0001",
                mediaType: "image/png",
                data: onePixelPng().toString("base64"),
              }],
            },
          }, context())
        : await service.resumeRun({ runId: priorRunId, input: { text } }, context());
      priorRunId = started.run.id;
      runIds.push(priorRunId);
      await service.waitForIdle();
      const eventResult = await service.loadRunEvents(
        { runId: priorRunId, afterSeq: 0, afterHash: ZERO_DIGEST },
        context()
      );
      const events = await eventResult.publicEventLedger.loadEventsAfter(0);
      if (events.some((event) => event.type === "context.compacted")) {
        compactionRunIds.push(priorRunId);
      }
    }

    const publicThread = (await service.getThread({ threadId }, context())).thread;
    assert.ok(compactionRunIds.length >= 2, "repeated compaction was not product-reachable");
    assert.ok(publicThread.replay.prunedMessageCount > 0);
    assert.notEqual(publicThread.replay.anchorDigest, ZERO_DIGEST);
    assert.ok(publicThread.authority.lastCompaction.compactedMessages > 0);
    assert.ok(
      publicThread.authority.lastCompaction.tokensAfter <=
        publicThread.authority.lastCompaction.tokensBefore
    );
    assert.ok(publicThread.messages.length < 160, "retained replay suffix is not bounded");
    assert.equal(Object.prototype.hasOwnProperty.call(publicThread, "compaction"), false);
    assert.equal(publicThread.activeImageContext, true);
    assert.equal(visionCalls.length, 130);
    assert.ok(
      runner.calls.at(-1).conversation.some((message) => message.content.includes(DURABLE_RULE)),
      "anchored long-term instruction was not supplied to the planner"
    );

    const persisted = await stateEnvelope(stateRoot);
    const privateThread = persisted.state.threads.find((thread) => thread.id === threadId);
    assert(privateThread.compaction, "private durable compaction memory is missing");
    assert.equal(privateThread.compaction.activeImage.runId, runIds[0]);
    assert.equal(privateThread.compaction.activeImage.attachments.length, 1);
    assert.equal(privateThread.compaction.totalCompactedMessages, publicThread.replay.prunedMessageCount);
    assert.ok(privateThread.compaction.memory.some((message) => message.content.includes(DURABLE_RULE)));
    assert.equal(privateThread.compaction.digest.length, 64);

    await service.close({ mode: "wait" });
    service = createTestOnlyIntegrationAnalysisSessionService(serviceOptions);
    const reopened = (await service.getThread({ threadId }, context())).thread;
    assert.deepEqual(reopened, publicThread, "compacted public replay changed across restart");
    assert.equal(
      (await service.getRunStatus({ runId: runIds[0] }, context())).run.status,
      "completed",
      "a compacted historical run was no longer addressable"
    );
    await assert.rejects(
      service.resumeRun({ runId: runIds[0] }, context()),
      (error) => error?.code === "ANALYSIS_RUN_NOT_RESUMABLE",
      "an input-less retry of a compacted non-head run must be a public conflict, not state corruption"
    );

    const edited = await service.resumeRun({
      runId: runIds[0],
      input: { text: "Create a new branch from this old compacted run while retaining the durable rule." },
    }, context());
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: edited.run.id }, context())).run.status, "completed");
    assert.ok(runner.calls.at(-1).conversation.some((message) => message.content.includes(DURABLE_RULE)));
    assert.equal(
      runner.calls.at(-1).conversation.some((message) => message.content.includes("durable turn 130")),
      false,
      "an old-run branch inherited unrelated later branch context"
    );

    const exactRetry = await service.resumeRun({ runId: edited.run.id, reuseAttachments: true }, context());
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: exactRetry.run.id }, context())).run.status, "completed");
    const replacement = await service.resumeRun({
      runId: exactRetry.run.id,
      input: {
        text: "Use this replacement image only on the new branch.",
        attachments: [{
          attachmentId: "compaction-image-replacement-0002",
          mediaType: "image/png",
          data: onePixelPng().toString("base64"),
        }],
      },
    }, context());
    await service.waitForIdle();
    const visionCallsBeforeStaleBranch = visionCalls.length;
    const staleBranch = await service.resumeRun({
      runId: runIds[0],
      input: { text: "Branch from the original run without borrowing a sibling image." },
    }, context());
    await service.waitForIdle();
    assert.equal(
      visionCalls.length,
      visionCallsBeforeStaleBranch,
      "an old branch borrowed the newer sibling branch image"
    );
    assert.equal(runner.calls.at(-1).visionEvidence, undefined);
    const finalThread = (await service.getThread({ threadId }, context())).thread;
    assert.equal(finalThread.lastRunId, staleBranch.run.id);
    assert.equal(Object.prototype.hasOwnProperty.call(finalThread, "activeImageContext"), false);
    assert.ok(finalThread.replay.prunedMessageCount >= reopened.replay.prunedMessageCount);

    await service.close({ mode: "wait" });
    const cleanEnvelope = await stateEnvelope(stateRoot);
    const publicMetadataTamper = structuredClone(cleanEnvelope);
    publicMetadataTamper.state.threads.find(
      (thread) => thread.id === threadId
    ).authority.lastCompaction.tokensAfter += 1;
    publicMetadataTamper.digest = contractDigest({
      schemaVersion: publicMetadataTamper.schemaVersion,
      state: publicMetadataTamper.state,
    });
    await fs.writeFile(
      await stateFile(stateRoot),
      `${canonicalJson(publicMetadataTamper)}\n`,
      { mode: 0o600 }
    );
    service = createTestOnlyIntegrationAnalysisSessionService(serviceOptions);
    await assert.rejects(
      service.getThread({ threadId }, context()),
      (error) => error?.code === "ANALYSIS_STATE_CORRUPT",
      "a forged public lastCompaction counter was accepted"
    );
    await service.close({ mode: "abort" }).catch(() => {});

    const anchorTamper = structuredClone(cleanEnvelope);
    anchorTamper.state.threads.find((thread) => thread.id === threadId).replay.anchorDigest = "f".repeat(64);
    anchorTamper.digest = contractDigest({ schemaVersion: anchorTamper.schemaVersion, state: anchorTamper.state });
    await fs.writeFile(await stateFile(stateRoot), `${canonicalJson(anchorTamper)}\n`, { mode: 0o600 });
    service = createTestOnlyIntegrationAnalysisSessionService(serviceOptions);
    await assert.rejects(
      service.getThread({ threadId }, context()),
      (error) => error?.code === "ANALYSIS_STATE_CORRUPT",
      "a replay-anchor tamper with a recomputed outer digest was accepted"
    );

    console.log("smoke-integration-analysis-context-compaction ok");
  } finally {
    await service.close({ mode: "abort" }).catch(() => {});
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
