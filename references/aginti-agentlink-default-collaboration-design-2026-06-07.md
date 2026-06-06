# AgInTi AgentLink Default Collaboration Design

Date: 2026-06-07  
Scope: research and product design only; no runtime code changes in this pass.  
Related LazySkills skill: `/home/lachlan/ProjectsLFS/LazySkills/skills/aginti-agentlink/`

## Executive Summary

AgInTiFlow should make collaboration between AgInTi sessions a default product capability, but it should not do this by letting sessions freely read each other's raw chats or by turning every run into a realtime swarm.

The right design is a typed coordination layer over the primitives AgInTiFlow already has:

- central session storage;
- event logs;
- session inbox and queued input;
- CLI/web shared session surfaces;
- artifacts/canvas;
- SCS evidence gates;
- long jobs;
- tmux tools;
- MCP bridge;
- SkillMesh and housekeeping redaction.

The feature name should be:

```text
AgInTi AgentLink
```

Default behavior should be conservative:

```text
local AgentLink index: on
same-machine session discovery: on
manual linking between sessions: on
network peer linking: off by default
raw session sharing: never by default
```

AgentLink should let sessions coordinate through:

- peer identities;
- shared boards;
- action contracts;
- typed messages;
- status probes;
- evidence bundles;
- ownership boundaries;
- redacted summaries.

It should not use unstructured chat memory as the coordination substrate.

## Why This Belongs In Core

The LazySkills `aginti-agentlink` skill defines a useful protocol, but making multi-session collaboration reliable requires runtime support. A skill can teach an agent what to do; it cannot by itself guarantee:

- stable peer identity;
- message acknowledgement;
- durable board state;
- race-free task claiming;
- permission-safe cross-session handoff;
- private raw-log boundaries;
- UI visibility;
- stop/resume semantics;
- evidence-linked finish validation.

Therefore, AgentLink is a system-level design feature, not just a custom skill.

The skill should remain useful as workflow guidance, but core AgInTiFlow should provide the mechanism.

## Current Architecture Observed

This review inspected AgInTiFlow source and docs without editing runtime code.

### Session Store

`src/session-store.js` already provides the core durable state layout:

```text
~/.agintiflow/sessions/<session-id>/
  state.json
  plan.md
  events.jsonl
  inbox.jsonl
  storage-state.json
  artifacts/
```

Relevant existing capabilities:

- `saveState`
- `savePlan`
- `saveJsonArtifact`
- `appendEvent`
- `loadEvents`
- `appendInbox`
- `loadInbox`
- `saveInbox`
- `drainInbox`
- `saveSnapshot`

This is enough to support the first AgentLink MVP without changing the basic session model.

### Session Index

`src/session-index.js` stores a global session index under:

```text
~/.agintiflow/sessions/index.sqlite
~/.agintiflow/sessions/index.json
```

It tracks:

- session id;
- project root;
- command cwd;
- project sessions dir;
- session dir;
- provider;
- model;
- goal;
- title;
- status;
- timestamps;
- result;
- error.

This index is a good base for same-machine session discovery. AgentLink should add a peer/session layer, not duplicate the session index.

### CLI/Web Shared Inbox

`docs/agent-runtime-pipe.md` describes the existing runtime pipe:

```text
Runtime inbox: ~/.agintiflow/sessions/<session-id>/inbox.jsonl
```

The web API exposes:

```text
GET    /api/sessions/:id/inbox
POST   /api/sessions/:id/inbox
PATCH  /api/sessions/:id/inbox/:itemId
DELETE /api/sessions/:id/inbox/:itemId
```

`src/agent-runner.js` drains the inbox at safe boundaries and appends queued messages as user messages. This is currently user-message oriented. AgentLink should reuse the storage pattern but add typed coordination messages instead of stuffing all collaboration into plain text.

### Events And Artifacts

AgInTiFlow already records session events such as:

- `session.created`
- `session.resumed`
- `skills.selected`
- `plan.created`
- `tool.started`
- `tool.completed`
- `file.changed`
- `canvas.item`
- `session.finished`
- `session.failed`
- `session.stopped`
- `conversation.queued_input`
- `conversation.queued_input_applied`

`src/artifact-tunnel.js` and `references/backend-frontend-artifact-tunnel.md` show a mature pattern: derive UI-visible artifacts from session events instead of inventing a parallel artifact database.

