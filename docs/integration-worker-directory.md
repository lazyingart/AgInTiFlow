# Integration worker directory

Status: the durable directory, leased execution router, fixed-manifest binding authority, and production preference path are implemented and smoke-tested. Production remains on the fixed client until a manifest and initial assignment are installed and accepted.

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

Production composition prefers the routed coordinator when `/etc/agintiflow/execution-worker-bindings.json` exists. It falls back to the fixed loopback client only when that file is absent. An unsafe, malformed, changed, or internally conflicting manifest fails startup; it never causes a silent downgrade. Activation still requires an initial directory assignment and real restart/cutover evidence.

The manifest is secret-free but security-sensitive and must be a canonical, non-symlinked, single-link `0600` file in a trusted, non-writable directory. Each binding contains only:

```json
{
  "schemaVersion": "aginti-integration-execution-worker-binding-v1",
  "bindingId": "binding_local_workstation_01",
  "transport": "local-loopback-http-v1",
  "host": "127.0.0.1",
  "port": 18130,
  "credentialName": "execution-worker-token"
}
```

The local binding is locked to `127.0.0.1:18130` and the existing fixed credential. LazyEdge bindings are also loopback-only from AgInTi's perspective and use reserved relay ports `18131` through `18194`, with distinct `execution-worker-binding-*` systemd credential names. Binding IDs, ports, and credential names must all be unique. Remote hosts, URLs, arbitrary ports, inline tokens, and caller-supplied credential names are rejected.

The service unit must install every named credential with `LoadCredential=`. The binding client reads only the credential selected by a branded manifest record, validates the read-only systemd credential mount and file identity, then attests the binding ID, transport, manifest digest, and exact loopback endpoint. A manifest change requires a controlled service restart.

The transition ledger currently refuses further transitions after its conservative capacity is reached rather than truncating audit history. Durable ledger segmentation is required before treating this coordinator as an unattended long-lived fleet registry.

## Verification

```bash
npm run smoke:integration-worker-directory
```

The directory smoke covers workstation-to-Jetson migration, live-lease drain blocking, two-way rollback, finalization, retirement/removal, persisted restart recovery, expired-lease sweeping, stale and mismatched admission rejection, caller endpoint/credential rejection, invalid randomness, and fail-closed corruption, symlink, and hardlink cases.

`npm run smoke:integration-analysis-coordinator` additionally proves that an in-flight job stays pinned to worker A during a switch, finalization waits for its lease, the next job uses worker B, and capability/admission divergence fails closed without leaking a lease.

`npm run smoke:integration-execution-worker-binding-config` covers manifest canonicalization, local and LazyEdge port policy, uniqueness, fixed-path loading, branded bindings, and rejection of URL/token/endpoint injection.
