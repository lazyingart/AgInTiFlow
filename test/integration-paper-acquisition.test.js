import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTestOnlyIntegrationAnalysisSessionService } from "../src/integration-analysis-session-service.js";
import { INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION } from "../src/integration-analysis-planner.js";
import { ACQUIRED_PAPER_MAXIMUM_BYTES } from "../src/integration-acquired-paper-contract.js";
import {
  PAPER_ACQUISITION_SCHEMA as JOB, paperSelectionFromArtifact,
  createPaperAcquisitionIntent, advancePaperAcquisitionIntent,
} from "../src/integration-paper-acquisition-contract.js";
import {
  createIntegrationPaperAcquisitionClient, createTestOnlyIntegrationPaperAcquisitionClient,
  assertIntegrationPaperAcquisitionClient,
} from "../src/integration-paper-acquisition.js";
import { createPublicPdfDownloader, createTestOnlyPublicPdfDownloader } from "../src/public-pdf-download.js";
import { contractDigest } from "../src/integration-policy.js";
import { createPaperHttpWorker } from "./fixtures/paper-worker.js";
import { paperSourceArtifact } from "./fixtures/paper-source.js";
import { pdf, scope, sha256 } from "./fixtures/acquired-paper.js";

const context = { principalId: scope.principalId, browserSessionId: scope.browserSessionId };
const input = { text: "Find and attach one source paper.", search: { mode: "papers", limit: 2 } };
const select = sourceArtifactId => ({ schemaVersion: JOB.select, sourceArtifactId, sourceIndex: 1 });
const fileArtifacts = items => items.filter(item => item.kind === "file");
const sampleSources = paperSourceArtifact({ prompt: input.text, search: input.search });

