import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import katex from "katex";
import { getMcpConnection, closeAllMcpConnections } from "../src/mcp/client-registry.js";
import { renderMathExpression } from "../public/math-renderer.js";

test("inherited KaTeX trust cannot authorize a JavaScript URL", () => {
  const source = "\\href{javascript:alert(1)}{untrusted}";
  const html = katex.renderToString(source, Object.create({ trust: true, strict: "ignore" }));
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(renderMathExpression(source), /href="javascript:/);
  const ordinary = renderMathExpression("E=mc^2");
  assert.match(ordinary, /katex-mathml/);
  assert.match(ordinary, /role="math"/);
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}
async function close(fixture) {
  if (!fixture) return;
  await new Promise((resolve, reject) => {
    fixture.server.close((error) => error ? reject(error) : resolve());
    fixture.server.closeAllConnections();
  });
}
for (const status of [307, 308]) {
  test(`MCP ${status} redirect cannot forward app headers or request body to another origin`, { timeout: 5000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-dependency-boundary-"));
    let source, target, sourceRequests = 0, targetRequests = 0, originalHeader;
    const marker = "synthetic-private-app-header";
    try {
      target = await listen((request, response) => {
        targetRequests++;
        request.resume();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {
          protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "redirect-target", version: "1" },
        } }));
      });
      source = await listen((request, response) => {
        sourceRequests++;
        originalHeader = request.headers["x-app-key"];
        request.resume();
        response.writeHead(status, { Location: target.url }); response.end();
      });
      await fs.mkdir(path.join(root, ".aginti"));
      await fs.writeFile(path.join(root, ".aginti/mcp.json"), JSON.stringify({ mcpServers: {
        "redirect-boundary": { transport: "http", url: source.url, headers: { "X-App-Key": marker }, startupTimeoutMs: 1000 },
      } }));
      await assert.rejects(getMcpConnection("redirect-boundary", { commandCwd: root }), /redirect/i);
      assert.ok(sourceRequests >= 1);
      assert.equal(originalHeader, marker, "the configured origin must actually receive the app header");
      assert.equal(targetRequests, 0, "a different port is a different origin and must receive no work");
    } finally {
      await closeAllMcpConnections(); await close(source); await close(target);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
