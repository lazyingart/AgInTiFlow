# AgInTiFlow TDV Method Retrospective

This document records what worked in the recent AgInTiFlow and AAPS test-debug-validation cycles. It is intended as a future reference for running similar Codex-supervised TDV campaigns.

TDV means:

- Test real user-facing behavior.
- Debug from external evidence, not model claims.
- Validate the fix through the same user path.
- Develop the product only when the failure is reusable.

## Why The Recent Prompts Worked

The repeated prompts worked because they forced Codex into a product-supervisor role instead of a normal implementation role. The important constraints were:

- Use a persistent tmux session and drive AgInTiFlow like a user.
- Keep a durable SQLite and Markdown ledger.
- Define one concrete task at a time.
- Monitor intermediate state, not only final output.
- Treat agent final answers as untrusted until host-side verification passes.
- Patch the product when the same failure class would affect future users.
- Install or link the patched CLI before retesting.
- Resume the same campaign instead of starting over.
- Record evidence paths, session ids, commits, versions, and next actions.

The prompt was strong because it made success expensive to fake. AgInTiFlow had to produce files, artifacts, logs, reports, events, or visible UI behavior that could be checked outside the agent conversation.

## Actual Campaign Shape

The recent campaign used:

- Primary repo: `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`
- AAPS repo: `/home/lachlan/ProjectsLFS/AAPS`
- Test workspace: `/home/lachlan/ProjectsLFS/aginti-test`
- Persistent tmux session: `aginti-thorough-debug-and-test`
- Evidence ledger: `/home/lachlan/ProjectsLFS/aginti-test/.aginti-thorough-tests/`
- SQLite DB: `/home/lachlan/ProjectsLFS/aginti-test/.aginti-thorough-tests/thorough-debug-and-test.sqlite`
- AgInTiFlow central sessions: `~/.agintiflow/sessions/<session-id>/`

The workflow repeatedly used:

1. Start or resume the tmux session.
2. Send a realistic AgInTiFlow prompt or command.
3. Capture the tmux pane.
4. Locate the AgInTiFlow session id.
5. Inspect central `events.jsonl`.
6. Verify output files and artifacts from the host.
7. Classify the result.
8. Patch AgInTiFlow or AAPS if the failure was reusable.
9. Run targeted regression checks.
10. Install the fixed local package.
11. Retest through tmux.
12. Update the ledger.

## Representative TDV Cycles

### 1. CLI Startup, Help, And Localization

Finding:

- `/help` and localized startup paths exposed untranslated labels, layout overflow, and inconsistent runtime date context.

What fixed it:

- Added missing help translations.
- Added terminal cell-width aware banner/layout handling.
- Injected fresh local and UTC runtime context into both new and resumed sessions.

Why it mattered:

- CLI UX issues are easy to dismiss as cosmetic, but they affect trust. If the app cannot present state and time correctly, users cannot reason about long-running work.

### 2. Resume, Queue, And Session Durability

Finding:

- Resume command parsing could treat runtime flags as prompt text.
- Queued input needed proof that it was not dropped.
- Empty/no-input sessions needed cleanup semantics.

What fixed it:

- Typed resume parsing.
- Cwd-scoped session selection.
- Queue inbox verification through `inbox.jsonl` and `conversation.queued_input_applied` events.
- Empty-session handling and cleanup commands.

Why it mattered:

- Durable sessions are a core product claim. The validation had to prove not only that sessions exist, but that history, queued input, titles, project pointers, and central state remain consistent.

### 3. Tool-Call Ordering And Provider 400 Errors

Finding:

- Blocked tools inside a multi-tool assistant batch could leave unmatched tool calls.
- Loop-guard or SCS messages inserted at the wrong time could break provider message ordering.
- DeepSeek/OpenAI-compatible APIs returned `400 insufficient tool messages`.

What fixed it:

- Short-circuited remaining tool execution while still appending synthetic skipped tool responses for every outstanding `tool_call_id`.
- Deferred loop-guard/SCS user messages until all tool responses were appended.
- Added old-history repair logic for interleaved invalid message sequences.

Why it mattered:

- This was not just a model/provider issue. It was a runtime transcript integrity issue. A robust agent must maintain valid tool-call history even when policy blocks or interrupts execution.

### 4. Permission Policy And tmux Bypass Paths

Finding:

- Command policy correctly blocked some unsafe `run_command` cases, but tmux command text could bypass equivalent guards.
- Outside-host path reads were possible through tmux startup command text.
- Some blocker reports suggested obsolete or unsafe rerun commands.

What fixed it:

- Applied workspace path guards to `tmux_start_session` and `tmux_send_keys`.
- Applied host shell command policy to tmux command text.
- Improved permission advice to include exact supported rerun commands.
- Required dry-run-first wording for destructive operations.

Why it mattered:

- Security policy must be consistent across all tool surfaces. A policy that blocks shell but allows tmux bypass is not a policy.

### 5. Evidence Discipline, Artifacts, And False Completion

Finding:

- Some runs were tempted to trust final answers or ephemeral tmux output.
- AAPS prompt-only workflows could report runtime success while declared outputs were absent.
- Canvas and artifact storage needed central proof, not just project-local files.

What fixed it:

- Required durable log evidence for tmux one-shot claims.
- Verified central canvas copies under `~/.agintiflow/sessions/<session-id>/artifacts/`.
- Added AAPS adapter warnings for prompt-only, non-executable steps.
- Reported declared outputs versus observed outputs.

Why it mattered:

