import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { mock } from "node:test";
const [root, baseURL, phase] = process.argv.slice(2);
const source = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../../", import.meta.url));
const originalFetch = globalThis.fetch;
const dnsBoundary = mock.module("node:dns/promises", { namedExports: { lookup: async hostname => { assert.equal(hostname, "arxiv.org");return [{ address: "93.184.216.34", family: 4 }]; } } });
const fixtureFetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "arxiv.org") return Promise.resolve(new Response(`<main><h1>Synthetic revision ${url.pathname.endsWith("v1") ? "one" : "seven"}</h1><p>Only ${phase} evidence from this exact fixture revision.</p></main>`, { headers: { "content-type": "text/html" } }));
  assert.equal(url.origin, new URL(baseURL).origin, "No external network in the offline fixture");return Reflect.apply(originalFetch, globalThis, [input, options]);
};
globalThis.fetch = fixtureFetch;
let pageTransportBoundary;
try {
  const transport = path.join(source, "src/public-page-fetch.js");await fs.access(transport);
  // This fixture verifies source identity, not network isolation. The separate
  // connection suite exercises the real transport with import-only socket mocks.
  pageTransportBoundary = mock.module(pathToFileURL(transport), { namedExports: {
    fetchPublicWebResponse: fixtureFetch, disposePublicWebResponse: async () => false,
  } });
} catch (error) { if (error.code !== "ENOENT") throw error; }
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
const workspace = path.join(root, "workspace"), model = phase === "initial" ? "deepseek-flash" : "deepseek-v4-pro";await fs.mkdir(workspace, { recursive: true });
const config = resolveRuntimeConfig({ provider: "deepseek", model, routingMode: "manual", enableScs: "off", goal: `${phase === "resume" ? "Refresh" : "Read"} both exact source pages https://arxiv.org/abs/2301.01234v1 and https://arxiv.org/abs/2301.01234v7 and make a concise answer from the observed evidence without changing files.`, maxSteps: 8, dynamicSteps: "off" }, { baseDir: workspace, commandCwd: workspace, packageDir: source, provider: "deepseek", model, baseURL, apiKey: "synthetic-loopback-source-key", sessionId: "source-address", sandboxMode: "host", allowWebSearch: true, allowedDomains: ["arxiv.org"], allowFileTools: false, allowShellTool: false, allowWrapperTools: false, allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false });
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"), ...(phase === "resume" ? { resume: "source-address" } : {}), allowProviderHandoff: false, modelTimeoutMs: 5000, scsActive: false, quiet: true, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model, executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline source identity regression" } });
if (phase === "resume") {
  const prior = JSON.parse(await fs.readFile(path.join(root, "sessions/source-address/state.json"), "utf8"));
  config.expectedRuntimeRevision = prior.meta.runtimeConfig.revision;
  config.runtimePatch = { provider: "deepseek", model, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model };
}
try { const result = await runAgent(config);const events = (await fs.readFile(path.join(root, "sessions/source-address/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);console.log(JSON.stringify({ sessionId: result.sessionId, stopped: Boolean(result.stopped), reason: result.reason || null, steps: result.stepsCompleted, eventTypes: events.slice(-12).map(e => [e.type, e.data?.toolName]) })); }
finally { closeSessionIndexConnections();globalThis.fetch = originalFetch;pageTransportBoundary?.restore();dnsBoundary.restore(); }
