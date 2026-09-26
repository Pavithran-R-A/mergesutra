# Architecture Decision Records

Each record: **decision → reason → alternatives → consequence**. These are
actual decisions taken while building Stages 0-8, not aspirations.

## ADR-001 — MergeSutra sits above the model/runtime layer

- **Decision:** Build a specialized issue→PR harness that *uses* BharatCode,
  rather than a general coding agent.
- **Reason:** The scarce value is trustworthy, evidence-backed contribution
  workflow, not another agent that edits files. Reading an issue, using a
  worktree, running tests, or making a PR are necessary but individually not
  differentiating.
- **Alternatives:** Fork/generalize OpenCode; rebuild the BharatCode CLI.
- **Consequence:** Strict scope discipline; a feature is in only if it makes
  "issue → evidence-backed PR" materially better.

## ADR-002 — The Acceptance Contract is the flagship artifact

- **Decision:** Convert the issue + repo policy into a versioned, structured
  contract; every final `PASS` must point to evidence.
- **Reason:** This is the defensible differentiator versus generic agents and
  versus validate-a-patch-only tools.
- **Alternatives:** Free-text "definition of done"; rely on the model's summary.
- **Consequence:** The contract must survive implementation and cannot be
  rewritten to make a solution look successful; genuine understanding changes
  are recorded as contract revisions with a reason.

## ADR-003 — Node 22+ / TypeScript strict / ESM, lean dependencies

- **Decision:** `type: module`, `NodeNext`, `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`. Runtime deps limited to `commander` + `zod`;
  `fetch` comes from the Node runtime.
- **Reason:** A CLI product should install fast, ship small, and start cold
  quickly. Strict typing plus runtime validation is required because model
  output and repo content are untrusted.
- **Alternatives:** A framework stack; Electron; a web frontend; a database.
- **Consequence:** Fewer foot-guns, smaller attack/audit surface; the dev
  toolchain (vitest/vite/esbuild) carries advisories that are dev-only and do
  **not** ship in `files` (see ADR-009).

## ADR-004 — BharatCode accessed only through an injected adapter

- **Decision:** Everything depends on the `BharatCodeClient` interface; the HTTP
  implementation injects `fetch`, a `sleeper`, and a `random` source.
- **Reason:** Keeps HTTP details out of the domain; makes the adapter fully
  offline-testable with zero live network and no secrets.
- **Alternatives:** Sprinkle `fetch`/axios calls through the codebase.
- **Consequence:** Uniform redaction, bounded retry, timeout and cancellation
  live in one auditable place; no model/provider is hardcoded.

## ADR-005 — Model output and repo text are untrusted

- **Decision:** Zod-validate every structured response; treat repository,
  issue and model text as data, never authority.
- **Reason:** Prompt-injection is a real threat when a tool reads arbitrary
  repos and then executes commands.
- **Alternatives:** Trust model JSON; concatenate repo docs into the prompt.
- **Consequence:** Malformed output triggers controlled repair or fails safely;
  an explicit authority hierarchy orders policy over content.

## ADR-006 — Never trust the process exit-code shortcut; explicit exit codes

- **Decision:** A planned command exits non-zero; `run()` returns an explicit
  exit code and uses a local setter instead of mutating `process.exitCode`.
- **Reason:** "Don't use fake success." A command that does nothing must not
  look like it succeeded — and mutating the global exit code breaks the test
  process.
- **Alternatives:** Exit 0 with a warning; hard `process.exit` in handlers.
- **Consequence:** CI and humans get truthful signals; the CLI stays testable.

## ADR-007 — Central redaction is the only path to output

- **Decision:** One `Redactor` (known values + patterns + header rules) masks
  text, headers, and nested structures; error `details` are redacted too.
- **Reason:** Secrets leak through error bodies and logs, not just explicit
  prints. A unit test caught that response bodies were being attached to errors
  unredacted, which motivated redacting `details` at construction.
- **Alternatives:** Redact at each call site (fragile).
- **Consequence:** Fewer leaks; redaction is directly covered by tests.

## ADR-008 — Bounded retries only, honouring Retry-After; never retry mutations

- **Decision:** Exponential backoff with full jitter, capped attempts, no
  infinite retry; auth (401/403) and validation errors are non-retryable;
  transient 429/5xx/timeout/network are retryable; 429 respects `Retry-After`.
- **Reason:** BharatCode is a shared service; availability must degrade to a
  useful status, never to corrupted work or a retry storm.
- **Alternatives:** Retry-on-anything loops.
- **Consequence:** Tests assert call counts deterministically via an injected
  sleeper/random.

## ADR-009 — Accept dev-only advisories over a breaking test-runner upgrade

- **Decision:** Keep the installed vitest major for Stage 0; document the
  dev-only advisories rather than run `audit fix --force`.
- **Reason:** The advisories affect the vite/esbuild dev server, which is never
  part of the published artifact (`files` ships only `dist` + docs, no
  `node_modules`). Forcing a major runner upgrade mid-foundation adds risk with
  no user-facing security benefit.
- **Alternatives:** Force-upgrade to vitest@5 immediately.
- **Consequence:** Recorded as a known limitation; a scheduled runner bump is
  part of the roadmap. Dependency scanning runs in CI.

## ADR-010 — Cross-platform is a real requirement, not a claim

- **Decision:** Use argv arrays (no shell), `windowsHide`, URL/`fileURLToPath`
  for path handling, `NO_COLOR`, and ASCII-safe status words; CI matrix covers
  Windows + Linux.
- **Reason:** The target audience and the theme both demand Windows usefulness;
  a Unix-only CLI would misrepresent support.
- **Alternatives:** Assume POSIX.
- **Consequence:** Windows assumptions are never baked into "Unix-only"
  shortcuts; Stage 13 qualifies behaviour further.

## ADR-011 — The `gh` CLI is MergeSutra's GitHub transport

- **Decision:** Read issues and repository metadata by invoking
  `gh api --hostname <host> …` as an argv array, rather than calling the REST
  API directly with a token of our own.
- **Reason:** `gh` already owns credential storage, `gh auth login`, enterprise
  hosts and keychain handling. Any token MergeSutra held would be one more
  secret to store, redact, rotate and leak. This also keeps Stage 1 free of any
  new credential requirement.
- **Alternatives:** `octokit` + `GITHUB_TOKEN`; raw `fetch` with a PAT.
- **Consequence:** Users must have `gh` installed and signed in; a missing or
  unauthenticated `gh` becomes a reportable `config`/`auth` failure with the
  exact remediation, never a crash. Tests never spawn `gh`: a scripted argv
  runner answers for it, so the suite stays offline and credential-free.
  Response payloads are still fully Zod-validated, because `gh` is a transport,
  not a trust boundary.

## ADR-012 — The run record is the report

- **Decision:** Build the versioned run record first, then render it. The object
  written to `.mergesutra/runs/<id>.json` is the same object the terminal prints,
  and every value in it carries the source it came from.
