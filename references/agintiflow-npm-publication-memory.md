# AgInTiFlow npm Publication Memory

Date: 2026-05-20

Updated: 2026-05-31

This note records the working publication route for AgInTiFlow so future release work does not get blocked by stale local npm tokens or repeated discussion about why direct `npm publish` failed.

## Published Evidence

Latest verified release:

- Version: `0.20.186`
- Commit: `f32a748`
- GitHub Actions run: `https://github.com/lazyingart/AgInTiFlow/actions/runs/26700782132`
- Workflow result: success
- npm registry check: `npm view @lazyingart/agintiflow version dist-tags.latest --registry=https://registry.npmjs.org` returned `0.20.186`.
- Installed verification: `npm install -g @lazyingart/agintiflow@0.20.186` then `aginti --version` returned `0.20.186`.
- Webapp verification: `aginti webapp restart --port 3210` then `curl -fsS http://127.0.0.1:3210/health` returned `version":"0.20.186"` from the global npm package path.
- Direct image CLI verification: `aginti image --json --dry-run --format svg` returned `requestedFormat:"svg"`, `actualFormat:"png"`, and a clear raster PNG fallback notice.

Previous verified release:

- Version: `0.20.185`
- Commit: `58d6087`
- GitHub Actions run: `https://github.com/lazyingart/AgInTiFlow/actions/runs/26700387931`
- Workflow result: success
- npm registry check: `npm view @lazyingart/agintiflow version dist-tags.latest --registry=https://registry.npmjs.org` returned `0.20.185`.
- Installed verification: `npm install -g @lazyingart/agintiflow@0.20.185` then `aginti --version` returned `0.20.185`.
- Webapp verification: `aginti webapp restart --port 3210` then `curl -fsS http://127.0.0.1:3210/health` returned `version":"0.20.185"` from the global npm package path.
- Image API verification: `POST /api/auxiliary/generate-image` with `format:"svg"` and `dryRun:true` returned `requestedFormat:"svg"`, `actualFormat:"png"`, and a clear raster PNG fallback notice.

Previous verified release:

- Version: `0.20.184`
- Commit: `9b22f4c`
- GitHub Actions run: `https://github.com/lazyingart/AgInTiFlow/actions/runs/26700154894`
- Workflow result: success
- npm registry check: `npm view @lazyingart/agintiflow version dist-tags.latest --registry=https://registry.npmjs.org` returned `0.20.184`.
- Installed verification: `npm install -g @lazyingart/agintiflow@0.20.184` then `aginti --version` returned `0.20.184`.
- Webapp verification: `aginti webapp restart --port 3210` then `curl -fsS http://127.0.0.1:3210/health` returned `version":"0.20.184"` from the global npm package path.

Previous verified release:

- Version: `0.20.182`
- Commit: `b5492f7`
- GitHub Actions run: `https://github.com/lazyingart/AgInTiFlow/actions/runs/26198123298`
- Workflow result: success
- npm registry check: `npm view @lazyingart/agintiflow version` returned `0.20.182`
- Installed verification: `npm install -g @lazyingart/agintiflow@0.20.182` then `aginti --version` returned `0.20.182`
- Webapp verification: `aginti webapp restart --port 3210` then `curl -fsS http://127.0.0.1:3210/health` returned `version":"0.20.182"` from the global npm package path.

Previous reference release:

- Package: `@lazyingart/agintiflow`
- Version: `0.20.169`
- Commit: `6ef3768`
- GitHub Actions run: `https://github.com/lazyingart/AgInTiFlow/actions/runs/26149627377`
- Workflow result: success
- npm registry check:

```bash
npm view @lazyingart/agintiflow version dist-tags.latest --registry=https://registry.npmjs.org
```

Expected result:

```text
version = '0.20.169'
dist-tags.latest = '0.20.169'
```

Installed verification:

```bash
npm install -g @lazyingart/agintiflow@0.20.169
aginti --version
aginti webapp restart --port 3210
curl -fsS http://127.0.0.1:3210/health
```

Expected result:

```text
0.20.169
```

The health endpoint should report `version":"0.20.169"` and a global npm package path.

## Working Publication Route

Use GitHub Actions Trusted Publishing as the primary route.

Workflow:

- `.github/workflows/npm-publish.yml`
- permissions include `id-token: write`
- publish command uses `npm publish --access public --provenance`

The successful dispatch used the configured `lazyingart` GitHub CLI account because the default `lachlanchen` account has `workflow` scope but does not have repository admin permission for workflow dispatch on `lazyingart/AgInTiFlow`.

Reliable command sequence:

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
git status --short
npm test
npm pack --dry-run
git push
gh auth switch -u lazyingart
gh workflow run npm-publish.yml --ref main
gh run watch <run-id> --exit-status
npm view @lazyingart/agintiflow version dist-tags.latest --registry=https://registry.npmjs.org
npm install -g @lazyingart/agintiflow@<version>
aginti --version
aginti webapp restart --port 3210
curl -fsS http://127.0.0.1:3210/health
gh auth switch -u lachlanchen
```

Do not print tokens. Do not copy token values into notes, logs, or final answers.

## Local Token Failure Is Not Terminal

On 2026-05-20, the env-based local publish path failed:

- `npm whoami` through the env publish script returned `E401`.
- direct publish returned `E404 PUT https://registry.npmjs.org/@lazyingart%2fagintiflow`.
- the registry still showed the prior version until the trusted-publishing workflow was dispatched.

Treat this as an auth/scope problem in local npm credentials, not as a package or registry existence problem. When this happens, use GitHub Trusted Publishing before spending time debating the local token path.

## Operational Rule

For future AgInTiFlow releases, do not stop after local token publish failure if the trusted-publishing workflow is available. Trigger the trusted-publishing workflow with the owner account, watch it, verify npm, install globally, restart the webapp, and only then report completion.
