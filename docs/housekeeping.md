# AgInTiFlow Housekeeping

AgInTiFlow keeps full private session history in `~/.agintiflow/sessions/<session-id>/`.
That history can include user prompts, model text, tool arguments, file diffs, and artifacts, so it is local-only and should not be committed.

Housekeeping is a lighter background layer for reusable learning:

- It listens to session events without blocking the main agent loop.
- It writes sanitized cross-session records to `~/.agintiflow/housekeeping/events.jsonl`.
- It maintains aggregate model, tool, and skill usage in `~/.agintiflow/housekeeping/capabilities.json`.
- It redacts common token/key/password patterns and replaces local project/home paths with placeholders.
- It stores previews, hashes, counts, model/tool names, selected skill ids, and touched skill files rather than a full second transcript.

Use:

```bash
aginti housekeeping
aginti housekeeping --json
```

Disable local housekeeping for a run:

```bash
AGINTIFLOW_HOUSEKEEPING=0 aginti
```

Project session pointers live in `.aginti-sessions/`, and old `.sessions/` folders may still exist after migration.
AgInTiFlow adds both to `.gitignore` during `aginti init` and when session storage is prepared, because these folders can contain private local metadata.

## Sharing Without A Center Server

Without a central server, the safe sharing path is:

1. Keep raw sessions and artifacts local.
2. Aggregate local learning into sanitized housekeeping capability data.
3. Promote reviewed reusable knowledge into Markdown skills, task profiles, command policy, or docs.
4. Ship those reviewed files through the npm package.

This avoids uploading private transcripts while still letting users receive better skills and tools when they upgrade `@lazyingart/agintiflow`.
