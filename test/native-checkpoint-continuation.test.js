import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { isBareTaskContinuationText, continuationAddsConcreteRequirement, applyContinuationContractTransition, isCompletedContinuationNoop, projectSavedRuntimeSnapshots } = await import(pathToFileURL(path.join(runtime, "src/agent-runner.js")));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(runtime, "src/scs-evidence.js")));
const original = "Can you turn measurement.txt into a short brief.md and a checklist.md of what is still to do? Leave the source as it is.";
const hash = text => createHash("sha256").update(text).digest("hex");
function stateFor(status = "failed", goal = original) {
  return { goal, plan: "Read the source; save brief.md and checklist.md.", meta: {
    taskProfile: "code", projectVerification: { mutationRevision: 1, mutationHistory: [{ revision: 1, goalRevision: 1, taskHash: hash(goal), paths: ["brief.md"] }], commandRuns: [], requiredCommands: [] },
    goalContract: { version: 3, revision: 1, status, taskGoal: goal, activeGoal: goal, activeGoalRevision: 1, taskBoundaryRevision: 1,
      history: [{ revision: 1, kind: "initial", hash: hash(goal), preview: goal }], lifecycle: [] },
  } };
}
const continuations = [
  "Please continue from where you stopped.", "Continue where we left off.",
  "Kindly resume from where I paused.", "Pick up where we left off.",
  "Please pick up from where you stopped.", "Carry on from where we stopped.",
  "Resume from the last checkpoint.", "Continue from your saved checkpoint.",
  "请从上次停下的地方继续。", "从刚才中断的位置接着。",
  "前回止まったところから続けてください。", "中断したところから再開してください。",
];
for (const prompt of continuations) test(`bounded checkpoint continuation preserves actual goal: ${prompt}`, () => {
  assert.equal(isBareTaskContinuationText(prompt), true); assert.equal(continuationAddsConcreteRequirement(prompt), false);
  for (const status of ["failed", "completed"]) {
    const state = stateFor(status), before = structuredClone(state.meta.projectVerification);
    const update = applyContinuationContractTransition(state, prompt);
    assert.equal(update.preserveTaskBoundary, true); assert.equal(update.refreshExecutionContract, false);
    assert.equal(state.goal, original); assert.equal(state.meta.goalContract.taskGoal, original); assert.equal(state.meta.goalContract.activeGoal, original);
    assert.equal(state.meta.goalContract.taskBoundaryRevision, 1); assert.deepEqual(state.meta.projectVerification, before);
    assert.equal(isCompletedContinuationNoop(update, prompt, state), status === "completed");
  }
});

for (const prompt of [
  "Please continue from where you stopped and save notes.md.",
  "Resume from the last checkpoint but delete legacy.txt.",
  "Pick up where we left off. Show me the current status.",
  "Continue from the last checkpoint.py", "Could you tell me where you stopped?",
  "请从上次停下的地方继续，并删除草稿。", "中断したところから再開して、結果を教えてください。",
  "Resume another project from the last checkpoint.",
]) test(`new requirements are not swallowed as a checkpoint no-op: ${prompt}`, () => {
  assert.equal(isBareTaskContinuationText(prompt), false); assert.equal(continuationAddsConcreteRequirement(prompt), true);
  const state = stateFor("completed"), update = applyContinuationContractTransition(state, prompt);
  assert.equal(isCompletedContinuationNoop(update, prompt, state), false);
});

test("retained history repairs a generic legacy active goal without rewriting provenance", () => {
  const state = stateFor(); const bare = continuations[0];
  Object.assign(state.meta.goalContract, { revision: 2, taskGoal: bare, activeGoal: bare, activeGoalRevision: 2, taskBoundaryRevision: 2 });
  state.goal = bare;state.plan = "Run a command for the generic task inferred by the old runtime.";
  const historical = { revision: 2, kind: "continuation", relation: "new-request", hash: hash(bare), preview: bare, taskHash: hash(bare) };
  state.meta.goalContract.history.push(historical);
  const update = applyContinuationContractTransition(state, bare);
  assert.equal(update.preserveTaskBoundary, true); assert.equal(state.goal, original); assert.equal(state.meta.goalContract.taskGoal, original);
  assert.equal(state.meta.goalContract.activeGoal, original); assert.equal(state.meta.goalContract.activeGoalRevision, 3);
  assert.equal(state.plan, "", "a plan inferred for the discarded generic goal is not retained");
  assert.equal(state.meta.goalContract.taskBoundaryRevision, 2, "do not retroactively grant older mutation provenance");
  assert.deepEqual(state.meta.goalContract.history[1], historical);
});

