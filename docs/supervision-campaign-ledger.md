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

### Internal recovery scaffolding cannot become the task answer

`labcanvas-internal-runtime-scaffold-leak-107` comes from retained production
session `web-agent-labcanvas-b94e75e1-5441-402c-b299-e8b527f386cf`. The task
was a current LabAgent research briefing with reader-facing artifacts. DeepSeek
failed before inference with `402 Insufficient Balance`; the LocalLLM request
then exceeded its context envelope and AgInTi compacted the history from about
71,000 to 13,800 message characters. Instead of continuing the briefing, the
fallback model copied the private recovery packet into its answer: it discussed
runtime compaction, repeated the AgInTi identity instruction, claimed that the
original request was truncated, and asserted that acceptance criteria were
satisfied. Because the task had not yet produced tool evidence, this internal
narrative was nevertheless accepted as `session.finished`.

Completion now checks a candidate against the actual runtime-generated
compaction or constrained-recovery packets retained in that session. It rejects
only high-confidence copying: at least two distinctive narrative markers, one
narrative marker plus a private section heading, or three private headings. A
normal answer after compaction is unaffected, and an explicit user request to
explain or audit context-recovery behavior remains allowed. English, Chinese,
and Japanese marker forms are covered without treating generic words such as
`runtime`, `context`, or `plan` as failures.

The first copied answer is removed from active conversation state and receives
one goal-revision-scoped repair directing the model back to the real task. A
second copied answer stops truthfully without a terminal finish, preserving the
session for another provider. The production-shaped regression forces proactive
compaction, proves recovery to the exact user-facing answer on the next model
turn, and separately proves the repeated-leak fail-closed path. Truthful
completion, context-budget recovery, provider handoff, syntax checks, and the
full test gate pass.

### Unsupported blocker narratives cannot close completed-looking runs

`labcanvas-unsupported-blocker-completion-108` comes from retained production
session `web-agent-labcanvas-57d7e9c5-8f7c-475b-acbd-b8cf70427d80`. The exact
LabCanvas repair request named its authoritative task artifact directory and
required a material source revision, rebuilt and inspected replacement PDF,
and concise result. After DeepSeek failed before inference with `402
Insufficient Balance`, LocalLLM listed the exact directory and read its routine
contract. It then claimed that no source file or revision instruction had been
provided and asked the user to provide them. No permission, dependency,
authentication, quota, or tool blocker existed, but the completion gate
accepted that invented limitation as `session.finished` once unrelated runtime
evidence made the underlying evidence assessment look complete.

Completion now classifies blocker language before the ordinary success return.
A candidate that says the task cannot proceed is accepted only when the current
evidence ledger contains a matching real blocker and project, source, and
artifact quality gates permit that blocker to close the run. Otherwise it
enters the existing bounded evidence-repair path with an explicit unsupported-
blocker reason. The model gets one progress-sensitive chance to use the enabled
tools or return the actual verified result; a repeated unsupported blocker
stops without a false terminal finish.

The end-to-end regression first satisfies a shell execution contract, then
proposes an unrelated missing-file blocker, verifies that the blocker is
rejected, and accepts the repaired evidence-grounded answer exactly once. The
existing positive control still accepts a genuinely evidenced missing command.
Syntax checks, truthful-completion tests, provider handoff, and the full package
gate pass.

### Revision and rebuild wording requires fresh artifact evidence

`labcanvas-scoped-artifact-revision-verbs-109` comes from retained production
session `web-agent-labcanvas-84d3ca00-7abe-4f4b-8b9e-51a7bf79122f`. Its exact
repair contract required AgInTi to materially revise a source inside the named
task directory, rebuild and inspect a replacement PDF, and return the verified
new PDF instead of the unchanged artifact. After the hosted provider failed
before inference, LocalLLM listed the directory, read the existing Markdown,
evidence manifest, and routine contract, then sent the pre-existing Markdown
and PDF to canvas. It performed no file mutation, rebuild, or replacement
inspection, but the run finished because the mutation classifier did not treat
`revise` or `rebuild` as workspace mutation verbs.

