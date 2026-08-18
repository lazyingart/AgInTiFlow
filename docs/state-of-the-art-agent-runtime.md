# State-of-the-Art Agent Runtime

AgInTiFlow is designed as an embeddable agent runtime, not a prompt wrapper.
Its main job is to preserve intent, evidence, and tool progress while providers,
frontends, and long-running tasks change underneath it.

This architecture draws on proven patterns from durable agent systems,
including the append-only session and lifecycle ideas in
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness),
while retaining AgInTiFlow's provider-neutral tool and safety boundaries. The
implementation is local and does not import that repository as a runtime
dependency.

## Runtime Invariants

1. One logical conversation owns one durable session ID.
2. A continuation resumes that session; it does not replay the task from the
   beginning.
3. The current user request is authoritative, but prior verified evidence and
   unfinished requirements remain available.
4. Tool side effects are accepted only through explicit, validated contracts.
5. A final answer is successful only when its required evidence exists.
6. Provider failure is not task success and is not silently converted into it.
7. Provider handoff preserves the session and goal rather than duplicating
   external work.

## Durable Goal Contract

Every session stores a versioned goal contract in `state.json`:

- `revision`: advances for every resumed request;
- `currentHash` and `currentPreview`: identify the authoritative request
  without placing private raw prompts in operational indexes;
- `history`: bounded revision history with previous-goal and plan hashes;
- `status`: `active`, `completed`, `paused`, or `failed`;
- `lifecycle`: bounded status transitions with reason and timestamp.

Accepted direct answers, evidence-backed assistant answers, and `finish` tool
calls mark the current revision completed. User interruption, step exhaustion,
or a repairable tool-contract stop pauses it. Provider timeout, preflight
failure, and unexpected runtime errors mark it failed. A new continuation
reactivates the same session at the next revision.

Inspect it without parsing terminal output:

```bash
aginti sessions list
aginti sessions show SESSION_ID
```

Machine responses also expose `goalRevision` and `goalStatus`.

## Append-Only Evidence And Atomic State

The canonical session lives under
`~/.agintiflow/sessions/<session-id>/`. Atomic `state.json` snapshots hold the
resumable working state. Append-only JSONL events preserve lifecycle, tool,
model, evidence, inbox, and recovery facts. A project-local index points to the
canonical session without copying private history.

Malformed state is treated as corruption, not as a missing session. Event
appends are serialized, state saves are atomic and fsynced, and the SQLite
session index uses WAL plus a bounded busy timeout for multiple frontends.

## Safe Interruption And Inbox

`aginti queue SESSION_ID "instruction"`, the CLI composer, and the web app all
write to the same durable inbox. The runner consumes messages only at safe
boundaries:

- before a model step;
- after a tool action;
- before accepting completion.

This permits an operator or chat bridge to correct, narrow, extend, or cancel
the current direction without mutating an in-flight model request or replaying
completed side effects. ASAP input and after-finish input remain distinct.

## Progressive Context And Tool Disclosure

The first model turn receives a focused runtime contract, the current goal,
relevant project instructions, and only the skills selected for that request.
It does not receive an indiscriminate dump of every skill or workspace file.

Tool access is progressively disclosed:

- direct chat can answer without tools;
- unfamiliar repositories begin with bounded inspection and search;
- relevant routines are preferred over rebuilding mature workflows;
- a small batch of up to four independent read-only calls may run in one turn;
- writes, GUI actions, network writes, and irreversible operations remain
  isolated, ordered calls.

Workspace search is bounded by file count, bytes, and elapsed time. Default
root scans skip generated outputs, artifacts, and private data, while an
explicit path remains inspectable when the user actually requested it.

## Truthful Completion

Completion is checked against an evidence scope. Read-only answers and plans do
not need irrelevant command or visual evidence. File creation, publication,
GUI work, and other external actions require the corresponding evidence.

The runtime provides:

- one bounded retry when a model claims completion without required evidence;
- one bounded repair for an empty model answer;
- a concise fallback only when runtime evidence already verifies completion;
- a resumable stop instead of a false success when evidence remains absent;
- short-circuiting after a blocked tool so later calls in that batch are not
  dispatched against an invalid state.

## Provider Attribution And Handoff

`npm run eval:provider-attribution` compares a raw provider answer with the
same provider through AgInTiFlow. Results are classified as:

- `both_pass`: provider and orchestration both satisfy the contract;
- `orchestration_loss_or_help`: the runtime changed the outcome, so inspect
  prompting, context, tools, or completion gates;
- `provider_limit`: the raw model itself failed the contract.

This prevents orchestration bugs from being blamed on DeepSeek or a local
model, and prevents weak model output from triggering unnecessary framework
rewrites.

Embedding hosts should use a provider chain while preserving the same AgInTi
session. LabCanvas uses DeepSeek first and LocalLLM second. A handoff occurs
only after a categorized provider failure and must not replay verified side
effects. Codex and Claude remain explicit opt-in backends rather than hidden
fallbacks.

## Machine Host Protocol

The supported subprocess boundary is:

```bash
printf '%s' 'Do the task.' | aginti run --stdin --json [runtime options]
printf '%s' 'Continue with this correction.' \
  | aginti resume SESSION_ID --stdin --json
```

Exactly one JSON object is emitted. It includes success/failure, session,
provider, model, resume state, goal revision/status, result, stop state, and
reason. Interactive banners, update checks, and web startup are suppressed.
Stopped or failed runs always have `ok: false` even when they contain a useful
human-facing explanation.

## Established Routines, Not Reinvention

AgInTiFlow is the reasoning and supervision layer. Domain work should use the
existing routine owned by the relevant project:

- LazyEdit and AutoPublish for subtitle-aware video publication;
- LALACHAN/Xiaoyunque for story and video generation;
- Musia for music and song-first MV workflows;
- LabCanvas CAD, KiCad, Blender, TeX/PDF, presentation, grant, and figure
  routines;
- WeChat and WeCom transports for exact-chat delivery.

The agent selects, invokes, monitors, and verifies those routines. It does not
replace them with prompt-specific shell fragments.

## Acceptance Gates

A primary-backend release is accepted only after all of these pass:

1. Syntax and deterministic runtime tests.
2. Durable run/resume, goal lifecycle, inbox, and session-isolation tests.
3. Progressive tool, bounded search, and truthful-completion tests.
4. Raw-provider versus agent attribution for DeepSeek and LocalLLM.
5. A live read-only established-routine task with no accidental write.
6. A live exact artifact-creation task with byte-level verification.
7. A live LocalLLM direct-response task.
8. Host project tests, chat-bridge self-tests, package dry run, installed
   version check, and existing-runtime restart.

These gates keep the architecture fast for ordinary chat, capable for long
tasks, and honest when a provider or external service is unavailable.
