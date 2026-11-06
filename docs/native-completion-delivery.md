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
