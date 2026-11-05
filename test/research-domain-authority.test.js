import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWebPage, searchWeb } from "../src/web-search.js";
import { checkToolUse } from "../src/guardrails.js";
import { webResearch } from "../src/perception-tools.js";
import { deepResearch } from "../src/deep-research.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { runAgent } from "../src/agent-runner.js";

const approved = "docs.example.org";
const outside = "outside.example.net";
const policy = { allowWebSearch: true, allowedDomains: [approved] };
const html = "<main>Official documentation describes bounded transactions and their limitations.</main>";
const pageResponse = () => new Response(html, { headers: { "content-type": "text/html" } });
const rss = urls => new Response(`<rss><channel>${urls.map(url => `<item><title>Source</title><link>${url}</link><description>Public documentation</description></item>`).join("")}</channel></rss>`);

test("model domain arguments cannot replace the server's research allowlist", async () => {
  let reads = 0;
  const args = { url: `https://${outside}/source`, domains: [outside] };
  assert.equal(checkToolUse({ toolName: "read_web_page", args, config: policy }).allowed, false);
  const result = await readWebPage(args, { ...policy, webPageFetchImpl: async () => { reads++; return pageResponse(); } });
  assert.equal(result.ok, false);
  assert.equal(reads, 0);
});

test("disjoint or malformed domains reject before search, synthesis, hooks or research persistence", async () => {
  for (const domains of [[outside], ["*"], ["https://docs.example.org"], ["docs.example.org:443"], [""], ["docs.example.org/evil"], [12]]) {
    let calls = 0;
    const deny = () => { calls++; throw new Error("must not run"); };
    const config = { ...policy, webSearchFetchImpl: deny, webSearchImpl: deny, webPageReaderImpl: deny, clientFactory: deny };
    for (const toolName of ["web_search", "read_web_page", "web_research", "deep_research"]) {
      assert.equal(checkToolUse({ toolName, args: { query: "transaction documentation", url: `https://${approved}/source`, domains }, config }).allowed, false);
    }
    assert.equal((await searchWeb({ query: "transaction documentation", domains }, config)).ok, false);
    assert.equal((await readWebPage({ url: `https://${approved}/source`, domains }, config)).ok, false);
    assert.equal((await webResearch({ query: "transaction documentation", mode: "openai", domains }, config)).ok, false);
    assert.equal((await deepResearch({ query: "transaction documentation", domains }, config, { ensure: deny })).ok, false);
    assert.equal(calls, 0);
  }
});

test("narrowing preserves parent/subdomain semantics and omitted restrictions", async () => {
  for (const [server, requested, url, allowed] of [
    [[approved], undefined, `https://${approved}/source`, true],
    [[approved], [], `https://${approved}/source`, true],
    [[approved], ["example.org"], `https://${approved}/source`, true],
    [[approved], ["example.org"], "https://sibling.example.org/source", false],
    [["example.org"], [approved], `https://${approved}/source`, true],
    [["example.org"], [approved], "https://example.org/source", false],
    [[approved], [outside, approved], `https://${approved}/source`, true],
    [[approved], [outside, approved], `https://${outside}/source`, false],
    [[], [outside], `https://${outside}/source`, true],
    [[], undefined, `https://${outside}/source`, true],
    [["WWW.DOCS.EXAMPLE.ORG"], [approved], `https://${approved}/source`, true],
  ]) {
    let calls = 0;
    const result = await readWebPage({ url, domains: requested }, { allowedDomains: server, webPageFetchImpl: async () => { calls++; return pageResponse(); } });
    assert.equal(result.ok, allowed, JSON.stringify({ server, requested, url }));
    assert.equal(calls, allowed ? 1 : 0);
  }
});

test("search results stay inside both domain policies", async () => {
  const urls = [`https://${outside}/source`, `https://${approved}/source`, "https://sibling.example.org/source"];
  for (const domains of [undefined, ["example.org"], [outside, approved]]) {
    const result = await searchWeb({ query: "transaction documentation", provider: "bing", domains }, {
      ...policy, webSearchFetchImpl: async () => rss(urls),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map(row => row.url), [`https://${approved}/source`]);
  }
});

test("dry-run discovery does not return an out-of-scope synthetic source", async () => {
  const result = await searchWeb({ query: "transaction documentation", domains: ["example.org"] }, { ...policy, webSearchDryRun: true });
  assert.equal(result.ok, true); assert.deepEqual(result.results, []);
});

test("scholarly PDF and alternate links cannot widen the effective domain policy", async () => {
  const result = await searchWeb({ query: "transaction documentation", provider: "crossref", domains: ["example.org"] }, { ...policy,
    webSearchFetchImpl: async () => Response.json({ message: { items: [{
      title: ["Synthetic bounded source"], DOI: "10.0000/fixture", URL: `https://${approved}/source`,
      type: "journal-article", link: [{ URL: `https://${outside}/source.pdf`, "content-type": "application/pdf" }],
    }] } }),
  });
  assert.equal(result.ok, true); assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].pdfUrls, []);
  assert.ok(result.results[0].alternativeUrls.every(url => new URL(url).hostname === approved));
});

