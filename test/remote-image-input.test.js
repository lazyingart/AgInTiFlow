import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import test from "node:test";
import { readImage } from "../src/perception-tools.js";
import { SessionStore } from "../src/session-store.js";

const MAX_BYTES = 10 * 1024 * 1024;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const args = { prompt: "Please check this image and describe what is visible.", dryRun: true };
const config = { allowWebSearch: true, allowedDomains: ["127.0.0.1"] };

async function server(t, handler, host = "127.0.0.1") {
  const instance = http.createServer(handler);
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, host, resolve);
  });
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
  });
  return { instance, origin: `http://${host}:${instance.address().port}` };
}

test("ordinary allowed image read preserves exact source bytes without a model", { timeout: 5000 }, async t => {
  let requests = 0;
  const source = await server(t, (_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(png);
  });
  const result = await readImage({ ...args, url: source.origin + "/sample.png" }, config);
  assert.equal(result.ok, true);
  assert.equal(requests, 1);
  assert.equal(result.provider, "dry-run");
  assert.equal(result.images[0].sha256, createHash("sha256").update(png).digest("hex"));
  assert.equal(result.images[0].sizeBytes, png.length);
  assert.equal(Object.hasOwn(result.images[0], "dataUrl"), false);
});

test("an allowed image URL cannot redirect to a host outside the configured scope", { timeout: 5000 }, async t => {
  let targetRequests = 0;
  const target = await server(t, (_request, response) => {
    targetRequests++;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(png);
  }, "127.0.0.2");
  const source = await server(t, (_request, response) => {
    response.writeHead(302, { Location: target.origin + "/out-of-scope.png" });
    response.end();
  });
  const result = await readImage({ ...args, url: source.origin + "/sample.png" }, config);
  assert.equal(targetRequests, 0, "Image pixels were acquired outside the server-owned host scope");
  assert.equal(result.ok, false);
  assert.match(result.error, /allowlist|scope/i);
});

test("an excessive Content-Length is rejected before reading the image stream", async t => {
  let pulls = 0, cancelled = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(png); controller.close(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response(stream, {
    headers: { "Content-Type": "image/png", "Content-Length": String(MAX_BYTES + 1) },
  }));
  const result = await readImage({ ...args, url: "http://127.0.0.1/synthetic.png" }, config);
  assert.equal(result.ok, false);
  assert.match(result.error, /large|limit/i);
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
});

test("unknown-length image streaming stops at the byte cap instead of buffering the entire source", async t => {
  let pulls = 0, cancelled = 0;
  const chunk = Buffer.alloc(1024 * 1024, 3);
  const stream = new ReadableStream({
    pull(controller) {
      pulls++; controller.enqueue(chunk);
      if (pulls === 32) controller.close();
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response(stream, { headers: { "Content-Type": "image/png" } }));
  const result = await readImage({ ...args, url: "http://127.0.0.1/synthetic.png" }, config);
  assert.equal(result.ok, false);
  assert.match(result.error, /large|limit/i);
  assert.equal(pulls, 11);
  assert.equal(cancelled, 1);
});

test("caller cancellation does not replace the image fetch's own 15-second deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  let entered, rejectFetch, requestSignal;
  const dispatched = new Promise(resolve => entered = resolve);
  t.mock.method(globalThis, "fetch", (_url, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      rejectFetch = reject;
      requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      entered();
    });
  });
  const outcome = readImage({ ...args, url: "http://127.0.0.1/stalled.png" }, { ...config, abortSignal: parent.signal });
  try {
    await dispatched;
    t.mock.timers.tick(14999);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(parent.signal.aborted, false);
    const result = await outcome;
    assert.equal(result.ok, false);
    assert.match(result.error, /deadline|time/i);
  } finally {
    rejectFetch(new Error("Test-owned fetch cleanup"));
    await outcome;
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`allowed relative HTTP ${status} image redirect preserves the final source`, { timeout: 5000 }, async t => {
    const visits = [];
    const source = await server(t, (request, response) => {
      visits.push(request.url);
      if (request.url === "/start") {
        response.writeHead(status, { Location: "/final.png" }); response.end();
      } else {
        response.writeHead(200, { "Content-Type": "image/png" }); response.end(png);
      }
    });
    const result = await readImage({ ...args, url: source.origin + "/start" }, config);
    assert.equal(result.ok, true);
    assert.deepEqual(visits, ["/start", "/final.png"]);
    assert.equal(result.images[0].url, source.origin + "/start");
    assert.equal(result.images[0].sha256, createHash("sha256").update(png).digest("hex"));
  });
}

test("every redirect hop is checked and a loop stops after five redirects", { timeout: 5000 }, async t => {
  let visits = 0;
  const source = await server(t, (_request, response) => {
    visits++;
    response.writeHead(302, { Location: "/loop" }); response.end();
  });
  const result = await readImage({ ...args, url: source.origin + "/loop" }, config);
  assert.equal(result.ok, false);
  assert.match(result.error, /5-redirect limit/);
  assert.equal(visits, 6);
});

