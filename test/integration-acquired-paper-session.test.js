import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { ACQUIRED_PAPER_MAXIMUM_BYTES } from "../src/integration-acquired-paper-contract.js";
import { inspectIntegrationFileWorkerArtifact } from "../src/integration-file-worker-client.js";
import { contractDigest } from "../src/integration-policy.js";
import { PAPER_ACQUISITION_SCHEMA as JOB } from "../src/integration-paper-acquisition-contract.js";
import { createPaperHttpWorker } from "./fixtures/paper-worker.js";
import { paperSourceArtifact } from "./fixtures/paper-source.js";
import { scope as sampleScope, source, pdf, issueRequest, importRequest, sha256 } from "./fixtures/acquired-paper.js";

const context = { principalId: sampleScope.principalId, browserSessionId: sampleScope.browserSessionId };
const prompt = "Attach the selected source paper.";
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function result(artifacts = []) {
  return {
    schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
    text: artifacts.length ? "The selected paper is ready below." : "The previous file is available.",
    kind: artifacts.length ? "analysis" : "direct", toolCalls: artifacts.length ? 1 : 0,
    executionStatus: artifacts.length ? "succeeded" : null, artifacts,
  };
}

async function fixture(t, { length = 775166, interruption = "", pause = "", wrongScope = false } = {}) {
  let service;
  const release = deferred();
  t.after(async () => { release.resolve(); await service?.close({ mode: "abort" }); });
  const worker = await createPaperHttpWorker(t);
  const stateRoot = path.join(worker.parent, "analysis");
  const captured = deferred();
  const calls = [];
  const runnerCalls = [];
  let available = true;
  let imported;
  let request;
  let runScope;
  const bytes = pdf(length);
  const client = worker.client(async (url, init) => {
    calls.push(new URL(url).pathname);
    if (!available) throw new Error("controlled test worker outage");
    return fetch(url, init);
  });
  const runner = {
    async run(scope, input, options) {
      runnerCalls.push(input);
      if (input.prompt !== prompt) {
        const done = result(); await options.onFinal(done); return done;
      }
      runScope = scope;
      const sources = paperSourceArtifact(input);
      await options.onArtifact(sources);
      const selection = await options.onPaperAcquireIntent({ schemaVersion: JOB.select, sourceArtifactId: sources.id, sourceIndex: 1 });
      const candidate = issueRequest(bytes);
      const canonical = await options.onPaperAcquireIntent({ schemaVersion: JOB.acquired, selection, authorityEpoch: 1,
        file: { ...candidate.files[0], filename: selection.filename }, source: { ...source, sourceId: selection.sourceId } });
      const issue = { ...canonical, scope: wrongScope ? { ...scope, principalId: "principal.wrong-paper-owner" } : scope };
      request = importRequest(issue, await client.issuePaper(issue));
      if (!wrongScope) await options.onPaperAcquireIntent({ schemaVersion: JOB.issued, request });
      imported = await client.importPaper(request, bytes, { signal: options.signal });
      await options.onArtifact(imported.artifacts[0]);
      assert.equal(await options.onFileCommitIntent(imported.artifacts), true);
      if (pause === "before") { captured.resolve(); await release.promise; options.signal.throwIfAborted(); }
      if (interruption === "before") { available = false; throw new Error("controlled pre-commit interruption"); }
      await client.commitArtifacts(scope, { receiptDigest: imported.receipt.digest, artifacts: imported.artifacts }, { signal: options.signal });
      if (pause === "after") { captured.resolve(); await release.promise; options.signal.throwIfAborted(); }
      if (interruption === "after") { available = false; throw new Error("controlled post-commit interruption"); }
      const done = result([sources, ...imported.artifacts]);
      await options.onFinal(done);
      return done;
    },
  };
  function open() {
    service = createTestOnlyIntegrationAnalysisSessionService({
      stateRoot, analysisRunner: runner, fileWorkerClient: client, fileWorkerEnabled: true, searchEnabled: true,
    });
  }
  open();
  const thread = (await service.createThread({ title: "Selected source paper" }, context)).thread;
  const run = (await service.startRun({ threadId: thread.id, input: { text: prompt, search: { mode: "papers", limit: 1 } } }, context)).run;
  async function persisted() {
    const directories = await fs.readdir(path.join(stateRoot, "scopes"));
    assert.equal(directories.length, 1);
    const file = path.join(stateRoot, "scopes", directories[0], "state.json");
    const raw = await fs.readFile(file, "utf8");
    return { file, raw, envelope: JSON.parse(raw) };
  }
  return {
    worker, client, calls, runnerCalls, thread, run, bytes, captured, release, persisted,
    get service() { return service; }, get imported() { return imported; }, get request() { return request; },
    get runScope() { return runScope; },
    setAvailable(value) { available = value; },
    async restart() { await service.close({ mode: "wait" }); open(); },
  };
}

