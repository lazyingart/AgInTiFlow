# DeepSeek Artifact Completion and Host Integration

Machine hosts should invoke both new and resumed AgInTi turns with
`--no-wrappers` when AgInTi is the fallback for an unavailable external agent.
Keep the provider explicit; credentials do not authorize a provider switch.
Use the host's existing routines rather than rewriting them in the agent loop.

## Source Changes Are Not Artifact Changes

A task that reads inputs and writes a separate summary must not be pushed into
editing those inputs. A task that creates or updates artifacts inside an exact
host-provided root must not be pushed into changing the generator's source.
Private task files deliberately do not increment the project-source revision.

Execution and completion now share bounded artifact-root resolution. A real
current-turn scoped write can satisfy artifact freshness without an unrelated
project edit. Its saved timestamp must follow the current execution contract;
old mutations, no-op patches, and workspace-wide roots do not qualify for this
exemption. Explicit input repairs still require their requested changes.
File, command, requested-format, source-grounding, and quality evidence gates
remain active. In particular, a pre-existing PDF cannot satisfy a request to
materially revise and rebuild it.

Postfix input declarations such as `requirements.txt is a read-only input`
are recognized without accidentally excluding a neighboring output path.

## Source-Free Answers

Refusing to invent a forecast is not a forecast. Chinese and English negated
forecast clauses are stripped before assessing whether an answer needs source
evidence. A real prediction later in the same sentence remains evidence-gated.

## Validation

Run the evidence-visibility, truthful-completion, and scoped-artifact-research
smokes, then the full `npm test`. The LabCanvas host adds separate mocked
timeout/session/concurrency tests and opt-in live DeepSeek acceptance:

```bash
python scripts/evaluate_aginti_fallback.py --live --command /path/to/bin/aginti-cli.js
```

The host test uses synthetic inputs, isolated session registries, actual routine
commands, a compiled Chinese memo PDF, and resumed turns. It prohibits external
chat sends, public publication, and external agent wrappers. Saved inputs and
attempted tool writes are checked independently of the model's final answer.

This is acceptance for simple host tasks, not a claim that DeepSeek matches
Codex across all tasks. Keep model/provider limitations separate from agent-loop
or host-integration failures.
