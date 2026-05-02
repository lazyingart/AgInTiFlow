---
id: supervision-student
label: Supervision Student Loop
description: Supervise another AgInTiFlow/student agent through tmux or session logs, verify its work independently, and convert failures into durable capability improvements.
triggers:
  - supervision
  - supervise
  - supervisor
  - student agent
  - homework
  - curriculum
  - self supervision
  - train agent
  - tmux monitor
tools:
  - tmux_list_sessions
  - tmux_capture_pane
  - tmux_send_keys
  - tmux_start_session
  - inspect_project
  - search_files
  - read_file
  - apply_patch
  - run_command
  - send_to_canvas
---
# Supervision Student Loop

Use this skill when AgInTiFlow is supervising another agent, a tmux session, or a long-running autonomous task.

## Roles

- The student does the target project work.
- The supervisor gives normal user-level prompts, monitors progress, verifies evidence, and improves reusable capabilities.
- The supervisor should not directly implement the student's target project unless the user explicitly changes the assignment.

## Loop

1. Create or reuse a clean project folder and a named tmux/session id.
2. Give the student a realistic task with imperfect prompting. Do not over-specify every implementation step.
3. Define acceptance criteria before judging: files, build/test output, screenshots, commits, docs, UX, or source evidence.
4. Monitor progress through tmux capture, session events, runtime logs, git status, and artifact lists.
5. Verify the result externally. Do not trust the student's final summary by itself.
6. If the student is blocked by missing reusable capability, improve AgInTiFlow itself: profile, skill, tool, command policy, model prompt, UI, docs, or smoke test.
7. Resume the same student session with the updated AgInTiFlow and ask it to continue.
8. Record the outcome in a homework ledger with evidence, flaws, fixes, and next test.

## Evidence Checklist

- `git status --short` before and after.
- `git diff --stat` or commit log for intended changes.
- Build/test/check output from the actual toolchain.
- Durable output paths for screenshots, images, PDFs, reports, APKs, archives, and generated docs.
- Session `events.jsonl` snippets when tool use or artifact publication matters.
- A short postmortem: what failed, what capability was added, and what to test next.

## Recursive Supervision

When training a supervisor agent, give it a smaller student to supervise. Grade the supervisor on whether it:

- Sets acceptance criteria.
- Gives compact prompts instead of doing the work.
- Verifies artifacts independently.
- Notices loops, false claims, missing files, bad git state, and tool failures.
- Converts recurring failures into reusable improvements.

The goal is not only a better worker. The goal is an agent that can supervise work, discover its own capability gaps, and request or implement durable upgrades.
