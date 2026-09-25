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
  and a bounded implementation loop that changes files only inside its own
  worktree and only through actions a deterministic policy allowed (Stage 6) are
  **shipped** — what is still **[DESIGNED]** is the other half of the chain:
  attaching executed evidence to those criteria (Stage 7/8) and the
  evidence-first PR output.

### PatchProof-style verifiers

Projects that focus on deterministic verification, regression-test evidence,
repair gates, patch reports, or auditable validation of a patch.

**MergeSutra's intended difference:** we own the **whole** issue → contract →
implementation → verification → PR workflow, not only validation of an
already-created patch. Verification is one layer inside a larger evidence
harness.

- **Status:** verification engine **[DESIGNED]** (Stage 7). The BharatCode
  adapter and redaction are implemented and Stages 4 and 6 both use them for
  real, and Stage 6 executes developer commands the policy allowed — but not one
  gate from a repository contract has been run, so every criterion is still
  `PENDING` and MergeSutra has no verification claims to make.

### MergeMitra-style PR reviewers

AI-assisted review of an already-created pull request.

**MergeSutra's difference:** review is a *critique-only* stage inside our
workflow that cannot silently edit code; it is not the product's entry point.

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
| Direct interactive local CLI workflow          | Partial — six working commands, `run` still exits `2`    |
| Acceptance Contract                            | Implemented (S3); no criterion has evidence yet          |
| Criterion-to-evidence traceability             | Designed (S8)                                            |
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
