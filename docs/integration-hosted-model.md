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

The initial v3 profile rejects `vision.enabled=true`: the existing vision path
uses a separate LocalLLM image model and needs its own explicit binding before
hosted-planner image activation. Text, structured research and document tools
retain their own independent capability checks. Report partial availability
accurately instead of silently ignoring attachments.

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
