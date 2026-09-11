import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_STATE_PERSISTENCE_MODES as MODES } from "../src/integration-analysis-state-persistence.js";
import { validatePaperCheckpoint, PAPER_RECOVERY_ATTEMPTS } from "../src/integration-paper-checkpoint.js";
import { createPaperHttpWorker } from "./fixtures/paper-worker.js";
import { paperRecoveryRunner } from "./fixtures/paper-recovery-runner.js";

const owner = { principalId: "paper-recovery-owner", browserSessionId: "a".repeat(64) };

async function persisted(stateRoot) {
  const dirs = await fs.readdir(path.join(stateRoot, "scopes"));
  assert.equal(dirs.length, 1);
  return JSON.parse(await fs.readFile(path.join(stateRoot, "scopes", dirs[0], "state.json"), "utf8")).state;
}

async function crashAt(t, config) {
  const child = fork(new URL("./fixtures/paper-recovery-child.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: {},
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture checkpoint timed out: ${stderr}`)), 10000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.on("message", message => {
      messages.push(message);
      if (message.error) finish(new Error(message.error));
      else if (message.stage === config.stopAt) finish();
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(new Error(`child exited ${code}/${signal}: ${stderr}`)));
    child.send({ owner, ...config });
  });
  child.kill("SIGKILL");
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  // Accelerate only the dead fixture lock's 60-second age threshold. Its actual
  // PID/boot identity and every durable run/worker byte remain untouched.
  const lockPath = path.join(config.stateRoot, ".analysis-session-owner.lock", "owner.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(lock.pid, child.pid);
  lock.acquiredAt = "2000-01-01T00:00:00.000Z";
  await fs.writeFile(lockPath, JSON.stringify(lock), { mode: 0o600 });
  return messages;
}

async function open(t, worker, stateRoot, options = {}) {
  const client = worker.client();
  const runner = paperRecoveryRunner(client, options);
  const service = createTestOnlyIntegrationAnalysisSessionService({ stateRoot, analysisRunner: runner,
    fileWorkerClient: client, fileWorkerEnabled: true, searchEnabled: true, statePersistenceMode: MODES.nativeV3 });
  // Registered after worker cleanup by node:test; close explicitly in tests too.
  t.after(() => service.close({ mode: "abort" }));
  const proof = await service.recoverBeforeListen();
  return { service, runner, proof };
}

for (const stopAt of ["before-download", "after-issue", "after-import", "after-commit", "after-final-callback"]) {
  test(`process loss ${stopAt} resumes the same selected PDF and run`, async t => {
    const worker = await createPaperHttpWorker(t);
    const stateRoot = path.join(worker.parent, "analysis");
    await crashAt(t, { stateRoot, endpoint: `http://127.0.0.1:${worker.port}`, stopAt });
    const before = await persisted(stateRoot);
    const original = before.runs[0];
    const { service, runner, proof } = await open(t, worker, stateRoot);
    assert.equal(proof.rescheduledPaperRuns, 1);
    assert.equal(proof.nonterminalRunsRecovered, 0, "queued work is not completed work");
    await service.waitForIdle();
    const state = await persisted(stateRoot);
    assert.equal(state.runs.length, 1);
    const run = state.runs[0];
    assert.equal(run.id, original.id);
    assert.equal(run.startedAt, original.startedAt);
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.equal(run.paperPlannerCheckpoint.recoveryAttempts, 1);
    assert.equal(run.paperPlannerCheckpoint.completionText, run.output);
    const completed = run.events.filter(event => event.type === "tool.completed");
    assert(completed.some(event => event.payload.callId === "source-paper-1-recovery-1"));
    assert.deepEqual(run.paperAcquisitionIntent.selection, original.paperAcquisitionIntent.selection);
    if (original.paperAcquisitionIntent.issued) assert.deepEqual(run.paperAcquisitionIntent.issued, original.paperAcquisitionIntent.issued);
    assert.equal(runner.resumed.length, 1);
    assert.equal(runner.resumed[0].selection.sourceArtifactId, original.paperPlannerCheckpoint.selection.sourceArtifactId);
    assert.equal(state.artifacts.filter(item => item.kind === "file").length, 1);
    assert.equal(state.documentCommitIntents.length, 1);
    assert(state.documentCommitIntents.every(intent => intent.status === "committed" && intent.eventsPublished));
    assert.equal(state.threads[0].messages.filter(message => message.role === "assistant").length, 1);
    await assert.rejects(service.getRunStatus({ runId: run.id }, { ...owner, principalId: "other-owner" }));
    await assert.rejects(service.getRunStatus({ runId: run.id }, { ...owner, browserSessionId: "b".repeat(64) }));
    const artifacts = (await service.listArtifacts({ runId: run.id }, owner)).artifacts;
    assert.equal(artifacts.filter(item => item.kind === "file").length, 1);
    await service.close({ mode: "wait" });
    const reopened = await open(t, worker, stateRoot);
    await reopened.service.waitForIdle();
    assert.equal(reopened.runner.resumed.length, 0, "completed work never replays");
    await reopened.service.close({ mode: "wait" });
  });
}

