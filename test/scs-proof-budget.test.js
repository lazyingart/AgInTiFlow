import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const runtime = process.env.AGINTI_TEST_BASELINE_RUNTIME || fileURLToPath(new URL("../", import.meta.url));
const { buildScsEvidencePack, reviewScsFinish } = await import(pathToFileURL(path.join(runtime, "src/scs-controller.js")));
const { deriveScsTaskContract } = await import(pathToFileURL(path.join(runtime, "src/scs-evidence.js")));
function fixture(text = "verified current value 107.083333") {
  const goal = "Run `python3 check.py` and report the observed result.";
  const result = { toolName: "run_command", ok: true, exitCode: 0, args: { command: "python3 check.py" }, stdout: text, stderr: "", goalRevision: 1 };
  const state = { goal, plan: "Read source and execute the reviewed check. ".repeat(1000), messages: [
    { role: "assistant", tool_calls: [{ id: "current_check", type: "function", function: { name: "run_command", arguments: JSON.stringify(result.args) } }] },
    { role: "tool", tool_call_id: "current_check", content: JSON.stringify(result) },
  ], meta: { goalContract: { revision: 1, activeGoalRevision: 1, taskBoundaryRevision: 1, taskGoal: goal, activeGoal: goal }, scs: { enabled: true, active: true, plan: "Earlier planning context. ".repeat(1000), acceptanceCriteria: ["Observe the real result."], lastStudentDecision: { reason: "Old planning judgment ".repeat(1000) } } } };
  const context = { goal, taskProfile: "auto", taskContract: deriveScsTaskContract({ goal }), events: [{ type: "tool.completed", data: result }] };
  return { state, context, result };
}
for (const text of ["verified current value 107.083333", "当前实测值107.083333", "現在の実測値107.083333", "Observed 🧪107.083333"]) {
  test(`bounded SCS pack retains valid JSON and current proof under large planning state: ${text}`, () => {
    const { state, context } = fixture(text);const wire = buildScsEvidencePack(state, context);
    assert.ok(Buffer.byteLength(wire, "utf8") <= 7000);assert.ok(wire.isWellFormed());
    const pack = JSON.parse(wire);assert.equal(pack.evaluation.ok, true);
    assert.ok(pack.evidenceLedger.categories.includes("command"));
    assert.ok(wire.includes(text), "planning context displaced the actual check output");
    assert.ok(wire.includes("python3 check.py"));
    assert.ok(!wire.includes("Old planning judgment ".repeat(20)));
  });
}
test("negative command outcome remains visible with a large plan", () => {
  const { state, context, result } = fixture("CURRENT_CHECK_FAILED");
  result.ok = false;result.exitCode = 1;state.messages[1].content = JSON.stringify(result);
  const pack = JSON.parse(buildScsEvidencePack(state, context));
  assert.equal(pack.evaluation.ok, false);assert.ok(pack.evaluation.missing.includes("command"));
  assert.ok(JSON.stringify(pack).includes("CURRENT_CHECK_FAILED"));
});
test("review receives the bounded proof and preserves its independent decision", async () => {
  const { state, context } = fixture();let calls = 0, inspected = false;
  const client = { chat: { completions: { async create(body) {
    calls++;const wire = body.messages.at(-1).content.split("Evidence pack:\n").at(-1);
    const pack = JSON.parse(wire);assert.equal(pack.evaluation.ok, true);
    assert.ok(wire.includes("verified current value 107.083333"));
    inspected = true;
    return { choices: [{ message: { content: JSON.stringify({ role: "student", decision: "finish_allowed", confidence: 0.95, evidence: ["Observed current stdout"], reason: "Current check is verified.", next_required_action: "finish" }) } }] };
  } } } };
  const decision = await reviewScsFinish(client, { provider: "deepseek", scsValidationMode: "model" }, state, "The current check passed.", context);
  assert.equal(calls, 1);assert.equal(inspected, true, "fallback cannot masquerade as a successful independent review");assert.equal(decision.decision, "finish_allowed");
});
test("model approval cannot override absent execution evidence", async () => {
  const { state, context } = fixture();state.messages = [];context.events = [];
  const client = { chat: { completions: { async create() { return { choices: [{ message: { content: JSON.stringify({ role: "student", decision: "finish_allowed", confidence: 0.99, evidence: [], reason: "Looks done.", next_required_action: "finish" }) } }] }; } } } };
  const decision = await reviewScsFinish(client, { provider: "deepseek", scsValidationMode: "model" }, state, "The current check passed.", context);
  assert.equal(decision.decision, "finish_rejected");
});

