import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { buildFailedTestRecoveryPacket, repairModelMessageHistory, failedTestExternalDiagnosticReadPaths, nextStepRuntimeConfig } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { executeWorkspaceTool } = await import(pathToFileURL(path.join(runtime, "src/workspace-tools.js")));
const marker = "EXCLUDED_SYNTHETIC_RECOVERY_VIOLET";
const sourceText = "def compute(value):\n    return value + 1\n";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-recovery-source-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = path.join(root, "workspace"), outside = path.join(root, "excluded");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  const source = path.join(workspace, "module.py"); await fs.writeFile(source, sourceText);
  const config = { commandCwd: workspace, baseDir: workspace, sandboxMode: "host", allowFileTools: true, allowDestructive: false,
    readOnlyRoots: [], goal: "Tests failed. Find the cause in module.py, fix it and leave unrelated files alone.", taskProfile: "code" };
  const state = { commandCwd: workspace, goal: config.goal, meta: { projectVerification: { mutationRevision: 1,
    lastMutation: { revision: 1, paths: ["module.py"] }, discoveredTests: [], testRuns: [{
      command: "python3 -m unittest discover -s tests -v", mutationRevision: 1, passed: false,
      failureEvidenceVersion: 2, failureSignature: "synthetic-source-boundary",
      failureSummary: `File "${source}", line 2, in compute\nAssertionError: expected compute result`,
    }] } } };
  return { root, workspace, outside, source, config, state };
}
const packet = f => buildFailedTestRecoveryPacket(f.config, f.state);
function empty(result) { assert.equal(result.content, ""); assert.deepEqual(result.paths, []); }

