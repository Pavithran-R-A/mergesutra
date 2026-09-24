# Changelog

All notable changes to MergeSutra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Stage 5: the workspace, the tool policy and the write boundary

Everything a run needs in order to change files without touching the human's
checkout, and every rule that decides whether it is allowed to try. Stage 5 adds
**no CLI command** — `mergesutra run` still exits `2` — because these are the
gates the next stage passes through, not a feature to advertise. They are
exercised by tests — including two that drive real Git in a scratch repository —
whose refusals are quoted below rather than asserted.

- Workspace manager (`src/git/workspace.ts`): `prepareWorkspace` pins a run to
  the exact base SHA it recorded, verifies the commit exists (`cat-file -t`),
  and creates a dedicated `git worktree` on its own branch
  `mergesutra/<run-id>`, nested under the ignored `.mergesutra/worktrees/` so a
  run cannot scatter directories across a repository. The primary checkout's
  HEAD and branch are unchanged afterwards.
- A pre-flight `git check-ignore` decides whether a workspace may exist at all.
  If `.mergesutra` is not ignored, the run refuses and tells the human how to
  ignore it — leaving thousands of untracked files in someone's checkout is
  worse than a blocked run, and MergeSutra will not edit their `.gitignore` to
  fix it.
- A dirty primary checkout is counted, sampled and reported. Never stashed,
  cleaned, reset or removed. Calling `prepareWorkspace` twice reuses the
  workspace at the same SHA, refuses to reuse one at a different SHA instead of
  resetting it, and refuses to write into a directory it did not create.
- Risk-classified tool controller (`src/process/tool-policy.ts`) — six classes
  (`READ` `WRITE` `EXECUTE` `NETWORK` `REMOTE_MUTATION` `DESTRUCTIVE`) and one
  decision function. Risk is derived from the operation and, for a command, from
  the argv; it is never accepted from the caller, so
  `git push --force` offered as `execute` is still DESTRUCTIVE.
- Refused with no approval path at all: privilege escalation (`sudo`, `doas`,
  `runas`), deletion programs (`rm`, `del`, `diskpart`, `shred`, `dd`), an
  interpreter handed a command string (`bash -c`, `node -e`, `cmd /c`,
  `powershell -Command`), destructive Git (`clean`, `rebase`, `apply`, `am`,
  `filter-branch`, `gc`, `prune`, force pushes), and any global Git option that
  redirects Git itself (`-c core.pager=…` executes a program; `--git-dir`,
  `--work-tree` and `--exec-path` move the ground). Only `-C` and a few inert
  flags pass, so confinement cannot be argued out of.
- A remote mutation (push, PR, comment) is blocked until a human approves *this
  exact* action summary — a different summary is not covered by the approval.
  Network use is allowed but always classified and disclosed; no credential
  crosses it.
