# MergeSutra — Product Specification

> Status legend used throughout: **[IMPLEMENTED]** exists and is tested today.
> **[DESIGNED]** specified but not yet built. **[PLANNED]** intended later.

## 1. Problem

Modern coding agents can already read a repository, edit files, run tests and
sometimes open a pull request. That is no longer the bottleneck. The bottleneck
for real contribution work is **trust**: a maintainer receives an
AI-authored patch and cannot tell whether it actually satisfies what the issue
asked for, whether it broke anything else, or what was even checked. "The AI
says it fixed it" is not a reviewable artifact.

MergeSutra makes the **evidence** the product. It converts a GitHub issue and
the target repository's own policies into a structured, versioned contract,
implements against that contract in an isolated workspace, verifies with the
repository's native checks, and publishes a PR draft where **every acceptance
criterion points to concrete evidence of what ran and what passed or failed**.

## 2. Audience

- Open-source maintainers and contributors who need reviewable, honest patches.
- Students and new contributors who need a guided, safe path from issue to PR.
- Engineers evaluating whether AI can be trusted with contribution workflows.
- The BharatCode ecosystem, which needs a specialized, evidence-first workflow
  on top of its runtime.

## 3. The one workflow

```
GitHub Issue
  → Repository acquisition / local repository
  → Repository policy discovery
  → Issue understanding
  → Acceptance Contract
  → Implementation plan
  → Safe isolated worktree
  → BharatCode-powered implementation
  → Repository-native verification
  → Diff review
  → Digest-approved repair, then verification over the bytes it changed
  → Acceptance Contract evidence mapping
  → Human approval of one page, by digest
  → Pull-request draft (written and filed; not published)

↺ at any point: `status` reads what is true now, and `resume` re-enters the chain at
  the first stage whose facts expired — never by rolling the workspace back
```

The hero command is `mergesutra issue <github-url>`. Phase commands
(`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`, `pr`,
`status`, `resume`) exist for transparency, debugging and recovery — not to
expand scope. What ships today is `inspect`, `contract`, `plan`, `implement`,
`verify`, `review`, `report`, `repair`, `pr`, `status` and `resume`, alongside
`issue` and `doctor`.
`pr` is Stage 10's, and it reaches as far as this build goes: it drafts the page,
takes a human's digest-bound yes and files both — and no command here publishes
anything. `status` and `resume` are Stage 11's, and they are the two halves of
recovery: `status` describes a run and the bytes beside it, changes nothing, and
exits `0` for a blocked lifecycle because describing a blocked lifecycle is what it
was asked to do (ADR-056); `resume` shows the one action the current facts justify,
with its costs, and performs it only when a person types `--execute` — and it holds
no execution consent, no repair approval, no publication approval, no remote
permission and no credential of its own, so the honest end of a resumed chain is the
same human boundary the direct commands stop at. `mergesutra run` is designed and
still exits `2`, and `resume` is deliberately not a path to it.

## 4. Core promise

**MergeSutra does not merely claim an AI fixed an issue. It shows the evidence.**

Evidence is always truthful:

- "Tests passed" appears only if tests actually ran and returned success.
- "Build passed" only if a build ran.
- Model confidence is never converted into factual verification.

Explicit verification states: `PASS`, `FAIL`, `SKIPPED`, `NOT_AVAILABLE`,
`BLOCKED`, `INCONCLUSIVE`. A run may reach `CONTRIBUTION_READY` only when the
defined mandatory gates pass — and in this build no command reaches it at all, the
field being a literal `false` in the evidence schema (§10). Other run states:
`PLAN_READY`, `PATCH_CREATED`, `VERIFICATION_FAILED`, `NEEDS_HUMAN_REVIEW`,
`BLOCKED`, `INCONCLUSIVE`. Stage 10's most hopeful word is a different kind of claim
from all of them: `HUMAN_APPROVED_FOR_PR` records that a person read one page and
approved its digest, which says nothing about whether the code is good and nothing
about whether anybody published it.

One deviation, on purpose: the state after Stage 4 is named `PLAN_COMPLETE`, not
`PLAN_READY`. Nothing in Stage 4 establishes that a plan is *ready* to execute —
no command was run, no patch was attempted, and the plan is untrusted model
output. `COMPLETE` says exactly what happened.

