// Private native CLI group owner. This is not an application sandbox.
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

function exact(value,keys){
  return value&&typeof value==="object"&&!Array.isArray(value)&&
    Object.keys(value).sort().join("\0")===keys.slice().sort().join("\0");
}

function runOwner(){
  const token=process.argv[2];
  if(!process.send||process.platform==="win32"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token||"")){
    process.exitCode=125;return;
  }
  let attempted=false,closed=false,released=false;
  const errorText=error=>Array.from(String(error?.message||"Command process failed")).slice(0,1000).join("");
  const keepAlive=setInterval(()=>{},1000);
  const stop=()=>{
    if(!released){try{process.kill(-process.pid,"SIGKILL");return;}catch{}}
    process.exitCode=125;clearInterval(keepAlive);
    try{if(process.connected)process.disconnect();}catch{}
  };
  const send=payload=>{
    try{process.send({version:1,token,...payload},error=>{if(error&&!released)stop();});}
    catch{stop();}
  };
  // TERM reaches the actual command, but cannot retire its identity owner
  // before the parent finishes escalation. Only the private release allows a
  // normal exit; owner failure/disconnect kills this still-owned group.
  process.on("SIGTERM",()=>{});
  process.on("disconnect",()=>{if(!released)stop();});
  process.on("uncaughtException",stop);
  process.on("unhandledRejection",stop);
  process.on("message",message=>{
    if(message?.type==="release"){
      if(!exact(message,["version","token","type"])||message.version!==1||message.token!==token||!closed||released)return stop();
      released=true;clearInterval(keepAlive);process.disconnect();return;
    }
    if(!exact(message,["version","token","type","command","shell"])||message.version!==1||message.token!==token||
        message.type!=="start"||attempted||typeof message.command!=="string"||!message.command.isWellFormed()||
        Buffer.byteLength(message.command)>2*1024*1024||typeof message.shell!=="string"||!message.shell||
        !message.shell.isWellFormed()||message.shell.includes("\0")||Buffer.byteLength(message.shell)>4096)return stop();
    attempted=true;let child,processError="";
    try{
      const env={...process.env};delete env.NODE_CHANNEL_FD;delete env.NODE_CHANNEL_SERIALIZATION_MODE;
      child=spawn(message.command,{cwd:process.cwd(),env,shell:message.shell,detached:false,stdio:["ignore","pipe","pipe"]});
    }catch(error){
      closed=true;send({type:"command-closed",code:1,signal:null,error:errorText(error)});return;
    }
    child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});
    child.stdout.on("error",stop);child.stderr.on("error",stop);
    child.on("error",error=>{processError=errorText(error);});
    child.on("close",(code,signal)=>{
      closed=true;
      send({type:"command-closed",code:Number.isInteger(code)&&code>=0?code:processError?1:null,signal:signal||null,error:processError});
    });
  });
  send({type:"ready"});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runOwner();
