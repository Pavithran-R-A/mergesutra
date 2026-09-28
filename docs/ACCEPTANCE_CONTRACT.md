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
> criterion, or be believed about either. **[STAGE 10 SHIPPED]** at the other end
> of that chain: `mergesutra pr` reads the statuses below and assembles a page from
> them, and it has no field on this contract — or on its own candidate — where a
> verdict could be written. See "The publication pair" below.

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
not do it by editing this contract. Stage 9R's repair cycle changes a criterion's
row only by running Stage 7's round again over the patch it just produced — it
holds no evidence writer of its own, which is why a repaired run's statuses are
receipts rather than the loop's opinion. `mergesutra verify` writes a separate
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

### The publication pair (Stage 10)

`src/pr/candidate.ts`, `src/pr/digest.ts`, `src/pr/approval.ts` and
`src/pr/record.ts`. The contract above is the obligation; these are the two
documents a run files beside it when it reaches the publication boundary. Both
are `.strict()`, and — like the contract — neither one carries a verdict.

```ts
PublicationCandidate {                        // schemaVersion 1, no status field
  runId, repository, baseSha, patchIdentity   // every one measured, none typed in
  targetBranch, proposedBranch
  prTitle, prBody, prBodySha256               // both bounded; the body is hashed
  evidencePackIdentity                        // which pack's bytes this page repeats
  issueCanonical: string | null, closesIssue: boolean
  reviewCycle, reviewedPatchIdentity, reviewSummary
  verificationSummary, knownLimitations: string[], createdAt
}

publicationDigestOf(candidate)                // sha256 of 15 labelled lines
  // mergesutra-publication/1, run, repository, base, patch, target, source,
  // title, body as prBodySha256, pack, issue + closes/relates, review cycle +
  // patch, review-summary, verification, limitations joined with \u0000.
  // `createdAt` is the only field left out: a yes covers a scope, not a minute.
  // The candidate is parsed through its own schema before it is hashed.

PublicationApproval {                         // five fields, authored by a person
  schemaVersion, runId,
  publicationDigest,                          // 64 hex — no prefix, no wildcard
  approvedAt,
  action: 'CREATE_PULL_REQUEST'               // the enum's only member
}

decidePublication → { status: 'MATCHED' | 'ABSENT' | 'STALE', allowed, … }
  // equality against the recomputed digest, and nothing else

PublicationRecord { candidate, approval: PublicationApproval | null }
  // appended to `record.publications` (run schema version 9)
```

Three rules that live in the shapes rather than in prose:

- **An approval can be about one thing.** `decidePublication` recomputes the
  digest from the candidate in front of it and compares; it never accepts a
  digest as a parameter, so there is no way to say yes to a page that was not
  shown. A candidate re-rendered by `mergesutra report` after the yes comes back
  `STALE`, naming both digests.
- **A stored yes cannot be cross-wired.** `publicationRecordSchema`'s
  `superRefine` refuses at read time a record whose approval names a different
  candidate's digest — the pairing a decision-time check would already have
  rejected, kept out of the history a later stage would trust.
- **There is no result field.** No `prUrl`, no `published`, no merge timestamp
  exists in either document, so nothing in Stage 10's stored state can read as a
  publication that happened. `contributionReady` remains the literal `false` it
  has been since Stage 7, and the criteria rows a page quotes are the same rows
  with the same statuses — `pr` is a consumer of this contract, and has no field
  on it to rewrite.

### The recovery pair (Stage 11)

`src/lifecycle/staleness.ts`, `observe.ts`, `snapshot.ts`, `next-actions.ts`,
`resume-plan.ts`, `budget.ts`, `lock.ts` and `resume.ts`. Stage 11 files no new
promise about the *work* — it files documents about the **state of** the work, and
each of them is `.strict()`. The run record stays at schema version 9: nothing here
adds a field a person could mistake for an outcome.

```ts
LifecycleArtifact (9)   // verification, evidence, review, repairPlan,
                        // executionConsent, pack, candidate,
                        // publicationApproval, repairApproval
LifecycleState (4)      // CURRENT | STALE | UNMEASURABLE | ABSENT

lifecycleStaleness(facts) → { states, rows }
  // facts: one { recorded, current } pair per artifact, brought by the caller.
  // recorded === null            → ABSENT
  // recorded set, current null   → UNMEASURABLE
  // the two digests differ       → STALE, else CURRENT
  // then every row widens to the worst state on anything it is built from
  //   evidence ← verification, review ← evidence, repairPlan ← review,
  //   candidate ← pack + review, publicationApproval ← candidate
  // and ABSENT — the one state that means "never filed", not "expired" — is the
  // only state that does not travel along an arrow.

StatusSnapshot { schemaVersion 1, runId, observedAt,               // .strict()
  lock:       { state, detail, directory, holder | null }
  //            state ∈ UNHELD / HELD_LIVE / HELD_ELSEWHERE / HELD_PROVABLY_GONE /
  //            UNREADABLE — five words, and the release token is in no field of it.
  recorded:   { stage, outcome, nextStage, createdAt, mergeSutraVersion }
  workspace:  { state, path, recordedBaseSha, observedHead,
                currentPatchIdentity, recordedPatchIdentity, detail }
  patch:      { recorded, current, status }        // the pair, with the graph's row
  contract | plan | implementation | verification | evidence | review
       | repair | publication                       // each null until that stage files it
  report:     { packOnDisk, state, regenerable: literal true }
  lifecycle:  { states keyed by the 9 artifacts, rows }
  blockers, warnings, safeNextActions
}
  // The record's words and this machine's bytes sit in separate fields and are
  // never fused. `PASS` beside `STALE` in one row is the honest shape of a run
  // whose files moved after its gates ran.

SafeNextAction { command, reason,
  requires: MODEL | REPOSITORY_COMMAND | HUMAN_APPROVAL | EXECUTION_CONSENT | LOCAL_ONLY }

ResumePlan { schemaVersion 1, runId,
  observedStateDigest,   // sha256 over the snapshot minus the moment it was read
  currentPatchIdentity,  // 64-hex, or null when nothing measurable is here
  action, reason,
  stage, command, requiresModel, requiresCredential, requiresExecutionConsent,
  requiresRepairApproval, requiresPublicationApproval, mutatesWorkspace }
  // `action` is one of thirteen names, from DERIVE_ACCEPTANCE_CONTRACT to
  // NOTHING_TO_RESUME; none of them means published, pushed, created or merged.

RunLock  <runsRoot>/<runId>.lock/owner.json     // operation: resume, and only resume
  // block reasons: HELD_BY_LIVE_PROCESS | HELD_BY_THIS_PROCESS |
  // HELD_ON_ANOTHER_HOST | TAKEOVER_IN_PROGRESS | OWNER_UNREADABLE | PATH_OCCUPIED

ResumeResult → PREVIEW | RAN | REFUSED (CAPABILITY_REQUIRED | AWAIT_HUMAN |
                                      NOTHING_TO_RESUME)
             | BLOCKED (WORKSPACE_BLOCKED | LOCK_HELD | STATE_CHANGED | NO_EXECUTOR)
```

