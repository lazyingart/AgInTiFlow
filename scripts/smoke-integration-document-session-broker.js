import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import { classifyIntegrationDocumentArtifactIntent } from "../src/integration-document-artifacts.js";
import { canonicalJson, contractDigest } from "../src/integration-policy.js";
import { compileRequirements, createDocumentWorkerFixture } from "./test-document-worker-fixture.js";

const PRINCIPAL_ID = "principal-document-session-smoke";
const BROWSER_SESSION_ID = "d".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const PRODUCTION_PROMPT = "Write a latex of qaoa compile and give me link of pdf with figures";
const NORMAL_FOLLOW_UP = "What is 2 + 2?";
const REVISE_FOLLOW_UP = "revise the previous TeX document and recompile";
const CANCEL_PROMPT = "Create a LaTeX report and PDF, but pause during artifact capture.";
const INTERRUPT_PROMPT = "Create a LaTeX report and PDF, then simulate an interruption before commit.";
const AFTER_COMMIT_PROMPT = "Create a LaTeX report and PDF, then simulate a crash after worker commit.";
const AFTER_FINAL_PROMPT = "Create a LaTeX report and PDF, then simulate a crash after file events.";
const CANCEL_AFTER_PAIR_PROMPT = "Create a LaTeX report and PDF, then pause after the paired capture.";
const CANCEL_AFTER_WORKER_COMMIT_PROMPT =
  "Create a LaTeX report and PDF, then pause after an ambiguous worker commit.";
const CANCEL_AFTER_FINAL_ACK_PROMPT =
  "Create a LaTeX report and PDF, then pause after publishing the committed files.";
const EXPIRED_STAGED_PAIR_PROMPT =
  "Create a LaTeX report and PDF, then simulate an authoritatively expired staged pair.";
const SOURCE_MARKER = "CLOUD_MUST_NOT_PERSIST_DOCUMENT_SOURCE_7c82a1";

function context() {
  return Object.freeze({ principalId: PRINCIPAL_ID, browserSessionId: BROWSER_SESSION_ID });
}

function eventsRequest(runId) {
  return Object.freeze({ runId, afterSeq: 0, afterHash: ZERO_DIGEST });
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

async function waitFor(promise, label, timeoutMs = 2_000) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function persistedState(stateRoot) {
  const entries = await fs.readdir(path.join(stateRoot, "scopes"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}$/u);
  const bytes = await fs.readFile(path.join(stateRoot, "scopes", entries[0], "state.json"), "utf8");
  return Object.freeze({ bytes, envelope: JSON.parse(bytes) });
}

function legacyV2Envelope(envelope, { unsafeFile = null } = {}) {
  const state = {
    ...envelope.state,
    schemaVersion: "aginti-integration-analysis-state-v2",
  };
  delete state.documentCommitIntents;
  delete state.documentDeletionIntents;
  if (unsafeFile) state.artifacts = [...state.artifacts, unsafeFile];
  const unsigned = {
    schemaVersion: "aginti-integration-analysis-state-v2",
    state,
  };
  return { ...unsigned, digest: contractDigest(unsigned) };
}

function texSource(scope, figureRequired) {
  return [
    "\\documentclass{article}",
    "\\usepackage{tikz}",
    "\\begin{document}",
    `\\section*{Bounded document ${scope.runId.slice(-8)}}`,
    SOURCE_MARKER,
    ...(figureRequired
      ? [
          "\\begin{figure}",
          "\\centering",
          "\\begin{tikzpicture}",
          "\\draw[->] (0,0) -- (2,0);",
          "\\draw[->] (0,0) -- (0,2);",
          "\\draw (0,0) -- (1,1) -- (2,1.5);",
          "\\end{tikzpicture}",
          "\\caption{A self-contained illustrative curve.}",
          "\\end{figure}",
        ]
      : []),
    "\\end{document}",
    "",
  ].join("\n");
}

function directResult(text = "The answer is 4.") {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text,
    kind: "direct",
    toolCalls: 0,
    executionStatus: null,
    artifacts: Object.freeze([]),
  });
}

function documentResult(artifacts) {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text: "The TeX source and compiled PDF are ready.",
    kind: "analysis",
    toolCalls: 1,
    executionStatus: "succeeded",
    artifacts: Object.freeze([...artifacts]),
  });
}