test("a prior task command is never relabelled as a current command proof", () => {
  const { state, context } = fixture();Object.assign(state.meta.goalContract, { revision: 2, activeGoalRevision: 2, taskBoundaryRevision: 2 });
  const pack = JSON.parse(buildScsEvidencePack(state, context));assert.deepEqual(pack.commandProofs, []);
});
test("the newest failed check stays visible beside earlier success", () => {
  const { state, context, result } = fixture();context.events.push({ type: "tool.failed", data: { ...result, ok: false, exitCode: 1, stdout: "NEWEST_CHECK_FAILED" } });
  const pack = JSON.parse(buildScsEvidencePack(state, context));assert.equal(pack.commandProofs[0].ok, false);assert.equal(pack.commandProofs[0].exitCode, 1);
  assert.ok(JSON.stringify(pack).includes("NEWEST_CHECK_FAILED"));assert.equal(pack.commandProofs[1].ok, true);
});
test("sensitive tool values remain redacted in prioritized proof", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const { state, context } = fixture(`Observed current value; credential example ${secret}`);
  const wire = buildScsEvidencePack(state, context);assert.ok(!wire.includes(secret));assert.ok(wire.includes("[REDACTED]"));
});
test("known output identity and a missing category survive bulky context", () => {
  const { state, context } = fixture();state.messages = [];context.events = [];
  context.taskContract.exactOutputPaths = ["result.md"];
  const pack = JSON.parse(buildScsEvidencePack(state, context));assert.deepEqual(pack.contract.exactOutputPaths, ["result.md"]);
  assert.equal(pack.evaluation.ok, false);assert.ok(pack.evaluation.missing.includes("command"));
});
test("browser URL and title proof cannot be displaced by a large plan", () => {
  const { state, context } = fixture();context.events.push({ type: "tool.completed", data: { toolName: "open", ok: true, url: "https://example.org/source", title: "CURRENT_SOURCE_TITLE", goalRevision: 1 } });
  const wire = buildScsEvidencePack(state, context);assert.ok(wire.includes("https://example.org/source"));assert.ok(wire.includes("CURRENT_SOURCE_TITLE"));
});
test("simultaneously full sections stay within the same total byte cap", () => {
  const { state, context } = fixture("CURRENT_BOUND_CHECK " + "実測🧪".repeat(500));
  context.taskContract.exactOutputPaths = Array.from({ length: 16 }, (_, i) => `${"資料".repeat(60)}-${i}.md`);
  context.taskContract.requiredTextTerms = Array.from({ length: 24 }, (_, i) => `term-${i}-${"あ".repeat(100)}`);
  for (let i = 0; i < 30; i++) state.messages.push({ role: "user", content: "Old context ".repeat(1000) });
  const wire = buildScsEvidencePack(state, context), pack = JSON.parse(wire);
  assert.ok(Buffer.byteLength(wire) <= 7000);assert.ok(wire.isWellFormed());assert.equal(pack.evaluation.ok, true);
  assert.ok(wire.includes("CURRENT_BOUND_CHECK"));assert.ok(pack.budget.boundedSections.length > 0);
});

