import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = fileURLToPath(new URL("../", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/restricted-startup-probe.js", import.meta.url));
const loader = new URL("./fixtures/restricted-startup-loader.js", import.meta.url);
function run(mode) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-startup-boundary-"));
  try {
    const trace = path.join(temporary, "imports.jsonl"), hook = new URL(loader);
    hook.searchParams.set("trace", trace); hook.searchParams.set("source", new URL("../src/", import.meta.url).href);
    hook.searchParams.set("client", mode === "explicit-http" ? "1" : "0");
    const child = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", hook.href, probe, path.join(root, "src/restricted-application.js"), mode], {
      cwd: temporary, env: { PATH: process.env.PATH, HOME: temporary, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    const result = JSON.parse(child.stdout);
    const imports = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(imports.every(r => typeof r.fromCore === "boolean" && typeof r.denied === "boolean"));
    assert.equal(result.network, 0);
    assert.deepEqual(imports.filter(r => r.denied), [], "No provider, runner, filesystem or unselected transport may be imported.");
    return { code: child.status, result, imports };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); assert.equal(fs.existsSync(temporary), false); }
}
for (const mode of ["text", "text-capable", "ordered-images"]) test("restricted startup needs no unused provider SDK: " + mode, () => {
  const r = run(mode); assert.equal(r.code, 0); assert.equal(r.result.status, "completed"); assert.equal(r.result.callbacks, 1);
});
for (const [mode, code] of [["reject-images", "VISION_UNAVAILABLE"], ["corrupt-image", "INVALID_IMAGE"]]) test("pure image admission still fails closed: " + mode, () => {
  const r = run(mode); assert.equal(r.code, 1); assert.equal(r.result.code, code); assert.equal(r.result.callbacks, 0);
});
test("the explicit DeepSeek client can construct and close with no other provider or request", () => {
  const r = run("explicit-http"); assert.equal(r.code, 0); assert.equal(r.result.status, "client-closed"); assert.equal(r.result.callbacks, 0);
});
test("the vision facade retains the exact shared image API and error identity", async () => {
  const vision = await import("../src/integration-analysis-vision.js");
  const pure = await import("../src/integration-analysis-image.js");
  for (const key of ["IntegrationAnalysisVisionError", "inspectIntegrationAnalysisImageBytes", "assertIntegrationAnalysisVisionAttachmentSetWork",
    "INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION", "INTEGRATION_ANALYSIS_VISION_MAX_PIXELS", "INTEGRATION_ANALYSIS_VISION_MAX_DECODED_BYTES",
    "INTEGRATION_ANALYSIS_VISION_MAX_PNG_DECOMPRESSED_BYTES", "INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES"]) assert.equal(vision[key], pure[key], key);
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; }, getPrototypeOf() { traps++; }, ownKeys() { traps++; return []; } });
  assert.throws(() => pure.inspectIntegrationAnalysisImageBytes(proxy, "image/png"), error => error instanceof vision.IntegrationAnalysisVisionError && error.code === "ANALYSIS_IMAGE_INVALID" && error.status === 400);
  assert.equal(traps, 0);
  assert.throws(() => pure.inspectIntegrationAnalysisImageBytes(Buffer.alloc(32), "image/png", proxy),
    error => error instanceof vision.IntegrationAnalysisVisionError && error.code === "ANALYSIS_VISION_INVALID" && error.status === 400);
  assert.equal(traps, 0);
  const spoof = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  assert.throws(() => pure.inspectIntegrationAnalysisImageBytes(Buffer.alloc(32), "image/png", spoof),
    error => error instanceof vision.IntegrationAnalysisVisionError && error.code === "ANALYSIS_VISION_INVALID" && error.status === 400);
  assert.equal(traps, 0);
});
