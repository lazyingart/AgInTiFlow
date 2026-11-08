import assert from "node:assert/strict";
import {EventEmitter,getEventListeners} from "node:events";
import {PassThrough} from "node:stream";
import {mock,test,after} from "node:test";

// Only the private process transport is mocked. No OS signal, command, model
// or service is launched in this file. Genuine native tests live separately.
const nativeKill=process.kill;
let children=[],signals=[],probes=0,group="alive",spawnError=null,duringSpawn=null,killError=null;
process.kill=(pid,signal)=>{
  assert.equal(pid,-3000001,"refuse any unrelated numeric process group");
  if(signal===0){probes++;if(group==="absent")throw Object.assign(new Error("absent"),{code:"ESRCH"});if(group==="unknown")throw Object.assign(new Error("denied"),{code:"EPERM"});return true;}
  signals.push(signal);if(signal==="SIGKILL"&&killError)throw killError;return true;
};
mock.module("node:child_process",{namedExports:{spawn(command,args,options){
  if(spawnError)throw spawnError;
  const child=new EventEmitter();
  Object.assign(child,{pid:3000001,command,args,options,stdout:new PassThrough(),stderr:new PassThrough(),
    exitCode:null,signalCode:null,killed:false,messages:[],
    send(message,callback){child.messages.push(message);callback?.(null);},
  });children.push(child);duringSpawn?.();return child;
}}});
const {runNativeHostCommand}=await import("../src/native-host-command.js");
after(()=>{process.kill=nativeKill;mock.restoreAll();});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,options={}){
  children=[];signals=[];probes=0;group="alive";spawnError=null;duringSpawn=null;killError=null;
  t.mock.timers.enable({apis:["setTimeout","setInterval"]});
  const abort=new AbortController();let pending=0;
  const config={cwd:"/tmp",env:{PATH:"/usr/bin:/bin"},shell:"/bin/sh",signal:abort.signal,timeoutMs:0,
    onShutdownPending(){pending++;},...options};
  const start=()=>{
    const promise=runNativeHostCommand("printf ordinary",config);promise.catch(()=>{});
    return {promise,child:children.at(-1)};
  };
  return {abort,config,start,pending:()=>pending};
}
function ready(child){child.emit("message",{version:1,type:"ready",token:child.args[1]});}
function result(child,code=0,signal=null,error=""){
  child.emit("message",{version:1,type:"command-closed",token:child.args[1],code,signal,error});
}
function close(child,code=0,signal=null){
  child.exitCode=code;child.signalCode=signal;child.emit("exit",code,signal);
  child.stdout.end();child.stderr.end();child.emit("close",code,signal);
}
function spec(name,fn){test(name,{skip:process.platform==="win32"},fn);}