test("continuation interrupted after paper commit stays incomplete", async t => {
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "analysis");
  await crashAt(t, { stateRoot, endpoint: `http://127.0.0.1:${worker.port}`, stopAt: "continuation", additionalOutputs: true });
  const { service, runner } = await open(t, worker, stateRoot, { additionalOutputs: true });
  await service.waitForIdle();
  const state = await persisted(stateRoot);
  assert.equal(state.runs[0].status, "failed");
  assert.equal(state.runs[0].error.code, "RUN_INTERRUPTED");
  assert.equal(state.runs[0].paperPlannerCheckpoint.completionText, null);
  assert.equal(runner.resumed.length, 0, "uncheckpointed follow-on work must not repeat");
  assert.equal(state.artifacts.filter(item => item.kind === "file").length, 1);
  await service.close({ mode: "wait" });
});

test("paper continuation failure and callback disagreement are not promoted to success", async t => {
  const worker = await createPaperHttpWorker(t);
  for (const options of [{ additionalOutputs: true, failContinuation: true }, { disagreeAfterFinal: true }]) {
    const stateRoot = path.join(worker.parent, options.failContinuation ? "failed" : "disagreed");
    const { service } = await open(t, worker, stateRoot, options);
    const { thread } = await service.createThread({ title: "Completion boundary" }, owner);
    const { run } = await service.startRun({ threadId: thread.id, input: { text: "Find the source paper PDF.", search: { mode: "papers", limit: 2 } } }, owner);
    await service.waitForIdle();
    await service.getRunStatus({ runId: run.id }, owner);
    const state = await persisted(stateRoot);
    assert.equal(state.runs[0].status, "failed");
    assert.equal(state.runs[0].paperPlannerCheckpoint.completionText, null);
    assert.equal(state.threads[0].messages.filter(message => message.role === "assistant").length, 0);
    await service.close({ mode: "wait" });
  }
});

test("automatic process recovery has a durable two-restart budget", async t => {
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "analysis");
  const config = { stateRoot, endpoint: `http://127.0.0.1:${worker.port}`, stopAt: "before-download" };
  await crashAt(t, config);
  for (let attempt = 1; attempt <= PAPER_RECOVERY_ATTEMPTS; attempt += 1) {
    await crashAt(t, { ...config, restart: true });
    assert.equal((await persisted(stateRoot)).runs[0].paperPlannerCheckpoint.recoveryAttempts, attempt);
  }
  const { service, runner } = await open(t, worker, stateRoot);
  await service.waitForIdle();
  assert.equal(runner.resumed.length, 0);
  assert.equal((await persisted(stateRoot)).runs[0].status, "failed");
  await service.close({ mode: "wait" });
});

test("checkpoint has a bounded exact schema", async t => {
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "analysis");
  await crashAt(t, { stateRoot, endpoint: `http://127.0.0.1:${worker.port}`, stopAt: "before-download" });
  const checkpoint = (await persisted(stateRoot)).runs[0].paperPlannerCheckpoint;
  assert.deepEqual(validatePaperCheckpoint(checkpoint), checkpoint);
  for (const patch of [{ recoveryAttempts: 3 }, { token: "not-a-state-field" }, { report: "x".repeat(16385) }, { continuationStarted: 1 }]) {
    assert.throws(() => validatePaperCheckpoint({ ...checkpoint, ...patch }));
  }
});

