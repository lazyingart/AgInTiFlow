// Shared synchronous image-data boundary. No provider, runtime probe, HTTP,
// filesystem, configuration loader or service is needed to validate bytes.
import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import { inflateSync } from "node:zlib";
import {
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT,
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES,
  integrationExactKeys,
} from "./integration-policy.js";

export const INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION = 8192;
export const INTEGRATION_ANALYSIS_VISION_MAX_PIXELS = 20_000_000;
export const INTEGRATION_ANALYSIS_VISION_MAX_DECODED_BYTES = 64 * 1024 * 1024;
export const INTEGRATION_ANALYSIS_VISION_MAX_PNG_DECOMPRESSED_BYTES =
  INTEGRATION_ANALYSIS_VISION_MAX_DECODED_BYTES + INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION;
export const INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES =
  (INTEGRATION_ANALYSIS_VISION_MAX_PIXELS * 4 + INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION) *
  INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_COUNT_LIMIT;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAXIMUM_IMAGE_STRUCTURE_RECORDS = 4096;

export class IntegrationAnalysisVisionError extends Error {
  constructor(code, message, { status = 503, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IntegrationAnalysisVisionError";
    this.code = code;
    this.publicCode = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fail(code, message, { status = 503, cause } = {}) {
  throw new IntegrationAnalysisVisionError(code, message, { status, cause });
}

function exact(value, allowed, required, label) {
  if (utilTypes.isProxy(value)) fail("ANALYSIS_VISION_INVALID", `${label} is invalid.`, { status: 400 });
  try {
    return integrationExactKeys(value, allowed, label, required);
  } catch (error) {
    fail("ANALYSIS_VISION_INVALID", `${label} is invalid.`, { status: 400, cause: error });
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("ANALYSIS_VISION_INVALID", `${label} is outside its bound.`, { status: 400 });
  }
  return value;
}

function assertImageBounds(width, height, decodedBytes) {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 ||
    width > INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION ||
    height > INTEGRATION_ANALYSIS_VISION_MAX_DIMENSION ||
    width * height > INTEGRATION_ANALYSIS_VISION_MAX_PIXELS ||
    !Number.isSafeInteger(decodedBytes) || decodedBytes < 1 ||
    decodedBytes > INTEGRATION_ANALYSIS_VISION_MAX_DECODED_BYTES
  ) {
    fail(
      "ANALYSIS_IMAGE_INVALID",
      "Image dimensions or decoded size exceed the bounded vision profile.",
      { status: 400 }
    );
  }
}

function pngCrc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFacts(bytes, { maximumPngWorkBytes = INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES } = {}) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail("ANALYSIS_IMAGE_INVALID", "PNG signature is invalid or truncated.", { status: 400 });
  }
  let offset = 8;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let hasHeader = false;
  let hasPalette = false;
  let hasImageData = false;
  let imageDataEnded = false;
  let ended = false;
  let compressedBytes = 0;
  const imageData = [];
  while (offset < bytes.length && chunks < MAXIMUM_IMAGE_STRUCTURE_RECORDS) {
    if (offset + 12 > bytes.length) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG chunk is truncated.", { status: 400 });
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG chunk length is invalid.", { status: 400 });
    }
    const type = bytes.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2].toUpperCase()) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG chunk type is invalid.", { status: 400 });
    }
    if (pngCrc32(bytes, typeStart, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG chunk CRC is invalid.", { status: 400 });
    }
    if (chunks === 0 && type !== "IHDR") {
      fail("ANALYSIS_IMAGE_INVALID", "PNG IHDR must be first.", { status: 400 });
    }
    if (type === "IHDR") {
      if (hasHeader || length !== 13) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG IHDR is invalid or duplicated.", { status: 400 });
      }
      hasHeader = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const allowedDepths = colorType === 0
        ? [1, 2, 4, 8]
        : colorType === 3
          ? [1, 2, 4, 8]
          : colorType === 2 || colorType === 4 || colorType === 6
            ? [8]
            : [];
      if (
        !allowedDepths.includes(bitDepth) || bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0
      ) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG IHDR fields are unsupported.", { status: 400 });
      }
    } else if (!hasHeader) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG data precedes IHDR.", { status: 400 });
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      fail("ANALYSIS_IMAGE_INVALID", "Animated PNG images are not accepted.", { status: 400 });
    }
    if (type === "PLTE") {
      if (
        hasPalette || hasImageData || colorType === 0 || colorType === 4 ||
        length < 3 || length > 768 || length % 3 !== 0
      ) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG palette placement or size is invalid.", { status: 400 });
      }
      hasPalette = true;
    }
    if (type === "IDAT") {
      if (imageDataEnded) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG IDAT chunks must be contiguous.", { status: 400 });
      }
      hasImageData = true;
      compressedBytes += length;
      if (compressedBytes > INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG compressed data exceeds its bound.", { status: 400 });
      }
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (hasImageData && type !== "IEND") {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG terminator is invalid.", { status: 400 });
      }
      ended = true;
      offset = end;
      chunks += 1;
      break;
    }
    if (type[0] === type[0].toUpperCase() && !new Set(["IHDR", "PLTE", "IDAT"]).has(type)) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG contains an unsupported critical chunk.", { status: 400 });
    }
    offset = end;
    chunks += 1;
  }
  if (
    !ended || !hasHeader || !hasImageData || compressedBytes < 1 ||
    (colorType === 3 && !hasPalette) || offset !== bytes.length ||
    chunks >= MAXIMUM_IMAGE_STRUCTURE_RECORDS
  ) {
    fail("ANALYSIS_IMAGE_INVALID", "PNG structure is incomplete or exceeds its bound.", { status: 400 });
  }
  const channels = colorType === 0 || colorType === 3
    ? 1
    : colorType === 2
      ? 3
      : colorType === 4
        ? 2
        : 4;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const decodedPixelBytes = height * rowBytes;
  const decodedBytes = decodedPixelBytes + height;
  assertImageBounds(width, height, decodedPixelBytes);
  const pngWorkBytes = width * height * 4 + height;
  if (
    !Number.isSafeInteger(pngWorkBytes) || pngWorkBytes > maximumPngWorkBytes
  ) {
    fail(
      "ANALYSIS_IMAGE_WORK_LIMIT",
      "The image set exceeds the bounded PNG decompression-work profile.",
      { status: 400 }
    );
  }
  if (
    !Number.isSafeInteger(decodedBytes) ||
    decodedBytes > INTEGRATION_ANALYSIS_VISION_MAX_PNG_DECOMPRESSED_BYTES
  ) {
    fail("ANALYSIS_IMAGE_INVALID", "PNG decompressed size exceeds the bounded vision profile.", {
      status: 400,
    });
  }
  let compressed = null;
  let decoded = null;
  try {
    compressed = Buffer.concat(imageData, compressedBytes);
    const inflated = inflateSync(compressed, { maxOutputLength: decodedBytes, info: true });
    decoded = inflated.buffer;
    const consumed = Number(inflated.engine?.bytesWritten || 0);
    if (decoded.length !== decodedBytes || consumed !== compressedBytes) {
      fail("ANALYSIS_IMAGE_INVALID", "PNG compressed stream boundary or decoded length is invalid.", {
        status: 400,
      });
    }
    for (let row = 0; row < height; row += 1) {
      if (decoded[row * (rowBytes + 1)] > 4) {
        fail("ANALYSIS_IMAGE_INVALID", "PNG scanline filter is invalid.", { status: 400 });
      }
    }
  } catch (error) {
    if (error instanceof IntegrationAnalysisVisionError) throw error;
    fail("ANALYSIS_IMAGE_INVALID", "PNG compressed image data does not decode safely.", {
      status: 400,
      cause: error,
    });
  } finally {
    decoded?.fill(0);
    compressed?.fill(0);
  }
  return Object.freeze({
    mediaType: "image/png",
    width,
    height,
    pixelCount: width * height,
    decodedBytes,
    pngWorkBytes,
  });
}

