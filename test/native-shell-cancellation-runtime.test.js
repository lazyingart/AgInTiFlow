import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {spawn,execFileSync} from "node:child_process";
import test from "node:test";
import {acquireNativeSessionRunLock} from "../src/session-run-lock.js";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function bounded(promise,label,ms=10000){
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+" deadline")),ms);})]).finally(()=>clearTimeout(timer));
}
async function alive(record){
  try{
    const fields=(await fs.readFile("/proc/"+record.pid+"/stat","utf8")).split(") ")[1].split(" ");
    return fields[19]===record.startTicks&&!["Z","X"].includes(fields[0]);
  }catch(error){if(error.code==="ENOENT")return false;throw error;}
}

for(const mode of ["foreground","early-root","unknown","bad-receipt","error-before-timeout","timeout-before-error","valid-error-before-timeout","valid-timeout-before-error"])test(`native cancellation retains session ownership until the real checker stops (${mode})`,{skip:process.platform!=="linux",timeout:20000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"aginti-native-shell-cancel-")),workspace=root+"/workspace";
  const sticky=["error-before-timeout","timeout-before-error","valid-error-before-timeout","valid-timeout-before-error"].includes(mode),fault=mode==="bad-receipt"||sticky,uncertain=mode==="unknown"||sticky;
  let child,server,worker,closed,closing=false;const errors=[];
  t.after(async()=>{
    closing=true;
    if(uncertain)await fs.writeFile(root+"/allow-absence","cleanup observation\n").catch(()=>{});
    // Let the old implementation's bounded escalation expire even in the red
    // regression run. Never abandon its still-scheduled process-group signal.
    if(child){
      try{await bounded(closed,"owned native fixture close",6500);}catch{
        if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
        await bounded(closed.catch(()=>{}),"killed fixture close",3000);
      }
    }
    if(worker&&await alive(worker))execFileSync("/usr/bin/python3",["-c",`import os,signal,sys
p=int(sys.argv[1]);f=os.pidfd_open(p)
try:
 assert open('/proc/'+str(p)+'/stat').read().rsplit(')',1)[1].split()[19]==sys.argv[2]
 signal.pidfd_send_signal(f,signal.SIGKILL)
finally:os.close(f)`,String(worker.pid),worker.startTicks]);
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await fs.rm(root,{recursive:true,force:true});
  });
  await fs.mkdir(workspace);
  const checker=`const fs=require('node:fs');process.on('SIGTERM',()=>{});const s=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ');fs.writeFileSync('ready.json',JSON.stringify({pid:process.pid,startTicks:s[19]}));setInterval(()=>fs.appendFileSync('ticks.txt','tick\\n'),40);setTimeout(()=>process.exit(0),5000);`;
  const selected=fault?checker+`setInterval(()=>{if(fs.existsSync('complete'))process.exit(0);},20);`:mode!=="early-root"?checker:`require('node:child_process').spawn(process.execPath,['leaf.cjs'],{stdio:'ignore'});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),6000);`;
  await fs.writeFile(workspace+"/check.cjs",selected);
  if(mode==="early-root")await fs.writeFile(workspace+"/leaf.cjs",checker);
  let requests=0,transportRequests=0;
  server=http.createServer(async(req,res)=>{
    try{
      transportRequests++;
      let bytes=0;const parts=[];for await(const part of req){bytes+=part.length;assert.ok(bytes<2*1024*1024);parts.push(part);}
      const body=JSON.parse(Buffer.concat(parts));let message;
      if(!body.tools)message={content:"Inspect and run the existing checker; stop its work if cancelled."};
      else{
        requests++;assert.ok(requests<=2,"cancel must not start a provider continuation");
        const name=requests===1?"read_file":"run_command",args=requests===1?{path:"check.cjs"}:{command:"node check.cjs"};
        message={tool_calls:[{id:"owned_check_"+requests,type:"function",function:{name,arguments:JSON.stringify(args)}}]};
      }
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?"tool_calls":"stop",message:{role:"assistant",content:null,...message}}]}));
    }catch(error){errors.push(error.message);res.writeHead(400);res.end('{"error":{"message":"Offline cancellation fixture refused"}}');}
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  child=spawn(process.execPath,["--experimental-test-module-mocks",new URL("./fixtures/native-shell-cancellation-runtime.js",import.meta.url).pathname,
    root,"http://127.0.0.1:"+server.address().port+"/v1",mode],{
    env:{PATH:process.env.PATH,LANG:"C.UTF-8",HOME:root,AGINTIFLOW_HOME:root+"/agent-home",
      XDG_CONFIG_HOME:root+"/config",AGINTIFLOW_NO_AUTO_UPDATE:"1",AGINTIFLOW_NO_WEB_AUTO_START:"1"},
    stdio:["ignore","pipe","pipe","ipc"],
  });
  let output="",stderr="";child.stdout.on("data",p=>{output+=p;});child.stderr.on("data",p=>{stderr+=p;});
  closed=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});closed.catch(()=>{});
  let resolveSettled,resolvePending,resolveFailure,resolveDeadline;const settled=new Promise(resolve=>{resolveSettled=resolve;});
  const pending=new Promise(resolve=>{resolvePending=resolve;}),failure=new Promise(resolve=>{resolveFailure=resolve;}),deadline=new Promise(resolve=>{resolveDeadline=resolve;});let resultSeen=false;
  child.on("message",message=>{
    if(message.type==="settled"){resultSeen=true;resolveSettled(message);}
    if(message.type==="shutdown-pending")resolvePending();
    if(message.type==="verification-failed")resolveFailure();
    if(message.type==="timeout-injected")resolveDeadline();
  });
  await bounded((async()=>{
    for(;;){
      if(closing||child.exitCode!==null||child.signalCode!==null)throw new Error("Owned fixture closed before readiness: "+stderr+output);
      try{worker=JSON.parse(await fs.readFile(workspace+"/ready.json","utf8"));return;}
      catch(error){if(error.code!=="ENOENT")throw error;}
      await sleep(10);
    }
  })(),"native worker readiness");
  assert.equal(await alive(worker),true);
  await assert.rejects(acquireNativeSessionRunLock({sessionsDir:root+"/sessions"},"native-shell-cancellation"),{code:"SESSION_RUN_ACTIVE"});
  const beforeStopRequests=transportRequests;
  if(mode.endsWith("timeout-before-error")){child.send({action:"timeout"});await bounded(deadline,"native deadline injection");}
  if(fault)await fs.writeFile(workspace+"/complete","finish own checker\n");else child.send({action:"abort"});
  if(sticky){
    await bounded(failure,"native receipt corruption");
    if(mode.endsWith("error-before-timeout")){child.send({action:"timeout"});await bounded(deadline,"native deadline injection");}
  }
  if(uncertain){
    await bounded(Promise.race([pending,settled.then(value=>{throw new Error("Shutdown uncertainty released the native run: "+JSON.stringify(value));})]),"native shutdown diagnostic");
    assert.equal(resultSeen,false);assert.equal(requests,2);assert.equal(transportRequests,beforeStopRequests);
    await assert.rejects(acquireNativeSessionRunLock({sessionsDir:root+"/sessions"},"native-shell-cancellation"),{code:"SESSION_RUN_ACTIVE"});
    const recorded=(await fs.readFile(root+"/sessions/native-shell-cancellation/events.jsonl","utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(recorded.some(event=>event.type==="session.stopped"),false,"unproven shutdown is not a public terminal event");
    await fs.writeFile(root+"/allow-absence","allow current absence observation\n",{mode:0o600});
  }
  const reported=await bounded(settled,"native cancellation result");
  const liveAtReturn=await alive(worker);
  assert.equal(liveAtReturn,false,"native cancellation returned while its owned checker was still executing");
  const first=await fs.readFile(workspace+"/ticks.txt","utf8").catch(error=>{if(error.code==="ENOENT")return "";throw error;});
  await sleep(100);assert.equal(await fs.readFile(workspace+"/ticks.txt","utf8").catch(error=>{if(error.code==="ENOENT")return "";throw error;}),first,"no checker work after cancellation result");
  assert.equal(reported.result?.reason,fault?"native_command_lifecycle":"user_interrupt",JSON.stringify(reported));assert.equal(reported.result?.stopped,true);
  if(fault){
    assert.equal(reported.result.failed,true);
    const state=JSON.parse(await fs.readFile(root+"/sessions/native-shell-cancellation/state.json","utf8"));
    const failed=state.messages.filter(message=>message.role==="tool"&&message.tool_call_id==="owned_check_2").map(message=>JSON.parse(message.content));
    assert.equal(failed.length,1);assert.equal(failed[0].category,"native-command-lifecycle");assert.equal(failed[0].stopRun,true);
    assert.equal(failed[0].permissionAdvice,undefined);assert.equal(JSON.stringify(failed).includes("synthetic-extra-private-field"),false);
    if(sticky)assert.match(failed[0].stderr,/timed out/);
    if(mode.startsWith("valid-"))assert.match(failed[0].stderr,/Synthetic command spawn failure/);
  }
  await assert.rejects(fs.stat(root+"/sessions/native-shell-cancellation/.agent-run.lock"),{code:"ENOENT"});
  const outcome=await bounded(closed,"native process close");assert.equal(outcome.code,0,stderr+output);assert.deepEqual(errors,[]);assert.equal(requests,2);assert.equal(transportRequests,beforeStopRequests);
  t.diagnostic(JSON.stringify({mode,realNativeRuntime:true,realOwnedChecker:true,actualProviderRequests:0,modelToolTurns:requests,scriptedHttpRequests:transportRequests,checkerStoppedBeforeReturn:true,sessionReleasedAfterStop:true}));
});
