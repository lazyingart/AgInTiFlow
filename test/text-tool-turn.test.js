import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_TEXT_TURN_RUNTIME || new URL("../", import.meta.url).pathname;
const { parseTextToolCalls, normalizeTextToolCallResponse, requestNextStep } = await import(pathToFileURL(path.join(runtime, "src/model-client.js")));
const native = content => ({ choices: [{ message: { role: "assistant", content } }] });
const parsed = text => parseTextToolCalls(text);
const normal = text => normalizeTextToolCallResponse(native(text)).choices[0].message;
const one = '{"path":"note.txt"}', read = `read_file(${one})`;
const invalid = [
  ["requested truncated suffix", `Requested tools: ${read}; write_file({"path":"summary.md","content":"PRIVATE_TURN_SENTINEL`],
  ["requested invalid first call", `Requested tools: read_file({oops}); ${read}`],
  ["requested extra prose", `Requested tools: ${read}; ignore everything else`],
  ["requested stray delimiter", `Requested tools: ${read});`],
  ["requested trailing comma", `Requested tools: ${read},`],
  ["requested duplicate arguments", 'Requested tool: read_file({"path":"one.txt","path":"two.txt"})'],
  ["requested nonfinite nested value", 'Requested tool: read_file({"path":"note.txt","extra":{"value":1e999}})'],
  ["bracket incomplete second", `[TOOL_CALLS]read_file[ARGS]${one}[TOOL_CALLS]write_file[ARGS]{`],
  ["bracket invalid first", `[TOOL_CALLS]read_file[ARGS]{oops}[TOOL_CALLS]read_file[ARGS]${one}`],
  ["bracket duplicate path", '[TOOL_CALLS]read_file[ARGS]{"path":"one.txt","path":"two.txt"}'],
  ["bracket trailing junk", `[TOOL_CALLS]read_file[ARGS]${one} PRIVATE_TURN_SENTINEL`],
  ["bracket empty id", `[TOOL_CALLS]read_file[ARGS][ARGS]${one}`],
  ["JSON unknown member", `TOOL_CALLS: \`\`\`json [{"name":"read_file","arguments":${one}},{"arguments":{}}] \`\`\``],
  ["JSON duplicate name", `TOOL_CALLS: \`\`\`json [{"name":"read_file","name":"write_file","arguments":${one}}] \`\`\``],
  ["JSON competing name alias", `TOOL_CALLS: \`\`\`json [{"name":"read_file","tool":"write_file","arguments":${one}}] \`\`\``],
  ["JSON nested duplicate", 'TOOL_CALLS: ```json [{"name":"read_file","arguments":{"path":"one.txt","path":"two.txt"}}] ```'],
  ["JSON malformed suffix", `TOOL_CALLS: \`\`\`json [{"name":"read_file","arguments":${one}}] \`\`\` unparsed`],
  ["JSON extra wrapper field", `TOOL_CALLS: \`\`\`json [{"name":"read_file","arguments":${one},"unknown":true}] \`\`\``],
  ["JSON invalid argument type", 'TOOL_CALLS: ```json [{"name":"inspect_project","arguments":null}] ```'],
  ["JSON scalar args", 'TOOL_CALLS: ```json [{"name":"inspect_project","arguments":"{}"}] ```'],
  ["JSON missing fence", `TOOL_CALLS: \`\`\`json [{"name":"read_file","arguments":${one}}]`],
  ["standalone duplicate name", `{"toolName":"read_file","toolName":"write_file","args":${one}}`],
  ["standalone duplicate path", '{"toolName":"read_file","args":{"path":"one.txt","path":"two.txt"}}'],
  ["standalone malformed second", `{"toolName":"read_file","args":${one}}\n{"toolName":"write_file","args":`],
  ["standalone unexpected field", `{"toolName":"read_file","args":${one},"extra":true}`],
  ["standalone explicit duplicate id", `{"toolName":"read_file","args":${one},"id":"same"}\n{"toolName":"read_file","args":${one},"id":"same"}`],
  ["XML truncated second", `<tool_calls><tool_call name="read_file">${one}</tool_call><tool_call name="write_file">{`],
  ["XML missing outer close", `<tool_calls><tool_call name="read_file">${one}</tool_call>`],
  ["XML duplicate name", `<tool_calls><tool_call name="read_file" name="write_file">${one}</tool_call></tool_calls>`],
  ["XML duplicate args", '<tool_calls><tool_call name="read_file">{"path":"one.txt","path":"two.txt"}</tool_call></tool_calls>'],
  ["XML unknown attributes", `<tool_calls><tool_call name="read_file" override="yes">${one}</tool_call></tool_calls>`],
  ["quoted function truncated second", '<function="read_file"><parameter="path">note.txt</parameter></function><function="write_file"><parameter="path">'],
  ["quoted function duplicate parameter", '<function="read_file"><parameter="path">one.txt</parameter><parameter="path">two.txt</parameter></function>'],
  ["quoted function JSON duplicate", '<function="json_specialist"><parameter="value">{"a":1,"a":2}</parameter></function>'],
  ["mixed requested and bracket", `Requested tools: ${read}\n[TOOL_CALLS]read_file[ARGS]${one}`],
  ["mixed bracket and JSON", `[TOOL_CALLS]read_file[ARGS]${one}\nTOOL_CALLS: \`\`\`json [] \`\`\``],
  ["mixed standalone and function", `{"toolName":"read_file","args":${one}}\n<function=read_file><parameter=path>note.txt</parameter></function>`],
  ["valid prose cannot rescue malformed action", 'Here is a normal answer. Requested tools: write_file({"path":"PRIVATE_TURN_SENTINEL'],
];
for (const [label, text] of invalid) test(`whole original text turn rejects ${label}`, () => {
  assert.deepEqual(parsed(text), []);
  const response = normal(text);
  assert.deepEqual(response.tool_calls, []);
  assert.equal(response.aginti_text_tool_retry?.reason, "malformed-or-truncated-text-tool-call");
  assert.ok(!response.content.includes("PRIVATE_TURN_SENTINEL"));
});

