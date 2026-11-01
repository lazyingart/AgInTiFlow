import assert from "node:assert/strict";
import test from "node:test";
import { createTestOnlyExecutionWorkerClient } from "../src/execution-worker-client.js";
import { createTestOnlyIntegrationAnalysisCoordinator } from "../src/integration-analysis-coordinator.js";
import { createTestOnlyIntegrationAnalysisPlanner } from "../src/integration-analysis-planner.js";

const scope = {principalId:"completion-protocol-fixture",browserSessionId:"a".repeat(64),
  threadId:"thr_00000000-0000-4000-8000-000000000061",runId:"run_00000000-0000-4000-8000-000000000062"};
const response = () => ({choices:[{finish_reason:"stop",message:{role:"assistant",content:"READY"}}]});
function fixture(value) {
  let workerCalls = 0;
  const coordinator = createTestOnlyIntegrationAnalysisCoordinator(createTestOnlyExecutionWorkerClient(async () => {
    workerCalls++;
    throw Error("No worker call is allowed in a completion protocol check");
  }));
  const planner = createTestOnlyIntegrationAnalysisPlanner({coordinator,modelClient:{},
    localModelConfig:{provider:"deepseek",baseURL:"https://api.deepseek.com/v1",model:"deepseek-flash",
      apiKey:"synthetic-not-a-real-provider-credential",thinking:"disabled"},complete:async()=>value});
  return {coordinator,planner,workerCalls:()=>workerCalls};
}
for (const [name, change] of [
  ["truncated", v=>{v.choices[0].finish_reason="length";}],
  ["filtered", v=>{v.choices[0].finish_reason="content_filter";}],
  ["unknown finish", v=>{v.choices[0].finish_reason="future_partial";}],
  ["null finish", v=>{v.choices[0].finish_reason=null;}],
  ["refusal mixed with text", v=>{v.choices[0].message.refusal="refused";}],
  ["multiple choices", v=>{v.choices.push(structuredClone(v.choices[0]));}],
  ["legacy function call", v=>{v.choices[0].message.function_call={name:"exec",arguments:"{}"};}],
  ["wrong role", v=>{v.choices[0].message.role="user";}],
  ["unfinished native tool", v=>{v.choices[0].finish_reason="length";v.choices[0].message.tool_calls=[{
    id:"call_01",type:"function",function:{name:"execute_python_analysis",arguments:'{"source":"print(1)"}'}}];}],
  ["tool finish without a call", v=>{v.choices[0].finish_reason="tool_calls";}],
]) {
  test(`${name} never publishes success or dispatches a tool`, async () => {
    const value=response();change(value);const f=fixture(value);let finals=0;
    try {
      await assert.rejects(f.planner.run(scope,{prompt:"Say READY."},{onFinal:()=>{finals++;}}),
        error=>error.code==="ANALYSIS_MODEL_PROTOCOL_INVALID");
      assert.equal(finals,0);assert.equal(f.workerCalls(),0);
    } finally {f.coordinator.close();}
  });
}
for (const inference of [undefined,{responseFormat:"text"},{responseFormat:"json_object"}]) {
  test(`complete reply remains accepted (${inference?.responseFormat||"normal"})`, async () => {
    const value=response();if(inference?.responseFormat==="json_object")value.choices[0].message.content='{"ready":true}';
    const f=fixture(value);
    try {
      const result=await f.planner.run(scope,{prompt:"Say READY.",...(inference?{inference}:{})});
      assert.equal(result.toolCalls,0);assert.equal(f.workerCalls(),0);
      assert.equal(result.text,value.choices[0].message.content);
    } finally {f.coordinator.close();}
  });
}
