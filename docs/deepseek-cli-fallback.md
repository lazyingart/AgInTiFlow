# DeepSeek as a practical CLI fallback

Use AgInTiFlow for small coding, documentation, and workspace tasks when Codex is
unavailable. It runs its own tool loop with DeepSeek API credentials; a Codex
subscription or a working Codex CLI is not required. DeepSeek API usage has its
own billing and availability.

## Start in the project you want to work on

Configure credentials once if needed:

```bash
aginti auth deepseek
```

From the project's terminal:

```bash
aginti --provider deepseek --routing fast --no-wrappers
```

Type an ordinary request, such as “Fix the failing tests and explain the change.”
The default Normal permission mode allows project edits and uses the Docker
workspace. It does not grant unrestricted host access. To use installed host
tools for a small, trusted project while keeping the existing command policy:

```bash
aginti --provider deepseek --routing fast --no-wrappers --sandbox-mode host
```

Host mode is not an OS sandbox. Commands still run as your user. Keep the project
scope narrow; use the Docker workspace when isolation is important. There is no
need to switch to Danger mode merely to read files, make patches, or run ordinary
tests. Arbitrary inline interpreter snippets can still stop in restricted host
mode; the normal Docker workspace is recommended for general coding. New
processes pick up an installed upgrade; no desktop reboot is needed.

One task, followed by a resumable exit:

```bash
aginti run --provider deepseek --routing fast --no-wrappers \
  "Read notes.txt and risks.txt. Write summary.md. Leave the inputs unchanged."
```

Resume from the same project:

```bash
aginti resume
aginti resume latest --no-wrappers
aginti resume SESSION_ID --no-wrappers "Continue and run the tests."
```

AgInTi sessions and Codex sessions are separate. These commands resume AgInTi
history; they do not load a Codex JSONL file. For a quota handoff, leave a short
project note with the current task, files changed, checks already run, and next
step, then ask AgInTi to read it. Do not include account tokens or private keys.

To change a saved AgInTi session explicitly to DeepSeek Flash:

```bash
aginti resume SESSION_ID --provider deepseek --model deepseek-v4-flash \
  --routing manual --route-provider deepseek --route-model deepseek-v4-flash \
  --main-provider deepseek --main-model deepseek-v4-pro \
  --spare-provider deepseek --spare-model deepseek-v4-pro --no-wrappers
```

Ordinary resume preserves saved runtime choices. An ambient environment change
does not silently switch the saved account/provider/model. `--no-wrappers`
explicitly disables Codex/Claude/Gemini-style external agent wrappers, including
when a saved session or environment previously enabled them. It does not disable
all shell commands or all separately configured external tools.

## Model control and limits

- `--routing fast` keeps the fast executor, currently DeepSeek v4 Flash.
- `--routing manual --model MODEL` keeps that executor model.
- `--routing smart` retains automatic task routing and can choose Pro.
- Planning and completion validation remain active when the task requires them.
  Their separately configured model roles may use Pro even with a Flash executor;
  Fast does not mean every auxiliary request uses Flash.
- Default local-first routing is unchanged. The commands above explicitly choose
  DeepSeek, rather than silently switching an existing local session to a cloud API.
- Review the diff and test results. A successful sample is not a promise of Codex
  parity, error-free code, or completion of every task without follow-up.

## Repairs in 0.20.337-integration.0

This integration build includes two earlier, previously undeployed fixes:

1. The model compatibility retry shares the original deadline and cancellation
   boundary. A stuck retry cannot keep AgInTi waiting beyond its deadline or
   turn cancellation into a late success.
2. Reading input files to create a separate output no longer forces mutations
   to those inputs. Positive source-edit requests still require real edits.

It also adds:

3. Fast/manual executor selection is preserved when SCS planning and evidence
   validation activate. Previously these modes could silently run the main model,
   including a separately configured provider.
4. `--no-wrappers` works for a new run and as a persistent resume patch. Explicit
   `--allow-wrappers` can still re-enable them.
5. Syntactically read-only `find` without a depth bound remains **blocked**, but
   returns a recoverable discovery error. The agent can choose structured file
   tools or add a bounded `-maxdepth`, without asking for destructive permission.
   That denial survives pipelines and command sequences. `-delete`, `-exec`,
   file output, unknown shell segments, and other writes remain under the existing
   stronger policies. No permission is silently granted and no denied command runs.

## Reproduce the live acceptance check

This is opt-in, spends DeepSeek credits, and creates a new synthetic workspace.
It does not point the agent at your current project's source files.

```bash
AGINTIFLOW_REAL_DEEPSEEK=1 npm run eval:deepseek-cli
```

Optional: set `AGINTIFLOW_EVAL_ROOT` to a directory for retained private evidence,
or `AGINTIFLOW_EVAL_CLI` to an installed `bin/aginti-cli.js` to verify that package.
The default evaluation location is a fresh temporary directory. The evaluator
uses the default Normal Docker workspace; set `AGINTIFLOW_EVAL_SANDBOX=host` to
test the more restricted host policy instead. That is a distinct acceptance
configuration, and a blocked host run is not counted as a pass.

The evaluator checks a two-source summary, a small code repair with real tests,
and a Chinese README follow-up in the same session. Independent checks compare
input files, run tests again, exercise an external decimal-rounding oracle, verify
unchanged implementation/tests during the documentation follow-up, and inspect
actual model/tool events. Model summaries alone do not establish a pass. A failed
case produces a nonzero exit and a retained report; it is not relabeled successful.

See [the dated acceptance record](../aginti-work-examples/deepseek-cli-fallback-20261001.md)
for measured outcomes, failures encountered, and release/install details.
