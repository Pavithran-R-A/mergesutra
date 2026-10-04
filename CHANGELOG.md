# Changelog

All notable changes to MergeSutra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — Stage 13 so far: the release boundary stopped being a Windows-only claim

Until this stage every proof about the published artifact had been run on one machine, on one
operating system. Putting the same gates on real Linux and on hosted runners found six defects,
five in the test harness and one in what a customer installs:

- **`mergesutra` printed nothing and exited successfully on Linux and macOS.** npm's POSIX
  launcher is a symlink, so the command's own "am I the entry point?" check answered no and
  `main()` never ran — exit `0`, empty output, on every platform except the one it had been
  tested on. The executable and the library are now separate modules: `dist/bin.js` is what the
  manifest registers and runs the command line unconditionally, `dist/index.js` is imports only
  and cannot start a CLI. `package.json`'s `bin`, `package-lock.json`, and every `node
  dist/index.js …` instruction in the README moved with it. Guarded by an installed-artifact
  test that starts the command through a symlink, plus one that asserts importing the library
  prints nothing; the failure was re-witnessed on Linux by putting the old check back
  (register S13-2).
- **The suites that ask npm what it would pack looked for npm in a Windows-shaped place.**
  Resolution now walks both install layouts, beside the executable and one level up under
  `lib`, through symlinks too (S13-2).
- **`npm run check` built `dist/` after the suites that hash it,** so a fresh checkout measured
  an absent build and this host measured whatever a previous command had left. Order corrected
  and pinned by a test (S13-2).
- **A test fixture could inherit the machine's build noise** — an ignored-less `node_modules/`
  write inside the workspace under measurement, which read as a stale patch on Linux and as
  current on Windows. Fixtures now carry a default ignore (S13-2).
- **Test-written Git hooks had no POSIX exec bit**, so a hook-firing test passed on Windows
  while testing the absence of a hook (S13-2).
- **The hosted checkout was too shallow for the history the credential gate reads.** Full
  history is fetched now, and a guard refuses a workflow that would not be (S13-2, S13-3).

`.github/workflows/ci.yml` is also now Ubuntu and Windows × Node 22 and 24 running `npm ci`,
`npm run check`, `npm run verify:package` and `npm run test:artifact` — the artifact gates were
not running in CI at all — with `permissions: contents: read`, both external actions pinned to
verified commit SHAs with their tags named beside them, the job name carrying the Node axis it
actually runs, and no secret, no live-model suite and no swallowed failure anywhere in it.
`tests/security/workflow-policy.test.ts` (24 cases) enforces all of that against the real file,
against the exact mutations it exists to catch, and against any workflow file added later
(S13-3).

Two earlier entries in this stage closed customer-facing lies in the published surface: the
package no longer prints its author's home directory (S13-0), and its `homepage`,
`repository.url` and `bugs.url` point at the repository that now exists rather than one that
never did (S13-1). A dead-link gate keeps them that way.

The shipped product also told readers to open files they do not have (S13-4). A screen printed
`Progress: see docs/ROADMAP.md` and `README.md` carried 25 relative links into `docs/`,
`SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` — none of which npm packs, because
`files` ships `dist`, `BharatCode.txt`, `README.md` and `LICENSE`, and a gate refuses a package
that carries `docs/`. Every one of those directions was aimed at this repository's developer.
Reader-facing pointers are now composed in `src/cli/pointers.ts` from the repository URL the
manifest already publishes (`…/blob/HEAD/docs/ROADMAP.md`, so the link survives a
default-branch rename), the README's links are absolute, and the two package-internal ones stay
relative. `tests/security/shipped-pointer-boundary.test.ts` (23 cases) starts the real installed
command once per advertised verb — from a directory holding none of this checkout's documents,
which is the only way the question can be asked — and judges each pointer by position: legal if
npm packs it, legal if it belongs to the repository being inspected, an offence if this checkout
tracks it and the package does not ship it. It reads a markdown link as a route a customer
follows and a backticked path as a citation, so provenance in prose is not mistaken for a
broken promise. Three mutations named the failures they caused — 3 screen cases, 2 document
cases, 1 drift pin — each then restored byte-for-byte. One of its own drafts put the URL in
`src/version.ts` and was caught by a *different* guard: the read-only half of recovery treats a
`https://` literal in its import closure as an endpoint, so the pointers belong in the
presentation layer and that guard stayed exactly as strict as it was.

`S13-5` was the same class of defect in the repository's own documents: they described a project
that does not exist. `SECURITY.md` called MergeSutra "a contribution harness", told readers a key
could come from a credential file when `src/config/load-config.ts:69` reads it from the
environment and nothing else does, offered GitHub's private vulnerability reporting as an intake
route, and listed supported versions for a package that has never been published. Every claim was
checked at the file that decides it, and the intake claim was measured rather than argued: on
2026-10-04 the REST endpoint behind private vulnerability reporting answered `200` for a public
repository and `404` for this one, so the honest text is "not a working route while this
repository is private", with the public address named for the day it becomes one.
`CONTRIBUTING.md` named seven of the manifest's fifteen scripts, none of the three that guard the
release boundary, stated `npm run check`'s composition in an order the manifest does not run, and
never told a contributor that the remote is canonical. Both documents are now accurate and one new gate keeps them that way:
`tests/docs/contributor-commands.test.ts` (9 cases) re-derives every script name, every command
name an intake form offers, every `src/**` path a security document cites, and the release-boundary
verifier list from `package.json`, `src/cli/program.ts`, `.github/workflows/ci.yml` and
`verify:package` themselves. Its RED was witnessed against the committed blobs, and seven
mutations each broke the case it was written for — including one that initially broke a *different*
case, which proved the mutation was mis-aimed rather than the gate being wrong. One detector bug
was found and fixed in the detector: a comment in `ci.yml` mentioning `npm run test:live` counted
as a CI step until the reader was restricted to `run:` lines.