function createDocumentRunner(fixture, client, controls = {}) {
  const calls = [];
  const runner = Object.freeze({
    calls,
    async run(scope, input, options) {
      calls.push(Object.freeze({
        scope: Object.freeze({ ...scope }),
        prompt: input.prompt,
        conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
      }));
      const intent = classifyIntegrationDocumentArtifactIntent(input.prompt, input.conversation);
      if (!intent.required) {
        const result = directResult();
        await options.onFinal?.(result);
        return result;
      }
      const source = texSource(scope, intent.requirements.minimumFigureCount > 0);
      const compiled = await client.compile(
        scope,
        {
          filename: `document-${scope.runId.slice(-8)}.tex`,
          source,
          requirements: compileRequirements(intent.requirements.minimumFigureCount),
        },
        { signal: options.signal }
      );
      await options.onArtifact?.(compiled.artifacts[0]);
      if (input.prompt === CANCEL_PROMPT) {
        controls.firstCapture?.resolve();
        await controls.releaseSecondCapture?.promise;
        await options.onArtifact?.(compiled.artifacts[1]);
        throw new Error("A cancelled run unexpectedly retained second-capture authority.");
      }
      await options.onArtifact?.(compiled.artifacts[1]);
      const authorized = await options.onDocumentCommitIntent?.(compiled.artifacts);
      assert.equal(authorized, true);
      if (input.prompt === EXPIRED_STAGED_PAIR_PROMPT) fixture.staged.clear();
      if (input.prompt === CANCEL_AFTER_PAIR_PROMPT) {
        controls.pairAuthorized?.resolve();
        await controls.releasePairCommit?.promise;
        if (options.signal?.aborted) throw options.signal.reason || new Error("cancelled after pair");
      }
      if (input.prompt === PRODUCTION_PROMPT && controls.holdProduction) {
        fixture.setAvailable(false);
        controls.productionAuthorized.resolve();
        await controls.releaseProduction.promise;
        fixture.setAvailable(true);
      }
      if (input.prompt === INTERRUPT_PROMPT) {
        fixture.setAvailable(false);
        throw Object.assign(new Error("simulated broker interruption"), {
          code: "ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE",
          publicCode: "ANALYSIS_DOCUMENT_WORKER_UNAVAILABLE",
        });
      }
      await client.commitArtifacts(
        scope,
        { receiptDigest: compiled.receipt.digest, artifacts: compiled.artifacts },
        { signal: options.signal }
      );
      if (input.prompt === CANCEL_AFTER_WORKER_COMMIT_PROMPT) {
        controls.workerCommitted?.resolve();
        await controls.releaseWorkerCommit?.promise;
        if (options.signal?.aborted) throw options.signal.reason || new Error("cancelled after worker commit");
      }
      if (input.prompt === AFTER_COMMIT_PROMPT) {
        throw new Error("simulated crash after worker commit before session ACK");
      }
      const result = documentResult(compiled.artifacts);
      await options.onFinal?.(result);
      if (input.prompt === CANCEL_AFTER_FINAL_ACK_PROMPT) {
        controls.finalAcknowledged?.resolve();
        await controls.releaseFinalAck?.promise;
        if (options.signal?.aborted) throw options.signal.reason || new Error("cancelled after final ACK");
      }
      if (input.prompt === AFTER_FINAL_PROMPT) {
        throw new Error("simulated crash after session ACK before runner return");
      }
      return result;
    },
  });
  return runner;
}