test("effective domains reach trusted hooks without replacing the server config", async () => {
  const original = Object.freeze({ ...policy, allowedDomains: Object.freeze([approved]) });
  const domains = ["example.org", outside];
  const search = await searchWeb({ query: "transaction documentation", domains }, { ...original,
    webSearchImpl: async (args, config) => {
      assert.deepEqual(args.domains, [approved]); assert.deepEqual(config.allowedDomains, [approved]);
      return { ok: true, results: [] };
    },
  });
  assert.equal(search.ok, true);
  const page = await readWebPage({ url: `https://${approved}/source`, domains }, { ...original,
    webPageReaderImpl: async (args, config) => {
      assert.deepEqual(args.domains, [approved]); assert.deepEqual(config.allowedDomains, [approved]);
      return { ok: true, content: "trusted reader" };
    },
  });
  assert.equal(page.ok, true);
  assert.deepEqual(domains, ["example.org", outside]); assert.deepEqual(original.allowedDomains, [approved]);
});

test("redirects and canonical metadata cannot escape an intersected scope", async () => {
  let calls = 0;
  const config = { ...policy, webPageFetchImpl: async () => {
    calls++; return new Response("", { status: 302, headers: { location: `https://${outside}/source` } });
  } };
  assert.equal((await readWebPage({ url: `https://${approved}/source`, domains: [approved, outside] }, config)).ok, false);
  assert.equal(calls, 1);
  const result = await readWebPage({ url: `https://${approved}/source`, domains: ["example.org"] }, { ...policy,
    webPageFetchImpl: async () => new Response(`<head><link rel="canonical" href="https://sibling.example.org/source"></head>${html}`, { headers: { "content-type": "text/html" } }),
  });
  assert.equal(result.ok, true); assert.equal(result.canonicalUrl, `https://${approved}/source`);
});

test("snippet research cannot overwrite server policy when it calls search", async () => {
  const result = await webResearch({ query: "transaction documentation", domains: ["example.org"] }, { ...policy,
    webSearchImpl: async (args, config) => {
      assert.deepEqual(args.domains, [approved]); assert.deepEqual(config.allowedDomains, [approved]);
      return { ok: true, results: [], provider: "fixture" };
    },
  });
  assert.equal(result.ok, true); assert.deepEqual(result.domains, [approved]);
});

test("explicit hosted research receives the same narrowed domains without changing provider permission", async () => {
  let requests = 0;
  const result = await webResearch({ query: "transaction documentation", mode: "openai", domains: ["example.org"] }, { ...policy,
    provider: "openai", apiKey: "scripted-test-only", webSearchImpl: async () => ({ ok: true, results: [] }),
    perceptionClientFactory: () => ({ responses: { create: async body => {
      requests++; assert.deepEqual(body.tools[0].filters.allowed_domains, [approved]);
      return { output_text: "Bounded hosted fixture", output: [] };
    } } }),
  });
  assert.equal(result.ok, true); assert.equal(requests, 1);
});

test("a research checkpoint cannot be resumed under a different server source scope", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-research-domain-cache-"));
  let modelCalls = 0;
  const store = { artifactsDir: root, ensure: async () => {}, appendEvent: async () => {} };
  const config = { ...policy, provider: "openai", model: "scripted-scope", apiKey: "scripted-test-only",
    clientFactory: async () => { modelCalls++; throw new Error("No model work in cache fixture"); },
  };
  try {
    const args = { query: "Compare bounded transaction behavior", researchId: "scope-cache" };
    await deepResearch(args, config, store);
    const before = await fs.readFile(path.join(root, "deep-research-scope-cache.json"));
    const beforeCalls = modelCalls;
    const result = await deepResearch(args, { ...config, allowedDomains: [outside] }, store);
    assert.equal(result.ok, false); assert.match(result.error, /different query or research policy/);
    assert.equal(modelCalls, beforeCalls);
    assert.deepEqual(await fs.readFile(path.join(root, "deep-research-scope-cache.json")), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("normal persisted review blocks an outside read without invoking a source or granting broader authority", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-research-domain-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  let requests = 0, reads = 0;
  try {
    const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
    const goal = "Read the approved documentation and explain the limitations. Do not use other sites or create files.";
    const clientFactory = async () => ({ chat: { completions: { create: async () => {
      requests++;
      const name = requests === 1 ? "read_web_page" : "finish";
      const args = requests === 1 ? { url: `https://${outside}/source`, domains: [outside] }
        : { result: "I could not read that source because it is outside the approved documentation scope. I have no verified source findings to report, and no files were created." };
      assert.ok(requests <= 2);
      return { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `scope_${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
    } } } });
    clientFactory.agintiDeterministicTest = true;
    const config = resolveRuntimeConfig({ goal, provider: "openai", model: "scripted-scope", routingMode: "manual", enableScs: "off" }, {
      baseDir: workspace, commandCwd: workspace, sessionId: "research-scope", clientFactory, sandboxMode: "host",
      allowWebSearch: true, allowedDomains: [approved], allowFileTools: false, allowShellTool: false,
      allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false, allowWrapperTools: false,
    });
    Object.assign(config, { apiKey: "scripted-test-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
      clientFactory, scsActive: false, quiet: true, maxSteps: 3, useDockerSandbox: false,
      webPageFetchImpl: async () => { reads++; return pageResponse(); },
      executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline research scope regression." },
    });
    await runAgent(config);
    assert.equal(reads, 0);
    const events = (await fs.readFile(path.join(root, "sessions/research-scope/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.some(row => row.type === "tool.blocked" && row.data?.toolName === "read_web_page"));
    assert.ok(!events.some(row => row.type === "tool.started" && row.data?.toolName === "read_web_page"));
    assert.deepEqual(await fs.readdir(workspace), []);
  } finally {
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});
