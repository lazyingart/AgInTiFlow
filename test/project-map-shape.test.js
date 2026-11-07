import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { refreshCodebaseMap, readCodebaseMap, codebaseMapToContextPack } from "../src/codebase-map.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-project-map-shape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), cache = path.join(workspace, ".aginti/codebase-map.json");
  await fs.mkdir(workspace); await fs.mkdir(path.join(root, "no-commands"));
  await fs.mkdir(path.join(workspace, "src")); await fs.mkdir(path.join(workspace, "test"));
  await fs.writeFile(path.join(workspace, "src/main.py"), "def double(n):\n    return n * 2\n");
  await fs.writeFile(path.join(workspace, "test/test_main.py"), "# Synthetic test metadata.\n");
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const config = { commandCwd: workspace, baseDir: workspace, allowFileTools: true, sandboxMode: "host", workspaceWritePolicy: "block" };
  const result = await refreshCodebaseMap(config); assert.equal(result.ok, true);
  return { root, workspace, cache, config, map: result.map };
}
function rewriteFingerprint(map) {
  const i = map.inspection;
  map.fingerprint = createHash("sha256").update(JSON.stringify({ summary: i.summary, counts: i.counts,
    manifests: i.manifestFiles.map(x => x.path), sourceDirs: i.sourceDirs.map(x => x.path), tests: i.testFiles.map(x => x.path),
    packageScripts: i.packageScripts, languages: i.languageCounts })).digest("hex").slice(0, 16);
}
const changes = [
  ["null", () => null], ["array", () => []], ["string", () => "not a map"], ["number", () => 1], ["boolean", () => true],
  ["missing version", m => { delete m.version; }], ["future version", m => { m.version = 2; }], ["string version", m => { m.version = "1"; }],
  ["invalid timestamp", m => { m.generatedAt = "not a date"; }], ["noncanonical timestamp", m => { m.generatedAt = "2026-11-07"; }],
  ["object fingerprint", m => { m.fingerprint = {}; }], ["hash drift", m => { m.fingerprint = "0".repeat(16); }],
  ["foreign root", (m,f) => { m.projectRoot = f.root; }], ["foreign cwd", (m,f) => { m.commandCwd = f.root; }],
  ["relative root", m => { m.projectRoot = "."; }], ["noncanonical root", m => { m.projectRoot += "/."; }],
  ["unknown root field", m => { m.provider = "untrusted-model-route"; }],
  ["null inspection", m => { m.inspection = null; }], ["array inspection", m => { m.inspection = []; }],
  ["wrong summary", m => { m.inspection.summary = ["not public text"]; rewriteFingerprint(m); }],
  ["empty summary", m => { m.inspection.summary = "  "; rewriteFingerprint(m); }],
  ["wrong counts", m => { m.inspection.counts.files = "5"; rewriteFingerprint(m); }],
  ["negative count", m => { m.inspection.counts.files = -1; rewriteFingerprint(m); }],
  ["fractional count", m => { m.inspection.counts.files = 1.5; rewriteFingerprint(m); }],
  ["unknown counts field", m => { m.inspection.counts.raw = "no"; rewriteFingerprint(m); }],
  ["nonboolean truncation", m => { m.inspection.truncated = "false"; }],
  ["null top entry", m => { m.inspection.topLevel = [null]; }],
  ["wrong top kind", m => { m.inspection.topLevel = [{ path: "main.py", type: "socket", size: 1 }]; }],
  ["absolute top path", m => { m.inspection.topLevel = [{ path: "/outside/main.py", type: "file", size: 1 }]; }],
  ["parent top path", m => { m.inspection.topLevel = [{ path: "../main.py", type: "file", size: 1 }]; }],
  ["oversized top array", m => { m.inspection.topLevel = Array.from({ length: 81 }, () => ({ path: "a.py", type: "file", size: 1 })); }],
  ["bad manifest date", m => { m.inspection.manifestFiles[0].modifiedAt = "yesterday"; }],
  ["bad source kind", m => { m.inspection.sourceDirs[0].kind = "host-shell"; }],
  ["bad test size", m => { m.inspection.testFiles[0].size = "1"; }],
  ["bad package manager", m => { m.inspection.packageManagers = [{}]; }],
  ["null script entry", m => { m.inspection.packageScripts = [null]; }],
  ["nontext command", m => { m.inspection.packageScripts[0].command = {}; rewriteFingerprint(m); }],
  ["noninteger language count", m => { m.inspection.languageCounts[0].count = "1"; rewriteFingerprint(m); }],
  ["null git", m => { m.inspection.git = null; }],
  ["nonboolean git flag", m => { m.inspection.git.present = "false"; }],
  ["nonarray git commands", m => { m.inspection.git.recommendedCommands = "git status"; }],
  ["nontext git workflow", m => { m.inspection.git.workflow = []; }],
  ["nontext recommendation", m => { m.inspection.recommendedReads = [{}]; }],
  ["nontext hint", m => { m.inspection.engineeringHints = [{}]; }],
  ["unknown inspection field", m => { m.inspection.rawToolOutput = "not public"; }],
  ["prototype key", m => { Object.defineProperty(m.inspection, "__proto__", { enumerable: true, value: { unsafe: true } }); }],
];
for (const [name, mutate] of changes) test("cache rejects " + name + " without changing bytes or leaking input", async t => {
  const f = await fixture(t), clone = structuredClone(f.map), changed = mutate(clone, f);
  const value = changed === undefined ? clone : changed, bytes = JSON.stringify(value);
  await fs.writeFile(f.cache, bytes);
  const result = await readCodebaseMap(f.workspace);
  assert.equal(result.ok, false); assert.equal(result.reason, "invalid-map"); assert.equal("map" in result, false);
  assert.equal(await fs.readFile(f.cache, "utf8"), bytes);
  assert.equal(codebaseMapToContextPack(value), "Context pack: no durable codebase map available.");
});

