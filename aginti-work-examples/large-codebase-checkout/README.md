# Large Codebase Supervision: Checkout Workspace

## Summary

AgInTiFlow completed the `large-codebase` homework in:

`/home/lachlan/ProjectsLFS/Aginti-Test/TASK-Profile-Large-Codebase`

The task was a deliberately broken multi-package Node checkout workspace. AgInTiFlow had to diagnose cross-package failures, patch only the relevant source files, run checks, initialize git, commit, and leave the tracked worktree clean.

## Supervision Details

- Tmux session: `aginti-profile-large-codebase`
- Failed first session: `web-agent-eead736a-0db8-4f06-a47c-b4212a75f62f`
- Successful session: `web-agent-d50715ad-0ed2-42ae-9472-a954a2430e22`
- Supervised project commit: `b98c1c7 Fix cross-package bugs: normalizeSku spaces, discount subtotal, report totalItems`

## Initial Failure Exposed

The first run failed before doing project work:

```text
403 Project ... does not have access to model gpt-5.4-mini
```

Root cause: the persistent tmux server did not inherit the current DeepSeek environment, so the session selected an OpenAI route. AgInTiFlow was patched so CLI defaults respect environment profile/model role variables more consistently. The successful run was restarted with DeepSeek env sourced without printing secrets.

## Student Work

AgInTiFlow found and fixed three source bugs:

- `packages/catalog/src/catalog.js`: `normalizeSku` converted underscores but not spaces.
- `packages/cart/src/cart.js`: coupon discount was computed per unit item instead of on subtotal.
- `packages/report/src/report.js`: `totalItems` counted line items instead of summing quantities.

## External Verification

Codex supervisor verified independently after the student reported completion:

```text
npm test
4 pass, 0 fail

npm run check
node --check passed for all source files

git status --short
<empty tracked worktree>
```

The session saved a scout blackboard and step snapshots under:

`/home/lachlan/ProjectsLFS/Aginti-Test/TASK-Profile-Large-Codebase/.sessions/web-agent-d50715ad-0ed2-42ae-9472-a954a2430e22/artifacts/`

## Grade

`A-`

It finished the target task independently after the environment issue was corrected. The main reusable improvement was launch/profile/env handling, not large-codebase reasoning. The agent did use many steps, but it inspected failures, patched incrementally, verified checks, and committed cleanly.