- **Reason:** A report assembled separately from persisted state can disagree
  with it, and "what did the tool actually believe?" is the question an
  evidence-backed PR has to answer. Absent values stay `null` and render as
  `NOT_AVAILABLE` rather than being filled with plausible defaults.
- **Alternatives:** Print during the run and persist a summary afterwards.
- **Consequence:** A check that cannot be recorded cannot be printed. Later
  stages resume from the record and validate it on load, so a stale or edited
  file fails loudly. A save failure is reported in the output; the run never
  implies it is resumable.

## ADR-013 — A gate is required only when a file says so

- **Decision:** A repository contract may contain five fixed gate kinds (format,
  lint, typecheck, test, build) and each is `REPOSITORY_REQUIRED` **only** if a
  CI step reaches it. A script that exists but no CI step runs is
  `DECLARED_ONLY`; anything else is `NOT_DECLARED`. MergeSutra never adds a gate
  of its own to this list, and contribution prose never becomes a check.
- **Reason:** The whole product is the evidence chain. A `PASS` that rests on a
  requirement MergeSutra invented is worse than no requirement, because the
  reader will assume the repository demanded it. Prose in `CONTRIBUTING.md` is
  untrusted text like any other file (ADR-005), and "the tool exists" is not the
  same claim as "CI blocks on it".
- **Alternatives:** Assume `lint`/`test` are always required; grep docs for
  commands; infer requirements from which files happen to be present.
- **Consequence:** On a repository whose CI is minimal the contract lists few
  required gates, which is the truth about that repository. Every row carries
  the workflow file and line that produced it, so a reviewer can check the claim
  in seconds. Unclassifiable CI steps are counted in the contract's limitations
  rather than dropped, so silence is never mistaken for a complete picture.

## ADR-014 — Follow a repository's own script chain, to a bounded depth

- **Decision:** When CI runs `npm run check`, resolve which gate that reaches by
  following declared scripts (any `npm|pnpm|yarn|bun|npx [run] <name>`
  invocation) up to 3 levels deep, cycle-safe, preferring the script whose name
  is itself a known gate. The *command* recorded for the gate is the carrier
  script's own command, not the CI line's.
- **Reason:** The dominant real-world pattern is one composite script, so
  matching only CI's literal command gave MergeSutra's own repository **zero**
  required gates while `ci.yml` plainly enforces all five. That was a lie by
  blindness, and it is exactly what Stage 2 exists to prevent. The depth cap and
  cycle guard exist because a script chain is untrusted input: it may be long,
  indirect, or self-referential.
- **Alternatives:** Match only the CI command text (wrong on composite scripts);
  execute `npm run check` and watch what runs (executes repository code during
  read-only discovery — refused); let the model guess what a script does
  (untrusted output presented as repository evidence — refused).
- **Consequence:** Resolution is a static scan with a stated limit, so a script
  that reaches a tool through a shell loop or a nested `node tools/x.js` stays
  unclassified and is reported as an unexplained CI step. Preference for a named
  carrier also fixes a real safety bug found while building this: a repository
  declaring both `format` (`prettier --write .`) and `format:check` must never
  have the write-capable script named as the gate a check needs.

## ADR-015 — Unverifiable is a type, not a tone

- **Decision:** The Acceptance Contract is a set of Zod discriminated unions in
  which the dishonest shapes are unconstructible: `status: 'PASS'` requires at
  least one `executed: true` evidence with a result; `PENDING` forbids evidence
  entirely; an `executed` evidence cannot omit `command` and a result; a
  `static_review`/`manual` step cannot carry a command; every object is
  `.strict()`, so `confidence`, `score` and free-text `notes` have nowhere to go.
  Stage 3 can therefore only emit `PENDING`, and says so.
- **Reason:** Everything downstream of this artifact is a model reading prose
  and a human skimming a report. A rule that lives only in documentation —
  "`PASS` means evidence exists" (ADR-002) — is the first thing a confident
  implementation loop learns to route around. If the value cannot be built, no
  prompt, no time pressure and no "tests obviously pass" can produce it.
- **Alternatives:** Validate after construction with a reviewer function (an
  invalid object can still be handed to the next layer); put the rule in
  AGENTS-style prose (unenforceable); allow `PASS` with a model justification
  (converts confidence into verification, explicitly forbidden).
- **Consequence:** Hand-written schema code is more verbose than a flat type,
  and the unions must be built through a helper because `z.discriminatedUnion`
  loses literal narrowing when wrapped — a cost paid once so that every later
  stage inherits the guarantee. Evidence itself stays a designed shape: it is
  only filled at Stage 7, and the schema is already ready for it.

## ADR-016 — An empty Acceptance Contract is refused, not emitted

- **Decision:** When no criterion can be traced to the issue's own acceptance
  list, a CI-enforced gate, or a named human, `contract` raises
  `AcceptanceContractUnavailable`, stores an `INCONCLUSIVE` record listing the
  limitations, exits `3` and writes no contract. `criteria` has `min(1)`.
- **Reason:** "There are no requirements" is a claim about the issue, not an
  observation about what MergeSutra could parse. Emitting an empty contract would
  hand a later stage a document that authorises anything, and a reviewer reading
  the report would see a completed stage rather than a failed one.
- **Alternatives:** Emit `criteria: []` (silent licence); let the model invent
  criteria to fill the gap (refused — Stage 4 records a model's suggestion as a
  `MODEL CLAIM` inside the plan, and the only route into this schema is a human
  typing `--criterion … --by …`); exit `0` with a warning (rewards the failure
  path).
- **Consequence:** The stage is only useful after intake, and it says which run
  it read. A run whose issue writes no list still gets a contract from the
  repository's required gates — and a limitation naming what is missing — so the
  gap is visible instead of being papered over.

## ADR-017 — A plan is a different artifact from a contract, not a note on it

- **Decision:** Stage 4 produces `ImplementationPlan`, its own Zod type, stored
  beside the contract at `record.plan` and never merged into it. The plan type
  has no `status`, no `evidence`, no `confidence` and no `verifiedCriteria`
  field, and sets `untrusted: true` through a schema `.default()` so the flag
  cannot be left out or argued down. Its outcome is `PLAN_COMPLETE`, not the
  spec's `PLAN_READY`: nothing in Stage 4 establishes that a plan is ready to
  run.
- **Reason:** The first place a model speaks is the first place a lie can be
  recorded. If a plan were an edit to the contract, "the model says AC-3 is
  handled" would be one JSON field away from becoming a status. Making the plan
  a separate, visibly weaker artifact means the reader meets the distinction
  before meeting the content.
- **Alternatives:** Attach `planNotes` to each criterion (invites the next stage
  to read a proposal as progress); keep plans as markdown prose (unvalidatable,
  and the traceability ids become a suggestion); name the outcome `PLAN_READY`
  for vocabulary fidelity (claims readiness no gate produced).
- **Consequence:** Every plan-carrying screen has to say what a plan is not, so
  `mergesutra plan` ends with two dim lines saying exactly that, and the
  `Execution` and `Verification` checks are `NOT_AVAILABLE` by construction.
  Two artifact types also means two schemas to keep in step when evidence
  arrives at Stage 7.

