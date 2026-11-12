# Internal restricted Responses transport candidate

This candidate is unexported and unwired. It adds no default provider, fallback,
sign-in, token loader, route, listener or capability admission. It is a
Responses API transport for the AgInTi restricted loop; it is not the Codex CLI
harness or permission to reuse a CLI login.

`createRestrictedResponsesClient(options)` in
`src/restricted-responses-client.js` returns frozen `{provider, close}`.
`provider` has only `supportsImages: false` and `complete(request, {signal})`.
Only the restricted SDK request shape is accepted; images and tools are
refused. The explicit host options are:

| Field | Local bound |
| --- | --- |
| `accessToken` | 16–8,192 visible ASCII characters; no ambient credential lookup |
| `principalId` | 16–128 characters from `A-Za-z0-9._~-` |
| `expiresAt` | Canonical future ISO UTC timestamp, at most 24 hours ahead |
| `model`, `reasoningEffort` | Exact host choices validated by the protocol profile |
| `timeoutMs` | 100–120,000 ms; default 30,000 |
| `maxConcurrency` | 1–16; default 1 |

Those declarations are not proof of token ownership, principal authorization,
scope, model access or account consent. Each client owns one fixed identity,
token, agent and physical request set. Apps must construct and isolate clients
only after their own authenticated admission. No per-turn identity override or
automatic auth refresh is supported.

Requests use native HTTPS to `api.openai.com:443/v1/responses`, public bundled
CA roots, native hostname verification, TLS 1.2 or newer and disabled socket/TLS
session reuse. Endpoint, agent, fetch, proxy, CA and environment overrides are
not accepted. There is no redirect, reconnect, retry or fallback. Requests use
`tools: []`, `tool_choice: "none"`, `store: false` and streaming. The original
deadline includes request preparation, body receipt and physical retirement.
Earlier authorization expiry is an authentication failure even after valid EOF.

The local bounds are 1 MiB request/wire body, 16 KiB headers/error body, and the
protocol decoder's event/text/count limits. Invalid UTF-8, duplicate critical
headers, compression, ambiguous framing and partial events fail closed.
Literal known-token reflection is refused in strings, keys and JSON numeric
serialization, including request schema values. This filter does not claim to
detect arbitrary encodings or infer unknown secrets.

Node's disposable native abort subscription resists another listener stopping
propagation. A final proposal is released only after valid EOF and observed
request, response and owned-socket closure. An unconfirmed close after three
seconds poisons the client and returns a safe failure while retaining the live
physical record. `close()` is cached, bounds its own wait and reports failure
instead of inventing successful retirement. Cancellation is not proof of
upstream model termination, deletion, a cost ceiling or a refund.

Safe failure metadata distinguishes authentication, permission, quota, rate
limit, timeout, protocol and unavailable. Only exact quota codes are used;
prose never establishes a billing reset or permission to retry. Numeric
`Retry-After` is bounded to 0–86,400 seconds for rate-limit/unavailable errors.
HTTP 500–503 are unavailable, 504 timeout and 505+ protocol-invalid. Validated
late stream failures discard every preceding delta.

## Offline checks and remaining gates

Run:

```sh
node --experimental-test-module-mocks --test test/restricted-responses-protocol.test.js test/restricted-responses-http.test.js test/restricted-responses-retirement-clock.test.js
```

HTTP tests adapt the native import to owned loopback peers. The retirement
probe controls clock and close ordering without a network connection. Neither
uses real credentials or model calls. They verify implementation behavior,
not public TLS, app registration, token lifecycle, live model/schema support,
upstream cancellation or an enabled Codex application backend. Those remain
separate acceptance gates before any public export or app activation.
