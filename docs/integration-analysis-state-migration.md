# Integration analysis state migration

`aginti-integration-analysis-state` performs the forward-only storage-floor migration from canonical analysis state v2 to v3. It always processes every scope in one state root and does not accept a scope selector.

Stop the analysis service, then run the command as the operating-system user that owns the state root:

```sh
aginti-integration-analysis-state migrate \
  --offline \
  --state-root /absolute/owner-only/analysis-state
```

The command requires `--offline`. Its migration contract denies network access and does not load service configuration, credentials, model clients, search clients, or document-worker clients. Run it inside the same host network sandbox used for offline maintenance when the host provides one.

The migrator fails closed unless the root, `scopes` directory, every scope directory, and every `state.json` file have their expected canonical paths, current-user ownership, owner-only modes, and safe link counts. It takes the analysis-session ownership lock, performs a read-only validation of every scope before changing anything, accepts only canonical v2 or already-valid canonical v3 records, and refuses the entire migration if any persisted run is not terminal. A recognized crash-left temporary file is validated during this read-only pass and removed only after the whole root passes preflight.

A live analysis service or migrator always blocks the command. A lock left by a killed process becomes reclaimable only after 60 seconds and only when its schema, cryptographic owner token, PID, boot ID, process start identity, and acquisition timestamp are valid and that exact process identity is no longer live. This permits bounded crash recovery without breaking a live owner.

Each v2 record receives empty document-intent arrays and run lineage inferred by the runtime's own parser. The state revision and all existing semantics remain unchanged. The runtime's canonical encoder recomputes the envelope digest. Each converted scope is written to an owner-only temporary file, fsynced, atomically renamed, verified, and followed by a directory fsync.

Conversion is resumable without a rollback journal: completed scopes are valid v3, untouched scopes remain valid v2, and a rerun accepts that mixed state and continues forward. Scope directories are processed by explicit lowercase-hex code-unit order, independent of host locale. A second run over an all-v3 root does not rewrite files.

Successful output contains only counts, fixed contract fields, and aggregate SHA-256-derived digests. It never prints root paths, scope identifiers, principals, browser sessions, thread/run identifiers, prompts, messages, artifacts, or document content.

## Lock-held prewrite handshake

An operator that must complete an external durable cutover step between validation and the first state mutation can enable the prewrite gate:

```sh
aginti-integration-analysis-state migrate \
  --offline \
  --state-root /absolute/owner-only/analysis-state \
  --prewrite-gate-nonce "$cutover_nonce" \
  --prewrite-gate-timeout-ms 120000
```

Both gate flags are required together. The nonce must be exactly 64 lowercase hexadecimal characters. The timeout must be an integer from 1 through 600000 milliseconds. Generate a fresh unpredictable nonce in the controller for each attempt; do not reuse a nonce across independent cutovers.

The command takes `.analysis-session-owner.lock`, validates the complete root, computes every canonical v3 target, and writes one JSON gate record to stdout. It continues holding that same lock while it waits on stdin. The gate record is deterministic for a given nonce, timeout, current state, and target plan. It contains only fixed protocol fields, counts, aggregate digests, and a derived storage-state label; it never exposes a scope identity or path.

`sourceV2ScopeCount` and `sourceV3ScopeCount` always sum to `scopeCount`. `migrationTemporaryCount` counts validated crash-left migration temporary files and cannot exceed `scopeCount`. `currentStorageState` is derived from the source counts: `empty` for zero scopes, `all-v2` when every nonempty scope is v2, `all-v3` when every nonempty scope is v3, and `mixed` only when both source versions are present. A controller can therefore apply its marker/storage matrix without releasing the lock. The `targetAggregateDigest` is computed solely from each scope's canonical v3 output, so it remains identical for equivalent all-v2, partially migrated, and all-v3 roots even though their current-state metadata differs.

The controller must first durably complete and verify its external cutover step. It then writes the gate record's `requiredAck` value followed by exactly one LF byte to the migrator's stdin. The acknowledgement is bound to the nonce, target aggregate, and migration contract. Do not reconstruct or normalize it when the exact emitted value can be relayed.

Until that exact acknowledgement is received, the migrator does not remove a crash-left migration temporary file and does not create, replace, or rewrite any state or migration-temporary file. EOF, a mismatched acknowledgement, input failure, or timeout fails closed, releases the ownership lock, and leaves the preflight state untouched. After acknowledgement, the normal resumable migration runs under the continuously held lock. A second JSON line is written only after final verification and is the ordinary migration result.

The gate is a synchronization boundary, not remote authentication: stdout reveals the required acknowledgement by design. The controller is responsible for withholding it until its separately authenticated durable action is complete. Keep the analysis service stopped for the whole command, including the acknowledgement wait.
