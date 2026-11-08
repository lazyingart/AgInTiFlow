import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import test from "node:test";
function deadline(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
for(const mode of ["pending","closed"])test(`actual native passive observer (${mode})`,{skip:process.platform==="win32",timeout:10000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"aginti-command-observer-"));let child,closed;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    if(closed)await deadline(closed.catch(()=>{}),2000,"own fixture cleanup deadline");
    await fs.rm(root,{recursive:true,force:true});
  });
  child=spawn(process.execPath,["--experimental-test-module-mocks",new URL("./fixtures/native-command-unproven.js",import.meta.url).pathname,root+"/release",mode],{
    env:{PATH:process.env.PATH,HOME:root,LANG:"C.UTF-8"},stdio:["ignore","pipe","pipe"],
  });
  let output="",stderr="",notify;
  const observed=new Promise(resolve=>{notify=resolve;});
  child.stdout.on("data",part=>{output+=part;if(output.includes("SHUTDOWN_UNPROVEN_OBSERVER_ACTIVE"))notify();});
  child.stderr.on("data",part=>{stderr+=part;});
  closed=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});closed.catch(()=>{});
  if(mode==="pending"){
    await deadline(Promise.race([observed,closed.then(value=>{throw new Error("CLI exited while shutdown unproven: "+JSON.stringify({value,stderr,output}));})]),6500,"pending observer diagnostic deadline");
    // All finite escalation/diagnostic timers have fired. No IPC/input handle
    // or fixture polling timer keeps this child alive; only the native observer.
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    await fs.writeFile(root+"/release","observed absence\n",{mode:0o600});
  }
  const outcome=await deadline(closed,mode==="closed"?2500:2500,"closure observation deadline");
  assert.equal(outcome.code,0,stderr);assert.equal(outcome.signal,null);assert.match(output,/OWNERSHIP_CLOSED/);
  if(mode==="closed")assert.equal(output.includes("SHUTDOWN_UNPROVEN_OBSERVER_ACTIVE"),false);
});