test("checkpoint wording never removes an earlier concrete active correction", () => {
  const state = stateFor();const active = "Continue the same task. Add notes.md containing the verified result.";
  state.meta.goalContract.activeGoal = active;state.meta.goalContract.activeGoalRevision = 2;state.meta.goalContract.revision = 2;
  state.meta.goalContract.history.push({ revision: 2, kind: "same-task-continuation", relation: "same-task", hash: hash(active), preview: active, taskHash: hash(original), activeHash: hash(active), refreshExecutionContract: true });
  applyContinuationContractTransition(state, continuations[0]);
  assert.equal(state.goal, active);assert.equal(state.meta.goalContract.activeGoalRevision, 2);
});

test("missing material history cannot invent an earlier task during recovery", () => {
  const state = stateFor();const bare = continuations[0];state.goal = bare;
  Object.assign(state.meta.goalContract, { taskGoal: bare, activeGoal: bare, history: [] });
  applyContinuationContractTransition(state, bare);assert.notEqual(state.goal, original);assert.equal(state.meta.goalContract.taskGoal, bare);
});

test("same-task checkpoint continuation preserves real required commands", () => {
  const commandGoal = "Run `node check.mjs` and report the observed result.";const state = stateFor("failed", commandGoal);
  applyContinuationContractTransition(state, continuations[0]);
  assert.equal(state.goal, commandGoal);
  assert.ok(deriveScsTaskContract({ goal: state.goal, taskProfile: "code" }).requiredProjectCommands.includes("node check.mjs"));
});

test("saved runtime snapshot projection removes only the generated goal cache and preserves user input", () => {
  const originalGoal = "Keep the bilingual credit exactly as 青禾工房 · 葉澄.";
  const ordinary = 'Keep <etc> and the literal field "preparedForGoal" in the caption.';
  const heading = "Step 2/8 (6 steps remain after this one). Latest runtime snapshot:\n";
  const surgicalContext = {
    preparedForGoal: originalGoal, fingerprint: "catalogue-map", generatedAt: "2026-11-18T12:00:00.000Z",
    mapPath: ".aginti/codebase-map.json", artifactPath: "artifacts/surgical-context-pack.json",
    summary: "One layout reference.", contextPreview: "layout.txt",
  };
  const snapshot = {
    title: "Catalogue proof", url: "https://catalogue.invalid/proof", pageText: "Check the folio.",
    elements: [{ id: 1, tag: "button", text: "Next folio" }], browserOpen: true,
    shellToolAvailable: false, fileToolsAvailable: true, commandCwd: "/workspace", plan: "Check the layout.",
    surgicalContext, stepBudget: { mode: "off", initialMaxSteps: 8, currentMaxSteps: 8 },
  };
  const generated = heading + JSON.stringify(snapshot);
  // The pasted envelope has the same heading, evidence shape, and cache value as the runtime's.
  const pasted = heading + JSON.stringify({ ...snapshot, title: "Reader-supplied proof" });
  const user = content => ({ role: "user", content });
  const state = {
    goal: originalGoal, meta: { surgicalContext },
    chat: [user(originalGoal), user(ordinary), user(pasted)],
    messages: [user(originalGoal), user(generated), user(ordinary), user(pasted)],
  };
  const before = structuredClone(state);
  assert.equal(typeof projectSavedRuntimeSnapshots, "function", "Runner must export projectSavedRuntimeSnapshots");
  const projected = projectSavedRuntimeSnapshots(state);
  assert.ok(Array.isArray(projected));
  assert.equal(projected.length, state.messages.length);
  assert.equal(projected[1].role, "user");
  assert.ok(projected[1].content.startsWith(heading));
  const expected = structuredClone(snapshot);
  delete expected.surgicalContext.preparedForGoal;
  assert.deepEqual(JSON.parse(projected[1].content.slice(heading.length)), expected);
  assert.deepEqual([projected[0], ...projected.slice(2)], state.chat);
  assert.deepEqual(state, before, "Projection must preserve persisted messages, chat, and the durable cache");
  assert.strictEqual(projectSavedRuntimeSnapshots({ ...state, messages: projected }), projected,
    "An already projected history must reuse its message array, including authentic pasted snapshots");
});

test("official CLI resumes a quota-interrupted file task and completed checkpoint is a no-op",
  { timeout: 30000 }, t => exerciseCheckpoint(t, false));
