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

## Stage 5 — Safe worktree + controlled tools — **[DONE]**

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
      Git and real files rather than a scripted runner; the suite stood at 446
      green at that stage's close, with one live check that still skips without
      a key
- [x] Not done on purpose: Stage 5 adds **no CLI command**. `mergesutra run`
      stays planned and exits `2` until there is something to run; these
      modules are the safety layer a stage calls, and they are exercised by
      tests — two of which drive real Git in a scratch repository — not
      presented as a user feature. (Stage 6 called them with its own command,
      `mergesutra implement`; `run` still exits `2`.)
- [x] Known gap: the policy's confinement is lexical. The writer repeats it
      after resolving links, which is the enforcing copy; a future stage that
      runs a command must not treat a policy `ALLOW` as proof that the command
      cannot escape (the worktree is isolation for clarity, not a sandbox)

## Stage 6 — BharatCode implementation loop (bounded) — **[DONE]**

- [x] A closed action protocol (`src/implement/protocol.ts`): eight operations in
      a strict discriminated union — `READ_FILE`, `LIST_FILES`, `SEARCH`,
      `WRITE_FILE`, `RUN_CHECK`, `PROPOSE_CONTRACT_REVISION`, `FINISH`,
      `BLOCKED`. Every variant is `.strict()`, so `{action:'WRITE_FILE', …,
      force:true}` is a refusal rather than an ignored field, and an invented
      action name is answered with the list of real ones. There is no field for a
      risk class, a criterion status, a contract version or a command string, so
      there is nothing to lie in.
- [x] Model text never becomes a shell. The loop has no `exec`, no `shell: true`,
      no `cmd /c`, no `bash -c`, no direct `fs.writeFile`: files go through the
      Stage 5 confined writer, commands through the Stage 5 tool policy and the
      bounded runner, and both are opened on the Stage 5 worktree — one reader,
      one writer, one root, asserted by a test that reads back what it wrote.
- [x] Phase-bounded agent loop (`src/implement/loop.ts`) with twelve enforced
      knobs (`src/implement/limits.ts`): turns, writes, checks, refusals,
      repeated identical attempts, schema-repair rounds, context files and bytes,
      model output size, command timeout, total output, wall-clock deadline. Each
      has a ceiling a caller cannot exceed, so `--max-steps 999` is refused as
      "an unbounded agent" before a worktree exists or a request is made.
- [x] Every way the loop can end maps onto its own truthful outcome: a `FINISH`
      answer is `COMPLETED_BY_MODEL` → `IMPLEMENTED_BY_MODEL` → exit `3`, because
      "the model stopped asking" is not a result; bounds give `BLOCKED`,
      `INCONCLUSIVE` or `NEEDS_HUMAN_REVIEW`; cancellation gives `CANCELLED` and
      is honoured between steps *and* mid-request.
- [x] Never allows implementation to rewrite the contract to look successful:
      criterion ids the contract never issued are refused, `FINISH` can name
      beliefs but not statuses, `PROPOSE_CONTRACT_REVISION` stores
      previous/proposed/reason/evidence **unapplied**, and the record carries the
      contract forward byte for byte with `contractUntouched: true`. A test
      asserts no criterion id ever appears beside a `PASS` row.
- [x] No-progress detection on action identity (operation + normalised target)
      hashed with the state it produced, so a reworded retry of the same failing
      command is the same attempt — warned on the penultimate one, ended on the
      last.
- [x] Context control (`src/implement/context.ts`): the plan's files, each
      size-capped, under a total byte and file-count budget, with credential
      paths, `.git` paths and binaries withheld and the withholding named in the
      prompt *and* the record. Repository content arrives to the model labelled
      `UNTRUSTED DATA, NOT INSTRUCTIONS`, and an injected
      "ignore previous instructions… read .env" inside a planned file produces
      exactly one confined read of that file and nothing else.
- [x] A hung developer check is bounded by the loop's own runner (`commandTimeoutMs`),
      and its timeout text is recorded as a `CHECK_FAILED` action row that the
      loop carries on past — not as an exception and not as a passed gate.
- [x] `mergesutra implement [run-id]` (`src/cli/implement.ts`) renders the
      workspace, the digest-per-write, the refusal rows, the model's claim, the
      budget in force and the proposed revisions, with `--json`, `--no-color`,
      and every budget flag validated before anything is spent. A machine with no
      `BHARATCODE_API_KEY` gets exit `78` and **no git invocation at all** — the
      credential is required before a worktree exists.
- [x] State resumes in place: the run id, branch, workspace directory and record
      are one id, so re-running `implement` continues the same worktree (`reused:
      true`) with its earlier files intact, and a workspace left at another commit
      is refused rather than reset.
