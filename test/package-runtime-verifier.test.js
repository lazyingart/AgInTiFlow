import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture=fileURLToPath(new URL("./fixtures/package-runtime-verifier.js",import.meta.url));
function run(scenario){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"aginti-verifier-contract-"));
  try{
    const result=spawnSync(process.execPath,["--experimental-test-module-mocks",fixture,scenario,root],{
      env:{PATH:process.env.PATH,HOME:root,LANG:"C.UTF-8"},encoding:"utf8",timeout:10000,maxBuffer:1024*1024});
    assert.ifError(result.error);assert.equal(result.signal,null);
    const receipt=JSON.parse(fs.readFileSync(path.join(root,"fixture-result.json"),"utf8"));
    assert.equal(receipt.temporaryRemoved,true);assert.equal(receipt.realNpmCalls,0);assert.equal(receipt.modelCalls,0);
    assert.equal(receipt.consumerOptions.concurrency,2);assert.ok(receipt.consumerOptions.timeout<=600000);
    return {...result,receipt};
  }finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}
}

for(const scenario of ["normal","slow"])test(`complete consumer cohort succeeds on ${scenario} host without dropping cases`,()=>{
  const result=run(scenario);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"consumerTests":1322/);
  assert.match(result.stdout,/"passedTests":1322/);assert.match(result.stdout,/"cancelledTests":0/);assert.match(result.stdout,/"skippedTests":0/);
  if(scenario==="slow")assert.ok(result.receipt.consumerOptions.timeout>=240000,"Full cohort needs a finite budget beyond the old180-second cutoff");
});
test("outer watchdog failure preserves child progress and stderr and still fails",()=>{
  const result=run("timeout");assert.notEqual(result.status,0);assert.match(result.stderr,/fixture-progress-before-timeout/);assert.match(result.stderr,/fixture-stderr-before-timeout/);assert.match(result.stderr,/ETIMEDOUT/);
});
test("nonzero consumer exit preserves both diagnostics and cannot become success",()=>{
  const result=run("failed");assert.notEqual(result.status,0);assert.match(result.stderr,/# fail 1/);assert.match(result.stderr,/fixture-nonzero-exit/);
});
for(const scenario of ["cancelled","skipped","wrong-count"])test(`${scenario} cohort cannot qualify through a zero exit`,()=>{
  const result=run(scenario);assert.notEqual(result.status,0,"Every required case must finish and pass");
});
