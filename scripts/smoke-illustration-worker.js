import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { loadDatabaseSync } from "../src/sqlite.js";
import { PROFILE, PROFILE_DIGEST, canonical, digest, snapshot, createRequest, exact, identifier, hexDigest } from "../src/illustration-contract.js";
import { openIllustrationStore, assertIllustrationStore } from "../src/illustration-store.js";
import { validateIllustrationPng } from "../src/illustration-png.js";
import { createIllustrationWorker } from "../src/illustration-worker.js";
import { createVeniceIllustrationTransport } from "../src/illustration-transport.js";
import { createIllustrationRpc } from "../src/illustration-rpc.js";

const OWNER = { appId: "app_fixture_000001", principalId: "principal_00000001" };
const KEY = "idempotency_00000001";
const REQUEST = { actionId: "action_fixture_00001", sourceBinding: { scopeDigest: "a".repeat(64), contentDigest: "b".repeat(64), policyDigest: "c".repeat(64) }, overlayDigest: "d".repeat(64), prompt: "Illustrate a public-domain story landscape. No factual labels.", styleId: "illustration" };
function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4); return b;
}
function png({ width = 2, height = 2, filter = 0, color = 6, interlace = 0, metadata = false, extra = Buffer.alloc(0), decoded = null } = {}) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = color; h[12] = interlace;
  const scanlines = decoded || Buffer.alloc((width * (color === 2 ? 3 : 4) + 1) * height);
  if (!decoded) for (let y = 0; y < height; y++) scanlines[y * (width * (color === 2 ? 3 : 4) + 1)] = filter;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", h), ...(metadata ? [chunk("tEXt", Buffer.from("private-prompt-marker"))] : []), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)), extra]);
}
const IMAGE = png();
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const errorCode = (code) => (error) => error.code === code;
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-illustration-smoke-"));
  const stores = [], workers = [];
  const open = () => { const s = openIllustrationStore(root); stores.push(s); return s; };
  const worker = (s, submit) => { const w = createIllustrationWorker({ store: s, transport: Object.freeze({ submit }) }); workers.push(w); return w; };
  try { await fn({ root, open, worker }); }
  finally { for (const w of workers) await w.close().catch(() => {}); for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
function child(root, mode) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", root, mode], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("child timeout")); }, 5000);
    p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { err += c; });
    p.once("error", reject);
    p.once("close", (code) => { clearTimeout(timer); if (![0, 17].includes(code)) reject(new Error(`child ${code}: ${err}`)); else resolve(JSON.parse(out)); });
  });
}
function editRecord(root, change) {
  const db = new (loadDatabaseSync())(path.join(root, "illustrations.sqlite"));
  try {
    const row = db.prepare("SELECT * FROM jobs").get();
    const r = change(JSON.parse(row.record));
    db.prepare("UPDATE jobs SET record=?,integrity=? WHERE id=?").run(canonical(r), digest(r), row.id);
  } finally { db.close(); }
}

