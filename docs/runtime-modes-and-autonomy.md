# Runtime Modes And Long-Running Autonomy

AgInTiFlow should feel like a normal coding agent, but with an explicit execution contract. The core decision is not "safe versus useful"; it is which execution mode matches the task.

## Evaluation Of The Tmux-In-Docker Case

The failed task was expected under the current Docker design, but the agent should have chosen a better path.

- `run_command` in Docker mode uses short-lived `docker run --rm` containers.
- A tmux server started inside that container dies when the command exits.
- Persistent folders such as `/aginti-env` and `/aginti-cache` preserve files and language environments, not running processes.
- For durable terminal sessions, the correct tool is host-side `tmux_start_session`, followed by `tmux_capture_pane` and `tmux_send_keys`.

The fix is guidance plus guardrails: raw `tmux` shell commands are blocked inside Docker `run_command`, and the model is told to use host tmux tools for durable sessions.

Important boundary: host tmux tools are durable, but they are not a permission escape hatch. In `docker-readonly` and `docker-workspace` modes, `tmux_start_session` and `tmux_send_keys` are still workspace-bound. Startup commands and sent shell text must use relative paths under the project, not absolute host paths outside the project. In `host` mode, tmux startup/send command text follows the same host shell policy as `run_command`, so broad host shell work requires `--allow-destructive`. Narrow workspace-local probes/builds can run without full-host trust, but if a task really needs `/home/...`, `/etc/...`, an emulator outside the project, or whole-host maintenance, rerun explicitly with `--sandbox-mode host --allow-destructive`.

## Execution Modes

| Mode | Similar Codex idea | Best use | What persists | Risk |
| --- | --- | --- | --- | --- |
| `docker-readonly` | `-s read-only` | Inspect code, run read-only checks | Session logs only | Lowest |
| `docker-workspace` | `-s workspace-write` | Normal coding, plotting, LaTeX, package setup | Workspace files, `/aginti-env`, `/aginti-cache` | Low to medium |
| `host` conservative | Workspace access with approval | Git, host tools, local previews | Host filesystem changes in project | Medium |
| `host` trusted | `-s danger-full-access -a never` style | Autonomous computer maintenance, host services, privileged workflows | Host state | High |
| Future persistent container | Externally sandboxed full-auto | Long-running services and durable container processes | Workspace, env, running processes | Medium |

Codex exposes these concerns as `--sandbox read-only|workspace-write|danger-full-access` and `--ask-for-approval untrusted|on-failure|on-request|never`. AgInTiFlow maps the same philosophy into:

- `-s safe|normal|danger` and `/safe`, `/normal`, `/danger`
- `--sandbox-mode host|docker-readonly|docker-workspace`
- repeatable `--read-root /absolute/reference/repository` for structured read-only cross-repository inspection
- `--package-install-policy block|prompt|allow`
- `--allow-shell|--no-shell`
- `--allow-destructive`

Read roots are narrower than danger mode. `inspect_project`, `list_files`,
`search_files`, `read_file`, and `read_image` may inspect an explicitly named
root, while every write still remains inside `--cwd`. Use read roots for
established sibling routines and reference repositories. Do not replace them
with recursive `grep`; use bounded workspace search or targeted `rg` with an
explicit path, relevant globs, and a result limit.

## Continuing The Active Task

A generic continuation advances the conversation revision while preserving the
active execution task. Completed source-grounding progress carries forward when
the workspace is identical, every intervening continuation binds the same task
and active intent, and the execution phase has an exact task-owned material
mutation record. Missing, contradictory or changed scope requires fresh grounding.

This avoids repeating repository discovery solely because the chat turn changed.
New concrete requirements establish their own execution phase. Existing source
repair, test freshness, artifact, permission and completion gates still apply;
filtered test output cannot stand in for a verified passing test. The native
session's progress markers do not attest external filesystem immutability or
protection against same-user session-state forgery.

## Docker Package Installs

Docker package installs are safe when they match the sandbox contract.

- `npm`, `pip`, `conda`, `curl`, `wget`, and `chmod` are practical inside `docker-workspace` when package policy is `allow`.
- Python and conda-style environments should live under `/aginti-env` so they survive future runs.
- Download caches should live under `/aginti-cache`.
- OS package installs such as `apt-get install htop` affect only the current short-lived command container unless the Docker image is rebuilt.
- To make OS packages portable, add them to `docker/sandbox.Dockerfile` and rebuild with `scripts/setup-agent-toolchain-docker.sh`.