async function fixture(t, { enabled = true, onLookup, response, body = () => pdf(), maximumBytes = ACQUIRED_PAPER_MAXIMUM_BYTES } = {}) {
  let service;
  t.after(async () => { await service?.close({ mode: "abort" }); });
  const worker = await createPaperHttpWorker(t, { paperImport: enabled });
  const stateRoot = path.join(worker.parent, "analysis");
  const requests = [];
  const downloads = [];
  const failures = [];
  const client = worker.client(async (url, init) => {
    const route = new URL(url).pathname;
    requests.push({ route, ...(route.endsWith("/issue") ? { issue: JSON.parse(init.body) } : {}) });
    return response ? response({ url, init, route, requests, persisted }) : fetch(url, init);
  });
  const downloader = createTestOnlyPublicPdfDownloader({ allowedOrigins: ["https://papers.example.org"], maximumBytes, timeoutMs: 1000 }, {
    async lookup() {
      const saved = await persisted();
      assert(saved.state.runs.at(-1).paperAcquisitionIntent, "selection must be durable before DNS");
      await onLookup?.(saved);
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
  const acquisition = createTestOnlyIntegrationPaperAcquisitionClient({ downloader, fileWorkerClient: client });
  let behavior;
  const runner = {
    async run(runScope, runnerInput, options) {
      try {
        const sources = runnerInput.search ? paperSourceArtifact(runnerInput) : null;
        if (sources) await options.onArtifact(sources);
        const artifacts = await behavior({ scope: runScope, input: runnerInput, options, sources });
        const result = { schemaVersion: INTEGRATION_ANALYSIS_PLANNER_SCHEMA_VERSION,
          text: "The requested operation completed.", kind: "direct", toolCalls: 0, executionStatus: null,
          artifacts: [...(sources ? [sources] : []), ...(artifacts ?? [])] };
        await options.onFinal(result);
        return result;
      } catch (error) { failures.push(error); throw error; }
    },
  };
  function open() {
    service = createTestOnlyIntegrationAnalysisSessionService({ stateRoot, analysisRunner: runner,
      fileWorkerClient: client, fileWorkerEnabled: true, searchEnabled: true });
  }
  open();
  const thread = (await service.createThread({ title: "Paper acquisition" }, context)).thread;
  async function persisted() {
    const dirs = await fs.readdir(path.join(stateRoot, "scopes"));
    for (const dir of dirs) {
      const value = JSON.parse(await fs.readFile(path.join(stateRoot, "scopes", dir, "state.json"), "utf8"));
      if (value.state.scope.principalId === context.principalId && value.state.scope.browserSessionId === context.browserSessionId) return value;
    }
    throw new Error("fixture owner state missing");
  }
  return {
    worker, client, downloader, acquisition, thread, requests, downloads, failures, persisted,
    get service() { return service; },
    async start(handler, overrides = {}, owner = context) {
      behavior = handler;
      return (await service.startRun({ threadId: thread.id, input, ...overrides }, owner)).run;
    },
    async finish(run, status = "completed") {
      await service.waitForIdle();
      const actual = (await service.getRunStatus({ runId: run.id }, context)).run;
      assert.equal(actual.status, status, failures.map(error => error.stack).join("\n"));
      return (await service.listArtifacts({ runId: run.id }, context)).artifacts;
    },
    async restart() { await service.close({ mode: "wait" }); open(); },
    async publish(runScope, options, imported) {
      for (const artifact of imported.artifacts) await options.onArtifact(artifact);
      assert.equal(await options.onFileCommitIntent(imported.artifacts), true);
      await client.commitArtifacts(runScope, { receiptDigest: imported.receipt.digest, artifacts: imported.artifacts }, { signal: options.signal });
      return imported.artifacts;
    },
  };
}

test("source selection uses the recorded arXiv identity and preserves explicit versions", () => {
  for (const [url, expected, version] of [
    ["https://arxiv.org/abs/1810.04805v2", "https://arxiv.org/pdf/1810.04805v2", "v2"],
    ["https://arxiv.org/pdf/1810.04805.pdf", "https://arxiv.org/pdf/1810.04805", null],
    ["https://arxiv.org/abs/hep-th/9901001v1", "https://arxiv.org/pdf/hep-th/9901001v1", "v1"],
    ["https://arxiv.org/abs/math.GT/0309136v1", "https://arxiv.org/pdf/math.GT/0309136v1", "v1"],
  ]) {
    const artifact = { ...sampleSources, spec: { ...sampleSources.spec, sources: [{ ...sampleSources.spec.sources[0], url }] } };
    const selected = paperSelectionFromArtifact(artifact, 1);
    assert.equal(selected.pdfUrl, expected);
    assert.equal(selected.version, version);
    assert.equal(selected.sourceDigest, contractDigest(artifact.spec.sources[0]));
  }
});

for (const url of ["https://example.org/landing", "https://arxiv.org/abs/garbage", "https://papers.example.org/paper.pdf?token=private",
  "https://arxiv.org/abs/1810.04805#fragment", "https://arxiv.org.evil.example/abs/1810.04805",
  "http://papers.example.org/paper.pdf", "https://127.0.0.1/paper.pdf"]) {
  test(`an ineligible citation is rejected before acquisition: ${url}`, () => {
    const artifact = { ...sampleSources, spec: { ...sampleSources.spec, sources: [{ ...sampleSources.spec.sources[0], url }] } };
    assert.throws(() => paperSelectionFromArtifact(artifact, 1));
  });
}

test("a selected paper flows through real HTTP storage and survives a session restart", async t => {
  const f = await fixture(t, { response: async ({ url, init, route, persisted }) => {
    const saved = await persisted();
    const intent = saved.state.runs.at(-1).paperAcquisitionIntent;
    if (route.endsWith("/issue")) assert(intent.issue);
    if (route.endsWith("/import")) assert(intent.issued);
    assert.doesNotMatch(JSON.stringify(saved), /wpa_[A-Za-z0-9_-]{43}|%PDF-/u);
    return fetch(url, init);
  } });
  const run = await f.start(async ({ scope, options, sources }) => {
    const imported = await f.acquisition.acquire(select(sources.id), optionsFor(options));
    return f.publish(scope, options, imported);
  });
  const files = fileArtifacts(await f.finish(run));
  assert.equal(files.length, 1);
  assert.equal(files[0].spec.sha256, sha256(pdf()));
  const saved = await f.persisted();
  assert.equal(saved.state.runs[0].paperAcquisitionIntent.selection.sourceArtifactId, saved.state.artifacts[0].id);
  assert.deepEqual(f.downloads, ["/paper.pdf"]);
  await f.restart();
  assert.deepEqual(fileArtifacts(await f.finish(run)), files);
  assert.doesNotMatch(JSON.stringify(await f.service.getRunStatus({ runId: run.id }, context)), /paperAcquisitionIntent|sourceDigest|authorityToken|issuanceId/u);
  await f.service.deleteThread({ threadId: f.thread.id }, context);
});

function optionsFor(options) { return { signal: options.signal, onPaperAcquireIntent: options.onPaperAcquireIntent }; }

for (const lost of ["issue", "import"]) test(`an uncertain ${lost} response reuses the original acquisition and operation`, async t => {
  let lostOnce = false;
  const f = await fixture(t, { response: async ({ url, init, route }) => {
    const response = await fetch(url, init);
    if (!lostOnce && route === `/artifact/v1/papers/${lost}`) {
      lostOnce = true; await response.arrayBuffer(); throw new Error("synthetic response loss");
    }
    return response;
  } });
  let first;
  const run = await f.start(async ({ scope, options, sources }) => {
    await assert.rejects(f.acquisition.acquire(select(sources.id), optionsFor(options)));
    first = (await f.persisted()).state.runs.at(-1).paperAcquisitionIntent;
    const imported = await f.acquisition.acquire(select(sources.id), optionsFor(options));
    const current = (await f.persisted()).state.runs.at(-1).paperAcquisitionIntent;
    assert.deepEqual(current.issue, first.issue);
    assert.equal(imported.receipt.source.acquiredAt, first.issue.source.acquiredAt);
    if (lost === "import") assert.deepEqual(current.issued, first.issued);
    return f.publish(scope, options, imported);
  });
  assert.equal(fileArtifacts(await f.finish(run)).length, 1);
  assert.equal(f.downloads.length, 2);
  const issues = f.requests.filter(item => item.issue).map(item => item.issue);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], issues[1]);
  const snapshot = await f.worker.fileStore.inspect();
  assert.equal(snapshot.groups, 1);
  await f.service.deleteThread({ threadId: f.thread.id }, context);
});

test("a changed PDF on retry does not silently replace the accepted file", async t => {
  let lost = false;
  const f = await fixture(t, { body: count => pdf(count === 1 ? 775166 : 775167),
    response: async ({ url, init, route }) => {
      const response = await fetch(url, init);
      if (!lost && route.endsWith("/issue")) { lost = true; await response.arrayBuffer(); throw new Error("lost response"); }
      return response;
    } });
  const run = await f.start(async ({ options, sources }) => {
    await assert.rejects(f.acquisition.acquire(select(sources.id), optionsFor(options)));
    const first = (await f.persisted()).state.runs.at(-1).paperAcquisitionIntent;
    await assert.rejects(f.acquisition.acquire(select(sources.id), optionsFor(options)), error => error.code === "ANALYSIS_PAPER_AUTHORITY_INVALID");
    assert.deepEqual((await f.persisted()).state.runs.at(-1).paperAcquisitionIntent, first);
  });
  await f.finish(run, "failed");
  assert.equal(f.requests.filter(item => item.route.endsWith("/issue")).length, 1);
  assert.equal(f.requests.filter(item => item.route.endsWith("/import")).length, 0);
});

test("disabled paper creation records selection but performs no DNS, download or issue", async t => {
  const f = await fixture(t, { enabled: false });
  const run = await f.start(async ({ options, sources }) => f.acquisition.acquire(select(sources.id), optionsFor(options)));
  await f.finish(run, "failed");
  assert.equal(f.failures[0].code, "ANALYSIS_PAPER_DISABLED");
  assert.equal(f.downloads.length, 0);
  assert.equal((await f.persisted()).state.runs[0].paperAcquisitionIntent.issue, null);
  assert.deepEqual(f.requests.map(item => item.route), ["/artifact/v1/papers/readiness"]);
});

test("a selected paper cannot be reported complete before a committed artifact exists", async t => {
  const f = await fixture(t);
  const run = await f.start(async ({ options, sources }) => {
    await options.onPaperAcquireIntent(select(sources.id));
    return [];
  });
  await f.finish(run, "failed");
  const status = (await f.service.getRunStatus({ runId: run.id }, context)).run;
  assert.equal(status.error.code, "ANALYSIS_PAPER_ARTIFACT_REQUIRED");
  assert.equal(status.output, "");
  assert.deepEqual(f.requests, []);
});

test("selection rejects injected URLs and wrong source rows before contacting a worker", async t => {
  const f = await fixture(t);
  const run = await f.start(async ({ options, sources }) => {
    for (const request of [{ ...select(sources.id), sourceIndex: 2 }, { ...select(sources.id), url: "https://papers.example.org/other.pdf" }, select(`art_${"e".repeat(64)}`)]) {
      await assert.rejects(f.acquisition.acquire(request, optionsFor(options)));
    }
  });
  await f.finish(run);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.downloads, []);
  assert.equal((await f.persisted()).state.runs[0].paperAcquisitionIntent, undefined);
});