Repository settings were then measured at the real remote instead of guessed. Topics required
`PUT …/topics` with the body key `names` (a `PATCH` of the repository silently dropped them), the
`homepage` field GitHub itself leaves empty is now set, the wiki is off, and ruleset `24454501`
holds the default branch with `[deletion, non_fast_forward]` for everyone, owner included —
`current_user_can_bypass` reads back `"never"`, which is the property that matters, because the
failure it prevents is losing the canonical history RULE 1 depends on.

That ruleset was itself a defect first. It went in with the `update` rule, which is GitHub's
"Restrict updates" — it refuses *every* push, not only non-fast-forward ones — and the discovery
was the push itself: `main` rejected `78f9440` with `GH013 … Cannot update this protected ref`,
leaving a completed, gate-green slice stranded on one machine while every local gate stayed green.
No test in this repository can see a repository setting, so the fix was a measurement on a
disposable branch rather than a re-read of the docs: under `non_fast_forward` a fast-forward push
was accepted and both a forced push and a delete were refused (`Cannot force-push to this branch`,
`Cannot delete this branch`), the probe artifacts were then deleted and verified gone, and `main`
accepted the same commit. Two rules that sound alike were separated the same way: requiring a pull
request blocks a direct push outright, while `required_status_checks` only gates a merge — which
is why the first is deferred to the visibility flip with a measured reason and the second is a
Stage 15 decision that costs nothing in cadence. Classic branch-protection endpoints answered
`404` on this repository, so the ruleset API is the only protection layer available here.
Hygiene got exactly one intake form rather than a template set: a bug report whose "where it
happened" dropdown lists the thirteen commands the CLI actually registers (so a report cannot be
filed against a planned verb), a required field for the exact command line, and a required
checkbox that the reporter removed every credential value from it.

The Stage 14 groundwork then found a defect this stage had itself made. Preparing the
first credential-free command — `mergesutra doctor` — through the source command the contribution
guide names (`npm run dev`, documented as "Run the CLI from source via `tsx`") produced exit `0`
and 51 bytes of output: npm's own banner, and nothing from the product. S13-2 had moved the command
line from `src/index.ts` into a new `src/bin.ts` and deliberately left `src/index.ts` as imports
only, so that importing the library could never start a CLI — and had left `dev` pointing at that
now-inert module. The documented source run therefore inherited exactly the symptom S13-2 exists to
prevent, "exit code 0, no stdout and no stderr", on every platform instead of two. Nothing could
see it for the same reason the first one went unseen: a gate that checks that a script *name*
resolves cannot see what the script *runs*. `dev` now launches `src/bin.ts`; two cases in
`tests/docs/contributor-commands.test.ts` hold the relationship, both derived from the manifest
itself (the executable from `bin`, the inert module from `main`) so they follow a future rename
rather than freezing today's filenames. Measured on this host after the change, the same command
line that had printed nothing prints the six-check screen and exits `1` on the honest pre-credential
state — `Node v24.21.0 PASS`, `Git … 2.55.0 PASS`, `GitHub CLI … 2.96.0 PASS`, `GitHub auth
signed in PASS`, `BharatCode key … is not set FAIL`, `BharatCode reach … SKIP`.

### Added — Stage 11: the screen that says what is true now, and the word that continues it

Every stage before this one assumed a run was being watched while it happened. This is
the stage for the other case — the terminal closed, the machine rebooted, the approval
never typed — and its design question is which of the two facts a person is owed: what
the run recorded, or what the checkout shows now. The answer is both, side by side, in
one document nothing in the product is allowed to smooth over. `mergesutra status` can
read that document and changes nothing; `mergesutra resume` can act on it, once, under
one word, after re-reading the state it is about to change. Neither one rolls anything
back, because the recovery this build can offer is legibility, not undo.

- The graph (`src/lifecycle/staleness.ts`) grades nine artifacts — `verification`,
  `evidence`, `review`, `repairPlan`, `executionConsent`, `pack`, `candidate`,
  `publicationApproval`, `repairApproval` — into four states, `CURRENT`, `STALE`,
  `UNMEASURABLE` and `ABSENT`, from a `{ recorded, current }` digest pair per artifact.
  It is pure arithmetic: no record read, no file opened, no Git command run, so the
  same call answers for a status screen and for a resume plan and they cannot disagree.
  A row widens to the worst state on anything it is built from, recursively — an
  approval sees a patch that moved four arrows above it — except `ABSENT`, which means
  "never filed" rather than "expired" and is the one state that does not travel. A run
  that skipped repair still has a page and still has an approval.
