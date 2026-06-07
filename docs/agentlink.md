# AgInTi AgentLink

AgentLink is AgInTiFlow's local-first collaboration layer for multiple AgInTi sessions.

It lets sessions coordinate through durable boards, typed messages, action contracts, safe session summaries, and evidence bundles. It does not let one session silently run tools inside another session.

## Defaults

```text
local same-account session discovery: on
manual board creation: on
session inbox delivery: explicit
network peer discovery: off
raw session sharing: off
```

This keeps AgentLink useful by default without turning AgInTi into an uncontrolled swarm.

## CLI

```bash
aginti agentlink status
aginti agentlink peers
aginti agentlink boards
aginti agentlink create "Experiment board" --objective "Coordinate capture and analysis"
aginti agentlink board default
aginti agentlink send default <session-id> "Please report current status with evidence."
aginti agentlink claim default "Record event-camera sample" --owner-session <session-id>
aginti agentlink evidence default "Output file exists and hash verified" --path results/manifest.json
aginti agentlink summary <session-id>
```

Aliases:

```bash
aginti link status
aginti agents peers
```

Interactive CLI:

```text
/link
/link peers
/link board default
```

## Web API

```text
GET  /api/agentlink/status
GET  /api/agentlink/peers
GET  /api/agentlink/boards
POST /api/agentlink/boards
GET  /api/agentlink/boards/:boardId
POST /api/agentlink/boards/:boardId/messages
POST /api/agentlink/boards/:boardId/contracts
POST /api/agentlink/boards/:boardId/evidence
GET  /api/agentlink/sessions/:sessionId/summary
```

## Model Tools

AgInTi sessions can use:

- `agentlink_status`
- `agentlink_list_peers`
- `agentlink_create_board`
- `agentlink_get_board`
- `agentlink_send_message`
- `agentlink_claim_task`
- `agentlink_attach_evidence`
- `agentlink_summarize_session`

These tools are deterministic local runtime tools. They are not external MCP tools and they do not grant remote execution rights.

## Storage

AgentLink stores account-local state under:

```text
~/.agintiflow/agentlink/
  identity.json
  peers.json
  boards/
    <board-id>/
      board.json
      messages.jsonl
      events.jsonl
      evidence.jsonl
      contracts/
```

Session inbox delivery uses the existing session store:

```text
~/.agintiflow/sessions/<session-id>/inbox.jsonl
```

## Evidence Rule

AgentLink messages are not proof. A completion claim should cite concrete evidence such as:

- file path;
- command output;
- artifact id;
- screenshot path;
- report path;
- log path;
- checksum;
- session summary with recent event types.

Use `agentlink_attach_evidence` to persist that evidence on the board.
