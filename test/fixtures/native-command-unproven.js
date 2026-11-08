import fs from "node:fs";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {mock} from "node:test";
const [releasePath,mode]=process.argv.slice(2);let child;
const realKill=process.kill;
process.kill=(pid,signal)=>{
  if(pid!==-3000001)throw new Error("Unrelated signal refused");
  if(signal===0){
    if(mode==="closed"||fs.existsSync(releasePath))throw Object.assign(new Error("absent"),{code:"ESRCH"});
    return true;
  }
  if(signal!=="SIGTERM")throw new Error("Owner is already closed; no late signal is allowed");
  return true;
};
mock.module("node:child_process",{namedExports:{spawn(command,args){
  child=new EventEmitter();Object.assign(child,{pid:3000001,args,stdout:new PassThrough(),stderr:new PassThrough(),send(){}});return child;
}}});
const {runNativeHostCommand}=await import("../../src/native-host-command.js");
const abort=new AbortController();
try{
  const result=runNativeHostCommand("printf ordinary",{cwd:"/tmp",env:{},shell:"/bin/sh",signal:abort.signal,timeoutMs:0,
    onShutdownPending(){console.log("SHUTDOWN_UNPROVEN_OBSERVER_ACTIVE");}});
  result.catch(()=>{});
  child.emit("message",{version:1,type:"ready",token:child.args[1]});abort.abort();
  child.emit("exit",null,"SIGTERM");child.emit("close",null,"SIGTERM");
  try{await result;throw new Error("Abort must not succeed");}catch(error){if(error.code!=="ABORT_ERR")throw error;}
  console.log("OWNERSHIP_CLOSED");
}finally{process.kill=realKill;mock.restoreAll();}