Use the built-in Docker setup command for the normal sandbox/toolchain path:

```bash
aginti docker status
aginti docker setup
```

`aginti docker setup` builds or verifies the companion sandbox image and checks Node, npm, Python, matplotlib/numpy, `latexmk`, `pdflatex`, git, and ripgrep inside Docker. If host Docker itself is missing, AgInTiFlow prints platform-specific install guidance. `aginti docker install-host --yes` is only an explicit opt-in helper for supported Ubuntu hosts; npm postinstall does not silently install Docker or mutate host services.

This is why a task can safely install Python packages in Docker, but cannot keep an interactive tmux server alive inside a one-shot Docker command.

## Permission Contract

The runtime must be consistent when an action is not permitted. A blocked action should not become a loop of slight command variants, and a failed setup step should not be reported as success just because a stale folder already exists.

Current contract:

- `safe` asks before file-tool writes and package/setup actions. It is the right mode for inspection, review, and cautious first passes.
- `normal` allows writes inside the current project folder, read-only inspection of visible host data roots, and package/setup inside Docker workspace mode. It still blocks outside-project writes and host-system changes until approved.
- `danger` is trusted host/full-access mode: host shell, destructive actions, host installs, password typing, and outside-workspace file paths are enabled. Use it only for tasks you trust; obvious secret/publish exfiltration guards remain hard stops.
- Workspace file tools may read and write inside the configured project folder when file tools are enabled.
- Narrow workspace-local shell actions such as safe probes, Gradle/TeX builds, and `chmod +x` on a project script may run when the command policy can classify them precisely.
- Finite literal read-only audits may bind a small literal path, inspect/hash it, count matches through a bounded read-only pipeline, summarize stdin with `sort | uniq -c`, and display numeric results with `echo` or `printf` without asking for destructive permission. Shell line continuations are accepted for finite literal item lists. Every producer, consumer, and surrounding command must still classify as bounded read-only work; network access, redirects, output-file operands, secret/dynamic expansion, shell-state `printf -v`, mutation, dynamic item lists, and computed values used as executable arguments remain blocked.
- Completion checks distinguish a resolved historical state such as "previously paused" from work that is currently pending or incomplete. A resolved past blocker therefore does not force another verification loop, while any explicit current unfinished state still does.
- Android/JVM toolchain commands may include safe local env assignments such as `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, or `GRADLE_USER_HOME`, plus small workspace-local status-log redirects. Secret-like env vars and redirects outside the workspace remain blocked.
- Workspace writes outside that folder, secret paths, `.git` internals, and dependency folders such as `node_modules` are blocked.
- `git clone`, `git fetch`, `git pull --ff-only`, `git push`, `curl`, and `wget` are classified as network operations.
- Network/setup commands are allowed in `docker-workspace` only when package installs are approved.
- Host `sudo` and host OS package installs are not automatic. The agent should ask the user to run a manual command or switch to a safer Docker setup.
- Destructive host shell/git operations need explicit trusted host mode.
- Android SDK/emulator work commonly needs host mode because `adb`, emulator images, and device state live outside Docker; use trusted host mode for install/launch/screenshot steps when the user approves that host access.

When a tool is blocked, the tool result includes `permissionAdvice`. Interactive CLI and web runs present the same approval language: `No`, `Yes this time`, and `Yes and always for this session`. One-time approval temporarily escalates the active continuation; always switches the session to the suggested shortcut mode. The model prompt requires the agent to present that blocker and avoid retrying variants until the user approves a path.

The common controlled rerun shape is:

```bash
aginti --resume <session-id> \
  --cwd /path/to/project \
  --sandbox-mode docker-workspace \
  --package-install-policy allow \
  --approve-package-installs \
  --allow-shell \
  --allow-file-tools \
  "Continue after approval and verify the output was created in this run."
```

Three practical permission recipes:

```bash
# Safe: read-first, ask before writes and setup.
aginti -s safe "inspect this project without edits"

# Normal: write in the current project folder, setup isolated in Docker.
aginti -s normal "build and test this project"

# Danger: full trusted host access for maintenance or emulator/device work.
aginti -s danger "perform the trusted host maintenance task"
```

For host-only work, use the stricter trusted form deliberately:

```bash
aginti --resume <session-id> \
  --cwd /path/to/project \
  -s danger \
  "Continue after trusted host approval. Inspect first and keep unrelated files untouched."
