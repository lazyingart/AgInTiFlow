import assert from 'node:assert/strict';
import test from 'node:test';
const sdk=await import(process.env.AGINTI_TEST_SDK_ENTRY||new URL('../src/restricted-application.js',import.meta.url));
const FINAL='__aginti_return_proposal';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',minLength:1,maxLength:100};
const schema=object({reply:text});
const input={input:[{type:'text',text:'Read the current record and make a short proposal. Leave the original unchanged.'}]};
const read=()=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'read_1',type:'function',function:{name:'read_current',arguments:'{}'}}]}}]});
const final=(args='{"reply":"current evidence"}',name=FINAL)=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'final_1',type:'function',function:{name,arguments:args}}]}}]});
const stop=content=>({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]});
const tool=execute=>({name:'read_current',description:'Read the authorized current record only.',readOnly:true,inputSchema:object({}),outputSchema:object({reply:text}),execute});
function make(complete,{model='deepseek-v4-pro',outputSchema=schema,limits={maxSteps:2,maxToolCalls:1},execute=()=>({reply:'current evidence'}),tools}={}){
 return sdk.createRestrictedApplicationRunner({provider:sdk.createRestrictedDeepSeekProvider({model,complete}),instructions:'Use current authorized evidence. Propose only; never save.',tools:tools??[tool(execute)],outputSchema,limits});
}
function closedWire(body){
 assert.deepEqual(JSON.parse(JSON.stringify(body.tool_choice)),{type:'function',function:{name:FINAL}});
 assert.equal(body.tools.length,1);assert.equal(body.tools[0].function.name,FINAL);
 assert.equal(body.tools[0].type,'function');assert.equal(body.thinking.type,'disabled');assert.equal(body.response_format.type,'json_object');
 assert.equal(Object.hasOwn(body.tools[0].function,'strict'),false,'No beta endpoint or unsupported strict schema claim');
 assert.ok(Object.isFrozen(body.tools[0].function.parameters));
}
for(const model of ['deepseek-flash','deepseek-v4-pro']){
 test(`${model} serializes closed read finalization without a host callback or extra turn`,async()=>{
  const bodies=[];let reads=0;
  const app=make(body=>{bodies.push(body);if(bodies.length===1){assert.equal(body.tools[0].function.name,'read_current');assert.equal(Object.hasOwn(body,'tool_choice'),false);return read();}closedWire(body);return final();},{model,execute:()=>{reads++;return{reply:'current evidence'};},limits:{maxSteps:2,maxToolCalls:1,maxOutputTokens:1536}});
  const result=await app.run(input);assert.equal(result.proposal.reply,'current evidence');assert.deepEqual({...result.usage},{steps:2,toolCalls:1});assert.equal(reads,1);assert.equal(bodies.length,2);assert.equal(bodies[1].max_tokens,1536);assert.equal(bodies[1].messages.at(-1).content,'{"reply":"current evidence"}');
 });
 test(`${model} exhausted read budget finalizes before the final step without another read`,async()=>{
  let calls=0,reads=0;const result=await make(body=>{if(++calls===1)return read();closedWire(body);return final();},{model,limits:{maxSteps:5,maxToolCalls:1},execute:()=>{reads++;return{reply:'current evidence'};}}).run(input);
  assert.equal(result.usage.steps,2);assert.equal(result.usage.toolCalls,1);assert.equal(calls,2);assert.equal(reads,1);
 });
 test(`${model} ordinary valid JSON final replies remain compatible`,async()=>{
  let calls=0;const result=await make(()=>++calls===1?read():stop('{"reply":"current evidence"}'),{model}).run(input);assert.equal(result.proposal.reply,'current evidence');assert.equal(calls,2);
 });
 test(`${model} no-tools initial chat retains its existing native wire`,async()=>{
  const result=await make(body=>{assert.equal(Object.hasOwn(body,'tools'),false);assert.equal(Object.hasOwn(body,'tool_choice'),false);return stop('{"reply":"current evidence"}');},{model,tools:[],limits:{maxSteps:1}}).run(input);assert.equal(result.usage.toolCalls,0);
 });
}
for(const [name,outputSchema,value]of [
 ['array',{type:'array',items:text,maxItems:3},['current evidence']],
 ['false',{type:'boolean'},false],['zero',{type:'integer',minimum:0,maximum:5},0],['null',{type:'null'},null],
 ['union',{anyOf:[{type:'null'},text]},'current evidence'],
 ['literal-proposal',object({proposal:text}),{proposal:'current evidence'}],
])test(`native final serialization preserves ${name} schema and value`,async()=>{
 let calls=0;const wrapped=outputSchema.type!=='object';
 const result=await make(body=>{if(++calls===1)return read();closedWire(body);assert.deepEqual(JSON.parse(JSON.stringify(body.tools[0].function.parameters)),wrapped?object({proposal:outputSchema}):outputSchema);return final(JSON.stringify(wrapped?{proposal:value}:value));},{outputSchema}).run(input);
 assert.deepEqual(JSON.parse(JSON.stringify(result.proposal)),value);assert.equal(calls,2);
});
const bad=[
 ['wrong-name',()=>final(undefined,'read_current')],
 ['duplicate-keys',()=>final('{"reply":"one","reply":"two"}')],
 ['truncated',()=>{const r=final();r.choices[0].finish_reason='length';return r;}],
 ['error-plus-choice',()=>({...final(),error:false})],
 ['extra-call',()=>{const r=final();r.choices[0].message.tool_calls.push({id:'second',type:'function',function:{name:'read_current',arguments:'{}'}});return r;}],
 ['bad-id',()=>{const r=final();r.choices[0].message.tool_calls[0].id='unsafe/id';return r;}],
 ['extra-function-key',()=>{const r=final();r.choices[0].message.tool_calls[0].function.path='/private/should-not-be-read';return r;}],
 ['text-tool-protocol',()=>{const r=final();r.choices[0].message.content='Requested tool: read_current';return r;}],
 ['blank-stop',()=>stop(' '.repeat(207))],
];
for(const [name,badFinal]of bad)test(`native final serialization rejects ${name} with no extra work`,async()=>{
 let calls=0,reads=0;await assert.rejects(make(()=>++calls===1?read():badFinal(),{execute:()=>{reads++;return{reply:'current evidence'};}}).run(input),e=>e.code==='PROVIDER_FAILED'&&e.providerFailure?.category==='protocol');assert.equal(calls,2);assert.equal(reads,1);
});
test('finalizer arguments remain subject to the original output schema',async()=>{
 for(const args of ['{"reply":false}','{"reply":"good","path":"/private/file"}','{"reply":""}']){
  let calls=0;await assert.rejects(make(()=>++calls===1?read():final(args)).run(input),e=>e.code==='OUTPUT_INVALID'&&!Object.hasOwn(e,'providerFailure'));assert.equal(calls,2);
 }
});
test('an early internal output call cannot bypass required authorized reads',async()=>{
 let calls=0,reads=0;await assert.rejects(make(()=>{calls++;return final();},{execute:()=>{reads++;return{reply:'current evidence'};}}).run(input),e=>e.code==='TOOL_CALL_INVALID');assert.equal(calls,1);assert.equal(reads,0);
});
test('the output namespace cannot be registered as an application tool',()=>{
 assert.throws(()=>make(()=>stop('{}'),{tools:[{...tool(()=>({reply:'x'})),name:FINAL}]}),e=>e.code==='INVALID_CONTRACT');
});
test('caller options cannot select internal native output behavior',()=>{
 for(const factory of [sdk.createRestrictedOpenAIProvider,sdk.createRestrictedDeepSeekProvider])assert.throws(()=>factory({model:'deepseek-flash',complete:()=>final(),finalizeWithTool:true}),e=>e.code==='INVALID_CONTRACT');
});
test('generic native OpenAI wire and internal-call rejection are unchanged',async()=>{
 let calls=0,reads=0;const provider=sdk.createRestrictedOpenAIProvider({model:'offline-model',supportsImages:false,complete:body=>{calls++;if(calls===1)return read();assert.equal(Object.hasOwn(body,'tools'),false);assert.equal(Object.hasOwn(body,'tool_choice'),false);return final();}});
 const app=sdk.createRestrictedApplicationRunner({provider,instructions:'Read current evidence only.',tools:[tool(()=>{reads++;return{reply:'current evidence'};})],outputSchema:schema,limits:{maxSteps:2,maxToolCalls:1}});
 await assert.rejects(app.run(input),e=>e.code==='STEP_LIMIT');assert.equal(calls,2);assert.equal(reads,1);
});
