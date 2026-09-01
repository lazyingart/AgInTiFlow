# LabCanvas Authoritative Structured Summary 099

Date: 2026-09-02 (Asia/Hong_Kong)

## Scenario

LabCanvas asked its default AgInTi backend to run the compact WeChat health
routine exactly once and concisely report queue health, schedule state, and
authentication blockers. The command returned valid structured JSON with exit
code 1 because the system was degraded by two human-action gates. DeepSeek
reported the queues and blockers but omitted the visible schedule section.

An earlier harness attempt used shell backticks inside the prompt argument, so
the parent shell executed the health command before AgInTi received the task.
AgInTi correctly rejected the resulting unsupported action claim with
`model_did_not_execute`. That run is evidence for the action guard, but is not
counted as the live acceptance.

## Runtime Repair

AgInTiFlow `0.20.322` adds a generic completion gate for authoritative
structured read-only routines:

- derive requested sections from the actual user request rather than host
  packet or routine metadata;
- compare every nonempty proposed completion with retained structured evidence;
- reject omitted requested sections and claims that an existing section is
  unavailable;
- offer exactly one finish-only correction without exposing another command or
  tool call;
- use a deterministic verified summary if the correction remains inaccurate;
- preserve the existing empty-response and evidence-validation behavior.

The gate covers queue, schedule, issue/authentication, ingress, and generic
structured fields without adding a LabCanvas-specific response branch.

Source commits:

- `d64df3a` - verify authoritative structured summaries
- `74b3494` - Release v0.20.322

## Live Acceptance

The valid LabCanvas task was `c9b38b01ab14412384c776de1549971f` in
conversation `aginti-live-health-acceptance-20260902-v4`. Its retained AgInTi
session was
`web-agent-labcanvas-99b3d3eb-07ef-49db-8703-ee8548f5e092`.

The event ledger proves:

1. provider `deepseek` and model `deepseek-v4-flash` were used;
2. the exact compact health command started once and completed once;
3. its exit-code-1 JSON was retained as an authoritative status result;
4. the first finish omitted schedules and triggered one finish-only repair;
5. the second finish still omitted and contradicted schedules;
6. the verified fallback reported all requested queues, schedules, and blockers;
7. the session completed after three model requests, with no duplicate command,
   message send, repair, file mutation, service restart, or authentication
   bypass.

The accepted snapshot reported empty personal-WeChat work queues, two pending
and three active WeCom tasks with no stale or failed work, all five visible
schedule states, and the explicit `wechat_login_required` and
`android_poll_stalled` blockers.

## Verification

- Focused truthful-completion and progressive-tool smoke tests passed.
- The full `npm test` suite passed, including 205-file syntax validation.
- Trusted-publish GitHub Actions run `33565477095` passed.
- npm package `@lazyingart/agintiflow@0.20.322` was published and its registry
  integrity verified.
- The installed global CLI reports `aginti --version` as `0.20.322`.

## General Lesson

A capable backend must not turn a provider's incomplete prose into a false
system status. Deterministic routines should own authoritative state, while the
model owns concise interpretation. One bounded correction preserves natural
answers; the verified fallback preserves truth when the provider still fails.