function jpegFacts(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    fail("ANALYSIS_IMAGE_INVALID", "JPEG boundary markers are invalid or truncated.", { status: 400 });
  }
  let offset = 2;
  let segments = 0;
  let facts = null;
  let frameComponents = null;
  let scanFound = false;
  let quantizationTables = 0;
  const huffmanTables = new Set();
  let restartInterval = 0;
  let maximumHorizontalSampling = 0;
  let maximumVerticalSampling = 0;
  let blocksPerMcu = 0;
  while (offset < bytes.length - 2 && segments < MAXIMUM_IMAGE_STRUCTURE_RECORDS) {
    if (bytes[offset] !== 0xff) {
      fail("ANALYSIS_IMAGE_INVALID", "JPEG marker stream is invalid before image data.", { status: 400 });
    }
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      fail("ANALYSIS_IMAGE_INVALID", "JPEG marker stream contains invalid stuffing.", { status: 400 });
    }
    if (offset + 2 > bytes.length - 2) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) break;
    const dataStart = offset + 2;
    const dataEnd = offset + length;
    if (marker === 0xc0) {
      if (facts !== null || length < 11) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG frame header is duplicated or truncated.", { status: 400 });
      }
      const precision = bytes[offset + 2];
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (precision !== 8 || !new Set([1, 3]).has(components) || length !== 8 + 3 * components) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG frame format is unsupported.", { status: 400 });
      }
      const decodedBytes = width * height * 4;
      assertImageBounds(width, height, decodedBytes);
      frameComponents = new Set();
      for (let index = 0; index < components; index += 1) {
        const componentOffset = offset + 8 + index * 3;
        const componentId = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const quantizationTable = bytes[componentOffset + 2];
        if (
          frameComponents.has(componentId) || (sampling >>> 4) < 1 || (sampling >>> 4) > 4 ||
          (sampling & 0x0f) < 1 || (sampling & 0x0f) > 4 || quantizationTable > 3
        ) {
          fail("ANALYSIS_IMAGE_INVALID", "JPEG frame components are invalid.", { status: 400 });
        }
        maximumHorizontalSampling = Math.max(maximumHorizontalSampling, sampling >>> 4);
        maximumVerticalSampling = Math.max(maximumVerticalSampling, sampling & 0x0f);
        blocksPerMcu += (sampling >>> 4) * (sampling & 0x0f);
        frameComponents.add(componentId);
      }
      facts = Object.freeze({
        mediaType: "image/jpeg",
        width,
        height,
        pixelCount: width * height,
        decodedBytes,
      });
    } else if ((marker >= 0xc1 && marker <= 0xcf) && !new Set([0xc4, 0xc8, 0xcc]).has(marker)) {
      fail("ANALYSIS_IMAGE_INVALID", "JPEG frame coding mode is unsupported.", { status: 400 });
    } else if (marker === 0xdb) {
      let cursor = dataStart;
      while (cursor < dataEnd) {
        const selector = bytes[cursor];
        const precision = selector >>> 4;
        const table = selector & 0x0f;
        const tableBytes = precision === 0 ? 64 : precision === 1 ? 128 : 0;
        if (table > 3 || tableBytes === 0 || cursor + 1 + tableBytes > dataEnd) {
          fail("ANALYSIS_IMAGE_INVALID", "JPEG quantization table is invalid.", { status: 400 });
        }
        quantizationTables += 1;
        cursor += 1 + tableBytes;
      }
      if (cursor !== dataEnd) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG quantization table boundary is invalid.", { status: 400 });
      }
    } else if (marker === 0xc4) {
      let cursor = dataStart;
      while (cursor < dataEnd) {
        if (cursor + 17 > dataEnd) {
          fail("ANALYSIS_IMAGE_INVALID", "JPEG Huffman table is truncated.", { status: 400 });
        }
        const selector = bytes[cursor];
        const tableClass = selector >>> 4;
        const table = selector & 0x0f;
        let symbols = 0;
        for (let index = 1; index <= 16; index += 1) symbols += bytes[cursor + index];
        if (tableClass > 1 || table > 3 || symbols < 1 || symbols > 256 || cursor + 17 + symbols > dataEnd) {
          fail("ANALYSIS_IMAGE_INVALID", "JPEG Huffman table is invalid.", { status: 400 });
        }
        huffmanTables.add(`${tableClass}:${table}`);
        cursor += 17 + symbols;
      }
      if (cursor !== dataEnd) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG Huffman table boundary is invalid.", { status: 400 });
      }
    } else if (marker === 0xdd) {
      if (length !== 4 || restartInterval !== 0) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG restart interval is invalid.", { status: 400 });
      }
      restartInterval = bytes.readUInt16BE(dataStart);
    } else if (marker === 0xda) {
      if (facts === null || frameComponents === null || quantizationTables < 1 || huffmanTables.size < 2) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG scan lacks its bounded decode tables.", { status: 400 });
      }
      const components = bytes[dataStart];
      if (components !== frameComponents.size || length !== 6 + 2 * components) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG scan header is invalid.", { status: 400 });
      }
      const scanComponents = new Set();
      for (let index = 0; index < components; index += 1) {
        const componentOffset = dataStart + 1 + index * 2;
        const componentId = bytes[componentOffset];
        const selectors = bytes[componentOffset + 1];
        const dcTable = selectors >>> 4;
        const acTable = selectors & 0x0f;
        if (
          !frameComponents.has(componentId) || scanComponents.has(componentId) ||
          !huffmanTables.has(`0:${dcTable}`) || !huffmanTables.has(`1:${acTable}`)
        ) {
          fail("ANALYSIS_IMAGE_INVALID", "JPEG scan component tables are invalid.", { status: 400 });
        }
        scanComponents.add(componentId);
      }
      const spectralOffset = dataStart + 1 + 2 * components;
      if (
        bytes[spectralOffset] !== 0 || bytes[spectralOffset + 1] !== 63 ||
        bytes[spectralOffset + 2] !== 0
      ) {
        fail("ANALYSIS_IMAGE_INVALID", "JPEG scan is not bounded baseline sequential data.", { status: 400 });
      }
      let cursor = dataEnd;
      let entropyBytes = 0;
      let restartMarkers = 0;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) {
          entropyBytes += 1;
          cursor += 1;
          continue;
        }
        let markerOffset = cursor + 1;
        while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= bytes.length) break;
        const scanMarker = bytes[markerOffset];
        if (scanMarker === 0x00) {
          entropyBytes += 1;
          cursor = markerOffset + 1;
          continue;
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          if (restartInterval === 0) {
            fail("ANALYSIS_IMAGE_INVALID", "JPEG restart marker lacks a declared interval.", { status: 400 });
          }
          restartMarkers += 1;
          cursor = markerOffset + 1;
          continue;
        }
        if (scanMarker === 0xd9 && markerOffset + 1 === bytes.length) {
          const mcuColumns = Math.ceil(facts.width / (8 * maximumHorizontalSampling));
          const mcuRows = Math.ceil(facts.height / (8 * maximumVerticalSampling));
          const minimumEntropyBits = mcuColumns * mcuRows * blocksPerMcu * 2;
          if (
            entropyBytes < 1 || entropyBytes * 8 < minimumEntropyBits ||
            (restartMarkers > 0 && restartInterval === 0)
          ) {
            fail("ANALYSIS_IMAGE_INVALID", "JPEG entropy-coded scan is empty or invalid.", { status: 400 });
          }
          scanFound = true;
          offset = bytes.length;
          break;
        }
        fail("ANALYSIS_IMAGE_INVALID", "JPEG scan contains an unsupported or corrupt marker.", { status: 400 });
      }
      break;
    }
    offset += length;
    segments += 1;
  }
  if (!scanFound || facts === null || offset !== bytes.length || segments >= MAXIMUM_IMAGE_STRUCTURE_RECORDS) {
    fail("ANALYSIS_IMAGE_INVALID", "JPEG has no valid bounded still-image frame.", { status: 400 });
  }
  return facts;
}

