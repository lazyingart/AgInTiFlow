# Supervision Campaign Ledger

Continuous AgInTiFlow validation uses a SQLite ledger instead of relying on a
chat transcript. The ledger records capability coverage, realistic scenarios,
individual test runs, runtime events, reusable fixes, versions, session IDs,
tmux ownership, and external evidence.

Initialize a campaign:

```bash
node scripts/supervision-ledger.js init \
  --db /path/to/campaign.sqlite \
  --campaign general-capability \
  --objective "Make AgInTiFlow fast, robust, and generally capable" \
  --aginti-version "$(node -p \"require('./package.json').version\")"
```

Register coverage before testing:

```bash
node scripts/supervision-ledger.js capability \
  --db /path/to/campaign.sqlite --campaign general-capability \
  --id media-chain --domain media --subdomain music-video-publish \
  --description "Reuse Musia, LALACHAN, and LazyEdit without rebuilding them" \
  --priority 90

node scripts/supervision-ledger.js scenario \
  --db /path/to/campaign.sqlite --campaign general-capability \
  --id media-chain-readiness --domain media --profile auto \
  --prompt-quality normal \
  --prompt "Inspect the established media chain without generating or publishing." \
  --expected-outputs '["media-routine-readiness.md"]' \
  --validation "Verify exact routine paths, command help, artifact bytes, and zero external writes."
```

Create, start, and finish a concrete run with `test`, `start`, `event`, and
`finish`. Record a reusable product change with `fix`. Every command is an
idempotent or append-only SQLite operation suitable for a persistent tmux
campaign.

Test registration validates that any named capability and scenario belong to
the same campaign. Finishing a test updates the test, capability, and scenario
status in one SQLite transaction, so a typo cannot silently leave the campaign
matrix stale or split across contradictory states.

Inspect current coverage:

```bash
node scripts/supervision-ledger.js status \
  --db /path/to/campaign.sqlite --campaign general-capability
```

Do not mark a test passed from the agent's prose. Verify session events, files,
checks, external state, and side-effect boundaries first, then store those paths
in `evidence_json` and `events`.

## Current Campaign Findings

### Data analysis retained-state recovery

`data-analysis-local-011` passed after reusable runtime fixes. AgInTi completed
the mixed sensor-export project, repaired its own unclosed CSV handles, created
commits `2f79553` and `3317a59`, and resumed the same durable session after a
control-loop pause. Independent validation ran both the unit suite and the
canonical generator with `ResourceWarning` promoted to an error; all tests,
audit counts, condition means, plot bytes, and clean-git checks passed.

The incident established two general contracts:

- A canonical command wrapped only by an explicit exit-status probe, such as
  `python analysis.py; echo "EXIT=$?"`, is valid evidence when the captured
  status is zero. Arbitrary semicolon chains remain invalid because a later
  command can hide an earlier failure.
- User-facing artifacts keep canonical workspace paths but receive a readable
  canvas/download filename derived from the task title and source purpose.
  Internal collision identifiers are short suffixes, never the leading or only
  visible filename information.

### QA repair continuity and evidence intent

`qa-incident-metrics-001` passed after two reusable runtime fixes. A normal,
underspecified QA prompt led the DeepSeek-backed agent to reproduce and diagnose
compound-duration parsing, percentile interpolation/mutation, and deterministic
summary-order defects. The first partial patch advanced the mutation revision,
but the runtime then forgot the retained failing test and prematurely reduced
the tool surface to test-only mode. Source-next restored the failed-test repair
state until a fresh current-revision test passed, allowing the same durable
session to finish the coherent patch, add regressions, run 15 tests at 100%
statement coverage, clean debris, and commit `667891f`.

Independent `pytest` and the hidden `qa_incident_metrics_contract.py` checker
both passed. The run also exposed an evidence-intent false positive: `figure
out` and `clean up generated test debris` were interpreted as a request for a
canvas artifact. Evidence inference now excludes those non-production phrases
while retaining the artifact gate for real generated figures. Exact session
evidence remains in
`~/.agintiflow/sessions/aginti-qa-incident-metrics-001/events.jsonl` and the
machine ledger records the run as `passed_after_fix`.

### GitHub maintenance hidden acceptance and goal-scoped evidence