The generic mutation contract now recognizes `revise`, `rebuild`, and
`regenerate`, including their Chinese equivalents, anywhere the existing
mutation classifier already accepts repair, rewrite, and update language. This
does not infer a file mutation from artifact delivery alone: a file, source,
document, path, workspace, or explicit filename signal is still required by
the existing second-stage classifier. Message-only corrections and read-only
reviews therefore keep their prior behavior.

The production-shaped regression uses the exact retained wording and artifact
scope. It proves that the request is a scoped artifact operation, requires a
fresh file mutation after the request boundary, and still requires a PDF. The
same retained production goal now derives file plus artifact evidence instead
of artifact delivery alone, so unchanged prior files cannot satisfy it.
Scoped-artifact, progressive-tool, syntax, and full package tests pass.

### Project nouns do not trigger source-free forecast repair

`labcanvas-project-noun-forecast-false-positive-110` comes from retained
production session `web-agent-labcanvas-acfafa25-d3c5-4a4e-9e12-1813973211a2`.
The authoritative scheduled-inspiration request required one concise message
aligned to the exact group's organoid and interdisciplinary research interests.
After DeepSeek failed before inference with `402 Insufficient Balance`, the
LocalLLM returned the harmless invitation `Share your latest project ideas`.
The source-free claim guard interpreted the noun `project` as the verb
`project`, rejected it as an unsupported forecast, and requested a correction.
That unnecessary repair lost the subject: the replacement became generic
career advice and exposed the unrelated internal schedule id `memo_daily`.

Forecast detection no longer treats bare `project` as a prediction. It still
detects the unambiguous forms `projected` and `projection`, and detects
`projects` when a report, study, source, model, forecast, analysis, or analyst
is its subject. The change is confined to source-free response validation; it
does not weaken publication, validation, citation, year, benchmark, metric, or
multilingual forecast checks.

The regression uses the exact retained invitation and proves it passes without
a repair. A negative control proves that `The market analysis projects that
demand will grow next year` remains rejected. Truthful-completion and syntax
checks pass before the full package gate.

### Response-only repairs preserve the output contract

`labcanvas-response-only-repair-contract-111` is derived from retained
production session `web-agent-labcanvas-21296064-9835-461b-8179-5c8cf5f367a2`.
The authoritative WeCom router request required a strict multi-field JSON
object. A source-free factual answer triggered the evidence repair path, whose
replacement returned only `response` and internal routing narration. The JSON
contract validator was added after that production event, but a validation-
order gap remained: it checked the first answer before source-free repair and
did not check the replacement afterward. A schema-valid first answer could
therefore still finish with a schema-invalid correction.

The source-free repair instruction now repeats the exact required top-level key
types when an explicit JSON contract exists. Its replacement passes the same
contract validator before the repair is accepted or `session.finished` is
recorded. A replacement that drops keys stops through the existing output-
contract failure path; it does not get an additional model turn. This keeps the
repair bounded while preventing one validator from undoing another validator's
guarantee.

The provider-handoff regression forces DeepSeek quota failure, supplies an
initial schema-valid but unsupported factual claim, and then exercises both
LocalLLM outcomes. Dropping `files` and `confirmation` fails closed with no
terminal finish; preserving all three fields completes once. Provider handoff,
source-free evidence, JSON repair, and syntax checks pass before the full
package gate.

### Negated cleanup policy does not become deletion authorization

`labcanvas-prebuild-cleanup-auto-recovery-112` comes from retained production
session `web-agent-labcanvas-c8410880-dc6a-420d-9270-9712f158d3ea`. The exact
document-revision packet explicitly said never to bundle `rm`, delete, clean,
reset, or scratch cleanup into a build. After making substantive report
progress, the fallback model nevertheless attempted to remove the prior PDF
and TeX sidecars before rebuilding. The destructive guard correctly blocked
the command, but the permission adviser interpreted the words `delete` and
`clean` in that negative safety rule as user authorization. It therefore
paused the entire task for destructive approval instead of leaving the files
in place and continuing safely.

