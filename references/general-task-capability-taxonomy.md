# General Task Capability Taxonomy

AgInTiFlow should be useful as a daily local agent, not only as a coding demo.
The UI should expose a manageable set of major profiles while the skill library
and Auto routing cover detailed task families.

## Profile Philosophy

- `auto` is the daily default. It should infer the task family and borrow the
  right profile and skill habits without forcing the user to select one.
- Profiles are bias, not restrictions. A `writing` run may still inspect files,
  run scripts, or use web search; a `code` run may still update docs.
- Skills are markdown operating procedures selected by trigger words and task
  profile. They are more granular than profiles and should cover common daily
  subtasks.
- Supervision is a meta-skill. It improves the agent, but it does not replace
  domain skills for writing, coding, design, data, system work, and research.

## Major Profiles

| Profile | Daily task families covered | Quality gates |
| --- | --- | --- |
| `auto` | Mixed requests, vague folder cleanup, small shell/file tasks, inferred profile work | infer correctly, create durable output, run a useful check, final git/artifact state |
| `code` | features, bug fixes, refactors, packages, scripts, APIs | pro route by default, inspect/search/read first, patch minimal files, focused tests, cleanup/gitingore artifacts, residual risk |
| `large-codebase` | cross-file bugs, architecture changes, migrations, multi-package repos | context pack, symbol search, narrow-to-broad checks, no unrelated edits |
| `qa` | failing tests, CI, flaky tests, coverage, regression harnesses | reproduce failure, identify root cause, add regression, rerun focused checks |
| `database` | SQL, schema, migrations, seed data, persistence bugs | inspect schema/migrations, avoid data loss, reversible migration, query checks |
| `devops` | Docker, CI/CD, deployment, services, ports, logs, runtime config | read-only diagnosis first, idempotent setup, no silent sudo, health/log proof |
| `security` | auth, secrets, input validation, dependency risk, shell safety | no secret leakage, prioritize real exploitability, scanner plus review evidence |
| `data` | CSV/JSON cleanup, ETL, plots, reports, notebooks, reproducible analysis | preserve raw data, validate rows/schema, rerun script, save clean artifacts |
| `research` | current-source research, literature notes, technical comparisons | cite sources, separate evidence from inference, save dated notes |
| `paper` | academic manuscripts, abstracts, figures, related work | outline claims, sources traceable, compile/check when possible |
| `latex` | TeX reports, equations, figures, bibliography, PDF compile | use existing TeX first, compile enough passes, save PDF/source |
| `writing` | articles, blog posts, scripts, copy, markdown, editing | durable draft, outline, revision notes, voice/tone preserved |
| `book` | chapter maps, long-form structure, continuity | chapter files, style/continuity notes, revision plan |
| `novel` | fiction scenes, character arcs, worldbuilding | story bible, scene files, continuity checks |
| `docs` | README, API docs, tutorials, changelog, knowledge base | source-backed docs, runnable examples, link/command checks |
| `slides` | pitch decks, lectures, posters, slide outlines | audience fit, concise slide structure, source/export when possible |
| `education` | tutorials, courses, lessons, exercises, quizzes | learner level, objectives, examples, exercises and answers |
| `design` | product specs, engineering designs, architecture decisions | goals, constraints, tradeoffs, decision record, verification criteria |
| `website` | landing pages, dashboards, static sites, frontends | intentional visual design, responsive preview, screenshots/artifacts |
| `app` | web/desktop/mobile/local apps, full-stack prototypes | coherent architecture, build/preview/install check, durable demo |
| `android` | Android Gradle/Kotlin/Java apps, emulator/device checks | SDK/adb inspection, build/test/install/launch/screenshot |
| `python` | Python packages, scripts, analysis, CLIs | pyproject/requirements, focused checks, cache hygiene |
| `node` | JS/TS packages, React/Vite/Next/Express, CLIs | package manager detection, scripts/tests, lockfile discipline |
| `c-cpp` | C/C++/CMake/Make, native debugging | out-of-tree builds, compiler/test output, sanitizer if available |
| `r-stan` | R, Stan, statistics, reproducible reports | project-local libs, Rscript/CmdStan checks, plots/reports |
| `word` | docx editing/conversion, Office workflows | preserve originals, converter evidence, verify output exists |
| `image` | raster images, covers, posters, illustration assets | prompt quality, manifest, durable image path, canvas preview |
| `github` | status, branches, pull, merge, rebase, commit, push, gh PRs | status/diff first, fast-forward preference, stop on conflicts/divergence |
| `shell` | shell scripts, diagnostics, automation | read-only diagnosis, bash syntax/check, reversible scripts |
| `maintenance` | system/software install, env repair, package/toolchain issues | safe mode awareness, no sudo hangs, manual command on permission blockers |
| `aaps` | AAPS project conventions and automation files | inspect .aaps conventions, document assumptions, avoid secrets |
| `supervision` | monitor another agent/session, recursive training | external evidence, flaw taxonomy, durable AgInTiFlow upgrades |

