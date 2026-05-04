# AAPS And AgInTiFlow Integration Design

This note researches how AgInTiFlow should connect with AAPS and proposes a lightweight `/aaps` feature that can grow into a full large-project workflow harness.

Local sources inspected:

- `/home/lachlan/ProjectsLFS/AAPS/package.json`
- `/home/lachlan/ProjectsLFS/AAPS/README.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/design-philosophy.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/language-spec.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/compiler.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/runtime.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/project-management.md`
- `/home/lachlan/ProjectsLFS/AAPS/docs/codex-wrapper.md`
- `/home/lachlan/ProjectsLFS/AAPS/scripts/aaps.js`
- `/home/lachlan/ProjectsLFS/AAPS/scripts/aaps-runner.js`
- `/home/lachlan/ProjectsLFS/AAPS/scripts/aaps-compiler.js`
- `/home/lachlan/ProjectsLFS/AAPS/examples/*.aaps`
- `/home/lachlan/ProjectsLFS/AAPS/examples/projects/app-development/aaps.project.json`
- AgInTiFlow runtime, CLI, web, task profiles, skill library, session store, canvas/artifact tunnel, SCS mode, and wrapper architecture.

## Short Answer

Yes, AAPS can lift AgInTiFlow to the next level, but the integration should be deliberately thin at first.

Recommended principle:

> AAPS is the declarative large-workflow control plane. AgInTiFlow is the interactive agent runtime and tool-use backend.

Do not merge the projects or copy the AAPS parser into AgInTiFlow. Use the published `@lazyingart/aaps` package as an optional dependency discovered at runtime, then wrap it with a stable AgInTiFlow adapter.

The first useful feature should be:

```text
/aaps
/aaps status
/aaps init
/aaps parse|validate|compile|check|run
/aaps open
/aaps studio
/aaps install
```

Later:

```text
/aaps on
/aaps auto
/aaps off
```

Those mode commands should not mean "turn AgInTi into AAPS." They should mean "when a task is large, ask AgInTi to express the work as AAPS blocks, compile/check it, and then execute or supervise the blocks."

## Current AAPS Shape

AAPS means Autonomous Agentic Pipeline Script. The current local package is `@lazyingart/aaps` and exposes the `aaps` CLI.

Important properties:

- It is CommonJS, Node >=18.
- It has a deterministic parser in `src/aaps.js`.
- It has a CLI front door in `scripts/aaps.js`.
- It has an agent-aware compiler in `scripts/aaps-compiler.js`.
- It has an executable runtime in `scripts/aaps-runner.js`.
- It has a Studio PWA and Python backend in `studio/` and `backend/`.
- It has schemas for chat/edit/project/response payloads.
- It already supports project manifests through `aaps.project.json`.
- It already has example workflows for app development, book writing, generic workflows, runtime demos, and organoid segmentation.

AAPS pipeline:

```text
.aaps
-> deterministic parser
-> unresolved IR
-> compiler
-> resolved IR
-> execution plan
-> readiness check
-> runtime actions
-> validation/recovery/report
```

The useful design boundary is strict:

- Parse does not invent missing code.
- Compile can detect missing blocks/scripts/tools/agents/packages and optionally generate safe project-local assets.
- Run executes deterministic local actions and records prompt/model-only work as prompts/checkpoints unless an adapter exists.
- Every run writes durable JSON, JSONL, reports, readiness, logs, and artifacts.

## Current AgInTiFlow Shape

AgInTiFlow already owns the runtime pieces AAPS wants from a backend agent:

- Role-based model routing: route/main/spare/wrapper/auxiliary.
- CLI and local web UI over the same session store.
- Central session storage under `~/.agintiflow/sessions/<session-id>`.
- Project session pointers under `.aginti-sessions/`.
- Workspace file tools with path guardrails.
- Docker workspace and command policy.
- Host tmux tools for long-running jobs.
- Browser, web search, canvas/artifact tunnel, and generated file previews.
- Task profiles and Markdown skills, including an existing `aaps` profile/skill.
- Optional SCS mode for plan approval, progress monitoring, and finish gates.
- Wrapper tools for external coding assistants.
- Structured `events.jsonl` for every model/tool/session event.

AgInTiFlow current execution loop:

```text
goal
-> resolve runtime config and model route
-> create/resume session
-> plan
-> optional scouts/SCS
-> model tool loop
-> guarded tools
-> events/artifacts/chat
-> finish/resume
```

