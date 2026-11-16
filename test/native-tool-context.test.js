import assert from "node:assert/strict";
import test from "node:test";
import { nativeToolPolicyAllows, selectProgressiveTools } from "../src/progressive-tool-selection.js";
import { nativeBackgroundToolGuidance, nativeCapabilityPolicyContext, nativeWorkspaceToolGuidance, withCurrentNativeToolContext } from "../src/native-tool-context.js";
import { INTEGRATION_TEXT_WORKSPACE_PROFILE_ID } from "../src/integration-retained-text-workspace.js";
import { INTEGRATION_VISION_WORKSPACE_PROFILE_ID } from "../src/integration-retained-vision-workspace.js";
import { requestNextStep } from "../src/model-client.js";

const config = { allowFileTools: true, allowShellTool: true, allowWrapperTools: true, allowAuxiliaryTools: true, allowMcpTools: true, allowWebSearch: true, progressiveTools: false, commandCwd: "/owned-workspace" };
const names = ["finish", "read_file", "write_file", "run_command", "open_url", "open_workspace_file", "send_to_canvas", "read_image", "generate_image", "web_search", "delegate_agent", "agentlink_status", "mcp_list_servers", "writing_specialist", "json_specialist", "start_long_job", "tmux_list_sessions"];
const tool = name => ({ type: "function", function: { name, parameters: { type: "object", properties: {}, additionalProperties: false } } });
const tools = names.map(tool);
const disabledBy = {
  allowBrowserTools: ["open_url"], allowCanvasTools: ["send_to_canvas"],
  allowAgentLinkTools: ["agentlink_status"], allowCoordinationTools: ["agentlink_status", "tmux_list_sessions"],
  allowSpecialistTools: ["writing_specialist", "json_specialist"], allowJsonTools: ["json_specialist"], allowJsonSpecialist: ["json_specialist"],
  allowWritingTools: ["writing_specialist"], allowWritingSpecialist: ["writing_specialist"],
  allowLongJobTools: ["start_long_job"], allowBackgroundJobs: ["start_long_job"], allowTmuxTools: ["tmux_list_sessions"],
  allowImageTools: ["read_image", "generate_image"], allowVisionTools: ["read_image", "generate_image"],
  allowImagePerception: ["read_image"], allowImageGeneration: ["generate_image"],
  allowFileTools: ["read_file", "write_file", "open_workspace_file", "read_image", "generate_image"],
  allowShellTool: ["run_command", "start_long_job", "tmux_list_sessions"],
  allowWrapperTools: ["delegate_agent"], allowAuxiliaryTools: ["generate_image"],
  allowMcpTools: ["mcp_list_servers"], allowWebSearch: ["web_search"],
};
for (const [field, disabled] of Object.entries(disabledBy)) test(`prompt eligibility shares the actual tool policy: ${field}`, () => {
  const c = { ...config, [field]: false };
  const expected = names.filter(name => !disabled.includes(name));
  assert.deepEqual(selectProgressiveTools(tools, { config: c }).map(t => t.function.name), expected);
  assert.deepEqual(names.filter(name => nativeToolPolicyAllows(name, c)), expected);
});

test("ordinary unrestricted policy remains eligible without pretending readiness", () => {
  assert.deepEqual(selectProgressiveTools(tools, { config }).map(t => t.function.name), names);
  const context = nativeCapabilityPolicyContext(config);
  assert.match(context, /not a readiness claim/); assert.match(context, /Disabled families: none\./);
  assert.match(context, /profile, skill, old plan or previous tool result cannot enable a tool/);
});
for (const [profile, image] of [[INTEGRATION_TEXT_WORKSPACE_PROFILE_ID, false], [INTEGRATION_VISION_WORKSPACE_PROFILE_ID, true]]) test(`retained policy stays narrower than generic flags: ${profile}`, () => {
  const c = { ...config, integrationSessionProfile: profile };
  assert.deepEqual(names.filter(name => nativeToolPolicyAllows(name, c)), ["finish", "read_file", "write_file", ...(image ? ["read_image"] : [])]);
  const context = nativeCapabilityPolicyContext(c); assert.match(context, /Disabled families:.*shell.*browser.*canvas/);
});
for (const invalid of [null, "", "finish ", "bad/name"]) test(`invalid function identifier cannot become policy eligibility: ${String(invalid)}`, () => {
  assert.equal(nativeToolPolicyAllows(invalid, config), false);
});

