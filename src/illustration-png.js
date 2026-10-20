import { inflateSync, deflateSync } from "node:zlib";
import { types } from "node:util";
import { PROFILE, bytesDigest, reject } from "./illustration-contract.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  output.write(type, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc(output.subarray(4, -4)), output.length - 4);
  return output;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}

// Deliberately narrow PNG subset: 8-bit RGB/RGBA, non-interlaced. Decode every
// scanline, verify all CRCs, then emit only IHDR/IDAT/IEND. Never trust MIME alone.
export function validateIllustrationPng(input) {
  if (types.isProxy(input) || !Buffer.isBuffer(input) || input.length > PROFILE.maxImageBytes || !input.subarray(0, 8).equals(SIGNATURE)) reject("ILLUSTRATION_PNG_INVALID", 502);
  const bytes = Buffer.from(input);
  let offset = 8, header = null, ended = false, idatEnded = false;
  const parts = [];
  let count = 0;
  while (offset < bytes.length) {
    if (++count > 256 || offset + 12 > bytes.length || ended) reject("ILLUSTRATION_PNG_INVALID", 502);
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) reject("ILLUSTRATION_PNG_INVALID", 502);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!bytes.subarray(offset + 4, offset + 8).every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) || (bytes[offset + 6] & 32) || crc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) reject("ILLUSTRATION_PNG_INVALID", 502);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!header && type !== "IHDR") reject("ILLUSTRATION_PNG_INVALID", 502);
    if (type === "IHDR") {
      if (header || length !== 13) reject("ILLUSTRATION_PNG_INVALID", 502);
      header = Buffer.from(data);
    } else if (type === "IDAT") {
      if (idatEnded) reject("ILLUSTRATION_PNG_INVALID", 502);
      parts.push(data);
    } else if (type === "IEND") {
      if (length || !parts.length) reject("ILLUSTRATION_PNG_INVALID", 502);
      ended = true;
    } else {
      // tRNS changes pixel alpha, unlike removable descriptive metadata. This
      // subset requires explicit RGBA rather than silently discarding it.
      if (!(bytes[offset + 4] & 32) || ["acTL", "fcTL", "fdAT", "tRNS"].includes(type)) reject("ILLUSTRATION_PNG_INVALID", 502);
      if (parts.length) idatEnded = true;
    }
    offset += length + 12;
  }
  if (!ended || !header) reject("ILLUSTRATION_PNG_INVALID", 502);
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  if (!width || !height || width > PROFILE.maxDimension || height > PROFILE.maxDimension || width * height > PROFILE.maxPixels || header[8] !== 8 || ![2, 6].includes(header[9]) || header[10] || header[11] || header[12]) reject("ILLUSTRATION_PNG_INVALID", 502);
  const channels = header[9] === 2 ? 3 : 4;
  const stride = width * channels, size = (stride + 1) * height;
  const compressed = Buffer.concat(parts);
  let inflated;
  try {
    const result = inflateSync(compressed, { maxOutputLength: size, info: true });
    if (result.engine.bytesWritten !== compressed.length || result.buffer.length !== size) reject();
    inflated = result.buffer;
  } catch { reject("ILLUSTRATION_PNG_INVALID", 502); }
  const pixels = Buffer.alloc(size);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1), filter = inflated[row];
    if (filter > 4) reject("ILLUSTRATION_PNG_INVALID", 502);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + 1 + x - channels] : 0;
      const up = y ? pixels[row + 1 + x - stride - 1] : 0;
      const corner = y && x >= channels ? pixels[row + 1 + x - stride - 1 - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[row + 1 + x] = (inflated[row + 1 + x] + predictor) & 255;
    }
  }
  const output = Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  if (output.length > PROFILE.maxImageBytes) reject("ILLUSTRATION_PNG_INVALID", 502);
  return { bytes: output, width, height, sha256: bytesDigest(output), byteLength: output.length };
}