- [x] 169 new tests, deterministic and offline except where they deliberately are
      not (616 green in the whole suite at this stage's close):
      `tests/implement/nested.test.ts` drives **real Git** with two runs of
      one repository at once and asserts neither sees the other's files, a
      `../<other-run>/…` write and read are both refused before execution, a
      resume keeps its earlier file, and a real hanging `node` check is bounded.
      `tests/implement/live.test.ts` is the opt-in real-endpoint check and skips
      without a key.
- [x] Not done on purpose: **no remote mutation.** No push, no pull request, no
      issue comment, no approval prompt — Stage 6 stops at files in a worktree.
      No verification either: no criterion changes status, because nothing here
      checked one, and `Verification` is reported as `NOT_AVAILABLE` rather than
      omitted.
- [x] Known gap: writes are whole-file, so a model that wants a three-line change
      in a large file must resend it (capped at 64 KiB per action), and a rewrite
      can clobber an edit made in the same workspace by someone else — the
      worktree belongs to one run, and nothing is committed.
- [x] Known gap: `RUN_CHECK` executes inside the worktree through the real
      runner, and a worktree is isolation for clarity, not a sandbox. A policy
      `ALLOW` proves the argv was not destructive; it does not prove the command
      cannot write outside the workspace by naming an absolute path itself.

## Stage 7 — Deterministic verification engine — **[DONE]**

- [x] Gate discovery from repository evidence only (`src/verify/gates.ts`): a gate
      exists when a CI workflow step or a declared package script runs the command.
      Prose in a contributing guide, a config file that implies a tool and a
      MergeSutra preference all *corroborate* a gate and never create one. Each
      gate carries `provenance` (source, file, line — a reviewer can open it) and a
      separate `requirementLevel`: `REPOSITORY_REQUIRED` (a CI step reaches it),
      `REPOSITORY_SUGGESTED` (declared, nothing runs it), `MERGESUTRA_ADDITIONAL`
      (the builtin `git diff --check`), and `USER_REQUESTED`, which is in the
      vocabulary so an operator-supplied gate has a label later and which nothing
      in this build emits — a criterion's stated check never creates a gate, it
      only matches one.
- [x] A candidate that cannot be honoured is refused loudly with its file and line
      — a step needing a shell, an install, or a script the manifest never declares
      is reported rather than dropped, so "CI has five steps, two became gates" is
      visible instead of being a silent narrowing.
- [x] `commandForms`: the invocation plus every script body it really reaches, so
      `npm test` and the `vitest run` behind it are one command for the one question
      "does this gate speak to this criterion's stated check". Case-preserving, and
      still a spelling match against commands the gate reaches — not a theme, not a
      guess about what a suite covers.
- [x] Gate kinds are the Stage 2 vocabulary and nothing else — `format`, `lint`,
      `typecheck`, `test`, `build` — assigned from the command the repository
      spells, not from a guess about its intent. Node-TypeScript-JavaScript comes
      first through the manifests Stage 2 already reads; a repository that declares
      no scripts still yields the gates its CI workflow runs, which is the generic
      fallback.
- [x] `executionClass` (`READ_ONLY` / `MUTATION_CAPABLE`) is a disclosure, not a
      switch: the workspace is re-described after *every* gate, because a test
      suite can write a snapshot file too.
- [x] Patch identity (`src/verify/patch.ts`): the sha-256 of the run's own
      uncommitted state (tracked diff, untracked additions, deletions, renames as
      one gone and one arrived), with Git scratch, `.mergesutra/` and nested
      worktrees excluded even when the repository forgot to ignore them. Every
      receipt names it, and evidence whose identity no longer matches the workspace
      is marked `STALE` in the report rather than trusted silently.
- [x] Execution consent (`src/verify/consent.ts`): a repository command runs only
      under `--allow VG-00n`, per gate, bound to this plan's digest, this command
      and this patch — change any of the three and the consent stops matching.
      `mergesutra verify <run>` with no consent writes the plan, refuses every
      repository gate, prints the exact ids and the re-run line, and exits `4`.
- [x] Receipts (`src/verify/receipt.ts`): one row per gate — argv, exit code,
      termination, bounded stdout/stderr tail, duration. The exit code is the
      verdict and nothing else is consulted; a gate that could not start is
      `BLOCKED` rather than `FAIL`, and a timeout says the process was stopped, not
      that the patch is wrong.
- [x] Contamination detection (`src/verify/engine.ts`): a gate that leaves the
      workspace different from how it found it invalidates the run's verdict rather
      than adding a receipt, because the next gate would be measuring a patch
      MergeSutra never identified.
- [x] Evidence mapping (`src/verify/evidence.ts`): a criterion's `status` stays one
      of the six truthful values and its `sufficiency` says how much of it the
      receipts carried (`VERIFIED` / `PARTIALLY_VERIFIED` / `NOT_VERIFIED` /
      `FAILED` / `BLOCKED` / `MANUAL_REVIEW_REQUIRED`). `PASS` requires an executed
      gate whose command forms match that criterion's own check; one criterion
      passing never carries another; no numeric confidence exists to be inflated.
- [x] Model output can never produce a deterministic `PASS`: the implementation
      loop's `FINISH` is filed as a claim, rendered under its own heading labelled
      "a claim; decided nothing", and no status rests on it.
- [x] Run record v6 carries four new Stage 7 documents (`verificationPlan`,
      `executionConsent`, `verification`, `evidence`); a v5 file is reported
      unreadable rather than guessed at, and `contributionReady` is
      `z.literal(false)` in the evidence schema, so "verified, therefore ready to
      submit" is unconstructible rather than merely unadvised.
- [x] `mergesutra verify [run-id] [--allow VG-001 …] [--json] [--no-color]`
      (`src/cli/verify.ts`, `src/verify/stage.ts`) reads the run's real state, the
      patch really on disk and the model's real claim; `mergesutra run` still exits
      `2`. Stage 7 logic lives in `src/verify/`, not in the implementation loop.
- [x] Hero integration fixture (`tests/verify/hero.test.ts`): a scratch Git
      repository whose CI demands a regression test that does not exist yet, taken
      through `inspect` → `contract` → `plan` → `implement` → `verify` with the real
      stages, real `node --test` child processes and the real patch identity. The
      AC→VG trace is asserted twice — structurally on the evidence document and
      textually on the printed report — and the fixture carries its own teeth: a
      final assertion that the regression test *fails* against the base commit, so
      no part of the chain can pass by being hard-wired.
- [x] 144 offline, deterministic tests for the stage — 140 across `tests/verify/*`
      and 4 in `tests/cli/verify.test.ts` — with no network, no credential and no
      live BharatCode call. `npm run check` is green at this stage's close with
      **800 passing and 2 skipped** (the two opt-in live-endpoint checks, which
      skip on a machine with no `BHARATCODE_API_KEY` rather than pretending).
- [x] Regression evidence is a narrow, explicit mechanism, not an orchestration
      (`compareRegressionEvidence` in `src/verify/evidence.ts`): it takes two
      receipts of *the same gate* on *the same base commit* with *different patch
      identities*, and says only what it can see — base `FAIL` and patch `PASS` is
      regression evidence, both-`PASS` explicitly is not, and a pair that does not
      match is refused as a mistake rather than recorded as inconclusive. The
      `statement` carries its own limit into the record.
- [x] Not done on purpose: **no base-run orchestration.** Nothing in `verify`
      creates a second workspace or re-runs a gate against the base commit, because
      a stage that silently runs the suite twice doubles the commands a human
      consented to. The two receipts a regression comparison needs are supplied by
      a caller that ran both, and `tests/verify/hero.test.ts` proves the base side
      by hand: the same regression command, executed against the base commit's
      code, exits non-zero.
- [x] Not done on purpose: **no `CONTRIBUTION_READY`.** Stage 7 emits
      `VERIFICATION_PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE` / `CANCELLED` and
      hands off to review; the ready verdict belongs to a later stage that has seen
      a diff reviewer and a human.
- [x] Not done on purpose: no gate is *fixed* by this stage — no `--fix`, no
      `prettier --write`, no retry after mutating the workspace, no dependency
      install. A missing `node_modules` is a sentence in `missingPrerequisites`.
- [x] Not done, and the earlier box for it was aspirational: **secret-scan and
      scope-guard are not gates.** Stage 7's only MergeSutra-added gate is
      `git diff --check`. Credentials are kept out of records by central redaction
      on the write path (Stage 0 onwards) rather than by a gate that scans for them
      after the fact, and the adversarial scan-and-contamination hardening belongs
      to Stage 12, where it can be tested against real secrets rather than asserted.
- [x] Known gap: the heuristic that reads a command's purpose (`--check`,
      `node --test`, a script body) is qualified on Node/TypeScript/JavaScript and
      on the generic "whatever CI runs" path. Its regexes name `pytest`, `unittest`
      and `phpunit`, but this build has no non-Node repository run, so a Python,
      Go, Rust or Java gate is reported with its provenance and stays consent-gated
      while its `executionClass` deserves a human's eye.
