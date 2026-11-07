import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { classifyCommand, evaluateCommandPolicy } from '../src/command-policy.js';

const host={sandboxMode:'host',allowShellTool:true,allowFileTools:true,allowDestructive:false,packageInstallPolicy:'block'};
const accepted=[
 "sed -n '/## Statistics/,/## Rejected/p' report.md",
 "sed -n '/start/,/end/p' report.md",
 "sed -n '/sample/p' report.md",
 "sed -n '1,/end/p' report.md",
 "sed -n '/start/,$p' report.md",
 "sed -n '1,20p' report.md",
 "sed -n '1p' report.md",
 "sed -n '$p' report.md",
 "sed -n p report.md",
 "sed -n '/a\\/b/,/end/p' report.md",
 "sed -n '/e;w;system()/p' report.md",
 "sed -n '/中文/,/结束/p' report.md",
 "sed -n '/start/,/end/p' 'report notes.md'",
 "sed -n '/start/,/end/p' -- report.md",
 "sed -n '/start/,/end/p' first.md second.md",
 "sed -n '/start/p' ./-i report.md",
 "cat report.md | sed -n '/start/,/end/p' | tail -12",
 "printf 'start\\nend\\n' | sed -n '/start/,/end/p'",
 "sed -n '/start/,/end/p' report.md >/dev/null",
 "sed -n '/start/,/end/p' report.md && sha256sum report.md",
];
for(const command of accepted)test('bounded print-only sed: '+command,()=>{
 const result=evaluateCommandPolicy(command,host);assert.equal(result.allowed,true);assert.equal(result.category,'read-only');assert.equal(result.writesWorkspace,false);
});
const denied=[
 "sed -i '/start/p' report.md", "sed -ni '/start/p' report.md", "sed --in-place -n '/start/p' report.md",
 "sed -n '/start/w output.md' report.md", "sed -n '/start/e' report.md", "sed -n '1e touch marker' report.md",
 "sed -n 's/start/end/e' report.md", "sed -n 's/start/end/w output.md' report.md", "sed -n '/start/r private.md' report.md",
 "sed -n '1p;w output.md' report.md", "sed -n '1p\nw output.md' report.md", "sed -n '/start/p;e touch marker' report.md",
 "sed -n -f script.sed report.md", "sed -n -e '/start/p' -e 'w output.md' report.md",
 "sed -n '/start/p' -i report.md", "sed -n '/start/p' --in-place report.md", "sed -n '/start/p' -fscript.sed",
 "sed -n '/start/p' *.md", "sed -n '/start/p' report?.md", "sed -n '/start/p' $INPUT",
 "sed -n '/start/p' ~/report.md", "sed -n '/start/p' ~someone/report.md",
 "sed -n '/start/p' $(cat path.txt)", "sed -n \"/$(touch marker)/p\" report.md",
 "sed -n '/start/p' report.md > output.md", "sed -n '/start/p' report.md && touch marker",
 "sed -n '/unterminated p' report.md", "sed -n '/start/p garbage' report.md",
 "sed -n '//p' report.md", "sed -n '/start/,p' report.md", "sed -n '/start/,/end/pp' report.md",
 "sed -n '/start/p' report.md; rm report.md", "sed -n '/start/p' report.md | sh",
 "sed -n '/start/p' report.md < private.md", "sed -n '1p' -i", "sed -n '1p' *",
];
for(const command of denied)test('unsafe or unqualified sed stays outside read-only: '+JSON.stringify(command),()=>{
 const result=evaluateCommandPolicy(command,host);assert.equal(result.allowed,false);assert.notEqual(result.category,'read-only');
});
test('shell-disabled authority still refuses the new read-only syntax',()=>{assert.equal(evaluateCommandPolicy(accepted[0],{...host,allowShellTool:false}).allowed,false);});
test('existing numeric syntax and tail have independent positive controls',()=>{
 for(const command of ["sed -n '1,3p' report.md",'tail -12 report.md'])assert.equal(evaluateCommandPolicy(command,host).allowed,true);
 assert.equal(classifyCommand("git add . && git commit -m done").category==='read-only',false);
});
test('program/operand bounds and ambiguous syntax fail closed',()=>{
 for(const command of [
  "sed -n '/"+'a'.repeat(1022)+"/p' report.md",
  "sed -n '1p' "+Array.from({length:17},(_,i)=>'file'+i+'.md').join(' '),
  "sed -n '1p' "+'a'.repeat(8200),"sed -n '/start/p report.md","sed -n '1p' report.md \\",
  "sed -n '{1p;w output.md}' report.md", "sed -n '/start/!p' report.md",
 ])assert.equal(evaluateCommandPolicy(command,host).allowed,false,command.slice(0,80));
});
test('the exact program-size limit remains usable',()=>{
 assert.equal(evaluateCommandPolicy("sed -n '/"+'a'.repeat(1021)+"/p' report.md",host).allowed,true);
});
test('credential-path policy remains independent of section-print syntax',()=>{
 for(const file of ['.env','.npmrc','api-key.txt'])assert.equal(evaluateCommandPolicy("sed -n '/start/p' "+file,host).allowed,false);
});
test('the admitted exact program prints only the requested section without source mutation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aginti-readonly-sed-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source='# Report\n\n## Statistics\nCount: 10\nMean: 6.11\n\n## Rejected\n5 rows\n';await fs.writeFile(root+'/report.md',source);
 const command=accepted[0];assert.equal(evaluateCommandPolicy(command,host).allowed,true);
 const r=spawnSync('/bin/sh',['-c',command],{cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:2000,maxBuffer:65536});
 assert.ifError(r.error);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'## Statistics\nCount: 10\nMean: 6.11\n\n## Rejected\n');
 assert.equal(await fs.readFile(root+'/report.md','utf8'),source);assert.deepEqual(await fs.readdir(root),['report.md']);
});

