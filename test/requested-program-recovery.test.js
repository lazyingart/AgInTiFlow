import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runAgent } from "../src/agent-runner.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { closeSessionIndexConnections } from "../src/session-index.js";
import { requestedWorkspaceProgramRecovery } from "../src/permission-advice.js";

const goal = "Read readings.csv, write summary.json with the row IDs, and include a small Python checker I can rerun. Leave the CSV alone; no installs.";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blocked = "python3 --version && python3 -c \"import pathlib; pathlib.Path('forbidden.txt').write_text('never execute')\"";

test("recovery is advice only for an explicit program request with unchanged authority", () => {
  const input = { toolName: "run_command", args: { command: blocked }, guard: { allowed: false, category: "general-shell" },
    config: { goal, allowFileTools: true, allowShellTool: true, allowDestructive: false, sandboxMode: "host" },
    state: { meta: { goalContract: { revision: 1, taskGoal: goal } } } };
  assert.equal(requestedWorkspaceProgramRecovery(input)?.autoRecover, true);
  for (const taskGoal of ["Explain this CSV.", "Run the existing Python checker.", "Do not create a script. Write summary.json.",
    "Create a short report without making a Python script.", "Create a summary, not a Python script.",
    "Do not build a script. Write a report.", "Create a report; do not provide a checker.",
    "Make a report instead of a new script.", "Create a report, I don't want a Python program.",
    "Include a small Python checker, but don’t create any files.",
    "Include a small Python checker, but dont create any files.",
    "Include a small Python checker, but do not create any new files.",
    "Include a small Python checker, but do not create or modify any files.",
    "Include a small Python checker, but no tools.",
    "Include a small Python checker in your answer.",
    "Never write any files; include a checker example in your answer."]) {
    assert.equal(requestedWorkspaceProgramRecovery({ ...input, state: { meta: { goalContract: { revision: 1, taskGoal } } } }), null, taskGoal);
  }
  for (const taskGoal of [goal, "Without installing packages, create a small Python checker I can rerun.",
    "Without installing packages create a small Python checker I can rerun."]) {
    assert.equal(requestedWorkspaceProgramRecovery({ ...input, state: { meta: { goalContract: { revision: 1, taskGoal } } } })?.autoRecover, true, taskGoal);
  }
  for (const delta of [{ allowFileTools: false }, { allowShellTool: false }, { sandboxMode: "docker-readonly" }, { allowDestructive: true }])
    assert.equal(requestedWorkspaceProgramRecovery({ ...input, config: { ...input.config, ...delta } }), null);
  assert.equal(requestedWorkspaceProgramRecovery({ ...input, guard: { category: "destructive" } }), null);
  assert.equal(requestedWorkspaceProgramRecovery({ ...input, args: { command: "npm install another-package" } }), null);
  assert.equal(requestedWorkspaceProgramRecovery({ ...input, state: { meta: { goalContract: { revision: 1, taskGoal: goal }, requestedProgramPolicyRecovery: { goalRevision: 1 } } } }), null);
  assert.equal(requestedWorkspaceProgramRecovery({ ...input, state: {} }), null);
});