- [x] Known gap: the hero fixture's criteria are numbered with the repository's own
      CI demand first (`AC-1`, from the workflow) and the human-stated ones after
      (`AC-2`, `AC-3`), which is Stage 3's derivation order and not a re-numbering
      for the demo; the trace it proves is `AC-1, AC-2 → VG-001` and
      `AC-3 → VG-002`.
- [x] Known gap: the hero exercises the whole chain, not every branch of it. The
      script-body spelling widening in `commandForms` is covered by
      `tests/verify/gates.test.ts` and `tests/verify/evidence.test.ts`, which fail
      without it; the hero stays green either way, because its criteria quote the
      command the way CI spells it.

## Stage 8 — Evidence mapping + report — **[DONE]**

The criterion-to-evidence mapping and the command receipts were the substance of
Stage 7 and shipped there, so what is left in this stage is packaging them for a
human reader rather than deriving anything new:

- [x] `.mergesutra/runs/<id>/` evidence pack: `report.md`, `report.json`,
      `commands.jsonl`, beside the run record that already holds them. The pack is
      a rendering and that is its whole discipline: `report.json` carries the
      record's `evidence` object verbatim, `commands.jsonl` re-emits each receipt
      exactly as the engine filed it (re-encoding one would put two versions of the
      same fact on disk), and `report.md`'s criteria table copies each row's
      status, sufficiency and gate ids out of the record. `src/report/` computes no
      verdict.
- [x] `mergesutra report [run-id]` with `--json`, rendering the pack for a reviewer
      without re-deciding any status. With no run id it takes the newest record in
      `.mergesutra/runs/`; with no record at all it refuses rather than writing an
      empty pack. Its exit code is the recorded outcome's, so a report of a blocked
      run exits 4 — having been written neatly is not success.
- [x] A run that never verified cannot acquire a passing row from this stage: the
      same builder fed a contract-stage record prints `PENDING` beside `no
      verification has run`, and `tests/report/pack.test.ts` holds that no
      `VERIFIED`, `PASS` or "contribution ready" text appears in that pack at all.
