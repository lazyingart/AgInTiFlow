// Credential-free acquisition primitive. Callers own paper selection, rights,
// durable jobs, quotas and authenticated storage; this module executes no PDF.
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PUBLIC_V6 = new BlockList();
PUBLIC_V6.addSubnet("2000::", 3, "ipv6");
const RESERVED = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) RESERVED.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
]) RESERVED.addSubnet(address, prefix, "ipv6");
const DOWNLOADERS = new WeakSet();

export class PublicPdfDownloadError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "PublicPdfDownloadError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new PublicPdfDownloadError(code, message, status);
}

export function isPublicPdfAddress(address) {
  if (typeof address !== "string") return false;
  const family = isIP(address);
  if (family === 4) return !RESERVED.check(address, "ipv4");
  // Mapped, link-local, translation, multicast and other non-global ranges do
  // not acquire authority from a DNS answer. IPv4 is checked in its own form.
  return family === 6 && PUBLIC_V6.check(address, "ipv6") && !RESERVED.check(address, "ipv6");
}

function publicUrl(value, origins) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length > 2048 ||
      /[\s\\\p{C}]/u.test(value)) fail("URL_DENIED", "A reviewed public HTTPS PDF URL is required.");
  let url;
  try { url = new URL(value); } catch { fail("URL_DENIED", "PDF URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      !url.hostname.includes(".") || isIP(url.hostname.replace(/^\[|\]$/gu, "")) ||
      /(?:^|\.)(?:localhost|local|internal|intranet|lan)$/iu.test(url.hostname) ||
      !origins.has(url.origin)) fail("URL_DENIED", "PDF URL is outside the reviewed public origins.");
  return url;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function requestPdf(request, url, address, signal) {
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: "https:", hostname: url.hostname, servername: url.hostname,
      port: 443, method: "GET", path: url.pathname + url.search,
      family: address.family, autoSelectFamily: false, agent: false,
      rejectUnauthorized: true, maxHeaderSize: 16 * 1024, signal,
      // Pin the checked DNS answer to this connection; fetch's independent
      // resolver would otherwise permit DNS rebinding after preflight.
      lookup: (_hostname, options, callback) => callback(null,
        options?.all ? [address] : address.address, options?.all ? undefined : address.family),
      headers: {
        "user-agent": "AgInTiFlow/1.0 (+https://flow.lazying.art)",
        accept: "application/pdf,application/octet-stream;q=0.5",
        "accept-encoding": "identity",
      },
    }, resolve);
    req.once("error", reject);
    req.end();
  });
}

function sameAddress(actual, expected) {
  if (!isIP(actual || "")) return false;
  const match = new BlockList();
  match.addAddress(expected.address, expected.family === 4 ? "ipv4" : "ipv6");
  return match.check(actual, isIP(actual) === 4 ? "ipv4" : "ipv6");
}

