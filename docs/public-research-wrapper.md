# Public Research Wrapper

AgInTiFlow exposes an optional fail-closed backend route for apps that need a narrow server-owned research helper without exposing model or provider controls to clients.

This route is intended for product backends such as EchoMind AI Agent. It is not a replacement for normal AgInTiFlow chat.

## Capability Classification

- Existing capability: AgInTiFlow already has internal Codex wrapper helpers for advisory work.
- System-level gap: those wrappers are too close to the caller workspace and process environment for an app-facing backend boundary.
- Packaging/setup gap: production deployments need a dedicated Codex home prepared by the server operator.

## API

`GET /api/public-research/status`

Returns availability, policy, and limits. It intentionally does not return model names.

`POST /api/public-research`

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

The endpoint rejects client-controlled provider, model, cwd, env, token, sandbox, and wrapper fields.

## Enablement

The route is disabled by default and fails closed until all required server-side conditions are true:

```bash
export AGINTI_PUBLIC_RESEARCH_ENABLED=1
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

## Security Boundary

The wrapper:

- runs `codex exec --ephemeral` from a disposable temp workspace;
- sets `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and temp paths to disposable directories;
- passes only a minimal environment to the Codex process;
- uses a dedicated `CODEX_HOME` supplied by the server operator;
- rejects likely secret inputs before invoking Codex;
- redacts stdout/stderr before returning errors;
- enforces timeout, output-size, and concurrency limits;
- requires public allowlisted domains in the research prompt;
- fails closed if disabled, unavailable, or not configured.

The wrapper does not provide OS-level domain firewalling. Production deployments that require hard network enforcement should run AgInTiFlow behind a service/container firewall that permits only the configured public domains.

## EchoMind Integration Shape

EchoMind should call this route only for explicit public research tasks:

```text
EchoMind client -> EchoMind server -> AgInTiFlow /api/public-research -> server-owned Codex exec
```

EchoMind clients should never send model names, provider names, keys, cwd values, user home paths, repository paths, or secrets to this route.