- The observation (`src/lifecycle/observe.ts`) is the only new reader of a workspace,
  and it reads with `rev-parse`, `cat-file -e` and the same `diff` / `ls-files`
  measurements `verify/patch.ts` already made. It writes nothing, and it never asks Git
  for a verdict: an unborn HEAD, a moved HEAD, a deleted directory and a workspace that
  is not this run's each get their own state and their own sentence.
- `StatusSnapshot` (`src/lifecycle/snapshot.ts`) is the one document both commands are
  built from, and its whole design is about *not* fusing its inputs. `recorded` is the
  stage vocabulary as filed; `workspace` is what Git just said; `patch` is the pair with
  a graph row beside it; every later section is `null` until the stage that owns it
  files something, so no gap is filled with an empty-but-passing shape. A row may read
  `PASS` and `STALE` in the same breath — which is the only honest description of a run
  whose bytes moved after its gates ran. There is no health number, no `ready`, no
  verdict field, and `publication.remote` is the literal
  `NOT_ATTEMPTED_BY_THIS_BUILD`. `mergesutra status [run-id]` prints it (or `--json`
  emits it, derived and never stored) and exits `0` even when everything it found is
  bad, because the number describes the command. `next-actions.ts` offers only commands
  this build has, in lifecycle order, each with the capabilities it costs from
  `MODEL | REPOSITORY_COMMAND | HUMAN_APPROVAL | EXECUTION_CONSENT | LOCAL_ONLY`.
- `mergesutra resume [run-id]` is a preview unless it is told `--execute`, and the
  preview is the plan itself: one of thirteen action names, the reason, the stage and
  command it maps to, and its costs (`requiresModel`, `requiresCredential`,
  `mutatesWorkspace`, `requiresExecutionConsent`, `requiresRepairApproval`,
  `requiresPublicationApproval`) printed beside it. No member of that list means
  published, pushed, created or merged, and none of them means approved — a plan that
  reaches `PUBLICATION_APPROVAL_REQUIRED` or `AWAIT_HUMAN` is stopped _at_ a boundary
  and carries no capability past it. There is no `--yes`, `--confirm`, `--force`,
  `--all` or `--approvals-already-granted`; the parser refuses them as unknown options.
- Execution revalidates rather than trusting its own preview (`src/lifecycle/resume.ts`):
  the service refuses on the plan's cost flags *before* it claims anything, takes the
  run lock, then re-reads the whole state and compares `observedStateDigest` — sha256
  over the snapshot it planned from, minus the moment it was read. A moved workspace
  between preview and execute comes back `BLOCKED: STATE_CHANGED`, not as a retry. It
  dispatches the one stage the plan names, holds no capability of its own, and never
  writes a record itself.
- A resumed loop gets what is left, not a fresh allowance (`src/lifecycle/budget.ts`).
  Residual limits come from the entry that last ran, so 8 steps spent of 12 bounds the
  resumed entry at 4 — the failure mode where a recovery tool buys itself twice the
  autonomy is closed by construction. What the record cannot prove is printed rather
  than assumed away: `BUDGET-LINEAGE` says a continued loop's bound replaces the one in
  its record, and `BUDGET-UNRECORDED` names the axes that were never bounded.
- One run, one mutator (`src/lifecycle/lock.ts`): `<runsRoot>/<runId>.lock/` created by
  atomic `mkdir`, holding an `owner.json` that is parsed as untrusted input. A live
  process on another host blocks rather than being deleted, age is never evidence of
  death, a proven-dead lock is *claimed* by writing again and recorded with
  `brokenFrom`, and no operation but `resume` takes one. The lock grants nothing — no
  consent, no approval, no credential, no remote — and is released in a `finally`.
- Recovery is forbidden from being a rollback, and the ban is compiled rather than
  documented: `tests/lifecycle/source-shape.test.ts` (15 tests) fails the build if
  `reset`, `restore`, `checkout <path>`, `clean` or `stash` appears in `src/lifecycle/`,
  alongside the boundary guard that `src/lifecycle/` imports no client, no transport and
  no HTTP. `tests/lifecycle/interruption.test.ts` walks 11 ways a run can be stopped
  mid-stage and asserts the record keeps the attempt count it earned — the record, not
  the memory, is the ledger.
- Two heroes carry §52 and §53. `tests/lifecycle/hero.test.ts` takes a run stopped in
  the middle of a repair, shows the screen that makes recovery visually obvious, and
  brings it forward to a pull-request page by re-earning every fact on the way — while
  naming the one write that was lost as a loss this tool does not undo.
  `tests/lifecycle/lock-hero.test.ts` runs two services against one run and proves the
  refusal is a refusal that really happened: the second is turned away while the first
  holds, is allowed after it releases, and leaves the stored record byte-identical to
  what it was before it was told no.
