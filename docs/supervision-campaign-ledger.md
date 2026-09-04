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

### Established media-chain reuse and permission boundaries

`media-chain-readiness-020` passed after reconciling a stale machine-ledger
`running` row with the retained session's terminal `session.finished` event.
AgInTi inspected the existing Musia, LabCanvas, LALACHAN, Xiaoyunque, and
LazyEdit entry points and produced `media-routine-readiness.md` without
generating media, starting or focusing a browser, uploading, copying to
Nutstore, creating a remote job, or publishing.

The independent acceptance contract verified every required source-grounded
entry, 16 read-only command results, zero forbidden external-action tools, and
zero long jobs. The resulting contract keeps four permissions independent:
reviewed-song generation, music-video generation, LazyEdit processing, and
public platform publication. An earlier stage or old context cannot authorize a
later irreversible stage.

### Retained dependencies, linked-worktree commits, and clean visual evidence

`data-analysis-retained-dependencies-060` resumed the original DeepSeek session
after an imperfect data-analysis repair had narrowed its context too far. The
agent retained the immutable configuration and CSV inputs referenced by the
mutable Python source, regenerated every required output, ran the canonical
producer and all four unit tests, inspected the 900 x 600 plot, and committed
target revision `55cadcd` from Docker workspace mode. Independent verification
confirmed 11 raw rows, one duplicate removal, two invalid-signal removals,
eight clean rows, the expected condition means, valid CSV/JSON/Markdown/PNG
artifacts, and a clean target worktree.

The run established three reusable runtime contracts:

- Failed-test recovery keeps bounded, previously read immutable dependencies
  when the mutable source names them, while mutation scope remains limited to
  the canonical repair paths.
- An outstanding exact producer or validation command runs before artifact Git
  completion. In a linked worktree, only bounded Git mutation commands receive
  a writable mount for the validated shared Git common directory.
- `read_image` stores its task-relative review copy under ignored `.aginti/`
  runtime storage, so visual verification cannot dirty a completed repository.

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

### Fresh current-turn command evidence on retained sessions

`security-labshare-035` exercised a long-lived LocalLLM security-repair
session after the target repository was already fixed, committed, and clean.
The follow-up prompt deliberately asked the agent not to edit or recommit. It
required only the exact hidden verifier and `git status --short`, while allowing
all other passing implementation and unit-test evidence to remain reusable.

Installed AgInTiFlow `0.20.250` incorrectly finished after `inspect_project`.
It reused the old verifier/status evidence and never executed either command in
the current turn. The defect was not model quality: the runtime had failed to
turn explicit commands in a concrete same-task interruption into a fresh,
revision-bound evidence obligation.

The runtime now records explicit current-turn commands in the active execution
contract and creates a fresh command batch for only that subset. Unrelated
passing evidence from the unchanged mutation revision remains valid, while old
runs of the newly requested commands cannot pre-complete the batch. Inline
command extraction also recognizes natural `verify`, `validate`, `check`,
`confirm`, and rerun wording in English and Chinese.

The same real session was replayed against the patched source at goal revision
`34`. Its event ledger records both commands under
`required-command-batch-3`: the exact external security contract returned
`security_labshare_contract: PASS`, and `git status --short` returned empty.
The target stayed at commit `2b35928` with no mutation. Focused planning,
truthful-completion, and dynamic-budget regressions pass, as does the complete
AgInTiFlow npm suite. The fix is released in AgInTiFlow `0.20.251`.

### Exact source recovery after context loss

`database-migration-049` repeated an imperfect SQLite repair task against a
fresh broken workspace. Automatic routing selected only `qa-testing` and
`database`, but the first run read the canonical source immediately before
proactive context compaction. The compacted model correctly requested that
source again; the retained failed-test read budget exposed a different file,
so two safe but schema-invalid reads stopped the session without dispatch.

AgInTiFlow now treats proactive compaction, local context-window recovery,
model-timeout compaction, and same-task continuation as bounded context-loss
boundaries. A current failed-test packet may reopen only its evidence-derived
production repair paths after such a boundary. Tests, broad discovery,
arbitrary commands, and unrelated writes remain closed. Once the exact source
is read in the new context, the ordinary mutation and verification gates apply.

