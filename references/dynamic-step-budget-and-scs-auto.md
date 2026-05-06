# Dynamic Step Budget And SCS Auto Routing

This note documents the implemented design for dynamic `maxSteps` extension and SCS auto routing.

## Current State

AgInTiFlow treats `maxSteps` as the initial run budget for real-provider work. The runtime can extend that budget near the boundary when recent evidence shows concrete progress.

Relevant paths:

- `src/cli.js`: parses `--max-steps`, `--dynamic-steps`, and budget tuning flags.
- `src/config.js`: resolves `config.maxSteps`, `config.dynamicSteps`, and extension caps.
- `src/engineering-guidance.js`: recommends profile-aware initial step budgets.
- `src/agent-runner.js`: uses a mutable budget loop and emits `budget.*` events.
- `src/step-budget-controller.js`: owns deterministic progress/blocker checks, caps, serialization, and extension application.
- `src/scs-controller.js`: supports `off`, `on`, `auto`, and the SCS student step-budget gate.

SCS auto is supported:

- CLI: `--scs auto`.
- Interactive: `/scs auto`.
- Config: `enableScs: "auto"`.
- Router policy: `shouldActivateScs("auto", { goal, taskProfile, complexityScore })`.
- Active model policy: when SCS is active, committee/student/supervisor use the main model.

## Goal

Avoid both failure modes:

- Stopping at `maxSteps` while the agent is making good, verifiable progress.
- Letting a stuck or drifting agent run forever.

The design is not unlimited steps. It is a bounded step-extension application reviewed by a monitor.

## Implemented Concept

At a budget boundary, the runtime asks:

```text
Should this run receive more steps?
```

The monitor can approve an extension only when:

- the run is near the current budget limit;
- recent steps show concrete tool, file, or artifact progress;
- the requested extra steps fit under a hard cap;
- no repeated failure loop is active;
- no permission, install, secret, host, or destructive-action blocker is being bypassed.

## Modes

### Normal Mode

Normal mode uses a deterministic runtime budget gate.

It is deliberately cheap:

- no extra model call;
- no free-form debate;
- one extension by default;
- extension size is normally `+6` to `+12`;
- hard cap is normally about `2x` the initial budget.

### SCS On Mode

When `/scs on` is active, the deterministic runtime gate first checks that progress exists and no blocker loop is active. Then the SCS student budget gate can emit:

```json
{
  "role": "student",
  "decision": "extend_steps | deny_extension | rethink_plan",
  "confidence": 0.82,
  "extra_steps": 8,
  "evidence": ["file changed", "artifact exists"],
  "reason": "Progress is concrete; one focused verification pass remains.",
  "next_required_action": "supervisor_continue"
}
```

SCS mode allows a slightly larger budget because the student gate is stricter:

- up to two extensions by default;
- extension size is normally `+8` to `+16`;
- hard cap is normally about `2.5x` the initial budget.

### SCS Auto Mode

`/scs auto` means the router may activate SCS for a specific turn. Signals include:

- high smart-routing complexity score;
- high-friction profiles such as Android, app, code, large-codebase, GitHub, maintenance, QA, research, review, security, supervision, or website;
- prompt language such as debug, failing, migration, emulator, deploy, PDF, refactor, monitor, or long-running.

If SCS auto activates, dynamic step extension uses the SCS student gate. If SCS auto does not activate, dynamic step extension uses the normal deterministic gate.

## Extension Evidence

The deterministic gate reads compact evidence only:

- user goal and current plan;
- initial and current step budgets;
- recent tool results;
- recent `tool.completed`, `file.changed`, and artifact events;
- repeated blocked/failed tool evidence;
- persisted budget state.

It does not include secrets. Tool and event payloads are redacted before persistence.

## Decision Criteria

Approve extension when:

- files or artifacts were created and need verification;
- a command/check produced useful output;
- a patch or workflow is mid-flight and the next step is bounded;
- the task is close to completion and one focused pass remains.

Deny extension when:

- the same command or tool failed repeatedly;
- a permission blocker requires user approval;
- host install, destructive action, publish, or outside-workspace access is blocked;
- no recent concrete progress exists;
- the hard cap or extension count is reached.

Request rethink in SCS when:

- progress exists but the current plan is stale;
- a failure class changed;
- the next phase must be smaller or safer.

## Runtime Events

Implemented compact events:

- `budget.initialized`
- `budget.near_limit`
- `budget.extension_requested`
- `budget.extension_approved`
- `budget.extension_denied`
- `scs.student.extend_steps`
- `scs.student.deny_extension`
- `scs.student.rethink_plan`

Typical event payload:

```json
{
  "initialMaxSteps": 24,
  "currentMaxSteps": 32,
  "stepsCompleted": 23,
  "extraSteps": 8,
  "approvedExtraSteps": 8,
  "extensionsUsed": 1,
  "hardCap": 60,
  "reason": "Recent verified tool progress exists."
}
```

## User-Facing Output

Normal mode:

```text
budget: monitor approved +8 steps (23/32); Recent verified tool progress exists
```

Denied:

```text
budget: extension denied; Recent blocker requires a different permission/setup path
```

SCS:

```text
SCS: student approved +8 steps (23/32); one focused verification pass remains
```

## Config

CLI:

```bash
aginti --max-steps 24 --dynamic-steps auto "..."
aginti --dynamic-steps off "..."
aginti --dynamic-steps on --provider mock "..."
aginti --dynamic-step-limit 2 "..."
aginti --dynamic-step-size 10 "..."
aginti --dynamic-step-hard-cap 72 "..."
aginti --scs auto "..."
```

Environment:

```text
AGINTI_DYNAMIC_STEPS=off|auto|on
AGINTI_STEP_EXTENSION_LIMIT=2
AGINTI_STEP_EXTENSION_SIZE=10
AGINTI_STEP_EXTENSION_HARD_CAP=72
```

Defaults:

- `dynamicSteps=auto`.
- Real-provider runs can auto-extend when evidence justifies it.
- Mock runs do not auto-extend unless explicitly run with `--dynamic-steps on`.

## Interaction With `/scs auto`

Routing semantics:

- `/scs off`: never use SCS; dynamic budget uses normal deterministic monitoring if enabled.
- `/scs on`: always use SCS; dynamic budget uses the student budget gate.
- `/scs auto`: router decides per run; if activated, dynamic budget uses the student gate.

For observability, state preserves:

- configured mode: `enableScs = "auto"`;
- actual run activation: `scsActive = true|false`;
- budget state: `state.meta.stepBudget`.

## Guardrail

A step extension is not permission escalation.

If the run lacks permission to write outside the project, install host packages, publish, use credentials, read secrets, or run destructive commands, more steps should not help. The monitor denies extension and the normal permission advice/rerun path remains authoritative.

## Regression Coverage

`scripts/smoke-dynamic-step-budget.js` checks:

- dynamic mode normalization;
- `/scs auto` activation for complex prompts and non-activation for trivial prompts;
- deterministic approval when recent file/tool progress exists;
- denial for repeated permission/blocker loops;
- mock-provider auto disablement;
- a real runner smoke where a one-step mock run creates a file, earns a bounded extension, finishes, and persists `budget.extension_approved`.

This keeps AgInTiFlow persistent without making it unbounded.
