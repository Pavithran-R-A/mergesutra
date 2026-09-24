# Changelog

All notable changes to MergeSutra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Not yet implemented (planned)

`issue`, `inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`,
`pr`, `status`, `resume`. Invoking any of these reports a truthful "planned"
message and exits non-zero.

[0.0.1]: https://github.com/mergesutra/mergesutra/releases/tag/v0.0.1
