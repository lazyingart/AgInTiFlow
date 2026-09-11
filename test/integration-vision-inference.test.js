import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeIntegrationRequest, INTEGRATION_RPC_PATHS,
  validateIntegrationInference } from "../src/integration-policy.js";

const image = { attachmentId: "att_" + "a".repeat(32), mediaType: "image/png",
  data: Buffer.alloc(32, 1).toString("base64") };
const threadId = "thr_12345678-1234-4123-8123-123456789abc";
const input = { text: "Describe this image as JSON", searchInference: false,
  inference: { responseFormat: "json_object", vision: true }, attachments: [image] };
const validate = (value) => sanitizeIntegrationRequest(INTEGRATION_RPC_PATHS.runsStart, { threadId, input: value });

test("explicit local perception can feed a tool-free JSON inference", () => {
  assert.deepEqual(validate(input).input, input);
  assert.deepEqual(validateIntegrationInference(input.inference), input.inference);
});

test("legacy text inference remains unchanged and does not accept implicit images", () => {
  const inference = { responseFormat: "json_object" };
  assert.deepEqual(validateIntegrationInference(inference), inference);
  assert.throws(() => validate({ ...input, inference }));
});

test("vision inference retains explicit and inferred search denial", () => {
  for (const extra of [{ searchInference: true }, { search: { mode: "papers", limit: 2 } }]) {
    assert.throws(() => validate({ ...input, ...extra }));
  }
});

test("vision opt-in accepts only true and retains exact inference fields", () => {
  for (const vision of [false, null, 1, "true", {}]) {
    assert.throws(() => validate({ ...input, inference: { responseFormat: "json_object", vision } }));
  }
  for (const extra of [{ tools: true }, { model: "other" }, { endpoint: "https://example.test" }]) {
    assert.throws(() => validate({ ...input, inference: { ...input.inference, ...extra } }));
  }
});

test("perception opt-in retains attachment validation", () => {
  for (const attachments of [[], [image, image], [{ ...image, data: "not-base64" }]]) {
    assert.throws(() => validate({ ...input, attachments }));
  }
});
