# Native completion and observer delivery

The native `runAgent` task outcome and application delivery are separate. After
the completed state and `session.finished` event have both been saved, a failing
`onEvent` or final `onConsole` callback cannot change the task to failed, trigger
provider handoff, or ask the model to repeat finished work.

Final delivery attempts all relevant event callbacks and the final console
callback. Returned promises are observed, with one shared one-second wait for
the asynchronous batch. A throw, rejection or timeout returns the original
completed result plus a bounded receipt:

```json
{
  "sessionId": "example-session",
  "result": "The requested summary was saved.",
  "goalStatus": "completed",
  "observerDelivery": {
    "status": "incomplete",
    "failed": ["session.finished"],
    "timedOut": [],
    "diagnosticPersisted": true
  }
}
```

The receipt is absent when delivery succeeds. `failed` and `timedOut` contain
only fixed notification labels, never the callback's exception, message, stack
or cause. A native `session.observer_delivery_failed` diagnostic records the
warning independently. If that diagnostic cannot be written, the completed
result is preserved and `diagnosticPersisted` is false. Later promise rejections
remain observed after a delivery timeout.

These rules apply to finish-tool, assistant-content, direct-answer,
response-only and already-completed continuation paths. State is saved before
completion notifications in every path. A fresh-process generic continuation
of an already-completed task preserves the result without repeating model or
tool work. A new concrete request still follows normal continuation rules.

Consumers should use the returned outcome or persisted native state to decide
whether work completed. Retry presentation independently after restoring the
observer; do not replay a task merely because its final delivery failed. These
native records are not an authenticated public integration API.

Failure to save the actual completion state or event is still a runtime
failure. This boundary does not provide atomic state/event commits, arbitrary
exactly-once tool execution, or delivery of every nonterminal callback. It does
not cover cleanup I/O failures. Callbacks remain trusted host JavaScript: a
timeout bounds the wait, not synchronous execution or callback-owned work.

## Named-file creation language

For ordinary named-file requests, “make a brief report.md” means file creation,
not invocation of the `make` program. A bounded creation grammar normalizes
named files and explicit file/artifact nouns for evidence classification.
Filename stems such as `summary.md` or `answer.md` are not stripped as chat
response narration. Explicit commands such as `Run make report.md` and
`Run \`make test\`` retain their command evidence requirement. Prohibited file
creation and response-only summaries do not gain file mutation authority.

This classifier changes neither workspace permissions nor shell, package,
publication, provider or sandbox policy. Existing source and artifact validation
remain required.

Input and output roles follow clauses rather than filename order. For example,
`Create summary.md from note.txt. Leave note.txt unchanged.` declares one output
and one protected input. `using` and `based on`, coordinated reads and common
Chinese source clauses follow the same bounded rule. A later explicit output
action starts a new deliverable clause, so multiple outputs remain possible.
Source paths cannot accidentally supply an output-directory prefix.

Only explicit preservation establishes the narrower mutation prohibition. A
provider proposal to patch that input is rejected before the tool executes;
the model can still create and inspect the permitted output. Genuine requests
to edit a source or create a file and then keep it unchanged remain supported.
The same contract is derived again for a concrete follow-up; a generic
continuation of completed work does not repeat its write. This is bounded
instruction inference, not an arbitrary natural-language or shell sandbox.

Direct named-file prohibitions use that same guard: for example,
"Do not modify note.txt", "不要修改 note.txt" and "别改 note.txt".
Bounded file lists are supported; the next positive clause remains actionable.
A restriction on only a field, section or file permission is not treated as a
whole-file prohibition. This does not infer unnamed files or every paraphrase.

Preservation uses bounded literal filenames rather than the output artifact
format catalog. Source files such as `src/amount.cpp`, `src/amount.rs` and
extensionless names such as `README` keep the same protection as `note.txt`.
Quoted filenames may contain spaces. Explicit source clauses remain read
targets during a concrete follow-up; a protection-only clause does not require
reading a dotfile or change the secret-file guard. Only an explicit new-file
declaration can exempt the created output from this preservation rule; an
incidental mention or verification command cannot authorize a source overwrite.

## Piped interactive input during resume

Non-TTY interactive input begins iteration before asynchronous startup and saved
history rendering. Lines received during that work, between questions or while
the previous task is running remain queued, including lines followed by EOF.
They are processed in order through the same native prompt and runtime-revision
checks. A stale prompt cannot bypass CAS or become a silent successful exit.

Interactive pipes are line-oriented. Use the one-shot `run --stdin` interface
when one request contains multiple lines. The TTY composer and live input path
retain their existing behavior; this change adds no application authorization
or inference fallback. Application integrations should use the restricted SDK
or their qualified native contract rather than expose a broad interactive CLI.