`github-safe-maintenance-012` started from a normal maintenance prompt rather
than a checker-shaped instruction. The agent repaired and verified the target,
but its first completion omitted the exact `docs/maintenance-handoff.md` file
required by independent acceptance. The same retained session inspected the
external failure, created the missing handoff, committed and pushed target
commit `36fa6c0`, and left `main` clean and synchronized. The hidden
`github_maintenance_contract.py` checker then passed.

Supervision of the repair exposed four runtime defects that could affect other
profiles:

- A test command wrapped as `command; echo "EXIT:$?"` could have shell exit zero
  even when the real command failed. Explicit final `EXIT`, `STATUS`, or
  `RESULT` probes are now parsed; a missing or nonzero marker is failing
  evidence.
- A genuinely new continuation could inherit completed artifact, SCS,
  project-verification, and repair state from the prior goal. New goals now
  clear only goal-scoped execution evidence while preserving conversation,
  durable goal history, and goal-keyed research memory.
- An acceptance sentence listing screenshots, PDFs, reports, or app launches
  "as appropriate" could force irrelevant visual work. Optional evidence
  examples no longer become mandatory categories.
- Merely naming a read-only checker such as `contract.py` could force a file
  artifact. File evidence now requires both mutation intent and a workspace
  file/source target; a virtual canvas artifact remains artifact evidence only.

The patched source resumed `aginti-github-maintenance-001`, invoked the hidden
checker exactly once, performed no file, canvas, commit, or push side effect,
and completed with a clean repository-state check. The full npm suite and the
focused dynamic-budget, SCS/model-role, and web-canvas regressions pass for
AgInTiFlow `0.20.213`.

### Java repair, permission pause, and durable artifact evidence

`java-event-window-013` passed after exposing two runtime defects with a normal,
underspecified Java repair prompt. DeepSeek correctly implemented decimal
duration parsing, non-mutating percentile interpolation, deterministic window
summaries, project guidance, and generated-output ignores. The first run then
encountered a host permission blocker while invoking the checked-in test script.
The runtime continued spending model and SCS turns instead of persisting a
single actionable pause. After trusted-host approval, loose artifact inference
also treated a generated test transcript as a mandatory deliverable, prompting
the agent to create and commit an unrequested `docs/test-results.txt`.

Permission advice that cannot auto-recover now stops the run immediately with
durable resume data. Approval is single-use, and a resolved blocker cannot be
replayed by a stale web request. Same-task continuation still preserves the
original goal when an approval sentence precedes the continuation instruction.
Artifact evidence from commands is accepted only when it names a supported,
existing, nonempty path; removed files and label-only prose no longer satisfy
completion. Exclusion language such as "ignore generated build and session
outputs" no longer invents an artifact requirement.

The queued correction was applied to the same live session, the stray transcript
commit was removed, and the intended repair remains at target commit `f2792f3`.
Independent verification passed the checked-in Java test script, the hidden
event-window contract, generated-output tracking checks, clean-worktree checks,
the focused permission/evidence regressions, and the complete AgInTiFlow npm
suite.

### Long-context memo synthesis and local visual verification

`memo-full-context-pdf-014` used a normal, short writing prompt against a
realistic interrupted chat export containing corrections, cancellations,
deadlines, dependencies, completed work, publication boundaries, research
ideas, and personal errands. The DeepSeek-backed writing agent read the full
history and produced an editable two-page XeLaTeX/PDF memo instead of copying
transport rows. Independent acceptance checked every critical commitment,
rejected raw timestamps and internal identifiers, verified the PDF structure,
and required a clean intentional commit.

The first draft generalized a concrete Nutstore private-backup destination and
left generated agent/perception directories unignored. The same durable session
accepted those exact external findings, restored the actionable destination,
added narrow generated-state ignores, rebuilt the PDF, inspected both rendered
pages, and committed the correction as `a275878`. The hidden full-context
checker, `qpdf`, `pdfinfo`, extracted-text review, independent page renders, and
clean-worktree check then passed.

The visual-review turn exposed a reusable provider-boundary defect: automatic
`read_image` was blocked merely because DeepSeek was the active reasoning
provider, even though the configured local image-perception handoff was safe
and the perception runtime already supported it. Guardrails now allow the
DeepSeek-to-LocalLLM handoff when local perception is enabled, continue to block
hosted vision without explicit authorization, and block all automatic vision
when both local and hosted routes are disabled. A focused regression covers the
guard and the actual LocalLLM client route.