test("producer version1 round trips; reordered JSON is not corruption", async t => {
  const f = await fixture(t), ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().reverse().map(k => [k, ordered(value[k])])) : value;
  await fs.writeFile(f.cache, JSON.stringify(ordered(f.map), null, 2));
  const result = await readCodebaseMap(f.workspace); assert.equal(result.ok, true); assert.deepEqual(result.map, f.map);
  assert.match(codebaseMapToContextPack(result.map), /src\/main|Source dirs: src/);
});

test("metadata stays multilingual and preserves the generated schema", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.workspace, "普通工程😀.js"), "// 合法的源文件\n");
  const result = await refreshCodebaseMap(f.config); assert.equal(result.ok, true);
  assert.ok(result.map.inspection.topLevel.some(e => e.path === "普通工程😀.js"));
  assert.equal((await readCodebaseMap(f.workspace)).ok, true);
  assert.match(codebaseMapToContextPack(result.map), /普通工程😀/);
});

test("a transplanted map cannot choose a different selected root or trigger lookups there", async t => {
  const f = await fixture(t), value = { ...f.map, projectRoot: f.root, commandCwd: f.root };
  const bytes = JSON.stringify(value); await fs.writeFile(f.cache, bytes);
  let declaredRootLookups = 0; const original = fs.realpath;
  t.mock.method(fs, "realpath", async (...args) => { if (args[0] === f.root) declaredRootLookups++; return Reflect.apply(original, fs, args); });
  const loaded = await readCodebaseMap(f.workspace);
  assert.equal(loaded.ok, false); assert.equal(loaded.reason, "invalid-map"); assert.equal(declaredRootLookups, 0);
  assert.equal(await fs.readFile(f.cache, "utf8"), bytes);
});

test("changing the selected logical root invalidates only the overview until refresh", async t => {
  const f = await fixture(t), alias = path.join(f.root, "selected-alias"); await fs.symlink(f.workspace, alias);
  assert.equal((await readCodebaseMap(alias)).ok, false);
  const result = await refreshCodebaseMap({ ...f.config, commandCwd: alias, baseDir: alias });
  assert.equal(result.ok, true); assert.equal((await readCodebaseMap(alias)).ok, true);
  assert.equal((await readCodebaseMap(f.workspace)).ok, false);
  await refreshCodebaseMap(f.config); assert.equal((await readCodebaseMap(f.workspace)).ok, true);
});

test("released version1 fingerprint vector remains readable", async t => {
  const f = await fixture(t);
  // Captured from the released379 producer's synthetic Python-only project.
  // Roots are labels outside that legacy digest and are bound independently.
  const map = { version: 1, generatedAt: "2026-11-07T02:16:06.649Z", projectRoot: f.workspace, commandCwd: f.workspace,
    fingerprint: "9247d9aec326609e", inspection: { summary: "1 files, 1 directories, python:1", counts: { files: 1, directories: 1, totalBytes: 32 }, truncated: false,
      topLevel: [{ path: "main.py", type: "file", size: 32 }], manifestFiles: [], sourceDirs: [], testFiles: [], packageManagers: [], packageScripts: [],
      languageCounts: [{ name: "python", count: 1 }], git: { present: false, recommendedCommands: [], workflow: "" }, recommendedReads: [], engineeringHints: [] } };
  await fs.writeFile(f.cache, JSON.stringify(map));
  const loaded = await readCodebaseMap(f.workspace); assert.equal(loaded.ok, true); assert.deepEqual(loaded.map, map);
});