This is complementary to AAPS. AAPS is better at declared workflow shape. AgInTiFlow is better at interactive environment-facing agent work.

## What AAPS Adds To AgInTiFlow

AAPS gives AgInTiFlow a better language for large tasks:

- Named workflows instead of transient chat plans.
- Reusable `skill`, `block`, `task`, `stage`, `action`, `guard`, `choose`, `if`, `else`, and `for_each` blocks.
- Typed inputs, outputs, artifacts, validations, requirements, agents, tools, and environment declarations.
- Readiness checks before side effects.
- Compile reports for missing scripts/tools/agents/packages.
- Project manifests for multi-file workflow libraries.
- A visual editor and graph-shaped mental model.
- Durable run/report folders independent of the chat transcript.

This solves a real weakness of ordinary agents: they make plans as prose, then the plan decays as execution gets messy. AAPS turns large-task plans into editable source.

## What AgInTiFlow Adds To AAPS

AgInTiFlow gives AAPS a stronger backend:

- Real browser/workspace/shell/canvas tooling.
- Better model-provider control, including DeepSeek/Venice/OpenAI/Qwen.
- Project-local API key onboarding.
- Docker workspace policy.
- tmux supervision.
- Session history and resumability.
- Web app workspace controls and artifact previews.
- SCS monitoring and finish gates.
- Skill Mesh and learned capability sharing later.

This solves a current AAPS limitation: AAPS can prepare prompts and run deterministic actions, but agent-assisted blocks currently depend on Codex wrapper or prompt files. AgInTiFlow can become a first-class AAPS agent adapter.

## Integration Options

### Option A: Shell Adapter To `aaps` CLI

AgInTiFlow discovers `aaps` on `PATH` or runs `npx -y @lazyingart/aaps`.

Pros:

- Minimal implementation.
- No dependency bloat in AgInTiFlow.
- Uses the actual published AAPS package.
- Easy to debug because commands are visible.
- Works with current AAPS immediately.

Cons:

- JSON parsing and error mapping must be careful.
- Version mismatch is possible.
- Shell command policy must explicitly allow safe AAPS commands.
- Web UI integration needs a wrapper API.

Verdict: best first step.

### Option B: Optional Dynamic Package Import

AgInTiFlow dynamically imports `@lazyingart/aaps` if installed.

Pros:

- Faster than spawning CLI.
- Cleaner API if AAPS exports parser/compiler functions.
- Easier web preview of IR.

Cons:

- AAPS is currently CommonJS and CLI-oriented.
- Compiler/runner are script-level, not stable library APIs.
- Pulls optional package complexity into AgInTiFlow.

Verdict: good later after AAPS exposes stable library exports.

### Option C: Vendored/Submodule Integration

AgInTiFlow vendors AAPS or uses the local sibling path.

Pros:

- Easy local development.
- Exact source is available.

Cons:

- Bad product boundary.
- Hard to maintain.
- Increases npm package size.
- Risks copying dirty local state.

Verdict: avoid for product runtime. Use only for local development references.

### Option D: AAPS Runtime Calls AgInTiFlow API

AAPS agent registry gets an `agintiflow` invocation that starts/resumes AgInTiFlow runs through API calls.

Pros:

- Correct long-term architecture.
- AAPS remains the declarative control plane.
- AgInTiFlow becomes the backend agent for specific blocks.
- AAPS Studio can display AgInTiFlow session and artifact links.

Cons:

- Requires stable AgInTiFlow run API and event streaming.
- Requires careful permission mapping.
- Requires cancellation/resume semantics.
- Needs a clear project/session identity bridge.

Verdict: best long-term bridge after the lightweight AgInTi-side adapter works.

## Recommended Architecture

Implement a new AgInTiFlow module:

```text
src/aaps-adapter.js
```

Responsibilities:

- Detect whether AAPS is available.
- Resolve the AAPS executable command:
  - `AAPS_BIN`
  - `node <local-sibling>/scripts/aaps.js` for development when allowed
  - `aaps` on PATH
  - `npx -y @lazyingart/aaps` only when install/network policy allows
- Run safe AAPS commands with project-relative paths.
- Parse JSON output and normalize errors.
- Summarize AAPS project status.
- Find `aaps.project.json`.
- Find active/default `.aaps` workflow.
- Return artifact paths and run/compile directories.
- Never read or print `.env` values.

Adapter surface:

```js
detectAaps({ cwd })
ensureAaps({ cwd, installPolicy })
initAapsProject({ cwd, name, domain, mode })
listAapsFiles({ cwd })
parseAaps({ cwd, file })
validateAaps({ cwd, file })
compileAaps({ cwd, file, mode })
checkAaps({ cwd, file })
runAaps({ cwd, file, dryRun, block })
openAapsStudio({ cwd, host, port, tmux })
summarizeAapsArtifacts({ cwd, report })
```

Use `run_command` policy only for the implementation, not raw LLM shell guessing. The model should request an explicit `aaps_*` tool once the adapter graduates from slash command to model tool.

## Slash Command Design

Interactive CLI:

```text
/aaps
/aaps status
/aaps install
/aaps init [name]
/aaps files
/aaps open [file]
/aaps parse [file]
/aaps validate [file]
/aaps compile [file] [check|suggest|apply]
/aaps check [file]
/aaps run [file]
/aaps dry-run [file]
/aaps studio
/aaps on
/aaps auto
/aaps off
```

Default `/aaps` behavior:

1. If no AAPS project exists, show a compact explainer plus options:
   - initialize project
   - create first workflow from current goal
   - install/find AAPS
2. If an AAPS project exists, show:
   - project name/domain
   - active file
   - available workflows
   - last compile/run status
   - suggested next commands

State fields:

```js
state.enableAaps = "off" | "on" | "auto"
state.aapsFile = ""
state.aapsProjectRoot = state.commandCwd
state.aapsCompileMode = "check" | "suggest" | "apply"
```

CLI flags:

```text
--aaps
--aaps auto
--no-aaps
--aaps-file workflows/main.aaps
```

## Web UI Design

Do not put AAPS into the left daily settings column at first. It is too large.

Add an **AAPS** panel/tab in the workspace area:

- Project status card.
- Active `.aaps` workflow selector.
- Source editor.
- Parse diagnostics.
- IR/graph preview.
- Compile/check/run buttons.
- Missing components list.
- Generated setup prompts and agent prompts.
- Run reports and artifacts.
- Button to send selected report/artifact to canvas.

Use existing Canvas & Artifacts for outputs rather than building a second preview system.

Suggested web layout:

```text
Left: normal AgInTi controls
Center: chat/session
Right/lower workspace tabs:
  Logs
  Workspace files
  Canvas
  AAPS
  Sandbox
```

AAPS editor should use the existing guarded file APIs at first. Later it can reuse AAPS Studio components or import AAPS parser directly in the browser.

## Model Behavior With AAPS Mode

When `/aaps on` or `/aaps auto` is enabled, the prompt should change:

- For large ambiguous tasks, first propose or update an AAPS workflow.
- Use `.aaps` as the durable high-level plan.
- Compile/check before running.
- Use AgInTiFlow tools to implement missing scripts/assets only when compile reports require them.
- Keep all generated assets project-local.
- Use SCS for risky large tasks automatically.
- Publish final report/artifacts through canvas.

Auto activation signals:

- User asks for "large project", "pipeline", "workflow", "autonomous", "repeatable", "batch", "analysis", "book", "paper", "app review", "multi-step".
- The task needs many phases or repeated loops.
- The task has clear inputs/outputs/artifacts.
- The task should be reused later.
- The project contains `aaps.project.json` or `.aaps` files.

Avoid AAPS mode for:

- one-off shell/file questions;
- tiny edits;
- normal code review;
- tasks where a short direct tool loop is cheaper and clearer.

## AAPS As Backend Agent Consumer

Long-term, AAPS should be able to declare an AgInTiFlow agent:

```json
{
  "name": "agintiflow_main",
  "invocation": "agintiflow",
  "provider": "deepseek",
  "modelRole": "main",
  "sandboxMode": "docker-workspace",
  "packageInstallPolicy": "allow",
  "tools": ["files", "shell", "browser", "canvas"]
}
```

AAPS `exec agent "agintiflow_main"` would call an AgInTiFlow service:

```text
POST /api/agent-runs
GET  /api/agent-runs/:id
GET  /api/agent-runs/:id/events
POST /api/agent-runs/:id/inbox
POST /api/agent-runs/:id/stop
```

The payload should include:

```json
{
  "projectRoot": "/path/to/aaps/project",
  "commandCwd": "/path/to/aaps/project",
  "goal": "Execute AAPS block qc_image with these inputs and outputs.",
  "aaps": {
    "project": "aaps.project.json",
    "workflow": "workflows/main.aaps",
    "block": "qc_image",
    "runId": "aaps-run-123",
    "contract": {
      "inputs": [],
      "outputs": [],
      "validations": [],
      "stopConditions": []
    }
  },
  "policy": {
    "sandboxMode": "docker-workspace",
    "packageInstallPolicy": "allow",
    "allowDestructive": false
  }
}
```

