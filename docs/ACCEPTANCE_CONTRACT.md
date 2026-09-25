# The Acceptance Contract

> Status: **[STAGE 3 SHIPPED]** for the schema, the criteria derivation and
> `mergesutra contract`. **[STAGE 4 SHIPPED]** for planning against the
> contract — a plan reads the criterion ids and cannot write them.
> **[STAGE 6 SHIPPED]** for the first stage that changes files under the
> contract's authority — it may propose a revision and cannot apply one, and its
> record carries `contractUntouched: true`. **[STAGE 7 SHIPPED]** for evidence:
> `mergesutra verify` runs a repository's own gates under an operator's named
> consent and derives each criterion's status from the receipts — and Stage 6's
> action still has no field that could hold a `PASS`. The core principle is
> implemented, not aspirational: **a `PASS` without evidence cannot be
> constructed**, and a model cannot be the one to add a requirement, prove a
> criterion, or be believed about either.

## Why it exists

A normal coding agent receives an issue and produces code. MergeSutra first
converts the issue and the repository's own policy into a structured, versioned
contract of acceptance criteria. The contract survives the entire workflow and
never degrades into vague prose after implementation, so the final PR can show,
per requirement:

```
Requirement → Change → Verification → Evidence
```

All four links exist in one record now. `tests/verify/hero.test.ts` is the run
that proves it — a real Git repository, a real `node --test` process, and an
output printed by the shipped `mergesutra verify` — and the README reproduces its
stdout, gate receipts and all, under "Stage 7: the same run, verified".

## Two contracts, deliberately different

|                     | Repository contract                     | Acceptance Contract                |
| ------------------- | --------------------------------------- | ---------------------------------- |
| Answers             | "What does this repository demand of any change?" | "What must this patch prove to close this issue?" |
| Built from          | Manifests, CI steps, `CODEOWNERS`, docs — files only | Issue text + the repository contract |
| Implemented         | **Stage 2 — `mergesutra inspect`**, shipped | **Stages 3 and 7 — `mergesutra contract` then `mergesutra verify`**, shipped: the contract states the obligations and never changes to flatter a run; the evidence document beside it says what the receipts proved. Stage 4's planner and Stage 6's loop both read this contract and neither can write it |
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
states can only enter the contract through a human who names themselves —
`--criterion "…" --by "name"`, and `--check "node --test test/invalid.test.mjs"`
when they also know what would prove it. Omit the check and the criterion is
still a real obligation; it simply carries a `manual` step that says "no
automatic check was supplied", and Stage 7 holds it at
`MANUAL_REVIEW_REQUIRED` no matter how green the run is. What the stage really
prints for this issue is in the README's sample output: one criterion per
acceptance-list item, plus one per `REPOSITORY_REQUIRED` gate, each citing its
file and line, all `PENDING`.

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

## Where the evidence lands

Stage 7 is the only stage that can move a criterion off `PENDING`, and it does
not do it by editing this contract. `mergesutra verify` writes a separate
document beside it — `record.evidence` — with one row per criterion keyed by the
contract's own id:

```
criterionEvidence {                       // .strict()
  criterionId: 'AC-1'                     // the contract issued this id, not us
  statement: '…'                          // copied, so a reader need not switch files
  status: CriterionStatus                 // the contract's vocabulary, not a new one
  sufficiency: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'NOT_VERIFIED'
           | 'FAILED' | 'BLOCKED' | 'MANUAL_REVIEW_REQUIRED'
  gateIds: ['VG-001']                     // every receipt this row quotes
  evidence: Evidence[]                    // one per step of *this* criterion's plan
  limitations: string[]
}
```

The separation is the point. The contract is the versioned *obligation* — it
changes only through a recorded revision a human made with a reason, so a run
that went badly cannot renegotiate what it was asked to prove. The evidence
document is the *score*, and it is re-derived from receipts every time verify
runs: same patch, same rows; a workspace that moved on gets its rows marked
`STALE`. Nothing has to mutate the contract for a verification to be honest
about what it established, and nothing can.

`mergesutra report` then puts that document in front of a human without adding to
it. The pack it writes beside the run record repeats the rows as they were filed —
`report.md`'s criteria table is `status`, `sufficiency` and `gateIds` copied out of
`record.evidence.criteria`, and `report.json` embeds the `evidence` object itself —
and the pack for a run that has not verified prints the contract's own `PENDING`
beside a column that reads `no verification has run`. So the trace a reviewer is
owed, `requirement → change → verification → evidence`, is readable off disk rather
than only off an in-memory object: `AC-2 → VG-001` in the table, and
`VG-001`'s argv, exit code and patch identity on the matching line of
`commands.jsonl`.

Three rules decide whether a receipt counts for a criterion:

- **Relevance is a command match, not a theme.** A criterion whose verification
  plan names `node scripts/check-banner.js` is not served by a passing `npm test`,
  however sure one is that the suite covers it. The match is against the spellings
  the gate really reaches — the invocation plus every script body it chains into,
  so `npm test` and the `vitest run` behind it are one command.
- **Every step of the criterion counts.** One passing command out of two leaves
  the row `PARTIALLY_VERIFIED`, and the status that goes with that is
  `INCONCLUSIVE` rather than `PASS`. A step that asks for a person cannot be
  satisfied by a process: it holds the row at `MANUAL_REVIEW_REQUIRED` instead of
  being dropped when it becomes inconvenient.
- **Evidence describes one patch.** Each receipt carries the sha-256 of the
  workspace's uncommitted state; a row quoting an identity the workspace no
  longer has is printed, marked `STALE`, and counts for nothing — which is why a
  resume that kept editing cannot inherit yesterday's green.

A sentence from BharatCode has no route into any of the three. The loop's
`FINISH` is filed in `evidence.claims`, beside the rows, labelled with the action
that produced it, and is read by nothing that decides a status.

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
    | { kind: 'human', by }              // `contract --criterion … --check … --by …`
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
   verification. No stage before Stage 7 emitted a `PASS`, and Stage 7 emits one
   only from a receipt: `record.evidence` is where a criterion can be `PASS`,
   `FAIL`, `BLOCKED` or `INCONCLUSIVE`, and the contract document itself keeps
   every criterion `PENDING` because it is the obligation, not the score. An
   unexecuted gate leaves its row `NOT_VERIFIED`, which is why "we have a plan to
   check that" never reads as "that held".
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

## Advanced evidence: regression before/after **[PARTIAL]**

For a bug fix, the strongest statement available is not "the tests pass on the
patched code" but "this command failed before the patch and passes after it".
Stage 7 implements the *comparison* and refuses to implement the *orchestration*:

- `compareRegressionEvidence(base, patched)` takes two receipts and will only
  speak when they are the same gate (`argv` and `cwd`), on the same base commit,
  with **different** patch identities. A pair that fails any of those is refused
  as a mistake rather than filed as weak evidence, because "not demonstrated"
  beside a nonsense comparison is how nonsense gets into a report.
- What it can say is bounded and is written into the record's own sentence: base
  `FAIL` and patch `PASS` is regression evidence that the test detects the defect
  it was written for; both sides `PASS` explicitly **is not** regression evidence,
  because the test did not need the fix; base `PASS` and patch `FAIL` is called a
  regression the change introduced, not a success.
- What it does not do is run anything twice. No second workspace, no automatic
  base-side gate — the caller that holds two receipts supplies them. A stage that
  silently re-ran the suite would be executing commands the operator never
  consented to, which is the one thing this design will not trade for a stronger
  sentence.

`tests/verify/hero.test.ts` shows the base side being established the honest way:
the same regression command, run against the base commit's code, exits non-zero —
asserted, so the fixture cannot pass by being hard-wired.

## Run-level statuses

`CONTRIBUTION_READY` is reachable only when all mandatory gates pass. Others:
`PLAN_READY`, `PATCH_CREATED`, `VERIFICATION_FAILED`, `NEEDS_HUMAN_REVIEW`,
`BLOCKED`, `INCONCLUSIVE`. The stages shipped so far emit `INTAKE`-through-
`VERIFY` outcomes; the plan's is called `PLAN_COMPLETE` rather than
`PLAN_READY`, because nothing in Stage 4 establishes that the plan is ready to
execute. Stage 6's are named the same way on purpose: `IMPLEMENTED_BY_MODEL`,
not `PATCH_CREATED`, because what ended the loop was the model's own statement
that it was done — the record that carries it also says `verified: false`, and
the criteria list it points at is unchanged. The other three,
`IMPLEMENTATION_BLOCKED`, `IMPLEMENTATION_INCONCLUSIVE` and
`IMPLEMENTATION_NEEDS_REVIEW`, are what a bound, a refusal pattern or an
unreachable model leaves behind.

Stage 7's are about the gates and nothing wider: `VERIFICATION_PASS`,
`VERIFICATION_FAIL`, `VERIFICATION_BLOCKED`, `VERIFICATION_INCONCLUSIVE`,
`VERIFICATION_CANCELLED`. The word is *verification*, not *contribution*: a run
that passed every gate it was allowed to run ends with `nextStage` naming a
`review` command, because whether the patch is worth submitting is a judgement
this stage makes no claim on. `CONTRIBUTION_READY` is still not in the outcome
vocabulary at all, so no run in this build can spell it — and the evidence
document beside it types `contributionReady` as the literal `false`, so there is
no field to write it into either.
