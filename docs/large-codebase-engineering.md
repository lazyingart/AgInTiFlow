# Large Codebase Engineering

AgInTiFlow now treats large or complicated coding tasks as a different operating mode from short file edits.

## What Was Borrowed

Local agent references informed the design:

- Codex-style editing: read/search first, apply deterministic patches, record diffs and hashes, then run checks.
- Copilot-style SDK surfaces: structured tools, session persistence, plan/history/workspace APIs, and explicit permission hooks.
- Claude/Claw-style safety: project-local status, container-first execution, read-only operations by default, and clear failure recovery.
- Gemini/Qwen-style extensibility: capability discovery through profiles and tools rather than hardcoding one model behavior.
- Claw-style `doctor` discipline: check health and environment before treating system symptoms as code bugs.
- Claude/Codex-style context discipline: read project instructions, manifests, entry points, and failing tests before touching broad files.

The shared pattern is not “put the whole repo in context.” It is: build a cheap map, choose the next exact evidence, edit with deterministic patches, verify, then compact what changed. AgInTiFlow uses cheap DeepSeek calls to add more independent eyes around that loop, not to replace it.

## Skill vs Tool

The `large-codebase` profile is a skill: it changes the model’s engineering behavior. It tells DeepSeek v4 pro to orient first, plan minimally, patch incrementally, and verify.

The `inspect_project` function is a tool: it deterministically scans the workspace and returns:

- top-level files and directories
- manifest files such as `package.json`, `pyproject.toml`, `Cargo.toml`, and `go.mod`
- package scripts
- likely source and test directories
- language and extension counts
- recommended files to read next

## Recommended Loop

For complicated tasks, the agent should follow this loop:

1. `inspect_project` to map the repository.
2. `read_file` on `AGINTI.md`, `AGENTS.md`, `README.md`, and manifests.
3. `search_files` for symbols, tests, errors, routes, or config names.
4. `read_file` only on the files needed for the change.
5. `apply_patch` in small coherent batches.
6. `run_command` for the narrowest relevant check first.
7. Broaden checks only after the focused check passes.

## Context Budgeting

Mature coding agents avoid keeping an entire growing project in the prompt. AgInTiFlow uses a layered context pack:

- Stable memory: `AGINTI.md`, `AGENTS.md`, README files, manifests, and package scripts.
- Project map: `inspect_project` summaries, language counts, source/test directories, and recommended reads.
- Active evidence: exact search hits, selected files, failing command output, and compact git status/diff.
- Patch context: only the nearby code needed for `apply_patch`, plus before/after hashes and compact diffs.
- Scout synthesis: cheap parallel DeepSeek scouts produce bounded advice, then a coordinator summary is injected instead of every long transcript becoming permanent context.

This keeps the main executor sober: it knows where it is in the repo, but it still re-reads exact files before editing and validates with commands rather than trusting stale memory.

## Surgical Context Pack

For complex engineering tasks where parallel scouts are disabled or unavailable, AgInTiFlow now prepares a lightweight surgical context pack before planning/execution:

- refreshes `.aginti/codebase-map.json` with `inspect_project`
- saves a session artifact named `surgical-context-pack.json`
- injects a compact repo overview into the model history
- includes an explicit surgical editing contract and evidence-card template
- carries the context handle in runtime snapshots so later steps can rehydrate exact files by path/search

This is intentionally not a whole-repo dump. The context pack is an overview handle. The executor must still search and read exact files before patching, state the active boundary, patch the smallest coherent surface, inspect the diff, and run focused checks.

The effective loop is:

```text
overview map -> active evidence card -> exact file windows -> surgical patch -> focused check -> diff review -> broader check if needed
```

## Git Discipline

When asked to commit, pull, merge, or push, the agent should run `git status --short` and `git diff --stat` first. It should commit only intended changes, use `git fetch` and `git pull --ff-only` when remote state matters, and stop for the user on conflicts, divergence, unrelated dirty files, or any merge/rebase/reset choice. Web and CLI logs fold long command output but keep full command summaries visible.

