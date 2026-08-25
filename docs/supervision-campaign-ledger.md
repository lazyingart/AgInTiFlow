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

### Live inbox requirement coalescing

The next installed-release run tested actual mid-turn input rather than a
sequence of explicit resume commands. A DeepSeek task started from a normal
repository-writing request. While its first model call was active, two
independent corrections were appended through `aginti queue`. Both received
distinct durable inbox IDs and were applied exactly once at the first safe tool
boundary, before the source note was read.

AgInTiFlow `0.20.217` retained both corrections through later context
compaction, produced one concise artifact, removed every superseded value,
preserved the source note, added only narrowly scoped runtime ignore rules,
committed the intentional files, and left the target repository clean. An
external semantic and repository-state contract passed at target commit
`f19ff4b`. No AgInTiFlow source change or task-specific prompt branch was
needed; the run validates the generic inbox, context, evidence, and completion
contracts in the published package.

### LabCanvas least-privilege worker integration

`labcanvas-worker-permission-018` validated the installed AgInTiFlow `0.20.217`
through LabCanvas after a real WeCom research task paused at
`permission_required`. The defect was in the integration boundary: LabCanvas
unconditionally selected AgInTi's blocked package-install tier, which also
blocked ordinary workspace shell execution. LabCanvas now keeps response-only
roles blocked while granting genuine worker roles reversible package setup
inside the Docker workspace. Host access, credentials, payment, publication,
destructive operations, and other irreversible actions remain separately
guarded.

A direct DeepSeek-backed worker smoke created and validated a bounded workspace
artifact without a permission prompt. Focused backend regressions, all WeChat
self-checks, the complete 1,442-test LabCanvas suite, and GitHub Actions passed.
The originally blocked exact-chat task was then resumed without duplicate model
work, produced a visually inspected nine-page XeLaTeX research report, and
delivered one concise message plus the PDF through the verified WeCom transport.
The follow-up message was preserved in the same chat session. The reusable fix
is AgenticApp commit `e705bb0`; no AgInTiFlow release change was required.

### Durable background-job recovery after foreground interruption

`long-job-recovery-019` exercised installed AgInTiFlow `0.20.217` with a normal
laboratory-export request whose terminal could disconnect. The DeepSeek-backed
agent inspected the checked-in resumable scripts, rejected duplicate execution,
and selected the generic `start_long_job` routine. The campaign interrupted only
the foreground AgInTi pane after durable admission; the independent job tmux
continued, completed eight delayed batches, ran deferred verification, and
cleaned up its own tmux session.

The same AgInTi session then resumed from retained state. It recovered the exact
job ID through `long_job_status`, independently reran the project verifier,
confirmed the artifact and checksum, and finished without calling
`start_long_job` again. Proactive context compaction reduced the resumed history
from 190,805 to 30,680 characters while preserving the job identity and original
task boundary.

The independent acceptance contract verified one process invocation, one durable
job directory, attempt `1`, command and verifier exit `0`, the required durable
event sequence, a project handoff with exact status and verification commands,
and no lingering job tmux session. No source patch or npm release was needed;
this run validates the published package's general long-job, resume, context,
deduplication, and cleanup contracts without task-specific routing.

### Host-managed response roles and permission integrity

`permission-resilient-synthesis-030` traced a real LabCanvas career-report
failure to the integration boundary rather than weakening AgInTiFlow's
permission guard. LabCanvas invoked the host-managed report under the role
`career_research`, while its response-only classifier recognized only the older
`career_daily` alias. The model was consequently offered file tools in a safe,
read-only run; when it tried to save its already synthesized report,
AgInTiFlow correctly persisted a `permission_required` pause.

LabCanvas now classifies the full `career-research-*` and
`daily-organizer-*` role families as host-managed response turns. Those turns
use AgInTi's `chatops` profile with shell, file, and auxiliary tools disabled;
the host owns persistence, compilation, quality validation, and delivery.
General worker roles retain their existing writable Docker contract, and safe
mode still blocks genuine unapproved writes.

A fresh installed `0.20.248` DeepSeek run completed the imperfect synthesis
prompt in one model turn. Independent event inspection found zero tool calls,
zero permission events, one normal `session.finished`, a complete 1,893-byte
answer, and no task artifact mutation. This was an AgenticApp integration fix;
no AgInTiFlow runtime or npm release change was required.

### Reader-facing report quality and local editorial routing

`research-pdf-quality-034` exercised a normal scheduled-research packet through
the AgInTi-backed LabCanvas worker. DeepSeek revised an existing local report
into a 17,557-byte Chinese scientific review with nine traceable sources,
source-level methods/results/limitations, cross-source synthesis and tensions,
explicit evidence boundaries, actionable experiments, and references. The
first host compile exposed a nearly empty final page, and the prior agent repair
claimed success without changing the source.

LabCanvas now treats the PDF as a different deliverable from the concise chat
brief. It audits every configured content dimension, keeps orchestration
provenance out of the reader document, extracts text per page, renders private
page previews, rejects orphan pages, retries one conservative compact layout,
rebuilds stale sibling PDFs, and can deterministically adopt a corrected
host-built PDF during stored-result repair. The accepted four-page PDF has
embedded CJK fonts, page body counts `1584, 1988, 1416, 2058`, and no visual or
layout issues. Stored replay covered every task item with no model rerun or
external write.

The scenario also exposed two general AgInTi routing false positives. Explicit
local report paths and existing-document revision language now count as local
workspace intent, so surrounding research policy does not force a new deep
research route. The phrase `page-safe` no longer creates a browser-evidence
requirement. Focused routing/evidence smokes and the full npm suite pass.
