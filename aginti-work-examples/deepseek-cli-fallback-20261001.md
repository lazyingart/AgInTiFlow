# DeepSeek CLI fallback acceptance — 2026-10-01

## Scope

Improve everyday CLI work without a Codex wrapper: inspect files, create a
summary, repair a small project, run real tests, and continue the same session.
AgInTi performed all target-workspace edits through DeepSeek. The supervising
agent changed AgInTi itself, supplied synthetic fixtures and ordinary requests,
and independently checked outputs. No user's project was used as a test fixture.

The installed baseline was `0.20.331`. Development started from `486c56c`, which
already contained the undeployed request-lifecycle and read-only-input fixes on
top of integration `bf9c3e0`. The new release is `0.20.337-integration.0`, an opt-in
integration release rather than a promotion of the npm `latest` channel.

## Failures were reproduced, not inferred

| Observation | Evidence | Repair or conclusion |
| --- | --- | --- |
| Baseline summary request temporarily changed `risks.txt` | Live Flash tool events showed an unwanted patch, a compensating restoration, and then the output; 8 model turns / 14 seconds | Deploy the existing source/output contract repair. The same request took 4 turns / 6 seconds and never edited either source. Timings are individual observations, not a benchmark. |
| Fast/manual selection silently ran Main | Offline config reproduced Flash becoming Pro, and an explicit DeepSeek manual model becoming a separately configured OpenAI main model | Keep the selected executor while retaining SCS planning and completion validation. |
| Could enable wrappers but could not explicitly disable them on resume | `--no-wrappers` was rejected; a stored true value had no matching negative CLI patch | Add symmetric parsing and durable resume support, including an ambient-true regression. |
| Retry could outlive its deadline | Earlier deterministic reproduction and eight lifecycle regressions | Include the previous cancellation/deadline repair; do not claim provider token generation became faster. |
| Final read-only discovery stopped an otherwise fixed task | A real `find` pipeline omitted `-maxdepth`; the CLI paused asking for broad host permission | Keep the command blocked but classify it as recoverable discovery. Preserve denial through pipelines/sequences. The same session continued and completed with unchanged permissions. |
| Optional inline JavaScript stopped a second restricted-host run | A compound `npm test; node -e ...` command was not admitted | Keep that host restriction. Describe host tool limits to the model and recommend Normal Docker workspace for general coding. Do not expand arbitrary host execution just to make a test pass. |
| The prompt itself encouraged unrelated cache searches | Engineering guidance suggested unbounded Python-cache discovery irrespective of stack | Use relevant-stack, bounded inspection and scoped claims; no unrelated cleanup requirement. |

The first Pro code fix passed its supplied tests, but an independent `10.075`
rounding example failed. A normal follow-up in the same session produced a
decimal-string repair and a new regression, passing the independent check. This
is useful evidence of resumability, and also a reminder that passing supplied
tests alone does not establish complete correctness. No money-specific patch was
added to AgInTi core.

## Verification

- Full existing `npm test`: passed, with live provider-attribution probing off.
  Existing occupied-port skips in document-worker checks remain skips, not passes
  for those external services.
- Eight request-lifecycle regressions passed.
- Five new CLI routing/wrapper/discovery tests passed; the routing and discovery
  reproductions failed before their repairs.
- Coding-tool policy, model-role, syntax, and CLI checks cover the changed paths.
- A denied discovery command is still denied. Mutating find actions, shell
  execution, redirection, and destructive commands are not admitted by the repair.
- Live evaluator: `scripts/eval-deepseek-cli.mjs`. It retains each failed attempt
  rather than overwriting it with a later pass. Its default follows the shipped
  Normal Docker workspace; `AGINTIFLOW_EVAL_SANDBOX=host` exercises restricted host
  behavior. A failed case exits nonzero.

Synthetic prompts, model results, events, independent test logs, and original
input hashes remain in a private acceptance directory. Credentials and raw
session history are not part of this public record or npm package.

The final fresh-workspace run passed all three cases with the Flash executor:

| Case | Model turns | Wall time | Independent result |
| --- | ---: | ---: | --- |
| Read two sources and write a summary | 5 | 9.1 s | Both sources unchanged; summary names both sources |
| Repair invoice utility and add regression coverage | 15 | 107.7 s | Project tests and 22 external oracle assertions passed |
| Resume for Chinese README instructions | 7 more | 17.3 s | Same session, next goal revision, implementation/tests byte-identical; tests and oracle still passed |

This is one successful run after the documented failures, not a success-rate or
speed claim. Model calls, planning, validation, and tool use all contribute to
wall time. No external Codex/Claude/Gemini agent wrapper was called. The existing
Docker image was reused; no GPU model, GUI desktop, or dependency rebuild was
needed. The test-created containers exited after each command.

The packaged CLI was then installed globally and tested again in a separate fresh
workspace, using the installed entry point rather than the source checkout. All
three cases passed again: summary in 6.8 seconds / 4 turns, code repair in 37.1
seconds / 5 turns, and Chinese follow-up in 16.7 seconds / 4 additional turns.
The same independent checks passed, including all 22 oracle assertions and
unchanged input/code/test bytes where required. The installed package also passed
the 13 focused lifecycle and CLI-policy regressions. These timings describe that
individual run and are not a throughput guarantee.

## Usage

See [DeepSeek CLI fallback](../docs/deepseek-cli-fallback.md) for start/resume,
permissions, model selection, and reproducible checks. No task is automatically
moved out of Codex when quota expires, and no Codex history is rewritten.
