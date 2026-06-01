# AgInTiFlow Intent Routing Overpatch Audit

Date: 2026-06-01

## Problem

A bare user message, `hello`, was handled as an execution task. In the observed run, AgInTiFlow planned to inspect the workspace, created `hello.py`, and then stopped without a natural chat answer. That is the wrong default behavior for a general agent UI: a greeting should be answered directly, not converted into a workspace mutation.

## Evidence

Observed session:

- Session: `/home/lachlan/.agintiflow/sessions/web-agent-f798c7cc-b3c2-439f-b2be-2a2746b4944d/state.json`
- Provider/model: `deepseek/deepseek-v4-flash`
- Goal: `hello`
- Task profile: `auto`
- Selected skills: `[]`
- Outcome shown by user: AgInTiFlow wrote `hello.py` with `print("Hello from agent!")`

The selected skills list was empty, so this was not caused by a custom skill. The behavior came from the core runtime prompt and the lack of a direct-answer lane.

## Root Cause

The runtime had one dominant path:

1. Create a plan.
2. Continue with tools until completion.
3. Prefer real workspace edits/checks over advice-only answers.

The strongest prompt pressure was in:

- `src/agent-runner.js`: system prompt said the plan is not final and the agent should actively use tools until complete.
- `src/model-client.js`: planner prompt said to prefer real workspace edits/checks over advice-only answers.
- `src/task-profiles.js`: the `auto` profile told the agent to infer task type and choose a tool mix, but did not define a no-tool conversational mode.

That design is useful for real tasks, but over-applies tool use to short social turns.

## Design Fix

Add a deterministic pre-plan goal-intent classifier:

- Greetings, thanks, and explicit greeting requests finish directly.
- Explicit create/edit/run/read/search/download/build/test/coding/file/command requests remain agentic.
- File paths, file extensions, and command-looking inputs remain agentic.
- The direct path runs before planning, SCS, surgical context, snapshots, browser, shell, canvas, or file tools.

This keeps the fix general. It does not special-case `hello.py`, mock mode, DeepSeek, or a single UI path.

The prompts were also softened:

- Tool use is required only when the user actually asks for workspace/browser/shell/web/canvas/image/MCP/specialist work.
- Greetings and simple conversational turns should finish directly.
- Canvas should not be used for ordinary chat replies.

## Regression Contract

Required behavior:

- `hello` returns a direct greeting.
- `hello` does not create a plan.
- `hello` does not call tools.
- `hello` does not create `hello.py`.
- `create hello.py` still requires tools.
- `write a hello-world Python script and run it` still requires tools.

## Product Lesson

AgInTiFlow should solve problems at the correct layer:

- Core system flaw: no conversational/direct-answer lane. Fix in runtime intent routing.
- Core general skill incompleteness: missing reusable task classifier. Add deterministic classifier and tests.
- Custom skill issue: not applicable here because no skill was selected.

Avoid overpatching by not making every short input a file task and not routing every interaction through heavyweight planning/SCS/tool execution.