test("a preceding completed search can be selected; another thread and older context cannot", async t => {
  const f = await fixture(t);
  const first = await f.start(async () => []);
  const previous = (await f.finish(first)).find(item => item.kind === "sources");
  const other = (await f.service.createThread({ title: "Other conversation" }, context)).thread;
  const denied = await f.start(async ({ options }) => {
    await assert.rejects(f.acquisition.acquire(select(previous.id), optionsFor(options)), error => error.code === "ANALYSIS_PAPER_SOURCE_UNAVAILABLE");
  }, { threadId: other.id, input: { text: "Attach that paper.", searchInference: false } });
  await f.finish(denied);
  assert.equal(f.requests.length, 0);
  const follow = await f.start(async ({ scope, options, input }) => {
    assert.equal(input.priorArtifacts[0].id, previous.id);
    const imported = await f.acquisition.acquire(select(previous.id), optionsFor(options));
    return f.publish(scope, options, imported);
  }, { input: { text: "Attach that paper.", searchInference: false } });
  assert.equal(fileArtifacts(await f.finish(follow)).length, 1);
  const later = await f.start(async ({ options }) => {
    await assert.rejects(f.acquisition.acquire(select(previous.id), optionsFor(options)), error => error.code === "ANALYSIS_PAPER_SOURCE_UNAVAILABLE");
  }, { input: { text: "Use an older hidden source.", searchInference: false } });
  await f.finish(later);
  await f.service.deleteThread({ threadId: f.thread.id }, context);
});

