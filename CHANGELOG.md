# Changelog

All notable changes to MergeSutra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Stage 8: the evidence pack, and a report that cannot be over-read

Stage 7 put the verdicts in the run record. Stage 8 is the first time a reader
gets them without a JavaScript REPL, and the whole design problem was packaging
without adding: a reviewer who has to run a gate to see what a run established is
a reviewer who is doing the harness's job.

- `mergesutra report [run-id]` — reads one run record and writes three files
  beside it under `.mergesutra/runs/<run-id>/`: `report.md` for a human,
  `report.json` for a tool, `commands.jsonl` with one command receipt per line.
  With no id it takes the newest record in the run store; with no readable record
  it refuses instead of writing an empty pack. `--json` prints the machine file
  instead of the human one. Flags: `--json`, `--no-color`. Exit codes come from
  the *recorded outcome*, not from the write: `0` for a passed or contract-derived
  run, `1` for `VERIFICATION_FAIL`, `3` inconclusive, `4` blocked — so a tidy
  report of a blocked run is still a blocked exit.
- `src/report/pack.ts` is a renderer with one rule: it may arrange the record's
  facts and may not add one. The criteria table copies each row's status,
  sufficiency and gate ids out of `record.evidence`; `report.json` embeds that
  evidence document, the verification plan and the execution consent as they were
  filed; `commands.jsonl` re-emits each receipt verbatim rather than summarising
  it, because a digest already covers the unredacted bytes. A pack built from a
  run that never verified prints `PENDING` and `no verification has run`, and
  there is no `VERIFIED` or `PASS` anywhere in it to misread.
- Caveats are printed under the document that wrote them. A run's `limitations`
  grows by carry-forward, so a verify-stage record still holds "Nothing here is
  verified" — words that were true of the stage that wrote them and are false of
  the run. Deleting the line would be the pack deciding something, so it does not:
  `report.md` groups the notes as the evidence mapper's, the stages of this run's,
  and the contract's, in that order, and `report.json` keeps `stageLimitations`
  and `contractLimitations` as separate keys.
- The model's own account stays visible and quarantined. The loop's `FINISH`
  sentence is printed under "What the model said about its own work (a claim;
  decided nothing)", and the test asserts the criteria table above it never
  contains that sentence.
- Writes are confined and atomic: the run id is validated as a path segment
  before it is used, each file is written to a `.tmp` sibling with mode `0600`
  and renamed into place, and a traversal-shaped id is refused without touching
  the filesystem.
- `tests/verify/hero.test.ts` now ends at the pack: the hero's verified record is
  saved through the real filesystem store, rendered by the same code path the
  command uses, and the three files are read back off disk — the three exit-0
  receipts, the `AC-1, AC-2 → VG-001` and `AC-3 → VG-002` rows, and the caveat
  attribution. This is the stage's own proof: the fixture-driven tests could not
  see that a record produced by six real stages renders the way a fixture does,
  and it is where the carried-forward "Nothing here is verified" contradiction
  was found.
- 19 tests of the stage's own — 10 in `tests/report/pack.test.ts`, 4 in
  `tests/report/write.test.ts`, 5 in `tests/cli/report.test.ts`, plus a new case
  in `tests/cli/program.test.ts` and the pack block added to the hero test —
  deterministic and offline; no Stage 8 test needs a BharatCode credential,
  because `report` makes no model call at all. Measured against the same
  command line: **820 passing and 2 skipped** (822 tests, up from the 800
  passing at Stage 7's close; the two skips are the opt-in live-endpoint checks
  that still need a credential).
  `mergesutra run`, `review`, `pr`, `status` and `resume` still exit
  `2`.

### Added — Stage 7: the deterministic verification engine

The first stage that can move an acceptance criterion off `PENDING`, and the only
one that can do it from something other than a model's own account. BharatCode
proposed; the repository's tools executed under policy; here, deterministic gates
observe and an evidence record says what actually happened.

- `mergesutra verify [run-id]` — plans a repository's own gates against the patch
  an implementation run left on disk, runs the ones the operator names, and files
  their receipts against the criteria they prove. Flags: `--repo`,
  `--allow VG-001` (repeatable), `--json`, `--no-color`. Exit codes: `0`
  `VERIFICATION_PASS`, `1` `VERIFICATION_FAIL`, `4` `VERIFICATION_BLOCKED`, `3`
  `VERIFICATION_INCONCLUSIVE` — and `4` is what an unconsented run returns, because
  "I did not run your tests" is a blocked state, not a success.