The original session resumed against the patched runtime, repaired the
transactional schema migration, preserved IDs and tags on URL updates, made
punctuation search literal, added regression coverage, passed four unit tests,
and committed a clean tree at `b956470`. The independent migration-safety
contract also passed. The complete npm suite passes, and the runtime fix is
released in AgInTiFlow `0.20.291`.

### Explicit test evidence and security-review completion

`security-labshare-050` asked a fresh DeepSeek Pro session to harden a small
standard-library laboratory service from an imperfect, outcome-level prompt.
The agent removed a default credential, bounded artifact and dataset paths,
kept export execution shell-free, redacted audit credentials, protected the
public status response, added focused tests, and committed a clean repair. The
hidden acceptance contract then exposed a remaining audit-log injection path:
newlines in an actor or artifact field could forge additional physical records.

During the retained-session repair, AgInTi fixed the production source but
committed it before adding the explicitly requested regression test. This was a
runtime contract defect, not a model-quality failure. The mutation parser did
not recognize contextual requests such as "add a regression test," and the SCS
evidence contract did not convert "run the tests" into a fresh test obligation.
Consequently, source and Git evidence could satisfy the phase too early.

AgInTiFlow now recognizes explicit English and Chinese test-file mutations,
requires fresh test evidence for explicit run/rerun-test requests, and keeps
task-owned commit completion closed until that evidence exists. The regression
suite reproduces the stale persisted contract and proves no commit is offered
after source mutation but before a fresh passing test. It avoids broad keyword
matching, so phrases such as "create a canvas preview for this smoke test" do
not invent a test-file mutation.

The same release accepts genuinely observational Git evidence when no
consequential Git action is required, permits only the exact bounded Python
cache-cleanup forms used by project hygiene, and treats masked values such as
`token=***` as safe status evidence without weakening detection of real
credential assignments. The security-review skill now covers control-character
log injection and requires a standalone note to distinguish deployment
boundary, threat model, controls, residual risks, non-goals, and verification.

The retained session completed `SECURITY.md` after a valid secret-content
block, passed the exact hidden contract and all 13 visible tests, and left a
clean target repository at `ef3c099`. Focused regressions and the complete npm
suite pass. These runtime and skill fixes are released in AgInTiFlow
`0.20.292`.

### Retained storage live authority poisoning

`retained-storage-live-poison-047` exercised the native integration storage
authority after independent audit addenda, using a dictated but realistic
operator prompt. The defect was an AgInTiFlow core integration-storage
authority gap: live retained handles and named bindings were mostly checked,
but the public limitation record omitted the generic `resolveBeneath:false`
fact, and protected file success paths could return after cleanup awaits
without one final permanent-poison check.

The storage authority now reports `procfsRequired:true`,
`resolveBeneath:false`, and `noXdev:false` truthfully across retained
directory/file/lock limitation records. Live retained owner, mode, fstat, and
named-binding divergence remains `INTEGRATION_STORAGE_POISONED`, not an
availability failure, and protected read/write/sync paths check permanent
poison again immediately before returning success.

External verification used the module-mocked retained-storage smoke for live
fstat, owner, mode, named-binding, concurrent poison, close/admission, cleanup,
and residual-FD adversaries. Retained durable-common, retained file-lock,
production-mount, integration authorities, runtime authority,
session-persistence, syntax, and whitespace checks passed on the working tree.

### Authoritative read-only routine first

`authoritative-readonly-routine-001` reproduced the LabCanvas status failure
from sessions `web-agent-labcanvas-cb6fe7cd-3464-42f7-99e4-b24c376e0115` and
`web-agent-labcanvas-6d0b04bc-79e8-4fd8-87b4-4d8e651dcd72`. The first session
had no selected routine and spent 25 model requests and 23 tools on broad
workspace/private-store exploration. The second session received a disclosed
canonical read-only routine, but AgInTiFlow still kept
`requiredProjectCommands` empty, then continued through 32 model requests and
32 tools after the status snapshot.

