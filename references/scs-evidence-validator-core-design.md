# SCS Evidence Validator Core Design

This note records the system-level design direction for AgInTiFlow after
supervising long browser and artifact-generation tasks. The lesson is general:
AgInTiFlow should not trust an executor's finish claim. It should maintain a
task contract, collect evidence, validate that evidence, and only then allow the
run to finish.

## Core Principle

AgInTiFlow should operate as an evidence-gated autonomous system:

1. Understand the requested outcome.
2. Convert it into an explicit task contract.
3. Execute through tools, scripts, browser actions, or model calls.
4. Record structured evidence from every meaningful action.
5. Let an independent validator compare evidence against the contract.
6. If evidence passes, accept finish with proof.
7. If evidence fails, reject finish with reasons and request a committee replan.

The executor may propose completion, but the validator decides whether the
evidence proves completion.

## Task Contract

Before execution, SCS should derive a runtime contract with:

- requested outcome
- required artifacts or external state
- forbidden actions
- success evidence
- stop conditions
- known blockers
- whether external verification is required

This contract should be structured runtime data, not only prompt text. For a
pure explanation, the answer itself may be the artifact. For code, browser,
file, media, publishing, upload, conversion, or long-running tasks, concrete
external evidence is required.

## Evidence Ledger

Every tool action should write useful evidence:

- tool or command name
- target path, page, artifact, or external state
- normalized output
- created or changed files
- screenshots, metadata, logs, or checks
- whether the action was verified
- which contract item it supports

The important question is not "did a tool run?" It is "does this evidence prove
the requested state?"

For example, `set-file-input ok=true` is not enough for an upload task. Valid
evidence might require the active page ID, visible attachment count, file names
in DOM, screenshot path, and confirmation that the page is the user-visible
composer rather than a background CDP tab.

## Validator Gate

The final validator should compare four things:

- task contract
- approved plan
- executor's finish claim
- evidence ledger

It should reject completion when the requested state is missing, skipped,
unverified, stale, contradicted, or only implied by broad tool success.

When rejecting, it should return:

- failed contract items
- evidence it inspected
- why the evidence is insufficient
- the smallest next action or replan request

When accepting, it should return:

- accepted contract items
- concrete proof paths, commands, screenshots, or state snapshots
- remaining caveats, if any

## Runtime Monitor

SCS should monitor during execution, not only at finish. The monitor should
detect:

- loops and repeated failed paths
- stale status or stale artifacts
- wrong target page, folder, branch, or process
- broad browser actions that return whole-page text
- successful commands that do not satisfy the contract
- missing artifacts after claimed generation
- contradictions between tool evidence and summary claims

When the monitor sees a real problem, it should interrupt the current phase and
ask the committee for a new bounded plan. When it sees healthy waiting or slow
progress, it should avoid unnecessary intervention.

## Browser State Reconciliation

Browser automation needs a general state model. It must distinguish:

- active user-visible tab
- background CDP page
- current URL and workflow mode
- DOM state
- screenshot-visible state
- server-side submitted/generated state

A browser task should not accept "DOM changed somewhere" when the user expects a
visible composer state. The verifier should state exactly which page was acted
on and whether that page is likely visible to the user.

This is a core browser automation principle, not a site-specific skill.

## Skills Are Optimization

AgInTiFlow should survive without custom skills. The base runtime should be able
to inspect, plan, execute, observe, validate, and replan using first principles.

Built-in skills can provide common habits. Project-local skills can record
learned workflows. SkillMesh can share proven patterns. But skills should
optimize repeated work, not replace the core evidence loop.

Skill creation should happen when:

- the user explicitly asks AgInTi to learn a method
- the same workflow pattern recurs
- a failure reveals a reusable project-local procedure

It should not distract from completing the immediate task.

## Self-Repair

When AgInTiFlow is stuck, it should classify the blocker:

- bad plan
- missing evidence
- wrong target
- weak script
- missing tool
- provider or quota limit
- permission or credential issue
- external service failure

Then it should choose the narrowest repair:

- collect better evidence
- re-run a verifier
- patch a project script
- switch to a more precise selector or command
- reduce scope for the next phase
- report a real blocker

Self-repair should be controlled by the same contract and evidence gate. The
agent should not keep patching blindly or treating any model confidence as proof.

## Design Target

The target AgInTiFlow loop is:

```text
user goal
  -> task contract
  -> committee phase plan
  -> student plan gate
  -> executor actions
  -> evidence ledger
  -> monitor review
  -> validator finish gate
  -> accept with proof OR reject with replan
```

This loop should apply to browser tasks, code tasks, media tasks, book tasks,
data tasks, system tasks, and long-running pipelines. Domain skills may add
better detectors and validators, but the evidence-gated runtime is the core.