test("a later redirect cannot widen the server allowlist or reach a perception provider", { timeout: 5000 }, async t => {
  let forbiddenRequests = 0, clients = 0;
  const target = await server(t, (_request, response) => { forbiddenRequests++; response.end(png); }, "127.0.0.2");
  const source = await server(t, (request, response) => {
    response.writeHead(302, { Location: request.url === "/start" ? "/next" : target.origin + "/forbidden.png" }); response.end();
  });
  const result = await readImage({ url: source.origin + "/start", prompt: args.prompt, domains: ["127.0.0.2"] }, {
    ...config, provider: "openai", perceptionClientFactory: () => { clients++; throw new Error("Unexpected model invocation"); },
  });
  assert.equal(result.ok, false);
  assert.equal(forbiddenRequests, 0); assert.equal(clients, 0);
});

for (const location of [null, "file:///synthetic/image.png", "http://synthetic:credential@127.0.0.1/image.png"]) {
  test(`malformed or disallowed image redirect is closed (${location === null ? "missing" : location.startsWith("file") ? "scheme" : "credentials"})`, { timeout: 5000 }, async t => {
    let visits = 0;
    const source = await server(t, (_request, response) => {
      visits++;
      response.writeHead(302, location === null ? {} : { Location: location }); response.end();
    });
    const result = await readImage({ ...args, url: source.origin + "/start" }, config);
    assert.equal(result.ok, false);
    assert.equal(visits, 1);
    assert.doesNotMatch(result.error, /synthetic:credential/);
  });
}

test("a stalled redirect body is cancelled without delaying the allowed next hop", { timeout: 5000 }, async t => {
  let closed;
  const discarded = new Promise(resolve => closed = resolve);
  const source = await server(t, (request, response) => {
    if (request.url === "/start") {
      response.on("close", closed);
      response.writeHead(302, { Location: "/image.png" }); response.write("unfinished redirect body");
    } else {
      response.writeHead(200, { "Content-Type": "image/png" }); response.end(png);
    }
  });
  const result = await readImage({ ...args, url: source.origin + "/start" }, config);
  assert.equal(result.ok, true);
  await discarded;
});

for (const excess of [0, 1]) {
  test(`streamed image ${excess ? "one byte over" : "exactly at"} the byte cap`, async t => {
    const bytes = Buffer.alloc(MAX_BYTES + excess, 7);
    t.mock.method(globalThis, "fetch", async () => new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Length": "1" } }));
    const result = await readImage({ ...args, url: "http://127.0.0.1/fixture.png" }, config);
    assert.equal(result.ok, excess === 0);
    if (!excess) assert.equal(result.images[0].sizeBytes, MAX_BYTES);
  });
}

test("redirects share one deadline and release the parent listener on timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const signals = [];
  const before = getEventListeners(parent.signal, "abort").length;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signals.push(options.signal);
    t.mock.timers.tick(8000);
    return new Response(null, { status: 302, headers: { Location: "/next" } });
  });
  const result = await readImage({ ...args, url: "http://127.0.0.1/start" }, { ...config, abortSignal: parent.signal });
  assert.equal(result.ok, false);
  assert.match(result.error, /deadline/);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(parent.signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, before);
});

for (const duringBody of [false, true]) {
  test(`real HTTP parent cancellation closes the image socket ${duringBody ? "during body" : "before headers"}`, { timeout: 5000 }, async t => {
    let entered, closed;
    const requested = new Promise(resolve => entered = resolve), disconnected = new Promise(resolve => closed = resolve);
    const source = await server(t, (_request, response) => {
      response.on("close", closed);
      if (duringBody) { response.writeHead(200, { "Content-Type": "image/png" }); response.write(png.subarray(0, 10)); }
      entered();
    });
    const parent = new AbortController();
    const baseline = getEventListeners(parent.signal, "abort").length;
    const outcome = readImage({ ...args, url: source.origin + "/stalled.png" }, { ...config, abortSignal: parent.signal });
    await requested;
    parent.abort(new Error("Host cancelled the image read"));
    assert.equal((await outcome).ok, false);
    await disconnected;
    assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
  });
}

test("pre-cancelled and web-disabled input never dispatches or creates a perception client", async t => {
  let requests = 0, clients = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Unexpected network request"); });
  const parent = new AbortController(); parent.abort(new Error("Cancelled before image read"));
  const c = { ...config, provider: "openai", perceptionClientFactory: () => { clients++; throw new Error("Unexpected provider"); } };
  for (const override of [{ abortSignal: parent.signal }, { allowWebSearch: false }]) {
    const result = await readImage({ url: "http://127.0.0.1/image.png", prompt: args.prompt }, { ...c, ...override });
    assert.equal(result.ok, false);
  }
  assert.equal(requests, 0); assert.equal(clients, 0);
});

