import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { source, root, env, command, built, installed, peerInstalled } from "./harness.js";

test("optional archive is reproducible with a closed dependency/credential-free surface", async () => {
  const second = JSON.parse(command(process.execPath, [path.join(source, "scripts/build-package.js"), path.join(root, "second")]));
  assert.equal(second.sha256, built.sha256);assert.equal(second.unpackedSize, built.unpackedSize);assert.equal(built.files.length, 8);
  assert.ok(built.unpackedSize < 64 * 1024);
  const metadata = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  assert.deepEqual(metadata.peerDependencies, { "@lazyingart/agintilite": "0.1.0-preview.23" });assert.equal(metadata.private, true);
  for (const field of ["bin", "dependencies", "optionalDependencies", "bundledDependencies"]) assert.equal(Object.hasOwn(metadata, field), false);
  for (const field of ["preinstall", "install", "postinstall", "prepack", "prepare", "prepublishOnly"]) assert.equal(Object.hasOwn(metadata.scripts, field), false);
  assert.deepEqual((await fs.readdir(path.join(root, "node_modules/@lazyingart"))).sort(), ["agintilite", "agintilite-pipe"]);
  for (const file of built.files) {
    const text = await fs.readFile(path.join(installed, file), "utf8");
    assert.doesNotMatch(text, /\/home\/lachlan|Nutstore|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
    if (file.endsWith(".js")) {
      const code = text.replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(code, /node:(?:fs|child_process|http|https|net|tls|vm)|\b(?:fetch|eval|Function|require)\s*\(|\bprocess\s*[.[]|agent-runner|\bvision\b|dotenv|LazyEdge|LazyingAgentWeb/);
    }
  }
  for (const file of ["restricted-application-contract.js", "redaction.js"]) assert.deepEqual(await fs.readFile(path.join(installed, "src/internal", file)), await fs.readFile(path.join(peerInstalled, "src", file)));
});

test("conflicting private pipe archive survives a rebuild unchanged", async () => {
  const destination = path.join(root, "conflict");
  await fs.mkdir(destination);
  const filename = path.basename(built.archive);
  const target = path.join(destination, filename);
  const bytes = await fs.readFile(built.archive);
  bytes[0] ^= 1;
  await fs.writeFile(target, bytes);
  const result = spawnSync(process.execPath, [path.join(source, "scripts/build-package.js"), destination], { env, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release archive differs/);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await fs.readdir(destination), [filename]);
});

test("private Python host runs native DeepSeek envelopes through actual SDK without model/network", () => {
  const result = JSON.parse(command("/usr/bin/python3", [path.join(source, "test/fixtures/python-host.py"), process.execPath,
    path.join(source, "test/fixtures/worker.js"), pathToFileURL(path.join(installed, "src/streams.js")).href,
    pathToFileURL(path.join(peerInstalled, "src/restricted-application.js")).href]));
  assert.deepEqual(result, { passed: true, invocations: 2, reads: 2, hostCommits: 2, liveModels: 0, foreignAccountUnchanged: true });
});

for (const version of ["0.1.0-preview.22", "0.1.0-preview.24"]) test(`strict offline install refuses SDK ${version}`, async () => {
  const peer = path.join(root, "unqualified-peer-" + version);
  const consumer = path.join(root, "incompatible-consumer-" + version);
  await fs.mkdir(peer);
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(peer, "package.json"), JSON.stringify({ name: "@lazyingart/agintilite", version }));
  await fs.writeFile(path.join(consumer, "package.json"), '{"private":true}');
  const [packed] = JSON.parse(command("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", root], peer));
  const result = spawnSync("npm", ["install", "--strict-peer-deps", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(root, packed.filename), built.archive], { cwd: consumer, env, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERESOLVE/);
  await assert.rejects(fs.stat(path.join(consumer, "node_modules/@lazyingart/agintilite-pipe")), { code: "ENOENT" });
});

test("channel refuses an unqualified peer before any callback", () => {
  command(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import peer from '@lazyingart/agintilite/package.json' with { type: 'json' };
    import {createRestrictedApplicationChannel} from '@lazyingart/agintilite-pipe';
    let calls = 0;
    const options = {scopeId:'account_isolated_0001',instructions:'Answer only.',tools:[],
      outputSchema:{type:'string',maxLength:80},provider:{supportsImages:false,complete(){calls++;}},emit(){calls++;}};
    for (const version of ['0.1.0-preview.21', '0.1.0-preview.22', '0.1.0-preview.24']) {
      peer.version = version;
      assert.throws(() => createRestrictedApplicationChannel(options), {code:'PEER_MISMATCH'});
    }
    assert.equal(calls,0);
  `]);
});

test("import has only the documented exports and no listener/process/provider side effect", () => {
  const result = command(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    const allowed = new Set(['node:util','node:perf_hooks','node:events','node:crypto','node:async_hooks']);
    const root=${JSON.stringify(pathToFileURL(path.join(root, "node_modules/")).href)};
    registerHooks({resolve(s,c,next){const result=next(s,c);if(!allowed.has(result.url)&&!result.url.startsWith(root))throw Error('Unapproved import');return result;}});
    globalThis.fetch=()=>{throw Error('Network forbidden')};
    const before=process.getActiveResourcesInfo();
    const channel=await import('@lazyingart/agintilite-pipe');const streams=await import('@lazyingart/agintilite-pipe/streams');
    assert.deepEqual(Object.keys(channel).sort(),['PIPE_MAX_FRAME_BYTES','RESTRICTED_APPLICATION_PIPE_PROTOCOL','RestrictedApplicationPipeError','createRestrictedApplicationChannel'].sort());
    assert.deepEqual(Object.keys(streams),['serveRestrictedApplicationPipe']);
    assert.deepEqual(process.getActiveResourcesInfo(),before);
    console.log('PASS');
  `]);assert.equal(result.trim(), "PASS");
});