spec("pre-cancelled native host work spawns nothing",async t=>{
  const f=setup(t);f.abort.abort(Object.freeze(new DOMException("Stop","AbortError")));
  await assert.rejects(f.start().promise,{name:"AbortError",code:"ABORT_ERR"});assert.equal(children.length,0);assert.deepEqual(signals,[]);
});
spec("synchronous spawn failure creates no timers or dispatch",async t=>{
  const f=setup(t);spawnError=Object.assign(new Error("Synthetic spawn failure"),{code:"EAGAIN"});
  await assert.rejects(f.start().promise,{code:"EAGAIN"});assert.equal(children.length,0);t.mock.timers.tick(10000);assert.deepEqual(signals,[]);
});
spec("invalid command data is refused before spawning or coercion",async t=>{
  const f=setup(t);let traps=0;
  const hostile=new Proxy({},{get(){traps++;throw Error("coercion");}});
  for(const command of [null,{},hostile,"","bad\0command","bad\ud800","x".repeat(2*1024*1024+1)]){
    await assert.rejects(runNativeHostCommand(command,f.config),{code:"HOST_COMMAND_INVALID"});
  }
  assert.equal(children.length,0);assert.equal(traps,0);
});
spec("invalid server shell data is refused before spawning",async t=>{
  const f=setup(t);
  for(const shell of [true,{},"","bad\0shell","bad\ud800","x".repeat(4097)]){
    await assert.rejects(runNativeHostCommand("printf ordinary",{...f.config,shell}),{code:"HOST_COMMAND_INVALID"});
  }
  assert.equal(children.length,0);
});
spec("cancellation during supervisor setup never releases a command",async t=>{
  const f=setup(t);duringSpawn=()=>f.abort.abort();const {promise,child}=f.start();ready(child);
  assert.equal(child.messages.length,0);assert.deepEqual(signals,["SIGTERM"]);
  t.mock.timers.tick(1200);assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
  group="absent";close(child,null,"SIGKILL");await assert.rejects(promise,{code:"ABORT_ERR"});
  assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
spec("ordinary explicit zero command exit preserves output and release",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);
  assert.equal(child.command,process.execPath);assert.equal(child.options.detached,true);
  assert.equal(child.messages[0].type,"start");assert.equal(child.messages[0].command,"printf ordinary");
  child.stdout.write("observed output");result(child);assert.equal(child.messages[1].type,"release");close(child);
  const value=await promise;assert.equal(value.ok,true);assert.equal(value.exitCode,0);assert.equal(value.stdout,"observed output");assert.equal(value.lifecycle,"normal-exit");
  assert.equal(probes,0,"ordinary foreground exit does not claim background-group termination");
  t.mock.timers.tick(10000);assert.deepEqual(signals,[]);assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
spec("ordinary nonzero exit remains a quiescent command failure",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);result(child,7);close(child);
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.exitCode,7);assert.equal(value.lifecycle,"normal-exit");
});
spec("TERM resistance and child.killed never suppress escalation or release early",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);let settled=false;promise.finally(()=>{settled=true;}).catch(()=>{});
  f.abort.abort();child.killed=true;t.mock.timers.tick(1199);await turn();assert.equal(settled,false);assert.deepEqual(signals,["SIGTERM"]);
  t.mock.timers.tick(1);assert.deepEqual(signals,["SIGTERM","SIGKILL"]);await turn();assert.equal(settled,false);
  group="absent";close(child,null,"SIGKILL");await assert.rejects(promise,{code:"ABORT_ERR"});
  const count=probes;t.mock.timers.tick(10000);assert.equal(probes,count);assert.equal(getEventListeners(f.abort.signal,"abort").length,0);
});
spec("zero exit during cancellation still requires absence and returns abort",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);f.abort.abort();result(child);close(child);
  let settled=false;promise.catch(()=>{settled=true;});await turn();assert.equal(settled,false);
  group="absent";t.mock.timers.tick(100);await assert.rejects(promise,{code:"ABORT_ERR"});
});
spec("early owner exit with a live group holds uncertainty without stale kills",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);f.abort.abort();close(child,null,"SIGTERM");
  let settled=false;promise.catch(()=>{settled=true;});t.mock.timers.tick(4200);await turn();
  assert.equal(settled,false);assert.equal(f.pending(),1);assert.deepEqual(signals,["SIGTERM"],"lost owner cannot authorize later PGID signalling");
  group="absent";t.mock.timers.tick(1000);await assert.rejects(promise,{code:"ABORT_ERR"});
});
spec("probe permission failure is unknown, not proof of shutdown",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);f.abort.abort();group="unknown";close(child,null,"SIGKILL");
  let settled=false;promise.catch(()=>{settled=true;});t.mock.timers.tick(4200);await turn();assert.equal(settled,false);assert.equal(f.pending(),1);
  group="absent";t.mock.timers.tick(1000);await assert.rejects(promise,{code:"ABORT_ERR"});
});
spec("unproven-shutdown diagnostics cannot reject or leak an async callback error",async t=>{
  let unhandled=0;const listener=()=>{unhandled++;};process.on("unhandledRejection",listener);t.after(()=>process.removeListener("unhandledRejection",listener));
  const f=setup(t,{onShutdownPending:()=>Promise.reject(new Error("Synthetic observer failure"))}),{promise,child}=f.start();ready(child);f.abort.abort();
  t.mock.timers.tick(4200);await turn();assert.equal(unhandled,0);
  group="absent";close(child,null,"SIGKILL");await assert.rejects(promise,{code:"ABORT_ERR"});
});
spec("timeout cannot settle before closure, even if final command exit is zero",async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);result(child);group="absent";close(child);
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.exitCode,124);assert.equal(value.lifecycle,"timeout");assert.equal(value.observedCommandExitCode,0);
});
spec("abort wins a timeout race before final settlement",async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);f.abort.abort();group="absent";close(child,null,"SIGKILL");
  await assert.rejects(promise,{code:"ABORT_ERR"});
});
for(const order of ["error-before-timeout","timeout-before-error"])spec(`verification failure stays fatal (${order})`,async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);
  if(order==="timeout-before-error")t.mock.timers.tick(20);
  child.emit("message",{version:1,type:"command-closed",token:child.args[1],code:0,signal:null,error:"",extra:true});
  if(order==="error-before-timeout")t.mock.timers.tick(20);
  close(child,null,"SIGKILL");let settled=false;promise.then(()=>{settled=true;});
  t.mock.timers.tick(4200);await turn();assert.equal(settled,false);assert.equal(f.pending(),1);
  group="absent";t.mock.timers.tick(1000);const value=await promise;
  assert.equal(value.ok,false);assert.equal(value.exitCode,1);assert.equal(value.lifecycleVerificationFailed,true);assert.equal(value.lifecycle,"process-error");
  assert.match(value.stderr,/supervisor failed/);assert.match(value.stderr,/timed out/);
});
for(const order of ["error-before-timeout","timeout-before-error"])spec(`valid process-error receipt stays fatal (${order})`,async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);
  if(order==="timeout-before-error")t.mock.timers.tick(20);
  result(child,1,null,"Synthetic command spawn failure");
  if(order==="error-before-timeout")t.mock.timers.tick(20);
  close(child,null,"SIGKILL");let settled=false;promise.then(()=>{settled=true;});
  t.mock.timers.tick(4200);await turn();assert.equal(settled,false);
  group="absent";t.mock.timers.tick(1000);const value=await promise;
  assert.equal(value.ok,false);assert.equal(value.exitCode,1);assert.equal(value.lifecycleVerificationFailed,true);
  assert.equal(value.lifecycle,"process-error");assert.equal(value.observedCommandExitCode,1);
  assert.match(value.stderr,/Synthetic command spawn failure/);assert.match(value.stderr,/timed out/);
});
for(const withReceipt of [false,true])for(const signalName of [null,"SIGSEGV"])spec(`abnormal owner closure after timeout stays fatal (receipt ${withReceipt}, signal ${signalName})`,async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);
  if(withReceipt)result(child);
  group="absent";close(child,signalName?null:7,signalName);const value=await promise;
  assert.equal(value.ok,false);assert.equal(value.exitCode,1);assert.equal(value.lifecycleVerificationFailed,true);
  assert.equal(value.lifecycle,"process-error");assert.equal(value.observedCommandExitCode,withReceipt?0:null);
  assert.match(value.stderr,/supervisor did not close normally/);assert.match(value.stderr,/timed out/);
});
spec("expected owner KILL during timeout teardown remains an ordinary timeout",async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);t.mock.timers.tick(1200);
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);group="absent";close(child,null,"SIGKILL");
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.exitCode,124);
  assert.equal(value.lifecycleVerificationFailed,false);assert.equal(value.lifecycle,"timeout");
});
for(const withReceipt of [false,true])spec(`owner KILL before parent escalation remains fatal (receipt ${withReceipt})`,async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);
  if(withReceipt)result(child);
  assert.deepEqual(signals,["SIGTERM"]);group="absent";close(child,null,"SIGKILL");
  const value=await promise;assert.equal(value.lifecycleVerificationFailed,true);assert.equal(value.lifecycle,"process-error");
  assert.equal(value.exitCode,1);assert.equal(value.observedCommandExitCode,withReceipt?0:null);
});
spec("failed KILL request cannot explain an independent owner KILL",async t=>{
  const f=setup(t,{timeoutMs:20}),{promise,child}=f.start();ready(child);t.mock.timers.tick(20);
  killError=Object.assign(new Error("Synthetic permission failure"),{code:"EPERM"});t.mock.timers.tick(1200);
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);group="absent";close(child,null,"SIGKILL");
  const value=await promise;assert.equal(value.lifecycleVerificationFailed,true);assert.equal(value.lifecycle,"process-error");assert.equal(value.exitCode,1);
});
spec("a real command signal is never coerced to successful zero",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);result(child,null,"SIGTERM");assert.deepEqual(signals,["SIGTERM"]);
  t.mock.timers.tick(1200);group="absent";close(child,null,"SIGKILL");
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.exitCode,130);assert.equal(value.lifecycle,"signal");
});
spec("owner signal or missing command receipt cannot become a normal success",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);group="absent";close(child,null,"SIGTERM");
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.lifecycle,"process-error");assert.equal(value.observedCommandExitCode,null);
});
spec("process error after spawn waits for teardown",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);child.emit("error",new Error("Synthetic process failure"));
  let settled=false;promise.then(()=>{settled=true;});t.mock.timers.tick(1200);await turn();assert.equal(settled,false);
  group="absent";close(child,null,"SIGKILL");const value=await promise;assert.equal(value.ok,false);assert.equal(value.lifecycle,"process-error");
});
spec("abnormal owner closure preserves the separate observed command exit",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);result(child);group="absent";close(child,7);
  const value=await promise;assert.equal(value.ok,false);assert.equal(value.observedCommandExitCode,0);assert.equal(value.lifecycle,"process-error");
});
for(const mode of ["proxy","accessor","extra","wrong-token","wrong-version"])spec(`private lifecycle envelope rejects ${mode}`,async t=>{
  const f=setup(t),{promise,child}=f.start();let traps=0;
  const message={version:1,type:"ready",token:child.args[1]};let input=message;
  if(mode==="proxy")input=new Proxy(message,{get(){traps++;throw Error("private");},ownKeys(){traps++;throw Error("private");}});
  if(mode==="accessor")Object.defineProperty(message,"type",{enumerable:true,get(){traps++;throw Error("private");}});
  if(mode==="extra")message.extra="private";
  if(mode==="wrong-token")message.token="different";
  if(mode==="wrong-version")message.version=2;
  child.emit("message",input);assert.equal(traps,0);assert.equal(child.messages.length,0);
  group="absent";close(child,null,"SIGKILL");const value=await promise;assert.equal(value.ok,false);assert.equal(value.stderr.includes("private"),false);
});
spec("stdout cannot impersonate the supervisor receipt",async t=>{
  const f=setup(t),{promise,child}=f.start();ready(child);
  child.stdout.write(JSON.stringify({version:1,type:"command-closed",token:child.args[1],code:0,signal:null,error:""}));
  group="absent";close(child);const value=await promise;assert.equal(value.ok,false);assert.equal(value.lifecycle,"process-error");
});
