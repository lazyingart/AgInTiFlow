# Dynamic Step Budget And SCS Auto Routing

This note documents a proposed design for dynamic `maxSteps` extension and SCS auto routing.

## Current State

AgInTiFlow currently sets a fixed `maxSteps` before a run starts.

Relevant paths:

- `src/cli.js`: parses `--max-steps` and profile shortcuts.
- `src/config.js`: resolves `config.maxSteps`.
- `src/engineering-guidance.js`: recommends profile-aware step budgets.
- `src/agent-runner.js`: runs `for (let step = state.stepsCompleted + 1; step <= config.maxSteps; step += 1)`.
- `src/scs-controller.js`: supports `off`, `on`, and `auto`.

SCS auto is already conceptually supported:

- CLI: `--scs auto`.
- Interactive: `/scs auto`.
- Config: `enableScs: "auto"`.
- Router policy: `shouldActivateScs("auto", { goal, taskProfile, complexityScore })`.
- Active model policy: when SCS is active, committee/student/supervisor use the main model.

The missing design is a principled way to extend the run beyond the initial step budget when progress is real and the remaining work is justified.

## Goal

Avoid both failure modes:

- Stopping at `maxSteps` while the agent is making good, verifiable progress.
- Letting a stuck or drifting agent run forever.

The correct design is not "unlimited steps." It is a bounded step-extension application reviewed by a monitor.

## Proposed Concept

Treat `maxSteps` as the initial budget, not the absolute lifetime.

At a budget boundary, the runtime can ask a monitor:

```text
Should this run receive more steps?
```

The monitor can approve an extension only when:

- the task is not finished;
- recent steps show concrete progress;
- the next phase is specific;
- the requested extra steps are proportional;
- no repeated failure loop is active;
- no permission/policy blocker is being bypassed;
- there is a clear verification target.

## Modes

### Normal Mode

In non-SCS mode, the monitor should be a lightweight runtime budget gate.

It can be implemented as:

- deterministic heuristics first;
- optional model monitor only near the boundary;
- no free-form debate;
- strict JSON decision.

Normal-mode extension should be conservative.

Recommended limits:

- Default initial budget remains profile-based.
- One extension by default.
- Extension size: 25-50 percent of original budget, clamped, for example `+6` to `+12`.
- Hard cap: no more than 2x initial budget unless user explicitly passed a larger `--max-steps` or a future `--max-step-extensions`.

### SCS On Mode

When `/scs on` is active, the student monitor should own extension approval.

The student already reviews:

- plan quality;
- failed/blocked tools;
- periodic progress;
- finish evidence.

At the step boundary, add one decision:

```json
{
  "role": "student",
  "decision": "extend_steps | deny_extension | rethink_plan | finish_rejected",
  "confidence": 0.82,
  "extra_steps": 8,
  "evidence": ["file changed", "test now reaches later failure", "artifact exists"],
  "reason": "Progress is concrete; one focused verification pass remains.",
  "next_required_action": "supervisor_continue"
}
```

SCS mode can allow slightly larger extensions because the student gate is stricter, but it must still have caps.

Recommended limits:

- Up to two monitor-approved extensions.
- Extension size: `+8` to `+16`.
- Hard cap: 2.5x initial budget unless user explicitly asked for long autonomous work.

### SCS Auto Mode

`/scs auto` means the router may activate SCS for a specific turn.

The routing decision should use existing smart-routing signals:

- complexity score;
- task profile;
- tool risk;
- write/shell/GitHub/system requirements;
- prompt language such as "debug", "large", "migration", "Android", "simulator", "deploy", "paper", "PDF", "refactor", "long-running";
- expected artifacts and verification needs.

If SCS auto activates for the turn, dynamic step extension uses the SCS student gate.

If SCS auto does not activate, dynamic step extension uses the normal lightweight gate.

This gives the desired behavior:

- simple tasks stay cheap;
- hard tasks get stronger monitoring and can ask for more steps if justified.

## Extension Evidence Pack

The monitor should not see the whole transcript. It should see a compact evidence pack:

- user goal;
- current plan or SCS phase;
- initial max steps;
- completed steps;
- remaining step count;
- recent 8-12 events;
- recent tool results;
- changed files summary;
- created artifacts;
- repeated failure counters;
- blocked permission/tool results;
- latest assistant intent if available;
- explicit next proposed phase.

Do not include secrets. Use existing redaction helpers.

## Decision Criteria

Approve extension only when at least one of these is true:

- A check moved from one failure to a later or narrower failure.
- Files/artifacts were created and now need verification.
- The agent found the correct owner boundary and is in the middle of a coherent patch.
- A long-running command finished late and its output needs interpretation.
- The task has clear remaining work that fits the requested extension.
- The user explicitly asked for a long task and there is no blocker.

Deny extension when:

- the same command/tool failed repeatedly;
- the agent is trying variants without new evidence;
- a permission blocker requires user approval;
- the plan has drifted from the user goal;
- no files/artifacts/checks changed recently;
- the next proposed action is vague;
- the task should ask the user instead;
- the run is near a hard safety cap.

Request rethink when:

- progress is real but the current plan is stale;
- the failure class changed;
- new evidence invalidates the approved phase;
- a different tool or profile is needed.

## Runtime Events

Add compact events:

- `budget.initialized`
- `budget.near_limit`
- `budget.extension_requested`
- `budget.extension_approved`
- `budget.extension_denied`
- `budget.hard_cap_reached`
- `scs.student.extend_steps`
- `scs.student.deny_extension`

Event payload should include:

```json
{
  "initialMaxSteps": 24,
  "currentMaxSteps": 24,
  "stepsCompleted": 23,
  "requestedExtraSteps": 8,
  "approvedExtraSteps": 8,
  "extensionCount": 1,
  "hardCap": 48,
  "reason": "Focused verification remains after successful patch."
}
```

## User-Facing Output

Keep it compact:

```text
budget: 23/24 steps used; monitor approved +8 steps for verification
```

If denied:

```text
budget: extension denied; repeated blocked install requires user approval
```

If SCS:

```text
SCS: student approved +8 steps; next phase verify patch and report evidence
```

## Suggested Config

Future CLI/env options:

```bash
aginti --max-steps 24 --dynamic-steps auto "..."
aginti --dynamic-steps off "..."
aginti --dynamic-step-hard-cap 72 "..."
aginti --scs auto "..."
```

Possible environment variables:

```text
AGINTI_DYNAMIC_STEPS=off|auto|on
AGINTI_STEP_EXTENSION_LIMIT=2
AGINTI_STEP_EXTENSION_HARD_CAP=72
```

Default recommendation:

- `dynamicSteps=auto`.
- Enabled only for write/tool tasks, not tiny chat answers.
- Disabled for mock smoke tests unless explicitly testing the feature.

## Implementation Sketch

Use a while loop instead of a fixed for-loop:

```js
let hardCap = computeHardCap(config);
while (state.stepsCompleted < config.maxSteps) {
  await runOneStep();

  if (nearBudgetLimit(state, config) && state.stepsCompleted >= config.maxSteps - 1) {
    const decision = await maybeExtendBudget({ client, config, state, store });
    if (decision.approved) {
      config.maxSteps = Math.min(config.maxSteps + decision.extraSteps, hardCap);
      await store.appendEvent("budget.extension_approved", decision);
      continue;
    }
  }
}
```

The extension controller should live outside core tool execution:

- `src/step-budget-controller.js` for normal and shared logic.
- `src/scs-controller.js` can provide the SCS student decision.
- `src/agent-runner.js` calls the controller near the boundary.

## Interaction With `/scs auto`

Recommended routing semantics:

- `/scs off`: never use SCS; dynamic budget uses normal lightweight monitor if enabled.
- `/scs on`: always use SCS; dynamic budget uses student monitor.
- `/scs auto`: route policy decides per run; if activated, dynamic budget uses student monitor.

Auto activation should happen before the run starts and be logged:

```text
scs=auto active=true reason=complexity:large-codebase
```

For observability, state should preserve both:

- configured mode: `enableScs = "auto"`;
- actual run activation: `scsActive = true|false`.

## Important Guardrail

A step extension is not permission escalation.

If the run is blocked because it lacks permission to write outside the project, install host packages, publish, use credentials, or run destructive commands, more steps should not help. The monitor should deny extension and present the approval/rerun path.

## Recommendation

Implement this as a typed budget gate, not as the executor asking itself for more time.

Best first slice:

1. Add budget events and hard caps.
2. Add deterministic normal-mode extension for clear progress.
3. Add SCS student `extend_steps` gate.
4. Add mock tests for approve, deny, hard cap, and permission-block denial.
5. Add one live smoke test where a task reaches the boundary after creating files and gets a small verification extension.

This keeps AgInTiFlow persistent without making it unbounded.