async function committedContinuationRoundTrip(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "committed-continuation");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const controls = {
    holdProduction: true,
    productionAuthorized: deferred(),
    releaseProduction: deferred(),
  };
  const runner = createDocumentRunner(fixture, client, controls);
  const service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  try {
    const capabilities = await service.getIntegrationCapabilities();
    assert.equal(capabilities.files, true);
    const thread = await service.createThread({ title: "Document continuation" }, context());
    const started = await service.startRun(
      { threadId: thread.thread.id, input: { text: PRODUCTION_PROMPT } },
      context()
    );
    await waitFor(
      Promise.race([
        controls.productionAuthorized.promise,
        service.waitForIdle().then(async () => {
          const failed = (await service.getRunStatus({ runId: started.run.id }, context())).run;
          throw new Error(`Document runner stopped before commit authority: ${failed.error?.code || failed.status}`);
        }),
      ]),
      "durable paired commit intent"
    );

    const pendingEventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const pendingEvents = await pendingEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(pendingEvents.some(({ type }) => type === "artifact.created"), false);
    assert.equal(pendingEvents.some(({ type }) => type === "run.completed"), false);
    assert.deepEqual((await service.listArtifacts({ runId: started.run.id }, context())).artifacts, []);
    const pending = await persistedState(stateRoot);
    assert.equal(pending.envelope.state.documentCommitIntents.length, 1);
    assert.equal(pending.envelope.state.documentCommitIntents[0].status, "pending");
    assert.equal(pending.envelope.state.documentCommitIntents[0].eventsPublished, false);
    assert.equal(pending.envelope.state.artifacts.filter(({ kind }) => kind === "file").length, 2);
    assert.doesNotMatch(pending.bytes, new RegExp(SOURCE_MARKER, "u"));
    assert.doesNotMatch(pending.bytes, /%PDF-/u);
    assert.doesNotMatch(pending.bytes, /(?:privateBytes|contentBytes|blobRef|\/var\/lib\/aginti-document-worker)/u);

    controls.releaseProduction.resolve();
    await service.waitForIdle();
    const completed = (await service.getRunStatus({ runId: started.run.id }, context())).run;
    assert.equal(completed.status, "completed", JSON.stringify(completed.error));
    const completeEventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const completeEvents = await completeEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(completeEvents.filter(({ type }) => type === "artifact.created").length, 2);
    assert.equal(completeEvents.filter(({ type }) => type === "run.completed").length, 1);
    assert.ok(
      completeEvents.findIndex(({ type }) => type === "artifact.created") <
        completeEvents.findIndex(({ type }) => type === "run.completed")
    );
    const files = (await service.listArtifacts({ runId: started.run.id }, context())).artifacts;
    assert.deepEqual(files.map(({ kind }) => kind), ["file", "file"]);
    assert.deepEqual(files.map(({ spec }) => spec.mime), ["application/x-tex", "application/pdf"]);
    const compileCallsAfterFirst = fixture.calls.filter(({ pathname }) => pathname === "/artifact/v1/compile");
    assert.equal(compileCallsAfterFirst.length, 1);
    assert.equal(compileCallsAfterFirst[0].request.requirements.minimumFigureCount, 1);

    const normal = await service.startRun(
      { threadId: thread.thread.id, input: { text: NORMAL_FOLLOW_UP } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: normal.run.id }, context())).run.status, "completed");
    assert.equal(
      fixture.calls.filter(({ pathname }) => pathname === "/artifact/v1/compile").length,
      1,
      "an unrelated same-thread question must remain ordinary chat"
    );

    const revised = await service.startRun(
      { threadId: thread.thread.id, input: { text: REVISE_FOLLOW_UP } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: revised.run.id }, context())).run.status, "completed");
    const compileCalls = fixture.calls.filter(({ pathname }) => pathname === "/artifact/v1/compile");
    assert.equal(compileCalls.length, 2);
    assert.equal(compileCalls[1].request.requirements.minimumFigureCount, 1);
    assert.equal((await service.listArtifacts({ runId: revised.run.id }, context())).artifacts.length, 2);
  } finally {
    controls.releaseProduction.resolve();
    fixture.setAvailable(true);
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function cancellationBeforePairedCaptureRoundTrip(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "cancel-before-pair");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const controls = { firstCapture: deferred(), releaseSecondCapture: deferred() };
  const runner = createDocumentRunner(fixture, client, controls);
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  try {
    const thread = await service.createThread({ title: "Cancellation race" }, context());
    const started = await service.startRun(
      { threadId: thread.thread.id, input: { text: CANCEL_PROMPT } },
      context()
    );
    await waitFor(controls.firstCapture.promise, "first document callback");
    const cancelled = await service.cancelRun({ runId: started.run.id }, context());
    assert.equal(cancelled.run.status, "cancelled");
    controls.releaseSecondCapture.resolve();
    await service.waitForIdle();
    const eventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(events.some(({ type }) => type === "artifact.created"), false);
    assert.equal(events.some(({ type }) => type === "run.completed"), false);
    assert.equal(fixture.calls.some(({ pathname }) => pathname === "/artifact/v1/commit"), false);
    const state = await persistedState(stateRoot);
    assert.equal(state.envelope.state.artifacts.length, 0);
    assert.equal(state.envelope.state.documentCommitIntents.length, 0);
    await service.close({ mode: "wait" });

    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    assert.equal((await service.getRunStatus({ runId: started.run.id }, context())).run.status, "cancelled");
    assert.equal(fixture.calls.some(({ pathname }) => pathname === "/artifact/v1/commit"), false);
  } finally {
    controls.releaseSecondCapture.resolve();
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function cancellationAfterPairedCaptureDeletesWorkerGroup(temporaryRoot) {
  for (const [label, prompt, reachedKey, releaseKey] of [
    ["cancel-after-pair", CANCEL_AFTER_PAIR_PROMPT, "pairAuthorized", "releasePairCommit"],
    [
      "cancel-after-ambiguous-commit",
      CANCEL_AFTER_WORKER_COMMIT_PROMPT,
      "workerCommitted",
      "releaseWorkerCommit",
    ],
  ]) {
    const stateRoot = path.join(temporaryRoot, label);
    const fixture = createDocumentWorkerFixture();
    const client = fixture.client();
    const controls = { [reachedKey]: deferred(), [releaseKey]: deferred() };
    const runner = createDocumentRunner(fixture, client, controls);
    let service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    try {
      const thread = await service.createThread({ title: label }, context());
      const started = await service.startRun({ threadId: thread.thread.id, input: { text: prompt } }, context());
      await waitFor(controls[reachedKey].promise, label);
      const before = await persistedState(stateRoot);
      assert.equal(before.envelope.state.artifacts.length, 2);
      assert.equal(before.envelope.state.documentCommitIntents.length, 1);
      assert.equal(before.envelope.state.documentCommitIntents[0].status, "pending");

      const cancelled = await service.cancelRun({ runId: started.run.id }, context());
      assert.equal(cancelled.run.status, "cancelled");
      controls[releaseKey].resolve();
      await service.waitForIdle();
      const after = await persistedState(stateRoot);
      assert.equal(after.envelope.state.artifacts.length, 0);
      assert.equal(after.envelope.state.documentCommitIntents.length, 0);
      assert.equal(after.envelope.state.documentDeletionIntents.length, 0);
      assert.equal(fixture.tombstoned.size, 2);
      assert.equal(
        fixture.calls.filter(({ pathname, request }) =>
          pathname === "/artifact/v1/delete" && request.phase === "prepare"
        ).length,
        1
      );
      assert.equal(
        fixture.calls.filter(({ pathname, request }) =>
          pathname === "/artifact/v1/delete" && request.phase === "commit"
        ).length,
        1
      );
      if (prompt === CANCEL_AFTER_PAIR_PROMPT) {
        assert.equal(fixture.calls.some(({ pathname }) => pathname === "/artifact/v1/commit"), false);
      } else {
        assert.equal(fixture.calls.filter(({ pathname }) => pathname === "/artifact/v1/commit").length, 1);
      }
      const eventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
      const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
      assert.equal(events.some(({ type }) => type === "artifact.created"), false);
      assert.equal(events.filter(({ type }) => type === "run.cancelled").length, 1);
      const ordinary = await service.startRun(
        { threadId: thread.thread.id, input: { text: "What is 3 + 3?" } },
        context()
      );
      await service.waitForIdle();
      assert.equal((await service.getRunStatus({ runId: ordinary.run.id }, context())).run.status, "completed");
      await service.close({ mode: "wait" });

      service = createTestOnlyIntegrationAnalysisSessionService({
        analysisRunner: runner,
        stateRoot,
        documentWorkerClient: client,
        documentWorkerEnabled: true,
      });
      assert.equal((await service.getRunStatus({ runId: started.run.id }, context())).run.status, "cancelled");
      const restarted = await persistedState(stateRoot);
      assert.equal(restarted.envelope.state.documentDeletionIntents.length, 0);
      assert.equal(restarted.envelope.state.artifacts.some(({ runId }) => runId === started.run.id), false);
    } finally {
      controls[releaseKey].resolve();
      await service.close({ mode: "abort" }).catch(() => {});
    }
  }
}

async function cancellationAfterPairedCaptureReplaysDeletionAfterRestart(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "cancel-after-pair-offline-restart");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const controls = { pairAuthorized: deferred(), releasePairCommit: deferred() };
  const runner = createDocumentRunner(fixture, client, controls);
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  let threadId;
  let runId;
  try {
    const thread = await service.createThread({ title: "Cancelled document cleanup replay" }, context());
    threadId = thread.thread.id;
    const started = await service.startRun(
      { threadId, input: { text: CANCEL_AFTER_PAIR_PROMPT } },
      context()
    );
    runId = started.run.id;
    await waitFor(controls.pairAuthorized.promise, "durable paired cancellation authority");

    fixture.setAvailable(false);
    const cancelled = await service.cancelRun({ runId }, context());
    assert.equal(cancelled.run.status, "cancelled");
    controls.releasePairCommit.resolve();
    await service.waitForIdle();

    const offline = await persistedState(stateRoot);
    assert.equal(offline.envelope.state.artifacts.filter((artifact) => artifact.runId === runId).length, 2);
    assert.equal(offline.envelope.state.documentCommitIntents.filter((intent) => intent.runId === runId).length, 1);
    const pendingDelete = offline.envelope.state.documentDeletionIntents.find(
      (intent) => intent.reason === "cancelled-run" && intent.runId === runId
    );
    assert.equal(pendingDelete?.status, "pending");
    assert.equal(fixture.calls.some(({ pathname }) => pathname === "/artifact/v1/commit"), false);
    const offlineEventsResponse = await service.loadRunEvents(eventsRequest(runId), context());
    const offlineEvents = await offlineEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(offlineEvents.some(({ type }) => type === "artifact.created"), false);
    assert.deepEqual((await service.listArtifacts({ runId }, context())).artifacts, []);
    const offlineCallCount = fixture.calls.length;
    await service.close({ mode: "wait" });

    fixture.setAvailable(true);
    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    assert.equal((await service.getRunStatus({ runId }, context())).run.status, "cancelled");
    const recovered = await persistedState(stateRoot);
    assert.equal(recovered.envelope.state.artifacts.some((artifact) => artifact.runId === runId), false);
    assert.equal(recovered.envelope.state.documentCommitIntents.some((intent) => intent.runId === runId), false);
    assert.equal(recovered.envelope.state.documentDeletionIntents.some((intent) => intent.runId === runId), false);
    assert.equal(fixture.tombstoned.size, 2);
    assert.equal(
      fixture.calls.slice(offlineCallCount).filter(({ pathname, request }) =>
        pathname === "/artifact/v1/delete" && request.phase === "prepare"
      ).length,
      1
    );
    assert.equal(
      fixture.calls.slice(offlineCallCount).filter(({ pathname, request }) =>
        pathname === "/artifact/v1/delete" && request.phase === "commit"
      ).length,
      1
    );
    const replayEventsResponse = await service.loadRunEvents(eventsRequest(runId), context());
    const replayEvents = await replayEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(replayEvents.some(({ type }) => type === "artifact.created"), false);
    assert.equal(replayEvents.filter(({ type }) => type === "run.cancelled").length, 1);

    const ordinary = await service.startRun(
      { threadId, input: { text: "What is 7 + 7?" } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: ordinary.run.id }, context())).run.status, "completed");
  } finally {
    fixture.setAvailable(true);
    controls.releasePairCommit.resolve();
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function cancellationAfterExpiredStageAcceptsAuthenticatedAbsence(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "cancel-after-expired-stage");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const controls = { pairAuthorized: deferred(), releasePairCommit: deferred() };
  const runner = createDocumentRunner(fixture, client, controls);
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  let threadId;
  let runId;
  try {
    const thread = await service.createThread({ title: "Expired cancelled document stage" }, context());
    threadId = thread.thread.id;
    const started = await service.startRun(
      { threadId, input: { text: CANCEL_AFTER_PAIR_PROMPT } },
      context()
    );
    runId = started.run.id;
    await waitFor(controls.pairAuthorized.promise, "expired-stage cancellation authority");
    fixture.setAvailable(false);
    assert.equal((await service.cancelRun({ runId }, context())).run.status, "cancelled");
    controls.releasePairCommit.resolve();
    await service.waitForIdle();
    await service.close({ mode: "wait" });

    fixture.staged.clear();
    fixture.failNextDelete("NOT_FOUND");
    fixture.setAvailable(true);
    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    assert.equal((await service.getRunStatus({ runId }, context())).run.status, "cancelled");
    const recovered = await persistedState(stateRoot);
    assert.equal(recovered.envelope.state.artifacts.some((artifact) => artifact.runId === runId), false);
    assert.equal(recovered.envelope.state.documentCommitIntents.some((intent) => intent.runId === runId), false);
    assert.equal(recovered.envelope.state.documentDeletionIntents.some((intent) => intent.runId === runId), false);
    assert.equal(fixture.tombstoned.size, 0, "authenticated absence must not fabricate worker tombstones");
    assert.equal(fixture.calls.some(({ pathname }) => pathname === "/artifact/v1/commit"), false);
    const eventsResponse = await service.loadRunEvents(eventsRequest(runId), context());
    const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(events.some(({ type }) => type === "artifact.created"), false);
    assert.equal(events.filter(({ type }) => type === "run.cancelled").length, 1);
    const ordinary = await service.startRun(
      { threadId, input: { text: "What is 11 + 11?" } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: ordinary.run.id }, context())).run.status, "completed");
  } finally {
    fixture.setAvailable(true);
    controls.releasePairCommit.resolve();
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function threadDeletionAcceptsAuthenticatedAbsence(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "thread-delete-authenticated-absence");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const runner = createDocumentRunner(fixture, client);
  const service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  try {
    const thread = await service.createThread({ title: "Absent document thread delete" }, context());
    const started = await service.startRun(
      { threadId: thread.thread.id, input: { text: PRODUCTION_PROMPT } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: started.run.id }, context())).run.status, "completed");
    fixture.failNextDelete("NOT_FOUND");
    const deleted = await service.deleteThread({ threadId: thread.thread.id }, context());
    assert.equal(deleted.deleted, true);
    assert.equal(fixture.tombstoned.size, 0);
    assert.equal(
      fixture.calls.filter(({ pathname, request }) =>
        pathname === "/artifact/v1/delete" && request.phase === "commit"
      ).length,
      0
    );
    await assert.rejects(
      service.getThread({ threadId: thread.thread.id }, context()),
      (error) => error?.code === "NOT_FOUND"
    );
    const state = await persistedState(stateRoot);
    assert.equal(state.envelope.state.threads.some(({ id }) => id === thread.thread.id), false);
    assert.equal(state.envelope.state.artifacts.some(({ threadId }) => threadId === thread.thread.id), false);
    assert.equal(state.envelope.state.documentDeletionIntents.length, 0);
  } finally {
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function cancellationAfterPublishedCommitCompletesTruthfully(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "cancel-after-published-commit");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const controls = { finalAcknowledged: deferred(), releaseFinalAck: deferred() };
  const runner = createDocumentRunner(fixture, client, controls);
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  try {
    const thread = await service.createThread({ title: "Published commit cancellation boundary" }, context());
    const started = await service.startRun(
      { threadId: thread.thread.id, input: { text: CANCEL_AFTER_FINAL_ACK_PROMPT } },
      context()
    );
    await waitFor(controls.finalAcknowledged.promise, "published committed document pair");
    const completedByBoundary = await service.cancelRun({ runId: started.run.id }, context());
    assert.equal(completedByBoundary.run.status, "completed");
    assert.equal(completedByBoundary.run.output, "The TeX source and compiled PDF are ready below.");
    controls.releaseFinalAck.resolve();
    await service.waitForIdle();

    const completed = (await service.getRunStatus({ runId: started.run.id }, context())).run;
    assert.equal(completed.status, "completed");
    assert.equal((await service.listArtifacts({ runId: started.run.id }, context())).artifacts.length, 2);
    const state = await persistedState(stateRoot);
    assert.equal(state.envelope.state.documentCommitIntents.length, 1);
    assert.equal(state.envelope.state.documentCommitIntents[0].status, "committed");
    assert.equal(state.envelope.state.documentCommitIntents[0].eventsPublished, true);
    assert.equal(state.envelope.state.documentDeletionIntents.length, 0);
    assert.equal(fixture.tombstoned.size, 0);
    const eventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(events.filter(({ type }) => type === "artifact.created").length, 2);
    assert.equal(events.filter(({ type }) => type === "output.completed").length, 1);
    assert.equal(events.filter(({ type }) => type === "run.completed").length, 1);
    assert.equal(events.some(({ type }) => type === "run.cancelled"), false);
    await service.close({ mode: "wait" });

    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    assert.equal((await service.getRunStatus({ runId: started.run.id }, context())).run.status, "completed");
    const replayEventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const replayEvents = await replayEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(replayEvents.filter(({ type }) => type === "artifact.created").length, 2);
    assert.equal(replayEvents.filter(({ type }) => type === "run.completed").length, 1);
  } finally {
    controls.releaseFinalAck.resolve();
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function pendingCommitRestartRoundTrip(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "pending-commit-restart");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const runner = createDocumentRunner(fixture, client);
  let service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  let threadId;
  let runId;
  try {
    const thread = await service.createThread({ title: "Commit replay" }, context());
    threadId = thread.thread.id;
    const started = await service.startRun(
      { threadId, input: { text: INTERRUPT_PROMPT } },
      context()
    );
    runId = started.run.id;
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId }, context())).run.status, "running");
    const before = await persistedState(stateRoot);
    assert.equal(before.envelope.state.documentCommitIntents.length, 1);
    assert.equal(before.envelope.state.documentCommitIntents[0].status, "pending");
    assert.equal(before.envelope.state.documentCommitIntents[0].eventsPublished, false);
    assert.equal(before.envelope.state.artifacts.length, 2);
    assert.doesNotMatch(before.bytes, new RegExp(SOURCE_MARKER, "u"));
    const beforeEventsResponse = await service.loadRunEvents(eventsRequest(runId), context());
    const beforeEvents = await beforeEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(beforeEvents.some(({ type }) => type === "artifact.created"), false);
    await service.close({ mode: "wait" });

    fixture.setAvailable(true);
    service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    const recovered = (await service.getRunStatus({ runId }, context())).run;
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.error, null);
    assert.equal(recovered.output, "The TeX source and compiled PDF are ready below.");
    const after = await persistedState(stateRoot);
    assert.equal(after.envelope.state.documentCommitIntents[0].status, "committed");
    assert.equal(after.envelope.state.documentCommitIntents[0].eventsPublished, true);
    assert.match(after.envelope.state.documentCommitIntents[0].workerAckDigest, /^[a-f0-9]{64}$/u);
    assert.equal((await service.listArtifacts({ runId }, context())).artifacts.length, 2);
    const afterEventsResponse = await service.loadRunEvents(eventsRequest(runId), context());
    const afterEvents = await afterEventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(afterEvents.filter(({ type }) => type === "artifact.created").length, 2);
    assert.equal(afterEvents.filter(({ type }) => type === "output.completed").length, 1);
    assert.equal(afterEvents.filter(({ type }) => type === "run.completed").length, 1);
    assert.equal(afterEvents.some(({ type }) => type === "run.failed"), false);
    assert.ok(
      afterEvents.findLastIndex(({ type }) => type === "artifact.created") <
        afterEvents.findIndex(({ type }) => type === "run.completed")
    );

    const deleted = await service.deleteThread({ threadId }, context());
    assert.equal(deleted.deleted, true);
    assert.equal(
      fixture.calls.filter(({ pathname, request }) =>
        pathname === "/artifact/v1/delete" && request.phase === "prepare"
      ).length,
      1
    );
    assert.equal(
      fixture.calls.filter(({ pathname, request }) =>
        pathname === "/artifact/v1/delete" && request.phase === "commit"
      ).length,
      1
    );
  } finally {
    fixture.setAvailable(true);
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function expiredStagedPairFailsTruthfullyWithoutThreadLock(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "expired-staged-pair");
  const fixture = createDocumentWorkerFixture();
  const client = fixture.client();
  const runner = createDocumentRunner(fixture, client);
  const service = createTestOnlyIntegrationAnalysisSessionService({
    analysisRunner: runner,
    stateRoot,
    documentWorkerClient: client,
    documentWorkerEnabled: true,
  });
  try {
    const thread = await service.createThread({ title: "Expired staged pair" }, context());
    const started = await service.startRun(
      { threadId: thread.thread.id, input: { text: EXPIRED_STAGED_PAIR_PROMPT } },
      context()
    );
    await service.waitForIdle();
    const failed = (await service.getRunStatus({ runId: started.run.id }, context())).run;
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, {
      code: "ANALYSIS_DOCUMENT_COMMIT_LOST",
      message: "The workstation no longer has the staged document pair. Resume this run to regenerate it.",
    });
    const state = await persistedState(stateRoot);
    assert.equal(state.envelope.state.artifacts.some(({ runId }) => runId === started.run.id), false);
    assert.equal(state.envelope.state.documentCommitIntents.some(({ runId }) => runId === started.run.id), false);
    const eventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
    const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
    assert.equal(events.some(({ type }) => type === "artifact.created"), false);
    assert.equal(events.filter(({ type }) => type === "run.failed").length, 1);
    const ordinary = await service.startRun(
      { threadId: thread.thread.id, input: { text: "What is 5 + 5?" } },
      context()
    );
    await service.waitForIdle();
    assert.equal((await service.getRunStatus({ runId: ordinary.run.id }, context())).run.status, "completed");
  } finally {
    await service.close({ mode: "abort" }).catch(() => {});
  }
}