AgentLink should follow the same pattern. Board updates, peer messages, task claims, and evidence attachments should be events first.

### SCS Evidence Gate

The SCS system already rejects unsupported finish claims and allows proven blockers. AgentLink should use SCS for cross-session completion:

- committee plans the multi-session contract;
- supervisor executes only the local owned actions;
- student validates peer evidence before accepting completion.

The finish gate must not accept "peer says done" unless the peer attached concrete evidence.

### Long Jobs And Tmux

`docs/runtime-modes-and-autonomy.md`, `src/long-job-tools.js`, and `src/tmux-tools.js` already separate durable shell work from model polling.

AgentLink should treat long jobs and tmux sessions as owned resources:

```text
session A owns: long_job_id, tmux target, output path
session B may inspect: status summary, evidence bundle
session B may not control: stop/restart/send keys unless explicitly granted
```

### MCP

`docs/mcp.md` describes a guarded MCP bridge with fixed bridge tools. MCP is for external tools/resources/prompts. It is not the same as AgentLink.

AgentLink may eventually expose an MCP server so outside clients can inspect sessions or send handoffs, but the default internal feature should not depend on MCP.

### SkillMesh

`docs/skillmesh.md` and `references/skill-mesh-sharing-design.md` define slow, reviewed, privacy-preserving skill sharing. SkillMesh exchanges capability packs. It is not a realtime coordination bus.

AgentLink should use the same privacy philosophy but a different lifecycle:

```text
SkillMesh: share reusable capabilities across users/machines after review.
AgentLink: coordinate active sessions on concrete tasks with typed evidence.
```

### Housekeeping

`src/housekeeping.js` redacts and aggregates capability metadata from session events. AgentLink should reuse this redaction discipline for cross-session summaries.

## Product Goal

AgInTi should support this normal workflow:

```text
User starts several AgInTi sessions across CLI/web/machines.
Each session knows its own role, cwd, tools, constraints, and current state.
The user links sessions into a shared board.
Sessions exchange typed requests, status, blockers, and evidence.
Each session acts only within its own ownership boundary.
The final report cites evidence from all participating sessions.
```

The user should be able to say:

```text
Use the Windows AgInTi session to control Arduino, the KV260 session to record events, and this session to supervise the experiment.
```

and AgInTiFlow should not rely on informal chat memory to coordinate that.

## Core Concepts

### Agent Node

An Agent Node is one active or resumable AgInTi session plus host/workspace/tool metadata.

Example:

```json
{
  "nodeId": "kv260-session",
  "sessionId": "web-agent-...",
  "host": "xilinx-kv260-starterkit-20222",
  "user": "petalinux",
  "projectRoot": "/home/petalinux/Projects/kria-kv260-starter",
  "commandCwd": "/home/petalinux/Projects/kria-kv260-starter",
  "role": "event camera recorder",
  "capabilities": ["shell", "tmux", "long_job", "http", "files"],
  "constraints": ["/dev/video0 single owner", "no host package installs"],
  "status": "idle",
  "lastSeenAt": "2026-06-07T00:00:00.000Z"
}
```

### AgentLink

An AgentLink connects two or more nodes around a shared objective.

Example:

```json
{
  "linkId": "event-camera-light-sync",
  "projectRoot": "/home/lachlan/ProjectsLFS/Experiment",
  "objective": "Record event-camera response while Windows Arduino modulates light.",
  "nodes": ["supervisor", "kv260-session", "windows-session"],
  "boardId": "board-event-camera-light-sync",
  "trust": "local-manual",
  "createdBy": "user",
  "createdAt": "2026-06-07T00:00:00.000Z"
}
```

### Board

A Board is the durable collaboration surface for one objective. It is not raw chat.

The board contains:

- objective;
- peers;
- ownership boundaries;
- tasks;
- action contracts;
- messages;
- blockers;
- evidence bundles;
- final status.

### Action Contract

An Action Contract says who owns what and what evidence closes the task.

Example:

```json
{
  "contractId": "record-run-001",
  "objective": "Record a 5-second KV260 event-camera file while Arduino runs light pattern A.",
  "owners": {
    "windows-session": ["Arduino COM port", "light pattern command"],
    "kv260-session": ["/dev/video0", "event recording API"],
    "supervisor": ["final evidence review"]
  },
  "allowedActions": [
    "windows-session may upload or run Arduino light sketch",
    "kv260-session may start/stop recording API",
    "supervisor may request status and attach evidence"
  ],
  "stopConditions": [
    "Arduino board not detected",
    "/dev/video0 busy and takeover denied",
    "network unreachable",
    "unexpected dirty worktree before edits"
  ],
  "requiredEvidence": [
    "Arduino status output",
    "KV260 recording API JSON",
    "recording file path and byte size",
    "timestamps for light start and recording start"
  ]
}
```

### Evidence Bundle

Evidence should be structured and linked to artifacts/events, not pasted prose.

Example:

```json
{
  "evidenceId": "evidence-recording-001",
  "nodeId": "kv260-session",
  "contractId": "record-run-001",
  "kind": "recording",
  "summary": "Recorded 5.0 seconds through API with takeover=true.",
  "events": [
    {
      "sessionId": "web-agent-...",
      "eventType": "tool.completed",
      "timestamp": "2026-06-07T00:00:01.000Z"
    }
  ],
  "artifacts": [
    {
      "path": "/home/petalinux/event_recordings/run001.pse2.raw",
      "sizeBytes": 12345678,
      "sha256": "optional"
    }
  ],
  "verifiedAt": "2026-06-07T00:00:06.000Z"
}
```

### AgentLink Message

Messages should be typed:

```json
{
  "messageId": "msg-...",
  "boardId": "board-event-camera-light-sync",
  "from": "supervisor",
  "to": "kv260-session",
  "type": "task_request",
  "priority": "normal",
  "contractId": "record-run-001",
  "content": "Start the recording API and perform a 5-second recording with prefix skill_smoke.",
  "requiresAck": true,
  "createdAt": "2026-06-07T00:00:00.000Z",
  "expiresAt": "2026-06-07T00:30:00.000Z"
}
```

Recommended message types:

```text
status_request
status_response
task_request
task_claim
task_update
task_done
task_blocked
evidence_attached
handoff_summary
permission_request
permission_denied
permission_granted
contract_proposed
contract_accepted
contract_rejected
stop_request
```

## Proposed Storage

Do not put AgentLink state inside project source by default. Use central AgInTiFlow storage with optional project pointers.

Recommended central storage:

```text
~/.agintiflow/agentlink/
  identity.json
  peers.sqlite
  boards/
    <board-id>/
      board.json
      events.jsonl
      messages.jsonl
      evidence.jsonl
      contracts/
        <contract-id>.json
      summaries/
        <node-id>.md
  private-mirrors/
    <peer-id>/
      README.md
      raw-history.jsonl
```

Recommended project pointer:

```text
<project>/.aginti/agentlink.json
```

Example pointer:

```json
{
  "boards": [
    {
      "boardId": "board-event-camera-light-sync",
      "objective": "Coordinate KV260 and Windows Arduino experiment",
      "createdAt": "2026-06-07T00:00:00.000Z"
    }
  ]
}
```

Project pointer files may be committed only if they do not expose private paths, hostnames, IPs, raw logs, or secrets. Otherwise they should stay ignored.

## Default Modes

AgentLink should have clear modes:

### `off`

No AgentLink discovery or board updates.

### `local`

Default. Same-machine sessions can be discovered from `~/.agintiflow/sessions/index.sqlite`, but no network link is opened.

### `project`

Sessions with the same project root may share a project board. Messages are still local files unless the user configures remote sync.

### `manual-peer`

User explicitly links a remote peer through SSH, copied handoff packet, or URL. No automatic raw session sync.

### `team`

Future mode. A trusted relay coordinates peer summaries and board events. Requires authentication, explicit invite, and stricter ACLs.

### `mesh`

Not a realtime coordination mode. SkillMesh remains for reviewed capability exchange only.

## CLI Surface

Recommended commands:

```bash
aginti link status
aginti link peers
aginti link boards
aginti link create "objective"
aginti link join <board-id>
aginti link leave <board-id>
aginti link invite <session-id> --role "tester"
aginti link send <peer> --type task_request --contract <contract-id> "message"
aginti link board <board-id>
aginti link contract new <board-id>
aginti link evidence attach <board-id> --file path --summary "..."
aginti link summarize <session-id>
aginti link private-mirror <peer> --from path
```

