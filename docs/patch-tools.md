# Patch Tools

AgInTiFlow exposes a deterministic `apply_patch` workspace tool for coding-agent edits. It is designed for DeepSeek v4 pro and other routed models to make auditable code changes without relying on free-form shell redirection.

## Supported Patch Modes

- Exact replacement: pass `path`, `search`, `replace`, and optionally `expectedReplacements` or `baseHash`.
- Codex-style patch envelope: pass `patch` with `*** Begin Patch`, `*** Update File`, `*** Add File`, `*** Delete File`, and `*** End Patch`.
- Unified diff: pass `patch` with standard `--- a/file`, `+++ b/file`, and `@@` hunks.

All paths must stay inside the configured workspace. Secret-like paths, `.git`, `node_modules` writes, binary files, and huge files are blocked. Multi-file patches are preflighted before writing, and each changed file records before/after hashes plus a compact diff in the session events.

Edits to a file with consistently CRLF line endings retain that convention,
including when the search text comes from the LF display returned by `read_file`.
Only line separators are adapted. Context, whitespace, case, match counts and
base hashes still have to match; the UTF-8 BOM and untouched bytes are preserved.
Files with mixed line endings or bare carriage returns require exact matching.
New files use the supplied content. Use an explicit whole-file rewrite when
changing a file's line-ending convention is part of the task.

## Agent Workflow

For large codebases, the model should first use `list_files`, `search_files`, and `read_file` to identify the relevant files. It should then call `apply_patch`, run safe tests or linters when available, and summarize changed files and residual risk.

Smart routing treats patch/refactor/edit/database tasks as complex work, so the LocalLLM `localllm-deep` main lane is selected by default unless the user explicitly chooses another route.
