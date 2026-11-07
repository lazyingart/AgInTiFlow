import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {deriveScsTaskContract} from '../src/scs-evidence.js';
import {nextStepRuntimeConfig,preservedInputMutationBlock,activePatchContextRefresh,activePatchContextRepair,bindPatchContextRepairArguments} from '../src/agent-runner.js';
import {runAgent} from '../src/agent-runner.js';
import {resolveRuntimeConfig} from '../src/config.js';
import {closeSessionIndexConnections} from '../src/session-index.js';

const goals=[
 '刚才 B 的最新读数改成了 15，O 有条更新的缺测记录。请按现在的 export.csv 更新那三个文件，原始导出别动，这次报告用中文。',
 '请按照当前的 export.csv 更新之前的报告，原始数据别动。',
 '請按現在的 export.csv 更新那三個文件，原始導出別動。',
 '根据 export.csv 更新那些输出文件。保持原始输入不变。',
 '依據 export.csv 更新報告。請勿修改原始資料。',
 'Use export.csv to update those files. Keep the source unchanged.',
 'Using export.csv, update the outputs. Leave the original export untouched.',
 'According to export.csv, update the report. Do not modify the input file.',
 'As per export.csv, regenerate the results. Keep the original unchanged.',
 '根据 "source notes.json" 更新之前的报告。原始输入别动。',
];
for(const goal of goals)test('a unique explicitly preserved source alias stays an input: '+goal,()=>{
 const source=goal.includes('source notes.json')?'source notes.json':'export.csv';const c=deriveScsTaskContract({goal,taskProfile:'data'});
 assert.deepEqual(c.exactInputPaths,[source]);assert.deepEqual(c.preservedInputPaths,[source]);assert.equal(c.exactOutputPaths.includes(source),false);
 for(const [tool,args] of [['apply_patch',{path:source,search:'old',replace:'new'}],['write_file',{path:source,content:'new'}],['run_command',{command:'printf changed > '+JSON.stringify(source)}]])assert.equal(preservedInputMutationBlock({goal},tool,args,{goal})?.category,'preserved-input-mutation');
 assert.equal(preservedInputMutationBlock({goal},'read_file',{path:source},{goal}),null);
 assert.equal(preservedInputMutationBlock({goal},'write_file',{path:'report.md',content:'new'},{goal}),null);
});
for(const goal of [
 'Use a.csv and b.csv to update those files. Keep the original unchanged.',
 'Keep it unchanged.', 'Keep the source unchanged.',
 'Use source.js and update its calculation.',
 'Read source.js and update source.js. Keep formatting unchanged.',
 'Read source.js and change the source file permissions only.',
 'Use export.csv to create report.md explaining "Keep the source unchanged."',
 'Use export.csv to create report.md explaining "Hello! Keep the source unchanged."',
 'Use export.csv to create report.md explaining 「Keep the source unchanged.」',
 'Explain the sentence "Use fake.csv."; keep the source unchanged.',
 'Explain the sentence 「Use fake.csv.」; keep the source unchanged.',
 'Use export.csv to create report.md. Keep the source formatting unchanged.',
 '按下按钮，更新 source.js。',
])test('an ambiguous, partial or quoted alias grants no whole-file protection: '+goal,()=>{
 assert.deepEqual(deriveScsTaskContract({goal,taskProfile:'code'}).preservedInputPaths,[]);
});
test('source aliases do not erase independently named outputs or explicit edits',()=>{
 const c=deriveScsTaskContract({goal:'按照 export.csv 生成 report.md。原始导出别动。',taskProfile:'data'});
 assert.deepEqual(c.exactInputPaths,['export.csv']);assert.deepEqual(c.exactOutputPaths,['report.md']);assert.deepEqual(c.preservedInputPaths,['export.csv']);
 for(const goal of ['Read source.js and update source.js.','按照说明修改 source.js。','Update 按钮.js.'])assert.equal(deriveScsTaskContract({goal,taskProfile:'code'}).preservedInputPaths.length,0);
});
test('current-source grounding must not force a touch/revert of the protected sole input',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aginti-source-alias-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(root+'/export.csv','sample,value\nA,1\n');
 const goal=goals[0],state={goal,commandCwd:root,messages:[],meta:{taskProfile:'data',goalContract:{version:3,revision:3,activeGoalRevision:3,currentRequest:goal,activeGoal:goal,taskGoal:goal},activeExecutionContract:{revision:3,refreshedAt:'2026-11-07T00:00:00.000Z',requiresFileMutation:true,requiresSourceGrounding:true,startedMutationRevision:0},projectVerification:{mutationRevision:0,mutationHistory:[]},toolLoop:{recent:[{toolName:'read_file',args:{path:'export.csv'},path:'export.csv',ok:true,at:'2026-11-07T00:00:01.000Z'}]}}};
 const runtime=nextStepRuntimeConfig({goal,commandCwd:root},state);assert.ok(!runtime.completionFreshMutationPaths?.includes('export.csv'));
});

