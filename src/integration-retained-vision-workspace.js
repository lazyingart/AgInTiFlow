import crypto from "node:crypto";
import OpenAI from "openai";
import { types as utilTypes } from "node:util";
import { inflateSync } from "node:zlib";
import { authorityFail } from "./integration-durable-common.js";
import {
  assertIntegrationRetainedBinaryFilePrimitives,
  assertIntegrationRetainedRegularFileLock,
} from "./integration-storage-authority.js";
import { contractDigest, validateIntegrationRunId, validateIntegrationThreadId } from "./integration-policy.js";
import {
  assertRetainedIntegrationNativeExecutionEvidence,
} from "./integration-retained-native-execution-evidence.js";
import {
  assertRetainedIntegrationSessionStateStore,
} from "./integration-retained-session-state-store.js";
import {
  INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES,
  assertRetainedIntegrationTextWorkspace,
  assertRetainedIntegrationTextWorkspaceCurrent,
} from "./integration-retained-text-workspace.js";
import {
  assertRetainedIntegrationRuntimeRecoveryCoordinator,
  assertRetainedIntegrationRuntimeRepositorySurface,
} from "./integration-retained-runtime-repository-surface.js";
import {
  assertIntegrationRuntimeProcessOwnerBootstrap,
} from "./integration-runtime-process-owner-bootstrap.js";
import { normalizeProviderBaseURL, resolveProviderDefaults } from "./provider-contract.js";
import { probeProviderRuntime } from "./provider-runtime.js";
import { redactSensitiveText } from "./redaction.js";

export const INTEGRATION_VISION_WORKSPACE_PROFILE_ID = "vision-workspace-v1";
export const INTEGRATION_RETAINED_VISION_WORKSPACE_VERSION =
  "aginti-retained-vision-workspace-v1";
export const INTEGRATION_RETAINED_VISION_WORKSPACE_ATTESTATION_VERSION =
  "aginti-retained-vision-workspace-attestation-v1";
export const INTEGRATION_RETAINED_VISION_WORKSPACE_CURRENT_PROOF_VERSION =
  "aginti-retained-vision-workspace-current-proof-v1";
export const INTEGRATION_RETAINED_VISION_REFERENCE_VERSION =
  "aginti-retained-vision-reference-v1";
export const INTEGRATION_RETAINED_VISION_METADATA_VERSION =
  "aginti-retained-vision-metadata-v1";
export const INTEGRATION_RETAINED_VISION_REFERENCE_ID_DOMAIN =
  "aginti-retained-vision-reference-id-v1";
export const INTEGRATION_RETAINED_VISION_REFERENCE_ID_PREFIX = "vimg_";
export const INTEGRATION_RETAINED_VISION_METADATA_ID_DOMAIN =
  "aginti-retained-vision-metadata-id-v1";
export const INTEGRATION_RETAINED_VISION_METADATA_ID_PREFIX =
  "aginti-evidence-v1:vision-metadata:";
export const INTEGRATION_RETAINED_VISION_BLOB_FILE_DOMAIN =
  "aginti-retained-vision-blob-file-v1";
export const INTEGRATION_RETAINED_VISION_MODEL_ID = "localllm-vision";
export const INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const INTEGRATION_RETAINED_VISION_MAX_DIMENSION = 8192;
export const INTEGRATION_RETAINED_VISION_MAX_PIXELS = 20_000_000;
export const INTEGRATION_RETAINED_VISION_MAX_FRAMES = 1;
export const INTEGRATION_RETAINED_VISION_MAX_DECODED_BYTES = 64 * 1024 * 1024;
export const INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS = 12_000;
export const INTEGRATION_RETAINED_VISION_MIME_TYPES = Object.freeze([
  "image/png",
]);
export const INTEGRATION_VISION_WORKSPACE_TOOL_NAMES = Object.freeze([
  ...INTEGRATION_TEXT_WORKSPACE_TOOL_NAMES.slice(0, -1),
  "read_image",
  "finish",
]);

const ZERO_DIGEST = "0".repeat(64);
const MAX_PNG_CHUNKS = 4096;
const INPUT_ECHO_WINDOW_CHARS = 12;
const MIN_INPUT_ECHO_MATCHED_CHARS = 48;
const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted"
)?.get;
const profileBrand = new WeakMap();
const preflightBrand = new WeakMap();
const executionBrand = new WeakMap();
const uploadBrand = new WeakMap();
const RETAINED_VISION_METADATA_KEYS = Object.freeze([
  "schemaVersion",
  "profile",
  "referenceId",
  "storageNamespaceDigest",
  "blobStorageNamespaceDigest",
  "principalId",
  "browserSessionId",
  "threadId",
  "runId",
  "nativeSessionId",
  "mimeType",
  "sizeBytes",
  "width",
  "height",
  "pixelCount",
  "frameCount",
  "decodedBytes",
  "sha256",
  "revokedAt",
  "revocationDigest",
  "admissionDigest",
]);

function fail(code, message, status = 503) {
  authorityFail(code, message, { status });
}

function frozenRecord(value) {
  return Object.freeze(Object.assign(Object.create(null), value));
}

function exactPayload(input, required, optional, label) {
  if (
    !input || typeof input !== "object" || utilTypes.isProxy(input) || Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label} must be plain data.`, 400);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label} fields are invalid.`, 400);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label}.${key} must be a data field.`, 400);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value,
    });
  }
  return Object.freeze(result);
}

function assertDigest(value, label, allowZero = true) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) || (!allowZero && value === ZERO_DIGEST)) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertPublicText(value, label, maximum, minimum = 0, { trim = false } = {}) {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    redactSensitiveText(value) !== value || (trim && value.trim() !== value)
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label} is invalid.`, 400);
  }
  return value;
}

function assertCanonicalIso(value, label) {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", `${label} is invalid.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", `${label} is invalid.`);
  }
  return value;
}

function normalizeScope(input) {
  const value = exactPayload(
    input,
    ["mode", "principalId", "browserSessionId", "threadId", "runId", "nativeSessionId"],
    [],
    "vision-workspace scope"
  );
  const mode = value.mode === "start" ? "start" : value.mode === "resume" ? "resume" : "";
  if (!mode) fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Execution mode is invalid.", 400);
  if (typeof value.principalId !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value.principalId)) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Principal id is invalid.", 400);
  }
  assertDigest(value.browserSessionId, "browser session id");
  if (
    typeof value.nativeSessionId !== "string" ||
    !/^(?!aginti-evidence-v1:)[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value.nativeSessionId) ||
    value.nativeSessionId.includes("..")
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Native session id is invalid.", 400);
  }
  return frozenRecord({
    mode,
    principalId: value.principalId,
    browserSessionId: value.browserSessionId,
    threadId: validateIntegrationThreadId(value.threadId),
    runId: validateIntegrationRunId(value.runId),
    nativeSessionId: value.nativeSessionId,
  });
}

function scopeWithoutMode(scope) {
  return frozenRecord({
    principalId: scope.principalId,
    browserSessionId: scope.browserSessionId,
    threadId: scope.threadId,
    runId: scope.runId,
    nativeSessionId: scope.nativeSessionId,
  });
}

function sameScope(left, right) {
  return left.principalId === right.principalId &&
    left.browserSessionId === right.browserSessionId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.nativeSessionId === right.nativeSessionId;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertImageBounds(width, height, frameCount) {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 ||
    width > INTEGRATION_RETAINED_VISION_MAX_DIMENSION ||
    height > INTEGRATION_RETAINED_VISION_MAX_DIMENSION ||
    width * height > INTEGRATION_RETAINED_VISION_MAX_PIXELS ||
    frameCount !== 1 || frameCount > INTEGRATION_RETAINED_VISION_MAX_FRAMES
  ) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "Image dimensions, decoded pixels, or frame count exceed the retained vision bounds.", 400);
  }
}