The defect was an AgInTiFlow core execution-contract/SCS handoff gap, with a
separate upstream routine-disclosure improvement already handled by
AgenticApp. AgInTiFlow now promotes an authoritative read-only routine's first
safe command into the exact required command batch, records an observed
nonzero status snapshot as read-only evidence instead of a failed verifier,
retains forbidden raw/private evidence scopes, and closes the following turn to
`finish` once normal SCS evidence is sufficient.

The focused regression uses a weak status prompt and a project-neutral
`sample-status` routine. It proves the first model turn sees only the exact
status command plus `finish`, a JSON status command exiting 1 still satisfies
the read-only evidence contract, the second turn is finish-only, and no
private/raw exploratory command is dispatched. `npm run smoke:progressive-tools`,
`npm run smoke:scs-evidence`, `npm run smoke:truthful-completion`, and
`npm run check` pass on the working tree.

Fresh compact retest `web-agent-labcanvas-2ebe5aef-83c8-4134-abcd-bec630a4ecb9`
reduced the flow to 6 model requests and 5 tool starts and used the canonical
compact status command, but both valid `finish` calls were rejected because the
human-facing status said `Still retrying: echomind_daily_pdf` and named a
`next attempt`. That was still an AgInTiFlow core completion-semantic defect:
the validator treated an observed external retry state as the agent promising
unfinished work. The completion predicate now rejects pending work only when it
is tied to the current task/report/validation/change or an agent-promised
future action. Read-only status answers may truthfully report external
pending/retrying/next-attempt state after sufficient evidence exists.

Installed retest `web-agent-labcanvas-5e6eb6b6-fb8d-419d-a549-aa4098252064`
then proved the next core gap. AgInTiFlow ran the same canonical compact
health command exactly once and avoided raw/private exploration, but the
finish-only verified-completion turns kept returning empty content and no tool
calls with `finishReason=length` at the inherited 768-token output cap. After
the bounded empty-response repair was exhausted, the runtime emitted the
generic verified fallback `Evidence: command` instead of summarizing the
authoritative JSON status snapshot.

That defect is still AgInTiFlow core completion-loop behavior, not AgenticApp
or a WeChat-specific routine. Verified-completion turns now have their own
final-answer output floor and explicit finish-only instruction. If a provider
still returns empty final responses after verified evidence exists, the
fallback derives a concise public answer from the successful bounded command
output. JSON status snapshots summarize visible delivered/retrying schedule
states, ingress reachability, queue counts, and top-level health while keeping
the original SCS checks for genuinely unfinished agent work.

### Retained tmux Git completion evidence

`labcanvas-mix2s-recovery-review-061` exposed a restart boundary in supervised
project work. The retained AgInTi session had sent a marked commit command to a
project-owned tmux pane, captured the canonical successful commit output, and
left the target worktree clean at `90d61bb`. SCS still rejected completion
after resume because the durable event ledger did not reconstruct that tmux
sequence as a consequential Git action.

AgInTiFlow now binds an explicit uppercase start marker and requested Git
action to the exact tmux target, accepts a commit only when the same pane later
contains canonical commit output plus a zero exit marker, and preserves the
tail of truncated captures. Restart reconciliation replays the ordered
`tool.started`, successful `tmux_send_keys`, and successful same-pane capture
events to recover goal- and mutation-revision-scoped evidence. Failed sends,
wrong panes, stale markers, and nonzero exits remain rejected.

The real retained session then finished without repeating the commit or any
external side effect. The complete npm suite, focused evidence regressions, and
registry installation passed. The fix is released as AgInTiFlow `0.20.301`.

### Context-complete document repair and semantic validation

Memo retests `082` through `084` exercised a retained LocalLLM document task
against a realistic mixed-language chat history. The task required a compiled
PDF, faithful current-state reconciliation, and a committed artifact. The
campaign exposed three independent AgInTiFlow runtime gaps rather than a
LabCanvas-specific routing problem.

