import assert from "node:assert/strict";
import test from "node:test";
import { buildKnownReadOnlyAnswerPhasePlan, nextStepRuntimeConfig } from "../src/agent-runner.js";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
import { selectProgressiveTools } from "../src/progressive-tool-selection.js";

const tools = ["read_file", "run_command", "finish"].map(name => ({
  type: "function", function: { name, description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false } },
}));
const saved = [
  "What was the second open item? Use the saved result and keep the file untouched.",
  "Which value was the last entry? Use the previous output.",
  "From the recorded output, what was the first label?",
  "What was the checksum? Use the retained output and leave the workspace alone.",
  "Using the previous result, which wavelength was the selected maximum?",
  "From the saved results, summarize the outcomes.",
  "根据已保存的结果，第二项是什么？",
  "保存済みの結果から、二番目の項目は何でしたか？",
];
const ordinary = [
  "What was the second open item? Read the file again.",
  "What was the second open item? Use the saved result and update handoff.txt.",
  "Use the saved result, inspect notes.md, then tell me the last value.",
  "From the recorded output, what was the first label? Check it against the current workspace.",
  "根据已保存的结果，第二项是什么？重新读取文件核对。",
  "保存済みの結果から、二番目の項目は何でしたか？ファイルを更新してください。",
  "What was the first label?",
  "Use the saved result and check the checksum now.",
  "Based on the previous output, what is the checksum now?",
];
function context(goal, meta = {}) {
  const state = { goal, plan: "", chat: [], messages: [], meta: { taskProfile: "code", ...meta } };
  const config = {goal, taskProfile: "code", provider: "deepseek", toolSurfacePolicy: "full", allowFileTools: true, allowShellTool: true};
  return { state, config };
}
for (const goal of saved) test(`explicit saved-result lookup: ${goal}`, () => {
  const {config,state} = context(goal);
  const contract = deriveScsTaskContract({goal,taskProfile:"code"});
  assert.equal(contract.readOnlyDiagnostic,true);
  assert.equal(contract.requiresExternalEvidence,false);
  assert.equal(contract.requiresFileMutation,false);
  assert.equal(contract.requiresWorkspaceMutation,false);
  const phase = buildKnownReadOnlyAnswerPhasePlan(config,state);
  assert.equal(phase?.mode,"read-only-answer");
  state.plan=phase.plan;
  const runtime=nextStepRuntimeConfig(config,state);
  assert.deepEqual(selectProgressiveTools(tools,{goal,config:runtime}).map(t=>t.function.name),["finish"]);
});
for (const goal of ordinary) test(`independent or mixed work keeps its tools: ${goal}`, () => {
  const {config,state}=context(goal);
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config,state),null);
  assert.ok(selectProgressiveTools(tools,{goal,config:nextStepRuntimeConfig(config,state)}).some(t=>t.function.name==="read_file"));
});
test("existing current execution obligations survive a historical lookup phrase", () => {
  const {config,state}=context(saved[0],{ activeExecutionContract:{revision:1,requiresSourceGrounding:true} });
  assert.equal(buildKnownReadOnlyAnswerPhasePlan(config,state),null);
  assert.ok(selectProgressiveTools(tools,{goal:state.goal,config:nextStepRuntimeConfig(config,state)}).some(t=>t.function.name==="read_file"));
});