- The strongest TDV rule is: claimed output is not output. Durable output must exist and be externally checked.

### 6. Profile And Command-Policy Real Tasks

Finding:

- Real profile tasks exposed practical gaps that unit tests missed:
  - Android profile needed Gradle/JVM wrapper command allowances.
  - Python profile needed compatibility and testing discipline.
  - Node profile needed package-quality guidance.
  - Data profile needed read-only metadata commands such as `file`, `stat`, and `sha256sum`.
  - R/Stan profile needed no-install blocker behavior when R was absent.

What fixed it:

- Added precise command-policy allowances for safe read-only probes and workspace-local toolchain commands.
- Added profile guidance for expected helper files, tests, reports, and blocker behavior.
- Rebuilt the Docker sandbox image when runtime utilities were missing.

Why it mattered:

- Profiles cannot be validated by documentation alone. They need real weak prompts and real tasks that force tool selection, missing dependency handling, and final evidence quality.

### 7. Markdown Rendering And CLI Transcript Quality

Finding:

- CLI Markdown rendering stripped underscores from filenames in tables, corrupting output like `demo_data_helper.py`.

What fixed it:

- Updated inline Markdown stripping so underscore emphasis only applies at non-word boundaries.
- Added smoke coverage.
- Retested a resumed session to prove the same transcript rendered correctly.

Why it mattered:

- If the CLI corrupts filenames, users cannot copy paths or trust reports. Rendering bugs can become workflow bugs.

### 8. AAPS Joint Behavior

Finding:

- Starter AAPS workflows could validate but fail compile due missing agent registry.
- AAPS handoff text could be ambiguous in Docker workspace mode.
- Prompt-only execution could be mistaken for completed backend work.

What fixed it:

- Created starter agent registry artifacts.
- Clarified Docker-safe `npx` versus host/source fallback routes.
- Added prompt-only warnings and missing-output reporting.
- Added smoke checks around the AgInTiFlow AAPS adapter.

Why it mattered:

- AgInTiFlow and AAPS should reinforce each other. AAPS supplies explicit workflow contracts; AgInTiFlow supplies interactive backend execution. The boundary must be truthful.

## Failure Taxonomy That Emerged

Use these classes in future TDV databases:

- `false_completion`: assistant claimed completion but durable output was missing.
- `transcript_integrity`: provider tool-call history was invalid.
- `policy_inconsistency`: one tool surface blocked while another bypassed.
- `permission_guidance`: task was blocked correctly but the remedy was unclear or wrong.
- `artifact_durability`: output existed only transiently or outside central artifact tracking.
- `profile_gap`: a profile lacked needed commands, skills, tests, or blocker behavior.
- `rendering_integrity`: CLI or web output corrupted meaningful text.
- `session_durability`: resume, queue, title, or pointer state was incomplete.
- `aaps_boundary`: AAPS and AgInTiFlow disagreed about parse, compile, run, or output status.
- `release_install`: source was fixed but the active CLI still used stale installed code.

## What Codex Did Well In The Loop

The successful behavior was not just patching code. The effective loop was:

- Ask AgInTiFlow to do the task with a normal or weak user prompt.
- Avoid over-teaching the student session.
- Watch intermediate behavior.
- Let the failure happen when it was useful.
- Verify externally.
- Patch the product capability, skill, command policy, or runtime logic.
- Retest the same failure class through the same kind of user-facing run.
- Record both the failed and passing evidence.

This matters because it tests whether AgInTiFlow can work for real users, not whether Codex can manually solve the task.

## What To Keep In Future TDV Prompts

Keep these phrases or ideas in future prompts:

- "Do not trust the final answer. Verify from the host."
- "Use tmux and keep the session alive."
- "Record every test item in SQLite and Markdown."
- "Patch only reusable product weaknesses."
- "Retest through the same user path after installing the fix."
- "Use real provider tests when credentials exist."
- "Vary prompt quality: weak, normal, ambiguous, adversarial."
- "If blocked, record the blocker and exact future rerun command."
- "Do not make a pretty report. Make the product more truthful."

## What To Avoid

Avoid these anti-patterns:

- Running only unit tests and calling the product validated.
- Trusting final model prose.
- Giving the student session overly detailed implementation instructions.
- Creating test folders without asking the product to work inside them.
- Fixing the test instead of fixing reusable product behavior.
- Patching many unrelated files at once.
- Publishing before retesting installed behavior.
- Forgetting to record the session id, evidence path, and source commit.

## Future Improvements

The next TDV prompt should push these areas harder:

- Full provider/auth wizard behavior without secret exposure.
- Website/Web UI visual regression and language dropdown checks.
- AAPS large-workflow editing, compile, run, and backend-agent execution.
- SCS on long, failure-prone tasks.
- Auxiliary image generation with artifact durability.
- Storage migration edge cases from old `.sessions` and project pointers into central `~/.agintiflow/sessions`.
- GitHub workflows: fast-forward, non-fast-forward, rebase, PR prep, `gh` command behavior.
- Real installed R/Stan workflows when the toolchain is available.
- Offline/self-contained website generation without external fonts.

## Reference Prompt Files

- Raw original working prompt: `references/effcient-prompts/thorough-test-debug-validate-prompt.md`
- ChatGPT Pro-polished imported prompt: `references/effcient-prompts/test-debug-validate-prompt.md`
- Project-aware repolished prompt: `references/effcient-prompts/agintiflow-aaps-supervision-repolished-prompt.md`

Use the repolished prompt for new campaigns and this retrospective as the method reference.
