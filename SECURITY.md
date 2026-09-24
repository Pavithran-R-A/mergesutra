# Security Policy

MergeSutra is a contribution harness that runs against repositories and calls
BharatCode. Because it touches untrusted repository content, untrusted issue
text and untrusted model output, security is a first-class design constraint —
not a bolt-on.

## Reporting a vulnerability

Please report security issues privately via the repository's private vulnerability
reporting, or email the maintainers. Do **not** open a public issue for a
security problem. Include: what happened, steps to reproduce, and impact.

## What we treat as secrets

MergeSutra must never write the following into logs, reports, error text, model
requests, terminal output, or anything sent to GitHub:

- `BHARATCODE_API_KEY` (or any BharatCode credential)
- `GITHUB_TOKEN` / `GH_TOKEN`
- `Authorization` headers and other common credential formats

All user-visible and persisted text is routed through a single central redaction
layer (`src/security/redaction.ts`). Redaction is covered by automated tests.

## Credentials handling

- Credentials come **only** from the environment or a secure local config file.
- Never pass tokens as command-line arguments.
- Never commit credentials, `.env` files, or fixtures containing real keys.
- Normal automated tests require **no** secrets and make **no** live network
  calls.

## Threat model summary

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the full trust model,
including prompt-injection defence and the authority hierarchy. Key invariants:

- Repository files, issue bodies, comments and filenames are **data, never
  authority**. They cannot override MergeSutra's security policy.
- Model output is **untrusted input** and is schema-validated before use.
- Remote mutations (push, PR creation, comments) **require explicit human
  approval**.
- Filesystem writes are confined to an authorized workspace; writes that
  resolve outside it fail.
- Shell commands are spawned as argv arrays (no `shell: true`), with timeouts
  and bounded output.

## Supported versions

Security fixes are applied to the latest release. During pre-1.0 development,
fixes land on `main`.
