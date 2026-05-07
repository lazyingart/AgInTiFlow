# Supervision Status And Next Work

## What We Have Already Proven

- `android`: AgInTiFlow built a real TipSplit Android app, ran tests, installed/launched it on an emulator, improved the UI, committed changes, and saved a durable screenshot after supervision caught a temporary-artifact flaw.
- `auto`: AgInTiFlow handled a vague messy-folder task, inferred the domain, fixed a script, generated a report and cleaned data, committed changes, then corrected duplicate analysis output and recursive Python cache hygiene after supervisor review.
- `code`: AgInTiFlow fixed seeded Python ledger bugs from a vague prompt, recovered after a stopped run, reran checks, ignored agent artifacts, committed the fix, and passed external unittest/pytest/CLI verification.
- `large-codebase`: AgInTiFlow fixed a multi-package checkout workspace across catalog/cart/report, ran `npm test` and `npm run check`, initialized git, committed `b98c1c7`, and left a clean tracked worktree.
- `artifact durability`: `send_to_canvas` now persists workspace file paths into session artifacts so preview evidence is not lost when a temp file is deleted.
- `policy`: Android supervision exposed unsafe host sudo/package-install behavior; command policy now blocks that path in host mode.
- `final git state`: AgInTiFlow now receives stronger guidance to check and report final git status.
- `profile coverage`: profiles expanded to cover common daily work: code, large codebase, app, website, Python, Node, Java/JVM, iOS/Swift, Go, Rust, .NET/C#, PHP, Ruby, C/C++, R/Stan, Android, LaTeX, paper, research, writing, book, novel, design, image, Word, GitHub, shell, maintenance, AAPS, and supervision.
- `read-only path advice`: a ProteinStructure-style read-only missing host path in docker-workspace mode no longer triggers misleading danger-mode permission advice; outside-workspace write/destructive failures still produce approval/remedy guidance.
- `cli option precedence`: explicit one-shot CLI options such as `--package-install-policy block` and `--cwd <path>` now survive permission-mode defaults and route execution into the requested project instead of silently falling back to the process cwd.

## What Is Not Yet Fully Proven

The following profiles exist but still need real supervised homework runs:

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
- `java`
- `ios`
- `go`
- `rust`
- `dotnet`
- `php`
- `ruby`
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

Move next to `TASK-Profile-QA`, then language/platform profiles such as `TASK-Profile-Java`, `TASK-Profile-IOS`, `TASK-Profile-Go`, and `TASK-Profile-Rust`. The next QA stress task should use a normal user-level prompt and verify that the agent creates or repairs a clean runnable test project without inventing contrived failures.

Before the next broad profile run, keep one control regression in scope: verify that `/status`, `Esc`, `Ctrl+C`, resume pagination, explicit `--cwd`, explicit package policy, and read-only missing-path failures remain stable in the installed CLI after every interactive-shell change.
