# Competitive Analysis

> Honest positioning. Adjacent public tools exist. We do **not** copy their
> source, branding, documentation wording or implementation. Differences below
> are design positions; per our own rule we only claim what is actually
> implemented (see statuses).

## What is *not* individually novel

These are necessary but not differentiating on their own: using an AI agent,
reading GitHub issues, using a git worktree, running tests, creating a PR,
generating a report, or "using BharatCode". Any submission that stops there is
a commodity.

## Adjacent categories

### IssueForge-style IssueOps supervisors

Local-first supervisors that take GitHub issues, create worktrees, drive an
existing coding agent, and attempt fixes / draft PRs.

**MergeSutra's intended difference:** the **Acceptance Contract** with
criterion-to-evidence traceability, the repository-policy compiler, and
evidence-first PR output — not just "run an agent in a worktree and open a PR".
Also: a direct interactive local CLI workflow with no mandatory self-hosted
runner for the core local path.

- **Status:** the repository-policy compiler (Stage 2), the Acceptance Contract
  with its criteria and verification plans (Stage 3), a planner that must
  account for every criterion without being able to mark one proven (Stage 4),
  a bounded implementation loop that changes files only inside its own worktree
  and only through actions a deterministic policy allowed (Stage 6), a
  verification engine that runs a repository's own gates only when an operator
  names them and then attaches their receipts to the criteria they prove
  (Stage 7), a report that puts those facts in front of a human without
  re-deciding one of them (Stage 8), and a critique-only second reader that
  describes the pinned patch, cites or is refused, and freezes the scope of a
  repair before any edit (Stage 9) are **shipped** — what is still
  **[DESIGNED]** is executing a frozen repair plan, the human-approval gate and
  the evidence-first PR output that reads this record.

### PatchProof-style verifiers

Projects that focus on deterministic verification, regression-test evidence,
repair gates, patch reports, or auditable validation of a patch.

**MergeSutra's intended difference:** we own the **whole** issue → contract →
implementation → verification → PR workflow, not only validation of an
already-created patch. Verification is one layer inside a larger evidence
harness.

- **Status:** the verification engine is **[SHIPPED]** (Stage 7). It discovers
  gates from CI steps and declared scripts with file-and-line provenance, runs
  none of them until an operator names the id, takes the exit code as the whole
  verdict, re-describes the patch after every gate so a gate that edited the
  workspace voids its own run, and marks a criterion's evidence `STALE` when the
  workspace moves off the patch the receipts describe. What it deliberately does
  not do: orchestrate a base run (the regression comparison takes two receipts a
  caller already holds, and refuses a pair that is not one), scan for secrets as
  a gate, or declare anything contribution-ready. Stages 4 and 6 spend real
  BharatCode calls through the adapter, and no model output has ever produced a
  `PASS` — the only writer of a criterion's status reads receipts.

### MergeMitra-style PR reviewers

AI-assisted review of an already-created pull request.

**MergeSutra's difference:** review is a *critique-only* stage inside our
workflow that cannot silently edit code; it is not the product's entry point.
Shipped, and shaped so a review cannot be over-read: the reviewer is given no
tools and a JSON shape with no status, score or verdict field, its findings are
weighed against a citation list MergeSutra authored before asking, and the
disposition — repair candidate, duplicate, unsupported, or for a human — is never
the model's to assign. A review that files nothing is recorded as the absence of
findings, not as a clean bill, and the workspace it reviewed is byte-identical
when it returns.

### General coding agents (Claude Code, Codex-style, OpenCode, Cursor-like)

Can read repos, edit files, run tests and sometimes open PRs.

**MergeSutra's difference:** those are general agents. MergeSutra is a
specialized contribution harness with deterministic gates and a durable
Acceptance Contract, powered by BharatCode. We are explicitly **not** a clone,
fork, or "better version" of the official BharatCode CLI; we sit above the
model/runtime layer.

## Why these answers are defensible

The claim "we use an AI agent" invites "why not just use a coding agent?". The
MergeSutra answer is structural: **we own the contribution workflow and the
evidence trail.** A reviewer sees, per requirement, exactly what changed, what
ran, what passed, what failed or could not be checked, and the evidence linking
each requirement to the change.

## Competitive advantages we must deliver (tracked, not asserted)

| Advantage                                      | Status                                                   |
| ---------------------------------------------- | -------------------------------------------------------- |
| BharatCode-native intelligence                 | Implemented (S4 plans, S6 drives the loop)               |
| Direct interactive local CLI workflow          | Partial — eight working commands, `run` still exits `2`   |
| Acceptance Contract                            | Implemented (S3); every criterion carries its own status  |
| Criterion-to-evidence traceability             | Implemented (S7 mapping, S8 pack)                         |
| Repository-policy compilation                  | Implemented (S2)                                         |
| Bounded, policy-gated implementation loop      | Implemented (S6); writes in its own worktree, verifies nothing |
| Evidence-first PR output                       | Designed (S10)                                           |
| No mandatory self-hosted runner for local core | Implemented (S5 worktree, exercised by S6)               |
| Honest benchmark incl. published failures      | Planned (S14)                                            |

"Implemented" here means the code exists and is green offline, not that the
advantage is complete: the Acceptance Contract cannot yet be satisfied by any
run, because nothing has verified a criterion, and the loop's output is an
unverified workspace rather than a pull request.

Do not attack competitors. State factual, implemented differences only. Respect
licenses and attribution.
