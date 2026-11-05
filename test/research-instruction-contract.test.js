import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveScsTaskContract } from "../src/scs-evidence.js";
import { hasLocalResearchWorkspaceIntent, shouldStartWithDeepResearch } from "../src/research-routing.js";
import { resolveRuntimeConfig } from "../src/config.js";
import { runAgent } from "../src/agent-runner.js";
import { flushHousekeeping } from "../src/housekeeping.js";
import { researchScopeApproval } from "./fixtures/research-scope-review.js";

const goal = "Please do a quick deep research note on Python's loop else. I keep mixing it up: does it always run, or does break skip it? Check the official tutorial, keep the conditions clear, and include an exact quote. Don't create or change workspace files.";
const commandRequired = text => deriveScsTaskContract({ goal: text }).requiredEvidence.some(item => item.category === "command");

test("language names and explanatory run questions do not request command execution", () => {
  for (const prompt of [
    goal,
    "Explain Python loop else from its documentation. When does it run?",
    "Research Node event loops using the official documentation. Does the callback run immediately?",
    "Explain how to run pytest; do not execute anything.",
    "请解释Python循环的else什么时候运行，阅读官方文档，不要执行代码。",
    "Pythonのelseはいつ実行されるか説明してください。コードを実行しないでください。",
  ]) assert.equal(commandRequired(prompt), false, prompt);
});

test("real execution, mixed explanation/action and exact verifier requests retain command evidence", () => {
  for (const prompt of [
    "Run Python and report its version.",
    "Explain Python loop else, then run an example to verify it.",
    "Research the docs and execute `node --version`.",
    "Explain how the tests work; run `npm test` and report the result.",
    "Could you run pytest without changing files?",
    "Use Python to calculate the supplied measurements and explain the result.",
    "Explain the script and verify that it works.",
    "Research the Python crash and try to reproduce it.",
    "Explain the Python benchmark, then measure it on the supplied data.",
    "解释循环else，然后运行示例验证。",
    "説明してから実際に実行してください。",
  ]) assert.equal(commandRequired(prompt), true, prompt);
});

test("generic workspace preservation does not defer requested research; positive local grounding still does", () => {
  for (const prompt of [goal, "Do deep research using the original docs. Do not edit local files.", "Do deep research. Never write or modify project files."]) {
    assert.equal(hasLocalResearchWorkspaceIntent(prompt), false, prompt);
    assert.equal(shouldStartWithDeepResearch(prompt), true, prompt);
  }
  for (const prompt of [
    "Read current workspace files, then do deep research. Do not modify workspace files.",
    "Use notes/source.md for deep research. Don't create or change workspace files.",
    "Read the existing report.md, then research missing sources. Never edit local files.",
  ]) assert.equal(hasLocalResearchWorkspaceIntent(prompt), true, prompt);
  assert.equal(shouldStartWithDeepResearch("Do deep research, but never run deep_research."), false);
  const messages = [
    { role: "user", content: `Goal: ${goal}\nUser interface language: English.\nRuntime time context: synthetic.\nAGINTI.md is not present unless you create it.\nDo not modify workspace files.` },
    { role: "user", content: "Step 1/4 (3 steps remain after this one). Latest runtime snapshot:\nSource instructions: read source files first." },
  ];
  assert.equal(shouldStartWithDeepResearch(goal, messages), true);
});

test("verification of a simple structured-data artifact does not invent a shell obligation", () => {
  const request = "Create and verify output/data.json with one valid JSON object, then read it back.";
  for (const prompt of [request,
    `Host wrapper: validate code, run commands and perform research when needed.\nAGINTI_EVIDENCE_SCOPE_JSON: ${JSON.stringify({ mode: "task", request })}`,
  ]) {
    const contract = deriveScsTaskContract({ goal: prompt, taskProfile: "code" });
    assert.ok(contract.requiredEvidence.some(item => item.category === "file"));
    assert.ok(!contract.requiredEvidence.some(item => item.category === "command"));
  }
});

