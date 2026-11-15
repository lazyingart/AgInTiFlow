import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const runtime=process.env.AGINTI_TEST_BASELINE_RUNTIME||fileURLToPath(new URL('../../',import.meta.url));
const {runAgent}=await import(pathToFileURL(runtime+'/src/agent-runner.js'));
const {resolveRuntimeConfig}=await import(pathToFileURL(runtime+'/src/config.js'));
const {closeSessionIndexConnections}=await import(pathToFileURL(runtime+'/src/session-index.js'));
const [root,baseURL,mode,phase='initial']=process.argv.slice(2), originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==new URL(baseURL).origin)throw Error('OFFLINE_PREPATCH_NETWORK_ESCAPE');return Reflect.apply(originalFetch,globalThis,[input,options]);};
const goal=phase==='resume'?'Please explain the blocker without changing files.':'Fix compute.py so its test passes. Run `python3 -m unittest -v test_compute.py` and leave unrelated files unchanged.';
const model=phase==='resume'?'deepseek-pro':'deepseek-flash';
const config=resolveRuntimeConfig({goal,provider:'deepseek',model,routingMode:'manual',taskProfile:'code',commandCwd:root+'/workspace',maxSteps:8,dynamicSteps:'off'},
 {baseDir:root+'/workspace',packageDir:runtime,sessionId:'prepatch-boundary-'+mode,apiKey:'synthetic-prepatch-key',baseURL,enableScs:'off',sandboxMode:'host',packageInstallPolicy:'block',
 allowFileTools:true,allowShellTool:true,allowDestructive:false,allowWrapperTools:false,allowAuxiliaryTools:false,allowWebSearch:false,allowMcpTools:false,allowParallelScouts:false,onConsole:()=>{},onLog:()=>{},onEvent:()=>{}});
Object.assign(config,{sessionsDir:root+'/sessions',projectSessionsDir:root+'/pointers',allowProviderHandoff:false,modelTimeoutMs:5000,
 routeProvider:'deepseek',routeModel:model,mainProvider:'deepseek',mainModel:model,spareProvider:'deepseek',spareModel:model,
 ...(phase==='resume'?{resume:'prepatch-boundary-'+mode,expectedRuntimeRevision:1,runtimePatch:{provider:'deepseek',model,routingMode:'manual',routeProvider:'deepseek',routeModel:model,mainProvider:'deepseek',mainModel:model,spareProvider:'deepseek',spareModel:model}}:{})});
let result=null,error=null;
try{result=await runAgent(config);}catch(e){error={code:e.code||'RUNTIME_ERROR',message:e.message};}finally{globalThis.fetch=originalFetch;closeSessionIndexConnections();}
const state=JSON.parse(await fs.readFile(root+'/sessions/prepatch-boundary-'+mode+'/state.json','utf8'));
console.log(JSON.stringify({result,error,runtimeRevision:state.meta.runtimeConfig.revision}));