Interactive commands:

```text
/link
/link status
/link peers
/link board
/link send <peer> <message>
/link evidence
/agents
```

`aginti queue <session-id> "message"` should remain a simple user-level queue command. AgentLink should not break it. Instead, AgentLink can use inbox internally with richer metadata.

## Web UI Surface

Add a "Collaborators" or "AgentLink" panel.

Minimum useful web UI:

- peer/session list;
- active board list;
- current board objective;
- action contract cards;
- task ownership table;
- messages with acknowledgement state;
- evidence bundle list;
- blockers;
- "Send to peer" composer;
- "Attach selected artifact as evidence";
- "Request status";
- "Summarize this session for peers";
- "Disconnect/link mode" controls.

The UI should not show raw event logs by default. It should show summarized cards with links to exact evidence when the user opens details.

## Model Tool Surface

Expose a small fixed bridge toolset to the model, similar to the MCP bridge philosophy.

Recommended tools:

```text
agentlink_list_peers
agentlink_get_board
agentlink_create_board
agentlink_send_message
agentlink_claim_task
agentlink_attach_evidence
agentlink_request_status
agentlink_summarize_session
agentlink_read_summary
agentlink_update_contract
```

Do not dynamically expose every peer's tools to the model.

Bad design:

```text
peer_windows_run_command
peer_kv260_tmux_send_keys
peer_browser_click
```

This creates tool poisoning, permission confusion, and accidental remote control.

Good design:

```text
agentlink_send_message({
  to: "windows-session",
  type: "task_request",
  contractId: "record-run-001",
  content: "Please run Arduino board detection and attach output."
})
```

The peer session decides whether it may execute the request under its local policy.

## Permission And Trust Policy

AgentLink must never be a permission bypass.

Rules:

- A session may request action from a peer; it may not silently execute tools in the peer.
- The receiving peer evaluates the request under its own sandbox, permission mode, cwd, policy, and user approvals.
- Cross-session messages must record sender, recipient, board id, timestamp, type, and origin.
- Mutating requests require an action contract.
- Dangerous requests require local approval in the receiving session.
- Peer evidence is untrusted until validated by the receiver or supervisor.
- Raw session logs stay private unless explicitly mirrored by the user.
- Private mirrors must live under ignored folders.
- Shared summaries must redact secrets and private absolute paths.

Trust levels:

```text
self
same-user-local
same-project-local
manual-ssh-peer
trusted-team-relay
untrusted-imported-summary
```

Default should be `same-user-local` only.

## Raw History Policy

AgentLink should formalize the pattern already described by the LazySkills skill:

```text
Prefer curated summaries.
Use raw histories only when needed.
Store raw histories in ignored private folders.
Never commit raw histories.
Never paste raw histories into another model context wholesale.
Extract only operational facts.
```

Recommended raw mirror path:

```text
~/.agintiflow/agentlink/private-mirrors/<peer-id>/
```

For project-local mirrors:

```text
<project>/private/agentlink/<peer-id>/
```

`private/` should be added to `.gitignore` by any helper that creates it.

## How AgentLink Differs From Existing Features

### Not Just Inbox

The inbox is a message pipe into one session. AgentLink is a coordination model across sessions with identity, roles, contracts, and evidence.

### Not Just Resume

Resume continues one session. AgentLink lets several sessions coordinate without collapsing them into one context.

### Not Just SkillMesh

SkillMesh shares reusable skills after review. AgentLink coordinates active work.

### Not Just MCP

MCP exposes tools/resources/prompts. AgentLink exposes peer sessions, boards, tasks, and evidence.

### Not Just Tmux

Tmux keeps terminals alive. AgentLink tells separate agents what they own and how they close shared tasks.

## Default Agent Behavior

When AgentLink is available, AgInTi should automatically consider it for prompts mentioning:

```text
another session
other aginti
peer agent
windows session
board session
supervisor session
student session
codex session
tmux session
coordinate
collaborate
handoff
multi-machine
remote host
hardware pair
agent team
```

But automatic consideration does not mean automatic action. The default should be:

1. Detect likely collaboration.
2. Show candidate peers/boards.
3. Ask for explicit link/role if ambiguity matters.
4. Create or reuse a board.
5. Draft an action contract.
6. Send typed requests.
7. Wait for peer evidence or blocker.

For simple prompts, AgentLink should stay invisible.

## Suggested Implementation Phases

### Phase 0: Keep Skill As Guidance

Immediate state:

- LazySkills `aginti-agentlink` remains a reusable skill.
- AgInTiFlow can load it through external skill packs.
- Users can manually use `aginti queue`, tmux, and handoff docs.

No core runtime behavior changes.

### Phase 1: Local AgentLink Metadata

Add central AgentLink storage:

```text
~/.agintiflow/agentlink/
```

Add:

- local identity;
- board records;
- peer/session discovery from the session index;
- event types;
- CLI `aginti link status`, `peers`, `boards`.

No network, no remote execution.

Smoke test:

- create two mock sessions;
- register both as peers;
- create one board;
- attach one status message;
- verify files and JSON schema.

### Phase 2: Typed Messages Over Session Inbox

Extend inbox items with AgentLink metadata:

```json
{
  "id": "agentlink-msg-...",
  "kind": "agentlink",
  "boardId": "...",
  "fromNodeId": "...",
  "toNodeId": "...",
  "messageType": "task_request",
  "contractId": "...",
  "content": "...",
  "priority": "normal",
  "requiresAck": true
}
```

The runner should not inject these as plain user messages. It should render a structured peer request:

```text
AgentLink request from <peer> on board <board>:
type: task_request
contract: ...
content: ...

Respond by accepting, blocking, asking clarification, or attaching evidence.
```

Smoke test:

- queue typed message;
- resume receiving session;
- verify `agentlink.message.applied` event;
- verify acknowledgement is written.

### Phase 3: Web UI Board

Add UI panel:

- peers;
- board;
- contracts;
- messages;
- evidence;
- blockers.

Reuse event rendering and artifact preview patterns.

Smoke test:

- mock web server creates board;
- send message;
- list message;
- attach artifact;
- verify UI/API payload.

### Phase 4: SCS Integration

Add AgentLink evidence categories to SCS:

```text
peer_status
peer_evidence
contract_status
ownership_boundary
blocker_from_peer
```

SCS should reject final answers that claim peer work is done without evidence.

Smoke test:

- peer says done with no artifact -> reject;
- peer attaches event/artifact evidence -> approve;
- peer reports permission blocker with evidence -> allow blocker finish.

### Phase 5: Manual Remote Peers

Support remote peer import/export:

```bash
aginti link export-peer --session <id>
aginti link import-peer peer.json
aginti link send --transport ssh-file ...
```

Keep this manual first. Do not start network relays by default.

### Phase 6: Team Relay

Only after local AgentLink is stable:

- authenticated relay;
- pair codes/invites;
- ACLs;
- encrypted transport;
- no raw logs;
- board/message sync only.

Do not overload SkillMesh relay for realtime collaboration unless the relay contract is explicitly extended and separated.

## Proposed Event Types

```text
agentlink.identity.created
agentlink.peer.discovered
agentlink.peer.registered
agentlink.board.created
agentlink.board.joined
agentlink.board.left
agentlink.contract.proposed
agentlink.contract.accepted
agentlink.contract.rejected
agentlink.message.sent
agentlink.message.received
agentlink.message.applied
agentlink.message.acknowledged
agentlink.task.claimed
agentlink.task.blocked
agentlink.task.completed
agentlink.evidence.attached
agentlink.evidence.verified
agentlink.evidence.rejected
agentlink.summary.created
agentlink.private_mirror.created
agentlink.permission.required
agentlink.permission.denied
```

These should be normal session events and board events.

## Suggested API

Local web API:

```text
GET    /api/agentlink/status
GET    /api/agentlink/peers
GET    /api/agentlink/boards
POST   /api/agentlink/boards
GET    /api/agentlink/boards/:boardId
POST   /api/agentlink/boards/:boardId/messages
POST   /api/agentlink/boards/:boardId/contracts
PATCH  /api/agentlink/boards/:boardId/contracts/:contractId
POST   /api/agentlink/boards/:boardId/evidence
POST   /api/agentlink/sessions/:sessionId/summarize
```