In `082`, the TeX compiler repeatedly identified one exact line containing an
unescaped underscore. After several valid repairs, the provider ignored the
remaining narrow patch schema and attempted to replace the whole document.
AgInTiFlow now derives the mechanically safe replacement from the compiler
diagnostic and current source, constrains the trusted patch contract to that
replacement, and can recover an invalid broad model patch into the exact
evidence-derived edit. The recovery is limited to one active
revision-bound producer diagnostic and cannot generalize into an arbitrary
rewrite.

In `083`, the provider repaired a quality defect by deleting the remainder of
the TeX document. Patch anchoring now recognizes LaTeX section boundaries and
binds a defect to its containing section. A replacement is rejected when it
changes the net balance of revision-bound LaTeX environments, preventing a
local list repair from dropping later sections or environment terminators.

In `084`, the provider produced and committed a syntactically valid PDF that
described the document-generation process but omitted the substantive source
topics. Document validation now extracts bounded salient topic anchors from a
complete-context source and requires representative coverage when the request
explicitly asks for complete, reconciled, or context-complete output. It also
preserves unverified source status, rejects contradictory completion claims,
validates LaTeX source structure, and keeps decimal measurements such as
`0.25 mm` intact during status parsing.

The release also preserves requested artifact and project contracts across
compaction, replays failed requested PDF producers without repeating successful
side effects, retains exact compiler lines through bounded retries, rejects
append-only repairs when replacement is required, and caps repair schemas so a
small local model receives only the actionable tool surface. Focused coding,
truthful-completion, writing-routing, progressive-tool, document-quality, and
dynamic-budget suites pass. These fixes are prepared for AgInTiFlow `0.20.302`.

### Host-scoped deliverables without false source mutation

LabCanvas research run `browser-agent-stale-ui-research-085` showed that
DeepSeek had already completed current web research and written valid task
artifacts, but AgInTiFlow rejected `finish` because every file-producing task
inherited a fresh project-source mutation requirement. The artifact directory
was intentionally excluded from project mutation accounting, so the runtime
could never satisfy its own gate and eventually reached the step limit.

The runtime now distinguishes a requested deliverable inside the host-owned
artifact root from a requested source-code change. Reports, notes, PDFs,
figures, CAD, presentations, and similar scoped outputs may complete from their
verified artifact evidence without fabricating a repository edit. A request to
fix, implement, or modify project source still requires a fresh project
mutation, even when it also asks for a sidecar report.

Fresh LabCanvas retest `browser-agent-stale-ui-research-086` used the same
imperfect prompt and a new persistent AgInTi session. It recovered a malformed
DeepSeek tool call, ran web research, wrote and registered two substantial
Markdown artifacts with current primary-source citations, separated
demonstrated evidence from inferred recommendations, and finished normally.
The retained trace contains no completion-evidence rejection or forced
source-mutation loop. Focused completion, evidence, progressive-tool, runtime,
and dynamic-budget suites plus the full npm suite pass for `0.20.303`.

### Response-only context compaction after provider handoff

`response-only-context-handoff-092` exercises a high-risk continuation boundary
for DeepSeek-first operation with LocalLLM fallback. Recent same-session
response-only evidence showed DeepSeek quota failures followed by LocalLLM
resume attempts that failed before inference because the retained transcript
exceeded the LocalLLM context window. Normal agent-step requests already had a
local context-budget compaction retry, but the explicit response-only branch
called the direct-response client without that recovery path.

AgInTiFlow now catches only `LOCALLLM_CONTEXT_BUDGET_EXCEEDED` in the
response-only branch, compacts the authoritative retained goal/evidence once,
persists `model.local_context_budget_exceeded` and
`history.compacted_for_local_context_retry`, and retries the same response-only
request with a bounded output reserve. The source-free evidence guard remains
active after compaction, so unsupported publication, validation, forecast,
benchmark, or metric claims still retry once and then fail closed.

The focused regression seeds a DeepSeek-owned response-only session, inflates
retained same-session context, resumes with a normal "answer from the saved
status" prompt, triggers a DeepSeek quota handoff, and verifies that LocalLLM is
called only after compaction. The run completes without `session.failed`, keeps
the provider handoff active on the same session, and records the compaction
events as durable evidence.