function pngCrc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFacts(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG magic bytes are invalid.", 400);
  }
  let offset = 8;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let hasHeader = false;
  let hasImageData = false;
  let imageDataEnded = false;
  let hasPalette = false;
  let ended = false;
  let compressedBytes = 0;
  const imageData = [];
  const critical = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
  while (offset < bytes.length && chunks < MAX_PNG_CHUNKS) {
    if (offset + 12 > bytes.length) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG chunk is truncated.", 400);
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG chunk length is invalid.", 400);
    const type = bytes.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/u.test(type)) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG chunk type is invalid.", 400);
    if (type[2] !== type[2].toUpperCase()) {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG chunk reserved type bit is invalid.", 400);
    }
    if (pngCrc32(bytes, typeStart, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG chunk CRC is invalid.", 400);
    }
    if (chunks === 0 && type !== "IHDR") fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG IHDR must be first.", 400);
    if (type === "IHDR") {
      if (hasHeader || length !== 13) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG IHDR is invalid or duplicated.", 400);
      hasHeader = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const allowedDepths = colorType === 0
        ? [1, 2, 4, 8, 16]
        : colorType === 2 || colorType === 4 || colorType === 6
          ? [8, 16]
          : [];
      if (
        !allowedDepths.includes(bitDepth) || bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0
      ) {
        fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG IHDR fields are unsupported.", 400);
      }
      assertImageBounds(width, height, 1);
    } else if (!hasHeader) {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG data precedes IHDR.", 400);
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "Animated PNG inputs are not admitted.", 400);
    }
    if (type === "PLTE") {
      if (hasPalette || hasImageData || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) {
        fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG palette placement or size is invalid.", 400);
      }
      hasPalette = true;
    }
    if (type === "IDAT") {
      if (imageDataEnded || length === 0) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG IDAT ordering is invalid.", 400);
      hasImageData = true;
      compressedBytes += length;
      if (compressedBytes > INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES) {
        fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG compressed image data exceeds its bound.", 400);
      }
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (hasImageData && type !== "IEND") {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG terminator is invalid.", 400);
      ended = true;
      offset = end;
      chunks += 1;
      break;
    }
    if (!critical.has(type)) {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG ancillary chunks are not admitted by this exact profile.", 400);
    }
    offset = end;
    chunks += 1;
  }
  if (!ended || !hasHeader || !hasImageData || offset !== bytes.length || chunks >= MAX_PNG_CHUNKS) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG structure is incomplete or exceeds its chunk bound.", 400);
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedDecodedBytes = height * (rowBytes + 1);
  if (
    !Number.isSafeInteger(expectedDecodedBytes) || expectedDecodedBytes < 1 ||
    expectedDecodedBytes > INTEGRATION_RETAINED_VISION_MAX_DECODED_BYTES
  ) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG decoded byte size exceeds its bound.", 400);
  }
  let decoded;
  let consumed = 0;
  try {
    const inflated = inflateSync(Buffer.concat(imageData, compressedBytes), {
      maxOutputLength: expectedDecodedBytes,
      info: true,
    });
    decoded = inflated.buffer;
    consumed = Number(inflated.engine?.bytesWritten || 0);
  } catch {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG compressed image data does not decode safely.", 400);
  }
  if (decoded.length !== expectedDecodedBytes || consumed !== compressedBytes) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG decoded image length or compressed stream boundary is invalid.", 400);
  }
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) {
      fail("INTEGRATION_VISION_IMAGE_INVALID", "PNG scanline filter is invalid.", 400);
    }
  }
  return frozenRecord({
    mimeType: "image/png",
    width,
    height,
    pixelCount: width * height,
    frameCount: 1,
    decodedBytes: expectedDecodedBytes,
  });
}

function validateImageBytes(bytesInput, mimeTypeInput) {
  if (utilTypes.isProxy(bytesInput) || !Buffer.isBuffer(bytesInput)) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "Image upload bytes must be an exact Buffer.", 400);
  }
  if (bytesInput.length < 16 || bytesInput.length > INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "Image upload exceeds the retained byte bound or is empty.", 400);
  }
  if (!INTEGRATION_RETAINED_VISION_MIME_TYPES.includes(mimeTypeInput)) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "Image MIME type is not admitted by this profile.", 400);
  }
  const bytes = Buffer.from(bytesInput);
  const facts = pngFacts(bytes);
  if (facts.mimeType !== mimeTypeInput) {
    fail("INTEGRATION_VISION_IMAGE_INVALID", "Image magic bytes do not match the declared MIME type.", 400);
  }
  return frozenRecord({ bytes, ...facts, sizeBytes: bytes.length, sha256: sha256(bytes) });
}

function referenceIdFor(scope, image, storageNamespaceDigest, blobStorageNamespaceDigest) {
  const digest = contractDigest({
    domain: INTEGRATION_RETAINED_VISION_REFERENCE_ID_DOMAIN,
    profile: INTEGRATION_VISION_WORKSPACE_PROFILE_ID,
    storageNamespaceDigest,
    blobStorageNamespaceDigest,
    ...scopeWithoutMode(scope),
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    frameCount: image.frameCount,
    sha256: image.sha256,
  });
  return `${INTEGRATION_RETAINED_VISION_REFERENCE_ID_PREFIX}${digest}`;
}

function assertReferenceId(value) {
  if (typeof value !== "string" || !/^vimg_[a-f0-9]{64}$/u.test(value)) {
    fail("INTEGRATION_VISION_REFERENCE_INVALID", "Retained image reference id is invalid.", 400);
  }
  return value;
}

function metadataSessionId(referenceId, storageNamespaceDigest) {
  return `${INTEGRATION_RETAINED_VISION_METADATA_ID_PREFIX}${contractDigest({
    domain: INTEGRATION_RETAINED_VISION_METADATA_ID_DOMAIN,
    storageNamespaceDigest,
    referenceId,
  })}`;
}

function blobFileName(referenceId, blobStorageNamespaceDigest) {
  return `vision-blob-${contractDigest({
    domain: INTEGRATION_RETAINED_VISION_BLOB_FILE_DOMAIN,
    blobStorageNamespaceDigest,
    referenceId,
  })}.bin`;
}

function publicReference(metadata) {
  return frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_VISION_REFERENCE_VERSION,
    referenceId: metadata.referenceId,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    width: metadata.width,
    height: metadata.height,
    pixelCount: metadata.pixelCount,
    frameCount: metadata.frameCount,
    decodedBytes: metadata.decodedBytes,
    sha256: metadata.sha256,
    admissionDigest: metadata.admissionDigest,
  });
}

function metadataAdmissionInput(metadata) {
  return frozenRecord({
    schemaVersion: metadata.schemaVersion,
    profile: metadata.profile,
    referenceId: metadata.referenceId,
    storageNamespaceDigest: metadata.storageNamespaceDigest,
    blobStorageNamespaceDigest: metadata.blobStorageNamespaceDigest,
    principalId: metadata.principalId,
    browserSessionId: metadata.browserSessionId,
    threadId: metadata.threadId,
    runId: metadata.runId,
    nativeSessionId: metadata.nativeSessionId,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    width: metadata.width,
    height: metadata.height,
    pixelCount: metadata.pixelCount,
    frameCount: metadata.frameCount,
    decodedBytes: metadata.decodedBytes,
    sha256: metadata.sha256,
  });
}

function metadataReferenceIdentityInput(metadata) {
  return metadataAdmissionInput(metadata);
}