async function committedCrashBoundariesCompleteExactlyOnce(temporaryRoot) {
  for (const [label, prompt] of [
    ["after-worker-commit", AFTER_COMMIT_PROMPT],
    ["after-file-events", AFTER_FINAL_PROMPT],
  ]) {
    const stateRoot = path.join(temporaryRoot, label);
    const fixture = createDocumentWorkerFixture();
    const client = fixture.client();
    const runner = createDocumentRunner(fixture, client);
    let service = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: runner,
      stateRoot,
      documentWorkerClient: client,
      documentWorkerEnabled: true,
    });
    try {
      const thread = await service.createThread({ title: label }, context());
      const started = await service.startRun({ threadId: thread.thread.id, input: { text: prompt } }, context());
      await service.waitForIdle();
      const before = await persistedState(stateRoot);
      const beforeRun = before.envelope.state.runs.find(({ id }) => id === started.run.id);
      const beforeIntent = before.envelope.state.documentCommitIntents.find(
        ({ runId }) => runId === started.run.id
      );
      if (prompt === AFTER_COMMIT_PROMPT) {
        assert.equal(beforeRun.status, "running");
        assert.equal(beforeIntent.status, "pending");
        assert.equal(beforeIntent.eventsPublished, false);
        assert.equal(beforeRun.events.some(({ type }) => type === "artifact.created"), false);
      } else {
        assert.equal(beforeRun.status, "completed");
        assert.equal(beforeIntent.status, "committed");
        assert.equal(beforeIntent.eventsPublished, true);
      }
      await service.close({ mode: "wait" });

      service = createTestOnlyIntegrationAnalysisSessionService({
        analysisRunner: runner,
        stateRoot,
        documentWorkerClient: client,
        documentWorkerEnabled: true,
      });
      const completed = (await service.getRunStatus({ runId: started.run.id }, context())).run;
      assert.equal(completed.status, "completed");
      assert.equal(completed.output, "The TeX source and compiled PDF are ready below.");
      assert.equal((await service.listArtifacts({ runId: started.run.id }, context())).artifacts.length, 2);
      const eventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
      const events = await eventsResponse.publicEventLedger.loadEventsAfter(0);
      assert.equal(events.filter(({ type }) => type === "artifact.created").length, 2);
      assert.equal(events.filter(({ type }) => type === "output.completed").length, 1);
      assert.equal(events.filter(({ type }) => type === "run.completed").length, 1);
      assert.equal(events.filter(({ type }) => type === "run.failed").length, 0);
      assert.ok(
        events.findLastIndex(({ type }) => type === "artifact.created") <
          events.findIndex(({ type }) => type === "output.completed")
      );
      await service.close({ mode: "wait" });

      service = createTestOnlyIntegrationAnalysisSessionService({
        analysisRunner: runner,
        stateRoot,
        documentWorkerClient: client,
        documentWorkerEnabled: true,
      });
      const replayEventsResponse = await service.loadRunEvents(eventsRequest(started.run.id), context());
      const replayEvents = await replayEventsResponse.publicEventLedger.loadEventsAfter(0);
      assert.equal(replayEvents.filter(({ type }) => type === "artifact.created").length, 2);
      assert.equal(replayEvents.filter(({ type }) => type === "output.completed").length, 1);
      assert.equal(replayEvents.filter(({ type }) => type === "run.completed").length, 1);
    } finally {
      await service.close({ mode: "abort" }).catch(() => {});
    }
  }
}