## ADR-018 — The contract's ids are a closed list the plan must satisfy

- **Decision:** The planner is given the criterion ids as a fixed set and the
  stored plan is rejected if it names an id outside the set or omits one it was
  given — omission is only allowed as an explicit `criteriaUnaddressed` entry
  with a reason. A schema failure is fed back to the model exactly once with the
  reason; a second bad answer is stored as `INCONCLUSIVE` with the refusal
  quoted.
- **Reason:** A plan that quietly narrows the obligations is the most damaging
  thing a planning stage can produce, because it looks complete. Coverage is the
  one property of a model answer that can be checked deterministically, so it is
  checked, and the check runs before storage rather than in review.
- **Alternatives:** Trust a prompt instruction to "cover everything" (the
  failure this guards against is precisely the plausible-looking one); repair
  until the model complies (unbounded spend, and an eventually-agreeable model
  proves nothing); accept an uncovered criterion silently (a gap the report
  would have to rediscover).
- **Consequence:** Legitimate work outside the contract has nowhere to go
  except `criteriaUnaddressed` or `proposedCriteria`, which is the intent — but
  it also means a genuinely missing requirement is visible as a `WARN` row
  ("1 MODEL CLAIM(s), not requirements") rather than as a criterion, and closing
  that gap costs a human running `contract --criterion`.

## ADR-019 — The planner holds no process runner, at the type level

- **Decision:** `PlanDeps` has no `Runner`, no filesystem writer and no GitHub
  client. Proposed commands must be argv arrays free of shell composition
  characters, and proposed paths must be repository-relative POSIX — both
  enforced by schema refinements so an unsafe proposal cannot be stored at all,
  let alone run.
- **Reason:** Dependency injection is only a safety property if the missing
  dependency cannot be acquired. A stage that can execute a command can execute
  the command an untrusted model just proposed, no matter what its prompt says;
  removing the parameter from the type is what makes "planning runs nothing" a
  structural fact instead of a behaviour that has to be re-tested forever.
- **Alternatives:** A runtime flag (`--dry-run` style: one refactor away from
  being threaded through); approval prompts before executing (moves the decision
  to a human reading a proposal they cannot verify); validating argv at the
  runner (correct as defence-in-depth, but the runner would still be reachable
  from the planner).
- **Consequence:** Stage 5/6 need their own module boundary to gain execution
  rights, which is the design anyway. It also means a plan's commands are
  untested suggestions with no result beside them, so the renderer labels the
  section "proposed argv, never run here" rather than printing them as checks.

## ADR-020 — Redaction masks strings, never structure

- **Decision:** `Redactor.deep()` replaces string leaves only. A value stored
  under a secret-shaped key name (`promptTokens`, `apiKeyId`, `token_count`) is
  inspected first: numbers, booleans and `null` pass through untouched, arrays
  and objects recurse, and only a string — anywhere in the tree — becomes
  `[REDACTED]`.
- **Reason:** Wiring Stage 4 found the bug in the shipped Stage 0 layer: the
  key-name heuristic masked `promptTokens: 120` into `'[REDACTED]'`, so
  `createRunRecord` rejected the plan record with "Expected number, received
  string". A redactor that corrupts a counter is not being careful, it is
  destroying evidence — and the failure appears in the consumer, far from the
  cause.
- **Alternatives:** Mask by key name at any depth (what shipped, and what broke
  the numeric fields every provenance record needs); redact at the print
  boundary only (leaves stored copies unredacted); whitelist which numeric
  fields may survive (a list that has to be right every time, versus a rule
  about types that is right once).
- **Consequence:** Two regression tests pin the behaviour, including a secret
  hidden at depth under a secret-shaped key. A secret expressed as a number
  cannot exist, so nothing is lost by the type check — but any future
  non-string credential carrier (a BigInt-shaped token, a binary blob) would
  need its own rule rather than the blanket key-name guess.

## ADR-021 — Risk is read off the argv, never off the caller's label

- **Decision:** `ToolOp` carries an operation and its arguments, not a risk
  class. `riskOf()` derives `READ / WRITE / EXECUTE / NETWORK / REMOTE_MUTATION /
  DESTRUCTIVE` itself, and for a command that means parsing the argv: the
  program basename (case-folded, `.exe/.cmd/.bat/.com` stripped), the Git
  subcommand after skipping `-C <path>`, the flags beside it.
- **Reason:** The callers of Stage 6 onward are shaped by model output and
  repository text. A `risk` field would be a declaration an untrusted caller
  gets to make, and `git push --force` labelled `read` would walk straight
  through — which is the same "data pretending to be authority" the authority
  hierarchy exists to stop.
- **Alternatives:** Caller-declared class with a sanity check (the check becomes
  the policy, so the field is dead weight); a program allowlist (approves `git`
  and then every Git subcommand inherits that approval); a denylist (a list that
  is wrong the first time someone finds a synonym).
- **Consequence:** The policy owns the flag and verb tables, and those tables are
  the maintenance burden they look like: a Git subcommand nobody classified falls
  through to `EXECUTE`, which still requires argv shape, a bare program name and
  a confined working directory. Unsorted is never read as safe.

## ADR-022 — A worktree lives inside the repository, and must prove it is ignored first

- **Decision:** Workspaces go to `.mergesutra/worktrees/<run-id>` **inside** the
  target repository, on their own branch `mergesutra/<run-id>`, and the run
  creates nothing until `git check-ignore` exits `0` for that path.
- **Reason:** Keeping a run's evidence, state and workspace under one ignored
  directory means one path answers "where did this run touch", and the relative
  confinement the writer enforces is the same shape as the repository. The
  obvious cost is polluting a human's checkout with a second working tree, so
  MergeSutra asks Git — which knows about `.gitignore` negations,
  `info/exclude`, the global `core.excludesFile` and nested ignore files —
  instead of parsing ignore rules itself and hoping.