function createDownloader(config, transport, testOnly) {
  if (!config || Object.keys(config).some(key => !["allowedOrigins", "maximumBytes", "timeoutMs"].includes(key))) {
    fail("CONFIGURATION_INVALID", "PDF acquisition configuration is invalid.");
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length < 1 || config.allowedOrigins.length > 32) {
    fail("CONFIGURATION_INVALID", "PDF acquisition needs explicit reviewed origins.");
  }
  const origins = new Set(config.allowedOrigins);
  for (const origin of origins) {
    const url = publicUrl(origin, origins);
    if (origin !== url.origin) fail("CONFIGURATION_INVALID", "PDF origins must be canonical HTTPS origins.");
  }
  const maximumBytes = config.maximumBytes ?? MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > MAX_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 90_000) {
    fail("CONFIGURATION_INVALID", "PDF acquisition limits are outside their bounds.");
  }
  let busy = false;
  let nextRequestAt = 0;
  const downloader = Object.freeze({
    testOnly,
    async download(value, { signal: callerSignal } = {}) {
      let url = publicUrl(value, origins);
      if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) {
        fail("INVALID_REQUEST", "PDF cancellation requires an AbortSignal.");
      }
      if (busy) fail("BUSY", "A PDF acquisition is already running; keep this request queued.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new PublicPdfDownloadError("TIMEOUT", "PDF acquisition timed out.")), timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
      busy = true;
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          signal.throwIfAborted();
          await delay(Math.max(0, nextRequestAt - performance.now()), undefined, { signal });
          const addresses = await abortable(transport.lookup(url.hostname, { all: true, verbatim: true }), signal);
          if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64 ||
              addresses.some(item => !item || isIP(item.address) !== item.family || !isPublicPdfAddress(item.address))) {
            fail("ADDRESS_DENIED", "PDF origin resolved to an unavailable or non-public address.");
          }
          signal.throwIfAborted();
          const address = addresses.find(item => item.family === 4) ?? addresses[0];
          nextRequestAt = performance.now() + transport.minimumIntervalMs;
          const response = await requestPdf(transport.request, url, address, signal);
          try {
            if (response.socket?.authorized !== true || !sameAddress(response.socket?.remoteAddress, address)) {
              fail("CONNECTION_DENIED", "PDF connection did not match its verified TLS origin and address.");
            }
            if (REDIRECTS.has(response.statusCode)) {
              if (hop === MAX_REDIRECTS) fail("REDIRECT_LIMIT", "PDF acquisition exceeded its redirect limit.");
              if (typeof response.headers.location !== "string") fail("INVALID_RESPONSE", "PDF redirect has no valid target.");
              let next;
              try { next = new URL(response.headers.location, url).href; }
              catch { fail("URL_DENIED", "PDF redirect target is invalid."); }
              url = publicUrl(next, origins);
              continue;
            }
            if (response.statusCode !== 200) fail("HTTP_ERROR", "PDF source did not return a complete document.", response.statusCode);
            const mime = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
            if (!["application/pdf", "application/octet-stream"].includes(mime) ||
                ![undefined, "identity"].includes(response.headers["content-encoding"])) {
              fail("NOT_PDF", "PDF source returned a different or encoded content type.");
            }
            const length = response.headers["content-length"];
            if (length !== undefined && (!/^[1-9][0-9]*$/u.test(length) || Number(length) > maximumBytes)) {
              fail("SIZE_LIMIT", "PDF source exceeds the document size limit.");
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of response) {
              signal.throwIfAborted();
              size += chunk.length;
              if (size > maximumBytes) fail("SIZE_LIMIT", "PDF source exceeds the document size limit.");
              chunks.push(chunk);
            }
            signal.throwIfAborted();
            if (response.complete !== true || (length !== undefined && size !== Number(length))) {
              fail("INCOMPLETE", "PDF transfer did not complete.");
            }
            const bytes = Buffer.concat(chunks, size);
            if (!/^%PDF-[12]\.[0-9]/u.test(bytes.subarray(0, 8).toString("latin1")) ||
                !/%%EOF[\t\n\f\r ]*$/u.test(bytes.subarray(-1024).toString("latin1"))) {
              fail("NOT_PDF", "Source bytes do not have a complete PDF envelope.");
            }
            return Object.freeze({
              sourceUrl: value, finalUrl: url.href, mime: "application/pdf", bytes,
              sizeBytes: size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
              acquiredAt: new Date().toISOString(),
            });
          } finally { response.destroy(); }
        }
      } catch (error) {
        if (callerSignal?.aborted) fail("CANCELLED", "PDF acquisition was cancelled.");
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof PublicPdfDownloadError) throw error;
        // Transport diagnostics can include URLs, addresses or headers. Keep
        // those out of the public exception; no credential/error-body relay.
        fail("NETWORK_ERROR", "PDF source could not be reached securely.");
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
  });
  DOWNLOADERS.add(downloader);
  return downloader;
}

export function createPublicPdfDownloader(config) {
  return createDownloader(config, { lookup, request: https.request, minimumIntervalMs: 3000 }, false);
}

export function createTestOnlyPublicPdfDownloader(config, transport) {
  return createDownloader(config, { ...transport, minimumIntervalMs: 0 }, true);
}

export function assertPublicPdfDownloader(value, { allowTestOnly = false } = {}) {
  if (!DOWNLOADERS.has(value) || (value.testOnly && !allowTestOnly)) {
    fail("CONFIGURATION_INVALID", "A production PDF acquisition client is required.");
  }
  return value;
}
