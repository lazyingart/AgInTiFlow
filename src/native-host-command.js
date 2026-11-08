import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {dataFields} from "./restricted-application-contract.js";

const OWNER=fileURLToPath(new URL("./native-host-command-worker.js",import.meta.url));
const signalGroup=process.kill.bind(process);
const TERM_GRACE_MS=1200,OBSERVATION_WINDOW_MS=4200;

function abortError(){return Object.assign(new Error("Run interrupted by user."),{name:"AbortError",code:"ABORT_ERR"});}

// POSIX native CLI lifecycle only: no hostile-session containment, cgroup or
// remote-engine proof. Windows retains its separately unqualified legacy path.
// Unknown shutdown stays pending, retaining the caller's native session lease.
export function runNativeHostCommand(command,{cwd,env,shell,signal,timeoutMs,onShutdownPending}={}){
  if(signal?.aborted)return Promise.reject(abortError());
  if(process.platform==="win32")return Promise.reject(Object.assign(new Error("POSIX command ownership is unavailable."),{code:"HOST_COMMAND_PLATFORM_UNSUPPORTED"}));
  if(typeof command!=="string"||!command||!command.isWellFormed()||command.includes("\0")||Buffer.byteLength(command)>2*1024*1024||
      typeof shell!=="string"||!shell||!shell.isWellFormed()||shell.includes("\0")||Buffer.byteLength(shell)>4096||
      typeof cwd!=="string"||!cwd) {
    return Promise.reject(Object.assign(new Error("Native command input is invalid or exceeds its bounded profile."),{code:"HOST_COMMAND_INVALID"}));
  }
  return new Promise((resolve,reject)=>{
    const token=randomUUID();
    const child=spawn(process.execPath,[OWNER,token],{cwd,env,detached:true,stdio:["ignore","pipe","pipe","ipc"],serialization:"json"});
    let stdout="",stderr="",settled=false,ready=false,started=false,received=null;
    let stopping=false,aborted=false,timedOut=false,ownerExited=false,ownerClosed=false,ownerCode=null,ownerSignal=null,killDelivered=false;
    let processError="",verificationFailed=false,timer=null,killTimer=null,observeTimer=null,pendingTimer=null;
    const markFailure=message=>{verificationFailed=true;if(!processError)processError=message;};
    const validPid=()=>Number.isSafeInteger(child.pid)&&child.pid>0;
    const absent=()=>{
      if(!validPid())return ownerClosed;
      try{signalGroup(-child.pid,0);return false;}catch(error){return error?.code==="ESRCH";}
    };
    const cleanup=()=>{
      for(const handle of [timer,killTimer,pendingTimer])if(handle)clearTimeout(handle);
      if(observeTimer)clearInterval(observeTimer);
      signal?.removeEventListener("abort",onAbort);
    };
    const settle=()=>{
      if(settled||!ownerClosed||stopping&&!absent())return;
      settled=true;cleanup();
      if(aborted){reject(abortError());return;}
      const normal=!timedOut&&!verificationFailed&&!ownerSignal&&ownerCode===0&&received&&received.signal===null&&!received.error;
      const code=verificationFailed?1:timedOut?124:ownerSignal?130:received?.signal?130:received?.code??1;
      const message=processError||received?.error||(received?.signal?`Command ended with ${received.signal}.`:ownerSignal?`Native command supervisor ended with ${ownerSignal}.`:"");
      resolve({ok:Boolean(normal&&received.code===0),exitCode:code,stdout,
        stderr:stderr+(message?`${stderr?"\n":""}${message}`:"")+(timedOut?`\nCommand timed out after ${timeoutMs}ms.`:""),
        lifecycleVerificationFailed:verificationFailed,
        lifecycle:verificationFailed?"process-error":timedOut?"timeout":ownerSignal||received?.signal?"signal":"normal-exit",
        observedCommandExitCode:received?.code??null});
    };
    const sendSignal=name=>{
      // The fixed owner ignores TERM and keeps its group identity while it is
      // our unexited child. Once identity is lost, never signal a reusable PGID.
      if(settled||ownerExited||!validPid())return;
      try{const delivered=signalGroup(-child.pid,name);if(name==="SIGKILL"&&delivered===true)killDelivered=true;}catch{ /* Absence/permission is observed separately; never assume shutdown. */ }
    };
    const stop=()=>{
      if(stopping||settled)return;
      stopping=true;
      // These observers are referenced: a pending Promise must not let the CLI
      // exit and make its still-active session look safely recoverable.
      observeTimer=setInterval(settle,100);
      killTimer=setTimeout(()=>sendSignal("SIGKILL"),TERM_GRACE_MS);
      pendingTimer=setTimeout(()=>{
        settle();if(settled)return;
        clearInterval(observeTimer);observeTimer=setInterval(settle,1000);
        try{Promise.resolve(onShutdownPending?.()).catch(()=>{});}catch{}
      },OBSERVATION_WINDOW_MS);
      sendSignal("SIGTERM");settle();
    };
    const fail=()=>{markFailure("Native command supervisor failed or returned invalid lifecycle evidence.");stop();};
    const send=message=>{
      try{child.send(message,error=>{if(error&&!settled)fail();});}catch{if(!settled)fail();}
    };
    const onAbort=()=>{aborted=true;stop();};
    child.stdout?.on("data",chunk=>{if(stdout.length<220*1024)stdout+=chunk.toString();});
    child.stderr?.on("data",chunk=>{if(stderr.length<120*1024)stderr+=chunk.toString();});
    child.on("message",message=>{
      if(settled)return;
      try{
        const fields=dataFields(message,["version","token","type","code","signal","error"],["version","token","type"]);
        if(fields.version!==1||fields.token!==token)throw new Error("Invalid owner binding");
        if(fields.type==="ready"){
          if(ready||Object.keys(fields).length!==3)throw new Error("Duplicate or malformed ready");ready=true;
          if(!stopping){started=true;send({version:1,token,type:"start",command,shell});}
        }else{
          if(fields.type!=="command-closed"||!started||received||Object.keys(fields).length!==6||
              !(fields.code===null||Number.isInteger(fields.code)&&fields.code>=0&&fields.code<=255)||
              !(fields.signal===null||typeof fields.signal==="string"&&/^SIG[A-Z0-9]{1,16}$/.test(fields.signal))||
              fields.signal!==null&&fields.code!==null||typeof fields.error!=="string"||!fields.error.isWellFormed()||Buffer.byteLength(fields.error)>4096||
              fields.code===null&&fields.signal===null&&!fields.error)throw new Error("Invalid command outcome");
          received=Object.freeze({code:fields.code,signal:fields.signal,error:fields.error});
          // A deadline starts teardown, but cannot erase a subsequently proven
          // process failure. Keep the independent failure fact monotonic.
          if(received.error)markFailure(received.error);
          if(!stopping){
            if(received.signal||received.error)stop();
            else send({version:1,token,type:"release"});
          }
        }
      }catch{fail();}
    });
    child.on("error",error=>{markFailure(String(error?.message||"Native command supervisor process failed"));stop();});
    child.on("exit",()=>{ownerExited=true;});
    child.on("close",(code,signalName)=>{
      ownerExited=true;ownerClosed=true;ownerCode=code;ownerSignal=signalName||null;
      // A deadline may already be stopping the group. Only its expected KILL
      // can explain an abnormal owner close; other failures stay independent.
      if(stopping&&(code!==0||ownerSignal)&&!(ownerSignal==="SIGKILL"&&killDelivered))markFailure("Native command supervisor did not close normally.");
      if(!received&&!stopping){markFailure("Native command supervisor closed without a command result.");stop();}
      if(received&&!stopping&&(code!==0||ownerSignal)){markFailure("Native command supervisor did not close normally.");stop();}
      settle();
    });
    if(Number.isFinite(timeoutMs)&&timeoutMs>0)timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted)onAbort();
  });
}