test("ordinary failed-test recovery retains the current source and reads it at most twice", async t => {
  const f = await fixture(t); let reads = 0;
  for (const key of ["readFile", "open"]) {
    const original = fs[key];
    t.mock.method(fs, key, (...args) => { if (args[0] === f.source) reads++; return Reflect.apply(original, fs, args); });
  }
  const result = await packet(f);
  assert.deepEqual(result.paths, ["module.py"]); assert.match(result.content, /return value \+ 1/);
  assert.ok(reads > 0 && reads <= 2, `A source was reread ${reads} times for one recovery packet`);
  assert.equal(await fs.readFile(f.source, "utf8"), sourceText);
});
for (const kind of ["outside", "env", "git"]) test(`automatic recovery rejects a ${kind} source alias`, async t => {
  const f = await fixture(t), target = kind === "outside" ? path.join(f.outside, "private.py") : path.join(f.workspace, kind === "env" ? ".env" : ".git/config");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `# ${marker}\n`);
  await fs.unlink(f.source); await fs.symlink(target, f.source);
  await assert.rejects(executeWorkspaceTool("read_file", { path: "module.py" }, f.config), { code: "WORKSPACE_READ_SCOPE" });
  const result = await packet(f); empty(result); assert.ok(!JSON.stringify(f.state).includes(marker));
});
test("canonical scope rejects aliases into an unselected workspace subtree", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.workspace, "selected")); await fs.mkdir(path.join(f.workspace, "other"));
  await fs.rename(f.source, path.join(f.workspace, "selected/module.py")); f.source = path.join(f.workspace, "selected/module.py");
  await fs.writeFile(path.join(f.workspace, "other/private.py"), `# ${marker}\n`);
  await fs.unlink(f.source); await fs.symlink("../other/private.py", f.source);
  f.config.workspacePathScopeRoots = ["selected"]; f.state.meta.projectVerification.lastMutation.paths = ["selected/module.py"];
  f.state.meta.projectVerification.testRuns[0].failureSummary = `File "${f.source}", line 1\nAssertionError`;
  empty(await packet(f));
});
test("a command mentioning an external traceback file does not grant read authority", async t => {
  const f = await fixture(t), external = path.join(f.outside, "validator.py"); await fs.writeFile(external, `# ${marker}\n`);
  const run = f.state.meta.projectVerification.testRuns[0]; run.command = `python3 ${external}`;
  run.failureSummary += `\nFile "${external}", line 1, in verify`;
  const result = await packet(f); assert.match(result.content, /return value \+ 1/); assert.ok(!result.content.includes(marker));
});
for (const field of ["readOnlyRoots", "skillReadOnlyRoots"]) test(`an explicit ${field} still permits selected external source`, async t => {
  const f = await fixture(t), external = path.join(f.outside, "current.py"); await fs.writeFile(external, "# selected external source\n");
  f.config[field] = [f.outside]; await fs.unlink(f.source); await fs.symlink(external, f.source);
  assert.match((await packet(f)).content, /selected external source/);
  f.config[field] = []; empty(await packet(f));
});
test("an inside-workspace alias remains a valid recovery source", async t => {
  const f = await fixture(t); await fs.rename(f.source, path.join(f.workspace, "current.py")); await fs.symlink("current.py", f.source);
  assert.match((await packet(f)).content, /return value \+ 1/);
});
test("an explicitly selected workspace root alias remains supported", async t => {
  const f = await fixture(t), alias = path.join(f.root, "selected-root"); await fs.symlink(f.workspace, alias);
  f.config.commandCwd = alias; f.config.baseDir = alias; f.state.commandCwd = alias;
  f.state.meta.projectVerification.testRuns[0].failureSummary = 'File "module.py", line 2\nAssertionError';
  assert.match((await packet(f)).content, /return value \+ 1/);
});
test("explicit file-tool revocation performs no secondary file operation or state mutation", async t => {
  const f = await fixture(t); f.config.allowFileTools = false; const before = JSON.stringify(f.state); let operations = 0;
  for (const key of ["open", "readFile", "stat", "realpath", "lstat"]) t.mock.method(fs, key, () => { operations++; throw Error("File permission was revoked"); });
  try { empty(await packet(f)); assert.equal(operations, 0); assert.equal(JSON.stringify(f.state), before); }
  finally { t.mock.restoreAll(); }
});
for (const bytes of [Buffer.from([0x23, 0x20, 0xff, 0x0a]), Buffer.from("source\0binary")]) test(`malformed source bytes are not repaired into model evidence (${bytes.toString("hex")})`, async t => {
  const f = await fixture(t); await fs.writeFile(f.source, bytes); empty(await packet(f));
});
test("valid multilingual source, BOM and line endings remain unmodified", async t => {
  const f = await fixture(t), text = "\ufeff# 来源：审查尚未完成。\r\n# 評価は未完了です。\r\ndef compute(value):\r\n    return value + 1\r\n";
  await fs.writeFile(f.source, text); const result = await packet(f);
  assert.ok(result.content.includes("审查尚未完成") && result.content.includes("評価は未完了")); assert.equal(await fs.readFile(f.source, "utf8"), text);
});
for (const bytes of [128000, 128001, 256001]) test(`recovery source read respects its existing byte bound ${bytes}`, async t => {
  const f = await fixture(t); await fs.writeFile(f.source, "# ordinary source line\n".repeat(bytes).slice(0, bytes));
  const result = await packet(f); if (bytes === 128000) assert.deepEqual(result.paths, ["module.py"]); else empty(result);
});
test("file growth after metadata cannot turn a bounded snapshot into a large read", async t => {
  const f = await fixture(t), stat = fs.stat, open = fs.open; let grown = false, oversizedRead = false;
  const grow = async () => { if (!grown) { grown = true; await fs.writeFile(f.source, "# large source\n".repeat(30000)); } };
  t.mock.method(fs, "stat", async (...args) => { const result = await Reflect.apply(stat, fs, args); if (args[0] === f.source) await grow(); return result; });
  t.mock.method(fs, "open", async (...args) => { if (args[0] === f.source) await grow(); return Reflect.apply(open, fs, args); });
  const readFile = fs.readFile;
  t.mock.method(fs, "readFile", async (...args) => { const result = await Reflect.apply(readFile, fs, args); if (args[0] === f.source && Buffer.byteLength(result) > 256000) oversizedRead = true; return result; });
  empty(await packet(f)); assert.equal(grown, true); assert.equal(oversizedRead, false);
});
test("a named-file swap during the live read discards context and closes the handle", async t => {
  const f = await fixture(t), external = path.join(f.outside, "private.py"); await fs.writeFile(external, `# ${marker}\n`);
  const open = fs.open; let swapped = false, closes = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await Reflect.apply(open, fs, args); if (args[0] !== f.source) return handle;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...a) => { const result = await read(...a); if (!swapped) { swapped = true; await fs.unlink(f.source); await fs.symlink(external, f.source); } return result; };
    handle.close = async () => { closes++; return close(); }; return handle;
  });
  empty(await packet(f)); assert.equal(swapped, true); assert.equal(closes, 1);
});
for (const mode of ["missing", "directory", "empty"]) test(`a ${mode} source cannot become a recovery artifact`, async t => {
  const f = await fixture(t); await fs.unlink(f.source);
  if (mode === "directory") await fs.mkdir(f.source);
  if (mode === "empty") await fs.writeFile(f.source, "");
  empty(await packet(f));
});
test("a successful test performs no diagnostic read", async t => {
  const f = await fixture(t); f.state.meta.projectVerification.testRuns[0].passed = true; let reads = 0;
  t.mock.method(fs, "open", () => { reads++; throw Error("No failed test"); }); empty(await packet(f)); assert.equal(reads, 0);
});
test("normal recovery does not issue any provider/network request", async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw Error("Offline context construction"); });
  assert.match((await packet(f)).content, /return value \+ 1/); assert.equal(calls, 0);
});