test("a cancelled acquisition cannot proceed to network or issuance", async t => {
  const f = await fixture(t);
  const run = await f.start(async ({ options, sources }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.acquisition.acquire(select(sources.id), { ...optionsFor(options), signal: controller.signal }));
  });
  await f.finish(run);
  assert.deepEqual(f.requests, []);
});

test("a source artifact from another account or browser session grants no acquisition authority", async t => {
  const f = await fixture(t);
  for (const outsider of [{ ...context, principalId: "principal.other-paper-user" }, { ...context, browserSessionId: "e".repeat(64) }]) {
    const other = (await f.service.createThread({ title: "Private source search" }, outsider)).thread;
    const search = await f.start(async () => [], { threadId: other.id }, outsider);
    await f.service.waitForIdle();
    assert.equal((await f.service.getRunStatus({ runId: search.id }, outsider)).run.status, "completed");
    const source = (await f.service.listArtifacts({ runId: search.id }, outsider)).artifacts[0];
    const denied = await f.start(async ({ options }) => {
      await assert.rejects(f.acquisition.acquire(select(source.id), optionsFor(options)), error => error.code === "ANALYSIS_PAPER_SOURCE_UNAVAILABLE");
    });
    await f.finish(denied);
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.downloads, []);
});

test("a pre-import failure retains selection through restart without inventing a completed download", async t => {
  const f = await fixture(t, { onLookup: () => { throw new Error("synthetic source outage"); } });
  const run = await f.start(async ({ options, sources }) => f.acquisition.acquire(select(sources.id), optionsFor(options)));
  await f.finish(run, "failed");
  const before = (await f.persisted()).state.runs[0].paperAcquisitionIntent;
  assert(before.selection.sourceDigest);
  assert.equal(before.issue, null);
  await f.restart();
  assert.equal(fileArtifacts(await f.finish(run, "failed")).length, 0);
  assert.deepEqual((await f.persisted()).state.runs[0].paperAcquisitionIntent, before);
  assert.deepEqual(f.downloads, []);
});