for (const repeatDenied of [false, true]) test(`requested program keeps existing authority; repeated refusal=${repeatDenied}`, { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-requested-program-"));
  const oldHome = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  t.mock.method(globalThis, "fetch", async () => { throw Error("Offline program recovery must not use the network"); });
  t.after(async () => {
    closeSessionIndexConnections();
    if (oldHome === undefined) delete process.env.AGINTIFLOW_HOME; else process.env.AGINTIFLOW_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const csv = "id,value\na,2\nb,3\n";
  await fs.writeFile(path.join(workspace, "readings.csv"), csv);
  const program = "import csv, hashlib, json\nfrom pathlib import Path\np = Path(__file__).resolve().parent\nsrc = p / 'readings.csv'\nbefore = hashlib.sha256(src.read_bytes()).digest()\nrows = list(csv.DictReader(src.open()))\n(p / 'summary.json').write_text(json.dumps([r['id'] for r in rows]))\nassert hashlib.sha256(src.read_bytes()).digest() == before\nprint('PASS: current rows verified; input unchanged')\n";
  let step = 0, resumed = false, resumeStep = 0;
  const turn = (name, args) => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: `program_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  const clientFactory = async () => ({ chat: { completions: { create: async (request) => {
    if (resumed) {
      resumeStep++;
      if (resumeStep === 1) return turn("read_file", { path: "readings.csv" });
      if (resumeStep === 2) return turn("run_command", { command: "python3 check_readings.py" });
      assert.equal(resumeStep, 3);
      return turn("finish", { result: "Refreshed summary.json with current IDs a, b and c. The unchanged checker passed; source data was left alone." });
    }
    step++;
    if (step === 1) return turn("read_file", { path: "readings.csv" });
    if (step === 2) return turn("run_command", { command: blocked });
    if (step === 3) {
      assert.ok(JSON.stringify(request.messages).includes("NOT executed"));
      if (repeatDenied) return turn("run_command", { command: blocked });
      return turn("write_file", { path: "check_readings.py", content: program });
    }
    if (step === 4) return turn("run_command", { command: "python3 check_readings.py" });
    assert.equal(step, 5, "recovery inflated the tool loop");
    return turn("finish", { result: "Created summary.json with IDs a and b and the rerunnable Python checker. The checker passed; readings.csv was unchanged. No installs." });
  } } } });
  clientFactory.agintiDeterministicTest = true;
  const config = resolveRuntimeConfig({ goal, provider: "openai", model: "offline-requested-program", routingMode: "manual", enableScs: "off" }, {
    packageDir, baseDir: workspace, commandCwd: workspace, sessionId: "requested-program", clientFactory,
    allowFileTools: true, allowShellTool: true, allowDestructive: false, sandboxMode: "host", packageInstallPolicy: "block",
    allowWebSearch: false, allowWrapperTools: false, allowMcpTools: false, allowAuxiliaryTools: false, allowParallelScouts: false,
  });
  Object.assign(config, { clientFactory, apiKey: "offline-not-a-credential", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
    useDockerSandbox: false, maxSteps: 6, dynamicSteps: "off", quiet: true, executionPolicy: { tier: "focused", requiresPlan: false } });
  const result = await runAgent(config);
  assert.equal(step, repeatDenied ? 3 : 5);
  if (repeatDenied) { assert.equal(result.stopped, true); assert.equal(result.reason, "permission_required"); }
  else { assert.notEqual(result.stopped, true); assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, "summary.json"))), ["a", "b"]); }
  assert.equal(await fs.readFile(path.join(workspace, "readings.csv"), "utf8"), csv);
  await assert.rejects(fs.stat(path.join(workspace, "forbidden.txt")), { code: "ENOENT" });
  const state = JSON.parse(await fs.readFile(path.join(root, "sessions/requested-program/state.json")));
  assert.equal(state.meta.runtimeConfig.allowDestructive, false); assert.equal(state.meta.runtimeConfig.packageInstallPolicy, "block");
  const events = (await fs.readFile(path.join(root, "sessions/requested-program/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.type === "tool.blocked" && e.data.permissionAdvice?.category === "requested-workspace-program").length, 1);
  assert.ok(!events.some(e => e.type === "tool.started" && e.data.args?.command === blocked));
  if (!repeatDenied) {
    const refreshed = csv + "c,4\n"; await fs.writeFile(path.join(workspace, "readings.csv"), refreshed);
    resumed = true;
    const continuation = await runAgent({ ...config, resume: "requested-program",
      goal: "I corrected readings.csv. Please refresh the same summary and rerun the checker. Leave the CSV alone." });
    assert.notEqual(continuation.stopped, true); assert.equal(resumeStep, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, "summary.json"))), ["a", "b", "c"]);
    assert.equal(await fs.readFile(path.join(workspace, "check_readings.py"), "utf8"), program);
    assert.equal(await fs.readFile(path.join(workspace, "readings.csv"), "utf8"), refreshed);
  }
});
