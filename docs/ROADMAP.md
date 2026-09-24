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
      the issue, not an observation. `inferred` therefore stays a legal source
      that nothing emits — Stage 4's model proposals are labelled
      `MODEL CLAIM` inside the plan and enter the contract only if a human adds
      them with `--criterion`
- [x] `mergesutra contract [run-id]` writes a `contract`-stage record; the issue
      body's text is redacted before storage or printing; `--json` returns the
      parsed record; a run with no repository contract still derives from issue
      text but records the gap as `NOT_AVAILABLE`
- [x] Run record schema v3 carries both contracts distinctly; a v2 file is
      reported unreadable rather than trusted
- [x] Not done on purpose: no criterion is checked, no gate is run and no model
      is called by this stage, so every status it can emit is `PENDING`

## Stage 4 — BharatCode planner — **[DONE]**

- [x] `mergesutra plan [run-id]` asks BharatCode for one implementation plan
      against a run's Acceptance Contract — the first stage that spends a model
      call, and the last one that runs nothing
- [x] A model-proof schema: `strict()` everywhere, no field that could carry a
      status, evidence count or confidence, and `untrusted: true` defaulted by
      the schema rather than by the caller — a plan that claims to be trusted is
      refused
- [x] Criterion ids are a closed list: an id the contract never issued is
      refused, and so is a plan that quietly drops one. The refusal names the id
- [x] Paths must be repository-relative POSIX (`..`, absolute, drive-letter,
      backslash and symlink-shaped paths refused); commands must be argv arrays
      with no shell composition characters, because MergeSutra never runs a
      command string
- [x] MergeSutra writes the provenance — model and token counts read from the
      response envelope, contract run id and version, round-trip count — never
      the model
- [x] One bounded repair round trip against the same schema; a second bad answer
      is reported, not renegotiated
- [x] Model proposals stay proposals: `proposedCriteria` is labelled
      `MODEL CLAIM`, kept inside the plan, and cannot enter the contract. The
      human route is `mergesutra contract --criterion "…" --by "name"`, added so
      that sentence is true
- [x] Issue text and repository instructions reach the prompt as labelled
      material to analyse, never as instructions to obey, and are redacted
      before they are sent
- [x] `Execution` and `Verification` are `NOT_AVAILABLE` in every plan record;
      criteria stay `PENDING` after a plan is written
- [x] `plan` holds no process runner at all, by type as well as by behaviour
- [x] Run record schema v4 carries the plan beside the contract; a v3 file is
      reported unreadable rather than guessed at
- [x] 37 offline tests (`tests/plan/*`, `tests/cli/plan.test.ts`) plus two
      redaction regressions, against a suite of 378 green and one live check that
      skips unless `MERGESUTRA_LIVE_BHARATCODE=1` with a key and a model
      (`tests/plan/live.test.ts`)
- [x] Not done on purpose: no plan has been executed, and this build has not
      been pointed at a live BharatCode endpoint from a machine with a key — the
      captured sample uses the real adapter against a local stub
- [x] Known gap: `provenance.source` records that the answer came through the
      BharatCode adapter, not which origin served it; `BHARATCODE_API_BASE` is
      not stored in the record

## Stage 5 — Safe worktree + controlled tools

- [x] Dedicated Git worktree at the exact base SHA (`src/git/workspace.ts`), on
      the run's own branch `mergesutra/<run-id>`, nested under the ignored
      `.mergesutra/worktrees/` so a run cannot scatter directories in the repo
- [x] Pre-flight `git check-ignore` on the workspace path: if `.mergesutra` is
      not ignored the run refuses to create anything, because leaving thousands
      of untracked files in the human's checkout is worse than a blocked run
- [x] Dirty primary checkout is detected, counted, sampled and reported — and
      never stashed, cleaned, reset or removed; a second call reuses the
      workspace at the same SHA instead of making another one, and a workspace
      at a different SHA is refused rather than reset
- [x] Risk-classified tool controller (`src/process/tool-policy.ts`) with the
      six classes and one decision function: risk is derived from the operation
      and, for a command, from the argv — never accepted from the caller.
      `git push --force` offered as `execute` is still DESTRUCTIVE
- [x] REMOTE MUTATION needs a human approval that matches the action word for
      word; DESTRUCTIVE is refused with no approval path at all, including
      `sudo`, deletion programs, an interpreter handed a command string
      (`bash -c`, `node -e`), and a global git option that redirects git itself
      (`-c core.pager=…`, `--git-dir`, `--work-tree`)
- [x] Filesystem-write confinement (`src/security/writer.ts`): relative paths
      only, no `.git` segment in any spelling, every existing ancestor
      realpath'd and proved inside the root (traversal, absolute, symlink and
      Windows-junction defence), no write through a symlink, byte cap, atomic
      temp-plus-rename write, and no delete/rename/chmod method to call
- [x] Shared command-shape predicates (`src/security/command-safety.ts`) now
      used by the Stage 4 plan validator as well, so one rule has one copy
- [x] 68 new tests (`tests/git/workspace.test.ts`,
      `tests/process/tool-policy.test.ts`, `tests/security/writer.test.ts`,
      `tests/security/command-safety.test.ts`), including two that drive real
      Git and real files rather than a scripted runner; suite is 446 green with
      one live check that still skips without a key
- [x] Not done on purpose: Stage 5 adds **no CLI command**. `mergesutra run`
      stays planned and exits `2` until Stage 6 has something to run; these
      modules are the safety layer a stage calls, and they are exercised by
      tests — two of which drive real Git in a scratch repository — not
      presented as a user feature
- [x] Known gap: the policy's confinement is lexical. The writer repeats it
      after resolving links, which is the enforcing copy; a future stage that
      runs a command must not treat a policy `ALLOW` as proof that the command
      cannot escape (the worktree is isolation for clarity, not a sandbox)

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