- Confined writer (`src/security/writer.ts`): the only filesystem-mutating module
  in the build. Repository-relative paths only; no `.git` segment in any
  spelling (a linked worktree's `.git` is a file, not a directory); every
  existing ancestor is realpath'd and proved inside the root, which catches
  traversal, absolute paths, symlinks and Windows junctions; no write through an
  existing symlink; a 1 MiB single-write cap; an atomic write to a temp file in
  the target directory, `fsync`'d, then renamed. It exposes `writeText` and
  `exists` — there is no delete, rename or chmod method to call.
- One copy of the command-shape rule (`src/security/command-safety.ts`), now
  shared by the Stage 4 plan validator instead of duplicated inside it: argv
  arrays, non-empty tokens, no `; & | ` $ < >` or newline.
- Two real bugs surfaced by Windows, both fixed: an 8.3 short path
  (`C:\Users\PAVITH~1\…`) is the same directory as
  `C:\Users\Pavithran R A\…` but not equal under `path.resolve`, so paths are
  compared after `realpath`; and case-insensitive containment needed the same
  treatment the lexical checker already had.
- Direct end-to-end evidence against real Git in a scratch repository: a
  worktree created at the pinned SHA (`reused: false`, primary
  `git status --porcelain` empty before and after), a second call reusing it,
  six writes refused with the reasons above, and thirteen tool requests decided —
  including `bash -c rm -rf /` and `git clean -fdx` refused,
  `git -C <workspace> status --porcelain` allowed, and a push blocked until the
  matching approval was supplied.
- 68 new tests (`tests/git/workspace.test.ts` including two that drive real Git
  and real files, `tests/process/tool-policy.test.ts`,
  `tests/security/writer.test.ts`, `tests/security/command-safety.test.ts`);
  the suite is 446 green with the one live-BharatCode check that still skips
  without a key.
- Known gap, stated rather than papered over: the *policy's* confinement is
  lexical, and the writer's is post-resolution. A stage that runs a command must
  not read a policy `ALLOW` as proof the command cannot escape — the worktree is
  isolation for clarity, not a sandbox.

### Added — Stage 4: BharatCode implementation plan

This is the first stage that asks a model anything. It executes nothing, changes
nothing, and cannot move a criterion off `PENDING` — the plan it stores is a
proposal with a type of its own, and the type has nowhere to put a result.

- `mergesutra plan [run-id]` — sends a run's Acceptance Contract to BharatCode
  and stores the validated plan. Exit codes: `0` `PLAN_COMPLETE`, `3`
  `INCONCLUSIVE` when the answer was refused, `1` when the source run has no
  contract, `78` when `BHARATCODE_API_KEY` is absent. `--json` emits the whole
  record. Without a key it refuses and says which variable to set; it never
  improvises a plan.
- Plan schema (`src/plan/schema.ts`): `strict()` throughout, with no `status`,
  `evidence`, `confidence` or `criteriaVerified` field to fill in, and
  `untrusted: true` applied by schema default rather than by the caller.
  Refuses a plan that reports a result.
- Obligation coverage: the criterion ids are handed over as a closed list. An
  invented id is refused; a dropped one is refused unless the plan names it under
  `criteriaUnaddressed` with a reason, and the refusal message quotes the id.
  One bounded repair round trip against the same schema, then a report.
- Model-proof path and command shapes: repository-relative POSIX paths only
  (`..`, absolute, drive-letter, backslash and traversal-shaped paths refused)
  and argv arrays with no shell composition characters. MergeSutra never runs a
  command string, and a proposal it could not run cannot be stored.
- Provenance is MergeSutra's, not the model's: the model name, token counts and
  round-trip count are read from the response envelope, alongside the contract
  run id and version. `Execution` and `Verification` are `NOT_AVAILABLE` in
  every plan record.
- Prompt (`src/plan/prompt.ts`) encloses the issue body and repository text as
  untrusted material to analyse rather than instructions to obey, and the whole
  payload is redacted before it leaves the machine.
- Model proposals stay proposals: `proposedCriteria` is rendered as
  `MODEL CLAIM, not requirements` and cannot enter the contract. To make that
  sentence actionable, `mergesutra contract --criterion "…" --by "name"` now
  lets a human state a requirement no file asserts, and refuses to do so
  anonymously.
- Run record schema v4 carries `plan` beside the two contracts; `stage` accepts
  `plan`, and the check statuses gained `INFO` for a row that reports what
  happened without judging it. Older v3 files are reported unreadable rather
  than guessed at.
- Two defects found by wiring this stage, both fixed with regressions:
  `Redactor.deep()` masked any value under a secret-shaped key, turning
  `promptTokens: 120` into a string and making a valid plan record unparseable
  (it now masks string leaves only), and `complete()` reported "No BharatCode
  model selected" when the real problem was a missing API key (the key is now
  checked first).
- 37 additional offline tests (378 total, all green offline) plus
  `tests/plan/live.test.ts`, which skips unless `MERGESUTRA_LIVE_BHARATCODE=1`
  is set alongside a key and a model. No test calls the network or needs a
  secret.

### Added — Stage 3: Acceptance Contract

This stage turns what a run already knows into the list of things it must prove.
It calls no model, executes nothing, and verifies nothing — so every criterion
it produces is `PENDING`, and it says so.

- Acceptance Contract schema (`src/contract/schema.ts`) built from Zod
  discriminated unions, so the states a run must not reach are unconstructible:
  a `PASS` cannot exist without executed evidence, an executed evidence cannot
  exist without an exit code or a stated reason, a `PENDING` cannot carry
  evidence, and undeclared fields (a `confidence` score, a free-text note) are
  rejected. Criterion statuses are `PENDING / PASS / FAIL / SKIPPED /
  NOT_AVAILABLE / BLOCKED / INCONCLUSIVE`.
- Deterministic derivation (`src/contract/derive.ts`): a criterion comes only
  from the issue's own acceptance list (copied verbatim, never interpreted), a
  `REPOSITORY_REQUIRED` gate with the CI file and line that cited it, or a named
  human injection recorded as `MERGESUTRA_ADDITIONAL`. Bullets under a heading
  that is not about acceptance are not mined; links, notes and repeated items
  are filtered or merged with a limitation. An empty contract is refused rather
  than emitted, because "no obligations" is a claim about the issue.
- `mergesutra contract [run-id]` — reads a run, derives its criteria and writes
  a `contract`-stage record. Exit codes: `0` `CONTRACT_DERIVED`, `3`
  `INCONCLUSIVE` when nothing could be derived, `1` when there is no run to read
  (it names the stage to run first). The printed table and the stored record
  carry the same `Verification NOT_AVAILABLE` row.
- Criteria are redacted with the central `Redactor` before they are stored or
  printed, so a credential pasted into an issue body cannot be laundered into a
  contract that later stages forward.
- Run record schema v3: a record now carries both contracts distinctly — the
  repository contract from Stage 2 and the Acceptance Contract from Stage 3.
  `createRunRecord` had been dropping the Acceptance Contract field, so a
  contract-stage record lost its criteria on write; it is now threaded through
  and covered by a round-trip test. Older v2 run files are reported as
  unreadable rather than trusted.
- `withRevision` refuses to rewrite criteria without a recorded reason, so a
  later stage cannot quietly move the goalposts after a failure.
- 32 additional offline tests (338 total), including an end-to-end Stage 2 →
  Stage 3 chain against fixture repositories with no network and no
  `gh` invocation.

### Added — Stage 2: repository policy compiler

This stage reads a repository and records what the repository itself requires.
It executes nothing from the repository, patches nothing, and verifies nothing.

- `mergesutra inspect [path]` — compiles a repository's own policy into a
  provenanced **repository contract** and writes it into a versioned run
  record. Read-only: nothing in the repository is executed, and only
  `.mergesutra/` is written. `--json` emits the parsed record. Exit codes: `0`
  `INSPECT_COMPLETE`, `3` `INCONCLUSIVE`, `1` on an unusable path.
- Confined read-only repository reader (`src/discovery/repo-fs.ts`): every path
  is resolved with `realpath` and must stay inside the root (traversal, absolute
  and symlink/junction escapes are refused), reads are byte-bounded and report
  `truncated` explicitly rather than silently cutting content, directory
  listings are capped, and nothing writes.
- Manifest and toolchain detection (`src/discovery/manifests.ts`): ecosystem,
  package manager inferred from lockfiles, runtime version from
  `.nvmrc`/`.node-version`/`engines`, and declared scripts — each carrying the
  file and detail it came from. An unreadable manifest is listed as unreadable,
  never guessed past.
- CI discovery (`src/discovery/ci.ts`): workflows under
  `.github/workflows/*.yml`, job ids, and `run:` commands with workflow + line
  provenance. Because this is a bounded line scan and not a YAML engine,
  anchors, aliases, merge keys and matrices are recorded as caveats and the
  coverage is honestly marked `partial`.
- Gate classification (`src/discovery/contract.ts`): format / lint / typecheck /
  test / build rows are `REPOSITORY_REQUIRED` **only** when a CI step reaches
  them, `DECLARED_ONLY` when a script exists that no CI step runs, and
  `NOT_DECLARED` otherwise. A declared script chain is followed to a bounded
  depth (3) so `npm run check` resolves to the commands it actually runs, and
  a script that can write (`prettier --write .`) is never named as the gate a
  read-only check needs. CI steps that cannot be classified are counted in the
  limitations instead of being dropped.
- Contribution-doc scan and `CODEOWNERS` summary: shape and counts only. Prose
  is recorded as data and never becomes a check.
- The contract is redacted with the central `Redactor` before it is persisted,
  so a credential embedded in a manifest script cannot reach a run record.
- Repository text is tagged `untrusted: true` in the contract, and every
  limitation MergeSutra could not establish is listed rather than left silent
  (including that branch protection and merge policies were never queried).
- 107 additional offline tests (306 total) against in-memory fixture
  repositories, including real junction/symlink escape attempts on Windows.

### Added — Stage 1: repository and GitHub issue intake

This stage reads and records; it does not patch, verify, review or open anything.

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

`run`, `verify`, `review`, `report`, `pr`, `status`,
`resume`. `issue` performs intake only: it produces no plan, patch,
verification, review or PR draft, and says so on the last two lines. `inspect`
and `contract` read and record; `plan` consults BharatCode and records what it
said. None of them runs a gate, so no criterion is ever proven before Stage 7.
Invoking a planned command reports a truthful "planned" message and exits `2`.

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
