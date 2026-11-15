import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { compactArtifactValidationContext, artifactValidationContextIsEmbedded, repairModelMessageHistory } from "../src/agent-runner.js";

const marker = "EXCLUDED_SYNTHETIC_ARTIFACT_CANARY_TEAL";
const original = "Project status: ready for the next local check.\n";
async function fixture(t, content = original) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-artifact-context-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = path.join(root, "workspace"), outside = path.join(root, "excluded");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  const source = path.join(workspace, "report.md");
  await fs.writeFile(source, content);
  const goal = "Create report.md with a short project status note. Leave unrelated files alone.";
  const config = { goal, provider: "deepseek", model: "deepseek-flash", commandCwd: workspace, baseDir: workspace,
    sandboxMode: "host", allowDestructive: false, allowFileTools: true, readOnlyRoots: [] };
  const state = { goal, commandCwd: workspace, messages: [{ role: "system", content: "Follow the task and current permission." },
    { role: "user", content: goal }], meta: { artifactProgress: { exactOutputPaths: ["report.md"], complete: true } } };
  return { root, workspace, outside, source, config, state };
}
const compact = f => compactArtifactValidationContext(f.state, f.config, "Deterministic artifact preflight: keep the verification gates.");
const packet = f => f.state.messages.find(m => m.content?.startsWith("Bounded artifact validation context v1.")).content;
const sourcePart = f => packet(f).split("\n\n").slice(2).join("\n\n");
function notExact(f) { assert.equal(f.state.meta.artifactProgress.outputEmbedded, false); assert.equal(artifactValidationContextIsEmbedded(f.state), false); }