Five rules that live in the shapes rather than in prose:

- **No row is set by asking.** Nothing in Stage 11 writes a run record, a receipt or
  an approval. A snapshot is derived from documents other stages filed, `observe.ts`
  runs read commands only, and `status --json` prints that derived document without
  storing it — so there is no path by which looking at a run changes what a later
  stage can claim about it.
- **`UNMEASURABLE` is the refusal to guess.** When the current fact cannot be
  measured (the workspace is gone, HEAD has moved, the patch cannot be described),
  the row says it cannot be measured instead of calling the document stale or
  current. `ABSENT` and `UNMEASURABLE` are different sentences, and only one of them
  is a complaint about the run.
- **Currency is computed, never narrated.** Every `state` field in the snapshot is
  copied out of the one graph, so a status screen and a resume plan cannot disagree
  about what expired, and neither can be talked into a friendlier answer.
- **An action is bound to the facts that justified it.** `observedStateDigest` is a
  hash over the snapshot the plan was read from, `--execute` re-reads the state and
  compares before dispatch, and a mismatch is `BLOCKED: STATE_CHANGED`. The digest is
  not a token to be replayed: it is the run's way of admitting the ground moved.
- **A lock is data, not authority.** `owner.json` is parsed as untrusted input, a
  lock that names another host blocks rather than being deleted, age is never
  evidence of death, and a proven-dead lock is *claimed* by writing again — never
  removed. Holding one grants no consent, no approval, no credential and no remote
  permission; `resume` refuses on the plan's own cost flags *before* it claims.

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

Stage 9's are named for what was filed, not for what was thought: `REVIEW_RECORDED`,
`REVIEW_NEEDS_HUMAN`, `REVIEW_INCONCLUSIVE` and `REVIEW_STALE`. There is no
`REVIEW_PASS`, because the answer came from a model that was shown the patch rather
than from a gate that ran against it.

Stage 9R's are `REPAIR_APPLIED`, `REPAIR_NEEDS_HUMAN` and `REPAIR_BLOCKED`.
`APPLIED` is the weakest sentence that is still true when a cycle ran and Stage 7's
re-run passed on the new bytes — bytes moved and the gates were re-run, which is not
the same claim as *the patch is good* — and the repair vocabulary has no `READY`
member to mistake it for. `NEEDS_HUMAN` covers a cycle whose gates did not pass, one
that finished and moved nothing, and a plan escalated for reaching outside its own
scope; `BLOCKED` is a loop that stopped on a bound or an outage, with the patch
unchanged. None of the three is exit `0`, and `contributionReady` remains the literal
`false` it was.

Stage 10's are `PR_CANDIDATE_RECORDED`, `PR_APPROVED_LOCAL` and
`PR_PUBLICATION_BLOCKED` — exits `3`, `3` and `4`, and no path through the command
returns `0`, because none of the three is a publication. The first says the facts a
page needs were all already on file and the page was assembled and shown; the second
says a human then typed that page's digest back, which is the strongest sentence this
stage can make and is still a sentence about a keystroke, not about GitHub; the third
covers a run whose evidence is missing or stale and a yes that does not fit the page
in front of the person typing it, and names which. The readiness decision behind them
is eight named facts, not a score: `patch-measured`, `verification-current`,
`verification-passed`, `review-current`, `no-repair-candidate-left`,
`no-scope-violation`, `pack-current`, `human-approved`. All eight hold and the word is
`HUMAN_APPROVED_FOR_PR`, which means exactly one thing — a person has agreed, by
digest, to this page being opened as a pull request — and does not mean the AI thinks
the code is good, that no defect remains, or that anything was published; the stage
result beside it types `published` as the literal `false`, and the only publication
transport this build defines throws when called — and has no production caller. Anything less is `NOT_READY_FOR_PUBLICATION`, whose blocking rows name
the earlier stage that owns the missing fact, since Stage 10 consumes state and does
not repair it. `CONTRIBUTION_READY` is still not in the outcome vocabulary: a run
whose eight checks all hold has a human's yes on a page, which is a different kind of
claim from every mandatory gate having passed, and Stage 10 has no field to write the
stronger one into.