AgInTiFlow returns:

```json
{
  "sessionId": "web-agent-...",
  "status": "finished",
  "result": "...",
  "artifacts": [],
  "eventsPath": "~/.agintiflow/sessions/.../events.jsonl",
  "changedFiles": [],
  "checks": []
}
```

AAPS can then write those links into its run report.

## Mapping AAPS Contracts To AgInTiFlow

| AAPS concept | AgInTiFlow mapping |
| --- | --- |
| `pipeline` | session goal plus optional AAPS project metadata |
| `agent` | model role/provider plus tool permissions |
| `skill` / `block` | AgInTi skill prompt plus tool contract |
| `task` | one run phase or queued prompt |
| `stage` | SCS phase or log section |
| `action run/exec` | guarded shell/file/browser tool call |
| `validate` / `verify` | explicit checks before `finish` |
| `guard` | SCS student gate plus runtime policy |
| `recover` / `fallback` | retry/fallback prompt injected after failure |
| `artifact` / `output` | workspace file plus `send_to_canvas` |
| `events.jsonl` | AgInTiFlow session events plus AAPS run events |
| `run.json` | AgInTiFlow session pointer plus AAPS run summary |

## Safety Model

AAPS integration must not become a backdoor around AgInTiFlow policy.

Rules:

- AAPS commands run inside the current `commandCwd` or an explicitly chosen AAPS project root.
- All AAPS file arguments must be project-relative.
- No absolute paths, `..`, home paths, `.env`, `.git`, `node_modules`, or secret-like paths in generated commands.
- `aaps compile --mode apply` is a write action and should require normal workspace-write policy.
- `aaps run` may execute workflow commands; route it through existing shell/Docker policy.
- `aaps studio` should start in host tmux or a durable process, not a short Docker command.
- `npx -y @lazyingart/aaps` requires package/network install policy.
- `aaps install` should be explicit. Auto-install can offer a selector, not silently install.
- All AAPS run/compile artifacts should be captured as session artifacts or canvas links.
- Never share AAPS project files through Skill Mesh unless the user explicitly exports a sanitized skill pack.

## Storage Model

Keep AAPS project files in the project:

```text
aaps.project.json
workflows/
blocks/
skills/
scripts/
tools/
agents/
artifacts/
runs/
reports/
notes/
```

Keep AgInTi session metadata in AgInTi storage:

```text
~/.agintiflow/sessions/<session-id>/
.aginti-sessions/<session-id>/session.json
```

Bridge with pointers:

```json
{
  "sessionId": "web-agent-...",
  "aapsProjectRoot": "/path/project",
  "aapsWorkflow": "workflows/main.aaps",
  "aapsRunDir": "runs/20260504_run",
  "aapsCompileDir": "runs/20260504_compile"
}
```

Do not move AAPS run directories into `~/.agintiflow`. AAPS artifacts are part of the project workflow and should remain portable with the AAPS project.

## Installation Strategy

Preferred resolution order:

1. `AAPS_BIN` env var.
2. Local project dependency: `node_modules/.bin/aaps`.
3. Global `aaps` on PATH.
4. Development sibling path `/home/lachlan/ProjectsLFS/AAPS/scripts/aaps.js` only in source checkout/dev mode.
5. `npx -y @lazyingart/aaps` when package policy allows network/package setup.

First `/aaps install` behavior:

- Explain that AAPS is optional.
- Show detected status.
- Offer project-local dev dependency as the default for reproducibility.
- Global install only if user explicitly asks.

Possible commands:

```bash
npm install --save-dev @lazyingart/aaps
npm install -g @lazyingart/aaps
```

In AgInTiFlow’s own npm package, do not add `@lazyingart/aaps` as a hard dependency initially. Use optional discovery to keep the CLI light.

## How AAPS And SCS Should Work Together

SCS and AAPS solve different layers.

- AAPS: durable workflow specification and block contract.
- SCS: runtime gatekeeper for plan/phase/progress/finish.

Recommended combined behavior:

- `/aaps auto` implies SCS auto for large AAPS runs.
- SCS student should judge AAPS compile/readiness/run evidence before finish.
- AAPS `guard` and `validate` statements should be included in the SCS evidence pack.
- If AAPS readiness is blocked, SCS should reject finish unless the final answer honestly reports the blocker and points to the setup/repair prompts.

