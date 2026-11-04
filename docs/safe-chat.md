# Safe Chat

AgInTiFlow provides an optional narrow text fallback for server applications. It calls an explicitly server-selected provider directly and has no agent loop, tools, filesystem, shell, browser, sessions, artifacts, or persistence.

This service is suitable for a bounded fallback response after an application has already classified a primary provider quota or capacity error. It must not be exposed directly to an end-user client.

## Install and Start

After a release containing this capability is published, install the package locally and start only the narrow service:

```bash
npm install --save-exact @lazyingart/agintiflow
./node_modules/.bin/aginti-safe-chat --host 127.0.0.1 --port 3212
```

Required server environment:

```bash
export AGINTI_SAFE_CHAT_ENABLED=1
export AGINTI_SAFE_CHAT_PROVIDER=deepseek
export AGINTI_SAFE_CHAT_BEARER_TOKEN=server-owned-random-value
export DEEPSEEK_API_KEY=server-owned-deepseek-key
```

Optional server-owned configuration:

```bash
export AGINTI_SAFE_CHAT_DEEPSEEK_MODEL=deepseek-v4-flash
export AGINTI_SAFE_CHAT_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
export AGINTI_SAFE_CHAT_TIMEOUT_MS=60000
export AGINTI_SAFE_CHAT_MAX_CONCURRENCY=1
export AGINTI_SAFE_CHAT_MAX_TOKENS=2048
export AGINTI_SAFE_CHAT_OUTPUT_CHARS=12000
```

Do not put the bearer token or DeepSeek key in client code, request bodies, command-line arguments, logs, or source control. Use a protected service environment file or secret store.
The bearer token must contain at least 24 characters.
The example explicitly selects DeepSeek. Without an explicit safe-chat provider,
selection follows the server's `AGENT_PROVIDER` or the LocalLLM baseline; a
hosted key alone does not select a hosted provider. Hosted endpoints must be
HTTPS and non-loopback. LocalLLM must be loopback-only. URL credentials, query
strings and fragments are rejected. Endpoint/model configuration belongs to the
host, not the request; operators must restrict egress to their approved origin.

## API

Every endpoint, including health and readiness, requires:

```text
Authorization: Bearer <server-owned-token>
```

`GET /health`

`GET /ready`

`GET /v1/chat/status`

`POST /v1/chat`

Request:

```json
{
  "prompt": "Explain this idea briefly.",
  "history": [
    { "role": "user", "content": "Earlier question" },
    { "role": "assistant", "content": "Earlier answer" }
  ],
  "locale": "en"
}
```

Response:

```json
{
  "ok": true,
  "feature": "safe-chat",
  "answer": "...",
  "code": "ok",
  "retryable": false,
  "modelExposed": false,
  "providerExposed": false
}
```

Compatibility aliases are available at `/api/safe-chat/status` and `/api/safe-chat`.

The request schema accepts only `prompt`, bounded `history`, and an optional short locale. Client-controlled provider, model, key, base URL, system prompt, tool, filesystem, command, environment, and sandbox fields are rejected. Responses never expose provider/model names or upstream diagnostics.

Success requires one assistant text choice with no refusal or tool/function
call. If finish metadata is present, it must be `stop`; legacy responses that
omit it remain compatible. Truncated, filtered, ambiguous or tool-shaped turns
return `invalid_response` with HTTP502 and no answer. The helper does not retry,
repair, execute tools or switch providers after such a failure. Callers must not
commit an `ok:false` response as a completed conversation answer.

If the calling server cancels a programmatic request or its HTTP connection closes before the response, the upstream request is aborted. Programmatic callers receive a frozen, non-retryable `cancelled` result; a disconnected HTTP caller receives no late response.

Programmatic imports:

```js
import { getSafeChatStatus, runSafeChat } from "@lazyingart/agintiflow/safe-chat";
import { listenSafeChatServer } from "@lazyingart/agintiflow/safe-chat/server";
```

## Deployment Boundary

- Bind only to loopback. The server rejects remote bind addresses.
- Require a separate bearer token even on loopback.
- Run under a dedicated non-root service account with a minimal environment.
- Give the process only the DeepSeek credential and service configuration it needs.
- Do not source an interactive shell profile from the service.
- Do not mount application repositories, user homes, Docker sockets, SSH agents, or cloud metadata credentials.
- Do not log authorization headers, request bodies, prompts, responses, or provider diagnostics.
- Keep concurrency and output limits low, and let the calling application own account quotas, idempotency, cancellation, and fallback eligibility.

The caller should invoke this service at most once for a classified primary-provider quota or capacity failure. Authentication, policy, invalid-input, and unsafe-output errors must remain fail-closed.
