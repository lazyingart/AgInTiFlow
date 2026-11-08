import {fileURLToPath} from "node:url";
import fsSync from "node:fs";
import * as childProcess from "node:child_process";
import {mock} from "node:test";
import {resolveRuntimeConfig} from "../../src/config.js";
import {closeSessionIndexConnections} from "../../src/session-index.js";
const [root,baseURL,mode]=process.argv.slice(2),controller=new AbortController();
const stickyModes=["error-before-timeout","timeout-before-error","valid-error-before-timeout","valid-timeout-before-error"];
const originalKill=process.kill,originalSetTimeout=globalThis.setTimeout;let ownerPid=null,triggerDeadline=null;
if(stickyModes.includes(mode))globalThis.setTimeout=(callback,ms,...args)=>{
  if(ms!==701)return Reflect.apply(originalSetTimeout,globalThis,[callback,ms,...args]);
  const handle=originalSetTimeout(()=>{},30000);handle.unref();
  triggerDeadline=()=>{triggerDeadline=null;clearTimeout(handle);Reflect.apply(callback,globalThis,args);};
  return handle;
};
if(["unknown","bad-receipt",...stickyModes].includes(mode)){
  const {default:defaultExport,...namedExports}=childProcess;
  mock.module("node:child_process",{defaultExport,namedExports:{...namedExports,spawn(...args){
    const child=Reflect.apply(childProcess.spawn,childProcess,args);
    if(Array.isArray(args[1])&&String(args[1][0]).endsWith("/native-host-command-worker.js")){
      ownerPid=child.pid;
      if(["bad-receipt",...stickyModes].includes(mode)){
        const emit=child.emit;
        child.emit=function(type,...values){
          const corrupt=type==="message"&&values[0]?.type==="command-closed";
          if(corrupt)values[0]=mode.startsWith("valid-")
            ? {...values[0],code:1,signal:null,error:"Synthetic command spawn failure"}
            : {...values[0],extra:"synthetic-extra-private-field"};
          const value=Reflect.apply(emit,child,[type,...values]);
          if(corrupt)process.send?.({type:"verification-failed"});
          return value;
        };
      }
    }
    return child;
  }}});
  if(["unknown",...stickyModes].includes(mode))process.kill=(pid,signal)=>{
    if(pid===-ownerPid&&signal===0&&!fsSync.existsSync(root+"/allow-absence"))throw Object.assign(new Error("Synthetic unavailable group observation"),{code:"EPERM"});
    return Reflect.apply(originalKill,process,[pid,signal]);
  };
}
const {runAgent}=await import("../../src/agent-runner.js");
const originalFetch=globalThis.fetch,origin=new URL(baseURL).origin;
globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
  if(url.origin!==origin)throw new Error("OFFLINE_HTTP_ESCAPE_REFUSED");
  return Reflect.apply(originalFetch,globalThis,[input,init]);
};
const config=resolveRuntimeConfig({provider:"deepseek",model:"deepseek-flash",routingMode:"manual",taskProfile:"code",
  goal:"Run the little checker in check.cjs and report the result. If I stop it, stop its work too.",
  commandCwd:root+"/workspace",maxSteps:4,dynamicSteps:"off"},
{baseDir:root+"/workspace",packageDir:fileURLToPath(new URL("../../",import.meta.url)),sessionId:"native-shell-cancellation",
  apiKey:"synthetic-cancellation-key",baseURL,enableScs:"off",sandboxMode:"host",packageInstallPolicy:"block",
  allowShellTool:true,allowDestructive:true,allowFileTools:true,allowWrapperTools:false,allowAuxiliaryTools:false,
  allowWebSearch:false,allowMcpTools:false,allowParallelScouts:false,onConsole:()=>{},
  onLog:type=>{if(type==="command.shutdown.pending")process.send?.({type:"shutdown-pending"});}});
Object.assign(config,{sessionsDir:root+"/sessions",projectSessionsDir:root+"/pointers",allowProviderHandoff:false,
  modelTimeoutMs:5000,shellTimeoutMs:stickyModes.includes(mode)?701:6000,abortSignal:controller.signal,
  routeProvider:"deepseek",routeModel:"deepseek-flash",mainProvider:"deepseek",mainModel:"deepseek-flash",spareProvider:"deepseek",spareModel:"deepseek-flash"});
process.on("message",message=>{
  if(message?.action==="timeout"){
    if(!triggerDeadline)throw new Error("No native shell deadline captured in fixture");
    triggerDeadline();process.send?.({type:"timeout-injected"});return;
  }
  if(message?.action!=="abort")return;
  controller.abort(new Error("User cancelled the checker"));
  process.send?.({type:"abort-accepted"});
});
try{
  const result=await runAgent(config);process.send?.({type:"settled",result});
  console.log(JSON.stringify(result));
}catch(error){
  process.send?.({type:"settled",error:{code:error.code||"RUNTIME_ERROR",message:error.message}});process.exitCode=1;
}finally{
  globalThis.fetch=originalFetch;process.kill=originalKill;globalThis.setTimeout=originalSetTimeout;closeSessionIndexConnections();mock.restoreAll();
  process.disconnect?.();
}