- Gate discovery with provenance a reviewer can open (`src/verify/gates.ts`): a
  gate exists when a CI workflow step or a declared package script runs it, and
  each one carries its file and line plus a `requirementLevel` —
  `REPOSITORY_REQUIRED`, `REPOSITORY_SUGGESTED` (declared, nothing runs it),
  `MERGESUTRA_ADDITIONAL` (MergeSutra's own `git diff --check`, labelled as its
  own), and `USER_REQUESTED`, which nothing emits yet. Prose in a contributing
  guide corroborates a gate and never creates one; a CI step MergeSutra cannot
  translate is refused loudly with its location rather than dropped, so "five
  steps, two gates" stays visible.
- Patch identity (`src/verify/patch.ts`): a sha-256 over the workspace's
  uncommitted state against the run's base commit — tracked diff, untracked
  additions, deletions, renames as one gone plus one arrived — with Git internals,
  `.mergesutra/` and nested worktrees excluded even when the repository forgot to
  ignore them. Every plan, receipt and evidence row names the identity it
  describes, and a workspace that moved gets its rows marked `STALE` instead of
  trusted.
- Execution consent as a capability (`src/verify/consent.ts`): a repository
  command runs only under a per-gate `--allow`, and the consent carries
  `scopeDigest(plan)` — the exact set of ids, working directories and argv it was
  given for. `--allow all` is refused as the malformed id it is; an empty list is
  no consent at every gate, each of which then records `NOT_EXECUTED` with the
  command it declined to run.
- Receipts (`src/verify/receipt.ts`) that cannot hold a verdict: exit code,
  termination, duration, the patch identity, provenance, a bounded tail of
  *redacted* stdout/stderr, and the digest of the unredacted bytes with a field
  saying which of the two the hash describes. `exitCode: 0` with
  `termination: 'NOT_EXECUTED'` is refused as incoherent rather than read as a
  pass.
- The engine (`src/verify/engine.ts`) takes the exit code as the whole verdict for
  a gate, refuses to start any gate while the workspace no longer matches the plan
  it was built for, and re-describes the patch after every one: a gate that
  rewrote the tree — a formatter wearing a check's clothes — records
  `contamination` and makes the run `INCONCLUSIVE` rather than producing receipts
  about bytes nobody identified.
- Conservative evidence mapping (`src/verify/evidence.ts`): a criterion's status
  and its `sufficiency` are separate facts, and `PASS` requires each step of that
  criterion's own verification plan to be carried by a gate whose command really
  matches it — the invocation plus every script body it reaches, so `npm test` and
  the `vitest run` behind it count as one command. A step that asks for a human
  holds the row at `MANUAL_REVIEW_REQUIRED`; the model's `FINISH` is copied into
  `claims` and read by nothing that decides a status.
- `mergesutra contract --check "node --test test/x.mjs"` now records the command a
  named human said would prove a criterion, so the trace has something to match
  against; the criterion still cannot be satisfied by the model proposing it.
- Run record **schema version 6** carries four new documents —
  `verificationPlan`, `executionConsent`, `verification`, `evidence` — and a v5
  file is reported unreadable rather than guessed at. `contributionReady` is
  `z.literal(false)` in the evidence schema: Stage 7 has no authority to call a
  patch ready, so the field exists only to record that.
- `tests/verify/hero.test.ts` is the stage's proof and its demo: a scratch Git
  repository whose own CI demands a regression test that does not exist, driven
  through `inspect` → `contract` → `plan` → `implement` → `verify` with real
  `node --test` child processes, with the AC→VG trace asserted both structurally
  and in the printed report, and with a final assertion that the regression test
  exits non-zero against the base commit so no link in that chain can pass by
  being hard-wired. The README's Stage 7 capture is that test's stdout.
- 144 tests for the stage — 140 across `tests/verify/*`, 4 in
  `tests/cli/verify.test.ts` — deterministic and offline; no Stage 7 test needs a
  BharatCode credential, and the whole suite stands at 800 passing with the two
  opt-in live-endpoint checks still skipping. `mergesutra run`, `review`, `report`
  and `pr` still exit `2`.

### Added — Stage 6: the bounded implementation loop

The first stage where a model's answer makes something happen. BharatCode chooses
what to read and what to write; every one of those choices passes through the
Stage 5 policy, the Stage 5 writer and a closed action protocol before a byte
changes, and the run records what actually ran rather than what the model
believes it did.