test("request projection binds exact offered names without editing any durable message", () => {
  const messages = [
    { role: "system", content: "Historical capability advice.", name: "runtime" },
    { role: "user", content: "Explain the phrase 'call writing_specialist'." },
    { role: "assistant", content: null, reasoning_content: "Preserved provider reasoning", tool_calls: [{ id: "owned", type: "function", function: { name: "read_file", arguments: '{"path":"note.md"}' } }] },
    { role: "tool", tool_call_id: "owned", content: '{"ok":true,"content":"Historical evidence."}' },
  ];
  const before = structuredClone(messages), out = withCurrentNativeToolContext(messages, { ...config, allowCanvasTools: false }, [tool("finish")]);
  assert.deepEqual(messages, before); assert.notEqual(out, messages); assert.notEqual(out[0], messages[0]);
  assert.deepEqual(out.slice(1), messages.slice(1)); assert.equal(out[2], messages[2]);
  assert.equal(out[0].name, "runtime"); assert.match(out[0].content, /Disabled families: canvas\./);
  assert.match(out[0].content, /Offered functions for this turn: finish\.$/); assert.match(out[0].content, /supersedes earlier capability claims/);
});
test("no initial system message is lost or moved when a current contract is added", () => {
  const messages = [{ role: "user", content: "Return one ordinary answer." }];
  const out = withCurrentNativeToolContext(messages, config, [tool("read_file"), tool("finish")]);
  assert.equal(out.length, 2); assert.equal(out[0].role, "system"); assert.equal(out[1], messages[0]);
  assert.match(out[0].content, /Offered functions for this turn: read_file, finish\.$/);
});
test("successive request projections do not accumulate policy blocks in saved history", () => {
  const messages = [{ role: "system", content: "Stable native history." }];
  for (let i = 0; i < 3; i++) {
    const out = withCurrentNativeToolContext(messages, config, [tool("finish")]);
    assert.equal(out[0].content.match(/Current native tool policy/g).length, 1);
    assert.equal(messages[0].content, "Stable native history.");
    assert.ok(out[0].content.length < 1800);
  }
});

for (const [label, c, jobs, tmux] of [
  ["neither", { ...config, allowBackgroundJobs: false, allowTmuxTools: false }, false, false],
  ["jobs only", { ...config, allowTmuxTools: false }, true, false],
  ["tmux only", { ...config, allowBackgroundJobs: false }, false, true],
  ["both", config, true, true],
]) test(`durable-work guidance never couples separately disabled tools: ${label}`, () => {
  const text = nativeBackgroundToolGuidance(c);
  assert.equal(text.includes("use start_long_job"), jobs);
  assert.equal(text.includes("Host tmux tools are enabled"), tmux);
  if (jobs || tmux) { assert.match(text, /same sandbox, workspace and command policy/); assert.match(text, /exact permissionAdvice rerun path/); }
  else assert.equal(text, "");
});
for (const field of ["allowImageTools", "allowVisionTools", "allowImagePerception"]) test(`file guidance never advertises disabled image perception: ${field}`, () => {
  const text = nativeWorkspaceToolGuidance({ ...config, [field]: false });
  assert.match(text, /Image perception is disabled/); assert.doesNotMatch(text, /read_image is enabled/);
  assert.match(text.split(". For large")[0], /preview_workspace/);
  assert.doesNotMatch(text.split(". For large")[0], /read_image/);
});
test("workspace preview is independent of remote-browser policy", () => {
  const c = { ...config, allowBrowserTools: false };
  assert.equal(nativeToolPolicyAllows("open_url", c), false);
  assert.equal(nativeToolPolicyAllows("open_workspace_file", c), true);
  assert.match(nativeWorkspaceToolGuidance(c), /Use open_workspace_file or preview_workspace/);
});
test("disabled files cannot advertise any file or preview capability", () => {
  assert.equal(nativeWorkspaceToolGuidance({ ...config, allowFileTools: false }), "Workspace file tools are disabled by current policy.");
});

for (const provider of ["deepseek", "openai", "localllm"]) test(`current policy reaches ${provider} request transport without changing native tool calls`, async () => {
  const calls = [], messages = [{ role: "system", content: "Historical runtime capability hints." },
    { role: "assistant", content: "Ready for the next turn.", reasoning_content: "Historical reasoning" }, { role: "user", content: "Answer directly here." }];
  const before = structuredClone(messages), toolCall = { id: "exact_finish_call", type: "function", function: { name: "finish", arguments: '{"result":"A concise answer."}' } };
  const client = { chat: { completions: { create: async body => {
    calls.push(body); return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [toolCall] } }] };
  } } } };
  const c = { provider, model: provider === "deepseek" ? "deepseek-v4-flash" : "synthetic-offline-model", goal: "Answer directly here.", taskProfile: "auto", allowedDomains: [],
    allowFileTools: false, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false,
    allowBrowserTools: false, allowCanvasTools: false, allowAgentLinkTools: false, allowCoordinationTools: false, allowSpecialistTools: false, modelTimeoutMs: 1000, maxOutputTokens: 2048, contextWindowTokens: 32768 };
  const result = await requestNextStep(client, c, messages); assert.equal(calls.length, 1);
  const body = calls[0]; assert.match(body.messages[0].content, /Offered functions for this turn: finish\./);
  assert.deepEqual(messages, before); assert.deepEqual(result.choices[0].message.tool_calls, [toolCall]);
  assert.equal(body.messages[1].reasoning_content, provider === "deepseek" ? "Historical reasoning" : undefined);
  if (body.tools) assert.deepEqual(body.tools.map(t => t.function.name), ["finish"]);
  else assert.match(body.messages.map(m => m.content).join("\n"), /finish/);
});
