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
  → Acceptance Contract evidence mapping
  → Human approval
  → Pull-request draft
```

The hero command is `mergesutra issue <github-url>`. Phase commands
(`inspect`, `contract`, `plan`, `run`, `verify`, `review`, `report`, `pr`,
`status`, `resume`) exist for transparency, debugging and recovery — not to
expand scope.

## 4. Core promise

**MergeSutra does not merely claim an AI fixed an issue. It shows the evidence.**

Evidence is always truthful:

- "Tests passed" appears only if tests actually ran and returned success.
- "Build passed" only if a build ran.
- Model confidence is never converted into factual verification.

Explicit verification states: `PASS`, `FAIL`, `SKIPPED`, `NOT_AVAILABLE`,
`BLOCKED`, `INCONCLUSIVE`. A run may reach `CONTRIBUTION_READY` only when the
defined mandatory gates pass. Other run states: `PLAN_READY`, `PATCH_CREATED`,
`VERIFICATION_FAILED`, `NEEDS_HUMAN_REVIEW`, `BLOCKED`, `INCONCLUSIVE`.

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
  DESTRUCTIVE); remote mutations require explicit human approval; destructive
  operations are normally forbidden.
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

## 10. Limitations (current, at Stage 4)

- Implemented today: CLI skeleton, BharatCode adapter, config, redaction,
  structured errors, `doctor`, **intake** (`mergesutra issue <url>` — parses the
  URL, reads the issue and repository through `gh`, pins an exact base commit
  with provenance, verifies a supplied `--repo` clone is the same repository,
  and writes a versioned run record), **repository policy discovery**
  (`mergesutra inspect <repo>` — reads CI, manifests and contributor docs
  read-only and compiles the gates the repository itself demands, each with a
  file-and-line citation), **Acceptance Contract derivation**
  (`mergesutra contract [run-id]` — joins an issue run and a repository contract
  into versioned criteria that cannot record a `PASS` without evidence), and
  **implementation planning** against BharatCode (`mergesutra plan [run-id]` —
  one schema-validated, coverage-checked plan whose every command is a proposal
  and which holds no process runner).
- Everything after Stage 4 — worktree isolation, the implementation loop, the
  verification engine, review, evidence pack, PR drafting and resumability
  (`status` / `resume`) — is **[DESIGNED]** / **[PLANNED]**, not yet functional.
  Planned commands exit `2` rather than imitating success. Every derived
  criterion is still `PENDING` after a plan is written, and the CLI says so on
  screen.
- Stages 1–3 make no model call, so a run works with no API key present. Stage
  4 does: without `BHARATCODE_API_KEY` it exits `78` and says why, and this
  build has not been pointed at a live BharatCode endpoint — the captured
  plan sample goes through the real adapter against a local stub, with
  `BHARATCODE_API_BASE` overridden for the test.
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
