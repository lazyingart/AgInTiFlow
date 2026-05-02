# Supervised Capability Curriculum

AgInTiFlow should be trained and verified by supervising real tasks, not by trusting the agent's final summary. Each curriculum run uses a clean project under `../Supervise-AgInTi-Projects`, runs AgInTiFlow through a persistent tmux session, and verifies artifacts from outside the agent.

## Verification Contract

Every supervised task must end with independent checks:

- Inspect `git status --short`.
- Verify output files exist with `test -s`, `ls -lh`, `file`, or a domain-specific checker.
- Read `.sessions/<session-id>/events.jsonl` for actual tool calls when claims matter.
- For screenshots, PDFs, images, APKs, reports, and archives, keep a durable workspace path unless the user explicitly requested only a temporary preview.
- Commit intentional project changes or explicitly report why the worktree is not clean.

## Task Families

| Profile | Example supervised task | Required evidence |
| --- | --- | --- |
| `auto` | Mixed request: inspect folder, write a note, run a safe command | Correct profile inference, real file, concise final answer |
| `code` | Add a CLI feature with tests | Patch diff, focused test output, git status |
| `large-codebase` | Fix a cross-file bug in a generated multi-package repo | Codebase map, targeted reads, focused then broader checks |
| `app` | Build a small usable app from scratch | Real app files, build/preview/install check, durable screenshot or demo |
| `website` | Build a polished landing page or dashboard | Preview works, screenshots/artifacts saved, responsive layout |
| `node` | Build/test a Node or TypeScript package | package manager detected, script/test output |
| `python` | Write a package/script/notebook-style analysis | Python check/test, output artifact if generated |
| `c-cpp` | Build a small CMake/Make project and fix a compiler error | Compiler output, binary/test result |
| `r-stan` | Run a reproducible R/Stan/statistics analysis | Rscript/CmdStan evidence, saved plot/report |
| `android` | Build, install, launch, screenshot an Android app | Gradle build/test, adb install/launch, durable screenshot |
| `latex` | Write and compile a paper/report | `.tex` source, PDF, compile log/pass evidence |
| `paper` | Draft a research manuscript with sources and figures | Outline/source notes, manuscript file, figure/PDF when available |
| `research` | Research a current technical topic | Source list, dated notes, clear evidence/inference split |
| `writing` | Write a structured article/script | Durable draft file, outline/revision notes |
| `book` | Plan and draft a chapter | Chapter map, chapter file, continuity notes |
| `novel` | Draft a scene/chapter with character continuity | Story bible or continuity notes, chapter file |
| `design` | Produce an engineering/product design doc | Options/tradeoffs, decision, verification criteria |
| `image` | Generate an image with GRS AI or Venice | Manifest, generated image path, canvas preview |
| `word` | Create/convert/edit a `.docx` style document | Input backup, output file, converter/tool evidence |
| `github` | Commit/push/open PR or fix CI | status/diff first, gh/git output, conflict handling |
| `shell` | Write and run a maintenance script | read-only diagnosis first, script syntax/check output |
| `maintenance` | Diagnose/fix an environment/toolchain/system issue | evidence log, reversible commands, no silent host mutation |
| `aaps` | Work with AAPS project conventions | `.aaps`/project files inspected, assumptions documented |

## Supervision Loop

1. Start or reuse a named tmux session in the supervised project.
2. Give AgInTiFlow a normal user-level task, not a full implementation recipe.
3. Poll the pane and session events until it finishes, blocks, or loops.
4. If a reusable capability is missing, patch AgInTiFlow itself: profile, skill, tool, policy, prompt, UI, docs, or tests.
5. Publish/install the updated AgInTiFlow build when possible, resume the same session, and ask it to continue.
6. Record the result, missing capability, fix, and verification evidence.

## Workspace Layout

Future supervised homework should live under `~/ProjectsLFS/Aginti-Test/`:

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

Durable example records should be copied into the AgInTiFlow repo under `aginti-work-examples/`.

## Recursive Supervision

The `supervision` profile and `supervision-student` skill are for training AgInTiFlow to be a better supervisor, not only a better worker. In recursive supervision:

1. A student AgInTiFlow session performs a real task.
2. A supervisor AgInTiFlow session monitors the student, verifies artifacts, and records flaws.
3. Codex supervises the supervisor, checking whether it used evidence rather than belief.
4. Repeated misses become AgInTiFlow upgrades.

Use this only with explicit workspace boundaries and clear permission mode. The supervisor may request code/tool/profile improvements, but should not silently mutate unrelated projects.

## Current Lesson From Android Supervision

Canvas preview alone is not proof that an artifact was saved. AgInTiFlow now persists canvas file paths into session artifacts and its Android workflow asks for durable screenshot paths. Supervisors must still verify the workspace file or session artifact exists before reporting success.
