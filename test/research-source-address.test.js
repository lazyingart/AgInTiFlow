import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { readWebPage, canonicalizeWebUrl } = await import(pathToFileURL(path.join(root, "src/web-search.js")));
const { recordDurableResearchEvidence, formatDurableResearchEvidence } = await import(pathToFileURL(path.join(root, "src/durable-research-evidence.js")));
const { deepResearch, RESEARCH_VERSION } = await import(pathToFileURL(path.join(root, "src/deep-research.js")));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const html = label => `<main><h1>Synthetic source ${label}</h1><p>Revision ${label} records only its own bounded synthetic evidence.</p></main>`;
const config = body => ({ allowedDomains: ["arxiv.org", "docs.example.org"], webPageFetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }) });

for (const url of ["https://arxiv.org/abs/2301.01234v1", "https://arxiv.org/html/2301.01234v7", "https://arxiv.org/abs/hep-th/9901001v2", "https://arxiv.org/pdf/2301.01234v3.pdf"]) {
  test(`page evidence retains the exact revision and representation: ${url}`, async () => {
    const body = html("pinned"), result = await readWebPage({ url }, config(body));
    assert.equal(result.ok, true);assert.equal(result.url, url);assert.equal(result.canonicalUrl, url);assert.equal(result.requestedUrl, url);assert.equal(result.sha256, hash(body));
  });
}
test("different arXiv revision reads retain independent URL/hash evidence", async () => {
  const state = {}, snapshots = [];
  for (const version of [1, 7]) {
    const url = `https://arxiv.org/abs/2301.01234v${version}`, body = html(String(version));
    const result = await readWebPage({ url }, config(body));recordDurableResearchEvidence(state, result);snapshots.push({ url, hash: hash(body) });
  }
  assert.deepEqual(state.meta.durableResearchEvidence.map(e => ({ url: e.url, hash: e.sha256 })), snapshots);
  const reloaded = JSON.parse(JSON.stringify(state));assert.equal(reloaded.meta.durableResearchEvidence.length, 2);
  const context = formatDurableResearchEvidence(reloaded.meta.durableResearchEvidence).join("\n");
  for (const item of snapshots) { assert.ok(context.includes(item.url));assert.ok(context.includes(item.hash.slice(0, 16))); }
});
test("HTML and PDF are different retrieved representations of the same paper", async () => {
  const state = {}, bytes = Buffer.from("SYNTHETIC_PDF_BYTES_NOT_A_REAL_DOCUMENT");
  for (const [url, type] of [["https://arxiv.org/html/2301.01234v2", "text/html"], ["https://arxiv.org/pdf/2301.01234v2", "application/pdf"]]) {
    const result = await readWebPage({ url }, { allowedDomains: ["arxiv.org"], webPageFetchImpl: async () => new Response(bytes, { headers: { "content-type": type } }), webPdfTextExtractorImpl: async ({ url: observed }) => { assert.equal(observed, url);return { ok: true, content: "Synthetic extractor fixture only." }; } });
    assert.equal(result.url, url);assert.equal(result.canonicalUrl, url);recordDurableResearchEvidence(state, result);
  }
  assert.equal(state.meta.durableResearchEvidence.length, 2);
});
for (const canonical of ["/manual/latest", "/manual/v9", "https://other.example.net/source", "http://127.0.0.1/private"]) {
  test(`page-declared canonical metadata cannot relabel retrieved evidence: ${canonical}`, async () => {
    const url = "https://docs.example.org/manual/v1", body = `<head><link rel="canonical" href="${canonical}"></head>${html("first")}`;
    const result = await readWebPage({ url }, config(body));assert.equal(result.ok, true);assert.equal(result.canonicalUrl, url);assert.equal(result.url, url);assert.equal(result.sha256, hash(body));
  });
}
test("different manuals cannot collapse through one SEO canonical URL", async () => {
  const state = {};
  for (const version of [1, 2]) {
    const url = `https://docs.example.org/manual/v${version}`;
    recordDurableResearchEvidence(state, await readWebPage({ url }, config(`<link rel="canonical" href="/manual/latest">${html(String(version))}`)));
  }
  assert.deepEqual(state.meta.durableResearchEvidence.map(e => e.url), ["https://docs.example.org/manual/v1", "https://docs.example.org/manual/v2"]);
});
test("fragments and default ports normalize while the entire sent query is retained", async () => {
  const result = await readWebPage({ url: "https://DOCS.example.org:443/manual?edition=2&utm_source=fixture&format=text#part" }, config(html("query")));
  assert.equal(result.url, "https://docs.example.org/manual?edition=2&utm_source=fixture&format=text");assert.equal(result.requestedUrl, result.url);assert.equal(result.canonicalUrl, result.url);
});
test("tracking-like names cannot collapse distinct source-selector query values", async () => {
  for (const key of ["ref", "source", "utm_source", "fbclid"]) {
    const state = {};
    for (const value of ["first", "second"]) {
      const url = `https://docs.example.org/manual?${key}=${value}`;
      recordDurableResearchEvidence(state, await readWebPage({ url }, config(html(value))));
    }
    assert.equal(state.meta.durableResearchEvidence.length, 2, key);
    assert.equal(state.meta.durableResearchEvidence[0].url, `https://docs.example.org/manual?${key}=first`);
  }
});
test("query order and duplicate values are not rewritten for fetched evidence", async () => {
  const url = "https://docs.example.org/manual?v=2&v=1&part=second&part=first";
  const result = await readWebPage({ url }, config(html("ordered")));assert.equal(result.url, url);assert.equal(result.canonicalUrl, url);
});
test("a valid long source address survives durable formatting without URL fabrication", async () => {
  const url = "https://docs.example.org/manual?edition=" + "a".repeat(1400), state = {};
  recordDurableResearchEvidence(state, await readWebPage({ url }, config(html("long"))));
  assert.equal(state.meta.durableResearchEvidence[0].url, url);assert.ok(formatDurableResearchEvidence(state.meta.durableResearchEvidence)[0].includes(url));
});
test("oversized source addresses fail before I/O and cannot become truncated evidence", async () => {
  const url = "https://docs.example.org/manual?q=" + "a".repeat(8192);let calls = 0;
  const result = await readWebPage({ url }, { webPageFetchImpl: async () => { calls++;throw Error("No I/O"); } });
  assert.equal(result.ok, false);assert.match(result.error, /8192/);assert.equal(calls, 0);
  const state = {};assert.deepEqual(recordDurableResearchEvidence(state, { ok: true, toolName: "read_web_page", url, content: "Synthetic fixture", sha256: "a".repeat(64) }), []);
  assert.equal(state.meta, undefined);
});
test("a too-large redirect target is rejected before following it", async () => {
  let calls = 0;const result = await readWebPage({ url: "https://docs.example.org/manual" }, { webPageFetchImpl: async () => { calls++;return new Response(null, { status: 302, headers: { location: "https://docs.example.org/manual?q=" + "a".repeat(8192) } }); } });
  assert.equal(result.ok, false);assert.match(result.error, /8192/);assert.equal(calls, 1);
});
test("redaction cannot manufacture another URL carrying the original content hash", () => {
  const state = {}, url = "https://docs.example.org/manual?token=sk-" + "x".repeat(32);
  assert.deepEqual(recordDurableResearchEvidence(state, { ok: true, toolName: "read_web_page", url, content: "Synthetic fixture", sha256: "a".repeat(64) }), []);
  assert.equal(state.meta, undefined);
});
test("a followed redirect records the actual destination separately from the request", async () => {
  const requested = "https://arxiv.org/abs/2301.01234v1", destination = "https://arxiv.org/abs/2301.01234v7";const seen = [];
  const result = await readWebPage({ url: requested }, { allowedDomains: ["arxiv.org"], webPageFetchImpl: async url => { seen.push(url);return url === requested ? new Response(null, { status: 302, headers: { location: destination } }) : new Response(html("redirect"), { headers: { "content-type": "text/html" } }); } });
  assert.deepEqual(seen, [requested, destination]);assert.equal(result.requestedUrl, requested);assert.equal(result.url, destination);assert.equal(result.canonicalUrl, destination);
});
test("repeat reads of one actual source replace only that source's old observation", async () => {
  const state = {};let previous;
  for (const label of ["old", "new"]) {
    const result = await readWebPage({ url: "https://docs.example.org/manual?v=2" }, config(html(label)));previous = result;recordDurableResearchEvidence(state, result);
  }
  assert.equal(state.meta.durableResearchEvidence.length, 1);assert.equal(state.meta.durableResearchEvidence[0].sha256, previous.sha256);
});
test("durable page evidence prefers the actual read address over advisory canonical metadata", () => {
  const state = {};recordDurableResearchEvidence(state, { ok: true, toolName: "read_web_page", url: "https://docs.example.org/v1", canonicalUrl: "https://docs.example.org/latest", content: "Synthetic version one.", sha256: "a".repeat(64) });
  assert.equal(state.meta.durableResearchEvidence[0].url, "https://docs.example.org/v1");
});
test("work-level scholarly discovery canonicalization keeps its separate deduplication meaning", () => {
  assert.equal(canonicalizeWebUrl("https://arxiv.org/html/2301.01234v2"), "https://arxiv.org/abs/2301.01234");
});
test("old completed research is not silently reused under corrected source-address semantics", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-source-policy-"));t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "deep-research-old-source.json"), old = JSON.stringify({ version: 17, researchId: "old-source", status: "completed", fingerprint: "old-address-policy" });await fs.writeFile(statePath, old);
  let calls = 0;const result = await deepResearch({ researchId: "old-source", query: "Check a pinned source" }, { provider: "mock", deepResearchDryRun: true, clientFactory() { calls++;throw Error("No dispatch"); } }, { artifactsDir: directory, ensure: async () => {} });
  assert.equal(RESEARCH_VERSION, 18);assert.equal(result.ok, false);assert.match(result.error, /older or unsupported schema/);assert.equal(calls, 0);assert.equal(await fs.readFile(statePath, "utf8"), old);
});