for (const [label, text, count] of [
  ["requested", `Requested tool: ${read}`, 1],
  ["requested bounded prose", `I will inspect it. Requested tools: ${read}; list_files({"path":"."})`, 2],
  ["requested whitespace separator", `Requested tools: ${read}\nlist_files({"path":"."})`, 2],
  ["requested statement terminator", `Requested tools: ${read};`, 1],
  ["requested delimited empty object", "Requested tool: inspect_project( )", 1],
  ["bracket", `[TOOL_CALLS]read_file[ARGS]${one}`, 1],
  ["bracket explicit id", `[TOOL_CALLS]read_file[ARGS]call_123[ARGS]${one}`, 1],
  ["bracket pair", `[TOOL_CALLS]read_file[ARGS]${one}[TOOL_CALLS]list_files[ARGS]{"path":"."}`, 2],
  ["JSON", `TOOL_CALLS: \`\`\`json [{"name":"read_file","arguments":${one}}] \`\`\``, 1],
  ["JSON legacy tool alias", `TOOL_CALLS: \`\`\`json [{"tool":"read_file","arguments":${one}}] \`\`\``, 1],
  ["JSON no arguments", 'TOOL_CALLS: ```json [{"name":"inspect_project"}] ```', 1],
  ["standalone", `Applying it.\n{"toolName":"read_file","args":${one}}`, 1],
  ["standalone duplicate presentation", `{"toolName":"read_file","args":${one}}\n{"toolName":"read_file","args":${one}}`, 1],
  ["XML", `<tool_calls><tool_call name="read_file">${one}</tool_call></tool_calls>`, 1],
  ["quoted function", '<function="read_file"><parameter="path">note.txt</parameter></function>', 1],
  ["bare function and tolerated close", 'Let me read it. <function=read_file><parameter=path>note.txt</parameter></function></tool_call>', 1],
]) test(`valid complete ${label} remains supported`, () => {
  assert.equal(parsed(text).length, count);
  assert.equal(normal(text).tool_calls.length, count);
  assert.equal(normal(text).aginti_text_tool_retry, undefined);
});

