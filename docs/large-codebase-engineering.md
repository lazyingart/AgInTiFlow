# Large Codebase Engineering

AgInTiFlow now treats large or complicated coding tasks as a different operating mode from short file edits.

## What Was Borrowed

Local agent references informed the design:

- Codex-style editing: read/search first, apply deterministic patches, record diffs and hashes, then run checks.
- Copilot-style SDK surfaces: structured tools, session persistence, plan/history/workspace APIs, and explicit permission hooks.
- Claude/Claw-style safety: project-local status, container-first execution, read-only operations by default, and clear failure recovery.
- Gemini/Qwen-style extensibility: capability discovery through profiles and tools rather than hardcoding one model behavior.

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
2. `read_file` on `AGENTS.md`, `README.md`, and manifests.
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