test("successful image read clears its deadline and parent abort listener", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const baseline = getEventListeners(parent.signal, "abort").length;
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal; return new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  assert.equal((await readImage({ ...args, url: "http://127.0.0.1/image.png" }, { ...config, abortSignal: parent.signal })).ok, true);
  t.mock.timers.tick(30000);
  assert.equal(signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
});

test("HTTP error bodies are cancelled without waiting for their producer", { timeout: 5000 }, async t => {
  let closed;
  const disconnected = new Promise(resolve => closed = resolve);
  const source = await server(t, (_request, response) => {
    response.on("close", closed);
    response.writeHead(404, { "Content-Type": "image/png" }); response.write(png.subarray(0, 10));
  });
  const result = await readImage({ ...args, url: source.origin + "/missing.png" }, config);
  assert.equal(result.ok, false); assert.match(result.error, /HTTP 404/);
  await disconnected;
});

test("real stalled HTTP image body keeps the 15-second deadline with a live caller signal", { timeout: 23000 }, async t => {
  let closed;
  const disconnected = new Promise(resolve => closed = resolve);
  const source = await server(t, (_request, response) => {
    response.on("close", closed);
    response.writeHead(200, { "Content-Type": "image/png" }); response.write(png.subarray(0, 10));
  });
  const parent = new AbortController();
  const baseline = getEventListeners(parent.signal, "abort").length;
  const result = await readImage({ ...args, url: source.origin + "/stalled.png" }, { ...config, abortSignal: parent.signal });
  assert.equal(result.ok, false); assert.match(result.error, /15000ms deadline/);
  assert.equal(parent.signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, baseline);
  await disconnected;
});

test("native client receives ordered exact pixels only after acquisition; retained artifacts contain metadata, not pixel bodies", { timeout: 5000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-remote-image-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, "workspace"); await fs.mkdir(workspace);
  const store = new SessionStore(path.join(temp, "sessions"), "remote-image-fixture");
  const imagePaths = [];
  const source = await server(t, (request, response) => {
    imagePaths.push(request.url);
    response.writeHead(200, { "Content-Type": "image/png" }); response.end(png);
  });
  let modelRequests = 0, inputImages;
  const model = await server(t, async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    modelRequests++;
    const body = []; for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body));
    inputImages = payload.messages[0].content.filter(part => part.type === "image_url");
    assert.equal(imagePaths.length, 2);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ summary: "Synthetic transport fixture", answer: "fixture reply", observations: [], visibleText: [], issues: [], uncertainty: [] }) }, finish_reason: "stop" }] }));
  });
  const images = [source.origin + "/first.png", source.origin + "/second.png"];
  const result = await readImage({ images, prompt: args.prompt }, {
    ...config, commandCwd: workspace, provider: "localllm", baseURL: model.origin + "/v1", apiKey: "synthetic-fixture-key",
    providerReadinessProbe: async request => ({ ok: true, checks: { models: { available: [request.selectedModel] } } }),
  }, store);
  assert.equal(result.ok, true, result.error);
  assert.equal(modelRequests, 1);
  assert.deepEqual(imagePaths, ["/first.png", "/second.png"]);
  assert.deepEqual(result.images.map(image => image.url), images);
  assert.equal(inputImages.length, 2);
  for (const part of inputImages) assert.equal(part.image_url.url, "data:image/png;base64," + png.toString("base64"));
  const retained = await fs.readFile(result.artifactPath, "utf8");
  assert.deepEqual(JSON.parse(retained).images, result.images);
  assert.doesNotMatch(retained, /data:image|synthetic-fixture-key/);
  assert.equal(JSON.parse(retained).result.answer, "fixture reply");
  await fs.access(result.markdownArtifactPath);
});

test("redirect-only credential material never becomes perception metadata or a retained artifact", { timeout: 5000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-remote-image-private-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, "workspace"); await fs.mkdir(workspace);
  const store = new SessionStore(path.join(temp, "sessions"), "remote-image-private-fixture");
  const marker = "synthetic-hidden-asset-auth";
  const source = await server(t, (request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { Location: `/private/${marker}/image.png?X-Amz-Signature=${marker}` }); response.end();
    } else {
      response.writeHead(200, { "Content-Type": "image/png" }); response.end(png);
    }
  });
  const url = source.origin + "/start";
  const result = await readImage({ ...args, url }, { ...config, commandCwd: workspace }, store);
  assert.equal(result.ok, true);
  assert.equal(result.images[0].url, url);
  assert.equal(Object.hasOwn(result.images[0], "finalUrl"), false);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal((await fs.readFile(result.artifactPath, "utf8")).includes(marker), false);
  assert.equal((await fs.readFile(result.markdownArtifactPath, "utf8")).includes(marker), false);
});