test("real native persisted context preserves both refreshed revisions across a fresh Pro continuation", { timeout: 25000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-source-address-"));t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./fixtures/native-research-source-address.js", import.meta.url));let phase = "initial", turns = 0;const seenModels = [];
  const reply = message => ({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] });
  const server = http.createServer((request, response) => {
    let body = "";request.on("data", chunk => body += chunk);request.on("end", () => {
      const payload = JSON.parse(body);seenModels.push(payload.model);let output;
      if (!payload.tools) output = reply({ content: "Read the exact revision and report what was observed." });
      else if (++turns <= 2) output = reply({ tool_calls: [{ id: "source_read_" + turns, type: "function", function: { name: "read_web_page", arguments: JSON.stringify({ url: `https://arxiv.org/abs/2301.01234v${turns === 1 ? 1 : 7}` }) } }] });
      else output = reply({ tool_calls: [{ id: "source_finish", type: "function", function: { name: "finish", arguments: JSON.stringify({ result: "Read the requested exact revision. Synthetic source evidence only; no application changes." }) } }] });
      response.writeHead(200, { "content-type": "application/json" });response.end(JSON.stringify(output));
    });
  });server.listen(0, "127.0.0.1");await once(server, "listening");t.after(async () => { const closed = once(server, "close");server.close();server.closeAllConnections();await closed; });
  const execute = promisify(execFile), env = { PATH: process.env.PATH, HOME: directory, AGINTIFLOW_HOME: path.join(directory, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: root } : {}) };
  const run = async () => { const { stdout } = await execute(process.execPath, ["--experimental-test-module-mocks", fixture, directory, `http://127.0.0.1:${server.address().port}/v1`, phase], { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });return JSON.parse(stdout.trim().split("\n").at(-1)); };
  assert.equal((await run()).stopped, false);const statePath = path.join(directory, "sessions/source-address/state.json"), before = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(before.meta.durableResearchEvidence.length, 2);assert.equal(before.meta.durableResearchEvidence[0].url, "https://arxiv.org/abs/2301.01234v1");
  phase = "resume";turns = 0;const resumed = await run();assert.equal(resumed.stopped, false);const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.ok(Array.isArray(state.meta.durableResearchEvidence), JSON.stringify(resumed));
  assert.deepEqual(state.meta.durableResearchEvidence.map(e => e.url), ["https://arxiv.org/abs/2301.01234v1", "https://arxiv.org/abs/2301.01234v7"]);assert.notEqual(state.meta.durableResearchEvidence[0].sha256, state.meta.durableResearchEvidence[1].sha256);
  for (let index = 0; index < 2; index++) assert.notEqual(state.meta.durableResearchEvidence[index].sha256, before.meta.durableResearchEvidence[index].sha256, "A new goal's refreshed observations do not inherit prior hashes");
  assert.ok(seenModels.includes("deepseek-flash"));assert.ok(seenModels.includes("deepseek-v4-pro"));assert.deepEqual(await fs.readdir(path.join(directory, "workspace")), []);
});
