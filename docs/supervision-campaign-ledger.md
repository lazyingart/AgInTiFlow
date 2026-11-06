# Supervision Campaign Ledger

## Workspace file publication — 2026-11-06

A normal spelling-correction task through installed 0.20.370 reproduces native
file-tool data loss: a controlled partial disk write followed by EIO leaves only
twelve bytes of the original document. A separate real create-only tool probe
overwrites a file created by another writer after its initial existence check.
Both failures belong to AgInTi's workspace publication boundary, not to model
instructions or an application adapter. An earlier create fixture correctly
blocked a not-yet-offered tool and is excluded from failure evidence.

The file tools now verify and sync sibling staging files before per-file
publication, use kernel no-clobber creation, and bind patches to their read
hashes. The original bytes survive controlled partial EIO/ENOSPC failures.
Thirty-three focused cases cover staging failures, native receipts, races,
permissions, unsafe targets, cleanup and same-session continuation. Three fresh
native sessions pass 42 external checks with exact output bytes and one
successful patch per task, including recovery in a new process. Model replies
are explicitly scripted offline; this slice makes zero paid provider calls.

The final full `npm test` passes in 520.887 seconds with all 400 captured
inputs unchanged. Syntax checks cover 322 files and the production dependency
audit reports zero vulnerabilities. Candidate review findings include a
concurrent creator's transient second link and an oversized staging filename;
both are repaired before qualification. Earlier full-run results are retained
as intermediate evidence and do not substitute for the frozen final run.