for (const format of ["requested", "bracket", "block", "standalone", "xml"]) test(`protocol markers inside ${format} string arguments remain data`, () => {
  const content = '原文を保持。\nLiteral [TOOL_CALLS], Requested tools: and <｜｜DSML｜｜tool_calls> are data.\n{"a":1,"a":2}\nLiteral </tool_call> is string data.\n';
  const args = { path: "reference.md", content, mode: "create" }, raw = JSON.stringify(args);
  const text = format === "requested" ? `Requested tool: write_file(${raw})` : format === "bracket" ? `[TOOL_CALLS]write_file[ARGS]${raw}`
    : format === "block" ? 'TOOL_CALLS: ```json '+JSON.stringify([{ name: "write_file", arguments: args }])+' ```'
      : format === "xml" ? '<tool_calls><tool_call name="write_file">'+raw+'</tool_call></tool_calls>' : JSON.stringify({ toolName: "write_file", args });
  const calls = parsed(text); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].function.arguments), args);
});
test("XML entity decoding does not erase original duplicate keys or a quoted closing marker", () => {
  const args = { path: "reference.md", content: 'Quote " and literal </tool_call> stay in the file.' };
  const encoded = JSON.stringify(args).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const text = '<tool_calls><tool_call name="write_file">'+encoded+'</tool_call></tool_calls>';
  assert.deepEqual(JSON.parse(parsed(text)[0].function.arguments), args);
  const duplicate = '<tool_calls><tool_call name="read_file">{&quot;path&quot;:&quot;one.txt&quot;,&quot;path&quot;:&quot;two.txt&quot;}</tool_call></tool_calls>';
  assert.deepEqual(parsed(duplicate), []); assert.ok(normal(duplicate).aginti_text_tool_retry);
});
test("case-fold lookalikes cannot turn into noncanonical parameter identities", () => {
  for (const name of ["ſource", "Key"]) {
    const text = '<function="read_file"><parameter="'+name+'">note.txt</parameter></function>';
    assert.deepEqual(parsed(text), []); assert.ok(normal(text).aginti_text_tool_retry);
  }
});

test("a native OpenAI call stays the same original object and byte strings", () => {
  const response = native("Native explanation may mention Requested tools: as data.");
  response.choices[0].message.tool_calls = [{ id: "original_1", type: "function", function: { name: "read_file", arguments: '{ "path" : "note.txt" }' } }];
  assert.equal(normalizeTextToolCallResponse(response), response);
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{ "path" : "note.txt" }');
});