test("ordinary persisted research uses the native workflow without invented shell evidence", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aginti-research-instruction-"));
  const previous = process.env.AGINTIFLOW_HOME;
  process.env.AGINTIFLOW_HOME = path.join(root, "home");
  const fact = "A loop's else clause runs after normal exhaustion; break, return and a raised exception skip it.";
  let parentCalls = 0, specialistCalls = 0;
  let unexpectedNetwork = 0;
  t.mock.method(globalThis, "fetch", async () => { unexpectedNetwork++;throw new Error("Offline test forbids network"); });
  const completion = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
  try {
    const workspace = path.join(root, "workspace");await fs.mkdir(workspace);
    const clientFactory = async () => ({ chat: { completions: { create: async request => {
      parentCalls++;
      if (parentCalls === 1) assert.deepEqual(request.tools.map(tool => tool.function.name), ["deep_research", "finish"]);
      assert.ok(parentCalls <= 2, "explanatory research entered an execution-repair loop");
      const name = parentCalls === 1 ? "deep_research" : "finish";
      if (parentCalls === 2) assert.deepEqual(request.tools.map(tool => tool.function.name), ["finish"]);
      const args = parentCalls === 1 ? { query: goal, depth: "quick", maxQueries: 2, maxSources: 2, sourcePolicy: "primary", researchId: "instruction-contract" }
        : { result: `${fact} With no break the else always runs, even if the function returns. A journal confirmed this in 2026.` };
      return { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `instruction_${parentCalls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
    } } } });
    clientFactory.agintiDeterministicTest = true;
    const config = resolveRuntimeConfig({ goal, provider: "deepseek", model: "scripted-parent", routingMode: "manual", enableScs: "off" }, {
      baseDir: workspace, commandCwd: workspace, sessionId: "research-instruction", clientFactory, sandboxMode: "host",
      allowWebSearch: true, allowedDomains: ["docs.example.org"], allowFileTools: false, allowShellTool: false,
      allowMcpTools: false, allowParallelScouts: false, allowAuxiliaryTools: false, allowWrapperTools: false,
    });
    Object.assign(config, { clientFactory, apiKey: "scripted-test-only", sessionsDir: path.join(root, "sessions"), projectSessionsDir: path.join(root, "pointers"),
      provider: "deepseek", routeModel: "scripted-flash", mainModel: "scripted-pro", scsActive: false, quiet: true, maxSteps: 3, useDockerSandbox: false,
      executionPolicy: { tier: "focused", requiresPlan: false, reason: "Offline explanatory research regression." },
      jsonClientFactory: () => ({ chat: { completions: { create: async request => {
        specialistCalls++;
        const input = JSON.parse(request.messages[1].content);
        const approval = researchScopeApproval(input);if (approval) return completion(approval);
        if (/research plan/i.test(input.task)) return completion({ objective: goal, sourcePolicy: "primary", subquestions: [{ id: "loop", question: "When does loop else run?", query: "loop else documentation" }, { id: "optional", question: "What additional implementation evidence exists?", query: "implementation evidence" }], queries: ["loop else documentation"], sourceTypes: ["official documentation"], exclusions: [] });
        if (/Extract only source-grounded/i.test(input.task)) return completion({ sourceId: "S1", relevant: true, summary: fact, relevantQuestionIds: ["loop"], claims: [{ claim: fact, quote: fact, confidence: "high" }], limitations: [] });
        if (/Synthesize a source-grounded/i.test(input.task)) return completion({ title: "Loop else conditions", executiveSummary: fact, executiveSummaryEvidenceIds: ["S1-C1"], sections: [{ heading: "Conditions", paragraphs: [{ text: fact, evidenceIds: ["S1-C1"] }] }], keyFindings: [{ claim: fact, evidenceIds: ["S1-C1"], confidence: "high" }], recommendations: [], contradictions: [], uncertainties: [{ text: fact, evidenceIds: ["S1-C1"] }], nextQuestions: [] });
        throw new Error("Unexpected research stage");
      } } } }),
      webSearchImpl: async () => ({ ok: true, provider: "fixture", results: [{ rank: 1, title: "Official loop documentation", url: "https://docs.example.org/loops", canonicalUrl: "https://docs.example.org/loops", domain: "docs.example.org", snippet: fact }] }),
      webPageReaderImpl: async ({ url }) => ({ ok: true, readable: true, url, content: fact, passages: [fact], title: "Official loop documentation", sha256: "a".repeat(64), retrievedAt: "2026-11-05T00:00:00Z", contentType: "text/plain", truncated: false }),
    });
    const result = await runAgent(config);
    assert.notEqual(result.stopped, true, result.reason);assert.notEqual(result.failed, true);
    assert.ok(result.result.startsWith(fact));
    assert.ok(!result.result.includes("With no break the else always runs"));
    assert.ok(!result.result.includes("journal confirmed"));
    assert.ok(result.result.includes("Coverage limitation: 1 planned research question remains outside this assessed answer."));
    assert.equal(parentCalls, 2);assert.equal(specialistCalls, 4);
    const session = path.join(root, "sessions/research-instruction");
    const events = (await fs.readFile(path.join(session, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.some(event => event.type === "tool.completed" && event.data?.toolName === "deep_research" && event.data.ok === true));
    assert.ok(events.find(event => event.type === "tool.completed" && event.data?.toolName === "deep_research").data.answer.includes(`“${fact}” [S1]`));
    assert.ok(!events.some(event => event.type === "tool.started" && event.data?.toolName === "run_command"));
    assert.ok(events.some(event => event.type === "completion.native_research_answer_selected" && event.data?.parentCandidateUsed === false));
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.equal(unexpectedNetwork, 0);
  } finally {
    await flushHousekeeping();
    if (previous === undefined) delete process.env.AGINTIFLOW_HOME;else process.env.AGINTIFLOW_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
