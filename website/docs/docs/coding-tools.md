# Coding Tools

AgInTiFlow is designed to edit code through deterministic workspace tools, not only shell text.

## Tool Loop

For a coding task, the model should usually:

1. Inspect project instructions and manifests.
2. Search for exact symbols or files.
3. Read the relevant files.
4. Patch small coherent changes.
5. Run focused checks.
6. Repair failures.
7. Summarize changed files, checks, and residual risks.

## Workspace Tools

| Tool | Purpose |
| --- | --- |
| `inspect_project` | Build a bounded project overview. |
| `list_files` | List workspace files and directories. |
| `read_file` | Read guarded text files. |
| `search_files` | Search text inside the workspace. |
| `write_file` | Create or overwrite safe workspace files. |
| `apply_patch` | Apply exact replacements, Codex-style patch envelopes, or unified diffs. |

## Guardrails

The tools block:

- paths outside the workspace
- `.git` internals
- secret-like paths such as `.env`
- huge files
- binary overwrites
- unsafe `node_modules` writes

## Patch Display

Each write records:

- path
- action
- before hash
- after hash
- byte counts
- compact diff

CLI and web both render diffs. CLI uses red and green terminal color for removed and added lines.

## Large Codebases

For large repositories, use:

```bash
aginti --profile large-codebase "fix the failing checkout flow tests"
```

The profile encourages codebase maps, precise search, patch discipline, and focused verification.
