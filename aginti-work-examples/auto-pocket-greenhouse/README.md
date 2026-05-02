# Auto Profile Homework: Pocket Greenhouse

## Summary

This example records the first supervised `auto` profile homework run.
AgInTiFlow was given a deliberately vague folder-cleanup prompt and asked to
infer the task, produce something useful, run checks, and leave the project in
a clean state.

## Supervised Project

- Workspace: `/home/lachlan/ProjectsLFS/Aginti-Test/TASK-Profile-Auto`
- Tmux session: `aginti-profile-auto`
- AgInTiFlow session: `web-agent-b82e5ae2-d143-4782-9cd8-239e7ae73432`
- Final project commit: `c68f44f fix: deduplicate risk rows in analysis output`

## What The Student Did

- Inferred the folder was a Pocket Greenhouse Sensor Monitor prototype.
- Fixed `scripts/analyze.py`.
- Generated `data/clean_sensor_readings.csv`.
- Wrote `README.md` and `REPORT.md`.
- Ran Python syntax and analysis checks.
- Committed the finished project.
- Corrected duplicated risk-row output after supervisor review.
- Removed recursive Python cache artifacts after supervisor review.

## External Verification

The supervisor verified these from outside the student session:

- `git status --short` is empty.
- `python3 -m py_compile scripts/analyze.py` passes.
- `python3 scripts/analyze.py` returns three unique risk rows with combined flags.
- `find . -type d -name __pycache__ -o -name '*.pyc'` returns no cache artifacts.
- `README.md`, `REPORT.md`, `data/clean_sensor_readings.csv`, and `scripts/analyze.py` exist and are non-empty.

## Grade

`A-`: the agent completed the vague task and corrected flaws after supervisor
feedback. The main reusable lessons were added to AgInTiFlow: polish actual
generated output before finalizing, prefer workspace-relative shell commands,
and check stack-specific transient files recursively before claiming a clean
workspace.

