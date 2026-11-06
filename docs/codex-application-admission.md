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

## Separate future route: Sign in with ChatGPT

The [official overview](https://developers.openai.com/siwc/token-sharing-open-source)
describes app registration, user consent and an account/workspace-bound client
for open-source and locally hosted applications. Paid or remotely hosted use
has a separate interest path. An existing CLI login is not evidence that an
application has completed that flow. No credentials are migrated by AgInTi.

The [inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
uses the public Responses endpoint with the selected account's authorized token.
It explicitly excludes ChatGPT backend-api endpoints and requires a completed
terminal event before success. A catalog alone does not establish model access.

The [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
require streaming and disabled server storage, caller-supplied HTTP history,
and do not support `max_output_tokens`. This needs a bounded stream decoder, deadline,
schema and failure handling; the existing non-streaming Chat Completions adapter
is not a substitute. App-server still owns local tools and exposes RPC inputs
rather than arbitrary Responses parameters.

The [app-server guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
describes explicit app-owned token delivery and renewal, with success determined
from the completed turn status. It supplies no no-tools attestation for AgInTi's
installed CLI. Direct Responses tool selection and the CLI's generated catalog
are distinct boundaries; setting a no-tools instruction is insufficient.

This is a qualification target, not an implemented adapter or admission grant.
It requires separately authorized credentials, exact tool denial and stream/
lifecycle/isolation tests before any app fallback can be enabled. Do not extract
the CLI user's auth file, redirect its bearer token, downgrade the contract or
share its session across accounts. Current app routing and the trusted opt-in
CLI adviser remain unchanged. AgInTi performs no sign-in, registration, token
refresh, request, model selection or provider activation for this route.