## CLI And Web Parity

Both CLI and web use the same task profile registry and the same model/tool schemas. Use either:

```bash
aginti --profile large-codebase "fix the failing tests"
```

or choose **Large codebase engineering** in the web task-profile dropdown.

Smart routing sends this profile to DeepSeek v4 pro even when the user prompt is short.

## Auto Profile Behavior

The web app still defaults to **Auto**. Auto does not mean weak. When the prompt mentions a large repo, system bug, failing tests, setup, install, migration, or a known language stack, AgInTiFlow adds engineering guidance and raises the step budget automatically.

Profiles are skill bias, not restrictions. `auto` is the broad general agent; `code`, `latex`, `website`, `maintenance`, and other profiles add stronger habits for that task type while still allowing the agent to use files, shell, browser, web search, canvas, and sandbox tools when they help.

Examples:

```bash
aginti "debug this Python project system bug and fix failing tests"
aginti "fix the Rust workspace build"
aginti "repair the Docker setup and run the Node tests"
```

These route to DeepSeek v4 pro when the complexity score is high enough.

## Parallel Scout Mode

DeepSeek calls are cheap enough that complex tasks can use several short advisory calls before the main executor starts. When enabled, AgInTiFlow runs bounded scouts in parallel:

- Architect: decomposes the task and identifies first files/logs/commands.
- Implementer: predicts patch boundaries and focused checks.
- Reviewer: looks for missing tests, risks, and instruction-compliance failures.
- Researcher: suggests `web_search` queries when current information may matter.
- Cartographer: builds a compact context map instead of dumping the whole tree.
- Tester: finds the narrowest useful checks and setup blockers.
- Git operator: keeps status/diff/commit/pull/push workflows disciplined.
- Integrator: looks for cross-stream conflicts and ordering constraints.
- Symbol tracer: predicts names, APIs, routes, schemas, and searches that connect the change.
- Dependency doctor: checks package managers, Docker/toolchain setup, generated artifacts, and install risks.

Before scouts run, AgInTiFlow builds a bounded shared context pack from a durable project map at `.aginti/codebase-map.json`: manifests, top-level files, source/test directories, package scripts, language counts, git status hints, and recommended reads. This avoids the weak pattern of each scout rediscovering the repo differently or flooding the main context with an infinite tree.

Scout output is synthesized by a coordinator Swarm Board, persisted as `artifacts/scout-blackboard.json`, and injected as advisory context only. The board records shared context, execution order, conflicts/unknowns, must-read files/checks, and stop conditions. The main agent still owns execution and must use real tools to inspect, edit, run commands, and finish. CLI flags:

```bash
aginti --parallel-scouts --scout-count 10 "fix this complicated repo bug"
aginti --no-parallel-scouts "run a cheap short task"
```

The web app exposes the same toggle and scout count.

## Web Search

Use `web_search` for current docs, package/toolchain errors, install instructions, and source discovery. It returns compact titles, URLs, and snippets, and should be preferred over opening a search engine in the browser. Specific result pages can still be opened later with `open_url`.

```bash
aginti --web-search "look up the current pytest config docs and update this project"
aginti --no-web-search "work fully offline"
```

## Cross-Language Playbook

AgInTiFlow gives DeepSeek stack-specific reminders without hardcoding a solution:

- JS/TS: inspect package scripts and lockfiles, then run focused `node`, `tsc`, or test commands.
- Python: inspect `pyproject.toml` or requirements, prefer project-local venv/conda/Docker, then run focused pytest/module checks.
- Rust/Go/JVM/C/C++: inspect native manifests, format only touched files when possible, and start with narrow build/test targets.
- R/Stan/LaTeX: keep toolchains project-local or Docker-backed, compile from the right directory, and publish useful artifacts to canvas.
- System tasks: diagnose first, capture versions/logs, write reversible scripts, use Docker for installs, and avoid silent host-level changes.
