# Code Profile Homework: Pocket Ledger Tools

## Supervised Run

- Date: 2026-05-03
- Profile focus: `code` with `qa` habits
- Workspace: `/home/lachlan/ProjectsLFS/Aginti-Test/TASK-Profile-Code`
- tmux session: `aginti-profile-code`
- AgInTiFlow session: `web-agent-ed9a260a-8506-4cb3-92f8-5214c5df948f`
- Final supervised project commit: `ef3b020`

## Stress Prompt

```text
this repo has some bugs and messy parts. can you make it good, run whatever checks make sense, and leave it clean?
```

The prompt intentionally avoided naming the failing functions or exact tests.
The student had to inspect the project, run checks, diagnose, patch, rerun, and
commit without a solution recipe.

## Result

AgInTiFlow fixed the ledger package after one reusable self-upgrade:

- `parse_amount` now handles `$`, commas, accounting parentheses, and negative amounts.
- `summarize_transactions` uses expense magnitudes, accumulates category totals, and computes `net = income - expenses`.
- CLI `--min-amount` filters by absolute value.
- `.gitignore` now ignores `.aginti/` and `.sessions/` student artifacts.
- Intentional changes were committed in the supervised project.

## External Verification

Codex verified the result outside the student session:

```text
git status --short
# clean tracked worktree; only ignored .aginti/ and .sessions/

python -m unittest discover -s tests -v
# Ran 4 tests in 0.043s
# OK

python -m pytest --tb=short -v
# 4 passed

PYTHONPATH=src python -m ledger_tools.cli data/transactions.csv
# {"categories": {"Food": 185.0, "Rent": 1200.5, "Software": 35.0, "Transport": 80.0}, "count": 6, "expenses": 1500.5, "income": 3200.0, "net": 1699.5, "top_category": "Rent"}
```

## AgInTiFlow Improvements From This Run

- `code` profile now routes vague real bugfix work to DeepSeek V4 Pro instead of Flash.
- `code` profile now receives a 36-step inspect-fix-test-cleanup budget.
- `code` profile prompt now explicitly handles cleanup and optional lint scope.
- One-shot CLI defaults now respect `SANDBOX_MODE`, `PACKAGE_INSTALL_POLICY`, and `USE_DOCKER_SANDBOX` environment settings instead of forcing Docker.
- Smoke coverage now checks code-profile Pro routing, step budget, and one-shot env sandbox defaults.

## Remaining Training Notes

- The student correctly recovered from a failed patch by reading and retrying, but it still spent several steps on cosmetic lint. Future QA/code runs should test whether it can distinguish required checks from optional style work earlier.
- The student set a local repository git identity when Docker lacked one. That is acceptable for a disposable homework repo, but GitHub/release homework should prefer the user's existing identity and stop on ambiguous identity choices.
