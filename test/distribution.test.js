import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeFiles = ["src/redaction.js", "src/restricted-application-contract.js", "src/restricted-application.js"];
const packageFiles = ["LICENSE", "NOTICE", "README.md", "package.json", ...runtimeFiles].sort();
const publicExports = ["RESTRICTED_APPLICATION_PROTOCOL", "RestrictedApplicationError", "createRestrictedApplicationRunner", "createRestrictedOpenAIProvider", "createRestrictedDeepSeekProvider", "createRestrictedProviderFailure", "createRestrictedToolFailure"].sort();
const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

test("distribution has a closed, zero-dependency, non-executable package surface", async () => {
  assert.equal(metadata.name, "@lazyingart/agintilite");
  assert.equal(metadata.type, "module");
  assert.equal(metadata.private, true);
  assert.equal(metadata.engines.node, ">=22");
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bin"]) {
    assert.equal(Object.hasOwn(metadata, key), false, key);
  }
  assert.deepEqual(Object.keys(metadata.exports).sort(), [".", "./package.json", "./restricted-application"]);
  assert.deepEqual([...metadata.files, "package.json"].sort(), packageFiles);
  for (const key of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"]) {
    assert.equal(Object.hasOwn(metadata.scripts, key), false, key);
  }
  let total = 0;
  for (const file of runtimeFiles) {
    const stat = await fs.lstat(path.join(root, file));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    total += stat.size;
    const source = await fs.readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /\bprocess\s*(?:\.|\[)|\b(?:fetch|eval|Function|require)\s*\(|\bimport\s*\(/);
    assert.doesNotMatch(source, /(?:node:)(?:fs|child_process|http|https|net|tls|vm)|integration-analysis-vision|agent-runner|dotenv|playwright/);
  }
  assert.ok(total < 48 * 1024, `runtime source grew to ${total} bytes`);
});

test("tarball is reproducible, allowlisted, and installs/runs offline without source-tree dependencies", { timeout: 60_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agintilite-pack-"));
  try {
    const userconfig = path.join(temp, "user.npmrc");
    const globalconfig = path.join(temp, "global.npmrc");
    await fs.writeFile(userconfig, "", { mode: 0o600 });
    await fs.writeFile(globalconfig, "", { mode: 0o600 });
    const env = {
      PATH: process.env.PATH, HOME: temp, LANG: "C", CI: "true",
      NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
      NPM_CONFIG_CACHE: path.join(temp, "cache"), NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    };
    function command(executable, args, cwd = root) {
      const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
      return result.stdout;
    }
    const hashes = [];
    let tarball;
    for (const name of ["first", "second"]) {
      const destination = path.join(temp, name);
      await fs.mkdir(destination);
      const [manifest] = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", destination]));
      assert.deepEqual(manifest.files.map((file) => file.path).sort(), packageFiles);
      assert.deepEqual(manifest.bundled, []);
      assert.ok(manifest.unpackedSize < 80 * 1024);
      tarball = path.join(destination, manifest.filename);
      const bytes = await fs.readFile(tarball);
      hashes.push(createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(command("tar", ["-tzf", tarball]).trim().split("\n").map((file) => file.replace(/^package\//, "")).sort(), packageFiles);
    }
    assert.equal(hashes[0], hashes[1], "identical source must produce identical local package bytes");

    const consumer = path.join(temp, "consumer");
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--prefix", consumer, tarball], consumer);
    const modules = (await fs.readdir(path.join(consumer, "node_modules"))).filter((name) => name !== ".package-lock.json");
    assert.deepEqual(modules, ["@lazyingart"]);
    assert.deepEqual(await fs.readdir(path.join(consumer, "node_modules", "@lazyingart")), ["agintilite"]);
    const installedRoot = path.join(consumer, "node_modules", "@lazyingart", "agintilite");
    for (const file of packageFiles) {
      const bytes = await fs.readFile(path.join(installedRoot, file));
      assert.deepEqual(bytes, await fs.readFile(path.join(root, file)));
      assert.doesNotMatch(bytes.toString("utf8"), /\/home\/lachlan|Nutstore|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
    }
    const hook = `
      import { registerHooks } from "node:module";
      const allowed = new Set(${JSON.stringify(runtimeFiles.map((file) => new URL(`file://${installedRoot}/${file}`).href))});
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (!["node:assert/strict", "node:util", "node:perf_hooks"].includes(result.url) && !allowed.has(result.url)) {
          throw new Error("Unapproved runtime import: " + result.url);
        }
        return result;
      } });
      globalThis.fetch = () => { throw new Error("Network is forbidden"); };
    `;
    const program = `
      import assert from "node:assert/strict";
      import * as root from "@lazyingart/agintilite";
      import * as subpath from "@lazyingart/agintilite/restricted-application";
      assert.deepEqual(Object.keys(root).sort(), ${JSON.stringify(publicExports)});
      assert.equal(root.createRestrictedApplicationRunner, subpath.createRestrictedApplicationRunner);
      const schema = {type:"object",properties:{reply:{type:"string",maxLength:40}},required:["reply"],additionalProperties:false};
      let calls = 0;
      const runner = root.createRestrictedApplicationRunner({
        provider:{supportsImages:false,complete:async () => { calls++; return {type:"final",value:{reply:"Proposal only"}}; }},
        tools:[],instructions:"Return an uncommitted proposal.",outputSchema:schema
      });
      const result = await runner.run({input:[{type:"text",text:"Please help."}]});
      assert.equal(result.proposal.reply, "Proposal only");
      assert.equal(result.schemaVersion, "aginti-restricted-application-v1");
      assert.equal(calls, 1);
      assert.equal(Object.isFrozen(result.proposal), true);
      const deepseek = root.createRestrictedDeepSeekProvider({model:"deepseek-flash",complete:async body => {
        assert.equal(body.response_format.type,"json_object");
        assert.equal(body.thinking.type,"disabled");
        assert.equal(Object.hasOwn(body,"tools"),false);
        return {choices:[{finish_reason:"stop",message:{role:"assistant",content:'{"reply":"Native DeepSeek profile"}'}}]};
      }});
      const nativeRunner = root.createRestrictedApplicationRunner({provider:deepseek,tools:[],instructions:"Uncommitted JSON only.",outputSchema:schema});
      assert.equal((await nativeRunner.run({input:[{type:"text",text:"Review my draft."}]})).proposal.reply,"Native DeepSeek profile");
      const roots = [
        [{type:"array",items:{type:"string",maxLength:40},maxItems:2},["first","second"]],
        [{type:"boolean"},false], [{type:"null"},null], [{type:"string",maxLength:20},""],
        [{anyOf:[{type:"string",maxLength:20},{type:"null"}]},null]
      ];
      for (const kind of ["openai","deepseek-flash","deepseek-v4-pro"]) for (const [outputSchema,value] of roots) {
        const complete = async body => {
          const wire = kind === "openai" ? body.response_format.json_schema.schema
            : JSON.parse(body.messages[0].content.split("FINAL_JSON_SCHEMA:\\n").at(-1));
          assert.equal(wire.type,"object");
          assert.deepEqual(Object.keys(wire.properties),["proposal"]);
          assert.deepEqual(wire.required,["proposal"]);
          assert.equal(wire.additionalProperties,false);
          return {choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify({proposal:value})}}]};
        };
        const provider = kind === "openai" ? root.createRestrictedOpenAIProvider({model:"offline-fixture",supportsImages:false,complete})
          : root.createRestrictedDeepSeekProvider({model:kind,complete});
        const app = root.createRestrictedApplicationRunner({provider,tools:[],instructions:"Proposal only.",outputSchema});
        const result = await app.run({input:[{type:"text",text:"List the observed items; no saves."}]});
        assert.deepEqual(JSON.parse(JSON.stringify(result.proposal)),value);
      }
      for (const content of ['{}','{"proposal":[],"extra":true}','{"proposal":[],"proposal":[]}','[]']) {
        const provider = root.createRestrictedDeepSeekProvider({model:"deepseek-flash",complete:async()=>({choices:[{finish_reason:"stop",message:{role:"assistant",content}}]})});
        const app = root.createRestrictedApplicationRunner({provider,tools:[],instructions:"Proposal only.",outputSchema:roots[0][0]});
        await assert.rejects(app.run({input:[{type:"text",text:"List items."}]}),error=>error.code==="PROVIDER_FAILED");
      }
      const declared = root.createRestrictedProviderFailure({category:"quota"});
      const failing = root.createRestrictedApplicationRunner({provider:{supportsImages:false,complete:async()=>{throw declared;}},tools:[],instructions:"Propose only.",outputSchema:schema});
      await assert.rejects(failing.run({input:[{type:"text",text:"Check my draft."}]}),error=>error.code==="PROVIDER_FAILED"&&error.providerFailure.category==="quota");
      const native = (content, extra = {}) => ({choices:[{finish_reason:"stop",message:{role:"assistant",content,...extra}}]});
      for (const raw of [
        native('{"reply":"first","reply":"last"}'),
        native('{"reply":"valid"}', {function_call:{name:"undeclared",arguments:"{}"}}),
        native('{"reply":"valid"}', {tool_calls:{}}),
        native('{"reply":"valid"}', {refusal:false})
      ]) {
        const provider = root.createRestrictedOpenAIProvider({model:"offline-fixture",supportsImages:false,complete:async () => raw});
        const guarded = root.createRestrictedApplicationRunner({provider,tools:[],instructions:"Proposal only.",outputSchema:schema});
        await assert.rejects(guarded.run({input:[{type:"text",text:"Review this record."}]}), {code:"PROVIDER_FAILED"});
      }
      await assert.rejects(import("@lazyingart/agintilite/src/redaction.js"), {code:"ERR_PACKAGE_PATH_NOT_EXPORTED"});
      console.log("INSTALLED_PACKAGE_OK");
    `;
    assert.match(command(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, "--input-type=module", "-e", program], consumer), /INSTALLED_PACKAGE_OK/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
