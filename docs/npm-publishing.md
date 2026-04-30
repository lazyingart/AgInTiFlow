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
4. Push the release commit and create a GitHub Release, or run the publish workflow manually.
5. Confirm the npm package page shows provenance.

## Local Token Fallback

Trusted Publishing is preferred. A local automation token can be used only for bootstrap or emergency fallback:

```bash
cp .env.example .env
# Add NPM_TOKEN or NODE_AUTH_TOKEN locally only.
set -a && source .env && set +a
npm publish --access public
```

Never commit `.env`, `.npmrc`, npm tokens, OTPs, npm debug logs, or generated credential material. The runtime command policy intentionally blocks npm publish and npm token commands during agent runs.
