import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshCodebaseMap, readCodebaseMap } from "../src/codebase-map.js";

const source = "def double(n):\n    return n * 2\n", excluded = "Synthetic unrelated record: amber meadow.\n";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-project-cache-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), other = path.join(root, "not-admitted");
  await fs.mkdir(workspace); await fs.mkdir(other); await fs.writeFile(path.join(workspace, "main.py"), source);
  const foreign = path.join(other, "codebase-map.json"), cache = path.join(workspace, ".aginti/codebase-map.json");
  await fs.writeFile(foreign, excluded);
  const config = { commandCwd: workspace, baseDir: workspace, allowFileTools: true, sandboxMode: "host", workspaceWritePolicy: "block" };
  return { root, workspace, other, foreign, cache, config };
}
async function unsafeCache(f, kind) {
  if (kind === "directory") await fs.symlink(f.other, path.join(f.workspace, ".aginti"));
  else {
    await fs.mkdir(path.dirname(f.cache));
    if (kind === "hardlink") await fs.link(f.foreign, f.cache);
    else if (kind === "file") await fs.symlink(f.foreign, f.cache);
    else if (kind === "dangling") await fs.symlink(path.join(f.other, "absent.json"), f.cache);
    else if (kind === "directory-entry") await fs.mkdir(f.cache);
  }
}
function patch(t, object, key, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { ...descriptor, value: wrap(descriptor.value) });
  t.after(() => Object.defineProperty(object, key, descriptor));
}

test("ordinary read-only inspection builds and atomically refreshes a usable project cache", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await refreshCodebaseMap(f.config);
    assert.equal(result.ok, true); assert.ok(result.map.fingerprint);
    const loaded = await readCodebaseMap(f.workspace);
    assert.equal(loaded.ok, true); assert.deepEqual(loaded.map, result.map);
    assert.equal(await fs.readFile(path.join(f.workspace, "main.py"), "utf8"), source);
    assert.equal(await fs.readFile(f.foreign, "utf8"), excluded);
    assert.equal((await fs.stat(f.cache)).nlink, 1);
    assert.deepEqual(await fs.readdir(path.dirname(f.cache)), ["codebase-map.json"]);
  }
});

for (const kind of ["file", "directory", "hardlink", "dangling", "directory-entry"]) {
  test("cache publication refuses " + kind + " aliases before changing unrelated bytes", async t => {
    const f = await fixture(t); await unsafeCache(f, kind);
    const before = (await fs.readdir(f.other)).sort();
    await assert.rejects(refreshCodebaseMap(f.config));
    assert.equal(await fs.readFile(f.foreign, "utf8"), excluded);
    assert.deepEqual((await fs.readdir(f.other)).sort(), before);
    assert.equal(await fs.readFile(path.join(f.workspace, "main.py"), "utf8"), source);
  });
}

for (const kind of ["file", "directory", "hardlink"]) {
  test("cache reader refuses " + kind + " alias rather than accepting foreign JSON", async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.workspace, "amber meadow.js"), "// Synthetic metadata marker.\n");
    const { map } = await refreshCodebaseMap(f.config);
    await fs.writeFile(f.foreign, JSON.stringify(map));
    await fs.rm(path.dirname(f.cache), { recursive: true });
    await unsafeCache(f, kind);
    const result = await readCodebaseMap(f.workspace);
    assert.equal(result.ok, false); assert.equal("map" in result, false);
    assert.equal(JSON.stringify(result).includes("amber meadow"), false);
  });
}

test("a selected workspace-root alias is usable without admitting child aliases", async t => {
  const f = await fixture(t), alias = path.join(f.root, "selected-workspace");
  await fs.symlink(f.workspace, alias);
  const result = await refreshCodebaseMap({ ...f.config, commandCwd: alias, baseDir: alias });
  assert.equal(result.ok, true); assert.equal((await readCodebaseMap(alias)).ok, true);
  assert.equal(await fs.readFile(f.foreign, "utf8"), excluded);
});

test("a failed staged write preserves the previous cache and cleans its temporary file", async t => {
  const f = await fixture(t); await refreshCodebaseMap(f.config); const before = await fs.readFile(f.cache);
  let injected = 0;
  patch(t, fs, "open", original => async (...args) => {
    const handle = await Reflect.apply(original, fs, args);
    if (path.basename(String(args[0])).startsWith(".aginti-write-")) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { injected++; await write(bytes.subarray(0, 7)); throw Object.assign(Error("Synthetic stage failure"), { code: "EIO" }); };
    }
    return handle;
  });
  await assert.rejects(refreshCodebaseMap(f.config), { code: "EIO" });
  assert.equal(injected, 1); assert.deepEqual(await fs.readFile(f.cache), before);
  assert.equal((await readCodebaseMap(f.workspace)).ok, true);
  assert.deepEqual(await fs.readdir(path.dirname(f.cache)), ["codebase-map.json"]);
});

