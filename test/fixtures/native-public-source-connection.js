import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";
const [root, baseURL, phase] = process.argv.slice(2);
const source = fileURLToPath(new URL("../../", import.meta.url));
const HOST = "source-connection.example.org", PUBLIC = "8.8.8.8";
const body = phase === "initial" ? "REJECTED_PRIVATE_FIXTURE_BYTES" : "Synthetic current source: independent review is pending.";
let lookups = 0, requests = 0;
const dnsBoundary = mock.module("node:dns/promises", { namedExports: { lookup: async hostname => {
  assert.equal(hostname, HOST);lookups++;return [{ address: PUBLIC, family: 4 }];
} } });
function request(options, callback) {
  requests++;assert.equal(options.hostname, HOST);assert.equal(options.servername, HOST);
  assert.equal(options.agent, false);assert.equal(options.rejectUnauthorized, true);
  options.lookup(HOST, { all: true }, (error, answers) => { assert.ifError(error);assert.deepEqual(answers, [{ address: PUBLIC, family: 4 }]); });
  const req = new EventEmitter();let incoming;
  req.destroy = () => {
    incoming?.destroy();incoming?.socket.destroy();
    if (!req.closed) { req.closed = true;queueMicrotask(() => req.emit("close")); }return req;
  };
  req.end = () => queueMicrotask(() => {
    incoming = new PassThrough();incoming.statusCode = 200;incoming.headers = { "content-type": "text/plain" };incoming.complete = true;
    incoming.socket = Object.assign(new EventEmitter(), { remoteAddress: phase === "initial" ? "127.0.0.1" : PUBLIC, authorized: true });
    incoming.socket.destroy = () => { if (!incoming.socket.closed) { incoming.socket.closed = true;queueMicrotask(() => incoming.socket.emit("close")); } };
    incoming.once("close", () => req.destroy());callback(incoming);
    setImmediate(() => { if (!incoming.destroyed) incoming.end(body); });
  });return req;
}
const httpBoundary = mock.module("node:http", { defaultExport: http, namedExports: { request } });
const httpsBoundary = mock.module("node:https", { defaultExport: https, namedExports: { request } });
const { runAgent } = await import(pathToFileURL(path.join(source, "src/agent-runner.js")));
const { resolveRuntimeConfig } = await import(pathToFileURL(path.join(source, "src/config.js")));
const { closeSessionIndexConnections } = await import(pathToFileURL(path.join(source, "src/session-index.js")));
const workspace = path.join(root, "workspace");await fs.mkdir(workspace, { recursive: true });
const model = phase === "initial" ? "deepseek-flash" : "deepseek-v4-pro";
const goal = phase === "initial" ? "Read https://source-connection.example.org/brief and summarize that page. Do not change any files." : "Try the same public page again and summarize its current status. Leave all files unchanged.";
const config = resolveRuntimeConfig({ provider: "deepseek", model, goal, routingMode: "manual", maxSteps: phase === "initial" ? 1 : 4, dynamicSteps: "off", enableScs: "off" }, {
  baseDir: workspace, commandCwd: workspace, packageDir: source, provider: "deepseek", model, baseURL,
  apiKey: "synthetic-loopback-peer-key", sessionId: "source-peer", sandboxMode: "host", allowedDomains: [HOST],
  allowWebSearch: true, allowFileTools: false, allowShellTool: false, allowWrapperTools: false, allowMcpTools: false,
  allowParallelScouts: false, allowAuxiliaryTools: false,
});
Object.assign(config, { sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
  ...(phase === "resume" ? { resume: "source-peer" } : {}), allowProviderHandoff: false, modelTimeoutMs: 5000,
  scsActive: false, quiet: true, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model,
  spareProvider: "deepseek", spareModel: model, executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline source connection regression" } });
if (phase === "resume") {
  const previous = JSON.parse(await fs.readFile(path.join(root, "sessions/source-peer/state.json"), "utf8"));
  config.expectedRuntimeRevision = previous.meta.runtimeConfig.revision;
  config.runtimePatch = { provider: "deepseek", model, routeProvider: "deepseek", routeModel: model, mainProvider: "deepseek", mainModel: model, spareProvider: "deepseek", spareModel: model, maxSteps: 4 };
}
try {
  const result = await runAgent(config);
  console.log(JSON.stringify({ sessionId: result.sessionId, stopped: Boolean(result.stopped), reason: result.reason || null,
    lookups, requests, rejectedPrivateBytes: phase === "initial", model, nativeTransportExercised: true }));
} finally { closeSessionIndexConnections();dnsBoundary.restore();httpBoundary.restore();httpsBoundary.restore(); }
