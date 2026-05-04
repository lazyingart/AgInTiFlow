# AgInTiFlow Skill Mesh Sharing Design

## Goal

AgInTiFlow should let different users benefit from skills, tool patterns, command policies, profiles, and troubleshooting lessons learned by other users without uploading private transcripts, source code, file paths, secrets, or artifacts.

The proposed feature name is **Skill Mesh**.

User-facing command:

```text
/skillmesh
```

CLI command:

```bash
aginti skillmesh
```

Useful aliases can be added later:

```text
/skill-sync
/skill-share
aginti skillsync
```

Product default should be **Record + Share Reviewed Skills**. This sounds active, but the implementation must still be conservative: it records locally by default, shares only reviewed/high-value skill packs, syncs slowly during idle time, and never uploads raw logs or raw sessions.

The sync philosophy should be **slow, strict, and high-signal**. Skill Mesh is not chat, telemetry streaming, or a real-time swarm bus. It should exchange only reviewed, deduplicated, high-value capability packs during idle time.

## Core Modes

The selector for `/skillmesh` should have three modes:

1. **Disabled**

   No housekeeping export, no community sync, no skill suggestions from shared feeds. Raw local session history still stays in `~/.agintiflow/sessions/` if normal sessions are enabled, but no Skill Mesh aggregation is used.

2. **Record Locally**

   AgInTiFlow records sanitized local capability metadata into `~/.agintiflow/housekeeping/`. This includes model/tool names, selected skill ids, command categories, outcome hashes, and short redacted previews. It does not upload anything.

3. **Record + Share Reviewed Packs**

   AgInTiFlow records locally and allows the user to review/export/share **skill packs**. Sharing must never mean uploading raw sessions automatically. It should mean publishing a small reviewed package containing reusable Markdown skills, task profile hints, safe command policy patterns, test snippets, and metadata. This should be the default mode for the product, with strict text in settings explaining what is and is not shared.

Better label in UI:

```text
Record + Share Reviewed Skills
```

Settings page explanatory text:

```text
Skill sharing improves AgInTiFlow's skill set across users. Sharing is strict: AgInTiFlow never uploads raw chats, raw session logs, project source files, .env files, keys, browser storage, or artifacts by default. Only reviewed, redacted, high-value skill packs can be shared, and shared skills are deduplicated and verified before they can enter the mesh.
```

When the user selects **Disabled**, show:

```text
Skill Mesh is disabled. AgInTiFlow will not record local skill-learning metadata and will not share or receive reviewed skill packs. Enabling Record + Share Reviewed Skills can improve the shared skill set, but sharing remains strict and never uploads raw sessions or secrets.
```

Avoid label:

```text
Auto-share logs
```

because that is the wrong privacy model.

## How Users Communicate Without Sharing Raw Sessions

Users communicate through **capability artifacts**, not through transcripts.

Shared artifact types:

- `SKILL.md` files with frontmatter and workflow guidance.
- Task profile patches or suggestions.
- Command-policy examples, such as safe git pull/merge/rebase patterns.
- Tool recipes, such as Android emulator screenshot capture or LaTeX compile fallback.
- Smoke tests that prove a skill/tool pattern works.
- Failure postmortems rewritten as generic lessons.
- Model routing hints, such as which model is reliable for which class of task.

Never share by default:

- Raw prompts.
- Raw model responses.
- Raw `events.jsonl`.
- Source files from the user project.
- Absolute paths.
- Shell output containing environment variables.
- Screenshots/images/PDFs unless the user explicitly includes them in a reviewed example.
- Provider keys, npm tokens, SSH data, cookies, auth headers, or `.env` content.

## Local Pipeline

The local machine should have a lightweight housekeeping pipeline:

```text
session events
  -> redaction and path masking
  -> local housekeeping ledger
  -> candidate capability extractor
  -> user review queue
  -> signed skill pack
  -> optional share/sync
```

Existing foundation:

```text
~/.agintiflow/housekeeping/events.jsonl
~/.agintiflow/housekeeping/capabilities.json
```

Future local folders:

```text
~/.agintiflow/skillmesh/
  config.json
  identity.json
  inbox/
  outbox/
  reviewed/
  rejected/
  feeds/
  trusted-keys/
```

