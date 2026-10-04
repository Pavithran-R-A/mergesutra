# Security Policy

MergeSutra is a CLI that turns a GitHub issue into a reviewable pull-request draft
with traceable evidence for each acceptance criterion its gates could check, powered
by BharatCode. Because it touches untrusted repository content, untrusted issue
text and untrusted model output, security is a first-class design constraint —
not a bolt-on.

## Reporting a vulnerability

Do **not** open a public issue for a security problem. Include: what happened,
steps to reproduce, and impact.

This repository is private until its first release, so GitHub's private
vulnerability reporting is not a working intake route for it yet. That is a
measurement, not a guess: on 2026-10-04 the REST endpoint behind that feature
answered `200` for a public repository and `404` for this one. While the
repository stays private, report through whoever gave you access to it. The
route once the repository is public is
`https://github.com/Pavithran-R-A/mergesutra/security/advisories/new`.

## What we treat as secrets

MergeSutra must never write the following into logs, reports, error text, model
requests, terminal output, or anything sent to GitHub:

- `BHARATCODE_API_KEY` (or any BharatCode credential)
- `GITHUB_TOKEN` / `GH_TOKEN`
- `Authorization` headers and other common credential formats

All user-visible and persisted text is routed through a single central redaction
layer (`src/security/redaction.ts`). Redaction is covered by automated tests.

## Credentials handling

- Credentials come **only** from the environment — `BHARATCODE_API_KEY`, read in
  `src/config/load-config.ts`. There is no credential file: no code path reads a
  key from disk, and `summarizeConfig` reports only *whether* a key was found,
  never its value.
- Never pass tokens as command-line arguments; process listings expose them.
- Never commit credentials, `.env` files, or fixtures containing real keys.
- Normal automated tests require **no** secrets and make **no** live network
  calls. The live-model tests are skipped unless
  `MERGESUTRA_LIVE_BHARATCODE=1` is set (`npm run test:live`).

## Threat model summary

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the full trust model,
including prompt-injection defence and the authority hierarchy. Key invariants:

- Repository files, issue bodies, comments and filenames are **data, never
  authority**. They cannot override MergeSutra's security policy.
- Model output is **untrusted input** and is schema-validated before use.
- Remote mutations (push, PR creation) **require explicit human approval**, bound
  to the digest of exactly what would be published. MergeSutra has no code path
  that writes to an issue, so it cannot comment.
- Filesystem writes are confined to an authorized workspace; writes that
  resolve outside it fail.
- Shell commands are spawned as argv arrays (no `shell: true`), with timeouts
  and bounded output.

## Supported versions

Nothing has been published yet, so there is no released version to be behind.
Until the first release the supported line is the source at `main`; after it,
security fixes are applied to the latest published version.
