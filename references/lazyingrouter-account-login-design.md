# LazyingRouter Account Login Design For AgInTiFlow

Date: 2026-05-31

Purpose: define the later-stage integration where a user logs into LazyingRouter once, authorizes AgInTiFlow, and then uses AgInTiFlow without pasting OpenAI, DeepSeek, OpenRouter, Venice, GRS AI, or other upstream provider keys.

Runtime freshness note: this document describes an optional future hosted account flow. The current default is the loopback LocalLLM Fast/Deep runtime documented in [Local-First Agent Runtime](../docs/local-first-agent-runtime.md). LazyingRouter must be selected and authorized explicitly; saved or ambient hosted credentials must never activate it, enable auxiliary image generation, or create a cloud fallback.

## Product Goal

AgInTiFlow should support two credential modes:

1. Direct provider keys for local power users and development.
2. LazyingRouter account login for normal users.

In LazyingRouter mode, the user pays LazyingRouter, LazyingRouter owns upstream provider keys, LazyingRouter checks balance and quota, and AgInTiFlow only stores one LazyingRouter-issued user token.

The user-facing experience should be:

```text
aginti login lazyingrouter
-> browser opens router.lazying.art
-> user signs in or registers
-> user authorizes "AgInTiFlow on this computer"
-> AgInTiFlow stores an implicit LazyingRouter token
-> AgInTiFlow runs with provider=lazyingrouter and model=lazying/auto
```

No user should need to understand upstream provider keys for the normal paid product path.

## Current AgInTiFlow State

AgInTiFlow is currently provider-key oriented.

Relevant files:

- `src/auth-onboarding.js`: defines `MAIN_AUTH_PROVIDERS`, normalizes auth provider names, and prompts for pasted provider keys.
- `src/project.js`: stores direct provider keys in ignored `.aginti/.env` with local permission control.
- `src/config.js`: resolves the explicitly selected provider. The default is `AGENT_PROVIDER=localllm`; hosted environment variables supply credentials only and do not select a provider or create fallback order.
- `src/model-routing.js`: returns provider defaults for `deepseek`, `openai`, `openrouter`, `qwen`, `venice`, and `mock`.
- `src/model-client.js`: creates an OpenAI SDK client from `apiKey` and `baseURL`.
- `web.js`: exposes key status and provider-key save APIs, and has a provider allow-list in preference normalization.
- `src/auxiliary-tools.js`: calls image providers directly through GRS AI and Venice keys.

This is a good base because LazyingRouter can be added as another OpenAI-compatible provider. The missing part is account login and a LazyingRouter-issued token.

## Current Key Flow

The current direct-key flow is:

1. User runs `aginti auth`, `aginti login <provider>`, or `aginti keys set <provider> --stdin`.
2. AgInTiFlow asks the user to paste a provider API key.
3. `setProviderKey()` writes that secret into project-local `.aginti/.env`.
4. `resolveRuntimeConfig()` keeps the LocalLLM default or resolves the provider selected explicitly, then builds `{provider, apiKey, baseURL, model}`. Discovering a hosted key does not change that choice.
5. `createClient()` sends requests through the OpenAI SDK.

This flow should stay available. It is useful for development, private labs, and users who intentionally bring their own keys.

## Proposed Minimal Design

Add `lazyingrouter` as a first-class provider, but do not ask the user to paste any upstream key.

Recommended environment shape:

```env
LAZYINGROUTER_API_KEY=
LAZYINGROUTER_BASE_URL=https://router.lazying.art/v1
LAZYINGROUTER_MODEL=lazying/auto
LAZYINGROUTER_ACCOUNT_URL=https://router.lazying.art
LAZYINGROUTER_TOKEN_ID=
LAZYINGROUTER_USER_ID=
```

Only `LAZYINGROUTER_API_KEY` is secret. `TOKEN_ID` and `USER_ID` are useful for status, logout, and support but should not be treated as credentials.

Provider defaults:

```js
{
  provider: "lazyingrouter",
  apiKey: process.env.LAZYINGROUTER_API_KEY || "",
  baseURL: process.env.LAZYINGROUTER_BASE_URL || "https://router.lazying.art/v1",
  model: process.env.LAZYINGROUTER_MODEL || process.env.LLM_MODEL || "lazying/auto"
}
```

AgInTiFlow model routing should remain role-based. LazyingRouter is supply and billing. It should not redefine AgInTiFlow's route/main/spare/SCS semantics.

## Account Authorization Flow

Use a simple device authorization flow instead of asking the user to copy keys.

1. User explicitly runs `aginti login lazyingrouter` or clicks "Login with LazyingRouter" in web settings.
2. AgInTiFlow generates or reuses a local install id and calls:

```http
POST https://router.lazying.art/api/app-auth/device/start
Content-Type: application/json

{
  "app": "agintiflow",
  "device_name": "hostname/project",
  "scopes": ["chat", "models", "usage", "artifacts"],
  "client_nonce": "random"
}
```

3. LazyingRouter returns:

```json
{
  "login_url": "https://router.lazying.art/app-auth/authorize?device_code=...",
  "device_code": "opaque",
  "user_code": "ABCD-EFGH",
  "expires_at": 1790000000,
  "poll_interval_seconds": 3
}
```

4. AgInTiFlow opens or prints `login_url`.
5. User signs into LazyingRouter, tops up if needed, and approves "AgInTiFlow on this computer".
6. AgInTiFlow polls:

```http
POST https://router.lazying.art/api/app-auth/device/poll
Content-Type: application/json

{
  "device_code": "opaque",
  "client_nonce": "same-random"
}
```

7. On approval, LazyingRouter returns the token once:

```json
{
  "ok": true,
  "api_base": "https://router.lazying.art/v1",
  "api_key": "sk-...",
  "model": "lazying/auto",
  "token_id": 123,
  "user_id": 456,
  "display_name": "Lachlan",
  "quota": {
    "available": 123456,
    "display": "$12.34",
    "topup_url": "https://router.lazying.art/topup"
  }
}
```

8. AgInTiFlow stores the token locally with `0600` permissions and sets provider `lazyingrouter`.

The token should be a normal LazyingRouter user token, visible and revocable in LazyingRouter. It should be named like `AgInTiFlow - <hostname>`.

## Runtime And Quota Behavior

AgInTiFlow should use LazyingRouter as the authority for billing and quota.

Before a run:

- If provider is `lazyingrouter`, call a lightweight status endpoint such as `/api/app-auth/status` or existing `/api/usage/token/`.
- If no usable balance exists, stop before starting the model loop and print a top-up URL.
- If the status endpoint is unreachable but the token exists, allow one normal model request unless the user has configured strict preflight.

During a run:

- LazyingRouter remains the hard enforcement layer.
- If LazyingRouter returns `401`, mark the local token invalid and suggest `aginti login lazyingrouter`.
- If it returns quota/balance errors, stop gracefully and show the LazyingRouter top-up URL.
- Do not fall back to direct upstream keys unless the user explicitly configured fallback.

After a run:

- Show spent quota if LazyingRouter returned usage metadata.
- Store token status evidence in the session log without storing the raw token.

## Commands And UI

CLI additions:

```text
aginti login lazyingrouter
aginti logout lazyingrouter
aginti keys status
aginti provider lazyingrouter
/login lazyingrouter
/logout lazyingrouter
/provider lazyingrouter
/balance
```

Web additions:

- Provider dropdown includes `LazyingRouter`.
- Settings has "Login with LazyingRouter", "Balance", "Top up", "Revoke this device", and "Use direct provider keys instead".
- Header status can show `provider=lazyingrouter`, `model=lazying/auto`, and a compact balance label.

## Implementation Points In AgInTiFlow

Add provider identity:

- Add `lazyingrouter` to `MAIN_AUTH_PROVIDERS` in `src/auth-onboarding.js`.
- Add aliases: `lazying`, `lzy`, `lazying-router`, `lazyingrouter`.
- Add `LAZYINGROUTER_*` keys to `LOCAL_ENV_KEYS` and provider key candidates in `src/project.js`.
- Add key status fields and preview masking in `providerKeyStatus()` and `providerKeyPreview()`.
- Add a `getProviderDefaults("lazyingrouter")` branch in `src/model-routing.js`.
- Update `resolveRuntimeConfig()` in `src/config.js` to support LazyingRouter only when it is selected explicitly; `LAZYINGROUTER_API_KEY` alone must never choose it.
- Update web preference allow-lists in `web.js`.
- Add command and interactive handlers for login/logout/status.

Do not overload `setProviderKey()` as the primary account-login path. It can save a LazyingRouter token for scripting, but the normal path should use device authorization.

Suggested storage:

```text
.aginti/.env
.aginti/auth/lazyingrouter.json
```

`.aginti/.env` keeps compatibility with current config loading. The JSON file can keep non-secret account metadata, token id, account url, device name, and last status check.

## Auxiliary Tools

Text/chat integration can be v1 because LazyingRouter already exposes OpenAI-compatible model routes.

Image generation should be a separate v1.1 or v2 item unless LazyingRouter exposes an image endpoint with stable semantics. Current AgInTiFlow image generation depends on direct GRS AI and Venice keys in `src/auxiliary-tools.js`. Later options:

- LazyingRouter exposes `/v1/images/generations`, then AgInTiFlow routes image generation through LazyingRouter when provider is `lazyingrouter`.
- AgInTiFlow keeps direct image provider keys as optional advanced configuration; image tools remain off until the user explicitly enables them.
- LazyingRouter returns a clear unsupported error for SVG/vector and can offer PNG generation when available.

## Security Rules

- Never store or display upstream provider keys in AgInTiFlow.
- Store the LazyingRouter user token with `0600` permissions.
- Redact `LAZYINGROUTER_API_KEY` in logs, command output, event JSON, and web state.
- Use a one-time token delivery response for device authorization.
- Support `logout lazyingrouter` by revoking the token server-side and deleting local secrets.
- Do not silently switch from LazyingRouter to direct provider keys on quota failure.
- Treat LazyingRouter resources and returned prompts as untrusted content, not system instructions.

## Acceptance Tests

Minimum TDV cases:

1. Fresh machine, no provider keys: `aginti login lazyingrouter` opens an authorization URL and stores a masked token after approval.
2. `aginti "hello"` uses `provider=lazyingrouter` and model `lazying/auto`.
3. `/balance` shows the same available balance as LazyingRouter token usage API.
4. Exhausted user/token balance stops before or during the run with a top-up URL and no fallback to upstream keys.
5. `aginti logout lazyingrouter` revokes the token and removes local secret material.
6. Web UI can login, show status, run, and logout with the same project state as CLI.
7. Session logs contain provider, model, token id, and quota status, but never the raw token.

## Open Design Decisions

1. Provider selection: LocalLLM remains the default regardless of which hosted keys exist. A user must explicitly select LazyingRouter or a direct hosted provider; credentials never establish precedence or fallback order.
2. Token funding: LazyingRouter must decide whether app tokens draw directly from user wallet/subscription or use allocated token quota. AgInTiFlow should not care as long as status and error semantics are stable.
3. Image generation: decide whether LazyingRouter will proxy image providers or leave direct auxiliary keys as an optional advanced path. Either way, auxiliary image generation remains disabled until explicitly enabled.
