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

## Stage 1 — Repository + GitHub issue intake — **[DONE]**

- [x] URL/model/exit-code plumbing exists at Stage 0
- [x] Safe GitHub issue URL parsing (host allow-list, no credentials in URL,
      pulls and other forges refused, traversal-shaped paths refused)
- [x] Issue + repository metadata via injected GitHub client (`gh api`,
      Zod-validated payloads, offline fixtures and a scripted argv runner)
- [x] Default branch resolution + exact base commit SHA, with provenance
      (`local-git` HEAD on the default branch, else GitHub branch head, else
      `NOT_AVAILABLE`)
- [x] Existing-local-repo path: read-only `git` probes, dirty-state detection,
      detached HEAD, linked worktree and bare-repository detection
- [x] Cross-check that `--repo` is the issue's repository; refuse to base work
      on a mismatched clone
- [x] Versioned run record (`.mergesutra/runs/<id>.json`) written atomically,
      schema-validated on load, corrupt files reported not hidden
- [x] Injection *signalling* on imported issue text (labels as data, never
      blocks); no model call and no patch is produced by this stage

## Stage 2 — Repository policy compiler — **[DONE]**

- [x] Confined, read-only repository reader (realpath containment, byte-bounded
      reads that report `truncated`, capped listings, no writes)
- [x] Detect manifests / CI / lint / format / test config (ecosystem, package
      manager from lockfiles, runtime version, declared scripts, workflow `run:`
      commands with file + line provenance)
- [x] Derive structured repository contract (runtime, package manager, required
      checks, protected areas) with per-field provenance
- [x] Gates classified only from repository evidence: `REPOSITORY_REQUIRED`
      needs a CI step that reaches it, `DECLARED_ONLY` for a script nothing
      runs, `NOT_DECLARED` otherwise; declared-script chains followed to depth
      3; unclassifiable CI steps counted in the limitations
- [x] CI coverage stated honestly (`full` vs `partial` with the YAML constructs
      MergeSutra does not expand)
- [x] Treat repository text as data, never authority: the contract is marked
      `untrusted`, redacted before persistence, and contribution-doc prose never
      becomes a check
- [x] `mergesutra inspect [path]` writes the contract into a versioned run
      record; `--json` returns the parsed record
- [x] Not done on purpose: branch protection / required reviewers / merge
      policies are repository settings and were not queried

## Stage 3 — Acceptance Contract engine — **[DONE]**

- [x] Acceptance Contract + criterion Zod schemas, built so the dishonest states
      are unconstructible: `PASS` requires executed evidence, executed evidence
      requires an exit code or a stated reason, `PENDING` forbids evidence, and
      undeclared fields (`confidence`, free-text notes) are rejected
- [x] Criteria derived deterministically from the issue's own acceptance list
      (copied verbatim), the Stage 2 repository contract's `REPOSITORY_REQUIRED`
      gates (with CI file + line provenance), and named human injections
- [x] Non-requirements filtered, not guessed at: bullets under an unrelated
      heading, links, notes and stack traces; repeated items merged with a
      limitation that says so
- [x] Stable ids (`AC-1…`) in derivation order — issue first, then repository —
      and versioning with `withRevision`, which refuses a revision without a
      recorded reason and lists the ids that moved
- [x] An empty contract is refused outright: "no obligations" is a claim about
      the issue, not an observation, so Stage 4's model proposals (with
      `MODEL CLAIM` labelling) are where inferred criteria will come from
- [x] `mergesutra contract [run-id]` writes a `contract`-stage record; the issue
      body's text is redacted before storage or printing; `--json` returns the
      parsed record; a run with no repository contract still derives from issue
      text but records the gap as `NOT_AVAILABLE`
- [x] Run record schema v3 carries both contracts distinctly; a v2 file is
      reported unreadable rather than trusted
- [x] Not done on purpose: no criterion is checked, no gate is run and no model
      is called by this stage, so every status it can emit is `PENDING`

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
