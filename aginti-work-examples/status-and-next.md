# Supervision Status And Next Work

## What We Have Already Proven

- `android`: AgInTiFlow built a real TipSplit Android app, ran tests, installed/launched it on an emulator, improved the UI, committed changes, and saved a durable screenshot after supervision caught a temporary-artifact flaw.
- `auto`: AgInTiFlow handled a vague messy-folder task, inferred the domain, fixed a script, generated a report and cleaned data, committed changes, then corrected duplicate analysis output and recursive Python cache hygiene after supervisor review.
- `code`: AgInTiFlow fixed seeded Python ledger bugs from a vague prompt, recovered after a stopped run, reran checks, ignored agent artifacts, committed the fix, and passed external unittest/pytest/CLI verification.
- `artifact durability`: `send_to_canvas` now persists workspace file paths into session artifacts so preview evidence is not lost when a temp file is deleted.
- `policy`: Android supervision exposed unsafe host sudo/package-install behavior; command policy now blocks that path in host mode.
- `final git state`: AgInTiFlow now receives stronger guidance to check and report final git status.
- `profile coverage`: profiles expanded to cover common daily work: code, large codebase, app, website, Python, Node, C/C++, R/Stan, Android, LaTeX, paper, research, writing, book, novel, design, image, Word, GitHub, shell, maintenance, AAPS, and supervision.

## What Is Not Yet Fully Proven

The following profiles exist but still need real supervised homework runs:

- `large-codebase`
- `qa`
- `database`
- `devops`
- `security`
- `data`
- `docs`
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
- `slides`
- `education`
- `image`
- `word`
- `github`
- `shell`
- `maintenance`
- `aaps`
- `supervision`

## Next Run

Move next to `TASK-Profile-Large-Codebase`, then `TASK-Profile-QA`. The next stress task should seed a cross-file bug with misleading names so the agent must build a context pack, search symbols, avoid over-reading, run focused checks first, and leave a clean commit.