Candidate skill packs should stay local until reviewed.

## Slow Sync And Value Gate

Skill Mesh should avoid heavy or frequent communication.

Default sync behavior:

- No sync while an agent run is active.
- No sync while shell tools, browser tools, package installs, tests, or model calls are running.
- Sync only during idle windows.
- Add jitter so many clients do not sync at the same second.
- Cap outbound submissions per day.
- Cap inbound downloads per sync.
- Prefer metadata sync first, pack download second.
- Never use Skill Mesh as a live coordination channel for active agent tasks.

Suggested defaults:

```json
{
  "syncPolicy": {
    "enabled": false,
    "idleOnly": true,
    "minIdleSeconds": 90,
    "minIntervalMinutes": 360,
    "jitterMinutes": 30,
    "maxOutboundPacksPerDay": 3,
    "maxInboundPacksPerSync": 20,
    "metadataFirst": true,
    "downloadRequiresUserReview": true
  }
}
```

The local scheduler should be simple:

```text
if skillmesh.mode != "share": skip
if agent is running: skip
if last sync too recent: skip
if no reviewed outbox packs and no feed refresh due: skip
fetch feed metadata
dedupe against local database
download only selected/high-trust candidates
upload only reviewed outbound packs
```

### Value Scoring

The candidate extractor should not share every local observation. It should rank candidates and export only the most useful.

Signals that increase value:

- The same failure happened more than once and a reusable fix was found.
- A new skill/tool recipe was used successfully with verification.
- A command policy pattern prevented a dangerous or stuck command.
- A generated smoke test caught a real regression.
- A workflow applies across many projects, not only one user folder.
- The candidate contains acceptance criteria and verification commands.
- The candidate is small and self-contained.

Signals that reduce value:

- It mentions private project names, file paths, users, servers, or proprietary APIs.
- It depends on a very specific local machine layout.
- It duplicates an existing core skill.
- It only says generic advice.
- It was not verified by a test, command, screenshot, or file evidence.
- It requires secrets, sudo passwords, or private accounts.

Example scoring:

```json
{
  "minShareScore": 80,
  "weights": {
    "verified": 30,
    "reusedAcrossSessions": 20,
    "hasSmokeTest": 20,
    "hasClearTrigger": 10,
    "smallAndGeneric": 10,
    "duplicatesExistingSkill": -40,
    "containsPrivateContext": -100
  }
}
```

Only reviewed packs above the threshold should enter the share outbox.

## Deduplication Database

Both clients and relay servers need a database to avoid duplication and noisy sync.

Local database:

```text
~/.agintiflow/skillmesh/index.sqlite
```

Relay database:

```text
~/.aginti-skill-relay/index.sqlite
```

Core tables:

```sql
CREATE TABLE packs (
  pack_hash TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author_key_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  value_score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE pack_signatures (
  pack_hash TEXT NOT NULL,
  key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_hash, key_id)
);

CREATE TABLE installed_packs (
  pack_hash TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  source_feed TEXT NOT NULL DEFAULT ''
);

CREATE TABLE rejected_packs (
  pack_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);
```

Hash strategy:

- `pack_hash`: SHA-256 of the canonical tarball bytes.
- `canonical_id`: stable hash of normalized semantic content, excluding timestamps and signatures.
- `skill_hash`: SHA-256 of normalized `SKILL.md` body and frontmatter.
- `policy_hash`: SHA-256 of normalized command-policy JSON.

Deduplication should use both exact and semantic hashes:

- If `pack_hash` exists, skip.
- If `canonical_id` exists with the same or higher version, skip.
- If a skill body hash matches a core skill, mark as duplicate.
- If a pack is rejected locally, do not re-download it unless the hash changes.

Relay response should support metadata-only dedupe:

```json
{
  "feedVersion": 1,
  "packs": [
    {
      "packHash": "sha256:...",
      "canonicalId": "skill:android-emulator-screenshot:...",
      "name": "android-emulator-screenshot",
      "version": "0.1.0",
      "valueScore": 92,
      "trustLevel": "community-reviewed",
      "downloadUrl": "/packs/sha256-....tgz",
      "metadataUrl": "/packs/sha256-.../metadata.json"
    }
  ]
}
```

