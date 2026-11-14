import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { EventEmitter, once, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { mock, after } from "node:test";

const root = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const HOST = "source-connection.example.org", PUBLIC = "8.8.8.8", TEXT = "Only bounded public fixture evidence.";
let active;
function fixture(t, responses = [{}], changes = {}) {
  const value = { responses, requests: [], streams: [], lookups: [], socketLookups: 0, ...changes };
  active = value;
  t.after(() => { for (const stream of value.streams) stream.destroy();if (active === value) active = null; });
  return value;
}
const dnsBoundary = mock.module("node:dns/promises", { namedExports: { lookup: async (hostname, options) => {
  assert.ok(active, "No unowned DNS lookup in the fixture");active.lookups.push({ hostname, options });
  return active.lookup ? active.lookup(hostname, options) : active.addresses || [{ address: PUBLIC, family: 4 }];
} } });
// The installed-408 negative control uses a real fetch socket. Its second DNS
// answer may reach only this test's own loopback server, never another target.
const originalSocketLookup = dns.lookup;
const socketBoundary = mock.method(dns, "lookup", (hostname, options, callback) => {
  if (hostname === "127.0.0.1") return Reflect.apply(originalSocketLookup, dns, [hostname, options, callback]);
  if (typeof options === "function") { callback = options;options = {}; }
  if (!active?.privatePort || hostname !== HOST) { queueMicrotask(() => callback(new Error("No external socket DNS in offline tests")));return; }
  active.socketLookups++;
  queueMicrotask(() => callback(null, options?.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", options?.all ? undefined : 4));
});
function request(options, callback) {
  assert.ok(active);const state = active, description = state.responses[state.requests.length] || state.responses.at(-1);
  state.requests.push(options);description.inspect?.(options);
  const req = new EventEmitter();let incoming;
  const aborted = () => { req.emit("error", options.signal.reason);incoming?.destroy(options.signal.reason); };
  const cleanup = () => options.signal?.removeEventListener("abort", aborted);
  req.destroy = () => {
    req.destroyed = true;incoming?.destroy();incoming?.socket?.destroy();cleanup();
    if (!req.closed) { req.closed = true;queueMicrotask(() => req.emit("close")); }return req;
  };
  req.end = () => queueMicrotask(() => {
    if (description.error) { req.destroy();req.emit("error", description.error);return; }
    incoming = new PassThrough();state.streams.push(incoming);
    incoming.statusCode = description.status ?? 200;
    incoming.headers = { "content-type": "text/plain", ...description.headers };
    incoming.socket = Object.assign(new EventEmitter(), { remoteAddress: PUBLIC, authorized: true, ...description.socket });
    incoming.socket.destroy = () => {
      if (incoming.socket.closing || incoming.socket.closed) return;
      incoming.socket.closing = true;description.onClosing?.();
      Promise.resolve(description.closeGate).then(() => { incoming.socket.closed = true;incoming.socket.emit("close"); });
    };
    incoming.complete = description.complete ?? true;
    incoming.once("close", () => req.destroy());
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (description.upgrade) { req.emit("upgrade", incoming, incoming.socket);return; }
    callback(incoming);
    setImmediate(() => {
      if (incoming.destroyed) return;
      if (description.initial) incoming.write(description.body || TEXT);
      if (!description.stall) incoming.end(description.body ?? TEXT);
    });
  });
  return req;
}
const httpBoundary = mock.module("node:http", { defaultExport: http, namedExports: { request } });
const httpsBoundary = mock.module("node:https", { defaultExport: https, namedExports: { request } });
const { readWebPage } = await import(pathToFileURL(path.join(root, "src/web-search.js")));
const helperPath = path.join(root, "src/public-page-fetch.js");
const { fetchPublicWebResponse, disposePublicWebResponse } = await fs.access(helperPath).then(() => import(pathToFileURL(helperPath)), () => ({}));
after(() => { socketBoundary.mock.restore();dnsBoundary.restore();httpBoundary.restore();httpsBoundary.restore(); });
const read = (args = {}, config = {}) => readWebPage({ url: `https://${HOST}/brief?edition=2&edition=1#part`, ...args }, { allowedDomains: [HOST], ...config });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function closed(state) { await turn();assert.ok(state.streams.every(stream => stream.destroyed), "Every owned response must close"); }

test("public DNS precheck cannot authorize a second private socket lookup", { timeout: 5000 }, async t => {
  let privateHits = 0;const marker = "OWNED_LOOPBACK_MARKER_NOT_PUBLIC_EVIDENCE";
  const server = http.createServer((_request, response) => { privateHits++;response.writeHead(200, { "content-type": "text/plain" });response.end(marker); });
  server.listen(0, "127.0.0.1");await once(server, "listening");
  t.after(async () => { const finished = once(server, "close");server.close();server.closeAllConnections();await finished; });
  const state = fixture(t, [{}], { privatePort: server.address().port });
  const result = await read({ url: `http://${HOST}:${state.privatePort}/brief` });
  assert.equal(result.content?.includes(marker), false, "Never accept private bytes under a public source URL");
  assert.equal(privateHits, 0);assert.equal(state.socketLookups, 0);
  assert.equal(result.ok, true);assert.equal(result.content, TEXT);assert.equal(state.lookups.length, 1);assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].agent, false);await closed(state);
});

test("native request pins detached DNS answers and preserves hostname/TLS/path identity", async t => {
  const answers = [{ address: PUBLIC, family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  const state = fixture(t, [{ inspect() { answers[0].address = "127.0.0.1"; } }], { addresses: answers });
  const result = await read();assert.equal(result.ok, true);assert.equal(result.url, `https://${HOST}/brief?edition=2&edition=1`);
  const options = state.requests[0];assert.equal(options.hostname, HOST);assert.equal(options.servername, HOST);assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.path, "/brief?edition=2&edition=1");assert.equal(options.autoSelectFamily, true);assert.equal(options.maxHeaderSize, 16384);
  const lookup = (name, opts) => new Promise((resolve, reject) => options.lookup(name, opts, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  const first = await lookup(HOST, {});assert.deepEqual(first, { address: PUBLIC, family: 4 });
  const all = await lookup(HOST, { all: true });assert.deepEqual(all.address.map(item => item.address), [PUBLIC, "2606:4700:4700::1111"]);
  all.address[0].address = "10.0.0.1";assert.equal((await lookup(HOST, {})).address, PUBLIC);
  await assert.rejects(lookup("foreign.example.org", {}));assert.equal((await lookup(HOST, { family: 6 })).family, 6);
  assert.deepEqual(Object.keys(options.headers).sort(), ["accept", "accept-encoding", "user-agent"]);await closed(state);
});

for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: PUBLIC, family: 4 }, { address: "10.0.0.1", family: 4 }], [{ address: PUBLIC, family: 6 }], [{ address: "invalid", family: 4 }], Array.from({ length: 65 }, () => ({ address: PUBLIC, family: 4 })), [{ address: "::ffff:127.0.0.1", family: 6 }], [{ address: "3fff::1", family: 6 }]]) {
  test(`unsafe or unbounded DNS set is refused before connection ${JSON.stringify(addresses).slice(0, 100)}`, async t => {
    const state = fixture(t, [{}], { addresses });const result = await read();assert.equal(result.ok, false);assert.equal(state.requests.length, 0);
  });
}
for (const socket of [{ remoteAddress: "127.0.0.1" }, { remoteAddress: "8.8.4.4" }, { remoteAddress: undefined }, { authorized: false }]) {
  test(`unapproved peer/TLS cannot supply accepted evidence ${JSON.stringify(socket)}`, async t => {
    const state = fixture(t, [{ socket }]);const result = await read();assert.equal(result.ok, false);assert.match(result.error, /approved address and TLS/);await closed(state);
  });
}
test("public IPv6-only source can use a canonical equivalent peer", async t => {
  const state = fixture(t, [{ socket: { remoteAddress: "2001:4860:4860:0:0:0:0:8888" } }], { addresses: [{ address: "2001:4860:4860::8888", family: 6 }] });
  assert.equal((await read()).ok, true);await closed(state);
});
for (const [encoding, encode] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
  test(`decoded ${encoding} text retains ordinary research behavior`, async t => {
    const body = encode(Buffer.from(TEXT));const state = fixture(t, [{ body, headers: { "content-encoding": encoding, "content-length": String(body.length) } }]);
    const result = await read();assert.equal(result.ok, true);assert.equal(result.content, TEXT);assert.equal(result.byteLength, Buffer.byteLength(TEXT));await closed(state);
  });
}
test("wire bytes, decoded bytes and declared oversize all fail closed with stream cleanup", async t => {
  for (const description of [{ body: Buffer.alloc(32769) }, { body: gzipSync(Buffer.alloc(65536, 65)), headers: { "content-encoding": "gzip" } }, { stall: true, headers: { "content-length": "99999999" } }]) {
    const state = fixture(t, [description]);const result = await read({ maxBytes: 32768 });assert.equal(result.ok, false);assert.match(result.error, /research limit/);await closed(state);
  }
});
test("unsupported/malformed/truncated bodies cannot become partial successful evidence", async t => {
  for (const description of [{ headers: { "content-encoding": "unknown" } }, { body: "broken", headers: { "content-encoding": "gzip" } }, { complete: false }, { error: new Error("controlled network failure") }]) {
    const state = fixture(t, [description]);const result = await read();assert.equal(result.ok, false);assert.equal(result.content, undefined);await closed(state);
  }
});
test("redirect cancellation precedes the next independently pinned hop", async t => {
  const state = fixture(t, [{ status: 302, stall: true, headers: { location: "/next" } }, {}]);
  state.lookup = async () => { if (state.lookups.length > 1) assert.ok(state.streams[0].destroyed);return [{ address: PUBLIC, family: 4 }]; };
  const result = await read();assert.equal(result.ok, true);assert.equal(result.url, `https://${HOST}/next`);assert.equal(state.requests.length, 2);assert.equal(state.lookups.length, 2);await closed(state);
});
test("same-host rebinding on redirect is refused without a second connection", async t => {
  const state = fixture(t, [{ status: 302, headers: { location: "/next" } }]);
  state.lookup = async () => [{ address: state.lookups.length === 1 ? PUBLIC : "127.0.0.1", family: 4 }];
  assert.equal((await read()).ok, false);assert.equal(state.requests.length, 1);await closed(state);
});
for (const location of ["http://127.0.0.1/private", "https://foreign.example.net/next", "http://[broken"]) {
  test(`unreviewed/malformed redirect is refused and closed ${location}`, async t => {
    const state = fixture(t, [{ status: 302, stall: true, headers: { location } }]);assert.equal((await read()).ok, false);assert.equal(state.requests.length, 1);await closed(state);
  });
}
test("redirect limit and HTTP error never leave stalled bodies open", async t => {
  const redirects = fixture(t, [{ status: 302, stall: true, headers: { location: "/again" } }]);assert.equal((await read()).ok, false);assert.equal(redirects.requests.length, 6);await closed(redirects);
  const failed = fixture(t, [{ status: 503, stall: true }]);assert.equal((await read()).status, 503);await closed(failed);
});
test("caller cancellation during DNS cannot dispatch after a late resolution", async t => {
  let release;const controller = new AbortController();const state = fixture(t, [{}], { lookup: () => new Promise(resolve => { release = resolve; }) });
  const pending = fetchPublicWebResponse(`https://${HOST}/brief`, { signal: controller.signal });
  await turn();controller.abort(new Error("cancelled test"));await assert.rejects(pending, /cancelled test/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  release([{ address: PUBLIC, family: 4 }]);await turn();assert.equal(state.requests.length, 0);
});
test("caller body cancellation destroys the complete owned response chain", async t => {
  const controller = new AbortController();const state = fixture(t, [{ stall: true, initial: true }]);
  const response = await fetchPublicWebResponse(`https://${HOST}/brief`, { signal: controller.signal });
  const reader = response.body.getReader();assert.equal((await reader.read()).done, false);
  const next = reader.read();controller.abort(new Error("cancel body"));await assert.rejects(next);reader.releaseLock();await closed(state);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
test("ambient fetch cannot replace the native public connection boundary", async t => {
  let ambientCalls = 0;const state = fixture(t);const original = globalThis.fetch;
  globalThis.fetch = () => { ambientCalls++;throw new Error("Ambient fetch is not source authority"); };
  try { assert.equal((await read({}, { webPageFetchImpl: globalThis.fetch })).ok, true);assert.equal(ambientCalls, 0);assert.equal(state.requests.length, 1); }
  finally { globalThis.fetch = original; }await closed(state);
});
test("explicit trusted fetch hooks preserve policy/body cleanup without gaining native attestation", async t => {
  const state = fixture(t);let cancelled = 0;
  const result = await read({}, { webPageFetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }) });
  assert.equal(result.status, 503);assert.equal(cancelled, 1);assert.equal(state.requests.length, 0);
});

test("invalid/private literal URLs cannot cause DNS or a native request", async t => {
  const state = fixture(t);
  for (const url of ["file:///etc/passwd", "https://name:secret@example.org/page", "http://127.0.0.1/brief", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://example.org/?" + "x".repeat(8192)]) {
    await assert.rejects(fetchPublicWebResponse(url));
  }
  assert.equal(state.lookups.length, 0);assert.equal(state.requests.length, 0);
});
test("public IP literals retain peer and TLS checks without another DNS lookup", async t => {
  for (const address of [PUBLIC, "2606:4700:4700::1111"]) {
    const state = fixture(t, [{ socket: { remoteAddress: address } }]);
    const authority = address.includes(":") ? "[" + address + "]" : address;
    const response = await fetchPublicWebResponse("https://" + authority + "/brief");
    assert.equal(await response.text(), TEXT);assert.equal(await disposePublicWebResponse(response), true);
    assert.equal(state.lookups.length, 0);assert.equal(state.requests[0].servername, undefined);
    assert.equal(state.requests[0].rejectUnauthorized, true);await closed(state);
  }
});
test("a bounded stacked content encoding is decoded in reverse wire order", async t => {
  const state = fixture(t, [{ body: brotliCompressSync(gzipSync(Buffer.from(TEXT))), headers: { "content-encoding": "gzip, br" } }]);
  assert.equal((await read()).content, TEXT);await closed(state);
});
test("already-cancelled source request performs no DNS or HTTP work", async t => {
  const state = fixture(t), controller = new AbortController();controller.abort(new Error("before dispatch"));
  await assert.rejects(fetchPublicWebResponse("https://" + HOST + "/brief", { signal: controller.signal }), /before dispatch/);
  assert.equal(state.lookups.length, 0);assert.equal(state.requests.length, 0);
});
test("bodyless statuses close their native ownership scope", async t => {
  for (const status of [204, 205, 304]) {
    const state = fixture(t, [{ status, stall: true }]);const result = await read();
    assert.equal(result.status ?? status, status);assert.equal(result.ok, status !== 304);await closed(state);
  }
});
test("protocol upgrade is refused after the owned socket closes", async t => {
  const state = fixture(t, [{ upgrade: true }]);const result = await read();
  assert.equal(result.ok, false);assert.match(result.error, /upgrades/);await closed(state);assert.ok(state.streams[0].socket.closed);
});
test("native disposal is idempotent and a forged response obtains no ownership", async t => {
  const state = fixture(t, [{ stall: true }]), response = await fetchPublicWebResponse("https://" + HOST + "/brief");
  assert.deepEqual(await Promise.all([disposePublicWebResponse(response), disposePublicWebResponse(response)]), [true, true]);
  assert.equal(await disposePublicWebResponse(response), true);await closed(state);
  let traps = 0;const impostor = new Proxy({}, { get() { traps++;throw new Error("No authority"); } });
  assert.equal(await disposePublicWebResponse(impostor), false);assert.equal(traps, 0);assert.equal(state.requests.length, 1);
});
test("tool result cannot outrun a delayed owned socket close", { timeout: 2000 }, async t => {
  let release, entered;const closing = new Promise(resolve => { entered = resolve; });
  const closeGate = new Promise(resolve => { release = resolve; });
  const state = fixture(t, [{ status: 503, stall: true, closeGate, onClosing: entered }]);
  let settled = false;const pending = read().then(result => { settled = true;return result; });
  t.after(release);await closing;await turn();assert.equal(settled, false);release();
  assert.equal((await pending).status, 503);assert.equal(settled, true);await closed(state);
});

test("native persistence rejects private peer bytes and resumes with fresh verified evidence", { timeout: 15000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-source-peer-"));t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixturePath = path.join(fileURLToPath(new URL("./", import.meta.url)), "fixtures/native-public-source-connection.js");
  let phase = "initial", turns = 0;const models = [];
  const server = http.createServer((request, response) => {
    let data = "";request.on("data", chunk => { data += chunk; });request.on("end", () => {
      const input = JSON.parse(data);models.push(input.model);turns++;
      const call = turns === 1 ? { name: "read_web_page", arguments: JSON.stringify({ url: "https://" + HOST + "/brief" }) } : { name: "finish", arguments: JSON.stringify({ result: "The current page says independent review is pending. No files were changed." }) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: phase + turns, object: "chat.completion", model: input.model,
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: phase + "_" + turns, type: "function", function: call }] }, finish_reason: "tool_calls" }] }));
    });
  });server.listen(0, "127.0.0.1");await once(server, "listening");
  t.after(async () => { const done = once(server, "close");server.close();server.closeAllConnections();await done; });
  const execute = promisify(execFile), env = { PATH: process.env.PATH, HOME: directory, AGINTIFLOW_HOME: path.join(directory, "home"), AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1" };
  const run = async () => {
    const { stdout } = await execute(process.execPath, ["--experimental-test-module-mocks", fixturePath, directory, `http://127.0.0.1:${server.address().port}/v1`, phase], { env, timeout: 6000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };
  const first = await run();assert.equal(first.stopped, true);assert.equal(first.lookups, 1);assert.equal(first.requests, 1);
  const stateFile = path.join(directory, "sessions/source-peer/state.json"), beforeText = await fs.readFile(stateFile, "utf8"), before = JSON.parse(beforeText);
  assert.equal(beforeText.includes("REJECTED_PRIVATE_FIXTURE_BYTES"), false);assert.equal(before.meta.durableResearchEvidence?.length || 0, 0);
  phase = "resume";turns = 0;const second = await run();assert.equal(second.stopped, false, JSON.stringify(second));
  const stateText = await fs.readFile(stateFile, "utf8"), state = JSON.parse(stateText);
  assert.equal(stateText.includes("REJECTED_PRIVATE_FIXTURE_BYTES"), false);assert.equal(state.meta.durableResearchEvidence.length, 1);
  assert.equal(state.meta.durableResearchEvidence[0].url, "https://" + HOST + "/brief");
  assert.equal(state.meta.durableResearchEvidence[0].sha256, crypto.createHash("sha256").update("Synthetic current source: independent review is pending.").digest("hex"));
  assert.equal(state.model, "deepseek-v4-pro");assert.ok(models.includes("deepseek-flash"));assert.ok(models.includes("deepseek-v4-pro"));
  assert.deepEqual(await fs.readdir(path.join(directory, "workspace")), []);
});