async function finished(f) {
  await f.service.waitForIdle();
  const run = (await f.service.getRunStatus({ runId: f.run.id }, context)).run;
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  return (await f.service.listArtifacts({ runId: f.run.id }, context)).artifacts.filter(item => item.kind === "file");
}
async function content(f, artifactId, options = {}) {
  const response = await f.service.getArtifactContent({ artifactId, ...options }, context);
  try {
    const bytes = response.body ? Buffer.from(await new Response(response.body).arrayBuffer()) : null;
    return { ...response, bytes };
  } finally { response.cleanup(); }
}
async function events(f) {
  const response = await f.service.loadRunEvents({ runId: f.run.id, afterSeq: 0, afterHash: "0".repeat(64) }, context);
  return (await response.publicEventLedger.loadEventsAfter(0)).filter(event => event.payload?.artifact?.kind !== "sources");
}

test("a 16 MiB paper survives conversation storage, restart, scoped content and deletion", async t => {
  const f = await fixture(t, { length: ACQUIRED_PAPER_MAXIMUM_BYTES });
  const artifacts = await finished(f);
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  const saved = await f.persisted();
  const stored = saved.envelope.state.artifacts.find(item => item.kind === "file");
  assert.equal(stored.workerProfile, "acquired-paper-v1");
  assert.deepEqual(stored.paperReceipt, f.imported.receipt);
  assert.deepEqual(stored.paperReceipt.source, f.request.source);
  assert.doesNotMatch(saved.raw, /%PDF-|wpa_[A-Za-z0-9_-]{43}/u);
  assert.doesNotMatch(JSON.stringify(artifacts), /paperReceipt|workerProfile|workerRef|authorityToken|sourceUrl/u);
  assert.equal(sha256((await content(f, artifact.id)).bytes), sha256(f.bytes));
  assert.deepEqual((await content(f, artifact.id, { range: { start: 71, end: 777 } })).bytes, f.bytes.subarray(71, 778));
  assert.equal((await content(f, artifact.id, { metadataOnly: true })).totalBytes, f.bytes.length);
  for (const outsider of [{ ...context, principalId: "principal.other-paper-account" }, { ...context, browserSessionId: "b".repeat(64) }]) {
    await assert.rejects(f.service.getArtifact({ artifactId: artifact.id }, outsider), error => error.status === 404);
    await assert.rejects(f.service.getArtifactContent({ artifactId: artifact.id }, outsider), error => error.status === 404);
  }
  await f.restart();
  assert.deepEqual((await f.service.listArtifacts({ runId: f.run.id }, context)).artifacts.filter(item => item.kind === "file"), artifacts);
  assert.equal(sha256((await content(f, artifact.id)).bytes), sha256(f.bytes));
  const follow = await f.service.startRun({ threadId: f.thread.id, input: { text: "Which file did you just attach?" } }, context);
  await f.service.waitForIdle();
  assert.equal((await f.service.getRunStatus({ runId: follow.run.id }, context)).run.status, "completed");
  assert.equal(f.runnerCalls[1].priorArtifacts.find(item => item.kind === "file").id, artifact.id);
  assert.doesNotMatch(JSON.stringify(f.runnerCalls[1]), /paperReceipt|workerRef|authorityToken|sourceUrl/u);
  assert.equal((await f.service.deleteThread({ threadId: f.thread.id }, context)).deleted, true);
  assert(f.calls.filter(route => route === "/artifact/v1/files/delete").length >= 2);
  assert(!f.calls.includes("/artifact/v1/delete"));
  await assert.rejects(f.service.getArtifactContent({ artifactId: artifact.id }, context), error => error.status === 404);
  await assert.rejects(f.client.importPaper(f.request, f.bytes), error => error.status === 410);
});

for (const interruption of ["before", "after"]) test(`paper commit recovers after interruption ${interruption} worker commit`, async t => {
  const f = await fixture(t, { interruption });
  await f.service.waitForIdle();
  assert.equal((await f.service.getRunStatus({ runId: f.run.id }, context)).run.status, "running");
  assert.deepEqual((await f.service.listArtifacts({ runId: f.run.id }, context)).artifacts.filter(item => item.kind === "file"), []);
  assert(!(await events(f)).some(event => event.type === "artifact.created"));
  const saved = await f.persisted();
  assert.equal(saved.envelope.state.documentCommitIntents[0].status, "pending");
  assert.deepEqual(saved.envelope.state.artifacts.find(item => item.kind === "file").paperReceipt.source, f.request.source);
  await f.restart();
  f.setAvailable(true);
  const artifacts = await finished(f);
  assert.equal(artifacts.length, 1);
  assert.equal((await f.service.getRunStatus({ runId: f.run.id }, context)).run.output, "The verified files are ready below.");
  assert.equal(sha256((await content(f, artifacts[0].id)).bytes), sha256(f.bytes));
  assert.equal(f.calls.filter(route => route === "/artifact/v1/papers/import").length, 1);
  assert.equal(f.calls.filter(route => route === "/artifact/v1/papers/issue").length, 1);
  const replay = await events(f);
  assert.equal(replay.filter(event => event.type === "artifact.created").length, 1);
  assert.equal(replay.filter(event => event.type === "run.completed").length, 1);
  assert(!replay.some(event => event.type === "run.failed"));
  assert.equal((await f.service.deleteThread({ threadId: f.thread.id }, context)).deleted, true);
});