Clients should send only hashes when asking what is new:

```http
POST /sync/metadata
```

```json
{
  "clientProtocol": 1,
  "knownPackHashes": ["sha256:..."],
  "knownCanonicalIds": ["skill:..."],
  "acceptedTrustLevels": ["core", "trusted-publisher", "community-reviewed"]
}
```

This keeps routine communication small.

## Skill Pack Format

A shared skill pack should be a normal directory or tarball:

```text
skillpack.json
skills/<skill-id>/SKILL.md
profiles/<profile-id>.json
policies/<policy-id>.json
tests/<test-id>.js
examples/<example-id>/README.md
```

`skillpack.json` should include:

```json
{
  "schema": 1,
  "name": "android-emulator-screenshot",
  "version": "0.1.0",
  "author": "local-user-or-org",
  "license": "Apache-2.0",
  "createdAt": "2026-05-04T00:00:00.000Z",
  "source": "reviewed-local-learning",
  "privacy": {
    "rawSessionsIncluded": false,
    "secretsRedacted": true,
    "pathsMasked": true,
    "requiresHumanReview": true
  },
  "contents": {
    "skills": ["android-emulator-screenshot"],
    "profiles": ["android"],
    "tests": ["android-screenshot-smoke"]
  },
  "signature": {
    "algorithm": "ed25519",
    "publicKeyId": "..."
  }
}
```

The pack should be installable locally:

```bash
aginti skillmesh import ./android-emulator-screenshot.skillpack.tgz
```

and exportable:

```bash
aginti skillmesh export android-emulator-screenshot
```

## Trust Model

Skill Mesh should treat shared capabilities like dependencies.

Trust levels:

- **Core**: shipped by the npm package.
- **Trusted publisher**: signed by LazyingArt or a configured team key.
- **Community reviewed**: available from a feed, but not automatically active.
- **Local experimental**: created on this machine.
- **Blocked**: rejected by the user or a policy rule.

Installing a skill pack should show:

- Author.
- Signature status.
- Files included.
- Tools/commands it recommends.
- Whether it changes command policy.
- Whether it adds tests.
- Whether it has examples.

Default import behavior:

```text
download -> verify -> preview -> install disabled -> user enables
```

Do not auto-enable community skills that can cause shell, git, network, browser, or file-writing behavior.

## Server And P2P Options

There are three viable distribution modes.

### 1. No Server: npm-Only Sharing

This is the safest and simplest.

Flow:

```text
users learn locally -> useful lessons become PRs or releases -> npm package ships updated skills
```

Pros:

- Strong review.
- Easy install and update.
- No user data service.
- Good for stable core skills.

Cons:

- Slower feedback loop.
- Less community experimentation.

### 2. Skill Relay Server

Use an ECS machine as a lightweight relay/index. Suggested product name:

```text
AgInTi Skill Relay
```

The relay should store only reviewed skill packs and feed metadata.

Server responsibilities:

- Receive signed skill packs.
- Reject raw session uploads.
- Run redaction/sanity checks.
- Compute hashes and deduplicate.
- Expose feed indexes.
- Serve downloads.
- Keep reputation/signature metadata.
- Optionally maintain review status.
- Rate-limit clients and publishers.
- Maintain dedupe indexes by exact and semantic hash.
- Support metadata-only sync.
- Quarantine untrusted uploads before feed publication.

Server should not:

- Store raw `~/.agintiflow/sessions`.
- Store raw project source.
- Store provider keys.
- Execute uploaded code.
- Auto-push updates to clients.
- Accept anonymous bulk uploads without rate limits.
- Act as a general file-sharing server.
- Serve packs that failed redaction or archive policy checks.

Possible server command:

```bash
aginti-skill-relay serve --host 0.0.0.0 --port 7377 --data ~/.aginti-skill-relay
```

Client sync:

```bash
aginti skillmesh feed add lazyingart https://skills.flow.lazying.art/feed.json
aginti skillmesh sync
aginti skillmesh inbox
```

### Strict Server Contract