test("test clients and an overlarge downloader cannot be used as production acquisition", async t => {
  const f = await fixture(t);
  assert.throws(() => createIntegrationPaperAcquisitionClient({ downloader: f.downloader, fileWorkerClient: f.client }));
  assert.throws(() => assertIntegrationPaperAcquisitionClient(f.acquisition));
  assert.throws(() => assertIntegrationPaperAcquisitionClient({ ...f.acquisition }, { allowTestOnly: true }));
  assert.equal(assertIntegrationPaperAcquisitionClient(f.acquisition, { allowTestOnly: true }), f.acquisition);
  assert.equal(assertIntegrationPaperAcquisitionClient(f.acquisition, { allowTestOnly: true, fileWorkerClient: f.client }), f.acquisition);
  assert.throws(() => assertIntegrationPaperAcquisitionClient(f.acquisition, { allowTestOnly: true, fileWorkerClient: f.worker.client() }));
  assert.equal((await f.acquisition.readiness()).creationEnabled, true);
  const large = createPublicPdfDownloader({ allowedOrigins: ["https://arxiv.org"] });
  assert.throws(() => createTestOnlyIntegrationPaperAcquisitionClient({ downloader: large, fileWorkerClient: f.client }));
});

test("issuance replay preserves source, byte hash, version, time, epoch and scope", () => {
  const selection = paperSelectionFromArtifact(sampleSources, 1);
  const intent = createPaperAcquisitionIntent(selection, "2026-09-11T10:00:00.000Z");
  const candidate = { schemaVersion: JOB.acquired, selection, authorityEpoch: 1,
    file: { index: 0, filename: selection.filename, mime: "application/pdf", bytes: 775166, sha256: sha256(pdf()) },
    source: { sourceId: selection.sourceId, sourceUrl: selection.pdfUrl, finalUrl: selection.pdfUrl,
      doi: null, version: null, acquiredAt: "2026-09-11T10:00:01.000Z" } };
  const first = advancePaperAcquisitionIntent(intent, candidate, selection, scope);
  assert.deepEqual(advancePaperAcquisitionIntent(first.intent, { ...candidate, source: { ...candidate.source, acquiredAt: "2026-09-11T10:01:00.000Z" } }, selection, scope).result, first.result);
  for (const changed of [
    { ...candidate, authorityEpoch: 2 },
    { ...candidate, file: { ...candidate.file, sha256: "d".repeat(64) } },
    { ...candidate, source: { ...candidate.source, finalUrl: "https://papers.example.org/other.pdf" } },
    { ...candidate, source: { ...candidate.source, doi: "10.1234/other" } },
    { ...candidate, source: { ...candidate.source, version: "v2" } },
  ]) assert.throws(() => advancePaperAcquisitionIntent(first.intent, changed, selection, scope));
  assert.throws(() => advancePaperAcquisitionIntent(first.intent, candidate, selection, { ...scope, principalId: "principal.other" }));
});