### Harmless tool-call annotations during repository discovery

`inspect-project-annotation-093` covers a DeepSeek-first tool-loop boundary
that was still under-tested after the provider handoff work. Recent runtime
evidence showed ordinary project-inspection tasks stopping with
`tool_contract_violation` before dispatch because the model included a
non-executable `reason` field in an otherwise valid `inspect_project` call.
The strict per-turn schema correctly rejected unknown executable fields, but
the existing benign-annotation normalizer only recognized `description`.

AgInTiFlow now treats a bounded string `reason` exactly like `description`: it
is removed before schema validation only when the offered tool schema forbids
additional properties and the schema does not define that field. Structured,
non-string, oversized, or executable unknown fields still fail closed.

The regression uses a normal weak prompt asking the agent to look over a small
repository and report whether a README exists. The scripted DeepSeek-shaped
response calls `inspect_project` with `reason` plus a real `limit`; the persisted
runtime dispatches the inspection, records zero tool-contract failures, and
finishes with the verified README status without mutating the workspace.

### Native tmux recovery from generic shell aliases

`tmux-run-command-native-recovery-094` covers a reusable coordination-tool
handoff gap seen in recent retained runtime evidence. A normal supervision
prompt selected the host tmux tool bundle, but the provider tried the native
tool name `tmux_list_sessions` and later `tmux list-sessions` through
`run_command`. AgInTiFlow treated those as generic shell commands, producing a
host permission pause or shell failure instead of using the already offered
native tmux listing tool.

The runtime now auto-corrects only exact read-only tmux session-list aliases
from `run_command` to `tmux_list_sessions` before shell guardrails run. It
records `tool.auto_corrected`, preserves the original requested tool in
`tool.started`, dispatches no generic shell command, and leaves arbitrary tmux
startup/send/mutation shell commands blocked by the existing permission policy.
The focused persisted-runtime regression verifies both exact aliases and the
negative mutating command case; the tmux guardrail, progressive-tool,
provider-handoff, syntax, package-audit, dry-pack, and full npm suites pass.

### Model-safe Docker failure evidence

`labcanvas-model-safe-docker-failure-100` was derived from retained production
session `web-agent-labcanvas-968d0e66-a494-40fd-b2f7-0290c687a4ea`. DeepSeek
first failed with `402 Insufficient Balance`, then the same session resumed on
LocalLLM and preserved its goal, plan, artifact paths, and tool evidence. The
local context guard also behaved correctly: each oversized request was reduced
from roughly 26K-57K message tokens to 8K-12K before retry. Context compaction
was therefore not the defect.

The actual failure boundary was a sandboxed LaTeX command that exited nonzero
without writing native stderr. Node's raw child-process exception embedded the
complete internal `docker run` invocation, mounts, environment setup, and
wrapped shell in the model-visible `run_command` result. LocalLLM copied that
runtime implementation detail into its next tool call, where the secret-path
guard correctly blocked it and stopped the otherwise recoverable document run.

AgInTiFlow now normalizes only failed sandbox command exceptions at the Docker
boundary. The model and public event stream retain the real exit code, command
stdout, native stderr when present, and a concise fallback when stderr is
empty; they no longer receive the Docker wrapper. The raw redacted exception
remains available only in the bounded private sandbox diagnostic ring. This
keeps audit evidence useful while preventing smaller fallback models from
replaying container internals as user commands.

Deterministic regressions cover empty-stderr and compiler-stderr failures. A
real toolchain-container check confirms that a failing command reports exit
code `1` without exposing `docker run`, sandbox environment variables, or
internal mount paths. Syntax, LocalLLM nested failure recovery, DeepSeek to
LocalLLM provider handoff, coding tools, Docker command, and Docker toolchain
checks pass.

### Response-only router JSON is not a forecast

