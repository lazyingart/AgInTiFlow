# Self-Development Supervision

This document defines how to let AgInTiFlow work on its own source code under Codex supervision.

## Readiness Verdict

AgInTiFlow is ready for supervised self-development on small and medium tasks. It has the required primitives:

- Project-local sessions and web/CLI sync.
- DeepSeek flash/pro routing with mock fallback.
- Workspace file tools, deterministic `apply_patch`, and compact diffs.
- Docker workspace mode for package installs and checks.
- Host tmux tools for durable monitored sessions.
- Guardrails for secrets, npm publishing, `.git`, `node_modules`, and destructive commands.
- Full test, smoke, and pack dry-run scripts.

It is not ready for fully unsupervised release or system-level work. Codex should remain the supervisor for commits, pushes, npm publishing, high-risk host commands, and ambiguous git states.

## Recommended Launch

Start AgInTiFlow in a separate tmux session from the source repo:

```bash
tmux new-session -d -s agintiflow-selfdev -c /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
tmux send-keys -t agintiflow-selfdev 'aginti --profile large-codebase --parallel-scouts --scout-count 5' Enter
```

For a single supervised task:

```bash
aginti --profile large-codebase --parallel-scouts --scout-count 5 \
  "inspect this repo, implement the requested change, run focused checks, and stop before commit"
```

Use `aginti web --port 3221` from the same folder if a browser UI is preferred. CLI and web will share `.sessions/`.

## Supervisor Duties

Codex should supervise by:

1. Capturing tmux output before sending input.
2. Keeping the task scoped and testable.
3. Reviewing diffs before commit.
4. Running or verifying `npm test`, `npm run pack:dry-run`, and `git diff --check` when package behavior changes.
5. Rejecting changes that weaken guardrails without explicit reasoning.
6. Handling commit, push, and publish steps itself unless Lachlan explicitly delegates them to AgInTiFlow.

## Safe Task Types

Good first self-development tasks:

- Add or improve docs.
- Add smoke tests around existing behavior.
- Improve prompt wording or task profiles.
- Make small CLI/web UI polish changes.
- Add capability reports or non-invasive diagnostics.

Use stronger supervision for:

- Model-client tool schemas.
- Guardrails and command policy.
- Docker runtime changes.
- Npm publishing workflow.
- Git automation.
- Session persistence and database changes.

## Stop Conditions

AgInTiFlow should stop and ask for supervision when it sees:

- Dirty unrelated files.
- Failing tests it cannot explain.
- Git conflicts, divergence, rebase/merge choices, or reset/checkout suggestions.
- Requests to publish npm, push tags, delete files, rotate secrets, or run host sudo.
- A plan that exceeds the current step budget without a completed checkpoint.

## Housekeeping Before Each Self-Dev Session

Run:

```bash
git status --short
aginti doctor
aginti doctor --capabilities
npm run check
```

For larger changes also run:

```bash
npm test
npm run pack:dry-run
git diff --check
```

