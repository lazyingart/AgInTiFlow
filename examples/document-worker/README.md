# Workstation document worker example

This example is deployment input, not an installed service. It deliberately
starts in the read/delete rollback floor with `creation.enabled=false`.
Readiness, staged-receipt commit, content reads, and two-phase delete remain
available; only new compile requests return `WORKER_CREATION_DISABLED` (503).

The fixed application listener is `127.0.0.1:18102`. LazyEdge is the only
intended caller and injects the distinct upstream application bearer. Store the
same bare upstream capability in a protected LazyEdge worker binding file and
in the root-owned, mode `0400`, non-symlink systemd credential source:

`/etc/agintiflow/credentials/document-worker-upstream-token`

The service receives it only through systemd at:

`/run/credentials/aginti-document-worker.service/document-worker-upstream-token`

Do not put that value in the JSON config, an environment variable, an argument,
logs, documentation, or Git. The dedicated `aginti-document-worker` user/group,
release symlink, config, and credential must be created by a reviewed deployment
step; this example does not create them.

The unit never uses the workstation's `/usr/bin/node` (currently Node 18 and
below the package's Node 22 floor). It pins the workstation's versioned Node
22.21.0 path recorded in `runtime-manifest.json`. `ProtectHome=tmpfs` hides the
rest of the home hierarchy while `BindReadOnlyPaths` exposes that one verified
executable read-only inside the unit. Before enable, deployment must verify the
version, SHA-256, ownership, and mode, then run both the CLI check and real
bwrap/latexmk/qpdf activation canary under the installed unit.
`ExecStartPre` repeats the owner/mode/size/hash check on every start using the
root-owned system Node without reading credentials. The Node 22 worker repeats
the check after exec and fails unless it is non-root, `/home/lachlan` contains
only the bind-created path to that Node binary, and `/proc/self/mountinfo`
proves the exact binary bind is read-only. Thus a later automatic restart does
not trust deployment-time evidence alone.
The exact installed candidate unit must complete `aginti-document-worker check`
successfully before LazyEdge route activation, AgInTi broker activation, or Web
exposure is allowed; static unit verification is not a substitute for that
namespace and compiler activation proof.

LazyEdge permits two concurrent requests and the worker admits at most two
compiler processes; at most four additional compiles remain in a bounded
in-process queue and excess admission fails retryably.
The private ledger also enforces fixed group/directory bounds, per-source and
per-PDF limits, and an 8 GiB aggregate live-object ceiling; quota exhaustion
does not disable existing reads or two-phase deletion.
Each compiler process has a 30-second wall limit. The 120-second private-route
timeout is intentionally longer so queueing, forced cleanup, and a structured
failure response retain transport headroom.

The TeX compiler uses bubblewrap namespaces. Therefore the unit intentionally
does not use `RestrictNamespaces=true`; it denies only time namespaces. Every
candidate unit must run the real bwrap/latexmk/qpdf activation canary under the
installed unit before creation is enabled. A hash-only executable check is not
an activation proof.
