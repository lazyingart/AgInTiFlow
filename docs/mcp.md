# AgInTiFlow MCP Bridge

AgInTiFlow supports MCP as a guarded runtime bridge. MCP is separate from Markdown skills: skills add prompt guidance, while MCP servers expose executable tools, resources, and prompts.

## Configuration

AgInTiFlow loads MCP servers from these sources, later sources overriding earlier server IDs:

- Global: `~/.agintiflow/mcp.json`
- Project: `.aginti/mcp.json`
- Extra paths: `AGINTIFLOW_MCP_CONFIG`, separated by the OS path delimiter or commas
- Inline JSON: `AGINTIFLOW_MCP_CONFIG_JSON`
- Inline server map: `AGINTIFLOW_MCP_SERVERS`

Claude-style `mcpServers` and plain `servers` maps are both accepted.

```json
{
  "mcpServers": {
    "filesystem-readonly": {
      "transport": "stdio",
      "command": "node",
      "args": ["./tools/filesystem-mcp.js"],
      "trust": "read-only",
      "readOnly": true,
      "allowedTools": ["list_files", "read_file"]
    },
    "research": {
      "transport": "http",
      "url": "http://127.0.0.1:4321/mcp",
      "trust": "untrusted"
    }
  }
}
```

## CLI And Chat

Inspect MCP status:

```bash
aginti mcp status
aginti mcp config --json
aginti mcp tools filesystem-readonly
aginti mcp resources filesystem-readonly
aginti mcp read filesystem-readonly aginti://example/resource
aginti mcp prompts research
aginti mcp prompt research summarize '{"topic":"protein design"}'
aginti mcp call filesystem-readonly read_file '{"path":"README.md"}'
aginti mcp restart filesystem-readonly
```

Inside the interactive CLI:

```text
/mcp status
/mcp tools filesystem-readonly
/mcp call filesystem-readonly read_file {"path":"README.md"}
/mcp off
/mcp on
```

## Runtime Model Contract

The model sees a fixed bridge toolset:

- `mcp_list_servers`
- `mcp_list_tools`
- `mcp_call_tool`
- `mcp_list_resources`
- `mcp_read_resource`
- `mcp_list_prompts`
- `mcp_get_prompt`

AgInTiFlow intentionally does not dump every remote MCP tool into the model by default. This avoids tool-name collisions, tool poisoning, and unbounded prompt growth. Remote tool descriptions, resources, prompts, and results are always untrusted context and never override system, developer, user, project, or permission instructions.

## Policy

MCP calls pass through AgInTiFlow policy:

- Stdio servers require shell tools to be enabled.
- Stdio server commands are host processes, even when the agent shell sandbox is Docker. AgInTiFlow checks them against host command policy and requires `trust=trusted` or `allowHostProcess=true` when the command is broader than the narrow read-only host allowlist.
- `allowedTools` and `deniedTools` are enforced before a tool call.
- `readOnly` servers block mutating-looking tools unless explicitly trusted.
- Mutating-looking tools require `allowedTools`, `trust=trusted`, `allowAllTools=true`, or a trusted destructive run mode.
- Safe mode blocks reading resources/prompts from `trust=untrusted` servers.
- Secret-like fields in returned data are redacted before logs and model context.

Every MCP operation records normal AgInTiFlow tool events, so sessions remain auditable through CLI logs, web run output, and session event JSONL.

## Web UI

The web UI exposes configured MCP servers in the capability panel and `/api/mcp`:

```bash
curl http://127.0.0.1:3210/api/mcp
curl -X POST http://127.0.0.1:3210/api/mcp \
  -H 'content-type: application/json' \
  -d '{"argv":["tools","filesystem-readonly"]}'
```

Use the MCP toggle in Advanced Settings to disable bridge tools for a run without changing project configuration.

## Current Scope

Implemented now:

- Config loading and redacted public summaries.
- Stdio client lifecycle with lazy startup, request timeouts, stderr capture, and shutdown.
- Streamable HTTP client lifecycle.
- Guarded bridge tools in the model loop.
- CLI `/mcp` and `aginti mcp` commands.
- Web API and status panel.
- Smoke coverage with a real local stdio MCP server.

Not implemented yet:

- OAuth and elicitation UX.
- Dynamic direct tool registration such as `mcp__server__tool`.
- AgInTiFlow acting as an MCP server for external clients.
