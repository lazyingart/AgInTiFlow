import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  assertPublicPdfDownloader, createPublicPdfDownloader,
  createTestOnlyPublicPdfDownloader, isPublicPdfAddress,
} from "../src/public-pdf-download.js";

const ORIGIN = "https://papers.example.org";
const URL = ORIGIN + "/paper.pdf";
const PDF = Buffer.from("%PDF-1.7\nsynthetic envelope, not a parsed paper\n%%EOF\n");
const config = { allowedOrigins: [ORIGIN], maximumBytes: 1024, timeoutMs: 1000 };

function fixture(responses = [{}], extra = {}) {
  const requests = [];
  const streams = [];
  const resolutions = [];
  const transport = {
    async lookup(hostname) {
      resolutions.push(hostname);
      return extra.addresses ?? [{ address: "8.8.8.8", family: 4 }];
    },
    request(options, callback) {
      requests.push(options);
      const description = responses[requests.length - 1] ?? responses.at(-1);
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        if (description.error) { request.emit("error", description.error); return; }
        const body = description.body ?? PDF;
        const response = new PassThrough();
        streams.push(response);
        response.statusCode = description.status ?? 200;
        response.headers = description.headers ?? { "content-type": "application/pdf", "content-length": String(body.length) };
        response.socket = { authorized: true, remoteAddress: "8.8.8.8", ...description.socket };
        response.complete = description.complete ?? true;
        const abort = () => response.destroy(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        response.once("close", () => options.signal.removeEventListener("abort", abort));
        callback(response);
        // Let the caller attach stream error listeners before controlled failure.
        setImmediate(() => {
          if (description.stall) return;
          if (description.streamError) response.destroy(new Error("private transport diagnostic"));
          else if (!response.destroyed) response.end(body);
        });
      });
      return request;
    },
    ...extra.transport,
  };
  const downloader = createTestOnlyPublicPdfDownloader({ ...config, ...extra.config }, transport);
  return { downloader, requests, streams, resolutions };
}

const fails = (operation, code) => assert.rejects(operation, error => error.code === code);

