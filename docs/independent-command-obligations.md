# Independent command obligations

A request such as “Run `node --version`. Separately run `python3 --version`
and report both results” contains two actions. “Also”, “additionally” and
“independently” do not make the following action optional. The native task
contract retains each supported exact command and requires its own observed
outcome before completion. English politeness prefixes and bounded Chinese
additive forms can compose with these requests. Explanations, quotations,
conditional questions and explicit exclusions do not acquire command authority.
“If needed, also run…” stays conditional. A separate unconditional action after
a semicolon remains required; “even if it fails, also run…” is unconditional.

This interpretation does not grant shell permission or change command policy,
workspace scopes, provider selection or installation rules. Commands still
need the configured authority. Existing canonical command syntax and size/count
bounds remain in force; this is not an unrestricted natural-language parser.

Paused sessions refresh an older inferred command contract from the saved
user request. Existing execution epochs, successful receipts and mutation
boundaries remain intact. The runtime records
`execution.command_intent_contract_refreshed`; an SCS-only refresh records
`scs.command_intent_contract_refreshed`. Existing input/output/copy/empty-output
refresh events retain priority and meaning.
For a lineage-bound user contract, obsolete inferred optional commands can be
removed from its caches. Independently declared project requirements and
unknown legacy authority remain conservative; stored execution evidence is
retained even when a command is no longer mandatory.

A generic same-task continuation can advance the goal revision while retaining
the execution epoch. Proven read-only diagnostics in that epoch share their
required-command batch, including closed failed outcomes. A later successful
check must not falsely make an earlier observed check pending and request its
repeat. The existing lineage, private/source-mutation and native-receipt checks
still apply; unrelated goals and unproven history gain no batch authority.

An older task may already have been marked complete without evidence for an
additional command. A generic continuation must not blindly repeat possible
external effects. If the upgraded contract finds an originally requested
command without sufficient retained evidence, the runtime pauses with
`completion_contract_review_required`. It preserves prior results and asks for
an explicit execution or verification request. Repeating “continue” keeps the
review blocker without a provider or tool call. An explicit new request can
authorize the next bounded action. A completed task with sufficient receipts
continues to return its saved result without repeating tools.
