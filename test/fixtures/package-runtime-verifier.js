import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";

// Import-only test boundary: no real npm, network, model or consumer process.
const scenario=process.argv[2], outer=process.argv[3];
assert.ok(["normal","slow","timeout","failed","cancelled","skipped","wrong-count"].includes(scenario));
const root=fileURLToPath(new URL("../../",import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
process.env.npm_execpath="/offline/fixture-npm-cli.js";
process.env.OPENAI_API_KEY="synthetic-host-credential-must-not-propagate";
let temporary, consumerOptions;
const response=stdout=>({status:0,signal:null,stdout,stderr:""});
const boundary=mock.module("node:child_process",{namedExports:{spawnSync(command,args,options){
  assert.equal(command,process.execPath);assert.equal(options.maxBuffer,16*1024*1024);
  assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.NPM_CONFIG_REGISTRY,"https://registry.npmjs.org");
  if(args[0]===process.env.npm_execpath&&args[1]==="pack"){
    temporary=args[args.indexOf("--pack-destination")+1];
    assert.equal(options.env.HOME,temporary);assert.equal(fs.statSync(options.env.NPM_CONFIG_USERCONFIG).mode&0o7777,0o600);
    return response(JSON.stringify([{filename:"fixture.tgz",files:[{path:"package.json",size:100}]}]));
  }
  if(args[0]===process.env.npm_execpath&&args[1]==="install"){
    for(const flag of ["--global","--ignore-scripts","--prefer-online","--no-audit","--no-fund"])assert.ok(args.includes(flag));
    const installed=path.join(args[args.indexOf("--prefix")+1],"lib/node_modules",manifest.name);
    fs.mkdirSync(installed,{recursive:true});fs.writeFileSync(path.join(installed,"package.json"),JSON.stringify({name:manifest.name,version:manifest.version,bin:{aginti:"bin/fixture.js","aginti-cli":"bin/fixture.js"}}));
    return response("fixture install\n");
  }
  if(args.at(-1)==="--version")return response(manifest.version+"\n");
  assert.ok(args.includes("--test"));assert.ok(args.includes("--test-concurrency=2"));
  consumerOptions={timeout:options.timeout,concurrency:2};
  const total=scenario==="wrong-count"?1351:1352;
  const incomplete=["failed","cancelled","skipped"].includes(scenario);
  const counts=`# tests ${total}\n# pass ${total-(incomplete?1:0)}\n# fail ${scenario==="failed"?1:0}\n# cancelled ${scenario==="cancelled"?1:0}\n# skipped ${scenario==="skipped"?1:0}\n`;
  if(scenario==="timeout"||(scenario==="slow"&&options.timeout<240000)){
    return {status:null,signal:"SIGTERM",error:Object.assign(new Error("fixture consumer ETIMEDOUT"),{code:"ETIMEDOUT"}),
      stdout:"fixture-progress-before-timeout\n",stderr:"fixture-stderr-before-timeout\n"};
  }
  return {...response(counts),status:scenario==="failed"?19:0,stderr:scenario==="failed"?"fixture-nonzero-exit\n":""};
}}});
try{await import(new URL("../../scripts/verify-package-runtime.js",import.meta.url));}
catch(error){console.error(error.stack);process.exitCode=1;}
finally{
  boundary.restore();
  fs.writeFileSync(path.join(outer,"fixture-result.json"),JSON.stringify({scenario,consumerOptions,temporaryRemoved:!fs.existsSync(temporary),realNpmCalls:0,modelCalls:0}));
}
