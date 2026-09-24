# Architecture Decision Records

Each record: **decision → reason → alternatives → consequence**. These are
actual decisions taken while building Stages 0-5, not aspirations.

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
  structural: Stage 6 will be the first real caller, so the API is small and gets
  shaped by its consumer rather than by a command that had to look useful.