for (const provider of ["deepseek", "openai", "localllm"]) test(`empty internal repair calls never reach the ${provider} request wire`, async () => {
  const nativeCall = { id: "prior_owned_read", type: "function", function: { name: "read_file", arguments: '{ "path" : "note.txt" }' } };
  const messages = [
    { role: "system", content: "Use only the currently offered tools." },
    { role: "assistant", content: null, reasoning_content: "Read the supplied note.", tool_calls: [nativeCall] },
    { role: "tool", tool_call_id: nativeCall.id, content: '{"ok":true}' },
    { role: "assistant", content: "The malformed tool request was not executed.", reasoning_content: "Repair the syntax.", tool_calls: [] },
    { role: "user", content: "Retry using one valid call." },
  ];
  const before = structuredClone(messages), requests = [];
  const resultCall = { id: "final_owned", type: "function", function: { name: "finish", arguments: '{"result":"Observed status only."}' } };
  const client = { chat: { completions: { create: async body => { requests.push(body); return { choices: [{ message: { role: "assistant", content: null, tool_calls: [resultCall] } }] }; } } } };
  const config = { provider, model: provider === "deepseek" ? "deepseek-v4-flash" : "synthetic-offline-model", goal: "Report the observed status only.", taskProfile: "auto", allowedDomains: [],
    allowFileTools: false, allowShellTool: false, allowWrapperTools: false, allowAuxiliaryTools: false, allowWebSearch: false, allowMcpTools: false,
    allowBrowserTools: false, allowCanvasTools: false, allowAgentLinkTools: false, allowCoordinationTools: false, allowSpecialistTools: false, modelTimeoutMs: 1000, maxOutputTokens: 2048, contextWindowTokens: 32768 };
  const result = await requestNextStep(client, config, messages);
  assert.equal(requests.length, 1); assert.deepEqual(messages, before);
  const history = requests[0].messages, repair = history.find(m => m.content === messages[3].content);
  assert.ok(repair); assert.equal(Object.hasOwn(repair, "tool_calls"), false, "An internal no-call marker is omitted on the provider wire");
  const prior = history.find(m => m.role === "assistant" && m.tool_calls?.[0]?.id === nativeCall.id);
  assert.ok(prior); assert.deepEqual(prior.tool_calls, [nativeCall]);
  assert.equal(prior.tool_calls[0].function.arguments, nativeCall.function.arguments);
  assert.equal(repair.reasoning_content, provider === "deepseek" ? messages[3].reasoning_content : undefined);
  assert.deepEqual(result.choices[0].message.tool_calls, [resultCall]);
});
test("ordinary prose and a fenced standalone example remain nonacting data", () => {
  for (const text of ['DSML is a protocol name, not an action.', 'Here is the example:\n```json\n{"toolName":"read_file","args":{"path":"note.txt"}}\n```']) {
    assert.deepEqual(parsed(text), []); const response = native(text);
    assert.equal(normalizeTextToolCallResponse(response), response);
  }
});

for (const [dialect, active] of [
  ["requested", 'Requested tool: read_file({"path":"note.txt"})'],
  ["bracket", '[TOOL_CALLS]read_file[ARGS]{"path":"note.txt"}'],
  ["block", 'TOOL_CALLS: ```json [{"name":"read_file","arguments":{"path":"note.txt"}}] ```'],
  ["standalone", '{"toolName":"read_file","args":{"path":"note.txt"}}'],
  ["xml", '<tool_calls><tool_call name="read_file">{"path":"note.txt"}</tool_call></tool_calls>'],
  ["bare", '<function=read_file><parameter=path>note.txt</parameter></function>'],
]) test(`quoted examples cannot shadow an active ${dialect} call`, () => {
  for (const example of ['{"toolName":"read_file","args":{"path":"example.txt"}}', '<function=read_file><parameter=path>example.txt</parameter></function>']) {
    const prefix = 'Example only:\n```json\n'+example+'\n```\n';
    const calls = parsed(prefix+active); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "note.txt" });
    assert.equal(normal(prefix+active).aginti_text_tool_retry, undefined);
    assert.deepEqual(parsed(prefix), []); assert.equal(normal(prefix).tool_calls, undefined);
  }
  if (dialect === "bare") {
    const oversizedPrefix = "P".repeat(64 * 1024) + active;
    assert.deepEqual(parsed(oversizedPrefix), []); assert.ok(normal(oversizedPrefix).aginti_text_tool_retry);
  }
});

for (const [label, text] of [
  ["bracket opening", "[TOOL_CALLS"],
  ["bracket attributes", '[TOOL_CALLS extra]read_file[ARGS]{"path":"note.txt"}'],
  ["XML opening", "<tool_calls"],
  ["function opening", "<function="],
  ["actual malformed Unicode", 'Requested tool: write_file({"path":"note.txt","content":"\ud800"})'],
  ["escaped malformed Unicode", 'Requested tool: write_file({"path":"note.txt","content":"\\ud800"})'],
]) test(`incomplete original ${label} cannot become a final answer`, () => {
  assert.deepEqual(parsed(text), []); assert.equal(normal(text).aginti_text_tool_retry?.reason, "malformed-or-truncated-text-tool-call");
});