for(const [kind,scs] of [['section',false],['section',true],['glob',false],['glob',true]]){
 test('native persisted '+kind+' inspection retains authority (SCS '+scs+')',{timeout:20000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aginti-native-sed-')),workspace=root+'/workspace';t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(workspace);
  const source='# Report\n\n## Statistics\nCount: 10\nMean: 6.11\nMin: -2.5\nMax: 13\n\n## Rejected\n5 rows\n';await fs.writeFile(workspace+'/report.md',source);await fs.writeFile(workspace+'/-i','');
  const {runAgent}=await import('../src/agent-runner.js'),{resolveRuntimeConfig}=await import('../src/config.js'),{closeSessionIndexConnections}=await import('../src/session-index.js');
  const previous=process.env.AGINTIFLOW_HOME;process.env.AGINTIFLOW_HOME=root+'/home';const originalFetch=globalThis.fetch;
  let requests=0,phase='start',read=false,command=false;
  const section="sed -n '/## Statistics/,/## Rejected/p' report.md | tail -12";
  const commandForPhase=()=>kind==='glob'&&phase==='start'?"sed -n '1p' *":section;
  globalThis.fetch=async(url,init)=>{
   assert.notEqual(phase,'completed','A completed task must not redispatch');assert.equal(new URL(url).href,'https://offline.invalid/v1/chat/completions');requests++;
   const body=JSON.parse(init.body);const call=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'sed_'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
   let message;
   if(!body.tools)message={role:'assistant',content:'Read the report, perform the authorized inspection and give the observed statistics.'};
   else if(!body.tools.some(tool=>tool.function.name==='read_file')&&body.tools.some(tool=>tool.function.name==='inspect_project'))message=call('inspect_project',{});
   else if(!read){read=true;message=call('read_file',{path:'report.md'});}
   else if(!command){command=true;message=call('run_command',{command:commandForPhase()});}
   else message=call('finish',{result:'Count: 10; mean: 6.11; minimum: -2.5; maximum: 13. The report.md source is unchanged.'});
   return new Response(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
   const config=resolveRuntimeConfig({goal:'Inspect report.md, print its Statistics section using sed, and tell me the count, mean and range. Do not change the report.',provider:'deepseek',model:'deepseek-flash',routingMode:'manual',taskProfile:'code',commandCwd:workspace,maxSteps:6,dynamicSteps:'off'},
    {baseDir:workspace,packageDir:path.resolve(import.meta.dirname,'..'),sessionId:'readonly-sed',apiKey:'synthetic-offline-key',baseURL:'https://offline.invalid/v1',sandboxMode:'host',packageInstallPolicy:'block',allowFileTools:true,allowShellTool:true,allowWrapperTools:false,allowAuxiliaryTools:false,allowWebSearch:false,allowMcpTools:false,allowParallelScouts:false,onConsole(){},onLog(){},onEvent(){}});
   Object.assign(config,{sessionsDir:root+'/sessions',projectSessionsDir:root+'/pointers',enableScs:scs?'on':'off',scsActive:scs,scsValidationMode:'deterministic',allowProviderHandoff:false,modelTimeoutMs:5000,routeProvider:'deepseek',routeModel:'deepseek-flash',mainProvider:'deepseek',mainModel:'deepseek-flash',spareProvider:'deepseek',spareModel:'deepseek-flash'});
   const first=await runAgent(config);assert.equal(first.goalStatus,kind==='glob'?'paused':'completed');if(kind==='glob')assert.equal(first.reason,'permission_required');
   assert.equal(await fs.readFile(workspace+'/report.md','utf8'),source);
   const eventPath=root+'/sessions/readonly-sed/events.jsonl';let events=(await fs.readFile(eventPath,'utf8')).trim().split('\n').map(JSON.parse);
   if(kind==='glob'){
    assert.ok(events.some(e=>e.type==='tool.blocked'&&e.data.args.command===commandForPhase()));
    assert.equal(events.some(e=>e.type==='tool.completed'&&e.data.toolName==='run_command'),false);
    phase='safe-follow-up';read=false;command=false;
    const resumed=await runAgent({...config,resume:'readonly-sed',expectedRuntimeRevision:1,goal:'Now inspect only the Statistics section of report.md with a literal file path and tell me the values. Leave all files unchanged.'});
    assert.equal(resumed.goalStatus,'completed');
    events=(await fs.readFile(eventPath,'utf8')).trim().split('\n').map(JSON.parse);
   }
   const observed=events.filter(e=>e.type==='tool.completed'&&e.data.toolName==='run_command');assert.equal(observed.length,1);
   assert.equal(observed[0].data.args.command,section);assert.equal(observed[0].data.exitCode,0);assert.match(observed[0].data.stdout,/Mean: 6\.11/);
   assert.equal(observed[0].data.commandPolicy.category,'read-only');assert.equal(observed[0].data.commandPolicy.writesWorkspace,false);
   assert.equal(events.some(e=>e.type==='file.changed'),false);assert.equal(await fs.readFile(workspace+'/report.md','utf8'),source);
   phase='completed';const before=requests;const completed=await runAgent({...config,resume:'readonly-sed',expectedRuntimeRevision:1,goal:'Continue the same task.'});
   assert.equal(completed.goalStatus,'completed');assert.equal(requests,before);assert.equal(await fs.readFile(workspace+'/report.md','utf8'),source);
   const state=JSON.parse(await fs.readFile(root+'/sessions/readonly-sed/state.json'));assert.equal(state.meta.goalContract.status,'completed');
   await assert.rejects(fs.stat(root+'/sessions/readonly-sed/.agent-run.lock'),{code:'ENOENT'});
  }finally{globalThis.fetch=originalFetch;closeSessionIndexConnections();if(previous===undefined)delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME=previous;}
 });
}