- **Tests:** 206 for this stage across fourteen files — staleness 27, observe 19, budget
  20, lock 18, snapshot 18, resume 18, resume-plan 17, source-shape 15, status 13,
  cli/resume 17, next-actions 11, interruption 11, and the two heroes at 1 each. The run
  record stays at schema version `9`: Stage 11 added no field to it, because a recovery
  layer that could write down what a run *is* would be a second authority. The complete
  chain was run at this entry's close: `npm run check` exits `0` —
  `prettier --check .`, `eslint .`, `tsc -p tsconfig.json --noEmit`, `vitest run` at
  **1686 passed, 3 skipped (1689 total) across 109 files** (106 files passing, the three
  opt-in live-endpoint checks skipped), and the build project.
- **Not done, and stated as a gap:** Stage 11 earns recovery, not durability. A process
  killed between a writer's open and its close still loses that write, and nothing here
  brings it back — the tool can see the gap and say so, which is not the same as closing
  it. Concretely, at this entry's close: `status` printed no lock state, so a run held by
  another process looked identical to one that is merely idle (Stage 12's S12-05 put a
  `Run lock` row on that screen — ADR-061 — and the row reads, it does not take);
  `expectedObservedStateDigest` is accepted by the service for programmatic callers and
  has no CLI flag, so a person cannot pin a preview
  by hand; `mergesutra resume` inherits the planner's behaviour of filing a plan as a
  **new** run id, so resuming a `contract` action moves the run rather than advancing it;
  and the residual budget is per-entry, which `BUDGET-LINEAGE` states instead of
  hiding. `mergesutra run` is still the one planned stub in the build, still exit `2`,
  and no later stage in this roadmap claims it: a pipeline that decides for itself when
  to keep going is what produced the runs Stage 11 exists to recover.

### Added — Stage 10: a page a human says yes to, and a remote that is not there

Every earlier stage ends in a document about the patch. This is the stage where the
documents become a pull request — and the boundary it crosses is the first one in this
product that could reach someone else's repository, so the design question was not how
to publish but how to get as close to publishing as possible without owning the hands.
The answer is one page, one number, and one refusal: MergeSutra assembles a
publication candidate from facts the run already established, a human types that
candidate's digest back to say yes, and the code that would carry either half to GitHub
throws on every call.

- `mergesutra pr [run-id]` — prints the page and the digest, or records a yes for one.
  Flags: `--repo <path>`, `--approve <publication-digest>`, plus the global `--json` and
  `--no-color`. `PR_CANDIDATE_RECORDED` and `PR_APPROVED_LOCAL` exit `3`,
  `PR_PUBLICATION_BLOCKED` exits `4`; there is no exit `0` at this stage, because none
  of the three outcomes is a publication, and no path through the command takes one.
  No `--yes`, `--force`, `--approve-all`, `--all` or `--dangerously-skip-approval` is
  declared, so the parser refuses them as unknown options, and `mergesutra merge` does
  not exist.
- The candidate (`src/pr/candidate.ts`) is a schema-strict record of measured facts —
  run, repository, base SHA, patch identity, both branches, the title and body, the
  evidence-pack identity, the issue and whether the page may claim to close it, the
  review cycle it repeats, the verification summary and the limitation list. It has no
  status, no verdict, no `approved` and no `confidence` field, so there is nothing on it
  for a stage to inflate; digesting a document that fails its own schema throws rather
  than producing a number to point at.
- The digest (`src/pr/digest.ts`) is sha256 over fifteen labelled lines, and it is the
  only approval surface: it names the repository, the base, the bytes, both branches,
  the title, the body (folded in as `prBodySha256`), the pack, the issue *and its closure
  keyword*, the review, the verification and the caveats. `createdAt` is the one field
  excluded — a yes covers a scope, not a minute — which also means `STALE` in this
  product means the scope moved, never that a timer ran out. Nothing is fuzzy: no
  prefix match, no wildcard, only the hex compared case-insensitively.
- The approval (`src/pr/approval.ts`) is five fields and one action,
  `CREATE_PULL_REQUEST`, which is the enum's only member — there is no
  `APPROVE_ALL`, no `*_AND_MERGE`, no force anywhere in the type. `approvePublication()`
  computes the digest rather than accepting one, so the call that records a yes is the
  call that checks what the yes is about. `decidePublication` answers
  `MATCHED` / `ABSENT` / `STALE`, and `STALE` prints both digests so the page can be
  re-read rather than re-approved by reflex.
- Approval is not capability. `src/pr/publisher.ts` declares the narrowest remote that
  would ever be needed — `pushBranch` and `createPullRequest`, as argv, on a
  `PublicationRemote` interface, with inputs re-validated through the strict schemas at
  that boundary — and defines one implementation, `unavailableRemote()`, which throws the
  same refusal for both. Nothing in this build calls either: `publish()` has no
  production caller, and `tests/pr/boundaries.test.ts` walks the import graph from the
  CLI and fails if `pr/publisher.ts` is ever reachable from the command a person types.
  The seam is still proved real rather than merely absent — `tests/pr/publisher.test.ts`
  drives it with a fake transport that records what it was handed
  (`pushBranch`, then `createPullRequest`), and asserts that the same call with no
  approval, or with a candidate whose bytes moved, records zero calls.
