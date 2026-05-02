# Release and Publishing

AgInTiFlow is published as:

```bash
@lazyingart/agintiflow
```

The package exposes both commands:

```bash
aginti
aginti-cli
```

## Version Policy

Use semantic versioning:

| Change | Version |
| --- | --- |
| Bug fix, UI polish, docs packaging | Patch |
| New user-facing feature | Minor |
| Breaking CLI/API behavior | Major |

## Prepublish Checks

Run:

```bash
npm test
npm run pack:dry-run
git diff --check
```

Inspect the pack output. It should include source, docs, public assets, skills, and scripts, but not `.env`, npm tokens, runtime sessions, or generated credential material.

## Safe Publish

Preferred release path is GitHub Trusted Publishing through OIDC. A local token fallback can be used only from ignored local credentials.

Never print:

- npm token
- API key
- `.npmrc` contents
- `.env` contents
- OTP

## After Publish

Verify:

```bash
npm view @lazyingart/agintiflow version --json
npm install -g @lazyingart/agintiflow@latest
aginti --version
```
