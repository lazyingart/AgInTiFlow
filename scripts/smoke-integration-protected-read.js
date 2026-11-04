import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteProtectedJson, readProtectedJsonFile, readProtectedUtf8File } from "../src/integration-durable-common.js";

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const code=(expected)=>(error)=>error.code===expected;
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"aginti-protected-read-smoke-"));
 const original=fs.open;
 try {await fn(path.join(root,"record.json"),root,original);}
 finally {fs.open=original;await fs.rm(root,{recursive:true,force:true});}
}
async function replacedRead(timing){
 return fixture(async(file,_root,open)=>{
  await atomicWriteProtectedJson(file,{revision:1});
  const entered=deferred(),proceed=deferred();let armed=true,handles=0;
  fs.open=async(...args)=>{
   const h=await open(...args);
   if(args[0]!==file||!armed)return h;
   armed=false;handles++;
   const gate=async()=>{entered.resolve();await proceed.promise;};
   return {stat:async()=>{if(timing==="before-stat")await gate();return h.stat();},
    readFile:async(...a)=>{if(timing==="during-read")await gate();return h.readFile(...a);},
    read:async(...a)=>{if(timing==="during-read")await gate();return h.read(...a);},
    close:async()=>{handles--;await h.close();}};
  };
  const reading=readProtectedJsonFile(file);reading.catch(()=>{});
  try {
   await entered.promise;
   await atomicWriteProtectedJson(file,{revision:2});
   proceed.resolve();
   assert.equal((await reading).revision,2);
   assert.equal(handles,0);
   assert.equal((await fs.stat(file)).nlink,1);
  } finally {proceed.resolve();await reading.catch(()=>{});}
 });
}
test("atomic rename after open but before fstat retries the unlinked old handle", {timeout:4000},()=>replacedRead("before-stat"));
test("atomic rename during read never returns the obsolete record", {timeout:4000},()=>replacedRead("during-read"));
test("real hard links, unsafe mode, symlink, directory and oversize reject", async()=>fixture(async(file,root)=>{
 await atomicWriteProtectedJson(file,{ok:true});
 await fs.link(file,file+".hard");
 await assert.rejects(readProtectedJsonFile(file),code("INTEGRATION_AUTHORITY_CORRUPT"));
 await fs.unlink(file+".hard");
 await fs.chmod(file,0o640);
 await assert.rejects(readProtectedJsonFile(file),code("INTEGRATION_AUTHORITY_CORRUPT"));
 await fs.chmod(file,0o600);
 await fs.symlink(file,file+".link");
 await assert.rejects(readProtectedJsonFile(file+".link"),code("INTEGRATION_AUTHORITY_CORRUPT"));
 await assert.rejects(readProtectedJsonFile(root),code("INTEGRATION_AUTHORITY_CORRUPT"));
 await assert.rejects(readProtectedJsonFile(file,{maxBytes:2}),code("INTEGRATION_AUTHORITY_CORRUPT"));
 assert.equal(await readProtectedJsonFile(file+".missing",{optional:true}),null);
}));
test("continuous replacements fail bounded and close every opened reader", {timeout:5000},async()=>fixture(async(file,_root,open)=>{
 await atomicWriteProtectedJson(file,{revision:0});let attempts=0,handles=0;
 fs.open=async(...args)=>{
  const h=await open(...args);if(args[0]!==file)return h;
  handles++;
  return {stat:async()=>{await atomicWriteProtectedJson(file,{revision:++attempts});return h.stat();},
   readFile:(...a)=>h.readFile(...a),read:(...a)=>h.read(...a),close:async()=>{handles--;await h.close();}};
 };
 await assert.rejects(readProtectedJsonFile(file),(error)=>error.code==="INTEGRATION_AUTHORITY_BUSY"&&error.status===503);
 assert.ok(attempts>1&&attempts<=8);assert.equal(handles,0);
}));
test("oversize growth after fstat is byte bounded and rejected", async()=>fixture(async(file,_root,open)=>{
 await fs.writeFile(file,"x".repeat(100000),{mode:0o600});let readBytes=0,armed=true;
 fs.open=async(...args)=>{
  const h=await open(...args);if(args[0]!==file||!armed)return h;armed=false;
  return {stat:async()=>{const s=await h.stat();s.size=1;return s;},
   read:async(...a)=>{const r=await h.read(...a);readBytes+=r.bytesRead;return r;},
   readFile:(...a)=>h.readFile(...a),close:()=>h.close()};
 };
 await assert.rejects(readProtectedUtf8File(file,{maxBytes:64}),code("INTEGRATION_AUTHORITY_CORRUPT"));
 assert.ok(readBytes>0&&readBytes<=65);
}));
test("wrong owner and hard-link metadata are never treated as retryable",async()=>fixture(async(file,_root,open)=>{
 await atomicWriteProtectedJson(file,{ok:true});
 for(const kind of ["owner","hardlink"]){
  let attempts=0;
  fs.open=async(...args)=>{
   const h=await open(...args);if(args[0]!==file)return h;attempts++;
   return {stat:async()=>{const s=await h.stat();if(kind==="owner")s.uid=process.getuid()+1;else s.nlink=2;return s;},
    read:(...a)=>h.read(...a),readFile:(...a)=>h.readFile(...a),close:()=>h.close()};
  };
  await assert.rejects(readProtectedJsonFile(file),code("INTEGRATION_AUTHORITY_CORRUPT"));
  assert.equal(attempts,1);
 }
}));

