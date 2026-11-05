# Codex application transport admission

AgInTi's trusted CLI wrapper remains available through explicit opt-in. It is
not the restricted SDK's application fallback. The application transport remains
disabled until its no-tools, isolation, authentication and lifecycle boundaries
are independently qualified.

The local diagnostic observes the first Responses request from an installed,
trusted Codex executable. It creates temporary HOME, CODEX_HOME and workspace
directories; provides an explicit environment without real auth; selects a
test-owned loopback provider; and returns an intentional nonretryable error
without supplying any model output. No hosted inference is configured. The
test model name `gpt-5.4` identifies this fixture only; it does not select a
production fallback model or establish model access.

This diagnostic is a source-only qualification checkpoint. It is not included
in the already-published 0.20.355-integration.0 archive and does not replace it.

```sh
npm run test:codex-no-tools-admission
npm run probe:restricted-codex -- --codex /absolute/path/to/trusted/codex
```

The first command runs offline catalog/boundary controls without launching
Codex. The second explicitly launches only the local diagnostic. It is not part
of the ordinary test suite. Never point it at an untrusted executable. The
executable runs as the current user; this harness is not an OS security sandbox.
No prompt, credential or provider selection is taken from an application user.

The tested profile uses ephemeral execution, ignores user config/rules, sets
read-only sandboxing and disables shell, web search, images, apps, multi-agent,
plugins, hooks, goals, memory and skill injection. Codex documents these
individual settings in its [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
These settings are candidate controls, not a supported promise to remove every
tool or every source of configuration.

On 2026-11-05, installed Codex 0.166.0 sent one local fixture request with
`request_user_input` still advertised. Explicitly disabling the experimental
default-mode input feature did not remove it. No shell/web/app tool was in that
observed catalog, but it was not empty. The result is
`TOOLS_STILL_ADVERTISED`, `enabled:false`, `productionQualified:false`. The
intentional provider-error exit is expected; a successful diagnostic command
does not mean a qualified Codex application provider.

Even an empty catalog produces `enabled:false`: a single request is insufficient
to prove credential isolation, later-turn behavior, absence of automatic retry,
deadline/cancellation cleanup or hard termination. There is no launchable
application profile, auth forwarding, automatic fallback or new SDK export.
The diagnostic does not change the standalone wrapper or make claims about all
Codex versions/models. Do not wrap an untrusted application chat in the trusted
CLI wrapper or infer readiness from `--output-schema`/read-only mode alone.

The next enabling gate needs an enforceable, reviewed no-tools boundary and
an isolated authenticated process/transport, followed by schema, ambiguity,
cancellation, output-cap and cross-principal acceptance. Durable app attempts,
consent and fallback policy remain host-owned. LocalLLM admission is a separate
prerequisite and is not changed by this observation.
