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

Scout output is injected as advisory context only. The main agent still owns execution and must use real tools to inspect, edit, run commands, and finish. CLI flags:

```bash
aginti --parallel-scouts --scout-count 4 "fix this complicated repo bug"
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