## Skill Coverage Targets

| Skill | Why it exists |
| --- | --- |
| `code` | baseline inspect-patch-test loop |
| `code-review` | review mindset without accidental edits |
| `qa-testing` | failure reproduction and regression discipline |
| `data-analysis` | reproducible data and report artifacts |
| `docs-knowledge` | source-backed docs instead of invented docs |
| `database` | schema/migration/data-loss guardrails |
| `devops-deployment` | runtime and setup work without unsafe host mutation |
| `security-review` | secret hygiene and real-risk prioritization |
| `presentation-slides` | deck/poster structure and export habits |
| `writing-editing` | long-form and editing workflows |
| `education-tutorial` | lesson/exercise structure |
| Domain skills | Android, LaTeX, Word, R/Stan, C/C++, website, image, AAPS, GitHub, shell, tmux, supervision |

## Supervised Homework Strategy

Run one hard homework per major family under `~/ProjectsLFS/Aginti-Test/`.
Each task should use realistic, imperfect user prompts so Auto and profile
skills must infer the right workflow.

1. Seed a project with realistic files, mistakes, and ambiguity.
2. Start AgInTiFlow in a persistent tmux session from the task folder.
3. Give a normal prompt, not a full solution recipe.
4. Monitor pane output and `.sessions/<id>/events.jsonl`.
5. Verify results externally: files, command output, git, screenshots, PDFs,
   plots, docs, app launches, or PR metadata.
6. If it fails, patch AgInTiFlow's profile, skill, tool, policy, UI, or tests.
7. Resume the same student session and let AgInTiFlow finish.
8. Record the example under `aginti-work-examples/`.

## Next Homework Queue

| Order | Folder | Profile focus | Stress prompt |
| --- | --- | --- | --- |
| 1 | `TASK-Profile-Code` | `auto` + `code` + `qa` | "this repo has some bugs; make it good and leave it clean" |
| 2 | `TASK-Profile-Large-Codebase` | `large-codebase` | "a feature broke across packages; find and fix it" |
| 3 | `TASK-Profile-Github` | `github` | "pull latest, commit my work, and push if safe" |
| 4 | `TASK-Profile-Data` | `data` | "these CSVs are messy; produce useful analysis and a report" |
| 5 | `TASK-Profile-Docs` | `docs` | "make the docs useful for a new user" |
| 6 | `TASK-Profile-Website` | `website` + `design` | "make a beautiful website from this rough idea" |
| 7 | `TASK-Profile-Paper` | `paper` + `latex` | "write a short manuscript with a figure and PDF" |
| 8 | `TASK-Profile-Maintenance` | `maintenance` + `devops` + `shell` | "this tool won't run; diagnose and fix safely" |
| 9 | `TASK-Profile-Security` | `security` | "review this small app for risky mistakes" |
| 10 | `TASK-Profile-Writing` | `writing` + `word` + `slides` | "turn these notes into polished deliverables" |
