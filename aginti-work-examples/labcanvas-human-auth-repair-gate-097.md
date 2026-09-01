# LabCanvas Human-Authentication Repair Gate 097

Date: 2026-09-02 (Asia/Hong_Kong)

## User-Level Failure

The LabCanvas transport health guard correctly detected two degraded states,
but treated both as ordinary repairable software faults:

- the personal WeChat client was waiting at its QR login screen;
- the connected MIX 2S was reachable through the relay but had not authorized
  the existing ADB host key.

That started an AgInTi repair session which repeatedly attempted to repair
human authentication and periodically restarted a healthy Android relay.

## Boundary Repair

LabCanvas commit `94396e4` keeps both blockers visible in health output while
excluding them from deterministic relay restarts and repair-agent assignment.
The same patch also reuses the canonical `labcanvas-web` tmux session instead
of silently creating `labcanvas-web-wechat` on a fallback port.

The repaired policy is:

1. Software faults remain eligible for bounded deterministic repair and then
   AgInTi diagnosis.
2. QR login, ADB authorization, confirmation dialogs, keyguard, and active
   authentication remain explicit human-action gates.
3. Human-action gates do not consume model steps, restart healthy transports,
   bypass authentication, or disappear from health evidence.

## Verification

- 324 focused LabCanvas transport, schedule, WeCom, and worker tests passed.
- The complete 98-check WeChat self-test suite passed before the final patch.
- GitHub Actions run `33559160242` passed.
- Live `output/transport-health/latest.json` retained
  `wechat_login_required` and `android_poll_stalled`, with both `repairs` and
  `repair_agent` null.
- No repair-agent process remained after the exact health-window reload.
- Only `labcanvas-web` remained active on port `19474`; the duplicate fallback
  web session and port were removed.

## General Lesson

Agentic self-repair needs a capability boundary, not merely more retries.
Observable external authorization is state, not a software defect. Preserving
that distinction makes AgInTi faster and safer while keeping operators fully
informed about the actual blocker.