test("generated-manifest diagnostics cannot read keys through an excluded alias", async t => {
  const f = await fixture(t), external = path.join(f.outside, "manifest.json");
  await fs.writeFile(external, JSON.stringify({ [marker]: true, artifacts: [] }));
  await fs.symlink(external, path.join(f.workspace, "manifest.json"));
  f.state.meta.projectVerification.requiredOutputs = ["manifest.json"];
  f.state.meta.projectVerification.testRuns[0].failureSummary += "\nmanifest.json lacks validation evidence";
  const result = await packet(f); assert.match(result.content, /return value \+ 1/); assert.ok(!result.content.includes(marker));
});
test("a source secret must not reappear in producer anchors or exact repair hints", async t => {
  const f = await fixture(t), secret = "sk-SYNTHETIC_ONLY_RECOVERY_BOUNDARY_123456789";
  await fs.writeFile(f.source, `def write_manifest(rows):\n    api_key = "${secret}"\n    return {"artifacts": rows}\n`);
  f.state.meta.projectVerification.testRuns[0].failureSummary += "\nmanifest lacks validation evidence";
  const result = await packet(f);
  assert.ok(!result.content.includes(secret), "A raw producer anchor bypassed source redaction");
  assert.ok(!JSON.stringify(f.state.meta.failedTestDiagnostic).includes(secret), "Unsafe exact source must not become an automatic repair target");
  assert.match(result.content, /REDACTED/);
});
test("manifest key diagnostics use the same secret redaction as native reads", async t => {
  const f = await fixture(t), secret = "sk-SYNTHETIC_ONLY_MANIFEST_KEY_123456789";
  await fs.writeFile(path.join(f.workspace, "manifest.json"), JSON.stringify({ [secret]: true, artifacts: [] }));
  f.state.meta.projectVerification.requiredOutputs = ["manifest.json"];
  f.state.meta.projectVerification.testRuns[0].failureSummary += "\nmanifest.json lacks validation evidence";
  const result = await packet(f); assert.ok(!result.content.includes(secret)); assert.match(result.content, /REDACTED/);
});

