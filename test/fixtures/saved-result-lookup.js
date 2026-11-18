import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runAgent } from "../../src/agent-runner.js";
import { resolveRuntimeConfig } from "../../src/config.js";
import { closeSessionIndexConnections } from "../../src/session-index.js";

const [root, stage, scs, behavior] = process.argv.slice(2);
const resume = stage === "resume", sessionId = "saved-lookup";
const model = resume ? "deepseek-v4-pro" : "deepseek-v4-flash";
const goal = behavior === "empty-history" ? "根据已保存的结果，第二项是什么？"
  : resume && behavior !== "recover-source" ? "What was the second open item? Use the saved result and keep the file untouched."
  : "Read queue.txt from line 4 to the end and tell me the two items in order. Do not change any file.";
const requests = [];
const clientFactory = async () => ({ chat: { completions: { create: async body => {
  const tools = (body.tools || []).map(tool => tool.function.name);
  const messages = JSON.stringify(body.messages);
  assert.ok(!messages.includes("ARCHIVE-OMIT-81"), "The provider only gets the requested excerpt");
  requests.push({ model: body.model, tools });
  const tool = (name, args) => ({ tool_calls: [{ id: "call_" + requests.length, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] });
  let message;
  if (resume && behavior !== "recover-source") {
    assert.deepEqual(tools, ["finish"], "Resumed lookup must never need a new observation or a planning request");
    assert.equal(body.model, model);
    const retainedPrefix="Previous assistant response retained as compacted history for DeepSeek thinking mode:\n";
    const answers=body.messages.map(m=>m.role==="assistant" ? m.content :
      m.role==="user" && m.content?.startsWith(retainedPrefix) ? m.content.slice(retainedPrefix.length) : "");
    const previous=answers.find(answer=>/^Recorded entries: PAPER KITE \| SILVER OAK [a-f0-9]{8}$/u.test(answer));
    assert.ok(previous, "The actual saved answer must survive native message repair");
    const second=previous.split(" | ")[1];
    assert.ok(!messages.includes("FRESH-ONLY-54"));
    message = behavior === "unoffered-read" && requests.length === 1
      ? tool("read_file", {path:"queue.txt"})
      : tool("finish", {result:`The recorded second item was ${second}.`});
  } else if (!tools.length) {
    message = { content: body.messages[0].content.includes("SCS committee")
      ? JSON.stringify({role:"committee",phase_goal:"Read and report queue.txt",plan:"Read queue.txt, then report both entries.",
        acceptance_criteria:["Read queue.txt and report its two entries"],allowed_tools:["read_file","finish"],stop_conditions:[]})
      : "Read queue.txt and report its entries." };
  } else {
    const read=body.messages.findLast(m=>m.role==="tool" && JSON.parse(m.content).toolName==="read_file");
    if (read) {
      const entries=JSON.parse(read.content).content.trim().split("\n");
      message=tool("finish",{result:`Recorded entries: ${entries.join(" | ")}`});
    } else {
      assert.ok(tools.includes("read_file"));
      message=tool("read_file",{path:"queue.txt",startLine:4});
    }
  }
  return {choices:[{index:0,finish_reason:message.tool_calls ? "tool_calls" : "stop",message:{role:"assistant",content:null,...message}}]};
} } } });
clientFactory.agintiDeterministicTest = true;
const workspace = path.join(root,"work"), sessionsDir = path.join(root,"sessions");
const config = resolveRuntimeConfig({provider:"deepseek",model,routingMode:"manual",taskProfile:"code",goal,commandCwd:workspace}, {
  baseDir:workspace, sessionId, packageDir:path.resolve(import.meta.dirname,"../.."), allowFileTools:true, allowShellTool:false,
  allowWebSearch:false, allowMcpTools:false, allowParallelScouts:false, allowWrapperTools:false, allowAuxiliaryTools:false,
  sandboxMode:"host", useDockerSandbox:false, enableScs:scs,
});
Object.assign(config,{sessionsDir,projectSessionsDir:path.join(root,"pointers"),model,clientFactory,
  apiKey:"offline-fixture",providerReadinessMode:"deterministic-test",scsValidationMode:"deterministic",enableScs:scs,scsActive:scs==="on",
  maxSteps:4,dynamicSteps:"off",allowProviderHandoff:false,routeProvider:"deepseek",routeModel:model,mainProvider:"deepseek",
  mainModel:model,spareProvider:"deepseek",spareModel:model,onConsole(){},onLog(){}});
if (resume) {
  const state=JSON.parse(await fs.readFile(path.join(sessionsDir,sessionId,"state.json")));
  Object.assign(config,{resume:sessionId,expectedRuntimeRevision:state.meta.runtimeConfig.revision,
    runtimePatch:{model,mainModel:model,routeModel:model,spareModel:model}});
}
try {
  const out=await runAgent(config);
  if (behavior === "empty-history") {
    assert.equal(out.stopped,true);assert.equal(out.reason,"saved_result_unavailable");
    assert.equal(out.goalStatus,"paused");assert.deepEqual(requests,[]);
  } else {
    assert.notEqual(out.stopped,true,JSON.stringify(out));
  }
  console.log(JSON.stringify({result:out.result,sessionId:out.sessionId,requests}));
} finally { closeSessionIndexConnections(); }
