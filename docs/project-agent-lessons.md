# Project-Agent UX Lessons

Round 8 distilled implementation lessons from local agent projects and applied the highest-value subset to AgInTiFlow.

## Codex

- Treat the launch directory as the working project unless the user overrides it.
- Keep patch/file tools deterministic and auditable: edits should be workspace-local, compactly diffed, and easy to inspect.
- Resume should be a first-class CLI flow, not only a hidden runtime detail.

## Claude Code

- Terminal UX should be simple: install, `cd` into a project, run the agent.
- Project context matters more than global state for everyday coding work.
- Natural-language prompts should map to file edits, shell checks, and git-aware workflows without extra ceremony.

## Gemini CLI

- Session history should be project-scoped so runs from different folders do not mix.
- Checkpoints/resume flows need discoverable commands and clear current-project boundaries.
- Extensibility works best as named profiles/skills rather than hardcoded one-off prompts.

## Copilot SDK

- BYOK status should report only presence/absence and env-var names, never raw key material.
- Session APIs should expose metadata, logs, workspace state, and model/provider choices for web clients.
- Tool and permission hooks should be visible enough that users can understand why actions were allowed or blocked.

## Claw Code

- First-run `init` and `doctor` commands reduce setup ambiguity.
- Container/sandbox readiness should be diagnosed before complex tasks.
- Parity and smoke checks should run against isolated project folders, not only the source repo.

## Applied In AgInTiFlow

- `aginti web` now defaults command execution to the folder it was launched from.
- CLI and web share `.sessions/` in the project root.
- `aginti init`, `aginti doctor`, `aginti keys`, `aginti sessions`, and `aginti resume` provide basic project lifecycle control.
- Task profiles wire lightweight skill prompts into CLI/web runs while keeping the LLM responsible for the main plan.
- Project-local `.aginti/.env` can store provider keys safely with 0600 permissions and ignored git entries.
