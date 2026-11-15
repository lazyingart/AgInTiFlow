import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const core = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const marker = "EXCLUDED_PREPATCH_SOURCE_SYNTHETIC_ORCHID";
const original = "def compute(value):\n    return value + 1\n";
const invalidPatch = { path: "compute.py", search: "return value + 1", replace: "return value +" };
async function fixture(t, content = original) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-prepatch-source-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await assert.rejects(fs.stat(root), { code: "ENOENT" }); });
  const workspace = path.join(root, "workspace"), outside = path.join(root, "excluded"), source = path.join(workspace, "compute.py");
  await fs.mkdir(workspace); await fs.mkdir(outside); await fs.writeFile(source, content);
  return { root, workspace, outside, source, config: { commandCwd: workspace, baseDir: workspace, allowFileTools: true,
    readOnlyRoots: [], sandboxMode: "host", allowDestructive: false } };
}
const check = f => core.prospectivePythonExactPatchSyntaxBlock("apply_patch", invalidPatch, f.config);

test("prospective syntax still blocks an invalid exact patch before mutation", async t => {
  const f = await fixture(t), result = await check(f);
  assert.equal(result?.category, "python-syntax-regression"); assert.equal(await fs.readFile(f.source, "utf8"), original);
});
test("a valid exact patch stays available", async t => {
  const f = await fixture(t);
  assert.equal(await core.prospectivePythonExactPatchSyntaxBlock("apply_patch", { ...invalidPatch, replace: "return value + 2" }, f.config), null);
});
test("repairing an already-invalid source remains available", async t => {
  const f = await fixture(t, "def compute(value):\n    return value +\n");
  assert.equal(await core.prospectivePythonExactPatchSyntaxBlock("apply_patch", { path: "compute.py", search: "return value +", replace: "return value + 2" }, f.config), null);
});
for (const kind of ["outside", "env", "git", "credential"]) test(`an excluded ${kind} alias cannot become a syntax diagnostic`, async t => {
  const f = await fixture(t);
  const target = kind === "outside" ? path.join(f.outside, "record.py") : kind === "env" ? path.join(f.workspace, ".env")
    : kind === "git" ? path.join(f.workspace, ".git/config") : path.join(f.workspace, "credentials.json");
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, original.trimEnd() + " # " + marker + "\n");
  await fs.unlink(f.source); await fs.symlink(target, f.source);
  assert.equal(await check(f), null); assert.ok((await fs.readFile(target, "utf8")).includes(marker));
});
test("an explicit source scope rejects an alias into another subtree", async t => {
  const f = await fixture(t); await fs.mkdir(f.workspace + "/selected"); await fs.mkdir(f.workspace + "/other");
  await fs.writeFile(f.workspace + "/other/compute.py", original); await fs.symlink("../other/compute.py", f.workspace + "/selected/compute.py");
  f.config.workspacePathScopeRoots = ["selected"];
  assert.equal(await core.prospectivePythonExactPatchSyntaxBlock("apply_patch", { ...invalidPatch, path: "selected/compute.py" }, f.config), null);
});
test("an authorized inside-workspace alias remains readable for diagnostics", async t => {
  const f = await fixture(t); await fs.rename(f.source, f.workspace + "/current.py"); await fs.symlink("current.py", f.source);
  assert.equal((await check(f))?.category, "python-syntax-regression");
});
for (const field of ["readOnlyRoots", "skillReadOnlyRoots"]) test(`selected ${field} grants only its existing read authority`, async t => {
  const f = await fixture(t), selected = f.outside + "/current.py"; await fs.writeFile(selected, original);
  await fs.unlink(f.source); await fs.symlink(selected, f.source); f.config[field] = [selected];
  assert.equal((await check(f))?.category, "python-syntax-regression");
  f.config[field] = []; assert.equal(await check(f), null);
});
test("a selected workspace root alias keeps its canonical identity", async t => {
  const f = await fixture(t); await fs.symlink(f.workspace, f.root + "/selected");
  f.config.commandCwd = f.root + "/selected"; f.config.baseDir = f.root + "/selected";
  assert.equal((await check(f))?.category, "python-syntax-regression");
});
test("revoked file permission performs zero secondary filesystem calls", async t => {
  const f = await fixture(t); f.config.allowFileTools = false; let calls = 0;
  for (const name of ["open", "readFile", "realpath", "stat", "lstat"]) t.mock.method(fs, name, () => { calls++; throw Error("File tools revoked"); });
  try {
    assert.equal(await check(f), null);
    assert.equal(await core.ambiguousDeclarationTokenPatchBlock("apply_patch", { path: "compute.py", search: "def compute", replace: "def other():\n    pass" }, f.config), null);
    assert.equal(await core.ambiguousPythonMainGuardPatchBlock("apply_patch", { path: "compute.py", search: 'if __name__ == "__main__":\n    main()', replace: "pass" }, f.config), null);
    assert.equal(calls, 0);
  } finally { t.mock.restoreAll(); }
});
for (const bytes of [Buffer.from([0x23, 0x20, 0xff, 0x0a]), Buffer.from(original + "\0")]) test(`non-text source is never silently repaired (${bytes.toString("hex")})`, async t => {
  const f = await fixture(t, bytes); assert.equal(await check(f), null);
});
test("BOM, multilingual comments and CRLF remain valid snapshot bytes", async t => {
  const text = "\ufeff# 状態：未検証。审查尚未完成。\r\ndef compute(value):\r\n    return value + 1\r\n";
  const f = await fixture(t, text); assert.equal((await check(f))?.category, "python-syntax-regression"); assert.equal(await fs.readFile(f.source, "utf8"), text);
});
for (const bytes of [220000, 220001]) test(`prospective source validation respects the native ${bytes}-byte boundary`, async t => {
  const f = await fixture(t, original + "#" + "x".repeat(bytes - Buffer.byteLength(original) - 2) + "\n");
  const result = await check(f); assert.equal(result?.category || null, bytes === 220000 ? "python-syntax-regression" : null);
});
for (const change of ["growth", "replacement", "EIO"]) test(`a ${change} during the live read discards source and closes once`, async t => {
  const f = await fixture(t), open = fs.open; let injected = false, closes = 0;
  t.mock.method(fs, "open", async (...args) => {
    const h = await Reflect.apply(open, fs, args), read = h.read.bind(h), close = h.close.bind(h);
    h.close = async () => { closes++; return close(); };
    h.read = async (...values) => { const result = await read(...values); if (!injected) { injected = true;
      if (change === "growth") await fs.appendFile(f.source, "# growth\n");
      else if (change === "replacement") { await fs.rename(f.source, f.source + ".old"); await fs.writeFile(f.source, "# " + marker + "\n"); }
      else throw Object.assign(Error("synthetic read error"), { code: "EIO" });
    } return result; }; return h;
  });
  try { assert.equal(await check(f), null); assert.equal(closes, 1); } finally { t.mock.restoreAll(); }
});
test("syntax diagnostics redact secret-shaped source text", async t => {
  const secret = "sk-" + "a".repeat(44), f = await fixture(t, original.trimEnd() + ' # api_key="' + secret + '"\n');
  const result = await check(f); assert.equal(result?.category, "python-syntax-regression");
  assert.ok(!JSON.stringify(result).includes(secret)); assert.match(result.diagnosticHint, /REDACTED/);
});
test("isolated syntax parsing does not load ambient Python site hooks", async t => {
  const f = await fixture(t); await fs.mkdir(f.root + "/python-hooks");
  await fs.writeFile(f.root + "/python-hooks/sitecustomize.py", "from pathlib import Path\nPath(" + JSON.stringify(f.root + "/hook-ran") + ").write_text('unsafe hook')\n");
  const before = process.env.PYTHONPATH; process.env.PYTHONPATH = f.root + "/python-hooks";
  try { assert.equal((await check(f))?.category, "python-syntax-regression"); await assert.rejects(fs.stat(f.root + "/hook-ran"), { code: "ENOENT" }); }
  finally { if (before === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = before; }
});
test("Python parses the authorized snapshot instead of reopening a later pathname", async t => {
  const f = await fixture(t); await fs.mkdir(f.root + "/bin");
  const realPython = spawnSync("python3", ["-I", "-S", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }); assert.equal(realPython.status, 0);
  const argsFile = f.root + "/python-args";
  const script = "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + JSON.stringify(argsFile) + "\nprintf '%s\\n' 'later = (' > " + JSON.stringify(f.source) + "\nexec " + JSON.stringify(realPython.stdout.trim()) + " \"$@\"\n";
  await fs.writeFile(f.root + "/bin/python3", script, { mode: 0o700 }); const before = process.env.PATH; process.env.PATH = f.root + "/bin:" + before;
  try { assert.equal((await check(f))?.category, "python-syntax-regression"); assert.equal(await fs.readFile(f.source, "utf8"), "later = (\n");
    const args = await fs.readFile(argsFile, "utf8"); assert.match(args, /^-I\n-S\n-c\n/); assert.ok(args.includes("sys.stdin.buffer.read()")); assert.ok(!args.includes("read_text"));
  } finally { process.env.PATH = before; }
});
test("declaration and main-guard checks keep their original safety semantics", async t => {
  const f = await fixture(t);
  assert.equal((await core.ambiguousDeclarationTokenPatchBlock("apply_patch", { path: "compute.py", search: "def compute", replace: "def other():\n    pass" }, f.config))?.category, "ambiguous-declaration-token-patch");
  const main = 'def main():\n    return 0\n\nif __name__ == "__main__":\n    result = main()\n    raise SystemExit(result)\n'; await fs.writeFile(f.source, main);
  assert.equal((await core.ambiguousPythonMainGuardPatchBlock("apply_patch", { path: "compute.py", search: 'if __name__ == "__main__":\n    result = main()', replace: "pass" }, f.config))?.category, "ambiguous-python-main-guard-patch");
});
for (const checkName of ["declaration", "main-guard", "source-quality"]) test(`${checkName} also refuses an excluded source alias`, async t => {
  const f = await fixture(t), external = f.outside + "/record.py";
  await fs.writeFile(external, 'def compute(value):\n    return value\n\ndef compute(value):\n    return value\n\nif __name__ == "__main__":\n    result = compute(1)\n    print(result)\n');
  await fs.unlink(f.source); await fs.symlink(external, f.source);
  if (checkName === "declaration") assert.equal(await core.ambiguousDeclarationTokenPatchBlock("apply_patch", { path: "compute.py", search: "def compute", replace: "def other():\n    pass" }, f.config), null);
  else if (checkName === "main-guard") assert.equal(await core.ambiguousPythonMainGuardPatchBlock("apply_patch", { path: "compute.py", search: 'if __name__ == "__main__":\n    result = compute(1)', replace: "pass" }, f.config), null);
  else { const result = await core.validateMutatedPythonSourceQuality(f.config, { meta: { projectVerification: { mutationHistory: [{ revision: 1, paths: ["compute.py"] }] } } }); assert.equal(result.checked, false); assert.deepEqual(result.defects, []); }
});
test("a real FIFO cannot strand a pre-patch source check", { timeout: 15000 }, async t => {
  if (process.platform === "win32") return t.skip("POSIX FIFO only");
  const f = await fixture(t); await fs.unlink(f.source); assert.equal(spawnSync("mkfifo", [f.source], { timeout: 5000 }).status, 0);
  const code = 'import {prospectivePythonExactPatchSyntaxBlock as check} from ' + JSON.stringify(pathToFileURL(path.join(runtime, "src/agent-runner.js")).href) + ';' +
    'const result=await check("apply_patch",{path:"compute.py",search:"return value + 1",replace:"return value +"},{commandCwd:process.argv[1],allowFileTools:true});if(result!==null)throw Error("Unexpected FIFO source");console.log("FIFO_REJECTED");';
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.workspace], { cwd: f.workspace, env: { PATH: process.env.PATH, HOME: f.root, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 8000);
    child.once("error", e => { clearTimeout(timer); reject(e); }); child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
  assert.equal(timedOut, false); assert.equal(result.code, 0, stderr); assert.equal(result.signal, null); assert.match(stdout, /FIFO_REJECTED/);
});
