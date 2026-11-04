import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readCliProviderDefault, writeCliProviderDefault, selectStandaloneCliProvider, cliProviderDefaultsCommand } from "../src/cli-provider-defaults.js";
import { modelTimeoutRetryRoute } from "../src/agent-runner.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const invalid = (error) => error.code === "CLI_PROVIDER_DEFAULT_INVALID";

test("timeout recovery recognizes equivalent Flash names and retains Pro downgrade", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const retry = modelTimeoutRetryRoute({ provider: "deepseek", model, modelTimeoutMs: 300000 });
    assert.equal(retry.model, model); assert.equal(retry.switchedModel, false); assert.equal(retry.retryTimeoutMs, 120000);
  }
  const pro = modelTimeoutRetryRoute({ provider: "deepseek", model: "deepseek-v4-pro", modelTimeoutMs: 300000 });
  assert.equal(pro.model, "deepseek-flash"); assert.equal(pro.switchedModel, true); assert.equal(pro.retryTimeoutMs, 180000);
});
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aginti-cli-provider-default-"));
  const env = { AGINTIFLOW_HOME: path.join(root, "home") };
  try { return fn({ root, env, filename: path.join(env.AGINTIFLOW_HOME, "cli-provider-default.json") }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function command(argv, f, extra = {}, script = null) {
  const result = spawnSync(process.execPath, script ? ["--experimental-test-module-mocks", "--input-type=module", "-e", script, "--", ...argv] : [path.join(repo, "bin/aginti-cli.js"), ...argv], {
    cwd: f.root, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH, HOME: f.root, AGINTIFLOW_HOME: f.env.AGINTIFLOW_HOME,
      AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1",
      DEEPSEEK_API_KEY: "synthetic-config-test-key", LANG: "C.UTF-8", ...extra },
  });
  if (result.error) throw result.error;
  return result;
}
const configScript = `
  import { mock } from 'node:test';
  await mock.module(${JSON.stringify(new URL("../src/agent-runner.js", import.meta.url).href)}, { namedExports: { runAgent: async(config) => {
    console.log('SELECTED '+JSON.stringify({provider:config.provider,model:config.model,routeProvider:config.routeProvider,mainProvider:config.mainProvider,spareProvider:config.spareProvider}));
    return {success:true,result:'Ready.',reason:'completed',sessionId:config.sessionId,stepsCompleted:0};
  } } });
  await mock.module(${JSON.stringify(new URL("../src/interactive-cli.js", import.meta.url).href)}, { namedExports: { startInteractiveCli: async(args) => {
    console.log('SELECTED '+JSON.stringify({provider:args.provider,interactive:true}));
  } } });
  const {main}=await import(${JSON.stringify(new URL("../src/cli.js", import.meta.url).href)});
  await main(process.argv.slice(1));
`;
function selected(argv, f, extra) {
  const r = command(argv, f, extra, configScript);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = r.stdout.split("\n").find((line) => line.startsWith("SELECTED "));
  assert.ok(line, r.stdout);
  return JSON.parse(line.slice(9));
}

test("preference read is side-effect free; set/reset are exact and leave credentials unchanged", () => fixture((f) => {
  assert.equal(readCliProviderDefault(f.env), null); assert.equal(fs.existsSync(f.env.AGINTIFLOW_HOME), false);
  fs.mkdirSync(f.env.AGINTIFLOW_HOME, { mode: 0o700 });
  const credentials = path.join(f.env.AGINTIFLOW_HOME, ".env"), original = 'DEEPSEEK_API_KEY="synthetic-untouched-key"\n';
  fs.writeFileSync(credentials, original, { mode: 0o600 }); const inode = fs.statSync(credentials).ino;
  assert.equal(writeCliProviderDefault("ds", f.env), "deepseek");
  assert.equal(fs.readFileSync(f.filename, "utf8"), '{"schemaVersion":1,"provider":"deepseek"}\n');
  assert.equal(fs.statSync(f.filename).mode & 0o7777, 0o600); assert.equal(readCliProviderDefault(f.env), "deepseek");
  assert.equal(writeCliProviderDefault(null, f.env), null); assert.equal(readCliProviderDefault(f.env), null);
  assert.equal(fs.readFileSync(credentials, "utf8"), original); assert.equal(fs.statSync(credentials).ino, inode);
  assert.deepEqual(fs.readdirSync(f.env.AGINTIFLOW_HOME).sort(), [".env", "cli-provider-default.json"]);
}));

test("flags and environment override preference without reading an invalid file", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env); fs.writeFileSync(f.filename, "corrupt");
  assert.equal(selectStandaloneCliProvider({ provider: "localllm" }, f.env), "localllm");
  assert.equal(selectStandaloneCliProvider({}, { ...f.env, AGENT_PROVIDER: "mock" }), "mock");
  assert.throws(() => selectStandaloneCliProvider({}, f.env), invalid);
}));

