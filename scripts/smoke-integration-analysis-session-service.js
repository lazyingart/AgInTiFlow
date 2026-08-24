import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM } from "../src/integration-api.js";
import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION } from "../src/integration-analysis-coordinator.js";
import {
  INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION,
  assertIntegrationAnalysisSessionService,
  createTestOnlyIntegrationAnalysisSessionService,
} from "../src/integration-analysis-session-service.js";
import { INTEGRATION_RPC_PATHS, canonicalJson, contractDigest } from "../src/integration-policy.js";
import { validatePublicIntegrationEvent } from "../src/integration-events.js";

const PRINCIPAL_ID = "principal-analysis-0001";
const OTHER_PRINCIPAL_ID = "principal-analysis-0002";
const BROWSER_SESSION_ID = "b".repeat(64);
const OTHER_BROWSER_SESSION_ID = "c".repeat(64);
const ZERO_DIGEST = "0".repeat(64);
const RAW_SOURCE_MARKER = "RAW_EXECUTION_SOURCE_SHOULD_NOT_PERSIST";
const RAW_STDOUT_MARKER = "RAW_EXECUTION_STDOUT_SHOULD_NOT_PERSIST";

function context(principalId = PRINCIPAL_ID, browserSessionId = BROWSER_SESSION_ID) {
  return Object.freeze({ principalId, browserSessionId });
}

function mutationContext(pathname, payload, idempotencyKey, principalId = PRINCIPAL_ID, browserSessionId = BROWSER_SESSION_ID) {
  return Object.freeze({
    principalId,
    browserSessionId,
    pathname,
    payload,
    idempotencyKey,
    requestHash: contractDigest({
      algorithm: INTEGRATION_IDEMPOTENCY_REQUEST_HASH_ALGORITHM,
      principalId,
      browserSessionId,
      operation: pathname,
      request: payload,
    }),
    idempotencyKeyDigest: crypto.createHash("sha256").update(idempotencyKey, "utf8").digest("hex"),
  });
}

function recoveryRequestFor(value) {
  return Object.freeze({
    principalId: value.principalId,
    browserSessionId: value.browserSessionId,
    pathname: value.pathname,
    requestHash: value.requestHash,
    idempotencyKeyDigest: value.idempotencyKeyDigest,
  });
}

function eventsRequest(runId) {
  return Object.freeze({ runId, afterSeq: 0, afterHash: ZERO_DIGEST });
}

function plannerResult({ text = "Analysis completed safely.", artifacts = [], toolCalls = 1 } = {}) {
  return Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text,
    kind: toolCalls > 0 ? "analysis" : "direct",
    toolCalls,
    executionStatus: toolCalls > 0 ? "succeeded" : null,
    artifacts: Object.freeze(artifacts),
  });
}

function plotArtifact() {
  return Object.freeze({
    id: `art_${"a".repeat(64)}`,
    title: "Quadratic plot",
    kind: "plot",
    spec: Object.freeze({
      schemaVersion: "1",
      type: "line",
      xLabel: "x",
      yLabel: "x squared",
      labels: Object.freeze(["0", "1", "2", "3"]),
      series: Object.freeze([
        Object.freeze({ name: "x squared", data: Object.freeze([0, 1, 4, 9]) }),
      ]),
    }),
  });
}

function runnerError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publicCode = code;
  return error;
}

function activationProof() {
  const unsigned = Object.freeze({
    schemaVersion: INTEGRATION_ANALYSIS_COORDINATOR_SCHEMA_VERSION,
    ready: true,
    publicActivationReady: true,
    workerCapabilityDigest: "1".repeat(64),
    workerHealthDigest: "2".repeat(64),
    coordinatorProtocolDigest: "3".repeat(64),
    coordinatorHealthDigest: "4".repeat(64),
    runtimeProfile: "python312-curated-root-v1",
    runtimeBundleRootDigest: "5".repeat(64),
    seccompPolicyDigest: "6".repeat(64),
    cgroupPolicyDigest: "7".repeat(64),
  });
  return Object.freeze({ ...unsigned, digest: contractDigest(unsigned) });
}

