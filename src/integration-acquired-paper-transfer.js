// AGIPDF1 frame: 8-byte magic, uint32 BE JSON length, canonical UTF-8
// import metadata, then exactly metadata.files[0].bytes PDF bytes. No base64.
import { TextDecoder } from "node:util";
import { documentWorkerFail } from "./integration-document-worker-contract.js";
import { canonicalJson } from "./integration-policy.js";
import {
  ACQUIRED_PAPER_MAXIMUM_BYTES, normalizeAcquiredPaperImport, validateAcquiredPaperImportRequest,
} from "./integration-acquired-paper-contract.js";

export const ACQUIRED_PAPER_CONTENT_TYPE = "application/vnd.aginti.acquired-paper";
export const ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES = 16 * 1024;
export const ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES = 12 + ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES + ACQUIRED_PAPER_MAXIMUM_BYTES;
export const ACQUIRED_PAPER_TRANSFER_TIMEOUT_MS = 60_000;
const MAGIC = Buffer.from("AGIPDF1\n", "ascii");

function fail(oversized = false) {
  documentWorkerFail(oversized ? "BODY_TOO_LARGE" : "INVALID_REQUEST", "Paper binary frame is invalid.", {
    status: oversized ? 413 : 400,
  });
}

export function encodeAcquiredPaperFrame(metadata, bytes) {
  const normalized = normalizeAcquiredPaperImport(metadata, bytes);
  const owned = normalized.files[0].bytesValue;
  try {
    const request = validateAcquiredPaperImportRequest({
      ...normalized, files: normalized.files.map(({ bytesValue: _bytes, ...file }) => file),
    });
    const json = Buffer.from(canonicalJson(request), "utf8");
    if (json.length > ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES) fail(true);
    const header = Buffer.alloc(12);
    MAGIC.copy(header);
    header.writeUInt32BE(json.length, 8);
    return Object.freeze({
      chunks: Object.freeze([header, json, owned]),
      byteLength: header.length + json.length + owned.length,
      dispose() { json.fill(0); owned.fill(0); },
    });
  } catch (error) { owned.fill(0); throw error; }
}

export async function readAcquiredPaperFrame(stream, { signal, declaredBytes = null } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail();
  if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 14)) fail();
  if (declaredBytes > ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES) fail(true);
  const header = Buffer.alloc(12);
  let headerOffset = 0;
  let json = null;
  let jsonOffset = 0;
  let bytes = null;
  let bytesOffset = 0;
  let metadata = null;
  let received = 0;
  let completed = false;
  try {
    signal?.throwIfAborted();
    const chunks = typeof stream.iterator === "function" ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) fail();
      received += chunk.length;
      if (received > ACQUIRED_PAPER_MAXIMUM_FRAME_BYTES) fail(true);
      let offset = 0;
      while (offset < chunk.length) {
        if (headerOffset < header.length) {
          const count = Math.min(header.length - headerOffset, chunk.length - offset);
          chunk.copy(header, headerOffset, offset, offset + count);
          offset += count; headerOffset += count;
          if (headerOffset === header.length) {
            if (!header.subarray(0, 8).equals(MAGIC)) fail();
            const length = header.readUInt32BE(8);
            if (length > ACQUIRED_PAPER_MAXIMUM_METADATA_BYTES) fail(true);
            if (length < 2) fail();
            json = Buffer.alloc(length);
          }
        } else if (jsonOffset < json.length) {
          const count = Math.min(json.length - jsonOffset, chunk.length - offset);
          chunk.copy(json, jsonOffset, offset, offset + count);
          offset += count; jsonOffset += count;
          if (jsonOffset === json.length) {
            let text;
            try {
              text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(json);
              metadata = validateAcquiredPaperImportRequest(JSON.parse(text));
            } catch { fail(); }
            // Exact canonical form also rejects duplicate keys, BOM, alternative
            // numeric encodings and ambiguous metadata before allocating PDF bytes.
            if (canonicalJson(metadata) !== text) fail();
            const length = 12 + json.length + metadata.files[0].bytes;
            if (declaredBytes !== null && declaredBytes !== length) fail();
            bytes = Buffer.allocUnsafe(metadata.files[0].bytes);
          }
        } else {
          const count = Math.min(bytes.length - bytesOffset, chunk.length - offset);
          if (!count) fail();
          chunk.copy(bytes, bytesOffset, offset, offset + count);
          offset += count; bytesOffset += count;
        }
      }
    }
    signal?.throwIfAborted();
    if (!bytes || bytesOffset !== bytes.length ||
        (declaredBytes !== null && received !== declaredBytes)) fail();
    completed = true;
    return Object.freeze({ metadata, bytes });
  } finally {
    json?.fill(0);
    if (!completed) bytes?.fill(0);
  }
}
