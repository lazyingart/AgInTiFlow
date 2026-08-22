# Supervision Campaign Ledger

Continuous AgInTiFlow validation uses a SQLite ledger instead of relying on a
chat transcript. The ledger records capability coverage, realistic scenarios,
individual test runs, runtime events, reusable fixes, versions, session IDs,
tmux ownership, and external evidence.

Initialize a campaign:

```bash
node scripts/supervision-ledger.js init \
  --db /path/to/campaign.sqlite \
  --campaign general-capability \
  --objective "Make AgInTiFlow fast, robust, and generally capable" \
  --aginti-version "$(node -p \"require('./package.json').version\")"
```

Register coverage before testing:

```bash
node scripts/supervision-ledger.js capability \
  --db /path/to/campaign.sqlite --campaign general-capability \
  --id media-chain --domain media --subdomain music-video-publish \
  --description "Reuse Musia, LALACHAN, and LazyEdit without rebuilding them" \
  --priority 90

node scripts/supervision-ledger.js scenario \
  --db /path/to/campaign.sqlite --campaign general-capability \
  --id media-chain-readiness --domain media --profile auto \
  --prompt-quality normal \
  --prompt "Inspect the established media chain without generating or publishing." \
  --expected-outputs '["media-routine-readiness.md"]' \
  --validation "Verify exact routine paths, command help, artifact bytes, and zero external writes."
```

Create, start, and finish a concrete run with `test`, `start`, `event`, and
`finish`. Record a reusable product change with `fix`. Every command is an
idempotent or append-only SQLite operation suitable for a persistent tmux
campaign.

Test registration validates that any named capability and scenario belong to
the same campaign. Finishing a test updates the test, capability, and scenario
status in one SQLite transaction, so a typo cannot silently leave the campaign
matrix stale or split across contradictory states.

Inspect current coverage:

```bash
node scripts/supervision-ledger.js status \
  --db /path/to/campaign.sqlite --campaign general-capability
```

Do not mark a test passed from the agent's prose. Verify session events, files,
checks, external state, and side-effect boundaries first, then store those paths
in `evidence_json` and `events`.

## Current Campaign Findings

### Data analysis retained-state recovery

`data-analysis-local-011` passed after reusable runtime fixes. AgInTi completed
the mixed sensor-export project, repaired its own unclosed CSV handles, created
commits `2f79553` and `3317a59`, and resumed the same durable session after a
control-loop pause. Independent validation ran both the unit suite and the
canonical generator with `ResourceWarning` promoted to an error; all tests,
audit counts, condition means, plot bytes, and clean-git checks passed.

The incident established two general contracts:

- A canonical command wrapped only by an explicit exit-status probe, such as
  `python analysis.py; echo "EXIT=$?"`, is valid evidence when the captured
  status is zero. Arbitrary semicolon chains remain invalid because a later
  command can hide an earlier failure.
- User-facing artifacts keep canonical workspace paths but receive a readable
  canvas/download filename derived from the task title and source purpose.
  Internal collision identifiers are short suffixes, never the leading or only
  visible filename information.
