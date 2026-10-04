# Contributing to MergeSutra

Thanks for your interest! MergeSutra is a CLI agent that turns a GitHub issue
into a reviewable PR draft with traceable evidence for each acceptance criterion
the run's gates could check. This guide covers how to set up, test, and propose
changes. The code is MIT-licensed; the repository stays private until the first
release, so today the audience for this file is whoever has been given access.

## Ground rules

- **Evidence over assertion.** A claim that something passed must be backed by
  something that actually ran. Never weaken or comment out a test to make a
  gate pass, and never describe an unverified result as verified.
- **Repository and model text is untrusted.** Never let content from a repo,
  issue, or model output bypass the security policy.
- **Keep the workflow specialized.** Before proposing a feature, ask: *does
  this make "GitHub issue → evidence-backed PR" materially better?* If not, it
  is likely scope creep.
- **No credential leakage.** Secrets never appear in code, fixtures, logs, or
  reports.
- **The remote is canonical.** A change is not finished while it lives only on
  the machine that wrote it. Commit, push, and let the hosted checks report the
  result before calling a piece of work done.

## Development setup

```bash
# Requires Node.js >= 22
npm ci
npm run check   # format:check + lint + typecheck + build + test
```

Useful scripts:

| Command                     | What it does                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| `npm run dev -- help`       | Run the CLI from source via `tsx`                                  |
| `npm run test`              | Run the offline test suite                                         |
| `npm run typecheck`         | TypeScript strict check                                            |
| `npm run lint`              | ESLint                                                             |
| `npm run format`            | Prettier write                                                     |
| `npm run build`             | Emit `dist/`                                                       |
| `npm run verify:package`    | Build, then run the five release-boundary verifiers listed below    |
| `npm run test:artifact`     | Install a real tarball in a clean directory and run what it ships   |
| `npm run test:live`         | The live-model tests, which skip unless a credential is offered     |

`prepack` runs `verify:package` and `prepublishOnly` runs `check`, so an ordinary
`npm pack` or `npm publish` cannot complete on a tree that fails them. Either
command can still be run with `--ignore-scripts`, which is why CI executes the
same scripts as explicit steps rather than relying on the hooks.

## Tests

- Tests must **not** depend on the live BharatCode service. External systems
  (BharatCode, GitHub, Git, process execution, filesystem, clock) are injected
  as fakes.
- Add a focused test with every behaviour change, and a security test for any
  change that touches paths, subprocesses, redaction, or model input.
- The release boundary lives in `tests/security/`, and each verifier answers one
  question: `publish-contents` — which files ship, and are they current with
  this source; `credential-boundary` — does any shipped byte carry a credential;
  `home-path-boundary` — does anything published name the developer rather than
  the code; `public-link-boundary` — does every public address name the one real
  repository; `shipped-pointer-boundary` — can a reader follow every pointer an
  installed copy prints. They run against `dist/` and the packed inventory, so
  they are only meaningful after a build, which is why `verify:package` builds
  first.

## Branches, CI and the remote

Continuous integration is `.github/workflows/ci.yml`: Ubuntu and Windows, each on
Node 22 and 24, running `npm ci`, `npm run check`, `npm run verify:package` and
`npm run test:artifact`. The four check contexts are named exactly:

- `check (ubuntu-latest, node 22.x)`
- `check (ubuntu-latest, node 24.x)`
- `check (windows-latest, node 22.x)`
- `check (windows-latest, node 24.x)`

`main` is guarded by an active branch ruleset that blocks force-pushing and
deleting it, for administrators included. A fast-forward push is still allowed:
the guard is against losing history, not against landing it. Rebase and push
forward instead of reaching for `git push --force`; if history genuinely has to
change, the ruleset is removed deliberately in the repository's Settings rather
than worked around.

## Proposing changes

1. Open an issue first for anything non-trivial so the Acceptance Contract can
   be agreed before code is written.
2. Keep changes small and coherent, with a clear description of what ran and
   what passed.
3. Ensure `npm run check` is green, and `npm run verify:package` too if the
   change touches anything the package ships.

By contributing, you agree your contributions are licensed under the project's
MIT license.