test("persisted native SCS finishes a verified producer once without an evidence-loss replan", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-native-scs-proof-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");await fs.mkdir(workspace);
  const input = "value\n1\n3\n5\n";await fs.writeFile(path.join(workspace, "input.csv"), input);
  await fs.writeFile(path.join(workspace, "README.md"), "The source contains three numerical observations. Missing values are not zero.\n");
  const analysisSource = [
    "import csv, statistics", "from pathlib import Path", "values=[float(r['value']) for r in csv.DictReader(Path('input.csv').open())]",
    "mean=statistics.mean(values)", "Path('comparison.csv').write_text('count,mean\\n%d,%g\\n' % (len(values), mean))",
    "Path('report.md').write_text('# Observed result\\n\\nMean: %g.\\n' % mean)",
    "with Path('.producer-count').open('a') as f: f.write('1\\n')", "print('CURRENT_SCOPED_PROOF mean=%g' % mean)", "",
  ].join("\n");
  let turn = 0, finishReviews = 0, verifiedReviews = 0;const errors = [];
  const call = (name, args) => ({ id: `scs_proof_${++turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let supervisor = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];for await (const chunk of req) chunks.push(chunk);const body = JSON.parse(Buffer.concat(chunks));
      const system = body.messages.find(message => message.role === "system")?.content || "";let message;
      if (system.startsWith("You are the SCS committee planner.")) {
        message = { content: JSON.stringify({ role: "committee", phase_goal: "Verify the current producer and requested artifacts.",
          plan: "1. Inspect the workspace, README.md and input.csv.\n2. Write analyze.py and run `python3 analyze.py` once.\n3. Save comparison.csv and report.md; keep input.csv unchanged.\n4. Read both outputs and finish with observed evidence.",
          acceptance_criteria: ["input.csv is unchanged; comparison.csv and report.md contain the verified result.", ...Array.from({ length: 8 }, (_, i) => `Criterion${i}: concrete Python and artifact evidence. `.repeat(5))], allowed_tools: ["inspect_project", "read_file", "run_command", "finish"], stop_conditions: ["Stop on a real permission blocker."] }) };
      } else if (system.startsWith("You are the independent SCS student validator.")) {
        message = { content: JSON.stringify({ role: "student", decision: "approve_plan", confidence: 0.95, evidence: ["Exact scope preserved."], reason: "Plan preserves input.csv, comparison.csv and report.md.", next_required_action: "execute" }) };
      } else if (system.startsWith("You are the SCS student final gate.")) {
        finishReviews++;const wire = body.messages.at(-1).content.split("Evidence pack:\n").at(-1);let verified = false;
        try { const pack = JSON.parse(wire);verified = pack.evaluation.ok === true && wire.includes("CURRENT_SCOPED_PROOF mean=3") && pack.contract.exactOutputPaths.includes("comparison.csv") && pack.contract.exactOutputPaths.includes("report.md"); } catch {}
        if (verified) verifiedReviews++;
        message = { content: JSON.stringify({ role: "student", decision: verified ? "finish_allowed" : "finish_rejected", confidence: 0.95, evidence: verified ? ["Current command stdout and exact artifact contract."] : [], reason: verified ? "Current proof verifies the result." : "The review input is truncated and cannot be verified.", next_required_action: verified ? "finish" : "show current proof" }) };
      } else if (system.startsWith("You are the SCS student")) {
        message = { content: JSON.stringify({ role: "student", decision: "accept_phase", confidence: 0.95, evidence: ["Observed progress"], reason: "Continue scoped verification.", next_required_action: "continue" }) };
      } else if (body.tools) {
        const actions = [
          ["inspect_project", { path: ".", includeFiles: true }], ["read_file", { path: "README.md" }],
          ["read_file", { path: "input.csv" }], ["write_file", { path: "analyze.py", content: analysisSource, mode: "create" }],
          ["run_command", { command: "python3 analyze.py" }], ["read_file", { path: "comparison.csv" }], ["read_file", { path: "report.md" }],
        ];
        const offered = body.tools.map(tool => tool.function.name);
        const finish = ["finish", { result: "comparison.csv and report.md are verified. Current observed mean is 3; input.csv is unchanged." }];
        const action = offered.length === 1 && offered[0] === "finish" ? finish : actions[supervisor++] || finish;
        assert.ok(offered.includes(action[0]), `Offline supervisor requested unavailable ${action[0]}`);
        message = { tool_calls: [call(...action)] };
      } else throw new Error("Unexpected offline SCS request");
      res.writeHead(200, { "content-type": "application/json" });res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: null, ...message } }] }));
    } catch (error) { errors.push(error.message);res.writeHead(400);res.end('{"error":{"message":"Offline SCS fixture refused request"}}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));t.after(() => { server.closeAllConnections();return new Promise(resolve => server.close(resolve)); });
  const fixturePath = fileURLToPath(new URL("./fixtures/native-scs-proof.js", import.meta.url));
  const child = spawn(process.execPath, [fixturePath, root, `http://127.0.0.1:${server.address().port}/v1`], { env: { PATH: process.env.PATH, HOME: root + "/home", AGINTIFLOW_HOME: root + "/home", LANG: "C.UTF-8", AGINTIFLOW_HOUSEKEEPING: "0", AGINTIFLOW_NO_AUTO_UPDATE: "1", AGINTIFLOW_NO_WEB_AUTO_START: "1", ...(process.env.AGINTI_TEST_BASELINE_RUNTIME ? { AGINTI_TEST_BASELINE_RUNTIME: runtime } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";child.stdout.on("data", chunk => { stdout += chunk; });child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject);child.once("close", resolve); });
  assert.equal(code, 0, stderr + stdout);assert.deepEqual(errors, []);
  const nativeResult = JSON.parse(stdout.trim().split("\n").at(-1));
  const savedEvents = (await fs.readFile(path.join(root, "sessions/native-scs-proof/events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.notEqual(nativeResult.stopped, true, JSON.stringify({ nativeResult, decisions: savedEvents.filter(event => /blocked|failed|rejected|stopped/.test(event.type)).map(event => ({ type: event.type, data: event.data })) }));
  assert.equal(nativeResult.goalStatus, "completed");
  assert.equal(await fs.readFile(path.join(workspace, ".producer-count"), "utf8"), "1\n");
  assert.equal(await fs.readFile(path.join(workspace, "input.csv"), "utf8"), input);
  assert.equal(finishReviews, 1);assert.equal(verifiedReviews, 1);
  const events = savedEvents;
  assert.equal(events.filter(event => event.type === "scs.student.finish_rejected").length, 0);
  assert.equal(events.filter(event => event.type === "session.finished").length, 1);
});