function metadataFor(scope, image, lane) {
  const referenceId = referenceIdFor(
    scope,
    image,
    lane.metadataStore.attestation.logicalNamespaceDigest,
    lane.blobStorageNamespaceDigest
  );
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_VISION_METADATA_VERSION,
    profile: INTEGRATION_VISION_WORKSPACE_PROFILE_ID,
    referenceId,
    storageNamespaceDigest: lane.metadataStore.attestation.logicalNamespaceDigest,
    blobStorageNamespaceDigest: lane.blobStorageNamespaceDigest,
    ...scopeWithoutMode(scope),
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    pixelCount: image.pixelCount,
    frameCount: image.frameCount,
    decodedBytes: image.decodedBytes,
    sha256: image.sha256,
    revokedAt: null,
    revocationDigest: ZERO_DIGEST,
    admissionDigest: ZERO_DIGEST,
  });
  const admissionDigest = contractDigest(metadataAdmissionInput(unsigned));
  return frozenRecord({ ...unsigned, admissionDigest });
}

function metadataState(metadata, sessionId) {
  return frozenRecord({
    sessionId,
    meta: frozenRecord({
      runtimeConfig: frozenRecord({ revision: 1 }),
      integrationRetainedVisionMetadata: metadata,
    }),
  });
}

function exactRetainedMetadata(input) {
  if (
    !input || typeof input !== "object" || utilTypes.isProxy(input) || Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata is not exact plain data.");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== RETAINED_VISION_METADATA_KEYS.length ||
    keys.some((key) => typeof key !== "string" || !RETAINED_VISION_METADATA_KEYS.includes(key)) ||
    RETAINED_VISION_METADATA_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata keys are invalid.");
  }
  const metadata = Object.create(null);
  for (const key of RETAINED_VISION_METADATA_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      !descriptor || descriptor.enumerable !== true || descriptor.configurable !== false ||
      descriptor.writable !== false || !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", `Retained image metadata field ${key} is not immutable data.`);
    }
    Object.defineProperty(metadata, key, descriptor);
  }
  return Object.freeze(metadata);
}

function validateMetadata(snapshot, expectedReferenceId, lane) {
  if (!snapshot || typeof snapshot !== "object") {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata snapshot is unavailable.");
  }
  const expectedSessionId = metadataSessionId(
    expectedReferenceId,
    lane.metadataStore.attestation.logicalNamespaceDigest
  );
  if (snapshot.nativeSessionId !== expectedSessionId) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata identity changed.");
  }
  if (snapshot.persistenceRevision === 0) return null;
  const metadata = exactRetainedMetadata(snapshot.state?.meta?.integrationRetainedVisionMetadata);
  if (
    !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
    metadata.schemaVersion !== INTEGRATION_RETAINED_VISION_METADATA_VERSION ||
    metadata.profile !== INTEGRATION_VISION_WORKSPACE_PROFILE_ID ||
    metadata.referenceId !== expectedReferenceId ||
    metadata.storageNamespaceDigest !== lane.metadataStore.attestation.logicalNamespaceDigest ||
    metadata.blobStorageNamespaceDigest !== lane.blobStorageNamespaceDigest ||
    !INTEGRATION_RETAINED_VISION_MIME_TYPES.includes(metadata.mimeType) ||
    !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 16 ||
    metadata.sizeBytes > INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES ||
    !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
    !Number.isSafeInteger(metadata.pixelCount) ||
    metadata.pixelCount !== metadata.width * metadata.height ||
    !Number.isSafeInteger(metadata.decodedBytes) || metadata.decodedBytes < 1 ||
    metadata.decodedBytes > INTEGRATION_RETAINED_VISION_MAX_DECODED_BYTES ||
    metadata.frameCount !== 1 ||
    metadata.revokedAt !== null && typeof metadata.revokedAt !== "string" ||
    snapshot.state?.meta?.runtimeConfig?.revision !== 1
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata fields are invalid.");
  }
  try {
    normalizeScope(frozenRecord({
      mode: "start",
      principalId: metadata.principalId,
      browserSessionId: metadata.browserSessionId,
      threadId: metadata.threadId,
      runId: metadata.runId,
      nativeSessionId: metadata.nativeSessionId,
    }));
  } catch {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image ownership fields are invalid.");
  }
  assertImageBounds(metadata.width, metadata.height, metadata.frameCount);
  assertDigest(metadata.sha256, "retained image digest", false);
  assertDigest(metadata.admissionDigest, "retained image admission digest", false);
  assertDigest(metadata.revocationDigest, "retained image revocation digest");
  if (metadata.revokedAt !== null) assertCanonicalIso(metadata.revokedAt, "retained image revocation time");
  if (
    metadata.admissionDigest !== contractDigest(metadataAdmissionInput(metadata)) ||
    (metadata.revokedAt === null) !== (metadata.revocationDigest === ZERO_DIGEST) ||
    referenceIdFor(
      frozenRecord({ mode: "start", ...scopeWithoutMode(metadata) }),
      metadata,
      metadata.storageNamespaceDigest,
      metadata.blobStorageNamespaceDigest
    ) !==
      metadata.referenceId
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata integrity is invalid.");
  }
  if (metadata.revokedAt !== null) {
    const expectedRevocation = contractDigest({
      domain: "aginti-retained-vision-revocation-v1",
      admissionDigest: metadata.admissionDigest,
      revokedAt: metadata.revokedAt,
    });
    if (metadata.revocationDigest !== expectedRevocation) {
      fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image revocation evidence is invalid.");
    }
  }
  return metadata;
}

function sameReferenceIdentity(left, right) {
  return contractDigest(metadataReferenceIdentityInput(left)) ===
    contractDigest(metadataReferenceIdentityInput(right));
}

function exactAdmissionMatches(left, right) {
  return sameReferenceIdentity(left, right) &&
    left.admissionDigest === right.admissionDigest;
}

async function readAndVerifyBlob(lane, metadata) {
  return lane.binaryLock.runExclusive(async () => {
    const fileName = blobFileName(metadata.referenceId, lane.blobStorageNamespaceDigest);
    const read = await lane.binaryFiles.readProtectedBinaryFile(fileName, {
      optional: true,
      maxBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    });
    if (!read || read.size !== metadata.sizeBytes) {
      fail("INTEGRATION_VISION_BLOB_UNAVAILABLE", "Retained image blob is missing or has the wrong byte size.");
    }
    const bytes = Buffer.from(read.bytes);
    if (sha256(bytes) !== metadata.sha256) {
      fail("INTEGRATION_VISION_BLOB_CORRUPT", "Retained image blob digest changed.");
    }
    const facts = validateImageBytes(bytes, metadata.mimeType);
    if (
      facts.width !== metadata.width || facts.height !== metadata.height ||
      facts.pixelCount !== metadata.pixelCount || facts.frameCount !== metadata.frameCount ||
      facts.decodedBytes !== metadata.decodedBytes ||
      facts.sha256 !== metadata.sha256
    ) {
      fail("INTEGRATION_VISION_BLOB_CORRUPT", "Retained image blob facts changed.");
    }
    return bytes;
  }, { waitMs: 60_000 });
}