- Readiness (`src/pr/readiness.ts`) is eight named facts, not a score:
  `patch-measured`, `verification-current`, `verification-passed`, `review-current`,
  `no-repair-candidate-left`, `no-scope-violation`, `pack-current`, `human-approved`.
  All eight give `HUMAN_APPROVED_FOR_PR`; any other combination gives
  `NOT_READY_FOR_PUBLICATION` with the blocking rows naming the earlier stage that owns
  the missing fact, because Stage 10 is a consumer and does not repair. `pack-current`
  compares the candidate against the bytes on disk via `readPackIdentity`, so re-running
  `mergesutra report` after a yes expires it.
- The page itself (`src/pr/draft.ts`) is deterministic — the stage makes **zero** model
  calls and needs no `BHARATCODE_API_KEY` — eight sections in a fixed order (Summary,
  Issue, Acceptance Contract, Implementation, Verification, Independent Review,
  Evidence, Limitations / Manual review), a body bound in size, paths central-redacted to
  repository-relative form, and `Fixes #n` printed only where the intake record proves
  the identity and the closure; otherwise `Related to #n`. A headline quoted from an
  issue passes the same overclaim screen as the rest of the page, so an issue titled
  `Fixes #999 # HUMAN_APPROVED_FOR_PR` cannot walk unedited into the title.
- Branch names come from the run id and the measured patch identity
  (`src/pr/branch.ts`), never from a model or from issue prose; the target branch is
  read from trusted Git metadata and refused if it is not a single unambiguous ref. The
  ref alphabet rejects the shapes that break a clone (`-`, `.lock`, `..`, control
  characters, a leading or trailing `/`), and there is no force parameter anywhere on
  the push path.
- The pair is filed together in the run record — schema version `9`, a new
  `publications` list holding `{ candidate, approval | null }` — and
  `src/pr/record.ts` refuses at read time a record whose approval names a different
  candidate's digest. There is no result field in either document: no URL, no timestamp
  on the publication, no `prUrl` string anywhere in `src/`.
- Every path through the screen ends with `HUMAN APPROVAL RECORDED` or
  `NO HUMAN APPROVAL RECORDED`, then `REMOTE PUBLICATION NOT ENABLED`, then
  `NO REMOTE CHANGE HAS BEEN MADE.`, and `--json` reports `published: false` beside
  `approved: true` rather than collapsing them.
- Two source-shape guards hold the boundary past the tests that exercise it:
  `tests/pr/source-shape.test.ts` scans Stage 10's sources for `git push`,
  `gh pr create`, generic GitHub write clients, force-push vocabulary, `shell: true` and
  reset/clean, and `tests/pr/boundaries.test.ts` proves `src/pr/` imports no transport,
  no HTTP client and no process runner.
- **Tests:** 181 for this stage — 173 across twelve files in `tests/pr/` (candidate 26,
  draft 31, readiness 20, approval 19, branch 19, stage 14, publisher 13, record 8,
  source-shape 8, boundaries 7, injection 7, hero 1) and 8 in `tests/cli/pr.test.ts`.
  The injection suite is the stage's real subject, and each of its seven tests is an
  attempt to make Stage 10 say yes without a person: a model document that reports
  itself approved is parsed as a document and not an approval; an environment variable
  that says yes is not read as one; a file inside the repository granting approval is
  noticed as a changed byte rather than a permission; a record whose approval was
  pasted onto the wrong page is refused at read time; an issue title written to look
  like a closing keyword lends the headline nothing; an absolute path stays out of the
  body whichever way the machine spelled it; and an issue in another repository is
  linked without ever being closed. The complete chain was run at this entry's close:
  `npm run check` exits `0` — `prettier --check .`, `eslint .`, `tsc -p tsconfig.json
  --noEmit`, `vitest run` at **1478 passed, 3 skipped (1481 total) across 95 files**
  (92 files passing, the three opt-in live-endpoint checks skipped), and the build
  project.
- **Not done, and stated as a gap:** this is a publication *boundary*, not a publication.
  No remote is configured, none was created, nothing was pushed, no pull request exists,
  and `git push` has never been run by this program — which is also why the ban is
  currently self-evident rather than well-tested: MergeSutra has never made a commit in
  the user's repository, so there is no branch to push. A yes expires if the pack is
  re-rendered, deliberately, and there is no re-approve shortcut.
  `HUMAN_APPROVED_FOR_PR` is not `CONTRIBUTION_READY` and does not become it: the first
  is one person's digest-bound decision about a page, the second would require every
  mandatory gate to have passed, and this build still has no outcome word that spells
  it. The `gh` / `npm` / `curl` bans rest on the argv enumeration and the import
  boundary rather than on the risk classifier, which has no name for those binaries —
  Stage 12's hardening work. `mergesutra run`, `status` and `resume` are unchanged
  stubs, still exit `2`, and are Stage 11's.

### Added — Stage 9R: a repair authorised by digest, and the gates that had to run again after it

Stage 9 froze a work order and stopped. This is the stage that carries it out, and
its design question is the one an editing stage cannot dodge: a thing that changes a
patch must not also be the thing that decides the change was good. So one cycle runs
a fixed path — read the plan, ask a human for a yes naming its digest, edit through
the loop that already owns the writer, re-verify the bytes that exist now, remake the
pack the cycle made stale — and every step is a separate document with its own proof.

