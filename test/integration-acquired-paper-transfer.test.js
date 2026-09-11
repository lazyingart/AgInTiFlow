import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES, ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES,
  encodeAcquiredPaperFrame, readAcquiredPaperFrame,
} from "../src/integration-acquired-paper-transfer.js";
import { canonicalJson } from "../src/integration-policy.js";
import { pdf, issueRequest, importRequest } from "./fixtures/acquired-paper.js";

function frame(bytes = pdf(1024)) {
  const metadata = importRequest(issueRequest(bytes));
  const encoded = encodeAcquiredPaperFrame(metadata, bytes);
  const body = Buffer.concat(encoded.chunks);
  encoded.dispose();
  return { metadata, bytes, body };
}
function withJson(body, text) {
  const header = Buffer.from(body.subarray(0, 12));
  const json = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const pdfBytes = body.subarray(12 + body.readUInt32BE(8));
  header.writeUInt32BE(json.length, 8);
  return Buffer.concat([header, json, pdfBytes]);
}
const fails = (body, code = "INVALID_REQUEST", options) => assert.rejects(
  readAcquiredPaperFrame(Readable.from([body]), options), error => error.code === code,
);

for (const length of [1, 7, 12, 13, 67, 65536]) test(`binary frame preserves metadata and bytes across ${length}-byte boundaries`, async () => {
  const f = frame();
  const chunks = [];
  for (let index = 0; index < f.body.length; index += length) chunks.push(f.body.subarray(index, index + length));
  const result = await readAcquiredPaperFrame(Readable.from(chunks), { declaredBytes: f.body.length });
  assert.deepEqual(result.metadata, f.metadata);
  assert.deepEqual(result.bytes, f.bytes);
  result.bytes.fill(0);
});

test("encoder owns the bytes and disposal clears its private payload", async () => {
  const bytes = pdf();
  const original = Buffer.from(bytes);
  const metadata = importRequest(issueRequest(bytes));
  const encoded = encodeAcquiredPaperFrame(metadata, bytes);
  bytes.fill(0);
  const result = await readAcquiredPaperFrame(Readable.from(encoded.chunks));
  assert.deepEqual(result.bytes, original);
  encoded.dispose();
  assert(encoded.chunks[1].every(byte => byte === 0));
  assert(encoded.chunks[2].every(byte => byte === 0));
});

for (const [name, change, code = "INVALID_REQUEST"] of [
  ["magic", body => { body[0] = 0; return body; }],
  ["metadata size", body => { body.writeUInt32BE(ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES + 1, 8); return body; }, "BODY_TOO_LARGE"],
  ["empty metadata", body => { body.writeUInt32BE(0, 8); return body; }],
  ["partial prefix", body => body.subarray(0, 11)],
  ["partial metadata", body => body.subarray(0, 33)],
  ["partial PDF", body => body.subarray(0, -1)],
  ["trailing PDF bytes", body => Buffer.concat([body, Buffer.from("x")])],
  ["UTF-8", body => withJson(body, Buffer.from([0xff, 0xfe]))],
  ["BOM", body => withJson(body, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body.subarray(12, 12 + body.readUInt32BE(8))]))],
  ["whitespace", body => withJson(body, body.subarray(12, 12 + body.readUInt32BE(8)).toString() + "\n")],
  ["duplicate key", body => withJson(body, body.subarray(12, 12 + body.readUInt32BE(8)).toString().replace('"authorityEpoch":1', '"authorityEpoch":1,"authorityEpoch":1'))],
  ["extra policy", body => { const value = JSON.parse(body.subarray(12, 12 + body.readUInt32BE(8))); value.allowedOrigins = ["https://example.org"]; return withJson(body, canonicalJson(value)); }],
]) test(`reject ${name}`, async () => { await fails(change(frame().body), code); });

test("declared size is checked before reading and against the metadata", async () => {
  let read = false;
  async function* input() { read = true; yield frame().body; }
  await assert.rejects(readAcquiredPaperFrame(input(), { declaredBytes: ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES + 1 }), error => error.code === "BODY_TOO_LARGE");
  assert.equal(read, false);
  const f = frame();
  await fails(f.body, "INVALID_REQUEST", { declaredBytes: f.body.length - 1 });
  await fails(f.body, "INVALID_REQUEST", { declaredBytes: f.body.length + 1 });
});

test("pre-cancelled and interrupted transfers stop without a partial result", async () => {
  const f = frame();
  await assert.rejects(readAcquiredPaperFrame(Readable.from([f.body]), { signal: AbortSignal.abort() }), { name: "AbortError" });
  const controller = new AbortController();
  async function* interrupted() { yield f.body.subarray(0, -3); controller.abort(); yield f.body.subarray(-3); }
  await assert.rejects(readAcquiredPaperFrame(interrupted(), { signal: controller.signal }), { name: "AbortError" });
});