for (const kind of ["invalid-UTF8", "NUL", "oversize"]) {
  test("cache reads refuse " + kind + " bytes", async t => {
    const f = await fixture(t), { map } = await refreshCodebaseMap(f.config);
    let bytes;
    if (kind === "oversize") {
      const json = Buffer.from(JSON.stringify(map)); bytes = Buffer.concat([json, Buffer.alloc(220001 - json.length, 0x20)]);
    } else if (kind === "invalid-UTF8") {
      map.inspection.engineeringHints[0] = "encoding-placeholder";
      const json = Buffer.from(JSON.stringify(map)), index = json.indexOf("encoding-placeholder");
      bytes = Buffer.concat([json.subarray(0, index), Buffer.from([0xff]), json.subarray(index + "encoding-placeholder".length)]);
    } else bytes = Buffer.from('{"value":"\u0000"}');
    await fs.writeFile(f.cache, bytes);
    const result = await readCodebaseMap(f.workspace);
    assert.equal(result.ok, false); assert.equal("map" in result, false);
    assert.deepEqual(await fs.readFile(f.cache), bytes);
  });
}

test("missing or disabled cache remains a non-mutating optional result", async t => {
  const f = await fixture(t);
  assert.equal((await readCodebaseMap(f.workspace)).reason, "missing");
  assert.equal((await refreshCodebaseMap({ ...f.config, allowFileTools: false })).ok, false);
  await assert.rejects(fs.lstat(path.dirname(f.cache)), { code: "ENOENT" });
});

for (const kind of ["file", "directory"]) test("in-workspace " + kind + " aliases cannot redirect cache publication either", async t => {
  const f = await fixture(t), local = path.join(f.workspace, "other-data"); await fs.mkdir(local);
  const target = path.join(local, "codebase-map.json"); await fs.writeFile(target, excluded);
  if (kind === "directory") await fs.symlink(local, path.dirname(f.cache));
  else { await fs.mkdir(path.dirname(f.cache)); await fs.symlink(target, f.cache); }
  await assert.rejects(refreshCodebaseMap(f.config));
  assert.equal(await fs.readFile(target, "utf8"), excluded);
  assert.equal((await readCodebaseMap(f.workspace)).ok, false);
});

test("valid literal replacement characters and the exact byte bound remain readable", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.workspace, "valid-\ufffd.js"), "// Valid literal filename.\n");
  const { map } = await refreshCodebaseMap(f.config), json = Buffer.from(JSON.stringify(map));
  assert.ok(json.includes(Buffer.from("\ufffd")));
  for (const bytes of [json, Buffer.concat([json, Buffer.alloc(220000 - json.length, 0x20)])]) {
    await fs.writeFile(f.cache, bytes);
    const result = await readCodebaseMap(f.workspace);
    assert.equal(result.ok, true); assert.deepEqual(result.map, map);
  }
});

function bounded(promise, label, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " timed out")), ms); })])
    .finally(() => clearTimeout(timer));
}

test("readers see the complete old cache until the complete new cache is published", async t => {
  const f = await fixture(t), old = await refreshCodebaseMap(f.config);
  const before = await fs.readFile(f.cache); await fs.appendFile(path.join(f.workspace, "main.py"), "# A second version.\n");
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), allowed = new Promise(resolve => { release = resolve; });
  patch(t, fs, "rename", original => async (...args) => {
    if (args[1] === f.cache) { enter(); await allowed; }
    return Reflect.apply(original, fs, args);
  });
  const pending = refreshCodebaseMap(f.config); pending.catch(() => {});
  try {
    await bounded(entered, "cache publication gate");
    assert.deepEqual(await fs.readFile(f.cache), before);
    assert.deepEqual((await readCodebaseMap(f.workspace)).map, old.map);
  } finally { release(); }
  const current = await bounded(pending, "complete cache publication");
  assert.equal(current.ok, true); assert.notEqual(current.map.fingerprint, old.map.fingerprint);
  assert.deepEqual((await readCodebaseMap(f.workspace)).map, current.map);
  assert.deepEqual(await fs.readdir(path.dirname(f.cache)), ["codebase-map.json"]);
});

