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