if (process.argv[2] === "--child") {
  const root = process.argv[3], mode = process.argv[4];
  const s = openIllustrationStore(root);
  if (mode === "claim") { const r = s.claim(OWNER, KEY, REQUEST); process.stdout.write(JSON.stringify(r)); s.close(); }
  if (mode === "completed-crash") {
    const claim = s.claim(OWNER, KEY, REQUEST);
    const job = s.settle(OWNER, claim.job.jobId, validateIllustrationPng(IMAGE));
    process.stdout.write(JSON.stringify(job)); process.exit(17);
  }
  if (mode === "crash") {
    const w = createIllustrationWorker({ store: s, transport: Object.freeze({ submit: async () => { fs.writeFileSync(path.join(root, "submission-proof"), "one", { flag: "wx", mode: 0o600 }); process.exit(17); } }) });
    process.stdout.write(JSON.stringify(w.create(OWNER, KEY, REQUEST)));
    await new Promise(() => {});
  }
} else {
  test("exact keys and scalar identifiers reject separator and trailing-newline aliases", () => {
    assert.throws(() => exact({ "": true }, []));
    assert.throws(() => createRequest({ ...REQUEST, sourceBinding: { "contentDigest|policyDigest|scopeDigest": "a".repeat(64) } }));
    for (const suffix of ["\n", "\r", "\r\n"]) {
      assert.throws(() => identifier(OWNER.appId + suffix));
      assert.throws(() => hexDigest("a".repeat(64) + suffix));
      assert.throws(() => createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000" + suffix }));
    }
  });
  test("strict canonical requests reject descriptor, path, provider and Unicode ambiguity", () => {
    assert.equal(createRequest(REQUEST).prompt, REQUEST.prompt);
    for (const r of [{ ...REQUEST, provider: "x" }, { ...REQUEST, prompt: " " }, { ...REQUEST, prompt: "x".repeat(8193) }, { ...REQUEST, prompt: "\ud800" }, { ...REQUEST, styleId: "arbitrary" }, { ...REQUEST, path: "/tmp/image" }]) assert.throws(() => createRequest(r));
    let traps = 0;
    assert.throws(() => snapshot(new Proxy({}, { get() { traps++; } })));
    assert.throws(() => snapshot({ get prompt() { traps++; } }));
    assert.throws(() => snapshot(Object.defineProperty({}, "hidden", { value: true })));
    assert.throws(() => snapshot([, 1])); assert.throws(() => snapshot({ [Symbol()]: true }));
    assert.equal(traps, 0);
  });
  test("PNG full decode/reencode strips metadata and is canonical", () => {
    const verified = validateIllustrationPng(png({ metadata: true }));
    assert.equal(verified.width, 2); assert.equal(verified.height, 2);
    assert.equal(verified.bytes.includes(Buffer.from("private-prompt-marker")), false);
    assert.deepEqual(validateIllustrationPng(verified.bytes), verified);
    for (let filter = 0; filter <= 4; filter++) assert.deepEqual(validateIllustrationPng(png({ filter })).bytes, verified.bytes);
    assert.equal(validateIllustrationPng(png({ color: 2 })).width, 2);
  });
  test("PNG rejects CRC/truncation/trailing data/animation/decompression and size attacks", () => {
    const corrupt = Buffer.from(IMAGE); corrupt[20] ^= 1;
    const animated = Buffer.concat([IMAGE.subarray(0, 33), chunk("acTL", Buffer.alloc(8)), IMAGE.subarray(33)]);
    const rgb = png({ color: 2 });
    const transparentRgb = Buffer.concat([rgb.subarray(0, 33), chunk("tRNS", Buffer.alloc(6)), rgb.subarray(33)]);
    for (const b of [corrupt, IMAGE.subarray(0, -1), png({ extra: Buffer.from("junk") }), png({ filter: 5 }), png({ interlace: 1 }), png({ width: 2049 }), png({ decoded: Buffer.alloc(1024 * 1024) }), animated, transparentRgb, Buffer.alloc(PROFILE.maxImageBytes + 1), Buffer.from("<svg/>")]) assert.throws(() => validateIllustrationPng(b), errorCode("ILLUSTRATION_PNG_INVALID"));
  });
  test("PNG nonzero RGB/RGBA filter decoding preserves pixels", () => {
    for (const channels of [3, 4]) {
      const width = 7, height = 5, stride = width * channels;
      const raw = Buffer.alloc((stride + 1) * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = (x * 37 + y * 13) % 256;
      const expected = validateIllustrationPng(png({ width, height, color: channels === 3 ? 2 : 6, decoded: raw })).bytes;
      for (let filter = 0; filter <= 4; filter++) {
        const encoded = Buffer.from(raw);
        for (let y = 0; y < height; y++) {
          const row = y * (stride + 1); encoded[row] = filter;
          for (let x = 0; x < stride; x++) {
            const a = x >= channels ? raw[row + 1 + x - channels] : 0;
            const b = y ? raw[row + 1 + x - stride - 1] : 0;
            const c = y && x >= channels ? raw[row + 1 + x - stride - 1 - channels] : 0;
            const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
            const paeth = [a, b, c][distances.indexOf(Math.min(...distances))];
            encoded[row + 1 + x] = (raw[row + 1 + x] - [0, a, b, Math.floor((a + b) / 2), paeth][filter]) & 255;
          }
        }
        assert.deepEqual(validateIllustrationPng(png({ width, height, color: channels === 3 ? 2 : 6, decoded: encoded })).bytes, expected);
      }
    }
  });
  test("create replay, action dedup, exact artifact bytes and restart without prompt persistence", async () => fixture(async ({ root, open, worker }) => {
    let calls = 0;
    const s = open(), w = worker(s, async () => { calls++; return IMAGE; });
    const a = w.create(OWNER, KEY, REQUEST);
    const b = w.create(OWNER, KEY, REQUEST); assert.equal(a.jobId, b.jobId);
    await w.settleLocalWork(); assert.equal(calls, 1);
    const done = w.status(OWNER, a.jobId); assert.equal(done.status, "succeeded");
    assert.equal(w.create(OWNER, "another_key_000001", REQUEST).jobId, a.jobId);
    const content = w.content(OWNER, done.artifact.artifactId); assert.deepEqual(content.bytes, validateIllustrationPng(IMAGE).bytes);
    await w.close(); s.close();
    const s2 = open(); assert.deepEqual(s2.status(OWNER, a.jobId), done);
    assert.equal(s2.claim(OWNER, KEY, REQUEST).fresh, false);
    assert.equal(fs.readFileSync(path.join(root, "illustrations.sqlite")).includes(Buffer.from(REQUEST.prompt)), false);
  }));
  test("changed keys/actions and owner/app isolation fail without side effects", async () => fixture(async ({ open, worker }) => {
    let calls = 0; const s = open(), w = worker(s, async () => { calls++; return IMAGE; });
    const job = w.create(OWNER, KEY, REQUEST); await w.settleLocalWork();
    assert.throws(() => w.create(OWNER, KEY, { ...REQUEST, prompt: "different" }), errorCode("ILLUSTRATION_IDEMPOTENCY_CONFLICT"));
    assert.throws(() => w.create(OWNER, "another_key_000001", { ...REQUEST, prompt: "different" }), errorCode("ILLUSTRATION_IDEMPOTENCY_CONFLICT"));
    const artifact = w.status(OWNER, job.jobId).artifact.artifactId;
    for (const other of [{ ...OWNER, principalId: "principal_other_0001" }, { ...OWNER, appId: "app_other_00000001" }]) {
      for (const operation of [() => w.status(other, job.jobId), () => w.cancel(other, KEY, job.jobId), () => w.content(other, artifact)]) assert.throws(operation, errorCode("ILLUSTRATION_NOT_FOUND"));
    }
    assert.equal(calls, 1);
  }));
  test("two processes race one durable claim, no second dispatch permission", async () => fixture(async ({ root, open }) => {
    open().close();
    const [a, b] = await Promise.all([child(root, "claim"), child(root, "claim")]);
    assert.equal(Number(a.fresh) + Number(b.fresh), 1); assert.equal(a.job.jobId, b.job.jobId);
  }));
  test("crash before invocation and after actual submit remain unretryable on restart", async () => {
    await fixture(async ({ open, worker }) => {
      const s = open(), claim = s.claim(OWNER, KEY, REQUEST); s.close();
      let calls = 0; const w = worker(open(), async () => { calls++; return IMAGE; });
      assert.equal(w.create(OWNER, KEY, REQUEST).jobId, claim.job.jobId); await w.settleLocalWork(); assert.equal(calls, 0);
    });
    await fixture(async ({ root, open, worker }) => {
      open().close(); const job = await child(root, "crash");
      assert.equal(fs.readFileSync(path.join(root, "submission-proof"), "utf8"), "one");
      let calls = 0; const w = worker(open(), async () => { calls++; return IMAGE; });
      assert.equal(w.create(OWNER, KEY, REQUEST).jobId, job.jobId); await w.settleLocalWork(); assert.equal(calls, 0);
      const expired = Date.now() - 1000;
      editRecord(root, (r) => ({ ...r, startedAt: expired - PROFILE.timeoutMs, deadlineAt: expired }));
      assert.equal(w.status(OWNER, job.jobId).status, "recovery_required");
      assert.throws(() => w.create(OWNER, "new_action_key_0001", { ...REQUEST, actionId: "new_action_0000001" }), errorCode("ILLUSTRATION_CAPACITY"));
    });
  });
  test("crash after committed bytes but before public response replays exact artifact", async () => fixture(async ({ root, open, worker }) => {
    open().close(); const committed = await child(root, "completed-crash");
    let calls = 0; const w = worker(open(), async () => { calls++; return IMAGE; });
    assert.equal(canonical(w.create(OWNER, KEY, REQUEST)), canonical(committed));
    assert.deepEqual(w.content(OWNER, committed.artifact.artifactId).bytes, validateIllustrationPng(IMAGE).bytes);
    assert.equal(calls, 0);
  }));
  test("lost acknowledgement never retries and recovery blocks new paid work", async () => fixture(async ({ open, worker }) => {
    let calls = 0; const w = worker(open(), async () => { calls++; throw new Error("provider secret response"); });
    const j = w.create(OWNER, KEY, REQUEST); await w.settleLocalWork();
    assert.equal(w.status(OWNER, j.jobId).status, "recovery_required");
    w.create(OWNER, KEY, REQUEST); assert.equal(calls, 1);
    assert.equal(canonical(w.status(OWNER, j.jobId)).includes("secret"), false);
  }));
  test("cancel is durable/idempotent, abort is not remote cancellation, late bytes cannot publish", async () => fixture(async ({ open, worker }) => {
    const gate = deferred(), entered = deferred(); let signal;
    const s = open(), w = worker(s, async (_r, sig) => { signal = sig; entered.resolve(); return gate.promise; });
    const job = w.create(OWNER, KEY, REQUEST); await entered.promise;
    const cancelled = w.cancel(OWNER, "cancel_key_0000001", job.jobId);
    assert.equal(cancelled.status, "cancel_requested"); assert.equal(signal.aborted, true);
    await w.settleLocalWork(); gate.resolve(IMAGE); await Promise.resolve();
    const end = w.status(OWNER, job.jobId); assert.equal(end.status, "recovery_required"); assert.equal(end.artifact, null);
    assert.equal(w.cancel(OWNER, "cancel_key_0000001", job.jobId).status, "recovery_required");
    s.close(); assert.equal(open().status(OWNER, job.jobId).status, "recovery_required");
  }));
  test("foreign-process cancel suppresses publication even without local controller", async () => fixture(async ({ open, worker }) => {
    const gate = deferred(); const w = worker(open(), async () => gate.promise);
    const j = w.create(OWNER, KEY, REQUEST);
    open().cancel(OWNER, "cancel_key_0000001", j.jobId);
    gate.resolve(IMAGE); await w.settleLocalWork();
    assert.equal(w.status(OWNER, j.jobId).status, "recovery_required"); assert.equal(w.status(OWNER, j.jobId).artifact, null);
  }));
  test("malformed PNG produces bounded failed receipt, never fake artifact", async () => fixture(async ({ open, worker }) => {
    let calls = 0; const w = worker(open(), async () => { calls++; return Buffer.from("private error"); });
    const j = w.create(OWNER, KEY, REQUEST); await w.settleLocalWork();
    assert.equal(w.status(OWNER, j.jobId).status, "failed"); assert.equal(w.status(OWNER, j.jobId).artifact, null);
    w.create(OWNER, KEY, REQUEST); assert.equal(calls, 1);
  }));
  test("close aborts bounded local wait, no unhandled rejection or post-close work", async () => fixture(async ({ open, worker }) => {
    const unhandled = []; const listener = (e) => unhandled.push(e); process.on("unhandledRejection", listener);
    try {
      const w = worker(open(), async () => new Promise(() => {}));
      w.create(OWNER, KEY, REQUEST); const first = w.close(); assert.equal(w.close(), first); await first;
      assert.throws(() => w.create(OWNER, KEY, REQUEST), errorCode("ILLUSTRATION_WORKER_CLOSED"));
      await new Promise((r) => setImmediate(r)); assert.deepEqual(unhandled, []);
    } finally { process.removeListener("unhandledRejection", listener); }
  }));
  test("deadline bounds uncooperative transport and sinks a later rejection", async () => fixture(async ({ open, worker }) => {
    const original = globalThis.setTimeout, gate = deferred(), failures = [];
    const unhandled = (e) => failures.push(e); process.on("unhandledRejection", unhandled);
    globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === PROFILE.timeoutMs ? 10 : delay, ...args);
    try {
      const w = worker(open(), async () => gate.promise), j = w.create(OWNER, KEY, REQUEST);
      await w.settleLocalWork(); assert.equal(w.status(OWNER, j.jobId).status, "recovery_required");
      gate.reject(new Error("late provider failure")); await new Promise((r) => setImmediate(r)); assert.deepEqual(failures, []);
    } finally { globalThis.setTimeout = original; process.removeListener("unhandledRejection", unhandled); }
  }));
  test("wrong modes/symlinks/hardlinks and named root replacement reject", async () => {
    await fixture(async ({ root, open }) => { fs.chmodSync(root, 0o755); assert.throws(open); fs.chmodSync(root, 0o700); });
    await fixture(async ({ root, open }) => { open().close(); const p = path.join(root, "illustrations.sqlite"); fs.chmodSync(p, 0o644); assert.throws(open); fs.chmodSync(p, 0o600); fs.linkSync(p, p + ".link"); assert.throws(open); });
    await fixture(async ({ root, open }) => { open().close(); const p = path.join(root, "illustrations.sqlite"); fs.renameSync(p, p + ".real"); fs.symlinkSync(p + ".real", p); assert.throws(open); });
    await fixture(async ({ root, open }) => {
      const s = open(); fs.renameSync(root, root + "-moved"); fs.mkdirSync(root, { mode: 0o700 });
      try { assert.throws(() => s.claim(OWNER, KEY, REQUEST), errorCode("ILLUSTRATION_STORE_POISONED")); }
      finally { s.close(); fs.rmSync(root, { recursive: true }); fs.renameSync(root + "-moved", root); }
    });
    assert.throws(() => assertIllustrationStore(Object.freeze({})), errorCode("ILLUSTRATION_STORE_UNAVAILABLE"));
  });
  test("corruption/future schema/hash drift fail closed on restart and live reads", async () => fixture(async ({ root, open }) => {
    const s = open(); const j = s.claim(OWNER, KEY, REQUEST); s.close();
    const db = new (loadDatabaseSync())(path.join(root, "illustrations.sqlite"));
    db.prepare("UPDATE jobs SET integrity=?").run("0".repeat(64)); db.close(); assert.throws(open);
    const db2 = new (loadDatabaseSync())(path.join(root, "illustrations.sqlite"));
    const row = db2.prepare("SELECT record FROM jobs").get(); db2.prepare("UPDATE jobs SET integrity=?").run(digest(JSON.parse(row.record))); db2.close();
    const live = open(); editRecord(root, (r) => ({ ...r, schemaVersion: "future" }));
    assert.throws(() => live.status(OWNER, j.job.jobId), errorCode("ILLUSTRATION_STORE_POISONED")); assert.throws(open);
  }));
  test("response publication failure cannot grant another submit", async () => fixture(async ({ root, open, worker }) => {
    const gate = deferred(); const s = open(), w = worker(s, async () => gate.promise);
    const j = w.create(OWNER, KEY, REQUEST); fs.chmodSync(path.join(root, "illustrations.sqlite"), 0o644); gate.resolve(IMAGE);
    await assert.rejects(w.settleLocalWork(), errorCode("ILLUSTRATION_STORE_POISONED"));
    fs.chmodSync(path.join(root, "illustrations.sqlite"), 0o600); s.close();
    assert.equal(open().claim(OWNER, KEY, REQUEST).fresh, false); assert.equal(j.status, "submitting");
  }));
  test("bounded admission does not prune old action receipts into new submissions", async () => fixture(async ({ open }) => {
    const s = open(); let original;
    for (let i = 0; i < PROFILE.maxJobs; i++) {
      const r = { ...REQUEST, actionId: `action_capacity_${String(i).padStart(6, "0")}` };
      const claim = s.claim(OWNER, `key_capacity_${String(i).padStart(6, "0")}`, r);
      s.settle(OWNER, claim.job.jobId, validateIllustrationPng(IMAGE));
      if (i === 0) original = { r, jobId: claim.job.jobId };
    }
    assert.throws(() => s.claim(OWNER, KEY, REQUEST), errorCode("ILLUSTRATION_CAPACITY"));
    assert.equal(s.claim(OWNER, "key_capacity_000000", original.r).job.jobId, original.jobId);
  }));
  test("pinned inline transport sends once, no URLs, no ambient choice, no retry", async () => {
    let calls = 0;
    const t = createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000", fetchImpl: async (url, options) => {
      calls++; assert.equal(url, PROFILE.endpoint); assert.equal(options.redirect, "error");
      assert.deepEqual(JSON.parse(options.body), { model: PROFILE.model, prompt: REQUEST.prompt, width: 1024, height: 1024, format: "png", variants: 1, return_binary: false, safe_mode: true });
      return new Response(JSON.stringify({ images: [IMAGE.toString("base64")] }), { headers: { "content-type": "application/json" } });
    } });
    assert.deepEqual(await t.submit(REQUEST, new AbortController().signal), IMAGE); assert.equal(calls, 1);
    for (const response of [new Response("busy", { status: 429 }), new Response("oops", { status: 500 }), new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } }), new Response(JSON.stringify({ images: ["https://elsewhere/image.png"] }), { headers: { "content-type": "application/json" } }), new Response("{}", { headers: { "content-type": "application/json", "content-length": "999999999" } })]) {
      let attempts = 0; const bad = createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000", fetchImpl: async () => { attempts++; return response; } });
      await assert.rejects(bad.submit(REQUEST, new AbortController().signal), errorCode("ILLUSTRATION_RECOVERY_REQUIRED")); assert.equal(attempts, 1);
    }
  });
  test("transport streams are bounded without Content-Length and abort before send is zero-call", async () => {
    let cancelled = false, reads = 0;
    const body = new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const t = createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000", fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
    await assert.rejects(t.submit(REQUEST, new AbortController().signal), errorCode("ILLUSTRATION_RECOVERY_REQUIRED"));
    assert.equal(cancelled, true); assert.ok(reads <= 13);
    let calls = 0;
    const aborted = createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000", fetchImpl: async () => { calls++; throw new Error(); } });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(aborted.submit(REQUEST, controller.signal)); assert.equal(calls, 0);
  });
  test("early response rejection aborts transport and cancels unread bodies without waiting forever", { timeout: 2000 }, async () => {
    for (const variant of ["status", "type", "length"]) {
      let cancelled = false, signal, calls = 0;
      const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
      const t = createVeniceIllustrationTransport({ apiKey: "synthetic_provider_key_000", fetchImpl: async (_url, options) => {
        signal = options.signal; calls++;
        return new Response(stream, { status: variant === "status" ? 503 : 200, headers: { "content-type": variant === "type" ? "text/html" : "application/json", ...(variant === "length" ? { "content-length": "999999999" } : {}) } });
      } });
      await assert.rejects(t.submit(REQUEST, new AbortController().signal), errorCode("ILLUSTRATION_RECOVERY_REQUIRED"));
      assert.equal(signal.aborted, true); assert.equal(cancelled, true); assert.equal(calls, 1);
    }
  });
  test("authenticated exact RPC remains disabled; owned bytes/private headers work", async () => fixture(async ({ open, worker }) => {
    const w = worker(open(), async () => IMAGE), token = "synthetic_bff_token_00000000000000001";
    const rpc = createIllustrationRpc({ worker: w, clients: [{ appId: OWNER.appId, token, trustedPrincipalProxy: true }] });
    const invoke = (action, body, extra = {}) => rpc({ method: "POST", originalPath: `/illustration/v1${action}`, rawHeaders: ["Authorization", `Bearer ${token}`, "x-aginti-principal-id", OWNER.principalId, "Content-Type", "application/json", ...(["/jobs/create", "/jobs/cancel"].includes(action) ? ["Idempotency-Key", KEY] : [])], body: Buffer.from(canonical(body)), ...extra });
    assert.equal(JSON.parse((await invoke("/capabilities", {})).body).enabled, false);
    assert.equal((await invoke("/jobs/create", REQUEST)).status, 503);
    const job = w.create(OWNER, KEY, REQUEST); await w.settleLocalWork(); const artifactId = w.status(OWNER, job.jobId).artifact.artifactId;
    const content = await invoke("/artifacts/content", { artifactId }); assert.equal(content.status, 200); assert.deepEqual(content.body, validateIllustrationPng(IMAGE).bytes); assert.equal(content.headers["Cache-Control"], "private, no-store");
    for (const originalPath of ["/illustration/v1/capabilities?x=1", "/illustration/v1//capabilities", "/illustration/v1/%63apabilities", "/illustration/v1/capabilities/"]) assert.equal((await invoke("/capabilities", {}, { originalPath })).status, 404);
    assert.equal((await invoke("/capabilities", {}, { body: Buffer.from([0xff]) })).status, 400);
    assert.equal((await invoke("/capabilities", {}, { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]) })).status, 400);
    assert.equal((await invoke("/capabilities", { "": true })).status, 400);
    assert.equal((await invoke("/capabilities", {}, { body: Buffer.from('{"a":1,"a":2}') })).status, 400);
    assert.equal((await invoke("/jobs/status", { jobId: job.jobId, path: "/secret" })).status, 400);
    for (const rawHeaders of [["Authorization", `Bearer ${token}`, "authorization", `Bearer ${token}`], ["Authorization", `Bearer ${token}`, "x-lazyedge-principal-id", OWNER.principalId], ["Authorization", `Bearer ${token}`, "Content-Encoding", "gzip"], ["Authorization", "Bearer wrong"]]) assert.ok((await invoke("/capabilities", {}, { rawHeaders })).status >= 400);
    assert.throws(() => createIllustrationRpc({ worker: w, clients: [{ appId: OWNER.appId, token, trustedPrincipalProxy: false }] }));
    assert.throws(() => createIllustrationRpc({ worker: w, clients: [{ appId: OWNER.appId, token: token + "\n", trustedPrincipalProxy: true }] }));
    assert.throws(() => createIllustrationRpc({ worker: w, clients: [{ appId: OWNER.appId, token, trustedPrincipalProxy: true }, { appId: "app_other_00000001", token, trustedPrincipalProxy: true }] }));
    let traps = 0;
    assert.throws(() => createIllustrationRpc({ worker: new Proxy({}, { get() { traps++; } }), clients: [] }), errorCode("ILLUSTRATION_WORKER_UNAVAILABLE"));
    assert.throws(() => createIllustrationRpc({ worker: Object.freeze({ status: () => ({ raw: "private" }) }), clients: [] }), errorCode("ILLUSTRATION_WORKER_UNAVAILABLE"));
    assert.equal(traps, 0);
    assert.equal(PROFILE_DIGEST.length, 64);
  }));
  test("repeated open/close leaves no owned descriptors, timeouts or temporary roots", async () => {
    const roots = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("aginti-illustration-smoke-")).sort();
    const fds = () => fs.readdirSync("/proc/self/fd").length;
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const beforeRoots = roots(), beforeFds = fds(), beforeTimers = timers();
    for (let i = 0; i < 5; i++) await fixture(async ({ open, worker }) => {
      const w = worker(open(), async () => IMAGE); w.create(OWNER, KEY, REQUEST); await w.settleLocalWork();
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(roots(), beforeRoots); assert.equal(fds(), beforeFds); assert.equal(timers(), beforeTimers);
  });
}