## 5. Non-goals (deliberate)

MergeSutra is **not**:

- a replacement, clone, or "better version" of the official BharatCode CLI;
- a general-purpose AI coding terminal, chatbot, or shell agent;
- an IDE, desktop app, web frontend, or generic file editor;
- a thin API wrapper;
- a fake demo hard-coded to a single task.

BharatCode is the intelligence; MergeSutra is the opinionated workflow, safety,
verification and evidence harness that sits **above** the model/runtime layer.

For every feature we ask: *does this make "issue → evidence-backed PR"
materially better?* If not, it is rejected as scope creep unless it is
necessary infrastructure.

## 6. The differentiator: the Acceptance Contract

Derivation is **[IMPLEMENTED]** (Stage 3) and planning against it is
**[IMPLEMENTED]** (Stage 4); the rest of the lifecycle — evidence from real
runs, revisions during implementation, and the final traceability row per
criterion — is **[DESIGNED]**.

A normal agent receives an issue and generates code. MergeSutra first converts
the issue and repository policy into a structured, versioned contract of stable
criteria. Each criterion carries: id, statement, source and source type,
requirement classification, verification plan, evidence, status, and unresolved
uncertainty. Today every criterion ships as `PENDING` with no evidence, because
nothing has run yet — the schema makes a `PASS` without evidence unconstructible
rather than merely discouraged.

The contract survives the whole workflow and never degrades into vague prose
after implementation. The final PR shows, per requirement:

```
Requirement → Change → Verification → Evidence
```

Full schema and rules: [ACCEPTANCE_CONTRACT.md](ACCEPTANCE_CONTRACT.md).

The contract is also what makes the model safe to consult. `mergesutra plan`
**(Stage 4, [IMPLEMENTED])** sends the contract's criterion ids as a closed
list and refuses an answer that drops one, invents one, or arrives in a shape
the schema does not allow; the plan it stores is typed separately from the
contract, carries no status field, and is marked `untrusted` by the schema
rather than by the caller. A model can propose a requirement all it likes —
that proposal stays inside the plan until a human states it with
`mergesutra contract --criterion … --by …`.

## 7. Repository policy compiler

**[IMPLEMENTED]** (Stage 2) for the read-only discovery path: CI workflows,
package manifests, and contribution instructions are parsed as data and compiled
into a **repository contract** (runtime, package manager, required checks,
contribution requirements, protected areas), with each required gate citing the
file and line that reached it. Broader ecosystem coverage is **[PLANNED]**. It
does not blindly
concatenate files into a prompt. Repository text is treated as possible prompt
injection and cannot override MergeSutra's security policy.

## 8. Safety model (summary)

- Never casually edit the user's primary checkout; prefer a dedicated Git
  worktree tied to the exact base SHA.
- Classify tools by risk (READ / WRITE / EXECUTE / NETWORK / REMOTE MUTATION /
  DESTRUCTIVE), deriving the class from the argv rather than from what the
  caller says it is; remote mutations require explicit human approval of that
  exact action; destructive operations are refused with no approval path.
- An approval is not a capability. Stage 10's yes is one digest typed for one page,
  and what it buys is a filing: the publication seam is a two-method interface whose
  only implementation in this build refuses both calls, and which no production
  module imports at all, so no human's approval in this build can
  reach a repository that is not theirs.
- Recovery is not a rollback, and a resumed action is not a second consent. A run
  whose bytes disagree with its record is described that way and re-measured one
  stage at a time; `reset`, `revert`, `clean`, `checkout -- .` and auto-stash appear
  nowhere on a recovery path, and a source-shape test fails the build if one is
  added — because the edit an interrupted cycle left behind is often the only
  artifact it produced (ADR-057).
- A lock is an exclusion, never a permission. One lifecycle mutation per run is
  proved with `mkdir`, and holding one buys the right to be the only writer and
  nothing else — not execution consent, not an approval, not a remote (ADR-058).
- Commands run as argv arrays (no `shell: true`) with timeouts and bounded,
  redacted output.
- Filesystem writes are proven to resolve inside the authorized workspace.
- Central secret redaction everywhere.

