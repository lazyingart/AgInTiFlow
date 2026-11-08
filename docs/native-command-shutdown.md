# Native POSIX command shutdown

Native host commands use a private Node supervisor as their POSIX process-group
owner. The existing shell executes the command in that group. A private IPC
channel carries lifecycle receipts separately from stdout and stderr; command
output cannot impersonate those receipts. The supervisor imports only Node
built-ins and starts one command per invocation.

For cancellation or timeout, TERM is sent once and KILL follows after 1.2 seconds
if the owner is still held. Cancellation waits for foreground closure and an
observed absent group before the native session lease is released. This includes
commands whose parent exits early while a child redirects its stdio. Signal
delivery and the ChildProcess `killed` flag are not treated as exit evidence.

Unknown shutdown is nonterminal. After the observation window, the optional
native log observer receives `command.shutdown.pending`. Referenced observation
keeps the process and session lease active; no further tool, model request,
automatic retry or provider handoff occurs. Late verified absence can finish the
stop. If the supervisor identity is lost, no later signal targets its reusable
numeric process-group ID. Do not remove the lease to bypass that uncertainty.

Only an explicit normal command exit can authorize an empty grep-style no-match
success. Signals, timeouts and supervisor failures remain failures. A lifecycle
failure after dispatch is recorded as such, with available output retained; it
pauses before another model request. More command permission is not a repair.

Ordinary command completion still reports the shell's result. Intentionally
started background services have their own lifecycle; prefer the existing
background-job or service tools when work must persist.

This is native trusted-host coordination, not an application sandbox or a
durable engine fence. It does not contain processes that escape into a different
session, guarantee recovery after owner/host failure, or qualify remote engines.
The existing Windows foreground path is unchanged and does not gain POSIX
descendant-shutdown qualification. Public application capability gates and
Docker/wrapper execution are unchanged.

Run `npm run test:native-shell-cancellation` for mocked lifecycle adversaries,
real persisted native checker cancellation and passive-observer subprocess
tests. The runtime providers are scripted loopback fixtures. No live model,
credential, GPU, Docker or application service is used by this focused suite.
