# Thorough Test, Debug, And Validate Prompt

This reference preserves the working supervision prompt pattern for deep AgInTiFlow validation.

## Purpose

Use this prompt when Codex should supervise AgInTiFlow through a persistent tmux session, force real end-to-end tests, maintain an auditable database, patch AgInTiFlow when reusable failures appear, publish/install the fix, and then retest in the same campaign.

The important behavior is not "write better prompts for the student." The important behavior is:

- Define a real task AgInTiFlow should be able to finish alone.
- Drive it through tmux as a normal user would.
- Monitor intermediate state, not only the final answer.
- Verify artifacts, logs, events, screenshots, files, installs, commits, and reports externally.
- Record every test item and capability in a durable database.
- Patch AgInTiFlow itself when the failure is reusable product weakness.
- Publish/install the fixed version when the active CLI must use the fix.
- Resume or continue the same supervised campaign and retest.

## Canonical Prompt

```text
btw, you can also update current codex skill on this kind of fix test debug validate our aginti. makemake this skill works better

could you do the test that didn't do before and maintain a database for each test item.

one test is basics test and also test that are designed to finish a task

could you do a through debug and test in a tmux session? aginti-thorough-debug-and-test

i wish you check each settings and command and logic and function and capability one by one in the tmux session and check if it will work? and if cannot work then fix and retest in the same tmux session? and use send keys to make the tmux session always there and test in '/home/lachlan/ProjectsLFS/aginti-test' folder and do a very deep and complete test?

i wish your test be complete and thorough and make sure all current designed feautres work. and no need use mock test you can use the true deepseek, we are rich and you can use it to finish each test/task

i wish your test be very heavy and complete

you main the database to detail record the test history and the unfinished terms and finished terms and also the problem every detailes in detail that as detailed as possible.

i wish you define a task, test and debug, record and fix the code and then do next

do very deep plz and also consider what did before and what to do next

plz make the test very real and send keys to the tmux session and always test in that session

and for one session you can send msgs several time and the task is to finish the task that aginti suppose can finish. we find the problems of aginti in its skills, tools, logic flaws

continue previous debug test and focus on fix all the implementation

you can focus on these parts not test and debug or valided before in the database you maintained

plz make the database exhaustive to contain all the parts of the aginti app and all the problems and all its designed capabilities and you validate these designed capabilities are fully implemented and capable.

could you organize different tasks that aginti should finish and accomplish alone in the database and test debug and validate it if it can finish the task? like all common programming and text work and research, life, work entertainment from science tech to liberal and arts and art and music and drawing and play games and travel and all other things that in this world that you can think of and maintain this database and we validate one by one
```

## AAPS Joint-Test Extension

```text
and for aaps could you also debug and test aaps

i mean you do joint test on both side

that make sure aaps also work

and you might introduce a aaps-cli mode for aaps

and also like aginti you can do aaps 'prompt directly'

and also possible introduce aginti as backend of aaps

so aaps can use aginti as backend, aginti can edit and parse and compile aaps
```

## Supervisor Operating Contract

When this prompt is active, Codex should:

1. Use one persistent tmux session for the validation campaign.
2. Keep a machine-readable SQLite ledger with capability areas, test items, events, fixes, and broad future task scenarios.
3. Also keep a human-readable ledger with current counts, passed/fixed/failed/deferred items, exact AgInTiFlow versions, session ids, and evidence paths.
4. Treat a final assistant message as untrusted until externally verified.
5. Inspect central session events under `~/.agintiflow/sessions/<session-id>/events.jsonl`.
6. Verify file outputs with host filesystem checks.
7. Verify canvas artifacts by checking durable session artifact paths.
8. Verify command-policy behavior from event logs, not only prose.
9. Verify package policy with block, prompt, and allow modes.
10. Verify AAPS at both boundaries: AgInTiFlow adapter behavior and AAPS's own CLI/runtime behavior.
11. Patch AgInTiFlow when its runtime, prompts, tools, skills, policies, docs, or CLI UX cause a reusable failure.
12. Patch AAPS when its CLI/runtime/backend behavior is the owner of the joint failure.
13. Add regression checks where possible before publishing.
14. Publish/install AgInTiFlow when the supervised tmux session must retest the installed CLI.
15. Continue with the next untested or highest-risk capability after closing the current test.

## Pass Criteria

A test should only be marked `passed` or `passed_after_fix` when:

- The tmux transcript shows the user-level command or prompt.
- The central session log shows the model/provider/profile, plan, tool calls, tool results, and finish state.
- Expected files or artifacts exist at durable paths.
- The report does not simply repeat the model's claim; it includes evidence.
- External verification confirms the artifact, command result, or policy state.
- Any known caveat is recorded in both the SQLite ledger and human ledger.

## Failure Criteria

Record a failure when:

- AgInTiFlow hangs, loops, or silently drops queued input.
- It claims a file, screenshot, PDF, app install, commit, report, or workflow output exists but the host cannot find it.
- It bypasses a permission policy instead of stopping with a useful remedy.
- It refuses without a clear rerun command or approval path when the operation is allowed with stronger trust.
- It leaks token-like text into reports or artifacts.
- It edits unrelated files.
- It overwrites existing files without explicit instruction.
- It logs invalid tool-call history or triggers provider `400` errors.
- It marks prompt-only AAPS handoff as completed task output.
- AAPS validates/compiles/runs successfully at engine level while declared task outputs are missing and unreported.

## Task Scenario Catalog Guidance

The validation database should contain not only product features but also real-world task scenarios AgInTiFlow should eventually complete alone. Include programming, writing, research, design, life/work planning, art/music/image, travel, games, security, system maintenance, GitHub operations, data analysis, and long-form document production.

Each scenario should include:

- Domain and subdomain.
- Profile to exercise.
- Prompt quality (`weak`, `normal`, `ambiguous`, or `adversarial`).
- User-level prompt.
- Expected durable outputs.
- External validation plan.
- Current status.

This keeps future testing systematic instead of depending on memory or ad hoc prompts.