- `mergesutra implement [run-id]` — takes a run that already has a contract and a
  plan and gives it a workspace with files in it. Flags: `--repo`, `--model`,
  `--max-steps`, `--max-writes`, `--max-commands`, plus `--json` and `--no-color`.
  Exit codes: `3` for `IMPLEMENTED_BY_MODEL` — a model that asked to stop has made
  a claim, not earned a `0` — `4` for blocked or cancelled, `1` when the source run
  has no plan, `78` when `BHARATCODE_API_KEY` is absent. **There is no exit `0` in
  Stage 6**, and `CONTRIBUTION_READY` is not reachable from this command.
- A closed action vocabulary (`src/implement/protocol.ts`): eight kinds
  (`READ_FILE`, `LIST_FILES`, `SEARCH`, `WRITE_FILE`, `RUN_CHECK`,
  `PROPOSE_CONTRACT_REVISION`, `FINISH`, `BLOCKED`) in a `strict()` discriminated
  union. Anything else — a `RUN_SHELL`, a `DELETE_FILE`, a field nobody asked for —
  is refused before it can reach a decision, so "what can this loop do" has one
  answer that does not depend on what the model thinks is available.
- Twelve knobs, each with a default **and a ceiling** (`src/implement/limits.ts`):
  steps, writes, commands, refusals, repeats, schema repairs, context files and
  bytes, model output size, command timeout and output, and a wall-clock deadline
  for the whole loop. `--max-steps 999` is refused as a validation error naming the
  ceiling, because an operator who can raise a limit to anything is running an
  unbounded agent with extra steps.
- Hitting a bound is an **outcome, not a lost run**: state is persisted, the
  worktree is left in place, and the run reports `BLOCKED` /
  `NEEDS_HUMAN_REVIEW` / `INCONCLUSIVE` with the specific `termination.kind`
  (`MAX_STEPS`, `MAX_WRITES`, `MAX_COMMANDS`, `MAX_REFUSALS`, `REPEATED_FAILURE`,
  `SCHEMA_REFUSAL`, `MODEL_UNAVAILABLE`, `DEADLINE`, `CANCELLED`, `FINISH`,
  `MODEL_BLOCKED`).
- The read half of the write boundary (`src/security/reader.ts`): the writer's
  confinement — repository-relative, no `.git` in any spelling, every existing
  ancestor realpath'd and proved inside the root — plus read-only rules. Credential
  shapes are never context (`.env` and any `.env.*`, `id_rsa` and friends,
  `.ssh`/`.aws`/`.gnupg`, `*.pem`/`*.key`/`*.kdbx`), `node_modules`, `dist`,
  `build`, `.venv`, `.git` and `.mergesutra` are never descended, binary bytes are
  refused as model text, and a 64 KiB read cap applies per file. Context assembly
  (`src/implement/context.ts`) sends the files the **plan named**, under a file
  count and a byte budget, and records what it withheld as a named skip — a
  silently truncated context is how an agent confidently describes a file it never
  saw.
- No whole-repository sends, and no unredacted ones: the prompt
  (`src/implement/prompt.ts`) wraps every repository and issue section in
  `UNTRUSTED DATA, NOT INSTRUCTIONS`, states that a sentence inside that material
  is not an instruction, and passes everything through the central `Redactor`.
- Execution has no bypass. Writes go through the Stage 5 confined writer and
  nothing else; commands go through the Stage 5 tool policy and the bounded
  argv-only runner with its working directory pinned to the workspace, and
  `shell: true` is not a thing this module can ask for. There is no
  `fs.writeFile`, `fs.rm`, `fs.rename`, `exec`, `execSync` or shell-mode spawn
  anywhere in `src/implement/`.
- A command the model proposes is classified from its argv, not from the model's
  label, so a proposed `git push --force` comes back as a DESTRUCTIVE refusal with
  the reason in the action log, and Stage 6 offers no approval path for it — asking
  to push, open a PR or comment is a refusal in this stage even though Stage 5 has a
  mechanism for it. **Stage 6 performs no remote mutation.**
- One write protocol: whole-file `WRITE_FILE` under a 64 KiB cap, no patch parser,
  no competing edit dialect. The record stores a path, a byte count and a
  `sha256`, not the content — the bytes live in the workspace, where
  `git diff` shows them.