- [x] The model's own account is printed, and labelled: the loop's FINISH sentence
      goes in a section named "What the model said about its own work (a claim;
      decided nothing)", and the test asserts the criteria table never contains it.
- [x] Caveats are printed under the document that wrote them. A run's `limitations`
      field grows by carry-forward, so a verify-stage record still holds "Nothing
      here is verified" — a sentence its own receipts disprove. Deleting it would be
      the pack deciding something; printing it in one flat list would be the pack
      re-asserting it. So `report.md` groups the notes three ways (the mapper, the
      stages of this run, the contract) and `report.json` keeps `stageLimitations`
      and `contractLimitations` apart.
- [x] Proved on a run that really happened, not only on fixtures:
      `tests/verify/hero.test.ts` files the verified record through the real
      filesystem store, reads it back through `runReportStage` into a temporary
      workspace, and checks the three files on disk — the three exit-0 receipts in
      `commands.jsonl`, the `AC-1, AC-2 → VG-001` and `AC-3 → VG-002` rows, the
      attribution above, and the absence of any `CONTRIBUTION_READY` string.
- [x] Writes are atomic and confined: the run id is validated before it touches a
      path, each file goes to a `.<pid>.tmp` sibling and is renamed into place with
      mode `0600`, and a traversal-shaped run id is refused with the file it would
      have landed on left alone.
- [x] Not done on purpose: the pack does not rank, score or summarise the evidence,
      does not decide which carried caveat a later stage answered, and never writes
      to the run record. `report` reads state and writes three files.
- [x] Known gap: a pack is rewritten whole on every call, so `.mergesutra/runs/<id>/`
      holds only the latest rendering of a run; the history of what a run claimed
      last week is not kept, and Stage 11's `status`/`resume` UX has to live with that.
- [x] Known gap: `report` renders whatever record it is pointed at, including one
      whose stage is `intake`, so a pack for an early run says very little and looks
      like any other pack. Stage 10's PR draft is where a reader is told which pack
      is complete enough to review.

## Stage 9 — Independent diff review + bounded repair routing — **[DONE]**

Stage 7 established what a repository's own gates prove and Stage 8 wrote it down.
This stage answers the question a green suite cannot: is the requirement actually
met? A second model pass reads the exact bytes the gates measured and files
findings about them. It has no tools and no authority, and the routing that turns a
finding into a work order is deterministic code, not the model's opinion of itself:

- [x] Critique-only reviewer (no silent edits). `mergesutra review [run-id]` reads a
      genuine persisted run — it refuses one with no contract, no implementation or
      no verification, rather than reviewing a partial story — and returns with the
      workspace **byte-identical**, including in the case that most needs proving: a
      review that found a real defect. The stage holds no writer and runs no gate; a
      `RunRecord` written by it carries a `review` document and at most one frozen
      `repairPlan`.
- [x] The patch is pinned before the question and re-measured after the answer
      (`src/review/engine.ts`, `reviewedPatchIdentity` / `currentPatchIdentity` /
      `patchPrecondition` on the attempt). Bytes that moved while the reviewer was
      reading make the account `STALE`: the outcome is `REVIEW_STALE`, exit `4`, and
      no finding from that answer is routed anywhere.
- [x] Citation is authored, not quoted. `review/manifest.ts` issues the only ids a
      finding may cite (`CTX-001`…, typed PATCH / SOURCE / CRITERION / RECEIPT /
      POLICY, each with what was actually sent and how much of it), and
      `review/disposition.ts` weighs every answer against it: uncited or unanchored
      is `UNSUPPORTED`, a repeat of an existing finding is `DUPLICATE`, anything
      outside the plan's stated scope is `OUT_OF_SCOPE`, security-sensitive or
      architectural complaints are `NEEDS_HUMAN_REVIEW`. **The reviewer never
      assigns its own disposition**, and the JSON shape it must return has no
      status, score, grade or verdict field.
- [x] Zero findings is reported as a limit, not a clean bill: the record gains a
      `REVIEW-EMPTY` caveat ("the absence of findings, not the absence of defects"),
      the outcome stays `REVIEW_RECORDED` with exit `3`, and the pack quotes the same
      sentence. A summary that reads as an approval is a failed answer, and the
      prompt says so before asking.
- [x] Bounded repair routing, frozen before the edit. `src/repair/plan.ts` builds a
      strict `RepairPlan` (files, gates, criteria, cycle numbers, digest) from the
      `VALID_REPAIR_CANDIDATE` findings only, under ceilings a caller cannot raise:
      2 review cycles, 2 repair cycles, 5 findings per cycle, provable at the module
      against a caller that asks for more (`tests/repair/plan.test.ts`). Past a
      ceiling the routing stops and the outcome is `REVIEW_NEEDS_HUMAN` — a decision
      somebody owes, with the bound that stopped it named in the record.
- [x] The reviewer's page defends its own structure. Material whose line is shaped
      like one of MergeSutra's section headings (`=== … ===`) is quoted behind a
      `> [data] ` marker and the count is disclosed at the bottom of the page, so
      planted text cannot open a section while every byte of it stays readable
      (`src/security/prompt-material.ts`, `src/review/prompt.ts`,
      `tests/review/prompt.test.ts`).
