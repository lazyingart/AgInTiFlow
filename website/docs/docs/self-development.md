# Self Development

AgInTiFlow can be used to develop AgInTiFlow itself, but it should be supervised.

## Recommended Setup

Use a separate terminal or tmux session inside the AgInTiFlow repository:

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
aginti
```

The supervising engineer should keep a normal terminal available for review, tests, git status, and release decisions.

## Housekeeping Before Self-Edit

- Ensure `git status --short` is understood.
- Commit or stash unrelated user work.
- Confirm the npm version and current published version.
- Run `npm test` before starting major edits.
- Keep secrets out of `.env`, logs, and commits.
- Prefer small tasks and inspectable patches.

## Safe Self-Development Loop

1. Ask AgInTiFlow to inspect and plan.
2. Let it patch a bounded area.
3. Run focused checks.
4. Review diffs manually.
5. Commit with a clear message.
6. Publish only when the behavior change should reach installed users.

## Stop Conditions

Stop and ask a human when:

- tests fail in a way the agent cannot localize
- git has unrelated dirty files
- publishing asks for OTP or browser setup
- a command needs sudo or host destructive access
- the plan starts broad rewrites without concrete file scope
