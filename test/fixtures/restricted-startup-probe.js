import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, mode] = process.argv.slice(2);
let network = 0, callbacks = 0;
globalThis.fetch = () => { network++; throw Error("No network in offline startup probe."); };
https.request = http.request = () => { network++; throw Error("No requests in offline startup probe."); };
syncBuiltinESMExports();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const jpeg = "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
try {
  const { createRestrictedApplicationRunner } = await import(pathToFileURL(entry));
  if (mode === "explicit-http") {
    const companion = new URL("./restricted-deepseek-client.js", pathToFileURL(entry));
    const { createRestrictedDeepSeekClient } = await import(companion);
    const client = createRestrictedDeepSeekClient({ apiKey: "synthetic-startup-fixture-credential", model: "deepseek-flash", userId: "startup_fixture_scope_20261114" });
    await client.close();
    console.log(JSON.stringify({ status: "client-closed", callbacks, network }));
  } else {
    const supportsImages = !["text", "reject-images"].includes(mode);
    const parts = [{ type: "text", text: "Summarize the supplied update; do not change anything." }];
    if (["ordered-images", "reject-images"].includes(mode)) parts.push({ type: "image", mediaType: "image/jpeg", data: jpeg }, { type: "image", mediaType: "image/png", data: png });
    if (mode === "corrupt-image") parts.push({ type: "image", mediaType: "image/png", data: Buffer.alloc(32).toString("base64") });
    const app = createRestrictedApplicationRunner({ provider: { supportsImages, complete(request) {
      callbacks++;
      if (mode === "ordered-images") assert.deepEqual(request.messages.at(-1).content.slice(1).map(p => [p.mediaType, p.data]), [["image/jpeg", jpeg], ["image/png", png]]);
      return { type: "final", value: { reply: "The supplied update is ready for review." } };
    } }, tools: [], instructions: "Propose only from the supplied input; no committed change.", outputSchema: { type: "object", properties: { reply: { type: "string", maxLength: 200 } }, required: ["reply"], additionalProperties: false } });
    const result = await app.run({ input: parts }); assert.equal(result.status, "completed");
    console.log(JSON.stringify({ status: "completed", callbacks, network }));
  }
} catch (error) {
  console.log(JSON.stringify({ status: "rejected", code: typeof error?.code === "string" ? error.code : "ERROR", callbacks, network }));
  process.exitCode = 1;
}