test("returns exact bytes and provenance over a DNS-pinned credential-free request", async () => {
  const { downloader, requests, resolutions, streams } = fixture();
  const result = await downloader.download(URL);
  assert.deepEqual(result.bytes, PDF);
  assert.equal(result.sha256, crypto.createHash("sha256").update(PDF).digest("hex"));
  assert.equal(result.sourceUrl, URL);
  assert.equal(result.finalUrl, URL);
  assert.equal(result.mime, "application/pdf");
  assert.equal(result.sizeBytes, PDF.length);
  assert.equal(new Date(result.acquiredAt).toISOString(), result.acquiredAt);
  assert.deepEqual(resolutions, ["papers.example.org"]);
  const options = requests[0];
  assert.equal(options.hostname, "papers.example.org");
  assert.equal(options.servername, options.hostname);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  assert.deepEqual(Object.keys(options.headers).sort(), ["accept", "accept-encoding", "user-agent"]);
  const resolved = await new Promise((resolve, reject) => options.lookup(options.hostname, {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(resolved, { address: "8.8.8.8", family: 4 });
  const all = await new Promise((resolve, reject) => options.lookup(options.hostname, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [resolved]);
  assert(streams.every(stream => stream.destroyed));
});

test("production configuration has no injectable transport and test clients are branded", () => {
  const actual = createPublicPdfDownloader(config);
  assert.equal(assertPublicPdfDownloader(actual), actual);
  const { downloader } = fixture();
  assert.throws(() => assertPublicPdfDownloader(downloader));
  assert.equal(assertPublicPdfDownloader(downloader, { allowTestOnly: true }), downloader);
  assert.throws(() => assertPublicPdfDownloader({ ...actual }));
  assert.throws(() => createPublicPdfDownloader({ ...config, request() {} }));
  for (const change of [
    { allowedOrigins: [] }, { allowedOrigins: ["https://papers.example.org/path"] },
    { maximumBytes: 1023 }, { maximumBytes: 20 * 1024 * 1024 + 1 },
    { timeoutMs: 0 }, { timeoutMs: 90001 },
  ]) assert.throws(() => createPublicPdfDownloader({ ...config, ...change }));
});

for (const address of [
  "127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "172.31.0.1",
  "192.168.1.1", "0.0.0.0", "192.0.2.1", "192.88.99.1", "198.18.0.1",
  "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1",
  "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1",
  "2001:db8::1", "2002:7f00:1::1", "64:ff9b::7f00:1", "3fff::1", "not-an-ip",
]) test(`reject non-public or translated address ${address}`, () => assert.equal(isPublicPdfAddress(address), false));

test("public IPv4 and IPv6 addresses remain available", () => {
  assert(isPublicPdfAddress("8.8.8.8"));
  assert(isPublicPdfAddress("2001:4860:4860::8888"));
  assert(isPublicPdfAddress("2606:4700:4700::1111"));
});

for (const url of [
  "http://papers.example.org/paper.pdf", "file:///etc/passwd", "https://127.0.0.1/p.pdf",
  "https://2130706433/p.pdf", "https://[::1]/p.pdf", "https://localhost/p.pdf",
  "https://other.example.org/p.pdf", "https://papers.example.org.evil.test/p.pdf",
  "https://user:password@papers.example.org/p.pdf", URL + "#fragment", URL + "\n",
  "https://papers.example.org:8443/p.pdf", "https://papers.example.org\\@localhost/p.pdf",
]) test(`reject unreviewed URL ${JSON.stringify(url)}`, async () => {
  const { downloader, requests, resolutions } = fixture();
  await fails(downloader.download(url), "URL_DENIED");
  assert.equal(requests.length + resolutions.length, 0);
});

for (const addresses of [
  [], [{ address: "127.0.0.1", family: 4 }],
  [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
  [{ address: "8.8.8.8", family: 6 }], [{ address: "garbage", family: 0 }],
]) test(`reject unsafe DNS set ${JSON.stringify(addresses)}`, async () => {
  const { downloader, requests } = fixture([{}], { addresses });
  await fails(downloader.download(URL), "ADDRESS_DENIED");
  assert.equal(requests.length, 0);
});

test("each redirect is reviewed and DNS checked, with bodies closed", async () => {
  const { downloader, requests, streams, resolutions } = fixture([
    { status: 302, headers: { location: "/canonical.pdf" } }, {},
  ]);
  const result = await downloader.download(URL);
  assert.equal(result.finalUrl, ORIGIN + "/canonical.pdf");
  assert.deepEqual(requests.map(item => item.path), ["/paper.pdf", "/canonical.pdf"]);
  assert.equal(resolutions.length, 2);
  assert(streams.every(stream => stream.destroyed));
});

test("a previously public origin cannot rebind to a private address on redirect", async () => {
  let lookups = 0;
  const { downloader, requests, streams } = fixture([{ status: 302, headers: { location: "/next.pdf" } }], {
    transport: { async lookup() {
      return [{ address: ++lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    } },
  });
  await fails(downloader.download(URL), "ADDRESS_DENIED");
  assert.equal(lookups, 2);
  assert.equal(requests.length, 1);
  assert(streams[0].destroyed);
});

test("IPv6-only public origins preserve the exact pinned peer", async () => {
  const { downloader, requests } = fixture([{ socket: { remoteAddress: "2001:4860:4860:0:0:0:0:8888" } }], {
    addresses: [{ address: "2001:4860:4860::8888", family: 6 }],
  });
  assert.deepEqual((await downloader.download(URL)).bytes, PDF);
  assert.equal(requests[0].family, 6);
});

for (const location of ["http://papers.example.org/p.pdf", "https://127.0.0.1/p.pdf", "https://evil.test/p.pdf"]) {
  test(`stop an unreviewed redirect ${location}`, async () => {
    const { downloader, requests, streams } = fixture([{ status: 302, headers: { location } }]);
    await fails(downloader.download(URL), "URL_DENIED");
    assert.equal(requests.length, 1);
    assert(streams[0].destroyed);
  });
}

test("redirect loops are bounded", async () => {
  const { downloader, requests } = fixture([{ status: 302, headers: { location: "/loop.pdf" } }]);
  await fails(downloader.download(URL), "REDIRECT_LIMIT");
  assert.equal(requests.length, 6);
});

for (const status of [401, 403, 404, 429, 500, 206]) test(`HTTP ${status} stops without retries`, async () => {
  const { downloader, requests, streams } = fixture([{ status }]);
  await assert.rejects(downloader.download(URL), error => error.code === "HTTP_ERROR" && error.status === status);
  assert.equal(requests.length, 1);
  assert(streams[0].destroyed);
});

for (const [name, description, code] of [
  ["HTML", { headers: { "content-type": "text/html" } }, "NOT_PDF"],
  ["encoded body", { headers: { "content-type": "application/pdf", "content-encoding": "gzip" } }, "NOT_PDF"],
  ["declared oversized", { headers: { "content-type": "application/pdf", "content-length": "1025" } }, "SIZE_LIMIT"],
  ["invalid length", { headers: { "content-type": "application/pdf", "content-length": "-1" } }, "SIZE_LIMIT"],
  ["chunked oversized", { body: Buffer.alloc(1025), headers: { "content-type": "application/pdf" } }, "SIZE_LIMIT"],
  ["length mismatch", { headers: { "content-type": "application/pdf", "content-length": "1000" } }, "INCOMPLETE"],
  ["incomplete transfer", { complete: false }, "INCOMPLETE"],
  ["stream error", { streamError: true }, "NETWORK_ERROR"],
  ["untrusted TLS", { socket: { authorized: false } }, "CONNECTION_DENIED"],
  ["unexpected peer", { socket: { remoteAddress: "1.1.1.1" } }, "CONNECTION_DENIED"],
  ["fake envelope", { body: Buffer.from("not a PDF\n%%EOF\n") }, "NOT_PDF"],
  ["truncated PDF", { body: Buffer.from("%PDF-1.7\nno footer") }, "NOT_PDF"],
  ["high-bit header spoof", { body: Buffer.concat([Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]), PDF.subarray(5)]) }, "NOT_PDF"],
]) test(`reject ${name}`, async () => {
  const { downloader, streams } = fixture([description]);
  await fails(downloader.download(URL), code);
  assert(streams.every(stream => stream.destroyed));
});

test("octet-stream and chunked PDF bytes are validated without trusting the name", async () => {
  const { downloader } = fixture([{ headers: { "content-type": "application/octet-stream" } }]);
  assert.deepEqual((await downloader.download(ORIGIN + "/download?id=public-paper")).bytes, PDF);
});

test("DNS timeout does not dispatch a later connection and releases the busy slot", async () => {
  let resolve;
  const { downloader, requests } = fixture([{}], {
    config: { timeoutMs: 100 }, transport: { lookup: () => new Promise(done => { resolve = done; }) },
  });
  const pending = downloader.download(URL);
  await fails(downloader.download(URL), "BUSY");
  await fails(pending, "TIMEOUT");
  resolve([{ address: "8.8.8.8", family: 4 }]);
  await new Promise(done => setImmediate(done));
  assert.equal(requests.length, 0);
  const abort = new AbortController(); abort.abort();
  await fails(downloader.download(URL, { signal: abort.signal }), "CANCELLED");
});

test("slow body timeout destroys its exact stream", async () => {
  const { downloader, streams } = fixture([{ stall: true }], { config: { timeoutMs: 100 } });
  await fails(downloader.download(URL), "TIMEOUT");
  assert(streams[0].destroyed);
});

test("the total deadline also aborts a connection before response headers", async () => {
  let connectionAborted = false;
  const { downloader } = fixture([{}], { config: { timeoutMs: 100 }, transport: {
    request(options) {
      const request = new EventEmitter();
      request.end = () => {};
      options.signal.addEventListener("abort", () => {
        connectionAborted = true;
        request.emit("error", options.signal.reason);
      }, { once: true });
      return request;
    },
  } });
  await fails(downloader.download(URL), "TIMEOUT");
  assert(connectionAborted);
});

test("cancellation stops a live download and the same client can be reused", async () => {
  const { downloader, streams } = fixture([{ stall: true }, {}]);
  const controller = new AbortController();
  const pending = downloader.download(URL, { signal: controller.signal });
  while (!streams.length) await new Promise(done => setImmediate(done));
  controller.abort();
  await fails(pending, "CANCELLED");
  assert(streams[0].destroyed);
  assert.deepEqual((await downloader.download(URL)).bytes, PDF);
});

test("network errors do not expose underlying diagnostic text", async () => {
  const { downloader } = fixture([{ error: new Error("secret URL and credential diagnostic") }]);
  await assert.rejects(downloader.download(URL), error => error.code === "NETWORK_ERROR" && !/secret|credential/u.test(error.message));
});
