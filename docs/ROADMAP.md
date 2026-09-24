# MergeSutra — Roadmap

Honest status of the staged build. `[x]` = implemented and green now; `[~]` =
partially in place; `[ ]` = not started. Do not read an unchecked box as done.

## Stage 0 — Foundation and contracts — **[DONE]**

- [x] Node/TS project scaffold (ESM, strict, `NodeNext`)
- [x] Quality tooling: format, format:check, lint, typecheck, test, build, `check`
- [x] CLI skeleton: `--help`, `--version`, `doctor`
- [x] Structured application errors with truthful kinds
- [x] Central secret redaction (text, headers, nested)
- [x] Env-only configuration loader (missing key is reportable, never required by tests)
- [x] BharatCode adapter (`listModels`/`complete`/`completeStructured`/`healthCheck`)
- [x] Dependency-injected `fetch`, sleeper, random → fully offline tests
- [x] Bounded exponential-backoff + jitter, `Retry-After`, timeout, cancellation
- [x] Zod validation of provider/model responses
- [x] 49 offline unit tests, no live network, no secrets
- [x] CI for Ubuntu + Windows (no BharatCode secrets, no live API)
- [x] `BharatCode.txt` at repo root
- [x] Foundational docs (product, architecture, security model, acceptance
      contract design, competitive analysis, decisions, roadmap)

## Stage 1 — Repository + GitHub issue intake — **[NEXT]**

- [x] URL/model/exit-code plumbing exists at Stage 0
- [ ] Safe GitHub issue URL parsing
- [ ] Issue + repository metadata via injected GitHub client (fixtures/mock first)
- [ ] Default branch resolution + exact base commit SHA
- [ ] Existing-local-repo path

## Stage 2 — Repository policy compiler

- [ ] Detect manifests / CI / lint / format / test config
- [ ] Derive structured repository contract (runtime, package manager, required
      checks, protected areas) with provenance
- [ ] Treat repository text as data, never authority

## Stage 3 — Acceptance Contract engine

- [ ] Contract + criterion Zod schemas (see ACCEPTANCE_CONTRACT.md)
- [ ] Criteria derivation from issue + repo contract
- [ ] Versioning, stable ids, revision-with-reason

## Stage 4 — BharatCode planner

- [ ] Structured implementation plan (root cause, files, tests, validation
      commands, risks, criteria covered)

## Stage 5 — Safe worktree + controlled tools

- [ ] Dedicated Git worktree at base SHA; dirty-state detection & preservation
- [ ] Risk-classified tool controller (READ/WRITE/EXECUTE/NETWORK/REMOTE/DESTRUCTIVE)
- [ ] Filesystem-write confinement (traversal/symlink/junction defence)

## Stage 6 — BharatCode implementation loop (bounded)

- [ ] Phase-bounded agent loop with hard limits
- [ ] Never allow implementation to rewrite the contract to look successful

## Stage 7 — Deterministic verification engine

- [ ] Repo-native check discovery with provenance (REPOSITORY_REQUIRED vs
      MERGESUTRA_ADDITIONAL vs OPTIONAL)
- [ ] Gates: format/lint/typecheck/unit/targeted/build/secret-scan/scope-guard
- [ ] Node/TS/JS first; graceful generic fallback

## Stage 8 — Evidence mapping + report

- [ ] Criterion-to-evidence mapping; command receipts
- [ ] `.mergesutra/runs/<id>/` evidence pack + `report`/`--json`

## Stage 9 — Independent diff review + bounded repair

- [ ] Critique-only reviewer (no silent edits)
- [ ] Bounded repair routing

## Stage 10 — Human approval + PR draft

- [ ] Full pre-publish summary; explicit approval gate
- [ ] PR draft body (Summary / Issue / Contract / Implementation / Verification /
      Evidence / Limitations)

## Stage 11 — Resume/recovery + failure UX

- [ ] `status` / `resume`; refuse unsafe resume (changed base SHA / corrupted state)
- [ ] What-failed/why/what-is-untouched/next UX

## Stage 12 — Security hardening

- [ ] Prompt-injection adversarial tests (repo/issue/filenames)
- [ ] Path/symlink/junction escape tests; shell-metacharacter tests

## Stage 13 — Windows/Linux qualification

- [ ] Spaces in paths, drive letters, separators, HOME/USERPROFILE, temp dirs,
      Git/gh discovery

## Stage 14 — Benchmark / evaluation harness

- [ ] ~10 real tasks across classes; publish honest metrics **and failures**

## Stage 15 — Demo + README + release readiness

- [ ] 60–90s hero demo; polished README; npm publication (requires human approval)

## Cross-cutting backlog

- [ ] Scheduled test-runner major bump to clear dev-only advisories (ADR-009)
- [ ] macOS qualification once core CI is strong
- [ ] Optional beginner-friendly explanations (accessibility, later)