- `mergesutra repair [run-id]` — the only shipped command that edits a repository,
  and it edits only under `--approve-plan <digest>`: the 64-hex digest of the plan
  Stage 9 froze, typed after reading it. There is no `--yes`, no `--force`, no
  `--approve-all` and no environment variable that stands in for the digest, because
  a repair that could be approved in advance would be approved without being read.
  The command has two halves with different needs: without an approval it prints the
  plan, the files it names and the exact command line that would authorise it, and
  asks for no credential — the half a person uses to *decide* may not cost a request.
  With one, a missing `BHARATCODE_API_KEY` is a configuration refusal at exit `78`,
  raised before a byte moves rather than as a cycle that ran and did nothing.
  `REPAIR_APPLIED` and `REPAIR_NEEDS_HUMAN` exit `3`, `REPAIR_BLOCKED` exits `4`;
  there is no exit `0`, and no outcome in the vocabulary that says a patch is good.
  `--repo`, `--max-review-cycles`, `--max-repair-cycles` (lowering only), `--json`,
  `--no-color`.
- The digest is the approval surface (`src/repair/digest.ts`): canonical JSON with
  every list order-normalised, covering which run, which cycles, which patch the
  findings described, which findings, files, criteria and gates and what each asked
  for. `createdAt` and the model id are excluded on purpose — re-freezing the same
  scope over the same bytes authorises the same edit, and a digest that moved with
  the clock or with a re-sorted list would train a human to reach for a blunter flag.
  The function decides nothing and holds no consent.
- Consent is a separate capability (`src/repair/consent.ts`): `{ planDigest,
  approvedAt }`, stored beside the plan rather than inside it, with three states —
  `MATCHED`, `ABSENT`, `STALE` — and no wildcard field of any kind. A yes spent on
  cycle 1 does not authorise cycle 2, and a yes typed for another plan is reported as
  stale while naming both digests; nothing is mutated to find out either way.
- A cycle runs on a smaller budget than Stage 6 did (`src/repair/limits.ts`): 6 steps,
  3 writes, 2 commands by default, ceilings of 8 / 4 / 3, and every axis clamped
  against Stage 6's *default* as well as this file's own. Asking for more is a clamp,
  not a refusal — the approved thing was the plan's scope, never a bigger budget — and
  the record says which numbers actually ran.
- The repairer is briefed with the plan's scope and nothing wider
  (`src/repair/context.ts`). It ships the findings the plan carried, the criteria
  those findings name, the receipts the plan answers to and the files the plan froze;
  it withholds the reviewer's closing summary, the earlier loop's account of its own
  work, and any criterion or file the plan never named — and states its own exclusions
  on the page, so an omission is visible instead of silent. A finding whose text is
  shaped like a section heading is quoted behind the shared `> [data] ` marker
  (§29), whole findings are dropped rather than truncated when the brief outgrows its
  budget, and a plan from another run, another patch or a finding a human was routed
  is refused rather than reinterpreted.
- The loop refuses an out-of-scope write before the writer sees it
  (`src/implement/loop.ts`, `src/implement/prompt.ts`): given a brief, a `WRITE_FILE`
  to a path outside it is rejected as a refusal, the scope is restated in MergeSutra's
  voice under its own heading, and Stage 5's policy still outranks the brief — a plan
  that lists `.git/config` gets no write either. There is no second editing engine:
  the cycle calls `runImplementationLoop`, so there is one writer, one precondition
  rule and one place a `shell: true` could ever appear.
- What a cycle did is its own document (`src/repair/execution.ts`) and the run record
  grows to hold the list of them (**v8**, `repairExecutions`, nullable and defaulted so
  a v6 or v7 record still reads). It cannot be constructed without an approval whose
  digest matches the plan handed to it — the digest is recomputed, never accepted — it
  carries no verdict field, no criterion status and no room for the model's reasoning
  beyond the loop's own action log, and its `verificationRequired` is read off the
  patch delta: bytes moved, so the gates run again, and that stays true when the cycle
  is being escalated rather than relaxing to whatever was green before.
- `src/repair/stage.ts` runs the path end to end and encodes it in state: the cycle,
  then `classifyRepairScope` on the real A→B delta, then — only when the bytes moved —
  Stage 7's own verification round over those bytes through the reusable entry point
  (`verifyWorkspace` in `src/verify/workspace.ts`), under §16's rule that the consent
  already on file may be reused only for the same commands and is reported as missing
  otherwise. The evidence
  is remapped from the new receipts, and Stage 8's `buildEvidencePack` /
  `writeEvidencePack` regenerate `report.md`, `report.json` and `commands.jsonl` from
  this cycle's record; a pack that cannot be regenerated is reported in the checks and
  the old one is left standing, not quietly re-labelled.
- Nothing is cleaned up. A cycle that reached outside its plan is filed as
  `OUTSIDE_PLANNED_SCOPE`, routed to `NEEDS_HUMAN_REVIEW`, and the edit and the extra
  file are both left exactly where they are; there is no revert, no `git clean`, no
  `git reset` and no automatic second repair because a gate failed. A cycle that left
  no trace is not re-verified either — the page says why: the gates already on file
  still describe this workspace, and nothing here retired them.
