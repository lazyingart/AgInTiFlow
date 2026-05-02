# AgInTiFlow Project Instructions

These instructions apply when AgInTiFlow is developing the AgInTiFlow repository itself.

## Operating Root

- Treat this directory as the project root: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`.
- Keep CLI and web runs project-local so `.sessions/`, `.aginti/`, and `AGINTI.md` stay scoped to this repository.
- Do not read or print `.env`, `.npmrc`, `.aginti/.env`, npm tokens, API keys, or session credential material.

## Self-Development Protocol

1. Start with `git status --short`, `git diff --stat`, and relevant project instructions.
2. Use `inspect_project` before large changes, then search/read exact files before editing.
3. Prefer `apply_patch` for source edits and keep patches focused.
4. Run the narrowest useful check first, then broader checks when the narrow check passes.
5. Before commit or push, run `git status --short` again and stop on unrelated dirty files, conflicts, divergence, or ambiguous generated outputs.
6. Never publish npm, push tags, rewrite history, or run destructive host commands unless Lachlan explicitly asks for that step.

## Execution Modes

- Default coding mode: `docker-workspace` with package installs allowed inside Docker.
- Use host tmux tools for durable long-running sessions. Do not start tmux inside Docker `run_command`; those containers are ephemeral.
- Use host mode only when the task requires host tools, git remote operations, local preview, or direct system state. Inspect first and stop on risky ambiguity.
- For trusted full-access work, make the trust level explicit in the prompt and keep a concise command log.

## Required Checks

Use these gates as appropriate:

```bash
npm run check
npm test
npm run pack:dry-run
git diff --check
```

Focused checks can include:

```bash
npm run smoke:cli-chat
npm run smoke:tmux-tools
npm run smoke:web-api
npm run smoke:coding-tools
```

## Release Discipline

- Patch version for bug fixes and CLI/UI polish.
- Minor version for new runtime capability, tool surfaces, or package-visible docs/features.
- Major version only for intentional breaking changes.
- Publish only after tests and pack dry-run pass, using the existing safe redacted npm flow.

