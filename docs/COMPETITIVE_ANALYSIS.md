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
  with its criteria and verification plans (Stage 3), and a planner that must
  account for every criterion without being able to mark one proven (Stage 4)
  are **shipped** — what is still **[DESIGNED]** is the other half of the
  chain: attaching executed evidence to those criteria (Stage 7/8) and the
  evidence-first PR output.

### PatchProof-style verifiers

Projects that focus on deterministic verification, regression-test evidence,
repair gates, patch reports, or auditable validation of a patch.

**MergeSutra's intended difference:** we own the **whole** issue → contract →
implementation → verification → PR workflow, not only validation of an
already-created patch. Verification is one layer inside a larger evidence
harness.

- **Status:** verification engine **[DESIGNED]** (Stage 7). The BharatCode
  adapter and redaction are implemented and Stage 4 uses both for real, but
  MergeSutra has not yet run a single gate, so it has no verification claims to
  make.

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

| Advantage                                      | Status        |
| ---------------------------------------------- | ------------- |
| BharatCode-native intelligence                 | Implemented   |
| Direct interactive local CLI workflow          | Partial       |
| Acceptance Contract                            | Designed (S3) |
| Criterion-to-evidence traceability             | Designed (S8) |
| Repository-policy compilation                  | Designed (S2) |
| Evidence-first PR output                       | Designed (S10)|
| No mandatory self-hosted runner for local core | Designed (S5) |
| Honest benchmark incl. published failures      | Planned (S14) |

Do not attack competitors. State factual, implemented differences only. Respect
licenses and attribution.