function createFakeRunner() {
  const held = new Map();
  const calls = [];
  const runner = {
    calls,
    held,
    async run(scope, input, options) {
      calls.push(Object.freeze({
        scope: Object.freeze({ ...scope }),
        prompt: input.prompt,
        conversation: Object.freeze(input.conversation.map((message) => Object.freeze({ ...message }))),
      }));
      if (input.prompt.includes("hold")) {
        return new Promise((resolve, reject) => {
          const abort = () => {
            held.delete(scope.runId);
            reject(runnerError("ANALYSIS_CANCELLED", "cancelled"));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          held.set(scope.runId, Object.freeze({
            reject,
            async release(value = plannerResult({ toolCalls: 0 })) {
              options.signal?.removeEventListener("abort", abort);
              held.delete(scope.runId);
              try {
                await options.onFinal?.(value);
                resolve(value);
              } catch (error) {
                reject(error);
              }
            },
          }));
        });
      }
      if (input.prompt.includes("fail")) {
        throw runnerError("ANALYSIS_MODEL_UNAVAILABLE", `private ${RAW_SOURCE_MARKER} /root/private/model.log`);
      }
      await options.onProgress?.(Object.freeze({ phase: "planning", toolCallsCompleted: 0 }));
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "starting",
      }));
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "running",
      }));
      const artifact = plotArtifact();
      await options.onArtifact?.(artifact);
      await options.onProgress?.(Object.freeze({
        phase: "executing",
        toolCallsCompleted: 0,
        toolName: "execute_python_analysis",
        toolCallNumber: 1,
        executionState: "succeeded",
      }));
      await options.onProgress?.(Object.freeze({
        phase: "synthesizing",
        toolCallsCompleted: 1,
        executionSucceeded: true,
        artifactCount: 1,
      }));
      // These values model private coordinator internals and are intentionally
      // never passed through the public planner result or callbacks.
      void RAW_SOURCE_MARKER;
      void RAW_STDOUT_MARKER;
      const result = plannerResult({
        text: "The plot is ready. Internal file /root/private/result.txt was hidden.",
        artifacts: [artifact],
      });
      await options.onFinal?.(result);
      return result;
    },
  };
  return runner;
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code || error?.publicCode, code);
    return true;
  });
}

function assertLedger(events, runId, threadId) {
  assert.ok(events.length > 0);
  let previousHash = ZERO_DIGEST;
  for (let index = 0; index < events.length; index += 1) {
    const event = validatePublicIntegrationEvent(events[index]);
    assert.equal(event.id, `${runId}.${index + 1}`);
    assert.equal(event.seq, index + 1);
    assert.equal(event.runId, runId);
    assert.equal(event.threadId, threadId);
    assert.equal(event.previousHash, previousHash);
    previousHash = event.hash;
  }
}

