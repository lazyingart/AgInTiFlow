# Public Research Wrapper

AgInTiFlow exposes an optional fail-closed backend route for apps that need a narrow server-owned research helper without exposing model or provider controls to clients.

This route is intended for product backends such as EchoMind AI Agent. It is not a replacement for normal AgInTiFlow chat.

## Capability Classification

- **Existing capability:** AgInTiFlow already has a server-owned Codex exec adapter, input/output redaction, bounded subprocess handling, and a disposable per-request workspace.
- **System-level gap addressed here:** normal AgInTiFlow chat and Studio expose too much tool and API surface for a narrow application backend. The standalone server exposes only health, readiness, status, and research routes. Prompts travel over stdin rather than process arguments.
- **Deployment/setup gap:** hard host-filesystem and domain-level network isolation cannot be created honestly by an npm process alone. Production must provide the external container/VM and egress firewall described below. The route remains unavailable until that boundary is explicitly attested.

The EchoMind server should call this narrow service only for explicit public-research work. Normal EchoMind chat does not need to invoke AgInTiFlow.

## Project-Local Installation

Install without a global package:

```bash
npm install --save-exact @lazyingart/agintiflow
```

Project dependency installation does not auto-start AgInTiFlow Studio. The package postinstall hook reserves that behavior for global CLI installs or explicit `AGINTIFLOW_POSTINSTALL_WEBAPP=1` opt-in.

Start only the narrow service:

```bash
./node_modules/.bin/aginti-public-research --host 127.0.0.1 --port 3211
```

Programmatic imports are also available:

```js
import { runPublicResearchWrapper } from "@lazyingart/agintiflow/public-research";
import { listenPublicResearchServer } from "@lazyingart/agintiflow/public-research/server";
```

Importing these modules does not start AgInTiFlow chat, Studio, sessions, model routing, or project tools.

## API

`GET /ready`

Returns `200` only when the route is available, otherwise `503`.

`GET /v1/research/status`

Returns availability, policy, and limits. It intentionally does not return model names.

`POST /v1/research`

Request:

```json
{
  "query": "Summarize public NIH guidance about reproducible literature searches.",
  "context": "Optional non-secret app context.",
  "allowedDomains": ["nih.gov"]
}
```

Response:

```json
{
  "ok": true,
  "feature": "public-research-wrapper",
  "route": "server-owned-codex",
  "modelExposed": false,
  "answer": "..."
}
```

Compatibility aliases remain available at `/api/public-research/status` and `/api/public-research`.

The endpoint rejects client-controlled provider, model, cwd, env, token, sandbox, and wrapper fields. Successful answers must include citations whose domains are within the server allowlist. Process stderr/stdout diagnostics are never returned to clients.

## Enablement

The route is disabled by default and fails closed until all required server-side conditions are true:

```bash
export AGINTI_PUBLIC_RESEARCH_ENABLED=1
export AGINTI_PUBLIC_RESEARCH_BOUNDARY=external-strict
export AGINTI_PUBLIC_RESEARCH_CODEX_HOME=/srv/aginti-public-codex
export AGINTI_PUBLIC_RESEARCH_ALLOWED_DOMAINS="nih.gov pubmed.ncbi.nlm.nih.gov arxiv.org"
```

Optional bounds:

```bash
export AGINTI_PUBLIC_RESEARCH_TIMEOUT_MS=90000
export AGINTI_PUBLIC_RESEARCH_MAX_CONCURRENCY=1
export AGINTI_PUBLIC_RESEARCH_CODEX_MODEL=server-owned-model
export AGINTI_PUBLIC_RESEARCH_CODEX_REASONING=medium
```

Do not set `AGINTI_PUBLIC_RESEARCH_CODEX_HOME` to the user's normal home directory or normal `~/.codex`. Use a dedicated service-owned Codex profile.

`AGINTI_PUBLIC_RESEARCH_BOUNDARY=external-strict` is an operator attestation, not a substitute for isolation. Set it only after the deployment requirements below are enforced. Without it, readiness fails closed.

The standalone server binds to loopback by default. Remote binding additionally requires:

```bash
export AGINTI_PUBLIC_RESEARCH_ALLOW_REMOTE=1
export AGINTI_PUBLIC_RESEARCH_BEARER_TOKEN=server-owned-random-value
```

Do not pass this bearer token to end-user clients. EchoMind server-side code owns it.

## Security Boundary

The wrapper:

- runs `codex exec --ephemeral` from a disposable temp workspace;
- passes the research prompt through stdin, not command-line arguments;
- sets `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and temp paths to disposable directories;
- passes only a minimal environment to the Codex process;
- uses a dedicated `CODEX_HOME` supplied by the server operator;
- rejects likely secret inputs before invoking Codex;
- rejects secret-like model output and does not return process diagnostics;
- enforces timeout, output-size, and concurrency limits;
- configures the Codex web-search tool with the server-selected domain allowlist;
- requires the same public allowlist in the research prompt and returned citations;
- fails closed if disabled, unavailable, or not configured.

The npm process cannot prove that the host filesystem or arbitrary network destinations are unreachable. A production deployment must enforce all of the following before setting `AGINTI_PUBLIC_RESEARCH_BOUNDARY=external-strict`:

1. Run the standalone service as a non-root user inside a dedicated container, microVM, or equivalent sandbox.
2. Mount no host home, application repository, EchoMind data, Docker socket, SSH agent, or cloud metadata credentials.
3. Mount only the dedicated Codex service profile needed for authentication, preferably read-only.
4. Use an ephemeral writable filesystem or tmpfs with bounded size; discard it when the service restarts.
5. Drop capabilities and apply no-new-privileges, PID, memory, CPU, wall-time, and process limits.
6. Deny private, loopback, link-local, and metadata destinations at the network boundary.
7. Permit only required Codex control-plane endpoints at the local egress boundary. Codex web-search source access is separately constrained with `tools.web_search.allowed_domains`; do not enable alternate browser, MCP, or shell-network tools in this service.
8. Do not log request bodies, authorization headers, Codex prompts, subprocess arguments, or model output.

Codex `--sandbox read-only` is retained as defense in depth, but it is not the host-isolation boundary: read-only mode still permits reads. The external sandbox is what must prevent host home and repository access.

## Smallest Deployment Shape

Use one narrow sidecar/service:

```text
EchoMind client
  -> EchoMind server (decides whether public research is needed)
  -> loopback/private authenticated aginti-public-research
  -> disposable codex exec worker
  -> allowlisted egress boundary
```

Keep concurrency at `1` initially, timeout at or below `90s`, and output below `12k` characters. Scale by adding isolated service replicas rather than sharing host access or widening the route.

## EchoMind Integration Shape

EchoMind should call this route only for explicit public research tasks:

```text
EchoMind client -> EchoMind server -> narrow research service -> server-owned Codex exec
```

EchoMind clients should never send model names, provider names, keys, cwd values, user home paths, repository paths, or secrets to this route.
