# Releasing MergeSutra

This document is the release operator checklist. It describes what the repository
can prove automatically and the two credential boundaries it cannot cross by
itself.

## Release invariants

A release candidate is not releasable unless all of these are true:

1. `main` and the release commit are identical to the commit being tagged.
2. GitHub-hosted CI is green on Ubuntu, Windows and macOS, on Node 22 and Node 24,
   at the exact release SHA (six jobs).
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
Do not create a long-lived automation token for this bootstrap. Publish from the
release commit's git checkout, as shown: npm records the checkout's `gitHead`, and a
tarball published from outside a repository carries none, so the release workflow
would refuse to verify it.

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
tag/version mismatch. When the exact npm version already exists it verifies that the
registry metadata names that version and the checked-out `gitHead`, rather than
trying to republish it. A registry read that fails for any reason other than npm's own
`code E404` line fails the release instead of counting as version absence, and metadata
without `gitHead` fails it as a mismatched commit does. npm answers a private read it
cannot authorize with E404 too, so the publish that follows is still subject to npm's
own duplicate-version refusal.

If `npm publish` succeeds but no verification read succeeds, the step fails and says the
version may already be live. Re-running the workflow verifies an existing exact version
instead of publishing it again.

## Registry verification

`node scripts/publish-or-verify.mjs` reads the registry as three states rather than two,
and the rules live in `scripts/lib/publish-registry.mjs`:

- **The version exists.** The metadata is accepted only when it reports the package
  version and a full lowercase 40-hex `gitHead` equal to the checked-out release commit.
  Metadata without a `gitHead`, or one too short or malformed to name a commit, fails:
  it cannot tie the published bytes to the release.
- **The version is absent.** Only npm's own `code E404` status line says that, matched as
  a whole line, and only in a read that reported an exit status: an npm that was killed
  after flushing that line completed nothing, so its partial transcript is a failed read
  rather than an answer. An authentication, network, proxy or registry error — and an
  `E404` token sitting inside other text — is a failed read too. Before publication a
  failed read stops the run, because the registry may already hold the version.
- **The read failed after publication.** A version that was just published can still be
  propagating, so both an absent and a failed answer are retried within the bounded
  window, and the exhaustion message names which of the two the last read left.

Every failure in this script exits non-zero, and nothing re-runs `npm publish`.

## BharatCode validation boundary

The deterministic release gates do not substitute for Stage 14's live-model
evidence. The controlled procedure lives in
`docs/REAL_MODEL_E2E_PROCEDURE.md` and must use a real
`BHARATCODE_API_KEY` in the isolated/scoped fixture environment described there.

Until that run and the approximately ten-task benchmark are executed, release notes
must say they are pending. Do not invent a model result, cost, success rate or
benchmark score.