test("a published cache with residual staging is reported unavailable rather than silently ready", async t => {
  const f = await fixture(t); let staged;
  const unlink = fs.unlink;
  patch(t, fs, "unlink", original => async file => {
    if (path.basename(file).startsWith(".aginti-write-")) { staged = file; throw Object.assign(Error("Synthetic unlink failure"), { code: "EIO" }); }
    return Reflect.apply(original, fs, [file]);
  });
  const result = await refreshCodebaseMap(f.config);
  assert.equal(result.ok, false); assert.equal(result.publication.stagingCleanupPending, true);
  assert.match(result.reason, /published.*cleanup/);
  assert.equal(JSON.parse(await fs.readFile(f.cache)).version, 1);
  assert.equal((await readCodebaseMap(f.workspace)).ok, false);
  assert.equal((await fs.stat(f.cache)).nlink, 2);
  await Reflect.apply(unlink, fs, [staged]);
  assert.equal((await readCodebaseMap(f.workspace)).ok, true);
});

for (const [kind, scs] of [["normal", false], ["normal", true], ["file", false], ["file", true], ["directory", false], ["hardlink", false]]) {
  test("native initial and follow-up review keeps " + kind + " optional cache safe (SCS " + scs + ")", { timeout: 20000 }, async t => {
    const f = await fixture(t); if (kind !== "normal") await unsafeCache(f, kind);
    const { runAgent } = await import("../src/agent-runner.js");
    const { resolveRuntimeConfig } = await import("../src/config.js");
    const { closeSessionIndexConnections } = await import("../src/session-index.js");
    const home = process.env.AGINTIFLOW_HOME; process.env.AGINTIFLOW_HOME = path.join(f.root, "home");
    let requests = 0, read = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(url).href, "https://offline.invalid/v1/chat/completions"); requests++;
      const body = JSON.parse(init.body); assert.equal(init.body.includes("amber meadow"), false);
      const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "cache_" + requests, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      let message;
      if (!body.tools) message = { role: "assistant", content: "Inspect main.py and explain it without changing code." };
      else if (!body.tools.some(tool => tool.function.name === "read_file") && body.tools.some(tool => tool.function.name === "inspect_project")) message = call("inspect_project", {});
      else if (!read) { read = true; message = call("read_file", { path: "main.py" }); }
      else message = call("finish", { result: "main.py defines double(n), which returns n * 2. This is source inspection only; no code was changed or executed." });
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const config = resolveRuntimeConfig({ goal: "Review main.py and tell me what it does. Don't change the code.",
        provider: "deepseek", model: "deepseek-flash", routingMode: "manual", taskProfile: "code", commandCwd: f.workspace, maxSteps: 5, dynamicSteps: "off" }, {
        baseDir: f.workspace, packageDir: path.resolve(import.meta.dirname, ".."), sessionId: "cache-review",
        apiKey: "synthetic-offline-key", baseURL: "https://offline.invalid/v1", sandboxMode: "host", packageInstallPolicy: "block",
        allowFileTools: true, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false,
        allowMcpTools: false, allowParallelScouts: false, onConsole() {}, onLog() {}, onEvent() {},
      });
      Object.assign(config, { sessionsDir: path.join(f.root, "sessions"), projectSessionsDir: path.join(f.root, "pointers"),
        enableScs: scs ? "on" : "off", scsActive: scs, scsValidationMode: "deterministic", allowProviderHandoff: false, modelTimeoutMs: 5000,
        mainProvider: "deepseek", mainModel: "deepseek-flash", spareProvider: "deepseek", spareModel: "deepseek-flash", routeProvider: "deepseek", routeModel: "deepseek-flash" });
      for (const phase of ["start", "follow-up"]) {
        read = false;
        const result = await runAgent(phase === "start" ? config : { ...config, resume: "cache-review",
          expectedRuntimeRevision: 1, goal: "Now inspect main.py once more and explain the function's return value. Do not edit any file." });
        assert.equal(result.goalStatus, "completed"); assert.ok(read);
        assert.equal(await fs.readFile(path.join(f.workspace, "main.py"), "utf8"), source);
        assert.equal(await fs.readFile(f.foreign, "utf8"), excluded);
        const dir = path.join(f.root, "sessions/cache-review");
        const state = await fs.readFile(path.join(dir, "state.json"), "utf8"), log = await fs.readFile(path.join(dir, "events.jsonl"), "utf8");
        const events = log.trim().split("\n").map(JSON.parse);
        assert.equal((state + log).includes("amber meadow"), false);
        assert.deepEqual(events.filter(e => e.type === "file.changed"), []);
        assert.ok(events.some(e => e.type === (kind === "normal" ? "surgical_context.prepared" : "surgical_context.failed")));
        assert.equal((await readCodebaseMap(f.workspace)).ok, kind === "normal");
      }
      assert.ok(requests <= 10, "cache failure must not inflate model work");
    } finally {
      globalThis.fetch = originalFetch; closeSessionIndexConnections();
      if (home === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = home;
    }
  });
}
