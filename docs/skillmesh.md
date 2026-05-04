# Skill Mesh

Skill Mesh lets AgInTiFlow exchange reusable skills without sharing raw sessions, project code, `.env` files, browser state, artifacts, or provider keys.

The first implementation is intentionally conservative:

- Skills are shared as signed JSON skill packs.
- Each pack is validated for required `SKILL.md` frontmatter, safe paths, size limits, secret-like text, and privacy metadata.
- Shared packs cannot override built-in skills.
- Community skills are installed disabled by default.
- Sync is explicit and metadata-first; there is no realtime polling loop.
- Relay nodes run without model/API keys.

## Modes

```bash
aginti skillmesh status
aginti skillmesh share
aginti skillmesh record
aginti skillmesh off
```

Interactive CLI:

```text
/skillmesh
```

The selector has three modes:

- `share`: record locally and allow reviewed skill-pack sharing.
- `record`: record local sanitized learning metadata only.
- `off`: disable Skill Mesh loading and sync.

## Pack Commands

Export a reviewed local skill:

```bash
aginti skillmesh export <skill-id>
```

Import a reviewed pack:

```bash
aginti skillmesh import ./example.skillpack.json
aginti skillmesh enable <skill-id>
```

Submit a reviewed pack to a relay:

```bash
aginti skillmesh submit ./example.skillpack.json --node https://skills.flow.lazying.art
```

Sync metadata and optionally download packs:

```bash
aginti skillmesh sync
aginti skillmesh sync --node http://127.0.0.1:7377 --install
```

Downloaded community packs are still disabled until explicitly enabled.

## Relay Node

Run a Skill Mesh relay:

```bash
aginti skillmesh serve \
  --role major \
  --host 127.0.0.1 \
  --port 7377 \
  --data ~/.aginti-skill-relay \
  --public-url https://skills.flow.lazying.art
```

Endpoints:

- `GET /health`
- `GET /feed.json`
- `POST /sync/metadata`
- `POST /submit`
- `GET /packs/<hash>.json`
- `GET /packs/<hash>/metadata.json`

The relay stores only validated skill packs and metadata in its data directory. It rejects raw sessions, unsafe paths, secret-like text, unsupported schemas, overlarge packs, unsigned packs, and packs that do not declare the strict privacy contract.

## Storage

Local client storage:

```text
~/.agintiflow/skillmesh/
  config.json
  identity.json
  index.sqlite
  skills/
  packs/
  inbox/
  outbox/
  reviewed/
  feeds/
```

Relay storage:

```text
~/.aginti-skill-relay/
  index.sqlite
  packs/
  logs/
```

`identity.json` contains the local Ed25519 signing key and should remain private.
