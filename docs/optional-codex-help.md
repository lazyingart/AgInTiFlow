# Optional Codex advice

AgInTi can ask Codex for a bounded second opinion while retaining its own task,
session, tool loop and completion checks. Enable the selected wrapper explicitly:

```bash
aginti --provider deepseek --allow-wrappers --wrapper codex \
  "Inspect this module. Ask Codex for a second opinion if useful, verify its advice, and explain the result."
```

The `delegate_agent` tool is available only when wrappers are enabled. Only the
selected wrapper is admitted. Its request should describe a small question and
the relevant evidence; the answer is advisory and must be verified by AgInTi.
Codex must already be installed and authenticated by the trusted CLI user.
The primary provider stays selected; delegation does not switch the session's
provider or transfer ownership of the task. Ordinary runs keep wrappers off.

New runs use `--wrapper-model cli-default`: AgInTi omits Codex's model override
and uses the model already selected by the user's Codex configuration. This is
a selection policy, not an API model ID or evidence of the served model. Wrapper
reasoning remains independently configured (medium by default). Explicit
`--wrapper-model MODEL`, environment pins and saved session models remain
authoritative; an older saved model is not silently migrated. Use the explicit
`cli-default` override to change that saved choice when desired. Codex documents
its model/configuration overrides in the [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

CLI-default makes one local wrapper invocation and does not invent a spare
model after failure. Explicitly pinned wrappers retain the existing eligible
ordinary-exit spare policy. This does not disable Codex's internal transport
behavior or prove a single upstream inference attempt. Failed advice returns
bounded, redacted diagnostics; it is never converted to a successful answer.

An explicit instruction such as “Ask Codex only once” or “Ask Codex for one
read-only second opinion before editing” creates a native session-owned attempt
receipt. The runtime fsyncs that reservation before launching the CLI. A failed
mandatory review stops with `advisory_unavailable`; optional advice may remain
unavailable while the primary continues. Neither response loss, a generic
continuation nor a primary-provider handoff grants another external call. A
successful exact request can replay its recorded result. A different question,
workspace or wrapper selection cannot reuse that result as a fresh review.
Pinned-wrapper spare calls are disabled under this explicit one-attempt limit.

When review is explicitly required before edits, the runtime initially offers
only read-only context tools, the selected adviser and finish. Existing repair,
source-grounding and verification phases resume after successful advice. A
missing reply, disabled wrapper or ambiguous prior reservation does not count
as completed advice. A new explicit owner request such as “Ask Codex once
again” can grant another attempt; a generic “continue” cannot.

This bounded grammar recognizes direct English and Chinese requests. Quoted
examples, code, descriptions and unrelated action counts supply no authority.
The receipt is private native CLI state with integrity digests, not a keyed MAC
or proof against same-user storage forgery. It relies on the existing native
session lock and fsynced SessionStore. A reservation can remain uncertain after
interruption; it never blindly redispatches. These controls neither attest a
single upstream inference nor qualify a multi-user application transport.

For an explicitly read-only review, explaining a proposed fix does not create
a source-edit obligation. A failed diagnostic test remains recorded as failed
and may be reported as a finding while the current goal's mutation boundary is
unchanged. It cannot satisfy a repair or mandatory-green contract. An extra
general-shell command stays denied; one bounded recovery can report retained
evidence or the remaining limitation without granting broader host permission.

The default wrapper deadline is 120 seconds, configurable by
`WRAPPER_TIMEOUT_MS`. Cancellation is checked before spawning. During timeout
or cancellation the launcher sends SIGTERM, escalates after 1.2 seconds, and
waits up to a further 3 seconds for close. Unconfirmed termination is an explicit
failure, not a successful answer. All cleanup timers and abort listeners are
cleared at settlement. A timeout, signal, cancellation or unconfirmed process
failure cannot start a spare-model call. Ordinary nonzero exits of an explicitly
pinned Codex wrapper retain the existing one-spare-attempt behavior. Each allowed attempt has its own
deadline; this is not a shared two-attempt task deadline.

This wrapper is for trusted standalone CLI use. Its read-only sandbox and
advisory prompt do not constitute a no-tools application boundary. It uses the
CLI user's environment/configuration and puts the request in process arguments.
Applications must not pass untrusted chat directly into it. The restricted
application SDK neither imports this wrapper nor automatically falls back to
Codex. An app-safe structured Codex transport requires separate qualification.

`npm run test:tool-wrappers` tests cancellation, close confirmation, signal and
timeout failures, spare-attempt policy and cleanup without invoking an agent
CLI. One local test-owned Node child ignores SIGTERM to verify real process-group
cleanup on supported POSIX hosts; it reads no credentials and performs no model
request. These tests do not establish live Codex answer quality or app isolation.