- An interrupt is a fact, not a verdict (`tests/repair/stage.test.ts`): cancelling
  before the first request files a cycle that edited nothing, cancelling after the
  edit runs no gate at all, and cancelling mid-round files the half-run with verdict
  `CANCELLED`, one PASS where a gate genuinely produced a receipt and the rest
  `INCONCLUSIVE` — the document never collapses into a pass because a round started.
- Two guards that cannot be run without executing something are proven from the source
  instead: `tests/repair/source-shape.test.ts` walks every module a repair cycle can
  reach, enumerates each command it constructs, classifies it with the production risk
  oracle, and fails on a snapshot list if a new one appears — with a positive control,
  so an empty scan cannot read as clean, and without ever starting a destructive
  command to show it would be refused. `tests/bharatcode/client.test.ts` pins the
  endpoints a default-configured client calls, so a repair cannot silently widen where
  the patch's text goes.
- 191 offline, deterministic tests for the stage — 181 across `tests/repair/*`, 10 in
  `tests/cli/repair.test.ts` — none of which needs a credential. `tests/review/hero.test.ts`
  now walks the whole way round on real Git and real `node --test` processes: the
  approved digest, the edit through the loop, new receipts naming the new patch, the
  pack regenerated over them, a second reading that files nothing, and the fixture's
  teeth — the case the repair added is checked to *fail* against the patch it replaced.
  One defect surfaced there and is fixed: a later `review` or `implement` over a
  repaired run used to drop the filed cycles from the record it re-saved.
- At this stage's close the full `npm run check` chain was run over the whole
  repository and measured **1263 passed | 3 skipped (1266) across 79 test files | 3
  skipped (82), in 143.11s**, with Prettier, ESLint, `tsc --noEmit` and the build
  project all green in the same pass. The 3 skips are the pre-existing live smokes —
  `tests/plan/live.test.ts`, `tests/implement/live.test.ts`, `tests/review/live.test.ts`
  — each of which needs a real `BHARATCODE_API_KEY`; no test was skipped, weakened or
  deleted to reach that number. The sweep caught a real defect on its first run:
  `src/repair/stage.ts` and `tests/repair/boundaries.test.ts` had been committed
  unformatted in earlier Stage 9R slices, so `prettier --check .` failed at HEAD; both
  were reformatted with no behaviour change and the complete chain was run again.
- **Not done, and stated as a gap:** the `> [data] ` guard now covers the reviewer's
  page and the repair brief, and still not the `plan` or general `implement` prompts —
  Stage 12's adversarial work. A repair cycle still reaches the same adapter, and
  possibly the same model family, as the review that ordered it. `CONTRIBUTION_READY`
  remains unreachable and unclaimed: this stage's most hopeful screen says the bytes
  moved and the gates were re-run, which is not the same sentence. `mergesutra run`,
  `pr`, `status` and `resume` still exit `2`; Stage 10 owns approval, the PR draft and
  the publication boundary. *(Kept as written: Stage 10 above ships `pr` — the
  digest-bound page, the human gate and the disabled remote — and its three outcomes
  exit `3` and `4`, never `2` or `0`. `run`, `status` and `resume` are the stubs that
  remain, and `CONTRIBUTION_READY` is still unspelled.)*

### Added — Stage 9: the same patch, read a second time by a model that changes nothing

Stage 7 said what the repository's own gates prove. Stage 9 asks the question a
green suite cannot answer — *is the requirement actually met?* — and files the
answer without touching a byte. The design problem was the opposite of Stage 8's:
not packaging without adding, but consulting a model without letting it decide.

- `mergesutra review [run-id]` — shows a second model the exact patch a run pinned,
  files the findings it can cite, routes them, and returns with the workspace
  byte-identical. Flags: `--repo`, `--max-review-cycles`, `--max-repair-cycles`
  (both ceilings a caller may lower, never raise), `--json`, `--no-color`. It has
  **no exit `0`**: a completed review exits `3`, bytes that moved mid-review exit `4`
  (`REVIEW_STALE`), and a missing `BHARATCODE_API_KEY` is a configuration refusal
  with exit `78` — raised after the run has proved it is reviewable, before a call is
  spent. There is no `REVIEW_PASS` in the outcome vocabulary and no code path to one.
- The reviewer's answer has nowhere to put a verdict (`src/review/schema.ts`).
  `summary` and `findings` only; each finding carries severity, one of nine
  categories, statement, impact, evidence, an anchored file, a bounded `lineRange`,
  criterion ids and `CTX-` citations — and no `status`, `score`, `grade`, `ready` or
  `disposition` field, which `.strict()` enforces by rejecting the ones a model tries
  to add. `RF-001`-style ids and dispositions are assigned here, in the order the
  findings arrived.
- Citations are issued, not quoted (`src/review/manifest.ts`). Before the question is
  asked, MergeSutra authors the only ids a finding may cite — patch files, in-scope
  sources the plan named and the patch left alone, criteria, gate receipts, policy
  files — each with what was sent, how it was presented, and how many lines reached
  the page. `src/review/disposition.ts` then weighs every answer against it: uncited
  or unanchored is `UNSUPPORTED`, a repeat is `DUPLICATE`, a complaint about a file
  this patch does not touch is `OUT_OF_SCOPE`, and `SECURITY`, `REPOSITORY_POLICY`,
  `SCOPE` and `MAINTAINABILITY` go to a human however confident their author claims
  to be. Only `BLOCKER`/`HIGH` findings on a citable patch file become
  `VALID_REPAIR_CANDIDATE`.