`labcanvas-response-router-project-label-101` came from retained production
session `web-agent-labcanvas-a5159676-c87c-4aad-b1a6-3ef3cd7cf8c1`. The task
was a response-only LabCanvas route classification for two WeChat article
cards. DeepSeek failed before inference with `402 Insufficient Balance`, and
LocalLLM returned a structurally valid routing JSON object. AgInTiFlow then
rejected it as an unsupported forecast because the source-free claim matcher
treated the ordinary JSON key-value pair `"project": "labcanvas"` as the verb
"project" in a prediction. Its bounded repair received another valid project
label and failed closed, suppressing the worker route entirely.

The forecast matcher now excludes the bare ambiguous noun `project` while
continuing to detect `projects`, `projected`, `projection`, predictions,
forecasts, expected growth, CAGR, and the existing Chinese and Japanese
forecast forms. This also prevents ordinary prose such as "the project" from
being mislabeled without weakening actual projection checks.

The matcher regression uses the production-shaped router JSON and a positive
unsupported forecast sentence. The end-to-end provider-handoff regression
forces DeepSeek `402`, returns the router JSON from LocalLLM, and verifies that
the exact JSON finishes unchanged after one fallback request with no
`response_only.source_free_claim_rejected` event. Truthful-completion,
provider-handoff, and syntax checks pass.

### Host-owned document compilation remains outside the fallback model

`labcanvas-host-document-handoff-102` came from retained production session
`web-agent-labcanvas-e654a5b9-6486-4718-b8fd-c76f1c05626e`. Its task packet
required AgInTi to revise a task-local Markdown or TeX source and explicitly
forbade compiler invocation because the LabCanvas host would compile and
revalidate the PDF in the same completion cycle. The narrowed evidence scope
still contained the earlier user-facing PDF request, however, so AgInTi's
generic completion contract discarded the later host-ownership directive and
continued to require a PDF from the fallback model.

After writing the report source, LocalLLM could not pass the contradictory
completion gate. It repeatedly sent the same Markdown file to canvas through
58 steps instead of returning control to the host compiler. The retained trace
therefore demonstrated a contract-layer defect rather than missing research,
context loss, or a need to weaken evidence checks.

Host compilation ownership is now derived from the complete runtime contract,
while factual source and artifact scope remain narrowed to the exact task. An
unconditional paired contract that prohibits agent-side compilers and assigns
build/validation to the host removes PDF from the agent-owned deliverables and
requires one fresh reader-facing Markdown or TeX source instead. Conditional
fallback wording still leaves ordinary PDF production agent-owned. A declared
artifact root is now an exclusive evidence boundary, and private routine
contracts or delivery notes cannot impersonate the reader-facing source.

The production-shaped regression proves that the explicit host directive
survives `AGINTI_EVIDENCE_SCOPE_JSON`, a private routine note is insufficient,
a real scoped report source satisfies the handoff, and ordinary or conditional
PDF workflows retain their existing contracts.

### Unchanged canvas artifacts are delivered once per goal revision

`labcanvas-canvas-delivery-idempotency-103` follows the same retained LabCanvas
session, `web-agent-labcanvas-e654a5b9-6486-4718-b8fd-c76f1c05626e`, after the
host-compilation contract defect had pushed LocalLLM into a weak convergence
loop. The event ledger contains 52 successful `send_to_canvas` calls and 52
`canvas.item` events for the exact same task-local `report.md`, with no finish
event. Cosmetic title changes generated another durable artifact copy and were
credited as progress, so the ordinary no-progress guard could never converge.

Canvas dispatch now keeps a bounded revision-scoped delivery ledger. Its
identity includes the normalized workspace path, file bytes and SHA-256,
renderer kind, and selection intent; inline artifacts use their content hash.
Changing a title or note cannot resend an unchanged artifact. A duplicate
returns a successful skipped result that points the model toward `finish`, emits
one diagnostic suppression event, creates no copied artifact, and does not
advance the stagnation epoch. A changed file remains deliverable because its
content fingerprint changes, and a later user goal revision gets an independent
delivery scope.

The end-to-end scripted model regression reads and delivers one report, retries
the same bytes under a different title, receives the completion redirect, then
observes a host-side file revision and successfully delivers those new bytes.
It asserts two substantive canvas items, one suppression, two persisted files,
and no false progress credit for the duplicate.