async function legacyV2MigrationRejectsCloudDocumentBytes(temporaryRoot) {
  const migrationRoot = path.join(temporaryRoot, "legacy-v2-migration");
  const runner = Object.freeze({
    async run() {
      throw new Error("legacy migration smoke must not start a run");
    },
  });
  let service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: runner, stateRoot: migrationRoot });
  const created = await service.createThread({ title: "Legacy metadata only" }, context());
  await service.close({ mode: "wait" });
  let persisted = await persistedState(migrationRoot);
  const migratedPath = path.join(
    migrationRoot,
    "scopes",
    (await fs.readdir(path.join(migrationRoot, "scopes")))[0],
    "state.json"
  );
  const safeLegacy = legacyV2Envelope(persisted.envelope);
  await fs.writeFile(migratedPath, `${canonicalJson(safeLegacy)}\n`, { mode: 0o600 });

  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: runner, stateRoot: migrationRoot });
  const updated = await service.updateThread(
    { threadId: created.thread.id, title: "Migrated metadata only" },
    context()
  );
  assert.equal(updated.thread.title, "Migrated metadata only");
  await service.close({ mode: "wait" });
  persisted = await persistedState(migrationRoot);
  assert.equal(persisted.envelope.schemaVersion, "aginti-integration-analysis-state-v3");
  assert.equal(persisted.envelope.state.schemaVersion, "aginti-integration-analysis-state-v3");
  assert.deepEqual(persisted.envelope.state.documentCommitIntents, []);
  assert.deepEqual(persisted.envelope.state.documentDeletionIntents, []);
  assert.doesNotMatch(persisted.bytes, /(?:privateBytes|contentBytes|blobRef|%PDF-)/u);

  const rejectionRoot = path.join(temporaryRoot, "legacy-v2-cloud-file-rejection");
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: runner, stateRoot: rejectionRoot });
  const rejectedThread = await service.createThread({ title: "Unsafe legacy file" }, context());
  await service.close({ mode: "wait" });
  const rejected = await persistedState(rejectionRoot);
  const rejectedPath = path.join(
    rejectionRoot,
    "scopes",
    (await fs.readdir(path.join(rejectionRoot, "scopes")))[0],
    "state.json"
  );
  const unsafeLegacy = legacyV2Envelope(rejected.envelope, {
    unsafeFile: {
      kind: "file",
      privateBytes: "JVBERi0xLjcK",
      blobRef: "blob_cloud_authority_must_not_migrate",
    },
  });
  await fs.writeFile(rejectedPath, `${canonicalJson(unsafeLegacy)}\n`, { mode: 0o600 });
  service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: runner, stateRoot: rejectionRoot });
  await assert.rejects(
    service.getThread({ threadId: rejectedThread.thread.id }, context()),
    (error) => error?.code === "ANALYSIS_STATE_CORRUPT"
  );
  await service.close({ mode: "abort" }).catch(() => {});
}