test("fresh CLI recovers a middle instruction from a compacted multi-page task without repeating writes",
  { timeout: 75000 }, t => exerciseCheckpoint(t, true));

async function exerciseCheckpoint(t, longBrief) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-checkpoint-continuation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));await fs.mkdir(root + "/workspace");
  const credit = 'Keep the checklist credit exactly as "Lin / Mori".';
  const notes = Array.from({ length: 64 }, (_, i) =>
    `Scene ${i + 1}: preserve its supplied caption, bilingual phrasing, sequence and previously approved location.`);
  notes.splice(30, 0, credit);
  const goal = longBrief ? [original, ...notes, "Deliver the two requested files."].join("\n") : original;
  if (longBrief) await fs.writeFile(path.join(root, "long-request.txt"), goal);
  await fs.writeFile(root + "/workspace/measurement.txt", "Latency fell from 120 ms to 90 ms across 12 samples. Independent review is pending.\n");
  const brief = "# Brief\n\nLatency fell from 120 ms to 90 ms in the supplied test (12 samples). Independent review is pending.\n";
  const checklist = "# Checklist\n\n- [ ] Obtain independent review.\n" + (longBrief ? "Credit: Lin / Mori\n" : "");
  const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let phase = "start", turns = 0, requests = 0;const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      requests++;const chunks = [];for await (const b of req) chunks.push(b);const body = JSON.parse(Buffer.concat(chunks));let message;
      if (!body.tools) message = { content: "1. Read the source.\n2. Write the brief.\n3. Write the remaining checklist." };
      else if (phase === "start" && turns++ === 0) message = { tool_calls: [call("read_file", { path: "measurement.txt" }, "read_source")] };
      else if (phase === "start" && turns === 2) message = { tool_calls: [call("write_file", { path: "brief.md", content: brief }, "write_brief")] };
      else if (phase === "start") { res.writeHead(402, { "content-type": "application/json" });res.end('{"error":{"code":"insufficient_balance","message":"Synthetic exhausted balance"}}');return; }
      else if (turns++ === 0) {
        if (longBrief) assert.ok(body.messages.some(m => m.role === "user" &&
          m.content?.startsWith("The runtime proactively compacted") && m.content.includes(credit)),
        "middle instruction missing from compacted model request after restart");
        message = { tool_calls: [call("write_file", { path: "checklist.md", content: checklist }, "write_checklist")] };
      }
      else if (turns === 2) message = { tool_calls: [call("read_file", { path: "brief.md" }, "verify_brief_as_data")] };
      else if (turns === 3) message = { tool_calls: [call("read_file", { path: "checklist.md" }, "verify_checklist_as_data")] };
      else message = { tool_calls: [call("finish", { result: "The brief.md and checklist.md are ready. The source is unchanged and independent review remains pending." }, "finish_task")] };
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, reasoning_content: "Preserve confirmed work and finish only the missing file.", ...message } }] }));
    } catch (e) { errors.push(e.message);res.writeHead(400);res.end('{"error":{"message":"Fixture request rejected"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, HOME: root, AGINTIFLOW_HOME: root + "/home", LANG: "C.UTF-8", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0", DEEPSEEK_API_KEY: "synthetic-continuation-key", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: process.env.AGINTI_TEST_BASELINE_RUNTIME } : {}) };
  async function run(args, extra = {}, input = "") {
    const child = spawn(process.execPath, args, { cwd: root + "/workspace", env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });let stdout = "", stderr = "", expired = false;
    child.stdout.on("data", b => stdout += b);child.stderr.on("data", b => stderr += b);child.stdin.on("error", () => {});child.stdin.end(input);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { expired = true;child.kill("SIGKILL"); }, longBrief ? 22000 : 12000);
      child.once("error", e => { clearTimeout(timer);reject(e); });child.once("close", c => { clearTimeout(timer);resolve(c); });
    });assert.equal(expired, false);return { code, stdout, stderr, data: JSON.parse(stdout) };
  }
  if (longBrief) Object.assign(env, { AGINTI_CONTEXT_BUDGET_MODE: "on", AGINTI_CONTEXT_BUDGET_CHARS: "10000",
    AGINTI_CONTEXT_TARGET_TOKENS: "16000", AGINTI_CONTEXT_WINDOW_TOKENS: "64000" });
  const seed = await run([fileURLToPath(new URL("./fixtures/native-terminal-quota.js", import.meta.url)), root, origin + "/v1", "start", ...(longBrief ? ["long-brief"] : [])]);
  assert.equal(seed.code, 0, seed.stderr);assert.equal(seed.data.resolved, false);phase = "resume";turns = 0;
  const briefPath = path.join(root, "workspace", "brief.md");
  const confirmed = await fs.stat(briefPath, { bigint: true });
  const args = [path.join(runtime, "bin/aginti-cli.js"), "run", "--resume", "terminal-quota", "--stdin", "--json", "--no-auto-update", "--provider", "deepseek", "--model", "deepseek-flash", "--routing", "manual", "--route-model", "deepseek-flash", "--main-model", "deepseek-flash", "--spare-model", "deepseek-flash"];
  const extra = { NODE_OPTIONS: "--import=" + fileURLToPath(new URL("./fixtures/native-terminal-quota-cli.js", import.meta.url)), AGINTI_TEST_QUOTA_ORIGIN: origin };
  const finished = await run(args, extra, continuations[0]);assert.deepEqual(errors, []);assert.equal(finished.code, 0, JSON.stringify(finished));assert.equal(finished.data.ok, true);
  const state = JSON.parse(await fs.readFile(root + "/home/sessions/terminal-quota/state.json"));
  assert.equal(state.meta.goalContract.taskGoal, goal);assert.equal(state.meta.goalContract.activeGoal, goal);
  if (longBrief) assert.ok(state.meta.contextBudget.compactions > 0);
  const retained = await fs.stat(briefPath, { bigint: true });
  assert.equal(retained.ino, confirmed.ino);assert.equal(retained.mtimeNs, confirmed.mtimeNs);
  assert.equal(state.meta.goalContract.taskRelation, "same-task");assert.equal(state.meta.goalContract.status, "completed");
  assert.equal(await fs.readFile(root + "/workspace/brief.md", "utf8"), brief);assert.equal(await fs.readFile(root + "/workspace/checklist.md", "utf8"), checklist);
  const count = requests;const noOp = await run(args, extra, continuations[0]);assert.equal(noOp.code, 0, noOp.stderr);assert.equal(noOp.data.ok, true);assert.equal(requests, count, "completed continuation must not invoke a provider or repeat tools");assert.deepEqual(errors, []);
}