- **Alternatives:** A sibling directory outside the repo (breaks the one-run-one-
  place story, can cross devices, and leaves the cleanup outside the repo's own
  ignore rules); editing `.gitignore` to make the path ignored (writes to a
  tracked file the human owns, for MergeSutra's convenience); `--git-dir`
  tricks, which the policy classifies as DESTRUCTIVE for good reason.
- **Consequence:** A repository where `.mergesutra` is untracked but not ignored
  cannot run Stage 6 until a human ignores it, and the refusal says exactly that
  and does not offer to do it for them. Two tests drive real Git here rather
  than a scripted runner, because the check-ignore contract is the part a mock
  would be sure to get wrong.

## ADR-023 — A dirty primary checkout is reported, never repaired

- **Decision:** `prepareWorkspace` samples `git status --porcelain` in the
  primary checkout, records the count, up to ten paths, and `primaryDirty`, and
  proceeds. It never stashes, cleans, resets or checks out. A second call reuses
  the workspace at the same base SHA, refuses a workspace at a different SHA
  rather than resetting it, and refuses to write into a directory that already
  exists.
- **Reason:** Uncommitted work is the most valuable and least recoverable thing
  in a developer's tree, and MergeSutra is a guest in it. Every convenient fix
  for a dirty tree — auto-stash, `git clean -fd`, `checkout -- .` — is in the
  class this stage exists to refuse. A tool that tidies the environment so its
  own pre-flight passes has also destroyed the description of the environment it
  claims it ran in.
- **Alternatives:** Require a clean tree (blocks a run over one scratch file, and
  is pointless: a fresh worktree at a recorded SHA is clean regardless);
  auto-stash with restore (leaves a stash entry nobody made, and fails on the
  conflict); proceed silently (the reviewer then believes the run saw the
  committed state).
- **Consequence:** Runs can start in a messy checkout, and the run record says
  so — which is the point. Reuse means a crashed run's workspace survives for
  the retry instead of being deleted by the next attempt; deleting it is
  deliberately left to the human, since deletion has no approval path (ADR-024).

## ADR-024 — DESTRUCTIVE has no approval path, and neither does the writer have a delete

- **Decision:** `REMOTE_MUTATION` is blocked until a human approves that exact
  action summary, matched literally. `DESTRUCTIVE` is refused with
  `requiresApproval: false` — no flag, no confirmation phrase, no typed path.
  `openConfinedWriter()` exposes `writeText` and `exists` only, so there is no
  delete, rename or chmod method for a later stage to reach for.
- **Reason:** An approval prompt degrades into a keystroke the moment it appears
  more than once, so the question "can this be undone?" must not be answered by
  a keystroke. Keeping deletion out of the writer's type is the same decision
  made structural: Stage 7 needs a file to disappear, and a method that exists
  will be called by whoever is in a hurry.
- **Alternatives:** Double confirmation, or a typed path (both convert an
  irreversible act into a UI problem); an `--allow-destructive` flag (CI sets
  flags, and a wrapper script is a caller that will set it); a `--yes` mode
  (the same thing, spelled shorter).
- **Consequence:** Some runs genuinely cannot finish inside MergeSutra — worktree
  cleanup is the everyday one, and the docs tell the human to run
  `git worktree remove` themselves. That is the intended shape: the tool's
  ceiling is the human's keyboard, not a prompt.

## ADR-025 — Confinement compares realpaths, and says what it still cannot prove

- **Decision:** The writer resolves before it judges. A candidate path is joined
  lexically, rejected if any segment is `..` or `.git`, then every **existing**
  ancestor is `realpath`'d — walking up to the first component the filesystem
  agrees about and re-joining the missing tail — and the result must still sit
  inside the realpath'd root. Windows is why this is not optional:
  `C:\Users\PAVITH~1\…` and `C:\Users\Pavithran R A\…` are one directory and
  unequal as strings.
- **Reason:** A containment check on the spelling of a path is a check on what
  the caller typed. Symlinks, junctions, case-insensitive volumes and 8.3
  aliases all preserve the string while changing the destination, and a
  non-existent leaf is exactly what a "write this new file" request looks like,
  so a check that gives up when a path does not exist yet refuses nothing at
  all.
- **Alternatives:** Lexical-only plus a final `realpath` of the full path
  (throws on the not-yet-created file it exists to authorise); `O_NOFOLLOW` and
  descriptor-relative writes (unportable on Windows, where this ships first);
  trusting the caller to pre-resolve.
- **Consequence:** This removes traversal, absolute-path, symlink, junction and
  short-name escapes for writes. It does **not** remove a TOCTOU window between
  the check and another program's write, and the policy's own confinement stays
  lexical — the writer is the enforcing copy. Running commands is Stage 7's
  problem, and a policy `ALLOW` is deliberately not documented as proof that a
  command cannot escape; the worktree is isolation for clarity, not a sandbox.

## ADR-026 — Stage 5 ships as a library with no command

- **Decision:** No new subcommand. `mergesutra run` still exits `2` as planned,
  and `src/git/`, `src/process/` and the two new security modules are reached
  only by tests, two of which drive real Git in a scratch repository.
- **Reason:** A command would have to show something, and the only thing these
  modules can honestly demonstrate today is refusal. Worse, `mergesutra
  workspace` invites the reading "MergeSutra can now change repositories" — a
  claim about the implementation loop, verification engine and review stage that
  do not exist yet, and exactly the kind of aspiration the status rules forbid.
- **Alternatives:** `mergesutra workspace create/remove` (offers a remove the
  policy refuses); a `--dry-run` demo command (a second code path that is never
  the real one); writing a file to show off the writer (a mutation for a
  screenshot).
- **Consequence:** This stage looks like no progress from the CLI, and the
  ROADMAP, CHANGELOG and 68 tests carry the evidence instead. The upside is
  structural: Stage 6 was meant to be the first real caller, so the API is small
  and gets shaped by its consumer rather than by a command that had to look
  useful — and that is what happened. `src/implement/loop.ts` is the only module
  that opens the confined writer, and it inherited the writer's one-method
  surface rather than gaining a delete (ADR-027).

## ADR-027 — A model write is a whole file, and there is only one write protocol

- **Decision:** `WRITE_FILE` carries the complete intended content of one file
  (capped at 64 KiB per action) and is applied through the Stage 5 confined
  writer. There is no patch, no diff, no append, no multi-file edit operation,
  and no second way for model text to become a file.
- **Reason:** Stage 6 was required to ship one documented write strategy rather
  than a menu. A patch is a second protocol with its own escapes — hunk context,
  fuzz, line endings, path rewriting, "which copy of the file am I patching" —
  and every one of them is a place where an untrusted document can describe a
  destination MergeSutra then trusts. A whole file can be size-checked,
  confinement-checked, digested and written atomically with no parser in the
  path at all.
- **Alternatives:** unified diffs plus a patch applier (a parser fed by the
  model, and a base-content match it can be lied about); line-oriented edit
  operations (`insert after line 40`) which are a mini-language the model must
  get exactly right and which re-open the "model text decides what runs" door;
  `fs.writeFile` straight from the loop, which bypasses every Stage 5 guarantee.
- **Consequence:** Changing three lines of a large file costs the whole file's
  tokens, and the per-action and per-loop byte ceilings are what keep that
  honest. Content is never stored in the run record — only path, byte count,
  whether the file was new, and a sha256 — so a pasted record cannot leak a
  repository file. It also means a write can clobber an edit someone else made
  in the same workspace; that is accepted because the worktree belongs to one run
  and nothing is committed, so the human still sees the difference as a diff.

## ADR-028 — Reading is a budgeted action, so a model cannot be talked into sending the repository

- **Decision:** The loop decides what leaves the machine. The first turn carries
  only the files the plan names, each truncated at a per-file cap, under a
  per-loop byte and file-count budget, with credential-shaped paths, `.git`
  paths and binary files withheld and the withholding reported. After that, more
  repository content arrives only as the result of a `READ_FILE`, `LIST_FILES` or
  `SEARCH` action — each one confined, size-bounded, and charged to the same
  budget until it runs out and is refused.
- **Reason:** "Send the model whatever it asks for" is how a context window
  becomes an exfiltration channel, and the thing being exfiltrated is a
  repository the model has no right to see in full. A budget that is spent, and
  visibly spent, is the only claim about size that survives contact with a
  hostile file. Withholding is recorded as a policy fact rather than an error so
  a reader can tell "the model never saw it" from "nobody looked".
- **Alternatives:** a whole-repository dump with a "summarise this" prompt (the
  cheapest possible design and impossible to bound); an embedding/retrieval layer
  (a second system with its own failure modes, for a stage whose real job is
  confinement); letting the model name a directory to read recursively (a
  `node_modules` walk that spends the run in one turn).
- **Consequence:** A model working outside the plan's file list pays turns for
  its exploration and can run out of budget mid-task; when it does, the refusal
  text says so and the record carries `Context withheld by policy or budget`
  lines. The tree sample is names only, and MergeSutra's own runtime and
  dependency directories are excluded from listings so a run never reads its own
  scaffolding back to itself.

## ADR-029 — No-progress is judged on the action and the state it produced, not on the model's prose

- **Decision:** Every executed action contributes a structural identity —
  operation plus normalised target — hashed together with the result it
  produced. `maxRepeatedFailures` consecutive identical pairs end the run with
  `REPEATED_FAILURE`, and the turn before the last one warns the model in the
  feedback text.
- **Reason:** A loop that asks for the same failing command forever is the
  classic way an API bill grows while nothing happens, and the obvious detector —
  similarity of the model's messages — is the one a reworded retry defeats. The
  reason field is prose; the action and its outcome are facts. Judging on those
  means "the same failure described more hopefully" is still the same failure,
  while a genuine second attempt after a write lands looks different because the
  write changed the state it is hashed against.
- **Alternatives:** counting total turns only (already covered by `maxSteps`, and
  it punishes productive exploration instead of stalling); comparing the model's
  text (a thesaurus defeats it); tracking a full diff-state hash (more accurate
  and far more expensive for the same judgement).
- **Consequence:** Two writes to the same path with different content are two
  attempts, which is right, and a search that differs only in case counts as the
  same attempt, which is also right. The end is a `NEEDS_HUMAN_REVIEW` outcome,
  not an error: the work done before the stall is kept, the workspace stays put,
  and the record names the identity that repeated so a human can see what the
  loop was stuck on.

## ADR-030 — A run advances in place, so one id names the record, the branch, the workspace and the diff

- **Decision:** `implement` writes to the run id it was given. The workspace
  directory (`.mergesutra/worktrees/<run-id>`), the branch
  (`mergesutra/<run-id>`), the stored record and every action row all carry that
  one id. Re-running a stage resumes rather than forking.
- **Reason:** Stage 4 deliberately forks a new id, because a plan is a draft that
  a second opinion replaces. Stage 6 changes files on disk, and a changed file
  cannot be un-forked: a new id per attempt would leave a second worktree, a
  second branch and two half-related diffs for the same work, and the human would
  be left to guess which one to read.
- **Alternatives:** fork per attempt (workspace sprawl, and resume becomes
  "replay the earlier run"); a sequence of child ids like `run-…-impl-2` (a
  second naming scheme to explain, and the workspace path no longer matches the
  run id it was built from); an explicit `--resume` flag (a mode switch for
  something that should just work).
- **Consequence:** `reused: true` becomes a fact worth recording, and a resumed
  run sees its earlier files because the directory was never reset. It also means
  a stale workspace is a real condition — one left at another commit — which the
  workspace preparer refuses outright instead of correcting, so nothing a human
  or another run did to that directory can be silently discarded.

## ADR-031 — A missing credential is a configuration refusal, before a workspace exists

- **Decision:** The stage builds its BharatCode client — and therefore requires
  `BHARATCODE_API_KEY` — after it has confirmed the run has a contract, a plan
  and a base commit, and before it creates a worktree.
- **Reason:** Built the other way round, an unconfigured machine got a new
  directory, a new branch, a written run record and an `INCONCLUSIVE`
  implementation, because the failure surfaced as a model request that could not
  be made. That is a fabricated state: the run reports having tried, and the
  truthful report is "this machine cannot run this stage", which is exit code 78
  and nothing on disk.
- **Alternatives:** checking in the loop (where a request failure must stay
  recoverable, so it cannot also be a config gate); letting the workspace
  preparer run first and cleaning up afterwards — a delete Stage 5 rightly
  refuses to offer.
- **Consequence:** `mergesutra implement` on a machine with no key is a
  one-line refusal, and a test asserts no git invocation happened at all. The
  ordering also means the record guards (no contract, no plan, no base sha) are
  all paid for before any configuration error, because those describe the run
  rather than the machine.

## ADR-032 — `.` is a directory and not a file, and the schema says so

- **Decision:** Two path shapes are validated separately: a file path must be
  repository-relative POSIX with no `..`, no absolute prefix and no empty
  segments; a directory path may additionally be exactly `.`, which is the only
  spelling accepted for the workspace root.
- **Reason:** Listing and searching are naturally rooted at the whole workspace,
  and a model asked for "a relative path" has no way to say that except `.` or an
  absolute path. Refusing `.` while offering `..`-free paths does not stop the
  request, it just pushes the model into the answer the security rules genuinely
  care about — an absolute path that looks like an attempt to escape.
- **Alternatives:** allowing `.` for files too (a read of the root directory is
  not a file read, and the confined reader would be the thing that has to explain
  why); allowing an empty path for "everything" (an empty string is exactly the
  shape a missing field arrives as, so it cannot also be meaningful);
  normalising `.` away in the writer (a second path language, in code, after the
  check).
- **Consequence:** `isRepositoryRelativePath` and
  `isRepositoryRelativeDirectory` are two functions with two rules, and every
  action declares which one it uses. The error text names the rule that was
  broken, because a model that gets `invalid_type` learns nothing and retries the
  same mistake.

## ADR-033 — Stage 6's status vocabulary has no word for "passing"

- **Decision:** The implementation record cannot express a criterion verdict.
  There is no status field on a criterion anywhere in it; `status` describes the
  loop (`COMPLETED_BY_MODEL`, `BLOCKED`, `NEEDS_HUMAN_REVIEW`, `INCONCLUSIVE`,
  `CANCELLED`), and a `FINISH` answer is stored as a claim — `termination.kind:
  'FINISH'`, the criteria the model believed complete, and a run outcome of
  `IMPLEMENTED_BY_MODEL`.
- **Reason:** "The model said it finished" and "the acceptance criteria hold" are
  two different sentences, and the product's whole value is that it never
  collapses them. Anything representable will eventually be written by a bug or
  pressed into it by a model; a schema with no field for `PASS` removes the
  option. The run even ends with exit code 3 (`INCONCLUSIVE`) rather than 0,
  because a terminal that believes exit codes should not believe this one.
- **Alternatives:** a `verified: false` flag on a passing status (a flag is a
  boolean away from being dropped); a "provisional pass" status (a new word for
  the thing this stage must not claim); printing the model's summary as the
  result (the summary is kept, but as `finishClaim`, in a field named for what it
  is).
- **Consequence:** Stage 7 is the only stage that can move a criterion off
  `PENDING`, and the record says so in its own limitations: `Nothing here is
  verified`. The renderer shows the claim as `WARN` with the words "a claim, not a
  verdict", and a test asserts that no criterion id ever appears beside a
  `PASS` row.

## ADR-034 — A program token with a space in it is refused before the process is spawned

- **Decision:** `isBareProgram` rejects any token containing whitespace, a
  backslash, a slash or a drive prefix, in addition to the shell-syntax
  characters Stage 1 already refused. `['npm test']` is therefore a refusal, not a
  failed spawn.
- **Reason:** Because `argv[0]` is the program and the rest are its arguments,
  one token that survives the shell-syntax check can still be a whole command
  string wearing an array's clothes. No search path contains a program named
  `npm test`, so the alternative to refusing it here is a doomed `ENOENT` whose
  error text the model reads as "this does not work" rather than "that shape is
  not allowed".
- **Alternatives:** splitting on whitespace (which is precisely the shell's
  behaviour, reintroduced by the front door); relying on the tool policy alone
  (the policy classifies risk and cannot see that a name has no referent);
  letting it fail at spawn (a real process attempt, and a leaky error message).
- **Consequence:** Path-shaped programs — `./scripts/x.sh`, `C:\tools\git.exe`,
  `/usr/bin/curl` — are refused in the same place, so "the repository decides
  what runs" is closed at the schema rather than being a policy judgement made
  later. A program the search path cannot find is still an ordinary failed check
  with the name in its stderr, which stays in the action log.

## ADR-035 — Running a repository's command is a capability, not a flag

- **Decision:** A discovered gate executes only if the operator names its id
  (`--allow VG-001`), and the resulting `ExecutionConsent` carries
  `scopeDigest(plan)` — a sha-256 over the exact set of `id`, `cwd` and `argv` the
  plan holds. The engine checks the digest before it spawns anything; a mismatch
  returns `BLOCKED_REPO_EXECUTION_CONSENT_STALE` and the gate does not run. An
  empty `--allow` list is no consent, not a wildcard, and `--allow all` is a
  malformed id that fails before a process starts.
- **Reason:** A CI command is someone else's code, chosen by a repository MergeSutra
  treats as untrusted data. The dangerous version of "run the checks" is a boolean
  that, once true, applies to whatever the discovery step happens to produce next —
  including after a resume, after an edit, or after a rename that turned a `lint`
  into an `install`. Binding the yes to the digest makes it a capability that
  expires exactly when the thing it described stops existing.
- **Alternatives:** `--yes` / `--dangerously-skip-consent` (one flag, every gate,
  including the ones added on the next run); a config allow-list of command
  prefixes (a second, weaker matcher that a rename slips past); asking
  interactively per gate (unusable in CI, and a prompt that auto-confirms under a
  pipe is the same hole with more ceremony).
- **Consequence:** The default `mergesutra verify <run>` is a no-execute run that
  prints the ids and the exact command to re-run, and exits `4`. That is a longer
  path to a green gate, and it is the point: the report of an unconsented run is
  legible evidence about what *would* be checked, never a pass. The patch binding
  is a separate check (ADR-036) — the engine refuses to run any gate whose plan no
  longer describes the workspace — so a consent that names the right commands
  still cannot be spent against the wrong bytes.

## ADR-036 — A patch is named by a digest, so evidence can be proved to describe it

- **Decision:** `describePatch` computes a sha-256 over the workspace's
  uncommitted state against the run's base commit — tracked diff, untracked
  additions, deletions, renames as one gone plus one arrived, with `.mergesutra/`,
  Git internals and nested worktrees excluded even when the repository forgot to
  ignore them. The plan, every receipt and the evidence document all carry it, and
  `stalenessOf` compares the verified identity with the one on disk now.
- **Reason:** "The tests pass" is a sentence about a set of bytes. Without an
  identity, the passing and the bytes can drift apart — the classic failure being a
  resume that edits after a green run and reports yesterday's receipts. A digest
  makes drift observable, and observable drift can be marked `STALE` instead of
  being trusted or quietly discarded.
- **Alternatives:** `git status` output as the identity (ordering and locale make
  it unstable, and it does not cover untracked content); commit hash (there is no
  commit — the run's contract is that it touches nothing the human owns); mtime or
  size (a rewrite back to identical bytes reads as a change, an identical rewrite
  of different bytes does not); trusting the workspace path (a path says where,
  never what).
- **Consequence:** Verification is against bytes on disk, not against a promise in
  the plan, so a `verify` run after further implementation edits is a fresh
  measurement rather than a resume of the old one — and evidence that goes stale
  stays in the report, marked, because hiding it would leave a reader unable to
  tell "no gate covers this" from "a gate covered an older patch".

## ADR-037 — A gate's verdict is its exit code, and an exit code alone is not a criterion's verdict

- **Decision:** One command, one receipt: `PASS` for the exit code the plan
  predicted, `FAIL` for any other, and `BLOCKED` / `INCONCLUSIVE` for a process
  that never started, timed out or was cancelled — never a fake `FAIL`. The
  run-level result is the conservative combination over gates. Whether an
  acceptance *criterion* holds is derived separately, from those receipts plus the
  criterion's own verification plan, and is stored as a `sufficiency` beside its
  `status`.
- **Reason:** Collapsing the two is how verification software starts grading
  homework instead of checking it — a suite that exits 0 gets credited to whatever
  the run was about. Keeping gate result and evidence sufficiency distinct means a
  green build can be honestly reported as "nothing here proves AC-2", which is the
  sentence a reviewer needs and a summary metric hides.
- **Alternatives:** a numeric confidence between the two (an unaccountable number
  that everyone reads as a probability); one merged status (the collapse just
  described); letting a model's judgement fill the gap (its answer is in
  `claims`, weighted nothing).
- **Consequence:** `missingPrerequisites`, timeouts and unconsented gates all stay
  visible rows rather than becoming `PASS` by absence, and a `VERIFICATION_PASS`
  outcome means "the gates named and consented to exited as predicted" — which is
  not, and does not claim to be, "this patch should be merged".

## ADR-038 — Which criteria a gate proves is a command-spelling match, and the spelling set is the gate's own reach

- **Decision:** A criterion is evidence-linked to a gate only when the command the
  criterion names equals one of that gate's `commandForms`: the invocation CI
  spells, plus every package-script body it chains into, followed to a bounded
  depth, with case preserved. `npm test` and the `vitest run` it runs are one
  command for this purpose. Nothing else links them — not a shared word, not a
  matching `requirementType`, not a model's opinion about coverage.
- **Reason:** The tempting version is a similarity heuristic, and it fails in the
  direction that matters: a broad green suite gets credited to a criterion about a
  narrow behaviour, and the report reads as though the specific thing was checked.
  A spelling match can be wrong in the other, safer direction — a criterion
  phrased loosely stays `NOT_VERIFIED` — and when it is wrong, the fix is to state
  the check the way the repository states it, which is information a human has.
- **Alternatives:** keyword or fuzzy matching (credits an unrelated green run);
  matching on gate kind (a `test` gate proving any `test` criterion is precisely
  the over-claim); asking the model which criteria a command covers (ADR-033).
- **Consequence:** Discovery has to know a script's body, so `commandForms` became
  part of the persisted gate and one rule has one copy: `relevantCriteriaFor` and
  the evidence mapper ask the same function. The cost is honest but visible — a
  criterion whose check nobody wrote down the way CI does it is reported as not
  verified, and the report says which commands did run.

## ADR-039 — A verification that passes still may not call the contribution ready

- **Decision:** Stage 7 introduces five run outcomes (`VERIFICATION_PASS` / `FAIL`
  / `BLOCKED` / `INCONCLUSIVE` / `CANCELLED`) and no `CONTRIBUTION_READY`, which
  stays out of the outcome vocabulary. The evidence document's
  `contributionReady` is `z.literal(false)`, so the field exists only to record
  that it cannot be set, and a passing run's `nextStage` names a `review` command
  that does not exist yet.
- **Reason:** Readiness is a judgement about a diff's merit, its scope, and whether
  anyone wants it — none of which a set of exit codes establishes. A product whose
  headline claim is honest statuses gains nothing by being the one that says
  "ready" first, and loses the claim the moment a reviewer finds `READY` beside a
  patch that passes lint and changes the wrong file.
- **Alternatives:** `CONTRIBUTION_READY` when every mandatory gate passes (a
  mechanical synonym for "verified", which the record already says); a
  `LIKELY_READY` state (a euphemism with a status's authority); omitting the field
  (a later stage would then add it as a real flag rather than fight a literal).
- **Consequence:** `verify`'s report ends under its own limit — a gate `PASS` is
  one command's exit code, a criterion `PASS` is that command plus the mapping this
  record publishes — and the human judgement arrives where ADR-033 pointed, one
  stage later. The hero fixture asserts the report never contains the string
  `CONTRIBUTION_READY`.

## ADR-040 — The engine re-measures the workspace after every gate, and a gate that moves it voids the run

- **Decision:** Each gate is followed by a fresh `describePatch`. If the identity
  moved, the run records `contamination` naming which gate moved the workspace and
  its result is `INCONCLUSIVE`, whatever the exit codes said. MergeSutra's own
  commands are the only mutation-capable thing allowed to be *observed* this way;
  nothing in the stage edits the patch, fixes a failure, or installs a dependency.
- **Reason:** A receipt describes a patch. If a gate — `prettier --write`, a
  snapshot updater, a codegen step — rewrote the tree, every later receipt is
  measuring bytes the earlier ones did not, and a verdict assembled from them is
  fiction with a table. Reporting contamination is also the only way a reviewer
  learns that this repository's "check" is a formatter, which is the kind of thing
  no one writes down.
- **Alternatives:** declaring gates `READ_ONLY` and trusting the declaration (the
  `executionClass` is kept as a disclosure precisely because a test suite can
  write a file); re-running the plan after a mutation (now two patches, and the
  first receipts are still stale); auto-fixing and continuing (the failure mode
  this whole stage exists to avoid, dressed as convenience).
- **Consequence:** A gate order can turn a green run into an inconclusive one, and
  the report says so plainly with the offending id, so the honest operator action
  is to re-run — the run is cheap, deterministic, and consents again — rather than
  to reason about which receipts survived.

## ADR-041 — The hero fixture runs real processes and asserts its own teeth

- **Decision:** One end-to-end integration test (`tests/verify/hero.test.ts`)
  drives the shipped stages against a scratch Git repository: real `git`, real
  `node --test` child processes, the real patch digest, the real consent flow, and
  the printed report. Its last block writes the regression test back against the
  *base* implementation and asserts the same command exits non-zero. The model
  turns in the chain come from the local stub.
- **Reason:** A verification engine can be demonstrated by a fixture that hands it
  convenient receipts, and such a fixture proves only the plumbing. The assertion
  that the test fails without the fix is what makes the rest of the chain evidence:
  it rules out the one shortcut that would leave everything else green and
  meaningless — a fixture whose "regression test" passed either way.
- **Alternatives:** a recorded output committed as a fixture (proves nothing about
  the present tree); unit tests alone (they check each rule, and no test checks
  that the AC→VG trace survives into the report a human reads); a live BharatCode
  run (needs a credential, is nondeterministic, and would prove the model rather
  than the harness).
- **Consequence:** The suite is slower here by design, the README's Stage 7 capture
  is this test's real stdout rather than hand-written prose, and the stub is
  labelled as such wherever the output appears — the honest description being
  "deterministic development capture using the local BharatCode-compatible test
  stub", never a claim of a live run.

## ADR-042 — The evidence pack is a rendering of the record, never a second decision-maker

- **Decision:** `src/report/pack.ts` may arrange facts already in the run record
  and may not add one. The criteria table copies each row's `status`,
  `sufficiency` and `gateIds` out of `record.evidence`; `report.json` embeds the
  evidence document, the verification plan and the execution consent as they were
  filed; the renderer's own strings are headings and the sentence "this command
  decided nothing". `contributionReady` in the JSON is a literal `false` written
  by the renderer, which is the one fact it asserts and the one ADR-039 already
  settled.
- **Reason:** The moment a packaging step is allowed to reason, there are two
  places a verdict can come from and only one of them is auditable against a
  receipt. Keeping the pack a projection also makes the sharpest reviewer
  question answerable by opening one file: "did this run really pass?" is
  answered by the record, and the pack cannot flatter it. The first test in
  `tests/report/pack.test.ts` asserts exactly this — a run that never verified
  produces a pack with no `VERIFIED` and no `PASS` anywhere in it.
- **Alternatives:** a report that re-derives sufficiency from the receipts
  (a second mapper, free to disagree with the first); a report that hides a
  caveat it judges stale (deciding, not rendering, and invisible from the page);
  emitting only JSON with a separate viewer (the reviewer then has to run
  something to see what a run established, which is Stage 8's whole failure
  mode).
- **Consequence:** Any verdict a future stage wants a reviewer to see must be
  written into the record by the stage that earned it — the pack will print it
  once it exists and will not guess at it while it does not. This is also why
  Stage 8's integration proof is the hero run's own record rendered off disk:
  the renderer is only trustworthy at the width of a real record.

## ADR-043 — `commands.jsonl` re-emits each receipt verbatim rather than summarising it

- **Decision:** One line per gate the run started, holding the receipt object
  exactly as the engine filed it — no re-ordered keys, no shortened stderr, no
  "exit code summary" column.
- **Reason:** A receipt is already the bounded, centrally redacted account of a
  process, and it carries a digest over the unredacted bytes
  (`digestsUnredactedOutput`). Re-encoding it in the pack would put a second
  version of the same fact on disk and give the two a way to disagree — and a
  reader who finds the disagreement cannot tell which one the harness trusted.
- **Alternatives:** a per-gate summary with truncated output (the truncation
  rule becomes a renderer decision that the receipt's own bound already made);
  no command list at all in the pack, only in the record (the reviewer then has
  to read the record's whole JSON to find what ran); re-running commands to
  capture fresh output (Stage 8 runs nothing — ADR-035 makes execution a
  consented capability, not a side effect of formatting).
- **Consequence:** A pack for a run with many gates is a long JSONL file, and
  that is the correct shape: line count equals commands started, so a reader can
  count them. The hero test parses the file back and asserts all three receipts,
  which fails if the renderer ever starts paraphrasing.

## ADR-044 — A caveat is printed under the name of the document that wrote it

- **Decision:** `report.md` groups the qualifier notes as *From the evidence
  mapper, about the rows above*, *Recorded by the stages of this run, oldest
  first*, and *Recorded with the Acceptance Contract*, and `report.json` keeps
  `stageLimitations` and `contractLimitations` as separate keys. A criterion's
  own `limitations` are filed under the mapper once evidence exists and under
  the contract before it, because those are the documents that actually wrote
  them.
- **Reason:** `record.limitations` is append-only — each stage carries the
  previous record's lines forward and adds its own — so by the verify stage the
  list still contains "Nothing here is verified. No criterion changed status.",
  which was true of the contract stage and false of the run. Printed as one flat
  list, that line sat under three `VERIFIED` rows and read as the run's own
  conclusion. This was found by the hero integration test, not by a fixture: a
  hand-built record never carries a stage's caveats forward.
- **Alternatives:** deleting a caveat a later stage answered (the renderer would
  be judging which lines survive, which ADR-042 forbids); annotating each line
  with the stage that wrote it (accurate, but `verify` reuses the source run id,
  so the attribution would point at the same run that is reading it); leaving it
  flat and trusting the prose above the table (the ordering of the table is what
  a skimming reader follows).
- **Consequence:** A carried caveat stays on the page for as long as the record
  holds it, which is the honest outcome — a reviewer can check it against the
  document named in the heading. Groups drop out when empty, so a clean run's
  pack has no qualifications section.

## ADR-045 — `report`'s exit code is the recorded outcome's, not the write's

- **Decision:** `mergesutra report` returns `exitForOutcome(record.outcome)` —
  `0` for a passed or contract-derived run, `1` for `VERIFICATION_FAIL`, `3` for
  inconclusive or cancelled, `4` for blocked — after the pack has been written.
  A refusal to read a record surfaces as the usual error path and writes no pack.
- **Reason:** The command succeeded as a file operation on a blocked run, and a
  script that treats exit `0` as "safe to hand to a maintainer" would then be
  reading a report of a run that was stopped. The exit code is the only thing a
  pipeline consumes, so it has to carry the run's verdict rather than the
  renderer's mood.
- **Alternatives:** `0` whenever the pack is written (a success signal for a
  tool that reports on other tools' failures); an exit code per file written
  (measures the wrong thing more precisely); exiting `2` for a blocked run
  (collides with "planned, not implemented", which is a different statement).
- **Consequence:** `report` is usable as a gate in CI and, like every other
  status-bearing command here, its number can be read without opening the pack —
  while §9's rule still holds that the exit code is primary and not sufficient,
  because the pack beside it says which gates carried it.

## ADR-046 — One pack per run, rewritten whole; no pack history

- **Decision:** Writing a pack replaces the three files in
  `.mergesutra/runs/<run-id>/`. There is no timestamped directory per rendering,
  and no manifest of which record produced the current pack — the run id in the
  directory name is the only binding, and the pack's `schemaVersion: 1` is a
  format marker rather than a revision counter.
- **Reason:** The alternative — keeping old renderings — invites a reviewer to
  open a pack that describes a superseded record and cannot tell. Replacing is
  the same choice ADR-040 makes about a contaminated workspace: an artifact that
  may be stale is worse than one that is simply regenerated, and a run is cheap
  to report again.
- **Alternatives:** a dated subdirectory per report (auditable, but the "latest"
  then depends on mtime, which is exactly the ambiguity the pack exists to
  remove); a manifest file with the source record's digest (the record is one
  directory up and unmodified, so it adds a file that can only drift); refusing
  to overwrite (a second honest run then reports nothing).
- **Consequence:** `mergesutra report` is not an archive. When Stage 12 wants
  pack history or a combined manifest, it has to decide how a pack names the
  record version it came from — the gap is recorded under Stage 8 in
  `docs/ROADMAP.md` rather than papered over by a directory full of undated
  files.

## ADR-047 — A record version is added, not replaced, and reading never rewrites

- **Decision:** Stage 9 bumps the run record to `schemaVersion: 7` by adding one
  nullable, defaulted field (`review`) beside the six stages' documents, and the
  reader becomes version-aware: `RUN_SCHEMA_VERSIONS_SUPPORTED` names the window
  (6 and 7), a record declaring 6 is validated against a v6-only shape, then
  transformed in memory to v7 with `review: null` and validated again. Anything
  outside the window is refused with the existing `Run record is not readable`
  error, and a numeric version that is simply unknown is named in the message.
  `store.load()` and `store.list()` never write; only a stage that legitimately
  saves persists, and what it persists is v7.
- **Reason:** Every earlier bump replaced the reader, because no record from a
  previous version was expected to be on disk when the new build ran. Stage 9 is
  the first bump where that assumption fails — records from Stage 8 exist, are
  gitignored rather than archived, and are the artifacts a human audits, so a
  literal-only parser would have made `mergesutra report <old-run>` and every
  future `review`/`resume` against them fail. The migration adds exactly one
  default and nothing else: a v6 record has no evidence of a review, so
  inventing `findings: []` would report "a reviewer looked and found nothing"
  about bytes nobody was shown, which is the same class of falsehood §5's
  truthful-status rules forbid. Keeping the v6 shape strict is what stops a
  hand-edited file from claiming to be a 6 while carrying a 7's `review`.
- **Alternatives:** loosening `schemaVersion` to `z.number()` (a record would
  then be parsed by a schema that has never heard of its fields, and the
  `.strict()` guard — the thing that catches a hand-edited file — would go with
  it); silently accepting a future version (a v8 record read as v7 would drop
  whatever v8 added, and drop it without saying so); rewriting v6 files to v7 on
  read, or a `migrate` command (the file a human already audited would no longer
  be the file the run wrote, and a migration that happens as a side effect of
  opening something is not a migration anyone asked for); storing each stage's
  documents in separate files (a real fix for the general problem, and Stage 12
  territory — it changes what a reviewer opens, so it is not a compatibility
  decision dressed up as one).
- **Consequence:** A dropped field is now a *possible* outcome of reading, so the
  ceiling on supported versions has to stay honest: adding a version to
  `RUN_SCHEMA_VERSIONS_SUPPORTED` requires a schema beside it and a transform
  with a test, and removing one is a compatibility break to record here rather
  than a silent edit. v6 records remain v6 on disk, so a pack rendered from a
  migrated record carries the fields the run actually wrote — and when Stage 10
  wants pack history, ADR-046's recorded gap still stands.
