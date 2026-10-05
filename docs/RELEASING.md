# Releasing MergeSutra

This document is the release operator checklist. It describes what the repository
can prove automatically and the two credential boundaries it cannot cross by
itself.

## Release invariants

A release candidate is not releasable unless all of these are true:

1. `main` and the release commit are identical to the commit being tagged.
2. GitHub-hosted CI is green on Ubuntu and Windows, on Node 22 and Node 24.
3. `npm audit --omit=dev --audit-level=high` succeeds.
4. `npm run check`, `npm run verify:package` and `npm run test:artifact` succeed.
5. The package version, `src/version.ts`, release tag and checked-out commit agree.
6. The packed artifact contains no credential, author home path, private-only link
   or unintended repository file.
7. A failed or missing real-model validation is reported as missing evidence, never
   rewritten as a pass.

## v0.1.0 namespace bootstrap

The package name is `mergesutra`. npm Trusted Publishing can only be configured
after the package already exists on the npm registry, so the first publication has
one unavoidable interactive bootstrap.

From the exact, fully green v0.1.0 release commit:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run check
npm run verify:package
npm run test:artifact
npm pack --dry-run
npm publish --access public
```

The npm maintainer must authenticate normally and satisfy npm's 2FA requirement.
Do not create a long-lived automation token for this bootstrap.

After `mergesutra@0.1.0` exists, configure npm Trusted Publishing for:

- provider: GitHub Actions
- GitHub owner: `Pavithran-R-A`
- repository: `mergesutra`
- workflow filename: `publish.yml`
- direct `npm publish`: allowed
- environment: none unless one is deliberately added to the workflow

Then prefer the GitHub release workflow for later versions. It requests
`id-token: write` only in the publish job and carries no npm token.

## GitHub Release

Do not publish the GitHub Release until the exact npm version exists for the first
bootstrap. The release event triggers `.github/workflows/publish.yml`.

Use tag `v<package-version>` on the exact release commit. The workflow refuses a
tag/version mismatch and verifies an already-existing exact npm version rather than
trying to republish it.

## BharatCode validation boundary

The deterministic release gates do not substitute for Stage 14's live-model
evidence. The controlled procedure lives in
`docs/REAL_MODEL_E2E_PROCEDURE.md` and must use a real
`BHARATCODE_API_KEY` in the isolated/scoped fixture environment described there.

Until that run and the approximately ten-task benchmark are executed, release notes
must say they are pending. Do not invent a model result, cost, success rate or
benchmark score.