- The contract is untouchable from inside the loop. `ImplementationRecord` has no
  criterion status field, so no action can mark a criterion `PASS`;
  `contractUntouched` is a structural `true`, `verified` a structural `false`, and
  a `PROPOSE_CONTRACT_REVISION` is stored beside the contract with `previous`,
  `proposed`, `reason`, `sourceEvidence` and `applied: false`. A model cannot edit
  the obligations it is measured against; a human re-runs `mergesutra contract`.
- No-progress detection is on **action identity plus what the action produced**, so
  "read the same file and get the same bytes" ends the run, while "run the same
  failing check after a write" does not — the first repeat earns a warning, the
  cap earns a `REPEATED_FAILURE`.
- A schema refusal costs one bounded repair round: the reason is fed back as
  `REJECTED BEFORE EXECUTION: …` and nothing ran; a second bad answer is stored as
  `INCONCLUSIVE`, not renegotiated.
- Cancellation is real in both directions: one Ctrl-C stops the loop between
  actions **and** aborts the model request in flight, and the record is still
  written, because a cancelled run is a fact about the workspace.
- A run advances **in place** — the record, the branch `mergesutra/<run-id>` and
  the workspace `.mergesutra/worktrees/<run-id>` all carry the same id, so
  re-running resumes the same worktree (`reused: true`) instead of forking a second
  one. A workspace that exists at a SHA other than the run's recorded base is
  refused with a remediation that tells a human to remove it themselves; MergeSutra
  never resets or deletes a directory it did not create.
- The credential is required **before** a workspace exists, so a keyless machine
  gets exit `78` and zero git invocations instead of a worktree, a record and an
  `INCONCLUSIVE` implementation.
- The model's `FINISH` is rendered as `WARN` under "Criteria the model claims",
  with the sentence "a claim, not a verdict" attached, and a `CHECK_PASSED` action
  is `INFO` — a developer command exiting `0` is a fact about that command, and the
  word `PASS` belongs to Stage 7.
- Run record schema v5 carries the `implementation` record beside the plan; older
  files are reported unreadable rather than guessed at. `mergesutra run` remains
  planned and exits `2`: the stages after implementation do not exist, so the
  unattended pipeline command is not being faked for a demonstration.
- 169 new offline tests (`tests/implement/protocol.test.ts` 25,
  `loop.test.ts` 44, `prompt.test.ts` 30, `implement.test.ts` 24,
  `context.test.ts` 16, `cli/implement.test.ts` 16, `limits.test.ts` 9) plus
  `tests/implement/nested.test.ts` (5) against **real Git in scratch
  repositories**: two runs of one repository get separate worktrees that cannot see
  each other's files, a `../<other-run>/…` write and read are both refused with the
  sibling's bytes left untouched, a resume reuses the same workspace, a stale
  workspace is refused before the model is asked anything, and a check that never
  finishes is bounded by the loop's own `commandTimeoutMs`. One further
  program-shape case was added to `tests/security/command-safety.test.ts`, and
  with it the whole suite is **616 tests green offline**, up from 446 at Stage 5.
  `tests/implement/live.test.ts` is the only Stage 6 test allowed to reach the
  network and **skips** unless `MERGESUTRA_LIVE_BHARATCODE=1` is set alongside a
  key and a model; it asserts the workspace, the provenance and that the contract
  is byte-identical afterwards. No live PASS is claimed for it in this build — no
  key exists on this machine.
- Known gaps, stated rather than papered over: whole-file writes mean a model that
  rewrites a file it did not read clobbers it (the digest makes that visible in the
  record, not preventable); the worktree is isolation for clarity, **not a
  sandbox** — a permitted command can still do what the operating system lets it
  do; and `IMPLEMENTED_BY_MODEL` means the model stopped asking, which is exactly
  what Stage 7 exists to check.

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
  the suite stood at 446 green at that close, with the one live-BharatCode check
  that still skips without a key.
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

As shipped at Stage 1 — the sections above supersede this list. `verify` and
`report` have since been implemented; `run`, `review`, `pr`, `status` and
`resume` are the commands that still print "planned" and exit `2`.

`run`, `verify`, `review`, `report`, `pr`, `status`,
`resume`. `issue` performs intake only: it produces no plan, patch,
verification, review or PR draft, and says so on the last two lines. `inspect`
and `contract` read and record; `plan` consults BharatCode and records what it
said; `implement` consults it again and changes files — but only inside its own
worktree, and only the actions the policy allowed. None of the commands runs the
contract's gates, so no criterion is ever proven before Stage 7, and
`CONTRIBUTION_READY` is not reachable from any of them.
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