async function ensureStagedBlob(lane, metadata, bytes) {
  return lane.binaryLock.runExclusive(async () => {
    const fileName = blobFileName(metadata.referenceId, lane.blobStorageNamespaceDigest);
    const existing = await lane.binaryFiles.readProtectedBinaryFile(fileName, {
      optional: true,
      maxBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    });
    if (existing) {
      const current = Buffer.from(existing.bytes);
      if (current.length !== metadata.sizeBytes || sha256(current) !== metadata.sha256) {
        fail("INTEGRATION_VISION_BLOB_CORRUPT", "Content-addressed retained image destination conflicts.");
      }
      await lane.binaryFiles.syncProtectedBinaryDirectory();
      const durable = await lane.binaryFiles.readProtectedBinaryFile(fileName, {
        optional: false,
        maxBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
      });
      const durableBytes = Buffer.from(durable.bytes);
      if (durableBytes.length !== metadata.sizeBytes || sha256(durableBytes) !== metadata.sha256) {
        fail("INTEGRATION_VISION_BLOB_CORRUPT", "Retained image destination changed across directory sync.");
      }
      return frozenRecord({ outcome: "already-staged", digest: metadata.sha256 });
    }
    let result;
    try {
      result = await lane.binaryFiles.atomicWriteProtectedBinaryFile(fileName, bytes, {
        maxBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
      });
    } catch (error) {
      if ((error?.publicCode || error?.code) !== "INTEGRATION_STORAGE_COMMIT_AMBIGUOUS") throw error;
      if (error?.details?.directorySynced !== true) {
        await lane.binaryFiles.syncProtectedBinaryDirectory();
      }
      result = frozenRecord({
        bytes: metadata.sizeBytes,
        digest: metadata.sha256,
        directorySynced: true,
      });
    }
    const committed = await lane.binaryFiles.readProtectedBinaryFile(fileName, {
      optional: false,
      maxBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    });
    const reopened = Buffer.from(committed.bytes);
    if (
      reopened.length !== metadata.sizeBytes || sha256(reopened) !== metadata.sha256 ||
      (result && (result.bytes !== metadata.sizeBytes || result.digest !== metadata.sha256))
    ) {
      fail("INTEGRATION_VISION_BLOB_CORRUPT", "Retained image blob publication could not be verified.");
    }
    return frozenRecord({ outcome: result ? "staged" : "reconciled", digest: metadata.sha256 });
  }, { waitMs: 60_000 });
}

async function publishMetadata(lane, metadata) {
  const sessionId = metadataSessionId(metadata.referenceId, lane.metadataStore.attestation.logicalNamespaceDigest);
  const current = await lane.metadataStore.loadSessionSnapshot(sessionId);
  const existing = validateMetadata(current, metadata.referenceId, lane);
  if (existing) {
    if (!sameReferenceIdentity(existing, metadata)) {
      fail("INTEGRATION_VISION_REFERENCE_CONFLICT", "Retained image reference metadata conflicts.", 409);
    }
    if (existing.revokedAt !== null) {
      fail("INTEGRATION_VISION_REFERENCE_REVOKED", "Retained image reference was revoked.", 410);
    }
    await readAndVerifyBlob(lane, existing);
    return frozenRecord({ outcome: "replayed", reference: publicReference(existing) });
  }
  let committed;
  try {
    committed = await lane.metadataStore.compareAndSwapSessionSnapshot({
      mutationId: `vision-stage.${metadata.referenceId.slice(5)}`,
      nativeSessionId: sessionId,
      expectedPersistenceRevision: current.persistenceRevision,
      expectedIntegrityDigest: current.integrityDigest,
      state: metadataState(metadata, sessionId),
    });
  } catch (error) {
    if ((error?.publicCode || error?.code) !== "INTEGRATION_SESSION_STATE_STORE_CONFLICT") throw error;
    const raced = await lane.metadataStore.loadSessionSnapshot(sessionId);
    const racedMetadata = validateMetadata(raced, metadata.referenceId, lane);
    if (!racedMetadata || !exactAdmissionMatches(racedMetadata, metadata) || racedMetadata.revokedAt !== null) {
      throw error;
    }
    await readAndVerifyBlob(lane, racedMetadata);
    return frozenRecord({ outcome: "replayed", reference: publicReference(racedMetadata) });
  }
  const published = validateMetadata(committed.snapshot, metadata.referenceId, lane);
  if (!published || !exactAdmissionMatches(published, metadata) || published.revokedAt !== null) {
    fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image metadata publication result is invalid.");
  }
  await readAndVerifyBlob(lane, published);
  return frozenRecord({ outcome: committed.outcome, reference: publicReference(published) });
}

async function resolveMetadataForScope(lane, scope, referenceId, { allowRevoked = false } = {}) {
  const sessionId = metadataSessionId(referenceId, lane.metadataStore.attestation.logicalNamespaceDigest);
  const snapshot = await lane.metadataStore.loadSessionSnapshot(sessionId);
  const metadata = validateMetadata(snapshot, referenceId, lane);
  if (!metadata) fail("INTEGRATION_VISION_REFERENCE_UNAVAILABLE", "Retained image reference is unavailable.", 404);
  if (!sameScope(metadata, scope)) {
    fail("INTEGRATION_VISION_REFERENCE_FORBIDDEN", "Retained image reference ownership does not match this run.", 403);
  }
  if (!allowRevoked && metadata.revokedAt !== null) {
    fail("INTEGRATION_VISION_REFERENCE_REVOKED", "Retained image reference was revoked.", 410);
  }
  return frozenRecord({ metadata, snapshot });
}