function catalogueBrief() {
  const notes = [
    "An ochre wash runs along the edge of the page. The facing leaf shows a shallow pool under a narrow footbridge.",
    "河岸边留下了雨后的水线，远处的树影倒映在安静的浅滩。画面右侧的小船还停在旧码头旁。",
    "桟橋から古い灯台までは小石の道が続いている。午後の光が港の壁を横切り、岸壁の継ぎ目が見える。",
    "Sur la rive, deux barques sont tirées sur le sable. Les ombres courtes indiquent une prise de vue vers midi.",
    "La orilla se curva junto al puente. Una hoja caída aparece en primer plano y el reflejo ocupa la mitad inferior.",
    "展台旁的玻璃映着坡上的灯，侧面的浅蓝色衬布和河面形成呼应。手绘图的小舟旁有一枚藏书章。🛶",
  ];
  const values = ["青禾工房 · 葉澄", "雨あがりの渡し場", "warm pear blossom"].map(
    label => label + " " + randomBytes(6).toString("hex")
  );
  const instructions = new Map([
    [116, `排版时，修裱师的署名请原样写作「${values[0]}」。`],
    [245, `見返しの写真には「${values[1]}」と添えてください。`],
    [381, `Describe the endpaper shade as “${values[2]}” in the production note.`],
  ]);
  const lines = [
    "For the catalogue production note, consult layout.txt for the column layout. Quote the restorer credit, flyleaf caption and endpaper shade exactly, in that order. Catalogue index: 116 / 245 / 381.",
    "The catalogue opens with a view of the hillside.",
  ];
  for (let i = 0; i < 505; i++) {
    const label = `Folio ${String(i + 1).padStart(3, "0")}.`;
    lines.push([label, instructions.get(i + 1), notes[i % notes.length], notes[(i + 1) % notes.length]].filter(Boolean).join(" "));
  }
  lines.push("Place the foldout after the harbour panorama.");
  const goal = lines.join("\n");
  assert.ok(goal.length >= 84000 && goal.length < 86000);
  return { goal, values };
}