- A repair plan is frozen before anything changes (`src/repair/plan.ts`,
  `src/repair/bounds.ts`): a strict, digest-bound work order naming the files, gates
  and criteria a later stage may touch, under ceilings of 2 review cycles, 2 repair
  cycles and 5 findings per cycle — provable against a caller that asks for more. Past
  a ceiling the routing stops and says which bound stopped it, and the outcome becomes
  `REVIEW_NEEDS_HUMAN`. `src/repair/scope.ts` compares a plan to the delta a repair
  actually left, flagging `UNEXPECTED` files and a "while I'm here" refactor instead of
  cleaning them.
- The patch is pinned before the question and re-measured after the answer
  (`src/review/engine.ts`, `src/review/stage.ts`). Bytes that moved yield
  `REVIEW_STALE`, no findings from that answer are routed, and the account of the
  review is still written; a refused, unreachable, cancelled or unintelligible answer
  writes a record too — with no review document in it, because there is nothing to
  file — and leaves the patch, the receipts, the evidence and the pack as they were.
- Zero findings is reported as a limit, not a clean bill: the record gains a
  `REVIEW-EMPTY` caveat ("the absence of findings, not the absence of defects") and
  the pack repeats it, so an empty section cannot be read as a sign-off.
- Quoted text can no longer impersonate the page's own structure
  (`src/security/prompt-material.ts`, used by `src/review/prompt.ts`). A line of
  untrusted material whose whole line is shaped like a section heading is prefixed
  with `> [data] `, the count is disclosed at the foot of the prompt, and nothing is
  deleted — so an issue body containing `=== ACCEPTANCE CONTRACT ===` renames nothing
  and opens nothing. `tests/review/prompt.test.ts` proves the attacked page has the
  same section list as the clean one.
- Run record **v7**: `review` and `repairPlan` are added beside the six stages'
  documents, nullable and defaulted, and the reader becomes version-aware — a v6
  record still parses, is transformed in memory, and gains no findings it never had.
  `report.md` renders a review and a frozen plan from that record, and prints
  `none recorded — nothing has read these bytes a second time` when a run has none,
  which is what the pack after a real repair correctly says about its own bytes.
- 192 offline, deterministic tests for the stage — 134 across `tests/review/*`, 48 in
  `tests/repair/*`, 10 in `tests/cli/review.test.ts` — none of which needs a
  credential. The flagship fixture (`tests/review/hero.test.ts`) runs on real Git and
  real `node --test` processes: every gate passes on a patch that does not satisfy the
  requirement the issue was opened about, the reviewer says so, the repair is executed
  through Stage 6's own bounded loop and confined writer, Stage 7 mints new receipts
  for the new bytes, and the pack is regenerated — with the fixture's teeth asserted,
  in that the case the repair added is checked to *fail* against the patch it replaced.
  Two further paths are pinned separately: a review that files nothing mutates
  nothing, and a fabricated finding citing a real id is weighed rather than believed.
- One opt-in live check: `tests/review/live.test.ts` asks the real endpoint once about a
  real patch, and stays skipped unless `MERGESUTRA_LIVE_BHARATCODE=1`, a key and a
  model id are present together. It asserts structure — the model id actually answered,
  the unchanged patch identity, citations that exist in the manifest, no credential in
  the record or the pack — never agreement. At this entry's `npm run check`: **1053
  passing and 3 skipped** (the three opt-in live-endpoint checks: planner, loop and
  reviewer).
- **Not done, and stated as a gap rather than a completion:** no shipped command
  executes a repair. Stage 9 routes work and freezes the scope; running a frozen plan
  would mean a second writer with the loop's powers, which the stage brief forbids, so
  `classifyRepairScope` has no production caller and a reviewed run's `nextStage` names
  a `REPAIR` that does not exist yet. The reviewer also runs through the same adapter
  and possibly the same model family, so this is an *independent review*, not an
  independent model; and the `> [data] ` guard covers the reviewer's page only — the
  `plan` and `implement` prompts still interpolate `===`-shaped text with labelling but
  without marking, which is Stage 12 work. *(Kept as written: Stage 9R above ships the
  executor and gives `classifyRepairScope` its production caller, and brings the
  marking to the repair brief — the `plan`/`implement` sentence still stands.)*
- `mergesutra run`, `pr`, `status` and `resume` still exit `2`. *(Kept as written:
  Stage 9R above added `repair` and Stage 10 added `pr`, so the stub list here is now
  `run`, `status` and `resume`.)*

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
  `2`. (That list lost `review` at Stage 9, above; the rest is still true.)

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
  (`C:\Users\ALEX~1\…`) is the same directory as
  `C:\Users\Alex Tester\…` but not equal under `path.resolve`, so paths are
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
`resume` were the commands that still printed "planned" and exited `2` then. Of
those four, Stages 9, 10 and 11 implemented `review`, `pr`, `status` and `resume`, and
`mergesutra run` remains the only planned stub in the build.

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
