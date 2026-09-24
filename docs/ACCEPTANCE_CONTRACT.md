# The Acceptance Contract

> Status: **[DESIGNED]**. This defines the schema and rules that Stage 3
> implements. The core principle is already an architectural commitment:
> **every final `PASS` must point to evidence.**

## Why it exists

A normal coding agent receives an issue and produces code. MergeSutra first
converts the issue and the repository's own policy into a structured, versioned
contract of acceptance criteria. The contract survives the entire workflow and
never degrades into vague prose after implementation, so the final PR can show,
per requirement:

```
Requirement → Change → Verification → Evidence
```

## Example

Issue: *"Parser accepts invalid empty dates. Reject empty input without
changing valid ISO date behavior."*

```
AC-1  Empty date input must be rejected.
      source: GitHub issue body        verification: targeted regression test
      status: PENDING

AC-2  Existing valid ISO dates must remain accepted.
      source: issue / inferred compat   verification: existing date parser suite
      status: PENDING

AC-3  Error behavior must conform to repository conventions.
      source: CONTRIBUTING.md + nearby code
      verification: static review + tests
      status: PENDING
```

## Schema (Zod-expressible)

```ts
AcceptanceContract {
  version: number
  issue: IssueRef
  repository: RepositoryRef
  baseSha: string
  criteria: AcceptanceCriterion[]
  revisions: ContractRevision[]   // recorded with a reason
}

AcceptanceCriterion {
  id: string                 // stable, e.g. "AC-1"
  statement: string
  source: string             // where the requirement came from
  sourceType: 'issue' | 'repository_policy' | 'inferred' | 'human'
  requirementType: 'functional' | 'compatibility' | 'convention' | 'safety' | 'scope'
  verificationPlan: VerificationStep[]
  implementationEvidence: Evidence[]
  validationEvidence: Evidence[]
  status: CriterionStatus
  limitations: string[]
}

VerificationStep {
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'static_review' | 'manual'
  command?: string           // argv form, never a shell string
  source: CheckSource        // REPOSITORY_REQUIRED | MERGESUTRA_ADDITIONAL | OPTIONAL
}

Evidence {
  type: 'test_result' | 'command_receipt' | 'diff_hunk' | 'file' | 'review' | 'artifact'
  provenance: string         // where it came from
  command?: string
  exitCode?: number
  file?: string
  lineRange?: [number, number]
  testName?: string
  artifact?: string
  timestamp?: string
  hash?: string
}

CheckSource = 'REPOSITORY_REQUIRED' | 'MERGESUTRA_ADDITIONAL' | 'OPTIONAL'

CriterionStatus =
  'PENDING' | 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_AVAILABLE' | 'BLOCKED' | 'INCONCLUSIVE'
```

## Hard rules

1. **Truthful states.** `PASS` only when the referenced evidence actually shows
   a real, executed success. `NOT_AVAILABLE` / `BLOCKED` / `INCONCLUSIVE` when a
   check could not run or could not decide. Never convert model confidence into
   verification.
2. **Deterministic evidence outranks model claims.** Distinguish `MODEL CLAIM`
   from `DETERMINISTIC EVIDENCE`; when they conflict, evidence wins.
3. **The contract is immutable-by-default.** The implementation stage must not
   rewrite criteria merely to make its solution look successful. If the issue
   understanding genuinely changes, record a `ContractRevision` **with a
   reason** — do not silently mutate history.
4. **Provenance is mandatory for checks.** Never invent a check and call it
   repository-required; record where each command came from (e.g. `pnpm test` ←
   `package.json scripts.test`).
5. **Unverifiable criteria demand human review.** If a criterion cannot be
   verified automatically, say so clearly and require human review.

## Advanced evidence: regression before/after **[DESIGNED]**

For bug fixes, where safe and applicable, MergeSutra can run a newly introduced
regression test against both the base state and the patched state to produce
stronger evidence than "tests pass on patched code". Limitations are stated
explicitly; this is independent work, not another project's methodology, and it
never claims universal proof.

## Run-level statuses

`CONTRIBUTION_READY` is reachable only when all mandatory gates pass. Others:
`PLAN_READY`, `PATCH_CREATED`, `VERIFICATION_FAILED`, `NEEDS_HUMAN_REVIEW`,
`BLOCKED`, `INCONCLUSIVE`.