test("ordinary complete artifact is exact current context and source is unchanged", async t => {
  const f = await fixture(t); assert.equal(await compact(f), true);
  assert.ok(packet(f).includes(original)); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, ["report.md"]);
  assert.equal(artifactValidationContextIsEmbedded(f.state), true); assert.equal(await fs.readFile(f.source, "utf8"), original);
});
test("BOM CJK Japanese leading whitespace and CRLF remain exact", async t => {
  const text = "\ufeff\r\n  状态：保留原文。 日本語の確認。\r\n";
  const f = await fixture(t, text); await compact(f); assert.ok(packet(f).includes(text)); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
test("an intentional empty artifact is a full zero-byte snapshot", async t => {
  const f = await fixture(t, ""); await compact(f); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, ["report.md"]);
  assert.equal(artifactValidationContextIsEmbedded(f.state), true); assert.equal((await fs.stat(f.source)).size, 0);
});
test("ordinary small OpenAI context performs no compaction or source operation", async t => {
  const f = await fixture(t); f.config.provider = "openai"; const before = JSON.stringify(f.state);
  t.mock.method(fs, "open", () => { throw Error("unexpected open"); });
  try { assert.equal(await compact(f), false); assert.equal(JSON.stringify(f.state), before); } finally { t.mock.restoreAll(); }
});
test("large OpenAI history uses the same authorized projection", async t => {
  const f = await fixture(t); f.config.provider = "openai"; f.state.messages.push({ role: "assistant", content: "x".repeat(160001) });
  await compact(f); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
test("file-tool revocation performs no source operation and clears old embedding claims", async t => {
  const f = await fixture(t); await compact(f); f.config.allowFileTools = false;
  let calls = 0;
  for (const name of ["open", "readFile", "stat", "realpath"]) t.mock.method(fs, name, () => { calls++; throw Error("unexpected revoked source operation"); });
  try { await compact(f); assert.equal(calls, 0); notExact(f); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, []); assert.ok(!packet(f).includes(original)); }
  finally { t.mock.restoreAll(); }
});
for (const kind of ["outside", "env", "git"]) test(`artifact context rejects a ${kind} alias`, async t => {
  const f = await fixture(t);
  const target = kind === "outside" ? path.join(f.outside, "data.txt") : path.join(f.workspace, kind === "env" ? ".env" : ".git/config");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, marker);
  await fs.unlink(f.source); await fs.symlink(target, f.source); await compact(f);
  assert.ok(!JSON.stringify(f.state).includes(marker)); notExact(f); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, []);
});
test("an alias to another unselected workspace subtree is denied", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.workspace, "allowed")); await fs.rename(f.source, path.join(f.workspace, "allowed/report.md"));
  f.state.meta.artifactProgress.exactOutputPaths = ["allowed/report.md"]; f.config.workspacePathScopeRoots = ["allowed"];
  await fs.writeFile(f.source, marker); await fs.unlink(path.join(f.workspace, "allowed/report.md"));
  await fs.symlink(f.source, path.join(f.workspace, "allowed/report.md")); await compact(f); notExact(f); assert.ok(!JSON.stringify(f.state).includes(marker));
});
test("an explicitly selected external file remains readable without widening its root", async t => {
  const f = await fixture(t); const target = path.join(f.outside, "selected.md"); await fs.writeFile(target, original);
  f.config.readOnlyRoots = [target]; f.state.meta.artifactProgress.exactOutputPaths = [target]; await compact(f);
  assert.equal(artifactValidationContextIsEmbedded(f.state), true); assert.deepEqual(f.config.readOnlyRoots, [target]);
});
test("an explicitly selected workspace root alias retains its canonical scope", async t => {
  const f = await fixture(t); const alias = path.join(f.root, "workspace-alias"); await fs.symlink(f.workspace, alias);
  f.config.commandCwd = alias; await compact(f); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
test("a formerly selected external file cannot be re-embedded after revocation", async t => {
  const f = await fixture(t); const target = path.join(f.outside, "selected.md"); await fs.writeFile(target, original);
  f.config.readOnlyRoots = [target]; f.state.meta.artifactProgress.exactOutputPaths = [target]; await compact(f);
  f.config.readOnlyRoots = []; await compact(f); notExact(f); assert.ok(!packet(f).includes(original));
});
for (const bytes of [Buffer.from([0xff, 0x61]), Buffer.from("source\0binary")]) test(`malformed artifact bytes are not model text (${bytes.toString("hex")})`, async t => {
  const f = await fixture(t, bytes); await compact(f); notExact(f); assert.ok(!packet(f).includes("\ufffd")); assert.ok(!packet(f).includes("\0"));
});
for (const size of [128000, 128001]) test(`source read observes its ${size}-byte boundary without full-context claims`, async t => {
  const f = await fixture(t, "a".repeat(size)); let requested = 0;
  const open = fs.open; t.mock.method(fs, "open", async (...args) => {
    const h = await Reflect.apply(open, fs, args); const read = h.read.bind(h); h.read = (...values) => { requested += Number(values[2] || 0); return read(...values); }; return h;
  });
  try { await compact(f); notExact(f); assert.ok(requested <= 128001); assert.ok(Buffer.byteLength(sourcePart(f)) <= 18000); if (size === 128001) assert.equal(requested, 0); }
  finally { t.mock.restoreAll(); }
});
for (const kind of ["growth", "replacement", "EIO"]) test(`a live ${kind} discards the snapshot and closes its handle once`, async t => {
  const f = await fixture(t); const open = fs.open; let closed = 0, injected = false;
  t.mock.method(fs, "open", async (...args) => {
    const h = await Reflect.apply(open, fs, args), read = h.read.bind(h), close = h.close.bind(h);
    h.close = async () => { closed++; return close(); };
    h.read = async (...values) => {
      const result = await read(...values);
      if (!injected) { injected = true;
        if (kind === "growth") await fs.appendFile(f.source, "grown");
        else if (kind === "replacement") { await fs.rename(f.source, f.source + ".old"); await fs.writeFile(f.source, marker); }
        else throw Object.assign(Error("read fault"), { code: "EIO" });
      }
      return result;
    }; return h;
  });
  try { await compact(f); assert.equal(closed, 1); notExact(f); assert.ok(!packet(f).includes(original)); assert.ok(!packet(f).includes(marker)); }
  finally { t.mock.restoreAll(); }
});
test("secret redaction never grants exact mutation authority", async t => {
  const token = "sk-" + "a".repeat(44); const f = await fixture(t, 'api_key = "' + token + '"\n');
  await compact(f); notExact(f); assert.ok(!JSON.stringify(f.state.messages).includes(token)); assert.match(packet(f), /Excerpt output/);
});
test("a literal already-redacted artifact can remain an exact snapshot", async t => {
  const f = await fixture(t, "credential_status=[REDACTED]\n"); await compact(f); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
test("multibyte excerpts fit the real UTF-8 bound without replacement characters", async t => {
  const f = await fixture(t, "状態😀".repeat(7000)); await compact(f); notExact(f);
  assert.ok(Buffer.byteLength(sourcePart(f)) <= 18000); assert.ok(!packet(f).includes("\ufffd")); assert.match(packet(f), /not complete exact patch context/);
});
test("aggregate clipping cannot mark an omitted or partial output fully embedded", async t => {
  const f = await fixture(t, "a".repeat(9000)); await fs.writeFile(path.join(f.workspace, "second.md"), "b".repeat(9000)); await fs.writeFile(path.join(f.workspace, "third.md"), "c".repeat(9000));
  f.state.meta.artifactProgress.exactOutputPaths = ["report.md", "second.md", "third.md"]; await compact(f); notExact(f);
  assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, ["report.md"]); assert.ok(Buffer.byteLength(sourcePart(f)) <= 18000);
});
test("at most sixteen files are opened for one context packet", async t => {
  const f = await fixture(t); const files = Array.from({ length: 20 }, (_, i) => "item-" + i + ".md");
  for (const name of files) await fs.writeFile(path.join(f.workspace, name), "brief\n");
  f.state.meta.artifactProgress.exactOutputPaths = files; let opens = 0; const open = fs.open;
  t.mock.method(fs, "open", (...args) => { opens++; return Reflect.apply(open, fs, args); });
  try { await compact(f); assert.equal(opens, 16); notExact(f); } finally { t.mock.restoreAll(); }
});
test("canonical aliases do not duplicate artifact reads or invent complete coverage", async t => {
  const f = await fixture(t); await fs.symlink(f.source, path.join(f.workspace, "alias.md")); f.state.meta.artifactProgress.exactOutputPaths.push("alias.md");
  let opens = 0; const open = fs.open; t.mock.method(fs, "open", (...args) => { opens++; return Reflect.apply(open, fs, args); });
  try { await compact(f); assert.equal(opens, 1); notExact(f); } finally { t.mock.restoreAll(); }
});
test("opaque binaries are never opened or presented as text", async t => {
  const f = await fixture(t); for (const ext of ["pdf", "png", "sqlite", "zip"]) {
    let opens = 0;
    f.state.meta.artifactProgress.exactOutputPaths = ["file." + ext]; t.mock.method(fs, "open", () => { opens++; throw Error("binary opened"); });
    try { await compact(f); assert.equal(opens, 0); notExact(f); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, []); } finally { t.mock.restoreAll(); }
  }
});
test("oversized output names do not gain a read or exact snapshot claim", async t => {
  const f = await fixture(t); f.state.meta.artifactProgress.exactOutputPaths = ["a".repeat(5000)]; await compact(f); notExact(f); assert.ok(Buffer.byteLength(sourcePart(f)) < 1000);
});
test("all synthesized goal/history/instruction text stays redacted", async t => {
  const f = await fixture(t), token = "sk-" + "b".repeat(44);
  f.config.goal = 'Create report.md. api_key="' + token + '"'; f.state.messages[0].content += ' api_key="' + token + '"'; f.state.messages[1].content += ' api_key="' + token + '"';
  await compactArtifactValidationContext(f.state, f.config, 'Verify safely. api_key="' + token + '"'); assert.ok(!JSON.stringify(f.state.messages).includes(token));
});
test("a prior automatic packet is not recycled as recent user context", async t => {
  const f = await fixture(t); f.state.messages.push({ role: "user", content: "The exact output content is embedded below.\n" + marker });
  f.state.messages.push({ role: "user", content: "Deterministic artifact preflight accepts this." });
  await compact(f); assert.ok(!JSON.stringify(f.state.messages).includes(marker)); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
for (const reason of ["absent", "changed", "wrong-path", "wrong-version"]) test(`embedded metadata cannot override ${reason} packet evidence`, async t => {
  const f = await fixture(t); await compact(f);
  if (reason === "absent") f.state.messages = [];
  if (reason === "changed") f.state.messages.find(m => m.content.startsWith("Bounded artifact")).content += "changed";
  if (reason === "wrong-path") f.state.meta.artifactProgress.embeddedOutputPaths = ["other.md"];
  if (reason === "wrong-version") f.state.meta.artifactProgress.contextVersion = 999;
  assert.equal(artifactValidationContextIsEmbedded(f.state), false);
});
for (const kind of ["legacy", "resume", "revoked", "future"]) test(`restart repair retires ${kind} automatic artifact authority`, async t => {
  const f = await fixture(t); await compact(f);
  if (kind === "legacy") { f.state.meta.artifactProgress.contextVersion = undefined; f.state.messages = [{ role: "user", content: "The exact output content is embedded below.\n" + marker }]; }
  if (kind === "resume") f.config.resume = "persisted-session";
  if (kind === "revoked") f.config.allowFileTools = false;
  if (kind === "future") f.state.messages.find(m => m.content.startsWith("Bounded artifact")).content = "Bounded artifact validation context v999.\n" + marker;
  const result = repairModelMessageHistory(f.state, f.config); assert.equal(result.changed, true);
  assert.ok(!JSON.stringify(f.state.messages).includes(marker)); notExact(f); assert.deepEqual(f.state.meta.artifactProgress.embeddedOutputPaths, []);
});
test("a current unchanged packet survives same-invocation history repair", async t => {
  const f = await fixture(t); await compact(f); repairModelMessageHistory(f.state, f.config); assert.equal(artifactValidationContextIsEmbedded(f.state), true);
});
test("a genuine user quote of the old packet header is preserved as user data", async t => {
  const f = await fixture(t); const text = "The exact output content is embedded below. Explain what that means.";
  f.config.goal = text; f.state.goal = text; f.state.chat = [{ role: "user", content: text }]; f.state.messages = [{ role: "user", content: text }];
  repairModelMessageHistory(f.state, f.config); assert.equal(f.state.messages[0].content, text);
});
test("changing both output path lists cannot retain another artifact packet authority", async t => {
  const f = await fixture(t); await compact(f);
  f.state.meta.artifactProgress.exactOutputPaths = ["other.md"];
  f.state.meta.artifactProgress.embeddedOutputPaths = ["other.md"];
  assert.equal(artifactValidationContextIsEmbedded(f.state), false);
});
test("a previous goal's packet is not authority for a later goal revision", async t => {
  const f = await fixture(t); f.state.meta.goalContract = { revision: 1 }; await compact(f);
  f.state.meta.goalContract.revision = 2;
  assert.equal(artifactValidationContextIsEmbedded(f.state), false);
});
test("a clipped output name cannot be advertised as complete exact context", async t => {
  const f = await fixture(t); const nested = Array(6).fill("a".repeat(100)).join("/");
  await fs.mkdir(path.join(f.workspace, nested), { recursive: true });
  const name = nested + "/note.md"; await fs.writeFile(path.join(f.workspace, name), original);
  f.state.meta.artifactProgress.exactOutputPaths = [name]; await compact(f);
  notExact(f); assert.match(packet(f), /Excerpt output/);
});
test("a real FIFO is rejected before blocking for a writer", { timeout: 15000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX FIFOs are unavailable");
  const f = await fixture(t); await fs.unlink(f.source);
  const fifo = spawnSync("mkfifo", [f.source], { timeout: 5000 });
  assert.equal(fifo.status, 0, "The POSIX filesystem smoke needs mkfifo");
  const moduleUrl = new URL("../src/workspace-tools.js", import.meta.url).href;
  const code = 'import { resolveWorkspaceReadTarget } from ' + JSON.stringify(moduleUrl) + ';' +
    'try { const t=await resolveWorkspaceReadTarget({commandCwd:process.argv[1],allowFileTools:true},"report.md");' +
    'await t.readBytes(128000); process.exitCode=2; } catch(e) { if(!/regular file/.test(e.message)) throw e; console.log("FIFO_REJECTED"); }';
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.workspace], {
    cwd: f.workspace, env: { PATH: process.env.PATH, HOME: f.root, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(timedOut, false, "A FIFO must not strand an automatic reader");
  assert.equal(result.signal, null); assert.equal(result.code, 0, stderr); assert.match(stdout, /FIFO_REJECTED/);
});