test("restart history retires obsolete automatic packet and repair authority", () => {
  const state = { goal: "Fix the existing test.", messages: [{ role: "system", content: "Use offered tools only." },
    { role: "user", content: "Fix the existing test." },
    { role: "user", content: `Bounded failed-test evidence packet v17. ${marker}` }],
    meta: { failedTestRecoveryPacket: { packetVersion: 17, content: marker },
      failedTestDiagnostic: { packetVersion: 17, focuses: [{ directSearch: marker }] } } };
  const result = repairModelMessageHistory(state, { provider: "openai" });
  assert.equal(result.changed, true); assert.ok(!JSON.stringify(state).includes(marker));
  assert.deepEqual(state.messages.map(m => m.content), ["Use offered tools only.", "Fix the existing test."]);
});
test("current recovery packet remains usable across ordinary history repair", () => {
  const content = "Bounded failed-test evidence packet v18. Current authorized evidence.";
  const state = { messages: [{ role: "user", content }], meta: {
    failedTestRecoveryPacket: { packetVersion: 18, content }, failedTestDiagnostic: { packetVersion: 18, focuses: [] } } };
  const before = structuredClone(state); assert.equal(repairModelMessageHistory(state, { provider: "openai" }).changed, false);
  assert.deepEqual(state, before);
});
test("a genuine user message quoting the old protocol is retained as user data", () => {
  const content = "Bounded failed-test evidence packet v17. Explain this example string.";
  const state = { goal: content, chat: [{ role: "user", content }], messages: [{ role: "user", content }], meta: {} };
  repairModelMessageHistory(state, { provider: "openai" }); assert.equal(state.messages[0].content, content);
});

test("a failed command cannot grant a new external read root", async t => {
  const f = await fixture(t), external = path.join(f.outside, "validator.py"); await fs.writeFile(external, "# selected only by command\n");
  f.state.meta.projectVerification.testRuns[0].command = `python3 ${external}`;
  assert.deepEqual(failedTestExternalDiagnosticReadPaths(f.config, f.state), []);
  assert.deepEqual(nextStepRuntimeConfig(f.config, f.state).readOnlyRoots, []);
});
test("an explicit external file root is not widened to its parent directory", async t => {
  const f = await fixture(t), external = path.join(f.outside, "validator.py"); await fs.writeFile(external, "# host selected validator\n");
  f.config.readOnlyRoots = [external]; f.state.meta.projectVerification.testRuns[0].command = `python3 ${external}`;
  assert.deepEqual(failedTestExternalDiagnosticReadPaths(f.config, f.state), [external]);
  const next = nextStepRuntimeConfig(f.config, f.state); assert.deepEqual(next.readOnlyRoots, [external]);
  const sibling = path.join(f.outside, "unrelated.txt"); await fs.writeFile(sibling, marker);
  const denied = await executeWorkspaceTool("read_file", { path: sibling }, next);
  assert.equal(denied.blocked, true); assert.equal(denied.ok, false);
  assert.ok(!JSON.stringify(denied).includes(marker));
});
for (const alias of [false, true]) test(`explicit validator-source exclusion governs automatic context (alias ${alias})`, async t => {
  const f = await fixture(t), external = path.join(f.outside, "validator.py"); await fs.writeFile(external, `# ${marker}\n`);
  f.config.readOnlyRoots = [f.outside]; f.config.goal = "Tests failed in module.py. Do not read external validator source."; f.state.goal = f.config.goal;
  f.state.meta.projectVerification.testRuns[0].command = `python3 ${external}`;
  f.state.meta.projectVerification.testRuns[0].failureSummary += `\nFile "${external}", line 1, in verify`;
  if (alias) { await fs.unlink(f.source); await fs.symlink(external, f.source); }
  const result = await packet(f); assert.ok(!result.content.includes(marker));
  assert.ok(!JSON.stringify(f.state.meta.failedTestDiagnostic || {}).includes(marker));
  if (!alias) assert.match(result.content, /return value \+ 1/);
});
