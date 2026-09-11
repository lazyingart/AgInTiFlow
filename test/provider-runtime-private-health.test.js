import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { probeProviderRuntime } from "../src/provider-runtime.js";

const token = "synthetic-private-readiness-token";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("private readiness authenticates health and models on the configured origin", async t => {
  const paths = [];
  const baseURL = await fixture(t, (request, response) => {
    paths.push(request.url);
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/healthz") response.end(JSON.stringify({ ok: true, ollama: { ok: true } }));
    else if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "localllm-vision" }] }));
    else response.writeHead(404).end();
  });
  const result = await probeProviderRuntime({ provider: "localllm", baseURL, apiKey: token,
    selectedModel: "localllm-vision" });
  assert.equal(result.ok, true);
  assert.deepEqual(paths, ["/healthz", "/v1/models"]);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("a private health authentication failure stops before model discovery", async t => {
  const paths = [];
  const baseURL = await fixture(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(403).end();
  });
  await assert.rejects(probeProviderRuntime({ provider: "localllm", baseURL, apiKey: token,
    selectedModel: "localllm-vision" }), error => {
    assert.equal(error.code, "AUTHENTICATION_FAILED");
    assert.equal(error.stage, "health");
    assert.equal(error.status, 403);
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
  assert.deepEqual(paths, ["/healthz"]);
});

test("health redirects never forward a readiness credential", async t => {
  let reached = 0;
  const other = await fixture(t, (_request, response) => { reached++; response.end("{}"); });
  const baseURL = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: other.replace("/v1", "/healthz") }).end();
  });
  await assert.rejects(probeProviderRuntime({ provider: "localllm", baseURL, apiKey: token,
    selectedModel: "localllm-vision" }), { code: "PROBE_REDIRECT_REFUSED" });
  assert.equal(reached, 0);
});
