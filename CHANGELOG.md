# Changelog

All notable changes to MergeSutra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Stage 1 — repository and GitHub issue intake. This stage reads and records; it
does not patch, verify, review or open anything.

### Added

- `mergesutra issue <url>` — the hero command's first stage. It parses the URL,
  reads the issue and repository through the injected GitHub source, pins an
  exact base commit **with provenance**, checks that a supplied `--repo` clone
  really is the issue's repository, and writes a versioned run record to
  `.mergesutra/runs/<id>.json`. `--repo <path>` works alone for a local clone.
  Exit codes: `0` complete, `3` inconclusive, `4` blocked.
- Safe issue URL parsing: https-only, `github.com` allow-list (look-alike hosts
  refused), credentials/ports refused, pull requests and non-issue paths
  refused, path-shaped and oversized input refused.
- `gh`-CLI backed GitHub source (`gh api`, argv arrays, `--hostname` for GHES)
  with Zod-validated payloads. GitHub owns the credential; MergeSutra never
  reads, stores or prints a GitHub token. API path segments are re-validated
  before they are interpolated.
- Read-only local repository inspection: identity, base SHA, branch, detached
  HEAD, dirty state (bounded sample), bare and linked-worktree detection. It
  never writes, fetches, checks out or touches the index, and a test asserts
  every command it ran was read-only.
- Versioned, schema-validated run record and an atomic run store (temp file +
  rename, `0600`); run ids are validated before touching the filesystem and
  unreadable files are reported rather than skipped.
- Injection *signalling* for imported issue text: eight rules, bounded redacted
  excerpts, recorded as a check. It labels text as data and never grants or
  removes authority.
- Path confinement helpers for later stages (`resolveInsideRoot`,
  `assertSafePathSegment`) plus shared bounded process runner in `src/core/`.
- Central redaction now also covers intake check details and limitations, so an
  error quoting a failing command's output cannot carry a credential into a run
  record.
- 150 additional offline tests (199 total), all with mocked GitHub responses and
  a scripted argv runner: no network, no credentials.

### Fixed

- `gh` HTTP status mapping looked at a mixed-case string, so a `502` from an
  intermediary was classified as a malformed response instead of a retryable
  server error.
- The process runner matched a Node max-buffer error code that Node does not
  emit, so oversized command output produced an empty failure; it now reports
  the byte bound that was hit. A command that could not start (for example a
  missing `gh`) reported an empty stderr instead of the reason.
- `www.github.com` produced a non-canonical URL.

### Not yet implemented (planned)

`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`, `pr`,
`status`, `resume`. `issue` performs intake only: it produces no plan, patch,
verification, review or PR draft, and says so on the last two lines. Invoking a
planned command reports a truthful "planned" message and exits `2`.

## [0.0.1] - 2026-09-24

Stage 0 — foundation and contracts. This is **not** yet the full issue-to-PR
workflow; it is the trustworthy base that workflow is built on.

### Added

- `mergesutra` CLI skeleton with working `--help`, `--version` and `doctor`.
- `mergesutra doctor` — offline-capable environment diagnosis (Node, Git, GitHub
  CLI + auth, BharatCode configuration) that never leaks secrets. `--connect`
  opts into a live reachability probe.
- BharatCode adapter (`BharatCodeClient`) over the OpenAI-compatible API with a
  dependency-injected `fetch`, typed model discovery and chat-completion
  boundaries, `completeStructured` schema-validated output, health check,
  bounded exponential-backoff-with-jitter retry honouring `Retry-After`,
  timeout and cancellation.
- Configuration loader that reads credentials only from the environment; a
  missing key is a reportable state, never a crash, and never required by tests.
- Central secret redaction (`Redactor`) for text, headers, and nested
  structures.
- Structured application errors (`AppError`) with explicit, truthful kinds.
- Zod validation of all model/provider responses (model output is untrusted).
- 49 offline unit tests; `npm run check` umbrella gate; CI for Ubuntu + Windows.
- Product, architecture, security, roadmap, decisions and acceptance-contract
  design documentation.
