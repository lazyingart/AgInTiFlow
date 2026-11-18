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

## Return a plan to the calling application

A planner often needs to mention actions such as correcting a file or publishing a job. If its task is to interpret the request and return a proposal, the host can select the `plan-response` evidence scope. This dispatches a response-only model turn with no execution tools. The application owns the observed job state and decides whether to enqueue an action.

Build stdin from a fixed host policy, serialized input data and a final host-owned scope line. For example, a queue assistant could use this Python function:

```python
import json


def planning_prompt(message, observed_phase):
    if not isinstance(message, str) or not 0 < len(message.strip()) <= 4000:
        raise ValueError("Invalid message")
    if observed_phase not in ("queued", "running", "completed", "unknown"):
        raise ValueError("Invalid observed phase")

    policy = (
        'Return a JSON object with exactly "decision" and "message". '
        'Use decision "reply" for status questions, or "prepare" to propose a job. '
        'Answer status questions from observedPhase. If unknown, say so. '
        'Only the application can enqueue work or confirm completion.'
    )
    data = json.dumps({"message": message, "observedPhase": observed_phase},
                      ensure_ascii=True, allow_nan=False)
    scope = json.dumps({"mode": "plan-response",
                        "request": "Interpret the supplied data and return the JSON proposal."})
    return policy + "\nInput data:\n" + data + "\nAGINTI_EVIDENCE_SCOPE_JSON: " + scope
```

Pass the result on stdin. The following invocation selects DeepSeek Flash explicitly:

```sh
aginti run --stdin --json --no-auto-update --task-profile chatops --no-scs -s safe \
  --sandbox-mode host --no-shell --no-file-tools --no-web-search --no-mcp \
  --no-parallel-scouts --no-auxiliary-tools --max-steps 2 --dynamic-steps off \
  --routing manual --provider deepseek --model deepseek-v4-flash
```

Run the process in the application's isolated environment with a private working directory and home, an approved provider credential, a deadline and bounded output. Keep wrapper tools disabled with `ALLOW_WRAPPER_TOOLS=false`. For structured output, first check the exit code and outer machine result. Then decode `result` as JSON and validate its exact fields, types, allowed values and consistency with current application state. A `prepare` proposal still needs the caller's normal authorization and queue submission.

Supply the scope on each proposal turn, including a resumed turn. A subsequent execution turn can use tools allowed by the saved session policy. Bind each session to the authenticated account in the application before resuming it.

The standalone CLI preference applies to new interactive sessions. For machine calls, select the provider in the host. To pin a model, pass `--routing manual` together with `--provider` and `--model`. A provider override on `resume` becomes the session's saved provider. If a user chooses OpenAI for just one turn, pass the application's usual provider and model explicitly on the next turn. Keeping both API keys available gives the host a choice of providers.

File creation, command execution and research that needs fresh sources require an execution turn with appropriate tools and evidence. For an embedded schema-checked loop with application-owned read callbacks, see the [Restricted Application SDK](restricted-application.md).
