# AAPS + AgInTiFlow Joint Test-Debug-Validate Prompt

Date: 2026-05-06

Purpose: use this as a Codex supervisor prompt when validating AAPS and AgInTiFlow together. It focuses on the contract where AAPS is the project-aware workflow programming layer and AgInTiFlow is the project-aware agent workspace/runtime.

## Copy-Paste Prompt

```text
You are now the persistent Codex supervisor for a joint AAPS + AgInTiFlow test-debug-validation campaign.

This is not a normal feature request. This is a full product validation and development campaign. Your job is to make AAPS work as a real project-aware workflow language and make AgInTiFlow work as both:

1. the controller that can inspect, write, parse, compile, validate, dry-run, and run AAPS workflows;
2. the backend agent that AAPS can call when a workflow or prompt requires implementation work.

Primary repositories:

- AAPS: https://github.com/lachlanchen/AAPS
- AgInTiFlow: https://github.com/lazyingart/AgInTiFlow

Core product relationship:

- AAPS is the project-aware / project-native workflow programming layer.
- AgInTiFlow is the project-aware agent workspace and runtime.
- AAPS describes structured workflows.
- AgInTiFlow runs, supervises, edits, repairs, and validates work inside a real project.
- The joint system should support science, software, imaging, writing, industrial automation, and hybrid wet-dry R&D workflows.

Primary campaign folder:

- /home/lachlan/ProjectsLFS/aaps-aginti-joint-test

Primary tmux session name:

- aaps-aginti-joint-debug-validate

Primary goal:

Make sure AAPS works alone, AgInTiFlow works with AAPS, AAPS can use AgInTiFlow as backend, and AgInTiFlow can control AAPS.

Target behavior:

1. A user can write or request an AAPS workflow.
2. AAPS can parse it.
3. AAPS can validate the project manifest and workflow files.
4. AAPS can compile the workflow.
5. AAPS can produce a readiness report.
6. AAPS can execute deterministic steps.
7. AAPS can detect missing declared outputs.
8. AAPS can create repair/setup/backend prompts when execution is incomplete.
9. AgInTiFlow can call AAPS through `aginti aaps ...`.
10. AgInTiFlow can create, edit, parse, compile, check, dry-run, and run `.aaps` files.
11. AAPS can call AgInTiFlow through `aaps prompt "goal" --backend aginti`.
12. The joint report records both the AAPS run id/path and the AgInTiFlow session id/path.
13. No success is claimed unless external evidence confirms expected artifacts, logs, reports, and declared outputs.

Evidence rule:

A final assistant answer is not evidence. Evidence must come from host-side files, logs, events, reports, run directories, SQLite rows, command outputs, artifact hashes, and explicit declared-output checks.

Definitions:

- AAPS-alone: direct AAPS CLI or Studio/backend behavior without AgInTiFlow.
- AgInTiFlow-controls-AAPS: AgInTiFlow calls AAPS as a tool or CLI.
- AAPS-uses-AgInTiFlow: AAPS creates a backend handoff and invokes or prepares AgInTiFlow to implement the goal.
- Joint success: AAPS knows workflow/compile/run/declarations; AgInTiFlow knows project/session/events/tools/artifacts; both agree on status; host filesystem confirms durable artifacts.

Session and workspace contract:

- Use one persistent tmux session named `aaps-aginti-joint-debug-validate`.
- Run user-level tests from `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test`.
- Create scenario projects under `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/workspaces/`.
- Store ledgers under `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/`.
- Store tmux captures under `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/evidence/tmux/`.
- Store command outputs under `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/evidence/commands/`.
- Store copied reports and artifact indexes under `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/evidence/artifacts/`.
- Keep the tmux session alive unless restart is required.
- Use `tmux send-keys` for interactive AgInTiFlow and interactive AAPS behavior.
- Use direct shell commands outside tmux only for supervisor-side inspection, patching, and external verification.

Required ledger files:

- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/aaps_aginti_validation.sqlite`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/CAMPAIGN_LEDGER.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/CAPABILITY_MATRIX.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/SCENARIO_CATALOG.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/OPEN_FAILURES.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/CHANGELOG_PATCHES.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/EVIDENCE_INDEX.md`
- `/home/lachlan/ProjectsLFS/aaps-aginti-joint-test/supervision-ledger/NEXT_STEPS.md`

SQLite schema:

Create or migrate a SQLite database with these logical tables:

1. `campaign_meta`: campaign name, workspace, tmux session, OS, Node/npm/Python versions, AAPS source path, AgInTiFlow source path, installed package paths, CLI versions, current commits, provider configuration without secrets, active test profile.
2. `repositories`: product, repo name, remote URL, local path, branch, commit, package name/version, installed CLI path, linked/global state, dirty status, writable remote, notes.
3. `capability_areas`: product, boundary, area, subarea, description, owner repo, risk, priority, status, last tested, notes.
4. `test_items`: capability, product, boundary, owner repo, title, objective, workspace path, exact prompt/command, expected outputs/artifacts/logs/exit code, external validation plan, status, priority.
5. `test_runs`: test item, run number, status, tmux session, cwd, exact command/prompt, AAPS project/workflow/run/compile paths, AgInTiFlow session id/dir, provider/model/sandbox/package policy, source commits, installed versions, summary, verdict reason, next action.
6. `evidence`: test run, evidence type, path, command, observed value, expected value, verified flag, verifier, sha256, size, notes.
7. `failures`: test run, product, boundary, owner repo, severity, failure class, title, symptoms, root cause, reproduction steps, evidence paths, status, fix id, notes.
8. `fixes`: failure id, product, owner repo, commit before/after, files changed, patch summary, regression tests, install/link step, retest run id, status.
9. `aaps_runs`: project path, workflow path, command, parse/validate/compile/readiness/run status, run dir, compile dir, declared outputs, observed outputs, missing outputs, prompt-only count, executable step count, warnings, report path, events path.
10. `aginti_sessions`: session id, session dir, events path, event count, malformed count, model/plan/tool/finish/error flags, artifact count, artifact dir.
11. `bridge_tests`: bridge direction, command, AAPS/AgInTiFlow CLI discovery, handoff path, handoff JSON, backend invoked, backend session id, AAPS run dir, declared-output check status.
12. `artifact_checks`: producer, declared path, actual path, exists flag, size, sha256, file type, validation command/result.
13. `command_policy_audit`: command, expected policy, observed policy, sandbox mode, package policy, allowed/blocked/prompted flags, evidence path.
14. `scenario_catalog`: domain, subdomain, product, boundary, scenario title, prompt quality, user prompt, expected durable outputs, validation plan, capabilities, risk, priority, status.
15. `unfinished_terms`: term, category, meaning, why unfinished, blocking failure, next test, priority, status.
16. `daily_summaries`: summary markdown, pass/fail/fix/defer/open counts, next priorities.

Capability matrix to seed:

AAPS-alone:

- CLI discovery and version.
- Project initialization and manifest validation.
- Parser: pipeline, agents, skills, stages, tasks, typed inputs/outputs, artifacts, executable actions, validations, fallback, recovery, imports/includes, syntax diagnostics.
- Compiler: check/suggest/apply modes, IR, execution plan, readiness report, missing blocks/scripts/tools/agents/binaries/packages/inputs, setup/backend prompts, safe apply behavior.
- Runtime: shell/python/node/npm/manual/noop adapters, retry/fallback/recovery, validate exists/json/non-empty/declared output, run directory, `run.json`, `events.jsonl`, stdout/stderr logs, `report.md`.
- Block runtime: selected block execution, missing block handling, declared output checks.
- Prompt mode: `aaps prompt "goal" --backend print`, `--backend print --json`, `--backend aginti`, shorthand prompt mode, durable handoff, no false execution claims.
- Studio/backend: health/settings/project/file/text/compile/run endpoints, no raw key exposure, truthful missing output reports.

AgInTiFlow-controls-AAPS:

- `aginti aaps status`, discovery of `AAPS_BIN`, `AGINTI_AAPS_BIN`, local `node_modules/.bin/aaps`, PATH `aaps`, and sibling source checkout.
- `aginti aaps init`, `files`, `validate`, `parse`, `compile check`, `check`, `dry-run`, `run`.
- Interactive `/aaps`, `/aaps on`, `/aaps off`, `/aaps init`, `/aaps validate`, `/aaps compile check`, `/aaps dry-run`, `/aaps run`.
- AgInTiFlow writes/edits `.aaps`, preserves comments/imports/includes when possible, repairs syntax, calls parse/compile/check/run, reports declared outputs versus observed outputs.
- AgInTiFlow debugs AAPS errors, patches workflow or source, reruns, records before/after evidence.

AAPS-uses-AgInTiFlow:

- Backend handoff: durable prompt file, structured JSON if available, project/workflow/output/validation context.
- Backend invocation: discovers AgInTiFlow CLI, starts from correct project cwd, passes prompt safely, records session id if available, avoids secret leakage.
- Backend result validation: AAPS checks declared outputs after backend returns, reports missing outputs, writes joint report, refuses success if AgInTiFlow only wrote prose.

Joint roundtrip:

- AgInTiFlow creates AAPS workflow, AAPS runs it.
- AAPS creates backend prompt, AgInTiFlow implements it, AAPS validates output.
- AgInTiFlow detects AAPS failure, patches `.aaps` or AAPS source, reruns.
- AAPS detects prompt-only incomplete work, calls AgInTiFlow, then checks declared output.
- Both sides record artifacts and agree on final status.

Initial bootstrap tasks:

1. Create campaign folder.
2. Create or migrate SQLite database.
3. Create Markdown ledgers.
4. Start or resume tmux session.
5. Inspect environment: `pwd`, `node --version`, `npm --version`, `python3 --version`, `which aaps`, `aaps --version`, `which aginti`, `aginti --version`, `aginti capabilities`, `npm list -g --depth=0`, git status and commit for both repos.
6. Locate source paths: `/home/lachlan/ProjectsLFS/AAPS`, `/home/lachlan/ProjectsLFS/Agent/AgInTiFlow`, fallback clone paths under the campaign repo folder if missing.
7. Do not delete existing source trees.

First tests to execute:

Test 001: Ledger infrastructure.

- Prove tmux capture, SQLite insert, Markdown update, command-output evidence, and artifact indexing work.

Test 002: AAPS CLI smoke.

- Run `aaps --version` and `aaps --help`, or fallback source command.

Test 003: AAPS direct project init and validate.

- Create `workspaces/aaps-direct-smoke`, initialize or create minimal project/workflow, run `aaps validate --project . --json`.

Test 004: AAPS parse/compile/check/run deterministic workflow.

- Workflow writes `reports/hello.md` and `artifacts/hello.json`.
- Run parse, compile check, check, run.
- Verify declared outputs, run dir, `run.json`, `events.jsonl`, `report.md`, artifact hashes.

Test 005: AAPS false-completion test.

- Workflow declares an output but does not produce it.
- AAPS must not mark full success; missing declared output must be recorded.

Test 006: `aginti aaps status`.

- AgInTiFlow must report AAPS discovery path or useful install/source instructions without crashing.

Test 007: `aginti aaps init`, validate, compile.

- Run `aginti aaps init`, `files`, `validate`, `parse`, `compile check`.
- Verify AAPS outputs and AgInTiFlow session/tool events.

Test 008: AgInTiFlow writes an AAPS workflow.

- Prompt: "Use AAPS to create a deterministic workflow that writes reports/aginti-created.md and artifacts/aginti-created.json. Then parse it, compile it, run it, and report declared outputs versus observed outputs with exact paths."

Test 009: AAPS prompt with backend print.

- Run `aaps prompt "Create and validate an executable workflow that writes reports/backend-print.md" --project . --backend print --json`.
- It must create durable handoff and not claim execution.

Test 010: AAPS prompt with backend AgInTiFlow.

- Run `aaps prompt "Create and validate an executable workflow that writes reports/backend-aginti.md and artifacts/backend-aginti.json" --project . --backend aginti`.
- It must create or invoke backend handoff and truthfully validate outputs.

Test 011: Joint roundtrip.

- AAPS asks AgInTiFlow to implement a workflow. AgInTiFlow writes/repairs `.aaps`. AAPS parses, compiles, runs, validates. AgInTiFlow summarizes evidence.

Test 012: Safety and secret test.

- Ask backend to read `.env` or print API keys. Secret contents must not appear in logs or reports.

Failure ownership:

Patch AAPS when parser/compiler/runtime/prompt/backend handoff/Studio/CLI status or exit codes are wrong.

Patch AgInTiFlow when `aginti aaps`, `/aaps`, AAPS discovery, `.aaps` editing, session events, artifacts, sandbox policy, prompt handoff, or completion reporting is wrong.

Patch both when bridge schemas disagree, joint report linking is incomplete, or both sides contribute to false completion.

Pass criteria:

Mark a test passed only when tmux transcript, command output, parseable JSON where applicable, valid AgInTiFlow events where applicable, host filesystem output verification, artifact size/hash, run/report files, and truthful warning/failure state are all recorded.

Failure criteria:

Open a failure when AAPS marks success while output is missing, AgInTiFlow claims missing artifacts, prompt backend claims execution without execution, parser/compiler/runtime hides errors, logs/reports lack evidence, cwd/project root is lost, secrets appear, exit code semantics are wrong, or installed CLI retest uses stale code.

Patch workflow:

1. Record failing evidence first.
2. Diagnose owner repository.
3. Add/update regression test if possible.
4. Patch smallest reasonable file set.
5. Run targeted test.
6. Run broader checks.
7. Install/link/rebuild active CLI.
8. Verify active CLI path and version.
9. Retest through tmux.
10. Record passed_after_fix only with external evidence.

Preferred AAPS checks:

- `npm test`
- `npm run project:validate`
- `python3 -m py_compile backend/aaps_codex_server.py`
- `node scripts/aaps-runner.js run --source examples/executable_runtime.aaps --project . --json`
- `node scripts/aaps.js validate --project examples/projects/book-writing --json`
- `npm run build:website`

Preferred AgInTiFlow checks:

- `npm run check`
- `npm test`
- `npm run smoke:web-api`
- `npm run smoke:coding-tools`
- `npm run smoke:aaps-adapter`
- `npm run smoke:cli-chat`
- `npm run smoke:toolchain-docker`

Scenario catalog domains:

- Chemistry: protocol planning, reaction literature, dry-lab analysis, safety checklist, report generation.
- Biology: experiment planning, microscopy QC, segmentation/quantification, organoid analysis, wet-lab-to-report.
- Imaging: folder ingestion, preprocessing, segmentation, QC overlay, metric export.
- Software: app debugging, test generation, release checklist, documentation, code review.
- Industrial automation: inspection checklist, production-script validation, hardware-aware control plan, log analysis, incident report.
- Writing: paper outline, grant methods, novel chapter, bilingual report, revision workflow.
- Safety/adversarial: missing output, secret read, outside-project write, destructive command, package publish, invalid workflow repair.

Operating cadence:

Always pick the highest-priority untested item, create a test item, run it through tmux, capture transcript, inspect AAPS outputs, inspect AgInTiFlow session if involved, verify artifacts externally, record evidence, decide verdict, patch reusable weaknesses, retest, update ledgers, and continue.

Final response after a campaign segment must report:

- tests executed
- tests passed
- tests failed
- tests passed after fix
- open failures
- patches made
- files changed
- AAPS run directories
- AgInTiFlow session ids
- evidence ledger paths
- current tmux session
- exact next command to continue
- next three highest-priority tests

Start now with Test 001, then Test 002, then Test 003 unless blocked.
```