The relay should be defensive by default.

Inbound upload checks:

- Require authenticated publisher identity or a temporary upload token.
- Require signed `skillpack.json`.
- Require archive size under a small limit, for example 2 MB initially.
- Require max file count, for example 100 files.
- Require all paths to be relative and normalized.
- Reject symlinks, hardlinks, device files, absolute paths, and `..` path traversal.
- Reject executable binaries by default.
- Reject nested archives by default.
- Reject any archive containing raw session filenames.
- Scan every text file for token/secret patterns.
- Require `privacy.rawSessionsIncluded=false`.
- Require `privacy.requiresHumanReview=true` unless the publisher is trusted.
- Put uploads into `pending` before public feed inclusion.

Outbound feed checks:

- Serve only approved or trusted packs.
- Include content hashes and signature metadata.
- Include trust level and review status.
- Do not expose uploader IPs or private client metadata.
- Keep feed response small and cacheable.
- Use ETag/If-None-Match for low traffic.

Abuse controls:

- Per-IP rate limits.
- Per-publisher daily upload limits.
- Maximum pending queue size.
- Manual blocklist for bad keys, bad IPs, and bad pack hashes.
- Audit log of decisions without storing raw private content.

The relay should fail closed: if validation cannot prove a pack is safe, the pack stays private/pending.

### Strict Client Contract

Clients must also be defensive.

Before upload:

- Export only reviewed packs from `~/.agintiflow/skillmesh/reviewed/`.
- Run local redaction scan.
- Run archive policy scan.
- Show a human-readable manifest preview.
- Require explicit confirmation unless the publisher key is configured for unattended sharing.
- Upload only pack metadata first if possible.

Before download/install:

- Fetch metadata first.
- Deduplicate locally.
- Verify signature when present.
- Reject packs with unsupported schema.
- Reject packs requiring disabled capabilities.
- Install community packs disabled by default.
- Show diff/manifest before enabling.
- Never let a downloaded pack directly change provider keys, `.env`, shell policy, or auto-update settings.

Client setting:

```json
{
  "downloadPolicy": {
    "autoDownloadMetadata": true,
    "autoDownloadPacks": false,
    "autoEnableSkills": false,
    "allowPolicyChanges": false,
    "allowExecutableTests": false
  }
}
```

### 3. P2P Mesh

True P2P can come later. It is harder because NAT traversal, identity, signatures, spam, and moderation become product concerns.

Pragmatic first step:

- Use the ECS server as a rendezvous and relay.
- Keep client identity keypairs local.
- Sign every skill pack.
- Let users subscribe to feeds rather than broadcast everything.

This gives most of the value of P2P without building a fragile distributed network first.

### Volunteer Shared Nodes

A volunteer shared node is a user-run relay that can exchange reviewed skill packs with the major node and with trusted peers.

Modes:

- **Client only**: syncs with feeds, does not accept inbound connections.
- **Volunteer node**: serves a local feed and accepts reviewed pack submissions from configured peers.
- **Major node**: public, stable relay operated by LazyingArt or a trusted maintainer.

Volunteer nodes should be opt-in and conservative:

```bash
aginti skillmesh node init
aginti skillmesh node check-public
aginti skillmesh node serve --port 7377
```

Node health checks:

- Public URL configured.
- TLS available or explicitly disabled for LAN-only.
- `/health` reachable from outside if public.
- Feed endpoint reachable.
- Upload endpoint protected.
- Data directory not inside a project repo.
- Rate limits enabled.
- Pack quarantine enabled.

If a machine is behind LAN/NAT, the user can provide an external tunnel:

```bash
ngrok http 7377
aginti skillmesh node set-url https://example.ngrok-free.app
aginti skillmesh node check-public
```

The node should not guess that it is public. It should verify from an external check endpoint or ask the major relay to call back:

```text
local node -> major node: please verify https://example.ngrok-free.app/health with nonce abc
major node -> local node: GET /health?nonce=abc
local node -> major node: verification succeeds
```

Only verified nodes should be listed as reachable peers.

### Verified Node Admission

A node can join the mesh only after a currently verified node can connect to it and complete the designed verification API.

Default admission authority:

```text
skills.flow.lazying.art
```

This means a LAN machine exposed by ngrok or a public `ip:port` is not trusted just because the user typed a URL. The major node must verify it first.

Admission flow:

```text
candidate node starts local relay
candidate node sets public URL, for example ngrok URL or https://ip:port
candidate node asks major node to verify
major node creates nonce and expected callback challenge
major node calls candidate /health and /node/verify endpoints
candidate proves it owns the local node identity key
major node checks protocol version, TLS/public URL, feed endpoint, upload protection, rate limits, and quarantine
major node adds candidate to node list as verified
verified node appears in feed metadata for optional peer sync
```

Verification API shape:

```http
POST /nodes/register
GET  /health?nonce=<nonce>
POST /node/verify
GET  /feed.json
```

Candidate registration payload:

```json
{
  "nodeId": "ed25519:key-id",
  "publicUrl": "https://example.ngrok-free.app",
  "role": "volunteer",
  "protocol": 1,
  "capabilities": ["feed", "metadata-sync"],
  "signature": "signature over publicUrl + nonce"
}
```

Major node checks:

- Public URL is reachable from the major node.
- Node identity signature verifies.
- `/health` returns the expected nonce.
- `/feed.json` is valid and small.
- Upload endpoint is either disabled or protected.
- Node advertises idle/slow sync policy.
- Node does not claim to accept raw sessions.
- Node version/protocol is compatible.

Node list table:

```sql
CREATE TABLE verified_nodes (
  node_id TEXT PRIMARY KEY,
  public_url TEXT NOT NULL,
  role TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  status TEXT NOT NULL,
  first_verified_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL
);
```

Removal policy:

- Recheck verified nodes occasionally, for example every 6-24 hours.
- If a node fails once, mark `degraded`.
- If it fails repeatedly, mark `offline`.
- If it stays offline beyond a threshold, remove it from the public node list.
- Keep the historical record locally for audit, but do not advertise unavailable nodes.

Suggested thresholds:

```json
{
  "nodeVerification": {
    "recheckIntervalHours": 12,
    "degradedAfterFailures": 1,
    "offlineAfterFailures": 3,
    "removeAfterOfflineDays": 7
  }
}
```

## ECS Deployment Role

The Alibaba Cloud ECS host can run a Skill Relay node.

Recommended architecture:

```text
nginx or caddy
  -> aginti-skill-relay node process
  -> ~/.aginti-skill-relay/index.sqlite
  -> ~/.aginti-skill-relay/packs/
```

Minimum endpoints:

```text
GET  /health
GET  /feed.json
GET  /packs/<hash>.tgz
POST /submit
GET  /packs/<hash>/metadata.json
```

Major node role:

- Stable public rendezvous point.
- Canonical community feed.
- Deduplication authority for public packs.
- Optional verification callback service for volunteer nodes.
- Optional relay for metadata exchange between trusted nodes.
- Not a raw memory server.

Recommended domain:

```text
skills.flow.lazying.art
```

Possible deployment command on `sshem`:

```bash
npm install -g @lazyingart/agintiflow
aginti skillmesh serve \
  --role major \
  --host 127.0.0.1 \
  --port 7377 \
  --data ~/.aginti-skill-relay \
  --public-url https://skills.flow.lazying.art
```

With nginx/caddy terminating TLS:

```text
https://skills.flow.lazying.art
  -> 127.0.0.1:7377
```

Initial server config:

```json
{
  "role": "major",
  "publicUrl": "https://skills.flow.lazying.art",
  "dataDir": "~/.aginti-skill-relay",
  "acceptUploads": true,
  "requireSignatures": true,
  "requireReview": true,
  "maxPackBytes": 2097152,
  "maxFilesPerPack": 100,
  "rateLimits": {
    "submitPerIpPerHour": 10,
    "submitPerPublisherPerDay": 20,
    "metadataPerIpPerMinute": 60
  }
}
```

### Major Node Bootstrap On `sshem`

The `sshem` ECS machine should be treated as the first **major node**. Other users who enable `Record + Share Reviewed Skills` can sync with it, but the node should still accept only reviewed/signed packs and should publish feeds slowly.

