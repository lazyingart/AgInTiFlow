import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import test from "node:test";

for (const mode of ["ordinary", "outside", "ordinary-resume", "outside-resume"]) test(`native pre-patch source authority: ${mode}`, {timeout:45000}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"aginti-prepatch-native-"));
  t.after(async()=>{await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.stat(root),{code:"ENOENT"});});
  await fs.mkdir(root+"/workspace");await fs.mkdir(root+"/excluded");
  const outside=mode.startsWith("outside"),resume=mode.endsWith("-resume");
  const marker="EXCLUDED_PREPATCH_SOURCE_SYNTHETIC_ORCHID",original="def compute(value):\n    return value + 1\n";
  const privateSource=original.trimEnd()+" # "+marker+"\n";
  const checker="import unittest\nfrom compute import compute\nclass ComputeTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(compute(1), 3)\n";
  await fs.writeFile(root+"/workspace/compute.py",original);await fs.writeFile(root+"/excluded/record.py",privateSource);await fs.writeFile(root+"/workspace/test_compute.py",checker);
  let stage=0,sequence=0,phase="initial";const requests=[],errors=[],reports=[];
  const call=(name,args)=>({role:"assistant",content:null,tool_calls:[{id:"prepatch_"+(++sequence),type:"function",function:{name,arguments:JSON.stringify(args)}}]});
  const server=http.createServer(async(request,response)=>{
    try{
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push({phase,body});
      const tools=(body.tools||[]).map(tool=>tool.function.name);let message;
      if(!body.tools)message={role:"assistant",content:"Read the current source, repair it, run the provided test and finish only from observed evidence."};
      else if(phase==="resume")message=call("finish",{result:outside?"The source binding is outside the permitted workspace, so repair and verification remain blocked. No files were changed.":"compute.py was repaired and its unit test passed. No files were changed in this follow-up."});
      else if(stage===0){stage++;message=call("read_file",{path:"compute.py"});}
      else if(stage===1){stage++;if(outside){await fs.unlink(root+"/workspace/compute.py");await fs.symlink(root+"/excluded/record.py",root+"/workspace/compute.py");}message=call("apply_patch",{path:"compute.py",search:"return value + 1",replace:"return value +"});}
      else if(outside&&tools.includes("read_file"))message=call("read_file",{path:"compute.py"});
      else if(outside)message=call("finish",{result:"The source binding changed outside the permitted workspace. I have not repaired or verified compute.py."});
      else if(stage===2&&tools.includes("apply_patch")){stage++;message=call("apply_patch",{path:"compute.py",search:"return value + 1",replace:"return value + 2"});}
      else if(stage===3&&tools.includes("run_command")){stage++;message=call("run_command",{command:"python3 -m unittest -v test_compute.py"});}
      else message=call("finish",{result:"Fixed compute.py and verified that compute(1) returns 3 with the passing unit test. Unrelated files are unchanged."});
      response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?"tool_calls":"stop",message}]}));
    }catch(e){errors.push(e.message);response.writeHead(500);response.end("{}");}
  });await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const run=async()=>{
    const env={PATH:process.env.PATH,HOME:root,LANG:"C.UTF-8",AGINTIFLOW_HOME:root+"/home",AGINTIFLOW_HOUSEKEEPING:"0",AGINTIFLOW_NO_AUTO_UPDATE:"1",AGINTIFLOW_NO_WEB_AUTO_START:"1",AGINTIFLOW_NO_AUTH_PROMPT:"1",AGINTI_PROVIDER_HANDOFF:"0",PYTHONDONTWRITEBYTECODE:"1",
      ...(process.env.AGINTI_TEST_BASELINE_RUNTIME?{AGINTI_TEST_BASELINE_RUNTIME:process.env.AGINTI_TEST_BASELINE_RUNTIME}:{})};
    const worker=spawn(process.execPath,[fileURLToPath(new URL("./fixtures/native-prepatch-source-boundary.js",import.meta.url)),root,"http://127.0.0.1:"+server.address().port+"/v1",mode,phase],{cwd:root+"/workspace",env,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",timedOut=false;worker.stdout.on("data",b=>stdout+=b);worker.stderr.on("data",b=>stderr+=b);
    const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{timedOut=true;worker.kill("SIGKILL");},18000);worker.once("error",e=>{clearTimeout(timer);reject(e);});worker.once("close",code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(timedOut,false);assert.equal(exit,0,stderr);assert.deepEqual(errors,[]);const report=JSON.parse(stdout);assert.equal(report.error,null,JSON.stringify(report));reports.push(report);
  };
  await run();
  const statePath=root+"/sessions/prepatch-boundary-"+mode+"/state.json";
  const initialState=await fs.readFile(statePath,"utf8");assert.ok(!initialState.includes(marker),"Excluded source entered initial durable state");
  if(resume){phase="resume";await run();}
  const state=JSON.parse(await fs.readFile(statePath,"utf8"));
  const events=(await fs.readFile(root+"/sessions/prepatch-boundary-"+mode+"/events.jsonl","utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(!JSON.stringify(requests).includes(marker));assert.ok(!JSON.stringify(state).includes(marker));assert.ok(!JSON.stringify(events).includes(marker),"Excluded source entered the authoritative event history");
  assert.ok(events.some(event=>event.type==="tool.failed"&&event.data.toolName==="apply_patch"));
  const commands=events.filter(event=>event.type==="tool.completed"&&event.data.toolName==="run_command");
  if(outside){assert.notEqual(reports[0].result.goalStatus,"completed");assert.equal(commands.length,0);assert.ok((await fs.lstat(root+"/workspace/compute.py")).isSymbolicLink());}
  else{assert.equal(reports[0].result.goalStatus,"completed");assert.equal(commands.length,1);assert.equal(commands[0].data.exitCode,0);assert.equal(await fs.readFile(root+"/workspace/compute.py","utf8"),original.replace("+ 1","+ 2"));assert.ok(events.some(event=>event.data.category==="python-syntax-regression"));}
  assert.equal(await fs.readFile(root+"/workspace/test_compute.py","utf8"),checker);assert.equal(await fs.readFile(root+"/excluded/record.py","utf8"),privateSource);
  assert.equal(state.meta.runtimeConfig.revision,resume?2:1);if(resume)assert.ok(requests.filter(item=>item.phase==="resume").every(item=>/pro/i.test(item.body.model)));
  await assert.rejects(fs.stat(root+"/sessions/prepatch-boundary-"+mode+"/.agent-run.lock"),{code:"ENOENT"});
  t.diagnostic(JSON.stringify({mode,realNativeRuntime:true,scriptedProvider:true,externalModelCalls:0,sessionId:state.sessionId,runtimeRevision:state.meta.runtimeConfig.revision,
    initialGoalStatus:reports[0].result.goalStatus,resumed:Boolean(resume),providerRequests:requests.length,sourceMarkerForwarded:false,sourceMarkerPersisted:false,
    sourceAndCheckerUnchangedOutsideTask:true,commands:commands.length,artifactSha256:outside?null:createHash("sha256").update(original.replace("+ 1","+ 2")).digest("hex"),sessionLeaseReleased:true}));
});