Do not use both AAPS and parallel scouts by default. AAPS is already a structured planning layer; if extra critique is needed, use SCS or a review block explicitly.

## Minimal First Implementation

Implement only this first:

1. Add `src/aaps-adapter.js`.
2. Add `/aaps status`, `/aaps install`, `/aaps init`, `/aaps validate`, `/aaps compile`, `/aaps check`, `/aaps run`, `/aaps studio`.
3. Add CLI flags `--aaps`, `--aaps-file`.
4. Add a safe AAPS status summary to `/status` when an AAPS project exists.
5. Add docs and smoke tests with `AAPS_MOCK` or local AAPS examples.
6. Do not add web editor yet.

First smoke tests:

```bash
node scripts/smoke-aaps.js
```

Smoke should cover:

- no AAPS installed -> status returns actionable missing state;
- sibling AAPS path -> parse example;
- project with `aaps.project.json` -> validate;
- compile check -> report path captured;
- dry-run/check -> no destructive side effects;
- `/aaps status` works in non-interactive simulation.

## Web Implementation After CLI

After CLI is stable:

1. Add `/api/aaps/status`.
2. Add `/api/aaps/files`.
3. Add `/api/aaps/file?path=...`.
4. Add `/api/aaps/file` save endpoint with guarded path checks.
5. Add `/api/aaps/parse`.
6. Add `/api/aaps/compile`.
7. Add `/api/aaps/run`.
8. Add AAPS tab in web UI.

The web editor can start as plain textarea plus diagnostics. The graph can come later.

## Product UX

The user mental model should be simple:

```text
Chat is for working.
AAPS is for making the work repeatable.
AgInTi executes.
AAPS remembers the pipeline.
```

Example flow:

```text
user> /aaps init "Android release QA"
user> make a workflow to build, install, screenshot, inspect logs, and summarize this Android app
aginti> creates workflows/android_release_qa.aaps
aginti> runs aaps compile --mode check
aginti> reports missing emulator/device setup or readiness
user> /aaps run
aginti> runs the executable blocks, uses AgInTi tools where needed, publishes screenshots/reports to canvas
```

## Why This Can Bring AgInTiFlow Up A Level

Normal coding agents are strong at local execution but weak at durable workflow shape.

AAPS gives AgInTiFlow:

- reusable project scripts for repeated work;
- user-editable high-level workflows;
- GUI-editable block graphs;
- compile/readiness reports before side effects;
- a natural form for large projects, papers, books, app QA, data analysis, and scientific pipelines.

AgInTiFlow gives AAPS:

- a real model/tool runtime;
- model/provider selection;
- browser/shell/file/canvas actions;
- long-running session management;
- better local UI;
- safer tool policy.

Together:

```text
AAPS = source code for autonomous work
AgInTiFlow = runtime for autonomous work
```

That is the clean product story.

## Risks

- Too much UI too early can make AgInTiFlow feel heavy.
- Silent auto-install of AAPS would surprise users.
- Running AAPS workflows can execute arbitrary declared commands if not routed through policy.
- Two run stores can confuse users unless linked clearly.
- If AgInTiFlow starts editing `.aaps` without compiling it, AAPS loses its main value.
- If AAPS Studio and AgInTi web both become full editors, duplicated UI maintenance will grow.

Mitigation:

- Start CLI-only.
- Use the AAPS CLI as source of truth.
- Show compile/run artifacts through existing AgInTi canvas.
- Add web editor only after adapter events and smoke tests are reliable.
- Keep install optional.

## Final Recommendation

Implement `/aaps` as a lightweight optional adapter first.

Do not make AAPS a hard dependency of AgInTiFlow. Do not merge the runtimes. Do not start with a full visual editor.

First milestone:

```text
AgInTiFlow can detect/install AAPS, initialize a project, validate/compile/check/run `.aaps`, and surface reports/artifacts in the current session.
```

Second milestone:

```text
AgInTiFlow web can edit `.aaps`, show parse diagnostics, and run compile/check/run from an AAPS tab.
```

Third milestone:

```text
AAPS can invoke AgInTiFlow as a backend agent for `exec agent "agintiflow_main"` blocks.
```

This keeps the architecture elegant: AAPS remains the explicit top-down pipeline language, while AgInTiFlow becomes the practical execution engine and user-facing agent workspace.