These are local APIs only. Remote networking needs a separate trust design.

## Integration With Skills

AgentLink should not eliminate skills.

Recommended pattern:

```text
Core AgentLink: identity, boards, messages, evidence, policy.
Skill `aginti-agentlink`: workflow guidance and examples.
Project-local skill: lab/domain defaults and known peers.
```

For example:

```text
kv260-windows-arduino skill:
  describes hostnames, ports, COM ports, event camera constraints.

AgentLink core:
  links the actual Windows and KV260 sessions, routes typed requests, records evidence.
```

## Integration With AAPS

AAPS should be able to use AgentLink later, but AgentLink must not own AAPS semantics.

Possible future:

```text
AAPS workflow declares agent roles.
AgInTiFlow creates AgentLink board.
Each role maps to one AgInTi session or backend adapter.
Outputs are validated by AAPS declared outputs.
AgentLink only coordinates sessions and evidence.
```

Rule:

Backend switching or peer linking must not mutate selected AAPS project, workflow, program, block, or file unless AAPS explicitly requests it.

## Failure Modes And Mitigations

### Mutual Waiting

Risk:

Two sessions wait for each other forever.

Mitigation:

- task leases;
- timeouts;
- explicit owner;
- board-level blocker detection.

### Duplicate Work

Risk:

Two sessions claim the same task.

Mitigation:

- task claim with compare-and-set semantics;
- task owner field;
- stale lease expiry.

### Context Flood

Risk:

Sessions paste whole histories into each other.

Mitigation:

- fixed summary schema;
- preview limits;
- artifact links instead of full dumps;
- private mirror rules.

### Permission Bypass

Risk:

One session uses another session to run commands it could not run.

Mitigation:

- receiving session evaluates local policy;
- cross-session action cannot bypass permission mode;
- mutating actions require contract;
- dangerous actions require local user approval.

### False Completion

Risk:

Supervisor trusts peer prose.

Mitigation:

- evidence bundles required;
- SCS peer evidence category;
- host-side/file/API verification where possible.

### Stale Peer State

Risk:

A session appears available but is actually idle, stopped, or in another cwd.

Mitigation:

- last-seen timestamp;
- heartbeat/status probe;
- session index verification;
- require fresh status before executing a contract.

### Privacy Leak

Risk:

Raw session history, paths, API keys, or artifacts leak to another peer.

Mitigation:

- raw history never shared by default;
- redacted summaries;
- ignored private mirrors;
- no network sync by default;
- trust levels and ACLs.

## Validation Plan

When implementation begins, add tests before broad UI work.

### Unit Tests

- identity creation;
- board creation;
- peer discovery from session index;
- message append/list/ack;
- contract create/update;
- evidence attach/list;
- raw summary redaction;
- unsafe peer id rejection.

### Smoke Tests

Recommended scripts:

```text
scripts/smoke-agentlink-storage.js
scripts/smoke-agentlink-inbox.js
scripts/smoke-agentlink-web-api.js
scripts/smoke-agentlink-scs.js
```

### Integration Scenarios

1. Two mock sessions coordinate a file-producing task.
2. One session asks another for status while it is running.
3. Peer reports a blocker; supervisor final answer reports blocker with evidence.
4. Peer claims done without evidence; SCS rejects.
5. Web UI sends AgentLink message; CLI receives and applies.
6. Raw mirror created under ignored private folder; check it is not tracked.

## Default Product Recommendation

Make AgentLink default in the same way session storage is default:

- always maintain local identity and session discoverability;
- show collaboration affordances only when useful;
- never start network sharing automatically;
- never share raw logs automatically;
- make typed peer requests easy;
- make evidence and ownership visible.

Best default UI phrase:

```text
Collaborate with another AgInTi session
```

Best technical feature name:

```text
AgInTi AgentLink
```

Best default mode:

```text
AgentLink local mode
```

## Recommended Next Action

Implement Phase 1 and Phase 2 first:

1. `src/agentlink.js` for local identity, boards, peers, contracts, messages, and evidence.
2. CLI `aginti link status|peers|boards|create|send`.
3. Extend inbox metadata for `kind: "agentlink"` messages.
4. Add smoke tests for local two-session coordination.
5. Only then add the web panel.

Do not begin with remote networking. The product needs typed local collaboration first.