// This preload only transports the CLI's actual HTTP request body over the test child IPC pipe.
const catalogueTransport = `
  import { Socket } from "node:net";
  Socket.prototype.connect = () => { throw Error("Offline catalogue CLI refused socket connection"); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://api.deepseek.com" || !["/chat/completions", "/v1/chat/completions"].includes(url.pathname))
      throw Error("Offline catalogue CLI refused endpoint");
    const response = await new Promise(resolve => {
      process.once("message", resolve);
      process.send(JSON.parse(init.body));
    });
    return new Response(JSON.stringify(response.body), {status: response.status, headers: {"content-type":"application/json"}});
  };
`;
const offlineReply = message => ({ status: 200, body: { choices: [{ index: 0,
  finish_reason: message.tool_calls ? "tool_calls" : "stop", message: {role: "assistant", ...message} }] } });

async function runCatalogueCli(root, args, input, respond) {
  const env = {
    PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: root, AGINTIFLOW_HOME: path.join(root, "home"),
    AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1",
    AGINTIFLOW_NO_AUTH_PROMPT: "1", AGINTI_PROVIDER_HANDOFF: "0", DEEPSEEK_API_KEY: "synthetic-offline-provider-key",
    AGINTI_CONTEXT_BUDGET_MODE: "on", AGINTI_CONTEXT_BUDGET_CHARS: "76000",
    AGINTI_CONTEXT_TARGET_TOKENS: "16000", AGINTI_CONTEXT_WINDOW_TOKENS: "64000",
  };
  const child = spawn(process.execPath, [
    "--import", "data:text/javascript," + encodeURIComponent(catalogueTransport), path.join(runtime, "bin/aginti-cli.js"),
    "run", "--stdin", "--json", "--no-auto-update", ...args,
  ], { cwd: path.join(root, "workspace"), env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", failure;
  child.stdout.setEncoding("utf8").on("data", text => stdout += text);
  child.stderr.setEncoding("utf8").on("data", text => stderr += text);
  child.stdin.on("error", () => {});
  child.on("message", body => {
    try { child.send(respond(body)); }
    catch (error) { failure = error; child.kill("SIGKILL"); }
  });
  const timer = setTimeout(() => {
    failure = new Error("Offline catalogue CLI exceeded its subprocess deadline");
    child.kill("SIGKILL");
  }, 90000);
  try {
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(input);
    const code = await closed;
    if (failure) throw failure;
    assert.ok(stdout.trim(), "Missing CLI response: " + stderr.slice(-400));
    return { code, data: JSON.parse(stdout) };
  } finally {
    clearTimeout(timer);
  }
}

const catalogueWindowLimit = 256;

// The resumed provider has no reference to the goal, the oracle, session files or the initial provider.
function catalogueReader() {
  let folios, layout;
  const quotes = [];
  let pending;
  return body => {
    const tools = (body.tools || []).map(tool => tool.function.name);
    function call(name, args, id) {
      assert.ok(tools.includes(name), `Missing advertised native tool: ${name}`);
      pending = id;
      return offlineReply({content: null, reasoning_content: "Read just the requested evidence.",
        tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(args)}}]});
    }
    if (!folios) {
      const summary = body.messages.find(message => message.role === "user" &&
        message.content?.startsWith("The runtime proactively compacted"));
      const index = summary?.content.match(/Catalogue index: (\d+) \/ (\d+) \/ (\d+)\./);
      assert.ok(index, "Missing neutral folio locators in compacted request");
      folios = index.slice(1);
      return call("read_file", {path: "layout.txt", startLine: 1, lineLimit: 1}, "layout");
    }
    const message = body.messages.find(m => m.role === "tool" && m.tool_call_id === pending);
    assert.ok(message, `Missing dispatched tool reply for ${pending}`);
    const result = JSON.parse(message.content);
    assert.equal(result.ok, true, `Unsuccessful tool reply for ${pending}`);
    if (pending === "layout") {
      assert.equal(result.toolName, "read_file");
      assert.equal(typeof result.content, "string");
      layout = result.content.trim();
    } else {
      assert.equal(result.toolName, "read_current_task");
      assert.equal(typeof result.excerpt, "string", "Native task window must return a string excerpt");
      assert.ok(Array.from(result.excerpt).length <= catalogueWindowLimit && message.content.length <= 4096, "Unbounded task reply");
      const locator = `Folio ${folios[quotes.length]}.`;
      assert.ok(result.excerpt.includes(locator), "Window missed its requested folio");
      const quote = result.excerpt.slice(result.excerpt.indexOf(locator)).match(/[「“]([^」”]+)[」”]/u);
      assert.ok(quote, "Window omitted the quoted production instruction");
      quotes.push(quote[1]);
    }
    if (quotes.length === folios.length) return call("finish", {result: [layout, ...quotes].join("\n")}, "catalogue_done");
    const folio = folios[quotes.length];
    return call("read_current_task", {query: `Folio ${folio}.`, limit: catalogueWindowLimit}, "folio_" + folio);
  };
}

