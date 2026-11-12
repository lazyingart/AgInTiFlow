# npm Publishing

AgInTiFlow is published on npm as `@lazyingart/agintiflow`.

## Trusted Publishing

Use GitHub Actions Trusted Publishing for normal releases. The workflow is `.github/workflows/npm-publish.yml` and publishes with provenance using OIDC.

Trusted Publisher settings on npm:

- Package: `@lazyingart/agintiflow`
- Publisher: GitHub Actions
- Repository: `lazyingart/AgInTiFlow`
- Workflow filename: `npm-publish.yml`
- Environment: blank, unless a GitHub deployment environment is added later

Equivalent setup command:

```bash
npm install -g npm@^11.5.1
npm trust github @lazyingart/agintiflow --repo lazyingart/AgInTiFlow --file npm-publish.yml
```

The npm trust setup may require the package to exist before trust can be attached. If npm asks for an OTP or browser confirmation, stop and complete that step outside the agent.

## Release Flow

1. Update `package.json` version.
2. Run `npm test`.
3. Run `npm pack --dry-run` and inspect the tarball contents.
4. Commit and push the verified source, then push one matching immutable version tag.
5. Confirm the npm package page shows provenance.

Use the tag-push path:

```bash
RELEASE_VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${RELEASE_VERSION}" -m "Release ${RELEASE_VERSION}"
git push origin "refs/tags/v${RELEASE_VERSION}"
gh run list --repo lazyingart/AgInTiFlow --workflow npm-publish.yml --event push --branch "v${RELEASE_VERSION}"
gh run watch RUN_ID --repo lazyingart/AgInTiFlow --exit-status
```

The hosted-runner namespace restriction disposition is deliberately bound to
`push` of a version tag in this repository and workflow. A branch dispatch or
GitHub Release event does not satisfy that predicate. Do not relax the predicate
or set its flags locally to manufacture a passing namespace proof. Do not move
an existing tag or launch a second publish while its first run is unresolved.

`pack:verify-runtime` runs the complete 1,208-case consumer cohort at concurrency
two with a finite ten-minute outer watchdog. Individual test deadlines remain
unchanged. Failure preserves child stdout/stderr, including partial progress.
Qualification requires all cases to pass with no cancellation or skips; the
release cohort currently includes Linux-specific cases. A timeout is a failed
gate, never permission to publish or silently omit tests.

If local token publishing fails with `E401` or `E404`, do not treat that as terminal when Trusted Publishing is configured. Use the established version-tag workflow with the authorized repository identity, then verify the registry and install the published package. A local npm token is not required for the configured OIDC path. See `references/agintiflow-npm-publication-memory.md` for the historical publication evidence and current invocation boundary. Preserve shared GitHub account settings; scope any required account choice to the command.

## Local Token Fallback

Trusted Publishing is preferred. A local automation token can be used only for bootstrap or emergency fallback:

```bash
cp .env.example .env
# Add NPM_TOKEN or NODE_AUTH_TOKEN locally only.
npm run publish:env:whoami
npm run publish:env
```

`publish:env` reads `.env`, writes a temporary npm config, runs npm with that config, and deletes it. Do not use global `~/.npmrc` for agent-driven publishing because it can be stale, point at the wrong account, or leak between projects.

Never commit `.env`, `.npmrc`, npm tokens, OTPs, npm debug logs, or generated credential material. The runtime command policy intentionally blocks npm publish and npm token commands during agent runs.
