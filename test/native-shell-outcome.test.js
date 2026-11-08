import assert from "node:assert/strict";
import test from "node:test";
import {normalizeNoMatchQueryResult} from "../src/agent-runner.js";

test("only an actual normal exit can authorize native no-match success",()=>{
  const policy={noMatchExitIsSuccess:true};
  for(const lifecycle of ["timeout","signal","process-error","unknown"]){
    const input={ok:false,exitCode:1,stdout:"",stderr:"",lifecycle};
    assert.equal(normalizeNoMatchQueryResult(input,policy),input,lifecycle);
  }
  const result=normalizeNoMatchQueryResult({ok:false,exitCode:1,stdout:"",stderr:"",lifecycle:"normal-exit"},policy);
  assert.equal(result.ok,true);assert.equal(result.noMatch,true);
  const failed={ok:false,exitCode:1,stdout:"",stderr:"",lifecycle:"normal-exit",lifecycleVerificationFailed:true};
  assert.equal(normalizeNoMatchQueryResult(failed,policy),failed,"sticky verification failure overrides a presentation label");
});
test("no-match inspection retains nullable and primitive compatibility",()=>{
  for(const value of [null,undefined,false,0,""]){
    const result=normalizeNoMatchQueryResult(value,{});
    if(value===undefined)assert.deepEqual(result,{});else assert.equal(result,value);
  }
});
test("existing Docker and legacy no-match envelopes preserve their contract",()=>{
  const result=normalizeNoMatchQueryResult({ok:false,exitCode:1,stdout:"",stderr:""},{noMatchExitIsSuccess:true});
  assert.equal(result.ok,true);assert.equal(result.semanticOutcome,"no-match");
});
