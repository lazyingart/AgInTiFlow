# AAPS Adapter

AgInTiFlow can use AAPS as a declarative control plane for large work. AAPS owns the top-down workflow script (`.aaps`), project manifest, validation contracts, compile reports, and run artifacts. AgInTiFlow remains the interactive agent runtime with model routing, file tools, shell policy, Docker mode, tmux, sessions, and canvas artifacts.

The integration is intentionally lightweight. AgInTiFlow does not vendor the AAPS parser or require AAPS as a hard dependency. It discovers AAPS at runtime in this order:

1. `AAPS_BIN` or `AGINTI_AAPS_BIN`.
2. `node_modules/.bin/aaps` in the current project.
3. `aaps` on `PATH`.
4. A sibling development checkout at `~/ProjectsLFS/AAPS/scripts/aaps.js` when present.

## CLI

```bash
aginti aaps status
aginti aaps init "My AAPS Project"
aginti aaps files
aginti aaps validate
aginti aaps parse
aginti aaps compile check
aginti aaps check workflows/main.aaps
aginti aaps dry-run workflows/main.aaps
aginti aaps run workflows/main.aaps
```

Inside the interactive CLI, use the same commands with a slash:

```text
/aaps
/aaps on
/aaps init
/aaps validate
/aaps compile check
/aaps dry-run workflows/main.aaps
```

`/aaps on` switches the session to the AAPS task profile and raises the step budget for workflow work. `/aaps off` returns to the Auto profile.

## Safety

The adapter keeps paths project-relative and uses `execFile`, not shell interpolation. `status`, `files`, and `init` work without AAPS installed. Validation, parse, compile, check, and run require a discovered AAPS CLI.

`compile check` and `validate` are the recommended first checks. `run` can execute commands declared by the `.aaps` workflow, so treat it like any other project execution step and run only workflows you intend to execute.

`aginti aaps install` installs `@lazyingart/aaps` as a project dev dependency only when the current project has `package.json`. Use `aginti aaps install global` only when you intentionally want a global npm install.

## Project Shape

`aginti aaps init` creates a starter project without overwriting existing files:

```text
aaps.project.json
workflows/main.aaps
reports/
runs/
artifacts/
```

The starter workflow is deliberately simple: it defines a planner agent and a `draft_plan` task that writes `reports/aaps-plan.md`. Use it as a safe scaffold, then expand the workflow with blocks, validations, recovery steps, and review gates.

## When To Use AAPS

Use AAPS when a task is too large for a single chat-style loop and benefits from explicit phases:

- Multi-stage app development with review, tests, repair, screenshots, and release notes.
- Paper or book pipelines with outline, draft, figures, review, export, and publication checks.
- Data/research workflows with ingestion, cleaning, analysis, validation, and report artifacts.
- Recurring project maintenance with inspect, plan, patch, test, and commit stages.

For ordinary one-off coding or writing tasks, use normal AgInTiFlow prompts.