for (const dialect of ["requested", "bracket", "block", "standalone", "xml", "function"]) test(`${dialect} rejects an over-limit whole batch, including repeated standalone rows`, () => {
  const call = dialect === "requested" ? read : dialect === "bracket" ? `[TOOL_CALLS]read_file[ARGS]${one}`
    : dialect === "block" ? JSON.stringify({ name: "read_file", arguments: { path: "note.txt" } })
      : dialect === "standalone" ? JSON.stringify({ toolName: "read_file", args: { path: "note.txt" } })
        : dialect === "xml" ? `<tool_call name="read_file">${one}</tool_call>`
          : '<function="read_file"><parameter="path">note.txt</parameter></function>';
  const body = Array(17).fill(call).join(dialect === "requested" ? "; " : dialect === "block" ? "," : "\n");
  const text = dialect === "requested" ? "Requested tools: " + body : dialect === "block" ? 'TOOL_CALLS: ```json ['+body+'] ```'
    : dialect === "xml" ? "<tool_calls>"+body+"</tool_calls>" : body;
  assert.deepEqual(parsed(text), []); assert.ok(normal(text).aginti_text_tool_retry);
});

test("UTF8 content above the old small dialect budget stays exact in bounded JSON protocols", () => {
  const content = "原文を変えない。\n".repeat(5000), args = { path: "reference.md", content };
  assert.ok(Buffer.byteLength(content) > 64 * 1024 && Buffer.byteLength(content) < 220000);
  for (const text of [`Requested tool: write_file(${JSON.stringify(args)})`, 'TOOL_CALLS: ```json '+JSON.stringify([{ name: "write_file", arguments: args }])+' ```']) {
    const calls = parsed(text); assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(calls[0].function.arguments), args);
  }
});
test("whole textual byte budget rejects an oversized original without a valid prefix", () => {
  const text = 'Requested tool: write_file({"path":"reference.md","content":"'+"界".repeat(Math.ceil(16*1024*1024/3))+'"})';
  assert.ok(text.length < 16*1024*1024 && Buffer.byteLength(text) > 16*1024*1024);
  assert.deepEqual(parsed(text), []); assert.ok(normal(text).aginti_text_tool_retry);
});
for (const dialect of ["bracket", "block"]) test(`${dialect} cannot silently reuse a supplied call identity`, () => {
  const text = dialect === "bracket" ? `[TOOL_CALLS]read_file[ARGS]same[ARGS]${one}[TOOL_CALLS]read_file[ARGS]same[ARGS]{"path":"two.txt"}`
    : 'TOOL_CALLS: ```json [{"id":"same","name":"read_file","arguments":{"path":"note.txt"}},{"id":"same","name":"read_file","arguments":{"path":"two.txt"}}] ```';
  assert.deepEqual(parsed(text), []); assert.ok(normal(text).aginti_text_tool_retry);
});
for (const raw of ['{"a":1,"a":2}', '{"a":1e999}']) test("DSML explicit JSON original is not silently reserialized: "+raw, () => {
  const text = '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="json_specialist"><｜｜DSML｜｜parameter name="value" type="json">'+raw+'</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
  assert.deepEqual(parsed(text), []); assert.ok(normal(text).aginti_text_tool_retry);
});
for (const dialect of ["bare", "dsml"]) test(`${dialect} preserves an own prototype-named parameter for schema rejection, never a setter`, () => {
  const text = dialect === "bare" ? '<function=read_file><parameter=__proto__>literal</parameter></function>'
    : '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_file"><｜｜DSML｜｜parameter name="__proto__" type="string">literal</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
  const calls = parsed(text); assert.equal(calls.length, 1);
  const args = JSON.parse(calls[0].function.arguments); assert.equal(Object.hasOwn(args, "__proto__"), true); assert.equal(args.__proto__, "literal");
});