test("absent preference preserves legacy home startup; unsafe present preference stays rejected", () => fixture((f) => {
  fs.mkdirSync(f.env.AGINTIFLOW_HOME); fs.chmodSync(f.env.AGINTIFLOW_HOME, 0o775);
  assert.equal(readCliProviderDefault(f.env), null); assert.equal(selectStandaloneCliProvider({}, f.env), "");
  assert.throws(() => writeCliProviderDefault("deepseek", f.env), invalid);
  fs.writeFileSync(f.filename, '{"schemaVersion":1,"provider":"deepseek"}\n', { mode: 0o600 });
  assert.throws(() => readCliProviderDefault(f.env), invalid);
}));

test("benign concurrent session directory creation does not change retained preference identity", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  const original = fs.readFileSync; let injected = false;
  fs.readFileSync = function (fd, ...args) {
    const bytes = Reflect.apply(original, fs, [fd, ...args]);
    if (typeof fd === "number" && !injected) { injected = true; fs.mkdirSync(path.join(f.env.AGINTIFLOW_HOME, "sessions")); }
    return bytes;
  };
  try { assert.equal(readCliProviderDefault(f.env), "deepseek"); assert.equal(injected, true); }
  finally { fs.readFileSync = original; }
}));

test("invalid providers and malformed command forms do not mutate settings", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env); const before = fs.readFileSync(f.filename);
  for (const value of ["", "arbitrary", "deepseek\nextra", {}, 1, undefined]) assert.throws(() => writeCliProviderDefault(value, f.env), invalid);
  for (const args of [["set"], ["set", "--provider", "deepseek", "--model", "x"], ["reset", "extra"]]) assert.throws(() => cliProviderDefaultsCommand(args, f.env));
  assert.deepEqual(fs.readFileSync(f.filename), before);
}));

test("corrupt, future, duplicate, hidden authority and oversized settings fail closed", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  for (const text of ['{}', '{"schemaVersion":2,"provider":"deepseek"}\n', '{"schemaVersion":1,"provider":"deepseek","provider":"localllm"}\n', '{"schemaVersion":1,"provider":"deepseek","tools":true}\n', '{"schemaVersion":1,"provider":"DS"}\n', "x".repeat(4097), '\ufeff{"schemaVersion":1,"provider":"deepseek"}\n']) {
    fs.writeFileSync(f.filename, text);
    assert.throws(() => readCliProviderDefault(f.env), invalid);
    assert.throws(() => writeCliProviderDefault("localllm", f.env), invalid);
    assert.equal(fs.readFileSync(f.filename, "utf8"), text);
  }
}));

test("unsafe mode/link/root cannot redirect preference I/O", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  fs.chmodSync(f.filename, 0o644); assert.throws(() => readCliProviderDefault(f.env), invalid); fs.chmodSync(f.filename, 0o600);
  const victim = path.join(f.root, "victim"); fs.writeFileSync(victim, "unchanged", { mode: 0o600 });
  fs.unlinkSync(f.filename); fs.symlinkSync(victim, f.filename);
  assert.throws(() => readCliProviderDefault(f.env), invalid); assert.throws(() => writeCliProviderDefault("deepseek", f.env), invalid);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged"); fs.unlinkSync(f.filename);
  writeCliProviderDefault("deepseek", f.env); fs.linkSync(f.filename, f.filename + ".link");
  assert.throws(() => readCliProviderDefault(f.env), invalid); fs.unlinkSync(f.filename + ".link");
  fs.chmodSync(f.env.AGINTIFLOW_HOME, 0o777); assert.throws(() => readCliProviderDefault(f.env), invalid); fs.chmodSync(f.env.AGINTIFLOW_HOME, 0o700);
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.env.AGINTIFLOW_HOME, alias);
  assert.throws(() => readCliProviderDefault({ AGINTIFLOW_HOME: alias }), invalid);
}));

