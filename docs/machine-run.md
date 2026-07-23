# Machine Run Interface

Use `aginti run` when another local application needs one AgInTiFlow turn without interactive CLI output.

```bash
printf '%s\n' 'Summarize this evidence.' |
  aginti run --stdin --json --task-profile chatops --no-scs -s safe
```

`--json` writes exactly one JSON object to stdout:

```json
{"ok":true,"sessionId":"...","result":"...","stopped":false,"failed":false,"reason":""}
```

Runtime headers, plans, tool logs, and sandbox diagnostics are suppressed. A missing key, timeout, empty result, or stopped run returns `ok: false` and a nonzero exit code. Callers must forward only `result`, never stderr or the full runtime state.

The `chatops` profile treats the current request as the sole source of authority. It avoids unrelated workspace artifacts and does not use tools for simple conversation. Use `-s safe` for read-only routing and research. Use `-s normal` with the default Docker workspace only when the request needs current-project artifacts. Do not use `-s danger` for unattended chat transports.
