# Architecture Decision Records

Each record: **decision → reason → alternatives → consequence**. These are
actual decisions taken while building Stage 0, not aspirations.

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