test("an uncommon but supported empty extension label does not invalidate produced metadata", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.workspace, "ends-in-dot."), "data\n");
  const result = await refreshCodebaseMap(f.config); assert.equal(result.ok, true);
  assert.ok(result.map.inspection.languageCounts.some(x => x.name === "")); assert.equal((await readCodebaseMap(f.workspace)).ok, true);
});

test("invalid JSON reason does not echo cache content", async t => {
  const f = await fixture(t); await fs.writeFile(f.cache, "synthetic-sensitive-cache-body");
  const result = await readCodebaseMap(f.workspace); assert.equal(result.ok, false); assert.equal(result.reason, "invalid-map");
  assert.equal(JSON.stringify(result).includes("sensitive-cache-body"), false);
});

for (const kind of ["proxy", "accessor", "hidden", "symbol", "custom-prototype", "sparse-array", "array-accessor", "array-iterator", "nested-proxy", "toJSON", "boxed-number", "array-constructor"]) {
  test("formatter rejects " + kind + " without invoking caller hooks", async t => {
    const f = await fixture(t); let traps = 0, value = structuredClone(f.map);
    const hook = () => { traps++; throw Error("untrusted hook"); };
    if (kind === "proxy") value = new Proxy(value, { get: hook, getPrototypeOf: hook, ownKeys: hook });
    if (kind === "accessor") Object.defineProperty(value, "inspection", { enumerable: true, get: hook });
    if (kind === "hidden") Object.defineProperty(value, "inspection", { enumerable: false, value: value.inspection });
    if (kind === "symbol") value[Symbol("extra")] = 1;
    if (kind === "custom-prototype") Object.setPrototypeOf(value, Object.defineProperty({}, "then", { get: hook }));
    if (kind === "sparse-array") value.inspection.topLevel = new Array(2);
    if (kind === "array-accessor") Object.defineProperty(value.inspection.topLevel, "0", { enumerable: true, get: hook });
    if (kind === "array-iterator") Object.defineProperty(value.inspection.topLevel, Symbol.iterator, { value: hook });
    if (kind === "nested-proxy") value.inspection.counts = new Proxy(value.inspection.counts, { get: hook, getPrototypeOf: hook, ownKeys: hook });
    if (kind === "toJSON") Object.defineProperty(value.inspection.counts, "toJSON", { value: hook });
    if (kind === "boxed-number") value.inspection.counts.files = Object.defineProperty(new Number(1), "valueOf", { get: hook });
    if (kind === "array-constructor") Object.defineProperty(value.inspection.topLevel, "constructor", { get: hook });
    assert.equal(codebaseMapToContextPack(value), "Context pack: no durable codebase map available."); assert.equal(traps, 0);
  });
}

test("actual CLI retains typed available metadata for a supported map", { timeout: 20000 }, async t => {
  const f = await fixture(t), result = spawnSync(process.execPath, ["--import", "data:text/javascript,globalThis.fetch%3D()%3D%3E%7Bthrow%20Error('No%20HTTP%20allowed')%7D",
    path.join(import.meta.dirname, "../bin/aginti-cli.js"), "capabilities", "--json", "--provider", "mock"], {
    cwd: f.workspace, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: path.join(f.root, "no-commands"), HOME: path.join(f.root, "home"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(f.root, "home/agent"),
      AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGENT_PROVIDER: "mock", AGENT_SANDBOX_MODE: "host" },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const map = JSON.parse(result.stdout).project.codebaseMap; assert.equal(map.present, true);
  assert.equal(map.fingerprint, f.map.fingerprint); assert.equal(map.summary, f.map.inspection.summary);
});

for (const value of [null, [], { version: 999, inspection: { summary: ["not text"] } }]) {
  test("actual CLI discovery survives invalid optional cache " + JSON.stringify(value), { timeout: 20000 }, async t => {
    const f = await fixture(t), bytes = JSON.stringify(value); await fs.writeFile(f.cache, bytes);
    const result = spawnSync(process.execPath, ["--import", "data:text/javascript,globalThis.fetch%3D()%3D%3E%7Bthrow%20Error('No%20HTTP%20allowed')%7D",
      path.join(import.meta.dirname, "../bin/aginti-cli.js"), "capabilities", "--json", "--provider", "mock"], {
      cwd: f.workspace, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: path.join(f.root, "no-commands"), HOME: path.join(f.root, "home"), LANG: "C.UTF-8", AGINTIFLOW_HOME: path.join(f.root, "home/agent"),
        AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGENT_PROVIDER: "mock", AGENT_SANDBOX_MODE: "host" },
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout), map = report.project.codebaseMap;
    assert.equal(map.present, false); for (const field of ["generatedAt", "fingerprint", "summary"]) assert.equal(map[field], "");
    assert.ok(report.checks.some(c => c.name === "node" && c.ok === false));
    assert.equal(await fs.readFile(f.cache, "utf8"), bytes);
  });
}
