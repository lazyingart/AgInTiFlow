# Explicit hosted inference for the durable integration API

The analysis integration can use DeepSeek as its planner without changing its
durable thread/run, execution-worker, search, document, or cancellation contracts.
Hosted inference is an explicit service configuration choice. Existing v2
LocalLLM services and the global CLI default remain unchanged; an ambient key
does not select a provider or enable an automatic fallback.

## Configuration

Use schema `aginti-integration-analysis-service-config-v3` and replace the v2
`localModel` field with this secret-free `model` field:

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-flash",
  "thinking": "disabled",
  "contextWindowTokens": 32768,
  "maxOutputTokens": 4096,
  "modelTimeoutMs": 60000
}
```

The surrounding fixed listen address, state roots, trusted BFF identity and
explicit RPC scope list are unchanged. All selected model fields are required
in the v3 service config. The bounded planner also accepts the verified
`deepseek-flash` and `deepseek-v4-pro` identifiers. It does not discover or switch
models from client input. Readiness and capacity still depend on the account
and selected model at runtime.

Pass the model credential through systemd `LoadCredential=deepseek-token:...`.
The CLI reads it only from its existing protected systemd credential directory;
config JSON, BFF requests, public summaries and planner attestations contain no
key. Keep the hosted credential separate from the BFF, execution, search and
document credentials. Never copy a whole shell environment into the worker.

The hosted SDK client uses the exact HTTPS provider origin, rejects redirects
and disables SDK-level retries. Existing bounded planner timeouts, cancellation
and model-step limits remain responsible for the request lifecycle. Every
planner inference path applies `thinking: {"type":"disabled"}` and removes
the unrelated `reasoning_effort` field. This keeps interactive/tool requests on
the explicitly selected non-thinking profile. A future thinking profile needs
provider reasoning retention across tool turns before it can be enabled.

## Capabilities and deployment

Public model labels remain `LocalLLM` for existing local services and use the
neutral `AI` label for an AgInTi-owned DeepSeek runner. Clients cannot select
the label, endpoint, key or model through a run request.

This changes inference, not execution authority. Python/tool jobs still need
the existing independently authenticated execution worker and its isolation.
Internet research and PDF/file delivery still need their configured worker
roles. A text or tool-call model canary does not prove those end-to-end paths.
Keep private loopback RPC behind the authenticated application/edge boundary;
do not expose the Studio management API as an application backend.

Vision is an independent optional LocalLLM role. A hosted planner may enable it
only with an explicit local binding and a separate credential:

```json
{
  "vision": {
    "enabled": true,
    "localModel": {
      "baseURL": "http://127.0.0.1:18080/v1",
      "modelTimeoutMs": 180000
    }
  }
}
```

The endpoint is the existing reviewed loopback LocalLLM route; the vision client
uses its fixed `localllm-vision` alias. The timeout is bounded to 1–600 seconds.
Provision `LoadCredential=localllm-vision-token:/private/operator/vision-token`
in the actual service, not in JSON, argv or the shell environment. The key must
be distinct from the text-provider, BFF, execution, search and document keys.
No credential is created, copied or rotated by configuration validation.

Local readiness authenticates both `GET /healthz` and `GET /v1/models` at the
same configured loopback origin. This supports a completely token-gated private
gateway; no unauthenticated health exception is needed. Both requests reject
redirects, and a health authentication failure stops before model discovery.
The gateway may expose just those two GET paths and
`POST /v1/chat/completions` for the independent vision role. Keep management,
other model APIs, search and document routes outside that credential's scope.

Missing optional vision credentials or a failed vision readiness probe leave
image capability unavailable while ordinary text remains operational. Invalid
credential files, unexpected credentials and cross-role reuse fail closed.
Images never fall back to the DeepSeek text endpoint. Public capabilities enable
attachments only after the existing local vision activation succeeds; desired
configuration alone is not proof of availability. Native-v3 persistence is
required for retained image ownership, retry and conversation isolation.

Existing v2 `vision: {"enabled":true}` services retain their previous local-model
binding and key. They may opt into the independent binding as well; no existing
service changes implicitly. Existing hosted text-only profiles remain identical,
and hosted `vision: {"enabled":true}` without a binding remains invalid. Text,
structured research and document tools retain their own checks. An app adapter
must still supply valid bounded images; this configuration does not implement
its upload transport or authorize activation on an unqualified live route.

Stage a separately pinned package/service and synthetic account before routing
live traffic. Preserve unrelated CLI installations and other integrations.
Qualify durable ownership, idempotency, cancel/retry, search sources, file
delivery and worker/tunnel outages against the actual deployed endpoints.

### Tool calls and the service runtime

Unknown or malformed DSML envelopes are protocol errors, not final answers.
When tools are available, malformed text/native calls receive at most two
formation corrections within the existing model/context budget. Each corrected
call must pass the same exact argument and tool allowlists before execution.
Disabled-tool turns and forbidden tools keep their original denial behavior.
Current-turn computation requests such as "use Python to calculate" remain
executable after prior chat; explanations, quotes and negations stay distinct.

Plain TeX/PDF creation advertises only `filename` and `source` to the model.
The evidence-backed `publicSummary` belongs to compound calculation/document
requests. If a plain-document call supplies invalid summary metadata, its
bounded correction asks the model to omit that field, rather than requiring
calculation evidence that the task never needed. Compound summary validation,
numeric grounding, compiler authority and artifact commit remain unchanged.

The execution-worker entrypoint requires Node22 or later and now fails at
startup on an older runtime instead of announcing a listener that cannot
process jobs. Do not upgrade another project's system Node to fix one service.
The deterministic unit renderer and both deployment/unit attestors accept an
optional `nodeRuntimeDigest`. It selects exactly
`/opt/aginti-node/releases/<sha256>/bin/node`; install a reviewed existing
Node22+ executable there with root-owned, non-writable parent directories and
mode0555. Deployment attestation verifies ownership and the binary SHA-256.
Pass the same digest to all three operations. Without this option, existing
`/usr/bin/node` unit bytes remain unchanged. The selected system Node still
needs to satisfy the package's Node22 requirement.

## Validation

```sh
npm run smoke:integration-model-binding
node --test test/integration-independent-vision.test.js
node --test test/integration-vision-inference.test.js
node --test test/provider-runtime-private-health.test.js
npm run smoke:integration-analysis-planner
npm run smoke:integration-analysis-session-service
npm run smoke:integration-analysis-api-server
npm run smoke:integration-api
npm run check
npm run smoke:web-api
npm run smoke:coding-tools
npm pack --dry-run
```

The binding tests cover explicit opt-in, fixed origin/model, private credentials,
payload normalization, bounded limits and v2/v3 separation. Planner fixtures
exercise both providers through direct answers, execution-tool feedback and
TeX/PDF document synthesis while retaining authority and artifact checks.
Live provider probes should use small synthetic prompts and bounded output;
never store keys or private user content in test evidence.