function compactModelText(value, limit = INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS) {
  let text = redactSensitiveText(String(value || ""))
    .replace(/data:image\/[a-z0-9.+-]+;base64,(?:[a-z0-9+/=]|[\t\n\r\f\v ])+/giu, "[REDACTED_IMAGE_DATA]")
    .replace(/\b(?:https?|file):\/\/[^\s]+/giu, "[REDACTED_URL]")
    .replace(/\/(?:home|root|workspace|run|proc|sys|dev|etc|var|tmp)\/[^\s]*/gu, "[REDACTED_PATH]")
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/gu, "[REDACTED_ENCODED_DATA]")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit - 12).trimEnd()} [truncated]`;
  return text;
}

function withoutAsciiWhitespace(value) {
  return value.replace(/[\t\n\r\f\v ]+/gu, "");
}

function encodedCandidateContainsInput(candidate, exactBase64) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const normalized = candidate.normalize("NFKC");
  const compact = withoutAsciiWhitespace(normalized);
  const base64AlphabetOnly = normalized.replace(/[^A-Za-z0-9+/=]/gu, "");
  const variants = [compact, base64AlphabetOnly];
  if (/data:image\/png;base64,/iu.test(compact)) return true;
  for (const variant of variants) {
    if (variant.includes(exactBase64)) return true;
  }
  const candidateWindows = new Set();
  for (const variant of variants) {
    for (let offset = 0; offset <= variant.length - INPUT_ECHO_WINDOW_CHARS; offset += 1) {
      const window = variant.slice(offset, offset + INPUT_ECHO_WINDOW_CHARS);
      if (/^[A-Za-z0-9+/=]{12}$/u.test(window)) candidateWindows.add(window);
    }
  }
  const covered = new Uint8Array(exactBase64.length);
  for (let offset = 0; offset <= exactBase64.length - INPUT_ECHO_WINDOW_CHARS; offset += 1) {
    if (!candidateWindows.has(exactBase64.slice(offset, offset + INPUT_ECHO_WINDOW_CHARS))) continue;
    covered.fill(1, offset, offset + INPUT_ECHO_WINDOW_CHARS);
  }
  let matched = 0;
  for (let index = 0; index < covered.length; index += 1) matched += covered[index];
  if (matched >= Math.min(MIN_INPUT_ECHO_MATCHED_CHARS, exactBase64.length)) {
    return true;
  }
  return false;
}

function parsedStringValues(value, output, depth = 0) {
  if (depth > 32 || output.length > 4096) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      parsedStringValues(value[index], output, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return;
  for (const key of Object.keys(value)) parsedStringValues(value[key], output, depth + 1);
}

function assertNoInputImageEcho(rawText, exactBase64) {
  if (typeof rawText !== "string") return;
  if (rawText.length > INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS * 4) {
    fail("INTEGRATION_VISION_OUTPUT_REJECTED", "The local vision response exceeded its safe input bound.", 502);
  }
  let parsedValues = [];
  try {
    const parsed = JSON.parse(rawText);
    parsedStringValues(parsed, parsedValues);
  } catch {
    parsedValues = [];
  }
  const joinedParsedValues = parsedValues.join("");
  if (
    encodedCandidateContainsInput(rawText, exactBase64) ||
    encodedCandidateContainsInput(joinedParsedValues, exactBase64)
  ) {
    fail(
      "INTEGRATION_VISION_OUTPUT_REJECTED",
      "The local vision response contained forbidden retained image data.",
      502
    );
  }
}

export function redactIntegrationRetainedVisionTextForPersistence(value) {
  return typeof value === "string" ? compactModelText(value) : "";
}

function modelResponseText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : String(part?.text || "")).join("\n");
}

function stringList(value, maximumItems = 64) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.slice(0, maximumItems).map((item) => compactModelText(item, 1000)).filter(Boolean));
}

function boundedNormalizedVisionResult(fields) {
  const result = frozenRecord(fields);
  if (JSON.stringify(result).length <= INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS) return result;
  const compacted = frozenRecord({
    summary: compactModelText(result.summary, 2_500),
    visibleText: Object.freeze([]),
    observations: Object.freeze([]),
    issues: Object.freeze([]),
    answer: compactModelText(result.answer, 5_500),
    uncertainty: Object.freeze(["The local vision response exceeded the retained output bound and was compacted."]),
  });
  if (JSON.stringify(compacted).length <= INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS) return compacted;
  return frozenRecord({
    summary: compactModelText(result.summary, 1_000),
    visibleText: Object.freeze([]),
    observations: Object.freeze([]),
    issues: Object.freeze([]),
    answer: compactModelText(result.answer, 2_000),
    uncertainty: Object.freeze(["The local vision response was compacted."]),
  });
}

function normalizedVisionResult(rawText) {
  const safeRaw = compactModelText(rawText);
  let parsed = null;
  try {
    parsed = JSON.parse(safeRaw);
  } catch {
    const first = safeRaw.indexOf("{");
    const last = safeRaw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(safeRaw.slice(first, last + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || utilTypes.isProxy(parsed)) {
    const summary = compactModelText(safeRaw, 4000);
    const answer = compactModelText(safeRaw, 6000);
    return boundedNormalizedVisionResult({
      summary,
      visibleText: Object.freeze([]),
      observations: Object.freeze([]),
      issues: Object.freeze([]),
      answer,
      uncertainty: Object.freeze(["The local vision response was not strict JSON."]),
    });
  }
  return boundedNormalizedVisionResult({
    summary: compactModelText(parsed.summary, 4000),
    visibleText: stringList(parsed.visibleText),
    observations: stringList(parsed.observations),
    issues: stringList(parsed.issues),
    answer: compactModelText(parsed.answer || parsed.summary, 6000),
    uncertainty: stringList(parsed.uncertainty || parsed.uncertainties),
  });
}

function exactReadImageArgs(input) {
  const args = exactPayload(input, ["referenceId"], ["detail"], "retained read_image arguments");
  const referenceId = assertReferenceId(args.referenceId);
  const detail = args.detail === undefined ? "auto" : args.detail;
  if (!new Set(["low", "high", "auto"]).has(detail)) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "read_image detail is invalid.", 400);
  }
  return frozenRecord({ referenceId, detail });
}

export function canonicalizeIntegrationRetainedVisionReadImageArguments(input) {
  return exactReadImageArgs(input);
}

function exactInferenceRuntime(input) {
  const runtime = exactPayload(
    input,
    ["abortSignal"],
    ["providerReadinessTimeoutMs", "modelTimeoutMs"],
    "retained vision inference runtime"
  );
  if (
    !runtime.abortSignal || typeof runtime.abortSignal !== "object" ||
    utilTypes.isProxy(runtime.abortSignal) ||
    Object.getPrototypeOf(runtime.abortSignal) !== AbortSignal.prototype ||
    Reflect.ownKeys(runtime.abortSignal).some((key) => typeof key === "string")
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Retained vision inference requires an AbortSignal.", 400);
  }
  try {
    if (typeof nativeAbortSignalAbortedGetter !== "function") throw new TypeError("missing native getter");
    Reflect.apply(nativeAbortSignalAbortedGetter, runtime.abortSignal, []);
  } catch {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Retained vision inference requires an AbortSignal.", 400);
  }
  for (const field of ["providerReadinessTimeoutMs", "modelTimeoutMs"]) {
    if (
      runtime[field] !== undefined &&
      (!Number.isSafeInteger(runtime[field]) || runtime[field] < 1 || runtime[field] > 300_000)
    ) {
      fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${field} must be a positive bounded integer.`, 400);
    }
  }
  return runtime;
}

function throwIfAborted(signal) {
  let aborted;
  try {
    aborted = Reflect.apply(nativeAbortSignalAbortedGetter, signal, []);
  } catch {
    fail("INTEGRATION_VISION_WORKSPACE_INVALID", "Retained vision inference requires an AbortSignal.", 400);
  }
  if (!aborted) return;
  const error = new Error("Retained vision inference was cancelled.");
  error.code = "CANCELLED";
  error.publicCode = "CANCELLED";
  error.status = 499;
  throw error;
}

function throwFixedInferenceFailure(signal, stage) {
  throwIfAborted(signal);
  fail(
    "INTEGRATION_VISION_MODEL_UNAVAILABLE",
    stage === "readiness"
      ? "The exact loopback LocalLLM vision route is unavailable."
      : "The exact loopback LocalLLM vision request failed."
  );
}

function visionPrompt(reference) {
  return [
    "Inspect the supplied retained image and return strict JSON only.",
    "Schema: {summary:string, visibleText:string[], observations:string[], issues:string[], answer:string, uncertainty:string[]}.",
    "Describe only visible evidence. Do not infer private identity, diagnosis, or facts not visible. State uncertainty explicitly.",
    `Opaque retained reference: ${reference.referenceId}`,
    `Validated type: ${reference.mimeType}; dimensions: ${reference.width}x${reference.height}; sha256: ${reference.sha256}.`,
    "Return a neutral inventory of visible text, objects, layout, anomalies, and uncertainty for the calling agent to apply to the retained user request.",
  ].join("\n");
}

async function invokePinnedLocalVision(lane, active, argsInput, runtimeInput) {
  const args = exactReadImageArgs(argsInput);
  const runtime = exactInferenceRuntime(runtimeInput);
  throwIfAborted(runtime.abortSignal);
  await resolveMetadataForScope(lane, active.scope, args.referenceId);
  let readiness;
  try {
    readiness = await probeProviderRuntime({
      provider: "localllm",
      baseURL: lane.connection.baseURL,
      apiKey: lane.connection.apiKey,
      selectedModel: INTEGRATION_RETAINED_VISION_MODEL_ID,
      timeoutMs: runtime.providerReadinessTimeoutMs,
      signal: runtime.abortSignal,
    });
  } catch {
    throwFixedInferenceFailure(runtime.abortSignal, "readiness");
  }
  if (
    readiness?.ok !== true || readiness?.provider !== "localllm" ||
    !readiness?.checks?.models?.available?.includes(INTEGRATION_RETAINED_VISION_MODEL_ID)
  ) {
    fail("INTEGRATION_VISION_MODEL_UNAVAILABLE", "Exact LocalLLM vision route readiness was not proven.");
  }
  throwIfAborted(runtime.abortSignal);
  const current = await resolveMetadataForScope(lane, active.scope, args.referenceId);
  const bytes = await readAndVerifyBlob(lane, current.metadata);
  const postRead = await resolveMetadataForScope(lane, active.scope, args.referenceId);
  if (
    postRead.snapshot.persistenceRevision !== current.snapshot.persistenceRevision ||
    postRead.snapshot.integrityDigest !== current.snapshot.integrityDigest
  ) {
    fail("INTEGRATION_VISION_REFERENCE_CONFLICT", "Retained image reference changed before inference.", 409);
  }
  throwIfAborted(runtime.abortSignal);
  const client = new OpenAI({
    apiKey: lane.connection.apiKey,
    baseURL: lane.connection.baseURL,
    maxRetries: 0,
  });
  const reference = publicReference(current.metadata);
  const encodedImage = bytes.toString("base64");
  let response;
  try {
    response = await client.chat.completions.create(
      {
        model: INTEGRATION_RETAINED_VISION_MODEL_ID,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: visionPrompt(reference) },
            {
              type: "image_url",
              image_url: {
                url: `data:${reference.mimeType};base64,${encodedImage}`,
                detail: args.detail,
              },
            },
          ],
        }],
        response_format: { type: "json_object" },
        max_tokens: 1800,
      },
      {
        timeout: runtime.modelTimeoutMs || 180_000,
        signal: runtime.abortSignal,
      }
    );
  } catch {
    throwFixedInferenceFailure(runtime.abortSignal, "request");
  }
  throwIfAborted(runtime.abortSignal);
  const rawModelText = modelResponseText(response);
  assertNoInputImageEcho(rawModelText, encodedImage);
  const result = normalizedVisionResult(rawModelText);
  return frozenRecord({
    ok: true,
    toolName: "read_image",
    provider: "localllm",
    model: INTEGRATION_RETAINED_VISION_MODEL_ID,
    modelRouteIdentityDigest: lane.modelRouteIdentityDigest,
    reference,
    detail: args.detail,
    result,
  });
}

