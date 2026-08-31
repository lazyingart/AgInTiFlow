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
selected release path, config, and credential must be created by a reviewed
deployment step; this example does not create them. Before installing the unit,
deployment must replace `RELEASE_SHA256` with the exact lowercase SHA-256 release
identifier. No mutable `current` entry is permitted beside `releases` and
`runtimes` under `/opt/agintiflow-document-worker`.
The root-only installer creates the mode `0755` `releases` child and performs
each no-replace release rename inside that child; the application root itself
can remain frozen at mode `0555` throughout staging.

The unit never executes the workstation's `/usr/bin/node` or a user-owned Node
path. A reviewed root bootstrap first verifies the versioned Node 22.21.0
source, then installs the exact binary at the immutable `/opt` path recorded in
`runtime-manifest.json`. The binary and its four application runtime
directories are all `root:root` mode `0555`; `/` and `/opt` remain `root:root`
mode `0755`. `ProtectHome=tmpfs` therefore needs no home-directory exception.
Before enable, deployment must verify the version, SHA-256, ownership, mode,
size, ancestry, and exact runtime inventories, then run both the CLI check and
real bwrap/latexmk/qpdf activation canary under the installed unit.
Both `ExecStartPre` checks and `ExecStart` use that same immutable Node. The
worker repeats the no-follow identity, hash, stable-ancestry, and inventory
checks after exec and fails unless it is running from that exact path as the
non-root service user/group. Thus a later automatic restart does not trust
deployment-time evidence alone.
The second `ExecStartPre` is the exact mode-aware in-unit `check`. It always
validates the immutable runtime, protected config/credential, and durable store.
When `creation.enabled=true`, it additionally runs one bounded,
network-isolated LaTeX/qpdf canary and refuses startup if that compiler proof
fails. When `creation.enabled=false`, it deliberately does not touch the TeX
toolchain: readiness advertises `compiler:null`, compile remains disabled, and
the retained full/range read plus two-phase-delete floor can restart even while
the compiler is unavailable.
The exact installed candidate unit must complete `aginti-document-worker check`
successfully before LazyEdge route activation, AgInTi broker activation, or Web
exposure is allowed; static unit verification is not a substitute for that
namespace and compiler activation proof.

LazyEdge permits two concurrent requests and the worker admits at most one
compiler process; at most four additional compiles remain in a bounded
in-process queue and excess admission fails retryably.
The private ledger also enforces fixed group/directory bounds, per-source and
per-PDF limits, and an 8 GiB aggregate live-object ceiling; quota exhaustion
does not disable existing reads or two-phase deletion.
Each compiler process has a 30-second wall limit. The 120-second private-route
timeout is intentionally longer so queueing, forced cleanup, and a structured
failure response retain transport headroom.

Completed deletion receipts are retained for the most recent 512 delete
transactions. Compaction removes only groups whose two objects are already
durably tombstoned; it never removes staged, committed, prepared, or deleting
groups. Within that window, compile/commit/delete response loss replays exactly.
When full tombstones are compacted, the store atomically advances a durable
compile-authority epoch in the same ledger replacement. New clients fetch that
epoch immediately before compiling and bind it into the deterministic request
ID. Old content/commit/delete replay resolves as not-found, while a delayed old
compile request carries a stale epoch and remains 410 Gone. Existing live-group
replay remains exact. This bounded cutoff has no practical lifetime delete
ceiling and the 4,096-entry live-ledger cap is no longer a lifetime creation
limit.

The TeX compiler uses bubblewrap namespaces. Therefore the unit intentionally
does not use `RestrictNamespaces=true`; it denies only time namespaces. Every
candidate unit must run the real bwrap/latexmk/qpdf activation canary under the
installed unit before creation is enabled. A hash-only executable check is not
an activation proof.