```

## Recommended Defaults

Default daily coding:

```bash
aginti
```

This starts interactive chat with Docker workspace mode, file tools, shell tools, web search, and package installs allowed inside Docker.

Docker workspace mode also mounts common host data roots, such as the user's home parent, read-only at their original absolute paths. This lets a task in `/home/lachlan/ProjectsLFS/aginti-test` inspect a sibling dataset such as `/home/lachlan/ProjectsLFS/ProteinStructure` without switching to host-write mode. Outputs and edits still belong under `/workspace` unless the user explicitly approves stronger host permissions. Set `AGINTI_DOCKER_READONLY_HOST_MOUNTS=/path/a:/path/b` to override the read-only mounts, or set it to `off` to disable them.

For a linked Git worktree, bounded Git mutation commands such as the runtime's path-enumerated `git add` plus `git commit` also receive a writable mount for the validated shared Git common directory. The mount is not added to ordinary shell commands or read-only Git inspection. This lets Docker workspace mode commit the current worktree without granting broad host-write access.

Outstanding exact project commands always run before Git completion. A pending producer, test, or user-declared validation command cannot be preempted by a commit merely because the current artifacts already exist.

Direct trusted host mode:

```bash
aginti -s danger "fix this local service"
```

Use this only when the task truly needs host access. The agent should inspect first, show risky commands, stop on ambiguity, and avoid secrets.

Durable tmux task:

```bash
aginti "start a tmux session named demo, run ls in it, keep it open, and tell me how to attach"
```

The agent should use `tmux_start_session`, `tmux_send_keys`, and `tmux_capture_pane`, not Docker `run_command`. In Docker sandbox mode, tmux commands must stay inside the project. In host mode, tmux command text is still governed by host shell policy; if a tmux command is blocked, present the suggested rerun path instead of trying tmux as a workaround. For trusted whole-host tmux work, use the host recipe above.

Long download or long command:

```bash
aginti "download this large zip with wget -c, verify the final byte count, and do not burn model steps polling it"
```

The agent should use `start_long_job` once instead of repeatedly calling `wait`, `run_command`, or `tmux_capture_pane`. The tool creates `.aginti/long-jobs/<job-id>/status.json`, stdout/stderr logs, a supervisor log, and an optional status card. For resumable downloads, the agent should first determine `Content-Length` when practical, then call `start_long_job` with:

- `command`: a resumable transfer such as `wget -c URL -O file.zip`
- `expectedOutputPath`: the downloaded file
- `expectedSizeBytes`: the expected byte count
- `verifyCommand`: a deterministic check such as `unzip -t file.zip` or `sha256sum -c`
- `restartOnFailure`: `true` when the transfer command is safe to resume

After `start_long_job` succeeds, the model loop should finish with the job id and status path. Later status checks should use `long_job_status` or direct shell inspection of the status JSON. This keeps multi-hour I/O under a shell supervisor instead of consuming model tokens and step budget.

## Future Persistent Container Mode

A useful next runtime mode is a service container:

- Start one named container per project, for example `agintiflow-<project-hash>`.
- Mount the workspace, `/aginti-home`, `/aginti-cache`, and `/aginti-env`.
- Keep the container alive with a shell, supervisor, or tmux server.
- Execute later commands with `docker exec` instead of `docker run --rm`.
- Provide explicit lifecycle commands: start, status, capture, stop, reset, rebuild.

This would support durable tmux, dev servers, long installs, notebooks, and language servers inside a portable container while still isolating the host.

## Long-Running Autonomy

Passing project tests carry a bounded workspace metadata observation. Resume and
completion recheck that observation before reusing the pass. Changes to visible
source, tests, manifests, generated inputs or vendored dependencies invalidate
the verifier revision; they do not manufacture an agent-owned edit. AgInTi must
run fresh verification and repair a genuine failure before claiming completion.
Even a previously completed task cannot use its no-op continuation shortcut
after this observation changes.

The observer excludes exact configured private runtime storage, reads metadata
only, stores hashes and counts, and follows the
existing sensitive-path and task-scope policy. It visits at most 4,096 entries
and 12 directory levels, rejects child symlinks and incomplete observations,
and never persists source bytes or filenames in its fingerprint. Old sessions
without a complete observation, and oversized or unobservable workspaces, need
a newly observed test in each invocation. An unchanged observable workspace can
retain its pass without running tests again. An unresolved failed test remains
a failure; revalidation cannot erase it by advancing the verifier revision.

This is ordinary workspace-change detection, not a content seal, atomic file
transaction, same-user forgery defense or proof about private/cache trees,
external dependencies, services or environment variables. Those remain separate
verification boundaries.

Large tasks should not stop because an early high-level plan ran out. AgInTiFlow should use rolling plans:

1. Orient: inspect project instructions, git status, manifests, and current files.
2. Plan the next phase only: choose a concrete milestone with a check.
3. Execute: edit files, run commands, and capture artifacts.
4. Gate quality: run the narrowest useful test, lint, compile, preview, or smoke check.
5. Checkpoint: persist a session event, artifact, diff, or note.
6. Replan: if the goal is not done, generate the next phase from the current state.
7. Stop only when the requested outcome is complete, blocked by a real dependency, or the user interrupts.

This keeps the agent sober. It avoids giant low-quality plans while still allowing long autonomous work.

## Cancellation and completion

Cancellation observed after final review or an asynchronous inbox read pauses
an active invocation before it admits a new completed-state save. Confirmed
tool and file receipts remain available for explicit same-session continuation;
the cancelled invocation emits a stopped outcome rather than task completion.
Response-only final validation uses the same admission boundary.

Once completion persistence is admitted, its I/O establishes the durable
outcome. A later cancellation does not retract a durably confirmed completion
or undo its file changes. Delivery interruptions retain that saved outcome.

Stopped notifications and saved-state messages require successful state and event
writes. If saving a pause or anticipated provider failure fails, the invocation
surfaces that storage error before emitting its stopped/failed notification or
returning a saved outcome. A rename that succeeded before a later I/O error may
already have persisted state; inspect the saved session before explicitly resuming.
Confirmed tool effects are retained, and no storage failure triggers a retry of them.

## Provider quota interruptions

The native runtime treats HTTP402 and explicit HTTP429 quota/billing codes as
terminal for the current provider request. The supported machine codes are
`insufficient_quota`, `insufficient_balance`, `billing_hard_limit_reached` and
`quota_exceeded`, in the error's `code` or `type` field. Code matching is case
insensitive; a quota word in prose alone does not establish this condition.

These errors do not spend SDK retries or reasoning/tool compatibility retries,
and do not trigger timeout/transport history compaction. HTTP status, error body
and request metadata remain available; only the SDK retry hint is forced off.
Ordinary and unclassified rate limits retain their existing bounded backoff.
The same decoded-response size limit and cancellation boundary still apply.
This policy belongs to the native runtime's model HTTP client; it does not
replace an application's independent provider and quota policies.

Confirmed tool receipts and completed artifacts stay in the saved session. After
resolving the account limit or explicitly selecting another qualified route,
resume that session and reconcile the remaining work. Switching models on the
same exhausted account does not replenish its balance. Configured provider
handoff policy remains separate; this change enables no provider or fallback.
A missing receipt does not prove an operation never happened, so inspect such
ambiguous work before retrying rather than assuming exactly-once execution.

`npm run test:model-terminal-quota` covers terminal versus transient errors,
misleading retry/compatibility hints, transport limits, and a persisted two-file
task interrupted after its first confirmed artifact. Explicit model continuation
finishes the remaining file without rewriting the first.

## Checkpoint-only continuation

A bounded cue such as “continue from where we left off” continues the saved
material task rather than becoming a new generic execution request. Equivalent
checkpoint wording is recognized in English, Chinese and Japanese. The runtime
keeps the task's confirmed evidence and required commands. Explicit new actions,
paths and questions remain active requirements; they are not swallowed as a
resume-only no-op. A checkpoint-only cue after verified completion invokes no
model or tool and does not repeat side effects.

If an older runtime replaced the active goal with such a cue, retained material
history can restore the actual goal and discard a plan inferred for the generic
cue. History and mutation provenance are not rewritten. Missing material history
does not authorize an invented task, and older artifacts still need their normal
source, freshness and provenance checks.

`npm run test:native-checkpoint-continuation` covers these boundaries, including
official CLI continuation after a saved first artifact and a provider failure.

## Artifact data and task instructions

Named-file transforms such as “turn input.txt into a short report.md” bind the
input and output to different roles and require source grounding. The bounded
grammar also supports convert/transform, quoted filenames and input lists.
Negation, explanations, quoted commands and unnamed prose do not grant output
roles or filesystem permission.

Reading a generated document does not make it a task instruction merely because
its name is TASK, BRIEF or INSTRUCTIONS. Declared outputs and known native
mutation paths cannot elect themselves as instruction or acceptance sources.
The project-instruction heuristic for pre-existing task documents binds the
recorded complete read's SHA256 and active task scope; a later changed file or
a read from a different task cannot supply new requirements through that
heuristic. Real project requirements and explicit command checks still apply.
This does not make model interpretation of arbitrary source prose trustworthy,
or provide retained-descriptor isolation for a hostile shared filesystem.

`npm run test:artifact-instruction-boundary` checks transform roles, negative
language, generated/persisted instruction claims, stale hashes and task scope.

## Documentation Maintenance

The documentation should be maintained as product code:

- Keep reference docs in `docs/`.
- Link important docs from `README.md` and the marketing website.
- Add smoke tests when a workflow becomes behavior, not just guidance.
- Update `AGINTI.md` for project-specific operating memory.
- Treat docs changes as part of the release checklist before publishing npm.

## Bounded SCS completion evidence

The SCS finish review receives a valid JSON preview bounded to 7,000 UTF-8
bytes. Current tool receipts, required evidence categories and failed checks
have dedicated budgets; a long approved plan cannot displace them. Truncated
sections are labelled in the preview. The preview is advisory: deterministic
source, artifact and completion gates still use the authoritative session state,
and model approval cannot override missing execution evidence.

An instruction to check an input followed by an independent instruction to save
outputs retains those output names. Quoted examples, command arguments and
negated creation instructions do not become output authority.

`npm run test:scs-proof-budget` checks proof priority, multilingual byte bounds,
secret redaction and a persisted native SCS tool loop with one producer execution.
`npm run test:output-clause-boundary` checks output requests and negative cases.
These tests use local fixtures; they do not establish model quality or application
sandbox readiness.
# Failed-test repair context

Automatic repair context uses the same canonical workspace read checks as
`read_file`, including selected read-only roots, secret-path exclusions,
file-tool permission, byte limits and strict text decoding. A failed command
does not grant access to an external validator or its parent directory. Explicit
validator-source exclusions also apply to automatic context. Sensitive content
is redacted; redacted snippets cannot serve as exact patch anchors. Obsolete
automatic repair packets are discarded when a session resumes.

A request to create a named missing file can reach creation before a possible
future repair clause. An observed test or source-quality failure still requires
repair and verification. Native host commands set `PYTHONDONTWRITEBYTECODE=1`
to avoid creating stale timestamp-based caches during rapid Python edit/test
loops. Existing caches and Python modes that ignore environment variables are
outside that guarantee.

These checks enforce path policy using current filesystem observations. They do
not provide retained-descriptor isolation against hostile same-user mutations.

## Artifact verification context

Artifact preflight projects authorized text through the same native read
boundary. It reads at most 16 files, 128,000 bytes per file, and supplies at most
16,000 UTF-8 bytes per excerpt and 18,000 bytes of aggregate output context.
Opaque binaries remain with format-aware validators. Invalid text, NULs,
denied scope and changed live bindings do not become inline artifact content.

Only complete, unredacted snapshots with complete names can suppress redundant
output reads. Excerpts and omitted outputs carry no such claim. The context
digest binds the actual packet, output paths and goal revision; a boolean alone
cannot advertise absent context. This digest detects accidental drift, not
same-user forgery or application authentication. Resume retires cached automatic
packets before a provider sees them; current artifact validation gates remain.

The POSIX native reader opens with O_NONBLOCK before requiring a regular file,
so a FIFO cannot strand it waiting for a writer. Regular-file behavior is
unchanged. This is not a general filesystem deadline or retained storage proof.

Native patch preparation uses the same canonical read boundary and a complete
220,000-byte source limit. Unavailable, excluded, changed or malformed source
cannot become an exact patch anchor, a recovered no-op or a syntax diagnostic.
Prospective Python checks parse the captured bytes through standard input with
isolated interpreter flags; they do not reopen the source pathname or load
ambient Python site hooks. Syntax diagnostics use the normal secret redaction.
These checks preserve the actual file-tool permissions and publication gates;
they do not add application sandbox or retained-storage authority.

Automatic document producer selection also uses a complete bounded source
snapshot, while preserving its synchronous decision API. It does not block on a
FIFO waiting for a writer. Missing, nonregular, malformed, oversized or excluded
sources supply no inferred compiler command or default-engine guess. Optional
external read roots do not authorize compilation of a replaced workspace output.
Valid workspace TeX still selects the existing PDF engine. This shares the native
canonical read policy; it is not a general deadline for regular-file I/O or a
retained-descriptor isolation guarantee.

Same-task continuations retain each previously observed acceptance source's
requirements when that source is missing, invalid or cannot be read safely.
A successful complete reread can still replace obsolete requirements; a failure
does not erase them, including when another source refresh succeeds. A new task
keeps its separate contract. Before final verification, the runtime may offer
create-only tools for exact missing declared outputs alongside a source-observed
completion-time checker. Directly requested commands and unknown/before-edit
ordering keep the existing command-first gate. Existing-file edits, failed-test
repair, file permissions and final fresh verification remain independently enforced.
For older sessions without an ordering marker, a complete current source may
establish completion-time ordering only if both retained obligation lists match
exactly. This observation cannot replace or erase the saved requirements.
Partial reads retain prior requirements and cannot establish completion-time
ordering. A complete native read must include its range, byte count and hash,
and still match the bounded current source before replacing saved requirements.

An explicit read-only diagnostic request can complete by reporting a closed
nonzero command outcome. That observation remains a failed check; it never
becomes a passing test or a completed repair. Explicit pass requirements still
need success. The runtime hides direct file writers for a read-only diagnostic
intent and tells the model to report results rather than repair unrequested work.
This does not sandbox arbitrary host commands or prove that a requested program
had no side effects.

Checkpoint continuation preserves the same diagnostic execution epoch only with
complete task and active-goal lineage. A concrete rerun, repair, new task or
observed file edit requires new evidence. Conservative command revisions from
exact requested diagnostics need their own digest-bound native receipts; missing
or unknown history cannot be used. If a provider returns no answer after the
bounded empty-response repair, the verified fallback can report the recorded
diagnostic exits without claiming that failed checks passed. No provider switch
or additional model call is introduced by that fallback.

SCS progress and final review use the same diagnostic evidence authority. When
the caller has not explicitly disabled that scope, the shared ledger derives it
from the current validated execution and read-only diagnostic contract. A missing
caller flag cannot turn an observed failed check into unexecuted work; stale or
unproven execution still cannot supply diagnostic completion evidence.

A bounded historical diagnostic question can ask why the prior check failed or
whether task files were changed, without requesting that work again. English,
Chinese and Japanese question forms are supported. The runtime retains the raw
question and prohibitions while inferring no fresh execution from those past
references. This supplies no new passing test, source snapshot or artifact proof.
Mixed requests, current inspection and retained unfinished task requirements
keep their ordinary evidence gates; unfamiliar phrasing remains conservative.
In particular, adding a requirement that checks pass is fresh verification work,
even inside the same question. A historical failure cannot satisfy it.

When such a bounded question has an explicit read-only contract with no fresh
execution, source-grounding, artifact or acceptance obligations, thorough/SCS
execution uses a fixed answer phase instead of asking a model to draft one.
Existing permission, completion and SCS final-review gates still run; a rejected
answer keeps the normal review/replan path. The phase supplies no new evidence
and does not force a finish-only tool turn. If no prior result is recorded, the
answer must explain what is unknown. Mixed requests and current execution
requirements retain their normal planning; existing approved plans are kept.

To recall an entry after restarting a session or switching providers, name the
saved result as the source. For example, “What was the checksum? Use the
previous output.” AgInTi offers only `finish` for a recognized lookup when
the active task has no outstanding execution requirements. The answer refers
to the earlier observation even if the file has since changed. A new session
without a prior result pauses and identifies the missing context.

To check the current value, ask to read or verify the source again. A request
to compare the two values or update a file keeps its execution requirements.

For this question type, the review preview can also include the preceding
diagnostic command's bounded stdout/stderr. It checks the native session event
anchor, goal-hash transitions, command-start/result pairing and failure outcome.
The preview labels these as past observations, never fresh command/test proof.
Missing, foreign, inconsistent or oversized history is omitted. Secrets and
absolute host paths are redacted. Native event history is not a signed audit
log or protection against an actor able to rewrite the session's own files.

SCS JSON roles can use the caller's available output allowance up to 4,096 tokens.
That allowance includes reasoning on models that charge reasoning against the
completion limit. A smaller explicit caller ceiling still wins, and the runtime
does not retry or change models merely to obtain review JSON. Existing timeout,
resident-model routing and hard evidence gates remain. If a deliberately small
budget cannot produce JSON, the existing fallback decision is not proof of a
successful model review.
