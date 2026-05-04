# AAPS Adapter

AgInTiFlow can connect to AAPS for large, explicit workflows.

AAPS is the declarative control plane: `.aaps` scripts, `aaps.project.json`, compile reports, validations, recovery steps, and run artifacts. AgInTiFlow is the interactive runtime: model routing, files, shell policy, Docker mode, tmux, sessions, and canvas.

The adapter is optional. Normal AgInTiFlow usage is unchanged when AAPS is not installed.

## Commands

```bash
aginti aaps status
aginti aaps init "My AAPS Project"
aginti aaps files
aginti aaps validate
aginti aaps parse
aginti aaps compile check
aginti aaps dry-run workflows/main.aaps
```

Inside the CLI:

```text
/aaps
/aaps on
/aaps init
/aaps validate
/aaps compile check
```

`/aaps on` selects the AAPS task profile and raises the step budget for workflow work. `/aaps off` returns to Auto.

## Discovery

AgInTiFlow looks for AAPS in this order:

1. `AAPS_BIN` or `AGINTI_AAPS_BIN`.
2. `node_modules/.bin/aaps`.
3. `aaps` on `PATH`.
4. A sibling development checkout at `~/ProjectsLFS/AAPS/scripts/aaps.js` when present.

Install AAPS when needed:

```bash
npm install -g @lazyingart/aaps
```

`aginti aaps install` installs AAPS as a project dev dependency when `package.json` exists. Use `aginti aaps install global` only when you intentionally want a global npm install.

## Safety

The adapter keeps paths project-relative and avoids shell interpolation. Start with `validate` and `compile check`. Use `run` only for workflows you intentionally want to execute because AAPS run steps can call declared shell actions.
