import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
const runtime=process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL('../../', import.meta.url));
const {runAgent}=await import(pathToFileURL(runtime+'/src/agent-runner.js'));
const {resolveRuntimeConfig}=await import(pathToFileURL(runtime+'/src/config.js'));
const {closeSessionIndexConnections}=await import(pathToFileURL(runtime+'/src/session-index.js'));
const [root,baseURL,goal,phase='start']=process.argv.slice(2),fetch0=globalThis.fetch;
globalThis.fetch=(input,options)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.origin!==new URL(baseURL).origin)throw Error('DIAGNOSTIC_OFFLINE_NETWORK_ESCAPE');return Reflect.apply(fetch0,globalThis,[input,options]);};
const model=phase==='start'?'deepseek-v4-flash':'deepseek-v4-pro';
const scsMode=process.env.AGINTI_TEST_SCS_MODE||'off';
if(!['off','on'].includes(scsMode))throw Error('INVALID_DIAGNOSTIC_TEST_SCS_MODE');
const validationMode=process.env.AGINTI_TEST_SCS_VALIDATION_MODE||'deterministic';
if(!['deterministic','model'].includes(validationMode))throw Error('INVALID_DIAGNOSTIC_TEST_SCS_VALIDATION_MODE');
const config=resolveRuntimeConfig({provider:'deepseek',model,routingMode:'manual',taskProfile:'code',goal,commandCwd:root+'/workspace',maxSteps:6,dynamicSteps:'off'},
 {baseDir:root+'/workspace',packageDir:runtime,sessionId:'diagnostic-status',baseURL,apiKey:'synthetic-diagnostic-only',enableScs:scsMode,sandboxMode:'host',packageInstallPolicy:'block',allowFileTools:true,allowShellTool:true,allowDestructive:true,allowWrapperTools:false,allowAuxiliaryTools:false,allowWebSearch:false,allowMcpTools:false,allowParallelScouts:false,onConsole:()=>{},onLog:()=>{}});
Object.assign(config,{sessionsDir:root+'/sessions',projectSessionsDir:root+'/pointers',allowProviderHandoff:false,modelTimeoutMs:4000,scsValidationMode:validationMode,routeProvider:'deepseek',routeModel:model,mainProvider:'deepseek',mainModel:model,spareProvider:'deepseek',spareModel:model,...(phase==='resume'?{resume:'diagnostic-status',expectedRuntimeRevision:1,runtimePatch:{model,routeModel:model,mainModel:model,spareModel:model}}:{})});
try{console.log(JSON.stringify({resolved:true,result:await runAgent(config)}));}
catch(e){console.log(JSON.stringify({resolved:false,code:e.code||'ERROR',status:e.status||0,message:e.message}));}
finally{globalThis.fetch=fetch0;closeSessionIndexConnections();}