Deletion-intent parsing now removes bounded policy clauses such as `never
bundle ... delete ... into a build command` before looking for affirmative
deletion requests. The shell command remains blocked. When no independent
deletion request exists, the existing non-destructive recovery tells the model
to retain all files and continue the substantive work without approval. A
separate affirmative request such as `Delete the obsolete PDF` still requires
the normal destructive permission path.

The production-shaped regression uses the retained absolute report paths and
the same negated cleanup sentence. It proves the blocked cleanup no longer
pauses, while an explicit deletion sentence in the same goal is not erased.
Coding-tool and syntax checks pass before the full package gate.

### Runtime echoes cannot authorize generic artifact names

`labcanvas-generic-artifact-echo-bypass-113` is also derived from retained
production session `web-agent-labcanvas-23dfa04f-cef4-4d48-a99e-b152eacf4a99`.
The document task asked for a recognizable reader-facing report. A first write
to generic `report.tex` was correctly blocked with a descriptive-name repair.
After local-context compaction, the synthetic runtime message repeated the
blocked path. The filename guard searched recent messages whose transport role
was `user`, mistook that runtime echo for a human filename request, and allowed
the same `report.tex` write on the next turn.

Generic-filename authorization now comes only from the active goal contract
and configured goal. Synthetic compaction, loop-guard, permission, and tool
feedback can still guide the model but cannot silently broaden the user's
artifact naming contract. Exact filenames in the current request remain
allowed, as do paths declared by the task contract and edits to an existing
file.

The regression supplies a production-shaped synthetic `role=user` recovery
message containing `output/task/report.tex` and proves the new file remains
blocked. Its positive control puts the same exact path in the active request
and proves it is accepted. Coding-tool and syntax checks pass before the full
package gate.

### Explicit JSON schema headings are completion contracts

`labcanvas-explicit-json-schema-contract-114` comes from retained production
session `web-agent-labcanvas-f61239a5-db5e-42ff-94e2-1f4a1d5a4b2c`. Its route
request said `Return only JSON`, declared the allowed `route_kind` values, and
then supplied a thirteen-field object under `JSON schema:`. One fallback turn
returned an unrelated object with `classification`, `request_type`, `context`,
`status`, and `required_action`; a later turn returned only `route_kind`. Both
were valid JSON, so the runtime recorded each as finished even though neither
matched the explicit response envelope.

Response-only contract discovery now recognizes explicit `JSON schema`,
`JSON shape`, and `JSON format` headings, including `required` and `expected`
variants, in addition to the existing inline `Return JSON:` form. It derives
only the declared top-level keys and value types, then uses the existing single
bounded repair and fail-closed path. This remains domain-independent and does
not infer a schema from incidental JSON examples elsewhere in the prompt.

The production-shaped regression forces DeepSeek quota failure, returns a
one-key route object from the LocalLLM double, and proves that it cannot finish
until the missing schema fields are repaired. The focused provider-handoff
test, syntax checks, and full package suite pass without real LocalLLM
inference or changes to LabCanvas routing.

### Explicit JSON enums are completion contracts

`labcanvas-response-json-enum-contract-115` continues from retained production
session `web-agent-labcanvas-f61239a5-db5e-42ff-94e2-1f4a1d5a4b2c`. The route
request declared an exact `Allowed route_kind values:` list, but one fallback
turn returned `video_generation_and_download`, a plausible invented label that
does not exist in the host contract. A full-shaped response with that value
could satisfy the key and type checks while still selecting an unsupported
route.

Response-only contract discovery now retains string enums declared either as
an explicit `Allowed <field> values:` bullet list or as a pipe-delimited value
in the authoritative JSON schema sample. Completion validation reports fields
whose values fall outside those caller-declared enums, includes the allowed
values in the bounded repair instruction, and fails closed if the one repair
still violates the contract. It does not infer allowed values from prose or
apply domain-specific route names.