test("startup shares the bounded queue, drains deferred owners, and honors queued cancellation", async t => {
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "combined");
  const scopesRoot = path.join(stateRoot, "scopes");
  await fs.mkdir(scopesRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);
  // Twenty independent real interrupted scopes; combine only their immutable
  // fixture scope directories. Live-state roots/locks are never involved.
  for (let index = 0; index < 20; index += 1) {
    const sourceRoot = path.join(worker.parent, `owner-${index}`);
    await crashAt(t, { stateRoot: sourceRoot, endpoint: `http://127.0.0.1:${worker.port}`,
      stopAt: "before-download", owner: { ...owner, principalId: `${owner.principalId}-${index}` } });
    for (const dir of await fs.readdir(path.join(sourceRoot, "scopes"))) {
      await fs.cp(path.join(sourceRoot, "scopes", dir), path.join(scopesRoot, dir), { recursive: true });
    }
  }
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let running = 0;
  let peak = 0;
  let service;
  try {
    const opened = await open(t, worker, stateRoot, { stage: async name => {
      if (name !== "before-download") return;
      running += 1;
      peak = Math.max(peak, running);
      await held;
      running -= 1;
      throw new Error("fixture stops after queue admission; no network or model call");
    } });
    service = opened.service;
    assert.equal(opened.proof.rescheduledPaperRuns, 16);
    assert.equal(opened.proof.deferredPaperRuns, 4);
    assert.equal(opened.proof.nonterminalRunsRemaining, 20);
    for (let attempt = 0; running < 2 && attempt < 200; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(running, 2);
    const files = (await fs.readdir(scopesRoot)).map(dir => path.join(scopesRoot, dir, "state.json"));
    const states = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, "utf8")).state));
    const queued = states.find(state => state.runs[0].schedulingState === "queued");
    assert(queued);
    await service.cancelRun({ runId: queued.runs[0].id }, queued.scope);
    release();
    await service.waitForIdle();
    assert.equal(peak, 2);
    assert.equal(opened.runner.resumed.length, 19);
    assert.equal(opened.runner.downloads.length, 0);
    const final = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, "utf8")).state.runs[0]));
    assert.equal(final.filter(run => run.status === "cancelled").length, 1);
    assert.equal(final.filter(run => run.status === "failed").length, 19);
    assert(final.every(run => run.paperPlannerCheckpoint.recoveryAttempts === 1));
  } finally {
    release();
    await service?.close({ mode: "wait" });
  }
});

test("an incomplete pre-listen audit dispatches no recovered planner", async t => {
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "combined");
  await fs.mkdir(path.join(stateRoot, "scopes"), { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);
  for (let index = 0; index < 2; index += 1) {
    const sourceRoot = path.join(worker.parent, `owner-${index}`);
    await crashAt(t, { stateRoot: sourceRoot, endpoint: `http://127.0.0.1:${worker.port}`, stopAt: "before-download",
      owner: { ...owner, principalId: `${owner.principalId}-${index}` } });
    for (const dir of await fs.readdir(path.join(sourceRoot, "scopes"))) {
      await fs.cp(path.join(sourceRoot, "scopes", dir), path.join(stateRoot, "scopes", dir), { recursive: true });
    }
  }
  const client = worker.client();
  const runner = paperRecoveryRunner(client);
  const service = createTestOnlyIntegrationAnalysisSessionService({ stateRoot, analysisRunner: runner,
    fileWorkerClient: client, fileWorkerEnabled: true, searchEnabled: true, statePersistenceMode: MODES.nativeV3,
    beforeStartupRecoveryScope: async ({ index }) => { if (index === 1) throw new Error("fixture pre-listen failure"); } });
  try {
    await assert.rejects(service.recoverBeforeListen(), /fixture pre-listen failure/);
    await service.waitForIdle();
    assert.equal(runner.resumed.length, 0);
    assert.equal(runner.downloads.length, 0);
  } finally { await service.close({ mode: "wait" }); }
});
