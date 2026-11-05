import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { createRestrictedApplicationRunner, createRestrictedDeepSeekProvider } from '../../src/restricted-application.js';

// Synthetic host-owned records/history only; this is not an application auth,
// transaction, storage or persistence implementation exported by the SDK.
const object = properties => ({ type:'object',properties,required:Object.keys(properties),additionalProperties:false });
const string = {type:'string',minLength:1,maxLength:1000};
const record = object({recordId:{type:'integer',minimum:1,maximum:1},revision:{type:'integer',minimum:1},text:string});
const output = object({recordId:{type:'integer',minimum:1,maximum:1},revision:{type:'integer',minimum:1},reply:string});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function bounded(promise,label,ms=10000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
export async function runConcurrentScopeScenario(complete, root, lateFailure=false, waitMs=10000){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const file=path.join(root,'host-state.json');
  const initial={alpha:{recordId:1,revision:5,text:'Kira 想在周四之前拿到蓝色笔记本。'},beta:{recordId:1,revision:31,text:'Nora needs the green sample box before Monday.'}};
  const save=value=>fs.writeFile(file,JSON.stringify(value)+'\n',{mode:0o600});
  await save(initial);
  const initialBytes=await fs.readFile(file);
  const aEntered=deferred(),bEntered=deferred(),aRelease=deferred(),bRelease=deferred();
  const reads=[];let aReads=0;
  const runner=(owner,model)=>createRestrictedApplicationRunner({
    provider:createRestrictedDeepSeekProvider({complete,model}),
    instructions:'Read the current authorized record once before answering. Return an uncommitted JSON summary with its exact recordId and revision. Preserve the user language. No save or mutation is available.',
    tools:[{name:'read_record',description:'Read record 1 in this authenticated account only. No account selector or writes.',readOnly:true,
      inputSchema:object({recordId:{type:'integer',minimum:1,maximum:1}}),outputSchema:record,
      execute:async(args,{signal})=>{
        assert.equal(args.recordId,1);const row=JSON.parse(await fs.readFile(file,'utf8'))[owner];reads.push({owner,revision:row.revision});
        if(owner==='alpha'&&++aReads===1){aEntered.resolve();await aRelease.promise;if(lateFailure)throw new Error('Late test-owned read failure');}
        if(owner==='beta'){bEntered.resolve();await bRelease.promise;assert.equal(signal.aborted,false);}
        return row;
      }}],outputSchema:output,limits:{maxSteps:2,maxToolCalls:1,maxCallsPerStep:1,maxConcurrency:1,timeoutMs:60000,maxOutputTokens:768},
  });
  const alpha=runner('alpha','deepseek-flash'),beta=runner('beta','deepseek-flash');
  const aAbort=new AbortController(),bAbort=new AbortController();
  const aInput={input:[{type:'text',text:'帮我看下1那条，别改，简短讲下现在的内容。'}],history:[{role:'assistant',text:'ALPHA_HISTORY: 上次谈的是蓝色笔记本，内容以当前记录为准。'}]};
  const bInput={input:[{type:'text',text:'check item 1 pls, just tell me what is there; do not change it.'}],history:[{role:'assistant',text:'BETA_HISTORY: Previous discussion concerned a green sample box; read the current record.'}]};
  for(const [owner,input] of [['alpha',aInput],['beta',bInput]]){
    const historyFile=path.join(root,owner+'-history.json');await fs.writeFile(historyFile,JSON.stringify(input.history),{mode:0o600});input.history=JSON.parse(await fs.readFile(historyFile));
  }
  const settled=p=>p.then(value=>({value}),error=>({error}));
  const a=settled(alpha.run(aInput,{signal:aAbort.signal}));const b=settled(beta.run(bInput,{signal:bAbort.signal}));
  const resumeAbort=new AbortController();let resumeSettled=null;
  try{
    await bounded(Promise.all([aEntered.promise,bEntered.promise]),'concurrent scoped reads',waitMs);
    aAbort.abort();const cancelled=await bounded(a,'cancelled alpha');assert.equal(cancelled.error?.code,'CANCELLED');assert.equal(cancelled.value,undefined);
    const blocked=await settled(alpha.run(aInput));assert.equal(blocked.error?.code,'BUSY');
    bRelease.resolve();const completed=await bounded(b,'unaffected beta',waitMs);assert.equal(completed.value?.proposal.revision,31);assert.equal(completed.value?.usage.toolCalls,1);assert.equal(bAbort.signal.aborted,false);
    assert.deepEqual(await fs.readFile(file),initialBytes);
    await fs.writeFile(path.join(root,'beta-history.json'),JSON.stringify([...bInput.history,{role:'user',text:bInput.input[0].text},{role:'assistant',text:JSON.stringify(completed.value.proposal)}]),{mode:0o600});
    const changed=JSON.parse(await fs.readFile(file,'utf8'));changed.alpha.revision=6;changed.alpha.text+=' 附注：封面不要折。';await save(changed);
    const before=await fs.readFile(file);aRelease.resolve();
    const alreadyAborted=new AbortController();alreadyAborted.abort();let released=false;
    for(let i=0;i<32;i++){await turn();const probe=await settled(alpha.run(aInput,{signal:alreadyAborted.signal}));if(probe.error?.code==='CANCELLED'){released=true;break;}assert.equal(probe.error?.code,'BUSY');}
    assert.equal(released,true,'callback capacity leaked after late settlement');
    await fs.writeFile(path.join(root,'alpha-history.json'),JSON.stringify([...aInput.history,{role:'user',text:aInput.input[0].text},{role:'assistant',text:'请求已取消，未返回结果，也未保存更改。'}]),{mode:0o600});
    const history=JSON.parse(await fs.readFile(path.join(root,'alpha-history.json')));
    resumeSettled=settled(runner('alpha','deepseek-v4-pro').run({input:[{type:'text',text:'那再试一下，还是看第1条，告诉我最新内容就好，不要改。'}],history},{signal:resumeAbort.signal}));
    const resumeResult=await bounded(resumeSettled,'explicit Pro continuation',waitMs);if(resumeResult.error)throw resumeResult.error;const resumed=resumeResult.value;
    assert.equal(resumed.proposal.revision,6);assert.equal(resumed.usage.toolCalls,1);
    assert.deepEqual(await fs.readFile(file),before);
    assert.equal(getEventListeners(aAbort.signal,'abort').length,0);assert.equal(getEventListeners(bAbort.signal,'abort').length,0);
    return {cancelledCode:cancelled.error.code,beta:completed.value,alpha:resumed,reads,hostStateUnchangedBySDK:true,lateFailure};
  }finally{aAbort.abort();bAbort.abort();resumeAbort.abort();aRelease.resolve();bRelease.resolve();await bounded(Promise.all([a,b,...(resumeSettled?[resumeSettled]:[])]),'fixture cleanup',waitMs);}
}