The production-shaped regression forces DeepSeek quota failure, returns all
thirteen required fields with only `route_kind` invalid, and proves that one
LocalLLM repair restores a declared value before the runtime records a finish.
The focused provider-handoff test, syntax checks, and full package suite pass
without real LocalLLM inference or any LabCanvas policy change.

### Candidate forecast mentions are not forecast claims

`labcanvas-auditor-forecast-mention-116` comes from retained production
session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`. A completion
auditor wrote that the candidate covered a `可证伪预测` but omitted a requested
PDF and related analysis. The source-free claim guard treated that
metalinguistic mention as the auditor making an unsupported forecast, forced a
second model turn, and risked replacing a useful missing-work diagnosis with a
less accurate answer.

The source-free claim classifier now distinguishes a candidate-content summary
that merely says a prediction, forecast, projection, hypothesis, or speculation
is present from a summary that repeats an actual future outcome. The narrow
exception covers explicit candidate/result/response language in English,
Chinese, and Japanese only when forecast is the sole detected claim category
and no year, future marker, projected outcome, or quantitative forecast appears.
Publication, validation, metric, evidence, and attributed-forecast checks are
unchanged.

The regression uses the exact retained Chinese wording plus English and
Japanese controls. A candidate-summary sentence that asserts 20% growth next
year remains rejected. Truthful-completion, provider-handoff, syntax, and the
full package suite pass without real LocalLLM inference.

### Successful equivalent web searches are single-use evidence

`labcanvas-successful-web-search-idempotency-117` comes from retained
production session `web-agent-labcanvas-3ff222ef-af1c-4301-8799-4c6ca71368d2`.
During one medical-research task, two generic discovery queries each completed
successfully 48 times and one exact paper-title query completed successfully 45
times. The static-discovery guard normalized equivalent search arguments but
deliberately allowed two successful calls before blocking, while context
recovery in the older runtime repeatedly reopened that allowance.

Equivalent successful `web_search` calls are now reusable after the first call
in an unchanged task state, matching the existing exact-file-read boundary.
Provider, result-count, whitespace, and capitalization changes do not bypass
the guard because they do not change the information need. A materially
refined query remains available, and successful task mutations still advance
the stagnation epoch through the existing progress machinery.

The focused regression proves that the second semantically identical query is
blocked while a query with an added primary-source constraint remains allowed.
The dynamic-step smoke, syntax checks, and full package suite pass without live
web requests, real LocalLLM inference, or any LabCanvas runtime-policy change.

### Reopening one unchanged browser URL is not progress

`labcanvas-browser-open-idempotency-118` continues from retained production
session `web-agent-labcanvas-3ff222ef-af1c-4301-8799-4c6ca71368d2`. The same
AACR page was successfully opened six times. Unlike `web_search` and
`read_web_page`, `open_url` was not static discovery, so every navigation was
credited as progress and reset convergence despite producing no file, artifact,
or new browser interaction.

`open_url` is now static discovery with a canonical URL signature. Fragments do
not create distinct identities, and a second successful equivalent open in an
unchanged task phase is blocked. A real non-static browser action still resets
the discovery phase through the existing progress machinery, so a later
intentional revisit after interacting with the page remains available.

The focused regression covers static classification, canonical fragment
normalization, duplicate blocking, and no-progress accounting. Dynamic-step,
syntax, and full package tests pass without opening a live browser or changing
host transport behavior.

### Directory depth is part of discovery identity

`labcanvas-directory-depth-refinement-119` also uses retained production
session `web-agent-labcanvas-3ff222ef-af1c-4301-8799-4c6ca71368d2`. The agent
listed the same artifact directory at both depth 2 and depth 3 while recovering
a document task. The convergence signature used only the directory path, so a
later, materially deeper inspection could be blocked as though it repeated the
same successful listing.

`list_files` signatures now include the normalized effective depth (1–8,
default 4). A simple read-only `ls` remains equivalent to a depth-1 structured
listing of the same canonical directory. Exact repeated listings retain their
existing bounded retry behavior, while an explicitly deeper scope remains
available when it can reveal evidence omitted by the earlier listing.

The focused regression proves cross-tool depth-1 equivalence, exact-listing
convergence, and a depth-2 to depth-3 refinement. It does not change filesystem
permissions, traversal limits, host transport, or LabCanvas runtime policy.

### Route assignments are not external forecasts

`labcanvas-operational-route-forecast-120` comes from retained production
session `web-agent-labcanvas-0aa6abef-47a0-4f2a-b07e-ae36281ecd6f`. After a
DeepSeek `402`, LocalLLM returned a structurally correct `publish_video` route
for the user's explicit request. The source-free claim guard interpreted the
route explanation as a forecast, rejected it twice, and replaced it with an
irrelevant no-evidence blocker.

The forecast classifier now separates bounded task-assignment language from
claims about external future outcomes. Wording such as a user requesting work
and a worker being expected to use an established routine is operational intent,
not a market or scientific prediction. Dates, future periods, quantitative
growth, demand, revenue, accuracy, and similar outcome claims remain guarded.

Focused evaluator checks cover the production-shaped publish route and an
unsupported 20% next-year demand forecast. The provider-handoff regression
forces DeepSeek quota failure and proves the valid LocalLLM route finishes on
its first response without weakening explicit JSON schema checks or changing
LabCanvas routing policy.

### Exact page reads converge without blocking focused rereads

`labcanvas-web-page-read-idempotency-121` comes from retained production
session `web-agent-labcanvas-6a712fc4-a1a4-4128-801d-46771cb3c50a`. One exact
web page extraction completed successfully 11 times, another completed six
times, and a query-ranked extraction of that second page completed three times.
The older convergence identity used only the URL and allowed two successful
calls, so it could neither stop the first duplicate nor distinguish a genuinely
different question about the same source.

`read_web_page` discovery identity now combines the canonical URL, normalized
passage query, and bounded content/passage scope bands. A second equivalent
successful extraction is blocked immediately. A materially different research
question or a larger content band remains available, while cosmetic whitespace,
fragment, and small numeric changes do not reopen the call.

The focused regression covers equivalent extraction normalization, exact-repeat
blocking, a different question, and a deeper read. This changes no web provider,
network permission, LabCanvas route, or hosted/local model priority.

### Image perception reuses one complete visual reading

`labcanvas-image-perception-idempotency-122` comes from retained production
session `web-agent-labcanvas-fab99af8-5b13-489b-ae4e-68f4c15cd8d7`. The agent
successfully read one 167031-byte WeCom image three times. Its first typed result
already contained the headline, account, visible text, and scene description;
the next two calls rephrased the OCR request and produced redundant perception
artifacts several minutes apart.

Image discovery identity now uses the canonical ordered image sources and the
requested detail level. Prompt wording, provider labels, model names, and
reasoning settings cannot create an unbounded series for an unchanged visual
source. One targeted follow-up remains available; a third equivalent-source
read is blocked. A higher-detail pass, a different image or image set, and a new
task-state epoch remain available.

The focused regression covers path aliases, prompt/provider variation, the
two-pass cap, and a higher-detail positive control. It does not select or change
any perception provider and performs no live vision inference.

### Structured workspace discovery converges after one complete result

`labcanvas-structured-workspace-idempotency-123` uses retained production
sessions `web-agent-labcanvas-ad4601f6-840b-46c8-b4a1-018491a847bb` and
`web-agent-labcanvas-6a712fc4-a1a4-4128-801d-46771cb3c50a`. Exact successful
`search_files` calls were repeated up to five times, while one rich root
`inspect_project` result was repeated after it had already returned the complete
manifest and source-directory inventory.

Exact structured file searches, project inspections, directory listings, and
equivalent plain `ls` calls now share one-use semantic discovery identities in
unchanged task state. Case-insensitive search identity ignores letter case.
Project inspection identity preserves material `maxDepth` and `includeFiles`
scope, and directory identity continues to preserve depth, so a refined search,
deeper listing, or richer inspection remains available. Successful mutation or
other concrete progress still starts a fresh discovery phase.

The focused regression covers exact workspace-search reuse, refined-search and
richer-inspection positive controls, listing depth, and cross-tool `list_files`
to `ls` equivalence. This changes no workspace permissions, tool availability,
provider selection, or LabCanvas runtime policy.

### Shell discovery requires non-mutation proof

`labcanvas-shell-discovery-mutation-boundary-124` follows the retained
environment-probe loop in production session
`web-agent-labcanvas-d2b99a34-8fa9-4157-ade9-a2a00c74940b`. That trace exposed
a disagreement between shell command policy and dynamic-step accounting: the
discovery classifier used only the first command word, so every command that
started with `find`, `cat`, `jq`, `rg`, or another reader looked static even
when it deleted files, ran a mutating `-exec`, or redirected output into the
workspace. Such a successful mutation could fail to advance the stagnation
epoch and could be rejected later by a misleading read-only convergence guard.

Shell calls now count as static discovery only when their shape is
discovery-like and command policy independently proves that they cannot mutate
the project. The existing `semanticMayMutateProject=false` escape remains
available for conservative broad-pipeline classifications such as
`find ... | xargs ls`. Verified leading workspace `cd` wrappers remain
transparent. Destructive `find` actions and output redirections remain outside
static accounting, while observed mutation and substantive-test progress keep
their existing semantics.

The focused regression covers the retained read-only environment probe,
leading-workspace wrappers, `find -delete`, mutating `find -exec`, reader output
redirection, and a stale convergence-history negative control. Dynamic-step
and syntax checks pass without executing a destructive command, starting a
model, or changing LabCanvas routing.

### Equivalent document builds share failure state

`labcanvas-document-compile-alias-convergence-125` follows retained production
session `web-agent-labcanvas-d568a2bd-e9d4-48c9-a30e-0e7c830efcd5`. After one
real LaTeX source repair, the session exhausted 84 steps while revisiting the
same failing `latexmk` build through both an absolute source path and a `cd`
plus relative source path. Exact-string guards bounded each spelling
separately, but changing the shell spelling incorrectly created another retry
budget. A byte-identical later overwrite no longer advances current runtime
state, so this path alias remained the live bypass.

Simple LaTeX compiler invocations now use a semantic failed-command identity:
compiler, ordered flags, and the resolved `.tex` source. The absolute-path and
working-directory forms of the same build therefore share bounded failure
history. Different compilers, flags, source documents, and post-mutation epochs
remain independent, preserving legitimate diagnosis and repair.

The focused regression reproduces the retained path aliases, proves that a
third equivalent failure is blocked, and keeps `xelatex`, another source, and a
fresh source-edit epoch available. It does not execute LaTeX or change any
LabCanvas host policy.

### Private context titles never become public web queries

`labcanvas-web-query-private-context-boundary-126` comes from retained
production session `web-agent-labcanvas-795aaa67-fdc2-427c-afd4-9bce957ae32c`.
A source-recovery manifest incorrectly described a same-chat history artifact
as an article and supplied an exact-title reconstruction query. DeepSeek then
sent `Chat History for sunnyyty的聊天记录` to public search providers. The
query returned irrelevant generic chat pages, exposed a private transcript
label outside the task boundary, and consumed a research step before the model
recognized that the real task was an unrelated daily research briefing.

Public web search now rejects secret-bearing queries and title-shaped private
chat, conversation, message, or session-history scaffolds before a custom
provider callback or network fetch can run. The same classifier is applied at
the agent tool guard and inside direct `searchWeb` calls, so `web_research` and
`deep_research` cannot bypass it. The failure tells the agent to search for the
underlying public topic without copying names or transcript labels.

The focused regression uses the exact retained mixed-language query plus
English, Chinese, and Japanese variants and proves zero provider dispatch. It
also keeps ordinary public queries about safely exporting chat history,
conversation-history research, and organoid microfluidics available. This
changes no provider choice, network allowlist, LabCanvas policy, schedule, or
transport.

### LaTeX compilers reject non-TeX document sources before execution

`labcanvas-document-source-compiler-boundary-127` comes from retained
production session
`web-agent-labcanvas-aef0f454-06ca-45ed-93ca-21c786de1020`. The task asked for
a Markdown report revision and explicitly assigned unavailable Unicode-PDF
compilation to the host. After correctly editing the report, the fallback model
ran `pdflatex report.md`, searched for a converter, attempted package-manager
and Node.js installation routes, and finally requested elevation. The first
command was semantically invalid: a LaTeX engine accepts a `.tex` source, not a
Markdown, text, HTML, office-document, or PDF input.

AgInTiFlow now rejects that source/compiler mismatch before launching the
process and stops the remaining tool calls in the same assistant batch. The
diagnostic directs the model to create or use the complete task-scoped `.tex`
source, use an already available declared converter, or return editable source
to a host-owned compilation stage. This prevents one invalid premise from
cascading into converter installation or permission requests while retaining
normal recovery after the model sees the result.

The focused regression covers the retained `pdflatex report.md` command,
XeLaTeX, LuaLaTeX, `latexmk`, shell wrappers, and incompatible Markdown, text,
PDF, HTML, and office-document inputs. Positive controls preserve valid `.tex`
compilation, option values that happen to carry file extensions, explicit
Pandoc conversion, and project build scripts. No compiler is launched, no
package is installed, and no LabCanvas provider, schedule, transport, or
runtime policy is changed.

### Numeric chat identifiers are not truncated into years or forecasts

`labcanvas-bare-number-claim-boundary-128` comes from retained production
sessions `web-agent-labcanvas-d99fc736-db3a-4310-bbe5-c939a779ffca` and
`web-agent-labcanvas-a2400822-729d-400b-8a70-2842e3dcefe8`. A user sent the
bare message `199793`. Both the route turn and the fast-chat turn produced
reasonable clarification responses, but response-only evidence validation
rejected them twice and returned an internal evidence failure to the host.

The root cause was lexical, not provider quality. The Chinese forecast matcher
read the last character of `收到` as the temporal preposition `到`, then treated
the first four digits of the six-digit value as year `1997`. Related year
patterns also lacked numeric boundaries. The source-free claim guard now
requires complete four-digit year tokens and an actual Chinese year/deadline
suffix after `到`. It also recognizes narrowly framed metalinguistic
clarifications about an ambiguous input while continuing to reject external
publication, validation, market, and forecast assertions embedded in them.

The focused regression preserves the exact retained Chinese clarification, a
production-shaped route JSON response, and ordinary numeric acknowledgements.
Negative controls still reject an ambiguous-message sentence that asserts a
2025 publication and validation, plus an attributed 2030 product forecast.
This changes no response schema, model route, LabCanvas prompt, transport, or
schedule.

### Degenerate transcripts cannot become invented speech summaries

`labcanvas-bounded-transcript-quality-129` comes from retained production
session `web-agent-labcanvas-5fbe19a4-7707-4649-8b50-1e2698ce7141`. The host
provided one exact Shipinhao packet for a 47-second video and explicitly asked
for a summary of the actual speech. Its transcript consisted almost entirely
of repeated `母带`, `混音`, and related production-credit words. The fallback
model nevertheless expanded title and hashtag metadata into a fluent account
of the video's speech and visuals, and response-only completion accepted it.

AgInTiFlow now evaluates transcript usability only for structured bounded
packets that explicitly request a speech summary. Empty, implausibly sparse,
or strongly repetitive transcripts require a reader-facing limitation. The
single repair turn prohibits converting title, description, author, or hashtag
metadata into speech and restates the caller's JSON key/type contract. If the
backend repeats the invention, the runtime returns a schema-compatible
limitation and leaves the session stopped rather than recording a successful
finish.

The production-shaped regression covers the exact repetitive transcript, a
successful bounded repair, repeated-failure fail-closed behavior, and JSON
contract preservation. Positive controls retain an ordinary information-rich
transcript and a metadata-only identification request. Media resolution,
download, ASR, attachment delivery, provider priority, LabCanvas queues,
transport, and schedules remain unchanged.

### Fail-closed response-only turns retain the caller envelope

`labcanvas-response-only-fail-closed-envelope-130` follows retained production
session `web-agent-labcanvas-0aa6abef-47a0-4f2a-b07e-ae36281ecd6f`. Its
response-only route request declared a strict multi-field JSON schema. The
source-free guard correctly stopped a repeated unsupported claim, but returned
plain diagnostic prose. That truthful stop was no longer parseable by the
caller's declared protocol and could become a dropped or misrouted host task.

Every response-only fail-closed path now serializes its limitation through the
explicit contract. Required keys and value types remain present, declared
string enums receive a valid safe value, and diagnostic prose is placed only in
a non-enum string field, preferring `message`, `summary`, or `reason`. The same
rule covers a repeated malformed JSON answer and a repeated unsupported factual
claim. The session still stops, emits its existing private failure event, and
never records `session.finished`.

Production-shaped regressions cover a chat response envelope, the retained
router-style enum envelope, and a completion-auditor schema. They force the
DeepSeek pre-inference quota handoff through deterministic LocalLLM responses;
no live model inference, LabCanvas policy change, queue action, schedule, or
transport operation is involved.

### Secret-bearing derived content recovers by redaction

`labcanvas-secret-write-redaction-recovery-131` follows retained production
session `web-agent-labcanvas-0ba776d1-2592-45a1-a2f3-e842c092be20`. A
Shipinhao source packet contained private signed media fields. While preparing
a derived reader-facing note, the fallback model copied a token-like value into
an `apply_patch` replacement. The workspace secret guard correctly denied the
write, but generic permission advice paused the task and suggested a stronger
Docker run. No permission level can make persisting that value safe, so the
source-understanding task stopped for an irrelevant user decision.

Workspace-content secret blocks now advertise one bounded automatic recovery:
omit the private URL or replace the sensitive value with `[REDACTED]`, preserve
the useful non-sensitive content and requested artifact path, and retry once.
The denied write still does not mutate the workspace. The current assistant
tool batch is still short-circuited, so later calls cannot act on the invalid
content before the model sees the correction. Protected paths,
outside-workspace writes, destructive actions, and genuine permission changes
retain their existing pause behavior.

The end-to-end regression first proves the old `permission_required` stop,
then proves that a redacted retry creates the exact derived artifact and can
finish without exposing the secret. Direct workspace-tool coverage separately
proves that the original secret-like write remains blocked. No live model,
private media URL, LabCanvas runtime change, queue action, schedule, or
transport operation is involved.

### Local file URLs recover through workspace-native tools

`labcanvas-file-url-preview-recovery-132` follows retained production session
`web-agent-labcanvas-8239a475-f456-4451-8c31-36428d15803e`. The fallback had
already found a task-scoped PDF, but passed its `file://` URL to `open_url`.
The browser guard correctly accepts only remote HTTP(S) URLs; generic
permission advice nevertheless paused the task and suggested stronger runtime
flags. No permission change was needed because the file was already inside the
authorized workspace.

Unsupported browser schemes now carry a distinct recovery category. A local
file URL remains blocked before browser navigation, while the next model turn
is directed to `open_workspace_file`, `preview_workspace`, or `read_file` using
the workspace-relative path. Unsupported non-file schemes are never executed
or rewritten; the model may use an exact authorized HTTP(S) source from the
current request or report the source limitation honestly.

The end-to-end regression reproduces the old one-turn permission pause, then
proves one workspace-native read and a verified finish. Direct guard coverage
also proves that `file://` did not become remotely navigable. Outside-workspace,
protected-path, domain-allowlist, and genuine permission boundaries remain
unchanged. No live model, browser navigation, LabCanvas runtime mutation,
queue action, schedule, or transport operation is involved.