test("actual CLI settings command round-trips without sessions, web, or credentials", () => fixture((f) => {
  for (const [args, expected] of [[['defaults', 'status'], null], [['defaults', 'set', '--provider', 'deepseek'], 'deepseek'], [['defaults', 'status'], 'deepseek'], [['defaults', 'reset'], null]]) {
    const r = command(args, f); assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout); assert.equal(data.provider, expected); assert.equal(data.scope, "standalone-cli-new-runs"); assert.equal(data.headlessRuns, false);
  }
  assert.deepEqual(fs.readdirSync(f.env.AGINTIFLOW_HOME), ["cli-provider-default.json"]);
}));

test("standalone new run selects preference; explicit/project/environment selection wins", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  let result = selected(["--routing", "fast", "Reply briefly."], f);
  assert.equal(result.provider, "deepseek"); assert.equal(result.model, "deepseek-flash");
  assert.equal(result.routeProvider, "deepseek"); assert.equal(result.mainProvider, "deepseek"); assert.equal(result.spareProvider, "deepseek");
  result = selected(["--routing", "complex", "Review this architecture."], f);
  assert.equal(result.provider, "deepseek"); assert.equal(result.model, "deepseek-v4-pro");
  result = selected(["--provider", "mock", "Reply briefly."], f); assert.equal(result.provider, "mock");
  result = selected(["Reply briefly."], f, { AGENT_PROVIDER: "mock" }); assert.equal(result.provider, "mock");
  fs.writeFileSync(path.join(f.root, ".env"), "AGENT_PROVIDER=mock\n", { mode: 0o600 });
  result = selected(["Reply briefly."], f); assert.equal(result.provider, "mock");
}));

test("settings entry works with only built-ins and no Agent runtime or node_modules", () => fixture((f) => {
  const minimal = path.join(f.root, "minimal");
  fs.mkdirSync(path.join(minimal, "bin"), { recursive: true }); fs.mkdirSync(path.join(minimal, "src"));
  fs.writeFileSync(path.join(minimal, "package.json"), '{"type":"module"}');
  for (const name of ["bin/aginti-cli.js", "src/cli-provider-defaults.js", "src/provider-contract.js"]) fs.copyFileSync(path.join(repo, name), path.join(minimal, name));
  const r = spawnSync(process.execPath, [path.join(minimal, "bin/aginti-cli.js"), "defaults", "set", "--provider", "deepseek"], { encoding: "utf8", timeout: 3000,
    env: { PATH: process.env.PATH, HOME: f.root, AGINTIFLOW_HOME: f.env.AGINTIFLOW_HOME } });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).provider, "deepseek");
  assert.deepEqual(fs.readdirSync(f.env.AGINTIFLOW_HOME), ["cli-provider-default.json"]);
}));

test("new chat selects the standalone preference without changing the task controls", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  const result = selected(["chat"], f);
  assert.equal(result.interactive, true); assert.equal(result.provider, "deepseek");
}));

test("headless run and SDK ignore personal preference; legacy saved model stays exact", () => fixture((f) => {
  writeCliProviderDefault("deepseek", f.env);
  let result = selected(["run", "--json", "Reply briefly."], f);
  assert.equal(result.provider, "localllm"); assert.equal(result.model, "localllm-fast");
  const script = `
    const {resolveRuntimeConfig}=await import(${JSON.stringify(new URL("../src/config.js", import.meta.url).href)});
    const normal=resolveRuntimeConfig({goal:'Reply briefly.'});
    const resumed=resolveRuntimeConfig({goal:'Continue.'},{provider:'deepseek',model:'deepseek-v4-flash',sessionModelLocked:true});
    console.log(JSON.stringify({normal:normal.provider,resumedProvider:resumed.provider,resumedModel:resumed.model}));
  `;
  const r = command([], f, {}, script); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { normal: "localllm", resumedProvider: "deepseek", resumedModel: "deepseek-v4-flash" });
}));
