# LabCanvas ChatOps Fallback

AgInTiFlow is a reasoning and tool-supervision fallback for LabCanvas. LabCanvas remains the owner of chat transport, schedules, exact-source media resolution, durable task state, routine selection, artifact validation, and delivery.

## Contract

LabCanvas should pass one bounded task packet containing:

- exact current request and source-chat identity;
- latest same-chat interruptions and a small amount of attributed context;
- one selected routine and its contract paths;
- current deterministic preflight and stage state;
- exact artifact directory and irreversible-action gates.

AgInTi should read `AGENTS.md` and the selected routine contract, then call established commands. It should not invent a second scheduler, publication pipeline, media downloader, CAD generator, or delivery mechanism.

The default provider chain is `deepseek,localllm`. Switching providers is safe only when the first provider failed before inference or tool execution. Never replay an unknown task failure or timeout on another provider because the first attempt may already have caused a side effect.

## Evidence Scope

ChatOps prompts may include a trusted single-line marker:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"chat-response","request":"Produce only the requested chat response."}
```

or:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"host-managed-response","request":"Return the report body; LabCanvas compiles and delivers it."}
```

or:

```text
AGINTI_EVIDENCE_SCOPE_JSON: {"mode":"task","request":"Create the requested PDF from the supplied evidence."}
```

For `chat-response`, ordinary conversation and routing do not require file or command evidence. `host-managed-response` is for content-only subtasks such as a LaTeX body, translation, completion audit, or scheduled lesson where LabCanvas owns persistence, compilation, validation, and delivery. For `task`, evidence requirements are inferred only from the exact request, not from surrounding wrapper prose. Artifact requests still require real artifacts.

## Bounded Media Source Quality

When a response-only packet explicitly asks AgInTi to summarize actual speech,
the packet's transcript is the speech authority. A title, description, author,
or hashtag may identify the source, but it cannot substitute for speech.

AgInTi checks a structured bounded transcript before accepting the response. A
long transcript with no content, implausibly little content, or extreme
repetition is treated as unusable. The backend receives one bounded repair turn
that must:

- disclose that the actual speech cannot be summarized reliably;
- avoid inferring speech, visuals, or events from metadata;
- label any metadata-based theme explicitly as title- or description-based;
- preserve the caller's JSON schema and truthful delivery flags.

If the repair repeats the unsupported summary, the turn stops with a
schema-compatible limitation instead of recording invented content as a
successful response. Reliable transcripts and requests that only ask to
identify supplied metadata are unaffected. Exact-source download,
transcription, attachments, and chat delivery remain host-owned routines.

## Fail-Closed Envelope Integrity

A response-only safety stop must preserve an explicit caller JSON envelope.
This applies when a backend repeats an unsupported source claim and when it
fails the JSON contract itself after the single bounded repair turn. The
fallback object keeps every required top-level key, value type, and declared
string enum; it places the private diagnostic in a non-enum field such as
`message`, `summary`, or `reason`. It never replaces a route enum with prose.

The session remains stopped and does not record `session.finished`. Envelope
preservation only lets the host parse and recover the task reliably; it does
not convert the failed turn into success, select a provider, or change any
LabCanvas queue, schedule, transport, or routing policy.

## Provider Tool-Batch Recovery

AgInTi requests one effectful tool call at a time, but some OpenAI-compatible
providers may still emit a small batch. A bounded batch of otherwise valid
calls is handled sequentially: AgInTi dispatches only the first call, records
`tool.batch_deferred`, and asks the model to continue from the resulting state.
Deferred calls are never executed automatically. Per-tool schema, permission,
secret, path, and irreversible-action checks remain authoritative.

Malformed calls, duplicate IDs, unavailable tools, hidden arguments, or an
oversized batch still stop with `tool_contract_violation`. A host may resume
the same saved session with another provider after that categorized stop; it
must not replay the original request or duplicate earlier side effects.

## Secret-Bearing Derived Content

Private source packets can legitimately contain signed media URLs, cookies, or
token-shaped fields that must not be copied into a reader-facing artifact.
Workspace secret guards remain authoritative: the proposed write is blocked
before any file mutation.

That block is a content-correction event, not a request for stronger runtime
permission. AgInTi receives one bounded automatic recovery instruction to
remove the private field or replace its value with `[REDACTED]`, retain the
useful non-sensitive content, and write the originally requested derived
artifact. It must not edit the authoritative source record merely to sanitize a
summary, repeat the blocked value, or expose the value in its final response.
Other protected-path, outside-workspace, destructive, and
permission-sensitive blocks keep their existing approval behavior.

## Local Artifact Preview Recovery

`open_url` is only for remote `http` and `https` sources. A fallback model may
still copy a local artifact path into a `file://` URL when it intends to inspect
a generated PDF, HTML page, image, or text file. The remote-browser guard keeps
that URL blocked, but the mistake is a tool-selection error rather than a
request for stronger permission.

AgInTi receives one bounded automatic correction. It converts the local URL to
an authorized workspace-relative path and chooses `open_workspace_file` for a
single rendered file, `preview_workspace` for a static site or directory, or
`read_file` when textual inspection is enough. It must not retry `open_url`,
start a temporary localhost server, or ask the user to elevate the sandbox.
The replacement workspace tool still enforces its normal path and read-root
rules, so an outside-workspace or protected target remains blocked.

## Current-Turn Response Fidelity

Response-only prompts contain host control metadata and may contain prior
bot-authored messages for conversational continuity. Neither is an answer to
the current inbound message. AgInTiFlow therefore rejects two exact replay
forms before accepting completion:

- a returned JSON object that is identical to an
  `AGINTI_EVIDENCE_SCOPE_JSON` control envelope;
- a substantive primary response field that exactly repeats a prior
  `is_self: true` chat message while the current message asks something else.

The backend receives one bounded repair turn that identifies the current
message as authoritative and preserves any explicit JSON key and type
contract. A current message that explicitly requests a verbatim repetition is
accepted. Merely quoting an earlier bot message to ask about it is not a repeat
request.

The replay check runs again after transcript-quality and source-free-evidence
repairs. This prevents one validator from replacing a rejected answer with
stale context that a later stage would otherwise accept. A repeated replay
fails closed in the caller's parseable envelope, leaves the session stopped,
and never records `session.finished`. This does not alter LabCanvas routing,
provider priority, queues, schedules, transports, or chat coalescing.

## Local Context Recovery

LocalLLM planning compacts oversized goals to a bounded head-and-tail representation. Runtime compaction retains the first request and latest interruptions. A `LocalContextBudgetError` triggers one compact-and-retry cycle at the same step and records private recovery events. It does not authorize replaying task side effects.

Validate with:

```bash
npm run check
npm run smoke:context-budget-recovery
npm run smoke:truthful-completion
```