function sameDirectoryBinding(left, right) {
  return left.role === right.role &&
    left.canonicalPath === right.canonicalPath &&
    left.rootIdentityDigest === right.rootIdentityDigest &&
    left.directoryIdentityDigest === right.directoryIdentityDigest &&
    contractDigest(left.relativeSegments) === contractDigest(right.relativeSegments);
}

function storageBindingFields(input, keys, label) {
  const raw = exactPayload(input, keys, [], label);
  const result = Object.create(null);
  for (const key of keys) {
    let value = raw[key];
    if (key === "relativeSegments") {
      if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label}.relativeSegments must be an exact array.`, 400);
      }
      const segments = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || typeof descriptor.value !== "string") {
          fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label}.relativeSegments is invalid.`, 400);
        }
        segments[index] = descriptor.value;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((item) => item !== "length" && (typeof item !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(item)))
      ) {
        fail("INTEGRATION_VISION_WORKSPACE_INVALID", `${label}.relativeSegments fields are invalid.`, 400);
      }
      value = Object.freeze(segments);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return Object.freeze(result);
}

function buildAttestation(state) {
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_VISION_WORKSPACE_ATTESTATION_VERSION,
    owner: "aginti",
    authority: "aginti",
    profile: INTEGRATION_VISION_WORKSPACE_PROFILE_ID,
    extendsProfile: "text-workspace-v1",
    runtimeCapabilityEnabled: false,
    publicServerCapabilityEnabled: false,
    nativeSessionStateWriterFencing: false,
    nativeSessionStateWriterQuiescenceProven: false,
    crossProcessImageWriterFencing: false,
    crossProcessInferenceRevocationFence: false,
    repositoryFenceCurrentRevalidationEachAdmission: true,
    retainedTypedBlobReferences: true,
    descriptorBoundBinaryBlobStorage: true,
    blobPublicationOrder: "hidden-binary-fsync-verify-then-single-metadata-cas",
    metadataWithoutExactBlobFailsClosed: true,
    durableRevocationTombstones: true,
    revocationRecheckedImmediatelyBeforeInference: true,
    referenceOwnershipFields: Object.freeze([
      "principalId",
      "browserSessionId",
      "threadId",
      "runId",
      "nativeSessionId",
    ]),
    publicReferenceContainsOwnerFields: false,
    publicReferenceContainsBase64: false,
    publicReferenceContainsLocalPath: false,
    repositoryStateContainsImageBytes: false,
    toolArgumentsRetainedReferencesOnly: true,
    hostedVisionFallback: false,
    callerModelOverride: false,
    callerProviderOverride: false,
    providerRequestRetries: 0,
    transientLoopbackDataUrlTransport: true,
    transientTransportRetained: false,
    localVisionProvider: "localllm",
    localVisionModel: INTEGRATION_RETAINED_VISION_MODEL_ID,
    localVisionAliasTargetAttested: false,
    localVisionBaseURL: state.connection.baseURL,
    localVisionRouteIdentityDigest: state.modelRouteIdentityDigest,
    supportedMimeTypes: INTEGRATION_RETAINED_VISION_MIME_TYPES,
    pngFullInflateValidation: true,
    pngChunkCrcValidation: true,
    pngInterlaceAllowed: false,
    animatedImagesAllowed: false,
    maxUploadBytes: INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    maxDimension: INTEGRATION_RETAINED_VISION_MAX_DIMENSION,
    maxPixels: INTEGRATION_RETAINED_VISION_MAX_PIXELS,
    maxFrames: INTEGRATION_RETAINED_VISION_MAX_FRAMES,
    maxDecodedBytes: INTEGRATION_RETAINED_VISION_MAX_DECODED_BYTES,
    callerVisionPromptArgument: false,
    lexicalVisionPrompt: true,
    maxOutputChars: INTEGRATION_RETAINED_VISION_MAX_OUTPUT_CHARS,
    normalizedResultJsonBounded: true,
    exactInputImageEchoRejectedBeforePersistence: true,
    inputEchoWindowChars: INPUT_ECHO_WINDOW_CHARS,
    minimumCumulativeInputEchoMatchedChars: MIN_INPUT_ECHO_MATCHED_CHARS,
    completeBoundedInputEchoResponseWindowIndex: true,
    binaryPrimitiveReadPeakCopies: 2,
    binaryPrimitiveReadPeakBytes: 2 * INTEGRATION_RETAINED_VISION_MAX_UPLOAD_BYTES,
    aggregateBlobQuota: false,
    orphanBlobCollection: false,
    blobPruning: false,
    revokedBlobPhysicalDelete: false,
    diskExhaustionFailsClosed: true,
    referenceRetention: "durable-until-revoked-no-prune",
    referenceIdDomain: INTEGRATION_RETAINED_VISION_REFERENCE_ID_DOMAIN,
    referenceIdPrefix: INTEGRATION_RETAINED_VISION_REFERENCE_ID_PREFIX,
    metadataIdDomain: INTEGRATION_RETAINED_VISION_METADATA_ID_DOMAIN,
    metadataIdPrefix: INTEGRATION_RETAINED_VISION_METADATA_ID_PREFIX,
    blobFileDomain: INTEGRATION_RETAINED_VISION_BLOB_FILE_DOMAIN,
    enabledToolNames: INTEGRATION_VISION_WORKSPACE_TOOL_NAMES,
    enabledToolDigest: contractDigest(INTEGRATION_VISION_WORKSPACE_TOOL_NAMES),
    textWorkspaceAttestationDigest: state.textWorkspace.attestation.digest,
    constructionTextWorkspaceCurrentProofDigest: state.constructionTextCurrentProof.digest,
    nativeSessionStorageNamespaceDigest: state.sessionStore.attestation.logicalNamespaceDigest,
    nativeSessionStorageAdmissionBindingDigest: state.sessionStore.attestation.admissionBindingDigest,
    metadataStorageNamespaceDigest: state.metadataStore.attestation.logicalNamespaceDigest,
    metadataStorageAdmissionBindingDigest: state.metadataStore.attestation.admissionBindingDigest,
    blobStorageNamespaceDigest: state.blobStorageNamespaceDigest,
    binaryFileAttestationDigest: state.binaryFiles.attestation.digest,
    binaryLockAttestationDigest: state.binaryLock.attestation.digest,
    nativeExecutionEvidenceDigest: state.evidence.attestation.digest,
    repositoryAttestationDigest: state.repository.integrationRuntimeRepositoryAttestation.digest,
    recoveryCoordinatorAttestationDigest: state.recovery.attestation.digest,
    processOwnerBootstrapDigest: state.bootstrap.digest,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

export async function createRetainedIntegrationVisionWorkspace(input = {}) {
  const options = exactPayload(
    input,
    [
      "textWorkspace",
      "sessionStateStore",
      "sessionStateStoreExpected",
      "metadataStore",
      "metadataStoreExpected",
      "binaryFilePrimitives",
      "binaryFilePrimitivesExpected",
      "binaryFileLock",
      "binaryFileLockExpected",
      "nativeExecutionEvidence",
      "repository",
      "recoveryCoordinator",
      "processOwnerBootstrap",
      "repositoryFenceLease",
    ],
    [],
    "retained vision-workspace factory"
  );
  const sessionExpected = storageBindingFields(
    options.sessionStateStoreExpected,
    [
      "role", "canonicalPath", "rootIdentityDigest", "relativeSegments", "directoryIdentityDigest",
      "lockFileIdentityDigest", "helperSha256", "helperIdentityDigest", "maxStateBytes", "lockWaitMs",
    ],
    "retained vision session store expected binding"
  );
  const metadataExpected = storageBindingFields(
    options.metadataStoreExpected,
    [
      "role", "canonicalPath", "rootIdentityDigest", "relativeSegments", "directoryIdentityDigest",
      "lockFileIdentityDigest", "helperSha256", "helperIdentityDigest", "maxStateBytes", "lockWaitMs",
    ],
    "retained vision metadata store expected binding"
  );
  const sessionStore = assertRetainedIntegrationSessionStateStore(
    options.sessionStateStore,
    options.sessionStateStoreExpected
  );
  const metadataStore = assertRetainedIntegrationSessionStateStore(
    options.metadataStore,
    options.metadataStoreExpected
  );
  const binaryFiles = assertIntegrationRetainedBinaryFilePrimitives(
    options.binaryFilePrimitives,
    options.binaryFilePrimitivesExpected
  );
  const binaryLock = assertIntegrationRetainedRegularFileLock(
    options.binaryFileLock,
    options.binaryFileLockExpected
  );
  const binaryBinding = binaryFiles.attestation;
  const binaryLockBinding = binaryLock.attestation;
  if (!sameDirectoryBinding(binaryBinding, binaryLockBinding)) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained image blob files and lock do not share one exact directory.");
  }
  const bindingFailures = [
    binaryBinding.canonicalPath !== sessionExpected.canonicalPath ? "blob-root-path" : "",
    binaryBinding.rootIdentityDigest !== sessionExpected.rootIdentityDigest ? "blob-root-identity" : "",
    metadataExpected.canonicalPath !== sessionExpected.canonicalPath ? "metadata-root-path" : "",
    metadataExpected.rootIdentityDigest !== sessionExpected.rootIdentityDigest ? "metadata-root-identity" : "",
    contractDigest(binaryBinding.relativeSegments) === contractDigest(sessionExpected.relativeSegments) ? "blob-session-alias" : "",
    contractDigest(metadataExpected.relativeSegments) === contractDigest(sessionExpected.relativeSegments) ? "metadata-session-alias" : "",
    contractDigest(metadataExpected.relativeSegments) === contractDigest(binaryBinding.relativeSegments) ? "metadata-blob-alias" : "",
  ].filter(Boolean);
  if (bindingFailures.length > 0) {
    fail(
      "INTEGRATION_VISION_WORKSPACE_UNAVAILABLE",
      `Retained image metadata and blob storage must be dedicated directories under the exact retained root (${bindingFailures.join(",")}).`
    );
  }
  const evidence = assertRetainedIntegrationNativeExecutionEvidence(options.nativeExecutionEvidence, {
    sessionStateStore: sessionStore,
    sessionStateStoreExpected: options.sessionStateStoreExpected,
    storageNamespaceDigest: sessionStore.attestation.logicalNamespaceDigest,
  });
  const repository = assertRetainedIntegrationRuntimeRepositorySurface(options.repository);
  const bootstrap = assertIntegrationRuntimeProcessOwnerBootstrap(options.processOwnerBootstrap);
  const recovery = assertRetainedIntegrationRuntimeRecoveryCoordinator(options.recoveryCoordinator, {
    repository,
    nativeExecutionEvidence: evidence,
    processOwnerBootstrap: options.processOwnerBootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
  });
  const textWorkspace = assertRetainedIntegrationTextWorkspace(options.textWorkspace, {
    sessionStateStore: sessionStore,
    sessionStateStoreExpected: options.sessionStateStoreExpected,
    nativeExecutionEvidence: evidence,
    repository,
    recoveryCoordinator: recovery,
    processOwnerBootstrap: options.processOwnerBootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
  });
  const constructionTextCurrentProof = await assertRetainedIntegrationTextWorkspaceCurrent(textWorkspace, {
    sessionStateStore: sessionStore,
    nativeExecutionEvidence: evidence,
    repository,
    recoveryCoordinator: recovery,
    processOwnerBootstrap: bootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
  });
  if (sessionStore.isClosed() || metadataStore.isClosed() || binaryFiles.isClosed() || binaryLock.isClosed() || evidence.isClosed()) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained vision-workspace storage is closed.");
  }
  const defaults = resolveProviderDefaults("localllm");
  const connection = frozenRecord({
    provider: "localllm",
    baseURL: normalizeProviderBaseURL("localllm", defaults.baseURL),
    apiKey: defaults.apiKey,
  });
  const state = {
    textWorkspace,
    sessionStore,
    metadataStore,
    binaryFiles,
    binaryLock,
    evidence,
    repository,
    recovery,
    bootstrap,
    repositoryFenceLease: options.repositoryFenceLease,
    constructionTextCurrentProof,
    blobStorageNamespaceDigest: contractDigest({
      domain: "aginti-retained-vision-blob-storage-namespace-v1",
      role: binaryBinding.role,
      canonicalPath: binaryBinding.canonicalPath,
      relativeSegments: binaryBinding.relativeSegments,
    }),
    connection,
    modelRouteIdentityDigest: contractDigest({
      domain: "aginti-retained-vision-model-route-v1",
      provider: "localllm",
      baseURL: connection.baseURL,
      model: INTEGRATION_RETAINED_VISION_MODEL_ID,
      hostedFallback: false,
    }),
    attestation: null,
  };
  state.attestation = buildAttestation(state);
  const surface = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_VISION_WORKSPACE_VERSION,
    attestation: state.attestation,

    async attestCurrent() {
      return currentVisionWorkspaceProof(state);
    },

    async prepareImageUpload(inputValue) {
      await currentVisionWorkspaceProof(state);
      const raw = exactPayload(inputValue, ["scope", "mimeType", "bytes"], [], "retained image upload");
      const scope = normalizeScope(raw.scope);
      const image = validateImageBytes(raw.bytes, raw.mimeType);
      const metadata = metadataFor(scope, image, state);
      await ensureStagedBlob(state, metadata, image.bytes);
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-vision-upload-prepared-v1",
        referenceId: metadata.referenceId,
        proofDigest: contractDigest({ admissionDigest: metadata.admissionDigest, sha256: metadata.sha256 }),
      });
      uploadBrand.set(handle, { lane: state, metadata });
      return frozenRecord({ handle, reference: publicReference(metadata) });
    },

    async publishImageUpload(handle) {
      await currentVisionWorkspaceProof(state);
      const prepared = uploadBrand.get(handle);
      if (!prepared || prepared.lane !== state) {
        fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained image upload proof is unavailable.");
      }
      const result = await publishMetadata(state, prepared.metadata);
      uploadBrand.delete(handle);
      return result;
    },

    async stageImageUpload(inputValue) {
      const prepared = await surface.prepareImageUpload(inputValue);
      return surface.publishImageUpload(prepared.handle);
    },

    async revokeImageReference(inputValue) {
      await currentVisionWorkspaceProof(state);
      const raw = exactPayload(inputValue, ["scope", "referenceId"], [], "retained image revocation");
      const scope = normalizeScope(raw.scope);
      const referenceId = assertReferenceId(raw.referenceId);
      const current = await resolveMetadataForScope(state, scope, referenceId, { allowRevoked: true });
      if (current.metadata.revokedAt !== null) {
        return frozenRecord({ outcome: "replayed", reference: publicReference(current.metadata), revoked: true });
      }
      const revokedAt = new Date().toISOString();
      const next = frozenRecord({
        ...current.metadata,
        revokedAt,
        revocationDigest: contractDigest({
          domain: "aginti-retained-vision-revocation-v1",
          admissionDigest: current.metadata.admissionDigest,
          revokedAt,
        }),
      });
      const sessionId = metadataSessionId(referenceId, state.metadataStore.attestation.logicalNamespaceDigest);
      const result = await state.metadataStore.compareAndSwapSessionSnapshot({
        mutationId: `vision-revoke.${referenceId.slice(5)}`,
        nativeSessionId: sessionId,
        expectedPersistenceRevision: current.snapshot.persistenceRevision,
        expectedIntegrityDigest: current.snapshot.integrityDigest,
        state: metadataState(next, sessionId),
      });
      const committed = validateMetadata(result.snapshot, referenceId, state);
      if (!committed || committed.revokedAt === null || !exactAdmissionMatches(committed, current.metadata)) {
        fail("INTEGRATION_VISION_WORKSPACE_CORRUPT", "Retained image revocation result is invalid.");
      }
      return frozenRecord({ outcome: result.outcome, reference: publicReference(committed), revoked: true });
    },

    async inspectImageReference(inputValue) {
      await currentVisionWorkspaceProof(state);
      const raw = exactPayload(inputValue, ["scope", "referenceId"], [], "retained image inspection");
      const scope = normalizeScope(raw.scope);
      const current = await resolveMetadataForScope(state, scope, assertReferenceId(raw.referenceId), { allowRevoked: true });
      await readAndVerifyBlob(state, current.metadata);
      return frozenRecord({ reference: publicReference(current.metadata), revoked: current.metadata.revokedAt !== null });
    },

    async prepareExecution(scopeInput) {
      await currentVisionWorkspaceProof(state);
      const scope = normalizeScope(scopeInput);
      const prepared = await textWorkspace.prepareExecution(scope);
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-vision-workspace-preflight-v1",
        proofDigest: contractDigest({ scope, textProofDigest: prepared.handle.proofDigest }),
      });
      preflightBrand.set(handle, { lane: state, scope, textPreflight: prepared.handle });
      return frozenRecord({ handle, nativeState: prepared.nativeState, nativeSnapshot: prepared.nativeSnapshot });
    },

    async bindAuthorizedExecution(bindingInput) {
      const raw = exactPayload(
        bindingInput,
        ["authorization", "snapshotHash", "preflight"],
        [],
        "vision-workspace authorization binding"
      );
      const prepared = preflightBrand.get(raw.preflight);
      if (!prepared || prepared.lane !== state) {
        fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Vision-workspace preflight proof is unavailable.");
      }
      const textHandle = await textWorkspace.bindAuthorizedExecution({
        authorization: raw.authorization,
        snapshotHash: raw.snapshotHash,
        preflight: prepared.textPreflight,
      });
      const handle = frozenRecord({
        schemaVersion: "aginti-retained-vision-workspace-execution-v1",
        bindingDigest: contractDigest({
          preflightDigest: raw.preflight.proofDigest,
          textBindingDigest: textHandle.bindingDigest,
        }),
      });
      executionBrand.set(handle, { lane: state, scope: prepared.scope, textHandle });
      preflightBrand.delete(raw.preflight);
      return handle;
    },

    invoke(handle, operation, args = []) {
      const active = executionBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Vision-workspace execution binding is unavailable.");
      }
      return textWorkspace.invoke(active.textHandle, operation, args);
    },

    async invokeReadImage(handle, args, runtime) {
      const active = executionBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Vision-workspace execution binding is unavailable.");
      }
      await currentVisionWorkspaceProof(state);
      return invokePinnedLocalVision(state, active, args, runtime);
    },

    recordTerminalEvidence(handle, terminal) {
      const active = executionBrand.get(handle);
      if (!active || active.lane !== state) {
        fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Vision-workspace execution binding is unavailable.");
      }
      return textWorkspace.recordTerminalEvidence(active.textHandle, terminal);
    },

    isClosed() {
      return sessionStore.isClosed() || metadataStore.isClosed() || binaryFiles.isClosed() || binaryLock.isClosed() || evidence.isClosed();
    },
  });
  profileBrand.set(surface, state);
  return surface;
}

