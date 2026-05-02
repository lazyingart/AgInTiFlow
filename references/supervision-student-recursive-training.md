# Supervision Student Recursive Training

AgInTiFlow should improve through supervised real work. The core pattern is:

1. A student AgInTiFlow session attempts a concrete project.
2. A supervisor watches it like a demanding user, not like an implementer.
3. The supervisor verifies outcomes from filesystem, git, tests, devices, screenshots, logs, and session events.
4. Failures become durable improvements to AgInTiFlow itself.
5. The same session resumes and tries again.

This pattern is useful because a young agent may not yet be a strong worker, but it can still learn to become a strong supervisor. A good supervisor can decompose quality, detect false completion, and force evidence-driven iteration.

## Folder Layout

Use one organized root for future profile training:

```text
~/ProjectsLFS/Aginti-Test/
  HOMEWORK.md
  TASK-Profile-Auto/
  TASK-Profile-Code/
  TASK-Profile-Large-Codebase/
  TASK-Profile-App/
  TASK-Profile-Website/
  TASK-Profile-Paper/
  TASK-Profile-Research/
  TASK-Profile-Supervision/
```

Use the AgInTiFlow repo for durable example records:

```text
AgInTiFlow/
  aginti-work-examples/
    README.md
    homework-ledger.md
    android-tipsplit/
      tipsplit-screenshot-*.png
```

## Supervision Contract

The supervisor must not report success from the student's final answer alone.

Required checks:

- Inspect `git status --short`.
- Check expected files with `test -s`, `ls -lh`, `file`, `rg`, or domain-specific validators.
- Read relevant `.sessions/<session-id>/events.jsonl` entries for tool claims.
- Verify screenshots/images/PDFs/APKs/reports exist after cleanup.
- Record whether build/test/install/preview/research-source checks actually ran.
- Save evidence in the example ledger.

## Prompt Style

Training prompts should be realistic and sometimes imperfect:

- Short: "make a small Android app and install it"
- Ambiguous: "fix this repo and make it good"
- Broad: "write a paper-style report with figures"
- Operational: "pull latest, handle conflicts safely, commit and push"

The supervisor should not compensate by giving a full implementation recipe unless the student has already failed and the missing reusable capability is being diagnosed.

## Failure Taxonomy

When a student fails, classify the flaw before patching:

- `planning`: skipped inspection, bad decomposition, wrong acceptance criteria.
- `context`: read the wrong files, missed instructions, forgot prior state.
- `tool`: lacked a first-class command/tool or used it incorrectly.
- `policy`: unsafe command, host mutation, sudo prompt, destructive git behavior.
- `artifact`: missing output, temp file deleted, wrong save path, no durable proof.
- `verification`: claimed success without tests, screenshots, logs, or source checks.
- `UX`: output technically works but is ugly, confusing, or too noisy.
- `recovery`: looped on same error, did not stop on blocker, did not resume cleanly.

## Upgrade Targets

Prefer durable upgrades over rescue prompts:

- Add task profiles for broad modes.
- Add skills for repeated domain workflows.
- Add tools for repeatable operations.
- Add command-policy guards for unsafe/hanging commands.
- Add smoke tests for regressions.
- Improve UI/logging when the user cannot inspect progress.
- Improve artifact persistence when evidence can disappear.

## Recursive Training

After worker profiles improve, train the `supervision` profile itself:

1. Start a supervisor AgInTiFlow session.
2. Ask it to supervise a smaller student session on a scoped task.
3. The outer Codex supervisor checks the AgInTi supervisor, not the student directly.
4. Grade whether the AgInTi supervisor found flaws, verified evidence, and requested durable improvements.
5. Patch AgInTiFlow if the supervisor missed important quality gates.

This builds toward self-improving behavior without granting blind autonomy.

## Current Baseline

Completed supervised example:

- Android TipSplit app in `/home/lachlan/ProjectsLFS/Android-AgInTi-Test`.
- Built and tested by AgInTiFlow.
- Installed and launched on emulator.
- Screenshot was first lost because it was temporary; AgInTiFlow was patched to persist canvas file artifacts.
- A durable screenshot was then saved at `screenshots/tipsplit-screenshot-20260503-063332.png`.
- Auto Pocket Greenhouse task in `/home/lachlan/ProjectsLFS/Aginti-Test/TASK-Profile-Auto`.
- AgInTiFlow inferred a messy sensor folder, fixed the Python analysis, generated README/REPORT/CSV outputs, committed the result, corrected duplicated risk rows, and removed transient Python caches after supervisor review.

Next recommended training run:

- `TASK-Profile-Code`: seed a small multi-language repo with misleading names and broken tests. Grade inspect/search/read discipline, patch quality, focused checks, and clean git handling.
