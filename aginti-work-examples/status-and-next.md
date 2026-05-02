# Supervision Status And Next Work

## What We Have Already Proven

- `android`: AgInTiFlow built a real TipSplit Android app, ran tests, installed/launched it on an emulator, improved the UI, committed changes, and saved a durable screenshot after supervision caught a temporary-artifact flaw.
- `artifact durability`: `send_to_canvas` now persists workspace file paths into session artifacts so preview evidence is not lost when a temp file is deleted.
- `policy`: Android supervision exposed unsafe host sudo/package-install behavior; command policy now blocks that path in host mode.
- `final git state`: AgInTiFlow now receives stronger guidance to check and report final git status.
- `profile coverage`: profiles expanded to cover common daily work: code, large codebase, app, website, Python, Node, C/C++, R/Stan, Android, LaTeX, paper, research, writing, book, novel, design, image, Word, GitHub, shell, maintenance, AAPS, and supervision.

## What Is Not Yet Fully Proven

The following profiles exist but still need real supervised homework runs:

- `auto`
- `code`
- `large-codebase`
- `app`
- `website`
- `python`
- `node`
- `c-cpp`
- `r-stan`
- `latex`
- `paper`
- `research`
- `writing`
- `book`
- `novel`
- `design`
- `image`
- `word`
- `github`
- `shell`
- `maintenance`
- `aaps`
- `supervision`

## Next Run

Start with `TASK-Profile-Auto` because `auto` is the daily default. The stress test should be intentionally vague and mixed: inspect unknown files, infer task type, create a useful artifact, run a relevant check, and save everything with a good name.

If `auto` succeeds, move to `code` and `large-codebase`. If it fails, improve the general profile and skill-selection logic before adding more specialized tests.