export function inspectIntegrationAnalysisImageBytes(bytesInput, mediaType, options = {}) {
  const checkedOptions = exact(
    options,
    ["maximumPngWorkBytes"],
    [],
    "analysis image inspection options"
  );
  const maximumPngWorkBytes = checkedOptions.maximumPngWorkBytes === undefined
    ? INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES
    : boundedInteger(
        checkedOptions.maximumPngWorkBytes,
        "analysis image maximumPngWorkBytes",
        0,
        INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES
      );
  if (utilTypes.isProxy(bytesInput) || !Buffer.isBuffer(bytesInput)) {
    fail("ANALYSIS_IMAGE_INVALID", "Image bytes must be an exact Buffer.", { status: 400 });
  }
  if (
    bytesInput.length < 16 ||
    bytesInput.length > INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_BYTES_LIMIT ||
    !INTEGRATION_ANALYSIS_IMAGE_ATTACHMENT_MEDIA_TYPES.includes(mediaType)
  ) {
    fail("ANALYSIS_IMAGE_INVALID", "Image bytes or media type exceed the admitted profile.", { status: 400 });
  }
  const facts = mediaType === "image/png"
    ? pngFacts(bytesInput, { maximumPngWorkBytes })
    : jpegFacts(bytesInput);
  if (facts.mediaType !== mediaType) {
    fail("ANALYSIS_IMAGE_INVALID", "Image bytes do not match the declared media type.", { status: 400 });
  }
  return Object.freeze({
    ...facts,
    byteLength: bytesInput.length,
    sha256: crypto.createHash("sha256").update(bytesInput).digest("hex"),
  });
}

