# Productive Agent Roadmap

AgInTiFlow should become a practical coding agent, not only a chat UI around a model. DeepSeek v4 pro is strong and cheap, so the advantage is to spend more inference on context, review, and verification while keeping the main executor focused.

## Lessons From Other Agents

- Codex: orient with file search, edit with deterministic patches, run focused checks, and keep git status visible.
- Claude Code: keep the terminal UX simple, project-local, resumable, and interruption-friendly.
- Gemini CLI: expose extensibility through tools, MCP-style capabilities, large-context workflows, and auth/setup discovery.
- Copilot SDK: make sessions, hooks, permissions, telemetry, and tool events first-class APIs.
- Claw Code: use doctor/preflight checks, container-first execution, parity tests, and explicit lifecycle state.
- LazyingArtBot: preserve workflow memory and artifacts so the agent can continue creative or production tasks later.

## Current Strengths

- Project-local CLI and web share sessions, preferences, artifacts, and `AGINTI.md`.
- DeepSeek flash/pro routing, Docker workspace mode, web search, image generation, canvas artifacts, and guarded file tools are already wired.
- `inspect_project`, `apply_patch`, command policy, git discipline, and the scout swarm give the model concrete tools instead of relying on memory.

## Missing Productive-Agent Pieces

1. Durable codebase map: cache `inspect_project`, symbol locations, test commands, package scripts, and recently changed files per project. Initial slice implemented as `.aginti/codebase-map.json` with manifests, source/test dirs, package scripts, languages, git hints, and recommended reads.
2. Scout blackboard: let scouts write short structured findings to a shared board, then run a coordinator pass that resolves conflicts before execution. Initial slice implemented as per-session `artifacts/scout-blackboard.json` with role lanes, findings, coordinator handoff, and codebase-map metadata.
3. Long-run checkpoints: save phase state after inspect, patch, test, repair, and commit so a long task can recover after interruption.
4. Symbol/LSP tools: add find-definition, references, diagnostics, and document-symbols for JS/TS, Python, Rust, Go, and C/C++ where available.
5. Test triage: parse common test failures into file, symbol, command, and likely cause so repair loops stay narrow.
6. Patch review loop: before finalizing large edits, run a cheap reviewer scout over diffs, risks, and missing tests.
7. Dependency doctor: detect toolchain gaps and propose Docker/project-local setup before touching host installs.
8. Release assistant: status, diff, changelog, version bump, pack, publish, push, and rollback notes as a reusable workflow.

## Swarm Design

Scouts must not become noisy subagents. Each scout gets the same bounded context pack generated from the durable codebase map and one role. The coordinator produces a Swarm Board with shared context, execution order, disagreements, must-read files, checks, and stop conditions. The main agent still owns tool use and must re-read exact files before editing.

Use 3 scouts for medium tasks, 5 for large tasks, and up to 10 for complex multi-language or system tasks. More scouts are only useful when their roles cover different failure modes.