test("large catalogue recall uses bounded native windows across a real CLI restart", {timeout: 210000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-catalogue-recall-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const layout = "Two columns on the facing page.";
  await fs.writeFile(path.join(workspace, "layout.txt"), layout + "\n");
  const {goal, values} = catalogueBrief();
  const sid = "catalogue-recall", session = path.join(root, "home", "sessions", sid);
  const seed = await runCatalogueCli(root, [
    "--session-id", sid, "--provider", "deepseek", "--model", "deepseek-flash", "--routing", "manual",
    "--route-model", "deepseek-flash", "--main-model", "deepseek-flash", "--spare-model", "deepseek-flash",
    "--profile", "code", "--scs", "off", "--max-steps", "9", "--dynamic-steps", "off", "--sandbox-mode", "host",
    "--allow-file-tools", "--no-shell", "--no-web-search", "--no-mcp", "--no-wrappers", "--no-auxiliary-tools", "--no-parallel-scouts",
  ], goal, body => body.tools
    ? {status: 402, body: {error: {code: "insufficient_balance", message: "Synthetic catalogue interruption"}}}
    : offlineReply({content: "1. Consult the layout reference.\n2. Quote the catalogue instructions."}));
  assert.equal(seed.code, 1);
  assert.match(seed.data.reason, /402.*Synthetic catalogue interruption/);
  const readState = () => fs.readFile(path.join(session, "state.json"), "utf8").then(JSON.parse);
  const saved = await readState();
  assert.ok(saved.meta.contextBudget.compactions > 0, "Seed failed to persist a compacted transcript");
  assert.ok(saved.meta.goalContract.taskGoal === goal && saved.meta.goalContract.activeGoal === goal);

  const respond = catalogueReader();
  const ids = ["folio_116", "folio_245", "folio_381"];
  const observed = new Set();
  let turns = 0;
  const resume = handler => runCatalogueCli(root, ["--resume", sid], continuations[0], handler);
  const finished = await resume(body => {
    assert.ok(++turns <= 6, "Unexpected extra provider turn");
    const wire = JSON.stringify(body);
    // These interior rows are distant from all three authorized windows. They also catch a
    // goal embedded in escaped snapshot JSON, including after the unrelated file read.
    assert.ok(!wire.includes("Folio 290.") && !wire.includes("Folio 414."),
      `Unrequested interior folios appeared on resumed provider turn ${turns}`);
    for (const [i, value] of values.entries()) {
      if (observed.has(i)) continue;
      const reply = body.messages.find(m => m.role === "tool" && m.tool_call_id === ids[i]);
      const otherFields = {...body, messages: body.messages.filter(m => m !== reply)};
      assert.ok(!JSON.stringify(otherFields).includes(value), "Held-out wording visible before its native reply");
      if (reply) {
        const {excerpt} = JSON.parse(reply.content);
        assert.equal(typeof excerpt, "string");
        assert.ok(excerpt.includes(value), "Expected exact wording inside its requested window");
        observed.add(i);
      }
    }
    return respond(body);
  });
  assert.equal(finished.code, 0, finished.data.reason);
  assert.equal(finished.data.result, [layout, ...values].join("\n"));
  assert.equal(observed.size, 3);
  const state = await readState();
  assert.ok(state.meta.goalContract.taskGoal === goal && state.meta.goalContract.activeGoal === goal);
  assert.equal(state.meta.goalContract.taskRelation, "same-task");
  assert.equal(state.meta.goalContract.status, "completed");
  async function completedReads() {
    const lines = await fs.readFile(path.join(session, "events.jsonl"), "utf8");
    return lines.trim().split("\n").map(JSON.parse)
      .filter(e => e.type === "tool.completed" && ["read_file", "read_current_task"].includes(e.data.toolName))
      .map(e => e.data.toolName);
  }
  const evidence = ["read_file", ...Array(3).fill("read_current_task")];
  assert.deepEqual(await completedReads(), evidence);
  const replay = await resume(() => assert.fail("Completed catalogue replay invoked the provider"));
  assert.equal(replay.code, 0, replay.data.reason);
  assert.equal(replay.data.ok, true);
  assert.deepEqual(await completedReads(), evidence, "Completed continuation repeated reads");
});
