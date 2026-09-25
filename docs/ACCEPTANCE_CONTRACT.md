# The Acceptance Contract

> Status: **[STAGE 3 SHIPPED]** for the schema, the criteria derivation and
> `mergesutra contract`. **[STAGE 4 SHIPPED]** for planning against the
> contract — a plan reads the criterion ids and cannot write them.
> **[STAGE 6 SHIPPED]** for the first stage that changes files under the
> contract's authority — it may propose a revision and cannot apply one, and its
> record carries `contractUntouched: true`. Evidence is still **[DESIGNED]**:
> nothing attaches a `PASS` before Stage 7 runs a gate, and no Stage 6 action has
> a field that could hold one. The core principle is implemented, not
> aspirational: **a `PASS` without evidence cannot be constructed**, and a model
> cannot be the one to add a requirement.

## Why it exists

A normal coding agent receives an issue and produces code. MergeSutra first
converts the issue and the repository's own policy into a structured, versioned
contract of acceptance criteria. The contract survives the entire workflow and
never degrades into vague prose after implementation, so the final PR can show,
per requirement:

```
Requirement → Change → Verification → Evidence
```

## Two contracts, deliberately different

|                     | Repository contract                     | Acceptance Contract                |
| ------------------- | --------------------------------------- | ---------------------------------- |
| Answers             | "What does this repository demand of any change?" | "What must this patch prove to close this issue?" |
| Built from          | Manifests, CI steps, `CODEOWNERS`, docs — files only | Issue text + the repository contract |
| Implemented         | **Stage 2 — `mergesutra inspect`**, shipped | **Stage 3 — `mergesutra contract`**, shipped (evidence attaches at Stage 7; Stage 4's planner and Stage 6's loop both read this contract and neither can write it) |
| Identifiers         | Five fixed gate kinds: `format`, `lint`, `typecheck`, `test`, `build` | Stable `AC-n` criterion ids, versioned with revisions |
| May it add a rule?  | Never — `MERGESUTRA_ADDITIONAL` is reserved for gates MergeSutra runs for its own benefit, and `inspect` emits none | Only from issue evidence with a citation, or from a named human — never from a model |

The repository contract is an *input* to the Acceptance Contract, not a copy of
it. Stage 2 records each gate's status as `REPOSITORY_REQUIRED` /
`DECLARED_ONLY` / `NOT_DECLARED` with the file and line that produced it; Stage
3 turns the issue's demands into criteria and binds each criterion to the
verification that will satisfy it, inheriting the repository's required gates as
baseline criteria. Neither stage may weaken the other: an implementation cannot
rewrite the contract to make a failing run look complete.

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

AC-2 and AC-3 are **not** what Stage 3 emits. `mergesutra contract` copies an
acceptance list verbatim and inherits CI-enforced gates; a criterion no file
states can only enter the contract through a human who names themselves
(`--criterion "…" --by "name"`). What the stage really prints for this issue
is in the README's sample output: one criterion per acceptance-list item, plus
one per `REPOSITORY_REQUIRED` gate, each citing its file and line, all
`PENDING`.

Stage 4 sits on the other side of that line. `mergesutra plan` is handed
exactly these ids and must account for every one; if the model thinks a
requirement is missing, it may record a `proposedCriteria` entry, which the plan
labels `MODEL CLAIM` and keeps inside the plan. There is no path from a model's
proposal to this contract that does not pass through a human typing
`--criterion`.

Stage 6 is the first stage with a reason to want that path, because it is the
first stage whose work can fail a criterion. It gets none. `mergesutra implement`
starts from the contract's version and id, hands the model the criterion list as
read-only context, and its `PROPOSE_CONTRACT_REVISION` action appends to a
`proposedRevisions` array whose schema types `applied` as the literal `false` —
so the loop cannot record a revision it accepted. The implementation record
carries `contractUntouched: true` as a structural fact, and the renderer prints a
`FINISH` that names criteria as "MODEL CLAIM, unverified". Weakening a criterion
is not a thing this stage can be asked to do, let alone do on its own.

## Schema as implemented

`src/contract/schema.ts`. Discriminated unions carry the rules, so the
dishonest shapes do not type rather than merely failing a review comment.