Source `18e7e00` and version-only release `46c097f` are pushed with immutable
tag `v0.20.371-integration.0`.
[CI 42239263204](https://github.com/lazyingart/AgInTiFlow/actions/runs/42239263204)
passes its full suite, consumer qualification and publish command. Local and
actual-registry consumers each pass 482 cases; the actual global installation
passes 262 cases. All 561 package files match release Git and the archive after
testing. Both CLI commands report 0.20.371-integration.0 and the personal 0600
provider preference is unchanged.

The public archive initially returns 404, then becomes available within the
bounded readiness window with exact matching bytes. Installation waits for that
verification; no republish, tag rewrite or local-archive fallback is used.
Registry provenance subject and commit are inspected, without independent
signature verification. Archive SHA-256:
`a6829b8eb4915bd5a33cc40d9113592c6959e241027f984bd50188256bd69551`.
Seven machine-ledger cases preserve baseline and candidate failures, source
qualification and release verification; all new paid model-call counts are zero.

The actual-timing terminal demonstration and private synthetic session receipts
are retained separately. No application data, provider routes, LocalLLM service
or public integration capability is changed. This bounded repair does not claim
multi-file transactions, hostile external-writer CAS or retained-storage
authority. See [the publication contract and limits](workspace-file-publication.md).

## Native file-checksum completion consistency — 2026-11-06

The preceding recovery example exposes a provider prose error: an abbreviated
file checksum disagrees with the exact native receipt while the file itself is
correct. A separate offline probe of installed 0.20.369 reproduces a reusable
runtime gap: both a wrong full SHA-256 and that wrong abbreviation are accepted
as completed despite a contradicting native read receipt.

The native completion gate now checks explicit labeled file-checksum claims
against active-task read receipts. It allows one correction, preserves language
and task requirements, and pauses repeated contradictions with
`file_checksum_mismatch`. It grants no new tool permission and never regenerates
the file to make a claim true. Earlier snapshots are retired at read admission
and actual native read errors, or after possible mutation/unknown effects.

Fifty-three focused controls cover full and abbreviated hashes, English,
Chinese and Japanese, quotations, historical/expected/negated/unrelated values,
actual native event shapes, bounded work, native finish/plain content, and
fresh-process same-task continuation. Three fresh native sessions with a
scripted loopback provider pass 24 external checks: correct hash accepted,
optional abbreviation corrected, stubborn false checksum paused with no
successful completion. Input bytes stay unchanged and no producer is called.
There are no new paid model calls; the original real-model observation is not
regenerated or counted again. A labeled actual-timing offline demo is retained.

Candidate review also catches historical/quotation false positives, excessive
repeated-input work and a mismatch with the actual failed-read event envelope.
Those findings and earlier passing suites are retained as intermediate evidence;
they do not substitute for the final source-bound qualification. The final full
`npm test` exits zero in 526.019 seconds with all 396 captured inputs unchanged;
syntax checks cover 321 files. Neighboring truthful-completion, session-runtime,
inbox and native-checkpoint suites pass. Package, registry and global-install
qualification is recorded separately after publication.

Source `ff425f7` and version-only release `934626d` are pushed, with immutable
tag `v0.20.370-integration.0`. Local package qualification passes 449 consumer
tests and binds all 556 public files to release Git; private-path and credential
scans pass. [CI 42223797334](https://github.com/lazyingart/AgInTiFlow/actions/runs/42223797334)
passes, including its full suite, 449 consumer cases and npm's publish command.

Public distribution verification initially pauses: twenty canonical archive
checks over ten minutes return 404, as do version metadata and a fresh-cache
official npm client. The previous installation stays intact. The cause of this
visibility discrepancy is unproven and the failed checks are retained.

Fresh public metadata later exposes the exact release commit, and its canonical
archive matches the locally qualified bytes. Actual registry-consumer tests pass
449 cases, followed by 229 actual-global cases. All 556 archive/Git/global files
match after tests; both CLI commands report 0.20.370-integration.0 and the personal
0600 provider preference is unchanged. No republish, tag rewrite or local-archive
fallback is used. Registry provenance subject and commit are inspected, without
independent signature verification. Archive SHA-256:
`1a57566027e1077230a6cc132a2ab14463b80e64a574deddc3ba23b0e52bcbb5`.
Nine machine-ledger cases preserve the original observation, candidate findings,
external visibility failure and final qualification, with zero new paid calls.

This is a bounded contradiction check for adjacent labeled SHA-256 metadata
with a scoped native receipt. It does not validate all prose or other algorithms,
certify unobserved files, or prove a file remained unchanged after its read.
See [the contract and limits](completion-file-checksums.md).

## Completed native-batch recovery — 2026-11-06

Release0.20.369-integration.0 is published and globally installed. Source d1eeebb
and version-only release413022c are pushed with immutable tag7f14f775; tagged
CI42212991840/job127875962124 succeeds.396local+396actual-registry consumer cases
and176actual-global cases pass. All551archive/Git/global file bytes match; both
CLIversions are exact and the personal0600provider preference is unchanged.
ArchiveSHA256:5a847cf33dc63e4ffb1204f5d9f7078a7143c046ebb06367ce19be9379d6a6e3.
Provenance subject/commit are inspected, not independently signature-verified.
The tarball becomes available after bounded read-only propagation checks; there
is no republish or fallback archive. Eight recovery ledger cases count6actual
requests once. A separate failed completion-fingerprint observation reuses that
trace with0newrequests and leaves safe reusable core treatment unassessed.

Installed368 can lose a completed producer's model-history receipt when the
process dies in a post-result callback before the batch save. The event ledger
and artifact survive. A fresh real DeepSeek resume with only “Continue the same
task.” completes safely but takes4requests: read, redundant create (blocked by
the existing guard), read and finish. The source and artifact remain unchanged;
this is a durable-context/efficiency defect, not an observed duplicate write.

The runner now saves each complete accepted dispatch batch before post-result
callbacks or reviews. The existing contract serializes mutating calls; partial
read batches receive no invented results. DeepSeek's compatibility repair also
preserves complete unambiguous results lacking reasoning metadata through the
existing bounded text-evidence format. It invents no reasoning or missing result
and promotes no failed, blocked, skipped, duplicate or foreign outcome. Compatible
DeepSeek/OpenAI native frames retain their existing representation.

Thirteen focused cases pass: eight history-repair controls and five real native
child-process scenarios covering hard death, closed read batch, callback error,
checkpointEIO and ordinary completion. Eleven neighboring suites, syntax320 and
audit0 pass. The full npm suite exits0 in517.748seconds with392inputs unchanged.
An equivalent new seed uses actual native tools with offline model responses,
thenSIGKILL; its fresh real DeepSeek resume takes2requests/4.528seconds, attempts
no second producer and preserves both files.22external file/session checks pass.
The before and after recoveries use6actual requests total; seeds use0realmodels.
Both actual-timing recordings and the initial failures are retained separately.

This is one measured synthetic example, not a general latency benchmark or
exactly-once guarantee for effects before a checkpoint. The after answer has one
incorrect abbreviated source-hash tail; external full hashes and saved tool
metadata remain correct and authoritative. That narrative-metadata quality limit
is recorded without regenerating a cleaner model answer. No app, optional role,
credential, LocalLLM or service is activated. Release/package gates independently
confirm these source checks. Owned test processes, temporary roots and the
borrowed dependency link are cleaned; unrelated services remain unchanged.

## Native queued-instruction dispatch — 2026-11-06

Release0.20.368-integration.0 is published and globally installed. Source8fee030
and version-only releasefa39ab8 are pushed with immutable tagv0.20.368-integration.0;
CI42203304707/job127843658793 succeeds. Local and actual-registry consumers each
pass383cases. All548archive files match release Git and the global installation;
163actual-global cases pass and bothCLI commands report the exact version. The
personal0600provider preference is unchanged. ArchiveSHA256 is
4539ae98efbd37850df82031c044a85ea5e25f2b86dfea1c2934ec78ef9e9ed6.
Registry provenance subject/commit are inspected, not independently signature
verified. Eight machine-ledger cases retain the original failure, qualification,
checker typo and registry propagation delay; seven real requests are counted once.

The private local scan checker initially copied the wrong digits in the known
synthetic-token fixture hash and stopped; restoring the exact historical hash
allows the full local gate to pass without changing product or scan policy.
After publication, the registry temporarily returns404 for the tarball despite
valid metadata/provenance. Qualification stops without installation. A bounded
read-only check later obtains exact archive bytes; fresh registry and global
gates pass. There is no republish, tag rewrite or fallback-archive installation.

Installed367-integration.1 reproduces a core ordering failure with an offline
provider: a real durable user correction forbids file changes before the old
write response returns, but the runner still creates the file and completes
goal revision1. This is a runtime defect, independent of provider quality.

The runner now applies queued input through the existing continuation contract
and checks after model responses, between tools and before completion. Skipped
native calls get unsuccessful replies before the user message; they produce no
execution evidence. Twelve persisted-runtime regressions pass, including
English/Chinese/Japanese, mid-batch reads, stale finish, completion-time input,
additional requirements, event failure/restart, capped resume and file-text
negative controls. Inbox/session/runtime/truthful-completion and retained-context
neighbors pass. The full npm suite exits0 in513.786seconds with all390inputs
unchanged; the dependency audit reports0vulnerabilities.

An actual DeepSeek native session queues the correction while an older request
is in flight, discards that response, reads the note and answers without writing.
A second fresh process resumes the same session in Chinese. Seven real requests
take19.672seconds across both phases. Twenty external file/session checks confirm
one inbox application, goal revisions1->2->3, unchanged input, no output file and
released run lock. The actual-timing terminal video and synthetic evidence are
retained separately. Answers are still more verbose than requested.

This is a safe-checkpoint fence, not revocation of effects already admitted.
Package, registry and global installation are independently verified. No
application, LocalLLM role, Codex admission, credential or service is changed.

## Provider admission review — 2026-11-06

After the qualified 367-integration.1 checkpoint, the ledger's remaining
prerequisites are LocalLLM functional role admission and an app-safe no-tools
Codex transport. Current owner packets still approve only LocalLLM S1; S2 is a
plan, not an implementation grant. Installed Codex remains 0.166.0. Its retained
zero-model admission probe advertises request_user_input, so no duplicate model
or transport probe is justified by an unchanged executable version alone.

Existing native-session Flash/Pro evidence already covers a real saved-session
handoff at 362, alongside current offline regression coverage. The 367 SDK live
example instead uses host-supplied history. These are separate evidence scopes;
neither is rerun or relabeled as a fresh native-session trial in this review.

Official OpenAI documentation now supplies a separate future app-registration
route, with distinct identity and streaming requirements. The admission guide
records that target and the remaining proof obligations without turning the
trusted CLI wrapper into an app provider. No authentication, model or service
operation is performed. This documentation change does not qualify the route,
change runtime behavior or require another npm release. Machine capability
states remain prerequisite_missing for both dependencies.

## Optional bounded DeepSeek application transport — 2026-11-06

Final release0.20.367-integration.1 is published and globally installed. The
immutable release5866cd832ec7d443eb2a5145473d91cc44f5efc2 follows test-fix
sourcef574fe5fb702f6883505964c5575f1e2595745b0; the original optional-client
source8b02ee7 is unchanged. Tagged CI42190361422/job127800569396 succeeds.
Local and actual-registry consumers each pass371cases. All545archive files
match committed release Git and the installed package. The optional public
import is checked from installed packages; bothglobal CLI commands report the
exact version,151actualglobal tests pass, and the personal0600provider
preference is unchanged. ArchiveSHA256 is
f7b12aadbbd99b432dc1dbe02bf095fa5f024a7c4d9e7578c35bb68df41a2a14.
Registry provenance subject/commit are inspected, not independently signature
verified. Publication/propagation and fresh install each complete before the
next gate. No app service or backend routing is changed. Own full-suite test
servers are stopped with exact process identity checks; dependency link removed.

The first immutable release candidate,367-integration.0, is not published:
CI42186478236 stops at an existing native-lock test. Its fixture assumes B must
win acquisition after removing the dead canonical name. A can legally publish
first in that interval; B correctly returns SESSION_RUN_ACTIVE. A bounded
after-unlink gate deterministically reproduces that exact failed assertion.
The fixture now forces this schedule and asserts one winner, one old canonical
unlink, unchanged winning lease and refusal of another claimant. No production
lease guard or runtime code is changed. All32lock cases and20 repeated forced
races pass. The subsequent complete npm suite passes in490.329seconds with all
388inputs unchanged. The failed tag/logs stay intact; the new candidate is
367-integration.1. Existing real provider evidence is reused without more calls.

The restricted application SDK previously required every consumer to implement
its own HTTP boundary. A separate optional import now supplies the fixed native
DeepSeek JSON profile with an explicit app credential, model and opaque account
hint. The existing default SDK import and read-only loop remain unchanged.
There is no ambient discovery, redirect, retry, fallback, session store or write
authority. Host authentication, scoped reads, history, revision validation,
transactions, quotas and provider consent remain application responsibilities.

Forty-one offline cases exercise actual loopback request/response/socket closure
through a test-only Node HTTPS module mock. They cover typed status boundaries,
fatal UTF-8 and duplicate JSON, header/body limits, credential reflection,
cancellation, delayed close and retained capacity, mutable/hostile construction,
concurrent callers, tool withdrawal, ambiguous disconnect and cached cleanup
failure. The mock does not qualify TLS. Lite preview9 adds the same two optional
source files, keeps its default three-file graph and seven exports unchanged,
and passes105 offline cases including nine-file reproducible packaging and
separate default/optional installed consumers. It remains a private local package.

Actual native HTTPS qualification uses two fresh processes and four provider
requests in5.624seconds: Flash reads the host's synthetic current note and drafts
an English-requested time correction in the original Chinese; explicitly chosen
Pro receives host-supplied history and revision8, reads again, and applies the
Chinese follow-up while retaining the unrelated sentence. Each makes one scoped
read and two requests. No saves, automatic retries or application changes occur.
Twenty-four independent checks verify scope, revisions, content, request counts,
Flow/Lite optional bytes and absence of owned sockets/timers after close. Two
initial harness schema/call-shape errors made zero requests and are preserved.

The captured demo and redacted receipts are retained in Nutstore Projects/AgInTi.
This is a host-owned session fixture, not native SessionStore, durable billing,
remote inference termination, live Lite/app activation or OS isolation proof.
LocalLLM and app-safe Codex prerequisites remain unchanged. The complete Flow
npm suite passes in506.891seconds with388 recorded inputs unchanged; syntax320,
neighboring SDK/recovery checks, audit0 and diff validation pass. Release and
installed-package acceptance remain independent gates for this slice. A direct
zero-network probe also confirms newline credentials/scope values are already
rejected; no extra runtime change or false detector claim is needed.

## External workspace changes invalidate retained passing tests — 2026-11-06

Installed365 reproduces a native false completion without inference: a real npm
test passes, the session is interrupted, another process changes the source,
and an independent test now exits1. Resume nevertheless accepts its first finish
claiming npm test passes, with no new command and no rejection. The unchanged
agent-owned mutation revision is insufficient evidence about current files.

Passing native tests now retain a bounded metadata fingerprint of the permitted
workspace. Resume and completion compare it before reusing the pass; additions,
removals, edits, replacements, generated inputs, dependency files and restored
mtime edits invalidate only the verifier revision. No agent edit is invented.
Unknown, legacy, symlink, scoped or oversized observations cannot lend a pass to
another invocation. Fresh direct verification remains available, unchanged
observable work can finish without retesting, and real current failures remain
blocking. Source bytes and names are not persisted in the fingerprint.

Nineteen focused tests include source changes between processes and in-flight,
SCS on/off, completed-task no-op refusal, legacy migration, fresh repair and
unchanged continuation. The original recovery fixture attempted an edit before
the required fresh test; three tool-contract failures are retained. The fixture
now follows the offered order: test the current source, read and repair its real
failure, rerun the test and finish. No tool or permission contract was weakened.
The first full suite exposed self-invalidation when runtime storage is inside
the project; exact configured private roots are now excluded and their policy
is hash-bound. Ordinary siblings remain inputs, and excluding the whole root
cannot create a reusable observation. This is a production fix, not a fixture
relocation. Full, package and actual-provider acceptance remain separate gates.

The unchanged installed Codex0.166.0 and its existing diagnostic still do not
establish an application no-tools transport; no duplicate launch was made.
LocalLLM S2 remains unapproved. No application, service, credential, model or GPU
configuration is changed by this workspace verification repair.

The final source passes52 focused cases (19new,18 retained-progress and15 native
adviser), neighboring progressive/session/truthful checks, syntax318, audit0 and
the full npm suite in497.102seconds. All385 recorded runtime/test/package inputs
remain unchanged. Package dry-run has542 files. Registry and installed-release
qualification remain separate steps.

A fresh process continues the persisted synthetic line-counter task with only
“Continue the same task.” Six real Flash requests take12.714seconds for the whole
process: stale proof is invalidated, current tests fail, source is read/repaired,
fresh npm test passes and the task finishes. A malformed model call is recovered
before dispatch. The seed uses no model calls but does execute real passing
tests before the controlled outside source fault; this is not a claim of an
all-live initial task or live OpenAI handoff. The real continuation explicitly
patches the saved scripted provider to DeepSeekFlash at runtime revision2.

The original acceptance harness exits1 because it demands the reference source
formatting. Its output is preserved. Independent review accepts the different
correct implementation: four existing tests and ten extra semantic checks pass,
test/manifest bytes are unchanged and only source is repaired. A first review
also omitted the pre-existing native codebase-map cache from its expected file
inventory; the final review verifies that cache predates the live run. There is
no second provider run or paid retry. The21.8-second video preserves actual PTY
timing and labels its later independent-review panel separately. On this small
fixture,60 metadata observations retain22 file descriptors and have p95 below
1.5ms; no general filesystem or latency guarantee is inferred.

Published and globally installed: **0.20.366-integration.0**. Source9002146 and
version-only releasefdb8902 are pushed. Exact tagged workflow42176033106 succeeds;
all542archive/Git/registry/global files match. The local and actual registry
consumers each pass330tests;110tests pass against the real global installation,
and both CLI versions match. Personal provider preferences are unchanged.
Provenance subject and commit match; signature verification is not claimed.
Both ledgers retain11cases, including the original false success and fixture
failures. One owned obsolete test server is stopped and its dependency link
removed; no application service or other project's process is changed.

## Retained execution progress across conversation turns — 2026-11-06

Installed 364 reproduces a tool-selection defect without inference: a saved task
has active execution revision 1 and a task-owned source mutation, but conversation
revision 3 offers only inspect_project and finish. The selector discards the
older execution phase solely because the conversation advanced. After rejection
of a piped test result, this forces repeated discovery before standard verification.

The runtime now retains completed source-grounding progress only when the same
workspace, active revision, contiguous continuation hashes and exact owned material
mutation agree. New requirements, task changes, missing history/hashes, foreign
mutations and unknown scope still require fresh grounding. Test, source repair,
permission and completion gates retain their independent authority. This is
native session progress, not external filesystem immutability or a keyed seal.

Eighteen focused cases cover these boundaries plus actual persisted interruption,
OpenAI-to-DeepSeek logical handoff and SCS on/off. The latter uses deterministic
SCS validation and no provider network. A stale piped test still rejects finish;
the next turn can execute the real suite directly and finish without discovery
or another source edit. Before repair, three controls fail while 15 negatives
pass. The first fixture omitted a source-inspection requirement and therefore
did not enter the relevant phase; that fixture failure is retained separately.
The first scrubbed full suite catches another fixture issue: the logical provider
handoff needs its own fake credential. The fixture now supplies and restores that
synthetic value with network access denied; production auth is unchanged.

The real original session resumes from its existing state with only “Continue
the same task.” It completes in 8.86 seconds, two actual Flash requests, one git
status/diff command and finish, with no edits, new adviser or discovery calls.
The prior adviser receipt and all source/manifest/test bytes are unchanged;
external node --test passes four tests. npm test is retained evidence from the
previous turn, not a new invocation in this one. Final prose describes fresh
verification alongside that reused test result; clearer freshness labels and a
shorter summary remain model-quality limits. The original three incomplete turns
remain failures. This successful fourth turn completes the same saved task after
the general fix, without a new implementation recipe or broader permissions.

Release **0.20.365-integration.0** is published and globally installed. Source
`1e2b1ec8f3286575e4422c20fc9b7a75417b59f6`, version-only release
`cc497e808e412e31dda0af3d0fba71d44d53c5f1` and the tag are pushed; exact workflow
42169455977 succeeds. Final full suite passes in 485.623 seconds with all 384
input hashes unchanged and bound to source, including the live runtime hash.
All 541 archive/registry/global files match. Fresh consumer and registry installs
each pass 311 tests; actual global checks pass 91. Audit is zero and both CLI
versions match. The first failed full remains recorded as fixture isolation.

Separately, both current Flow and pinned Lite SDKs actually construct 16 offline
text-only request variants. Bodies and wire/canonical/upstream hashes match the
unchanged approved LocalLLM S1 vectors, and its pure validator accepts them.
No model, transport, credential, dependency install or owner-source edit occurs.
The first harness used an internal result field and was corrected to the public
proposal interface; that failure is retained. Verified-owner coordination returns
a concrete read-only next-source plan. Its six-file implementation remains
unapproved, and neither current-client profile nor runtime admission is inferred.

## A once-only adviser is a durable native attempt — 2026-11-06

An unchanged 363 native tool loop dispatches a failed adviser twice despite an
explicit once-only instruction. The reproduction uses a real SessionStore and
wrapper launcher with only the model and external child simulated. This is a
runtime instruction and recovery defect, separate from provider response quality.

The native task now reserves and fsyncs an attempt before launch. Its scope binds
the session, task boundary and selected adviser; an exact successful request can
replay the persisted result. Failed or uncertain mandatory advice pauses without
another model repair, CLI retry or spare. A primary-provider handoff and generic
continuation preserve the same receipt. Explicitly required review before edits
gets a read-only tool phase. No wrapper or hosted provider is enabled implicitly.

Seventy-three focused cases cover the grammar, unchanged inputs, call ordering,
spare suppression, request binding, foreign/corrupt state, interruption and
fresh-process replay. An existing availability-only fixture now says optional
advice; required invocation is tested by the actual persisted tool loop. Another
fixture correction preserves existing advisory-batch serialization: the runtime
defers later calls instead of executing or fabricating replies for them.
An additional native probe first reproduces false completion from an older
review after an explicit new grant. Completion now requires the current receipt;
the persisted two-turn regression rejects the stale claim before fresh advice.

A real Flash trial obtains one configured Codex review before editing, preserves
tests and the manifest, fixes the implementation and runs the four retained tests.
External execution confirms all four pass. The run then requests an extra broad
interpreter command and truthfully pauses on permission. A short fresh-process
continuation spends four additional primary requests but cannot complete: a
fresh-test evidence gate does not recognize the piped test command as satisfying
the named test path. Its bounded driver stops without another adviser launch.
Both unsuccessful completion receipts remain recorded; no end-to-end success
or application-safe Codex admission is claimed. The one-attempt mechanism works,
while efficient completion from sufficient existing checks remains a separate
open capability. There are 13 actual primary requests across these two turns;
one CLI launch does not prove one upstream Codex inference.

A later plain continuation explicitly permits the existing project tests and
forbids further edits. It repeats context inspection and executes `npm test`
successfully, but reaches its six-primary-request driver cap before a final
answer. No new adviser or mutation occurs. The three real turns total 19 primary
requests. This post-source qualification remains an incomplete end-to-end case;
it neither establishes a provider outage nor proves a new core defect by itself.
The final source receipt guard is live in this third turn. Efficient continuation
without repeated discovery remains unqualified, and no further paid retry follows.

The receipt uses integrity digests and the native session lock, not protection
against same-user storage forgery. Natural-language recognition is deliberately
bounded to direct English and Chinese requests. Arbitrary host-code isolation,
functional LocalLLM admission and multi-user application authority remain separate.

Release **0.20.364-integration.0** is published and globally installed. Source
`341799715cf2a8e955e4c3a8a29956884eb74612` and version-only release
`220bb560b13bdbba44ea8c4b37a896c6401c5787` are pushed; tagged workflow
42163474695 succeeds. Both full suites pass; the final 383 recorded inputs match
source Git blobs. All 540 archive files match the registry and global install;
293 fresh-consumer tests, 293 registry-installed tests and 73 actual global tests
pass. Audit reports zero vulnerabilities. The original incomplete live turns
remain failures in both ledgers. No application, model or LocalLLM role activated.

## Preserved repair inputs without named outputs — 2026-11-06

A real trusted CLI coding trial changed and reverted a manifest that the user
explicitly required to remain unchanged. The runtime had treated that input as
a mandatory fresh-mutation target because no separate output filename was
given. Final byte equality did not make this transient mutation acceptable.

Explicit preservation now has its own task-contract paths. Fresh-repair target
selection excludes them, and the tool dispatcher refuses matching file writes,
patch paths and recognized direct shell mutations. Ordinary read-then-edit
requests and independently requested new deliverables remain writable. This is
an instruction-following guard, not an isolation boundary for arbitrary host
code; sandbox and permission policies remain necessary.

The regression first fails on unchanged 362 source. Eleven new offline cases
cover target selection, English and Chinese preservation, patch/rename/write
and direct-redirection attempts, allowed edits and persisted repair/resume with
SCS on and off. The latter use deterministic SCS validation: seven tool turns
repair the implementation, execute a real local assertion, preserve both inputs
and resume without another mutation. No live provider quality claim follows
from scripted model responses.

The original trial's optional Codex review timed out after 90 seconds. One CLI
launch occurred; a second requested launch was cancelled before dispatch. No
independent review or completed target repair is claimed. This timeout remains
separate from the proven runtime preservation defect; application no-tools
Codex admission and LocalLLM role readiness remain unqualified.

## Lightweight cited reading and host continuation — 2026-11-06

The installed private Lite preview 8 passes a real synthetic reading workflow:
Flash produces three cited events and a sibling relationship, then fresh-process
Pro rereads a corrected passage and returns only the requested timeline. Four
provider requests take 6.636 seconds; six authorized reads preserve foreign
source rows. The host validates exact quotation/revision bindings and stores
view revisions 1 then 2. Its separate response replay makes zero model calls.
This uses host-owned SQLite history/CAS, not a new Lite session store or proof
of production application authentication, quotas or transaction recovery.

All 64 Lite tests, syntax, immutable seven-file install and focused fixture
controls pass. All four real wire exchanges/results match Flow 362 under offline
replay without new inference. The first offline fixture corrected a prototype
comparison; no runtime failure or rescue prompt was needed. No source behavior
change, new npm build or application activation is justified. See
[lightweight cited reading](lightweight-cited-reading.md) for integration boundaries.

Fresh read-only LocalLLM observations still show workstation functional
`not_configured` and no responding known Mac endpoint. Existing owner admission
and protected credential prerequisites remain open; no inference was attempted.

## Complete native turns and preserved inputs — 2026-11-06

Installed 0.20.361-integration.0 reproduces an admission defect: a scripted native write with valid
arguments and `finish_reason:length` still creates a file. The final completion
guard later refuses, so this is an unsafe dispatch rather than a false successful
result. The native model boundary now checks the original envelope before tool
normalization, planning or final-answer use. Missing legacy metadata remains
compatible; explicit contradictions fail closed without hidden fallback.

The empty-response recovery control exposes a second core defect. “Keep note.txt
unchanged” was inferred as another output after a save action on the same line.
Recovery then demanded a fresh mutation of the input. Local preservation clauses
now contribute input intent while independent explicit output declarations remain
intact; existing mutation, provenance and path guards are unchanged.

All 54 focused controls pass (34 envelope, eight native persisted runtime and 12
intent cases). They include tool/plan/finish rejection, exact fresh-process resume,
one producer, empty/reasoning-only recovery, and multilingual preservation. The
separate real Flash task reconciles two synthetic notes into one checklist in five
requests. Fresh-process Pro rereads it and explains the corrected status in
Chinese in three requests, without edits. Inputs and artifact hashes are externally
checked; runtime revision advances from 1 to 2. No LocalLLM or shell invocation occurs.

The first live verifier incorrectly required `stopped:false` although successful
native results omit that field. Its failed receipt is preserved; durable events
and file bytes verify the original completed Flash run without repeating it.
These examples do not qualify every provider, application or free-form task.
See [native assistant turn admission](native-turn-admission.md). Release/package
and global-install evidence is recorded separately after its gates pass.

## Native argument JSON has one interpretation — 2026-11-06

Installed360 reproduces a core parsing gap with a normal note-summary request.
A scripted native write_file call contains two content fields; JSON.parse keeps
the last and writes a wrong summary. The final completion guard subsequently
stops, but it does not undo that file mutation. This attributes the malformed
reply to the scripted provider and the unsafe argument admission to AgInTi.
No external model or private source is involved in the reproduction.

Nine of ten initial controls fail before repair. Native batches now preflight
strict bounded argument JSON before any schema recovery or dispatch. Repeated
decoded keys, malformed Unicode, nonfinite overflow and structural limits fail
closed; no value is guessed and no valid prefix executes. Tool-contract helpers
use the same parser so a benign schema repair cannot erase the ambiguity. The
existing bounded repair lane explicitly requests a native interface and unique
keys. Valid raw arguments and JSON-looking text content remain unchanged.

The expanded30controls pass:27 parser/normalizer/contract tests and three actual
native child-process cases. One corrected reply creates exactly one accurate
summary; a mixed batch creates neither prefix nor wrong artifact. Repeated
ambiguity stops without tool activity, releases the lease, and fresh-process
resume completes the same session with one verified summary. Persisted state and
events do not retain the synthetic wrong-content marker. Those are scripted HTTP
core tests, separate from any real-provider qualification or release gates.

See [native tool argument integrity](native-tool-json.md). This does not qualify
every legacy text decoder, a caller-supplied parser, semantic truth, application
authority or all-task autonomy. Full-suite, packaged-install, registry and global
evidence must pass separately before a release is claimed.

The first full gate catches a genuine draft compatibility regression after
348.808 seconds with 373 inputs unchanged: intercepting ordinary truncated JSON
changed its established native one-repair path. The guard now distinguishes
JSON grammar errors from complete-but-ambiguous/noncanonical data. Ordinary
syntax failures retain their prior budget/events; the local-first evaluation
returns to 18 passes. A dedicated regression preserves that distinction.

## Observed publication status is not a deployment instruction — 2026-11-06

The real native Flash task creates one accurate summary from a synthetic note in
five requests. A fresh-process Pro follow-up in Chinese asks for the latency,
whether deployment happened and the remaining check, with no file changes. The
core incorrectly derives publish evidence from the polite question. Four failed
completion attempts cause irrelevant canvas/AgentLink exploration and the run
stops after ten provider requests. Input and artifact hashes remain unchanged.

Eight of seventeen status/action controls fail before correction. Publication
inference now removes only local Chinese/English observational predicates,
retaining direct/mixed/conditional publication requests. All seventeen controls
across three profiles pass, together with a fresh-process native session case.
Combined with argument-integrity coverage, the focused set has 48 passing tests.

Without repeating the successful Flash task, the unchanged Chinese request on
the existing session succeeds in three Pro requests after correction. It reports
120 to 90 ms, no production deployment and the larger-input check; the summary
and input remain byte-identical. Runtime revision advances from the failed
revision 2 to 3; the lease is released. The actual recovery PTY capture lasts
11.699 seconds. Eighteen real requests include the preserved failed trial; this
is one bounded example, not a benchmark or all-task qualification. The first
Flash source predates later syntax-budget/intent tightening; final Pro and
offline controls bind the final runtime separately.

Final source gates pass: 48 focused tests, neighboring progressive tool selection,
truthful completion, provider handoff and local-first evaluation, syntax 316 and
zero audit vulnerabilities. After the preserved failed first full gate, the
complete final suite passes in 451.926 seconds with all 374 selected inputs
unchanged. Package, registry and global installation are separate release gates.

## Model HTTP responses have a decoded byte budget — 2026-11-06

An installed359 synthetic transport accepts32MiB of assistant text, ignores an
oversized declared body and materializes a32MiB provider-error message. The
normal request asks for a short note summary with max_tokens128. No model or
network request is needed to reproduce this core receive-budget omission; it
does not establish that a real provider emitted such a response.

Built-in native model HTTP clients now count at most16MiB of decoded response
bytes, including reasoning, tool arguments and errors. Declared oversize is
refused early; streamed and decompressed bytes are counted independently.
Overflow cancels the reader and returns bounded non-retryable local413 with no
upstream body or retry hints. It cannot authorize SDK/text-tool retries or a
provider handoff. Accepted bytes and HTTP metadata remain unchanged. Declared
SSE remains incremental under the same bound, without adding Agent streaming
semantics. Incomplete bodies avoid extra hidden SDK attempts while preserving
the core's explicit transient recovery policy.

27 transport controls cover exact/over-limit and UTF-8 bytes, real gzip and
unknown-length HTTP, socket close, bounded errors, retry/handoff policy, SSE,
deadline/cancellation/listener cleanup and intrinsic byte-chunk handling. Two
native persisted-runtime controls use actual core execution in child processes
and scripted HTTP replies: oversized plan/tool output emits no tool/finish,
persists bounded failure state without the source marker, releases its lease,
and resumes in a fresh process to write one externally checked summary.
These29controls plus23existing HTTP/request-lifecycle tests pass.

Two real canonical DeepSeek requests use the real restricted AgInTi runner,
Flash in English and Pro in Chinese. Each returns a locally validated JSON
proposal in one turn/no tools, correctly reporting120to90ms, no deployment and
the remaining larger-input check. Combined elapsed1.924seconds is this tiny
example's timing, not a performance benchmark. The first harness attempt
omitted a mandatory string maxLength and was rejected before any request;
its failure is preserved and the host schema corrected without a product
contract change. The successful actual PTY capture is retained.

This qualifies a native transport boundary and bounded examples, not production
app authorization, remote-generation cancellation or arbitrary custom-JavaScript
isolation. Lite and custom client factories retain host transport ownership;
no app, LocalLLM, credential, GPU, tunnel or service is activated. See
[model response budgets](model-response-budget.md) for exact behavior and limits.
Full-suite/package/registry/global gates remain separate release evidence.

The first full run stopped after126.686seconds in an existing one-second
retention smoke, outside the HTTP changes. That fixture could retry after its
completed receipt legitimately expired. A controlled clock probe confirms live
pending preservation, replay before expiry and fresh dispatch after expiry.
The smoke now gates the handler and uses the store's injected logical clock,
asserts it is still pending during pruning, checks replay inside the window,
then explicitly checks dispatch after the completed window. No runtime
idempotency behavior is changed. The original failure is retained; the fixed
authority smoke passes. The final complete suite passes in463.063seconds with
all369selected inputs unchanged; syntax315, audit0 and diff checks pass.

## Native session exclusion survives delayed recovery — 2026-11-06

An installed358.0 filesystem-only reproduction paused a stale reaper, let a
second caller recover and acquire the session, then resumed the first caller.
Both claims were accepted while the second was still active. This is a native
runtime durability defect, independent of model quality or application policy.
Three initial regression controls failed: delayed recovery, old malformed owner
handling, and integration invocation rejection before storage creation.

Native leases now publish initialized owner records atomically and retain inode
identity during removal. A unique hard-link removal claim and exact link-count
and name checks prevent a delayed reaper from unlinking its successor. Linux
boot/start identity distinguishes reused PIDs; live or unverifiable owners stay
protected regardless of age. Invalid records and unknown links fail closed.
Registered retained integrations keep their own authority; profile strings alone
cannot bypass exclusion. Integration entry validation precedes native storage.

Thirty-two offline controls cover six actual child-process crash boundaries,
four processes and48 serialized critical sections, delayed reapers, malformed
records, PID reuse, release failure, FD cleanup, independent sessions and early
integration rejection. Five consecutive focused runs and neighboring native
persistence/handoff/runtime/inbox smokes pass. Tests are included in pretest and
the fresh online installed-package qualification.

The first full suite stopped at web-api: session producers inherited umask002
and created group-writable directories that the new lease correctly rejected.
New index, project/Studio session roots and SessionStore directories use0700; existing unsafe modes stay
unchanged and rejected. A separate review probe also found that legacy recovery
cleanup checked the dead original owner instead of the live reaper named on its
quarantine. The corrected check and three new controls cover both failures.
The original355.123-second failed full receipt is retained; it is not a release
gate. The tightened source passes a fresh445.913-second complete suite with all
366selected inputs unchanged, syntax315, zero audit findings and diff checks.

In a bounded real DeepSeek workflow, Flash read a synthetic note and wrote one
summary. A concurrent same-session Pro resume was rejected before a provider
request, with identical state bytes. After completion, a fresh-process Pro resume
read the summary, preserved its bytes and the input, and answered the latency
and remaining-check questions. Native runtime revision advanced1 to2 and the
lease was released. Eight transport calls include two planning calls and six
step events. Initial harness assertions incorrectly required stopped:false,
counted runtime-owned .aginti bookkeeping as a model artifact, and equated step
events with transport calls. Original failed receipts are preserved; independent
state/event/file verification established success without repeating model work.

This is cooperative local-filesystem exclusion, not distributed locking,
exactly-once tool execution or retained-descriptor application storage. Older
unpatched binaries retain their stale-recovery race and need an idle upgrade.
No app, credential, LocalLLM, GPU, tunnel or production service was changed.
See [native session leases](native-session-run-lease.md) for supported behavior
and limitations. Full-suite, registry and global-install gates are recorded
separately from these source-level results.

## Remote image acquisition keeps its scope and resource limits — 2026-11-06

Four of five initial controls fail on unchanged357.1: an allowlisted URL follows
a redirect to a forbidden loopback host; a declared oversize response is
accepted; a32MiB unknown-length response is fully buffered before rejection;
and a supplied caller signal removes the independent fetch deadline. The
ordinary allowed-image control already passes. Owned loopback responders,
native Response streams and a controlled deadline clock establish a core
image-input defect without external providers or credentials.

Remote image reading now validates every redirect target, preserving allowed
relative redirects within a five-hop bound. One15-second deadline spans the
entire acquisition and remains active with caller cancellation. Streaming stops
at10MiB rather than buffering an unbounded response. Declared oversize,
redirect and error bodies are cancelled; parent listeners and timers are
removed. Successful metadata preserves the requested URL and actual byte hash.
Acquisition errors cannot invoke a perception provider or wrapper fallback.

Twenty-seven focused controls cover a real stalled HTTP body timing out
with a live caller signal, cancellation before headers/during the body, allowed
redirect statuses, later-hop scope rejection, exact/over-limit bytes, cleanup
and ordered native-client input. A local protocol fixture receives the exact
PNG bytes once; retained JSON/Markdown stores metadata and a labelled synthetic
reply without pixel bodies or the fixture credential. This is not a real vision
quality test. New tests run in pretest and the fresh online packed-consumer gate.

The initial26-case candidate passed a446.188-second full suite. Review then
reproduced an unnecessary new final-URL field retaining hidden redirect
credentials. That field is removed before publication; an additional regression
checks typed and retained JSON/Markdown for the synthetic credential. The
preliminary package/full/demo receipts remain separate. The tightened source
passes a fresh452.163-second full suite with363selected inputs unchanged,
syntax314/audit0/diff checks. Existing fixed-port document HTTP checks preserve
their occupied18102 skips. Package, registry and global installed-consumer
qualification remain separate release gates.

The hostname rule is the existing server-owned allowlist, not DNS pinning or an
SSRF-proof application gateway. No application, model, GPU, credential, tunnel
or production service changes. Workstation functional LocalLLM admission stays
not_configured; the existing Mac route reaches SSH but its loopback8008 refuses
connections. Neither observation authorizes new LocalLLM inference.

## Published browser runtime and online consumer qualification — 2026-11-06

Release 357.0's CI, archive and offline installed tests passed, but the ordinary
global install failed: its Playwright range resolved 1.65.0 while the required
playwright-core 1.65.0 was unavailable in the registry at that observation.
The previous global356.0 installation's506 files and saved DeepSeek preference
remained unchanged. No forced or offline global install was substituted.

The repository lock had qualified Playwright/core1.59.1. The published manifest
now pins that exact browser version, with a consumer regression checking the
actual installed Playwright/core pair. A package lock alone cannot constrain
global consumer resolution. A fresh online candidate install now succeeds and
passes16 HTTP/package controls; this is separate from the earlier warmed-cache
qualification.

`npm run pack:verify-runtime` packs into a temporary directory, resolves public
dependencies with prefer-online and scripts disabled, verifies both CLI versions,
then runs the installed browser-pair and model-HTTP controls. It is required by
the trusted publish workflow before publication. Temporary state is removed;
there is no provider inference or browser download. The model HTTP repair and
its two real canonical model probes remain unchanged; no model test is rerun
merely for the packaging follow-up.

The packaging full suite passes in 420.281 seconds with all 362 selected inputs
unchanged, including the publish workflow. Audit has zero findings; the new
script and test pass explicit syntax checks. The exact browser pin changes no
locked installed runtime version. The follow-up is released separately so the
357.0 online-install failure remains an immutable, visible checkpoint.

## Model requests stay on the configured route — 2026-11-06

A local HTTP reproduction found a reusable core transport defect. Before the
repair, five redirect-status cases reached another origin; HTTP 307/308 also
forwarded a synthetic private prompt body. A same-origin redirect silently
selected another handler. Ordinary completion and cancellation before headers
and during a stalled body were already correct. Six of ten original controls
failed; no external provider, credential or model was used for reproduction.

All owned OpenAI-compatible model clients now share a no-follow default. Manual
redirect handling preserves the 3xx status without an SDK retry, while the
hosted integration client's existing strict error policy is retained. Redirects
cannot trigger reasoning/tool-protocol compatibility retries, transient-error
repair or provider handoff even when the response body impersonates those
failures. Safe chat returns a bounded non-retryable error with no answer; image
perception does not forward pixels or repeat a reasoning request. Injected host
callbacks remain the caller's transport responsibility; documentation examples
now set their redirect policy explicitly.

Fifteen offline HTTP/policy controls pass, including real test-owned loopback
servers, unchanged native payload/authentication, socket closure on cancellation,
safe-chat and image requests, and misleading redirect error bodies. Forty-six
combined HTTP/lifecycle/completion tests pass. No production listener, app, provider route,
model, credential, service or LocalLLM admission was changed. This is a model
transport fix, not a general public-URL downloader or universal privacy claim.

A final review reproduced a stalled redirect body after the first no-follow
draft. The shared transport now cancels and discards that body and its headers
before SDK error parsing, preserving only the 3xx status. It neither waits for
the body nor propagates retry hints or diagnostic instructions. The original
failure and the passing pre-refinement full suite remain separate evidence;
the refined source receives a new full-suite gate before release.

The refined full suite passes in 416.158 seconds with 359 selected inputs
unchanged. Syntax covers 313 files; audit has zero findings. Two existing
document HTTP tests skip occupied port 18102. A separate native-body-reader
observation confirms abort rejects and closes its owned socket. Two bounded
real canonical DeepSeek checks, one Flash and one Pro with retries disabled,
return the exact requested markers over HTTP 200 with no redirect. These are
transport checks, not a new broad model-quality or application qualification.

## Retrieved instructions stay untrusted — 2026-11-06

The next app-backend qualification uses an ordinary current-notes request with
hostile English/Chinese/Japanese annotations in authorized source records. Seven
offline controls cover a source-backed initial/follow-up proposal; denied
write/delete tools, account/path selectors and a mixed invalid batch after an
authorized read; and independent host rejection of schema-valid fabricated text.
No reusable runtime defect reproduces. No runtime/version/dependency change is
made; the new test and fixture are included in the package's self-test surface.

The real installed 0.20.356-integration.1 SDK passes four DeepSeek requests in
7.26 seconds: two Flash turns for an English request, then two explicitly chosen
Pro turns for a Chinese follow-up. The host owns the scope/history and changes
revisions 7/12 to 8/13 between invocations. Both models reread the current source,
preserve exact IDs/revisions/text/order, ignore hostile annotations and do not
change owned or foreign files. The foreign record's bytes never appear in a
provider request. This is an actual terminal capture with original timing, not
a status-card replay. A preliminary four-request run passed the model boundary
but used an inconsistent host revision update; its evidence remains separate,
and only the corrected fixture supports the current qualification.

The host's explicit read scope, absence of write tools and external source check
remain essential. The SDK does not prove arbitrary semantic correctness or
universal prompt-injection resistance. This case does not qualify a production
app's authentication/database, native SessionStore, automatic provider fallback,
LocalLLM admission or an app-safe Codex transport. Those separate gates stay
open. No application, service, model, credential or tunnel is changed.

Full npm test passes in 418.163 seconds with all 357 selected code/test/package
inputs unchanged. Syntax covers 312 files; the dependency audit has zero
findings. The two new files also pass explicit node syntax checks. Existing
fixed-port document HTTP tests retain their occupied-port skips, without
stopping the foreign listener. Package and installed-consumer checks are kept
as separate candidate evidence, not an assertion that a new version was published.

## Partial read outage and explicit process recovery — 2026-11-06

A new backend qualification covers a successful read followed by temporary
unavailability. Two deterministic controls exercise serial and batched native
calls in separate worker processes. Both require no partial proposal, an exact
host-issued unavailable category, unchanged source bytes, and an explicitly
authorized fresh-process Pro invocation that rereads current source state.
No core defect reproduces; runtime sources/exports/lock/version are unchanged.

Installed Flow 356 passes the real counterpart with five DeepSeek requests in
6.29 seconds. Flash makes two turns, reads revision 7, then stops at the injected
second-read fault. It returns TOOL_FAILED/unavailable and no proposal. After
that process exits, the synthetic host updates source-a to revision 8 and
authorizes Pro. A distinct worker restores the original Chinese user history
and host failure receipt, rereads both records in three turns and returns the
exact current revisions/text/order, including the new remark. Independent raw
wire/source/process checks pass; source bytes remain unchanged within each SDK
invocation. The operator's between-invocation edit is explicit, not an agent
write. No automatic retry/fallback, model request after the failed read or
source-absence claim occurs.

An actual PTY capture records the process/model/read/result output with original
timing. The video derives from that captured terminal stream, not a status-card
slideshow. It uses synthetic host records/history and an injected read outage;
it does not qualify production app auth/DB/transactions, remote work termination,
native SessionStore, LocalLLM admission or an app-safe Codex transport. No model
or source fixture is rerun merely for a new recording. The existing published
and installed version remains 0.20.356-integration.0.

Full npm test passes in 417.367 seconds with all 355 selected code/test/package
input hashes unchanged; syntax covers 312 files, the dependency audit reports
zero findings and diff checks pass. Two existing fixed-port document HTTP tests
skip occupied 18102; the foreign listener is preserved. This tests/docs source
snapshot does not replace the registered 356 archive or enable a provider.

## Dependency-free root proposal backport — Lite preview 8, 2026-11-06

The lightweight SDK retained the same root-schema mismatch fixed in Flow 356.
Six of seven targeted groups fail on unchanged Lite preview 7; the object-root
control passes. Preview 8 backports only the final transport envelope, retaining
text-only input, deadlines, cancellation, capacity, schema and callback bounds.
No new dependency, export, executable, ambient provider or fallback is added.

All 64 offline tests pass, including two reproducible package builds and an
offline installed consumer whose network and non-allowlisted imports are
forbidden. The exact seven-file archive is 69,977 bytes unpacked; runtime source
is 37,112 bytes. Each archive file matches the committed Git blob. Four request
pairs from ordinary English/Chinese list fixtures are byte-identical to the
registry-installed Flow 356 reference under scripted transport. Hosted model
calls: 0; existing Flow live evidence does not independently qualify Lite or an
application's authenticated transport.

Immutable source `72a94cf8570ee22469f3e2def6cdb6fe311f05c9` is pushed to the existing
AgInTiFlow repository's separate sdk/agintilite-root-proposal-20261105 branch.
Canonical local Lite main fast-forwards cleanly to it; Flow branches are not
merged. Package SHA-256 is
b62c9b1a76c09d6664f465c0983e48c7ed259b5091e028bc46280bff1e19ffe2.
The private local preview is not published to npm or installed globally. App
owners retain pinned-source adoption, provider/routing consent, account scope,
citations, state and quota ownership. No Bunko or other app source/runtime,
credential, service, model or tunnel is changed. Flow remains installed at
0.20.356-integration.0.

## Root proposal types on native provider wires — 2026-11-05

The restricted SDK accepts list/scalar/root-union proposal schemas, but its
native adapters previously sent those schemas directly to object-root wire
protocols. DeepSeek also instructed the model to return an object matching an
array/scalar schema. Five of six initial regression groups fail before the
repair; the first dependency-link setup failure is retained separately and is
not counted as a runtime reproduction. This is a generic provider-adapter gap,
not a model-quality, prompt-specific or app-policy defect.

The native adapter now envelopes only non-object final proposals in exactly
one closed proposal property, then unwraps before the original schema check.
Object-root profiles retain their wire, including literal proposal properties.
Tool calls/arguments/results, output budget, cancellation, retry and routing
policy are unchanged. Seven controlled groups cover list/scalar/union/falsey
values, whole native read batches, malformed/duplicate/extra wrappers, caller
alias mutation and ordinary multilingual host-backed requests.

One bounded real qualification uses four DeepSeek requests in about five
seconds: explicit Flash English and Pro Chinese, one current host read/two
turns each. Ordered two-record lists preserve exact IDs, revisions and content
despite stale history. Synthetic host files remain byte-identical, no automatic
retry/fallback or unhandled rejection occurs. Independent body/source/result
review is retained outside Git. This does not qualify production app auth/DB,
native SessionStore restart, LocalLLM admission or live OpenAI behavior.

The final focused set passes 67 groups and the full npm suite passes in
415.164 seconds with all 353 selected code/test/package hashes unchanged.
Syntax covers 312 files, the dependency audit has zero findings and diff checks
pass. Two existing fixed-port document HTTP tests skip occupied 18102; the
foreign listener remains untouched. Publication and installed-package evidence
are separate release gates, not inferred from the source tests.

## Restricted Codex admission — prerequisite remains unavailable, 2026-11-05

The remaining optional application fallback is examined with a credential-free
local transport diagnostic, rather than assuming the trusted wrapper is safe
for app chat. Installed Codex 0.166.0 makes one synthetic Responses request
using a temporary home/config/workspace and explicit feature disables. The
fixture returns an intentional error before any model output. Its advertised
catalog still contains request_user_input, including with default-mode input
explicitly disabled. Strict no-tools admission fails; no provider, app, auth,
model or service is activated. This is not an AgInTi runtime or model-quality
failure and does not justify changing the trusted wrapper.

Five offline control groups prove that any advertised tool blocks no-tools
observation, even when tool_choice says none; missing/malformed/hostile catalogs
fail closed; and even an empty catalog cannot self-attest production readiness.
The optional diagnostic is separate from ordinary tests and requires an exact
trusted executable path. It cannot enable a capability or supply credentials.
See [the admission contract](codex-application-admission.md). Source changes are
tests/diagnostics/documentation only; runtime/exports/lock/version and installed
355 remain unchanged. No new npm release is justified by this checkpoint.

Full npm test passes in 407.886 seconds with all 351 selected code/test/package
input hashes unchanged. Syntax covers 312 files, the production audit has zero
findings, and all 14 existing optional-wrapper lifecycle cases pass. No hosted
Codex or DeepSeek inference is performed for this diagnostic slice.
Two existing fixed-port document HTTP checks skip occupied 18102; the foreign
listener is preserved and no new live HTTP qualification is inferred. Candidate
package inspection finds 504 files, no private paths or credential literals,
and 65 actual temporary-install SDK/recovery/concurrency/admission cases pass.
This tests/diagnostics archive is not the registered 355 archive.

## Concurrent restricted scopes and cancellation — qualification, 2026-11-05

The current registry-installed 355 SDK passes a new backend interaction test:
two account-bound conversations share one provider transport, one is cancelled
during its read, the other completes, and the first explicitly continues on Pro
after old work settles. Both records use ID 1. Host history/state are synthetic
and owned by the fixture, not persisted by the SDK or a production application.

Two offline cases cover late read success and late rejection, retained capacity,
reused scoped tool IDs, independent cancellation and language/history isolation.
A completion-order assumption in the initial fixture assertion is removed;
concurrent reads are compared independently of their order. No runtime defect
reproduces, so only tests, test wiring and documentation change.

The one-shot live run uses five real DeepSeek requests in approximately 5.1s:
three Flash and two explicit Pro. The cancelled run returns no proposal and
holds its slot until the gated read settles. The other account returns its own
English revision31 answer. Pro later reads current revision6 and preserves the
Chinese subject and newly added remark. Independent request/body/state review
finds no foreign history/source and confirms no SDK record mutation. Parent
listeners are removed and no unhandled rejection occurs. This is not a live
generation-cancel, process restart, database-transaction, app-auth or aggregate
resource-admission proof. The SDK bytes match published355; no new release is
needed. Full npm test passes in410.236s with all339 runtime/test/package inputs
unchanged. Syntax/audit/diff checks pass. The candidate package has501 files,
no private paths and60 actual temporary-install SDK/recovery/concurrency cases.
It is an unpublished tests/docs snapshot, not a replacement for the registered
355 archive. Runtime sources/exports/lockfile and installed355 remain unchanged.

Read-only workstation GETs still report catalog ready but functional readiness
not_configured/ready:false/fresh:false. The existing Mac SSH route works, while
loopback8008 health/capability connections remain unavailable. No model,
credential, service, tunnel or maintenance-fence action is taken. These are
dated observations, not a granted client profile or permission to infer.

## Research provenance and bounded correction — release candidate, 2026-11-05

The prior failed live review proves a provider-output protocol problem: runtime
metadata was quoted as if it occurred in retained source text. Three test-first
native SessionStore controls reproduce the missing correction path. Policy v2
adds one durable, same-provider quotation correction after full inventory
validation; it never accepts the bad verdict or weakens semantic review.
Reservations bind the exact batch and survive restart/response loss. Cancellation,
foreign/malformed inventory and exhausted correction remain fail-closed.

A new twelve-request whole-agent check then reaches valid semantic rejection,
but replacement repeats a rejected note. The retained evidence exposes a
contradictory synthesis instruction: put coverage gaps in uncertainties while
requiring those entries to be source-backed. Unquoted extraction limitations
and reader metadata were also included in supposedly verified synthesis input.
Those observations now remain diagnostic. Bibliographic projection reduces the
input, optional arrays may be empty, and replacement feedback binds each exact
rejected statement to an explicit replace-or-omit action. The unchanged-rejection
guard is preserved. The failed live attempt remains failed, not retroactively
qualified. Prior cumulative Python requests were 34; this attempt adds 12.

Focused coverage passes 77 groups, including durable retry exhaustion,
response loss, cancellation, later-row inventory attacks, malformed reservation
records, earlier policy refusal and synthesis input boundaries. Another live
attempt completes native research in eight requests, but an invented CPython
implementation subquestion prevents safe answer selection and the parent again
paraphrases. It remains a failed final-acceptance case. Official-docs planning
now stays within its requested source class; disclosed native coverage gaps
cannot reopen unreviewed paraphrasing. The persisted regression covers a scoped
answer plus a poisoned parent, retaining the native coverage caveat and all
mandatory evidence gates.

The final fresh whole-agent attempt passes in six requests: Flash parent/plan/
extraction and Pro synthesis/assessment, then the finish-only parent turn. Its
13 assessed statements pass without correction or replacement. Final output
equals the native assessed answer, preserves normal termination/break/return/
exception conditions and exact source quotations, and writes no workspace
files. Independent fresh HTTP has the same raw HTML hash and matches all six
extracted quotations; finite Python examples corroborate the control-flow
conditions. A separate OS process replays the native state with no model,
source or network calls and unchanged report/checkpoint bytes. Python live
requests total 60 across the refinements, including the retained failures.
This qualifies a bounded official-corpus workflow, not broad discovery, formal
entailment, app deployment or LocalLLM admission. The full npm suite passes in
419.497 seconds with all 337 tracked runtime/test/package inputs unchanged.
Syntax covers 311 files and the dependency audit reports no vulnerabilities.
The two existing document HTTP checks skip occupied port 18102; the foreign
listener is preserved. Package inspection has 498 files and no private-state
paths. Registry publication/install qualification is a separate pending gate;
no publication is claimed by the source tests.

## Structured research-note authority — candidate, 2026-11-05

The preceding live failure identifies a reusable report contract gap: paragraphs
carry evidence arrays but contradictions and uncertainties are free-text strings.
The provider can satisfy the old schema while omitting note citation bindings.
Two new test-first controlled native cases fail on source45ef0ad: typed notes
are discarded after schema rejection/fallback, and a missing-binding repair
does not occur. These fixtures use real SessionStore research state with scripted
providers; no inference or network is needed for the reproduction.

Native schema16 gives every note an explicit text/evidenceIds record. The audit
derives its sources; the same source-context gate assesses it and rendering keeps
its citation. Inline citation-looking prose grants no authority. Missing bindings
remain rejected until a valid replacement supplies existing evidence and passes
review. Unknown/unverified IDs, hostile data and cache tampering fail closed.
Replacement input is projected to its exact schema rather than leaking derived
runtime fields. A schema-invalid provider report cannot disappear behind a
deterministic fallback; the existing empty-response fallback is preserved.

New controls cover typed note rendering/restart, binding repair, spoofed inline
citations, all three note fields, malformed records/arrays, rejected schema15
replay and unchanged tampered checkpoint bytes. The actual persisted outer-agent
control now includes a corrected, cited uncertainty. Existing multilingual
positive controls also carry structured notes.

The ordinary persisted research prompt also exposes three outer-runtime gaps:
mentioning Python invents a command-execution obligation, the initial runtime
envelope looks like a requested local source, and a summary-only tool result
omits explicitly requested quotations. Explanatory intent and native scaffolding
now retain their proper boundaries; the tool delivers bounded assessed quotes.
For a simple fully covered read-only quote request, completion keeps the assessed
native answer rather than a new unreviewed parent paraphrase. Compound/format
requests and existing completion gates remain in effect. A persisted regression
supplies a false parent conclusion and verifies that it never becomes the final
answer. Cache integrity, stale work and incomplete coverage controls fail closed.

The focused controlled set passes 68 groups. Deep-research, scoped-artifact,
progressive-tools, dynamic-budget, SCS, truthful-completion and wrapper lifecycle
checks pass, along with syntax and the dependency audit. These are offline
protocol/regression controls, not proof of general model entailment.

The first full suite fails after 403.487 seconds in the existing model-roles
static-JSON control. The new positive-execution helper was applied too broadly
and invented a shell obligation for ordinary file verification. Its use is now
limited to deciding the explanatory exception; existing file evidence rules stay
in force. A scoped/unscoped JSON regression and the model-roles smoke pass.
The failed log is preserved rather than counted as a green run.

The final full suite passes in 427.429 seconds with all 337 tracked runtime,
test and package inputs unchanged during execution. Syntax checks cover 311
files. Candidate packaging includes 498 files and no private-state paths;
the temporary installation qualifies the runtime separately from the installed
registry release. A separate OS process replays completed native research with
zero model/source/network calls and unchanged checkpoint/report bytes. Fresh
public-source retrieval confirms all eight retained quotations, and finite
Python cases independently check normal, break, return, exception and continue
behavior. The fresh HTML hash differs; unchanged whole-source bytes are not
claimed. These component results do not overturn either failed live acceptance.

Live acceptance remains HOLD. The four earlier Python attempts used 26 requests
in total: instruction routing failed, native provenance/quote handoff needed
repair, and a six-request structural completion produced an unsafe parent
paraphrase. Its independent review is failed; the original receipt is retained.
One final bounded check used eight requests. The reviewer cited runtime metadata
(`readerTruncated`) as a source quotation; native validation rejected it. No
reviewed answer completed, and the request cap ended the run. Cumulative Python
requests are 34, not six. No further paid retry is part of this checkpoint.
No new version, publication, installation or app activation is claimed.

## Research source-context assessment — candidate, 2026-11-05

A real public-source comparison passes all 23 exact quotation checks but loses
the governing section scope in a standalone finding. The comparison remains
failed semantic acceptance. A separate controlled native research reproduction
supplies both conditions in full, yet installed 352 and 354 complete the
unconditional claim with citation coverage 1. Those fixtures use real
SessionStore checkpoints and three scripted phases, with no inference or
network request. The gap is promotion of extracted/synthesized interpretations
without source-context assessment, not evidence fetching or provider handoff.

The candidate adds a mandatory bounded assessment before native live research
completion, one replacement at most, and policy/content-bound checkpoint replay.
It keeps extraction interpretations explicitly unreviewed and labels the
deterministic citation audit as linkage only. Unsafe or unavailable assessment
cannot expose an asserted answer/report. Existing raw diagnostic evidence is
preserved; an old checkpoint is not silently migrated. Schema 15 and the outer
session cache reject quotation-only and dry-run completion shortcuts.

Controlled tests cover positive and rejected English/Chinese/Japanese scope,
quantitative direction, disclaimer bypass, cancellation, strict response
inventory and quote binding, oversized UTF-8 context, partial-batch restart,
tampered/legacy/malformed checkpoints and persisted outer-agent delegation.
The protocol-only approval fixture used by older positive mocks is not a
semantic evaluator. A model-assisted assessment can itself be wrong, and these
offline cases do not qualify universal entailment or a live provider's quality.
The final focused set passes 42 groups: 21 new assessment groups, nine quotation
groups and 12 domain-policy groups. Deep-research, scoped-artifact research,
dynamic-budget and progressive-tools smokes pass. A domain-cache fixture now
uses scripted empty search rather than accidentally depending on network
timing. A stale positive progressive-tools fixture now supplies the current
assessment metadata; the first full-suite failure at that assertion is preserved.

A new ordinary one-specification question makes six real DeepSeek requests in
total: one plan, one extraction, one initial synthesis, two assessments across
candidate-contract refinement, and one replacement. The initial filename-only
corpus metadata fails strict source selection; explicit publisher metadata
allows the same checkpoint to proceed without repeating planning. The first
assessment violates the uncited-row contract and fails closed. The candidate
then supplies each row's allowed verdicts explicitly. Its next assessment
rejects factual notes without evidence IDs, but the bounded replacement repeats
those notes, so the run remains blocked. This is failed task completion, not a
successful live research answer or open-web discovery test.

Independent Python verification retrieves the original specification again,
matches its byte hash and all three retained quotes, and confirms no public
answer, report or workspace file escaped. A fresh OS process replays the blocker
with zero source/model dispatch and unchanged checkpoint bytes. There is no
additional paid retry. Package candidate inspection finds 497 files, no private
paths or credentials, and passes 229 actual temporary-install tests. No registry
publication, global installation or application activation is qualified by this
candidate. Live completion remains HOLD even though the safety behavior passes.

## Durable lock-release observation — 2026-11-05

The tagged 0.20.353-integration.0 release gate fails before publication. An analysis
coordinator operation finishes, but its directory-lock release observes a
successor concurrently removing the retired lock quarantine. The unstable
inventory becomes INTEGRATION_AUTHORITY_BUSY and then EXECUTION_UNAVAILABLE.
The publish step is skipped; the failed immutable tag is not rewritten.

Eleven controlled regressions use real temporary directories and bounded gates.
Installed 0.20.352-integration.0 fails five, including both directions of concurrent cleanup,
owner unlink between open and fstat, final binding disappearance, and replacement
identity classification. The candidate passes all eleven in ten repeated runs.
Tests also preserve changed-owner, symlink, persistent-instability and EIO
failures, exact successor-owner bytes, handler call counts and exclusion.
An independent Python oracle verifies 32 distinct operations from four Node
processes: contiguous on-disk records, exact responses, one exclusive active
marker and no residual lock/quarantine directories. No model or network request
is used in these fixtures.

Only unstable metadata observation is retried, with at most 32 snapshot attempts
and the original retired device/inode required on every attempt. Exact absence
after concurrent cleanup is accepted; replacement, unsafe inventory and genuine
I/O errors remain failures. An existing owner must still match the retired
owner token. A missing owner in that previously verified retired inode may be
finished as partial cleanup. Neither the semantic handler nor an external worker
is redispatched, and the successor's canonical lock is never a cleanup target.
This does not change retained-descriptor admission, claim same-UID forgery
protection or enable any public runtime capability.

Pre-release review catches a missing corrupted-owner control in the first
candidate: JSON null/false could appear absent after retirement. That candidate's
full suite is stopped and preserved as superseded, not reported as passing.
Owner files now require an actual object; null, false, zero, strings and arrays
are explicitly rejected. Only a physically missing owner file is partial cleanup.

The final full npm test passes in425.158 seconds with runtime/test/package hashes
unchanged throughout the suite. It includes the original failing coordinator,
authority, session/recovery, CLI and Studio checks. Syntax310, production audit0
and diff checks pass. Two fixed-port document HTTP checks skip occupied18102;
the foreign listener is untouched. The final four-process oracle retains its
synthetic records and binds the frozen runtime hash. No live inference is needed.

## Exact research-quotation integrity — 2026-11-05

Installed352 reproduces a core evidence-verification defect through real
SessionStore research checkpoints: a source says -10, a scripted extraction
quotes +10, and the run completes with quoteVerificationRate1. The matcher erased
symbols/punctuation and lowercased text, so numerical direction, comparisons,
percent signs and unit case could change while retaining citation authority.
The reproduction makes no real model or network request; it is not an observed
live-provider hallucination. A first incomplete fixture lacked SessionStore's
artifact writer; the decisive reproduction uses the real store.

Matching now normalizes only Unicode NFC and whitespace layout. Case, signs,
operators, punctuation and units remain exact. The persisted quotation must
also be unchanged by bounded storage projection before it can be verified.
The policy binds checkpoint fingerprints, refusing old explicit IDs without
overwriting their state/report. Current exact evidence remains restart-cacheable.
Nine regression groups cover English/Chinese/Japanese mutations, scientific
notation, percentages, case, whitespace/NFC, oversized quotes, unreadable excerpts,
blocked synthesis, restart and legacy-cache preservation. The initial set has
one pass/eight failures; all nine pass after the fix, as does deep-research smoke.
Textual quotation integrity is not semantic entailment or universal research
quality. Application/source admission and live task acceptance remain separate.

A new ordinary two-document comparison makes four real requests: Flash planning,
two Flash extractions and Pro synthesis on the explicitly configured same-provider
main role. All23 quotations pass the stricter matcher. A fresh SessionStore and
a separate OS-process cache read dispatch no source/model work and preserve
state/report/event bytes. The host admits a fixed public-document corpus; this
is not broad web discovery or app activation. Independent semantic review finds
a standalone finding that loses its source's isolation-level scope. The full
answer is therefore not accepted as deployment advice despite valid quotations.
No paid rerun or detailed rescue prompt is used to relabel it. Quote-integrity
qualification and source-entailment acceptance are recorded separately.

Independent Python rereads match both raw source hashes and all23 quoted
passages. Six altered-receipt controls pass; the labelled15-second replay states
the failed semantic acceptance explicitly. Full npm test passes405.612 seconds
with runtime/test/package hashes frozen; syntax310, production audit0 and diff
checks pass. Two occupied18102 HTTP checks skip locally without touching the
foreign listener. No paid task was rerun after the semantic review.

## Server-owned research scope — 2026-11-05

Installed351 accepts a model-supplied outside domain in place of a configured
research allowlist. The native guard permits the read, the reader invokes its
fetch callback, and search admits the outside result. A persisted normal-prompt
fixture reproduces that source read. This is a core authority-composition gap,
not an upstream model-quality failure. All eight initial regressions fail before
the repair; controlled transports perform no external HTTP or model requests.

Research arguments now intersect with server-owned domains. Parent/subdomain
restrictions retain their existing meaning; an empty task list keeps the server
restriction, while invalid/disjoint lists stop before callbacks or persistence.
Snippet research no longer replaces server configuration. Effective domains
also bind deep-research checkpoint fingerprints and pass to explicitly permitted
hosted research. Redirect/canonical, alternate-PDF, dry-run and cached-policy
controls accompany the persisted read denial. These checks do not attest an
app sandbox or constrain arbitrary injected host callbacks. Other applications,
LocalLLM roles, credentials, services, provider defaults and Lite remain unchanged.

Twelve focused groups, an independent 4,356-membership oracle and six tampered
evidence controls pass. A later approved public-page read matches independent
response bytes; earlier fetch failures remain recorded with original cause
unproven. No automatic retry or new inference is added. A labelled 15-second
evidence replay and receipts are synced to Nutstore. The first full suite stops
because the global dependency graph needs an absent Playwright browser. After
correcting only the owned dependency link to an existing lockfile-matched graph
(107 installed versions, optional Darwin fsevents absent), full npm test passes
in415.148 seconds with runtime/tests frozen. Syntax310, audit0 and diff checks
pass; two occupied18102 HTTP checks skip without touching that foreign listener.

## Bounded scholarly-source pacing — 2026-11-05

The installed350 built-in Crossref path reproduces an independent core gap:
two callers overlap while the first response is pending, so a controlled source
returns429 to the second. Crossref's July2026 public-list contract is one request
per second/one concurrent request. Sequential model tools also issued list
queries less than a second apart in the earlier failed live fixture. Those
failures remain recorded; an HTTP200 diagnostic was not a task acceptance result.

Built-in Crossref now shares one bounded, body-aware process-local read gate.
It spaces completed callbacks by1100ms, observes stricter rate/Retry-After
timing, preserves original queue deadlines and removes cancelled queued work.
Ignored active cancellation remains charged through original settlement. Close
drains queued admission and waits active work; no idle wake timer or automatic
retry is added. Invalid/out-of-bound timing closes only that Crossref lane.
Other provider routes, privacy/domain checks and tool permissions are preserved.
The optional read-request-gate export provides the same transport scheduling to
trusted hosts without HTTP/model/environment authority or persistence.

Ten offline regressions cover FIFO/body lifetime, spacing, cooldown, native
deadline, cancellation/late rejection, queue capacity, strict options, close,
malformed source timing and independent providers. The neighboring deep-research
smoke passes. A two-query live built-in preflight returns200/200, observes the
public-array1request/1s/concurrency1 headers, and preserves all source kinds.

A separate one-shot typed journal-article profile uses the same ordinary user
prompt and initial native request bytes as the earlier failed typed fixture.
Flash makes3 real requests/two searches+two metadata reads, all four source
responses200. A fresh-process Chinese Pro follow-up makes1 request/no reads and
preserves both exact references; both years are2026, so this is a stable tie,
not evidence of a changed chronology. Independent registry reads verify title,
year, DOI, URL and declared journal kind. Lite replays identical native exchanges
without inference. The model chose different query text; the controlled test
isolates the pacing defect, while the live run is a new bounded acceptance case,
not a deterministic causal/latency comparison. Total real model requests:four.

This qualifies one metadata-only process-local profile, not full-text findings,
peer review, paper quality, arbitrary sources, production multi-process source
admission, native SessionStore durability or application activation. Gates do
not coordinate other processes/clients sharing an IP or persist across restart.
Existing apps, credentials, LocalLLM/GPU/services and Lite package remain unchanged.
Full npm test passes in435.242 seconds with frozen source/test/package hashes;
syntax310 and production audit0 pass. Two existing fixed-port18102 document
HTTP checks skip locally. No duplicate full suite or additional inference was
needed after this checkpoint.

## Safe read-tool failure metadata — 2026-11-05

A normal public-paper request exercised live Crossref discovery with DeepSeek
Flash, followed by a separate-process Chinese Pro continuation. Exact title,
year and DOI identity passed independent registry checks, but one selected
record was classified `other`, not an article. The initial structurally valid
result therefore fails paper-task acceptance. The host research profile had
omitted publication kind; this was not a fabricated citation or a core schema
bypass. Its original receipt is preserved, not relabelled as passing.

A typed profile retains the same user prompt and validates article kind on
discovery and metadata reads. Two attempts stop with TOOL_FAILED during the
second search; the instrumented attempt captures HTTP429. No Pro continuation
or answer follows either failed attempt. Total real model requests across the
three recorded attempts are six; source HTTP attempts are eight. A separate
read-only diagnostic later returns200 but does not prove the earlier unknown
HTTP outcome or qualify a successful typed search. Public-paper discovery stays
HOLD pending a reviewed source-rate/availability contract and successful task
acceptance. No more live requests were made to chase a green result.

This exposed a reusable SDK capability gap: a host could declare a safe provider
failure category but had no equivalent read-tool signal. The additive
createRestrictedToolFailure export preserves TOOL_FAILED plus optional frozen
toolFailure metadata. Its same-module private brand admits only explicit host
classification, never raw Error/status fields, JSON/model output, proxies or a
different SDK copy. Provider and tool channels are separate. Raw errors remain
opaque; cancellation, deadline and bounded capacity retain precedence. A failed
read returns no partial proposal, later batch read, retry or extra model turn.

Five new regression groups fail before the API; all55 SDK and57 Lite tests pass
after it. They cover closed options, zero-hook hostile data, channel separation,
native OpenAI/Flash/Pro batches, cancellation/late rejection, deadline overrun,
capacity cleanup and real loopback HTTP error mapping. Recorded native request
bytes replay exactly in full SDK and Lite; the source429 becomes a safe explicit
rate_limit only when the host issues it. Six independent evidence-tamper checks
pass. This is not automatic HTTP classification or a successful live search.
The dated Nutstore evidence replay records failures and limitations explicitly.
Application vendors, state, routing and services remain unchanged.
Full npm test passes in429.910 seconds with frozen runtime/test hashes;
309-file syntax, production dependency audit and dry packing pass. Two existing
fixed-port18102 document HTTP checks skip the occupied listener. The additive
SDK error channel does not qualify successful source-rate handling or a live
application backend, and does not change LocalLLM admission or Codex routing.

## Consumer boundary qualification — 2026-11-05

Read-only Bunko source review pins64de224a89193512f664f393129a38b6bc9ae858;
the web worktree050852791340ad2f0118bd53009b1643ef53e2ef has identical adapter
and test bytes. Its seven focused tests pass in disposable copies with both
vendored Litepreview1 and the qualified preview6 archive. Module imports are
allowlisted, fetch denied, model/network attempts zero; application files and
Git states remain unchanged. No live/deployed app behavior is claimed.

Adversarial probes show why compatibility is not full qualification: the custom
host parser can discard duplicate final keys, multiple choices and mixed
tool/final metadata before returning a valid SDK value. Refusal becomes a
repairable output error. Its24000-code-unit producer can split a surrogate pair;
both vendors reject a valid whole transcript before provider invocation.
These are consumer adapter/producer findings, not a demonstrated core bypass or
an observed live provider incident. Downstream app citation/store checks are
outside this qualification. App repairs stay with the app owner.

Three generic regression groups document the boundary: native factories reject
original malformed protocol/duplicate arguments before reads; a trusted generic
callback owns earlier interpretation; every typed text part must be independently
Unicode-valid. SDK50 and the same three portable Lite controls pass. No runtime,
provider, export, dependency or version change is needed. Installed349 and
private Litepreview6 remain pinned; no new publication/vendor update is implied.
Full npm test passes in496.944 seconds with frozen runtime/test hashes and
309-file syntax. Production audit reports zero findings; dry pack contains489
allowlisted files/no private paths. Two existing occupied18102 document HTTP
checks skip locally. Executable sources, exports, package metadata and lockfile
are byte-identical to the349 release.

## JSON enum equality and public-reference handoff — 2026-11-05

Preparing a bounded reference workflow reproduced a general validator defect:
an exact allowed object succeeds in schema key order but fails OUTPUT_INVALID
when its keys are reordered. This is a core JSON-instance equality bug, not a
provider error. The correction compares snapshotted JSON structurally: object
keys are unordered, arrays ordered, primitive types/values and Unicode spelling
exact. It neither reorders proposals nor changes schema/wire bytes. Four new
groups reproduce3 failures before the repair; SDK47/Lite52 pass after, including
tool args/results, mixed-source binding and zero-hook hostile-data controls.

The first ordinary two-reference Flash fixture used two searches followed by
two metadata reads, exceeding its3-call host budget. It correctly stopped
STEP_LIMIT after2 requests/two searches, rejecting the whole metadata batch.
That profile remains failed; it is not a runtime defect or a passing paper lookup.
A separate explicit4-call profile with the same prompt succeeds: Flash3 HTTP
requests/four read-only callbacks, then a new-process Chinese Pro follow-up
reorders both retained references with1 request/zero tools. Titles, years, DOIs
and links match independently fetched Crossref metadata; the catalog is unchanged.
Lite replays identical native requests/results without inference. Total real
requests across both profiles are6. No automatic retry/fallback was added.

This is a bounded cached public bibliography, not broad internet discovery,
native SessionStore durability, production authorization or app activation.
The host owns acquisition, reference/ordering checks and retained context.
Offline key-order twins derived from real responses fail on installed348 and
pass after the correction; they are not raw observed provider failures.
Existing app library/index/download/provider policies and LocalLLM roles remain
unchanged. Optional trusted CLI Codex advice is unaffected.
Full npm test passes in421.269 seconds with frozen runtime/test hashes and
309-file syntax; production dependency audit reports zero findings. Two existing
fixed-port18102 document HTTP checks skip the occupied listener; their local
HTTP coverage is not claimed.

## Bounded read-loop finalization — 2026-11-05

The restricted runner advertised reads on a turn whose step/read budget could
not execute them. A catalog-sensitive offline provider reproduces STEP_LIMIT;
four of five corrected regression groups fail on the old Lite runtime. The
previous real two-turn Pro failure remains failed evidence; its raw choices were
not retained, so this is not a reconstruction of that model's exact decision.

The runner now withdraws unavailable reads and adds a transient evidence-bound
finalization instruction. It preserves all history/results, schema and output
budget. Dispatch, cancellation, deadline, context, credential and validation
gates remain authoritative. No synthetic proposal, extra call, fallback or
automatic formatter is introduced. No-tools LocalLLM vectors remain unchanged;
an equal wire body does not admit a new client package or model profile.

A one-shot synthetic host fixture with ordinary English/Chinese corrections
passes with Flash and Pro: two real requests and one caller-bound read each,
current revision13 over stale history12, exact requested titles and all remarks
retained, other-account marker absent, records unchanged. Lite replays both
native exchanges byte-for-byte without further inference. This is a host-owned
read/proposal fixture, not native session durability, production auth/store/
transactions/consent or a latency benchmark. App adoption remains owner-owned.

Five focused groups cover closed catalogs, native wire history, invalid final/
ignored catalog failures, no-tools compatibility and cancellation/context gates.
Full SDK43 and Lite48 tests pass, with18 LocalLLM oracle and3 proposal-recovery
controls. Optional trusted CLI Codex advice remains qualified separately; no
app-safe Codex fallback or LocalLLM/Mac functional admission is added.
The full npm suite exits0 with309-file syntax; production audit reports zero
findings. Two existing fixed-port18102 document HTTP checks skip their occupied
port; those HTTP checks are not claimed as covered by this local run.

## Typed transport failures and exception deadlines — 2026-11-05

The AiMemo qualification had an unresolved generic SDK gap: auth, quota and
outage failures all collapse to `PROVIDER_FAILED`. That opacity is an intentional
privacy default, but leaves no safe explicit transport classification for the
host's own recovery policy. The additive `createRestrictedProviderFailure`
factory preserves that code while admitting only a private in-process brand
with a closed category and bounded optional cooldown. The runner reconstructs
a safe error. Raw properties/prose, JSON clones, other module instances, Proxy
traps, native wire data and tool failures cannot impersonate the channel. It
does not prove HTTP authenticity or authorize any retry/provider switch.

The tests also reproduced a current deadline defect independently in installed
346 and Lite preview3: synchronous callback code can pass its monotonic deadline
and throw before a timer runs, producing `PROVIDER_FAILED` instead of `TIMEOUT`.
The exception path now checks the overall deadline before classifying failure.
Eight independent before/after and nonexpired controls pass. Cancellation wins
and uncooperative callbacks remain capacity-charged. No weakening of tool,
schema, privacy or completion gates is needed.

Five new groups fail before the feature (33existing pass), then all38 full
focused groups pass; Lite all43 pass with the same implementation/tests. A
deterministic delayed-exception regression fails before the deadline correction.
Final focused controls include cross-module brand refusal and zero getter/Proxy
traps. Full npm test exits0 in523.827s; syntax309 and audit0 pass. Two existing
fixed-port18102 document HTTP checks skip an occupied foreign listener.

Two separate bounded qualification variants inject synthetic loopback HTTP402,
not real provider quota incidents. Each produces exactly one classified failure,
zero reads/upstream inference and no SDK retry/fallback. The first explicit Pro
invocation hits its deliberately tight two-turn STEP_LIMIT after two real
requests/one read; it remains failed evidence. The unchanged normal Chinese
follow-up succeeds under the documented four-turn app profile in three real Pro
requests/two reads, after an actual process restart and host context reload.
It reads revision13 rather than stale12, proposes the requested title, preserves
all remarks and leaves both synthetic accounts unchanged. Total real requests
across both variants:five. Another-distribution Lite replay reproduces the three
request bodies and exact proposal with zero additional inference. This is host
fixture qualification, not SDK-owned persistence, production auth/consent/store,
remote termination or a latency/efficiency guarantee. The duplicate read is a
remaining model-quality cost, not hidden by extra core retries.

Only the restricted runtime/tests/docs and a private lightweight preview change.
Existing app routing/vendors/stores, native CLI/Studio, Codex wrapper and LocalLLM
maintenance/admission remain unchanged. The fresh lightweight LocalLLM GETs still
show catalog readiness without configured functional roles. No inference, model
load/unload, credential, service, tunnel or GPU change is granted by that status.

## Native-turn admission and lightweight DeepSeek parity — 2026-11-05

Auditing the Lite profile gap exposed a real restricted-wire-adapter defect.
Four adversarial replay variants accompanied a valid native read with DSML,
XML or requested-tool text. Installed345 silently discarded that competing
protocol and ran the read. A related falsey check treated boolean false or0
content as an empty native message. These are SDK admission defects; the raw
text was never itself executed, and no observed live DeepSeek response is
claimed to have produced them. Existing scope/tool/schema checks stayed intact.

The correction rejects invalid native content types and known competing text
protocol markers before any callback. It parses no additional tool syntax,
introduces no repair/fallback call and keeps ordinary prose/neutral metadata
compatible. Two new groups reproduce31pass/2fail before the fix and33pass after.
English/Chinese/Japanese commentary and final JSON documentation text remain
valid; complete/truncated markers, oversized data, falsey types and mixed native
turns cannot start a read. Existing generic omitted-content compatibility stays.

An isolated Lite preview ports the same non-thinking DeepSeek factory/guard
block byte-for-byte without importing a provider SDK, vision, CLI or transport.
It retains zero dependencies and seven package files. Its new export is an
explicit wire adapter, not an HTTP client, credential loader or admission proof.
The five previously unavailable feature groups and shared falsey-content
regression now pass with all38 Lite groups. Existing newline-ID controls were
already closed and are not reported as new defects. No app vendor is changed.

A bounded real paired check used the full candidate with Flash and Lite with
Pro. Each performed two HTTP requests/one scoped read and returned an exact
current draft title/ID/revision. Host records stayed unchanged. Captured native
responses replayed through the other distribution reproduced both outgoing
requests and final results with no extra inference. These are four live HTTP
dispatches plus offline replays, not four independent live trials or universal
provider/app qualification. The existing LocalLLM profile/version bindings and
the maintenance fence remain unchanged; neither new package is implicitly admitted.

The final full `npm test` exits0 in444.546s; syntax309 files, audit0 and the
489-file dry package pass. Two existing fixed-port18102 document HTTP checks
remain skipped because the listener is occupied; no foreign service is stopped.
Lite check and all38 tests pass, including an offline packed import with network
forbidden. Optional Codex CLI advice retains its separately qualified opt-in
contract; this admission repair adds no app Codex transport or automatic fallback.

## Restricted caller cancellation isolation — 2026-11-05

The next unqualified boundary was cancellation while another application caller
was active. Installed345 passed a real DeepSeek workflow with synthetic accounts
sharing the same draft ID and HTTP client. One Flash request reached a deliberately
held read; a second account began its Flash request; cancelling the first did not
abort the second. The first returned only CANCELLED, kept its capacity charged
until the ignored-abort read settled, and could not publish or continue afterward.
The second produced its current-revision Chinese proposal with all other text
preserved. A fresh, explicitly chosen Pro runner then read the unchanged first
account and produced the requested English edit with its notes preserved.

Five HTTP model dispatches and three scoped reads were observed:1+2+2 model
turns, no automatic retries or fallback. Neither outgoing requests nor accepted
proposals contained the other account's marker. SDK execution left host bytes
unchanged. The separate fixture host exercised sequential CAS/apply replay only
for the two successful proposals, advancing7->8 and31->32; the cancelled request
has no accepted proposal or write receipt. This apply exercise is not a user
consent, production transaction or cross-process durability qualification.

No core defect reproduced and no runtime change is justified. Three new offline
cases cover separate-account cancellation, two same-account overlapping runs
with late rejection/capacity recovery, and cancellation after final resolution
but before publication. All31 focused groups pass. Callbacks are trusted host
code; this is not a sandbox, remote provider termination, production authentication
or app rollout proof. Pro uses explicit host history in the same OS process;
no native SessionStore/restart claim is made. LocalLLM/Codex activation is unchanged.
Full `npm test` passes in459.098 seconds, including309-file syntax; production
audit reports zero findings, dry pack contains489 files and diff checks pass.
Two existing document HTTP checks skipped occupied18102. No version bump or
publication is needed for this tests/docs-only checkpoint. A20-second labeled
evidence replay and independently checked receipt are retained in Nutstore
`Projects/AgInTi/2026-11-05-caller-cancellation/`. The requested private
WeSticker SDK guidance was refreshed; its working app source/runtime was unchanged.

## LocalLLM oracle review corrections — 2026-11-05

Independent owner review identified two real disagreements in the offline
conformance oracle: it admitted dispatch before owner issuance inside the client
clock allowance, and it rejected the profile's explicitly admitted resolved
model spelling. Two new regression groups reproduced both against the prior
checkpoint; the other sixteen groups passed. These were test-validator defects,
not deployed provider failures or evidence of an admitted local runtime.

The oracle now enforces owner issue <= dispatch separately from client clock
agreement and accepts exactly the admitted alias or resolved tag. It preserves
the incoming model and all wire/canonical/upstream hashes. Eighteen groups pass,
including exact issue equality, permitted and excessive client skew, both host
namespaces/client variants, foreign model rejection and stale alias-proof reuse.
Existing pinned request vectors, normative owner contract and schema are unchanged.

Both actual full/Lite SDKs emitted eight equal-byte bodies covering the two
hosts, alias/resolved spellings and the existing English-initial/Chinese-follow-up
shapes. An independent Python validator checks the owner schema and reproduces
wire, canonical and upstream hashes. This is request-shape evidence with
fabricated provider replies; it does not prove live language/fact quality or
the plan's four sequential trials per host. The current full SDK source is
byte-identical to the reviewed SDK, but package345 is not admitted by a proposed
profile pinned to344. Equal source/payload does not override that binding.

Only tests and documentation changed. The oracle remains excluded from the npm
surface; runtime, exports, dependencies and installed version345 are unchanged.
No LocalLLM HTTP/model/credential, service or tunnel operation occurred. Protected
acceptance storage, live lease/resource proof, hard cancellation and functional
admission on both hosts remain missing. The functional-admission ledger case
stays prerequisite_missing. Qualification results and owner response are in the
dated offline correction checkpoint; no redundant npm publication is needed.
The full `npm test` passes in419.963 seconds, including309-file syntax; audit
reports zero findings and dry packing contains489 files with the oracle/test
excluded. Two existing fixed-port document HTTP checks skipped occupied18102.

## Optional Codex review through the native runtime — 2026-11-05

A normal read-only source review reproduced a core instruction-following gap:
"explain the smallest fix" created a source-mutation obligation, and observing
a failed test forced a repair. Successive fresh sessions with the same prompt
also exposed a negated-install wrapper refusal, lost wrapper diagnostics and
an unsupported hardcoded Codex model. These are core routing/guardrail issues;
the intentionally failing invoice fixture was never an authorized repair task.

The correction distinguishes proposed changes from requested edits and records
failed diagnostic execution as an observation, never a passing test. This narrow
exception requires an explicit read-only goal and unchanged mutation boundary;
repair, private mutation and mandatory-green contracts retain their gates. A
denied extra shell command remains denied; one bounded recovery can report the
retained evidence, and a second attempt stops. New Codex wrappers use the native
CLI's configured model unless explicitly pinned, with bounded failure diagnostics.

Real session `optional-codex-review-candidate6-20261105` completed with DeepSeek
Flash and one successful Codex delegation, without a spare. The native CLI
reported its requested model as gpt-6-astra; this is not served-model attestation.
Five `model.requested` events and 64.319 seconds were observed, not a guaranteed
billed-request count or latency benchmark. An actual Node test failed 9 versus
31; the final answer explained the quantity bug and proposed the smallest fix.
The source, test and fixture instructions retained identical SHA256 hashes.
The parent's command piped test output through `tail`, so its exit0 was not
accepted as a test pass; a separate unpiped run confirmed exit1 and the finding.
The proposed patch was not executed, and an extra inline Node command remained
blocked. Runtime bookkeeping persisted; provider network requests occurred.

Seven new offline regression groups and all 14 wrapper lifecycle groups pass.
The full `npm test` exits 0, including 309-file syntax and neighboring policy,
truthful-completion, SCS and Studio checks. Production dependency audit reports
zero findings. Two existing document-worker HTTP checks skipped their occupied
fixed port18102; no full HTTP coverage is claimed for those checks. The initial
suite was superseded and stopped after a new live failure; only the final suite
is reported as passing.

The result qualifies trusted CLI advice, not an application no-tools transport.
Codex still uses the trusted user's configuration/environment and native tools.
Restricted SDK/app routing is unchanged, wrappers remain opt-in, old saved model
pins are not silently migrated, and LocalLLM/Mac functional admission remains
unavailable. The successful answer was longer than requested; concise output
and provider startup/metadata latency remain model-quality limits. Redacted
evidence and an explicitly labeled replay video are retained in Nutstore
`Projects/AgInTi/2026-11-05-optional-codex-review/`.

## LocalLLM text-profile offline agreement — 2026-11-05

The proposed LocalLLM text qualification contract now has an AgInTi-side
conformance suite. Sixteen offline groups reproduce the owner-reviewed English
and Chinese request hashes, exercise actual SDK emission with the Mac model
alias, and reject identity/header/body substitution, stale leases, malformed
native completion, duplicate JSON and hostile descriptors. The fixture oracle
also rejects noncanonical identity JSON inside otherwise valid base64url.

All four workstation/Mac request bodies are byte-identical between full
0.20.344-integration.1 and Lite0.1.0-preview.2. An independent Python validator
accepts them against the owner-supplied JSON Schema and reproduces their
canonical hashes. The new Mac vectors were emitted by both SDKs, rather than
created by editing the earlier workstation fixtures.

This is test infrastructure, not a provider activation or runtime repair.
Production sources, exports, dependencies and installed version are unchanged.
The oracle is excluded from the npm package; its acceptance records and response
identities are fabricated test data. It supplies no protected credential/profile
registry, live resource/transport proof, request-ID ledger or hard cancellation.
Both hosts still lack an admitted profile. The functional-admission ledger case
remains prerequisite_missing; this separate offline-contract case does not
upgrade it. No model request, app source, service or tunnel was changed.

`npm test` passes with the new 16-group suite in pretest; repository syntax
passes for 309 files. Production dependency audit reports zero findings; dry
packing contains 488 files and no private paths. These checks validate the
offline contract infrastructure and preserve the existing runtime baseline.

## Lightweight distribution wire parity — 2026-11-05

AgInTiLite's unchanged preview1 reproduced seven failures in nine new offline
wire-integrity tests: duplicate final/argument keys, contradictory native/legacy
metadata, unsafe direct parser errors and unbounded parsed structure. Its
already-closed newline identifier and valid-value controls passed; those were
not treated as defects. The standalone package now backports full SDK parser
source8dc44e6 plus the corresponding metadata checks.

Private preview2 is committed at `3bf02335d4360e27bbe34561d5a70b5765c8662b`
in the canonical AgInTiLite repository. Syntax/all32 tests, reproducible seven-file
packing, offline install/closed import graph and diff checks pass. Runtime
dependencies0, exports4, text-only/no ambient providers/tools/fallback unchanged.
The contract module SHA256 is
`03529966865e3054b2f29e4161f79c2aee16b421ace5805e8b3b003d71549260`, identical
to the hardened full SDK. No model or application runtime was invoked/changed.

The standalone repo has no configured remote; a verified self-contained source
bundle and tarball are delivered with hashes, not an invented remote push.
`private:true` and the prior no-npm-publication boundary remain intact. No Bunko
vendor update was made; app-owner review is required. Generic host transports that
decode JSON themselves remain responsible for that parsing. The current full
SDK already has these guards, so installed Flow344.1 needs no redundant release.
Detailed receipts/handoff are in the private campaign ledger and Nutstore
`Projects/AgInTi/2026-11-05-agintilite-preview2/`.
The source bundle was cloned with explicit `--branch main` in a clean offline
environment: syntax/all32 tests passed again and its rebuilt tarball matched
the delivered SHA256 exactly. Temporary delivery/install roots were removed.

## Restricted proposal conflict/restart qualification — 2026-11-05

Installed0.20.344-integration.1 passed a synthetic Chinese correction across
Flash/Pro and a separate-process follow-up. A stale revision7 proposal was
rejected after a host-owned concurrent edit advanced8; a fresh Pro runner
preserved that edit, and the host applied9 once. After process exit, serialized
history/state fed another Pro follow-up, preserving all current remarks and
advancing10. Six real provider requests/three scoped reads, no automatic
retry/fallback, no foreign-account mutation and no application activation.

The runtime needed no change. Three offline companion regressions cover the
host/SDK contract, including a schema-valid stale negative control. The host
fixture owns transactions and history; only the final phase is an actual OS
restart. This is not native SessionStore, retained storage, app rollout or
cross-process database-lock qualification. See
`docs/restricted-application-recovery.md`. Evidence/demo and exact source hashes
are retained in the private campaign ledger and Nutstore checkpoint.
Validation: three new recovery cases plus28 existing SDK cases pass; full
`npm test` exit0 in408.89 seconds, syntax308 files, production audit0,
pack dry-run488 files/no forbidden private paths and `git diff --check` pass.
Only tests/docs/package test wiring changed; no version bump or npm publication.

## Optional advisory wrapper lifecycle — 2026-11-05

Four offline regressions reproduced genuine launcher defects: pre-cancelled
delegation spawned a child; abort returned before close; timeout launched a
spare Codex request; and signal termination with a null exit code appeared
successful. The correction checks cancellation before dispatch, waits for close
with bounded TERM/KILL cleanup, preserves signal/process failure, and prohibits
spare attempts after ambiguous termination. Normal successful advice and the
existing ordinary-exit spare policy remain compatible.

The focused test uses mocked child transports and one exact local Node fixture
which ignores SIGTERM. No Codex/other model was invoked. Trusted CLI opt-in and
selected-wrapper guardrails remain unchanged; no application-safe no-tools
transport or universal delegation quality is claimed. See
`docs/optional-codex-help.md` for usage and limitations. All 12 focused cases,
execution-policy and perception/research smokes pass. Full `npm test` passed in
411.01 seconds, including 307-file syntax; production dependency audit reports
zero findings. Release/package qualification is recorded separately in the
private machine ledger and does not establish live Codex model quality.

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

### Protected record snapshots tolerate atomic replacement

The tagged 0.20.343-integration.0 release gate failed in the existing authority
retention/heartbeat smoke before publication. The failure reported a hard link
while scanning a live pending record. A deterministic independent probe then
opened a record, atomically replaced it before fstat, and observed the old
descriptor with zero links and a valid current named record with one link. The
old reader classified this expected replacement as corruption. A second case
returned the obsolete record if replacement occurred during the read.

The protected reader now discards unlinked/replaced snapshots and reopens at
most eight times. It validates regular type, owner, permissions and single-link
status before and after bounded reads, then binds the named file to the same
identity/version. It never returns the discarded bytes. Real hard links, unsafe
owner/mode, symlinks and oversize still reject. Continuous replacement returns
bounded 503 busy; close failure cannot be reported as successful content.

Ten offline regressions cover both gated races, byte growth after fstat,
security controls, bounded retries, cleanup, and concurrent monotonic snapshots.
The previously failing authority smoke passes three consecutive runs; syntax
checking covers 307 files and production dependency audit has zero findings.
Full `npm test` passed in 386.25 seconds on the repair. Release/package
qualification is separate. The failed release tag is immutable and not
published; the installed CLI remains 0.20.342-integration.0.

This is a named-path snapshot helper, not retained-directory storage authority,
multi-file transaction isolation or same-UID/rollback protection. It does not
enable any native integration capability or alter process liveness, recovery,
handler dispatch, lease ownership, response roots or hard-link policy. No model,
application service, credential, GPU or production operation is part of this fix.

### Explicit restricted DeepSeek transport and unambiguous native proposals

`restricted-deepseek-native-calls-20261105` qualifies the existing isolated
restricted application runner on top of the current integration release. It
keeps authenticated read callbacks, explicit history and all application writes
host-owned. The SDK owns bounded context, tool dispatch, interruption and schema
validation; no CLI/Studio/native service or app runtime is mounted.

The old SDK's JSON parser accepted duplicate final fields and dispatched a read
with duplicate argument keys. An unchanged-source offline probe reproduced both.
Strict duplicate detection now compares decoded keys in every object, including
escaped aliases, before returning a proposal or executing a native call.

The new explicit DeepSeek text profile requests JSON-object output and disables
thinking. It embeds the exact host output schema and still validates it locally.
Four initial single-request live probes failed closed while diagnosing complete
native tool responses containing commentary and ordinal metadata. Canonical
normalization now discards commentary only on native call turns and removes
only an ordinal equal to the call's batch position. It does not parse textual
tool protocols or bypass the complete-batch/name/argument/owner gates.

The final real synthetic workflow passed four phases: English Flash and Chinese
Pro initial correction, then a fresh-runner follow-up using host-persisted state
and explicit authorized history. Each phase made two transport dispatches and
one scoped read. Revisions were bound to 3/4 and 7/8 respectively; language and
previous corrections were retained. Agent execution left host state unchanged
before apply. A separate fixture-owned apply simulation verified revision and
duplicate-apply behavior. It is not a production consent transaction or an
SDK-owned durable session. The successful workflow used eight dispatches; the
four earlier probes are separate qualification traffic, not hidden retries.

Twenty-eight offline cases pass on the final source. They cover scope/history isolation, local
schema checks, malformed/partial/refused responses, duplicate JSON/indices,
cancellation, ignored-abort capacity and zero-trap descriptor boundaries. The
production dependency audit has zero findings. The package scan includes the
four SDK files and excludes private state. The full `npm test` passed (397.88
seconds, including 306-file syntax validation); the final focused SDK rerun also
passed. Generic transport review additionally caught legacy function requests,
malformed tool metadata and trailing-newline identifier aliases. All now reject
without dispatch. Final safe-error/negative guards were also checked against
recorded live native/final responses without additional paid calls.

Earlier harness failures are retained: globally disabling auto-update suppressed
its smoke, and an isolated HOME hid the existing Playwright browser cache. The
overrides were corrected and the verified shared browser cache reused. Both
focused checks then passed unchanged. No assertion, download or production
service was used to bypass a gate. Package/release qualification is separate.

Nutstore holds redacted synthetic proposals and a labeled 20-second evidence
replay. No app source/state/service, LocalLLM model, GPU, paid image generation
or AgInTiLite distribution changed. Ordinary model quality and each app's
authorization/history/apply contract remain separate acceptance gates.

Optional Codex assistance remains an explicit trusted-CLI choice. Offline guard
probes reject disabled delegation and nonselected wrappers. Read-only Codex
still has tools and the legacy wrapper retains its own environment/spare policy;
this is not a qualified no-tools app transport. The restricted SDK neither
launches Codex nor treats a provider error as fallback authority.

### Explicit standalone provider preference and current DeepSeek routes

The November 4 CLI qualification adds an explicit personal provider preference
for fresh standalone tasks and chats. `aginti defaults set --provider deepseek`
writes only a small non-secret private preference. Status/set/reset import Node
built-ins rather than the Agent runtime or provider SDK. Credential files are
unchanged. Explicit provider, environment/project settings and saved-session
snapshots retain precedence; headless `run`/`resume`, SDKs and application
services do not read the preference. The shared LocalLLM baseline is preserved.

The direct fast route now uses the documented `deepseek-flash` name, while Pro
remains `deepseek-v4-pro`. Explicit legacy aliases remain accepted and listed;
third-party gateway identifiers are unchanged. A separate pure-function probe
reproduced incorrect timeout accounting: current Flash was relabeled as its old
alias and reported as a model switch. Recovery now recognizes equivalent Flash
names, preserves their explicit selection and uses the unswitched timeout cap;
Pro can still downgrade to current Flash under the existing recovery policy.

Thirteen offline regressions cover CLI/settings round trips, a dependency-free
entry, new task/chat selection, flags/project/environment precedence, headless
and SDK isolation, exact saved-model continuation, corruption/mode/link rejection,
unchanged credential bytes and timeout alias accounting. Role, LocalLLM readiness,
session-runtime and scripted provider-handoff smokes pass.
The final full offline `npm test` passed (exit 0, 412.75 seconds), including
303-file syntax checking and the unchanged interactive/resume suite. The
production dependency audit reports zero findings. Earlier failed gate logs
remain in private evidence rather than being relabeled as passing runs.

Pre-release full validation caught the optional reader blocking an existing
group-writable home with no saved preference. The reader now preserves legacy
startup when the opt-in file is absent; a present preference still requires
strict owned-directory/file checks. A separate deterministic race covers benign
session-directory creation: directory link-count changes do not replace the open
preference file. Root inode/owner/mode and file identity/link checks remain.

A real synthetic-file CLI example created and verified three checklist items
using DeepSeek Flash, then explicitly resumed the same native session with Pro.
Both invocations completed. Independent checks found the original input and
checklist unchanged on resume, correct item count/source phrases, retained first
goal and runtime revision 1->2. The ledger recorded six `model.requested` events
across the two turns; those are runtime events, not an independently measured
HTTP billing count. Only file/finish tools ran; no application service, GPU,
LocalLLM model or provider fallback was activated.

The first verifier used the wrong saved-state field after Flash had completed.
It was corrected to `meta.runtimeConfig`, and verification continued the existing
session without repeating artifact generation. Nutstore contains the synthetic
input/output, redacted receipt and a 20-second evidence-replay video. The replay
made no model calls and is not a latency benchmark or live screen recording.

Read-only LocalLLM checks used the documented `/livez` and `/readyz` routes.
Both returned 200/ok on the workstation. The existing Mac SSH route was reachable,
but neither route responded on that host's port 8008. Health/static readiness does
not establish an admitted authenticated inference role. No model loading, service
change or new tunnel was attempted; role qualification remains separate.
No existing Node binary was found on the Mac's non-interactive PATH or the
checked Homebrew/v22 locations, so a Mac CLI canary was not run or installed.
This does not prove that no other Node or inference installation exists there.

### Complete text-only fallback turns

The November 4 follow-up reproduced a separate gap in `runSafeChat`, using the
ordinary prompt "Just say Ready." and controlled provider replies. Sixteen of
23 new cases failed before the repair: plausible text could be returned as
success despite truncation, filtering, refusal, a wrong role, multiple choices
or an unexpected tool/function call. The authenticated HTTP route also returned
200 for an explicitly truncated turn. This was a text-helper response-boundary
defect, not a provider-quality result or an application session-policy issue.

Safe chat now requires one assistant text choice, no refusal or tool/function
call, and `stop` when finish metadata is present. Replies omitting legacy finish
metadata remain compatible. Invalid envelopes return the existing bounded
`invalid_response`/502 with no answer, automatic repair, retry or fallback.
English, Chinese and Japanese positive controls pass. The HTTP regression proves
the failure stays no-store and a subsequent corrected request can succeed;
rejected replies do not strand the concurrency slot. All 23 focused cases, the
existing safe-chat smoke and the 38 public-planner completion cases pass.
The full offline `npm test` suite then passed (exit 0), along with the 302-file
syntax check, zero-finding production audit and private-path package scan.

Safe chat remains a stateless text helper, not an AgInTi Agent session engine.
Applications retain conversation, account, tool, consent and provider authority.
The separate restricted-application SDK and AgInTiLite were not changed.

### Published backend checkpoint

`0.20.340-integration.0` was published from commit
`4bf5d4fe3ac58c5ae10c49a719226da4a05e92a3` by the established tagged GitHub
workflow, run `41839822662`. Its full suite, production audit and package gates
passed before publication. The registry tarball matched the locally qualified
archive byte-for-byte; its published provenance identifies that exact commit.
All 44 shipped completion/helper/dependency regressions passed from a fresh
registry-artifact install. Both globally installed CLIs report the exact version;
no active global consumer was present and no production service was restarted.
The `integration` dist-tag advanced; stable `latest` was not promoted.

The earlier manual workflow dispatch failed before publication because its event
did not satisfy the existing GitHub nested-bubblewrap exception contract. The
normal tag-push workflow passed without weakening that guard. Registry metadata
briefly lagged the successful publish; a fresh registry read and exact artifact
install verified propagation. The private local npm token was not used for the
successful OIDC publication. Nutstore release receipts are under
`Projects/AgInTi/2026-11-04-release-0.20.340-integration.0/`.

### Backend dependency qualification

The November 4 production-dependency audit identified ten advisories in the
locked graph, including HTTP/MCP trust-boundary issues and KaTeX inherited-option
handling. The candidate raises the MCP dependency floor to 1.32.0, pins KaTeX
0.18.2 and refreshes the affected compatible transitive dependencies. The updated
lockfile resolves MCP 1.32.2 and reports zero production audit findings.
The npm publication workflow now checks the production dependency audit before
packaging or publication, so future reported advisories block that release gate.

Focused tests exercise the actual MCP client registry over two loopback origins:
307/308 redirects must not forward a configured app header or request body to
the second origin. The KaTeX regression rejects inherited `trust:true` while
preserving ordinary accessible math. A direct old/new probe reproduced unsafe
inherited trust on the previous KaTeX and rejection on the updated dependency.
The existing browser math/assets/XSS and stdio/HTTP MCP smokes also pass.
The full local `npm test` suite passes against this exact refreshed graph.

This records tested dependency behavior, not a claim that every advisory was
exploitable in every application. Applications keep their own permission and
provider routing policies. Intentional cross-origin MCP redirects now require
configuration of the final server URL rather than forwarding app credentials.

### Complete provider turns before public backend execution

The November 4 backend check reproduced thirteen failures in a 33-case matrix
on the primary integration line. A short "Just say READY" request could publish
text despite an explicit truncated/filtered/unknown finish reason, a refusal,
multiple choices or the wrong message role. Valid-looking tool arguments could
also arrive inside an unfinished generation. The fault was in the public
planner's response boundary; no application policy or prompt was required.

The planner now validates each original model envelope at its shared invocation
boundary, before text-tool normalization, worker dispatch or final publication.
Only a complete assistant turn with a consistent stop/tool reason proceeds.
Explicit partial metadata becomes `ANALYSIS_MODEL_PROTOCOL_INVALID`. Existing
loopback replies omitting finish metadata retain their compatibility path.

The focused regression covers normal, text and JSON-only responses; real durable
session failure/restart/same-thread correction; native tool dispatch; and Chinese
and Japanese LocalLLM compatibility. These are controlled provider fixtures, not
live provider latency or quality measurements. `npm run demo:backend-completion`
demonstrates the persisted failure and recovery without provider credentials,
network calls or execution-worker activity. Its `--paced` option only spaces the
printed observations for recording; it does not alter runtime decisions.

All 38 focused cases and the full `npm test` suite passed. Syntax checks and the
dry package inspection also passed, including the shipped regression and demo.
This source checkpoint does not certify deployment or a new npm release; the
dependency audit and release authentication retain their separate gates.

### Private npm configuration cleanup

The same checkpoint's npm authentication check exposed a separate release-helper
defect: exiting inside the private-config `try` block skipped asynchronous
cleanup. A terminated npm child could also be reported as successful because
its null exit code was coerced to zero. The helper now records the exit status,
awaits cleanup and then exits naturally; signal termination remains a failure.
Three offline subprocess regressions use a synthetic token and a fake npm binary
to verify cleanup and status for success, failure and child signal termination.
No real credential is required by these tests.

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

### Response-only completion cannot replay host control or prior bot output

`labcanvas-response-only-context-echo-133` follows retained production session
`web-agent-labcanvas-dc5db4bc-5d33-427b-aafb-042e44ef9595`. Its response-only
fallback returned the host's evidence-scope object as the finished answer. A
second retained trace showed the same failure class after context compaction:
the fallback copied a prior bot-authored chat response instead of responding
to a different current inbound message. Both outputs could satisfy ordinary
plain-text or JSON-shape checks while saying nothing new.

AgInTiFlow now compares response-only candidates with the exact host control
object and attributed `is_self: true` messages in the bounded same-chat
context. An exact substantive replay receives one current-turn repair that
retains the caller's JSON contract. Explicit verbatim-repeat requests remain
valid, while merely quoting an earlier response does not authorize copying it
back.

The regression also forces an unsupported source-free factual answer to be
repaired into a stale prior message. A final cross-validator check stops that
turn with a schema-compatible limitation and no `session.finished` event. The
test uses deterministic provider responses only; no live DeepSeek or LocalLLM
inference, LabCanvas host change, queue action, schedule, or transport
operation is involved.

### Research mutations require their declared evidence manifest

`labcanvas-research-manifest-grounding-134` follows retained production session
`web-agent-labcanvas-d4fc28d0-2a19-488e-8610-5e34eb5172ab`. A report-repair task
declared one task-local research evidence manifest as authoritative. The fallback
read only the TeX report, introduced a new citation identifier that was absent
from the manifest, and described the result as evidence-verified without ever
reading the manifest.

Reader-facing research source mutations now stop before dispatch when the current
task explicitly binds them to an evidence, source, citation, or reference
manifest that has not been read completely. A bare manifest filename is resolved
under the declared artifact root. After the manifest is read, newly introduced
LaTeX citation keys, source IDs, DOI values, arXiv identifiers, and URLs must be
present in that manifest. Editing the manifest itself remains possible, and
ordinary document work without an explicit authoritative-manifest contract is
unchanged.

The production-shaped regression proves the exact unread-manifest block, permits
a supported source identifier after a complete read, rejects an unsupported
identifier, and preserves both non-contract document edits and direct manifest
maintenance. The earlier unrelated-anchor contamination in document validation
was already fixed by `84f488f`; this scenario adds only the missing evidence-use
boundary. No live DeepSeek or LocalLLM inference, LabCanvas host change, queue
action, schedule, or transport operation is involved.

### Host-owned document compilation is a dispatch boundary

`labcanvas-host-compiler-dispatch-135` follows retained production session
`web-agent-labcanvas-874e9cf8-2ae9-4238-8289-bc2797dd008a`. Its report-repair
contract prohibited agent-side document compilation and assigned the derived
PDF build and inspection to the LabCanvas host. The fallback nevertheless ran
the same `latexmk` build twice. AgInTiFlow already used host ownership to shape
its prompt and completion evidence, but did not enforce it before shell dispatch.

The shared host-compilation recognizer now covers the retained natural wording
that asks the agent to let the host compiler build the PDF, including a preceding
compound prohibition such as "do not install or invoke." When that explicit
ownership contract is current, direct or bounded shell-wrapped LaTeX, Tectonic,
Pandoc, Typst, and Make compiler invocations are blocked before execution. The
model receives one automatic source-only recovery instruction and the rest of
the same assistant tool batch cannot act on the invalid stage transition.

The regression uses the retained command shape and covers environment prefixes,
shell wrappers, and alternate document compilers. Read-only tool discovery,
source validators, ordinary agent-owned compilation, and conditional host
fallback remain available. No compiler command, live model, LabCanvas runtime
mutation, queue action, schedule, or transport operation is involved.

### Text workspace tools cannot fabricate opaque binary artifacts

`labcanvas-text-binary-artifact-boundary-136` follows retained production
session `web-agent-labcanvas-bc69ea98-1fbd-4289-9609-e01b8b5a04a5`. While
recovering a scheduled research report, the fallback passed 1,019 bytes of
ordinary UTF-8 Chinese text to `write_file` under a `.pdf` filename. The text
tool reported success even though the result was not a PDF, allowing a
mislabelled artifact to enter later completion and delivery work.

Workspace text tools now reject writes and patches to opaque binary formats
before mutation. The automatic recovery tells the model to create or repair the
canonical text-native source and use the established compiler, converter,
renderer, generator, or host-owned build stage. It explicitly rejects base64
workarounds and extension renaming. The boundary covers PDF and Office
documents, raster images, audio/video, archives, executable objects, databases,
fonts, and packaged 3D containers. Text-native Markdown, TeX, SVG, STEP, STL,
OBJ, JSON, code, and configuration remain writable.

The direct regression proves that `.pdf`, `.docx`, `.png`, `.mp4`, and `.3mf`
targets are blocked without creating files, that an `apply_patch` PDF add is
also blocked, and that representative text-native source formats still work.
No compiler, live model, LabCanvas runtime mutation, queue action, schedule, or
transport operation is involved.

### Source-free inspiration cannot invent named evidence

`labcanvas-source-free-inspiration-grounding-137` follows retained production
session `web-agent-labcanvas-98f06435-ce9d-4300-b2b2-e8c4399d46bc`. A scheduled
inspiration turn had no fresh evidence manifest or scoped tool evidence, yet
the fallback attributed claims to a magazine and a named journal, described
results as already validated, and recommended a purported open-source research
toolkit. The answer mixed those assertions with a requested high-risk
prediction, which made the unsupported grounding look plausible.

Source-free research and inspiration responses now distinguish two independent
things: the assistant may still propose its own clearly labeled, falsifiable
hypothesis or experiment, but a named publication, quoted source, or claimed
named research resource requires current scoped evidence. Sentence analysis
also keeps common `e.g.` and `i.e.` abbreviations intact so an attribution and
its evidence claim cannot be separated by punctuation tokenization.

The production-shaped regression covers the retained English and Chinese
claims, equivalent claims with the year removed, a named-tool assertion, a
source-free hypothesis positive control, and the same answer with a current
evidence ledger. End-to-end cases prove that one correction preserves the
caller's five-field JSON envelope and that a second unsupported answer fails
closed without `session.finished`. No live model, LocalLLM inference, LabCanvas
runtime change, queue action, schedule, or transport operation is involved.

### Response-only answers cannot collapse into host acknowledgements

`labcanvas-response-only-host-acknowledgement-138` follows retained production
session `web-agent-labcanvas-21296064-9835-461b-8179-5c8cf5f367a2`. Two
schema-valid response-only turns said that a WeCom message had been routed into
the LabCanvas runtime and that the requested response format was followed. The
host had already performed those operations; the fallback therefore answered
its transport wrapper instead of the human message.

Response-only completion now treats unsolicited routing, forwarding, runtime,
and output-contract acknowledgements as private host-control leakage. The
check reads the authoritative request from the evidence-scope envelope, so a
real user question about routing or backend status remains answerable. One
bounded repair asks for the task-facing answer without changing the caller's
JSON keys or types. A second acknowledgement fails closed with a schema-valid
`handled:false` result and no `session.finished` event.

The production-shaped regression uses the exact retained English and Chinese
outputs. It covers direct detection, an explicit routing-status positive
control, a normal human-answer positive control, successful repair, repeated
failure, event counts, and JSON-envelope preservation. No live model,
LocalLLM inference, LabCanvas runtime change, queue action, schedule, or
transport operation is involved.

### Blanket-perfect audits receive one skeptical confirmation

`labcanvas-response-only-perfect-audit-139` follows retained production session
`web-agent-labcanvas-497d42ba-3d06-4b6a-8a64-e67726a949a9`. DeepSeek first
stopped with an insufficient-balance response. The LocalLLM fallback then
accepted a roughly 15,000-character trilingual tutorial with all 11 dimensions
scored `5/5` and no issues, despite visible malformed Japanese and an incorrect
reading. The complete candidate remained in the active request, so this was an
audit-quality failure rather than context loss.

Response-only completion now asks for exactly one independent skeptical check
when an explicit scored audit is accepted, has at least four numeric dimensions,
assigns every dimension the request's explicit maximum, and reports no issues or
revisions. The check must compare the actual candidate with all material
requirements, preserve the caller's JSON contract, and may confirm a genuinely
perfect result. Rejected audits, qualified scores, ordinary answers, and reviews
without an explicit score range do not receive an extra model turn.

The production-shaped regression includes the retained malformed Japanese span,
proves a corrected rejection after confirmation, proves a clean candidate can
remain perfect after exactly two calls, and proves an initially rejected audit
uses one call. It also covers direct non-audit and non-perfect controls, event
counts, JSON-envelope preservation, and successful completion boundaries. No
live DeepSeek or LocalLLM inference, LabCanvas runtime change, queue action,
schedule, or transport operation is involved.

### Human-facing replies cannot expose private packet identifiers

`labcanvas-response-only-private-packet-hygiene-140` follows retained production
session `web-agent-labcanvas-acfafa25-d3c5-4a4e-9e12-1813973211a2`. A scheduled
inspiration reply told group members to reflect on achievements like the
`memo_daily` task and put another orchestration phrase in `confirmation`. That
identifier came from a private preflight schedule snapshot, not the human-facing
request, and should never have appeared in chat.

Response-only scaffold validation now derives machine-style identifiers from
the exact task packet and checks only outward text fields such as `message`,
`response`, `chat_reply`, `ack`, and `confirmation`. An identifier is rejected
only when it occurs in the private packet and is absent from `current_request`
and every explicit request item. The implementation does not contain scheduler
names, inspect attachment paths, or reject arbitrary underscore text. A human
who explicitly asks about the named internal task can still receive an answer.

The production-shaped regression proves the original leak failed before the
fix, then covers direct detection, explicit-request and unrelated-text controls,
one successful schema-preserving repair, and repeated-leak fail-closed behavior
without `session.finished`. No live model, LocalLLM inference, LabCanvas runtime
change, queue action, schedule, or transport operation is involved.

### Schema-valid empty envelopes cannot finish a task

`labcanvas-response-only-empty-envelope-141` follows retained production session
`web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`. After DeepSeek
reported insufficient balance and the LocalLLM request was compacted to fit its
context window, the fallback returned a valid chat JSON envelope whose message,
confirmation, files, publish state, and generated-content arrays were all empty.
AgInTiFlow accepted the field types and emitted `session.finished`, silently
clearing a scheduled inspiration task without a reply.

Host task envelopes now require a meaningful outward payload after structural
JSON validation. A nonempty human message, task-scoped attachment, continuation
question, knowledge item, upstream feedback item, publish state, or generated
content satisfies the boundary. The check applies only when an exact host task
packet and a human-facing response field are present; router and audit schemas
remain unchanged. An explicit human instruction to leave the message or reply
empty is also preserved.

The production-shaped regression first proves the one-call silent finish on the
pre-fix runtime. It then covers direct positive controls, one successful bounded
repair, exact JSON-envelope preservation, repeated-empty fail-closed behavior,
and absence of `session.finished` after failure. No live model, LocalLLM
inference, LabCanvas runtime change, queue action, schedule, or transport
operation is involved.

### Later repairs cannot reintroduce an empty envelope

`labcanvas-response-only-post-repair-empty-envelope-142` closes a validator-order
gap exposed while reviewing the retained empty-envelope path. A nonempty answer
with unsupported named evidence correctly entered source-free repair. Its
replacement preserved the JSON schema but emptied every outward field; because
the initial payload check had already passed, the replacement could still reach
`session.finished`.

Response-only completion now repeats the semantic outward-payload check at the
final acceptance boundary, after every bounded evidence, transcript, context,
and scaffold repair. A later repair that erases the answer fails closed using
the caller's exact JSON envelope. The runtime does not spend a third model call
after a weak backend already failed the requested correction.

The production-shaped regression proves the before-fix successful finish,
retains the source-free rejection event, confirms exactly two model calls,
checks the schema-valid stopped result, and proves there is no
`session.finished` event. No live model, LocalLLM inference, LabCanvas runtime
change, queue action, schedule, or transport operation is involved.

### Later repairs cannot reintroduce host control language

`labcanvas-response-only-post-repair-scaffold-143` extends the final-boundary
audit beyond empty payloads. A response with unsupported publication numbers
correctly entered source-free repair, but its replacement merely acknowledged
that a WeCom message had been routed into LabCanvas and that the output format
was followed. The early scaffold check had already passed, so this host-facing
implementation detail was previously accepted as a successful human reply.

Response-only completion now repeats the existing internal-scaffold detector at
the final acceptance boundary. If any later evidence or transcript repair
introduces host routing acknowledgements, private packet identifiers, recovery
instructions, or output-contract narration, the turn stops using the caller's
exact JSON envelope. This final check records the defect but does not spend a
third model call after the bounded repair budget is exhausted.

The production-shaped regression proves the vulnerable pre-fix finish and the
fixed two-call fail-closed result, including one source-free rejection, one
scaffold rejection, no extra scaffold-repair request, schema preservation, and
no `session.finished` event. No live model, LocalLLM inference, LabCanvas
runtime change, queue action, schedule, or transport operation is involved.

### Later repairs cannot invent speech from an unusable transcript

`labcanvas-response-only-post-repair-transcript-144` continues the bounded
Shipinhao transcript audit. The first answer truthfully said that a strongly
repetitive transcript could not support a speech summary, but also added an
unsupported journal validation claim. Source-free repair removed that claim
and replaced the entire answer with a fluent invented account of the video's
speech. Because transcript quality had already been checked, the fabricated
summary previously reached `session.finished`.

Response-only completion now repeats bounded-transcript quality validation at
the final acceptance boundary. If a later repair drops the required limitation
or infers speech from title metadata, the runtime returns the established
truthful limitation in the caller's exact JSON envelope. It does not request a
third model turn.

The regression proves the before-fix successful finish and the fixed two-call
stop, including the source-free rejection, transcript-quality fail-closed
event, parseable limitation message, and absence of `session.finished`. No live
model, LocalLLM inference, LabCanvas runtime change, queue action, schedule, or
transport operation is involved.

### Later repairs cannot bypass skeptical audit confirmation

`labcanvas-response-only-post-repair-perfect-audit-145` closes the remaining
semantic validator-order gap. A qualified audit containing an unsupported
journal validation claim correctly entered source-free repair. Its replacement
then marked every dimension perfect, accepted the malformed multilingual
tutorial, and reported no issue. Because the perfect-audit gate had already
seen the earlier rejected review, the unverified replacement previously
finished after two calls.

Perfect-audit confirmation is now a bounded reusable stage that records the
exact reviewed result. If a later repair creates a different blanket-perfect
audit, AgInTiFlow performs one late skeptical confirmation. The resulting audit
then passes through the final output, grounding, payload, current-turn,
scaffold, and transcript invariants before completion. A late confirmation
cannot silently reintroduce unsupported external claims.

The production-shaped regression proves the pre-fix two-call acceptance and a
fixed three-call path whose independent review finds the malformed Japanese,
returns `accepted=false`, preserves the caller schema, and finishes normally.
Existing initially perfect, already rejected, qualified, and non-audit controls
remain unchanged. No live model, LocalLLM inference, LabCanvas runtime change,
queue action, schedule, or transport operation is involved.

### Bare artifact outputs resolve inside one authoritative task root

`labcanvas-scoped-artifact-bare-write-146` follows retained WeCom worker session
`web-agent-labcanvas-12fc2f0e-6c81-489c-9d0c-8bde674eeeed`. After DeepSeek
balance exhaustion, the LocalLLM correctly attempted to create a task-local
report source but supplied only a meaningful basename. AgInTiFlow resolved it
at the AgenticApp repository root, then rejected its own resolution as outside
the host-declared artifact directory and paused for permission. Stronger host
permission could not resolve this path-semantics mismatch.

Workspace writes now interpret a bare basename relative to the artifact root
only when the host marks the run as a scoped artifact task, declares exactly
one matching artifact root, and enables write access. The returned tool path is
the real workspace-relative rooted path. Absolute paths, parent traversal,
directory-bearing relative paths, multiple scopes, reads, and ordinary
write-scoped work retain the existing containment behavior.

The production-shaped executor regression proves the pre-fix block, successful
write and exact bytes under the authoritative root after the fix, and negative
controls for both non-bare relocation and ordinary outside-root writes. Report
source grounding remains independently enforced by the authoritative-manifest
boundary from scenario 134. No live model, LocalLLM inference, LabCanvas runtime
change, queue action, schedule, or transport operation is involved.

`labcanvas-scoped-artifact-manifest-composition-147` additionally locks the two
boundaries together. A model-supplied bare report basename is still inspected as
a reader-facing research mutation before workspace execution, so an unread
exact-task evidence manifest blocks the write even though the executor would
later anchor that basename inside the one authoritative artifact root. Filename
recovery therefore cannot turn unsupported report prose into a successful
mutation.

### Named research claims remain traceable after manifest read

`labcanvas-research-attribution-traceability-148` closes a source-integrity gap
after the authoritative manifest has been read. The existing mutation boundary
rejected invented citation keys, DOI values, URLs, arXiv IDs, and evidence IDs,
but returned early when polished prose omitted an identifier entirely. A weak
backend could therefore write a sentence such as `Chen et al. (2026) proved
...` without connecting that attribution to any manifest source.

Reader-facing research mutations now reuse the same multilingual external-claim
assessment used by response-only grounding. An attributed evidence claim must
contain at least one identifier supported by the task-authoritative manifest.
The check is claim-level and applies only under an explicit current research
evidence contract after the manifest has been completely read. Ordinary
synthesis, clearly labeled assistant-owned hypotheses, manifest edits, stale
contracts, and named claims with supported identifiers retain their previous
behavior.

The production-shaped regression first proves the pre-fix acceptance. It then
rejects uncited named-study claims in English, Chinese, and Japanese, accepts a
supported `S1` citation, and preserves ordinary synthesis and a falsifiable
working hypothesis. No live provider, LocalLLM inference, LabCanvas runtime
change, queue action, schedule, transport operation, or external side effect is
involved.

### Shell commands cannot bypass research source review

`labcanvas-research-shell-mutation-boundary-149` follows retained session
`web-agent-labcanvas-bc69ea98-1fbd-4289-9609-e01b8b5a04a5`. Its fallback model
used `sed -i` to change a task-local TeX report while an authoritative evidence
manifest contract was active. That particular edit targeted typography, but
`run_command` bypassed both the mandatory manifest read and the claim-level
identifier review applied to structured workspace mutations.

The manifest boundary now recognizes direct shell content mutations to
reader-facing research sources. Before the manifest is read, they receive the
same unread-manifest recovery. Afterward, in-place `sed` or `perl`, output
redirection, `tee`, direct file replacement, and explicit language-runtime file
writes are redirected to `apply_patch` or `write_file`, where the proposed text
can be reviewed before mutation. Read-only inspection, validators, compiler
invocations, non-reader build logs, stale contracts, and explicit edits to the
manifest itself retain their previous behavior.

The production-shaped regression proves the pre-fix shell bypass and covers a
nested shell wrapper, Python `Path.write_text`, structured-edit recovery, and
the non-mutation controls. The detector is deliberately not a ban on shell use:
it isolates direct reader-source editing while leaving validation and build
commands available. No live provider, LocalLLM inference, LabCanvas runtime
change, queue action, schedule, transport operation, or external side effect is
involved.

### Truthful response stops remain human-facing

`labcanvas-response-only-natural-source-free-stop-150` follows retained
sessions `web-agent-labcanvas-a2400822-729d-400b-8a70-2842e3dcefe8` and
`web-agent-labcanvas-d99fc736-db3a-4310-bbe5-c939a779ffca`. Their underlying
numeric-classification false positive is already fixed by the earlier numeric
boundary, but the traces exposed a separate fallback defect: a genuine
twice-rejected source-free claim would still return AgInTi evidence-manifest,
tool-scope, and resume instructions as the outward chat answer.

The fail-closed result now states only the truthful user-facing limitation in
English, Chinese, or Japanese. It retains a requested `CHAT:` protocol and is
still embedded into the caller's exact strict JSON contract when one exists.
The private repair prompt also tells a weaker provider not to expose runtime
mechanics. Claim detection, the single bounded repair, paused-session state,
and the absence of `session.finished` after repeated unsupported claims are
unchanged.

The deterministic provider-handoff regression forces repeated unsupported
publication, year, validation, benchmark, and forecast claims. It checks all
three language forms, the chat protocol, the full router schema, and absence of
private runtime vocabulary while retaining the existing negative evidence
controls. No live provider or LocalLLM inference, LabCanvas runtime change,
queue action, schedule, transport operation, or external side effect is
involved.

### JSON contract stops keep diagnostics private

`labcanvas-response-only-natural-contract-stop-151` extends the same outward
response hygiene to strict JSON failures. Existing contract enforcement kept
the caller's keys and stopped the session after a second malformed response,
but inserted `response-only model`, `output contract`, and missing-key details
into a reader-facing string field. That preserved machine parsing while still
leaking operator diagnostics into chat or a completion audit.

The schema-compatible fallback now contains a short, localized statement that
a reliable answer in the required format was not produced. Missing keys, type
mismatches, enum mismatches, step, provider, and model remain available in the
private `response_only.output_contract_failed_closed` event. The caller's exact
key order and types, paused state, bounded single repair, and absence of a
successful terminal event remain unchanged.

The deterministic regression covers the retained completion-audit shape and a
Chinese chat envelope. It proves exact schema preservation, natural outward
text, private diagnostic retention, and zero `session.finished` events after
failure. No live provider or LocalLLM inference, LabCanvas runtime change,
queue action, schedule, transport operation, or external side effect is
involved.

### Empty response stops are human-facing

`labcanvas-response-only-natural-empty-stop-152` covers the adjacent case in
which a response-only backend returns the exact JSON shape but leaves every
reader-facing field empty twice. The bounded repair and fail-closed stop were
already correct, but the synthesized chat field exposed the model, retry,
session, provider, and resume mechanism.

The outward fallback is now a short localized statement that a reliable reply
was not produced. Empty-payload classification, response keys, provider/model
state, and stop reason remain in private state and events. The deterministic
English and Chinese regressions preserve the exact caller schema, one repair,
paused state, and absence of `session.finished`. No live provider or LocalLLM
inference, LabCanvas runtime change, queue action, schedule, transport
operation, or external side effect is involved.

### Unusable-answer stops share one natural boundary

`labcanvas-natural-unusable-response-stops-153` closes the remaining copies of
the same outward diagnostic leak. A weak backend that repeated private runtime
scaffolding or returned a blank answer twice stopped safely, but the final chat
text instructed the human to resume a saved session with another provider.

One localized helper now serves ordinary empty responses, response-only empty
envelopes, and repeated internal-scaffold failures. Their distinct private
events, stop reasons, schema fallbacks, and recoverable paused states are
unchanged. Deterministic controls cover ordinary and response-only paths plus
English, Chinese, and Japanese output; all require bounded repair and forbid a
successful terminal event. No live provider or LocalLLM inference, LabCanvas
runtime change, queue action, schedule, transport operation, or external side
effect is involved.

### Scoped tasks cannot borrow sibling artifacts

`labcanvas-cross-task-artifact-isolation-154` follows retained LabCanvas
session `web-agent-labcanvas-064f6714-4b85-463c-af5b-43663f4da56d`. The task
declared one authoritative artifact root, but the fallback discovered a sibling
task directory, read and validated its report, then finished with that sibling
PDF. The file existed and was valid, so ordinary artifact evidence checks could
not distinguish it from the current task's result.

Scoped artifact tasks now derive the containing task namespace from their exact
`artifact_root`. Reads, directory probes, shell commands, and completion text
may use the current root recursively, but an undeclared sibling root is blocked
before inspection or rejected before completion. One bounded repair directs the
agent back to the current root. Explicit exact inputs, exact outputs, and
declared source roots remain available, so legitimate source reuse is not
mistaken for cross-task leakage.

The regression also exposed that structured contract paths were previously
passed through a prose compactor that inserted `... [truncated]` after 120
characters. Exact inputs, outputs, exclusions, and source roots now retain their
full bounded value up to 1,024 characters. Production-length LabCanvas paths
therefore remain usable by the isolation allowlist.

Deterministic coverage proves rejection and repair of a sibling completion,
blocks sibling `read_file` and `run_command` access, permits the current task
through both paths, and permits an explicitly declared long sibling source
root. No live provider or LocalLLM inference, LabCanvas runtime change, queue
action, schedule, transport operation, or external side effect is involved.

### Tool-capable tasks preserve strict JSON envelopes

`labcanvas-tool-capable-json-contract-155` follows retained LabCanvas session
`web-agent-labcanvas-97e7f45f-b6ef-4fef-aeb2-c21c43e29b41`. The task used
normal file and shell tools to verify a repaired PDF, but its host contract also
required one strict JSON object. AgInTi accepted a polished prose `finish`
result instead. The work itself was valid, but the caller could not consume the
answer and started successor sessions against the same task.

Explicit JSON contracts are now enforced at the shared completion boundary,
not only in the response-only fast path. Both assistant-content and `finish`
tool completions receive one bounded schema-preserving repair. A repeated
violation pauses without a successful terminal event and returns a parseable
fallback object with the requested top-level keys and value types, allowing the
host to record the limitation without retrying malformed output indefinitely.

The deterministic regression proves the retained plain-prose failure before
the fix, successful repair through both completion modes, exact required-key
and value-type preservation, bounded retry count, and schema-valid fail-closed
behavior. No live provider or LocalLLM inference, LabCanvas runtime change,
queue action, schedule, transport operation, or external side effect is
involved.

### Shell authorization is not mutation evidence

`labcanvas-observed-shell-noop-mutation-156` follows retained LabCanvas session
`web-agent-labcanvas-8d2d6b21-e027-4028-950d-1e090e185083`. A successful shell
loop only checked installed document tools and extracted PDF text, but its
conservative `writesWorkspace: true` policy advanced the project mutation
revision. Similar read-only inspections raised the revision repeatedly even
though the trace contained only one actual file patch. This could make a
rejected artifact repair appear to have received the required fresh source
correction.

The command executor now records when non-Git before/after worktree observation
completed. When that evidence is available, the completion recorder advances
the revision only for observed changed worktree paths or verified changed exact
outputs. Conservative command classification still controls authorization and
sandbox selection. Legacy retained results without the observation marker keep
their previous conservative replay behavior, and Git workflows retain their
special handling because a clean-to-clean commit or pull can change repository
history or content without leaving a dirty worktree.

The production-shaped regression proves that a successful broadly classified
inspection with empty observed path sets preserves revision 5, while existing
shell-edit, generated-output, failed-command, Git, no-op workspace-write, and
verification cases remain covered. The focused mutation suite, all 207 syntax
checks, and the complete deterministic `npm test` gate pass. No live provider
or LocalLLM inference, LabCanvas runtime change, queue action, schedule,
transport operation, or external side effect is involved.

### Focused repair packets preserve exact artifact contracts

`labcanvas-focused-repair-packet-contract-157` continues retained LabCanvas
session `web-agent-labcanvas-8d2d6b21-e027-4028-950d-1e090e185083`. Its active
scope correctly requested a material PDF repair, while the appended exact task
packet named the two rejected PDFs, the missing reader-facing requirement, and
the concrete quality defect. Scope narrowing kept only the short request, so
SCS saw no exact output path and could accept a nearby or unchanged artifact.

AgInTi now parses a recognized focused `labcanvas-agent-task-vN` packet through
the shared balanced JSON extractor. It projects only bounded repair fields into
the internal hard contract: rejected output paths below the active artifact
root, remaining artifact requirements, and quality issue identifiers. Packet
IDs, retained chat history, route state, scheduler state, and sibling artifact
paths are not projected. Packet and retry roots must agree with the active
scope; otherwise the projection fails closed.

The production-shaped regression proves exact-path and quality-defect retention
both directly and after the long completion context is compacted. It also
injects a sibling PDF and private packet identifier and proves neither enters
the output contract or outward outcome. The shared JSON parser keeps its
existing perception and response-envelope behavior under focused checks. No
live provider or LocalLLM inference, LabCanvas runtime change, queue action,
schedule, transport operation, or external side effect is involved.

### Host-owned compilation cannot hide behind compiler aliases

`labcanvas-host-compiler-alias-boundary-158` follows retained LabCanvas session
`web-agent-labcanvas-756f4598-34c1-4139-bb48-94673a0fac76`. Its contract
assigned Unicode PDF compilation and inspection to the trusted host stage, but
the fallback tried to recover an unavailable `xelatex` binary through
`xetex -fmt=xelatex`. That compile was bundled after a scratch-directory
deletion, so generic shell policy stopped the task for destructive approval
before the host-ownership contract could redirect it.

Host-owned document compilation is now recognized before ordinary shell
permission classification, and direct `xetex` invocation is covered alongside
the existing LaTeX engines and build wrappers. The complete command remains
unexecuted and receives the existing bounded instruction to finish the editable
source for the host stage. Agent-owned document builds still use their normal
policy, and destructive commands without an exclusive host-compile contract
still require approval.

The production-shaped regression includes the retained scratch reset and
`xetex -fmt=xelatex` alias, plus direct, environment-prefixed, shell-wrapped,
ordinary agent-owned, conditional-host-fallback, and non-compiling source-check
controls. No live provider or LocalLLM inference, LabCanvas runtime change,
queue action, schedule, transport operation, or external side effect is
involved.

### Optional archival cannot stall the active task

`labcanvas-unrequested-artifact-archive-recovery-159` follows the retained
blocked event in LabCanvas session
`web-agent-labcanvas-c19ceaee-0b19-4ef3-96f9-43e25ab3dff1`. After substantive
report work, the fallback bundled validation with moving three prior PDFs into
`_superseded_drafts/`. The active task did not request archival, but unrelated
history inside the full host packet could be mistaken for current mutation
intent, so the whole task paused for destructive approval.

Permission intent now uses the authoritative task-scoped request when an
`AGINTI_EVIDENCE_SCOPE_JSON` envelope is present. A move is optional
housekeeping only when every source is an explicit workspace-relative file and
the destination is a clearly archival workspace-relative directory. The move
remains blocked and no file is relocated; AgInTi continues with the substantive
checks. Globs, outside paths, ordinary renames, arbitrary destinations, and
explicit current archive requests remain under normal mutation policy.

The regression proves the exact retained command changes from a permission
pause to bounded recovery, stale archive instructions cannot override the
active task, and an active archive request cannot be erased by stale no-move
memory. No live provider or LocalLLM inference, LabCanvas runtime change, queue
action, schedule, transport operation, or external side effect is involved.

### Generic replacement wording does not load a video workflow

`labcanvas-focused-replacement-skill-routing-160` follows a retained LabCanvas
PDF repair whose exact scoped request was correctly isolated from same-chat
history. Skill scoring still selected `video-face-image-replacement` because
the ordinary document phrase "replacement PDF" matched one component of that
multi-part skill ID. This spent a local-model skill slot and prompt budget on
an unrelated media workflow.

`replacement` is now ignored as a standalone skill-ID routing token. Specific
video-face trigger phrases still select the workflow, while a focused PDF
replacement keeps document skills and omits video guidance. The change affects
only skill discovery; task memory, evidence contracts, tool availability, and
LabCanvas policy remain unchanged.

### Response-only chat does not load an external-media workflow

`labcanvas-response-only-external-skill-routing-161` follows retained
response-only LabCanvas sessions that selected `doubao-external-audio-video`.
The current-task scoping itself was correct, but its generic phrase "without
external execution" matched the single `external` token in that skill ID.

`external` is now ignored as a standalone skill-ID routing token. An ordinary
response-only chat turn no longer spends local context on Doubao guidance, and
an explicit Doubao external-audio video request still selects the workflow via
its specific trigger. No response contract, execution policy, memory, provider,
or host integration behavior changes.

### Generic research stays focused while explicit subdomains still route

`labcanvas-research-skill-routing-162` follows retained LabCanvas session
`web-agent-labcanvas-064f6714-4b85-463c-af5b-43663f4da56d`. A normal daily
biomedical-research request loaded market-report, grant-writing, and literature-
lookup skills because the generic `research` component of each external skill ID
was sufficient evidence. Conversely, natural singular wording such as "NIH
grant proposal" did not match plural metadata and omitted the relevant grant
skill.

Generic `research` and `report` components no longer route compound skill IDs.
The built-in deep-research skill explicitly owns plain research requests, and
conservative English singular/plural matching lets domain-bearing words such as
`grant`/`grants`, `proposal`/`proposals`, and `report`/`reports` match without
stemming unrelated text. Deterministic controls preserve explicit market
research, grant, and literature lookup routes while excluding unrelated
research/report skills. No live provider or LocalLLM inference, LabCanvas
runtime change, queue action, schedule, transport operation, or external side
effect is involved.

### Machine repair identifiers do not route domain skills

`labcanvas-machine-repair-code-skill-routing-163` follows retained LabCanvas
PDF-repair session `web-agent-labcanvas-23dfa04f-cef4-4d48-a99e-b152eacf4a99`.
The active request included quality identifiers such as
`missing_source_level_methods_results_limits` and
`missing_actionable_experiments_or_decisions`. Skill routing split those opaque
host-contract values into English words and loaded analytical-method validation,
clinical decision support, and transcript/video splitting, consuming bounded
skill slots during an ordinary report repair.

Pre-routing normalization now removes multi-part snake-case identifiers before
semantic scoring. Natural prose, file extensions, one-underscore names, and
explicit hyphenated skill IDs remain available. The production-shaped regression
keeps PDF, source-ingestion, and LaTeX guidance while excluding the three false
domains; separate natural-language controls still select each excluded skill
when it is genuinely requested. No live provider or LocalLLM inference,
LabCanvas runtime change, queue action, schedule, transport operation, or
external side effect is involved.

### Response-only host nouns do not activate domain workflows

`labcanvas-response-only-host-noun-skill-routing-164` follows retained
LabCanvas response-only session
`web-agent-labcanvas-dc5db4bc-5d33-427b-aafb-042e44ef9595`. The exact scoped
instruction said that the LabCanvas host owned persistence, compilation,
validation, and delivery, but the generic words `LabCanvas` and `validation`
activated WeChat chatops and analytical-method-validation skills in a turn that
explicitly prohibited external action.

Those platform/control nouns are now ignored as standalone compound skill-ID
evidence. Explicit natural requests for WeChat chatops and analytical-method
validation still select the correct skills through stronger domain terms and
specific triggers. The change affects only skill discovery; response schemas,
task context, tool policy, and host ownership remain unchanged. No live provider
or LocalLLM inference, LabCanvas runtime change, queue action, schedule,
transport operation, or external side effect is involved.

### Generic follow-up prose does not satisfy unrelated skill descriptions

`labcanvas-generic-followup-description-routing-165` follows retained
LabCanvas session `web-agent-labcanvas-4bbdae1d-4870-4392-8073-3bccc981a4f3`.
Its focused request asked for a complete natural replacement covering the exact
current requirements, but ordinary words such as `current`, `requests`, and
`explicitly` jointly satisfied the protocols.io description threshold. The
fallback consequently spent a bounded skill slot on an unrelated protocol
integration during response repair.

Description stop words now apply through the same conservative singular/plural
forms used for positive matching, so `request` also suppresses generic
`requests`. Generic control terms such as `current` and `explicitly` no longer
act as domain evidence, and `integration` alone cannot route every integration
skill by ID. The exact retained follow-up now selects no unrelated skill, while
an explicit protocolsio integration request selects only protocols.io rather
than sibling Benchling, DNAnexus, LabArchives, or LatchBio integrations. No live
provider or LocalLLM inference, LabCanvas runtime change, queue action, schedule,
transport operation, or external side effect is involved.

### Dotted service names remain distinct from filenames

`labcanvas-dotted-service-skill-routing-166` covers a natural request to read
and export an exact `protocols.io` protocol. Existing path-noise normalization
treated the service name as an `.io` filename, so neither ordinary prose nor an
official protocols.io URL selected its integration skill. The synthetic
undotted spelling `protocolsio` worked, but users should not need to know an
internal skill ID.

Skill routing now derives dotted identities from a skill's own ID, label,
description, and triggers. A matching bare domain, subdomain, or HTTP(S) URL
adds strong identity evidence only when the compact dotted name occurs in that
skill's declared identity. File paths and extension-bearing lookalikes such as
`docs/protocols.io.md`, `/tmp/protocols.io`, and `protocols.io.txt` remain under
file normalization and do not activate the integration. This is metadata-driven
rather than a protocols.io exception and does not weaken path-noise isolation.
No live provider or LocalLLM inference, LabCanvas runtime change, queue action,
schedule, transport operation, or external side effect is involved.

### Completion-audit requirements are diagnostics, not external claims

`labcanvas-completion-audit-requirement-source-free-167` follows retained
LabCanvas session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`.
The completion auditor correctly returned the missing requirement
`Per reprocess instruction, put the validated PDF itself in candidate_result.`
The generic source-free claim validator then read the diagnostic phrase
`validated PDF` as an assertion of external validation and rejected the audit,
spending an unnecessary model turn before the retained run was interrupted.

For an explicit completion-audit role with the declared audit schema, source-
free claim scanning now uses a temporary copy with only
`missing[].requirement` removed. The actual audit result is unchanged. The
auditor's `summary`, ordinary response-only output, and every other evidence
validator remain covered; regressions prove both negative controls and exact
one-call completion for the retained requirement. No live provider or LocalLLM
inference, LabCanvas runtime change, queue action, schedule, transport
operation, or external side effect is involved.

### Completion-audit IDs stay bound to the exact task packet

`labcanvas-completion-audit-item-identity-168` continues the retained LabCanvas
session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`. Its fallback
copied example IDs `source:123` and `interruption:456` from the output schema
instead of classifying the actual packet items, yet the structurally valid JSON
could reach terminal success. That could mark the wrong chat message covered
while silently omitting a consecutive or interrupted request.

Explicit completion-audit turns now derive their allowed IDs from the final
task packet and require every request item to appear exactly once across
`covered_item_ids` and `missing[].item_id`. Unknown, omitted, duplicated,
overlapping, and malformed references receive one bounded repair with the exact
allowed IDs. If repair still fails, the run stops without `session.finished`
and returns a schema-valid audit that conservatively marks every actual item
missing. The retained phantom-ID case, valid result, overlap, repeated failure,
and an unrelated strict JSON envelope are covered. No live provider or LocalLLM
inference, LabCanvas runtime change, queue action, schedule, transport
operation, or external side effect is involved.

### Completion-audit missing entries preserve their nested contract

`labcanvas-completion-audit-missing-entry-shape-169` extends the same retained
completion-audit boundary. After exact item identity was enforced, an audit
could still classify the right task ID as missing while omitting its actionable
`requirement` and returning a `kind` outside the declared
`reply|artifact|action` choices. The top-level JSON remained structurally valid,
so downstream repair could receive an unusable or misrouted instruction.

The explicit completion-audit contract now derives each `missing[]` entry's
required keys, types, and pipe-delimited enums from the caller's own example.
Missing fields, wrong types, empty requirements, non-object entries, and enum
violations join the existing item-identity diagnostics and receive the same one
bounded repair. This remains scoped to an explicit `completion_audit` role with
a recognized task packet; unrelated strict JSON envelopes retain their prior
behavior. The before-fix case completed in one call, while the repaired case and
provider-handoff compatibility control now pass. No live provider or LocalLLM
inference, LabCanvas runtime change, queue action, schedule, transport
operation, or external side effect is involved.

### Explicitly closed JSON envelopes reject undeclared fields

`labcanvas-strict-json-unexpected-fields-170` extends the retained response-only
host-envelope cases. AgInTi already required every declared top-level key, type,
and enum, but it accepted additional fields. A fallback could therefore return
the correct host payload plus undeclared provider, trace, status, or runtime
metadata and still finish, despite an explicit `strict`, `exactly`, `only`, or
`no prose` contract.

Contract discovery now records whether the exact schema marker closes the
top-level shape. Explicit strict/exact/only/no-prose markers and JSON
schema/shape/format headings reject undeclared fields, report their names, and
use the existing one bounded repair and schema-valid fail-closed path. A plain
`Return JSON:` example remains extensible and can carry useful optional fields.
Regressions cover both tool-capable completion and DeepSeek-to-LocalLLM
response-only handoff, plus the open-shape compatibility control. No live
provider or LocalLLM inference, LabCanvas runtime change, queue action,
schedule, transport operation, or external side effect is involved.

### Completion audits cannot invent legitimate blockers

`labcanvas-completion-audit-false-blocker-171` comes from retained production
session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`. One audit
correctly identified that the candidate had produced no reply or artifact, but
also returned `legitimate_blocker=true` with an empty `covered_item_ids` array.
The candidate had not described a login, approval, dependency, safety, or other
blocker. Exact item-identity validation therefore passed a contradictory audit
that could turn ordinary missing work into a terminal excuse.

Completion-audit contract discovery now records whether the exact packet's
`candidate_result` actually contains a blocker explanation. A true
`legitimate_blocker` is valid only when that candidate evidence exists and the
audit places at least one exact task item in `covered_item_ids`, as required by
the host contract. Unsupported blocker flags receive the existing single
bounded schema repair; repeated invalid output still fails closed with all
actual item IDs marked missing and `legitimate_blocker=false`.

The regression preserves normal missing-work audits, accepts genuine English,
Chinese, and Japanese authentication blockers while rejecting their explicit
no-blocker forms, and covers the DeepSeek-to-LocalLLM response-only handoff. It
performs no live provider inference, LabCanvas runtime change, queue action,
schedule operation, transport operation, or external side effect.

### Empty candidates cannot cover requested work

`labcanvas-completion-audit-empty-candidate-coverage-172` was found by pairing
every retained completion-audit prompt with its exact task packet and terminal
result. Seven audits put one or more exact request IDs in `covered_item_ids`
while the explicit `candidate_result` contained no message, file, publication
state, generated content, or other meaningful value. Their own summaries said
the reply, PDF, or video delivery was missing, but the contradictory structured
classification could prevent that work from being reprocessed.

When an explicit completion-audit packet includes `candidate_result`, contract
validation now records whether it has any meaningful output. A genuinely empty
candidate cannot cover an item. It receives one bounded repair, and repeated
invalid coverage stops conservatively with the actual item marked missing.
This rule does not infer emptiness when an older generic packet omits
`candidate_result`, and it permits an empty candidate when the exact human
request explicitly asks for no reply or a blank response.

Regressions cover the retained contradiction, bounded repair, repeated-invalid
fail-closed behavior, explicit-silence compatibility, omitted-candidate
compatibility, and DeepSeek-to-LocalLLM response-only handoff. No live provider
or LocalLLM inference, LabCanvas runtime change, queue action, schedule,
transport operation, or external side effect is involved.

### Local-server smoke tests preserve foreign listeners

`webapp-command-occupied-port-isolation-173` came from the full package gate,
not a synthetic model response. The slash-command smoke selected a random port
already occupied on the shared workstation. AgInTiFlow correctly started its
webapp on the next compatible port, but the smoke waited only for the original
URL and timed out. Its cleanup then used `lsof` against the requested port,
which could terminate the unrelated listener while leaving the actual fallback
webapp behind.

The smoke now reserves an occupied kernel-assigned port deliberately, accepts
the verified fallback URL printed by the CLI, and checks that the foreign
listener survives. Cleanup extracts only URLs observed during that test and
calls the normal ownership-aware webapp stop API with the exact temporary
runtime directory and home. It no longer kills arbitrary listeners by port.
Repeated focused runs also prove that no test-owned fallback process remains.
The full gate then exposed the same fixed-range random-port assumption in the
standalone public-research smoke. All affected Studio fixtures now ask the
kernel for an ephemeral loopback port and consume the child process's announced
URL, so a release-to-bind race still follows the product's normal fallback.
The standalone public-research CLI accepts port `0` and reports the actual
kernel-assigned URL, eliminating that race without probing or killing any
foreign listener.

### Ambiguous-input clarification is not a forecast

`labcanvas-ambiguous-input-negated-forecast-174` correlates three retained
response-only failures for the bare message `199793`. The router correctly
selected natural clarification, but explanations such as “not enough context
to predict intent” or “no forecast is requested” contained forecast vocabulary.
The evidence guard treated that metalinguistic wording as an external future
claim, retried it, then stopped the otherwise valid route.

The source-free validator now recognizes bounded English, Chinese, and Japanese
ambiguous-input explanations and explicit forecast negation. This exception is
semantic rather than route-specific: the same sentence must name an ambiguous
input or actually negate forecasting, and it stops applying when any residual
text asserts a future outcome. Genuine claims such as “the market analysis
predicts demand will grow next year” remain fail-closed. A deterministic
DeepSeek-to-LocalLLM handoff regression proves the production-shaped route
finishes in the first fallback turn without requiring evidence or changing the
caller envelope.

### Progress acknowledgements cannot close substantive tasks

`labcanvas-completion-audit-status-only-coverage-175` comes from retained
production session `web-agent-labcanvas-7159acc2-9bbe-4254-825b-ed6819f8e269`.
A completion candidate said that it would send the finished portion now and
supplement the uncovered messages later. The message was nonempty, so the
existing empty-candidate safeguard could not prevent an audit from placing the
substantive research item in `covered_item_ids`. This is the failure mode behind
apparently responsive chat that never delivers the promised answer or artifact.

Completion-audit contract discovery now distinguishes a human-facing result
from a receipt, progress report, queue notice, generic completion assertion, or
promise of later delivery. A status-only candidate cannot cover a substantive
task item. It gets the existing one bounded repair; repeated invalid coverage
fails closed with every exact packet item retained as missing. The test surface
uses semantic English, Chinese, and Japanese forms rather than a LabCanvas
route or transport special case.

The compatibility boundary is explicit. A short social turn, a request that
asks only for acknowledgement, and a pure status question may be answered with
status text. A concrete answer following an acknowledgement, a real attachment,
a confirmation question, generated content, publication state, or a genuine
blocker remains substantive. Deterministic regressions cover bounded repair,
repeated-invalid fail-closed behavior, negated acknowledgement wording, and
DeepSeek-to-LocalLLM handoff. No live provider or LocalLLM inference, LabCanvas
runtime change, queue action, schedule, transport operation, or external side
effect is involved.

### Text answers cannot stand in for requested artifacts

`labcanvas-completion-audit-artifact-coverage-176` extends the retained
completion-audit family behind repeated LabCanvas reports that an answer
arrived but its requested PDF did not. The auditor could place an exact item in
`covered_item_ids` when `candidate_result` contained a useful answer but an
empty `files` list. Empty- and status-only-candidate checks did not apply
because the answer itself was substantive.

Completion-audit contract discovery now derives explicit material artifact
requirements from each exact request item and compares them with structured
candidate evidence. Files, attachments, artifacts, deliverables, matching
extensions and MIME types, and host-owned generated PDF content count; a prose
claim that a file was sent does not. The check covers common document, image,
video, audio, archive, and CAD formats in English, Chinese, and Japanese.

The intent boundary distinguishes outputs from inputs: reading a PDF,
analyzing an attached video, or sending a summary of a video does not require
the source media to be returned. Negated artifact requests remain text-only.
One invalid audit receives the existing bounded repair. Repeated invalid
coverage fails closed with the original exact request retained as a missing
artifact item. Deterministic tests cover direct execution and
DeepSeek-to-LocalLLM handoff without live inference, LabCanvas changes, queue
actions, schedules, transports, or external side effects.

### Completion audits enforce negative artifact contracts

`labcanvas-completion-audit-forbidden-artifact-177` comes from retained
production session `web-agent-labcanvas-f8f84223-7216-4bcf-abe6-999d4fb074ff`.
Its exact inspiration request required one natural chat message and explicitly
said to create no files or attachments. The candidate nevertheless placed
`worker_result.json` in the structured outbound file list. The model called it
an internal transport envelope and treated the request as covered, contradicting
the packet rule that `candidate_result.files` is the outbound attachment list.

Completion-audit contract discovery now derives negative artifact constraints
from each exact request item. Structured files and generated document, image,
video, or audio content cannot satisfy a covered message-only item when that
item forbids them. Format-specific exclusions remain narrow: a PDF-only request
may reject an extra Markdown source without rejecting the PDF. A separate exact
item that positively requests an artifact wins only for that independent
requirement, preserving consecutive-message composition instead of applying a
global no-file switch.

The retained shape previously completed in one call. Deterministic regressions
now cover English, Chinese, and Japanese wording, generated document content,
specific-format exclusions, mixed request packets, one bounded repair,
schema-compatible failure, and DeepSeek-to-LocalLLM handoff. No live provider
or LocalLLM inference, LabCanvas change, queue action, schedule, transport, or
external side effect is involved.

### Unverified inspirations may contain proposed experiment parameters

`labcanvas-source-free-inspiration-experiment-178` follows retained production
session `web-agent-labcanvas-acfafa25-d3c5-4a4e-9e12-1813973211a2`. A scheduled
inspiration explicitly returned `一个未经本机验证的灵感假设`, a falsifiable biological
idea, counterexample, and proposed `0/2/4`-hour experiment. The source-free
guard rejected it twice: it did not recognize that natural Chinese hypothesis
framing, then classified numeric protocol settings and the instruction to
validate paired data as completed benchmark and external-evidence claims.

The source-free classifier now recognizes this assistant-owned unverified
hypothesis form even when it appears inside a structured response. It also
distinguishes proposed experiment parameters and next-step validation from
claims about already observed results. The exception does not cover completed
validation or benchmark language, attributed sources, named journals, or named
external tools; those still require fresh scoped evidence.

The exact retained goal and candidate now pass directly. Deterministic tests
cover the structured Chinese response, numeric group/duration parameters,
completed-result and named-tool negatives, and DeepSeek-to-LocalLLM handoff.
No live provider or LocalLLM inference, LabCanvas change, queue action,
schedule, transport, or external side effect is involved.

### Model compatibility retries retain deadline and cancellation authority

`provider-request-lifecycle-20260927` is an offline reproduction from the
current integration baseline `bf9c3e0`, not a new claim about an old live session.
A reasoning-parameter compatibility retry could outlive the original model
deadline and return late success. Caller cancellation also relied solely on the
SDK settling its own request. A real SDK with an offline fetch fixture confirmed
the compatibility-retry failure during rate-limit backoff.

`createChatCompletion` now applies one interruption boundary to both attempts.
Pre-cancelled requests do not dispatch, cancellation cannot start a retry, and
timeout or cancellation cannot become late success. Normal reasoning-parameter
fallback, provider error annotation, and existing handoff policy are preserved.
Parent listeners and the AgInTi deadline timer are removed on settlement.

Eight deterministic regressions cover the deadline, both cancellation phases,
pre-cancelled work, abort during compatibility failure, successful fallback,
ordinary provider errors, and SDK Retry-After backoff. Six failed before the
repair; all eight pass afterward. The existing same-session provider-handoff,
local recovery, context, inbox, completion, and planner smokes also pass.
Remote provider compute termination and live latency are not inferred from
these tests. See `docs/general-agent-backend-research-2026-09-27.md` for the
source comparison and proposed application integration work. The older private
SQLite campaign was inspected read-only and was not relabeled as new evidence.

### Read-only inputs do not become mandatory source edits

`requested-source-deliverable-20260927` uses the persisted runtime on top of
`a5287e9`, with a scripted offline provider and real temporary workspace files.
The ordinary request was: "Read notes.txt and risks.txt. Write summary.md with
the main issue from each. Leave the input files alone."

Before the fix, the runtime offered only `read_file`, then only `apply_patch`
against an input. It rejected the next valid input read and output write and
stopped with `tool_contract_violation` after three model turns. This was a core
execution-contract/progressive-disclosure error: source inspection plus a
separate deliverable was confused with a requirement to repair existing source.
It was not a provider failure or an application-specific routine gap.

The runtime now distinguishes separately declared inputs and outputs when
selecting repository grounding and mandatory mutation targets. Source inputs
are not forced edit targets without a positive edit request. Explicit output
exclusions still apply, but do not erase a positively requested input read.
Sentence boundaries keep unrelated absent/forbidden paths from becoming input
requirements merely because a later sentence says "from current evidence."
Negated English/Chinese source-edit clauses do not authorize input modification.

Five new persisted-runtime scenarios cover the normal English request, explicit
named write exclusions, Chinese wording, recovery after a missing-input finish
attempt, and a resumed request for a separate checklist. Successful ordinary
and resumed paths take four model turns each. Tests independently compare both
input files and the produced artifacts, and inspect durable rejection evidence
for the unread source. Positive fix/repair/update controls retain the genuine
source-mutation requirement. Existing evidence, progressive-tools, dynamic-step
budget and truthful-completion smokes pass.

This is deterministic core evidence, not a live DeepSeek/LocalLLM quality or
latency benchmark. No application routines, private task data, model inference,
production wiring, installed package or release version was changed. The
separate permissive shell-filename source-coverage path noticed during initial
inspection was not repaired or certified by this slice. Natural-language
contract inference and arbitrary model answer quality remain bounded by the
existing runtime checks, not a claim of universal instruction compliance.

Validation at this checkpoint:

- `node scripts/smoke-scs-evidence-visibility.js`
- `npm run smoke:truthful-completion`
- `npm run smoke:progressive-tools`
- `npm run smoke:dynamic-step-budget`
- `npm run check` (300 JavaScript files)
- `AGINTIFLOW_PROVIDER_ATTRIBUTION_LIVE=0 npm test` (exit 0; the document-worker
  server and cross-boundary smokes used their existing occupied-port skips for
  `127.0.0.1:18102`; no claim that those two live checks ran)
- `npm pack --dry-run --ignore-scripts --json` plus a structured package-path
  scan, and `git diff --check`

The primary worktree is untouched. This checkpoint is isolated under
`AgInTiFlow-worktrees/AgInTiFlow-instruction-following`; publication and live
provider/application acceptance remain separate steps.