test("a named symlink replacement after reading cannot validate an old handle",async()=>fixture(async(file,_root,open)=>{
 await atomicWriteProtectedJson(file,{revision:1});let armed=true;
 fs.open=async(...args)=>{
  const h=await open(...args);if(args[0]!==file||!armed)return h;armed=false;
  let replaced=false;
  return {stat:()=>h.stat(),read:async(...a)=>{const result=await h.read(...a);if(!replaced){replaced=true;await fs.rename(file,file+".real");await fs.symlink(file+".real",file);}return result;},close:()=>h.close()};
 };
 await assert.rejects(readProtectedJsonFile(file),code("INTEGRATION_AUTHORITY_CORRUPT"));
}));
test("reader close failure cannot be reported as successful content",async()=>fixture(async(file,_root,open)=>{
 await atomicWriteProtectedJson(file,{ok:true});
 fs.open=async(...args)=>{
  const h=await open(...args);if(args[0]!==file)return h;
  return {stat:()=>h.stat(),read:(...a)=>h.read(...a),close:async()=>{await h.close();throw Object.assign(new Error("synthetic close failure"),{code:"EIO"});}};
 };
 await assert.rejects(readProtectedJsonFile(file),code("EIO"));
}));
test("repeated atomic reads leave no descriptor or temporary-file residue",async()=>fixture(async(file,root)=>{
 const count=async()=> (await fs.readdir("/proc/self/fd")).length;
 await atomicWriteProtectedJson(file,{revision:0});await readProtectedJsonFile(file);
 const before=await count();
 for(let i=1;i<=20;i++){await atomicWriteProtectedJson(file,{revision:i});assert.equal((await readProtectedJsonFile(file)).revision,i);}
 assert.equal(await count(),before);assert.deepEqual(await fs.readdir(root),["record.json"]);
}));

test("concurrent atomic writers and readers retain valid monotonic snapshots",{timeout:10000},async()=>fixture(async(file)=>{
 await atomicWriteProtectedJson(file,{revision:0});let done=false,last=0,successes=0;
 const writer=(async()=>{try{for(let i=1;i<=50;i++)await atomicWriteProtectedJson(file,{revision:i});}finally{done=true;}})();
 const reader=(async()=>{
  for(let i=0;!done||i<100;i++){
   try{const record=await readProtectedJsonFile(file);assert.ok(record.revision>=last&&record.revision<=50);last=record.revision;successes++;}
   catch(error){if(error.code!=="INTEGRATION_AUTHORITY_BUSY")throw error;}
  }
 })();
 const settled=await Promise.allSettled([writer,reader]);
 for(const result of settled)if(result.status==="rejected")throw result.reason;
 assert.ok(successes>0);assert.equal((await readProtectedJsonFile(file)).revision,50);
}));
