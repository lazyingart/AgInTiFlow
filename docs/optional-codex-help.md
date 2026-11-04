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

The default wrapper deadline is 120 seconds, configurable by
`WRAPPER_TIMEOUT_MS`. Cancellation is checked before spawning. During timeout
or cancellation the launcher sends SIGTERM, escalates after 1.2 seconds, and
waits up to a further 3 seconds for close. Unconfirmed termination is an explicit
failure, not a successful answer. All cleanup timers and abort listeners are
cleared at settlement. A timeout, signal, cancellation or unconfirmed process
failure cannot start a spare-model call. Ordinary nonzero Codex exits retain
the existing one-spare-attempt behavior. Each allowed attempt has its own
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