async function stateFile(root) {
  const scopeEntries = await fs.readdir(path.join(root, "scopes"));
  assert.equal(scopeEntries.length, 1);
  assert.match(scopeEntries[0], /^[a-f0-9]{64}$/u);
  return path.join(root, "scopes", scopeEntries[0], "state.json");
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-analysis-session-"));
  const root = path.join(temporaryRoot, "state");
  const fakeRunner = createFakeRunner();
  try {
    const service = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    assertIntegrationAnalysisSessionService(service, { allowTestOnly: true });
    assert.throws(() => assertIntegrationAnalysisSessionService(service), /test-only/u);
    for (const method of [
      "getIntegrationCapabilities",
      "recoverMutation",
      "listThreads",
      "createThread",
      "getThread",
      "updateThread",
      "deleteThread",
      "startRun",
      "getRunStatus",
      "loadRunEvents",
      "cancelRun",
      "resumeRun",
      "listArtifacts",
      "getArtifact",
      "beginDrain",
      "close",
    ]) {
      assert.equal(typeof service[method], "function", `${method} is missing`);
    }
    const capabilities = await service.getIntegrationCapabilities();
    assert.equal(capabilities.cancel, true);
    assert.equal(capabilities.resume, true);
    assert.equal(capabilities.analysisSessionAuthority.schemaVersion, INTEGRATION_ANALYSIS_SESSION_SCHEMA_VERSION);
    assert.equal(capabilities.analysisSessionAuthority.ready, false);
    assert.equal(capabilities.analysisSessionAuthority.testOnly, true);
    assert.equal(capabilities.analysisSessionAuthority.atomicTempFsyncRename, true);
    assert.equal(capabilities.analysisSessionAuthority.publicEventHashChain, true);
    assert.equal(capabilities.analysisSessionAuthority.exclusiveServiceLifetimeLock, true);
    assert.equal(capabilities.analysisSessionAuthority.crossProcessSafe, true);
    assert.equal(capabilities.analysisSessionAuthority.maximumConcurrentPlannerRuns, 2);
    assert.equal(capabilities.analysisSessionAuthority.publicActivationLocksChanged, false);
    assert.equal(capabilities.analysisSessionAuthority.durableMutationReceipts, true);
    assert.equal(capabilities.mutationRecoveryAuthority.atomicWithMutation, true);
    assert.equal(capabilities.mutationRecoveryAuthority.blindRedispatch, false);
    assert.equal(
      capabilities.analysisSessionAuthority.mutationRecoveryAuthorityDigest,
      capabilities.mutationRecoveryAuthority.digest
    );

    const proofBoundService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: path.join(temporaryRoot, "proof-bound-state"),
      activationProof: activationProof(),
    });
    const proofBoundAttestation = await proofBoundService.getAnalysisSessionAttestation();
    assert.equal(proofBoundAttestation.activationProofPinnedAtStartup, true);
    assert.equal(proofBoundAttestation.activationProof.digest, proofBoundAttestation.activationProofDigest);
    await proofBoundService.close();

    const receiptRoot = path.join(temporaryRoot, "receipt-state");
    const receiptService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: receiptRoot,
    });
    const receiptPayload = Object.freeze({ title: "Atomic mutation receipt" });
    const rawIdempotencyKey = "mutation-receipt-secret-key-0001";
    const receiptContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsCreate,
      receiptPayload,
      rawIdempotencyKey
    );
    const receiptCreated = await receiptService.createThread(receiptPayload, receiptContext);
    const recoveryRequest = recoveryRequestFor(receiptContext);
    const recoveredReceipt = await receiptService.recoverMutation(recoveryRequest);
    assert.equal(recoveredReceipt.schemaVersion, "1");
    assert.equal(recoveredReceipt.thread.id, receiptCreated.thread.id);

    const updatePayload = Object.freeze({ threadId: receiptCreated.thread.id, title: "Receipt updated" });
    const updateContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsUpdate,
      updatePayload,
      "mutation-receipt-secret-key-0002"
    );
    const updatedReceiptThread = await receiptService.updateThread(updatePayload, updateContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(updateContext))).thread.title,
      updatedReceiptThread.thread.title
    );

    const startPayload = Object.freeze({
      threadId: receiptCreated.thread.id,
      input: Object.freeze({ text: "Run receipt plot" }),
    });
    const startContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsStart,
      startPayload,
      "mutation-receipt-secret-key-0003"
    );
    const receiptStarted = await receiptService.startRun(startPayload, startContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(startContext))).run.id,
      receiptStarted.run.id
    );
    await receiptService.waitForIdle();

    const heldPayload = Object.freeze({
      threadId: receiptCreated.thread.id,
      input: Object.freeze({ text: "hold for receipt cancellation" }),
    });
    const heldContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsStart,
      heldPayload,
      "mutation-receipt-secret-key-0004"
    );
    const heldReceiptRun = await receiptService.startRun(heldPayload, heldContext);
    await waitFor(() => fakeRunner.held.has(heldReceiptRun.run.id), "receipt cancellation runner start");
    const cancelPayload = Object.freeze({ runId: heldReceiptRun.run.id });
    const cancelContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsCancel,
      cancelPayload,
      "mutation-receipt-secret-key-0005"
    );
    const cancelledReceiptRun = await receiptService.cancelRun(cancelPayload, cancelContext);
    assert.equal(cancelledReceiptRun.run.status, "cancelled");
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(cancelContext))).run.status,
      "cancelled"
    );
    await receiptService.waitForIdle();

    const resumePayload = Object.freeze({
      runId: heldReceiptRun.run.id,
      input: Object.freeze({ text: "answer the receipt resume" }),
    });
    const resumeContext = mutationContext(
      INTEGRATION_RPC_PATHS.runsResume,
      resumePayload,
      "mutation-receipt-secret-key-0006"
    );
    const resumedReceiptRun = await receiptService.resumeRun(resumePayload, resumeContext);
    assert.equal(
      (await receiptService.recoverMutation(recoveryRequestFor(resumeContext))).run.id,
      resumedReceiptRun.run.id
    );
    await receiptService.waitForIdle();

    const deletePayload = Object.freeze({ threadId: receiptCreated.thread.id });
    const deleteContext = mutationContext(
      INTEGRATION_RPC_PATHS.threadsDelete,
      deletePayload,
      "mutation-receipt-secret-key-0007"
    );
    await receiptService.deleteThread(deletePayload, deleteContext);
    assert.deepEqual(await receiptService.recoverMutation(recoveryRequestFor(deleteContext)), {
      schemaVersion: "1",
      deleted: true,
      threadId: receiptCreated.thread.id,
    });
    const receiptStatePath = await stateFile(receiptRoot);
    const receiptStateBytes = await fs.readFile(receiptStatePath, "utf8");
    assert.doesNotMatch(receiptStateBytes, new RegExp(rawIdempotencyKey, "u"));
    assert.equal(JSON.parse(receiptStateBytes).state.mutationReceipts.length, 7);
    await expectCode(
      receiptService.recoverMutation({ ...recoveryRequest, requestHash: "f".repeat(64) }),
      "IDEMPOTENCY_CONFLICT"
    );
    assert.equal(
      await receiptService.recoverMutation({ ...recoveryRequest, idempotencyKeyDigest: "e".repeat(64) }),
      null
    );
    await receiptService.close({ mode: "wait" });

    const restartedReceiptService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: receiptRoot,
    });
    assert.deepEqual(await restartedReceiptService.recoverMutation(recoveryRequest), recoveredReceipt);
    const corruptReceiptEnvelope = JSON.parse(receiptStateBytes);
    corruptReceiptEnvelope.state.mutationReceipts[0].response.thread.title = "Corrupted receipt";
    corruptReceiptEnvelope.digest = contractDigest({
      schemaVersion: corruptReceiptEnvelope.schemaVersion,
      state: corruptReceiptEnvelope.state,
    });
    await fs.writeFile(receiptStatePath, `${canonicalJson(corruptReceiptEnvelope)}\n`, { mode: 0o600 });
    await expectCode(restartedReceiptService.recoverMutation(recoveryRequest), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(receiptStatePath, receiptStateBytes, { mode: 0o600 });
    await restartedReceiptService.close({ mode: "wait" });

    const created = await service.createThread({ title: "Durable plot" }, context());
    const threadId = created.thread.id;
    assert.equal(created.thread.browserSessionPolicy, "same-browser-session");
    const started = await service.startRun(
      { threadId, input: { text: "Run Python and show a quadratic plot" } },
      context()
    );
    const runId = started.run.id;
    assert.equal(started.run.status, "starting");
    await service.waitForIdle();

    const completed = (await service.getRunStatus({ runId }, context())).run;
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /plot is ready/u);
    assert.doesNotMatch(completed.output, /\/root\/private/u);
    assert.match(completed.output, /REDACTED_PATH/u);
    const eventResult = await service.loadRunEvents(eventsRequest(runId), context());
    const events = await eventResult.publicEventLedger.loadEventsAfter(0);
    assertLedger(events, runId, threadId);
    assert.ok(events.some((event) => event.type === "plan.updated"));
    assert.ok(events.some((event) => event.type === "tool.started"));
    assert.ok(events.some((event) => event.type === "tool.progress"));
    assert.ok(events.some((event) => event.type === "tool.completed"));
    const artifactEvent = events.find((event) => event.type === "artifact.created");
    const terminalEvent = events.find((event) => event.type === "run.completed");
    assert.ok(artifactEvent.seq < terminalEvent.seq, "artifact.created must precede run.completed");
    assert.deepEqual(await eventResult.publicEventLedger.loadCursor(0), { seq: 0, hash: ZERO_DIGEST });
    assert.deepEqual(await eventResult.publicEventLedger.loadHead(), {
      seq: completed.eventCursor.lastSeq,
      hash: completed.eventCursor.lastHash,
    });

    const listedArtifacts = await service.listArtifacts({ runId }, context());
    assert.equal(listedArtifacts.artifacts.length, 1);
    assert.notEqual(listedArtifacts.artifacts[0].id, plotArtifact().id, "artifact id was not rebound to run ownership");
    const loadedArtifact = await service.getArtifact({ artifactId: listedArtifacts.artifacts[0].id }, context());
    assert.deepEqual(loadedArtifact.artifact.spec, listedArtifacts.artifacts[0].spec);
    const loadedThread = (await service.getThread({ threadId }, context())).thread;
    assert.deepEqual(loadedThread.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(loadedThread.authority.contextDigest, loadedThread.messages.at(-1).digest);

    const persistedFile = await stateFile(root);
    const persistedText = await fs.readFile(persistedFile, "utf8");
    assert.doesNotMatch(persistedText, new RegExp(RAW_SOURCE_MARKER, "u"));
    assert.doesNotMatch(persistedText, new RegExp(RAW_STDOUT_MARKER, "u"));
    assert.doesNotMatch(persistedText, /\/root\/private/u);
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(persistedFile)).mode & 0o777, 0o600);

    const rejectedSecondOwner = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    await expectCode(rejectedSecondOwner.getRunStatus({ runId }, context()), "ANALYSIS_SERVICE_BUSY");
    await rejectedSecondOwner.close();
    await service.close({ mode: "wait" });

    const restarted = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    const restartedRun = (await restarted.getRunStatus({ runId }, context())).run;
    assert.equal(restartedRun.eventCursor.lastHash, completed.eventCursor.lastHash);
    const restartedEventsResult = await restarted.loadRunEvents(eventsRequest(runId), context());
    const restartedEvents = await restartedEventsResult.publicEventLedger.loadEventsAfter(0);
    assert.deepEqual(restartedEvents, events, "durable event replay changed after service recreation");

    await expectCode(
      restarted.getThread({ threadId }, context(PRINCIPAL_ID, OTHER_BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );
    await expectCode(
      restarted.getThread({ threadId }, context(OTHER_PRINCIPAL_ID, BROWSER_SESSION_ID)),
      "NOT_FOUND"
    );

    const streamingThread = await restarted.createThread({ title: "Dynamic stream" }, context());
    const streamingStarted = await restarted.startRun(
      { threadId: streamingThread.thread.id, input: { text: "hold for a live stream" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(streamingStarted.run.id), "dynamic stream runner start");
    const liveEventResult = await restarted.loadRunEvents(eventsRequest(streamingStarted.run.id), context());
    assert.equal(liveEventResult.once, false);
    assert.equal(liveEventResult.streamMs, 25_000);
    assert.equal(liveEventResult.pollMs, 100);
    const initialStreamEvents = await liveEventResult.publicEventLedger.loadEventsAfter(0);
    const pinnedInitialHead = await liveEventResult.publicEventLedger.loadHead();
    assert.equal(pinnedInitialHead.seq, initialStreamEvents.at(-1).seq);
    await fakeRunner.held.get(streamingStarted.run.id).release();
    await restarted.waitForIdle();
    const appendedStreamEvents = await liveEventResult.publicEventLedger.loadEventsAfter(pinnedInitialHead.seq);
    assert.ok(appendedStreamEvents.length > 0, "live event ledger did not expose events appended after the initial snapshot");
    assert.equal(appendedStreamEvents.at(-1).type, "run.completed");
    assert.deepEqual(
      await liveEventResult.publicEventLedger.loadHead(),
      pinnedInitialHead,
      "initial run/head binding must stay atomic while the append-only ledger grows"
    );

    const cancelThread = await restarted.createThread({ title: "Cancel" }, context());
    const cancelStarted = await restarted.startRun(
      { threadId: cancelThread.thread.id, input: { text: "hold until cancelled" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(cancelStarted.run.id), "cancel runner start");
    const cancelled = (await restarted.cancelRun({ runId: cancelStarted.run.id }, context())).run;
    assert.equal(cancelled.status, "cancelled");
    const cancelledAgain = (await restarted.cancelRun({ runId: cancelStarted.run.id }, context())).run;
    assert.equal(cancelledAgain.eventCursor.lastHash, cancelled.eventCursor.lastHash);
    await restarted.waitForIdle();
    const cancelledEventsResult = await restarted.loadRunEvents(eventsRequest(cancelStarted.run.id), context());
    const cancelledEvents = await cancelledEventsResult.publicEventLedger.loadEventsAfter(0);
    assert.equal(cancelledEvents.at(-1).type, "run.cancelled");
    assert.equal(cancelledEvents.filter((event) => event.type === "run.cancelled").length, 1);

    const failureThread = await restarted.createThread({ title: "Failure and resume" }, context());
    const failedStarted = await restarted.startRun(
      { threadId: failureThread.thread.id, input: { text: "fail without leaking internals" } },
      context()
    );
    await restarted.waitForIdle();
    const failed = (await restarted.getRunStatus({ runId: failedStarted.run.id }, context())).run;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "ANALYSIS_MODEL_UNAVAILABLE");
    assert.doesNotMatch(failed.error.message, /private|root|source/iu);
    const resumed = await restarted.resumeRun(
      { runId: failed.id, input: { text: "Run Python and show the plot now" } },
      context()
    );
    assert.equal(resumed.run.previousRunId, failed.id);
    await restarted.waitForIdle();
    assert.equal((await restarted.getRunStatus({ runId: resumed.run.id }, context())).run.status, "completed");

    const interruptedThread = await restarted.createThread({ title: "Exclusive ownership" }, context());
    const interruptedStarted = await restarted.startRun(
      { threadId: interruptedThread.thread.id, input: { text: "hold while the owner is live" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(interruptedStarted.run.id), "exclusive owner runner start");
    const blockedDuringRun = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    await expectCode(blockedDuringRun.getRunStatus({ runId: interruptedStarted.run.id }, context()), "ANALYSIS_SERVICE_BUSY");
    await blockedDuringRun.close();
    await restarted.cancelRun({ runId: interruptedStarted.run.id }, context());
    await restarted.waitForIdle();
    await restarted.close({ mode: "wait" });

    const afterCrash = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: root });
    const recovered = (await afterCrash.getRunStatus({ runId: interruptedStarted.run.id }, context())).run;
    assert.equal(recovered.status, "cancelled");
    const resumedRecovered = await afterCrash.resumeRun({ runId: recovered.id, input: { text: "answer normally" } }, context());
    await afterCrash.waitForIdle();
    assert.equal((await afterCrash.getRunStatus({ runId: resumedRecovered.run.id }, context())).run.status, "completed");

    const pageThread = await afterCrash.createThread({ title: "Pagination" }, context());
    const updated = await afterCrash.updateThread(
      { threadId: pageThread.thread.id, title: "Pagination updated" },
      context()
    );
    assert.equal(updated.thread.title, "Pagination updated");
    const firstPage = await afterCrash.listThreads({ limit: 1, before: "" }, context());
    assert.equal(firstPage.threads.length, 1);
    assert.ok(firstPage.nextBefore);
    const secondPage = await afterCrash.listThreads({ limit: 1, before: firstPage.nextBefore }, context());
    assert.equal(secondPage.threads.length, 1);
    assert.notEqual(secondPage.threads[0].id, firstPage.threads[0].id);
    const deleted = await afterCrash.deleteThread({ threadId: pageThread.thread.id }, context());
    assert.equal(deleted.deleted, true);
    await expectCode(afterCrash.getThread({ threadId: pageThread.thread.id }, context()), "NOT_FOUND");

    const stableBytes = await fs.readFile(persistedFile, "utf8");
    const tamperedEnvelope = JSON.parse(stableBytes);
    tamperedEnvelope.state.threads[0].title = "Tampered title";
    await fs.writeFile(persistedFile, `${canonicalJson(tamperedEnvelope)}\n`, { mode: 0o600 });
    await expectCode(afterCrash.getThread({ threadId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(persistedFile, stableBytes, { mode: 0o600 });

    const eventTamperEnvelope = JSON.parse(stableBytes);
    const run = eventTamperEnvelope.state.runs.find((item) => item.id === runId);
    run.events[0].payload.status = "running";
    const unsigned = {
      schemaVersion: eventTamperEnvelope.schemaVersion,
      state: eventTamperEnvelope.state,
    };
    eventTamperEnvelope.digest = contractDigest(unsigned);
    await fs.writeFile(persistedFile, `${canonicalJson(eventTamperEnvelope)}\n`, { mode: 0o600 });
    await expectCode(afterCrash.getRunStatus({ runId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.writeFile(persistedFile, stableBytes, { mode: 0o600 });

    const realStateFile = `${persistedFile}.real`;
    await fs.rename(persistedFile, realStateFile);
    await fs.symlink(realStateFile, persistedFile);
    await expectCode(afterCrash.getRunStatus({ runId }, context()), "ANALYSIS_STATE_CORRUPT");
    await fs.unlink(persistedFile);
    await fs.rename(realStateFile, persistedFile);

    const symlinkRoot = path.join(temporaryRoot, "linked-state");
    await fs.symlink(root, symlinkRoot);
    const rejectsRootSymlink = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: symlinkRoot,
    });
    await expectCode(rejectsRootSymlink.getIntegrationCapabilities(), "ANALYSIS_STATE_CORRUPT");

    assert.throws(
      () => createTestOnlyIntegrationAnalysisSessionService({
        analysisRunner: fakeRunner,
        stateRoot: path.join(temporaryRoot, "bad-proof-state"),
        activationProof: { ready: true },
      }),
      /activation proof/iu
    );

    await afterCrash.close({ mode: "wait" });

    const queueRoot = path.join(temporaryRoot, "queue-state");
    const queueService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: queueRoot,
    });
    const queueThreads = [];
    for (let index = 0; index < 7; index += 1) {
      queueThreads.push((await queueService.createThread({ title: `Queue ${index + 1}` }, context())).thread);
    }
    const callsBeforeQueue = fakeRunner.calls.length;
    const firstHeld = await queueService.startRun(
      { threadId: queueThreads[0].id, input: { text: "hold queue slot one" } },
      context()
    );
    const secondHeld = await queueService.startRun(
      { threadId: queueThreads[1].id, input: { text: "hold queue slot two" } },
      context()
    );
    await waitFor(
      () => fakeRunner.held.has(firstHeld.run.id) && fakeRunner.held.has(secondHeld.run.id),
      "two bounded planner slots"
    );
    const queuedRuns = [];
    for (let index = 2; index < 6; index += 1) {
      queuedRuns.push(await queueService.startRun(
        { threadId: queueThreads[index].id, input: { text: `answer queued run ${index}` } },
        context()
      ));
    }
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 2, "queued work escaped the global concurrency bound");
    assert.ok(queuedRuns.every((item) => item.run.status === "starting"));
    const queueStatePath = await stateFile(queueRoot);
    const queueEnvelope = JSON.parse(await fs.readFile(queueStatePath, "utf8"));
    const queuedIds = new Set(queuedRuns.map((item) => item.run.id));
    assert.equal(
      queueEnvelope.state.runs.filter((item) => queuedIds.has(item.id) && item.schedulingState === "queued").length,
      4,
      "queued scheduling state was not durably persisted"
    );
    await expectCode(
      queueService.startRun(
        { threadId: queueThreads[6].id, input: { text: "overflow this scope queue" } },
        context()
      ),
      "ANALYSIS_SCOPE_QUEUE_SATURATED"
    );
    const additionalScopes = [
      context("principal-analysis-q001", "d".repeat(64)),
      context("principal-analysis-q002", "e".repeat(64)),
      context("principal-analysis-q003", "f".repeat(64)),
    ];
    for (const [scopeIndex, queueContext] of additionalScopes.entries()) {
      for (let index = 0; index < 4; index += 1) {
        const thread = await queueService.createThread(
          { title: `Global queue ${scopeIndex + 1}.${index + 1}` },
          queueContext
        );
        await queueService.startRun(
          { threadId: thread.thread.id, input: { text: `answer global queued run ${scopeIndex}.${index}` } },
          queueContext
        );
      }
    }
    const overflowContext = context("principal-analysis-q004", "9".repeat(64));
    const globalOverflowThread = await queueService.createThread({ title: "Global overflow" }, overflowContext);
    await expectCode(
      queueService.startRun(
        { threadId: globalOverflowThread.thread.id, input: { text: "overflow the global queue" } },
        overflowContext
      ),
      "ANALYSIS_QUEUE_SATURATED"
    );
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 2, "saturated queued work started early");
    await Promise.all([
      fakeRunner.held.get(firstHeld.run.id).release(),
      fakeRunner.held.get(secondHeld.run.id).release(),
    ]);
    await queueService.waitForIdle();
    assert.equal(fakeRunner.calls.length - callsBeforeQueue, 18);
    await queueService.close({ mode: "wait" });

    const drainRoot = path.join(temporaryRoot, "drain-state");
    const drainService = createTestOnlyIntegrationAnalysisSessionService({
      analysisRunner: fakeRunner,
      stateRoot: drainRoot,
    });
    const drainThread = await drainService.createThread({ title: "Bounded drain" }, context());
    const drainStarted = await drainService.startRun(
      { threadId: drainThread.thread.id, input: { text: "hold through bounded drain" } },
      context()
    );
    await waitFor(() => fakeRunner.held.has(drainStarted.run.id), "drain runner start");
    await expectCode(drainService.beginDrain({ mode: "wait", timeoutMs: 100 }), "ANALYSIS_DRAIN_TIMEOUT");
    await expectCode(
      drainService.startRun(
        { threadId: drainThread.thread.id, input: { text: "must be rejected while draining" } },
        context()
      ),
      "ANALYSIS_SERVICE_DRAINING"
    );
    const drained = await drainService.close({ mode: "abort", timeoutMs: 2_000 });
    assert.equal(drained.closed, true);
    const successor = createTestOnlyIntegrationAnalysisSessionService({ analysisRunner: fakeRunner, stateRoot: drainRoot });
    const drainedRun = (await successor.getRunStatus({ runId: drainStarted.run.id }, context())).run;
    assert.equal(drainedRun.status, "cancelled");
    await successor.close({ mode: "wait" });

    console.log("smoke-integration-analysis-session-service ok");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