Host assumptions from the current ECS login:

```text
OS: Ubuntu 24.04 LTS
role: public major relay
service user: aginti-relay
data: /var/lib/aginti-skill-relay
logs: /var/log/aginti-skill-relay
public domain: skills.flow.lazying.art
internal port: 7377
```

Bootstrap outline:

```bash
sudo adduser --system --group --home /var/lib/aginti-skill-relay aginti-relay
sudo mkdir -p /var/lib/aginti-skill-relay /var/log/aginti-skill-relay
sudo chown -R aginti-relay:aginti-relay /var/lib/aginti-skill-relay /var/log/aginti-skill-relay
npm install -g @lazyingart/agintiflow
```

Service command:

```bash
sudo -u aginti-relay aginti skillmesh serve \
  --role major \
  --host 127.0.0.1 \
  --port 7377 \
  --data /var/lib/aginti-skill-relay \
  --public-url https://skills.flow.lazying.art
```

Systemd shape:

```ini
[Unit]
Description=AgInTi Skill Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aginti-relay
Group=aginti-relay
WorkingDirectory=/var/lib/aginti-skill-relay
Environment=NODE_ENV=production
ExecStart=/usr/bin/env aginti skillmesh serve --role major --host 127.0.0.1 --port 7377 --data /var/lib/aginti-skill-relay --public-url https://skills.flow.lazying.art
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/aginti-skill-relay /var/log/aginti-skill-relay

[Install]
WantedBy=multi-user.target
```

Nginx/Caddy should terminate TLS and proxy only the relay domain to `127.0.0.1:7377`. The relay process itself should not bind directly to `0.0.0.0` on the major node unless there is no reverse proxy.

Firewall:

```text
allow 22/tcp for SSH
allow 80/tcp for ACME HTTP challenge if needed
allow 443/tcp for HTTPS
deny public 7377/tcp
```

Backups:

- Back up `index.sqlite`, `packs/`, `trusted-keys/`, and `review-state/`.
- Do not back up temporary upload quarantine forever; expire rejected uploads.
- Keep audit logs but rotate them.
- Never back up or store submitted raw sessions because those should be rejected before persistence.

Major node publishing cadence:

```text
incoming upload -> quarantine -> validation -> pending review -> approved feed batch
feed batch interval: 30-60 minutes
metadata cache: ETag + max-age
pack files: immutable by hash
```

Major node failure mode:

- If validation worker fails, uploads stay pending.
- If database write fails, upload fails.
- If redaction scanner fails, upload is rejected or held pending.
- If feed generation fails, keep serving the last known good feed.
- If disk usage is high, stop accepting uploads before serving breaks.

Submission policy:

- Require signed packs.
- Require `privacy.rawSessionsIncluded=false`.
- Reject archives containing `.env`, `.git`, `.aginti-sessions`, `.sessions`, `events.jsonl`, `state.json`, `storage-state.json`, or obvious private paths.
- Run content scans for token patterns.
- Put new packs into `pending` until approved or trusted.
- Reject too frequent submissions.
- Reject duplicate exact hashes immediately.
- Merge duplicate semantic packs into the same canonical record.

## Sync Frequency Policy

Skill Mesh should be closer to package update checks than chat messages.

Default sync cadence:

```text
metadata refresh: every 6-12 hours
pack upload: idle-only, max 3/day by default
pack download: manual review or trusted feed only
major relay feed publish: batch every 30-60 minutes
volunteer node peer sync: every 12-24 hours
```

Reasons:

- Skills are slow-changing knowledge.
- Frequent sync increases privacy and abuse risk.
- Low-frequency sync makes server costs predictable.
- Idle-only sync avoids interfering with agent work.
- Batch publishing gives time for validation and review.

The UI should show sync state:

```text
Skill Mesh: Record + Share Reviewed Skills
last sync: 2026-05-04 13:06
next sync: after 18:58, idle-only
outbox: 1 reviewed pack pending
inbox: 4 new candidates, 0 enabled
relay: skills.flow.lazying.art healthy
```

## Commands

Interactive:

```text
/skillmesh
```

Selector:

```text
Skill Mesh
> Record + Share Reviewed Skills
  Record Locally
  Disabled
```

CLI:

```bash
aginti skillmesh status
aginti skillmesh off
aginti skillmesh record
aginti skillmesh share
aginti skillmesh review
aginti skillmesh export <name>
aginti skillmesh import <file-or-url>
aginti skillmesh feed add <name> <url>
aginti skillmesh sync
aginti skillmesh serve
aginti skillmesh node init
aginti skillmesh node check-public
aginti skillmesh node set-url <url>
```

Config:

```json
{
  "mode": "share",
  "feeds": [],
  "shareRequiresReview": true,
  "autoInstallSharedSkills": false,
  "trustedPublishers": [],
  "syncPolicy": {
    "idleOnly": true,
    "minIntervalMinutes": 360,
    "maxOutboundPacksPerDay": 3
  }
}
```

Environment override:

```bash
AGINTIFLOW_SKILLMESH=off
AGINTIFLOW_SKILLMESH=record
AGINTIFLOW_SKILLMESH=share
```

## Safety Rules

Hard rules:

- Never upload raw session directories.
- Never upload `.aginti-sessions/` or `.sessions/`.
- Never upload `.env`, `.npmrc`, SSH keys, browser storage, cookies, or auth tokens.
- Never enable shared skills automatically if they affect shell, git, network, filesystem writes, browser auth, or package installation.
- Keep the sharing state visible through `aginti skillmesh status`.

Good defaults:

- `Record + Share Reviewed Skills` for product default, because it can improve the shared skill set while still requiring strict reviewed-pack sharing.
- `Record Locally` for users who want learning logs but no network sharing.
- Shared packs install disabled until enabled.
- ECS relay accepts uploads only after local pack validation.
- Sync is idle-only and low-frequency.
- Metadata sync happens before pack transfer.
- Deduplication happens before download or upload.

## Implementation Stages

### Stage 1: Local Skill Mesh

- Add `/skillmesh` selector with three modes.
- Store config in `~/.agintiflow/skillmesh/config.json`.
- Add `aginti skillmesh status`.
- Keep using the existing housekeeping ledger.
- Add local review queue from housekeeping candidates.

### Stage 2: Skill Pack Export/Import

- Add `aginti skillmesh export`.
- Add `aginti skillmesh import`.
- Support signature generation and verification.
- Install imported skills disabled by default.

### Stage 3: Relay Server

- Add a separate npm binary:

```bash
npm install -g @lazyingart/aginti-skill-relay
aginti-skill-relay serve
```

or keep it inside AgInTiFlow:

```bash
aginti skillmesh serve
```

Recommendation: start inside AgInTiFlow for speed, split into `@lazyingart/aginti-skill-relay` once the protocol stabilizes.

Stage 3 should include:

- SQLite dedupe database.
- Pack archive validator.
- Secret scanner.
- Signature verifier.
- Pending/reviewed/rejected states.
- Metadata-only sync endpoint.
- Public reachability check for volunteer nodes.
- Nginx/Caddy deployment docs for ECS.

### Stage 4: Community Feed And Review

- Add feed subscription.
- Add pending inbox.
- Add publisher trust list.
- Add simple moderation state on the relay.
- Publish stable reviewed skills through npm releases.

### Stage 5: Volunteer Node Federation

- Add volunteer node mode.
- Add ngrok/public URL configuration.
- Add major-node callback verification.
- Add peer allowlists.
- Add low-frequency node-to-node metadata sync.
- Keep major node as the default rendezvous and dedupe authority.
- Remove nodes from the advertised node list when repeated reachability checks fail.

## Naming Recommendation

Use:

```text
Skill Mesh
/skillmesh
aginti skillmesh
AgInTi Skill Relay
```

Why:

- `Skill Mesh` describes distributed capability sharing without promising raw P2P networking immediately.
- `Skill Relay` is honest for the ECS role: it relays and indexes reviewed packs.
- The names are short enough for CLI and clear enough for docs.

Avoid:

```text
Skill Cloud
Skill Brain
Auto Learn Share
Swarm Memory
```

because they imply centralized memory, automatic uploads, or raw agent transcript sharing.