### SQLite migration and literal-query safety

`database-migration-safety-015` passed on AgInTiFlow `0.20.215` from a normal,
imperfect maintenance prompt. The DeepSeek-backed database profile diagnosed a
destructive version-1 migration, `INSERT OR REPLACE` identity loss, and unsafe
`LIKE` semantics. In one retained session it replaced the migration with an
in-place transaction, preserved item IDs, tags, and relationships, used an
identity-preserving UPSERT, escaped `%`, `_`, and backslashes as literal search
text, added regression tests, and committed target repair `fb97fbd`.

The run also exercised recovery behavior without a supervisor rescue prompt.
DeepSeek initially requested too many tools in one turn; the contract guard
rejected that batch and the next turn continued with allowed calls. Later, a
noncanonical `TEST_EXIT:0` shell suffix confused project-test evidence despite
five passing tests. The agent recognized the discrepancy, reran the canonical
README command, obtained `passed:true`, cleaned transient Python artifacts, and
finished normally. No AgInTiFlow product patch was required for this scenario.

Independent acceptance used
`supervision/acceptance/database_migration_safety_contract.py` to verify legacy
IDs `7`, `12`, and `19`, tag relationships, schema columns, foreign keys,
idempotent reopening, stable URL updates, literal punctuation, archive
filtering, absence of destructive SQL, intentional commit history, and a clean
worktree. The hidden contract passed.

### Shell grammar, mutation revision, and output provenance hardening

The next campaign phase exercised completion evidence under realistic compound
commands, multiline acceptance criteria, delegated test runners, Git workflows,
and pre-existing output files. The reusable repair centralizes shell
canonicalization, command classification, Git-action intent, and evidence
tracking instead of adding project- or prompt-specific branches. In particular,
escaped line continuations and heredocs are parsed structurally; read-only test
evidence is separated from write capability; later mutations invalidate stale
validation; commit, pull-request, tag, and push evidence must occur in the
requested order; and exact output files count only when the current required
generator created or changed them.

Five independent review rounds found and drove regressions for inline mutation
batches, stale opaque validators, Git grammar and ordering, zero-test runners,
external executable paths, arithmetic shifts mistaken for heredocs, multiline
command substitutions, stale exact outputs, and ambiguous Git nouns such as
"commit message" or "branch diagram". A final fresh hosted Codex review was
blocked by its rolling quota and the DeepSeek review route was blocked by
provider balance. A separate read-only `localllm-deep` review completed with no
actionable findings. The full `npm test` suite, focused dynamic-step-budget,
coding-tools, SCS-evidence, and syntax checks all pass before packaging
AgInTiFlow `0.20.216`.

### Same-session interruption convergence and bounded completion

The `context-interruption-016` campaign exercised a long retained DeepSeek
session with multiple concrete interruptions, source corrections, an exact
external acceptance command, and a final clean-repository requirement. The
agent owned every target edit and commit. Early recovery turns repeatedly read
the same already-correct diff, showing that token limits alone do not guarantee
convergence while the available action surface remains open ended.

The reusable repair is driven by runtime state and evidence rather than task
literals. Mutations invalidate stale tests and prior completion evidence;
same-task interruptions refresh per-turn acceptance while retaining durable
evidence; repository-state recovery derives task-owned paths since the latest
successful commit and offers a bounded `commit_project_changes` action; and
the runtime constructs the path-scoped Git command. A current-revision exact
validator creates a one-use completion candidate. The following turn compacts
the evidence and exposes only `finish`; rejection or mutation invalidates the
candidate.

The final live continuation converged in three turns: bounded commit, exact
validator, and truthful finish. The target ended clean at commit `bd74bbd`.
Repository-repair context compacted from 156,716 to 5,788 characters, and the
verified-completion context compacted from 23,658 to 5,157 characters.

An independent read-only DeepSeek review then drove three general fixes: a
dedicated task-owned commit-path validator that supports binary,
extensionless, and instruction files while rejecting protected paths;
platform-aware POSIX and Windows command quoting; and recognition of bounded
stdin `sed -n` pipelines as read-only inspection. Production code contains no
campaign scenario IDs, target paths, expected prose, commit IDs, or acceptance
literals.