- [x] The lifecycle is encoded in state, not documented. `tests/review/hero.test.ts`
      takes a real scratch repository through `inspect` → `contract` → `plan` →
      `implement` → `verify` → `review` → a repair executed by Stage 6's own bounded
      loop and confined writer → `verify` again → `report`, on real Git objects and
      real `node --test` processes: patch A's receipts and review are shown to be
      about patch A, patch B mints new ones, and the pack written after the repair
      prints `Review: none recorded — nothing has read these bytes a second time`.
      The fixture carries its teeth: the impossible-day assertion the repair added
      is asserted to *fail* against the patch it replaced.
- [x] Green-but-wrong is the flagship case, because it is the one a suite cannot see:
      every gate passes and the requirement the issue was opened about is `VERIFIED`
      by a gate that never once handed the parser an impossible day. The reviewer
      files `CORRECTNESS` and `TEST_GAP` against those exact bytes; both route as
      repair candidates. The same file proves the opposite failure modes: a zero-
      finding answer mutates nothing, and a fabricated finding citing a real id for a
      claim the patch does not support is weighed, not believed.
- [x] Refusal, cancellation and unintelligibility damage nothing. A refused,
      unreachable, cancelled or unparseable answer still writes a record — with no
      review document in it, because there is nothing to file — and the patch,
      receipts, evidence and pack are untouched; `REVIEW_CANCELLED` is its own
      outcome, tested separately from a model that said no (`tests/review/stage.test.ts`).
- [x] Run record schema **v7**, additive: `review` and `repairPlan` fields plus the
      `REVIEW_*` outcomes and the `review` stage. A v6 record still parses and is
      rendered without invented findings, receipts or approvals — the pack says no
      review was recorded rather than implying one (`docs/DECISIONS.md`).
      *(Kept as written: v7 was the version at this stage's close. Stage 9R adds
      `repairExecutions` and becomes v8 — see below.)*
- [x] 192 offline, deterministic tests for the stage — 134 across `tests/review/*`,
      48 in `tests/repair/*`, 10 in `tests/cli/review.test.ts` — with no network, no
      credential and no live BharatCode call. `npm run check` is green at this
      stage's close with **1053 passing and 3 skipped** (the three opt-in
      live-endpoint checks: `tests/plan/live.test.ts`,
      `tests/implement/live.test.ts` and `tests/review/live.test.ts`,
      which skip unless a flag, a key and a model id are all present).
      *(Measured at this stage's close. Stage 9R re-counts both figures below rather
      than quietly restating them here.)*
- [x] One explicit opt-in live review smoke test (§35 of the stage brief):
      `tests/review/live.test.ts` asks the real endpoint once, about a real patch,
      and stays silent unless invited. It asserts only structural truths — the model
      id actually spoken to, the patch identity unchanged, every citation present in
      the manifest MergeSutra authored, no `CONTRIBUTION_READY` string, no credential
      in the record or in any pack file — because a model's agreement is not
      evidence either way.
- [x] **Not done on purpose: no command executes a repair.** Stage 9 routes work and
      freezes the scope; running a frozen plan would be a second writer with the
      loop's powers, and the brief's "do not build a second unrestricted editing
      agent" is honoured by not building one at all. The consequence is stated
      plainly rather than hidden: `classifyRepairScope` / `routeRepairScope` in
      `src/repair/scope.ts` have **no production caller** — the scope guard is proven
      by tests over the delta the hero run really produced, and the stage that wires
      it is the one that does not exist yet.
      *(Kept as written: this was true at Stage 9's close, and the sentence about a
      second unrestricted writer is why Stage 9R reuses Stage 6's loop instead of
      building one — see below. Both no-production-caller claims are now false:
      `classifyRepairScope` is called by `repair/execution.ts` and `routeRepairScope`
      by `repair/stage.ts`.)*
- [x] Not done on purpose: no verdict. There is no `REVIEW_PASS` outcome and no code
      path to a word like `PASS` from this stage; readiness stays in gate receipts
      and criterion statuses, where Stage 7 put it.
- [x] Known gap: **independent review, not an independent model.** The reviewer runs
      through the same adapter, possibly on the same model family, so this stage
      buys a second pass with different instructions and no tools, not a vendor
      diversity claim.
