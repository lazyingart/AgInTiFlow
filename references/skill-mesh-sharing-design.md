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

The default should be conservative: local recording only, no sharing unless the user explicitly enables it.

## Core Modes

The selector for `/skillmesh` should have three modes:

1. **Disabled**

   No housekeeping export, no community sync, no skill suggestions from shared feeds. Raw local session history still stays in `~/.agintiflow/sessions/` if normal sessions are enabled, but no Skill Mesh aggregation is used.

2. **Record Locally**

   AgInTiFlow records sanitized local capability metadata into `~/.agintiflow/housekeeping/`. This includes model/tool names, selected skill ids, command categories, outcome hashes, and short redacted previews. It does not upload anything. This should be the default for technical users.

3. **Record + Share Reviewed Packs**

   AgInTiFlow records locally and allows the user to review/export/share **skill packs**. Sharing must never mean uploading raw sessions automatically. It should mean publishing a small reviewed package containing reusable Markdown skills, task profile hints, safe command policy patterns, test snippets, and metadata.

Better label in UI:

```text
Record + Share Reviewed Skills
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

Server should not:

- Store raw `~/.agintiflow/sessions`.
- Store raw project source.
- Store provider keys.
- Execute uploaded code.
- Auto-push updates to clients.

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

### 3. P2P Mesh

True P2P can come later. It is harder because NAT traversal, identity, signatures, spam, and moderation become product concerns.

Pragmatic first step:

- Use the ECS server as a rendezvous and relay.
- Keep client identity keypairs local.
- Sign every skill pack.
- Let users subscribe to feeds rather than broadcast everything.

This gives most of the value of P2P without building a fragile distributed network first.

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

Submission policy:

- Require signed packs.
- Require `privacy.rawSessionsIncluded=false`.
- Reject archives containing `.env`, `.git`, `.aginti-sessions`, `.sessions`, `events.jsonl`, `state.json`, `storage-state.json`, or obvious private paths.
- Run content scans for token patterns.
- Put new packs into `pending` until approved or trusted.

## Commands

Interactive:

```text
/skillmesh
```

Selector:

```text
Skill Mesh
> Disabled
  Record Locally
  Record + Share Reviewed Skills
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
```

Config:

```json
{
  "mode": "record",
  "feeds": [],
  "shareRequiresReview": true,
  "autoInstallSharedSkills": false,
  "trustedPublishers": []
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

- `Record Locally` for local capability learning.
- `Record + Share Reviewed Skills` only after explicit user selection.
- Shared packs install disabled until enabled.
- ECS relay accepts uploads only after local pack validation.

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

### Stage 4: Community Feed And Review

- Add feed subscription.
- Add pending inbox.
- Add publisher trust list.
- Add simple moderation state on the relay.
- Publish stable reviewed skills through npm releases.

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