Full model: [SECURITY_MODEL.md](SECURITY_MODEL.md).

## 9. Success criteria

MergeSutra succeeds when a reviewer can open the PR draft and, without reading
any model transcript, see for each acceptance criterion exactly what changed,
what was run, what passed, what failed or could not be checked — and decide
whether to publish. Honest reporting of failures is a success condition, not a
defect.

## 10. Limitations (current, at Stage 11)

- Implemented today: CLI skeleton, BharatCode adapter, config, redaction,
  structured errors, `doctor`, **intake** (`mergesutra issue <url>` — parses the
  URL, reads the issue and repository through `gh`, pins an exact base commit
  with provenance, verifies a supplied `--repo` clone is the same repository,
  and writes a versioned run record), **repository policy discovery**
  (`mergesutra inspect <repo>` — reads CI, manifests and contributor docs
  read-only and compiles the gates the repository itself demands, each with a
  file-and-line citation, and carries forward the issue from an intake run only
  when that run provably describes this clone's repository at the commit being
  inspected), **Acceptance Contract derivation**
  (`mergesutra contract [run-id]` — joins an issue run and a repository contract
  into versioned criteria that cannot record a `PASS` without evidence),
  **implementation planning** against BharatCode (`mergesutra plan [run-id]` —
  one schema-validated, coverage-checked plan whose every command is a proposal
  and which holds no process runner), and the **bounded implementation loop**
  (`mergesutra implement [run-id]` — BharatCode proposes one action per turn from
  a closed list of eight; MergeSutra validates it, decides whether it is allowed,
  and executes the allowed ones in a Git worktree at the run's base commit), and
  the **deterministic verification engine** (`mergesutra verify [run-id]` — the
  repository's own gates, discovered with file-and-line provenance, run only under
  a per-gate `--allow` an operator gives, judged by their exit codes and nothing
  else, and filed against the criteria whose stated command each one really ran),
  and the **evidence pack** (`mergesutra report [run-id]` — the run record read
  back and rendered as `report.md`, `report.json` and `commands.jsonl` beside it:
  statuses copied, receipts re-emitted as filed, caveats grouped by the document
  that wrote them, and an exit code taken from the recorded outcome rather than
  from the fact that printing succeeded), and the **independent diff review**
  (`mergesutra review [run-id]` — the patch Stage 7 measured is pinned, a second
  model with no tools describes it, MergeSutra weighs each finding against the
  citation list it authored before asking, and a repair plan is frozen before any
  edit; the workspace the stage reviewed comes back byte-identical), and the
  **digest-approved repair cycle** (`mergesutra repair [run-id]` — the only command
  that edits a repository, and it edits only under `--approve-plan <64-hex>`, the
  digest of the plan `review` froze: the cycle runs through Stage 6's own bounded
  loop under a brief narrowed to that plan's files, and once bytes have moved
  Stage 7's gates run again over them and Stage 8's pack is regenerated from the new
  receipts. Reading a plan costs nothing and changes nothing; running one needs a yes
  typed for that plan alone. No outcome in its vocabulary says a patch is good, and
  there is no exit `0`.), and the **publication boundary**
  (`mergesutra pr [run-id]` — the run's evidence is re-measured, assembled into one
  frozen `PublicationCandidate` and printed as the pull request page it drafts:
  title, body, both branch names and the eight facts the page rests on. A yes is
  `--approve <64-hex>`, the digest of exactly that document, and what it buys is a
  filing: `published` is `false`, there is no pull request URL to print, and every
  path through the command ends by saying so. There is no exit `0` here either. §3's
  "decide whether to publish" has, at last, a command a person can answer with; the
  limit of what that answer buys is stated below.
- Stage 11 shipped the **recovery pair** (`mergesutra status [run-id]` and
  `mergesutra resume [run-id]`). The first is an observation with no write path at all:
  a `StatusSnapshot` puts what the run recorded beside what the checkout shows now —
  HEAD, the live patch identity, and each lifecycle document graded against the bytes
  it was produced for — `CURRENT`, `STALE`, `UNMEASURABLE` when the current fact
  cannot be measured at all, or `ABSENT` when none was ever filed — and it exits `0`
  even
  when what it found is a dead workspace, because the number is about the command and
  the document is about the run. The second is a preview with one acting word: it names
  the single stage the current facts justify, prints that stage's costs (a model
  request, a credential, a workspace change, repository gates, an approval, a remote),
  re-reads the state immediately before it acts, and stops at any boundary it cannot
  cross on its own authority. Neither command holds, grants or implies a consent;
  `resume` reaching `pr`'s boundary and refusing there is the design working, not a gap.
- Stage 5 shipped the safety layer as **modules with no command**: the worktree
  manager (`src/git/workspace.ts`), the risk classifier
  (`src/process/tool-policy.ts`) and the confined writer
  (`src/security/writer.ts`). Stage 6 is the first consumer of all three, plus a
  confined reader for the read half of the same boundary. The rules in §8 are no
  longer only a policy document — every action the loop can take is routed
  through them, and there is no code path in `src/implement/` that reaches
  `fs.writeFile`, `fs.rm`, `fs.rename`, `exec`, `execSync` or a shell-mode spawn.
- Stage 9 shipped the **independent diff review** and its **routing** — a reviewer
  with no tools, findings weighed against a manifest MergeSutra authored, bounded
  dispositions, and a repair plan frozen before any edit. What it deliberately did
  **not** ship is the execution of that plan: no command of MergeSutra's starts the
  loop a frozen plan authorises, so `src/repair/scope.ts`'s planned-versus-actual
  comparison has no production caller and a reviewed run's `nextStage` names a
  `REPAIR` that does not exist yet. Building that is a later stage's decision, with
  its own consent, not a flag on `review`.
  *(That later stage is Stage 9R, and it is built: `mergesutra repair` starts
  Stage 6's loop under a brief narrowed to the plan's own files, so the scope
  comparison now has its production caller — a cycle that reached outside the plan is
  escalated to a human with the bytes left in place, never reverted — and a repaired
  run goes back through Stage 7's gates and Stage 8's pack writer. The last sentence
  holds: the yes that runs a plan is a separate digest-bound capability with its own
  flag and its own proof, not a field on `review` and not a `--yes`.)*
- A review is a **second pass, not a second vendor.** It runs through the same
  adapter, possibly on the same model family, so what Stage 9 buys is different
  instructions and no tools, not provider diversity — and the reviewer's world is
  the page it was shown: a defect inside a file the context withheld cannot be
  cited, so it can be filed as a fact about the patch but cannot route to a repair.
- Stage 10 shipped PR drafting and the human gate; it did not ship publication.
  `mergesutra pr` stops at a page, a digest and a recorded yes, and the seam on the
  other side of that — `src/pr/publisher.ts`, two methods — has one production
  value, which is a refusal. The reason is not a missing flag: MergeSutra has never
  made a commit, so the work a candidate describes is uncommitted bytes in a linked
  worktree, and pushing would mean committing an operator's tree on their behalf.
  Two consequences of binding a page to its evidence are stated rather than
  smoothed: running `mergesutra report` after an approval changes the pack identity,
  which changes the candidate, which makes that approval `STALE`; and the word a
  full pass produces is `HUMAN_APPROVED_FOR_PR`, printed beside a literal
  `published: false` — `CONTRIBUTION_READY` remains unreachable in every screen and
  every record this build writes.
- Recovery was split in two and shipped in that order, and both halves are now
  functional: reading it (`status`) and acting on it (`resume`) from Stage 11. What
  the split still buys is the limitation that matters — a resumed action is one stage,
  chosen by the facts, and no command here will keep going until a pull request
  exists. `mergesutra run` remains the only planned stub and exits `2` rather than
  imitating success. The
  pack `report` writes is three files rendered from one run record; the
  one-file-per-document bundle sketched in
  [ARCHITECTURE.md](ARCHITECTURE.md) §8 stays a sketch, because splitting the same
  facts across files gives each fact two places to be wrong — including the review,
  whose findings live in the record and are rendered from it rather than into a
  separate `review.json`. A repair cycle's document is held the same way, in the
  record's `repairExecutions` list, a publication's the same way again — the
  candidate and the approval beside it, in `record.publications` — and its pack is
  the same three files regenerated rather than a fourth kind of page.
- Every derived criterion is `PENDING` after `implement` finishes, and the
  CLI says so on screen: the loop ran no gate from the Acceptance Contract, and
  `Verification` is `NOT_AVAILABLE` in every implementation record. Attaching a
  status is `verify`'s job, and it is the only stage that can do it. A `report`
  built before `verify` renders that honestly — the row keeps `PENDING`, its
  Evidence column says `no verification has run`, and `report.json`'s
  `verification` is `null` — so the pack cannot be mistaken for a run that passed.
- What `implement` establishes is **permission, not merit**. It records what ran,
  what was refused and with which reason; whether the patch satisfies the issue
  is what `verify` asks, and even its answer is bounded: a gate `PASS` is one
  command's exit code, and a criterion `PASS` is that command plus the mapping
  this record publishes. `COMPLETED_BY_MODEL` means the model stopped asking —
  hence exit `3` rather than `0`, and no `CONTRIBUTION_READY` reachable from any
  command in this build: `contributionReady` is a literal `false` in the evidence
  schema, so there is no code path that sets it.
- Two Stage 6 gaps are written into each record rather than smoothed over: a
  `WRITE_FILE` carries a whole file, so a model that rewrites a file it never
  read clobbers it (the stored `sha256` and byte count make that visible, not
  impossible), and the workspace is isolation for clarity — **a Git worktree is
  not a sandbox**, so a command the policy allows can still do whatever the
  operating system allows.
- Stages 1–3 make no model call, so a run works with no API key present. Stages
  4 and 6 do: without `BHARATCODE_API_KEY` they exit `78` and say why. Stage 6
  checks the key **before** it creates a workspace, so a keyless machine gets a
  configuration refusal and zero git invocations instead of a worktree and an
  `INCONCLUSIVE` run. Stage 10 returns to the first group and stays there by
  construction: `pr` imports no client at all, so reading a page, approving one and
  filing the approval spend no request and need no key — which is what lets the
  stage's own tests, including the ones that attack it with fabricated approvals,
  run offline. This build has still not been pointed at a live BharatCode
  endpoint — no key exists on this machine — so the captured plan and implement
  samples both go through the real adapter against a local stub, with
  `BHARATCODE_API_BASE` overridden for the run. `tests/implement/live.test.ts`
  is the opt-in real-endpoint check, and it skips here rather than pretending.
- Stage 11 earns recovery, not durability. It makes a stopped run legible and
  continuable; it does not make one impossible to interrupt, and no sentence in this
  product claims crash-proofing, perfect recovery, or that work is never lost — the
  scenario its own hero walks through *is* a lost write, and the tool's contribution is
  to describe and continue it, not to undo it. Four structural gaps follow from that
  and are listed rather than smoothed: the lock is per-machine and per-run, and the
  `Run lock` row `status` prints is an observation that takes nothing, so a second
  service still finds out for certain by colliding; the observed-state digest is
  compared by the service but cannot be supplied from the
  command line, so cross-process agreement is for programmatic callers; a record shows
  one loop entry's spend, so a resumed stage's budget is measured against the entry
  before it rather than a lifetime total; and `resume` still cannot get a run past a
  boundary that needs a human, which is the point.
- A plan is validated for **shape and coverage**, not merit. Nothing in Stage 4
  decides whether the proposed files are the right ones or the proposed commands
  will pass; that is what the next stages exist for.
- `provenance.source` records that an answer came through the BharatCode
  adapter; the endpoint that served it is not stored in the run record.
- GitHub access goes through the `gh` CLI only; `gh` must be installed and
  signed in, and a run with an unreachable issue reports `BLOCKED` (exit `4`).
- Initial high-quality verification targets Node.js/TypeScript/JavaScript with
  graceful generic fallback; other ecosystems are **[PLANNED]** and must not be
  claimed until tested.
- Public repositories are the initial scope; private-repo support is not yet
  advertised.

## 11. Hackathon fit

- **Track:** CLI Agent — "a terminal agent for one workflow, powered by
  BharatCode." This is exactly one workflow, specialized, in a terminal.
- **Theme:** "Build the tools India will code with." Relevance comes from
  BharatCode as the runtime, an accessible low-infrastructure CLI, real Windows
  support, usefulness to students and new contributors, and public open source —
  not from decorative imagery.
