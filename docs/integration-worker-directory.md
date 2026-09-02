# Integration worker directory

Status: the durable directory and leased execution-router path are implemented and smoke-tested. The binding authority is test-only; production still uses the fixed execution client.

AgInTi owns durable worker identity, role assignment, migration, rollback, drain, retirement, and removal. LazyEdge owns only authenticated transport and admission checks. LocalLLM and other worker services own their role-specific model or tool execution. Callers cannot choose a URL or credential.

## Stored state

The directory stores only:

- a stable node ID and opaque transport binding ID;
- platform and declared roles;
- short-lived admission evidence derived from readiness and capability probes;
- generation-checked role assignments;
- bounded execution leases used to drain an old worker safely;
- an integrity-sealed, hash-chained transition ledger.

It does not store endpoints, bearer tokens, cookies, passkeys, or other credentials. The default owner-only state root is `/var/lib/agintiflow-integration/worker-directory`; tests and isolated deployments can supply another absolute root.

## Admission contract

Enrollment and every switch or rollback require fresh probe evidence. Evidence binds the node and opaque binding, role set, transport kind, release and capability digests, canary digest, supported protocols, observation time, and expiry. Admission lifetime is at most ten minutes.

The probe belongs to the trusted coordinator bootstrap. Candidate input containing an endpoint or credential is rejected before any probe or write. A later transport-binding adapter may resolve an opaque binding to a systemd credential and LazyEdge route, but that adapter must remain outside caller input.

## Migration lifecycle

1. Enroll and probe a candidate.
2. Assign a role with the expected current generation.
3. Acquire bounded leases for work accepted under that generation.
4. Switch the role to a freshly probed replacement. New leases resolve to the replacement immediately; old leases remain attached to the previous node.
5. Roll back while the previous-node pointer is retained, or finalize only after its leases drain.
6. Retire and remove an unassigned, unleased node.

Every mutation is serialized by an owner-only directory lock and committed with an atomic protected JSON replacement. Corrupt integrity seals, event chains, symlinks, hardlinks, malformed records, stale evidence, and generation conflicts fail closed.

## Leased execution routing

The analysis coordinator now has a routed mode. It acquires one execution lease before capability validation, resolves that lease to the opaque binding, opens the binding through an AgInTi-owned authority, and holds the lease through job start, polling, cancellation, terminal-ledger validation, artifact retrieval, and artifact callbacks. A role switch affects only later leases, so an in-flight job never changes workers halfway through its protocol.

The router revalidates the worker capability digest against the admitted node evidence before starting a job. It releases the lease on success, cancellation, or failure. A successful operation is not reported if its lease release cannot be committed; deterministic job identity allows the caller to retry safely.

## Current limitation and next integration step

Production routing is intentionally unchanged. The production execution client still uses one fixed loopback worker. The next slice must load an owner-only binding manifest, resolve each opaque binding to a fixed loopback/LazyEdge transport plus a systemd credential, and construct a binding-attested execution client without accepting caller transport fields. Activation still requires restart and real two-worker cutover evidence.

The transition ledger currently refuses further transitions after its conservative capacity is reached rather than truncating audit history. Durable ledger segmentation is required before treating this coordinator as an unattended long-lived fleet registry.

## Verification

```bash
npm run smoke:integration-worker-directory
```

The directory smoke covers workstation-to-Jetson migration, live-lease drain blocking, two-way rollback, finalization, retirement/removal, persisted restart recovery, expired-lease sweeping, stale and mismatched admission rejection, caller endpoint/credential rejection, invalid randomness, and fail-closed corruption, symlink, and hardlink cases.

`npm run smoke:integration-analysis-coordinator` additionally proves that an in-flight job stays pinned to worker A during a switch, finalization waits for its lease, the next job uses worker B, and capability/admission divergence fails closed without leaking a lease.