function retainedMarkers(state, file, search='sample,value\nA,1\n') {
 const base={version:1,path:file,mutationRevision:state.meta.projectVerification.mutationRevision,
  privateMutationRevision:state.meta.projectVerification.privateMutationRevision||0,goalRevision:0};
 state.meta.toolLoop.patchContextRequired={...base};
 state.meta.toolLoop.patchContextRepair={...base,search,searchHash:createHash('sha256').update(search).digest('hex'),anchorKind:'exact-line',lineStart:1,lineEnd:2};
}
for(const goal of [goals[0],'Use export.csv to update report.md. Keep export.csv unchanged.']) {
 for(const file of ['export.csv','report.md'])test('retained patch authority respects the current preservation contract: '+file+' / '+goal,()=>{
  const state={goal,commandCwd:os.tmpdir(),messages:[],meta:{taskProfile:'data',projectVerification:{mutationRevision:4},toolLoop:{recent:[]}}};
  retainedMarkers(state,file);
  const protectedInput=file==='export.csv';
  assert.equal(activePatchContextRefresh(state)?.path||null,protectedInput?null:file);
  delete state.meta.toolLoop.patchContextRequired;
  assert.equal(activePatchContextRepair(state)?.path||null,protectedInput?null:file);
  const bound=bindPatchContextRepairArguments(state,{replace:'changed\n'});
  assert.equal(bound?.args.path||null,protectedInput?null:file);
  const runtime=nextStepRuntimeConfig({goal,commandCwd:state.commandCwd},state);
  assert.equal(runtime.patchContextRepairRequired===true,!protectedInput);
  if(protectedInput)assert.notEqual(runtime.patchContextRepairPath,file);
 });
}