async function main() {
  assert.deepEqual(classifyIntegrationDocumentArtifactIntent(PRODUCTION_PROMPT), {
    schemaVersion: "aginti-integration-document-artifacts-v1",
    required: true,
    kind: "tex-pdf",
    requiredFormats: ["tex", "pdf"],
    requirements: {
      schemaVersion: "aginti-document-compile-requirements-v1",
      profile: "self-contained-tex-v1",
      minimumFigureCount: 1,
    },
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-document-session-broker-"));
  try {
    await committedContinuationRoundTrip(temporaryRoot);
    await cancellationBeforePairedCaptureRoundTrip(temporaryRoot);
    await cancellationAfterPairedCaptureDeletesWorkerGroup(temporaryRoot);
    await cancellationAfterPairedCaptureReplaysDeletionAfterRestart(temporaryRoot);
    await cancellationAfterExpiredStageAcceptsAuthenticatedAbsence(temporaryRoot);
    await threadDeletionAcceptsAuthenticatedAbsence(temporaryRoot);
    await cancellationAfterPublishedCommitCompletesTruthfully(temporaryRoot);
    await pendingCommitRestartRoundTrip(temporaryRoot);
    await expiredStagedPairFailsTruthfullyWithoutThreadLock(temporaryRoot);
    await committedCrashBoundariesCompleteExactlyOnce(temporaryRoot);
    await legacyV2MigrationRejectsCloudDocumentBytes(temporaryRoot);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write("integration document session broker smoke passed\n");
}

await main();