```ts
AcceptanceContract {                     // .strict(): an undeclared field throws
  schemaVersion: 1
  version: number                        // bumped only by a recorded revision
  runId: string
  issueUrl: string | null
  repository: { fullName, baseSha, localPath }  // pinned by intake, nullable
  criteria: AcceptanceCriterion[]        // min 1 — an empty contract is refused
  revisions: ContractRevision[]          // recorded with a reason
  limitations: string[]                  // what this contract did not establish
  untrusted: true
}

AcceptanceCriterion {                    // discriminated on `status`
  id: string                             // "AC-1", assigned in derivation order
  statement: string
  source:                                // where the requirement came from
    | { kind: 'issue', detail }
    | { kind: 'repository_policy', file, line }
    | { kind: 'inferred', reason }       // legal in the schema; nothing emits it
    | { kind: 'human', by }              // `contract --criterion … --by …`
  requirementType: 'functional' | 'compatibility' | 'convention' | 'safety' | 'scope'
  verificationPlan: VerificationStep[]
  status: CriterionStatus
  evidence: Evidence[]                   // PASS ⇒ min 1; PENDING ⇒ length 0
  limitations: string[]
}

VerificationStep =                       // discriminated on `kind`
  | { kind: 'test'|'lint'|'format'|'typecheck'|'build'|'secret_scan',
      command, source, from }            // argv form, never a shell string
  | { kind: 'static_review'|'manual', source, from }   // cannot carry a command

Evidence =                               // discriminated on `executed`
  | { executed: false, reason, provenance }
  | { executed: true, command, provenance,
      result: { status: 'PASS'|'FAIL', exitCode, outputRef, durationMs }
            | { status: 'BLOCKED'|'INCONCLUSIVE', reason } }

ContractRevision { version, reason, affectedCriterionIds, createdAt }

CheckSource = 'REPOSITORY_REQUIRED' | 'MERGESUTRA_ADDITIONAL' | 'OPTIONAL'

CriterionStatus =
  'PENDING' | 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_AVAILABLE' | 'BLOCKED' | 'INCONCLUSIVE'
```

Two deltas from the earlier design sketch, both deliberate:

- `implementationEvidence` / `validationEvidence` are one `evidence` list. The
  split added a place to hide an unsupported claim; the provenance string on
  each item says what kind of evidence it is.
- There is no `confidence`, `score` or free-text `notes` field anywhere. A
  schema-strict object rejects them, so an inflated self-assessment has nowhere
  to be written.

## Hard rules

1. **Truthful states.** `PASS` only when the referenced evidence actually shows
   a real, executed success. `NOT_AVAILABLE` / `BLOCKED` / `INCONCLUSIVE` when a
   check could not run or could not decide. Never convert model confidence into
   verification. No stage shipped so far has emitted a `PASS`, and none has
   emitted a `FAIL` either: every criterion in every record on disk is still
   `PENDING`, because nothing has run a gate.
2. **Deterministic evidence outranks model claims.** Distinguish `MODEL CLAIM`
   from `DETERMINISTIC EVIDENCE`; when they conflict, evidence wins.
3. **The contract is immutable-by-default.** The implementation stage must not
   rewrite criteria merely to make its solution look successful — which Stage 6
   enforces in types rather than in prose, since its record can hold a proposal
   but no applied change. If the issue understanding genuinely changes,
   record a `ContractRevision` **with a reason** — do not silently mutate
   history.
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
`BLOCKED`, `INCONCLUSIVE`. The stages shipped so far emit `INTAKE`-through-
`IMPLEMENT` outcomes; the plan's is called `PLAN_COMPLETE` rather than
`PLAN_READY`, because nothing in Stage 4 establishes that the plan is ready to
execute. Stage 6's are named the same way on purpose: `IMPLEMENTED_BY_MODEL`,
not `PATCH_CREATED`, because what ended the loop was the model's own statement
that it was done — the record that carries it also says `verified: false`, and
the criteria list it points at is unchanged. The other three,
`IMPLEMENTATION_BLOCKED`, `IMPLEMENTATION_INCONCLUSIVE` and
`IMPLEMENTATION_NEEDS_REVIEW`, are what a bound, a refusal pattern or an
unreachable model leaves behind. `CONTRIBUTION_READY` is not in the outcome
vocabulary at all yet, so no run in this build can spell it.