### Local context recovery retains its successful output lane

`labcanvas-local-context-output-adaptation-104` was derived from retained
production sessions rather than a synthetic large-prompt guess. Session
`web-agent-labcanvas-e654a5b9-6486-4718-b8fd-c76f1c05626e` recorded 56
`model.local_context_budget_exceeded` events in 58 steps, while the longer
`web-agent-labcanvas-3ff222ef-af1c-4301-8799-4c6ca71368d2` history recorded 183
such events across 291 requests. Each retry could compact successfully, but the
next turn restored the implicit 8192-token output reserve and rediscovered the
same envelope limit.

AgInTiFlow now records whether `maxOutputTokens` came from an operator or from
the LocalLLM default. After an implicit-cap context overflow, the successful
4096-token retry lane is retained in private session state and reused by later
agent steps and response-only continuations with the same context window. The
saved runtime configuration remains unchanged, hosted providers are unaffected,
and an explicit operator cap remains authoritative.

The regressions cover a context overflow followed by a nested timeout and model
route change, all subsequent full-agent requests, an explicit 8192-token cap,
and a second response-only continuation whose near-limit history would overflow
again without the retained lane. The second continuation makes one bounded
request and the event ledger remains at one context-overflow recovery. The full
`npm test` gate passes.

### Explicit response-only JSON contracts are checked before completion

`labcanvas-response-only-json-contract-105` comes from retained production
session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`. After a
DeepSeek `402` handoff, a completion-auditor turn explicitly required an object
with `covered_item_ids`, `missing`, `legitimate_blocker`, `complexity`, and
`summary`. LocalLLM instead copied the nested candidate object with `message`,
`confirmation`, and artifact fields. It was valid nonempty JSON and made no
unsupported factual claim, so the response-only lane incorrectly recorded a
successful finish.

Response-only execution now derives a shallow contract only when the
authoritative prompt contains an explicit `Return JSON ...:` instruction
followed by a valid object example. It requires one parseable JSON object with
the example's top-level keys and value types. It does not infer schemas from
ordinary prose, hard-code LabCanvas fields, or inspect arbitrary nested task
payloads. A mismatch receives one bounded repair instruction naming only the
expected key types. A second mismatch stops without `session.finished`, so the
host can retain and retry the task instead of accepting the wrong protocol.

The provider-handoff regression reproduces the wrong nested candidate object,
repairs it to the outer audit contract, and separately proves the fail-closed
path. Existing plain-text, router, source-free-claim, and context-recovery
response-only paths remain covered.

### Requested falsifiable predictions remain useful without becoming evidence

`labcanvas-source-free-falsifiable-prediction-106` comes from retained
production session `web-agent-labcanvas-acfafa25-d3c5-4a4e-9e12-1813973211a2`.
The response-only LabAgent prompt explicitly requested one evidence-aware
inspiration point, an actionable experiment, and clearly falsifiable 3-, 5-,
and 10-year predictions. It did not ask the fallback model to claim a source or
present the predictions as established facts. After the DeepSeek quota
handoff, however, the source-free claim guard rejected every LocalLLM answer
that contained a forecast. Bounded repair eventually removed the useful task
content and returned unrelated generic career advice.

When the authoritative request explicitly asks for it, source-free
response-only execution now distinguishes an assistant's own clearly labeled
hypothesis or prediction from a forecast attributed to a
report, paper, study, source, company, or authority. The exception remains
narrow: a speculation label cannot legalize claimed validation, external
evidence, citations, publications, benchmarks, or asserted quantitative
results. The repair prompt explains the same boundary in multilingual terms
instead of prohibiting all forecasts even when the authoritative task requires
one. An unsolicited model-added prediction remains rejected.

Regressions cover English guidance, Chinese and Japanese falsifiable
predictions, attributed Chinese forecasts, and a prediction label that attempts
to conceal unsupported validation and accuracy claims. The production-shaped
provider handoff forces DeepSeek `402`, accepts the requested LocalLLM
prediction in one fallback request, emits no source-free rejection, and records
one terminal finish.