- [x] Known gap: the guard that stops quoted text impersonating a section heading is
      on the reviewer's page only. `plan` and `implement` still interpolate
      repository, issue and model text into their prompts ungarded; the shared
      primitive exists for them to call and the adversarial suite around it is
      [Stage 12](#stage-12--security-hardening) work.
      *(Narrowed, not closed, by Stage 9R: the repair brief the same reviewer's
      findings feed is now marked through the primitive too. `plan` and `implement`
      still only label their material — the gap below and the Stage 12 work stand.)*
- [x] Known gap: one question, one answer. A review is a single request (plus at most
      one bounded repair round for a malformed JSON answer), so a reviewer that
      misreads a file cannot be asked again within the run; `attempts` records how
      many answers it took, not how many exchanges happened.
- [x] Known gap: the reviewer cannot see what the context withheld. A file marked
      `WITHHELD` or `NOT_SENT` is listed and its content is not, so a defect that
      lives in a credential-shaped entry or a binary is reported as *the fact that it
      is in the patch* and nothing more — by rule, and the rule is tested.

## Stage 9R — Carrying out a frozen repair plan, and re-verifying what it changed — **[DONE]**

Stage 9 could say *this finding is worth a repair* and freeze the scope, and could
not act on it. This stage is the acting half — the only place in the product where a
run changes bytes after a person has read a plan — and it is built around the one
asymmetry an editing stage cannot design away: the thing that authorises the change
must not be the thing that decides the change was good.

- [x] `mergesutra repair [run-id]` — the only shipped command that edits a repository,
      and it edits only under `--approve-plan <64-hex>`, the digest of the plan Stage 9
      froze, typed after reading it. No `--yes`, no `--force`, no `--approve-all`, no
      environment variable that stands in for the digest: a repair approvable in
      advance is a repair approved without being read. The command's two halves have
      different needs — without an approval it prints the plan, the files, the gates
      and the exact line that would authorise it, and asks for no credential; with one,
      a missing `BHARATCODE_API_KEY` is a configuration refusal at exit `78` raised
      before a byte moves. `REPAIR_APPLIED` / `REPAIR_NEEDS_HUMAN` exit `3`,
      `REPAIR_BLOCKED` exits `4`; there is no exit `0` and no outcome that says a patch
      is good.
- [x] Approval is a capability, not a field in a document (`src/repair/digest.ts`,
      `src/repair/consent.ts`). The digest is canonical JSON with every list
      order-normalised, excluding `createdAt` and the model id; consent is stored
      beside the plan as `{ planDigest, approvedAt }` with three states — `MATCHED`,
      `ABSENT`, `STALE` — and no wildcard. A yes spent on cycle 1 does not authorise
      cycle 2; a yes typed for another plan is reported stale while naming both
      digests, and nothing is mutated to find out either way. `buildRepairExecution`
      recomputes the digest rather than accepting one, so the cycle's own document
      cannot be constructed without the match. ADR-052.
- [x] There is no second editing engine. A cycle calls Stage 6's
      `runImplementationLoop`, so there is one writer, one compare-before-write rule,
      one confined filesystem and one place a `shell: true` could ever appear — and it
      calls it under a `LoopBrief` (`src/implement/loop.ts`, `implement/prompt.ts`)
      that narrows the files the cycle may write: a `WRITE_FILE` outside the brief is
      refused before the writer sees it, and Stage 5's policy still outranks the plan,
      so a plan that names `.git/config` gets no write either. A repair gets a smaller
      budget than an implementation (`src/repair/limits.ts`: 6 steps / 3 writes / 2
      commands by default, ceilings 8 / 4 / 3, each axis also clamped against Stage
      6's *default*); asking for more clamps it rather than raising it, and the record
      says which numbers ran. ADR-053.
- [x] The cycle is briefed, not regaled (`src/repair/context.ts`): the findings the
      plan carried, the criteria those findings name, the receipts the plan answers to,
      the files the plan froze — and not the reviewer's closing summary, not the
      earlier loop's account of its own work, not a criterion the plan never named.
      The page states its own exclusions so an omission is visible. Review-finding
      text shaped like a section heading is quoted behind the shared `> [data] `
      marker, whole findings are dropped rather than truncated when the brief outgrows
      its budget, and a plan from another run, another patch, or a finding already
      routed to a human is refused rather than reinterpreted.
- [x] Verification after a repair is not optional and not a new product. The stage
      classifies the real A→B delta, and only when bytes moved runs Stage 7's own
      round through the reusable entry point (`verifyWorkspace` in
      `src/verify/workspace.ts`), reusing the consent on file only for the same
      commands under §16's rule and reporting it as missing otherwise; the evidence is
      remapped from the new receipts and Stage 8's `buildEvidencePack` /
      `writeEvidencePack` regenerate `report.md`, `report.json` and `commands.jsonl`.
      A pack that cannot be written is said so in the checks and the old one is left
      standing, not re-labelled. A cycle that left no trace is not re-verified either,
      and the page says why.
- [x] Nothing is cleaned up, and nothing is retried into green. A cycle that reached
      outside its plan is filed `OUTSIDE_PLANNED_SCOPE`, routed to
      `NEEDS_HUMAN_REVIEW`, with the edit and the extra file left exactly where they
      are: no revert, no `git clean`, no `git reset`, no automatic second repair
      because a gate failed.
- [x] An interrupt is a fact, not a verdict. Cancelling before the first request files
      a cycle that edited nothing; cancelling after the edit runs no gate at all;
      cancelling mid-round files the half-run with verdict `CANCELLED`, one `PASS`
      where a gate genuinely produced a receipt and the rest `INCONCLUSIVE`.
- [x] `RepairExecution` (`src/repair/execution.ts`) is the record's shape for a cycle,
      and the run record grows to hold the list of them (**v8**, `repairExecutions`,
      nullable and defaulted so a v6 or v7 record still reads). It carries no verdict
      field, no criterion status and no room for model reasoning beyond the loop's own
      action log; `verificationRequired` is read off the patch delta. One defect was
      found and fixed here: a later `review` or `implement` over a repaired run used to
      drop the filed cycles from the record it re-saved.
- [x] Two guards that cannot be proven by running them are proven from the source:
      `tests/repair/source-shape.test.ts` enumerates every command a repair cycle can
      construct, classifies it with the production risk oracle and fails on a snapshot
      if a new one appears — with a positive control, so an empty scan cannot read as
      clean, and without ever starting a destructive command;
      `tests/repair/boundaries.test.ts` holds the import-side rule that only
      `src/repair/stage.ts` reaches the loop. `tests/bharatcode/client.test.ts` pins
      the endpoints a default-configured client calls, so a repair cannot silently
      widen where the patch's text goes.
- [x] 191 offline, deterministic tests for the stage — 181 across `tests/repair/*`, 10
      in `tests/cli/repair.test.ts` — none of which needs a credential.
      `tests/review/hero.test.ts` walks the whole way round on real Git objects and
      real `node --test` processes: `inspect → contract → plan → implement → verify →
      review → repair → verify → report`, with patch A's receipts and review shown to
      be about patch A, patch B minting new ones, and the fixture carrying its teeth —
      the case the repair added is asserted to *fail* against the patch it replaced.
      `MERGESUTRA_HERO_CAPTURE=1` over that test prints the screen the README quotes
      for Stage 9R, so the capture is a real stage's real output rather than prose
      about it. `npm run check`
      is green at this stage's close; the measured totals are in the CHANGELOG entry.
- [x] **Not done, and stated as a gap:** the `> [data] ` guard covers the reviewer's
      page and the repair brief and still not the `plan` or general `implement`
      prompts — [Stage 12](#stage-12--security-hardening) work. A repair cycle reaches
      the same adapter, and possibly the same model family, as the review that ordered
      it. `CONTRIBUTION_READY` remains unreachable and unclaimed: this stage's most
      hopeful screen says the bytes moved and the gates were re-run, which is not the
      same sentence. `mergesutra run`, `pr`, `status` and `resume` still exit `2` —
      Stage 10 owns approval, the PR draft and the publication boundary. *(Kept as
      written: Stage 10 above replaces the `pr` stub with the digest-bound candidate, the
      human gate and the disabled remote, and keeps the promise that no path through it
      publishes. `run`, `status` and `resume` are still stubs, still exit `2`, and are
      Stage 11's. Stage 11 has since taken `status` out of that list: it is a wired,
      read-only command that exits `0` for a blocked lifecycle and `1` only when there
      was nothing to describe — ADR-056. `run` and `resume` remain stubs, and `resume`
      is the rest of this stage.)*

## Stage 10 — Human approval + PR draft — **[DONE]**

Stage 10 is the publication boundary, and the boundary is the feature: a person reads a
page, says yes to that page by name, and nothing in the world changes. It is the only
stage whose most important output is a refusal, and it was built against the two ways a
stage like this one fails — an approval so loose it covers work nobody read, and an
approval so powerful that saying yes to a draft also handed over the hands that publish
it.

- [x] `mergesutra pr [run-id]` replaces the planned stub. It assembles the page, prints
      it, and takes a yes in exactly one form: `--approve <64-hex>`, the digest of the
      candidate on screen. `--yes`, `--force`, `--approve-all`, `--all` and
      `--dangerously-skip-approval` are not flags this command knows, and a test types
      them to prove nothing is filed when they are used. Outcomes are
      `PR_CANDIDATE_RECORDED` and `PR_APPROVED_LOCAL` at exit `3`, and
      `PR_PUBLICATION_BLOCKED` at exit `4`; there is no exit `0`, because "a page exists
      and nobody has approved it" is not a success and "a page exists and somebody has"
      is not a publication.
- [x] `PublicationCandidate` (`src/pr/candidate.ts`) is the one thing approvable: the
      repository, the base SHA, the measured patch, both branch names, the title and
      body, the evidence pack identity, the issue and whether the page closes it, the
      review cycle and the bytes it reviewed, both summaries and the caveats in recorded
      order. The schema is `.strict()` and carries no `approved`, no `shouldPublish`, no
      recommendation and no model id, so a candidate with a verdict inside it — from a
      planner, a reviewer, a repository file or a hand-edited record — does not parse at
      all. ADR-054.
- [x] The digest (`src/pr/digest.ts`) is fifteen labelled lines over exactly that, with
      the body folded in as `prBodySha256` and `createdAt` excluded on purpose: the same
      state frozen twice gives the same number, so recording an approval never expires
      the approval it records, and `STALE` in this product means the scope moved rather
      than a timer ran out. Nothing is fuzzy — and the document is validated through its
      own schema *before* it is hashed, so a forged candidate cannot produce a number to
      point at.
- [x] Approval is a capability with one door (`src/pr/approval.ts`): five fields, an
      `action` enum with the single member `CREATE_PULL_REQUEST`, and three states —
      `MATCHED`, `ABSENT`, `STALE` — reached by equality and nothing else.
      `approvePublication()` computes the digest rather than accepting one,
      `decidePublication()` returns a reason on every path and performs no act, and the
      CLI reads a yes from argv only: `process.env` is never consulted, which a test
      proves by stubbing the environment rather than by asserting a negative. ADR-054.
- [x] Readiness is a consumer's check, not a second verdict
      (`src/pr/readiness.ts`): eight facts in the order a reader would want them —
      `patch-measured`, `verification-current`, `verification-passed`, `review-current`,
      `no-repair-candidate-left`, `no-scope-violation`, `pack-current`,
      `human-approved` — each with its reason printed whether it passed or failed. Freshness
      is measured by the stage immediately before asking and handed over as a
      comparison, so this module cannot quietly re-interpret Stage 7 or Stage 9. Its two
      words are `HUMAN_APPROVED_FOR_PR` and `NOT_READY_FOR_PUBLICATION`;
      `CONTRIBUTION_READY` remains unreachable and unclaimed, and the module states its
      own exclusions so an omission is visible on the screen.
- [x] The draft is deterministic and holds no claims the run did not earn
      (`src/pr/draft.ts`): exactly eight sections — `Summary`, `Issue`,
      `Acceptance Contract`, `Implementation`, `Verification`, `Independent Review`,
      `Evidence`, `Limitations / Manual review` — built from Git's file list, Stage 7's
      receipts and Stage 9's findings, with the title and body bounded in length and run
      through central redaction. `Fixes #n` appears only when the issue identity,
      same-repository closure and verified evidence for every criterion are all on file
      for the current patch; otherwise the page says `Related to #n` and closes nothing
      it did not prove. A title quoted from the issue is refused if it borrows an
      overclaim, this program's own state words, or a closing keyword; ADR-055.
- [x] Both branch names come from recorded Git facts and nothing else
      (`src/pr/branch.ts`). The target is read, never chosen: only
      `repository.defaultBranch` and `local.defaultBranch` may name it, and where they
      disagree the answer is a block — which is why the function's arguments are two
      strings rather than a record, so no model document has a path into a target. The
      source reuses the branch Stage 5's worktree was created on, since proposing a second
      name for the same commits would misdescribe where the work lives. The alphabet rule
      is a list of what is allowed, because Git accepts `fix; rm -rf /` as a ref name and
      a name that will be typed near a shell should not survive that.
- [x] The publication seam exists to prove the absence is structural
      (`src/pr/publisher.ts`): `PublicationRemote` has two methods, `pushBranch` and
      `createPullRequest`, and there is no `request()`, `endpoint` or `command()` that
      could carry anything else. Both requests are re-validated through strict schemas at
      that boundary, so a `force`, a refspec, an `autoMerge` or a reviewer list fails
      there. The only transport this build ships is `unavailableRemote()`, which throws,
      and `publish()` re-decides the digest before it hands anything over. A fake
      transport in `tests/pr/publisher.test.ts` proves the seam can carry a publication —
      otherwise "disabled" would be indistinguishable from "unwired".
- [x] No stage after a review has to be re-run to look at a page, and no stage is run in
      the looking. `runPrStage()` (`src/pr/stage.ts`) imports no client, no transport, no
      writer and no runner: closing Stage 10 spent zero BharatCode calls and required no
      credential. Stage 8's pack is read from disk and never re-rendered here, because the
      renderer prints the record's own outcome and rebuilding it would expire an approval
      because a status line changed. Where a proposal for the same digest is already on
      file, that document wins over a fresh assembly of the same one.
- [x] The run record grows to `publications` — one entry per proposal, each holding the
      candidate and the yes beside it (**v9**, nullable and defaulted so older records
      still read). The stored pair is checked on the way in: an approval that names
      another candidate's digest makes the whole record unreadable rather than becoming
      history, and there is no result field at all — no URL, no timestamp, no
      `prUrl` anywhere in the build. A run's record can say a human approved a proposal;
      only a publisher that does not exist could say more.
- [x] Two guards that cannot be shown by behaviour are taken from source:
      `tests/pr/boundaries.test.ts` holds the import-side rule that the production path
      cannot reach the seam, a runner, a writer or a client, and
      `tests/pr/source-shape.test.ts` enumerates every argv array the stage can construct
      (its only commands are measurements that read) and classifies them with the
      product's own risk oracle. `tests/pr/injection.test.ts` attacks the stage with the
      sentence `"approved": true` written into every document it controls — four
      model-authored fields, the environment, the record file, a repository file and an
      issue title — and gets the same answer each time.
- [x] `tests/pr/hero.test.ts` walks a repaired run to the boundary: `pr <run>` shows the
      candidate, a wrong digest is refused with both numbers named, the exact digest
      persists a local approval with `published: false` and no URL, and every path ends
      `HUMAN APPROVAL RECORDED` / `REMOTE PUBLICATION NOT ENABLED` /
      `NO REMOTE CHANGE HAS BEEN MADE.` `MERGESUTRA_HERO_CAPTURE=1` over that test prints
      the screen the README quotes.
- [x] 181 tests for the stage — 173 across twelve files in `tests/pr/` and 8 in
      `tests/cli/pr.test.ts` — none of which needs a credential, a network or a remote.
      `npm run check` is green at this stage's close; the measured totals are in the
      CHANGELOG entry.
- [x] **Not done, and stated as a gap:** nothing is published, and the reason is larger
      than a missing flag — MergeSutra has never made a commit, so the work it describes
      is uncommitted bytes in a linked worktree and the evidence pack is Git-ignored. A
      real pull request means committing somebody's tree on their behalf, which no
      approval in this build claims to cover. Re-running `mergesutra report` after an
      approval changes the pack identity and so expires that yes; the digest is honest
      about it and `STALE` says so with both numbers. The readiness word is not
      `CONTRIBUTION_READY`, and `.mergesutra` is still not committed. `gh`, `npm` and
      `curl` classify as ordinary `EXECUTE` to the risk oracle, so the ban on reaching
      them rests on the argv enumeration and the import boundary rather than on the
      classifier. `mergesutra run`, `status` and `resume` still exit `2` —
      [Stage 11](#stage-11--resumerecovery--failure-ux) owns recovery and failure UX.

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