export function assertRetainedIntegrationVisionWorkspace(value, expected = {}) {
  const state = value && typeof value === "object" && !utilTypes.isProxy(value)
    ? profileBrand.get(value)
    : null;
  if (!state || value.schemaVersion !== INTEGRATION_RETAINED_VISION_WORKSPACE_VERSION) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained vision-workspace lexical brand is invalid.");
  }
  if (
    expected.textWorkspace && state.textWorkspace !== expected.textWorkspace ||
    expected.sessionStateStore && state.sessionStore !== expected.sessionStateStore ||
    expected.metadataStore && state.metadataStore !== expected.metadataStore ||
    expected.nativeExecutionEvidence && state.evidence !== expected.nativeExecutionEvidence ||
    expected.repository && state.repository !== expected.repository ||
    expected.recoveryCoordinator && state.recovery !== expected.recoveryCoordinator ||
    expected.processOwnerBootstrap && state.bootstrap !== expected.processOwnerBootstrap ||
    expected.repositoryFenceLease && state.repositoryFenceLease !== expected.repositoryFenceLease ||
    expected.binaryFilePrimitives && state.binaryFiles !== expected.binaryFilePrimitives ||
    expected.binaryFileLock && state.binaryLock !== expected.binaryFileLock
  ) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained vision-workspace binding identity changed.");
  }
  if (value.attestation.digest !== contractDigest(Object.fromEntries(
    Object.entries(value.attestation).filter(([key]) => key !== "digest")
  ))) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained vision-workspace attestation is invalid.");
  }
  return value;
}

