// Credential-free, single-hop page transport. Domain/redirect policy stays in
// the reader. Like public PDF acquisition, DNS approval binds the TCP peer;
// an independent fetch resolver must not replace that approval after preflight.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable, Transform, pipeline } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { isPublicPdfAddress as isPublicAddress } from "./public-pdf-download.js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_URL_BYTES = 8192;
const responses = new WeakMap();

function closed(stream) {
  return !stream || stream.closed ? Promise.resolve() : new Promise(resolve => stream.once("close", resolve));
}

function dispose(state) {
  if (!state.disposed) state.disposed = (async () => {
    for (const stream of state.streams) stream.destroy();
    state.request.destroy();state.socket?.destroy();
    await Promise.all([state.pipelineDone, state.requestClosed, state.incomingClosed, state.socketClosed]);
  })();
  return state.disposed;
}

// Only responses made here carry this private ownership record. A trusted
// custom fetch remains responsible for its own transport rather than acquiring
// a native lifetime attestation from the shape of a Response object.
export async function disposePublicWebResponse(response) {
  const state = responses.get(response);
  if (!state) return false;
  await dispose(state);return true;
}

function abortable(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    // DNS itself cannot be cancelled through getaddrinfo. Its eventual result
    // is observed but never dispatches a request after caller cancellation.
    Promise.resolve(operation).then(
      value => { signal.removeEventListener("abort", aborted);resolve(value); },
      error => { signal.removeEventListener("abort", aborted);reject(error); },
    );
    if (signal.aborted) { signal.removeEventListener("abort", aborted);aborted(); }
  });
}

function byteLimit(maximumBytes, incoming = null) {
  let total = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    callback(total > maximumBytes ? new Error(`Response exceeds the ${maximumBytes}-byte research limit.`) : null, chunk);
  }, flush(callback) {
    callback(incoming && incoming.complete !== true ? new Error("Source transfer did not complete.") : null);
  } });
}

function decodingStreams(value) {
  const encodings = String(value || "identity").toLowerCase().split(",").map(item => item.trim()).reverse();
  if (encodings.length > 3) throw new Error("Source content encoding exceeds the research limit.");
  return encodings.flatMap(encoding => {
    if (encoding === "identity") return [];
    if (["gzip", "x-gzip"].includes(encoding)) return [createGunzip()];
    if (["deflate", "x-deflate"].includes(encoding)) return [createInflate()];
    if (encoding === "br") return [createBrotliDecompress()];
    throw new Error("Source content encoding is unsupported.");
  });
}

export async function fetchPublicWebResponse(value, { signal = AbortSignal.timeout(20_000), maximumBytes = MAX_BYTES } = {}) {
  if (typeof value !== "string" || !value.isWellFormed() || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BYTES) {
    throw new Error("Public source request is invalid.");
  }
  const url = new URL(value);url.hash = "";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || Buffer.byteLength(url.href, "utf8") > MAX_URL_BYTES) {
    throw new Error("A bounded credential-free public HTTP(S) source is required.");
  }
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const raw = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64 || raw.some(record => !record || isIP(record.address) !== record.family || !isPublicAddress(record.address))) {
    throw new Error("Source hostname resolves to a private, reserved or unavailable network address.");
  }
  const addresses = Object.freeze(raw.map(({ address, family }) => Object.freeze({ address, family })));
  const peers = new BlockList();
  for (const record of addresses) peers.addAddress(record.address, record.family === 4 ? "ipv4" : "ipv6");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    let requestClosed;
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname, port: url.port || (secure ? 443 : 80),
      method: "GET", path: url.pathname + url.search, agent: false,
      ...(secure ? { rejectUnauthorized: true, ...(isIP(hostname) ? {} : { servername: hostname }) } : {}),
      maxHeaderSize: 16 * 1024, signal, autoSelectFamily: true,
      // Return only the detached, approved set. Node can select another family
      // within this set, without performing another ambient DNS lookup.
      lookup: (name, options, callback) => {
        if (name !== hostname) { callback(new Error("Source lookup hostname changed."));return; }
        const candidates = addresses.filter(item => !options?.family || item.family === options.family);
        if (!candidates.length) { callback(new Error("Source address family is unavailable."));return; }
        callback(null, options?.all ? candidates.map(item => ({ ...item })) : candidates[0].address, options?.all ? undefined : candidates[0].family);
      },
      headers: {
        "user-agent": "AgInTiFlow/1.0 (+https://flow.lazying.art)",
        accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/pdf",
        "accept-encoding": "identity",
      },
    }, incoming => {
      const state = { request, socket: incoming.socket, streams: [incoming], pipelineDone: Promise.resolve(),
        requestClosed, incomingClosed: closed(incoming), socketClosed: closed(incoming.socket) };
      try {
        signal?.throwIfAborted();
        const peer = incoming.socket?.remoteAddress, family = isIP(peer || "");
        if (!family || !peers.check(peer, family === 4 ? "ipv4" : "ipv6") || (secure && incoming.socket?.authorized !== true)) {
          throw new Error("Source connection did not match its approved address and TLS origin.");
        }
        const status = incoming.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error("Source HTTP status is invalid.");
        const headers = new Headers();
        for (const name of ["content-type", "content-length", "content-encoding", "location"]) {
          const header = incoming.headers[name];
          if (typeof header === "string") headers.set(name, header);
        }
        let body = null;
        if ([204, 205, 304].includes(status)) incoming.destroy();
        else {
          const decoded = byteLimit(maximumBytes, incoming);
          const streams = [incoming, byteLimit(maximumBytes), ...decodingStreams(incoming.headers["content-encoding"]), decoded];
          // Pipeline owns propagation and closure in either direction. Web-body
          // cancellation destroys the complete owned HTTP/decompression chain.
          state.streams = streams;
          state.pipelineDone = new Promise(done => pipeline(...streams, () => done()));
          body = Readable.toWeb(decoded, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
        }
        const response = new Response(body, { status, headers });
        Object.defineProperty(response, "url", { value: url.href });
        responses.set(response, state);
        resolve(response);
      } catch (error) { dispose(state).then(() => reject(error), () => reject(error)); }
    });
    requestClosed = closed(request);
    request.once("error", error => requestClosed.then(() => reject(error)));
    request.once("upgrade", (_response, socket) => {
      const socketClosed = closed(socket);socket.destroy();request.destroy();
      Promise.all([requestClosed, socketClosed]).then(() => reject(new Error("Source protocol upgrades are not allowed.")));
    });
    request.end();
  });
}