for (const pause of ["before", "after"]) test(`cancellation ${pause} paper commit cleans the file through restart/outage`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { pause });
  await Promise.race([f.captured.promise, f.service.waitForIdle().then(() => { throw new Error("runner stopped before capture barrier"); })]);
  assert.deepEqual((await f.service.listArtifacts({ runId: f.run.id }, context)).artifacts.filter(item => item.kind === "file"), []);
  f.setAvailable(false);
  assert.equal((await f.service.cancelRun({ runId: f.run.id }, context)).run.status, "cancelled");
  f.release.resolve();
  await f.service.waitForIdle();
  const saved = await f.persisted();
  assert.equal(saved.envelope.state.documentDeletionIntents[0].schemaVersion, "aginti-file-deletion-intent-v1");
  await f.restart();
  f.setAvailable(true);
  assert.equal((await f.service.getRunStatus({ runId: f.run.id }, context)).run.status, "cancelled");
  const recovered = await f.persisted();
  assert.equal(recovered.envelope.state.artifacts.filter(item => item.kind === "file").length, 0);
  assert.equal(recovered.envelope.state.documentDeletionIntents.length, 0);
  assert(!(await events(f)).some(event => event.type === "artifact.created"));
  await assert.rejects(f.client.importPaper(f.request, f.bytes), error => error.status === 410);
});

test("a paper sealed for another account is rejected before conversation capture", async t => {
  const f = await fixture(t, { wrongScope: true });
  await f.service.waitForIdle();
  assert.equal((await f.service.getRunStatus({ runId: f.run.id }, context)).run.status, "failed");
  const saved = await f.persisted();
  assert.equal(saved.envelope.state.artifacts.filter(item => item.kind === "file").length, 0);
  assert.equal(saved.envelope.state.documentCommitIntents.length, 0);
  const metadata = inspectIntegrationFileWorkerArtifact(f.imported.artifacts[0]);
  const { runId, ...ownerScope } = f.request.scope;
  const deletion = { deletionId: `fdel_${sha256("wrong-scope-fixture-cleanup")}`, phase: "prepare",
    objects: [{ ref: metadata.workerRef, runId, receiptDigest: metadata.receipt.digest }] };
  await f.client.deleteObjects(ownerScope, deletion);
  await f.client.deleteObjects(ownerScope, { ...deletion, phase: "commit" });
});

for (const mutation of ["source", "receipt-missing", "profile", "bytes", "scope", "intent-missing", "selection", "acquired-hash"]) test(`persisted paper ${mutation} tampering fails closed`, async t => {
  const f = await fixture(t);
  await finished(f);
  await f.service.close({ mode: "wait" });
  const saved = await f.persisted();
  const record = saved.envelope.state.artifacts.find(item => item.kind === "file");
  if (mutation === "source") record.paperReceipt.source.sourceUrl = "https://papers.example.org/other.pdf";
  if (mutation === "receipt-missing") delete record.paperReceipt;
  if (mutation === "profile") record.workerProfile = "file-bundle-v1";
  if (mutation === "bytes") record.spec.bytes -= 1;
  if (mutation === "scope") record.paperReceipt.scopeDigest = "1".repeat(64);
  if (mutation === "intent-missing") delete saved.envelope.state.runs[0].paperAcquisitionIntent;
  if (mutation === "selection") saved.envelope.state.runs[0].paperAcquisitionIntent.selection.sourceDigest = "2".repeat(64);
  if (mutation === "acquired-hash") saved.envelope.state.runs[0].paperAcquisitionIntent.issue.files[0].sha256 = "3".repeat(64);
  const { digest: _digest, ...unsigned } = saved.envelope;
  await fs.writeFile(saved.file, JSON.stringify({ ...unsigned, digest: contractDigest(unsigned) }) + "\n", { mode: 0o600 });
  await f.restart();
  await assert.rejects(f.service.getThread({ threadId: f.thread.id }, context), error => error.code === "ANALYSIS_STATE_CORRUPT");
});