export function assertIntegrationAnalysisVisionAttachmentSetWork(value) {
  if (!Array.isArray(value)) {
    fail("ANALYSIS_VISION_INVALID", "Analysis vision attachment set is invalid.", { status: 400 });
  }
  let pngWorkBytes = 0;
  for (const attachment of value) {
    if (attachment?.mediaType !== "image/png") continue;
    if (
      !Number.isSafeInteger(attachment.width) || !Number.isSafeInteger(attachment.height) ||
      attachment.width < 1 || attachment.height < 1
    ) {
      fail("ANALYSIS_VISION_INVALID", "Analysis vision PNG dimensions are invalid.", { status: 400 });
    }
    const workBytes = attachment.width * attachment.height * 4 + attachment.height;
    if (!Number.isSafeInteger(workBytes)) {
      fail("ANALYSIS_VISION_INVALID", "Analysis vision PNG work bound is invalid.", { status: 400 });
    }
    pngWorkBytes += workBytes;
    if (pngWorkBytes > INTEGRATION_ANALYSIS_VISION_MAX_PNG_WORK_BYTES) {
      fail(
        "ANALYSIS_IMAGE_WORK_LIMIT",
        "The image set exceeds the bounded PNG decompression-work profile.",
        { status: 400 }
      );
    }
  }
  return Object.freeze({ pngWorkBytes });
}

export {
  fail as failIntegrationAnalysisVision,
  exact as exactIntegrationAnalysisVision,
  boundedInteger as boundedIntegrationAnalysisVisionInteger,
};