async function currentVisionWorkspaceProof(state) {
  const textProof = await assertRetainedIntegrationTextWorkspaceCurrent(state.textWorkspace, {
    sessionStateStore: state.sessionStore,
    nativeExecutionEvidence: state.evidence,
    repository: state.repository,
    recoveryCoordinator: state.recovery,
    processOwnerBootstrap: state.bootstrap,
    repositoryFenceLease: state.repositoryFenceLease,
  });
  if (state.metadataStore.isClosed() || state.binaryFiles.isClosed() || state.binaryLock.isClosed()) {
    fail("INTEGRATION_VISION_WORKSPACE_UNAVAILABLE", "Retained vision metadata or blob storage is closed.");
  }
  const unsigned = frozenRecord({
    schemaVersion: INTEGRATION_RETAINED_VISION_WORKSPACE_CURRENT_PROOF_VERSION,
    profileAttestationDigest: state.attestation.digest,
    textWorkspaceCurrentProofDigest: textProof.digest,
    repositoryFenceLeaseDigest: textProof.repositoryFenceLeaseDigest,
    durablyCurrent: true,
    nativeSessionStateWriterFencing: false,
    nativeSessionStateWriterQuiescenceProven: false,
    crossProcessImageWriterFencing: false,
  });
  return frozenRecord({ ...unsigned, digest: contractDigest(unsigned) });
}

export async function assertRetainedIntegrationVisionWorkspaceCurrent(value, expected = {}) {
  assertRetainedIntegrationVisionWorkspace(value, expected);
  return currentVisionWorkspaceProof(profileBrand.get(value));
}

export function isIntegrationVisionWorkspaceToolAllowed(name) {
  return INTEGRATION_VISION_WORKSPACE_TOOL_NAMES.includes(String(name || ""));
}