for(const scsActive of [false,true])for(const staleRepair of [false,true])test('source alias survives a persisted output update/model patch (SCS '+scsActive+', retained repair '+staleRepair+')',{timeout:20000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aginti-native-source-alias-')),workspace=root+'/workspace';await fs.mkdir(workspace);
 const previous=process.env.AGINTIFLOW_HOME;process.env.AGINTIFLOW_HOME=root+'/home';t.after(async()=>{closeSessionIndexConnections();if(previous===undefined)delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME=previous;await fs.rm(root,{recursive:true,force:true});});
 let phase='start',step=0,requests=0,readSource=false,attemptedInput=false,wrote=false,readOutput=false,constrainedSourceExcluded=false;const sources={start:'sample,value\nA,1\n',update:'sample,value\nA,2\n'},reports={start:'# Report\nCount: 1\nMean: 1\n',update:'# 报告\n有效数：1\n均值：2\n'};
 await fs.writeFile(workspace+'/current.csv',sources.start);
 const client={chat:{completions:{create:async request=>{
  assert.notEqual(phase,'completed');requests++;
  if(!request.tools)return{choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Read current input and update the separate report.'}}]};
  const call=(name,args)=>({choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'alias_'+phase+'_'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  if(!request.tools.some(t=>t.function.name==='read_file')&&request.tools.some(t=>t.function.name==='inspect_project'))return call('inspect_project',{});
  step++;
  const offered=(name,file)=>{const tool=request.tools.find(t=>t.function.name===name);if(!tool)return false;const p=tool.function.parameters?.properties?.path;return !p?.enum||p.enum.includes(file);};
  assert.ok(step<=7,'input was incorrectly required to change or a producer loop began');
  if(!readSource){readSource=true;return call('read_file',{path:'current.csv'});}
  if(!attemptedInput){attemptedInput=true;if(offered('apply_patch','current.csv'))return call('apply_patch',{path:'current.csv',search:phase==='start'?'A,1':'A,2',replace:'A,999'});constrainedSourceExcluded=true;}
  if(phase==='update'&&!readOutput&&offered('read_file','report.md')){readOutput=true;return call('read_file',{path:'report.md'});}
  if(!wrote){wrote=true;return phase==='start'?call('write_file',{path:'report.md',content:reports.start,mode:'create'}):call('apply_patch',{path:'report.md',search:reports.start,replace:reports.update});}
  if(!readOutput&&offered('read_file','report.md')){readOutput=true;return call('read_file',{path:'report.md'});}
  return call('finish',{result:phase==='start'?'Saved report.md with count 1 and mean 1. current.csv is unchanged.':'已更新 report.md：有效数为 1，均值为 2。current.csv 保持不变。'});
 }}}};
 const clientFactory=async()=>client;clientFactory.agintiDeterministicTest=true;
 const config=resolveRuntimeConfig({goal:'Use current.csv to create report.md with its count and mean. Keep the original input unchanged.',provider:'openai',model:'scripted-alias-fast',routingMode:'manual',taskProfile:'code',commandCwd:workspace,enableScs:scsActive?'on':'off'},
  {baseDir:workspace,packageDir:path.resolve(import.meta.dirname,'..'),sessionId:'source-alias',clientFactory,sandboxMode:'host',packageInstallPolicy:'block',allowFileTools:true,allowShellTool:false,allowWrapperTools:false,allowAuxiliaryTools:false,allowWebSearch:false,allowMcpTools:false,allowParallelScouts:false,onConsole(){},onLog(){},onEvent(){}});
 Object.assign(config,{clientFactory,apiKey:'synthetic-only',sessionsDir:root+'/sessions',projectSessionsDir:root+'/pointers',scsActive,scsValidationMode:'deterministic',maxSteps:7,dynamicSteps:'off',executionPolicy:{tier:'focused',requiresPlan:false,reason:'Offline source alias regression.'}});
 const first=await runAgent(config);assert.equal(first.goalStatus,'completed');assert.equal(await fs.readFile(workspace+'/current.csv','utf8'),sources.start);
 if(staleRepair){const statePath=root+'/sessions/source-alias/state.json',saved=JSON.parse(await fs.readFile(statePath));retainedMarkers(saved,'current.csv',sources.start);delete saved.meta.toolLoop.patchContextRequired;await fs.writeFile(statePath,JSON.stringify(saved,null,2)+'\n');}
 await fs.writeFile(workspace+'/current.csv',sources.update);phase='update';step=0;readSource=false;attemptedInput=false;wrote=false;readOutput=false;
 const updated=await runAgent({...config,resume:'source-alias',expectedRuntimeRevision:1,runtimePatch:{model:'scripted-alias-complex'},goal:'请按现在的 current.csv 更新之前的报告，原始导出别动，这次用中文。'});
 assert.equal(updated.goalStatus,'completed',JSON.stringify(updated));assert.equal(await fs.readFile(workspace+'/current.csv','utf8'),sources.update);assert.equal(await fs.readFile(workspace+'/report.md','utf8'),reports.update);
 const dir=root+'/sessions/source-alias',state=JSON.parse(await fs.readFile(dir+'/state.json')),events=(await fs.readFile(dir+'/events.jsonl','utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(state.meta.runtimeConfig.revision,2);assert.equal(state.meta.runtimeConfig.model,'scripted-alias-complex');
 const denials=events.filter(e=>e.type==='tool.blocked'&&e.data.category==='preserved-input-mutation').length;assert.ok(denials>=1);assert.ok(denials===2||constrainedSourceExcluded);
 assert.deepEqual(events.filter(e=>e.type==='file.changed').map(e=>e.data.path),['report.md','report.md']);
 phase='completed';const before=requests;const completed=await runAgent({...config,resume:'source-alias',expectedRuntimeRevision:2,goal:'Continue the same task.'});assert.equal(completed.goalStatus,'completed');assert.equal(requests,before);
 assert.equal(await fs.readFile(workspace+'/report.md','utf8'),reports.update);await assert.rejects(fs.stat(dir+'/.agent-run.lock'),{code:'ENOENT'});
});
